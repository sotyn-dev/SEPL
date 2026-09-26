// "WhatsApp" — internal group chat. Uses its OWN database (chat.db, separate
// from erp.db) and pushes live updates over Socket.IO (mam 2026-06-18). Users
// create named groups, add members, chat (text + photo/file). Members-gated,
// read receipts, unread badges. Module key `site_chat`, base /api/site-chat.
const express = require('express');
const { getDb } = require('../db/schema');          // erp.db — only for the user list / names
const { getChatDb } = require('../db/chatDb');       // separate chat database
const { emitChat } = require('../lib/chatSocket');   // real-time push
const { rateLimit } = require('../lib/rateLimit');   // in-memory send backpressure
const { authMiddleware, requirePermission } = require('../middleware/auth');
const quarantine = require('../lib/quarantine');     // reversible cleanup of deleted attachments
const router = express.Router();
router.use(authMiddleware);

// A sent message stays editable for 15 minutes, matching WhatsApp (mam 2026-07-15).
const EDIT_WINDOW_MS = 15 * 60 * 1000;

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
const markRead = (db, g, uid, knownMax) => {
  // On the send path the caller already holds the just-inserted id (info.lastInsertRowid),
  // which is this group's newest id — so skip the redundant MAX(id) scan. Every other
  // caller passes nothing and still resolves it here, so behaviour is unchanged.
  const max = knownMax != null ? knownMax
    : (db.prepare('SELECT MAX(id) m FROM chat_messages WHERE group_id=?').get(g).m || 0);
  db.prepare(`INSERT INTO chat_reads (group_id,user_id,last_read_id,updated_at) VALUES (?,?,?,CURRENT_TIMESTAMP)
              ON CONFLICT(group_id,user_id) DO UPDATE SET last_read_id=MAX(last_read_id,excluded.last_read_id), updated_at=CURRENT_TIMESTAMP`).run(g, uid, max);
  return max;
};

// Permanent server-side trail for every destructive/membership chat action —
// shows in `pm2 logs erp | grep chat-audit` even if the UI trail is missed.
// Records the account AND the IP, so a teammate's script using a borrowed
// token is identifiable by source address (mam 2026-08-13).
const chatAudit = (req, action, groupId, extra) => {
  try {
    const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || '?';
    console.log(`[chat-audit] ${new Date().toISOString()} user=${req.user.id}(${req.user.name || '?'}) ip=${ip} action=${action} group=${groupId}${extra ? ` :: ${extra}` : ''}`);
  } catch (e) { /* never let logging break the action */ }
};

// In-chat audit line for membership changes (mam 2026-08-13: people were being
// silently removed from groups and re-added later with no trace). Every
// add/remove now announces itself INSIDE the group, WhatsApp-style, naming the
// actor. sender_id records WHO acted (or whose token a script used), so the
// trail survives even if display names change later.
const postSystem = (db, g, actor, text) => {
  const info = db.prepare('INSERT INTO chat_messages (group_id, body, sender_id, sender_name, is_system) VALUES (?,?,?,?,1)')
    .run(g, text, actor.id, actor.name || '');
  markRead(db, g, actor.id, info.lastInsertRowid);   // the actor has "seen" their own line
  emitChat(g, 'message', db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid));
};

// Same "which groups can this user reach" rule as canAccess(), expressed as a
// reusable SQL fragment (exactly one `?` for uid) instead of a materialized id
// list — lets /groups and /unread-count push the admin-vs-member predicate
// straight into the DB instead of enumerating ids into JS first (/site-chat
// perf pass — admin-slowness fix).
const accessWhereFor = (admin) => admin
  ? 'g.is_dm=0 OR g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)'
  : 'g.id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)';

// Soft-archive predicate. ALWAYS combined with accessWhereFor() wrapped in its own
// parentheses — the admin variant is a bare `A OR B`, so an unparenthesised
// `... OR B AND archived_at IS NULL` would bind the AND to B alone and leak
// archived groups back into an admin's list.
const archiveWhere = (archived) => (archived ? 'g.archived_at IS NOT NULL' : 'g.archived_at IS NULL');

// Shared enrichment: DM display name/avatar + last-message/member-count/unread
// per group, scoped to EXACTLY the ids passed in (a full list for the legacy
// unpaginated path, a ~30-row page for the paginated list, or a handful of
// unread groups for the badge) — never re-derives "which groups" itself.
function enrichGroups(db, uid, groups, { withMembers = true } = {}) {
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
      dmUid[id] = (others[0] || mem[0])?.user_id || null;
    }
  }
  const gids = groups.map(g => g.id);
  let lastBy = {}, memBy = {}, unreadBy = {};
  if (gids.length) {
    const ph = gids.map(() => '?').join(',');
    lastBy = Object.fromEntries(db.prepare(`SELECT group_id, CASE WHEN deleted_at IS NULL THEN body ELSE '🚫 Message deleted' END AS body, CASE WHEN deleted_at IS NULL THEN attachment_name ELSE NULL END AS attachment_name, sender_name, created_at FROM chat_messages WHERE id IN (SELECT MAX(id) FROM chat_messages WHERE group_id IN (${ph}) GROUP BY group_id)`).all(...gids).map(l => [l.group_id, l]));
    if (withMembers) {
      memBy = Object.fromEntries(db.prepare(`SELECT group_id,COUNT(*) c FROM chat_group_members WHERE group_id IN (${ph}) GROUP BY group_id`).all(...gids).map(c => [c.group_id, c.c]));
    }
    unreadBy = Object.fromEntries(db.prepare(`SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
        WHERE cm.group_id IN (${ph}) AND cm.sender_id<>? AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
        GROUP BY cm.group_id`).all(...gids, uid, uid).map(c => [c.group_id, c.c]));
  }
  return groups.map(g => ({ ...g, name: g.is_dm ? (dmTitle[g.id] || g.name) : g.name, dm_uid: g.is_dm ? (dmUid[g.id] || null) : null, last: lastBy[g.id] || null, members: memBy[g.id] || 0, unread: unreadBy[g.id] || 0 }));
}
const sortGroups = (groups) => groups.sort((a, b) => { const ta = a.last?.created_at || '', tb = b.last?.created_at || ''; if (ta && tb) return tb.localeCompare(ta); if (ta) return -1; if (tb) return 1; return String(a.name).localeCompare(String(b.name)); });

// Default group-list page size + the max a single request may pull. The cap is
// the ceiling for a RESET refetch too: a scrolled-deep admin's poll/socket
// reconcile re-requests Math.max(GROUP_PAGE, rendered count) so their view isn't
// truncated — but only up to GROUP_MAX, past which the cursor re-extends. Mirror
// the message thread's MAX_LIVE=100 ceiling so a busy admin's every-`changed`
// reconcile stays bounded rather than re-aggregating the whole scrolled window.
const GROUP_PAGE = 30;
const GROUP_MAX = 100;

// Keyset page of accessible groups ordered by most-recent-activity-first, then
// messageless groups by name (mirrors sortGroups' tie-break). Two phases so we
// never need a persisted "last activity" column: phase 1 walks groups WITH a
// message via idx_cmsg_group_id (an index descent per candidate group, not a
// table scan); phase 2 (once phase 1 is exhausted) walks message-less groups
// by name. `cursor` is whatever `nextCursor` the previous page returned.
// Phase 1's key (last_id = MAX message id) is globally unique so a bare
// `last_id < ?` is safe. Phase 2's key (name) is NOT unique — group names can
// collide — so it uses a COMPOUND (name, id) keyset; a bare `name > ?` would
// skip the rest of a run of identically-named groups straddling a page edge.
function pageOfGroups(db, { uid, admin, limit, q, cursor, archived }) {
  const accessWhere = accessWhereFor(admin);
  const qWhere = q ? ' AND (g.name LIKE ? OR EXISTS (SELECT 1 FROM chat_group_members m2 WHERE m2.group_id=g.id AND m2.user_id<>? AND m2.user_name LIKE ?))' : '';
  const qParams = q ? [`%${q}%`, uid, `%${q}%`] : [];
  const candidateSql = `SELECT g.id, g.name, g.is_dm, g.archived_at, (SELECT MAX(id) FROM chat_messages m WHERE m.group_id=g.id) AS last_id FROM chat_groups g WHERE (${accessWhere}) AND ${archiveWhere(archived)}${qWhere}`;
  const phase = cursor?.phase === 2 ? 2 : 1;

  if (phase === 1) {
    const cursorWhere = cursor?.after_last_id != null ? ' AND last_id < ?' : '';
    const cursorParams = cursor?.after_last_id != null ? [cursor.after_last_id] : [];
    let rows = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NOT NULL${cursorWhere} ORDER BY last_id DESC LIMIT ?`)
      .all(uid, ...qParams, ...cursorParams, limit + 1);
    if (rows.length > limit) {
      rows = rows.slice(0, limit);
      return { rows, hasMore: true, nextCursor: { phase: 1, after_last_id: rows[rows.length - 1].last_id } };
    }
    // Phase 1 exhausted this call — fall through into phase 2 from the start.
    const remaining = limit - rows.length;
    const rows2 = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL ORDER BY name ASC, id ASC LIMIT ?`).all(uid, ...qParams, remaining + 1);
    const hasMore = rows2.length > remaining;
    const appended = rows2.slice(0, remaining);
    rows = rows.concat(appended);
    const tail = appended.length ? appended[appended.length - 1] : null;
    return { rows, hasMore, nextCursor: hasMore ? { phase: 2, after_name: tail ? tail.name : null, after_id: tail ? tail.id : null } : null };
  }
  // Compound (name, id) keyset — a bare `name > ?` would drop same-named groups.
  const keyWhere = cursor?.after_name != null ? ' AND (name > ? OR (name = ? AND id > ?))' : '';
  const keyParams = cursor?.after_name != null ? [cursor.after_name, cursor.after_name, cursor.after_id ?? 0] : [];
  const rows2 = db.prepare(`SELECT * FROM (${candidateSql}) c WHERE last_id IS NULL${keyWhere} ORDER BY name ASC, id ASC LIMIT ?`).all(uid, ...qParams, ...keyParams, limit + 1);
  const hasMore = rows2.length > limit;
  const rows = rows2.slice(0, limit);
  const tail = rows[rows.length - 1];
  return { rows, hasMore, nextCursor: hasMore ? { phase: 2, after_name: tail.name, after_id: tail.id } : null };
}

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
  // ?mine=1 → admin sees only the groups they're actually a member of (the
  // sidebar "Only chats I'm in" toggle). Treating the admin as a non-admin here
  // reuses the exact member-only predicate; pagination/search/counts all follow.
  const db = getChatDb(); const uid = req.user.id; const admin = isAdmin(req) && req.query.mine !== '1';
  // ?archived=1 → the Archived view (same access rules; an admin still never
  // sees someone else's DM, because accessWhereFor already excludes them).
  const archived = req.query.archived === '1';
  // No ?limit → legacy full-list behaviour, unchanged (kept for any other
  // caller that still wants everything at once). Admin here IS every non-DM
  // group + own DMs, same rule as before this perf pass; only the paginated
  // branch below avoids materialising + enriching all of them on every load.
  if (req.query.limit == null) {
    const groups = db.prepare(`SELECT g.id, g.name, g.is_dm, g.archived_at FROM chat_groups g WHERE (${accessWhereFor(admin)}) AND ${archiveWhere(archived)} ORDER BY g.name`).all(uid);
    return res.json(sortGroups(enrichGroups(db, uid, groups)));
  }
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || GROUP_PAGE, 1), GROUP_MAX);
  const q = String(req.query.q || '').trim();
  const cursor = req.query.phase
    ? { phase: parseInt(req.query.phase, 10), after_last_id: req.query.after_last_id != null ? parseInt(req.query.after_last_id, 10) : null, after_name: req.query.after_name != null ? String(req.query.after_name) : null, after_id: req.query.after_id != null ? parseInt(req.query.after_id, 10) : null }
    : null;
  const { rows, hasMore, nextCursor } = pageOfGroups(db, { uid, admin, limit, q, cursor, archived });
  const groups = sortGroups(enrichGroups(db, uid, rows)).map(({ last_id, ...g }) => g);
  res.json({ groups, hasMore, nextCursor });
});

// Lightweight badge/toast feed for the always-on sidebar poll (Layout.jsx,
// every 25s from every page) — deliberately NOT the same query as /groups.
// `total` is a single uncapped aggregate; `groups` is only the (usually small)
// subset that actually has unread messages, capped, so an admin overseeing a
// large number of groups doesn't pay for every group just to show one number
// (/site-chat perf pass — admin-slowness fix, "chat count concern").
const UNREAD_GROUPS_CAP = 30;
router.get('/unread-count', (req, res) => {
  const db = getChatDb(); const uid = req.user.id; const admin = isAdmin(req);
  // Archived groups raise no badge and no toast — that is the point of archiving.
  // Parenthesised: see archiveWhere()'s note on the bare OR in the admin variant.
  const accessIdsSql = `SELECT g.id FROM chat_groups g WHERE (${accessWhereFor(admin)}) AND ${archiveWhere(false)}`;
  const unreadCountSql = `SELECT cm.group_id, COUNT(*) c FROM chat_messages cm
      WHERE cm.group_id IN (${accessIdsSql}) AND cm.sender_id<>?
        AND cm.id > COALESCE((SELECT last_read_id FROM chat_reads r WHERE r.group_id=cm.group_id AND r.user_id=?),0)
      GROUP BY cm.group_id`;
  const total = db.prepare(`SELECT COALESCE(SUM(c),0) AS total FROM (${unreadCountSql})`).get(uid, uid, uid).total;
  if (!total) return res.json({ total: 0, groups: [] });
  const unreadRows = db.prepare(`${unreadCountSql} ORDER BY MAX(cm.id) DESC LIMIT ?`).all(uid, uid, uid, UNREAD_GROUPS_CAP);
  const ids = unreadRows.map(r => r.group_id);
  const ph = ids.map(() => '?').join(',');
  const meta = db.prepare(`SELECT id, name, is_dm FROM chat_groups WHERE id IN (${ph})`).all(...ids);
  const enriched = enrichGroups(db, uid, meta, { withMembers: false });
  const byId = Object.fromEntries(enriched.map(g => [g.id, g]));
  const groups = ids.map(id => byId[id]).filter(Boolean);   // preserve unreadRows' recency order
  res.json({ total, groups });
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
// Find the 1-on-1 DM between two people, creating it if it doesn't exist yet.
// Shared by POST /dm and POST /forward so "message someone new" and "forward to
// someone new" can never drift into two different behaviours.
function ensureDm(db, me, myName, other) {
  if (!other || other === me) throw new Error('Pick a different person to message');
  const existing = db.prepare(`
    SELECT g.id FROM chat_groups g
    WHERE g.is_dm=1
      AND (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id)=2
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
      AND EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)
    LIMIT 1`).get(me, other);
  if (existing) return existing.id;
  const otherName = userName(other);
  const gid = db.prepare('INSERT INTO chat_groups (name, is_dm, created_by, created_by_name) VALUES (?,1,?,?)')
    .run(otherName || 'Direct message', me, myName).lastInsertRowid;
  const ins = db.prepare('INSERT OR IGNORE INTO chat_group_members (group_id, user_id, user_name, added_by) VALUES (?,?,?,?)');
  db.transaction(() => { ins.run(gid, me, myName, me); ins.run(gid, other, otherName, me); })();
  emitChat(gid, 'changed', { groupId: gid });
  return gid;
}

router.post('/dm', (req, res) => {
  const db = getChatDb();
  const me = req.user.id, other = +req.body?.user_id;
  if (!other || other === me) return res.status(400).json({ error: 'Pick a different person to message' });
  const gid = ensureDm(db, me, req.user.name || '', other);
  res.json({ id: gid, name: userName(other) });
});

// ─── FORWARD DIALOG ──────────────────────────────────────────────────────
// Everything the forward picker needs in ONE request: every group you're in,
// PLUS every active colleague — including people you have never messaged, so
// you never have to open a chat before you can forward to someone.
//
// Rows are merged on identity: a person you already DM comes back once, as a
// 'group' row (the existing DM) rather than twice.
router.get('/forward-targets', (req, res) => {
  const db = getChatDb(), erp = getDb(), me = req.user.id;

  const groups = db.prepare(`
    SELECT g.id, g.name, g.is_dm,
           (SELECT MAX(created_at) FROM chat_messages m WHERE m.group_id=g.id) AS last_at,
           (SELECT COUNT(*) FROM chat_group_members m WHERE m.group_id=g.id)   AS members
      FROM chat_groups g
     WHERE EXISTS (SELECT 1 FROM chat_group_members m WHERE m.group_id=g.id AND m.user_id=?)`).all(me);

  // The other participant of each DM, so a DM row can be de-duped against the
  // person row and can show their department/phone.
  const dmIds = groups.filter(g => g.is_dm).map(g => g.id);
  const dmPeer = {};
  if (dmIds.length) {
    const ph = dmIds.map(() => '?').join(',');
    for (const r of db.prepare(`SELECT group_id, user_id FROM chat_group_members WHERE group_id IN (${ph}) AND user_id<>?`).all(...dmIds, me)) {
      dmPeer[r.group_id] = r.user_id;
    }
  }

  const people = erp.prepare(
    `SELECT id, name, username, department, role, phone, email, avatar_url
       FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 AND id<>?`).all(me);
  const byId = new Map(people.map(u => [u.id, u]));

  const favRows = db.prepare('SELECT target_type, target_id FROM chat_forward_favorites WHERE user_id=?').all(me);
  const favs = new Set(favRows.map(f => `${f.target_type}:${f.target_id}`));
  const statRows = db.prepare('SELECT target_type, target_id, forward_count, last_forwarded_at FROM chat_forward_stats WHERE user_id=?').all(me);
  const stats = new Map(statRows.map(s => [`${s.target_type}:${s.target_id}`, s]));
  const decorate = (type, id, row) => {
    const k = `${type}:${id}`;
    const s = stats.get(k);
    return { ...row, favorite: favs.has(k), forwardCount: s?.forward_count || 0, lastForwardedAt: s?.last_forwarded_at || null };
  };

  const out = [];
  const coveredUsers = new Set();
  for (const g of groups) {
    const peer = g.is_dm ? byId.get(dmPeer[g.id]) : null;
    if (g.is_dm && !peer) continue;                     // peer deactivated — hide the DM
    if (peer) coveredUsers.add(peer.id);
    out.push(decorate('group', g.id, {
      targetType: 'group', targetId: g.id, groupId: g.id, isDm: !!g.is_dm,
      name: peer ? peer.name : g.name,
      subtitle: peer ? [peer.department, peer.role].filter(Boolean).join(' · ') : `${g.members} members`,
      phone: peer?.phone || null, email: peer?.email || null,
      avatarUserId: peer?.id || null, lastAt: g.last_at || null,
    }));
  }
  // Colleagues with no DM yet — the whole point of the redesign.
  for (const u of people) {
    if (coveredUsers.has(u.id)) continue;
    out.push(decorate('user', u.id, {
      targetType: 'user', targetId: u.id, groupId: null, isDm: true,
      name: u.name, subtitle: [u.department, u.role].filter(Boolean).join(' · '),
      phone: u.phone || null, email: u.email || null,
      avatarUserId: u.id, lastAt: null, username: u.username || null,
    }));
  }
  res.json(out);
});

// Pin / unpin a forward target. Toggle — the client doesn't track which way.
router.post('/forward-favorite', (req, res) => {
  const db = getChatDb(), me = req.user.id;
  const type = req.body?.target_type === 'user' ? 'user' : 'group';
  const id = +req.body?.target_id;
  if (!id) return res.status(400).json({ error: 'target_id required' });
  const row = db.prepare('SELECT id FROM chat_forward_favorites WHERE user_id=? AND target_type=? AND target_id=?').get(me, type, id);
  if (row) {
    db.prepare('DELETE FROM chat_forward_favorites WHERE id=?').run(row.id);
    return res.json({ favorite: false });
  }
  db.prepare('INSERT INTO chat_forward_favorites (user_id, target_type, target_id) VALUES (?,?,?)').run(me, type, id);
  res.json({ favorite: true });
});

// Rename a group — same privilege as managing members (create). DMs can't be
// renamed (their title is always the other person's name).
router.put('/:groupId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Not a member' });
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.is_dm) return res.status(400).json({ error: 'A direct message cannot be renamed' });
  // Creator/admin-only + audited (mam 2026-08-13: a group was renamed to
  // "XXXXXX" — any member could silently rename before).
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the group creator or an admin can rename the group' });
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Name required' });
  if (name !== grp.name) {
    chatAudit(req, 'rename-group', g, `"${grp.name}" -> "${name}"`);
    postSystem(db, g, req.user, `${req.user.name || 'Someone'} renamed the group from "${grp.name}" to "${name}"`);
  }
  db.prepare('UPDATE chat_groups SET name=? WHERE id=?').run(name, g);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

// Archive / restore — the reversible alternative to DELETE. Deleting a group is
// permanent (its rows are gone; only the attachments are recoverable, via
// quarantine), so archiving is what "remove this from the list" should normally
// mean. Same privilege as delete, since it hides the group for every member.
// Nothing is deleted, so this reclaims NO disk — it is list hygiene, not cleanup.
// A DM cannot be archived: one participant archiving would hide it for the other
// too, and per-user archive would need its own table. Same rule as rename.
const setArchived = (req, res, archived) => {
  const db = getChatDb(); const g = +req.params.groupId;
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.is_dm) return res.status(400).json({ error: 'A direct message cannot be archived' });
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the creator or an admin can archive the group' });
  // Audit line BEFORE flipping the flag — an archived group that comes back
  // shows exactly who hid it and who restored it (mam 2026-08-13: groups were
  // "vanishing" and reappearing; archive was the last untraced path).
  chatAudit(req, archived ? 'archive-group' : 'unarchive-group', g, grp.name);
  postSystem(db, g, req.user, archived
    ? `${req.user.name || 'Someone'} archived the group (hidden for everyone until restored)`
    : `${req.user.name || 'Someone'} restored the group`);
  db.prepare('UPDATE chat_groups SET archived_at=? WHERE id=?').run(archived ? new Date().toISOString() : null, g);
  // On archive reuse 'group_deleted' — for a client it means exactly "this group
  // has left your list", so the sidebar refreshes AND an open thread is closed.
  // On restore 'changed' triggers the same loadGroups() reconcile.
  emitChat(g, archived ? 'group_deleted' : 'changed', { groupId: g });
  res.json({ ok: true, archived });
};
router.post('/:groupId/archive', requirePermission('site_chat', 'delete'), (req, res) => setArchived(req, res, true));
router.post('/:groupId/unarchive', requirePermission('site_chat', 'delete'), (req, res) => setArchived(req, res, false));

router.delete('/:groupId', requirePermission('site_chat', 'delete'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  const grp = db.prepare('SELECT * FROM chat_groups WHERE id=?').get(g);
  if (!grp) return res.status(404).json({ error: 'Not found' });
  if (grp.created_by !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'Only the creator or an admin can delete the group' });
  // NOTHING hard-deletes any more (mam 2026-08-13: whole groups + their
  // messages were wiped today — "code so that anything dont delete").
  // "Delete" now = archive: the group disappears from every list exactly
  // like before, but ALL messages, members, reads and files stay in the DB
  // and an admin can bring it back instantly via /unarchive.  The audit
  // line goes in FIRST so the restored group shows who "deleted" it.
  chatAudit(req, 'delete-group(->archive)', g, grp.name);
  postSystem(db, g, req.user, `${req.user.name || 'Someone'} deleted the group (recoverable by admin)`);
  db.prepare('UPDATE chat_groups SET archived_at=CURRENT_TIMESTAMP WHERE id=? AND archived_at IS NULL').run(g);
  emitChat(g, 'group_deleted', { groupId: g });
  res.json({ ok: true, archived: true });
});

// Admin-only: the DB-level membership trail (trigger-fed, catches even
// direct-DB writes). Rows here with NO matching [chat-audit] pm2 log line
// = the change bypassed the API = someone/something with server access.
// MUST stay above the '/:groupId' route or 'admin' parses as a group id.
router.get('/admin/member-audit', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const db = getChatDb();
  const rows = db.prepare(`SELECT a.id, a.at, a.action, a.user_name, a.user_id, a.group_id, g.name AS group_name
                             FROM chat_member_audit a LEFT JOIN chat_groups g ON g.id=a.group_id
                            ORDER BY a.id DESC LIMIT 200`).all();
  res.json(rows);
});

router.get('/:groupId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const group = db.prepare('SELECT id, name, is_dm, archived_at FROM chat_groups WHERE id=?').get(g);
  if (!group) return res.status(404).json({ error: 'Group not found' });
  // Cursor pagination (backward-compatible): a client that passes ?limit=N gets
  // the most-recent N (or N older than ?before=<id>) via idx_cmsg_group_id; a
  // client that passes NOTHING gets the full history exactly as before, so the
  // current app is unaffected until it opts in (/site-chat perf pass).
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 0, 0), 100);
  const before = parseInt(req.query.before, 10) || 0;
  let messages, hasMore = false, quotedParents = [];
  if (limit > 0) {
    // Newest-first with a +1 look-ahead to know if older messages remain.
    const rows = before
      ? db.prepare('SELECT * FROM chat_messages WHERE group_id=? AND id < ? ORDER BY id DESC LIMIT ?').all(g, before, limit + 1)
      : db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY id DESC LIMIT ?').all(g, limit + 1);
    hasMore = rows.length > limit;
    if (hasMore) rows.pop();                 // drop the look-ahead row
    messages = rows.reverse();               // oldest→newest for display
    // Include quoted-reply parents that fall OUTSIDE this page so replies still
    // render their preview (client merges these into its lookup map).
    const oldestId = messages.length ? messages[0].id : 0;
    const parentIds = [...new Set(messages.map(m => m.reply_to_id).filter(id => id && id < oldestId))];
    if (parentIds.length) {
      const ph = parentIds.map(() => '?').join(',');
      quotedParents = db.prepare(`SELECT * FROM chat_messages WHERE id IN (${ph})`).all(...parentIds);
    }
  } else {
    messages = db.prepare('SELECT * FROM chat_messages WHERE group_id=? ORDER BY created_at, id').all(g);
  }
  const members = db.prepare('SELECT user_id, user_name AS name FROM chat_group_members WHERE group_id=? ORDER BY user_name').all(g);
  // DM header = the OTHER participant's name (per viewer), not the stored name.
  if (group.is_dm) group.name = members.filter(m => m.user_id !== req.user.id).map(m => m.name).filter(Boolean).join(', ') || group.name;
  const readRows = db.prepare('SELECT user_id,last_read_id,updated_at FROM chat_reads WHERE group_id=?').all(g);
  const reads = Object.fromEntries(readRows.map(r => [r.user_id, r.last_read_id]));
  const readsAt = Object.fromEntries(readRows.map(r => [r.user_id, r.updated_at]));  // for Message Info read-time
  const lastReadId = markRead(db, g, req.user.id);
  // Soft-deleted messages keep their row for the tombstone ("deleted by X")
  // but their CONTENT never leaves the server — body + attachment stripped
  // here, recoverable only by admin directly in the DB (mam 2026-08-13).
  const strip = (m) => m.deleted_at ? { ...m, body: null, attachment_url: null, attachment_name: null } : m;
  messages = messages.map(strip);
  quotedParents = quotedParents.map(strip);
  // NOTE: deliberately do NOT emitChat('changed') here. Loading a thread used
  // to broadcast 'changed' to the room, but the client reloads the thread on
  // 'changed' → which re-GETs → which re-emits: an infinite self-reinforcing
  // loop that hammered the server and caused intermittent chat errors
  // (mam 2026-06-19). New messages still emit from POST; read receipts refresh
  // via the other members' poll / next message.
  res.json({ group, messages, members, reads, readsAt, hasMore, quotedParents, last_read_id: lastReadId });
});

// Per-user send backpressure (2026-07): caps one user to 40 messages / 10 s → 429,
// so a runaway/abusive client can't flood the single event loop (each POST = several
// sync queries + 2 socket broadcasts). In-memory, site-chat only; keyed by user id
// (authMiddleware has already set req.user). A human never trips this.
const sendLimiter = rateLimit({
  windowMs: 10_000, max: 40, keyFn: (req) => req.user?.id,
  message: 'You are sending messages too fast — take a breath and try again in a moment.',
});

// Forward one message to MANY targets in a single call.
// A 'user' target with no DM yet gets one created here, so forwarding to
// someone you've never messaged just works.
router.post('/forward', sendLimiter, (req, res) => {
  const db = getChatDb(), me = req.user.id;
  const { body, attachment_url, attachment_name, targets } = req.body || {};
  if (!Array.isArray(targets) || !targets.length) return res.status(400).json({ error: 'Pick at least one chat' });
  if ((!body || !String(body).trim()) && !attachment_url) return res.status(400).json({ error: 'Nothing to forward' });
  if (targets.length > 25) return res.status(400).json({ error: 'Forward to at most 25 chats at once' });

  const myName = req.user.name || '';
  // forwarded=1 so the recipient's bubble carries the "Forwarded" label.
  const insMsg = db.prepare('INSERT INTO chat_messages (group_id, body, attachment_url, attachment_name, sender_id, sender_name, forwarded) VALUES (?,?,?,?,?,?,1)');
  const bump = db.prepare(`
    INSERT INTO chat_forward_stats (user_id, target_type, target_id, forward_count, last_forwarded_at)
    VALUES (?,?,?,1,CURRENT_TIMESTAMP)
    ON CONFLICT(user_id, target_type, target_id)
    DO UPDATE SET forward_count = forward_count + 1, last_forwarded_at = CURRENT_TIMESTAMP`);

  const sent = [], failed = [];
  for (const t of targets) {
    const type = t?.target_type === 'user' ? 'user' : 'group';
    const tid = +t?.target_id;
    if (!tid) { failed.push({ ...t, error: 'bad target' }); continue; }
    try {
      let gid;
      if (type === 'group') {
        if (!canAccess(db, req, tid)) { failed.push({ ...t, error: 'not a member' }); continue; }
        gid = tid;
      } else {
        gid = ensureDm(db, me, myName, tid);            // creates the DM if absent
      }
      const info = insMsg.run(gid, body ? String(body).trim() : null, attachment_url || null, attachment_name || null, me, myName);
      markRead(db, gid, me, info.lastInsertRowid);
      bump.run(me, type, tid);
      const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
      emitChat(gid, 'message', row);
      emitChat(gid, 'changed', { groupId: gid });
      sent.push({ target_type: type, target_id: tid, group_id: gid, message: row });
    } catch (e) {
      failed.push({ target_type: type, target_id: tid, error: e.message });
    }
  }
  res.json({ sent: sent.length, failed, results: sent });
});

// Any MEMBER can post — gated by group membership ONLY, not any site_chat
// module permission, so anyone added to a group can reply by default
// (mam 2026-06-19: "user add monika she is not able to reply").
router.post('/:groupId', sendLimiter, (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  // An archived group is read-only. Without this a client holding the thread open
  // could still post into it — the message would land in a group that shows in no
  // list and raises no unread badge, i.e. silently lost to everyone.
  if (db.prepare('SELECT archived_at FROM chat_groups WHERE id=?').get(g)?.archived_at) {
    return res.status(409).json({ error: 'This group is archived. Restore it to send messages.' });
  }
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
  markRead(db, g, req.user.id, info.lastInsertRowid);   // reuse the just-inserted id — skip the MAX(id) scan
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
  // Emit the new row so an updated client can append it directly. Additive: the
  // current client ignores 'message' and still reloads on 'changed' (perf pass).
  emitChat(g, 'message', row);
  emitChat(g, 'changed', { groupId: g });
  res.json(row);
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
  const addedNames = [];
  let added = 0;
  db.transaction(() => {
    for (const u of ids) {
      const nm = userName(+u);
      const ch = ins.run(g, +u, nm, req.user.id).changes;
      if (ch) { added += ch; addedNames.push(nm || `#${u}`); }
    }
  })();
  if (added > 0) {
    chatAudit(req, 'add-members', g, addedNames.join(', '));
    postSystem(db, g, req.user, `${req.user.name || 'Someone'} added ${addedNames.join(', ')}`);
  }
  emitChat(g, 'changed', { groupId: g });
  res.json({ added });
});
router.delete('/:groupId/members/:userId', requirePermission('site_chat', 'create'), (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'Only a member or admin can remove members' });
  const target = +req.params.userId;
  const self = target === req.user.id;
  // Removing SOMEONE ELSE is creator/admin-only (mam 2026-08-13: any member
  // could silently remove any other member — that is exactly how people were
  // "vanishing" from groups). Leaving the group yourself stays open to all.
  if (!self) {
    const grp = db.prepare('SELECT created_by FROM chat_groups WHERE id=?').get(g);
    if (grp?.created_by !== req.user.id && !isAdmin(req)) {
      return res.status(403).json({ error: 'Only the group creator or an admin can remove members' });
    }
  }
  const nm = db.prepare('SELECT user_name FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, target)?.user_name;
  const ch = db.prepare('DELETE FROM chat_group_members WHERE group_id=? AND user_id=?').run(g, target).changes;
  if (ch) {
    chatAudit(req, self ? 'leave-group' : 'remove-member', g, nm || `#${target}`);
    postSystem(db, g, req.user, self
      ? `${req.user.name || 'Someone'} left the group`
      : `${req.user.name || 'Someone'} removed ${nm || 'a member'}`);
  }
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

// Edit your OWN message within the 15-min window (WhatsApp-style). Unlike delete,
// admins may NOT edit someone else's words — sender only (mam 2026-07-15).
router.put('/:groupId/messages/:msgId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.is_system) return res.status(403).json({ error: 'System messages cannot be edited' });
  if (msg.deleted_at) return res.status(403).json({ error: 'This message was deleted' });
  if (msg.sender_id !== req.user.id) return res.status(403).json({ error: 'You can only edit your own messages' });
  const body = req.body?.body;
  if (!body || !String(body).trim()) return res.status(400).json({ error: 'Message cannot be empty' });
  // created_at is stored UTC via CURRENT_TIMESTAMP — append 'Z' so the age math is tz-correct.
  const ageMs = Date.now() - new Date(msg.created_at + 'Z').getTime();
  if (ageMs > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Edit window has expired' });
  db.prepare('UPDATE chat_messages SET body=?, edited_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(body).trim(), msg.id);
  const row = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(msg.id);
  emitChat(g, 'changed', { groupId: g });   // clients reconcile-refetch → pick up new body + edited_at
  res.json(row);
});

router.delete('/:groupId/messages/:msgId', (req, res) => {
  const db = getChatDb(); const g = +req.params.groupId;
  if (!canAccess(db, req, g)) return res.status(403).json({ error: 'You are not a member of this group' });
  const msg = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(req.params.msgId);
  if (!msg) return res.status(404).json({ error: 'Not found' });
  if (msg.is_system) return res.status(403).json({ error: 'Audit lines cannot be deleted' });
  if (msg.sender_id !== req.user.id && !isAdmin(req)) return res.status(403).json({ error: 'You can only delete your own messages' });
  // SOFT delete only (mam 2026-08-13: messages were being wiped — "anything
  // dont delete"). The row + body + file stay in the DB (admin-recoverable);
  // clients render a "deleted by X" tombstone; API responses strip content.
  chatAudit(req, 'delete-message', g, `msg#${msg.id} by ${msg.sender_name || '?'}`);
  db.prepare('UPDATE chat_messages SET deleted_at=CURRENT_TIMESTAMP, deleted_by=?, deleted_by_name=? WHERE id=?')
    .run(req.user.id, req.user.name || '', msg.id);
  emitChat(g, 'changed', { groupId: g });
  res.json({ ok: true });
});

module.exports = router;
