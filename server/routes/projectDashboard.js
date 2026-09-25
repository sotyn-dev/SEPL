const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

// Permission check: allow if user has project_dashboard, business_book, procurement, or admin
function canViewProjectDashboard(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const perms = req.user?.permissions || {};
  if (
    perms.project_dashboard?.can_view ||
    perms.business_book?.can_view ||
    perms.procurement?.can_view ||
    perms.orders?.can_view ||
    perms.dashboard?.can_view
  ) {
    return next();
  }
  return res.status(403).json({ error: 'Access denied to Project Dashboard' });
}

router.use(canViewProjectDashboard);

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Helper to find vendor POs linked to a project
function getProjectVpos(db, project) {
  const pName = (project.project_name || '').trim();
  const cName = (project.company_name || '').trim();
  const lNo = (project.lead_no || '').trim();
  const pId = project.id;

  return db.prepare(`
    SELECT vp.id, vp.po_number, vp.total_amount, vp.po_approval, vp.status,
           vp.po_date, vp.expected_receipt_date, vp.delay_reason, vp.created_at,
           vp.payment_terms, vp.credit_days,
           v.id AS vendor_id, v.name AS vendor_name,
           i.id AS indent_id, i.indent_number, i.site_name, i.lead_no AS indent_lead_no,
           COALESCE((SELECT COUNT(*) FROM grn g WHERE g.vendor_po_id = vp.id), 0) AS grn_count,
           COALESCE((SELECT SUM(pb.total_amount) FROM purchase_bills pb WHERE pb.vendor_po_id = vp.id), 0) AS billed_amount,
           COALESCE((SELECT SUM(pb.total_amount) FROM purchase_bills pb WHERE pb.vendor_po_id = vp.id AND pb.payment_status = 'paid'), 0) AS paid_amount
    FROM vendor_pos vp
    JOIN indents i ON i.id = vp.indent_id
    LEFT JOIN order_planning op ON op.id = i.planning_id
    LEFT JOIN purchase_orders cpo ON cpo.id = op.po_id
    LEFT JOIN vendors v ON v.id = vp.vendor_id
    WHERE COALESCE(vp.cancelled, 0) = 0
      AND (
        (op.business_book_id IS NOT NULL AND op.business_book_id = ?)
        OR (cpo.business_book_id IS NOT NULL AND cpo.business_book_id = ?)
        OR (i.lead_no IS NOT NULL AND i.lead_no != '' AND i.lead_no = ?)
        OR (i.site_name IS NOT NULL AND (
          (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
          OR (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
        ))
      )
    ORDER BY vp.id DESC
  `).all(pId, pId, lNo, pName, pName, cName, cName);
}

// ── GET /api/project-dashboard/projects ──────────────────────────────────
// Returns list of all projects with rollup procurement & PO statistics
router.get('/projects', (req, res) => {
  try {
    const db = getDb();
    const projects = db.prepare(`
      SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, bb.client_name,
             bb.district, bb.state, bb.status,
             COALESCE(bb.sale_amount_without_gst, bb.po_amount, 0) AS contract_value,
             bb.committed_delivery_date, bb.created_at
      FROM business_book bb
      ORDER BY bb.id DESC
    `).all();

    const todayStr = new Date().toISOString().slice(0, 10);

    const projectCards = projects.map(p => {
      const vpos = getProjectVpos(db, p);
      const totalPoSpend = round2(vpos.reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0));
      const approvedPos = vpos.filter(v => v.po_approval === 'approved');
      const pendingApprovalPos = vpos.filter(v => ['pending_l1', 'pending_l2'].includes(v.po_approval));
      const grnCompletedPos = vpos.filter(v => Number(v.grn_count) > 0);
      const overdueDeliveries = vpos.filter(v =>
        v.expected_receipt_date &&
        v.expected_receipt_date < todayStr &&
        Number(v.grn_count) === 0
      );

      const displayName = (p.project_name || '').trim() || (p.company_name || '').trim() || `Project #${p.id}`;

      return {
        id: p.id,
        name: displayName,
        lead_no: p.lead_no || `PRJ-${p.id}`,
        company_name: p.company_name,
        client_name: p.client_name,
        location: [p.district, p.state].filter(Boolean).join(', '),
        status: p.status || 'active',
        contract_value: round2(p.contract_value),
        committed_delivery_date: p.committed_delivery_date,
        po_count: vpos.length,
        total_po_spend: totalPoSpend,
        approved_po_count: approvedPos.length,
        pending_approval_count: pendingApprovalPos.length,
        grn_completed_count: grnCompletedPos.length,
        overdue_delivery_count: overdueDeliveries.length,
      };
    });

    // Macro KPIs across all projects
    const totalContractValue = round2(projectCards.reduce((s, p) => s + p.contract_value, 0));
    const totalPoSpend = round2(projectCards.reduce((s, p) => s + p.total_po_spend, 0));
    const totalPosCount = projectCards.reduce((s, p) => s + p.po_count, 0);
    const totalPendingApproval = projectCards.reduce((s, p) => s + p.pending_approval_count, 0);
    const totalOverdueDeliveries = projectCards.reduce((s, p) => s + p.overdue_delivery_count, 0);

    res.json({
      summary: {
        total_projects: projectCards.length,
        total_contract_value: totalContractValue,
        total_po_spend: totalPoSpend,
        total_pos_count: totalPosCount,
        total_pending_approval: totalPendingApproval,
        total_overdue_deliveries: totalOverdueDeliveries,
      },
      projects: projectCards,
    });
  } catch (err) {
    console.error('[project-dashboard/projects] error:', err.message);
    res.status(500).json({ error: 'Failed to fetch projects list: ' + err.message });
  }
});

// ── GET /api/project-dashboard/project/:id ───────────────────────────────
// Detailed Project 360° View + Deep Purchase Order Analytics
router.get('/project/:id', (req, res) => {
  try {
    const db = getDb();
    const projectId = +req.params.id;

    const project = db.prepare(`
      SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, bb.client_name,
             bb.client_contact, bb.client_email, bb.district, bb.state,
             bb.billing_address, bb.shipping_address, bb.status,
             bb.sale_amount_without_gst, bb.po_amount, bb.order_type,
             bb.committed_start_date, bb.committed_delivery_date,
             bb.penalty_clause, bb.penalty_clause_date, bb.created_at
      FROM business_book bb
      WHERE bb.id = ?
    `).get(projectId);

    if (!project) {
      return res.status(404).json({ error: 'Project not found' });
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const displayName = (project.project_name || '').trim() || (project.company_name || '').trim() || `Project #${project.id}`;
    const contractValue = round2(project.sale_amount_without_gst || project.po_amount || 0);

    // 1. Client POs
    const clientPos = db.prepare(`
      SELECT id, po_number, po_date, total_amount, advance_amount, status, created_at
      FROM purchase_orders
      WHERE business_book_id = ?
      ORDER BY id DESC
    `).all(projectId);

    // 2. Vendor POs & Line Items
    const vpos = getProjectVpos(db, project);
    const vpoIds = vpos.map(v => v.id);

    // Line items across all vendor POs for this project
    let poLineItems = [];
    if (vpoIds.length > 0) {
      const placeholders = vpoIds.map(() => '?').join(',');
      poLineItems = db.prepare(`
        SELECT vpi.id, vpi.vendor_po_id, vpi.description, vpi.quantity, vpi.rate, vpi.amount,
               vpi.hsn_code, vpi.specification, vp.po_number, v.name AS vendor_name
        FROM vendor_po_items vpi
        JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
        LEFT JOIN vendors v ON v.id = vp.vendor_id
        WHERE vpi.vendor_po_id IN (${placeholders})
        ORDER BY vpi.amount DESC
      `).all(...vpoIds);
    }

    // Attach items to each VPO
    const vposWithDetails = vpos.map(v => {
      const items = poLineItems.filter(item => item.vendor_po_id === v.id);
      const isOverdue = !!(v.expected_receipt_date && v.expected_receipt_date < todayStr && Number(v.grn_count) === 0);
      let deliveryStatus = 'Pending Dispatch';
      if (Number(v.grn_count) > 0) deliveryStatus = 'Received (GRN)';
      else if (isOverdue) deliveryStatus = 'Overdue / Delayed';
      else if (v.expected_receipt_date) deliveryStatus = `Expected ${v.expected_receipt_date}`;

      return {
        ...v,
        is_overdue: isOverdue,
        delivery_status: deliveryStatus,
        item_count: items.length,
        items,
      };
    });

    // 3. Planned Material Budget
    // Sum of planning items or client BOQ items
    let materialBudget = 0;
    try {
      const budgetRow = db.prepare(`
        SELECT COALESCE(SUM(opi.planned_qty * opi.estimated_rate), 0) AS b
        FROM order_planning_items opi
        JOIN order_planning op ON op.id = opi.planning_id
        WHERE op.business_book_id = ?
      `).get(projectId);
      materialBudget = round2(budgetRow?.b || 0);

      // If planning not found, check po_items on linked client PO
      if (materialBudget === 0) {
        const boqRow = db.prepare(`
          SELECT COALESCE(SUM(pi.amount), 0) AS b
          FROM po_items pi
          JOIN purchase_orders po ON po.id = pi.po_id
          WHERE po.business_book_id = ?
        `).get(projectId);
        materialBudget = round2(boqRow?.b || 0);
      }
    } catch (_) {}

    // Fallback: If no BOQ planning entered, default to 70% of contract value as standard EPC material estimate
    const estimatedBudget = materialBudget > 0 ? materialBudget : round2(contractValue * 0.7);

    // 4. Summaries & Key Metrics
    const totalPoSpend = round2(vpos.reduce((sum, v) => sum + (Number(v.total_amount) || 0), 0));
    const totalBilled = round2(vpos.reduce((sum, v) => sum + (Number(v.billed_amount) || 0), 0));
    const totalPaid = round2(vpos.reduce((sum, v) => sum + (Number(v.paid_amount) || 0), 0));

    const approvedPos = vposWithDetails.filter(v => v.po_approval === 'approved');
    const pendingApprovalPos = vposWithDetails.filter(v => ['pending_l1', 'pending_l2'].includes(v.po_approval));
    const grnCompletedPos = vposWithDetails.filter(v => Number(v.grn_count) > 0);
    const overduePos = vposWithDetails.filter(v => v.is_overdue);

    const budgetVariance = round2((materialBudget > 0 ? materialBudget : estimatedBudget) - totalPoSpend);
    const budgetConsumedPct = (materialBudget > 0 ? materialBudget : estimatedBudget) > 0
      ? Math.round((totalPoSpend / (materialBudget > 0 ? materialBudget : estimatedBudget)) * 100)
      : 0;

    // 5. Vendor Concentration (Top Vendors by Spend)
    const vendorMap = new Map();
    for (const v of vposWithDetails) {
      const vName = v.vendor_name || 'Direct / Unknown Vendor';
      const cur = vendorMap.get(vName) || { name: vName, spend: 0, po_count: 0, billed: 0 };
      cur.spend = round2(cur.spend + (Number(v.total_amount) || 0));
      cur.billed = round2(cur.billed + (Number(v.billed_amount) || 0));
      cur.po_count += 1;
      vendorMap.set(vName, cur);
    }
    const topVendors = [...vendorMap.values()].sort((a, b) => b.spend - a.spend);

    // 6. PO Status Distribution for Charts
    const statusDistribution = [
      { name: 'Approved & Placed', count: approvedPos.length, value: round2(approvedPos.reduce((s, v) => s + v.total_amount, 0)), color: '#16a34a' },
      { name: 'Pending Approval', count: pendingApprovalPos.length, value: round2(pendingApprovalPos.reduce((s, v) => s + v.total_amount, 0)), color: '#f59e0b' },
      { name: 'Received (GRN)', count: grnCompletedPos.length, value: round2(grnCompletedPos.reduce((s, v) => s + v.total_amount, 0)), color: '#2563eb' },
      { name: 'Overdue Delivery', count: overduePos.length, value: round2(overduePos.reduce((s, v) => s + v.total_amount, 0)), color: '#dc2626' },
    ].filter(s => s.count > 0 || s.value > 0);

    // 7. Indents & Pending for PO
    // Indents requested for this project
    const pName = (project.project_name || '').trim();
    const cName = (project.company_name || '').trim();
    const lNo = (project.lead_no || '').trim();
    const indents = db.prepare(`
      SELECT i.id, i.indent_number, i.indent_date, i.status, i.site_name, i.raised_by_name,
             COALESCE((SELECT COUNT(*) FROM indent_items ii WHERE ii.indent_id = i.id), 0) AS item_count,
             COALESCE((SELECT SUM(ii.amount) FROM indent_items ii WHERE ii.indent_id = i.id), 0) AS total_amount
      FROM indents i
      WHERE (i.lead_no IS NOT NULL AND i.lead_no != '' AND i.lead_no = ?)
         OR (i.site_name IS NOT NULL AND (
            (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
            OR (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
         ))
      ORDER BY i.id DESC
    `).all(lNo, pName, pName, cName, cName);

    // Items pending for PO creation
    const pendingPoItems = db.prepare(`
      SELECT ii.id, ii.description, ii.quantity, ii.unit, ii.rate, ii.amount,
             i.indent_number, i.created_at
      FROM indent_items ii
      JOIN indents i ON i.id = ii.indent_id
      WHERE (i.lead_no IS NOT NULL AND i.lead_no != '' AND i.lead_no = ?)
         OR (i.site_name IS NOT NULL AND (
            (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
            OR (? != '' AND LOWER(TRIM(i.site_name)) = LOWER(TRIM(?)))
         ))
      AND NOT EXISTS (SELECT 1 FROM vendor_po_items vpi WHERE vpi.indent_item_id = ii.id)
      ORDER BY ii.id DESC
      LIMIT 20
    `).all(lNo, pName, pName, cName, cName);

    // 8. Site Execution & DPR Summary
    let siteExecution = { dpr_count: 0, work_done_value: 0, cost_incurred: 0, latest_dpr_date: null, open_snags: 0 };
    try {
      const dprStats = db.prepare(`
        SELECT COUNT(d.id) AS dpr_count,
               COALESCE(SUM(d.grand_total_a), 0) AS work_done_value,
               COALESCE(SUM(d.grand_total_b), 0) AS cost_incurred,
               MAX(d.report_date) AS latest_dpr_date
        FROM dpr d
        JOIN sites s ON s.id = d.site_id
        WHERE s.business_book_id = ?
           OR (s.name IS NOT NULL AND (? != '' AND LOWER(TRIM(s.name)) = LOWER(TRIM(?))))
      `).get(projectId, cName, cName);

      const snagCount = db.prepare(`
        SELECT COUNT(*) AS c
        FROM snags sn
        LEFT JOIN sites s ON s.id = sn.site_id
        WHERE (s.business_book_id = ? OR sn.project_name = ?)
          AND sn.status != 'closed'
      `).get(projectId, displayName)?.c || 0;

      siteExecution = {
        dpr_count: dprStats?.dpr_count || 0,
        work_done_value: round2(dprStats?.work_done_value || 0),
        cost_incurred: round2(dprStats?.cost_incurred || 0),
        latest_dpr_date: dprStats?.latest_dpr_date || null,
        open_snags: snagCount,
      };
    } catch (_) {}

    // 9. Client Invoicing & Receivables
    let clientBilling = { invoiced: 0, collected: 0, balance: 0 };
    try {
      const salesBillSum = db.prepare(`
        SELECT COALESCE(SUM(amount), 0) AS total_invoiced
        FROM sales_bills
        WHERE business_book_id = ? AND approval_status = 'approved'
      `).get(projectId)?.total_invoiced || 0;

      const recRow = db.prepare(`
        SELECT COALESCE(SUM(amount_received), 0) AS collected,
               COALESCE(SUM(balance_amount), 0) AS balance
        FROM receivables
        WHERE project_id = ? OR client_name = ?
      `).get(projectId, project.client_name);

      clientBilling = {
        invoiced: round2(salesBillSum),
        collected: round2(recRow?.collected || 0),
        balance: round2(recRow?.balance || Math.max(0, contractValue - (recRow?.collected || 0))),
      };
    } catch (_) {}

    res.json({
      project: {
        id: project.id,
        name: displayName,
        lead_no: project.lead_no || `PRJ-${project.id}`,
        company_name: project.company_name,
        client_name: project.client_name,
        client_contact: project.client_contact,
        client_email: project.client_email,
        address: [project.billing_address, project.district, project.state].filter(Boolean).join(', '),
        status: project.status || 'active',
        order_type: project.order_type || 'Supply',
        contract_value: contractValue,
        committed_start_date: project.committed_start_date,
        committed_delivery_date: project.committed_delivery_date,
        penalty_clause: project.penalty_clause,
        created_at: project.created_at,
      },
      kpis: {
        contract_value: contractValue,
        material_budget: materialBudget > 0 ? materialBudget : estimatedBudget,
        is_budget_estimated: materialBudget === 0,
        total_po_spend: totalPoSpend,
        budget_variance: budgetVariance,
        budget_consumed_pct: budgetConsumedPct,
        po_count: vpos.length,
        approved_po_count: approvedPos.length,
        pending_approval_count: pendingApprovalPos.length,
        grn_completed_count: grnCompletedPos.length,
        overdue_delivery_count: overduePos.length,
        total_billed: totalBilled,
        total_paid: totalPaid,
      },
      analytics: {
        status_distribution: statusDistribution,
        top_vendors: topVendors,
        spend_vs_budget: {
          contract_value: contractValue,
          material_budget: materialBudget > 0 ? materialBudget : estimatedBudget,
          po_spend: totalPoSpend,
          vendor_billed: totalBilled,
          vendor_paid: totalPaid,
        },
      },
      vendor_pos: vposWithDetails,
      po_line_items: poLineItems.slice(0, 50),
      indents,
      pending_po_items: pendingPoItems,
      site_execution: siteExecution,
      client_billing: clientBilling,
      client_pos: clientPos,
    });
  } catch (err) {
    console.error('[project-dashboard/project/:id] error:', err.message);
    res.status(500).json({ error: 'Failed to load project details: ' + err.message });
  }
});

module.exports = router;
