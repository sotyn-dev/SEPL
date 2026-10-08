const express=require('express');
const multer=require('multer');
const {getDb}=require('../db/schema');
const {authMiddleware}=require('../middleware/auth');
const {logAuditEvent}=require('../middleware/audit');
const access=require('../lib/vendorTreds/access');
const {ENTITY_DEFS,STATUS_LABELS,normalizeKind}=require('../lib/vendorTreds/model');
const service=require('../lib/vendorTreds/service');
const queries=require('../lib/vendorTreds/queries');
const kpis=require('../lib/vendorTreds/kpis');
const reports=require('../lib/vendorTreds/reports');
const docs=require('../lib/vendorTreds/documents');
const tasks=require('../lib/vendorTreds/tasks');
const storage=require('../lib/storage');
function createRouter({dbProvider=getDb,authenticate=authMiddleware,auditEvent=logAuditEvent}={}) {
const router=express.Router();
const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:docs.MAX_BYTES,files:1}}).single('file');
const wrap=fn=>(req,res,next)=>Promise.resolve().then(()=>fn(req,res)).catch(e=>{
  if(e.status||e.code==='LIMIT_FILE_SIZE') return res.status(e.status||400).json({error:e.message,code:e.code,existing:e.existing,candidates:e.candidates?.map(({id,customer_code,company_name,website_url,matches})=>({id,customer_code,company_name,website_url,matches})),details:e.details,fields:e.fields});
  next(e);
});
router.use(authenticate);
router.use((req,res,next)=>{
  try { const db=dbProvider();req.vt={db,permissions:access.permissions(db,req.user)}; next(); } catch(e) {next(e);}
});
function guard(req,kind,action='view') {
  access.requireAccess(req.vt.permissions,kind,action);
  return access.scopeFor(req.vt.db,req.user,req.vt.permissions,kind);
}
function entity(req) {
  const kind=normalizeKind(req.params.kind);
  if(!ENTITY_DEFS[kind]||kind==='documents') access.fail('Page not found',404);
  return kind;
}
function record(req,kind,id=req.params.id) {
  const n=Number(id); if(!Number.isSafeInteger(n)||n<1) access.fail('Record not found',404);
  const row=req.vt.db.prepare(`SELECT * FROM ${ENTITY_DEFS[kind].table} WHERE id=?`).get(n);
  if(!row) access.fail('Record not found',404);
  if(kind!=='catalog') access.requireOwner(guard(req,kind),row.owner_id);
  return row;
}
function filters(query) {
  return {...query,search:query.search??query.q,customer_id:query.customer_id??query.client_id};
}
function actor(req,scope) {return {...req.user,scope,permissions:req.vt.permissions};}
function scopes(req) {
  return Object.fromEntries(['registrations','approvals','enquiries','accounts','mappings','invoices','funding','followups','tasks'].map(k=>[k,access.allowed(req.vt.permissions,k)?guard(req,k):{ownerIds:[]}]));
}
function audit(req,kind,before,after,action='EDIT') {
  auditEvent({user:req.user,action,entity_type:`vendor_treds_${kind}`,entity_id:after.id,before,after});
}
function canReadClientProfile(req,id) {
  if(req.user.role==='admin'||req.vt.permissions.customers?.can_see_all) return true;
  const scope=guard(req,'registrations');
  const params=[Number(id)];
  let owners='';
  if(scope.ownerIds!==null){owners=` AND owner_id IN (${scope.ownerIds.map(()=>'?').join(',')||'NULL'})`;params.push(...scope.ownerIds);}
  return !!req.vt.db.prepare(`SELECT 1 FROM vt_registrations WHERE customer_id=?${owners} LIMIT 1`).get(...params);
}
function validateClientChanges(req,data) {
  if(!data.customer_id||req.user.role==='admin'||req.vt.permissions.customers?.can_edit||canReadClientProfile(req,data.customer_id)) return;
  // A new registration may enrich missing master fields, but cannot overwrite
  // another team's existing client profile merely by selecting its identity.
  const profile=service.customerProfile(req.vt.db,Number(data.customer_id));
  for(const field of ENTITY_DEFS.registrations.fields.filter(f=>f.virtual)) {
    const key=field.key;
    if(Object.hasOwn(data,key)&&profile[key]!=null&&String(profile[key]).trim()&&String(data[key]??'').trim()!==String(profile[key]).trim()) {
      access.fail('Existing client profile changes require an assigned registration or Customer edit permission');
    }
  }
}
function validateReferences(req,kind,data,scope) {
  if(kind==='registrations')validateClientChanges(req,data);
  if(data.owner_id!=null) access.requireOwner(scope,data.owner_id);
  const refs={registration_id:'registrations',enquiry_id:'enquiries',mapping_id:'mappings',invoice_id:'invoices',account_id:'accounts',contact_id:'contacts'};
  for(const [field,parentKind] of Object.entries(refs)) if(data[field]!=null&&data[field]!=='') record(req,parentKind,data[field]);
  if(data.collection_id!=null&&data.collection_id!=='') {
    if(req.user.role!=='admin'&&!req.vt.permissions.collections?.can_view) access.fail('Collections permission is required to reference an accounting receipt');
    const receipt=req.vt.db.prepare('SELECT * FROM collections WHERE id=?').get(Number(data.collection_id));
    if(!receipt) access.fail('Accounting receipt not found',400);
    if(req.user.role!=='admin'&&!req.vt.permissions.collections?.can_see_all) {
      const ar=req.vt.db.prepare('SELECT owner_id FROM receivables WHERE id=?').get(receipt.receivable_id);
      if(ar?.owner_id!==req.user.id) access.fail('Receipt is outside your assigned collection scope');
    }
  }
  if(data.bank_transaction_id!=null&&data.bank_transaction_id!=='') {
    if(req.user.role!=='admin'&&!req.vt.permissions.cashflow?.can_view) access.fail('Cashflow permission is required to reference a bank transaction');
    if(!req.vt.db.prepare('SELECT id FROM bank_transactions WHERE id=?').get(Number(data.bank_transaction_id))) access.fail('Bank transaction not found',400);
  }
}
function statusAction(kind,status) {
  if(kind==='approvals'&&['approved','rejected','expired'].includes(status)) return 'approve';
  if(kind==='registrations'&&['approved','rejected'].includes(status)) return 'approve';
  if(kind==='invoices'&&['accepted','bid_received','rejected','cancelled'].includes(status)) return 'approve';
  if(kind==='funding'&&['funding_approved','funded','reconciled','closed'].includes(status)) return 'approve';
  if(kind==='accounts'&&['active','frozen','inactive'].includes(status)) return 'approve';
  return 'edit';
}
router.get('/options',wrap((req,res)=>{
  if(!Object.keys(access.MODULES).some(k=>access.allowed(req.vt.permissions,k))) access.fail('Vendor & TReDS permission required');
  const defs={...ENTITY_DEFS,tasks:tasks.DEFINITION,history:{label:'Tracker Events',permission:'vendor_treds_dashboard',readOnly:true,fields:[{key:'entity_type',label:'Entity',type:'text'},{key:'entity_id',label:'Record',type:'number'},{key:'event',label:'Event',type:'text'},{key:'actor_name',label:'Recorded By',type:'text'},{key:'event_date',label:'Business Date',type:'date'},{key:'changed_at',label:'Recorded At',type:'datetime'},{key:'same_day',label:'Same Day',type:'boolean'}]}}; delete defs.documents;
  res.json({catalog:req.vt.db.prepare('SELECT id,kind,code,label,required,active,version FROM vt_catalog WHERE active=1 ORDER BY kind,label').all(),
    entity_defs:defs,status_labels:STATUS_LABELS,permissions:req.vt.permissions,
    capabilities:Object.fromEntries(Object.keys(defs).map(k=>[k,Object.fromEntries(access.ACTIONS.map(a=>[a,access.allowed(req.vt.permissions,k,a)]))])),reports:reports.REPORT_CATALOG});
}));
router.get('/dashboard',wrap((req,res)=>{
  guard(req,'dashboard');
  const data=kpis.getDashboard(req.vt.db,filters(req.query),guard(req,'dashboard'),{scopes:scopes(req)});
  res.json(data);
}));
router.get('/weekly-kpis',wrap((req,res)=>{
  guard(req,'dashboard'); res.json(kpis.getWeeklyKpis(req.vt.db,filters(req.query),guard(req,'dashboard'),{scopes:scopes(req)}));
}));
router.get('/history',wrap((req,res)=>{
  guard(req,'dashboard');res.json(kpis.listTrackerEvents(req.vt.db,filters(req.query),guard(req,'dashboard'),{scopes:scopes(req)}));
}));
router.get('/settings',wrap((req,res)=>{
  guard(req,'settings');
  const row=req.vt.db.prepare("SELECT value FROM app_settings WHERE key='vendor_treds_settings'").get();
  const envelope=row?JSON.parse(row.value):kpis.getDefaultConfig();
  const effective=kpis.getConfig(req.vt.db,req.query.as_of,req.query.owner_id);
  const ids=[...new Set((envelope.versions||[]).flatMap(v=>[...(v.responsible_owner_ids||[]),...Object.keys(v.owner_overrides||{})]).map(Number))];
  const owner_names=[];
  for(let start=0;start<ids.length;start+=500){const chunk=ids.slice(start,start+500);owner_names.push(...req.vt.db.prepare(`SELECT id,name FROM users WHERE id IN (${chunk.map(()=>'?').join(',')}) ORDER BY name,id`).all(...chunk));}
  res.json({...envelope,record:effective,effective,owner_names});
}));
router.patch('/settings',wrap((req,res)=>{
  guard(req,'settings','edit');
  if(req.body.responsible_owner_ids!=null&&!Array.isArray(req.body.responsible_owner_ids))access.fail('Choose target owners from the employee list',400);
  if(req.body.owner_overrides!=null&&(typeof req.body.owner_overrides!=='object'||Array.isArray(req.body.owner_overrides)))access.fail('Owner overrides must contain per-employee targets',400);
  const owners=[...new Set([...(req.body.responsible_owner_ids||[]),...Object.keys(req.body.owner_overrides||{})].map(Number))];
  if(owners.some(id=>!Number.isSafeInteger(id)||id<1))access.fail('Target owners must be active ERP users',400);
  for(let start=0;start<owners.length;start+=500){const chunk=owners.slice(start,start+500);if(req.vt.db.prepare(`SELECT COUNT(*) n FROM users WHERE id IN (${chunk.map(()=>'?').join(',')}) AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0`).get(...chunk).n!==chunk.length)access.fail('Target owners must be active ERP users',400);}
  const saved=req.vt.db.transaction(()=>{
    const row=req.vt.db.prepare("SELECT value FROM app_settings WHERE key='vendor_treds_settings'").get();
    const before=row?JSON.parse(row.value):kpis.getDefaultConfig();
    const after=kpis.appendConfigVersion(before,req.body);
    req.vt.db.prepare("INSERT INTO app_settings(key,value) VALUES('vendor_treds_settings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(after));
    req.vt.db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,before_json,after_json,actor_id) VALUES(?,?,?,?,?,?)').run('settings',1,'settings_changed',JSON.stringify(before),JSON.stringify(after),req.user.id);
    return after;
  })(); res.json(saved);
}));
router.get('/reports/:report/export',wrap(async(req,res)=>{
  guard(req,'reports');
  const def=reports.REPORT_CATALOG[req.params.report]||reports.REPORT_CATALOG.find?.(r=>r.key===req.params.report||r.id===req.params.report);
  if(!def) access.fail('Report not found',404);
  const scope=guard(req,def.entity||def.kind||'dashboard');
  const result=reports.reportRows(req.vt.db,req.params.report,filters({...req.query,all:'1',limit:'10000'}),scope,{scopes:scopes(req)});
  if(result.total>10000) access.fail('Narrow the date range to export at most 10,000 records',413);
  res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition',`attachment; filename="vendor-treds-${req.params.report}.xlsx"`);
  res.send(await reports.exportXlsx(req.vt.db,req.params.report,filters(req.query),scope,{scopes:scopes(req)}));
}));
router.get('/reports/:report',wrap((req,res)=>{
  guard(req,'reports');
  const def=reports.REPORT_CATALOG[req.params.report]||reports.REPORT_CATALOG.find?.(r=>r.key===req.params.report||r.id===req.params.report);
  if(!def) access.fail('Report not found',404);
  const data=reports.reportRows(req.vt.db,req.params.report,filters(req.query),guard(req,def.entity||def.kind||'dashboard'),{scopes:scopes(req)});
  if(req.query.all==='1'&&data.total>10000) access.fail('Narrow the date range to print at most 10,000 records',413);
  res.json(data);
}));
router.get('/customers/:id/profile',wrap((req,res)=>{
  guard(req,'registrations');
  const profile=service.customerProfile(req.vt.db,Number(req.params.id));
  res.json(canReadClientProfile(req,req.params.id)?profile:{customer_id:profile.customer_id,customer_code:profile.customer_code,company_name:profile.company_name,website_url:profile.website_url});
}));
router.get('/lookups/:lookup',wrap((req,res)=>{
  const aliases={owner:'users',owners:'users',user:'users',customer:'customers',client:'customers',vendor:'vendors',sales_bill:'sales_bills',invoice:'invoices',registration:'registrations',enquiry:'enquiries',account:'accounts',mapping:'mappings',contact:'contacts',document:'documents',receivable:'receivables',collection:'collections',bank_transaction:'bank_transactions',document_type:'doc_type'};
  const kind=aliases[req.params.lookup]||req.params.lookup,q=String(req.query.q||req.query.search||'').slice(0,200),limit=Math.min(50,Math.max(1,Number(req.query.limit)||20)),page=Math.max(1,Number(req.query.page)||1);
  if(!Object.keys(access.MODULES).some(k=>access.allowed(req.vt.permissions,k))) access.fail('Module permission required');
  if(['platform','doc_type','sector','service'].includes(kind)) {
    const params=[kind,`%${q}%`];
    const total=req.vt.db.prepare('SELECT COUNT(*) n FROM vt_catalog WHERE kind=? AND active=1 AND label LIKE ?').get(...params).n;
    const rows=req.vt.db.prepare('SELECT id,label FROM vt_catalog WHERE kind=? AND active=1 AND label LIKE ? ORDER BY label,id LIMIT ? OFFSET ?').all(...params,limit,(page-1)*limit);
    return res.json({rows,total,page,limit});
  }
  if(ENTITY_DEFS[kind]&&kind!=='documents') {
    const rows=queries.listEntity(req.vt.db,kind,{search:q,page,limit},guard(req,kind));
    return res.json({...rows,rows:rows.rows.map(r=>({...r,label:r.customer_name||r.company_name||r.external_invoice_number||r.name||r.platform_label||r.platform_name||`${ENTITY_DEFS[kind].label} #${r.id}`}))});
  }
  if(kind==='documents') {
    const scope=guard(req,'registrations'),p=[`%${q}%`];let clause='';
    if(scope.ownerIds!==null){clause=` AND r.owner_id IN (${scope.ownerIds.map(()=>'?').join(',')||'NULL'})`;p.push(...scope.ownerIds);}
    const from=`FROM vt_documents d JOIN vt_registrations r ON r.id=d.registration_id WHERE d.filename LIKE ?${clause}`;
    return res.json({rows:req.vt.db.prepare(`SELECT d.id,d.filename label,d.registration_id ${from} ORDER BY d.id DESC LIMIT ? OFFSET ?`).all(...p,limit,(page-1)*limit),total:req.vt.db.prepare(`SELECT COUNT(*) n ${from}`).get(...p).n,page,limit});
  }
  const sql={customers:['customers','company_name','vendor_registrations'],vendors:['vendors','COALESCE(firm_name,name)','vendor_registrations'],users:['users','name','vendor_treds_dashboard'],crm_funnel:['crm_funnel',"COALESCE(lead_no,'')||' — '||client_name",'vendor_enquiries'],sales_bills:['sales_bills',"COALESCE(bill_number,'')||' — '||COALESCE(total_amount,0)",'treds_invoices'],receivables:['receivables',"COALESCE(invoice_number,'')||' — '||client_name",'bill_discounting'],collections:['collections',"'Receipt #'||id||' — '||amount",'bill_discounting'],bank_transactions:['bank_transactions',"COALESCE(txn_date,'')||' — '||COALESCE(ref_no,'')||' — '||credit",'bill_discounting']}[kind];
  if(!sql) access.fail('Lookup not found',404);
  const [table,label,module]=sql;
  const identity=['customers','vendors','users'].includes(kind);
  if(req.user.role!=='admin'&&!(identity?Object.keys(access.MODULES).some(k=>access.allowed(req.vt.permissions,k)):req.vt.permissions[module]?.can_view)) access.fail('Lookup permission required');
  if(kind==='bank_transactions'&&req.user.role!=='admin'&&!req.vt.permissions.cashflow?.can_view) access.fail('Cashflow permission is required for bank transactions');
  let where=`${label} LIKE ?`,p=[`%${q}%`];
  if(kind==='users') {
    const all=Object.keys(access.MODULES).some(k=>access.allowed(req.vt.permissions,k,'see_all'));
    if(!all&&req.user.role!=='admin'){where+=' AND (id=? OR manager_id=?)';p.push(req.user.id,req.user.id);} where+=' AND COALESCE(active,1)=1 AND COALESCE(archived,0)=0';
  }
  if(['sales_bills','crm_funnel','receivables','collections'].includes(kind)&&req.user.role!=='admin') {
    const source={sales_bills:'billing',crm_funnel:'crm_funnel',receivables:'collections',collections:'collections'}[kind];
    if(!req.vt.permissions[source]?.can_view) return res.json({rows:[],total:0,page,limit});
    if(!req.vt.permissions[source]?.can_see_all) {
      if(kind==='receivables'){where+=' AND owner_id=?';p.push(req.user.id);}
      else if(kind==='collections'){where+=' AND receivable_id IN (SELECT id FROM receivables WHERE owner_id=?)';p.push(req.user.id);}
      else if(kind==='sales_bills'){where+=' AND id IN (SELECT sales_bill_id FROM vt_invoices WHERE owner_id=?)';p.push(req.user.id);}
      else {where+=' AND id IN (SELECT crm_funnel_id FROM vt_enquiries WHERE owner_id=?)';p.push(req.user.id);}
    }
  }
  res.json({rows:req.vt.db.prepare(`SELECT id,${label} label FROM ${table} WHERE ${where} ORDER BY label,id LIMIT ? OFFSET ?`).all(...p,limit,(page-1)*limit),total:req.vt.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where}`).get(...p).n,page,limit});
}));
router.get('/tasks',wrap((req,res)=>res.json(tasks.listTasks(req.vt.db,filters(req.query),guard(req,'tasks')))));
router.post('/tasks',wrap((req,res)=>{
  const scope=guard(req,'tasks','create');validateReferences(req,'tasks',req.body,scope);
  res.status(201).json(tasks.createTask(req.vt.db,req.body,actor(req,scope)));
}));
router.get('/tasks/:id',wrap((req,res)=>{
  const scope=guard(req,'tasks'),row=tasks.taskDetail(req.vt.db,Number(req.params.id));access.requireOwner(scope,row.owner_id);
  res.json({record:row,history:req.vt.db.prepare('SELECT * FROM vt_history WHERE entity_type=\'tasks\' AND entity_id=? ORDER BY id DESC LIMIT 500').all(row.id),allowed_transitions:(tasks.DEFINITION.transitions[row.status]||[]).filter(s=>s!=='completed'||access.allowed(req.vt.permissions,'tasks','approve'))});
}));
router.patch('/tasks/:id',wrap((req,res)=>res.json(tasks.updateTask(req.vt.db,Number(req.params.id),req.body,actor(req,guard(req,'tasks','edit'))))));
router.post('/tasks/:id/status',wrap((req,res)=>{
  guard(req,'tasks',req.body.status==='completed'?'approve':'edit');
  const {version,status,remarks}=req.body;
  res.json(tasks.updateTask(req.vt.db,Number(req.params.id),{version,status,remarks},actor(req,guard(req,'tasks'))));
}));
router.get('/documents/:id/download',wrap(async(req,res)=>{
  const invoice=req.params.id.startsWith('invoice-'),id=Number(req.params.id.replace(/^invoice-/,'')),kind=invoice?'invoices':'registrations';
  guard(req,kind);
  const d=req.vt.db.prepare(`SELECT * FROM ${invoice?'vt_invoice_documents':'vt_documents'} WHERE id=?`).get(id);
  if(!d) access.fail('Document not found',404); record(req,kind,d[invoice?'invoice_id':'registration_id']);
  const object=await storage.openStream(d.storage_key); if(!object) access.fail('Document file is unavailable',404);
  res.setHeader('Content-Type',d.mime);res.setHeader('Cache-Control','private, no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Content-Disposition',`inline; filename*=UTF-8''${encodeURIComponent(d.filename)}`);
  if(object.size!=null)res.setHeader('Content-Length',object.size);
  object.stream.on('error',()=>res.destroy());object.stream.pipe(res);
}));
router.patch('/documents/:id',wrap((req,res)=>{
  const invoice=req.params.id.startsWith('invoice-'),id=Number(req.params.id.replace(/^invoice-/,'')),kind=invoice?'invoices':'registrations',db=req.vt.db;
  guard(req,kind,'approve');const table=invoice?'vt_invoice_documents':'vt_documents',before=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
  if(!before)access.fail('Document not found',404);record(req,kind,before[invoice?'invoice_id':'registration_id']);
  const after=db.transaction(()=>{
    if(Number(req.body.version)!==before.version)access.fail('Document changed. Reload before saving.',409);
    if(!['uploaded','pending','verified','rejected','expired'].includes(req.body.status))access.fail('Invalid document status',400);
    db.prepare(`UPDATE ${table} SET status=?,remarks=?,version=version+1,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.body.status,String(req.body.remarks||'').slice(0,2000),req.user.id,id);
    const result=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
    db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,before_json,after_json,actor_id) VALUES(?,?,?,?,?,?)').run(kind,before[invoice?'invoice_id':'registration_id'],'document_reviewed',JSON.stringify({...before,storage_key:undefined}),JSON.stringify({...result,storage_key:undefined}),req.user.id);
    return {...result,storage_key:undefined};
  })(); res.json(after);
}));
router.post('/:kind/:id/documents',wrap(async(req,res)=>{
  const kind=entity(req);guard(req,kind,'edit');const parent=record(req,kind);
  await new Promise((resolve,reject)=>upload(req,res,e=>e?reject(e):resolve()));
  res.status(201).json(await docs.addDocument(req.vt.db,kind,parent,req.body,req.file,req.user));
}));
router.get('/registration-stages',wrap((req,res)=>{
  const scope=guard(req,'registrations'),query=filters(req.query);
  const all=queries.buildQuery('registrations',{...query,workflow_stage:undefined},scope);
  const counts={1:0,2:0,3:0,4:0};
  for(const row of req.vt.db.prepare(`SELECT ${queries.REGISTRATION_STAGE} stage,COUNT(*) total ${all.from} ${all.where} GROUP BY stage`).all(...all.params))counts[row.stage]=row.total;
  res.json({...queries.listEntity(req.vt.db,'registrations',query,scope),counts});
}));
router.post('/registrations/:id/stage',wrap((req,res)=>{
  const scope=guard(req,'registrations','edit'),before=record(req,'registrations');
  if(req.body.action==='accept_portal') {
    access.requireOwner(guard(req,'approvals','create'),before.owner_id);
    access.requireOwner(guard(req,'approvals','approve'),before.owner_id);
  }
  if(req.body.action==='record_enquiry')access.requireOwner(guard(req,'enquiries','create'),before.owner_id);
  const result=service.advanceRegistration(req.vt.db,before.id,req.body,actor(req,scope));
  audit(req,'registrations',before,result,'STATUS_CHANGE');res.json(result);
}));
router.get('/:kind/:id/history',wrap((req,res)=>{
  const kind=entity(req);record(req,kind);res.json(service.getHistory(req.vt.db,kind,Number(req.params.id),actor(req,guard(req,kind))));
}));
router.get('/:kind/:id',wrap((req,res)=>{
  const kind=entity(req),row=record(req,kind),user=actor(req,guard(req,kind)),detail=service.getDetail(req.vt.db,kind,row.id,user);
  const output=detail.record?detail:{record:detail,history:service.getHistory(req.vt.db,kind,row.id,user)};
  output.allowed_transitions=(detail.allowed_transitions||[]).filter(s=>access.allowed(req.vt.permissions,kind,statusAction(kind,s)));
  if(['invoices','funding'].includes(kind))Object.assign(output.record,queries.canonicalInvoiceWarning(req.vt.db,kind==='invoices'?row.id:row.invoice_id));
  if(['registrations','invoices'].includes(kind))output.documents=docs.documentsFor(req.vt.db,kind,row.id);
  if(kind==='registrations')output.document_types=req.vt.db.prepare("SELECT id,label,required FROM vt_catalog WHERE kind='doc_type' AND active=1 ORDER BY label").all();
  res.json(output);
}));
router.get('/:kind',wrap((req,res)=>{
  const kind=entity(req);res.json(queries.listEntity(req.vt.db,kind,filters(req.query),guard(req,kind)));
}));
router.post('/:kind',wrap((req,res)=>{
  const kind=entity(req),scope=guard(req,kind,'create');validateReferences(req,kind,req.body,scope);
  const result=service.createEntity(req.vt.db,kind,req.body,actor(req,scope));audit(req,kind,null,result,'CREATE');res.status(201).json(result);
}));
router.patch('/:kind/:id',wrap((req,res)=>{
  const kind=entity(req),scope=guard(req,kind,'edit'),before=record(req,kind);validateReferences(req,kind,req.body,scope);
  const result=service.updateEntity(req.vt.db,kind,before.id,req.body,actor(req,scope));audit(req,kind,before,result);res.json(result);
}));
router.post('/:kind/:id/status',wrap((req,res)=>{
  const kind=entity(req),scope=guard(req,kind,statusAction(kind,req.body.status)),before=record(req,kind);validateReferences(req,kind,{...before,...req.body},scope);
  const result=service.transitionEntity(req.vt.db,kind,before.id,req.body,actor(req,scope));audit(req,kind,before,result,'STATUS_CHANGE');res.json(result);
}));
return router;
}
module.exports=createRouter();
module.exports.createRouter=createRouter;
