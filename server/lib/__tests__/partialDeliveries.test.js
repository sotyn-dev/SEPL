const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensurePartialDeliveries, balanceItems, recordBalance, validateBatch } = require('../partialDeliveries');
function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE purchase_bills(id INTEGER PRIMARY KEY, vendor_po_id INTEGER, bill_number TEXT);
    CREATE TABLE delivery_notes(id INTEGER PRIMARY KEY, vendor_po_id INTEGER, document_type TEXT, document_number TEXT, delivery_date TEXT, status TEXT, items_json TEXT, notes TEXT);
    CREATE TABLE vendor_po_items(id INTEGER PRIMARY KEY, vendor_po_id INTEGER, indent_item_id INTEGER, quantity REAL, rate REAL);
    CREATE TABLE indent_items(id INTEGER PRIMARY KEY, description TEXT, unit TEXT, item_master_id INTEGER);
    CREATE TABLE item_master(id INTEGER PRIMARY KEY, item_name TEXT, uom TEXT);
    INSERT INTO purchase_bills VALUES(1,10,'B1');`);
  ensurePartialDeliveries(db); ensurePartialDeliveries(db);
  db.prepare("UPDATE purchase_bills SET delivery_mode='partial'").run();
  for(let i=1;i<=4;i++) {
    db.prepare("INSERT INTO indent_items VALUES(?,?,'Nos',NULL)").run(i,'Item '+i);
    db.prepare('INSERT INTO vendor_po_items VALUES(?,10,?,10,100)').run(i,i);
  }
  const first = [1,2,3,4].map(id=>({vendor_po_item_id:id,received_qty:id===4?0:10}));
  db.prepare("INSERT INTO delivery_notes(vendor_po_id,document_type,document_number,delivery_date,items_json) VALUES(10,'challan','DC1','2026-09-28',?)").run(JSON.stringify(first));
  // A sales bill copied from a challan must not double the received quantity.
  db.prepare("INSERT INTO delivery_notes(vendor_po_id,document_type,items_json) VALUES(10,'sales_bill',?)").run(JSON.stringify(first));
  return db;
}
test('three items now, fourth later: preserve history and close only the outstanding balance',()=>{
  const db=fixture();
  const original=db.prepare('SELECT items_json FROM delivery_notes WHERE id=1').get().items_json;
  assert.deepEqual(balanceItems(db,10).map(i=>i.remaining_qty),[0,0,0,10]);
  const body={request_id:'delivery-fourth-item-001',items:[{vendor_po_item_id:4,received_qty:10}]};
  const result=recordBalance(db,1,body,'2026-09-30',1);
  assert.deepEqual(balanceItems(db,10).map(i=>i.remaining_qty),[0,0,0,0]);
  assert.equal(db.prepare('SELECT items_json FROM delivery_notes WHERE id=1').get().items_json,original);
  assert.equal(recordBalance(db,1,body,'2026-09-30',1).id,result.id);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_notes WHERE document_type='challan'").get().n,2);
  db.close();
});
test('several later deliveries accumulate and over-receipt rolls back',()=>{
  const db=fixture();
  recordBalance(db,1,{request_id:'delivery-fourth-part-001',items:[{vendor_po_item_id:4,received_qty:4}]},'2026-09-29',1);
  assert.equal(balanceItems(db,10)[3].remaining_qty,6);
  assert.throws(()=>recordBalance(db,1,{request_id:'delivery-fourth-part-002',items:[{vendor_po_item_id:4,received_qty:7}]},'2026-09-30',1),/between 0 and 6/);
  assert.equal(balanceItems(db,10)[3].remaining_qty,6);
  recordBalance(db,1,{request_id:'delivery-fourth-part-003',items:[{vendor_po_item_id:4,received_qty:6}]},'2026-09-30',1);
  assert.equal(balanceItems(db,10)[3].remaining_qty,0);db.close();
});
test('reject duplicate, unrelated, negative, nonfinite and empty deliveries',()=>{
  const db=fixture(),items=balanceItems(db,10);
  for(const rows of [[],[{vendor_po_item_id:99,received_qty:1}],[{vendor_po_item_id:4,received_qty:-1}],[{vendor_po_item_id:4,received_qty:'no'}],[{vendor_po_item_id:4,received_qty:1},{vendor_po_item_id:4,received_qty:1}]]) assert.throws(()=>validateBatch(items,rows));
  db.close();
});
