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
//
// ANCHORED, and the gap is bounded and newline-free. The original
// /hi\s+sotyn\.?ai.*(contracting|demo)/i put an unbounded `.*` in front of an
// alternation, which backtracks from every position the prefix could start at:
// measured 14 ms at 11 KB, 625 ms at 88 KB, cleanly quadratic, so the 5 MB the
// import route accepts would pin this synchronous server for hours and freeze
// every other screen with it (review 2026-09-07).
const BARE_CTA = /^\s*hi\s+sotyn\.?ai\b[^\n]{0,160}?(contracting|demo)/i;

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
  const isBare = !header && BARE_CTA.test(first);
  if (!header && !isBare) return null;

  const lead = {
    form_type: header ? header.form : 'demo',
    name: null, company: null, phone: null, email: null,
    city: null, trade: null, team: null, turnover: null, event: null, magnet: null,
    bare: isBare,
  };

  for (const line of lines.slice(header ? 1 : 0)) {
    // A second form header means a second message got concatenated into this
    // body — stop, or its fields are absorbed into this lead's empty slots and
    // one person is recorded at another's company (review 2026-09-07).
    if (HEADERS.some((h) => h.re.test(line))) break;
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
// Some locales export ISO dates: "2026-09-07, 15:54 - Ankush: …".
//
// The SENDER IS OPTIONAL on purpose. WhatsApp writes author-less notice lines
// ("… - Messages and calls are end-to-end encrypted.", "… - Ankush changed their
// phone number") which have no "Name:" segment. If those do not match here they
// are treated as continuation text and GLUED onto the lead above them, polluting
// the stored message (reproduced in the 2026-09-07 research pass). Matching them
// as their own author-less message keeps that boundary intact; they are dropped
// straight afterwards because they carry no lead.
//
// A leading BOM is matched too: WhatsApp exports are UTF-8 with a BOM, and without
// this the FIRST message of every export was silently lost.
const MSG_START = new RegExp(
  '^[\\ufeff\\u200e\\u200f]*' +               // BOM / bidi marks
  '(?:\\[)?' +                                    // iOS bracket
  '(\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4})' +   // ISO or dd/mm/yy
  ',?\\s+' +
  '(\\d{1,2}:\\d{2}(?::\\d{2})?)' +                  // time
  '(?:[\\s\\u202f\\u00a0]*([ap]\\.?m\\.?))?' +          // optional am/pm
  '(?:\\])?' +
  '\\s*[-–]?\\s*' +                                    // Android separator
  '(?:([^:]{1,80}?):\\s?)?' +                          // sender — OPTIONAL (notice lines have none)
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
  // Strip a leading BOM once for the whole file as well — belt and braces.
  const lines = text.replace(/^\ufeff/, '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let cur = null;

  for (const raw of lines) {
    const m = raw.match(MSG_START);
    if (m) {
      if (cur) out.push(cur);
      cur = {
        authorless: !m[4],   // a WhatsApp notice line, not somebody's message
        date: m[1],
        time: m[2] + (m[3] ? ' ' + m[3].replace(/\./g, '').toLowerCase() : ''),
        sender: (m[4] || '').replace(/[\u200e\u200f]/g, '').trim(),
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

  // Author-less lines are WhatsApp's own notices; they can never be a lead.
  return out.filter((m) => !m.authorless && !SYSTEM_LINE.test(m.body.split('\n')[0] || ''));
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
function toSqlDateTime(date, time, offsetMinutes = IST_OFFSET_MIN, order = 'dmy') {
  if (!date) return null;
  const d = date.split(/[\/.-]/).map((n) => parseInt(n, 10));
  if (d.length !== 3 || d.some(Number.isNaN)) return null;
  // dd/mm/yy is the Indian order WhatsApp uses on these phones, but an ISO
  // export (yyyy-mm-dd) leads with a 4-digit year — detect it rather than
  // reading 2026 as a day.
  let [dd, mm, yy] = /^\d{4}-/.test(date) ? [d[2], d[1], d[0]]
                   : order === 'mdy' ? [d[1], d[0], d[2]]
                   : d;
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

// Split a raw paste (no export timestamps) into one block per message, starting a
// new block at every form header or bare CTA. Anything before the first header is
// discarded — it cannot belong to a lead.
function splitPastedBlocks(text) {
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  const isStart = (l) => HEADERS.some((h) => h.re.test(l)) || BARE_CTA.test(l);
  const blocks = [];
  let cur = null;
  for (const line of lines) {
    if (isStart(line)) { if (cur) blocks.push(cur); cur = [line]; }
    else if (cur) cur.push(line);
  }
  if (cur) blocks.push(cur);
  return blocks.map((b) => b.join('\n'));
}

/**
 * Full pipeline: a pasted chat export (or a single pasted message) -> leads.
 * `selfNames` are the names that identify OUR side of the chat, so a lead
 * forwarded BY us is still captured but attributed to the message, not the sender.
 */
// Work out whether this export writes dd/mm or mm/dd by looking at ALL of its
// dates: any first component over 12 can only be a day, any second component over
// 12 can only be a month. WhatsApp follows the PHONE's locale, and "English
// (United States)" is common on Indian handsets, so assuming dd/mm unconditionally
// silently back-dated leads by months (review 2026-09-07). When every date in the
// file is ambiguous (all components <= 12) we keep dd/mm, which is what the
// Indian-locale phones this actually runs on produce.
function inferDateOrder(messages) {
  for (const m of messages) {
    if (!m.date || /^\d{4}-/.test(m.date)) continue;       // ISO needs no guess
    const [a, b] = m.date.split(/[\/.-]/).map((n) => parseInt(n, 10));
    if (a > 12) return 'dmy';
    if (b > 12) return 'mdy';
  }
  return 'dmy';
}

function parseChat(text) {
  const messages = splitChatExport(text);
  const order = inferDateOrder(messages);

  // A pasted message has no timestamp line at all — handle that too, so mam can
  // copy leads straight out of WhatsApp without exporting anything. She may well
  // paste SEVERAL at once (the screen invites it), so split on the form headers
  // rather than treating the whole paste as one message: handing it all to
  // parseLeadMessage returned a single row wearing three people's details, and
  // silently dropped the other two (review 2026-09-07).
  if (!messages.length) {
    return splitPastedBlocks(text)
      .map((block) => ({ lead: parseLeadMessage(block), at: null, sender: null, body: block.trim() }))
      .filter((x) => x.lead);
  }

  const out = [];
  for (const m of messages) {
    let lead = parseLeadMessage(m.body);
    // MSG_START stops the sender at the FIRST colon, so a contact saved as
    // "Sotyn: Leads" leaves "Leads: " glued to the front of the body and the form
    // header no longer starts line 1 — the whole lead vanished silently. Retry
    // once with that leftover prefix stripped (review 2026-09-07).
    if (!lead) {
      const stripped = m.body.replace(/^[^\n:]{1,80}:\s?/, '');
      if (stripped !== m.body) lead = parseLeadMessage(stripped);
    }
    if (!lead) continue;
    out.push({ lead, at: toSqlDateTime(m.date, m.time, IST_OFFSET_MIN, order), sender: m.sender, body: m.body.trim() });
  }
  return out;
}

module.exports = { parseLeadMessage, splitChatExport, parseChat, toSqlDateTime };
