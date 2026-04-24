// Audit middleware — runs AFTER authMiddleware (so req.user is set) and
// records every mutating request (POST / PUT / PATCH / DELETE) into the
// audit_log table once the response is finished.
//
// Design notes:
//  - Non-blocking: logging is fire-and-forget so request latency is unchanged.
//  - Secret stripping: fields named password / token / authorization in the
//    body are redacted before being summarised.
//  - Auto-derives action from the HTTP method if the route doesn't set one.
//  - Helper `logAuditEvent()` lets routes record richer context manually
//    (e.g. before/after snapshots, friendly entity labels).
//  - Auto-derives entity_type from the URL path (the segment after /api/).

const { getDb } = require('../db/schema');

const SECRET_KEYS = new Set(['password', 'current_password', 'new_password', 'token', 'authorization', 'secret']);

const METHOD_TO_ACTION = {
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

// Paths we don't want to flood the log with (high-frequency location pings,
// dashboard polls, etc.). Blacklist instead of whitelist so everything else
// gets recorded by default.
const SKIP_PATH_PREFIXES = [
  '/api/attendance/track-location',
  '/api/attendance/my-today',
  '/api/attendance/my-month',
  '/api/dashboard',           // heavy read; adds noise
  '/api/audit',               // don't log reading of the log itself
  '/api/upload',              // covered by the target POST that stores the url
  '/api/auth/me',
  '/api/auth/my-permissions',
];

function summariseBody(body) {
  if (!body || typeof body !== 'object') return null;
  try {
    const safe = Array.isArray(body) ? body.slice() : { ...body };
    if (!Array.isArray(safe)) {
      for (const k of Object.keys(safe)) {
        if (SECRET_KEYS.has(k.toLowerCase())) safe[k] = '[REDACTED]';
      }
    }
    const str = JSON.stringify(safe);
    return str.length > 2000 ? str.slice(0, 2000) + '…' : str;
  } catch (e) {
    return '[unserialisable]';
  }
}

function entityTypeFromPath(p) {
  // /api/orders/po/5/items -> 'po_items'?  no — keep it simple: second segment
  // /api/complaints/:id   -> 'complaints'
  // /api/auth/register    -> 'auth'
  const m = p.replace(/^\/+/, '').split('/');
  if (m[0] === 'api' && m[1]) return m[1];
  if (m[0]) return m[0];
  return null;
}

function entityIdFromPath(p) {
  // Try to pull a numeric id from the last numeric segment.
  const parts = p.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  return null;
}

function auditMiddleware(req, res, next) {
  // Only log mutating methods
  if (!METHOD_TO_ACTION[req.method]) return next();
  // Skip noisy / high-frequency paths
  if (SKIP_PATH_PREFIXES.some(p => req.originalUrl.startsWith(p))) return next();

  // Capture what we can right now (before the response happens)
  const startedAt = Date.now();
  const pathOnly = req.originalUrl.split('?')[0];

  res.on('finish', () => {
    // Don't log if the request wasn't authenticated — that just means an
    // anonymous hit on a public endpoint (e.g. /api/auth/login failure).
    // We still log successful logins via a manual call from the login route.
    try {
      const db = getDb();
      const user = req.user || {};
      db.prepare(
        `INSERT INTO audit_log
          (user_id, user_name, user_role, action, entity_type, entity_id,
           method, path, query, body_summary, status_code, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        user.id || null,
        user.name || null,
        user.role || null,
        METHOD_TO_ACTION[req.method] || req.method,
        entityTypeFromPath(pathOnly),
        entityIdFromPath(pathOnly),
        req.method,
        pathOnly,
        req.query && Object.keys(req.query).length ? JSON.stringify(req.query) : null,
        summariseBody(req.body),
        res.statusCode,
        (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null,
        (req.headers['user-agent'] || '').toString().slice(0, 200) || null,
      );
    } catch (e) {
      // Never let audit failures break the actual request flow
      console.error('[audit] insert failed:', e.message);
    }
  });
  next();
}

// Manual call for routes that want to log richer info (labels, before/after
// snapshots, custom actions like 'APPROVE' / 'REJECT' / 'LOGIN_FAIL' etc.).
function logAuditEvent({
  user, action, entity_type, entity_id, entity_label,
  before, after, method, path, query, body, status_code, ip, user_agent,
}) {
  try {
    getDb().prepare(
      `INSERT INTO audit_log
        (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
         method, path, query, body_summary, status_code, ip, user_agent,
         before_json, after_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      user?.id || null,
      user?.name || null,
      user?.role || null,
      action || null,
      entity_type || null,
      entity_id != null ? String(entity_id) : null,
      entity_label || null,
      method || null,
      path || null,
      query ? JSON.stringify(query) : null,
      body ? summariseBody(body) : null,
      status_code || null,
      ip || null,
      user_agent ? user_agent.slice(0, 200) : null,
      before ? (typeof before === 'string' ? before : JSON.stringify(before)).slice(0, 10000) : null,
      after ? (typeof after === 'string' ? after : JSON.stringify(after)).slice(0, 10000) : null,
    );
  } catch (e) {
    console.error('[audit] manual log failed:', e.message);
  }
}

module.exports = { auditMiddleware, logAuditEvent };
