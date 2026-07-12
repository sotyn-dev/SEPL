// Redis rollout smoke test (Workstreams 0–1). Run AFTER deploying the Redis
// branch on the VPS, with Redis + both PM2 apps (erp, erp-worker) up:
//
//     node server/scripts/redis-smoke.js
//
// It exercises every accelerated path end-to-end using the app's OWN helpers
// (so it proves the real code, not a reimplementation) and is SAFE on
// production: it only touches a throwaway cache key (which it deletes) and runs
// one no-op export job (whose temp file is auto-deleted). It writes NOTHING to
// erp.db. Exit code 0 = all pass, 1 = something's off.
//
// A FAIL here does not mean the app is broken — every path has an inline
// fallback — it means Redis acceleration isn't actually engaged (Redis down,
// deps not installed, or the erp-worker app not running).

require('dotenv').config();

const { getRedis, isRedisReady, closeRedis, REDIS_URL } = require('../lib/redis');
const cache = require('../lib/cache');
const cacheKeys = require('../lib/cacheKeys');
const jobs = require('../jobs/queue');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const record = (name, ok, detail) => { results.push({ name, ok, detail }); console.log(`${ok ? '  ✓' : '  ✗'} ${name}${detail ? ' — ' + detail : ''}`); };

async function waitFor(fn, ms = 6000, step = 200) {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch (_) {} await wait(step); }
  return false;
}

(async () => {
  console.log(`\nRedis smoke test — ${REDIS_URL}  (prefix ${cacheKeys._prefixForScope('').replace(/:+$/, '')})\n`);

  // 1) Connectivity — is Redis reachable and reporting ready?
  const ready = await waitFor(() => isRedisReady());
  record('Redis reachable + ready', ready, ready ? 'isRedisReady() = true' : 'NOT ready — check REDIS_URL / redis-server / ERP_DISABLE_REDIS');
  if (!ready) { return finish(); }

  const r = getRedis();

  // 2) Cache round-trip + invalidation (uses cache.getOrSet, the real helper).
  try {
    const key = cacheKeys.ref('smoke', String(process.pid));
    let loaderRuns = 0;
    const load = () => { loaderRuns++; return { ok: true, at: 'smoke' }; };
    await cache.getOrSet(key, 30, load);          // miss → loader runs, value cached
    const rawAfterSet = await r.get(key);
    await cache.getOrSet(key, 30, load);          // hit → loader must NOT run again
    await cache.del(key);                          // invalidate
    const rawAfterDel = await r.get(key);
    const ok = !!rawAfterSet && loaderRuns === 1 && rawAfterDel === null;
    record('Cache read/cache/invalidate', ok, `loaderRuns=${loaderRuns} (want 1), delEmpty=${rawAfterDel === null}`);
  } catch (e) { record('Cache read/cache/invalidate', false, e.message); }

  // 3) Worker heartbeat — is the erp-worker process alive?
  let workerUp = false;
  try { workerUp = (await r.exists(cacheKeys.workerAlive())) === 1; } catch (_) {}
  record('Worker process alive (erp-worker)', workerUp, workerUp ? 'heartbeat key present' : 'no heartbeat — is the erp-worker PM2 app running?');

  // 4) Files job end-to-end — enqueue an export and let the worker build it.
  if (workerUp) {
    try {
      await jobs.isWorkerAlive(); await wait(500);   // warm the API-side liveness cache
      const data = { title: 'SMOKE', client_name: '', client_address: '', quotation_no: '', prep_by: '',
        byCat: { Test: [{ description: 'smoke', qty: 1, rate: 1, sp: 1 }] }, manpower: [] };
      const buf = await jobs.runFileJob(jobs.QUEUES.FILES, jobs.JOBS.EXCEL_EXPORT_QUOTATION, data, { timeoutMs: 30000 });
      const validXlsx = Buffer.isBuffer(buf) && buf.length > 500 && buf[0] === 0x50 && buf[1] === 0x4b; // "PK" zip magic
      record('Files job (export) processed by worker', validXlsx, validXlsx ? `${buf.length} bytes, valid .xlsx` : 'no/invalid file returned');
    } catch (e) { record('Files job (export) processed by worker', false, e.message); }
  } else {
    record('Files job (export) processed by worker', false, 'skipped — worker not alive');
  }

  return finish();
})().catch((e) => { console.error('smoke test crashed:', e); process.exit(1); });

async function finish() {
  try { await jobs.closeQueues(); } catch (_) {}
  try { await closeRedis(); } catch (_) {}
  const failed = results.filter((x) => !x.ok);
  console.log(`\n${failed.length ? '✗ FAIL' : '✓ PASS'} — ${results.length - failed.length}/${results.length} checks passed\n`);
  // Give ioredis a tick to close sockets, then exit deterministically.
  setTimeout(() => process.exit(failed.length ? 1 : 0), 300);
}
