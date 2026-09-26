// Drawing Tracker — schema (tables only; extracted from schema.js unchanged).
//
// Two tables: 'drawings' is the document identity, 'drawing_revisions' is the
// permanent per-version history that is never updated in place.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No ALTERs.
// The 'drawing_tracker' permission key stays in schema.js's ALL_MODULES list.

function migrateDrawingsSourceConstraint(db) {
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='drawings'").get();
    if (!row?.sql || row.sql.includes('sales_funnel')) return;
    db.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE drawings_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_source TEXT NOT NULL DEFAULT 'business_book'
          CHECK(project_source IN ('business_book','proj_project','sales_funnel','solar_deal')),
        project_id INTEGER,
        project_name TEXT,
        site_id INTEGER,
        site_name TEXT,
        drawing_number TEXT NOT NULL,
        title TEXT,
        discipline TEXT,
        drawing_type TEXT,
        current_revision_id INTEGER,
        remarks TEXT,
        created_by INTEGER, created_by_name TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO drawings_new SELECT * FROM drawings;
      DROP TABLE drawings;
      ALTER TABLE drawings_new RENAME TO drawings;
      CREATE UNIQUE INDEX IF NOT EXISTS uq_dwg_identity
        ON drawings(project_source, project_id, drawing_number);
      CREATE INDEX IF NOT EXISTS idx_dwg_site       ON drawings(site_id);
      CREATE INDEX IF NOT EXISTS idx_dwg_discipline ON drawings(discipline);
      CREATE INDEX IF NOT EXISTS idx_dwg_number     ON drawings(drawing_number);
      PRAGMA foreign_keys = ON;
    `);
  } catch (e) {
    console.warn('[drawing-tracker] migration warn:', e.message);
  }
}

function runDrawingTrackerMigrations(db) {
  db.exec(`
    -- ================================================================
    -- DRAWING TRACKER (2026-08)
    --
    -- Two tables, deliberately split:
    --   drawings           the document IDENTITY (one row per drawing number)
    --   drawing_revisions  one row per uploaded version, NEVER updated in place
    --
    -- The whole point of the module: uploading Rev 11 must leave Rev 10's row
    -- and file completely untouched and still downloadable. Nothing here ever
    -- overwrites or deletes a revision.
    --
    -- Project comes from EITHER existing master: business_book (booked orders),
    -- sales_funnel (qualified leads/pre-sales), solar_deals, or proj_projects.
    -- ================================================================
    CREATE TABLE IF NOT EXISTS drawings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_source TEXT NOT NULL DEFAULT 'business_book'
        CHECK(project_source IN ('business_book','proj_project','sales_funnel','solar_deal')),
      project_id INTEGER,
      -- Names denormalised alongside the id so a historical drawing still
      -- reads correctly if the master row is later renamed or deactivated.
      project_name TEXT,
      site_id INTEGER,
      site_name TEXT,
      drawing_number TEXT NOT NULL,
      title TEXT,
      discipline TEXT,
      drawing_type TEXT,
      current_revision_id INTEGER,      -- pointer to the live revision
      remarks TEXT,
      boq_required INTEGER DEFAULT 0,
      boq_file_url TEXT,
      boq_file_name TEXT,
      created_by INTEGER, created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Project + Drawing Number identifies the document (spec rule).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_dwg_identity
      ON drawings(project_source, project_id, drawing_number);
    CREATE INDEX IF NOT EXISTS idx_dwg_site       ON drawings(site_id);
    CREATE INDEX IF NOT EXISTS idx_dwg_discipline ON drawings(discipline);
    CREATE INDEX IF NOT EXISTS idx_dwg_number     ON drawings(drawing_number);

    CREATE TABLE IF NOT EXISTS drawing_revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      drawing_id INTEGER NOT NULL REFERENCES drawings(id) ON DELETE CASCADE,
      revision_no INTEGER NOT NULL,     -- 0,1,2…N — no maximum, never reused
      revision_date DATE,
      revision_description TEXT NOT NULL,
      revision_reason TEXT,
      status TEXT NOT NULL DEFAULT 'current'
        CHECK(status IN ('current','superseded','cancelled')),
      file_url TEXT NOT NULL,
      file_name TEXT, file_type TEXT, file_size INTEGER,
      uploaded_by INTEGER, uploaded_by_name TEXT,
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      -- Unused today (no approval step by design), but present so an approval
      -- workflow can be layered on later without a migration.
      approved_by INTEGER, approved_by_name TEXT, approved_at DATETIME,
      remarks TEXT,
      -- Makes a duplicate "Rev 5" impossible, and makes two simultaneous
      -- uploads safe: the loser hits this constraint and is retried with the
      -- next free number instead of silently overwriting.
      UNIQUE(drawing_id, revision_no)
    );
    -- Exactly ONE current revision per drawing, enforced by the database
    -- rather than by route code — SQLite ignores NULLs/non-matching rows in a
    -- partial unique index, so superseded rows are unconstrained while two
    -- Currents cannot exist even momentarily mid-transaction.
    CREATE UNIQUE INDEX IF NOT EXISTS uq_dr_current
      ON drawing_revisions(drawing_id) WHERE status = 'current';
    CREATE INDEX IF NOT EXISTS idx_dr_drawing ON drawing_revisions(drawing_id, revision_no DESC);
    CREATE INDEX IF NOT EXISTS idx_dr_uploaded ON drawing_revisions(uploaded_at DESC);
  `);
  migrateDrawingsSourceConstraint(db);

  // Idempotent column additions for BOQ support
  try { db.exec(`ALTER TABLE drawings ADD COLUMN boq_required INTEGER DEFAULT 0;`); } catch (_) {}
  try { db.exec(`ALTER TABLE drawings ADD COLUMN boq_file_url TEXT;`); } catch (_) {}
  try { db.exec(`ALTER TABLE drawings ADD COLUMN boq_file_name TEXT;`); } catch (_) {}

  // Idempotent column additions for SOP-06 Drawing Approval Workflow
  const drawingCols = [
    `target_date DATE`,
    `sop_stage TEXT DEFAULT 's1_register'`,
    `internal_review_status TEXT DEFAULT 'pending'`,
    `internal_reviewed_by INTEGER`,
    `internal_reviewed_by_name TEXT`,
    `internal_reviewed_at DATETIME`,
    `internal_review_notes TEXT`,
    `internal_checklist TEXT`,
    `client_submitted_at DATETIME`,
    `client_submitted_by INTEGER`,
    `client_submitted_by_name TEXT`,
    `client_expected_date DATE`,
    `submission_ref_no TEXT`,
    `submission_notes TEXT`,
    `reminder_50_sent_at DATETIME`,
    `reminder_80_sent_at DATETIME`,
    `reminder_escalation_status TEXT`,
    `site_release_status TEXT DEFAULT 'pending'`,
    `site_released_at DATETIME`,
    `site_released_by INTEGER`,
    `site_released_by_name TEXT`,
    `release_note_no TEXT`,
    `ready_checklist_ticked INTEGER DEFAULT 0`,
    `site_release_remarks TEXT`,
  ];
  for (const col of drawingCols) {
    try { db.exec(`ALTER TABLE drawings ADD COLUMN ${col};`); } catch (_) {}
  }

  const revCols = [
    `internal_review_status TEXT DEFAULT 'pending'`,
    `internal_reviewed_by INTEGER`,
    `internal_reviewed_by_name TEXT`,
    `internal_reviewed_at DATETIME`,
    `internal_checklist TEXT`,
    `internal_review_notes TEXT`,
    `client_submitted_at DATETIME`,
    `client_expected_date DATE`,
    `submission_ref_no TEXT`,
    `release_note_no TEXT`,
    `site_released_at DATETIME`,
  ];
  for (const col of revCols) {
    try { db.exec(`ALTER TABLE drawing_revisions ADD COLUMN ${col};`); } catch (_) {}
  }
}

module.exports = { runDrawingTrackerMigrations };
