// Company-configured estimates only: no statutory rates are assumed or seeded.
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS employee_pt_rules (
    id INTEGER PRIMARY KEY, state TEXT NOT NULL, min_salary REAL NOT NULL,
    max_salary REAL, amount REAL NOT NULL, month INTEGER NOT NULL DEFAULT 0,
    effective_from TEXT NOT NULL, effective_to TEXT
  )`);
}
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
function validateRules(input, states) {
  if (!Array.isArray(input) || input.length > 500) throw new Error('Provide up to 500 PT slabs');
  const rules = input.map(r => {
    if (!r || !states.includes(r.state)) throw new Error('Select a valid PT state');
    const number = (value, label) => {
      if (!['number', 'string'].includes(typeof value) || String(value).trim() === '') throw new Error(`Enter ${label}`);
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) throw new Error(`${label} must be zero or greater`);
      return n;
    };
    const out = { state: r.state, min_salary: number(r.min_salary, 'Minimum salary'),
      max_salary: r.max_salary === '' || r.max_salary == null ? null : number(r.max_salary, 'Maximum salary'),
      amount: number(r.amount, 'PT amount'), month: number(r.month, 'Calendar month'),
      effective_from: r.effective_from, effective_to: r.effective_to || null };
    if (!Number.isInteger(out.month) || out.month > 12) throw new Error('Calendar month must be 0–12');
    if (out.max_salary != null && out.max_salary <= out.min_salary) throw new Error('Maximum salary must exceed minimum salary');
    if (!MONTH.test(out.effective_from) || (out.effective_to && (!MONTH.test(out.effective_to) || out.effective_to < out.effective_from))) throw new Error('Enter a valid effective month range');
    return out;
  });
  rules.forEach((r, i) => rules.slice(i + 1).forEach(s => {
    // A specific calendar month intentionally overrides an all-month rule.
    if (r.state === s.state && r.month === s.month &&
      r.min_salary < (s.max_salary ?? Infinity) && s.min_salary < (r.max_salary ?? Infinity) &&
      r.effective_from <= (s.effective_to || '9999-12') && s.effective_from <= (r.effective_to || '9999-12')) {
      throw new Error(`Overlapping PT slabs for ${r.state}`);
    }
  }));
  return rules;
}
function calculate(rules, state, salary, month) {
  if (!MONTH.test(month || '')) throw new Error('Select a valid calculation month');
  if (state === 'Not applicable') return { amount: 0, note: 'Not applicable' };
  if (!state) return { amount: null, note: 'Select PT State' };
  if (salary === '' || salary == null || !Number.isFinite(Number(salary)) || Number(salary) < 0) return { amount: null, note: 'Enter the existing monthly Salary amount' };
  const matches = rules.filter(r => r.state === state && Number(salary) >= r.min_salary &&
    (r.max_salary == null || Number(salary) < r.max_salary) &&
    (!r.month || r.month === Number(month.slice(5))) &&
    r.effective_from <= month && (!r.effective_to || r.effective_to >= month));
  const specific = matches.filter(r => r.month !== 0);
  const selected = specific.length ? specific : matches;
  if (selected.length !== 1) return { amount: null, note: selected.length ? 'Conflicting PT slabs: contact Payroll admin' : 'No matching PT slab configured in Payroll → Rules / Settings' };
  return { amount: Math.round(selected[0].amount * 100) / 100, note: 'Calculated from configured slabs using the existing Salary amount' };
}
module.exports = { initialize, validateRules, calculate };
