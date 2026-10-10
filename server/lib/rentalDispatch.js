const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('./istDate');
const clean = value => String(value ?? '').trim();
const fail = (message, status = 400) => { throw Object.assign(new Error(message), { status }); };
const parse = value => { try { return JSON.parse(value || 'null'); } catch { return null; } };

function initialize(db) {
  db.transaction(() => {
    for (const [table, name, definition] of [
      ['delivery_notes', 'rental_confirmed_at', 'TEXT'],
      ['delivery_notes', 'rental_revision', 'INTEGER NOT NULL DEFAULT 0'],
      ['delivery_notes', 'rental_request_id', 'TEXT'],
      ['delivery_notes', 'rental_request_payload', 'TEXT'],
      ['rental_tool_enquiry', 'dispatch_item_id', 'INTEGER REFERENCES rental_dispatch_items(id)'],
      ['rental_tool_enquiry', 'dispatch_snapshot', 'TEXT'],
      ['rental_tool_history', 'details_json', 'TEXT'],
    ]) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`CREATE TABLE IF NOT EXISTS rental_dispatch_items (
      id INTEGER PRIMARY KEY, delivery_note_id INTEGER NOT NULL REFERENCES delivery_notes(id),
      line_key TEXT NOT NULL, indent_item_id INTEGER NOT NULL REFERENCES indent_items(id),
      vendor_po_item_id INTEGER REFERENCES vendor_po_items(id),
      quantity REAL NOT NULL CHECK(quantity > 0), rental_start_date TEXT NOT NULL,
      rental_days INTEGER NOT NULL CHECK(rental_days > 0), rental_end_date TEXT NOT NULL,
      initial_start_date TEXT NOT NULL, initial_days INTEGER NOT NULL, initial_end_date TEXT NOT NULL,
      snapshot TEXT NOT NULL, created_by INTEGER REFERENCES users(id),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(delivery_note_id, line_key)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS rental_dispatch_enquiry ON rental_tool_enquiry(dispatch_item_id) WHERE dispatch_item_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS rental_dispatch_request ON delivery_notes(rental_request_id) WHERE rental_request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS rental_dispatch_indent_item ON rental_dispatch_items(indent_item_id);
    CREATE INDEX IF NOT EXISTS rental_dispatch_po_item ON rental_dispatch_items(vendor_po_item_id);
    CREATE TRIGGER IF NOT EXISTS rental_dispatch_preserve_delete BEFORE DELETE ON delivery_notes
      WHEN OLD.rental_confirmed_at IS NOT NULL BEGIN SELECT RAISE(ABORT, 'Confirmed rental dispatch history cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS rental_dispatch_preserve_items BEFORE UPDATE OF items_json,vendor_po_id,indent_id ON delivery_notes
      WHEN OLD.rental_confirmed_at IS NOT NULL AND NEW.rental_revision <= OLD.rental_revision
        AND (NEW.items_json IS NOT OLD.items_json OR NEW.vendor_po_id IS NOT OLD.vendor_po_id OR NEW.indent_id IS NOT OLD.indent_id)
      BEGIN SELECT RAISE(ABORT, 'Edit confirmed rental items using Rental dispatch details'); END;`);
  })();
}

function period(start, days) {
  if (typeof start !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(start)) fail('Rental Start Date is required (YYYY-MM-DD)');
  const date = new Date(`${start}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== start) fail('Enter a valid Rental Start Date');
  const count = Number(days);
  if (!Number.isSafeInteger(count) || count <= 0 || typeof days === 'boolean') fail('Total Rental Days must be a positive whole number');
  date.setUTCDate(date.getUTCDate() + count - 1);
  if (!Number.isFinite(date.getTime()) || date.getUTCFullYear() > 9999) fail('Rental period is too large');
  return { rental_start_date: start, rental_days: count, rental_end_date: date.toISOString().slice(0, 10) };
}

// Resolve only explicit foreign keys (or an unambiguous legacy item code).
// Never trust client-supplied type, site, vendor, rate or indent identifiers.
function context(db, { noteId, poId }) {
  const note = noteId ? db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(noteId) : null;
  if (noteId && !note) fail('Dispatch not found', 404);
  if (note && note.document_type !== 'challan') fail('Rental dispatch requires a delivery challan');
  const po = db.prepare('SELECT * FROM vendor_pos WHERE id=?').get(note?.vendor_po_id || poId || null);
  const indent = db.prepare('SELECT * FROM indents WHERE id=?').get(po?.indent_id || note?.indent_id || null);
  if (!indent) return { note, po, indent: null, items: [] };
  const all = db.prepare(`SELECT ii.*, im.item_code, im.item_name, im.type AS master_type,
    im.specification, im.size, im.uom FROM indent_items ii LEFT JOIN item_master im ON im.id=ii.item_master_id
    WHERE ii.indent_id=? ORDER BY ii.id`).all(indent.id);
  const linked = po ? db.prepare('SELECT * FROM vendor_po_items WHERE vendor_po_id=? ORDER BY id').all(po.id) : [];
  const saved = note && parse(note.items_json);
  if (note?.items_json && !Array.isArray(saved)) fail('Correct the saved challan items before confirming rental dispatch');
  const candidates = Array.isArray(saved) ? saved : po ? linked.map(p => ({ vendor_po_item_id: p.id, quantity: p.quantity })) : [];
  const items = [];
  for (const line of candidates.filter(it => it && it.include !== false)) {
    const vp = linked.find(p => p.id === +line.vendor_po_item_id);
    let item = all.find(it => it.id === +(vp?.indent_item_id || line.indent_item_id));
    if (!item && !line.vendor_po_item_id) {
      const matches = all.filter(it => (line.item_master_id && it.item_master_id === +line.item_master_id)
        || (line.item_code && it.item_code === line.item_code));
      if (matches.length === 1) item = matches[0];
    }
    const rental = clean(item?.item_type).toUpperCase() === 'RENTAL' || clean(item?.master_type).toUpperCase() === 'RENTAL'
      || clean(indent.indent_category).toLowerCase() === 'rental';
    if (!item && (rental || clean(line.item_type).toUpperCase() === 'RENTAL')) fail('A rental challan line has no unambiguous indent-item link; correct its item link first');
    if (!rental) continue;
    if (po && !vp) fail('A rental challan line has no valid Vendor PO item link');
    const key = vp ? `vpi:${vp.id}` : `ii:${item.id}`;
    if (items.some(it => it.line_key === key)) fail('Duplicate rental item links on this challan; correct the item links first');
    const dispatched = db.prepare(`SELECT COALESCE(SUM(quantity),0) qty FROM rental_dispatch_items
      WHERE indent_item_id=? AND delivery_note_id<>?`).get(item.id, note?.id || 0).qty;
    const poDispatched = vp ? db.prepare(`SELECT COALESCE(SUM(quantity),0) qty FROM rental_dispatch_items
      WHERE vendor_po_item_id=? AND delivery_note_id<>?`).get(vp.id, note?.id || 0).qty : dispatched;
    const limit = Math.min(+item.quantity - dispatched, vp ? +vp.quantity - poDispatched : Infinity);
    const savedQty = Number(line.qty ?? line.quantity ?? line.received_qty ?? line.ordered_qty ?? 0);
    const existing = note && db.prepare('SELECT * FROM rental_dispatch_items WHERE delivery_note_id=? AND line_key=?').get(note.id, key);
    items.push({ line_key: key, indent_item_id: item.id, vendor_po_item_id: vp?.id || null,
      item_master_id: item.item_master_id, item_code: item.item_code, item_name: item.item_name || item.description,
      description: item.description, specification: item.specification, size: item.size, unit: item.unit || item.uom,
      rental_rate_per_day: item.rental_rate_per_day ?? vp?.rate ?? item.rate ?? null,
      max_quantity: Math.max(0, note && !existing ? Math.min(limit, savedQty) : limit),
      quantity: existing?.quantity ?? Math.max(0, Math.min(limit, savedQty)),
      rental_start_date: existing?.rental_start_date || '', rental_days: existing?.rental_days ?? item.rental_days ?? '',
      rental_end_date: existing?.rental_end_date || '', existing_id: existing?.id || null });
  }
  return { note, po, indent, items };
}

function requestItems(input) {
  const rows = typeof input === 'string' ? parse(input) : input;
  if (!Array.isArray(rows) || !rows.length) fail('Select rental items and enter Rental Start Date and Total Rental Days');
  const seen = new Set();
  return rows.map(it => {
    const key = clean(it?.line_key);
    if (!key || seen.has(key)) fail('Invalid or duplicate rental item');
    seen.add(key);
    const quantity = Number(it.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0 || typeof it.quantity === 'boolean') fail('Rental quantity must be greater than zero');
    return { line_key: key, quantity, ...period(it.rental_start_date, it.rental_days) };
  }).sort((a, b) => a.line_key.localeCompare(b.line_key));
}

function confirm(db, noteId, body, actor) {
  return db.transaction(() => {
    const ctx = context(db, { noteId });
    const { note, indent, po } = ctx;
    if (!ctx.items.length) fail('This challan has no linked rental items');
    const inputs = requestItems(body.rental_items);
    const prior = db.prepare('SELECT * FROM rental_dispatch_items WHERE delivery_note_id=? ORDER BY line_key').all(note.id);
    const current = prior.map(it => ({ line_key: it.line_key, quantity: it.quantity, rental_start_date: it.rental_start_date, rental_days: it.rental_days, rental_end_date: it.rental_end_date }))
      .sort((a,b) => a.line_key.localeCompare(b.line_key));
    if (prior.length && JSON.stringify(current) === JSON.stringify(inputs)) return { id: note.id, existing: true, revision: note.rental_revision };
    if (po?.cancelled || !['approved','po_sent','dispatched','received'].includes(indent.status)) fail('Approve the indent and use an active Vendor PO before rental dispatch', 409);
    if (note.rental_confirmed_at && Number(body.revision) !== note.rental_revision) fail('Rental dispatch changed. Refresh before editing.', 409);
    if (prior.some(it => !inputs.some(row => row.line_key === it.line_key))) fail('Confirmed rental lines cannot be removed; their history must be retained', 409);
    if (note.receipt_file_path || db.prepare('SELECT id FROM delivery_receipts WHERE delivery_note_id=? LIMIT 1').get(note.id)) {
      fail('This challan has receiving history. Rental quantities and dates require a reviewed correction; history cannot be overwritten.', 409);
    }
    const vendor = db.prepare('SELECT * FROM vendors WHERE id=?').get(po?.vendor_id || null);
    const raisedBy = db.prepare('SELECT name FROM users WHERE id=?').get(indent.created_by || null);
    const approvedBy = db.prepare('SELECT name FROM users WHERE id=?').get(indent.approved_by || null);
    const project = db.prepare('SELECT business_book_id FROM order_planning WHERE id=?').get(indent.planning_id || null);
    const site = db.prepare('SELECT id FROM sites WHERE id=?').get(indent.site_id || null);
    const byName = !site && indent.site_name ? db.prepare('SELECT id FROM sites WHERE name=?').all(indent.site_name) : [];
    const records = inputs.map(input => {
      const item = ctx.items.find(it => it.line_key === input.line_key);
      if (!item) fail('Rental item does not belong to this dispatch');
      if (input.quantity > item.max_quantity + 0.000001) fail(`${item.item_name}: quantity exceeds the remaining ${item.max_quantity} ${item.unit || ''}`);
      const old = prior.find(it => it.line_key === input.line_key);
      const enquiry = old && db.prepare('SELECT * FROM rental_tool_enquiry WHERE dispatch_item_id=?').get(old.id);
      if (enquiry && (enquiry.current_stage !== 'rate_finalised' || enquiry.status !== 'open')) fail('Rental has receiving, return or cancellation history; it cannot be overwritten', 409);
      return { ...item, ...input, indent_id: indent.id, indent_number: indent.indent_number,
        dispatch_id: note.id, dispatch_number: note.document_number, dispatch_status: 'dispatched', receiving_status: note.status || 'pending',
        site_id: site?.id || (byName.length === 1 ? byName[0].id : null), site_name: indent.site_name || indent.client_name || '',
        planning_id: indent.planning_id, project_id: project?.business_book_id || null, vendor_id: vendor?.id || null, vendor_name: vendor?.name || '',
        vendor_po_id: po?.id || null, vendor_po_number: po?.po_number || null,
        raised_by: indent.created_by, raised_by_name: indent.raised_by_name || raisedBy?.name || '',
        approved_by: indent.approved_by, approved_by_name: approvedBy?.name || '', approved_at: indent.approved_at, confirmed_by: actor.id };
    });
    const base = require('./deliveryReceipts').lines(db, note);
    const rentalIds = new Set(ctx.items.map(it => it.indent_item_id));
    const rentalPoIds = new Set(ctx.items.map(it => it.vendor_po_item_id).filter(Boolean));
    const otherItems = base.filter(it => !rentalPoIds.has(+it.vendor_po_item_id) && !rentalIds.has(+it.indent_item_id)
      && !ctx.items.some(r => (it.item_code && r.item_code === it.item_code) || (it.item_master_id && r.item_master_id === +it.item_master_id)));
    const snapshotItems = records.map(it => ({ ...it, item_type: 'RENTAL', qty: it.quantity }));
    db.prepare(`UPDATE delivery_notes SET items_json=?, rental_confirmed_at=COALESCE(rental_confirmed_at,CURRENT_TIMESTAMP),
      rental_revision=rental_revision+1 WHERE id=?`).run(JSON.stringify([...otherItems, ...snapshotItems]), note.id);
    for (const record of records) {
      const snapshot = JSON.stringify(record);
      const old = prior.find(it => it.line_key === record.line_key);
      let id = old?.id;
      if (old) db.prepare(`UPDATE rental_dispatch_items SET quantity=?,rental_start_date=?,rental_days=?,rental_end_date=?,snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(record.quantity, record.rental_start_date, record.rental_days, record.rental_end_date, snapshot, id);
      else id = db.prepare(`INSERT INTO rental_dispatch_items(delivery_note_id,line_key,indent_item_id,vendor_po_item_id,quantity,
        rental_start_date,rental_days,rental_end_date,initial_start_date,initial_days,initial_end_date,snapshot,created_by)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(note.id, record.line_key, record.indent_item_id, record.vendor_po_item_id, record.quantity,
          record.rental_start_date, record.rental_days, record.rental_end_date, record.rental_start_date, record.rental_days, record.rental_end_date, snapshot, actor.id).lastInsertRowid;
      let enquiry = db.prepare('SELECT * FROM rental_tool_enquiry WHERE dispatch_item_id=?').get(id);
      if (enquiry) db.prepare(`UPDATE rental_tool_enquiry SET dispatch_snapshot=?,date_of_requirement=?,days_required=?,return_target_date=?,
        tool_description=?,vendor_rate=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(snapshot, record.rental_start_date, record.rental_days,
          record.rental_end_date, [record.item_name, record.specification, record.size].filter(Boolean).join(' · '), record.rental_rate_per_day, enquiry.id);
      else {
        const number = nextSequence(db, 'rental_tool_enquiry', 'enquiry_no', `RT-${istToday().slice(0,4)}-`, { pad: 4 });
        const newId = db.prepare(`INSERT INTO rental_tool_enquiry(enquiry_no,site_id,site_name,tool_description,date_of_requirement,days_required,
          current_stage,status,vendor_id,vendor_name,vendor_rate,return_target_date,created_by,dispatch_item_id,dispatch_snapshot)
          VALUES(?,?,?,?,?,?,'rate_finalised','open',?,?,?,?,?,?,?)`).run(number, record.site_id, record.site_name,
            [record.item_name, record.specification, record.size].filter(Boolean).join(' · '), record.rental_start_date, record.rental_days,
            record.vendor_id, record.vendor_name, record.rental_rate_per_day, record.rental_end_date, actor.id, id, snapshot).lastInsertRowid;
        enquiry = { id: newId };
      }
      // Keep the existing "material at site" SLA for enquiries that originate
      // from dispatch, without changing their agreed calendar rental end date.
      const stage2Target = require('./businessHours').addBusinessHours(new Date(`${record.rental_start_date}T09:00:00`), 8).toISOString();
      db.prepare('UPDATE rental_tool_enquiry SET stage2_target_at=? WHERE id=?').run(stage2Target, enquiry.id);
      db.prepare(`INSERT INTO rental_tool_history(enquiry_id,from_stage,to_stage,triggered_by,notes,details_json) VALUES(?,?,?,?,?,?)`)
        .run(enquiry.id, old ? 'rate_finalised' : null, 'rate_finalised', String(actor.id),
          `${old ? 'Corrected' : 'Confirmed'} dispatch ${note.document_number}: ${record.item_name}, ${record.quantity} ${record.unit || ''}, ${record.rental_start_date} to ${record.rental_end_date} (${record.rental_days} calendar days).${old ? ` Previous: ${old.quantity}, ${old.rental_start_date} to ${old.rental_end_date}.` : ' Awaiting site receipt.'}`,
          JSON.stringify({ action: old ? 'dispatch_corrected' : 'dispatch_confirmed', before: old ? parse(old.snapshot) : null, after: record }));
    }
    return { id: note.id, revision: note.rental_revision + 1, rental_items: records.length };
  }).immediate();
}

function create(db, poId, body, actor) {
  return db.transaction(() => {
    const key = clean(body.request_id);
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(key)) fail('A valid dispatch request ID is required');
    const inputs = requestItems(body.rental_items);
    const payload = JSON.stringify({ poId: +poId, actor: actor.id, items: inputs });
    const previous = db.prepare('SELECT * FROM delivery_notes WHERE rental_request_id=?').get(key);
    if (previous) {
      if (previous.rental_request_payload !== payload) fail('This dispatch request was already used with different details', 409);
      return { id: previous.id, document_number: previous.document_number, existing: true, revision: previous.rental_revision };
    }
    const ctx = context(db, { poId });
    if (!ctx.items.length) fail('This PO has no linked rental items');
    const lines = inputs.map(input => {
      const item = ctx.items.find(it => it.line_key === input.line_key);
      if (!item) fail('Rental item does not belong to this PO');
      return { ...item, ...input, qty: input.quantity, item_type: 'RENTAL' };
    });
    const number = nextSequence(db, 'delivery_notes', 'document_number', `DC/${istToday().slice(0,4)}/`, { pad: 4 });
    const id = db.prepare(`INSERT INTO delivery_notes(vendor_po_id,indent_id,document_type,document_number,delivery_date,status,items_json,rental_request_id,rental_request_payload,received_by)
      VALUES(?,?,'challan',?,?,'pending',?,?,?,?)`).run(poId, ctx.indent.id, number, istToday(), JSON.stringify(lines), key, payload, actor.id).lastInsertRowid;
    return { ...confirm(db, id, { rental_items: inputs }, actor), document_number: number };
  }).immediate();
}

function decorate(db, row) {
  if (!row.dispatch_item_id) return row;
  const snapshot = parse(row.dispatch_snapshot) || {};
  const note = db.prepare('SELECT status FROM delivery_notes WHERE id=?').get(snapshot.dispatch_id);
  return { ...row, dispatch: { ...snapshot, receiving_status: note?.status || snapshot.receiving_status } };
}

module.exports = { initialize, period, context, requestItems, confirm, create, decorate };
