// AI Agent — three features behind /api/ai-agent:
//   (1) Rate intelligence  — /rate-suggestion + /item-history (Feature 1+2)
//   (2) Settings           — /settings (admin-only: paste Anthropic API key
//                            inside the ERP, no .env edit needed — mam's
//                            requirement: 'in erp')
//   (3) Ask ERP chatbot    — /ask (Claude + read-only SQL tool)

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Read/write helpers for the key-value app_settings table. Keys we own:
//   ai_provider  — 'anthropic' (only one for now)
//   ai_api_key   — the secret (server-side only; masked in GET)
//   ai_model     — model id (default claude-opus-4-7)
function getSetting(key) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}
function setSetting(key, value) {
  getDb().prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
                   ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`).run(key, value);
}
function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/ai-agent/rate-suggestion?item_id=&lead_id=
// Returns last-quoted-to-this-client + 6-month stats across all clients.
// Both null when no history exists for that item (UI hides the panel).
// Gated by 'quotations' perms — the popup only renders inside the BOQ form.
router.get('/rate-suggestion', requirePermission('quotations', 'view'), (req, res) => {
  const itemId = +req.query.item_id;
  const leadId = req.query.lead_id ? +req.query.lead_id : null;
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  const db = getDb();

  // Pull this client's company_name so we can match historical rows
  // even if a different lead from the same client quoted before.
  let companyName = null;
  if (leadId) {
    const lead = db.prepare('SELECT company_name FROM leads WHERE id=?').get(leadId);
    companyName = lead?.company_name || null;
  }

  const lastForClient = companyName
    ? db.prepare(`SELECT rate, created_at, created_by_name, quantity
                  FROM item_price_history
                  WHERE item_id=? AND company_name=?
                  ORDER BY created_at DESC LIMIT 1`).get(itemId, companyName)
    : null;

  // 6-month window across all clients
  const stats = db.prepare(`SELECT
      COUNT(*) AS n,
      AVG(rate) AS avg_rate,
      MIN(rate) AS min_rate,
      MAX(rate) AS max_rate
    FROM item_price_history
    WHERE item_id=? AND created_at >= datetime('now', '-6 months')`).get(itemId);

  const lastOverall = db.prepare(`SELECT rate, created_at, created_by_name, company_name
                                  FROM item_price_history
                                  WHERE item_id=?
                                  ORDER BY created_at DESC LIMIT 1`).get(itemId);

  const item = db.prepare('SELECT id, item_name, current_price FROM item_master WHERE id=?').get(itemId);

  res.json({
    item,
    last_for_client: lastForClient,         // null if no prior quote to this client
    last_overall: lastOverall,              // null if no history at all
    six_month_stats: stats?.n > 0 ? {
      count: stats.n,
      avg: Math.round(stats.avg_rate),
      min: stats.min_rate,
      max: stats.max_rate,
    } : null,
    company_name: companyName,
  });
});

// GET /api/ai-agent/item-history?item_id=&limit=20
// Full historical log for an item — used by the AI Agent page (later)
// and useful for "show me the rate trend" view.
router.get('/item-history', requirePermission('quotations', 'view'), (req, res) => {
  const itemId = +req.query.item_id;
  const limit = Math.min(+req.query.limit || 20, 100);
  if (!itemId) return res.status(400).json({ error: 'item_id required' });
  const rows = getDb().prepare(`SELECT h.*, l.company_name AS lead_company
                                FROM item_price_history h
                                LEFT JOIN leads l ON h.lead_id=l.id
                                WHERE h.item_id=?
                                ORDER BY h.created_at DESC
                                LIMIT ?`).all(itemId, limit);
  res.json(rows);
});

// ─── AI Settings (admin) ─────────────────────────────────────────────
// Mam pastes her Anthropic API key here, no SSH/.env editing needed.
// GET returns a masked key so the UI can show "configured / not configured"
// without ever sending the secret back to the browser.

router.get('/settings', adminOnly, (req, res) => {
  const key = getSetting('ai_api_key');
  res.json({
    provider: getSetting('ai_provider') || 'anthropic',
    model: getSetting('ai_model') || 'claude-opus-4-7',
    api_key_set: !!key,
    api_key_masked: key ? `${key.slice(0, 7)}…${key.slice(-4)}` : null,
  });
});

router.put('/settings', adminOnly, (req, res) => {
  const { provider, model, api_key } = req.body || {};
  if (provider) setSetting('ai_provider', String(provider).trim() || 'anthropic');
  if (model) setSetting('ai_model', String(model).trim() || 'claude-opus-4-7');
  if (typeof api_key === 'string' && api_key.trim()) {
    // Accept both bare keys and "sk-ant-..."; just trim and store.
    setSetting('ai_api_key', api_key.trim());
  }
  res.json({ message: 'AI settings saved' });
});

// Lets users with ai_agent.view check if the chatbot is configured so
// the floating bubble can render only for permitted users.
router.get('/status', requirePermission('ai_agent', 'view'), (req, res) => {
  res.json({ configured: !!getSetting('ai_api_key') });
});

// ─── Ask ERP (chatbot) ───────────────────────────────────────────────
// POST { question, history?: [{role,content}] } → { answer, sql_runs: [{query,row_count}] }
// Claude is given a SELECT-only "query_database" tool and a digest of the
// schema; it can make up to MAX_TOOL_ITER queries before returning a final
// natural-language answer.

const MAX_TOOL_ITER = 8;
const ROW_LIMIT = 500;

// Tables Claude is allowed to read. Skipping sensitive auth tables.
const READABLE_TABLES = new Set([
  'sites', 'leads', 'customers', 'item_master', 'item_price_history',
  'boq', 'boq_items', 'quotations', 'business_book', 'purchase_orders',
  'po_items', 'order_planning', 'indents', 'indent_items', 'vendor_pos',
  'vendor_po_items', 'purchase_bills', 'sales_bills', 'delivery_notes',
  'payments', 'cash_flow_entries', 'receivables', 'expenses', 'employees',
  'attendance', 'payment_requests', 'rent_requests', 'dpr', 'dpr_work_items',
  'dpr_material', 'dpr_machinery', 'dpr_manpower', 'dpr_contractors',
  'installations', 'complaints', 'snags', 'sales_funnel', 'company_assets',
]);

function buildSchemaDigest(db) {
  // Compact "table(col TYPE, col TYPE)" lines for every readable table.
  // Cached per process via getSchemaDigest below.
  const lines = [];
  for (const t of READABLE_TABLES) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${t})`).all();
      if (!cols.length) continue;
      const colList = cols.map(c => `${c.name} ${c.type || ''}`.trim()).join(', ');
      lines.push(`${t}(${colList})`);
    } catch (_) {}
  }
  return lines.join('\n');
}
let _cachedDigest = null;
function getSchemaDigest(db) {
  if (!_cachedDigest) _cachedDigest = buildSchemaDigest(db);
  return _cachedDigest;
}

// SQL safety filter. Reject anything that isn't a single SELECT.
function validateSelect(sql) {
  if (typeof sql !== 'string') return 'Query must be a string';
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) return 'Empty query';
  if (/;/.test(trimmed)) return 'Multiple statements not allowed';
  if (!/^\s*(SELECT|WITH)\s/i.test(trimmed)) return 'Only SELECT/WITH queries are allowed';
  // Quick deny-list — even inside a CTE/subquery, these tokens should never appear
  const banned = /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|ATTACH|DETACH|REPLACE|PRAGMA|VACUUM)\b/i;
  if (banned.test(trimmed)) return 'Mutating keywords are not allowed';
  return null;
}

function safeRunQuery(db, sql) {
  const err = validateSelect(sql);
  if (err) return { error: err };
  try {
    const stmt = db.prepare(sql);
    const rows = stmt.all();
    const truncated = rows.length > ROW_LIMIT;
    return {
      row_count: rows.length,
      truncated,
      rows: truncated ? rows.slice(0, ROW_LIMIT) : rows,
    };
  } catch (e) {
    return { error: e.message };
  }
}

router.post('/ask', requirePermission('ai_agent', 'view'), async (req, res) => {
  const apiKey = getSetting('ai_api_key');
  if (!apiKey) {
    return res.status(400).json({
      error: 'AI Agent not configured. Ask an admin to paste an Anthropic API key in Admin → AI Settings.',
    });
  }
  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'question required' });
  const priorHistory = Array.isArray(req.body?.history) ? req.body.history.slice(-10) : [];

  let Anthropic;
  try {
    Anthropic = require('@anthropic-ai/sdk');
  } catch (e) {
    return res.status(500).json({ error: '@anthropic-ai/sdk not installed on the server. Run `npm install` on the VPS.' });
  }

  const db = getDb();
  const client = new Anthropic.default({ apiKey });
  const model = getSetting('ai_model') || 'claude-opus-4-7';

  const systemPrompt = `You are the AI assistant inside SEPL Engineers' internal ERP (an MEPF subcontracting business in India). The user asking is staff or admin. You have TWO tools:

1. query_database — read the local ERP database (leads, customers, items, quotations, POs, payments, DPR, attendance, etc.). Use this for ANY question about SEPL's own data.

2. web_search — search the live internet. Use this when the user asks about market/online/current rates that aren't in our ERP yet, vendor news, commodity prices, GST rate lookups, supplier company details, or any fact that lives outside our database.

Combine the tools when useful. Example: "is our cement rate competitive?" → first query_database for SEPL's current_price, then web_search for today's market rate on IndiaMART / Justdial / cement industry sites, then compare and answer.

Answer concisely in plain English. Money is in Indian Rupees (Rs) — Indian-style formatting (e.g. "Rs 12,50,000"). Be specific: include names, numbers, dates. If a question is ambiguous, make one reasonable assumption and state it. Never invent data — only report what the tools return. When you cite a web-search number, mention the source briefly ("per IndiaMART today").

Database schema (SQLite). Only SELECT/WITH queries are allowed; the tool will reject anything else.

${getSchemaDigest(db)}

Guidance:
- Prefer JOINs over multiple round-trip queries when sensible.
- Use date('now') / datetime('now', '-N days') for recency filters.
- LIMIT large result sets (≤ 100 rows for display).
- If the user asks about "rates", look at item_master.current_price and item_price_history first; only fall back to web_search if they explicitly want "market rate" / "online price" / "current price online".
- If they ask about overdue payments, sales_bills with payment_status='pending' or 'partial' is the first place to check; receivables also tracks this.
- If they ask "who", join with employees on the relevant *_by columns.`;

  // Two tools: read-only SQL on the local ERP, and Claude's hosted web
  // search (so the bot can answer "what's the current market rate of MS
  // pipe online" — mam's "show rate live from net" requirement). Web
  // search adds ~$0.01 per call but lets Claude decide when it's needed.
  const tools = [
    {
      name: 'query_database',
      description: 'Run a single read-only SQL query (SELECT or WITH only) against the ERP SQLite database. Returns rows as JSON. Limited to 500 rows per query; the response indicates if truncated.',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'A single SELECT/WITH query. No semicolons, no DDL/DML.' },
        },
        required: ['query'],
      },
    },
    // allowed_callers: ['direct'] = use plain tool use, not programmatic
    // tool calling (PTC). Haiku 4.5 doesn't support PTC, and PTC is the
    // default for web_search_20260209 — without this Haiku 400s with
    // "claude-haiku-4-5 does not support programmatic tool calling".
    { type: 'web_search_20260209', name: 'web_search', allowed_callers: ['direct'] },
  ];

  // Build conversation history
  const messages = [];
  for (const m of priorHistory) {
    if (!m || !m.role || !m.content) continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    messages.push({ role: m.role, content: String(m.content).slice(0, 4000) });
  }
  messages.push({ role: 'user', content: question });

  // Adaptive thinking + the `effort` parameter are only supported on the
  // Opus/Sonnet 4.6+ family. Haiku 4.5 (and older Sonnet 4.5) 400 with
  // "adaptive thinking is not supported on this model". Detect by ID
  // prefix so the same call works on every model the UI offers.
  const supportsAdaptive = /^claude-(opus-4-[67]|sonnet-4-6)/.test(model);
  const baseParams = {
    model,
    max_tokens: 16000,
    system: systemPrompt,
    tools,
  };
  if (supportsAdaptive) {
    baseParams.thinking = { type: 'adaptive' };
    baseParams.output_config = { effort: 'high' };
  }

  const sqlRuns = [];
  let response;
  try {
    for (let iter = 0; iter < MAX_TOOL_ITER; iter++) {
      response = await client.messages.create({ ...baseParams, messages });

      if (response.stop_reason === 'end_turn' || response.stop_reason === 'refusal') break;

      // pause_turn: Anthropic-side tool (web_search) hit its server-side
      // iteration limit. Re-send the same conversation with the assistant
      // turn appended; the server resumes web_search from where it left off.
      // No client-side action needed.
      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      if (response.stop_reason !== 'tool_use') break;

      // Append assistant turn verbatim (preserves thinking/tool_use blocks)
      messages.push({ role: 'assistant', content: response.content });

      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use' || block.name !== 'query_database') continue;
        const sql = block.input?.query || '';
        const result = safeRunQuery(db, sql);
        sqlRuns.push({ query: sql, row_count: result.row_count ?? 0, error: result.error || null });
        toolResults.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 50000),
          is_error: !!result.error,
        });
      }
      if (!toolResults.length) break;
      messages.push({ role: 'user', content: toolResults });
    }
  } catch (e) {
    console.error('[AI Agent /ask] Anthropic call failed:', e.message);
    const status = e?.status || 500;
    let hint = '';
    if (status === 401) hint = ' Your API key is invalid — update it in Admin → AI Settings.';
    else if (status === 429) hint = ' Rate limited by Anthropic — wait a few seconds and try again.';
    return res.status(502).json({ error: `AI request failed: ${e.message}${hint}` });
  }

  const answer = (response?.content || [])
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('\n')
    .trim();

  res.json({
    answer: answer || '(no answer)',
    sql_runs: sqlRuns,
    stop_reason: response?.stop_reason,
  });
});

module.exports = router;
