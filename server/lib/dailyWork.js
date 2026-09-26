const { ROSTERS, normalizeRoster } = require('./roster');
const { expectedOn, absenceSet } = require('./checklistFrequency');

const SOURCES = ['delegations', 'pms_tasks', 'checklists'];
const PRIORITIES = ['urgent', 'high', 'normal', 'low'];
const json = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e; };
const dateOk = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s).toISOString().slice(0, 10) === s;
const addDay = (s, n) => new Date(Date.parse(s + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);
const completedDate = value => {
  if(!value)return null;
  const iso=String(value).replace(' ','T');
  const at=Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso)?iso:`${iso}Z`);
  return Number.isNaN(at)?null:new Date(at+19800000).toISOString().slice(0,10);
};
const minutes = t => { if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(t || '')) fail('Use a valid HH:MM time'); return +t.slice(0, 2) * 60 + +t.slice(3); };
const hasTable = (db, table) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
function permission(db, user, module, action) {
  if (user.role === 'admin') return true;
  const field = { view: 'can_view', approve: 'can_approve' }[action];
  if (!field) return false;
  return !!db.prepare(`SELECT MAX(rp.${field}) AS allowed FROM role_permissions rp JOIN user_roles ur ON ur.role_id=rp.role_id WHERE ur.user_id=? AND rp.module=?`).get(user.id, module)?.allowed;
}
function canApprove(db, user, source, row) {
  if (user.role === 'admin') return true;
  if (source === 'checklists') return false; // Existing HR endpoint is admin-only.
  if (source === 'delegations') return permission(db, user, source, 'approve') || permission(db, user, 'pms_tasks', 'approve');
  return permission(db, user, source, 'approve') || row.assigned_by === user.id ||
    (!!row.crm_name && String(row.crm_name).trim().toLowerCase().split(/\s+/)[0] === String(user.name || '').trim().toLowerCase().split(/\s+/)[0]);
}
function approvalCandidates(db) {
  return db.prepare(`SELECT u.id,u.name,u.role,
    MAX(CASE WHEN rp.module='delegations' THEN rp.can_approve ELSE 0 END) AS delegations,
    MAX(CASE WHEN rp.module='pms_tasks' THEN rp.can_approve ELSE 0 END) AS pms_tasks
    FROM users u LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN role_permissions rp ON rp.role_id=ur.role_id
    WHERE COALESCE(u.active,1)=1 AND COALESCE(u.archived,0)=0 GROUP BY u.id`).all();
}
function approvers(db,source,row,extension=false,candidates=approvalCandidates(db)) {
  return candidates.filter(u=> {
    if(u.role==='admin')return true;
    if(source==='checklists' || (extension && source==='pms_tasks'))return false;
    if(source==='delegations')return u.delegations || u.pms_tasks;
    return u.pms_tasks || row.assigned_by===u.id || (!!row.crm_name && String(row.crm_name).trim().toLowerCase().split(/\s+/)[0]===String(u.name || '').trim().toLowerCase().split(/\s+/)[0]);
  });
}
function visibleSource(db, viewer, ownerId, source) {
  if (viewer.id === ownerId || viewer.role === 'admin') return true;
  return permission(db, viewer, source, 'view') || permission(db, viewer, source, 'approve') || (source === 'delegations' && permission(db, viewer, 'pms_tasks', 'approve'));
}
function owner(db, viewer, id) {
  const u = db.prepare('SELECT id, name, role, manager_id FROM users WHERE id=? AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0').get(id);
  if (!u) fail('User not found', 404);
  if (viewer.id !== u.id && viewer.role !== 'admin' && u.manager_id !== viewer.id) fail('Only your own work or direct reports are available', 403);
  return u;
}
function sourceTask(db, source, id, userId, occurrence) {
  if (!SOURCES.includes(source) || !Number.isSafeInteger(id) || id <= 0) fail('Invalid task');
  const t = db.prepare(`SELECT * FROM ${source} WHERE id=?`).get(id);
  if (!t || (t.assigned_to !== userId && !(source === 'checklists' && t.assigned_to == null))) fail('Assigned task not found', 404);
  if (source === 'checklists') {
    if (!dateOk(occurrence)) fail('Checklist occurrence date required');
    const c = db.prepare('SELECT * FROM checklist_completions WHERE checklist_id=? AND user_id=? AND completion_date=?').get(id, userId, occurrence);
    t.status = c ? (c.approval_status === 'approved' ? 'approved' : c.approval_status === 'rejected' ? 'rejected' : 'submitted') : 'pending';
    t.completion_id = c?.id; t.proof_url = c?.proof_url; t.reject_reason = c?.approval_note;
    t.completed_on = c?.approval_status==='approved' ? completedDate(c.approved_at):null;
    t.due_date = occurrence;
  } else if (occurrence) fail('Only recurring checklists have occurrence dates');
  return t;
}
function event(db, actor, userId, source, sourceId, occurrence, action, reason, before, after) {
  db.prepare('INSERT INTO daily_work_events(user_id,actor_id,source,source_id,occurrence,action,reason,before_json,after_json) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(userId, actor.id, source || null, sourceId || null, occurrence || '', action, reason, before == null ? null : JSON.stringify(before), after == null ? null : JSON.stringify(after));
}
function validateSchedule(config) {
  if (!config || !Array.isArray(config.weekdays) || !config.weekdays.length || config.weekdays.some(x => !Number.isInteger(x) || x < 0 || x > 6)) fail('Choose working weekdays');
  const start = minutes(config.start), end = minutes(config.end);
  if (start === end) fail('Shift start and end must differ');
  const breaks = config.breaks || [];
  if (!Array.isArray(breaks) || breaks.length > 8) fail('Use at most eight breaks');
  const finish = end <= start ? end + 1440 : end;
  const spans = breaks.map(b => {
    let a = minutes(b.start), z = minutes(b.end);
    if (a < start && finish > 1440) a += 1440;
    if (z <= a % 1440 && finish > 1440) z += 1440;
    else if (z < start && finish > 1440) z += 1440;
    if (a < start || z > finish || z <= a) fail('Breaks must be inside the shift');
    return [a, z];
  }).sort((a,b) => a[0]-b[0]);
  if (spans.some((s,i) => i && s[0] < spans[i-1][1])) fail('Breaks cannot overlap');
  return { start: config.start, end: config.end, weekdays: [...new Set(config.weekdays)], breaks: breaks.map(b => ({ start: b.start, end: b.end })) };
}
function subtract(spans, a, b) {
  return spans.flatMap(([x,y]) => b <= x || a >= y ? [[x,y]] : [[x, Math.max(x,a)], [Math.min(y,b),y]].filter(([s,e]) => e>s));
}
function schedule(db, userId, date) {
  const employee = db.prepare("SELECT roster FROM employees WHERE user_id=? AND status IN ('active','training') ORDER BY id DESC LIMIT 1").get(userId);
  const saved = db.prepare('SELECT config FROM daily_work_schedules WHERE user_id=?').get(userId);
  const roster = ROSTERS[normalizeRoster(employee?.roster)];
  const config = saved ? json(saved.config, null) : { start: roster.start, end: roster.end, weekdays: [1,2,3,4,5,6], breaks: [] };
  validateSchedule(config);
  const start = minutes(config.start), clockEnd = minutes(config.end), end = clockEnd <= start ? clockEnd + 1440 : clockEnd;
  const reasons = [], unavailable = [];
  let spans = [[start,end]];
  if (!config.weekdays.includes(new Date(date + 'T00:00:00Z').getUTCDay())) { spans = []; reasons.push('Weekly day off'); }
  for (const b of config.breaks) {
    let a = minutes(b.start), z = minutes(b.end);
    if (a < start && end > 1440) a += 1440;
    if (z <= a % 1440 && end > 1440) z += 1440;
    else if (z < start && end > 1440) z += 1440;
    spans = subtract(spans,a,z);
  }
  for (let offset = 0; offset <= (end > 1440 ? 1 : 0); offset++) {
    const day = addDay(date, offset), base = offset * 1440;
    const holiday = hasTable(db, 'payroll_holidays') ? db.prepare('SELECT name FROM payroll_holidays WHERE date=?').get(day) : null;
    const att = db.prepare('SELECT status, punch_in_time, punch_out_time FROM attendance WHERE user_id=? AND date=?').get(userId,day);
    if (holiday || ['absent','leave','holiday'].includes(att?.status)) {
      spans = subtract(spans,base,base+1440); reasons.push(holiday ? `Holiday: ${holiday.name}` : `Attendance: ${att.status}`);
    }
    const leaves = db.prepare("SELECT leave_type,from_time,to_time FROM leave_requests WHERE user_id=? AND status='approved' AND from_date<=? AND to_date>=?").all(userId,day,day);
    for (const l of leaves) {
      const timed = l.from_time && l.to_time;
      if (timed) {
        let a = minutes(l.from_time), z = minutes(l.to_time);
        if (z <= a) z += 1440;
        spans = subtract(spans,base+a,base+z);
        unavailable.push({ type:l.leave_type, start:l.from_time, end:l.to_time, date:day });
      } else { spans = subtract(spans,base,base+1440); reasons.push(l.leave_type === 'half_day' ? 'Half-day leave: confirm available hours with manager' : 'Approved leave'); }
    }
  }
  const attendance = db.prepare('SELECT status,punch_in_time,punch_out_time FROM attendance WHERE user_id=? AND date=?').get(userId,date) || null;
  return { config, origin: saved ? 'Personal schedule' : employee ? `Employee roster: ${roster.key}` : 'Default roster — confirm schedule', timezone:'Asia/Kolkata', spans, reasons, unavailable, attendance, capacity_minutes: spans.reduce((n,[a,b]) => n+b-a,0) };
}
function unpack(p) { return p ? { ...p, steps:json(p.steps,[]), dependencies:json(p.dependencies,[]), documents:json(p.documents,[]) } : null; }
function tasks(db, viewer, userId, date) {
  const plans = db.prepare('SELECT * FROM daily_work_plans WHERE user_id=?').all(userId).map(unpack);
  const map = new Map(plans.map(p => [`${p.source}:${p.source_id}:${p.occurrence}`,p]));
  const availability = schedule(db,userId,date);
  const out = [];
  const candidates=approvalCandidates(db);
  // Planning uses explicit attendance/approved leave. Do not infer absence at
  // a hard-coded roster end: a personal or overnight schedule may still be open.
  const away = absenceSet(db,[date],{inferNoPunch:false});
  for (const source of SOURCES) {
    if (!visibleSource(db,viewer,userId,source)) continue;
    let rows;
    if (source === 'checklists') {
      const assigned = db.prepare("SELECT * FROM checklists WHERE (assigned_to=? OR assigned_to IS NULL) AND (status IS NULL OR status IN ('pending','active',''))").all(userId);
      rows = [];
      for (const t of assigned) {
        const dates = new Set();
        if ((availability.capacity_minutes > 0 && expectedOn({...t, assigned_to:userId},date,away)) || map.has(`${source}:${t.id}:${date}`)) dates.add(date);
        // Pending prior occurrences remain reviewable, without inventing or
        // carrying forward a new checklist occurrence.
        for (const c of db.prepare("SELECT completion_date FROM checklist_completions WHERE checklist_id=? AND user_id=? AND completion_date<=? AND (COALESCE(approval_status,'pending')<>'approved' OR completion_date=?)").all(t.id,userId,date,date)) dates.add(c.completion_date);
        for (const p of plans) if(p.source===source && p.source_id===t.id && p.work_date<=date) dates.add(p.occurrence);
        for(const occurrence of dates) rows.push({...sourceTask(db,source,t.id,userId,occurrence),occurrence});
      }
    } else {
      rows = db.prepare(`SELECT * FROM ${source} WHERE assigned_to=? AND (status<>'approved' OR date(reviewed_at,'+5 hours','+30 minutes')=? OR id IN (SELECT source_id FROM daily_work_plans WHERE user_id=? AND source=? AND work_date=?))`).all(userId,date,userId,source,date);
    }
    for (const t of rows) {
      const occurrence = source === 'checklists' ? t.occurrence : '';
      const plan = map.get(`${source}:${t.id}:${occurrence}`) || null;
      const assignee = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
      const assigner = db.prepare('SELECT name FROM users WHERE id=?').get(t.assigned_by || t.created_by || null);
      const deps = (plan?.dependencies || []).map(d => {
        if (!visibleSource(db,viewer,userId,d.source)) return {...d,title:'Dependency details require module access',complete:false};
        try { const row = sourceTask(db,d.source,d.id,userId,d.occurrence || ''); return {...d, title:row.title, complete:row.status==='approved'}; }
        catch { return {...d,title:'Dependency no longer available',complete:false}; }
      });
      if (source==='checklists' && t.status==='approved' && occurrence!==date) continue;
      const status = t.status === 'approved' ? 'approved' : t.status === 'submitted' ? 'submitted' : (plan?.state || 'planned');
      out.push({ key:`${source}:${t.id}:${occurrence}`, source, id:t.id, occurrence, title:t.title, description:t.description,
        assigned_to:userId, assignee_name:assignee?.name, assigner_name:assigner?.name,
        approver:approvers(db,source,t,false,candidates).map(u=>u.name).join(' · ') || 'No active approver configured — contact an administrator',
        due_date:t.due_date, completed_on:t.completed_on || (t.status==='approved'?completedDate(t.reviewed_at):null), source_status:t.status, status, proof_url:t.proof_url, proof_type:source==='checklists' ? (t.proof_type || 'photo') : 'file',
        attachment_url:t.attachment_url, reject_reason:t.reject_reason, completion_id:t.completion_id,
        extension_status:t.extension_status, requested_due_date:t.requested_due_date, extension_reason:t.extension_reason,
        can_approve:canApprove(db,viewer,source,t), can_extend:source!=='checklists' && t.status!=='approved',
        can_approve_extension:viewer.role==='admin' || (source==='delegations' && canApprove(db,viewer,source,t)),
        path:source==='pms_tasks' ? '/pms-tasks' : source==='checklists' ? '/checklists' : '/delegations',
        plan, dependencies:deps, scheduled:plan?.work_date===date,
        overdue:t.status!=='approved' && !!t.due_date && t.due_date < date,
        schedule_conflict:plan?.work_date===date && !availability.spans.some(([a,b])=>plan.start_minute>=a && plan.start_minute+plan.duration<=b),
      });
    }
  }
  out.sort((a,b) => (a.scheduled ? 0:1)-(b.scheduled ? 0:1) || (a.plan?.start_minute ?? 9999)-(b.plan?.start_minute ?? 9999) || PRIORITIES.indexOf(a.plan?.priority || 'normal')-PRIORITIES.indexOf(b.plan?.priority || 'normal') || (a.due_date || '9999').localeCompare(b.due_date || '9999'));
  const today = out.filter(t => t.scheduled || t.due_date===date || t.completed_on===date || t.overdue || t.source_status==='submitted');
  const counts = { completed:today.filter(t=>t.status==='approved').length, remaining:today.filter(t=>!['approved','submitted'].includes(t.status)).length,
    overdue:today.filter(t=>t.overdue).length, blocked:today.filter(t=>t.status==='blocked' || t.dependencies.some(d=>!d.complete)).length, awaiting_approval:today.filter(t=>t.status==='submitted').length };
  return { tasks:out, schedule:availability, counts, planned_minutes:out.filter(t=>t.scheduled).reduce((n,t)=>n+t.plan.duration,0) };
}
module.exports = { SOURCES, PRIORITIES, json, fail, dateOk, addDay, minutes, permission, canApprove, approvers, visibleSource, owner, sourceTask, event, validateSchedule, schedule, unpack, tasks };
