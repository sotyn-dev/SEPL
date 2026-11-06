// API routes for SEPL ERP Notification System.
// Handles notification listing, filters, unread counts, read synchronization,
// and user notification preferences.

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const notificationService = require('../services/notificationService');

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

// GET /api/notifications/preferences - Get user's notification preferences
router.get('/preferences', (req, res) => {
  try {
    const prefs = notificationService.getAllPreferences(req.user.id);
    res.json(prefs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/notifications/preferences - Update notification preference for a category
router.put('/preferences', (req, res) => {
  try {
    const { category, in_app, push, email } = req.body;
    if (!category) return res.status(400).json({ error: 'Category required' });
    const result = notificationService.setPreference(req.user.id, category, { in_app, push, email });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

