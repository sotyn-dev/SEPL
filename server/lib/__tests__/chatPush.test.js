const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chatDelivery,isChatPush}=require('../chatPush');
function fixture() {
  const db=new Database(':memory:');
  db.exec(`CREATE TABLE chat_groups(id INTEGER PRIMARY KEY,name TEXT,is_dm INTEGER,archived_at TEXT);
    CREATE TABLE chat_messages(id INTEGER PRIMARY KEY,group_id INTEGER,sender_id INTEGER,sender_name TEXT,body TEXT,attachment_name TEXT,is_system INTEGER,deleted_at TEXT);
    CREATE TABLE chat_group_members(group_id INTEGER,user_id INTEGER);
    INSERT INTO chat_groups VALUES(1,'Project',0,NULL),(2,'Private',1,NULL);
    INSERT INTO chat_group_members VALUES(1,10),(1,20),(1,30),(2,10),(2,20);
    INSERT INTO chat_messages VALUES(1,1,10,'Sender','Hello',NULL,0,NULL),(2,2,10,'Sender',NULL,'drawing.pdf',0,NULL);`);
  return db;
}
test('group and direct messages notify only members other than the sender',()=>{
  const db=fixture();assert.deepEqual(chatDelivery(db,1,1).recipients,[20,30]);
  const dm=chatDelivery(db,2,2);assert.deepEqual(dm.recipients,[20]);
  assert.equal(dm.payload.type,'site_chat');assert.match(dm.payload.body,/drawing.pdf/);
  assert.equal(dm.payload.url,'/site-chat?chat=2');assert.equal(dm.payload.groupId,2);assert.equal(dm.payload.messageId,2);assert.equal(dm.payload.tag,'chat-message-2');db.close();
});
test('system messages, deleted messages, wrong groups and archived groups do not push',()=>{
  const db=fixture();assert.equal(chatDelivery(db,1,2),null);
  for(const sql of ["UPDATE chat_messages SET is_system=1 WHERE id=1","UPDATE chat_messages SET is_system=0,deleted_at='now' WHERE id=1","UPDATE chat_messages SET deleted_at=NULL WHERE id=1; UPDATE chat_groups SET archived_at='now' WHERE id=1"]) {
    db.exec(sql);assert.equal(chatDelivery(db,1,1),null);
  }db.close();
});
test('removed members do not get messages and previews have a bounded size',()=>{
  const db=fixture();db.exec('DELETE FROM chat_group_members WHERE user_id=20');
  db.prepare('UPDATE chat_messages SET body=? WHERE id=1').run('a'.repeat(1000));
  const delivery=chatDelivery(db,1,1);assert.deepEqual(delivery.recipients,[30]);assert.equal(delivery.payload.body.length,240);db.close();
});
test('only chat and explicit chat tests pass the mobile notification policy',()=>{
  for(const payload of [{},{type:'ticket'},{type:'approval'},{url:'/site-chat'},null]) assert.equal(isChatPush(payload),false);
  assert.equal(isChatPush({type:'site_chat'}),true);assert.equal(isChatPush({type:'chat_push_test'}),true);
});
test('new chat messages dispatch push even before any socket server/client exists',()=>{
  const delivered=[];const module={exports:{}};
  const deps={'socket.io':{},jsonwebtoken:{},'../middleware/auth':{},'../db/chatDb':{},'./chatPush':{notifyChat:(...args)=>delivered.push(args)}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../chatSocket.js'),'utf8'),{require:name=>deps[name],module,setTimeout,Map});
  module.exports.emitChat(1,'message',{id:7});module.exports.emitChat(1,'changed',{});
  assert.deepEqual(delivered,[[1,7]]);
});
test('push sender blocks non-chat alerts and broadcasts without touching subscriptions',async()=>{
  const module={exports:{}};
  const deps={'web-push':{},'../db/schema':{getDb:()=>{throw Error('Must not read devices for other ERP alerts');}},'./chatPush':{isChatPush}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../push.js'),'utf8'),{require:name=>deps[name],module,setImmediate,console,process});
  assert.equal((await module.exports.pushToUser(20,{title:'Task assigned'})).skipped,'chat_only');
  assert.equal((await module.exports.pushToAll({title:'Announcement'})).sent,0);
});
