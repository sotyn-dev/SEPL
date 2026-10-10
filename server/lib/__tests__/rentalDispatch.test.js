const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const rental = require('../rentalDispatch');

test('inclusive calendar rental dates reject missing, impossible and fractional values', () => {
  assert.equal(rental.period('2026-10-10', 15).rental_end_date, '2026-10-24');
  assert.equal(rental.period('2028-02-28', 2).rental_end_date, '2028-02-29');
  assert.equal(rental.period('2026-12-31', 2).rental_end_date, '2027-01-01');
  assert.equal(rental.period('2026-10-10', 1).rental_end_date, '2026-10-10');
  for (const date of ['', '2026-02-30', '10/10/2026', '2026-10-10T00:00:00Z']) assert.throws(() => rental.period(date, 1));
  for (const days of ['', 0, -1, 1.5, true, Infinity, 999999999999]) assert.throws(() => rental.period('2026-10-10', days));
});

test('real indent approval → confirmed rental dispatch → existing Rental Tools API', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture({ enforceApprovalPermission: true });
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'rental-dispatch-test-'));
  const paths = require('../paths');
  require.cache[require.resolve('../paths')].exports = { ...paths, uploadsSub: (...parts) => path.join(uploads, ...parts) };
  const storage = require('../storage');
  require.cache[require.resolve('../storage')].exports = { ...storage, adoptLocalFile: async () => '/uploads/rental-tools/synthetic.jpg' };
  app.use('/api/rental-tools', require('../../routes/rentalTools'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); fs.rmSync(uploads, { recursive: true, force: true }); });
  const call = async (url, method = 'GET', body, user = 9004) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, {
      method, headers: { ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), 'x-demo-user': String(user) }, body: body instanceof FormData ? body : body ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, data: await response.json() };
  };
  const good = (r, status = 200) => { assert.equal(r.status, status, JSON.stringify(r.data)); return r.data; };
  db.exec(`INSERT INTO item_master(id,item_code,item_name,uom,type,current_price,specification) VALUES
    (99001,'RENT-A','Scaffolding','nos','RENTAL',10000,'Two metre'),
    (99002,'RENT-B','Mixer','nos','RENTAL',15000,'Electric'),
    (99003,'PPE-A','Helmet','nos','PPE_KIT',500,'Yellow');
    INSERT INTO vendors(id,name) VALUES(99001,'Synthetic rental vendor');`);
  good(await call('procurement/indent-raise-window', 'PUT', { enable: true }));
  const make = async (category, masterIds) => {
    const data = good(await call('procurement/indents', 'POST', {
      site_name: 'Synthetic Rental Site', raised_by_name: 'Site Engineer A', indent_category: category,
      emergency_reason: 'Synthetic regression fixture', items: masterIds.map(id => ({ item_master_id: id,
        description: id === 99001 ? 'Scaffolding' : id === 99002 ? 'Mixer' : 'Helmet', quantity: 5, unit: 'nos',
        item_type: category === 'rental' ? 'RENTAL' : 'PPE_KIT', rental_days: 15, rental_rate_per_day: 10 })),
    }, 9002), 201);
    return data.id;
  };
  const indentId = await make('rental', [99001,99002]);
  const ppeId = await make('ppe_kit', [99003]);
  await t.test('all categories, search/date/status and pagination return correct item details', async () => {
    for (const category of ['rental','ppe_kit','extra_non_schedule','material','rgp','extra_schedule']) {
      const result = good(await call(`procurement/indents?page=1&limit=1&category=${category}&q=Synthetic&status=submitted&from=2000-01-01&to=2099-01-01`));
      assert.equal(result.total, ['rental','ppe_kit'].includes(category) ? 1 : 0);
      assert.equal(result.kpis.total_count, result.total);
      if (result.total) {
        assert.equal(result.rows[0].indent_category, category);
        assert.equal(result.rows[0].items.length, category === 'rental' ? 2 : 1);
      }
    }
    const page2 = good(await call('procurement/indents?page=2&limit=1&category=all&q=Synthetic'));
    assert.equal(page2.total, 2); assert.equal(page2.rows.length, 1);
    db.prepare("UPDATE indents SET indent_category=' RENTAL ' WHERE id=?").run(indentId);
    assert.equal(good(await call('procurement/indents?page=1&limit=1&category=RENTAL')).total, 1);
    db.prepare("UPDATE indents SET indent_category='rental' WHERE id=?").run(indentId);
    assert.equal((await call('procurement/indents?page=1&category=unknown')).status, 400);
    assert.ok(ppeId);
  });
  await t.test('submission and approval alone do not start rentals', async () => {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n, 0);
    good(await call(`procurement/indents/${indentId}`, 'PUT', { status: 'reviewed', review_revision: 0 }, 9001));
    good(await call(`procurement/indents/${indentId}`, 'PUT', { status: 'approved', review_revision: 0 }, 9002));
    assert.equal(db.prepare('SELECT status FROM indents WHERE id=?').get(indentId).status, 'approved');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n, 0);
  });
  // The existing purchasing process is independent; seed an approved Vendor PO
  // against the two actually-created and approved indent items.
  db.prepare("INSERT INTO vendor_pos(id,indent_id,vendor_id,po_number,status) VALUES(99001,?,99001,'RENT-PO','sent')").run(indentId);
  const lines = db.prepare('SELECT * FROM indent_items WHERE indent_id=? ORDER BY id').all(indentId);
  for (const [index, line] of lines.entries()) db.prepare('INSERT INTO vendor_po_items(id,vendor_po_id,indent_item_id,quantity,rate,amount) VALUES(?,99001,?,5,10,50)').run(99001+index,line.id);
  const input = (id, quantity, date='2026-10-10', days=15) => ({ line_key: `vpi:${id}`, quantity, rental_start_date: date, rental_days: days });
  const body = { document_type: 'challan', vendor_po_id: 99001, request_id: randomUUID(), rental_items: [input(99001,2),input(99002,1,'2026-10-11',3)] };
  await t.test('server blocks omitted/invalid periods, forged items and unauthorized users atomically', async () => {
    for (const rental_items of [undefined, [], [input(99001,1,'')], [input(99001,1,'2026-02-30')], [input(99001,1,'2026-10-10',1.5)], [input(99001,6)], [input(99999,1)], [input(99001,1),input(99001,1)]]) {
      assert.equal((await call('procurement/delivery-notes', 'POST', { ...body, request_id: randomUUID(), rental_items })).status, 400);
    }
    assert.equal((await call('procurement/delivery-notes', 'POST', body, 9003)).status, 403);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_dispatch_items').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes WHERE rental_request_id IS NOT NULL').get().n, 0);
  });
  const created = good(await call('procurement/delivery-notes', 'POST', body), 201);
  await t.test('two items keep independent periods, quantities, source links and one entry per item', async () => {
    const enquiries = good(await call('rental-tools/enquiries'));
    assert.equal(enquiries.length, 2);
    const a = enquiries.find(e => e.dispatch.item_master_id === 99001);
    assert.equal(a.dispatch.quantity, 2); assert.equal(a.days_required, 15);
    assert.equal(a.return_target_date, '2026-10-24'); assert.equal(a.current_stage, 'rate_finalised');
    assert.equal(a.material_received_at, null); assert.equal(a.dispatch.indent_id, indentId);
    assert.equal(a.dispatch.dispatch_id, created.id); assert.equal(a.site_name, 'Synthetic Rental Site');
    assert.equal(a.dispatch.vendor_name, 'Synthetic rental vendor'); assert.equal(a.dispatch.approved_by, 9002);
    assert.equal(enquiries.find(e => e.dispatch.item_master_id === 99002).return_target_date, '2026-10-13');
    const detail = good(await call(`rental-tools/enquiries/${a.id}`));
    assert.equal(detail.history.length, 1);
    const list = good(await call('procurement/delivery-notes'));
    assert.equal(list.find(e => e.id === created.id).rental_items.length, 2);
    assert.equal(good(await call('rental-tools/dashboard')).total_value, 330);
  });
  await t.test('network retries replay; changed payload conflicts; other dispatches use only remaining quantities', async () => {
    assert.equal(good(await call('procurement/delivery-notes','POST',body)).id, created.id);
    assert.equal((await call('procurement/delivery-notes','POST',{...body,rental_items:[input(99001,3)]})).status,409);
    const second = good(await call('procurement/delivery-notes','POST',{...body,request_id:randomUUID(),rental_items:[input(99001,2,'2026-10-20',2)]}),201);
    assert.notEqual(second.id, created.id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n,3);
    assert.equal((await call('procurement/delivery-notes','POST',{...body,request_id:randomUUID(),rental_items:[input(99001,2)]})).status,400);
  });
  await t.test('corrections sync dates/quantity once with revision checks and immutable originals', async () => {
    const correction = { revision: 1, rental_items:[input(99001,1,'2026-10-12',5),input(99002,1,'2026-10-11',3)] };
    good(await call(`procurement/delivery-notes/${created.id}/rental-dispatch`,'PUT',correction));
    good(await call(`procurement/delivery-notes/${created.id}/rental-dispatch`,'PUT',correction));
    const line = db.prepare('SELECT * FROM rental_dispatch_items WHERE delivery_note_id=? AND vendor_po_item_id=99001').get(created.id);
    assert.equal(line.initial_start_date,'2026-10-10'); assert.equal(line.initial_days,15);
    assert.equal(line.rental_start_date,'2026-10-12'); assert.equal(line.rental_end_date,'2026-10-16');
    const enquiry = db.prepare('SELECT * FROM rental_tool_enquiry WHERE dispatch_item_id=?').get(line.id);
    assert.equal(enquiry.return_target_date,'2026-10-16'); assert.equal(JSON.parse(enquiry.dispatch_snapshot).quantity,1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_history WHERE enquiry_id=?').get(enquiry.id).n,2);
    assert.equal((await call(`procurement/delivery-notes/${created.id}/rental-dispatch`,'PUT',{...correction,rental_items:body.rental_items})).status,409);
    assert.throws(()=>db.prepare("UPDATE delivery_notes SET items_json='[]' WHERE id=?").run(created.id),/Rental dispatch/);
    assert.equal((await call(`procurement/delivery-notes/${created.id}`,'DELETE')).status,409);
    db.prepare("UPDATE rental_tool_enquiry SET current_stage='returned',status='closed' WHERE id=?").run(enquiry.id);
    assert.equal((await call(`procurement/delivery-notes/${created.id}/rental-dispatch`,'PUT',{revision:2,rental_items:body.rental_items})).status,409);
    assert.equal(db.prepare('SELECT rental_start_date FROM rental_dispatch_items WHERE id=?').get(line.id).rental_start_date,'2026-10-12');
  });
  await t.test('non-rental creation is unchanged and migration is repeatable without backfill', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n;
    good(await call('procurement/delivery-notes','POST',{document_type:'challan',document_number:'NON-RENTAL',items:[{description:'Cable',qty:1,item_type:'PO'}]}),201);
    rental.initialize(db); rental.initialize(db);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n,before);
  });
  await t.test('pre-created mixed challan starts no rental until confirmation and preserves its other items', async () => {
    db.exec(`INSERT INTO indents(id,indent_number,site_name,indent_category,status,created_by,approved_by) VALUES(99200,'MIXED-INDENT','Mixed sample site','material','approved',9002,9002);
      INSERT INTO indent_items(id,indent_id,item_master_id,description,quantity,unit,item_type,rental_days,rental_rate_per_day) VALUES
      (99200,99200,99002,'Mixer',3,'nos','RENTAL',15,10),(99201,99200,NULL,'Packing material',2,'nos','FOC',NULL,NULL);
      INSERT INTO vendor_pos(id,indent_id,vendor_id,po_number) VALUES(99200,99200,99001,'MIXED-PO');
      INSERT INTO vendor_po_items(id,vendor_po_id,indent_item_id,quantity,rate,amount) VALUES(99200,99200,99200,3,10,30),(99201,99200,99201,2,1,2);`);
    const saved = [{vendor_po_item_id:99200,qty:1,item_type:'RENTAL'}, {vendor_po_item_id:99201,description:'Packing material',qty:2,item_type:'FOC'}];
    const id = db.prepare("INSERT INTO delivery_notes(vendor_po_id,document_type,document_number,items_json) VALUES(99200,'challan','PRE-CREATED',?)").run(JSON.stringify(saved)).lastInsertRowid;
    const count = db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n;
    assert.throws(() => require('../deliveryReceipts').addReceipt(db,id,{},[],{id:9004}), /Confirm rental dispatch/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM rental_tool_enquiry').get().n,count);
    good(await call(`procurement/delivery-notes/${id}/rental-dispatch`, 'PUT', {rental_items:[input(99200,1)]}));
    const items = JSON.parse(db.prepare('SELECT items_json FROM delivery_notes WHERE id=?').get(id).items_json);
    assert.equal(items.find(it=>it.item_type==='FOC').quantity,2);
    const detail = good(await call(`procurement/indents?page=1&category=material`));
    assert.ok(detail.rows.find(i=>i.id===99200).items.find(it=>it.id===99200).rental_dispatches.some(r=>r.document_number==='PRE-CREATED'));
  });
  await t.test('late synchronization failure rolls back both the challan and linked rentals', async () => {
    const before = db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n;
    db.exec("CREATE TRIGGER synthetic_rental_failure BEFORE INSERT ON rental_tool_enquiry BEGIN SELECT RAISE(ABORT,'Synthetic sync failure'); END;");
    const result = await call('procurement/delivery-notes','POST',{...body,request_id:randomUUID(),rental_items:[input(99002,1)]});
    assert.equal(result.status,500); assert.match(result.data.error,/Synthetic sync failure/);
    db.exec('DROP TRIGGER synthetic_rental_failure');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes').get().n,before);
  });
  await t.test('site receipt keeps dispatch end date while manual enquiries retain business-day rules', async () => {
    const linked = db.prepare("SELECT * FROM rental_tool_enquiry WHERE dispatch_item_id IS NOT NULL AND status='open' LIMIT 1").get();
    const photo = () => { const form = new FormData(); form.append('photo', new Blob(['synthetic image'], {type:'image/jpeg'}), 'sample.jpg'); form.append('latitude','1'); form.append('longitude','1'); return form; };
    const receipt = good(await call(`rental-tools/enquiries/${linked.id}/material-received`,'POST',photo()));
    assert.equal(receipt.return_target_date,linked.return_target_date);
    const dispatchId = JSON.parse(linked.dispatch_snapshot).dispatch_id;
    const ctx = rental.context(db,{noteId:dispatchId});
    const changed = ctx.items.map(it=>input(it.vendor_po_item_id,it.quantity,it.rental_start_date,it.rental_days+1));
    assert.equal((await call(`procurement/delivery-notes/${dispatchId}/rental-dispatch`,'PUT',{revision:ctx.note.rental_revision,rental_items:changed})).status,409);
    const manual = good(await call('rental-tools/enquiries','POST',{site_name:'Manual sample',date_of_requirement:'2026-10-10',days_required:2}),201);
    db.prepare("UPDATE rental_tool_enquiry SET current_stage='rate_finalised' WHERE id=?").run(manual.id);
    const expected = require('../businessHours').addBusinessDays(new Date(),2).toISOString().slice(0,10);
    assert.equal(good(await call(`rental-tools/enquiries/${manual.id}/material-received`,'POST',photo())).return_target_date,expected);
  });
});
