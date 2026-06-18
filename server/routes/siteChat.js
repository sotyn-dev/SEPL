// Site Chat — internal WhatsApp-style per-site threads (mam 2026-06-18).
// Team-only, ERP-stored. Per-site MEMBERS (only members + admin view/post),
// read receipts (✓✓ + who-read), and unread badges.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

getDb().exec(`
  CREATE TABLE IF NOT EXISTS site_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL, site_name TEXT, body TEXT,
    attachment_url TEXT, attachment_name TEXT,
    sender_id INTEGER, sender_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sitemsg_site ON site_messages(site_id, created_at);
  -- Per-site membership (like a WhatsApp group).
  CREATE TABLE IF NOT EXISTS site_chat_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    site_id INTEGER NOT NULL, user_id INTEGER NOT NULL, added_by INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(site_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_sitemem_site ON site_chat_members(site_id);
  -- Read receipts: each member's last-read message id per site.
  CREATE TABLE IF NOT EXISTS site_chat_reads (
    site_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    last_read_id INTEGER DEFAULT 0, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (site_id, user_id)
  );
`);

const isAdmin = (req) => req.user.role === 'admin';
const isMember = (db, s, u) => !!db.prepare('SELECT 1 FROM site_chat_members WHERE site_id=? AND user_id=?').get(s, u);
const canAccess = (db, req, s) => isAdmin(req) || isMember(db, s, req.user.id);
const markRead = (db, s, uid) => {
  const max = db.prepare('SELECT MAX(id) m FROM site_messages WHERE site_id=?').get(s).m || 0;
  db.prepare(`INSERT INTO site_chat_reads (site_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(site_id,user_id) DO UPDATE SET last_read_id=MAX(last_read_id, excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`).run(s, uid, max);
  return max;
};

// Chat list — sites the user is a member of (admin sees all), each with the
// last-message preview, member count and an unread count.
router.get('/sites', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const uid = req.user.id;
  const sites = isAdmin(req)
    ? db.prepare('SELECT id,name,client_name,status FROM sites ORDER BY name').all()
    : db.prepare('SELECT s.id,s.name,s.client_name,s.status FROM sites s JOIN site_chat_members m ON m.site_id=s.id WHERE m.user_id=? ORDER BY s.name').all(uid);
  const lastBy = Object.fromEntries(db.prepare(`SELECT site_id,body,attachment_name,sender_name,created_at FROM site_messages WHERE id IN (SELECT MAX(id) FROM site_messages GROUP BY site_id)`).all().map(l => [l.site_id, l]));
  const countBy = Object.fromEntries(db.prepare('SELECT site_id,COUNT(*) c FROM site_messages GROUP BY site_id').all().map(c => [c.site_id, c.c]));
  const memBy = Object.fromEntries(db.prepare('SELECT site_id,COUNT(*) c FROM site_chat_members GROUP BY site_id').all().map(c => [c.site_id, c.c]));
  const unreadBy = Object.fromEntries(db.prepare(`SELECT sm.site_id, COUNT(*) c FROM site_messages sm
      WHERE sm.sender_id <> ? AND sm.id > COALESCE((SELECT last_read_id FROM site_chat_reads r WHERE r.site_id=sm.site_id AND r.user_id=?), 0)
      GROUP BY sm.site_id`).all(uid, uid).map(c => [c.site_id, c.c]));
  const out = sites.map(s => ({ ...s, last: lastBy[s.id] || null, count: countBy[s.id] || 0, members: memBy[s.id] || 0, unread: unreadBy[s.id] || 0 }));
  out.sort((a, b) => {
    const ta = a.last?.created_at || '', tb = b.last?.created_at || '';
    if (ta && tb) return tb.localeCompare(ta);
    if (ta) return -1; if (tb) return 1;
    return String(a.name).localeCompare(String(b.name));
  });
  res.json(out);
});

// One site's thread: messages + members + each member's last-read id (for
// the ✓✓ "who read" rendering). Also marks the caller read up to the latest.
router.get('/:siteId', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'You are not a member of this site chat' });
  const messages = db.prepare('SELECT * FROM site_messages WHERE site_id=? ORDER BY created_at, id').all(s);
  const members = db.prepare('SELECT m.user_id, u.name FROM site_chat_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.site_id=? ORDER BY u.name').all(s);
  const reads = Object.fromEntries(db.prepare('SELECT user_id,last_read_id FROM site_chat_reads WHERE site_id=?').all(s).map(r => [r.user_id, r.last_read_id]));
  markRead(db, s, req.user.id);
  res.json({ messages, members, reads });
});

// POST a message (text and/or attachment).
router.post('/:siteId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'You are not a member of this site chat' });
  const { body, attachment_url, attachment_name } = req.body;
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a message or attach a file' });
  const site = db.prepare('SELECT id, name FROM sites WHERE id=?').get(s);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const info = db.prepare(`INSERT INTO site_messages (site_id, site_name, body, attachment_url, attachment_name, sender_id, sender_name)
                           VALUES (?,?,?,?,?,?,?)`)
    .run(site.id, site.name, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '');
  markRead(db, s, req.user.id);                                   // sender has read their own message
  res.json(db.prepare('SELECT * FROM site_messages WHERE id=?').get(info.lastInsertRowid));
});

// Mark the caller read up to the latest message (called when the thread is open).
router.post('/:siteId/read', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'Not a member' });
  res.json({ last_read_id: markRead(db, s, req.user.id) });
});

// ── Members (WhatsApp-group style) ─────────────────────────────────────
router.get('/:siteId/members', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare('SELECT m.user_id, u.name, u.username FROM site_chat_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.site_id=? ORDER BY u.name').all(s));
});
router.post('/:siteId/members', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'Only a member or admin can add members' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ins = db.prepare('INSERT OR IGNORE INTO site_chat_members (site_id, user_id, added_by) VALUES (?,?,?)');
  let added = 0;
  db.transaction(() => { for (const uid of ids) { const r = ins.run(s, +uid, req.user.id); added += r.changes; } })();
  res.json({ added });
});
router.delete('/:siteId/members/:userId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const s = +req.params.siteId;
  if (!canAccess(db, req, s)) return res.status(403).json({ error: 'Only a member or admin can remove members' });
  db.prepare('DELETE FROM site_chat_members WHERE site_id=? AND user_id=?').run(s, +req.params.userId);
  res.json({ ok: true });
});

// DELETE a message — sender or admin only.
router.delete('/:id', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM site_messages WHERE id=?').get(req.params.id);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && req.user.role !== 'admin') return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM site_messages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
