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
  const { group_name, metric_name, weightage, direction, data_source, display_order, active } = req.body;
  getDb().prepare(
    `UPDATE score_kpis SET
       group_name=COALESCE(?, group_name),
       metric_name=COALESCE(?, metric_name),
       weightage=COALESCE(?, weightage),
       direction=COALESCE(?, direction),
       data_source=COALESCE(?, data_source),
       display_order=COALESCE(?, display_order),
       active=COALESCE(?, active)
     WHERE id=?`
  ).run(
    group_name || null, metric_name || null,
    weightage === undefined ? null : weightage,
    direction || null, data_source || null,
    display_order === undefined ? null : display_order,
    active === undefined ? null : (active ? 1 : 0),
    req.params.id
  );
  res.json({ message: 'Updated' });
});

router.delete('/kpis/:id', adminOnly, (req, res) => {
  getDb().prepare('DELETE FROM score_kpis WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
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
router.get('/scorecard', (req, res) => {
  try {
    const userId = parseInt(req.query.user_id, 10) || req.user.id;
    const weekStart = req.query.week_start && /^\d{4}-\d{2}-\d{2}$/.test(req.query.week_start)
      ? req.query.week_start
      : defaultWeekStart();
    const db = getDb();

    // Find user's template
    const ut = db.prepare('SELECT template_id FROM score_user_template WHERE user_id=?').get(userId);
    if (!ut) {
      return res.json({ user_id: userId, week_start: weekStart, template: null, kpis: [], score: 0, message: 'No template assigned to this user yet' });
    }
    const tpl = db.prepare('SELECT * FROM score_templates WHERE id=?').get(ut.template_id);
    const kpis = db.prepare('SELECT * FROM score_kpis WHERE template_id=? AND COALESCE(active,1)=1 ORDER BY display_order, id').all(ut.template_id);

    const lastWeekStart = shiftWeek(weekStart, -7);
    const startTs = `${weekStart} 00:00:00`;
    const endTs = `${shiftWeek(weekStart, 5)} 23:59:59`;
    const lastStartTs = `${lastWeekStart} 00:00:00`;
    const lastEndTs = `${shiftWeek(lastWeekStart, 5)} 23:59:59`;

    const computeAutoCount = (source, since, until) => {
      if (source === 'auto:delegations') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status='approved' AND COALESCE(reviewed_at, submitted_at, created_at) BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:pms') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM pms_tasks WHERE assigned_to=? AND status='approved' AND COALESCE(reviewed_at, submitted_at, created_at) BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:tickets') {
        const given = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND created_at BETWEEN ? AND ?`).get(userId, since, until).c;
        const done = db.prepare(`SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to=? AND status IN ('resolved','closed') AND COALESCE(resolved_at, updated_at, created_at) BETWEEN ? AND ?`).get(userId, since, until).c;
        return { given, done };
      }
      if (source === 'auto:checklists') {
        const cklAssigned = db.prepare(`SELECT COUNT(*) as c FROM checklists WHERE assigned_to=? AND COALESCE(active,1)=1`).get(userId).c;
        const given = cklAssigned * 6;
        const done = db.prepare(`SELECT COUNT(*) as c FROM checklist_completions WHERE user_id=? AND completion_date BETWEEN ? AND ?`).get(userId, since.slice(0,10), until.slice(0,10)).c;
        return { given, done };
      }
      return { given: null, done: null };
    };

    let totalScore = 0, totalWeight = 0;
    const result = kpis.map(k => {
      const entry = db.prepare('SELECT * FROM score_entries WHERE user_id=? AND kpi_id=? AND week_start=?').get(userId, k.id, weekStart);
      const lastEntry = db.prepare('SELECT actual_pct FROM score_entries WHERE user_id=? AND kpi_id=? AND week_start=?').get(userId, k.id, lastWeekStart);

      let planned = entry?.planned ?? 0;
      let actual = entry?.actual ?? 0;

      // Auto-fill from ERP if data_source is 'auto:*'
      if (k.data_source && k.data_source.startsWith('auto:')) {
        const { given, done } = computeAutoCount(k.data_source, startTs, endTs);
        if (given !== null) {
          planned = given;
          actual = done;
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

      const weight = k.weightage || 0;
      totalWeight += weight;
      totalScore += weight * actualPct;

      return {
        kpi_id: k.id,
        group_name: k.group_name,
        metric_name: k.metric_name,
        weightage: k.weightage,
        direction: k.direction,
        data_source: k.data_source,
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

    res.json({
      user_id: userId,
      week_start: weekStart,
      week_end: shiftWeek(weekStart, 5),
      template: tpl,
      kpis: result,
      score,
      total_weight: totalWeight,
    });
  } catch (err) {
    console.error('scorecard get error', err);
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
         WHERE assigned_to = ? AND status = 'approved'
           AND COALESCE(reviewed_at, submitted_at, created_at) BETWEEN ? AND ?`
      ).get(u.id, startTs, endTs).c;

      // PMS Tasks
      const pmsGiven = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND created_at BETWEEN ? AND ?`
      ).get(u.id, startTs, endTs).c;
      const pmsDone = db.prepare(
        `SELECT COUNT(*) as c FROM pms_tasks
         WHERE assigned_to = ? AND status = 'approved'
           AND COALESCE(reviewed_at, submitted_at, created_at) BETWEEN ? AND ?`
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
         WHERE assigned_to = ? AND status IN ('resolved', 'closed')
           AND COALESCE(resolved_at, updated_at, created_at) BETWEEN ? AND ?`
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
