// SYSTEM FLOW & ERP IMPLEMENTATION CONTROL — SQLite schema (idempotent).
// Mam (2026-09-01): manage the ERP build itself — planning → assigning →
// development → testing → completion, with automatic bottleneck detection.
//
// Tables:
//   sysflow_processes    — process master (SALES, PURCHASE, ACCOUNTS, …)
//   sysflow_step_master  — System Step dropdown source (admin-managed,
//                          deactivate hides from NEW records only)
//   sysflow_flows        — the flow steps themselves (one row = one step
//                          of one system build). depends_on_id is the
//                          dependency chain; "next step" is derived.
//   sysflow_activity     — immutable audit trail (insert-only; no UPDATE/
//                          DELETE endpoints exist for it)
//
// Bottleneck/severity/escalation are COMPUTED at read time from status +
// dates + the dependency graph — nothing to keep in sync, no cron needed.

function runSystemFlowMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sysflow_processes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sysflow_step_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sysflow_flows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_no TEXT NOT NULL UNIQUE,
      process_id INTEGER NOT NULL REFERENCES sysflow_processes(id),
      system_name TEXT NOT NULL,
      step_id INTEGER NOT NULL REFERENCES sysflow_step_master(id),
      seq INTEGER NOT NULL DEFAULT 1,
      depends_on_id INTEGER REFERENCES sysflow_flows(id),
      responsible_id INTEGER NOT NULL REFERENCES users(id),
      developer_id INTEGER NOT NULL REFERENCES users(id),
      start_date DATE NOT NULL,
      target_date DATE NOT NULL,
      actual_completion_date DATE,
      priority TEXT NOT NULL DEFAULT 'medium'
        CHECK(priority IN ('low','medium','high','critical')),
      status TEXT NOT NULL DEFAULT 'not_started'
        CHECK(status IN ('not_started','in_progress','testing','waiting','blocked','completed','cancelled')),
      progress INTEGER NOT NULL DEFAULT 0,
      blocked_reason TEXT,
      blocked_since DATETIME,
      required_action TEXT,
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_status     ON sysflow_flows(status);
    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_resp       ON sysflow_flows(responsible_id);
    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_dev        ON sysflow_flows(developer_id);
    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_target     ON sysflow_flows(target_date);
    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_process    ON sysflow_flows(process_id);
    CREATE INDEX IF NOT EXISTS idx_sysflow_flows_depends    ON sysflow_flows(depends_on_id);

    CREATE TABLE IF NOT EXISTS sysflow_activity (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flow_id INTEGER NOT NULL REFERENCES sysflow_flows(id),
      user_id INTEGER REFERENCES users(id),
      action TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sysflow_activity_flow ON sysflow_activity(flow_id);
  `);

  // Seed the step master + processes once (empty tables only) so the
  // dropdowns are usable on first open. Admin can edit/deactivate later.
  const stepCount = db.prepare('SELECT COUNT(*) c FROM sysflow_step_master').get().c;
  if (stepCount === 0) {
    const ins = db.prepare('INSERT INTO sysflow_step_master (name) VALUES (?)');
    for (const s of [
      'Login & User Management','User Master','Customer Master','Vendor Master',
      'Sales Order','Indent','Purchase Order','Purchase Bill','Material Receipt',
      'Inventory','Stock Transfer','DPR','Billing','Payment','HR','Attendance',
      'Project Management','Dashboard','Reports',
    ]) ins.run(s);
  }
  const procCount = db.prepare('SELECT COUNT(*) c FROM sysflow_processes').get().c;
  if (procCount === 0) {
    const ins = db.prepare('INSERT INTO sysflow_processes (name, sort_order) VALUES (?,?)');
    [['SALES',1],['PURCHASE',2],['INVENTORY',3],['PROJECT',4],['ACCOUNTS',5],['HR',6],['ADMIN',7]]
      .forEach(([n,o]) => ins.run(n,o));
  }

  // erp_path (mam 2026-09-01): link each step type to the ACTUAL ERP module
  // page, so Update Status can jump to the real thing and show its pending
  // count. Guarded ALTER — idempotent.
  const smCols = db.pragma('table_info(sysflow_step_master)').map(c => c.name);
  if (!smCols.includes('erp_path')) {
    db.exec('ALTER TABLE sysflow_step_master ADD COLUMN erp_path TEXT');
  }
  const ERP_PATHS = {
    'Login & User Management': '/admin/users', 'User Master': '/admin/users',
    'Customer Master': '/customers', 'Vendor Master': '/vendors',
    'Sales Order': '/business-book', 'Indent': '/procurement',
    'Purchase Order': '/procurement', 'Purchase Bill': '/tally-bills',
    'Material Receipt': '/procurement', 'Inventory': '/inventory',
    'Stock Transfer': '/inventory', 'DPR': '/dpr', 'Billing': '/billing',
    'Payment': '/payment-required', 'HR': '/hr', 'Attendance': '/attendance',
    'Project Management': '/pms-tasks', 'Dashboard': '/', 'Reports': '/',
  };
  const setPath = db.prepare('UPDATE sysflow_step_master SET erp_path=? WHERE name=? AND erp_path IS NULL');
  for (const [name, path] of Object.entries(ERP_PATHS)) setPath.run(path, name);

  // Configurable escalation thresholds (days overdue/blocked) — app_settings.
  const getSetting = db.prepare('SELECT value FROM app_settings WHERE key = ?');
  const setSetting = db.prepare('INSERT OR IGNORE INTO app_settings (key, value) VALUES (?,?)');
  if (!getSetting.get('sysflow_esc_l1_days')) setSetting.run('sysflow_esc_l1_days', '1');
  if (!getSetting.get('sysflow_esc_l2_days')) setSetting.run('sysflow_esc_l2_days', '3');
  if (!getSetting.get('sysflow_esc_l3_days')) setSetting.run('sysflow_esc_l3_days', '7');
}

module.exports = { runSystemFlowMigrations };
