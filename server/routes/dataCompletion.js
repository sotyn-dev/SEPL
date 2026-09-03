// Data Completion endpoints (MD 2026-09-03).
//
// GET /api/data-completion/:module  -> the bar for one page
// GET /api/data-completion          -> every module rolled up (scorecard / admin view)
//
// Each module is gated by the SAME permission as the page it sits on, so the
// bar can never leak counts from a module the user cannot open. The roll-up is
// filtered to the modules the caller may actually see, so two people can get
// different totals — that is deliberate, and `modules` says what was counted.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, getUserPermissions } = require('../middleware/auth');
const { MODULES, completionFor, completionAll } = require('../lib/dataCompletion');

const router = express.Router();
router.use(authMiddleware);

// module key -> the permission module that guards its page
const PERM = {
  item_master: 'item_master',
  business_book: 'business_book',
  employees: 'employees',
  users: 'users',
};

const canView = (req, moduleKey) => {
  if (req.user?.role === 'admin') return true;
  try {
    const perms = getUserPermissions(req.user.id);
    return !!perms[PERM[moduleKey] || moduleKey]?.can_view;
  } catch (_) { return false; }
};

router.get('/', (req, res) => {
  try {
    const all = completionAll(getDb());
    const visible = all.modules.filter(m => canView(req, m.module));
    const required_total = visible.reduce((s, m) => s + m.required_total, 0);
    const filled_total = visible.reduce((s, m) => s + m.filled_total, 0);
    res.json({
      required_total,
      filled_total,
      pct: required_total ? Math.round((filled_total / required_total) * 1000) / 10 : 0,
      total_items: visible.reduce((s, m) => s + m.total_items, 0),
      complete_items: visible.reduce((s, m) => s + m.complete_items, 0),
      modules: visible,
      errors: all.errors,
    });
  } catch (e) {
    console.error('[data-completion] roll-up failed:', e.message);
    res.status(500).json({ error: 'Could not compute data completion' });
  }
});

router.get('/:module', (req, res) => {
  const key = req.params.module;
  if (!MODULES[key]) return res.status(404).json({ error: `Unknown module '${key}'` });
  if (!canView(req, key)) return res.status(403).json({ error: `No view permission for ${key}` });
  try {
    res.json(completionFor(getDb(), key));
  } catch (e) {
    console.error(`[data-completion] ${key} failed:`, e.message);
    res.status(500).json({ error: 'Could not compute data completion' });
  }
});

module.exports = router;
