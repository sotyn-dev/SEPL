const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const f=require('../raBillingWorkflow');
function fixture(){
 const db=new Database(':memory:');db.pragma('foreign_keys=ON');db.exec(`
 CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,active INTEGER);INSERT INTO users VALUES(1,'Billing',1),(2,'PM',1),(3,'Head',1);
 CREATE TABLE business_book(id INTEGER PRIMARY KEY,project_name TEXT,client_name TEXT,company_name TEXT,payment_against_installation TEXT);INSERT INTO business_book VALUES(1,'Demo site','Demo client',NULL,'20%');
 CREATE TABLE sites(id INTEGER PRIMARY KEY,business_book_id INTEGER);INSERT INTO sites VALUES(1,1);
 CREATE TABLE dpr(id INTEGER PRIMARY KEY,site_id INTEGER,report_date TEXT,approval_status TEXT,sales_bill_id INTEGER);
 INSERT INTO dpr VALUES(1,1,'2026-09-16','approved',NULL),(2,1,'2026-09-28','approved',NULL),(3,1,'2026-09-01','pending',NULL),(4,1,'2026-09-01','rejected',NULL);
 CREATE TABLE sales_bills(id INTEGER PRIMARY KEY,bill_type INTEGER,business_book_id INTEGER,bill_number TEXT,bill_date TEXT,customer_name TEXT,project_name TEXT,total_amount REAL,amount REAL,gst_amount REAL,sent_to_client INTEGER,sent_at TEXT);
 INSERT INTO sales_bills VALUES(1,3,1,'DEMO-RA-1','2026-10-01','Demo client','Demo site',1180,1000,180,0,NULL);
 CREATE TABLE sales_bill_items(id INTEGER PRIMARY KEY,sales_bill_id INTEGER,description TEXT,qty_delivered REAL,unit TEXT,rate REAL,amount REAL);
 INSERT INTO sales_bill_items VALUES(1,1,'Pipe',10,'MTR',100,1000);
 CREATE TABLE payments(id INTEGER PRIMARY KEY,reference_type TEXT,reference_id INTEGER,amount REAL);
 CREATE TABLE receivables(id INTEGER PRIMARY KEY,client_name TEXT,project_name TEXT,business_book_id INTEGER,invoice_number TEXT,invoice_date TEXT,invoice_amount REAL,received_amount REAL,outstanding_amount REAL,due_date TEXT,ageing_days INTEGER,ageing_bucket TEXT,status TEXT,owner_id INTEGER,created_by INTEGER,updated_at TEXT);
 CREATE TABLE notifications(id INTEGER PRIMARY KEY,user_id INTEGER,type TEXT,title TEXT,body TEXT,link_url TEXT,channel_sent TEXT,dedupe_key TEXT);
 `);f.ensure(db);return db;
}
const value=()=>({totalSitcVal:2500});
const rules={mode:'rolling',amount_limit:null,payment_days:30,owner_id:1,pm_id:2,head_id:3,client_email:'demo@example.test'};
test('daily visibility, rejected exclusion, rolling 15-day boundary and early amount trigger',()=>{
 const db=fixture();let g=f.queue(db,value,'2026-09-30')[0];assert.equal(g.approved_value,1000);assert.equal(g.pending_value,500);assert.equal(g.dprs.length,3);assert.deepEqual(g.eligible_ids,[]);
 g=f.queue(db,value,'2026-10-01')[0];assert.deepEqual(g.eligible_ids,[1,2]);assert.equal(g.age_days,15);
 f.saveRule(db,1,{...rules,amount_limit:1000},1);g=f.queue(db,value,'2026-09-28')[0];assert.equal(g.trigger,'Amount limit reached');assert.deepEqual(g.eligible_ids,[1,2]);
 f.saveRule(db,1,{...rules,mode:'calendar'},1);assert.deepEqual(f.queue(db,value,'2026-09-30')[0].eligible_ids,[]);assert.deepEqual(f.queue(db,value,'2026-10-01')[0].eligible_ids,[1,2]);db.close();
});
test('complete pack, submission-based collections, reminders once per owner/stage, signature stops follow-ups',()=>{
 const db=fixture();db.exec('UPDATE dpr SET sales_bill_id=1 WHERE id IN (1,2)');f.saveRule(db,1,rules,1);
 assert.throws(()=>f.pack(db,1),/Complete the bill pack/);
 for(const kind of ['measurement','report','photo'])f.addDocument(db,1,{kind,path:`/uploads/${kind}.pdf`,name:kind},1);
 assert.throws(()=>f.submit(db,1,{submitted_on:'2026-10-02',reference:'Ack',submission_proof:'/uploads/ack.pdf'},1,'2026-10-01'),/Submission/);
 f.submit(db,1,{submitted_on:'2026-10-01',reference:'Client acknowledgement',submission_proof:'/uploads/ack.pdf'},1,'2026-10-01');
 let r=db.prepare('SELECT * FROM receivables').get();assert.equal(r.due_date,'2026-10-31');assert.equal(r.outstanding_amount,1180);
 f.submit(db,1,{submitted_on:'2026-10-01'},1);assert.equal(db.prepare('SELECT COUNT(*) n FROM receivables').get().n,1);
 assert.throws(()=>f.addDocument(db,1,{kind:'photo'},1),/locked/);
 assert.equal(f.followups(db,'2026-10-03').posted,0);assert.equal(f.followups(db,'2026-10-04').posted,1);assert.equal(f.followups(db,'2026-10-04').posted,0);assert.equal(f.followups(db,'2026-10-06').posted,1);
 assert.deepEqual(db.prepare('SELECT user_id FROM notifications ORDER BY id').all().map(x=>x.user_id),[1,2]);
 db.exec("INSERT INTO payments VALUES(1,'sales_bill',1,200)");f.syncCollection(db,1,'2026-11-02');r=db.prepare('SELECT * FROM receivables').get();assert.equal(r.outstanding_amount,980);assert.equal(r.ageing_days,2);
 f.sign(db,1,{signed_on:'2026-10-06',path:'/uploads/signed.pdf'},1,'2026-10-06');assert.equal(f.followups(db,'2026-10-08').posted,0);assert.equal(db.prepare('SELECT due_date FROM receivables').get().due_date,'2026-10-31');db.close();
});
test('configuration validation, day-7 catch-up and rejection before submission',()=>{
 const db=fixture();assert.throws(()=>f.saveRule(db,1,{...rules,amount_limit:-1},1),/positive/);assert.throws(()=>f.saveRule(db,1,{...rules,payment_days:1.5},1),/0–365/);
 db.exec('UPDATE dpr SET sales_bill_id=1 WHERE id=4');for(const kind of ['measurement','report','photo'])f.addDocument(db,1,{kind,path:'/uploads/test.pdf'},1);
 assert.throws(()=>f.pack(db,1),/approved/);db.exec("UPDATE dpr SET approval_status='approved' WHERE id=4");f.saveRule(db,1,rules,1);
 f.submit(db,1,{submitted_on:'2026-10-01',reference:'Ack',submission_proof:'/uploads/ack.pdf'},1,'2026-10-01');assert.equal(f.followups(db,'2026-10-08').posted,3);assert.equal(f.followups(db,'2026-10-09').posted,0);db.close();
});
