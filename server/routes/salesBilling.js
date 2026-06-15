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

// Business Book orders for the "new bill" picker — Order→Planning projects
// (status='planning') surface first, then the rest, so the Sales Order bill is
// raised off the planning project's name / value / BOQ items.
router.get('/orders', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT id, lead_no, client_name, company_name, project_name, po_number,
            po_date, po_amount, sale_amount_without_gst, status
       FROM business_book
      ORDER BY CASE status
                 WHEN 'planning' THEN 0 WHEN 'execution' THEN 1
                 WHEN 'advance_received' THEN 2 WHEN 'completed' THEN 3 ELSE 4 END,
               id DESC`
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
  // In-module chain is 1 → 3 → 4. Type 2 (material delivery) is billed in
  // Dispatch (mam kept the old flow), so it's not created here.
  let nextType = null;
  for (const t of [1, 3, 4]) { if (!haveTypes.has(t)) { nextType = t; break; } }
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

// Pending-billing alerts (mam 2026-06-13: "show data automatically as an alert
// so we don't forget a sales order / bill"). Surfaces what still needs billing:
//   - active orders (planning/execution) with NO Type-1 Sales Order bill
//   - approved, billing-ready DPRs not yet billed (Type-3 install)
// MUST be declared before GET /:id so it isn't captured as an :id.
router.get('/pending', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  const ordersWithoutSo = db.prepare(
    `SELECT bb.id, bb.lead_no, bb.client_name, bb.company_name, bb.project_name,
            bb.po_amount, bb.sale_amount_without_gst, bb.status
       FROM business_book bb
      WHERE bb.status IN ('planning','execution','advance_received')
        AND NOT EXISTS (SELECT 1 FROM sales_bills sb WHERE sb.business_book_id=bb.id AND sb.bill_type=1)
      ORDER BY CASE bb.status WHEN 'planning' THEN 0 WHEN 'execution' THEN 1 ELSE 2 END, bb.id DESC`
  ).all().map(r => ({
    id: r.id, lead_no: r.lead_no, status: r.status, project_name: r.project_name,
    customer_name: (r.client_name || r.company_name || '').trim(),
    value: r.sale_amount_without_gst || r.po_amount || 0,
  }));
  let dprReady = { count: 0, value: 0 };
  try {
    dprReady = db.prepare(
      `SELECT COUNT(*) AS count, COALESCE(SUM(COALESCE(d.grand_total_a,0)),0) AS value
         FROM dpr d JOIN sites s ON s.id = d.site_id
        WHERE d.approval_status='approved' AND d.billing_ready=1
          AND d.sales_bill_id IS NULL AND s.business_book_id IS NOT NULL`
    ).get();
  } catch (e) { /* dpr.sales_bill_id may be absent on a stale DB */ }
  res.json({ orders_without_so: ordersWithoutSo, dpr_ready: dprReady });
});

// Material billing view (mam 2026-06-13): each material dispatch (delivery
// challan, by indent number) and whether its client Sales Bill is DONE or
// PENDING. The Sales Bill itself is still created in Dispatch (legacy flow);
// this surfaces the pendency. MUST be before GET /:id.
router.get('/material', requirePermission('installation', 'view'), (req, res) => {
  const db = getDb();
  let rows = [];
  try {
    rows = db.prepare(
      `SELECT dn.id, dn.document_number, dn.delivery_date, dn.source,
              dn.sales_bill_pending, dn.sales_bill_number, dn.grand_total_amount, dn.items_json,
              COALESCE(dn.sales_bill_file_path,
                       (SELECT sbn.file_path FROM delivery_notes sbn
                         WHERE sbn.document_type='sales_bill' AND sbn.document_number=dn.sales_bill_number LIMIT 1)
              ) AS sales_bill_file,
              COALESCE(vp.indent_id, dn.indent_id) AS indent_id, i.indent_number, i.site_name
         FROM delivery_notes dn
         LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
         LEFT JOIN indents i ON i.id = COALESCE(vp.indent_id, dn.indent_id)
        WHERE dn.document_type = 'challan' AND COALESCE(dn.source,'') <> 'rgp'
        ORDER BY dn.id DESC LIMIT 500`
    ).all();
  } catch (e) { /* tables may be absent on a stale DB */ }
  // Resolve a challan's order (business_book) → its BOQ rates + Against-Delivery
  // %, so VALUE = (delivered qty × BOQ rate) × delivery % (mam 2026-06-15).
  const indentBb = new Map();   // indent_id/site → business_book_id
  const bbCache = new Map();    // bb_id → { pct, rates: Map(descLower→rate) }
  const resolveBb = (indentId, siteName) => {
    const key = indentId ? ('i' + indentId) : ('s:' + (siteName || ''));
    if (indentBb.has(key)) return indentBb.get(key);
    let bbId = null;
    try {
      if (indentId) {
        const r = db.prepare('SELECT op.business_book_id AS bb FROM indents i LEFT JOIN order_planning op ON op.id = i.planning_id WHERE i.id=?').get(indentId);
        bbId = (r && r.bb) || null;
        if (!bbId) { const i2 = db.prepare('SELECT site_name FROM indents WHERE id=?').get(indentId); siteName = (i2 && i2.site_name) || siteName; }
      }
      if (!bbId && siteName) {
        const s = db.prepare('SELECT business_book_id AS bb FROM sites WHERE LOWER(TRIM(name))=LOWER(TRIM(?)) AND business_book_id IS NOT NULL LIMIT 1').get(siteName);
        bbId = (s && s.bb) || null;
      }
    } catch (_) {}
    indentBb.set(key, bbId);
    return bbId;
  };
  const getBb = (bbId) => {
    if (!bbId) return null;
    if (bbCache.has(bbId)) return bbCache.get(bbId);
    let pct = 0; const rates = new Map();
    try {
      const bb = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
      pct = parseFloat(String((bb && bb.payment_against_delivery) || '').replace(/[^0-9.]/g, '')) || 0;
      for (const it of db.prepare('SELECT description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
        if (it.description) rates.set(String(it.description).toLowerCase().trim(), +it.rate || 0);
      }
    } catch (_) {}
    const v = { pct, rates };
    bbCache.set(bbId, v);
    return v;
  };

  const out = rows.map(r => {
    let itemCount = 0, boqValue = 0;
    const bb = getBb(resolveBb(r.indent_id, r.site_name));
    try {
      const items = JSON.parse(r.items_json || '[]');
      itemCount = items.length;
      for (const it of items) {
        const qty = +it.qty || +it.quantity || 0;
        const rate = bb ? (bb.rates.get(String(it.description || '').toLowerCase().trim()) || 0) : 0;
        boqValue += qty * rate;
      }
    } catch (_) {}
    const pct = bb ? bb.pct : 0;
    const value = round2(boqValue * pct / 100);
    return {
      id: r.id, challan_no: r.document_number, date: r.delivery_date, source: r.source,
      indent_number: r.indent_number, site_name: r.site_name, item_count: itemCount,
      boq_value: round2(boqValue), delivery_pct: pct, value,
      sales_bill_status: r.sales_bill_number ? 'done' : (r.sales_bill_pending ? 'pending' : 'na'),
      sales_bill_number: r.sales_bill_number || null,
      sales_bill_file: r.sales_bill_file || null,
    };
  });
  res.json(out);
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
    if (bill_type === 2) return res.status(400).json({ error: 'Type 2 (material delivery) is billed in Dispatch, not here.' });
    if (![1, 3, 4].includes(bill_type)) return res.status(400).json({ error: 'bill_type must be 1, 3 or 4' });

    const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(business_book_id);
    if (!bb) return res.status(404).json({ error: 'Order not found' });

    // Chain validation over the in-module sequence 1 → 3 → 4. Every earlier
    // type must already exist; this type must not.
    const SEQ = [1, 3, 4];
    const existing = db.prepare(
      'SELECT id, bill_type FROM sales_bills WHERE business_book_id=? AND bill_type IS NOT NULL'
    ).all(business_book_id);
    const byType = new Map(existing.map(b => [b.bill_type, b.id]));
    if (byType.has(bill_type)) return res.status(409).json({ error: `Type ${bill_type} bill already exists for this order` });
    for (const t of SEQ) {
      if (t >= bill_type) break;
      if (!byType.has(t)) return res.status(409).json({ error: `Create the Type ${t} bill first — bills are sequential` });
    }
    const earlier = SEQ.filter(t => t < bill_type && byType.has(t));
    const previous_bill_id = earlier.length ? byType.get(earlier[earlier.length - 1]) : null;

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
  // Free the DPRs this installation bill consumed so they can be re-billed.
  db.prepare('UPDATE dpr SET sales_bill_id=NULL WHERE sales_bill_id=?').run(bill.id);
  db.prepare('DELETE FROM sales_bills WHERE id=?').run(bill.id);
  res.json({ message: 'Bill deleted' });
});

// Mark an installation bill "Sent to Client" — the only manual step on an
// auto-generated Type-3 bill (mam 2026-06-13). Toggle.
router.put('/:id/sent', requirePermission('installation', 'edit'), (req, res) => {
  const db = getDb();
  const bill = db.prepare('SELECT id, sent_to_client FROM sales_bills WHERE id=? AND bill_type IS NOT NULL').get(req.params.id);
  if (!bill) return res.status(404).json({ error: 'Bill not found' });
  const sent = bill.sent_to_client ? 0 : 1;
  db.prepare('UPDATE sales_bills SET sent_to_client=?, sent_at=' + (sent ? 'CURRENT_TIMESTAMP' : 'NULL') + ' WHERE id=?').run(sent, bill.id);
  db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
    .run(bill.id, sent ? 'sent_to_client' : 'unsent', req.user.id, sent ? 'Sent to client' : 'Marked not sent');
  res.json({ message: sent ? 'Marked Sent to Client' : 'Marked not sent', sent_to_client: sent });
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

// Generate Type-3 Installation bills from DPRs (mam 2026-06-13: "installation
// bill according to DPR every 15 days, auto"). Sums each project's DPR Table-A
// value (grand_total_a = labour/installation billing value) for approved,
// billing-ready, NOT-yet-billed DPRs, and raises one Type-3 bill per project.
// Idempotent via dpr.sales_bill_id (a DPR is billed once). Returns a summary.
// `draft=true` (default) creates the bills as DRAFT for review; the scheduled
// fortnightly job calls this with draft=false to auto-approve.
function generateInstallationBills(db, userId, { draft = true } = {}) {
  // Bill value = the BOQ items × qty recorded in the DPR (mam 2026-06-13),
  // i.e. the sum of that DPR's work-item amounts — not the labour-only total.
  const rows = db.prepare(
    `SELECT d.id AS dpr_id, d.report_date, s.business_book_id AS bb_id,
            COALESCE((SELECT SUM(wi.amount) FROM dpr_work_items wi WHERE wi.dpr_id = d.id), 0) AS val
       FROM dpr d JOIN sites s ON s.id = d.site_id
      WHERE d.approval_status = 'approved' AND d.billing_ready = 1
        AND d.sales_bill_id IS NULL AND s.business_book_id IS NOT NULL`
  ).all();
  if (!rows.length) return { created: 0, bills: [] };

  const groups = new Map();   // bb_id → { sum, dprIds, minDate, maxDate }
  for (const r of rows) {
    if (!groups.has(r.bb_id)) groups.set(r.bb_id, { sum: 0, dprIds: [], minDate: r.report_date, maxDate: r.report_date });
    const g = groups.get(r.bb_id);
    g.sum += +r.val || 0;
    g.dprIds.push(r.dpr_id);
    if (r.report_date < g.minDate) g.minDate = r.report_date;
    if (r.report_date > g.maxDate) g.maxDate = r.report_date;
  }

  const today = new Date().toISOString().split('T')[0];
  const out = [];
  const tx = db.transaction(() => {
    for (const [bbId, g] of groups) {
      if (round2(g.sum) <= 0) continue;          // no work recorded this window
      const bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(bbId);
      if (!bb) continue;
      // Installation bill = work value × the "Against Installation" % from the
      // order's Business Book payment terms (mam 2026-06-13).
      const instPct = parseFloat(String(bb.payment_against_installation || '').replace(/[^0-9.]/g, '')) || 0;
      const workValue = round2(g.sum);
      const amount = round2(workValue * instPct / 100);
      if (amount <= 0) continue;                  // no installation % set on this order — skip
      const prior = db.prepare(
        `SELECT id FROM sales_bills WHERE business_book_id=? AND bill_type=1`
      ).get(bbId);
      const gst_rate = 18;                        // installation service GST
      const gst_amount = round2(amount * gst_rate / 100);
      const total_amount = round2(amount + gst_amount);
      const bill_number = nextBillNumber(db, today);
      const r = db.prepare(
        `INSERT INTO sales_bills
           (bill_number, bill_date, amount, gst_amount, total_amount, gst_rate,
            bill_type, business_book_id, customer_name, project_name, bill_status,
            previous_bill_id, reference_doc_type, reference_doc_no, approval_status,
            payment_status, created_by)
         VALUES (?,?,?,?,?,?,3,?,?,?,?,?, 'DPR', ?, ?, 'pending', ?)`
      ).run(bill_number, today, amount, gst_amount, total_amount, gst_rate,
        bbId, (bb.client_name || bb.company_name || '').trim(), bb.project_name || null, BILL_STATUS[3],
        prior ? prior.id : null, `DPRs ${g.minDate} → ${g.maxDate} · ${instPct}% of ₹${workValue}`, draft ? 'draft' : 'approved', userId);
      const billId = r.lastInsertRowid;
      const upd = db.prepare('UPDATE dpr SET sales_bill_id=? WHERE id=?');
      for (const dprId of g.dprIds) upd.run(billId, dprId);
      db.prepare('INSERT INTO sales_bill_status_log (sales_bill_id, status, changed_by, notes) VALUES (?,?,?,?)')
        .run(billId, draft ? 'draft' : 'approved', userId, `Auto installation bill from ${g.dprIds.length} DPR(s)`);
      out.push({ bill_number, business_book_id: bbId, dprs: g.dprIds.length, amount, total_amount });
    }
  });
  tx();
  return { created: out.length, bills: out };
}

// Manual trigger — admin/accounts run it once to verify amounts before the
// fortnightly job is switched on. Creates DRAFT bills.
router.post('/generate-installation', requirePermission('installation', 'create'), (req, res) => {
  try {
    const db = getDb();
    const result = generateInstallationBills(db, req.user.id, { draft: false });
    res.json({ message: result.created ? `${result.created} installation bill(s) generated — review, then mark Sent to Client` : 'No unbilled DPRs ready to bill', ...result });
  } catch (err) {
    console.error('sales-billing generate-installation error', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.generateInstallationBills = generateInstallationBills;
