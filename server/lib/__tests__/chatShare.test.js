const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const express=require('express');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const crypto=require('node:crypto');
const vm=require('node:vm');
const {ensureSchema,sendShare,canReadFile,guardAttachment,fileUrl}=require('../chatShare');
const createRouter=require('../../routes/chatShare');
function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE chat_groups(id INTEGER PRIMARY KEY,name TEXT,is_dm INTEGER,archived_at TEXT);
    CREATE TABLE chat_group_members(group_id INTEGER,user_id INTEGER);
    CREATE TABLE chat_messages(id INTEGER PRIMARY KEY,group_id INTEGER,body TEXT,attachment_url TEXT,attachment_name TEXT,
      sender_id INTEGER,sender_name TEXT,deleted_at TEXT,created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE chat_reads(group_id INTEGER,user_id INTEGER,last_read_id INTEGER,PRIMARY KEY(group_id,user_id));
    INSERT INTO chat_groups VALUES(1,'Group',0,NULL),(2,'Personal',1,NULL),(3,'Other DM',1,NULL),(4,'Archive',0,'yesterday');
    INSERT INTO chat_group_members VALUES(1,10),(1,20),(2,10),(2,20),(3,20),(3,30),(4,10);`);
  ensureSchema(db);
  const canAccess=(db,req,id)=>!!db.prepare('SELECT 1 FROM chat_group_members WHERE group_id=? AND user_id=?').get(id,req.user.id) ||
    (req.user.role==='admin' && db.prepare('SELECT is_dm FROM chat_groups WHERE id=?').get(id)?.is_dm===0);
  const events=[];
  const markRead=(db,g,u,id)=>db.prepare('INSERT OR REPLACE INTO chat_reads VALUES (?,?,?)').run(g,u,id);
  const emitChat=(...event)=>events.push(event);
  const req={user:{id:10,name:'Sender',role:'employee'},body:{expected_sender_id:10,request_id:crypto.randomUUID(),group_ids:[1,2],text:'Selected WhatsApp text',attachment_ids:[]}};
  return {db,canAccess,markRead,emitChat,events,req};
}
function addFile(db,owner=10) {
  const row={id:crypto.randomUUID(),owner_id:owner,upload_key:crypto.randomUUID(),storage_key:'private.pdf',name:'document.pdf',mime:'application/pdf',size:20,sha256:'hash',created_at:Date.now()};
  db.prepare('INSERT INTO chat_share_uploads VALUES (@id,@owner_id,@upload_key,@storage_key,@name,@mime,@size,@sha256,@created_at)').run(row);
  return row;
}
test('multi-chat send uses existing messages/reads and emits once; timeout retry returns same receipt',()=>{
  const f=fixture();
  const file=addFile(f.db);f.req.body.attachment_ids=[file.id];f.req.body.group_ids=[1,2,1];
  const a=sendShare(f);const b=sendShare(f);
  assert.equal(a.replayed,false);assert.equal(b.replayed,true);assert.deepEqual(a.message_ids,b.message_ids);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,2);
  assert.equal(f.events.filter(e=>e[1]==='message').length,2);assert.equal(f.events.filter(e=>e[1]==='changed').length,2);
  assert.equal(f.db.prepare('SELECT attachment_url FROM chat_messages LIMIT 1').get().attachment_url,fileUrl(file));
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_reads').get().n,2);
  f.req.body.text='Changed after send';assert.throws(()=>sendShare(f),e=>e.status===409);f.db.close();
});
test('permission/archive/foreign-file failures send nothing, including the first valid destination',()=>{
  for(const kind of ['private','archived','file','account']) {
    const f=fixture();
    if(kind==='private'){f.req.user.role='admin';f.req.body.group_ids=[1,3];}
    if(kind==='archived')f.req.body.group_ids=[1,4];
    if(kind==='file')f.req.body.attachment_ids=[addFile(f.db,30).id];
    if(kind==='account')f.req.body.expected_sender_id=30;
    assert.throws(()=>sendShare(f),e=>[403,409].includes(e.status));
    assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,0);assert.equal(f.events.length,0);f.db.close();
  }
});
test('server rechecks membership and handles multiple files as existing attachment messages',()=>{
  const f=fixture();const first=addFile(f.db),second=addFile(f.db);f.req.body.attachment_ids=[first.id,second.id];
  f.db.exec('DELETE FROM chat_group_members WHERE group_id=2 AND user_id=10');
  assert.throws(()=>sendShare(f),e=>e.status===403);
  f.req.body.group_ids=[1];sendShare(f);
  const rows=f.db.prepare('SELECT * FROM chat_messages ORDER BY id').all();assert.equal(rows.length,2);
  assert.equal(rows[0].body,'Selected WhatsApp text');assert.equal(rows[1].body,null);f.db.close();
});
test('private attachments require ownership or current chat access, including forwarding',()=>{
  const f=fixture();const file=addFile(f.db);f.req.body.attachment_ids=[file.id];sendShare(f);
  const member={user:{id:20,role:'employee'}},stranger={user:{id:30,role:'employee'}};
  assert.equal(canReadFile(f.db,member,file,f.canAccess),true);
  assert.equal(canReadFile(f.db,stranger,file,f.canAccess),false);
  assert.throws(()=>guardAttachment(f.db,stranger,fileUrl(file),f.canAccess),e=>e.status===403);
  assert.throws(()=>guardAttachment(f.db,stranger,'https://securederp.in'+fileUrl(file),f.canAccess),e=>e.status===403);
  guardAttachment(f.db,member,fileUrl(file),f.canAccess);guardAttachment(f.db,stranger,'/uploads/legacy.pdf',f.canAccess);
  f.db.exec('DELETE FROM chat_group_members WHERE user_id=20');
  assert.equal(canReadFile(f.db,member,file,f.canAccess),false);f.db.close();
});
test('invalid/oversized inputs and a database failure cannot partially send',()=>{
  const f=fixture();
  for(const patch of [{request_id:'bad'},{group_ids:[]},{group_ids:['1']},{text:'x'.repeat(16001)},{text:'',attachment_ids:[]}]) {
    const old=f.req.body;f.req.body={...old,...patch};assert.throws(()=>sendShare(f),e=>e.status===400);f.req.body=old;
  }
  f.db.exec("CREATE TRIGGER fail_second BEFORE INSERT ON chat_messages WHEN new.group_id=2 BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  assert.throws(()=>sendShare(f),/test failure/);assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_messages').get().n,0);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM chat_share_receipts').get().n,0);assert.equal(f.events.length,0);f.db.close();
});
test('HTTP upload/download flow: auth, signatures, upload retry, permission removal and cleanup',async t=>{
  const f=fixture(),dir=fs.mkdtempSync(path.join(os.tmpdir(),'sotyn-share-test-'));
  const fakeStorage={NS:{CHAT_PRIVATE:'chat-private'},adoptLocalFile:async()=>{},openStream:async key=>{
    const p=path.join(dir,key);return fs.existsSync(p)?{stream:fs.createReadStream(p),size:fs.statSync(p).size}:null;
  },removeKey:async key=>{await fs.promises.unlink(path.join(dir,key)).catch(()=>{});}};
  const app=express();app.use(express.json());
  app.use('/api/site-chat/share',(req,res,next)=>{
    const id=Number(req.get('x-test-user'));if(!id)return res.status(401).json({error:'Sign in'});
    req.user={id,name:'Test',role:'employee'};next();
  },createRouter({...f,getChatDb:()=>f.db,uploadDir:dir,fileStorage:fakeStorage}));
  const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});
  t.after(()=>{server.closeAllConnections();server.close();f.db.close();fs.rmSync(dir,{recursive:true,force:true});});
  const base=`http://127.0.0.1:${server.address().port}`;
  const upload=async(key,text='%PDF-1.7\nselected document',name='proof.pdf',user='10')=>{
    const body=new FormData();body.append('file',new Blob([text]),name);
    return fetch(`${base}/api/site-chat/share/uploads/${key}`,{method:'POST',headers:{'x-test-user':user},body});
  };
  assert.equal((await upload(crypto.randomUUID(),'not PDF')).status,400);
  assert.equal((await upload(crypto.randomUUID(),'console.log(1)','bad.js')).status,400);
  assert.equal((await upload(crypto.randomUUID(),'%PDF-'+ 'x'.repeat(20*1024*1024))).status,400);
  assert.equal((await upload(crypto.randomUUID(),undefined,undefined,'')).status,401);
  const key=crypto.randomUUID();const a=await upload(key);assert.equal(a.status,200,await a.clone().text());const file=await a.json();
  const b=await upload(key);assert.equal((await b.json()).id,file.id);
  assert.equal((await upload(key,'%PDF-1.7\ndifferent')).status,409);assert.equal(fs.readdirSync(dir).length,1);
  const row=f.db.prepare('SELECT * FROM chat_share_uploads WHERE id=?').get(file.id);
  assert.equal((await fetch(base+fileUrl(row))).status,401);
  assert.equal((await fetch(base+fileUrl(row),{headers:{'x-test-user':'20'}})).status,404);
  assert.equal((await fetch(base+'/uploads/'+row.storage_key)).status,404);
  const own=await fetch(base+fileUrl(row),{headers:{'x-test-user':'10'}});assert.equal(own.status,200);assert.match(own.headers.get('cache-control'),/no-store/);assert.match(await own.text(),/%PDF/);
  f.req.body.attachment_ids=[row.id];sendShare(f);
  assert.equal((await fetch(base+fileUrl(row),{headers:{'x-test-user':'20'}})).status,200);
  f.db.exec('DELETE FROM chat_group_members WHERE user_id=20');
  assert.equal((await fetch(base+fileUrl(row),{headers:{'x-test-user':'20'}})).status,404);
  const c=await (await upload(crypto.randomUUID())).json();
  await fetch(`${base}/api/site-chat/share/uploads/${c.id}`,{method:'DELETE',headers:{'x-test-user':'10'}});
  assert.equal(f.db.prepare('SELECT 1 FROM chat_share_uploads WHERE id=?').get(c.id),undefined);
  const expired=await (await upload(crypto.randomUUID())).json();
  f.db.prepare('UPDATE chat_share_uploads SET created_at=? WHERE id=?').run(Date.now()-86400001,expired.id);
  await upload(crypto.randomUUID());
  assert.equal(f.db.prepare('SELECT 1 FROM chat_share_uploads WHERE id=?').get(expired.id),undefined);
});
test('service worker receives only explicit share POST and preserves unrelated requests',async()=>{
  const events={},saved=[];const source=fs.readFileSync(path.join(__dirname,'../../../client/public/chat-share-worker.js'),'utf8');
  const self={location:{origin:'https://erp.test'},SotynChatShares:{UUID:/^[a-f0-9-]{36}$/,create:async content=>{saved.push(content);return{id:'d'};}},addEventListener:(k,fn)=>events[k]=fn};
  vm.runInNewContext(source,{self,importScripts:()=>{},Response,URL,fetch:async()=>{throw Error('offline');}});
  let response;
  const body=new FormData();body.set('text','Only selected text');body.append('files',new Blob(['%PDF-1.7']), 'selected.pdf');
  events.fetch({request:new Request('https://erp.test/site-chat/share-target',{method:'POST',body}),respondWith:p=>response=p});
  const result=await response;assert.equal(result.status,303);assert.equal(saved.length,1);assert.equal(saved[0].files[0].name,'selected.pdf');
  assert.equal(saved[0].text,'Only selected text');
  response=null;events.fetch({request:new Request('https://erp.test/api/dashboard'),respondWith:p=>response=p});assert.equal(response,null);
  events.fetch({request:{url:'https://erp.test/site-chat/share?draft=12345678-1234-4234-8234-123456789012',mode:'navigate',method:'GET'},respondWith:p=>response=p});
  assert.match(await (await response).text(),/offline/);
});
