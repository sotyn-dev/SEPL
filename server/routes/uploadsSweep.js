// Admin-only API for uploads maintenance: the scoped orphan-sweep, and the
// move-to-S3 migration.
//
// Endpoints:
//   GET  /api/admin/uploads/sweep/preview     -> dry-run: what WOULD be restored/
//                                                quarantined/purged (no changes)
//   POST /api/admin/uploads/sweep             -> run it for real
//   GET  /api/admin/uploads/migrate/preview   -> what a migration would move (no changes)
//   POST /api/admin/uploads/migrate           -> start the migration in the background
//   GET  /api/admin/uploads/migrate/status    -> progress / last result
//
// The sweep only ever touches the site-chat / help-tickets / sotyn-flow subfolders.
// The migration covers every referenced file under uploads/, and is the thing that
// actually reclaims disk.

const express = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { runSweep } = require('../scripts/sweep-uploads');
const { runBackfill } = require('../scripts/backfill-uploads-s3');
const storage = require('../lib/storage');

const router = express.Router();
router.use(authMiddleware);
router.use(adminOnly);

router.get('/sweep/preview', async (req, res) => {
  try { res.json(await runSweep({ dryRun: true, silent: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/sweep', async (req, res) => {
  try { res.json(await runSweep({ dryRun: false, silent: true })); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Migration ───────────────────────────────────────────────────────────────────
// A migration can take minutes over thousands of files, far longer than an HTTP
// request should live — so POST starts it in the background and returns immediately,
// and progress is read from /migrate/status. Job state lives HERE, on the server, so
// the admin page can be closed and reopened without losing sight of a running job.
//
// Single-flight, mirroring the transcribeBusy guard in routes/delegations.js: a
// double-clicked button, or a manual run colliding with the 02:30 nightly, must never
// produce two passes marching over the same files.
const job = {
  running: false,
  startedAt: null,
  finishedAt: null,
  processed: 0,
  total: 0,
  deleteLocal: false,
  summary: null,
  error: null,
};

router.get('/migrate/preview', async (req, res) => {
  try {
    const r = await runBackfill({ commit: false, silent: true });
    res.json({ s3_enabled: storage.isRemote, driver: storage.DRIVER, ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.get('/migrate/status', (req, res) => {
  res.json({ s3_enabled: storage.isRemote, ...job });
});

router.post('/migrate', (req, res) => {
  if (!storage.isRemote) {
    return res.status(400).json({ error: 'STORAGE_DRIVER is not "s3" — nothing to migrate into.' });
  }
  if (job.running) {
    return res.status(409).json({ error: 'A migration is already running.', startedAt: job.startedAt });
  }

  const deleteLocal = req.body?.deleteLocal === true;

  job.running = true;
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.processed = 0;
  job.total = 0;
  job.deleteLocal = deleteLocal;
  job.summary = null;
  job.error = null;

  // Fire-and-forget: the response goes out now, the work continues. Every failure path
  // must clear `running`, or the guard would latch and block all future runs.
  runBackfill({
    commit: true,
    deleteLocal,
    silent: true,
    onProgress: ({ processed, total }) => { job.processed = processed; job.total = total; },
  })
    .then((summary) => { job.summary = summary; })
    .catch((e) => { job.error = e.message; console.error('[backfill] migration failed:', e.message); })
    .finally(() => { job.running = false; job.finishedAt = new Date().toISOString(); });

  res.status(202).json({ started: true, deleteLocal, startedAt: job.startedAt });
});

module.exports = router;
