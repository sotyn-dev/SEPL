// Personnel Administration — the employee master record and its audit trail.
// References Organizational Management (orgSchema.js) by FK — department_id/
// designation_id on employee_timeline point there — but does not own it: a
// department or designation can exist with zero employees in it. Same OM/PA
// split most enterprise HRIS suites (SAP, Workday) keep as separate modules.
//
// MUST run AFTER orgSchema.js's runOrgStructureMigrations(db) — see above.
//
// Extracted from schema.js (was inline; plan: keep-confirmation-status-
// separate-elegant-beacon) — moved verbatim, same execution order, same
// non-fatal try/catch idiom the rest of schema.js already uses for
// self-contained modules (see fireNocSchema.js / rentalToolsSchema.js).
//
// The base `employees` CREATE TABLE itself stays inline in schema.js — 14
// stable lines, untouched since initial release, not part of the churn this
// split exists to tame.

// Mandatory Field Spec — HR pack (management spec, 2026-08-03). 17 new
// employees columns, added via their own small guarded loop (same idiom as
// schema.js's shared `migrations` array, just scoped to this module instead
// of interleaved with ~300 unrelated entries for other modules).
//
// Career-event fields (reports_to_employee_id, employment_type, grade,
// probation_end_date, confirmation_status, notice_period_days) are TRACKED in
// server/lib/employeeFields.js — a change opens a reason-required
// employee_timeline row, same mechanism as salary/status/designation.
// Demographic fields save silently.
//
// Deliberately NO DB-level defaults on the enum-ish columns below: ALTER
// TABLE ADD COLUMN ... DEFAULT stamps that value onto every EXISTING row
// immediately, which would fabricate employment_type='Permanent' /
// confirmation_status='Probation' on employees who may be long terminated.
// NULL here is correct — it feeds the profile-completeness signal honestly.
// 'Permanent'/'Probation' is a FORM default for NEW hires only
// (client/src/pages/Employees.jsx openCreate), not a schema default.
//
// reports_to_employee_id is a soft ref (no FK) — matches the house convention
// already used for org_openings.reports_to_employee_id and
// employee_timeline.manager_id (see orgSchema.js's FK-policy note):
// "reports-to"/"manager" fields are display-only, validated in the route
// layer (self-reference, cycles, orphaned-reports-on-deactivate).
const EMPLOYEE_COLUMNS = [
  'reports_to_employee_id INTEGER',
  'employment_type TEXT',
  'grade TEXT',
  'probation_end_date DATE',
  'confirmation_status TEXT',
  'notice_period_days INTEGER',
  'date_of_birth DATE',
  'gender TEXT',
  'father_spouse_name TEXT',
  'permanent_address TEXT',
  'permanent_pincode TEXT',
  'current_address TEXT',
  'current_pincode TEXT',
  'emergency_contact_name TEXT',
  'emergency_contact_phone TEXT',
  'blood_group TEXT',
  'photo_url TEXT',
];

function runHrMigrations(db) {
  for (const col of EMPLOYEE_COLUMNS) {
    try { db.exec(`ALTER TABLE employees ADD COLUMN ${col}`); } catch (e) {}
  }

  // reports_to_employee_id: the derived "does this employee have active
  // direct reports" query and the deactivation guard (block setting a
  // manager inactive while people report to them) both hit this on every save.
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_employees_reports_to ON employees(reports_to_employee_id)');
  } catch (e) { console.error('[schema] idx_employees_reports_to failed:', e.message); }

  try {
    db.exec(`
      -- Effective-dated employee history spine (HRIS EFFDT/EFFSEQ pattern).
      -- Wired for dept/designation/manager now; salary/roster/ot/status columns
      -- are provisioned + snapshotted so later modules link with no schema change.
      -- employee_id is NULLABLE with ON DELETE SET NULL (NOT the RESTRICT that a
      -- bare "NOT NULL REFERENCES" gives under foreign_keys=ON): once the change
      -- ledger has rows, a hard employee delete must NOT be blocked — the link
      -- nulls out and the row survives under the denormalized employee_name so the
      -- audit trail outlives the record. (Existing DBs are reshaped to this below.)
      CREATE TABLE IF NOT EXISTS employee_timeline (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
        employee_name  TEXT,                  -- denormalized name snapshot (survives delete)
        phone          TEXT,                  -- mirrors employees.phone (tracked: contact-info edits need a reason)
        email          TEXT,                  -- mirrors employees.email
        linked_user_label TEXT,               -- denormalized "Name (username/email)" snapshot of the linked login, or NULL
        department_id  INTEGER REFERENCES org_departments(id),
        designation_id INTEGER REFERENCES org_designations(id),
        department     TEXT,                  -- free-text dept snapshot now (department_id fills when org resumes)
        designation    TEXT,                  -- free-text title snapshot now
        manager_id     INTEGER,               -- snapshot of users.manager_id (live source stays users; no FK)
        salary         REAL,                  -- mirrors employees.salary (read-gate with employee_salary.can_view)
        salary_exempt  INTEGER,               -- mirrors employees.salary_exempt
        roster         TEXT,                  -- mirrors employees.roster
        ot_eligible    INTEGER,               -- mirrors employees.ot_eligible
        status         TEXT,                  -- mirrors employees.status
        join_date      TEXT,                  -- mirrors employees.join_date (tracked: corrections need a reason)
        salary_effective_from TEXT,           -- salary's OWN effective date, isolated from effective_from's noise
        status_effective_from TEXT,           -- status's OWN effective date, isolated likewise
        salary_action  TEXT,                  -- 'revision' | 'correction' — set only when salary changed
        salary_reason_code TEXT,              -- one of SALARY_REASON_CODES — set only when salary_action='revision'
        effective_from TEXT NOT NULL,         -- date this state became true (date-level, YYYY-MM-DD)
        effective_seq  INTEGER DEFAULT 0,     -- EFFSEQ: tiebreaker for >1 change the same day
        effective_to   TEXT,                  -- NULL = the current open row
        action_code    TEXT,                  -- Hired | Promotion | Pay Revision | ... | Other
        reason_code    TEXT,                  -- optional coded turnover reason (inactive/terminated)
        reason         TEXT,
        source         TEXT,                  -- hr | payroll | roster | backfill | manual
        changed_by     INTEGER,               -- acting user (soft ref, no FK)
        changed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      -- Exactly ONE open row per employee — an invariant the employees table lacks.
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_emp_timeline_open
        ON employee_timeline(employee_id) WHERE effective_to IS NULL;
      -- As-of range lookups.
      CREATE INDEX IF NOT EXISTS idx_emp_timeline_asof
        ON employee_timeline(employee_id, effective_from, effective_seq);
      -- Current headcount rollups by dept / title (only the open rows).
      CREATE INDEX IF NOT EXISTS idx_emp_timeline_dept_open
        ON employee_timeline(department_id) WHERE effective_to IS NULL;
      CREATE INDEX IF NOT EXISTS idx_emp_timeline_desig_open
        ON employee_timeline(designation_id) WHERE effective_to IS NULL;
    `);
    // One nullable string column on employees — optional finer sub-title label
    // (e.g. "ASM · Region 2"). Idempotent guarded ALTER (house pattern).
    try { db.exec(`ALTER TABLE employees ADD COLUMN role_subtitle TEXT`); } catch (_) { /* already exists */ }
  } catch (e) { console.error('[schema] org_structure tables create failed:', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  // Employee Change-History activation (plan: magical-wibbling-orbit).
  // Reshape the (empty) employee_timeline shipped above to its final ledger shape:
  //   1. add the change-ledger columns (employee_name/department/designation/
  //      action_code/reason_code) if an OLD-shape table already exists;
  //   2. rebuild the table when employee_id is still the RESTRICT-y
  //      "NOT NULL REFERENCES employees(id)" — flip it to nullable + ON DELETE SET
  //      NULL so a hard employee delete never breaks (history survives orphaned).
  // Idempotent: CREATE-IF-NOT-EXISTS already emits the final shape on fresh DBs, so
  // this only fires on DBs carrying the earlier org-structure table. Preserves any
  // rows via a copy, so it is safe even after a backfill.
  try {
    const etCols = db.prepare(`PRAGMA table_info(employee_timeline)`).all().map(c => c.name);
    const addCol = (name, decl) => {
      if (!etCols.includes(name)) { try { db.exec(`ALTER TABLE employee_timeline ADD COLUMN ${decl}`); } catch (_) {} }
    };
    addCol('employee_name', 'employee_name TEXT');
    addCol('department',    'department TEXT');
    addCol('designation',   'designation TEXT');
    addCol('action_code',   'action_code TEXT');
    addCol('reason_code',   'reason_code TEXT');
    addCol('join_date',     'join_date TEXT');
    addCol('phone',             'phone TEXT');
    addCol('email',             'email TEXT');
    addCol('linked_user_label', 'linked_user_label TEXT');
    addCol('salary_effective_from', 'salary_effective_from TEXT');
    addCol('status_effective_from', 'status_effective_from TEXT');
    addCol('salary_action',         'salary_action TEXT');
    addCol('salary_reason_code',    'salary_reason_code TEXT');
    // Mandatory Field Spec — HR pack career-event snapshot columns. All 6
    // tracked career fields get one here EXCEPT reports_to_employee_id, which
    // snapshots onto the existing manager_id column instead (see below) — plus
    // manager_label, denormalized the same way linked_user_label is, so
    // history reads correctly after a manager is renamed or removed.
    // confirmation_status gets its OWN isolated effective date (like salary
    // and status): the shared effective_date is capped at today (hr.js), and
    // probation confirmations are routinely dated forward ("confirmed w.e.f.
    // the 1st") — the shared date cannot express that.
    addCol('employment_type',             'employment_type TEXT');
    addCol('grade',                       'grade TEXT');
    addCol('probation_end_date',          'probation_end_date TEXT');
    addCol('confirmation_status',         'confirmation_status TEXT');
    addCol('confirmation_effective_from', 'confirmation_effective_from TEXT');
    addCol('notice_period_days',          'notice_period_days INTEGER');
    addCol('manager_label',               'manager_label TEXT');

    // Does employee_id still block deletes? PRAGMA foreign_key_list → on_delete.
    const fks = db.prepare(`PRAGMA foreign_key_list(employee_timeline)`).all();
    const empFk = fks.find(f => f.from === 'employee_id');
    const needsReshape = !empFk || String(empFk.on_delete).toUpperCase() !== 'SET NULL';
    if (needsReshape) {
      db.pragma('foreign_keys = OFF');
      const cols = `id, employee_id, employee_name, phone, email, linked_user_label, department_id, designation_id, department,
        designation, manager_id, salary, salary_exempt, roster, ot_eligible, status, join_date,
        salary_effective_from, status_effective_from, salary_action, salary_reason_code,
        effective_from, effective_seq, effective_to, action_code, reason_code, reason,
        source, changed_by, changed_at`;
      db.transaction(() => {
        db.exec(`
          CREATE TABLE employee_timeline__new (
            id             INTEGER PRIMARY KEY AUTOINCREMENT,
            employee_id    INTEGER REFERENCES employees(id) ON DELETE SET NULL,
            employee_name  TEXT,
            phone          TEXT,
            email          TEXT,
            linked_user_label TEXT,
            department_id  INTEGER REFERENCES org_departments(id),
            designation_id INTEGER REFERENCES org_designations(id),
            department     TEXT,
            designation    TEXT,
            manager_id     INTEGER,
            salary         REAL,
            salary_exempt  INTEGER,
            roster         TEXT,
            ot_eligible    INTEGER,
            status         TEXT,
            join_date      TEXT,
            salary_effective_from TEXT,
            status_effective_from TEXT,
            salary_action  TEXT,
            salary_reason_code TEXT,
            effective_from TEXT NOT NULL,
            effective_seq  INTEGER DEFAULT 0,
            effective_to   TEXT,
            action_code    TEXT,
            reason_code    TEXT,
            reason         TEXT,
            source         TEXT,
            changed_by     INTEGER,
            changed_at     DATETIME DEFAULT CURRENT_TIMESTAMP
          );
          INSERT INTO employee_timeline__new (${cols}) SELECT ${cols} FROM employee_timeline;
          DROP TABLE employee_timeline;
          ALTER TABLE employee_timeline__new RENAME TO employee_timeline;
          CREATE UNIQUE INDEX IF NOT EXISTS uniq_emp_timeline_open
            ON employee_timeline(employee_id) WHERE effective_to IS NULL;
          CREATE INDEX IF NOT EXISTS idx_emp_timeline_asof
            ON employee_timeline(employee_id, effective_from, effective_seq);
          CREATE INDEX IF NOT EXISTS idx_emp_timeline_dept_open
            ON employee_timeline(department_id) WHERE effective_to IS NULL;
          CREATE INDEX IF NOT EXISTS idx_emp_timeline_desig_open
            ON employee_timeline(designation_id) WHERE effective_to IS NULL;
        `);
      })();
      db.pragma('foreign_keys = ON');
      console.log('[schema] employee_timeline reshaped → employee_id ON DELETE SET NULL');
    }

    // Last-modified stamp on employees (HR-form writes bump it; NULL until first edit
    // or a backfill seed). Plain guarded ALTER — house pattern.
    try { db.exec(`ALTER TABLE employees ADD COLUMN updated_at TEXT`); } catch (_) { /* already exists */ }
  } catch (e) {
    console.error('[schema] employee_timeline change-history reshape failed:', e.message);
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
  }

  // Employee document re-upload events (HR History redesign, dme 2026-07-31).
  // Aadhar/PAN/Qualification files are plain employees columns, silently
  // overwritten on edit with no ledger trace. Rather than mirroring 3 file
  // columns into employee_timeline (which asserts "state as of a date" — not
  // true of a document swap), these are logged as their own lightweight event
  // table and merged into the HR History timeline at read time alongside
  // employee_timeline's field-change events.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS employee_document_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        employee_id INTEGER REFERENCES employees(id) ON DELETE CASCADE,
        doc_type    TEXT NOT NULL,   -- 'aadhar' | 'pan' | 'qualification'
        file_url    TEXT,
        reason      TEXT,            -- required by the route layer (hr.js PUT /employees/:id)
        changed_by  INTEGER,         -- soft ref, no FK (matches employee_timeline.changed_by)
        changed_at  DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_emp_doc_events_emp
        ON employee_document_events(employee_id, changed_at);
    `);
  } catch (e) { console.error('[schema] employee_document_events create failed:', e.message); }
}

module.exports = { runHrMigrations };
