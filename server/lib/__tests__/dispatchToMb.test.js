const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { syncDispatchToMb } = require('../dispatchToMb');

let db;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = OFF'); // test setup simplicity

  db.exec(`
    CREATE TABLE business_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT,
      project_name TEXT,
      client_name TEXT,
      site_address TEXT
    );

    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER,
      po_number TEXT
    );

    CREATE TABLE order_planning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER,
      business_book_id INTEGER
    );

    CREATE TABLE indents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_number TEXT,
      site_name TEXT,
      site_id INTEGER,
      planning_id INTEGER
    );

    CREATE TABLE vendor_pos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER,
      po_number TEXT,
      vendor_name TEXT
    );

    CREATE TABLE delivery_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER,
      indent_id INTEGER,
      source TEXT,
      delivery_date DATE,
      document_type TEXT,
      document_number TEXT,
      status TEXT,
      items_json TEXT,
      notes TEXT
    );

    CREATE TABLE installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER,
      business_book_id INTEGER,
      site_address TEXT,
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'pending',
      assigned_to INTEGER,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE mb_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER,
      installation_id INTEGER,
      bill_number TEXT,
      measurements TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft',
      delivery_note_id INTEGER,
      source TEXT DEFAULT 'manual',
      items_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
});

test('syncDispatchToMb: auto-creates installation and draft MB entry for new dispatch challan', () => {
  // 1. Setup planning & indent
  db.exec(`
    INSERT INTO business_book (id, project_name, client_name, site_address)
    VALUES (1, 'Solar Rooftop 100kW', 'Acme Corp', 'Sector 62, Noida');

    INSERT INTO purchase_orders (id, business_book_id, po_number)
    VALUES (10, 1, 'PO-ACME-001');

    INSERT INTO order_planning (id, po_id, business_book_id)
    VALUES (100, 10, 1);

    INSERT INTO indents (id, indent_number, site_name, planning_id)
    VALUES (500, 'IND-001', 'Sector 62, Noida', 100);

    INSERT INTO delivery_notes (id, indent_id, source, delivery_date, document_type, document_number, status, items_json)
    VALUES (1, 500, 'store', '2026-09-28', 'challan', 'DC/2026/0001', 'pending',
      '[{"description":"Solar Panel 540W","qty":50,"unit":"Nos","rate":8000},{"description":"Structure Mounting Kit","qty":50,"unit":"Set","rate":1200}]'
    );
  `);

  const res = syncDispatchToMb(db, 1, { id: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.action, 'created');
  assert.ok(res.mb_id > 0);
  assert.match(res.bill_number, /^MB\/\d{4}\/\d{4}$/);

  // Check installation created
  const inst = db.prepare('SELECT * FROM installations WHERE id = ?').get(res.installation_id);
  assert.ok(inst);
  assert.equal(inst.po_id, 10);
  assert.equal(inst.business_book_id, 1);
  assert.equal(inst.site_address, 'Sector 62, Noida');

  // Check MB bill created
  const mb = db.prepare('SELECT * FROM mb_bills WHERE id = ?').get(res.mb_id);
  assert.ok(mb);
  assert.equal(mb.installation_id, inst.id);
  assert.equal(mb.status, 'draft');
  assert.equal(mb.source, 'auto_dispatch');
  assert.equal(mb.delivery_note_id, 1);
  // (50 * 8000) + (50 * 1200) = 400000 + 60000 = 460000
  assert.equal(mb.total_amount, 460000);
  assert.match(mb.measurements, /DC\/2026\/0001/);
  assert.match(mb.measurements, /Solar Panel 540W/);
});

test('syncDispatchToMb: re-uses existing installation for the project', () => {
  db.exec(`
    INSERT INTO business_book (id, project_name, client_name, site_address)
    VALUES (2, 'Noida Mall Project', 'DLF', 'Plot 4, Expressway');

    INSERT INTO purchase_orders (id, business_book_id, po_number)
    VALUES (20, 2, 'PO-DLF-002');

    INSERT INTO order_planning (id, po_id, business_book_id)
    VALUES (200, 20, 2);

    INSERT INTO installations (id, po_id, business_book_id, site_address, status)
    VALUES (77, 20, 2, 'Plot 4, Expressway', 'in_progress');

    INSERT INTO indents (id, indent_number, site_name, planning_id)
    VALUES (501, 'IND-002', 'Plot 4, Expressway', 200);

    INSERT INTO delivery_notes (id, indent_id, source, delivery_date, document_type, document_number, status, items_json)
    VALUES (2, 501, 'store', '2026-09-28', 'challan', 'DC/2026/0002', 'pending',
      '[{"description":"Inverter 50kW","qty":2,"unit":"Nos","rate":150000}]'
    );
  `);

  const res = syncDispatchToMb(db, 2);
  assert.equal(res.ok, true);
  assert.equal(res.installation_id, 77); // re-used existing installation!

  const count = db.prepare('SELECT COUNT(*) as c FROM installations').get().c;
  assert.equal(count, 1); // no duplicate installation created
});

test('syncDispatchToMb: idempotent update when site marks received with shortage', () => {
  db.exec(`
    INSERT INTO delivery_notes (id, source, delivery_date, document_type, document_number, status, items_json)
    VALUES (3, 'po', '2026-09-28', 'challan', 'DC/2026/0003', 'pending',
      '[{"description":"Copper Cable 1Core 4sqmm","qty":1000,"unit":"Mtr","rate":40}]'
    );
  `);

  // First sync on dispatch
  const res1 = syncDispatchToMb(db, 3);
  assert.equal(res1.ok, true);
  assert.equal(res1.action, 'created');

  const mb1 = db.prepare('SELECT * FROM mb_bills WHERE id = ?').get(res1.mb_id);
  assert.equal(mb1.total_amount, 40000); // 1000 * 40

  // Site receives short: 900 received out of 1000
  db.prepare(`
    UPDATE delivery_notes
       SET status = 'received',
           items_json = ?
     WHERE id = 3
  `).run(JSON.stringify([
    { description: 'Copper Cable 1Core 4sqmm', ordered_qty: 1000, received_qty: 900, rate: 40, unit: 'Mtr', short_reason: '100m roll damaged in transit' }
  ]));

  // Second sync on site receive
  const res2 = syncDispatchToMb(db, 3);
  assert.equal(res2.ok, true);
  assert.equal(res2.action, 'updated');
  assert.equal(res2.mb_id, res1.mb_id); // updated same MB bill!

  const mb2 = db.prepare('SELECT * FROM mb_bills WHERE id = ?').get(res1.mb_id);
  assert.equal(mb2.total_amount, 36000); // 900 * 40
  assert.match(mb2.measurements, /100m roll damaged in transit/);
  assert.match(mb2.measurements, /Received at Site/);
});

test('syncDispatchToMb: ignores sales bills (tax invoices)', () => {
  db.exec(`
    INSERT INTO delivery_notes (id, source, delivery_date, document_type, document_number, status, items_json)
    VALUES (4, 'po', '2026-09-28', 'sales_bill', 'GST/26-26/01', 'pending', '[]')
  `);

  const res = syncDispatchToMb(db, 4);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'Sales bill is not a physical material dispatch');

  const mbCount = db.prepare('SELECT COUNT(*) as c FROM mb_bills').get().c;
  assert.equal(mbCount, 0);
});
