// API routes for SEPL ERP Notification System.
// Handles notification listing, filters, unread counts, read synchronization,
// user notification preferences, and Admin notification enforcement & controls.

const express = require('express');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const notificationService = require('../services/notificationService');
const { getDb } = require('../db/schema');

router.use(authMiddleware);

// GET /api/notifications - List notifications with filters
router.get('/', (req, res) => {
  try {
    const { category, unread, limit = 50, offset = 0 } = req.query;
    const notifications = notificationService.getNotifications(req.user.id, {
      category: category || 'all',
      unreadOnly: unread === '1' || unread === 'true',
      limit: Math.min(Number(limit) || 50, 100),
      offset: Number(offset) || 0
    });
    res.json(notifications);
  } catch (err) {
    console.error('Error fetching notifications:', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/unread-count - Lightweight unread count
router.get('/unread-count', (req, res) => {
  try {
    const count = notificationService.getUnreadCount(req.user.id);
    res.json({ count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/:id/read - Mark single notification as read
router.put('/:id/read', (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid notification id' });
    const result = notificationService.markAsRead(id, req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/mark-all-read - Mark all as read
router.post('/mark-all-read', (req, res) => {
  try {
    const result = notificationService.markAllAsRead(req.user.id);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/notifications/preferences - Get user's notification preferences with enforcement metadata
router.get('/preferences', (req, res) => {
  try {
    const prefs = notificationService.getAllPreferences(req.user.id);
    const db = getDb();
    let strictlyEnforced = false;
    let pushMandated = true;
    try {
      const ctrl = db.prepare(`SELECT strictly_enforced, push_mandated FROM user_notification_controls WHERE user_id = ?`).get(req.user.id);
      if (ctrl) {
        strictlyEnforced = ctrl.strictly_enforced === 1;
        pushMandated = ctrl.push_mandated === 1;
      }
    } catch (_) {}
    res.json({
      ...prefs,
      _is_strictly_enforced: strictlyEnforced,
      _push_mandated: pushMandated
    });
  } catch (err) {
    console.error('Error fetching preferences:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/preferences - Update notification preference for a category
router.put('/preferences', (req, res) => {
  try {
    const { category, in_app, push, email } = req.body;
    if (!category) return res.status(400).json({ error: 'Category required' });

    // Check if user is strictly enforced by admin
    const db = getDb();
    if (req.user.role !== 'admin') {
      try {
        const ctrl = db.prepare(`SELECT strictly_enforced FROM user_notification_controls WHERE user_id = ?`).get(req.user.id);
        if (ctrl && ctrl.strictly_enforced === 1) {
          if (in_app === false || push === false) {
            return res.status(403).json({ error: 'Notification settings are strictly locked and enforced by company policy.' });
          }
        }
      } catch (_) {}
    }

    const result = notificationService.setPreference(req.user.id, category, { in_app, push, email });
    res.json(result);
  } catch (err) {
    console.error('Error updating preference:', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── ADMIN NOTIFICATION & PUSH CONTROL MATRIX ─────────────────────────────────

// GET /api/notifications/admin/employee-matrix - List all employees with push & notification status
router.get('/admin/employee-matrix', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const defaultCategories = ['chat_mention', 'chat_dm', 'delegation', 'ticket', 'approval', 'general'];

    // 1. Fetch all non-archived users
    const users = db.prepare(`
      SELECT 
        u.id, 
        u.name, 
        u.username, 
        u.email, 
        u.role, 
        u.department, 
        u.active,
        c.strictly_enforced,
        c.push_mandated,
        c.updated_at AS enforced_at,
        c.enforced_by,
        admin_u.name AS enforced_by_name
      FROM users u
      LEFT JOIN user_notification_controls c ON c.user_id = u.id
      LEFT JOIN users admin_u ON admin_u.id = c.enforced_by
      WHERE COALESCE(u.archived, 0) = 0
      ORDER BY u.name COLLATE NOCASE ASC
    `).all();

    // 2. Fetch all push subscriptions
    const subs = db.prepare(`
      SELECT id, user_id, device_label, user_agent, active, last_seen_at, created_at
      FROM push_subscriptions
      ORDER BY last_seen_at DESC
    `).all();

    const subsByUserId = {};
    for (const s of subs) {
      if (!subsByUserId[s.user_id]) subsByUserId[s.user_id] = [];
      subsByUserId[s.user_id].push(s);
    }

    // 3. Fetch all notification preferences
    const prefs = db.prepare(`
      SELECT user_id, category, in_app, push, email
      FROM notification_preferences
    `).all();

    const prefsByUserId = {};
    for (const p of prefs) {
      if (!prefsByUserId[p.user_id]) prefsByUserId[p.user_id] = {};
      prefsByUserId[p.user_id][p.category] = {
        in_app: p.in_app !== 0,
        push: p.push !== 0,
        email: p.email !== 0
      };
    }

    // Combine matrix
    const matrix = users.map(u => {
      const userSubs = subsByUserId[u.id] || [];
      const activeSubs = userSubs.filter(s => s.active === 1);
      const userPrefs = prefsByUserId[u.id] || {};

      // Fill fallback default categories
      const finalPrefs = {};
      for (const cat of defaultCategories) {
        finalPrefs[cat] = userPrefs[cat] || { in_app: true, push: true, email: false };
      }

      let overallPushStatus = 'unregistered';
      if (activeSubs.length > 0) {
        overallPushStatus = 'active';
      } else if (userSubs.length > 0) {
        overallPushStatus = 'disabled';
      }

      return {
        id: u.id,
        name: u.name,
        username: u.username,
        email: u.email,
        role: u.role,
        department: u.department,
        active: u.active !== 0,
        strictly_enforced: u.strictly_enforced === 1,
        push_mandated: u.push_mandated === 1 || u.push_mandated === null,
        enforced_at: u.enforced_at,
        enforced_by_name: u.enforced_by_name,
        total_devices: userSubs.length,
        active_devices: activeSubs.length,
        devices: userSubs,
        latest_seen_at: userSubs[0]?.last_seen_at || null,
        overall_push_status: overallPushStatus,
        preferences: finalPrefs
      };
    });

    res.json(matrix);
  } catch (err) {
    console.error('Error fetching employee notification matrix:', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/admin/employee/:user_id - Admin updates enforcement & preferences for an employee
router.put('/admin/employee/:user_id', adminOnly, (req, res) => {
  try {
    const targetUserId = Number(req.params.user_id);
    if (!targetUserId) return res.status(400).json({ error: 'Valid user_id required' });

    const db = getDb();
    const { strictly_enforced, push_mandated, preferences, reactivate_devices } = req.body;

    // 1. Update user_notification_controls
    if (strictly_enforced !== undefined || push_mandated !== undefined) {
      const existing = db.prepare(`SELECT strictly_enforced, push_mandated FROM user_notification_controls WHERE user_id = ?`).get(targetUserId);
      const newEnforced = strictly_enforced !== undefined ? (strictly_enforced ? 1 : 0) : (existing?.strictly_enforced || 0);
      const newMandated = push_mandated !== undefined ? (push_mandated ? 1 : 0) : (existing?.push_mandated !== undefined ? existing.push_mandated : 1);

      db.prepare(`
        INSERT INTO user_notification_controls (user_id, strictly_enforced, push_mandated, enforced_by, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id) DO UPDATE SET
          strictly_enforced = excluded.strictly_enforced,
          push_mandated = excluded.push_mandated,
          enforced_by = excluded.enforced_by,
          updated_at = CURRENT_TIMESTAMP
      `).run(targetUserId, newEnforced, newMandated, req.user.id);
    }

    // 2. Update preferences if provided
    if (preferences && typeof preferences === 'object') {
      for (const [cat, p] of Object.entries(preferences)) {
        notificationService.setPreference(targetUserId, cat, {
          in_app: p.in_app !== undefined ? (p.in_app ? 1 : 0) : 1,
          push: p.push !== undefined ? (p.push ? 1 : 0) : 1,
          email: p.email !== undefined ? (p.email ? 1 : 0) : 0
        });
      }
    }

    // 3. Reactivate devices if requested (admin remote ON)
    if (reactivate_devices) {
      db.prepare(`UPDATE push_subscriptions SET active = 1 WHERE user_id = ?`).run(targetUserId);
    }

    res.json({ ok: true, message: 'Employee notification configuration updated successfully' });
  } catch (err) {
    console.error('Error updating employee notification control:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/notifications/admin/bulk-update - Bulk enforce or enable notifications
router.post('/admin/bulk-update', adminOnly, (req, res) => {
  try {
    const { user_ids, strictly_enforced, turn_on_all } = req.body;
    const db = getDb();
    const defaultCategories = ['chat_mention', 'chat_dm', 'delegation', 'ticket', 'approval', 'general'];

    let targetIds = [];
    if (user_ids === 'all' || !Array.isArray(user_ids) || user_ids.length === 0) {
      targetIds = db.prepare(`SELECT id FROM users WHERE COALESCE(archived,0)=0`).all().map(r => r.id);
    } else {
      targetIds = user_ids.map(Number).filter(Boolean);
    }

    const tx = db.transaction(() => {
      for (const uid of targetIds) {
        if (strictly_enforced !== undefined) {
          const enforcedVal = strictly_enforced ? 1 : 0;
          db.prepare(`
            INSERT INTO user_notification_controls (user_id, strictly_enforced, push_mandated, enforced_by, updated_at)
            VALUES (?, ?, 1, ?, CURRENT_TIMESTAMP)
            ON CONFLICT(user_id) DO UPDATE SET
              strictly_enforced = excluded.strictly_enforced,
              enforced_by = excluded.enforced_by,
              updated_at = CURRENT_TIMESTAMP
          `).run(uid, enforcedVal, req.user.id);
        }

        if (turn_on_all) {
          // Reactivate all push subscriptions
          db.prepare(`UPDATE push_subscriptions SET active = 1 WHERE user_id = ?`).run(uid);

          // Enable all categories for in_app and push
          for (const cat of defaultCategories) {
            db.prepare(`
              INSERT INTO notification_preferences (user_id, category, in_app, push, email, updated_at)
              VALUES (?, ?, 1, 1, 0, CURRENT_TIMESTAMP)
              ON CONFLICT(user_id, category) DO UPDATE SET
                in_app = 1,
                push = 1,
                updated_at = CURRENT_TIMESTAMP
            `).run(uid, cat);
          }
        }
      }
    });

    tx();

    res.json({ ok: true, affected: targetIds.length });
  } catch (err) {
    console.error('Error in bulk update notifications:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
