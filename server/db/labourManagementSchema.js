// Labour Management System — schema (tables only; extracted from schema.js
// unchanged). Ten tables across the module's three sub-areas: quotations and
// rates, the labour roster and attendance, and the bill-verification chain.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only.
//
// Deliberately NOT moved here yet (still in schema.js, unchanged): the
// standalone ALTER TABLE column additions for labour_quotations /
// labour_master / proj_work_orders, the sqlite_master table-rebuild
// migrations for the pre-existing proj_* tables, and the permission keys in
// ALL_MODULES. Those run later in initializeDatabase() and depend on these
// tables already existing — which is why this module is invoked from the
// point in schema.js where its SQL used to sit, not from the tail.

function runLabourManagementMigrations(db) {
  db.exec(`
    -- ================================================================
    -- LABOUR MANAGEMENT SYSTEM (2026-08)
    --
    -- The LMS is the existing Indent Labour Payment pipeline, renamed and
    -- extended — NOT a second system. It already owns Projects, Work Orders,
    -- Muster Roll, Measurement Book and Contractor RA Bills across 12 proj_*
    -- tables. Only the genuinely missing pieces are added here:
    --
    --   labour_quotations    quotation + threshold rule -> approval -> WO
    --   labour_rate_master   HR-owned crew rates (the Labour Rate Window)
    --   labour_rate_history  append-only audit + version history
    --   proj_wo_labour       labour lines on a Work Order, rate SNAPSHOTTED
    --
    -- No duplicate Work Order, labour register or contractor-bill table is
    -- created; those already exist and are reused as-is.
    --
    -- Client / contractor / project references point at the modules that own
    -- that data (customers, sub_contractors, proj_projects, business_book)
    -- rather than copying it. Names are denormalised alongside the id purely
    -- so a historical quotation still reads correctly if a master row is
    -- later renamed or deactivated.
    -- ================================================================

    CREATE TABLE IF NOT EXISTS labour_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quotation_number TEXT UNIQUE,
      project_id INTEGER REFERENCES proj_projects(id) ON DELETE SET NULL,
      project_name TEXT,
      business_book_id INTEGER,          -- CRM lead / site, when quoted off one
      site_name TEXT,
      customer_id INTEGER,               -- customers(id) — CRM owns the master
      client_name TEXT,
      contractor_id INTEGER,             -- sub_contractors(id) — Procurement owns it
      contractor_name TEXT,
      labour_category TEXT,
      description TEXT,
      amount REAL NOT NULL DEFAULT 0 CHECK(amount >= 0),
      -- Snapshotted from settings at creation, so a later change to the
      -- company threshold never rewrites the rule an old quotation was
      -- judged under.
      threshold REAL DEFAULT 0,
      rule_no INTEGER,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK(status IN ('draft','below_threshold','waiting_approval','approved','rejected','wo_generated')),
      approved_by INTEGER, approved_by_name TEXT, approved_at DATETIME,
      rejected_by INTEGER, rejected_by_name TEXT, rejected_at DATETIME,
      reject_reason TEXT,
      work_order_id INTEGER REFERENCES proj_work_orders(id) ON DELETE SET NULL,
      remarks TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lq_status  ON labour_quotations(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lq_project ON labour_quotations(project_id);
    CREATE INDEX IF NOT EXISTS idx_lq_wo      ON labour_quotations(work_order_id);

    CREATE TABLE IF NOT EXISTS labour_rate_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labour_category TEXT NOT NULL,        -- Electrician / Helper / Supervisor
      labour_type TEXT,
      trade TEXT,
      department TEXT,
      skill_level TEXT,
      unit TEXT NOT NULL DEFAULT 'Day'
        CHECK(unit IN ('Day','Hour','Month')),
      standard_rate REAL NOT NULL DEFAULT 0 CHECK(standard_rate >= 0),
      overtime_rate REAL DEFAULT 0 CHECK(overtime_rate IS NULL OR overtime_rate >= 0),
      effective_from DATE NOT NULL,
      effective_to DATE,                    -- NULL = open-ended
      status TEXT NOT NULL DEFAULT 'active'
        CHECK(status IN ('active','inactive')),
      remarks TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER, updated_by_name TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- "Only one active rate per labour category and effective date." Enforced
    -- by a partial UNIQUE index rather than a route check, so a concurrent
    -- double-submit cannot slip a second active rate through. Scoped by trade
    -- and department too: an Electrician in Fire-Fighting and one in
    -- Electrical are legitimately different rates on the same date.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_lrm_active_effective
      ON labour_rate_master(labour_category, COALESCE(trade,''), COALESCE(department,''), effective_from)
      WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_lrm_status ON labour_rate_master(status, effective_from DESC);
    CREATE INDEX IF NOT EXISTS idx_lrm_cat    ON labour_rate_master(labour_category);
    CREATE INDEX IF NOT EXISTS idx_lrm_dept   ON labour_rate_master(department);
    CREATE INDEX IF NOT EXISTS idx_lrm_trade  ON labour_rate_master(trade);

    -- Append-only: every create / edit / status change writes one row, so
    -- "who changed this rate, from what, to what, and why" is always
    -- answerable. Never updated, never deleted.
    CREATE TABLE IF NOT EXISTS labour_rate_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rate_id INTEGER REFERENCES labour_rate_master(id) ON DELETE CASCADE,
      labour_category TEXT,
      action TEXT NOT NULL
        CHECK(action IN ('created','updated','activated','deactivated','deleted')),
      old_rate REAL, new_rate REAL,
      old_overtime_rate REAL, new_overtime_rate REAL,
      before_json TEXT, after_json TEXT,
      reason TEXT,
      changed_by INTEGER, changed_by_name TEXT,
      changed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lrh_rate    ON labour_rate_history(rate_id, changed_at DESC);
    CREATE INDEX IF NOT EXISTS idx_lrh_changed ON labour_rate_history(changed_at DESC);

    -- Labour lines on a Work Order.
    --
    -- Every rate field is a SNAPSHOT taken when the line was added, not a join
    -- to labour_rate_master. That is what makes "existing Work Orders retain
    -- the rates used at the time of creation" true: if HR raises the
    -- Electrician rate next month, a WO signed today still shows — and is
    -- still payable at — what it was signed at. rate_id is kept for
    -- traceability back to the master row, never for pricing.
    CREATE TABLE IF NOT EXISTS proj_wo_labour (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_order_id INTEGER NOT NULL REFERENCES proj_work_orders(id) ON DELETE CASCADE,
      rate_id INTEGER,                      -- provenance only
      labour_category TEXT NOT NULL,
      labour_type TEXT, trade TEXT, department TEXT, skill_level TEXT,
      unit TEXT DEFAULT 'Day',
      rate_snapshot REAL NOT NULL DEFAULT 0 CHECK(rate_snapshot >= 0),
      overtime_rate_snapshot REAL DEFAULT 0,
      rate_effective_from DATE,
      quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0),   -- number of labourers
      days REAL NOT NULL DEFAULT 1 CHECK(days > 0),
      overtime_hours REAL DEFAULT 0 CHECK(overtime_hours IS NULL OR overtime_hours >= 0),
      -- Stored rather than derived on read, so a WO total can never drift if
      -- the rounding rule changes. Recomputed server-side on every write.
      amount REAL NOT NULL DEFAULT 0,
      overtime_amount REAL DEFAULT 0,
      remarks TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pwol_wo   ON proj_wo_labour(work_order_id);
    CREATE INDEX IF NOT EXISTS idx_pwol_rate ON proj_wo_labour(rate_id);

    -- ================================================================
    -- Labour Management System — Module 3: Labour Master + attendance.
    --
    -- labour_master        one row per individual worker (ID/name/mobile/
    --                      Aadhaar/trade/daily wage) — the roster proj_muster_roll
    --                      never had (that table stores labour_name as free text).
    -- labour_attendance    per-worker per-day present/absent/half-day +
    --                      overtime hours. Wage register is a REPORT over
    --                      this + labour_master, not a separate table.
    -- labour_transfers     site-to-site move log, append-only.
    -- labour_daily_progress  one row per site per day — brief progress note
    --                      + headcount, distinct from the full DPR module.
    -- ================================================================
    CREATE TABLE IF NOT EXISTS labour_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labour_code TEXT UNIQUE,
      name TEXT NOT NULL,
      mobile TEXT,
      aadhaar_number TEXT,
      trade TEXT,
      department TEXT,
      daily_wage REAL NOT NULL DEFAULT 0 CHECK(daily_wage >= 0),
      site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')),
      remarks TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lm_site   ON labour_master(site_id);
    CREATE INDEX IF NOT EXISTS idx_lm_status ON labour_master(status);
    CREATE INDEX IF NOT EXISTS idx_lm_trade  ON labour_master(trade);

    CREATE TABLE IF NOT EXISTS labour_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labour_id INTEGER NOT NULL REFERENCES labour_master(id) ON DELETE CASCADE,
      site_id INTEGER REFERENCES sites(id),
      work_order_id INTEGER REFERENCES proj_work_orders(id),
      date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'present' CHECK(status IN ('present','absent','half_day')),
      overtime_hours REAL DEFAULT 0 CHECK(overtime_hours IS NULL OR overtime_hours >= 0),
      remarks TEXT,
      recorded_by INTEGER, recorded_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- One attendance row per worker per day — a re-submit edits it, never
    -- duplicates it, so the wage register can never double-count a day.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_la_labour_date ON labour_attendance(labour_id, date);
    CREATE INDEX IF NOT EXISTS idx_la_site_date ON labour_attendance(site_id, date);
    CREATE INDEX IF NOT EXISTS idx_la_date      ON labour_attendance(date);

    CREATE TABLE IF NOT EXISTS labour_transfers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      labour_id INTEGER NOT NULL REFERENCES labour_master(id) ON DELETE CASCADE,
      from_site_id INTEGER REFERENCES sites(id),
      to_site_id INTEGER NOT NULL REFERENCES sites(id),
      transfer_date DATE NOT NULL,
      reason TEXT,
      transferred_by INTEGER, transferred_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_lt_labour ON labour_transfers(labour_id, transfer_date DESC);

    CREATE TABLE IF NOT EXISTS labour_daily_progress (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER NOT NULL REFERENCES sites(id),
      work_order_id INTEGER REFERENCES proj_work_orders(id),
      date DATE NOT NULL,
      labourers_present INTEGER DEFAULT 0,
      progress_notes TEXT,
      progress_pct REAL CHECK(progress_pct IS NULL OR (progress_pct >= 0 AND progress_pct <= 100)),
      recorded_by INTEGER, recorded_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_ldp_site_date ON labour_daily_progress(site_id, date);

    -- ================================================================
    -- Labour Management System — Modules 4-6: Bill Verification chain,
    -- Bills & Finance, Payments.
    --
    -- These are ONE continuous pipeline over the EXISTING
    -- proj_contractor_ra_bills (raised/payment/paid) — not a parallel bill
    -- system. current_stage tracks progress through the 6-stage chain;
    -- the existing 3-state 'status' column still gates the coarse
    -- raised->payment->paid lifecycle other code already reads.
    --
    -- proj_bill_stage_log   append-only — one row per Verify/Reject/Send
    --                       Back action, at any stage. This is both the
    --                       audit trail and what "Bill submitted" /
    --                       "pending at X" notifications are built from.
    -- vendor_ledger         one row per bill (debit) or payment (credit)
    --                       per contractor — Module 6's ledger + the data
    --                       source for "Contractor payment history".
    -- ================================================================
    CREATE TABLE IF NOT EXISTS proj_bill_stage_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER NOT NULL REFERENCES proj_contractor_ra_bills(id) ON DELETE CASCADE,
      stage TEXT NOT NULL CHECK(stage IN
        ('site_engineer','site_head','project_manager','finance','accounts','payment')),
      action TEXT NOT NULL CHECK(action IN ('verified','rejected','sent_back')),
      photos_json TEXT,             -- array of uploaded photo URLs (site engineer stage)
      measurement_notes TEXT,
      quantity_verified REAL,
      remarks TEXT,
      acted_by INTEGER, acted_by_name TEXT,
      acted_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_pbsl_bill  ON proj_bill_stage_log(ra_bill_id, acted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_pbsl_stage ON proj_bill_stage_log(stage);

    CREATE TABLE IF NOT EXISTS vendor_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      contractor_id INTEGER REFERENCES sub_contractors(id),
      contractor_name TEXT,
      ra_bill_id INTEGER REFERENCES proj_contractor_ra_bills(id),
      entry_type TEXT NOT NULL CHECK(entry_type IN ('bill','payment')),
      amount REAL NOT NULL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      tds_amount REAL DEFAULT 0,
      payment_mode TEXT,            -- Bank Transfer / Cheque / UPI / Cash
      transaction_id TEXT,
      remarks TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vl_contractor ON vendor_ledger(contractor_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_vl_bill       ON vendor_ledger(ra_bill_id);
  `);
}

module.exports = { runLabourManagementMigrations };
