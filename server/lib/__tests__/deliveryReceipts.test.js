const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { dispatchReceivingScore } = require('../dispatchReceivingScore');

test('multiple site receivings preserve proof, quantities, inventory and approval cohorts', async t => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(),'delivery-receipts-test-'));
  process.env.ERP_UPLOAD_DIR = uploads;
  const { app, db, setToday } = require('./fixtures/indentReviewFixture').fixture();
  setToday('2026-10-03');
  const storage = require('../storage'), originalExists = storage.exists;
  storage.exists = async key => fs.existsSync(path.join(uploads,key));
  t.after(() => { storage.exists = originalExists; });
  require.cache[require.resolve('../emailRules')].exports.runRulesForEvent = async () => [];
  app.use('/api/dispatch-receiving',require('../../routes/dispatchReceiving'));
  const server = app.listen(0,'127.0.0.1'); await new Promise(r => server.on('listening',r));
  t.after(() => { server.close(); db.close(); fs.rmSync(uploads,{recursive:true,force:true}); delete process.env.ERP_UPLOAD_DIR; });
  const request = async (url, method='GET', body) => {
    const headers = { 'x-demo-user':'9004' };
    if (body && !(body instanceof FormData)) { headers['content-type']='application/json'; body=JSON.stringify(body); }
    const result=await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`,{method,headers,body});
    return { status:result.status, body:await result.json() };
  };
  const receive = async (id, qty, key, extra={}, count=1) => {
    const body = new FormData();
    const values = {request_id:key,received_by_name:'Receiver',received_at:'2026-10-03',items_received:JSON.stringify([{line_key:'line-0',received_qty:qty}]),...extra};
    for (const [k,v] of Object.entries(values)) body.append(k,String(v));
    for(let i=0;i<count;i++) body.append('file',new Blob(['%PDF-1.4\nSynthetic receiving'],{type:'application/pdf'}),`proof-${i}.pdf`);
    return request(`procurement/delivery-notes/${id}/receive`,'PATCH',body);
  };
  db.exec(`INSERT INTO warehouses(id,name,type,active) VALUES(9001,'Test receiving store','office',1);
    INSERT INTO vendors(id,name) VALUES(9001,'Test vendor');
    INSERT INTO indents(id,indent_number,site_name,created_by,status) VALUES(9001,'TEST-INDENT','Test Site',9002,'approved');
    INSERT INTO indent_items(id,indent_id,item_master_id,description,quantity,unit,item_type) VALUES(9001,9001,90001,'Pipe',100,'nos','PO');
    INSERT INTO vendor_pos(id,po_number,vendor_id,indent_id,total_amount) VALUES(9001,'TEST-PO',9001,9001,1000);
    INSERT INTO vendor_po_items(id,vendor_po_id,indent_item_id,quantity,rate,amount) VALUES(9001,9001,9001,100,10,1000);
    INSERT INTO delivery_notes(id,vendor_po_id,document_type,document_number,status,delivery_date,sales_bill_number,sales_bill_file_path)
      VALUES(9001,9001,'challan','TEST-DC','pending','2026-10-03','TALLY-1','/uploads/tally.pdf');`);
  const consignment = JSON.stringify([{vendor_po_item_id:9001,description:'Pipe',quantity:100,received_qty:100,unit:'nos',item_type:'PO'}]);
  db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=9001').run(consignment);
  let first, second;
  const row = async id => (await request('procurement/delivery-notes')).body.find(r=>r.id===id);
  await t.test('60 received from 100; multiple proof files are ONE receiving and no shortage debit',async()=>{
    first=await receive(9001,60,'receiving-test-0001',{warehouse_id:9001},2);
    assert.equal(first.status,200,JSON.stringify(first.body)); assert.equal(first.body.status,'partial');
    const r=await row(9001); assert.equal(r.receiving_status,'partial'); assert.equal(r.sales_bill_status,'uploaded');
    assert.equal(r.receiving_history.length,1); assert.equal(r.receiving_documents.length,2);
    assert.deepEqual([r.dispatch_items[0].qty,r.dispatch_items[0].received_qty,r.dispatch_items[0].remaining_qty],[100,60,40]);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_receiving').get().n,1);
    assert.equal(db.prepare('SELECT quantity FROM stock_balance WHERE warehouse_id=9001 AND item_master_id=90001').get().quantity,60);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM debit_notes').get().n,0);
    assert.equal(db.prepare('SELECT items_json FROM delivery_notes WHERE id=9001').get().items_json,consignment);
    assert.equal(require('../partialDeliveries').receiptTotals(db,9001)[9001],100);
    const mb = db.prepare('SELECT items_json FROM mb_bills WHERE delivery_note_id=9001').get();
    assert.equal(JSON.parse(mb.items_json)[0].qty,60);
    const print= require('../deliveryNotePrint').challanItems(db,db.prepare('SELECT * FROM delivery_notes WHERE id=9001').get());
    assert.equal(print[0].quantity,100);
  });
  await t.test('retry is idempotent; over-receipt, duplicate lines, invalid quantities and future dates leave no files or rows',async()=>{
    const fileCount=fs.readdirSync(uploads).length;
    const retry=await receive(9001,60,'receiving-test-0001',{warehouse_id:9001},2);
    assert.equal(retry.status,200); assert.equal(retry.body.existing,true);
    for (const [qty,extra] of [[41,{}],[-1,{}],['NaN',{}],[0,{}],[10,{received_at:'2026-10-04'}],[10,{items_received:'bad'}],
      [10,{items_received:JSON.stringify([{line_key:'line-0',received_qty:1},{line_key:'line-0',received_qty:1}])}]]) {
      const result=await receive(9001,qty,'invalid-request-0001',extra); assert.equal(result.status,400,JSON.stringify(result.body));
    }
    assert.equal(fs.readdirSync(uploads).length,fileCount);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_receipts').get().n,1);
    assert.equal((await row(9001)).dispatch_items[0].received_qty,60);
  });
  await t.test('second 40 completes bill; stock is 100, both receipts and original challan remain',async()=>{
    second=await receive(9001,40,'receiving-test-0002',{warehouse_id:9001});
    assert.equal(second.status,200,JSON.stringify(second.body)); assert.equal(second.body.status,'received');
    const r=await row(9001); assert.equal(r.receiving_history.length,2); assert.equal(r.receiving_documents.length,3);
    assert.deepEqual([r.dispatch_items[0].qty,r.dispatch_items[0].received_qty,r.dispatch_items[0].remaining_qty],[100,100,0]);
    assert.equal(r.sales_bill_documents[0].number,'TALLY-1');
    assert.equal(db.prepare('SELECT quantity FROM stock_balance WHERE warehouse_id=9001 AND item_master_id=90001').get().quantity,100);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM stock_movements WHERE reference_type=?').get('RECEIVE').n,2);
    assert.equal((await receive(9001,1,'receiving-test-0003')).status,400);
    assert.equal((await request('procurement/delivery-notes/9001','DELETE')).status,400);
    assert.equal((await request('procurement/delivery-notes/9001','PUT',{status:'pending'})).status,400);
  });
  await t.test('approval list shows all files; weekly Planned 2, Actual 1 then 2; other users excluded',async()=>{
    db.exec("UPDATE dispatch_receiving SET created_at='2026-10-03 08:00:00'");
    const list=await request('dispatch-receiving'); assert.equal(list.status,200);
    assert.equal(list.body.find(r=>r.id===first.body.dispatch_receiving_id).receiving_files.length,2);
    assert.equal(list.body.find(r=>r.id===first.body.dispatch_receiving_id).receiving_items[0].received_qty,60);
    assert.deepEqual(dispatchReceivingScore(db,9004,'2026-09-28','2026-10-03'),{given:2,done:0});
    assert.equal((await request(`dispatch-receiving/${first.body.dispatch_receiving_id}/approve`,'POST',{})).status,200);
    assert.deepEqual(dispatchReceivingScore(db,9004,'2026-09-28','2026-10-03'),{given:2,done:1});
    assert.equal((await request(`dispatch-receiving/${second.body.dispatch_receiving_id}/approve`,'POST',{})).status,200);
    assert.deepEqual(dispatchReceivingScore(db,9004,'2026-09-28','2026-10-03'),{given:2,done:2});
    assert.deepEqual(dispatchReceivingScore(db,9002,'2026-09-28','2026-10-03'),{given:0,done:0});
  });
  await t.test('legacy partial receipt stays intact and only NEW upload enters approval scoring',async()=>{
    db.prepare(`INSERT INTO delivery_notes(id,document_type,document_number,status,source,indent_id,items_json,receipt_file_path,received_by_name,received_at)
      VALUES(9002,'challan','LEGACY-DC','received','store',9001,?,'/uploads/old-proof.pdf','Old receiver','2026-09-20')`).run(JSON.stringify([{description:'Store pipe',qty:100,received_qty:40,unit:'nos',item_type:'FOC'}]));
    assert.equal((await row(9002)).receiving_status,'partial');
    const result=await receive(9002,60,'legacy-balance-0001'); assert.equal(result.status,200,JSON.stringify(result.body));
    const r=await row(9002); assert.equal(r.receiving_history.length,2); assert.equal(r.receiving_documents[0].file_path,'/uploads/old-proof.pdf');
    assert.equal(r.dispatch_items[0].received_qty,100); assert.equal(r.sales_bill_status,'not_required');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_receiving').get().n,3);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_receipts WHERE legacy=1').get().n,1);
  });
  await t.test('proof correction keeps receipt quantities and earlier files; approval resets without another Planned record',async()=>{
    const r=db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(first.body.dispatch_receiving_id);
    const replacement=db.prepare('SELECT receiving_url FROM dispatch_receiving WHERE id=?').get(second.body.dispatch_receiving_id).receiving_url;
    const updated=await request(`dispatch-receiving/${r.id}`,'PUT',{site:r.site_name,indent_number:r.indent_number,bill_number:r.bill_number,receiving_url:replacement});
    assert.equal(updated.status,200,JSON.stringify(updated.body));
    assert.equal(db.prepare('SELECT status FROM dispatch_receiving WHERE id=?').get(r.id).status,'pending');
    const history=(await row(9001)).receiving_history;
    assert.equal(history[0].files.length,3); assert.equal(history[0].items[0].received_qty,60);
    assert.equal(history.length,2); assert.equal(history[1].approval_status,'approved');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_receiving').get().n,3);
    assert.equal((await request(`dispatch-receiving/${r.id}`,'PUT',{site:'Another site',indent_number:r.indent_number,bill_number:r.bill_number})).status,400);
  });
  await t.test('store rows with identical names stay distinct by line; no second stock movement',async()=>{
    db.prepare(`INSERT INTO delivery_notes(id,document_type,document_number,status,source,indent_id,items_json)
      VALUES(9004,'challan','TWO-STORE-LINES','pending','store',9001,?)`).run(JSON.stringify([
      {description:'Fitting',qty:3,unit:'nos',item_type:'FOC'},{description:'Fitting',qty:5,unit:'nos',item_type:'RGP'}]));
    const qty=JSON.stringify([{line_key:'line-0',received_qty:3},{line_key:'line-1',received_qty:2}]);
    assert.equal((await receive(9004,0,'store-receiving-001',{items_received:qty,warehouse_id:9001})).status,400);
    assert.equal((await receive(9004,0,'store-receiving-001',{items_received:qty})).status,200);
    const r=await row(9004); assert.deepEqual(r.dispatch_items.map(it=>it.remaining_qty),[0,3]);
    assert.equal(r.receiving_status,'partial'); assert.equal(r.sales_bill_status,'not_required');
  });
  await t.test('database failure rolls back receiving, approval row and inventory together',async()=>{
    db.prepare("INSERT INTO delivery_notes(id,vendor_po_id,document_type,document_number,status) VALUES(9003,9001,'challan','ROLLBACK-DC','pending')").run();
    db.exec("CREATE TRIGGER fail_receipt_stock BEFORE INSERT ON stock_movements BEGIN SELECT RAISE(ABORT,'test stock failure'); END");
    const before=fs.readdirSync(uploads).length;
    const result=await receive(9003,10,'rollback-receiving-01',{warehouse_id:9001}); assert.equal(result.status,500);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_receipts WHERE delivery_note_id=9003').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dispatch_receiving').get().n,4);
    assert.equal(fs.readdirSync(uploads).length,before);
    assert.equal(db.prepare('SELECT quantity FROM stock_balance WHERE warehouse_id=9001 AND item_master_id=90001').get().quantity,100);
    db.exec('DROP TRIGGER fail_receipt_stock');
  });
});
