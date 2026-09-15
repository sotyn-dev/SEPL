// Bank statement mailbox cron (mam 2026-09-04: "i not need to upload excel
// automatically it fetech from bank direct").
//
// The bank emails the statement on its own schedule; this checks the mailbox
// periodically and imports whatever has arrived, through the same code as a
// manual upload. Statements land in Bank › Transactions with no upload step.
//
// Does nothing at all unless BANK_MAIL_* is configured in .env — an
// unconfigured server just logs once at boot and stays quiet. Skip entirely
// with ERP_DISABLE_BANK_MAIL=1.
const { getDb } = require('../db/schema');

const EVERY_MINUTES = Math.max(15, +(process.env.BANK_MAIL_POLL_MINUTES || 60));

async function runOnce() {
  try {
    const { pollBankMailbox, isConfigured } = require('../lib/bankStatementMailbox');
    if (!isConfigured()) return;
    const r = await pollBankMailbox(getDb());
    if (r.imported) {
      console.log(`[bank-mail] imported ${r.imported} statement(s): +${r.added} new row(s), ${r.duplicates} duplicate(s), ${r.matched} auto-matched`);
    }
    // Problems are worth a line even when nothing imported — this is how a
    // silently-wrong mailbox (bad folder, unknown account) becomes visible.
    for (const p of (r.problems || [])) console.warn('[bank-mail] ' + p);
    if (r.error) console.error('[bank-mail] poll error:', r.error);
  } catch (e) {
    console.error('[bank-mail] run failed:', e.message);
  }
}

function scheduleBankMailCron() {
  if (process.env.ERP_DISABLE_BANK_MAIL === '1') {
    console.log('[bank-mail] disabled via ERP_DISABLE_BANK_MAIL');
    return;
  }
  let configured = false;
  try { configured = require('../lib/bankStatementMailbox').isConfigured(); } catch (_) {}
  if (!configured) {
    console.log('[bank-mail] Scheduler not started: set BANK_MAIL_* in .env to auto-import emailed statements.');
    return;
  }
  // Boot catch-up, then a steady poll. Floor of 15 min so a mistyped env var
  // can't hammer the mail server.
  setTimeout(runOnce, 2 * 60 * 1000);
  setInterval(runOnce, EVERY_MINUTES * 60 * 1000);
  console.log(`[bank-mail] scheduled — first check in 2 min, then every ${EVERY_MINUTES} min`);
}

module.exports = { scheduleBankMailCron, runOnce };
