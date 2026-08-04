// Employee change-history taxonomy (plan: magical-wibbling-orbit).
//
// The vocabulary for the employee_timeline ledger: what KIND of change a row is
// (action_code) and, for exits, WHY (reason_code). Baked constants for now — they
// graduate to an admin-editable settings table later without touching callers.
//
// Mirrored on the client in client/src/constants/employeeChangeCodes.js — keep the
// two in sync. The server is the source of truth for validation.

const { trackedKeys } = require('./employeeFields');

// The change action. "Other" is always present so the picker can never block a save.
// 'Multiple changes' is SERVER-COMPUTED ONLY (never a dropdown choice) — see
// resolveActionCode below: when >1 tracked field moves in one edit, forcing a
// single human-picked label (e.g. "Status Change") silently mislabels the OTHER
// fields that also changed (dme 2026-08-01: changed roster, forgot to flip the
// dropdown off "Status Change" — the roster change would have recorded wrong).
// Status is ALSO isolated now (own effective date + block, like salary) — so
// 'Status Change' is dropped from this picklist too: it can never be the
// server-derived suggestion for the shared Action (status is excluded from
// its field-count, see resolveActionCode's call site in hr.js) and offering
// it as a manual pick would just mislabel whatever non-salary/non-status
// field actually drove the shared Action.
const ACTIONS = [
  'Hired',
  'Promotion',
  'Pay Revision',
  'Transfer',
  'Roster Change',
  'Correction',
  'Other',
];
const MULTI_ACTION = 'Multiple changes';

// System-only actions (never chosen by a human on the HR form).
const SYSTEM_ACTIONS = ['Payroll Update', 'Reconstructed', 'Activated'];

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
// join_date is tracked too (2026-08-01): it's a locked field in the UI — changing
// it after the fact is a correction, and HR wants that correction on record.
// name/phone/email/user_id joined the tracked set 2026-07-31 — HR wants contact-info
// and linked-login corrections on record too ("how can we forget" — dme).
//
// Derived from the field registry (lib/employeeFields.js) rather than hand-listed —
// the same source that feeds the hr.js diff, SNAPSHOT_COLS and CHANGE_FIELDS, so a
// new tracked field cannot land in one of them and silently miss the others.
const TRACKED_FIELDS = trackedKeys();

// Auto-suggest an action from what actually changed — used ONLY as the UI's
// starting value when exactly one tracked field changed. Human may override to
// any single-field ACTIONS entry (incl. "Other"). Never called for >1 field.
function suggestAction(changedFields) {
  const s = new Set(changedFields || []);
  if (s.has('status')) return 'Status Change';
  if (s.has('salary')) return 'Pay Revision';
  if (s.has('designation') || s.has('department')) return 'Transfer';
  if (s.has('roster')) return 'Roster Change';
  return 'Correction';
}

// The SERVER-AUTHORITATIVE action_code for a save. This is the fix for the
// "stray dropdown" bug: a human-picked action_code is honored ONLY when exactly
// one tracked field changed (they were choosing a label for that one thing). The
// moment 2+ fields move together, whatever the dropdown says is IGNORED and the
// row is stamped 'Multiple changes' — so a leftover "Status Change" pick can never
// misrepresent a roster/salary field that changed alongside it.
function resolveActionCode(changedFields, clientActionCode) {
  const n = (changedFields || []).length;
  if (n > 1) return MULTI_ACTION;
  if (n === 1) {
    const picked = String(clientActionCode || '').trim();
    return (picked && ACTIONS.includes(picked)) ? picked : suggestAction(changedFields);
  }
  return null; // no tracked change — caller shouldn't be recording a row at all
}

// Statuses that count as an "exit" → the turnover reason dropdown appears.
const EXIT_STATUSES = ['inactive', 'terminated'];

// Salary's own action classifier — isolated from the shared ACTIONS list above
// (see employee_timeline.salary_action). A binary, always-visible choice
// whenever salary changed: is this forward-looking (revision) or fixing a
// past mistake (correction)? Demotion is still a 'revision' — nothing was
// wrong before, it's still forward-looking pay.
const SALARY_ACTIONS = ['revision', 'correction'];

// Full structured salary-change-reason taxonomy — shown only when
// salary_action='revision' (a correction's story is "wrong entry", already
// covered by the shared free-text Reason box). `other` is the escape valve.
const SALARY_REASON_CODES = [
  'annual_increment',
  'promotion',
  'market_adjustment',
  'retention',
  'statutory',
  'probation_confirmation',
  'demotion',
  'other',
];
const SALARY_REASON_LABELS = {
  annual_increment: 'Annual Increment',
  promotion: 'Promotion',
  market_adjustment: 'Market Adjustment',
  retention: 'Retention',
  statutory: 'Statutory',
  probation_confirmation: 'Probation Confirmation',
  demotion: 'Demotion',
  other: 'Other',
};

// ── HR History event-type classification (read-time only) ──────────────────
// Independent of action_code/resolveActionCode above (that's the write-time,
// human-picked label kept for the ledger). This decides the HR-facing "event
// type" shown on the History timeline and in the Excel reports, from the set
// of field keys that changed together in one save. Fixed priority order so a
// grouped save always gets exactly one label — never a raw "multiple changes"
// bucket. No manual override (dme 2026-07-31: auto-classification is final).
const HR_EVENT_TYPES = [
  'Joined', 'Activated', 'Status Change', 'Promotion', 'Transfer',
  'Salary Revision', 'Documents Updated', 'Correction',
];
// salaryAction ('revision'|'correction'|null) only matters for the
// salary-alone branch — a salary CORRECTION reads as the existing generic
// 'Correction' bucket instead of 'Salary Revision', no new event type needed.
function classifyEvent({ isFirst = false, changedKeys = [], salaryAction = null } = {}) {
  if (isFirst) return 'Joined';
  const s = new Set(changedKeys);
  // Employee lifecycle (plan revision 2026-08-04) — Activation writes only
  // onboarding_status, so this branch is unambiguous and takes priority the
  // same way 'Joined' does above.
  if (s.has('onboarding_status')) return 'Activated';
  if (s.has('status')) return 'Status Change';
  if (s.has('designation') && s.has('salary')) return 'Promotion';
  if (s.has('designation') || s.has('department')) return 'Transfer';
  if (s.has('salary')) return salaryAction === 'correction' ? 'Correction' : 'Salary Revision';
  const nonDoc = changedKeys.filter((k) => !String(k).startsWith('doc_'));
  if (nonDoc.length === 0 && changedKeys.length > 0) return 'Documents Updated';
  return 'Correction';
}

module.exports = {
  ACTIONS,
  SYSTEM_ACTIONS,
  MULTI_ACTION,
  TURNOVER_REASONS,
  TRACKED_FIELDS,
  EXIT_STATUSES,
  HR_EVENT_TYPES,
  SALARY_ACTIONS,
  SALARY_REASON_CODES,
  SALARY_REASON_LABELS,
  suggestAction,
  resolveActionCode,
  classifyEvent,
};
