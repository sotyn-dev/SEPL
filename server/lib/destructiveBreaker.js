// Destructive-action circuit breaker — the REFUSE layer the 2026-08-22/24
// incident showed was missing. That night one ordinary `user` account made
// ~1,155 successful destructive calls (mass DELETE across ~20 modules, 16
// employee terminations, 106 PO/FOC approves) at ~2 requests/sec, and the
// only defence that existed — bulkDeleteAlert — fires AFTER each row is
// already gone. This module is the counterpart that stops the spray while
// it is happening:
//
//   • Every user's successful destructive actions are counted over a rolling
//     10-minute window. At the threshold (10 by day, 5 during 22:00–06:00 IST
//     — nobody legitimately deletes six things at 2am, and the real spray ran
//     23:42–00:47) further destructive calls are refused with HTTP 429 for
//     30 minutes. The session STAYS logged in (mam's iron rule: no
//     auto-logout, ever) — only the destructive verbs lock.
//   • Counting is derived from audit_log (already indexed per-user) plus a
//     small breaker_events table for weighted actions a plain DELETE count
//     can't see: admin-mark-bulk marking 22 days is 22, bulk-approve of 40
//     payment ids is 40, one HR bulk-status batch trips the lock outright.
//   • The tripped state lives in a table (destructive_locks), so a pm2
//     restart or a fresh login does NOT clear it. Only an admin unlock or
//     the 30-minute expiry does.
//   • Admins are subject to the breaker too — the scenario Layer 1
//     (permission stripping) cannot stop is a STOLEN admin/HR login. A real
//     admin doing a genuine cleanup waits 30 minutes or has another admin
//     unlock; that trade was chosen deliberately.
//   • FAIL-OPEN: if the check itself errors (DB busy, table missing on an
//     un-migrated copy) the request goes through and we log loudly. A
//     breaker malfunction must never become its own outage (same stance as
//     sessionState in middleware/auth.js).
//
// Wiring: ONE call site — authMiddleware calls guardCheck(req) after
// req.user is set. Everything else (what counts, what blocks, weights) is
// decided in here, so future destructive endpoints are added to the lists
// below, not wired file-by-file.
//
// Emergency valve: ERP_DISABLE_BREAKER=1 disables the whole thing (mirrors
// ERP_DISABLE_AUDIT).

const { getDb } = require('../db/schema');

const WINDOW_MINUTES = 10;
const LOCK_MINUTES = 30;
const TRIP_DAY = 10;         // threshold during working hours
const TRIP_NIGHT = 5;        // 22:00–06:00 IST — spray hours, tighter
const NIGHT_START = 22, NIGHT_END = 6; // IST hours

// DELETE on any of these API prefixes counts toward — and is blocked by —
// the breaker: every router that holds BUSINESS data (the incident bands
// plus every same-class module the adversarial review found uncovered —
// DPR, item master, tally bills, inventory, labour, drawings, user
// accounts…). Deliberately NOT included: config/housekeeping routers (pipe
// weights, module flags, module videos, delegations, pms-tasks,
// system-requirements, fire-noc, cashflow, crm-kitting, price-requests,
// labour payments) so admin housekeeping can't arm or trip the lock.
// NOTE scoreFor() filters its audit-log count to THESE prefixes too — a
// delete outside this list neither blocks nor counts, so the two can never
// disagree (unguarded deletes silently arming the lock was a review find).
const GUARDED_DELETE_PREFIXES = [
  '/api/business-book', '/api/customers', '/api/crm-funnel', '/api/sales-funnel',
  '/api/influencers', '/api/quotations', '/api/solar', '/api/solar-site',
  '/api/procurement', '/api/orders', '/api/procurement-schedule', '/api/snags',
  '/api/sales-billing', '/api/installation', '/api/cheques', '/api/payment-required',
  '/api/collections', '/api/ar-ap-tracker', '/api/hr', '/api/hr-system',
  '/api/subcon-hiring', '/api/sub-contractors', '/api/company-assets',
  '/api/rentals', '/api/rental-tools', '/api/attendance', '/api/site-chat',
  '/api/leads', '/api/dpr', '/api/item-master', '/api/tally-bills', '/api/tools',
  '/api/inventory', '/api/complaints', '/api/client-snag', '/api/indent-fms',
  '/api/drawing-tracker', '/api/labour-master', '/api/labour-quotations',
  '/api/labour-rate-master', '/api/auth/users',
  // Sotyn Leads (2026-09-07): website enquiries are business data — a sprayed
  // delete of the inbox must arm and trip the lock like any other module.
  '/api/sotyn-leads',
];

// Non-DELETE requests that do the same damage (blocked when locked; their
// WEIGHT is reported by the route itself via addScore after success, since
// only the handler knows how many rows one call touched).
const GUARDED_WRITES = [
  { method: 'POST', re: /^\/api\/attendance\/admin-mark(-bulk)?$/ },
  { method: 'POST', re: /^\/api\/quotations\/po-foc\/\d+\/approve$/ },
  { method: 'POST', re: /^\/api\/payment-required\/bulk-(approve|reject)$/ },
  { method: 'POST', re: /^\/api\/hr\/employees\/bulk-status$/ },
  // Employee edit is only destructive when it terminates/deactivates —
  // a locked user can still fix a phone number. TRANSITION-aware, not
  // value-aware: the client PUTs the full employee row, so an edit to an
  // ALREADY-terminated employee carries status='terminated' too — matching
  // on the value alone would block innocent edits to past staff while
  // locked (adversarial-review find). One indexed PK read, only on this
  // rare endpoint, decides whether the status is actually CHANGING.
  {
    method: 'PUT', re: /^\/api\/hr\/employees\/(\d+)$/,
    bodyTest: (b, path) => {
      if (!['terminated', 'inactive'].includes(String(b?.status || '').toLowerCase())) return false;
      try {
        const id = path.match(/(\d+)$/)?.[1];
        const cur = getDb().prepare('SELECT status FROM employees WHERE id=?').get(id);
        return !cur || String(cur.status || '').toLowerCase() !== String(b.status).toLowerCase();
      } catch (_) { return true; }   // can't read → treat as destructive (safe side)
    },
  },
];

let _tablesReady = false;
function ensureTables(db) {
  if (_tablesReady) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS destructive_locks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      tripped_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      until DATETIME NOT NULL,
      reason TEXT,
      score_at_trip INTEGER,
      unlocked_by INTEGER,
      unlocked_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_destructive_locks_user ON destructive_locks(user_id, until DESC);
    CREATE TABLE IF NOT EXISTS breaker_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      at DATETIME DEFAULT CURRENT_TIMESTAMP,
      weight INTEGER NOT NULL DEFAULT 1,
      kind TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_breaker_events_user ON breaker_events(user_id, at DESC);
  `);
  _tablesReady = true;
}

const sqliteNow = (offsetMs = 0) =>
  new Date(Date.now() + offsetMs).toISOString().replace('T', ' ').slice(0, 19);
// Millisecond-precision variant used ONLY for the unlock boundary. audit_log
// and CURRENT_TIMESTAMP are second-resolution; if a spray and its unlock land
// in the same second (proved by the e2e test — 10 deletes + unlock inside
// one second), a second-resolution boundary with a >= compare re-counts the
// pre-unlock deletes and re-trips the lock the admin just cleared. A
// '…06.123' boundary string sorts strictly AFTER every '…06' event, so
// same-second pre-unlock events are excluded lexically.
const sqliteNowMs = () => new Date().toISOString().replace('T', ' ').slice(0, 23);

function istHour() { return new Date(Date.now() + 5.5 * 3600 * 1000).getUTCHours(); }
function isNight() { const h = istHour(); return h >= NIGHT_START || h < NIGHT_END; }
function tripThreshold() { return isNight() ? TRIP_NIGHT : TRIP_DAY; }

// Express routes case-insensitively and tolerates doubled slashes, so
// "DELETE /API//Customers/5" reaches the same handler as the canonical
// path — normalise before matching or that exact spelling walks straight
// past a case-sensitive startsWith (adversarial-review find).
function normalisePath(originalUrl) {
  let p = (originalUrl || '').split('?')[0];
  // Express percent-decodes before routing ("/api/%63ustomers" hits the
  // customers router) — decode before matching or encoding dodges the guard.
  try { p = decodeURIComponent(p); } catch (_) { /* malformed encoding — match raw */ }
  return p.replace(/\/{2,}/g, '/').toLowerCase();
}

function isGuarded(req) {
  const path = normalisePath(req.originalUrl);
  if (req.method === 'DELETE') {
    return GUARDED_DELETE_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
  }
  return GUARDED_WRITES.some(
    (g) => g.method === req.method && g.re.test(path) && (!g.bodyTest || g.bodyTest(req.body, path)),
  );
}

// Static WHERE fragment limiting the audit-log count to guarded paths — so
// deletes on housekeeping routers (notifications, pipe weights…) can never
// arm the lock for a later legitimate guarded delete. Prefixes are
// hard-coded constants above, so inlining them is injection-safe.
const GUARDED_PATH_SQL = GUARDED_DELETE_PREFIXES
  .map((p) => `LOWER(path) = '${p}' OR LOWER(path) LIKE '${p}/%'`)
  .join(' OR ');

function activeLock(db, userId) {
  return db.prepare(
    `SELECT * FROM destructive_locks
      WHERE user_id = ? AND unlocked_at IS NULL AND until > ?
      ORDER BY id DESC LIMIT 1`
  ).get(userId, sqliteNow());
}

// Rolling-window score. The window never reaches back past the most recent
// admin unlock — otherwise the pre-unlock actions still satisfy the
// threshold and the very next delete re-trips the lock the admin just
// cleared.
function scoreFor(db, userId) {
  let since = sqliteNow(-WINDOW_MINUTES * 60 * 1000);
  const lastUnlock = db.prepare(
    'SELECT MAX(unlocked_at) m FROM destructive_locks WHERE user_id = ? AND unlocked_at IS NOT NULL'
  ).get(userId)?.m;
  if (lastUnlock && lastUnlock > since) since = lastUnlock;

  const deletes = db.prepare(
    `SELECT COUNT(*) c FROM audit_log
      WHERE user_id = ? AND action IN ('DELETE','FORCE_DELETE')
        AND status_code BETWEEN 200 AND 299 AND at >= ?
        AND (${GUARDED_PATH_SQL})`
  ).get(userId, since)?.c || 0;
  const weighted = db.prepare(
    'SELECT COALESCE(SUM(weight),0) w FROM breaker_events WHERE user_id = ? AND at >= ?'
  ).get(userId, since)?.w || 0;
  return deletes + weighted;
}

function notifyTrip(db, userId, userName, score, reason) {
  const who = userName || `user #${userId}`;
  const title = `⛔ Destructive actions LOCKED for ${who} (${score} in ${WINDOW_MINUTES} min)`;
  const body = `Account "${who}" hit the destructive-action limit (${score} delete/terminate/mass-approve action(s) in ${WINDOW_MINUTES} minutes${isNight() ? ', during night hours' : ''}) — further destructive actions are refused for ${LOCK_MINUTES} minutes. Reason: ${reason}. If this is an attack, deactivate the account + Force Logout now. If it is legitimate bulk work, an admin can unlock the account (or it opens by itself when the timer runs out).`;
  const url = `/admin/audit?user_id=${userId}`;
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    const dedupe = `breaker_trip:${userId}:${sqliteNow().slice(0, 16)}`; // minute-resolution
    const ins = db.prepare(
      `INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
       VALUES (?,?,?,?,?,?,?)`
    );
    for (const a of admins) ins.run(a.id, 'breaker_trip', title, body.slice(0, 900), url, 'in_app', dedupe);
  } catch (e) { console.warn('[breaker] in-app notify failed:', e.message); }
  try {
    const { notifyMany } = require('./push');
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    notifyMany(admins.map((a) => a.id), { title, body: body.slice(0, 180), url, tag: `breaker-${userId}` });
  } catch (e) { console.warn('[breaker] push failed:', e.message); }
  setImmediate(async () => {
    try {
      const { sendEmail, getEmailConfig } = require('./email');
      const director = getEmailConfig().director;
      if (sendEmail && director) {
        await sendEmail({
          to: director,
          subject: `[SEPL ERP] ${title}`,
          text: `${body}\n\nAudit: /admin/audit?user_id=${userId}`,
          html: `<h3>${title}</h3><p>${body}</p>`,
        });
      }
    } catch (e) { console.warn('[breaker] email failed:', e.message); }
  });
}

// Create a lock now (used on threshold trip AND deliberately by the HR
// bulk-status route: one legitimate batch, then the gun goes cold).
function tripNow(db, userId, userName, score, reason) {
  const existing = activeLock(db, userId);
  if (existing) return existing;
  db.prepare(
    'INSERT INTO destructive_locks (user_id, until, reason, score_at_trip) VALUES (?,?,?,?)'
  ).run(userId, sqliteNow(LOCK_MINUTES * 60 * 1000), reason, score);
  console.warn(`[breaker] TRIPPED for user ${userId} (${userName || '?'}): score=${score}, reason=${reason}`);
  notifyTrip(db, userId, userName, score, reason);
  return activeLock(db, userId);
}

// Locks store UTC (like every DB timestamp) but every user of this ERP is
// IST — show them wall-clock time they can act on.
function istTimeStr(utcStr) {
  try {
    const d = new Date(utcStr.replace(' ', 'T') + 'Z');
    return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(11, 16) + ' IST';
  } catch { return utcStr; }
}

// In-flight guarded requests per user. The audit row that feeds scoreFor()
// only lands when a response FINISHES — so a parallel burst (a script
// firing 50 DELETEs at once) could sail past the threshold before a single
// completed row exists to count (adversarial-review find). Counting
// requests currently in flight closes that: request #k of a burst sees
// k-1 others already in flight and the gate trips at the threshold even
// with zero completed audit rows. Sequential legit use keeps inFlight at
// ~1 and is unaffected. In-memory (resets on restart) — the DB count is
// the durable floor, this is the burst supplement.
const _inFlight = new Map();

// The single check authMiddleware calls. Returns null to let the request
// through, or { status, body } for the middleware to send.
function guardCheck(req, res) {
  try {
    if (process.env.ERP_DISABLE_BREAKER === '1') return null;
    if (!req.user?.id) return null;
    if (!isGuarded(req)) return null;
    const db = getDb();
    ensureTables(db);
    const uid = req.user.id;

    const lock = activeLock(db, uid);
    if (lock) {
      return {
        status: 429,
        body: {
          error: `Destructive actions are temporarily locked for your account (too many delete/terminate/approve actions in a short time). The lock lifts automatically at ${istTimeStr(lock.until)}, or an admin can unlock you sooner.`,
          reason: 'destructive_lock',
          locked_until: lock.until,
        },
      };
    }

    const inFlight = _inFlight.get(uid) || 0;
    const score = scoreFor(db, uid) + inFlight;
    if (score >= tripThreshold()) {
      const l = tripNow(db, uid, req.user.name, score,
        `${score} destructive action(s) in ${WINDOW_MINUTES} min via ${req.method} ${(req.originalUrl || '').split('?')[0]}`);
      return {
        status: 429,
        body: {
          error: `Destructive actions locked: ${score} delete/terminate/approve action(s) in ${WINDOW_MINUTES} minutes is above the safety limit. Locked for ${LOCK_MINUTES} minutes (until ${istTimeStr(l?.until || '')}); admins have been notified.`,
          reason: 'destructive_lock',
          locked_until: l?.until,
        },
      };
    }

    // Allowed through — track it until the response completes (by then the
    // audit row exists and takes over the counting).
    if (res) {
      _inFlight.set(uid, inFlight + 1);
      let done = false;
      const release = () => {
        if (done) return; done = true;
        const n = (_inFlight.get(uid) || 1) - 1;
        if (n <= 0) _inFlight.delete(uid); else _inFlight.set(uid, n);
      };
      res.on('finish', release);
      res.on('close', release);
    }
    return null;
  } catch (e) {
    // Fail-open, loudly (see header note).
    console.error('[breaker] guardCheck failed (failing open):', e.message);
    return null;
  }
}

// Routes report weighted destructive work AFTER it succeeds (only the
// handler knows one call marked 22 days or approved 40 payments).
function addScore(userId, weight, kind) {
  try {
    if (process.env.ERP_DISABLE_BREAKER === '1') return;
    if (!userId || !(weight > 0)) return;
    const db = getDb();
    ensureTables(db);
    db.prepare('INSERT INTO breaker_events (user_id, weight, kind) VALUES (?,?,?)')
      .run(userId, Math.round(weight), kind || null);
  } catch (e) { console.error('[breaker] addScore failed:', e.message); }
}

function unlock(userId, byUser) {
  const db = getDb();
  ensureTables(db);
  const r = db.prepare(
    'UPDATE destructive_locks SET unlocked_by = ?, unlocked_at = ? WHERE user_id = ? AND unlocked_at IS NULL AND until > ?'
  ).run(byUser?.id || null, sqliteNowMs(), userId, sqliteNow());
  if (r.changes > 0) {
    console.warn(`[breaker] user ${userId} unlocked by ${byUser?.name || byUser?.id || '?'}`);
    setImmediate(async () => {
      try {
        const { sendEmail, getEmailConfig } = require('./email');
        const director = getEmailConfig().director;
        const who = db.prepare('SELECT name FROM users WHERE id=?').get(userId)?.name || `user #${userId}`;
        if (sendEmail && director) {
          await sendEmail({
            to: director,
            subject: `[SEPL ERP] Destructive-action lock cleared for ${who}`,
            text: `${byUser?.name || 'An admin'} unlocked destructive actions for ${who} before the timer expired.`,
          });
        }
      } catch (e) { console.warn('[breaker] unlock email failed:', e.message); }
    });
  }
  return r.changes;
}

function listLocks() {
  const db = getDb();
  ensureTables(db);
  return db.prepare(
    `SELECT l.*, u.name AS user_name, u.username, ub.name AS unlocked_by_name,
            CASE WHEN l.unlocked_at IS NULL AND l.until > ? THEN 1 ELSE 0 END AS is_active
       FROM destructive_locks l
       LEFT JOIN users u ON u.id = l.user_id
       LEFT JOIN users ub ON ub.id = l.unlocked_by
      ORDER BY l.id DESC LIMIT 50`
  ).all(sqliteNow());
}

module.exports = {
  guardCheck, addScore, tripNow, unlock, listLocks,
  // exported for tests
  scoreFor, activeLock, isGuarded, tripThreshold, WINDOW_MINUTES, LOCK_MINUTES,
};
