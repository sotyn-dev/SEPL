// SYSTEM FLOW — the ERP Management system register.
//
// Mam (2026-09-08): "change it fully, 2,3 photo is steps and 4 is create system".
// The module is rebuilt to match her spreadsheet exactly:
//
//   CREATE SYSTEM (photo 4)
//     UID · Timestamp · System Name · Type · System Category · Frequency · HOD's Name
//
//   THE FOUR STEPS every system runs through (photos 2 and 3)
//     1  CREATE     Monika             G-form                          1 day
//     2  ALIGN      respective person  upload sign from every person   1 day
//     3  ROLL-OUT   automatic          manually                        0 days
//     4  ALIGNMENT  PC                 automatically                  30 days
//
//   Each step tracks Planned · Actual · Time Delay, plus its own extra column:
//     step 1 → upload proof + person's name
//     step 2 → upload proof
//     step 3 → PC name
//     step 4 → score of system
//
// Mam chose "replace everything" over keeping the old model, and chose that the
// number under each step is PLANNED DAYS. The planned date therefore chains:
// step 1 is planned one day after the system is created, and every later step is
// planned from the previous step's ACTUAL date (falling back to its planned date
// while it is still open), so a slipped step moves the ones behind it.
//
// The previous model's rows (sysflow_flows / step_master / activity) are ARCHIVED
// rather than dropped — see runSystemFlowMigrations. The tables themselves stay in
// place and empty, because seven auto:sysflow_* Scorecard KPI sources query them
// directly and a missing table would throw rather than report zero.

const STEP_TEMPLATE = [
  { step_no: 1, step_name: 'CREATE',    owner_label: 'MONIKA',            method: 'G-form',                        planned_days: 1,  extra: 'proof_person' },
  { step_no: 2, step_name: 'ALIGN',     owner_label: 'RESPECTIVE PERSON', method: 'UPLOAD SIGN FROM EVERY PERSON', planned_days: 1,  extra: 'proof' },
  { step_no: 3, step_name: 'ROLL-OUT',  owner_label: 'AUTOMATIC',         method: 'MANUALLY',                      planned_days: 0,  extra: 'pc_name' },
  { step_no: 4, step_name: 'ALIGNMENT', owner_label: 'PC',                method: 'Automatically',                 planned_days: 30, extra: 'score' },
];

function runSystemFlowMigrations(db) {
  db.exec(`
    -- ── the system register (photo 4) ──────────────────────────────
    CREATE TABLE IF NOT EXISTS sysflow_systems (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT NOT NULL UNIQUE,               -- SYS-0001, issued by the server
      system_name TEXT NOT NULL,
      type TEXT,
      system_category TEXT,
      frequency TEXT,
      hod_id INTEGER REFERENCES users(id),    -- HOD'S NAME, picked from users
      hod_name TEXT,                          -- kept as typed when not an ERP user
      remarks TEXT,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,   -- the sheet's Timestamp
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ── the four steps per system (photos 2 and 3) ─────────────────
    CREATE TABLE IF NOT EXISTS sysflow_system_steps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL REFERENCES sysflow_systems(id) ON DELETE CASCADE,
      step_no INTEGER NOT NULL,               -- 1..4
      step_name TEXT NOT NULL,
      owner_label TEXT,                       -- MONIKA / RESPECTIVE PERSON / AUTOMATIC / PC
      owner_id INTEGER REFERENCES users(id),  -- who actually holds it, when known
      method TEXT,                            -- G-form / upload sign / manually / automatically
      planned_days INTEGER NOT NULL DEFAULT 0,
      planned_date DATE,                      -- chained from the previous step
      actual_date DATE,
      -- Time Delay is DERIVED (actual - planned) and never stored: a stored copy
      -- goes stale the moment a planned date is recalculated.
      proof_url TEXT,                         -- steps 1 and 2: UPLOAD PROOF
      person_name TEXT,                       -- step 1: Persons Name
      pc_name TEXT,                           -- step 3: PC NAME
      system_score INTEGER,                   -- step 4: Score of system (0-100)
      remarks TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (system_id, step_no)
    );

    CREATE INDEX IF NOT EXISTS idx_sysflow_sys_created ON sysflow_systems(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_sysflow_sys_hod     ON sysflow_systems(hod_id);
    CREATE INDEX IF NOT EXISTS idx_sysflow_steps_sys   ON sysflow_system_steps(system_id, step_no);
    CREATE INDEX IF NOT EXISTS idx_sysflow_steps_plan  ON sysflow_system_steps(planned_date);
    CREATE INDEX IF NOT EXISTS idx_sysflow_steps_owner ON sysflow_system_steps(owner_id);

    -- Kept from the old model: one audit trail per change, now keyed to a system.
    CREATE TABLE IF NOT EXISTS sysflow_system_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      system_id INTEGER NOT NULL REFERENCES sysflow_systems(id) ON DELETE CASCADE,
      step_no INTEGER,
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sysflow_sysact ON sysflow_system_activity(system_id, created_at DESC);

    -- ── retired v1 tables, kept EMPTY on purpose ───────────────────
    -- server/routes/scoring.js queries these directly for seven auto:sysflow_*
    -- KPI sources (columns: status, developer_id, target_date,
    -- actual_completion_date, progress, and activity.flow_id/created_at). On a
    -- fresh database they would not exist at all and every one of those KPIs
    -- would throw instead of reporting zero, taking the Scorecard page with it.
    -- Recreated here with exactly the shape those queries need.
    CREATE TABLE IF NOT EXISTS sysflow_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_no TEXT,
      system_name TEXT,
      developer_id INTEGER REFERENCES users(id),
      responsible_id INTEGER REFERENCES users(id),
      target_date DATE,
      actual_completion_date DATE,
      progress INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'not_started',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS sysflow_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER,
      user_id INTEGER REFERENCES users(id),
      action TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ── the OLD model, retired ──────────────────────────────────────
  //
  // Mam picked "replace everything". The rows are moved into dated archive tables
  // instead of being dropped: the outcome she chose is identical (the module is
  // the new one and the old KPIs report zero) but a mistaken wipe of 119 real
  // assignments would otherwise be unrecoverable. The ORIGINAL tables are left in
  // place and empty on purpose — server/routes/scoring.js queries sysflow_flows
  // and sysflow_activity directly for seven auto:sysflow_* KPI sources, and a
  // missing table throws where an empty one correctly reports nothing.
  //
  // Guarded by a one-time flag so it can never run twice and archive an empty set
  // over a good archive.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='sysflow_v2_archived'").get();
    if (!done) {
      const has = (t) => !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t);
      let moved = 0;
      let failed = 0;
      // CHILD TABLES FIRST. sysflow_activity.flow_id references sysflow_flows(id)
      // and foreign_keys is ON, so deleting the parent first fails the whole
      // changeover with "FOREIGN KEY constraint failed" — which is exactly what
      // happened on the first run.
      for (const t of ['sysflow_activity', 'sysflow_flows', 'sysflow_step_master', 'sysflow_processes']) {
        if (!has(t)) continue;
        const n = db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c;
        if (!n) continue;
        try {
          // NEVER delete unless THIS run wrote the archive. CREATE TABLE IF NOT
          // EXISTS ... AS SELECT silently does nothing when the archive already
          // exists, while the DELETE below would still run — so a re-run (after
          // someone restores the v1 rows, or after the app_settings guard is lost
          // in a settings restore) would wipe the live rows and log them as
          // "archived". Reproduced on a copy of the live database.
          if (has(`${t}_archive_v1`)) {
            failed++;
            console.error(`[system-flow] ${t}_archive_v1 already exists — refusing to empty ${t} again (${n} row(s) left in place)`);
            continue;
          }
          db.exec(`CREATE TABLE ${t}_archive_v1 AS SELECT * FROM ${t}`);
          // Count what the archive ACTUALLY holds, not what we hoped to copy.
          const kept = db.prepare(`SELECT COUNT(*) c FROM ${t}_archive_v1`).get().c;
          if (kept !== n) {
            failed++;
            console.error(`[system-flow] ${t}: archive holds ${kept} of ${n} row(s) — not emptying`);
            continue;
          }
          db.exec(`DELETE FROM ${t}`);
          moved += kept;
          console.log(`[system-flow] archived ${kept} row(s) from ${t} -> ${t}_archive_v1`);
        } catch (inner) {
          // One stubborn table must not stop the others, and must not let the
          // one-time flag be set over an incomplete changeover.
          failed++;
          console.error(`[system-flow] could not retire ${t}: ${inner.message}`);
        }
      }
      // Arm the guard ONLY on a clean sweep, so a partial run is retried next boot
      // instead of leaving half the old model in place forever.
      if (!failed) {
        db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('sysflow_v2_archived', ?)")
          .run(String(moved));
        if (moved) console.log(`[system-flow] v2 changeover complete: ${moved} row(s) archived, old tables now empty`);
      }
    }
  } catch (e) {
    console.error('[system-flow] archive step failed (non-fatal):', e.message);
  }
}

module.exports = { runSystemFlowMigrations, STEP_TEMPLATE };
