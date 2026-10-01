const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const Database=require('better-sqlite3');
test('follow-up keeps all unbilled POs without requiring receiving, with original values and pagination',()=>{
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE vendor_pos(id INTEGER PRIMARY KEY,po_number TEXT,po_date TEXT,total_amount REAL,expected_receipt_date TEXT,vendor_id INTEGER,payment_block_status TEXT,delay_reason TEXT,file_path TEXT,indent_id INTEGER,cancelled INTEGER DEFAULT 0);
 CREATE TABLE vendors(id INTEGER PRIMARY KEY,name TEXT); CREATE TABLE indents(id INTEGER PRIMARY KEY,indent_number TEXT,site_name TEXT);
 CREATE TABLE vendor_po_items(id INTEGER PRIMARY KEY,vendor_po_id INTEGER,amount REAL);
 CREATE TABLE purchase_bill_pos(purchase_bill_id INTEGER,vendor_po_id INTEGER);
 INSERT INTO vendors VALUES(1,'Follow-up Vendor'); INSERT INTO indents VALUES(1,'IND-1','Site');`);
 for(let id=1;id<=240;id++){
  db.prepare("INSERT INTO vendor_pos(id,po_number,po_date,total_amount,expected_receipt_date,vendor_id,indent_id) VALUES(?,?,'2026-09-01',1180,'2026-09-10',1,1)").run(id,'VPO-'+id);
  db.prepare('INSERT INTO vendor_po_items VALUES(?,?,1000)').run(id,id);
 }
 db.exec("INSERT INTO purchase_bill_pos VALUES(1,232),(1,233),(2,234),(3,235); UPDATE vendor_pos SET payment_block_status='pending' WHERE id BETWEEN 236 AND 238; UPDATE vendor_pos SET cancelled=1 WHERE id>=239");
 const source=fs.readFileSync(path.join(__dirname,'../../routes/procurement.js'),'utf8');
 const start=source.indexOf("router.get('/purchase-bills/followup',");
 const end=source.indexOf("router.get('/purchase-bills/eligible'",start);
 let handler;vm.runInNewContext(source.slice(start,end),{router:{get:(_,h)=>handler=h},getDb:()=>db});
 const call=query=>{let result;handler({query},{json:v=>result=v});return result;};
 const result=call({page:'1',limit:'15'});
 assert.equal(result.total,231);assert.equal(result.blocked_count,3);assert.equal(result.rows.length,15);assert.equal(result.totalPages,16);
 assert(result.rows.every(r=>r.display_total===1180 && r.total_amount===1180));
 assert.equal(call({export:'1'}).length,231);
 assert.equal(call({page:'16',limit:'15'}).rows.length,6);
 assert.equal(call({page:'1',limit:'15',q:'VPO-231'}).rows[0].id,231);
 assert.equal(call({page:'1',limit:'15',from:'2026-09-11'}).total,0);
 db.close();
});
