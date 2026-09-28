const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connect } = require('../../../client/node_modules/socket.io-client');
const { attachCallSignalling } = require('../callSignalling');
const { callNotification } = require('../chatPush');

async function fixture(t, options = {}) {
  const server = http.createServer();
  const io = new Server(server);
  const pushes = [];
  io.on('connection', socket => {
    socket.user = { id: Number(socket.handshake.auth.id), name: 'Test caller' };
    attachCallSignalling(io, socket, { notifyIncoming: async call => { pushes.push(callNotification(call)); return { sent: 1 }; }, ...options });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => { sockets.forEach(socket => socket.disconnect()); await new Promise(resolve => io.close(resolve)); });
  const open = async (id, transports = ['websocket']) => {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { auth: { id }, transports });
    sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('connect_error', reject); });
    return socket;
  };
  return { open, pushes, io };
}
const request = (socket, event, data) => socket.timeout(2000).emitWithAck(event, data);
const ready = (socket, data = {}) => request(socket, 'call:ready', data);
const once = (socket, event) => new Promise(resolve => socket.once(event, resolve));
const offer = id => ({ to: 2, callId: id, sdp: { type: 'offer', sdp: 'test-description' } });

test('foreground calls ring, answer and relay without a push', { timeout: 5000 }, async t => {
  const { open, pushes } = await fixture(t);
  const caller = await open(1), recipient = await open(2, ['polling']);
  await ready(caller); await ready(recipient);
  const received = once(recipient, 'call:offer');
  assert.equal((await request(caller, 'call:offer', { ...offer('online'), from: 99 })).mode, 'online');
  assert.equal((await received).from, 1);
  const ringing = once(caller, 'call:ringing');
  await request(recipient, 'call:ringing', { to: 1, callId: 'online' });
  assert.equal((await ringing).from, 2);
  const answered = once(caller, 'call:answer');
  await request(recipient, 'call:answer', { to: 1, callId: 'online', sdp: { type: 'answer', sdp: 'test' } });
  assert.equal((await answered).callId, 'online');
  const ice = once(recipient, 'call:ice');
  await request(caller, 'call:ice', { to: 2, callId: 'online', candidate: { candidate: 'test' } });
  assert.equal((await ice).candidate.candidate, 'test');
  await request(caller, 'call:end', { to: 2, callId: 'online' });
  assert.equal(pushes.length, 0);
});

test('closed app receives push and replays offer plus ICE when opened', { timeout: 5000 }, async t => {
  const { open, pushes } = await fixture(t);
  const caller = await open(1); await ready(caller);
  const notified = once(caller, 'call:delivery');
  assert.equal((await request(caller, 'call:offer', offer('closed'))).mode, 'notifying');
  assert.equal((await notified).notificationSent, true);
  assert.equal(pushes[0].type, 'site_call');
  assert.equal(pushes[0].url, '/site-chat?call=closed');
  assert.equal(pushes[0].sdp, undefined);
  assert.equal(pushes[0].ice, undefined);
  await request(caller, 'call:ice', { to: 2, callId: 'closed', candidate: { candidate: 'saved-ice' } });
  const stranger = await open(3); assert.equal((await ready(stranger, { callId: 'closed' })).pending, false);
  assert.equal((await request(stranger, 'call:answer', { to: 1, callId: 'closed' })).ok, false);
  const recipient = await open(2, ['polling']);
  const incoming = once(recipient, 'call:offer'), ice = once(recipient, 'call:ice');
  assert.equal((await ready(recipient, { callId: 'closed' })).pending, true);
  assert.equal((await incoming).sdp.sdp, 'test-description');
  assert.equal((await ice).candidate.candidate, 'saved-ice');
  await request(recipient, 'call:answer', { to: 1, callId: 'closed' });
  assert.equal((await ready(recipient, { callId: 'closed' })).pending, false);
});

test('background tab gets a push and duplicate offers are blocked', { timeout: 5000 }, async t => {
  const { open, pushes } = await fixture(t);
  const caller = await open(1), recipient = await open(2);
  await ready(caller); await ready(recipient, { visible: false });
  const notification = once(caller, 'call:delivery');
  await request(caller, 'call:offer', offer('hidden')); await notification;
  assert.equal(pushes.length, 1);
  assert.equal((await request(caller, 'call:offer', offer('hidden'))).reason, 'busy');
  await request(caller, 'call:cancel', { to: 2, callId: 'hidden' });
  assert.equal((await ready(recipient, { callId: 'hidden' })).pending, false);
});

test('no subscription and push failure report unavailable without a stuck invitation', { timeout: 5000 }, async t => {
  for (const notifyIncoming of [async () => ({ sent: 0 }), async () => { throw Error('push unavailable'); }]) {
    const { open } = await fixture(t, { notifyIncoming });
    const caller = await open(1); await ready(caller);
    const ended = once(caller, 'call:cancel');
    await request(caller, 'call:offer', offer('unavailable'));
    assert.equal((await ended).reason, 'unavailable');
    const recipient = await open(2);
    assert.equal((await ready(recipient, { callId: 'unavailable' })).pending, false);
  }
});

test('expired, cancelled and disconnected calls never ring after reopening', { timeout: 5000 }, async t => {
  const { open, io } = await fixture(t, { waitMs: 120 });
  const caller = await open(1); await ready(caller);
  const ended = once(caller, 'call:cancel');
  await request(caller, 'call:offer', offer('expired'));
  assert.equal((await ended).reason, 'no_answer');
  const recipient = await open(2);
  assert.equal((await ready(recipient, { callId: 'expired' })).pending, false);
  await request(caller, 'call:offer', offer('cancelled'));
  await request(caller, 'call:cancel', { to: 2, callId: 'cancelled' });
  assert.equal((await ready(recipient, { callId: 'cancelled' })).pending, false);
  await request(caller, 'call:offer', offer('disconnected'));
  const disconnected = once(io.sockets.sockets.get(caller.id), 'disconnect');
  caller.disconnect(); await disconnected;
  assert.equal((await ready(recipient, { callId: 'disconnected' })).pending, false);
});

test('one device answers and another device cannot end that call', { timeout: 5000 }, async t => {
  const { open } = await fixture(t);
  const caller = await open(1), first = await open(2), second = await open(2);
  await ready(caller); await ready(first); await ready(second);
  await request(caller, 'call:offer', offer('devices'));
  const dismissed = once(second, 'call:cancel');
  await request(first, 'call:answer', { to: 1, callId: 'devices' });
  assert.equal((await dismissed).reason, 'answered_elsewhere');
  assert.equal((await request(second, 'call:end', { to: 1, callId: 'devices' })).ok, false);
  assert.equal((await request(first, 'call:end', { to: 1, callId: 'devices' })).ok, true);
  assert.equal((await request(caller, 'call:offer', null)).ok, false);
  assert.equal((await request(caller, 'call:offer', { ...offer('self'), to: 1 })).ok, false);
});
