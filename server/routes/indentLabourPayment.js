// Indent Labour Payment — full project execution + billing pipeline.
// Mam (2026-06-01) renamed the spec from "Project Execution & Billing"
// to "Indent Labour Payment".  This module COEXISTS with the simpler
// labour_payment module shipped earlier today (which stays put under
// /labour-payment).
//
// Plan (6 phases, each shippable + verifiable):
//   PHASE 1 (this file, today): schema + read-only Project list.
//   PHASE 2: Budget CRUD + Work Order CRUD.
//   PHASE 3: Muster Roll CRUD.
//   PHASE 4: DPR ↔ Work-Order linkage (one nullable column on
//            dpr_work_items, added in the schema block today).
//   PHASE 5: MB / CDPR generation + finalise/lock.
//   PHASE 6: Contractor RA Bill cycle (Raised → Payment → Paid) +
//            Client RA Bill cycle + Project Dashboard.
//
// Phase 6 needs answers to mam's open questions:
//   Q3 default deduction %s (Retention / TDS / Advance Recovery)
//   Q4 MB lock permission (Admin only?)
//   Q6 Salary feed source (Payroll auto-allocate vs manual tab)
//
// Schema strategy: REUSE business_book as the project record (Q1),
// REUSE dpr/dpr_work_items for daily work (Phase 4 only adds
// work_order_id), REUSE collections for client payments (Phase 6
// only adds proj_client_ra_bill_id), NEW tables for every entity
// without a natural existing home.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// ─── PHASE 1 · Projects (read-only) ─────────────────────────────
// Pulls every business_book row as a Project candidate; surfaces
// the new owner + legacy-cost ALTERs.  Search by company / client /
// project name keeps the page useful when the master swells.
router.get('/projects', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const { q, owner } = req.query;
  let sql = `
    SELECT bb.id,
           bb.company_name        AS project_name,
           bb.client_name         AS client_name,
           bb.category            AS category,
           bb.po_amount           AS po_amount,
           bb.committed_completion_date AS target_close,
           COALESCE(bb.owner, 'Aanchal')               AS owner,
           COALESCE(bb.project_kickoff_legacy_cost, 0) AS legacy_cost,
           bb.created_at          AS created_at,
           (SELECT COUNT(*) FROM proj_work_orders wo WHERE wo.project_id = bb.id) AS work_order_count,
           (SELECT COUNT(*) FROM proj_budgets    bud WHERE bud.project_id = bb.id) AS budget_lines_count
      FROM business_book bb
     WHERE 1=1
  `;
  const params = [];
  if (q) {
    sql += ` AND (LOWER(bb.company_name) LIKE ? OR LOWER(COALESCE(bb.client_name,'')) LIKE ? OR LOWER(COALESCE(bb.category,'')) LIKE ?)`;
    const like = `%${String(q).toLowerCase()}%`;
    params.push(like, like, like);
  }
  if (owner) {
    sql += ` AND COALESCE(bb.owner, 'Aanchal') = ?`;
    params.push(owner);
  }
  sql += ` ORDER BY bb.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

// ─── PHASE 1 · single project detail ────────────────────────────
// Header view used by every later-phase tab.  Read-only for now;
// edit endpoints (set owner / legacy cost) land in Phase 2 next to
// the Budget CRUD.
router.get('/projects/:id', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const row = db.prepare(`
    SELECT bb.id,
           bb.company_name        AS project_name,
           bb.client_name         AS client_name,
           bb.category            AS category,
           bb.po_amount           AS po_amount,
           bb.committed_completion_date AS target_close,
           COALESCE(bb.owner, 'Aanchal')               AS owner,
           COALESCE(bb.project_kickoff_legacy_cost, 0) AS legacy_cost,
           bb.created_at          AS created_at
      FROM business_book bb
     WHERE bb.id = ?
  `).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Project not found' });
  res.json(row);
});

// ─── PHASE 1 · owners list (for the filter dropdown) ────────────
// Returns the distinct owners currently assigned — keeps the UI
// free of stale options and surfaces the 'Aanchal' default at top.
router.get('/owners', requirePermission('indent_labour_payment', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT COALESCE(owner, 'Aanchal') AS owner, COUNT(*) AS project_count
      FROM business_book
     GROUP BY COALESCE(owner, 'Aanchal')
     ORDER BY (CASE WHEN COALESCE(owner,'Aanchal')='Aanchal' THEN 0 ELSE 1 END), owner
  `).all();
  res.json(rows);
});

module.exports = router;
