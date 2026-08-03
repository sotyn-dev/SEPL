// Mandatory Field Spec — HR pack validation (plan: keep-confirmation-status-
// separate-elegant-beacon, Phase 2). The SERVER rule here is the real one;
// client-side checks (Phase 3/4) are UX only and bypassable.
//
// "Required on create, never blocking on edit" — see the plan's "The rule
// that makes or breaks this": every employee alive today has all 17 of
// these fields blank. REQUIRED_AT_CREATE only fires for mode:'create'; on
// mode:'edit' a field is validated ONLY when the caller actually supplied
// it, so fixing a phone number on a five-year employee is never blocked by
// their missing blood group.
//
// Deliberately NOT validated here: designation/department catalog
// membership, and "reports-to must hold a manager role". Both are tied to
// the Org Structure picker UI landing in Phase 4 — designation/department
// are still free text today, so enforcing catalog membership now would 400
// almost every existing employee's next edit. "Manager role" isn't modelled
// at all (see the plan) — reports-to graph integrity (active, not self, no
// cycle) is enforced instead, below.

const isBlank = (v) => v === undefined || v === null || String(v).trim() === '';
const norm = (v) => String(v || '').trim().toLowerCase();
const ymd = (d) => d.toISOString().slice(0, 10);
const addYears = (base, years) => { const d = new Date(base); d.setFullYear(d.getFullYear() + years); return d; };

const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PIN_RE = /^[0-9]{6}$/;

const ENUMS = {
  employment_type: ['Permanent', 'Contract', 'Intern', 'Vendor'],
  confirmation_status: ['Probation', 'Confirmed', 'Terminated'],
  gender: ['Male', 'Female', 'Other'],
  blood_group: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'],
  notice_period_days: [30, 60, 90],
};

// [payload key, human label] — every "Hire" field in the spec's HR pack.
const REQUIRED_AT_CREATE = [
  ['reports_to_employee_id', 'Reports to'],
  ['employment_type', 'Employment type'],
  ['grade', 'Grade'],
  ['probation_end_date', 'Probation end date'],
  ['confirmation_status', 'Confirmation status'],
  ['notice_period_days', 'Notice period'],
  ['date_of_birth', 'Date of birth'],
  ['gender', 'Gender'],
  ['father_spouse_name', "Father's / Spouse's name"],
  ['permanent_address', 'Permanent address'],
  ['permanent_pincode', 'Permanent PIN code'],
  ['current_address', 'Current address'],
  ['current_pincode', 'Current PIN code'],
  ['emergency_contact_name', 'Emergency contact name'],
  ['emergency_contact_phone', 'Emergency contact phone'],
  ['blood_group', 'Blood group'],
  ['photo_url', 'Photo'],
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

// payload  — req.body, raw.
// opts.mode        — 'create' | 'edit'.
// opts.db           — better-sqlite3 handle, needed for grade/reports-to/
//                      deactivation-guard lookups.
// opts.employeeId   — the employee being edited (undefined on create).
// opts.before       — the employee's current row (edit only), used as the
//                      fallback for "own phone/name" when the field wasn't
//                      resubmitted this save.
// Returns [{ field, message }] — empty array means valid.
function validateEmployee(payload, { mode, db, employeeId, before } = {}) {
  const errors = [];
  const add = (field, message) => errors.push({ field, message });
  const has = (key) => !isBlank(payload[key]);

  if (mode === 'create') {
    for (const [key, label] of REQUIRED_AT_CREATE) {
      if (isBlank(payload[key])) add(key, `${label} is required`);
    }
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

module.exports = { validateEmployee, ENUMS, REQUIRED_AT_CREATE };
