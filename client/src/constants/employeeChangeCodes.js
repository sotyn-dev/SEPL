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
  // Phase 5 — career-event fields, mirrors server/lib/employeeFields.js.
  { key: 'grade',                    label: 'Grade' },
  { key: 'employment_type',          label: 'Employment type' },
  { key: 'probation_end_date',       label: 'Probation end date' },
  { key: 'confirmation_status',      label: 'Confirmation status' },
  { key: 'notice_period_days',       label: 'Notice period' },
  { key: 'reports_to_employee_id',   label: 'Reports to' },
  // Statutory/Compliance pack (Module 1, 2026-08-04) — mirrors
  // server/lib/employeeFields.js. `sensitive` fields never carry a real
  // before/after value here — see computeChanges()'s special-casing below —
  // only whether the field was touched at all.
  { key: 'bank_name',            label: 'Bank name' },
  { key: 'bank_branch',          label: 'Bank branch' },
  { key: 'ifsc_code',            label: 'IFSC code' },
  { key: 'pt_state',             label: 'PT state' },
  { key: 'uan_number',           label: 'UAN' },
  { key: 'pf_number',            label: 'PF number' },
  { key: 'esi_number',           label: 'ESI number' },
  { key: 'bank_account_number',  label: 'Bank account number', sensitive: true },
  { key: 'aadhar_number',        label: 'Aadhaar number',      sensitive: true },
  // Compensation pack (Module 2, 2026-08-04) — mirrors
  // server/lib/employeeFields.js. None are `sensitive`: gated at the tab
  // level via canSeeSalary instead (see fmtChip's `money` masking below,
  // reused as-is for these 11 money fields).
  { key: 'ctc_annual',           label: 'CTC annual',              money: true },
  { key: 'fixed_monthly_gross',  label: 'Fixed monthly gross',     money: true },
  { key: 'variable_bonus',       label: 'Variable / bonus',        money: true },
  { key: 'basic_pay',            label: 'Basic pay',               money: true },
  { key: 'hra',                  label: 'HRA',                     money: true },
  { key: 'special_allowance',    label: 'Special allowance',       money: true },
  { key: 'pf_deduction',         label: 'PF deduction',            money: true },
  { key: 'esi_deduction',        label: 'ESI deduction',           money: true },
  { key: 'professional_tax',     label: 'Professional tax',        money: true },
  { key: 'tds_estimated_annual', label: 'TDS estimated annual',    money: true },
  { key: 'reimbursements',       label: 'Reimbursements',          money: true },
  { key: 'bonus_target_pct',     label: 'Bonus/variable target %' },
  { key: 'last_increment_date',  label: 'Last increment date' },
  { key: 'salary_review_cycle',  label: 'Salary review cycle' },
  // Assets pack (Module 3, 2026-08-04) — mirrors server/lib/employeeFields.js.
  // Plain equipment tags, no money/sensitive flags.
  { key: 'laptop_asset_tag', label: 'Laptop asset tag' },
  { key: 'mobile_asset_tag', label: 'Mobile asset tag' },
  { key: 'vehicle_allotted', label: 'Vehicle allotted' },
  { key: 'sim_card_number',  label: 'SIM card number' },
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
  // Mirrors server/lib/employeeChangeCodes.js's Phase 5 widening.
  if (s.has('grade')) return 'Promotion';
  // Mirrors server/lib/employeeChangeCodes.js — user_id (linked login) is
  // its own Workspace section, always saved alone, one unambiguous label.
  if (s.has('user_id')) return 'Access Change';
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
    // Sensitive fields never round-trip a real value into `form[key]` directly
    // (the server only ever sends a masked display string, see redactStatutory
    // in server/routes/hr.js) — an edit is entered into a separate shadow key
    // instead (`_<key>_edit`, see StatutorySection.jsx), and "changed" means
    // "the shadow was actually typed into", not a before/after comparison.
    // EXCEPTION: bank_account_number's real value IS sent to holders of
    // employee_statutory.can_view — for them it behaves like any other field.
    if (f.key === 'aadhar_number') {
      if (form._aadhar_number_edit) out.push({ ...f, from: '••••', to: '••••' });
      continue;
    }
    if (f.key === 'bank_account_number' && form.bank_account_number === undefined) {
      if (form._bank_account_number_edit) out.push({ ...f, from: '••••', to: '••••' });
      continue;
    }
    const a = form[f.key], b = original[f.key];
    const changed = f.money
      ? Number(a || 0) !== Number(b || 0)
      : norm(a) !== norm(b);
    if (changed) out.push({ ...f, from: b, to: a });
  }
  return out;
}
