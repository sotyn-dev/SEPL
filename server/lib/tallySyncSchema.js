// Idempotent schema initialization for Tally Sync (TSK-0826)

function ensureTallySyncSchema(db) {
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_guid TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_alter_id INTEGER`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN is_tally_synced INTEGER DEFAULT 0`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_voucher_type TEXT DEFAULT 'Purchase'`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_company TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_party_gstin TEXT`); } catch (_) { }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_bills_guid ON tally_bills(tally_guid) WHERE tally_guid IS NOT NULL`); } catch (_) { }

  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN items_json TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tax_breakdown_json TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN purchase_ledger TEXT`); } catch (_) { }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tally_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_id INTEGER NOT NULL REFERENCES tally_bills(id) ON DELETE CASCADE,
      item_name TEXT NOT NULL,
      description TEXT,
      quantity REAL DEFAULT 0,
      unit TEXT,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_tally_bill_items_bill ON tally_bill_items(bill_id)`);
  } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bill_items ADD COLUMN discount REAL DEFAULT 0`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bill_items ADD COLUMN per_unit TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN subtotal REAL`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN round_off REAL`); } catch (_) { }

  // Sales sync support on sales_bills
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN tally_guid TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN tally_alter_id INTEGER`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN is_tally_synced INTEGER DEFAULT 0`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN customer_name TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN customer_gstin TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN tally_company TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN items_json TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE sales_bills ADD COLUMN tax_breakdown_json TEXT`); } catch (_) { }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sales_bills_tally_guid ON sales_bills(tally_guid) WHERE tally_guid IS NOT NULL`); } catch (_) { }

  // Bank transactions sync support on bank_transactions
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN tally_guid TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN tally_alter_id INTEGER`); } catch (_) { }
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN voucher_type TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN party_name TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE bank_transactions ADD COLUMN tally_company TEXT`); } catch (_) { }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_txn_tally_guid ON bank_transactions(tally_guid) WHERE tally_guid IS NOT NULL`); } catch (_) { }

  try {
    db.exec(`CREATE TABLE IF NOT EXISTS tally_sync_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sync_type TEXT NOT NULL,
      vouchers_received INTEGER DEFAULT 0,
      vouchers_added INTEGER DEFAULT 0,
      vouchers_updated INTEGER DEFAULT 0,
      vouchers_skipped INTEGER DEFAULT 0,
      last_alter_id INTEGER DEFAULT 0,
      company_name TEXT,
      status TEXT DEFAULT 'success',
      error_message TEXT,
      ip_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
  } catch (_) { }
}

module.exports = { ensureTallySyncSchema };
