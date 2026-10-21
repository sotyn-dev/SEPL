const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Run the real calculator with isolated data; never initialize the live database.
let sentEmails = [];
const routes = {};
const router = { use() {}, get(p, ...h) { routes['GET ' + p] = h.at(-1); },
  put(p, ...h) { routes['PUT ' + p] = h.at(-1); },
  post(p, ...h) { routes['POST ' + p] = h.at(-1); }, delete() {} };
const source = fs.readFileSync(path.join(__dirname, '../payroll.js'), 'utf8');
const context = { module: { exports: {} }, console, require(name) {
  if (name === 'express') return { Router: () => router };
  if (name === '../db/schema') return { getDb: () => activeDb };
  if (name === '../middleware/auth') return { requirePermission: () => () => {}, adminOnly() {}, authMiddleware() {} };
  if (name === '../middleware/audit') return { logAuditEvent() {} };
  if (name === '../lib/roster') return require('../../lib/roster');
  if (name === '../lib/email') return { sendEmail: async (opts) => { sentEmails.push(opts); return { success: true }; }, isConfigured: () => true };
  if (name === '../lib/numberToWords') return { rupeesInWords: () => 'Zero Rupees' };
  throw new Error(name);
} };
vm.runInNewContext(source + '\nmodule.exports = { calculateForEmployee, generateSalarySlipEmailContent, getEligiblePayrollEmployees };', context);
const calculate = context.module.exports.calculateForEmployee;
const generateSalarySlip = context.module.exports.generateSalarySlipEmailContent;
const getEligiblePayrollEmployees = context.module.exports.getEligiblePayrollEmployees;
let activeDb;
const settings = { late_after_time: '09:46', half_day_after_time: '10:00', min_hours_full_day: 6, min_hours_half_day: 2,
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
test('25 attended dates with 8 weekday late half-days (Sunday 10:01 not docked) give 21 payroll day equivalents', () => {
  const attendance = Array.from({ length: 25 }, (_, i) => ({ date: `2025-08-${String(i + 1).padStart(2, '0')}`,
    punch_in_time: i < 9 ? '10:01' : '09:30', total_hours: 10 }));
  const r = run({ attendance });
  assert.equal(r.present_days, 21);
  assert.equal(r.half_days, 8);
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

test('salary slip email content contains clear salary structure, attendance reconciliation, and formula', () => {
  const mockData = {
    employee_name: 'Vishesh Kumar',
    employee_id: 101,
    department: 'Operation',
    designation: 'Operations Executive',
    base_salary: 31000,
    total_days_in_month: 31,
    per_day_rate: 1000,
    paid_days: 28,
    gross_earned: 28000,
    basic_pay: 14000,
    conveyance: 4000,
    hra: 7000,
    adhoc: 3000,
    ot_hours: 10,
    ot_pay: 1200,
    food: 500,
    late_marks: 4,
    late_penalty: 300,
    advance: 1000,
    sunday_count: 4,
    paid_leaves: 1,
    holiday_days: 1,
    half_days: 2,
    absent_days: 1,
  };

  const { html, text, payPeriod } = generateSalarySlip(mockData, '2026-09', { id: 101, name: 'Vishesh Kumar' });

  assert.equal(payPeriod, 'September 2026');

  // Must contain monthly base and calendar days
  assert.ok(html.includes('Monthly Base Salary:'), 'HTML must include Monthly Base Salary');
  assert.ok(html.includes('31 Days'), 'HTML must include calendar days');
  assert.ok(html.includes('Per-Day Rate:'), 'HTML must include Per-Day Rate');
  assert.ok(html.includes('28 of 31 days'), 'HTML must include paid days ratio');

  // Must contain attendance reconciliation block
  assert.ok(html.includes('Attendance & Paid Days Reconciliation'), 'HTML must include Attendance Reconciliation block');
  assert.ok(html.includes('Present</th>'), 'HTML must have Present header');
  assert.ok(html.includes('Sunday / Off</th>'), 'HTML must have Sunday header');
  assert.ok(html.includes('Paid Leaves</th>'), 'HTML must have Paid Leaves header');
  assert.ok(html.includes('Absent (LOP)</th>'), 'HTML must have Absent header');

  // Must contain calculation formula
  assert.ok(html.includes('Payout Formula:'), 'HTML must include Payout Formula');
  assert.ok(html.includes('Net Payable:'), 'HTML must include Net Payable');

  // Plain text version checks
  assert.ok(text.includes('Monthly Base Salary: ₹31,000'), 'Text must include base salary');
  assert.ok(text.includes('Per-Day Calculation Rate: ₹1,000/day'), 'Text must include per day rate');
  assert.ok(text.includes('ATTENDANCE RECONCILIATION:'), 'Text must include attendance reconciliation section');
  assert.ok(text.includes('PAYOUT FORMULA:'), 'Text must include payout formula');
});

test('late shift (10:30 AM to 7:00 PM) treats 10:01 AM punch as full on-time day instead of half-day', () => {
  const attendance = [{ date: '2025-08-04', punch_in_time: '10:01', total_hours: 9 }];
  const generalEmp = run({ attendance }, { ...employee, roster: 'general' });
  assert.equal(generalEmp.half_days, 1, 'General shift punch at 10:01 AM must trigger half day');
  assert.equal(generalEmp.present_days, 0.5);

  const lateEmp = run({ attendance }, { ...employee, roster: 'late' });
  assert.equal(lateEmp.half_days, 0, 'Late shift punch at 10:01 AM must NOT trigger half day');
  assert.equal(lateEmp.present_days, 1);
});

test('salary slip email delivery targets strictly personal_email and never falls back to work email', async () => {
  sentEmails = [];
  let currentEmp = { id: 10, name: 'Ravi', email: 'ravi@company.com', personal_email: 'ravi@gmail.com', salary: 25000 };
  activeDb = {
    exec() {},
    prepare(sql) {
      return {
        all() { return []; },
        get() {
          if (sql.includes('FROM payroll_settings')) return settings;
          if (sql.includes('FROM employees')) return currentEmp;
          if (sql.includes('FROM payroll_runs')) return { c: 0 };
          return {};
        },
        run() {}
      };
    }
  };

  const res1 = { code: 200, status(n) { this.code = n; return this; }, json(v) { this.body = v; } };
  await routes['POST /send-slip/:employee_id']({ body: { month: '2025-08' }, params: { employee_id: '10' }, user: { id: 1 } }, res1);
  assert.equal(res1.code, 200);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, 'ravi@gmail.com', 'Must deliver to personal email');

  // When personal_email is missing, it must refuse rather than sending to work email
  sentEmails = [];
  currentEmp = { id: 10, name: 'Ravi', email: 'ravi@company.com', personal_email: null, salary: 25000 };
  const res2 = { code: 200, status(n) { this.code = n; return this; }, json(v) { this.body = v; } };
  await routes['POST /send-slip/:employee_id']({ body: { month: '2025-08' }, params: { employee_id: '10' }, user: { id: 1 } }, res2);
  assert.equal(res2.code, 400);
  assert.match(res2.body.error, /personal email/i);
  assert.equal(sentEmails.length, 0, 'Must NOT deliver to work email');
});

test('hour thresholds: <2h is absent, 2h-6h is half day, >=6h is full day, >9h is OT', () => {
  const customEmployee = { ...employee, ot_eligible: 1 };
  const r = run({
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:30', total_hours: 1.5 }, // Fri: <2h -> absent
      { date: '2025-08-02', punch_in_time: '09:30', total_hours: 3.5 }, // Sat: 2h-6h -> half day
      { date: '2025-08-04', punch_in_time: '09:30', total_hours: 7.0 }, // Mon: 6h-9h -> full day
      { date: '2025-08-05', punch_in_time: '09:30', total_hours: 11.0 }, // Tue: >9h -> full day + 2h OT
    ]
  }, customEmployee, settings);

  const day1 = r.breakdown.find(b => b.date === '2025-08-01');
  assert.equal(day1.label, 'absent_low_hours');
  assert.equal(day1.pay, 0);
  assert.equal(day1.hours, 1.5); // exact worked hours reported
  assert.equal(day1.ot_hours, 1.5); // OT credited because worked 1.5h (>=0.5h) and ot_eligible = 1

  const day2 = r.breakdown.find(b => b.date === '2025-08-02');
  assert.equal(day2.label, 'half_day_low_hours');
  assert.equal(day2.pay, 0.5);

  const day4 = r.breakdown.find(b => b.date === '2025-08-04');
  assert.equal(day4.label, 'present');
  assert.equal(day4.pay, 1);
  assert.equal(day4.ot_hours, 0);

  const day5 = r.breakdown.find(b => b.date === '2025-08-05');
  assert.equal(day5.label, 'present');
  assert.equal(day5.pay, 1);
  assert.equal(day5.ot_hours, 2);
  assert.equal(r.ot_hours, 3.5); // 1.5h from day 1 + 2h from day 5
});

test('Sundays have no late penalties or cutoffs regardless of punch in time', () => {
  // 2025-08-03 is Sunday. Punched at 11:30 AM (very late on weekdays) and worked 7h
  const r = run({
    attendance: [
      { date: '2025-08-03', punch_in_time: '11:30', total_hours: 7 },
    ]
  }, employee, settings);

  const sun = r.breakdown.find(b => b.date === '2025-08-03');
  assert.equal(sun.label, 'sunday_worked');
  assert.equal(sun.pay, 2); // full double pay
  assert.equal(r.late_marks, 0); // 0 late marks
  assert.equal(r.late_penalty, 0); // 0 late penalty
});

test('inactive employee: dates after exit_date are marked left_company with pay 0 and no absent deduction', () => {
  const inactiveEmp = { ...employee, exit_date: '2025-08-15' };
  const r = run({
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:30', total_hours: 8 },
      { date: '2025-08-02', punch_in_time: '09:30', total_hours: 8 },
    ]
  }, inactiveEmp, settings);

  const afterExit = r.breakdown.filter(b => b.label === 'left_company');
  // Days 16 to 31 in August = 16 days
  assert.equal(afterExit.length, 16);
  for (const b of afterExit) {
    assert.equal(b.pay, 0);
  }
  // Days 1-15: Aug 1 (P), Aug 2 (P), Aug 3 (Sun paid), Aug 4-9 (6 absent), Aug 10 (Sun paid), Aug 11-15 (5 absent)
  // Total absent days should only be from days 1 to 15 (11 days), NOT days 16-31
  assert.equal(r.absent_days, 11);
});

test('missed punch-out: up to 3 times per month counts as Full Day (Grace); 4th time counts 0 pay (absent)', () => {
  // August 2025: Aug 1 (Fri), Aug 4 (Mon), Aug 5 (Tue), Aug 6 (Wed) - all have punch_in but NO punch_out
  const r = run({
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:27', punch_out_time: null, total_hours: 0 }, // 1st missed out -> grace
      { date: '2025-08-04', punch_in_time: '09:30', punch_out_time: null, total_hours: 0 }, // 2nd missed out -> grace
      { date: '2025-08-05', punch_in_time: '09:15', punch_out_time: null, total_hours: 0 }, // 3rd missed out -> grace
      { date: '2025-08-06', punch_in_time: '09:20', punch_out_time: null, total_hours: 0 }, // 4th missed out -> absent (0 pay)
      { date: '2025-08-07', punch_in_time: '09:25', punch_out_time: '18:30', total_hours: 9.08 }, // punch out added -> normal present
    ]
  }, employee, settings);

  const day1 = r.breakdown.find(b => b.date === '2025-08-01');
  assert.equal(day1.label, 'missed_punch_out_grace');
  assert.equal(day1.pay, 1); // Full day

  const day2 = r.breakdown.find(b => b.date === '2025-08-04');
  assert.equal(day2.label, 'missed_punch_out_grace');
  assert.equal(day2.pay, 1); // Full day

  const day3 = r.breakdown.find(b => b.date === '2025-08-05');
  assert.equal(day3.label, 'missed_punch_out_grace');
  assert.equal(day3.pay, 1); // Full day

  const day4 = r.breakdown.find(b => b.date === '2025-08-06');
  assert.equal(day4.label, 'missed_punch_out_absent');
  assert.equal(day4.pay, 0); // Absent (exceeded grace)

  const day5 = r.breakdown.find(b => b.date === '2025-08-07');
  assert.equal(day5.label, 'present');
  assert.equal(day5.pay, 1);

  assert.equal(r.missed_punch_out_count, 4);
  assert.equal(r.missed_punch_out_grace, 3);
});

test('worked hours under 2h: credits OT only if worked >= 0.5h and employee is ot_eligible; exact worked hours reported', () => {
  // Employee 1: ot_eligible = 1
  const otEmp = { ...employee, ot_eligible: 1 };
  const r1 = run({
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:00', punch_out_time: '10:12', total_hours: 1.2 }, // 1.2h: >=0.5h and <2h -> OT
      { date: '2025-08-04', punch_in_time: '09:00', punch_out_time: '09:20', total_hours: 0.33 }, // 0.33h: <0.5h -> No OT
    ]
  }, otEmp, settings);

  const b1 = r1.breakdown.find(b => b.date === '2025-08-01');
  assert.equal(b1.label, 'absent_low_hours');
  assert.equal(b1.pay, 0);
  assert.equal(b1.hours, 1.2);
  assert.equal(b1.ot_hours, 1.2);

  const b2 = r1.breakdown.find(b => b.date === '2025-08-04');
  assert.equal(b2.label, 'absent_low_hours');
  assert.equal(b2.pay, 0);
  assert.equal(b2.hours, 0.33);
  assert.equal(b2.ot_hours, 0);

  assert.equal(r1.ot_hours, 1.2);

  // Employee 2: ot_eligible = 0
  const nonOtEmp = { ...employee, ot_eligible: 0 };
  const r2 = run({
    attendance: [
      { date: '2025-08-01', punch_in_time: '09:00', punch_out_time: '10:12', total_hours: 1.2 },
    ]
  }, nonOtEmp, settings);

  const b3 = r2.breakdown.find(b => b.date === '2025-08-01');
  assert.equal(b3.label, 'absent_low_hours');
  assert.equal(b3.pay, 0);
  assert.equal(b3.hours, 1.2);
  assert.equal(b3.ot_hours, 0); // No OT because not ot_eligible
  assert.equal(r2.ot_hours, 0);
});

test('Sunday worked between 2h and 6h pays 1.5 days (half day + Sunday paid)', () => {
  // 2025-08-03 is Sunday. Worked 3.64 hours (between 2h and 6h)
  const r = run({
    attendance: [
      { date: '2025-08-03', punch_in_time: '10:00', punch_out_time: '13:38', total_hours: 3.64 },
    ]
  }, employee, settings);

  const sun = r.breakdown.find(b => b.date === '2025-08-03');
  assert.equal(sun.label, 'sunday_half_day');
  assert.equal(sun.pay, 1.5); // 0.5 half-day work + 1.0 Sunday paid = 1.5
  assert.equal(sun.sunday_bonus, 0.5);
  assert.equal(sun.sunday_worked, true);
});

test('getEligiblePayrollEmployees: excludes historical inactive employees with null exit_date, includes month exits and attendees', () => {
  const Database = require('better-sqlite3');
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, staff_type TEXT);
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY, user_id INTEGER, name TEXT, department TEXT, designation TEXT,
      join_date TEXT, exit_date TEXT, status TEXT, salary REAL, ot_eligible INTEGER,
      cl_eligible INTEGER, cl_opening_balance REAL, roster TEXT, email TEXT, personal_email TEXT
    );
    CREATE TABLE payroll_runs (id INTEGER PRIMARY KEY, month TEXT, employee_id INTEGER);
    CREATE TABLE attendance (id INTEGER PRIMARY KEY, user_id INTEGER, date TEXT, punch_in_time TEXT, admin_marked INTEGER);

    -- 1. Active employee
    INSERT INTO employees (id, user_id, name, status, salary, join_date) VALUES (1, 101, 'Active Emp', 'active', 20000, '2025-01-01');

    -- 2. Historical inactive employee with exit_date NULL and no attendance (the 118 records case)
    INSERT INTO employees (id, user_id, name, status, salary, join_date, exit_date) VALUES (2, 102, 'Historical Inactive', 'inactive', 25000, '2024-01-01', NULL);

    -- 3. Inactive employee who exited in September 2025
    INSERT INTO employees (id, user_id, name, status, salary, join_date, exit_date) VALUES (3, 103, 'Sept Exited Emp', 'inactive', 30000, '2025-01-01', '2025-09-28');
    -- Attended in September
    INSERT INTO attendance (user_id, date, punch_in_time) VALUES (103, '2025-09-15', '09:30');

    -- 4. Inactive employee who exited during October 2025
    INSERT INTO employees (id, user_id, name, status, salary, join_date, exit_date) VALUES (4, 104, 'Oct Exited Emp', 'inactive', 35000, '2025-01-01', '2025-10-10');
  `);

  // October 2025:
  const octList = getEligiblePayrollEmployees(db, '2025-10');
  const octNames = octList.map(e => e.name);

  // Active Emp should be included
  assert.ok(octNames.includes('Active Emp'), 'Active employee must be in October');

  // Historical Inactive (null exit_date, no attendance) must be EXCLUDED
  assert.ok(!octNames.includes('Historical Inactive'), 'Historical inactive employee must NOT be in October');

  // Sept Exited Emp has exit_date in Sept and NO attendance in Oct -> must be EXCLUDED
  assert.ok(!octNames.includes('Sept Exited Emp'), 'September exited employee must NOT be in October');

  // Oct Exited Emp exited during October (2025-10-10) -> must be INCLUDED
  assert.ok(octNames.includes('Oct Exited Emp'), 'October exited employee must be in October for final settlement');

  // September 2025:
  const septList = getEligiblePayrollEmployees(db, '2025-09');
  const septNames = septList.map(e => e.name);

  // Sept Exited Emp worked in September -> must be INCLUDED in September
  assert.ok(septNames.includes('Sept Exited Emp'), 'September exited employee must be in September');
  // Historical Inactive still excluded
  assert.ok(!septNames.includes('Historical Inactive'), 'Historical inactive employee must NOT be in September');
});



