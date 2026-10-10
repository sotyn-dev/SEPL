const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { getDb } = require('../../db/schema');
const tallySyncRouter = require('../../routes/tallySync');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tally-sync', tallySyncRouter);
  return app;
}

test('Tally Sync: Voucher ingestion, deduplication, and payment reconciliation', async (t) => {
  const db = getDb();
  const app = createApp();

  // Retrieve valid sync token from app_settings
  let token = db.prepare("SELECT value FROM app_settings WHERE key = 'tally_sync_token'").get()?.value;
  if (!token) {
    token = 'test_tally_token_2026';
    db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('tally_sync_token', ?)").run(token);
  }

  const server = app.listen(0);
  const port = server.address().port;
  const baseUrl = `http://localhost:${port}/api/tally-sync`;

  try {
    await t.test('rejects request without token', async () => {
      const res = await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ vouchers: [] })
      });
      assert.equal(res.status, 401);
    });

    await t.test('ingests new purchase vouchers cleanly', async () => {
      const testGuid = 'TEST-GUID-' + Date.now();
      const testBillNo = 'TBILL-' + Date.now();
      const payload = {
        company_name: 'SEPL Test Corp',
        vouchers: [
          {
            tally_guid: testGuid,
            alter_id: 101,
            voucher_type: 'Purchase',
            bill_number: testBillNo,
            bill_date: '2026-10-05',
            vendor_name: 'Polycab Test Vendor',
            vendor_gstin: '07TESTGSTIN1234',
            bill_amount: 50000,
            narration: 'Test cables for site'
          }
        ]
      };

      const res = await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Tally-Token': token
        },
        body: JSON.stringify(payload)
      });

      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.added, 1);

      // Verify row in DB
      const row = db.prepare('SELECT * FROM tally_bills WHERE tally_guid = ?').get(testGuid);
      assert.ok(row, 'Bill should exist in DB');
      assert.equal(row.bill_number, testBillNo);
      assert.equal(row.bill_amount, 50000);
      assert.equal(row.is_tally_synced, 1);
      assert.equal(row.status, 'pending_task_creation');
      assert.match(row.register_no, /^TB-\d{4}-\d{4}$/);

      // Verify audit log
      const audit = db.prepare('SELECT * FROM tally_bill_audit WHERE bill_id = ?').get(row.id);
      assert.ok(audit, 'Audit trail should be created');
      assert.equal(audit.action, 'tally_create');
    });

    await t.test('deduplicates identical voucher and updates if amount changed', async () => {
      const testGuid = 'TEST-GUID-DUPE-' + Date.now();
      const testBillNo = 'TBILL-DUPE-' + Date.now();

      // First sync
      await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          vouchers: [{
            tally_guid: testGuid,
            alter_id: 201,
            bill_number: testBillNo,
            bill_date: '2026-10-05',
            vendor_name: 'Havells Test',
            bill_amount: 30000
          }]
        })
      });

      // Second sync: identical (should skip)
      const resIdentical = await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          vouchers: [{
            tally_guid: testGuid,
            alter_id: 201,
            bill_number: testBillNo,
            bill_date: '2026-10-05',
            vendor_name: 'Havells Test',
            bill_amount: 30000
          }]
        })
      });
      const dataIdentical = await resIdentical.json();
      assert.equal(dataIdentical.added, 0);
      assert.equal(dataIdentical.skipped, 1);

      // Third sync: updated amount (should update)
      const resUpdated = await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          vouchers: [{
            tally_guid: testGuid,
            alter_id: 202,
            bill_number: testBillNo,
            bill_date: '2026-10-05',
            vendor_name: 'Havells Test',
            bill_amount: 35000
          }]
        })
      });
      const dataUpdated = await resUpdated.json();
      assert.equal(dataUpdated.updated, 1);

      const row = db.prepare('SELECT bill_amount FROM tally_bills WHERE tally_guid = ?').get(testGuid);
      assert.equal(row.bill_amount, 35000);
    });

    await t.test('ingests payment voucher and closes matching bill', async () => {
      const testBillNo = 'TBILL-PAY-' + Date.now();
      const testGuid = 'TEST-GUID-PAY-' + Date.now();

      // Create bill of 40,000
      await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          vouchers: [{
            tally_guid: testGuid,
            alter_id: 301,
            bill_number: testBillNo,
            bill_date: '2026-10-05',
            vendor_name: 'Finolex Test',
            bill_amount: 40000
          }]
        })
      });

      // Partial payment of 15,000
      const resPartial = await fetch(`${baseUrl}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          payments: [{
            alter_id: 401,
            bill_ref: testBillNo,
            vendor_name: 'Finolex Test',
            payment_date: '2026-10-06',
            amount: 15000,
            utr_ref: 'UTR-PARTIAL-123'
          }]
        })
      });
      const dataPartial = await resPartial.json();
      assert.equal(dataPartial.added, 1);

      let bill = db.prepare('SELECT * FROM tally_bills WHERE tally_guid = ?').get(testGuid);
      assert.equal(bill.amount_received, 15000);
      assert.equal(bill.status, 'partially_paid');

      // Final payment of 25,000 (total = 40,000 -> closed)
      const resFinal = await fetch(`${baseUrl}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify({
          payments: [{
            alter_id: 402,
            bill_ref: testBillNo,
            vendor_name: 'Finolex Test',
            payment_date: '2026-10-07',
            amount: 25000,
            utr_ref: 'UTR-FINAL-456'
          }]
        })
      });
      const dataFinal = await resFinal.json();
      assert.equal(dataFinal.added, 1);

      bill = db.prepare('SELECT * FROM tally_bills WHERE tally_guid = ?').get(testGuid);
      assert.equal(bill.amount_received, 40000);
      assert.equal(bill.status, 'closed');
      assert.ok(bill.t4_closed_at, 'Closing timestamp should be set');
    });

  } finally {
    server.close();
  }
});
