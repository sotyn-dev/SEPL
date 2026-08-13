// Labour Management System — Labour Rate Master.
//
// HR/Admin maintain the rates; everyone else reads them. That asymmetry is the
// point, so it is enforced on the server: the Work Order creator, site engineer
// and contractor all consume these rates through the Labour Rate Window, and
// none of them can reach a write route.
//
// Distinct from the labour_rates table read by routes/quotations.js — that one
// holds 610 per-unit-of-work BOQ activity rates ("SENSOR INSTALLATION / PCS /
// 100"); this one holds per-person-per-day crew rates ("Electrician / Day /
// 1200"). Same word, different concept.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware);

const MODULE = 'labour_rate_master';
const canCreate = requirePermission(MODULE, 'create');
const canEdit = requirePermission(MODULE, 'edit');
const canDelete = requirePermission(MODULE, 'delete');

/**
 * Read access for anyone who legitimately needs to SEE a rate.
 *
 * A plain requirePermission(MODULE,'view') would mean every site engineer needs
 * an explicit grant before the Labour Rate Window opens — new modules default
 * to DENY for non-admin roles. Since the window is a mandatory step in Work
 * Order creation, anyone who can work on Work Orders or quotations can read
 * rates. Write routes keep the strict single-module check.
 */
function canRead(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const row = getDb().prepare(`
    SELECT MAX(rp.can_view) AS ok
      FROM role_permissions rp
      JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ?
       AND rp.module IN (?, 'indent_labour_payment', 'labour_payment', 'labour_quotation')
  `).get(req.user.id, MODULE);
  if (row?.ok) return next();
  return res.status(403).json({ error: 'No access to labour rates' });
}

const UNITS = ['Day', 'Hour', 'Month'];
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => { const t = String(v ?? '').trim(); return t || null; };

const RATE_COLS = `id, labour_category, labour_type, trade, department, skill_level,
  unit, standard_rate, overtime_rate, effective_from, effective_to, status, remarks,
  created_by, created_by_name, created_at, updated_by, updated_by_name, updated_at`;

function writeHistory(db, { rate_id, labour_category, action, before, after, reason, user }) {
  db.prepare(`
    INSERT INTO labour_rate_history
      (rate_id, labour_category, action, old_rate, new_rate,
       old_overtime_rate, new_overtime_rate, before_json, after_json,
       reason, changed_by, changed_by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    rate_id, labour_category, action,
    before?.standard_rate ?? null, after?.standard_rate ?? null,
    before?.overtime_rate ?? null, after?.overtime_rate ?? null,
    before ? JSON.stringify(before) : null,
    after ? JSON.stringify(after) : null,
    reason || null, user?.id || null, user?.name || null);
}

function validate(b, { partial = false } = {}) {
  if ((!partial || b.labour_category !== undefined) && !str(b.labour_category)) {
    return 'Labour category is required';
  }
  if ((!partial || b.effective_from !== undefined) && !str(b.effective_from)) {
    return 'Effective from date is required';
  }
  if (b.unit != null && b.unit !== undefined && !UNITS.includes(b.unit)) {
    return `Unit must be one of ${UNITS.join(' / ')}`;
  }
  if (b.standard_rate !== undefined && num(b.standard_rate, -1) < 0) return 'Standard rate must be zero or more';
  if (b.overtime_rate !== undefined && b.overtime_rate != null && num(b.overtime_rate, -1) < 0) {
    return 'Overtime rate must be zero or more';
  }
  if (b.effective_from && b.effective_to && String(b.effective_to) < String(b.effective_from)) {
    return 'Effective To cannot be earlier than Effective From';
  }
  return null;
}

// ─── List ─────────────────────────────────────────────────────────────────
router.get('/', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  for (const [key, col] of [['status', 'status'], ['department', 'department'],
    ['trade', 'trade'], ['labour_category', 'labour_category'],
    ['skill_level', 'skill_level'], ['unit', 'unit']]) {
    if (q[key]) { where.push(`${col} = ?`); args.push(q[key]); }
  }
  if (q.search) {
    where.push(`(labour_category LIKE ? OR trade LIKE ? OR department LIKE ?
                 OR labour_type LIKE ? OR skill_level LIKE ? OR remarks LIKE ?)`);
    const like = `%${q.search}%`;
    args.push(like, like, like, like, like, like);
  }
  res.json(getDb().prepare(`
    SELECT ${RATE_COLS} FROM labour_rate_master
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY status ASC, labour_category ASC, effective_from DESC`).all(...args));
});

// ─── Labour Rate Window feed ──────────────────────────────────────────────
// Only rates actually in force today. A rate whose effective_to has passed is
// not offered even if someone forgot to flip its status — the date range is
// the source of truth, not the flag.
router.get('/window', canRead, (req, res) => {
  const db = getDb();
  const q = req.query || {};
  const where = [
    `status = 'active'`,
    `DATE(effective_from) <= DATE('now','localtime')`,
    `(effective_to IS NULL OR DATE(effective_to) >= DATE('now','localtime'))`,
  ];
  const args = [];
  for (const key of ['department', 'trade', 'labour_category', 'skill_level']) {
    if (q[key]) { where.push(`${key} = ?`); args.push(q[key]); }
  }
  if (q.search) {
    where.push(`(labour_category LIKE ? OR trade LIKE ? OR department LIKE ? OR skill_level LIKE ?)`);
    const like = `%${q.search}%`;
    args.push(like, like, like, like);
  }

  const rows = db.prepare(`
    SELECT ${RATE_COLS} FROM labour_rate_master
     WHERE ${where.join(' AND ')}
     ORDER BY department, trade, labour_category`).all(...args);

  // Filter options come from the whole active set, not the filtered result, so
  // narrowing one dropdown doesn't empty the others.
  const distinct = (col) => db.prepare(
    `SELECT DISTINCT ${col} v FROM labour_rate_master
      WHERE status='active' AND ${col} IS NOT NULL AND TRIM(${col}) <> ''
      ORDER BY ${col}`).all().map(r => r.v);

  res.json({
    rows,
    filters: {
      departments: distinct('department'),
      trades: distinct('trade'),
      categories: distinct('labour_category'),
      skill_levels: distinct('skill_level'),
    },
  });
});

router.get('/:id', canRead, (req, res) => {
  const row = getDb().prepare(`SELECT ${RATE_COLS} FROM labour_rate_master WHERE id=?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Rate not found' });
  res.json(row);
});

router.get('/:id/history', canRead, (req, res) => {
  res.json(getDb().prepare(
    `SELECT * FROM labour_rate_history WHERE rate_id=? ORDER BY changed_at DESC, id DESC`
  ).all(req.params.id));
});

// ─── Create ───────────────────────────────────────────────────────────────
router.post('/', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const err = validate(b);
  if (err) return res.status(400).json({ error: err });

  let info;
  try {
    info = db.prepare(`
      INSERT INTO labour_rate_master
        (labour_category, labour_type, trade, department, skill_level, unit,
         standard_rate, overtime_rate, effective_from, effective_to, status, remarks,
         created_by, created_by_name, updated_by, updated_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      str(b.labour_category), str(b.labour_type), str(b.trade), str(b.department),
      str(b.skill_level), b.unit || 'Day',
      num(b.standard_rate), num(b.overtime_rate),
      str(b.effective_from), str(b.effective_to),
      b.status === 'inactive' ? 'inactive' : 'active', str(b.remarks),
      req.user.id, req.user.name || null, req.user.id, req.user.name || null);
  } catch (e) {
    if (/uq_lrm_active_effective/.test(e.message)) {
      return res.status(409).json({
        error: 'An active rate already exists for this labour category, trade and effective date. Deactivate it first, or use a different effective date.',
      });
    }
    throw e;
  }

  const after = db.prepare(`SELECT ${RATE_COLS} FROM labour_rate_master WHERE id=?`).get(info.lastInsertRowid);
  writeHistory(db, { rate_id: after.id, labour_category: after.labour_category,
    action: 'created', before: null, after, reason: str(b.reason), user: req.user });
  logAuditEvent({
    user: req.user, action: 'CREATE', entity_type: 'labour_rate_master',
    entity_id: after.id, entity_label: `${after.labour_category} — ₹${after.standard_rate}/${after.unit}`,
    before: null, after,
  });
  notifyRateChange(db, req.user, 'added');
  res.status(201).json({ id: after.id });
});

// ─── Update ───────────────────────────────────────────────────────────────
router.put('/:id', canEdit, (req, res) => {
  const db = getDb();
  const before = db.prepare(`SELECT ${RATE_COLS} FROM labour_rate_master WHERE id=?`).get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Rate not found' });
  const b = req.body || {};
  const err = validate({ ...before, ...b }, { partial: true });
  if (err) return res.status(400).json({ error: err });

  // A rate change is a business event, not a typo fix — require the why.
  const rateChanging = b.standard_rate != null && num(b.standard_rate) !== before.standard_rate;
  if (rateChanging && !str(b.reason)) {
    return res.status(400).json({ error: 'A reason is required when changing the rate.' });
  }

  try {
    db.prepare(`
      UPDATE labour_rate_master SET
        labour_category = COALESCE(?, labour_category),
        labour_type = ?, trade = ?, department = ?, skill_level = ?,
        unit = COALESCE(?, unit),
        standard_rate = COALESCE(?, standard_rate),
        overtime_rate = COALESCE(?, overtime_rate),
        effective_from = COALESCE(?, effective_from),
        effective_to = ?,
        status = COALESCE(?, status),
        remarks = ?,
        updated_by = ?, updated_by_name = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      str(b.labour_category),
      b.labour_type !== undefined ? str(b.labour_type) : before.labour_type,
      b.trade !== undefined ? str(b.trade) : before.trade,
      b.department !== undefined ? str(b.department) : before.department,
      b.skill_level !== undefined ? str(b.skill_level) : before.skill_level,
      b.unit || null,
      b.standard_rate != null ? num(b.standard_rate) : null,
      b.overtime_rate != null ? num(b.overtime_rate) : null,
      str(b.effective_from),
      b.effective_to !== undefined ? str(b.effective_to) : before.effective_to,
      b.status || null,
      b.remarks !== undefined ? str(b.remarks) : before.remarks,
      req.user.id, req.user.name || null, req.params.id);
  } catch (e) {
    if (/uq_lrm_active_effective/.test(e.message)) {
      return res.status(409).json({
        error: 'That would collide with another active rate for the same labour category, trade and effective date.',
      });
    }
    throw e;
  }

  const after = db.prepare(`SELECT ${RATE_COLS} FROM labour_rate_master WHERE id=?`).get(req.params.id);
  const action = before.status !== after.status
    ? (after.status === 'active' ? 'activated' : 'deactivated') : 'updated';
  writeHistory(db, { rate_id: after.id, labour_category: after.labour_category,
    action, before, after, reason: str(b.reason), user: req.user });
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'labour_rate_master',
    entity_id: after.id,
    entity_label: `${after.labour_category} — ₹${before.standard_rate} → ₹${after.standard_rate}`,
    before, after,
  });
  if (rateChanging) notifyRateChange(db, req.user, 'updated');
  res.json({ message: 'Rate updated' });
});

// ─── Delete ───────────────────────────────────────────────────────────────
// Refused once a Work Order has used the rate. The snapshot on the WO line
// means the price survives, but deleting the master row breaks the provenance
// trail back to it — deactivating keeps both.
router.delete('/:id', canDelete, (req, res) => {
  const db = getDb();
  const before = db.prepare(`SELECT ${RATE_COLS} FROM labour_rate_master WHERE id=?`).get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Rate not found' });

  const used = db.prepare('SELECT COUNT(*) c FROM proj_wo_labour WHERE rate_id=?').get(req.params.id).c;
  if (used > 0) {
    return res.status(409).json({
      error: `This rate is used on ${used} Work Order line(s). Set it to Inactive instead — deleting would break the audit trail.`,
      used_count: used,
    });
  }

  db.prepare('DELETE FROM labour_rate_master WHERE id=?').run(req.params.id);
  writeHistory(db, { rate_id: null, labour_category: before.labour_category,
    action: 'deleted', before, after: null, reason: str(req.body?.reason), user: req.user });
  logAuditEvent({
    user: req.user, action: 'DELETE', entity_type: 'labour_rate_master',
    entity_id: before.id, entity_label: before.labour_category, before, after: null,
  });
  res.json({ message: 'Rate deleted' });
});

// ─── Notifications ────────────────────────────────────────────────────────
// Tell the people who raise Work Orders that the rates under them moved.
// Deduped per user per day so a session of edits doesn't spam the bell.
function notifyRateChange(db, actor, verb) {
  try {
    const day = new Date().toLocaleDateString('en-CA');
    const recipients = db.prepare(`
      SELECT DISTINCT u.id FROM users u
       WHERE u.role = 'admin'
          OR u.id IN (SELECT ur.user_id FROM user_roles ur
                        JOIN role_permissions rp ON rp.role_id = ur.role_id
                       WHERE rp.module IN ('indent_labour_payment','labour_quotation')
                         AND rp.can_create = 1)`).all();
    const ins = db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?, 'labour_rate', ?, ?, '/labour-rate-master', 'in_app', ?)`);
    const title = 'Labour rates updated by HR';
    const body = `Labour rates have been ${verb} by ${actor?.name || 'HR'}. All new Work Orders will use the latest rates. Work Orders already created keep the rates they were created with.`;
    for (const r of recipients) {
      const key = `labour_rate:${day}:${r.id}`;
      if (!db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(r.id, key)) {
        ins.run(r.id, title, body, key);
      }
    }
  } catch (e) {
    // A failed notification must never roll back a saved rate.
    console.warn('[labour-rate] notify failed:', e.message);
  }
}

// ─── Reports / KPIs ───────────────────────────────────────────────────────
router.get('/reports/dashboard', canRead, (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  res.json({
    cards: {
      active_rates: one(`SELECT COUNT(*) c FROM labour_rate_master WHERE status='active'`).c,
      inactive_rates: one(`SELECT COUNT(*) c FROM labour_rate_master WHERE status='inactive'`).c,
      changes_this_month: one(`SELECT COUNT(*) c FROM labour_rate_history
         WHERE strftime('%Y-%m', changed_at) = strftime('%Y-%m','now','localtime')`).c,
      avg_day_rate: one(`SELECT COALESCE(AVG(standard_rate),0) v FROM labour_rate_master
         WHERE status='active' AND unit='Day'`).v,
      categories: one(`SELECT COUNT(DISTINCT labour_category) c FROM labour_rate_master WHERE status='active'`).c,
    },
    latest_updates: db.prepare(`
      SELECT h.*, r.unit FROM labour_rate_history h
      LEFT JOIN labour_rate_master r ON r.id = h.rate_id
       ORDER BY h.changed_at DESC LIMIT 10`).all(),
    by_department: db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(department),''),'(none)') AS name,
             COUNT(*) AS rates, COALESCE(AVG(standard_rate),0) AS avg_rate
        FROM labour_rate_master WHERE status='active' GROUP BY name ORDER BY rates DESC`).all(),
    by_trade: db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(trade),''),'(none)') AS name,
             COUNT(*) AS rates, COALESCE(AVG(standard_rate),0) AS avg_rate
        FROM labour_rate_master WHERE status='active' GROUP BY name ORDER BY rates DESC`).all(),
  });
});

router.get('/reports/history', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.from) { where.push('DATE(h.changed_at) >= DATE(?)'); args.push(q.from); }
  if (q.to) { where.push('DATE(h.changed_at) <= DATE(?)'); args.push(q.to); }
  if (q.labour_category) { where.push('h.labour_category = ?'); args.push(q.labour_category); }
  if (q.action) { where.push('h.action = ?'); args.push(q.action); }
  res.json(getDb().prepare(`
    SELECT h.*, r.trade, r.department, r.unit
      FROM labour_rate_history h
      LEFT JOIN labour_rate_master r ON r.id = h.rate_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY h.changed_at DESC, h.id DESC LIMIT 1000`).all(...args));
});

module.exports = router;
