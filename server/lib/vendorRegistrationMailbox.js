// VENDOR REGISTRATION MAILBOX SCANNER & MATCHER
// Scans SOTYN's designated vendor registration mailbox via IMAP (using imapflow & mailparser).
// Idempotent and safe: read-only against the mailbox.
// Automatically matches incoming portal emails against pending vendor registrations.

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { getDb } = require('../db/schema');

function getSettings() {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM vendor_registration_settings').all();
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return map;
}

function getMailConfig() {
  const s = getSettings();
  const e = process.env;

  const host = s.email_imap_host || e.VENDOR_MAIL_HOST || e.SOTYN_MAIL_HOST || e.BANK_MAIL_HOST || '';
  const port = +(s.email_imap_port || e.VENDOR_MAIL_PORT || e.SOTYN_MAIL_PORT || 993);
  const secure = (s.email_imap_secure || e.VENDOR_MAIL_SECURE || '1') !== '0';
  const user = s.email_imap_user || e.VENDOR_MAIL_USER || e.SOTYN_MAIL_USER || '';
  const pass = s.email_imap_pass || e.VENDOR_MAIL_PASS || e.SOTYN_MAIL_PASS || '';
  const folder = s.email_imap_folder || 'INBOX';
  const lookbackDays = +(s.email_lookback_days || 30);

  return {
    host,
    port,
    secure,
    user,
    pass,
    folder,
    lookbackDays,
    configured: !!(host && user && pass),
  };
}

/**
 * Classify email intent into categories:
 * 'otp' | 'credentials' | 'activation' | 'additional_info' | 'confirmation' | 'rejection' | 'general'
 */
function classifyEmailType(subject = '', body = '') {
  const text = `${subject} ${body}`.toLowerCase();

  if (/\b(otp|one time password|verification code|verification pin|verify your email)\b/i.test(text)) {
    return 'otp';
  }
  if (/\b(vendor id|vendor code|supplier id|supplier code|login credentials|temporary password|account details|password has been set|user id:)\b/i.test(text)) {
    return 'credentials';
  }
  if (/\b(activate your account|activation link|confirm your registration|account activation|click here to activate)\b/i.test(text)) {
    return 'activation';
  }
  if (/\b(rejected|rejection|not approved|disapproved|criteria not met|cannot be processed)\b/i.test(text)) {
    return 'rejection';
  }
  if (/\b(additional document|missing document|clarification|query raised|upload revised|resubmit|pending documents)\b/i.test(text)) {
    return 'additional_info';
  }
  if (/\b(registration submitted|acknowledgement|reference number|application number|received your application|successfully registered|empanelment application)\b/i.test(text)) {
    return 'confirmation';
  }
  return 'general';
}

/**
 * Extract root domain from an email or URL (e.g. 'ril.com' from 'vendor@ril.com' or 'scm.ril.com')
 */
function extractRootDomain(str = '') {
  if (!str) return '';
  const cleanStr = str.toLowerCase().replace(/^(https?:\/\/)?(www\.)?/, '').split('/')[0];
  const parts = cleanStr.split('@').pop().split('.');
  if (parts.length >= 2) {
    return parts.slice(-2).join('.');
  }
  return cleanStr;
}

/**
 * Match parsed email with an existing vendor_registrations record
 */
function findMatchingRegistration(db, { fromAddress, subject = '', body = '' }) {
  const registrations = db.prepare(`
    SELECT id, company_name, portal_url, application_number, registered_email, status
    FROM vendor_registrations
    WHERE status NOT IN ('rejected')
  `).all();

  const senderDomain = extractRootDomain(fromAddress);

  // 1. Try matching by application_number in subject or body
  for (const reg of registrations) {
    if (reg.application_number && reg.application_number.length >= 4) {
      if (subject.includes(reg.application_number) || body.includes(reg.application_number)) {
        return { match: reg, matchedBy: 'app_number' };
      }
    }
  }

  // 2. Try matching by company portal domain
  if (senderDomain && senderDomain.length > 3) {
    for (const reg of registrations) {
      const portalDomain = extractRootDomain(reg.portal_url);
      if (portalDomain && (portalDomain === senderDomain || senderDomain.endsWith(portalDomain) || portalDomain.endsWith(senderDomain))) {
        return { match: reg, matchedBy: 'domain' };
      }
    }
  }

  // 3. Try matching by exact company name in subject
  for (const reg of registrations) {
    if (reg.company_name && reg.company_name.length > 3) {
      const regPattern = new RegExp(`\\b${reg.company_name.trim().replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&')}\\b`, 'i');
      if (regPattern.test(subject)) {
        return { match: reg, matchedBy: 'company_name' };
      }
    }
  }

  return { match: null, matchedBy: null };
}

/**
 * Scan mailbox and match emails to registrations
 */
async function scanAndSyncVendorEmails() {
  const cfg = getMailConfig();
  if (!cfg.configured) {
    return {
      configured: false,
      scanned: 0,
      matched: 0,
      message: 'IMAP mailbox credentials are not configured. Please enter them in Vendor Registration Settings.',
    };
  }

  const db = getDb();
  let client;
  let scannedCount = 0;
  let matchedCount = 0;

  try {
    client = new ImapFlow({
      host: cfg.host,
      port: cfg.port,
      secure: cfg.secure,
      auth: { user: cfg.user, pass: cfg.pass },
      logger: false,
    });

    await client.connect();
    const lock = await client.getMailboxLock(cfg.folder);

    try {
      const sinceDate = new Date(Date.now() - cfg.lookbackDays * 86400000);
      const uids = await client.search({ since: sinceDate });
      const recentUids = (uids || []).slice(-200); // capped to avoid VPS memory spikes

      for (const uid of recentUids) {
        scannedCount++;
        try {
          const raw = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!raw || !raw.source) continue;

          const parsed = await simpleParser(raw.source);
          const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
          const fromName = parsed.from?.value?.[0]?.name || '';
          const subject = parsed.subject || '';
          const bodyText = (parsed.text || parsed.html || '').slice(0, 5000);
          const receivedDate = parsed.date ? new Date(parsed.date).toISOString() : new Date().toISOString();

          // Check if already processed
          const exists = db.prepare('SELECT id FROM vendor_registration_emails WHERE sender=? AND subject=? AND received_at=?').get(fromAddr, subject, receivedDate);
          if (exists) continue;

          // Check relevance
          const isVendorRelated = /(vendor|supplier|registration|empanelment|procurement|portal|credential|onboard|scm|ariba|coupa)/i.test(subject + ' ' + bodyText);
          if (!isVendorRelated) continue;

          const emailType = classifyEmailType(subject, bodyText);
          const { match, matchedBy } = findMatchingRegistration(db, { fromAddress: fromAddr, subject, body: bodyText });

          const snippet = (parsed.text || '').replace(/\s+/g, ' ').trim().slice(0, 300);

          db.prepare(`
            INSERT INTO vendor_registration_emails (
              registration_id, company_name, matched_by, sender, sender_name,
              subject, email_type, body_snippet, has_attachments, received_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            match ? match.id : null,
            match ? match.company_name : null,
            matchedBy || 'keyword_filter',
            fromAddr,
            fromName,
            subject,
            emailType,
            snippet,
            (parsed.attachments && parsed.attachments.length > 0) ? 1 : 0,
            receivedDate
          );

          if (match) {
            matchedCount++;
            // If email is credentials or activation or query, update registration timeline
            let historyNote = `Email received from ${fromAddr}: "${subject}" (Classified: ${emailType})`;
            db.prepare(`
              INSERT INTO vendor_registration_history (registration_id, stage, action, notes, performed_by_name)
              VALUES (?, ?, 'Email Received', ?, 'Automated Mail Scanner')
            `).run(match.id, match.status, historyNote);

            // Auto-advance status if matching criteria are high confidence
            if (emailType === 'credentials' && match.status === 'awaiting_credentials') {
              db.prepare("UPDATE vendor_registrations SET credential_notes = COALESCE(credential_notes || ' | ', '') || 'Credentials email detected on ' || date('now'), updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(match.id);
            } else if (emailType === 'additional_info') {
              db.prepare("UPDATE vendor_registrations SET status = 'additional_info_required', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(match.id);
            } else if (emailType === 'activation') {
              db.prepare("UPDATE vendor_registrations SET status = 'activation_pending', updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(match.id);
            }
          }
        } catch (msgErr) {
          console.warn('[vendorRegistrationMailbox] error parsing message:', msgErr.message);
        }
      }
    } finally {
      lock.release();
    }

    await client.logout();
    return {
      configured: true,
      scanned: scannedCount,
      matched: matchedCount,
      message: `Scanned ${scannedCount} emails. Found and linked ${matchedCount} matching vendor updates.`,
    };
  } catch (err) {
    console.error('[vendorRegistrationMailbox] connection error:', err);
    return {
      configured: true,
      scanned: scannedCount,
      matched: matchedCount,
      error: err.message,
    };
  }
}

module.exports = {
  getMailConfig,
  scanAndSyncVendorEmails,
  classifyEmailType,
};

