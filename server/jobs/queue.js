// Background job queue registry (Workstream 1 — BullMQ).
//
// This is the ONE place the API process talks to the queue. It exists to make
// enqueuing FALLBACK-SAFE by construction (matches the cache/socket helpers):
// `enqueue()` hands the job to BullMQ only when we're confident it will actually
// be processed, and otherwise returns false so the caller runs the existing
// inline path. Heavy/slow work then goes to server/worker.js when Redis + a live
// worker are present, and runs synchronously in-process exactly like today when
// they're not.
//
// The three gates enqueue() checks, all cheap + synchronous:
//   1. not disabled — ERP_DISABLE_JOB_QUEUE=1 (or ERP_DISABLE_REDIS=1) forces
//      the pre-queue inline behavior with no redeploy.
//   2. Redis ready — isRedisReady() (a down Redis ⇒ inline).
//   3. a worker is ALIVE — the worker refreshes a TTL heartbeat key; if no live
//      worker is seen we do NOT enqueue into a void, we run inline. This is what
//      keeps a misconfigured deploy (queue on, worker never started) correct
//      rather than silently dropping work. (BullMQ would persist the job and a
//      restarted worker would still pick it up, so this is belt-and-suspenders.)

const path = require('path');
const fs = require('fs');
const { createBullConnection, isRedisReady, getRedis } = require('../lib/redis');
const cacheKeys = require('../lib/cacheKeys');

const DISABLED = process.env.ERP_DISABLE_JOB_QUEUE === '1';

// Where the files worker writes generated artifacts (Excel exports). Shared by
// the worker (writer) and runFileJob (reader). NOT served statically — the
// route streams it and deletes it. Sits next to data/uploads.
const GENERATED_DIR = path.join(__dirname, '..', '..', 'data', 'generated');

// Queue names. `notifications` (Workstream 1 push fan-out) is live now; `files`
// (heavy Excel export/import) is reserved for WS1-B — declared here so both
// halves share one registry.
const QUEUES = { NOTIFICATIONS: 'notifications', FILES: 'files' };

// Job names within a queue (a queue can carry several job types).
const JOBS = {
  PUSH_FANOUT: 'push-fanout',                    // notifications queue
  EXCEL_EXPORT_QUOTATION: 'excel-export-quotation', // files queue (WS1-B)
};

// Sensible retry/backoff defaults: 3 tries, exponential backoff so a briefly
// slow/failed push server recovers instead of dropping the message; keep a
// bounded history so Redis memory can't grow unbounded.
const DEFAULT_JOB_OPTS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 3000 },
  removeOnComplete: 100,
  removeOnFail: 200,
};

// How long the API trusts a cached "worker is alive" result before re-checking.
// Small, so a worker that dies is noticed within a few seconds (then enqueue
// reverts to inline). Well under the worker's heartbeat TTL.
const WORKER_CHECK_MS = 4000;

let _bullmq = null;             // cached require('bullmq'), or false if absent
const _queues = new Map();      // name -> { queue, connection }
const _queueEvents = new Map(); // name -> { events, connection }
let _workerAlive = false, _workerCheckedAt = 0;

function loadBullmq() {
  if (_bullmq) return _bullmq;
  if (_bullmq === false) return null;
  try {
    // eslint-disable-next-line global-require
    _bullmq = require('bullmq');
    return _bullmq;
  } catch (e) {
    _bullmq = false;
    console.warn('[jobs] bullmq not installed — jobs run inline (fallback). Run `npm install`. (', e.message, ')');
    return null;
  }
}
function loadQueueClass() { const m = loadBullmq(); return m ? m.Queue : null; }

// Is the queue usable at all right now? (not disabled, Redis ready, bullmq present)
function isQueueReady() {
  return !DISABLED && isRedisReady() && !!loadQueueClass();
}

// Lazily create (once) the Queue for a name. Returns null in fallback mode. The
// underlying BullMQ connection reconnects quietly if Redis blips; we never let a
// construction error escape.
function getQueue(name) {
  if (DISABLED) return null;
  const existing = _queues.get(name);
  if (existing) return existing.queue;
  const Queue = loadQueueClass();
  if (!Queue) return null;
  const connection = createBullConnection();
  if (!connection) return null;
  try {
    const queue = new Queue(name, { connection, defaultJobOptions: DEFAULT_JOB_OPTS });
    queue.on('error', () => {});   // swallow — enqueue gates on isRedisReady()
    _queues.set(name, { queue, connection });
    return queue;
  } catch (e) {
    console.warn(`[jobs] could not create queue "${name}":`, e.message);
    try { connection.quit().catch(() => {}); } catch (_) {}
    return null;
  }
}

// QueueEvents for a queue (needed to await a specific job's completion in the
// request/response "off-loop but synchronous" pattern — WS1-B). Lazily created
// once per queue; its own subscriber connection. Null in fallback mode.
function getQueueEvents(name) {
  if (DISABLED) return null;
  const existing = _queueEvents.get(name);
  if (existing) return existing.events;
  const m = loadBullmq();
  if (!m) return null;
  const connection = createBullConnection();
  if (!connection) return null;
  try {
    const events = new m.QueueEvents(name, { connection });
    events.on('error', () => {});
    _queueEvents.set(name, { events, connection });
    return events;
  } catch (e) {
    console.warn(`[jobs] could not create QueueEvents "${name}":`, e.message);
    try { connection.quit().catch(() => {}); } catch (_) {}
    return null;
  }
}

// Can we hand work to the queue right now? (ready AND a live worker will drain it)
function canQueue() {
  return isQueueReady() && isWorkerAlive();
}

// Run a job and WAIT for its result — the "move CPU off the API loop but keep the
// synchronous response" pattern (WS1-B). Returns the job's return value, or the
// sentinel NOT_QUEUED so the caller runs its inline fallback. Throws only on a
// genuine job failure/timeout (caller may still fall back to inline).
const NOT_QUEUED = Symbol('not-queued');
async function runJob(queueName, jobName, data, { timeoutMs = 120000 } = {}) {
  if (!canQueue()) return NOT_QUEUED;
  const queue = getQueue(queueName);
  const events = getQueueEvents(queueName);
  if (!queue || !events) return NOT_QUEUED;
  const job = await queue.add(jobName, data);
  return job.waitUntilFinished(events, timeoutMs);   // resolves with the processor's return value
}

// Like runJob, but for jobs whose result is a FILE the worker wrote to
// GENERATED_DIR ({ file }). Reads it into a Buffer and deletes it (best-effort),
// so the route can stream the bytes exactly as if it had built them inline.
// Returns null when not queued ⇒ caller builds inline.
async function runFileJob(queueName, jobName, data, opts) {
  const result = await runJob(queueName, jobName, data, opts);
  if (result === NOT_QUEUED) return null;
  const file = result && result.file;
  if (!file) throw new Error('file job returned no file path');
  const abs = path.isAbsolute(file) ? file : path.join(GENERATED_DIR, file);
  const buf = await fs.promises.readFile(abs);
  fs.promises.unlink(abs).catch(() => {});   // clean up once we've read it
  return buf;
}

// Best-effort read of the worker's TTL heartbeat, cached for WORKER_CHECK_MS so
// the hot enqueue path never blocks on a Redis round-trip. Cold cache reports
// "not alive" (⇒ inline) until the first async EXISTS resolves — safe, since
// inline always works.
function isWorkerAlive() {
  const now = Date.now();
  if (now - _workerCheckedAt >= WORKER_CHECK_MS) {
    _workerCheckedAt = now;
    const r = getRedis();
    if (r && isRedisReady()) {
      r.exists(cacheKeys.workerAlive())
        .then((n) => { _workerAlive = n === 1; })
        .catch(() => { _workerAlive = false; });
    } else {
      _workerAlive = false;
    }
  }
  return _workerAlive;
}

// Enqueue a job IF it will be processed, else return false so the caller runs
// its inline fallback. `fallbackFn` (optional) runs if the async add() itself
// fails after we'd already committed to the queue — so a late enqueue error
// still gets the work done exactly once (add succeeded ⇒ worker does it; add
// rejected ⇒ fallbackFn does it; the two are mutually exclusive).
function enqueue(queueName, jobName, data, fallbackFn, opts) {
  if (!isQueueReady() || !isWorkerAlive()) return false;
  const queue = getQueue(queueName);
  if (!queue) return false;
  try {
    queue.add(jobName, data, opts).catch((err) => {
      console.warn(`[jobs] enqueue ${jobName} failed, running inline fallback:`, err.message);
      try { if (fallbackFn) fallbackFn(); } catch (_) {}
    });
    return true;
  } catch (e) {
    return false;   // synchronous failure — caller falls back inline
  }
}

// Best-effort shutdown for the API process (called from index.js SIGINT/SIGTERM).
async function closeQueues() {
  const q = [..._queues.values()]; _queues.clear();
  const e = [..._queueEvents.values()]; _queueEvents.clear();
  await Promise.all([
    ...q.map(async ({ queue, connection }) => {
      try { await queue.close(); } catch (_) {}
      try { await connection.quit(); } catch (_) {}
    }),
    ...e.map(async ({ events, connection }) => {
      try { await events.close(); } catch (_) {}
      try { await connection.quit(); } catch (_) {}
    }),
  ]);
}

module.exports = {
  QUEUES, JOBS, DEFAULT_JOB_OPTS, GENERATED_DIR,
  getQueue, getQueueEvents, enqueue, canQueue, runJob, runFileJob,
  isQueueReady, isWorkerAlive, closeQueues,
};
