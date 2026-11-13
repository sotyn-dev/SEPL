// Push notification subscription endpoints. Frontend service worker
// calls /vapid for the public key, then /subscribe to register the
// browser endpoint. Backend then uses lib/push.js helper to fan
// notifications to whichever user(s) need them.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getPublicKey, pushToUser, pushToAll } = require('../lib/push');

// Public key — anyone can fetch (the public half is meant to be public).
router.get('/vapid', (req, res) => {
  try {
    const key = getPublicKey();
    if (!key) return res.status(503).json({ error: 'VAPID keys not initialised yet' });
    res.json({ publicKey: key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// The worker cannot read the user's login token when SOTYN is closed. Only a
// random capability delivered in that specific, unexpired call push is valid.
router.post('/call-receipt', (req, res) => {
  const { acknowledgeCallNotification } = require('../lib/callSignalling');
  const { getIO } = require('../lib/chatSocket');
  const accepted = acknowledgeCallNotification(getIO(), req.body);
  res.status(accepted ? 204 : 404).end();
});

router.use(authMiddleware);

// Save / refresh a subscription. Called by the client right after the
// browser grants notification permission AND on every login (in case
// the endpoint rotated).
router.post('/subscribe', (req, res) => {
  try {
    const { endpoint, keys, device_label } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint + keys.p256dh + keys.auth required' });
    }
    const ua = req.headers['user-agent'] || '';
    const db = getDb();
    db.prepare(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, device_label, active, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(endpoint) DO UPDATE SET
        user_id=excluded.user_id,
        p256dh=excluded.p256dh,
        auth=excluded.auth,
        user_agent=excluded.user_agent,
        device_label=COALESCE(excluded.device_label, device_label),
        active=1,
        last_seen_at=CURRENT_TIMESTAMP
    `).run(req.user.id, endpoint, keys.p256dh, keys.auth, ua, device_label || null);
    res.json({ message: 'Subscribed' });
  } catch (err) {
    console.error('subscribe error', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/unsubscribe', (req, res) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) return res.status(400).json({ error: 'endpoint required' });

    // Check if user notification policy is strictly enforced
    if (req.user.role !== 'admin') {
      try {
        const ctrl = getDb().prepare('SELECT strictly_enforced FROM user_notification_controls WHERE user_id = ?').get(req.user.id);
        if (ctrl && ctrl.strictly_enforced === 1) {
          return res.status(403).json({ error: 'Push notifications are strictly mandatory for your account and cannot be disabled.' });
        }
      } catch (_) {}
    }

    getDb().prepare(`UPDATE push_subscriptions SET active=0 WHERE endpoint=? AND user_id=?`)
      .run(endpoint, req.user.id);
    res.json({ message: 'Unsubscribed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List my devices
router.get('/devices', (req, res) => {
  const rows = getDb().prepare(`
    SELECT id, device_label, user_agent, active, last_seen_at, created_at
    FROM push_subscriptions WHERE user_id = ? ORDER BY last_seen_at DESC
  `).all(req.user.id);
  res.json(rows);
});

// Test push to current user (anyone can fire to their own devices)
router.post('/test', async (req, res) => {
  try {
    const r = await pushToUser(req.user.id, {
      type: 'chat_push_test',
      title: 'SOTYN Chat — Test Notification',
      body: req.body?.message || 'If you can read this, push notifications are working on this device 🎉',
      url: '/site-chat',
      tag: 'test',
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin test push to a specific employee (verifies their registered devices)
router.post('/admin/test-employee/:user_id', adminOnly, async (req, res) => {
  try {
    const targetUserId = Number(req.params.user_id);
    if (!targetUserId) return res.status(400).json({ error: 'Target user_id required' });

    const r = await pushToUser(targetUserId, {
      type: 'chat_push_test',
      title: 'SEPL Admin Test Alert',
      body: req.body?.message || 'Admin test: Your device push notifications are active and verified ✓',
      url: '/site-chat',
      tag: 'admin_test',
    });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin broadcast — push a custom message to everyone (e.g. urgent
// company-wide alert from MD).
router.post('/broadcast', adminOnly, async (req, res) => {
  try {
    const { title, body, url } = req.body;
    if (!title || !body) return res.status(400).json({ error: 'title and body required' });
    const r = await pushToAll({ title, body, url: url || '/', tag: 'broadcast' });
    res.json(r);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
