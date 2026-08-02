// Client mirror of server/lib/employeeChangeCodes.js — keep in sync.
// The vocabulary + diff helpers for the employee change-history Change Card.

// Status is isolated (own effective date/block, mirrors salary) — no longer a
// pickable shared Action. Keep in sync with server/lib/employeeChangeCodes.js.
export const ACTIONS = [
  'Hired', 'Promotion', 'Pay Revision', 'Transfer',
  'Roster Change', 'Correction', 'Other',
];

export const TURNOVER_REASONS = [
  'Resignation', 'Termination – Performance', 'Termination – Misconduct',
  'Redundancy/Layoff', 'End of Contract', 'Absconding', 'Retirement', 'Deceased', 'Other',
];

// Tracked fields (the HR-form fields whose change opens a reason-required row).
// join_date is locked-by-default in the UI (see Employees.jsx) — changing it is
// treated as a correction and goes through this same reason-required path.
// name/phone/email/user_id (linked login) joined the tracked set 2026-07-31.
export const TRACKED_FIELDS = [
  { key: 'status',      label: 'Status' },
  { key: 'salary',      label: 'Pay',        money: true },
  { key: 'designation', label: 'Role' },
  { key: 'department',  label: 'Department' },
  { key: 'roster',      label: 'Roster' },
  { key: 'join_date',   label: 'Join date' },
  { key: 'name',        label: 'Name' },
  { key: 'phone',       label: 'Phone' },
  { key: 'email',       label: 'Email' },
  { key: 'user_id',     label: 'Linked user' },
];

export const EXIT_STATUSES = ['inactive', 'terminated'];

// Salary's own action classifier — isolated from ACTIONS above. Binary,
// always-visible choice whenever salary changed. Demotion is still
// 'revision' — nothing was wrong before, still forward-looking pay.
export const SALARY_ACTIONS = ['revision', 'correction'];

// Full structured salary-change-reason taxonomy — shown only when
// salary_action === 'revision'. Keep in sync with server/lib/employeeChangeCodes.js.
export const SALARY_REASON_CODES = [
  { code: 'annual_increment',      label: 'Annual Increment' },
  { code: 'promotion',             label: 'Promotion' },
  { code: 'market_adjustment',     label: 'Market Adjustment' },
  { code: 'retention',             label: 'Retention' },
  { code: 'statutory',             label: 'Statutory' },
  { code: 'probation_confirmation', label: 'Probation Confirmation' },
  { code: 'demotion',              label: 'Demotion' },
  { code: 'other',                 label: 'Other' },
];

// Server-computed-only label for a multi-field edit (never a dropdown choice —
// see resolveAction below). Keep in sync with server/lib/employeeChangeCodes.js.
export const MULTI_ACTION = 'Multiple changes';

// Suggest an action from the set of changed field keys — used ONLY when exactly
// one tracked field changed. Mirrors the server's suggestAction.
export function suggestAction(changedKeys) {
  const s = new Set(changedKeys || []);
  if (s.has('status')) return 'Status Change';
  if (s.has('salary')) return 'Pay Revision';
  if (s.has('designation') || s.has('department')) return 'Transfer';
  if (s.has('roster')) return 'Roster Change';
  return 'Correction';
}

// What the Action control should show/allow, given how many fields changed.
// >1 field → LOCKED to "Multiple changes" (no dropdown — this is the fix for
// picking "Status Change" then also changing roster and forgetting to update
// the dropdown, which used to mislabel the roster change). Exactly 1 field →
// an editable dropdown seeded with the suggestion.
export function resolveAction(changedKeys) {
  const n = (changedKeys || []).length;
  if (n > 1) return { locked: true, value: MULTI_ACTION };
  if (n === 1) return { locked: false, value: suggestAction(changedKeys) };
  return { locked: true, value: '' };
}

// Compute the live diff between the original row and the edited form.
// Returns [{ key, label, money, from, to }]. Normalizes like the server.
export function computeChanges(original, form) {
  if (!original) return [];
  const norm = (v) => (v == null ? '' : String(v).trim());
  const out = [];
  for (const f of TRACKED_FIELDS) {
    const a = form[f.key], b = original[f.key];
    const changed = f.money
      ? Number(a || 0) !== Number(b || 0)
      : norm(a) !== norm(b);
    if (changed) out.push({ ...f, from: b, to: a });
  }
  return out;
}
