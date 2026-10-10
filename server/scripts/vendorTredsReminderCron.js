const {getDb}=require('../db/schema');
const {getConfig}=require('../lib/vendorTreds/kpis');
const {MODULES,permissions,allowed}=require('../lib/vendorTreds/access');
const {isoDate}=require('../lib/vendorTreds/queries');
const tabs={registrations:'registrations',approvals:'approvals',enquiries:'enquiries',accounts:'treds',mappings:'treds',invoices:'invoices',funding:'discounting',tasks:'dashboard'};
function today(){return new Date(Date.now()+19800000).toISOString().slice(0,10);}
function scan(db,asOf=today(),emit=()=>{},options={}) {
  if(!isoDate(asOf)){const error=new Error('Invalid reminder scan date');error.status=400;throw error;}
  const config=getConfig(db,asOf),rules=config.reminders||{};
  if(rules.enabled===false)return {created:0};
  const lead=Number(rules.expiry_lead_days??7),age=Number(rules.pending_after_days??2),repeat=Math.max(1,Number(rules.repeat_days??1));
  const bucket=Math.floor(Date.parse(asOf)/86400000/repeat),due=[];
  const instant=options.now||new Date(asOf+'T23:59:59.999+05:30').toISOString();
  if(!Number.isFinite(Date.parse(instant))){const error=new Error('Invalid reminder scan time');error.status=400;throw error;}
  const append=(kind,title,sql,params=[])=>{for(const r of db.prepare(sql).all(...params))due.push({...r,kind,title});};
  append('registrations','Registration pending',`SELECT id,owner_id,status trigger FROM vt_registrations WHERE status IN ('not_started','started','submitted','invite_only') AND date(registration_date)<=date(?,'-'||?||' days')`,[asOf,age]);
  append('registrations','Registration documents pending',`SELECT r.id,r.owner_id,r.status trigger FROM vt_registrations r WHERE r.status='docs_pending' OR EXISTS (SELECT 1 FROM vt_catalog c WHERE c.kind='doc_type' AND c.active=1 AND c.required=1 AND NOT EXISTS (SELECT 1 FROM vt_documents d WHERE d.registration_id=r.id AND d.type_id=c.id AND d.status IN ('uploaded','verified') AND (d.expiry_date IS NULL OR d.expiry_date>=?)))`,[asOf]);
  append('registrations','Document expiry approaching',`SELECT r.id,r.owner_id,d.id||':'||d.expiry_date trigger FROM vt_documents d JOIN vt_registrations r ON r.id=d.registration_id WHERE d.status IN ('uploaded','verified') AND d.expiry_date<=date(?,'+'||?||' days')`,[asOf,lead]);
  append('registrations','Registration follow-up due',`SELECT id,owner_id,next_followup_at trigger FROM vt_registrations WHERE next_followup_at IS NOT NULL AND date(next_followup_at,'+5 hours','+30 minutes')<=? AND status NOT IN ('rejected','po_received')`,[asOf]);
  append('approvals','Vendor approval pending',`SELECT id,owner_id,status trigger FROM vt_approvals WHERE status IN ('pending','docs_pending','under_review') AND date(application_date)<=date(?,'-'||?||' days')`,[asOf,age]);
  append('approvals','Vendor approval expiring',`SELECT id,owner_id,valid_until trigger FROM vt_approvals WHERE status='approved' AND valid_until IS NOT NULL AND valid_until<=date(?,'+'||?||' days')`,[asOf,lead]);
  append('enquiries','Enquiry follow-up due',`SELECT id,owner_id,next_followup_at trigger FROM vt_enquiries WHERE status NOT IN ('po_received','lost','rejected','closed') AND date(next_followup_at,'+5 hours','+30 minutes')<=?`,[asOf]);
  append('enquiries','RFQ deadline approaching',`SELECT id,owner_id,due_date trigger FROM vt_enquiries WHERE status IN ('enquiry_received','rfq_received','quote_preparing') AND due_date IS NOT NULL AND due_date<=date(?,'+'||?||' days')`,[asOf,lead]);
  append('accounts','TReDS registration or account needs attention',`SELECT id,owner_id,status||':'||account_status trigger FROM vt_accounts WHERE status IN ('registration_started','pending_verification','frozen','inactive') AND date(COALESCE(registration_date,created_at))<=date(?,'-'||?||' days')`,[asOf,age]);
  append('mappings','AP team follow-up due',`SELECT id,owner_id,next_followup_at trigger FROM vt_mappings WHERE date(next_followup_at,'+5 hours','+30 minutes')<=?`,[asOf]);
  append('invoices','Invoice awaiting client acceptance',`SELECT id,owner_id,status trigger FROM vt_invoices WHERE status='uploaded' AND date(uploaded_at,'+5 hours','+30 minutes')<=date(?,'-'||?||' days')`,[asOf,age]);
  append('invoices','Invoice awaiting bid',`SELECT id,owner_id,status trigger FROM vt_invoices WHERE status='accepted' AND date(accepted_at,'+5 hours','+30 minutes')<=date(?,'-'||?||' days')`,[asOf,age]);
  append('funding','Funding pending',`SELECT f.id,f.owner_id,f.status trigger FROM vt_funding f JOIN vt_invoices i ON i.id=f.invoice_id WHERE f.status IN ('bid_received','funding_approved') AND date(CASE WHEN f.status='funding_approved' THEN COALESCE(f.approved_at,f.created_at) ELSE COALESCE(i.bid_at,f.created_at) END,'+5 hours','+30 minutes')<=date(?,'-'||?||' days')`,[asOf,age]);
  append('funding','Payment reconciliation pending',`SELECT id,owner_id,status trigger FROM vt_funding WHERE status='funded' AND (expected_settlement IS NULL OR expected_settlement<=?)`,[asOf]);
  append('tasks','Vendor & TReDS task reminder',`SELECT l.id,t.assigned_to owner_id,l.reminder_at trigger FROM vt_task_links l LEFT JOIN daily_work_plans p ON p.id=l.daily_work_plan_id JOIN pms_tasks t ON t.id=COALESCE(l.pms_task_id,p.source_id) WHERE t.status<>'approved' AND l.reminder_at IS NOT NULL AND julianday(l.reminder_at)<=julianday(?)`,[instant]);
  const users=db.prepare('SELECT id,role FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0').all();
  // Read merged grants once for the whole scan, rather than once per employee.
  const rows=db.prepare(`SELECT ur.user_id,rp.module,MAX(rp.can_view) can_view,MAX(rp.can_create) can_create,
    MAX(rp.can_edit) can_edit,MAX(rp.can_delete) can_delete,MAX(rp.can_approve) can_approve,MAX(rp.can_see_all) can_see_all
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id GROUP BY ur.user_id,rp.module`).all();
  const grants=new Map(users.map(u=>[u.id,u.role==='admin'?permissions(db,u):{}])),created=[];
  const administrators=new Set(users.filter(u=>u.role==='admin').map(u=>u.id));
  for(const row of rows){const grant=grants.get(row.user_id);if(grant&&!administrators.has(row.user_id)&&Object.values(MODULES).includes(row.module))grant[row.module]=row;}
  const insertKey=db.prepare('INSERT OR IGNORE INTO vt_reminder_keys(user_id,key) VALUES(?,?)');
  const insert=db.prepare("INSERT INTO notifications(user_id,type,title,body,link_url,channel_sent,dedupe_key) VALUES(?,'vendor_treds_reminder',?,?,?,'in_app',?)");
  db.transaction(()=>{
    for(const r of due){
      if(!grants.has(r.owner_id)||!allowed(grants.get(r.owner_id),r.kind))continue;
      const key=`vt:${r.kind}:${r.id}:${r.title}:${r.trigger}:${bucket}`;
      if(!insertKey.run(r.owner_id,key).changes)continue;
      const link=`/vendor-treds?tab=${tabs[r.kind]}&sub=${r.kind}&record=${r.id}`;
      const id=Number(insert.run(r.owner_id,r.title,'Open the record to review the pending action.',link,key).lastInsertRowid);
      created.push({id,user_id:r.owner_id,type:'vendor_treds_reminder',title:r.title,link_url:link});
    }
  })();
  for(const n of created)emit(n);
  return {created:created.length};
}
function schedule() {
  if(process.env.ERP_DISABLE_VENDOR_TREDS_REMINDERS==='1'||['test','preview'].includes(process.env.NODE_ENV))return;
  let lastRun=0;
  const run=()=>{try{
    const db=getDb(),config=getConfig(db),minutes=config.reminders.scan_minutes;
    if(Date.now()-lastRun<minutes*60000)return;
    lastRun=Date.now();
    scan(db,today(),n=>require('../lib/chatSocket').getIO()?.to(`u:${n.user_id}`).emit('notification:new',n),{now:new Date().toISOString()});
  }catch(e){console.warn('[vendor-treds] reminder scan failed:',e.message);}};
  // Re-read effective settings each minute so changed scan rules apply without a restart.
  const start=setTimeout(run,10000);start.unref();
  const timer=setInterval(run,60000);timer.unref();
  return {start,timer};
}
module.exports={scan,schedule};
