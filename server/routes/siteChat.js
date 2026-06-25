// "WhatsApp" — internal group chat. Uses its OWN database (chat.db, separate
// from erp.db) and pushes live updates over Socket.IO (mam 2026-06-18). Users
// create named groups, add members, chat (text + photo/file). Members-gated,
// read receipts, unread badges. Module key `site_chat`, base /api/site-chat.
const express = require('express');
const { getDb } = require('../db/schema');          // erp.db — only for the user list / names
const { getChatDb } = require('../db/chatDb');       // separate chat database
const { emitChat } = require('../lib/chatSocket');   // real-time push
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const isAdmin = (req) => req.user.role === 'admin';
const isMember = (db, g, u) => !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, u);
// Access = membership; Admin additionally oversees GROUPS but NOT private DMs.
// A 1-on-1 direct message is readable ONLY by its two participants — no admin /
// COO override (mam 2026-06-19: "why coo can check sushila lovely chat").
const canAccess = (db, req, g) => {
  if (isMember(db, g, req.user.id)) return true;
  if (!isAdmin(req)) return false;
  const row = db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g);
  return !!row && !row.is_dm;          // admin sees groups, never private DMs
};
const userName = (uid) => { try { return getDb().prepare('SELECT name FROM users WHERE id=?').get(uid)?.name || ''; } catch { return ''; } };
const markRead = (db, g, uid) => {
  const max = db.prepare('SELECT MAX(id) m FROM chat_messages WHERE group_id=?').get(g).m || 0;
  db.prepare(`INSERT INTO chat_reads (group_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`).run(g, uid, max);
  return max;
};

// Membership-driven (mam 2026-06-19: "user add monika she is not able to
// reply"). WhatsApp is open to every signed-in user — you simply see the
// groups you've been added to (admin sees all). NO site_chat module
// permission is needed to view or chat; being a group member IS the access
// control. Only group creation + member management stay privileged below.
// ICE servers for WebRTC calls (mam 2026-06-19). Public STUN works for most
// same-network / simple cases; a TURN server (set turn_url/turn_username/
// turn_password in app_settings, e.g. self-hosted coturn) is needed for calls
// across different networks/NATs.
router.get('/ice', (req, res) => {
  const ice = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
  ];
  try {
    const db = getDb();
    const get = (k) => db.prepare('SELECT value FROM app_settings WHERE key=?').get(k)?.value;
    const url = get('turn_url'), u = get('turn_username'), p = get('turn_password');
    if (url) ice.push({ urls: url, username: u || '', credential: p || '' });
  } catch (_) { /* app_settings may not exist yet */ }
  res.json({ iceServers: ice });
});

router.get('/groups', (req, res) => {
  const db = getChatDb(); const uid = req.user.id;
  const groups = isAdmin(req)
    // Admin sees every GROUP, but only the DMs they're personally in — private
    // 1-on-1 chats never appear in the admin list (mam 2026-06-19).
    ? db.prepare('SELECT id, name, is_dm FROM chat_groups WHERE is_dm=0 OR id IN (SELECT group_id FROM chat_group_members WHERE user_id=?) ORDER BY name').all(uid)
    : db.prepare('SELECT g.id, g.name, g.is_dm FROM chat_groups g JOIN chat_group_members m ON m.group_id=g.id WHERE m.user_id=? ORDER BY g.name').all(uid);
  // For DMs, the title shown is the OTHER participant's name (per viewer).
  const dmIds = groups.filter(g => g.is_dm).map(g => g.id);
  const dmTitle = {}, dmUid = {};
  if (dmIds.length) {
    const ph = dmIds.map(() => '?').join(',');
    const byG = {};
    for (const r of db.prepare(`SELECT group_id, user_id, user_name FROM chat_group_members WHERE group_id IN (${ph})`).all(...dmIds)) (byG[r.group_id] ||= []).push(r);
    for (const id of dmIds) {
      const mem = byG[id] || [];
      const others = mem.filter(m => m.user_id !== uid);
      dmTitle[id] = (others.length ? others : mem).map(o => o.user_name).filter(Boolean).join(', ') || 'Direct message';
      dmUid[id] = (others[0] || mem[0])?.user_id || null;     // other person's id → their avatar
    }
  }
  const lastBy = Object.fromEntries(db.prepare(`SELECT group_id,body,attachment_name,sender_name,created_at FROM chat_messages WHERE id IN (SELECT MAX(id) FROM chat_messages GROUP BY group_id)`).all().map(l => [l.group_id, l]));
  const memBy = Object.fromEntries(db.prepare('SELECT group_id,COUNT(*) c FROM chat_group_members GROUP BY group_id').all().map(c => [c.group_id, c.c]));
  const unreadBy = Object.fromEntries(db.prepare(`SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
      WHERE cm.sender_id<>? AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
      GROUP BY cm.group_id`).all(uid, uid).map(c => [c.group_id, c.c]));
  const out = groups.map(g => ({ ...g, name: g.is_dm ? (dmTitle[g.id] || g.name) : g.name, dm_uid: g.is_dm ? (dmUid[g.id] || null) : null, last: lastBy[g.id] || null, members: memBy[g.id] || 0, unread: unreadBy[g.id] || 0 }));
  out.sort((a, b) => { const ta = a.last?.created_at || '', tb = b.last?.created_at || ''; if (ta && tb) return tb.localeCompare(ta); if (ta) return -1; if (tb) return 1; return String(a.name).localeCompare(String(b.name)); });
  res.json(out);
});

router.post('/groups', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb();
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Group name is required' });
  const ids = Array.isArray(req.body?.member_ids) ? req.body.member_ids.map(Number).filter(Boolean) : [];
  const gid = db.prepare('INSERT INTO chat_groups (name, created_by, created_by_name) VALUES (?,?,?)').run(name, req.user.id, req.user.name || '').lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  db.transaction(() => { ins.run(gid, req.user.id, req.user.name || '', req.user.id); for (const u of ids) ins.run(gid, u, userName(u), req.user.id); })();
  emitChat(gid, 'changed', { groupId: gid });
  res.json(db.prepare('SELECT id, name FROM chat_groups WHERE id=?').get(gid));
});

// Direct message — open (or create) a 1-on-1 chat with another user. Open to
// EVERY signed-in user (no create permission needed): personal connect like
// WhatsApp (mam 2026-06-19 "if monika wants send to sushila she can direct").
router.post('/dm', (req, res) => {
  const db = getChatDb();
  const me = req.user.id, other = +req.body?.user_id;
  if (!other || other === me) return res.status(400).json({ error: 'Pick a different person to message' });
  // Reuse an existing DM between exactly these two people, if any.
  const existing = db.prepare(`
    SELECT g.id FROM chat_groups g
    WHERE g.is_dm=1
      AND (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id)=2
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
    LIMIT 1`).get(me, other);
  if (existing) return res.json({ id: existing.id, name: userName(other) });
  const otherName = userName(other), myName = req.user.name || '';
  const gid = db.prepare('INSERT INTO chat_groups (name, is_dm, created_by, created_by_name) VALUES (?,1,?,?)').run(otherName || 'Direct message', me, myName).lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  db.transaction(() => { ins.run(gid, me, myName, me); ins.run(gid, other, otherName, me); })();
  emitChat(gid, 'changed', { groupId: gid });
  res.json({ id: gid, name: otherName });
});

// Rename a group — same privilege as managing members (create). DMs can't be
// renamed (their title is always the other person's name).
router.put('/:groupId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  if (db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g)?.is_dm) return res.status(400).json({ error: 'A direct message cannot be renamed' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name, g);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

router.delete('/:groupId', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the creator or an admin can delete the group' });
  db.transaction(() => {
    db.prepare('DELETE FROM chat_messages WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_group_members WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_reads WHERE group_id=?').run(g);
    db.prepare('DELETE FROM chat_groups WHERE id=?').run(g);
  })();
  emitChat(g, 'group_deleted', { groupId: g });
  res.json({ ok: true });
});

router.get('/:groupId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const group = db.prepare('SELECT id, name, is_dm FROM chat_groups WHERE id=?').get(g);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  const messages = db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY created_at, id').all(g);
  const members = db.prepare('SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name').all(g);
  // DM header = the OTHER participant's name (per viewer), not the stored name.
  if (group.is_dm) group.name = members.filter(m => m.user_id !== req.user.id).map(m => m.name).filter(Boolean).join(', ') || group.name;
  const readRows = db.prepare('SELECT user_id,last_read_id,updated_at FROM chat_reads WHERE group_id=?').all(g);
  const reads = Object.fromEntries(readRows.map(r => [r.user_id, r.last_read_id]));
  const readsAt = Object.fromEntries(readRows.map(r => [r.user_id, r.updated_at]));  // for Message Info read-time
  markRead(db, g, req.user.id);
  // NOTE: deliberately do NOT emitChat('changed') here. Loading a thread used
  // to broadcast 'changed' to the room, but the client reloads the thread on
  // 'changed' → which re-GETs → which re-emits: an infinite self-reinforcing
  // loop that hammered the server and caused intermittent chat errors
  // (mam 2026-06-19). New messages still emit from POST; read receipts refresh
  // via the other members' poll / next message.
  res.json({ group, messages, members, reads, readsAt });
});

// Any MEMBER can post — gated by group membership ONLY, not any site_chat
// module permission, so anyone added to a group can reply by default
// (mam 2026-06-19: "user add monika she is not able to reply").
router.post('/:groupId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const { body, attachment_url, attachment_name, reply_to_id } = req.body;
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Type a message or attach a file' });
  // Quoted reply — only accept an id that belongs to THIS group (mam 2026-06-25).
  let replyId = null;
  if (reply_to_id) {
    const ref = db.prepare('SELECT id FROM chat_messages WHERE id=? AND group_id=?').get(+reply_to_id, g);
    if (ref) replyId = ref.id;
  }
  const info = db.prepare(`INSERT INTO chat_messages (group_id, body, attachment_url, attachment_name, sender_id, sender_name, reply_to_id) VALUES (?,?,?,?,?,?,?)`)
    .run(g, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, req.user.id, req.user.name || '', replyId);
  markRead(db, g, req.user.id);
  emitChat(g, 'changed', { groupId: g });
  res.json(db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid));
});

router.post('/:groupId/read', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  const last = markRead(db, g, req.user.id);
  emitChat(g, 'changed', { groupId: g });
  res.json({ last_read_id: last });
});

router.get('/:groupId/members', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  res.json(db.prepare('SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name').all(g));
});
router.post('/:groupId/members', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can add members' });
  const ids = Array.isArray(req.body?.user_ids) ? req.body.user_ids : [];
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  let added = 0; db.transaction(() => { for (const u of ids) added += ins.run(g, +u, userName(+u), req.user.id).changes; })();
  emitChat(g, 'changed', { groupId: g });
  res.json({ added });
});
router.delete('/:groupId/members/:userId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can remove members' });
  db.prepare('DELETE FROM chat_group_members WHERE group_id=? AND user_id=?').run(g, +req.params.userId);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

router.delete('/:groupId/messages/:msgId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.sender_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'You can only delete your own messages' });
  db.prepare('DELETE FROM chat_messages WHERE id=?').run(req.params.msgId);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

module.exports = router;
