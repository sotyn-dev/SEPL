const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real calculator with isolated data; never initialize the live database.
const routes = {};
const router = { use() {}, get(p, ...h) { routes['GET ' + p] = h.at(-1); },
  put(p, ...h) { routes['PUT ' + p] = h.at(-1); }, post() {}, delete() {} };
const source = fs.readFileSync(path.join(__dirname, '../payroll.js'), 'utf8');
const context = { module: { exports: {} }, console, require(name) {
  if (name === 'express') return { Router: () => router };
  if (name === '../db/schema') return { getDb: () => activeDb };
  if (name === '../middleware/auth') return { requirePermission: () => () => {}, adminOnly() {}, authMiddleware() {} };
  if (name === '../middleware/audit') return { logAuditEvent() {} };
  if (name === '../lib/roster') return require('../../lib/roster');
  throw new Error(name);
} };
vm.runInNewContext(source + '\nmodule.exports = { calculateForEmployee };', context);
const calculate = context.module.exports.calculateForEmployee;
let activeDb;
const settings = { late_after_time: '09:46', half_day_after_time: '10:00', min_hours_half_day: 4,
  sundays_paid: 1, late_grace_count: 3, late_per_minute_rate: 20, lates_to_absent: 0,
  working_days_per_month: 26, ot_threshold_hours: 9, basic_pct: 100 };
const employee = { id: 1, user_id: 1, name: 'Example', salary: 31000, join_date: '2025-01-01' };
function fixture({ attendance = [], holidays = [], leaves = [], adjustments = {}, locked = false } = {}) {
  return { exec() {}, prepare(sql) {
    return { all() {
      if (sql.includes('FROM attendance')) return attendance;
      if (sql.includes('FROM leave_requests')) return leaves;
      if (sql.includes('FROM payroll_holidays')) return holidays;
      throw new Error(sql);
    }, get() {
      if (sql.includes('FROM payroll_advances')) return adjustments;
      if (sql.includes('FROM employees')) return { id: 1 };
      if (sql.includes('FROM payroll_runs')) return { c: locked ? 1 : 0 };
      throw new Error(sql);
    }, run(month, id, value) {
      if (sql.includes('INSERT INTO payroll_advances')) { adjustments.late_penalty_override = value; return; }
      throw new Error(sql);
    } };
  } };
}
function run(options, emp = employee, rules = settings) { return calculate(fixture(options), rules, emp, '2025-08'); }
const holiday = [{ date: '2025-08-15', name: 'Independence Day' }];
test('holiday eligibility includes joining day, excludes every pre-joining date without absence', () => {
  assert.equal(run({ holidays: holiday }, { ...employee, join_date: '2025-08-15' }).holiday_days, 1);
  const r = run({ holidays: holiday }, { ...employee, join_date: '2025-08-16' });
  assert.equal(r.holiday_days, 0);
  assert.equal(r.breakdown.filter(b => b.label === 'not_joined').length, 15);
  assert.equal(r.absent_days, 13);
  assert.equal(r.breakdown.find(b => b.date === '2025-08-15').pay, 0);
});
test('pre-joining attendance and leave cannot generate pay or penalties', () => {
  const r = run({ holidays: holiday, attendance: [{ date: '2025-08-14', punch_in_time: '09:55', total_hours: 10 }],
    leaves: [{ from_date: '2025-08-01', to_date: '2025-08-02', leave_type: 'casual' }] }, { ...employee, join_date: '2025-09-01' });
  for (const key of ['paid_days', 'holiday_days', 'sunday_count', 'absent_days', 'half_days', 'late_marks', 'paid_leaves']) assert.equal(r[key], 0, key);
});
test('a pre-joining Saturday does not make the joining Sunday sandwiched absence', () => {
  const r = run({}, { ...employee, join_date: '2025-08-17' });
  assert.equal(r.breakdown.find(b => b.date === '2025-08-17').label, 'sunday_paid');
});
test('25 attended dates with 9 late half-days give 20.5 payroll day equivalents', () => {
  const attendance = Array.from({ length: 25 }, (_, i) => ({ date: `2025-08-${String(i + 1).padStart(2, '0')}`,
    punch_in_time: i < 9 ? '10:01' : '09:30', total_hours: 10 }));
  const r = run({ attendance });
  assert.equal(r.present_days, 20.5);
  assert.equal(r.half_days, 9);
});
test('late deductions remain automatic even with a saved manual override', () => {
  const options = { attendance: [{ date: '2025-08-04', punch_in_time: '09:50', total_hours: 10 }], adjustments: {} };
  const rules = { ...settings, late_grace_count: 0 };
  const auto = run(options, employee, rules);
  assert.equal(auto.late_penalty, 100);
  for (const override of [0, 500, null]) {
    options.adjustments.late_penalty_override = override;
    const r = run(options, employee, rules);
    assert.equal(r.late_penalty, 100);
    assert.equal(r.late_penalty_overridden, false);
    assert.equal(r.net_pay, auto.net_pay);
  }
});
test('late override endpoint refuses manual late amounts', () => {
  activeDb = fixture();
  const res = { code: 200, status(n) { this.code = n; return this; }, json(v) { this.body = v; } };
  routes['PUT /override/:employee_id']({ body: { month: '2025-08', field: 'late_penalty', value: 0 }, params: { employee_id: '1' }, user: { id: 1 } }, res);
  assert.equal(res.code, 400);
  assert.match(res.body.error, /automatic/);
});

test('payroll export includes displayed totals and adjustments without recalculating snapshots', () => {
  const jsx = fs.readFileSync(path.join(__dirname, '../../../client/src/pages/Payroll.jsx'), 'utf8');
  const start = jsx.indexOf('export function buildPayrollExport');
  const end = jsx.indexOf('const monthNow', start);
  const exportContext = { staffTypeLabel: (t) => t || 'Staff' };
  vm.runInNewContext(jsx.slice(start, end).replace('export function', 'function'), exportContext);
  const { headers, rows } = exportContext.buildPayrollExport([
    { employee_name: 'Gagan', present_days: 20.5, sunday_count: 0, sunday_worked_pay: 3, half_days: 9,
      paid_leaves: 1, holiday_days: 2, paid_days: 26.5, base_salary: 45000,
      late_penalty: 0, late_penalty_auto: 1040, late_penalty_overridden: true,
      advance: 500, food: 200, net_pay: 40000, ot_pay: 1000, locked: true, paid: true },
    { employee_name: 'Old snapshot', paid_days: 20, net_pay: 15000, locked: true },
  ], '2025-08');
  const cell = label => rows[0][headers.indexOf(label)];
  assert.equal(headers.length, new Set(headers).size);
  assert.equal(rows[0].length, headers.length);
  assert.equal(cell('Present (paid equivalents)'), 20.5);
  assert.equal(cell('Sunday (including worked bonus)'), 3);
  assert.equal(cell('Holidays'), 2);
  assert.equal(cell('Half Days'), 9);
  assert.equal(cell('Late Deduction (Rs)'), 0);
  assert.equal(cell('Late Deduction Auto (Rs)'), 1040);
  assert.equal(headers.includes('Late Deduction Adjusted'), false);
  assert.equal(cell('Salary Before OT (Rs)'), 39000);
  assert.equal(cell('Net Pay (Rs)'), 40000);
  assert.equal(cell('Payment Status'), 'Paid');
  assert.equal(rows[1][headers.indexOf('Present (paid equivalents)')], '');
  assert.equal(rows[1][headers.indexOf('Net Pay (Rs)')], 15000);
});
test('working on Sunday earns double pay (present day + sunday bonus)', () => {
  // 2025-08-03 is a Sunday
  const options = {
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:30', total_hours: 9 }, // Fri
      { date: '2025-08-02', punch_in_time: '09:30', total_hours: 9 }, // Sat
      { date: '2025-08-03', punch_in_time: '09:30', total_hours: 9 }, // Sun worked
      { date: '2025-08-04', punch_in_time: '09:30', total_hours: 9 }, // Mon
    ],
  };
  const res = run(options, employee, settings);
  assert.equal(res.sunday_worked, 1);
  assert.equal(res.sunday_worked_pay, 1);
  const sunRow = res.breakdown.find(b => b.date === '2025-08-03');
  assert.equal(sunRow.label, 'sunday_worked');
  assert.equal(sunRow.pay, 2);
  assert.equal(sunRow.sunday_bonus, 1);
  assert.equal(sunRow.sunday_worked, true);
});

test('applied leave overridden by attendance: pays according to attendance and preserves leave quota', () => {
  // Employee applied for casual leave on 2025-08-04 and 2025-08-05
  // Punches in on 2025-08-04, but absent on 2025-08-05
  const options = {
    leaves: [
      { from_date: '2025-08-04', to_date: '2025-08-04', leave_type: 'casual', status: 'approved' },
      { from_date: '2025-08-05', to_date: '2025-08-05', leave_type: 'casual', status: 'approved' },
    ],
    attendance: [
      { date: '2025-08-04', punch_in_time: '09:30', total_hours: 9 },
    ],
  };
  const rules = { ...settings, cl_per_month: 1 };
  const res = run(options, employee, rules);
  const attendedRow = res.breakdown.find(b => b.date === '2025-08-04');
  assert.equal(attendedRow.label, 'present');
  assert.equal(attendedRow.pay, 1);
  assert.equal(attendedRow.applied_leave, 'casual');

  const absentLeaveRow = res.breakdown.find(b => b.date === '2025-08-05');
  assert.equal(absentLeaveRow.label, 'paid_casual_leave');
  assert.equal(absentLeaveRow.pay, 1);
  assert.equal(res.cl_used, 1); // Only the un-attended day consumed the 1 available CL
});
test('calendar Sundays remain integer count (4 or 5) and never fractional when Sunday is worked', () => {
  // Build attendance for all working days (Mon-Sat) in August 2025 (26 weekdays, 5 Sundays)
  const allWorkDays = [];
  for (let d = 1; d <= 31; d++) {
    const dt = new Date(2025, 7, d);
    const day = dt.getDay();
    const dStr = `2025-08-${String(d).padStart(2, '0')}`;
    if (day !== 0) { // Mon-Sat
      allWorkDays.push({ date: dStr, punch_in_time: '09:30', total_hours: 9 });
    }
  }

  // 1. Full day worked on Sunday Aug 3
  const resFull = run({
    attendance: [...allWorkDays, { date: '2025-08-03', punch_in_time: '09:30', total_hours: 9 }],
  }, employee, settings);
  assert.equal(resFull.sunday_count, 5); // Must be full 5 Sundays, NOT 4
  assert.equal(resFull.present_days, 27); // 26 weekdays + 1 Sunday
  assert.equal(resFull.paid_days, 32); // 27 + 5 = 32

  // 2. Half day worked on Sunday Aug 3
  const resHalf = run({
    attendance: [...allWorkDays, { date: '2025-08-03', punch_in_time: '10:30', total_hours: 3 }],
  }, employee, settings);
  assert.equal(resHalf.sunday_count, 5); // Must be full 5 Sundays, NOT 4 and NEVER 3.5 or 4.5
  assert.equal(resHalf.present_days, 26.5); // 26 weekdays + 0.5 Sunday
  assert.equal(resHalf.paid_days, 31.5); // 26.5 + 5 = 31.5
});
