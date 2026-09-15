// Admin ▸ Performance — what is slow on THIS running server, right now.
//
// Hang audit 2026-09-05: the VPS log is the only place the hang detector's
// [slow]/[lag] lines used to go, and mam has no terminal access from the
// office. This serves the same data from memory so the page can show it:
// stalls, slow requests, the routes that cost the most blocking time, what is
// in flight this second, memory and DB size. Admin only; read only.
const express = require('express');
const fs = require('fs');
const path = require('path');
const router = express.Router();
const { authMiddleware, adminOnly } = require('../middleware/auth');
const hang = require('../lib/hangDetector');

router.use(authMiddleware, adminOnly);

router.get('/', (req, res) => {
  const snap = hang.snapshot();
  const mem = process.memoryUsage();
  let db_bytes = null, wal_bytes = null;
  try {
    const dbPath = process.env.ERP_DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
    db_bytes = fs.statSync(dbPath).size;
    try { wal_bytes = fs.statSync(dbPath + '-wal').size; } catch (_) { wal_bytes = 0; }
  } catch (_) { /* unreadable — leave null */ }
  let cache = null;
  try { cache = require('../lib/readCache').stats(); } catch (_) {}
  res.json({
    now: Date.now(),
    node: process.version,
    pid: process.pid,
    memory: { rss_mb: Math.round(mem.rss / 1048576), heap_used_mb: Math.round(mem.heapUsed / 1048576), heap_total_mb: Math.round(mem.heapTotal / 1048576) },
    db: { bytes: db_bytes, wal_bytes },
    cache,
    ...snap,
  });
});

// Start the counters again (e.g. after a deploy) without a restart.
router.post('/reset', (req, res) => {
  hang.reset();
  res.json({ message: 'Performance counters reset' });
});

module.exports = router;
