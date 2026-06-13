// Sales Billing — 4-type sequential client billing (mam 2026-06-13).
// Type 1 Sales Order → 2 Material Delivery → 3 Installation → 4 Final.
// Built on existing Business Book orders; amounts typed manually; one GST %
// per bill; numbering SEPL/SB/<FY>/NNN; Admin + Accounts (installation perm).
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const round2 = n => Math.round((+n || 0) * 100) / 100;
const BILL_STATUS = { 1: 'ORDER BOOKED', 2: 'MATERIAL DELIVERED', 3: 'INSTALLATION COMPLETE', 4: 'READY FOR PAYMENT' };
const REF_TYPE = { 1: 'Sales Order', 2: 'Delivery Challan', 3: 'DPR', 4: 'Commissioning Report' };

// Financial-year label for a date: Apr–Mar. 2026-06 → "26-27".
function fyLabel(dateStr) {
  const d = dateStr ? new Date(dateStr) : new Date();
  const y = d.getFullYear(), m = d.getMonth() + 1;
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}
// Next bill number SEPL/SB/<FY>/NNN, sequence per FY.
function nextBillNumber(db, dateStr) {
  const prefix = `SEPL/SB/${fyLabel(dateStr)}/`;
  let max = 0;
  for (const r of db.prepare('SELECT bill_number FROM sales_bills WHERE bill_number LIKE ?').all(prefix + '%')) {
    const n = parseInt(String(r.bill_number).split('/').pop(), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return prefix + String(max + 1).padStart(3, '0');
}

// Business Book orders for the "new bill" picker.
router.get('/orders', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, lead_no, client_name, company_name, project_name, po_number,
            po_date, po_amount, sale_amount_without_gst
       FROM business_book ORDER BY id DESC`
  ).all();
  res.json(rows.map(r => ({
    ...r,
    customer_name: (r.client_name || r.company_name || '').trim(),
  })));
});

// One order: its items + the bills already raised against it (to know the
// next allowed type in the chain).
router.get('/orders/:bbId', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(req.params.bbId);
  if (!bb) return res.status(404).json({ error: 'Order not found' });
  const items = db.prepare(
    `SELECT id, description, quantity, unit, rate, amount FROM po_items WHERE business_book_id=? ORDER BY id`
  ).all(bb.id);
  const bills = db.prepare(
    `SELECT id, bill_type, bill_number, amount, total_amount, bill_status, approval_status, bill_date
       FROM sales_bills WHERE business_book_id=? AND bill_type IS NOT NULL ORDER BY bill_type`
  ).all(bb.id);
  const haveTypes = new Set(bills.map(b => b.bill_type));
  // Next type = smallest 1..4 not yet created (chain must be contiguous).
  let nextType = null;
  for (let t = 1; t <= 4; t++) { if (!haveTypes.has(t)) { nextType = t; break; } }
  res.json({
    order: {
      id: bb.id, lead_no: bb.lead_no, po_number: bb.po_number,
      customer_name: (bb.client_name || bb.company_name || '').trim(),
      project_name: bb.project_name, po_amount: bb.po_amount,
      sale_amount_without_gst: bb.sale_amount_without_gst,
    },
    items, bills, next_type: nextType,
  });
});

// List all 4-type sales bills (legacy delivery-note rows have bill_type NULL).
router.get('/', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT sb.*, u.name AS created_by_name,
            COALESCE((SELECT SUM(p.amount) FROM payments p
                       WHERE p.reference_type='sales_bill' AND p.reference_id=sb.id), 0) AS received_amount
       FROM sales_bills sb LEFT JOIN users u ON u.id = sb.created_by
      WHERE sb.bill_type IS NOT NULL
      ORDER BY sb.id DESC`
  ).all();
  res.json(rows);
});

// One bill + its items.
router.get('/:id', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  bill.items = db.prepare('SELECT * FROM sales_bill_items WHERE sales_bill_id=? ORDER BY id').all(bill.id);
  bill.log = db.prepare(
    `SELECT l.*, u.name AS by_name FROM sales_bill_status_log l LEFT JOIN users u ON u.id=l.changed_by
      WHERE l.sales_bill_id=? ORDER BY l.id`
  ).all(bill.id);
  bill.payments = db.prepare(
    `SELECT p.*, u.name AS by_name FROM payments p LEFT JOIN users u ON u.id=p.created_by
      WHERE p.reference_type='sales_bill' AND p.reference_id=? ORDER BY p.id`
  ).all(bill.id);
  bill.received_amount = bill.payments.reduce((s, p) => s + (+p.amount || 0), 0);
  res.json(bill);
});

// Create a sales bill. Enforces the 1→2→3→4 chain per order.
router.post('/', requirePermission('installation', 'create'), (req, res) => {
  try {
    const db = getDb();
    const business_book_id = +req.body.business_book_id;
    const bill_type = +req.body.bill_type;
    if (!business_book_id) return res.status(400).json({ error: 'Pick a Business Book order' });
    if (![1, 2, 3, 4].includes(bill_type)) return res.status(400).json({ error: 'bill_type must be 1-4' });

    const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(business_book_id);
    if (!bb) return res.status(404).json({ error: 'Order not found' });

    // Chain validation — every earlier type must already exist; this type must not.
    const existing = db.prepare(
      'SELECT id, bill_type FROM sales_bills WHERE business_book_id=? AND bill_type IS NOT NULL'
    ).all(business_book_id);
    const byType = new Map(existing.map(b => [b.bill_type, b.id]));
    if (byType.has(bill_type)) return res.status(409).json({ error: `Type ${bill_type} bill already exists for this order` });
    for (let t = 1; t < bill_type; t++) {
      if (!byType.has(t)) return res.status(409).json({ error: `Create the Type ${t} bill first — bills are sequential` });
    }
    const previous_bill_id = bill_type > 1 ? byType.get(bill_type - 1) : null;

    const amount = round2(req.body.amount);
    const gst_rate = round2(req.body.gst_rate);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });
    if (!Number.isFinite(gst_rate) || gst_rate < 0 || gst_rate > 100) return res.status(400).json({ error: 'GST % must be 0-100' });
    const gst_amount = round2(amount * gst_rate / 100);
    const total_amount = round2(amount + gst_amount);
    const bill_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.bill_date) ? req.body.bill_date : new Date().toISOString().split('T')[0];
    const customer_name = (bb.client_name || bb.company_name || '').trim();
    const items = Array.isArray(req.body.items) ? req.body.items : [];

    const out = db.transaction(() => {
      const bill_number = nextBillNumber(db, bill_date);
      const r = db.prepare(
        `INSERT INTO sales_bills
           (bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
            bill_type, business_book_id, customer_name, project_name, bill_status,
            previous_bill_id, reference_doc_type, reference_doc_no, approval_status,
            payment_status, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'draft', 'pending', ?)`
      ).run(bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
        bill_type, business_book_id, customer_name, bb.project_name || null, BILL_STATUS[bill_type],
        previous_bill_id, REF_TYPE[bill_type], req.body.reference_doc_no || null, req.user.id);
      const billId = r.lastInsertRowid;
      const insItem = db.prepare(
        `INSERT INTO sales_bill_items (sales_bill_id, description, qty_ordered, qty_delivered, unit, rate, amount)
         VALUES (?,?,?,?,?,?,?)`
      );
      for (const it of items) {
        if (!it || (!it.description && !it.amount)) continue;
        insItem.run(billId, it.description || '', round2(it.qty_ordered), round2(it.qty_delivered), it.unit || '', round2(it.rate), round2(it.amount));
      }
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(billId, 'draft', req.user.id, `${REF_TYPE[bill_type]} bill created`);
      return { id: billId, bill_number };
    })();

    res.status(201).json({ message: `Bill ${out.bill_number} created`, ...out });
  } catch (err) {
    console.error('sales-billing create error', err);
    res.status(500).json({ error: err.message });
  }
});

// Approve a bill (Admin + Accounts via installation edit).
router.put('/:id/approve', requirePermission('installation', 'edit'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id, approval_status FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const next = req.body.approval_status === 'draft' ? 'draft' : 'approved';
  db.prepare('UPDATE sales_bills SET approval_status=? WHERE id=?').run(next, bill.id);
  db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
    .run(bill.id, next, req.user.id, next === 'approved' ? 'Approved' : 'Reverted to draft');
  res.json({ message: next === 'approved' ? 'Approved' : 'Reverted to draft', approval_status: next });
});

// Delete a bill — only if no later-type bill in its chain references it.
router.delete('/:id', requirePermission('installation', 'delete'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const child = db.prepare('SELECT id FROM sales_bills WHERE previous_bill_id=?').get(bill.id);
  if (child) return res.status(409).json({ error: 'Delete the later bill in this chain first' });
  db.prepare('DELETE FROM sales_bills WHERE id=?').run(bill.id);
  res.json({ message: 'Bill deleted' });
});

// Record a payment against a Type-4 (Final) bill — payment is only allowed on
// the final bill (spec rule). Logs into `payments`, updates the bill's
// payment_status, and upserts a Receivables row so it shows in the ledger.
router.post('/:id/payment', requirePermission('installation', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const bill = db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.bill_type !== 4) return res.status(400).json({ error: 'Payment can only be recorded against the Type 4 (Final) bill' });
    if (bill.approval_status !== 'approved') return res.status(400).json({ error: 'Approve the Final bill before recording payment' });
    const amount = round2(req.body.amount);
    if (!Number.isFinite(amount) || amount <= 0) return res.status(400).json({ error: 'amount must be a positive number' });
    const payment_date = /^\d{4}-\d{2}-\d{2}$/.test(req.body.payment_date) ? req.body.payment_date : new Date().toISOString().split('T')[0];
    const payment_mode = ['Cash', 'Bank', 'UPI', 'Cheque', 'NEFT/RTGS'].includes(req.body.payment_mode) ? req.body.payment_mode : 'Bank';

    const out = db.transaction(() => {
      db.prepare(
        `INSERT INTO payments (type, reference_type, reference_id, amount, payment_date, payment_mode, transaction_ref, notes, created_by)
         VALUES ('receivable', 'sales_bill', ?, ?, ?, ?, ?, ?, ?)`
      ).run(bill.id, amount, payment_date, payment_mode, req.body.transaction_ref || null, req.body.notes || null, req.user.id);

      const received = round2(db.prepare(
        `SELECT COALESCE(SUM(amount),0) AS s FROM payments WHERE reference_type='sales_bill' AND reference_id=?`
      ).get(bill.id).s);
      const pstatus = received >= bill.total_amount - 0.01 ? 'paid' : received > 0 ? 'partial' : 'pending';
      db.prepare('UPDATE sales_bills SET payment_status=? WHERE id=?').run(pstatus, bill.id);
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(bill.id, pstatus, req.user.id, `Payment ₹${amount} (${payment_mode})`);

      // Upsert the Receivables ledger row for this final bill.
      const outstanding = round2(bill.total_amount - received);
      const rstatus = outstanding <= 0.01 ? 'green' : received > 0 ? 'yellow' : 'red';
      const existing = db.prepare('SELECT id FROM receivables WHERE invoice_number=?').get(bill.bill_number);
      if (existing) {
        db.prepare('UPDATE receivables SET received_amount=?, outstanding_amount=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
          .run(received, outstanding, rstatus, existing.id);
      } else {
        db.prepare(
          `INSERT INTO receivables (client_name, project_name, business_book_id, invoice_number, invoice_date,
             invoice_amount, received_amount, outstanding_amount, status, created_by)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        ).run(bill.customer_name || 'Customer', bill.project_name || null, bill.business_book_id, bill.bill_number,
          bill.bill_date, bill.total_amount, received, outstanding, rstatus, req.user.id);
      }
      return { received, outstanding, payment_status: pstatus };
    })();

    res.json({ message: 'Payment recorded', ...out });
  } catch (err) {
    console.error('sales-billing payment error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
