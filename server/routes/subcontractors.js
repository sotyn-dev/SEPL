// Sub-contractor master list. Brings mam's "Sub-Contractor Form"
// Google-Form workflow into the ERP so 47+ subcontractor entries can
// be filtered/searched alongside the rest of the data.

const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { sitesWithActiveWorkOrder } = require('../lib/subcontractorWorkOrders');
const router = express.Router();
router.use(authMiddleware);

// Lightweight picker endpoint — any authenticated user can use it,
// no sub_contractors:view permission required.  Mam (2026-05-30):
// the DPR submission form needs site engineers to pick from the
// master, but engineers don't (and shouldn't) have full master
// access.  Returns just id / name / type / district so dropdowns
// stay small.  MUST be registered above the `/:id` route so the
// id-matcher doesn't eat it.
router.get('/lookup', (req, res) => {
  // De-dupe by name (case-insensitive): the master can hold several
  // rows sharing a name (e.g. four "Raj" plumbing gangs), but the DPR
  // picker binds by name string and uses it as the React key, so the
  // duplicates collapse into one another and silently drop from the
  // list.  GROUP BY name → one entry per distinct name; keep the
  // lowest id (earliest master record) as the representative.
  const rows = getDb().prepare(
    `SELECT MIN(id) AS id, name, contractor_type, district
       FROM sub_contractors
      WHERE active = 1
      GROUP BY name COLLATE NOCASE
      ORDER BY name COLLATE NOCASE`
  ).all();
  res.json(rows);
});

// GET list — optional filters: q (name/number/type search), state,
// contractor_type, active=0|1 (default: active only).
router.get('/', requirePermission('sub_contractors', 'view'), (req, res) => {
  const { q, state, contractor_type, active } = req.query;
  let sql = 'SELECT * FROM sub_contractors WHERE 1=1';
  const params = [];

  if (active !== 'all') {
    sql += ' AND active=?';
    params.push(active === '0' ? 0 : 1);
  }
  if (state) { sql += ' AND state=?'; params.push(state); }
  if (contractor_type) { sql += ' AND contractor_type=?'; params.push(contractor_type); }
  if (q) {
    sql += ' AND (name LIKE ? OR phone LIKE ? OR contractor_type LIKE ? OR district LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like, like);
  }
  sql += ' ORDER BY name COLLATE NOCASE';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/:id', requirePermission('sub_contractors', 'view'), (req, res) => {
  const row = getDb().prepare('SELECT * FROM sub_contractors WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const bool01 = (v) => (v === true || v === 1 || v === '1' || v === 'yes' || v === 'Yes') ? 1 : 0;

router.post('/', requirePermission('sub_contractors', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });
  const r = getDb().prepare(
    `INSERT INTO sub_contractors
     (name, phone, state, district, location_extra, contractor_type,
      experience_years, manpower, with_tools, has_gst, gst_number, rate_in_budget,
      start_within_days, notes, active, work_order_file, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    String(b.name).trim(),
    b.phone || null,
    b.state || null,
    b.district || null,
    b.location_extra || null,
    b.contractor_type || null,
    num(b.experience_years),
    num(b.manpower),
    bool01(b.with_tools),
    bool01(b.has_gst),
    b.gst_number || null,
    b.rate_in_budget || null,
    num(b.start_within_days),
    b.notes || null,
    b.active === false || b.active === 0 ? 0 : 1,
    b.work_order_file || null,
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', requirePermission('sub_contractors', 'edit'), (req, res) => {
  const b = req.body || {};
  const existing = getDb().prepare('SELECT id FROM sub_contractors WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  if (!b.name || !String(b.name).trim()) return res.status(400).json({ error: 'Name is required' });

  getDb().prepare(
    `UPDATE sub_contractors SET
       name=?, phone=?, state=?, district=?, location_extra=?, contractor_type=?,
       experience_years=?, manpower=?, with_tools=?, has_gst=?, gst_number=?, rate_in_budget=?,
       start_within_days=?, notes=?, active=?, work_order_file=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    String(b.name).trim(),
    b.phone || null,
    b.state || null,
    b.district || null,
    b.location_extra || null,
    b.contractor_type || null,
    num(b.experience_years),
    num(b.manpower),
    bool01(b.with_tools),
    bool01(b.has_gst),
    b.gst_number || null,
    b.rate_in_budget || null,
    num(b.start_within_days),
    b.notes || null,
    b.active === false || b.active === 0 ? 0 : 1,
    b.work_order_file || null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

// Toggle active (soft-delete pattern — preserves historical references).
router.patch('/:id/active', requirePermission('sub_contractors', 'edit'), (req, res) => {
  const next = req.body?.active ? 1 : 0;
  const r = getDb().prepare('UPDATE sub_contractors SET active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(next, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: next ? 'Activated' : 'Deactivated' });
});

router.delete('/:id', requirePermission('sub_contractors', 'delete'), (req, res) => {
  const r = getDb().prepare('DELETE FROM sub_contractors WHERE id=?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ── Sub-contractor self-service login (director ask, 2026-07-25) ────────
// Admin-only: creates a `users` row scoped to the "Sub-Contractor" role
// (seeded in schema.js) and links it via sub_contractors.user_id — same
// nullable-FK pattern as employees.user_id. The resulting login can only
// see its own crew roster + attendance for sites where it holds an ACTIVE
// Work Order (routes/subcontractorAttendance.js).
router.post('/:id/create-login', adminOnly, (req, res) => {
  const db = getDb();
  const sc = db.prepare('SELECT id, name, user_id FROM sub_contractors WHERE id=?').get(req.params.id);
  if (!sc) return res.status(404).json({ error: 'Sub-contractor not found' });
  if (sc.user_id) return res.status(400).json({ error: 'This sub-contractor already has a login' });

  const { email, username, password } = req.body || {};
  // users.email is UNIQUE NOT NULL — synthesize one if admin didn't give a
  // real address, so a subcontractor without email can still get a login.
  const finalEmail = (email && String(email).trim()) || `subcon-${sc.id}@subcontractor.sotyn.local`;
  const finalUsername = (username && String(username).trim()) || `subcon${sc.id}`;
  const finalPassword = (password && String(password).length >= 4) ? String(password) : Math.random().toString(36).slice(2, 10);

  const dupe = db.prepare('SELECT id FROM users WHERE LOWER(email)=LOWER(?) OR username=?').get(finalEmail, finalUsername);
  if (dupe) return res.status(409).json({ error: 'A user with this email/username already exists' });

  const role = db.prepare(`SELECT id FROM roles WHERE name='Sub-Contractor'`).get();
  if (!role) return res.status(500).json({ error: "Sub-Contractor role not seeded — restart the server" });

  const hash = bcrypt.hashSync(finalPassword, 10);
  const txn = db.transaction(() => {
    const u = db.prepare(
      `INSERT INTO users (name, email, username, password, role, department) VALUES (?,?,?,?,?,?)`
    ).run(sc.name, finalEmail, finalUsername, hash, 'user', 'Sub-Contractor');
    db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?,?)').run(u.lastInsertRowid, role.id);
    db.prepare('UPDATE sub_contractors SET user_id=? WHERE id=?').run(u.lastInsertRowid, sc.id);
    return u.lastInsertRowid;
  });
  try {
    const userId = txn();
    // Password is only ever returned here, once, right after creation —
    // same as the pattern used for the seeded backup-admin account.
    res.status(201).json({ user_id: userId, username: finalUsername, email: finalEmail, password: finalPassword });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Which sites a sub-contractor can currently submit attendance for — read-
// only, derived from active Work Orders (director ask, 2026-07-25: "no work
// order no attendance"). There's no manual assignment step: issuing a Work
// Order for this sub-contractor at a project (Projects → Indent Labour
// Payment → Work Orders) is what grants access, automatically.
router.get('/:id/work-order-sites', requirePermission('sub_contractors', 'view'), (req, res) => {
  res.json(sitesWithActiveWorkOrder(getDb(), +req.params.id));
});

// Admin/site-engineer review: recent daily attendance submissions for one
// sub-contractor, with named worker present/absent + photos, so mam can
// audit a crew's attendance without needing the subcontractor's own login.
router.get('/:id/attendance-log', requirePermission('sub_contractors', 'view'), (req, res) => {
  const db = getDb();
  const dateFrom = String(req.query.date_from || '').slice(0, 10) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const dateTo = String(req.query.date_to || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  const attendance = db.prepare(
    `SELECT a.id, a.site_id, a.attendance_date, a.notes, s.name as site_name, u.name as submitted_by_name
       FROM sub_contractor_attendance a
       JOIN sites s ON s.id = a.site_id
       LEFT JOIN users u ON u.id = a.submitted_by
      WHERE a.sub_contractor_id = ? AND a.attendance_date BETWEEN ? AND ?
      ORDER BY a.attendance_date DESC`
  ).all(req.params.id, dateFrom, dateTo);
  if (!attendance.length) return res.json([]);
  const ids = attendance.map(a => a.id);
  const ph = ids.map(() => '?').join(',');
  const photos = db.prepare(`SELECT * FROM sub_contractor_attendance_photos WHERE attendance_id IN (${ph})`).all(...ids);
  const workers = db.prepare(
    `SELECT aw.attendance_id, aw.present, w.id as worker_id, w.name, w.phone
       FROM sub_contractor_attendance_workers aw
       JOIN sub_contractor_workers w ON w.id = aw.worker_id
      WHERE aw.attendance_id IN (${ph})`
  ).all(...ids);
  res.json(attendance.map(a => ({
    ...a,
    photos: photos.filter(p => p.attendance_id === a.id),
    workers: workers.filter(w => w.attendance_id === a.id),
  })));
});

module.exports = router;
