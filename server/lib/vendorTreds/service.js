const { ENTITY_DEFS, normalizeKind } = require('./model');
const { istToday } = require('../istDate');

function fail(message,status=400,code='VALIDATION_ERROR',fields) {
  const error = new Error(message); error.status=status; error.code=code;
  if (fields) error.fields=fields; throw error;
}
const now = () => new Date().toISOString();
const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value)>0;
const columns = (db,table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(c=>c.name));
function entity(kind) {
  kind=normalizeKind(kind); const def=ENTITY_DEFS[kind];
  if (!def) fail('Unknown workflow entity',404,'NOT_FOUND');
  return {kind,def};
}
function actor(user) {
  if (!positiveId(user?.id)) fail('Authentication required',401,'UNAUTHENTICATED');
  return Number(user.id);
}
function seeAll(user,permission) {
  return user.role==='admin' || user.vt_see_all===true || user._vtSeeAll===true ||
    !!user.permissions?.[permission]?.can_see_all || user.scope?.all===true;
}
function ownerVisible(db,user,ownerId,permission) {
  if (seeAll(user,permission) || Number(ownerId)===actor(user)) return true;
  if (Array.isArray(user.scope?.ownerIds)&&user.scope.ownerIds.map(Number).includes(Number(ownerId))) return true;
  if (!columns(db,'users').has('manager_id')) return false;
  return !!db.prepare('SELECT 1 FROM users WHERE id=? AND manager_id=?').get(ownerId,user.id);
}
function rowOwner(db,kind,row) {
  if (row.owner_id) return row.owner_id;
  if (kind==='documents') return db.prepare('SELECT owner_id FROM vt_registrations WHERE id=?').get(row.registration_id)?.owner_id;
  return null;
}
function assertScope(db,kind,row,user) {
  const {def}=entity(kind); actor(user);
  if (kind==='catalog') return;
  if (!ownerVisible(db,user,rowOwner(db,kind,row),def.permission)) fail('Record is outside your assigned team',403,'FORBIDDEN');
}
function load(db,kind,id,user) {
  const {def}=entity(kind);
  if (!positiveId(id)) fail('Invalid record ID');
  const row=db.prepare(`SELECT * FROM ${def.table} WHERE id=?`).get(Number(id));
  if (!row) fail('Record not found',404,'NOT_FOUND');
  assertScope(db,normalizeKind(kind),row,user); return row;
}
function history(db,kind,id,event,before,after,user,remarks) {
  db.prepare(`INSERT INTO vt_history(entity_type,entity_id,event,old_status,new_status,before_json,after_json,actor_id,changed_at,remarks)
    VALUES(?,?,?,?,?,?,?,?,?,?)`).run(kind,id,event,before?.status||null,after?.status||null,
    before?JSON.stringify(before):null,after?JSON.stringify(after):null,actor(user),now(),remarks||null);
}
function date(value,key) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) fail(`${key}: enter a valid date`,400,'VALIDATION_ERROR',{[key]:'Invalid date'});
  return value;
}
function datetime(value,key) {
  if (typeof value!=='string' || !/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value) || !Number.isFinite(Date.parse(value))) fail(`${key}: enter a valid date and time`);
  date(value.slice(0,10),key);
  // datetime-local is interpreted in the ERP's IST business timezone.
  const zoned=/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)?value:value.replace(' ','T')+'+05:30';
  return new Date(zoned).toISOString();
}
function cleanData(def,input={},partial=false) {
  if (!input || typeof input!=='object' || Array.isArray(input)) fail('Record data must be an object');
  const allowed=new Set(def.fields.map(f=>f.key).concat(['version','status']));
  for (const key of Object.keys(input)) {
    if (/password|secret|token/i.test(key)) fail('Passwords and secrets cannot be stored in this tracker',400,'SECRET_NOT_ALLOWED');
    if (!allowed.has(key)) fail(`Unknown field: ${key}`,400,'VALIDATION_ERROR',{[key]:'Unknown field'});
  }
  const out={};
  for (const field of def.fields) {
    const key=field.key;
    // Virtual master fields can be inherited from the selected canonical client.
    if (!Object.hasOwn(input,key)) {if (!partial&&field.required&&!field.virtual) fail(`${field.label} is required`,400,'VALIDATION_ERROR',{[key]:'Required'}); continue;}
    if(field.readOnly)fail(`${field.label} is calculated by the server`);
    let value=input[key];
    if (value==null || value==='') {if (field.required) fail(`${field.label} is required`,400,'VALIDATION_ERROR',{[key]:'Required'});out[key]=null;continue;}
    if (field.type==='lookup') {
      if (!positiveId(value)) fail(`${field.label}: choose a valid record`); value=Number(value);
    } else if (field.type==='date') value=date(value,key);
    else if (field.type==='datetime') value=datetime(value,key);
    else if (field.type==='boolean') {
      if (![0,1,true,false,'0','1'].includes(value)) fail(`${field.label}: choose yes or no`);value=(value===true||value===1||value==='1')?1:0;
    } else if (field.type==='number'||field.type==='money') {
      value=Number(value); if (!Number.isFinite(value) || (field.type==='money'&&!Number.isSafeInteger(value)) ||
        (field.min!=null&&value<field.min)||(field.max!=null&&value>field.max)) fail(`${field.label}: enter a valid number`);
      if (['size_bytes','term_days'].includes(key)&&!Number.isSafeInteger(value)) fail(`${field.label} must be a whole number`);
    } else if (field.type==='select') {
      const choice=field.options.find(x=>String(x)===String(value));if(choice===undefined) fail(`${field.label}: choose a valid value`);value=choice;
    } else {
      if (typeof value!=='string') fail(`${field.label} must be text`); value=value.trim();
      if (!value&&field.required) fail(`${field.label} is required`);
      if (value.length>(field.type==='textarea'?10000:500)) fail(`${field.label} is too long`);
      if (field.type==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail('Enter a valid contact email');
      if (field.type==='url') {try {const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error();}catch{fail(`${field.label}: use an HTTP or HTTPS URL without credentials`);}}
      value=value||null;
    }
    out[key]=value;
  }
  return out;
}
function foreign(db,table,id,label,extra='') {
  if (id==null) return null;
  const row=db.prepare(`SELECT * FROM ${table} WHERE id=? ${extra}`).get(id);
  if (!row) fail(`${label} not found`,400,'INVALID_REFERENCE');return row;
}
function ownReference(db,kind,id,user) {return id==null?null:load(db,kind,id,user);}
function validateReferences(db,kind,row,user) {
  const {def}=entity(kind);
  if (row.owner_id!=null) {
    const valid=foreign(db,'users',row.owner_id,'Owner');
    if (valid.active===0||valid.archived===1)fail('Choose an active owner');
    if (!ownerVisible(db,user,row.owner_id,def.permission)) fail('You cannot assign this owner',403,'FORBIDDEN');
  }
  foreign(db,'customers',row.customer_id,'Client');foreign(db,'vendors',row.vendor_id,'Vendor');
  const reg=ownReference(db,'registrations',row.registration_id,user);
  if (reg && row.customer_id && reg.customer_id!==row.customer_id) fail('Registration belongs to another client');
  if (reg && Object.hasOwn(row,'vendor_id') && (reg.vendor_id||null)!==(row.vendor_id||null)) fail('Registration belongs to another vendor');
  if (row.platform_id) foreign(db,'vt_catalog',row.platform_id,'Platform',"AND kind='platform' AND active=1");
  if (row.type_id) foreign(db,'vt_catalog',row.type_id,'Document type',"AND kind='doc_type' AND active=1");
  const contact=ownReference(db,'contacts',row.contact_id,user);
  if (contact&&row.customer_id&&contact.customer_id!==row.customer_id) fail('Contact belongs to another client');
  const account=ownReference(db,'accounts',row.account_id,user);
  if (account&&row.platform_id&&account.platform_id!==row.platform_id) fail('Account belongs to another platform');
  if (kind==='invoices'&&account) {
    if ((account.vendor_id||null)!==(row.vendor_id||null))fail('Account belongs to another invoice issuer');
    if(!['funded','cancelled','rejected','on_hold'].includes(row.status)) {
    if (account.status!=='active'||account.account_status!=='active') fail('TReDS account must be active',409,'INACTIVE_ACCOUNT');
    const mapping=db.prepare('SELECT * FROM vt_mappings WHERE customer_id=? AND platform_id=?').get(row.customer_id,row.platform_id);
    if (!mapping||mapping.acceptance_confirmed!==1)fail('Confirm client acceptance on this platform first',409,'CLIENT_MAPPING_REQUIRED');
    assertScope(db,'mappings',mapping,user);
    if (mapping.account_id&&mapping.account_id!==row.account_id)fail('Client mapping belongs to another account');
    }
  }
  if (kind==='approvals'&&row.document_id) {
    const document=ownReference(db,'documents',row.document_id,user);
    if(document.registration_id!==row.registration_id)fail('Approval document belongs to another registration');
  }
  if (kind==='documents') {
    if (!/^(?:vendor-treds\/)[a-zA-Z0-9._/-]+$/.test(row.storage_key||'') || row.storage_key.split('/').includes('..')) fail('Use a protected vendor-treds storage key');
    if (!['application/pdf','image/jpeg','image/png'].includes(row.mime))fail('Only PDF, JPEG and PNG documents are supported');
    if(row.size_bytes>20*1024*1024)fail('Document exceeds 20 MB');
  }
  if(kind==='followups') {
    if(['enquiry_id','mapping_id','registration_id'].filter(k=>row[k]!=null).length!==1)fail('Choose exactly one follow-up record');
    ownReference(db,'enquiries',row.enquiry_id,user);ownReference(db,'mappings',row.mapping_id,user);
    if(row.completed_at&&row.contact_at&&row.completed_at<row.contact_at)fail('Completion cannot precede contact');
  }
  if(kind==='funding')ownReference(db,'invoices',row.invoice_id,user);
  if(row.valid_until&&row.approval_date&&row.valid_until<row.approval_date)fail('Approval expiry cannot precede approval');
  if(row.due_date&&(row.invoice_date||row.enquiry_date)&&row.due_date<(row.invoice_date||row.enquiry_date))fail('Due date cannot precede transaction date');
}
function requiredDocuments(db,registrationId) {
  return db.prepare(`SELECT c.id,c.label FROM vt_catalog c WHERE c.kind='doc_type' AND c.active=1 AND c.required=1
    AND NOT EXISTS(SELECT 1 FROM vt_documents d WHERE d.registration_id=? AND d.type_id=c.id
      AND d.status IN ('uploaded','verified') AND (d.expiry_date IS NULL OR d.expiry_date>=?))`).all(registrationId,istToday());
}
function requireDocuments(db,id) {
  const missing=requiredDocuments(db,id);
  if(missing.length)fail(`Required documents pending: ${missing.map(d=>d.label).join(', ')}`,409,'DOCUMENTS_PENDING',{documents:missing});
}
function hasInvoiceUpload(db,invoice) {
  return !!(invoice.uploaded_at&&db.prepare(`SELECT id FROM vt_invoice_documents WHERE invoice_id=? AND purpose='invoice'
    AND mime='application/pdf' AND size_bytes>0 AND storage_key IS NOT NULL AND status IN ('uploaded','verified')
    AND (expiry_date IS NULL OR expiry_date>=?) LIMIT 1`).get(invoice.id,istToday()));
}
function requireInvoiceUpload(db,invoice) {
  if(!hasInvoiceUpload(db,invoice))fail('Upload a valid invoice PDF before continuing',409,'INVOICE_PDF_REQUIRED');
}
function persist(db,kind,before,changes,user,event='update',note) {
  const {def}=entity(kind);const keys=Object.keys(changes);
  const result=db.prepare(`UPDATE ${def.table} SET ${keys.map(k=>`${k}=?`).join(',')}${keys.length?',':''}
    version=version+1,updated_by=?,updated_at=? WHERE id=? AND version=?`)
    .run(...keys.map(k=>changes[k]===undefined?null:changes[k]),actor(user),now(),before.id,before.version);
  if(result.changes!==1)fail('This record changed. Refresh before saving.',409,'VERSION_CONFLICT');
  const after=db.prepare(`SELECT * FROM ${def.table} WHERE id=?`).get(before.id);
  history(db,kind,before.id,event,before,after,user,note);return after;
}
function expectVersion(row,input) {
  if (!positiveId(input?.version)) fail('The current record version is required',400,'VERSION_REQUIRED');
  if(Number(input.version)!==row.version)fail('This record changed. Refresh before saving.',409,'VERSION_CONFLICT');
}
function normalizeInvoice(row) {
  row.invoice_number_key=String(row.external_invoice_number||'').trim().replace(/\s+/g,' ').toUpperCase();
  if(!row.invoice_number_key)fail('Invoice number is required');
  if(!Number.isSafeInteger(row.amount_paise)||row.amount_paise<=0)fail('Invoice amount must be positive');
  return row;
}
const CUSTOMER_FIELDS={company_name:'company_name',website_url:'website_url',sector:'sector',plant_location:'plant_location',
  turnover_amount:'turnover_amount',address:'company_registration_address',city:'city',state:'state',contact_person:'concern_person_name',
  email:'email',phone:'contact_no',pan:'pan',gst_number:'gst_number',udyam:'udyam'};
function normalizeDomain(value) {
  if(!value)return null;
  try{const parsed=new URL(value);if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)throw Error();return parsed.hostname.toLowerCase().replace(/^www\./,'').replace(/\.$/,'');}
  catch{fail('Website URL must be an HTTP or HTTPS URL without credentials');}
}
function findDuplicateCandidates(db,input={},excludeId=null) {
  const identity={company_name:input.company_name,website_domain:input.website_domain||normalizeDomain(input.website_url),
    pan:input.pan,gst_number:input.gst_number};
  const entries=Object.entries(identity).filter(([,v])=>String(v||'').trim());
  if(!entries.length)return [];
  const params=entries.map(([,v])=>String(v).trim());
  let sql=`SELECT id,customer_code,company_name,website_url,website_domain,pan,gst_number FROM customers
    WHERE (${entries.map(([k])=>`LOWER(TRIM(COALESCE(${k},'')))=LOWER(TRIM(?))`).join(' OR ')})`;
  if(excludeId){sql+=' AND id<>?';params.push(Number(excludeId));}
  sql+=' ORDER BY id LIMIT 20';
  return db.prepare(sql).all(...params).map(row=>({...row,matches:entries.filter(([key,value])=>
    String(row[key]||'').trim().toLowerCase()===String(value).trim().toLowerCase()).map(([key])=>key)}));
}
function customerProfile(db,id) {
  const customer=foreign(db,'customers',Number(id),'Client');
  const out={customer_id:customer.id,customer_code:customer.customer_code};
  for(const [key,column] of Object.entries(CUSTOMER_FIELDS))out[key]=customer[column]??null;
  out.website_domain=customer.website_domain;
  out.procurement_contact=db.prepare("SELECT name FROM vt_contacts WHERE customer_id=? AND kind='procurement' ORDER BY id DESC LIMIT 1").get(id)?.name||null;
  return out;
}
function saveCustomer(db,row,user) {
  const before=row.customer_id?foreign(db,'customers',row.customer_id,'Client'):null;
  const values={};for(const [key,column] of Object.entries(CUSTOMER_FIELDS))if(Object.hasOwn(row,key))values[column]=row[key];
  const next={...(before||{}),...values};
  if(!String(next.company_name||'').trim())fail('Company Name is required',400,'VALIDATION_ERROR',{company_name:'Required'});
  values.website_domain=normalizeDomain(next.website_url);
  for(const key of ['pan','gst_number','udyam'])if(values[key])values[key]=String(values[key]).trim().toUpperCase();
  const duplicates=findDuplicateCandidates(db,{...next,...values},before?.id);
  if(duplicates.length){const error=new Error('Possible existing vendor found. Select the existing company.');error.status=409;error.code='POSSIBLE_DUPLICATE_VENDOR';error.candidates=duplicates;throw error;}
  if(before) {
    if(Object.keys(values).some(k=>values[k]!==before[k])) {
      const keys=Object.keys(values);db.prepare(`UPDATE customers SET ${keys.map(k=>`${k}=?`).join(',')},updated_at=? WHERE id=?`).run(...keys.map(k=>values[k]),now(),before.id);
    }
  } else {
    const {nextSequence}=require('../../db/nextSequence');
    values.customer_code=nextSequence(db,'customers','customer_code','CUST-',{startFrom:1000,pad:5});
    const keys=Object.keys(values);row.customer_id=Number(db.prepare(`INSERT INTO customers(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k])).lastInsertRowid);
  }
  const procurement=row.procurement_contact;
  for(const field of ENTITY_DEFS.registrations.fields.filter(f=>f.virtual))delete row[field.key];
  return {before,after:foreign(db,'customers',row.customer_id,'Client'),procurement};
}
function recordCustomer(db,registration,change,user) {
  if(!change)return;
  if(JSON.stringify(change.before)!==JSON.stringify(change.after))history(db,'registrations',registration.id,
    change.before?'customer_update':'customer_create',change.before,change.after,user,'Canonical company profile updated');
  if(change.procurement&&!db.prepare("SELECT 1 FROM vt_contacts WHERE customer_id=? AND kind='procurement' AND LOWER(TRIM(name))=LOWER(TRIM(?))").get(registration.customer_id,change.procurement)) {
    insert(db,'contacts',{customer_id:registration.customer_id,kind:'procurement',name:change.procurement,owner_id:registration.owner_id},user);
  }
}
function fundingTerms(row) {
  const calculate=require('./finance').calculateFundingTerms;
  let result;try{result=calculate(row);}catch(error){fail(error.message);}
  return Object.fromEntries(['principal_paise','discount_rate','basis','term_days','day_basis','discount_paise','fees_paise','taxes_paise','expected_net_paise','actual_received_paise']
    .filter(k=>Object.hasOwn(result,k)).map(k=>[k,result[k]]));
}
function insert(db,kind,data,user) {
  const {def}=entity(kind);const keys=Object.keys(data),at=now();
  const r=db.prepare(`INSERT INTO ${def.table}(${keys.join(',')},created_by,updated_by,created_at,updated_at)
    VALUES(${keys.map(()=>'?').join(',')},?,?,?,?)`).run(...keys.map(k=>data[k]===undefined?null:data[k]),actor(user),actor(user),at,at);
  const row=db.prepare(`SELECT * FROM ${def.table} WHERE id=?`).get(r.lastInsertRowid);
  history(db,kind,row.id,'create',null,row,user,row.remarks||row.notes);return row;
}
function createCrm(db,row,user) {
  const customer=foreign(db,'customers',row.customer_id,'Client');
  if(row.crm_funnel_id) {
    const crm=foreign(db,'crm_funnel',row.crm_funnel_id,'CRM Enquiry');
    if(crm.created_by&&!ownerVisible(db,user,crm.created_by,'vendor_enquiries'))fail('CRM enquiry is outside your assigned team',403,'FORBIDDEN');
    if(![crm.client_name,crm.company_name].some(v=>String(v||'').trim().toLowerCase()===customer.company_name.trim().toLowerCase()))fail('CRM enquiry belongs to another client');
    return;
  }
  const values={lead_no:`VT-RFQ-${Date.now()}-${actor(user)}-${Math.random().toString(36).slice(2,7)}`,
    client_name:customer.company_name,company_name:customer.company_name,mobile:customer.contact_no||null,
    email:customer.email||null,source:null,remarks:row.remarks||null,created_by:actor(user)};
  const available=columns(db,'crm_funnel');const keys=Object.keys(values).filter(k=>available.has(k));
  row.crm_funnel_id=Number(db.prepare(`INSERT INTO crm_funnel(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k])).lastInsertRowid);
}
function canonicalInvoice(db,row,user) {
  if(row.sales_bill_id) {
    const bill=foreign(db,'sales_bills',row.sales_bill_id,'ERP Invoice');
    const amount=Math.round(Number(bill.total_amount)*100);
    if(amount!==row.amount_paise||bill.bill_date!==row.invoice_date)fail('Amount and invoice date must match the selected ERP invoice',409,'CANONICAL_INVOICE_MISMATCH');
    const client=foreign(db,'customers',row.customer_id,'Client');
    if(bill.customer_name&&String(bill.customer_name).trim().toLowerCase()!==String(client.company_name).trim().toLowerCase())fail('ERP invoice belongs to another client');
    if(bill.vt_origin!=='vendor_treds'&&String(bill.bill_number).trim().toUpperCase()!==row.invoice_number_key)fail('Invoice number must match the existing ERP invoice');
    return;
  }
  const customer=foreign(db,'customers',row.customer_id,'Client'),at=now();
  // The uploaded face value is known; its GST/base split is not supplied.
  const values={bill_date:row.invoice_date,amount:null,gst_amount:null,total_amount:row.amount_paise/100,
    customer_name:customer.company_name,payment_status:'pending',approval_status:'draft',created_by:actor(user),created_at:at,vt_origin:'vendor_treds'};
  const available=columns(db,'sales_bills');const keys=Object.keys(values).filter(k=>available.has(k));
  row.sales_bill_id=Number(db.prepare(`INSERT INTO sales_bills(${keys.join(',')}) VALUES(${keys.map(()=>'?').join(',')})`).run(...keys.map(k=>values[k])).lastInsertRowid);
  db.prepare('UPDATE sales_bills SET bill_number=? WHERE id=?').run(`VT-IN-${row.sales_bill_id}`,row.sales_bill_id);
}
function syncRegistration(db,id,status,user) {
  if(!id)return;
  const row=db.prepare('SELECT * FROM vt_registrations WHERE id=?').get(id);
  if(!row)return;
  const rank={not_started:0,started:1,submitted:2,docs_pending:2,approved:3,enquiry_received:4,quote_sent:5,po_received:6};
  if((rank[row.status]??-1)>=(rank[status]??0))return;
  persist(db,'registrations',row,{status},user,'status','Updated from workflow transaction');
}
function syncFollowup(db,row,user) {
  const linked=row.enquiry_id?['enquiries',row.enquiry_id]:row.mapping_id?['mappings',row.mapping_id]:['registrations',row.registration_id];
  const parent=load(db,linked[0],linked[1],user);const changes={next_followup_at:row.next_followup_at||null};
  if(row.contact_at)changes[linked[0]==='mappings'?'last_contact_at':linked[0]==='registrations'?'last_followup_at':'next_followup_at']=
    linked[0]==='enquiries'?row.next_followup_at||null:row.contact_at;
  persist(db,linked[0],parent,changes,user,'update','Follow-up recorded');
}
function translateConstraint(error) {
  if(/UNIQUE constraint failed: (vt_invoices|index ['"]vt_invoice_identity)/.test(error.message))fail('Possible existing invoice found for this issuer and client.',409,'DUPLICATE_INVOICE');
  if(/UNIQUE constraint failed/.test(error.message))fail('Possible existing record found.',409,'DUPLICATE_RECORD');
  if(/FOREIGN KEY constraint failed/.test(error.message))fail('Referenced record is not available',400,'INVALID_REFERENCE');
  throw error;
}
function createEntity(db,kind,input,user) {
  ({kind}=entity(kind));actor(user);
  try{return db.transaction(()=>{
    const {def}=entity(kind);const payload={...input};
    if(def.fields.some(f=>f.key==='owner_id')&&!Object.hasOwn(payload,'owner_id'))payload.owner_id=actor(user);
    const row=cleanData(def,payload);
    if(payload.status&&payload.status!==def.initialStatus)fail('Create the record in its initial status, then use a workflow action');
    if(def.initialStatus)row.status=def.initialStatus;
    if(kind==='catalog') {row.required??=0;row.active??=1;}
    if(kind==='contacts')row.kind??='general';
    if(kind==='registrations')row.source??='manual';
    if(kind==='enquiries')row.is_mnc??=0;
    if(kind==='accounts')row.account_status='inactive';
    const customerChange=kind==='registrations'?saveCustomer(db,row,user):null;
    validateReferences(db,kind,row,user);
    if(kind==='enquiries')createCrm(db,row,user);
    if(kind==='invoices'){row.uploaded_at=null;normalizeInvoice(row);canonicalInvoice(db,row,user);}
    if(kind==='funding'){requireInvoiceUpload(db,load(db,'invoices',row.invoice_id,user));Object.assign(row,fundingTerms(row));}
    const saved=insert(db,kind,row,user);
    recordCustomer(db,saved,customerChange,user);
    if(kind==='enquiries')syncRegistration(db,row.registration_id,'enquiry_received',user);
    if(kind==='followups')syncFollowup(db,saved,user);
    return {...saved,allowed_transitions:allowedTransitions(db,kind,saved,user)};
  })();}catch(error){translateConstraint(error);}
}
function updateEntity(db,kind,id,input,user) {
  ({kind}=entity(kind));
  try{return db.transaction(()=>{
    const before=load(db,kind,id,user);expectVersion(before,input);
    if(Object.hasOwn(input,'status')&&input.status!==before.status)fail('Use a workflow action to change status');
    const changes=cleanData(ENTITY_DEFS[kind],input,true);
    const immutable={documents:['registration_id','storage_key','filename','mime','size_bytes'],approvals:['registration_id'],
      enquiries:['crm_funnel_id','registration_id','customer_id'],invoices:['sales_bill_id','customer_id','vendor_id','registration_id'],funding:['invoice_id']};
    for(const key of immutable[kind]||[])if(Object.hasOwn(changes,key)&&changes[key]!==before[key])fail(`${key} cannot change after creation`);
    if(kind==='accounts'&&Object.hasOwn(changes,'account_status')&&changes.account_status!==before.account_status)fail('Use an account workflow action to change account status');
    if(kind==='funding'&&['funded','reconciled','closed'].includes(before.status)) {
      for(const key of Object.keys(changes))if(!['remarks','expected_settlement','receivable_id','collection_id','bank_transaction_id'].includes(key)&&changes[key]!==before[key])fail('Funded financial values are locked',409,'FINANCIAL_LOCKED');
    }
    if(kind==='funding'&&before.reconciled_at) {
      for(const key of ['receivable_id','collection_id','bank_transaction_id'])if(Object.hasOwn(changes,key)&&changes[key]!==before[key])fail('Reconciled accounting receipt references are locked',409,'RECONCILIATION_LOCKED');
    }
    if(kind==='funding'&&before.status==='funding_approved') {
      for(const key of ['principal_paise','discount_rate','basis','term_days','day_basis','discount_paise','fees_paise','taxes_paise'])
        if(Object.hasOwn(changes,key)&&changes[key]!==before[key])fail('Approved funding terms are locked',409,'FINANCIAL_LOCKED');
    }
    if(kind==='invoices'&&(before.accepted_at||['accepted','bid_received','funded','cancelled','rejected'].includes(before.status))) {
      for(const key of ['external_invoice_number','invoice_date','amount_paise','platform_id','account_id'])if(Object.hasOwn(changes,key)&&changes[key]!==before[key])fail('Invoice values are locked after client acceptance',409,'FINANCIAL_LOCKED');
    }
    const next={...before,...changes};validateReferences(db,kind,next,user);
    let customerChange;
    if(kind==='registrations') {
      if(Object.hasOwn(changes,'customer_id')&&changes.customer_id!==before.customer_id)fail('Registration client cannot change after creation');
      customerChange=saveCustomer(db,next,user);
      for(const field of ENTITY_DEFS.registrations.fields.filter(f=>f.virtual))delete changes[field.key];
    }
    if(kind==='invoices') {
      normalizeInvoice(next);changes.invoice_number_key=next.invoice_number_key;
      const bill=foreign(db,'sales_bills',next.sales_bill_id,'ERP Invoice');
      if(bill.vt_origin==='vendor_treds')db.prepare('UPDATE sales_bills SET bill_date=?,total_amount=? WHERE id=?')
        .run(next.invoice_date,next.amount_paise/100,bill.id);
      else canonicalInvoice(db,next,user);
    }
    if(kind==='funding') {
      if(['principal_paise','discount_rate','basis','term_days','day_basis'].some(k=>Object.hasOwn(changes,k)&&changes[k]!==before[k])&&!Object.hasOwn(changes,'discount_paise'))next.discount_paise=null;
      Object.assign(changes,fundingTerms(next));
    }
    const saved=persist(db,kind,before,changes,user,'update',changes.remarks||changes.notes);
    recordCustomer(db,saved,customerChange,user);
    if(kind==='followups')syncFollowup(db,saved,user);
    return {...saved,allowed_transitions:allowedTransitions(db,kind,saved,user)};
  })();}catch(error){translateConstraint(error);}
}

function allowedTransitions(db,kind,row,user) {
  const options=ENTITY_DEFS[kind].transitions[row.status]||[];
  return options.filter(status=>{
    if(kind==='registrations'&&status==='approved')return false;
    if(kind==='registrations'&&['enquiry_received','quote_sent','po_received'].includes(status))return false;
    if(kind==='invoices'&&status==='funded')return false;
    if(kind==='invoices'&&['accepted','bid_received'].includes(status)&&!hasInvoiceUpload(db,row))return false;
    if(kind==='enquiries'&&status==='po_received')return !!db.prepare("SELECT 1 FROM quotations WHERE crm_funnel_id=? AND status='accepted' AND business_book_id IS NOT NULL").get(row.crm_funnel_id);
    return true;
  });
}
function approvalAction(db,before,changes,user) {
  if(changes.status==='approved') {
    requireDocuments(db,before.registration_id);
    const merged={...before,...changes};
    const registration=load(db,'registrations',before.registration_id,user);
    if(!String(merged.vendor_code||'').trim()&&!registration.portal_url)fail('Record the vendor portal URL or vendor code for acceptance',400,'VENDOR_CODE_REQUIRED');
    changes.approval_date=merged.approval_date||istToday();
    if(changes.approval_date>istToday())fail('Approval date cannot be in the future');
    if(merged.valid_until&&merged.valid_until<changes.approval_date)fail('Approval already expired');
    syncRegistration(db,before.registration_id,'approved',user);
  }
}
function enquiryAction(db,before,changes,user) {
  const status=changes.status;
  if(status==='quote_sent') {
    const quote=db.prepare("SELECT * FROM quotations WHERE crm_funnel_id=? AND status IN ('sent','negotiation','accepted') ORDER BY id DESC LIMIT 1").get(before.crm_funnel_id);
    if(!quote)fail('Send an approved quotation through the ERP quotation workflow first',409,'QUOTATION_REQUIRED');
    db.prepare('UPDATE crm_funnel SET quotation_submitted=1,quotation_submit_date=COALESCE(quotation_submit_date,?),updated_at=? WHERE id=?')
      .run(now(),now(),before.crm_funnel_id);
    syncRegistration(db,before.registration_id,'quote_sent',user);
  }
  if(status==='negotiation')db.prepare("UPDATE crm_funnel SET negotiation_status='in_progress',updated_at=? WHERE id=?").run(now(),before.crm_funnel_id);
  if(status==='po_received') {
    const quote=db.prepare("SELECT * FROM quotations WHERE crm_funnel_id=? AND status='accepted' AND business_book_id IS NOT NULL ORDER BY id DESC LIMIT 1").get(before.crm_funnel_id);
    if(!quote||!db.prepare('SELECT 1 FROM business_book WHERE id=? AND NULLIF(TRIM(po_number),\'\') IS NOT NULL').get(quote.business_book_id))fail('Link an accepted ERP quotation to a real received client PO first',409,'PO_REQUIRED');
    db.prepare("UPDATE crm_funnel SET final_status='win',closed_at=COALESCE(closed_at,?),updated_at=? WHERE id=?").run(now(),now(),before.crm_funnel_id);
    syncRegistration(db,before.registration_id,'po_received',user);
  }
  if(status==='lost'||status==='rejected')db.prepare("UPDATE crm_funnel SET final_status='loss',closed_at=COALESCE(closed_at,?),updated_at=? WHERE id=?").run(now(),now(),before.crm_funnel_id);
}
function invoiceAction(db,before,changes,user) {
  const status=changes.status,at=now();
  if(['accepted','bid_received'].includes(status))requireInvoiceUpload(db,before);
  if(['accepted','bid_received'].includes(status))canonicalInvoice(db,before,user);
  if(status==='funded')fail('Record the actual funding through Bill Discounting',409,'FUNDING_ACTION_REQUIRED');
  if(status==='accepted')changes.accepted_at=before.accepted_at||at;
  if(status==='bid_received') {if(!before.accepted_at)fail('Client acceptance is required first',409,'INVALID_TRANSITION');changes.bid_at=before.bid_at||at;}
  if(before.status==='on_hold') {
    const expected=before.bid_at?'bid_received':before.accepted_at?'accepted':'uploaded';
    if(!['cancelled',expected].includes(status))fail('Resume the stage reached before the hold',409,'INVALID_TRANSITION');
  }
  const funding=db.prepare('SELECT * FROM vt_funding WHERE invoice_id=?').get(before.id);
  if(funding) {
    if(['funded','reconciled','closed'].includes(funding.status)&&['cancelled','rejected','on_hold'].includes(status))fail('Funded invoices cannot be cancelled or rejected',409,'FINANCIAL_LOCKED');
    const map={accepted:'client_accepted',bid_received:'bid_received',cancelled:'cancelled',rejected:'rejected',on_hold:'on_hold',uploaded:'invoice_uploaded'};
    let fundingStatus=map[status];
    if(funding.status==='on_hold'&&!['on_hold','cancelled','rejected'].includes(status)) {
      fundingStatus=funding.approved_at?'funding_approved':before.bid_at?'bid_received':before.accepted_at?'client_accepted':'invoice_uploaded';
    }
    if(fundingStatus&&funding.status!==fundingStatus)persist(db,'funding',funding,{status:fundingStatus},user,'status','Updated from invoice stage');
  }
}
function fundingAction(db,before,changes,user) {
  const invoice=load(db,'invoices',before.invoice_id,user),merged={...before,...changes},status=changes.status,at=now();
  if(['client_accepted','bid_received','funding_approved','funded'].includes(status))requireInvoiceUpload(db,invoice);
  if(['funding_approved','funded'].includes(status))canonicalInvoice(db,invoice,user);
  if(['cancelled','rejected'].includes(invoice.status))fail('Invoice is not eligible for funding',409,'INELIGIBLE_INVOICE');
  if(status==='client_accepted'&&!invoice.accepted_at)fail('Record client invoice acceptance first',409,'ACCEPTANCE_REQUIRED');
  if(['bid_received','funding_approved','funded'].includes(status)&&!invoice.bid_at)fail('Record a received invoice bid first',409,'BID_REQUIRED');
  if(status==='funding_approved') {
    if(['principal_paise','discount_rate','basis','term_days','day_basis'].some(k=>Object.hasOwn(changes,k)&&changes[k]!==before[k])&&!Object.hasOwn(changes,'discount_paise'))merged.discount_paise=null;
    const terms=fundingTerms(merged);Object.assign(changes,terms);
    if(!merged.principal_paise||merged.principal_paise>invoice.amount_paise)fail('Funding principal must be positive and cannot exceed invoice value');
    changes.approved_at=at;
  }
  if(status==='funded') {
    const account=foreign(db,'vt_accounts',invoice.account_id,'Account');
    if(account.status!=='active'||account.account_status!=='active')fail('TReDS account must be active',409,'INACTIVE_ACCOUNT');
    if(!before.approved_at)fail('Funding approval is required first',409,'APPROVAL_REQUIRED');
    if(!Number.isSafeInteger(merged.actual_received_paise)||merged.actual_received_paise<=0)fail('Enter actual positive funds received',400,'ACTUAL_FUNDS_REQUIRED');
    if(!merged.bank_reference)fail('Bank reference is required for funding');
    if(merged.actual_received_paise>(merged.principal_paise||invoice.amount_paise))fail('Received funds exceed financed principal');
    changes.funded_at=at;
    persist(db,'invoices',invoice,{status:'funded',funded_at:at},user,'status','Actual funding received');
  }
  if(status==='reconciled') {
    if(!before.funded_at)fail('Funding is required before reconciliation',409,'FUNDING_REQUIRED');
    if(merged.bank_transaction_id) {
      const bank=foreign(db,'bank_transactions',merged.bank_transaction_id,'Bank transaction');
      if(Math.round(Number(bank.credit)*100)!==merged.actual_received_paise || Number(bank.credit)<=0 || Number(bank.debit)>0)fail('Bank credit amount does not match actual funds received',409,'RECEIPT_MISMATCH');
      if(bank.ref_no&&bank.ref_no!==merged.bank_reference)fail('Bank receipt reference does not match funding');
      if(bank.matched_type&&!(bank.matched_type==='vt_funding'&&Number(bank.matched_id)===before.id))fail('Bank transaction is already matched to another accounting record',409,'DUPLICATE_RECEIPT');
      if(db.prepare('SELECT 1 FROM vt_funding WHERE bank_transaction_id=? AND id<>?').get(bank.id,before.id))fail('Bank transaction already reconciled to another funding',409,'DUPLICATE_RECEIPT');
      if(merged.collection_id||merged.receivable_id)fail('Choose one accounting receipt source');
      if(bank.matched_type!=='vt_funding') {
        // Reserve the canonical credit inside this workflow transaction so bank
        // import/reconciliation cannot subsequently consume it as client cash.
        const reserved=db.prepare(`UPDATE bank_transactions SET matched_type='vt_funding',matched_id=?,matched_note=?,matched_by=?,matched_at=?
          WHERE id=? AND matched_type IS NULL`).run(before.id,`TReDS funding #${before.id}`,actor(user),at,bank.id);
        if(reserved.changes!==1)fail('Bank transaction is already matched to another accounting record',409,'DUPLICATE_RECEIPT');
      }
    } else {
    const collection=foreign(db,'collections',merged.collection_id,'Accounting receipt');
    const receivable=foreign(db,'receivables',merged.receivable_id,'Receivable');
    if(!collection||!receivable||collection.receivable_id!==receivable.id)fail('Select the real receipt and its receivable',400,'RECEIPT_REQUIRED');
    if(Math.round(Number(collection.amount)*100)!==merged.actual_received_paise)fail('Accounting receipt amount does not match actual funds received',409,'RECEIPT_MISMATCH');
    const bill=foreign(db,'sales_bills',invoice.sales_bill_id,'ERP Invoice');
    if(![invoice.external_invoice_number,bill.bill_number].includes(receivable.invoice_number))fail('Receivable belongs to another invoice');
    const client=foreign(db,'customers',invoice.customer_id,'Client');
    const normalizeParty=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
    if(receivable.sales_bill_id!=null&&Number(receivable.sales_bill_id)!==invoice.sales_bill_id)fail('Receivable belongs to another ERP invoice',409,'RECEIPT_MISMATCH');
    if(receivable.customer_id!=null&&Number(receivable.customer_id)!==invoice.customer_id)fail('Receivable belongs to another client',409,'RECEIPT_MISMATCH');
    if(receivable.business_book_id!=null&&bill.business_book_id!=null&&Number(receivable.business_book_id)!==Number(bill.business_book_id))fail('Receivable belongs to another order',409,'RECEIPT_MISMATCH');
    if(normalizeParty(receivable.client_name)!==normalizeParty(client.company_name))fail('Receivable belongs to another client',409,'RECEIPT_MISMATCH');
    if(collection.transaction_ref&&collection.transaction_ref!==merged.bank_reference)fail('Accounting receipt bank reference does not match funding');
    if(db.prepare('SELECT 1 FROM vt_funding WHERE collection_id=? AND id<>?').get(collection.id,before.id))fail('Accounting receipt already reconciled to another funding',409,'DUPLICATE_RECEIPT');
    }
    changes.reconciled_at=at;
  }
  if(status==='closed') {if(!before.reconciled_at)fail('Reconcile payment before closing',409,'RECONCILIATION_REQUIRED');changes.closed_at=at;}
  if(before.status==='on_hold') {
    const reached=before.approved_at?'funding_approved':invoice.bid_at?'bid_received':invoice.accepted_at?'client_accepted':'invoice_uploaded';
    if(!['cancelled',reached].includes(status))fail('Resume the stage reached before the hold',409,'INVALID_TRANSITION');
  }
}
function transitionEntity(db,kind,id,status,input,user) {
  // Also accepts transitionEntity(db,kind,id,{status,version,...},user).
  if(status&&typeof status==='object'){user=input;input=status;status=input.status;}
  ({kind}=entity(kind));input=input||{};
  try{return db.transaction(()=>{
    const before=load(db,kind,id,user);expectVersion(before,input);
    if(!(ENTITY_DEFS[kind].transitions[before.status]||[]).includes(status))fail(`Cannot change ${before.status} to ${status}`,409,'INVALID_TRANSITION');
    const permitted={approvals:['vendor_code','approval_date','valid_until','document_id'],
      funding:['principal_paise','discount_rate','basis','term_days','day_basis','discount_paise','fees_paise','taxes_paise','actual_received_paise','expected_settlement','bank_reference','receivable_id','collection_id','bank_transaction_id']}[kind]||[];
    for(const key of Object.keys(input))if(!['version','status','remarks',...permitted].includes(key))fail(`Field ${key} cannot be changed by a status action`);
    const changes=cleanData(ENTITY_DEFS[kind],{...input,status},true);changes.status=status;
    if(kind==='funding'&&['funding_approved','funded','reconciled','closed'].includes(before.status)) {
      const locked=['principal_paise','discount_rate','basis','term_days','day_basis','discount_paise','fees_paise','taxes_paise'];
      if(['funded','reconciled','closed'].includes(before.status))locked.push('actual_received_paise','bank_reference');
      for(const key of locked)if(Object.hasOwn(changes,key)&&changes[key]!==before[key])fail('Approved financial values are locked',409,'FINANCIAL_LOCKED');
    }
    validateReferences(db,kind,{...before,...changes},user);
    if(kind==='registrations') {
      if(['approved','enquiry_received','quote_sent','po_received'].includes(status))fail('This stage is updated from the approval or enquiry transaction',409,'RELATED_ACTION_REQUIRED');
      if(status==='submitted'){requireDocuments(db,before.id);changes.submitted_at=before.submitted_at||now();}
    }
    if(kind==='approvals')approvalAction(db,before,changes,user);
    if(kind==='enquiries')enquiryAction(db,before,changes,user);
    if(kind==='accounts')changes.account_status=['active','frozen'].includes(status)?status:'inactive';
    if(kind==='invoices')invoiceAction(db,before,changes,user);
    if(kind==='funding')fundingAction(db,before,changes,user);
    const saved=persist(db,kind,before,changes,user,'status',changes.remarks||input.remarks);
    return {...saved,allowed_transitions:allowedTransitions(db,kind,saved,user)};
  })();}catch(error){translateConstraint(error);}
}
function getDetail(db,kind,id,user) {
  ({kind}=entity(kind));const row=load(db,kind,id,user);
  return {...row,...(kind==='registrations'?{...customerProfile(db,row.customer_id),owner_name:db.prepare('SELECT name FROM users WHERE id=?').get(row.owner_id)?.name}:{}),allowed_transitions:allowedTransitions(db,kind,row,user)};
}
function getHistory(db,kind,id,user) {
  ({kind}=entity(kind));load(db,kind,id,user);
  return db.prepare(`SELECT h.*,u.name AS actor_name FROM vt_history h LEFT JOIN users u ON u.id=h.actor_id
    WHERE h.entity_type=? AND h.entity_id=? ORDER BY h.changed_at DESC,h.id DESC LIMIT 500`).all(kind,Number(id));
}
// Four-stage actions reuse the same registration, documents, approval and CRM enquiry.
// The transaction/version guard prevents a partial acceptance or duplicate retry.
function advanceRegistration(db,id,input,user) {
  return db.transaction(()=>{
    const before=load(db,'registrations',id,user);expectVersion(before,input);
    const action=input.action;
    const fields={start_documents:[],submit_documents:[],accept_portal:['portal_url','portal_login_id','vendor_code','approval_date','remarks'],
      record_enquiry:['enquiry_date','rfq_number','product_service','due_date','expected_amount_paise','remarks']}[action];
    if(!fields)fail('Choose a valid registration stage action');
    for(const key of Object.keys(input))if(!['version','action',...fields].includes(key))fail(`Unknown stage field: ${key}`);
    if(action==='start_documents'||action==='submit_documents') {
      return transitionEntity(db,'registrations',id,{version:before.version,status:action==='start_documents'?'started':'submitted'},user);
    }
    if(action==='accept_portal') {
      if(before.status!=='submitted'||!before.submitted_at)fail('Submit the documents before recording portal acceptance',409,'DOCUMENTS_NOT_SUBMITTED');
      requireDocuments(db,id);
      if(!String(input.portal_url||'').trim())fail('Vendor portal URL is required');
      date(input.approval_date,'approval_date');
      if(input.approval_date<before.registration_date||input.approval_date>istToday())fail('Acceptance date must be between registration date and today');
      updateEntity(db,'registrations',id,{version:before.version,portal_url:input.portal_url,portal_login_id:input.portal_login_id||null},user);
      let approval=db.prepare("SELECT * FROM vt_approvals WHERE registration_id=? AND status IN ('pending','docs_pending','under_review') ORDER BY id DESC LIMIT 1").get(id);
      if(approval)assertScope(db,'approvals',approval,user);
      else approval=createEntity(db,'approvals',{registration_id:id,application_date:new Date(Date.parse(before.submitted_at)+19800000).toISOString().slice(0,10),owner_id:before.owner_id},user);
      transitionEntity(db,'approvals',approval.id,{version:approval.version,status:'approved',vendor_code:input.vendor_code||null,
        approval_date:input.approval_date,remarks:input.remarks||null},user);
    }
    if(action==='record_enquiry') {
      if(!['approved','enquiry_received','quote_sent','po_received'].includes(before.status))fail('Record portal acceptance before adding an enquiry',409,'PORTAL_NOT_ACCEPTED');
      const payload=Object.fromEntries(fields.filter(key=>Object.hasOwn(input,key)).map(key=>[key,input[key]]));
      if(!String(payload.product_service||'').trim()&&!String(payload.rfq_number||'').trim())fail('Enter an enquiry reference or requirement');
      const accepted=db.prepare("SELECT MAX(approval_date) day FROM vt_approvals WHERE registration_id=? AND status='approved'").get(id)?.day;
      date(payload.enquiry_date,'enquiry_date');
      if(payload.enquiry_date<(accepted||before.registration_date)||payload.enquiry_date>istToday())fail('Enquiry date must be between acceptance date and today');
      createEntity(db,'enquiries',{...payload,registration_id:id,customer_id:before.customer_id,owner_id:before.owner_id},user);
      const current=load(db,'registrations',id,user);
      if(current.version===before.version)persist(db,'registrations',current,{},user,'enquiry_received','Another enquiry recorded');
    }
    return getDetail(db,'registrations',id,user);
  })();
}
module.exports = {advanceRegistration,createEntity,updateEntity,transitionEntity,getDetail,getHistory,requiredDocuments,assertScope,ownerVisible,
  findDuplicateCandidates,customerProfile,normalizeDomain,fail};
