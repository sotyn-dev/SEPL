const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { makeDeliveryBillResolver, parsePct } = require('../indentDeliveryBill');

assert.equal(parsePct('70%'), 70);
assert.equal(parsePct(' 30 % against delivery'), 30);
assert.equal(parsePct(null), 0);

const db = new Database(':memory:');
db.exec(`CREATE TABLE po_items (id INTEGER PRIMARY KEY, business_book_id INTEGER, rate REAL, description TEXT);
  CREATE TABLE business_book (id INTEGER PRIMARY KEY, payment_against_delivery TEXT, project_name TEXT, company_name TEXT);
  CREATE TABLE sites (name TEXT, business_book_id INTEGER);
  INSERT INTO business_book VALUES (1,'70%','Project One','Co One'), (2,'40','Project Two','Co Two');
  INSERT INTO po_items VALUES (100,1,500,'Pipe 50mm'), (101,1,250,'Valve 25mm'), (200,2,90,'Cable');
  INSERT INTO sites VALUES ('Site Two', 2);`);
const resolve = makeDeliveryBillResolver(db);

// Planning order + its term; linked rate, description match, FOC, unpriced.
const items = [
  { id: 1, quantity: 10, description: 'anything', item_type: 'PO', po_item_id: 100 },
  { id: 2, quantity: 4, description: ' valve 25MM ', item_type: 'PO', po_item_id: null },
  { id: 3, quantity: 99, description: 'Pipe 50mm', item_type: 'FOC', po_item_id: 100 },
  { id: 4, quantity: 3, description: 'Unknown thing', item_type: 'PO', po_item_id: null },
];
const r1 = resolve({ business_book_id: 1, bb_delivery_terms: '70%', site_name: 'x' }, items);
assert.equal(r1.bb_source, 'planning');
assert.deepEqual(r1.lines.map(l => l.rate_source), ['po_item', 'boq_description', 'not_billed', 'none']);
assert.equal(r1.billable, 10 * 500 + 4 * 250);
assert.equal(r1.pct, 70);
assert.equal(r1.pct_source, 'planning');
assert.equal(r1.delivery, 6000 * 0.7);
assert.equal(items[1].boq_sale_rate, 250);
assert.equal(items[1].billable_line, 1000);

// No planning link: order from the first linked line, % from Business Book.
const r2 = resolve({ business_book_id: null, bb_delivery_terms: null, site_name: '' },
  [{ id: 5, quantity: 2, description: 'Cable', item_type: 'PO', po_item_id: 200 }]);
assert.equal(r2.bb_source, 'po_item');
assert.equal(r2.business_book_id, 2);
assert.equal(r2.pct_source, 'business_book');
assert.equal(r2.delivery, 2 * 90 * 0.4);

// No links at all: order from the site name; description match inside it.
const r3 = resolve({ business_book_id: null, bb_delivery_terms: '', site_name: 'Site Two' },
  [{ id: 6, quantity: 5, description: 'cable', item_type: 'PO', po_item_id: null }]);
assert.equal(r3.bb_source, 'site');
assert.equal(r3.lines[0].rate_source, 'boq_description');
assert.equal(r3.billable, 450);

// Nothing resolvable → zero, with sources saying so.
const r4 = resolve({ business_book_id: null, bb_delivery_terms: '', site_name: 'Nowhere' },
  [{ id: 7, quantity: 5, description: 'cable', item_type: 'PO', po_item_id: null }]);
assert.equal(r4.business_book_id, null);
assert.equal(r4.bb_source, null);
assert.equal(r4.pct_source, null);
assert.equal(r4.delivery, 0);

db.close();
console.log('Indent delivery bill checks passed: rate sources, order resolution, % source, totals');
