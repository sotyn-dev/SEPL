const { istToday } = require('./istDate');
const { completedThrough } = require('./installationBillingPeriod');
const money = n => Math.round((+n || 0) * 100) / 100;
const daysBetween = (a,b) => Math.floor((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
function date(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0,10)!==value) throw Error('Enter a valid date');
  return value;
}
function ensure(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS ra_billing_rules (
    project_id INTEGER PRIMARY KEY REFERENCES business_book(id), mode TEXT NOT NULL DEFAULT 'rolling',
    amount_limit REAL, payment_days INTEGER, owner_id INTEGER REFERENCES users(id), pm_id INTEGER REFERENCES users(id), head_id INTEGER REFERENCES users(id),
    client_email TEXT, updated_by INTEGER, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS ra_bill_workflow (
    bill_id INTEGER PRIMARY KEY REFERENCES sales_bills(id) ON DELETE CASCADE, documents TEXT NOT NULL DEFAULT '[]',
    submitted_on TEXT, submitted_by INTEGER, submission_reference TEXT, submission_proof TEXT, payment_days INTEGER,
    signed_file TEXT, signed_on TEXT, signed_by INTEGER, receipt_id INTEGER, snapshot TEXT,
    mail_state TEXT, mail_error TEXT, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS ra_bill_events (
    id INTEGER PRIMARY KEY, bill_id INTEGER REFERENCES sales_bills(id) ON DELETE CASCADE, event TEXT NOT NULL,
    detail TEXT, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS ra_bill_reminders (
    bill_id INTEGER REFERENCES sales_bills(id) ON DELETE CASCADE, stage INTEGER, user_id INTEGER, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY(bill_id,stage));`);
}
function rule(db,id) { ensure(db); return db.prepare('SELECT * FROM ra_billing_rules WHERE project_id=?').get(id) || {project_id:id,mode:'rolling',amount_limit:null,payment_days:null}; }
function saveRule(db,id,b,user) {
  ensure(db);
  if (!db.prepare('SELECT id FROM business_book WHERE id=?').get(id)) throw Error('Project not found');
  if(db.prepare("SELECT 1 FROM ra_bill_workflow w JOIN sales_bills b ON b.id=w.bill_id WHERE b.business_book_id=? AND w.mail_state='sending'").get(id))throw Error('Verify the pending email outcome before changing billing rules');
  if (!['rolling','calendar'].includes(b.mode)) throw Error('Choose a billing cycle');
  const limit=b.amount_limit===''||b.amount_limit==null?null:Number(b.amount_limit);
  const terms=b.payment_days===''||b.payment_days==null?null:Number(b.payment_days);
  if(limit!==null&&(!Number.isFinite(limit)||limit<=0))throw Error('Amount limit must be positive');
  if(terms!==null&&(!Number.isInteger(terms)||terms<0||terms>365))throw Error('Payment terms must be 0–365 days');
  const ids=['owner_id','pm_id','head_id'].map(k=>{
    if(!b[k])return null;
    if(!db.prepare('SELECT id FROM users WHERE id=? AND active=1').get(b[k]))throw Error('Select an active follow-up owner');
    return +b[k];
  });
  const email=String(b.client_email||'').trim();
  if(email&&!/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(email))throw Error('Enter one valid client email');
  db.prepare(`INSERT INTO ra_billing_rules(project_id,mode,amount_limit,payment_days,owner_id,pm_id,head_id,client_email,updated_by)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(project_id) DO UPDATE SET mode=excluded.mode,amount_limit=excluded.amount_limit,payment_days=excluded.payment_days,
    owner_id=excluded.owner_id,pm_id=excluded.pm_id,head_id=excluded.head_id,client_email=excluded.client_email,updated_by=excluded.updated_by,updated_at=CURRENT_TIMESTAMP`).run(id,b.mode,limit,terms,...ids,email,user);
  return rule(db,id);
}
// Net installation value, excluding GST; use the same contracted-rate resolver as invoice generation.
function queue(db, value, today=istToday()) {
  ensure(db);
  const rows=db.prepare(`SELECT d.id,d.report_date,d.approval_status,s.business_book_id,bb.project_name,bb.client_name,bb.company_name,bb.payment_against_installation
    FROM dpr d JOIN sites s ON s.id=d.site_id JOIN business_book bb ON bb.id=s.business_book_id
    WHERE d.sales_bill_id IS NULL AND d.report_date<=? AND d.approval_status IN ('approved','pending') ORDER BY d.report_date,d.id`).all(today);
  const groups=new Map();
  for(const d of rows){
    const id=d.business_book_id;
    if(!groups.has(id))groups.set(id,{project_id:id,project_name:d.project_name,customer:d.client_name||d.company_name,rule:rule(db,id),approved_value:0,pending_value:0,dprs:[]});
    const g=groups.get(id), pct=parseFloat(String(d.payment_against_installation||'').replace(/[^0-9.]/g,''))||100;
    const amount=money(value([d.id],id).totalSitcVal*pct/100);
    g.dprs.push({id:d.id,date:d.report_date,status:d.approval_status,amount});
    if(d.approval_status==='approved')g.approved_value=money(g.approved_value+amount); else g.pending_value=money(g.pending_value+amount);
  }
  return [...groups.values()].map(g=>{
    const approved=g.dprs.filter(d=>d.status==='approved');
    g.oldest_date=approved[0]?.date||null;
    g.age_days=g.oldest_date?daysBetween(g.oldest_date,today):0;
    const amountDue=!!g.rule.amount_limit&&g.approved_value>=g.rule.amount_limit;
    const dated=approved.filter(d=>g.rule.mode==='calendar'?d.date<=completedThrough(today):g.age_days>=15);
    g.eligible_ids=(amountDue?approved:dated).map(d=>d.id);
    g.trigger=amountDue?'Amount limit reached':g.eligible_ids.length?'15-day cycle due':'Accumulating daily work';
    g.eligible_value=money(g.dprs.filter(d=>g.eligible_ids.includes(d.id)).reduce((n,d)=>n+d.amount,0));
    return g;
  });
}
function bill(db,id) {
  ensure(db);
  const b=db.prepare('SELECT * FROM sales_bills WHERE id=? AND bill_type=3').get(id);
  if(!b)throw Error('RA / installation bill not found');
  db.prepare('INSERT OR IGNORE INTO ra_bill_workflow(bill_id) VALUES(?)').run(id);
  return b;
}
function approved(db,id) {
  const linked=db.prepare('SELECT approval_status FROM dpr WHERE sales_bill_id=?').all(id);
  if(!linked.length||linked.some(d=>d.approval_status!=='approved'))throw Error('Every linked DPR must be approved before submission');
}
function workflow(db,id) { bill(db,id); return db.prepare('SELECT * FROM ra_bill_workflow WHERE bill_id=?').get(id); }
function documents(db,id) { return JSON.parse(workflow(db,id).documents||'[]'); }
function addDocument(db,id,doc,user) {
  const w=workflow(db,id);
  if(w.submitted_on||w.mail_state)throw Error('Submitted or emailing bill pack is locked');
  if(!['measurement','report','photo'].includes(doc.kind))throw Error('Choose measurement, report or photo');
  const docs=JSON.parse(w.documents); docs.push({kind:doc.kind,path:doc.path,name:String(doc.name||'Document').slice(0,160)});
  db.prepare('UPDATE ra_bill_workflow SET documents=?,updated_at=CURRENT_TIMESTAMP WHERE bill_id=?').run(JSON.stringify(docs),id);
  event(db,id,'document_added',doc.kind,user);
}
function event(db,id,type,detail,user=null){db.prepare('INSERT INTO ra_bill_events(bill_id,event,detail,user_id) VALUES(?,?,?,?)').run(id,type,detail,user);}
function pack(db,id) {
  const b=bill(db,id), w=workflow(db,id); approved(db,id);
  const docs=JSON.parse(w.documents);
  const missing=['measurement','report','photo'].filter(kind=>!docs.some(d=>d.kind===kind));
  if(missing.length)throw Error('Complete the bill pack: '+missing.join(', '));
  const items=db.prepare('SELECT description,qty_delivered,unit,rate,amount FROM sales_bill_items WHERE sales_bill_id=? ORDER BY id').all(id);
  const dprs=db.prepare('SELECT id,report_date,approval_status FROM dpr WHERE sales_bill_id=? ORDER BY report_date,id').all(id);
  return {bill:b,order:db.prepare('SELECT * FROM business_book WHERE id=?').get(b.business_book_id),items,dprs,documents:docs};
}
function submit(db,id,b,user,today=istToday()) {
  const p=pack(db,id), w=workflow(db,id), r=rule(db,p.bill.business_book_id);
  if(w.submitted_on)return w;
  const submitted=date(b.submitted_on);
  if(submitted>today||submitted<p.bill.bill_date)throw Error('Submission must be between bill date and today');
  if(r.payment_days==null)throw Error('Set the agreed client payment terms first');
  if(!r.owner_id||!r.pm_id||!r.head_id)throw Error('Set the day-3 owner, day-5 PM and day-7 Head first');
  if(!b.submission_proof || !String(b.reference||'').trim())throw Error('Submission reference and evidence are required');
  return db.transaction(()=>{
    db.prepare(`UPDATE ra_bill_workflow SET submitted_on=?,submitted_by=?,submission_reference=?,submission_proof=?,payment_days=?,snapshot=?,updated_at=CURRENT_TIMESTAMP WHERE bill_id=?`).run(submitted,user,String(b.reference).slice(0,500),b.submission_proof,r.payment_days,JSON.stringify(p),id);
    db.prepare('UPDATE sales_bills SET sent_to_client=1,sent_at=? WHERE id=?').run(submitted,id);
    event(db,id,'submitted',`${submitted}; ${b.reference}`,user);
    syncCollection(db,id,today);
    return workflow(db,id);
  })();
}
function syncCollection(db,id,today=istToday()) {
  const b=bill(db,id),w=workflow(db,id);
  if(!w.submitted_on)return;
  const paid=money(db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE reference_type='sales_bill' AND reference_id=?").get(id).n);
  const outstanding=Math.max(0,money(b.total_amount-paid));
  const due=new Date(Date.parse(w.submitted_on+'T00:00:00Z')+w.payment_days*86400000).toISOString().slice(0,10);
  const age=Math.max(0,daysBetween(due,today)), bucket=age<=30?'0-30':age<=60?'31-60':age<=90?'61-90':'90+';
  const status=outstanding<=0.01?'green':paid>0?'yellow':'red';
  const existing=db.prepare('SELECT id FROM receivables WHERE invoice_number=?').get(b.bill_number);
  let rid=existing?.id;
  if(rid)db.prepare('UPDATE receivables SET invoice_amount=?,received_amount=?,outstanding_amount=?,due_date=?,ageing_days=?,ageing_bucket=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(b.total_amount,paid,outstanding,due,age,bucket,status,rid);
  else rid=db.prepare(`INSERT INTO receivables(client_name,project_name,business_book_id,invoice_number,invoice_date,invoice_amount,received_amount,outstanding_amount,due_date,ageing_days,ageing_bucket,status,owner_id,created_by)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(b.customer_name||'Customer',b.project_name,b.business_book_id,b.bill_number,w.submitted_on,b.total_amount,paid,outstanding,due,age,bucket,status,rule(db,b.business_book_id).owner_id||null,w.submitted_by).lastInsertRowid;
  db.prepare('UPDATE ra_bill_workflow SET receipt_id=? WHERE bill_id=?').run(rid,id);
}
function sign(db,id,b,user,today=istToday()) {
  const w=workflow(db,id);
  if(!w.submitted_on)throw Error('Record bill submission first');
  if(w.signed_file)throw Error('Signed copy is already recorded');
  const signed=date(b.signed_on);
  if(signed<w.submitted_on||signed>today)throw Error('Signing date must be between submission and today');
  if(!b.path)throw Error('Upload the signed copy');
  db.prepare('UPDATE ra_bill_workflow SET signed_on=?,signed_file=?,signed_by=?,updated_at=CURRENT_TIMESTAMP WHERE bill_id=?').run(signed,b.path,user,id);
  event(db,id,'signed_copy',signed,user);
  return workflow(db,id);
}
function followups(db,today=istToday()) {
  ensure(db);
  const rows=db.prepare(`SELECT w.*,sb.bill_number,sb.business_book_id FROM ra_bill_workflow w JOIN sales_bills sb ON sb.id=w.bill_id WHERE w.submitted_on IS NOT NULL`).all();
  let posted=0;
  for(const w of rows){
    syncCollection(db,w.bill_id,today);
    if(w.signed_file)continue;
    const age=daysBetween(w.submitted_on,today),r=rule(db,w.business_book_id);
    for(const [stage,uid] of [[3,r.owner_id],[5,r.pm_id],[7,r.head_id]]){
      if(age<stage||!uid||db.prepare('SELECT 1 FROM ra_bill_reminders WHERE bill_id=? AND stage=?').get(w.bill_id,stage))continue;
      db.transaction(()=>{
        db.prepare(`INSERT INTO notifications(user_id,type,title,body,link_url,channel_sent,dedupe_key) VALUES(?,'generic',?,?,?,'in_app',?)`).run(uid,`Unsigned RA bill: day ${stage}`,`${w.bill_number} submitted ${w.submitted_on}; signed copy is still pending.`, '/installation?tab=ra',`ra-signature-${w.bill_id}-${stage}`);
        db.prepare('INSERT INTO ra_bill_reminders(bill_id,stage,user_id) VALUES(?,?,?)').run(w.bill_id,stage,uid);
        event(db,w.bill_id,'signature_reminder',`Day ${stage}: user ${uid}`);
      })(); posted++;
    }
  }
  return {posted};
}
module.exports={ensure,rule,saveRule,queue,bill,workflow,documents,addDocument,pack,submit,sign,syncCollection,followups,event,date};
