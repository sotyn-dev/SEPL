// WHATSAPP LEAD PARSER — turn WhatsApp text into sotyn_leads rows.
//
// Mam (2026-09-07): "whatsapp ingestion banao". Every sotyn.ai form ships with an
// empty WEBHOOK constant, so a submission only ever opens a pre-filled WhatsApp
// chat to +91 7009987817. Until the site is fixed, WhatsApp is where the leads
// actually are — this file is how we get them out.
//
// ONE parser, three callers (bank-import pattern: never two engines for one
// format): the paste box, the chat-export upload, and — if the Cloud API is ever
// connected — the inbound webhook. Pure functions, no database, no I/O, so it is
// cheap to unit-test and cannot half-write anything.
//
// The four message shapes are copied VERBATIM from the live site's own code
// (verified 2026-09-07), not guessed:
//
//   New sotyn.ai demo request        Free checklist request        Webinar registration
//   Name: <name>                     Name: <name>                  Name: <name>
//   Company: <company>               Phone: <phone>                Phone: <phone>
//   Phone: <phone>                   Email: <email>      (opt)     Company: <company>  (opt)
//   City: <city or ->                Downloaded: 11-Point …        Turnover: <slab>    (opt)
//   Trade: <trade or ->                                            Event: Contractor's …
//   Team: <team or ->
//
// …plus the bare CTA every other button on the site opens:
//   "Hi sotyn.ai, I run a contracting business and I'd like a demo."
// which carries NO fields — only the sender's own number identifies them.
//
// NOTE the demo form writes a literal "-" for an empty city/trade/team. That is a
// placeholder, not data, and must land as NULL.

// ── message → lead ───────────────────────────────────────────────────

// First line decides the form. Anchored, case-insensitive, tolerant of the
// stray punctuation people add when they forward a message by hand.
const HEADERS = [
  { re: /^\s*new\s+sotyn\.?ai\s+demo\s+request/i, form: 'demo' },
  { re: /^\s*free\s+checklist\s+request/i, form: 'magnet' },
  { re: /^\s*webinar\s+registration/i, form: 'webinar' },
];
// The bare CTA — a real person asking for a demo, with nothing but their number.
const BARE_CTA = /hi\s+sotyn\.?ai.*(contracting|demo)/i;

// Label -> column. Everything else is kept in raw_json but not mapped.
const LABELS = {
  name: 'name',
  company: 'company',
  phone: 'phone',
  mobile: 'phone',
  email: 'email',
  city: 'city',
  trade: 'trade',
  team: 'team',
  'team size': 'team',
  turnover: 'turnover',
  event: 'event',
  downloaded: 'magnet',
};

const clean = (v) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();
  // The site's own placeholder for "they left it blank".
  if (!s || s === '-' || s === '—' || s === 'N/A' || s === 'NA') return null;
  return s;
};

/**
 * Parse ONE WhatsApp message body into a lead, or null if it is not one.
 * Never throws — a message that makes no sense is simply not a lead.
 */
function parseLeadMessage(body) {
  if (!body || typeof body !== 'string') return null;
  const text = body.replace(/\r\n?/g, '\n').trim();
  if (!text) return null;

  const lines = text.split('\n').map((l) => l.replace(/[\u200e\u200f]/g, '').trim());
  const first = lines[0] || '';

  const header = HEADERS.find((h) => h.re.test(first));
  const isBare = !header && BARE_CTA.test(text);
  if (!header && !isBare) return null;

  const lead = {
    form_type: header ? header.form : 'demo',
    name: null, company: null, phone: null, email: null,
    city: null, trade: null, team: null, turnover: null, event: null, magnet: null,
    bare: isBare,
  };

  for (const line of lines.slice(header ? 1 : 0)) {
    // "Label: value" — the label must be a known one, so a stray colon inside a
    // company name ("Sharma & Co: Electricals") cannot invent a field.
    const m = line.match(/^([A-Za-z][A-Za-z ]{1,14}?)\s*:\s*(.*)$/);
    if (!m) continue;
    const col = LABELS[m[1].trim().toLowerCase()];
    if (!col) continue;
    if (lead[col] === null) lead[col] = clean(m[2]);
  }

  // "Downloaded: 11-Point Project Savings Checklist" identifies the magnet, and
  // an Event line identifies a webinar even when the header was reworded.
  if (lead.magnet && lead.form_type === 'demo') lead.form_type = 'magnet';
  if (lead.event && lead.form_type === 'demo') lead.form_type = 'webinar';

  return lead;
}

// ── chat export → messages ───────────────────────────────────────────

// Android:  "07/09/2026, 3:54 pm - Ankush: Webinar registration"
// iOS:      "[07/09/2026, 3:54:12 PM] Ankush: Webinar registration"
// Both may carry U+200E marks; iOS uses a narrow no-break space before am/pm.
// The date/time itself is deliberately NOT strictly validated — this only has to
// recognise where a message STARTS, so continuation lines can be joined to it.
const MSG_START = new RegExp(
  '^\\u200e?' +
  '(?:\\[)?' +                                   // iOS bracket
  '(\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4})' +   // date
  ',?\\s+' +
  '(\\d{1,2}:\\d{2}(?::\\d{2})?)' +              // time
  '(?:[\\s\\u202f\\u00a0]*([ap]\\.?m\\.?))?' +   // optional am/pm
  '(?:\\])?' +
  '\\s*[-–]?\\s*' +                              // Android separator
  '([^:]{1,80}?):\\s?' +                         // sender
  '([\\s\\S]*)$',
  'i'
);

// Lines WhatsApp itself writes. None of them is a lead, and the encryption /
// Meta-hosting notices in particular appear in every single export.
const SYSTEM_LINE = /(end-to-end encrypted|secure service from Meta|Messages and calls are|<Media omitted>|image omitted|video omitted|document omitted|sticker omitted|audio omitted|This message was deleted|You deleted this message|created group|added you|joined using this group|left$|changed the subject|changed this group|changed their phone number|blocked this contact|Missed voice call|Missed video call)/i;

/**
 * Split a WhatsApp chat export (.txt) into messages, joining continuation lines.
 * Returns [{ date, time, sender, body }] — parsing a message into a lead is a
 * separate step so the caller can preview what was found before writing anything.
 */
function splitChatExport(text) {
  if (!text || typeof text !== 'string') return [];
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;

  for (const raw of lines) {
    const m = raw.match(MSG_START);
    if (m) {
      if (cur) out.push(cur);
      cur = {
        date: m[1],
        time: m[2] + (m[3] ? ' ' + m[3].replace(/\./g, '').toLowerCase() : ''),
        sender: m[4].replace(/[\u200e\u200f]/g, '').trim(),
        body: m[5] || '',
      };
    } else if (cur) {
      // A line with no timestamp continues the message above it — which is what
      // every one of these leads is, since they are 5-7 lines long.
      cur.body += '\n' + raw;
    }
    // A line before the first timestamp is export preamble; drop it.
  }
  if (cur) out.push(cur);

  return out.filter((m) => !SYSTEM_LINE.test(m.body.split('\n')[0] || ''));
}

// dd/mm/yy(yy) — Indian order, which is what WhatsApp uses on these phones.
// Returns 'YYYY-MM-DD HH:MM:SS' (the format the rest of the ERP stores) or null.
//
// IMPORTANT: a WhatsApp export prints the phone's LOCAL wall-clock time, but this
// database stores UTC and every screen renders it back as IST. Writing the local
// string unchanged therefore shifts an imported lead 5½ hours into the future —
// a 3:54 pm message displayed as 9:24 pm. So the local time is converted to UTC
// here, with the offset explicit rather than assumed.
const IST_OFFSET_MIN = 330;
function toSqlDateTime(date, time, offsetMinutes = IST_OFFSET_MIN) {
  if (!date) return null;
  const d = date.split(/[\/.-]/).map((n) => parseInt(n, 10));
  if (d.length !== 3 || d.some(Number.isNaN)) return null;
  let [dd, mm, yy] = d;
  if (yy < 100) yy += 2000;
  if (dd > 31 || mm > 12) return null;

  let hh = 0, mi = 0, ss = 0;
  if (time) {
    const t = time.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?/i);
    if (t) {
      hh = parseInt(t[1], 10); mi = parseInt(t[2], 10); ss = parseInt(t[3] || '0', 10);
      const ap = (t[4] || '').toLowerCase();
      if (ap === 'pm' && hh < 12) hh += 12;
      if (ap === 'am' && hh === 12) hh = 0;
    }
  }
  // Build the instant from the local parts, then shift to UTC. Date.UTC + a
  // minute offset handles month/year rollover for us (a 1 am IST message on the
  // 1st belongs to the previous day in UTC).
  const ms = Date.UTC(yy, mm - 1, dd, hh, mi, ss) - offsetMinutes * 60000;
  const u = new Date(ms);
  if (Number.isNaN(u.getTime())) return null;
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(u.getUTCFullYear(), 4)}-${p(u.getUTCMonth() + 1)}-${p(u.getUTCDate())} `
       + `${p(u.getUTCHours())}:${p(u.getUTCMinutes())}:${p(u.getUTCSeconds())}`;
}

/**
 * Full pipeline: a pasted chat export (or a single pasted message) -> leads.
 * `selfNames` are the names that identify OUR side of the chat, so a lead
 * forwarded BY us is still captured but attributed to the message, not the sender.
 */
function parseChat(text) {
  const messages = splitChatExport(text);

  // A single pasted message has no timestamp line at all — handle that too, so
  // mam can paste one lead straight out of WhatsApp without exporting anything.
  if (!messages.length) {
    const lead = parseLeadMessage(text);
    return lead ? [{ lead, at: null, sender: null, body: text.trim() }] : [];
  }

  const out = [];
  for (const m of messages) {
    const lead = parseLeadMessage(m.body);
    if (!lead) continue;
    out.push({ lead, at: toSqlDateTime(m.date, m.time), sender: m.sender, body: m.body.trim() });
  }
  return out;
}

module.exports = { parseLeadMessage, splitChatExport, parseChat, toSqlDateTime };
