const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { istToday, istNowMinutes } = require('../lib/istDate');
const work = require('../lib/dailyWork');
const { notify } = require('../lib/push');
const router = express.Router();
router.use(authMiddleware);
const wrap = fn => (req,res,next) => { try { fn(req,res); } catch(e) { if (e.status) res.status(e.status).json({error:e.message}); else next(e); } };
const reason = body => { const value = String(body.reason || '').trim(); if (!value || value.length>2000) work.fail('A reason (up to 2,000 characters) is required'); return value; };
const date = value => { if (!work.dateOk(value)) work.fail('A valid date is required'); return value; };
const member = (db,req) => work.owner(db,req.user,Number(req.query.user_id || req.body?.user_id || req.user.id));
const tellManager = (db, userId, title, body) => {
  const manager = db.prepare('SELECT manager_id FROM users WHERE id=?').get(userId)?.manager_id;
  if (manager) notify(manager,{ title,body,url:'/daily-work',tag:`daily-work-${userId}` });
};
router.get('/',wrap((req,res) => {
  const db=getDb(), u=member(db,req), day=date(req.query.date || istToday());
  const data=work.tasks(db,req.user,u.id,day);
  res.json({...data, user:u, date:day, today:istToday(), now_minute:(Date.parse(istToday())-Date.parse(day))/86400000*1440+istNowMinutes(),
    reviews:db.prepare('SELECT * FROM daily_work_reviews WHERE user_id=? AND work_date=? ORDER BY id DESC').all(u.id,day).map(r=>{
      const all=work.json(r.entries,[]);
      const entries=all.filter(e=>work.visibleSource(db,req.user,u.id,e.key.split(':')[0]));
      return {...r,entries,summary:entries.length===all.length?r.summary:'Some review details are hidden by module permissions.'};
    }),
    members:db.prepare(`SELECT id,name FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 AND ${req.user.role==='admin' ? '1=1' : '(id=? OR manager_id=?)'} ORDER BY name`).all(...(req.user.role==='admin' ? [] : [req.user.id,req.user.id])),
  });
}));
// Approval eligibility is independent of reporting lines, just as in the source
// modules. Return source details only, never another team's private daily plan.
router.get('/approvals',wrap((req,res)=> {
  const db=getDb(), out=[];
  for(const source of ['delegations','pms_tasks']) {
    const rows=db.prepare(`SELECT t.*,u.name AS assignee_name FROM ${source} t LEFT JOIN users u ON u.id=t.assigned_to WHERE t.status='submitted' OR t.extension_status='pending'`).all();
    for(const t of rows) {
      const approve=work.canApprove(db,req.user,source,t), extension=req.user.role==='admin' || (source==='delegations' && approve);
      if((t.status==='submitted'&&approve) || (t.extension_status==='pending'&&extension)) out.push({
        key:`${source}:${t.id}`,source,id:t.id,title:t.title,assignee_name:t.assignee_name,proof_url:t.proof_url,proof_remarks:t.proof_remarks,
        source_status:t.status,can_approve:approve,can_approve_extension:extension,extension_status:t.extension_status,
        requested_due_date:t.requested_due_date,extension_reason:t.extension_reason,due_date:t.due_date,
      });
    }
  }
  if(req.user.role==='admin') {
    for(const t of db.prepare("SELECT c.id AS task_id,c.title,cc.*,u.name AS assignee_name FROM checklist_completions cc JOIN checklists c ON c.id=cc.checklist_id LEFT JOIN users u ON u.id=cc.user_id WHERE COALESCE(cc.approval_status,'pending')='pending'").all()) {
      out.push({key:`checklists:${t.id}`,source:'checklists',id:t.task_id,title:t.title,occurrence:t.completion_date,completion_id:t.id,assignee_name:t.assignee_name,proof_url:t.proof_url,proof_remarks:t.notes,source_status:'submitted',can_approve:true});
    }
  }
  res.json(out);
}));
router.get('/team',wrap((req,res) => {
  const db=getDb(), day=date(req.query.date || istToday());
  const members=db.prepare(`SELECT id,name FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 AND ${req.user.role==='admin' ? '1=1' : 'manager_id=?'} ORDER BY name`).all(...(req.user.role==='admin' ? []:[req.user.id]));
  res.json(members.map(u=> {
    const data=work.tasks(db,req.user,u.id,day);
    return {...u,counts:data.counts,capacity_minutes:data.schedule.capacity_minutes,planned_minutes:data.planned_minutes,
      schedule_reasons:data.schedule.reasons, blockers:data.tasks.filter(t=>t.status==='blocked').map(t=>({title:t.title,reason:t.plan.blocker})),
      approvals:data.tasks.filter(t=>(t.source_status==='submitted' && t.can_approve) || (t.extension_status==='pending' && t.can_approve_extension)),
      review:db.prepare('SELECT created_at FROM daily_work_reviews WHERE user_id=? AND work_date=? ORDER BY id DESC LIMIT 1').get(u.id,day) || null};
  }));
}));
router.put('/schedule',wrap((req,res)=> {
  const db=getDb(), u=member(db,req), why=reason(req.body), config=work.validateSchedule(req.body.config);
  if (u.id===req.user.id && req.user.role!=='admin' && !work.permission(db,req.user,'attendance','approve')) work.fail('Ask your manager or an attendance approver to configure your schedule',403);
  db.transaction(()=> {
    const before=db.prepare('SELECT config FROM daily_work_schedules WHERE user_id=?').get(u.id);
    db.prepare('INSERT INTO daily_work_schedules(user_id,config,updated_by) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET config=excluded.config,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP').run(u.id,JSON.stringify(config),req.user.id);
    work.event(db,req.user,u.id,null,null,'','schedule_changed',why,before ? work.json(before.config,null):null,config);
  })();
  res.json({message:'Planning schedule saved. Attendance and payroll settings are unchanged.'});
}));
router.put('/plan/:source/:id',wrap((req,res)=> {
  const db=getDb(), u=member(db,req), b=req.body, source=req.params.source, id=Number(req.params.id), occurrence=b.occurrence || '', why=reason(b);
  if (!work.visibleSource(db,req.user,u.id,source)) work.fail('Module permission required',403);
  const task=work.sourceTask(db,source,id,u.id,occurrence);
  if (['submitted','approved'].includes(task.status)) work.fail('Submitted or approved work cannot be replanned',409);
  const day=date(b.work_date), start=Number(b.start_minute), duration=Number(b.duration);
  if (!Number.isInteger(start) || start<0 || start>=2880 || !Number.isInteger(duration) || duration<1 || duration>1440) work.fail('Choose a valid start and duration (1–1,440 minutes)');
  if (!work.PRIORITIES.includes(b.priority)) work.fail('Invalid priority');
  if (source==='checklists' && occurrence!==day) work.fail('Recurring checklist plans must stay on their occurrence date');
  const schedule=work.schedule(db,u.id,day);
  if (!schedule.spans.some(([a,z])=>start>=a && start+duration<=z)) work.fail('This time overlaps a break, leave, holiday, or time outside the shift');
  if (source==='checklists') {
    const original=db.prepare('SELECT * FROM checklists WHERE id=?').get(id);
    if (!require('../lib/checklistFrequency').expectedOn({...original,assigned_to:u.id},day,require('../lib/checklistFrequency').absenceSet(db,[day],{inferNoPunch:false}))) work.fail('This checklist is not due on that date');
  }
  if (!Array.isArray(b.steps) || !b.steps.length || b.steps.length>40) work.fail('Add between 1 and 40 task steps');
  let cursor=start;
  const steps=b.steps.map((s,i)=> {
    const title=String(s.title || '').trim(), length=Number(s.duration);
    if (!title || title.length>500 || !Number.isInteger(length) || length<1) work.fail('Each step needs instructions and a positive duration');
    const step={title,duration:length,start_minute:cursor,done:!!s.done}; cursor+=length; return step;
  });
  if (cursor>start+duration) work.fail('Step durations exceed the task estimate');
  const documents=b.documents || [], dependencies=b.dependencies || [];
  if (!Array.isArray(documents) || documents.length>20 || documents.some(d=>typeof d!=='string' || d.length>2000 || !/^(https?:\/\/|\/uploads\/)/i.test(d))) work.fail('Documents must be upload links or HTTP(S) URLs');
  if (!Array.isArray(dependencies) || dependencies.length>20) work.fail('Use at most 20 dependencies');
  const deps=dependencies.map(d=> {
    const ref={source:d.source,id:Number(d.id),occurrence:d.occurrence || ''};
    if (!work.visibleSource(db,req.user,u.id,ref.source)) work.fail('Dependency module permission required',403);
    work.sourceTask(db,ref.source,ref.id,u.id,ref.occurrence);
    if (ref.source===source && ref.id===id && ref.occurrence===occurrence) work.fail('A task cannot depend on itself');
    return ref;
  });
  const instructions=String(b.instructions || '').trim(); if(instructions.length>5000) work.fail('Instructions must be under 5,000 characters');
  db.transaction(()=> {
    const before=db.prepare('SELECT * FROM daily_work_plans WHERE user_id=? AND source=? AND source_id=? AND occurrence=?').get(u.id,source,id,occurrence);
    if (before && Number(b.version)!==before.version) work.fail('This plan changed. Reload before saving.',409);
    if (before?.state==='running') work.fail('Pause this task before changing its plan',409);
    const absoluteStart=Date.parse(day+'T00:00:00Z')/60000+start;
    if (db.prepare(`SELECT id FROM daily_work_plans WHERE user_id=? AND id<>?
      AND work_date BETWEEN date(?,'-1 day') AND date(?,'+1 day')
      AND CAST(strftime('%s',work_date) AS INTEGER)/60+start_minute < ?
      AND CAST(strftime('%s',work_date) AS INTEGER)/60+start_minute+duration > ?`)
      .get(u.id,before?.id || -1,day,day,absoluteStart+duration,absoluteStart)) work.fail('This time overlaps another planned task',409);
    // Walk existing edges; changing A to depend on B must not create A → B → A.
    const visit=(ref,seen=new Set())=> {
      const key=`${ref.source}:${ref.id}:${ref.occurrence}`;
      if (key===`${source}:${id}:${occurrence}`) work.fail('Dependencies cannot form a cycle');
      if(seen.has(key)) return; seen.add(key);
      const p=db.prepare('SELECT dependencies FROM daily_work_plans WHERE user_id=? AND source=? AND source_id=? AND occurrence=?').get(u.id,ref.source,ref.id,ref.occurrence);
      for (const dep of work.json(p?.dependencies,[])) visit(dep,seen);
    };
    deps.forEach(d=>visit(d));
    db.prepare(`INSERT INTO daily_work_plans(user_id,source,source_id,occurrence,work_date,start_minute,duration,priority,steps,dependencies,instructions,documents)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,source,source_id,occurrence) DO UPDATE SET
      work_date=excluded.work_date,start_minute=excluded.start_minute,duration=excluded.duration,priority=excluded.priority,
      steps=excluded.steps,dependencies=excluded.dependencies,instructions=excluded.instructions,documents=excluded.documents,version=version+1,updated_at=CURRENT_TIMESTAMP`)
      .run(u.id,source,id,occurrence,day,start,duration,b.priority,JSON.stringify(steps),JSON.stringify(deps),instructions,JSON.stringify(documents));
    const after=db.prepare('SELECT * FROM daily_work_plans WHERE user_id=? AND source=? AND source_id=? AND occurrence=?').get(u.id,source,id,occurrence);
    work.event(db,req.user,u.id,source,id,occurrence,before ? 'plan_changed':'planned',why,work.unpack(before),work.unpack(after));
  })();
  res.json({message:'Plan saved; source deadline unchanged'});
}));
router.post('/plan/:id/action',wrap((req,res)=> {
  const db=getDb(), b=req.body;
  db.transaction(()=> {
    const p=db.prepare('SELECT * FROM daily_work_plans WHERE id=? AND user_id=?').get(Number(req.params.id),req.user.id);
    if (!p) work.fail('Your plan was not found',404);
    if (Number(b.version)!==p.version) work.fail('This task changed. Reload before acting.',409);
    const task=work.sourceTask(db,p.source,p.source_id,req.user.id,p.occurrence);
    if (['approved','submitted'].includes(task.status)) work.fail('Work is already submitted or approved',409);
    const before=work.unpack(p), steps=before.steps;
    let state=p.state, started=p.started_at, elapsed=p.elapsed_seconds, blocker=p.blocker;
    if (['start','resume'].includes(b.action)) {
      if (!(b.action==='start' ? p.state==='planned' : ['paused','blocked'].includes(p.state))) work.fail('Invalid work-state transition',409);
      const now=(Date.parse(istToday())-Date.parse(p.work_date))/86400000*1440+istNowMinutes();
      if (!work.schedule(db,p.user_id,p.work_date).spans.some(([a,z])=>now>=a && now<z)) work.fail('Outside available working hours; ask your manager to update your schedule');
      if (before.dependencies.some(d=>work.sourceTask(db,d.source,d.id,p.user_id,d.occurrence).status!=='approved')) work.fail('Finish dependency approvals before starting');
      if(db.prepare("SELECT id FROM daily_work_plans WHERE user_id=? AND state='running'").get(p.user_id)) work.fail('Pause your current task first',409);
      if(p.state==='blocked') reason(b);
      state='running'; started=new Date().toISOString(); blocker=null;
    } else if (['pause','block'].includes(b.action)) {
      if (b.action==='pause' && p.state!=='running') work.fail('Only running work can be paused',409);
      if (b.action==='block') blocker=reason(b);
      if(started) elapsed+=Math.max(0,Math.floor((Date.now()-Date.parse(started))/1000));
      started=null; state=b.action==='block' ? 'blocked':'paused';
    } else if (b.action==='step') {
      if (!Number.isInteger(b.index) || !steps[b.index] || typeof b.done!=='boolean') work.fail('Invalid checklist step');
      steps[b.index].done=b.done;
    } else work.fail('Unknown action');
    db.prepare('UPDATE daily_work_plans SET state=?,started_at=?,elapsed_seconds=?,blocker=?,steps=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(state,started,elapsed,blocker,JSON.stringify(steps),p.id);
    work.event(db,req.user,p.user_id,p.source,p.source_id,p.occurrence,b.action,String(b.reason || b.action),before,work.unpack(db.prepare('SELECT * FROM daily_work_plans WHERE id=?').get(p.id)));
    if(b.action==='block') tellManager(db,p.user_id,`${req.user.name}: work blocked`,blocker);
  })();
  res.json({message:'Work updated'});
}));
router.post('/review',wrap((req,res)=> {
  const db=getDb(), day=date(req.body.date), data=work.tasks(db,req.user,req.user.id,day);
  if(day>istToday()) work.fail('Review today or a previous day');
  if(!Array.isArray(req.body.entries)) work.fail('Review entries required');
  const unfinished=data.tasks.filter(t=>(t.scheduled || t.overdue || t.due_date===day || t.status==='submitted') && t.status!=='approved');
  const entries=unfinished.map(t=> {
    const e=req.body.entries.find(e=>e.key===t.key);
    if(!e || !String(e.reason || '').trim() || !String(e.next_action || '').trim()) work.fail(`Add a reason and next action for ${t.title}`);
    if(String(e.reason).length>2000 || String(e.next_action).length>2000) work.fail('Review notes must be under 2,000 characters');
    return {key:t.key,title:t.title,status:t.status,source_due_date:t.due_date,plan:t.plan,reason:e.reason.trim(),next_action:e.next_action.trim()};
  });
  const summary=String(req.body.summary || '').slice(0,5000);
  db.prepare('INSERT INTO daily_work_reviews(user_id,work_date,entries,summary) VALUES(?,?,?,?)').run(req.user.id,day,JSON.stringify(entries),summary);
  tellManager(db,req.user.id,`${req.user.name}: daily review saved`,`${entries.length} unfinished items documented`);
  res.json({message:'Review saved. No deadlines or planned dates were changed.'});
}));
router.get('/history/:source/:id',wrap((req,res)=> {
  const db=getDb(), u=member(db,req), source=req.params.source, id=Number(req.params.id), occurrence=req.query.occurrence || '';
  if(!work.visibleSource(db,req.user,u.id,source)) work.fail('Module permission required',403);
  work.sourceTask(db,source,id,u.id,occurrence);
  res.json(db.prepare('SELECT e.*,u.name AS actor_name FROM daily_work_events e LEFT JOIN users u ON u.id=e.actor_id WHERE e.user_id=? AND e.source=? AND e.source_id=? AND e.occurrence=? ORDER BY e.id DESC LIMIT 100').all(u.id,source,id,occurrence).map(e=>({...e,before:work.json(e.before_json,null),after:work.json(e.after_json,null)})));
}));
module.exports=router;
