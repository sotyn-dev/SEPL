// Lead-to-Dispatch Funnel — WhatsApp send/receive (Twilio).
//
// Cold messages to brand-new leads must be pre-approved Meta templates
// (Twilio "Content" templates), so we send by contentSid + contentVariables.
// The CTA quick-reply buttons ("Confirm Order" / "Expect a Call") live in the
// approved template itself; the inbound webhook receives the tap.
//
// Design rules:
//   • twilio is required LAZILY and guarded — boot never fails if the package
//     isn't installed yet or creds aren't set (mirrors aiAgent.js's SDK guard).
//   • Every attempt is logged to l2d_messages. Sends are NO-THROW: a failure
//     is recorded and returned, it never blocks a stage transition.
//   • Sends to opted-out leads are skipped.
//   • normalisePhone() is reused READ-ONLY from server/utils/whatsapp.js.

const { getFunnelDb } = require('../db/leadToDispatchFunnelDb');
const { normalisePhone } = require('../utils/whatsapp');

function getTwilioClient() {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from = process.env.TWILIO_WHATSAPP_FROM;
  if (!sid || !token || !from) return null;
  let twilio;
  try {
    twilio = require('twilio');
  } catch (e) {
    console.warn('[l2d-wa] twilio package not installed:', e.message);
    return null;
  }
  return { client: twilio(sid, token), from };
}

function logMessage({ lead_id, direction = 'out', template = null, body = null, twilio_sid = null, status = null, error = null }) {
  try {
    getFunnelDb().prepare(
      `INSERT INTO l2d_messages (lead_id, direction, channel, template, body, twilio_sid, status, error)
       VALUES (?, ?, 'whatsapp', ?, ?, ?, ?, ?)`
    ).run(lead_id, direction, template, body, twilio_sid, status, error);
  } catch (e) {
    console.error('[l2d-wa] failed to log message:', e.message);
  }
}

// Send an approved template to a lead. Returns { ok, sid?, error? }.
// variables: object mapping the template's {{1}},{{2}}… placeholders, e.g.
//   { 1: 'Ravi', 2: 'Dye Sublimation Ink', 3: '₹12,500' }
// Never throws.
async function sendTemplate({ lead, templateSid, variables = {}, templateLabel = null }) {
  const leadId = lead?.id;
  if (lead?.opted_out) {
    logMessage({ lead_id: leadId, template: templateLabel || templateSid, status: 'skipped', error: 'lead opted out' });
    return { ok: false, error: 'opted_out' };
  }
  const to = normalisePhone(lead?.sender_mobile);
  if (!to) {
    logMessage({ lead_id: leadId, template: templateLabel || templateSid, status: 'failed', error: 'no valid WhatsApp number' });
    return { ok: false, error: 'no_number' };
  }
  if (!templateSid) {
    logMessage({ lead_id: leadId, template: templateLabel, status: 'failed', error: 'template SID not configured' });
    return { ok: false, error: 'no_template' };
  }
  const tw = getTwilioClient();
  if (!tw) {
    logMessage({ lead_id: leadId, template: templateLabel || templateSid, status: 'failed', error: 'Twilio not configured' });
    return { ok: false, error: 'twilio_unconfigured' };
  }

  try {
    const msg = await tw.client.messages.create({
      from: tw.from.startsWith('whatsapp:') ? tw.from : `whatsapp:${tw.from}`,
      to: `whatsapp:+${to}`,
      contentSid: templateSid,
      contentVariables: JSON.stringify(variables || {}),
    });
    logMessage({
      lead_id: leadId, template: templateLabel || templateSid,
      body: JSON.stringify(variables || {}), twilio_sid: msg.sid, status: msg.status || 'queued',
    });
    return { ok: true, sid: msg.sid };
  } catch (e) {
    logMessage({ lead_id: leadId, template: templateLabel || templateSid, status: 'failed', error: e.message });
    return { ok: false, error: e.message };
  }
}

// Map a Twilio inbound webhook payload (form-encoded body) to a funnel action.
// Quick-reply taps arrive as ButtonText/ButtonPayload; free text as Body.
// Returns { from, action: 'confirm_order'|'expect_call'|null, text }.
function parseInboundButton(payload = {}) {
  const fromRaw = String(payload.From || payload.WaId || '').replace(/^whatsapp:/, '');
  const from = normalisePhone(fromRaw);
  const text = String(payload.ButtonText || payload.ButtonPayload || payload.Body || '').trim();
  const norm = text.toLowerCase();
  let action = null;
  if (/confirm/.test(norm) && /order/.test(norm)) action = 'confirm_order';
  else if (/confirm[_\s-]?order/.test(norm)) action = 'confirm_order';
  else if (/expect/.test(norm) && /call/.test(norm)) action = 'expect_call';
  else if (/call[_\s-]?me|call back|callback/.test(norm)) action = 'expect_call';
  return { from, action, text };
}

module.exports = { sendTemplate, parseInboundButton, logMessage, getTwilioClient };
