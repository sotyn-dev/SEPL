const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const Module = require('module');
const express = require('express');
const { provisionEmployeeLogin, usernameBase } = require('../employeeLogin');
function database() {
 const db = new Database(':memory:');
 db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE NOT NULL,username TEXT,password TEXT,role TEXT,department TEXT,phone TEXT,active INTEGER,archived INTEGER DEFAULT 0,must_change_password INTEGER DEFAULT 0,token_revoked_at INTEGER,recovery_code_hash TEXT,approval_role TEXT,avatar_url TEXT);
 CREATE TABLE roles(id INTEGER PRIMARY KEY,name TEXT);CREATE TABLE user_roles(user_id INTEGER,role_id INTEGER);
 CREATE TABLE role_permissions(role_id INTEGER,module TEXT,can_view INTEGER,can_create INTEGER,can_edit INTEGER,can_delete INTEGER,can_approve INTEGER,can_see_all INTEGER);
 CREATE TABLE user_totp(user_id INTEGER,required INTEGER,enabled INTEGER,secret TEXT);`);
 return db;
}
test('employee logins use dotted names, unique suffixes, hashed initial passwords and preserve existing accounts',()=>{
 const db=database();
 try {
  assert.equal(usernameBase('  Monika   Devi  '),'monika.devi');
  const create=options=>db.transaction(()=>provisionEmployeeLogin(db,options))();
  const first=create({name:'Monika Devi',email:'monika@example.test'});
  assert.equal(first.username,'monika.devi');assert.equal(first.created,true);
  const stored=db.prepare('SELECT * FROM users WHERE id=?').get(first.userId);
  assert.equal(stored.role,'user');assert.equal(stored.must_change_password,1);assert.notEqual(stored.password,'123456');assert.ok(bcrypt.compareSync('123456',stored.password));
  assert.equal(create({name:'Monika Devi'}).username,'monika.devi.2');
  const existing=create({name:'Different Name',email:'MONIKA@example.test'});
  assert.equal(existing.userId,first.userId);assert.equal(existing.created,false);assert.equal(existing.initial_password,undefined);assert.equal(db.prepare('SELECT password FROM users WHERE id=?').get(first.userId).password,stored.password);
  const before=db.prepare('SELECT COUNT(*) n FROM users').get().n;
  assert.throws(()=>db.transaction(()=>{provisionEmployeeLogin(db,{name:'Rollback Account'});throw new Error('Employee insert failed');})());
  assert.equal(db.prepare('SELECT COUNT(*) n FROM users').get().n,before);
 } finally {db.close();}
});
test('initial-password users can sign in but cannot access ERP APIs until password change',async()=>{
 const db=database();
 const account=db.transaction(()=>provisionEmployeeLogin(db,{name:'Login Test'}))();
 const original=Module._load;
 Module._load=function(name,parent,...rest){
  if (parent && /(?:middleware|routes)[\\/]auth\.js$/.test(parent.filename) && name==='../db/schema')return {getDb:()=>db};
  if (name==='../middleware/audit')return {logAuditEvent(){}};
  if (name==='../lib/destructiveBreaker')return {guardCheck:()=>null};
  return original.call(this,name,parent,...rest);
 };
 let auth,router;
 try{auth=require('../../middleware/auth');router=require('../../routes/auth');}finally{Module._load=original;}
 const app=express();app.use(express.json());app.use('/api/auth',router);app.get('/api/private',auth.authMiddleware,(req,res)=>res.json({ok:true}));
 const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
 let token;
 const call=async(method,path,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${path}`,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json(),token:r.headers.get('x-refresh-token')};};
 try {
  // Use real password verification and middleware; audit is the only side-effect stub.
  const login=await call('POST','/api/auth/login',{username:account.username,password:'123456'});
  assert.equal(login.status,200);assert.equal(login.data.user.must_change_password,true);token=login.data.token;
  assert.equal((await call('GET','/api/auth/me')).data.must_change_password,1);
  assert.equal((await call('GET','/api/private')).status,403);
  assert.equal((await call('POST','/api/auth/change-password',{current_password:'123456',new_password:'123456'})).status,400);
  const changed=await call('POST','/api/auth/change-password',{current_password:'123456',new_password:'Changed-Only-In-Test!'});
  assert.equal(changed.status,200);token=changed.token || token;
  assert.equal(db.prepare('SELECT must_change_password FROM users WHERE id=?').get(account.userId).must_change_password,0);
  assert.equal((await call('GET','/api/private')).status,200);
 }finally{await new Promise(resolve=>server.close(resolve));db.close();}
});
