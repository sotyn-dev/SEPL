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
const { authMiddleware, requirePermission } = require('../middleware/auth');

router.use(authMiddleware);

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
