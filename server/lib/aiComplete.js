// Shared ONE-SHOT AI completion — provider-aware (Anthropic OR Google Gemini).
//
// WHY THIS EXISTS — mam 2026-08-21, pointing at Procurement › Vendor Rates:
// "ai kpi i want from gemini so that marketing rate minimum according to item
// show here". Admin → AI Settings already lets her pick Gemini, and the chat
// (routes/aiAgent.js) honours it — but SIX other call sites hardcoded
// require('@anthropic-ai/sdk') and posted her "AIza..." key to Anthropic, which
// 401s → the red "AI key invalid" toast. Fix the CLASS, not the instance: every
// simple prompt-in / text-out caller now goes through here.
//
// NOT for routes/aiAgent.js — its agentic loop (function tools, Google Search
// grounding, multi-turn, adaptive thinking) keeps its own implementation.
const { getDb } = require('../db/schema');

// Model defaults. mam 2026-08-21: her brand-new Gemini key 404'd on BOTH
// gemini-2.0-flash ("no longer available") and gemini-2.5-flash ("no longer
// available to new users") — Google's own error told us to move to 3.6. Any
// hardcoded id dies the same way eventually, so the 404 self-heal below ASKS
// Google what this key can actually use instead of guessing a second time.
const AI_DEFAULTS = { anthropic: 'claude-opus-4-7', gemini: 'gemini-3.6-flash' };
const ANTHROPIC_FALLBACK_MODEL = 'claude-opus-5';   // stale-model self-heal (audit 2026-08-18)
const GEMINI_FALLBACK_MODEL = 'gemini-3.6-flash';
// Preference order when auto-picking a live Gemini model: cheap+fast first,
// since every caller here wants a short answer, not deep reasoning.
const GEMINI_PREFERRED = [
  'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite', 'gemini-3.5-flash',
];

function setting(db, key) {
  try { return (db || getDb()).prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value ?? null; }
  catch (_) { return null; }
}

// Resolve provider + key + model. Mirrors aiAgent.js:751-755 — 'google' is
// accepted as an alias, and a model id that doesn't belong to the chosen
// provider is coerced (a Claude id would 404 on generateContent, and vice
// versa). Callers use .configured to keep their OWN not-configured status code.
function aiConfig(db, override) {
  const o = override || {};
  const rawProv = String(o.provider || setting(db, 'ai_provider') || 'anthropic').toLowerCase();
  const provider = (rawProv === 'gemini' || rawProv === 'google') ? 'gemini' : 'anthropic';
  const apiKey = (o.apiKey || setting(db, 'ai_api_key') || '').trim();
  let model = (o.model || setting(db, 'ai_model') || '').trim();
  if (provider === 'gemini') { if (!model || !/gemini/i.test(model)) model = AI_DEFAULTS.gemini; }
  else { if (!model || /gemini/i.test(model)) model = AI_DEFAULTS.anthropic; }
  return { provider, apiKey, model, configured: !!apiKey };
}

function aiNotConfiguredMessage(provider) {
  return provider === 'gemini'
    ? 'AI not configured — paste a Google Gemini API key in Admin → AI Settings'
    : 'AI not configured — paste an API key in Admin → AI Settings';
}

// Provider-aware user-facing message. err.status is the normalised HTTP status
// (Gemini's REST body is mapped onto it below) so ONE mapper serves both.
function aiErrorMessage(err, provider) {
  const s = err?.status;
  const g = provider === 'gemini';
  // Errors WE constructed locally (missing SDK, Node too old) carry an
  // operator-actionable sentence — return it verbatim instead of letting the
  // 5xx branch below flatten it to "AI service is busy" (audit 2026-08-21:
  // a stale node_modules after a branch jump used to say "run npm install",
  // the refactor silently swallowed that hint).
  if (err?.aiLocal) return err.message;
  if (s === 401) return 'AI key invalid — check the API key in Admin → AI Settings';
  if (s === 403) return g
    ? 'AI key has no access — enable the Generative Language API for this key at aistudio.google.com, or paste a new key in Admin → AI Settings'
    : 'AI key has no access/credits — check billing on the Anthropic console';
  if (s === 404) return g
    ? `AI model not available — pick a Gemini model (e.g. ${GEMINI_FALLBACK_MODEL}) in Admin → AI Settings`
    : `AI model not available — set a current model (e.g. ${ANTHROPIC_FALLBACK_MODEL}) in Admin → AI Settings`;
  if (s === 429) return g
    ? 'Gemini free-tier quota hit (even after auto-retry) — wait a few minutes, or switch to Anthropic in Admin → AI Settings'
    : 'AI is rate-limited right now — wait a minute and try again';
  if (s === 408) return 'AI took too long to answer — try again';
  if (s === 500 || s === 502 || s === 503 || s === 529) return 'AI service is busy — try again shortly';
  return 'AI request failed: ' + (err?.message || 'error');
}

// Pull a JSON array out of a model reply. Gemini often wraps JSON in ```json
// fences, and both providers sometimes prefix a sentence containing a '['.
// The old /\[[\s\S]*\]/ greedy regex broke on that second case (it captured
// the prose bracket too, JSON.parse threw, and the batch was silently dropped).
// Verified 2026-08-21 against fenced, prefixed, bare and padded replies.
function extractJsonArray(text) {
  if (!text) return null;
  const t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try { const v = JSON.parse(t); if (Array.isArray(v)) return v; } catch (_) {}
  const end = t.lastIndexOf(']');
  if (end === -1) return null;
  for (let i = t.indexOf('['); i !== -1 && i < end; i = t.indexOf('[', i + 1)) {
    try { const v = JSON.parse(t.slice(i, end + 1)); if (Array.isArray(v)) return v; } catch (_) {}
  }
  return null;
}

function httpErr(message, status) { const e = new Error(message); e.status = status; return e; }
// Locally-constructed, operator-actionable error — aiErrorMessage() passes its
// message straight through instead of using the generic per-status wording.
function localErr(message, status) { const e = httpErr(message, status); e.aiLocal = true; return e; }

// ── Anthropic ──────────────────────────────────────────────────────────────
async function runAnthropic(cfg, opts) {
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); }
  catch (_) { throw localErr('AI SDK not installed on the server (run npm install on the VPS)', 500); }
  const client = new Anthropic.default({ apiKey: cfg.apiKey, timeout: opts.timeout });
  const blocks = (opts.attachments || []).map(a => (a.mime === 'application/pdf'
    ? { type: 'document', source: { type: 'base64', media_type: a.mime, data: a.data }, title: a.name || undefined, citations: { enabled: false } }
    : { type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } }));
  const content = blocks.length ? [...blocks, { type: 'text', text: opts.prompt }] : opts.prompt;
  const params = { max_tokens: opts.maxTokens, messages: [{ role: 'user', content }] };
  if (opts.system) params.system = opts.system;
  let model = cfg.model, resp;
  try {
    resp = await client.messages.create({ model, ...params });
  } catch (err) {
    // Stale/typo'd ai_model that 404s → retry once on the current default
    // (self-healing, audit 2026-08-18). Unchanged behaviour.
    if (err && err.status === 404 && model !== ANTHROPIC_FALLBACK_MODEL) {
      console.warn(`[ai] anthropic model '${model}' not found — retrying with ${ANTHROPIC_FALLBACK_MODEL}`);
      model = ANTHROPIC_FALLBACK_MODEL;
      resp = await client.messages.create({ model, ...params });
    } else throw err;
  }
  const text = (resp?.content || []).map(c => c.text || '').join(opts.attachments?.length ? '' : ' ').trim();
  return { text, model, provider: 'anthropic',
    usage: { input_tokens: resp?.usage?.input_tokens, output_tokens: resp?.usage?.output_tokens } };
}

// Ask Google which models THIS key may call (ListModels). mam 2026-08-21: a
// hardcoded id is a time bomb — 2.0-flash was shut down and 2.5-flash was
// closed to new keys, so both entries in the old Admin dropdown 404'd and every
// AI feature died at once. Querying is the only answer that survives the next
// retirement. Returns [] on any failure so callers can fall back quietly.
async function listGeminiModels(apiKey, timeout = 15000) {
  if (typeof fetch !== 'function') return [];
  try {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000', {
      headers: { 'x-goog-api-key': apiKey }, signal: AbortSignal.timeout(timeout),
    });
    if (!r.ok) return [];
    const j = await r.json();
    return (j.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => ({
        id: String(m.name || '').replace(/^models\//, ''),
        label: m.displayName || String(m.name || '').replace(/^models\//, ''),
      }))
      .filter(m => m.id && !/embedding|aqa|imagen|veo|tts/i.test(m.id));
  } catch (_) { return []; }
}

// Best live model for short answers: first hit in GEMINI_PREFERRED, else any
// non-preview flash, else the first usable model the key reports.
function pickGeminiModel(available, exclude) {
  const ids = new Set(available.map(m => m.id));
  const skip = new Set(exclude || []);
  for (const p of GEMINI_PREFERRED) if (ids.has(p) && !skip.has(p)) return p;
  const flash = available.find(m => /flash/i.test(m.id) && !/preview|exp/i.test(m.id) && !skip.has(m.id));
  if (flash) return flash.id;
  const any = available.find(m => !skip.has(m.id));
  return any ? any.id : null;
}

// Persist a healed model so the NEXT request doesn't repeat the discovery round
// trip (and so Admin → AI Settings shows what is actually in use).
function rememberModel(db, model) {
  try {
    const h = db || getDb();
    const ex = h.prepare("SELECT 1 FROM app_settings WHERE key='ai_model'").get();
    if (ex) h.prepare("UPDATE app_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key='ai_model'").run(model);
    else h.prepare("INSERT INTO app_settings (key, value) VALUES ('ai_model', ?)").run(model);
  } catch (_) { /* best-effort — never fail a completion over bookkeeping */ }
}

// ── Google Gemini (native REST, global fetch — no new dependency) ──────────
async function runGemini(cfg, opts) {
  if (typeof fetch !== 'function') throw localErr("This server's Node is too old for Gemini (needs Node 18+).", 500);
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const parts = (opts.attachments || []).map(a => ({ inlineData: { mimeType: a.mime, data: a.data } }));
  parts.push({ text: opts.prompt });
  // Thinking models burn maxOutputTokens BEFORE writing anything — a 40-token
  // cap then returns finishReason MAX_TOKENS with no parts. 2.5 can switch
  // thinking off (thinkingBudget, set per-model below); 3.x cannot (it uses
  // thinking_level, and an unknown field 400s on older models), so give every
  // thinking-capable model real headroom instead. Unused tokens are not spent.
  const genCfg = { temperature: 0.2 };   // maxOutputTokens set PER MODEL in payloadFor()
  if (opts.json) genCfg.responseMimeType = 'application/json';
  if (opts.json && opts.jsonSchema) genCfg.responseSchema = opts.jsonSchema;
  const body = { contents: [{ role: 'user', parts }], generationConfig: genCfg };
  if (opts.system) body.systemInstruction = { parts: [{ text: opts.system }] };

  // Serialise ONCE PER MODEL — never inside the retry loop. The model id lives
  // in the URL, not the body, so every 429 attempt reuses the same string;
  // procurementSchedule.js can ship ~33MB of base64 drawings here and
  // re-stringifying that per attempt churned hundreds of MB on the VPS for
  // nothing (audit 2026-08-21). Only the 404 self-heal rebuilds it, because
  // thinkingConfig is 2.5-only and 1.5/2.0 reject the unknown field with a 400.
  const payloadFor = (model) => {
    // The token floor is derived from the model that is ACTUALLY being called,
    // never from cfg.model (audit 2026-08-21): the 404 self-heal below can land
    // on a thinking model — GEMINI_PREFERRED[0] is one — and re-using a small
    // caller's 256 floor made the retry come back MAX_TOKENS with no parts, i.e.
    // a working key reported as "AI service is busy". Alias ids
    // (gemini-flash-latest, gemini-pro-latest) hide their generation and never
    // 404, so assume thinking headroom unless the id is a known pre-2.5
    // generation. Unused tokens are not spent, so the headroom is free.
    const thinks = !/gemini-(1\.\d|2\.0)/i.test(model);
    genCfg.maxOutputTokens = Math.max(opts.maxTokens || 0, thinks ? 1024 : 256);
    if (/2\.5/.test(model)) genCfg.thinkingConfig = { thinkingBudget: 0 };
    else delete genCfg.thinkingConfig;
    return JSON.stringify(body);
  };

  const call = async (model, payload) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const retries = opts.retries429 == null ? 2 : opts.retries429;
    for (let attempt = 0; ; attempt++) {
      let r;
      try {
        r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body: payload,
          signal: AbortSignal.timeout(opts.timeout),
        });
      } catch (e) {
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw httpErr('Gemini request timed out', 408);
        throw httpErr(e?.message || 'Gemini request failed', 502);
      }
      if (r.status === 429 && attempt < retries) { await sleep(4000 * (attempt + 1)); continue; }  // 4s, then 8s
      return r;
    }
  };

  let model = cfg.model;
  let r = await call(model, payloadFor(model));
  // Stale-model self-heal. Don't guess a replacement — Google retired BOTH ids
  // the old Admin dropdown offered (mam 2026-08-21), so ask the key what it can
  // actually call, retry on that, and remember it so this costs one round trip
  // once rather than on every request.
  if (r.status === 404) {
    const live = await listGeminiModels(cfg.apiKey);
    const next = pickGeminiModel(live, [model]);
    if (next) {
      console.warn(`[ai] gemini model '${model}' not available — switching to '${next}' (${live.length} models offered by this key)`);
      model = next;
      r = await call(model, payloadFor(model));
      if (r.ok && !opts.noPersistModel) rememberModel(opts.db, model);
    } else {
      console.warn(`[ai] gemini model '${model}' not available and ListModels returned nothing usable`);
    }
  }
  if (!r.ok) {
    const raw = await r.text().catch(() => '');
    let msg = raw, gStatus = '';
    try { const j = JSON.parse(raw); msg = j?.error?.message || raw; gStatus = j?.error?.status || ''; } catch (_) {}
    // Gemini answers a BAD KEY with 400 INVALID_ARGUMENT, not 401. Normalise
    // THAT ONE case so aiErrorMessage() gives mam the actionable "key invalid"
    // line instead of a raw Google string.
    // Match on the MESSAGE only — INVALID_ARGUMENT is Google's generic status
    // for the whole class of malformed 400s (oversized inline payload, bad
    // responseSchema, …). Treating the bare status as a bad key told mam her
    // WORKING key was invalid on a big drawing upload — the exact toast this
    // change set out to kill (audit 2026-08-21). Other 400s fall through to
    // aiErrorMessage()'s generic branch, which prints Google's own words.
    let status = r.status;
    if (status === 400 && /api[ _]?key[ _]?(not valid|invalid)|api_key_invalid|API_KEY_INVALID/i.test(msg)) status = 401;
    console.error('[ai] gemini HTTP', r.status, gStatus, String(msg).slice(0, 300));
    throw httpErr(msg || `Gemini HTTP ${r.status}`, status);
  }
  const data = await r.json();
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter(p => p.text).map(p => p.text).join('\n').trim();
  if (!text) {
    // 200 OK with no text = SAFETY block, RECITATION, or MAX_TOKENS eaten by
    // thinking. Must be an ERROR, never a silent "" (a "" rate parses as 0).
    const fr = cand?.finishReason || data.promptFeedback?.blockReason || 'no content';
    throw httpErr(`Gemini returned no text (${fr})`, 502);
  }
  return { text, model, provider: 'gemini',
    usage: { input_tokens: data.usageMetadata?.promptTokenCount, output_tokens: data.usageMetadata?.candidatesTokenCount } };
}

/**
 * One-shot completion against whichever provider Admin → AI Settings selects.
 * @param {object|null} db  better-sqlite3 handle (null → getDb()).
 * @param {object} opts
 *   prompt      {string}  REQUIRED. The single user turn.
 *   system      {string=} System instruction (Anthropic `system` / Gemini `systemInstruction`).
 *   maxTokens   {number=} default 1024. Gemini floors it per model (1024 on a
 *                        thinking model, 256 on a pre-2.5 one) so a small budget
 *                        can't be eaten by thinking before any text is written.
 *   json        {boolean=} ask for strict JSON (Gemini: responseMimeType application/json).
 *   jsonSchema  {object=} optional Gemini responseSchema (OpenAPI subset, UPPERCASE types).
 *   attachments {Array=}  [{ mime:'image/jpeg'|'application/pdf', data:<base64>, name?:string }]
 *   timeout     {number=} ms, default 60000.
 *   retries429  {number=} Gemini 429 retries, default 2 (4s, 8s). 0 = fail fast.
 *   override    {object=} { provider, model, apiKey } — bypass app_settings (Test connection only).
 * @returns {Promise<{ text:string, model:string, provider:'anthropic'|'gemini',
 *                     usage:{input_tokens?:number, output_tokens?:number} }>}
 * @throws  Error with .status (401/403/404/408/429/5xx, Gemini normalised) — feed to aiErrorMessage(err, provider).
 */
async function aiComplete(db, opts = {}) {
  const cfg = aiConfig(db, opts.override);
  if (!cfg.configured) throw httpErr(aiNotConfiguredMessage(cfg.provider), 401);
  const o = {
    prompt: String(opts.prompt || ''), system: opts.system || null,
    maxTokens: opts.maxTokens || 1024, json: !!opts.json, jsonSchema: opts.jsonSchema || null,
    attachments: Array.isArray(opts.attachments) ? opts.attachments : [],
    timeout: opts.timeout || 60000, retries429: opts.retries429,
    // Carried so the 404 self-heal can persist the model it discovered.
    // Test connection passes noPersistModel so probing never rewrites settings.
    db: db || null, noPersistModel: !!opts.noPersistModel || !!opts.override,
  };
  return cfg.provider === 'gemini' ? runGemini(cfg, o) : runAnthropic(cfg, o);
}

module.exports = {
  aiComplete, aiConfig, aiErrorMessage, aiNotConfiguredMessage, extractJsonArray,
  listGeminiModels, pickGeminiModel,
  AI_DEFAULTS, ANTHROPIC_FALLBACK_MODEL, GEMINI_FALLBACK_MODEL, GEMINI_PREFERRED,
};
