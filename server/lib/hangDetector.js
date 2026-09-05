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
// Cost: one Map insert/delete per request and a 500 ms timer. Tunable via
// ERP_SLOW_MS / ERP_LAG_MS; disable with ERP_HANG_DETECTOR=0.

const SLOW_MS = Number(process.env.ERP_SLOW_MS) || 2000;
const LAG_MS = Number(process.env.ERP_LAG_MS) || 1000;
const TICK_MS = 500;

const inflight = new Map(); // id -> { req, started }
let seq = 0;
let lastFinished = null;    // { label, ms, at } — the request that ended most recently

// Never let a credential reach the PM2 log: a few endpoints carry the login
// token in the query string (backup download `?token=…`, audit report), and a
// backup download is exactly the slow request this logs. Redact by name.
const SENSITIVE_QS = /([?&](?:token|access_token|refresh_token|secret|api_key|apikey|key|code|sig|signature|password|pass|otp)=)[^&#]*/gi;
function describe(req) {
  const raw = String(req.originalUrl || req.url || '');
  const url = raw.replace(SENSITIVE_QS, '$1[redacted]').slice(0, 160);
  return `${req.method} ${url}`;
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
      lastFinished = { label: describe(req), ms, at: Date.now() };
      if (ms >= SLOW_MS) {
        const who = req.user ? `${req.user.id}:${req.user.name || ''}` : '-';
        console.warn(`[slow] ${describe(req)} status=${res.statusCode} ms=${ms} user=${who}`);
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
    const running = [...inflight.values()]
      .map(x => `${describe(x.req)} (${now - x.started}ms${x.req.user ? ', user ' + x.req.user.id : ''})`)
      .slice(0, 8);
    // The blocker usually FINISHES before this timer gets to run, so name the
    // request that ended inside the stall window as well as anything still open.
    const just = lastFinished && (now - lastFinished.at) <= lag + TICK_MS
      ? ` · just finished: ${lastFinished.label} (${lastFinished.ms}ms)` : '';
    console.warn(`[lag] event loop blocked ~${lag}ms · in-flight: ${running.length ? running.join(' | ') : 'none'}${just}${!running.length && !just ? ' (cron / GC / startup)' : ''}`);
  }, TICK_MS);
  timer.unref();

  console.log(`[hang-detector] on — [slow] > ${SLOW_MS}ms, [lag] > ${LAG_MS}ms`);
}

module.exports = { install, SLOW_MS, LAG_MS };
