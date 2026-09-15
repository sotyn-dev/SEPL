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
// Preference order when auto-picking a live Gemini model. FLASH-LITE FIRST:
// every caller here wants a short answer (a rate, a head-count, a JSON row),
// not deep reasoning, and the lite models carry by far the most generous
// FREE-tier limits. mam 2026-08-21 is on the free tier deliberately ("i want
// free which will work") and hit a 429 on gemini-3.6-flash, whose free
// allowance is small — so the cheap, high-quota models are tried first and the
// flagships are kept as backstops.
const GEMINI_PREFERRED = [
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
  'gemini-3.6-flash', 'gemini-3.7-flash', 'gemini-3.5-flash',
];
// A CAPABILITY-first order for the rare caller that would rather pay quota than
// lose answer quality (opts.prefer:'capable' — vision/drawing work). Same ids,
// flagships first. No caller opts in today; the default stays cheap-first.
const GEMINI_PREFERRED_CAPABLE = [
  'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-3.5-flash',
  'gemini-3.5-flash-lite', 'gemini-3.1-flash-lite',
];
// The default, the 404 fallback and the preference list must all name the SAME
// model. Audit 2026-08-21: the list was reordered to flash-lite but these two
// still said 'gemini-3.6-flash', so a blank/reset/coerced ai_model STARTED on
// the flagship whose free quota mam had just exhausted, and the 404 toast told
// her to pick it. Derive them from the list so they can never drift again.
const AI_DEFAULTS = { anthropic: 'claude-opus-4-7', gemini: GEMINI_PREFERRED[0] };
const ANTHROPIC_FALLBACK_MODEL = 'claude-opus-5';   // stale-model self-heal (audit 2026-08-18)
const GEMINI_FALLBACK_MODEL = GEMINI_PREFERRED[0];

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
  return { text, model, requestedModel: cfg.model, provider: 'anthropic',
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

// Best live model for short answers: first hit in the preference list, else any
// non-preview flash, else the cheapest-looking thing the key reports.
//
// The LAST-RESORT rung used to be `available.find(m => !skip.has(m.id))`, which
// ignored both filters above it and could hand back a *-pro or *-preview id —
// exactly the models with the SMALLEST free-tier allowance, the opposite of
// what this list exists to do (audit 2026-08-21). It now degrades in order:
// preferred → plain flash → any stable non-pro → any stable → anything.
// @param prefer 'capable' = flagships first (vision/drawing callers); default cheap-first.
function pickGeminiModel(available, exclude, prefer) {
  const ids = new Set(available.map(m => m.id));
  const skip = new Set(exclude || []);
  const order = prefer === 'capable' ? GEMINI_PREFERRED_CAPABLE : GEMINI_PREFERRED;
  for (const p of order) if (ids.has(p) && !skip.has(p)) return p;
  const usable = available.filter(m => !skip.has(m.id));
  const stable = (m) => !/preview|exp/i.test(m.id);
  const flash = usable.find(m => /flash/i.test(m.id) && stable(m));
  if (flash) return flash.id;
  const lean = usable.find(m => stable(m) && !/pro|ultra/i.test(m.id));
  if (lean) return lean.id;
  const anyStable = usable.find(stable);
  if (anyStable) return anyStable.id;
  return usable.length ? usable[0].id : null;
}

// Same pick, but SKIPPING models this process saw 429 in the last cooldown.
// pickGeminiModel() itself is quota-blind — it walks GEMINI_PREFERRED from the
// top — so a walk that used it kept selecting models it had already recorded as
// spent, burning a whole agentic turn each time (audit 2026-08-21). If every
// candidate is capped we fall back to the quota-blind pick: a stale cap is a
// guess, and trying something beats returning nothing.
// NOTE: declared BELOW isQuotaCapped in module scope; both are function
// declarations, so the hoisting is safe.
function pickFreshGeminiModel(available, exclude, prefer) {
  const fresh = (available || []).filter(m => !isQuotaCapped(m.id));
  return pickGeminiModel(fresh, exclude, prefer) || pickGeminiModel(available, exclude, prefer);
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

// ── Free-tier quota memory — IN PROCESS ONLY, deliberately not persisted ────
// A 404 is permanent (Google retired the id) so healing onto a new model is
// written to app_settings. A 429 is NOT: it is a rolling free-tier window that
// reopens. Persisting a 429 hop turned a temporary condition into a permanent
// settings change mam never chose — every AI feature (and the separate Ask
// SOTYN.AI chat, which reads the same app_settings.ai_model) stayed downgraded
// to the lite tier forever, because nothing ever walks back UP the list
// (audit 2026-08-21). So a quota hop lives here instead: for the next
// QUOTA_COOLDOWN_MS this process starts on the model that answered, and after
// that it goes back to HER model on its own. A pm2 restart also clears it.
const QUOTA_COOLDOWN_MS = 15 * 60 * 1000;
// A body at or above this size is treated as "expensive to re-upload" — the
// 429/404 walk is capped at a single hop for it (25MB of drawings x 4 hops is
// ~100MB out of a 1GB VPS).
const BIG_PAYLOAD_BYTES = 256 * 1024;
// Don't start a hop with less than this much of the caller's budget left.
const MIN_HOP_MS = 2000;
// The SHORT end of the scale: a per-MINUTE 429 reopens in about a minute, so
// parking every consumer off mam's chosen model for the full 15 minutes because
// a bulk Vendor-Rates sweep tripped RPM is wrong (audit 2026-08-21). Google's
// 429 body carries both the quota id (…PerMinute vs …PerDay) and a RetryInfo
// retryDelay — parseRetryDelayMs() below reads them so the cooldown matches the
// window that was actually hit.
const QUOTA_MIN_COOLDOWN_MS = 45 * 1000;
const quotaCapped = new Map();   // model id → { at, ttl } of the last 429
let quotaSwitch = null;          // { from, to, at } — last quota hop that WORKED

/**
 * How long a model should be treated as quota-capped, read from Google's own
 * 429 body. Returns null when the body says nothing useful (caller then uses
 * the conservative QUOTA_COOLDOWN_MS default).
 *   - "quotaId": "GenerateRequestsPerMinutePerProjectPerModel" → short window
 *   - RetryInfo { "retryDelay": "27s" }                        → use that delay
 *   - anything naming PerDay                                   → full cooldown
 * @param {string|object} body raw 429 response text (or parsed object).
 */
function parseRetryDelayMs(body) {
  if (!body) return null;
  let txt = typeof body === 'string' ? body : '';
  if (!txt) { try { txt = JSON.stringify(body); } catch (_) { return null; } }
  if (/per\s*-?\s*day|PerDay/i.test(txt)) return QUOTA_COOLDOWN_MS;
  const m = txt.match(/"?retryDelay"?\s*[:=]\s*"?(\d+(?:\.\d+)?)s"?/i);
  if (m) {
    const ms = Math.round(parseFloat(m[1]) * 1000);
    // +50% margin so we don't come back a beat early, clamped both ways.
    return Math.max(QUOTA_MIN_COOLDOWN_MS, Math.min(QUOTA_COOLDOWN_MS, Math.round(ms * 1.5)));
  }
  if (/per\s*-?\s*minute|PerMinute/i.test(txt)) return QUOTA_MIN_COOLDOWN_MS;
  return null;
}

/**
 * Record that a model is out of free quota.
 * @param {string} model
 * @param {number|string|object=} ttlOrBody  ms to hold the cap for, OR the raw
 *   429 body to derive it from. Omitted → the conservative 15-min default.
 */
function markQuotaCapped(model, ttlOrBody) {
  let ttl = null;
  if (typeof ttlOrBody === 'number' && ttlOrBody > 0) ttl = ttlOrBody;
  else if (ttlOrBody != null) ttl = parseRetryDelayMs(ttlOrBody);
  quotaCapped.set(model, { at: Date.now(), ttl: ttl || QUOTA_COOLDOWN_MS });
}
function isQuotaCapped(model) {
  const e = quotaCapped.get(model);
  if (!e) return false;
  // Tolerate the old bare-timestamp shape in case anything still writes it.
  const at = typeof e === 'number' ? e : e.at;
  const ttl = (typeof e === 'number' ? QUOTA_COOLDOWN_MS : e.ttl) || QUOTA_COOLDOWN_MS;
  if (Date.now() - at > ttl) { quotaCapped.delete(model); return false; }
  return true;
}
// A model that just ANSWERED is demonstrably not capped. Called by both this
// module's heal and routes/aiAgent.js's chat walk, so the memory is genuinely
// shared in BOTH directions: without this the chat's successful hop was
// invisible here and every one-shot caller re-burned a full failed request on
// the capped model (audit 2026-08-21).
function noteQuotaSwitch(from, to) {
  if (!to) return;
  quotaCapped.delete(to);
  if (from && from !== to) quotaSwitch = { from, to, at: Date.now() };
}
// Exposed so Admin → AI Settings can one day show "auto-switched from X to Y
// (quota)" instead of the switch being invisible. Returns null once it expires.
function getQuotaSwitch() {
  if (!quotaSwitch) return null;
  if (Date.now() - quotaSwitch.at > QUOTA_COOLDOWN_MS) { quotaSwitch = null; return null; }
  return { ...quotaSwitch };
}
function _resetQuotaMemory() { quotaCapped.clear(); quotaSwitch = null; }   // tests only

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

  // Serialise ONCE PER BODY SHAPE — never inside the retry loop, and never
  // again per hop. The model id lives in the URL, not the body, so every 429
  // attempt reuses the same string; procurementSchedule.js can ship ~33MB of
  // base64 drawings here and re-stringifying that per attempt churned hundreds
  // of MB on the VPS for nothing (audit 2026-08-21). The 429 walk then
  // re-stringified the SAME bytes up to 3 more times, because every id in
  // GEMINI_PREFERRED lands on the same (thinks, 2.5, maxOutputTokens) triple —
  // so the string is now memoised on exactly that triple and a hop between two
  // same-shaped models costs zero extra serialisation (audit 2026-08-21).
  const payloadCache = new Map();
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
    const is25 = /2\.5/.test(model);
    const maxOut = Math.max(opts.maxTokens || 0, thinks ? 1024 : 256);
    const key = `${thinks}|${is25}|${maxOut}`;
    const hit = payloadCache.get(key);
    if (hit) return hit;
    genCfg.maxOutputTokens = maxOut;
    if (is25) genCfg.thinkingConfig = { thinkingBudget: 0 };
    else delete genCfg.thinkingConfig;
    const s = JSON.stringify(body);
    payloadCache.set(key, s);
    return s;
  };

  // Wall-clock spent INSIDE generateContent fetches (the timed 429 back-off
  // sleeps and the ListModels round trip are excluded — they are not the
  // caller's per-attempt budget). The hop walk below spends against this so the
  // whole walk fits inside ONE opts.timeout instead of taking a fresh full
  // timeout per hop (audit 2026-08-21: 4 x 180s = 12 min on a 180s contract).
  let netMs = 0;
  const call = async (model, payload, retriesOverride, timeoutOverride) => {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const retries = retriesOverride != null ? retriesOverride
      : (opts.retries429 == null ? 2 : opts.retries429);
    const perAttempt = timeoutOverride != null ? timeoutOverride : opts.timeout;
    for (let attempt = 0; ; attempt++) {
      let r;
      const t0 = Date.now();
      try {
        r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
          body: payload,
          signal: AbortSignal.timeout(perAttempt),
        });
      } catch (e) {
        netMs += Date.now() - t0;
        if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw httpErr('Gemini request timed out', 408);
        throw httpErr(e?.message || 'Gemini request failed', 502);
      }
      netMs += Date.now() - t0;
      if (r.status === 429 && attempt < retries) { await sleep(4000 * (attempt + 1)); continue; }  // 4s, then 8s
      return r;
    }
  };

  // Record a 429 with the cooldown Google's own body implies (per-minute vs
  // per-day). r.clone() so the final error path can still read the body.
  const capFrom = async (r, m) => {
    let body = '';
    try { body = await r.clone().text(); } catch (_) {}
    markQuotaCapped(m, body || undefined);
  };

  let model = cfg.model;
  const tried = [];
  // A quota hop earlier in this process is remembered IN MEMORY only (see
  // QUOTA_COOLDOWN_MS above): if her model was 429'd minutes ago, start on the
  // one that answered instead of paying the failed call + ListModels round trip
  // on every single request. app_settings still holds HER choice, and once the
  // cooldown lapses we go straight back to it. A probe (Test connection) is
  // exempt — it must test exactly the model that was typed.
  // preflightSwitched: we LEFT her model because of a 429, not because it is
  // retired — so a 404 further down the walk must never be persisted over her
  // choice (audit 2026-08-21).
  let preflightSwitched = false;
  let liveModels = null;          // ListModels answer, fetched at most once per call
  if (!opts.noHeal && isQuotaCapped(model)) {
    // 1) A model that ANSWERED after a quota hop (this module's or the chat's,
    //    via noteQuotaSwitch) — zero network, the good case.
    let alt = quotaSwitch && quotaSwitch.to;
    if (alt && (alt === model || isQuotaCapped(alt))) alt = null;
    // 2) Nothing remembered: ask the key what it can call and pick a model this
    //    process has NOT seen 429 — still cheaper than spending a whole request
    //    (plus its 4s+8s back-off) rediscovering a cap we already recorded.
    if (!alt) {
      const tPre = Date.now();
      liveModels = await listGeminiModels(cfg.apiKey, Math.max(1000, Math.min(15000, opts.timeout)));
      netMs += Date.now() - tPre;
      alt = pickFreshGeminiModel(liveModels, [model], opts.prefer);
      if (alt && isQuotaCapped(alt)) alt = null;   // everything capped → just use hers
    }
    if (alt && alt !== model) {
      console.warn(`[ai] gemini '${model}' was quota-capped minutes ago — using '${alt}' for this request (in-memory only; Admin → AI Settings still says '${model}')`);
      tried.push(model);            // never re-select the model we just skipped
      model = alt;
      preflightSwitched = true;
    }
  }
  tried.push(model);
  let r = await call(model, payloadFor(model));
  if (r.status === 429) await capFrom(r, model);
  // Self-heal onto another model the key can actually use. TWO triggers:
  //   404 — the id is retired. Google killed BOTH ids the old Admin dropdown
  //         offered (mam 2026-08-21), so never guess a replacement: ask.
  //   429 — this MODEL's free-tier quota is spent. Quota on Gemini is charged
  //         PER MODEL, so a sibling (especially a flash-lite, which carries the
  //         most generous free limits) is usually still open. mam 2026-08-21:
  //         "i want free which will work" — she is on the free tier by choice,
  //         so exhausting one model must not take every AI feature down.
  // call() has already burned its own timed 429 retries before we get here.
  const healTrigger = r.status;
  let healed = false;
  if (!opts.noHeal && (r.status === 404 || r.status === 429)) {
    // ListModels counts against the same budget as the hops below.
    let live = liveModels;
    if (!live) {
      const tList = Date.now();
      live = liveModels = await listGeminiModels(cfg.apiKey, Math.max(1000, Math.min(15000, opts.timeout - netMs)));
      netMs += Date.now() - tList;
    }
    // HOW MANY HOPS THIS CALLER CAN AFFORD (audit 2026-08-21). The walk re-POSTs
    // the caller's whole body per hop, so it must respect what the caller is
    // shipping. procurementSchedule.js sends up to 25MB of drawings with
    // retries429:0 *precisely* to get one attempt; 4 attempts there is ~100MB
    // re-uploaded from a 1GB VPS that has been OOM-killed at ~190MB before. So a
    // body with attachments (or >256KB serialised) gets ONE hop — enough to
    // escape a capped model, not enough to melt the box — while a 40-token rate
    // ask keeps the full walk, because several models can be capped at once.
    //
    // retries429:0 means "don't SLEEP out a quota window", and it is still
    // honoured exactly: hops never sleep (retriesOverride 0 below), and the
    // whole walk now shares ONE opts.timeout of network time instead of each
    // hop getting a fresh full one (4 x 180s = 12 min against a 180s contract,
    // long past nginx's 60s and the browser).
    const bigBody = (opts.attachments || []).length > 0 || payloadFor(model).length > BIG_PAYLOAD_BYTES;
    const maxHops = bigBody ? 1 : 3;
    // NOTE the loop re-reads r.status every iteration: a 404 that lands on a capped
    // model used to stop dead after one hop because `hops` was frozen from the
    // FIRST status, leaving an open free model one entry further down untried.
    for (let i = 0; i < maxHops && (r.status === 404 || r.status === 429); i++) {
      const left = opts.timeout - netMs;
      if (left < MIN_HOP_MS) {
        console.warn(`[ai] gemini ${r.status} on '${model}' — no time left in the caller's ${opts.timeout}ms budget to try another model`);
        break;
      }
      const next = pickFreshGeminiModel(live, tried, opts.prefer);
      if (!next) break;
      console.warn(`[ai] gemini '${model}' ${r.status === 429 ? 'quota exhausted' : 'not available'} — trying '${next}' (${live.length} models offered by this key)`);
      tried.push(next);
      model = next;
      // No timed 429 back-off on a hop: waiting 4s+8s on a model we only
      // reached BECAUSE another was capped would stall a click for ~40s across
      // 3 hops. Sitting out a quota window is what the caller's own retry is
      // for; here we just want the first model that answers immediately.
      r = await call(model, payloadFor(model), 0, Math.min(opts.timeout, left));
      if (r.status === 429) await capFrom(r, model);
      if (r.ok) { healed = true; break; }
      // Anything that is neither 404 nor 429 (403, 400, 5xx) is a real error —
      // the loop condition stops the walk on the next turn.
    }
    if (!r.ok && !live.length) {
      console.warn(`[ai] gemini '${model}' failed ${r.status} and ListModels returned nothing usable`);
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
  // ── Bookkeeping AFTER the reply has proved itself ──────────────────────────
  // Two rules, both learned the hard way (audit 2026-08-21):
  //  1. Persist only once we have TEXT. The old code wrote the model on r.ok
  //     alone, so a hop that answered 200 with no parts (SAFETY / RECITATION /
  //     MAX_TOKENS) was saved as ai_model and the request still failed 502 —
  //     the next request then STARTED on the model that produced nothing.
  //  2. Persist only a 404 heal. A retired id is gone for good, so writing the
  //     replacement is right. A 429 is a rolling free-tier window: writing it
  //     would silently and permanently replace mam's own choice (and downgrade
  //     the separate Ask SOTYN.AI chat, which reads the same key) with nothing
  //     that ever walks back up. That one lives in memory for QUOTA_COOLDOWN_MS.
  //     preflightSwitched counts as a 429 trigger for the same reason: we left
  //     her model over quota, so a 404 on the SUBSTITUTE must not be written
  //     over her choice either.
  if (healed || preflightSwitched) {
    if (healed && healTrigger === 404 && !preflightSwitched) {
      quotaCapped.delete(model);
      if (!opts.noPersistModel) rememberModel(opts.db, model);
    } else {
      // Remember the model that ANSWERED so the next request skips the capped
      // one with zero network (and so the chat's walk can reuse it too).
      noteQuotaSwitch(cfg.model, model);
      console.warn(`[ai] gemini quota switch: '${cfg.model}' → '${model}' for the next ${Math.round(QUOTA_COOLDOWN_MS / 60000)} min (NOT saved — Admin → AI Settings keeps your choice)`);
    }
  }
  return { text, model, requestedModel: cfg.model, provider: 'gemini',
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
 *   timeout     {number=} ms, default 60000. Gemini: this is the budget for the
 *                        WHOLE call including any 404/429 model hop, not per hop.
 *   retries429  {number=} Gemini 429 retries, default 2 (4s, 8s). 0 = fail fast
 *                        (also caps the model-hop walk at a single hop).
 *   prefer      {'cheap'|'capable'=} Gemini model preference when auto-picking.
 *                        Default 'cheap' (flash-lite first — biggest free quota).
 *                        'capable' puts the flagships first, for a caller whose
 *                        output quality is visible (drawing vision, photo count).
 *   override    {object=} { provider, model, apiKey } — bypass app_settings (Test connection only).
 *                        Implies noPersistModel AND noHeal: a probe must report
 *                        exactly what the model being tested did, never a
 *                        substitute's success under the tested model's name.
 * @returns {Promise<{ text:string, model:string, requestedModel:string,
 *                     provider:'anthropic'|'gemini',
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
    prefer: opts.prefer === 'capable' ? 'capable' : 'cheap',
    // Carried so the 404 self-heal can persist the model it discovered.
    // Test connection passes noPersistModel so probing never rewrites settings.
    db: db || null, noPersistModel: !!opts.noPersistModel || !!opts.override,
    // A PROBE tests one model, so it must not silently answer on another:
    // "gemini-3.6-flash responded — key works" while a lite sibling actually
    // answered told mam her quota-dead selection was healthy (audit 2026-08-21).
    // With no heal she gets the real 429 wording, which names the free tier.
    noHeal: !!opts.noHeal || !!opts.override,
  };
  return cfg.provider === 'gemini' ? runGemini(cfg, o) : runAnthropic(cfg, o);
}

module.exports = {
  aiComplete, aiConfig, aiErrorMessage, aiNotConfiguredMessage, extractJsonArray,
  listGeminiModels, pickGeminiModel, pickFreshGeminiModel, getQuotaSwitch, _resetQuotaMemory,
  // Shared with routes/aiAgent.js: the chat keeps its OWN agentic Gemini loop
  // but must not re-learn which model is quota-capped (mam 2026-08-21: market
  // rates recovered while the chat still 429'd, because only this module knew).
  markQuotaCapped, isQuotaCapped, noteQuotaSwitch, parseRetryDelayMs, QUOTA_COOLDOWN_MS,
  AI_DEFAULTS, ANTHROPIC_FALLBACK_MODEL, GEMINI_FALLBACK_MODEL,
  GEMINI_PREFERRED, GEMINI_PREFERRED_CAPABLE,
};
