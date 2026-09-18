// Weekly Score Dashboard
//   Aggregates work given vs work done per employee for a Mon-Sat week.
//   Mam's basic v1 covers 4 modules: Delegations, PMS Tasks, Checklists,
//   Help Tickets. Other categories will be layered on top once she
//   reviews this baseline and shares the full template.
//
// Endpoints:
//   GET /scoring/weekly?week_start=YYYY-MM-DD
//     -> { week_start, week_end, users: [...] }
//        Each user row carries given/done counts for every module plus
//        a total score (0-100) = done * 100 / max(given, 1).
//
//   GET /scoring/weekly/detail?user_id=N&module=X&week_start=YYYY-MM-DD
//     -> drill-down list of the actual rows that fed each cell.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);

// Due-date basis (mam 2026-09-05 "change to due date"): a task belongs to the
// week its CURRENT due date falls in — after any approved extension or manual
// re-date — so the scorecard agrees with the Delegations page's From/To filter
// (which is on due_date). A task with no due date falls back to the week it
// was created, so nothing ever disappears from every week. Replaces the
// created_at cohort of 2026-06-29; snags keep raised_at (mam's verbatim
// formula). Shared by the Scorecard engine, the Weekly team table and its
// detail drill-down — one rule, one number per person on every surface.
// Two boundary rules (pre-push review 2026-09-05):
//  • undated rows fall back to the IST calendar day they were created —
//    created_at is UTC, so a 00:00–05:29 IST creation would otherwise slide
//    to the previous day (same '+330 minutes' shift the snag formula uses);
//  • the scoring week is Mon–Sat, so a SUNDAY due day is folded into the
//    Saturday before it: it belongs to the week that just ended, never to no
//    week at all (it used to be Planned nowhere, then surface as next week's
//    backlog).
// Shared with db/schema.js so the expression INDEXES match these queries
// exactly (hang audit 2026-09-05) — see lib/dueDay.js before editing.
const { dueDay } = require('../lib/dueDay');
const DUE_DELEG = dueDay('due_date'), DUE_PMS = dueDay('due_date'), DUE_TKT = dueDay('deadline_date');
const DUE_FLOW = dueDay('target_date');   // ERP Management (System Flow) v1 (retired)
const DUE_SYSFLOW = dueDay('st.planned_date');   // System Flow v2 steps
// Snag List on the due-date basis too (mam 2026-09-14: "snag list scoring
// evaluate according due date"): the Target Date Mon→Sat, undated snags not
// counted — shared with the Snags page filter so both show the same total.
const DUE_SNAG = require('../lib/dueDay').snagDue();

// ---------- TEMPLATES & KPIs (admin manages) ----------

// List all templates
router.get('/templates', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT t.*, (SELECT COUNT(*) FROM score_kpis k WHERE k.template_id = t.id) as kpi_count,
           (SELECT COUNT(*) FROM score_user_template ut WHERE ut.template_id = t.id) as user_count
    FROM score_templates t WHERE COALESCE(t.active, 1) = 1
    ORDER BY t.name`).all();
  res.json(rows);
});

// Template detail with KPIs
router.get('/templates/:id', (req, res) => {
  const db = getDb();
  const tpl = db.prepare('SELECT * FROM score_templates WHERE id = ?').get(req.params.id);
  if (!tpl) return res.status(404).json({ error: 'Template not found' });
  const kpis = db.prepare(
    'SELECT * FROM score_kpis WHERE template_id = ? AND COALESCE(active,1)=1 ORDER BY display_order, id'
  ).all(req.params.id);
  res.json({ ...tpl, kpis });
});

// Create template
router.post('/templates', adminOnly, (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Name required' });
  const db = getDb();
  try {
    const r = db.prepare('INSERT INTO score_templates (name, description) VALUES (?, ?)').run(name, description || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.put('/templates/:id', adminOnly, (req, res) => {
  const { name, description, active } = req.body;
  getDb().prepare('UPDATE score_templates SET name=COALESCE(?,name), description=COALESCE(?,description), active=COALESCE(?,active) WHERE id=?')
    .run(name || null, description || null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/templates/:id', adminOnly, (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM score_kpis WHERE template_id=?').run(req.params.id);
  db.prepare('DELETE FROM score_user_template WHERE template_id=?').run(req.params.id);
  db.prepare('DELETE FROM score_templates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Add KPI
router.post('/templates/:id/kpis', adminOnly, (req, res) => {
  const { group_name, metric_name, weightage, direction, data_source, display_order } = req.body;
  if (!metric_name) return res.status(400).json({ error: 'metric_name required' });
  const db = getDb();
  const r = db.prepare(
    `INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, group_name || 'Weekly', metric_name, weightage || 0, direction || 'higher_better', data_source || 'manual', display_order || 0);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/kpis/:id', adminOnly, (req, res) => {
  const { group_name, metric_name, weightage, direction, data_source, display_order, active, default_planned } = req.body;
  getDb().prepare(
    `UPDATE score_kpis SET
       group_name=COALESCE(?, group_name),
       metric_name=COALESCE(?, metric_name),
       weightage=COALESCE(?, weightage),
       direction=COALESCE(?, direction),
       data_source=COALESCE(?, data_source),
       display_order=COALESCE(?, display_order),
       active=COALESCE(?, active),
       default_planned=COALESCE(?, default_planned)
     WHERE id=?`
  ).run(
    group_name || null, metric_name || null,
    weightage === undefined ? null : weightage,
    direction || null, data_source || null,
    display_order === undefined ? null : display_order,
    active === undefined ? null : (active ? 1 : 0),
    default_planned === undefined ? null : default_planned,
    req.params.id
  );
  res.json({ message: 'Updated' });
});

router.delete('/kpis/:id', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM score_kpis WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- PER-USER KPI TARGETS ----------
// mam (2026-06-02): "Same target weekly but per-user (different per
// engineer)".  Override of score_kpis.default_planned for a specific
// user — scorecard endpoint reads this first, falls back to template
// default.  Lets the same KPI on the same template carry different
// targets per assigned engineer.

// List overrides for a user (optionally scoped to one template).
router.get('/users/:user_id/kpi-targets', (req, res) => {
  const db = getDb();
  const tplId = req.query.template_id ? +req.query.template_id : null;
  const sql = tplId
    ? `SELECT t.kpi_id, t.planned_value, t.enabled, t.weight_override, t.updated_at,
              k.metric_name, k.default_planned, k.weightage
         FROM score_user_kpi_target t
         JOIN score_kpis k ON k.id = t.kpi_id
        WHERE t.user_id = ? AND k.template_id = ?`
    : `SELECT t.kpi_id, t.planned_value, t.enabled, t.weight_override, t.updated_at,
              k.metric_name, k.default_planned, k.weightage
         FROM score_user_kpi_target t
         JOIN score_kpis k ON k.id = t.kpi_id
        WHERE t.user_id = ?`;
  const params = tplId ? [req.params.user_id, tplId] : [req.params.user_id];
  res.json(db.prepare(sql).all(...params));
});

// Upsert per-user KPI settings — mam (2026-06-02): "every person
// different KPIs".  Body can carry any combination of:
//   planned_value   — target override (null/'' removes override)
//   enabled         — 0 hides this KPI from the user, 1 shows it
//   weight_override — overrides k.weightage for this user, null clears
// If ALL three fields are null/cleared AND enabled defaults back to 1,
// the row is deleted (clean fallback to template defaults).
router.put('/users/:user_id/kpi-targets/:kpi_id', adminOnly, (req, res) => {
  const db = getDb();
  const userId = +req.params.user_id;
  const kpiId = +req.params.kpi_id;
  const b = req.body || {};

  // Read current row so we only patch the supplied fields.  Lets a
  // single-field PUT (e.g. only "enabled") not blow away an earlier
  // planned_value override.
  const cur = db.prepare(
    'SELECT planned_value, enabled, weight_override FROM score_user_kpi_target WHERE user_id=? AND kpi_id=?'
  ).get(userId, kpiId);

  // Normalise inputs
  const clean = (v) => (v == null || v === '') ? null : +v;
  let planned = b.planned_value !== undefined ? clean(b.planned_value) : (cur?.planned_value ?? null);
  let weight  = b.weight_override !== undefined ? clean(b.weight_override) : (cur?.weight_override ?? null);
  let enabled = b.enabled !== undefined
    ? (b.enabled === 0 || b.enabled === false || b.enabled === '0' ? 0 : 1)
    : (cur?.enabled ?? 1);

  // Validation
  if (planned != null && (!Number.isFinite(planned) || planned < 0)) {
    return res.status(400).json({ error: 'planned_value must be a non-negative number' });
  }
  if (weight != null && (!Number.isFinite(weight) || weight < 0 || weight > 100)) {
    return res.status(400).json({ error: 'weight_override must be between 0 and 100' });
  }

  // Zero-state cleanup: enabled=1 + no overrides → delete the row to
  // keep the table sparse + readers happy with simple "row exists =
  // user has customisations".
  if (enabled === 1 && planned == null && weight == null) {
    db.prepare('DELETE FROM score_user_kpi_target WHERE user_id=? AND kpi_id=?').run(userId, kpiId);
    return res.json({ message: 'Override removed — falls back to template defaults' });
  }

  db.prepare(
    `INSERT INTO score_user_kpi_target (user_id, kpi_id, planned_value, enabled, weight_override, updated_by)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, kpi_id) DO UPDATE SET
       planned_value   = excluded.planned_value,
       enabled         = excluded.enabled,
       weight_override = excluded.weight_override,
       updated_by      = excluded.updated_by,
       updated_at      = CURRENT_TIMESTAMP`
  ).run(userId, kpiId, planned == null ? 0 : planned, enabled, weight, req.user.id);
  res.json({
    message: 'Saved',
    user_id: userId, kpi_id: kpiId,
    planned_value: planned, enabled, weight_override: weight,
  });
});

// ---------- ASSIGNMENTS ----------
// List all users with their assigned template
router.get('/assignments', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT u.id as user_id, u.name, u.role, u.department,
           ut.template_id, t.name as template_name
    FROM users u
    LEFT JOIN score_user_template ut ON ut.user_id = u.id
    LEFT JOIN score_templates t ON t.id = ut.template_id
    WHERE COALESCE(u.active, 1) = 1
    ORDER BY u.name`).all();
  res.json(rows);
});

router.put('/assignments/:user_id', adminOnly, (req, res) => {
  const { template_id } = req.body;
  const db = getDb();
  if (template_id) {
    db.prepare(`INSERT INTO score_user_template (user_id, template_id, assigned_by)
                VALUES (?, ?, ?)
                ON CONFLICT(user_id) DO UPDATE SET template_id=excluded.template_id, assigned_at=CURRENT_TIMESTAMP, assigned_by=excluded.assigned_by`)
      .run(req.params.user_id, template_id, req.user.id);
  } else {
    db.prepare('DELETE FROM score_user_template WHERE user_id=?').run(req.params.user_id);
  }
  res.json({ message: 'Saved' });
});

// ---------- MODULE OWNERS ----------
// mam decides the accountable owner + backup per ERP module group, surfaced in
// the War Room QQTC "Module Audit" tab. A row here overrides the authored
// recommendation; clearing both removes the row (falls back to the default).
router.get('/module-owners', (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT mo.module_key, mo.owner_user_id, ou.name AS owner_name,
           mo.backup_user_id, bu.name AS backup_name, mo.updated_at
    FROM module_owners mo
    LEFT JOIN users ou ON ou.id = mo.owner_user_id
    LEFT JOIN users bu ON bu.id = mo.backup_user_id`).all();
  res.json(rows);
});

router.put('/module-owners/:key', adminOnly, (req, res) => {
  const db = getDb();
  const o = req.body.owner_user_id ? +req.body.owner_user_id : null;
  const b = req.body.backup_user_id ? +req.body.backup_user_id : null;
  const key = String(req.params.key || '').slice(0, 60);
  if (!key) return res.status(400).json({ error: 'module key required' });
  if (!o && !b) {
    db.prepare('DELETE FROM module_owners WHERE module_key=?').run(key);
    return res.json({ message: 'Cleared' });
  }
  db.prepare(`INSERT INTO module_owners (module_key, owner_user_id, backup_user_id, updated_by, updated_at)
              VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
              ON CONFLICT(module_key) DO UPDATE SET
                owner_user_id=excluded.owner_user_id,
                backup_user_id=excluded.backup_user_id,
                updated_by=excluded.updated_by,
                updated_at=CURRENT_TIMESTAMP`)
    .run(key, o, b, req.user.id);
  res.json({ message: 'Saved' });
});

// ---------- SCORECARD ----------
// GET full scorecard for a user × week (with auto-fill from delegations/pms/etc.)
// ---------- SCORECARD CORE (reusable) ----------
// Role-normalized weekly score for ONE user measured against THEIR OWN
// template targets. Extracted from the /scorecard route so the Champions
// League gamification module can rank the very same scores without
// duplicating any of the KPI math below.
// opts (all optional):
//   templateId — score THIS template's KPIs for the user instead of the one
//                assigned to them (the template editor previews a template
//                before anyone is assigned, and needs `target_auto` per KPI)
//   allKpis    — ignore the per-user enabled=0 switch (editor shows every row)
function computeScorecard(db, userId, weekStart, opts = {}) {
    // Find user's template
    const ut = opts.templateId
      ? { template_id: opts.templateId }
      : db.prepare('SELECT template_id FROM score_user_template WHERE user_id=?').get(userId);
    if (!ut) {
      return { user_id: userId, week_start: weekStart, template: null, kpis: [], score: 0, total_weight: 0, activity: 0, message: 'No template assigned to this user yet' };
    }
    const tpl = db.prepare('SELECT * FROM score_templates WHERE id=?').get(ut.template_id);
    if (!tpl) {
      return { user_id: userId, week_start: weekStart, template: null, kpis: [], score: 0, total_weight: 0, activity: 0, message: 'Template not found' };
    }
    const kpis = db.prepare('SELECT * FROM score_kpis WHERE template_id=? AND COALESCE(active,1)=1 ORDER BY display_order, id').all(ut.template_id);

    const lastWeekStart = shiftWeek(weekStart, -7);
    const startTs = `${weekStart} 00:00:00`;
    const endTs = `${shiftWeek(weekStart, 5)} 23:59:59`;
    const lastStartTs = `${lastWeekStart} 00:00:00`;
    const lastEndTs = `${shiftWeek(lastWeekStart, 5)} 23:59:59`;

    // Helper: list site_ids where this user is the assigned site engineer
    // OR supervisor. Three sources combined:
    //   sites.site_engineer_id           (direct linkage on the sites table)
    //   sites.supervisor_id              (added 2026-05-04 for supervisor MIS)
    //   sites.supervisor TEXT (legacy)   matched by user.name
    //   purchase_orders.site_engineer_id (CSV via site_engineer_ids too) →
    //                                    sites are linked through po.id
    const userName = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || '';
    const siteIdsForUser = () => {
      const rows = db.prepare(`
        SELECT id FROM sites WHERE site_engineer_id = ? OR supervisor_id = ?
        UNION
        SELECT id FROM sites WHERE LOWER(TRIM(COALESCE(supervisor,''))) = LOWER(TRIM(?))
        UNION
        SELECT s.id FROM sites s
        JOIN purchase_orders po ON po.id = s.po_id
        WHERE po.site_engineer_id = ?
           OR (',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ?
      `).all(userId, userId, userName, userId, `%,${userId},%`);
      return rows.map(r => r.id).filter(Boolean);
    };

    let _raciAgg; // memoized RACI aggregate for this user/week — both raci sources reuse it
    let _raciBreakdown; // memoized per-(module,step) RACI breakdown — per-step KPIs reuse it
    const computeAutoCount = (source, since, until) => {
      const sinceDate = since.slice(0, 10);
      const untilDate = until.slice(0, 10);

      // mam 2026-06-29: count Planned vs Actual on the SAME cohort — tasks
      // ASSIGNED this week, and of those how many reached the done status — so
      // Actual can never exceed Planned. The old logic counted ANY task completed
      // this week (including ones assigned in earlier weeks), which gave the
      // confusing 5-given / 11-done case on Monika's Delegation row.
      // Due-date basis (2026-09-05): Planned = tasks DUE this week, Actual = of
      // those, done. Same cohort both sides, so Actual <= Planned still holds.
      if (source === 'auto:delegations') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND ${DUE_DELEG} BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND ${DUE_DELEG} BETWEEN ? AND ? AND status='approved'`).get(userId, sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:pms') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND ${DUE_PMS} BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND ${DUE_PMS} BETWEEN ? AND ? AND status='approved'`).get(userId, sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:tickets') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND ${DUE_TKT} BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND ${DUE_TKT} BETWEEN ? AND ? AND status IN ('resolved','closed')`).get(userId, sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:checklists') {
        // Frequency-aware planned (mam 2026-08-31: the old ×6 assumed every
        // checklist is DAILY — a monthly task inflated the week's plan by 6).
        // Planned = Σ per checklist of the days it actually fires Mon–Sat.
        // Days the person was absent / on leave drop out of the plan too, so
        // nobody is scored against a day they were not at work (mam 2026-09-12).
        const { weeklyExpected, absenceSet, weekDates } = require('../lib/checklistFrequency');
        const ckls = db.prepare(`SELECT assigned_to, frequency, due_date, fortnight_days, recurrence_start_date, recurrence_end_date, created_at
                                   FROM checklists WHERE assigned_to=? AND COALESCE(active,1)=1`).all(userId);
        const cklAway = absenceSet(db, weekDates(sinceDate));
        const given = ckls.reduce((s, c) => s + weeklyExpected(c, sinceDate, cklAway), 0);
        const done = db.prepare(`SELECT COUNT(*) as c FROM checklist_completions WHERE user_id=? AND completion_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        return { given, done };
      }
      // Snag List — SAME shape and SAME position as delegations (mam
      // 2026-08-12: "u do snaglist same as delegation").  MUST stay above the
      // site-scope gate further down: snags are per-assignee like delegations,
      // not site-scoped, and when this block sat below the gate every user
      // with no site mapping silently read 0/0.
      // Formula: Plan = snags DUE this week (target_date) AND assigned = user;
      // Actual = same + status='approved' (current status only, NO
      // approved_at window — a later approval still counts toward the due
      // week).  Due-date basis since 2026-09-14 (was raise date): Target
      // Date Mon→Sat, snags with no Target Date not counted — the same
      // window as the Snags page Due From/To filter (see DUE_SNAG).
      // Tolerant assignee match (mam 2026-08-13 "ur calculation is wrong"):
      // app-created rows link assigned_to = users.id, but imported/WhatsApp
      // rows carry only the NAME (either in assigned_to_name with a NULL id,
      // or the name string sitting in the id column itself) — match all three.
      if (source === 'auto:snags') {
        const uname = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || '';
        const who = `(assigned_to=? OR (assigned_to IS NULL AND assigned_to_name=?) OR CAST(assigned_to AS TEXT)=?)`;
        const given = db.prepare(
          `SELECT COUNT(*) as c FROM snags WHERE ${who} AND ${DUE_SNAG} BETWEEN ? AND ?`
        ).get(userId, uname, uname, sinceDate, untilDate).c;
        const done = db.prepare(
          `SELECT COUNT(*) as c FROM snags WHERE ${who} AND ${DUE_SNAG} BETWEEN ? AND ? AND status='approved'`
        ).get(userId, uname, uname, sinceDate, untilDate).c;
        return { given, done };
      }

      // ── Owner / company-wide variants — for a PROCESS OWNER scored on the
      // WHOLE process, not just their own records (mam 2026-06-29: Sushila owns
      // ALL PMS). Same same-week cohort as the by-user versions, no assigned_to.
      if (source === 'auto:pms_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE ${DUE_PMS} BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE ${DUE_PMS} BETWEEN ? AND ? AND status='approved'`).get(sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:delegations_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE ${DUE_DELEG} BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE ${DUE_DELEG} BETWEEN ? AND ? AND status='approved'`).get(sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:tickets_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE ${DUE_TKT} BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE ${DUE_TKT} BETWEEN ? AND ? AND status IN ('resolved','closed')`).get(sinceDate, untilDate).c;
        return { given, done };
      }
      if (source === 'auto:snags_all') {
        // Company-wide twin of auto:snags — same formula, no assignee filter.
        // Kept beside the other *_all owner sources, above the site gate.
        // Same due-day basis as auto:snags so both views bucket a snag into
        // the same week.
        const given = db.prepare(`SELECT COUNT(*) as c FROM snags WHERE ${DUE_SNAG} BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM snags WHERE ${DUE_SNAG} BETWEEN ? AND ? AND status='approved'`).get(sinceDate, untilDate).c;
        return { given, done };
      }
      // ERP module coverage — how many of the tracked modules had ANY activity
      // this week (mam 2026-06-29: Anmol owns the whole ERP — "is the system
      // running"). Planned = modules tracked, Actual = modules active, so all
      // modules busy = 0% (on plan); a quiet module pulls the score down.
      if (source === 'auto:erp_module_coverage') {
        const tables = ['delegations','pms_tasks','support_tickets','indents','vendor_pos','purchase_bills','sales_bills','collections','dpr','leads','quotations'];
        let active = 0;
        for (const t of tables) {
          try { if (db.prepare(`SELECT COUNT(*) as c FROM ${t} WHERE created_at BETWEEN ? AND ?`).get(since, until).c > 0) active += 1; }
          catch (e) { /* table missing on this DB — skip */ }
        }
        return { given: tables.length, done: active };
      }
      // Itemwise total complete — of all indent line-items, how many are fully
      // PROCURED (have a vendor PO raised, po_item_id set) — mam 2026-06-29
      // ("itemwise total complete score"). Cumulative, company-wide. Planned =
      // total items, Actual = items with a PO. ("Received" isn't usable — all
      // deliveries are still 'pending'; switch to stock_movement_id once they're
      // marked received.)
      if (source === 'auto:items_complete') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM indent_items`).get().c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM indent_items WHERE po_item_id IS NOT NULL`).get().c;
        return { given, done };
      }

      // Site manpower — company-wide staffing fill: REQUIRED manpower (value slab,
      // all projects) as Plan vs ACTUAL on site (DPR average) as Actual. Reads the
      // SAME numbers as the HR → Manpower Plan page (mam 2026-07-04: "site manpower
      // report pick from the manpower page — plan 232, actual 56"). Not time-scoped
      // — a current staffing snapshot each week (like items_complete).
      if (source === 'auto:site_manpower') {
        try {
          const { manpowerTotals } = require('../lib/manpowerPlan');
          const t = manpowerTotals(db);
          return { given: t.required, done: t.actual };
        } catch (e) { return { given: null, done: null }; }
      }

      // Attrition — staff who have LEFT. mam 2026-07-04 chose "just count who left"
      // (no hire compare): Actual = count of inactive/terminated employees. The
      // employees table has no exit-date, so this is an ALL-TIME count, not weekly
      // (flagged to mam; add an exit-date field later for a true weekly number).
      // Plan stays the manual target (given:null) — set the acceptable max; use a
      // lower_better KPI so fewer leavers scores higher.
      if (source === 'auto:attrition') {
        try {
          const done = db.prepare(`SELECT COUNT(*) c FROM employees WHERE status IN ('inactive','terminated')`).get().c;
          return { given: null, done };
        } catch (e) { return { given: null, done: null }; }
      }

      // Daily Active users — system engagement (mam 2026-07-04: "daily active =
      // average of week, actual user vs active user"). Plan = total registered
      // (active) users; Actual = AVERAGE across the week's days of the distinct
      // users who touched the system (audit_log). Company-wide (an owner KPI).
      if (source === 'auto:daily_active_users') {
        try {
          const given = db.prepare(`SELECT COUNT(*) c FROM users WHERE COALESCE(active,1)=1`).get().c;
          const row = db.prepare(`SELECT AVG(cnt) a FROM (SELECT date(at) d, COUNT(DISTINCT user_id) cnt FROM audit_log WHERE at BETWEEN ? AND ? GROUP BY date(at))`).get(since, until);
          const done = row && row.a != null ? Math.round(row.a) : 0;
          return { given, done };
        } catch (e) { return { given: null, done: null }; }
      }

      // Compliance Monitoring KPI (Nancy / Compliance Officer)
      // Weighted 100%: 30% On-time SLA, 30% Closure, 20% Task follow-up, 20% Field-location follow-up
      if (source === 'auto:compliance_monitoring') {
        try {
          const { calculateComplianceKpi } = require('../services/complianceService');
          const kpi = calculateComplianceKpi(since, until, db);
          return { given: 100, done: kpi.overallKpi };
        } catch (e) { return { given: 100, done: 100 }; }
      }

      // Data Entry volume — total records entered company-wide this week (mam
      // 2026-07-04: "data entry ... total words enter", target e.g. 300000).
      // audit_log stores ACTIONS not word counts, so this counts the CREATE/
      // UPDATE/DELETE records everyone entered. Plan stays your manual target.
      if (source === 'auto:data_entry_all') {
        try {
          const done = db.prepare(`SELECT COUNT(*) c FROM audit_log WHERE at BETWEEN ? AND ? AND action IN ('CREATE','UPDATE','DELETE') AND COALESCE(status_code,200) < 400`).get(since, until).c;
          return { given: null, done };
        } catch (e) { return { given: null, done: null }; }
      }

      // Data completeness — QUALITY of data entry, not volume (mam 2026-09-03:
      // "count this ... like data completion and want to take in data entry
      // score"). auto:data_entry_all above counts how MANY records were touched;
      // this scores how much of the required data is actually filled.
      //
      // Plan = every required field across every record (Item Master, Business
      // Book, Employees, Users); Actual = the ones filled. So the score IS the
      // completion percentage the bars on those pages show — same library, so
      // the KPI can never disagree with the screen.
      //
      // Deliberately NOT week-scoped: it is a standing snapshot of the whole
      // dataset, like auto:items_complete and auto:site_manpower. A week where
      // nothing is fixed scores the same as the week before, which is the point
      // — the backlog stays visible until it is actually cleared.
      if (source === 'auto:data_completeness') {
        try {
          const { completionAll } = require('../lib/dataCompletion');
          const all = completionAll(db);
          return { given: all.required_total, done: all.filled_total };
        } catch (e) { return { given: null, done: null }; }
      }
      // One module's completeness on its own — auto:data_completeness:<module>,
      // e.g. auto:data_completeness:business_book, for scoring a person who owns
      // just that register.
      if (source.startsWith('auto:data_completeness:')) {
        try {
          const { completionFor } = require('../lib/dataCompletion');
          const c = completionFor(db, source.slice('auto:data_completeness:'.length));
          if (!c) return { given: null, done: null };
          return { given: c.required_total, done: c.filled_total };
        } catch (e) { return { given: null, done: null }; }
      }

      // ── Responsibility (RACI / SLA) — cross-module per-person accountability ──
      // Steps where the user is the EXPLICIT RACI Responsible (per-record, else
      // whole-module default) across every module. Computed once per user, shared.
      if (source === 'auto:raci_steps_done' || source === 'auto:raci_ontime_pct') {
        if (_raciAgg === undefined) {
          try { _raciAgg = require('../utils/raciModules').raciUserWeek(db, userId, sinceDate, untilDate); }
          catch (e) { _raciAgg = { stepsClosed: 0, slaJudged: 0, onTime: 0, openOnUser: 0, openBefore: 0, closedBefore: 0, stepsPlanned: 0 }; }
        }
        // Planned = steps on their plate this week (closed this week + still open
        // on them); Actual = steps they closed this week. So % = how much of the
        // RACI work assigned to this person they have finished (mam 2026-06-27).
        if (source === 'auto:raci_steps_done') return { given: _raciAgg.stepsPlanned, done: _raciAgg.stepsClosed, openBefore: _raciAgg.openBefore || 0, closedBefore: _raciAgg.closedBefore || 0 };
        // On-time %: only meaningful when the user closed SLA-bearing steps this
        // week. Otherwise stay neutral (planned 0 → 0%) so an idle week neither
        // tanks the score nor falsely qualifies for the activity gate.
        if (_raciAgg.stepsClosed === 0 || _raciAgg.slaJudged === 0) return { given: 0, done: 0, typedTarget: true };
        return { given: null, done: Math.round((_raciAgg.onTime / _raciAgg.slaJudged) * 100) };
      }

      // Per-step RACI KPI — auto:raci_step:<module>:<stepKey>. Planned/Actual for
      // ONE specific step (e.g. indent_to_dispatch → l1) for the person this
      // scorecard belongs to, where they are the RACI Responsible for that step.
      // Reuses the same per-(module,step) breakdown as the scorecard drill-down,
      // memoized per user (mam 2026-06-27: "in template pick step-wise which
      // person I select in RACI").
      if (source.startsWith('auto:raci_step:')) {
        if (_raciBreakdown === undefined) {
          try { _raciBreakdown = require('../utils/raciModules').raciUserWeekBreakdown(db, userId, sinceDate, untilDate); }
          catch (e) { _raciBreakdown = []; }
        }
        const rest = source.slice('auto:raci_step:'.length);
        const ci = rest.indexOf(':');
        const mod = ci >= 0 ? rest.slice(0, ci) : rest;
        const stepKey = ci >= 0 ? rest.slice(ci + 1) : '';
        const row = _raciBreakdown.find(r => r.module === mod && r.step_key === stepKey);
        return row
          ? { given: row.planned, done: row.actual, openBefore: row.pending_before || 0, closedBefore: row.closed_before || 0 }
          : { given: 0, done: 0, openBefore: 0, closedBefore: 0 };
      }

      // ── ERP Management (System Flow) — the ERP build itself, per DEVELOPER ──
      // mam 2026-09-07: "ERP Management also show here" … "not as RACI —
      // according to developer": a person's System Flow KPI counts the steps
      // where they are the DEVELOPER column (the one building it), never the
      // RACI-style Owner/Responsible. Same due-date basis as Tasks & Tickets:
      // a step is PLANNED in the week its target date falls (no target → the
      // week it was created; a Sunday folds to the Saturday before), ACTUAL =
      // of those, completed. Cancelled steps are out of both sides. Pending
      // carry-over comes from CARRY_CFG below.
      // ── ERP Management (System Flow) — v2 tables ──────────────────────
      // Repointed 2026-09-08. These read sysflow_flows until the module was
      // rebuilt; that table is now permanently empty, and an empty table is NOT
      // neutral here — computeScore turns 0 planned + 0 actual into actualPct
      // 100, so all seven rows were about to score full marks for everyone.
      // Attribution stays per-person on the STEP OWNER (v2 has no separate
      // developer column; the owner is who actually holds that step).
      const SYS_FROM = `FROM sysflow_system_steps st
                          JOIN sysflow_systems sy ON sy.id = st.system_id AND sy.active = 1`;

      if (source === 'auto:sysflow_steps' || source === 'auto:sysflow_all') {
        // Steps DUE in the window, and how many of those are done.
        const who = source === 'auto:sysflow_steps' ? 'st.owner_id=? AND ' : '';
        const args = who ? [userId] : [];
        const given = db.prepare(`SELECT COUNT(*) c ${SYS_FROM}
           WHERE ${who}st.planned_date IS NOT NULL AND ${DUE_SYSFLOW} BETWEEN ? AND ?`)
          .get(...args, sinceDate, untilDate).c;
        const done = db.prepare(`SELECT COUNT(*) c ${SYS_FROM}
           WHERE ${who}st.actual_date IS NOT NULL AND st.planned_date IS NOT NULL
             AND ${DUE_SYSFLOW} BETWEEN ? AND ?`)
          .get(...args, sinceDate, untilDate).c;
        return { given, done };
      }

      if (source === 'auto:sysflow_ontime_pct') {
        // Of the steps the user COMPLETED this week, the % finished on or before
        // their planned date. Nothing completed → neutral 0/0 with the typed target.
        const r = db.prepare(`
          SELECT COUNT(*) n,
                 SUM(CASE WHEN date(st.actual_date) <= date(st.planned_date) THEN 1 ELSE 0 END) ok
            ${SYS_FROM}
           WHERE st.owner_id=? AND st.actual_date IS NOT NULL AND st.planned_date IS NOT NULL
             AND date(st.actual_date) BETWEEN ? AND ?`).get(userId, sinceDate, shiftWeek(sinceDate, 6));
        if (!r || !r.n) return { given: 0, done: 0, typedTarget: true };
        return { given: null, done: Math.round((r.ok / r.n) * 100) };
      }

      if (source === 'auto:sysflow_overdue') {
        // Steps the user holds that were overdue AT THE WEEK END, so a past week
        // reads what it was. Pair with "↓ lower better".
        const weekEnd = shiftWeek(sinceDate, 6);
        const n = db.prepare(`SELECT COUNT(*) c ${SYS_FROM}
           WHERE st.owner_id=? AND st.planned_date IS NOT NULL
             AND date(st.planned_date) < ?
             AND (st.actual_date IS NULL OR date(st.actual_date) > ?)`)
          .get(userId, weekEnd, weekEnd).c;
        return { given: null, done: n };
      }

      if (source === 'auto:sysflow_blocked') {
        // v2 has no 'blocked' status. The honest equivalent is work the person
        // CANNOT START: their step is open and the step in front of it is itself
        // open and already past its planned date — they are held up by someone
        // else's late step. Pair with "↓ lower better".
        const weekEnd = shiftWeek(sinceDate, 6);
        const n = db.prepare(`SELECT COUNT(*) c ${SYS_FROM}
           WHERE st.owner_id=? AND st.actual_date IS NULL
             AND EXISTS (SELECT 1 FROM sysflow_system_steps prev
                          WHERE prev.system_id = st.system_id
                            AND prev.step_no = st.step_no - 1
                            AND prev.actual_date IS NULL
                            AND prev.planned_date IS NOT NULL
                            AND date(prev.planned_date) < ?)`)
          .get(userId, weekEnd).c;
        return { given: null, done: n };
      }

      if (source === 'auto:sysflow_updates') {
        // Work the user logged this IST week. STEP_DONE and EDIT are work;
        // CREATE / BULK_CREATE are planning and stay out, as in v1 — registering
        // 20 systems from a sheet is not 20 updates.
        const n = db.prepare(`
          SELECT COUNT(*) c FROM sysflow_system_activity
           WHERE user_id=? AND action IN ('STEP_DONE','EDIT')
             AND date(created_at, '+330 minutes') BETWEEN ? AND ?`)
          .get(userId, sinceDate, shiftWeek(sinceDate, 6)).c;
        return { given: null, done: n };
      }

      if (source === 'auto:sysflow_progress_pct') {
        // Company-wide ERP implementation progress at the week end: steps done
        // on/before Sunday ÷ steps that existed by Sunday.
        const weekEnd = shiftWeek(sinceDate, 6);
        const r = db.prepare(`
          SELECT COUNT(*) n,
                 SUM(CASE WHEN st.actual_date IS NOT NULL AND date(st.actual_date) <= ? THEN 1 ELSE 0 END) done
            ${SYS_FROM}
           WHERE date(sy.created_at, '+330 minutes') <= ?`).get(weekEnd, weekEnd);
        if (!r || !r.n) return { given: 0, done: 0, typedTarget: true };
        return { given: null, done: Math.round((r.done / r.n) * 100) };
      }

      // Site-scoped KPIs (Site Engineer / Supervisor templates) need the list
      // of sites this user manages. ONLY those ten sources are gated: this
      // early return used to sit in front of EVERY source below it, so a user
      // with no site mapping (HR, sales, accounts…) read 0/0 = "on plan" for
      // candidates shortlisted, leads created, amount received — 57 sources
      // silently scored 100% (found 2026-09-05 while wiring target_auto: every
      // Actual on the HR Executive template showed 0).
      const SITE_SCOPED = new Set([
        'auto:dpr_count', 'auto:dpr_profit', 'auto:indent_vs_bill', 'auto:indents_in_week',
        'auto:material_received', 'auto:mb_signed', 'auto:ra_bills',
        'auto:stock_at_site', 'auto:stock_updates', 'auto:tools_list',
      ]);
      let siteIds = [], inSites = '(NULL)';
      if (SITE_SCOPED.has(source)) {
        siteIds = siteIdsForUser();
        if (siteIds.length === 0) {
          // No sites mapped to this user → can't aggregate. Return zero.
          return { given: 0, done: 0 };
        }
        inSites = `(${siteIds.join(',')})`;
      }

      if (source === 'auto:dpr_profit') {
        // Planned = sum of grand_total_b (planned cost) × 1.5, Actual = sum
        // of grand_total_a (actual revenue).  Mam 2026-08-13: "weekly dpr
        // cost 1 plann cost (DPR table) if 1 than here calculate 1.5" — the
        // revenue TARGET is 1.5× the planned cost, so a site is on plan only
        // when it bills one-and-a-half times what it planned to spend.
        const r = db.prepare(`SELECT COALESCE(SUM(grand_total_b),0) as planned, COALESCE(SUM(grand_total_a),0) as actual FROM dpr WHERE site_id IN ${inSites} AND report_date BETWEEN ? AND ?`).get(sinceDate, untilDate);
        return { given: Math.round(r.planned * 1.5 * 100) / 100, done: r.actual };
      }
      if (source === 'auto:dpr_count') {
        // DPRs submitted this week (planned = 6 days, actual = count)
        const c = db.prepare(`SELECT COUNT(*) as c FROM dpr WHERE site_id IN ${inSites} AND report_date BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        return { given: 6, done: c };
      }
      if (source === 'auto:indents_in_week') {
        // Indents created in the week for this user's site(s). indents carries
        // site_name (TEXT), NOT site_id — match by name (the old site_id query
        // silently returned nothing). No per-week target → planned=actual so %=0.
        const c = db.prepare(`SELECT COUNT(*) as c FROM indents WHERE created_at BETWEEN ? AND ?
          AND LOWER(TRIM(COALESCE(site_name,''))) IN (SELECT LOWER(TRIM(name)) FROM sites WHERE id IN ${inSites})`).get(since, until).c;
        return { given: c, done: c };
      }
      // Indent vs Bill — indents RAISED vs sales bills GENERATED for this site
      // engineer's site(s) this week (mam 2026-06-29: "how much indent raise and
      // sales bill generate"). Planned = indents raised, Actual = sales bills.
      // Both link to the site by NAME: indents.site_name and sales_bills.project_name
      // matched to sites.name (sales bills carry project_name, not site_id/po_id).
      if (source === 'auto:indent_vs_bill') {
        const indents = db.prepare(`SELECT COUNT(*) as c FROM indents WHERE created_at BETWEEN ? AND ?
          AND LOWER(TRIM(COALESCE(site_name,''))) IN (SELECT LOWER(TRIM(name)) FROM sites WHERE id IN ${inSites})`).get(since, until).c;
        const bills = db.prepare(`SELECT COUNT(*) as c FROM sales_bills WHERE created_at BETWEEN ? AND ?
          AND LOWER(TRIM(COALESCE(project_name,''))) IN (SELECT LOWER(TRIM(name)) FROM sites WHERE id IN ${inSites})`).get(since, until).c;
        return { given: indents, done: bills };
      }
      if (source === 'auto:mb_signed') {
        // MB bills approved (client-signed proxy) / total raised in the week.
        // mb_bills doesn't carry site_id — joined via installation_id →
        // installations.po_id → sites.po_id.
        const total = db.prepare(`
          SELECT COUNT(DISTINCT mb.id) as c FROM mb_bills mb
          JOIN installations i ON i.id = mb.installation_id
          JOIN sites s ON s.po_id = i.po_id
          WHERE s.id IN ${inSites} AND mb.created_at BETWEEN ? AND ?
        `).get(since, until).c;
        const signed = db.prepare(`
          SELECT COUNT(DISTINCT mb.id) as c FROM mb_bills mb
          JOIN installations i ON i.id = mb.installation_id
          JOIN sites s ON s.po_id = i.po_id
          WHERE s.id IN ${inSites} AND mb.created_at BETWEEN ? AND ? AND mb.status = 'approved'
        `).get(since, until).c;
        return { given: total, done: signed };
      }
      if (source === 'auto:ra_bills') {
        // RA bills raised in the week — joined via installation_id → po → sites
        const c = db.prepare(`
          SELECT COUNT(DISTINCT r.id) as c FROM ra_bills r
          JOIN installations i ON i.id = r.installation_id
          JOIN sites s ON s.po_id = i.po_id
          WHERE s.id IN ${inSites} AND r.created_at BETWEEN ? AND ?
        `).get(since, until).c;
        return { given: 3, done: c }; // SEPL target = 3/week per Indresh template
      }
      if (source === 'auto:stock_at_site') {
        // Latest non-zero stock at any of this user's sites — binary flag
        const c = db.prepare(`SELECT COUNT(*) as c FROM stock_movements WHERE site_id IN ${inSites} AND quantity > 0`).get().c;
        return { given: 1, done: c > 0 ? 1 : 0 };
      }
      // Supervisor template: DPR Daily Actual = count of DPRs SUBMITTED
      // BY this user during the week (not by site). Mam: "from as per
      // date and as per user name count which dpr submit".
      if (source === 'auto:dpr_by_user') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM dpr WHERE submitted_by = ? AND report_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        return { given: 6, done: c }; // 6 working days target
      }
      // Sum of profit_loss across DPRs submitted BY this user in the week.
      // Mam: "if dpr is one count then why not profit or loss show" —
      // pulls the profit number directly off the DPR rows.
      if (source === 'auto:dpr_profit_by_user') {
        const r = db.prepare(`SELECT COALESCE(SUM(profit_loss),0) as p FROM dpr WHERE submitted_by = ? AND report_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate);
        // planned defaults to the row's default_planned (set by admin),
        // actual = sum of profit_loss across this user's DPRs.
        return { given: null, done: r.p }; // given=null preserves the
        // template's default_planned target as the comparison base.
      }
      // DPR Cost Accuracy = how many DPRs submitted vs how many approved.
      // Mam: "dpr cost is who much dpr submit vs approval".
      // Planned = submitted count (denominator), Actual = approved count
      // (numerator). Score = ((approved - submitted) / submitted) × 100,
      // so all-approved = 0% (on plan), rejections drag the score
      // negative.
      if (source === 'auto:dpr_cost_by_user') {
        const submitted = db.prepare(
          `SELECT COUNT(*) as c FROM dpr
           WHERE submitted_by = ? AND report_date BETWEEN ? AND ?`
        ).get(userId, sinceDate, untilDate).c;
        const approved = db.prepare(
          `SELECT COUNT(*) as c FROM dpr
           WHERE submitted_by = ? AND report_date BETWEEN ? AND ?
             AND approval_status = 'approved'`
        ).get(userId, sinceDate, untilDate).c;
        return { given: submitted, done: approved };
      }
      // Material Receiving: how many vendor PO deliveries were received
      // at this user's sites this week. Mam: "indent to dispatch user
      // assign as per site name week how much dispatch & rec".
      if (source === 'auto:material_received') {
        // indents doesn't have site_id — match via site_name (TEXT) → sites.name
        const total = db.prepare(`
          SELECT COUNT(DISTINCT dn.id) as c FROM delivery_notes dn
          JOIN vendor_pos vp ON vp.id = dn.vendor_po_id
          JOIN indents ind ON ind.id = vp.indent_id
          JOIN sites s ON LOWER(TRIM(s.name)) = LOWER(TRIM(COALESCE(ind.site_name,'')))
          WHERE s.id IN ${inSites}
            AND dn.created_at BETWEEN ? AND ?
        `).get(since, until).c;
        const received = db.prepare(`
          SELECT COUNT(DISTINCT dn.id) as c FROM delivery_notes dn
          JOIN vendor_pos vp ON vp.id = dn.vendor_po_id
          JOIN indents ind ON ind.id = vp.indent_id
          JOIN sites s ON LOWER(TRIM(s.name)) = LOWER(TRIM(COALESCE(ind.site_name,'')))
          WHERE s.id IN ${inSites}
            AND dn.created_at BETWEEN ? AND ?
            AND dn.status = 'received'
        `).get(since, until).c;
        return { given: total, done: received };
      }
      // Stock report accuracy: count of stock movements at user's sites
      // in the week. Target = 1 update per site per week (mam: "stock
      // per week one time update as per site assign").
      if (source === 'auto:stock_updates') {
        const c = db.prepare(`SELECT COUNT(DISTINCT site_id) as c FROM stock_movements WHERE site_id IN ${inSites} AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: siteIds.length, done: c };
      }
      // Tools List submission: count of weekly tools_list_submissions
      // by this user for sites they manage. Target = sites count (one
      // submission per site per week).
      if (source === 'auto:tools_list') {
        const c = db.prepare(`
          SELECT COUNT(DISTINCT site_id) as c FROM tools_list_submissions
          WHERE submitted_by = ? AND site_id IN ${inSites}
            AND week_start = ?
        `).get(userId, sinceDate).c;
        return { given: siteIds.length, done: c };
      }

      // ===== Sales / CRM =====
      if (source === 'auto:leads_created') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:leads_qualified') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE assigned_to=? AND status='qualified' AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:quotations_sent') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM quotations WHERE created_by=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:meetings_planned') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM meetings WHERE meeting_date BETWEEN ? AND ?`).get(sinceDate, untilDate).c;
        return { given: null, done: c };
      }
      // CRM Full Kitting — mam 2026-09-07: "CRM -> only CRM Full kitting".
      // Credits the person named in the tracker's CRM column, not whoever
      // clicked the box: the checkpoints on Consern Pharma were ticked by the
      // Admin login, so the CRM person scored 0 while the tracker showed real
      // progress.
      //   Actual  = checkpoints CURRENTLY complete on her projects — the
      //             append-only history collapsed to the latest status per
      //             (project_key, checkpoint_id), so two edits of one box stay
      //             ONE unit, by the tracker's own rule;
      //   Planned = every ACTIVE checkpoint on those same projects.
      // BOTH sides come from lib/crmKittingProgress and both are standing
      // totals with no week window, so the ratio is "how much of my kitting is
      // finished" and is bounded by 100%. This RETIRES the typed weekly target
      // (120) on purpose: a cumulative count divided by a weekly number has no
      // ceiling, pinned the row above 100% forever and rewrote every past week
      // with today's total. Ownership is crm_kitting_project_meta.crm_owner
      // ONLY — a project with no owner typed counts for nobody, and a name
      // that matches two user accounts counts for nobody either. All three
      // stages roll up into the one number (the tracker's badge is per stage).
      // Owns NO kitting project → null/null, NOT 0/0. The engine reads 0/0 as
      // "nothing to judge, on plan" and scores it a weighted 100% (mam
      // 2026-08-13), which would paint the whole company green the moment this
      // shipped — worse than the 0 she complained about, and target_auto would
      // hide the Target box so she could not type her way out of it. null hands
      // the row back to the manual planned/actual it uses today.
      if (source === 'auto:crm_kitting') {
        try {
          const { kittingProjectsForUser, kittingProgress } = require('../lib/crmKittingProgress');
          const keys = kittingProjectsForUser(db, userId);
          if (!keys.length) return { given: null, done: null };
          const p = kittingProgress(db, keys);
          return { given: p.given, done: p.done };
        } catch (e) { return { given: null, done: null }; }
      }
      // Activity-log data entry — how many create/update/delete actions this
      // user recorded this week, from the live audit trail (mam 2026-07-04).
      // audit_log only records mutations, so it's a clean "data entry" count
      // (LOGIN rows and failed 4xx/5xx requests excluded).
      if (source === 'auto:activity_log') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM audit_log WHERE user_id=? AND at BETWEEN ? AND ? AND action IN ('CREATE','UPDATE','DELETE') AND COALESCE(status_code,200) < 400`).get(userId, since, until).c;
        return { given: null, done: c };
      }

      // ===== Business Book =====
      if (source === 'auto:bb_entries') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM business_book WHERE employee_assigned=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:bb_po_amount') {
        const r = db.prepare(`SELECT COALESCE(SUM(po_amount),0) as s FROM business_book WHERE employee_assigned=? AND created_at BETWEEN ? AND ?`).get(userId, since, until);
        return { given: null, done: r.s };
      }
      if (source === 'auto:bb_sale_amount') {
        const r = db.prepare(`SELECT COALESCE(SUM(sale_amount_without_gst),0) as s FROM business_book WHERE employee_assigned=? AND created_at BETWEEN ? AND ?`).get(userId, since, until);
        return { given: null, done: r.s };
      }
      if (source === 'auto:bb_advance') {
        const r = db.prepare(`SELECT COALESCE(SUM(advance_received),0) as s FROM business_book WHERE employee_assigned=? AND created_at BETWEEN ? AND ?`).get(userId, since, until);
        return { given: null, done: r.s };
      }

      // ===== Procurement =====
      if (source === 'auto:indents_approved') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM indents WHERE approved_by=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:vendor_pos_created') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM vendor_pos WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:purchase_bills') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM purchase_bills WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:dispatch_sent') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM delivery_notes WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // Purchase Bill — mam 2026-09-07: "every approved PO must have a bill".
      // Replaces the RACI step 'indent_to_dispatch:purchase_bill' — the LAST
      // step of that module (utils/raciModules.js:289-305) and therefore
      // always 0: a record is pending at only the FIRST unstamped step, so
      // every step in front of it absorbed the pipeline. Its rows are INDENTS
      // and the bill stamp joins purchase_bills → vendor_pos → indent_id, so
      // a PO with indent_id NULL was invisible to it anyway.
      // This is a COMPLIANCE ratio, not a weekly throughput, because that is
      // what mam's rule is: every approved PO must have a bill. Planned and
      // Actual are therefore the SAME cohort, measured as at the week end:
      //   Planned = every PO due a bill by the week end (approved, not cancelled);
      //   Actual  = of those, the ones that HAVE a bill by the week end.
      // Pending "up" is then Planned − Actual (computed further down), which is
      // byte-for-byte the Procurement flow board's Purchase Bill count — the
      // two screens cannot drift apart because they are the same subtraction.
      //   closedBefore = backlog actually cleared this week (POs approved before
      //                  the week whose FIRST bill landed inside it) → Pending "wk".
      // Two cohorts was the earlier mistake: Planned = approved-this-week against
      // Actual = billed-this-week meant a week spent clearing old bills scored
      // Planned 0 / Actual 3, which the engine reads as 0% — clearing the backlog
      // scored WORSE than doing nothing, and the leftover POs vanished from every
      // column. One cohort makes the row monotone: uploading a bill can only ever
      // move the number up. openBefore stays 0 for the same reason — the backlog
      // is already inside Planned−Actual, and adding it again would double-count.
      // Every query bounds the PO itself to "existed and was approved on or
      // before the week end", not just the bill, so a past week cannot count
      // POs that had not been raised yet.
      // _all is the company-wide twin: no owner clause, so no untraceable PO
      // can silently vanish from the total.
      if (source === 'auto:po_bill_pending' || source === 'auto:po_bill_pending_all') {
        const { PO_BILL_OWNER_SQL, PO_APPROVED_TS_IST, PO_APPROVED_DATE_IST } = require('../lib/poBill');
        const mine = source === 'auto:po_bill_pending' ? ` AND (${PO_BILL_OWNER_SQL}) = @uid` : '';
        // Week END = end of SUNDAY, the same bound the carry-over engine uses
        // for done-timestamps, so a bill uploaded on Sunday lands in the week
        // that just ended instead of the Sat 23:59:59 → Mon 00:00:00 gap.
        const sundayDate = shiftWeek(sinceDate, 6);
        const arg = (o) => (mine ? { ...o, uid: userId } : o);
        const cut = `${sundayDate} 23:59:59`;
        // The cohort: every PO that owed a bill as at the week end.
        const planned = db.prepare(
          `SELECT COUNT(*) c FROM vendor_pos vp
            WHERE COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
              AND ${PO_APPROVED_TS_IST} <= @cut${mine}`
        ).get(arg({ cut })).c;
        // Of that same cohort, the ones that HAVE a bill by the week end.
        // Planned − this = poMissingBillWhere('@cut') by construction, so the
        // Pending figure and the flow board's tile are the same number.
        const done = db.prepare(
          `SELECT COUNT(*) c FROM vendor_pos vp
            WHERE COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
              AND ${PO_APPROVED_TS_IST} <= @cut${mine}
              AND EXISTS (SELECT 1 FROM purchase_bills pb WHERE pb.vendor_po_id=vp.id
                           AND datetime(pb.created_at, '+330 minutes') <= @cut)`
        ).get(arg({ cut })).c;
        // Backlog cleared this week — Pending "wk". MIN(pb.created_at) so a PO
        // with three bills counts ONCE, and created_at (server-set, +330 = IST)
        // not bill_date: bill_date is the vendor's printed date, user-typed and
        // freely back-datable, so scoring on it would let work move between weeks.
        const clearedBacklog = db.prepare(
          `SELECT COUNT(*) c FROM vendor_pos vp
            WHERE COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
              AND ${PO_APPROVED_DATE_IST} < @ws${mine}
              AND date((SELECT MIN(pb.created_at) FROM purchase_bills pb WHERE pb.vendor_po_id=vp.id),
                       '+330 minutes') BETWEEN @ws AND @we`
        ).get(arg({ ws: sinceDate, we: sundayDate })).c;
        // openBefore 0: the backlog is already Planned − Actual. Adding it here
        // would show the same POs twice in the Pending column.
        return { given: planned, done, openBefore: 0, closedBefore: clearedBacklog };
      }

      // ===== Inventory =====
      if (source === 'auto:stock_in') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM stock_movements WHERE type='IN' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:stock_out') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM stock_movements WHERE type='OUT' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:stock_to_site') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM stock_movements WHERE site_id IS NOT NULL AND type='OUT' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ===== Installation =====
      if (source === 'auto:installations_completed') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM installations WHERE status='completed' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:installations_started') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM installations WHERE status IN ('in_progress','testing','completed') AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ===== Billing =====
      if (source === 'auto:sales_bills') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM sales_bills WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:mb_filed') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM mb_bills WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ===== Cash Flow / Collections =====
      if (source === 'auto:amount_received') {
        const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM collections WHERE collected_by=? AND collection_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate);
        return { given: null, done: r.s };
      }
      if (source === 'auto:amount_received_all') {
        const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM collections WHERE collection_date BETWEEN ? AND ?`).get(sinceDate, untilDate);
        return { given: null, done: r.s };
      }
      // In-LAKH / In-CRORE variants — finance KPIs whose TARGET is set in lakh/cr
      // (mam 2026-06-29: auto the amount KPIs). Company-wide. Planned stays at the
      // template's lakh/cr target; Actual = this week's collections in lakh, and
      // current open receivables in crore (2 decimals).
      if (source === 'auto:amount_received_lakh') {
        const r = db.prepare(`SELECT COALESCE(SUM(amount),0) as s FROM collections WHERE collection_date BETWEEN ? AND ?`).get(sinceDate, untilDate);
        return { given: null, done: Math.round((r.s / 100000) * 100) / 100 };
      }
      if (source === 'auto:receivables_outstanding_cr') {
        const r = db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) as s FROM receivables WHERE outstanding_amount > 0`).get();
        return { given: null, done: Math.round((r.s / 10000000) * 100) / 100 };
      }
      if (source === 'auto:receivables_outstanding') {
        const r = db.prepare(`SELECT COALESCE(SUM(outstanding_amount),0) as s FROM receivables WHERE owner_id=? AND outstanding_amount > 0`).get(userId);
        return { given: null, done: r.s };
      }
      if (source === 'auto:receivables_count') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM receivables WHERE owner_id=? AND outstanding_amount > 0`).get(userId).c;
        return { given: null, done: c };
      }
      if (source === 'auto:collections_count') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM collections WHERE collected_by=? AND collection_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        return { given: null, done: c };
      }

      // ===== Payment Required =====
      if (source === 'auto:payments_raised') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE created_by=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:payments_approved') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE status='final_approved' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:payments_rejected') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE status='rejected' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ===== HR Hiring =====
      if (source === 'auto:candidates_added') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM candidates WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:candidates_onboarded') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM candidates WHERE status='onboarded' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:candidates_shortlisted') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM candidates WHERE status IN ('interview_scheduled','interview_done','offer_sent','accepted','onboarded') AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ===== Attendance =====
      if (source === 'auto:attendance_present_days') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE user_id=? AND date BETWEEN ? AND ? AND status IN ('present','late','half_day','short_day')`).get(userId, sinceDate, untilDate).c;
        return { given: 6, done: c };
      }
      if (source === 'auto:attendance_late_days') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE user_id=? AND date BETWEEN ? AND ? AND status='late'`).get(userId, sinceDate, untilDate).c;
        return { given: null, done: c };
      }
      if (source === 'auto:attendance_absent_days') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM attendance WHERE user_id=? AND date BETWEEN ? AND ? AND status='absent'`).get(userId, sinceDate, untilDate).c;
        return { given: null, done: c };
      }
      if (source === 'auto:leaves_applied') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM leave_requests WHERE user_id=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: c };
      }

      // ===== Complaints =====
      // Mam 2026-08-20: Plan is not a hand-typed target — it auto-fills from
      // the complaints RAISED in the week, and Actual is how many of that same
      // cohort are resolved ("plan 10 complaint but resolve 9" → 90%). Same
      // given/done cohort shape as delegations/PMS/snags: current status only,
      // no resolved-date window — a later resolution still counts toward the
      // raised week. 'closed' counts as resolved, matching the Complaints
      // page dashboard tiles. Both sources return the same pair so the KPI
      // reads Plan=raised / Actual=resolved whichever one a row is bound to.
      if (source === 'auto:complaints_raised' || source === 'auto:complaints_resolved') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM complaints WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM complaints WHERE created_at BETWEEN ? AND ? AND status IN ('resolved','closed')`).get(since, until).c;
        return { given, done };
      }

      // ===== Customers / Vendors =====
      if (source === 'auto:customers_added') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM customers WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:vendors_added') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM vendors WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }

      // ── Real ERP-fetched actuals for the KPI cards (mam 2026-07-01: "you know
      // where to fetch the number" — compute the ACTUAL live from the data, don't
      // fill by hand). Each returns {given:null, done:<value>} so the PLAN stays
      // the person's target and the % is (actual vs target). Caller wraps this in
      // try/catch, so a metric with no data just reads 0.
      if (source === 'auto:pipeline_value_cr') {
        // Open CRM pipeline value in ₹ Cr — live, company-wide (not week-bound).
        const r = db.prepare(`SELECT COALESCE(SUM(COALESCE(NULLIF(tentative_amount,0), NULLIF(estimated_value,0), NULLIF(quotation_amount,0), NULLIF(boq_amount,0), 0)),0) s
          FROM sales_funnel WHERE COALESCE(dropped,0)=0 AND (result IS NULL OR TRIM(result)='')`).get();
        return { given: null, done: Math.round((r.s / 10000000) * 100) / 100 };
      }
      if (source === 'auto:throughput_margin') {
        // Avg actual margin % on THIS user's orders booked this week.
        const r = db.prepare(`SELECT AVG(actual_margin_pct) a FROM business_book
          WHERE employee_assigned=? AND actual_margin_pct IS NOT NULL AND created_at BETWEEN ? AND ?`).get(userId, since, until);
        return { given: null, done: r.a != null ? Math.round(r.a * 10) / 10 : 0 };
      }
      if (source === 'auto:po_cycle_days') {
        // Avg days from indent raised -> vendor PO, for POs raised this week.
        const r = db.prepare(`SELECT AVG(julianday(vp.created_at) - julianday(i.created_at)) a
          FROM vendor_pos vp JOIN indents i ON i.id = vp.indent_id
          WHERE vp.created_at BETWEEN ? AND ? AND i.created_at IS NOT NULL AND COALESCE(vp.cancelled,0)=0`).get(since, until);
        return { given: null, done: r.a != null ? Math.round(r.a * 10) / 10 : 0 };
      }
      if (source === 'auto:dso_days') {
        // Days sales outstanding — avg ageing across open receivables (live).
        const r = db.prepare(`SELECT AVG(ageing_days) a FROM receivables WHERE outstanding_amount > 0 AND ageing_days IS NOT NULL`).get();
        return { given: null, done: r.a != null ? Math.round(r.a) : 0 };
      }
      if (source === 'auto:lead_quote_conversion') {
        // % of this user's leads (created this week) that reached a quotation.
        const leads = db.prepare(`SELECT COUNT(*) c FROM leads WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const quoted = db.prepare(`SELECT COUNT(DISTINCT q.lead_id) c FROM quotations q JOIN leads l ON l.id = q.lead_id
          WHERE l.assigned_to=? AND l.created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given: null, done: leads > 0 ? Math.round((quoted / leads) * 100) : 0 };
      }
      if (source === 'auto:lead_response_hours') {
        // Avg hours from lead created -> first follow-up, for leads created this week.
        const r = db.prepare(`SELECT AVG((julianday(f.first_at) - julianday(l.created_at)) * 24) a
          FROM leads l JOIN (SELECT lead_id, MIN(created_at) first_at FROM lead_followups GROUP BY lead_id) f ON f.lead_id = l.id
          WHERE l.created_at BETWEEN ? AND ?`).get(since, until);
        return { given: null, done: r.a != null ? Math.round(r.a * 10) / 10 : 0 };
      }
      if (source === 'auto:dpr_billed_pct') {
        // % of billing-ready DPRs this week that have been billed (sales_bill linked).
        const r = db.prepare(`SELECT COUNT(*) t, SUM(CASE WHEN sales_bill_id IS NOT NULL THEN 1 ELSE 0 END) b
          FROM dpr WHERE COALESCE(billing_ready,0)=1 AND report_date BETWEEN ? AND ?`).get(sinceDate, untilDate);
        return { given: null, done: r.t > 0 ? Math.round((r.b / r.t) * 100) : 0 };
      }
      if (source === 'auto:time_to_quote_days') {
        // Avg days from lead created -> quotation, for quotes THIS user made this week.
        const r = db.prepare(`SELECT AVG(julianday(q.created_at) - julianday(l.created_at)) a
          FROM quotations q JOIN leads l ON l.id = q.lead_id
          WHERE q.created_by=? AND q.created_at BETWEEN ? AND ? AND l.created_at IS NOT NULL`).get(userId, since, until);
        return { given: null, done: r.a != null ? Math.round(r.a * 10) / 10 : 0 };
      }

      // ── AR/AP + cash-flow driven collections KPIs (mam 2026-07-01) ──
      if (source === 'auto:collection_efficiency') {
        // Collection efficiency = actual total cash inflow this week ÷ the AR/AP-
        // planned inflow for the week. AR/AP is stored in LAKHS, cash_flow in ₹, so
        // normalise both to lakhs. given=planned (from AR/AP), done=actual (cashflow).
        const planned = db.prepare(`SELECT COALESCE(SUM(planned),0) s FROM arap_entries WHERE kind='AR' AND status <> 'cancelled' AND due_date BETWEEN ? AND ?`).get(sinceDate, untilDate).s;
        const inflow  = db.prepare(`SELECT COALESCE(SUM(amount),0) s FROM cash_flow_entries WHERE type='inflow' AND date BETWEEN ? AND ?`).get(sinceDate, untilDate).s;
        return { given: Math.round(planned * 100) / 100, done: Math.round((inflow / 100000) * 100) / 100 };
      }
      if (source === 'auto:overdue_ar_cr') {
        // Overdue AR in ₹ Cr — AR entries past their due date not yet collected
        // (planned − actual), from the AR/AP tracker. lower_better; plan = target.
        const r = db.prepare(`SELECT COALESCE(SUM(CASE WHEN COALESCE(actual,0) < planned THEN planned - COALESCE(actual,0) ELSE 0 END),0) s
          FROM arap_entries WHERE kind='AR' AND status <> 'cancelled' AND due_date < ?`).get(untilDate);
        return { given: null, done: Math.round((r.s / 100) * 100) / 100 };   // lakhs → Cr
      }

      return { given: null, done: null };
    };

    // ── Cross-week carryover (mam 2026-08-25: "also add previous pendancy").
    // For the task-cohort sources, the week's Planned = this week's cohort +
    // the still-open BACKLOG from ALL previous weeks (not just last week),
    // and Actual = cohort done + backlog items closed DURING this week. The
    // backlog is reconstructed as-of the week start from each table's done
    // timestamp (reviewed_at / resolved_at / approved_at) so a past week
    // reads the way it actually stood, not the way things stand today. A
    // done row with a NULL done-timestamp can't be placed in time, so it is
    // treated as done before the week — excluded from BOTH sides, which
    // keeps the mam-2026-06-29 invariant intact: Actual can never exceed
    // Planned (every prev-done item is inside prevPending by construction).
    // RACI sources are deliberately NOT here — mam rejected months-old open
    // records inflating Planned there (2026-08-22, the 97-leads case).
    // Due-date rule (mam 2026-09-05: "if due date change or forward then pick
    // according to dates"): a still-open task only counts as PENDING when its
    // CURRENT due date (after any approved extension / manual re-date) is on
    // or before the week end. A task pushed to a future date is scheduled, not
    // pending — so the backlog reads 5-6 real overdue items, not every open
    // task ever assigned. No due date = always pending (nothing to defer to).
    const CARRY_CFG = {
      'auto:delegations':     { table: 'delegations',     who: 'assigned_to=?', doneCond: "status='approved'",                doneAt: 'reviewed_at', dueCol: 'due_date' },
      'auto:pms':             { table: 'pms_tasks',       who: 'assigned_to=?', doneCond: "status='approved'",                doneAt: 'reviewed_at', dueCol: 'due_date' },
      'auto:tickets':         { table: 'support_tickets', who: 'assigned_to=?', doneCond: "status IN ('resolved','closed')",  doneAt: 'resolved_at', dueCol: 'deadline_date' },
      'auto:delegations_all': { table: 'delegations',     who: null,            doneCond: "status='approved'",                doneAt: 'reviewed_at', dueCol: 'due_date' },
      'auto:pms_all':         { table: 'pms_tasks',       who: null,            doneCond: "status='approved'",                doneAt: 'reviewed_at', dueCol: 'due_date' },
      'auto:tickets_all':     { table: 'support_tickets', who: null,            doneCond: "status IN ('resolved','closed')",  doneAt: 'resolved_at', dueCol: 'deadline_date' },
      // ERP Management (System Flow), attributed by DEVELOPER (mam 2026-09-07:
      // "not as RACI — according to developer"). `who` may carry extra filters;
      // the number of '?' in it decides how many times userId is bound (whoArgs).
      // v2 (2026-09-08): the steps live in sysflow_system_steps now. 'done' is
      // simply having an actual date; there is no cancelled state to exclude.
      'auto:sysflow_steps':     { table: 'sysflow_system_steps', who: 'owner_id=?', doneCond: 'actual_date IS NOT NULL', doneAt: 'actual_date', dueCol: 'planned_date' },
      'auto:sysflow_all':       { table: 'sysflow_system_steps', who: null,         doneCond: 'actual_date IS NOT NULL', doneAt: 'actual_date', dueCol: 'planned_date' },
    };
    const computeCarry = (source, since, until) => {
      // Snags keep their tolerant assignee match and IST approved_at dates
      // (same rules as computeAutoCount above), but since 2026-09-14 the
      // backlog is on the Target Date: "previous" = due before this week's
      // Monday (undated snags never count), and a snag re-dated to a later
      // week is scheduled, not pending.
      if (source === 'auto:snags' || source === 'auto:snags_all') {
        const sinceDate = since.slice(0, 10), untilDate = until.slice(0, 10);
        // Approvals are counted through Sunday so a Sunday close-out is never
        // lost between two weeks (next week's backlog starts from Monday).
        const weekEndDate = shiftWeek(sinceDate, 6);
        const uname = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || '';
        const who = source === 'auto:snags'
          ? `(assigned_to=? OR (assigned_to IS NULL AND assigned_to_name=?) OR CAST(assigned_to AS TEXT)=?) AND `
          : '';
        const whoArgs = source === 'auto:snags' ? [userId, uname, uname] : [];
        const approvedDay = `date(approved_at, '+330 minutes')`;
        const prevPending = db.prepare(
          `SELECT COUNT(*) c FROM snags WHERE ${who}${DUE_SNAG} < ?
             AND (status != 'approved' OR (approved_at IS NOT NULL AND ${approvedDay} >= ?))`
        ).get(...whoArgs, sinceDate, sinceDate).c;
        const prevDone = db.prepare(
          `SELECT COUNT(*) c FROM snags WHERE ${who}${DUE_SNAG} < ?
             AND status = 'approved' AND ${approvedDay} BETWEEN ? AND ?`
        ).get(...whoArgs, sinceDate, sinceDate, weekEndDate).c;
        // Pending "up" halves: stillOpen = due before the week, not approved as
        // of the week end; weekOpen = due this week, not approved.
        const stillOpen = db.prepare(
          `SELECT COUNT(*) c FROM snags WHERE ${who}${DUE_SNAG} < ?
             AND (status != 'approved' OR (approved_at IS NOT NULL AND ${approvedDay} > ?))`
        ).get(...whoArgs, sinceDate, weekEndDate).c;
        const weekOpen = db.prepare(
          `SELECT COUNT(*) c FROM snags WHERE ${who}${DUE_SNAG} BETWEEN ? AND ?
             AND status != 'approved'`
        ).get(...whoArgs, sinceDate, untilDate).c;
        return { prevPending, prevDone, stillOpen, weekOpen };
      }
      const cfg = CARRY_CFG[source];
      if (!cfg) return null;
      const who = cfg.who ? `${cfg.who} AND ` : '';
      // Bind userId once per '?' in the who-clause (0 for company-wide filters
      // like the System Flow "status<>'cancelled'" that carry no user at all).
      const whoArgs = cfg.who ? Array((cfg.who.match(/\?/g) || []).length).fill(userId) : [];
      // Same due-day basis as Planned/Actual (2026-09-05): "previous" = due
      // before this week (or created before it when undated).
      const sinceDate = since.slice(0, 10), untilDate = until.slice(0, 10);
      const DUE = dueDay(cfg.dueCol);
      // Week END for done-timestamps = end of SUNDAY: dueDay() folds a Sunday
      // due day into this week, so a Sunday approval must land here too, not
      // in the gap between Sat 23:59:59 and Mon 00:00:00. datetime() makes
      // both timestamp shapes comparable (support.js writes resolved_at as
      // ISO 'T…Z' on one path and CURRENT_TIMESTAMP on another).
      const weekEndTs = `${shiftWeek(sinceDate, 6)} 23:59:59`;
      const doneTs = `datetime(${cfg.doneAt})`;
      const prevPending = db.prepare(
        `SELECT COUNT(*) c FROM ${cfg.table} WHERE ${who}${DUE} < ?
           AND (NOT (${cfg.doneCond}) OR (${cfg.doneAt} IS NOT NULL AND ${doneTs} >= ?))`
      ).get(...whoArgs, sinceDate, since).c;
      const prevDone = db.prepare(
        `SELECT COUNT(*) c FROM ${cfg.table} WHERE ${who}${DUE} < ?
           AND (${cfg.doneCond}) AND ${doneTs} BETWEEN ? AND ?`
      ).get(...whoArgs, sinceDate, since, weekEndTs).c;
      // Pending "up" halves:
      //   stillOpen = due before the week, not done as of the week END;
      //   weekOpen  = due this week, not done.
      // A task whose date moved to a later week is in neither: scheduled, not
      // pending. Counted directly (not prevPending - prevDone) so nothing clamps.
      const stillOpen = db.prepare(
        `SELECT COUNT(*) c FROM ${cfg.table} WHERE ${who}${DUE} < ?
           AND (NOT (${cfg.doneCond}) OR (${cfg.doneAt} IS NOT NULL AND ${doneTs} > ?))`
      ).get(...whoArgs, sinceDate, weekEndTs).c;
      const weekOpen = db.prepare(
        `SELECT COUNT(*) c FROM ${cfg.table} WHERE ${who}${DUE} BETWEEN ? AND ?
           AND NOT (${cfg.doneCond})`
      ).get(...whoArgs, sinceDate, untilDate).c;
      return { prevPending, prevDone, stillOpen, weekOpen };
    };
    // Sources with no cross-week backlog concept but where the Pending column
    // should still auto-fill with the week's own leftover (planned − actual):
    // checklists are day-scoped and RACI planned is week-scoped by decision.
    // Purchase Bill is here too (mam 2026-09-07): planned − actual is the
    // week's own unbilled leftover and openBefore carries the older backlog,
    // which is exactly the pair this branch adds up. Without it the repointed
    // row would lose its auto Pending figures and fall back to typed boxes.
    const pendingWeekOnly = (source) =>
      source === 'auto:checklists' || source === 'auto:raci_steps_done' || source.startsWith('auto:raci_step:')
      || source === 'auto:po_bill_pending' || source === 'auto:po_bill_pending_all';

    // Load every per-user override row for this user in ONE query so the
    // per-KPI loop below doesn't fan out to 20 small SELECTs.  Indexed by
    // kpi_id for O(1) lookup.
    const userOverridesArr = db.prepare(
      'SELECT kpi_id, planned_value, enabled, weight_override FROM score_user_kpi_target WHERE user_id=?'
    ).all(userId);
    const userOverrides = {};
    for (const o of userOverridesArr) userOverrides[o.kpi_id] = o;

    // Per-user filter — mam (2026-06-02): "every person different KPIs".
    // If the user has enabled=0 on a KPI, skip it entirely (not just
    // suppress display — also pull from the score calculation so total
    // weight doesn't include disabled rows).
    const activeKpis = kpis.filter(k => {
      if (opts.allKpis) return true;
      const o = userOverrides[k.id];
      return !o || o.enabled !== 0;
    });

    let totalScore = 0, totalWeight = 0;
    const result = activeKpis.map(k => {
      const entry = db.prepare('SELECT * FROM score_entries WHERE user_id=? AND kpi_id=? AND week_start=?').get(userId, k.id, weekStart);
      const lastEntry = db.prepare('SELECT actual_pct FROM score_entries WHERE user_id=? AND kpi_id=? AND week_start=?').get(userId, k.id, lastWeekStart);

      // Resolution order for Planned (mam 2026-06-02):
      //   1. Weekly entry's `planned`  — explicit override for that week
      //   2. Per-user KPI target       — score_user_kpi_target
      //   3. Template default_planned  — fallback for everyone
      // Same fallback chain for weight: per-user weight_override → k.weightage.
      const userOverride = userOverrides[k.id];
      let planned = (entry?.planned != null && entry?.planned !== 0)
        ? entry.planned
        : (userOverride?.planned_value != null
            ? userOverride.planned_value
            : (k.default_planned || 0));
      let actual = entry?.actual ?? 0;

      // Auto-fill from ERP if data_source is 'auto:*'. Wrap in try/catch
      // so one broken auto source (e.g. table missing a column on a stale
      // DB) doesn't take down the whole scorecard render.
      // - If `given` is non-null, override Planned (e.g. 6 days for DPR count)
      // - If `given` is null, keep template default_planned and only set Actual
      //   (e.g. DPR profit Actual = sum from DPR rows, target stays as 30000)
      // Auto Pending (mam 2026-08-25 "use this column to pending"):
      //   wk = this week's own leftover (cohort given − cohort done)
      //   up = total still-open as of the week end (backlog + this week)
      let pendingUp = null, pendingWk = null, pendingAuto = false;
      // Does the ERP know the GIVEN side for this source? (tasks due, snags
      // raised, RACI steps reached → yes; candidates shortlisted, amount
      // received, lead conversion → no, the ERP only records the outcome and
      // the target is a management goal typed in the template.) Reported to
      // the UI as target_auto so the Target cell locks or opens accordingly —
      // mam 2026-09-05: "some place I need to enter plan and some place
      // automatically pick plan, how I can justify".
      let targetAuto = false;
      let carryPrevPending = 0, carryPrevDone = 0;
      if (k.data_source && k.data_source.startsWith('auto:')) {
        try {
          const autoRes = computeAutoCount(k.data_source, startTs, endTs);
          const { given, done } = autoRes;
          if (given !== null && given !== undefined) {
            planned = given;
            // A %-type source that had nothing to judge this week returns a
            // neutral 0/0 WITH typedTarget: the target is still the one typed
            // in the template, so the Target cell must not lock as "counted
            // live" (review 2026-09-07 — RACI on-time, System Flow on-time,
            // ERP progress).
            targetAuto = !autoRes.typedTarget;
          }
          if (done !== null && done !== undefined) {
            actual = done;
          }
          // Previous pendency shows in the PENDING column ONLY — mam saw the
          // first cut live (2026-08-26) and said the "incl N prev" additions
          // in Planned/Actual should go: Planned/Actual stay this week's
          // cohort; the backlog lives in Pending "up".
          const carry = computeCarry(k.data_source, startTs, endTs);
          if (carry) {
            carryPrevPending = carry.prevPending;
            carryPrevDone = carry.prevDone;
            // Pending pair (mam 2026-08-26, "19/4" question): first = ALL still
            // open as of the week end (uncleared backlog + this week's
            // leftover); second = of the PREVIOUS tasks, how many were
            // completed during this week. This week's own leftover is already
            // visible as Planned − Actual.
            // Due-date rule (2026-09-05): both halves come from computeCarry
            // already filtered to tasks due on/before the week end, so a task
            // whose date was extended into the future is not "pending" yet.
            // mam 2026-09-14: Pending = PREVIOUS pendency only — tasks due
            // before this week still not done at the week end. This week's own
            // leftover already reads as Planned − Actual, so it is not re-added.
            pendingUp = carry.stillOpen || 0;
            pendingWk = carry.prevDone;
            pendingAuto = true;
          } else if (pendingWeekOnly(k.data_source) && given !== null && done !== null) {
            // RACI: same pair — openBefore joins the outstanding total (never
            // Planned, 2026-08-22 rule) and closedBefore = backlog steps the
            // user closed this week. Checklists have neither → 0s.
            // Previous pendency only (mam 2026-09-14) — same rule as above.
            pendingUp = autoRes.openBefore || 0;
            pendingWk = autoRes.closedBefore || 0;
            carryPrevPending = autoRes.openBefore || 0;
            carryPrevDone = autoRes.closedBefore || 0;
            pendingAuto = true;
          }
        } catch (e) {
          console.warn(`auto-fetch failed for ${k.data_source}:`, e.message);
        }
      }

      // Calculate Actual % — plain "achievement vs plan" (mam 2026-07-03:
      // "actual/Planned*100", not the old variance that subtracted 100 and
      // showed 0-of-3 as −100%).
      //   higher_better: how much of the target you hit — actual/planned×100
      //                  (0 of 3 = 0%, 3 of 3 = 100%, beating it climbs above).
      //   lower_better : at or under the target = 100%, then it eases down as
      //                  you overshoot (planned/actual×100).
      // Always floored at 0 — a scorecard % must never read negative.
      let actualPct = 0;
      // Mam 2026-08-13: "if plan 0 actual 0 then actual % will be 0" — an
      // empty cohort (nothing planned, nothing done) is ON PLAN, not a
      // failure.  Engine achievement = 100 so the page's variance display
      // (which subtracts 100) reads 0%.  Before this, 0/0 rows read as 0
      // achievement → a wall of −100% red and weighted scores tanked for
      // people who simply had nothing assigned that week.
      if (+planned === 0 && +actual === 0) {
        actualPct = 100;
      } else if (planned > 0) {
        if (k.direction === 'lower_better') {
          actualPct = actual <= planned ? 100 : Math.round((planned / actual) * 100);
        } else {
          actualPct = Math.round((actual / planned) * 100);
        }
        if (actualPct < 0) actualPct = 0;
      }

      // Weight resolution: per-user weight_override → k.weightage default.
      // Mam (2026-06-02): "every person different KPIs" — Option B per-user
      // weight override.  weight_override=0 is valid (intentionally muted
      // KPI without disabling); only NULL/undefined falls back.
      const weight = (userOverride?.weight_override != null)
        ? +userOverride.weight_override
        : (k.weightage || 0);
      totalWeight += weight;
      totalScore += weight * actualPct;

      return {
        kpi_id: k.id,
        group_name: k.group_name,
        metric_name: k.metric_name,
        weightage: weight,                  // effective weight for THIS user
        template_weightage: k.weightage,    // raw template value for reference
        has_weight_override: userOverride?.weight_override != null,
        has_target_override: userOverride?.planned_value != null,
        direction: k.direction,
        data_source: k.data_source,
        default_planned: k.default_planned || 0,
        is_auto: k.data_source && k.data_source.startsWith('auto:'),
        target_auto: targetAuto,            // true = Planned counted live; false = Planned is the typed target
        planned,
        actual,
        actual_pct: actualPct,
        last_week_pct: lastEntry?.actual_pct ?? null,
        total_uptodate: entry?.total_uptodate ?? null,
        // Auto rows compute Pending live (backlog-aware); manual rows keep
        // whatever was typed into the up/wk boxes.
        pending_uptodate: pendingAuto ? pendingUp : (entry?.pending_uptodate ?? null),
        pending_work: pendingAuto ? pendingWk : (entry?.pending_work ?? null),
        pending_auto: pendingAuto,
        carry_prev_pending: carryPrevPending,
        carry_prev_done: carryPrevDone,
        pending_pct: entry?.pending_pct ?? null,
        commitment: entry?.commitment ?? null,
        commitment_prev: entry?.commitment_prev ?? null,
        notes: entry?.notes ?? null,
      };
    });

    // Zero-weight template (audit 2026-08-17: prod's 'Everyone' template has
    // 0% weight on every KPI): score = plain unweighted average of the KPI
    // achievement %s, instead of a constant 0 (which displayed as an eternal
    // -100% and made Champions treat the whole template as unscoreable).
    const score = totalWeight > 0
      ? Math.round((totalScore / totalWeight) * 100) / 100
      : (result.length ? Math.round((result.reduce((s, r) => s + (r.actual_pct || 0), 0) / result.length) * 100) / 100 : 0);

    // Total auto work units this week — the Champions League min-activity gate
    // uses this to decide whether a week counts toward a player's score (so a
    // person can't win on two perfect tasks while doing almost nothing).
    const activity = result.reduce((s, r) => s + (r.is_auto && Number.isFinite(+r.actual) ? +r.actual : 0), 0);

    return {
      user_id: userId,
      week_start: weekStart,
      week_end: shiftWeek(weekStart, 5),
      template: tpl,
      kpis: result,
      score,
      total_weight: totalWeight,
      activity,
    };
}

// Thin HTTP wrapper — keeps the /scorecard response identical to before so
// the existing Scorecard page is completely unaffected by the extraction.
router.get('/scorecard', (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10) || req.user.id;
    const weekStart = req.query.week_start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_start)
      ? req.query.week_start
      : defaultWeekStart();
    const db = getDb();
    // template_id (admin only): preview a template that may not be assigned to
    // anyone yet — the template editor uses it for live Actuals + target_auto.
    const templateId = req.user.role === 'admin' ? (parseInt(req.query.template_id, 10) || null) : null;
    const card = computeScorecard(db, userId, weekStart, templateId ? { templateId, allKpis: true } : {});
    // Whose card this is — the page needs the name for the export filename and
    // the printed letterhead (admin switches between employees, and every file
    // was downloading as "scorecard-user-...").
    card.user = { id: userId, name: db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || '' };
    res.json(card);
  } catch (err) {
    console.error('scorecard get error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET the WHOLE scorecard aggregated over a From→To period (mam 2026-08-17:
// "if i apply this value not changed" — Apply must recalculate the table, not
// just the banner tile). Runs the normal weekly compute for every week in the
// range — every hard-won weekly rule (IST bucketing, cohorts, 0/0=on-plan,
// per-user overrides) applies unchanged — then sums Planned/Actual per KPI
// and recomputes % and the weighted score from the summed values.
router.get('/scorecard-range', (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10) || req.user.id;
    const ok = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    if (!ok(req.query.from) || !ok(req.query.to)) {
      return res.status(400).json({ error: 'from and to (yyyy-mm-dd) required' });
    }
    // Snap both ends to their week's Monday (scoring weeks are Mon-Sat).
    const monday = (s) => {
      const d = new Date(`${s}T00:00:00Z`);
      const dow = d.getUTCDay();
      d.setUTCDate(d.getUTCDate() + (dow === 0 ? -6 : 1 - dow));
      return d.toISOString().slice(0, 10);
    };
    let from = monday(req.query.from), to = monday(req.query.to);
    if (from > to) [from, to] = [to, from];
    const nWeeks = Math.min(53, Math.round((new Date(to) - new Date(from)) / (7 * 864e5)) + 1);

    const db = getDb();
    const byKpi = new Map();   // kpi_id → aggregated row
    let template = null, weeksCounted = 0;
    for (let i = 0; i < nWeeks; i++) {
      const w = shiftWeek(from, 7 * i);
      const sc = computeScorecard(db, userId, w);
      if (!sc || !sc.template) continue;
      template = sc.template;
      weeksCounted++;
      for (const k of sc.kpis) {
        const agg = byKpi.get(k.kpi_id);
        if (!agg) {
          byKpi.set(k.kpi_id, { ...k, planned: +k.planned || 0, actual: +k.actual || 0,
            last_week_pct: null, total_uptodate: null, pending_uptodate: null,
            pending_work: null, pending_pct: null, commitment: null, commitment_prev: null, notes: null,
            pending_auto: false, carry_prev_pending: 0, carry_prev_done: 0 });
        } else {
          agg.planned += +k.planned || 0;
          agg.actual += +k.actual || 0;
          // keep the latest week's definition (name/weight/direction may evolve)
          agg.group_name = k.group_name; agg.metric_name = k.metric_name;
          agg.weightage = k.weightage; agg.direction = k.direction;
        }
      }
    }

    // Same % + weighted-score math as the weekly compute, on the summed values.
    let totalScore = 0, totalWeight = 0;
    const kpis = [...byKpi.values()].map(k => {
      let pct = 0;
      if (+k.planned === 0 && +k.actual === 0) pct = 100;
      else if (k.planned > 0) {
        pct = k.direction === 'lower_better'
          ? (k.actual <= k.planned ? 100 : Math.round((k.planned / k.actual) * 100))
          : Math.round((k.actual / k.planned) * 100);
        if (pct < 0) pct = 0;
      }
      k.actual_pct = pct;
      totalWeight += k.weightage || 0;
      totalScore += (k.weightage || 0) * pct;
      return k;
    });
    // Same zero-weight-template rule as the weekly compute above.
    const score = totalWeight > 0
      ? Math.round((totalScore / totalWeight) * 100) / 100
      : (kpis.length ? Math.round((kpis.reduce((s, r) => s + (r.actual_pct || 0), 0) / kpis.length) * 100) / 100 : 0);

    res.json({
      user_id: userId, period: true, from, to,
      // Same name payload as /scorecard — the period export filename and the
      // print letterhead read it.
      user: { id: userId, name: db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || '' },
      week_end: shiftWeek(to, 5), weeks_counted: weeksCounted,
      template, kpis, score, total_weight: totalWeight,
    });
  } catch (err) {
    console.error('scorecard-range get error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET step-wise breakdown of the "RACI Steps (All Modules)" row for one
// user × week — powers the scorecard drill-down (mam 2026-06-27: "show step
// wise"). Splits the single Planned/Actual total into one line per (module,
// step) with planned / done / pending / on-time, mirroring the same weekly
// scope the scorecard row uses.
router.get('/raci-breakdown', (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10) || req.user.id;
    const weekStart = req.query.week_start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_start)
      ? req.query.week_start
      : defaultWeekStart();
    const sinceDate = weekStart;
    const untilDate = shiftWeek(weekStart, 5);
    const rows = require('../utils/raciModules').raciUserWeekBreakdown(getDb(), userId, sinceDate, untilDate);
    // totals.pending mirrors the scorecard row's Pending pair (mam 2026-08-27
    // audit): total outstanding includes the pre-week backlog (pending_before),
    // and prev_done = backlog steps closed this week — else the drill-down
    // would contradict the row it expands (502 vs 297).
    const totals = rows.reduce(
      (t, r) => ({ planned: t.planned + r.planned, actual: t.actual + r.actual,
                   pending: t.pending + r.pending + (r.pending_before || 0),
                   prev_done: t.prev_done + (r.closed_before || 0) }),
      { planned: 0, actual: 0, pending: 0, prev_done: 0 }
    );
    res.json({ user_id: userId, week_start: weekStart, week_end: untilDate, rows, totals });
  } catch (err) {
    console.error('raci-breakdown error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT save a single KPI entry (planned / actual / pending counts / notes)
router.put('/scorecard/entry', (req, res) => {
  try {
    const { user_id, kpi_id, week_start, planned, actual, total_uptodate, pending_uptodate, pending_work, pending_pct, commitment, commitment_prev, notes } = req.body;
    if (!kpi_id || !week_start) return res.status(400).json({ error: 'kpi_id and week_start required' });
    const targetUser = parseInt(user_id, 10) || req.user.id;
    // Only admin or the target user themselves can edit
    if (targetUser !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot edit another user\'s scorecard' });
    }
    const db = getDb();
    const k = db.prepare('SELECT direction FROM score_kpis WHERE id=?').get(kpi_id);
    // Achievement vs plan — same rule as the weekly compute (mam 2026-07-03).
    let actualPct = 0;
    if (planned > 0) {
      if (k?.direction === 'lower_better') {
        actualPct = actual <= planned ? 100 : Math.round((planned / actual) * 100);
      } else {
        actualPct = Math.round((actual / planned) * 100);
      }
      if (actualPct < 0) actualPct = 0;
    }
    db.prepare(`
      INSERT INTO score_entries (user_id, kpi_id, week_start, planned, actual, actual_pct, total_uptodate, pending_uptodate, pending_work, pending_pct, commitment, commitment_prev, notes, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, kpi_id, week_start) DO UPDATE SET
        planned=excluded.planned,
        actual=excluded.actual,
        actual_pct=excluded.actual_pct,
        total_uptodate=excluded.total_uptodate,
        pending_uptodate=excluded.pending_uptodate,
        pending_work=excluded.pending_work,
        pending_pct=excluded.pending_pct,
        commitment=excluded.commitment,
        commitment_prev=excluded.commitment_prev,
        notes=excluded.notes,
        updated_by=excluded.updated_by,
        updated_at=CURRENT_TIMESTAMP
    `).run(targetUser, kpi_id, week_start, planned || 0, actual || 0, actualPct, total_uptodate || null, pending_uptodate || null, pending_work || null, pending_pct || null, commitment || null, commitment_prev || null, notes || null, req.user.id);
    res.json({ message: 'Saved', actual_pct: actualPct });
  } catch (err) {
    console.error('scorecard save error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- Weekly Commitment (mam 2026-07-06) ----------
// A single week-level target the employee COMMITS to for the coming week,
// in the same "variance vs plan" convention the Scorecard renders: 0% = will
// fully hit plan, down to −50% = the worst they'll allow themselves.  Each
// commitment is keyed to the week it is FOR (the target week), so:
//   • "commit for next week"        → writes committed_pct for weekStart+7
//   • "this week's committed target" → committed_pct[weekStart] (the promise
//                                      made earlier, shown read-only)
//   • the Committed-vs-Actual graph  → pairs committed_pct[w] with the achieved
//     variance (computeScorecard(w).score − 100) for the same week w.
const COMMIT_MIN = -50, COMMIT_MAX = 0;

function commitmentRow(db, userId, week) {
  return db.prepare('SELECT committed_pct, note FROM score_commitments WHERE user_id=? AND week_start=?')
    .get(userId, week) || null;
}

// GET the commitment history + achieved variance for the last N weeks, plus
// the promise already saved for the coming week (for the input to pre-fill).
router.get('/commitments', (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10) || req.user.id;
    const weekStart = req.query.week_start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_start)
      ? req.query.week_start
      : defaultWeekStart();
    let weeks = parseInt(req.query.weeks, 10) || 8;
    // Cap 53 = one full year: covers the "Last 6 Months" graph range AND the
    // manual From→To period score (both mam 2026-08-17).
    weeks = Math.max(1, Math.min(53, weeks));
    const db = getDb();

    // Oldest → newest; newest = the viewed week (so the graph reads left→right).
    const series = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const w = shiftWeek(weekStart, -7 * i);
      const commit = commitmentRow(db, userId, w);
      let actualPct = null;
      try {
        const sc = computeScorecard(db, userId, w);
        // Only weeks with a template have a real score; else leave the bar blank.
        if (sc && sc.template) actualPct = Math.round((sc.score - 100) * 100) / 100;
      } catch (_) { /* leave null */ }
      series.push({
        week_start: w,
        committed_pct: commit ? commit.committed_pct : null,
        actual_pct: actualPct,
      });
    }

    res.json({
      user_id: userId,
      week_start: weekStart,
      next_week_start: shiftWeek(weekStart, 7),
      current: commitmentRow(db, userId, weekStart),            // promise for the viewed week
      next: commitmentRow(db, userId, shiftWeek(weekStart, 7)), // already-saved promise for the coming week
      weeks: series,
    });
  } catch (err) {
    console.error('commitments get error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT (upsert) the commitment for one (user, week).  Empty value clears it.
router.put('/commitment', (req, res) => {
  try {
    const { user_id, week_start, committed_pct, note } = req.body;
    if (!week_start || !/^\d{4}-\d{2}-\d{2}$/.test(week_start)) {
      return res.status(400).json({ error: 'week_start (yyyy-mm-dd) required' });
    }
    const targetUser = parseInt(user_id, 10) || req.user.id;
    // Only admin or the target user themselves can edit (same rule as entries).
    if (targetUser !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot edit another user\'s commitment' });
    }
    const db = getDb();
    // Empty / null clears the commitment for that week.
    if (committed_pct === null || committed_pct === undefined || committed_pct === '') {
      db.prepare('DELETE FROM score_commitments WHERE user_id=? AND week_start=?').run(targetUser, week_start);
      return res.json({ message: 'Cleared' });
    }
    const v = Number(committed_pct);
    if (!Number.isFinite(v) || v < COMMIT_MIN || v > COMMIT_MAX) {
      return res.status(400).json({ error: `Commitment must be between ${COMMIT_MAX}% and ${COMMIT_MIN}%` });
    }
    db.prepare(`
      INSERT INTO score_commitments (user_id, week_start, committed_pct, note, updated_by, updated_at)
      VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, week_start) DO UPDATE SET
        committed_pct=excluded.committed_pct,
        note=excluded.note,
        updated_by=excluded.updated_by,
        updated_at=CURRENT_TIMESTAMP
    `).run(targetUser, week_start, v, note || null, req.user.id);
    res.json({ message: 'Saved', committed_pct: v });
  } catch (err) {
    console.error('commitment save error', err);
    res.status(500).json({ error: err.message });
  }
});

// Helpers for scorecard endpoints (defined here so they can use Date math)
function defaultWeekStart() {
  const d = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const dow = d.getUTCDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}
function shiftWeek(date, days) {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------- helpers ----------

// Last completed Mon-Sat. If today is Monday, returns the previous week.
// Otherwise returns the current Monday → Saturday window so mam can also
// check progress mid-week.
function defaultWeek() {
  const now = new Date();
  // Use IST so the cut-over isn't off by 5.5 hours
  const ist = new Date(now.getTime() + (5.5 * 60 * 60 * 1000));
  const dow = ist.getUTCDay(); // 0=Sun, 1=Mon, ... 6=Sat
  // Find current week's Monday
  const offset = dow === 0 ? -6 : (1 - dow);
  const thisMon = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + offset));
  // If today is exactly Monday, default to LAST week (so mam reviews
  // the freshly-finished Mon-Sat).
  if (dow === 1) thisMon.setUTCDate(thisMon.getUTCDate() - 7);
  const sat = new Date(thisMon);
  sat.setUTCDate(sat.getUTCDate() + 5);
  return {
    start: thisMon.toISOString().slice(0, 10),
    end: sat.toISOString().slice(0, 10),
  };
}

function weekRange(req) {
  if (req.query.week_start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_start)) {
    const start = req.query.week_start;
    const sd = new Date(start + 'T00:00:00Z');
    sd.setUTCDate(sd.getUTCDate() + 5);
    return { start, end: sd.toISOString().slice(0, 10) };
  }
  return defaultWeek();
}

// ---------- /scoring/weekly ----------
router.get('/weekly', requirePermission('scoring', 'view'), (req, res) => {
  try {
    const { start, end } = weekRange(req);
    const db = getDb();

    // Active employees with a login user (we score by user_id since that's
    // what every module references).
    const users = db.prepare(`
      SELECT u.id, u.name, u.role, u.department
      FROM users u
      WHERE COALESCE(u.active, 1) = 1
      ORDER BY u.name
    `).all();

    // Helper: count given (created_at in week) and done (completed in week)
    const startTs = `${start} 00:00:00`;
    const endTs = `${end} 23:59:59`;

    const result = users.map(u => {
      // Delegations
      // Due-date basis (mam 2026-09-05) — same rule as the Scorecard page so
      // both surfaces read one number per person.
      const delGiven = db.prepare(
        `SELECT COUNT(*) as c FROM delegations
         WHERE assigned_to = ? AND ${DUE_DELEG} BETWEEN ? AND ?`
      ).get(u.id, start, end).c;
      const delDone = db.prepare(
        `SELECT COUNT(*) as c FROM delegations
         WHERE assigned_to = ? AND ${DUE_DELEG} BETWEEN ? AND ? AND status = 'approved'`
      ).get(u.id, start, end).c;

      // PMS Tasks
      const pmsGiven = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND ${DUE_PMS} BETWEEN ? AND ?`
      ).get(u.id, start, end).c;
      const pmsDone = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND ${DUE_PMS} BETWEEN ? AND ? AND status = 'approved'`
      ).get(u.id, start, end).c;

      // Checklists — frequency-aware (mam 2026-08-31): planned = the days
      // each checklist actually fires within the Mon–Sat week, not ×6 flat.
      const { weeklyExpected, absenceSet, weekDates } = require('../lib/checklistFrequency');
      const cklRows = db.prepare(
        `SELECT assigned_to, frequency, due_date, fortnight_days, recurrence_start_date, recurrence_end_date, created_at
           FROM checklists WHERE assigned_to = ? AND COALESCE(active, 1) = 1`
      ).all(u.id);
      // Absent / leave days are not expected of anyone (mam 2026-09-12).
      const cklAway = absenceSet(db, weekDates(start));
      const cklGiven = cklRows.reduce((s, c) => s + weeklyExpected(c, start, cklAway), 0);
      const cklDone = db.prepare(
        `SELECT COUNT(*) as c FROM checklist_completions cc
         JOIN checklists c ON c.id = cc.checklist_id
         WHERE cc.user_id = ? AND cc.completion_date BETWEEN ? AND ?`
      ).get(u.id, start, end).c;

      // Help Tickets — only count tickets ASSIGNED to this user (not raised by)
      const tktGiven = db.prepare(
        `SELECT COUNT(*) as c FROM support_tickets
         WHERE assigned_to = ? AND ${DUE_TKT} BETWEEN ? AND ?`
      ).get(u.id, start, end).c;
      const tktDone = db.prepare(
        `SELECT COUNT(*) as c FROM support_tickets
         WHERE assigned_to = ? AND ${DUE_TKT} BETWEEN ? AND ? AND status IN ('resolved', 'closed')`
      ).get(u.id, start, end).c;

      const totalGiven = delGiven + pmsGiven + cklGiven + tktGiven;
      const totalDone = delDone + pmsDone + cklDone + tktDone;
      // Score = the user's TEMPLATE scorecard % — the SAME engine as the Scorecard
      // page and the Champions League — so every surface (this board, the Dashboard
      // "Performance" widget, Team Overview) shows ONE number per person. mam
      // 2026-07-04: Aanchal read −82.72% on her scorecard but −10% here, because
      // this box used a SEPARATE task-activity %. Users with no template fall back
      // to the task/RACI activity % so their row isn't blank.
      let score = null;
      try {
        const sc = computeScorecard(db, u.id, start);
        if (sc && sc.template) score = Math.round(sc.score);
      } catch (_) { /* fall through to the activity score below */ }
      if (score == null) {
        const rw = require('../utils/raciModules').raciUserWeek(db, u.id, start, end);
        const raciPlanned = rw.stepsPlanned || 0, raciActual = rw.stepsClosed || 0;
        score = raciPlanned > 0
          ? Math.round((raciActual / raciPlanned) * 100)
          : (totalGiven > 0 ? Math.round((totalDone / totalGiven) * 100) : 0);
      }

      return {
        user_id: u.id,
        name: u.name,
        role: u.role,
        department: u.department,
        delegations: { given: delGiven, done: delDone },
        pms: { given: pmsGiven, done: pmsDone },
        checklists: { given: cklGiven, done: cklDone },
        tickets: { given: tktGiven, done: tktDone },
        total_given: totalGiven,
        total_done: totalDone,
        score,
      };
    });

    // Sort by score descending so top performers float up
    result.sort((a, b) => b.score - a.score || b.total_done - a.total_done);

    res.json({
      week_start: start,
      week_end: end,
      users: result,
    });
  } catch (err) {
    console.error('scoring weekly error', err);
    res.status(500).json({ error: err.message });
  }
});

// ---------- /scoring/weekly/detail ----------
//   List the actual rows that fed a single (user, module) cell so admin
//   can see what was given vs what was done.
router.get('/weekly/detail', requirePermission('scoring', 'view'), (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10);
    const moduleName = req.query.module;
    if (!userId || !moduleName) return res.status(400).json({ error: 'user_id and module required' });
    const { start, end } = weekRange(req);
    const startTs = `${start} 00:00:00`;
    const endTs = `${end} 23:59:59`;
    const db = getDb();

    let rows = [];
    if (moduleName === 'delegations') {
      rows = db.prepare(
        `SELECT d.id, d.title, d.description, d.status, d.due_date, d.created_at,
                d.submitted_at, d.reviewed_at, ab.name as assigned_by_name
         FROM delegations d
         LEFT JOIN users ab ON ab.id = d.assigned_by
         WHERE d.assigned_to = ? AND ${dueDay('due_date', 'd.')} BETWEEN ? AND ?
         ORDER BY d.due_date DESC, d.created_at DESC`
      ).all(userId, start, end);
    } else if (moduleName === 'pms') {
      rows = db.prepare(
        `SELECT p.id, p.title, p.description, p.status, p.due_date, p.created_at,
                p.submitted_at, p.reviewed_at, ab.name as assigned_by_name,
                p.project_name_snapshot as project_name
         FROM pms_tasks p
         LEFT JOIN users ab ON ab.id = p.assigned_by
         WHERE p.assigned_to = ? AND ${dueDay('due_date', 'p.')} BETWEEN ? AND ?
         ORDER BY p.due_date DESC, p.created_at DESC`
      ).all(userId, start, end);
    } else if (moduleName === 'checklists') {
      rows = db.prepare(
        `SELECT cc.id, c.title, c.description, cc.completion_date as date,
                cc.proof_url, cc.notes, cc.submitted_at
         FROM checklist_completions cc
         JOIN checklists c ON c.id = cc.checklist_id
         WHERE cc.user_id = ? AND cc.completion_date BETWEEN ? AND ?
         ORDER BY cc.completion_date DESC`
      ).all(userId, start, end);
    } else if (moduleName === 'tickets') {
      rows = db.prepare(
        `SELECT t.id, t.ticket_no, t.subject, t.priority, t.status, t.category,
                t.created_at, t.resolved_at, t.deadline_date, ru.name as raised_by_name
         FROM support_tickets t
         LEFT JOIN users ru ON ru.id = t.user_id
         WHERE t.assigned_to = ? AND ${dueDay('deadline_date', 't.')} BETWEEN ? AND ?
         ORDER BY t.deadline_date DESC, t.created_at DESC`
      ).all(userId, start, end);
    } else {
      return res.status(400).json({ error: 'Unknown module' });
    }

    res.json({ user_id: userId, module: moduleName, week_start: start, week_end: end, rows });
  } catch (err) {
    console.error('scoring detail error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
// Exposed so the Champions League gamification module can reuse the exact
// same role-normalized weekly score.
module.exports.computeScorecard = computeScorecard;
