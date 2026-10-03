const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('saved challans supply both print locations without rates or unrelated materials', async t => {
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-note-test-'));
  process.env.ERP_UPLOAD_DIR = uploads;
  const { app, db, setToday } = require('./fixtures/indentReviewFixture').fixture();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); fs.rmSync(uploads, { recursive: true, force: true }); delete process.env.ERP_UPLOAD_DIR; });
  const request = async (url, method='GET', body) => {
    const headers = { 'x-demo-user':'9004' };
    if (body && !(body instanceof FormData)) { headers['content-type']='application/json'; body=JSON.stringify(body); }
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/procurement/${url}`, { method, headers, body });
    return { status:res.status, body:res.headers.get('content-type').includes('application/json') ? await res.json() : await res.text() };
  };
  db.exec(`INSERT INTO vendors(id,name) VALUES(9001,'Sample Supplier');
    INSERT INTO business_book(id,company_name,project_name,billing_address,shipping_address,gstin,client_name,client_contact)
      VALUES(9001,'Sample Company','Sample Site','Billing Road','Delivery Road','SAMPLE-GST','Client Contact','000-CLIENT');
    INSERT INTO sites(id,name,business_book_id) VALUES(9001,'Sample Site',9001);
    INSERT INTO indents(id,indent_number,site_name,created_by,raised_by_name,status)
      VALUES(9001,'IND-PRINT','Sample Site',9002,'Site Contact','approved');
    UPDATE users SET name='Site Contact',phone='000-SITE' WHERE id=9002;
    INSERT INTO item_master(id,item_name,item_code,uom,gst,type) VALUES
      (90002,'Brush','BRUSH-CODE','PCS','18%','PO'),(90003,'Primer','PRIMER-CODE','LTR','18%','PO');
    INSERT INTO po_items(id,business_book_id,description,quantity,unit,hsn_code) VALUES
      (9001,9001,'Entire client order brush',999,'PCS','9603'),(9002,9001,'Unrelated client order material',500,'LTR','3208');
    INSERT INTO indent_items(id,indent_id,item_master_id,po_item_id,description,quantity,unit,item_type)
      VALUES(9001,9001,90002,9001,'Brush',15,'PCS','PO'),(9002,9001,90003,9002,'Primer',20,'LTR','PO');
    INSERT INTO vendor_pos(id,po_number,vendor_id,indent_id,total_amount) VALUES
      (9001,'VPO-PRINT-1',9001,9001,150),(9002,'VPO-PRINT-2',9001,9001,200),(9003,'VPO-PRINT-3',9001,9001,150);
    INSERT INTO vendor_po_items(id,vendor_po_id,indent_item_id,quantity,rate,amount) VALUES
      (9001,9001,9001,15,10,150),(9002,9002,9002,20,10,200),(9003,9003,9001,15,10,150);
    INSERT INTO delivery_notes(id,vendor_po_id,document_type,document_number,delivery_date) VALUES
      (9001,9001,'challan','DC/2026/0033','2026-10-01'),(9002,9002,'challan','DC/2026/0032','2026-10-01');`);

  await t.test('reprinting keeps stored numbers and dates; each PO lists only its challans', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n;
    for (const date of ['2026-10-03','2027-01-01']) {
      setToday(date);
      const list = await request('vendor-po/9001/delivery-notes');
      assert.deepEqual(list.body.delivery_notes.map(n => n.id), [9001]);
      assert.equal(list.body.delivery_notes[0].document_number, 'DC/2026/0033');
      const print = await request(`delivery-notes/${list.body.delivery_notes[0].id}/print`);
      assert.equal(print.status,200,JSON.stringify(print.body));
      for (const value of ['DC/2026/0033','01 / 10 / 2026','Brush','15.00','9603','Billing Road','Delivery Road','SAMPLE-GST','Client Contact','000-CLIENT','Site Contact','000-SITE']) assert.ok(print.body.includes(value), value);
      for (const value of ['Primer','999.00','Unrelated client order material','18%','>RATE<','>AMOUNT<','DN-261003']) assert.ok(!print.body.includes(value), value);
    }
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n, before);
  });
  await t.test('partial batches retain their own sparse quantities and item metadata', async () => {
    db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=9002').run(JSON.stringify([{vendor_po_item_id:9002,received_qty:3}]));
    db.prepare("INSERT INTO delivery_notes(id,vendor_po_id,document_type,document_number,items_json) VALUES(9004,9002,'challan','DC-LATER',?)")
      .run(JSON.stringify([{vendor_po_item_id:9002,received_qty:17}]));
    assert.equal((await request('vendor-po/9002/delivery-notes')).body.delivery_notes.length,2);
    const first=(await request('delivery-notes/9002/print')).body, later=(await request('delivery-notes/9004/print')).body;
    assert.match(first,/Primer/); assert.match(first,/>3\.00</); assert.doesNotMatch(first,/>17\.00<|>20\.00</);
    assert.match(later,/>17\.00</); assert.doesNotMatch(later,/>3\.00<|>20\.00</);
    assert.match(first,/3208/);
  });
  await t.test('zero, excluded, corrupt and unrelated snapshots never fall back to a full order', async () => {
    for (const value of ['[]','bad-json',JSON.stringify([{vendor_po_item_id:9002,quantity:0,received_qty:20}]),JSON.stringify([{vendor_po_item_id:9002,quantity:20,include:false}]),JSON.stringify([{vendor_po_item_id:9001,quantity:15}])]) {
      db.prepare('UPDATE delivery_notes SET items_json=? WHERE id=9004').run(value);
      assert.equal((await request('delivery-notes/9004/print')).status,409,value);
    }
  });
  await t.test('store challan uses approved store qty and latest uniquely linked address', async () => {
    db.prepare("INSERT INTO delivery_notes(id,indent_id,document_type,document_number,source,items_json) VALUES(9005,9001,'challan','SI-OLD','store',?)")
      .run(JSON.stringify([{item_master_id:90002,description:'Brush <special>',qty:5,unit:'PCS'}]));
    db.prepare("UPDATE business_book SET shipping_address='Updated delivery address' WHERE id=9001").run();
    const printed = await request('delivery-notes/9005/print');
    assert.equal(printed.status,200); assert.match(printed.body,/STORE ISSUE CHALLAN/);
    for (const value of ['SI-OLD','5.00','Brush &lt;special&gt;','Updated delivery address','SAMPLE-GST']) assert.ok(printed.body.includes(value),value);
    assert.doesNotMatch(printed.body,/>15\.00</);
  });
  await t.test('explicit create is retry-safe and a later purchase bill reuses that number', async () => {
    setToday('2026-10-03');
    assert.equal((await request('vendor-po/9003/delivery-notes')).body.delivery_notes.length,0);
    const created = await request('vendor-po/9003/delivery-notes','POST',{});
    assert.equal(created.status,201);
    const note=created.body.delivery_notes[0];
    assert.equal(db.prepare('SELECT status FROM delivery_notes WHERE id=?').get(note.id).status,'pending');
    assert.deepEqual(require('../partialDeliveries').receiptTotals(db,9003),{});
    assert.equal((await request('vendor-po/9003/delivery-notes','POST',{})).body.delivery_notes[0].id,note.id);
    const form = new FormData();
    for (const [key,value] of Object.entries({vendor_po_id:9003,bill_number:'PRINT-BILL',amount:150,total_amount:150})) form.append(key,String(value));
    form.append('file',new Blob(['%PDF-1.4\nSynthetic bill'],{type:'application/pdf'}),'test-bill.pdf');
    const bill=await request('purchase-bills','POST',form);
    assert.equal(bill.status,201,JSON.stringify(bill.body));
    assert.equal(bill.body.delivery_note_id,note.id);
    assert.equal(db.prepare('SELECT document_number FROM delivery_notes WHERE id=?').get(note.id).document_number,note.document_number);
    assert.equal((await request('vendor-po/9003/delivery-notes')).body.delivery_notes.length,1);
    assert.match((await request(`delivery-notes/${note.id}/print`)).body,/>15\.00</);
  });
});
