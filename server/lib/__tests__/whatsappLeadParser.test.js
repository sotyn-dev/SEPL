// Tests for the WhatsApp lead parser. Plain node — `node server/lib/__tests__/whatsappLeadParser.test.js`.
// The fixtures are the REAL message texts the sotyn.ai forms build (verified from
// the live site 2026-09-07), wrapped in real Android and iOS export lines.
const assert = require('assert');
const { parseLeadMessage, splitChatExport, parseChat, toSqlDateTime } = require('../whatsappLeadParser');

const LRM = String.fromCharCode(0x200e);
const NNBSP = String.fromCharCode(0x202f);
const RUPEE = String.fromCharCode(0x20b9);
const ENDASH = String.fromCharCode(0x2013);

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('  ok   ' + name); }
  catch (e) { fail++; console.log('  FAIL ' + name + '\n       ' + e.message); }
}

// ── single messages ──────────────────────────────────────────────────

t('webinar registration (the exact message mam forwarded)', () => {
  const lead = parseLeadMessage(
    'Webinar registration\n' +
    'Name: Monika Devi\n' +
    'Phone: 919501890918\n' +
    'Company: Secured engineer Pvt Ltd\n' +
    'Turnover: ' + RUPEE + '10' + ENDASH + '50 Cr\n' +
    "Event: Contractor's Profit Masterclass"
  );
  assert.strictEqual(lead.form_type, 'webinar');
  assert.strictEqual(lead.name, 'Monika Devi');
  assert.strictEqual(lead.phone, '919501890918');
  assert.strictEqual(lead.company, 'Secured engineer Pvt Ltd');
  assert.strictEqual(lead.turnover, RUPEE + '10' + ENDASH + '50 Cr');
  assert.strictEqual(lead.event, "Contractor's Profit Masterclass");
});

t('demo request, with the literal "-" placeholders becoming NULL', () => {
  const lead = parseLeadMessage(
    'New sotyn.ai demo request\n' +
    'Name: Harpreet Sandhu\nCompany: Sandhu Electricals\nPhone: 9814556677\n' +
    'City: -\nTrade: -\nTeam: -'
  );
  assert.strictEqual(lead.form_type, 'demo');
  assert.strictEqual(lead.company, 'Sandhu Electricals');
  assert.strictEqual(lead.city, null, 'a "-" must not be stored as data');
  assert.strictEqual(lead.trade, null);
  assert.strictEqual(lead.team, null);
});

t('checklist request, optional email present', () => {
  const lead = parseLeadMessage(
    'Free checklist request\nName: Meera Krishnan\nPhone: 9880012345\n' +
    'Email: meera@krishnansolar.co.in\nDownloaded: 11-Point Project Savings Checklist'
  );
  assert.strictEqual(lead.form_type, 'magnet');
  assert.strictEqual(lead.email, 'meera@krishnansolar.co.in');
  assert.strictEqual(lead.magnet, '11-Point Project Savings Checklist');
});

t('checklist request with the email line omitted', () => {
  const lead = parseLeadMessage(
    'Free checklist request\nName: No Email\nPhone: 9812345678\n' +
    'Downloaded: 11-Point Project Savings Checklist'
  );
  assert.strictEqual(lead.email, null);
  assert.strictEqual(lead.name, 'No Email');
});

t('bare CTA is recognised as a lead with no fields', () => {
  const lead = parseLeadMessage("Hi sotyn.ai, I run a contracting business and I'd like a demo.");
  assert.ok(lead, 'the plain CTA must still count as a lead');
  assert.strictEqual(lead.bare, true);
  assert.strictEqual(lead.name, null);
});

t('ordinary chatter is NOT a lead', () => {
  assert.strictEqual(parseLeadMessage('Sir cement khatam. PO approval?'), null);
  assert.strictEqual(parseLeadMessage('Ok mam'), null);
  assert.strictEqual(parseLeadMessage(''), null);
  assert.strictEqual(parseLeadMessage(null), null);
});

t('a colon inside a value cannot invent a field', () => {
  const lead = parseLeadMessage(
    'New sotyn.ai demo request\nName: Sharma & Co: Electricals\nPhone: 9800000000'
  );
  assert.strictEqual(lead.name, 'Sharma & Co: Electricals');
});

// ── exports ──────────────────────────────────────────────────────────

const ANDROID = [
  '07/09/2026, 3:52 pm - Messages and calls are end-to-end encrypted.',
  '07/09/2026, 3:54 pm - Ankush: Webinar registration',
  'Name: Monika Devi',
  'Phone: 919501890918',
  'Company: Secured engineer Pvt Ltd',
  'Turnover: ' + RUPEE + '10' + ENDASH + '50 Cr',
  "Event: Contractor's Profit Masterclass",
  '07/09/2026, 4:02 pm - Ramesh: Sir cement khatam. PO approval?',
  '07/09/2026, 4:10 pm - Ankush: New sotyn.ai demo request',
  'Name: Harpreet Sandhu',
  'Company: Sandhu Electricals',
  'Phone: 9814556677',
  'City: Ludhiana',
  'Trade: MEPF',
  'Team: 50-100',
].join('\n');

const IOS = [
  '[07/09/2026, 3:52:01 PM] ' + LRM + 'Ankush: ' + LRM + 'Messages and calls are end-to-end encrypted.',
  '[07/09/2026, 3:54:12' + NNBSP + 'PM] Ankush: Free checklist request',
  'Name: Meera Krishnan',
  'Phone: 9880012345',
  'Downloaded: 11-Point Project Savings Checklist',
  '[07/09/2026, 4:20:00' + NNBSP + 'PM] Ankush: <Media omitted>',
].join('\n');

t('android export: finds both leads, skips chatter and the encryption notice', () => {
  const found = parseChat(ANDROID);
  assert.strictEqual(found.length, 2, 'expected exactly 2 leads, got ' + found.length);
  assert.strictEqual(found[0].lead.form_type, 'webinar');
  assert.strictEqual(found[0].lead.name, 'Monika Devi');
  assert.strictEqual(found[1].lead.form_type, 'demo');
  assert.strictEqual(found[1].lead.city, 'Ludhiana');
});

t('android export: multi-line body is joined to its timestamp', () => {
  const found = parseChat(ANDROID);
  assert.strictEqual(found[0].at, '2026-09-07 10:24:00', 'IST 15:54 must be stored as UTC 10:24; got ' + found[0].at);
  assert.strictEqual(found[0].sender, 'Ankush');
});

t('ios export: brackets, LRM marks and narrow no-break space', () => {
  const found = parseChat(IOS);
  assert.strictEqual(found.length, 1, 'expected 1 lead, got ' + found.length);
  assert.strictEqual(found[0].lead.form_type, 'magnet');
  assert.strictEqual(found[0].lead.name, 'Meera Krishnan');
  assert.strictEqual(found[0].at, '2026-09-07 10:24:12', 'IST 15:54:12 -> UTC 10:24:12; got ' + found[0].at);
});

t('a single pasted message (no export lines at all) still parses', () => {
  const found = parseChat('Webinar registration\nName: Solo Paste\nPhone: 9800011122');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].lead.name, 'Solo Paste');
  assert.strictEqual(found[0].at, null);
});

t('24-hour timestamps and dd.mm.yyyy separators', () => {
  const found = parseChat('07.09.2026, 15:54 - Ankush: Webinar registration\nName: Dot Format\nPhone: 9800011133');
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].at, '2026-09-07 10:24:00', 'got ' + found[0].at);
});

t('midnight/noon am-pm conversion', () => {
  // all expressed as UTC, i.e. IST minus 5:30
  assert.strictEqual(toSqlDateTime('07/09/2026', '12:30 am'), '2026-09-06 19:00:00', 'past-midnight IST rolls back a day in UTC');
  assert.strictEqual(toSqlDateTime('07/09/2026', '12:30 pm'), '2026-09-07 07:00:00');
  assert.strictEqual(toSqlDateTime('07/09/26', '9:05 pm'), '2026-09-07 15:35:00');
  assert.strictEqual(toSqlDateTime('01/09/2026', '2:00 am'), '2026-08-31 20:30:00', 'month rollover');
});

t('an export with no leads yields nothing rather than throwing', () => {
  const found = parseChat('07/09/2026, 4:02 pm - Ramesh: Sir?\n07/09/2026, 4:03 pm - Ankush: Ok');
  assert.strictEqual(found.length, 0);
});
// ── regressions from the 2026-09-07 research pass ────────────────────

const BOM = String.fromCharCode(0xFEFF);

t('a BOM at the start of an export does not eat the first message', () => {
  // WhatsApp exports are UTF-8 WITH a BOM; before the fix this returned 0.
  const found = parseChat(BOM + '07/09/2026, 3:54 pm - Ankush: Webinar registration\nName: BOM Export\nPhone: 9812300098');
  assert.strictEqual(found.length, 1, 'the BOM swallowed the first message');
  assert.strictEqual(found[0].lead.name, 'BOM Export');
});

t('an ISO-dated export (yyyy-mm-dd) is understood, not dropped', () => {
  const found = parseChat('2026-09-07, 15:54 - Ankush: Webinar registration\nName: ISO Test\nPhone: 9812300095');
  assert.strictEqual(found.length, 1, 'ISO-dated exports matched nothing at all');
  assert.strictEqual(found[0].at, '2026-09-07 10:24:00', 'the year must not be read as the day; got ' + found[0].at);
});

t('an author-less notice between messages is not glued into the lead above it', () => {
  const found = parseChat([
    '07/09/2026, 3:54 pm - Ankush: Webinar registration',
    'Name: Before System',
    'Phone: 9812300097',
    '08/09/2026, 9:00 am - Ankush changed their phone number',
    '08/09/2026, 9:05 am - Ankush: New sotyn.ai demo request',
    'Name: After System',
    'Phone: 9812300096',
  ].join('\n'));
  assert.strictEqual(found.length, 2, 'expected 2 leads, got ' + found.length);
  assert.ok(!/changed their phone/.test(found[0].body), 'the notice line was glued into the first lead');
  assert.strictEqual(found[1].lead.name, 'After System');
});

t('pasting SEVERAL messages at once yields one lead each, not one merged row', () => {
  // The screen invites pasting messages, and mam pastes more than one. Before the
  // fix this returned a single lead wearing three people's details.
  const found = parseChat([
    'Webinar registration', 'Name: Monika Devi', 'Phone: 919501890918', '',
    'New sotyn.ai demo request', 'Name: Harpreet Sandhu', 'Company: Sandhu Electricals',
    'Phone: 9814556677', 'City: Ludhiana', '',
    'Free checklist request', 'Name: Meera Krishnan', 'Phone: 9880012345',
    'Downloaded: 11-Point Project Savings Checklist',
  ].join('\n'));
  assert.strictEqual(found.length, 3, 'expected 3 separate leads, got ' + found.length);
  assert.strictEqual(found[0].lead.name, 'Monika Devi');
  assert.strictEqual(found[0].lead.company, null, "Monika must not inherit Harpreet's company");
  assert.strictEqual(found[0].lead.city, null, "nor his city");
  assert.strictEqual(found[0].lead.magnet, null, "nor Meera's checklist");
  assert.strictEqual(found[1].lead.company, 'Sandhu Electricals');
  assert.strictEqual(found[2].lead.form_type, 'magnet');
});

t('a huge paste cannot pin the event loop (was quadratic backtracking)', () => {
  // 5 MB is exactly what POST /import accepts. Measured >22 s at 352 KB before
  // the fix, i.e. tens of minutes at the cap, on a synchronous server.
  const payload = 'hi sotynai '.repeat(90000);   // ~1 MB
  const t0 = Date.now();
  parseChat(payload);
  const ms = Date.now() - t0;
  assert.ok(ms < 2000, 'parsing ~1 MB took ' + ms + ' ms — the regex is backtracking again');
});

t('a US-locale export (m/d/yy) is detected, not read as d/m/y', () => {
  // WhatsApp follows the PHONE's locale; 'English (United States)' is common on
  // Indian handsets. 9/20 can only be a month-first date, so the whole file is mdy.
  const found = parseChat([
    '9/7/2026, 11:00 am - Ankush: Webinar registration', 'Name: Sep 7', 'Phone: 9812300011',
    '9/20/2026, 11:00 am - Ankush: New sotyn.ai demo request', 'Name: Sep 20', 'Phone: 9812300012',
  ].join('\n'));
  assert.strictEqual(found.length, 2);
  assert.ok(found[0].at.startsWith('2026-09-07'), 'Sep 7 was read as ' + found[0].at);
  assert.ok(found[1].at.startsWith('2026-09-20'), 'Sep 20 was read as ' + found[1].at);
});

t('an Indian export is still read as d/m/y', () => {
  const found = parseChat([
    '25/12/2026, 11:00 am - Ankush: Webinar registration', 'Name: Dec 25', 'Phone: 9812300013',
    '07/09/2026, 11:00 am - Ankush: New sotyn.ai demo request', 'Name: Sep 7', 'Phone: 9812300014',
  ].join('\n'));
  assert.ok(found[0].at.startsWith('2026-12-25'), 'got ' + found[0].at);
  assert.ok(found[1].at.startsWith('2026-09-07'), 'got ' + found[1].at);
});

t('a sender name containing a colon does not lose the lead', () => {
  // MSG_START stops the sender at the first colon, so 'Sotyn: Leads' left
  // 'Leads: ' glued to the body and the header no longer started line 1.
  const found = parseChat([
    '07/09/2026, 4:10 pm - Sotyn: Leads: New sotyn.ai demo request',
    'Name: Harpreet Sandhu', 'Company: Sandhu Electricals', 'Phone: 9814556677',
  ].join('\n'));
  assert.strictEqual(found.length, 1, 'the lead vanished; got ' + found.length);
  assert.strictEqual(found[0].lead.name, 'Harpreet Sandhu');
});


console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
