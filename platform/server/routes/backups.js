'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { getSecret } = require('./auth');
const { requireAdmin } = require('./users');
const { runBackup, listBackups, BACKUP_DIR, KEEP_COUNT } = require('../lib/backup');

const router = express.Router();

const ZIP_RE = /^platform-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/;

/**
 * Download with Authorization header OR ?token= (browser <a> navigation).
 * Mounted BEFORE global requireAuth in index.js.
 */
async function downloadHandler(req, res) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    || String(req.query.token || '');
  let decoded;
  try {
    decoded = jwt.verify(token, getSecret(), { issuer: 'sotyn-platform' });
  } catch {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  if (decoded.aud !== 'platform') {
    return res.status(401).json({ error: 'Invalid token audience' });
  }

  const { getDb } = require('../lib/db');
  const user = getDb().prepare(
    'SELECT id, role, active FROM platform_users WHERE id = ?'
  ).get(decoded.sub);
  if (!user || !user.active || user.role !== 'platform_admin') {
    return res.status(403).json({ error: 'platform_admin required' });
  }

  const file = req.params.file;
  if (!ZIP_RE.test(file)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) {
    return res.status(404).json({ error: 'Backup not found' });
  }
  return res.download(full, file);
}

router.get('/', requireAdmin, (_req, res) => {
  res.json({
    backup_dir: BACKUP_DIR,
    keep: KEEP_COUNT,
    backups: listBackups(),
  });
});

router.post('/run', requireAdmin, async (_req, res) => {
  try {
    const r = await runBackup({ silent: true });
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = { router, downloadHandler };
