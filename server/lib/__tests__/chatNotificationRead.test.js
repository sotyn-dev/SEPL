const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
test('push requests audible alerts and re-alerts repeated tags without overriding phone settings',async()=>{
  const handlers={};let shown;
  const self={addEventListener:(type,fn)=>handlers[type]=fn,registration:{showNotification:async(title,options)=>{shown={title,options};}}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../../client/public/sw.js'),'utf8'),{self,URL});
  let pending;handlers.push({data:{json:()=>({title:'SOTYN Chat',tag:'test'})},waitUntil:p=>pending=p});await pending;
  assert.equal(shown.options.silent,false);assert.equal(shown.options.renotify,true);assert.equal(shown.options.tag,'test');
});
test('confirmed reads clear only read messages in that conversation on this device',async()=>{
  const handlers={},closed=[];
  const rows=[{type:'site_chat',groupId:1,messageId:5},{type:'site_chat',groupId:1,messageId:7},{type:'site_chat',groupId:2,messageId:4},{type:'chat_push_test',groupId:1,messageId:3}];
  const self={addEventListener:(type,fn)=>handlers[type]=fn,registration:{getNotifications:async()=>rows.map((data,i)=>({data,close:()=>closed.push(i)}))}};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../../../client/public/sw.js'),'utf8'),{self,URL});
  let pending;
  handlers.message({data:{type:'chat_read',groupId:1,lastReadId:5},waitUntil:p=>pending=p});await pending;
  assert.deepEqual(closed,[0]);
  handlers.message({data:{type:'chat_read',groupId:1,lastReadId:-1},waitUntil:()=>assert.fail('invalid read marker')});
});
