// SOP-17: Final Account & Retention Schema
// Owner: Finance Head — Parul Goyal
//
// Lifecycle:
// S1: Final account made — booked value vs actual cost vs actual money received (Real profit finally visible)
// S2: Retention schedule made at handover, with due dates (Tracked money, not forgotten money)
// S3: Warranty period tracked; complaints closed before claiming retention (Site Engineer complaint log)
// S4: Retention due — claim raised on its own, into the same follow-up ladder as collection (ERP + Collection Engineer)
// S5: Project's actual rates and usage go back into the Rate Master — next quote gets sharper (ERP learning loop)

function runFinalAccountRetentionMigrations(db) {
  function addColumn(table, colName, colDef) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === colName)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
      }
    } catch (e) {
      console.warn(`[final-account-retention] addColumn ${table}.${colName} error:`, e.message);
    }
  }

  // 1. Ensure complaints has site_id and warranty flag if needed
  addColumn('complaints', 'site_id', 'INTEGER REFERENCES sites(id)');
  addColumn('complaints', 'is_warranty_complaint', 'INTEGER DEFAULT 0');
  addColumn('complaints', 'handover_cert_id', 'INTEGER REFERENCES handover_certificates(id)');

  // 2. Ensure handover_certificates tracks final_account_id
  addColumn('handover_certificates', 'final_account_id', 'INTEGER');

  // 3. Ensure sites tracks final_account_status
  addColumn('sites', 'final_account_status', "TEXT DEFAULT 'none'");

  // 4. Create final_accounts table (S1: Real profit & final ledger snapshot)
  db.exec(`
    CREATE TABLE IF NOT EXISTS final_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id),
      cert_id INTEGER REFERENCES handover_certificates(id),
      project_name TEXT,
      client_name TEXT,
      booked_contract_value REAL DEFAULT 0,
      invoiced_revenue REAL DEFAULT 0,
      received_amount REAL DEFAULT 0,
      material_cost REAL DEFAULT 0,
      labour_cost REAL DEFAULT 0,
      expense_cost REAL DEFAULT 0,
      total_actual_cost REAL DEFAULT 0,
      net_profit REAL DEFAULT 0,
      profit_margin_pct REAL DEFAULT 0,
      variance_amount REAL DEFAULT 0,
      variance_pct REAL DEFAULT 0,
      costs_locked INTEGER DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'finalized', 'audited')),
      finalized_by INTEGER REFERENCES users(id),
      finalized_by_name TEXT,
      finalized_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_fa_site ON final_accounts(site_id);
    CREATE INDEX IF NOT EXISTS idx_fa_status ON final_accounts(status);
  `);

  // 5. Create retention_claims table (S2 & S4: Retention schedule & claim tracking)
  db.exec(`
    CREATE TABLE IF NOT EXISTS retention_claims (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id),
      cert_id INTEGER REFERENCES handover_certificates(id),
      claim_number TEXT UNIQUE,
      retention_pct REAL DEFAULT 5.0,
      retention_amount REAL DEFAULT 0,
      due_date DATE,
      warranty_end_date DATE,
      open_complaints_count INTEGER DEFAULT 0,
      claim_status TEXT DEFAULT 'pending' CHECK(claim_status IN ('pending', 'due', 'claimed', 'collected')),
      receivable_id INTEGER REFERENCES receivables(id),
      payment_stage_id INTEGER REFERENCES project_payment_stages(id),
      claimed_by INTEGER REFERENCES users(id),
      claimed_by_name TEXT,
      claimed_at DATETIME,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_rc_site ON retention_claims(site_id);
    CREATE INDEX IF NOT EXISTS idx_rc_status ON retention_claims(claim_status);
  `);
}

module.exports = { runFinalAccountRetentionMigrations };
