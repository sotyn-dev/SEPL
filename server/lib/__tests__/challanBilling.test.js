const {test} = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {ensureChallanBilling, syncChallanBilling} = require('../challanBilling');
function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE delivery_notes(id INTEGER PRIMARY KEY,document_type TEXT,document_number TEXT,vendor_po_id INTEGER,status TEXT,sales_bill_number TEXT,sales_bill_pending INTEGER DEFAULT 0,received_by_name TEXT,received_at TEXT,receipt_file_path TEXT);
  CREATE TABLE vendor_po_items(vendor_po_id INTEGER,indent_item_id INTEGER);
  CREATE TABLE indent_items(id INTEGER,item_type TEXT);
  INSERT INTO indent_items VALUES(1,'PO'),(2,'RGP'),(3,'FOC');
  INSERT INTO vendor_po_items VALUES(10,1),(10,2),(20,2),(20,3);
  INSERT INTO delivery_notes VALUES(1,'challan','DC1',10,'received',NULL,1,'Receiver','2026-09-21','/uploads/proof.jpg');`);
  ensureChallanBilling(db);
  return db;
}
test('receiving mixed PO/RGP challan keeps only billing pending without creating an invoice',()=>{
 const db=fixture(); try {
  syncChallanBilling(db,1);syncChallanBilling(db,1);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n,1);
  const dn=db.prepare('SELECT * FROM delivery_notes').get();
  assert.equal(dn.status,'received');assert.equal(dn.sales_bill_pending,1);
  assert.equal(dn.receipt_file_path,'/uploads/proof.jpg');
 }finally{db.close();}
});
test('later invoice shares receipt and does not need a second receiving',()=>{
 const db=fixture();try{
  db.exec("INSERT INTO delivery_notes(id,document_type,document_number,status) VALUES(2,'sales_bill','SB1','pending'); UPDATE delivery_notes SET sales_bill_number='SB1' WHERE id=1");
  syncChallanBilling(db,1);
  const bill=db.prepare('SELECT * FROM delivery_notes WHERE id=2').get();
  assert.equal(bill.source_challan_id,1);assert.equal(bill.status,'received');
  assert.equal(bill.receipt_file_path,'/uploads/proof.jpg');
  assert.equal(db.prepare('SELECT sales_bill_pending n FROM delivery_notes WHERE id=1').get().n,0);
  ensureChallanBilling(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n,2);
 }finally{db.close();}
});
test('FOC/RGP-only challan and existing sales bills never request another sales bill',()=>{
 const db=fixture();try{
  db.exec("UPDATE delivery_notes SET vendor_po_id=20 WHERE id=1; INSERT INTO delivery_notes(id,document_type,sales_bill_pending) VALUES(2,'sales_bill',1)");
  ensureChallanBilling(db);
  assert.deepEqual(db.prepare('SELECT sales_bill_pending p FROM delivery_notes ORDER BY id').all().map(r=>r.p),[0,0]);
 }finally{db.close();}
});
test('unreceived challan does not fabricate proof and existing invoice proof is preserved',()=>{
 const db=fixture();try{
  db.exec("INSERT INTO delivery_notes(id,document_type,document_number,status,receipt_file_path) VALUES(2,'sales_bill','SB1','pending','/uploads/invoice-proof.jpg'); UPDATE delivery_notes SET sales_bill_number='SB1',status='pending' WHERE id=1");
  syncChallanBilling(db,1);
  assert.equal(db.prepare('SELECT status FROM delivery_notes WHERE id=2').get().status,'pending');
  db.exec("UPDATE delivery_notes SET status='received' WHERE id=1");syncChallanBilling(db,1);
  assert.equal(db.prepare('SELECT receipt_file_path FROM delivery_notes WHERE id=2').get().receipt_file_path,'/uploads/invoice-proof.jpg');
 }finally{db.close();}
});
