// Facts for the 'receiving.approved' email trigger (mam 2026-09-12: "when i or
// crm approve here from customercare@securedengineers.com go mail after approve
// on customer to and cc emails" — then: "emails triggers i need to do").
//
// This file NEVER sends mail. It resolves who the customer is and reads the
// receiving file, and hands both to the rules engine; the subject, body, From,
// recipients and whether to attach are all set on the rule in Email Triggers.
//
// WHO THE CUSTOMER IS — the receiving's site → its Business Book lead → the
// lead's customer code → Customers master:
//     customer_email     = Customers → Email ID
//     customer_cc_email  = Customers → CC Email   (comma list, see lib/emailList)
// A lead with no customer code (or a code with no address) falls back to the
// lead's own Client Email ID / Email Address. Nothing is invented: with no
// address the context simply carries none and the rule resolves no recipient.

const { cleanEmailList } = require('./emailList');
const storage = require('./storage');

const norm = (s) => String(s || '').trim().toLowerCase();

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

// Context for the 'receiving.approved' email trigger. NOTHING is sent from
// here: the subject, body, recipients, From and whether to attach the file all
// live on the rule mam builds in Admin → Email Triggers (mam 2026-09-12: "this
// is hard code like static u set but emails triggers i need to do"). This only
// hands the rule engine the facts it can use.
async function receivingEventContext(db, row, approver) {
  const { to, cc, source, reason } = recipientsForSite(db, row.site_name);
  const attachment = await proofAttachment(row.receiving_url);
  const recorded = row.created_by
    ? db.prepare('SELECT name, email FROM users WHERE id=?').get(row.created_by)
    : null;
  return {
    // {{vars}} for the subject / body templates
    site: row.site_name || '',
    indent_no: row.indent_number || '',
    bill_no: row.bill_number || '',
    approved_by: approver?.name || '',
    recorded_by: recorded?.name || '',
    date: new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
    // dynamic recipients the rule can tick
    customer_email: to.join(', '),
    customer_cc_email: cc.join(', '),
    recorded_by_email: recorded?.email || '',
    director_email: setting(db, 'email_director_to') || 'director@securedengineers.com',
    // offered to the rule only when it ticks "attach the record's file"
    __attachments: attachment ? [attachment] : [],
    // diagnostics for the UI, never mailed
    __customer_source: source,
    __customer_reason: reason,
  };
}

module.exports = { receivingEventContext, recipientsForSite, customerCareFrom };
