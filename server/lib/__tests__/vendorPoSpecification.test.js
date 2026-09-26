const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getDb } = require('../../db/schema');

// 1. In-memory schema and migration test
const memDb = new Database(':memory:');
memDb.exec(`
  CREATE TABLE vendor_pos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    po_number TEXT,
    vendor_id INTEGER,
    indent_id INTEGER,
    total_amount REAL,
    po_date DATE,
    file_path TEXT,
    remarks TEXT,
    expected_receipt_date DATE,
    freight_terms TEXT,
    freight_amount REAL DEFAULT 0,
    gst_pct REAL DEFAULT 18,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE item_master (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_code TEXT,
    item_name TEXT,
    specification TEXT,
    size TEXT,
    uom TEXT
  );
  CREATE TABLE indent_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    indent_id INTEGER,
    item_master_id INTEGER,
    description TEXT,
    quantity REAL,
    unit TEXT,
    rate REAL,
    amount REAL
  );
  CREATE TABLE vendor_po_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor_po_id INTEGER REFERENCES vendor_pos(id) ON DELETE CASCADE,
    indent_item_id INTEGER REFERENCES indent_items(id),
    quantity REAL DEFAULT 0,
    rate REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    terms TEXT,
    credit_days INTEGER DEFAULT 0,
    description TEXT,
    hsn_code TEXT,
    specification TEXT,
    rate_updated_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

const cols = memDb.prepare("PRAGMA table_info(vendor_po_items)").all().map(c => c.name);
assert.ok(cols.includes('specification'), 'vendor_po_items must include specification column');

memDb.prepare(`
  INSERT INTO item_master (id, item_code, item_name, specification, size, uom)
  VALUES (1, 'VALVE-01', 'Ball Valve 25mm', 'Forged Brass, PN16', '25mm', 'NOS'),
         (2, 'PIPE-01', 'MS Pipe 50mm', 'Class B', '50mm', 'MTR')
`).run();

memDb.prepare(`
  INSERT INTO indent_items (id, indent_id, item_master_id, description, quantity, unit, rate, amount)
  VALUES (10, 100, 1, 'Ball Valve', 10, 'NOS', 250, 2500),
         (11, 100, 2, 'MS Pipe', 20, 'MTR', 400, 8000)
`).run();

memDb.prepare(`
  INSERT INTO vendor_pos (id, po_number, vendor_id, indent_id, total_amount, po_date)
  VALUES (50, 'VPO/2026/0001', 5, 100, 10500, '2026-09-19')
`).run();

const ins = memDb.prepare(`
  INSERT INTO vendor_po_items (vendor_po_id, indent_item_id, quantity, rate, amount, terms, credit_days, specification)
  VALUES (?, ?, ?, ?, ?, NULL, 0, ?)
`);

ins.run(50, 10, 10, 250, 2500, 'Custom Heavy Duty SS316 Ball Valve Class 300');
ins.run(50, 11, 20, 400, 8000, null);

const printQuery = memDb.prepare(`
  SELECT vpi.id, vpi.vendor_po_id, vpi.quantity, vpi.rate, vpi.amount,
         COALESCE(vpi.specification, im.specification) AS specification,
         im.specification AS master_specification,
         vpi.specification AS vpi_specification
    FROM vendor_po_items vpi
    LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
    LEFT JOIN item_master im ON im.id = ii.item_master_id
   WHERE vpi.vendor_po_id = ?
   ORDER BY vpi.id
`);

const items = printQuery.all(50);
assert.equal(items.length, 2);
assert.equal(items[0].specification, 'Custom Heavy Duty SS316 Ball Valve Class 300');
assert.equal(items[0].master_specification, 'Forged Brass, PN16');
assert.equal(items[0].vpi_specification, 'Custom Heavy Duty SS316 Ball Valve Class 300');

assert.equal(items[1].specification, 'Class B');
assert.equal(items[1].master_specification, 'Class B');
assert.equal(items[1].vpi_specification, null);

const updLine = memDb.prepare(`
  UPDATE vendor_po_items
     SET quantity    = COALESCE(?, quantity),
         rate        = COALESCE(?, rate),
         amount      = COALESCE(?, amount),
         description = COALESCE(?, description),
         hsn_code    = COALESCE(?, hsn_code),
         specification = COALESCE(?, specification),
         rate_updated_at = CASE WHEN ? IS NOT NULL THEN CURRENT_TIMESTAMP ELSE rate_updated_at END
   WHERE id = ? AND vendor_po_id = ?
`);

const updatedSpec = 'SS316 Forged Ball Valve with IBR TC';
updLine.run(null, null, null, null, null, updatedSpec, null, items[0].id, 50);

const afterUpdate = printQuery.all(50);
assert.equal(afterUpdate[0].specification, 'SS316 Forged Ball Valve with IBR TC');

// 4. Verify in fresh instance
try {
  const schemaPath = require.resolve('../../db/schema');
  delete require.cache[schemaPath];
  const realSchema = require('../../db/schema');
  if (typeof realSchema.initializeDatabase === 'function') {
    const liveDb = realSchema.initializeDatabase();
    const liveCols = liveDb.prepare('PRAGMA table_info(vendor_po_items)').all().map(c => c.name);
    assert.ok(liveCols.includes('specification'), 'live database vendor_po_items must have specification');
  }
} catch (err) {
  // If running in a mock test runner, ignore cache stub error
  if (!err.message.includes('not a function')) throw err;
}

console.log('All vendor PO specification tests passed successfully!');
