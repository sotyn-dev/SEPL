// Shared BullMQ worker runtime (Workstream 1). This is the ONE place the
// background workers are defined; it is started in two ways:
//
//   • EMBEDDED (default): server/index.js calls start() after boot, so the single
//     `erp` PM2 process runs the workers in-process. No second always-on process
//     on the 2-core VPS. (mam 2026-07-14: the separate `erp-worker` app was
//     overkill for a single-fork box — collapsed back into the API, kept BullMQ.)
//   • STANDALONE: server/worker.js calls start() as its own process. Only used
//     once we go PM2 cluster mode (set ERP_EMBED_WORKER=0 on the API instances
//     and run this as a separate app so N API workers share ONE drain).
//
// Fallback-first: the workers are an ACCELERATOR, never a dependency. If Redis is
// disabled/down start() no-ops (or the workers idle) and the API does every job
// inline exactly as before — see server/jobs/queue.js. While workers ARE live
// they publish a TTL heartbeat the API checks before enqueuing, so a dead/absent
// worker means the API reverts to inline rather than piling work into a queue
// nobody drains.

const path = require('path');
const fs = require('fs');
const { pathToFileURL } = require('url');
const { getRedis, isRedisReady, createBullConnection } = require('../lib/redis');
const cacheKeys = require('../lib/cacheKeys');
const { QUEUES, JOBS } = require('./queue');
const { GENERATED_DIR } = require('./paths');

const DISABLED = process.env.ERP_DISABLE_REDIS === '1' || process.env.ERP_DISABLE_JOB_QUEUE === '1';
const WORKER_TTL_SEC = 30;      // heartbeat key TTL
const HEARTBEAT_MS = 10_000;    // refresh well within the TTL

// In-process (function) processors — IO-bound work that's cheap to run on the
// API event loop. The push fan-out queries the DB, so it stays in-process where
// getDb() is already open (a sandboxed child would need its own DB connection).
const notificationProcessors = {
  [JOBS.PUSH_FANOUT]: require('./processors/pushFanout'),
};

// The CPU-bound Excel build runs as a SANDBOXED processor: we hand BullMQ the
// file (not a function) so it runs the job in a child process — off the API
// event loop AND off the API's V8 heap. That file must stay Redis-free (see
// processors/excelExportQuotation.js), so we intentionally do NOT require it here.
// Pass a file:// URL OBJECT (not a bare path, not a string): BullMQ loads the
// sandboxed processor through the ESM loader, and on Windows a bare absolute path
// (`D:\…`) is misparsed as a URL scheme (`ERR_UNSUPPORTED_ESM_URL_SCHEME`).
// BullMQ has a dedicated `instanceof URL` branch that validates via fs.existsSync
// then imports via url.href — correct on Windows AND Linux. pathToFileURL returns
// a URL object, so we deliberately do NOT append `.href` here.
const EXCEL_PROCESSOR_FILE = pathToFileURL(path.join(__dirname, 'processors', 'excelExportQuotation.js'));

const workers = [];
let heartbeatTimer = null;
let sweepTimer = null;
let warmupTimer = null;
let _beatLanded = false;
let _started = false;

// ── Generated-file housekeeping ─────────────────────────────────────────────
// The API deletes each export right after streaming it, so files only linger if
// the API crashed mid-download. Ensure the dir exists and sweep hourly.
function ensureGeneratedDir() {
  try { if (!fs.existsSync(GENERATED_DIR)) fs.mkdirSync(GENERATED_DIR, { recursive: true }); } catch (_) {}
}
function sweepGenerated() {
  try {
    if (!fs.existsSync(GENERATED_DIR)) return;
    const cutoff = Date.now() - 3600_000;
    for (const f of fs.readdirSync(GENERATED_DIR)) {
      const p = path.join(GENERATED_DIR, f);
      try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch (_) {}
    }
  } catch (_) {}
}

// ── Heartbeat ───────────────────────────────────────────────────────────────
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
  // The Redis connection reaches 'ready' a moment AFTER boot, so the first beat
  // above usually can't send yet. Retry every 500ms until the heartbeat actually
  // lands, so the API sees a live worker within ~1s instead of up to one full
  // HEARTBEAT_MS interval (during which it would fall back to inline needlessly).
  warmupTimer = setInterval(() => { if (_beatLanded) { clearInterval(warmupTimer); warmupTimer = null; return; } beat(); }, 500);
  if (warmupTimer.unref) warmupTimer.unref();
}

// ── Workers ─────────────────────────────────────────────────────────────────
// Build a Worker for one queue. `processor` is either an async function (runs
// in-process) or an absolute file path (BullMQ runs it in a sandboxed child).
// Each worker gets its OWN Redis connection (BullMQ requirement for blocking
// workers). Returns null in fallback mode (no connection).
function makeWorker(Worker, queueName, processor, concurrency) {
  const connection = createBullConnection();
  if (!connection) return null;
  const w = new Worker(queueName, processor, { connection, concurrency });
  w.on('ready', () => console.log(`[worker] listening on "${queueName}" queue`));
  w.on('completed', (job) => console.log(`[worker] ${job.name}#${job.id} done`));
  w.on('failed', (job, err) => console.warn(`[worker] ${job?.name}#${job?.id} failed:`, err?.message));
  w.on('error', (err) => console.warn('[worker] error:', err?.message));
  return w;
}

function startWorkers() {
  const { Worker } = require('bullmq');
  // notifications: IO-bound in-process fn, concurrency 5.
  const n = makeWorker(
    Worker,
    QUEUES.NOTIFICATIONS,
    async (job) => {
      const fn = notificationProcessors[job.name];
      if (!fn) throw new Error(`No processor registered for job "${job.name}"`);
      return fn(job);
    },
    5,
  );
  // files: CPU-bound Excel build via a sandboxed child. concurrency 1 on a
  // 2-core box — one heavy build at a time, leaving a core for the API.
  const f = makeWorker(Worker, QUEUES.FILES, EXCEL_PROCESSOR_FILE, 1);
  if (n) workers.push(n);
  if (f) workers.push(f);
  return workers.length > 0;
}

// ── Lifecycle ───────────────────────────────────────────────────────────────
// Start the workers + heartbeat + housekeeping. Idempotent, and a no-op when the
// queue is disabled — in both cases the API keeps running every job inline.
function start() {
  if (_started) return true;
  if (DISABLED) {
    console.log('[worker] job queue disabled (ERP_DISABLE_REDIS/ERP_DISABLE_JOB_QUEUE) — API runs jobs inline');
    return false;
  }
  ensureGeneratedDir();
  sweepGenerated();
  sweepTimer = setInterval(sweepGenerated, 3600_000);
  if (sweepTimer.unref) sweepTimer.unref();
  if (startWorkers()) {
    startHeartbeat();
    _started = true;
    console.log('[worker] runtime started (embedded/standalone)');
    return true;
  }
  console.warn('[worker] no Redis connection — workers idle, API runs jobs inline');
  return false;
}

// Best-effort shutdown. Clears timers, drops the heartbeat key so peers revert to
// inline immediately, and closes the workers. Never throws.
async function stop() {
  try { if (heartbeatTimer) clearInterval(heartbeatTimer); } catch (_) {}
  try { if (warmupTimer) clearInterval(warmupTimer); } catch (_) {}
  try { if (sweepTimer) clearInterval(sweepTimer); } catch (_) {}
  heartbeatTimer = warmupTimer = sweepTimer = null;
  try { const r = getRedis(); if (r) await r.del(cacheKeys.workerAlive()).catch(() => {}); } catch (_) {}
  try { await Promise.all(workers.map((w) => w.close().catch(() => {}))); } catch (_) {}
  workers.length = 0;
  _started = false;
}

module.exports = { start, stop, isStarted: () => _started };
