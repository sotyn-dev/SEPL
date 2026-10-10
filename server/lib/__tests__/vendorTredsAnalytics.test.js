const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { ensureVendorTredsSchema } = require('../../db/vendorTredsSchema');
const { calculateFundingTerms } = require('../vendorTreds/finance');
const { listEntity, buildQuery } = require('../vendorTreds/queries');
const { getDefaultConfig, getConfig, appendConfigVersion, getDashboard, getWeeklyKpis, listTrackerEvents } = require('../vendorTreds/kpis');
const { REPORT_CATALOG, reportRows, exportXlsx } = require('../vendorTreds/reports');
const { addDocument } = require('../vendorTreds/documents');
const storage = require('../storage');

function fixture() {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,active INTEGER DEFAULT 1,archived INTEGER DEFAULT 0);
    CREATE TABLE customers(id INTEGER PRIMARY KEY,company_name TEXT,category TEXT);
    CREATE TABLE vendors(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE crm_funnel(id INTEGER PRIMARY KEY);
    CREATE TABLE sales_bills(id INTEGER PRIMARY KEY,total_amount REAL,bill_date TEXT);
    CREATE TABLE receivables(id INTEGER PRIMARY KEY);
    CREATE TABLE collections(id INTEGER PRIMARY KEY);
    CREATE TABLE bank_transactions(id INTEGER PRIMARY KEY);
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE pms_tasks(id INTEGER PRIMARY KEY,title TEXT,description TEXT,due_date TEXT,status TEXT,reviewed_at TEXT,assigned_to INTEGER);
    INSERT INTO users(id,name) VALUES(1,'Owner One'),(2,'Owner Two'),(3,'Manager');
    INSERT INTO customers(id,company_name) VALUES(1,'Client One'),(2,'Client Two');
    INSERT INTO vendors(id,name) VALUES(1,'Existing Seller');
    INSERT INTO crm_funnel(id) VALUES(1),(2);
    INSERT INTO sales_bills(id,total_amount,bill_date) VALUES(1,1000000,'2026-10-01'),(2,300000,'2026-10-01'),(3,5000000,'2026-10-01');`);
  require('../../db/dailyWork').initialize(db);
  ensureVendorTredsSchema(db);
  const config = getDefaultConfig();
  config.versions[0].program_start_date = '2026-09-21'; config.versions[0].responsible_owner_ids = [1,2];
  db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run('vendor_treds_settings',JSON.stringify(config));
  const platform = db.prepare("SELECT id FROM vt_catalog WHERE kind='platform' AND code='rxil'").get().id;
  const otherPlatform = db.prepare("SELECT id FROM vt_catalog WHERE kind='platform' AND code='m1xchange'").get().id;
  db.exec(`INSERT INTO vt_registrations(id,customer_id,owner_id,registration_date,status) VALUES(1,1,1,'2026-10-07','approved'),(2,2,2,'2026-10-07','started');
    INSERT INTO vt_approvals(registration_id,application_date,status,vendor_code,approval_date,owner_id) VALUES
      (1,'2026-10-01','approved','C-ONE','2026-10-05',1),(1,'2026-10-02','approved','C-TWO','2026-10-06',1);
    INSERT INTO vt_enquiries(id,crm_funnel_id,registration_id,customer_id,enquiry_date,owner_id,status,is_mnc) VALUES(1,1,1,1,'2026-10-05',1,'po_received',1),(2,2,2,2,'2026-10-05',2,'rfq_received',1);
    INSERT INTO vt_contacts(id,customer_id,kind,name,owner_id) VALUES(1,1,'ap','Recorded AP Contact',1);`);
  db.prepare("INSERT INTO vt_accounts(id,platform_id,vendor_id,status,account_status,owner_id) VALUES(1,?,1,'active','active',1),(2,?,1,'frozen','frozen',2)").run(platform,otherPlatform);
  db.prepare('INSERT INTO vt_mappings(id,customer_id,platform_id,account_id,contact_id,owner_id) VALUES(1,1,?,1,1,1)').run(platform);
  db.exec(`INSERT INTO vt_followups(id,mapping_id,owner_id,contact_at,next_followup_at,notes) VALUES(1,1,1,'2026-10-05 12:00:00','2026-10-09 12:00:00','Actual AP conversation');`);
  const invoice = db.prepare(`INSERT INTO vt_invoices(id,sales_bill_id,customer_id,registration_id,account_id,platform_id,
    external_invoice_number,invoice_number_key,invoice_date,amount_paise,owner_id,status,uploaded_at,accepted_at,bid_at,funded_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  invoice.run(1,1,1,1,1,platform,'INV-1','INV-1','2026-10-01',100000000,1,'funded','2026-10-05 23:00:00','2026-10-06 12:00:00','2026-10-07 10:00:00','2026-10-07 23:00:00');
  invoice.run(2,2,1,1,1,platform,'INV-2','INV-2','2026-10-01',30000000,1,'uploaded','2026-10-04 23:00:00',null,null,null);
  invoice.run(3,3,2,2,2,otherPlatform,'INV-3','INV-3','2026-10-01',500000000,2,'funded','2026-10-05 12:00:00','2026-10-06 12:00:00','2026-10-07 10:00:00','2026-10-07 12:00:00');
  db.exec(`INSERT INTO vt_funding(id,invoice_id,principal_paise,discount_rate,basis,day_basis,actual_received_paise,status,funded_at,owner_id)
    VALUES(1,1,100000000,9,'annualized',365,98000000,'funded','2026-10-07 23:00:00',1),
      (2,2,NULL,NULL,NULL,NULL,NULL,'invoice_uploaded',NULL,1),
      (3,3,500000000,5,'flat',NULL,400000000,'funded','2026-10-07 12:00:00',2);`);
  const history = db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,new_status,after_json,actor_id,changed_at) VALUES(?,?,?,?,?,?,?)');
  history.run('invoices',1,'create','uploaded',JSON.stringify({uploaded_at:'2026-10-05 23:00:00'}),1,'2026-10-05 23:10:00');
  history.run('followups',1,'create',null,JSON.stringify({contact_at:'2026-10-05 12:00:00'}),1,'2026-10-07 12:00:00');
  history.run('invoices',1,'update','funded',JSON.stringify({remarks:'Private comment'}),1,'2026-10-07 12:00:00');
  history.run('enquiries',1,'status','po_received',JSON.stringify({status:'po_received'}),1,'2026-10-06 12:00:00');
  return db;
}
const own = {ownerIds:[1]};
const period = {date_from:'2026-10-05',date_to:'2026-10-10'};

test('funding calculations keep actual receipts independent and missing terms unknown', () => {
  assert.equal(calculateFundingTerms({principal_paise:100000000,discount_rate:9,basis:'annualized',term_days:60,day_basis:365,fees_paise:0,taxes_paise:0}).discount_paise,1479452);
  const flat = calculateFundingTerms({principal_paise:10000,discount_rate:2,basis:'flat',fees_paise:0,taxes_paise:0});
  assert.equal(flat.expected_net_paise,9800); assert.equal(Object.hasOwn(flat,'actual_received_paise'),false);
  assert.equal(calculateFundingTerms({principal_paise:10000,discount_rate:2,basis:'flat'}).expected_net_paise,null);
  assert.equal(calculateFundingTerms({principal_paise:10000,discount_rate:2,basis:'annualized',term_days:30}).discount_paise,null);
  assert.equal(calculateFundingTerms({actual_received_paise:0}).actual_received_paise,0);
  for (const invalid of [{principal_paise:-1},{principal_paise:0},{fees_paise:1.5},{fees_paise:true},{discount_rate:Infinity},{discount_rate:true},{day_basis:366},{basis:'monthly'}]) assert.throws(()=>calculateFundingTerms(invalid));
  assert.equal(calculateFundingTerms({principal_paise:Number.MAX_SAFE_INTEGER,discount_rate:100,basis:'flat'}).discount_paise,Number.MAX_SAFE_INTEGER);
  assert.throws(()=>calculateFundingTerms({principal_paise:100,discount_paise:80,fees_paise:30,taxes_paise:0}));
});

test('query scopes are mandatory and filters/sorting remain bound or allowlisted', () => {
  const db=fixture();try {
    assert.equal(listEntity(db,'registrations',{},own).total,1);
    const registration=listEntity(db,'registrations',{},own).rows[0];
    assert.equal(registration.enquiry_status,'po_received');
    assert.equal(registration.treds_status,'RXIL: active');
    assert.equal(listEntity(db,'registrations',{}, {ownerIds:[]}).total,0);
    assert.equal(listEntity(db,'registrations',{}).total,0);
    assert.equal(listEntity(db,'registrations',{}, {ownerIds:null}).total,2);
    assert.equal(listEntity(db,'registrations',{owner_id:2},own).total,0);
    assert.equal(listEntity(db,'registrations',{search:"' OR 1=1 --"},own).total,0);
    assert.throws(()=>buildQuery('invoices',{sort_by:'id; DROP TABLE users'},own),error=>error.status===400);
    assert.throws(()=>buildQuery('invoices',{status:'invented_status'},own),error=>error.status===400);
    assert.throws(()=>buildQuery('invoices',{date_field:'secret'},own));
    assert.throws(()=>buildQuery('invoices',{date_from:'2026-02-31'},own));
    assert.equal(listEntity(db,'invoices',{date_from:'2026-10-08',date_to:'2026-10-08',stage_event:'funded'},own).total,1,'funding period uses IST, not UTC');
    assert.equal(listEntity(db,'invoices',{...period,stage_event:'uploaded',pending_funding:true},own).total,1);
    const invoice=listEntity(db,'invoices',{},own).rows[0];
    assert.equal(Object.hasOwn(invoice,'actual_received_paise'),false,'invoice view does not expose funding terms');
    assert.equal(invoice.canonical_mismatch,0);
    assert.equal(listEntity(db,'catalog',{kind:'platform',active:true},own).total,4,'authorized metadata access is not filtered by business owner');
    assert.equal(listEntity(db,'catalog',{kind:'platform'}, {ownerIds:[]}).total,0);
  } finally {db.close();}
});

test('canonical ERP edits are disclosed without rewriting historical cohort money', () => {
  const db=fixture();try {
    db.prepare('UPDATE sales_bills SET total_amount=?,bill_date=? WHERE id=1').run(1200000,'2026-10-02');
    const invoice=listEntity(db,'invoices',{},own).rows.find(row=>row.id===1);
    assert.equal(invoice.amount_paise,100000000);
    assert.equal(invoice.canonical_amount_paise,120000000);
    assert.equal(invoice.canonical_invoice_date,'2026-10-02');
    assert.equal(invoice.canonical_mismatch,1);
    assert.match(invoice.canonical_warning,/Historical totals retain/);
    const data=getDashboard(db,period,own,{today:'2026-10-07',scopes:{invoices:own,funding:own}});
    assert.equal(data.funding.uploaded_value_paise.value,130000000);
    assert.equal(data.funding.actual_received_paise.value,98000000);
    assert.equal(data.funding.funded_face_value_paise.value,100000000);
    assert.equal(reportRows(db,'funding',period,own).rows[0].canonical_mismatch,1);
  } finally {db.close();}
});

test('settings append effective versions and preserve historical target definitions', () => {
  const db=fixture();try {
    const existing=getDefaultConfig();
    const next=appendConfigVersion(existing,{effective_from:'2026-10-07',targets:{registrations_daily:20}},'2026-10-07');
    db.prepare('UPDATE app_settings SET value=? WHERE key=?').run(JSON.stringify(next),'vendor_treds_settings');
    assert.equal(getConfig(db,'2026-10-06').targets.registrations_daily,10);
    assert.equal(getConfig(db,'2026-10-07').targets.registrations_daily,20);
    assert.equal(getConfig(db,'2026-10-07').program_week,null);
    assert.throws(()=>appendConfigVersion(next,{effective_from:'2026-10-07'},'2026-10-07'),/already exists/);
    assert.throws(()=>appendConfigVersion(next,{effective_from:'2026-10-06'},'2026-10-07'),/past/);
    assert.throws(()=>appendConfigVersion(next,{effective_from:'2026-10-08',reminders:{repeat_days:0}},'2026-10-07'),error=>error.status===400);
    assert.throws(()=>getConfig(db,'2026-02-31'),error=>error.status===400);
    const before=db.prepare('SELECT value FROM app_settings WHERE key=?').get('vendor_treds_settings').value;
    getConfig(db,'2026-10-07');
    assert.equal(db.prepare('SELECT value FROM app_settings WHERE key=?').get('vendor_treds_settings').value,before,'reading config never writes');
  } finally {db.close();}
});

test('dashboard aggregates use actual money and exact list drilldown cohorts', () => {
  const db=fixture();try {
    const dashboard=getDashboard(db,period,own,{today:'2026-10-07',scopes:{registrations:own,enquiries:own,invoices:own,funding:own,followups:own,accounts:own}});
    assert.equal(dashboard.cards.find(item=>item.key==='approved_vendor_codes').value,1,'multiple approval documents/codes do not multiply registrations');
    assert.equal(dashboard.cards.find(item=>item.key==='amount_funded_paise').value,98000000);
    assert.equal(dashboard.funding.financed_principal_paise.value,100000000);
    assert.equal(dashboard.funding.funded_face_value_paise.value,100000000);
    assert.equal(dashboard.funding.pending_value_paise.value,30000000);
    for (const card of dashboard.cards.filter(item=>item.unit==='count')) {
      assert.equal(listEntity(db,card.drilldown.entity,card.drilldown.filters,own).total,card.value,card.key);
    }
    const funded=dashboard.cards.find(item=>item.key==='amount_funded_paise');
    assert.equal(listEntity(db,funded.drilldown.entity,funded.drilldown.filters,own).rows.reduce((sum,row)=>sum+row.actual_received_paise,0),funded.value);
    const privateDashboard=getDashboard(db,period,own,{today:'2026-10-07',scopes:{registrations:own}});
    assert.equal(privateDashboard.cards.some(item=>item.key==='amount_funded_paise'),false);
    assert.deepEqual(privateDashboard.funding,{});
    assert.equal(privateDashboard.platforms.length,0);
  } finally {db.close();}
});

test('dashboard status qualification keeps registration, funding and task cohorts independent',()=>{
  const db=fixture();try{
    db.prepare("UPDATE vt_registrations SET status='submitted' WHERE id=1").run();
    db.exec("INSERT INTO pms_tasks(id,title,due_date,status,assigned_to) VALUES(1,'Blocked vendor review','2026-10-07','pending',1),(2,'Queued review','2026-10-07','pending',1); INSERT INTO vt_task_links(pms_task_id,planning_state,created_by,updated_by) VALUES(1,'blocked',1,1),(2,'planned',1,1)");
    const scopes=Object.fromEntries(['registrations','approvals','enquiries','accounts','invoices','funding','followups','tasks'].map(kind=>[kind,own]));
    for(const selected of [{status:'submitted'},{status:'funded'},{status:'blocked'},{status_entity:'registrations',status:'submitted'},{status_entity:'funding',status:'funded'},{status_entity:'tasks',status:'blocked'}]){
      const dashboard=getDashboard(db,{...period,...selected},own,{today:'2026-10-07',scopes});
      assert.equal(dashboard.cards.find(row=>row.key==='amount_funded_paise').value,98000000);
      for(const card of dashboard.cards.filter(row=>row.unit==='count'))assert.equal(listEntity(db,card.drilldown.entity,card.drilldown.filters,own).total,card.value);
      const taskSelected=selected.status==='blocked';
      assert.equal(dashboard.tasks.total,taskSelected?1:2);
      const registration=dashboard.cards.find(row=>row.key==='registrations_weekly');
      assert.equal(registration.value,1);
      if(selected.status_entity==='funding')assert.equal(registration.drilldown.filters.status,undefined);
      assert.equal(reportRows(db,'weekly_registrations',{...period,...selected},own).total,registration.value);
    }
  }finally{db.close();}
});

test('tracker replays qualified status, source and overdue predicates exactly',()=>{
  const db=fixture();try{
    db.prepare("UPDATE vt_registrations SET source='chatgpt',next_followup_at='2026-10-05T00:00:00.000Z' WHERE id=1").run();
    db.prepare("UPDATE vt_invoices SET due_date='2026-10-06' WHERE id=1").run();
    db.prepare("UPDATE vt_invoices SET due_date='2026-10-09' WHERE id=2").run();
    db.prepare("UPDATE vt_funding SET expected_settlement='2026-10-06' WHERE id=1").run();
    db.prepare("UPDATE vt_funding SET status='funding_approved',approved_at='2026-10-06T00:00:00.000Z',expected_settlement='2026-10-06' WHERE id=2").run();
    const history=db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,new_status,after_json,actor_id,changed_at) VALUES(?,?,?,?,?,?,?)');
    history.run('registrations',1,'create','approved',JSON.stringify({registration_date:'2026-10-07'}),1,'2026-10-07T00:00:00.000Z');
    history.run('funding',1,'status','funded',JSON.stringify({funded_at:'2026-10-07T23:00:00.000Z'}),1,'2026-10-07T23:05:00.000Z');
    history.run('funding',2,'status','funding_approved',JSON.stringify({approved_at:'2026-10-06T00:00:00.000Z'}),1,'2026-10-06T00:05:00.000Z');
    const scopes=Object.fromEntries(['registrations','enquiries','accounts','invoices','funding','followups'].map(kind=>[kind,own]));
    const filters={...period,status_entity:'funding',status:'funded',source:'chatgpt',overdue_as_of:'2026-10-09'};
    const weekly=getWeeklyKpis(db,filters,own,{scopes});
    const tracker=weekly.rows.find(row=>row.key==='tracker_same_day_percent');
    assert.equal(tracker.drilldown.filters.status_entity,'funding');
    assert.equal(tracker.drilldown.filters.status,'funded');
    assert.equal(tracker.drilldown.filters.source,'chatgpt');
    assert.equal(tracker.drilldown.filters.overdue_as_of,'2026-10-09');
    const rows=listTrackerEvents(db,tracker.drilldown.filters,own,{scopes});
    assert.equal(rows.total,tracker.eligible);
    assert.equal(rows.rows.filter(row=>row.same_day).length,tracker.same_day);
    assert.equal(rows.rows.some(row=>row.entity_type==='funding'&&row.entity_id===2),false);
    const uploaded=weekly.rows.find(row=>row.key==='invoices_uploaded');
    assert.equal(uploaded.value,1);
    assert.equal(reportRows(db,'invoice_uploads',filters,own).total,uploaded.value);
    const funded=weekly.rows.find(row=>row.key==='amount_funded_paise');
    assert.equal(reportRows(db,'funding',filters,own).rows.reduce((sum,row)=>sum+row.actual_received_paise,0),funded.value);
    const dashboard=getDashboard(db,filters,own,{today:'2026-10-07',scopes});
    assert.equal(dashboard.platforms[0].total,1,'accounts have no overdue deadline and retain their scope');
    const missingSource=getDashboard(db,{...filters,source:'gemini'},own,{today:'2026-10-07',scopes});
    assert.equal(missingSource.cards.find(row=>row.key==='registrations_weekly').value,0);
    assert.equal(missingSource.cards.find(row=>row.key==='amount_funded_paise').value,98000000,'source only narrows registration metrics');
  }finally{db.close();}
});

test('invoice-upload cohorts start at the first successful PDF and remain fixed on replacement',async()=>{
  const db=fixture(),original={putObject:storage.putObject,removeKey:storage.removeKey};
  const files=new Map();storage.putObject=async({key,body})=>files.set(key,body);storage.removeKey=async key=>files.delete(key);
  try{
    db.prepare("UPDATE vt_invoices SET uploaded_at=NULL,created_at='2026-10-01T00:00:00.000Z' WHERE id=2").run();
    const receiptBefore=db.prepare('SELECT principal_paise,actual_received_paise,funded_at FROM vt_funding WHERE id=1').get();
    const owner={id:1,role:'admin'},pdf={originalname:'invoice.pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic invoice')};
    const load=()=>db.prepare('SELECT * FROM vt_invoices WHERE id=2').get();
    const cohort={search:'INV-2',stage_event:'uploaded',date_from:'2026-10-01',date_to:'2026-10-10'};
    assert.equal(listEntity(db,'invoices',cohort,own).total,0,'metadata-only invoice has no upload event');
    await addDocument(db,'invoices',load(),{purpose:'proof'},pdf,owner,{now:()=> '2026-10-06T10:00:00.000Z'});
    assert.equal(load().uploaded_at,null,'delivery proof cannot count as an invoice upload');
    await assert.rejects(()=>addDocument(db,'invoices',load(),{purpose:'invoice'},{...pdf,buffer:Buffer.from('invalid PDF')},owner,{now:()=> '2026-10-07T10:00:00.000Z'}));
    assert.equal(load().uploaded_at,null,'failed PDF validation leaves the cohort unchanged');
    await addDocument(db,'invoices',load(),{purpose:'invoice'},pdf,owner,{now:()=> '2026-10-07T23:00:00.000Z'});
    const first=load(),day={date_from:'2026-10-08',date_to:'2026-10-08',search:'INV-2'};
    assert.equal(first.uploaded_at,'2026-10-07T23:00:00.000Z');
    assert.equal(listEntity(db,'invoices',{...cohort,date_from:'2026-10-01',date_to:'2026-10-07'},own).total,0,'creation date does not backdate the successful upload');
    const dashboard=getDashboard(db,day,own,{today:'2026-10-08',scopes:{invoices:own}});
    const count=dashboard.cards.find(row=>row.key==='invoices_uploaded');
    assert.equal(count.value,1);
    assert.deepEqual(listEntity(db,'invoices',count.drilldown.filters,own).rows.map(row=>row.id),[2]);
    assert.equal(dashboard.cards.find(row=>row.key==='invoice_value_paise').value,30000000);
    assert.equal(reportRows(db,'invoice_uploads',day,own).total,1);
    const tracker=dashboard.weekly_kpis.find(row=>row.key==='tracker_same_day_percent');
    assert.equal(tracker.eligible,1,'only the first actual PDF creates a dated upload stage');
    assert.equal(tracker.same_day,1);
    await addDocument(db,'invoices',load(),{purpose:'invoice'},pdf,owner,{now:()=> '2026-10-09T10:00:00.000Z'});
    assert.equal(load().uploaded_at,first.uploaded_at,'replacement does not reset the original upload cohort');
    assert.equal(load().version,first.version,'replacement does not create another parent stage');
    db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,old_status,new_status,before_json,after_json,actor_id,changed_at) VALUES(?,?,?,?,?,?,?,?,?)').run('invoices',2,'status','on_hold','uploaded',JSON.stringify({...first,status:'on_hold'}),JSON.stringify(first),owner.id,'2026-10-09T11:00:00.000Z');
    assert.equal(reportRows(db,'invoice_uploads',{...day,date_from:'2026-10-09',date_to:'2026-10-09'},own).total,0);
    assert.equal(getWeeklyKpis(db,day,own,{scopes:{invoices:own}}).rows.find(row=>row.key==='tracker_same_day_percent').eligible,1,'hold/resume does not recount the first upload');
    assert.deepEqual(db.prepare('SELECT principal_paise,actual_received_paise,funded_at FROM vt_funding WHERE id=1').get(),receiptBefore);
    assert.equal(load().amount_paise,30000000,'recorded face value is preserved');
  }finally{Object.assign(storage,original);db.close();}
});

test('same-day tracker and AP contacts use actual dated events with replayable rows', () => {
  const db=fixture();try {
    const kpis=getWeeklyKpis(db,period,own,{scopes:{invoices:own,followups:own}});
    const tracker=kpis.rows.find(item=>item.key==='tracker_same_day_percent');
    assert.equal(tracker.eligible,2);assert.equal(tracker.same_day,1);assert.equal(tracker.actual,50);
    assert.equal(kpis.rows.find(item=>item.key==='ap_contacts').value,1);
    assert.equal(listTrackerEvents(db,period,own,{scopes:{invoices:own,followups:own}}).total,2);
    const event=listTrackerEvents(db,period,own,{scopes:{invoices:own,followups:own}}).rows[0];
    assert.equal(event.event_date,event.happened_date,'history UI business-date token matches KPI date');
    assert.equal(listTrackerEvents(db,{...period,same_day:false},own,{scopes:{invoices:own,followups:own}}).rows[0].entity_type,'followups');
    assert.equal(listEntity(db,'contacts',{},own).total,1,'contact master exists but is not an extra AP event');
  } finally {db.close();}
});

test('funding durations compare instants across SQLite and ISO timestamp formats', () => {
  const db=fixture();try {
    db.prepare('UPDATE vt_invoices SET uploaded_at=? WHERE id=1').run('2026-10-07 20:00:00');
    db.prepare('UPDATE vt_funding SET funded_at=? WHERE id=1').run('2026-10-07T19:00:00.000Z');
    const data=getDashboard(db,period,own,{today:'2026-10-07',scopes:{funding:own}});
    assert.equal(data.funding.average_funding_days.value,null,'reversed instants remain unknown');
    assert.equal(data.funding.average_funding_days.known_count,0);
    const detail=data.funding.average_funding_days.drilldown;
    assert.equal(listEntity(db,detail.entity,detail.filters,own).total,0,'average drilldown excludes the same reversed timestamps');
  } finally {db.close();}
});

test('reports apply shared predicates and XLSX preserves null/actual numeric values', async () => {
  const db=fixture();try {
    assert.equal(REPORT_CATALOG.length,11);
    const report=reportRows(db,'invoice_uploads',period,own,{all:true});
    assert.equal(report.total,2);
    assert.equal(reportRows(db,'vendor_codes',period,own,{all:true}).total,1);
    assert.equal(reportRows(db,'po_conversion',period,own,{all:true}).total,1);
    assert.equal(reportRows(db,'invoice_uploads',period,{ownerIds:[]},{all:true}).total,0);
    assert.throws(()=>reportRows(db,'invoice_uploads',period,own,{all:true,maxRows:1}),error=>error.status===413);
    const buffer=await exportXlsx(db,'funding',period,own);
    assert.equal(buffer.subarray(0,2).toString(),'PK');
    const ExcelJS=require('exceljs');const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(buffer);
    const sheet=workbook.worksheets[0];const received=sheet.getRow(1).values.indexOf('Actual Amount Received (₹)');
    assert.equal(sheet.getRow(2).getCell(received).value,980000);
    const unknown=sheet.getRow(1).values.indexOf('Expected Net Proceeds (₹)');
    assert.equal(sheet.getRow(2).getCell(unknown).value,null);
  } finally {db.close();}
});
