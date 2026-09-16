// Admin-only audit log API. Query + filter the audit_log table populated by
// the auditMiddleware + manual logAuditEvent() calls.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, adminOnly } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

// The two O(table-size) operations on this page are the unfiltered total
// COUNT(*) and the /meta DISTINCT scans — both ran on every page load and, on
// a large audit_log (every mutating request is logged, so it grows fast),
// turned the page into a hang. The distinct filter values and the grand total
// change slowly, so cache both for a minute. The row LIST query itself is
// already index-backed (idx_audit_log_at) + LIMIT 50, so it stays live.
const CACHE_MS = 60 * 1000;
let _metaCache = { at: 0, data: null };
let _countCache = { at: 0, total: null };

// GET /api/admin/audit
// Filters: user_id, entity_type, action, date_from, date_to, q (free text),
// page (1-based), limit (default 50, max 500)
router.get('/', (req, res) => {
  const db = getDb();
  const { user_id, entity_type, action, date_from, date_to, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (user_id) { where.push('user_id = ?'); params.push(+user_id); }
  if (entity_type) { where.push('entity_type = ?'); params.push(entity_type); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (date_from) { where.push('at >= ?'); params.push(date_from + ' 00:00:00'); }
  if (date_to) { where.push('at <= ?'); params.push(date_to + ' 23:59:59'); }
  if (q) {
    where.push('(path LIKE ? OR body_summary LIKE ? OR entity_label LIKE ? OR user_name LIKE ?)');
    const qp = `%${q}%`;
    params.push(qp, qp, qp, qp);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
  // Cache only the UNFILTERED grand total (the expensive full-table count run
  // on every default page load). Filtered counts are narrower/indexed and vary
  // per query, so compute those live.
  let total;
  const noFilters = where.length === 0;
  if (noFilters && _countCache.total != null && (Date.now() - _countCache.at) < CACHE_MS) {
    total = _countCache.total;
  } else {
    total = db.prepare(`SELECT COUNT(*) as c FROM audit_log ${whereSql}`).get(...params).c;
    if (noFilters) _countCache = { at: Date.now(), total };
  }
  const rows = db.prepare(
    `SELECT * FROM audit_log ${whereSql} ORDER BY at DESC LIMIT ? OFFSET ?`
  ).all(...params, limit, offset);

  res.json({ total, page, limit, rows });
});

// Metadata for filter dropdowns — distinct values the UI can offer
router.get('/meta', (req, res) => {
  if (_metaCache.data && (Date.now() - _metaCache.at) < CACHE_MS) {
    return res.json(_metaCache.data);
  }
  const db = getDb();
  const users = db.prepare(
    `SELECT DISTINCT user_id, user_name FROM audit_log
     WHERE user_id IS NOT NULL ORDER BY user_name`
  ).all();
  const entityTypes = db.prepare(
    `SELECT DISTINCT entity_type FROM audit_log
     WHERE entity_type IS NOT NULL ORDER BY entity_type`
  ).all().map(r => r.entity_type);
  const actions = db.prepare(
    `SELECT DISTINCT action FROM audit_log
     WHERE action IS NOT NULL ORDER BY action`
  ).all().map(r => r.action);
  const data = { users, entityTypes, actions };
  _metaCache = { at: Date.now(), data };
  res.json(data);
});

// GET /api/admin/audit/suspicious — identity-mismatch detector (mam
// 2026-08-17: "users not use but changes show from their id").
// Flags mutations recorded under a user's id when:
//   - the request's DEVICE (user-agent, version numbers stripped so a
//     browser update doesn't false-flag) was never seen on any LOGIN
//     by that user, OR
//   - the user has no LOGIN row at all / none in the last 30 days.
// IP mismatch alone does NOT flag (mobile-data IPs rotate daily) but is
// appended as supporting context on already-flagged rows.
// MUST stay registered before '/:id' or Express eats it as an id.
router.get('/suspicious', (req, res) => {
  const db = getDb();
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 30));
  const normUA = (ua) => String(ua || '').replace(/[\d.]+/g, '').slice(0, 200);

  const loginRows = db.prepare(
    `SELECT user_id, ip, user_agent, at FROM audit_log
      WHERE action = 'LOGIN' AND user_id IS NOT NULL`
  ).all();
  const knownIPs = new Set(), knownUAs = new Set(), lastLogin = new Map();
  for (const l of loginRows) {
    if (l.ip) knownIPs.add(l.user_id + '|' + l.ip);
    if (l.user_agent) knownUAs.add(l.user_id + '|' + normUA(l.user_agent));
    const prev = lastLogin.get(l.user_id);
    if (!prev || l.at > prev) lastLogin.set(l.user_id, l.at);
  }

  const cutoff30 = new Date(Date.now() - 30 * 864e5).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(
    `SELECT * FROM audit_log
      WHERE at >= datetime('now', ?)
        AND user_id IS NOT NULL
        AND action NOT IN ('LOGIN', 'LOGIN_FAIL')
      ORDER BY at DESC LIMIT 3000`
  ).all(`-${days} days`);

  const flagged = [];
  for (const r of rows) {
    const reasons = [];
    if (r.user_agent && !knownUAs.has(r.user_id + '|' + normUA(r.user_agent)))
      reasons.push('device never seen at this user’s login');
    const ll = lastLogin.get(r.user_id);
    if (!ll) reasons.push('user has NO login on record');
    else if (ll < cutoff30) reasons.push('no login in the last 30 days');
    if (reasons.length) {
      if (r.ip && !knownIPs.has(r.user_id + '|' + r.ip)) reasons.push('IP also never seen at login');
      flagged.push({ ...r, suspect_reasons: reasons.join(' + ') });
    }
  }
  res.json({ days, scanned: rows.length, flagged: flagged.length, rows: flagged.slice(0, 500) });
});

// Single entry with the full before/after JSON (for a detail popover).
router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM audit_log WHERE id=?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
