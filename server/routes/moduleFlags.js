// Module availability API — the admin switch that turns a whole feature on/off
// for the organisation (see server/lib/features.js for why this is not RBAC and
// why the state lives in a JSON file rather than app_settings).
//
// GET  — any signed-in user. The client needs this to hide sidebar links and to
//        render the "switched off" screen (which interpolates the module label).
// PUT  — admin only. Flipping a flag takes effect immediately: the next request to
//        the module's own router hits requireModuleEnabled() and 404s.
const express = require('express');
const { authMiddleware } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { getModuleList, setModuleFlag, isModuleEnabled } = require('../lib/features');

const router = express.Router();
router.use(authMiddleware);

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// GET /api/module-flags → [{ key, label, description, offHint, enabled }]
// Deliberately readable by every signed-in user: it exposes nothing but which
// features exist and whether they are on — the same thing the sidebar shows.
router.get('/', (req, res) => {
  res.json({ modules: getModuleList() });
});

// PUT /api/module-flags/:key  { enabled: true|false }
router.put('/:key', adminOnly, (req, res) => {
  const { key } = req.params;
  const enabled = !!req.body?.enabled;
  const before = isModuleEnabled(key);
  try {
    setModuleFlag(key, enabled);
  } catch (e) {
    return res.status(400).json({ error: e.message });   // unknown / non-switchable module
  }

  logAuditEvent({
    user: req.user, action: enabled ? 'MODULE_ENABLE' : 'MODULE_DISABLE',
    entity_type: 'module', entity_id: key, entity_label: key,
    before: { enabled: before }, after: { enabled },
    method: req.method, path: req.originalUrl, status_code: 200,
    ip: req.ip, user_agent: req.get('user-agent'),
  });

  // Push the change to every connected client so an open tab reacts immediately
  // instead of waiting for its next window-focus refetch. Best-effort by design —
  // the socket layer is allowed to fail to start (see index.js), and the flag is
  // already persisted, so a missing socket only costs freshness, never correctness.
  try { require('../lib/chatSocket').getIO()?.emit('modules:changed'); } catch (_) {}

  res.json({ modules: getModuleList() });
});

module.exports = router;
