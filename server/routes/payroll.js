// Payroll auto-calculator. Reads rules from the payroll_settings table and
// computes per-employee monthly salary by walking each day of the month
// and applying:
//   - Sunday handling (paid / unpaid per setting)
//   - Approved leaves (CL / SL / PL paid up to allowance, LWP unpaid)
//   - Short leave (skips half-day deduction if setting enabled)
//   - Attendance (no punch = absent, late punch = late mark / half day,
//     low hours = half day / absent, overtime hours)
//   - N lates → 1 absent (configurable)
// Everything is recalculated live unless a run is "finalised" — then we
// return the snapshot from payroll_runs so historical slips don't drift.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');

router.use(authMiddleware);

// ---------- helpers ----------

function ensureSettingsRow(db) {
  const row = db.prepare('SELECT id FROM payroll_settings WHERE id=1').get();
  if (!row) {
    db.prepare(`INSERT INTO payroll_settings (id) VALUES (1)`).run();
  }
}

function getSettings(db) {
  ensureSettingsRow(db);
  return db.prepare('SELECT * FROM payroll_settings WHERE id=1').get();
}

function daysInMonth(month) {
  // month = "YYYY-MM"
  const [y, m] = month.split('-').map(Number);
  return new Date(y, m, 0).getDate();
}

function isSunday(year, month, day) {
  return new Date(year, month - 1, day).getDay() === 0;
}

function pad(n) { return String(n).padStart(2, '0'); }

// Parse "HH:MM" / "HH:MM:SS" / ISO datetime → minutes since midnight
function timeToMinutes(t) {
  if (!t) return null;
  // ISO datetime?
  if (t.includes('T') || t.includes(' ')) {
    const d = new Date(t);
    if (isNaN(d)) return null;
    return d.getHours() * 60 + d.getMinutes();
  }
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// ---------- routes ----------

// GET current settings
router.get('/settings', (req, res) => {
  try {
    res.json(getSettings(getDb()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT update settings (admin only)
router.put('/settings', adminOnly, (req, res) => {
  const db = getDb();
  ensureSettingsRow(db);
  const fields = [
    'late_after_time','half_day_after_time','min_hours_full_day','min_hours_half_day',
    'skip_half_day_if_short_leave','lates_to_absent','late_grace_count','late_per_minute_rate',
    'working_days_per_month','sundays_paid',
    'cl_per_month','sl_per_month','pl_per_month','short_leave_per_month',
    'ot_threshold_hours','ot_rate_multiplier','pay_cycle_start_day',
    'basic_pct','conveyance_pct','hra_pct','adhoc_pct','misc_pct'
  ];
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (req.body[f] !== undefined) {
      sets.push(`${f} = ?`);
      vals.push(req.body[f]);
    }
  }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  vals.push(req.user.id);
  db.prepare(`UPDATE payroll_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  res.json({ message: 'Settings updated', settings: getSettings(db) });
});

// Core calculator — runs for one employee for one month, returns full breakdown.
function calculateForEmployee(db, settings, employee, month) {
  const [year, mm] = month.split('-').map(Number);
  const totalDays = daysInMonth(month);

  // ─── Salary-exempt short-circuit (mam 2026-06-01) ────────────────
  // "this person every month make salary full" — Parul Goyal, Rajat
  // Sir, Nitin Jain, Ankur Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma
  // Kaplesh.  When employees.salary_exempt=1, we bypass every
  // attendance / late / leave deduction and return the full base
  // salary as net pay.  Earnings split still respects the BASIC /
  // CONVEYANCE / HRA / Adhoc / Misc percentages from settings so the
  // slip stays compliant.  Future months still return 0 — no advance
  // payout — admin-marked exempt rows still respect time.
  if (employee.salary_exempt) {
    const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
    const tY = istNow.getUTCFullYear(), tM = istNow.getUTCMonth() + 1;
    const isFuture = year > tY || (year === tY && mm > tM);
    const baseSalary = employee.salary || 0;
    const grossEarned = isFuture ? 0 : baseSalary;
    const basicPay  = round2(grossEarned * (settings.basic_pct       || 0) / 100);
    const conveyance = round2(grossEarned * (settings.conveyance_pct || 0) / 100);
    const hra       = round2(grossEarned * (settings.hra_pct         || 0) / 100);
    const adhoc     = round2(grossEarned * (settings.adhoc_pct       || 0) / 100);
    const misc      = round2(grossEarned * (settings.misc_pct        || 0) / 100);
    return {
      employee_id: employee.id,
      employee_name: employee.name,
      department: employee.department,
      designation: employee.designation,
      join_date: employee.join_date,
      base_salary: baseSalary,
      per_day_rate: round2(settings.working_days_per_month > 0 ? baseSalary / settings.working_days_per_month : 0),
      working_days: settings.working_days_per_month,
      total_days_in_month: totalDays,
      days_counted: totalDays,
      is_current_month: (year === tY && mm === tM),
      is_future_month: isFuture,
      user_linked: !!employee.user_id,
      user_id: employee.user_id || null,
      salary_exempt: 1,
      salary_exempt_reason: 'Full salary regardless of attendance (mam directive)',
      paid_days: isFuture ? 0 : settings.working_days_per_month,
      half_days: 0, absent_days: 0,
      late_marks: 0, lates_converted_absent: 0, late_penalty: 0, late_days: [],
      paid_leaves: 0, unpaid_leaves: 0, sunday_count: 0,
      ot_hours: 0, ot_pay: 0,
      gross_earned: grossEarned,
      basic_pay: basicPay, conveyance, hra, adhoc, misc,
      total_earnings: round2(basicPay + conveyance + hra + adhoc + misc),
      total_deductions: 0, deductions: 0,
      net_pay: grossEarned,
      cl_used: 0, sl_used: 0, pl_used: 0, short_leave_used: 0,
      breakdown: [{ date: month + '-01', day: '—', label: 'salary_exempt', pay: 0, note: 'Flat monthly salary; daily breakdown not applicable' }],
    };
  }

  // Don't penalise employees for days that haven't happened yet. For the
  // CURRENT month, stop the day-loop at today's date so May 5-31 (still in
  // the future on May 4) aren't counted as absent. Past months use all
  // days. Future months return zero everything.
  // Use IST (UTC+5:30) regardless of server timezone — Hostinger VPS runs
  // UTC by default, which would mark days as 'future' for ~5.5 hours after
  // midnight IST.
  const istNow = new Date(Date.now() + (5.5 * 60 * 60 * 1000));
  const todayY = istNow.getUTCFullYear();
  const todayM = istNow.getUTCMonth() + 1;
  const todayD = istNow.getUTCDate();
  let lastDay = totalDays;
  if (year > todayY || (year === todayY && mm > todayM)) {
    lastDay = 0; // future month — nothing to calc yet
  } else if (year === todayY && mm === todayM) {
    lastDay = todayD; // current month — only up to today
  }

  // Resolve the user_id for this employee. Many HR employee rows were
  // created from candidates / manual entry without a login linkage, so
  // employee.user_id is NULL. Without a user_id, attendance / leaves
  // can't be looked up and every day looks 'absent'. Fall back to matching
  // by name (case-insensitive, trimmed) — and once found, persist the
  // linkage so the next run is fast.
  let userId = employee.user_id;
  if (!userId && employee.name) {
    const nameMatch = db.prepare(
      `SELECT id FROM users WHERE LOWER(TRIM(name)) = LOWER(TRIM(?)) AND active != 0 LIMIT 1`
    ).get(employee.name);
    if (nameMatch) {
      userId = nameMatch.id;
      try { db.prepare('UPDATE employees SET user_id = ? WHERE id = ?').run(userId, employee.id); } catch (e) { /* ignore */ }
    }
  }

  // Pull all attendance rows for this month at once
  const startDate = `${month}-01`;
  const endDate = `${month}-${pad(totalDays)}`;
  const attRows = userId
    ? db.prepare(`SELECT date, punch_in_time, punch_out_time, total_hours, status
                  FROM attendance WHERE user_id = ? AND date BETWEEN ? AND ?`).all(userId, startDate, endDate)
    : [];
  const attByDate = {};
  for (const r of attRows) attByDate[r.date] = r;

  // Pull approved leaves overlapping this month
  const leaveRows = userId
    ? db.prepare(`SELECT leave_type, from_date, to_date, days, hours
                  FROM leave_requests
                  WHERE user_id = ? AND status='approved'
                    AND NOT (to_date < ? OR from_date > ?)`).all(userId, startDate, endDate)
    : [];

  // Track allowance usage
  let clUsed = 0, slUsed = 0, plUsed = 0, shortLeaveUsed = 0;

  // Build per-day map of leave type
  const leaveByDate = {}; // date → leave_type ('casual','sick','earned','short_leave','comp_off')
  const shortLeaveByDate = {}; // date → true if short leave applied that day
  for (const lr of leaveRows) {
    const from = new Date(lr.from_date);
    const to = new Date(lr.to_date);
    for (let d = new Date(from); d <= to; d.setDate(d.getDate() + 1)) {
      const dateStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      if (dateStr < startDate || dateStr > endDate) continue;
      if (lr.leave_type === 'short_leave') {
        shortLeaveByDate[dateStr] = true;
      } else {
        leaveByDate[dateStr] = lr.leave_type;
      }
    }
  }

  let paidDays = 0, halfDays = 0, absentDays = 0, lateMarks = 0;
  let paidLeaves = 0, unpaidLeaves = 0, sundayCount = 0, otHours = 0;
  let latePenalty = 0; // accumulated Rs deduction for late punches over grace
  const breakdown = []; // per-day for slip
  const lateDays = []; // [{date, minutes_late, applies_penalty: bool}]

  const lateAfter = timeToMinutes(settings.late_after_time);
  const halfDayAfter = timeToMinutes(settings.half_day_after_time);

  for (let day = 1; day <= lastDay; day++) {
    const dateStr = `${year}-${pad(mm)}-${pad(day)}`;
    const sun = isSunday(year, mm, day);
    const att = attByDate[dateStr];
    const leaveType = leaveByDate[dateStr];
    const isShortLeave = !!shortLeaveByDate[dateStr];

    let dayLabel = 'absent';
    let dayPay = 0; // 1 = full, 0.5 = half, 0 = absent

    // Sunday
    if (sun && !leaveType && !att) {
      if (settings.sundays_paid) {
        dayPay = 1;
        sundayCount += 1;
        dayLabel = 'sunday_paid';
      } else {
        dayLabel = 'sunday_unpaid';
      }
      breakdown.push({ date: dateStr, day: 'Sun', label: dayLabel, pay: dayPay });
      paidDays += dayPay;
      continue;
    }

    // Approved leave that day
    if (leaveType) {
      let allowance = 0, used = 0;
      if (leaveType === 'casual') { allowance = settings.cl_per_month; used = clUsed; }
      else if (leaveType === 'sick') { allowance = settings.sl_per_month; used = slUsed; }
      else if (leaveType === 'earned') { allowance = settings.pl_per_month; used = plUsed; }

      if (allowance > 0 && used < allowance) {
        // Within allowance → paid
        dayPay = 1;
        if (leaveType === 'casual') clUsed += 1;
        else if (leaveType === 'sick') slUsed += 1;
        else if (leaveType === 'earned') plUsed += 1;
        paidLeaves += 1;
        dayLabel = `paid_${leaveType}_leave`;
      } else {
        // Over allowance → unpaid
        unpaidLeaves += 1;
        dayLabel = `unpaid_${leaveType}_leave`;
      }
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay });
      paidDays += dayPay;
      continue;
    }

    // Attendance row
    if (att && att.punch_in_time) {
      const punchInMin = timeToMinutes(att.punch_in_time);
      const hours = att.total_hours || 0;

      // Half-day cutoff (punched in late)
      const veryLate = punchInMin !== null && halfDayAfter !== null && punchInMin > halfDayAfter;
      const lowHoursHalfDay = hours > 0 && hours < settings.min_hours_full_day && hours >= settings.min_hours_half_day;
      const lowHoursAbsent = hours > 0 && hours < settings.min_hours_half_day;

      // Skip half-day if short leave was applied that day (and setting enabled)
      const shortLeaveSavesIt = isShortLeave && settings.skip_half_day_if_short_leave;

      if (lowHoursAbsent) {
        absentDays += 1;
        dayLabel = 'absent_low_hours';
        dayPay = 0;
      } else if ((veryLate || lowHoursHalfDay) && !shortLeaveSavesIt) {
        halfDays += 1;
        dayPay = 0.5;
        dayLabel = veryLate ? 'half_day_late' : 'half_day_low_hours';
      } else {
        // Late mark check (between late_after and half_day_after)
        if (punchInMin !== null && lateAfter !== null && punchInMin > lateAfter) {
          if (!shortLeaveSavesIt) {
            lateMarks += 1;
            lateDays.push({ date: dateStr, minutes_late: punchInMin - lateAfter });
          }
          dayLabel = 'late';
        } else {
          dayLabel = 'present';
        }
        dayPay = 1;
        // Overtime
        if (hours > settings.ot_threshold_hours) {
          otHours += hours - settings.ot_threshold_hours;
        }
      }
      paidDays += dayPay;
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay, punch_in: att.punch_in_time, hours });
      continue;
    }

    // No attendance, no leave, not Sunday → absent
    absentDays += 1;
    dayLabel = 'absent_no_punch';
    breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: 0 });
  }

  // N lates → 1 absent conversion (legacy model — disabled by default when 0)
  let latesAsAbsent = 0;
  if (settings.lates_to_absent > 0 && lateMarks >= settings.lates_to_absent) {
    latesAsAbsent = Math.floor(lateMarks / settings.lates_to_absent);
    paidDays = Math.max(0, paidDays - latesAsAbsent);
  }

  // Per-minute late penalty (current model): first N late marks per month
  // are free, every late day after that is charged Rs/min × minutes_late.
  const grace = settings.late_grace_count || 0;
  const perMin = settings.late_per_minute_rate || 0;
  for (let i = 0; i < lateDays.length; i++) {
    const d = lateDays[i];
    if (i < grace) {
      d.applies_penalty = false;
    } else {
      d.applies_penalty = true;
      const dayPenalty = (d.minutes_late || 0) * perMin;
      latePenalty += dayPenalty;
      d.penalty_amount = round2(dayPenalty);
      // tag the breakdown row with the penalty
      const br = breakdown.find(b => b.date === d.date);
      if (br) {
        br.late_minutes = d.minutes_late;
        br.late_penalty = round2(dayPenalty);
      }
    }
  }

  // ─── Sandwich rule (mam 2026-06-01) ──────────────────────────────
  // "if some one full day on saturday and monday sunday deduct" —
  // i.e. the standard Indian labour sandwich: Sunday is PAID by
  // default, but if either the preceding Saturday or the following
  // Monday is absent / half-day, the Sunday becomes UNPAID.
  // Walk the breakdown post-loop because we need each day's
  // outcome (pay 0 / 0.5 / 1) before deciding the Sundays.
  for (let i = 0; i < breakdown.length; i++) {
    const b = breakdown[i];
    if (b.day !== 'Sun') continue;
    const prev = i > 0 ? breakdown[i - 1] : null;
    const next = i < breakdown.length - 1 ? breakdown[i + 1] : null;
    const prevOk = !prev || prev.pay >= 1; // Saturday must be FULL day
    const nextOk = !next || next.pay >= 1; // Monday must be FULL day
    if (prevOk && nextOk) {
      // Sandwich satisfied → Sunday paid.  Only flip if it wasn't
      // already (preserves any existing sundays_paid behaviour).
      if (b.pay < 1) {
        paidDays += (1 - b.pay);
        sundayCount += 1;
        b.pay = 1;
        b.label = 'sunday_paid_sandwich';
      }
    } else {
      // Sandwich broken → Sunday unpaid.
      if (b.pay > 0) {
        paidDays -= b.pay;
        if (b.label === 'sunday_paid') sundayCount -= 1;
        b.pay = 0;
        b.label = 'sunday_sandwich_break';
      }
    }
  }

  // ─── Per-day rate (mam 2026-06-01) ───────────────────────────────
  // "one per day we count = full salary / total days in month".
  // Switched from working_days_per_month (typically 26) to the actual
  // calendar days (28/29/30/31).  Sundays are already paid via the
  // sandwich rule above, so the salary covers the full month evenly.
  const baseSalary = employee.salary || 0;
  const perDayRate = totalDays > 0 ? baseSalary / totalDays : 0;
  const grossEarned = perDayRate * paidDays;

  // Overtime pay — hourly rate derived from the same monthly base so
  // it stays consistent with the new per-day formula.
  const perHourRate = totalDays > 0
    ? baseSalary / (totalDays * settings.ot_threshold_hours)
    : 0;
  const otPay = otHours * perHourRate * (settings.ot_rate_multiplier || 1);

  // Salary breakdown — split the prorated gross into Basic / Conveyance /
  // HRA / Adhoc / Misc using the percentages in settings (matches mam's
  // SEPL Tally slip format).
  const basicPay = round2(grossEarned * (settings.basic_pct || 0) / 100);
  const conveyance = round2(grossEarned * (settings.conveyance_pct || 0) / 100);
  const hra = round2(grossEarned * (settings.hra_pct || 0) / 100);
  const adhoc = round2(grossEarned * (settings.adhoc_pct || 0) / 100);
  const misc = round2(grossEarned * (settings.misc_pct || 0) / 100);

  const totalDeductions = round2(latePenalty);
  const netPay = round2(grossEarned + otPay - totalDeductions);
  const deductions = baseSalary - grossEarned + totalDeductions; // informational

  return {
    employee_id: employee.id,
    employee_name: employee.name,
    department: employee.department,
    designation: employee.designation,
    join_date: employee.join_date,
    base_salary: baseSalary,
    per_day_rate: round2(perDayRate),
    working_days: settings.working_days_per_month,
    total_days_in_month: totalDays,
    days_counted: lastDay,
    is_current_month: (year === todayY && mm === todayM),
    is_future_month: (year > todayY || (year === todayY && mm > todayM)),
    user_linked: !!userId,
    user_id: userId || null,
    paid_days: round2(paidDays),
    half_days: halfDays,
    absent_days: absentDays,
    late_marks: lateMarks,
    lates_converted_absent: latesAsAbsent,
    late_penalty: round2(latePenalty),
    late_days: lateDays,
    paid_leaves: paidLeaves,
    unpaid_leaves: unpaidLeaves,
    sunday_count: sundayCount,
    ot_hours: round2(otHours),
    gross_earned: round2(grossEarned),
    ot_pay: round2(otPay),
    // Earnings breakdown (Basic + Conveyance + HRA + Adhoc + Misc = gross)
    basic_pay: basicPay,
    conveyance: conveyance,
    hra: hra,
    adhoc: adhoc,
    misc: misc,
    total_earnings: round2(basicPay + conveyance + hra + adhoc + misc),
    total_deductions: totalDeductions,
    deductions: round2(deductions),
    net_pay: netPay,
    cl_used: clUsed,
    sl_used: slUsed,
    pl_used: plUsed,
    short_leave_used: Object.keys(shortLeaveByDate).length,
    breakdown,
  };
}

function round2(n) { return Math.round((n || 0) * 100) / 100; }

function dayName(y, m, d) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(y, m - 1, d).getDay()];
}

// GET monthly payroll for ALL employees
router.get('/calculate', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    const settings = getSettings(db);
    const employees = db.prepare(`SELECT id, user_id, name, department, designation, join_date, salary FROM employees WHERE status='active' AND salary > 0`).all();

    // If a run is finalised for this month, return saved snapshots; else live-calc
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    const out = employees.map(emp => {
      if (finalised) {
        const snap = db.prepare('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?').get(month, emp.id);
        if (snap) return { ...snap, locked: true };
      }
      return calculateForEmployee(db, settings, emp, month);
    });

    res.json({ month, settings, employees: out });
  } catch (err) {
    console.error('payroll calc error', err);
    res.status(500).json({ error: err.message });
  }
});

// GET single employee detail (with breakdown)
router.get('/calculate/:employee_id', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    const settings = getSettings(db);
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const result = calculateForEmployee(db, settings, emp, month);
    res.json({ month, settings, ...result });
  } catch (err) {
    console.error('payroll detail error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST finalise a month — locks the snapshot for all employees
router.post('/finalise', requirePermission('payroll', 'approve'), (req, res) => {
  try {
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month required' });
    const db = getDb();
    const settings = getSettings(db);
    const employees = db.prepare(`SELECT * FROM employees WHERE status='active' AND salary > 0`).all();

    const ins = db.prepare(`INSERT OR REPLACE INTO payroll_runs (
      month, employee_id, employee_name, base_salary, working_days, paid_days, half_days,
      absent_days, late_marks, lates_converted_absent, late_penalty, paid_leaves, unpaid_leaves, sundays,
      ot_hours, gross_earned, ot_pay, deductions, net_pay,
      basic_pay, conveyance, hra, adhoc, misc,
      breakdown_json, status, finalised_by, finalised_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);

    const tx = db.transaction(() => {
      for (const emp of employees) {
        const r = calculateForEmployee(db, settings, emp, month);
        ins.run(
          month, emp.id, emp.name, r.base_salary, r.working_days, r.paid_days, r.half_days,
          r.absent_days, r.late_marks, r.lates_converted_absent, r.late_penalty, r.paid_leaves, r.unpaid_leaves, r.sunday_count,
          r.ot_hours, r.gross_earned, r.ot_pay, r.deductions, r.net_pay,
          r.basic_pay, r.conveyance, r.hra, r.adhoc, r.misc,
          JSON.stringify(r.breakdown), 'finalised', req.user.id
        );
      }
    });
    tx();
    res.json({ message: `Payroll finalised for ${month}`, count: employees.length });
  } catch (err) {
    console.error('payroll finalise error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST unlock a finalised month (admin only — for corrections)
router.post('/unlock', adminOnly, (req, res) => {
  const { month } = req.body;
  const db = getDb();
  db.prepare('DELETE FROM payroll_runs WHERE month=? AND status != ?').run(month, 'disbursed');
  res.json({ message: `Unlocked ${month}` });
});

module.exports = router;
