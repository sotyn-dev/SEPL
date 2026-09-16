// Hang detector — mam 2026-09-05 "check ERP is going to hang".
//
// The server is ONE Node process on better-sqlite3, which is synchronous: a
// single slow handler (or cron) freezes every page for every user, and the
// health probe from outside only shows THAT it stalled, never WHO. These two
// probes make `pm2 logs erp | grep -E '\[slow\]|\[lag\]'` name the culprit:
//
//   [slow] METHOD /url status=… ms=… user=…   — a request that took > SLOW_MS
//   [lag]  event loop blocked ~Nms · in-flight: …  — the loop stalled > LAG_MS;
//          the blocker is one of the listed in-flight requests, or a cron /
//          GC pause if the list is empty.
//
// Since the 2026-09-05 audit the same data is also kept IN MEMORY (last 300
// slow requests, last 200 stalls, per-route totals) and served by
// GET /api/admin/perf → the Admin ▸ Performance page, so mam can see what is
// slow on the live server without opening the VPS terminal.
//
// Cost: one Map insert/delete per request and a 500 ms timer. Tunable via
// ERP_SLOW_MS / ERP_LAG_MS; disable with ERP_HANG_DETECTOR=0.

const SLOW_MS = Number(process.env.ERP_SLOW_MS) || 2000;
const LAG_MS = Number(process.env.ERP_LAG_MS) || 1000;
const TICK_MS = 500;
const KEEP_SLOW = 300;
const KEEP_LAG = 200;
// Per-route totals count everything that took at least this long, so the
// table ranks routes by the blocking time they actually cost, not by a
// threshold that only catches the very worst.
const TRACK_MS = 200;

const inflight = new Map(); // id -> { req, started }
let seq = 0;
let lastFinished = null;    // { label, ms, at } — the request that ended most recently
const startedAt = Date.now();

// In-memory history for the Performance page.
const slowRing = [];        // { at, method, url, status, ms, user }
const lagRing = [];         // { at, lag_ms, inflight: [label…], just_finished }
const routeStats = new Map(); // "METHOD /route/pattern" -> { n, total, max, over_slow, last_at }
let totalRequests = 0, totalSlow = 0, totalLag = 0, lagTotalMs = 0, maxLagMs = 0;

// Never let a credential reach the PM2 log: a few endpoints carry the login
// token in the query string (backup download `?token=…`, audit report), and a
// backup download is exactly the slow request this logs. Redact by name.
const SENSITIVE_QS = /([?&](?:token|access_token|refresh_token|secret|api_key|apikey|key|code|sig|signature|password|pass|otp)=)[^&#]*/gi;
function describe(req) {
  const raw = String(req.originalUrl || req.url || '');
  const url = raw.replace(SENSITIVE_QS, '$1[redacted]').slice(0, 160);
  return `${req.method} ${url}`;
}

// Collapse ids so /api/indents/123 and /api/indents/456 count as one route.
function routeKey(req) {
  const path = String(req.originalUrl || req.url || '').split('?')[0];
  return `${req.method} ${path.replace(/\/\d+(?=\/|$)/g, '/:id')}`.slice(0, 120);
}

function pushRing(ring, item, keep) {
  ring.push(item);
  if (ring.length > keep) ring.splice(0, ring.length - keep);
}

function install(app) {
  if (process.env.ERP_HANG_DETECTOR === '0') {
    console.log('[hang-detector] disabled via ERP_HANG_DETECTOR=0');
    return;
  }

  app.use((req, res, next) => {
    const id = ++seq;
    const started = Date.now();
    inflight.set(id, { req, started });
    let finished = false;
    const done = () => {
      if (finished) return;            // 'finish' and 'close' both fire
      finished = true;
      inflight.delete(id);
      const ms = Date.now() - started;
      totalRequests++;
      lastFinished = { label: describe(req), ms, at: Date.now() };
      if (ms >= TRACK_MS) {
        const k = routeKey(req);
        const s = routeStats.get(k) || { n: 0, total: 0, max: 0, over_slow: 0, last_at: 0 };
        s.n++; s.total += ms; s.max = Math.max(s.max, ms); s.last_at = Date.now();
        if (ms >= SLOW_MS) s.over_slow++;
        routeStats.set(k, s);
      }
      if (ms >= SLOW_MS) {
        totalSlow++;
        const who = req.user ? `${req.user.id}:${req.user.name || ''}` : '-';
        console.warn(`[slow] ${describe(req)} status=${res.statusCode} ms=${ms} user=${who}`);
        pushRing(slowRing, { at: Date.now(), method: req.method, url: describe(req).slice(req.method.length + 1), status: res.statusCode, ms, user: who }, KEEP_SLOW);
      }
    };
    res.once('finish', done);
    res.once('close', done);
    next();
  });

  // Event-loop lag: a 500 ms timer that fires late by more than LAG_MS means
  // something synchronous held the loop for that long. Log what was running.
  let last = Date.now();
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - last - TICK_MS;
    last = now;
    if (lag < LAG_MS) return;
    totalLag++; lagTotalMs += lag; maxLagMs = Math.max(maxLagMs, lag);
    const running = [...inflight.values()]
      .map(x => `${describe(x.req)} (${now - x.started}ms${x.req.user ? ', user ' + x.req.user.id : ''})`)
      .slice(0, 8);
    // The blocker usually FINISHES before this timer gets to run, so name the
    // request that ended inside the stall window as well as anything still open.
    const justHit = lastFinished && (now - lastFinished.at) <= lag + TICK_MS ? lastFinished : null;
    const just = justHit ? ` · just finished: ${justHit.label} (${justHit.ms}ms)` : '';
    console.warn(`[lag] event loop blocked ~${lag}ms · in-flight: ${running.length ? running.join(' | ') : 'none'}${just}${!running.length && !just ? ' (cron / GC / startup)' : ''}`);
    pushRing(lagRing, { at: now, lag_ms: lag, inflight: running, just_finished: justHit ? `${justHit.label} (${justHit.ms}ms)` : null }, KEEP_LAG);
  }, TICK_MS);
  timer.unref();

  console.log(`[hang-detector] on — [slow] > ${SLOW_MS}ms, [lag] > ${LAG_MS}ms`);
}

// Everything the Performance page shows. Newest first.
function snapshot() {
  const now = Date.now();
  const routes = [...routeStats.entries()]
    .map(([route, s]) => ({ route, count: s.n, total_ms: s.total, avg_ms: Math.round(s.total / s.n), max_ms: s.max, over_slow: s.over_slow, last_at: s.last_at }))
    .sort((a, b) => b.total_ms - a.total_ms)
    .slice(0, 60);
  return {
    thresholds: { slow_ms: SLOW_MS, lag_ms: LAG_MS, track_ms: TRACK_MS },
    since: startedAt,
    uptime_seconds: Math.round((now - startedAt) / 1000),
    totals: { requests: totalRequests, slow_requests: totalSlow, stalls: totalLag, stall_total_ms: lagTotalMs, stall_max_ms: maxLagMs },
    in_flight: [...inflight.values()].map(x => ({ label: describe(x.req), ms: now - x.started, user: x.req.user ? x.req.user.id : null })),
    routes,
    slow: [...slowRing].reverse(),
    stalls: [...lagRing].reverse(),
  };
}

function reset() {
  slowRing.length = 0; lagRing.length = 0; routeStats.clear();
  totalRequests = 0; totalSlow = 0; totalLag = 0; lagTotalMs = 0; maxLagMs = 0;
}

module.exports = { install, snapshot, reset, SLOW_MS, LAG_MS };
