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

function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    const decoded = jwt.verify(token, getSecret());
    req.user = decoded;
    // Sliding session (mam 2026-06-12: "after some time automatically logout
    // ... very bad"). While the user is active, keep handing back a fresh
    // token once the current one is more than a day old, so an active user
    // never gets logged out. Only a session idle for the full token lifetime
    // (7 days) expires. The client swaps the token in via the response header.
    try {
      const now = Math.floor(Date.now() / 1000);
      const REFRESH_WHEN_REMAINING_UNDER = 6 * 24 * 60 * 60; // < 6 days left → token is >1 day old
      if (decoded.exp && (decoded.exp - now) < REFRESH_WHEN_REMAINING_UNDER) {
        const fresh = generateToken(decoded);
        res.setHeader('X-Refresh-Token', fresh);
        res.setHeader('Access-Control-Expose-Headers', 'X-Refresh-Token');
      }
    } catch (_) { /* refresh is best-effort; never block the request */ }
    next();
  } catch {
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
    const modules = [
      'dashboard','leads','quotations','solar_quotation','orders','business_book','item_master','vendors','customers','procurement',
      'cashflow','collections','payment_required','attendance','indent_fms','dpr',
      'installation','billing','complaints','hr','payroll','employees','expenses','checklists','users','delegations','pms_tasks','inventory','scoring','tools','rentals'
    ];
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
    { expiresIn: '7d' }   // base lifetime; slides forward on activity (see authMiddleware)
  );
}

// `SECRET` getter kept for back-compat (e.g. chatSocket) — always returns the
// one persisted secret.
module.exports = {
  authMiddleware, adminOnly, requirePermission, getUserPermissions, generateToken, getSecret,
  get SECRET() { return getSecret(); },
};
