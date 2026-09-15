const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { basePo, findOrderPoConflict, conflictMessage } = require('../orderPoMatch');

assert.equal(basePo('CPL/SEPL/10/25-26 L7'), 'cpl/sepl/10/25-26');
assert.equal(basePo(' CPL / SEPL/10/25-26 '), 'cpl/sepl/10/25-26');
assert.equal(basePo('PO-12 L'), 'po-12l');            // a bare "L" is part of the number, not a line tag
assert.equal(basePo(''), '');

const db = new Database(':memory:');
db.exec(`CREATE TABLE business_book (id INTEGER PRIMARY KEY, lead_no TEXT, po_number TEXT);
  CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, po_number TEXT, business_book_id INTEGER);
  INSERT INTO business_book VALUES (1,'SEPL20271','CPL/SEPL/10/25-26'), (2,'SEPL20100',NULL), (3,'SEPL20090','ABC/1');
  INSERT INTO purchase_orders VALUES (10,'CPL/SEPL/10/25-26',1), (11,'UNLINKED/9',NULL);`);

// New lead for a PO line of a PO already in Order to Planning → points at its lead.
const c1 = findOrderPoConflict(db, 'CPL/SEPL/10/25-26 L7');
assert.equal(c1.source, 'order_planning');
assert.equal(c1.lead_no, 'SEPL20271');
assert.match(conflictMessage(c1), /Open SEPL20271/);

// The owning lead itself may keep / re-save its own PO.
assert.equal(findOrderPoConflict(db, 'cpl/sepl/10/25-26', { leadId: 1 }), null);
// Another lead may not take it.
assert.equal(findOrderPoConflict(db, 'CPL/SEPL/10/25-26', { leadId: 2 }).lead_no, 'SEPL20271');

// PO in Order to Planning but not linked yet → tell them to link it.
const c2 = findOrderPoConflict(db, 'UNLINKED/9');
assert.equal(c2.source, 'order_planning');
assert.equal(c2.lead_id, null);
assert.match(conflictMessage(c2), /not linked to a lead/);

// Only in Business Book (no Order to Planning PO yet) → still one lead per PO.
const c3 = findOrderPoConflict(db, 'ABC/1 L2');
assert.equal(c3.source, 'business_book');
assert.equal(c3.lead_no, 'SEPL20090');
assert.equal(findOrderPoConflict(db, 'ABC/1', { leadId: 3 }), null);

// A brand-new PO is fine.
assert.equal(findOrderPoConflict(db, 'NEW/PO/1'), null);

db.close();
console.log('Order PO match checks passed: line-tagged PO copies, Order to Planning owner, unlinked PO, self-save, new PO');
