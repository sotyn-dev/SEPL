// Standalone BullMQ worker entrypoint.
//
// By DEFAULT you do NOT run this — the API process (server/index.js) embeds the
// worker runtime in-process, so the single `erp` PM2 app both serves HTTP and
// drains the queues. That's the right shape for the current single-fork 2-core
// VPS (mam 2026-07-14: the old separate `erp-worker` app was overkill).
//
// This file exists for the FUTURE: when we go PM2 CLUSTER mode (N API instances
// for multitenant scale), set ERP_EMBED_WORKER=0 on the API and run THIS as its
// own PM2 app so the N instances share one queue drain. The actual worker logic
// lives in ./jobs/workerRuntime — this is just the process shell around it.
//
// Run locally with:  node server/worker.js   (alongside `npm run server`).

const sentry = require('./lib/sentry');
require('dotenv').config();

const { initializeDatabase } = require('./db/schema');
const workerRuntime = require('./jobs/workerRuntime');

process.on('uncaughtException', (err) => { console.error('[worker uncaughtException]', err); sentry.captureException(err); });
process.on('unhandledRejection', (err) => { console.error('[worker unhandledRejection]', err); sentry.captureException(err); });

// The standalone worker owns its own DB connection (better-sqlite3 is
// per-process); the push fan-out processor queries erp.db. getDb() sets PRAGMA
// busy_timeout so a concurrent write waits briefly instead of throwing.
initializeDatabase();

async function shutdown(sig) {
  console.log(`[worker] ${sig} — shutting down`);
  try { await workerRuntime.stop(); } catch (_) {}
  try { await require('./lib/redis').closeRedis(); } catch (_) {}
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// start() no-ops (and this process just idles) when the queue is disabled, so
// PM2 autorestart never crash-loops it. Otherwise it starts the workers +
// heartbeat and this process becomes the queue drain.
workerRuntime.start();
console.log('[worker] standalone process up');

// Keep the process alive even if start() registered no workers (disabled/no
// Redis) — exiting would make PM2 autorestart crash-loop this app.
setInterval(() => {}, 1 << 30);
