const { STALE_DAYS, OPEN_STATUSES } = require('./constants');

const ACTIVE_SQL = `soft_deleted_at IS NULL`;
const openList = OPEN_STATUSES.map(s => `'${s}'`).join(',');

/**
 * @param {object} opts
 * @param {number} [opts.userId]
 * @param {{ sql: string, params: any[] }} [opts.visibility] — AND-clause for non-tech scoping
 */
function dashboard(db, { userId, visibility } = {}) {
  const v = visibility && visibility.sql !== '1=1'
    ? { sql: visibility.sql, params: visibility.params || [] }
    : { sql: '1=1', params: [] };
  const vParams = v.params;
  const active = `r.soft_deleted_at IS NULL`;

  const countStatusAliased = (statuses) => {
    const ph = statuses.map(() => '?').join(',');
    return db.prepare(
      `SELECT COUNT(*) c FROM sysreq_requirements r
       WHERE ${active} AND r.status IN (${ph}) AND (${v.sql})`
    ).get(...statuses, ...vParams).c;
  };

  const open = db.prepare(
    `SELECT COUNT(*) c FROM sysreq_requirements r
     WHERE ${active} AND r.status IN (${openList}) AND (${v.sql})`
  ).get(...vParams).c;

  const waitingApproval = countStatusAliased(['under_review']);
  const withItManagers = countStatusAliased(['submitted']);
  const pending = countStatusAliased(['pending', 'in_development']);
  const inProgress = countStatusAliased(['in_progress']);
  const testing = countStatusAliased(['testing']);
  const releasedMonth = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements r
    WHERE ${active} AND r.status IN ('released','done')
      AND COALESCE(r.completed_at, r.updated_at) >= datetime('now', 'start of month')
      AND (${v.sql})
  `).get(...vParams).c;

  const overdue = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements r
    WHERE ${active}
      AND r.due_date IS NOT NULL AND r.due_date < date('now')
      AND r.status NOT IN ('released','done','closed','archived','rejected')
      AND (${v.sql})
  `).get(...vParams).c;

  const highPriority = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements r
    WHERE ${active}
      AND r.priority IN ('high','urgent')
      AND r.status IN (${openList})
      AND (${v.sql})
  `).get(...vParams).c;

  const needClarification = countStatusAliased(['need_clarification']);

  const stale = db.prepare(`
    SELECT COUNT(*) c FROM sysreq_requirements r
    WHERE ${active}
      AND r.status IN (${openList})
      AND r.updated_at < datetime('now', ?)
      AND (${v.sql})
  `).get(`-${STALE_DAYS} days`, ...vParams).c;

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
      AND (${v.sql})
  `).get(...vParams).c;

  const myAssigned = userId
    ? db.prepare(`
        SELECT id, req_number, title, status, priority, due_date, updated_at
        FROM sysreq_requirements r
        WHERE ${active} AND r.assignee_id = ? AND r.status IN (${openList}) AND (${v.sql})
        ORDER BY r.updated_at DESC LIMIT 10
      `).all(userId, ...vParams)
    : [];

  const recentlyUpdated = db.prepare(`
    SELECT r.id, r.req_number, r.title, r.status, r.priority, r.updated_at
    FROM sysreq_requirements r
    WHERE ${active} AND (${v.sql})
    ORDER BY r.updated_at DESC LIMIT 10
  `).all(...vParams);

  const recentActivity = db.prepare(`
    SELECT h.id, h.requirement_id, h.event_type, h.from_status, h.to_status, h.created_at,
           r.req_number, r.title, u.name AS actor_name
    FROM sysreq_history h
    JOIN sysreq_requirements r ON r.id = h.requirement_id
    LEFT JOIN users u ON u.id = h.actor_id
    WHERE r.soft_deleted_at IS NULL AND (${v.sql})
    ORDER BY h.created_at DESC, h.id DESC
    LIMIT 20
  `).all(...vParams);

  const byStatus = db.prepare(`
    SELECT r.status, COUNT(*) cnt FROM sysreq_requirements r
    WHERE ${active} AND (${v.sql}) GROUP BY r.status ORDER BY cnt DESC
  `).all(...vParams);

  const byType = db.prepare(`
    SELECT r.type, COUNT(*) cnt FROM sysreq_requirements r
    WHERE ${active} AND r.status IN (${openList}) AND (${v.sql})
    GROUP BY r.type ORDER BY cnt DESC
  `).all(...vParams);

  const assigneeWorkload = db.prepare(`
    SELECT u.id, u.name, COUNT(*) cnt
    FROM sysreq_requirements r
    JOIN users u ON u.id = r.assignee_id
    WHERE r.soft_deleted_at IS NULL
      AND r.status IN (${openList})
      AND (${v.sql})
    GROUP BY u.id, u.name
    ORDER BY cnt DESC
    LIMIT 15
  `).all(...vParams);

  return {
    counts: {
      open,
      waiting_approval: waitingApproval,
      with_it_managers: withItManagers,
      pending,
      in_progress: inProgress,
      in_development: pending,
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
      AND status IN ('released','done')
    ORDER BY COALESCE(completed_at, updated_at) DESC
    LIMIT 500
  `).all();
  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', COALESCE(completed_at, updated_at)) AS month, COUNT(*) cnt
    FROM sysreq_requirements
    WHERE soft_deleted_at IS NULL AND status IN ('released','done')
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
