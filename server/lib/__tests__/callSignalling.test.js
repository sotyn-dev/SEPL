const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { Server } = require('socket.io');
const { io: connect } = require('../../../client/node_modules/socket.io-client');
const { attachCallSignalling } = require('../callSignalling');

test('call delivery requires a ready screen and confirms ringing independently', async (t) => {
  const server = http.createServer();
  const io = new Server(server);
  io.on('connection', socket => {
    // Test identities only; production authenticates before attaching handlers.
    socket.user = { id: Number(socket.handshake.auth.id), name: 'Test user' };
    attachCallSignalling(io, socket);
    socket.on('barrier', ack => ack());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const sockets = [];
  t.after(async () => {
    sockets.forEach(socket => socket.disconnect());
    await new Promise(resolve => io.close(resolve));
  });
  const open = async (id, transports) => {
    const socket = connect(`http://127.0.0.1:${server.address().port}`, { auth: { id }, transports });
    sockets.push(socket);
    await new Promise((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('connect_error', reject);
    });
    return socket;
  };
  const request = (socket, event, data) => socket.timeout(2000).emitWithAck(event, data);
  const ready = async socket => {
    socket.emit('call:ready');
    await socket.timeout(2000).emitWithAck('barrier');
  };
  const caller = await open(1, ['websocket']);
  await ready(caller);
  const offer = { to: 2, callId: 'test-call', sdp: { type: 'offer', sdp: 'test' } };
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: false, reason: 'offline' });
  const chatOnly = await open(2, ['polling']);
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: false, reason: 'offline' });
  const recipient = await open(2, ['polling']);
  await ready(recipient);
  let chatReceived = false;
  chatOnly.on('call:offer', () => { chatReceived = true; });
  const received = new Promise(resolve => recipient.once('call:offer', resolve));
  assert.deepEqual(await request(caller, 'call:offer', { ...offer, from: 999 }), { ok: true });
  const payload = await received;
  assert.equal(payload.from, 1);
  assert.equal(payload.callId, offer.callId);
  const ringing = new Promise(resolve => caller.once('call:ringing', resolve));
  await request(recipient, 'call:ringing', { to: 1, callId: offer.callId });
  assert.equal((await ringing).from, 2);
  assert.equal(chatReceived, false);
  for (const event of ['call:answer', 'call:ice', 'call:reject', 'call:end', 'call:cancel']) {
    const message = new Promise(resolve => caller.once(event, resolve));
    await request(recipient, event, { to: 1, callId: offer.callId });
    assert.equal((await message).callId, offer.callId);
  }
  assert.deepEqual(await request(caller, 'call:offer', { ...offer, to: 1 }), { ok: false, reason: 'invalid' });
  assert.deepEqual(await request(caller, 'call:offer', null), { ok: false, reason: 'invalid' });
  recipient.emit('call:unready');
  await recipient.timeout(2000).emitWithAck('barrier');
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: false, reason: 'offline' });
  await ready(recipient);
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: true });
  const serverSocket = io.sockets.sockets.get(recipient.id);
  const disconnected = new Promise(resolve => serverSocket.once('disconnect', resolve));
  recipient.disconnect();
  await disconnected;
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: false, reason: 'offline' });
  const reconnected = new Promise(resolve => recipient.once('connect', resolve));
  recipient.connect();
  await reconnected;
  await ready(recipient);
  assert.deepEqual(await request(caller, 'call:offer', offer), { ok: true });
});
