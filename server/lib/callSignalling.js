// Only sockets with a mounted call screen receive invitations. The chat page
// has a second socket, so general chat presence is not call availability.
function attachCallSignalling(io, socket) {
  const uid = Number(socket.user.id);
  const room = `calls:${uid}`;
  socket.on('call:ready', () => socket.join(room));
  socket.on('call:unready', () => socket.leave(room));
  for (const event of ['call:offer', 'call:ringing', 'call:answer', 'call:ice', 'call:reject', 'call:end', 'call:cancel']) {
    socket.on(event, (data = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const to = Number(data?.to);
      if (!Number.isSafeInteger(to) || to <= 0 || to === uid || !data?.callId) {
        reply({ ok: false, reason: 'invalid' });
        return;
      }
      const target = `calls:${to}`;
      if (event === 'call:offer' && !io.sockets.adapter.rooms.get(target)?.size) {
        reply({ ok: false, reason: 'offline' });
        return;
      }
      io.to(target).emit(event, { ...data, to: undefined, from: uid, fromName: socket.user.name || '' });
      reply({ ok: true });
    });
  }
}

module.exports = { attachCallSignalling };
