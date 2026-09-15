// BANK module (mam 2026-08-31): "payment received and payment out from bank
// come here — one bank module". Phase 1: statement import (PNB / HDFC CSV or
// Excel, tolerant header detection) + auto-reconciliation — credits matched
// to Collections, debits to Payment Required and Cheques. Phase 2 slots in
// here too: the Account Aggregator sync will write the SAME
// bank_transactions rows with source='aa' once TSP keys exist.
//
// The parsing / persisting / matching engine lives in lib/bankStatementImport.js
// so the mailbox poller (lib/bankStatementMailbox.js) imports emailed
// statements through exactly the same code as this manual upload.
const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { persistStatementRows, autoMatch, sheetToRecords } = require('../lib/bankStatementImport');

router.use(authMiddleware);
const upload = multer({ dest: require('os').tmpdir(), limits: { fileSize: 15 * 1024 * 1024 } });

// ── Accounts ──────────────────────────────────────────────────────────
router.get('/accounts', (req, res) => {
  const db = getDb();
  res.json(db.prepare(`SELECT a.*,
      (SELECT COUNT(*) FROM bank_transactions t WHERE t.bank_account_id=a.id) AS txn_count,
      (SELECT MAX(t.txn_date) FROM bank_transactions t WHERE t.bank_account_id=a.id) AS last_txn_date
    FROM bank_accounts a ORDER BY a.id`).all());
});

router.post('/accounts', requirePermission('cashflow', 'create'), (req, res) => {
  const { bank_name, account_label, account_last4 } = req.body || {};
  if (!bank_name || !String(bank_name).trim()) return res.status(400).json({ error: 'Bank name required' });
  const r = getDb().prepare('INSERT INTO bank_accounts (bank_name, account_label, account_last4, created_by) VALUES (?,?,?,?)')
    .run(String(bank_name).trim(), account_label || null, String(account_last4 || '').slice(-4) || null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// ── Statement import ─────────────────────────────────────────────────
// Header detection, parsing, dedupe/insert and auto-reconciliation all live in
// lib/bankStatementImport.js — shared with the mailbox poller.
// Persist a parsed statement and reconcile it in one step.
const persistAndMatch = (db, accountId, records, userId) => {
  const { added, skipped } = persistStatementRows(db, accountId, records, userId);
  return { added, skipped, matched: autoMatch(db, accountId, userId) };
};

router.post('/import', requirePermission('cashflow', 'create'), upload.single('file'), async (req, res) => {
  try {
    const db = getDb();
    const accountId = +req.body?.bank_account_id;
    const account = accountId && db.prepare('SELECT * FROM bank_accounts WHERE id=?').get(accountId);
    if (!account) {
      return res.status(400).json({ error: 'Pick the bank account first' });
    }
    if (!req.file) return res.status(400).json({ error: 'Attach the statement file (CSV / Excel / PDF)' });

    // ── PDF path (mam 2026-09-04) ────────────────────────────────────
    // PNB One Biz hands out an "OpTransactionHistory" PDF and that is
    // sometimes all that's to hand. Parsed POSITIONALLY — see
    // lib/pnbPdfStatement.js for why the plain-text route is unsafe here.
    const fsMod = require('fs');
    // Sniff the magic bytes rather than trusting the extension — but read only
    // the first 5, not the whole upload.
    const sniff = () => {
      const buf = Buffer.alloc(5);
      let fd;
      try { fd = fsMod.openSync(req.file.path, 'r'); fsMod.readSync(fd, buf, 0, 5, 0); }
      catch { return false } finally { if (fd !== undefined) try { fsMod.closeSync(fd); } catch (_) {} }
      return buf.toString('latin1') === '%PDF-';
    };
    const isPdf = /\.pdf$/i.test(req.file.originalname || '') || sniff();
    if (isPdf) {
      const { parsePnbStatementPdf } = require('../lib/pnbPdfStatement');
      const parsed = await parsePnbStatementPdf(fsMod.readFileSync(req.file.path));
      if (!parsed.rows.length) {
        return res.status(400).json({ error: 'No transactions found in that PDF. It should be the PNB One Biz "Transaction History" statement — a scanned or printed-to-PDF copy has no text layer to read.' });
      }
      // Refuse a statement that belongs to a DIFFERENT account than the one
      // selected — importing another account's lines would silently corrupt
      // this account's ledger and every reconciliation built on it.
      const last4 = String(account.account_last4 || '').trim();
      if (last4 && parsed.accountNumber && !parsed.accountNumber.endsWith(last4)) {
        return res.status(400).json({
          error: `That statement is for account ending ${parsed.accountNumber.slice(-4)}, but you selected ${account.bank_name} ••${last4}. Pick the matching account.`,
        });
      }
      const r = persistAndMatch(db, accountId, parsed.rows, req.user.id);
      return res.json({
        added: r.added, skipped_duplicates: r.skipped, bad_dates: 0, auto_matched: r.matched,
        source_format: 'pdf', parsed_rows: parsed.rows.length, pages: parsed.pages,
        // anchors that carried no amount — reported so a silent drop is visible
        skipped_rows: Math.max(0, parsed.anchors - parsed.rows.length),
      });
    }

    // Spreadsheet path — unchanged behaviour, still reading from the uploaded
    // file PATH (XLSX.readFile) exactly as before the extraction.
    const { records, badDates } = sheetToRecords({ filePath: req.file.path });
    if (!records) {
      return res.status(400).json({ error: 'Could not find the statement columns — the file needs a Date column plus Withdrawal/Debit and Deposit/Credit columns (standard PNB / HDFC export). A PNB One Biz Transaction History PDF also works.' });
    }
    const r = persistAndMatch(db, accountId, records, req.user.id);
    res.json({ added: r.added, skipped_duplicates: r.skipped, bad_dates: badDates, auto_matched: r.matched, source_format: 'sheet' });
  } catch (err) {
    console.error('bank import error', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  } finally {
    try { require('fs').unlinkSync(req.file?.path); } catch (_) {}
  }
});

// ── Auto-reconciliation ───────────────────────────────────────────────
// autoMatch() lives in lib/bankStatementImport.js — shared with the mailbox
// poller so an emailed statement reconciles the same way an uploaded one does.

router.post('/auto-match', requirePermission('cashflow', 'edit'), (req, res) => {
  const db = getDb();
  const accounts = db.prepare('SELECT id FROM bank_accounts').all();
  let total = 0;
  for (const a of accounts) total += autoMatch(db, a.id, req.user.id);
  res.json({ matched: total });
});

// Manual match / unmatch
router.put('/transactions/:id/match', requirePermission('cashflow', 'edit'), (req, res) => {
  const db = getDb();
  const { matched_type, matched_id, note } = req.body || {};
  if (!matched_type) {
    db.prepare('UPDATE bank_transactions SET matched_type=NULL, matched_id=NULL, matched_note=NULL, matched_by=NULL, matched_at=NULL WHERE id=?').run(req.params.id);
    return res.json({ ok: true, unmatched: true });
  }
  db.prepare('UPDATE bank_transactions SET matched_type=?, matched_id=?, matched_note=?, matched_by=?, matched_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(matched_type).slice(0, 20), +matched_id || null, String(note || '').slice(0, 200) || null, req.user.id, req.params.id);
  res.json({ ok: true });
});

// ── Transactions list + summary ──────────────────────────────────────
router.get('/transactions', (req, res) => {
  const db = getDb();
  const page = Math.max(1, parseInt(req.query.page || '1', 10));
  const PER = 50;
  const where = []; const params = [];
  if (+req.query.account_id) { where.push('t.bank_account_id=?'); params.push(+req.query.account_id); }
  if (req.query.status === 'unmatched') where.push('t.matched_type IS NULL');
  if (req.query.status === 'matched') where.push('t.matched_type IS NOT NULL');
  if (req.query.q) { where.push('(LOWER(t.description) LIKE ? OR LOWER(COALESCE(t.ref_no,"")) LIKE ?)'); params.push(`%${String(req.query.q).toLowerCase()}%`, `%${String(req.query.q).toLowerCase()}%`); }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';
  const total = db.prepare(`SELECT COUNT(*) c FROM bank_transactions t ${W}`).get(...params).c;
  const rows = db.prepare(`SELECT t.*, a.bank_name, a.account_label FROM bank_transactions t
    JOIN bank_accounts a ON a.id=t.bank_account_id ${W}
    ORDER BY t.txn_date DESC, t.id DESC LIMIT ${PER} OFFSET ${(page - 1) * PER}`).all(...params);
  res.json({ total, page, per: PER, rows });
});

router.get('/summary', (req, res) => {
  const db = getDb();
  const monthStart = new Date();
  const ms = `${monthStart.getFullYear()}-${String(monthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const g = (q, ...p) => { try { return db.prepare(q).get(...p) || {}; } catch { return {}; } };
  res.json({
    month_in: g('SELECT COALESCE(SUM(credit),0) v FROM bank_transactions WHERE txn_date >= ?', ms).v || 0,
    month_out: g('SELECT COALESCE(SUM(debit),0) v FROM bank_transactions WHERE txn_date >= ?', ms).v || 0,
    unmatched: g('SELECT COUNT(*) v FROM bank_transactions WHERE matched_type IS NULL').v || 0,
    matched: g('SELECT COUNT(*) v FROM bank_transactions WHERE matched_type IS NOT NULL').v || 0,
  });
});

// ── Auto-fetch from the statement mailbox ────────────────────────────
// mam (2026-09-04) wants statements to arrive without uploading. The bank
// emails them; lib/bankStatementMailbox.js collects and imports them on a
// cron. These two endpoints make that visible and testable from the UI —
// a background job nobody can see is a job nobody trusts.
router.get('/mail-status', (req, res) => {
  const { isConfigured, mailConfig, readStatus } = require('../lib/bankStatementMailbox');
  const cfg = mailConfig();
  res.json({
    configured: isConfigured(),
    enabled: cfg.enabled,
    // Never return the password; the mailbox address is enough to identify it.
    mailbox: cfg.user ? cfg.user.replace(/^(.{2}).*(@.*)$/, '$1***$2') : null,
    folder: cfg.folder,
    senders: cfg.senders,
    last_run: readStatus(getDb()),
  });
});

// Run the poll now — so the mailbox can be proved working without waiting
// for the cron. Gated on edit rights, same as the other write operations.
router.post('/mail-poll', requirePermission('cashflow', 'edit'), async (req, res) => {
  try {
    const { pollBankMailbox, isConfigured } = require('../lib/bankStatementMailbox');
    if (!isConfigured()) {
      return res.status(400).json({ error: 'Statement mailbox is not configured yet — set BANK_MAIL_* in the server .env (see .env.example).' });
    }
    res.json(await pollBankMailbox(getDb()));
  } catch (err) {
    console.error('[bank-mail] manual poll failed:', err);
    res.status(500).json({ error: 'Mailbox check failed: ' + err.message });
  }
});

module.exports = router;
