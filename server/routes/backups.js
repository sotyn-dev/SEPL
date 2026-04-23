// Admin-only API for database backups.
//
// Endpoints:
//   GET   /api/admin/backups              -> list backups (metadata only)
//   POST  /api/admin/backups/run          -> trigger a backup right now
//   GET   /api/admin/backups/:file/download -> stream a backup file

const express = require('express');
const path = require('path');
const fs = require('fs');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { runBackup, listBackups, BACKUP_DIR } = require('../scripts/backup-db');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly); // Everything here is admin-only

router.get('/', (req, res) => {
  res.json({ backup_dir: BACKUP_DIR, backups: listBackups() });
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

// Stream a backup file so admin can pull it onto their laptop.
// Guarded: only filenames matching the standard backup pattern are served
// so this can't be abused to read arbitrary files from the VPS.
router.get('/:file/download', (req, res) => {
  const file = req.params.file;
  if (!/^erp-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.db$/.test(file)) {
    return res.status(400).json({ error: 'Invalid filename' });
  }
  const full = path.join(BACKUP_DIR, file);
  if (!fs.existsSync(full)) return res.status(404).json({ error: 'Backup not found' });
  res.download(full, file);
});

module.exports = router;
