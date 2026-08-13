// Labour Management System — Modules 4-6: Bill Verification chain,
// Bills & Finance, Payments.
//
// One continuous pipeline over the EXISTING proj_contractor_ra_bills table
// (raised/payment/paid) — no parallel bill system. current_stage walks the
// simplified 4-stage chain (2026-08, shortened from the original 6):
//   contractor_uploaded -> site_engineer -> finance -> payment
// Verify advances one stage; Reject kills the bill; Send Back returns it to
// the contractor for correction. Module 5's "Bills & Finance" checks
// (invoice/GST/tax/previous-payment) are captured at the finance stage on
// the same row, since they describe ONE bill, not a separate entity.
// Module 6's Payments are the terminal 'payment' stage, which also posts to
// vendor_ledger.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');

const router = express.Router();
router.use(authMiddleware);

const MODULE = 'bill_verification';
const canCreate = requirePermission(MODULE, 'create');
const canApprove = requirePermission(MODULE, 'approve');

function canRead(req, res, next) {
  if (req.user?.role === 'admin') return next();
  const row = getDb().prepare(`
    SELECT MAX(rp.can_view) AS ok FROM role_permissions rp
      JOIN user_roles ur ON ur.role_id = rp.role_id
     WHERE ur.user_id = ? AND rp.module IN (?, 'indent_labour_payment')
  `).get(req.user.id, MODULE);
  if (row?.ok) return next();
  return res.status(403).json({ error: 'No access to bill verification' });
}

const str = (v) => { const t = String(v ?? '').trim(); return t || null; };
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

// Chain order — index also doubles as "how far along" for progress bars.
// Simplified 4-stage chain (2026-08): Contractor Upload -> Site Engineer ->
// Finance -> Payment. proj_bill_stage_log's CHECK still allows the older
// site_head/project_manager/accounts values (never remove a value old rows
// might hold) — they're just not reachable from this STAGES list anymore.
const STAGES = ['contractor_uploaded', 'site_engineer', 'finance', 'payment'];
const STAGE_LABEL = {
  contractor_uploaded: 'Contractor Uploaded', site_engineer: 'Site Engineer',
  site_head: 'Site Head', project_manager: 'Project Manager',
  finance: 'Finance', accounts: 'Accounts', payment: 'Payment',
};

const BILL_COLS = `b.id, b.project_id, b.work_order_id, b.mb_id, b.ra_no, b.invoice_number,
  b.gross_amount, b.net_amount, b.status, b.current_stage,
  b.gst_verified, b.tax_verified, b.previous_payment_verified,
  b.payment_mode, b.transaction_id, b.contractor_id,
  b.hold_reason, b.held_by, b.held_by_name, b.held_at,
  b.resumed_by, b.resumed_by_name, b.resumed_at,
  b.raised_by, b.raised_at, b.paid_by, b.paid_at, b.payment_ref, b.remarks, b.updated_at,
  wo.wo_number, wo.sub_contractor_name, sc.name AS contractor_name, p.name AS project_name`;

function withDeductions(db, bill) {
  const deductions = db.prepare('SELECT * FROM proj_contractor_ra_deductions WHERE ra_bill_id=?').all(bill.id);
  return { ...bill, deductions, stage_index: STAGES.indexOf(bill.current_stage), stages: STAGES.map(s => STAGE_LABEL[s]) };
}

// ─── List / detail ───────────────────────────────────────────────────
router.get('/bills', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  for (const [key, col] of [['status', 'b.status'], ['current_stage', 'b.current_stage'],
    ['project_id', 'b.project_id'], ['work_order_id', 'b.work_order_id'], ['contractor_id', 'b.contractor_id']]) {
    if (q[key]) { where.push(`${col} = ?`); args.push(q[key]); }
  }
  // "Pending at my stage" — the queue each approver actually works from.
  if (q.pending_stage) { where.push(`b.current_stage = ? AND b.status != 'cancelled'`); args.push(q.pending_stage); }
  res.json(getDb().prepare(`
    SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id = b.work_order_id
      LEFT JOIN sub_contractors sc ON sc.id = b.contractor_id
      LEFT JOIN proj_projects p ON p.id = b.project_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY b.raised_at DESC LIMIT 500`).all(...args));
});

router.get('/bills/:id', canRead, (req, res) => {
  const db = getDb();
  const bill = db.prepare(`SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id = b.work_order_id
      LEFT JOIN sub_contractors sc ON sc.id = b.contractor_id
      LEFT JOIN proj_projects p ON p.id = b.project_id
    WHERE b.id=?`).get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const stage_log = db.prepare('SELECT * FROM proj_bill_stage_log WHERE ra_bill_id=? ORDER BY acted_at DESC').all(req.params.id);
  res.json({ ...withDeductions(db, bill), stage_log });
});

// ─── Create (Contractor uploads) ────────────────────────────────────────
router.post('/bills', canCreate, (req, res) => {
  const db = getDb();
  const b = req.body || {};
  if (!b.work_order_id) return res.status(400).json({ error: 'work_order_id is required' });
  if (num(b.gross_amount, -1) < 0) return res.status(400).json({ error: 'gross_amount must be zero or more' });

  const wo = db.prepare('SELECT * FROM proj_work_orders WHERE id=?').get(b.work_order_id);
  if (!wo) return res.status(404).json({ error: 'Work Order not found' });

  const deductions = Array.isArray(b.deductions) ? b.deductions : [];
  const totalDeductions = deductions.reduce((s, d) => s + (num(d.amount, 0)), 0);
  const netAmount = num(b.gross_amount) - totalDeductions;

  const raNo = nextSequence(db, 'proj_contractor_ra_bills', 'ra_no', 'CRA', { pad: 4 });
  const tx = db.transaction(() => {
    const info = db.prepare(`
      INSERT INTO proj_contractor_ra_bills
        (project_id, work_order_id, mb_id, ra_no, invoice_number, gross_amount, net_amount,
         status, current_stage, contractor_id, raised_by, remarks)
      VALUES (?,?,?,?,?,?,?,'raised','contractor_uploaded',?,?,?)`).run(
      wo.project_id, b.work_order_id, b.mb_id || null, raNo, str(b.invoice_number),
      num(b.gross_amount), netAmount, wo.sub_contractor_id || null, req.user.id, str(b.remarks));
    const billId = info.lastInsertRowid;
    const insDed = db.prepare('INSERT INTO proj_contractor_ra_deductions (ra_bill_id, label, pct, amount) VALUES (?,?,?,?)');
    for (const d of deductions) insDed.run(billId, str(d.label) || 'Deduction', num(d.pct, 0), num(d.amount, 0));
    db.prepare(`INSERT INTO vendor_ledger (contractor_id, contractor_name, ra_bill_id, entry_type, amount, created_by, created_by_name)
      VALUES (?,?,?,'bill',?,?,?)`).run(wo.sub_contractor_id || null, wo.sub_contractor_name, billId, netAmount, req.user.id, req.user.name || null);
    return billId;
  });
  const billId = tx();

  notifyStage(db, billId, 'site_engineer', req.user);
  const after = db.prepare(`SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id=b.work_order_id LEFT JOIN sub_contractors sc ON sc.id=b.contractor_id LEFT JOIN proj_projects p ON p.id=b.project_id WHERE b.id=?`).get(billId);
  logAuditEvent({ user: req.user, action: 'CREATE', entity_type: 'proj_contractor_ra_bills',
    entity_id: billId, entity_label: after.ra_no, before: null, after });
  res.status(201).json(after);
});

// ─── Verify / Reject / Send Back ────────────────────────────────────────
router.post('/bills/:id/action', canApprove, (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM proj_contractor_ra_bills WHERE id=?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status === 'cancelled' || bill.status === 'paid') {
    return res.status(409).json({ error: `Bill is already ${bill.status} — no further action possible.` });
  }
  if (bill.status === 'on_hold') {
    return res.status(409).json({ error: 'Bill is on hold — resume it before taking further action.' });
  }

  const b = req.body || {};
  const action = ['verified', 'rejected', 'sent_back'].includes(b.action) ? b.action : null;
  if (!action) return res.status(400).json({ error: 'action must be verified, rejected or sent_back' });

  const idx = STAGES.indexOf(bill.current_stage);
  const nextStage = STAGES[idx + 1]; // the stage this action is being taken FOR
  if (!nextStage) return res.status(409).json({ error: 'This bill has already completed the chain.' });

  // The acting stage is the NEXT stage after contractor_uploaded — i.e. the
  // first real approver is site_engineer, matching the spec's chain order.
  const actingStage = nextStage;

  if (action === 'rejected' && !str(b.remarks)) {
    return res.status(400).json({ error: 'A reason is required to reject a bill.' });
  }

  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO proj_bill_stage_log (ra_bill_id, stage, action, photos_json, measurement_notes, quantity_verified, remarks, acted_by, acted_by_name)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(
      bill.id, actingStage, action,
      Array.isArray(b.photos) ? JSON.stringify(b.photos) : null,
      str(b.measurement_notes), b.quantity_verified != null ? num(b.quantity_verified) : null,
      str(b.remarks), req.user.id, req.user.name || null);

    if (action === 'rejected') {
      db.prepare(`UPDATE proj_contractor_ra_bills SET status='cancelled', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(bill.id);
      // Reverse the 'bill' debit posted at creation — otherwise a rejected
      // bill leaves a phantom outstanding balance in the vendor ledger
      // forever. A contra 'payment'-type entry nets it to zero without
      // deleting the original entry (preserves the audit trail).
      db.prepare(`INSERT INTO vendor_ledger (contractor_id, contractor_name, ra_bill_id, entry_type, amount, remarks, created_by, created_by_name)
        VALUES (?,?,?,'payment',?,?,?,?)`).run(
        bill.contractor_id, null, bill.id, bill.net_amount, 'Reversal — bill rejected', req.user.id, req.user.name || null);
      return { finalStatus: 'cancelled' };
    }
    if (action === 'sent_back') {
      db.prepare(`UPDATE proj_contractor_ra_bills SET current_stage='contractor_uploaded', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(bill.id);
      return { finalStatus: 'sent_back' };
    }

    // 'verified' — Module 5's Finance checks land here, on the same row.
    if (actingStage === 'finance') {
      db.prepare(`UPDATE proj_contractor_ra_bills SET
          gst_verified=?, tax_verified=?, previous_payment_verified=?
        WHERE id=?`).run(b.gst_verified ? 1 : 0, b.tax_verified ? 1 : 0, b.previous_payment_verified ? 1 : 0, bill.id);
    }

    if (actingStage === 'payment') {
      // Terminal stage — Payment released (Module 6).
      const gstTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM proj_contractor_ra_deductions WHERE ra_bill_id=? AND label LIKE '%GST%'`).get(bill.id).v;
      const tdsTotal = db.prepare(`SELECT COALESCE(SUM(amount),0) v FROM proj_contractor_ra_deductions WHERE ra_bill_id=? AND label LIKE '%TDS%'`).get(bill.id).v;
      db.prepare(`UPDATE proj_contractor_ra_bills SET
          status='paid', current_stage='payment', paid_by=?, paid_at=CURRENT_TIMESTAMP,
          payment_ref=?, payment_mode=?, transaction_id=?, updated_at=CURRENT_TIMESTAMP
        WHERE id=?`).run(req.user.id, str(b.transaction_id), str(b.payment_mode), str(b.transaction_id), bill.id);
      db.prepare(`UPDATE proj_work_orders SET amount_paid = amount_paid + ? WHERE id=?`).run(bill.net_amount, bill.work_order_id);
      db.prepare(`INSERT INTO vendor_ledger (contractor_id, contractor_name, ra_bill_id, entry_type, amount, gst_amount, tds_amount, payment_mode, transaction_id, created_by, created_by_name)
        VALUES (?,?,?,'payment',?,?,?,?,?,?,?)`).run(
        bill.contractor_id, null, bill.id, bill.net_amount, gstTotal, tdsTotal,
        str(b.payment_mode), str(b.transaction_id), req.user.id, req.user.name || null);
      return { finalStatus: 'paid' };
    }

    db.prepare(`UPDATE proj_contractor_ra_bills SET current_stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(nextStage, bill.id);
    return { finalStatus: nextStage };
  });
  const result = tx();

  if (action === 'verified' && result.finalStatus !== 'paid') {
    notifyStage(db, bill.id, result.finalStatus, req.user);
  }
  logAuditEvent({ user: req.user, action: action.toUpperCase(), entity_type: 'proj_contractor_ra_bills',
    entity_id: bill.id, entity_label: bill.ra_no,
    before: { current_stage: bill.current_stage, status: bill.status }, after: result });

  const updated = db.prepare(`SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id=b.work_order_id LEFT JOIN sub_contractors sc ON sc.id=b.contractor_id LEFT JOIN proj_projects p ON p.id=b.project_id WHERE b.id=?`).get(bill.id);
  res.json(withDeductions(db, updated));
});

// ─── Hold / Resume — pause a bill in place, without rejecting or sending
// it back. current_stage is deliberately left untouched by both routes,
// so /bills/:id/action picks up exactly where it paused once resumed.
router.post('/bills/:id/hold', canApprove, (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM proj_contractor_ra_bills WHERE id=?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'raised') {
    return res.status(409).json({ error: `Only a bill actively in the chain can be held (this one is ${bill.status}).` });
  }
  const reason = str((req.body || {}).reason);
  if (!reason) return res.status(400).json({ error: 'A reason is required to hold a bill.' });

  const tx = db.transaction(() => {
    db.prepare(`UPDATE proj_contractor_ra_bills SET
        status='on_hold', hold_reason=?, held_by=?, held_by_name=?, held_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(reason, req.user.id, req.user.name || null, bill.id);
    db.prepare(`INSERT INTO proj_bill_stage_log (ra_bill_id, stage, action, remarks, acted_by, acted_by_name)
      VALUES (?,?,'held',?,?,?)`).run(bill.id, bill.current_stage, reason, req.user.id, req.user.name || null);
  });
  tx();

  logAuditEvent({ user: req.user, action: 'HOLD', entity_type: 'proj_contractor_ra_bills',
    entity_id: bill.id, entity_label: bill.ra_no,
    before: { status: bill.status }, after: { status: 'on_hold', reason } });
  notifyHoldResume(db, bill.id, 'held', req.user, reason);

  const updated = db.prepare(`SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id=b.work_order_id LEFT JOIN sub_contractors sc ON sc.id=b.contractor_id LEFT JOIN proj_projects p ON p.id=b.project_id WHERE b.id=?`).get(bill.id);
  res.json(withDeductions(db, updated));
});

router.post('/bills/:id/resume', canApprove, (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM proj_contractor_ra_bills WHERE id=?').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  if (bill.status !== 'on_hold') {
    return res.status(409).json({ error: `This bill is not on hold (it is ${bill.status}).` });
  }

  const tx = db.transaction(() => {
    db.prepare(`UPDATE proj_contractor_ra_bills SET
        status='raised', resumed_by=?, resumed_by_name=?, resumed_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(req.user.id, req.user.name || null, bill.id);
    db.prepare(`INSERT INTO proj_bill_stage_log (ra_bill_id, stage, action, remarks, acted_by, acted_by_name)
      VALUES (?,?,'resumed',?,?,?)`).run(bill.id, bill.current_stage, str((req.body || {}).remarks), req.user.id, req.user.name || null);
  });
  tx();

  logAuditEvent({ user: req.user, action: 'RESUME', entity_type: 'proj_contractor_ra_bills',
    entity_id: bill.id, entity_label: bill.ra_no,
    before: { status: 'on_hold' }, after: { status: 'raised', stage: bill.current_stage } });
  notifyHoldResume(db, bill.id, 'resumed', req.user, null);

  const updated = db.prepare(`SELECT ${BILL_COLS} FROM proj_contractor_ra_bills b
      LEFT JOIN proj_work_orders wo ON wo.id=b.work_order_id LEFT JOIN sub_contractors sc ON sc.id=b.contractor_id LEFT JOIN proj_projects p ON p.id=b.project_id WHERE b.id=?`).get(bill.id);
  res.json(withDeductions(db, updated));
});

// Same dedupe-by-recipient pattern as notifyStage, keyed on the hold/resume
// EVENT rather than a stage — a bill can be held and resumed more than
// once, and each cycle should notify again.
function notifyHoldResume(db, billId, action, actor, reason) {
  try {
    const bill = db.prepare('SELECT ra_no FROM proj_contractor_ra_bills WHERE id=?').get(billId);
    const recipients = db.prepare(`
      SELECT DISTINCT u.id FROM users u
       WHERE u.role = 'admin'
          OR u.id IN (SELECT ur.user_id FROM user_roles ur
                        JOIN role_permissions rp ON rp.role_id = ur.role_id
                       WHERE rp.module = 'bill_verification' AND rp.can_approve = 1)`).all();
    const dedupe = `bill_${action}:${billId}:${Date.now()}`;
    const title = action === 'held' ? `Bill on hold — ${bill.ra_no}` : `Bill resumed — ${bill.ra_no}`;
    const body = action === 'held'
      ? `${actor?.name || 'Someone'} put bill ${bill.ra_no} on hold${reason ? `: ${reason}` : ''}.`
      : `${actor?.name || 'Someone'} resumed bill ${bill.ra_no}.`;
    const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key) VALUES (?,?,?,?,?,?,?)`);
    for (const r of recipients) {
      ins.run(r.id, 'bill_verification', title, body, `/bill-verification?bill=${billId}`, 'in_app', `${dedupe}:${r.id}`);
    }
  } catch (e) { console.warn('[bill-verification] hold/resume notify failed:', e.message); }
}

// Tells the people who can act on the next stage that something is waiting.
// Deduped per bill per stage so re-checking a queue doesn't spam the bell.
function notifyStage(db, billId, stage, actor) {
  try {
    const bill = db.prepare('SELECT ra_no FROM proj_contractor_ra_bills WHERE id=?').get(billId);
    const recipients = db.prepare(`
      SELECT DISTINCT u.id FROM users u
       WHERE u.role = 'admin'
          OR u.id IN (SELECT ur.user_id FROM user_roles ur
                        JOIN role_permissions rp ON rp.role_id = ur.role_id
                       WHERE rp.module = 'bill_verification' AND rp.can_approve = 1)`).all();
    const dedupe = `bill_stage:${billId}:${stage}`;
    const title = stage === 'payment' ? `Payment ready — ${bill.ra_no}` : `${STAGE_LABEL[stage]} verification pending — ${bill.ra_no}`;
    const body = `${actor?.name || 'Someone'} moved bill ${bill.ra_no} to the ${STAGE_LABEL[stage]} stage.`;
    const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key) VALUES (?,?,?,?,?,?,?)`);
    for (const r of recipients) {
      const key = `${dedupe}:${r.id}`;
      if (!db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(r.id, key)) {
        ins.run(r.id, 'bill_verification', title, body, `/bill-verification?bill=${billId}`, 'in_app', key);
      }
    }
  } catch (e) { console.warn('[bill-verification] notify failed:', e.message); }
}

// ─── Vendor Ledger / contractor history (Module 6) ─────────────────────
router.get('/vendor-ledger', canRead, (req, res) => {
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.contractor_id) { where.push('vl.contractor_id = ?'); args.push(q.contractor_id); }
  res.json(getDb().prepare(`
    SELECT vl.*, sc.name AS contractor_name_live, b.ra_no
      FROM vendor_ledger vl
      LEFT JOIN sub_contractors sc ON sc.id = vl.contractor_id
      LEFT JOIN proj_contractor_ra_bills b ON b.id = vl.ra_bill_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY vl.created_at DESC LIMIT 1000`).all(...args));
});

router.get('/vendor-ledger/contractor/:id', canRead, (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT vl.*, b.ra_no FROM vendor_ledger vl
      LEFT JOIN proj_contractor_ra_bills b ON b.id = vl.ra_bill_id
     WHERE vl.contractor_id=? ORDER BY vl.created_at`).all(req.params.id);
  let balance = 0;
  const withBalance = rows.map(r => {
    balance += r.entry_type === 'bill' ? r.amount : -r.amount;
    return { ...r, running_balance: balance };
  });
  res.json({ rows: withBalance.reverse(), balance_due: balance });
});

// ─── Dashboard ────────────────────────────────────────────────────────
router.get('/reports/dashboard', canRead, (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  res.json({
    cards: {
      bills_in_chain: one(`SELECT COUNT(*) c FROM proj_contractor_ra_bills WHERE status='raised'`).c,
      paid_this_month: one(`SELECT COALESCE(SUM(net_amount),0) v FROM proj_contractor_ra_bills
         WHERE status='paid' AND strftime('%Y-%m',paid_at)=strftime('%Y-%m','now','localtime')`).v,
      rejected_this_month: one(`SELECT COUNT(*) c FROM proj_contractor_ra_bills WHERE status='cancelled'
         AND strftime('%Y-%m',updated_at)=strftime('%Y-%m','now','localtime')`).c,
      total_outstanding: one(`SELECT COALESCE(SUM(net_amount),0) v FROM proj_contractor_ra_bills WHERE status='raised'`).v,
    },
    by_stage: db.prepare(`SELECT current_stage AS stage, COUNT(*) AS bills, COALESCE(SUM(net_amount),0) AS amount
       FROM proj_contractor_ra_bills WHERE status='raised' GROUP BY current_stage`).all()
      .map(r => ({ ...r, label: STAGE_LABEL[r.stage] || r.stage })),
  });
});

module.exports = router;
