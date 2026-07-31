// Employee change-history taxonomy (plan: magical-wibbling-orbit).
//
// The vocabulary for the employee_timeline ledger: what KIND of change a row is
// (action_code) and, for exits, WHY (reason_code). Baked constants for now — they
// graduate to an admin-editable settings table later without touching callers.
//
// Mirrored on the client in client/src/constants/employeeChangeCodes.js — keep the
// two in sync. The server is the source of truth for validation.

// The change action. "Other" is always present so the picker can never block a save.
const ACTIONS = [
  'Hired',
  'Promotion',
  'Pay Revision',
  'Transfer',
  'Roster Change',
  'Status Change',
  'Correction',
  'Other',
];

// System-only actions (never chosen by a human on the HR form).
const SYSTEM_ACTIONS = ['Payroll Update', 'Reconstructed'];

// Optional coded turnover reason — shown only when a Status Change moves an
// employee to inactive/terminated. Feeds attrition analytics later.
const TURNOVER_REASONS = [
  'Resignation',
  'Termination – Performance',
  'Termination – Misconduct',
  'Redundancy/Layoff',
  'End of Contract',
  'Absconding',
  'Retirement',
  'Deceased',
  'Other',
];

// The fields whose change opens a reason-required ledger row (the HR edit form's
// tracked set). salary_exempt/ot_eligible are payroll-owned — snapshotted but never
// reason-prompted here (ot_eligible gets a silent system row from payroll instead).
const TRACKED_FIELDS = ['status', 'salary', 'designation', 'department', 'roster'];

// Auto-suggest an action from what actually changed. Human can override to any of
// ACTIONS (incl. "Other"). Order = precedence when several fields changed at once.
function suggestAction(changedFields) {
  const s = new Set(changedFields || []);
  if (s.has('status')) return 'Status Change';
  if (s.has('salary')) return 'Pay Revision';
  if (s.has('designation') || s.has('department')) return 'Transfer';
  if (s.has('roster')) return 'Roster Change';
  return 'Correction';
}

// Statuses that count as an "exit" → the turnover reason dropdown appears.
const EXIT_STATUSES = ['inactive', 'terminated'];

module.exports = {
  ACTIONS,
  SYSTEM_ACTIONS,
  TURNOVER_REASONS,
  TRACKED_FIELDS,
  EXIT_STATUSES,
  suggestAction,
};
