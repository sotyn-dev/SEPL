// A durable outbox catches challans from every procurement entry point,
// including store issues and old RGP gate passes. Never rewrite asset history
// when a challan is edited, retried, returned, cancelled or deleted.
const { nextSequence } = require('../db/nextSequence');
const clean = value => String(value ?? '').trim();
const norm = value => clean(value).toLowerCase();
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;

function initializeRgpToolsSync(db) {
  db.transaction(() => {
    const firstRun = !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='rgp_tool_sync'").get();
    const columns = db.prepare('PRAGMA table_info(tools)').all().map(c => c.name);
    for (const [name, definition] of [['item_master_id', 'INTEGER REFERENCES item_master(id)'], ['quantity', 'REAL NOT NULL DEFAULT 1 CHECK(quantity > 0)'], ['unit', 'TEXT']]) {
      if (!columns.includes(name)) db.exec(`ALTER TABLE tools ADD COLUMN ${name} ${definition}`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS rgp_tool_sync (
        delivery_note_id INTEGER PRIMARY KEY,
        state TEXT NOT NULL DEFAULT 'pending', reason TEXT,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS rgp_tool_links (
        delivery_note_id INTEGER NOT NULL, line_number INTEGER NOT NULL,
        tool_id INTEGER NOT NULL UNIQUE, snapshot TEXT NOT NULL,
        PRIMARY KEY (delivery_note_id, line_number)
      );
      CREATE TRIGGER IF NOT EXISTS rgp_tools_dn_insert AFTER INSERT ON delivery_notes BEGIN
        INSERT OR REPLACE INTO rgp_tool_sync(delivery_note_id) VALUES (NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS rgp_tools_dn_update AFTER UPDATE ON delivery_notes BEGIN
        INSERT OR REPLACE INTO rgp_tool_sync(delivery_note_id) VALUES (NEW.id);
      END;
      CREATE TRIGGER IF NOT EXISTS rgp_tools_dn_delete AFTER DELETE ON delivery_notes BEGIN
        INSERT OR REPLACE INTO rgp_tool_sync(delivery_note_id) VALUES (OLD.id);
      END;
    `);
    if (firstRun) db.exec('INSERT OR IGNORE INTO rgp_tool_sync(delivery_note_id) SELECT id FROM delivery_notes');
    // Older deployments held distinct challans when their item already existed.
    // A challan line is the import identity, not the item-master entry.
    db.exec("UPDATE rgp_tool_sync SET state='pending', reason=NULL WHERE state='review' AND reason LIKE 'Possible existing asset (%'");
  })();
}

function resolveLines(db, dn) {
  const indent = db.prepare('SELECT * FROM indents WHERE id=?').get(dn.indent_id || db.prepare('SELECT indent_id FROM vendor_pos WHERE id=?').get(dn.vendor_po_id)?.indent_id || null);
  if (!indent) {
    if (norm(dn.source) === 'rgp' || /"item_type"\s*:\s*"RGP"/i.test(dn.items_json || '')) throw new Error('RGP challan has no linked indent');
    return [];
  }
  const items = db.prepare(`SELECT ii.*, im.item_code, im.item_name, im.type AS master_type,
      im.department, im.uom, im.size AS master_size, im.specification AS master_specification
      FROM indent_items ii LEFT JOIN item_master im ON im.id=ii.item_master_id WHERE ii.indent_id=?`).all(indent.id);
  const rgp = items.filter(i => norm(i.item_type) === 'rgp' || norm(i.master_type) === 'rgp');
  if (!rgp.length) return [];
  let lines;
  try { lines = JSON.parse(dn.items_json || 'null'); } catch (_) { /* reported below */ }
  if (!Array.isArray(lines) || !lines.length) throw new Error('Missing dispatch quantities; fill challan items before importing');
  const sites = db.prepare('SELECT id FROM sites WHERE LOWER(TRIM(name))=?').all(norm(indent.site_name));
  const users = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(name))=?').all(norm(indent.raised_by_name));
  const result = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (!line || line.include === false) continue;
    let matches;
    if (line.indent_item_id) matches = items.filter(i => i.id === Number(line.indent_item_id));
    else if (line.vendor_po_item_id) {
      const vpi = db.prepare('SELECT indent_item_id FROM vendor_po_items WHERE id=? AND vendor_po_id=?').get(line.vendor_po_item_id, dn.vendor_po_id);
      matches = items.filter(i => i.id === vpi?.indent_item_id);
    } else if (line.item_master_id) matches = items.filter(i => i.item_master_id === Number(line.item_master_id));
    else if (clean(line.item_code)) matches = items.filter(i => norm(i.item_code) === norm(line.item_code));
    else matches = items.filter(i => [i.description, i.item_name,
      [i.description || i.item_name, i.master_size, i.master_specification].filter(Boolean).join(' / ')]
      .some(name => clean(name) && norm(name) === norm(line.description || line.item_name)));
    if (matches.length !== 1) throw new Error(`Line ${index + 1}: item cannot be matched uniquely to the indent`);
    const item = matches[0];
    if (!rgp.some(i => i.id === item.id)) continue;
    const rawQuantity = line.qty ?? line.quantity;
    if (!clean(rawQuantity)) throw new Error(`Line ${index + 1}: missing dispatched quantity`);
    const quantity = Number(rawQuantity);
    if (quantity === 0) continue;
    if (!positive(quantity)) throw new Error(`Line ${index + 1}: invalid dispatched quantity`);
    if (!item.item_master_id || norm(item.master_type) !== 'rgp') throw new Error(`Line ${index + 1}: link the indent item to an RGP Item Master entry`);
    if (!clean(indent.site_name) || sites.length !== 1) throw new Error('Indent site is missing or matches multiple sites');
    if (!clean(indent.raised_by_name) || users.length !== 1) throw new Error('Indent Raised By is missing or matches multiple employees');
    // RGP challans intentionally carry a zero billing rate. Use the recorded
    // indent cost in that case, never today's item-master price for old assets.
    const rate = positive(line.rate) ? Number(line.rate) : Number(item.rate);
    if (!positive(rate)) throw new Error(`Line ${index + 1}: recorded asset cost is missing; fill the indent rate`);
    if (!Number.isFinite(quantity * rate)) throw new Error(`Line ${index + 1}: invalid asset value`);
    const unit = clean(line.unit || item.unit || item.uom);
    if (!unit || (clean(item.unit) && norm(unit) !== norm(item.unit))) throw new Error(`Line ${index + 1}: check dispatch unit against indent unit`);
    result.push({ line_number: index + 1, item_master_id: item.item_master_id,
      name: item.item_name || item.description, category: item.department || 'Other',
      quantity, unit, purchase_price: Math.round(quantity * rate * 100) / 100,
      site_id: sites[0].id, user_id: users[0].id, created_by: indent.created_by,
      date: dn.delivery_date || null, indent_number: indent.indent_number,
      document_number: dn.document_number, raised_by: indent.raised_by_name,
      site_name: indent.site_name, rate_source: positive(line.rate) ? 'Challan rate' : 'Indent rate', rate });
  }
  return result;
}

function syncDocument(db, id) {
  const dn = db.prepare('SELECT * FROM delivery_notes WHERE id=?').get(id);
  const links = db.prepare('SELECT * FROM rgp_tool_links WHERE delivery_note_id=? ORDER BY line_number').all(id);
  const eligible = dn && dn.document_type === 'challan' && !dn.is_draft && dn.status !== 'rejected';
  if (!eligible) {
    if (links.length) throw new Error('Imported challan was deleted, rejected or changed; review existing tools and their movement history');
    return 'ignored';
  }
  const lines = resolveLines(db, dn);
  if (links.length) {
    if (links.length !== lines.length || links.some((link, i) => link.snapshot !== JSON.stringify(lines[i]) || !db.prepare('SELECT id FROM tools WHERE id=?').get(link.tool_id))) {
      throw new Error('Imported challan details changed; review existing tools before adjusting quantities or value');
    }
    return 'imported'; // A retry must never re-issue a returned tool.
  }
  if (!lines.length) return 'ignored';
  for (const line of lines) {
    const note = `${line.document_number || 'Challan #' + id} / ${line.indent_number}; Raised by: ${line.raised_by}; Site: ${line.site_name}; ${line.rate_source}: ${line.rate} × ${line.quantity} ${line.unit}`;
    const tool = db.prepare(`INSERT INTO tools (item_master_id, tool_code, serial_no, name, category, quantity, unit,
      purchase_price, purchase_date, status, condition, current_site_id, current_user_id, created_by, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_use', 'good', ?, ?, ?, ?)`).run(
      line.item_master_id, nextSequence(db, 'tools', 'tool_code', `T-${new Date().getFullYear()}-`, { pad: 4 }),
      nextSequence(db, 'tools', 'serial_no', ''), line.name, line.category, line.quantity, line.unit,
      line.purchase_price, line.date, line.site_id, line.user_id, line.created_by, note);
    db.prepare(`INSERT INTO tool_movements (tool_id, action, to_site_id, to_user_id, condition_at_action, notes, created_by)
      VALUES (?, 'issue', ?, ?, 'good', ?, ?)`).run(tool.lastInsertRowid, line.site_id, line.user_id, note, line.created_by);
    db.prepare('INSERT INTO rgp_tool_links(delivery_note_id,line_number,tool_id,snapshot) VALUES (?,?,?,?)')
      .run(id, line.line_number, tool.lastInsertRowid, JSON.stringify(line));
  }
  return 'imported';
}

function drainRgpToolsSync(db, { retry = false, deliveryNoteId = null } = {}) {
  const queue = deliveryNoteId
    ? db.prepare('SELECT delivery_note_id FROM rgp_tool_sync WHERE delivery_note_id=?').all(deliveryNoteId)
    : db.prepare(`SELECT delivery_note_id FROM rgp_tool_sync WHERE state='pending' ${retry ? "OR state='review'" : ''} ORDER BY delivery_note_id`).all();
  for (const { delivery_note_id: id } of queue) {
    try {
      db.transaction(() => {
        const state = syncDocument(db, id);
        db.prepare("UPDATE rgp_tool_sync SET state=?, reason=NULL, updated_at=CURRENT_TIMESTAMP WHERE delivery_note_id=?").run(state, id);
      })();
    } catch (error) {
      db.prepare("UPDATE rgp_tool_sync SET state='review', reason=?, updated_at=CURRENT_TIMESTAMP WHERE delivery_note_id=?").run(error.message, id);
    }
  }
  return getRgpToolsSyncStatus(db);
}

function getRgpToolsSyncStatus(db) {
  return {
    imported: db.prepare('SELECT COUNT(*) AS n FROM rgp_tool_links').get().n,
    review: db.prepare(`SELECT q.*, dn.document_number, i.indent_number, i.site_name, i.raised_by_name
      FROM rgp_tool_sync q LEFT JOIN delivery_notes dn ON dn.id=q.delivery_note_id
      LEFT JOIN vendor_pos vp ON vp.id=dn.vendor_po_id LEFT JOIN indents i ON i.id=COALESCE(dn.indent_id,vp.indent_id)
      WHERE q.state IN ('review','pending') ORDER BY q.delivery_note_id DESC`).all(),
  };
}

function rgpToolsBridge(db) {
  initializeRgpToolsSync(db);
  drainRgpToolsSync(db); // One-time historical seed, then only durable pending work.
  return (req, res, next) => {
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      res.once('finish', () => {
        try { drainRgpToolsSync(db); }
        catch (error) { console.error('[rgp-tools-sync]', error.message); }
      });
    }
    next();
  };
}

module.exports = { initializeRgpToolsSync, drainRgpToolsSync, getRgpToolsSyncStatus, rgpToolsBridge };
