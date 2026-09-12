// Mail the customer when a site receiving is approved (mam 2026-09-12: "when i
// or crm approve here from customercare@securedengineers.com go mail after
// approve on customer to and cc emails").
//
// WHO GETS IT — the site's Business Book lead carries a customer code, and the
// Customers master holds the addresses mam maintains:
//     To  = Customers → Email ID
//     Cc  = Customers → CC Email   (comma-separated, see lib/emailList)
// A lead with no customer code (or a code with no addresses) falls back to the
// lead's own Client Email ID / Email Address, so an older lead still reaches
// someone. Nothing is invented: if there is no To address the mail is skipped
// and the reason is handed back to the UI.
//
// The mail never blocks the approval — a dead SMTP or a missing address is
// reported, not thrown.

const { cleanEmailList } = require('./emailList');
const { sendEmail } = require('./email');
const storage = require('./storage');

const norm = (s) => String(s || '').trim().toLowerCase();
const esc = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function setting(db, key) {
  try { return db.prepare('SELECT value FROM app_settings WHERE key=?').get(key)?.value || null; }
  catch { return null; }
}

// The From mam asked for. Kept as a setting so it can be changed without a
// deploy — providers reject a From that is not the authenticated mailbox or one
// of its verified aliases, which is a mail-account matter, not a code one.
function customerCareFrom(db) {
  return setting(db, 'email_customercare_from') || 'customercare@securedengineers.com';
}

function recipientsForSite(db, siteName) {
  const site = norm(siteName);
  if (!site) return { to: [], cc: [], source: null, reason: 'the receiving has no site name' };
  const bb = db.prepare(
    `SELECT customer_code, client_email, email_address
       FROM business_book
      WHERE LOWER(TRIM(COALESCE(project_name, ''))) = ?
         OR LOWER(TRIM(COALESCE(company_name, ''))) = ?
         OR LOWER(TRIM(COALESCE(client_name, ''))) = ?
      ORDER BY id DESC LIMIT 1`
  ).get(site, site, site);
  if (!bb) return { to: [], cc: [], source: null, reason: `no Business Book lead matches the site "${siteName}"` };

  if (bb.customer_code) {
    const cust = db.prepare('SELECT email, concern_person_email FROM customers WHERE LOWER(TRIM(COALESCE(customer_code, \'\'))) = ?')
      .get(norm(bb.customer_code));
    if (cust) {
      const to = cleanEmailList(cust.email).list;
      const cc = cleanEmailList(cust.concern_person_email).list;
      if (to.length) return { to, cc, source: `Customers master (${bb.customer_code})`, reason: null };
    }
  }
  const to = cleanEmailList(bb.client_email).list;
  const cc = cleanEmailList(bb.email_address).list;
  if (to.length) return { to, cc, source: 'Business Book lead', reason: null };
  return {
    to: [], cc, source: null,
    reason: bb.customer_code
      ? `customer ${bb.customer_code} has no Email ID, and the lead has none either`
      : 'the lead has no customer code and no Client Email ID',
  };
}

// "/uploads/<file>" → the bytes, read through lib/storage so it works whether
// uploads live on this disk or in S3. Missing file → no attachment, mail still goes.
async function proofAttachment(receivingUrl) {
  const rel = String(receivingUrl || '').trim();
  if (!rel.startsWith('/uploads/')) return null;
  const key = rel.slice('/uploads/'.length);
  try {
    const content = await storage.getObject(key);
    return content ? { filename: key, content } : null;
  } catch (e) {
    console.warn('[receiving-mail] could not read the receiving file:', e.message);
    return null;
  }
}

function body(row, approverName) {
  const line = (label, value) => (value ? `<tr><td style="padding:4px 12px 4px 0;color:#6b7280">${esc(label)}</td><td style="padding:4px 0;font-weight:600">${esc(value)}</td></tr>` : '');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;color:#111827">
  <p>Dear Sir / Madam,</p>
  <p>The material below has been <b>received at site</b> and the receiving is approved. The signed receiving document is attached for your record.</p>
  <table style="border-collapse:collapse;margin:12px 0">
    ${line('Site', row.site_name)}
    ${line('Indent No.', row.indent_number)}
    ${line('Bill No.', row.bill_number)}
    ${line('Approved by', approverName)}
  </table>
  <p>Please reply to this mail if anything does not match your records.</p>
  <p style="margin-top:16px">Regards,<br/>Customer Care<br/><b>Secured Engineers Pvt Ltd</b></p>
</div>`;
  const text = [
    'Dear Sir / Madam,',
    '',
    'The material below has been received at site and the receiving is approved. The signed receiving document is attached for your record.',
    '',
    `Site: ${row.site_name || '-'}`,
    `Indent No.: ${row.indent_number || '-'}`,
    `Bill No.: ${row.bill_number || '-'}`,
    `Approved by: ${approverName || '-'}`,
    '',
    'Please reply to this mail if anything does not match your records.',
    '',
    'Regards,',
    'Customer Care',
    'Secured Engineers Pvt Ltd',
  ].join('\n');
  return { html, text };
}

// → { sent, skipped, to, cc, source, reason }  — never throws.
async function sendReceivingApprovedMail(db, row, approverName) {
  try {
    const { to, cc, source, reason } = recipientsForSite(db, row.site_name);
    if (!to.length) return { sent: false, skipped: true, to: [], cc, reason };
    const { html, text } = body(row, approverName);
    const attachment = await proofAttachment(row.receiving_url);
    const res = await sendEmail({
      from: customerCareFrom(db),
      to: to.join(', '),
      cc: cc.join(', '),
      subject: `Material received at site — ${row.site_name || ''}${row.bill_number ? ` · Bill ${row.bill_number}` : ''}`.trim(),
      html, text,
      attachments: attachment ? [attachment] : [],
    });
    if (res?.skipped) return { sent: false, skipped: true, to, cc, source, reason: res.reason };
    return { sent: true, to, cc, source, attached: !!attachment };
  } catch (e) {
    console.warn('[receiving-mail] failed:', e.message);
    return { sent: false, skipped: true, to: [], cc: [], reason: e.message };
  }
}

module.exports = { sendReceivingApprovedMail, recipientsForSite, customerCareFrom };
