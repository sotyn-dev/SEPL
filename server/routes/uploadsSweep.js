// Admin-only API for the scoped uploads orphan-sweep.
//
// Endpoints:
//   GET  /api/admin/uploads/sweep/preview  -> dry-run: what WOULD be restored/
//                                             quarantined/purged (no changes)
//   POST /api/admin/uploads/sweep          -> run it for real
//
// The sweep only ever touches the site-chat / help-tickets upload subfolders.

const express = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { runSweep } = require('../scripts/sweep-uploads');

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

module.exports = router;
