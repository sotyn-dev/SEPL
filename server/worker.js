// Background job worker (Workstream 1 — BullMQ). A SEPARATE process from the API
// (its own PM2 app, `erp-worker`), so heavy/slow work — the push fan-out now,
// Excel export/import in WS1-B — runs off the API event loop on this 2-core VPS.
//
// Fallback-first: this process is an ACCELERATOR, never a dependency. If Redis is
// disabled/down the API does every job inline exactly as before, and this worker
// simply idles (it never crash-loops PM2). While it IS running it publishes a
// TTL heartbeat key that the API checks before enqueuing — so if this process
// dies, the API notices within seconds and reverts to inline sending rather than
// piling work into a queue nobody drains.
//
// Run locally with:  node server/worker.js   (alongside `npm run server`).

const sentry = require('./lib/sentry');
require('dotenv').config();

const { initializeDatabase } = require('./db/schema');
const { getRedis, isRedisReady, createBullConnection, closeRedis } = require('./lib/redis');
const cacheKeys = require('./lib/cacheKeys');
const { QUEUES, JOBS } = require('./jobs/queue');

process.on('uncaughtException', (err) => { console.error('[worker uncaughtException]', err); sentry.captureException(err); });
process.on('unhandledRejection', (err) => { console.error('[worker unhandledRejection]', err); sentry.captureException(err); });

const DISABLED = process.env.ERP_DISABLE_REDIS === '1' || process.env.ERP_DISABLE_JOB_QUEUE === '1';
const WORKER_TTL_SEC = 30;      // heartbeat key TTL
const HEARTBEAT_MS = 10_000;    // refresh well within the TTL

// The worker owns its own DB connection (better-sqlite3 is per-process). The API
// and this worker both write erp.db; getDb() sets PRAGMA busy_timeout so a
// concurrent write waits briefly instead of throwing SQLITE_BUSY.
initializeDatabase();

// One processor per job name. Add WS1-B's excel-* processors here later.
const processors = {
  [JOBS.PUSH_FANOUT]: require('./jobs/processors/pushFanout'),
};

let worker = null;
let heartbeatTimer = null;
let warmupTimer = null;
let _beatLanded = false;

function beat() {
  const r = getRedis();
  if (!r || !isRedisReady()) return;
  r.set(cacheKeys.workerAlive(), '1', 'EX', WORKER_TTL_SEC)
    .then(() => { _beatLanded = true; })
    .catch(() => {});
}

function startHeartbeat() {
  beat();                                   // try immediately
  heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
  if (heartbeatTimer.unref) heartbeatTimer.unref();
  // The main Redis connection reaches 'ready' a moment AFTER boot, so the first
  // beat above usually can't send yet. Retry every 500ms until the heartbeat
  // actually lands, so the API sees a live worker within ~1s of startup instead
  // of up to one full HEARTBEAT_MS interval (during which it would fall back to
  // inline sending unnecessarily).
  warmupTimer = setInterval(() => { if (_beatLanded) { clearInterval(warmupTimer); return; } beat(); }, 500);
  if (warmupTimer.unref) warmupTimer.unref();
}

function startWorker() {
  const { Worker } = require('bullmq');
  const connection = createBullConnection();
  if (!connection) { console.warn('[worker] no Redis connection — idling'); return null; }

  const w = new Worker(
    QUEUES.NOTIFICATIONS,
    async (job) => {
      const fn = processors[job.name];
      if (!fn) throw new Error(`No processor registered for job "${job.name}"`);
      return fn(job);
    },
    { connection, concurrency: 5 },
  );

  w.on('ready', () => console.log(`[worker] listening on "${QUEUES.NOTIFICATIONS}" queue`));
  w.on('completed', (job, res) => console.log(`[worker] ${job.name}#${job.id} done`, res || ''));
  w.on('failed', (job, err) => console.warn(`[worker] ${job?.name}#${job?.id} failed:`, err?.message));
  w.on('error', (err) => console.warn('[worker] error:', err?.message));
  return w;
}

async function shutdown(sig) {
  console.log(`[worker] ${sig} — shutting down`);
  try { clearInterval(heartbeatTimer); } catch (_) {}
  try { clearInterval(warmupTimer); } catch (_) {}
  // Drop the heartbeat key now so the API reverts to inline immediately rather
  // than waiting for the TTL to lapse.
  try { const r = getRedis(); if (r) await r.del(cacheKeys.workerAlive()).catch(() => {}); } catch (_) {}
  try { if (worker) await worker.close(); } catch (_) {}
  try { await closeRedis(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

if (DISABLED) {
  // Job queue turned off — the API runs everything inline. Stay alive and idle
  // (do NOT exit, or PM2 autorestart would crash-loop this app).
  console.log('[worker] job queue disabled (ERP_DISABLE_REDIS/ERP_DISABLE_JOB_QUEUE) — idling, API runs jobs inline');
  setInterval(() => {}, 1 << 30);
} else {
  worker = startWorker();
  if (worker) startHeartbeat();
  console.log('[worker] started');
}
