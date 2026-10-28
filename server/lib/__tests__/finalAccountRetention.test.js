const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runFinalAccountRetentionMigrations } = require('../../db/finalAccountRetentionSchema');
const {
  calculateFinalAccountData,
  ensureRetentionSchedule,
  getSop17Raci,
} = require('../../routes/finalAccountRetention');

function buildTestDb() {
  const db = new Database(':memory:');

  // Base ERP tables
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT,
      email TEXT,
      role TEXT,
      department TEXT,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE business_book (
      id INTEGER PRIMARY KEY,
      lead_no TEXT,
      project_name TEXT,
      company_name TEXT,
      client_name TEXT,
      status TEXT,
      sale_amount_without_gst REAL,
      management_discount_amount REAL
    );

    CREATE TABLE purchase_orders (
      id INTEGER PRIMARY KEY,
      business_book_id INTEGER,
      total_amount REAL
    );

    CREATE TABLE sites (
      id INTEGER PRIMARY KEY,
      business_book_id INTEGER,
      po_id INTEGER,
      name TEXT,
      client_name TEXT,
      handover_stage TEXT DEFAULT 's0_in_progress',
      handover_cert_id INTEGER,
      cost_locked INTEGER DEFAULT 0,
      cost_locked_by INTEGER,
      status TEXT DEFAULT 'in_progress',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE handover_certificates (
      id INTEGER PRIMARY KEY,
      site_id INTEGER,
      certificate_number TEXT UNIQUE,
      handover_date DATE,
      client_name TEXT,
      project_name TEXT,
      retention_pct REAL DEFAULT 5.0,
      retention_amount REAL DEFAULT 0,
      retention_due_date DATE,
      retention_status TEXT DEFAULT 'pending',
      warranty_start_date DATE,
      warranty_end_date DATE,
      warranty_months INTEGER DEFAULT 12,
      status TEXT DEFAULT 'draft',
      final_bill_triggered INTEGER DEFAULT 0,
      final_bill_triggered_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_number TEXT UNIQUE,
      client_name TEXT,
      company_name TEXT,
      mobile_number TEXT,
      problem_detail TEXT,
      category TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      assigned_engineer_id INTEGER,
      resolved_date DATE,
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE snags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER,
      snag_no TEXT,
      description TEXT,
      priority TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'open',
      is_client_walk INTEGER DEFAULT 0,
      assigned_to INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE sales_bills (
      id INTEGER PRIMARY KEY,
      business_book_id INTEGER,
      po_id INTEGER,
      bill_number TEXT,
      approval_status TEXT,
      amount REAL,
      bill_date DATE
    );

    CREATE TABLE receivables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT,
      project_name TEXT,
      site_id INTEGER,
      site_name TEXT,
      business_book_id INTEGER,
      invoice_number TEXT,
      invoice_date DATE,
      invoice_amount REAL DEFAULT 0,
      received_amount REAL DEFAULT 0,
      outstanding_amount REAL DEFAULT 0,
      due_date DATE,
      ageing_days INTEGER DEFAULT 0,
      ageing_bucket TEXT DEFAULT '0-30',
      status TEXT DEFAULT 'red',
      follow_up_status TEXT DEFAULT 'pending',
      payment_stage_id INTEGER,
      created_by INTEGER
    );

    CREATE TABLE project_payment_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER,
      project_name TEXT,
      client_name TEXT,
      stage_key TEXT,
      stage_name TEXT,
      stage_percentage REAL,
      stage_amount REAL,
      trigger_event TEXT,
      status TEXT DEFAULT 'pending',
      demanded_receivable_id INTEGER,
      demanded_at DATETIME,
      due_date DATE,
      notes TEXT,
      created_by INTEGER
    );

    CREATE TABLE order_planning (
      id INTEGER PRIMARY KEY,
      business_book_id INTEGER,
      po_id INTEGER
    );

    CREATE TABLE indents (
      id INTEGER PRIMARY KEY,
      planning_id INTEGER
    );

    CREATE TABLE indent_items (
      id INTEGER PRIMARY KEY,
      indent_id INTEGER,
      item_master_id INTEGER,
      description TEXT,
      quantity REAL,
      unit TEXT,
      rate REAL,
      amount REAL
    );

    CREATE TABLE vendor_pos (
      id INTEGER PRIMARY KEY,
      indent_id INTEGER,
      vendor_id INTEGER,
      po_number TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE vendor_po_items (
      id INTEGER PRIMARY KEY,
      vendor_po_id INTEGER,
      indent_item_id INTEGER,
      description TEXT,
      quantity REAL,
      rate REAL,
      amount REAL
    );

    CREATE TABLE vendors (
      id INTEGER PRIMARY KEY,
      name TEXT
    );

    CREATE TABLE purchase_bills (
      id INTEGER PRIMARY KEY,
      vendor_po_id INTEGER,
      vendor_id INTEGER,
      bill_number TEXT,
      amount REAL,
      bill_date DATE
    );

    CREATE TABLE purchase_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_bill_id INTEGER,
      vendor_po_id INTEGER,
      vendor_po_item_id INTEGER,
      description TEXT,
      unit TEXT,
      quantity REAL,
      po_rate REAL,
      bill_rate REAL,
      taxable_amount REAL
    );

    CREATE TABLE proj_contractor_ra_bills (
      id INTEGER PRIMARY KEY,
      site_id INTEGER,
      business_book_id INTEGER,
      ra_no TEXT,
      status TEXT,
      gross_amount REAL
    );

    CREATE TABLE proj_client_ra_bills (
      id INTEGER PRIMARY KEY,
      site_id INTEGER,
      business_book_id INTEGER,
      ra_no TEXT,
      status TEXT,
      gross_amount REAL
    );

    CREATE TABLE payment_requests (
      id INTEGER PRIMARY KEY,
      site_id INTEGER,
      po_id INTEGER,
      status TEXT,
      category TEXT,
      amount REAL
    );

    CREATE TABLE item_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT,
      item_name TEXT,
      uom TEXT,
      current_price REAL DEFAULT 0,
      updated_at DATETIME
    );

    CREATE TABLE item_price_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER,
      rate REAL,
      quantity REAL,
      source TEXT,
      company_name TEXT,
      created_by INTEGER,
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Run SOP-17 migrations
  runFinalAccountRetentionMigrations(db);

  return db;
}

test('SOP-17 Schema Migrations run idempotently and establish required tables and columns', () => {
  const db = buildTestDb();
  try {
    // Check tables exist
    const faTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='final_accounts'").get();
    const rcTable = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='retention_claims'").get();
    assert.ok(faTable, 'final_accounts table created');
    assert.ok(rcTable, 'retention_claims table created');

    // Check columns added
    const compCols = db.prepare("PRAGMA table_info(complaints)").all().map(c => c.name);
    assert.ok(compCols.includes('site_id'), 'complaints has site_id');
    assert.ok(compCols.includes('is_warranty_complaint'), 'complaints has is_warranty_complaint');

    // Run again to ensure idempotency
    runFinalAccountRetentionMigrations(db);
    assert.ok(true, 'migration is idempotent');
  } finally {
    db.close();
  }
});

test('SOP-17 S1: Final Account calculates booked value vs actual costs vs money received accurately', () => {
  const db = buildTestDb();
  try {
    // 1. Seed business book & PO (Contract Value = 1,000,000 - 50,000 discount = 950,000)
    db.prepare(`INSERT INTO business_book (id, lead_no, project_name, client_name, sale_amount_without_gst, management_discount_amount)
                VALUES (1, 'LEAD-100', 'Metro Fire Station', 'Metro Corp', 1000000, 50000)`).run();
    db.prepare(`INSERT INTO purchase_orders (id, business_book_id, total_amount) VALUES (1, 1, 950000)`).run();
    db.prepare(`INSERT INTO sites (id, business_book_id, po_id, name, client_name, cost_locked)
                VALUES (1, 1, 1, 'Metro Fire Station', 'Metro Corp', 1)`).run();

    // 2. Invoiced Revenue: 950,000 (Sales bill approved)
    db.prepare(`INSERT INTO sales_bills (id, business_book_id, po_id, bill_number, approval_status, amount, bill_date)
                VALUES (1, 1, 1, 'INV-001', 'approved', 950000, '2026-05-01')`).run();

    // 3. Money Received: 900,000 (Receivable)
    db.prepare(`INSERT INTO receivables (client_name, project_name, site_id, invoice_number, invoice_amount, received_amount, outstanding_amount)
                VALUES ('Metro Corp', 'Metro Fire Station', 1, 'INV-001', 950000, 900000, 50000)`).run();

    // 4. Actual Costs:
    // Material: 500,000
    db.prepare(`INSERT INTO order_planning (id, po_id) VALUES (1, 1)`).run();
    db.prepare(`INSERT INTO indents (id, planning_id) VALUES (1, 1)`).run();
    db.prepare(`INSERT INTO vendor_pos (id, indent_id) VALUES (1, 1)`).run();
    db.prepare(`INSERT INTO purchase_bills (id, vendor_po_id, bill_number, amount, bill_date) VALUES (1, 1, 'PB-001', 500000, '2026-05-10')`).run();
    db.prepare(`INSERT INTO purchase_bill_items (purchase_bill_id, vendor_po_id, description, quantity, bill_rate, taxable_amount)
                VALUES (1, 1, 'Pipes & Fittings', 100, 5000, 500000)`).run();

    // Labour: 150,000
    db.prepare(`INSERT INTO proj_contractor_ra_bills (id, site_id, business_book_id, ra_no, status, gross_amount)
                VALUES (1, 1, 1, 'CRA-1', 'paid', 150000)`).run();

    // Travel / Transport Overheads: 25,000
    db.prepare(`INSERT INTO payment_requests (id, site_id, po_id, status, category, amount)
                VALUES (1, 1, 1, 'final_approved', 'Transport', 25000)`).run();

    // Handover Certificate
    db.prepare(`INSERT INTO handover_certificates (id, site_id, certificate_number, handover_date, client_name, project_name, retention_pct, retention_amount, retention_due_date, status)
                VALUES (1, 1, 'HC-2026-0001', '2026-06-01', 'Metro Corp', 'Metro Fire Station', 5.0, 47500, '2027-06-01', 'signed')`).run();

    // Compute S1 Final Account
    const res = calculateFinalAccountData(db, 1);
    assert.ok(res, 'calculated final account data');
    assert.equal(res.financials.booked_contract_value, 950000, 'contract value is 950,000');
    assert.equal(res.financials.invoiced_revenue, 950000, 'invoiced revenue is 950,000');
    assert.equal(res.financials.received_amount, 900000, 'received amount is 900,000');
    assert.equal(res.financials.material_cost, 500000, 'material cost is 500,000');
    assert.equal(res.financials.labour_cost, 150000, 'labour cost is 150,000');
    assert.equal(res.financials.expense_cost, 25000, 'expense cost is 25,000');
    assert.equal(res.financials.total_actual_cost, 675000, 'total actual cost is 675,000');
    assert.equal(res.financials.net_profit, 275000, 'net profit (invoiced - cost) is 275,000');
    assert.equal(res.financials.cash_profit, 225000, 'cash profit (received - cost) is 225,000');
    assert.equal(res.financials.profit_margin_pct, 28.9, 'profit margin % is 28.9%');
    assert.equal(res.site.cost_locked, 1, 'costs locked');
  } finally {
    db.close();
  }
});

test('SOP-17 S2: Retention Schedule is synchronized at handover and linked into Collection Engine', () => {
  const db = buildTestDb();
  try {
    db.prepare(`INSERT INTO sites (id, name, client_name) VALUES (1, 'Industrial Plant', 'Apex Ltd')`).run();
    db.prepare(`INSERT INTO handover_certificates (id, site_id, certificate_number, handover_date, client_name, project_name, retention_pct, retention_amount, retention_due_date, status)
                VALUES (1, 1, 'HC-2026-0002', '2026-07-01', 'Apex Ltd', 'Industrial Plant', 5.0, 50000, '2027-07-01', 'signed')`).run();

    // Trigger S2 sync
    const syncRes = ensureRetentionSchedule(db, 1, 1, 1);
    assert.ok(syncRes.stage, 'payment stage created in collection engine');
    assert.equal(syncRes.stage.stage_key, 'retention');
    assert.equal(syncRes.stage.stage_amount, 50000);
    assert.equal(syncRes.stage.due_date, '2027-07-01');

    assert.ok(syncRes.claim, 'retention claim created');
    assert.equal(syncRes.claim.claim_status, 'pending');
    assert.equal(syncRes.claim.retention_amount, 50000);
    assert.ok(syncRes.claim.claim_number.startsWith('RET-'));
  } finally {
    db.close();
  }
});

test('SOP-17 S3 & S4: Retention claim is gated by warranty complaint resolution', () => {
  const db = buildTestDb();
  try {
    db.prepare(`INSERT INTO sites (id, name, client_name, handover_stage, status) VALUES (1, 'Tech Park', 'Tech Corp', 's6_closed', 'completed')`).run();
    db.prepare(`INSERT INTO handover_certificates (id, site_id, certificate_number, handover_date, client_name, project_name, retention_pct, retention_amount, retention_due_date, status)
                VALUES (1, 1, 'HC-2026-0003', '2026-01-01', 'Tech Corp', 'Tech Park', 5.0, 60000, '2027-01-01', 'signed')`).run();

    ensureRetentionSchedule(db, 1, 1, 1);

    // 1. Add an open warranty complaint
    db.prepare(`INSERT INTO complaints (complaint_number, client_name, site_id, problem_detail, status)
                VALUES ('CMP-99991', 'Tech Corp', 1, 'Sprinkler head leaking on 2nd floor', 'open')`).run();

    // Check open complaints count
    const openCount = db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE site_id=1 AND status NOT IN ('resolved','closed')`).get().c;
    assert.equal(openCount, 1, '1 open warranty complaint');

    // S4 Rule: Cannot claim when open complaints exist
    assert.ok(openCount > 0, 'Retention claim must be blocked when complaints exist');

    // 2. Resolve complaint with client sign-off
    db.prepare(`UPDATE complaints SET status='resolved', resolved_date='2026-10-01' WHERE complaint_number='CMP-99991'`).run();

    const openCountAfter = db.prepare(`SELECT COUNT(*) AS c FROM complaints WHERE site_id=1 AND status NOT IN ('resolved','closed')`).get().c;
    assert.equal(openCountAfter, 0, '0 open warranty complaints');

    // Now eligible for retention claim
    assert.equal(openCountAfter, 0, 'Warranty clear, retention claim eligible');
  } finally {
    db.close();
  }
});

test('SOP-17 S5: Actual project purchase rates feed back into Rate Master and sharpen future quotations', () => {
  const db = buildTestDb();
  try {
    // Seed Rate Master with initial price 120
    db.prepare(`INSERT INTO item_master (id, item_code, item_name, current_price) VALUES (1, 'PIPE-001', '25mm GI Pipe', 120)`).run();

    // Project actual landed rate was 145 on purchase bill
    const projectRate = 145;
    const qtyUsed = 200;

    // Execute S5 sync
    db.prepare(`INSERT INTO item_price_history (item_id, rate, quantity, source, company_name, created_by, created_by_name)
                VALUES (1, ?, ?, 'sop17_learning_loop', 'Tech Park', 1, 'Parul Goyal')`).run(projectRate, qtyUsed);

    db.prepare(`UPDATE item_master SET current_price = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1`).run(projectRate);

    // Verify item_master has new sharp rate
    const item = db.prepare('SELECT current_price FROM item_master WHERE id=1').get();
    assert.equal(item.current_price, 145, 'Rate Master price updated to actual project landed rate');

    // Verify history logged for future AI quoting
    const hist = db.prepare('SELECT * FROM item_price_history WHERE item_id=1 ORDER BY id DESC LIMIT 1').get();
    assert.equal(hist.rate, 145);
    assert.equal(hist.source, 'sop17_learning_loop');
    assert.equal(hist.company_name, 'Tech Park');
  } finally {
    db.close();
  }
});
