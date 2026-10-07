// SOP-15: Handover & Snags Schema
// Owner: Project Manager — Adarsh Kumar
//
// Lifecycle:
// S1: Work 100% → Handover starts on its own; no new cost booking allowed (Costs locked).
// S2: Snag walk WITH the client. Every snag noted separately — name, date, photo.
// S3: Every snag is a task with a clock. Late → PM, then Head.
// S4: Snag closed with photo; client ticks each one himself (Lovely / CRM).
// S5: All snags closed → Handover certificate is automatically made and sent for sign.
// S6: Signed handover starts the final bill, retention schedule, and warranty period.

function runHandoverSnagsMigrations(db) {
  // 1. Helper to add columns idempotently
  function addColumn(table, colName, colDef) {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all();
      if (!cols.some(c => c.name === colName)) {
        db.exec(`ALTER TABLE ${table} ADD COLUMN ${colName} ${colDef}`);
      }
    } catch (e) {
      console.warn(`[handover-snags] addColumn ${table}.${colName} error:`, e.message);
    }
  }

  // 2. Extend sites table with SOP-15 fields
  addColumn('sites', 'handover_stage', "TEXT DEFAULT 's0_in_progress'");
  addColumn('sites', 'work_completed_100', 'INTEGER DEFAULT 0');
  addColumn('sites', 'work_completed_at', 'DATETIME');
  addColumn('sites', 'cost_locked', 'INTEGER DEFAULT 0');
  addColumn('sites', 'cost_locked_at', 'DATETIME');
  addColumn('sites', 'cost_locked_by', 'INTEGER REFERENCES users(id)');
  addColumn('sites', 'client_walk_date', 'DATE');
  addColumn('sites', 'client_rep_name', 'TEXT');
  addColumn('sites', 'client_rep_phone', 'TEXT');
  addColumn('sites', 'handover_cert_id', 'INTEGER');

  // 3. Extend snags table with SOP-15 fields
  addColumn('snags', 'is_client_walk', 'INTEGER DEFAULT 0');
  addColumn('snags', 'walk_date', 'DATE');
  addColumn('snags', 'client_verified', 'INTEGER DEFAULT 0');
  addColumn('snags', 'client_verified_at', 'DATETIME');
  addColumn('snags', 'client_verified_by', 'INTEGER REFERENCES users(id)');
  addColumn('snags', 'client_verified_by_name', 'TEXT');
  addColumn('snags', 'escalation_level', 'INTEGER DEFAULT 0');
  addColumn('snags', 'escalated_pm_at', 'DATETIME');
  addColumn('snags', 'escalated_head_at', 'DATETIME');

  // 4. Ensure handover_certificates table has all necessary fields
  addColumn('handover_certificates', 'site_id', 'INTEGER REFERENCES sites(id)');
  addColumn('handover_certificates', 'project_name', 'TEXT');
  addColumn('handover_certificates', 'client_name', 'TEXT');
  addColumn('handover_certificates', 'snags_total', 'INTEGER DEFAULT 0');
  addColumn('handover_certificates', 'snags_closed', 'INTEGER DEFAULT 0');
  addColumn('handover_certificates', 'retention_pct', 'REAL DEFAULT 5.0');
  addColumn('handover_certificates', 'retention_amount', 'REAL DEFAULT 0');
  addColumn('handover_certificates', 'retention_due_date', 'DATE');
  addColumn('handover_certificates', 'retention_status', "TEXT DEFAULT 'pending'");
  addColumn('handover_certificates', 'warranty_start_date', 'DATE');
  addColumn('handover_certificates', 'warranty_end_date', 'DATE');
  addColumn('handover_certificates', 'warranty_months', 'INTEGER DEFAULT 12');
  addColumn('handover_certificates', 'signed_date', 'DATE');
  addColumn('handover_certificates', 'signed_file_url', 'TEXT');
  addColumn('handover_certificates', 'generated_by', 'INTEGER REFERENCES users(id)');
  addColumn('handover_certificates', 'generated_by_name', 'TEXT');
  addColumn('handover_certificates', 'final_bill_triggered', 'INTEGER DEFAULT 0');
  addColumn('handover_certificates', 'final_bill_triggered_at', 'DATETIME');

  // 5. Ensure indices
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sites_cost_locked ON sites(cost_locked);
      CREATE INDEX IF NOT EXISTS idx_sites_handover_stage ON sites(handover_stage);
      CREATE INDEX IF NOT EXISTS idx_snags_client_walk ON snags(site_id, is_client_walk);
      CREATE INDEX IF NOT EXISTS idx_handover_cert_site ON handover_certificates(site_id);
    `);
  } catch (e) {
    console.warn('[handover-snags] index creation warning:', e.message);
  }
}

module.exports = { runHandoverSnagsMigrations };
