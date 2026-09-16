const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { syncInstallationUnits } = require('../installationBillUnits');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE po_items (id INTEGER PRIMARY KEY, po_id INTEGER, business_book_id INTEGER, description TEXT, unit TEXT);
  CREATE TABLE sites (id INTEGER PRIMARY KEY, po_id INTEGER, business_book_id INTEGER);
  CREATE TABLE dpr (id INTEGER PRIMARY KEY, site_id INTEGER, sales_bill_id INTEGER);
  CREATE TABLE dpr_work_items (id INTEGER PRIMARY KEY, dpr_id INTEGER, po_item_id INTEGER, description TEXT, unit TEXT);
  CREATE TABLE sales_bills (id INTEGER PRIMARY KEY, business_book_id INTEGER, bill_type INTEGER);
  CREATE TABLE sales_bill_items (id INTEGER PRIMARY KEY, sales_bill_id INTEGER, description TEXT, unit TEXT, amount REAL);
  INSERT INTO po_items VALUES (11, 42, 1, '37mm pipe', 'mtr'), (12, 43, 1, '37mm pipe', 'PCS'),
    (13, 42, 1, 'Duplicate', 'Each'), (14, 42, 1, 'Duplicate', 'mtr');
  INSERT INTO sites VALUES (1, 42, 1);
  INSERT INTO dpr VALUES (1, 1, 8);
  INSERT INTO dpr_work_items VALUES (1, 1, NULL, '37mm pipe', 'PCS'), (2, 1, NULL, 'Duplicate', 'nos');
  INSERT INTO sales_bills VALUES (8, 1, 3), (9, 1, 2);
  INSERT INTO sales_bill_items VALUES (1, 8, '37mm pipe', 'PCS', 3750), (2, 9, '37mm pipe', 'PCS', 3750);
`);
assert.deepEqual(syncInstallationUnits(db), { workUpdated: 1, billsUpdated: 1 });
assert.deepEqual(db.prepare('SELECT po_item_id, unit FROM dpr_work_items WHERE id=1').get(), { po_item_id: 11, unit: 'mtr' });
assert.equal(db.prepare('SELECT unit FROM sales_bill_items WHERE id=1').get().unit, 'mtr');
assert.equal(db.prepare('SELECT po_item_id FROM dpr_work_items WHERE id=2').get().po_item_id, null);
assert.equal(db.prepare('SELECT unit FROM sales_bill_items WHERE id=2').get().unit, 'PCS');
assert.deepEqual(syncInstallationUnits(db), { workUpdated: 0, billsUpdated: 0 });
// A later Order to Planning edit updates the already-billed historical rows.
db.prepare('UPDATE po_items SET unit=? WHERE id=11').run('Meter');
assert.deepEqual(syncInstallationUnits(db, 2), { workUpdated: 0, billsUpdated: 0 });
assert.deepEqual(syncInstallationUnits(db, 1), { workUpdated: 1, billsUpdated: 1 });
assert.deepEqual(db.prepare('SELECT unit, amount FROM sales_bill_items WHERE id=1').get(), { unit: 'Meter', amount: 3750 });
db.close();
console.log('Historical unit synchronization regression checks passed');
