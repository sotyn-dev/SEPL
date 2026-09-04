// Bank statement import — the one place a statement becomes bank_transactions.
//
// Extracted from routes/bank.js (2026-09-04) so the SAME code serves both
// entry points: the manual upload on the Import tab, and the mailbox poller
// (lib/bankStatementMailbox.js) that fetches statements the bank emails.
// mam: "i not need to upload excel automatically it fetech from bank direct".
//
// Behaviour is deliberately unchanged from the route version — the upload path
// still hands us a file PATH and still goes through XLSX.readFile, so nothing
// about the already-working CSV/Excel import shifts. The mailbox path hands us
// a BUFFER instead and takes XLSX.read.
const crypto = require('crypto');
const XLSX = require('xlsx');

// ── Tolerant header detection (PNB / HDFC layouts) ────────────────────
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
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);              // 31/08/2026 (DD first — Indian banks)
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

// ── Persist ───────────────────────────────────────────────────────────
// `records` are normalised to { date:'YYYY-MM-DD', description, ref, debit, credit, balance }.
function persistStatementRows(db, accountId, records, userId) {
  const ins = db.prepare(`INSERT OR IGNORE INTO bank_transactions
    (bank_account_id, txn_date, description, ref_no, debit, credit, balance, source, dedupe_hash)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  let added = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const r of records) {
      const desc = String(r.description || '').trim().slice(0, 300);
      const ref = String(r.ref || '').trim().slice(0, 60);
      const hash = crypto.createHash('sha1')
        .update([accountId, r.date, desc, ref, r.debit, r.credit].join('|')).digest('hex');
      const out = ins.run(accountId, r.date, desc, ref || null, r.debit, r.credit, r.balance ?? null, r.source || 'import', hash);
      if (out.changes) added++; else skipped++;
    }
  });
  tx();
  return { added, skipped };
}

// ── Auto-reconciliation ───────────────────────────────────────────────
// Credits → Collections (same amount, date within ±5 days; a transaction_ref
// appearing in the narration seals it). Debits → Payment Required releases
// (same amount, ±15 days) else Cheques (cheque number in the narration).
// One ERP record matches at most one bank line.
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

// ── Spreadsheet → records ─────────────────────────────────────────────
// Give it EITHER {filePath} (upload — keeps the original XLSX.readFile
// behaviour exactly) OR {buffer} (mail attachment).
function sheetToRecords({ filePath, buffer }) {
  const wb = filePath
    ? XLSX.readFile(filePath, { cellDates: true, raw: false })
    : XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Header row = first row carrying a date hint AND a debit/credit hint.
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
  if (headRow < 0) return { records: null, badDates: 0 };

  let badDates = 0;
  const records = [];
  for (let r = headRow + 1; r < rows.length; r++) {
    const row = rows[r];
    const date = parseDate(row[cols.date]);
    const debit = cols.debit >= 0 ? parseAmount(row[cols.debit]) : 0;
    const credit = cols.credit >= 0 ? parseAmount(row[cols.credit]) : 0;
    if (!date) { if (debit || credit) badDates++; continue; }
    if (!debit && !credit) continue;
    records.push({
      date, debit, credit,
      description: cols.description >= 0 ? String(row[cols.description] || '') : '',
      ref: cols.ref >= 0 ? String(row[cols.ref] || '') : '',
      balance: cols.balance >= 0 ? (parseAmount(row[cols.balance]) || null) : null,
    });
  }
  // Scan the pre-header block for the account number, so an emailed sheet can
  // be routed to the right account the same way a PDF can.
  let accountNumber = null;
  for (let r = 0; r <= headRow; r++) {
    for (const cell of rows[r] || []) {
      const m = String(cell || '').match(/\b(\d{9,18})\b/);
      if (m) { accountNumber = m[1]; break; }
    }
    if (accountNumber) break;
  }
  return { records, badDates, accountNumber };
}

const isPdfBuffer = (buf) => Buffer.isBuffer(buf) && buf.slice(0, 5).toString('latin1') === '%PDF-';

module.exports = {
  HEADER_HINTS, findCol, parseAmount, parseDate,
  persistStatementRows, autoMatch, sheetToRecords, isPdfBuffer,
};
