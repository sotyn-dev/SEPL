'use strict';

// Platform audit — mirrors ERP server/middleware/audit.js.
// Records mutating API calls into platform_audit after the response finishes.
// Non-blocking; secrets redacted; never throws into the request path.

const { getDb } = require('./db');

const SECRET_KEYS = new Set([
  'password',
  'currentpassword',
  'current_password',
  'newpassword',
  'new_password',
  'token',
  'authorization',
  'secret',
  'agent_token',
  'agenttoken',
  'password_hash',
]);

const METHOD_TO_ACTION = {
  POST: 'CREATE',
  PUT: 'UPDATE',
  PATCH: 'UPDATE',
  DELETE: 'DELETE',
};

const SKIP_PATH_PREFIXES = [
  '/api/audit',
  '/api/auth/me',
  '/api/auth/login', // logged manually with LOGIN / LOGIN_FAIL
  '/api/health',
];

const AUDIT_DEBUG = process.env.PLATFORM_AUDIT_DEBUG === '1';
const dbg = (...args) => {
  if (AUDIT_DEBUG) console.log('[platform-audit]', ...args);
};

function summariseBody(body) {
  if (!body || typeof body !== 'object') return null;
  try {
    const safe = Array.isArray(body) ? body.slice() : { ...body };
    if (!Array.isArray(safe)) {
      for (const k of Object.keys(safe)) {
        if (SECRET_KEYS.has(k.toLowerCase().replace(/-/g, '_'))) safe[k] = '[REDACTED]';
        else if (SECRET_KEYS.has(k.toLowerCase().replace(/_/g, ''))) safe[k] = '[REDACTED]';
        else if (/password|token|secret/i.test(k)) safe[k] = '[REDACTED]';
      }
    }
    const str = JSON.stringify(safe);
    return str.length > 2000 ? `${str.slice(0, 2000)}…` : str;
  } catch {
    return '[unserialisable]';
  }
}

function entityTypeFromPath(p) {
  const m = p.replace(/^\/+/, '').split('/');
  if (m[0] === 'api' && m[1] === 'deploy' && m[2] === 'images') return 'images';
  if (m[0] === 'api' && m[1]) return m[1];
  if (m[0]) return m[0];
  return null;
}

function entityIdFromPath(p) {
  const parts = p.split('/').filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    if (/^\d+$/.test(parts[i])) return parts[i];
  }
  // Text ids / slugs: /api/tenants/:slug, /api/hosts/:id, /api/users/:id, /api/branding/:slug
  if (parts[0] === 'api' && ['tenants', 'hosts', 'users', 'branding'].includes(parts[1]) && parts[2]) {
    return parts[2];
  }
  if (parts[0] === 'api' && parts[1] === 'deploy' && parts[2] === 'images' && parts[3]) {
    return parts[3];
  }
  if (parts[0] === 'api' && parts[1] === 'deploy' && parts[2] === 'jobs' && parts[3]) {
    return parts[3];
  }
  return null;
}

function clientIp(req) {
  return (req.headers?.['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
}

function auditMiddleware(req, res, next) {
  try {
    if (process.env.PLATFORM_DISABLE_AUDIT === '1') {
      dbg('skip ENV flag');
      return next();
    }
    if (!req || !res || !req.method) return next();
    if (!METHOD_TO_ACTION[req.method]) {
      dbg('skip method', req.method);
      return next();
    }
    const url = req.originalUrl || req.url || '';
    if (SKIP_PATH_PREFIXES.some((p) => url.startsWith(p))) {
      dbg('skip path', url);
      return next();
    }

    const pathOnly = url.split('?')[0];
    dbg('scheduled', req.method, pathOnly);

    res.on('finish', () => {
      try {
        const db = getDb();
        if (!db) return;
        const user = req.platformUser || {};
        const safe = (v) => (v === undefined ? null : v);
        db.prepare(
          `INSERT INTO platform_audit
            (user_id, user_name, user_role, action, entity_type, entity_id,
             method, path, query, body_summary, status_code, ip, user_agent)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          safe(user.id) || null,
          safe(user.username) || null,
          safe(user.role) || null,
          safe(METHOD_TO_ACTION[req.method] || req.method),
          safe(entityTypeFromPath(pathOnly)),
          safe(entityIdFromPath(pathOnly)),
          safe(req.method),
          safe(pathOnly),
          req.query && Object.keys(req.query || {}).length ? JSON.stringify(req.query) : null,
          safe(summariseBody(req.body)),
          safe(res.statusCode) || null,
          clientIp(req),
          (req.headers?.['user-agent'] || '').toString().slice(0, 200) || null
        );
      } catch (e) {
        console.error('[platform-audit] insert failed:', e.message, 'path=', pathOnly);
      }
    });
  } catch (outerErr) {
    console.error('[platform-audit] middleware outer failure:', outerErr.message);
  }
  next();
}

/** Manual richer events (LOGIN, LOGIN_FAIL, SET_PASSWORD, …). */
function logAuditEvent(opts) {
  if (process.env.PLATFORM_DISABLE_AUDIT === '1') return;
  const {
    user,
    action,
    entity_type,
    entity_id,
    entity_label,
    before,
    after,
    method,
    path: reqPath,
    query,
    body,
    status_code,
    ip,
    user_agent,
  } = opts || {};
  try {
    getDb()
      .prepare(
        `INSERT INTO platform_audit
          (user_id, user_name, user_role, action, entity_type, entity_id, entity_label,
           method, path, query, body_summary, status_code, ip, user_agent,
           before_json, after_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        user?.id || null,
        user?.username || user?.name || null,
        user?.role || null,
        action || null,
        entity_type || null,
        entity_id != null ? String(entity_id) : null,
        entity_label || null,
        method || null,
        reqPath || null,
        query ? JSON.stringify(query) : null,
        body ? summariseBody(body) : null,
        status_code || null,
        ip || null,
        user_agent ? String(user_agent).slice(0, 200) : null,
        before
          ? (typeof before === 'string' ? before : JSON.stringify(before)).slice(0, 10000)
          : null,
        after
          ? (typeof after === 'string' ? after : JSON.stringify(after)).slice(0, 10000)
          : null
      );
  } catch (e) {
    console.error('[platform-audit] manual log failed:', e.message);
  }
}

module.exports = { auditMiddleware, logAuditEvent, clientIp };
