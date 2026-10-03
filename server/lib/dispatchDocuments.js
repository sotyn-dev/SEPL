const text = value => String(value || '').trim();
const type = value => text(value).toUpperCase();
function items(value) {
  try { const rows = JSON.parse(value || '[]'); return Array.isArray(rows) ? rows : []; }
  catch { return []; }
}

// Read-only presentation of historical documents. Never delete or rewrite an
// old invoice/receipt while putting an unambiguous invoice beside its challan.
function groupDocuments(rows) {
  const challans = rows.filter(row => row.document_type === 'challan');
  const groups = new Map(challans.map(row => [row.id, [row]]));
  for (const row of rows.filter(row => row.document_type !== 'challan')) {
    let matches = row.source_challan_id ? challans.filter(c => c.id === row.source_challan_id) : [];
    if (!matches.length) matches = challans.filter(c => text(c.sales_bill_number)
      && c.sales_bill_number === row.document_number
      && ((c.vendor_po_id && c.vendor_po_id === row.vendor_po_id)
        || (!c.vendor_po_id && c.indent_id && c.indent_id === row.indent_id)));
    if (!matches.length && row.vendor_po_id) {
      matches = challans.filter(c => c.vendor_po_id === row.vendor_po_id);
    }
    if (row.document_type === 'sales_bill' && matches.length === 1) groups.get(matches[0].id).push(row);
    else groups.set(row.id, [row]); // Ambiguous legacy records stay visible.
  }
  return [...groups.values()].map(documents => {
    const row = documents[0];
    const billFiles = [], receipts = [];
    const addFile = (list, file) => {
      if (text(file.file_path) && !list.some(x => x.file_path === file.file_path)) list.push(file);
    };
    for (const doc of documents) {
      addFile(billFiles, { id: doc.id, number: doc.sales_bill_number, file_path: doc.sales_bill_file_path });
      if (doc.document_type === 'sales_bill') {
        addFile(billFiles, { id: doc.id, number: doc.document_number, file_path: doc.file_path });
      }
      if (doc.receipt_state?.receipts.length) {
        for (const receiving of doc.receipt_state.receipts) for (const file of receiving.files) {
          addFile(receipts, { id: receiving.id, number: doc.document_number, file_path: file,
            received_by_name: receiving.received_by_name, received_at: receiving.received_at });
        }
      } else addFile(receipts, { id: doc.id, number: doc.document_number, file_path: doc.receipt_file_path,
        received_by_name: doc.received_by_name, received_at: doc.received_at });
    }
    // A challan's own typed lines are authoritative (e.g. the RGP slice of a
    // mixed indent). Otherwise use the exact Vendor PO's linked indent lines.
    const ownItems = items(row.items_json).map(item => {
      const poItem = (row.po_items || []).find(p => p.vendor_po_item_id === +item.vendor_po_item_id);
      return { ...poItem, ...item, item_type: item.item_type || poItem?.item_type || '',
        qty: item.qty ?? item.quantity ?? item.received_qty ?? item.ordered_qty };
    });
    const dispatchItems = row.receipt_state?.items.length ? row.receipt_state.items : ownItems.length ? ownItems : (row.po_items || []);
    const ownTypes = ownItems.map(it => type(it.item_type));
    const lineTypes = ownTypes.length && ownTypes.every(Boolean) ? ownTypes : (row.item_types || []);
    let required;
    if (lineTypes.includes('PO')) required = true;
    else if (lineTypes.length && lineTypes.every(t => ['FOC', 'RGP'].includes(t))) required = false;
    else if (row.source === 'rgp') required = false;
    else if (documents.some(d => d.document_type === 'sales_bill' || d.sales_bill_pending || text(d.sales_bill_number))) required = true;
    else required = null; // Missing item types must not silently waive billing.
    const billStatus = billFiles.length ? 'uploaded' : required === true ? 'pending' : required === false ? 'not_required' : 'check_items';
    const receipt = receipts[receipts.length - 1];
    return { ...row,
      dispatch_items: dispatchItems,
      sales_bill_required: required, sales_bill_status: billStatus,
      sales_bill_pending: billStatus === 'pending' ? 1 : 0,
      sales_bill_documents: billFiles, receiving_documents: receipts,
      receiving_history: documents.flatMap(d => d.receipt_state?.receipts || []),
      receiving_status: row.receipt_state?.receipts.length ? row.receipt_state.status : receipts.length ? 'received' : 'pending',
      received_by_name: receipt?.received_by_name || row.received_by_name,
      received_at: receipt?.received_at || row.received_at,
      receipt_file_path: receipt?.file_path || null,
      related_document_ids: documents.map(d => d.id),
    };
  }).sort((a, b) => b.id - a.id);
}

function getDispatchDocuments(db) {
  const rows = db.prepare(`SELECT dn.*, u.name AS received_by_user_name,
    vp.po_number AS vendor_po_number, vp.indent_id AS vendor_po_indent_id,
    v.name AS vendor_name, i.indent_number,
    COALESCE(NULLIF(TRIM(i.raised_by_name),''), raiser.name) AS raised_by_name,
    COALESCE(NULLIF(TRIM(i.site_name),''), bb.project_name) AS site_name,
    bb.company_name AS company_name, sin.note_number AS stock_issue_number,
    wh.name AS from_warehouse_name
    FROM delivery_notes dn
    LEFT JOIN users u ON dn.received_by=u.id
    LEFT JOIN vendor_pos vp ON dn.vendor_po_id=vp.id
    LEFT JOIN vendors v ON vp.vendor_id=v.id
    LEFT JOIN indents i ON i.id=COALESCE(vp.indent_id,dn.indent_id)
    LEFT JOIN users raiser ON raiser.id=i.created_by
    LEFT JOIN order_planning op ON op.id=i.planning_id
    LEFT JOIN business_book bb ON bb.id=op.business_book_id
    LEFT JOIN stock_issue_notes sin ON sin.id=dn.stock_issue_note_id
    LEFT JOIN warehouses wh ON wh.id=sin.from_warehouse_id`).all();
  const byPo = new Map();
  for (const item of db.prepare(`SELECT vpi.vendor_po_id, vpi.id AS vendor_po_item_id, ii.item_type, ii.description,
    vpi.quantity AS qty, ii.unit, ii.item_master_id, ii.id AS indent_item_id
    FROM vendor_po_items vpi LEFT JOIN indent_items ii ON ii.id=vpi.indent_item_id`).all()) {
    if (!byPo.has(item.vendor_po_id)) byPo.set(item.vendor_po_id, []);
    byPo.get(item.vendor_po_id).push(item);
  }
  const bills = new Map();
  for (const bill of db.prepare(`SELECT pb.id, links.vendor_po_id, pb.bill_number, pb.file_path
    FROM (SELECT purchase_bill_id, vendor_po_id FROM purchase_bill_pos
      UNION SELECT id, vendor_po_id FROM purchase_bills WHERE vendor_po_id IS NOT NULL) links
    JOIN purchase_bills pb ON pb.id=links.purchase_bill_id ORDER BY pb.id DESC`).all()) {
    if (!bill.vendor_po_id) continue;
    if (!bills.has(bill.vendor_po_id)) bills.set(bill.vendor_po_id, []);
    bills.get(bill.vendor_po_id).push(bill);
  }
  const history = new Map();
  for (const receipt of db.prepare(`SELECT dr.*, r.status AS approval_status FROM delivery_receipts dr
    LEFT JOIN dispatch_receiving r ON r.id=dr.dispatch_receiving_id ORDER BY dr.id`).all()) {
    if (!history.has(receipt.delivery_note_id)) history.set(receipt.delivery_note_id, []);
    history.get(receipt.delivery_note_id).push(receipt);
  }
  return groupDocuments(rows.map(row => ({ ...row,
    receipt_state: require('./deliveryReceipts').state(db, row, history.get(row.id) || []),
    item_types: (byPo.get(row.vendor_po_id) || []).map(item => type(item.item_type)),
    po_items: byPo.get(row.vendor_po_id) || [],
    purchase_bills: bills.get(row.vendor_po_id) || [],
  })));
}

module.exports = { groupDocuments, getDispatchDocuments };
