// Retain invitations while a recipient opens SOTYN from a push notification.
// SDP and ICE stay on the server, never in Web Push.
const servers = new WeakMap();
const { randomBytes, timingSafeEqual } = require('node:crypto');
const CALL_WAIT_MS = 60000;

// A short-lived, per-call capability is sent only inside the encrypted push.
// It allows the worker to acknowledge display without storing login tokens.
function acknowledgeCallNotification(io, data) {
  const call = io && servers.get(io)?.get(data?.callId);
  if (!call || call.answered || call.expiresAt <= Date.now() ||
      !['displayed', 'failed'].includes(data?.status) || typeof data?.receiptToken !== 'string' ||
      !/^[a-f0-9]{48}$/.test(data.receiptToken) ||
      !timingSafeEqual(Buffer.from(data.receiptToken), Buffer.from(call.receiptToken))) return false;
  // One failing device must not overwrite a successful acknowledgement.
  if (call.notificationDisplayed) return true;
  call.notificationDisplayed = data.status === 'displayed';
  io.to(call.callerSocket).emit('call:delivery', {
    callId: call.callId, notificationDisplayed: call.notificationDisplayed,
    notificationFailed: data.status === 'failed',
  });
  return true;
}

function attachCallSignalling(io, socket, options = {}) {
  let calls = servers.get(io);
  if (!calls) { calls = new Map(); servers.set(io, calls); }
  const notify = options.notifyIncoming || ((call) => require('./chatPush').notifyCall(call));
  const uid = Number(socket.user.id);
  const room = `calls:${uid}`;
  const targetSockets = id => [...(io.sockets.adapter.rooms.get(`calls:${id}`) || [])]
    .map(id => io.sockets.sockets.get(id)).filter(Boolean);
  const finish = (call, reason) => {
    if (calls.get(call.callId) !== call) return;
    calls.delete(call.callId);
    clearTimeout(call.timer);
    io.to(`calls:${call.from}`).to(`calls:${call.to}`).emit('call:cancel', { callId: call.callId, reason });
  };
  const deliver = (call, recipient) => {
    if (call.answered || call.expiresAt <= Date.now() || call.delivered.has(recipient.id)) return;
    call.delivered.add(recipient.id);
    recipient.emit('call:offer', call.offer);
    for (const candidate of call.ice) recipient.emit('call:ice', candidate);
  };
  socket.on('call:ready', async (data = {}, ack) => {
    await socket.join(room);
    socket.data.callVisible = data?.visible !== false;
    let pending = false;
    for (const call of calls.values()) {
      if (call.to !== uid || call.answered || call.expiresAt <= Date.now()) continue;
      if (data?.callId === call.callId) pending = true;
      deliver(call, socket);
    }
    if (typeof ack === 'function') ack({ pending });
  });
  socket.on('call:presence', data => { socket.data.callVisible = data?.visible === true; });
  socket.on('call:unready', () => { socket.leave(room); endSocketCalls(); });
  socket.on('call:offer', (data = {}, ack) => {
    const reply = typeof ack === 'function' ? ack : () => {};
    const to = Number(data?.to);
    if (!Number.isSafeInteger(to) || to <= 0 || to === uid || !socket.rooms.has(room) ||
        typeof data?.callId !== 'string' || !/^[\w.:-]{1,128}$/.test(data.callId) ||
        data.sdp?.type !== 'offer' || typeof data.sdp.sdp !== 'string' || data.sdp.sdp.length > 100000) {
      reply({ ok: false, reason: 'invalid' }); return;
    }
    // One invitation per participant bounds both the queue and push volume.
    if (calls.has(data.callId) || [...calls.values()].some(c => [c.from, c.to].includes(uid) || [c.from, c.to].includes(to))) {
      reply({ ok: false, reason: 'busy' }); return;
    }
    const call = { callId: data.callId, from: uid, to, callerSocket: socket.id, receiptToken: randomBytes(24).toString('hex'),
      fromName: String(socket.user.name || 'Someone').slice(0, 100), video: !!data.video,
      expiresAt: Date.now() + (options.waitMs || CALL_WAIT_MS), ice: [], delivered: new Set() };
    call.offer = { callId: call.callId, from: uid, fromName: call.fromName, video: call.video,
      sdp: data.sdp, expiresAt: call.expiresAt };
    calls.set(call.callId, call);
    call.timer = setTimeout(() => finish(call, 'no_answer'), options.waitMs || CALL_WAIT_MS);
    call.timer.unref?.();
    const recipients = targetSockets(to);
    recipients.forEach(recipient => deliver(call, recipient));
    const foreground = recipients.some(recipient => recipient.data.callVisible);
    reply({ ok: true, expiresAt: call.expiresAt, mode: foreground ? 'online' : 'notifying' });
    if (!foreground) {
      Promise.resolve().then(() => notify(call)).then(result => {
        if (calls.get(call.callId) !== call || call.answered || call.presented || call.notificationDisplayed) return;
        if (result?.sent) socket.emit('call:delivery', { callId: call.callId, notificationSent: true });
        else if (!targetSockets(to).length) finish(call, 'unavailable');
      }).catch(() => { if (!targetSockets(to).length) finish(call, 'unavailable'); });
    }
  });
  for (const event of ['call:ringing', 'call:answer', 'call:ice', 'call:reject', 'call:end', 'call:cancel']) {
    socket.on(event, (data = {}, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};
      const call = calls.get(data?.callId);
      const isCaller = call?.from === uid && call?.callerSocket === socket.id;
      const isRecipient = call?.to === uid && call.delivered.has(socket.id) && (!call.recipientSocket || call.recipientSocket === socket.id);
      if (!call || (!isCaller && !isRecipient) || Number(data.to) !== (isCaller ? call.to : call.from)) {
        reply({ ok: false, reason: 'invalid' }); return;
      }
      if ((event === 'call:ringing' || event === 'call:answer') && !isRecipient) return;
      if (event === 'call:ringing') call.presented = true;
      if (event === 'call:answer') {
        if (call.answered) return;
        call.answered = true;
        call.recipientSocket = socket.id;
        clearTimeout(call.timer);
        socket.to(`calls:${uid}`).emit('call:cancel', { callId: call.callId, reason: 'answered_elsewhere' });
      }
      const payload = { ...data, to: undefined, from: uid, fromName: socket.user.name || '' };
      if (event === 'call:ice' && isCaller && !call.answered && call.ice.length < 100) call.ice.push(payload);
      const destination = isCaller ? (call.recipientSocket || `calls:${call.to}`) : call.callerSocket;
      io.to(destination).emit(event, payload);
      reply({ ok: true });
      if (['call:reject', 'call:end', 'call:cancel'].includes(event)) finish(call, event);
    });
  }
  const endSocketCalls = () => {
    for (const call of calls.values()) {
      if (call.callerSocket === socket.id || call.recipientSocket === socket.id) finish(call, 'disconnected');
    }
  };
  socket.on('disconnect', endSocketCalls);
}

module.exports = { attachCallSignalling, acknowledgeCallNotification };
