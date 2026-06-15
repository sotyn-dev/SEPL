// IndiaMART lead poller — the ONE genuinely IndiaMART-specific piece of the
// Lead-to-Dispatch Funnel. Everything it writes lands in the funnel DB only.
//
// Modelled on procurementReminderCron.js. runOnce():
//   1. Return early if no glusr_crm_key (funnel setting OR env) — no API call.
//   2. Build a rolling window (start = last_end − 5 min, end = now), IST,
//      formatted DD-MM-YYYYHH:MM:SS.
//   3. Call the Pull API (global fetch, Node ≥18).
//   4. INSERT OR IGNORE each record by unique_query_id → LEAD_ENTERED.
//   5. For each NEW lead: keyword → AI classifier filter, then Matcher/Pricer,
//      set the stage (WELCOME_SENT / NEEDS_REVIEW / REJECTED) and auto-send the
//      welcome template.
//   6. Update last_poll_end_time only on a successful (200/204) call.
//
// A future second lead source is a sibling fetch/normalize pair + a different
// `source` tag — no adapter framework. Skip the whole poller via
// ERP_DISABLE_INDIAMART_POLL=1.

const { getFunnelDb, getFunnelSetting, setFunnelSetting } = require('../db/leadToDispatchFunnelDb');
const { keywordPass, classifyLead, matchAndPrice } = require('../lib/lead2DispatchFunnelAi');
const { sendTemplate } = require('../lib/whatsappSend');
const { STAGE_BY_KEY } = require('../lib/l2dStages');

const INDIAMART_URL = 'https://mapi.indiamart.com/wservce/crm/crmListing/v2/';
// Set INDIAMART_MOCK_URL=http://localhost:5099 to redirect to the local mock server.
function getBaseUrl() {
  return (process.env.INDIAMART_MOCK_URL || '').trim() || INDIAMART_URL;
}
const POLL_INTERVAL_MS = 15 * 60 * 1000; // 15 min — safely above the 5-min minimum, keeps key alive

// ─── IST date formatting for the API (DD-MM-YYYYHH:MM:SS) ────────────
function fmtIstApi(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date).reduce((a, p) => (a[p.type] = p.value, a), {});
  // en-GB hour may render '24' at midnight — clamp to '00'.
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.day}-${parts.month}-${parts.year}${hh}:${parts.minute}:${parts.second}`;
}

function resolveCrmKey() {
  return (getFunnelSetting('indiamart_crm_key') || process.env.INDIAMART_CRM_KEY || '').trim();
}

// Persist the latest poll outcome so the UI can surface a silent ingestion
// failure (expired key, rate limit, network) instead of leads just stopping.
function recordPollStatus(status, error) {
  try {
    const now = new Date().toISOString();
    setFunnelSetting('last_poll_at', now);
    setFunnelSetting('last_poll_status', status);
    setFunnelSetting('last_poll_error', error || '');
    if (status === 'ok') setFunnelSetting('last_poll_ok_at', now);
  } catch (_) { /* best-effort */ }
}

function parseList(raw) {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ─── IndiaMART-specific fetch + normalize (isolated for future sources) ──
async function fetchIndiamartLeads(key, startTime, endTime) {
  const url = `${getBaseUrl()}?glusr_crm_key=${encodeURIComponent(key)}&start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;
  const res = await fetch(url, { method: 'GET' });
  let json = null;
  try { json = await res.json(); } catch { /* non-JSON body */ }
  return { httpStatus: res.status, body: json };
}

function normalizeIndiamartLead(rec) {
  return {
    source: 'indiamart',
    unique_query_id: rec.UNIQUE_QUERY_ID != null ? String(rec.UNIQUE_QUERY_ID) : null,
    query_type: rec.QUERY_TYPE || null,
    query_time: rec.QUERY_TIME || null,
    sender_name: rec.SENDER_NAME || null,
    sender_mobile: rec.SENDER_MOBILE || rec.SENDER_MOBILE_ALT || null,
    sender_email: rec.SENDER_EMAIL || rec.SENDER_EMAIL_ALT || null,
    sender_company: rec.SENDER_COMPANY || null,
    sender_city: rec.SENDER_CITY || null,
    sender_state: rec.SENDER_STATE || null,
    sender_country_iso: rec.SENDER_COUNTRY_ISO || null,
    query_product_name: rec.QUERY_PRODUCT_NAME || null,
    query_mcat_name: rec.QUERY_MCAT_NAME || null,
    query_message: rec.QUERY_MESSAGE || null,
    call_duration: rec.CALL_DURATION != null ? String(rec.CALL_DURATION) : null,
    receiver_mobile: rec.RECEIVER_MOBILE || null,
    raw_json: JSON.stringify(rec),
  };
}

// ─── Stage helpers ───────────────────────────────────────────────────
function recordStage(db, leadId, fromStage, toStage, note) {
  db.prepare(
    `INSERT INTO l2d_stage_history (lead_id, from_stage, to_stage, changed_by, changed_by_name, note)
     VALUES (?, ?, ?, NULL, 'system (poller)', ?)`
  ).run(leadId, fromStage, toStage, note || null);
  db.prepare('UPDATE l2d_leads SET stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(toStage, leadId);
}

function fmtMoney(n) {
  return '₹' + (Number(n) || 0).toLocaleString('en-IN');
}

// Filter + match a freshly-ingested lead, set its stage, and auto-send the
// welcome template. NO-THROW: any failure leaves the lead at LEAD_ENTERED
// for a human to pick up.
async function processNewLead(db, lead) {
  try {
    const include = parseList(getFunnelSetting('keyword_include'));
    const exclude = parseList(getFunnelSetting('keyword_exclude'));
    const scopePrompt = getFunnelSetting('ai_scope_prompt') || '';
    const marginPct = Number(getFunnelSetting('margin_pct')) || 0;
    const welcomeSid = getFunnelSetting('welcome_template_sid') || process.env.L2D_WELCOME_TEMPLATE_SID || null;

    // 1. Keyword pass (plain JS, no AI)
    const kw = keywordPass(lead, include, exclude);
    let relevant = false;
    if (kw === 'exclude') {
      recordStage(db, lead.id, 'LEAD_ENTERED', 'REJECTED', 'keyword exclude match');
      return;
    } else if (kw === 'include') {
      relevant = true;
    } else {
      // 2. Borderline → AI classifier second opinion
      const verdict = await classifyLead(lead, scopePrompt);
      if (!verdict) {
        recordStage(db, lead.id, 'LEAD_ENTERED', 'NEEDS_REVIEW', 'AI unavailable / inconclusive');
        return;
      }
      db.prepare('UPDATE l2d_leads SET ai_verdict=?, ai_confidence=?, ai_reason=? WHERE id=?')
        .run(verdict.verdict, verdict.confidence, verdict.reason, lead.id);
      if (verdict.verdict === 'junk') {
        recordStage(db, lead.id, 'LEAD_ENTERED', 'REJECTED', `AI junk (${verdict.reason || ''})`);
        return;
      }
      if (verdict.verdict === 'unsure') {
        recordStage(db, lead.id, 'LEAD_ENTERED', 'NEEDS_REVIEW', `AI unsure (${verdict.reason || ''})`);
        return;
      }
      relevant = true;
    }

    if (!relevant) return;

    // 3. Product → price match
    const match = await matchAndPrice(lead, marginPct);
    if (match) {
      db.prepare(
        'UPDATE l2d_leads SET matched_item_id=?, matched_item_name=?, quoted_price=?, price_source=? WHERE id=?'
      ).run(match.item_id, match.item_name, match.price, match.price_source, lead.id);
      // Send welcome WITH price (template carries Confirm Order + Expect a Call buttons)
      const sent = await sendTemplate({
        lead, templateSid: welcomeSid, templateLabel: 'welcome',
        variables: { 1: lead.sender_name || 'there', 2: match.item_name, 3: fmtMoney(match.price) },
      });
      recordStage(db, lead.id, 'LEAD_ENTERED', 'WELCOME_SENT',
        `matched "${match.item_name}" @ ${fmtMoney(match.price)} (${match.price_source}); welcome ${sent.ok ? 'sent' : 'send failed: ' + sent.error}`);
    } else {
      // Relevant but no confident price → human prices it; still greet
      // (the template's "no price" variant shows Expect-a-Call only).
      const sent = await sendTemplate({
        lead, templateSid: welcomeSid, templateLabel: 'welcome',
        variables: { 1: lead.sender_name || 'there', 2: lead.query_product_name || 'your enquiry', 3: 'on request' },
      });
      recordStage(db, lead.id, 'LEAD_ENTERED', 'NEEDS_REVIEW',
        `relevant, no confident price match; welcome ${sent.ok ? 'sent' : 'send failed: ' + sent.error}`);
    }
  } catch (e) {
    console.error('[indiamart-poll] processNewLead failed for', lead.unique_query_id, e.message);
  }
}

// ─── Main poll ───────────────────────────────────────────────────────
async function runOnce() {
  if (process.env.ERP_DISABLE_INDIAMART_POLL === '1') {
    return { skipped: 'disabled' };
  }
  const key = resolveCrmKey();
  if (!key) {
    // By design: no key configured → poller does nothing, makes NO API call.
    recordPollStatus('no_key');
    return { skipped: 'no_key' };
  }

  const db = getFunnelDb();
  const now = new Date();
  const lastEndIso = getFunnelSetting('last_poll_end_time_iso');
  // start = last end − 5 min overlap; first run → now − 15 min.
  const startDate = lastEndIso
    ? new Date(new Date(lastEndIso).getTime() - 5 * 60 * 1000)
    : new Date(now.getTime() - 15 * 60 * 1000);
  const startTime = fmtIstApi(startDate);
  const endTime = fmtIstApi(now);

  let resp;
  try {
    resp = await fetchIndiamartLeads(key, startTime, endTime);
  } catch (e) {
    console.error('[indiamart-poll] fetch error:', e.message);
    recordPollStatus('error', e.message);
    return { error: e.message };
  }

  const code = resp.body?.CODE ?? resp.httpStatus;
  // Rate limited or auth failure → log, back off, DO NOT advance the window.
  if (code === 429) {
    console.warn('[indiamart-poll] 429 rate limited — backing off, window unchanged');
    recordPollStatus('rate_limited', 'HTTP 429 — rate limited');
    return { code: 429, ingested: 0 };
  }
  if (code === 401) {
    console.warn('[indiamart-poll] 401 invalid/expired key — regenerate in Lead Manager');
    recordPollStatus('auth_failed', 'HTTP 401 — invalid or expired CRM key');
    return { code: 401, ingested: 0 };
  }
  if (code !== 200 && code !== 204) {
    console.warn('[indiamart-poll] unexpected response code', code, resp.body?.MESSAGE || '');
    recordPollStatus('error', `HTTP ${code} ${resp.body?.MESSAGE || ''}`.trim());
    return { code, ingested: 0 };
  }

  const records = Array.isArray(resp.body?.RESPONSE) ? resp.body.RESPONSE : [];
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO l2d_leads
      (source, unique_query_id, query_type, query_time, sender_name, sender_mobile,
       sender_email, sender_company, sender_city, sender_state, sender_country_iso,
       query_product_name, query_mcat_name, query_message, call_duration, receiver_mobile,
       raw_json, stage)
    VALUES (@source, @unique_query_id, @query_type, @query_time, @sender_name, @sender_mobile,
            @sender_email, @sender_company, @sender_city, @sender_state, @sender_country_iso,
            @query_product_name, @query_mcat_name, @query_message, @call_duration, @receiver_mobile,
            @raw_json, 'LEAD_ENTERED')
  `);

  const newLeads = [];
  for (const rec of records) {
    const row = normalizeIndiamartLead(rec);
    if (!row.unique_query_id) continue;
    const info = insertStmt.run(row);
    if (info.changes > 0) {
      const lead = db.prepare('SELECT * FROM l2d_leads WHERE id=?').get(info.lastInsertRowid);
      newLeads.push(lead);
    }
  }

  // Advance the window only after a successful call.
  setFunnelSetting('last_poll_end_time_iso', now.toISOString());

  // Filter + match + auto-welcome each new lead (sequential to respect AI rate).
  for (const lead of newLeads) {
    await processNewLead(db, lead);
  }

  if (newLeads.length) {
    console.log(`[indiamart-poll] ingested ${newLeads.length} new lead(s) of ${records.length} fetched`);
  }
  recordPollStatus('ok');
  return { code, fetched: records.length, ingested: newLeads.length };
}

// ─── Step-13 keep-in-touch tick ──────────────────────────────────────
// Sends due, unsent follow-ups via the follow-up template, honouring the
// lead's opt-out flag. Marks each attempted follow-up as sent so it never
// re-fires. NO-THROW. Reuses the poller's scheduler (daily interval).
async function runFollowupTick() {
  if (process.env.ERP_DISABLE_INDIAMART_POLL === '1') return { skipped: 'disabled' };
  const db = getFunnelDb();
  const followupSid = getFunnelSetting('followup_template_sid') || process.env.L2D_FOLLOWUP_TEMPLATE_SID || null;
  const todayIso = fmtIstApi(new Date()).slice(0, 10).split('-').reverse().join('-'); // YYYY-MM-DD (IST)
  const due = db.prepare(
    `SELECT f.*, l.sender_name, l.sender_mobile, l.opted_out
       FROM l2d_followups f JOIN l2d_leads l ON l.id = f.lead_id
      WHERE f.sent = 0 AND date(f.due_date) <= date(?)`
  ).all(todayIso);
  let sent = 0, skipped = 0;
  for (const f of due) {
    const lead = { id: f.lead_id, sender_name: f.sender_name, sender_mobile: f.sender_mobile, opted_out: f.opted_out };
    const r = await sendTemplate({
      lead, templateSid: followupSid, templateLabel: 'followup',
      variables: { 1: f.sender_name || 'there', 2: f.note || '' },
    });
    db.prepare('UPDATE l2d_followups SET sent=1, sent_at=CURRENT_TIMESTAMP WHERE id=?').run(f.id);
    if (r.ok) sent++; else skipped++;
  }
  if (due.length) console.log(`[indiamart-poll] follow-up tick: ${sent} sent, ${skipped} skipped/failed of ${due.length} due`);
  return { due: due.length, sent, skipped };
}

// ─── Scheduler ───────────────────────────────────────────────────────
function schedule() {
  if (process.env.ERP_DISABLE_INDIAMART_POLL === '1') {
    console.log('[indiamart-poll] disabled via ERP_DISABLE_INDIAMART_POLL');
    return;
  }
  // Boot catch-up 60 s after start (only acts if a key is configured).
  setTimeout(() => {
    runOnce().catch(e => console.error('[indiamart-poll] boot run failed:', e.message));
  }, 60 * 1000);
  // Then every 15 minutes.
  setInterval(() => {
    runOnce().catch(e => console.error('[indiamart-poll] interval run failed:', e.message));
  }, POLL_INTERVAL_MS);
  // Step-13 follow-up tick — daily (and 90 s after boot for catch-up).
  setTimeout(() => {
    runFollowupTick().catch(e => console.error('[indiamart-poll] followup boot run failed:', e.message));
  }, 90 * 1000);
  setInterval(() => {
    runFollowupTick().catch(e => console.error('[indiamart-poll] followup tick failed:', e.message));
  }, 24 * 60 * 60 * 1000);
  console.log(`[indiamart-poll] scheduled every ${POLL_INTERVAL_MS / 60000} min (boot catch-up in 60s); follow-up tick daily`);
}

module.exports = { schedule, runOnce, runFollowupTick, fetchIndiamartLeads, normalizeIndiamartLead, processNewLead, fmtIstApi };
