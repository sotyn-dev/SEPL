const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {report,validateAdjustment}=require('../projectProfit');
function fixture(){
 const db=new Database(':memory:');
 db.exec(`CREATE TABLE business_book(id INTEGER PRIMARY KEY,lead_no TEXT,project_name TEXT,company_name TEXT,client_name TEXT,status TEXT,sale_amount_without_gst REAL,management_discount_amount REAL);
 CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT);
 CREATE TABLE purchase_orders(id INTEGER PRIMARY KEY,business_book_id INTEGER);
 CREATE TABLE sites(id INTEGER PRIMARY KEY,business_book_id INTEGER,po_id INTEGER,name TEXT);
 CREATE TABLE sales_bills(id INTEGER PRIMARY KEY,business_book_id INTEGER,po_id INTEGER,bill_number TEXT,approval_status TEXT,bill_type INTEGER,amount REAL,bill_date TEXT);
 CREATE TABLE purchase_bills(id INTEGER PRIMARY KEY,vendor_po_id INTEGER,bill_number TEXT,amount REAL,bill_date TEXT);
 CREATE TABLE vendor_pos(id INTEGER PRIMARY KEY,indent_id INTEGER);
 CREATE TABLE indents(id INTEGER PRIMARY KEY,planning_id INTEGER);
 CREATE TABLE order_planning(id INTEGER PRIMARY KEY,business_book_id INTEGER,po_id INTEGER);
 CREATE TABLE proj_contractor_ra_bills(id INTEGER PRIMARY KEY,project_id INTEGER,ra_no TEXT,status TEXT,gross_amount REAL,raised_at TEXT);
 CREATE TABLE proj_client_ra_bills(id INTEGER PRIMARY KEY,project_id INTEGER,ra_no TEXT,status TEXT,gross_amount REAL,raised_at TEXT);
 CREATE TABLE payment_requests(id INTEGER PRIMARY KEY,site_id INTEGER,request_no TEXT,status TEXT,category TEXT,amount REAL,created_at TEXT);
 CREATE TABLE dpr(id INTEGER PRIMARY KEY,site_id INTEGER,approval_status TEXT,submission_time TEXT,is_planned_template INTEGER,grand_total_a REAL,grand_total_b REAL,report_date TEXT);
 CREATE TABLE project_profit_adjustments(id INTEGER PRIMARY KEY,project_id INTEGER,basis TEXT,kind TEXT,category TEXT,entry_date TEXT,amount REAL,reason TEXT,created_by INTEGER,voided_by INTEGER,voided_at TEXT,void_reason TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
 INSERT INTO business_book VALUES(1,'BB1','Same project','Client','A','execution',1000,100),(2,'BB2','Same project','Client','A','execution',2000,0);
 INSERT INTO purchase_orders VALUES(1,1);INSERT INTO sites VALUES(1,1,1,'Site one'),(2,1,1,'Site two');
 INSERT INTO sales_bills VALUES(1,1,1,'DEL1','approved',2,500,'2026-09-01'),(2,1,1,'INST1','approved',3,100,'2026-09-02'),(3,1,1,'FINAL','approved',4,900,'2026-09-02'),(4,1,1,'ORDER','approved',1,900,'2026-09-02'),(5,1,1,'DRAFT','draft',2,700,'2026-09-02'),(6,NULL,NULL,'UNLINKED','approved',2,50,NULL);
 INSERT INTO order_planning VALUES(1,1,1);INSERT INTO indents VALUES(1,1);INSERT INTO vendor_pos VALUES(1,1);INSERT INTO purchase_bills VALUES(1,1,'PB1',200,'2026-09-01');
 INSERT INTO proj_contractor_ra_bills VALUES(1,1,'CRA1','raised',100,'2026-09-01'),(2,1,'CRA2','cancelled',500,'2026-09-01');
 INSERT INTO proj_client_ra_bills VALUES(1,1,'RA1','raised',800,'2026-09-01');
 INSERT INTO payment_requests VALUES(1,1,'TR1','final_approved','Transport',20,'2026-09-01'),(2,1,'P1','final_approved','Purchase',200,'2026-09-01'),(3,1,'TR2','pending','Transport',99,'2026-09-01');
 INSERT INTO dpr VALUES(1,1,'approved','2026-09-01',0,700,400,'2026-09-01'),(2,2,'pending','2026-09-01',0,900,900,'2026-09-01'),(3,2,'approved',NULL,1,900,900,'2026-09-01');
 INSERT INTO project_profit_adjustments(id,project_id,basis,kind,category,entry_date,amount,reason,created_by,voided_by,voided_at) VALUES(1,1,'sales','cost','Overhead','2026-09-01',30,'Office overhead',NULL,NULL,NULL),(2,1,'sales','cost','Other','2026-09-01',999,'Voided test',NULL,NULL,'2026-09-02'),(3,1,'dpr','cost','Other','2026-09-01',-20,'Cost reversal',NULL,NULL,NULL);`);
 return db;
}
test('billed view excludes duplicate order/final totals and drafts, aggregates each source once',()=>{const db=fixture();try{const r=report(db);const p=r.rows.find(p=>p.id===1);assert.equal(p.contract_value,900);assert.equal(p.auto_revenue,600);assert.equal(p.auto_cost,320);assert.equal(p.cost,350);assert.equal(p.profit,250);assert.equal(p.margin,41.67);assert.equal(r.rows.find(p=>p.id===2).has_activity,false);assert.equal(r.warnings.unlinked_count,1);assert.equal(r.warnings.undated_count,1);}finally{db.close();}});
test('RA and DPR bases stay separate; approved actual DPR only; manual reversals and dates',()=>{const db=fixture();try{const ra=report(db,{basis:'client_ra'}).rows.find(p=>p.id===1);assert.equal(ra.revenue,800);assert.equal(ra.cost,320);const dpr=report(db,{basis:'dpr'}).rows.find(p=>p.id===1);assert.equal(dpr.revenue,700);assert.equal(dpr.cost,380);assert.equal(dpr.profit,320);const dated=report(db,{basis:'sales',from:'2026-09-02',to:'2026-09-02'}).rows.find(p=>p.id===1);assert.equal(dated.revenue,100);assert.equal(dated.cost,0);}finally{db.close();}});
test('manual adjustments reject invalid data and allow signed cent precision',()=>{const b={project_id:1,basis:'sales',kind:'cost',category:'Overhead',entry_date:'2026-09-01',amount:10.25,reason:'Office overhead'};assert.equal(validateAdjustment(b),null);assert.equal(validateAdjustment({...b,amount:-10.25}),null);for(const patch of [{amount:0},{amount:NaN},{amount:1.001},{entry_date:'2026-02-31'},{basis:'unknown'},{kind:'salary'},{reason:'x'},{project_id:'1'}])assert.ok(validateAdjustment({...b,...patch}));});

test('API enforces view/create/delete permissions and retains void history',async()=>{
 const db=fixture(),Module=require('module'),express=require('express');const original=Module._load;
 Module._load=function(name,parent,...args){
  if(parent?.filename.endsWith('projectProfit.js')){
   if(name==='../db/schema')return {getDb:()=>db};
   if(name==='../middleware/auth')return {
    authMiddleware:(req,res,next)=>{if(!req.headers['x-user'])return res.sendStatus(401);req.user={id:1};next();},
    requirePermission:(module,action)=>(req,res,next)=>{assert.equal(module,'project_profit');if(!(req.headers['x-allow']||'').split(',').includes(action))return res.sendStatus(403);next();}
   };
  }return original.call(this,name,parent,...args);
 };
 let router;try{router=require('../../routes/projectProfit');}finally{Module._load=original;}
 const app=express();app.use(express.json());app.use('/',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=(path='',method='GET',body,allow='view',user='yes')=>fetch(`http://127.0.0.1:${server.address().port}/${path}`,{method,headers:{'Content-Type':'application/json','x-user':user,'x-allow':allow},...(body?{body:JSON.stringify(body)}:{})});
 try{
  assert.equal((await call('','GET',null,'view','')).status,401);assert.equal((await call('','GET',null,'')).status,403);
  assert.equal((await call('?from=2026-02-31')).status,400);
  const b={project_id:1,basis:'sales',kind:'cost',category:'Overhead',entry_date:'2026-09-01',amount:10,reason:'Test adjustment'};
  assert.equal((await call('adjustments','POST',b)).status,403);
  assert.equal((await call('adjustments','POST',{...b,project_id:999},'view,create')).status,404);
  const created=await call('adjustments','POST',b,'view,create');assert.equal(created.status,201);const {id}=await created.json();
  assert.equal(report(db).rows.find(p=>p.id===1).profit,240);
  assert.equal((await call(`adjustments/${id}/void`,'POST',{reason:'Duplicate entry'})).status,403);
  assert.equal((await call(`adjustments/${id}/void`,'POST',{reason:'Duplicate entry'},'view,delete')).status,200);
  assert.equal(report(db).rows.find(p=>p.id===1).profit,250);assert.equal(db.prepare('SELECT void_reason FROM project_profit_adjustments WHERE id=?').get(id).void_reason,'Duplicate entry');
  assert.equal((await call(`adjustments/${id}/void`,'POST',{reason:'Duplicate entry'},'view,delete')).status,409);
 }finally{await new Promise(r=>server.close(r));db.close();}
});

