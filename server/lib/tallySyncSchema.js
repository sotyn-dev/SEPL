// Idempotent schema initialization for Tally Sync (TSK-0826)

function ensureTallySyncSchema(db) {
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_guid TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_alter_id INTEGER`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN is_tally_synced INTEGER DEFAULT 0`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_voucher_type TEXT DEFAULT 'Purchase'`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_company TEXT`); } catch (_) { }
  try { db.exec(`ALTER TABLE tally_bills ADD COLUMN tally_party_gstin TEXT`); } catch (_) { }
  try { db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_tally_bills_guid ON tally_bills(tally_guid) WHERE tally_guid IS NOT NULL`); } catch (_) { }

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
