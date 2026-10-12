const express = require('express');
const { getDb } = require('../db/schema');
const { istToday } = require('../lib/istDate');
const { authMiddleware } = require('../middleware/auth');
const { checklistWeekScore } = require('../lib/checklistWeekScore');

const router = express.Router();
router.use(authMiddleware);

// Initialize schema on load
function ensureStandupSchema(db) {
  try {
    db.prepare(`
      CREATE TABLE IF NOT EXISTS daily_standup_acknowledgments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        standup_date TEXT NOT NULL,
        acknowledged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        total_overdue INTEGER DEFAULT 0,
        critical_overdue INTEGER DEFAULT 0,
        focused_task_ids TEXT,
        commitment_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, standup_date)
      )
    `).run();
  } catch (e) {
    console.warn('[daily-standup] Schema init warning:', e.message);
  }
}

// Ensure schema exists
ensureStandupSchema(getDb());

// Helper: compute days difference (positive means overdue)
function getDaysDiff(todayStr, targetDateStr) {
  if (!targetDateStr) return 0;
  const dToday = new Date(todayStr + 'T00:00:00Z');
  const dTarget = new Date(targetDateStr.slice(0, 10) + 'T00:00:00Z');
  if (isNaN(dTarget.getTime())) return 0;
  const diffMs = dToday.getTime() - dTarget.getTime();
  return Math.floor(diffMs / (24 * 3600 * 1000));
}

// GET /api/daily-standup/briefing
// Returns aggregated pending & overdue tasks for the current user
router.get('/briefing', (req, res) => {
  try {
    const db = getDb();
    const today = istToday();
    const isAdmin = req.user.role === 'admin';
    const targetUserId = (isAdmin && req.query.user_id) ? parseInt(req.query.user_id, 10) : req.user.id;

    const user = db.prepare('SELECT id, name, email, department, role FROM users WHERE id=?').get(targetUserId);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const tasks = [];

    // 1. Delegations (assigned_to = user, pending or rejected)
    const delegations = db.prepare(`
      SELECT 
        d.id,
        'delegation' AS module,
        'Delegation #' || d.id AS task_reference,
        d.title,
        d.description,
        'high' AS priority,
        d.status,
        d.due_date,
        date(d.created_at, '+330 minutes') AS created_date,
        au.name AS assigned_by_name,
        d.project_name,
        '/delegations' AS link_url
      FROM delegations d
      LEFT JOIN users au ON au.id = d.assigned_by
      WHERE d.assigned_to = ? AND d.status IN ('pending', 'rejected')
    `).all(targetUserId);

    for (const d of delegations) {
      const effDate = d.due_date || d.created_date || today;
      const daysDiff = getDaysDiff(today, effDate);
      tasks.push({
        ...d,
        effective_date: effDate,
        days_overdue: daysDiff,
        is_overdue: daysDiff > 0,
      });
    }

    // 2. PMS Tasks (assigned_to = user, pending or rejected)
    const pmsTasks = db.prepare(`
      SELECT 
        p.id,
        'pms' AS module,
        'PMS Task #' || p.id AS task_reference,
        p.title,
        p.description,
        'urgent' AS priority,
        p.status,
        p.due_date,
        date(p.created_at, '+330 minutes') AS created_date,
        au.name AS assigned_by_name,
        COALESCE(s.name, bb.project_name, p.project_name_snapshot, 'Project #' || p.project_id) AS project_name,
        '/pms-tasks' AS link_url
      FROM pms_tasks p
      LEFT JOIN users au ON au.id = p.assigned_by
      LEFT JOIN business_book bb ON bb.id = p.project_id
      LEFT JOIN sites s ON s.business_book_id = bb.id
      WHERE p.assigned_to = ? AND p.status IN ('pending', 'rejected')
    `).all(targetUserId);

    for (const p of pmsTasks) {
      const effDate = p.due_date || p.created_date || today;
      const daysDiff = getDaysDiff(today, effDate);
      tasks.push({
        ...p,
        effective_date: effDate,
        days_overdue: daysDiff,
        is_overdue: daysDiff > 0,
      });
    }

    // 3. Support Tickets (assigned_to = user, open / in_progress / rejected)
    const tickets = db.prepare(`
      SELECT 
        t.id,
        'ticket' AS module,
        COALESCE(t.ticket_no, 'Ticket #' || t.id) AS task_reference,
        t.subject AS title,
        t.description,
        COALESCE(t.priority, 'medium') AS priority,
        t.status,
        t.deadline_date AS due_date,
        date(t.created_at, '+330 minutes') AS created_date,
        u.name AS assigned_by_name,
        NULL AS project_name,
        '/support' AS link_url
      FROM support_tickets t
      LEFT JOIN users u ON t.user_id = u.id
      WHERE t.assigned_to = ? AND t.status IN ('open', 'in_progress', 'rejected')
    `).all(targetUserId);

    for (const t of tickets) {
      const effDate = t.due_date || t.created_date || today;
      const daysDiff = getDaysDiff(today, effDate);
      tasks.push({
        ...t,
        effective_date: effDate,
        days_overdue: daysDiff,
        is_overdue: daysDiff > 0,
      });
    }

    // 4. Checklists (assigned_to = user, pending for today or missed this week)
    try {
      const cklScore = checklistWeekScore(db, targetUserId, today);
      if (cklScore && Array.isArray(cklScore.rows)) {
        for (const row of cklScore.rows) {
          if (row.status === 'missed' || row.status === 'today' || row.status === 'rejected') {
            const daysDiff = getDaysDiff(today, row.date);
            tasks.push({
              id: row.id,
              module: 'checklist',
              task_reference: 'Checklist #' + row.checklist_id,
              title: row.title,
              description: row.description || `Frequency: ${row.frequency || 'Daily'}`,
              priority: 'normal',
              status: row.status,
              due_date: row.date,
              created_date: row.date,
              effective_date: row.date,
              assigned_by_name: 'Manager / SOP',
              project_name: null,
              link_url: '/checklists',
              days_overdue: daysDiff,
              is_overdue: daysDiff > 0,
            });
          }
        }
      }
    } catch (e) {
      console.warn('[daily-standup] Checklists query note:', e.message);
    }

    // Classify each task into SLA / Urgency categories
    const criticalOverdue = [];
    const overdue = [];
    const dueToday = [];
    const upcoming48h = [];
    const others = [];

    for (const item of tasks) {
      const d = item.days_overdue;
      if (d >= 7) {
        item.category = 'critical_overdue';
        item.sla_status = d >= 21 ? 'Breached (>3w)' : d >= 14 ? 'Breached (>2w)' : 'Breached (>1w)';
        item.aging_label = `${d} days overdue (${Math.floor(d / 7)}w ago)`;
        item.badge_color = 'rose';
        criticalOverdue.push(item);
      } else if (d > 0) {
        item.category = 'overdue';
        item.sla_status = 'Breached';
        item.aging_label = `${d} ${d === 1 ? 'day' : 'days'} overdue`;
        item.badge_color = 'amber';
        overdue.push(item);
      } else if (d === 0) {
        item.category = 'due_today';
        item.sla_status = 'Due Today';
        item.aging_label = 'Due Today';
        item.badge_color = 'blue';
        dueToday.push(item);
      } else if (d === -1 || d === -2) {
        item.category = 'upcoming_48h';
        item.sla_status = 'Upcoming';
        item.aging_label = `Due in ${Math.abs(d)} ${Math.abs(d) === 1 ? 'day' : 'days'}`;
        item.badge_color = 'slate';
        upcoming48h.push(item);
      } else {
        item.category = 'upcoming';
        item.sla_status = 'Within SLA';
        item.aging_label = `Due in ${Math.abs(d)} days`;
        item.badge_color = 'gray';
        others.push(item);
      }
    }

    // Sort by priority and aging (highest days overdue first)
    criticalOverdue.sort((a, b) => b.days_overdue - a.days_overdue);
    overdue.sort((a, b) => b.days_overdue - a.days_overdue);
    dueToday.sort((a, b) => a.title.localeCompare(b.title));
    upcoming48h.sort((a, b) => b.days_overdue - a.days_overdue);

    const sortedTasks = [...criticalOverdue, ...overdue, ...dueToday, ...upcoming48h, ...others];

    // Check if acknowledged today
    const ack = db.prepare(`
      SELECT * FROM daily_standup_acknowledgments 
      WHERE user_id = ? AND standup_date = ?
    `).get(targetUserId, today);

    // Auto-create In-App Notification if critical overdue tasks exist (>7 days) and not already alerted today
    if (criticalOverdue.length > 0) {
      const dedupeKey = `standup_overdue_${targetUserId}_${today}`;
      const existingNotif = db.prepare('SELECT id FROM notifications WHERE dedupe_key = ?').get(dedupeKey);
      if (!existingNotif) {
        try {
          db.prepare(`
            INSERT INTO notifications (
              user_id, type, title, body, link_url, channel_sent, dedupe_key, is_mandatory, created_at
            ) VALUES (?, 'mandatory_task', ?, ?, '/delegations', 'in_app', ?, 1, CURRENT_TIMESTAMP)
          `).run(
            targetUserId,
            `🚨 Daily Standup: ${criticalOverdue.length} Tasks Critical Overdue (>7d)`,
            `You have ${criticalOverdue.length} tasks overdue by over a week across Delegations, PMS, Tickets, or Checklists. Please check your Daily Focus.`,
            dedupeKey
          );
        } catch (ne) {
          console.warn('[daily-standup] Notification insert skipped:', ne.message);
        }
      }
    }

    const counts = {
      critical_overdue: criticalOverdue.length,
      overdue: overdue.length,
      due_today: dueToday.length,
      upcoming_48h: upcoming48h.length,
      total_attention_needed: criticalOverdue.length + overdue.length + dueToday.length + upcoming48h.length,
      total_all: tasks.length,
      by_module: {
        delegations: tasks.filter(t => t.module === 'delegation').length,
        pms: tasks.filter(t => t.module === 'pms').length,
        tickets: tasks.filter(t => t.module === 'ticket').length,
        checklists: tasks.filter(t => t.module === 'checklist').length,
      },
    };

    res.json({
      today,
      user,
      acknowledged_today: !!ack,
      acknowledgment: ack ? {
        acknowledged_at: ack.acknowledged_at,
        commitment_note: ack.commitment_note,
        focused_task_ids: (() => { try { return JSON.parse(ack.focused_task_ids || '[]'); } catch { return []; } })(),
      } : null,
      counts,
      tasks: sortedTasks,
    });
  } catch (error) {
    console.error('[daily-standup] Briefing error:', error);
    res.status(500).json({ error: 'Failed to generate daily standup briefing', details: error.message });
  }
});

// POST /api/daily-standup/acknowledge
// Saves employee acknowledgment and daily focus commitments
router.post('/acknowledge', (req, res) => {
  try {
    const db = getDb();
    const today = istToday();
    const userId = req.user.id;
    const { focused_task_ids = [], commitment_note = '', total_overdue = 0, critical_overdue = 0 } = req.body;

    const focusedJson = JSON.stringify(Array.isArray(focused_task_ids) ? focused_task_ids : []);

    db.prepare(`
      INSERT INTO daily_standup_acknowledgments (
        user_id, standup_date, acknowledged_at, total_overdue, critical_overdue, focused_task_ids, commitment_note
      ) VALUES (?, ?, CURRENT_TIMESTAMP, ?, ?, ?, ?)
      ON CONFLICT(user_id, standup_date) DO UPDATE SET
        acknowledged_at = CURRENT_TIMESTAMP,
        total_overdue = excluded.total_overdue,
        critical_overdue = excluded.critical_overdue,
        focused_task_ids = excluded.focused_task_ids,
        commitment_note = excluded.commitment_note
    `).run(
      userId,
      today,
      Number(total_overdue) || 0,
      Number(critical_overdue) || 0,
      focusedJson,
      String(commitment_note || '').trim()
    );

    res.json({
      ok: true,
      message: 'Daily standup briefing acknowledged successfully',
      date: today,
    });
  } catch (error) {
    console.error('[daily-standup] Acknowledge error:', error);
    res.status(500).json({ error: 'Failed to record standup acknowledgment', details: error.message });
  }
});

// GET /api/daily-standup/admin-summary
// For Admins & Management: visibility into overdue backlogs across the company
router.get('/admin-summary', (req, res) => {
  try {
    const db = getDb();
    const today = istToday();

    // Check admin permission
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Admin permission required' });
    }

    const users = db.prepare('SELECT id, name, username, email, department, role FROM users WHERE active=1 ORDER BY name').all();
    const acks = db.prepare('SELECT * FROM daily_standup_acknowledgments WHERE standup_date=?').all(today);
    const ackMap = new Map(acks.map(a => [a.user_id, a]));

    const summary = [];
    for (const u of users) {
      // Fast count of delegations & pms & tickets overdue > 7d
      const delegCount = db.prepare(`
        SELECT COUNT(*) as c FROM delegations 
        WHERE assigned_to = ? AND status IN ('pending', 'rejected') 
        AND COALESCE(due_date, date(created_at, '+330 minutes')) <= date(?, '-7 days')
      `).get(u.id, today)?.c || 0;

      const pmsCount = db.prepare(`
        SELECT COUNT(*) as c FROM pms_tasks 
        WHERE assigned_to = ? AND status IN ('pending', 'rejected') 
        AND COALESCE(due_date, date(created_at, '+330 minutes')) <= date(?, '-7 days')
      `).get(u.id, today)?.c || 0;

      const ticketCount = db.prepare(`
        SELECT COUNT(*) as c FROM support_tickets 
        WHERE assigned_to = ? AND status IN ('open', 'in_progress', 'rejected') 
        AND COALESCE(deadline_date, date(created_at, '+330 minutes')) <= date(?, '-7 days')
      `).get(u.id, today)?.c || 0;

      const criticalTotal = delegCount + pmsCount + ticketCount;
      const userAck = ackMap.get(u.id);

      summary.push({
        user: u,
        critical_overdue_count: criticalTotal,
        delegations_overdue: delegCount,
        pms_overdue: pmsCount,
        tickets_overdue: ticketCount,
        acknowledged_today: !!userAck,
        acknowledged_at: userAck?.acknowledged_at || null,
        commitment_note: userAck?.commitment_note || null,
      });
    }

    res.json({
      today,
      total_active_users: users.length,
      total_acknowledged_today: acks.length,
      users_with_critical_overdue: summary.filter(s => s.critical_overdue_count > 0).length,
      summary,
    });
  } catch (error) {
    console.error('[daily-standup] Admin summary error:', error);
    res.status(500).json({ error: 'Failed to fetch admin summary', details: error.message });
  }
});

module.exports = router;
