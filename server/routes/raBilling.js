const express=require('express');
const {getDb}=require('../db/schema');
const {requirePermission}=require('../middleware/auth');
const flow=require('../lib/raBillingWorkflow');
const {istToday}=require('../lib/istDate');
const storage=require('../lib/storage');
const router=express.Router();
const view=requirePermission('installation','view'),edit=requirePermission('installation','edit');
const safe=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){res.status(400).json({error:e.message});}};
const values=(db)=>(ids,bb)=>require('./salesBilling').getDprSitcWorkItems(db,{dprIds:ids,businessBookId:bb});
async function filePath(path){
  if(typeof path!=='string'||!path.startsWith('/uploads/'))throw Error('Upload a file first');
  const key=storage.safeKey(path.slice(9));
  if(!key||!(await storage.exists(key)))throw Error('Uploaded file is missing');
  return '/uploads/'+key;
}
router.get('/',view,safe((req,res)=>{
  const db=getDb();flow.ensure(db);
  const bills=db.prepare(`SELECT sb.*,w.submitted_on,w.signed_on,w.signed_file,w.submission_reference,w.mail_state,w.mail_error,
    w.documents,w.payment_days,w.receipt_id,r.due_date,r.outstanding_amount,r.ageing_days
    FROM sales_bills sb LEFT JOIN ra_bill_workflow w ON w.bill_id=sb.id LEFT JOIN receivables r ON r.id=w.receipt_id
    WHERE sb.bill_type=3 ORDER BY sb.id DESC`).all();
  res.json({queue:flow.queue(db,values(db)),bills,users:db.prepare('SELECT id,name FROM users WHERE active=1 ORDER BY name').all()});
}));
router.put('/rules/:id',requirePermission('installation','approve'),safe((req,res)=>res.json(flow.saveRule(getDb(),+req.params.id,req.body,req.user.id))));
router.get('/rules/:id',view,safe((req,res)=>res.json(flow.rule(getDb(),+req.params.id))));
router.post('/generate',requirePermission('installation','create'),safe((req,res)=>res.json(require('./salesBilling').generateInstallationBills(getDb(),req.user.id))));
router.get('/bills/:id',view,safe((req,res)=>{
  const db=getDb(),bill=flow.bill(db,+req.params.id);
  const dprs=db.prepare('SELECT id,report_date,site_photos FROM dpr WHERE sales_bill_id=?').all(bill.id);
  res.json({bill,workflow:flow.workflow(db,bill.id),rule:flow.rule(db,bill.business_book_id),dprs,
    events:db.prepare('SELECT e.*,u.name AS actor FROM ra_bill_events e LEFT JOIN users u ON u.id=e.user_id WHERE bill_id=? ORDER BY e.id DESC').all(bill.id)});
}));
router.post('/bills/:id/documents',edit,safe(async(req,res)=>{
  const path=await filePath(req.body.path);flow.addDocument(getDb(),+req.params.id,{...req.body,path},req.user.id);res.json({ok:true});
}));
router.delete('/bills/:id/documents/:index',edit,safe((req,res)=>{
  const db=getDb(),w=flow.workflow(db,+req.params.id);if(w.submitted_on||w.mail_state)throw Error('Submitted or emailing bill pack is locked');
  const docs=JSON.parse(w.documents),i=Number(req.params.index);if(!Number.isInteger(i)||!docs[i])throw Error('Document not found');
  docs.splice(i,1);db.prepare('UPDATE ra_bill_workflow SET documents=? WHERE bill_id=?').run(JSON.stringify(docs),w.bill_id);
  flow.event(db,w.bill_id,'document_removed','Pack attachment removed',req.user.id);res.json({ok:true});
}));
const escape=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function packBuffer(db,id){
  const w=flow.workflow(db,id),p=w.snapshot?JSON.parse(w.snapshot):flow.pack(db,id);
  const attachments=[];let size=0;
  for(const d of p.documents){
    const path=await filePath(d.path),key=path.slice(9),meta=await storage.statKey(key);
    size+=meta?.size||0;if(size>25*1024*1024)throw Error('Bill pack exceeds 25 MB; use smaller attachments');
    const data=await storage.getObject(key);if(!data)throw Error('A bill-pack attachment could not be read');attachments.push({name:`${d.kind}/${attachments.length+1}-${key.split('/').pop()}`,data});
  }
  const zip=require('archiver')('zip',{zlib:{level:6}}),parts=[];
  const complete=new Promise((resolve,reject)=>{zip.on('data',b=>parts.push(b));zip.on('error',reject);zip.on('end',()=>resolve(Buffer.concat(parts)));});
  const b=p.bill;
  const sum=p.items.reduce((n,i)=>n+(+i.amount||0),0);let allocated=0;
  const billedItems=p.items.map((i,index)=>{const amount=index===p.items.length-1?Math.round((b.amount-allocated)*100)/100:Math.round((sum?i.amount*b.amount/sum:0)*100)/100;allocated+=amount;return {...i,amount,rate:i.qty_delivered?amount/i.qty_delivered:0};});
  zip.append(require('./salesBilling').installBillHTML({bill:b,items:billedItems,bb:p.order||{}}),{name:'Tax-invoice.html'});
  zip.append(`<html><meta charset="utf-8"><title>RA bill pack ${escape(b.bill_number)}</title><body><h1>RA bill ${escape(b.bill_number)}</h1><p>${escape(b.customer_name)} · ${escape(b.project_name)} · ${escape(b.bill_date)}</p><p>${escape(b.reference_doc_no)}</p><table border="1" cellpadding="8"><tr><th>Item</th><th>Quantity</th><th>Unit</th><th>Rate</th><th>Work value</th></tr>${p.items.map(i=>`<tr><td>${escape(i.description)}</td><td>${escape(i.qty_delivered)}</td><td>${escape(i.unit)}</td><td>${escape(i.rate)}</td><td>${escape(i.amount)}</td></tr>`).join('')}</table><p>Billable amount: ${escape(b.amount)} · GST: ${escape(b.gst_amount)} · Total: ${escape(b.total_amount)}</p><p>Supporting documents are included in this ZIP. Use ERP Print Tax Invoice for the tax-invoice layout.</p></body></html>`,{name:'RA-bill-summary.html'});
  zip.append(JSON.stringify({bill_number:b.bill_number,dprs:p.dprs.map(d=>({id:d.id,date:d.report_date})),documents:p.documents.map(d=>({kind:d.kind,name:d.name}))},null,2),{name:'Contents.json'});
  attachments.forEach(d=>zip.append(d.data,{name:d.name}));zip.finalize();return complete;
}
router.get('/bills/:id/pack',view,safe(async(req,res)=>{const data=await packBuffer(getDb(),+req.params.id);res.type('zip').attachment(`RA-bill-${req.params.id}-pack.zip`).send(data);}));
router.post('/bills/:id/submit',edit,safe(async(req,res)=>{
  const proof=await filePath(req.body.submission_proof);
  res.json(flow.submit(getDb(),+req.params.id,{...req.body,submission_proof:proof},req.user.id));
}));
// Sending is explicit, with an immutable pack and an outbox state. Unknown SMTP
// outcomes stay visible and cannot be silently retried into duplicate mail.
router.post('/bills/:id/email',edit,safe(async(req,res)=>{
  const db=getDb(),id=+req.params.id,bill=flow.bill(db,id),r=flow.rule(db,bill.business_book_id),w=flow.workflow(db,id);
  if(w.submitted_on||w.mail_state==='sending'||w.mail_state==='sent')throw Error('Already submitted or email delivery needs verification');
  if(!r.client_email||r.payment_days==null||!r.owner_id||!r.pm_id||!r.head_id)throw Error('Configure client email, payment terms and all follow-up owners first');
  const mail=require('../lib/email');if(!mail.isConfigured())throw Error('Configure SMTP in Email Settings first');
  const data=await packBuffer(db,id);
  const claimed=db.prepare("UPDATE ra_bill_workflow SET mail_state='sending',mail_error=NULL WHERE bill_id=? AND submitted_on IS NULL AND COALESCE(mail_state,'') NOT IN ('sending','sent')").run(id);
  if(!claimed.changes)throw Error('Submission is already in progress');
  try {
    const result=await mail.sendEmail({to:r.client_email,subject:`RA bill ${bill.bill_number}`,text:`Please find attached bill ${bill.bill_number}, measurements, report and photographs for ${bill.project_name||'your project'}. Please return the signed copy.`,attachments:[{filename:`RA-${id}.zip`,content:data}]});
    if(result?.skipped)throw Error('Email was not sent');
    db.prepare("UPDATE ra_bill_workflow SET mail_state='sent' WHERE bill_id=?").run(id);
    res.json(flow.submit(db,id,{submitted_on:istToday(),reference:`Email to ${r.client_email}`,submission_proof:`smtp:${result?.messageId||'accepted'}`},req.user.id));
  } catch(e){db.prepare('UPDATE ra_bill_workflow SET mail_error=? WHERE bill_id=?').run(e.message,id);throw Error('Email outcome needs verification. Check mailbox before recording manual submission: '+e.message);}
}));
router.post('/bills/:id/sign',edit,safe(async(req,res)=>res.json(flow.sign(getDb(),+req.params.id,{...req.body,path:await filePath(req.body.path)},req.user.id))));
module.exports=router;
