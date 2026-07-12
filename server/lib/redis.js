// Central Redis access for the ERP — the ONE place connections are created and
// the ONE place the rest of the app asks "is Redis usable right now?".
//
// Design rules (match the repo's degrade-gracefully style, cf. rateLimit.js /
// the compression try/catch in server/index.js):
//   1. NEVER throw on connect. Redis being down must never crash the ERP or
//      block a request — every caller checks isRedisReady() and falls back to
//      the current direct-SQLite behavior. A missing/broken Redis degrades
//      PERFORMANCE, never CORRECTNESS.
//   2. Lazy connections. Nothing connects at require()-time; the first getter
//      call opens the socket. So importing this module is free and safe even
//      when Redis isn't installed (local dev fallback mode).
//   3. One shared Redis, many logical connections. ioredis needs SEPARATE
//      connections for general commands, for the Socket.IO adapter's pub/sub
//      pair (a subscriber connection can't run normal commands), and for BullMQ
//      (which wants blocking commands + maxRetriesPerRequest:null). We create
//      each once and reuse it.
//   4. ERP_DISABLE_REDIS=1 forces full fallback (matches the existing
//      ERP_DISABLE_* convention) — a kill-switch to revert to pre-Redis
//      behavior in production without a redeploy.

const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const DISABLED = process.env.ERP_DISABLE_REDIS === '1';

// ready flag driven by ioredis lifecycle events. Starts false; flips true on
// 'ready', false again on 'end'/'error'. isRedisReady() reads this — a cheap
// synchronous boolean every hot path can check without touching the socket.
let _ready = false;

// Lazily-created connections (see rule 3). null until first requested.
let _redis = null;   // general commands (GET/SET/INCR/LRANGE/SADD/...)
let _pub = null;     // Socket.IO adapter publisher
let _sub = null;     // Socket.IO adapter subscriber (duplicate of _pub)

let _ioredisModule = null;   // cached require, or false if the package is absent
let _warnedMissing = false;
let _warnedError = false;

// Require ioredis lazily so a machine that hasn't `npm install`-ed yet (or a
// deliberate fallback deployment) doesn't crash on import — it just reports
// not-ready. Returns the module, or null if it can't be loaded.
function loadIoredis() {
  if (_ioredisModule) return _ioredisModule;
  if (_ioredisModule === false) return null;
  try {
    // eslint-disable-next-line global-require
    _ioredisModule = require('ioredis');
    return _ioredisModule;
  } catch (e) {
    _ioredisModule = false;
    if (!_warnedMissing) {
      console.warn('[redis] ioredis not installed — running in fallback mode (no cache/queue/adapter). Run `npm install` to enable Redis. (', e.message, ')');
      _warnedMissing = true;
    }
    return null;
  }
}

// Shared connection options. lazyConnect so `new Redis()` doesn't dial until we
// call .connect(); a bounded retryStrategy so a down Redis reconnects quietly in
// the background instead of hammering or throwing.
function baseOptions(extra) {
  return Object.assign({
    lazyConnect: true,
    // Back off up to ~2 s between reconnect attempts; keep trying forever so the
    // app self-heals when Redis comes back, but never faster than every 200 ms.
    retryStrategy: (times) => Math.min(times * 200, 2000),
    // Don't buffer commands forever while offline — fail fast so getOrSet's
    // try/catch falls back to the loader instead of hanging the request.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  }, extra || {});
}

// Attach lifecycle logging + ready-flag wiring to a connection, then kick off
// the (lazy) connect. Never throws — a connect failure just leaves _ready false.
function wire(conn, label) {
  conn.on('ready', () => { _ready = true; _warnedError = false; console.log(`[redis] ${label} ready`); });
  conn.on('end', () => { _ready = false; });
  conn.on('error', (err) => {
    _ready = false;
    if (!_warnedError) {
      console.warn(`[redis] ${label} error — falling back to direct SQLite behavior:`, err.message);
      _warnedError = true;   // once per outage, not per reconnect tick
    }
  });
  // .connect() rejects if the server is unreachable; swallow it — the retry
  // strategy keeps trying and 'ready' will fire if/when Redis appears.
  conn.connect().catch(() => { /* stays not-ready; callers fall back */ });
  return conn;
}

// General-purpose command connection. Returns null in fallback mode (disabled or
// ioredis absent) so callers can treat "no connection" and "not ready" alike.
function getRedis() {
  if (DISABLED) return null;
  if (_redis) return _redis;
  const Redis = loadIoredis();
  if (!Redis) return null;
  _redis = wire(new Redis(REDIS_URL, baseOptions()), 'main');
  return _redis;
}

// Publisher/subscriber pair for @socket.io/redis-adapter (Workstream 2/4).
// The subscriber MUST be a separate connection (a subscribed connection can't
// issue normal commands), so we duplicate the publisher.
function getPub() {
  if (DISABLED) return null;
  if (_pub) return _pub;
  const Redis = loadIoredis();
  if (!Redis) return null;
  _pub = wire(new Redis(REDIS_URL, baseOptions()), 'pub');
  return _pub;
}
function getSub() {
  if (DISABLED) return null;
  if (_sub) return _sub;
  const pub = getPub();
  if (!pub) return null;
  _sub = wire(pub.duplicate(), 'sub');
  return _sub;
}

// A LIVE ioredis connection for BullMQ (Workstream 1). BullMQ uses blocking
// commands, so its connection MUST have maxRetriesPerRequest:null (the general
// getRedis() connection uses 1 — the two can't be shared). BullMQ also
// duplicates this connection internally for its blocking workers. We create a
// dedicated instance here (kept inside redis.js so ioredis is required in ONE
// place) and hand it to Queue()/Worker(). Returns null in fallback mode
// (disabled / ioredis absent) so the queue layer runs jobs inline instead.
//
// NOTE: unlike the other connections this is NOT memoised — Queue and Worker
// live in different processes and each wants its own; the caller owns the
// returned instance's lifecycle (quit on shutdown).
function createBullConnection() {
  if (DISABLED) return null;
  const Redis = loadIoredis();
  if (!Redis) return null;
  const conn = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null,   // required by BullMQ (blocking BRPOPLPUSH etc.)
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });
  // Swallow errors so a down Redis doesn't spam uncaught 'error' events; the
  // queue layer gates on isRedisReady() and falls back to inline anyway.
  conn.on('error', () => {});
  return conn;
}

// The single question every Redis-optional code path asks. True only when a
// connection exists AND ioredis reports it 'ready'. Cheap + synchronous.
function isRedisReady() {
  if (DISABLED) return false;
  // Touch getRedis() so the main connection starts connecting on first check;
  // _ready stays false until 'ready' fires, so early callers correctly fall back.
  if (!_redis) getRedis();
  return _ready;
}

// Best-effort shutdown (called from index.js SIGINT/SIGTERM alongside the chat
// flush). Quits each connection so PM2 reload doesn't leave sockets dangling.
async function closeRedis() {
  const conns = [_redis, _pub, _sub].filter(Boolean);
  await Promise.all(conns.map((c) => c.quit().catch(() => {})));
  _redis = _pub = _sub = null;
  _ready = false;
}

module.exports = {
  getRedis,
  getPub,
  getSub,
  createBullConnection,
  isRedisReady,
  closeRedis,
  REDIS_URL,
};
