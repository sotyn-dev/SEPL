const { isTechOperator, userId } = require('./permissions');

/**
 * SQL fragment + params: which requirements a user may see.
 * Tech operators: all rows. Others: raised ∪ created ∪ assignee ∪ durable watcher.
 */
function visibleRequirementFilter(db, user, alias = 'r') {
  if (isTechOperator(db, user)) {
    return { sql: '1=1', params: [] };
  }
  const uid = userId(user);
  return {
    sql: `(
      ${alias}.requested_by = ?
      OR ${alias}.created_by = ?
      OR ${alias}.assignee_id = ?
      OR EXISTS (
        SELECT 1 FROM sysreq_watchers w
        WHERE w.requirement_id = ${alias}.id AND w.user_id = ?
      )
    )`,
    params: [uid, uid, uid, uid],
  };
}

function canViewRequirement(db, user, reqRow) {
  if (!reqRow) return false;
  if (isTechOperator(db, user)) return true;
  const uid = userId(user);
  if (reqRow.requested_by === uid || reqRow.created_by === uid || reqRow.assignee_id === uid) {
    return true;
  }
  const row = db.prepare(`
    SELECT 1 AS ok FROM sysreq_watchers
    WHERE requirement_id = ? AND user_id = ?
  `).get(reqRow.id, uid);
  return !!row;
}

function addWatchers(db, requirementId, userIds) {
  const ids = [...new Set((userIds || []).map(Number).filter(n => Number.isFinite(n) && n > 0))];
  if (!ids.length) return;
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO sysreq_watchers (requirement_id, user_id)
    VALUES (?, ?)
  `);
  const run = db.transaction((rid, list) => {
    for (const uid of list) stmt.run(rid, uid);
  });
  run(requirementId, ids);
}

module.exports = {
  visibleRequirementFilter,
  canViewRequirement,
  addWatchers,
};
