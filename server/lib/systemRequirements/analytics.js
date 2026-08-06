const { STALE_DAYS, OPEN_STATUSES } = require('./constants');

const ACTIVE_SQL = `soft_deleted_at IS NULL`;
const openList = OPEN_STATUSES.map(s => `'${s}'`).join(',');

function dashboard(db, { userId } = {}) {
  const countStatus = (statuses) => {
    const ph = statuses.map(() => '?').join(',');
    return db.prepare(
      `SELECT COUNT(*) c FROM sysreq_requirements WHERE ${ACTIVE_SQL} AND status IN (${ph})`
    ).get(...statuses).c;
  };

  const open = db.prepare(
    `SELECT COUNT(*) c FROM sysreq_requirements WHERE ${ACTIVE_SQL} AND status IN (${openList})`
  ).get().c;

  const waitingApproval = countStatus(['under_review']);
  const withItManagers = countStatus(['submitted']);
  const pending = countStatus(['pending', 'in_development']);
  const inProgress = countStatus(['in_progress']);
  const testing = countStatus(['testing']);
  const releasedMonth = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements
    WHERE ${ACTIVE_SQL} AND status IN ('released','closed')
      AND completed_at >= datetime('now', 'start of month')
  `).get().c;

  const overdue = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements
    WHERE ${ACTIVE_SQL}
      AND due_date IS NOT NULL AND due_date < date('now')
      AND status NOT IN ('released','closed','archived','rejected')
  `).get().c;

  const highPriority = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements
    WHERE ${ACTIVE_SQL}
      AND priority IN ('high','urgent')
      AND status IN (${openList})
  `).get().c;

  const needClarification = countStatus(['need_clarification']);

  const stale = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements
    WHERE ${ACTIVE_SQL}
      AND status IN (${openList})
      AND updated_at < datetime('now', ?)
  `).get(`-${STALE_DAYS} days`).c;

  const inactiveAssignee = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements r
    LEFT JOIN users asg ON asg.id = r.assignee_id
    WHERE r.soft_deleted_at IS NULL
      AND r.status IN (
        'submitted','under_review','need_clarification','approved',
        'planned','assigned','pending','in_progress','in_development','testing','reopened'
      )
      AND r.assignee_id IS NOT NULL
      AND (
        asg.id IS NULL
        OR (asg.active IS NOT NULL AND asg.active = 0)
        OR COALESCE(asg.archived, 0) = 1
      )
  `).get().c;

  const myAssigned = userId
    ? db.prepare(`
        SELECT id, req_number, title, status, priority, due_date, updated_at
        FROM sysreq_requirements
        WHERE ${ACTIVE_SQL} AND assignee_id = ? AND status IN (${openList})
        ORDER BY updated_at DESC LIMIT 10
      `).all(userId)
    : [];

  const recentlyUpdated = db.prepare(`
    SELECT id, req_number, title, status, priority, updated_at
    FROM sysreq_requirements
    WHERE ${ACTIVE_SQL}
    ORDER BY updated_at DESC LIMIT 10
  `).all();

  const recentActivity = db.prepare(`
    SELECT h.id, h.requirement_id, h.event_type, h.from_status, h.to_status, h.created_at,
           r.req_number, r.title, u.name AS actor_name
    FROM sysreq_history h
    JOIN sysreq_requirements r ON r.id = h.requirement_id
    LEFT JOIN users u ON u.id = h.actor_id
    WHERE r.soft_deleted_at IS NULL
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT 20
  `).all();

  const byStatus = db.prepare(`
    SELECT status, COUNT(*) cnt FROM sysreq_requirements
    WHERE ${ACTIVE_SQL} GROUP BY status ORDER BY cnt DESC
  `).all();

  const byType = db.prepare(`
    SELECT type, COUNT(*) cnt FROM sysreq_requirements
    WHERE ${ACTIVE_SQL} AND status IN (${openList})
    GROUP BY type ORDER BY cnt DESC
  `).all();

  const assigneeWorkload = db.prepare(`
    SELECT u.id, u.name, COUNT(*) cnt
    FROM sysreq_requirements r
    JOIN users u ON u.id = r.assignee_id
    WHERE r.soft_deleted_at IS NULL
      AND r.status IN (${openList})
    GROUP BY u.id, u.name
    ORDER BY cnt DESC
    LIMIT 15
  `).all();

  return {
    counts: {
      open,
      waiting_approval: waitingApproval,
      with_it_managers: withItManagers,
      pending,
      in_progress: inProgress,
      in_development: pending, // legacy chip key
      testing,
      released_this_month: releasedMonth,
      overdue,
      high_priority: highPriority,
      need_clarification: needClarification,
      stale,
      inactive_assignee: inactiveAssignee,
    },
    my_assigned: myAssigned,
    recently_updated: recentlyUpdated,
    recent_activity: recentActivity,
    by_status: byStatus,
    by_type: byType,
    assignee_workload: assigneeWorkload,
    stale_days: STALE_DAYS,
  };
}

function groupCount(db, column) {
  return db.prepare(`
    SELECT COALESCE(${column}, '(none)') AS key, COUNT(*) AS cnt
    FROM sysreq_requirements
    WHERE ${ACTIVE_SQL}
    GROUP BY ${column}
    ORDER BY cnt DESC
  `).all();
}

function reportByStatus(db) {
  return { rows: groupCount(db, 'status') };
}

function reportByPriority(db) {
  return { rows: groupCount(db, 'priority') };
}

function reportAssigneeWorkload(db) {
  const rows = db.prepare(`
    SELECT COALESCE(u.name, '(unassigned)') AS key,
           COUNT(*) AS cnt,
           SUM(CASE WHEN r.priority IN ('high','urgent') THEN 1 ELSE 0 END) AS high_cnt
    FROM sysreq_requirements r
    LEFT JOIN users u ON u.id = r.assignee_id
    WHERE r.soft_deleted_at IS NULL AND r.status IN (${openList})
    GROUP BY r.assignee_id
    ORDER BY cnt DESC
  `).all();
  return { rows };
}

function reportStale(db, days = STALE_DAYS) {
  const rows = db.prepare(`
    SELECT r.id, r.req_number, r.title, r.status, r.priority,
           r.updated_at, u.name AS assignee_name,
           CAST((julianday('now') - julianday(r.updated_at)) AS INTEGER) AS age_days
    FROM sysreq_requirements r
    LEFT JOIN users u ON u.id = r.assignee_id
    WHERE r.soft_deleted_at IS NULL
      AND r.status IN (${openList})
      AND r.updated_at < datetime('now', ?)
    ORDER BY r.updated_at ASC
    LIMIT 500
  `).all(`-${days} days`);
  return { rows, days };
}

function avgDaysBetween(db, fromStatus, toStatus) {
  const row = db.prepare(`
    SELECT AVG(
      julianday(h2.created_at) - julianday(h1.created_at)
    ) AS avg_days
    FROM sysreq_history h1
    JOIN sysreq_history h2
      ON h2.requirement_id = h1.requirement_id
     AND h2.to_status = ?
     AND h2.created_at >= h1.created_at
    WHERE h1.to_status = ?
  `).get(toStatus, fromStatus);
  return row?.avg_days != null ? Math.round(row.avg_days * 10) / 10 : null;
}

function reportCycleTimes(db) {
  return {
    averages: {
      approval_days: avgDaysBetween(db, 'submitted', 'approved'),
      development_days: avgDaysBetween(db, 'in_progress', 'testing')
        ?? avgDaysBetween(db, 'pending', 'testing')
        ?? avgDaysBetween(db, 'in_development', 'testing'),
      testing_days: avgDaysBetween(db, 'testing', 'released'),
      lead_days: avgDaysBetween(db, 'submitted', 'released'),
    },
    outcomes: db.prepare(`
      SELECT status, COUNT(*) cnt FROM sysreq_requirements
      WHERE soft_deleted_at IS NULL AND status IN ('approved','rejected','need_clarification')
      GROUP BY status
    `).all(),
  };
}

function reportDeliveryLog(db) {
  const rows = db.prepare(`
    SELECT id, req_number, title, type, release_version, target_version,
           completed_at, status
    FROM sysreq_requirements
    WHERE soft_deleted_at IS NULL
      AND status IN ('released','closed')
    ORDER BY COALESCE(completed_at, updated_at) DESC
    LIMIT 500
  `).all();
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', COALESCE(completed_at, updated_at)) AS month, COUNT(*) cnt
    FROM sysreq_requirements
    WHERE soft_deleted_at IS NULL AND status IN ('released','closed')
    GROUP BY month
    ORDER BY month DESC
    LIMIT 24
  `).all();
  return { rows, by_month: byMonth };
}

const REPORTS = {
  by_status: reportByStatus,
  by_priority: reportByPriority,
  assignee_workload: reportAssigneeWorkload,
  stale: reportStale,
  cycle_times: reportCycleTimes,
  delivery_log: reportDeliveryLog,
};

function runReport(db, key, opts = {}) {
  const fn = REPORTS[key];
  if (!fn) {
    const err = new Error(`Unknown report: ${key}`);
    err.status = 404;
    throw err;
  }
  if (key === 'stale') return fn(db, opts.days || STALE_DAYS);
  return fn(db);
}

module.exports = {
  dashboard,
  runReport,
  REPORTS,
};
