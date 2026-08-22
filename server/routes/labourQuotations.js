// Labour Management System — Quotations.
//
// Raise a labour quotation, let the threshold rule decide whether it needs
// approval, and on approval generate the Work Order automatically.
//
// Cross-module reuse: client, contractor and project are picked from the
// modules that own that data (customers / sub_contractors / proj_projects /
// business_book) rather than re-entered. Names are stored alongside the id so
// a historical quotation still reads correctly if a master row is later
// renamed or deactivated — the id is the link, the name is the receipt.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');

const router = express.Router();
router.use(authMiddleware);

const MODULE = 'labour_quotation';
const canView = requirePermission(MODULE, 'view');
const canCreate = requirePermission(MODULE, 'create');
const canEdit = requirePermission(MODULE, 'edit');
const canDelete = requirePermission(MODULE, 'delete');
const canApprove = requirePermission(MODULE, 'approve');

// Company approval threshold. Stored in app_settings so finance can move it
// without a deploy; the value in force is snapshotted onto each quotation, so
// changing it never rewrites the rule an old quotation was judged under.
const DEFAULT_THRESHOLD = 200000;
const DEFAULT_RULE_NO = 1;

// Above-threshold quotations must be approved (or rejected) by a named senior
// — a logged-in "Admin" account is shared by several people day to day, so
// the account alone doesn't say who actually signed off. Fixed list rather
// than a role check: these are specific people, not everyone holding the
// labour_quotation approve permission.
const SENIOR_APPROVERS = ['Ankur Kalpesh', 'Nitin Jain', 'Prabhdeep Singh'];

function currentThreshold(db) {
  const row = db.prepare(`SELECT value FROM app_settings WHERE key='labour_quotation_threshold'`).get();
  const n = Number(row?.value);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_THRESHOLD;
}

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => { const t = String(v ?? '').trim(); return t || null; };

const COLS = `q.id, q.quotation_number, q.project_id, q.project_name, q.business_book_id,
  q.site_name, q.customer_id, q.client_name, q.contractor_id, q.contractor_name, q.contractor_aadhaar,
  q.labour_category, q.description, q.amount, q.threshold, q.rule_no, q.status,
  q.approved_by_name, q.approved_at, q.rejected_by_name, q.rejected_at, q.reject_reason,
  q.work_order_id, q.remarks, q.attachment_url, q.created_by, q.created_by_name, q.created_at, q.updated_at`;

/**
 * The threshold rule, in one place.
 *
 * Strictly above the threshold the quotation needs approval and carries the
 * rule number it was judged under. At or below it, it is cleared without
 * approval — ₹2,00,000 itself clears, only ₹2,00,000.01+ waits. Kept as a
 * pure function so the rule is testable and so the list, create and edit
 * paths can never disagree about it.
 */
function applyThresholdRule(amount, threshold) {
  return amount > threshold
    ? { threshold, rule_no: DEFAULT_RULE_NO, status: 'waiting_approval' }
    : { threshold, rule_no: null, status: 'below_threshold' };
}

// Shared by the auto (below-threshold) and manual (approve) paths so a Work
// Order is built identically either way — only who/when triggered it differs.
function insertWorkOrder(db, q, user) {
  const woNumber = nextSequence(db, 'proj_work_orders', 'wo_number', 'WO', { pad: 4 });
  const info = db.prepare(`
    INSERT INTO proj_work_orders
      (project_id, wo_number, sub_contractor_id, sub_contractor_name, scope,
       planned_value, amount_paid, status, quotation_id, created_by)
    VALUES (?,?,?,?,?,?,0,'draft',?,?)`).run(
    q.project_id, woNumber, q.contractor_id || null, q.contractor_name || null,
    q.description || q.labour_category || null, q.amount, q.id, user.id);
  return { id: info.lastInsertRowid, wo_number: woNumber };
}

// ─── Reference data for the form's dropdowns ──────────────────────────────
// One call rather than five, and every list comes from the module that owns
// it — no duplicate master data lives in the LMS.
router.get('/reference', canView, (req, res) => {
  const db = getDb();
  const safe = (sql) => { try { return db.prepare(sql).all(); } catch { return []; } };
  res.json({
    projects: safe(`SELECT id, name FROM proj_projects ORDER BY name`),
    sites: safe(`SELECT id, COALESCE(NULLIF(TRIM(project_name),''), client_name) AS name,
                        client_name, company_name, lead_no
                   FROM business_book ORDER BY id DESC LIMIT 500`),
    customers: safe(`SELECT id, COALESCE(NULLIF(TRIM(company_name),''), concern_person_name) AS name,
                            customer_code FROM customers ORDER BY name LIMIT 500`),
    contractors: safe(`SELECT id, name, specialization, phone FROM sub_contractors
                        WHERE COALESCE(status,'active') <> 'inactive' ORDER BY name LIMIT 500`),
    // Vendors double as contractors in this ERP — Procurement owns both.
    vendors: safe(`SELECT id, name, firm_name, category FROM vendors
                    WHERE active = 1 ORDER BY name LIMIT 500`),
    labour_categories: safe(`SELECT DISTINCT labour_category AS name FROM labour_rate_master
                              WHERE status='active' ORDER BY labour_category`),
    threshold: currentThreshold(db),
  });
});

// ─── List ─────────────────────────────────────────────────────────────────
router.get('/', canView, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.status) { where.push('q.status = ?'); args.push(q.status); }
  if (q.project_id) { where.push('q.project_id = ?'); args.push(q.project_id); }
  if (q.contractor_id) { where.push('q.contractor_id = ?'); args.push(q.contractor_id); }
  if (q.from) { where.push('DATE(q.created_at) >= DATE(?)'); args.push(q.from); }
  if (q.to) { where.push('DATE(q.created_at) <= DATE(?)'); args.push(q.to); }
  if (q.search) {
    where.push(`(q.quotation_number LIKE ? OR q.project_name LIKE ? OR q.client_name LIKE ?
                 OR q.contractor_name LIKE ? OR q.labour_category LIKE ? OR q.description LIKE ?)`);
    const like = `%${q.search}%`;
    args.push(like, like, like, like, like, like);
  }
  const sql = `FROM labour_quotations q ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const db = getDb();
  res.json({
    rows: db.prepare(`SELECT ${COLS}, wo.wo_number
                        ${sql.replace('FROM labour_quotations q',
                          'FROM labour_quotations q LEFT JOIN proj_work_orders wo ON wo.id = q.work_order_id')}
                       ORDER BY q.id DESC LIMIT 500`).all(...args),
    totals: db.prepare(`SELECT COUNT(*) c, COALESCE(SUM(q.amount),0) v ${sql}`).get(...args),
  });
});

router.get('/:id', canView, (req, res) => {
  const row = getDb().prepare(`
    SELECT ${COLS}, wo.wo_number FROM labour_quotations q
    LEFT JOIN proj_work_orders wo ON wo.id = q.work_order_id
     WHERE q.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Quotation not found' });
  res.json(row);
});

// ─── Create ───────────────────────────────────────────────────────────────
router.post('/', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const amount = num(b.amount);
  if (amount <= 0) return res.status(400).json({ error: 'Quotation amount must be more than zero' });
  if (!str(b.labour_category) && !str(b.description)) {
    return res.status(400).json({ error: 'Give at least a labour category or a description' });
  }

  const rule = applyThresholdRule(amount, currentThreshold(db));
  const quotation_number = str(b.quotation_number)
    || nextSequence(db, 'labour_quotations', 'quotation_number', 'QTN', { pad: 4 });

  // Below (or at) the threshold clears itself — build the Work Order in the
  // same transaction as the quotation so it never sits there with no way
  // forward. Needs a project to hang the WO off; without one it just stays
  // below_threshold until edited with a project, same as before.
  let quotationId, wo = null;
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO labour_quotations
        (quotation_number, project_id, project_name, business_book_id, site_name,
         customer_id, client_name, contractor_id, contractor_name, contractor_aadhaar,
         labour_category, description, amount, threshold, rule_no, status,
         remarks, attachment_url, created_by, created_by_name)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      quotation_number, b.project_id || null, str(b.project_name),
      b.business_book_id || null, str(b.site_name),
      b.customer_id || null, str(b.client_name),
      b.contractor_id || null, str(b.contractor_name), str(b.contractor_aadhaar),
      str(b.labour_category), str(b.description), amount,
      rule.threshold, rule.rule_no, rule.status,
      str(b.remarks), str(b.attachment_url), req.user.id, req.user.name || null);
    quotationId = info.lastInsertRowid;

    if (rule.status === 'below_threshold' && b.project_id) {
      const q = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(quotationId);
      wo = insertWorkOrder(db, q, req.user);
      db.prepare(`
        UPDATE labour_quotations SET status='wo_generated', work_order_id=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`).run(wo.id, quotationId);
    }
  });
  tx();

  logAuditEvent({
    user: req.user, action: 'CREATE', entity_type: 'labour_quotations',
    entity_id: quotationId,
    entity_label: `${quotation_number} — ₹${amount.toLocaleString('en-IN')} (${wo ? 'wo_generated' : rule.status})`,
    before: null, after: { amount, ...rule, work_order_id: wo?.id },
  });

  if (rule.status === 'waiting_approval') notifyApprovers(db, req.user, quotation_number, amount);

  res.status(201).json({
    id: quotationId, quotation_number, ...rule,
    status: wo ? 'wo_generated' : rule.status,
    work_order_id: wo?.id, wo_number: wo?.wo_number,
  });
});

// ─── Update ───────────────────────────────────────────────────────────────
// Editing is blocked once approved: the Work Order and its labour costing hang
// off the approved figure, so changing it after the fact would silently
// invalidate them.
router.put('/:id', canEdit, (req, res) => {
  const db = getDb();
  const before = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(req.params.id);
  if (!before) return res.status(404).json({ error: 'Quotation not found' });
  if (['approved', 'wo_generated'].includes(before.status)) {
    return res.status(409).json({
      error: 'This quotation is already approved and has a Work Order against it. Create a new quotation instead of editing this one.',
    });
  }

  const b = req.body || {};
  const amount = b.amount != null ? num(b.amount) : before.amount;
  if (amount <= 0) return res.status(400).json({ error: 'Quotation amount must be more than zero' });

  // Re-run the rule: raising an amount past the threshold must pull the
  // quotation back into the approval queue rather than leaving it cleared.
  const rule = applyThresholdRule(amount, before.threshold || currentThreshold(db));

  db.prepare(`
    UPDATE labour_quotations SET
      project_id = ?, project_name = ?, business_book_id = ?, site_name = ?,
      customer_id = ?, client_name = ?, contractor_id = ?, contractor_name = ?, contractor_aadhaar = ?,
      labour_category = ?, description = ?, amount = ?,
      threshold = ?, rule_no = ?, status = ?, remarks = ?, attachment_url = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`).run(
    b.project_id !== undefined ? (b.project_id || null) : before.project_id,
    b.project_name !== undefined ? str(b.project_name) : before.project_name,
    b.business_book_id !== undefined ? (b.business_book_id || null) : before.business_book_id,
    b.site_name !== undefined ? str(b.site_name) : before.site_name,
    b.customer_id !== undefined ? (b.customer_id || null) : before.customer_id,
    b.client_name !== undefined ? str(b.client_name) : before.client_name,
    b.contractor_id !== undefined ? (b.contractor_id || null) : before.contractor_id,
    b.contractor_name !== undefined ? str(b.contractor_name) : before.contractor_name,
    b.contractor_aadhaar !== undefined ? str(b.contractor_aadhaar) : before.contractor_aadhaar,
    b.labour_category !== undefined ? str(b.labour_category) : before.labour_category,
    b.description !== undefined ? str(b.description) : before.description,
    amount, rule.threshold, rule.rule_no, rule.status,
    b.remarks !== undefined ? str(b.remarks) : before.remarks,
    b.attachment_url !== undefined ? str(b.attachment_url) : before.attachment_url,
    req.params.id);

  const after = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(req.params.id);
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'labour_quotations',
    entity_id: after.id, entity_label: after.quotation_number, before, after,
  });
  res.json({ message: 'Quotation updated', ...rule });
});

// ─── Approve → generate the Work Order ────────────────────────────────────
// One transaction: the quotation is marked approved and its Work Order created
// together, so a crash can never leave an approved quotation with no WO or a
// WO with no quotation behind it.
router.post('/:id/approve', canApprove, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.status === 'approved' || q.status === 'wo_generated') {
    return res.status(409).json({ error: 'Already approved.', work_order_id: q.work_order_id });
  }
  if (q.status === 'rejected') {
    return res.status(409).json({ error: 'This quotation was rejected. Raise a new one.' });
  }
  // Separation of duties: the raiser cannot approve their own quotation.
  // Admin is exempt, matching how the indent approval gates already behave.
  if (q.created_by === req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'You raised this quotation — someone else has to approve it.' });
  }
  if (!q.project_id) {
    return res.status(400).json({
      error: 'Pick a Project on the quotation before approving — the Work Order is created against it.',
    });
  }
  // Rule 1 (above-threshold) quotations need a named senior's sign-off on
  // record. Below-threshold quotations clear on their own and never reach
  // this route, so this only ever gates the >₹2,00,000 case.
  const approverName = str(req.body?.approved_by_name);
  if (q.rule_no && !SENIOR_APPROVERS.includes(approverName)) {
    return res.status(400).json({
      error: `Pick who is approving this — one of ${SENIOR_APPROVERS.join(', ')}.`,
    });
  }

  let wo;
  try {
    const tx = db.transaction(() => {
      wo = insertWorkOrder(db, q, req.user);
      db.prepare(`
        UPDATE labour_quotations
           SET status='wo_generated', approved_by=?, approved_by_name=?,
               approved_at=CURRENT_TIMESTAMP, work_order_id=?, updated_at=CURRENT_TIMESTAMP
         WHERE id=?`).run(req.user.id, approverName || req.user.name || null, wo.id, q.id);
    });
    tx();
  } catch (e) {
    return res.status(500).json({ error: 'Could not generate the Work Order: ' + e.message });
  }
  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'labour_quotations',
    entity_id: q.id, entity_label: `${q.quotation_number} approved → ${wo.wo_number}`,
    before: { status: q.status }, after: { status: 'wo_generated', work_order_id: wo.id },
  });
  notifyCreator(db, q, `Quotation ${q.quotation_number} approved`,
    `Your quotation was approved and Work Order ${wo.wo_number} has been created. Open it to add labour from the Labour Rate Window.`);

  res.json({ message: 'Approved', work_order_id: wo.id, wo_number: wo.wo_number });
});

router.post('/:id/reject', canApprove, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (['approved', 'wo_generated', 'rejected'].includes(q.status)) {
    return res.status(409).json({ error: `Already ${q.status.replace('_', ' ')}.` });
  }
  const reason = str(req.body?.reason);
  if (!reason || reason.length < 3) {
    return res.status(400).json({ error: 'Give a reason for the rejection.' });
  }
  const rejectorName = str(req.body?.rejected_by_name);
  if (q.rule_no && !SENIOR_APPROVERS.includes(rejectorName)) {
    return res.status(400).json({
      error: `Pick who is rejecting this — one of ${SENIOR_APPROVERS.join(', ')}.`,
    });
  }
  db.prepare(`
    UPDATE labour_quotations SET status='rejected', rejected_by=?, rejected_by_name=?,
           rejected_at=CURRENT_TIMESTAMP, reject_reason=?, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`).run(req.user.id, rejectorName || req.user.name || null, reason, q.id);

  logAuditEvent({
    user: req.user, action: 'UPDATE', entity_type: 'labour_quotations',
    entity_id: q.id, entity_label: `${q.quotation_number} rejected`,
    before: { status: q.status }, after: { status: 'rejected', reason },
  });
  notifyCreator(db, q, `Quotation ${q.quotation_number} rejected`, `Reason: ${reason}`);
  res.json({ message: 'Rejected' });
});

// ─── Delete ───────────────────────────────────────────────────────────────
router.delete('/:id', canDelete, (req, res) => {
  const db = getDb();
  const q = db.prepare('SELECT * FROM labour_quotations WHERE id=?').get(req.params.id);
  if (!q) return res.status(404).json({ error: 'Quotation not found' });
  if (q.work_order_id) {
    return res.status(409).json({
      error: 'A Work Order was generated from this quotation. Delete the Work Order first, or leave the quotation for the audit trail.',
    });
  }
  db.prepare('DELETE FROM labour_quotations WHERE id=?').run(q.id);
  logAuditEvent({
    user: req.user, action: 'DELETE', entity_type: 'labour_quotations',
    entity_id: q.id, entity_label: q.quotation_number, before: q, after: null,
  });
  res.json({ message: 'Deleted' });
});

// ─── Dashboard ────────────────────────────────────────────────────────────
router.get('/reports/dashboard', canView, (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  res.json({
    cards: {
      total_quotations: one('SELECT COUNT(*) c FROM labour_quotations').c,
      waiting_approval: one(`SELECT COUNT(*) c FROM labour_quotations WHERE status='waiting_approval'`).c,
      below_threshold: one(`SELECT COUNT(*) c FROM labour_quotations WHERE status='below_threshold'`).c,
      approved: one(`SELECT COUNT(*) c FROM labour_quotations WHERE status IN ('approved','wo_generated')`).c,
      rejected: one(`SELECT COUNT(*) c FROM labour_quotations WHERE status='rejected'`).c,
      work_orders: one('SELECT COUNT(*) c FROM proj_work_orders').c,
      quoted_value: one('SELECT COALESCE(SUM(amount),0) v FROM labour_quotations').v,
      approved_value: one(`SELECT COALESCE(SUM(amount),0) v FROM labour_quotations
         WHERE status IN ('approved','wo_generated')`).v,
      labour_cost: one('SELECT COALESCE(SUM(amount + COALESCE(overtime_amount,0)),0) v FROM proj_wo_labour').v,
      active_contractors: one(`SELECT COUNT(DISTINCT contractor_id) c FROM labour_quotations
         WHERE contractor_id IS NOT NULL`).c,
      active_sites: one('SELECT COUNT(DISTINCT project_id) c FROM labour_quotations WHERE project_id IS NOT NULL').c,
    },
    by_status: db.prepare(`
      SELECT status AS name, COUNT(*) AS c, COALESCE(SUM(amount),0) AS value
        FROM labour_quotations GROUP BY status ORDER BY c DESC`).all(),
    recent: db.prepare(`
      SELECT ${COLS} FROM labour_quotations q ORDER BY q.id DESC LIMIT 10`).all(),
    pending_approvals: db.prepare(`
      SELECT ${COLS} FROM labour_quotations q
       WHERE q.status='waiting_approval' ORDER BY q.amount DESC LIMIT 10`).all(),
  });
});

// ─── Notifications ────────────────────────────────────────────────────────
function notifyApprovers(db, actor, quotationNumber, amount) {
  try {
    const recipients = db.prepare(`
      SELECT DISTINCT u.id FROM users u
       WHERE u.role='admin'
          OR u.id IN (SELECT ur.user_id FROM user_roles ur
                        JOIN role_permissions rp ON rp.role_id = ur.role_id
                       WHERE rp.module='labour_quotation' AND rp.can_approve=1)`).all();
    const ins = db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?, 'labour_quotation', ?, ?, '/labour-quotations', 'in_app', ?)`);
    for (const r of recipients) {
      const key = `labour_quotation:${quotationNumber}:${r.id}`;
      if (!db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(r.id, key)) {
        ins.run(r.id, `Quotation ${quotationNumber} needs approval`,
          `₹${Math.round(amount).toLocaleString('en-IN')} raised by ${actor?.name || 'a user'} crossed the approval threshold.`, key);
      }
    }
  } catch (e) { console.warn('[labour-quotation] notify failed:', e.message); }
}

function notifyCreator(db, quotation, title, body) {
  try {
    if (!quotation.created_by) return;
    const key = `labour_quotation_result:${quotation.id}`;
    if (db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(quotation.created_by, key)) return;
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?, 'labour_quotation', ?, ?, '/labour-quotations', 'in_app', ?)`)
      .run(quotation.created_by, title, body, key);
  } catch (e) { console.warn('[labour-quotation] notify failed:', e.message); }
}

module.exports = router;
