// Socket.IO layer for the chat — real-time message / read / member updates,
// SEPARATE from the rest of the ERP (mam 2026-06-18). Authenticated with the
// same JWT as the REST API. Each connection joins a room per group it belongs
// to (g:<groupId>); the chat route calls emitChat() to push live events.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { getSecret } = require('../middleware/auth');
const { getChatDb } = require('../db/chatDb');
const { getPub, getSub, getRedis, isRedisReady } = require('./redis');
const cacheKeys = require('./cacheKeys');

let io = null;

// Presence TTL (Workstream 4). A live user's heartbeat key is refreshed every
// half of this; after this many seconds with no refresh (clean disconnect OR a
// crashed instance) the user ages out to "offline". 30 s by default.
const PRESENCE_TTL_SEC = parseInt(process.env.PRESENCE_TTL_SEC, 10) || 30;

function roomsFor(uid, admin) {
  const db = getChatDb();
  // Admin joins every GROUP room but only the DM rooms they're a member of —
  // private DMs are never delivered to admin/COO (mam 2026-06-19).
  const rows = admin
    ? db.prepare('SELECT id AS gid FROM chat_groups WHERE is_dm=0 OR id IN (SELECT group_id FROM chat_group_members WHERE user_id=?)').all(uid)
    : db.prepare('SELECT group_id AS gid FROM chat_group_members WHERE user_id=?').all(uid);
  return rows.map(r => `g:${r.gid}`);
}

// ── Presence (Workstream 4) ───────────────────────────────────────────────
// "Who is online" in Redis, so a caller can skip ringing an offline user and so
// a future 2nd instance shares one presence view. TWO mechanisms, by design:
//   • a per-user heartbeat key (presenceHb) with a TTL — the SOURCE OF TRUTH for
//     isOnline(). It's refreshed every TTL/2 for every socket THIS instance holds
//     and is NEVER deleted on disconnect: if the user is still connected on
//     another instance that instance keeps refreshing it; if they're gone
//     everywhere it simply expires. That makes presence crash-safe (a dead
//     instance's users age out via the TTL) and multi-instance-safe (no
//     cross-instance DEL race).
//   • a Set (presence()) of online ids — a best-effort index for a future bulk
//     "who's online" list; NOT used by the offline-check (which needs one id).
// All of it no-ops cleanly when Redis is down: isOnline() then returns null
// ("unknown") and the caller proceeds exactly as today — a call is never blocked
// by a missing accelerator (fallback-first ethic).
const localPresence = new Map();   // uid -> # of sockets connected to THIS instance
let presenceTimer = null;

function markPresent(uid) {
  const r = getRedis();
  if (!r || !isRedisReady()) return;
  // Best-effort, never awaited on a hot path; a rejection just means the next
  // heartbeat tick retries. set+sadd are idempotent so repeats are harmless.
  try {
    r.set(cacheKeys.presenceHb(uid), '1', 'EX', PRESENCE_TTL_SEC).catch(() => {});
    r.sadd(cacheKeys.presence(), String(uid)).catch(() => {});
  } catch (_) { /* ignore */ }
}

// One interval per process refreshes the heartbeat of every locally-connected
// user, so a live user's key never lapses between reconnects. unref'd so it can
// never keep the process alive on shutdown.
function startPresenceHeartbeat() {
  if (presenceTimer) return;
  const ms = Math.max(5, Math.floor(PRESENCE_TTL_SEC / 2)) * 1000;
  presenceTimer = setInterval(() => {
    if (!isRedisReady()) return;
    for (const uid of localPresence.keys()) markPresent(uid);
  }, ms);
  if (presenceTimer.unref) presenceTimer.unref();
}

// Is this user online right now? true/false when Redis can answer, null when
// Redis is down — callers treat null as "unknown" and proceed (never block).
async function isOnline(uid) {
  const r = getRedis();
  if (!r || !isRedisReady()) return null;
  try { return (await r.exists(cacheKeys.presenceHb(uid))) === 1; }
  catch (_) { return null; }
}

function initChatSocket(httpServer) {
  io = new Server(httpServer, { path: '/socket.io', cors: { origin: true, credentials: true } });

  // Redis adapter (Workstream 2/4): when Redis is configured, fan chat + call
  // events out across every app instance via Redis Pub/Sub — the groundwork for
  // running more than one PM2 process / a second server without chat or call
  // signalling silently missing a user on another instance. getPub()/getSub()
  // return null when Redis is disabled or ioredis isn't installed, in which case
  // we keep the default in-memory adapter (single-instance = today's behavior).
  // IMPORTANT: the redis-adapter still delivers to LOCAL sockets directly, so
  // even if Redis is momentarily down, single-instance delivery is unaffected —
  // only the cross-instance fan-out (which doesn't exist yet) would pause.
  try {
    const pub = getPub(), sub = getSub();
    if (pub && sub) {
      // eslint-disable-next-line global-require
      const { createAdapter } = require('@socket.io/redis-adapter');
      io.adapter(createAdapter(pub, sub));
      console.log('[chat] Redis adapter enabled — multi-instance chat/call delivery');
    }
  } catch (e) {
    console.warn('[chat] Redis adapter unavailable, using in-memory adapter:', e.message);
  }

  // Pre-warm the main command connection (used by markPresent) at boot, so the
  // FIRST user to connect is marked online immediately rather than waiting for
  // the connection to open on-demand mid-handshake. No-op when Redis is disabled.
  try { getRedis(); } catch (_) {}

  // Authenticate every socket with the JWT (handshake auth or ?token=).
  io.use((socket, next) => {
    try {
      const t = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!t) return next(new Error('No token'));
      socket.user = jwt.verify(t, getSecret());
      next();
    } catch (e) { next(new Error('Auth failed')); }
  });

  io.on('connection', (socket) => {
    const uid = socket.user.id, admin = socket.user.role === 'admin';
    try { for (const r of roomsFor(uid, admin)) socket.join(r); } catch (_) {}
    try { socket.join('u:' + uid); } catch (_) {}     // personal room for 1-on-1 call signalling
    // Scope rooms for real-time feature pushes (Workstream 6): every user joins
    // 'all' (app-wide broadcasts like announcement:changed); admins also join
    // 'role:admin' (admin-only pushes like the live location map). These are
    // tenant-partitionable later via the same key seam as the cache.
    try { socket.join('all'); } catch (_) {}
    try { if (admin) socket.join('role:admin'); } catch (_) {}

    // Presence (Workstream 4): mark this user online on THIS instance and make
    // sure the heartbeat refresher is running. Ref-counted so a user with two
    // tabs open stays online until the LAST one drops (see disconnect below).
    localPresence.set(uid, (localPresence.get(uid) || 0) + 1);
    markPresent(uid);
    startPresenceHeartbeat();

    // WebRTC call signalling (mam 2026-06-19) — relay offer/answer/ICE/end to
    // the target user's personal room. Stateless pass-through; the media goes
    // peer-to-peer (WebRTC), only these tiny control messages go via the socket.
    for (const ev of ['call:offer', 'call:answer', 'call:ice', 'call:reject', 'call:end', 'call:cancel']) {
      socket.on(ev, (d = {}) => {
        const to = parseInt(d.to, 10);
        if (to) io.to('u:' + to).emit(ev, { ...d, to: undefined, from: uid, fromName: socket.user.name || '' });
      });
    }

    // Re-join when a client opens / is added to a group. Members always may;
    // admin may join GROUP rooms but NOT a private DM they're not part of.
    socket.on('join', (gid) => {
      try {
        const db = getChatDb(); const g = +gid;
        const isMem = !!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(g, uid);
        if (isMem) return socket.join(`g:${g}`);
        if (admin) { const row = db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(g); if (row && !row.is_dm) socket.join(`g:${g}`); }
      } catch (_) {}
    });

    // Presence teardown: when this user's LAST local socket drops, remove them
    // from the online Set (best-effort). We deliberately do NOT delete the
    // heartbeat key — if the user is still connected on another instance that
    // instance keeps refreshing it; otherwise its TTL expires on its own. This
    // avoids a cross-instance DEL race and keeps a crashed instance's users
    // aging out via the TTL rather than lingering forever.
    socket.on('disconnect', () => {
      const n = (localPresence.get(uid) || 1) - 1;
      if (n > 0) { localPresence.set(uid, n); return; }
      localPresence.delete(uid);
      const r = getRedis();
      if (r && isRedisReady()) { try { r.srem(cacheKeys.presence(), String(uid)).catch(() => {}); } catch (_) {} }
    });
  });

  return io;
}

// A 'changed' broadcast is idempotent ("something in this group changed —
// reconcile"), so a burst of them (rapid messages / reads in a busy group)
// safely collapses into ONE trailing broadcast per group instead of one-per-
// event. That caps the socket fan-out that would otherwise pile onto the single
// event loop under load (perf pass — S3 server half). Only 'changed' is
// coalesced; 'message' (which carries the actual new row) and every other event
// stay instant, so message delivery is never delayed.
const CHANGED_WINDOW_MS = 300;
const changedTimers = new Map();     // groupId -> pending timeout (a broadcast already queued)

function scheduleChanged(groupId) {
  if (!io || changedTimers.has(groupId)) return;
  const t = setTimeout(() => {
    changedTimers.delete(groupId);
    try { io.to(`g:${groupId}`).emit('changed', { groupId }); } catch (_) {}
  }, CHANGED_WINDOW_MS);
  if (t.unref) t.unref();             // a pending ping must never keep the process alive
  changedTimers.set(groupId, t);
}

// Push an event to everyone currently in a group's room. 'changed' is coalesced
// per group (see above); all other events fire immediately.
function emitChat(groupId, event, payload) {
  if (!io) return;
  if (event === 'changed') return scheduleChanged(groupId);
  try { io.to(`g:${groupId}`).emit(event, payload); } catch (_) {}
}

// Generic real-time push (Workstream 6). emitTo targets one room (e.g.
// 'role:admin' for the live map); broadcast hits every connected client (e.g.
// 'announcement:changed'). Both no-op safely when the socket layer isn't up, and
// — with the Redis adapter (Workstream 4) — fan out across instances. These are
// best-effort side channels: callers must NEVER depend on delivery (the REST
// data is always the source of truth; the client keeps a fallback poll).
function emitTo(room, event, payload) {
  if (!io) return;
  try { io.to(room).emit(event, payload); } catch (_) {}
}
function broadcast(event, payload) {
  if (!io) return;
  try { io.emit(event, payload); } catch (_) {}
}

module.exports = { initChatSocket, emitChat, emitTo, broadcast, isOnline, getIO: () => io };
