// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18).
//
// Mirrors mam's "Cash Flow June-2026.xlsx": an AR grid (expected receipts by
// party × week), an AP grid (expected payments by party × week) and a Summary
// that nets each week's AR − AP into a running balance. Amounts are in LAKHS.
//
// The defining rule (build spec §4/§5): editing an amount or a date is BLOCKED
// until a remark is entered, and every change is written to a readable,
// searchable, exportable change log (old → new, who, when, why). Creating a
// brand-new entry does NOT need a remark.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Idempotent schema — created at module load so the tables exist before any
// handler runs, without touching the central schema.js SQL block.
getDb().exec(`
  CREATE TABLE IF NOT EXISTS arap_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK(kind IN ('AR','AP')),
    party TEXT NOT NULL,
    due_date DATE NOT NULL,
    planned REAL DEFAULT 0,
    actual REAL,
    status TEXT DEFAULT 'planned' CHECK(status IN ('planned','partial','done','cancelled')),
    note TEXT,
    created_by INTEGER,
    created_by_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_arap_kind  ON arap_entries(kind);
  CREATE INDEX IF NOT EXISTS idx_arap_date  ON arap_entries(due_date);
  CREATE INDEX IF NOT EXISTS idx_arap_party ON arap_entries(party);

  CREATE TABLE IF NOT EXISTS arap_changelog (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER,
    kind TEXT,
    party TEXT,
    field TEXT,
    old_value TEXT,
    new_value TEXT,
    remark TEXT NOT NULL,
    changed_by INTEGER,
    changed_by_name TEXT,
    changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_arap_cl_entry ON arap_changelog(entry_id);
  CREATE INDEX IF NOT EXISTS idx_arap_cl_date  ON arap_changelog(changed_at DESC);
`);

// The figure that actually moves cash: the realised actual once it exists,
// else the planned forecast.
const effective = (r) => (r.actual != null && r.actual !== '' ? +r.actual : +r.planned || 0);

const logChange = (db, entry, field, oldV, newV, remark, user) =>
  db.prepare(`INSERT INTO arap_changelog (entry_id, kind, party, field, old_value, new_value, remark, changed_by, changed_by_name)
              VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(entry.id, entry.kind, entry.party, field,
         oldV == null ? '' : String(oldV), newV == null ? '' : String(newV),
         remark, user.id, user.name || '');

// GET list — filter by kind (AR/AP), date range, party, free-text search.
router.get('/', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const { kind, from, to, party, search } = req.query;
  const where = [], args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (from) { where.push('due_date >= ?'); args.push(from); }
  if (to) { where.push('due_date <= ?'); args.push(to); }
  if (party) { where.push('party = ?'); args.push(party); }
  if (search) { where.push('(party LIKE ? OR note LIKE ?)'); args.push(`%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM arap_entries ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY due_date, party`;
  res.json(db.prepare(sql).all(...args));
});

// GET summary — per-date AR total, AP total, net, running balance (Lakhs).
router.get('/summary', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM arap_entries').all();
  const byDate = {};
  for (const r of rows) {
    const d = (byDate[r.due_date] || (byDate[r.due_date] = { date: r.due_date, ar: 0, ap: 0 }));
    if (r.kind === 'AR') d.ar += effective(r); else d.ap += effective(r);
  }
  let bal = 0;
  const out = Object.values(byDate).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map(d => { const net = d.ar - d.ap; bal += net; return { ...d, net: +net.toFixed(2), balance: +bal.toFixed(2) }; });
  const totAR = out.reduce((s, d) => s + d.ar, 0), totAP = out.reduce((s, d) => s + d.ap, 0);
  res.json({ rows: out, totals: { ar: +totAR.toFixed(2), ap: +totAP.toFixed(2), net: +(totAR - totAP).toFixed(2) } });
});

// GET change log — newest first, optional kind + free-text search.
router.get('/changelog', requirePermission('ar_ap_tracker', 'view'), (req, res) => {
  const db = getDb();
  const { kind, search } = req.query;
  const where = [], args = [];
  if (kind) { where.push('kind = ?'); args.push(kind); }
  if (search) { where.push('(party LIKE ? OR remark LIKE ? OR field LIKE ? OR changed_by_name LIKE ?)'); args.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  const sql = `SELECT * FROM arap_changelog ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY changed_at DESC, id DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...args));
});

// POST create — no remark required for a brand-new entry. We still record a
// "created" change-log row so the audit trail is complete.
router.post('/', requirePermission('ar_ap_tracker', 'create'), (req, res) => {
  const db = getDb();
  const { kind, party, due_date, planned, actual, status, note } = req.body;
  if (!['AR', 'AP'].includes(kind)) return res.status(400).json({ error: 'kind must be AR or AP' });
  if (!party || !String(party).trim()) return res.status(400).json({ error: 'Party is required' });
  if (!due_date) return res.status(400).json({ error: 'Date is required' });
  const info = db.prepare(`INSERT INTO arap_entries (kind, party, due_date, planned, actual, status, note, created_by, created_by_name)
                           VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(kind, String(party).trim(), due_date, +planned || 0,
         actual === '' || actual == null ? null : +actual,
         status || 'planned', note || null, req.user.id, req.user.name || '');
  const row = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(info.lastInsertRowid);
  logChange(db, row, 'created', '', `${kind} · ${party} · ${due_date} · ₹${+planned || 0}L`, note || 'New entry', req.user);
  res.json(row);
});

// PUT edit — a change to planned / actual / due_date REQUIRES a remark; each
// changed field is logged individually with that remark.
router.put('/:id', requirePermission('ar_ap_tracker', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { party, due_date, planned, actual, status, note, remark } = req.body;

  // Build the set of real changes vs the current row.
  const next = {
    party: party != null ? String(party).trim() : cur.party,
    due_date: due_date != null ? due_date : cur.due_date,
    planned: planned != null && planned !== '' ? +planned : (planned === '' ? 0 : cur.planned),
    actual: actual === '' || actual == null ? (actual === '' ? null : cur.actual) : +actual,
    status: status != null ? status : cur.status,
    note: note != null ? note : cur.note,
  };
  const numEq = (a, b) => (a == null ? null : +a) === (b == null ? null : +b);
  const changes = [];
  if (next.party !== cur.party) changes.push(['party', cur.party, next.party]);
  if (next.due_date !== cur.due_date) changes.push(['due_date', cur.due_date, next.due_date]);
  if (!numEq(next.planned, cur.planned)) changes.push(['planned', cur.planned, next.planned]);
  if (!numEq(next.actual, cur.actual)) changes.push(['actual', cur.actual, next.actual]);
  if (next.status !== cur.status) changes.push(['status', cur.status, next.status]);
  if ((next.note || '') !== (cur.note || '')) changes.push(['note', cur.note, next.note]);

  if (!changes.length) return res.json(cur); // nothing to do

  // Mandatory-remark gate: any amount or date change needs a reason.
  const sensitive = changes.some(c => ['planned', 'actual', 'due_date'].includes(c[0]));
  if (sensitive && (!remark || String(remark).trim().length < 3)) {
    return res.status(400).json({ error: 'A remark (min 3 chars) is required to change an amount or date.' });
  }

  db.prepare(`UPDATE arap_entries SET party=?, due_date=?, planned=?, actual=?, status=?, note=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(next.party, next.due_date, next.planned, next.actual, next.status, next.note, cur.id);
  const why = (remark && String(remark).trim()) || 'Edited';
  for (const [field, oldV, newV] of changes) logChange(db, cur, field, oldV, newV, why, req.user);
  res.json(db.prepare('SELECT * FROM arap_entries WHERE id=?').get(cur.id));
});

// DELETE — significant, so it also captures a remark into the change log.
router.delete('/:id', requirePermission('ar_ap_tracker', 'delete'), (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM arap_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const remark = req.body?.remark || req.query?.remark;
  if (!remark || String(remark).trim().length < 3) return res.status(400).json({ error: 'A remark (min 3 chars) is required to delete an entry.' });
  logChange(db, cur, 'deleted', `${cur.kind} · ${cur.party} · ${cur.due_date} · ₹${effective(cur)}L`, '', String(remark).trim(), req.user);
  db.prepare('DELETE FROM arap_entries WHERE id=?').run(cur.id);
  res.json({ ok: true });
});

module.exports = router;
