const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

// In-memory test db
const db = new Database(':memory:');

db.exec(`
  CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT);
  CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT);
  CREATE TABLE warehouses (id INTEGER PRIMARY KEY, name TEXT, type TEXT, site_id INTEGER, active INTEGER DEFAULT 1);
  CREATE TABLE item_master (id INTEGER PRIMARY KEY, item_name TEXT, specification TEXT, size TEXT, uom TEXT);
  CREATE TABLE stock_balance (id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, item_master_id INTEGER, quantity REAL DEFAULT 0, avg_rate REAL DEFAULT 0, updated_at DATETIME);
  CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY AUTOINCREMENT, warehouse_id INTEGER, item_master_id INTEGER, type TEXT,
    quantity REAL, rate REAL, total_value REAL, reference_type TEXT, reference_id TEXT,
    from_warehouse_id INTEGER, to_warehouse_id INTEGER, site_id INTEGER, notes TEXT, created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE site_store_slips (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_number TEXT UNIQUE,
    slip_type TEXT NOT NULL CHECK(slip_type IN ('issue','return','transfer')),
    site_id INTEGER NOT NULL REFERENCES sites(id),
    warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
    to_warehouse_id INTEGER REFERENCES warehouses(id),
    slip_date DATE NOT NULL,
    issued_to TEXT,
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    shift TEXT DEFAULT 'day'
  );
  CREATE TABLE site_store_slip_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slip_id INTEGER NOT NULL REFERENCES site_store_slips(id) ON DELETE CASCADE,
    item_master_id INTEGER NOT NULL REFERENCES item_master(id),
    item_name TEXT,
    unit TEXT,
    quantity REAL NOT NULL,
    rate REAL DEFAULT 0
  );
`);

// Seed test data
db.prepare("INSERT INTO users (id, name, role) VALUES (1, 'Admin', 'admin'), (2, 'Abhishek', 'user')").run();
db.prepare("INSERT INTO sites (id, name) VALUES (10, 'Site Alpha'), (20, 'Site Beta')").run();
db.prepare("INSERT INTO warehouses (id, name, type, site_id, active) VALUES (1, 'Office Store', 'office', NULL, 1)").run();
db.prepare("INSERT INTO warehouses (id, name, type, site_id, active) VALUES (2, 'Site Alpha Store', 'site_store', 10, 1)").run();
db.prepare("INSERT INTO warehouses (id, name, type, site_id, active) VALUES (3, 'Site Beta Store', 'site_store', 20, 1)").run();
db.prepare("INSERT INTO item_master (id, item_name, specification, size, uom) VALUES (100, 'Smoke Detector Base', 'Conventional', 'Na', 'PCS')").run();

// Initial balance: Site Alpha has 20 PCS @ rate 50
db.prepare("INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (2, 100, 20, 50)").run();

// Test helper: execute transfer
function executeTransfer(siteId, toWarehouseId, items, issuedTo, notes, userId = 2) {
  const store = db.prepare("SELECT id, name FROM warehouses WHERE site_id = ? AND type = 'site_store' AND active = 1").get(siteId);
  assert.ok(store, 'Store must exist');
  assert.notEqual(store.id, toWarehouseId, 'Source and target warehouse must differ');

  const targetStore = db.prepare("SELECT id, name FROM warehouses WHERE id = ? AND active = 1").get(toWarehouseId);
  assert.ok(targetStore, 'Target store must exist');

  const getBal = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id = ? AND item_master_id = ?');

  // Validation
  for (const it of items) {
    const bal = +(getBal.get(store.id, it.item_master_id)?.quantity || 0);
    if (it.quantity > bal) {
      throw new Error(`Insufficient stock: have ${bal}, requested ${it.quantity}`);
    }
  }

  const slipNumber = `XFR/2026/0001`;
  let slipId;
  db.transaction(() => {
    const r = db.prepare(`
      INSERT INTO site_store_slips (slip_number, slip_type, site_id, warehouse_id, to_warehouse_id, slip_date, issued_to, notes, created_by, shift)
      VALUES (?, 'transfer', ?, ?, ?, '2026-09-19', ?, ?, ?, 'day')
    `).run(slipNumber, siteId, store.id, toWarehouseId, issuedTo, notes, userId);
    slipId = r.lastInsertRowid;

    for (const it of items) {
      const bal = getBal.get(store.id, it.item_master_id);
      const rate = +(bal?.avg_rate || 0);
      db.prepare("INSERT INTO site_store_slip_items (slip_id, item_master_id, item_name, unit, quantity, rate) VALUES (?, ?, 'Smoke Detector Base', 'PCS', ?, ?)")
        .run(slipId, it.item_master_id, it.quantity, rate);

      // Decrement source
      db.prepare("UPDATE stock_balance SET quantity = quantity - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(it.quantity, bal.id);
      db.prepare(`
        INSERT INTO stock_movements (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, reference_id, to_warehouse_id, site_id, notes, created_by)
        VALUES (?, ?, 'OUT', ?, ?, ?, 'TRANSFER', ?, ?, ?, ?, ?)
      `).run(store.id, it.item_master_id, it.quantity, rate, it.quantity * rate, slipNumber, toWarehouseId, siteId, notes, userId);

      // Increment destination
      const targetBal = getBal.get(targetStore.id, it.item_master_id);
      if (targetBal) {
        const newQty = targetBal.quantity + it.quantity;
        const newAvg = (targetBal.quantity * targetBal.avg_rate + it.quantity * rate) / newQty;
        db.prepare("UPDATE stock_balance SET quantity = ?, avg_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(newQty, newAvg, targetBal.id);
      } else {
        db.prepare("INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?, ?, ?, ?)").run(targetStore.id, it.item_master_id, it.quantity, rate);
      }
      db.prepare(`
        INSERT INTO stock_movements (warehouse_id, item_master_id, type, quantity, rate, total_value, reference_type, reference_id, from_warehouse_id, site_id, notes, created_by)
        VALUES (?, ?, 'IN', ?, ?, ?, 'TRANSFER', ?, ?, ?, ?, ?)
      `).run(targetStore.id, it.item_master_id, it.quantity, rate, it.quantity * rate, slipNumber, store.id, siteId, notes, userId);
    }
  })();

  return { slipId, slipNumber };
}

// 1. Transfer 5 PCS from Site Alpha to Office Store
const res1 = executeTransfer(10, 1, [{ item_master_id: 100, quantity: 5 }], 'Abhishek', 'Surplus return to office');
assert.equal(res1.slipNumber, 'XFR/2026/0001');

// Verify balances
const alphaBal1 = db.prepare("SELECT quantity FROM stock_balance WHERE warehouse_id = 2 AND item_master_id = 100").get();
assert.equal(alphaBal1.quantity, 15, 'Site Alpha should now have 15 PCS');

const officeBal = db.prepare("SELECT quantity, avg_rate FROM stock_balance WHERE warehouse_id = 1 AND item_master_id = 100").get();
assert.equal(officeBal.quantity, 5, 'Office Store should now have 5 PCS');
assert.equal(officeBal.avg_rate, 50, 'Office Store rate should match');

// Verify movements logged
const mvAlpha = db.prepare("SELECT * FROM stock_movements WHERE warehouse_id = 2").get();
assert.equal(mvAlpha.type, 'OUT');
assert.equal(mvAlpha.reference_type, 'TRANSFER');
assert.equal(mvAlpha.quantity, 5);

const mvOffice = db.prepare("SELECT * FROM stock_movements WHERE warehouse_id = 1").get();
assert.equal(mvOffice.type, 'IN');
assert.equal(mvOffice.reference_type, 'TRANSFER');
assert.equal(mvOffice.from_warehouse_id, 2);

// 2. Over-transfer test: try to transfer 20 when only 15 remain -> should throw
assert.throws(() => {
  executeTransfer(10, 1, [{ item_master_id: 100, quantity: 20 }], 'Abhishek', 'Over transfer');
}, /Insufficient stock/);

console.log('Site store transfer regression checks passed successfully!');
db.close();
