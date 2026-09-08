// SOTYN LEAD MAILBOX — read website enquiries out of sales@securedengineers.com.
//
// Mam (2026-09-07) "old data also retrive ... do which is best i need data".
//
// Why this exists: every sotyn.ai page links mailto:sales@securedengineers.com, and
// that mailbox is one of only TWO places a historical lead can still be. (I checked
// the rest: the site is static with no database and no API route, there is no Meta
// Pixel actually installed — the code only makes guarded window.fbq calls that never
// fire — and no GA/GTM/Vercel/Clarity/Hotjar. Nothing else recorded anything.)
//
// Same engine and the same safety posture as the bank-statement poller
// (lib/bankStatementMailbox.js): IMAP with an app-password that lives in .env on the
// server, never in the database and never in the UI. Read-only — it does not delete,
// move or mark anything, so it can be run repeatedly against a live mailbox.
//
// It is NOT a cron. It is triggered from the Sotyn Leads screen and returns a
// PREVIEW; nothing is written until a human presses Import. A sales mailbox is full
// of ordinary correspondence, and a scanner that silently turned every email into a
// "lead" would poison the inbox it is meant to fill.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { parseLeadMessage } = require('./whatsappLeadParser');

function mailConfig() {
  const e = process.env;
  return {
    // Falls back to the bank poller's mailbox settings, since it is the same
    // company mailbox host in most setups — but the address/folder can differ.
    enabled: e.SOTYN_MAIL_ENABLED === '1',
    host: e.SOTYN_MAIL_HOST || e.BANK_MAIL_HOST || '',
    port: +(e.SOTYN_MAIL_PORT || e.BANK_MAIL_PORT || 993),
    secure: (e.SOTYN_MAIL_SECURE || e.BANK_MAIL_SECURE) !== '0',
    user: e.SOTYN_MAIL_USER || '',
    pass: e.SOTYN_MAIL_PASS || '',
    folder: e.SOTYN_MAIL_FOLDER || 'INBOX',
    maxMessages: +(e.SOTYN_MAIL_MAX_MESSAGES || 500),
    sinceDays: +(e.SOTYN_MAIL_SINCE_DAYS || 365),
  };
}

function isConfigured() {
  const c = mailConfig();
  return !!(c.enabled && c.host && c.user && c.pass);
}

// What makes an email a website enquiry rather than an invoice or a vendor reply.
// Deliberately strict: a false positive puts a stranger's unrelated email into the
// sales inbox as a "lead", which is worse than missing one we can catch by hand.
const ENQUIRY_HINT = /(sotyn|demo request|free checklist|webinar registration|profit masterclass|11-point|book a demo|30-day pilot|30 day pilot)/i;
// Indian mobile, with or without +91 / 0, tolerating spaces and hyphens.
const PHONE_RE = /(?:\+?91[\s-]?|0)?([6-9]\d{4}[\s-]?\d{5})\b/;

const clean = (v, max = 200) => {
  if (v === undefined || v === null) return null;
  const s = String(v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Turn one parsed email into a lead candidate, or null.
 *
 * Two paths, in order of trust:
 *   1. the email BODY contains one of the site's own message templates (someone
 *      pasted or forwarded it) — reuse the WhatsApp parser, which knows them exactly;
 *   2. otherwise it is a human writing in. Take the sender's name and address, pull a
 *      phone number out of the text if there is one, and keep the subject as the
 *      remark. Only if the mail actually looks like an enquiry.
 */
function emailToLead(msg) {
  const text = clean(msg.text || msg.subject || '', 20000) || '';
  const subject = clean(msg.subject, 300);
  const fromAddr = clean(((msg.from && msg.from.value && msg.from.value[0] && msg.from.value[0].address) || ''), 160);
  const fromName = clean(((msg.from && msg.from.value && msg.from.value[0] && msg.from.value[0].name) || ''), 120);

  const templated = parseLeadMessage(msg.text || '');
  if (templated) {
    return {
      ...templated,
      email: templated.email || fromAddr,
      name: templated.name || fromName || fromAddr,
      _why: 'the site’s own message text was in the email',
    };
  }

  const haystack = `${subject || ''} ${text}`;
  if (!ENQUIRY_HINT.test(haystack)) return null;

  const pm = haystack.match(PHONE_RE);
  return {
    form_type: 'demo',
    name: fromName || (fromAddr ? fromAddr.split('@')[0] : null),
    company: null,
    phone: pm ? clean(pm[0], 40) : null,
    email: fromAddr,
    city: null, trade: null, team: null, turnover: null, event: null, magnet: null,
    bare: false,
    _why: `email to sales@ mentioning ${(haystack.match(ENQUIRY_HINT) || [''])[0]}`,
    _subject: subject,
  };
}

/**
 * Read the mailbox and return lead CANDIDATES. Never throws — a bad mailbox or one
 * unreadable message must not take the screen down; problems are reported instead.
 *
 * Returns { configured, candidates: [{ lead, at, sender, body }], scanned, problems }
 * in the same shape parseChat() produces, so the import path is identical.
 */
async function scanLeadMailbox() {
  const cfg = mailConfig();
  if (!isConfigured()) {
    return {
      configured: false,
      candidates: [],
      scanned: 0,
      problems: ['Mailbox not configured. Set SOTYN_MAIL_ENABLED=1, SOTYN_MAIL_HOST, SOTYN_MAIL_USER and SOTYN_MAIL_PASS (an app password) in .env on the server, then restart.'],
    };
  }

  const out = { configured: true, candidates: [], scanned: 0, problems: [] };
  let client;
  try {
    client = new ImapFlow({
      host: cfg.host, port: cfg.port, secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
    });
    await client.connect();
    const lock = await client.getMailboxLock(cfg.folder);
    try {
      const since = new Date(Date.now() - cfg.sinceDays * 86400000);
      const uids = await client.search({ since });
      // Newest first, capped — a mailbox with years of history must not be read
      // wholesale into a 512 MB node process.
      const batch = (uids || []).slice(-cfg.maxMessages);
      for (const uid of batch) {
        let msg;
        try {
          const raw = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!raw || !raw.source) continue;
          msg = await simpleParser(raw.source);
        } catch (e) { out.problems.push(`message ${uid}: ${e.message}`); continue; }

        out.scanned++;
        let lead;
        try { lead = emailToLead(msg); } catch (e) { out.problems.push(`message ${uid}: ${e.message}`); continue; }
        if (!lead) continue;

        const at = msg.date instanceof Date && !Number.isNaN(msg.date.getTime())
          ? msg.date.toISOString().slice(0, 19).replace('T', ' ')   // already UTC
          : null;

        out.candidates.push({
          lead,
          at,
          sender: clean(((msg.from && msg.from.value && msg.from.value[0] && msg.from.value[0].address) || ''), 160),
          body: clean(`${msg.subject || ''}\n\n${msg.text || ''}`, 4000),
        });
      }
    } finally { lock.release(); }
  } catch (e) {
    out.problems.push(`Could not read the mailbox: ${e.message}`);
  } finally {
    try { if (client) await client.logout(); } catch { /* closing must never fail the scan */ }
  }
  return out;
}

module.exports = { scanLeadMailbox, isConfigured, mailConfig, emailToLead };
