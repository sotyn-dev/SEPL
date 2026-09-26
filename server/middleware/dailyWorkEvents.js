// Observe existing source workflows, including changes made outside Daily Work.
// Source handlers still perform all authorization, validation and side effects.
const { getDb } = require('../db/schema');
const { event, approvers } = require('../lib/dailyWork');
const { istToday } = require('../lib/istDate');
const { notify } = require('../lib/push');
const snapshot = row => row && Object.fromEntries(['id','assigned_to','due_date','status','proof_url','requested_due_date','extension_status','extension_reason','reject_reason','approval_status','approval_note'].filter(k=>k in row).map(k=>[k,row[k]]));
module.exports = function dailyWorkEvents(req,res,next) {
  if(!['POST','PUT','PATCH','DELETE'].includes(req.method)) return next();
  const task=/^\/(delegations|pms-tasks)\/(\d+)(?:\/(submit|approve|reject|request-extension|approve-extension|reject-extension))?\/?$/.exec(req.path);
  const checklist=/^\/hr\/checklists\/(\d+)\/complete\/?$/.exec(req.path);
  const decision=/^\/hr\/checklists\/completions\/(\d+)\/decision\/?$/.exec(req.path);
  if(!task && !checklist && !decision) return next();
  const db=getDb(), source=task ? (task[1]==='pms-tasks' ? 'pms_tasks':'delegations'):'checklists';
  const completion=decision ? db.prepare('SELECT * FROM checklist_completions WHERE id=?').get(+decision[1]):null;
  const id=+(task?.[2] || checklist?.[1] || completion?.checklist_id || 0);
  const before=db.prepare(`SELECT * FROM ${source} WHERE id=?`).get(id);
  if(!before) return next();
  const original=res.json.bind(res);
  res.json=body=> {
    try {
    if(res.statusCode>=200 && res.statusCode<300 && req.user) {
      const after=db.prepare(`SELECT * FROM ${source} WHERE id=?`).get(id);
      const uid=completion?.user_id || (checklist ? req.user.id:before.assigned_to);
      const occurrence=source==='checklists' ? (completion?.completion_date || req.body.completion_date || istToday()):'';
      const action=task?.[3] || (checklist ? 'submit':decision ? req.body.status:req.method==='DELETE'?'source_deleted':'source_updated');
      const afterCompletion=source==='checklists' ? db.prepare('SELECT * FROM checklist_completions WHERE checklist_id=? AND user_id=? AND completion_date=?').get(id,uid,occurrence):null;
      if(uid) {
        db.transaction(()=> {
          event(db,req.user,uid,source,id,occurrence,action,String(req.body.reason || req.body.proof_remarks || req.body.note || `Source workflow: ${action}`),snapshot(completion || before),snapshot(afterCompletion || after));
          if(['submit','approve','approved','reject','rejected'].includes(action) || !after || after.assigned_to!==before.assigned_to) {
            const p=db.prepare('SELECT * FROM daily_work_plans WHERE user_id=? AND source=? AND source_id=? AND occurrence=?').get(uid,source,id,occurrence);
            if(p) {
              const elapsed=p.elapsed_seconds+(p.started_at ? Math.max(0,Math.floor((Date.now()-Date.parse(p.started_at))/1000)):0);
              db.prepare("UPDATE daily_work_plans SET state='paused',started_at=NULL,elapsed_seconds=?,version=version+1 WHERE id=?").run(elapsed,p.id);
            }
          }
        })();
        const manager=db.prepare('SELECT manager_id FROM users WHERE id=?').get(uid)?.manager_id;
        if(['submit','request-extension'].includes(action)) {
          const recipients=new Set(approvers(db,source,before,action==='request-extension').map(u=>u.id));
          if(manager)recipients.add(manager);
          for(const recipient of recipients) if(recipient!==req.user.id) notify(recipient,{title:'Daily Work needs attention',body:`${before.title}: ${action==='submit' ? 'submitted for approval':'more time requested'}`,url:'/daily-work'});
        }
        if(['approve','approved','reject','rejected'].includes(action)) notify(uid,{title:'Work reviewed',body:`${before.title}: ${action}`,url:'/daily-work'});
      }
    }
    } catch (error) {
      // The source action has already committed. An observer failure must not
      // turn success into a retry that repeats the original workflow.
      console.error('[daily-work] Source action saved; activity recording failed:', error.message);
    }
    return original(body);
  };
  next();
};
