const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');
let db, server, root;
const notifications=[];
const stub=(path,exports)=>{require.cache[require.resolve(path)]={exports};};
stub('../../db/schema',{getDb:()=>db});
stub('../push',{notify:(id,payload)=>notifications.push({id,...payload})});
stub('../istDate',{istToday:()=> '2026-09-24',istNowMinutes:()=>600});
const auth=(req,res,next)=>{req.user=db.prepare('SELECT id,name,role FROM users WHERE id=?').get(Number(req.headers['x-test-user'] || 1));if(!req.user)return res.sendStatus(401);next();};
stub('../../middleware/auth',{authMiddleware:auth,requirePermission:()=>auth,adminOnly:auth,getUserPermissions:()=>({})});
const work=require('../dailyWork');
const router=require('../../routes/dailyWork');
const observer=require('../../middleware/dailyWorkEvents');
const pms=require('../../routes/pmstasks');
const DAY='2026-09-24';
beforeEach(async()=> {
  notifications.length=0;
  db=new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,role TEXT,manager_id INTEGER,active INTEGER DEFAULT 1,archived INTEGER DEFAULT 0);
    INSERT INTO users(id,name,role,manager_id) VALUES(1,'Asha','user',2),(2,'Manager','manager',NULL),(3,'Other','user',NULL),(4,'Admin','admin',NULL);
    CREATE TABLE user_roles(user_id INTEGER,role_id INTEGER);
    CREATE TABLE role_permissions(role_id INTEGER,module TEXT,can_view INTEGER,can_approve INTEGER);
    INSERT INTO user_roles VALUES(2,1);
    INSERT INTO role_permissions VALUES(1,'delegations',1,0),(1,'pms_tasks',1,0),(1,'checklists',1,0);
    CREATE TABLE employees(id INTEGER PRIMARY KEY,user_id INTEGER,roster TEXT,status TEXT);
    INSERT INTO employees VALUES(1,1,'early','active');
    CREATE TABLE attendance(user_id INTEGER,date TEXT,status TEXT,punch_in_time TEXT,punch_out_time TEXT);
    INSERT INTO attendance VALUES(1,'2026-09-24','present','2026-09-24T03:30:00Z',NULL);
    CREATE TABLE leave_requests(user_id INTEGER,from_date TEXT,to_date TEXT,from_time TEXT,to_time TEXT,leave_type TEXT,status TEXT);
    CREATE TABLE payroll_holidays(date TEXT,name TEXT);
    CREATE TABLE payroll_settings(id INTEGER PRIMARY KEY,late_after_time TEXT);
    INSERT INTO payroll_settings VALUES(1,'09:46');
    CREATE TABLE delegations(id INTEGER PRIMARY KEY,title TEXT,description TEXT,assigned_to INTEGER,assigned_by INTEGER,due_date TEXT,status TEXT,proof_url TEXT,submitted_at TEXT,reviewed_at TEXT,reviewer_id INTEGER,reject_reason TEXT,requested_due_date TEXT,extension_reason TEXT,extension_status TEXT,extension_reviewed_by INTEGER,extension_reviewed_at TEXT);
    CREATE TABLE pms_tasks(id INTEGER PRIMARY KEY,title TEXT,description TEXT,assigned_to INTEGER,assigned_by INTEGER,crm_name TEXT,due_date TEXT,status TEXT,proof_url TEXT,submitted_at TEXT,reviewed_at TEXT,reviewer_id INTEGER,reject_reason TEXT,requested_due_date TEXT,extension_reason TEXT,extension_status TEXT,extension_reviewed_by INTEGER,extension_reviewed_at TEXT);
    INSERT INTO delegations(id,title,assigned_to,assigned_by,due_date,status) VALUES(1,'Prepare report',1,2,'2026-09-24','pending'),(2,'Older task',1,2,'2026-09-22','pending'),(3,'Other user private task',3,3,'2026-09-24','pending');
    INSERT INTO pms_tasks(id,title,assigned_to,assigned_by,due_date,status) VALUES(1,'Verify site bill',1,2,'2026-09-24','pending');
    CREATE TABLE checklists(id INTEGER PRIMARY KEY,title TEXT,description TEXT,assigned_to INTEGER,created_by INTEGER,due_date TEXT,status TEXT,frequency TEXT,proof_type TEXT,created_at TEXT);
    INSERT INTO checklists VALUES(1,'Safety checklist','Inspect equipment',1,2,NULL,'pending','daily','photo','2026-09-01');
    CREATE TABLE checklist_completions(id INTEGER PRIMARY KEY,checklist_id INTEGER,user_id INTEGER,completion_date TEXT,proof_url TEXT,notes TEXT,submitted_at TEXT,approval_status TEXT,approval_note TEXT,UNIQUE(checklist_id,user_id,completion_date));
  `);
  require('../../db/dailyWork').initialize(db);
  const app=express();app.use(express.json());
  app.use('/api/daily-work',router);
  app.use('/api',observer);
  app.use('/api/pms-tasks',pms);
  app.use((e,req,res,next)=>res.status(e.status || 500).json({error:e.message}));
  server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  root=`http://127.0.0.1:${server.address().port}/api`;
});
afterEach(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
async function call(path,{method='GET',body,user=1,status=200}={}) {
  const r=await fetch(root+path,{method,headers:{'Content-Type':'application/json','x-test-user':String(user)},body:body?JSON.stringify(body):undefined});
  const result=await r.json();assert.equal(r.status,status,JSON.stringify(result));return result;
}
const plan=(more={})=>({work_date:DAY,start_minute:600,duration:30,priority:'high',steps:[{title:'Check source document',duration:10},{title:'Finish and verify',duration:20}],reason:'Today’s agreed plan',...more});
const saved=()=>db.prepare('SELECT * FROM daily_work_plans ORDER BY id LIMIT 1').get();

test('migration is repeatable; aggregation does not create or duplicate source tasks',async()=> {
  require('../../db/dailyWork').initialize(db);
  const a=await call(`/daily-work?date=${DAY}`), b=await call(`/daily-work?date=${DAY}`);
  assert.equal(a.tasks.length,4);assert.equal(new Set(a.tasks.map(t=>t.key)).size,4);assert.equal(b.tasks.length,4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_work_plans').get().n,0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM delegations').get().n,3);
  assert.equal(a.schedule.config.start,'09:00');assert.equal(a.schedule.capacity_minutes,540);
  assert.equal(a.counts.overdue,1);
});
test('ownership, direct-report scope and source permissions are enforced',async()=> {
  await call(`/daily-work?date=${DAY}&user_id=3`,{status:403});
  await call(`/daily-work?date=${DAY}&user_id=1`,{user:2});
  await call('/daily-work/plan/delegations/3',{method:'PUT',body:plan(),status:404});
  const team=await call(`/daily-work/team?date=${DAY}`,{user:2});assert.deepEqual(team.map(u=>u.id),[1]);
  assert.equal(team[0].approvals.length,0);
  db.prepare('DELETE FROM role_permissions').run();
  const hidden=await call(`/daily-work?date=${DAY}&user_id=1`,{user:2});assert.deepEqual(hidden.tasks,[]);
  await call('/daily-work/plan/delegations/1',{method:'PUT',user:2,body:plan({user_id:1}),status:403});
});
test('plans validate steps, overlap, dates and stale versions; source deadlines stay unchanged',async()=> {
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({work_date:'2026-02-30'}),status:400});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({duration:15}),status:400});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan()});
  await call('/daily-work/plan/delegations/2',{method:'PUT',body:plan(),status:409});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({version:0,start_minute:660}),status:409});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({version:1,work_date:'2026-09-25',reason:'Waiting for vendor'})});
  assert.equal(saved().work_date,'2026-09-25');
  assert.equal(db.prepare('SELECT due_date FROM delegations WHERE id=1').get().due_date,DAY);
  const history=await call('/daily-work/history/delegations/1');
  assert.equal(history[0].before.work_date,DAY);assert.equal(history[0].after.work_date,'2026-09-25');assert.equal(history[0].reason,'Waiting for vendor');
  const old=await call(`/daily-work?date=${DAY}`);assert.equal(old.tasks.find(t=>t.id===1&&t.source==='delegations').scheduled,false);
});
test('schedule honors holidays, approved partial leave, breaks, weekly off and overnight shifts',async()=> {
  const config={start:'22:00',end:'06:00',weekdays:[4],breaks:[{start:'01:00',end:'01:30'}]};
  await call('/daily-work/schedule',{method:'PUT',user:2,body:{user_id:1,reason:'Night shift',config}});
  assert.equal(work.schedule(db,1,DAY).capacity_minutes,450);
  db.exec("INSERT INTO leave_requests VALUES(1,'2026-09-25','2026-09-25','02:00','03:00','short_leave','approved')");
  assert.equal(work.schedule(db,1,DAY).capacity_minutes,390);
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({start_minute:1560}),status:400});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({start_minute:1320})});
  db.exec("INSERT INTO payroll_holidays VALUES('2026-09-25','Holiday')");assert.equal(work.schedule(db,1,DAY).capacity_minutes,120);
  db.exec("INSERT INTO payroll_holidays VALUES('2026-09-24','Holiday')");assert.equal(work.schedule(db,1,DAY).capacity_minutes,0);
  assert.equal(work.schedule(db,1,'2026-09-26').capacity_minutes,0);
  assert.equal(db.prepare('SELECT late_after_time FROM payroll_settings').get().late_after_time,'09:46');
  await call('/daily-work/schedule',{method:'PUT',body:{reason:'Own shift',config},status:403});
});
test('start/pause/resume are versioned; only one task runs; blockers require reasons and notify manager',async()=> {
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan()});
  const id=saved().id;
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'start',version:1}});
  await call(`/daily-work/plan/${id}/action`,{method:'POST',user:3,body:{action:'pause',version:2},status:404});
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'start',version:2},status:409});
  await call('/daily-work/plan/delegations/2',{method:'PUT',body:plan({start_minute:660})});
  await call('/daily-work/plan/2/action',{method:'POST',body:{action:'start',version:1},status:409});
  db.prepare('UPDATE daily_work_plans SET started_at=? WHERE id=?').run(new Date(Date.now()-60000).toISOString(),id);
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'block',version:2},status:400});
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'block',version:2,reason:'Missing signed drawing'}});
  assert.equal(saved().state,'blocked');assert.ok(saved().elapsed_seconds>=60);assert.equal(notifications[0].id,2);
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'resume',version:3,reason:'Drawing received'}});
  await call(`/daily-work/plan/${id}/action`,{method:'POST',body:{action:'pause',version:4}});
  assert.equal(saved().state,'paused');assert.equal(saved().started_at,null);
});
test('dependencies require approval and cannot be circular or expose another user’s task',async()=> {
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({dependencies:[{source:'delegations',id:3}]}),status:404});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({dependencies:[{source:'delegations',id:2}]})});
  await call('/daily-work/plan/delegations/2',{method:'PUT',body:plan({start_minute:660,dependencies:[{source:'delegations',id:1}]}),status:400});
  await call(`/daily-work/plan/${saved().id}/action`,{method:'POST',body:{action:'start',version:1},status:400});
  db.prepare("UPDATE delegations SET status='approved' WHERE id=2").run();
  await call(`/daily-work/plan/${saved().id}/action`,{method:'POST',body:{action:'start',version:1}});
});
test('source submission remains awaiting approval; original PMS approval closes it and history records deadline changes',async()=> {
  await call('/daily-work/plan/pms_tasks/1',{method:'PUT',body:plan()});
  await call(`/daily-work/plan/${saved().id}/action`,{method:'POST',body:{action:'start',version:1}});
  await call('/pms-tasks/1/submit',{method:'POST',body:{proof_url:'/uploads/proof.png'}});
  let data=await call(`/daily-work?date=${DAY}`);assert.equal(data.counts.awaiting_approval,1);assert.equal(data.counts.completed,0);assert.equal(saved().state,'paused');
  await call('/pms-tasks/1/approve',{method:'POST',user:3,body:{},status:403});
  await call('/pms-tasks/1/approve',{method:'POST',user:2,body:{}});
  data=await call(`/daily-work?date=${DAY}`);assert.equal(data.counts.completed,1);assert.equal(data.counts.awaiting_approval,0);
  await call('/daily-work/plan/pms_tasks/1',{method:'PUT',body:plan({version:saved().version}),status:409});
  db.exec("UPDATE pms_tasks SET status='pending' WHERE id=1");
  await call('/pms-tasks/1/request-extension',{method:'POST',body:{requested_due_date:'2026-09-28',reason:'Client delay'}});
  assert.equal(db.prepare('SELECT due_date FROM pms_tasks').get().due_date,DAY);
  await call('/pms-tasks/1/approve-extension',{method:'POST',user:2,body:{},status:403});
  await call('/pms-tasks/1/approve-extension',{method:'POST',user:4,body:{}});
  const history=await call('/daily-work/history/pms_tasks/1');assert.equal(history[0].before.due_date,DAY);assert.equal(history[0].after.due_date,'2026-09-28');
});
test('older checklist submissions stay visible and approved leave suppresses new daily occurrences',async()=> {
  db.exec("INSERT INTO checklist_completions(checklist_id,user_id,completion_date,proof_url,approval_status) VALUES(1,1,'2026-09-23','/uploads/yesterday.png','pending')");
  let data=await call(`/daily-work?date=${DAY}`);assert.equal(data.tasks.filter(t=>t.source==='checklists').length,2);assert.equal(data.counts.awaiting_approval,1);
  db.exec("INSERT INTO leave_requests(user_id,from_date,to_date,leave_type,status) VALUES(1,'2026-09-24','2026-09-24','casual','approved')");
  data=await call(`/daily-work?date=${DAY}`);assert.equal(data.schedule.capacity_minutes,0);assert.equal(data.tasks.filter(t=>t.source==='checklists').length,1);
  assert.equal(data.tasks.find(t=>t.source==='checklists').occurrence,'2026-09-23');
});
test('EOD requires an explanation and next action for every unfinished item and saves immutable snapshots',async()=> {
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan()});
  const data=await call(`/daily-work?date=${DAY}`);
  await call('/daily-work/review',{method:'POST',body:{date:DAY,entries:[]},status:400});
  const entries=data.tasks.filter(t=>(t.scheduled||t.overdue||t.due_date===DAY)&&t.status!=='approved').map(t=>({key:t.key,reason:'Waiting on input',next_action:'Call owner tomorrow; agree a new plan'}));
  await call('/daily-work/review',{method:'POST',body:{date:DAY,entries,summary:'Reviewed with manager'}});
  await call('/daily-work/review',{method:'POST',body:{date:DAY,entries,summary:'Additional note'}});
  assert.equal(db.prepare('SELECT COUNT(*) n FROM daily_work_reviews').get().n,2);
  const review=work.json(db.prepare('SELECT entries FROM daily_work_reviews ORDER BY id LIMIT 1').get().entries,[]);
  assert.equal(review[0].plan.work_date,DAY);assert.equal(saved().work_date,DAY);
  assert.equal(db.prepare('SELECT due_date FROM delegations WHERE id=1').get().due_date,DAY);
  const tomorrow=await call('/daily-work?date=2026-09-25');assert.equal(tomorrow.tasks.find(t=>t.source==='delegations'&&t.id===1).scheduled,false);
  assert.equal(db.prepare('SELECT status FROM attendance').get().status,'present');
});
test('changing leave after planning flags the conflict instead of silently changing the plan',async()=> {
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan()});
  db.exec("INSERT INTO leave_requests VALUES(1,'2026-09-24','2026-09-24','10:00','11:00','short_leave','approved')");
  const data=await call(`/daily-work?date=${DAY}`);assert.equal(data.tasks.find(t=>t.source==='delegations'&&t.id===1).schedule_conflict,true);
  await call(`/daily-work/plan/${saved().id}/action`,{method:'POST',body:{action:'start',version:1},status:400});
  assert.equal(saved().start_minute,600);
});
test('approval queue follows source privileges across reporting lines without exposing private plans',async()=> {
  db.exec("UPDATE pms_tasks SET assigned_to=3,status='submitted',proof_url='/uploads/review.png' WHERE id=1");
  const queue=await call('/daily-work/approvals',{user:2});
  assert.equal(queue.length,1);assert.equal(queue[0].assignee_name,'Other');assert.equal(queue[0].can_approve,true);
  assert.equal(queue[0].plan,undefined);
  await call(`/daily-work?date=${DAY}&user_id=3`,{user:2,status:403});
  assert.deepEqual(await call('/daily-work/approvals',{user:1}),[]);
});
test('unplanned completions are counted on their IST approval date',async()=> {
  db.exec("UPDATE pms_tasks SET due_date='2026-09-20',status='approved',reviewed_at='2026-09-23 20:00:00' WHERE id=1");
  const data=await call(`/daily-work?date=${DAY}`);
  assert.equal(data.counts.completed,1);assert.equal(data.tasks.find(t=>t.source==='pms_tasks').completed_on,DAY);
});
test('deleting or reassigning source work releases its running timer',async()=> {
  await call('/daily-work/plan/pms_tasks/1',{method:'PUT',body:plan()});
  await call(`/daily-work/plan/${saved().id}/action`,{method:'POST',body:{action:'start',version:1}});
  await call('/pms-tasks/1',{method:'DELETE',user:2});
  assert.equal(saved().state,'paused');assert.equal(saved().started_at,null);
  assert.equal(db.prepare('SELECT action FROM daily_work_events ORDER BY id DESC LIMIT 1').get().action,'source_deleted');
});

test('overnight plans cannot overlap a task on the following work date',async()=> {
  const night={start:'22:00',end:'06:00',weekdays:[4,5],breaks:[]};
  await call('/daily-work/schedule',{method:'PUT',user:2,body:{user_id:1,reason:'Night roster',config:night}});
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({start_minute:1500})});
  const morning={start:'00:00',end:'08:00',weekdays:[4,5],breaks:[]};
  await call('/daily-work/schedule',{method:'PUT',user:2,body:{user_id:1,reason:'Revised roster',config:morning}});
  await call('/daily-work/plan/delegations/2',{method:'PUT',body:plan({work_date:'2026-09-25',start_minute:60}),status:409});
  await call('/daily-work/plan/delegations/2',{method:'PUT',body:plan({work_date:'2026-09-25',start_minute:90})});
});

test('manager module restrictions also filter saved reviews and dependency context',async()=> {
  const deps=[{source:'pms_tasks',id:1,occurrence:''}];
  await call('/daily-work/plan/delegations/1',{method:'PUT',body:plan({dependencies:deps})});
  const data=await call(`/daily-work?date=${DAY}`);
  const entries=data.tasks.filter(t=>t.scheduled||t.overdue||t.due_date===DAY).map(t=>({key:t.key,reason:'Private source details',next_action:'Follow up'}));
  await call('/daily-work/review',{method:'POST',body:{date:DAY,entries,summary:'Private PMS summary'}});
  db.exec("DELETE FROM role_permissions WHERE module='pms_tasks'");
  const restricted=await call(`/daily-work?date=${DAY}&user_id=1`,{user:2});
  assert.equal(restricted.reviews[0].entries.some(e=>e.key.startsWith('pms_tasks:')),false);
  assert.notEqual(restricted.reviews[0].summary,'Private PMS summary');
  assert.equal(restricted.tasks.find(t=>t.key==='delegations:1:').dependencies[0].title,'Dependency details require module access');
  await call('/daily-work/plan/delegations/1',{method:'PUT',user:2,body:plan({user_id:1,version:1,dependencies:deps}),status:403});
});

test('activity recording failure does not undo or misreport successful source submission',async()=> {
  db.exec("CREATE TRIGGER reject_audit BEFORE INSERT ON daily_work_events BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  const log=console.error; const errors=[]; console.error=(...args)=>errors.push(args.join(' '));
  try { await call('/pms-tasks/1/submit',{method:'POST',body:{proof_url:'/uploads/proof.png'}}); }
  finally { console.error=log; }
  assert.equal(db.prepare('SELECT status FROM pms_tasks WHERE id=1').get().status,'submitted');
  assert.equal(errors.length,1);
  assert.match(errors[0],/activity recording failed/);
});
