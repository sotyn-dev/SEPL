const { createHash } = require('node:crypto');

function initialize(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(purchase_orders)').all().map(c => c.name));
  for (const [name, type] of [['final_approval_hash','TEXT'],['final_approved_at','TEXT'],['final_approved_by','INTEGER']]) {
    if (!cols.has(name)) db.exec(`ALTER TABLE purchase_orders ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS po_final_approval_log (
    id INTEGER PRIMARY KEY, po_id INTEGER NOT NULL, snapshot_hash TEXT NOT NULL,
    approved_by INTEGER NOT NULL, approved_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

function snapshot(db, id) {
  const po = db.prepare('SELECT * FROM purchase_orders WHERE id=?').get(id);
  if (!po) return null;
  const items = db.prepare(`SELECT * FROM po_items WHERE po_id=?
    OR (po_id IS NULL AND business_book_id=?) ORDER BY sr_no,id`).all(po.id, po.business_book_id || -1);
  const fields = Object.fromEntries(Object.entries(po).filter(([k]) => !k.startsWith('final_approv')));
  const hash = createHash('sha256').update(JSON.stringify({ po: fields, items })).digest('hex');
  return { po, items, hash };
}

function state(db, id) {
  const s = snapshot(db, id);
  if (!s) return null;
  return {
    final_approval_status: s.po.final_approval_hash === s.hash ? 'approved' : s.po.final_approval_hash ? 'needs_reapproval' : 'pending',
    final_approved_at: s.po.final_approved_at,
    final_approved_by_name: s.po.final_approved_by ? db.prepare('SELECT name FROM users WHERE id=?').get(s.po.final_approved_by)?.name || '' : '',
  };
}

function approve(db, id, userId) {
  return db.transaction(() => {
    const s = snapshot(db, id);
    if (!s) throw Object.assign(new Error('Purchase order not found'), { status: 404 });
    if (!s.po.business_book_id || !(s.po.site_engineer_id || s.po.site_engineer_ids) || !s.po.crm_name) {
      throw Object.assign(new Error('Complete the project, site engineer and CRM details before approval.'), { status: 400 });
    }
    if (!s.items.length || s.items.some(i => !String(i.description || '').trim() || !(Number(i.quantity) > 0) || !String(i.unit || '').trim())) {
      throw Object.assign(new Error('Complete BOQ descriptions, positive quantities and units before approval.'), { status: 400 });
    }
    if (s.po.final_approval_hash !== s.hash) {
      db.prepare('UPDATE purchase_orders SET final_approval_hash=?, final_approved_by=?, final_approved_at=CURRENT_TIMESTAMP WHERE id=?').run(s.hash, userId, id);
      db.prepare('INSERT INTO po_final_approval_log(po_id,snapshot_hash,approved_by) VALUES(?,?,?)').run(id,s.hash,userId);
    }
    return state(db, id);
  })();
}
module.exports = { initialize, state, approve };
