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
const { computeCmdDetail } = require('../utils/cmdDashboard');

const router = express.Router();
router.use(authMiddleware);

// GET /api/dashboards/pending-approvals — one consolidated inbox of every
// place in the ERP awaiting an approval, so the CMD/MD acts from one screen
// instead of hunting tab-by-tab (mam 2026-06-23). Counts are ERP-wide
// (admin sees all); delegations are scoped to the signed-in approver.
router.get('/pending-approvals', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const safe = (sql, ...a) => { try { return db.prepare(sql).get(...a)?.c || 0; } catch (_) { return 0; } };
  const items = [
    { key: 'indents', label: 'Indent Approval', icon: '📋',
      count: safe("SELECT COUNT(*) c FROM indents WHERE status IN ('submitted','l1_approved','crm_approved')"),
      link: '/procurement?tab=indents' },
    { key: 'vendor_po', label: 'Vendor PO Approval', icon: '🧾',
      count: safe("SELECT COUNT(*) c FROM vendor_pos WHERE po_approval IN ('pending_l1','pending_l2')"),
      link: '/procurement?tab=vendorpo' },
    { key: 'payment', label: 'Payment Approval', icon: '💸',
      count: safe("SELECT COUNT(*) c FROM payment_requests WHERE status NOT IN ('final_approved','rejected')"),
      link: '/payment-required' },
    { key: 'dpr', label: 'DPR Approval', icon: '📝',
      count: safe("SELECT COUNT(*) c FROM dpr WHERE approval_status='pending'"),
      link: '/dpr' },
    { key: 'delegation', label: 'Delegation Sign-off', icon: '✅',
      count: safe("SELECT COUNT(*) c FROM delegations WHERE assigned_by=? AND status='submitted'", uid),
      link: '/delegations' },
  ];
  res.json({ items, total: items.reduce((s, x) => s + x.count, 0) });
});

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

// GET /api/dashboards/cmd-detail?days=N — extended payload for both
// CMD dashboard pages (Stage 1 Operating Console, Stage 2 TOC View).
// Single fetch feeds every section so the page loads in one round-trip.
router.get('/cmd-detail', adminOnly, (req, res) => {
  try {
    res.json(computeCmdDetail(getDb(), req.query.days));
  } catch (e) {
    console.error('[dashboards/cmd-detail] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
