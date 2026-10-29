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

    await t.test('ingests line items, quantities, rates, and tax breakdown for purchases', async () => {
      const testGuid = 'TEST-ITEMS-' + Date.now();
      const testBillNo = 'MES-' + Date.now();
      const payload = {
        company_name: 'SECURED ENGINEERS PVT. LTD. - 24-25',
        vouchers: [{
          tally_guid: testGuid,
          alter_id: 127330,
          voucher_type: 'GST PURCHASE',
          bill_number: testBillNo,
          bill_date: '2026-10-29',
          vendor_name: 'MANMOHAN ELECTRIC STORE',
          bill_amount: 52859,
          subtotal: 44796,
          round_off: -0.28,
          purchase_ledger: 'PURCHASE LOCAL GST',
          items: [
            { item_name: 'WIRE ROLL', description: 'RR WIRE', quantity: 10, unit: 'ROLL', rate: 1615, per_unit: 'ROLL', discount: 0, amount: 16150 },
            { item_name: 'PIPE CONDUIT UPVC', description: '25MM HEAVY', quantity: 1700, unit: 'FT', rate: 8.18, per_unit: 'FT', discount: 0, amount: 13906 },
            { item_name: 'BEND', description: 'CONDUIT 25MM', quantity: 20, unit: 'Dozens', rate: 77, per_unit: 'Dozens', discount: 0, amount: 1540 },
            { item_name: 'PIPE CONDUIT UPVC', description: '25MM', quantity: 2000, unit: 'FT', rate: 6.60, per_unit: 'FT', discount: 0, amount: 13200 }
          ],
          tax_breakdown: [
            { ledger_name: 'INPUT CGST', amount: 4031.64 },
            { ledger_name: 'INPUT SGST', amount: 4031.64 },
            { ledger_name: 'ROUND OFF', amount: -0.28 }
          ]
        }]
      };

      const res = await fetch(`${baseUrl}/vouchers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 200);

      const bill = db.prepare('SELECT * FROM tally_bills WHERE tally_guid = ?').get(testGuid);
      assert.ok(bill);
      assert.equal(bill.bill_amount, 52859);
      assert.equal(bill.subtotal, 44796);
      assert.equal(bill.purchase_ledger, 'PURCHASE LOCAL GST');

      const dbItems = db.prepare('SELECT * FROM tally_bill_items WHERE bill_id = ? ORDER BY id').all(bill.id);
      assert.equal(dbItems.length, 4);
      assert.equal(dbItems[0].item_name, 'WIRE ROLL');
      assert.equal(dbItems[0].description, 'RR WIRE');
      assert.equal(dbItems[0].quantity, 10);
      assert.equal(dbItems[0].unit, 'ROLL');
      assert.equal(dbItems[0].rate, 1615);
      assert.equal(dbItems[0].amount, 16150);

      assert.equal(dbItems[1].item_name, 'PIPE CONDUIT UPVC');
      assert.equal(dbItems[1].quantity, 1700);
      assert.equal(dbItems[1].unit, 'FT');
      assert.equal(dbItems[1].rate, 8.18);
      assert.equal(dbItems[1].amount, 13906);
    });

    await t.test('ingests sales vouchers into sales_bills with items and taxes', async () => {
      const testGuid = 'TEST-SALES-' + Date.now();
      const testInvNo = 'INV-' + Date.now();
      const payload = {
        company_name: 'SECURED ENGINEERS PVT. LTD. - 24-25',
        vouchers: [{
          tally_guid: testGuid,
          alter_id: 125000,
          bill_number: testInvNo,
          bill_date: '2026-10-25',
          customer_name: 'Consern Pharma Ltd',
          customer_gstin: '03TESTPHARMA12',
          total_amount: 118000,
          amount: 100000,
          gst_amount: 18000,
          items: [{ item_name: 'Installation & Commissioning', quantity: 1, rate: 100000, amount: 100000 }],
          tax_breakdown: [{ ledger_name: 'OUTPUT IGST', amount: 18000 }]
        }]
      };

      const res = await fetch(`${baseUrl}/sales`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.added, 1);

      const sRow = db.prepare('SELECT * FROM sales_bills WHERE tally_guid = ?').get(testGuid);
      assert.ok(sRow);
      assert.equal(sRow.bill_number, testInvNo);
      assert.equal(sRow.customer_name, 'Consern Pharma Ltd');
      assert.equal(sRow.total_amount, 118000);
      assert.equal(sRow.is_tally_synced, 1);
    });

    await t.test('ingests bank transactions into bank_transactions', async () => {
      const testGuid = 'TEST-BANK-' + Date.now();
      const payload = {
        company_name: 'SECURED ENGINEERS PVT. LTD. - 24-25',
        transactions: [
          {
            tally_guid: testGuid + '-1',
            alter_id: 126001,
            voucher_type: 'Payment',
            date: '2026-10-28',
            amount: 25000,
            party_name: 'HDFC Bank',
            voucher_number: 'PAY-1001',
            instrument_number: 'NEFT998877',
            narration: 'Vendor RTGS Transfer'
          },
          {
            tally_guid: testGuid + '-2',
            alter_id: 126002,
            voucher_type: 'Receipt',
            date: '2026-10-29',
            amount: 50000,
            party_name: 'Consern Pharma Ltd',
            voucher_number: 'RCPT-2001',
            instrument_number: 'CMS112233',
            narration: 'Client Advance Payment'
          }
        ]
      };

      const res = await fetch(`${baseUrl}/bank`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Tally-Token': token },
        body: JSON.stringify(payload)
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.success, true);
      assert.equal(data.added, 2);

      const payTxn = db.prepare('SELECT * FROM bank_transactions WHERE tally_guid = ?').get(testGuid + '-1');
      assert.ok(payTxn);
      assert.equal(payTxn.debit, 25000);
      assert.equal(payTxn.credit, 0);

      const rcptTxn = db.prepare('SELECT * FROM bank_transactions WHERE tally_guid = ?').get(testGuid + '-2');
      assert.ok(rcptTxn);
      assert.equal(rcptTxn.debit, 0);
      assert.equal(rcptTxn.credit, 50000);
    });

  } finally {
    server.close();
  }
});
