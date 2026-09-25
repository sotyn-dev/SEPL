const jwt = require('jsonwebtoken');
const { getDb } = require('../db/schema');

// JWT signing/verification secret — resolved ONCE and PERSISTED so it stays
// identical across every restart and redeploy. It used to be read inline as
// `process.env.JWT_SECRET || 'default'` at module load; if a restart didn't
// load .env (pm2 caches the env from the first `pm2 start`, or a boot fell
// back to the default), the effective secret FLIPPED and every already-issued
// token instantly became "Invalid token" → users were logged out after each
// deploy (mam, repeatedly). We now store the secret in app_settings on first
// boot and read it back forever, so the secret can never change underneath
// live sessions, no matter how the process is started.
let _secret = null;
function getSecret() {
  if (_secret) return _secret;
  const seed = process.env.JWT_SECRET || 'erp-secret-key-change-in-production';
  try {
    const db = getDb();
    db.exec('CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)');
    const row = db.prepare("SELECT value FROM app_settings WHERE key='jwt_secret'").get();
    if (row && row.value) { _secret = row.value; return _secret; }
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('jwt_secret', ?)").run(seed);
    _secret = seed;
    return _secret;
  } catch (_) {
    // DB not ready yet — use the seed for now and DON'T memoize, so the next
    // call (once the DB is up) persists and locks it in.
    return seed;
  }
}

// ── Zero-logout key rotation (mam 2026-08-17 "NOT DO IT EVERYONE") ──────────
// The jwt_secret was rotated away from the public default. Instead of forcing
// the whole company to re-login, tokens signed with an OLD secret stay valid
// during a short grace window and are SILENTLY re-issued under the new secret
// via the existing X-Refresh-Token header the client already swaps in. After
// the window, legacy signatures die for good (dormant/forged tokens included).
//
// 2026-08-19 — mass-logout loop root cause: rotate-jwt-secret.sh mints a NEW
// RANDOM secret every run. If it ran more than once, tokens signed with an
// in-between random secret ("the unrecoverable middle-generation key") match
// NEITHER the current secret NOR the single hard-coded public default this
// bridge used to know — so those users 401 on every request and the client's
// instant /auth/me probe logs them straight back out, again and again.
//
// Fix: accept a LIST of legacy secrets, not one. Sources, in order:
//   1. app_settings.jwt_legacy_secrets  (comma/newline-separated) — the RELIABLE
//      source: a DB row survives pm2's env caching (the same reason getSecret()
//      trusts the DB over .env). This is how a RANDOM old secret is fed back in
//      WITHOUT hard-coding it — on the VPS the rotation script left each old
//      value in .env.bak-*; drop them into this row and every stuck session
//      migrates to the current secret with ZERO logout. See recover-jwt-sessions.sh.
//   2. env JWT_LEGACY_SECRETS  (comma-separated) — belt-and-suspenders.
//   3. the KNOWN in-repo secrets prod may have run on before the first rotation.
// The current secret is never treated as legacy. A token matching none still dies.
//
// Two windows, because an in-repo secret is PUBLICLY KNOWN (forgeable) while a
// rotated random secret is not:
//   • known in-repo secrets → accepted only until PUBLIC_DEFAULT_UNTIL (kept tight
//     — the whole point of rotating was to close that forgery hole).
//   • recovered random secrets (DB/env) → accepted until RECOVERED_UNTIL, a bit
//     longer, so weekly/dormant users still migrate silently. Safe: not public.
//
// PUBLIC_LEGACY_SECRETS lists EVERY signing secret that has ever appeared in the
// repo, because the original single-value bridge (a69ee976) only knew the code
// default and prod actually ran on the .env value 'sepl-erp-secret-key-2026'
// (len 24) before the 2026-08-17 rotation — so pre-rotation tokens were NOT being
// bridged. Both are listed now; whichever prod really used, those tokens migrate.
const PUBLIC_LEGACY_SECRETS = [
  'erp-secret-key-change-in-production',   // getSecret() hard-coded seed / local-dev value (len 35)
  'sepl-erp-secret-key-2026',              // deploy-vps.sh .env — prod's pre-rotation secret (len 24)
];
// 2026-08-24 — CLOSED EARLY (security incident). Both secrets in
// PUBLIC_LEGACY_SECRETS are committed in this repo, so anyone who can read the
// source can MINT a valid admin token for the live ERP for as long as they are
// accepted. That is a forged-token path into production, and it was still open
// today. Set to a past date = these signatures are dead now. Only the recovered
// RANDOM secrets (not public, therefore not forgeable) keep their window.
// Cost: a session last used before the 2026-08-17 rotation needs one re-login.
// Anyone who has opened the ERP since then was silently re-signed already.
const PUBLIC_DEFAULT_UNTIL = '2026-08-23';   // IST, inclusive — expired on purpose
const RECOVERED_UNTIL = '2026-08-31';        // IST, inclusive — non-public old secrets

function istDateStr() { return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10); }

let _legacyCache = null, _legacyCacheAt = 0;
// Returns [{ secret, until }] — every accepted-legacy secret with its own deadline.
function legacySecrets() {
  // Re-read at most once a minute so a fresh app_settings write (during recovery)
  // takes effect without a restart, but we don't hit the DB on every request.
  const now = Date.now();
  if (_legacyCache && (now - _legacyCacheAt) < 60000) return _legacyCache;
  const recovered = [];
  const add = (raw) => { if (!raw) return; for (const s of String(raw).split(/[,\n]/)) { const v = s.trim(); if (v) recovered.push(v); } };
  try {
    const row = getDb().prepare("SELECT value FROM app_settings WHERE key='jwt_legacy_secrets'").get();
    add(row && row.value);
  } catch (_) { /* DB not ready — env + default below still apply */ }
  add(process.env.JWT_LEGACY_SECRETS);
  const cur = getSecret();
  const list = [];
  for (const s of new Set(recovered)) if (s && s !== cur) list.push({ secret: s, until: RECOVERED_UNTIL });
  for (const s of PUBLIC_LEGACY_SECRETS) if (s !== cur) list.push({ secret: s, until: PUBLIC_DEFAULT_UNTIL });
  _legacyCache = list;
  _legacyCacheAt = now;
  return _legacyCache;
}

function verifyToken(token) {
  try { return { decoded: jwt.verify(token, getSecret()), legacy: false }; }
  catch (e) {
    if (e && e.name === 'JsonWebTokenError') {
      const today = istDateStr();
      for (const { secret, until } of legacySecrets()) {
        if (today > until) continue;                 // this secret's window has closed
        // Same expiry rules apply — only the signature check uses the old key.
        try { return { decoded: jwt.verify(token, secret), legacy: true }; }
        catch (_) { /* signature didn't match this one — try the next */ }
      }
    }
    throw e;
  }
}

// ── Live session enforcement (2026-08-24 security incident) ────────────────
// Until today the ONLY thing a request was checked against was the JWT
// SIGNATURE. Everything else — id, name, and critically `role` — was read
// straight out of the token and trusted. That meant a session could not be
// ended by anything the product offers:
//   • deactivate the account (active=0) → token keeps working
//   • archive the account               → token keeps working
//   • demote admin → user               → token still says "admin"
//   • reset / change the password       → token keeps working
//   • DELETE the user row               → token keeps working (nothing looked
//                                         the user up at all)
// and because the sliding refresh below re-issues the token on every request,
// an attacker who was logged in once stayed logged in indefinitely. "Disable
// the user" was cosmetic.
//
// So: re-check the account on every request. To keep this off the hot path it
// is cached per user for 30s — one small indexed read per user per 30s, not
// one per request (this DB is synchronous better-sqlite3; a per-request read
// on every endpoint is exactly the kind of thing that turns into a hang).
//
// FAIL-OPEN by design. If the lookup throws for any reason (DB busy, column
// missing on an un-migrated copy) we keep the token's own claims and let the
// request through. A logout storm caused by a database hiccup would be worse
// than the thing we are defending against, and mam's standing rule is that an
// unexplained auto-logout is never acceptable.
const SESSION_CACHE_MS = 30 * 1000;
const _sessionCache = new Map();

function sessionState(userId) {
  const now = Date.now();
  const hit = _sessionCache.get(userId);
  if (hit && (now - hit.at) < SESSION_CACHE_MS) return hit.state;
  let state;
  try {
    const row = getDb().prepare(
      `SELECT id, role, COALESCE(active, 1) AS active, COALESCE(archived, 0) AS archived,
              token_revoked_at, must_change_password
         FROM users WHERE id = ?`
    ).get(userId);
    state = row
      ? { ok: true, role: row.role, active: row.active, archived: row.archived, revokedAt: row.token_revoked_at || 0, mustChangePassword: !!row.must_change_password }
      : { ok: true, missing: true };
  } catch (_) {
    state = null;   // unknown → fail open (see note above); don't cache a failure
    _sessionCache.delete(userId);
    return state;
  }
  _sessionCache.set(userId, { at: now, state });
  return state;
}

// Ends every live session for one user, immediately (within the 30s cache
// window, and instantly on this process since we drop the cache entry).
// Called whenever an account is disabled, archived, demoted, deleted, or has
// its password changed — and directly by the admin "Force logout" button.
function revokeUserSessions(userId, db) {
  const at = Math.floor(Date.now() / 1000);
  try {
    (db || getDb()).prepare('UPDATE users SET token_revoked_at = ? WHERE id = ?').run(at, userId);
  } catch (e) {
    console.error('[auth] revokeUserSessions failed:', e.message);
    return null;
  }
  _sessionCache.delete(Number(userId));
  return at;
}

// Drop a cached account snapshot so the next request re-reads it (used after
// any admin edit to a user, so a role change lands immediately rather than
// up to 30s later).
function clearSessionCache(userId) {
  if (userId == null) _sessionCache.clear();
  else _sessionCache.delete(Number(userId));
}

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1] || req.query.token;
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const { decoded, legacy } = verifyToken(token);
    // Pending TOTP tokens are only for POST /auth/login/totp (verified there).
    // Never treat them as a session, and never slide them into a 90-day JWT.
    if (decoded.totp_pending) {
      return res.status(401).json({ error: 'Authenticator code required' });
    }
    req.user = decoded;

    // Signature is good — but is this session still ALLOWED? (see the note on
    // sessionState above). Runs before any refresh below, so a revoked token
    // can never be rolled forward into a fresh one.
    const st = sessionState(decoded.id);
    if (st && st.ok) {
      if (st.missing) {
        return res.status(401).json({ error: 'Session ended', reason: 'account_removed' });
      }
      if (st.active === 0 || st.archived === 1) {
        return res.status(401).json({ error: 'Session ended', reason: 'account_disabled' });
      }
      if (st.revokedAt && (!decoded.iat || decoded.iat < st.revokedAt)) {
        return res.status(401).json({ error: 'Session ended', reason: 'session_revoked' });
      }
      // Authority comes from the DATABASE, never from the token. A demotion
      // from admin now takes effect on the next request instead of surviving
      // for the 90-day life of an already-issued token.
      req.user.role = st.role;
      if (st.mustChangePassword) {
        const endpoint = String(req.originalUrl || req.url).split('?')[0].replace(/\/$/, '');
        const allowed = (req.method === 'GET' && endpoint === '/api/auth/me') || (req.method === 'POST' && endpoint === '/api/auth/change-password');
        if (!allowed) return res.status(403).json({ error: 'Change your initial password before using the ERP', code: 'PASSWORD_CHANGE_REQUIRED' });
      }
    }

    // Destructive-action circuit breaker (2026-08-22/24 mass-delete incident).
    // Single wiring point: every guarded router runs through here, so the
    // spray defence can't be forgotten on a new route file. Returns 429 and
    // KEEPS the session — never a logout. See lib/destructiveBreaker.js.
    try {
      const blocked = require('../lib/destructiveBreaker').guardCheck(req, res);
      if (blocked) return res.status(blocked.status).json(blocked.body);
    } catch (e) { console.error('[auth] breaker check failed (failing open):', e.message); }

    if (legacy) {
      // Migrate on the spot: hand back a token signed with the NEW secret.
      // The client's response interceptor swaps it in automatically — the
      // user notices nothing.
      try {
        const fresh = generateToken(decoded);
        res.setHeader('X-Refresh-Token', fresh);
        res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
      } catch (_) { /* best-effort */ }
      return next();
    }
    // Sliding session (mam 2026-06-12: "after some time automatically logout
    // ... very bad"). While the user is active, keep handing back a fresh
    // token once the current one is more than a day old, so an active user
    // never gets logged out. Only a session idle for the full token lifetime
    // (7 days) expires. The client swaps the token in via the response header.
    try {
      const now = Math.floor(Date.now() / 1000);
      // Roll the token forward whenever it's more than a day old, so any active
      // user's token always sits ~90 days from expiry and a logout effectively
      // never happens (mam: "automatically logout — very bad"). 2026-06-26: a
      // synchronized cohort hit the old 7-day cliff together (60% logged out at
      // once) because the OOM crash-loop kept dropping the refresh response —
      // the cliff is now 90 days, so a missed refresh is survivable, not fatal.
      const TOKEN_LIFETIME_DAYS = 90;
      const REFRESH_WHEN_REMAINING_UNDER = (TOKEN_LIFETIME_DAYS - 1) * 24 * 60 * 60; // >1 day old → roll
      if (decoded.exp && (decoded.exp - now) < REFRESH_WHEN_REMAINING_UNDER) {
        const fresh = generateToken(decoded);
        res.setHeader('X-Refresh-Token', fresh);
        res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
      }
    } catch (_) { /* refresh is best-effort; never block the request */ }
    next();
  } catch (e) {
    // Diagnostic (mam 2026-06-25, "Nitin Jain logs in then logs out"): record
    // WHY a token was rejected so a real production logout can be traced to its
    // exact cause instead of guessed at:
    //   TokenExpiredError  → token genuinely aged past 7 days (sliding session
    //                        not reaching this user — e.g. a long-idle tab)
    //   JsonWebTokenError  → bad signature = the token was signed with a
    //                        DIFFERENT secret (a stale browser token from
    //                        before the secret was persisted) → one clean
    //                        re-login fixes it
    //   NotBeforeError     → clock skew between client and server
    // We decode (WITHOUT verifying) just to attach the embedded user id so the
    // log line names who it was. Only logged for the session check to avoid
    // noise from the many unauthenticated/probe requests.
    if (String(req.originalUrl || '').includes('/auth/me')) {
      let who = '?';
      try { who = (jwt.decode(token) || {}).id ?? '?'; } catch (_) { }
      console.warn(`[auth] /auth/me 401 — ${e.name || 'Error'}: ${e.message} | token.user=${who}`);
    }
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });
  next();
}

// Permission check middleware factory
function requirePermission(module, action) {
  return (req, res, next) => {
    // Admin role always has full access
    if (req.user.role === 'admin') return next();

    const db = getDb();
    // Get user's role permissions
    const perms = db.prepare(`
      SELECT rp.* FROM role_permissions rp
      JOIN user_roles ur ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = ?
    `).get(req.user.id, module);

    if (!perms) {
      return res.status(403).json({ error: `No access to ${module}` });
    }

    const actionMap = {
      view: 'can_view',
      create: 'can_create',
      edit: 'can_edit',
      delete: 'can_delete',
      approve: 'can_approve',
    };

    const field = actionMap[action];
    if (!field || !perms[field]) {
      return res.status(403).json({ error: `No ${action} permission for ${module}` });
    }

    next();
  };
}


// Get all permissions for a user (used by frontend)
function getUserPermissions(userId) {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id = ?').get(userId);

  if (user?.role === 'admin') {
    // Admin gets everything
    let modules = [
      'dashboard', 'leads', 'quotations', 'solar_quotation', 'orders', 'business_book', 'item_master', 'vendors', 'customers', 'procurement',
      'cashflow', 'collections', 'payment_required', 'attendance', 'indent_fms', 'dpr',
      'installation', 'billing', 'complaints', 'hr', 'payroll', 'employees', 'expenses', 'checklists', 'users', 'delegations', 'pms_tasks', 'inventory', 'scoring', 'gamification', 'tools', 'rentals', 'client_snag',
      // employee_salary: gates visibility of the salary field on GET /hr/employees.
      // hr_team: HR-team membership — gates hiring-request actions and the HR-alert
      // recipient group (cron). Both replace the fuzzy department/role "is HR" checks.
      // attendance_grid: gates viewing the Attendance Monthly Grid tab (marking needs attendance.can_approve).
      'employee_salary', 'hr_team', 'attendance_grid',
      // Drawing Tracker (2026-08). NOTE: this list is a separate hardcoded copy
      // from schema.js's ALL_MODULES and has drifted out of sync over time — a
      // new module must be added to BOTH or admin's frontend permission map
      // silently omits it (routes still work; the sidebar entry disappears).
      'drawing_tracker',
      // System Flow & ERP Implementation Control (2026-09)
      'system_flow',
      // Project Dashboard & PO Analytics (TSK-0819)
      'project_dashboard'
    ];
    // Drift fix (2026-09-01): the hardcoded copy above was 26 modules behind
    // schema.js's ALL_MODULES. The top-up loop in schema.js seeds EVERY module
    // into the Admin role's role_permissions rows, so union in what the DB
    // actually knows — admin's frontend permission map can no longer drift
    // when a new module ships. The list above stays as a safety net only.
    try {
      const rows = db.prepare('SELECT DISTINCT module FROM role_permissions').all();
      modules = [...new Set([...modules, ...rows.map(r => r.module)])];
    } catch (_) { /* pre-seed DB — fall back to the static list */ }
    const perms = {};
    for (const m of modules) {
      perms[m] = { can_view: 1, can_create: 1, can_edit: 1, can_delete: 1, can_approve: 1, can_see_all: 1 };
    }
    return perms;
  }

  const rows = db.prepare(`
    SELECT rp.module, rp.can_view, rp.can_create, rp.can_edit, rp.can_delete, rp.can_approve, rp.can_see_all
    FROM role_permissions rp
    JOIN user_roles ur ON rp.role_id = ur.role_id
    WHERE ur.user_id = ?
  `).all(userId);

  const perms = {};
  for (const r of rows) {
    if (!perms[r.module]) {
      perms[r.module] = { can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_see_all: 0 };
    }
    // Merge permissions (if user has multiple roles, take highest privilege)
    perms[r.module].can_view = perms[r.module].can_view || r.can_view;
    perms[r.module].can_create = perms[r.module].can_create || r.can_create;
    perms[r.module].can_edit = perms[r.module].can_edit || r.can_edit;
    perms[r.module].can_delete = perms[r.module].can_delete || r.can_delete;
    perms[r.module].can_see_all = perms[r.module].can_see_all || r.can_see_all;
    perms[r.module].can_approve = perms[r.module].can_approve || r.can_approve;
  }
  return perms;
}

function generateToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role, name: user.name },
    getSecret(),
    { expiresIn: '90d' }   // base lifetime; slides forward on activity (see authMiddleware)
  );
}

function generatePendingToken(user) {
  return jwt.sign(
    { id: user.id, totp_pending: true },
    getSecret(),
    { expiresIn: '5m' }
  );
}

// `SECRET` getter kept for back-compat (e.g. chatSocket) — always returns the
// one persisted secret.
module.exports = {
  authMiddleware, adminOnly, requirePermission, getUserPermissions, generateToken, generatePendingToken, getSecret,
  revokeUserSessions, clearSessionCache,
  get SECRET() { return getSecret(); },
};
