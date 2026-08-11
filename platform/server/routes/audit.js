'use strict';

// Admin audit log API — mirrors ERP server/routes/audit.js against platform_audit.

const express = require('express');
const { getDb } = require('../lib/db');

const router = express.Router();

const CACHE_MS = 60 * 1000;
let _metaCache = { at: 0, data: null };
let _countCache = { at: 0, total: null };

// GET /api/audit
router.get('/', (req, res) => {
  const db = getDb();
  const { user_id, entity_type, action, date_from, date_to, q } = req.query;
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const offset = (page - 1) * limit;

  const where = [];
  const params = [];
  if (user_id) {
    where.push('user_id = ?');
    params.push(String(user_id));
  }
  if (entity_type) {
    where.push('entity_type = ?');
    params.push(entity_type);
  }
  if (action) {
    where.push('action = ?');
    params.push(action);
  }
  if (date_from) {
    where.push('at >= ?');
    params.push(`${date_from} 00:00:00`);
  }
  if (date_to) {
    where.push('at <= ?');
    params.push(`${date_to} 23:59:59`);
  }
  if (q) {
    where.push('(path LIKE ? OR body_summary LIKE ? OR entity_label LIKE ? OR user_name LIKE ? OR entity_id LIKE ?)');
    const qp = `%${q}%`;
    params.push(qp, qp, qp, qp, qp);
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  let total;
  const noFilters = where.length === 0;
  if (noFilters && _countCache.total != null && Date.now() - _countCache.at < CACHE_MS) {
    total = _countCache.total;
  } else {
    total = db.prepare(`SELECT COUNT(*) AS c FROM platform_audit ${whereSql}`).get(...params).c;
    if (noFilters) _countCache = { at: Date.now(), total };
  }

  const rows = db
    .prepare(`SELECT * FROM platform_audit ${whereSql} ORDER BY at DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset);

  res.json({ total, page, limit, rows });
});

router.get('/meta', (_req, res) => {
  if (_metaCache.data && Date.now() - _metaCache.at < CACHE_MS) {
    return res.json(_metaCache.data);
  }
  const db = getDb();
  const users = db
    .prepare(
      `SELECT DISTINCT user_id, user_name FROM platform_audit
       WHERE user_id IS NOT NULL ORDER BY user_name`
    )
    .all();
  const entityTypes = db
    .prepare(
      `SELECT DISTINCT entity_type FROM platform_audit
       WHERE entity_type IS NOT NULL ORDER BY entity_type`
    )
    .all()
    .map((r) => r.entity_type);
  const actions = db
    .prepare(
      `SELECT DISTINCT action FROM platform_audit
       WHERE action IS NOT NULL ORDER BY action`
    )
    .all()
    .map((r) => r.action);
  const data = { users, entityTypes, actions };
  _metaCache = { at: Date.now(), data };
  res.json(data);
});

router.get('/:id', (req, res) => {
  const row = getDb().prepare('SELECT * FROM platform_audit WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  res.json(row);
});

module.exports = router;
