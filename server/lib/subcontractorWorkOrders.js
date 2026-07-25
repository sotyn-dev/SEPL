// Shared helper: which sites a sub-contractor has an ACTIVE Work Order for.
//
// Director ask (2026-07-25 follow-up): "sub contractor attendance must be
// linked with work order given to contractor, no work order no attendance."
// Work Orders (proj_work_orders) are already the authoritative record of a
// sub-contractor's engagement — attendance access is derived from them
// rather than a separate manual site-assignment step.
//
// proj_work_orders links to proj_projects by project_id; proj_projects has
// no direct FK to `sites`, so we bridge by name — the same pattern already
// used across the app (business_book.project_name ↔ sites.name, see
// routes/dpr.js GET /sites/:site_id/po-items).
//
// Used by both routes/subcontractorAttendance.js (the subcontractor's own
// gate) and routes/subcontractors.js (the admin-facing read view).
function sitesWithActiveWorkOrder(db, subContractorId) {
  return db.prepare(`
    SELECT DISTINCT s.id as site_id, s.name as site_name, wo.wo_number, wo.id as work_order_id
      FROM proj_work_orders wo
      JOIN proj_projects p ON p.id = wo.project_id
      JOIN sites s ON (
        TRIM(LOWER(s.name)) = TRIM(LOWER(p.name))
        OR EXISTS (
          SELECT 1 FROM business_book bb
           WHERE bb.id = s.business_book_id
             AND TRIM(LOWER(bb.project_name)) = TRIM(LOWER(p.name))
        )
      )
     WHERE wo.sub_contractor_id = ?
       AND wo.status = 'active'
     ORDER BY s.name
  `).all(subContractorId);
}

module.exports = { sitesWithActiveWorkOrder };
