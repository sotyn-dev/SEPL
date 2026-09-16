const {test}=require('node:test');const assert=require('node:assert/strict');const Database=require('better-sqlite3');const express=require('express');const Module=require('module');
test('self-fill validates, saves and prefills addresses without overwriting omitted fields',async()=>{
 const db=new Database(':memory:');db.exec(`CREATE TABLE employees(id INTEGER PRIMARY KEY,name TEXT,phone TEXT,email TEXT,designation TEXT,department TEXT,join_date TEXT,aadhar_file TEXT,pan_file TEXT,qualification_file TEXT,permanent_address TEXT,permanent_pin TEXT,current_address TEXT,current_pin TEXT,same_as_permanent INTEGER DEFAULT 0,aadhaar_last4 TEXT,pan_number TEXT,bank_ifsc TEXT,bank_name TEXT,bank_branch TEXT,bank_account_no TEXT);CREATE TABLE employee_fill_links(id INTEGER PRIMARY KEY,token TEXT,employee_id INTEGER,used_at TEXT,expires_at TEXT,multi_use INTEGER,submitted_name TEXT,created_by INTEGER);INSERT INTO employee_fill_links VALUES(1,'address-test-token-123',NULL,NULL,NULL,1,NULL,1);`);
 const original=Module._load;Module._load=function(name,parent,...rest){if((parent?.filename.endsWith('publicHr.js') || parent?.filename.endsWith('ifscLookup.js'))){if(name==='../db/schema')return{getDb:()=>db};if(name==='../middleware/audit')return{logAuditEvent(){}};if(name==='../lib/push')return{notify(){}};}return original.call(this,name,parent,...rest);};let router;try{router=require('../../routes/publicHr');}finally{Module._load=original;}
 const app=express();app.use(express.json());app.use('/public',router);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 const call=async(method,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}/public/employee-fill/address-test-token-123`,{method,headers:{'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:r.status,data:await r.json()};};
 try{
 db.exec("CREATE TABLE ifsc_cache(ifsc TEXT PRIMARY KEY,bank TEXT,branch TEXT,city TEXT,state TEXT); INSERT INTO ifsc_cache VALUES('ICIC0007917','Test Bank','Test Branch',NULL,NULL)");
 const lookup=async(token,code)=>fetch(`http://127.0.0.1:${server.address().port}/public/employee-fill/${token}/ifsc/${code}`);
 const bank=await lookup('address-test-token-123','ICIC0007917');assert.equal(bank.status,200);assert.equal((await bank.json()).branch,'Test Branch');
 assert.equal((await lookup('address-test-token-123','INVALID')).status,400);
 assert.equal((await lookup('unknown-token-123456','ICIC0007917')).status,404);
 db.exec("UPDATE employee_fill_links SET expires_at='2000-01-01'");assert.equal((await lookup('address-test-token-123','ICIC0007917')).status,410);db.exec('UPDATE employee_fill_links SET expires_at=NULL');
 const body={name:'Address Test',phone:'9876543210',aadhar_file:'/uploads/a.pdf',pan_file:'/uploads/p.pdf',qualification_file:'/uploads/q.pdf',permanent_address:'Test locality, Delhi',permanent_pin:'110001',same_as_permanent:true};
 assert.equal((await call('POST',{...body,permanent_pin:'012345'})).status,400);assert.equal(db.prepare('SELECT COUNT(*) n FROM employees').get().n,0);
 assert.equal((await call('POST',{...body,pan_number:'bad'})).status,400);
 assert.equal((await call('POST',{...body,aadhaar_last4:'123456789012'})).status,400);
 assert.equal((await call('POST',{...body,bank_account_no:'abc'})).status,400);
 assert.equal((await call('POST',{...body,aadhaar_last4:'1234',pan_number:'abcde1234f',bank_ifsc:'sbin0001234',bank_name:'Test Bank',bank_branch:'Test Branch',bank_account_no:'000123456789'})).status,200);const row=db.prepare('SELECT * FROM employees').get();assert.equal(row.current_address,body.permanent_address);assert.equal(row.current_pin,'110001');assert.equal(row.pan_number,'ABCDE1234F');assert.equal(row.bank_account_no,'000123456789');assert.equal(row.bank_ifsc,'SBIN0001234');
 db.prepare('UPDATE employee_fill_links SET employee_id=?').run(row.id);
 const publicData=(await call('GET')).data.employee;assert.equal(publicData.permanent_pin,'110001');assert.equal(publicData.has_pan_number,true);assert.equal(publicData.pan_number,undefined);assert.equal(publicData.bank_account_no,undefined);
 assert.equal((await call('POST',{permanent_address:'Updated locality'})).status,200);let saved=db.prepare('SELECT * FROM employees').get();assert.equal(saved.current_address,'Updated locality');assert.equal(saved.permanent_pin,'110001');assert.equal(saved.bank_account_no,'000123456789');
 assert.equal((await call('POST',{same_as_permanent:false,current_address:'Different locality',current_pin:'400001'})).status,200);saved=db.prepare('SELECT * FROM employees').get();assert.equal(saved.current_pin,'400001');assert.equal(saved.permanent_pin,'110001');assert.equal(saved.same_as_permanent,0);
 }finally{await new Promise(r=>server.close(r));db.close();}
});
