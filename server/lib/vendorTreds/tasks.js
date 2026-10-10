const {fail,requireOwner}=require('./access');
const {validDate}=require('./documents');
const {scopeIds}=require('./queries');
const DATE_TIME=/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:[zZ]|[+-]\d{2}:?\d{2})?$/;
function id(value,label) { const n=Number(value); if(!Number.isSafeInteger(n)||n<1)fail(`${label} must be a positive integer`,400); return n; }
function reminder(value) {
  if(value==null||value==='')return null;
  if(typeof value!=='string'||!DATE_TIME.test(value)||!validDate(value.slice(0,10))||Number(value.slice(11,13))>23||Number(value.slice(14,16))>59||Number(value.slice(17,19))>59)fail('Choose a valid reminder date and time',400);
  const zoned=/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)?value:value.replace(' ','T')+'+05:30';
  if(!Number.isFinite(Date.parse(zoned)))fail('Choose a valid reminder date and time',400);
  return new Date(zoned).toISOString();
}
function text(value,label,max,required=false) {
  if(value==null&&!required)return '';
  if(typeof value!=='string')fail(`${label} must be text`,400);
  const result=value.trim();if((required&&!result)||result.length>max)fail(`Enter ${label.toLowerCase()} under ${max.toLocaleString()} characters`,400);
  return result;
}
function validateInput(data) {
  if(!data||typeof data!=='object'||Array.isArray(data))fail('Task data must be an object',400);
  const allowed=new Set(['title','owner_id','due_date','priority','reminder_at','customer_id','registration_id','remarks','version','status']);
  for(const key of Object.keys(data))if(!allowed.has(key))fail(`Unknown task field: ${key}`,400);
  for(const key of ['owner_id','customer_id','registration_id'])if(data[key]!=null&&data[key]!=='')id(data[key],key);
  if(data.priority!=null&&data.priority!==''&&!['urgent','high','normal','low'].includes(data.priority))fail('Invalid priority',400);
  if(data.reminder_at!==undefined)reminder(data.reminder_at);
}
const DEFINITION={label:'Daily Tasks',permission:'vendor_treds_dashboard',fields:[
  {key:'title',label:'Task',type:'text',required:true},{key:'owner_id',label:'Owner',type:'lookup',lookup:'owner',required:true},
  {key:'due_date',label:'Due Date',type:'date',required:true},{key:'priority',label:'Priority',type:'select',options:['urgent','high','normal','low']},
  {key:'reminder_at',label:'Reminder',type:'datetime'},{key:'customer_id',label:'Client',type:'lookup',lookup:'customer'},
  {key:'registration_id',label:'Registration',type:'lookup',lookup:'registration'},
  {key:'remarks',label:'Remarks / Instructions',type:'textarea'},
],statuses:['not_started','in_progress','pending','completed','blocked'],transitions:{not_started:['in_progress','pending','blocked','completed'],in_progress:['pending','blocked','completed'],pending:['in_progress','blocked','completed'],blocked:['in_progress','pending','completed']}};
const select=`SELECT l.id,l.version,l.customer_id,l.registration_id,l.reminder_at,t.assigned_to owner_id,u.name owner_name,
  c.company_name customer_name,t.title,t.due_date,COALESCE(p.priority,l.priority) priority,
  COALESCE(p.instructions,l.remarks) remarks,p.blocker,
  t.reviewed_at completed_at,COALESCE(p.state,l.planning_state) plan_state,t.status source_status,
  CASE WHEN t.status='approved' THEN 'completed' WHEN COALESCE(p.state,l.planning_state)='blocked' THEN 'blocked'
    WHEN COALESCE(p.state,l.planning_state)='running' THEN 'in_progress' WHEN COALESCE(p.state,l.planning_state)='paused' OR t.status='submitted' THEN 'pending' ELSE 'not_started' END status
  FROM vt_task_links l LEFT JOIN daily_work_plans p ON p.id=l.daily_work_plan_id
  JOIN pms_tasks t ON t.id=COALESCE(l.pms_task_id,p.source_id) LEFT JOIN users u ON u.id=t.assigned_to LEFT JOIN customers c ON c.id=l.customer_id`;
function listTasks(db,filters={},scope={ownerIds:[]}) {
  const where=[],params=[];
  let owners;try{owners=scopeIds(scope);}catch(e){fail(e.message,400);}
  if(owners!==null){where.push(`t.assigned_to IN (${owners.map(()=>'?').join(',')||'NULL'})`);params.push(...owners);}
  if(filters.owner_id!=null&&filters.owner_id!==''){where.push('t.assigned_to=?');params.push(id(filters.owner_id,'Owner'));}
  if(filters.customer_id!=null&&filters.customer_id!==''){where.push('l.customer_id=?');params.push(id(filters.customer_id,'Client'));}
  if(filters.date_from){if(!validDate(filters.date_from))fail('Invalid date_from',400);where.push('t.due_date>=?');params.push(filters.date_from);}
  if(filters.date_to){if(!validDate(filters.date_to))fail('Invalid date_to',400);where.push('t.due_date<=?');params.push(filters.date_to);}
  if(filters.date_from&&filters.date_to&&filters.date_from>filters.date_to)fail('Date range is reversed',400);
  if(filters.overdue_as_of){if(!validDate(filters.overdue_as_of))fail('Invalid overdue date',400);where.push("t.due_date<? AND t.status<>'approved'");params.push(filters.overdue_as_of);}
  if(filters.search||filters.q){where.push('t.title LIKE ?');params.push(`%${String(filters.search||filters.q).slice(0,200)}%`);}
  if(filters.status){const statuses=Array.isArray(filters.status)?filters.status:[filters.status];if(!statuses.length||statuses.length>30||statuses.some(status=>!DEFINITION.statuses.includes(status)))fail('Invalid task state',400);where.push(`(CASE WHEN t.status='approved' THEN 'completed' WHEN COALESCE(p.state,l.planning_state)='blocked' THEN 'blocked' WHEN COALESCE(p.state,l.planning_state)='running' THEN 'in_progress' WHEN COALESCE(p.state,l.planning_state)='paused' OR t.status='submitted' THEN 'pending' ELSE 'not_started' END) IN (${statuses.map(()=>'?').join(',')})`);params.push(...statuses);}
  const sql=select+(where.length?' WHERE '+where.join(' AND '):''),limit=Math.min(100,Math.max(1,Math.floor(Number(filters.limit)||15))),page=Math.min(1000000,Math.max(1,Math.floor(Number(filters.page)||1)));
  return {rows:db.prepare(sql+' ORDER BY t.due_date,l.id DESC LIMIT ? OFFSET ?').all(...params,limit,(page-1)*limit),total:db.prepare('SELECT COUNT(*) n FROM ('+sql+')').get(...params).n,page,limit};
}
function event(db,user,id,before,after,action) {
  db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,before_json,after_json,actor_id,remarks) VALUES(?,?,?,?,?,?,?)').run('tasks',id,action,before?JSON.stringify(before):null,JSON.stringify(after),user.id,after.remarks||'');
}
function taskDetail(db,taskId){const row=db.prepare(select+' WHERE l.id=?').get(id(taskId,'Task'));if(!row)fail('Task not found',404);return row;}
function createTask(db,data,user) {
  validateInput(data);
  if(data.status&&data.status!=='not_started')fail('Create a task before changing its state',400);
  const ownerId=id(data.owner_id??user.id,'Owner'); requireOwner(user.scope,ownerId);
  if(!db.prepare('SELECT id FROM users WHERE id=? AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0').get(ownerId))fail('Choose an active owner',400);
  const title=text(data.title,'Task',1000,true),remarks=text(data.remarks,'Remarks',5000);
  if(!validDate(data.due_date))fail('Choose a valid due date',400);
  const customerId=data.customer_id==null||data.customer_id===''?null:id(data.customer_id,'Client');
  const registrationId=data.registration_id==null||data.registration_id===''?null:id(data.registration_id,'Registration');
  if(registrationId){const reg=db.prepare('SELECT customer_id FROM vt_registrations WHERE id=?').get(registrationId);if(!reg)fail('Registration not found',400);if(customerId&&reg.customer_id!==customerId)fail('Registration belongs to another client',400);}
  return db.transaction(()=>{
    const sourceId=Number(db.prepare("INSERT INTO pms_tasks(title,description,assigned_by,assigned_to,due_date,status) VALUES(?,?,?,?,?,'pending')").run(title,remarks,user.id,ownerId,data.due_date).lastInsertRowid);
    const taskId=Number(db.prepare('INSERT INTO vt_task_links(pms_task_id,customer_id,registration_id,reminder_at,priority,remarks,created_by,updated_by) VALUES(?,?,?,?,?,?,?,?)').run(sourceId,customerId,registrationId,reminder(data.reminder_at),data.priority||'normal',remarks,user.id,user.id).lastInsertRowid);
    const row=taskDetail(db,taskId);event(db,user,taskId,null,row,'created');return row;
  })();
}
function updateTask(db,id,data,user) {
  validateInput(data);
  return db.transaction(()=>{
    const before=taskDetail(db,id);requireOwner(user.scope,before.owner_id);
    if(Number(data.version)!==before.version)fail('Task changed. Reload before saving.',409);
    const link=db.prepare('SELECT * FROM vt_task_links WHERE id=?').get(id),p=link.daily_work_plan_id?db.prepare('SELECT * FROM daily_work_plans WHERE id=?').get(link.daily_work_plan_id):null;
    if(before.status==='completed')fail('Completed tasks cannot be edited',409);
    if(data.owner_id&&Number(data.owner_id)!==before.owner_id)fail('Reassign this task through PMS Tasks to preserve planning history',400);
    for(const field of ['customer_id','registration_id'])if(Object.hasOwn(data,field)&&(data[field]==null||data[field]===''?null:Number(data[field]))!==(before[field]??null))fail('Task client and registration links cannot change after creation',400);
    const state={not_started:'planned',in_progress:'running',pending:'paused',blocked:'blocked',completed:'completed'}[data.status];
    if(data.status&&!state)fail('Invalid task state',400);
    if(data.status==='completed'&&user.role!=='admin'&&!user.permissions?.vendor_treds_dashboard?.can_approve)fail('Task approval permission required');
    const remarks=data.remarks==null?before.remarks:text(data.remarks,'Remarks',5000);
    const title=data.title===undefined?before.title:text(data.title,'Task',1000,true);
    if(data.status==='blocked'&&!remarks.trim())fail('Describe the blocker',400);
    if(data.due_date&&!validDate(data.due_date))fail('Choose a valid due date',400);
    if(p&&data.status==='in_progress'&&db.prepare("SELECT id FROM daily_work_plans WHERE user_id=? AND state='running' AND id<>?").get(before.owner_id,p.id))fail('Pause the owner’s running task first',409);
    if(p)db.prepare('UPDATE daily_work_plans SET state=?,instructions=?,blocker=?,work_date=?,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(state||p.state,remarks,data.status==='blocked'?remarks:null,data.due_date||p.work_date,p.id);
    const sourceId=link.pms_task_id||p.source_id;
    db.prepare('UPDATE pms_tasks SET title=?,due_date=?,description=? WHERE id=?').run(title,data.due_date||before.due_date,remarks,sourceId);
    if(data.status==='completed')db.prepare("UPDATE pms_tasks SET status='approved',reviewed_at=CURRENT_TIMESTAMP,reviewer_id=? WHERE id=?").run(user.id,sourceId);
    db.prepare('UPDATE vt_task_links SET reminder_at=?,planning_state=?,remarks=?,priority=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(data.reminder_at===undefined?link.reminder_at:reminder(data.reminder_at),state||link.planning_state,remarks,data.priority||link.priority,user.id,id);
    const after=taskDetail(db,id);event(db,user,id,before,after,data.status?'status_changed':'updated');return after;
  })();
}
module.exports={DEFINITION,listTasks,taskDetail,createTask,updateTask};
