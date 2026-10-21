const { getDb } = require('../db/schema');
const { getChatDb } = require('../db/chatDb');
const { getBoardDb } = require('../db/sotynFlowDb');
const { revokeUserSessions, clearSessionCache } = require('../middleware/auth');

/**
 * Triggered whenever a user is deactivated (active=0) or archived (archived=1).
 * Cascades to:
 * - Linked employee status in erp.db
 * - Removes user from all group chats (non-DM) in chat.db
 * - Removes user from all board member lists in sotynflow.db
 * - Revokes live sessions so the account cannot perform further actions
 */
function onUserDeactivatedOrArchived(userId, isArchived = false) {
  if (!userId) return;
  const db = getDb();

  // 1. Synchronize linked employee
  try {
    if (isArchived) {
      db.prepare("UPDATE employees SET status = 'terminated', exit_date = COALESCE(exit_date, DATE('now', '+5.5 hours')) WHERE user_id = ?").run(userId);
    } else {
      db.prepare("UPDATE employees SET status = 'inactive', exit_date = COALESCE(exit_date, DATE('now', '+5.5 hours')) WHERE user_id = ? AND LOWER(COALESCE(status, '')) != 'terminated'").run(userId);
    }
  } catch (e) {
    console.error(`[userStatusSync] employee sync failed for user ${userId}:`, e.message);
  }

  // 2. Prune from group chat memberships (non-DM groups only; DMs preserved)
  try {
    const chatDb = getChatDb();
    chatDb.prepare(`
      DELETE FROM chat_group_members 
      WHERE user_id = ? 
        AND group_id IN (SELECT id FROM chat_groups WHERE COALESCE(is_dm, 0) = 0)
    `).run(userId);
  } catch (e) {
    // chat.db may be offline or uninitialized
  }

  // 3. Prune from sotynflow board memberships
  try {
    const boardDb = getBoardDb();
    boardDb.prepare(`DELETE FROM board_members WHERE user_id = ?`).run(userId);
  } catch (e) {
    // sotynflow.db may be offline or uninitialized
  }

  // 4. Invalidate sessions
  try {
    revokeUserSessions(userId, db);
    clearSessionCache(userId);
  } catch (e) {
    // ignore
  }
}

/**
 * Self-healing routine run on startup:
 * Ensures data consistency between employees, users, chat groups, and flow boards.
 */
function healInactiveAndTerminatedUsers(db = getDb()) {
  try {
    // 1. Terminated employees -> ensure linked users have active=0, archived=1
    const terminatedEmps = db.prepare(`
      SELECT user_id FROM employees 
      WHERE user_id IS NOT NULL 
        AND LOWER(TRIM(status)) = 'terminated'
    `).all();
    for (const t of terminatedEmps) {
      if (t.user_id) {
        db.prepare('UPDATE users SET active = 0, archived = 1 WHERE id = ? AND (active = 1 OR COALESCE(archived,0) = 0)').run(t.user_id);
      }
    }

    // 2. Inactive employees -> ensure linked users have active=0
    const inactiveEmps = db.prepare(`
      SELECT user_id FROM employees 
      WHERE user_id IS NOT NULL 
        AND LOWER(TRIM(status)) = 'inactive'
    `).all();
    for (const inact of inactiveEmps) {
      if (inact.user_id) {
        db.prepare('UPDATE users SET active = 0 WHERE id = ? AND active = 1').run(inact.user_id);
      }
    }

    // 3. Archived users -> ensure linked employee is status='terminated'
    const archivedUsers = db.prepare(`
      SELECT id FROM users WHERE COALESCE(archived,0) = 1
    `).all();
    for (const au of archivedUsers) {
      db.prepare("UPDATE employees SET status = 'terminated' WHERE user_id = ? AND LOWER(COALESCE(status,'')) != 'terminated'").run(au.id);
    }

    // 4. Inactive users (active=0, not archived) -> ensure linked employee is inactive (unless already terminated)
    const inactiveUsers = db.prepare(`
      SELECT id FROM users WHERE active = 0 AND COALESCE(archived,0) = 0
    `).all();
    for (const iu of inactiveUsers) {
      db.prepare("UPDATE employees SET status = 'inactive' WHERE user_id = ? AND LOWER(COALESCE(status,'')) = 'active'").run(iu.id);
    }

    // 5. Gather all inactive or archived user IDs to cleanse chat.db and sotynflow.db
    const allInactiveUserIds = db.prepare(`
      SELECT id FROM users 
      WHERE active = 0 OR COALESCE(archived, 0) = 1
         OR id IN (SELECT user_id FROM employees WHERE user_id IS NOT NULL AND LOWER(TRIM(status)) IN ('terminated', 'inactive'))
    `).all().map(r => r.id);

    if (allInactiveUserIds.length > 0) {
      // Clean chat groups
      try {
        const chatDb = getChatDb();
        const ph = allInactiveUserIds.map(() => '?').join(',');
        chatDb.prepare(`
          DELETE FROM chat_group_members 
          WHERE user_id IN (${ph}) 
            AND group_id IN (SELECT id FROM chat_groups WHERE COALESCE(is_dm, 0) = 0)
        `).run(...allInactiveUserIds);
      } catch (_) {}

      // Clean board members
      try {
        const boardDb = getBoardDb();
        const ph = allInactiveUserIds.map(() => '?').join(',');
        boardDb.prepare(`
          DELETE FROM board_members 
          WHERE user_id IN (${ph})
        `).run(...allInactiveUserIds);
      } catch (_) {}
    }
  } catch (e) {
    console.warn('[userStatusSync] healInactiveAndTerminatedUsers warning:', e.message);
  }
}

module.exports = {
  onUserDeactivatedOrArchived,
  healInactiveAndTerminatedUsers
};
