function listActiveUsers(db) {
  return db.prepare(`
    SELECT u.id, u.name, u.email, u.department
    FROM users u
    WHERE (u.active IS NULL OR u.active = 1)
      AND COALESCE(u.archived, 0) = 0
    ORDER BY u.name COLLATE NOCASE
  `).all();
}

function isUserActive(db, userId) {
  if (!userId) return false;
  const row = db.prepare(`
    SELECT id FROM users
    WHERE id = ?
      AND (active IS NULL OR active = 1)
      AND COALESCE(archived, 0) = 0
  `).get(Number(userId));
  return !!row;
}

/** SQL fragment: assignee is missing or inactive/archived. Alias users table as `asg`. */
const ASSIGNEE_INACTIVE_SQL = `
  r.assignee_id IS NOT NULL
  AND (
    asg.id IS NULL
    OR (asg.active IS NOT NULL AND asg.active = 0)
    OR COALESCE(asg.archived, 0) = 1
  )
`;

module.exports = { listActiveUsers, isUserActive, ASSIGNEE_INACTIVE_SQL };
