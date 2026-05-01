const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// All non-expired announcements, pinned first then newest first. Each row
// carries the author's name and an `is_new` flag so the UI can highlight
// announcements posted since this user's last visit to the panel.
router.get('/', (req, res) => {
  const db = getDb();
  const seen = db.prepare('SELECT last_seen_at FROM announcement_reads WHERE user_id=?').get(req.user.id);
  const lastSeen = seen?.last_seen_at || '1970-01-01';
  const rows = db.prepare(`
    SELECT a.*, u.name as created_by_name,
           CASE WHEN a.created_at > ? THEN 1 ELSE 0 END as is_new
      FROM announcements a
      LEFT JOIN users u ON u.id = a.created_by
     WHERE (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
     ORDER BY a.pinned DESC, a.created_at DESC
  `).all(lastSeen);
  res.json(rows);
});

// Light-weight unread count for the bell icon — used in the header layout
// so we don't have to fetch all announcement bodies just to know the badge.
router.get('/unread-count', (req, res) => {
  const db = getDb();
  const seen = db.prepare('SELECT last_seen_at FROM announcement_reads WHERE user_id=?').get(req.user.id);
  const lastSeen = seen?.last_seen_at || '1970-01-01';
  const row = db.prepare(`
    SELECT COUNT(*) as count
      FROM announcements a
     WHERE a.created_at > ?
       AND (a.expires_at IS NULL OR a.expires_at > CURRENT_TIMESTAMP)
  `).get(lastSeen);
  res.json({ count: row?.count || 0 });
});

// Mark all current announcements as seen for this user — call on panel open.
router.post('/mark-seen', (req, res) => {
  const db = getDb();
  // UPSERT: insert if missing, otherwise bump last_seen_at to now.
  db.prepare(`
    INSERT INTO announcement_reads (user_id, last_seen_at)
    VALUES (?, CURRENT_TIMESTAMP)
    ON CONFLICT(user_id) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
  `).run(req.user.id);
  res.json({ message: 'Marked seen' });
});

// Admin-only — create a new announcement.
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can post announcements' });
  const { title, body, pinned, expires_at } = req.body || {};
  const t = String(title || '').trim();
  if (!t) return res.status(400).json({ error: 'Title is required' });
  const r = getDb().prepare(`
    INSERT INTO announcements (title, body, pinned, expires_at, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(t, body || '', pinned ? 1 : 0, expires_at || null, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can edit announcements' });
  const { title, body, pinned, expires_at } = req.body || {};
  getDb().prepare(`
    UPDATE announcements SET title=?, body=?, pinned=?, expires_at=? WHERE id=?
  `).run(String(title || '').trim(), body || '', pinned ? 1 : 0, expires_at || null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can delete announcements' });
  getDb().prepare('DELETE FROM announcements WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
