// BANK module (mam 2026-08-31): "payment received and payment out from bank
// come here — one bank module". Phase 1: statement import (PNB / HDFC CSV or
// Excel, tolerant header detection) + auto-reconciliation — credits matched
// to Collections, debits to Payment Required and Cheques. Phase 2 slots in
// here too: the Account Aggregator sync will write the SAME
// bank_transactions rows with source='aa' once TSP keys exist.
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

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

// ── Statement import — tolerant of PNB / HDFC column layouts ─────────
const HEADER_HINTS = {
  date: ['txn date', 'transaction date', 'value date', 'date', 'tran date'],
  description: ['narration', 'description', 'particulars', 'remarks', 'transaction remarks', 'details'],
  ref: ['ref', 'utr', 'cheque', 'chq', 'reference', 'instrument'],
  debit: ['withdrawal', 'debit', 'dr amount', 'dr', 'withdrawal amt'],
  credit: ['deposit', 'credit', 'cr amount', 'cr', 'deposit amt'],
  balance: ['balance', 'closing balance', 'available balance'],
};
const findCol = (headers, hints) => {
  for (const hint of hints) {
    const i = headers.findIndex(h => h.includes(hint));
    if (i >= 0) return i;
  }
  return -1;
};
const parseAmount = (v) => {
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[,₹\s]/g, '').replace(/\((.*)\)/, '-$1'));
  return Number.isFinite(n) ? Math.abs(n) : 0;
};
const parseDate = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  const s = String(v).trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);                       // 2026-08-31
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[-\/](\d{1,2})[-\/](\d{2,4})/);            // 31/08/2026 or 31-08-26 (DD first — Indian banks)
  if (m) {
    const yy = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${yy}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`;
  }
  m = s.match(/^(\d{1,2})[-\s]([A-Za-z]{3})[-\s](\d{2,4})/);        // 31-Aug-2026
  if (m) {
    const months = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };
    const mo = months[m[2].toLowerCase()];
    if (mo) { const yy = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${yy}-${mo}-${String(m[1]).padStart(2, '0')}`; }
  }
  return null;
};

router.post('/import', requirePermission('cashflow', 'create'), upload.single('file'), (req, res) => {
  try {
    const db = getDb();
    const accountId = +req.body?.bank_account_id;
    if (!accountId || !db.prepare('SELECT 1 FROM bank_accounts WHERE id=?').get(accountId)) {
      return res.status(400).json({ error: 'Pick the bank account first' });
    }
    if (!req.file) return res.status(400).json({ error: 'Attach the statement file (CSV / Excel)' });
    const wb = XLSX.readFile(req.file.path, { cellDates: true, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    // Find the header row: the first row matching a date hint AND a debit/credit hint.
    let headRow = -1, cols = null;
    for (let r = 0; r < Math.min(rows.length, 30); r++) {
      const headers = rows[r].map(h => String(h || '').toLowerCase().trim());
      const dc = findCol(headers, HEADER_HINTS.date);
      const dr = findCol(headers, HEADER_HINTS.debit);
      const cr = findCol(headers, HEADER_HINTS.credit);
      if (dc >= 0 && (dr >= 0 || cr >= 0)) {
        headRow = r;
        cols = {
          date: dc, debit: dr, credit: cr,
          description: findCol(headers, HEADER_HINTS.description),
          ref: findCol(headers, HEADER_HINTS.ref),
          balance: findCol(headers, HEADER_HINTS.balance),
        };
        break;
      }
    }
    if (headRow < 0) {
      return res.status(400).json({ error: 'Could not find the statement columns — the file needs a Date column plus Withdrawal/Debit and Deposit/Credit columns (standard PNB / HDFC export).' });
    }
    const ins = db.prepare(`INSERT OR IGNORE INTO bank_transactions
      (bank_account_id, txn_date, description, ref_no, debit, credit, balance, source, dedupe_hash)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    let added = 0, skipped = 0, badDates = 0;
    const tx = db.transaction(() => {
      for (let r = headRow + 1; r < rows.length; r++) {
        const row = rows[r];
        const date = parseDate(row[cols.date]);
        const debit = cols.debit >= 0 ? parseAmount(row[cols.debit]) : 0;
        const credit = cols.credit >= 0 ? parseAmount(row[cols.credit]) : 0;
        if (!date) { if (debit || credit) badDates++; continue; }
        if (!debit && !credit) continue;
        const desc = cols.description >= 0 ? String(row[cols.description] || '').trim().slice(0, 300) : '';
        const ref = cols.ref >= 0 ? String(row[cols.ref] || '').trim().slice(0, 60) : '';
        const bal = cols.balance >= 0 ? (parseAmount(row[cols.balance]) || null) : null;
        const hash = crypto.createHash('sha1').update([accountId, date, desc, ref, debit, credit].join('|')).digest('hex');
        const out = ins.run(accountId, date, desc, ref || null, debit, credit, bal, 'import', hash);
        if (out.changes) added++; else skipped++;
      }
    });
    tx();
    const matched = autoMatch(db, accountId, req.user.id);
    res.json({ added, skipped_duplicates: skipped, bad_dates: badDates, auto_matched: matched });
  } catch (err) {
    console.error('bank import error', err);
    res.status(500).json({ error: 'Import failed: ' + err.message });
  } finally {
    try { require('fs').unlinkSync(req.file?.path); } catch (_) {}
  }
});

// ── Auto-reconciliation ───────────────────────────────────────────────
// Credits → Collections (same amount, date within ±5 days; a transaction_ref
// appearing in the narration seals it). Debits → Payment Required releases
// (same amount, ±7 days) else Cheques (cheque number in the narration, or
// same amount ±10 days). One ERP record matches at most one bank line.
function autoMatch(db, accountId, userId) {
  const unmatched = db.prepare(`SELECT * FROM bank_transactions
    WHERE bank_account_id=? AND matched_type IS NULL ORDER BY txn_date`).all(accountId);
  const usedCollections = new Set(db.prepare("SELECT matched_id id FROM bank_transactions WHERE matched_type='collection'").all().map(r => r.id));
  const usedPayments = new Set(db.prepare("SELECT matched_id id FROM bank_transactions WHERE matched_type='payment'").all().map(r => r.id));
  const usedCheques = new Set(db.prepare("SELECT matched_id id FROM bank_transactions WHERE matched_type='cheque'").all().map(r => r.id));
  const mark = db.prepare(`UPDATE bank_transactions SET matched_type=?, matched_id=?, matched_note=?, matched_by=?, matched_at=CURRENT_TIMESTAMP WHERE id=?`);
  let n = 0;
  for (const t of unmatched) {
    if (+t.credit > 0) {
      const cands = db.prepare(`SELECT id, amount, collection_date, transaction_ref FROM collections
        WHERE ABS(amount - ?) < 0.5 AND ABS(julianday(collection_date) - julianday(?)) <= 5`).all(+t.credit, t.txn_date);
      const pick = cands.find(c => !usedCollections.has(c.id) &&
        (c.transaction_ref && t.description && t.description.toLowerCase().includes(String(c.transaction_ref).toLowerCase())))
        || cands.find(c => !usedCollections.has(c.id));
      if (pick) { mark.run('collection', pick.id, `auto: collection #${pick.id}`, userId, t.id); usedCollections.add(pick.id); n++; }
    } else if (+t.debit > 0) {
      let pick = null;
      try {
        const cands = db.prepare(`SELECT id, request_no FROM payment_requests
          WHERE ABS(amount - ?) < 0.5 AND ABS(julianday(date(created_at)) - julianday(?)) <= 15`).all(+t.debit, t.txn_date);
        pick = cands.find(c => !usedPayments.has(c.id));
      } catch (_) {}
      if (pick) { mark.run('payment', pick.id, `auto: ${pick.request_no || 'payment #' + pick.id}`, userId, t.id); usedPayments.add(pick.id); n++; continue; }
      try {
        const chq = db.prepare(`SELECT id, cheque_number FROM cheques WHERE ABS(amount - ?) < 0.5`).all(+t.debit)
          .find(c => !usedCheques.has(c.id) && c.cheque_number && t.description &&
                     t.description.toLowerCase().includes(String(c.cheque_number).toLowerCase()));
        if (chq) { mark.run('cheque', chq.id, `auto: cheque ${chq.cheque_number}`, userId, t.id); usedCheques.add(chq.id); n++; }
      } catch (_) {}
    }
  }
  return n;
}

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

module.exports = router;
