// Run with Node 22.13+ / Node 24: node --test server/lib/rgpToolsSync.test.js
// node:sqlite keeps these database integration tests independent of native addons.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { EventEmitter } = require('node:events');
const { initializeRgpToolsSync, drainRgpToolsSync, rgpToolsBridge } = require('./rgpToolsSync');
const { TOOLS_SITE_SUMMARY_SQL } = require('./toolsSiteSummary');

function fixture() {
  const db = new DatabaseSync(':memory:');
  let savepoint = 0;
  db.transaction = fn => (...args) => {
    const key = `test_${++savepoint}`;
    db.exec(`SAVEPOINT ${key}`);
    try { const result = fn(...args); db.exec(`RELEASE ${key}`); return result; }
    catch (error) { db.exec(`ROLLBACK TO ${key}; RELEASE ${key}`); throw error; }
  };
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY, name TEXT);
    CREATE TABLE sites(id INTEGER PRIMARY KEY, name TEXT, site_engineer_id INTEGER, po_id INTEGER, business_book_id INTEGER);
    CREATE TABLE purchase_orders(id INTEGER, business_book_id INTEGER, site_engineer_id INTEGER, site_engineer_ids TEXT);
    CREATE TABLE indents(id INTEGER PRIMARY KEY, site_name TEXT, raised_by_name TEXT, created_by INTEGER, indent_number TEXT);
    CREATE TABLE item_master(id INTEGER PRIMARY KEY, item_name TEXT, item_code TEXT, type TEXT, department TEXT, uom TEXT, size TEXT, specification TEXT);
    CREATE TABLE indent_items(id INTEGER PRIMARY KEY, indent_id INTEGER, item_master_id INTEGER, item_type TEXT, description TEXT, unit TEXT, quantity REAL, rate REAL);
    CREATE TABLE vendor_pos(id INTEGER PRIMARY KEY, indent_id INTEGER);
    CREATE TABLE vendor_po_items(id INTEGER PRIMARY KEY, vendor_po_id INTEGER, indent_item_id INTEGER);
    CREATE TABLE delivery_notes(id INTEGER PRIMARY KEY AUTOINCREMENT, indent_id INTEGER, vendor_po_id INTEGER, source TEXT, document_type TEXT DEFAULT 'challan', is_draft INTEGER DEFAULT 0, status TEXT DEFAULT 'pending', items_json TEXT, delivery_date TEXT, document_number TEXT);
    CREATE TABLE tools(id INTEGER PRIMARY KEY, item_master_id INTEGER, tool_code TEXT UNIQUE, serial_no TEXT, name TEXT, category TEXT, quantity REAL CHECK(quantity > 0), unit TEXT, purchase_price REAL, purchase_date TEXT, status TEXT, condition TEXT, current_site_id INTEGER REFERENCES sites(id), current_user_id INTEGER REFERENCES users(id), created_by INTEGER, notes TEXT);
    CREATE TABLE tool_movements(id INTEGER PRIMARY KEY, tool_id INTEGER REFERENCES tools(id), action TEXT, to_site_id INTEGER, to_user_id INTEGER, condition_at_action TEXT, notes TEXT, created_by INTEGER);
    INSERT INTO users VALUES(1,'Admin'),(2,'Engineer');
    INSERT INTO sites VALUES(1,'Site A',2,NULL,NULL);
    INSERT INTO indents VALUES(1,'Site A','Engineer',1,'IND-1');
    INSERT INTO item_master VALUES(1,'Drill','R001','RGP','ELE','Nos',NULL,NULL),(2,'Cable','C002','CONSUMABLE','ELE','Mtr',NULL,NULL);
    INSERT INTO indent_items VALUES(1,1,1,'RGP','Drill','Nos',10,125),(2,1,2,'CONSUMABLE','Cable','Mtr',20,10);
    INSERT INTO vendor_pos VALUES(1,1);
    INSERT INTO vendor_po_items VALUES(1,1,1);
  `);
  return db;
}

function challan(db, overrides = {}, items = [{ item_code: 'R001', qty: 3, unit: 'Nos', rate: 0 }]) {
  const values = { indent_id: 1, source: 'rgp', document_number: 'RGP/1', items_json: JSON.stringify(items), ...overrides };
  return Number(db.prepare(`INSERT INTO delivery_notes (${Object.keys(values).join(',')}) VALUES (${Object.keys(values).map(() => '?').join(',')})`).run(...Object.values(values)).lastInsertRowid);
}

test('backfill uses dispatched quantity, recorded cost and explicit raiser; quantities aggregate without engineer duplication', () => {
  const db = fixture();
  challan(db); // existed BEFORE deployment
  initializeRgpToolsSync(db);
  assert.equal(drainRgpToolsSync(db).imported, 1);
  const tool = db.prepare('SELECT * FROM tools').get();
  assert.equal(tool.quantity, 3);
  assert.equal(tool.purchase_price, 375);
  assert.equal(tool.current_user_id, 2); // not the administrator who entered it
  assert.equal(tool.current_site_id, 1);
  assert.equal(tool.status, 'in_use');
  assert.match(tool.notes, /Indent rate: 125/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_movements').get().n, 1);
  db.exec("INSERT INTO purchase_orders VALUES(1,1,2,'2'); UPDATE sites SET po_id=1,business_book_id=1");
  const summary = db.prepare(TOOLS_SITE_SUMMARY_SQL).get();
  assert.equal(summary.tool_count, 3);
  assert.equal(summary.tools_amount, 375);
  assert.equal(summary.site_engineer_name, 'Engineer');
  db.close();
});

test('successful mutation flushes queued imports, repeat saves/restart preserve returned tools', () => {
  const db = fixture();
  const bridge = rgpToolsBridge(db);
  const response = new EventEmitter();
  let next = false;
  bridge({ method: 'POST' }, response, () => { next = true; });
  const id = challan(db);
  response.emit('finish');
  assert.equal(next, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tools').get().n, 1);
  db.exec("UPDATE tools SET status='available', current_site_id=NULL,current_user_id=NULL");
  db.prepare("UPDATE delivery_notes SET status='received' WHERE id=?").run(id);
  drainRgpToolsSync(db);
  initializeRgpToolsSync(db);
  drainRgpToolsSync(db, { retry: true });
  assert.equal(db.prepare('SELECT status FROM tools').get().status, 'available');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tool_movements').get().n, 1);
  db.close();
});

test('vendor PO partial challan resolves exact indent line and excludes consumables', () => {
  const db = fixture(); initializeRgpToolsSync(db);
  challan(db, { indent_id: null, vendor_po_id: 1, source: null }, [
    { vendor_po_item_id: 1, quantity: 2, unit: 'Nos', rate: 100 },
    { item_code: 'C002', quantity: 15, unit: 'Mtr', rate: 10 },
  ]);
  assert.equal(drainRgpToolsSync(db).imported, 1);
  assert.equal(db.prepare('SELECT purchase_price FROM tools').get().purchase_price, 200);
  db.close();
});

test('drafts, sales bills and rejected challans do not create assets', () => {
  const db = fixture(); initializeRgpToolsSync(db);
  const id = challan(db, { is_draft: 1 });
  challan(db, { document_type: 'sales_bill' });
  challan(db, { status: 'rejected' });
  assert.equal(drainRgpToolsSync(db).imported, 0);
  db.prepare('UPDATE delivery_notes SET is_draft=0 WHERE id=?').run(id);
  assert.equal(drainRgpToolsSync(db).imported, 1);
  db.close();
});

test('uncertain history stays visible without invented employee, item, quantity or cost', () => {
  for (const sql of [
    "UPDATE indents SET raised_by_name=''",
    "INSERT INTO users VALUES(3,'Engineer')",
    "INSERT INTO sites VALUES(2,'Site A',NULL,NULL,NULL)",
    'UPDATE indent_items SET rate=0',
    "UPDATE delivery_notes SET items_json='[]'",
    "UPDATE delivery_notes SET items_json='invalid'",
    "UPDATE delivery_notes SET items_json='[{\"item_code\":\"UNKNOWN\",\"qty\":3}]'",
  ]) {
    const db = fixture(); initializeRgpToolsSync(db); challan(db); db.exec(sql);
    const result = drainRgpToolsSync(db);
    assert.equal(result.imported, 0, sql);
    assert.equal(result.review.length, 1, sql);
    db.close();
  }
});

test('distinct challans for the same item import automatically; repeat imports stay idempotent', () => {
  const db = fixture(); initializeRgpToolsSync(db);
  challan(db); drainRgpToolsSync(db);
  const id = challan(db, { document_number: 'RGP/2' });
  let result = drainRgpToolsSync(db);
  assert.equal(result.review.length, 0);
  assert.equal(result.imported, 2);
  drainRgpToolsSync(db, { deliveryNoteId: id });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tools').get().n, 2);
  db.close();
});

test('deployment automatically retries challans held by the old item-level duplicate check', () => {
  const db = fixture(); initializeRgpToolsSync(db);
  challan(db); drainRgpToolsSync(db);
  const id = challan(db, { document_number: 'RGP/2' });
  db.prepare("UPDATE rgp_tool_sync SET state='review', reason='Possible existing asset (T-1); confirm' WHERE delivery_note_id=?").run(id);
  initializeRgpToolsSync(db);
  const result = drainRgpToolsSync(db);
  assert.equal(result.review.length, 0);
  assert.equal(result.imported, 2);
  db.close();
});

test('changed quantity and deleted challan preserve asset history and flag review', () => {
  const db = fixture(); initializeRgpToolsSync(db);
  const id = challan(db); drainRgpToolsSync(db);
  db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=?').run('[{"item_code":"R001","qty":1,"unit":"Nos","rate":0}]', id);
  assert.match(drainRgpToolsSync(db).review[0].reason, /details changed/);
  assert.equal(db.prepare('SELECT quantity FROM tools').get().quantity, 3);
  db.prepare('DELETE FROM delivery_notes WHERE id=?').run(id);
  assert.match(drainRgpToolsSync(db).review[0].reason, /deleted/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tools').get().n, 1);
  db.close();
});

test('a failed movement insert rolls back tool creation and can safely retry', () => {
  const db = fixture(); initializeRgpToolsSync(db); challan(db);
  db.exec("CREATE TRIGGER fail_issue BEFORE INSERT ON tool_movements BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  assert.equal(drainRgpToolsSync(db).review.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM tools').get().n, 0);
  db.exec('DROP TRIGGER fail_issue');
  assert.equal(drainRgpToolsSync(db, { retry: true }).imported, 1);
  db.close();
});
