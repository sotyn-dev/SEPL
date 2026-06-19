// Socket.IO layer for the chat — real-time message / read / member updates,
// SEPARATE from the rest of the ERP (mam 2026-06-18). Authenticated with the
// same JWT as the REST API. Each connection joins a room per group it belongs
// to (g:<groupId>); the chat route calls emitChat() to push live events.
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const { SECRET } = require('../middleware/auth');
const { getChatDb } = require('../db/chatDb');

let io = null;

function roomsFor(uid, admin) {
  const db = getChatDb();
  const rows = admin
    ? db.prepare('SELECT id AS gid FROM chat_groups').all()
    : db.prepare('SELECT group_id AS gid FROM chat_group_members WHERE user_id=?').all(uid);
  return rows.map(r => `g:${r.gid}`);
}

function initChatSocket(httpServer) {
  io = new Server(httpServer, { path: '/socket.io', cors: { origin: true, credentials: true } });

  // Authenticate every socket with the JWT (handshake auth or ?token=).
  io.use((socket, next) => {
    try {
      const t = socket.handshake.auth?.token || socket.handshake.query?.token;
      if (!t) return next(new Error('No token'));
      socket.user = jwt.verify(t, SECRET);
      next();
    } catch (e) { next(new Error('Auth failed')); }
  });

  io.on('connection', (socket) => {
    const uid = socket.user.id, admin = socket.user.role === 'admin';
    try { for (const r of roomsFor(uid, admin)) socket.join(r); } catch (_) {}
    // Re-join when a client opens / is added to a group.
    socket.on('join', (gid) => {
      try {
        const db = getChatDb();
        if (admin || db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(+gid, uid)) socket.join(`g:${+gid}`);
      } catch (_) {}
    });
  });

  return io;
}

// Push an event to everyone currently in a group's room.
function emitChat(groupId, event, payload) {
  if (io) { try { io.to(`g:${groupId}`).emit(event, payload); } catch (_) {} }
}

module.exports = { initChatSocket, emitChat, getIO: () => io };
