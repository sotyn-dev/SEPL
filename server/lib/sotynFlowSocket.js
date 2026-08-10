// Socket.IO layer for SOTYN Flow (task boards). Reuses the SAME `io` instance
// that chatSocket.initChatSocket() already creates — it does NOT modify chat.
// Everything here is namespaced away from chat: board events are `flow:*` and
// board rooms are `f:<boardId>`, disjoint from chat's `join`/`message`/`changed`
// and rooms `g:`/`u:`. So a chat client never receives a board event and vice
// versa. We only ADD a second, independent io.on('connection') listener (Socket.IO
// supports multiple) and reuse chat's existing io.use JWT auth (socket.user).
const { getBoardDb } = require('../db/sotynFlowDb');

let io = null;

// Member OR super-viewer (app admin / can_see_all) may join a board room. The
// route enforces the same rule; passed in so we don't duplicate the erp.db
// permission query here — the connection handler resolves it lazily per join.
function canJoin(uid, admin, boardId) {
  try {
    const db = getBoardDb();
    if (admin) return true;                       // app admin / super-viewer resolved by caller
    return !!db.prepare('SELECT 1 FROM board_members WHERE board_id=? AND user_id=?').get(boardId, uid);
  } catch (_) { return false; }
}

// Register board handlers on the shared io. `seeAll(uid)` lets a non-admin
// super-viewer (can_see_all on sotyn_flow) join any board room; injected so this
// file never imports the erp permission layer directly.
function registerBoardSocket(sharedIo, seeAll) {
  io = sharedIo;
  const superViewer = typeof seeAll === 'function' ? seeAll : () => false;
  io.on('connection', (socket) => {
    // Wrapped so a board-handler error can never break chat's connection handler.
    try {
      const uid = socket.user?.id;
      const admin = socket.user?.role === 'admin';
      socket.on('flow:join', (boardId) => {
        try {
          const b = +boardId;
          if (!b) return;
          if (canJoin(uid, admin || superViewer(uid), b)) socket.join(`f:${b}`);
        } catch (_) {}
      });
      socket.on('flow:leave', (boardId) => {
        try { const b = +boardId; if (b) socket.leave(`f:${b}`); } catch (_) {}
      });
    } catch (_) {}
  });
  return io;
}

// A `flow:changed` broadcast is idempotent ("something on this board changed —
// reconcile"), so a burst collapses into ONE trailing broadcast per board — same
// coalescing the chat socket uses for its `changed` event.
const CHANGED_WINDOW_MS = 300;
const changedTimers = new Map();     // boardId -> pending timeout

function scheduleChanged(boardId) {
  if (!io || changedTimers.has(boardId)) return;
  const t = setTimeout(() => {
    changedTimers.delete(boardId);
    try { io.to(`f:${boardId}`).emit('flow:changed', { boardId }); } catch (_) {}
  }, CHANGED_WINDOW_MS);
  if (t.unref) t.unref();
  changedTimers.set(boardId, t);
}

// Push an event to everyone in a board's room. 'changed' is coalesced per board;
// any other event fires immediately as `flow:<event>`.
function emitBoard(boardId, event, payload) {
  if (!io) return;
  if (event === 'changed') return scheduleChanged(boardId);
  try { io.to(`f:${boardId}`).emit(`flow:${event}`, payload); } catch (_) {}
}

module.exports = { registerBoardSocket, emitBoard, getIO: () => io };
