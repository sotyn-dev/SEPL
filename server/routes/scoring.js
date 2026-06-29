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
  ).run(userId, kpiId, planned, enabled, weight, req.user.id);
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

// ---------- SCORECARD ----------
// GET full scorecard for a user × week (with auto-fill from delegations/pms/etc.)
// ---------- SCORECARD CORE (reusable) ----------
// Role-normalized weekly score for ONE user measured against THEIR OWN
// template targets. Extracted from the /scorecard route so the Champions
// League gamification module can rank the very same scores without
// duplicating any of the KPI math below.
function computeScorecard(db, userId, weekStart) {
    // Find user's template
    const ut = db.prepare('SELECT template_id FROM score_user_template WHERE user_id=?').get(userId);
    if (!ut) {
      return { user_id: userId, week_start: weekStart, template: null, kpis: [], score: 0, total_weight: 0, activity: 0, message: 'No template assigned to this user yet' };
    }
    const tpl = db.prepare('SELECT * FROM score_templates WHERE id=?').get(ut.template_id);
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
      if (source === 'auto:delegations') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND created_at BETWEEN ? AND ? AND status='approved'`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:pms') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND created_at BETWEEN ? AND ? AND status='approved'`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:tickets') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND created_at BETWEEN ? AND ? AND status IN ('resolved','closed')`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:checklists') {
        const cklAssigned = db.prepare(`SELECT COUNT(*) as c FROM checklists WHERE assigned_to=? AND COALESCE(active,1)=1`).get(userId).c;
        const given = cklAssigned * 6;
        const done = db.prepare(`SELECT COUNT(*) as c FROM checklist_completions WHERE user_id=? AND completion_date BETWEEN ? AND ?`).get(userId, sinceDate, untilDate).c;
        return { given, done };
      }

      // ── Owner / company-wide variants — for a PROCESS OWNER scored on the
      // WHOLE process, not just their own records (mam 2026-06-29: Sushila owns
      // ALL PMS). Same same-week cohort as the by-user versions, no assigned_to.
      if (source === 'auto:pms_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE created_at BETWEEN ? AND ? AND status='approved'`).get(since, until).c;
        return { given, done };
      }
      if (source === 'auto:delegations_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE created_at BETWEEN ? AND ? AND status='approved'`).get(since, until).c;
        return { given, done };
      }
      if (source === 'auto:tickets_all') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE created_at BETWEEN ? AND ? AND status IN ('resolved','closed')`).get(since, until).c;
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

      // ── Responsibility (RACI / SLA) — cross-module per-person accountability ──
      // Steps where the user is the EXPLICIT RACI Responsible (per-record, else
      // whole-module default) across every module. Computed once per user, shared.
      if (source === 'auto:raci_steps_done' || source === 'auto:raci_ontime_pct') {
        if (_raciAgg === undefined) {
          try { _raciAgg = require('../utils/raciModules').raciUserWeek(db, userId, sinceDate, untilDate); }
          catch (e) { _raciAgg = { stepsClosed: 0, slaJudged: 0, onTime: 0, openOnUser: 0, stepsPlanned: 0 }; }
        }
        // Planned = steps on their plate this week (closed this week + still open
        // on them); Actual = steps they closed this week. So % = how much of the
        // RACI work assigned to this person they have finished (mam 2026-06-27).
        if (source === 'auto:raci_steps_done') return { given: _raciAgg.stepsPlanned, done: _raciAgg.stepsClosed };
        // On-time %: only meaningful when the user closed SLA-bearing steps this
        // week. Otherwise stay neutral (planned 0 → 0%) so an idle week neither
        // tanks the score nor falsely qualifies for the activity gate.
        if (_raciAgg.stepsClosed === 0 || _raciAgg.slaJudged === 0) return { given: 0, done: 0 };
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
        return row ? { given: row.planned, done: row.actual } : { given: 0, done: 0 };
      }

      // Site-scoped KPIs (Site Engineer / Supervisor templates) — need
      // the list of sites this user manages first.
      const siteIds = siteIdsForUser();
      if (siteIds.length === 0) {
        // No sites mapped to this user → can't aggregate. Return zero.
        return { given: 0, done: 0 };
      }
      const inSites = `(${siteIds.join(',')})`;

      if (source === 'auto:dpr_profit') {
        // Sum of profit_loss across DPRs in the week. Planned = sum of
        // grand_total_b (planned cost), Actual = sum of grand_total_a
        // (actual revenue). Score = (a - b) / b × 100 → matches "DPR
        // Profit" KPI on the Site Eng template.
        const r = db.prepare(`SELECT COALESCE(SUM(grand_total_b),0) as planned, COALESCE(SUM(grand_total_a),0) as actual FROM dpr WHERE site_id IN ${inSites} AND report_date BETWEEN ? AND ?`).get(sinceDate, untilDate);
        return { given: r.planned, done: r.actual };
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
      if (source === 'auto:complaints_raised') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM complaints WHERE created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
      }
      if (source === 'auto:complaints_resolved') {
        const c = db.prepare(`SELECT COUNT(*) as c FROM complaints WHERE status='resolved' AND created_at BETWEEN ? AND ?`).get(since, until).c;
        return { given: null, done: c };
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

      return { given: null, done: null };
    };

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
      if (k.data_source && k.data_source.startsWith('auto:')) {
        try {
          const { given, done } = computeAutoCount(k.data_source, startTs, endTs);
          if (given !== null) {
            planned = given;
          }
          if (done !== null && done !== undefined) {
            actual = done;
          }
        } catch (e) {
          console.warn(`auto-fetch failed for ${k.data_source}:`, e.message);
        }
      }

      // Calculate Actual %
      let actualPct = 0;
      if (planned > 0) {
        if (k.direction === 'lower_better') {
          // lower is better: under-budget or fast turnaround
          actualPct = Math.round(((planned - actual) / planned) * 100);
        } else {
          actualPct = Math.round(((actual - planned) / planned) * 100);
        }
        // Cap on the negative side at -100 (can't lose more than 100%)
        if (actualPct < -100) actualPct = -100;
      } else if (actual === 0) {
        actualPct = 0;
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
        planned,
        actual,
        actual_pct: actualPct,
        last_week_pct: lastEntry?.actual_pct ?? null,
        total_uptodate: entry?.total_uptodate ?? null,
        pending_uptodate: entry?.pending_uptodate ?? null,
        pending_work: entry?.pending_work ?? null,
        pending_pct: entry?.pending_pct ?? null,
        commitment: entry?.commitment ?? null,
        notes: entry?.notes ?? null,
      };
    });

    const score = totalWeight > 0 ? Math.round((totalScore / totalWeight) * 100) / 100 : 0;

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
    res.json(computeScorecard(getDb(), userId, weekStart));
  } catch (err) {
    console.error('scorecard get error', err);
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
    const totals = rows.reduce(
      (t, r) => ({ planned: t.planned + r.planned, actual: t.actual + r.actual, pending: t.pending + r.pending }),
      { planned: 0, actual: 0, pending: 0 }
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
    const { user_id, kpi_id, week_start, planned, actual, total_uptodate, pending_uptodate, pending_work, pending_pct, commitment, notes } = req.body;
    if (!kpi_id || !week_start) return res.status(400).json({ error: 'kpi_id and week_start required' });
    const targetUser = parseInt(user_id, 10) || req.user.id;
    // Only admin or the target user themselves can edit
    if (targetUser !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Cannot edit another user\'s scorecard' });
    }
    const db = getDb();
    const k = db.prepare('SELECT direction FROM score_kpis WHERE id=?').get(kpi_id);
    let actualPct = 0;
    if (planned > 0) {
      if (k?.direction === 'lower_better') {
        actualPct = Math.round(((planned - actual) / planned) * 100);
      } else {
        actualPct = Math.round(((actual - planned) / planned) * 100);
      }
      if (actualPct < -100) actualPct = -100;
    }
    db.prepare(`
      INSERT INTO score_entries (user_id, kpi_id, week_start, planned, actual, actual_pct, total_uptodate, pending_uptodate, pending_work, pending_pct, commitment, notes, updated_by, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, kpi_id, week_start) DO UPDATE SET
        planned=excluded.planned,
        actual=excluded.actual,
        actual_pct=excluded.actual_pct,
        total_uptodate=excluded.total_uptodate,
        pending_uptodate=excluded.pending_uptodate,
        pending_work=excluded.pending_work,
        pending_pct=excluded.pending_pct,
        commitment=excluded.commitment,
        notes=excluded.notes,
        updated_by=excluded.updated_by,
        updated_at=CURRENT_TIMESTAMP
    `).run(targetUser, kpi_id, week_start, planned || 0, actual || 0, actualPct, total_uptodate || null, pending_uptodate || null, pending_work || null, pending_pct || null, commitment || null, notes || null, req.user.id);
    res.json({ message: 'Saved', actual_pct: actualPct });
  } catch (err) {
    console.error('scorecard save error', err);
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
      const delGiven = db.prepare(
        `SELECT COUNT(*) as c FROM delegations
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ?`
      ).get(u.id, startTs, endTs).c;
      const delDone = db.prepare(
        `SELECT COUNT(*) as c FROM delegations
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ? AND status = 'approved'`
      ).get(u.id, startTs, endTs).c;

      // PMS Tasks
      const pmsGiven = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ?`
      ).get(u.id, startTs, endTs).c;
      const pmsDone = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ? AND status = 'approved'`
      ).get(u.id, startTs, endTs).c;

      // Checklists — assigned daily checklists (one per weekday active days)
      // Given = number of (active checklist × weekday-in-range) the user owns.
      // For simplicity we count active checklists assigned to this user × 6
      // weekdays (Mon-Sat). Done = unique completion rows in range.
      const checklistsAssigned = db.prepare(
        `SELECT COUNT(*) as c FROM checklists
         WHERE assigned_to = ? AND COALESCE(active, 1) = 1`
      ).get(u.id).c;
      const cklGiven = checklistsAssigned * 6; // Mon-Sat
      const cklDone = db.prepare(
        `SELECT COUNT(*) as c FROM checklist_completions cc
         JOIN checklists c ON c.id = cc.checklist_id
         WHERE cc.user_id = ? AND cc.completion_date BETWEEN ? AND ?`
      ).get(u.id, start, end).c;

      // Help Tickets — only count tickets ASSIGNED to this user (not raised by)
      const tktGiven = db.prepare(
        `SELECT COUNT(*) as c FROM support_tickets
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ?`
      ).get(u.id, startTs, endTs).c;
      const tktDone = db.prepare(
        `SELECT COUNT(*) as c FROM support_tickets
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ? AND status IN ('resolved', 'closed')`
      ).get(u.id, startTs, endTs).c;

      const totalGiven = delGiven + pmsGiven + cklGiven + tktGiven;
      const totalDone = delDone + pmsDone + cklDone + tktDone;
      const score = totalGiven > 0 ? Math.round((totalDone / totalGiven) * 100) : 0;

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
         WHERE d.assigned_to = ? AND d.created_at BETWEEN ? AND ?
         ORDER BY d.created_at DESC`
      ).all(userId, startTs, endTs);
    } else if (moduleName === 'pms') {
      rows = db.prepare(
        `SELECT p.id, p.title, p.description, p.status, p.due_date, p.created_at,
                p.submitted_at, p.reviewed_at, ab.name as assigned_by_name,
                p.project_name_snapshot as project_name
         FROM pms_tasks p
         LEFT JOIN users ab ON ab.id = p.assigned_by
         WHERE p.assigned_to = ? AND p.created_at BETWEEN ? AND ?
         ORDER BY p.created_at DESC`
      ).all(userId, startTs, endTs);
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
                t.created_at, t.resolved_at, ru.name as raised_by_name
         FROM support_tickets t
         LEFT JOIN users ru ON ru.id = t.user_id
         WHERE t.assigned_to = ? AND t.created_at BETWEEN ? AND ?
         ORDER BY t.created_at DESC`
      ).all(userId, startTs, endTs);
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
