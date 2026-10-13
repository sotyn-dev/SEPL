// SOP-16 Collection Engine Schema
// Owner: Collection Engineer
// Steps:
//   S1: Payment Stages on Day 1 (Advance, Material, Testing, Handover, Retention)
//   S2: Auto-Demand on Event Completion
//   S3: Live Ageing Screen (0-30, 31-60, 61-90, 90+)
//   S4: Fixed Escalation Ladder (Collection Eng -> PM Adarsh -> Head Nitin -> MD Ankur)
//   S5: 60-Day Material Supply Stop (with Head Exception Override)
//   S6: Auto Bank Match & Thank-You Receipt

function runCollectionEngineMigrations(db) {
  // 1. Contract / Project Payment Milestones (S1 & S2)
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_payment_stages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER,
      business_book_id INTEGER,
      project_name TEXT,
      client_name TEXT,
      stage_key TEXT NOT NULL CHECK(stage_key IN ('advance', 'material', 'testing', 'handover', 'retention', 'custom')),
      stage_name TEXT NOT NULL,
      stage_percentage REAL DEFAULT 0,
      stage_amount REAL DEFAULT 0,
      trigger_event TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'demanded', 'paid')),
      demanded_receivable_id INTEGER REFERENCES receivables(id),
      demanded_at DATETIME,
      due_date DATE,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pps_site ON project_payment_stages(site_id);
    CREATE INDEX IF NOT EXISTS idx_pps_status ON project_payment_stages(status);
  `);

  // 2. 60-Day Overdue Material Supply Blocks & Overrides (S5)
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_material_blocks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER UNIQUE,
      site_name TEXT,
      client_name TEXT,
      is_blocked INTEGER DEFAULT 0,
      blocked_reason TEXT,
      blocked_at DATETIME,
      oldest_overdue_days INTEGER DEFAULT 0,
      overdue_amount REAL DEFAULT 0,
      has_override INTEGER DEFAULT 0,
      overridden_by INTEGER REFERENCES users(id),
      overridden_by_name TEXT,
      override_reason TEXT,
      overridden_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_smb_site ON site_material_blocks(site_id);
  `);

  // 3. Thank-You Payment Receipts (S6)
  db.exec(`
    CREATE TABLE IF NOT EXISTS collection_receipts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receipt_no TEXT UNIQUE NOT NULL,
      collection_id INTEGER REFERENCES collections(id),
      receivable_id INTEGER REFERENCES receivables(id),
      receipt_date DATE NOT NULL,
      client_name TEXT NOT NULL,
      project_name TEXT,
      site_name TEXT,
      amount_received REAL NOT NULL DEFAULT 0,
      tds_deducted REAL DEFAULT 0,
      total_credit REAL NOT NULL DEFAULT 0,
      outstanding_balance REAL DEFAULT 0,
      payment_mode TEXT,
      transaction_ref TEXT,
      bank_name TEXT,
      company_signatory TEXT DEFAULT 'Accounts & Finance',
      notes TEXT,
      sent_to_client INTEGER DEFAULT 0,
      sent_at DATETIME,
      generated_by INTEGER REFERENCES users(id),
      generated_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_cr_rec ON collection_receipts(receivable_id);
    CREATE INDEX IF NOT EXISTS idx_cr_col ON collection_receipts(collection_id);
  `);

  // 4. Ensure site columns exist for quick checks
  try { db.exec(`ALTER TABLE sites ADD COLUMN material_supply_blocked INTEGER DEFAULT 0`); } catch (_) {}
  try { db.exec(`ALTER TABLE sites ADD COLUMN material_override_reason TEXT`); } catch (_) {}
  try { db.exec(`ALTER TABLE sites ADD COLUMN material_overridden_by INTEGER`); } catch (_) {}

  // 5. Ensure receivables columns exist for SOP-16 stage linking
  try { db.exec(`ALTER TABLE receivables ADD COLUMN payment_stage_id INTEGER REFERENCES project_payment_stages(id)`); } catch (_) {}
  try { db.exec(`ALTER TABLE receivables ADD COLUMN escalation_stage TEXT DEFAULT 'L1_COLLECTION_ENG'`); } catch (_) {}
  try { db.exec(`ALTER TABLE receivables ADD COLUMN escalation_assigned_name TEXT`); } catch (_) {}
}

module.exports = { runCollectionEngineMigrations };
