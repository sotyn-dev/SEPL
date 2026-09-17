const { createHash } = require('node:crypto');
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS po_make_approvals (
    po_id INTEGER NOT NULL, po_item_id INTEGER NOT NULL, make TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', item_hash TEXT NOT NULL,
    submitted_by INTEGER NOT NULL, submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
    reviewed_by INTEGER, reviewed_at TEXT, PRIMARY KEY(po_id,po_item_id)
  );
  CREATE TABLE IF NOT EXISTS po_make_approval_log (
    id INTEGER PRIMARY KEY, po_id INTEGER, po_item_id INTEGER, make TEXT,
    action TEXT, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );`);
}
function item(db, poId, itemId) {
  return db.prepare(`SELECT i.* FROM po_items i JOIN purchase_orders p ON p.id=?
    WHERE i.id=? AND (i.po_id=p.id OR (i.po_id IS NULL AND i.business_book_id=p.business_book_id))`).get(poId,itemId);
}
function hash(i) {
  return createHash('sha256').update(JSON.stringify([i.description,i.item_master_id,i.quantity,i.unit])).digest('hex');
}
function selectMake(db, poId, itemId, make, userId) {
  const i = item(db,poId,itemId);
  if (!i) throw Object.assign(new Error('BOQ item not found for this order'),{status:404});
  make = String(make || '').trim();
  if (!make || make.length > 120) throw Object.assign(new Error('Choose a make (maximum 120 characters)'),{status:400});
  return db.transaction(() => {
    const old = db.prepare('SELECT * FROM po_make_approvals WHERE po_id=? AND po_item_id=?').get(poId,itemId);
    if (old?.make === make && old.item_hash === hash(i) && old.status !== 'rejected') return;
    db.prepare(`INSERT INTO po_make_approvals(po_id,po_item_id,make,item_hash,submitted_by) VALUES(?,?,?,?,?)
      ON CONFLICT(po_id,po_item_id) DO UPDATE SET make=excluded.make,item_hash=excluded.item_hash,
      submitted_by=excluded.submitted_by,submitted_at=CURRENT_TIMESTAMP,status='pending',reviewed_by=NULL,reviewed_at=NULL`)
      .run(poId,itemId,make,hash(i),userId);
    db.prepare("INSERT INTO po_make_approval_log(po_id,po_item_id,make,action,user_id) VALUES(?,?,?,'submitted',?)").run(poId,itemId,make,userId);
  })();
}
function review(db,poId,itemId,status,userId,expectedMake) {
  if (!['approved','rejected'].includes(status)) throw Object.assign(new Error('Choose Approve or Reject'),{status:400});
  return db.transaction(() => {
    const i = item(db,poId,itemId);
    const row = db.prepare('SELECT * FROM po_make_approvals WHERE po_id=? AND po_item_id=?').get(poId,itemId);
    if (!i || !row) throw Object.assign(new Error('Select and submit a make first'),{status:400});
    if (row.item_hash !== hash(i) || row.make !== expectedMake) throw Object.assign(new Error('Entry changed. Refresh and submit the make again.'),{status:409});
    if (row.status === status) return;
    if (row.status !== 'pending') throw Object.assign(new Error('This selection has already been reviewed'),{status:409});
    db.prepare('UPDATE po_make_approvals SET status=?,reviewed_by=?,reviewed_at=CURRENT_TIMESTAMP WHERE po_id=? AND po_item_id=?').run(status,userId,poId,itemId);
    db.prepare('INSERT INTO po_make_approval_log(po_id,po_item_id,make,action,user_id) VALUES(?,?,?,?,?)').run(poId,itemId,row.make,status,userId);
  })();
}
module.exports = { initialize, item, hash, selectMake, review };
