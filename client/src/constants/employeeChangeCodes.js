// Client mirror of server/lib/employeeChangeCodes.js — keep in sync.
// The vocabulary + diff helpers for the employee change-history Change Card.

export const ACTIONS = [
  'Hired', 'Promotion', 'Pay Revision', 'Transfer',
  'Roster Change', 'Status Change', 'Correction', 'Other',
];

export const TURNOVER_REASONS = [
  'Resignation', 'Termination – Performance', 'Termination – Misconduct',
  'Redundancy/Layoff', 'End of Contract', 'Absconding', 'Retirement', 'Deceased', 'Other',
];

// Tracked fields (the HR-form fields whose change opens a reason-required row).
export const TRACKED_FIELDS = [
  { key: 'status',      label: 'Status' },
  { key: 'salary',      label: 'Pay',        money: true },
  { key: 'designation', label: 'Role' },
  { key: 'department',  label: 'Department' },
  { key: 'roster',      label: 'Roster' },
];

export const EXIT_STATUSES = ['inactive', 'terminated'];

// Suggest an action from the set of changed field keys. Mirrors the server.
export function suggestAction(changedKeys) {
  const s = new Set(changedKeys || []);
  if (s.has('status')) return 'Status Change';
  if (s.has('salary')) return 'Pay Revision';
  if (s.has('designation') || s.has('department')) return 'Transfer';
  if (s.has('roster')) return 'Roster Change';
  return 'Correction';
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
