function ensurePartialDeliveries(db) {
  for (const [table, column, definition] of [
    ['purchase_bills', 'freight_amount', 'REAL NOT NULL DEFAULT 0'],
    ['purchase_bills', 'delivery_mode', "TEXT NOT NULL DEFAULT 'final'"],
    ['delivery_notes', 'supply_pending', 'INTEGER NOT NULL DEFAULT 0'],
    ['delivery_notes', 'receipt_request_id', 'TEXT'],
    ['delivery_notes', 'balance_purchase_bill_id', 'INTEGER REFERENCES purchase_bills(id)'],
  ]) {
    if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    }
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_receipt_request ON delivery_notes(receipt_request_id) WHERE receipt_request_id IS NOT NULL');
}

function receiptTotals(db, poId) {
  const totals = {};
  // A linked sales invoice is not another physical delivery.
  for (const dn of db.prepare("SELECT items_json FROM delivery_notes WHERE vendor_po_id=? AND document_type='challan'").all(poId)) {
    try {
      for (const item of JSON.parse(dn.items_json || '[]')) {
        if (item.vendor_po_item_id != null && Number.isFinite(+item.received_qty)) {
          totals[item.vendor_po_item_id] = (totals[item.vendor_po_item_id] || 0) + Math.max(0, +item.received_qty);
        }
      }
    } catch (_) { /* Legacy non-itemised records carry no quantity. */ }
  }
  return totals;
}

function balanceItems(db, poId) {
  const totals = receiptTotals(db, poId);
  return db.prepare(`SELECT vpi.id AS vpi_id, vpi.quantity AS ordered_qty, vpi.rate,
    COALESCE(im.item_name, ii.description, 'Item') AS description, COALESCE(ii.unit, im.uom, '') AS unit
    FROM vendor_po_items vpi LEFT JOIN indent_items ii ON ii.id=vpi.indent_item_id
    LEFT JOIN item_master im ON im.id=ii.item_master_id WHERE vpi.vendor_po_id=? ORDER BY vpi.id`).all(poId)
    .map(it => ({ ...it, received_qty: totals[it.vpi_id] || 0,
      remaining_qty: Math.max(0, +it.ordered_qty - (totals[it.vpi_id] || 0)) }));
}

function validateBatch(items, submitted) {
  if (!Array.isArray(submitted)) throw new Error('Delivery items are required');
  const seen = new Set();
  const rows = submitted.map(input => {
    const id = +input.vendor_po_item_id;
    const item = items.find(it => it.vpi_id === id);
    const qty = Number(input.received_qty);
    if (!item || seen.has(id)) throw new Error('Invalid or duplicate PO item');
    seen.add(id);
    if (!Number.isFinite(qty) || qty < 0 || qty > item.remaining_qty + 0.000001) {
      throw new Error(`Received quantity must be between 0 and ${item.remaining_qty} for ${item.description}`);
    }
    return { vendor_po_item_id: id, description: item.description, unit: item.unit,
      quantity: qty, received_qty: qty, ordered_qty: qty, rate: item.rate };
  }).filter(it => it.quantity > 0);
  if (!rows.length) throw new Error('Enter at least one quantity received in this delivery');
  return rows;
}

function recordBalance(db, billId, body, date, userId) {
  return db.transaction(() => {
    const bill = db.prepare('SELECT * FROM purchase_bills WHERE id=?').get(billId);
    if (!bill || bill.delivery_mode !== 'partial' || !bill.vendor_po_id) throw new Error('This bill is not awaiting staged delivery');
    const key = String(body.request_id || '');
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) throw new Error('A valid delivery request ID is required');
    const previous = db.prepare('SELECT id, vendor_po_id, document_number, balance_purchase_bill_id FROM delivery_notes WHERE receipt_request_id=?').get(key);
    if (previous) {
      if (previous.vendor_po_id !== bill.vendor_po_id) throw new Error('Delivery request belongs to another PO');
      return { ...previous, existing: true };
    }
    const rows = validateBatch(balanceItems(db, bill.vendor_po_id), body.items);
    let newBillId = null;
    if (body.add_bill === true || body.add_bill === '1') {
      const billNumber = String(body.bill_number || '').trim();
      const billDate = String(body.bill_date || '');
      const amount = Number(body.amount), gst = Number(body.gst_amount || 0);
      if (!billNumber || billNumber.length > 100) throw new Error('Enter the new purchase bill number');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(billDate) || Number.isNaN(Date.parse(billDate)) || new Date(billDate).toISOString().slice(0,10) !== billDate) throw new Error('Enter a valid bill date');
      if (body.amount === '' || body.amount == null || !Number.isFinite(amount) || amount < 0 || !Number.isFinite(gst) || gst < 0) throw new Error('Amount and GST must be valid non-negative numbers');
      if (!body.bill_file_path) throw new Error('Upload the purchase bill file');
      if (db.prepare("SELECT id FROM purchase_bills WHERE vendor_id IS ? AND LOWER(TRIM(bill_number))=LOWER(?)").get(bill.vendor_id || null, billNumber)) throw new Error('This bill number is already recorded for this vendor');
      const freight = Number(body.freight_amount || 0);
      if (!Number.isFinite(freight) || freight < 0) throw new Error('Freight amount must be a valid non-negative number');
      const total = Math.round((amount + gst + freight) * 100) / 100;
      newBillId = db.prepare(`INSERT INTO purchase_bills
        (vendor_po_id,vendor_id,bill_number,bill_date,amount,gst_amount,total_amount,freight_amount,file_path,material_status,delivery_mode,created_by)
        VALUES (?,?,?,?,?,?,?,?,?,'approved','partial',?)`).run(bill.vendor_po_id,bill.vendor_id || null,billNumber,billDate,amount,gst,total,freight,body.bill_file_path,userId).lastInsertRowid;
    }
    const { nextSequence } = require('../db/nextSequence');
    const number = nextSequence(db, 'delivery_notes', 'document_number', `DC/${date.slice(0,4)}/`, { pad: 4 });
    const result = db.prepare(`INSERT INTO delivery_notes
      (vendor_po_id, document_type, document_number, delivery_date, status, items_json, notes, supply_pending, receipt_request_id, balance_purchase_bill_id)
      VALUES (?, 'challan', ?, ?, 'pending', ?, ?, 1, ?, ?)`).run(bill.vendor_po_id, number, date, JSON.stringify(rows),
      `Balance delivery against bill ${bill.bill_number || bill.id}; recorded by user ${userId}. ${String(body.notes || '').slice(0,500)}`, key, newBillId);
    if (newBillId && db.prepare("SELECT 1 FROM sqlite_master WHERE name='purchase_bill_items'").get()) require('./purchaseBilling').ensurePurchaseBilling(db);
    return { id: result.lastInsertRowid, document_number: number, balance_purchase_bill_id: newBillId };
  }).immediate();
}
module.exports = { ensurePartialDeliveries, receiptTotals, balanceItems, validateBatch, recordBalance };
