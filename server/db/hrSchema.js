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
  // Statutory/Compliance pack (aadhar_number/aadhar_last4/pan_number/
  // uan_number/pf_number/esi_number/bank_name/bank_branch/
  // bank_account_number/ifsc_code/pt_state) and Compensation pack
  // (ctc_annual...salary_review_cycle, 14 cols) used to be ALTERed onto
  // `employees` here. Moved out (dme 2026-08-04, "so many columns in
  // employee table" architecture review) into their own 1:1 satellite
  // tables — see the employee_statutory / employee_compensation block
  // further down in runHrMigrations(), which also does the one-time
  // backfill-copy + DROP COLUMN off `employees`. Kept OUT of this array so
  // a fresh boot never re-ADDs a column that block has already dropped.
  'form11_file TEXT',
  'formf_file TEXT',

  // Assets pack (Mandatory Field Spec, Module 3, 2026-08-04) — 4 spec items
  // (#41-44). Plain free-text tags, no format regex, "mandatory at Issued"
  // (a post-hire event) not Hire — same precedent as UAN/PF/ESI, excluded
  // from REQUIRED_FOR_ACTIVATION (employeeValidation.js). Independent of the
  // pre-existing company_assets/company_asset_movements register (keyed to
  // users, not employees) — the Assets tab additionally shows a read-only
  // mirror of that register, but never reads/writes these 4 columns.
  'laptop_asset_tag TEXT',
  'mobile_asset_tag TEXT',
  'vehicle_allotted TEXT',
  'sim_card_number TEXT',
];

function runHrMigrations(db) {
  for (const col of EMPLOYEE_COLUMNS) {
    try { db.exec(`ALTER TABLE employees ADD COLUMN ${col}`); } catch (e) {}
  }

  // Plan B.0 Phase 1 — soft org binds on the live employee row. Leaf TEXT
  // (department / designation) stays the denormalized display/legacy axis;
  // these IDs are the identity for rename self-heal + Org Structure HOME.
  // Soft refs (no FK) so catalog deactivate/delete guards stay app-level.
  try { db.exec('ALTER TABLE employees ADD COLUMN department_id INTEGER'); } catch (e) {}
  try { db.exec('ALTER TABLE employees ADD COLUMN designation_id INTEGER'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_department_id ON employees(department_id)'); } catch (e) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_employees_designation_id ON employees(designation_id)'); } catch (e) {}

  // Statutory/Compliance catalogs (PT State, Bank Name) — same shape and
  // pattern as org_grades (orgSchema.js): id/name/sort_order/active, seeded
  // once on an empty table, CRUD deferred to Org Structure later. Bank Name's
  // dropdown always offers "Other" client-side (not a catalog row) to fall
  // back to free text — see StatutorySection.jsx.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_pt_states (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER DEFAULT 0,
        active     INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS org_banks (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,
        sort_order INTEGER DEFAULT 0,
        active     INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
    if (db.prepare('SELECT COUNT(*) c FROM org_pt_states').get().c === 0) {
      const PT_STATES = [
        'Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Gujarat', 'Jharkhand',
        'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya',
        'Mizoram', 'Nagaland', 'Odisha', 'Puducherry', 'Punjab', 'Sikkim', 'Tamil Nadu',
        'Telangana', 'Tripura', 'West Bengal', 'Delhi', 'Not Applicable',
      ];
      const ins = db.prepare('INSERT INTO org_pt_states (name, sort_order) VALUES (?,?)');
      PT_STATES.forEach((n, i) => ins.run(n, i));
      console.log(`[schema] org_pt_states seeded (${PT_STATES.length} entries)`);
    }
    if (db.prepare('SELECT COUNT(*) c FROM org_banks').get().c === 0) {
      const BANKS = [
        'State Bank of India', 'HDFC Bank', 'ICICI Bank', 'Axis Bank', 'Punjab National Bank',
        'Bank of Baroda', 'Kotak Mahindra Bank', 'IndusInd Bank', 'Yes Bank', 'Canara Bank',
        'Union Bank of India', 'IDBI Bank', 'Bank of India', 'Central Bank of India',
        'IDFC First Bank', 'Federal Bank', 'Indian Bank', 'UCO Bank', 'Bank of Maharashtra',
        'Indian Overseas Bank',
      ];
      const ins = db.prepare('INSERT INTO org_banks (name, sort_order) VALUES (?,?)');
      BANKS.forEach((n, i) => ins.run(n, i));
      console.log(`[schema] org_banks seeded (${BANKS.length} entries)`);
    }
  } catch (e) { console.error('[schema] statutory catalogs create/seed failed:', e.message); }

  // Aadhaar encrypt-and-mask backfill (dme 2026-08-04 fix — the field
  // shipped earlier this session stored the full 12-digit number in the
  // clear, a deviation from the spec's "last 4 only, masked storage" rule).
  // One-time, guarded on looking like a raw 12-digit value (ciphertext never
  // matches that shape) — safe to leave running on every boot. Also guarded
  // on the column still living on `employees` — once the satellite split
  // below has dropped it, this becomes a no-op rather than an error (the
  // aadhar_number column now lives on employee_statutory; nothing here needs
  // to re-run against it since the split's own backfill already carried
  // across whatever this block had already encrypted).
  try {
    if (db.prepare('PRAGMA table_info(employees)').all().some((c) => c.name === 'aadhar_number')) {
      const { encryptAadhaar, last4 } = require('../lib/cryptoFields');
      const rows = db.prepare(
        "SELECT id, aadhar_number FROM employees WHERE aadhar_number IS NOT NULL AND aadhar_number GLOB '[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]'"
      ).all();
      if (rows.length) {
        const upd = db.prepare('UPDATE employees SET aadhar_number=?, aadhar_last4=? WHERE id=?');
        for (const r of rows) upd.run(encryptAadhaar(r.aadhar_number), last4(r.aadhar_number), r.id);
        console.log(`[schema] aadhar_number: encrypted ${rows.length} plaintext value(s) in place`);
      }
    }
  } catch (e) { console.error('[schema] aadhar_number encrypt-backfill failed:', e.message); }

  // ───────────────────────────────────────────────────────────────────────────
  // Statutory + Compensation satellite tables (dme 2026-08-04 architecture
  // review: "so many columns in employee table, can some relational linked
  // sub tables make efficient for us?"). 1:1 with employees, employee_id as
  // the PK (no surrogate id needed — this is a vertical partition, not a new
  // entity). Only two clusters qualify: Statutory has a real security
  // boundary (employee_statutory.can_view already gates it end-to-end) and a
  // stable, fully-known shape (no history ever needed); Compensation's
  // effective-dating already lives safely in employee_timeline's snapshot
  // mechanism regardless of which physical table these columns sit in, so
  // moving them carries no risk of guessing a future shape wrong. Every
  // other HR-pack field stays flat — no security/lifecycle boundary of its
  // own to justify the join cost.
  //
  // ONE-SHOT cutover, no dual-write phase: nothing outside the Employee
  // Workspace stack (hr.js / employeeFields.js / employeeTimeline.js /
  // employeeValidation.js) touches these columns on `employees` (verified),
  // so there is no benefit to running old-and-new in parallel — that would
  // just let the old columns go stale the moment the new write path lands.
  // Create → backfill-copy → drop, all inside this single boot sequence,
  // shipped in the same commit as the hr.js/employeeTimeline.js read/write
  // changes that stop touching these columns on `employees`.
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS employee_statutory (
        employee_id         INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        aadhar_number        TEXT,   -- ciphertext (see cryptoFields.js) — same as employees column was
        aadhar_last4         TEXT,
        pan_number           TEXT,
        uan_number           TEXT,
        pf_number            TEXT,
        esi_number           TEXT,
        bank_name            TEXT,
        bank_branch          TEXT,
        bank_account_number  TEXT,
        ifsc_code            TEXT,
        pt_state             TEXT
      );
      CREATE TABLE IF NOT EXISTS employee_compensation (
        employee_id             INTEGER PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        ctc_annual              REAL,
        fixed_monthly_gross     REAL,
        variable_bonus          REAL,
        basic_pay               REAL,
        hra                     REAL,
        special_allowance       REAL,
        pf_deduction            REAL,
        esi_deduction           REAL,
        professional_tax        REAL,
        tds_estimated_annual    REAL,
        reimbursements          REAL,
        bonus_target_pct        REAL,
        last_increment_date     DATE,
        salary_review_cycle     TEXT
      );
    `);

    // Backfill — ADDITIVE, per-employee, idempotent (guarded on NOT IN, not a
    // count gate) so it only ever copies rows that don't have a satellite row
    // yet. Runs BEFORE the DROP COLUMNs below so the source columns are still
    // there to read. Safe to leave running every boot — a no-op once every
    // employee has been copied.
    const statutoryCols = ['employee_id', 'aadhar_number', 'aadhar_last4', 'pan_number', 'uan_number',
      'pf_number', 'esi_number', 'bank_name', 'bank_branch', 'bank_account_number', 'ifsc_code', 'pt_state'];
    const empColsNow = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
    if (empColsNow.includes('aadhar_number')) {
      const srcCols = statutoryCols.map((c) => (c === 'employee_id' ? 'id' : c)).join(', ');
      const info = db.prepare(`
        INSERT INTO employee_statutory (${statutoryCols.join(', ')})
        SELECT ${srcCols} FROM employees WHERE id NOT IN (SELECT employee_id FROM employee_statutory)
      `).run();
      if (info.changes) console.log(`[schema] employee_statutory: backfilled ${info.changes} row(s) from employees`);
    }

    const compensationCols = ['employee_id', 'ctc_annual', 'fixed_monthly_gross', 'variable_bonus',
      'basic_pay', 'hra', 'special_allowance', 'pf_deduction', 'esi_deduction', 'professional_tax',
      'tds_estimated_annual', 'reimbursements', 'bonus_target_pct', 'last_increment_date', 'salary_review_cycle'];
    if (empColsNow.includes('ctc_annual')) {
      const srcCols = compensationCols.map((c) => (c === 'employee_id' ? 'id' : c)).join(', ');
      const info = db.prepare(`
        INSERT INTO employee_compensation (${compensationCols.join(', ')})
        SELECT ${srcCols} FROM employees WHERE id NOT IN (SELECT employee_id FROM employee_compensation)
      `).run();
      if (info.changes) console.log(`[schema] employee_compensation: backfilled ${info.changes} row(s) from employees`);
    }

    // Drop the now-migrated columns off employees — one ALTER per column
    // (better-sqlite3 ^11 bundles SQLite ≥3.35, which supports DROP COLUMN
    // natively; no table-rebuild dance needed). Each guarded individually so
    // a partially-migrated DB (or a column already dropped by a prior boot)
    // never throws — re-running boot after the first successful drop is a
    // total no-op.
    const empColsAfterBackfill = db.prepare('PRAGMA table_info(employees)').all().map((c) => c.name);
    const toDrop = statutoryCols.concat(compensationCols).filter((c) => c !== 'employee_id');
    let dropped = 0;
    toDrop.forEach((col) => {
      if (empColsAfterBackfill.includes(col)) {
        try { db.exec(`ALTER TABLE employees DROP COLUMN ${col}`); dropped++; } catch (e) {
          console.error(`[schema] employees.${col} DROP COLUMN failed (leaving in place):`, e.message);
        }
      }
    });
    if (dropped) console.log(`[schema] employees: dropped ${dropped} column(s) now owned by employee_statutory/employee_compensation`);
  } catch (e) { console.error('[schema] employee_statutory/employee_compensation split failed:', e.message); }

  // Employee lifecycle (plan revision 2026-08-04) — Draft → sections completed
  // → Activated → payroll-eligible. A SEPARATE axis from `status` (payroll/
  // attendance eligibility) — see server/lib/employeeValidation.js and
  // hr.js's POST /employees/:id/activate. No DB default (same reasoning as
  // EMPLOYEE_COLUMNS above): a default would stamp 'draft' onto every real,
  // long-serving employee the moment this ALTER runs. Instead: add the bare
  // column, then explicitly backfill every EXISTING row to 'complete' — new
  // rows are written 'draft' at the application layer (hr.js POST /employees).
  // Backfill is a WHERE-guarded no-op after the first boot (every row has a
  // value by then), so it's safe to leave running on every startup.
  try {
    db.exec(`ALTER TABLE employees ADD COLUMN onboarding_status TEXT`);
  } catch (e) { /* already exists */ }
  try {
    const backfilled = db.prepare(
      "UPDATE employees SET onboarding_status = 'complete' WHERE onboarding_status IS NULL"
    ).run().changes;
    if (backfilled) console.log(`[schema] employees.onboarding_status: backfilled ${backfilled} existing row(s) to 'complete'`);
  } catch (e) { console.error('[schema] onboarding_status backfill failed:', e.message); }

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
    // Statutory/Compliance pack (Module 1, 2026-08-04) — snapshot columns for
    // the 7 non-sensitive tracked fields (bank_name/branch/ifsc/pt_state/
    // uan/pf/esi). aadhar_number/bank_account_number are NOT snapshotted here
    // on purpose — see employeeFields.js's `sensitive` flag comment.
    addCol('bank_name',   'bank_name TEXT');
    addCol('bank_branch', 'bank_branch TEXT');
    addCol('ifsc_code',   'ifsc_code TEXT');
    addCol('pt_state',    'pt_state TEXT');
    addCol('uan_number',  'uan_number TEXT');
    addCol('pf_number',   'pf_number TEXT');
    addCol('esi_number',  'esi_number TEXT');
    // MASKED forms only — never the real value (see employeeFields.js's
    // snapshotFrom comment on bank_account_number/aadhar_number).
    addCol('bank_account_masked', 'bank_account_masked TEXT');
    addCol('aadhar_masked',       'aadhar_masked TEXT');
    // Employee lifecycle (plan revision 2026-08-04) — snapshot of
    // employees.onboarding_status, so History/Vault reads "as of this date"
    // correctly. Not tracked (no reason prompt): Activation writes its own
    // dedicated event through its own code path (hr.js POST .../activate).
    addCol('onboarding_status', 'onboarding_status TEXT');
    // Compensation pack (Module 2, 2026-08-04) — plain current-value snapshot
    // columns for all 14 fields, same generic mechanism as the Statutory
    // fields above. Deliberately NOT extended with an effective-dating/
    // reason-taxonomy pair like salary_effective_from/salary_action — see
    // the plan's "Future extensibility" section: a dedicated Compensation
    // History module can layer that on top of these columns later without
    // needing to rip anything out here.
    addCol('ctc_annual',           'ctc_annual REAL');
    addCol('fixed_monthly_gross',  'fixed_monthly_gross REAL');
    addCol('variable_bonus',       'variable_bonus REAL');
    addCol('basic_pay',            'basic_pay REAL');
    addCol('hra',                  'hra REAL');
    addCol('special_allowance',    'special_allowance REAL');
    addCol('pf_deduction',         'pf_deduction REAL');
    addCol('esi_deduction',        'esi_deduction REAL');
    addCol('professional_tax',     'professional_tax REAL');
    addCol('tds_estimated_annual', 'tds_estimated_annual REAL');
    addCol('reimbursements',       'reimbursements REAL');
    addCol('bonus_target_pct',     'bonus_target_pct REAL');
    addCol('last_increment_date',  'last_increment_date TEXT');
    addCol('salary_review_cycle',  'salary_review_cycle TEXT');
    // Assets pack (Module 3, 2026-08-04) — plain current-value snapshot
    // columns for the 4 fields, same generic mechanism as Compensation above.
    addCol('laptop_asset_tag', 'laptop_asset_tag TEXT');
    addCol('mobile_asset_tag', 'mobile_asset_tag TEXT');
    addCol('vehicle_allotted', 'vehicle_allotted TEXT');
    addCol('sim_card_number',  'sim_card_number TEXT');

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
