// Single-row / list "full employee" reads — joins the employee_statutory and
// employee_compensation satellite tables back onto `employees` so every
// consumer keeps seeing ONE flat row, byte-identical to when these columns
// lived directly on `employees` (see hrSchema.js's satellite-split comment,
// dme 2026-08-04: "so many columns in employee table, can some relational
// linked sub tables make efficient for us?").
//
// This is the ONLY place that knows the join exists — hr.js, employeeTimeline.js,
// employeeValidation.js, redactStatutory/redactCompensation all keep reading
// `row.pan_number` / `row.ctc_annual` etc. off a plain object exactly as before.

const STATUTORY_COLS = [
  'aadhar_number', 'aadhar_last4', 'pan_number', 'uan_number', 'pf_number', 'esi_number',
  'bank_name', 'bank_branch', 'bank_account_number', 'ifsc_code', 'pt_state',
];
const COMPENSATION_COLS = [
  'ctc_annual', 'fixed_monthly_gross', 'variable_bonus', 'basic_pay', 'hra', 'special_allowance',
  'pf_deduction', 'esi_deduction', 'professional_tax', 'tds_estimated_annual', 'reimbursements',
  'bonus_target_pct', 'last_increment_date', 'salary_review_cycle',
];

// `e.*` first so any satellite column re-listed below (there are none today,
// but this keeps the precedence obvious) always wins — satellite values are
// the source of truth for these keys.
const FULL_SELECT_LIST = [
  'e.*',
  ...STATUTORY_COLS.map((c) => `st.${c} AS ${c}`),
  ...COMPENSATION_COLS.map((c) => `cp.${c} AS ${c}`),
].join(', ');

const FULL_JOIN_SQL = `
  LEFT JOIN employee_statutory st ON st.employee_id = e.id
  LEFT JOIN employee_compensation cp ON cp.employee_id = e.id
`;

// Drop-in replacement for `SELECT * FROM employees WHERE id=?`.
function getEmployeeFull(db, id) {
  return db.prepare(`SELECT ${FULL_SELECT_LIST} FROM employees e ${FULL_JOIN_SQL} WHERE e.id = ?`).get(id);
}

module.exports = { getEmployeeFull, STATUTORY_COLS, COMPENSATION_COLS, FULL_SELECT_LIST, FULL_JOIN_SQL };
