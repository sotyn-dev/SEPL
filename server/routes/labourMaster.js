// Labour Management System — Module 3: Labour Master.
//
// Individual worker roster (ID/name/mobile/Aadhaar/trade/daily wage),
// daily attendance, site-to-site transfers, and daily site progress.
// The Wage Register is a REPORT computed from labour_master + labour_attendance
// (days present × daily_wage + overtime), not a separately-maintained table —
// same "derive, don't duplicate" principle as the Labour Rate Master's reports.
//
// Follows labourRateMaster.js's asymmetric access pattern: roster edits are
// HR/Admin only, but attendance/transfer/progress are day-to-day site data
// entry, so 'create' on this module covers both — granted per role in
// Admin → Roles & Permissions, not hardcoded to a job title.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');

const router = express.Router();
router.use(authMiddleware);

const MODULE = 'labour_master';
const canCreate = requirePermission(MODULE, 'create');
const canEdit = requirePermission(MODULE, 'edit');
const canDelete = requirePermission(MODULE, 'delete');

// Same broad-read rationale as labourRateMaster.js's canRead: attendance and
// the roster are things a site engineer needs to see just by virtue of
// working on Work Orders, not something that needs its own explicit grant.
function canRead(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const row = getDb().prepare(`
    SELECT MAX(rp.can_view) AS ok
      FROM role_permissions rp
      JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ?
       AND rp.module IN (?, 'indent_labour_payment', 'labour_quotation', 'labour_rate_master')
  `).get(req.user.id, MODULE);
  if (row?.ok) return next();
  return res.status(403).json({ error: 'No access to labour master' });
}

const str = (v) => { const t = String(v ?? '').trim(); return t || null; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// ─── Labour Master (roster) ─────────────────────────────────────────────
const MANPOWER_TYPES = ['contractor_manpower', 'sepl_team', 'daily_wages_team'];
const LM_COLS = `lm.id, lm.labour_code, lm.name, lm.mobile, lm.aadhaar_number, lm.trade,
  lm.department, lm.manpower_type, lm.document_url, lm.daily_wage, lm.site_id, s.name AS site_name, lm.status, lm.remarks,
  lm.created_by, lm.created_by_name, lm.created_at, lm.updated_at`;

router.get('/', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  for (const [key, col] of [['status', 'lm.status'], ['trade', 'lm.trade'],
    ['department', 'lm.department'], ['site_id', 'lm.site_id'], ['manpower_type', 'lm.manpower_type']]) {
    if (q[key]) { where.push(`${col} = ?`); args.push(q[key]); }
  }
  if (q.search) {
    where.push(`(lm.name LIKE ? OR lm.labour_code LIKE ? OR lm.mobile LIKE ? OR lm.trade LIKE ?)`);
    const like = `%${q.search}%`;
    args.push(like, like, like, like);
  }
  res.json(getDb().prepare(`
    SELECT ${LM_COLS} FROM labour_master lm
    LEFT JOIN sites s ON s.id = lm.site_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY lm.status ASC, lm.name ASC`).all(...args));
});

router.post('/', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!str(b.name)) return res.status(400).json({ error: 'Name is required' });
  if (num(b.daily_wage, -1) < 0) return res.status(400).json({ error: 'Daily wage must be zero or more' });
  if (b.manpower_type && !MANPOWER_TYPES.includes(b.manpower_type)) {
    return res.status(400).json({ error: `Type of Manpower must be one of ${MANPOWER_TYPES.join(', ')}` });
  }

  const code = str(b.labour_code) || nextSequence(db, 'labour_master', 'labour_code', 'LAB', { pad: 4 });
  const info = db.prepare(`
    INSERT INTO labour_master
      (labour_code, name, mobile, aadhaar_number, trade, department, manpower_type, document_url, daily_wage,
       site_id, status, remarks, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    code, str(b.name), str(b.mobile), str(b.aadhaar_number), str(b.trade), str(b.department),
    str(b.manpower_type), str(b.document_url), num(b.daily_wage), b.site_id || null, b.status === 'inactive' ? 'inactive' : 'active',
    str(b.remarks), req.user.id, req.user.name || null);

  const after = db.prepare(`SELECT ${LM_COLS} FROM labour_master lm LEFT JOIN sites s ON s.id=lm.site_id WHERE lm.id=?`).get(info.lastInsertRowid);
  logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'labour_master',
    entity_id: after.id, entity_label: `${after.labour_code} — ${after.name}`, before: null, after });
  res.status(201).json(after);
});

router.put('/:id', canEdit, (req, res) => {
  const db = getDb();
  const before = db.prepare('SELECT * FROM labour_master WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Labour record not found' });
  const b = req.body || {};
  if (b.name !== undefined && !str(b.name)) return res.status(400).json({ error: 'Name is required' });
  if (b.daily_wage !== undefined && num(b.daily_wage, -1) < 0) return res.status(400).json({ error: 'Daily wage must be zero or more' });
  if (b.manpower_type && !MANPOWER_TYPES.includes(b.manpower_type)) {
    return res.status(400).json({ error: `Type of Manpower must be one of ${MANPOWER_TYPES.join(', ')}` });
  }

  db.prepare(`
    UPDATE labour_master SET
      name = COALESCE(?, name), mobile = ?, aadhaar_number = ?, trade = ?, department = ?,
      manpower_type = ?, document_url = ?, daily_wage = COALESCE(?, daily_wage), site_id = ?, status = COALESCE(?, status),
      remarks = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(
    str(b.name), b.mobile !== undefined ? str(b.mobile) : before.mobile,
    b.aadhaar_number !== undefined ? str(b.aadhaar_number) : before.aadhaar_number,
    b.trade !== undefined ? str(b.trade) : before.trade,
    b.department !== undefined ? str(b.department) : before.department,
    b.manpower_type !== undefined ? str(b.manpower_type) : before.manpower_type,
    b.document_url !== undefined ? str(b.document_url) : before.document_url,
    b.daily_wage != null ? num(b.daily_wage) : null,
    b.site_id !== undefined ? (b.site_id || null) : before.site_id,
    b.status || null,
    b.remarks !== undefined ? str(b.remarks) : before.remarks,
    req.params.id);

  const after = db.prepare(`SELECT ${LM_COLS} FROM labour_master lm LEFT JOIN sites s ON s.id=lm.site_id WHERE lm.id=?`).get(req.params.id);
  logAuditEvent({ user: req.user, action: 'UPDATE', entity_type: 'labour_master',
    entity_id: after.id, entity_label: `${after.labour_code} — ${after.name}`, before, after });
  res.json(after);
});

router.delete('/:id', canDelete, (req, res) => {
  const db = getDb();
  const before = db.prepare('SELECT * FROM labour_master WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Labour record not found' });

  const used = db.prepare('SELECT COUNT(*) c FROM labour_attendance WHERE labour_id=?').get(req.params.id).c;
  if (used > 0) {
    return res.status(409).json({
      error: `This worker has ${used} attendance record(s). Set status to Inactive instead — deleting would break the wage register history.`,
      used_count: used,
    });
  }
  db.prepare('DELETE FROM labour_master WHERE id=?').run(req.params.id);
  logAuditEvent({ user: req.user, action: 'DELETE', entity_type: 'labour_master',
    entity_id: before.id, entity_label: `${before.labour_code} — ${before.name}`, before, after: null });
  res.json({ message: 'Labour record deleted' });
});

// ─── Attendance ──────────────────────────────────────────────────────────
// One row per worker per day — POST upserts (create-or-correct), matching
// the UNIQUE(labour_id, date) index so a re-submit edits rather than
// duplicates.
router.get('/attendance/list', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.site_id) { where.push('a.site_id = ?'); args.push(q.site_id); }
  if (q.labour_id) { where.push('a.labour_id = ?'); args.push(q.labour_id); }
  if (q.from) { where.push('a.date >= ?'); args.push(q.from); }
  if (q.to) { where.push('a.date <= ?'); args.push(q.to); }
  if (!q.from && !q.to && !q.date) { where.push(`a.date = DATE('now','localtime')`); }
  if (q.date) { where.push('a.date = ?'); args.push(q.date); }
  res.json(getDb().prepare(`
    SELECT a.*, lm.labour_code, lm.name AS labour_name, lm.trade, lm.daily_wage, s.name AS site_name
      FROM labour_attendance a
      JOIN labour_master lm ON lm.id = a.labour_id
      LEFT JOIN sites s ON s.id = a.site_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY a.date DESC, lm.name ASC`).all(...args));
});

router.post('/attendance', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.labour_id) return res.status(400).json({ error: 'labour_id is required' });
  if (!str(b.date)) return res.status(400).json({ error: 'date is required' });
  const worker = db.prepare('SELECT id, site_id FROM labour_master WHERE id=?').get(b.labour_id);
  if (!worker) return res.status(404).json({ error: 'Labour record not found' });

  const status = ['present', 'absent', 'half_day'].includes(b.status) ? b.status : 'present';
  const siteId = b.site_id || worker.site_id || null;

  db.prepare(`
    INSERT INTO labour_attendance (labour_id, site_id, work_order_id, date, status, overtime_hours, remarks, recorded_by, recorded_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(labour_id, date) DO UPDATE SET
      site_id=excluded.site_id, work_order_id=excluded.work_order_id, status=excluded.status,
      overtime_hours=excluded.overtime_hours, remarks=excluded.remarks,
      recorded_by=excluded.recorded_by, recorded_by_name=excluded.recorded_by_name`).run(
    b.labour_id, siteId, b.work_order_id || null, b.date, status,
    num(b.overtime_hours, 0), str(b.remarks), req.user.id, req.user.name || null);

  const row = db.prepare('SELECT * FROM labour_attendance WHERE labour_id=? AND date=?').get(b.labour_id, b.date);
  res.status(201).json(row);
});

// Bulk mark — a whole site's crew for one day in one call, since that's
// how attendance is actually taken (a muster roll, not one row at a time).
router.post('/attendance/bulk', canCreate, (req, res) => {
  const db = getDb();
  const { date, site_id, entries } = req.body || {};
  if (!str(date)) return res.status(400).json({ error: 'date is required' });
  if (!Array.isArray(entries) || !entries.length) return res.status(400).json({ error: 'entries[] is required' });

  const upsert = db.prepare(`
    INSERT INTO labour_attendance (labour_id, site_id, work_order_id, date, status, overtime_hours, remarks, recorded_by, recorded_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)
    ON CONFLICT(labour_id, date) DO UPDATE SET
      site_id=excluded.site_id, work_order_id=excluded.work_order_id, status=excluded.status,
      overtime_hours=excluded.overtime_hours, remarks=excluded.remarks,
      recorded_by=excluded.recorded_by, recorded_by_name=excluded.recorded_by_name`);
  const tx = db.transaction((rows) => {
    for (const e of rows) {
      if (!e.labour_id) continue;
      upsert.run(e.labour_id, e.site_id || site_id || null, e.work_order_id || null, date,
        ['present', 'absent', 'half_day'].includes(e.status) ? e.status : 'present',
        num(e.overtime_hours, 0), str(e.remarks), req.user.id, req.user.name || null);
    }
  });
  tx(entries);
  res.json({ ok: true, count: entries.length });
});

// ─── Transfers ───────────────────────────────────────────────────────────
router.get('/transfers', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.labour_id) { where.push('t.labour_id = ?'); args.push(q.labour_id); }
  res.json(getDb().prepare(`
    SELECT t.*, lm.labour_code, lm.name AS labour_name,
           fs.name AS from_site_name, ts.name AS to_site_name
      FROM labour_transfers t
      JOIN labour_master lm ON lm.id = t.labour_id
      LEFT JOIN sites fs ON fs.id = t.from_site_id
      LEFT JOIN sites ts ON ts.id = t.to_site_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY t.transfer_date DESC, t.id DESC LIMIT 500`).all(...args));
});

router.post('/transfers', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.labour_id) return res.status(400).json({ error: 'labour_id is required' });
  if (!b.to_site_id) return res.status(400).json({ error: 'to_site_id is required' });
  if (!str(b.transfer_date)) return res.status(400).json({ error: 'transfer_date is required' });

  const worker = db.prepare('SELECT * FROM labour_master WHERE id=?').get(b.labour_id);
  if (!worker) return res.status(404).json({ error: 'Labour record not found' });

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO labour_transfers (labour_id, from_site_id, to_site_id, transfer_date, reason, transferred_by, transferred_by_name)
      VALUES (?,?,?,?,?,?,?)`).run(
      b.labour_id, worker.site_id || null, b.to_site_id, b.transfer_date, str(b.reason),
      req.user.id, req.user.name || null);
    db.prepare('UPDATE labour_master SET site_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.to_site_id, b.labour_id);
  });
  tx();

  logAuditEvent({ user: req.user, action: 'TRANSFER', entity_type: 'labour_master',
    entity_id: worker.id, entity_label: `${worker.labour_code} — ${worker.name}`,
    before: { site_id: worker.site_id }, after: { site_id: b.to_site_id } });
  res.status(201).json({ ok: true });
});

// ─── Wage register (report, not a table) ──────────────────────────────────
// days_present + half-days at 0.5 + overtime_hours × (daily_wage / 8) —
// standard 8-hour-day OT rate, since the spec doesn't define a separate
// overtime rate per worker (unlike the crew-level labour_rate_master, which
// does carry its own overtime_rate).
router.get('/wage-register', canRead, (req, res) => {
  const q = req.query || {};
  const where = ['1=1'];
  const args = [];
  if (q.from) { where.push('a.date >= ?'); args.push(q.from); }
  if (q.to) { where.push('a.date <= ?'); args.push(q.to); }
  if (q.site_id) { where.push('a.site_id = ?'); args.push(q.site_id); }
  if (q.labour_id) { where.push('a.labour_id = ?'); args.push(q.labour_id); }

  const rows = getDb().prepare(`
    SELECT lm.id AS labour_id, lm.labour_code, lm.name, lm.trade, lm.daily_wage,
           SUM(CASE WHEN a.status='present' THEN 1 WHEN a.status='half_day' THEN 0.5 ELSE 0 END) AS days_present,
           SUM(CASE WHEN a.status='absent' THEN 1 ELSE 0 END) AS days_absent,
           COALESCE(SUM(a.overtime_hours), 0) AS overtime_hours
      FROM labour_attendance a
      JOIN labour_master lm ON lm.id = a.labour_id
     WHERE ${where.join(' AND ')}
     GROUP BY lm.id
     ORDER BY lm.name`).all(...args);

  const out = rows.map(r => {
    const wage_due = r.days_present * r.daily_wage;
    const overtime_due = r.overtime_hours * (r.daily_wage / 8);
    return { ...r, wage_due, overtime_due, total_due: wage_due + overtime_due };
  });
  res.json({ rows: out, total_due: out.reduce((s, r) => s + r.total_due, 0) });
});

// ─── Daily progress ────────────────────────────────────────────────────
router.get('/daily-progress', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.site_id) { where.push('p.site_id = ?'); args.push(q.site_id); }
  if (q.from) { where.push('p.date >= ?'); args.push(q.from); }
  if (q.to) { where.push('p.date <= ?'); args.push(q.to); }
  res.json(getDb().prepare(`
    SELECT p.*, s.name AS site_name
      FROM labour_daily_progress p
      LEFT JOIN sites s ON s.id = p.site_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY p.date DESC LIMIT 500`).all(...args));
});

router.post('/daily-progress', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.site_id) return res.status(400).json({ error: 'site_id is required' });
  if (!str(b.date)) return res.status(400).json({ error: 'date is required' });

  db.prepare(`
    INSERT INTO labour_daily_progress (site_id, work_order_id, date, labourers_present, progress_notes, progress_pct, recorded_by, recorded_by_name)
    VALUES (?,?,?,?,?,?,?,?)
    ON CONFLICT(site_id, date) DO UPDATE SET
      work_order_id=excluded.work_order_id, labourers_present=excluded.labourers_present,
      progress_notes=excluded.progress_notes, progress_pct=excluded.progress_pct,
      recorded_by=excluded.recorded_by, recorded_by_name=excluded.recorded_by_name`).run(
    b.site_id, b.work_order_id || null, b.date, num(b.labourers_present, 0),
    str(b.progress_notes), b.progress_pct != null ? num(b.progress_pct) : null,
    req.user.id, req.user.name || null);

  const row = db.prepare('SELECT * FROM labour_daily_progress WHERE site_id=? AND date=?').get(b.site_id, b.date);
  res.status(201).json(row);
});

// ─── Dashboard ────────────────────────────────────────────────────────
router.get('/reports/dashboard', canRead, (req, res) => {
  const db = getDb();
  const one = (sql, ...args) => db.prepare(sql).get(...args);
  res.json({
    cards: {
      active_workers: one(`SELECT COUNT(*) c FROM labour_master WHERE status='active'`).c,
      present_today: one(`SELECT COUNT(*) c FROM labour_attendance WHERE date=DATE('now','localtime') AND status='present'`).c,
      absent_today: one(`SELECT COUNT(*) c FROM labour_attendance WHERE date=DATE('now','localtime') AND status='absent'`).c,
      transfers_this_month: one(`SELECT COUNT(*) c FROM labour_transfers WHERE strftime('%Y-%m', transfer_date) = strftime('%Y-%m','now','localtime')`).c,
    },
    by_trade: db.prepare(`SELECT COALESCE(NULLIF(TRIM(trade),''),'(none)') AS name, COUNT(*) AS workers
      FROM labour_master WHERE status='active' GROUP BY 1 ORDER BY workers DESC`).all(),
    by_site: db.prepare(`SELECT COALESCE(s.name,'(unassigned)') AS name, COUNT(*) AS workers
      FROM labour_master lm LEFT JOIN sites s ON s.id=lm.site_id WHERE lm.status='active' GROUP BY 1 ORDER BY workers DESC`).all(),
  });
});

// Registered LAST — a bare :id param would otherwise shadow every literal
// single-segment route above it (/transfers, /wage-register, /daily-progress
// all matched /:id first and 404'd as "not found" before this was moved).
router.get('/:id', canRead, (req, res) => {
  const row = getDb().prepare(`SELECT ${LM_COLS} FROM labour_master lm LEFT JOIN sites s ON s.id=lm.site_id WHERE lm.id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Labour record not found' });
  res.json(row);
});

module.exports = router;
