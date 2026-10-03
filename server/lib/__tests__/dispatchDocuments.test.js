const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { groupDocuments } = require('../dispatchDocuments');

test('historical invoices group only when unambiguous and preserve actual files and receipts', () => {
  const rows = groupDocuments([
    { id: 1, document_type: 'challan', vendor_po_id: 10, item_types: ['PO'], sales_bill_number: 'GENERATED-1' },
    { id: 2, document_type: 'sales_bill', vendor_po_id: 10, document_number: 'GENERATED-1', receipt_file_path: '/signed.pdf', received_by_name: 'Receiver' },
    { id: 3, document_type: 'challan', vendor_po_id: 20, item_types: ['FOC','RGP'] },
    { id: 4, document_type: 'challan', vendor_po_id: 30, item_types: ['PO'] },
    { id: 5, document_type: 'challan', vendor_po_id: 30, item_types: ['PO'] },
    { id: 6, document_type: 'sales_bill', vendor_po_id: 30, document_number: 'TALLY-1', file_path: '/tally.pdf' },
    { id: 7, document_type: 'challan', source: 'store', items_json: JSON.stringify([{item_type:'PO'}]) },
    { id: 8, document_type: 'challan', item_types: [''] },
  ]);
  assert.equal(rows.length, 7);
  const received = rows.find(row => row.id === 1);
  assert.equal(received.receiving_status, 'received');
  assert.equal(received.receipt_file_path, '/signed.pdf');
  assert.equal(received.sales_bill_status, 'pending'); // Generated number is not an uploaded Tally bill.
  assert.equal(rows.find(row => row.id === 3).sales_bill_status, 'not_required');
  assert.equal(rows.find(row => row.id === 6).sales_bill_documents[0].file_path, '/tally.pdf');
  assert.equal(rows.find(row => row.id === 7).sales_bill_status, 'pending');
  assert.equal(rows.find(row => row.id === 8).sales_bill_status, 'check_items');
});

test('purchase bill → challan; receiving and Tally uploads stay independent through real routes', async t => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'dispatch-documents-test-'));
  process.env.ERP_UPLOAD_DIR = uploads;
  const { app, db, setToday } = require('./fixtures/indentReviewFixture').fixture();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); fs.rmSync(uploads, { recursive: true, force: true }); delete process.env.ERP_UPLOAD_DIR; });
  const request = async (url, method='GET', body) => {
    const headers = { 'x-demo-user': '9004' };
    if (body && !(body instanceof FormData)) { headers['content-type']='application/json'; body=JSON.stringify(body); }
    const res=await fetch(`http://127.0.0.1:${server.address().port}/api/procurement/${url}`, {method,headers,body});
    return {status:res.status,body:await res.json()};
  };
  const form = (values, filename) => {
    const result=new FormData();
    for (const [key,value] of Object.entries(values)) result.append(key,String(value));
    if (filename) result.append('file',new Blob(['%PDF-1.4\nSynthetic test document'],{type:'application/pdf'}),filename);
    return result;
  };
  db.exec(`INSERT INTO vendors(id,name) VALUES(9001,'Test vendor');
    INSERT INTO indents(id,indent_number,site_name,created_by,status) VALUES(9001,'TEST-INDENT','Test Site',9002,'approved');
    INSERT INTO indent_items(id,indent_id,description,quantity,unit,item_type) VALUES(9001,9001,'PO material',1,'nos','PO'),(9002,9001,'FOC material',1,'nos','FOC');
    INSERT INTO vendor_pos(id,po_number,vendor_id,indent_id,total_amount) VALUES(9001,'TEST-PO',9001,9001,100),(9002,'TEST-FOC',9001,9001,100);
    INSERT INTO vendor_po_items(vendor_po_id,indent_item_id,quantity,rate,amount) VALUES(9001,9001,1,100,100),(9002,9002,1,100,100);`);
  let id;
  await t.test('purchase-bill upload creates only the automatic challan', async () => {
    const r=await request('purchase-bills','POST',form({vendor_po_id:9001,bill_number:'PB-1',amount:100,total_amount:100},'purchase.pdf'));
    assert.equal(r.status,201,JSON.stringify(r.body)); id=r.body.delivery_note_id;
    assert.equal(db.prepare('SELECT document_type FROM delivery_notes WHERE id=?').get(id).document_type,'challan');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_notes WHERE document_type='sales_bill'").get().n,0);
    const row=(await request('delivery-notes')).body.find(row=>row.id===id);
    assert.equal(row.sales_bill_status,'pending'); assert.equal(row.receiving_status,'pending');
    assert.equal(row.purchase_bills[0].bill_number,'PB-1');
  });
  await t.test('signed challan can be received while billing stays pending', async () => {
    const r=await request(`delivery-notes/${id}/receive`,'PATCH',form({received_by_name:'Site Receiver',received_at:'2026-09-28',sales_bill_pending:0},'signed.pdf'));
    assert.equal(r.status,200,JSON.stringify(r.body));
    const row=(await request('delivery-notes')).body.find(row=>row.id===id);
    assert.equal(row.receiving_status,'received'); assert.equal(row.sales_bill_status,'pending');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_notes WHERE document_type='sales_bill'").get().n,0);
  });
  await t.test('bill number alone cannot clear pending; Tally file preserves receiving', async () => {
    assert.equal((await request(`delivery-notes/${id}/sales-bill`,'POST',form({sales_bill_number:'TALLY-1'}))).status,400);
    const before=db.prepare('SELECT receipt_file_path,received_at,status FROM delivery_notes WHERE id=?').get(id);
    const r=await request(`delivery-notes/${id}/sales-bill`,'POST',form({sales_bill_number:'TALLY-1'},'tally.pdf'));
    assert.equal(r.status,200,JSON.stringify(r.body));
    assert.deepEqual(db.prepare('SELECT receipt_file_path,received_at,status FROM delivery_notes WHERE id=?').get(id),before);
    const row=(await request('delivery-notes')).body.find(row=>row.id===id);
    assert.equal(row.sales_bill_status,'uploaded'); assert.equal(row.receiving_status,'received');
    assert.equal((await request('delivery-notes?page=1&limit=1&bill_status=uploaded&status=received')).body.total,1);
  });
  await t.test('FOC needs no sales bill and stale generation actions cannot create invoices', async () => {
    const r=await request('purchase-bills','POST',form({vendor_po_id:9002,bill_number:'PB-2',amount:100,total_amount:100},'purchase-foc.pdf'));
    assert.equal(r.status,201,JSON.stringify(r.body));
    const row=(await request('delivery-notes')).body.find(row=>row.id===r.body.delivery_note_id);
    assert.equal(row.sales_bill_status,'not_required');
    assert.equal((await request(`delivery-notes/${id}/generate-sales-bill`,'POST',{})).status,409);
    assert.equal((await request(`delivery-notes/${id}/rates`,'PUT',{rates:[1]})).status,409);
    assert.equal((await request('delivery-notes','POST',form({vendor_po_id:9001,document_type:'sales_bill'}))).status,409);
    assert.equal((await request('auto-sales-bills/sweep','POST',{})).body.generated_count,0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM delivery_notes WHERE document_type='sales_bill'").get().n,0);
  });
  await t.test('approved store quantity appears directly without a purchase bill or vendor PO', async () => {
    db.exec(`INSERT INTO warehouses(id,name,type,active) VALUES(9001,'Test Office Store','office',1);
      INSERT INTO item_master(id,item_code,item_name,uom,type) VALUES(90002,'STORE-PO','Store pipe','PCS','PO'),(90003,'STORE-FOC','Store fitting','PCS','FOC');
      INSERT INTO stock_balance(warehouse_id,item_master_id,quantity,avg_rate) VALUES(9001,90002,10,100),(9001,90003,10,50);
      INSERT INTO indents(id,indent_number,site_name,created_by,status,approval_policy) VALUES(9003,'STORE-INDENT','Store Site',9002,'submitted','single'),(9004,'STORE-FOC-INDENT','FOC Site',9002,'submitted','single');
      INSERT INTO indent_items(id,indent_id,item_master_id,description,quantity,unit,item_type) VALUES(9003,9003,90002,'Store pipe',20,'PCS','PO'),(9004,9004,90003,'Store fitting',2,'PCS','FOC');`);
    const beforeBills=db.prepare('SELECT COUNT(*) n FROM purchase_bills').get().n;
    const beforePos=db.prepare('SELECT COUNT(*) n FROM vendor_pos').get().n;
    const approved=await request('indents/9003','PUT',{status:'approved',store_qty_per_item:{9003:5}});
    assert.equal(approved.status,200,JSON.stringify(approved.body));
    assert.ok(approved.body.store_challan_id);
    const row=(await request('delivery-notes?q=STORE-INDENT')).body.find(row=>row.id===approved.body.store_challan_id);
    assert.ok(row,'Store dispatch must be visible immediately after approval');
    assert.equal(row.source,'store'); assert.equal(row.vendor_po_id,null);
    assert.deepEqual(row.purchase_bills,[]);
    assert.equal(row.from_warehouse_name,'Test Office Store');
    assert.equal(row.raised_by_name,'Site Engineer A (Demo raiser)');
    assert.equal(row.dispatch_items[0].qty,5); assert.equal(row.dispatch_items[0].unit,'PCS');
    assert.equal(db.prepare('SELECT quantity FROM indent_items WHERE id=9003').get().quantity,15);
    assert.equal(db.prepare('SELECT quantity FROM stock_balance WHERE warehouse_id=9001 AND item_master_id=90002').get().quantity,5);
    assert.equal(row.sales_bill_status,'pending'); assert.equal(row.receiving_status,'pending');
    const foc=await request('indents/9004','PUT',{status:'approved',store_qty_per_item:{9004:2}});
    assert.equal(foc.status,200,JSON.stringify(foc.body));
    const focRow=(await request('delivery-notes')).body.find(row=>row.id===foc.body.store_challan_id);
    assert.equal(focRow.sales_bill_status,'not_required'); assert.equal(focRow.dispatch_items[0].qty,2);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM purchase_bills').get().n,beforeBills);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vendor_pos').get().n,beforePos);
    setToday('2026-10-03');
    const received=await request(`delivery-notes/${row.id}/receive`,'PATCH',form({received_by_name:'Store Site Receiver',received_at:'2026-10-03',items_received:JSON.stringify([{description:'Store pipe',ordered_qty:5,received_qty:5}])},'store-proof.pdf'));
    assert.equal(received.status,200,JSON.stringify(received.body));
    const result=(await request('delivery-notes?q=STORE-INDENT')).body[0];
    assert.equal(result.receiving_status,'received'); assert.equal(result.sales_bill_status,'pending');
    assert.equal(result.dispatch_items[0].qty,5); assert.equal(result.dispatch_items[0].unit,'PCS');
    assert.equal((await request('delivery-notes?from=2026-10-03&to=2026-10-03')).body.length,1);
  });
  await t.test('partial challan uses its exact item types and keeps multi-PO purchase-bill links', async () => {
    db.exec(`INSERT INTO vendor_pos(id,po_number,vendor_id,indent_id,total_amount) VALUES(9010,'MIXED-PO',9001,9001,200);
      INSERT INTO vendor_po_items(id,vendor_po_id,indent_item_id,quantity,rate,amount) VALUES(9010,9010,9001,10,10,100),(9011,9010,9002,20,5,100);
      INSERT INTO purchase_bills(id,bill_number,total_amount) VALUES(9010,'MULTI-PO-BILL',200);
      INSERT INTO purchase_bill_pos(purchase_bill_id,vendor_po_id) VALUES(9010,9001),(9010,9010);`);
    db.prepare("INSERT INTO delivery_notes(id,vendor_po_id,document_type,document_number,supply_pending,items_json) VALUES(9010,9010,'challan','PARTIAL-FOC',1,?)")
      .run(JSON.stringify([{vendor_po_item_id:9011,received_qty:3}]));
    const rows=(await request('delivery-notes')).body;
    const partial=rows.find(r=>r.id===9010);
    assert.equal(partial.sales_bill_status,'not_required');
    assert.equal(partial.dispatch_items[0].qty,3);
    assert.equal(partial.dispatch_items[0].item_type,'FOC');
    assert.ok(partial.purchase_bills.some(b=>b.bill_number==='MULTI-PO-BILL'));
    assert.ok(rows.find(r=>r.id===id).purchase_bills.some(b=>b.bill_number==='MULTI-PO-BILL'));
  });
});
