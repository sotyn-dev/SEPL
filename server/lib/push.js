// Web Push notification helper — used by every route that needs to
// notify a user (delegations / tickets / payments / announcements).
//
// VAPID keys are auto-generated on first boot and persisted in
// app_settings so PM2 restarts don't invalidate every device's
// subscription.

const webpush = require('web-push');
const { getDb } = require('../db/schema');

let initialised = false;

function ensureVapid() {
  if (initialised) return true;
  const db = getDb();
  let pub = db.prepare(`SELECT value FROM app_settings WHERE key='vapid_public_key'`).get()?.value;
  let priv = db.prepare(`SELECT value FROM app_settings WHERE key='vapid_private_key'`).get()?.value;
  if (!pub || !priv) {
    const keys = webpush.generateVAPIDKeys();
    pub = keys.publicKey;
    priv = keys.privateKey;
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_public_key', ?)`).run(pub);
    db.prepare(`INSERT OR REPLACE INTO app_settings (key, value) VALUES ('vapid_private_key', ?)`).run(priv);
    console.log('[push] generated new VAPID keys');
  }
  const subject = process.env.VAPID_SUBJECT || 'mailto:admin@securedengineers.com';
  webpush.setVapidDetails(subject, pub, priv);
  initialised = true;
  return true;
}

function getPublicKey() {
  ensureVapid();
  const db = getDb();
  return db.prepare(`SELECT value FROM app_settings WHERE key='vapid_public_key'`).get()?.value;
}

// Send a single push to one subscription
async function sendOne(sub, payload) {
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload)
    );
    return { ok: true };
  } catch (err) {
    // 404 / 410 = subscription expired — deactivate it
    if (err.statusCode === 404 || err.statusCode === 410) {
      try {
        getDb().prepare(`UPDATE push_subscriptions SET active=0 WHERE endpoint=?`).run(sub.endpoint);
      } catch {}
      return { ok: false, reason: 'expired' };
    }
    return { ok: false, reason: err.message };
  }
}

// Send to one user (all their active devices)
async function pushToUser(userId, payload) {
  if (!userId) return { sent: 0 };
  ensureVapid();
  const subs = getDb().prepare(`SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id=? AND active=1`).all(userId);
  let sent = 0;
  for (const s of subs) {
    const r = await sendOne(s, payload);
    if (r.ok) sent += 1;
  }
  return { sent, total: subs.length };
}

// Send to many users at once
async function pushToUsers(userIds, payload) {
  let sent = 0, total = 0;
  const seen = new Set();
  for (const id of userIds) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const r = await pushToUser(id, payload);
    sent += r.sent || 0;
    total += r.total || 0;
  }
  return { sent, total };
}

// Send to every active user (announcements)
async function pushToAll(payload) {
  ensureVapid();
  const subs = getDb().prepare(`
    SELECT ps.endpoint, ps.p256dh, ps.auth
    FROM push_subscriptions ps
    JOIN users u ON u.id = ps.user_id
    WHERE ps.active=1 AND COALESCE(u.active, 1)=1
  `).all();
  let sent = 0;
  for (const s of subs) {
    const r = await sendOne(s, payload);
    if (r.ok) sent += 1;
  }
  return { sent, total: subs.length };
}

// The actual fan-out work, in ONE place (Workstream 1). Both the inline
// fallback below AND the BullMQ worker's processor call this, so the per-device
// send loop is identical whichever path runs it. Shape of `data` matches what
// the wrappers enqueue: { userIds:[...] , payload } or { all:true, payload }.
async function runPushFanout(data) {
  if (!data || !data.payload) return { sent: 0, total: 0 };
  if (data.all) return pushToAll(data.payload);
  if (Array.isArray(data.userIds)) return pushToUsers(data.userIds, data.payload);
  return { sent: 0, total: 0 };
}

// Enqueue the fan-out to the background worker when Redis + a live worker are
// present (durable, retried, off the API event loop); otherwise fall back to the
// original setImmediate inline send — unchanged behavior. require() is done
// lazily so push.js has no load-time dependency on the queue layer (avoids any
// require cycle and keeps this usable in the worker process itself).
function dispatchFanout(data, label) {
  const inline = () => setImmediate(() => {
    runPushFanout(data).catch(err => console.warn(`[push] ${label} failed:`, err.message));
  });
  let queued = false;
  try {
    const { enqueue, QUEUES, JOBS } = require('../jobs/queue');
    queued = enqueue(QUEUES.NOTIFICATIONS, JOBS.PUSH_FANOUT, data, inline);
  } catch (_) { queued = false; }
  if (!queued) inline();   // Redis down / no worker / not enqueued ⇒ send inline now
}

// Fire-and-forget wrappers — never throw, never block the parent route. Use
// these from inside POST/PUT handlers so a push failure can't break a submit.
function notify(userId, payload) {
  if (!userId) return;
  dispatchFanout({ userIds: [userId], payload }, 'notify');
}

function notifyMany(userIds, payload) {
  if (!Array.isArray(userIds) || !userIds.length) return;
  dispatchFanout({ userIds, payload }, 'notifyMany');
}

function notifyAll(payload) {
  dispatchFanout({ all: true, payload }, 'notifyAll');
}

module.exports = {
  ensureVapid,
  getPublicKey,
  pushToUser,
  pushToUsers,
  pushToAll,
  runPushFanout,
  notify,
  notifyMany,
  notifyAll,
};
