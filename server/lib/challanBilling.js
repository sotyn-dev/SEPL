// Receipt belongs to the physical challan; an invoice is created explicitly later.
function syncChallanBilling(db, id) {
  const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(id);
  if (!dn) return;
  if (dn.document_type !== 'challan') {
    db.prepare('UPDATE delivery_notes SET sales_bill_pending=0 WHERE id=?').run(id);
    return;
  }
  const linked = dn.sales_bill_number && db.prepare("SELECT id FROM delivery_notes WHERE document_type='sales_bill' AND document_number=?").get(dn.sales_bill_number);
  if (linked) {
    db.prepare('UPDATE delivery_notes SET source_challan_id=? WHERE id=?').run(id, linked.id);
    if (dn.status === 'received') {
      // Keep a separately uploaded invoice receipt if one exists.
      db.prepare(`UPDATE delivery_notes SET status='received',
        received_by_name=COALESCE(received_by_name,?), received_at=COALESCE(received_at,?),
        receipt_file_path=COALESCE(receipt_file_path,?), sales_bill_pending=0 WHERE id=?`)
        .run(dn.received_by_name, dn.received_at, dn.receipt_file_path, linked.id);
    }
  }
  let billable = !!dn.sales_bill_pending;
  if (dn.vendor_po_id) {
    billable = !!db.prepare(`SELECT 1 FROM vendor_po_items vpi JOIN indent_items ii ON ii.id=vpi.indent_item_id
      WHERE vpi.vendor_po_id=? AND UPPER(TRIM(COALESCE(ii.item_type,'')))='PO' LIMIT 1`).get(dn.vendor_po_id);
    if (dn.supply_pending) {
      const ids = new Set(db.prepare(`SELECT vpi.id FROM vendor_po_items vpi JOIN indent_items ii ON ii.id=vpi.indent_item_id
        WHERE vpi.vendor_po_id=? AND UPPER(TRIM(COALESCE(ii.item_type,'')))='PO'`).all(dn.vendor_po_id).map(row => row.id));
      let batch = [];
      try { batch = JSON.parse(dn.items_json || '[]'); } catch (_) {}
      billable = batch.some(row => ids.has(+row.vendor_po_item_id) && +row.received_qty > 0);
    }
  }
  db.prepare('UPDATE delivery_notes SET sales_bill_pending=? WHERE id=?').run(dn.sales_bill_number ? 0 : Number(billable), id);
}

function ensureChallanBilling(db) {
  if (!db.prepare('PRAGMA table_info(delivery_notes)').all().some(c => c.name === 'source_challan_id')) {
    db.exec('ALTER TABLE delivery_notes ADD COLUMN source_challan_id INTEGER REFERENCES delivery_notes(id)');
  }
  // Repair only unambiguous existing links. Do not delete or renumber invoices.
  db.transaction(() => {
    db.prepare("UPDATE delivery_notes SET sales_bill_pending=0 WHERE document_type='sales_bill' AND sales_bill_pending<>0").run();
    for (const row of db.prepare("SELECT id FROM delivery_notes WHERE document_type='challan' AND status='received'").all()) syncChallanBilling(db, row.id);
  })();
}
module.exports = { syncChallanBilling, ensureChallanBilling };
