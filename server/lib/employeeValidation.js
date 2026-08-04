// Mandatory Field Spec — HR pack validation (plan: keep-confirmation-status-
// separate-elegant-beacon, Phase 2 + the 2026-08-04 lifecycle revision). The
// SERVER rule here is the real one; client-side checks (Phase 3/4) are UX
// only and bypassable.
//
// Two distinct concerns, kept deliberately separate:
//   - validateEmployee()      — is a SUPPLIED value valid? Runs on every
//                                POST/PUT, unconditionally, on whatever keys
//                                are present. Never checks presence itself.
//   - REQUIRED_FOR_ACTIVATION / getActivationGaps() — IS the record complete
//                                enough to go operational? Checked only at
//                                the Activation business action (hr.js POST
//                                /employees/:id/activate), never at create,
//                                never blocking on an ordinary edit.
//
// getActivationGaps() is a PURE calculation — no writes, no Timeline events,
// no state transitions. Those live in the business endpoints that call it
// (activate, and later: Workspace progress, reports, bulk validation) so
// this one function stays safely reusable across all of them.
//
// Deliberately NOT validated here: designation/department catalog
// membership, and "reports-to must hold a manager role". Both are tied to
// the Org Structure picker UI landing in Phase 4 — designation/department
// are still free text today, so enforcing catalog membership now would 400
// almost every existing employee's next edit. "Manager role" isn't modelled
// at all (see the plan) — reports-to graph integrity (active, not self, no
// cycle) is enforced instead, below.

const { SECTION_BY_FIELD } = require('./employeeSections');

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const norm = (v) => String(v || '').trim().toLowerCase();
const ymd = (d) => d.toISOString().slice(0, 10);
const addYears = (base, years) => { const d = new Date(base); d.setFullYear(d.getFullYear() + years); return d; };

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[0-9]{6}$/;
// Mirrors client/src/constants/employeeValidation.js's ADDRESS_MAX_LEN — kept
// in sync manually (small, self-contained rule, not worth a shared module).
// Indian addresses (flat/building, street, landmark, area, city, state)
// routinely run 150-220 characters; 250 gives room without being unbounded.
const ADDRESS_MAX_LEN = 250;

const ENUMS = {
  employment_type: ['Permanent', 'Contract', 'Intern', 'Vendor'],
  confirmation_status: ['Probation', 'Confirmed', 'Terminated'],
  gender: ['Male', 'Female', 'Other'],
  blood_group: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  notice_period_days: [30, 60, 90],
};

// [payload key, human label, optional custom check(value)]. `check` defaults
// to "not blank" — only overridden where presence alone is the wrong test
// (salary: `0`/blank both mean "not set", but `isBlank(0)` is false). This
// list feeds BOTH the Activation gate and the completeness reshape below —
// one list, two readers, never two rule sets to keep in sync. Section
// membership is NOT hardcoded here — it's looked up from
// employeeSections.js's SECTION_BY_FIELD, the single source of truth the
// Workspace client also reads (via GET /employees/meta/sections), so this
// list and the Workspace's screen layout can never disagree about which
// section a field lives in.
//
// Includes fields that predate this spec (salary, the 3 KYC docs) — they used
// to be required at CREATE (hand-written checks in hr.js's old POST); the
// 2026-08-04 lifecycle revision moves that requirement here instead, so a
// Draft employee genuinely only needs a name to exist.
const REQUIRED_FOR_ACTIVATION = [
  ['reports_to_employee_id', 'Reports to'],
  ['employment_type', 'Employment type'],
  ['grade', 'Grade'],
  ['probation_end_date', 'Probation end date'],
  ['confirmation_status', 'Confirmation status'],
  ['notice_period_days', 'Notice period'],
  ['salary', 'Salary', (v) => Number(v) > 0],
  ['date_of_birth', 'Date of birth'],
  ['gender', 'Gender'],
  ['father_spouse_name', "Father's / Spouse's name"],
  ['blood_group', 'Blood group'],
  ['photo_url', 'Photo'],
  ['permanent_address', 'Permanent address'],
  ['permanent_pincode', 'Permanent PIN code'],
  ['current_address', 'Current address'],
  ['current_pincode', 'Current PIN code'],
  ['emergency_contact_name', 'Emergency contact name'],
  ['emergency_contact_phone', 'Emergency contact phone'],
  ['aadhar_file', 'Aadhar card'],
  ['pan_file', 'PAN card'],
  ['qualification_file', 'Highest qualification certificate'],
];

// Walk UP the reports-to chain from `startId` (the proposed manager). If
// `employeeId` is ever reached, appointing startId as employeeId's manager
// would close a loop — returns the path for the error message, else null.
// Depth-capped against a corrupted/self-referential chain already in the DB.
function findReportsToCycle(db, startId, employeeId) {
  const path = [];
  const seen = new Set();
  let cur = db.prepare('SELECT id, name, reports_to_employee_id FROM employees WHERE id=?').get(startId);
  let depth = 0;
  while (cur && depth < 50) {
    path.push(cur.name || `#${cur.id}`);
    if (cur.id === employeeId) return path;
    if (seen.has(cur.id)) break;
    seen.add(cur.id);
    cur = cur.reports_to_employee_id
      ? db.prepare('SELECT id, name, reports_to_employee_id FROM employees WHERE id=?').get(cur.reports_to_employee_id)
      : null;
    depth++;
  }
  return null;
}

// Is a SUPPLIED value valid? Never checks presence — that's
// REQUIRED_FOR_ACTIVATION's job, checked only at Activation. Runs
// unconditionally on POST (whatever's optionally supplied at create) and PUT
// (whatever a section save touches), so an old employee with 17 blank HR
// fields can still get a same-day phone-number fix through.
//
// payload  — req.body, or a full persisted employee row (getActivationGaps
//            re-runs this against the row itself — every populated column
//            is then "supplied").
// opts.db          — better-sqlite3 handle, needed for grade/reports-to/
//                     deactivation-guard lookups.
// opts.employeeId  — the employee being edited (undefined on create).
// opts.before      — the employee's current row (edit only), used as the
//                     fallback for "own phone/name" when the field wasn't
//                     resubmitted this save.
// Returns [{ field, message }] — empty array means valid.
function validateEmployee(payload, { db, employeeId, before } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const has = (key) => !isBlank(payload[key]);

  // ── Salary — must be positive whenever explicitly supplied. Predates this
  // plan (used to be a standalone hard gate on every POST/PUT); requiring it
  // to EXIST moved to Activation (REQUIRED_FOR_ACTIVATION below) — this only
  // checks a SUPPLIED value's format, so an unrelated section save that
  // never touches salary is never blocked by it. ────────────────────────────
  if (has('salary') && !(Number(payload.salary) > 0)) {
    add('salary', 'Salary must be greater than 0');
  }

  // ── Join date window (spec #1 — existing field, tightened) ───────────────
  if (has('join_date')) {
    const jd = String(payload.join_date).slice(0, 10);
    if (!YMD_RE.test(jd)) add('join_date', 'Join date is invalid');
    else {
      const today = ymd(new Date());
      const floor = ymd(addYears(new Date(), -30));
      if (jd > today) add('join_date', 'Join date cannot be in the future');
      else if (jd < floor) add('join_date', 'Join date cannot be more than 30 years ago');
    }
  }

  // ── Date of birth — age ≥ 18 (spec #10) ───────────────────────────────────
  if (has('date_of_birth')) {
    const dob = String(payload.date_of_birth).slice(0, 10);
    if (!YMD_RE.test(dob)) add('date_of_birth', 'Date of birth is invalid');
    else if (dob > ymd(addYears(new Date(), -18))) add('date_of_birth', 'Employee must be at least 18 years old');
  }

  // ── PIN codes — 6 digits (spec #13/#14) ───────────────────────────────────
  if (has('permanent_pincode') && !PIN_RE.test(String(payload.permanent_pincode).trim())) {
    add('permanent_pincode', 'Permanent PIN code must be 6 digits');
  }
  if (has('current_pincode') && !PIN_RE.test(String(payload.current_pincode).trim())) {
    add('current_pincode', 'Current PIN code must be 6 digits');
  }

  // ── Address length (spec #13/#14) — the client caps the textarea at the
  // same limit, but this is the real gate; a direct API call must not be
  // able to stuff an unbounded string into a free-text column. ─────────────
  if (has('permanent_address') && String(payload.permanent_address).length > ADDRESS_MAX_LEN) {
    add('permanent_address', `Permanent address is too long (max ${ADDRESS_MAX_LEN} characters)`);
  }
  if (has('current_address') && String(payload.current_address).length > ADDRESS_MAX_LEN) {
    add('current_address', `Current address is too long (max ${ADDRESS_MAX_LEN} characters)`);
  }

  // ── Emergency contact ≠ self (spec #15) ───────────────────────────────────
  const ownPhone = has('phone') ? payload.phone : before?.phone;
  const ownName = has('name') ? payload.name : before?.name;
  if (has('emergency_contact_phone') && ownPhone && norm(payload.emergency_contact_phone) === norm(ownPhone)) {
    add('emergency_contact_phone', "Emergency contact cannot be the employee's own phone number");
  }
  if (has('emergency_contact_name') && ownName && norm(payload.emergency_contact_name) === norm(ownName)) {
    add('emergency_contact_name', 'Emergency contact cannot be the employee themselves');
  }

  // ── Enum membership (spec #5/#8/#9/#11/#16) ───────────────────────────────
  if (has('employment_type') && !ENUMS.employment_type.includes(payload.employment_type)) {
    add('employment_type', 'Invalid employment type');
  }
  if (has('confirmation_status') && !ENUMS.confirmation_status.includes(payload.confirmation_status)) {
    add('confirmation_status', 'Invalid confirmation status');
  }
  if (has('gender') && !ENUMS.gender.includes(payload.gender)) {
    add('gender', 'Invalid gender');
  }
  if (has('blood_group') && !ENUMS.blood_group.includes(payload.blood_group)) {
    add('blood_group', 'Invalid blood group');
  }
  if (has('notice_period_days') && !ENUMS.notice_period_days.includes(Number(payload.notice_period_days))) {
    add('notice_period_days', 'Notice period must be 30, 60 or 90 days');
  }

  // ── Grade — scheme is DATA (org_grades), not code (spec #6) ──────────────
  if (has('grade') && db) {
    const g = db.prepare('SELECT 1 FROM org_grades WHERE code = ? AND active = 1').get(payload.grade);
    if (!g) add('grade', 'Grade is not in the catalog');
  }

  // ── Reports To — structural graph integrity (spec #4, narrowed) ──────────
  if (has('reports_to_employee_id') && db) {
    const mgrId = Number(payload.reports_to_employee_id);
    if (employeeId && mgrId === Number(employeeId)) {
      add('reports_to_employee_id', 'An employee cannot report to themselves');
    } else {
      const mgr = db.prepare('SELECT id, status FROM employees WHERE id=?').get(mgrId);
      if (!mgr) add('reports_to_employee_id', 'Selected manager was not found');
      else if (mgr.status !== 'active') add('reports_to_employee_id', 'Selected manager is not an active employee');
      else if (employeeId) {
        const cycle = findReportsToCycle(db, mgrId, Number(employeeId));
        if (cycle) add('reports_to_employee_id', `This would create a reporting loop: ${cycle.join(' → ')}`);
      }
    }
  }

  // ── Deactivation guard — a manager can't be set inactive/terminated while
  // people still actively report to them (plan: "structural rules that ARE
  // enforced" #3). Fires off the ordinary `status` field, not a new one. ────
  if (has('status') && ['inactive', 'terminated'].includes(norm(payload.status)) && db && employeeId) {
    const reports = db.prepare(
      "SELECT name FROM employees WHERE reports_to_employee_id = ? AND status = 'active'"
    ).all(Number(employeeId));
    if (reports.length) {
      add('status', `${reports.length} employee${reports.length === 1 ? '' : 's'} report${reports.length === 1 ? 's' : ''} to this person (${reports.map((r) => r.name).join(', ')}) — reassign them before setting this status`);
    }
  }

  return errors;
}

// PURE — reads the DB (grade/reports-to lookups) but never writes anything.
// No Timeline events, no state transitions, no UPDATEs. This is deliberate:
// it's the one function Activation, Workspace progress, reports and any
// future bulk-validation all call — a side effect here would make every one
// of those callers unsafe to call it from. State changes belong in the
// business endpoints that call this, not in this function.
//
// employeeRow — a full row from `employees` (e.g. `SELECT * FROM employees
//               WHERE id=?`), not a partial request payload.
// Returns [{ field, section, message }] — empty array means ready to activate.
function getActivationGaps(employeeRow, { db } = {}) {
  const gaps = [];
  const seen = new Set();

  // 1. Presence / custom check, from REQUIRED_FOR_ACTIVATION.
  for (const [key, label, check] of REQUIRED_FOR_ACTIVATION) {
    const ok = check ? check(employeeRow[key]) : !isBlank(employeeRow[key]);
    if (!ok) { gaps.push({ field: key, section: SECTION_BY_FIELD.get(key) || null, message: `${label} is required` }); seen.add(key); }
  }

  // 2. Re-run the SAME per-field correctness rules already used on every
  // PUT, against the row itself — catches a populated-but-malformed field
  // (bad PIN, invalid enum, a stale self-referential reports_to, etc.) that
  // presence alone would miss. No new rule logic — this is the exact call
  // site Phase 2 already built, just fed the persisted row instead of a
  // request body. `status` is excluded: its own check is about a PROPOSED
  // status change, meaningless when just reading the employee's current row.
  const { status, ...correctnessPayload } = employeeRow;
  const correctness = validateEmployee(correctnessPayload, { db, employeeId: employeeRow.id, before: employeeRow });
  for (const err of correctness) {
    if (seen.has(err.field)) continue; // already flagged as missing — don't double count
    gaps.push({ field: err.field, section: SECTION_BY_FIELD.get(err.field) || null, message: err.message });
    seen.add(err.field);
  }

  return gaps;
}

// Reshapes getActivationGaps() into progress counts for the Workspace's
// completeness indicators. Purely a VIEW over the same computation — adds no
// validation logic of its own, so it can never drift from what Activation
// actually enforces.
function computeCompleteness(employeeRow, { db } = {}) {
  const gaps = getActivationGaps(employeeRow, { db });
  const gapFields = new Set(gaps.map((g) => g.field));

  const sections = {};
  for (const [key] of REQUIRED_FOR_ACTIVATION) {
    const section = SECTION_BY_FIELD.get(key) || 'other';
    sections[section] ||= { total: 0, done: 0 };
    sections[section].total++;
    if (!gapFields.has(key)) sections[section].done++;
  }
  for (const s of Object.keys(sections)) {
    sections[s].pct = sections[s].total ? Math.round((sections[s].done / sections[s].total) * 100) : 100;
  }

  // NOTE: gapFields can include fields outside REQUIRED_FOR_ACTIVATION (e.g. a
  // malformed join_date) — those affect Activation (getActivationGaps returns
  // them) but must NOT skew the completeness percentage, which is scoped to
  // the 21-field checklist only.
  const total = REQUIRED_FOR_ACTIVATION.length;
  const done = total - REQUIRED_FOR_ACTIVATION.filter(([key]) => gapFields.has(key)).length;
  return {
    overall: { total, done, pct: total ? Math.round((done / total) * 100) : 100 },
    sections,
    errors: gaps,
  };
}

module.exports = {
  validateEmployee,
  getActivationGaps,
  computeCompleteness,
  ENUMS,
  REQUIRED_FOR_ACTIVATION,
};
