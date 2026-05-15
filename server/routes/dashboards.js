// In-app role dashboards — TOC v3 P1 #2.
//
// Same JSON shape as /audit/kpi but authenticated via the user's
// normal JWT session (no bearer token needed) and gated to admin.
// This is what the React dashboard pages call.
//
// Going forward each role-specific dashboard (CMD / COO / Sales /
// Finance) reads from this single endpoint and renders only the
// slices that role is supposed to see — RBAC filtering happens in
// the frontend layout, not in the data feed, so the four pages
// stay in sync with the single source of truth.

const express = require('express');
const { authMiddleware, adminOnly } = require('../middleware/auth');
const { getDb } = require('../db/schema');
const { computeKpiPayload } = require('./auditReport');

const router = express.Router();
router.use(authMiddleware);

// GET /api/dashboards/kpi?days=N — same payload as /audit/kpi.
// Admin-gated until the RBAC rollout (TOC v3 P1 #1) defines the
// five canonical roles; at that point this loosens to allow any
// authenticated user, with field-level masking by role.
router.get('/kpi', adminOnly, (req, res) => {
  try {
    res.json(computeKpiPayload(getDb(), req.query.days));
  } catch (e) {
    console.error('[dashboards/kpi] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
