// Lead-to-Dispatch Funnel — AI engine (namespace: Lead2DispatchFunnel).
//
// Three prompt-isolated jobs over ONE shared Anthropic engine, mirroring
// the pattern in server/routes/aiAgent.js:
//   1. Lead Classifier      — classifyLead()    (borderline leads only)
//   2. Product Matcher/Pricer — matchAndPrice()  (semantic item match + price)
//   3. Vendor-PO Drafter    — draftVendorPo()    (ranked vendor shortlist)
//
// Reuses the existing Anthropic key from app_settings (read-only on the main
// ERP DB) — no second key to manage. All main-ERP access here is READ-ONLY
// (item_master, item_price_history, vendors, vendor_po_items,
// indent_item_rates). Nothing in this file writes to erp.db; callers persist
// results into the funnel DB.

const { getDb } = require('../db/schema');

const ANTHROPIC_TIMEOUT_MS = 60 * 1000;

// ─── Shared engine ───────────────────────────────────────────────────
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}

// Returns { client, model } or null when no key is configured (callers then
// skip AI and fall back to keyword-only / human review).
function getEngine() {
  const apiKey = getSetting('ai_api_key');
  if (!apiKey) return null;
  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    console.warn('[l2d-ai] @anthropic-ai/sdk not installed:', e.message);
    return null;
  }
  const client = new Anthropic.default({ apiKey, timeout: ANTHROPIC_TIMEOUT_MS });
  const model = getSetting('ai_model') || 'claude-opus-4-7';
  return { client, model };
}

// Pull the first text block and try to parse JSON out of it (tolerates
// ```json fences and leading prose).
function parseJsonResponse(response) {
  const text = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();
  if (!text) return null;
  // Strip code fences if present
  let body = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  // Fall back to the first {...} block
  if (body[0] !== '{' && body[0] !== '[') {
    const m = body.match(/[{[][\s\S]*[}\]]/);
    if (m) body = m[0];
  }
  try { return JSON.parse(body); } catch { return null; }
}

async function ask(system, user, maxTokens = 1024) {
  const engine = getEngine();
  if (!engine) return null;
  const response = await engine.client.messages.create({
    model: engine.model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: user }],
  });
  return parseJsonResponse(response);
}

// ─── 0. Keyword pass (plain JS, no AI) ───────────────────────────────
// Runs FIRST on every lead. include/exclude are arrays of lowercase
// substrings the admin maintains. Returns one of:
//   'exclude'    → hit an exclude term → REJECTED, no AI call
//   'include'    → hit an include term, no exclude → relevant, no AI call
//   'borderline' → neither matched → escalate to the AI classifier
function keywordPass(lead, includeList = [], excludeList = []) {
  const hay = [lead.query_product_name, lead.query_mcat_name, lead.query_message]
    .filter(Boolean).join(' ').toLowerCase();
  const inc = (includeList || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  const exc = (excludeList || []).map(s => String(s).trim().toLowerCase()).filter(Boolean);
  if (exc.some(t => hay.includes(t))) return 'exclude';
  if (inc.length && inc.some(t => hay.includes(t))) return 'include';
  return 'borderline';
}

// ─── 1. Lead Classifier ──────────────────────────────────────────────
// Second opinion on borderline leads only. Returns
// { verdict:'relevant'|'junk'|'unsure', confidence:0-1, reason } or null
// (null → caller routes to NEEDS_REVIEW; we never silently drop).
async function classifyLead(lead, scopePrompt) {
  const system =
    'You are the Lead Classifier for an industrial-supplies company. Decide whether an ' +
    'inbound enquiry is a RELEVANT sales lead, JUNK (spam/irrelevant/job-seeker/competitor), ' +
    'or UNSURE. Be conservative: when genuinely unsure, say "unsure" so a human reviews it — ' +
    'never label a possibly-real buyer as junk.\n\n' +
    'Company scope / what we sell:\n' + (scopePrompt || '(no scope provided — judge generically)') +
    '\n\nReply with ONLY a JSON object: ' +
    '{"verdict":"relevant|junk|unsure","confidence":0.0-1.0,"reason":"one short sentence"}';
  const user = JSON.stringify({
    product: lead.query_product_name || '',
    category: lead.query_mcat_name || '',
    message: (lead.query_message || '').slice(0, 1500),
    query_type: lead.query_type || '',
  });
  try {
    const out = await ask(system, user, 400);
    if (!out || !out.verdict) return null;
    const verdict = String(out.verdict).toLowerCase();
    return {
      verdict: ['relevant', 'junk', 'unsure'].includes(verdict) ? verdict : 'unsure',
      confidence: typeof out.confidence === 'number' ? out.confidence : null,
      reason: out.reason ? String(out.reason).slice(0, 300) : null,
    };
  } catch (e) {
    console.warn('[l2d-ai] classifyLead failed:', e.message);
    return null;
  }
}

// Tokenise a free-text product/category string into search terms.
function tokens(str) {
  return String(str || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3);
}

// Pre-fetch a bounded candidate set from item_master (READ-ONLY) so the AI
// picks among real rows instead of issuing open SQL. Token OR-match on
// item_name / specification / make, capped.
function fetchCandidateItems(lead, limit = 25) {
  const db = getDb();
  const terms = [...new Set([...tokens(lead.query_product_name), ...tokens(lead.query_mcat_name)])].slice(0, 8);
  if (!terms.length) {
    return db.prepare('SELECT id, item_name, specification, make, uom, current_price FROM item_master LIMIT ?').all(limit);
  }
  const likeCols = ['item_name', 'specification', 'make'];
  const where = terms.map(() => '(' + likeCols.map(c => `${c} LIKE ?`).join(' OR ') + ')').join(' OR ');
  const params = [];
  for (const t of terms) for (let i = 0; i < likeCols.length; i++) params.push(`%${t}%`);
  const rows = db.prepare(
    `SELECT id, item_name, specification, make, uom, current_price FROM item_master WHERE ${where} LIMIT ?`
  ).all(...params, limit);
  return rows;
}

// Latest historical rate for an item, else null.
function latestHistoryRate(itemId) {
  const row = getDb().prepare(
    'SELECT rate FROM item_price_history WHERE item_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(itemId);
  return row?.rate ?? null;
}

// ─── 2. Product Matcher / Pricer ─────────────────────────────────────
// Semantically matches the lead's product to an item_master row and
// resolves a price. Returns
//   { item_id, item_name, price, price_source, confidence }
// or null (→ NEEDS_REVIEW, no auto price). price_source is
// 'history' | 'current_plus_margin'. marginPct is a whole number (e.g. 15).
async function matchAndPrice(lead, marginPct = 0) {
  let candidates;
  try {
    candidates = fetchCandidateItems(lead);
  } catch (e) {
    console.warn('[l2d-ai] candidate fetch failed:', e.message);
    return null;
  }
  if (!candidates || !candidates.length) return null;

  const system =
    'You match a customer enquiry to the single best item from a catalogue. The catalogue ' +
    'names will NOT exactly equal the enquiry wording — match by meaning. If none is a ' +
    'genuine match, return null. Reply with ONLY JSON: ' +
    '{"item_id": <id or null>, "confidence": 0.0-1.0}.';
  const user = JSON.stringify({
    enquiry: {
      product: lead.query_product_name || '',
      category: lead.query_mcat_name || '',
      message: (lead.query_message || '').slice(0, 800),
    },
    catalogue: candidates.map(c => ({
      id: c.id, name: c.item_name, spec: c.specification || '', make: c.make || '',
    })),
  });

  let pick;
  try {
    pick = await ask(system, user, 300);
  } catch (e) {
    console.warn('[l2d-ai] matchAndPrice failed:', e.message);
    return null;
  }
  if (!pick || pick.item_id == null) return null;
  const item = candidates.find(c => c.id === pick.item_id);
  if (!item) return null;
  const confidence = typeof pick.confidence === 'number' ? pick.confidence : null;
  // Low-confidence match → treat as no confident match.
  if (confidence != null && confidence < 0.55) return null;

  const histRate = latestHistoryRate(item.id);
  let price, price_source;
  if (histRate != null && histRate > 0) {
    price = histRate;
    price_source = 'history';
  } else if (item.current_price != null && item.current_price > 0) {
    price = Math.round(item.current_price * (1 + (Number(marginPct) || 0) / 100));
    price_source = 'current_plus_margin';
  } else {
    // We matched an item but have no price basis → still hand to a human.
    return null;
  }
  return { item_id: item.id, item_name: item.item_name, price, price_source, confidence };
}

// ─── 3. Vendor-PO Drafter ────────────────────────────────────────────
// Proposes a ranked vendor shortlist for an item, mined READ-ONLY from
// vendors (category/deals_in text) + who actually supplied similar items
// before (indent_item_rates.final_vendor_name / vendor_po history). Returns
//   { item_id, item_name, qty, rate, vendor_candidates: [{name, why, score}] }
// A human confirms the final vendor before the funnel PO is approved.
async function draftVendorPo(lead, item) {
  const db = getDb();
  const itemName = item?.item_name || lead.matched_item_name || lead.query_product_name || '';
  const terms = tokens(itemName).slice(0, 6);

  // Signal A: vendors whose free-text category/deals_in mentions the item terms.
  let catVendors = [];
  if (terms.length) {
    const where = terms.map(() => '(category LIKE ? OR deals_in LIKE ? OR sub_category LIKE ?)').join(' OR ');
    const params = [];
    for (const t of terms) { params.push(`%${t}%`, `%${t}%`, `%${t}%`); }
    catVendors = db.prepare(
      `SELECT name, firm_name, category, deals_in FROM vendors WHERE active=1 AND (${where}) LIMIT 15`
    ).all(...params);
  }

  // Signal B: vendors who were FINALISED on similar items historically.
  let histVendors = [];
  if (terms.length) {
    const where = terms.map(() => 'ir.final_vendor_name IS NOT NULL').slice(0, 1).join('');
    // Match on the indent item description text where available.
    const likeWhere = terms.map(() => 'ii.description LIKE ?').join(' OR ');
    const params = terms.map(t => `%${t}%`);
    try {
      histVendors = db.prepare(
        `SELECT ir.final_vendor_name AS name, COUNT(*) AS times
           FROM indent_item_rates ir
           JOIN indent_items ii ON ii.id = ir.indent_item_id
          WHERE ir.final_vendor_name IS NOT NULL AND (${likeWhere})
          GROUP BY ir.final_vendor_name
          ORDER BY times DESC LIMIT 10`
      ).all(...params);
    } catch (e) {
      // indent schema variations shouldn't break the draft.
      histVendors = [];
    }
  }

  const engine = getEngine();
  // Without AI we still return the mined signals so a human can choose.
  if (!engine) {
    const fallback = [
      ...histVendors.map(v => ({ name: v.name, why: `supplied similar items ${v.times}× before`, score: 0.7 })),
      ...catVendors.map(v => ({ name: v.name, why: `deals in: ${v.deals_in || v.category || ''}`.slice(0, 120), score: 0.5 })),
    ];
    return { item_id: item?.item_id || null, item_name: itemName, qty: 1, rate: lead.quoted_price || 0, vendor_candidates: dedupeVendors(fallback).slice(0, 5) };
  }

  const system =
    'You draft a purchase-order vendor shortlist for an industrial item. You are given two ' +
    'signals: vendors whose catalogue text matches, and vendors who actually supplied similar ' +
    'items before (stronger signal). Rank up to 5 candidates, prefer proven past suppliers. ' +
    'Reply with ONLY JSON: {"vendor_candidates":[{"name":"...","why":"short reason","score":0.0-1.0}]}.';
  const user = JSON.stringify({
    item: itemName,
    matched_by_catalogue: catVendors.map(v => ({ name: v.name, deals_in: v.deals_in || v.category || '' })),
    supplied_before: histVendors,
  });
  let out;
  try {
    out = await ask(system, user, 600);
  } catch (e) {
    console.warn('[l2d-ai] draftVendorPo failed:', e.message);
    out = null;
  }
  const candidates = (out?.vendor_candidates || []).filter(v => v && v.name).slice(0, 5);
  return {
    item_id: item?.item_id || null,
    item_name: itemName,
    qty: 1,
    rate: lead.quoted_price || 0,
    vendor_candidates: candidates.length ? candidates : dedupeVendors([
      ...histVendors.map(v => ({ name: v.name, why: `supplied similar items ${v.times}× before`, score: 0.7 })),
      ...catVendors.map(v => ({ name: v.name, why: (v.deals_in || v.category || '').slice(0, 120), score: 0.5 })),
    ]).slice(0, 5),
  };
}

function dedupeVendors(list) {
  const seen = new Set();
  const out = [];
  for (const v of list) {
    const k = (v.name || '').trim().toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(v);
  }
  return out;
}

module.exports = {
  keywordPass,
  classifyLead,
  matchAndPrice,
  draftVendorPo,
  // exported for the route's manual "re-draft" endpoint / tests
  fetchCandidateItems,
};
