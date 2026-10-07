const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {ensureVendorTredsSchema}=require('../../../db/vendorTredsSchema');
const service=require('../service');

// Exercise real SQLite constraints even when the host's Node version differs
// from its installed better-sqlite3 native binary. Production still uses its DB.
function database() {
  try{return new (require('better-sqlite3'))(':memory:');}catch(error){
    if(!['ERR_DLOPEN_FAILED','MODULE_NOT_FOUND'].includes(error.code))throw error;
    const {DatabaseSync}=require('node:sqlite'),raw=new DatabaseSync(':memory:');let depth=0;
    return {exec:s=>raw.exec(s),prepare:s=>raw.prepare(s),close:()=>raw.close(),
      transaction:fn=>(...args)=>{const marker=`vt_test_${depth++}`;raw.exec(`SAVEPOINT ${marker}`);
        try{const value=fn(...args);raw.exec(`RELEASE ${marker}`);depth--;return value;}
        catch(e){raw.exec(`ROLLBACK TO ${marker}; RELEASE ${marker}`);depth--;throw e;}}};
  }
}
function fixture() {
  const db=database();db.exec('PRAGMA foreign_keys=ON');
  const source=fs.readFileSync(path.join(__dirname,'../../../db/schema.js'),'utf8');
  for(const table of ['users','lead_sources','leads','boq','quotations','purchase_orders','business_book',
    'customers','vendors','crm_funnel','sales_bills','receivables','collections','pms_tasks','app_settings']) {
    const ddl=source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`))?.[0];
    assert(ddl,`Existing ${table} DDL found`);db.exec(ddl);
  }
  for(const table of ['bank_accounts','bank_transactions'])db.exec(source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\)`))[0]);
  const daily=fs.readFileSync(path.join(__dirname,'../../../db/dailyWork.js'),'utf8');
  db.exec(daily.match(/CREATE TABLE IF NOT EXISTS daily_work_plans \([\s\S]*?\n\s*\);/)[0]);
  db.exec(`ALTER TABLE users ADD COLUMN manager_id INTEGER; ALTER TABLE users ADD COLUMN archived INTEGER DEFAULT 0;
    ALTER TABLE quotations ADD COLUMN crm_funnel_id INTEGER; ALTER TABLE quotations ADD COLUMN business_book_id INTEGER;
    ALTER TABLE sales_bills ADD COLUMN customer_name TEXT; ALTER TABLE sales_bills ADD COLUMN created_by INTEGER;
    ALTER TABLE sales_bills ADD COLUMN approval_status TEXT DEFAULT 'draft';
    INSERT INTO users(id,name,email,password,role) VALUES(1,'Administrator','admin@test.invalid','hash','admin'),
      (2,'Owner','owner@test.invalid','hash','user'),(3,'Another Owner','another@test.invalid','hash','user'),
      (4,'Manager','manager@test.invalid','hash','manager'); UPDATE users SET manager_id=4 WHERE id=2;
    INSERT INTO customers(id,customer_code,company_name) VALUES(1,'CUST-01001','Client One'),(2,'CUST-01002','Client Two');`);
  ensureVendorTredsSchema(db);
  db.exec(`UPDATE customers SET website_url='https://client-one.test',website_domain='client-one.test' WHERE id=1;
    UPDATE customers SET website_url='https://client-two.test',website_domain='client-two.test' WHERE id=2;`);
  return db;
}
const admin={id:1,role:'admin'},owner={id:2,role:'user'},other={id:3,role:'user'},manager={id:4,role:'manager'};
const create=(db,kind,data,user=admin)=>service.createEntity(db,kind,data,user);
const move=(db,kind,row,status,extra={},user=admin)=>service.transitionEntity(db,kind,row.id,{status,version:row.version,...extra},user);
function registration(db,customer=1,ownerId=2) {
  return create(db,'registrations',{customer_id:customer,owner_id:ownerId,registration_date:'2026-10-07'});
}
function documents(db,reg) {
  for(const type of db.prepare("SELECT id FROM vt_catalog WHERE kind='doc_type' AND required=1").all()) {
    create(db,'documents',{registration_id:reg.id,type_id:type.id,storage_key:`vendor-treds/${reg.id}/${type.id}.pdf`,
      filename:'test.pdf',mime:'application/pdf',size_bytes:100});
  }
}
function recordedInvoicePdf(db,invoice) {
  const at=new Date().toISOString();
  // Domain tests seed an already stored fixture PDF; upload API behavior is
  // exercised separately through the real documents service below.
  db.prepare(`INSERT INTO vt_invoice_documents(invoice_id,purpose,storage_key,filename,mime,size_bytes,uploaded_at,created_by)
    VALUES(?,'invoice',?,'fixture.pdf','application/pdf',100,?,?)`).run(invoice.id,`vendor-treds/invoices/${invoice.id}/fixture.pdf`,at,admin.id);
  db.prepare('UPDATE vt_invoices SET uploaded_at=?,version=version+1 WHERE id=?').run(at,invoice.id);
  return service.getDetail(db,'invoices',invoice.id,admin);
}
function invoiceSetup(db,amount=1000000,withPdf=true) {
  const reg=registration(db);documents(db,reg);
  const platform=db.prepare("SELECT id FROM vt_catalog WHERE kind='platform' AND code='rxil'").get().id;
  let account=create(db,'accounts',{platform_id:platform,owner_id:2});
  for(const status of ['registration_started','pending_verification','active'])account=move(db,'accounts',account,status);
  create(db,'mappings',{customer_id:1,platform_id:platform,account_id:account.id,acceptance_confirmed:1,owner_id:2});
  let invoice=create(db,'invoices',{customer_id:1,registration_id:reg.id,platform_id:platform,account_id:account.id,
    external_invoice_number:'INV-001',invoice_date:'2026-10-07',due_date:'2026-11-07',amount_paise:amount,owner_id:2});
  if(withPdf)invoice=recordedInvoicePdf(db,invoice);
  return {reg,account,platform,invoice};
}

test('additive migrations repeat safely, preserve masters and immutable history',()=>{
  const db=fixture();const before=db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  ensureVendorTredsSchema(db);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,before);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM vt_catalog WHERE kind='platform'").get().n,4);
  const reg=registration(db);assert.throws(()=>db.prepare('UPDATE vt_history SET event=? WHERE entity_id=?').run('changed',reg.id),/immutable/);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
});
test('registration creates a canonical client, normalizes identity, rejects duplicates and secrets',()=>{
  const db=fixture();
  const reg=create(db,'registrations',{company_name:'New Client',website_url:'https://www.new-client.test/path',
    pan:'ABCDE1234F',owner_id:2,registration_date:'2026-10-07',procurement_contact:'Procurement Person'});
  assert.equal(db.prepare('SELECT website_domain FROM customers WHERE id=?').get(reg.customer_id).website_domain,'new-client.test');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vendors').get().n,0);
  assert.equal(service.getDetail(db,'registrations',reg.id,owner).company_name,'New Client');
  const count=db.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
  assert.throws(()=>create(db,'registrations',{company_name:'Different spelling',website_url:'https://new-client.test',owner_id:2,registration_date:'2026-10-07'}),e=>e.code==='POSSIBLE_DUPLICATE_VENDOR');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM customers').get().n,count);
  assert.throws(()=>create(db,'registrations',{customer_id:2,owner_id:2,registration_date:'2026-10-07',portal_password:'never-store'}),e=>e.code==='SECRET_NOT_ALLOWED');
  assert.throws(()=>create(db,'registrations',{company_name:'Website missing',owner_id:2,registration_date:'2026-10-07'}),/Website URL/);
  db.close();
});
test('required and expired documents block submission; approval code drives registration without overwriting supplier code',()=>{
  const db=fixture();let reg=registration(db);reg=move(db,'registrations',reg,'started');
  assert.throws(()=>move(db,'registrations',reg,'submitted'),e=>e.code==='DOCUMENTS_PENDING');
  documents(db,reg);reg=move(db,'registrations',reg,'submitted');assert(reg.submitted_at);
  let approval=create(db,'approvals',{registration_id:reg.id,application_date:'2026-10-07',owner_id:2});
  assert.throws(()=>move(db,'approvals',approval,'approved'),e=>e.code==='VENDOR_CODE_REQUIRED');
  approval=move(db,'approvals',approval,'approved',{vendor_code:'CLIENT-VENDOR-42',valid_until:'2027-10-07'});
  assert.equal(service.getDetail(db,'registrations',reg.id,owner).status,'approved');
  db.exec("UPDATE vt_registrations SET status='po_received' WHERE id=1");
  approval=move(db,'approvals',approval,'expired');approval=move(db,'approvals',approval,'approved');
  assert.equal(service.getDetail(db,'registrations',reg.id,owner).status,'po_received');
  const doc=db.prepare('SELECT id FROM vt_documents ORDER BY id LIMIT 1').get();
  db.prepare("UPDATE vt_documents SET expiry_date='2000-01-01' WHERE id=?").run(doc.id);
  assert(service.requiredDocuments(db,reg.id).length>0);db.close();
});
test('ownership and optimistic conflicts prevent cross-owner writes and preserve canonical profile on rollback',()=>{
  const db=fixture();const reg=registration(db);
  assert.throws(()=>service.getDetail(db,'registrations',reg.id,other),e=>e.status===403);
  assert.equal(service.getDetail(db,'registrations',reg.id,manager).id,reg.id);
  const changed=service.updateEntity(db,'registrations',reg.id,{version:reg.version,remarks:'Owner note'},owner);
  assert.throws(()=>service.updateEntity(db,'registrations',reg.id,{version:reg.version,company_name:'Must roll back'},owner),e=>e.code==='VERSION_CONFLICT');
  assert.equal(db.prepare('SELECT company_name FROM customers WHERE id=1').get().company_name,'Client One');
  assert.equal(changed.version,reg.version+1);
  assert.throws(()=>service.updateEntity(db,'registrations',reg.id,{version:changed.version,owner_id:3},owner),e=>e.status===403);
  assert.throws(()=>move(db,'registrations',changed,'started',{owner_id:3},owner),/cannot be changed by a status action/);db.close();
});
test('RFQ reuses CRM and refuses fabricated quote/PO stage, follow-up dates update parent',()=>{
  const db=fixture(),reg=registration(db);
  let rfq=create(db,'enquiries',{registration_id:reg.id,customer_id:1,enquiry_date:'2026-10-07',owner_id:2,rfq_number:'RFQ-1'});
  assert(db.prepare('SELECT 1 FROM crm_funnel WHERE id=?').get(rfq.crm_funnel_id));
  rfq=move(db,'enquiries',rfq,'quote_preparing');
  assert.throws(()=>move(db,'enquiries',rfq,'quote_sent'),e=>e.code==='QUOTATION_REQUIRED');
  db.prepare("INSERT INTO quotations(quotation_number,crm_funnel_id,status) VALUES(?,?,'sent')").run('QUOTE-1',rfq.crm_funnel_id);
  rfq=move(db,'enquiries',rfq,'quote_sent');assert.equal(service.getDetail(db,'registrations',reg.id,owner).status,'quote_sent');
  assert.throws(()=>move(db,'enquiries',rfq,'po_received'),e=>e.code==='PO_REQUIRED');
  create(db,'followups',{enquiry_id:rfq.id,owner_id:2,notes:'Procurement follow-up',next_followup_at:'2026-10-10T12:00'});
  assert.equal(service.getDetail(db,'enquiries',rfq.id,owner).next_followup_at,'2026-10-10T06:30:00.000Z');db.close();
});
test('invoice identity, active account and canonical invoice checks are enforced transactionally',()=>{
  const db=fixture();const {invoice,account,platform}=invoiceSetup(db);
  assert.equal(db.prepare('SELECT total_amount FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).total_amount,10000);
  const bills=db.prepare('SELECT COUNT(*) AS n FROM sales_bills').get().n;
  assert.throws(()=>create(db,'invoices',{customer_id:1,platform_id:platform,account_id:account.id,external_invoice_number:'  inv-001 ',
    invoice_date:'2026-10-07',amount_paise:1000000,owner_id:2}),e=>e.code==='DUPLICATE_INVOICE');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sales_bills').get().n,bills);
  assert.throws(()=>create(db,'invoices',{sales_bill_id:invoice.sales_bill_id,customer_id:1,platform_id:platform,account_id:account.id,
    external_invoice_number:'NEW',invoice_date:'2026-10-07',amount_paise:99,owner_id:2}),e=>e.code==='CANONICAL_INVOICE_MISMATCH');
  move(db,'accounts',account,'frozen');
  assert.throws(()=>create(db,'invoices',{customer_id:1,platform_id:platform,account_id:account.id,external_invoice_number:'INV-2',invoice_date:'2026-10-07',amount_paise:100,owner_id:2}),e=>e.code==='INACTIVE_ACCOUNT');db.close();
});
test('only the first successful invoice PDF completes upload, atomically records its day and unlocks later stages',async()=>{
  const db=fixture();const {invoice}=invoiceSetup(db,1000000,false);
  const documents=require('../documents'),storage=require('../../storage'),files=new Map();
  const original={putObject:storage.putObject,removeKey:storage.removeKey};
  storage.putObject=async({key,body})=>{files.set(key,body);return key;};
  storage.removeKey=async key=>files.delete(key);
  const pdf={originalname:'invoice.pdf',buffer:Buffer.from('%PDF-1.4\nSynthetic isolated upload fixture')};
  const firstAt='2026-10-08T07:00:00.000Z',laterAt='2026-10-09T08:00:00.000Z';
  const current=()=>service.getDetail(db,'invoices',invoice.id,admin);
  try {
    db.prepare('UPDATE vt_invoices SET created_at=? WHERE id=?').run('2026-10-07T05:00:00.000Z',invoice.id);
    assert.equal(current().uploaded_at,null);assert(!current().allowed_transitions.includes('accepted'));
    assert.throws(()=>move(db,'invoices',invoice,'accepted'),e=>e.code==='INVOICE_PDF_REQUIRED');
    assert.throws(()=>create(db,'funding',{invoice_id:invoice.id,principal_paise:1000000,owner_id:2}),e=>e.code==='INVOICE_PDF_REQUIRED');
    const png={originalname:'proof.png',buffer:Buffer.from([137,80,78,71,13,10,26,10])};
    await assert.rejects(documents.addDocument(db,'invoices',current(),{purpose:'invoice'},png,admin),/Invoice must be a PDF/);
    await documents.addDocument(db,'invoices',current(),{purpose:'proof'},png,admin,{now:()=>firstAt});
    assert.equal(current().uploaded_at,null);assert.equal(current().version,invoice.version);
    assert.throws(()=>move(db,'invoices',current(),'accepted'),e=>e.code==='INVOICE_PDF_REQUIRED');

    // A failed history write rolls back both the document and parent stage,
    // and removes the protected object that was written before the transaction.
    db.exec("CREATE TEMP TRIGGER fail_first_upload_history BEFORE INSERT ON vt_history WHEN NEW.event='status' AND NEW.entity_type='invoices' BEGIN SELECT RAISE(ABORT,'History unavailable'); END");
    await assert.rejects(documents.addDocument(db,'invoices',current(),{purpose:'invoice'},pdf,admin,{now:()=>firstAt}),/History unavailable/);
    assert.equal(current().uploaded_at,null);assert.equal(current().version,invoice.version);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM vt_invoice_documents WHERE invoice_id=?').get(invoice.id).n,1);assert.equal(files.size,1);
    db.exec('DROP TRIGGER fail_first_upload_history');

    const uploaded=await documents.addDocument(db,'invoices',current(),{purpose:'invoice'},pdf,admin,{now:()=>firstAt});
    assert.equal(uploaded.uploaded_at,firstAt);assert.equal(uploaded.parent_version,invoice.version+1);
    assert.equal(current().uploaded_at,firstAt);assert.equal(current().version,invoice.version+1);
    assert(current().allowed_transitions.includes('accepted'));
    assert.throws(()=>move(db,'invoices',invoice,'accepted'),e=>e.code==='VERSION_CONFLICT');
    const stageEvents=()=>service.getHistory(db,'invoices',invoice.id,admin).filter(row=>row.event==='status'&&row.new_status==='uploaded');
    assert.equal(stageEvents().length,1);assert.equal(stageEvents()[0].changed_at,firstAt);
    assert.equal(JSON.parse(stageEvents()[0].before_json).uploaded_at,null);
    assert.equal(JSON.parse(stageEvents()[0].after_json).uploaded_at,firstAt);
    await documents.addDocument(db,'invoices',current(),{purpose:'invoice'},pdf,admin,{now:()=>laterAt});
    await documents.addDocument(db,'invoices',current(),{purpose:'proof'},png,admin,{now:()=>laterAt});
    assert.equal(current().uploaded_at,firstAt);assert.equal(current().version,invoice.version+1);assert.equal(stageEvents().length,1);
    db.prepare("UPDATE vt_invoice_documents SET status='rejected' WHERE invoice_id=? AND purpose='invoice'").run(invoice.id);
    assert.throws(()=>move(db,'invoices',current(),'accepted'),e=>e.code==='INVOICE_PDF_REQUIRED');
    db.prepare("UPDATE vt_invoice_documents SET status='verified' WHERE id=?").run(uploaded.id);
    assert.equal(move(db,'invoices',current(),'accepted').status,'accepted');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM collections').get().n,0);
  } finally {Object.assign(storage,original);db.close();}
});

test('full invoice funding journey needs real cash and receipt; financing never auto-pays the client invoice',()=>{
  const db=fixture();let {invoice}=invoiceSetup(db);
  let funding=create(db,'funding',{invoice_id:invoice.id,owner_id:2,principal_paise:1000000,discount_rate:1,basis:'flat',fees_paise:0,taxes_paise:0});
  assert.equal(funding.expected_net_paise,990000);assert.equal(funding.actual_received_paise,null);
  assert.throws(()=>move(db,'funding',funding,'client_accepted'),e=>e.code==='ACCEPTANCE_REQUIRED');
  invoice=move(db,'invoices',invoice,'accepted');funding=service.getDetail(db,'funding',funding.id,admin);
  invoice=move(db,'invoices',invoice,'bid_received');funding=service.getDetail(db,'funding',funding.id,admin);
  funding=move(db,'funding',funding,'funding_approved');
  assert.throws(()=>move(db,'funding',funding,'funded',{actual_received_paise:0,bank_reference:'BANK-42'}),e=>e.code==='ACTUAL_FUNDS_REQUIRED');
  funding=move(db,'funding',funding,'funded',{actual_received_paise:990000,bank_reference:'BANK-42'});
  assert.equal(service.getDetail(db,'invoices',invoice.id,owner).status,'funded');
  assert.equal(db.prepare('SELECT payment_status FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).payment_status,'pending');
  assert.throws(()=>move(db,'funding',funding,'reconciled'),e=>e.code==='RECEIPT_REQUIRED');
  const bankId=Number(db.prepare('INSERT INTO bank_transactions(txn_date,ref_no,credit) VALUES(?,?,?)').run('2026-10-07','BANK-42',9900).lastInsertRowid);
  funding=move(db,'funding',funding,'reconciled',{bank_transaction_id:bankId});funding=move(db,'funding',funding,'closed');
  assert(funding.approved_at<=funding.funded_at&&funding.funded_at<=funding.reconciled_at&&funding.reconciled_at<=funding.closed_at);
  assert.equal(db.prepare('SELECT payment_status FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).payment_status,'pending');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM receivables').get().n,0);
  const match=db.prepare('SELECT matched_type,matched_id,matched_by,matched_at FROM bank_transactions WHERE id=?').get(bankId);
  assert.equal(match.matched_type,'vt_funding');assert.equal(match.matched_id,funding.id);assert.equal(match.matched_by,admin.id);assert(match.matched_at);
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);db.close();
});
test('held invoices retain reached milestones, cancelled invoices cannot finance, and status actions cannot rewrite amounts',()=>{
  const db=fixture();let {invoice}=invoiceSetup(db);
  invoice=move(db,'invoices',invoice,'accepted');invoice=move(db,'invoices',invoice,'bid_received');
  let funding=create(db,'funding',{invoice_id:invoice.id,principal_paise:1000000,owner_id:2});
  funding=move(db,'funding',funding,'client_accepted');funding=move(db,'funding',funding,'bid_received');
  funding=move(db,'funding',funding,'funding_approved');
  invoice=move(db,'invoices',invoice,'on_hold');
  const acceptedAt=invoice.accepted_at,bidAt=invoice.bid_at;
  assert.throws(()=>move(db,'invoices',invoice,'uploaded'),e=>e.code==='INVALID_TRANSITION');
  assert.throws(()=>service.updateEntity(db,'invoices',invoice.id,{version:invoice.version,amount_paise:2000000},admin),e=>e.code==='FINANCIAL_LOCKED');
  invoice=move(db,'invoices',invoice,'bid_received');
  funding=service.getDetail(db,'funding',funding.id,admin);assert.equal(funding.status,'funding_approved');
  assert.equal(invoice.accepted_at,acceptedAt);assert.equal(invoice.bid_at,bidAt);
  assert.throws(()=>move(db,'funding',funding,'funded',{principal_paise:500000,actual_received_paise:400000,bank_reference:'REF'}),e=>e.code==='FINANCIAL_LOCKED');
  invoice=move(db,'invoices',invoice,'cancelled');funding=service.getDetail(db,'funding',funding.id,admin);
  assert.equal(funding.status,'cancelled');assert.throws(()=>move(db,'funding',funding,'funded'),e=>e.code==='INVALID_TRANSITION');db.close();
});
test('bank reconciliation rejects mismatched and reused receipts and locks financial amounts after funding',()=>{
  const db=fixture();let {invoice}=invoiceSetup(db);let funding=create(db,'funding',{invoice_id:invoice.id,principal_paise:1000000,owner_id:2});
  invoice=move(db,'invoices',invoice,'accepted');invoice=move(db,'invoices',invoice,'bid_received');
  funding=service.getDetail(db,'funding',funding.id,admin);funding=move(db,'funding',funding,'funding_approved');
  funding=move(db,'funding',funding,'funded',{actual_received_paise:950000,bank_reference:'REAL-REF'});
  const wrong=Number(db.prepare('INSERT INTO bank_transactions(ref_no,credit) VALUES(?,?)').run('REAL-REF',9000).lastInsertRowid);
  assert.throws(()=>move(db,'funding',funding,'reconciled',{bank_transaction_id:wrong}),e=>e.code==='RECEIPT_MISMATCH');
  assert.throws(()=>move(db,'funding',funding,'reconciled',{bank_transaction_id:wrong,actual_received_paise:900000}),e=>e.code==='FINANCIAL_LOCKED');
  const used=Number(db.prepare("INSERT INTO bank_transactions(ref_no,credit,matched_type,matched_id) VALUES(?,?,'sales_bill',99)").run('REAL-REF',9500).lastInsertRowid);
  assert.throws(()=>move(db,'funding',funding,'reconciled',{bank_transaction_id:used}),e=>e.code==='DUPLICATE_RECEIPT');
  assert.equal(service.getDetail(db,'funding',funding.id,admin).status,'funded');db.close();
});

test('collection reconciliation rejects another client with the same invoice number, amount and receipt reference',()=>{
  const db=fixture();let {invoice}=invoiceSetup(db);
  let funding=create(db,'funding',{invoice_id:invoice.id,principal_paise:1000000,owner_id:2});
  invoice=move(db,'invoices',invoice,'accepted');invoice=move(db,'invoices',invoice,'bid_received');
  funding=service.getDetail(db,'funding',funding.id,admin);funding=move(db,'funding',funding,'funding_approved');
  funding=move(db,'funding',funding,'funded',{actual_received_paise:950000,bank_reference:'CLIENT-RECEIPT'});
  const receivable=db.prepare('INSERT INTO receivables(client_name,invoice_number,invoice_amount) VALUES(?,?,?)');
  const receipt=db.prepare('INSERT INTO collections(receivable_id,amount,collection_date,transaction_ref) VALUES(?,?,?,?)');
  const wrong=Number(receivable.run('Client Two','INV-001',10000).lastInsertRowid);
  const wrongReceipt=Number(receipt.run(wrong,9500,'2026-10-07','CLIENT-RECEIPT').lastInsertRowid);
  const historyBefore=service.getHistory(db,'funding',funding.id,admin).length;
  assert.throws(()=>move(db,'funding',funding,'reconciled',{receivable_id:wrong,collection_id:wrongReceipt}),e=>e.code==='RECEIPT_MISMATCH');
  assert.equal(service.getDetail(db,'funding',funding.id,admin).status,'funded');
  assert.equal(service.getHistory(db,'funding',funding.id,admin).length,historyBefore);
  const correct=Number(receivable.run('  CLIENT   ONE  ','INV-001',10000).lastInsertRowid);
  const correctReceipt=Number(receipt.run(correct,9500,'2026-10-07','CLIENT-RECEIPT').lastInsertRowid);
  funding=move(db,'funding',funding,'reconciled',{receivable_id:correct,collection_id:correctReceipt});
  assert.equal(funding.status,'reconciled');
  assert.equal(db.prepare('SELECT payment_status FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).payment_status,'pending');
  db.close();
});

test('reconciled bank credits stay reserved through auto/manual matching and cannot fund another invoice',async()=>{
  const db=fixture();let {invoice,reg,platform,account}=invoiceSetup(db);
  const fund=invoiceRow=>{
    if(!invoiceRow.uploaded_at)invoiceRow=recordedInvoicePdf(db,invoiceRow);
    let funding=create(db,'funding',{invoice_id:invoiceRow.id,principal_paise:1000000,owner_id:2});
    invoiceRow=move(db,'invoices',invoiceRow,'accepted');invoiceRow=move(db,'invoices',invoiceRow,'bid_received');
    funding=service.getDetail(db,'funding',funding.id,admin);funding=move(db,'funding',funding,'funding_approved');
    return move(db,'funding',funding,'funded',{actual_received_paise:950000,bank_reference:'RESERVED-REF'});
  };
  let funding=fund(invoice);
  const accountId=Number(db.prepare('INSERT INTO bank_accounts(bank_name) VALUES(?)').run('Fixture Bank').lastInsertRowid);
  const bank=Number(db.prepare('INSERT INTO bank_transactions(bank_account_id,txn_date,ref_no,credit) VALUES(?,?,?,?)').run(accountId,'2026-10-07','RESERVED-REF',9500).lastInsertRowid);
  funding=move(db,'funding',funding,'reconciled',{bank_transaction_id:bank});
  const original=db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(bank);
  const receivable=Number(db.prepare('INSERT INTO receivables(client_name,invoice_number,invoice_amount) VALUES(?,?,?)').run('Client One','INV-001',10000).lastInsertRowid);
  db.prepare('INSERT INTO collections(receivable_id,amount,collection_date,transaction_ref) VALUES(?,?,?,?)').run(receivable,9500,'2026-10-07','RESERVED-REF');
  const {autoMatch}=require('../../bankStatementImport');
  assert.equal(autoMatch(db,accountId,admin.id),0);
  assert.deepEqual(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(bank),original);
  assert.throws(()=>service.updateEntity(db,'funding',funding.id,{version:funding.version,bank_transaction_id:null},admin),e=>e.code==='RECONCILIATION_LOCKED');

  const second=create(db,'invoices',{customer_id:1,registration_id:reg.id,platform_id:platform,account_id:account.id,
    external_invoice_number:'INV-002',invoice_date:'2026-10-07',amount_paise:1000000,owner_id:2});
  let another=fund(second);
  assert.throws(()=>move(db,'funding',another,'reconciled',{bank_transaction_id:bank}),e=>e.code==='DUPLICATE_RECEIPT');
  const own=Number(db.prepare("INSERT INTO bank_transactions(bank_account_id,ref_no,credit,matched_type,matched_id,matched_note,matched_at) VALUES(?,?,?,'vt_funding',?,?,?)")
    .run(accountId,'RESERVED-REF',9500,another.id,'Already linked to this funding','2026-10-07T01:00:00Z').lastInsertRowid);
  another=move(db,'funding',another,'reconciled',{bank_transaction_id:own});
  assert.equal(another.status,'reconciled');
  assert.equal(db.prepare('SELECT matched_at FROM bank_transactions WHERE id=?').get(own).matched_at,'2026-10-07T01:00:00Z');

  // Load the real bank router against only this isolated DB; authentication is
  // supplied by the fixture so this test focuses on the bank match contract.
  const schemaPath=require.resolve('../../../db/schema'),authPath=require.resolve('../../../middleware/auth'),bankPath=require.resolve('../../../routes/bank');
  const originals=new Map([schemaPath,authPath,bankPath].map(file=>[file,require.cache[file]]));
  let router,server;
  try {
    require.cache[schemaPath]={id:schemaPath,filename:schemaPath,loaded:true,exports:{getDb:()=>db}};
    require.cache[authPath]={id:authPath,filename:authPath,loaded:true,exports:{authMiddleware:(req,res,next)=>{req.user=admin;next();},requirePermission:()=>((req,res,next)=>next())}};
    delete require.cache[bankPath];router=require(bankPath);
  } finally {
    for(const [file,originalModule] of originals)if(originalModule)require.cache[file]=originalModule;else delete require.cache[file];
  }
  try {
    const app=require('express')();app.use(require('express').json());app.use('/bank',router);
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const request=async(id,body)=>{
      const response=await fetch(`http://127.0.0.1:${server.address().port}/bank/transactions/${id}/match`,{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
      return {status:response.status,data:await response.json()};
    };
    for(const body of [{},{matched_type:'collection',matched_id:1},{matched_type:'vt_funding',matched_id:another.id}]){
      const response=await request(bank,body);assert.equal(response.status,409);assert.equal(response.data.code,'RECONCILIATION_LOCKED');
    }
    assert.equal((await request(bank,{matched_type:'vt_funding',matched_id:funding.id})).status,200);
    assert.deepEqual(db.prepare('SELECT * FROM bank_transactions WHERE id=?').get(bank),original);
    const ordinary=Number(db.prepare('INSERT INTO bank_transactions(bank_account_id,credit) VALUES(?,?)').run(accountId,42).lastInsertRowid);
    assert.equal((await request(ordinary,{matched_type:'vt_funding',matched_id:999})).status,400);
    assert.equal((await request(ordinary,{matched_type:'collection',matched_id:1})).status,200);
    assert.equal((await request(ordinary,{})).status,200);
    assert.equal(db.prepare('SELECT matched_type FROM bank_transactions WHERE id=?').get(ordinary).matched_type,null);
    assert.equal(db.prepare('SELECT payment_status FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).payment_status,'pending');
  } finally {
    if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    db.close();
  }
});
