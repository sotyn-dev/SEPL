// Drawing Tracker — schema (tables only; extracted from schema.js unchanged).
//
// Two tables: 'drawings' is the document identity, 'drawing_revisions' is the
// permanent per-version history that is never updated in place.
//
// Idempotent: CREATE TABLE / CREATE INDEX IF NOT EXISTS only. No ALTERs.
// The 'drawing_tracker' permission key stays in schema.js's ALL_MODULES list.

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
    -- Project comes from EITHER existing master (they are unlinked in this
    -- schema): business_book (booked orders — sites.business_book_id points
    -- here, so the Site dropdown can cascade) or proj_projects (the thin
    -- name/owner list). project_source says which one project_id refers to.
    -- No new project or site master is created.
    -- ================================================================
    CREATE TABLE IF NOT EXISTS drawings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_source TEXT NOT NULL DEFAULT 'business_book'
        CHECK(project_source IN ('business_book','proj_project')),
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
}

module.exports = { runDrawingTrackerMigrations };
