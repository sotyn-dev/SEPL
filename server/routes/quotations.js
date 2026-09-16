const express = require('express');
const { istToday } = require('../lib/istDate');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { aiComplete, aiConfig, extractJsonArray } = require('../lib/aiComplete');
const router = express.Router();
router.use(authMiddleware);

const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Does this user hold a right on another module? The BOQ / quotation lists are
// shared reads with no requirePermission of their own, so when they merge in
// CRM Sales Funnel rows (mam 2026-09-07) the CRM half has to carry the CRM
// module's own gate — otherwise unticking "view" on crm_funnel in Roles &
// Permissions would hide the CRM page but leave the same leads, their client
// names and their BOQ files readable one tab away.
const RIGHT_FIELDS = { view: 'can_view', create: 'can_create', edit: 'can_edit', delete: 'can_delete', approve: 'can_approve' };
function hasModuleRight(db, user, module, action) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  const field = RIGHT_FIELDS[action];
  if (!field) return false;
  try {
    const r = db.prepare(`SELECT MAX(rp.${field}) AS ok FROM role_permissions rp
        JOIN user_roles ur ON ur.role_id = rp.role_id
       WHERE ur.user_id = ? AND rp.module = ?`).get(user.id, module);
    return !!(r && r.ok);
  } catch (e) { return false; }
}

// A BOQ link is either an uploaded /uploads/… path or free text somebody typed
// into "Customer BOQ Link". A pasted "drive.google.com/…" with no scheme would
// resolve RELATIVE to the ERP (…/quotations/drive.google.com/…) and open a dead
// SPA route instead of the BOQ, so give a bare host one (mam 2026-09-07).
function externalLink(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (s.startsWith('/') || /^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

// Name a BOQ row after the FILE it points at. A lead can now carry several
// BOQs (mam 2026-09-07 "more upload files") and rows titled identically —
// same client, same date, same Rs 0 — are unreadable, so the filename is the
// only thing that tells them apart. Strips the "<epoch>-" prefix the upload
// handler adds, and truncates the MIDDLE of a very long name so the extension
// stays visible. Returns null when nothing file-like can be derived (a typed
// Drive URL, say) — the caller falls back to a generic label.
function boqFileTitle(link) {
  let base = String(link || '').split(/[\\/]/).pop().split('?')[0].split('#')[0];
  try { base = decodeURIComponent(base); } catch (_) { /* keep the raw text */ }
  base = base.replace(/^\d{10,}-/, '');            // 1757248…-TFA.xlsx → TFA.xlsx
  if (!base || !/\.[A-Za-z0-9]{1,8}$/.test(base)) return null;
  if (base.length <= 52) return base;
  return `${base.slice(0, 30)}…${base.slice(-18)}`;
}

// Tokenise a description for fuzzy item matching — drop noise words so the
// distinctive keywords (Excavation, MS Pipe, 25mm…) carry the match.
// Word-match rules (tokens / scoreMatch) now live in lib/textMatch.js, shared
// with the Vendor Rates quotation reader. The LLM pass (below) makes the final
// call when configured.
const { STOP, tokens, scoreMatch } = require('../lib/textMatch');

// (AI provider/key/model live in app_settings, set via the AI Settings UI —
// both LLM passes below read them through lib/aiComplete.js since 2026-08-21.)

// Claude pass: for each line, pick the best catalog item from its fuzzy
// shortlist, or null for composite WORK items that have no single catalog
// match. Returns an array indexed by line, or null if AI isn't configured.
async function llmRefine(ranked) {
  // Provider (anthropic / gemini) comes from Admin → AI Settings via the
  // shared helper (mam 2026-08-21). Contract unchanged: return null on ANY
  // failure so the caller falls back to fuzzy matching.
  if (!aiConfig(getDb()).configured) return null;
  const blocks = ranked.map((r, i) => {
    const cands = r.scored.slice(0, 8).map(s =>
      `${s.it.id}=${[s.it.item_name, s.it.specification, s.it.size].filter(Boolean).join(' ')}`).join(' | ');
    return `[${i}] "${String(r.line.description).slice(0, 280)}"\n   options: ${cands || '(none)'}`;
  }).join('\n');
  const prompt = `You match client BOQ lines to a company's Item Master (catalog of materials/products it sells).
For each BOQ line, pick the ONE option id that is the SAME product, or null if none genuinely match.
CRITICAL: many lines are CONSTRUCTION WORK (e.g. "construct brick masonry manhole", "lay RCC pipe in trench") that has NO single catalog item — return null for those; do NOT match a material merely mentioned inside the text.
Return ONLY a JSON array, one object per line: {"line": <index>, "item_id": <id or null>, "confidence": <0-100>}.

${blocks}`;
  let out0;
  try { out0 = await aiComplete(getDb(), { prompt, maxTokens: 4096, timeout: 55000, json: true }); }
  catch (e) { console.warn('[quotations] AI refine pass failed:', e.status || '', e.message); return null; }
  const arr = extractJsonArray(out0.text);
  if (!arr) { console.warn('[quotations] AI refine returned no JSON array'); return null; }
  const out = [];
  for (const o of arr) if (o && typeof o.line === 'number') out[o.line] = { item_id: o.item_id ?? null, confidence: Number(o.confidence) || 0 };
  return out;
}

// Turn extracted PDF/Word text into BOQ line items: each meaningful line is a
// description (header/note/total lines skipped); a trailing "<n> <unit>"
// becomes the qty.
function textToLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const SKIP = /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|description|particulars?|hsn|grand total|sub\s*total|subtotal|total\b|note|notes|terms|page\b|quotation\b|date\b|validity|currency|subject|scope|to:|m\/s|email|website|secured ?engineers|fire ?fighting|#$|qty|quantity|uom|unit|rate|amount|gst|cgst|sgst|igst)\b/i;
  const isSerial = l => /^\d{1,3}$/.test(l);                         // item number on its own line
  const isPriceLine = l => /(mtrs?|nos|pcs|sets?|kg|each|point|rmt|rft|sqm|cum)\b/i.test(l) && /(₹|\brs\b|\d{2,})/i.test(l);
  const items = [];
  let cur = null;
  for (const l of raw) {
    if (SKIP.test(l)) continue;
    if (isSerial(l)) { if (cur && cur.parts.length) items.push(cur); cur = { parts: [] }; continue; }
    if (!cur) continue;                                              // skip the header preamble before item #1
    if (isPriceLine(l) && cur.parts.length) continue;                // drop the HSN/qty/rate/amount line
    // also handle a serial prefixed inline: "1. Supply of ..."
    const cleaned = l.replace(/^\s*\d+(\.\d+)*[).]\s+/, '').trim();
    if (cleaned.length >= 3) cur.parts.push(cleaned);
  }
  if (cur && cur.parts.length) items.push(cur);
  return items
    .map(it => ({ description: it.parts.join(' — ').replace(/\s+/g, ' ').trim(), qty: 1, unit: '' }))
    .filter(it => it.description.length > 3 && /[a-z]{3,}/i.test(it.description));
}

// Use Claude to extract clean BOQ line items from raw PDF/Word text — it
// groups multi-line descriptions (name + spec + make) into one item and skips
// headers/notes/totals. Returns [{description, qty}] or null if AI not set up.
async function llmExtractItems(text) {
  if (!text || !aiConfig(getDb()).configured) return null;
  const prompt = `Extract the BOQ / requirement line items from this client document text.
Each item may span SEVERAL lines (item name, long description, "Make: ...", size) — COMBINE those into ONE item's description.
Skip headers, column titles, notes, terms, totals, page numbers, addresses.
Return ONLY a JSON array, one object per item: {"description": "<full combined item text>", "qty": <number, default 1>}.

TEXT:
${String(text).slice(0, 14000)}`;
  let res0;
  try { res0 = await aiComplete(getDb(), { prompt, maxTokens: 4096, timeout: 55000, json: true }); }
  catch (e) { console.warn('[quotations] AI extract pass failed:', e.status || '', e.message); return null; }
  const arr = extractJsonArray(res0.text);
  if (!arr) { console.warn('[quotations] AI extract returned no JSON array'); return null; }
  const out = arr.filter(x => x && x.description && String(x.description).trim().length > 3)
    .map(x => ({ description: String(x.description).replace(/\s+/g, ' ').trim(), qty: Number(x.qty) || 1, unit: '' }));
  return out.length ? out : null;
}

// POST a CLIENT BOQ (Excel / PDF / Word) → auto-match each line to Item
// Master and return a suggested item + rate + confidence per line.
// Core BOQ parse + match — shared by the upload route and the funnel auto-load.
// Throws Error (with optional .status) on failure; the caller handles cleanup.
async function matchBoqFile(filePath, originalName) {
    const ext = String(originalName || '').toLowerCase().split('.').pop();
    let lines = [];
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(filePath));
      lines = (await llmExtractItems(data.text).catch(() => null)) || textToLines(data.text);
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: filePath });
      lines = (await llmExtractItems(r.value).catch(() => null)) || textToLines(r.value);
    } else {
      // Excel / CSV — find the header row, then read Description/Qty/Unit cols.
      const wb = XLSX.readFile(filePath);
      const parseNum = (v) => {
        if (v == null || v === '') return 0;
        if (typeof v === 'number') return v;
        const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
        return m ? parseFloat(m[0]) : 0;
      };
      const parseSheet = (name) => {
        const ws = wb.Sheets[name]; if (!ws) return [];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
        const KW = ['description', 'particulars', 'item', 'work', 'qty', 'quantity', 'unit', 'rate', 's.no', 'sr no', 'sn'];
        let h = -1;
        for (let i = 0; i < Math.min(25, data.length); i++) {
          const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
          if (KW.filter(k => row.some(c => c === k || c.includes(k))).length >= 2) { h = i; break; }
        }
        if (h === -1) return [];
        const headers = (data[h] || []).map(x => String(x || '').toLowerCase().trim());
        const col = {};
        headers.forEach((hd, i) => {
          if (col.name === undefined && (hd.includes('description') || hd.includes('particular') || hd === 'item' || hd === 'items' || hd === 'work' || hd.includes('work description'))) col.name = i;
          if (col.qty === undefined && (hd === 'qty' || hd === 'quantity' || hd.includes('qty'))) col.qty = i;
          if (col.unit === undefined && (hd === 'unit' || hd === 'uom' || hd.includes('unit'))) col.unit = i;
        });
        if (col.name === undefined) return [];
        const out = [];
        for (let i = h + 1; i < data.length; i++) {
          const row = data[i] || [];
          const desc = String(row[col.name] || '').trim();
          if (!desc || desc.length < 3) continue;
          out.push({
            description: desc,
            qty: col.qty !== undefined ? (parseNum(row[col.qty]) || 1) : 1,
            unit: col.unit !== undefined ? String(row[col.unit] || '').trim() : '',
          });
        }
        return out;
      };
      for (const name of wb.SheetNames) { const r = parseSheet(name); if (r.length > lines.length) lines = r; }
    }
    if (!lines.length) { const e = new Error('Could not read any items. For Excel: ensure a Description/Qty header row. For PDF/Word: the items must be text (not a scanned image).'); e.status = 400; throw e; }

    // Match the client BOQ against OUR PO items only (the ones quoted, with
    // PO/FOC kits) — mam 2026-06-10. FOC/consumables aren't quoted as lines.
    const items = getDb().prepare(`SELECT id, item_code, department, item_name, specification, size, uom, make, current_price FROM item_master WHERE type='PO'`).all();
    const itemById = new Map(items.map(it => [it.id, it]));
    const itemTok = items.map(it => ({ it, toks: tokens([it.item_name, it.specification, it.size].filter(Boolean).join(' ')) }));

    // PO/FOC kits keyed by po_item_id (approved preferred) — so a matched item
    // carries its PP rate + labour + FOC straight to the quotation line.
    const kitById = new Map();
    for (const k of getDb().prepare('SELECT po_item_id, po_rate, labour, focs_json, status FROM po_foc_entries WHERE po_item_id IS NOT NULL').all()) {
      if (!kitById.has(k.po_item_id) || k.status === 'approved') kitById.set(k.po_item_id, k);
    }

    const mk = (it, score) => {
      if (!it) return null;
      const k = kitById.get(it.id);
      const base = {
        item_id: it.id, code: it.item_code,
        name: [it.item_name, it.specification, it.size].filter(Boolean).join(' / '),
        department: it.department || 'General', rate: it.current_price || 0,
        uom: it.uom || '', make: it.make || '', score: Math.round(score || 0),
      };
      if (k) { base.kit_pp = k.po_rate || 0; base.kit_labour = k.labour || 0; base.kit_focs = JSON.parse(k.focs_json || '[]'); }
      return base;
    };

    // Fuzzy shortlist per line (also the candidate set handed to the AI).
    const ranked = lines.map(line => {
      const lset = new Set(tokens(line.description));
      const scored = itemTok.map(({ it, toks }) => ({ it, score: scoreMatch(lset, toks) }))
        .filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
      return { line, scored };
    });

    // Best-effort AI refinement; falls back to fuzzy if not configured / errors.
    let llm = null;
    try { llm = await llmRefine(ranked); } catch (e) { llm = null; }

    const rows = ranked.map((r, i) => {
      const { line, scored } = r;
      const alts = scored.map(s => mk(s.it, s.score * 100)).filter(Boolean);
      // A very strong fuzzy match (≥85%) is auto-applied as the match — don't
      // let the LLM bump a near-exact name into "try:" (mam 2026-06-10).
      const strong = scored[0] && scored[0].score >= 0.85 ? scored[0] : null;
      if (strong) {
        return {
          description: line.description, qty: line.qty, unit: line.unit,
          confidence: 'high', match: mk(strong.it, strong.score * 100),
          alternatives: alts.filter(a => a.item_id !== strong.it.id).slice(0, 3),
        };
      }
      if (llm && llm[i] !== undefined) {
        const pick = llm[i];
        const it = (pick.item_id != null) ? itemById.get(pick.item_id) : null;
        const cf = Number(pick.confidence) || 0;
        const conf = it ? (cf >= 70 ? 'high' : cf >= 40 ? 'medium' : 'low') : 'none';
        return {
          description: line.description, qty: line.qty, unit: line.unit,
          confidence: it ? conf : 'none', match: it ? mk(it, cf) : null,
          alternatives: alts.filter(a => !it || a.item_id !== it.id).slice(0, 3),
        };
      }
      const best = scored[0];
      const sc = best ? best.score : 0;
      const conf = sc === 0 ? 'none' : sc < 0.3 ? 'low' : sc < 0.6 ? 'medium' : 'high';
      return {
        description: line.description, qty: line.qty, unit: line.unit,
        confidence: best ? conf : 'none', match: best ? mk(best.it, sc * 100) : null,
        alternatives: alts.slice(1, 4),
      };
    });
    return { count: rows.length, rows, matched_by: llm ? 'ai' : 'keyword' };
}

// Upload a BOQ file → match (the original route).
router.post('/auto-match-boq', requirePermission('quotations', 'view'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    res.json(await matchBoqFile(req.file.path, req.file.originalname));
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Failed to parse BOQ: ' + err.message) });
  } finally {
    try { fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
  }
});

// Auto-load a client's BOQ from the Sales Funnel and match it (mam 2026-06-22).
// No manual upload: find the funnel BOQ file for the selected lead's company
// and run the same matcher. lead_id comes from the /leads dropdown.
router.get('/client-boq', async (req, res) => {
  try {
    const db = getDb();
    const id = req.query.funnel_id || req.query.lead_id;
    if (!id) return res.status(400).json({ error: 'client id required' });
    // The Estimator's Client dropdown IS the Sales Funnel, so look the row up
    // directly by id and take its BOQ file (revised first, then original).
    let name = '', link = null;
    const sfRow = db.prepare('SELECT client_name, company_name, revised_boq_file_link, boq_file_link FROM sales_funnel WHERE id=?').get(id);
    if (sfRow) {
      name = (sfRow.company_name || sfRow.client_name || '').trim();
      link = sfRow.revised_boq_file_link || sfRow.boq_file_link || null;
      // The denormalized column can be stale/null while the funnel's BOQ history
      // (the "BOQs (N)" list) holds the actual file — check that too.
      if (!link) {
        const b = db.prepare(`SELECT boq_file_link FROM sales_funnel_boqs
                              WHERE funnel_id=? AND COALESCE(boq_file_link,'')<>''
                              ORDER BY created_at DESC, id DESC LIMIT 1`).get(id);
        if (b?.boq_file_link) link = b.boq_file_link;
      }
    } else {
      // Legacy fallback: a leads-table id → match the funnel by company name.
      const lead = db.prepare('SELECT company_name FROM leads WHERE id=?').get(id);
      name = (lead?.company_name || '').trim();
    }
    // Still no link? Try matching sales_funnel / crm_funnel by the company name.
    if (!link && name) {
      const sf = db.prepare(`SELECT COALESCE(NULLIF(revised_boq_file_link,''), NULLIF(boq_file_link,'')) AS link
                       FROM sales_funnel WHERE (company_name=? OR client_name=?)
                         AND (COALESCE(revised_boq_file_link,'')<>'' OR COALESCE(boq_file_link,'')<>'')
                       ORDER BY id DESC LIMIT 1`).get(name, name);
      if (sf?.link) link = sf.link;
      if (!link) {
        const cf = db.prepare(`SELECT COALESCE(NULLIF(cust_boq_link,''), NULLIF(boq_file_link,'')) AS link
                         FROM crm_funnel WHERE (company_name=? OR client_name=?)
                           AND (COALESCE(cust_boq_link,'')<>'' OR COALESCE(boq_file_link,'')<>'')
                         ORDER BY id DESC LIMIT 1`).get(name, name);
        if (cf?.link) link = cf.link;
      }
    }
    if (!link) return res.status(404).json({ error: `No BOQ found in the Sales Funnel for "${name || 'this client'}". Upload it in the funnel, or use Upload Client BOQ.` });
    // Resolve the stored link (e.g. '/uploads/xxx') to the real uploads dir,
    // which is <repo>/data/uploads (see server/index.js). basename guards
    // against path traversal and handles full-URL links.
    const filename = path.basename(String(link).split('?')[0]);
    const filePath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!filename || !fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'The funnel BOQ file is not on this server — re-upload it in the funnel.' });
    }
    const out = await matchBoqFile(filePath, path.basename(filePath));
    res.json({ ...out, client_name: name });
  } catch (err) {
    res.status(err.status || 500).json({ error: err.status ? err.message : ('Failed to load client BOQ: ' + err.message) });
  }
});

// BOQ — the manually created rows PLUS every BOQ recorded on a Sales Funnel
// lead (mam 2026-08-27: "here need come data from sales funnel boq, if add and
// extra sales funnel boq"). Funnel rows are read-only references: the first
// BOQ on a lead shows as FUNNEL, later ones (the "additional BOQ" path) as
// EXTRA. The CRM Sales Funnel's customer BOQs list alongside them (mam
// 2026-09-07). Ids are prefixed (sf-/sfl-/cf-) so they can never collide with
// native boq ids or be deleted/quoted by mistake.
router.get('/boq', (req, res) => {
  const db = getDb();
  const native = db.prepare(`SELECT b.*, l.company_name, u.name as created_by_name, 'boq' AS source FROM boq b
    LEFT JOIN leads l ON b.lead_id=l.id LEFT JOIN users u ON b.created_by=u.id ORDER BY b.created_at DESC`).all();
  let funnel = [];
  try {
    funnel = db.prepare(`
      SELECT fb.id, fb.funnel_id, fb.boq_file_link, fb.boq_amount AS total_amount,
             fb.notes, fb.created_by AS created_by_name, fb.created_at,
             COALESCE(NULLIF(sf.company_name,''), sf.client_name) AS company_name,
             (SELECT COUNT(*) FROM sales_funnel_boqs x
               WHERE x.funnel_id = fb.funnel_id
                 AND (x.created_at < fb.created_at OR (x.created_at = fb.created_at AND x.id < fb.id))) AS prior_count
        FROM sales_funnel_boqs fb
        JOIN sales_funnel sf ON sf.id = fb.funnel_id
       ORDER BY fb.created_at DESC, fb.id DESC`).all()
      .map(r => ({
        id: `sf-${r.id}`,
        source: r.prior_count > 0 ? 'funnel_extra' : 'funnel',
        title: `${r.prior_count > 0 ? 'Extra BOQ' : 'Funnel BOQ'}${r.notes ? ` — ${r.notes}` : ''}`,
        company_name: r.company_name,
        drawing_required: 0,
        total_amount: r.total_amount || 0,
        status: r.prior_count > 0 ? 'extra' : 'funnel',
        created_at: r.created_at,
        boq_file_link: r.boq_file_link || null,
        created_by_name: r.created_by_name || null,
        funnel_id: r.funnel_id,
      }));
    // The lead's own latest columns can hold files the history table never
    // saw — the ORIGINAL and the REVISED BOQ (mam 2026-08-27 "previous also
    // add"). Emit each file that isn't already covered by a history row.
    const historyLinks = new Set(funnel.map(r => `${r.funnel_id}|${r.boq_file_link || ''}`));
    const latest = db.prepare(`
      SELECT sf.id AS funnel_id,
             COALESCE(NULLIF(sf.company_name,''), sf.client_name) AS company_name,
             NULLIF(sf.boq_file_link,'') AS boq_file_link,
             NULLIF(sf.revised_boq_file_link,'') AS revised_boq_file_link,
             COALESCE(sf.boq_amount, 0) AS total_amount,
             COALESCE(sf.boq_date, sf.updated_at, sf.created_at) AS created_at,
             EXISTS (SELECT 1 FROM sales_funnel_boqs x WHERE x.funnel_id = sf.id) AS has_history
        FROM sales_funnel sf
       WHERE COALESCE(sf.boq_file_link,'') <> '' OR COALESCE(sf.revised_boq_file_link,'') <> ''
          OR COALESCE(sf.boq_amount, 0) > 0`).all();
    for (const r of latest) {
      const emitted = [];
      if (r.boq_file_link && !historyLinks.has(`${r.funnel_id}|${r.boq_file_link}`)) {
        emitted.push({ link: r.boq_file_link, title: 'Funnel BOQ', status: 'funnel', source: 'funnel' });
      }
      if (r.revised_boq_file_link && r.revised_boq_file_link !== r.boq_file_link
          && !historyLinks.has(`${r.funnel_id}|${r.revised_boq_file_link}`)) {
        emitted.push({ link: r.revised_boq_file_link, title: 'Revised BOQ', status: 'extra', source: 'funnel_extra' });
      }
      // A lead with only an amount (no files) and no history still gets one row.
      if (!emitted.length && !r.has_history && r.total_amount > 0) {
        emitted.push({ link: null, title: 'Funnel BOQ', status: 'funnel', source: 'funnel' });
      }
      emitted.forEach((e, i) => funnel.push({
        id: `sfl-${r.funnel_id}-${i}`, source: e.source, title: e.title,
        company_name: r.company_name, drawing_required: 0,
        // amount belongs to the LATEST file — earlier files show 0 rather
        // than repeating a total they may not represent.
        total_amount: (i === emitted.length - 1) ? r.total_amount : 0,
        status: e.status, created_at: r.created_at,
        boq_file_link: e.link, funnel_id: r.funnel_id,
      }));
    }
  } catch (e) { /* funnel tables missing on a stale DB — native list still serves */ }
  // CRM Sales Funnel BOQs (mam 2026-09-07: "here boq from sales funnel and
  // from crm sales funnel where fill Customer BOQ File (optional)"). Only
  // leads that actually carry a BOQ file/link are listed — crm_funnel has no
  // BOQ amount column, so these rows show 0 rather than borrowing
  // quotation_amount, which is the QUOTE value and not a BOQ cost.
  // Deliberately its OWN try/catch, outside the block above, so a crm failure
  // can never wipe the sales-funnel rows already collected.
  // Gated on the CRM module's OWN view right (see hasModuleRight): this
  // endpoint has no requirePermission, so without the check a role whose CRM
  // access mam has revoked would still read every CRM lead from this tab.
  let crm = [];
  if (hasModuleRight(db, req.user, 'crm_funnel', 'view')) {
    try {
      // One row per row of the row shape below — built once here so the three
      // sources (history file, latest file, typed link) can never drift apart.
      const emit = (r, id, label, link, createdAt) => {
        const extra = r.lead_type === 'Extra Enquiry';
        crm.push({
          id,
          source: extra ? 'crm_extra' : 'crm',
          title: `${extra ? 'Extra BOQ' : 'CRM BOQ'}${r.lead_no ? ` — ${r.lead_no}` : ''} · ${label}`,
          company_name: r.company_name,
          drawing_required: 0,
          // No BOQ amount exists on a CRM lead — 0, never an invented figure.
          // The client blanks the Total cell for these rather than showing Rs 0.
          total_amount: 0,
          status: extra ? 'extra' : 'funnel',
          created_at: createdAt,
          boq_file_link: link,
          created_by_name: r.created_by_name || null,
          // crm_id, NOT funnel_id: funnel_id is a sales_funnel id and the two id
          // spaces overlap, so quoting it would stamp a different client's lead.
          crm_id: r.crm_id,
        });
      };
      // EVERY BOQ ever attached to a lead, not just the one the column still
      // points at (mam 2026-09-07: "which attached previous also"). One query,
      // joined — never a lookup per lead.
      // Its own try/catch: on a stale DB without the history table this must
      // degrade to the old "latest columns only" list, not blank the CRM rows.
      let crmHistory = [];
      try {
        crmHistory = db.prepare(`
        SELECT cb.id, cb.crm_id, cb.boq_file_link, cb.notes, cb.created_at,
               cf.lead_no, cf.lead_type,
               COALESCE(NULLIF(cf.company_name,''), cf.client_name) AS company_name,
               COALESCE(NULLIF(cb.created_by,''), u.name) AS created_by_name
          FROM crm_funnel_boqs cb
          JOIN crm_funnel cf ON cf.id = cb.crm_id
          LEFT JOIN users u ON u.id = cf.created_by
         WHERE COALESCE(cb.boq_file_link,'') <> ''
         ORDER BY cb.created_at DESC, cb.id DESC`).all();
      } catch (_) { /* crm_funnel_boqs missing — latest columns still list */ }
      for (const h of crmHistory) {
        // Titled by the file itself; the note, then a generic label, stand in
        // when the link carries no filename.
        emit(h, `cf-h${h.id}`, boqFileTitle(h.boq_file_link) || h.notes || 'Customer BOQ File',
          h.boq_file_link, h.created_at);
      }
      // The lead's own columns can still hold a file the history never saw —
      // the typed Customer BOQ Link always, and boq_file_link on a lead saved
      // before this table existed and missed by the backfill. Same
      // `historyLinks` de-duplication the sales-funnel block above uses, keyed
      // crm_id|link, so a file that is both "latest" AND in history shows ONCE.
      const historyLinks = new Set(crmHistory.map(h => `${h.crm_id}|${h.boq_file_link}`));
      const crmLeads = db.prepare(`
        SELECT cf.id AS crm_id, cf.lead_no, cf.lead_type,
               COALESCE(NULLIF(cf.company_name,''), cf.client_name) AS company_name,
               NULLIF(cf.boq_file_link,'') AS boq_file_link,
               NULLIF(cf.cust_boq_link,'') AS cust_boq_link,
               -- updated_at first: these rows are derived from the lead's own
               -- columns, so a Customer BOQ Link typed today onto a lead opened
               -- in June must not sort into June, below every newer BOQ. Real
               -- uploads carry their own accurate date from the history table.
               COALESCE(cf.updated_at, cf.created_at) AS created_at, u.name AS created_by_name
          FROM crm_funnel cf
          LEFT JOIN users u ON u.id = cf.created_by
         WHERE COALESCE(cf.boq_file_link,'') <> '' OR COALESCE(cf.cust_boq_link,'') <> ''`).all();
      for (const r of crmLeads) {
        // The uploaded "Customer BOQ File" first, then the typed Customer BOQ
        // Link only when it is a DIFFERENT document — one row per distinct BOQ.
        const docs = [];
        if (r.boq_file_link && !historyLinks.has(`${r.crm_id}|${r.boq_file_link}`)) {
          docs.push({ label: boqFileTitle(r.boq_file_link) || 'Customer BOQ File', link: r.boq_file_link });
        }
        if (r.cust_boq_link && r.cust_boq_link !== r.boq_file_link
            && !historyLinks.has(`${r.crm_id}|${r.cust_boq_link}`)) {
          docs.push({ label: boqFileTitle(r.cust_boq_link) || 'Customer BOQ Link', link: externalLink(r.cust_boq_link) });
        }
        // The lead's created_at: crm_funnel has no boq_date, and updated_at
        // would reshuffle this list on every unrelated edit to the lead.
        // (History rows carry their own created_at, so multiple BOQs sort by
        // when each was actually attached.)
        docs.forEach((d, i) => emit(r, `cf-${r.crm_id}-${i}`, d.label, d.link, r.created_at));
      }
    } catch (e) { /* crm_funnel missing on a stale DB — the rest of the list still serves */ }
  }
  res.json([...native, ...funnel, ...crm].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))));
});

router.post('/boq', requirePermission('quotations', 'create'), (req, res) => {
  const { lead_id, title, drawing_required, items } = req.body;
  const db = getDb();
  const total = (items || []).reduce((s, i) => s + (i.quantity * i.rate), 0);
  const r = db.prepare('INSERT INTO boq (lead_id, title, drawing_required, total_amount, created_by) VALUES (?,?,?,?,?)')
    .run(lead_id, title, drawing_required ? 1 : 0, total, req.user.id);
  const insertItem = db.prepare('INSERT INTO boq_items (boq_id, description, quantity, unit, rate, amount, item_id) VALUES (?,?,?,?,?,?,?)');

  // AI Agent: when a line item is linked to a catalogue item AND has a
  // rate > 0, log it to item_price_history so everyone sees this rate
  // as a suggestion next time. Also bump item_master.current_price to
  // reflect the latest market rate the team is actually quoting.
  const insertHistory = db.prepare(`INSERT INTO item_price_history
    (item_id, rate, quantity, lead_id, company_name, boq_id, source, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const updateItemPrice = db.prepare('UPDATE item_master SET current_price=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const lead = lead_id ? db.prepare('SELECT company_name FROM leads WHERE id=?').get(lead_id) : null;
  const companyName = lead?.company_name || null;

  for (const i of (items || [])) {
    const itemId = i.item_id ? +i.item_id : null;
    insertItem.run(r.lastInsertRowid, i.description, i.quantity, i.unit, i.rate, i.quantity * i.rate, itemId);
    if (itemId && i.rate > 0) {
      insertHistory.run(itemId, i.rate, i.quantity || 0, lead_id || null, companyName, r.lastInsertRowid, 'boq', req.user.id, req.user.name || null);
      updateItemPrice.run(i.rate, itemId);
    }
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/boq/:id', (req, res) => {
  const boq = getDb().prepare('SELECT * FROM boq WHERE id=?').get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'Not found' });
  boq.items = getDb().prepare('SELECT * FROM boq_items WHERE boq_id=?').all(req.params.id);
  res.json(boq);
});

// Quotations — ERP rows PLUS quotations recorded on Sales Funnel leads
// (mam 2026-08-27: "upload quotations show here") and on CRM Sales Funnel
// leads (mam 2026-09-07). A funnel lead whose quotation was uploaded in the
// funnel (quotation_number/file/amount on sales_funnel, quotation_link/amount
// on crm_funnel) shows as a read-only FUNNEL / CRM row — unless a real
// quotations row already points at that lead, which supersedes it.
router.get('/', (req, res) => {
  const db = getDb();
  // cf joined so a quote raised on a CRM Sales Funnel BOQ still shows a client
  // name instead of a blank cell (mam 2026-09-07).
  // NULLIF on every text branch: a cleared company_name is stored as '' (not
  // NULL) by both funnel edit forms, and COALESCE stops at '' — which is how a
  // quotation ends up with a blank Client cell while the same lead shows its
  // name fine one tab away.
  const native = db.prepare(`SELECT q.*, COALESCE(NULLIF(l.company_name,''), NULLIF(sf.company_name,''), NULLIF(sf.client_name,''), NULLIF(cf.company_name,''), cf.client_name) AS company_name, u.name as created_by_name, 'quotation' AS source
    FROM quotations q
    LEFT JOIN leads l ON q.lead_id=l.id
    LEFT JOIN sales_funnel sf ON sf.id=q.funnel_id
    LEFT JOIN crm_funnel cf ON cf.id=q.crm_funnel_id
    LEFT JOIN users u ON q.created_by=u.id ORDER BY q.created_at DESC`).all();
  // SOP-03 S1 two clocks: starting when the quote went out (created_at) the
  // ball is with the CLIENT; each log entry flips it ('client' replied → ball
  // to us, 'us' replied → ball to client). Days accumulate on whoever holds it.
  try {
    const logs = db.prepare('SELECT quotation_id, side, at FROM quotation_negotiation_log ORDER BY quotation_id, at, id').all();
    const byQ = {};
    for (const l of logs) (byQ[l.quotation_id] = byQ[l.quotation_id] || []).push(l);
    const DAY = 86400000, now = Date.now();
    for (const q of native) {
      let ball = 'client', from = new Date(String(q.created_at).replace(' ', 'T') + 'Z').getTime();
      let cDays = 0, usDays = 0;
      if (!Number.isFinite(from)) from = now;
      for (const ev of (byQ[q.id] || [])) {
        const at = new Date(String(ev.at).replace(' ', 'T') + 'Z').getTime();
        if (Number.isFinite(at) && at > from) {
          if (ball === 'client') cDays += (at - from) / DAY; else usDays += (at - from) / DAY;
          from = at;
        }
        ball = ev.side === 'client' ? 'us' : 'client';
      }
      // Clocks stop once the negotiation is over.
      if (!['accepted', 'rejected'].includes(q.status) && now > from) {
        if (ball === 'client') cDays += (now - from) / DAY; else usDays += (now - from) / DAY;
      }
      q.clock_client_days = Math.round(cDays * 10) / 10;
      q.clock_us_days = Math.round(usDays * 10) / 10;
      q.clock_ball = ball;
    }
  } catch (e) { /* log table missing on a stale DB — list still serves */ }
  let funnel = [];
  try {
    funnel = db.prepare(`
      SELECT sf.id AS funnel_id, sf.quotation_number, sf.quotation_file_link,
             COALESCE(sf.quotation_amount, 0) AS quotation_amount,
             sf.quotation_sent_by, COALESCE(sf.quotation_sent_date, sf.updated_at, sf.created_at) AS created_at,
             COALESCE(NULLIF(sf.company_name,''), sf.client_name) AS company_name
        FROM sales_funnel sf
       WHERE (COALESCE(sf.quotation_number,'') <> '' OR COALESCE(sf.quotation_file_link,'') <> '' OR COALESCE(sf.quotation_amount,0) > 0)
         AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.funnel_id = sf.id)`).all()
      .map(r => ({
        id: `sfq-${r.funnel_id}`, source: 'funnel', funnel_id: r.funnel_id,
        quotation_number: r.quotation_number || `SF-${r.funnel_id}`,
        company_name: r.company_name,
        total_amount: r.quotation_amount, discount: 0, final_amount: r.quotation_amount,
        status: 'sent', created_at: r.created_at,
        quotation_file_link: r.quotation_file_link || null,
        created_by_name: r.quotation_sent_by || null,
      }));
  } catch (e) { /* stale DB without funnel columns — native list still serves */ }
  // The same read-only treatment for CRM Sales Funnel leads (mam 2026-09-07),
  // so a quotation raised on a CRM BOQ — or filled straight into the CRM
  // funnel — is visible here too. A real quotations row pointing at the lead
  // (crm_funnel_id) supersedes it, exactly as funnel_id does above.
  let crmQ = [];
  if (hasModuleRight(db, req.user, 'crm_funnel', 'view')) {
   try {
    crmQ = db.prepare(`
      SELECT cf.id AS crm_id, cf.lead_no, cf.quotation_link,
             COALESCE(cf.quotation_amount, 0) AS quotation_amount,
             -- quotation_submit_date can be an ISO string ('2026-09-07T09:12:33.123Z')
             -- or a bare date, while every other row here is SQLite's
             -- 'YYYY-MM-DD HH:MM:SS'. The merged list is ordered by a RAW string
             -- compare, so normalise the shape or these rows sort to the wrong day.
             SUBSTR(REPLACE(SUBSTR(COALESCE(cf.quotation_submit_date, cf.updated_at, cf.created_at), 1, 19), 'T', ' ') || ' 00:00:00', 1, 19) AS created_at,
             COALESCE(NULLIF(cf.company_name,''), cf.client_name) AS company_name,
             u.name AS created_by_name
        FROM crm_funnel cf
        LEFT JOIN users u ON u.id = cf.created_by
       WHERE (COALESCE(cf.quotation_submitted,0) = 1 OR COALESCE(cf.quotation_link,'') <> '' OR COALESCE(cf.quotation_amount,0) > 0)
         AND NOT EXISTS (SELECT 1 FROM quotations q WHERE q.crm_funnel_id = cf.id)`).all()
      .map(r => ({
        id: `cfq-${r.crm_id}`, source: 'crm', crm_id: r.crm_id,
        // crm_funnel has no quotation_number column — the lead no identifies it.
        quotation_number: r.lead_no || `CRM-${r.crm_id}`,
        company_name: r.company_name,
        total_amount: r.quotation_amount, discount: 0, final_amount: r.quotation_amount,
        status: 'sent', created_at: r.created_at,
        quotation_file_link: r.quotation_link || null,
        created_by_name: r.created_by_name || null,
      }));
   } catch (e) { /* stale DB without the crm columns — the rest of the list still serves */ }
  }
  res.json([...native, ...funnel, ...crmQ].sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || ''))));
});

// ── SOP-02 S5/S6: Margin Chart + floor rule (mam 2026-08-27) ──────────────
// GET the fixed margin chart + the floor — feeds the Quote modal's category
// dropdown and the "below floor goes to Sales Head" hint.
router.get('/margin-chart', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM quotation_margin_chart ORDER BY category').all();
  const setting = (k, d) => +(db.prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value || d);
  res.json({
    rows,
    floor: setting('quotation_margin_floor_pct', 10),
    // SOP-03 S3 discount chart: within auto → done; above → Sales Head;
    // above md → MD sir.
    discount_auto: setting('quotation_discount_auto_pct', 5),
    discount_md: setting('quotation_discount_md_pct', 10),
  });
});

// Upsert one chart row / set the floor — admin keeps the chart honest.
router.post('/margin-chart', adminOnly, (req, res) => {
  const db = getDb();
  const { category, margin_pct, floor, discount_auto, discount_md } = req.body || {};
  const setSetting = (k, v) => db.prepare(`INSERT INTO app_settings (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(k, String(+v || 0));
  if (floor != null) setSetting('quotation_margin_floor_pct', floor);
  if (discount_auto != null) setSetting('quotation_discount_auto_pct', discount_auto);
  if (discount_md != null) setSetting('quotation_discount_md_pct', discount_md);
  if (category && String(category).trim()) {
    db.prepare(`INSERT INTO quotation_margin_chart (category, margin_pct, updated_by, updated_at)
                VALUES (?, ?, ?, CURRENT_TIMESTAMP)
                ON CONFLICT(category) DO UPDATE SET margin_pct=excluded.margin_pct,
                  updated_by=excluded.updated_by, updated_at=CURRENT_TIMESTAMP`)
      .run(String(category).trim(), +margin_pct || 0, req.user.id);
  }
  res.json({ ok: true });
});

router.delete('/margin-chart/:id', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM quotation_margin_chart WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Who may decide a below-floor margin: admin, anyone holding can_approve on
// quotations, or the Sales Head by name (SOP-02 S6 names Rajat Sharma —
// same by-name pattern as the vendor-PO approvers).
const canDecideMargin = (db, user) => {
  if (user.role === 'admin') return true;
  const n = (user.name || '').toLowerCase();
  if (n.includes('rajat') && n.includes('sharma')) return true;
  try {
    return !!db.prepare(`SELECT 1 FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id
      WHERE ur.user_id=? AND rp.module='quotations' AND rp.can_approve=1`).get(user.id);
  } catch { return false; }
};

// Sales Head decision on a below-floor quotation (SOP-02 S6).
router.post('/:id/margin-decision', (req, res) => {
  try {
    const db = getDb();
    if (!canDecideMargin(db, req.user)) {
      return res.status(403).json({ error: 'Only the Sales Head (or admin / quotations-approve) can decide a below-floor margin' });
    }
    const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    if (q.margin_approval !== 'pending') return res.status(409).json({ error: 'This quotation is not waiting for a margin decision' });
    const approve = req.body?.action === 'approve';
    db.prepare('UPDATE quotations SET margin_approval=?, status=?, notes=COALESCE(notes,\'\') || ? WHERE id=?')
      .run(approve ? 'approved' : 'rejected',
           approve ? 'draft' : 'rejected',
           ` | Margin ${approve ? 'APPROVED' : 'REJECTED'} by ${req.user.name}${req.body?.reason ? `: ${req.body.reason}` : ''}`,
           q.id);
    // The funnel stage is stamped only once the quote may go out (S7).
    if (approve && q.funnel_id) {
      db.prepare(`UPDATE sales_funnel SET quotation_number=?, quotation_amount=?,
                    quotation_file_link=COALESCE(?, quotation_file_link),
                    quotation_sent_by=?, quotation_sent_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(q.quotation_number, q.final_amount, q.quotation_file_link || null, req.user.name || null, q.funnel_id);
    } else if (approve && q.crm_funnel_id) {
      // Same release for a CRM Sales Funnel quote (mam 2026-09-07) — without
      // this a below-floor CRM quote is approved here but the CRM lead never
      // leaves Step 1 and the team thinks no quote went out.
      db.prepare(`UPDATE crm_funnel SET quotation_amount=?, quotation_link=COALESCE(?, quotation_link),
                    quotation_submitted=1, quotation_submit_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(q.final_amount, q.quotation_file_link || null, q.crm_funnel_id);
    }
    res.json({ ok: true, status: approve ? 'draft' : 'rejected' });
  } catch (err) {
    console.error('margin-decision error', err);
    res.status(500).json({ error: err.message });
  }
});

// Quote a Sales Funnel BOQ with margin (mam 2026-08-27, SOP-02 F5-F7):
// base = the BOQ cost, final = base × (1 + margin%). Creates a real
// quotation row AND stamps the funnel lead's quotation_* columns so the
// funnel board and this page stay in sync. Takes a CRM Sales Funnel BOQ the
// same way (mam 2026-09-07) — crm_id instead of funnel_id.
router.post('/funnel-quote', requirePermission('quotations', 'create'), (req, res) => {
  try {
    const { funnel_id, crm_id, base_amount, margin_pct, category, quotation_file_link, valid_until, notes } = req.body || {};
    const db = getDb();
    // The BOQ comes either from the Sales Funnel or from the CRM Sales Funnel
    // (mam 2026-09-07). The two ids are kept in SEPARATE fields on purpose:
    // both tables autoincrement from 1, so one id in the wrong field would
    // quote — and stamp — a completely different client's lead.
    const funnelId = funnel_id != null && funnel_id !== '' ? +funnel_id : null;
    const crmId = crm_id != null && crm_id !== '' ? +crm_id : null;
    if (!funnelId && !crmId) return res.status(400).json({ error: 'Pick a funnel BOQ to quote' });
    if (funnelId && crmId) return res.status(400).json({ error: 'A quotation belongs to ONE lead — send funnel_id or crm_id, not both' });
    const sf = funnelId ? db.prepare('SELECT id, company_name, client_name FROM sales_funnel WHERE id=?').get(funnelId) : null;
    if (funnelId && !sf) return res.status(404).json({ error: 'Funnel lead not found' });
    const cf = crmId ? db.prepare('SELECT id, lead_no, company_name, client_name, final_status, quotation_amount FROM crm_funnel WHERE id=?').get(crmId) : null;
    if (crmId && !cf) return res.status(404).json({ error: 'CRM lead not found' });
    // Quoting a CRM lead WRITES to crm_funnel (below), so it needs the CRM
    // module's own edit right — quotations:create is held by every non-Viewer
    // role while crm_funnel edit is admin-only, so without this the CRM board
    // could be moved by people that module refuses (mam 2026-09-07).
    if (cf && !hasModuleRight(db, req.user, 'crm_funnel', 'edit')) {
      return res.status(403).json({ error: 'No edit permission for crm_funnel — ask an admin to quote this CRM lead' });
    }
    // A closed deal's recorded quote value is history: crm_funnel keeps no
    // revision of it, so re-quoting a won/lost lead would overwrite the real
    // figure with no way back.
    if (cf && ['win', 'loss'].includes(String(cf.final_status || '').toLowerCase())) {
      return res.status(409).json({ error: `${cf.lead_no || ("CRM-" + cf.id)} is already closed (${cf.final_status}) — its quoted value can't be overwritten` });
    }
    const base = +base_amount || 0;
    if (base <= 0) return res.status(400).json({ error: 'Enter the BOQ base amount' });
    // Margin resolution (SOP-02 S5 "margin chart, not guesswork"):
    // explicit % from the form → else the chart's % for the picked category.
    let margin = margin_pct != null && margin_pct !== '' ? +margin_pct : null;
    if (margin == null && category) {
      margin = db.prepare('SELECT margin_pct FROM quotation_margin_chart WHERE category=?').get(category)?.margin_pct ?? null;
    }
    margin = +margin || 0;
    // Floor rule (S6): at/above the floor the quote approves on its own;
    // below it, it parks as pending_approval for the Sales Head and the
    // funnel is NOT stamped until the decision.
    const floor = +(db.prepare("SELECT value FROM app_settings WHERE key='quotation_margin_floor_pct'").get()?.value || 10);
    const belowFloor = margin < floor;
    const finalAmt = Math.round(base * (1 + margin / 100) * 100) / 100;
    const { nextSequence } = require('../db/nextSequence');
    const qNum = nextSequence(db, 'quotations', 'quotation_number', 'QTN-', { startFrom: 0, pad: 4 });
    const lead = sf || cf;
    const clientName = lead.company_name || lead.client_name || '';
    const r = db.prepare(`INSERT INTO quotations
        (lead_id, boq_id, quotation_number, total_amount, discount, final_amount, valid_until, notes, status, margin_approval, created_by, funnel_id, crm_funnel_id, margin_pct, quotation_file_link)
        VALUES (NULL, NULL, ?, ?, 0, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?)`)
      .run(qNum, base, finalAmt, valid_until || null,
           notes || `Margin ${margin}%${category ? ` (${category})` : ''} on ${cf ? 'CRM funnel' : 'funnel'} BOQ — ${clientName}`,
           belowFloor ? 'pending' : null,
           req.user.id, sf ? sf.id : null, cf ? cf.id : null, margin, quotation_file_link || null);
    if (!belowFloor && sf) {
      db.prepare(`UPDATE sales_funnel SET quotation_number=?, quotation_amount=?, quotation_file_link=COALESCE(?, quotation_file_link),
                    quotation_sent_by=?, quotation_sent_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(qNum, finalAmt, quotation_file_link || null, req.user.name || null, sf.id);
    } else if (!belowFloor && cf) {
      // Same stamp on the CRM lead (mam 2026-09-07). quotation_submitted=1 is
      // what moves it out of Step 1; crm_funnel has no quotation_number /
      // sent_by column, so the QTN number lives on the quotation row here.
      db.prepare(`UPDATE crm_funnel SET quotation_amount=?, quotation_link=COALESCE(?, quotation_link),
                    quotation_submitted=1, quotation_submit_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(finalAmt, quotation_file_link || null, cf.id);
    }
    res.status(201).json({
      id: r.lastInsertRowid, quotation_number: qNum, final_amount: finalAmt,
      status: 'draft', margin_approval: belowFloor ? 'pending' : null, floor, margin,
      message: belowFloor ? `Margin ${margin}% is below the ${floor}% floor — sent to the Sales Head for a decision` : undefined,
    });
  } catch (err) {
    console.error('funnel-quote error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SOP-03 S3: discount chart gate (mam 2026-08-27) ───────────────────────
// Discount within quotation_discount_auto_pct → done on its own. Above it →
// Sales Head. Above quotation_discount_md_pct → MD sir.
const discountGate = (db, total, discount) => {
  const pct = +total > 0 ? Math.round(((+discount || 0) / +total) * 10000) / 100 : 0;
  const auto = +(db.prepare("SELECT value FROM app_settings WHERE key='quotation_discount_auto_pct'").get()?.value || 5);
  const mdAt = +(db.prepare("SELECT value FROM app_settings WHERE key='quotation_discount_md_pct'").get()?.value || 10);
  return { pct, auto, mdAt, level: pct > mdAt ? 'pending_md' : (pct > auto ? 'pending_sh' : null) };
};

router.post('/', requirePermission('quotations', 'create'), (req, res) => {
  const { lead_id, boq_id, total_amount, discount, final_amount, valid_until, notes } = req.body;
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const qNum = nextSequence(db, 'quotations', 'quotation_number', 'QTN-', { startFrom: 0, pad: 4 });
  const gate = discountGate(db, total_amount, discount);
  const r = db.prepare(
    'INSERT INTO quotations (lead_id, boq_id, quotation_number, total_amount, discount, final_amount, valid_until, notes, discount_approval, created_by) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(lead_id, boq_id, qNum, total_amount, discount || 0, final_amount, valid_until, notes, gate.level, req.user.id);
  res.status(201).json({
    id: r.lastInsertRowid, quotation_number: qNum, discount_approval: gate.level,
    message: gate.level === 'pending_md' ? `Discount ${gate.pct}% is above ${gate.mdAt}% — needs MD sir's approval`
           : gate.level === 'pending_sh' ? `Discount ${gate.pct}% is above the ${gate.auto}% chart — needs the Sales Head's approval`
           : undefined,
  });
});

router.put('/:id', requirePermission('quotations', 'edit'), (req, res) => {
  const { total_amount, discount, final_amount, status, valid_until, notes } = req.body;
  const db = getDb();
  const prev = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Quotation not found' });
  // Re-run the discount gate ONLY when the discount actually changed —
  // an already-approved discount must not re-park on a plain status change.
  let discountApproval = prev.discount_approval;
  if (+discount !== +prev.discount || +total_amount !== +prev.total_amount) {
    discountApproval = discountGate(db, total_amount, discount).level;
  }
  // Gates on booking the order: margin (SOP-02 S6) and discount (SOP-03 S3)
  // must both be settled before 'accepted'.
  if (status === 'accepted') {
    if (prev.margin_approval === 'pending') return res.status(409).json({ error: 'Margin is below the floor and still waiting for the Sales Head — cannot book the order yet' });
    if (discountApproval === 'pending_sh') return res.status(409).json({ error: 'Discount is above the chart and waiting for the Sales Head — cannot book the order yet' });
    if (discountApproval === 'pending_md') return res.status(409).json({ error: "Discount needs MD sir's approval — cannot book the order yet" });
  }
  db.prepare('UPDATE quotations SET total_amount=?, discount=?, final_amount=?, status=?, valid_until=?, notes=?, discount_approval=? WHERE id=?')
    .run(total_amount, discount, final_amount, status, valid_until, notes, discountApproval, req.params.id);

  // ── SOP-03 S4/S5: "Order mila!" — ONE project record + handover ─────────
  // First transition into 'accepted' creates the Business Book record the
  // whole company uses, and informs PM / Purchase / Accounts together.
  let project = null;
  if (status === 'accepted' && prev.status !== 'accepted' && !prev.business_book_id) {
    try {
      const { nextSequence } = require('../db/nextSequence');
      const lead = prev.lead_id ? db.prepare('SELECT company_name, contact_person, email FROM leads WHERE id=?').get(prev.lead_id) : null;
      const sf = prev.funnel_id ? db.prepare('SELECT company_name, client_name FROM sales_funnel WHERE id=?').get(prev.funnel_id) : null;
      // A quote raised on a CRM Sales Funnel BOQ has no lead_id and no
      // funnel_id (mam 2026-09-07) — without this the project record would be
      // created, once and for ever, literally named "Client".
      const cf = prev.crm_funnel_id ? db.prepare('SELECT company_name, client_name FROM crm_funnel WHERE id=?').get(prev.crm_funnel_id) : null;
      const clientName = lead?.company_name || sf?.company_name || sf?.client_name || cf?.company_name || cf?.client_name || 'Client';
      const leadNo = nextSequence(db, 'business_book', 'lead_no', 'SEPL', { startFrom: 20000, pad: 5 });
      const bb = db.prepare(`INSERT INTO business_book
          (lead_no, client_name, company_name, project_name, sale_amount_without_gst, po_amount)
          VALUES (?,?,?,?,?,?)`)
        .run(leadNo, clientName, clientName, `${clientName} — ${prev.quotation_number}`,
             +final_amount || +prev.final_amount || 0, +final_amount || +prev.final_amount || 0);
      db.prepare('UPDATE quotations SET business_book_id=? WHERE id=?').run(bb.lastInsertRowid, prev.id);
      project = { business_book_id: bb.lastInsertRowid, lead_no: leadNo };
      // S5 handover — PM, Purchase and Accounts informed together: the
      // module owners of DPR / Procurement / Payments (where set) + admins.
      try {
        const owners = db.prepare(`SELECT DISTINCT owner_user_id AS id FROM module_owners
            WHERE module_key IN ('dpr','procurement','payment_required') AND owner_user_id IS NOT NULL`).all();
        const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1").all();
        const ids = [...new Set([...owners, ...admins].map(u => u.id))];
        const title = `Order booked — ${clientName}`;
        const body = `${prev.quotation_number} accepted · Rs ${(+final_amount || 0).toLocaleString('en-IN')} · project record ${leadNo} created. Handover pack: BOQ & files on the Quotations page / Sales Funnel.`;
        const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
                                VALUES (?,?,?,?,?,?,?)`);
        for (const uid of ids) ins.run(uid, 'order_booked', title, body, '/business-book', 'in_app', `order-booked-q${prev.id}-${uid}`);
        try { require('../lib/push').notifyMany(ids, { title, body, url: '/business-book' }); } catch (_) {}
      } catch (e) { console.warn('[order-booked] notify failed:', e.message); }
    } catch (e) { console.error('[order-booked] project record failed:', e.message); }
  }
  res.json({ message: 'Updated', discount_approval: discountApproval, project });
});

// S3 decision: pending_sh → Sales Head (Rajat Sharma / quotations-approve /
// admin); pending_md → MD sir (Ankur Kaplesh / admin).
router.post('/:id/discount-decision', (req, res) => {
  try {
    const db = getDb();
    const q = db.prepare('SELECT * FROM quotations WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).json({ error: 'Quotation not found' });
    if (q.discount_approval !== 'pending_sh' && q.discount_approval !== 'pending_md') {
      return res.status(409).json({ error: 'This quotation is not waiting for a discount decision' });
    }
    const n = (req.user.name || '').toLowerCase();
    const isMd = n.includes('ankur') || req.user.role === 'admin';
    if (q.discount_approval === 'pending_md' && !isMd) {
      return res.status(403).json({ error: "This discount level needs MD sir (Ankur Kaplesh) or admin" });
    }
    if (q.discount_approval === 'pending_sh' && !canDecideMargin(db, req.user) && !isMd) {
      return res.status(403).json({ error: 'Only the Sales Head (Rajat Sharma), quotations-approve holders, MD or admin can decide this discount' });
    }
    const approve = req.body?.action === 'approve';
    db.prepare("UPDATE quotations SET discount_approval=?, notes=COALESCE(notes,'') || ? WHERE id=?")
      .run(approve ? 'approved' : 'rejected',
           ` | Discount ${approve ? 'APPROVED' : 'REJECTED'} by ${req.user.name}${req.body?.reason ? `: ${req.body.reason}` : ''}`,
           q.id);
    res.json({ ok: true, discount_approval: approve ? 'approved' : 'rejected' });
  } catch (err) {
    console.error('discount-decision error', err);
    res.status(500).json({ error: err.message });
  }
});

// ── SOP-03 S1: two-clock negotiation log ──────────────────────────────────
// One tap per event: 'client' = client replied (ball comes to US),
// 'us' = we replied / re-quoted (ball goes to the CLIENT).
router.post('/:id/negotiation-log', requirePermission('quotations', 'edit'), (req, res) => {
  const db = getDb();
  const side = req.body?.side === 'client' ? 'client' : 'us';
  const q = db.prepare('SELECT id FROM quotations WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  db.prepare('INSERT INTO quotation_negotiation_log (quotation_id, side, note, created_by) VALUES (?,?,?,?)')
    .run(q.id, side, (req.body?.note || '').slice(0, 300) || null, req.user.id);
  res.json({ ok: true });
});

router.delete('/:id', requirePermission('quotations', 'delete'), (req, res) => {
  const db = getDb();
  const poCount = db.prepare('SELECT COUNT(*) as c FROM purchase_orders WHERE quotation_id=?').get(req.params.id).c;
  if (poCount > 0) return res.status(409).json({ error: 'Cannot delete: Purchase Orders reference this quotation' });
  db.prepare('DELETE FROM quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.delete('/boq/:id', requirePermission('quotations', 'delete'), (req, res) => {
  const db = getDb();
  const qCount = db.prepare('SELECT COUNT(*) as c FROM quotations WHERE boq_id=?').get(req.params.id).c;
  if (qCount > 0) return res.status(409).json({ error: 'Cannot delete: Quotations reference this BOQ' });
  db.prepare('DELETE FROM boq_items WHERE boq_id=?').run(req.params.id);
  db.prepare('DELETE FROM boq WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── PO/FOC Stripped (mam 2026-06-09) ──────────────────────────────
// Each entry = one PO item + FOC items + labour + margin, with an
// approval workflow (non_approved → approved → re_approved on later edit).
function computePoFoc(body) {
  const qty = Number(body.qty) || 0;
  const poRate = Number(body.po_rate) || 0;
  const labour = Number(body.labour) || 0;                 // labour rate (from labour_rates)
  const margin = Number(body.margin) || 0;
  const labourMargin = (body.labour_margin === '' || body.labour_margin == null) ? 50 : Number(body.labour_margin) || 0;
  const focs = Array.isArray(body.focs) ? body.focs.filter(f => f && (f.item_id || f.name)).map(f => ({
    item_id: f.item_id || null, name: f.name || '', qty: Number(f.qty) || 1, rate: Number(f.rate) || 0,
    // Per-FOC margin (mam 2026-06-23). null → inherits the PO margin so legacy
    // rows + the FOC-% line recompute exactly as before.
    margin: (f.margin === '' || f.margin == null) ? null : (Number(f.margin) || 0),
    ...(f.foc ? { foc: true } : {}),
    ...(f.is_pct ? { is_pct: true, foc_pct: f.foc_pct } : {}),
  })) : [];
  const poAmt = poRate * qty;
  const focAmt = focs.reduce((t, f) => t + f.rate * f.qty, 0);
  // Each FOC carries its OWN margin; null falls back to the PO margin.
  const focSale = focs.reduce((t, f) => t + f.rate * f.qty * (1 + ((f.margin == null ? margin : f.margin) / 100)), 0);
  const labourAmt = labour * qty;                          // labour RATE × PO qty
  const cost = Math.round((poAmt + focAmt + labourAmt) * 100) / 100;
  // PO carries the item margin, each FOC its own margin, labour its own.
  const tpa = Math.round((poAmt * (1 + margin / 100) + focSale + labourAmt * (1 + labourMargin / 100)) * 100) / 100;
  return { qty, poRate, labour, margin, labourMargin, focs, cost, tpa };
}

// Rebuild the same "[code] name / spec / size · uom" label the client shows.
function itemDisplay(im) {
  return `${im.item_code ? '[' + im.item_code + '] ' : ''}` +
    `${[im.item_name, im.specification, im.size].filter(Boolean).join(' / ')}` +
    `${im.uom ? ' · ' + im.uom : ''}`;
}

// Preload item_master + labour_rates into Maps so liveResolvePoFoc does O(1)
// in-memory lookups instead of a DB query per entry AND per FOC item. The list
// has 800+ kits × ~6-8 FOC each, so the old per-row queries meant thousands of
// point lookups on every load/approve and the page crawled (mam 2026-06-11:
// "takes lots of process time"). Two bulk reads replace all of them.
function buildLiveMaps(db) {
  const items = new Map();
  for (const im of db.prepare('SELECT id, item_code, item_name, specification, size, uom, current_price FROM item_master').all()) items.set(im.id, im);
  const labour = new Map();
  for (const lr of db.prepare('SELECT id, item_name, rate FROM labour_rates').all()) labour.set(lr.id, lr);
  return { items, labour };
}

// Serve an entry LIVE against the Item Master (mam 2026-06-11): PO rate, FOC
// rates, names and UOM are re-read by id every time, so editing an item's
// rate/UOM in the master reflects on existing PO/FOC entries. Stored values
// stay as a fallback when the item was deleted or typed manually (no item_id).
// cost/TPA are recomputed from the live rates so cards and PDF stay consistent.
function liveResolvePoFoc(row, maps) {
  let { po_rate, po_name, labour, labour_name } = row;
  if (row.po_item_id) {
    const im = maps.items.get(row.po_item_id);
    if (im) { po_rate = im.current_price || 0; po_name = itemDisplay(im); }
  }
  // Labour is live off the Labour Rate sheet too.
  if (row.labour_item_id) {
    const lr = maps.labour.get(row.labour_item_id);
    if (lr) { labour = lr.rate || 0; labour_name = lr.item_name; }
  }
  const focs = JSON.parse(row.focs_json || '[]').map(f => {
    if (f && f.item_id) {
      const im = maps.items.get(f.item_id);
      if (im) return { ...f, rate: im.current_price || 0, name: itemDisplay(im) };
    }
    return f;
  });
  const c = computePoFoc({ qty: row.qty, po_rate, labour, margin: row.margin, labour_margin: row.labour_margin, focs });
  return { ...row, po_rate, po_name, labour, labour_name, focs, cost: c.cost, tpa: c.tpa };
}

router.get('/po-foc', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM po_foc_entries ORDER BY updated_at DESC, id DESC').all();
  const counts = { non_approved: 0, approved: 0, re_approved: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  const maps = buildLiveMaps(db);
  res.json({ rows: rows.map(r => liveResolvePoFoc(r, maps)), counts });
});

router.get('/po-foc/:id', (req, res) => {
  const db = getDb();
  const r = db.prepare('SELECT * FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json(liveResolvePoFoc(r, buildLiveMaps(db)));
});

router.post('/po-foc', requirePermission('quotations', 'create'), (req, res) => {
  const c = computePoFoc(req.body);
  const r = getDb().prepare(
    `INSERT INTO po_foc_entries (po_item_id, po_name, po_rate, qty, labour, labour_item_id, labour_name, labour_margin, margin, focs_json, cost, tpa, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'non_approved', ?)`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/po-foc/:id', requirePermission('quotations', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT status FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const c = computePoFoc(req.body);
  // Editing an APPROVED entry sends it to re_approved (mam's rule).
  const newStatus = cur.status === 'approved' ? 're_approved' : cur.status;
  db.prepare(
    `UPDATE po_foc_entries SET po_item_id=?, po_name=?, po_rate=?, qty=?, labour=?, labour_item_id=?, labour_name=?, labour_margin=?, margin=?,
            focs_json=?, cost=?, tpa=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, newStatus, req.params.id);
  res.json({ message: 'Updated', status: newStatus });
});

router.post('/po-foc/:id/approve', requirePermission('quotations', 'approve'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT id FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE po_foc_entries SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.user.id, req.params.id);
  // 106 of these went through in ~2 minutes on 2026-08-23 — same
  // fastest-finger pattern as the deletes, so it feeds the same breaker.
  require('../lib/destructiveBreaker').addScore(req.user.id, 1, 'po_foc_approve');
  res.json({ message: 'Approved' });
});

router.delete('/po-foc/:id', requirePermission('quotations', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM po_foc_entries WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Labour Rate sheet (mam 2026-06-10) ────────────────────────────
router.get('/labour-rates', (req, res) => {
  const db = getDb();
  const { search, category } = req.query;
  const cond = [], args = [];
  if (category) { cond.push('category = ?'); args.push(category); }
  // Token-wise AND, mirroring the page's own filter (LabourRate.jsx): every
  // whitespace-separated word must appear in the item name or Task ID. One
  // contiguous LIKE made the export drop rows the table was visibly showing.
  if (search) { String(search).toLowerCase().trim().split(/\s+/).filter(Boolean).forEach(t => { cond.push("INSTR(LOWER(COALESCE(item_name, '') || ' LR-' || id), ?) > 0"); args.push(t); }); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  res.json(db.prepare(`SELECT * FROM labour_rates ${where} ORDER BY category, item_name`).all(...args));
});

router.post('/labour-rates', requirePermission('quotations', 'create'), (req, res) => {
  const { item_name, specification, size, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  const r = getDb().prepare('INSERT INTO labour_rates (item_name, specification, size, rate, uom, category, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(String(item_name).trim(), specification || '', size || '', Number(rate) || 0, uom || '', category || '', req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/labour-rates/:id', requirePermission('quotations', 'edit'), (req, res) => {
  const { item_name, specification, size, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  getDb().prepare('UPDATE labour_rates SET item_name=?, specification=?, size=?, rate=?, uom=?, category=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(item_name).trim(), specification || '', size || '', Number(rate) || 0, uom || '', category || '', req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/labour-rates/:id', requirePermission('quotations', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM labour_rates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Labour Rate Excel export / template / bulk import (mam 2026-06-11) ─
const LR_HEADERS = ['Item Name', 'Specification', 'Size', 'Rate', 'UOM', 'Category'];
function sendLabourXlsx(res, rowsAoA, filename) {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([LR_HEADERS, ...rowsAoA]);
  ws['!cols'] = LR_HEADERS.map(h => ({ wch: Math.max(14, h.length + 2) }));
  XLSX.utils.book_append_sheet(wb, ws, 'Labour Rates');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(buf);
}

// Download every labour rate as a real .xlsx (respects ?search / ?category).
router.get('/labour-rates/export', (req, res) => {
  const db = getDb();
  const { search, category } = req.query;
  const cond = [], args = [];
  if (category) { cond.push('category = ?'); args.push(category); }
  // Token-wise AND, mirroring the page's own filter (LabourRate.jsx): every
  // whitespace-separated word must appear in the item name or Task ID. One
  // contiguous LIKE made the export drop rows the table was visibly showing.
  if (search) { String(search).toLowerCase().trim().split(/\s+/).filter(Boolean).forEach(t => { cond.push("INSTR(LOWER(COALESCE(item_name, '') || ' LR-' || id), ?) > 0"); args.push(t); }); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const rows = db.prepare(`SELECT * FROM labour_rates ${where} ORDER BY category, item_name`).all(...args);
  const aoa = rows.map(r => [r.item_name, r.specification || '', r.size || '', r.rate || 0, r.uom || '', r.category || '']);
  sendLabourXlsx(res, aoa, 'labour-rates.xlsx');
});

// Blank template with the header row + one sample line.
router.get('/labour-rates/template', (req, res) => {
  sendLabourXlsx(res, [['SENSOR INSTALLATION', 'MS Type', '25mm', 350, 'PCS', 'ELECTRICAL']], 'labour-rates-template.xlsx');
});

// Find labour items that share the same name (case/space-insensitive) —
// duplicates that splinter one task across two rows (e.g. one MTRS + one Kg),
// which breaks the live link from PO/FOC kits (mam 2026-06-11).
router.get('/labour-rates/duplicates', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM labour_rates ORDER BY item_name, id').all();
  const usage = db.prepare('SELECT labour_item_id AS id, COUNT(*) AS c FROM po_foc_entries WHERE labour_item_id IS NOT NULL GROUP BY labour_item_id').all();
  const useMap = new Map(usage.map(u => [u.id, u.c]));
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.item_name || '').toLowerCase().replace(/\s+/g, ' ').trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push({ ...r, used_in: useMap.get(r.id) || 0 });
  }
  res.json([...groups.values()].filter(g => g.length > 1));
});

// Merge duplicate labour rows: repoint every PO/FOC kit from the removed rows
// onto the kept row, then delete the removed rows (one transaction).
router.post('/labour-rates/merge', requirePermission('quotations', 'edit'), (req, res) => {
  const keepId = Number(req.body.keep_id);
  const removeIds = (Array.isArray(req.body.remove_ids) ? req.body.remove_ids : []).map(Number).filter(id => id && id !== keepId);
  if (!keepId || !removeIds.length) return res.status(400).json({ error: 'keep_id and at least one remove_id required' });
  const db = getDb();
  if (!db.prepare('SELECT id FROM labour_rates WHERE id=?').get(keepId)) return res.status(404).json({ error: 'Kept item not found' });
  const ph = removeIds.map(() => '?').join(',');
  const result = db.transaction(() => {
    const rep = db.prepare(`UPDATE po_foc_entries SET labour_item_id=? WHERE labour_item_id IN (${ph})`).run(keepId, ...removeIds);
    const del = db.prepare(`DELETE FROM labour_rates WHERE id IN (${ph})`).run(...removeIds);
    return { repointed: rep.changes, removed: del.changes };
  })();
  res.json(result);
});

// Bulk import from an uploaded .xlsx / .xls / .csv. First row = headers;
// columns matched case-insensitively. Item Name required; others optional.
router.post('/labour-rates/import', requirePermission('quotations', 'create'), upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const db = getDb();
  let rows;
  try {
    const wb = XLSX.readFile(req.file.path);
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { defval: '' });
  } catch (e) {
    try { fs.unlinkSync(req.file.path); } catch (_) {}
    return res.status(400).json({ error: 'Could not parse the file. Expected .xlsx / .xls / .csv' });
  }
  try { fs.unlinkSync(req.file.path); } catch (_) {}
  if (!rows.length) return res.status(400).json({ error: 'No data rows. Row 1 must be headers; data starts on row 2.' });

  const cleanKey = (k) => String(k || '').toLowerCase().replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  const insert = db.prepare('INSERT INTO labour_rates (item_name, specification, size, rate, uom, category, created_by) VALUES (?,?,?,?,?,?,?)');
  let added = 0; const errors = [];
  for (let i = 0; i < rows.length; i++) {
    const r = {};
    Object.entries(rows[i]).forEach(([k, v]) => { r[cleanKey(k)] = typeof v === 'string' ? v.trim() : v; });
    const item_name = String(r['item name'] || '').trim();
    if (!item_name) { errors.push(`Row ${i + 2}: Item Name required`); continue; }
    try {
      insert.run(item_name, String(r['specification'] || ''), String(r['size'] || ''),
        Number(r['rate']) || 0, String(r['uom'] || ''), String(r['category'] || ''), req.user.id);
      added++;
    } catch (err) { errors.push(`Row ${i + 2}: ${err.message}`); }
  }
  res.json({ added, total: rows.length, errors });
});

// ── Saved AI Auto-Quotation estimates (mam 2026-06-10) ────────────
router.get('/estimates', (req, res) => {
  const rows = getDb().prepare(`SELECT id, title, client_name, sp, cost, updated_at, created_at
    FROM estimate_quotations ORDER BY client_name COLLATE NOCASE, updated_at DESC`).all();
  res.json(rows);
});
router.get('/estimates/:id', (req, res) => {
  const r = getDb().prepare('SELECT * FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, margins: JSON.parse(r.margins_json || '{}'), rows: JSON.parse(r.rows_json || '[]'), manpower: JSON.parse(r.manpower_json || '[]'), payment_terms: JSON.parse(r.payment_terms_json || '{}') });
});
router.post('/estimates', requirePermission('quotations', 'create'), (req, res) => {
  const b = req.body || {};
  const r = getDb().prepare(`INSERT INTO estimate_quotations (title, lead_id, client_name, acc_pct, margins_json, rows_json, manpower_json, payment_terms_json, cost, sp, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
    JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []), JSON.stringify(b.payment_terms || {}),
    Number(b.cost) || 0, Number(b.sp) || 0, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});
router.put('/estimates/:id', requirePermission('quotations', 'edit'), (req, res) => {
  const b = req.body || {};
  const ex = getDb().prepare('SELECT id FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  getDb().prepare(`UPDATE estimate_quotations SET title=?, lead_id=?, client_name=?, acc_pct=?, margins_json=?, rows_json=?, manpower_json=?, payment_terms_json=?, cost=?, sp=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
      JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []), JSON.stringify(b.payment_terms || {}),
      Number(b.cost) || 0, Number(b.sp) || 0, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/estimates/:id', requirePermission('quotations', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM estimate_quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Build the multi-sheet quotation Excel (mam's saizar format): one sheet per
// category + a SUMMARY with letterhead, category totals and a manpower block.
// ── Styled quotation workbook (ExcelJS) — logo, navy headers, borders,
// wrapped descriptions, currency number formats. Falls back to the plain
// SheetJS export below if exceljs isn't installed on the server.
async function buildStyledQuotation(ExcelJS, d) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Secured Engineers Pvt Ltd';
  const NAVY = 'FF1E3A8A', LIGHT = 'FFE8EEF7', GREY = 'FFF4F6FA', MONEY = '#,##0.00';
  const thin = { style: 'thin', color: { argb: 'FFD0D7E2' } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const QH = ['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP'];
  const styleHeader = (ws, rowIdx, n) => {
    const r = ws.getRow(rowIdx); r.height = 26;
    for (let c = 1; c <= n; c++) { const cell = r.getCell(c); cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 }; cell.alignment = { wrapText: true, vertical: 'middle', horizontal: 'center' }; cell.border = border; }
  };

  // ── SUMMARY ──
  const sum = wb.addWorksheet('SUMMARY');
  sum.columns = [{ width: 34 }, { width: 18 }, { width: 16 }, { width: 16 }, { width: 18 }];
  const logoPath = path.join(__dirname, '..', '..', 'client', 'public', 'sepl-logo.png');
  if (fs.existsSync(logoPath)) {
    const imgId = wb.addImage({ filename: logoPath, extension: 'png' });
    sum.addImage(imgId, { tl: { col: 0, row: 0 }, ext: { width: 175, height: 56 } });
    sum.getRow(1).height = 46;
  }
  const co = [['B1', 'SECURED ENGINEERS PVT. LTD', { bold: true, size: 14, color: { argb: NAVY } }],
    ['B2', 'H.O: 2480/1, B.K. Towers, Janta Nagar, Gill Road, Ludhiana', { size: 9, color: { argb: 'FF555555' } }],
    ['B3', 'C.O: 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016', { size: 9, color: { argb: 'FF555555' } }],
    ['B4', 'Website: www.securedengineers.com', { size: 9, color: { argb: 'FF555555' } }]];
  co.forEach(([a, v, f], i) => { sum.mergeCells(`${a}:E${i + 1}`); sum.getCell(a).value = v; sum.getCell(a).font = f; });
  sum.mergeCells('A6:E6'); const tb = sum.getCell('A6'); tb.value = `QUOTATION FOR ${d.title || 'WORK'}`; tb.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: NAVY } }; tb.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } }; tb.alignment = { horizontal: 'center', vertical: 'middle' }; sum.getRow(6).height = 24;
  const info = [['NAME', d.client_name, 'Date', istToday()], ['ADDRESS', d.client_address, 'Quotation No', d.quotation_no], ['PREP BY', d.prep_by, 'Revision No', 'R0']];
  let rr = 8;
  info.forEach(([k, v, k2, v2]) => { sum.getCell(`A${rr}`).value = k; sum.getCell(`A${rr}`).font = { bold: true }; sum.getCell(`B${rr}`).value = v; sum.getCell(`B${rr}`).alignment = { wrapText: true }; sum.getCell(`D${rr}`).value = k2; sum.getCell(`D${rr}`).font = { bold: true }; sum.getCell(`E${rr}`).value = v2; rr++; });
  rr++;
  sum.getCell(`A${rr}`).value = 'S.No.'; sum.getCell(`B${rr}`).value = 'Description'; sum.getCell(`C${rr}`).value = 'SP Amount (Rs)'; styleHeader(sum, rr, 3); rr++;
  let grand = 0, ci = 1;
  for (const [cat, items] of Object.entries(d.byCat)) { const sp = items.reduce((t, it) => t + (Number(it.sp) || 0), 0); grand += sp; sum.getCell(`A${rr}`).value = ci++; sum.getCell(`B${rr}`).value = cat; const cc = sum.getCell(`C${rr}`); cc.value = Math.round(sp * 100) / 100; cc.numFmt = MONEY; [`A${rr}`, `B${rr}`, `C${rr}`].forEach(a => sum.getCell(a).border = border); rr++; }
  sum.getCell(`B${rr}`).value = 'SUB TOTAL'; sum.getCell(`B${rr}`).font = { bold: true }; const stc = sum.getCell(`C${rr}`); stc.value = Math.round(grand * 100) / 100; stc.numFmt = MONEY; stc.font = { bold: true }; rr += 2;
  ['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount'].forEach((h, k) => sum.getCell(rr, k + 1).value = h); styleHeader(sum, rr, 5); rr++;
  let mTotal = 0;
  d.manpower.filter(m => m && m.name).forEach(m => { const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0); mTotal += amt; sum.getCell(rr, 1).value = m.name; sum.getCell(rr, 2).value = Number(m.qty) || 0; const mc = sum.getCell(rr, 3); mc.value = Number(m.monthly_cost) || 0; mc.numFmt = MONEY; sum.getCell(rr, 4).value = Number(m.months) || 0; const ac = sum.getCell(rr, 5); ac.value = Math.round(amt * 100) / 100; ac.numFmt = MONEY; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).border = border; rr++; });
  sum.getCell(rr, 4).value = 'Manpower Total'; sum.getCell(rr, 4).font = { bold: true }; const mtc = sum.getCell(rr, 5); mtc.value = Math.round(mTotal * 100) / 100; mtc.numFmt = MONEY; mtc.font = { bold: true }; rr++;
  sum.getCell(rr, 4).value = 'GRAND TOTAL'; sum.getCell(rr, 4).font = { bold: true, size: 12 }; const gtc = sum.getCell(rr, 5); gtc.value = Math.round((grand + mTotal) * 100) / 100; gtc.numFmt = MONEY; gtc.font = { bold: true, size: 12, color: { argb: NAVY } }; for (let c = 1; c <= 5; c++) sum.getCell(rr, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } };

  // ── per-category sheets ──
  const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
  for (const [cat, items] of Object.entries(d.byCat)) {
    const ws = wb.addWorksheet(safeSheet(cat));
    ws.columns = [{ width: 6 }, { width: 52 }, { width: 12 }, { width: 7 }, { width: 7 }, { width: 12 }, { width: 14 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 11 }, { width: 13 }, { width: 9 }, { width: 13 }];
    QH.forEach((h, k) => ws.getCell(1, k + 1).value = h); styleHeader(ws, 1, QH.length);
    let sp = 0, ri = 2;
    items.forEach((it, idx) => {
      const vals = [idx + 1, it.description || '', it.make || '', it.unit || '', Number(it.qty) || 0, Number(it.rate) || 0, Number(it.sp) || 0, Number(it.pp) || 0, Number(it.acc) || 0, Number(it.lab) || 0, Number(it.tp) || 0, Number(it.tpa) || 0, (Number(it.margin) || 0) + '%', Number(it.sp) || 0];
      vals.forEach((v, k) => {
        const cell = ws.getCell(ri, k + 1); cell.value = v; cell.border = border;
        cell.alignment = { vertical: 'top', wrapText: k === 1, horizontal: k === 0 ? 'center' : (k >= 4 ? 'right' : 'left') };
        if (k === 4) cell.numFmt = '0';
        else if ([5, 6, 7, 8, 9, 10, 11, 13].includes(k)) cell.numFmt = MONEY;
        if (idx % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: GREY } };
      });
      sp += Number(it.sp) || 0; ri++;
    });
    ws.getCell(ri, 1).value = 'TOTAL'; ws.getCell(ri, 1).font = { bold: true };
    const t7 = ws.getCell(ri, 7); t7.value = Math.round(sp * 100) / 100; t7.numFmt = MONEY; t7.font = { bold: true };
    const t14 = ws.getCell(ri, 14); t14.value = Math.round(sp * 100) / 100; t14.numFmt = MONEY; t14.font = { bold: true };
    for (let c = 1; c <= QH.length; c++) { ws.getCell(ri, c).border = border; ws.getCell(ri, c).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LIGHT } }; }
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

router.post('/estimate-export', requirePermission('quotations', 'view'), async (req, res) => {
  const { title = '', client_name = '', client_address = '', quotation_no = '', prep_by = '',
    rows = [], manpower = [] } = req.body || {};
  const sendBuf = (buf) => {
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${String(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  };
  // Group by category once (shared by both export paths).
  const byCatShared = {};
  for (const r of rows) { const c = r.category || 'General'; (byCatShared[c] = byCatShared[c] || []).push(r); }

  // Preferred: styled ExcelJS workbook. If exceljs isn't installed (or styling
  // throws), fall through to the plain SheetJS export — never 500 on this.
  let ExcelJS = null; try { ExcelJS = require('exceljs'); } catch { ExcelJS = null; }
  if (ExcelJS) {
    try {
      const buf = await buildStyledQuotation(ExcelJS, { title, client_name, client_address, quotation_no, prep_by, byCat: byCatShared, manpower });
      return sendBuf(buf);
    } catch (e) { /* fall through to plain */ }
  }

  try {
    const wb = XLSX.utils.book_new();
    const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
    const byCat = {};
    for (const r of rows) { const c = r.category || 'General'; (byCat[c] = byCat[c] || []).push(r); }

    const catTotals = [];
    for (const [cat, items] of Object.entries(byCat)) {
      const aoa = [['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', '', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP']];
      let sp = 0;
      items.forEach((it, i) => {
        aoa.push([i + 1, it.description || '', it.make || '', it.unit || '', it.qty || 0, it.rate || 0, it.sp || 0,
          '', it.pp || 0, it.acc || 0, it.lab || 0, it.tp || 0, it.tpa || 0, (it.margin || 0) + '%', it.sp || 0]);
        sp += Number(it.sp) || 0;
      });
      aoa.push(['TOTAL', '', '', '', '', '', Math.round(sp * 100) / 100, '', '', '', '', '', Math.round(sp * 100) / 100]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), safeSheet(cat));
      catTotals.push({ cat, sp });
    }

    const sum = [];
    sum.push(['SECURED ENGINEERS PVT. LTD']);
    sum.push(['H.O: 2480/1 , B.K. Towers, Janta Nagar, Gill Road, Ludhiana']);
    sum.push(['C.O : 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016']);
    sum.push(['Website : www.securedengineers.com']);
    sum.push([`QUOTATION FOR ${title || 'WORK'}`]);
    sum.push(['NAME', client_name, '', 'Date-:', istToday()]);
    sum.push(['ADDRESS', client_address, '', 'Quotation No', quotation_no]);
    sum.push(['PREP BY', prep_by, '', 'Revision No', 'R0']);
    sum.push([]);
    sum.push(['S.No.', 'Description', 'SP Amount (Rs)']);
    let grand = 0;
    catTotals.forEach((c, i) => { sum.push([i + 1, c.cat, Math.round(c.sp * 100) / 100]); grand += c.sp; });
    sum.push(['', 'SUB TOTAL', Math.round(grand * 100) / 100]);
    sum.push([]);
    sum.push(['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount']);
    let mTotal = 0;
    manpower.filter(m => m && m.name).forEach(m => {
      const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);
      sum.push([m.name, m.qty || 0, m.monthly_cost || 0, m.months || 0, Math.round(amt * 100) / 100]);
      mTotal += amt;
    });
    sum.push(['', '', '', 'Manpower Total', Math.round(mTotal * 100) / 100]);
    sum.push(['', '', '', 'GRAND TOTAL', Math.round((grand + mTotal) * 100) / 100]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'SUMMARY');
    wb.SheetNames.unshift(wb.SheetNames.pop()); // SUMMARY first

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${String(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

module.exports = router;
