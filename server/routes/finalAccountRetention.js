// SOP-17: Final Account & Retention Route Module
// Owner: Finance Head — Parul Goyal
//
// Lifecycle:
// S1: Final account made — booked value vs actual cost vs actual money received (Real profit finally visible)
// S2: Retention schedule made at handover, with due dates (Tracked money, not forgotten money)
// S3: Warranty period tracked; complaints closed before claiming retention (Site Engineer complaint log)
// S4: Retention due — claim raised on its own, into the same follow-up ladder as collection (ERP + Collection Engineer)
// S5: Project's actual rates and usage go back into the Rate Master — next quote gets sharper (ERP learning loop)

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('../lib/istDate');
const { calculateAgeing, getStatusColor } = require('../lib/cashSync');

const router = express.Router();
router.use(authMiddleware);

// ─── Default SOP-17 RACI Delegation Matrix ─────────────────────────────
const DEFAULT_SOP17_RACI = {
  sop_owner: {
    key: 'sop_owner',
    role_name: 'SOP-17 Owner / Finance Head',
    raci_type: 'A',
    stage_label: 'Overall Process Owner',
    default_name: 'Parul Goyal (Finance Head)',
    description: 'Accountable for final project account formulation, retention recovery schedule, warranty complaint verification, and rate master learning loop.'
  },
  s1_final_account: {
    key: 's1_final_account',
    role_name: 'Final Account Formulation',
    raci_type: 'A',
    stage_label: 'S1 Final Account (Real Profit)',
    default_name: 'ERP / Parul Goyal',
    description: 'Computes booked contract value vs actual cost vs money received. Real profit and variance margin become permanently visible.'
  },
  s2_retention_schedule: {
    key: 's2_retention_schedule',
    role_name: 'Retention Release Schedule',
    raci_type: 'A',
    stage_label: 'S2 Retention Schedule',
    default_name: 'ERP / Parul Goyal',
    description: 'Configures retention release milestone in the Collections ladder at handover with explicit due dates so retention is actively tracked.'
  },
  s3_warranty_log: {
    key: 's3_warranty_log',
    role_name: 'Warranty Log & Complaint Tracker',
    raci_type: 'R',
    stage_label: 'S3 Warranty Period & Complaints',
    default_name: 'Site Engineer',
    description: 'Tracks defect liability period and ensures 100% of warranty complaints in the complaint register are resolved before claiming retention.'
  },
  s4_retention_claim: {
    key: 's4_retention_claim',
    role_name: 'Retention Demand & Follow-up',
    raci_type: 'R',
    stage_label: 'S4 Retention Due Claim',
    default_name: 'Collection Engineer / ERP',
    description: 'Raises formal retention demand invoice on due date once warranty is clear, feeding directly into the 7-level collection ladder.'
  },
  s5_rate_master: {
    key: 's5_rate_master',
    role_name: 'Rate Master Learning Loop',
    raci_type: 'A',
    stage_label: 'S5 Rate Master Feedback',
    default_name: 'ERP / Estimation Head',
    description: 'Feeds actual landed material rates from this project back into the Rate Master (item_master) so future quotations become sharper.'
  }
};

function getSop17Raci(db) {
  let saved = {};
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='sop17_raci'").get();
    if (row?.value) saved = JSON.parse(row.value);
  } catch (_) {}

  let users = [];
  try {
    users = db.prepare("SELECT id, name, email, department, role FROM users WHERE active=1 ORDER BY name").all();
  } catch (_) {}
  const userMap = new Map(users.map(u => [u.id, u]));

  const result = {};
  for (const [k, def] of Object.entries(DEFAULT_SOP17_RACI)) {
    const s = saved[k] || {};
    const uid = s.user_id ? Number(s.user_id) : null;
    const u = uid ? userMap.get(uid) : null;
    result[k] = {
      ...def,
      user_id: uid,
      assigned_name: u?.name || s.custom_name || def.default_name,
      assigned_email: u?.email || null,
      assigned_role: u?.role || null,
      assigned_department: u?.department || null,
    };
  }
  return result;
}

// ─── Helper: Compute Final Account Data for a Site ─────────────────────
function calculateFinalAccountData(db, siteId) {
  const site = db.prepare(`
    SELECT s.*, 
           bb.id AS bb_id, bb.lead_no, bb.project_name AS bb_project_name, 
           bb.company_name AS bb_company, bb.client_name AS bb_client,
           bb.sale_amount_without_gst, bb.management_discount_amount,
           po.total_amount AS po_amount,
           hc.id AS cert_id, hc.certificate_number, hc.handover_date, hc.status AS cert_status,
           hc.retention_pct, hc.retention_amount, hc.retention_due_date, hc.retention_status,
           hc.warranty_start_date, hc.warranty_end_date, hc.warranty_months,
           u.name AS cost_locked_by_name
      FROM sites s
      LEFT JOIN business_book bb ON bb.id = s.business_book_id
      LEFT JOIN purchase_orders po ON po.id = s.po_id
      LEFT JOIN handover_certificates hc ON (hc.id = s.handover_cert_id OR hc.site_id = s.id)
      LEFT JOIN users u ON u.id = s.cost_locked_by
     WHERE s.id = ?
     ORDER BY hc.id DESC LIMIT 1
  `).get(siteId);

  if (!site) return null;

  // 1. Booked Contract Value
  const bookedContractValue = Math.max(0, 
    Number(site.sale_amount_without_gst || 0) - Number(site.management_discount_amount || 0)
  ) || Number(site.po_amount || 0);

  // 2. Invoiced Revenue (Sales Bills + Client RAs)
  let invoicedRevenue = 0;
  try {
    const bbId = site.bb_id;
    const poId = site.po_id;
    const sbRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
        FROM sales_bills
       WHERE approval_status = 'approved'
         AND ((? IS NOT NULL AND business_book_id = ?) OR (? IS NOT NULL AND po_id = ?))
    `).get(bbId, bbId, poId, poId);
    invoicedRevenue += Number(sbRow?.total || 0);

    const raRow = db.prepare(`
      SELECT COALESCE(SUM(gross_amount), 0) AS total
        FROM proj_client_ra_bills
       WHERE status IN ('raised', 'payment', 'paid')
         AND (site_id = ? OR (? IS NOT NULL AND business_book_id = ?))
    `).get(siteId, bbId, bbId);
    invoicedRevenue += Number(raRow?.total || 0);
  } catch (_) {}

  // Fallback: If no bills raised yet, use contract value as reference
  const effectiveRevenue = invoicedRevenue > 0 ? invoicedRevenue : bookedContractValue;

  // 3. Money Received from Receivables / Payments
  let receivedAmount = 0;
  let outstandingAmount = 0;
  try {
    const recRow = db.prepare(`
      SELECT COALESCE(SUM(received_amount), 0) AS received,
             COALESCE(SUM(outstanding_amount), 0) AS outstanding
        FROM receivables
       WHERE site_id = ? OR (? IS NOT NULL AND business_book_id = ?)
    `).get(siteId, site.bb_id, site.bb_id);
    receivedAmount = Number(recRow?.received || 0);
    outstandingAmount = Number(recRow?.outstanding || 0);
  } catch (_) {}

  // 4. Actual Costs Breakdown:
  // Material Cost (Purchase Bills / Items)
  let materialCost = 0;
  try {
    const pbiExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_bill_items'").get();
    if (pbiExists) {
      const matRow = db.prepare(`
        SELECT COALESCE(SUM(pbi.taxable_amount), 0) AS total
          FROM purchase_bills pb
          JOIN purchase_bill_items pbi ON pbi.purchase_bill_id = pb.id
          LEFT JOIN vendor_pos vp ON vp.id = pbi.vendor_po_id
          LEFT JOIN indents ind ON ind.id = vp.indent_id
          LEFT JOIN order_planning op ON op.id = ind.planning_id
          LEFT JOIN purchase_orders po ON po.id = op.po_id
         WHERE (op.po_id = ? OR po.business_book_id = ? OR pb.vendor_po_id IN (
           SELECT id FROM vendor_pos WHERE indent_id IN (
             SELECT id FROM indents WHERE planning_id IN (
               SELECT id FROM order_planning WHERE po_id = ?
             )
           )
         ))
      `).get(site.po_id, site.bb_id, site.po_id);
      materialCost = Number(matRow?.total || 0);
    }
    if (materialCost === 0) {
      const pbRow = db.prepare(`
        SELECT COALESCE(SUM(pb.amount), 0) AS total
          FROM purchase_bills pb
          LEFT JOIN vendor_pos vp ON vp.id = pb.vendor_po_id
          LEFT JOIN indents ind ON ind.id = vp.indent_id
          LEFT JOIN order_planning op ON op.id = ind.planning_id
         WHERE op.po_id = ? OR (? IS NOT NULL AND vp.id IN (
           SELECT id FROM vendor_pos WHERE indent_id IN (
             SELECT id FROM indents WHERE planning_id IN (
               SELECT id FROM order_planning WHERE po_id = ?
             )
           )
         ))
      `).get(site.po_id, site.po_id, site.po_id);
      materialCost = Number(pbRow?.total || 0);
    }
  } catch (_) {}

  // Labour Cost (Contractor RAs)
  let labourCost = 0;
  try {
    const labRow = db.prepare(`
      SELECT COALESCE(SUM(gross_amount), 0) AS total
        FROM proj_contractor_ra_bills
       WHERE status IN ('raised', 'payment', 'paid')
         AND (site_id = ? OR (? IS NOT NULL AND business_book_id = ?))
    `).get(siteId, site.bb_id, site.bb_id);
    labourCost = Number(labRow?.total || 0);
  } catch (_) {}

  // Travel / Transport Overheads
  let expenseCost = 0;
  try {
    const expRow = db.prepare(`
      SELECT COALESCE(SUM(amount), 0) AS total
        FROM payment_requests
       WHERE status = 'final_approved'
         AND category IN ('TA/DA', 'Transport')
         AND (site_id = ? OR (? IS NOT NULL AND po_id = ?))
    `).get(siteId, site.po_id, site.po_id);
    expenseCost = Number(expRow?.total || 0);
  } catch (_) {}

  const totalActualCost = Math.round((materialCost + labourCost + expenseCost) * 100) / 100;

  // Real Net Profit = Invoiced Revenue - Actual Costs
  // (Also compute Collected Net Profit = Money Received - Actual Costs)
  const netProfit = Math.round((effectiveRevenue - totalActualCost) * 100) / 100;
  const cashProfit = Math.round((receivedAmount - totalActualCost) * 100) / 100;
  const profitMarginPct = effectiveRevenue > 0 ? Math.round((netProfit / effectiveRevenue) * 1000) / 10 : 0;
  const varianceAmount = Math.round((bookedContractValue - totalActualCost) * 100) / 100;
  const variancePct = bookedContractValue > 0 ? Math.round((varianceAmount / bookedContractValue) * 1000) / 10 : 0;

  // Existing Final Account Snapshot
  const savedAccount = db.prepare('SELECT * FROM final_accounts WHERE site_id=? ORDER BY id DESC LIMIT 1').get(siteId);

  return {
    site: {
      id: site.id,
      name: site.name,
      client_name: site.client_name || site.bb_client,
      project_name: site.bb_project_name || site.name,
      cost_locked: site.cost_locked,
      cost_locked_by_name: site.cost_locked_by_name,
      handover_stage: site.handover_stage,
      status: site.status,
    },
    certificate: site.cert_id ? {
      id: site.cert_id,
      certificate_number: site.certificate_number,
      handover_date: site.handover_date,
      status: site.cert_status,
      retention_pct: site.retention_pct || 5.0,
      retention_amount: site.retention_amount || 0,
      retention_due_date: site.retention_due_date,
      retention_status: site.retention_status || 'pending',
      warranty_start_date: site.warranty_start_date,
      warranty_end_date: site.warranty_end_date,
      warranty_months: site.warranty_months || 12,
    } : null,
    financials: {
      booked_contract_value: bookedContractValue,
      invoiced_revenue: invoicedRevenue,
      effective_revenue: effectiveRevenue,
      received_amount: receivedAmount,
      outstanding_amount: outstandingAmount,
      material_cost: materialCost,
      labour_cost: labourCost,
      expense_cost: expenseCost,
      total_actual_cost: totalActualCost,
      net_profit: netProfit,
      cash_profit: cashProfit,
      profit_margin_pct: profitMarginPct,
      variance_amount: varianceAmount,
      variance_pct: variancePct,
    },
    saved_account: savedAccount || null,
  };
}

// ─── Helper: Ensure Retention Schedule is linked to Collection Engine ───
function ensureRetentionSchedule(db, siteId, certId, userId) {
  const cert = db.prepare('SELECT * FROM handover_certificates WHERE id=?').get(certId);
  if (!cert) return null;

  const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
  const clientName = cert.client_name || site?.client_name || 'Client';
  const projectName = cert.project_name || site?.name || 'Project';

  const rPct = Number(cert.retention_pct || 5.0);
  const rAmt = Number(cert.retention_amount || 0);
  const dueDate = cert.retention_due_date;

  // 1. Upsert or link into project_payment_stages (Collection Engine S1 / S2)
  let stage = db.prepare(`
    SELECT * FROM project_payment_stages 
     WHERE site_id = ? AND stage_key = 'retention'
     ORDER BY id DESC LIMIT 1
  `).get(siteId);

  if (!stage) {
    const ins = db.prepare(`
      INSERT INTO project_payment_stages (
        site_id, project_name, client_name, stage_key, stage_name,
        stage_percentage, stage_amount, trigger_event, status, due_date, notes, created_by
      ) VALUES (?,?,?,?,?,?,?,?,'pending',?,?,?)
    `).run(
      siteId,
      projectName,
      clientName,
      'retention',
      'Final Bill & Retention (SOP-17)',
      rPct,
      rAmt,
      'Warranty Completion (SOP-17)',
      dueDate,
      `Auto-scheduled at handover certificate ${cert.certificate_number} signature under SOP-17.2.`,
      userId || 1
    );
    stage = db.prepare('SELECT * FROM project_payment_stages WHERE id=?').get(ins.lastInsertRowid);
  } else if (stage.status === 'pending') {
    db.prepare(`
      UPDATE project_payment_stages
         SET stage_amount = ?,
             stage_percentage = ?,
             due_date = ?,
             trigger_event = 'Warranty Completion (SOP-17)'
       WHERE id = ?
    `).run(rAmt, rPct, dueDate, stage.id);
    stage = db.prepare('SELECT * FROM project_payment_stages WHERE id=?').get(stage.id);
  }

  // 2. Upsert into retention_claims table
  let claim = db.prepare('SELECT * FROM retention_claims WHERE site_id=? ORDER BY id DESC LIMIT 1').get(siteId);
  if (!claim) {
    const claimNum = nextSequence(db, 'retention_claims', 'claim_number', 'RET-', { pad: 4 });
    const cIns = db.prepare(`
      INSERT INTO retention_claims (
        site_id, cert_id, claim_number, retention_pct, retention_amount,
        due_date, warranty_end_date, open_complaints_count, claim_status,
        payment_stage_id, notes
      ) VALUES (?,?,?,?,?,?,?,?, 'pending', ?, ?)
    `).run(
      siteId,
      certId,
      claimNum,
      rPct,
      rAmt,
      dueDate,
      cert.warranty_end_date || dueDate,
      0,
      stage?.id || null,
      `Retention schedule generated for certificate ${cert.certificate_number} (SOP-17.2).`
    );
    claim = db.prepare('SELECT * FROM retention_claims WHERE id=?').get(cIns.lastInsertRowid);
  }

  return { stage, claim };
}

// ─── GET /raci — SOP-17 RACI Matrix ────────────────────────────────────
router.get('/raci', (req, res) => {
  try {
    const db = getDb();
    res.json(getSop17Raci(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /raci — Save SOP-17 RACI Delegation ──────────────────────────
router.post('/raci', (req, res) => {
  try {
    const db = getDb();
    const assignments = req.body.assignments || {};
    const toSave = {};

    for (const [key, val] of Object.entries(assignments)) {
      if (DEFAULT_SOP17_RACI[key]) {
        toSave[key] = {
          user_id: val.user_id ? Number(val.user_id) : null,
          custom_name: val.custom_name ? String(val.custom_name).trim() : null,
        };
      }
    }

    db.prepare(`
      INSERT INTO app_settings (key, value, updated_at)
      VALUES ('sop17_raci', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
    `).run(JSON.stringify(toSave));

    logAuditEvent({
      user: req.user,
      action: 'SOP17_RACI_UPDATED',
      entity_type: 'app_settings',
      entity_id: 0,
      entity_label: 'SOP-17 RACI Roles',
      after: toSave,
    });

    res.json(getSop17Raci(db));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S1: GET /final-account/:site_id ───────────────────────────────────
router.get('/final-account/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const data = calculateFinalAccountData(db, siteId);
    if (!data) return res.status(404).json({ error: 'Site not found' });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S1: POST /finalize-account/:site_id — Freeze Final Account ────────
router.post('/finalize-account/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const data = calculateFinalAccountData(db, siteId);
    if (!data) return res.status(404).json({ error: 'Site not found' });

    const { notes } = req.body;
    const f = data.financials;

    // Insert or update final_accounts record
    const existing = db.prepare('SELECT id FROM final_accounts WHERE site_id=? ORDER BY id DESC LIMIT 1').get(siteId);
    let faId;

    if (existing) {
      db.prepare(`
        UPDATE final_accounts
           SET cert_id = ?,
               project_name = ?,
               client_name = ?,
               booked_contract_value = ?,
               invoiced_revenue = ?,
               received_amount = ?,
               material_cost = ?,
               labour_cost = ?,
               expense_cost = ?,
               total_actual_cost = ?,
               net_profit = ?,
               profit_margin_pct = ?,
               variance_amount = ?,
               variance_pct = ?,
               costs_locked = ?,
               status = 'finalized',
               finalized_by = ?,
               finalized_by_name = ?,
               finalized_at = CURRENT_TIMESTAMP,
               notes = COALESCE(?, notes),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(
        data.certificate?.id || null,
        data.site.project_name,
        data.site.client_name,
        f.booked_contract_value,
        f.invoiced_revenue,
        f.received_amount,
        f.material_cost,
        f.labour_cost,
        f.expense_cost,
        f.total_actual_cost,
        f.net_profit,
        f.profit_margin_pct,
        f.variance_amount,
        f.variance_pct,
        data.site.cost_locked || 0,
        req.user.id,
        req.user.name,
        notes || null,
        existing.id
      );
      faId = existing.id;
    } else {
      const ins = db.prepare(`
        INSERT INTO final_accounts (
          site_id, cert_id, project_name, client_name, booked_contract_value,
          invoiced_revenue, received_amount, material_cost, labour_cost,
          expense_cost, total_actual_cost, net_profit, profit_margin_pct,
          variance_amount, variance_pct, costs_locked, status,
          finalized_by, finalized_by_name, finalized_at, notes
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'finalized',?,?,CURRENT_TIMESTAMP,?)
      `).run(
        siteId,
        data.certificate?.id || null,
        data.site.project_name,
        data.site.client_name,
        f.booked_contract_value,
        f.invoiced_revenue,
        f.received_amount,
        f.material_cost,
        f.labour_cost,
        f.expense_cost,
        f.total_actual_cost,
        f.net_profit,
        f.profit_margin_pct,
        f.variance_amount,
        f.variance_pct,
        data.site.cost_locked || 0,
        req.user.id,
        req.user.name,
        notes || 'Final account approved by Finance Head (SOP-17.1)'
      );
      faId = ins.lastInsertRowid;
    }

    // Link into site & certificate
    db.prepare("UPDATE sites SET final_account_status='finalized' WHERE id=?").run(siteId);
    if (data.certificate?.id) {
      db.prepare('UPDATE handover_certificates SET final_account_id=? WHERE id=?').run(faId, data.certificate.id);
    }

    logAuditEvent({
      user: req.user,
      action: 'SOP17_FINAL_ACCOUNT_FINALIZED',
      entity_type: 'final_accounts',
      entity_id: faId,
      entity_label: `${data.site.name} Final Account`,
      after: { site_id: siteId, net_profit: f.net_profit, profit_margin_pct: f.profit_margin_pct },
    });

    res.json({
      message: 'Final Account calculated and finalized successfully (SOP-17.1)',
      final_account_id: faId,
      status: 'finalized',
      net_profit: f.net_profit,
      profit_margin_pct: f.profit_margin_pct,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S2: GET /retention-schedule/:site_id ──────────────────────────────
router.get('/retention-schedule/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const data = calculateFinalAccountData(db, siteId);
    if (!data) return res.status(404).json({ error: 'Site not found' });

    // Link/Sync retention schedule if cert is signed
    if (data.certificate?.status === 'signed') {
      ensureRetentionSchedule(db, siteId, data.certificate.id, req.user.id);
    }

    const claim = db.prepare(`
      SELECT rc.*, pps.status AS stage_status, pps.stage_amount AS stage_amount_live,
             r.invoice_number, r.outstanding_amount, r.received_amount
        FROM retention_claims rc
        LEFT JOIN project_payment_stages pps ON pps.id = rc.payment_stage_id
        LEFT JOIN receivables r ON r.id = rc.receivable_id
       WHERE rc.site_id = ?
       ORDER BY rc.id DESC LIMIT 1
    `).get(siteId);

    res.json({
      site: data.site,
      certificate: data.certificate,
      retention_claim: claim || null,
      retention_pct: data.certificate?.retention_pct || 5.0,
      retention_amount: data.certificate?.retention_amount || 0,
      retention_due_date: data.certificate?.retention_due_date || null,
      retention_status: claim?.claim_status || data.certificate?.retention_status || 'pending',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S3: GET /warranty-status/:site_id ─────────────────────────────────
router.get('/warranty-status/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cert = db.prepare('SELECT * FROM handover_certificates WHERE (id=? OR site_id=?) ORDER BY id DESC LIMIT 1')
      .get(site.handover_cert_id, siteId);

    const startDate = cert?.warranty_start_date || cert?.handover_date || site.created_at?.slice(0, 10);
    const endDate = cert?.warranty_end_date || cert?.retention_due_date;
    const months = cert?.warranty_months || 12;

    const todayStr = istToday();
    const daysRemaining = endDate ? Math.max(0, Math.ceil((new Date(endDate) - new Date(todayStr)) / 86400000)) : 0;
    const isWarrantyActive = endDate ? todayStr <= endDate : false;

    // 1. Fetch complaints matching this site / client
    const complaints = db.prepare(`
      SELECT c.id, c.complaint_number, c.problem_detail, c.category, c.priority,
             c.status, c.created_at, c.resolved_date,
             eng.name AS assigned_engineer_name, eng.phone AS assigned_engineer_phone
        FROM complaints c
        LEFT JOIN users eng ON eng.id = c.assigned_engineer_id
       WHERE (c.site_id = ? OR (c.client_name = ? AND c.created_at >= ?))
       ORDER BY c.id DESC
    `).all(siteId, site.client_name || site.name, startDate || '2000-01-01');

    // 2. Fetch snags raised after handover walk
    const postHandoverSnags = db.prepare(`
      SELECT s.id, s.snag_no, s.description, s.priority, s.status, s.raised_at,
             u.name AS assigned_to_name
        FROM snags s
        LEFT JOIN users u ON u.id = s.assigned_to
       WHERE s.site_id = ?
         AND s.is_client_walk = 0
         AND s.created_at >= ?
       ORDER BY s.id DESC
    `).all(siteId, startDate || '2000-01-01');

    const openComplaints = complaints.filter(c => !['resolved', 'closed'].includes(c.status));
    const openSnags = postHandoverSnags.filter(s => s.status !== 'approved');
    const totalOpenDefects = openComplaints.length + openSnags.length;

    // Update open_complaints_count in retention_claims
    db.prepare('UPDATE retention_claims SET open_complaints_count=? WHERE site_id=?').run(totalOpenDefects, siteId);

    res.json({
      site_id: siteId,
      site_name: site.name,
      client_name: site.client_name,
      warranty: {
        start_date: startDate,
        end_date: endDate,
        months,
        days_remaining: daysRemaining,
        is_active: isWarrantyActive,
      },
      open_defects_count: totalOpenDefects,
      can_claim_retention: totalOpenDefects === 0,
      complaints,
      open_complaints: openComplaints,
      post_handover_snags: postHandoverSnags,
      open_snags: openSnags,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S3: POST /warranty-complaint — Log Warranty Ticket ─────────────────
router.post('/warranty-complaint', (req, res) => {
  try {
    const db = getDb();
    const { site_id, problem_detail, category, priority, assigned_engineer_id, mobile_number } = req.body;
    if (!site_id || !problem_detail) {
      return res.status(400).json({ error: 'site_id and problem_detail are required' });
    }

    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const cert = db.prepare('SELECT * FROM handover_certificates WHERE (id=? OR site_id=?) ORDER BY id DESC LIMIT 1')
      .get(site.handover_cert_id, site_id);

    const cn = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });

    const r = db.prepare(`
      INSERT INTO complaints (
        complaint_number, client_name, company_name, mobile_number, category,
        problem_detail, priority, status, site_id, is_warranty_complaint,
        handover_cert_id, assigned_engineer_id, created_by
      ) VALUES (?,?,?,?,?,?,?, 'open', ?, 1, ?, ?, ?)
    `).run(
      cn,
      site.client_name || site.name,
      site.name,
      mobile_number || site.client_rep_phone || null,
      category || 'Warranty / DLP Defect',
      problem_detail,
      priority || 'high',
      site_id,
      cert?.id || null,
      assigned_engineer_id ? Number(assigned_engineer_id) : null,
      req.user.id
    );

    logAuditEvent({
      user: req.user,
      action: 'SOP17_WARRANTY_COMPLAINT_REGISTERED',
      entity_type: 'complaints',
      entity_id: r.lastInsertRowid,
      entity_label: cn,
      after: { site_id, complaint_number: cn, problem_detail },
    });

    res.status(201).json({
      message: `Warranty complaint ${cn} registered in Complaint Register (SOP-17.3)`,
      complaint_id: r.lastInsertRowid,
      complaint_number: cn,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S4: POST /claim-retention/:site_id — Raise Retention Demand ────────
router.post('/claim-retention/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const data = calculateFinalAccountData(db, siteId);
    if (!data) return res.status(404).json({ error: 'Site not found' });

    const cert = data.certificate;
    if (!cert || cert.status !== 'signed') {
      return res.status(400).json({ error: 'Cannot claim retention: Handover Certificate must be signed first (SOP-15.6 / 17.2).' });
    }

    // 1. Verify warranty complaints count — must be 0!
    const openComplaints = db.prepare(`
      SELECT COUNT(*) AS c
        FROM complaints
       WHERE (site_id = ? OR (client_name = ? AND created_at >= ?))
         AND status NOT IN ('resolved', 'closed')
    `).get(siteId, data.site.client_name, cert.warranty_start_date || '2000-01-01')?.c || 0;

    const openSnags = db.prepare(`
      SELECT COUNT(*) AS c
        FROM snags
       WHERE site_id = ? AND is_client_walk = 0 AND status != 'approved'
    `).get(siteId)?.c || 0;

    const totalOpen = openComplaints + openSnags;
    if (totalOpen > 0) {
      return res.status(400).json({
        error: `Retention claim BLOCKED: ${totalOpen} open warranty defect(s) pending (${openComplaints} complaints, ${openSnags} snags). All warranty complaints must be closed in the register before claiming retention (SOP-17.3 / 17.4).`,
        open_complaints_count: totalOpen,
      });
    }

    // 2. Ensure retention milestone stage in Collection Engine
    const { stage, claim } = ensureRetentionSchedule(db, siteId, cert.id, req.user.id);
    const amt = Number(cert.retention_amount || stage?.stage_amount || 0);

    if (amt <= 0) {
      return res.status(400).json({ error: 'Retention amount is 0. Please verify contract value.' });
    }

    const today = istToday();
    const invoiceNo = `DEM-RET-${cert.certificate_number.replace(/[^A-Za-z0-9]/g, '')}-${Date.now().toString().slice(-4)}`;
    const { days, bucket } = calculateAgeing(cert.retention_due_date || today);

    // 3. Insert Receivable for Retention in Collection Engine (Level 1 Ladder)
    let recId;
    const existingRec = stage?.demanded_receivable_id
      ? db.prepare('SELECT id FROM receivables WHERE id=?').get(stage.demanded_receivable_id)
      : null;

    if (existingRec) {
      recId = existingRec.id;
    } else {
      const recResult = db.prepare(`
        INSERT INTO receivables (
          client_name, project_name, site_id, site_name, invoice_number, invoice_date,
          invoice_amount, received_amount, outstanding_amount, due_date,
          ageing_days, ageing_bucket, status, follow_up_status, payment_stage_id, created_by
        ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,'red','pending',?,?)
      `).run(
        data.site.client_name || data.site.name,
        data.site.project_name || data.site.name,
        siteId,
        data.site.name,
        invoiceNo,
        today,
        amt,
        amt,
        cert.retention_due_date || today,
        days,
        bucket,
        stage?.id || null,
        req.user.id
      );
      recId = recResult.lastInsertRowid;
    }

    // 4. Update stage, certificate, and claim records
    if (stage?.id) {
      db.prepare(`
        UPDATE project_payment_stages
           SET status = 'demanded',
               demanded_receivable_id = ?,
               demanded_at = CURRENT_TIMESTAMP
         WHERE id = ?
      `).run(recId, stage.id);
    }

    db.prepare(`
      UPDATE handover_certificates
         SET retention_status = 'claimed'
       WHERE id = ?
    `).run(cert.id);

    const claimNum = claim?.claim_number || nextSequence(db, 'retention_claims', 'claim_number', 'RET-', { pad: 4 });
    db.prepare(`
      UPDATE retention_claims
         SET claim_status = 'claimed',
             receivable_id = ?,
             claimed_by = ?,
             claimed_by_name = ?,
             claimed_at = CURRENT_TIMESTAMP,
             notes = 'Retention claim raised into Collection Engine follow-up ladder (SOP-17.4).'
       WHERE site_id = ?
    `).run(recId, req.user.id, req.user.name, siteId);

    logAuditEvent({
      user: req.user,
      action: 'SOP17_RETENTION_CLAIM_RAISED',
      entity_type: 'retention_claims',
      entity_id: claim?.id || 0,
      entity_label: claimNum,
      after: { site_id: siteId, claim_number: claimNum, amount: amt, invoice_number: invoiceNo, receivable_id: recId },
    });

    res.json({
      message: `Retention Claim ${claimNum} raised successfully! Placed into 7-level Collection follow-up ladder (SOP-17.4).`,
      claim_number: claimNum,
      receivable_id: recId,
      invoice_number: invoiceNo,
      amount: amt,
      due_date: cert.retention_due_date || today,
      status: 'claimed',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S5: GET /rate-master-variance/:site_id ────────────────────────────
router.get('/rate-master-variance/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(siteId);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Pull material items purchased for this project / site
    let rows = [];
    const pbiTableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='purchase_bill_items'").get();
    if (pbiTableExists) {
      try {
        rows = db.prepare(`
          SELECT pbi.id AS pbi_id,
                 COALESCE(pbi.description, vpi.description, ii.description, 'Material Item') AS item_name,
                 pbi.quantity,
                 pbi.unit,
                 pbi.po_rate,
                 pbi.bill_rate,
                 pbi.taxable_amount,
                 pb.bill_number,
                 pb.bill_date,
                 v.name AS vendor_name,
                 im.id AS item_master_id,
                 im.item_code,
                 im.current_price AS current_rate_master_price
            FROM purchase_bill_items pbi
            JOIN purchase_bills pb ON pb.id = pbi.purchase_bill_id
            LEFT JOIN vendor_pos vp ON vp.id = pbi.vendor_po_id
            LEFT JOIN vendor_po_items vpi ON vpi.id = pbi.vendor_po_item_id
            LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
            LEFT JOIN vendors v ON v.id = pb.vendor_id
            LEFT JOIN item_master im ON (
              (ii.item_master_id IS NOT NULL AND im.id = ii.item_master_id)
              OR LOWER(TRIM(im.item_name)) = LOWER(TRIM(COALESCE(pbi.description, vpi.description, ii.description)))
            )
           WHERE vp.indent_id IN (
             SELECT ind.id FROM indents ind
              WHERE ind.planning_id IN (
                SELECT op.id FROM order_planning op WHERE op.po_id = ?
              )
           )
           ORDER BY pbi.id DESC
        `).all(site.po_id || 0);
      } catch (pbiErr) {
        console.warn('[rate-master-variance] pbi query error:', pbiErr.message);
      }
    }

    if (rows.length === 0 && site.po_id) {
      try {
        rows = db.prepare(`
          SELECT vpi.id AS pbi_id,
                 COALESCE(vpi.description, ii.description, 'Material Item') AS item_name,
                 vpi.quantity,
                 'nos' AS unit,
                 vpi.rate AS po_rate,
                 vpi.rate AS bill_rate,
                 vpi.amount AS taxable_amount,
                 vp.po_number AS bill_number,
                 vp.created_at AS bill_date,
                 v.name AS vendor_name,
                 im.id AS item_master_id,
                 im.item_code,
                 im.current_price AS current_rate_master_price
            FROM vendor_po_items vpi
            JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
            LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
            LEFT JOIN vendors v ON v.id = vp.vendor_id
            LEFT JOIN item_master im ON (
              (ii.item_master_id IS NOT NULL AND im.id = ii.item_master_id)
              OR LOWER(TRIM(im.item_name)) = LOWER(TRIM(COALESCE(vpi.description, ii.description)))
            )
           WHERE vp.indent_id IN (
             SELECT ind.id FROM indents ind
              WHERE ind.planning_id IN (
                SELECT op.id FROM order_planning op WHERE op.po_id = ?
              )
           )
           ORDER BY vpi.id DESC
        `).all(site.po_id);
      } catch (vpiErr) {
        console.warn('[rate-master-variance] fallback query error:', vpiErr.message);
      }
    }

    // Aggregate by item
    const map = new Map();
    for (const r of rows) {
      const key = (r.item_master_id ? `id_${r.item_master_id}` : r.item_name).toLowerCase().trim();
      const existing = map.get(key);
      const qty = Number(r.quantity || 0);
      const billRate = Number(r.bill_rate || r.po_rate || 0);

      if (!existing) {
        map.set(key, {
          item_master_id: r.item_master_id || null,
          item_code: r.item_code || '—',
          item_name: r.item_name,
          unit: r.unit || 'nos',
          total_quantity: qty,
          total_spend: billRate * qty,
          latest_bill_rate: billRate,
          po_rate: Number(r.po_rate || 0),
          current_rate_master_price: Number(r.current_rate_master_price || 0),
          last_bill_date: r.bill_date,
          last_bill_number: r.bill_number,
          vendor_name: r.vendor_name,
        });
      } else {
        existing.total_quantity += qty;
        existing.total_spend += billRate * qty;
        if (new Date(r.bill_date || 0) > new Date(existing.last_bill_date || 0)) {
          existing.latest_bill_rate = billRate;
          existing.last_bill_date = r.bill_date;
          existing.last_bill_number = r.bill_number;
          existing.vendor_name = r.vendor_name;
        }
      }
    }

    const items = [...map.values()].map(it => {
      const avgRate = it.total_quantity > 0 ? Math.round((it.total_spend / it.total_quantity) * 100) / 100 : it.latest_bill_rate;
      const rateDiff = Math.round((avgRate - it.current_rate_master_price) * 100) / 100;
      const variancePct = it.current_rate_master_price > 0 ? Math.round((rateDiff / it.current_rate_master_price) * 1000) / 10 : 0;
      return {
        ...it,
        avg_rate: avgRate,
        rate_diff: rateDiff,
        variance_pct: variancePct,
        is_higher: rateDiff > 0,
        is_lower: rateDiff < 0,
      };
    });

    res.json({
      site_id: siteId,
      site_name: site.name,
      total_items_analyzed: items.length,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S5: POST /sync-rate-master — Update Rate Master Learning Loop ──────
router.post('/sync-rate-master', (req, res) => {
  try {
    const db = getDb();
    const { items, site_id, site_name } = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'items array is required' });
    }

    let updatedCount = 0;
    const runTx = db.transaction(() => {
      for (const it of items) {
        const itemId = Number(it.item_master_id);
        const newRate = Number(it.rate || it.avg_rate || it.latest_bill_rate || 0);
        if (!itemId || newRate <= 0) continue;

        // 1. Log to item_price_history (SOP-17 learning record)
        db.prepare(`
          INSERT INTO item_price_history (
            item_id, rate, quantity, source, company_name, created_by, created_by_name
          ) VALUES (?, ?, ?, 'sop17_learning_loop', ?, ?, ?)
        `).run(
          itemId,
          newRate,
          Number(it.total_quantity || it.quantity || 0),
          site_name || `Site #${site_id || ''}`,
          req.user.id,
          req.user.name
        );

        // 2. Update active rate in item_master
        db.prepare(`
          UPDATE item_master
             SET current_price = ?,
                 updated_at = CURRENT_TIMESTAMP
           WHERE id = ?
        `).run(newRate, itemId);

        updatedCount++;
      }
    });

    runTx();

    logAuditEvent({
      user: req.user,
      action: 'SOP17_RATE_MASTER_LEARNING_SYNC',
      entity_type: 'item_master',
      entity_id: 0,
      entity_label: `${updatedCount} items synced from project rates`,
      after: { count: updatedCount, site_id },
    });

    res.json({
      message: `Successfully fed ${updatedCount} actual project rate(s) into Rate Master (SOP-17.5). Next quotations will use these updated rates!`,
      synced_count: updatedCount,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = {
  router,
  getSop17Raci,
  calculateFinalAccountData,
  ensureRetentionSchedule,
};
