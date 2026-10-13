// SOP-16 Collection Engine Routes
// Owner: Collection Engineer
// Steps:
//   S1: Payment Stages on Day 1 (Advance, Material, Testing, Handover, Retention)
//   S2: Auto-Demand on Event Completion
//   S3: Live Ageing Screen (0-30, 31-60, 61-90, 90+)
//   S4: Fixed Escalation Ladder (Collection Eng -> PM Adarsh -> Head Nitin -> MD Ankur)
//   S5: 60-Day Material Supply Stop (with Head Exception Override)
//   S6: Auto Bank Match & Thank-You Receipt

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('../lib/istDate');
const { calculateAgeing, getStatusColor } = require('../lib/cashSync');

const router = express.Router();
router.use(authMiddleware);

// ─── Default SOP-16 RACI Delegation Matrix ─────────────────────────────
const DEFAULT_SOP16_RACI = {
  sop_owner: {
    key: 'sop_owner',
    role_name: 'SOP-16 Owner / Collection Engineer',
    raci_type: 'A',
    stage_label: 'Overall Process Owner',
    default_name: 'Collection Engineer',
    description: 'Accountable for end-to-end collection targets, milestone demand generation, follow-up execution, and bank reconciliation.'
  },
  s1_payment_stages: {
    key: 's1_payment_stages',
    role_name: 'Payment Stages Contract Lead',
    raci_type: 'R',
    stage_label: 'S1 Payment Stages on Day 1',
    default_name: 'Collection Engineer / Contract Lead',
    description: 'Records contractual payment milestones (Advance, Material, Testing, Handover, Retention) in the project record on Day 1.'
  },
  s2_auto_demand: {
    key: 's2_auto_demand',
    role_name: 'Automated Milestone Demand',
    raci_type: 'A',
    stage_label: 'S2 Auto-Demand on Event',
    default_name: 'ERP (Automatic)',
    description: 'System automatically demands payment the moment a project milestone completes.'
  },
  s3_ageing_screen: {
    key: 's3_ageing_screen',
    role_name: 'Live Ageing Dashboard',
    raci_type: 'I',
    stage_label: 'S3 Live Ageing Screen',
    default_name: 'ERP / Finance',
    description: 'Real-time visibility into who owes what across 0-30, 31-60, 61-90, and 90+ day buckets.'
  },
  s4_ladder_ce: {
    key: 's4_ladder_ce',
    role_name: 'Escalation Level 1 (Days 1–7 Overdue)',
    raci_type: 'R',
    stage_label: 'S4.1 Collection Engineer Call',
    default_name: 'Collection Engineer',
    description: 'Initiates direct phone calls and sends formal payment reminders in the first week of overdue.'
  },
  s4_ladder_pm: {
    key: 's4_ladder_pm',
    role_name: 'Escalation Level 2 (Day 15 Overdue)',
    raci_type: 'A',
    stage_label: 'S4.2 Project Manager Escalation',
    default_name: 'Adarsh Kumar (PM)',
    description: 'Leverages site-level relationship with client project manager to expedite payment release.'
  },
  s4_ladder_head: {
    key: 's4_ladder_head',
    role_name: 'Escalation Level 3 (Day 30 Overdue)',
    raci_type: 'A',
    stage_label: 'S4.3 Department Head Escalation',
    default_name: 'Nitin Jain (Head)',
    description: 'Engages client senior executives; evaluates risk of continued project delivery.'
  },
  s4_ladder_md: {
    key: 's4_ladder_md',
    role_name: 'Escalation Level 4 (Day 45–60 Overdue)',
    raci_type: 'A',
    stage_label: 'S4.4 MD Escalation',
    default_name: 'Ankur Kaplesh (MD)',
    description: 'Direct top-level executive intervention, contractual notice, and final payment demand.'
  },
  s5_material_stop: {
    key: 's5_material_stop',
    role_name: '60-Day Supply Stop & Override Authority',
    raci_type: 'A',
    stage_label: 'S5 60-Day Supply Stop',
    default_name: 'Nitin Jain (Head)',
    description: 'Enforces automatic pause of new material supply to 60+ days overdue clients; can grant written exception overrides.'
  },
  s6_bank_receipt: {
    key: 's6_bank_receipt',
    role_name: 'Bank Matching & Thank-You Receipt Authority',
    raci_type: 'A',
    stage_label: 'S6 Bank Match & Thank-You Receipt',
    default_name: 'ERP / Accounts',
    description: 'Issues formal Thank-You Payment Receipts upon bank reconciliation and dispatches acknowledgment to client.'
  }
};

// Helper: load resolved RACI from DB
function getCollectionRaci(db) {
  let saved = {};
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='sop16_collection_raci'").get();
    if (row?.value) saved = JSON.parse(row.value);
  } catch (_) {}

  let users = [];
  try {
    users = db.prepare("SELECT id, name, email, department, role FROM users WHERE active=1 ORDER BY name").all();
  } catch (_) {}
  const userMap = new Map(users.map(u => [u.id, u]));

  const result = {};
  for (const [k, def] of Object.entries(DEFAULT_SOP16_RACI)) {
    const s = saved[k] || {};
    const uid = s.user_id ? Number(s.user_id) : null;
    const u = uid ? userMap.get(uid) : null;
    result[k] = {
      ...def,
      user_id: uid,
      assigned_name: u ? u.name : (s.custom_name || def.default_name),
      assigned_email: u ? u.email : null,
      assigned_department: u ? u.department : null,
      is_custom: !!u || !!s.custom_name,
    };
  }

  return { raci: result, users };
}

// ─── RACI Routes ────────────────────────────────────────────────────────
router.get('/raci', (req, res) => {
  const db = getDb();
  const isAdmin = req.user?.role === 'admin';
  res.json({ ...getCollectionRaci(db), can_modify: isAdmin });
});

router.put('/raci', (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only Admins can modify SOP-16 Collection RACI delegation roles' });
  }
  const db = getDb();
  const assignments = req.body?.assignments || {};
  const toSave = {};

  for (const [key, val] of Object.entries(assignments)) {
    if (DEFAULT_SOP16_RACI[key]) {
      toSave[key] = {
        user_id: val.user_id ? Number(val.user_id) : null,
        custom_name: val.custom_name ? String(val.custom_name).trim() : null,
      };
    }
  }

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('sop16_collection_raci', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).run(JSON.stringify(toSave));

  res.json({ message: 'SOP-16 RACI roles updated successfully', ...getCollectionRaci(db) });
});

// Helper to resolve a site from either `sites` table ID or `business_book` ID
function resolveSite(db, siteId) {
  if (!siteId) return null;
  const numId = Number(siteId);
  let site = db.prepare('SELECT id, name, client_name FROM sites WHERE id=?').get(numId);
  if (!site) {
    // Check if it's a business_book ID
    const bb = db.prepare('SELECT id, company_name, project_name, client_name FROM business_book WHERE id=?').get(numId);
    if (bb) {
      const matchName = bb.project_name || bb.company_name;
      site = db.prepare('SELECT id, name, client_name FROM sites WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) OR business_book_id=?').get(matchName, bb.id);
      if (!site) {
        // Auto-create site row for relational consistency
        const ins = db.prepare('INSERT INTO sites (name, client_name, business_book_id) VALUES (?,?,?)')
          .run(matchName, bb.client_name || matchName, bb.id);
        site = { id: ins.lastInsertRowid, name: matchName, client_name: bb.client_name || matchName };
      }
    }
  }
  return site;
}

// ─── S1 & S2: Payment Stages API ───────────────────────────────────────
const STANDARD_STAGES = [
  { stage_key: 'advance', stage_name: 'Advance on Contract Signing', stage_percentage: 10, trigger_event: 'Contract Kickoff' },
  { stage_key: 'material', stage_name: 'Material Supply & Delivery', stage_percentage: 50, trigger_event: 'Material Dispatched' },
  { stage_key: 'testing', stage_name: 'Testing & Commissioning', stage_percentage: 20, trigger_event: 'Testing Passed (SOP-14)' },
  { stage_key: 'handover', stage_name: 'Handover & Snags Clearance', stage_percentage: 15, trigger_event: 'Handover Certificate (SOP-15)' },
  { stage_key: 'retention', stage_name: 'Final Bill & Retention', stage_percentage: 5, trigger_event: 'Warranty Completion (SOP-17)' },
];

router.get('/stages/:site_id', (req, res) => {
  const db = getDb();
  const site = resolveSite(db, req.params.site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const siteId = site.id;

  // Get total contract / PO value for this site if available
  const poTotal = db.prepare(`
    SELECT COALESCE(SUM(po.total_amount), 0) AS total
    FROM purchase_orders po
    JOIN business_book bb ON po.business_book_id = bb.id
    WHERE bb.company_name = ? OR bb.project_name = ?
  `).get(site.client_name, site.name)?.total || 0;

  const existing = db.prepare(`
    SELECT pps.*, r.invoice_number, r.outstanding_amount, r.received_amount
    FROM project_payment_stages pps
    LEFT JOIN receivables r ON r.id = pps.demanded_receivable_id
    WHERE pps.site_id = ?
    ORDER BY pps.id ASC
  `).all(siteId);

  res.json({
    site,
    po_total: poTotal,
    stages: existing.length > 0 ? existing : STANDARD_STAGES.map(s => ({
      ...s,
      site_id: siteId,
      site_name: site.name,
      client_name: site.client_name,
      stage_amount: poTotal > 0 ? Math.round((poTotal * s.stage_percentage) / 100) : 0,
      status: 'pending'
    }))
  });
});

router.post('/stages/:site_id', (req, res) => {
  const db = getDb();
  const site = resolveSite(db, req.params.site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const siteId = site.id;

  const { stages } = req.body;
  if (!Array.isArray(stages) || stages.length === 0) {
    return res.status(400).json({ error: 'At least one payment stage is required' });
  }

  // Transactionally replace or insert stages for site
  const insertStmt = db.prepare(`
    INSERT INTO project_payment_stages (
      site_id, project_name, client_name, stage_key, stage_name,
      stage_percentage, stage_amount, trigger_event, status, due_date, notes, created_by
    ) VALUES (?,?,?,?,?,?,?,?,COALESCE(?,'pending'),?,?,?)
  `);

  const runTx = db.transaction(() => {
    // Delete pending stages (preserve already demanded / paid stages)
    db.prepare("DELETE FROM project_payment_stages WHERE site_id=? AND status='pending'").run(siteId);

    for (const s of stages) {
      if (s.id && (s.status === 'demanded' || s.status === 'paid')) {
        // Keep existing demanded/paid stages
        continue;
      }
      insertStmt.run(
        siteId,
        site.name,
        site.client_name || site.name,
        s.stage_key || 'custom',
        s.stage_name,
        Number(s.stage_percentage || 0),
        Number(s.stage_amount || 0),
        s.trigger_event || '',
        s.status || 'pending',
        s.due_date || null,
        s.notes || null,
        req.user.id
      );
    }
  });

  runTx();
  res.json({ message: 'Payment stages configured successfully for ' + site.name });
});

// Trigger payment demand for a stage (S2 Auto-Demand)
router.post('/trigger-stage/:stage_id', (req, res) => {
  const db = getDb();
  const stageId = Number(req.params.stage_id);
  const stage = db.prepare('SELECT * FROM project_payment_stages WHERE id=?').get(stageId);
  if (!stage) return res.status(404).json({ error: 'Payment stage not found' });
  if (stage.status !== 'pending') {
    return res.status(400).json({ error: `Stage is already ${stage.status}` });
  }

  const amt = Number(stage.stage_amount || 0);
  if (amt <= 0) {
    return res.status(400).json({ error: 'Stage amount must be greater than 0 to generate a payment demand' });
  }

  const today = istToday();
  const invoiceNo = `DEM-${stage.stage_key.toUpperCase().slice(0, 3)}-${Date.now().toString().slice(-6)}`;
  const { days, bucket } = calculateAgeing(stage.due_date || today);
  const statusColor = getStatusColor(amt, days);

  const recResult = db.prepare(`
    INSERT INTO receivables (
      client_name, project_name, site_id, site_name, invoice_number, invoice_date,
      invoice_amount, received_amount, outstanding_amount, due_date,
      ageing_days, ageing_bucket, status, follow_up_status, payment_stage_id, created_by
    ) VALUES (?,?,?,?,?,?,?,0,?,?,?,?,'red','pending',?,?)
  `).run(
    stage.client_name || stage.project_name,
    stage.project_name,
    stage.site_id,
    stage.project_name,
    invoiceNo,
    today,
    amt,
    amt,
    stage.due_date || today,
    days,
    bucket,
    stageId,
    req.user.id
  );

  db.prepare(`
    UPDATE project_payment_stages
    SET status='demanded', demanded_receivable_id=?, demanded_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
    WHERE id=?
  `).run(recResult.lastInsertRowid, stageId);

  res.status(201).json({
    message: `Payment demanded successfully for stage "${stage.stage_name}"`,
    receivable_id: recResult.lastInsertRowid,
    invoice_number: invoiceNo
  });
});

// ─── S4: Escalation Ladder API ─────────────────────────────────────────
router.get('/escalations', (req, res) => {
  const db = getDb();
  const raciData = getCollectionRaci(db).raci;

  // Find all active unpaid receivables
  const rows = db.prepare(`
    SELECT r.*, s.name AS site_name_live
    FROM receivables r
    LEFT JOIN sites s ON s.id = r.site_id
    WHERE r.outstanding_amount > 0
    ORDER BY r.ageing_days DESC
  `).all();

  const escalations = rows.map(r => {
    const days = Number(r.ageing_days || 0);
    let level = 'L1_CE';
    let levelNum = 1;
    let levelTitle = 'Level 1 · Collection Engineer';
    let assignedName = raciData.s4_ladder_ce?.assigned_name || 'Collection Engineer';
    let actionRequired = 'Direct telephone call and formal reminder message';

    if (days >= 45) {
      level = 'L4_MD';
      levelNum = 4;
      levelTitle = 'Level 4 · MD Escalation';
      assignedName = raciData.s4_ladder_md?.assigned_name || 'Ankur Kaplesh (MD)';
      actionRequired = 'Executive intervention / Contractual breach notice';
    } else if (days >= 30) {
      level = 'L3_HEAD';
      levelNum = 3;
      levelTitle = 'Level 3 · Department Head';
      assignedName = raciData.s4_ladder_head?.assigned_name || 'Nitin Jain (Head)';
      actionRequired = 'Senior management discussion; assess risk of continued supply';
    } else if (days >= 15) {
      level = 'L2_PM';
      levelNum = 2;
      levelTitle = 'Level 2 · Project Manager';
      assignedName = raciData.s4_ladder_pm?.assigned_name || 'Adarsh Kumar (PM)';
      actionRequired = 'Site coordination follow-up with client representative';
    }

    return {
      id: r.id,
      client_name: r.client_name,
      project_name: r.site_name || r.site_name_live || r.project_name || '—',
      site_id: r.site_id,
      invoice_number: r.invoice_number,
      invoice_date: r.invoice_date,
      due_date: r.due_date,
      invoice_amount: r.invoice_amount,
      outstanding_amount: r.outstanding_amount,
      ageing_days: days,
      ageing_bucket: r.ageing_bucket,
      level,
      level_num: levelNum,
      level_title: levelTitle,
      assigned_name: assignedName,
      action_required: actionRequired,
      is_material_blocked: days >= 60,
    };
  });

  const summary = {
    total_overdue: escalations.length,
    l1_ce: escalations.filter(e => e.level_num === 1).length,
    l2_pm: escalations.filter(e => e.level_num === 2).length,
    l3_head: escalations.filter(e => e.level_num === 3).length,
    l4_md: escalations.filter(e => e.level_num === 4).length,
    material_blocked_count: escalations.filter(e => e.is_material_blocked).length,
  };

  res.json({ escalations, summary, raci: raciData });
});

// ─── S5: 60-Day Material Supply Stop & Override API ────────────────────
function checkSiteMaterialBlock(db, siteId) {
  if (!siteId) return { blocked: false };
  const site = resolveSite(db, siteId);
  if (!site) return { blocked: false };
  const resolvedId = site.id;

  // Check oldest overdue receivable for this site
  const overdueRow = db.prepare(`
    SELECT MAX(ageing_days) as max_days, SUM(outstanding_amount) as total_overdue
    FROM receivables
    WHERE (site_id = ? OR LOWER(TRIM(site_name)) = LOWER(TRIM(?)) OR LOWER(TRIM(client_name)) = LOWER(TRIM(?)))
      AND outstanding_amount > 0
  `).get(resolvedId, site.name, site.client_name);

  const maxDays = Number(overdueRow?.max_days || 0);
  const totalOverdue = Number(overdueRow?.total_overdue || 0);

  if (maxDays < 60) {
    return { blocked: false, max_days: maxDays, total_overdue: totalOverdue };
  }

  // Check if active override exists
  const blockRow = db.prepare('SELECT * FROM site_material_blocks WHERE site_id=?').get(resolvedId);
  if (blockRow?.has_override === 1) {
    return {
      blocked: false,
      max_days: maxDays,
      total_overdue: totalOverdue,
      has_override: true,
      override_reason: blockRow.override_reason,
      overridden_by_name: blockRow.overridden_by_name,
      overridden_at: blockRow.overridden_at
    };
  }

  return {
    blocked: true,
    max_days: maxDays,
    total_overdue: totalOverdue,
    has_override: false,
    reason: `Material supply blocked per SOP-16.5: Site "${site.name}" has client receivables overdue by ${maxDays} days (>60 days limit). Total overdue: ₹${totalOverdue.toLocaleString('en-IN')}. Exception override from Department Head is required.`
  };
}

router.get('/supply-block-status/:site_id', (req, res) => {
  const db = getDb();
  const site = resolveSite(db, req.params.site_id);
  if (!site) return res.json({ blocked: false });
  res.json(checkSiteMaterialBlock(db, site.id));
});

router.post('/supply-block-override', (req, res) => {
  const db = getDb();
  const { site_id, override_reason } = req.body;
  if (!site_id) return res.status(400).json({ error: 'Site ID is required' });
  if (!override_reason || !String(override_reason).trim()) {
    return res.status(400).json({ error: 'A written justification reason is mandatory to grant an exception override' });
  }

  const site = resolveSite(db, site_id);
  if (!site) return res.status(404).json({ error: 'Site not found' });
  const resolvedId = site.id;

  // Update or insert site_material_blocks
  db.prepare(`
    INSERT INTO site_material_blocks (
      site_id, site_name, client_name, is_blocked, has_override,
      overridden_by, overridden_by_name, override_reason, overridden_at
    ) VALUES (?,?,?, 0, 1, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(site_id) DO UPDATE SET
      has_override = 1,
      overridden_by = excluded.overridden_by,
      overridden_by_name = excluded.overridden_by_name,
      override_reason = excluded.override_reason,
      overridden_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).run(resolvedId, site.name, site.client_name, req.user.id, req.user.name, String(override_reason).trim());

  // Also sync sites table
  db.prepare(`
    UPDATE sites
    SET material_supply_blocked = 0, material_override_reason = ?, material_overridden_by = ?
    WHERE id = ?
  `).run(String(override_reason).trim(), req.user.id, resolvedId);

  res.json({
    message: `Exception override granted for ${site.name}. Material supply is now authorized.`,
    site_id: resolvedId,
    overridden_by: req.user.name,
    override_reason
  });
});

// ─── S6: Thank-You Payment Receipts API ────────────────────────────────
router.post('/generate-receipt', (req, res) => {
  const db = getDb();
  const { collection_id, tds_deducted, notes, company_signatory } = req.body;
  if (!collection_id) return res.status(400).json({ error: 'Collection ID is required' });

  const col = db.prepare(`
    SELECT c.*, r.client_name, r.project_name, r.site_name, r.outstanding_amount, r.invoice_number
    FROM collections c
    JOIN receivables r ON r.id = c.receivable_id
    WHERE c.id = ?
  `).get(collection_id);

  if (!col) return res.status(404).json({ error: 'Collection record not found' });

  // Check if receipt already exists
  const existing = db.prepare('SELECT * FROM collection_receipts WHERE collection_id=?').get(collection_id);
  if (existing) {
    return res.json({ message: 'Receipt already exists', receipt: existing });
  }

  const receiptNo = nextSequence(db, 'collection_receipts', 'receipt_no', `REC-${new Date().getFullYear()}-`, { pad: 4 });
  const amtReceived = Number(col.amount || 0);
  const tds = Number(tds_deducted || 0);
  const totalCredit = amtReceived + tds;

  const insertRes = db.prepare(`
    INSERT INTO collection_receipts (
      receipt_no, collection_id, receivable_id, receipt_date, client_name, project_name, site_name,
      amount_received, tds_deducted, total_credit, outstanding_balance, payment_mode,
      transaction_ref, company_signatory, notes, generated_by, generated_by_name
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    receiptNo,
    col.id,
    col.receivable_id,
    col.collection_date || istToday(),
    col.client_name,
    col.project_name || col.site_name,
    col.site_name || col.project_name,
    amtReceived,
    tds,
    totalCredit,
    col.outstanding_amount,
    col.payment_mode || 'Bank Transfer',
    col.transaction_ref || '—',
    company_signatory || 'Accounts & Finance',
    notes || `Thank you for your payment towards ${col.invoice_number || 'project invoice'}.`,
    req.user.id,
    req.user.name
  );

  const receipt = db.prepare('SELECT * FROM collection_receipts WHERE id=?').get(insertRes.lastInsertRowid);
  res.status(201).json({ message: 'Thank-You Payment Receipt generated successfully', receipt });
});

router.get('/receipt/:id', (req, res) => {
  const db = getDb();
  const receipt = db.prepare('SELECT * FROM collection_receipts WHERE id=?').get(req.params.id);
  if (!receipt) return res.status(404).json({ error: 'Receipt not found' });
  res.json(receipt);
});

router.get('/receipt-by-collection/:collection_id', (req, res) => {
  const db = getDb();
  const receipt = db.prepare('SELECT * FROM collection_receipts WHERE collection_id=?').get(req.params.collection_id);
  res.json(receipt || null);
});

module.exports = {
  router,
  getCollectionRaci,
  checkSiteMaterialBlock
};
