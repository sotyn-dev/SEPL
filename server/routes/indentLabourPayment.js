// Indent Labour Payment — full project execution + billing pipeline.
// Mam (2026-06-01, amended 2026-06-02 — "it create wrong project …
// first amend it"): Projects are MANUALLY entered (unique name, no
// PO column).  Each project has three labour spend streams:
//   L1 Salary       (proj_salary_entries)
//   L2 Daily Wages  (proj_daily_wage_entries)
//   L3 Sub-contract (proj_work_orders + amount_paid running total)
// Budget = SUM of all three.
//
// Legacy capture: old (pre-ERP) projects get one-off 'legacy' rows
// for L1 + L2 to record what was already spent before the ERP came
// online.  For L3 the WO row itself carries amount_paid which can
// include legacy payment.

const express = require('express');
const { getDb } = require('../db/schema');
const { statusFilter } = require('../lib/statusFilter');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();
router.use(authMiddleware);

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

// ─── helper: per-project rollups ────────────────────────────────
// Returns { l1, l2, l3, budget } for a single project_id.  L3
// budget contribution is the running amount_paid against WOs (not
// the planned_value).
function projectRollup(db, projectId) {
  const l1 = num(db.prepare(
    `SELECT COALESCE(SUM(amount), 0) AS s FROM proj_salary_entries WHERE project_id = ?`
  ).get(projectId)?.s);
  const l2 = num(db.prepare(
    `SELECT COALESCE(SUM(total_amount), 0) AS s FROM proj_daily_wage_entries WHERE project_id = ?`
  ).get(projectId)?.s);
  const l3 = num(db.prepare(
    `SELECT COALESCE(SUM(amount_paid), 0) AS s FROM proj_work_orders WHERE project_id = ?`
  ).get(projectId)?.s);
  return { l1, l2, l3, budget: l1 + l2 + l3 };
}

// ════════════════════════════════════════════════════════════════
// PROJECT CRUD
// ════════════════════════════════════════════════════════════════
router.get('/projects', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const { q, owner } = req.query;
  let sql = `
    SELECT p.id, p.name, COALESCE(p.owner, 'Aanchal') AS owner, p.notes,
           p.created_at, p.updated_at,
           (SELECT COALESCE(SUM(amount), 0)       FROM proj_salary_entries     WHERE project_id = p.id) AS l1,
           (SELECT COALESCE(SUM(total_amount), 0) FROM proj_daily_wage_entries WHERE project_id = p.id) AS l2,
           (SELECT COALESCE(SUM(amount_paid), 0)  FROM proj_work_orders        WHERE project_id = p.id) AS l3,
           (SELECT COUNT(*)                       FROM proj_work_orders        WHERE project_id = p.id) AS work_order_count
      FROM proj_projects p
     WHERE 1=1
  `;
  const params = [];
  if (q) {
    sql += ` AND (LOWER(p.name) LIKE ? OR LOWER(COALESCE(p.notes,'')) LIKE ?)`;
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like);
  }
  if (owner) {
    sql += ` AND COALESCE(p.owner, 'Aanchal') = ?`;
    params.push(owner);
  }
  sql += ` ORDER BY p.created_at DESC`;
  const rows = db.prepare(sql).all(...params).map(r => ({ ...r, budget: r.l1 + r.l2 + r.l3 }));
  res.json(rows);
});

router.get('/projects/:id', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT id, name, COALESCE(owner, 'Aanchal') AS owner, notes, created_at, updated_at
       FROM proj_projects WHERE id = ?`
  ).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json({ ...row, ...projectRollup(db, row.id) });
});

router.post('/projects', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Project name is required' });
  // Uniqueness — surface as a friendly error instead of the raw
  // SQLITE_CONSTRAINT.  Case-insensitive check.
  const dup = db.prepare(`SELECT id FROM proj_projects WHERE LOWER(TRIM(name)) = LOWER(?)`).get(name);
  if (dup) return res.status(409).json({ error: 'A project with this name already exists' });
  const owner = String(req.body?.owner || 'Aanchal').trim() || 'Aanchal';
  const notes = req.body?.notes || null;
  const r = db.prepare(
    `INSERT INTO proj_projects (name, owner, notes, created_by) VALUES (?, ?, ?, ?)`
  ).run(name, owner, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/projects/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT id FROM proj_projects WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Project not found' });
  const name = req.body?.name != null ? String(req.body.name).trim() : null;
  if (name === '') return res.status(400).json({ error: 'Project name cannot be blank' });
  if (name) {
    const dup = db.prepare(
      `SELECT id FROM proj_projects WHERE LOWER(TRIM(name)) = LOWER(?) AND id <> ?`
    ).get(name, req.params.id);
    if (dup) return res.status(409).json({ error: 'Another project already uses this name' });
  }
  db.prepare(
    `UPDATE proj_projects
        SET name = COALESCE(?, name),
            owner = COALESCE(?, owner),
            notes = COALESCE(?, notes),
            updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`
  ).run(name, req.body?.owner ?? null, req.body?.notes ?? null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/projects/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT id FROM proj_projects WHERE id = ?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Project not found' });
  // CASCADE on the FKs handles salary / daily-wage / WOs.
  db.prepare(`DELETE FROM proj_projects WHERE id = ?`).run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ─── owners list (filter dropdown) ──────────────────────────────
router.get('/owners', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT COALESCE(owner, 'Aanchal') AS owner, COUNT(*) AS project_count
       FROM proj_projects
      GROUP BY COALESCE(owner, 'Aanchal')
      ORDER BY (CASE WHEN COALESCE(owner,'Aanchal')='Aanchal' THEN 0 ELSE 1 END), owner`
  ).all();
  res.json(rows);
});

// ════════════════════════════════════════════════════════════════
// PROJECT OVERVIEW (2026-08) — "click a project, see everything":
// money, work progress, and bill status in one summary, so nobody has to
// hop between the L1/L2/L3 tabs and Bill Verification separately.
//
// Honest limitation: proj_projects has no column linking it to a site or
// to labour_master, so per-project labour attendance can't be rolled up
// here — that data lives per-SITE in Labour Master, not per-project.
// Everything below is what the schema actually supports joining.
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/overview', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const pid = req.params.pid;

  const money = {
    l1_salary: db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM proj_salary_entries WHERE project_id=?`).get(pid).v,
    l2_daily_wage: db.prepare(`SELECT COALESCE(SUM(total_amount),0) v FROM proj_daily_wage_entries WHERE project_id=?`).get(pid).v,
    l3_paid: db.prepare(`SELECT COALESCE(SUM(amount_paid),0) v FROM proj_work_orders WHERE project_id=?`).get(pid).v,
    l3_planned: db.prepare(`SELECT COALESCE(SUM(planned_value),0) v FROM proj_work_orders WHERE project_id=?`).get(pid).v,
  };

  const wo_by_status = db.prepare(`
    SELECT COALESCE(status,'draft') AS status, COUNT(*) AS count, COALESCE(SUM(planned_value),0) AS value
      FROM proj_work_orders WHERE project_id=? GROUP BY status`).all(pid);

  // Work progress — DPR-claimed amount vs planned value, across every WO
  // in this project (the same figure the per-WO "DPR Progress" badge uses,
  // rolled up).
  const progress = db.prepare(`
    SELECT COALESCE(SUM(dwi.amount),0) AS claimed, COALESCE(SUM(wo.planned_value),0) AS planned
      FROM proj_work_orders wo
      LEFT JOIN dpr_work_items dwi ON dwi.work_order_id = wo.id
     WHERE wo.project_id = ?`).get(pid);
  const progress_pct = progress.planned > 0 ? Math.min(999, Math.round((progress.claimed / progress.planned) * 1000) / 10) : 0;

  // Bills — joined via work_order_id since proj_contractor_ra_bills.project_id
  // is not reliably the same project concept in every row (pre-existing
  // schema note); work_order_id -> proj_work_orders.project_id is the
  // trustworthy path.
  const bills_by_status = db.prepare(`
    SELECT b.status, COUNT(*) AS count, COALESCE(SUM(b.net_amount),0) AS amount
      FROM proj_contractor_ra_bills b
      JOIN proj_work_orders wo ON wo.id = b.work_order_id
     WHERE wo.project_id = ? GROUP BY b.status`).all(pid);
  const bills_pending_stage = db.prepare(`
    SELECT b.current_stage, COUNT(*) AS count
      FROM proj_contractor_ra_bills b
      JOIN proj_work_orders wo ON wo.id = b.work_order_id
     WHERE wo.project_id = ? AND b.status = 'raised' GROUP BY b.current_stage`).all(pid);

  res.json({
    money: { ...money, budget: money.l1_salary + money.l2_daily_wage + money.l3_paid },
    work_progress_pct: progress_pct,
    work_orders_by_status: wo_by_status,
    bills_by_status,
    bills_pending_by_stage: bills_pending_stage,
  });
});

// ════════════════════════════════════════════════════════════════
// L1 SALARY ENTRIES
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/salary', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, kind, employee_name, period_month, amount, notes, created_at
       FROM proj_salary_entries
      WHERE project_id = ?
      ORDER BY (CASE kind WHEN 'legacy' THEN 0 ELSE 1 END), period_month DESC, id DESC`
  ).all(req.params.pid));
});

router.post('/projects/:pid/salary', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const kind = b.kind === 'legacy' ? 'legacy' : 'monthly';
  const amount = num(b.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Amount must be > 0' });
  if (kind === 'monthly' && !b.period_month) {
    return res.status(400).json({ error: 'period_month (YYYY-MM) required for monthly entries' });
  }
  // Legacy is a single bulk row per project — block duplicates so
  // mam can't accidentally enter the legacy carry twice.
  if (kind === 'legacy') {
    const exists = db.prepare(
      `SELECT id FROM proj_salary_entries WHERE project_id=? AND kind='legacy'`
    ).get(req.params.pid);
    if (exists) return res.status(409).json({ error: 'Legacy salary already captured for this project. Edit it instead of adding a second.' });
  }
  const r = db.prepare(
    `INSERT INTO proj_salary_entries (project_id, kind, employee_name, period_month, amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, kind, b.employee_name || null,
    kind === 'monthly' ? b.period_month : null,
    amount, b.notes || null, req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/salary/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_salary_entries WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// L2 DAILY WAGE ENTRIES
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/daily-wages', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT id, kind, description, per_day_rate, days_required, total_amount, notes, created_at
       FROM proj_daily_wage_entries
      WHERE project_id = ?
      ORDER BY (CASE kind WHEN 'legacy' THEN 0 ELSE 1 END), id DESC`
  ).all(req.params.pid));
});

router.post('/projects/:pid/daily-wages', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const kind = b.kind === 'legacy' ? 'legacy' : 'entry';
  const perDay = num(b.per_day_rate);
  const days = num(b.days_required);
  // For 'entry', compute total from rate × days; for 'legacy', use
  // explicit total_amount (the bulk pre-ERP carry).
  let total = num(b.total_amount);
  if (kind === 'entry') {
    if (perDay <= 0 || days <= 0) return res.status(400).json({ error: 'Per-day rate and days required must be > 0' });
    total = perDay * days;
  } else {
    if (total <= 0) return res.status(400).json({ error: 'Legacy bulk amount must be > 0' });
  }
  if (kind === 'legacy') {
    const exists = db.prepare(
      `SELECT id FROM proj_daily_wage_entries WHERE project_id=? AND kind='legacy'`
    ).get(req.params.pid);
    if (exists) return res.status(409).json({ error: 'Legacy daily wages already captured. Edit instead of adding a second.' });
  }
  const r = db.prepare(
    `INSERT INTO proj_daily_wage_entries
       (project_id, kind, description, per_day_rate, days_required, total_amount, notes, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, kind, b.description || null,
    kind === 'entry' ? perDay : 0,
    kind === 'entry' ? days : 0,
    total, b.notes || null, req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/daily-wages/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_daily_wage_entries WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// L3 WORK ORDERS (sub-contract)
// ════════════════════════════════════════════════════════════════
router.get('/projects/:pid/work-orders', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  // Phase 4 (mam 2026-06-02): each WO row now carries a rollup of the
  // DPR work items that have been logged against it:
  //   dpr_linked_count    — distinct DPR submissions touching this WO
  //   dpr_linked_amount   — Σ(actual_qty × labour rate) across those rows
  //   dpr_linked_qty      — Σ actual_qty (raw quantity claim, no rate)
  //   dpr_progress_pct    — dpr_linked_amount / planned_value × 100,
  //                         capped at 999 so a runaway claim doesn't
  //                         break the badge UI.
  // Mam sees this on the L3 Work Orders tab as a "Linked DPRs · X%"
  // badge; if amount_paid lags progress, that's the cue to release
  // the next contractor payment.
  res.json(db.prepare(
    `SELECT wo.id, wo.wo_number, wo.sub_contractor_id, wo.sub_contractor_name,
            wo.scope, wo.planned_value, COALESCE(wo.amount_paid, 0) AS amount_paid,
            (COALESCE(wo.planned_value, 0) - COALESCE(wo.amount_paid, 0)) AS balance,
            wo.work_order_file_url, wo.planned_start, wo.planned_end, wo.status,
            wo.routed_to, wo.routed_by_name, wo.routed_at,
            wo.created_at, wo.updated_at,
            COALESCE((
              SELECT COUNT(DISTINCT dwi.dpr_id) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_count,
            COALESCE((
              SELECT SUM(dwi.amount) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_amount,
            COALESCE((
              SELECT SUM(dwi.actual_qty) FROM dpr_work_items dwi
               WHERE dwi.work_order_id = wo.id
            ), 0) AS dpr_linked_qty,
            CASE
              WHEN COALESCE(wo.planned_value, 0) <= 0 THEN 0
              ELSE MIN(999,
                ROUND(
                  COALESCE((
                    SELECT SUM(dwi.amount) FROM dpr_work_items dwi
                     WHERE dwi.work_order_id = wo.id
                  ), 0) * 100.0 / wo.planned_value,
                  1
                )
              )
            END AS dpr_progress_pct
       FROM proj_work_orders wo
      WHERE wo.project_id = ?
      ORDER BY wo.created_at DESC`
  ).all(req.params.pid));
});

// Global Work Order registry — every WO across every project (any status),
// for the top-level "Work Orders" tab. Optional project_id filter so it can
// double as a project-scoped list without a second endpoint.
router.get('/work-orders', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const where = [];
  const args = [];
  if (req.query.project_id) { where.push('wo.project_id = ?'); args.push(req.query.project_id); }
  // Status — one value or a comma list (mam 2026-09-12).
  const st = statusFilter(req.query.status,
    ['draft', 'submitted', 'approved', 'work_started', 'in_progress', 'completed', 'cancelled'], 'wo.status');
  if (st) { where.push(st.sql); args.push(...st.params); }
  res.json(db.prepare(`
    SELECT wo.id, wo.project_id, p.name AS project_name, wo.wo_number,
           wo.sub_contractor_id, wo.sub_contractor_name, wo.scope,
           wo.planned_value, COALESCE(wo.amount_paid,0) AS amount_paid,
           (COALESCE(wo.planned_value,0) - COALESCE(wo.amount_paid,0)) AS balance,
           wo.planned_start, wo.planned_end, wo.status, wo.created_at,
           wo.contact_number, wo.location, wo.approved_by, wo.work_order_file_url, wo.contractor_document_url
      FROM proj_work_orders wo
      LEFT JOIN proj_projects p ON p.id = wo.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY wo.created_at DESC LIMIT 500`).all(...args));
});

// Phase 4 · All active Work Orders across every project — used by the
// DPR form's per-line Work Order picker.  Site engineer raises a daily
// report and tags each work line against the WO the sub-contractor is
// performing.  Inactive / closed / cancelled WOs are filtered out so
// the picker stays short.
router.get('/active-work-orders', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  res.json(getDb().prepare(
    `SELECT wo.id, wo.wo_number, wo.sub_contractor_name, wo.scope,
            wo.planned_value, wo.status,
            p.name as project_name
       FROM proj_work_orders wo
       LEFT JOIN proj_projects p ON p.id = wo.project_id
      WHERE COALESCE(wo.status, 'active') NOT IN ('closed','cancelled','completed')
      ORDER BY wo.wo_number, wo.id DESC`
  ).all());
});

// Phase 4 · DPR breakdown per Work Order — mam clicks a WO row and
// sees every DPR line that's been logged against it (date, site,
// qty, amount, who submitted) so she can audit the progress claim
// before releasing the next contractor payment.
router.get('/work-orders/:id/dpr-items', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(
    `SELECT dwi.id, dwi.dpr_id, dwi.description, dwi.unit, dwi.floor_zone,
            dwi.actual_qty, dwi.planned_qty, dwi.rate, dwi.amount, dwi.remarks,
            d.report_date, d.site_id,
            s.name as site_name,
            u.name as submitted_by_name
       FROM dpr_work_items dwi
       LEFT JOIN dpr d  ON d.id = dwi.dpr_id
       LEFT JOIN sites s ON s.id = d.site_id
       LEFT JOIN users u ON u.id = d.submitted_by
      WHERE dwi.work_order_id = ?
      ORDER BY d.report_date DESC, dwi.id DESC`
  ).all(req.params.id));
});

router.post('/projects/:pid/work-orders', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.wo_number && !b.sub_contractor_name && !b.scope) {
    return res.status(400).json({ error: 'Provide at least WO number, sub-contractor name, or scope' });
  }
  const planned = num(b.planned_value);
  const paid = num(b.amount_paid);
  if (planned > 0 && paid > planned) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  const r = db.prepare(
    `INSERT INTO proj_work_orders
       (project_id, wo_number, sub_contractor_id, sub_contractor_name, scope,
        planned_value, amount_paid, work_order_file_url, contractor_document_url, planned_start, planned_end,
        contact_number, location, approved_by,
        status, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.pid, b.wo_number || null,
    b.sub_contractor_id || null, b.sub_contractor_name || null,
    b.scope || null, planned, paid,
    b.work_order_file_url || null, b.contractor_document_url || null,
    b.planned_start || null, b.planned_end || null,
    b.contact_number || null, b.location || null, b.approved_by || null,
    b.status || 'active',
    req.user.id,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/work-orders/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const cur = db.prepare(`SELECT planned_value FROM proj_work_orders WHERE id=?`).get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const newPaid = b.amount_paid != null ? num(b.amount_paid) : null;
  const newPlanned = b.planned_value != null ? num(b.planned_value) : null;
  if (newPaid != null && newPlanned != null && newPlanned > 0 && newPaid > newPlanned) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  if (newPaid != null && newPlanned == null && cur.planned_value > 0 && newPaid > cur.planned_value) {
    return res.status(400).json({ error: 'Amount paid cannot exceed WO value' });
  }
  db.prepare(
    `UPDATE proj_work_orders SET
       wo_number            = COALESCE(?, wo_number),
       sub_contractor_id    = COALESCE(?, sub_contractor_id),
       sub_contractor_name  = COALESCE(?, sub_contractor_name),
       scope                = COALESCE(?, scope),
       planned_value        = COALESCE(?, planned_value),
       amount_paid          = COALESCE(?, amount_paid),
       work_order_file_url  = COALESCE(?, work_order_file_url),
       contractor_document_url = COALESCE(?, contractor_document_url),
       planned_start        = COALESCE(?, planned_start),
       planned_end          = COALESCE(?, planned_end),
       contact_number       = COALESCE(?, contact_number),
       location             = COALESCE(?, location),
       approved_by          = COALESCE(?, approved_by),
       status               = COALESCE(?, status),
       updated_at           = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    b.wo_number ?? null,
    b.sub_contractor_id ?? null,
    b.sub_contractor_name ?? null,
    b.scope ?? null,
    newPlanned,
    newPaid,
    b.work_order_file_url ?? null,
    b.contractor_document_url ?? null,
    b.planned_start ?? null,
    b.planned_end ?? null,
    b.contact_number ?? null,
    b.location ?? null,
    b.approved_by ?? null,
    b.status ?? null,
    req.params.id,
  );
  res.json({ message: 'Updated' });
});

router.delete('/work-orders/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare(`DELETE FROM proj_work_orders WHERE id=?`).run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ─── Routing — "send to Site Engineer -> send to Contractor" (2026-08) ────
// Records the hop and notifies the recipient. Does not change `status` —
// routing is who has the WO right now, status is where it is in its
// lifecycle; a WO can be routed to the site engineer at any status.
router.post('/work-orders/:id/route', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const wo = db.prepare('SELECT * FROM proj_work_orders WHERE id=?').get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Work Order not found' });
  const to = ['site_engineer', 'contractor'].includes((req.body || {}).routed_to) ? req.body.routed_to : null;
  if (!to) return res.status(400).json({ error: "routed_to must be 'site_engineer' or 'contractor'" });

  db.prepare(`UPDATE proj_work_orders SET routed_to=?, routed_by=?, routed_by_name=?, routed_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(to, req.user.id, req.user.name || null, wo.id);

  logAuditEvent({ user: req.user, action: 'ROUTE', entity_type: 'proj_work_orders',
    entity_id: wo.id, entity_label: wo.wo_number, before: { routed_to: wo.routed_to }, after: { routed_to: to } });

  // proj_projects has no link to sites/site_engineer_id in this schema, so
  // "the specific site engineer for this WO" isn't resolvable — notify
  // everyone who holds edit rights on this module instead (contractors
  // don't have ERP logins, so the 'contractor' hop is recorded on the WO
  // and in the audit trail, but has no in-app recipient to notify).
  try {
    const recipients = db.prepare(`
      SELECT DISTINCT u.id FROM users u
       WHERE u.role = 'admin'
          OR u.id IN (SELECT ur.user_id FROM user_roles ur
                        JOIN role_permissions rp ON rp.role_id = ur.role_id
                       WHERE rp.module = 'indent_labour_payment' AND rp.can_edit = 1)`).all();
    const dedupe = `wo_route:${wo.id}:${Date.now()}`;
    const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key) VALUES (?,?,?,?,?,?,?)`);
    const title = to === 'site_engineer' ? `Work Order routed to Site Engineer — ${wo.wo_number}` : `Work Order routed to Contractor — ${wo.wo_number}`;
    for (const r of recipients) {
      if (r.id === req.user.id) continue;
      ins.run(r.id, 'work_order', title,
        `${req.user.name || 'Someone'} sent ${wo.wo_number} to the ${to === 'site_engineer' ? 'site engineer' : 'contractor'}.`,
        '/indent-labour-payment', 'in_app', `${dedupe}:${r.id}`);
    }
  } catch (e) { console.warn('[work-order route] notify failed:', e.message); }

  res.json({ ok: true, routed_to: to });
});

// ─── Print / PDF data (2026-08) ────────────────────────────────────────
// Same "server returns structured data, a dedicated frontend page renders
// it for window.print()" pattern as IndentPrint.jsx / QuotationPrint.jsx —
// no server-side PDF library needed.
router.get('/work-orders/:id/print', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const wo = db.prepare(`
    SELECT wo.*, p.name AS project_name
      FROM proj_work_orders wo
      LEFT JOIN proj_projects p ON p.id = wo.project_id
     WHERE wo.id = ?`).get(req.params.id);
  if (!wo) return res.status(404).json({ error: 'Work Order not found' });
  const labour = db.prepare(`SELECT * FROM proj_wo_labour WHERE work_order_id=? ORDER BY id`).all(wo.id);
  res.json({ work_order: wo, labour });
});

// ─── Work Order labour lines (Labour Management System, 2026-08) ──────────
// Crew costing on a WO: pick a category from the Labour Rate Master, give a
// headcount and a duration, and the cost follows. planned_value is left alone
// — it stays the sub-contract / quotation figure, and labour is reported as
// its own total beside it.
//
// The rate is ALWAYS re-read from labour_rate_master on the server and
// snapshotted onto the line. Any rate in the request body is ignored, which is
// what makes "users must not be able to edit the rate" true rather than merely
// hidden in the UI — and what makes an existing WO keep its original rate
// after HR revises the master.

const LABOUR_LINE_COLS = `id, work_order_id, rate_id, labour_category, labour_type, trade,
  department, skill_level, unit, rate_snapshot, overtime_rate_snapshot, rate_effective_from,
  quantity, days, overtime_hours, amount, overtime_amount, remarks,
  created_by, created_by_name, created_at, updated_at`;

// Rate × headcount × duration, plus overtime priced per hour per labourer.
// Rounded to paise so a stored total never disagrees with a displayed one.
function computeLabourAmounts(rate, otRate, qty, days, otHours) {
  const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
  return {
    amount: round2(rate * qty * days),
    overtime_amount: round2((otRate || 0) * (otHours || 0) * qty),
  };
}

router.get('/work-orders/:id/labour', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const rows = getDb().prepare(
    `SELECT ${LABOUR_LINE_COLS} FROM proj_wo_labour WHERE work_order_id=? ORDER BY id`
  ).all(req.params.id);

  const summary = rows.reduce((a, r) => ({
    categories: a.categories + 1,
    labourers: a.labourers + (Number(r.quantity) || 0),
    // Man-days, not a sum of `days`: two crews each running 10 days is 10
    // calendar days but 130 man-days, and man-days is what drives cost.
    man_days: a.man_days + (Number(r.quantity) || 0) * (Number(r.days) || 0),
    total_cost: a.total_cost + (Number(r.amount) || 0) + (Number(r.overtime_amount) || 0),
  }), { categories: 0, labourers: 0, man_days: 0, total_cost: 0 });
  summary.total_cost = Math.round(summary.total_cost * 100) / 100;
  summary.avg_cost_per_category = summary.categories
    ? Math.round((summary.total_cost / summary.categories) * 100) / 100 : 0;

  res.json({ rows, summary });
});

router.post('/work-orders/:id/labour', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  if (!db.prepare('SELECT id FROM proj_work_orders WHERE id=?').get(req.params.id)) {
    return res.status(404).json({ error: 'Work Order not found' });
  }

  const b = req.body || {};
  const rate = db.prepare(`
    SELECT * FROM labour_rate_master
     WHERE id = ? AND status = 'active'
       AND DATE(effective_from) <= DATE('now','localtime')
       AND (effective_to IS NULL OR DATE(effective_to) >= DATE('now','localtime'))`)
    .get(b.rate_id);
  if (!rate) {
    return res.status(400).json({
      error: 'Pick a labour category from the Labour Rate Window. That rate is no longer active or is outside its effective dates.',
    });
  }

  const quantity = num(b.quantity);
  const days = num(b.days);
  const otHours = num(b.overtime_hours);
  if (!(quantity > 0)) return res.status(400).json({ error: 'Number of labourers must be more than zero' });
  if (!(days > 0)) return res.status(400).json({ error: 'Days must be more than zero' });
  if (otHours < 0) return res.status(400).json({ error: 'Overtime hours cannot be negative' });

  const { amount, overtime_amount } =
    computeLabourAmounts(rate.standard_rate, rate.overtime_rate, quantity, days, otHours);

  const r = db.prepare(`
    INSERT INTO proj_wo_labour
      (work_order_id, rate_id, labour_category, labour_type, trade, department,
       skill_level, unit, rate_snapshot, overtime_rate_snapshot, rate_effective_from,
       quantity, days, overtime_hours, amount, overtime_amount, remarks,
       created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    req.params.id, rate.id, rate.labour_category, rate.labour_type, rate.trade,
    rate.department, rate.skill_level, rate.unit,
    rate.standard_rate, rate.overtime_rate, rate.effective_from,
    quantity, days, otHours, amount, overtime_amount,
    b.remarks || null, req.user.id, req.user.name || null);

  res.status(201).json({ id: r.lastInsertRowid, amount, overtime_amount });
});

// Quantity, days, overtime and remarks are editable. The snapshotted rate is
// not — re-pick the category from the window to price the line differently.
router.put('/work-orders/labour/:lineId', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const line = db.prepare(`SELECT ${LABOUR_LINE_COLS} FROM proj_wo_labour WHERE id=?`).get(req.params.lineId);
  if (!line) return res.status(404).json({ error: 'Labour line not found' });

  const b = req.body || {};
  const quantity = b.quantity != null ? num(b.quantity) : line.quantity;
  const days = b.days != null ? num(b.days) : line.days;
  const otHours = b.overtime_hours != null ? num(b.overtime_hours) : (line.overtime_hours || 0);
  if (!(quantity > 0)) return res.status(400).json({ error: 'Number of labourers must be more than zero' });
  if (!(days > 0)) return res.status(400).json({ error: 'Days must be more than zero' });
  if (otHours < 0) return res.status(400).json({ error: 'Overtime hours cannot be negative' });

  const { amount, overtime_amount } = computeLabourAmounts(
    line.rate_snapshot, line.overtime_rate_snapshot, quantity, days, otHours);

  db.prepare(`
    UPDATE proj_wo_labour
       SET quantity=?, days=?, overtime_hours=?, amount=?, overtime_amount=?,
           remarks=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`).run(
    quantity, days, otHours, amount, overtime_amount,
    b.remarks !== undefined ? (b.remarks || null) : line.remarks, req.params.lineId);

  res.json({ message: 'Updated', amount, overtime_amount });
});

router.delete('/work-orders/labour/:lineId', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const r = getDb().prepare('DELETE FROM proj_wo_labour WHERE id=?').run(req.params.lineId);
  if (r.changes === 0) return res.status(404).json({ error: 'Labour line not found' });
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// PHASE 5 — MB / CDPR (Measurement Book).  A period snapshot of WO
// lines, locked once finalised so it stays immutable even if the
// DPR rows behind it are later edited.
// ════════════════════════════════════════════════════════════════
const str = (v) => { const t = String(v ?? '').trim(); return t || null; };

router.get('/projects/:pid/mb', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT m.id, m.mb_no, m.period_from, m.period_to, m.total_qty, m.total_amount,
           m.status, m.locked_at, m.remarks, m.created_at,
           (SELECT COUNT(*) FROM proj_mb_lines WHERE mb_id = m.id) AS line_count
      FROM proj_mb_sheets m
     WHERE m.project_id = ?
     ORDER BY m.id DESC`).all(req.params.pid));
});

router.get('/mb/:id', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare(`SELECT * FROM proj_mb_sheets WHERE id=?`).get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'MB sheet not found' });
  const lines = db.prepare(`
    SELECT l.*, wo.wo_number FROM proj_mb_lines l
    LEFT JOIN proj_work_orders wo ON wo.id = l.work_order_id
     WHERE l.mb_id = ? ORDER BY l.id`).all(req.params.id);
  res.json({ ...sheet, lines });
});

router.post('/projects/:pid/mb', requirePermission('indent_labour_payment', 'create'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.period_from || !b.period_to) {
    return res.status(400).json({ error: 'Period From and Period To are required' });
  }
  const lines = Array.isArray(b.lines) ? b.lines.filter(l => str(l.description)) : [];
  const totals = lines.reduce((acc, l) => {
    const qty = num(l.qty), rate = num(l.rate);
    return { qty: acc.qty + qty, amount: acc.amount + qty * rate };
  }, { qty: 0, amount: 0 });

  const mbNo = nextSequence(db, 'proj_mb_sheets', 'mb_no', 'MB', { pad: 4 });
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO proj_mb_sheets (project_id, mb_no, period_from, period_to, total_qty, total_amount,
        status, remarks, generated_by)
      VALUES (?,?,?,?,?,?,'draft',?,?)`).run(
      req.params.pid, mbNo, b.period_from, b.period_to, totals.qty, totals.amount,
      str(b.remarks), req.user.id);
    const mbId = info.lastInsertRowid;
    const insLine = db.prepare(`
      INSERT INTO proj_mb_lines (mb_id, work_order_id, description, unit, qty, rate, amount, remarks)
      VALUES (?,?,?,?,?,?,?,?)`);
    for (const l of lines) {
      const qty = num(l.qty), rate = num(l.rate);
      insLine.run(mbId, l.work_order_id || null, str(l.description), str(l.unit) || 'nos',
        qty, rate, qty * rate, str(l.remarks));
    }
    return mbId;
  });
  const mbId = tx();

  logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'proj_mb_sheets',
    entity_id: mbId, entity_label: mbNo, before: null, after: { ...b, mb_no: mbNo } });
  res.status(201).json({ id: mbId, mb_no: mbNo });
});

// Locking is one-way — a finalised MB is the immutable snapshot the
// contractor bill is raised against.
router.post('/mb/:id/finalize', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM proj_mb_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'MB sheet not found' });
  if (sheet.status === 'finalised') return res.status(409).json({ error: 'Already finalised.' });
  db.prepare(`UPDATE proj_mb_sheets SET status='finalised', locked_by=?, locked_at=CURRENT_TIMESTAMP,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, req.params.id);
  logAuditEvent({ user: req.user, action: 'UPDATE', entity_type: 'proj_mb_sheets',
    entity_id: sheet.id, entity_label: `${sheet.mb_no} finalised`, before: { status: sheet.status }, after: { status: 'finalised' } });
  res.json({ message: 'MB finalised — it is now locked.' });
});

router.delete('/mb/:id', requirePermission('indent_labour_payment', 'edit'), (req, res) => {
  const db = getDb();
  const sheet = db.prepare('SELECT * FROM proj_mb_sheets WHERE id=?').get(req.params.id);
  if (!sheet) return res.status(404).json({ error: 'MB sheet not found' });
  if (sheet.status === 'finalised') return res.status(409).json({ error: 'A finalised MB cannot be deleted.' });
  db.prepare('DELETE FROM proj_mb_sheets WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ════════════════════════════════════════════════════════════════
// PHASE 6 — DASHBOARD.  Per-project spend + progress rollup, plus
// "today" — labourers logged and sites that filed daily progress,
// pulled from labour_daily_progress via work_order → project.
// ════════════════════════════════════════════════════════════════
router.get('/dashboard/overview', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const projects = db.prepare(`
    SELECT p.id, p.name,
           (SELECT COALESCE(SUM(amount),0)       FROM proj_salary_entries     WHERE project_id=p.id) AS l1,
           (SELECT COALESCE(SUM(total_amount),0) FROM proj_daily_wage_entries WHERE project_id=p.id) AS l2,
           (SELECT COALESCE(SUM(amount_paid),0)  FROM proj_work_orders        WHERE project_id=p.id) AS l3_paid,
           (SELECT COALESCE(SUM(planned_value),0) FROM proj_work_orders       WHERE project_id=p.id) AS l3_planned,
           (SELECT COUNT(*) FROM proj_work_orders WHERE project_id=p.id) AS wo_count,
           (SELECT COUNT(*) FROM proj_work_orders WHERE project_id=p.id AND status NOT IN ('closed','cancelled')) AS wo_active
      FROM proj_projects p ORDER BY p.name`).all();

  const claimed = db.prepare(`
    SELECT wo.project_id AS project_id, COALESCE(SUM(dwi.amount),0) AS claimed
      FROM dpr_work_items dwi JOIN proj_work_orders wo ON wo.id = dwi.work_order_id
     GROUP BY wo.project_id`).all();
  const claimedByProject = Object.fromEntries(claimed.map(r => [r.project_id, r.claimed]));

  const today = db.prepare(`
    SELECT wo.project_id AS project_id,
           COALESCE(SUM(ldp.labourers_present),0) AS labourers_today,
           COUNT(DISTINCT ldp.site_id) AS sites_reported,
           COALESCE(AVG(ldp.progress_pct),0) AS avg_progress_pct
      FROM labour_daily_progress ldp
      JOIN proj_work_orders wo ON wo.id = ldp.work_order_id
     WHERE ldp.date = DATE('now','localtime')
     GROUP BY wo.project_id`).all();
  const todayByProject = Object.fromEntries(today.map(r => [r.project_id, r]));

  const rows = projects.map(p => {
    const budget = p.l1 + p.l2 + p.l3_paid;
    const claimedAmt = claimedByProject[p.id] || 0;
    const progress_pct = p.l3_planned > 0 ? Math.min(999, Math.round((claimedAmt / p.l3_planned) * 1000) / 10) : 0;
    const t = todayByProject[p.id];
    return {
      id: p.id, name: p.name, budget,
      l3_planned: p.l3_planned, l3_paid: p.l3_paid,
      wo_count: p.wo_count, wo_active: p.wo_active,
      progress_pct,
      today_labourers: t ? t.labourers_today : 0,
      today_sites_reported: t ? t.sites_reported : 0,
      today_avg_progress_pct: t ? Math.round(t.avg_progress_pct) : null,
    };
  });

  res.json({
    projects: rows,
    totals: {
      budget: rows.reduce((s, r) => s + r.budget, 0),
      wo_count: rows.reduce((s, r) => s + r.wo_count, 0),
      today_labourers: rows.reduce((s, r) => s + r.today_labourers, 0),
      today_sites_reported: rows.reduce((s, r) => s + r.today_sites_reported, 0),
    },
  });
});

module.exports = router;
