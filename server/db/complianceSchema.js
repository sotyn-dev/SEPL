// Compliance Schema & Migrations
// SOTYN Mandatory Compliance Requirements

function initializeComplianceSchema(db) {
  // 1. Extend notifications table with mandatory task lifecycle columns
  const notificationColumns = [
    { name: 'is_mandatory', type: 'INTEGER DEFAULT 0' },
    { name: 'is_pending', type: 'INTEGER DEFAULT 0' },
    { name: 'task_type', type: 'TEXT' },
    { name: 'task_id', type: 'INTEGER' },
    { name: 'delivered_at', type: 'DATETIME' },
    { name: 'acknowledged_at', type: 'DATETIME' },
    { name: 'completed_at', type: 'DATETIME' },
    { name: 'closed_at', type: 'DATETIME' },
    { name: 'status', type: "TEXT DEFAULT 'active'" },
  ];

  for (const col of notificationColumns) {
    try {
      db.exec(`ALTER TABLE notifications ADD COLUMN ${col.name} ${col.type}`);
    } catch (_) {
      // column already exists
    }
  }

  // 2. Extend employees table with field employee & duty time columns
  const employeeColumns = [
    { name: 'is_field_employee', type: 'INTEGER DEFAULT 0' },
    { name: 'duty_start_time', type: "TEXT DEFAULT '09:00'" },
    { name: 'duty_end_time', type: "TEXT DEFAULT '18:30'" },
  ];

  for (const col of employeeColumns) {
    try {
      db.exec(`ALTER TABLE employees ADD COLUMN ${col.name} ${col.type}`);
    } catch (_) {
      // column already exists
    }
  }

  // 3. Create compliance_cases table
  db.exec(`
    CREATE TABLE IF NOT EXISTS compliance_cases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_number TEXT UNIQUE NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id),
      employee_name TEXT,
      violation_type TEXT NOT NULL CHECK(violation_type IN (
        'location_off',
        'location_unavailable',
        'mandatory_task_overdue',
        'task_notification_unresponsive',
        'geofence_breach'
      )),
      title TEXT NOT NULL,
      description TEXT,
      detected_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sla_deadline DATETIME,
      assigned_to INTEGER REFERENCES users(id),
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      alert_sent INTEGER DEFAULT 0,
      alert_sent_at DATETIME,
      employee_notified INTEGER DEFAULT 0,
      monitor_notified INTEGER DEFAULT 0,
      followup_status TEXT DEFAULT 'pending' CHECK(followup_status IN ('pending','contacted','in_progress','overdue')),
      followed_up_at DATETIME,
      followed_up_by INTEGER REFERENCES users(id),
      followup_notes TEXT,
      employee_response TEXT,
      employee_responded_at DATETIME,
      resolution_notes TEXT,
      resolved_at DATETIME,
      resolved_by INTEGER REFERENCES users(id),
      resolution_time_minutes INTEGER,
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','pending_employee','resolved','closed')),
      impacts_attendance INTEGER DEFAULT 1,
      impacts_expense INTEGER DEFAULT 1,
      attendance_flag_notes TEXT,
      expense_flag_notes TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 4. Create compliance_case_logs table
  db.exec(`
    CREATE TABLE IF NOT EXISTS compliance_case_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES compliance_cases(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      performed_by INTEGER REFERENCES users(id),
      performer_name TEXT,
      notes TEXT,
      metadata TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // 5. Indices for high performance queries
  const indices = [
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_user_status ON compliance_cases(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_violation ON compliance_cases(violation_type)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_detected ON compliance_cases(detected_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_assigned ON compliance_cases(assigned_to, status)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_number ON compliance_cases(case_number)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_cases_emp_name ON compliance_cases(employee_name)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_logs_case ON compliance_case_logs(case_id, created_at ASC)',
    'CREATE INDEX IF NOT EXISTS idx_notif_mandatory ON notifications(user_id, is_mandatory, is_pending, status)',
  ];

  for (const sql of indices) {
    try {
      db.exec(sql);
    } catch (_) {}
  }

  // 6. Ensure Compliance Monitor Role exists
  try {
    const monitorRole = db.prepare("SELECT id FROM roles WHERE name = 'Compliance Monitor'").get();
    let roleId;
    if (!monitorRole) {
      const res = db.prepare(`
        INSERT INTO roles (name, description, is_system)
        VALUES ('Compliance Monitor', 'Monitors mandatory task completion, location tracking compliance, and manages violation cases', 1)
      `).run();
      roleId = res.lastInsertRowid;
    } else {
      roleId = monitorRole.id;
    }

    // Set role permissions for compliance module
    const compliancePerm = db.prepare("SELECT id FROM role_permissions WHERE role_id = ? AND module = 'compliance'").get(roleId);
    if (!compliancePerm) {
      db.prepare(`
        INSERT INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve)
        VALUES (?, 'compliance', 1, 1, 1, 1, 1)
      `).run(roleId);
    }
  } catch (e) {
    console.warn('[compliance-schema] role initialization warning:', e.message);
  }
}

module.exports = { initializeComplianceSchema };
