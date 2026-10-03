const parse = value => { try { const rows = JSON.parse(value || '[]'); return Array.isArray(rows) ? rows : []; } catch { return []; } };
const round = value => Math.round(value * 1e6) / 1e6;
const fail = message => { const error = new Error(message); error.status = 400; throw error; };

function initialize(db) {
  if (!db.prepare('PRAGMA table_info(delivery_notes)').all().some(c => c.name === 'receipt_dispatch_items_json')) {
    db.exec('ALTER TABLE delivery_notes ADD COLUMN receipt_dispatch_items_json TEXT');
  }
  db.exec(`CREATE TABLE IF NOT EXISTS delivery_receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_note_id INTEGER NOT NULL REFERENCES delivery_notes(id),
    request_id TEXT UNIQUE, files_json TEXT NOT NULL, items_json TEXT NOT NULL,
    received_by_name TEXT NOT NULL, received_at TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    dispatch_receiving_id INTEGER UNIQUE REFERENCES dispatch_receiving(id),
    warehouse_id INTEGER REFERENCES warehouses(id), legacy INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_receipts_note ON delivery_receipts(delivery_note_id);`);
}

function lines(db, note) {
  const saved = note.receipt_dispatch_items_json || note.items_json;
  const linked = note.vendor_po_id ? db.prepare(`SELECT vpi.id vendor_po_item_id, vpi.quantity, vpi.rate,
    ii.description, ii.unit, ii.item_type, ii.item_master_id, ii.id indent_item_id
    FROM vendor_po_items vpi LEFT JOIN indent_items ii ON ii.id=vpi.indent_item_id
    WHERE vpi.vendor_po_id=? ORDER BY vpi.id`).all(note.vendor_po_id) : [];
  let rows = parse(saved);
  if (!rows.length && !saved) rows = linked;
  return rows.filter(it => it && it.include !== false).map((it, index) => {
    // Legacy receive saved ordered_qty alongside the original dispatched qty.
    const quantity = Number(it.qty ?? it.quantity ?? it.ordered_qty ?? it.received_qty ?? 0);
    const poItem = linked.find(p => p.vendor_po_item_id === +it.vendor_po_item_id);
    return { ...poItem, ...it, line_key: String(it.line_key || `line-${index}`), quantity, qty: quantity };
  }).filter(it => Number.isFinite(it.quantity) && it.quantity > 0);
}

function state(db, note, stored) {
  const source = lines(db, note);
  const receipts = (stored || db.prepare('SELECT * FROM delivery_receipts WHERE delivery_note_id=? ORDER BY id').all(note.id))
    .map(r => ({ ...r, files: parse(r.files_json), items: parse(r.items_json) }));
  if (!receipts.length && note.receipt_file_path) {
    receipts.push({ id: `legacy-${note.id}`, legacy: 1, files: [note.receipt_file_path],
      received_by_name: note.received_by_name || '', received_at: note.received_at || note.delivery_date || '',
      items: source.map(it => ({ ...it, received_qty: it.received_qty == null ? it.quantity : +it.received_qty })) });
  }
  const items = source.map(it => {
    const received = round(receipts.reduce((sum, r) => sum + r.items.filter(x => x.line_key === it.line_key)
      .reduce((n, x) => n + (+x.received_qty || 0), 0), 0));
    return { ...it, received_qty: received, remaining_qty: round(Math.max(0, it.quantity - received)) };
  });
  return { items, receipts, status: !receipts.length ? 'pending'
    : items.some(it => it.remaining_qty > 0) ? 'partial' : 'received' };
}

function addReceipt(db, noteId, body, files, actor, workflow) {
  return db.transaction(() => {
    const note = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(noteId);
    if (!note) fail('Dispatch not found');
    const key = String(body.request_id || '');
    if (key && !/^[a-zA-Z0-9-]{16,80}$/.test(key)) fail('Invalid receiving request ID');
    const previous = key && db.prepare('SELECT * FROM delivery_receipts WHERE request_id=?').get(key);
    if (previous) {
      if (previous.delivery_note_id !== +noteId || previous.created_by !== actor.id) fail('Receiving request belongs to another record');
      return { id: previous.id, existing: true, status: state(db, note).status, stock_ins: 0 };
    }
    if (!files.length) fail('Upload receiving proof');
    if (!String(body.received_by_name || '').trim()) fail('Receiver name is required');
    const current = state(db, note);
    if (!current.items.length) fail('This challan has no valid material quantities. Correct the challan before receiving.');
    if (current.status === 'received') fail('All material on this challan has already been received');
    // A proof saved on a legacy linked invoice must not be counted again.
    if (!current.receipts.length && workflow?.receiving_documents?.length) fail('Receiving is already saved on a linked document. Review that receiving before adding another.');
    let submitted;
    try { submitted = body.items_received ? JSON.parse(body.items_received) : current.items.map(it => ({ line_key: it.line_key, received_qty: it.remaining_qty })); }
    catch { fail('Invalid receiving item quantities'); }
    if (!Array.isArray(submitted)) fail('Receiving item quantities are required');
    const seen = new Set();
    const receivedItems = submitted.map(input => {
      const matches = current.items.filter(it => input.line_key ? it.line_key === input.line_key
        : input.vendor_po_item_id ? +it.vendor_po_item_id === +input.vendor_po_item_id : it.description === input.description);
      if (matches.length !== 1 || seen.has(matches[0].line_key)) fail('Invalid or duplicate receiving item');
      const item = matches[0]; seen.add(item.line_key);
      const qty = Number(input.received_qty);
      if (input.received_qty == null || input.received_qty === '' || !Number.isFinite(qty) || qty < 0 || qty > item.remaining_qty + 0.000001) {
        fail(`Receive between 0 and ${item.remaining_qty} for ${item.description || 'this item'}`);
      }
      return { ...item, received_qty: round(qty), short_reason: String(input.short_reason || '').slice(0, 200) };
    }).filter(it => it.received_qty > 0);
    if (!receivedItems.length) fail('Enter at least one quantity received');
    const warehouse = body.warehouse_id ? +body.warehouse_id : null;
    if (warehouse && !db.prepare('SELECT id FROM warehouses WHERE id=?').get(warehouse)) fail('Invalid warehouse');
    if (warehouse && note.source === 'store') fail('Store issues have already moved stock; do not add them to inventory again');
    const base = lines(db, note);
    db.prepare('UPDATE delivery_notes SET receipt_dispatch_items_json=COALESCE(receipt_dispatch_items_json,?) WHERE id=?').run(JSON.stringify(base), note.id);
    // Preserve old receiving without inventing an uploader or approval credit.
    if (current.receipts[0]?.legacy) {
      const old = current.receipts[0];
      db.prepare(`INSERT INTO delivery_receipts(delivery_note_id,files_json,items_json,received_by_name,received_at,legacy)
        VALUES(?,?,?,?,?,1)`).run(note.id, JSON.stringify(old.files), JSON.stringify(old.items), old.received_by_name, old.received_at);
    }
    const indentId = note.indent_id || (note.vendor_po_id && db.prepare('SELECT indent_id FROM vendor_pos WHERE id=?').get(note.vendor_po_id)?.indent_id) || null;
    const receivingId = db.prepare(`INSERT INTO dispatch_receiving(site_name,indent_id,indent_number,bill_number,receiving_url,created_by)
      VALUES(?,?,?,?,?,?)`).run(workflow?.site_name || workflow?.company_name || 'Site not specified', indentId,
        workflow?.indent_number || '', note.sales_bill_number || workflow?.sales_bill_documents?.[0]?.number || note.document_number || `DN-${note.id}`, files[0], actor.id).lastInsertRowid;
    const result = db.prepare(`INSERT INTO delivery_receipts(delivery_note_id,request_id,files_json,items_json,received_by_name,received_at,created_by,dispatch_receiving_id,warehouse_id)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(note.id,key || null,JSON.stringify(files),JSON.stringify(receivedItems),body.received_by_name.trim(),body.received_at,actor.id,receivingId,warehouse);
    db.prepare('UPDATE dispatch_receiving SET delivery_receipt_id=? WHERE id=?').run(result.lastInsertRowid,receivingId);
    const after = state(db, { ...note, receipt_dispatch_items_json: JSON.stringify(base) });
    // The consignment snapshot also feeds purchase-invoice matching. Site
    // receipts have their own ledger; do not rewrite supplier quantities.
    db.prepare(`UPDATE delivery_notes SET received_by_name=?,received_at=?,receipt_file_path=?,status=?,
      warehouse_id=COALESCE(?,warehouse_id) WHERE id=?`).run(body.received_by_name.trim(),body.received_at,
        files[0],after.status,warehouse,note.id);
    let stockIns = 0;
    if (warehouse && note.vendor_po_id) {
      for (const item of receivedItems) {
        const poItem = db.prepare(`SELECT vpi.rate, ii.item_master_id FROM vendor_po_items vpi
          JOIN indent_items ii ON ii.id=vpi.indent_item_id WHERE vpi.id=? AND vpi.vendor_po_id=?`).get(item.vendor_po_item_id || null,note.vendor_po_id);
        if (!poItem?.item_master_id) continue;
        const qty = item.received_qty, rate = +poItem.rate || 0;
        const balance = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(warehouse,poItem.item_master_id);
        const total = (+balance?.quantity || 0) + qty;
        const avg = total > 0 ? ((+balance?.quantity || 0) * (+balance?.avg_rate || 0) + qty * rate) / total : 0;
        if (balance) db.prepare('UPDATE stock_balance SET quantity=?,avg_rate=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(total,avg,balance.id);
        else db.prepare('INSERT INTO stock_balance(warehouse_id,item_master_id,quantity,avg_rate) VALUES(?,?,?,?)').run(warehouse,poItem.item_master_id,total,avg);
        db.prepare(`INSERT INTO stock_movements(warehouse_id,item_master_id,type,quantity,rate,total_value,reference_type,reference_id,notes,created_by)
          VALUES(?,?,'IN',?,?,?,'RECEIVE',?,?,?)`).run(warehouse,poItem.item_master_id,qty,rate,qty*rate,`RECEIPT-${result.lastInsertRowid}`,`Receiving against ${note.document_number}`,actor.id);
        stockIns++;
      }
    }
    return { id: result.lastInsertRowid, dispatch_receiving_id: receivingId, status: after.status, stock_ins: stockIns };
  }).immediate();
}

module.exports = { initialize, state, lines, addReceipt };
