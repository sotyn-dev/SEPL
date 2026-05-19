const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Helper: does the user see EVERY payment request, or only their own?
// Admin always sees all. Otherwise the user sees all iff one of their
// roles has either can_approve=1 OR can_see_all=1 on payment_required.
// can_see_all is the explicit "scope=ALL" toggle mam can flip in
// Roles & Permissions UI, decoupled from approval power.
const seesAll = (req) => {
  if (req.user.role === 'admin') return true;
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'payment_required'
  `).get(req.user.id);
  return !!row?.ok;
};

// Approval workflow based on category
// TA/DA: Step 1 → Step 2 → Step 5 (skip velocity & billing eng)
// Others: Step 1 → Step 2 → Step 3 (velocity auto) → Step 4 → Step 5
const WORKFLOW = {
  'TA/DA': [
    { step: 1, name: 'HR Approval', approver_role: 'HR Manager' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
  'Purchase': [
    { step: 1, name: 'Purchase Head Approval', approver_role: 'Purchase Manager' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 3, name: 'Velocity Check (Auto)', approver_role: 'System' },
    { step: 4, name: 'Billing Engineer Approval', approver_role: 'Billing Engineer' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
  'Labour': [
    { step: 1, name: 'Site Engineer Approval', approver_role: 'Site Engineer' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 3, name: 'Velocity Check (Auto)', approver_role: 'System' },
    { step: 4, name: 'Billing Engineer Approval', approver_role: 'Billing Engineer' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
  'Transport': [
    { step: 1, name: 'Purchase Dept Approval', approver_role: 'Purchase Manager' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 3, name: 'Velocity Check (Auto)', approver_role: 'System' },
    { step: 4, name: 'Billing Engineer Approval', approver_role: 'Billing Engineer' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
  // Payroll / statutory payments — lighter approval (HR → Accountant → Release).
  'Salary': [
    { step: 1, name: 'HR Approval', approver_role: 'HR Manager' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
  'Compliance': [
    { step: 1, name: 'HR Approval', approver_role: 'HR Manager' },
    { step: 2, name: 'Accountant Approval', approver_role: 'Accountant' },
    { step: 5, name: 'Payment Release', approver_role: 'Accountant' },
  ],
};

// Per-step approver override table (mam, 2026-05-16: "i want hr
// approval will give to anchal how can be it dynamic all steps").
// Idempotent migration — admin can now route any (category, step)
// to a specific user, bypassing the role-based default.  Empty row
// or no row at all = fall back to role-based check (old behaviour).
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS payment_approval_overrides (
      category TEXT NOT NULL,
      step INTEGER NOT NULL,
      user_id INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      PRIMARY KEY (category, step)
    )
  `);
} catch (_) {}

function getApprovalRoutingFor(db, category, step) {
  try {
    const row = db.prepare(`SELECT user_id FROM payment_approval_overrides WHERE category=? AND step=?`).get(category, step);
    return row?.user_id || null;
  } catch (_) { return null; }
}

function canUserApproveStep(db, userId, category, step) {
  const workflow = WORKFLOW[category];
  if (!workflow) return false;
  const stepInfo = workflow.find(w => w.step === step);
  if (!stepInfo) return false;
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(userId);
  if (user?.role === 'admin') return true;
  // Explicit override wins.  Only the assigned user (or admin) can
  // approve when an override is set.  No fallback to role-based —
  // that's the point of the override.
  const overrideUserId = getApprovalRoutingFor(db, category, step);
  if (overrideUserId) {
    return overrideUserId === userId;
  }
  // No override → role-based fallback (the original behaviour).
  const userRoles = db.prepare(`SELECT r.name FROM user_roles ur JOIN roles r ON ur.role_id=r.id WHERE ur.user_id=?`).all(userId);
  return userRoles.some(r => r.name === stepInfo.approver_role);
}

// Check if project/site is in top 3 by cash velocity (z-a)
function isInTop3Velocity(db, siteName) {
  if (!siteName) return false;
  try {
    // Get all projects with their velocity calculated
    const projects = db.prepare(`SELECT bb.company_name, bb.sale_amount_without_gst,
      (SELECT COALESCE(SUM(amount),0) FROM cash_flow_entries WHERE type='inflow' AND party_name LIKE '%' || bb.client_name || '%') as received,
      (SELECT COALESCE(SUM(amount),0) FROM payment_requests WHERE status='final_approved' AND site_name LIKE '%' || bb.company_name || '%') as purchase,
      (SELECT COALESCE(aanchal_value*100000, 0) FROM project_finance WHERE business_book_id=bb.id) as aanchal,
      (SELECT COALESCE(payment_days, 0) FROM project_finance WHERE business_book_id=bb.id) as pdays
      FROM business_book bb GROUP BY bb.company_name`).all();

    const withVelocity = projects.map(p => {
      const totalDays = (p.pdays || 0) + 30; // approx completion
      const velocity = totalDays > 0 ? (p.aanchal - p.purchase) / totalDays : 0;
      return { name: p.company_name, velocity };
    });

    // Sort descending (z-a by velocity)
    withVelocity.sort((a, b) => b.velocity - a.velocity);
    const top3 = withVelocity.slice(0, 3);
    return top3.some(t => (siteName || '').toLowerCase().includes((t.name || '').toLowerCase()) || (t.name || '').toLowerCase().includes((siteName || '').toLowerCase()));
  } catch (e) { return false; }
}

// GET all with filters
router.get('/', requirePermission('payment_required', 'view'), (req, res) => {
  const { status, category, search, step } = req.query;
  let sql = `SELECT pr.*, u.name as created_by_name FROM payment_requests pr LEFT JOIN users u ON pr.created_by=u.id WHERE 1=1`;
  const params = [];
  // Scope filter: non-approvers (e.g. site engineers) only see their own
  // requests. Approvers / admin see everything.
  if (!seesAll(req)) { sql += ' AND pr.created_by = ?'; params.push(req.user.id); }
  if (status) { sql += ' AND pr.status=?'; params.push(status); }
  if (category) { sql += ' AND pr.category=?'; params.push(category); }
  if (step) { sql += ' AND pr.current_step=?'; params.push(step); }
  if (search) {
    sql += ' AND (pr.employee_name LIKE ? OR pr.request_no LIKE ? OR pr.purpose LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY pr.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

// GET stats — scoped same way as the list. A site engineer's "totals"
// reflect only their own requests so the cards don't expose other users'
// activity.
router.get('/stats', requirePermission('payment_required', 'view'), (req, res) => {
  const db = getDb();
  const all = seesAll(req);
  const where = all ? '' : ' WHERE created_by = ?';
  const args = all ? [] : [req.user.id];
  const total = db.prepare(`SELECT COUNT(*) as c FROM payment_requests${where}`).get(...args);
  const totalAmount = db.prepare(`SELECT COALESCE(SUM(amount),0) as t FROM payment_requests${where}`).get(...args);
  const pending = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE status NOT IN ('final_approved','rejected')${all ? '' : ' AND created_by = ?'}`).get(...args);
  const approved = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE status='final_approved'${all ? '' : ' AND created_by = ?'}`).get(...args);
  const rejected = db.prepare(`SELECT COUNT(*) as c FROM payment_requests WHERE status='rejected'${all ? '' : ' AND created_by = ?'}`).get(...args);
  const byCategory = db.prepare(`SELECT category, COUNT(*) as count, COALESCE(SUM(amount),0) as amount FROM payment_requests${where} GROUP BY category`).all(...args);
  const byStep = db.prepare(`SELECT current_step, COUNT(*) as count FROM payment_requests WHERE status NOT IN ('final_approved','rejected')${all ? '' : ' AND created_by = ?'} GROUP BY current_step`).all(...args);
  res.json({ total: total.c, totalAmount: totalAmount.t, pending: pending.c, approved: approved.c, rejected: rejected.c, byCategory, byStep });
});

// GET single with workflow
router.get('/:id', requirePermission('payment_required', 'view'), (req, res) => {
  // Defensive ownership check — even if an approver-only ID leaks into
  // another user's URL, the GET must respect the scope rule.
  const db = getDb();
  const ownRow = db.prepare('SELECT created_by FROM payment_requests WHERE id=?').get(req.params.id);
  if (!ownRow) return res.status(404).json({ error: 'Not found' });
  if (!seesAll(req) && ownRow.created_by !== req.user.id) {
    return res.status(403).json({ error: 'You can only view your own requests' });
  }
  const request = db.prepare('SELECT pr.*, u.name as created_by_name FROM payment_requests pr LEFT JOIN users u ON pr.created_by=u.id WHERE pr.id=?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  request.approvals = db.prepare(`SELECT pa.*, u.name as approved_by_name FROM payment_approvals pa LEFT JOIN users u ON pa.approved_by=u.id WHERE pa.request_id=? ORDER BY pa.step`).all(req.params.id);
  request.workflow = WORKFLOW[request.category] || [];
  request.can_approve_current = canUserApproveStep(db, req.user.id, request.category, request.current_step);
  res.json(request);
});

// POST create
router.post('/', requirePermission('payment_required', 'create'), (req, res) => {
  const b = req.body;
  if (!b.employee_name || !b.category || !b.amount || !b.purpose) {
    return res.status(400).json({ error: 'Employee, category, amount, purpose required' });
  }
  if (!WORKFLOW[b.category]) return res.status(400).json({ error: 'Invalid category' });
  // Vendor Name is mandatory for Purchase category (who are we paying?).
  if (b.category === 'Purchase' && !String(b.vendor_name || '').trim()) {
    return res.status(400).json({ error: 'Vendor name is required for Purchase requests' });
  }
  // Mandatory proofs by category + mode — keeps the audit trail clean.
  // Mam's rule: 'proofs must be uploaded at request time, not after'.
  const missingProofs = [];
  if (b.category === 'TA/DA') {
    if (['Bus','Train','Flight'].includes(b.mode_of_travel) && !b.ticket_upload) {
      missingProofs.push('Travel Ticket');
    }
    if (['Car','Bike'].includes(b.mode_of_travel)) {
      if (!b.km_photo) missingProofs.push('Start KM Photo');
      if (!b.end_km_photo) missingProofs.push('End KM Photo');
    }
  }
  if (b.category === 'Purchase' && !b.quotation_link) {
    missingProofs.push('Quotation / Purchase Order');
  }
  if (missingProofs.length > 0) {
    return res.status(400).json({ error: `Upload required proof${missingProofs.length > 1 ? 's' : ''} before submitting: ${missingProofs.join(', ')}` });
  }
  // Required By Date must be at least 5 days out — immediate payouts aren't possible.
  if (b.required_by_date) {
    const minDate = new Date(); minDate.setHours(0,0,0,0); minDate.setDate(minDate.getDate() + 5);
    const reqDate = new Date(b.required_by_date);
    if (reqDate < minDate) {
      return res.status(400).json({ error: `Required By Date must be on or after ${minDate.toISOString().split('T')[0]} (today + 5 days)` });
    }
  }
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const yr = new Date().getFullYear();
  // Schema column is `request_no` (NOT request_number) — earlier mismatch
  // crashed the create with "no such column: request_number" on the live VPS.
  const requestNo = nextSequence(db, 'payment_requests', 'request_no', `PR-${yr}-`, { startFrom: 0, pad: 4 });

  // Ensure extra columns exist
  try { db.exec('ALTER TABLE payment_requests ADD COLUMN ticket_upload TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE payment_requests ADD COLUMN start_km REAL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE payment_requests ADD COLUMN end_km REAL DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE payment_requests ADD COLUMN km_photo TEXT'); } catch(e) {}
  try { db.exec('ALTER TABLE payment_requests ADD COLUMN end_km_photo TEXT'); } catch(e) {}

  const r = db.prepare(`INSERT INTO payment_requests (
    request_no, employee_name, site_id, site_name, department, contact_number, category, amount, purpose,
    payment_mode, required_by_date,
    travel_from_to, travel_dates, mode_of_travel, stay_details, ticket_upload, start_km, end_km, km_photo, end_km_photo,
    indent_number, item_description, vendor_name, quotation_link,
    labour_type, number_of_workers, work_duration, site_engineer_name,
    vehicle_type, from_to_location, material_description, driver_vendor_name,
    created_by
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    requestNo, b.employee_name, b.site_id || null, b.site_name, b.department, b.contact_number,
    b.category, b.amount, b.purpose, b.payment_mode || 'Bank', b.required_by_date || null,
    b.travel_from_to, b.travel_dates, b.mode_of_travel, b.stay_details,
    b.ticket_upload, b.start_km || 0, b.end_km || 0, b.km_photo, b.end_km_photo,
    b.indent_number, b.item_description, b.vendor_name, b.quotation_link,
    b.labour_type, b.number_of_workers || 0, b.work_duration, b.site_engineer_name,
    b.vehicle_type, b.from_to_location, b.material_description, b.driver_vendor_name,
    req.user.id
  );
  // Push to step-1 approvers (everyone with payment_required.approve permission)
  try {
    const { notifyMany } = require('../lib/push');
    const approvers = db.prepare(`
      SELECT DISTINCT u.id FROM users u
      LEFT JOIN user_roles ur ON ur.user_id = u.id
      LEFT JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE COALESCE(u.active,1)=1
        AND (u.role='admin' OR (rp.module='payment_required' AND rp.can_approve=1))
    `).all().map(x => x.id);
    notifyMany(approvers, {
      title: `💸 ${requestNo} — ${b.category} Rs ${(b.amount || 0).toLocaleString('en-IN')}`,
      body: `${b.employee_name}: ${b.purpose}`.slice(0, 180),
      url: '/payment-required',
      tag: `payment-${r.lastInsertRowid}`,
    });
  } catch {}
  res.status(201).json({ id: r.lastInsertRowid, request_no: requestNo });
});

// Helper: advance to next step
function advanceToNextStep(db, request, approvedBy) {
  const workflow = WORKFLOW[request.category];
  const currentStepIdx = workflow.findIndex(w => w.step === request.current_step);
  const nextStepInfo = workflow[currentStepIdx + 1];

  if (!nextStepInfo) {
    // Last step - final approved
    db.prepare('UPDATE payment_requests SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run('final_approved', request.id);
    // Add to cash flow outflow
    try {
      const today = new Date().toISOString().split('T')[0];
      let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date=?').get(today);
      if (!daily) {
        const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
        const dr = db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?,?,?)').run(today, prev?.closing_balance || 0, prev?.closing_balance || 0);
        daily = { id: dr.lastInsertRowid };
      }
      db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, party_name, created_by) VALUES (?,?,?,?,?,?,?,?)')
        .run(daily.id, today, 'outflow', request.category, `Payment: ${request.request_no} - ${request.purpose}`, request.amount, request.employee_name, approvedBy);
    } catch (e) {}
    return 'final_approved';
  }

  // Move to next step
  db.prepare('UPDATE payment_requests SET current_step=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nextStepInfo.step, request.id);

  // If next step is velocity check (Step 3), auto-approve if in top 3
  if (nextStepInfo.step === 3) {
    const inTop3 = isInTop3Velocity(db, request.site_name);
    if (inTop3) {
      db.prepare('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)')
        .run(request.id, 3, 'Velocity Check (Auto)', 'approved', `Auto-approved: Project in TOP 3 by velocity`, approvedBy);
      const newReq = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(request.id);
      return advanceToNextStep(db, newReq, approvedBy);
    } else {
      db.prepare('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)')
        .run(request.id, 3, 'Velocity Check (Auto)', 'rejected', 'Auto-rejected: Project not in TOP 3 by velocity', approvedBy);
      db.prepare('UPDATE payment_requests SET status=?, rejection_remarks=? WHERE id=?').run('rejected', 'Auto-rejected at velocity check (not in top 3)', request.id);
      return 'rejected_velocity';
    }
  }

  return 'step_advanced';
}

// PUT approve
router.put('/:id/approve', requirePermission('payment_required', 'approve'), (req, res) => {
  const { remarks } = req.body;
  if (!remarks || remarks.trim().length < 5) return res.status(400).json({ error: 'Remarks required (min 5 chars)' });
  const db = getDb();
  const request = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.status === 'final_approved' || request.status === 'rejected') return res.status(400).json({ error: 'Already ' + request.status });

  if (!canUserApproveStep(db, req.user.id, request.category, request.current_step)) {
    const workflow = WORKFLOW[request.category];
    const stepInfo = workflow?.find(w => w.step === request.current_step);
    return res.status(403).json({ error: `Not authorized. This step requires: ${stepInfo?.approver_role}` });
  }

  const workflow = WORKFLOW[request.category];
  const stepInfo = workflow.find(w => w.step === request.current_step);
  db.prepare('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)')
    .run(request.id, request.current_step, stepInfo.name, 'approved', remarks, req.user.id);

  const result = advanceToNextStep(db, request, req.user.id);
  res.json({ message: `${stepInfo.name} approved`, result });
});

// PUT reject
router.put('/:id/reject', requirePermission('payment_required', 'approve'), (req, res) => {
  const { remarks } = req.body;
  if (!remarks || remarks.trim().length < 5) return res.status(400).json({ error: 'Remarks required' });
  const db = getDb();
  const request = db.prepare('SELECT * FROM payment_requests WHERE id=?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (!canUserApproveStep(db, req.user.id, request.category, request.current_step)) return res.status(403).json({ error: 'Not authorized' });

  const stepInfo = WORKFLOW[request.category]?.find(w => w.step === request.current_step);
  db.prepare('INSERT INTO payment_approvals (request_id, step, step_name, action, remarks, approved_by) VALUES (?,?,?,?,?,?)')
    .run(request.id, request.current_step, stepInfo?.name || 'Unknown', 'rejected', remarks, req.user.id);
  db.prepare('UPDATE payment_requests SET status=?, rejection_remarks=?, rejected_by=?, rejected_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('rejected', remarks, req.user.id, request.id);
  res.json({ message: 'Rejected' });
});

router.delete('/:id', requirePermission('payment_required', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM payment_approvals WHERE request_id=?').run(req.params.id);
  db.prepare('DELETE FROM payment_requests WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// PATCH attach a proof URL to an existing request. Some users miss the
// upload step on the form and the approver only sees "No proofs uploaded"
// — this endpoint lets the original creator OR an approver fix it after
// the fact, before the request is finalised.
//   field options: ticket_upload | km_photo | end_km_photo | quotation_link | attachment_link
router.patch('/:id/proof', requirePermission('payment_required', 'view'), (req, res) => {
  const { field, url } = req.body;
  const allowed = ['ticket_upload', 'km_photo', 'end_km_photo', 'quotation_link', 'attachment_link'];
  if (!allowed.includes(field)) return res.status(400).json({ error: 'Invalid proof field' });
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'URL required' });
  const db = getDb();
  const request = db.prepare('SELECT created_by, status, category FROM payment_requests WHERE id=?').get(req.params.id);
  if (!request) return res.status(404).json({ error: 'Not found' });
  if (request.status === 'final_approved' || request.status === 'rejected') {
    return res.status(400).json({ error: 'Cannot edit proofs on finalised request' });
  }
  // Permission: admin, original creator, OR anyone who can approve this category
  const isOwner = request.created_by === req.user.id;
  const isAdmin = req.user.role === 'admin';
  const canApprove = canUserApproveStep(db, req.user.id, request.category, 1) ||
                     canUserApproveStep(db, req.user.id, request.category, 2) ||
                     canUserApproveStep(db, req.user.id, request.category, 4) ||
                     canUserApproveStep(db, req.user.id, request.category, 5);
  if (!isOwner && !isAdmin && !canApprove) {
    return res.status(403).json({ error: 'Only the request creator or an approver can attach proofs' });
  }
  db.prepare(`UPDATE payment_requests SET ${field} = ? WHERE id = ?`).run(url, req.params.id);
  res.json({ message: 'Proof attached', field, url });
});

// ── GET / PUT approval routing ─────────────────────────────────
// Returns the full matrix of categories × steps with current
// assignee (override if set, else NULL = role-based fallback).
// Used by the admin UI to render the routing table.
// Helper: make sure the override table exists.  Module-load CREATE
// can race with DB init on fresh boots, so we self-heal here.
function ensureOverrideTable(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS payment_approval_overrides (
        category TEXT NOT NULL,
        step INTEGER NOT NULL,
        user_id INTEGER REFERENCES users(id),
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_by INTEGER REFERENCES users(id),
        PRIMARY KEY (category, step)
      )
    `);
  } catch (_) { /* fine — table already exists or db locked momentarily */ }
}

router.get('/approval-routing', (req, res) => {
  try {
    const db = getDb();
    ensureOverrideTable(db);
    let overrides = [];
    try {
      overrides = db.prepare(`
        SELECT o.category, o.step, o.user_id, u.name as user_name
        FROM payment_approval_overrides o
        LEFT JOIN users u ON o.user_id = u.id
      `).all();
    } catch (e) {
      // Table genuinely missing (fresh DB) — fall through with empty map
      console.warn('[payment-required/approval-routing] overrides table read failed:', e.message);
    }
    const map = {};
    for (const o of overrides) {
      map[`${o.category}_${o.step}`] = { user_id: o.user_id, user_name: o.user_name };
    }
    // Build the response by walking the static WORKFLOW so admin sees
    // every step that exists per category, with the current assignee
    // (override > NULL).
    const matrix = {};
    for (const [category, steps] of Object.entries(WORKFLOW)) {
      matrix[category] = steps.map(s => {
        const o = map[`${category}_${s.step}`];
        return {
          step: s.step,
          name: s.name,
          role_default: s.approver_role,
          override_user_id: o?.user_id || null,
          override_user_name: o?.user_name || null,
        };
      });
    }
    res.json({ matrix });
  } catch (e) {
    console.error('[payment-required/approval-routing GET] failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.put('/approval-routing', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  ensureOverrideTable(db);
  const { category, step, user_id } = req.body || {};
  if (!category || !step) return res.status(400).json({ error: 'category and step required' });
  if (!WORKFLOW[category]) return res.status(400).json({ error: 'unknown category' });
  if (!WORKFLOW[category].find(s => s.step === +step)) return res.status(400).json({ error: 'unknown step for that category' });

  // user_id = null clears the override (returns to role-based)
  if (user_id == null || user_id === '' || user_id === 0) {
    db.prepare(`DELETE FROM payment_approval_overrides WHERE category=? AND step=?`).run(category, +step);
    return res.json({ cleared: true });
  }
  // Validate user exists
  const u = db.prepare(`SELECT id, name FROM users WHERE id=?`).get(+user_id);
  if (!u) return res.status(400).json({ error: 'unknown user_id' });
  db.prepare(`
    INSERT INTO payment_approval_overrides (category, step, user_id, updated_at, updated_by)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(category, step) DO UPDATE SET user_id=excluded.user_id,
      updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by
  `).run(category, +step, +user_id, req.user.id);
  res.json({ category, step: +step, user_id: u.id, user_name: u.name });
});

module.exports = router;
