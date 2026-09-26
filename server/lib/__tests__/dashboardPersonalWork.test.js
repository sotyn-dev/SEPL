const {test}=require('node:test');
const assert=require('node:assert/strict');
const Database=require('better-sqlite3');
const {personalRaciWork}=require('../personalRaciWork');
const {MODULE_DEFS}=require('../../utils/raciModules');
test('personal assigned records exclude other users, inaccessible modules and future steps',()=>{
  const step={key:'a',label:'Review',status:'current',responsible_id:7,started_at:'2026-09-26T02:00:00Z',sla_hours:2};
  const board=()=>({label:'Sample',rows:[{id:1,title:'Record',steps:[step,{...step,key:'b',status:'pending',responsible_id:8,accountable_id:7}]},{id:2,title:'Private',steps:[{...step,responsible_id:9}]}]});
  assert.equal(personalRaciWork(null,{id:7,role:'user'},{},board).rows.length,0);
  const result=personalRaciWork(null,{id:7,role:'user'},{cheques:{can_view:1}},board);
  assert.equal(result.rows.length,1);assert.equal(result.rows[0].due_at,'2026-09-26T04:00:00.000Z');
});
test('dashboard record reads include older assigned work beyond the existing 500-record board limit',()=>{
  const db=new Database(':memory:');
  db.exec('CREATE TABLE cheques(id INTEGER PRIMARY KEY,cheque_number TEXT,payee_to TEXT,bank_name TEXT,raised_at TEXT,raised_by INTEGER,current_status TEXT); CREATE TABLE cheque_actions(cheque_id INTEGER,action_at TEXT)');
  const insert=db.prepare("INSERT INTO cheques VALUES(?,?,'Vendor','Bank','2026-09-01',1,'pending')");
  for(let i=1;i<=501;i++)insert.run(i,`C-${i}`);
  assert.equal(MODULE_DEFS.cheques.rows(db).length,500);
  assert.equal(MODULE_DEFS.cheques.rows(db,{allRecords:true}).length,501);db.close();
});
