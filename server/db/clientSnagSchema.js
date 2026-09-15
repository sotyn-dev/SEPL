// Client Snag — schema (tables only; extracted from schema.js unchanged).
//
// Three tables: the snag record, its per-record timeline, and the
// admin-editable identity gate (uploader / approver) that this module uses
// instead of a role-permission approver.
//
// Idempotent: CREATE TABLE IF NOT EXISTS only — safe to re-run every boot.
// The 'client_snag' permission key stays in schema.js's ALL_MODULES list,
// and client_snags.before_photo_url stays in schema.js's migrations array.

function runClientSnagMigrations(db) {
  db.exec(`
    -- Client Snag — a client-facing snag (e.g. a bill that came back
    -- without the client's signature). Same raise/assign/photo/approve
    -- shape as the 'snags' table above, plus a client_name field, but with
    -- two IDENTITY-gated actions instead of a role-permission-gated
    -- approver: Ajmer uploads the snag photo; Lovely Sharma approves or
    -- rejects it (see client_snag_gate_users below).
    --
    -- Status flow:
    --   awaiting_document → Ajmer hasn't uploaded the snag photo yet
    --   pending_approval   → Ajmer submitted; awaiting Lovely Sharma
    --   approved            → Lovely Sharma accepted — locked
    --   rejected            → Lovely Sharma rejected with a reason;
    --                         Ajmer re-uploads and resubmits (back to
    --                         awaiting_document, not a dead end)
    CREATE TABLE IF NOT EXISTS client_snags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snag_no TEXT UNIQUE,                        -- CS-YYYY-####
      client_name TEXT,
      assigned_to INTEGER REFERENCES users(id),
      assigned_to_name TEXT,                      -- snapshot
      site_name TEXT,
      location TEXT,                               -- e.g. "2nd floor accounts desk"
      description TEXT NOT NULL,
      photo_url TEXT,                              -- the Snag Photo — Ajmer-only upload
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT DEFAULT 'awaiting_document'
        CHECK(status IN ('awaiting_document','pending_approval','approved','rejected')),
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME,
      submitted_at DATETIME,
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at DATETIME,
      rejection_reason TEXT,
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-record timeline for a Client Snag (separate from the global
    -- audit_log so the detail page can render a cheap in-page history
    -- without querying a much larger shared table).
    CREATE TABLE IF NOT EXISTS client_snag_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_snag_id INTEGER NOT NULL REFERENCES client_snags(id) ON DELETE CASCADE,
      action TEXT NOT NULL,          -- CREATED / DOCUMENT_UPLOADED / SUBMITTED / APPROVED / REJECTED / RESUBMITTED
      user_id INTEGER REFERENCES users(id),
      from_status TEXT,
      to_status TEXT,
      note TEXT,                     -- rejection reason, etc.
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Admin-editable gate: exactly one user may act as 'uploader' (Ajmer)
    -- and one as 'approver' (Lovely Sharma). Deliberately NO auto-seed row
    -- here — same reasoning as indent_to_dispatch_setting_users: the
    -- resolver (server/routes/clientSnag.js) falls back to a name lookup
    -- ('Ajmer' / 'Lovely Sharma') when a role has no row here, so nothing
    -- breaks before an admin visits Client Snag's Reassign control and
    -- sets the real row via PUT /client-snag/settings/gate — which then
    -- takes priority over the name fallback, with no redeploy needed.
    CREATE TABLE IF NOT EXISTS client_snag_gate_users (
      role_key TEXT PRIMARY KEY CHECK(role_key IN ('uploader','approver')),
      user_id INTEGER NOT NULL REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );
  `);

  // Site Readiness FMS migrations — adds civil scope tracking columns idempotently
  function addCol(colName, colDef) {
    const cols = db.prepare(`PRAGMA table_info(client_snags)`).all();
    if (!cols.some(c => c.name === colName)) {
      db.exec(`ALTER TABLE client_snags ADD COLUMN ${colName} ${colDef}`);
    }
  }

  addCol('snag_type', "TEXT DEFAULT 'site_readiness'");
  addCol('scope_category', 'TEXT');
  addCol('floor_zone', 'TEXT');
  addCol('site_id', 'INTEGER');
  addCol('before_photo_url', 'TEXT');
  addCol('client_promised_date', 'DATE');
  addCol('fms_stage', "TEXT DEFAULT 'reported'");
  addCol('cleared_at', 'DATETIME');
  addCol('cleared_by', 'INTEGER');
  addCol('cleared_photo_url', 'TEXT');
  addCol('client_contact_person', 'TEXT');
  addCol('client_contact_phone', 'TEXT');
  addCol('intimation_notes', 'TEXT');

  // Any legacy rows created before this migration default to billing_doc
  db.exec(`UPDATE client_snags SET snag_type = 'billing_doc' WHERE snag_type IS NULL`);
}

module.exports = { runClientSnagMigrations };
