// Admin-only API for database backups.
//
// Endpoints:
//   GET   /api/admin/backups              -> list backups (metadata only)
//   POST  /api/admin/backups/run          -> trigger a backup right now
//   GET   /api/admin/backups/:file/download -> stream a backup file

const express = require('express');
const path = require('path');
const fs = require('fs');
const jwt = require('jsonwebtoken');
const { authMiddleware, adminOnly, getSecret } = require('../middleware/auth');
const {
  runBackup, listBackups, BACKUP_DIR,
  backupS3Enabled, listOffsite, presignOffsite,
} = require('../scripts/backup-db');

const router = express.Router();

// Stream a backup file so admin can pull it onto their laptop. Guarded: only
// filenames matching the standard backup pattern are served, so this can't read
// arbitrary files from the VPS.
//
// This route has its OWN auth (Authorization header OR ?token= query param) and
// is declared BEFORE the global authMiddleware. That lets the browser download
// the file via a plain navigation — streaming the (large, 150+ MB) .db straight
// to disk — instead of the page pulling the whole file into an in-memory blob,
// which was failing on big backups (mam 2026-06-29: "not able to download").
// Query-token acceptance is scoped to THIS endpoint only.
router.get('/:file/download', async (req, res) => {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || String(req.query.token || '');
  let user;
  try { user = jwt.verify(token, getSecret()); }
  catch (e) { return res.status(401).json({ error: 'Unauthorized' }); }
  if (!user || user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' });

  const file = req.params.file;
  // New unified archive, plus legacy erp-/chat-/sotynflow- .db files still on disk.
  const ok = /^backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/.test(file)
    || /^(erp|chat|sotynflow)-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(file);
  if (!ok) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const full = path.join(BACKUP_DIR, file);
  // Prefer the local copy — same streaming behaviour as before, no egress cost.
  if (fs.existsSync(full)) return res.download(full, file);

  // Rotated off local disk but still offsite: hand the browser a short-lived
  // presigned URL so the bucket serves it directly, instead of proxying hundreds
  // of MB back through this 1-2 GB box.
  if (backupS3Enabled()) {
    try {
      const url = await presignOffsite(file);
      return res.redirect(302, url);
    } catch (e) {
      return res.status(502).json({ error: `Offsite download failed: ${e.message}` });
    }
  }
  return res.status(404).json({ error: 'Backup not found' });
});

// Everything below is admin-only via the standard header auth.
router.use(authMiddleware);
router.use(adminOnly);

router.get('/', async (req, res) => {
  const local = listBackups();
  // When BACKUP_S3 is off this is [] and the payload is byte-for-byte what the page
  // has always received, so the UI is unchanged for anyone not using offsite backups.
  const offsite = await listOffsite();

  // Merge on filename: the same archive normally exists in BOTH places, and showing
  // it twice would read as duplicate backups rather than one backup safely in two
  // locations. `source` is what the page badges.
  const byName = new Map();
  for (const b of local) byName.set(b.filename, { ...b, source: 'local' });
  for (const b of offsite) {
    const hit = byName.get(b.filename);
    if (hit) hit.source = 'both';
    else byName.set(b.filename, { ...b, source: 's3' });
  }
  const backups = [...byName.values()].sort((a, b) => b.created_at.localeCompare(a.created_at));

  res.json({ backup_dir: BACKUP_DIR, s3_enabled: backupS3Enabled(), backups });
});

router.post('/run', async (req, res) => {
  try {
    const r = await runBackup({ silent: true });
    if (!r.ok) return res.status(500).json({ error: r.error });
    res.status(201).json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
