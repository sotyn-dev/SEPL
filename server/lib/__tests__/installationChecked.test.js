const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const Database = require('better-sqlite3');

test('Approved DPRs bill by closed fortnight without a second approval', async () => {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE business_book(id INTEGER PRIMARY KEY, payment_against_installation TEXT, client_name TEXT, company_name TEXT, project_name TEXT);
    CREATE TABLE sites(id INTEGER PRIMARY KEY, business_book_id INTEGER);
    CREATE TABLE dpr(id INTEGER PRIMARY KEY, site_id INTEGER, report_date TEXT, approval_status TEXT, billing_ready INTEGER, sales_bill_id INTEGER);
    CREATE TABLE po_items(id INTEGER PRIMARY KEY, business_book_id INTEGER, description TEXT, rate REAL, unit TEXT, hsn_code TEXT);
    CREATE TABLE dpr_work_items(id INTEGER PRIMARY KEY, dpr_id INTEGER, po_item_id INTEGER, description TEXT, unit TEXT, rate REAL, actual_qty REAL);
    CREATE TABLE sales_bills(id INTEGER PRIMARY KEY, bill_number TEXT UNIQUE, bill_date TEXT, amount REAL, gst_amount REAL, total_amount REAL, gst_rate REAL,
      bill_type INTEGER, business_book_id INTEGER, customer_name TEXT, project_name TEXT, bill_status TEXT, previous_bill_id INTEGER,
      reference_doc_type TEXT, reference_doc_no TEXT, approval_status TEXT, payment_status TEXT, created_by INTEGER,
      checked_at TEXT, checked_by INTEGER, sent_to_client INTEGER DEFAULT 0, sent_at TEXT);
    CREATE TABLE sales_bill_items(id INTEGER PRIMARY KEY, sales_bill_id INTEGER, description TEXT, qty_ordered REAL, qty_delivered REAL, unit TEXT, rate REAL, amount REAL);
    CREATE TABLE sales_bill_status_log(id INTEGER PRIMARY KEY, sales_bill_id INTEGER, status TEXT, changed_by INTEGER, notes TEXT);
    INSERT INTO business_book VALUES(1,'20%', 'Client', NULL, 'Test project');
    INSERT INTO sites VALUES(1,1);
    INSERT INTO dpr VALUES(1,1,'2026-09-17','approved',1,NULL);
    INSERT INTO po_items VALUES(1,1,'Pipe',1000,'mtr','');
    INSERT INTO dpr_work_items VALUES(1,1,1,'Pipe','mtr',110,10);
  `);
  const stub = (name, exports) => { require.cache[require.resolve(name)] = { exports }; };
  stub('../../db/schema', { getDb: () => db });
  stub('../../middleware/auth', {
    authMiddleware: (req, res, next) => { req.user = { id: 7 }; next(); },
    requirePermission: () => (req, res, next) => req.headers['x-deny'] ? res.sendStatus(403) : next(),
  });
  stub('../istDate', { istToday: () => '2026-10-01' });
  const router = require('../../routes/salesBilling');
  db.exec("UPDATE dpr SET billing_ready=0; INSERT INTO dpr VALUES(2,1,'2026-09-18','rejected',1,NULL),(3,1,'2026-09-19','pending',1,NULL),(4,1,'2026-10-01','approved',1,NULL);");
  const app = express(); app.use(express.json()); app.use(router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = (method, path, body = {}, deny = false) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { 'Content-Type': 'application/json', ...(deny ? { 'x-deny': '1' } : {}) }, body: JSON.stringify(body),
  });
  try {
    const request = { dpr_ids: [1] };
    assert.equal((await call('POST', '/generate-installation', request, true)).status, 403);
    assert.equal((await call('POST', '/generate-installation', { dpr_ids: [2,3,4] })).status, 409);
    assert.equal((await call('POST', '/generate-installation', { checked: true })).status, 400);
    const response = await call('POST', '/generate-installation', request);
    assert.equal(response.status, 200, await response.text());
    const bill = db.prepare('SELECT * FROM sales_bills').get();
    assert.equal(bill.amount, 2000);
    assert.equal(bill.gst_amount, 360);
    assert.equal(bill.total_amount, 2360);
    assert.equal(bill.checked_by, null); assert.equal(bill.checked_at, null);
    assert.equal(bill.approval_status, 'approved');
    assert.match(bill.reference_doc_no, /2026-09-16.*2026-09-30/);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM dpr WHERE id IN (2,3,4) AND sales_bill_id IS NULL').get().n, 3);
    assert.equal(bill.sent_to_client, 0);
    assert.equal(db.prepare('SELECT sales_bill_id FROM dpr').get().sales_bill_id, bill.id);
    assert.equal((await call('POST', '/generate-installation', request)).status, 409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sales_bills').get().n, 1);
    assert.equal((await call('PUT', `/${bill.id}/sent`)).status, 200);
    db.prepare('UPDATE sales_bills SET checked_at=NULL, checked_by=NULL, sent_to_client=0').run();
    db.exec("UPDATE dpr SET approval_status='rejected' WHERE id=1");
    assert.equal((await call('PUT', `/${bill.id}/sent`)).status, 409);
    db.exec("UPDATE dpr SET approval_status='approved' WHERE id=1");
    assert.equal((await call('PUT', `/${bill.id}/checked`, {}, true)).status, 403);
    assert.equal((await call('PUT', `/${bill.id}/checked`)).status, 200);
    const logCount = db.prepare("SELECT COUNT(*) n FROM sales_bill_status_log WHERE status='checked'").get().n;
    assert.equal((await call('PUT', `/${bill.id}/checked`)).status, 200);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM sales_bill_status_log WHERE status='checked'").get().n, logCount);
    assert.equal((await call('PUT', `/${bill.id}/sent`)).status, 200);
    db.exec("INSERT INTO dpr VALUES(5,1,'2026-09-02','approved',0,NULL),(6,1,'2026-09-28','approved',0,NULL); INSERT INTO dpr_work_items VALUES(5,5,1,'Pipe','mtr',110,2),(6,6,1,'Pipe','mtr',110,3);");
    const result = require('../../scripts/installationBillingCron').runOnce('2026-10-01');
    assert.equal(result.created, 2);
    const generated = db.prepare('SELECT * FROM sales_bills WHERE id<>? ORDER BY id').all(bill.id);
    assert.deepEqual(generated.map(b=>b.amount), [400,600]);
    assert.ok(generated.every(b=>b.approval_status==='approved' && !b.sent_to_client && !b.checked_by));
    assert.equal(require('../../scripts/installationBillingCron').runOnce('2026-10-01').created, 0);
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});

test('period boundaries include leap years and year rollover', () => {
  const { billingPeriod, completedThrough } = require('../installationBillingPeriod');
  assert.deepEqual(billingPeriod('2026-01-15'), {start:'2026-01-01',end:'2026-01-15'});
  assert.deepEqual(billingPeriod('2026-01-16'), {start:'2026-01-16',end:'2026-01-31'});
  assert.equal(billingPeriod('2028-02-29').end,'2028-02-29');
  assert.equal(completedThrough('2026-01-01'),'2025-12-31');
  assert.equal(completedThrough('2026-01-15'),'2025-12-31');
  assert.equal(completedThrough('2026-01-16'),'2026-01-15');
  assert.throws(()=>billingPeriod('2026-02-30'));
});
