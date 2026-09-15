// Bank statement mailbox poller — the "no upload needed" path.
//
// mam (2026-09-04): "i not need to upload excel automatically it fetech from
// bank direct". True bank-direct fetch needs Account Aggregator (FIU) or a
// corporate bank API, and BOTH are gated on commercial onboarding, not code.
// This gets the same OUTCOME today: PNB One Biz / HDFC can email the statement
// on a schedule, so the ERP watches a mailbox, picks the attachment up and
// runs the exact same import + auto-match as the manual upload.
//
// Deliberately NOT done: scraping netbanking with a stored password. It breaks
// the bank's terms and the Bank page promises no netbanking password is ever
// stored. The only secret here is an IMAP app-password for a mailbox the
// company owns, and it lives in .env — never in the DB, never in the UI.
//
// SAFETY RULE: the account is never guessed. A statement is imported only when
// the account number read out of the file resolves to EXACTLY ONE bank_accounts
// row. Anything ambiguous is left unread and reported, because filing one
// account's transactions against another would corrupt the ledger and every
// reconciliation built on it.
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { persistStatementRows, autoMatch, sheetToRecords, isPdfBuffer } = require('./bankStatementImport');

const ALLOWED_EXT = /\.(csv|xls|xlsx|pdf)$/i;
// Attachment cap. Prod runs node with --max-old-space-size=512 and a
// spreadsheet expands many times over in memory, so oversized files are
// skipped rather than risking the process every user depends on.
const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024;

function mailConfig() {
  const e = process.env;
  return {
    enabled: e.BANK_MAIL_ENABLED === '1',
    host: e.BANK_MAIL_HOST || '',
    port: +(e.BANK_MAIL_PORT || 993),
    secure: e.BANK_MAIL_SECURE !== '0',
    user: e.BANK_MAIL_USER || '',
    pass: e.BANK_MAIL_PASS || '',
    folder: e.BANK_MAIL_FOLDER || 'INBOX',
    processedFolder: e.BANK_MAIL_PROCESSED_FOLDER || '',
    senders: (e.BANK_MAIL_SENDERS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    maxMessages: +(e.BANK_MAIL_MAX_MESSAGES || 20),
  };
}

function isConfigured() {
  const c = mailConfig();
  return !!(c.enabled && c.host && c.user && c.pass);
}

// Persisted so the Import tab can show whether this is actually working —
// a silent background job nobody can see is a job nobody trusts.
function readStatus(db) {
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='bank_mail_status'").get();
    return row && row.value ? JSON.parse(row.value) : null;
  } catch (_) { return null; }
}
function writeStatus(db, status) {
  try {
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('bank_mail_status', ?)")
      .run(JSON.stringify(status));
  } catch (e) { console.error('[bank-mail] could not save status:', e.message); }
}

// Resolve the owning account from the number printed on the statement.
// Returns { account } or { error } — never a guess.
function resolveAccount(db, accountNumber) {
  const accounts = db.prepare('SELECT * FROM bank_accounts').all();
  if (!accountNumber) {
    return { error: 'no account number found in the file — cannot tell which account it belongs to' };
  }
  const hits = accounts.filter(a => {
    const l4 = String(a.account_last4 || '').trim();
    return l4 && String(accountNumber).endsWith(l4);
  });
  if (hits.length === 1) return { account: hits[0] };
  if (hits.length === 0) {
    return { error: `statement is for account ${String(accountNumber).slice(-4)}, which matches no bank account in the ERP` };
  }
  return { error: `account ending ${String(accountNumber).slice(-4)} matches ${hits.length} ERP accounts — ambiguous, left for manual import` };
}

// Turn one attachment into records + the account it belongs to.
async function attachmentToRecords(buf, filename) {
  if (isPdfBuffer(buf) || /\.pdf$/i.test(filename)) {
    const { parsePnbStatementPdf } = require('./pnbPdfStatement');
    const parsed = await parsePnbStatementPdf(buf);
    if (!parsed.rows.length) return { error: 'no transactions found in the PDF (a scanned copy has no text layer to read)' };
    return { records: parsed.rows, accountNumber: parsed.accountNumber, format: 'pdf' };
  }
  const out = sheetToRecords({ buffer: buf });
  if (!out.records) return { error: 'could not find the statement columns in the sheet' };
  if (!out.records.length) return { error: 'sheet parsed but held no transaction rows' };
  return { records: out.records, accountNumber: out.accountNumber, format: 'sheet', badDates: out.badDates };
}

/**
 * Poll the mailbox once and import whatever statements are waiting.
 * Never throws — the cron must survive a bad mailbox or a bad attachment.
 */
async function pollBankMailbox(db) {
  const cfg = mailConfig();
  const startedAt = new Date().toISOString();
  if (!isConfigured()) {
    return { skipped: 'not configured', configured: false };
  }

  const summary = { startedAt, configured: true, messages: 0, imported: 0, added: 0, duplicates: 0, matched: 0, problems: [] };
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
      const uids = await client.search({ seen: false });
      const batch = (uids || []).slice(-cfg.maxMessages);
      for (const uid of batch) {
        let msg;
        try {
          const raw = await client.fetchOne(String(uid), { source: true }, { uid: true });
          if (!raw || !raw.source) continue;
          msg = await simpleParser(raw.source);
        } catch (e) { summary.problems.push(`uid ${uid}: could not read message (${e.message})`); continue; }

        const from = ((msg.from && msg.from.value && msg.from.value[0] && msg.from.value[0].address) || '').toLowerCase();
        if (cfg.senders.length && !cfg.senders.some(s => from.endsWith(s))) continue;   // not a bank mail; leave unread

        const atts = (msg.attachments || []).filter(a => ALLOWED_EXT.test(a.filename || ''));
        if (!atts.length) continue;
        summary.messages++;

        let handledAny = false;
        for (const att of atts) {
          const name = att.filename || 'statement';
          if (!att.content || att.content.length > MAX_ATTACHMENT_BYTES) {
            summary.problems.push(`${name}: larger than ${Math.round(MAX_ATTACHMENT_BYTES / 1024 / 1024)}MB — skipped`);
            continue;
          }
          let parsed;
          try { parsed = await attachmentToRecords(att.content, name); }
          catch (e) { summary.problems.push(`${name}: ${e.message}`); continue; }
          if (parsed.error) { summary.problems.push(`${name}: ${parsed.error}`); continue; }

          const resolved = resolveAccount(db, parsed.accountNumber);
          if (resolved.error) { summary.problems.push(`${name}: ${resolved.error}`); continue; }

          const rows = parsed.records.map(r => ({ ...r, source: 'mail' }));
          const { added, skipped } = persistStatementRows(db, resolved.account.id, rows, null);
          const matched = autoMatch(db, resolved.account.id, null);
          summary.imported++; summary.added += added; summary.duplicates += skipped; summary.matched += matched;
          handledAny = true;
          console.log(`[bank-mail] ${name} -> ${resolved.account.bank_name} ••${resolved.account.account_last4}: +${added} new, ${skipped} dup, ${matched} matched`);
        }

        // Only consume the message once something was actually imported —
        // otherwise leave it unread so the problem stays visible and a fix
        // (e.g. adding the missing account) lets the next run pick it up.
        if (handledAny) {
          try {
            await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
            if (cfg.processedFolder) await client.messageMove(String(uid), cfg.processedFolder, { uid: true });
          } catch (e) { summary.problems.push(`uid ${uid}: imported but could not file the message (${e.message})`); }
        }
      }
    } finally { lock.release(); }
  } catch (e) {
    summary.error = e.message;
    console.error('[bank-mail] poll failed:', e.message);
  } finally {
    try { if (client) await client.logout(); } catch (_) {}
  }

  summary.finishedAt = new Date().toISOString();
  writeStatus(db, summary);
  return summary;
}

module.exports = { pollBankMailbox, isConfigured, mailConfig, readStatus, resolveAccount };
