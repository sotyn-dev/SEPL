// Central Notification Engine for SEPL ERP.
// Single source of truth: All notifications are saved to the SQLite database first,
// then delivered in real-time via Socket.IO (in-app) and Web Push (device / background).

const { getDb } = require('../db/schema');
const { getIO } = require('../lib/chatSocket');
const push = require('../lib/push');

// Map internal event categories to preferences category key
function resolveCategory(type, referenceType) {
  const t = String(type || '').toLowerCase();
  const r = String(referenceType || '').toLowerCase();
  if (t.includes('mention') || r === 'chat_mention') return 'chat_mention';
  if (t.includes('dm') || r === 'chat_dm') return 'chat_dm';
  if (t.includes('chat') || r === 'chat') return 'chat';
  if (t.includes('delegat') || r.includes('delegat')) return 'delegation';
  if (t.includes('ticket') || r.includes('ticket') || r.includes('support')) return 'ticket';
  if (t.includes('approv') || r.includes('approv') || r.includes('procure')) return 'approval';
  return 'general';
}

/**
 * Check if the user has enabled in_app / push for this category
 */
function getUserPreferences(db, userId, category) {
  try {
    const row = db.prepare(
      `SELECT in_app, push, email FROM notification_preferences WHERE user_id = ? AND category = ?`
    ).get(userId, category);
    if (row) {
      return {
        in_app: row.in_app !== 0,
        push: row.push !== 0,
        email: row.email !== 0
      };
    }
  } catch (_) {}
  // Default: both in_app and push are enabled (1)
  return { in_app: true, push: true, email: false };
}

/**
 * Create and dispatch a central notification
 * @param {Object} options
 * @param {number} options.userId - Recipient user ID
 * @param {string} options.type - 'mention' | 'dm' | 'delegation' | 'ticket' | 'approval' | 'general'
 * @param {string} options.title - Notification header
 * @param {string} options.body - Notification description / preview
 * @param {string} [options.referenceType] - 'chat' | 'delegation' | 'ticket' | 'approval' etc.
 * @param {number|string} [options.referenceId] - ID of the target record
 * @param {string} [options.actionUrl] - Link to navigate to upon click
 * @param {string} [options.priority] - 'normal' | 'high' | 'urgent' (default: 'normal')
 * @param {string} [options.dedupeKey] - Unique key to prevent duplicates
 * @param {string} [options.module] - Friendly module name
 * @param {Object} [options.metadata] - Extra data
 */
async function createNotification(options) {
  const {
    userId,
    type = 'general',
    title,
    body = '',
    referenceType = null,
    referenceId = null,
    actionUrl = '/',
    priority = 'normal',
    dedupeKey = null,
    module: moduleName = null,
  } = options || {};

  if (!userId || !title) {
    return { ok: false, reason: 'missing_user_or_title' };
  }

  const db = getDb();
  const category = resolveCategory(type, referenceType);

  // 1. Deduplication check
  if (dedupeKey) {
    try {
      const existing = db.prepare(
        `SELECT id, created_at FROM notifications 
         WHERE user_id = ? AND dedupe_key = ? 
         AND created_at >= datetime('now', '-24 hours')`
      ).get(userId, dedupeKey);
      if (existing) {
        return { ok: true, duplicate: true, id: existing.id };
      }
    } catch (_) {}
  }

  // 2. Preference check
  const prefs = getUserPreferences(db, userId, category);

  let notifRecord = null;
  const channelList = [];
  if (prefs.in_app) channelList.push('in_app');
  if (prefs.push) channelList.push('push');

  // 3. Database persistence (Single source of truth)
  if (prefs.in_app) {
    try {
      const result = db.prepare(`
        INSERT INTO notifications (
          user_id, type, title, body, link_url,
          reference_id, reference_type, priority,
          channel_sent, dedupe_key, is_read, module, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, CURRENT_TIMESTAMP)
      `).run(
        userId,
        type,
        title,
        body,
        actionUrl,
        referenceId ? Number(referenceId) : null,
        referenceType,
        priority,
        channelList.join(','),
        dedupeKey,
        moduleName || referenceType || 'general'
      );

      notifRecord = {
        id: result.lastInsertRowid,
        user_id: userId,
        type,
        title,
        body,
        link_url: actionUrl,
        reference_id: referenceId ? Number(referenceId) : null,
        reference_type: referenceType,
        priority,
        is_read: 0,
        module: moduleName || referenceType || 'general',
        created_at: new Date().toISOString()
      };
    } catch (dbErr) {
      console.error('[notificationService] DB insert error:', dbErr.message);
      return { ok: false, error: dbErr.message };
    }
  }

  // 4. Real-time In-App Delivery via Socket.IO (when ERP tab is open)
  if (prefs.in_app && notifRecord) {
    try {
      const io = getIO();
      if (io) {
        io.to(`u:${userId}`).emit('notification:new', notifRecord);
      }
    } catch (sockErr) {
      console.warn('[notificationService] Socket emit error:', sockErr.message);
    }
  }

  // 5. System Web Push Delivery via Service Worker (Desktop & Mobile background push)
  if (prefs.push) {
    const pushPayload = {
      type: type || 'erp_notification',
      notificationId: notifRecord ? notifRecord.id : null,
      title,
      body: body ? String(body).slice(0, 240) : '',
      url: actionUrl || '/',
      tag: dedupeKey || `notif-${notifRecord ? notifRecord.id : Date.now()}`,
      priority,
      reference_type: referenceType,
      reference_id: referenceId,
      icon: '/icon-192.png',
      badge: '/icon-192.png'
    };

    // Non-blocking fire-and-forget push delivery
    push.notify(userId, pushPayload);
  }

  return { ok: true, notification: notifRecord };
}

/**
 * Mark a single notification as read
 * Synchronizes read state across all of user's active devices and tabs
 */
function markAsRead(notificationId, userId) {
  const db = getDb();
  try {
    const info = db.prepare(
      `UPDATE notifications 
       SET is_read = 1, read_at = CURRENT_TIMESTAMP 
       WHERE id = ? AND user_id = ? AND (is_read = 0 OR is_read IS NULL)`
    ).run(notificationId, userId);

    if (info.changes > 0) {
      // Broadcast read sync event to all connected devices for this user
      const io = getIO();
      if (io) {
        io.to(`u:${userId}`).emit('notification:read', { id: notificationId, all: false });
      }
    }
    return { ok: true, changes: info.changes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Mark all notifications as read for a user
 * Synchronizes read state across all devices
 */
function markAllAsRead(userId) {
  const db = getDb();
  try {
    const info = db.prepare(
      `UPDATE notifications 
       SET is_read = 1, read_at = CURRENT_TIMESTAMP 
       WHERE user_id = ? AND (is_read = 0 OR is_read IS NULL)`
    ).run(userId);

    const io = getIO();
    if (io) {
      io.to(`u:${userId}`).emit('notification:read', { all: true });
    }
    return { ok: true, changes: info.changes };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch notifications with filters (category, unread, limit)
 */
function getNotifications(userId, options = {}) {
  const db = getDb();
  const { category, unreadOnly, limit = 50, offset = 0 } = options;

  let query = `
    SELECT id, user_id, type, title, body, link_url,
           reference_id, reference_type, priority,
           is_read, module, read_at, created_at,
           COALESCE(is_mandatory, 0) as is_mandatory,
           status, acknowledged_at
    FROM notifications
    WHERE user_id = ?
  `;
  const params = [userId];

  if (unreadOnly) {
    query += ` AND (is_read = 0 OR is_read IS NULL)`;
  }

  if (category && category !== 'all') {
    switch (category) {
      case 'chat':
        query += ` AND (reference_type = 'chat' OR type LIKE '%chat%' OR type LIKE '%mention%' OR type LIKE '%dm%')`;
        break;
      case 'delegation':
        query += ` AND (reference_type = 'delegation' OR type LIKE '%delegat%')`;
        break;
      case 'ticket':
        query += ` AND (reference_type = 'ticket' OR type LIKE '%ticket%' OR type LIKE '%support%')`;
        break;
      case 'approval':
        query += ` AND (reference_type = 'approval' OR type LIKE '%approv%' OR type LIKE '%procure%')`;
        break;
      default:
        query += ` AND (reference_type = ? OR module = ?)`;
        params.push(category, category);
    }
  }

  query += ` ORDER BY (CASE WHEN is_mandatory = 1 AND status = 'active' THEN 1 ELSE 0 END) DESC, is_read ASC, id DESC LIMIT ? OFFSET ?`;
  params.push(Number(limit), Number(offset));

  try {
    const rows = db.prepare(query).all(...params);
    return rows;
  } catch (err) {
    console.error('[notificationService] getNotifications error:', err.message);
    return [];
  }
}

/**
 * Get total unread count for user's notification bell
 */
function getUnreadCount(userId) {
  const db = getDb();
  try {
    const row = db.prepare(
      `SELECT COUNT(*) as count FROM notifications 
       WHERE user_id = ? AND (is_read = 0 OR is_read IS NULL)`
    ).get(userId);
    return row?.count || 0;
  } catch (_) {
    return 0;
  }
}

/**
 * Get all notification preferences for a user
 */
function getAllPreferences(userId) {
  const db = getDb();
  const defaultCategories = ['chat_mention', 'chat_dm', 'delegation', 'ticket', 'approval', 'general'];
  try {
    const rows = db.prepare(
      `SELECT category, in_app, push, email FROM notification_preferences WHERE user_id = ?`
    ).all(userId);
    const prefMap = {};
    for (const r of rows) {
      prefMap[r.category] = {
        in_app: r.in_app !== 0,
        push: r.push !== 0,
        email: r.email !== 0
      };
    }
    // Return filled preferences with fallback defaults
    const result = {};
    for (const cat of defaultCategories) {
      result[cat] = prefMap[cat] || { in_app: true, push: true, email: false };
    }
    return result;
  } catch (err) {
    return {};
  }
}

/**
 * Update user preference for a category
 */
function setPreference(userId, category, { in_app, push: pushPref, email }) {
  const db = getDb();
  try {
    db.prepare(`
      INSERT INTO notification_preferences (user_id, category, in_app, push, email, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, category) DO UPDATE SET
        in_app = COALESCE(excluded.in_app, in_app),
        push = COALESCE(excluded.push, push),
        email = COALESCE(excluded.email, email),
        updated_at = CURRENT_TIMESTAMP
    `).run(
      userId,
      category,
      in_app === undefined ? 1 : (in_app ? 1 : 0),
      pushPref === undefined ? 1 : (pushPref ? 1 : 0),
      email === undefined ? 0 : (email ? 1 : 0)
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  createNotification,
  markAsRead,
  markAllAsRead,
  getNotifications,
  getUnreadCount,
  getAllPreferences,
  setPreference,
  getUserPreferences
};

