// "WhatsApp" — internal group chat (mam 2026-06-18: custom groups only, looks
// like WhatsApp). Users create named groups, add the people they want, and chat
// (text + photo/file). Members-gated, read receipts, unread badges. Team-only,
// ERP-stored. Module key stays `site_chat`; API base /api/site-chat.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

getDb().exec(`
  CREATE TABLE IF NOT EXISTS chat_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
    created_by INTEGER, created_by_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS chat_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, user_id INTEGER NOT NULL,
    added_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, UNIQUE(group_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_cgm_group ON chat_group_members(group_id);
  CREATE INDEX IF NOT EXISTS idx_cgm_user ON chat_group_members(user_id);
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT, group_id INTEGER NOT NULL, body TEXT,
    attachment_url TEXT, attachment_name TEXT, sender_id INTEGER, sender_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_cmsg_group ON chat_messages(group_id, created_at);
  CREATE TABLE IF NOT EXISTS chat_reads (
    group_id INTEGER NOT NULL, user_id INTEGER NOT NULL, last_read_id INTEGER DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (group_id, user_id)
  );
`);

const isAdmin = (req) => req.user.role === 'admin';
const isMember = (db, g, u) => !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, u);
const canAccess = (db, req, g) => isAdmin(req) || isMember(db, g, req.user.id);
const markRead = (db, g, uid) => {
  const max = db.prepare('SELECT MAX(id) m FROM chat_messages WHERE group_id=?').get(g).m || 0;
  db.prepare(`INSERT INTO chat_reads (group_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`).run(g, uid, max);
  return max;
};

// The user's groups (admin sees all) + last-message preview, member count, unread.
router.get('/groups', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const uid = req.user.id;
  const groups = isAdmin(req)
    ? db.prepare('SELECT id, name FROM chat_groups ORDER BY name').all()
    : db.prepare('SELECT g.id, g.name FROM chat_groups g JOIN chat_group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.name').all(uid);
  const lastBy = Object.fromEntries(db.prepare(`SELECT group_id,body,attachment_name,sender_name,created_at FROM chat_messages WHERE id IN (SELECT MAX(id) FROM chat_messages GROUP BY group_id)`).all().map(l => [l.group_id, l]));
  const memBy = Object.fromEntries(db.prepare('SELECT group_id,COUNT(*) c FROM chat_group_members GROUP BY group_id').all().map(c => [c.group_id, c.c]));
  const unreadBy = Object.fromEntries(db.prepare(`SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
      WHERE cm.sender_id<>? AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
      GROUP BY cm.group_id`).all(uid, uid).map(c => [c.group_id, c.c]));
  const out = groups.map(g => ({ ...g, last: lastBy[g.id] || null, members: memBy[g.id] || 0, unread: unreadBy[g.id] || 0 }));
  out.sort((a, b) => { const ta = a.last?.created_at || '', tb = b.last?.created_at || ''; if (ta && tb) return tb.localeCompare(ta); if (ta) return -1; if (tb) return 1; return String(a.name).localeCompare(String(b.name)); });
  res.json(out);
});

// Create a group (name + members). Creator is auto-added.
router.post('/groups', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
  const gid = db.prepare('INSERT INTO chat_groups (name, created_by, created_by_name) VALUES (?,?,?)').run(name, req.user.id, req.user.name || '').lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, added_by) VALUES (?,?,?)');
  db.transaction(() => { ins.run(gid, req.user.id, req.user.id); for (const u of ids) ins.run(gid, u, req.user.id); })();
  res.json(db.prepare('SELECT id, name FROM chat_groups WHERE id=?').get(gid));
});

// Rename a group (member/admin).
router.put('/:groupId', requirePermission('site_chat', 'edit'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name, g);
  res.json({ ok: true });
});

// Delete a group (creator or admin).
router.delete('/:groupId', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the creator or an admin can delete the group' });
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_group_members WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_reads WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_groups WHERE id=?').run(g);
  })();
  res.json({ ok: true });
});

// Thread: messages + members + each member's last-read id (for ✓✓ "who read").
router.get('/:groupId', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const group = db.prepare('SELECT id, name FROM chat_groups WHERE id=?').get(g);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const messages = db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY created_at, id').all(g);
  const members = db.prepare('SELECT m.user_id, u.name FROM chat_group_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name').all(g);
  const reads = Object.fromEntries(db.prepare('SELECT user_id,last_read_id FROM chat_reads WHERE group_id=?').all(g).map(r => [r.user_id, r.last_read_id]));
  markRead(db, g, req.user.id);
  res.json({ group, messages, members, reads });
});

// Post a message.
router.post('/:groupId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const { body, attachment_url, attachment_name } = req.body;
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a message or attach a file' });
  const info = db.prepare(`INSERT INTO chat_messages (group_id, body, attachment_url, attachment_name, sender_id, sender_name) VALUES (?,?,?,?,?,?)`)
    .run(g, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '');
  markRead(db, g, req.user.id);
  res.json(db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid));
});

router.post('/:groupId/read', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  res.json({ last_read_id: markRead(db, g, req.user.id) });
});

// ── Members ────────────────────────────────────────────────────────────
router.get('/:groupId/members', requirePermission('site_chat', 'view'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare('SELECT m.user_id, u.name, u.username FROM chat_group_members m LEFT JOIN users u ON u.id=m.user_id WHERE m.group_id=? ORDER BY u.name').all(g));
});
router.post('/:groupId/members', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can add members' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, added_by) VALUES (?,?,?)');
  let added = 0; db.transaction(() => { for (const u of ids) added += ins.run(g, +u, req.user.id).changes; })();
  res.json({ added });
});
router.delete('/:groupId/members/:userId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can remove members' });
  db.prepare('DELETE FROM chat_group_members WHERE group_id=? AND user_id=?').run(g, +req.params.userId);
  res.json({ ok: true });
});

// Delete a message (sender or admin).
router.delete('/:groupId/messages/:msgId', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getDb();
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM chat_messages WHERE id=?').run(req.params.msgId);
  res.json({ ok: true });
});

module.exports = router;
