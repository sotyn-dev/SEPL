const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { isChatPush, callNotification } = require('../chatPush');

test('call pushes use high urgency and expire promptly; messages keep their TTL', async () => {
  const sent = [];
  const module = { exports: {} };
  const deps = {
    'web-push': { setVapidDetails() {}, sendNotification: async (...args) => sent.push(args) },
    '../db/schema': { getDb: () => ({ prepare: () => ({ get: () => ({ value: 'test-key' }), all: () => [{ endpoint: 'test-device', p256dh: 'test', auth: 'test' }] }) }) },
    './chatPush': { isChatPush },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../push.js'), 'utf8'), { require: name => deps[name], module, process, console });
  const payload = callNotification({ callId: 'push-call', fromName: 'Caller', video: true, expiresAt: Date.now() + 55000 });
  assert.equal((await module.exports.pushToUser(2, payload)).sent, 1);
  assert.equal(sent[0][2].urgency, 'high');
  assert.ok(sent[0][2].TTL > 0 && sent[0][2].TTL <= 55);
  assert.equal((await module.exports.pushToUser(2, { ...payload, expiresAt: Date.now() - 1 })).sent, 0);
  assert.equal((await module.exports.pushToUser(2, { type: 'site_chat' })).sent, 1);
  assert.equal(sent[1][2].TTL, 86400);
  assert.equal((await module.exports.pushToUser(2, { type: 'ticket' })).sent, 0);
});

function worker() {
  const handlers = {}, shown = [], opened = [], notices = [], receipts = [];
  const self = {
    addEventListener: (event, handler) => { handlers[event] = handler; },
    location: { origin: 'https://test.invalid' },
    registration: { showNotification: async (title, options) => shown.push({ title, options }),
      getNotifications: async ({ tag }) => notices.filter(n => n.tag === tag) },
    clients: { matchAll: async () => [], openWindow: async url => opened.push(url) },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../../client/public/sw.js'), 'utf8'), {
    self, URL, console, fetch: async (url, options) => receipts.push({ url, options }),
  });
  return { handlers, shown, opened, notices, self, receipts };
}

test('service worker shows incoming/missed calls and opens the invitation on tap', async () => {
  const w = worker();
  const payload = callNotification({ callId: 'wake', video: false, expiresAt: Date.now() + 60000 });
  let task;
  w.handlers.push({ data: { json: () => payload }, waitUntil: p => { task = p; } }); await task;
  assert.match(w.shown[0].title, /Incoming voice call/);
  assert.equal(w.shown[0].options.requireInteraction, true);
  w.handlers.notificationclick({ notification: { close() {}, data: payload }, waitUntil: p => { task = p; } }); await task;
  assert.deepEqual(w.opened, ['/site-chat?call=wake']);
  w.handlers.push({ data: { json: () => ({ ...payload, expiresAt: Date.now() - 1 }) }, waitUntil: p => { task = p; } }); await task;
  assert.match(w.shown[1].title, /Missed call/);
  assert.equal(w.shown[1].options.requireInteraction, false);
});

test('worker distinguishes provider acceptance from actual display success or failure', async () => {
  const w = worker();
  const payload = callNotification({ callId: 'receipt', expiresAt: Date.now() + 60000, receiptToken: 'test-capability' });
  let task;
  w.handlers.push({ data: { json: () => payload }, waitUntil: p => { task = p; } }); await task;
  assert.equal(w.receipts[0].url, '/api/push/call-receipt');
  assert.equal(JSON.parse(w.receipts[0].options.body).status, 'displayed');
  assert.equal(w.receipts[0].options.credentials, 'omit');
  w.self.registration.showNotification = async () => { throw new TypeError('cannot display'); };
  w.handlers.push({ data: { json: () => payload }, waitUntil: p => { task = p; } }); await task;
  assert.equal(JSON.parse(w.receipts[1].options.body).status, 'failed');
});

test('service worker closes only the matching call alert and awaits focus before navigation', async () => {
  const w = worker();
  let closed = 0, otherClosed = 0, focused = false, task;
  w.notices.push({ tag: 'sotyn-call-test', close: () => closed++ }, { tag: 'chat-message-1', close: () => otherClosed++ });
  w.handlers.message({ data: { type: 'call_close', callId: 'test' }, waitUntil: p => { task = p; } }); await task;
  assert.equal(closed, 1); assert.equal(otherClosed, 0);
  w.self.clients.matchAll = async () => [{ url: 'https://test.invalid/site-chat',
    focus: async () => { focused = true; }, postMessage: data => { assert.equal(focused, true); assert.equal(data.url, '/site-chat?call=test'); } }];
  w.handlers.notificationclick({ notification: { close() {}, data: { url: '/site-chat?call=test' } }, waitUntil: p => { task = p; } }); await task;
  assert.equal(w.opened.length, 0);
});
