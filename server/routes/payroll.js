// Payroll auto-calculator. Reads rules from the payroll_settings table and
// computes per-employee monthly salary by walking each day of the month
// and applying:
//   - Sunday handling (paid / unpaid per setting)
//   - Approved leaves (CL / SL / PL paid up to allowance, LWP unpaid)
//   - Short leave (skips half-day deduction if setting enabled)
//   - Attendance (no punch = absent; punch 09:46–10:00 = late mark on a
//     full day; punch after 10:00 = half day; under 4h worked = half day;
//     4h+ = full day; overtime hours)
//   - N lates → 1 absent (configurable)
// Everything is recalculated live unless a run is "finalised" — then we
// return the snapshot from payroll_runs so historical slips don't drift.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { rosterCutoffs } = require('../lib/roster');
const { sendEmail, isConfigured } = require('../lib/email');
const { rupeesInWords } = require('../lib/numberToWords');

router.use(authMiddleware);

// ---------- helpers ----------

function ensureSettingsRow(db) {
  const row = db.prepare('SELECT id FROM payroll_settings WHERE id=1').get();
  if (!row) {
    db.prepare(`INSERT INTO payroll_settings (id) VALUES (1)`).run();
  }
}

// ─── Declared paid holidays (mam 2026-08-19) ─────────────────────────
// A company-wide holiday list (e.g. 15 Aug Independence Day): everyone is
// PAID for these dates without needing per-employee admin marking. Shown as
// its own "Holiday" column — Paid Days = Present + Sunday + CL + Holiday.
// Self-contained table creation (same pattern as app_settings in
// middleware/auth.js) so this module owns its own schema.
let _holidaysReady = false;
function ensureHolidaysTable(db) {
  if (_holidaysReady) return;
  db.exec(`CREATE TABLE IF NOT EXISTS payroll_holidays (
    date TEXT PRIMARY KEY,          -- 'YYYY-MM-DD'
    name TEXT NOT NULL,             -- e.g. 'Independence Day'
    created_by INTEGER,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);
  // Snapshot column for finalised months so locked history keeps its own
  // holiday count (ALTER is idempotent-guarded; older DBs get the column).
  try { db.exec(`ALTER TABLE payroll_runs ADD COLUMN holiday_days REAL DEFAULT 0`); } catch (_) { /* exists */ }
  _holidaysReady = true;
}
function getHolidaysForMonth(db, month) {
  ensureHolidaysTable(db);
  const rows = db.prepare(`SELECT date, name FROM payroll_holidays WHERE date LIKE ? ORDER BY date`).all(month + '-%');
  const byDate = {};
  for (const r of rows) byDate[r.date] = r.name;
  return byDate;
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
  // ISO datetime? punch_in_time is stored as UTC; the production VPS also
  // runs in UTC, so d.getHours() would return UTC hours — a 10:15 IST punch
  // (04:45Z) read as 04:45 and NEVER crosses the 09:46/10:00 late cutoffs,
  // so nobody was ever marked late. Convert to IST (+5:30) explicitly and
  // read UTC parts so the result is correct regardless of server timezone
  // (matches the attendance month-view logic).
  if (t.includes('T') || t.includes(' ')) {
    const d = new Date(t);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const [h, m] = t.split(':').map(Number);
  return h * 60 + (m || 0);
}

// Compute hours duration between punch_in and punch_out as fallback when total_hours is missing or 0
function getPunchDurationHours(inTime, outTime, storedHours) {
  if (storedHours != null && Number(storedHours) > 0) {
    return round2(Number(storedHours));
  }
  if (!inTime || !outTime) return 0;
  if (inTime.includes('T') || inTime.includes(' ') || outTime.includes('T') || outTime.includes(' ')) {
    const dIn = new Date(inTime);
    const dOut = new Date(outTime);
    if (!isNaN(dIn) && !isNaN(dOut)) {
      const diffHours = (dOut.getTime() - dIn.getTime()) / (1000 * 60 * 60);
      if (diffHours > 0 && diffHours <= 24) {
        return round2(diffHours);
      }
    }
  }
  const inMin = timeToMinutes(inTime);
  const outMin = timeToMinutes(outTime);
  if (inMin !== null && outMin !== null && outMin > inMin) {
    return round2((outMin - inMin) / 60);
  }
  return 0;
}

// ─── Salary Slip Email Template Generator (TSK-0924) ─────────────────────────
const COMPANY_INFO = {
  name: 'Secured Engineers Private Limited',
  brandName: 'SECURED ENGINEERS PVT. LTD.',
  headOffice: 'B.K Towers, Janta Nagar, Gill Road, Ludhiana, (PB)(141003)',
  corpOffice: '58/A/1, First Floor, Kalu Sarai, New Delhi - 110016',
  email: 'Sales@securedengineers.com',
  website: 'www.securedengineers.com',
};

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function fmt(n) {
  return Math.round(n || 0).toLocaleString('en-IN');
}

function formatDate(d) {
  if (!d) return '-';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return String(d);
  return `${String(dt.getDate()).padStart(2, '0')}-${String(dt.getMonth() + 1).padStart(2, '0')}-${dt.getFullYear()}`;
}

function generateSalarySlipEmailContent(data, month, emp, isTest = false) {
  const [yrStr, moStr] = month.split('-');
  const moNum = parseInt(moStr, 10);
  const payPeriod = `${MONTH_NAMES[moNum - 1]} ${yrStr}`;

  const empName = data.employee_name || emp?.name || 'Employee';
  const empId = data.employee_id || emp?.id || '-';
  const designation = data.designation || emp?.designation || '-';
  const department = data.department || emp?.department || '-';
  const joinDate = formatDate(data.join_date || emp?.join_date);

  const baseSalary = Number(data.base_salary || emp?.salary || 0);
  const totalDays = Number(data.total_days_in_month || 30);
  const perDayRate = Number(data.per_day_rate || (totalDays > 0 ? baseSalary / totalDays : 0));
  const paidDays = Number(data.paid_days || 0);
  const grossEarned = Number(data.gross_earned || (perDayRate * paidDays));

  const basicPay = Number(data.basic_pay || 0);
  const conveyance = Number(data.conveyance || 0);
  const hra = Number(data.hra || 0);
  const adhoc = Number(data.adhoc || 0);
  const misc = Number(data.misc || 0);
  const otPay = Number(data.ot_pay || 0);
  const otHours = Number(data.ot_hours || 0);
  const food = Number(data.food || 0);

  const latePenalty = Number(data.late_penalty || 0);
  const lateMarks = Number(data.late_marks || 0);
  const advance = Number(data.advance || 0);

  const sundayCount = Number(data.sunday_count || 0);
  const paidLeaves = Number(data.paid_leaves || 0);
  const holidayDays = Number(data.holiday_days || 0);
  const halfDays = Number(data.half_days || 0);
  const absentDays = Number(data.absent_days || 0);
  const sundayWorked = Number(data.sunday_worked || 0);
  const presentDays = data.breakdown
    ? data.breakdown.filter(b => ['present', 'late', 'admin_present', 'admin_late', 'missed_punch_out_grace'].includes(b.label)).length
    : Math.max(0, paidDays - sundayCount - paidLeaves - holidayDays);

  const totalEarnings = Number(data.total_earnings != null ? (data.total_earnings + otPay + food) : (basicPay + conveyance + hra + adhoc + misc + otPay + food));
  const totalDeductions = Number(data.total_deductions != null ? data.total_deductions : (latePenalty + advance));
  const netPay = Number(data.net_pay != null ? data.net_pay : (totalEarnings - totalDeductions));
  const words = rupeesInWords(netPay);

  const attParts = [
    `Paid Days: ${paidDays} of ${totalDays} calendar days`
  ];
  if (presentDays) attParts.push(`${presentDays} present`);
  if (sundayCount) attParts.push(`${sundayCount} Sunday(s)/week-off`);
  if (paidLeaves) attParts.push(`${paidLeaves} paid leave(s)`);
  if (holidayDays) attParts.push(`${holidayDays} declared holiday(s)`);
  if (halfDays) attParts.push(`${halfDays} half day(s) [-${halfDays * 0.5}d]`);
  if (absentDays) attParts.push(`${absentDays} absent day(s)`);
  if (lateMarks) attParts.push(`${lateMarks} late arrival(s)`);
  if (sundayWorked) attParts.push(`${sundayWorked} Sunday(s) worked (+${data.sunday_worked_pay || 0}d bonus)`);
  const attSummary = attParts.join(' • ');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Salary Slip - ${payPeriod}</title>
</head>
<body style="margin:0;padding:24px 12px;background-color:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1e293b;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:680px;background:#ffffff;border:1px solid #cbd5e1;border-radius:8px;overflow:hidden;box-shadow:0 4px 14px rgba(0,0,0,0.06);border-collapse:collapse;">
          ${isTest ? `
          <tr>
            <td style="background-color:#fef3c7;border-bottom:2px solid #f59e0b;padding:12px 20px;text-align:center;">
              <span style="font-weight:bold;color:#b45309;font-size:13px;letter-spacing:0.5px;">
                ⚠️ THIS IS A TEST / PREVIEW SALARY SLIP EMAIL. NO REAL PAYOUT MODIFICATIONS HAVE OCCURRED.
              </span>
            </td>
          </tr>` : ''}

          <!-- Header -->
          <tr>
            <td style="padding:22px 28px 18px;border-bottom:3px solid #c00000;background:linear-gradient(to right, #ffffff 60%, #fff5f5);">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
                <tr>
                  <td width="72" valign="middle" style="padding-right:16px;">
                    <div style="width:60px;height:52px;background:#ffffff;border:2px solid #c00000;border-radius:6px;text-align:center;line-height:50px;font-weight:900;color:#c00000;font-size:22px;letter-spacing:1px;font-family:sans-serif;">
                      SE
                    </div>
                  </td>
                  <td valign="middle">
                    <h1 style="margin:0;font-size:20px;font-weight:800;color:#c00000;letter-spacing:0.5px;line-height:1.2;">
                      ${COMPANY_INFO.brandName}
                    </h1>
                    <p style="margin:4px 0 0;font-size:11px;color:#64748b;line-height:1.4;">
                      <strong>Head Office:</strong> ${COMPANY_INFO.headOffice}<br>
                      <strong>Corporate Office:</strong> ${COMPANY_INFO.corpOffice}
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Slip Title Banner -->
          <tr>
            <td align="center" style="background:#f8fafc;padding:14px 20px;border-bottom:1px solid #e2e8f0;">
              <h2 style="margin:0;font-size:16px;color:#0f172a;text-transform:uppercase;letter-spacing:1.5px;font-weight:700;">
                Payslip
              </h2>
              <div style="margin-top:2px;font-size:13px;color:#475569;font-weight:600;">
                Pay Period: <span style="color:#c00000;">${payPeriod}</span>
              </div>
            </td>
          </tr>

          <!-- Employee Details & Salary Structure -->
          <tr>
            <td style="padding:18px 28px 14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12.5px;">
                <tr>
                  <td width="50%" valign="top" style="padding-right:14px;">
                    <table width="100%" cellpadding="3" cellspacing="0" style="border-collapse:collapse;">
                      <tr>
                        <td width="125" style="color:#64748b;font-weight:600;">Employee Name:</td>
                        <td style="color:#0f172a;font-weight:700;">${empName}</td>
                      </tr>
                      <tr>
                        <td width="125" style="color:#64748b;font-weight:600;">Employee ID:</td>
                        <td style="color:#0f172a;">${empId}</td>
                      </tr>
                      <tr>
                        <td width="125" style="color:#64748b;font-weight:600;">Department:</td>
                        <td style="color:#0f172a;">${department}</td>
                      </tr>
                      <tr>
                        <td width="125" style="color:#64748b;font-weight:600;">Designation:</td>
                        <td style="color:#0f172a;">${designation}</td>
                      </tr>
                      <tr>
                        <td width="125" style="color:#64748b;font-weight:600;">Date of Joining:</td>
                        <td style="color:#0f172a;">${joinDate}</td>
                      </tr>
                    </table>
                  </td>
                  <td width="50%" valign="top" style="padding-left:14px;border-left:1px dashed #cbd5e1;">
                    <table width="100%" cellpadding="3" cellspacing="0" style="border-collapse:collapse;">
                      <tr>
                        <td width="135" style="color:#64748b;font-weight:600;">Monthly Base Salary:</td>
                        <td style="color:#0f172a;font-weight:700;">₹${fmt(baseSalary)}</td>
                      </tr>
                      <tr>
                        <td width="135" style="color:#64748b;font-weight:600;">Calendar Days:</td>
                        <td style="color:#0f172a;">${totalDays} Days</td>
                      </tr>
                      <tr>
                        <td width="135" style="color:#64748b;font-weight:600;">Per-Day Rate:</td>
                        <td style="color:#0f172a;" title="Monthly Base / Total Days">₹${fmt(perDayRate)} / day</td>
                      </tr>
                      <tr>
                        <td width="135" style="color:#64748b;font-weight:600;">Payable Paid Days:</td>
                        <td style="color:#0f172a;font-weight:700;">
                          <span style="color:#15803d;background:#dcfce7;padding:2px 8px;border-radius:4px;font-size:12px;">
                            ${paidDays} of ${totalDays} days
                          </span>
                        </td>
                      </tr>
                    </table>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Attendance & Paid Days Reconciliation -->
          <tr>
            <td style="padding:0 28px 16px;">
              <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:12px 14px;">
                <div style="font-size:11.5px;font-weight:700;color:#0f172a;margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">
                  Attendance & Paid Days Reconciliation
                </div>
                <table width="100%" cellpadding="6" cellspacing="0" style="border-collapse:collapse;text-align:center;font-size:11.5px;">
                  <thead>
                    <tr style="background:#f1f5f9;color:#475569;font-weight:700;">
                      <th style="border:1px solid #cbd5e1;padding:6px;">Present</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;">Sunday / Off</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;">Paid Leaves</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;">Holidays</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;">Half Days</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;">Absent (LOP)</th>
                      <th style="border:1px solid #cbd5e1;padding:6px;background:#e0f2fe;color:#0369a1;">Paid Days</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr style="font-weight:700;color:#0f172a;background:#ffffff;">
                      <td style="border:1px solid #cbd5e1;padding:6px;">${presentDays}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;color:#1d4ed8;">${sundayCount}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;color:#7e22ce;">${paidLeaves}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;color:#0e7490;">${holidayDays}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;color:${halfDays > 0 ? '#ea580c' : '#64748b'};">${halfDays > 0 ? `${halfDays} (-${halfDays * 0.5}d)` : '0'}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;color:${absentDays > 0 ? '#dc2626' : '#64748b'};">${absentDays}</td>
                      <td style="border:1px solid #cbd5e1;padding:6px;background:#f0f9ff;color:#0284c7;font-size:13px;">${paidDays}</td>
                    </tr>
                  </tbody>
                </table>
                <div style="margin-top:6px;font-size:11px;color:#64748b;line-height:1.4;">
                  <strong>Summary:</strong> ${attSummary}
                </div>
              </div>
            </td>
          </tr>

          <!-- Earnings & Deductions Table -->
          <tr>
            <td style="padding:0 28px 18px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;border:1px solid #cbd5e1;font-size:12.5px;">
                <thead>
                  <tr style="background:#f1f5f9;color:#334155;border-bottom:2px solid #cbd5e1;">
                    <th width="32%" align="left" style="padding:8px 12px;font-weight:700;border-right:1px solid #cbd5e1;">Earnings</th>
                    <th width="18%" align="right" style="padding:8px 12px;font-weight:700;border-right:1px solid #cbd5e1;">Amount (₹)</th>
                    <th width="32%" align="left" style="padding:8px 12px;font-weight:700;border-right:1px solid #cbd5e1;">Deductions</th>
                    <th width="18%" align="right" style="padding:8px 12px;font-weight:700;">Amount (₹)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Basic Pay</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">${fmt(basicPay)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;color:#64748b;">
                      Late Penalty ${lateMarks > 0 ? `<span style="font-size:11px;color:#94a3b8;">(${lateMarks} late)</span>` : ''}
                    </td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;font-variant-numeric:tabular-nums;color:${latePenalty > 0 ? '#dc2626' : '#64748b'};">${latePenalty > 0 ? fmt(latePenalty) : '0'}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Conveyance Allowance</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">${fmt(conveyance)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;color:#64748b;">Advance Salary Repaid</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;font-variant-numeric:tabular-nums;color:${advance > 0 ? '#dc2626' : '#64748b'};">${advance > 0 ? fmt(advance) : '0'}</td>
                  </tr>
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">House Rent Allowance (HRA)</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">${fmt(hra)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;"></td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;"></td>
                  </tr>
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Adhoc Allowance</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">${fmt(adhoc)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;"></td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;"></td>
                  </tr>
                  ${misc > 0 ? `
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Miscellaneous Allowance</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">${fmt(misc)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;"></td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;"></td>
                  </tr>` : ''}
                  ${otPay > 0 ? `
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Overtime Pay (${otHours}h)</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;color:#15803d;font-weight:600;">${fmt(otPay)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;"></td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;"></td>
                  </tr>` : ''}
                  ${food > 0 ? `
                  <tr>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;">Food Allowance</td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;color:#15803d;font-weight:600;">${fmt(food)}</td>
                    <td style="padding:7px 12px;border:1px solid #e2e8f0;border-right:1px solid #cbd5e1;"></td>
                    <td align="right" style="padding:7px 12px;border:1px solid #e2e8f0;"></td>
                  </tr>` : ''}
                  <!-- Subtotals -->
                  <tr style="background:#f8fafc;font-weight:700;border-top:2px solid #cbd5e1;">
                    <td style="padding:8px 12px;border:1px solid #cbd5e1;border-right:1px solid #cbd5e1;">Total Earnings</td>
                    <td align="right" style="padding:8px 12px;border:1px solid #cbd5e1;border-right:1px solid #cbd5e1;font-variant-numeric:tabular-nums;">₹${fmt(totalEarnings)}</td>
                    <td style="padding:8px 12px;border:1px solid #cbd5e1;border-right:1px solid #cbd5e1;">Total Deductions</td>
                    <td align="right" style="padding:8px 12px;border:1px solid #cbd5e1;font-variant-numeric:tabular-nums;color:#dc2626;">₹${fmt(totalDeductions)}</td>
                  </tr>
                </tbody>
              </table>
            </td>
          </tr>

          <!-- Net Pay Box -->
          <tr>
            <td style="padding:0 28px 14px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f0fdf4;border:2px solid #86efac;border-radius:6px;border-collapse:collapse;">
                <tr>
                  <td valign="middle" style="padding:12px 18px;">
                    <span style="font-size:14px;color:#166534;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">Net Payable Amount:</span>
                  </td>
                  <td align="right" valign="middle" style="padding:12px 18px;">
                    <span style="font-size:24px;color:#15803d;font-weight:800;letter-spacing:0.5px;">₹${fmt(netPay)}</span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Calculation Formula Summary -->
          <tr>
            <td style="padding:0 28px 14px;">
              <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;padding:8px 12px;font-size:11.5px;color:#166534;line-height:1.5;">
                <strong>Payout Formula:</strong> Earned Base (₹${fmt(grossEarned)}) ${otPay > 0 ? `+ Overtime (₹${fmt(otPay)})` : ''} ${food > 0 ? `+ Food Allowance (₹${fmt(food)})` : ''} ${totalDeductions > 0 ? `- Deductions (₹${fmt(totalDeductions)})` : ''} = <strong>Net Payable: ₹${fmt(netPay)}</strong>
              </div>
            </td>
          </tr>

          <!-- Amount In Words -->
          <tr>
            <td style="padding:0 28px 18px;">
              <div style="background:#f8fafc;border-left:3px solid #c00000;padding:10px 14px;font-size:12.5px;color:#334155;">
                <strong style="color:#0f172a;">Amount in Words:</strong> ${words}
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:16px 28px;text-align:center;font-size:11px;color:#64748b;line-height:1.6;">
              <div>This is a system-generated salary slip sent from <strong>${COMPANY_INFO.name}</strong>.</div>
              <div>Email: <a href="mailto:${COMPANY_INFO.email}" style="color:#c00000;text-decoration:none;">${COMPANY_INFO.email}</a> • Website: <a href="https://${COMPANY_INFO.website}" style="color:#c00000;text-decoration:none;">${COMPANY_INFO.website}</a></div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = `${COMPANY_INFO.brandName}
PAYSLIP FOR ${payPeriod}
--------------------------------------------------
Employee: ${empName} (ID: ${empId})
Department: ${department} | Designation: ${designation}
Monthly Base Salary: ₹${fmt(baseSalary)} | Total Calendar Days: ${totalDays}
Per-Day Calculation Rate: ₹${fmt(perDayRate)}/day
Paid Days: ${paidDays} / ${totalDays} days

ATTENDANCE RECONCILIATION:
- Present Days: ${presentDays}
- Sundays / Week-Offs: ${sundayCount}
- Paid Leaves: ${paidLeaves}
- Holidays: ${holidayDays}
${halfDays > 0 ? `- Half Days: ${halfDays} (-${halfDays * 0.5}d)\n` : ''}${absentDays > 0 ? `- Absent (Loss of Pay): ${absentDays} days\n` : ''}${lateMarks > 0 ? `- Late Arrivals: ${lateMarks} marks\n` : ''}
EARNINGS:
- Basic Pay: ₹${fmt(basicPay)}
- Conveyance Allowance: ₹${fmt(conveyance)}
- House Rent Allowance: ₹${fmt(hra)}
- Adhoc Allowance: ₹${fmt(adhoc)}
${misc > 0 ? `- Miscellaneous Allowance: ₹${fmt(misc)}\n` : ''}${otPay > 0 ? `- Overtime Pay (${otHours}h): ₹${fmt(otPay)}\n` : ''}${food > 0 ? `- Food Allowance: ₹${fmt(food)}\n` : ''}Total Earnings: ₹${fmt(totalEarnings)}

DEDUCTIONS:
${latePenalty > 0 ? `- Late Penalty: ₹${fmt(latePenalty)} (${lateMarks} late arrivals)\n` : ''}${advance > 0 ? `- Advance Salary Repaid: ₹${fmt(advance)}\n` : ''}Total Deductions: ₹${fmt(totalDeductions)}

PAYOUT FORMULA:
Earned Base (₹${fmt(grossEarned)}) ${otPay > 0 ? `+ Overtime (₹${fmt(otPay)})` : ''} ${food > 0 ? `+ Food (₹${fmt(food)})` : ''} ${totalDeductions > 0 ? `- Deductions (₹${fmt(totalDeductions)})` : ''} = Net Payable: ₹${fmt(netPay)}

NET PAYABLE: ₹${fmt(netPay)}
IN WORDS: ${words}

Attendance Summary: ${attSummary}
--------------------------------------------------
${COMPANY_INFO.name}
Head Office: ${COMPANY_INFO.headOffice}
Email: ${COMPANY_INFO.email} | Website: ${COMPANY_INFO.website}
`;

  return { html, text, payPeriod };
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
    'late_after_time', 'half_day_after_time', 'min_hours_full_day', 'min_hours_half_day',
    'skip_half_day_if_short_leave', 'lates_to_absent', 'late_grace_count', 'late_per_minute_rate',
    'working_days_per_month', 'sundays_paid',
    'cl_per_month', 'sl_per_month', 'pl_per_month', 'short_leave_per_month',
    'ot_threshold_hours', 'ot_rate_multiplier', 'pay_cycle_start_day',
    'basic_pct', 'conveyance_pct', 'hra_pct', 'adhoc_pct', 'misc_pct'
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

  // Salary breakdown percentages must sum to 100%
  const pctKeys = ['basic_pct', 'conveyance_pct', 'hra_pct', 'adhoc_pct', 'misc_pct'];
  if (pctKeys.some(k => req.body[k] !== undefined)) {
    const cur = getSettings(db);
    const bp = req.body.basic_pct !== undefined ? Number(req.body.basic_pct) : (cur.basic_pct || 0);
    const cp = req.body.conveyance_pct !== undefined ? Number(req.body.conveyance_pct) : (cur.conveyance_pct || 0);
    const hp = req.body.hra_pct !== undefined ? Number(req.body.hra_pct) : (cur.hra_pct || 0);
    const ap = req.body.adhoc_pct !== undefined ? Number(req.body.adhoc_pct) : (cur.adhoc_pct || 0);
    const mp = req.body.misc_pct !== undefined ? Number(req.body.misc_pct) : (cur.misc_pct || 0);
    const totalPct = Math.round((bp + cp + hp + ap + mp) * 100) / 100;
    if (Math.abs(totalPct - 100) > 0.05) {
      return res.status(400).json({ error: `Salary slip breakdown percentages must equal 100% (currently ${totalPct}%)` });
    }
  }

  sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
  vals.push(req.user.id);
  db.prepare(`UPDATE payroll_settings SET ${sets.join(', ')} WHERE id = 1`).run(...vals);
  res.json({ message: 'Settings updated', settings: getSettings(db) });
});

// Core calculator — runs for one employee for one month, returns full breakdown.
function calculateForEmployee(db, settings, employee, month) {
  const [year, mm] = month.split('-').map(Number);
  const totalDays = daysInMonth(month);

  // Advance salary taken this month (deducted from net pay) + a food
  // allowance (ADDED to net pay) — both entered by admin on the payroll
  // screen and stored on the same monthly row (mam 2026-06-12).
  const adjRow = db.prepare('SELECT amount, food, paid_days_override, cl_override FROM payroll_advances WHERE month=? AND employee_id=?')
    .get(month, employee.id) || {};
  const advance = round2(adjRow.amount || 0);
  const food = round2(adjRow.food || 0);

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
    const totalPct = (settings.basic_pct || 0) + (settings.conveyance_pct || 0) + (settings.hra_pct || 0) + (settings.adhoc_pct || 0) + (settings.misc_pct || 0);
    const normFactor = (totalPct > 0 && Math.abs(totalPct - 100) > 0.01) ? (100 / totalPct) : 1;
    const basicPay = round2(grossEarned * ((settings.basic_pct || 0) * normFactor) / 100);
    const conveyance = round2(grossEarned * ((settings.conveyance_pct || 0) * normFactor) / 100);
    const hra = round2(grossEarned * ((settings.hra_pct || 0) * normFactor) / 100);
    const adhoc = round2(grossEarned * ((settings.adhoc_pct || 0) * normFactor) / 100);
    const misc = round2(grossEarned * ((settings.misc_pct || 0) * normFactor) / 100);
    const sumEarnings = round2(basicPay + conveyance + hra + adhoc + misc);
    const diffEarnings = round2(grossEarned - sumEarnings);
    const finalBasicPay = round2(basicPay + diffEarnings);
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
      paid_leaves: 0, unpaid_leaves: 0, sunday_count: 0, holiday_days: 0,
      ot_hours: 0, ot_pay: 0,
      gross_earned: grossEarned,
      basic_pay: basicPay, conveyance, hra, adhoc, misc,
      total_earnings: round2(basicPay + conveyance + hra + adhoc + misc),
      advance,
      total_deductions: advance, deductions: advance,
      net_pay: round2(grossEarned - advance),
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
  const todayStr = `${todayY}-${pad(todayM)}-${pad(todayD)}`;
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
    ? db.prepare(`SELECT date, punch_in_time, punch_out_time, total_hours, status, admin_marked, regularized_at
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
    // Clamp the day-walk to THIS month. The old loop walked the leave's full
    // range before filtering, so one mistyped to_date (e.g. 2999-12-31) made
    // this request spin for years of days — and because better-sqlite3 is
    // synchronous, it froze every user, not just the payroll page.
    const from = new Date(lr.from_date < startDate ? startDate : lr.from_date);
    const to = new Date(lr.to_date > endDate ? endDate : lr.to_date);
    if (isNaN(from) || isNaN(to) || from > to) continue;
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
  let holidayDays = 0; // declared paid holidays (payroll_holidays) + admin 'holiday' marks
  let latePenalty = 0; // accumulated Rs deduction for late punches over grace
  let missedPunchOutCount = 0; // number of times employee forgot to punch out this month (max 3 grace)
  const breakdown = []; // per-day for slip
  const lateDays = []; // [{date, minutes_late, applies_penalty: bool}]

  // Declared company holidays this month (date → name), e.g. 15 Aug.
  const holidayByDate = getHolidaysForMonth(db, month);

  // Roster-aware cutoffs (SEPL 2026-07): a 9:00 (early) roster employee is late
  // 30 min earlier than the 9:30 (general) default. Times still come from the
  // admin-tuned payroll_settings; the roster just shifts them.
  const cut = rosterCutoffs(settings, employee.roster);
  const lateAfter = timeToMinutes(cut.late_after_time);
  const halfDayAfter = timeToMinutes(cut.half_day_after_time);

  const joinDate = String(employee.join_date || '').slice(0, 10);
  const hasJoinDate = isRealDate(joinDate);
  const exitDate = String(employee.exit_date || '').slice(0, 10);
  const hasExitDate = isRealDate(exitDate);

  for (let day = 1; day <= lastDay; day++) {
    const dateStr = `${year}-${pad(mm)}-${pad(day)}`;
    // Before employment: no holiday, weekly-off, leave, absence or penalty.
    if (hasJoinDate && dateStr < joinDate) {
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: 'not_joined', pay: 0 });
      continue;
    }
    // After leaving / inactive: no holiday, weekly-off, leave, absence or penalty.
    if (hasExitDate && dateStr > exitDate) {
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: 'left_company', pay: 0 });
      continue;
    }
    const sun = isSunday(year, mm, day);
    const att = attByDate[dateStr];
    const leaveType = leaveByDate[dateStr];
    const isShortLeave = !!shortLeaveByDate[dateStr];

    let dayLabel = 'absent';
    let dayPay = 0; // 1 = full, 0.5 = half, 0 = absent

    const isHoliday = !!holidayByDate[dateStr];

    const hasPunch = !!(att && att.punch_in_time);
    const adminAttStatus = !!(att && (att.admin_marked || att.regularized_at) && ['present', 'late', 'half_day', 'short_day'].includes(String(att.status || '').toLowerCase()));
    const hasAttended = hasPunch || adminAttStatus;

    // Sunday (when employee did NOT work/attend)
    if (sun && !hasAttended) {
      if (settings.sundays_paid) {
        dayPay = 1;
        sundayCount += 1;
        dayLabel = 'sunday_paid';
      } else if (isHoliday) {
        // Daily-wage config (Sundays unpaid): a DECLARED holiday landing on a
        // Sunday is still a paid holiday — otherwise the holiday silently
        // vanishes for exactly the people Sundays aren't paid for.
        dayPay = 1;
        holidayDays += 1;
        dayLabel = 'holiday_paid';
      } else {
        dayLabel = 'sunday_unpaid';
      }
      breakdown.push({
        date: dateStr,
        day: 'Sun',
        label: dayLabel,
        pay: dayPay,
        holiday_name: isHoliday ? holidayByDate[dateStr] : undefined,
        ...(leaveType ? { applied_leave: leaveType } : {}),
      });
      paidDays += dayPay;
      continue;
    }

    // ─── Declared company holiday (mam 2026-08-19) ──────────────────
    // "holiday is all for everyone" — a declared holiday is a full paid day
    // for every employee, so it WINS over leave and over attendance:
    //   • on approved leave that day  → paid as holiday, and the leave
    //     allowance is NOT consumed (otherwise the one person on leave pays
    //     for the company holiday out of their own CL, or loses the day).
    //   • punched in that day         → still a full paid day with NO
    //     half-day and NO late penalty (otherwise turning up on a holiday
    //     pays LESS than staying home). Overtime hours still accrue.
    // Placed before the leave / admin-mark / punch branches so the outcome is
    // the same for everyone regardless of what else is on the day.
    if (isHoliday) {
      dayPay = 1;
      holidayDays += 1;
      dayLabel = 'holiday_paid';
      const hrs = att ? (att.total_hours || 0) : 0;
      const dayOtHours = (att && employee.ot_eligible && hrs > settings.ot_threshold_hours)
        ? round2(hrs - settings.ot_threshold_hours)
        : 0;
      if (dayOtHours > 0) {
        otHours += dayOtHours;
      }
      breakdown.push({
        date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay,
        holiday_name: holidayByDate[dateStr],
        ...(att ? { punch_in: att.punch_in_time, punch_out: att.punch_out_time || null, hours: hrs, ot_hours: dayOtHours, holiday_worked: true } : {}),
      });
      paidDays += dayPay;
      continue;
    }

    // Approved leave that day (only when employee did NOT attend/work)
    // If an employee applied for leave but came to work (punched in or marked present),
    // attendance takes precedence and leave balance is NOT consumed.
    if (leaveType && !hasAttended) {
      let paid = false;
      if (leaveType === 'casual') {
        // 1 paid casual leave per month per staff (mam 2026-06-09).
        if ((settings.cl_per_month || 0) > 0 && clUsed < settings.cl_per_month) { paid = true; clUsed += 1; }
      } else if (leaveType === 'sick') {
        if ((settings.sl_per_month || 0) > 0 && slUsed < settings.sl_per_month) { paid = true; slUsed += 1; }
      } else if (leaveType === 'earned') {
        if ((settings.pl_per_month || 0) > 0 && plUsed < settings.pl_per_month) { paid = true; plUsed += 1; }
      } else if (leaveType === 'comp_off' || leaveType === 'half_day') {
        paid = true; // comp-off & half-day leave → full paid day (mam 2026-06-09)
      }
      if (paid) {
        dayPay = 1;
        paidLeaves += 1;
        dayLabel = `paid_${leaveType}_leave`;
      } else {
        unpaidLeaves += 1;
        dayLabel = `unpaid_${leaveType}_leave`;
      }
      breakdown.push({ date: dateStr, day: dayName(year, mm, day), label: dayLabel, pay: dayPay });
      paidDays += dayPay;
      continue;
    }

    // Admin-marked override (admin-mark sets status + admin_marked=1 but
    // NO punch_in_time, so the punch-based logic below would wrongly count
    // it absent). When an admin manually marks a day, honour that status
    // directly — this is what makes "admin updates present/absent" flow
    // through to the payroll counts. Wins over the punch logic.
    if (att && (att.admin_marked || att.regularized_at)) {
      const s = String(att.status || '').toLowerCase();
      if (s === 'present' || s === 'late') {
        dayPay = 1;
        dayLabel = s === 'late' ? 'admin_late' : 'admin_present';
      } else if (s === 'half_day' || s === 'short_day') {
        dayPay = 0.5; halfDays += 1;
        dayLabel = 'admin_' + s;
      } else if (s === 'leave' || s === 'on_leave' || s === 'holiday') {
        // NOTE: admin-marked 'holiday' deliberately still counts as a paid
        // leave here, exactly as before. Moving it into the holiday bucket
        // would change paid_leaves for months that already carry a manual CL
        // override — effPaidDays = paidDays - paidLeaves + clOverride, so a
        // drop in paidLeaves silently RAISES pay by one day per admin-holiday
        // with nobody touching anything. Declared holidays (below) are the
        // supported mechanism; this legacy path stays pay-neutral.
        dayPay = 1; paidLeaves += 1;
        dayLabel = 'admin_' + s;
      } else { // 'absent' or anything unrecognised
        dayPay = 0; absentDays += 1;
        dayLabel = 'admin_absent';
      }
      paidDays += dayPay;
      breakdown.push({
        date: dateStr,
        day: dayName(year, mm, day),
        label: dayLabel,
        pay: dayPay,
        admin_marked: true,
        punch_in: att ? att.punch_in_time : null,
        punch_out: att ? (att.punch_out_time || null) : null,
        hours: att ? (att.total_hours || 0) : 0,
        ot_hours: 0,
        ...(leaveType ? { applied_leave: leaveType } : {}),
      });
      continue;
    }

    // Attendance row
    if (att && att.punch_in_time) {
      const punchInMin = timeToMinutes(att.punch_in_time);
      const minHalfHours = settings.min_hours_half_day != null ? Number(settings.min_hours_half_day) : 2;
      const minFullHours = settings.min_hours_full_day != null ? Number(settings.min_hours_full_day) : 6;
      const otThreshold = settings.ot_threshold_hours != null ? Number(settings.ot_threshold_hours) : 9;
      const shortLeaveSavesIt = isShortLeave && settings.skip_half_day_if_short_leave;

      // A missed punch-out occurs when there is punch_in but NO punch_out AND total_hours is missing or 0.
      // If punch_out_time is present OR total_hours > 0 is already recorded, it is NOT a missed punch-out.
      const hasPunchOut = !!att.punch_out_time || (att.total_hours != null && Number(att.total_hours) > 0);
      const isPastDay = dateStr < todayStr || month < todayStr.slice(0, 7);

      if (!hasPunchOut) {
        if (!isPastDay) {
          // Today's shift in progress: punched in, not yet punched out.
          // Award full day without consuming a missed punch-out grace.
          dayPay = 1;
          dayLabel = sun ? 'sunday_worked' : (isShortLeave ? 'short_leave' : 'present');
          paidDays += dayPay;
          breakdown.push({
            date: dateStr,
            day: dayName(year, mm, day),
            label: dayLabel,
            pay: dayPay,
            punch_in: att.punch_in_time,
            punch_out: null,
            hours: 0,
            ot_hours: 0,
            note: 'Shift in progress (punched in)',
            short_leave_applied: isShortLeave,
            ...(leaveType ? { applied_leave: leaveType } : {}),
          });
          continue;
        }

        // Missed punch-out on a past day:
        // Grace rule: up to 3 times per month counts as Full Day.
        // 4th time onwards counts as 0 hours / absent (or pays applied leave if approved).
        missedPunchOutCount += 1;
        let note = '';

        if (missedPunchOutCount <= 3) {
          // Grace applied -> Full Day
          dayPay = 1;
          dayLabel = 'missed_punch_out_grace';
          note = `Missed punch-out (Grace ${missedPunchOutCount}/3 - full day)`;
        } else {
          // Grace exceeded -> 0 hours / absent unless applied leave pays
          if (sun) {
            dayPay = settings.sundays_paid ? 1 : 0;
            if (settings.sundays_paid) sundayCount += 1;
            dayLabel = settings.sundays_paid ? 'sunday_paid' : 'sunday_unpaid';
            note = 'Missed punch-out on Sunday (exceeded 3 grace times - no bonus)';
          } else {
            let leavePaid = false;
            if (leaveType === 'casual') {
              if ((settings.cl_per_month || 0) > 0 && clUsed < settings.cl_per_month) {
                leavePaid = true; clUsed += 1; dayPay = 1; paidLeaves += 1; dayLabel = 'paid_casual_leave';
              }
            } else if (leaveType === 'sick') {
              if ((settings.sl_per_month || 0) > 0 && slUsed < settings.sl_per_month) {
                leavePaid = true; slUsed += 1; dayPay = 1; paidLeaves += 1; dayLabel = 'paid_sick_leave';
              }
            } else if (leaveType === 'earned') {
              if ((settings.pl_per_month || 0) > 0 && plUsed < settings.pl_per_month) {
                leavePaid = true; plUsed += 1; dayPay = 1; paidLeaves += 1; dayLabel = 'paid_earned_leave';
              }
            } else if (leaveType === 'comp_off') {
              leavePaid = true; dayPay = 1; paidLeaves += 1; dayLabel = 'paid_comp_off_leave';
            } else if (leaveType === 'half_day') {
              leavePaid = true; dayPay = 0.5; halfDays += 1; dayLabel = 'half_day_leave';
            }

            if (!leavePaid) {
              dayPay = 0;
              absentDays += 1;
              dayLabel = 'missed_punch_out_absent';
              note = 'Missed punch-out (exceeded 3 grace times - 0 hrs)';
            }
          }
        }

        paidDays += dayPay;
        breakdown.push({
          date: dateStr,
          day: dayName(year, mm, day),
          label: dayLabel,
          pay: dayPay,
          punch_in: att.punch_in_time,
          punch_out: null,
          hours: 0,
          ot_hours: 0,
          note,
          missed_punch_out: true,
          short_leave_applied: isShortLeave,
          ...(leaveType ? { applied_leave: leaveType } : {}),
        });
        continue;
      }

      // Normal attendance when punch_out IS present:
      let hours = Number(att.total_hours || 0);
      if (hours <= 0 && att.punch_in_time && att.punch_out_time) {
        hours = getPunchDurationHours(att.punch_in_time, att.punch_out_time, att.total_hours);
      }
      hours = round2(hours);

      let dayOtHours = 0;
      let note = '';

      if (sun) {
        // SUNDAY attendance:
        // No late marks, no late penalty, no punch-in late cutoffs apply.
        if (hours >= minFullHours) {
          dayPay = 1;
          dayLabel = 'sunday_worked';
          note = 'Sunday full day worked';
          if (employee.ot_eligible && hours > otThreshold) {
            dayOtHours = round2(hours - otThreshold);
            otHours += dayOtHours;
          }
        } else if (hours >= minHalfHours) {
          dayPay = 0.5;
          halfDays += 1;
          dayLabel = 'half_day_low_hours';
          note = 'Sunday half day (2h - 6h)';
        } else {
          // Under minimum hours on Sunday (< 2h)
          if (settings.sundays_paid) {
            dayPay = 1;
            sundayCount += 1;
            dayLabel = 'sunday_paid';
          } else {
            dayPay = 0;
            dayLabel = 'sunday_unpaid';
          }
          if (employee.ot_eligible && hours >= 0.5) {
            dayOtHours = round2(hours);
            otHours += dayOtHours;
            note = `Under 2h on Sunday (${dayOtHours}h OT credited)`;
          } else {
            note = 'Under 2h on Sunday';
          }
        }
      } else {
        // WEEKDAY / SATURDAY attendance:
        if (hours < minHalfHours && !shortLeaveSavesIt) {
          // Under 2h -> Absent, but calculate OT if worked >= 0.5h for OT-eligible staff
          absentDays += 1;
          dayPay = 0;
          dayLabel = 'absent_low_hours';
          if (employee.ot_eligible && hours >= 0.5) {
            dayOtHours = round2(hours);
            otHours += dayOtHours;
            note = `Under 2h (${dayOtHours}h OT credited)`;
          } else {
            note = 'Under 2h';
          }
        } else if (hours < minFullHours && !shortLeaveSavesIt) {
          // 2h to < 6h -> Half Day
          halfDays += 1;
          dayPay = 0.5;
          dayLabel = 'half_day_low_hours';
          note = 'Half day (2h - 6h)';
        } else {
          // 6h+ or saved by short leave
          const veryLate = punchInMin !== null && halfDayAfter !== null && punchInMin > halfDayAfter;
          if (employee.ot_eligible && hours > otThreshold) {
            dayOtHours = round2(hours - otThreshold);
            otHours += dayOtHours;
          }

          if (veryLate && !shortLeaveSavesIt) {
            halfDays += 1;
            dayPay = 0.5;
            dayLabel = 'half_day_late';
            note = 'Late arrival after 10:00 (half day)';
          } else {
            dayPay = 1;
            if (punchInMin !== null && lateAfter !== null && punchInMin >= lateAfter) {
              if (!shortLeaveSavesIt) {
                lateMarks += 1;
                lateDays.push({ date: dateStr, minutes_late: punchInMin - lateAfter + 1 });
                dayLabel = 'late';
                note = `Late arrival (${punchInMin - lateAfter + 1} min)`;
              } else {
                dayLabel = 'short_leave';
                note = 'Late excused by short leave';
              }
            } else {
              dayLabel = isShortLeave ? 'short_leave' : 'present';
            }
          }
        }
      }

      paidDays += dayPay;
      breakdown.push({
        date: dateStr,
        day: dayName(year, mm, day),
        label: dayLabel,
        pay: dayPay,
        punch_in: att.punch_in_time,
        punch_out: att.punch_out_time || null,
        hours,
        ot_hours: dayOtHours,
        note: note || undefined,
        short_leave_applied: isShortLeave,
        ...(leaveType ? { applied_leave: leaveType } : {}),
      });
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

  // ─── Sandwich rule (mam 2026-06-08, revised) ─────────────────────
  // Sunday is ALWAYS paid, EXCEPT when BOTH the Saturday before AND the
  // Monday after are absent (no pay) — only then is the sandwiched
  // Sunday deducted. If either side is a worked/paid day (full, half,
  // or paid leave) the Sunday stays paid. (Previous rule deducted when
  // EITHER side was off; mam softened it to BOTH.)
  //
  // Only the weekly-off Sunday rows are touched — a Sunday the person
  // actually worked or took leave on keeps its own outcome.
  // Walk post-loop because we need each neighbouring day's pay first.
  for (let i = 0; i < breakdown.length; i++) {
    const b = breakdown[i];
    if (b.day !== 'Sun') continue;
    if (b.label !== 'sunday_paid' && b.label !== 'sunday_unpaid') continue; // worked or on-leave Sundays keep their outcome
    const prev = i > 0 ? breakdown[i - 1] : null;
    const next = i < breakdown.length - 1 ? breakdown[i + 1] : null;
    const prevAbsent = !!prev && prev.label !== 'not_joined' && prev.pay === 0; // Saturday absent (no pay)
    const nextAbsent = !!next && next.label !== 'not_joined' && next.pay === 0; // Monday absent (no pay)
    if (prevAbsent && nextAbsent) {
      // Both neighbours absent → Sunday deducted.
      if (b.pay > 0) {
        paidDays -= b.pay;
        sundayCount -= 1;
        b.pay = 0;
        b.label = 'sunday_sandwich_break';
      }
    } else if (settings.sundays_paid) {
      // At least one neighbour worked/paid → Sunday paid.
      if (b.pay < 1) {
        paidDays += (1 - b.pay);
        sundayCount += 1;
        b.pay = 1;
        b.label = 'sunday_paid';
      }
    }
  }

  // ─── Sunday-worked bonus (mam 2026-06-09) ────────────────────────
  // Sunday is a paid weekly-off already built into the monthly salary.
  // If the person ALSO works that Sunday, mam gives an EXTRA full day's
  // pay on top — so net can exceed base salary. The worked Sunday has
  // already counted as one normal day (folded into the 'att'/present
  // count); here we add the extra day-equivalent (full worked Sunday →
  // +1, half → +0.5).  Weekly-off (unworked) Sundays are untouched.
  let sundayWorked = 0;     // # of Sundays actually worked
  let sundayWorkedPay = 0;  // extra day-equivalents credited
  const SUN_WORK_LABELS = new Set([
    'present', 'late', 'half_day_late', 'half_day_low_hours', 'short_leave', 'sunday_worked',
    'admin_present', 'admin_late', 'admin_half_day', 'admin_short_day', 'missed_punch_out_grace',
  ]);
  for (const b of breakdown) {
    if (b.day !== 'Sun' || !SUN_WORK_LABELS.has(b.label) || !(b.pay > 0)) continue;
    sundayWorked += 1;
    sundayWorkedPay += b.pay;
    b.sunday_worked = true;
    b.sunday_bonus = b.pay;
    if (settings.sundays_paid) {
      // Every Sunday is credited as a paid Sunday (4 or 5 per month).
      // Working on Sunday adds the attendance pay on top for double pay.
      sundayCount += 1;
      paidDays += 1;
      b.pay = round2(b.pay + 1);
    } else {
      paidDays += b.pay;
      b.pay = round2(b.pay * 2);
    }
    if (b.label === 'present' || b.label === 'late' || b.label === 'short_leave' || b.label === 'missed_punch_out_grace') {
      b.label = 'sunday_worked';
    } else if (b.label === 'admin_present' || b.label === 'admin_late') {
      b.label = 'admin_sunday_worked';
    } else if (b.label === 'half_day_late' || b.label === 'half_day_low_hours') {
      b.label = 'sunday_half_day';
    } else if (b.label === 'admin_half_day' || b.label === 'admin_short_day') {
      b.label = 'admin_sunday_half_day';
    }
  }

  // ─── Per-day rate (mam 2026-06-01) ───────────────────────────────
  // "one per day we count = full salary / total days in month".
  // Switched from working_days_per_month (typically 26) to the actual
  // calendar days (28/29/30/31).  Sundays are already paid via the
  // sandwich rule above, so the salary covers the full month evenly.
  // ─── Manual monthly overrides (mam 2026-06-13) ───────────────────
  // Admin can hand-set Paid Days and CL (paid leaves) for
  // this month to pay salary now while attendance is being corrected.  NULL =
  // use auto.  CL is part of paid days, so a CL edit shifts the auto paid-days;
  // a manual Paid Days is the final word for what's paid.
  const clOv = adjRow.cl_override, pdOv = adjRow.paid_days_override;
  const clOverridden = clOv != null && clOv >= 0;
  const pdOverridden = pdOv != null && pdOv >= 0;
  const effPaidLeaves = clOverridden ? round2(clOv) : paidLeaves;
  let effPaidDays = round2(paidDays - paidLeaves + effPaidLeaves);
  if (pdOverridden) effPaidDays = round2(pdOv);
  // Always apply the attendance-based penalty for open months. Ignore legacy
  // manual late overrides; finalised payroll remains a frozen snapshot.
  const effLatePenalty = latePenalty;

  const baseSalary = employee.salary || 0;
  const perDayRate = totalDays > 0 ? baseSalary / totalDays : 0;
  const grossEarned = perDayRate * effPaidDays;

  // Overtime pay — hourly rate derived from the same monthly base so
  // it stays consistent with the new per-day formula.
  const perHourRate = totalDays > 0
    ? baseSalary / (totalDays * settings.ot_threshold_hours)
    : 0;
  const otPay = otHours * perHourRate * (settings.ot_rate_multiplier || 1);

  // Salary breakdown — split the prorated gross into Basic / Conveyance /
  // HRA / Adhoc / Misc using the percentages in settings (matches mam's
  // SEPL Tally slip format). If settings sum to something other than 100
  // (e.g. legacy 100.1% in DB), normalize so total components always sum to grossEarned.
  const totalPct = (settings.basic_pct || 0) + (settings.conveyance_pct || 0) + (settings.hra_pct || 0) + (settings.adhoc_pct || 0) + (settings.misc_pct || 0);
  const normFactor = (totalPct > 0 && Math.abs(totalPct - 100) > 0.01) ? (100 / totalPct) : 1;
  const basicPay = round2(grossEarned * ((settings.basic_pct || 0) * normFactor) / 100);
  const conveyance = round2(grossEarned * ((settings.conveyance_pct || 0) * normFactor) / 100);
  const hra = round2(grossEarned * ((settings.hra_pct || 0) * normFactor) / 100);
  const adhoc = round2(grossEarned * ((settings.adhoc_pct || 0) * normFactor) / 100);
  const misc = round2(grossEarned * ((settings.misc_pct || 0) * normFactor) / 100);
  const sumEarnings = round2(basicPay + conveyance + hra + adhoc + misc);
  const diffEarnings = round2(grossEarned - sumEarnings);
  const finalBasicPay = round2(basicPay + diffEarnings);

  // Deductions = automatic late penalty + any advance taken this month.
  const totalDeductions = round2(effLatePenalty + advance);
  // Salary BEFORE overtime = earned-for-days minus deductions PLUS the food
  // allowance (mam wants base earning and the OT add-on shown separately).
  // Net pay then = before-OT + OT.
  const netBeforeOt = round2(grossEarned - totalDeductions + food);
  const netPay = round2(grossEarned + otPay - totalDeductions + food);
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
    paid_days: round2(effPaidDays),
    paid_days_auto: round2(paidDays),                 // before any manual override
    paid_days_overridden: pdOverridden,
    // Components of paid_days, so the UI can show the full formula
    // Paid Days = Present + Sunday + CL + Holiday (mam 2026-08-19).
    // present_days = the REAL worked-day equivalents from attendance
    // (full=1, half=0.5) — always the auto figure so a manual Paid Days
    // override doesn't distort the breakdown.
    present_days: round2(paidDays - sundayCount - paidLeaves - holidayDays),
    holiday_days: round2(holidayDays),
    missed_punch_out_count: missedPunchOutCount,
    missed_punch_out_grace: Math.min(missedPunchOutCount, 3),
    sunday_worked: sundayWorked,            // # of Sundays the person worked
    sunday_worked_pay: round2(sundayWorkedPay), // extra day-equivalents paid for them
    half_days: halfDays,
    absent_days: absentDays,
    late_marks: lateMarks,
    lates_converted_absent: latesAsAbsent,
    late_penalty: round2(effLatePenalty),
    late_penalty_auto: round2(latePenalty),           // automatic attendance-based amount
    late_penalty_overridden: false,
    late_days: lateDays,
    paid_leaves: effPaidLeaves,
    paid_leaves_auto: paidLeaves,                     // before any manual override
    cl_overridden: clOverridden,
    cl_override_diff: clOverridden ? round2(effPaidLeaves - paidLeaves) : 0,
    unpaid_leaves: unpaidLeaves,
    sunday_count: sundayCount,
    ot_eligible: !!employee.ot_eligible,
    roster: cut.roster,
    roster_label: cut.roster_label,
    late_after_time: cut.late_after_time,
    half_day_after_time: cut.half_day_after_time,
    ot_hours: round2(otHours),
    ot_threshold: settings.ot_threshold_hours,            // hours/day before OT (= 9)
    ot_per_hour_rate: round2(perHourRate * (settings.ot_rate_multiplier || 1)), // = salary/days/9
    gross_earned: round2(grossEarned),
    ot_pay: round2(otPay),
    net_before_ot: netBeforeOt,   // salary before overtime is added
    // Earnings breakdown (Basic + Conveyance + HRA + Adhoc + Misc = gross)
    basic_pay: finalBasicPay,
    conveyance: conveyance,
    hra: hra,
    adhoc: adhoc,
    misc: misc,
    total_earnings: round2(finalBasicPay + conveyance + hra + adhoc + misc),
    advance,
    food,
    late_penalty_only: round2(effLatePenalty),
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
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(y, m - 1, d).getDay()];
}

function getEligiblePayrollEmployees(db, month) {
  const [y, m] = month.split('-').map(Number);
  const totalDays = new Date(y, m, 0).getDate();
  const startDate = `${month}-01`;
  const endDate = `${month}-${pad(totalDays)}`;

  return db.prepare(`
    SELECT id, user_id, name, department, designation, join_date, exit_date, status, salary,
           ot_eligible, cl_eligible, cl_opening_balance, roster, email, personal_email,
           (SELECT staff_type FROM users WHERE id=employees.user_id) AS staff_type
      FROM employees
     WHERE salary > 0
       AND (
         (status = 'active' AND (join_date IS NULL OR join_date <= ?))
         OR id IN (SELECT employee_id FROM payroll_runs WHERE month = ? AND employee_id IS NOT NULL)
         OR (user_id IS NOT NULL AND user_id IN (
              SELECT user_id FROM attendance WHERE date BETWEEN ? AND ? AND (punch_in_time IS NOT NULL OR admin_marked = 1)
            ))
         OR (
              status IN ('inactive', 'terminated')
          AND exit_date IS NOT NULL
          AND exit_date >= ?
          AND (join_date IS NULL OR join_date <= ?)
         )
       )
     ORDER BY name COLLATE NOCASE
  `).all(endDate, month, startDate, endDate, startDate, endDate);
}

// GET monthly payroll for ALL employees
router.get('/calculate', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    const settings = getSettings(db);
    const employees = getEligiblePayrollEmployees(db, month);
    // Active employees with NO salary set are silently excluded from payroll —
    // surface them so admin knows who's missing and why (mam 2026-06-12:
    // "X not in payroll even they present").  Salary, not attendance, gates
    // inclusion.
    const excludedNoSalary = db.prepare(
      `SELECT id, name FROM employees WHERE status='active' AND (salary IS NULL OR salary <= 0) ORDER BY name COLLATE NOCASE`
    ).all();

    // If a run is finalised for this month, return saved snapshots; else live-calc
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    const out = employees.map(emp => {
      if (finalised) {
        const snap = db.prepare(
          `SELECT pr.*, u.name AS finalised_by_name FROM payroll_runs pr
           LEFT JOIN users u ON u.id = pr.finalised_by
           WHERE pr.month=? AND pr.employee_id=?`
        ).get(month, emp.id);
        // payroll_runs has no department column, so a finalised month's
        // snapshot rows come back with a blank Dept (table + Export Excel).
        // Overlay it from the live employee row already in hand.
        if (snap) return {
          ...snap,
          staff_type: emp.staff_type,
          department: emp.department,
          designation: emp.designation,
          status: emp.status || snap.status,
          sunday_count: snap.sundays,
          locked: true,
          email: emp.personal_email || '',
          personal_email: emp.personal_email || '',
          work_email: emp.email || '',
          email_sent_at: snap.email_sent_at,
          email_sent_to: snap.email_sent_to,
        };
      }
      return {
        ...calculateForEmployee(db, settings, emp, month),
        staff_type: emp.staff_type,
        department: emp.department,
        designation: emp.designation,
        status: emp.status,
        email: emp.personal_email || '',
        personal_email: emp.personal_email || '',
        work_email: emp.email || '',
        email_sent_at: null,
        email_sent_to: null,
      };
    });

    res.json({ month, settings, employees: out, excluded_no_salary: excludedNoSalary });
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
    const live = calculateForEmployee(db, settings, emp, month);

    // If month is finalised, return the frozen snapshot from payroll_runs so modal and slips never drift
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (finalised) {
      const snap = db.prepare(
        `SELECT pr.*, u.name AS finalised_by_name FROM payroll_runs pr
         LEFT JOIN users u ON u.id = pr.finalised_by
         WHERE pr.month=? AND pr.employee_id=?`
      ).get(month, emp.id);
      if (snap) {
        let snapBreakdown = null;
        if (snap.breakdown_json) {
          try { snapBreakdown = JSON.parse(snap.breakdown_json); } catch (_) { }
        }
        return res.json({
          month,
          settings,
          ...live,
          ...snap,
          sunday_count: snap.sundays,
          locked: true,
          email: emp.personal_email || '',
          personal_email: emp.personal_email || '',
          work_email: emp.email || '',
          email_sent_at: snap.email_sent_at,
          email_sent_to: snap.email_sent_to,
          breakdown: (snapBreakdown && snapBreakdown.length > 0) ? snapBreakdown : live.breakdown,
        });
      }
    }

    res.json({
      month,
      settings,
      ...live,
      email: emp.personal_email || '',
      personal_email: emp.personal_email || '',
      work_email: emp.email || '',
      email_sent_at: null,
      email_sent_to: null,
    });
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
    // Re-finalise guard (SEPL 2026-07): finalise is a one-way snapshot. If the
    // month is already finalised, refuse to overwrite it with fresh live
    // numbers — the admin must explicitly /unlock first. Prevents a silent
    // re-run from clobbering a frozen, possibly-already-paid month.
    const alreadyFinal = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (alreadyFinal > 0) return res.status(409).json({ error: `${month} is already finalised. Unlock it first if you really need to re-finalise.` });

    // ─── Early-finalise guard (mam 2026-08-19) ───────────────────────
    // Finalising freezes a snapshot; a month frozen before it ends keeps
    // paying the partial figure forever and every later attendance edit is
    // silently invisible. July 2026 was finalised on day 2 of 31 and read
    // "2 paid days" for the whole company weeks later. The UI already
    // refuses this, but the guard has to live HERE too — a stale browser
    // bundle or a direct API call bypasses the client entirely.
    const istNow2 = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const nowY = istNow2.getUTCFullYear(), nowM = istNow2.getUTCMonth() + 1, nowD = istNow2.getUTCDate();
    const [fy, fmn] = month.split('-').map(Number);
    if (fy > nowY || (fy === nowY && fmn > nowM)) {
      return res.status(409).json({ error: `${month} hasn't started yet — finalising it would freeze zero paid days for everyone.` });
    }
    if (fy === nowY && fmn === nowM) {
      const totalDays = daysInMonth(month);
      const daysLeft = totalDays - nowD;
      if (daysLeft > 5) {
        return res.status(409).json({
          error: `${month} is only on day ${nowD} of ${totalDays} — finalising now would freeze the month and exclude the remaining ${daysLeft} days for everyone. Finalise closer to month-end.`,
        });
      }
    }
    ensureHolidaysTable(db);   // payroll_runs.holiday_days column must exist before the INSERT below is prepared
    const settings = getSettings(db);
    const employees = getEligiblePayrollEmployees(db, month);

    const ins = db.prepare(`INSERT OR REPLACE INTO payroll_runs (
      month, employee_id, employee_name, base_salary, working_days, paid_days, half_days,
      absent_days, late_marks, lates_converted_absent, late_penalty, paid_leaves, unpaid_leaves, sundays,
      ot_hours, gross_earned, ot_pay, ot_eligible, ot_per_hour_rate, ot_threshold, net_before_ot, roster, deductions, net_pay,
      basic_pay, conveyance, hra, adhoc, misc, advance,
      present_days, sunday_worked_pay, holiday_days,
      breakdown_json, status, finalised_by, finalised_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`);

    const tx = db.transaction(() => {
      for (const emp of employees) {
        const r = calculateForEmployee(db, settings, emp, month);
        ins.run(
          month, emp.id, emp.name, r.base_salary, r.working_days, r.paid_days, r.half_days,
          r.absent_days, r.late_marks, r.lates_converted_absent, r.late_penalty, r.paid_leaves, r.unpaid_leaves, r.sunday_count,
          r.ot_hours, r.gross_earned, r.ot_pay, (emp.ot_eligible ? 1 : 0), r.ot_per_hour_rate, r.ot_threshold, r.net_before_ot, (emp.roster || 'general'), r.deductions, r.net_pay,
          r.basic_pay, r.conveyance, r.hra, r.adhoc, r.misc, r.advance,
          r.present_days, r.sunday_worked_pay, r.holiday_days || 0,
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

// PUT mark an employee Paid / unpaid for a finalised month (mam 2026-06-13:
// "after account will give option paid ... if we dont pay someone that is in
// our record").  Only works once the month is finalised — the snapshot row
// must exist.  Gated by payroll edit (Accounts); admins always pass.
router.put('/paid/:employee_id', requirePermission('payroll', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const paid = req.body.paid ? 1 : 0;
    const row = db.prepare('SELECT id FROM payroll_runs WHERE month=? AND employee_id=?').get(month, req.params.employee_id);
    if (!row) return res.status(409).json({ error: `Finalise ${month} first — you can only mark salary paid after it's finalised.` });
    if (paid) {
      db.prepare('UPDATE payroll_runs SET paid=1, paid_at=CURRENT_TIMESTAMP, paid_by=? WHERE id=?').run(req.user.id, row.id);
    } else {
      db.prepare('UPDATE payroll_runs SET paid=0, paid_at=NULL, paid_by=NULL WHERE id=?').run(row.id);
    }
    res.json({ message: paid ? 'Marked paid' : 'Marked unpaid', paid: !!paid });
  } catch (err) {
    console.error('payroll paid update error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST unlock a finalised month (admin only — for corrections)
router.post('/unlock', adminOnly, (req, res) => {
  const { month } = req.body;
  if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
  const db = getDb();
  const ip = (req.headers['x-forwarded-for'] || req.ip || '').toString().split(',')[0].trim() || null;
  const ua = req.headers['user-agent'] || null;
  // Integrity guard (SEPL 2026-07): once ANY employee in this month is marked
  // PAID, final payment is done and the month is a permanent record. Unlocking
  // would delete the frozen snapshot and let the next open live-recompute base
  // salary / OT / deductions from CURRENT data — silently corrupting history
  // (the "June showed unlocked" incident). Block it, and log every attempt so
  // a reopen is never anonymous again.
  const paidCount = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND paid=1').get(month).c;
  if (paidCount > 0) {
    logAuditEvent({ user: req.user, action: 'PAYROLL_UNLOCK_BLOCKED', entity_type: 'payroll', entity_label: month, method: 'POST', path: '/api/payroll/unlock', status_code: 409, ip, user_agent: ua });
    return res.status(409).json({ error: `${month} has ${paidCount} employee(s) already marked paid — this is a locked payroll record and cannot be unlocked. Reverse those payments first if a correction is genuinely required.` });
  }
  const result = db.prepare('DELETE FROM payroll_runs WHERE month=? AND paid=0').run(month);
  logAuditEvent({ user: req.user, action: 'PAYROLL_UNLOCK', entity_type: 'payroll', entity_label: month, method: 'POST', path: '/api/payroll/unlock', status_code: 200, ip, user_agent: ua, after: { removed: result.changes } });
  res.json({ message: `Unlocked ${month}`, removed: result.changes });
});

// PUT an employee's advance-salary amount for a month (admin). Deducted
// from that month's net pay. Blocked once the month is finalised.
router.put('/advance/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change an advance.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, amount, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         amount = excluded.amount, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Advance saved', amount: round2(amount) });
  } catch (err) {
    console.error('advance update error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT an employee's food allowance for a month (admin). ADDED to that
// month's net pay. Blocked once the month is finalised. Stored on the same
// payroll_advances row as the advance (mam 2026-06-12).
router.put('/food/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ error: 'amount must be a non-negative number' });

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to change food.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, food, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         food = excluded.food, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, round2(amount), req.user.id);

    res.json({ message: 'Food saved', amount: round2(amount) });
  } catch (err) {
    console.error('food update error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT a manual monthly override for Paid Days / CL / Late ₹ (admin, mam
// 2026-06-13: "give me edit option on days, CL, late so i can give salary
// now").  field ∈ paid_days | cl. A blank / null value RESETS
// to the auto-calculated number.  Blocked once the month is finalised.
router.put('/override/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const { month, field } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const COLS = { paid_days: 'paid_days_override', cl: 'cl_override' };
    const col = COLS[field];
    if (!col) return res.status(400).json({ error: 'field must be paid_days or cl; late deductions are automatic' });

    const raw = req.body.value;
    const reset = raw === '' || raw === null || raw === undefined;
    let value = null;
    if (!reset) {
      value = Number(raw);
      if (!Number.isFinite(value) || value < 0) return res.status(400).json({ error: 'value must be a non-negative number' });
      // Paid days can exceed the calendar days — worked Sundays add bonus days
      // on top (mam 2026-06-13: Manoj = 34). CL stays within the month.
      const dayMax = field === 'cl' ? 31 : 60;
      if (value > dayMax) {
        return res.status(400).json({ error: `${field === 'cl' ? 'CL' : 'days'} cannot exceed ${dayMax}` });
      }
      value = round2(value);
    }

    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    if (locked) return res.status(409).json({ error: `${month} is finalised — unlock it first to edit it.` });

    db.prepare(
      `INSERT INTO payroll_advances (month, employee_id, ${col}, updated_by, updated_at)
       VALUES (?,?,?,?,CURRENT_TIMESTAMP)
       ON CONFLICT(month, employee_id) DO UPDATE SET
         ${col} = excluded.${col}, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`
    ).run(month, emp.id, value, req.user.id);

    res.json({ message: reset ? 'Reset to auto' : 'Override saved', value });
  } catch (err) {
    console.error('override update error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CL Leave Balances (annual, with carry-forward) ────────────────────
// Mam: "show me we give CL to someone and carry forward, where i can show".
// Model (decided 2026-06-08): the monthly CL allowance is the same for
// everyone (payroll_settings.cl_per_month); each person accrues it month
// by month across the YEAR, CL taken is deducted, and whatever is left at
// year-end is carried into next year as their opening balance.
//
//   remaining(year) = cl_opening_balance            (carried from prev year)
//                   + cl_per_month × months_elapsed  (accrued this year)
//                   − CL days taken this year        (approved casual leaves)
//
// months_elapsed = 12 for a past year, current calendar month for the
// running year, 0 for a future year. Per-employee cl_eligible=0 → no accrual.

function computeLeaveBalances(db, year) {
  const settings = getSettings(db);
  const clPerMonth = +settings.cl_per_month || 0;

  const now = new Date();
  const curYear = now.getFullYear();
  const curMonth = now.getMonth() + 1; // 1-12
  const monthsElapsed = year < curYear ? 12 : (year > curYear ? 0 : curMonth);

  const yStart = `${year}-01-01`;
  const yEnd = `${year}-12-31`;

  const employees = db.prepare(
    `SELECT id, user_id, name, department, designation,
            COALESCE(cl_eligible, 1) AS cl_eligible,
            COALESCE(ot_eligible, 0) AS ot_eligible,
            COALESCE(cl_opening_balance, 0) AS cl_opening_balance
       FROM employees WHERE status='active' ORDER BY name COLLATE NOCASE`
  ).all();

  // CL days taken this year per user (approved casual leaves whose start
  // falls in the year). days defaults to 1 when the column is null.
  const usedStmt = db.prepare(
    `SELECT COALESCE(SUM(COALESCE(days, 1)), 0) AS used
       FROM leave_requests
      WHERE user_id = ? AND leave_type = 'casual' AND status = 'approved'
        AND from_date BETWEEN ? AND ?`
  );

  return employees.map(e => {
    const eligible = e.cl_eligible ? 1 : 0;
    const opening = round2(e.cl_opening_balance);
    const accrued = eligible ? round2(clPerMonth * monthsElapsed) : 0;
    const used = e.user_id ? round2(usedStmt.get(e.user_id, yStart, yEnd).used) : 0;
    const remaining = round2(opening + accrued - used);
    return {
      employee_id: e.id,
      employee_name: e.name,
      department: e.department || null,
      designation: e.designation || null,
      cl_eligible: eligible,
      ot_eligible: e.ot_eligible ? 1 : 0,
      opening_balance: opening,
      cl_per_month: clPerMonth,
      months_elapsed: monthsElapsed,
      accrued,
      used,
      remaining,
      user_linked: !!e.user_id,
    };
  });
}

// GET annual CL balance sheet for all employees.
router.get('/leave-balances', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const db = getDb();
    res.json({ year, cl_per_month: +getSettings(db).cl_per_month || 0, rows: computeLeaveBalances(db, year) });
  } catch (err) {
    console.error('leave-balances error', err);
    res.status(500).json({ error: err.message });
  }
});

// PUT one employee's carry-forward opening balance + CL eligibility (admin).
router.put('/leave-balance/:employee_id', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const emp = db.prepare('SELECT id FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });
    const sets = [];
    const vals = [];
    if (req.body.cl_opening_balance !== undefined) {
      const v = Number(req.body.cl_opening_balance);
      if (!Number.isFinite(v)) return res.status(400).json({ error: 'cl_opening_balance must be a number' });
      sets.push('cl_opening_balance = ?'); vals.push(v);
    }
    if (req.body.cl_eligible !== undefined) {
      sets.push('cl_eligible = ?'); vals.push(req.body.cl_eligible ? 1 : 0);
    }
    if (req.body.ot_eligible !== undefined) {
      sets.push('ot_eligible = ?'); vals.push(req.body.ot_eligible ? 1 : 0);
    }
    if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
    vals.push(emp.id);
    db.prepare(`UPDATE employees SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) {
    console.error('leave-balance update error', err);
    res.status(500).json({ error: err.message });
  }
});

// POST roll a year's leftover CL into next year's opening balance (admin).
// Sets each employee's cl_opening_balance = remaining(year). Idempotent in
// effect only if re-run on the SAME source year — re-running after CL is
// taken in the new year would double count, so the UI guards it to the
// completed year.
router.post('/leave-balances/rollover', adminOnly, (req, res) => {
  try {
    const year = parseInt(req.body.year, 10);
    if (!year) return res.status(400).json({ error: 'year required' });
    const db = getDb();
    const rows = computeLeaveBalances(db, year);
    const upd = db.prepare('UPDATE employees SET cl_opening_balance = ? WHERE id = ?');
    const tx = db.transaction(() => {
      for (const r of rows) upd.run(Math.max(0, r.remaining), r.employee_id);
    });
    tx();
    res.json({ message: `Rolled ${year} leftover CL into opening balance for ${rows.length} employees`, count: rows.length });
  } catch (err) {
    console.error('leave-balances rollover error', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── Declared holidays CRUD (mam 2026-08-19) ───────────────────────────
// Company-wide paid holidays (e.g. 15 Aug). Everyone with payroll view can
// read the list; only admin declares/removes. Finalised months are frozen
// snapshots, so editing the list never changes locked history.

// GET holidays for a month
router.get('/holidays', requirePermission('payroll', 'view'), (req, res) => {
  try {
    const month = req.query.month;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    ensureHolidaysTable(db);
    res.json(db.prepare(`SELECT date, name FROM payroll_holidays WHERE date LIKE ? ORDER BY date`).all(month + '-%'));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// A real calendar date, not just the right shape: '2026-02-30' / '2026-13-01'
// pass a regex but would silently never match any day in the payroll loop.
function isRealDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1) return false;
  return d <= new Date(y, m, 0).getDate();
}
// A finalised month is a frozen snapshot — changing its holidays would be a
// no-op on pay yet make the screen disagree with what was actually paid.
// Refuse it the same way /advance, /food and /override do.
function assertMonthOpen(db, date, res) {
  const month = date.slice(0, 7);
  const locked = db.prepare('SELECT COUNT(*) AS c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
  if (locked) { res.status(409).json({ error: `${month} is finalised — unlock it first to change its holidays.` }); return false; }
  return true;
}

// POST declare a holiday {date:'YYYY-MM-DD', name}
router.post('/holidays', adminOnly, (req, res) => {
  try {
    const date = String(req.body?.date || '').trim();
    const name = String(req.body?.name || '').trim().slice(0, 60);
    if (!isRealDate(date)) return res.status(400).json({ error: 'Pick a real calendar date (YYYY-MM-DD)' });
    if (!name) return res.status(400).json({ error: 'Holiday name is required (e.g. Independence Day)' });
    const db = getDb();
    ensureHolidaysTable(db);
    if (!assertMonthOpen(db, date, res)) return;
    db.prepare(`INSERT INTO payroll_holidays (date, name, created_by) VALUES (?,?,?)
                ON CONFLICT(date) DO UPDATE SET name = excluded.name`).run(date, name, req.user.id);
    logAuditEvent({ user: req.user, action: 'PAYROLL_HOLIDAY_SET', entity_type: 'payroll', entity_label: `${date} ${name}`, method: 'POST', path: '/api/payroll/holidays', status_code: 200 });
    res.json({ message: `Holiday saved — ${date} ${name}. Employees who have joined by this date are eligible for holiday pay.`, date, name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE a declared holiday
router.delete('/holidays/:date', adminOnly, (req, res) => {
  try {
    const date = String(req.params.date || '').trim();
    if (!isRealDate(date)) return res.status(400).json({ error: 'Pick a real calendar date (YYYY-MM-DD)' });
    const db = getDb();
    ensureHolidaysTable(db);
    if (!assertMonthOpen(db, date, res)) return;
    const r = db.prepare('DELETE FROM payroll_holidays WHERE date=?').run(date);
    if (!r.changes) return res.status(404).json({ error: 'No holiday declared on that date' });
    logAuditEvent({ user: req.user, action: 'PAYROLL_HOLIDAY_REMOVE', entity_type: 'payroll', entity_label: date, method: 'DELETE', path: '/api/payroll/holidays', status_code: 200 });
    res.json({ message: `Holiday removed — ${date}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Salary Slip Email Endpoints (TSK-0924) ──────────────────────────────────

// GET email configuration status
router.get('/email-status', requirePermission('payroll', 'view'), (req, res) => {
  try {
    res.json({ configured: isConfigured() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET preview single salary slip HTML & structured data
router.get('/preview-slip/:employee_id', requirePermission('payroll', 'view'), async (req, res) => {
  try {
    const { month } = req.query;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    ensureHolidaysTable(db);
    const settings = getSettings(db);
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    let slipData;
    if (finalised) {
      const snap = db.prepare('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?').get(month, emp.id);
      if (snap) {
        const live = calculateForEmployee(db, settings, emp, month);
        slipData = { ...live, ...snap, settings };
      } else {
        slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
      }
    } else {
      slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
    }

    const { html, text, payPeriod } = generateSalarySlipEmailContent(slipData, month, emp);
    return res.json({ success: true, html, text, payPeriod, slipData });
  } catch (err) {
    console.error('Error previewing salary slip:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST send single salary slip via email
router.post('/send-slip/:employee_id', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const { month, email_override } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const db = getDb();
    ensureHolidaysTable(db);
    const settings = getSettings(db);
    const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(req.params.employee_id);
    if (!emp) return res.status(404).json({ error: 'Employee not found' });

    const targetEmail = (email_override || emp.personal_email || '').trim();
    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({ error: `No personal email address found for ${emp.name}. Salary slips are sent exclusively to personal email. Please update personal email in Employee Master or enter one.` });
    }

    // Prefer frozen finalised snapshot if finalised; else live calculation
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;
    let slipData;
    if (finalised) {
      const snap = db.prepare('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?').get(month, emp.id);
      if (snap) {
        const live = calculateForEmployee(db, settings, emp, month);
        slipData = { ...live, ...snap, settings };
      } else {
        slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
      }
    } else {
      slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
    }

    const { html, text, payPeriod } = generateSalarySlipEmailContent(slipData, month, emp);
    const mailResult = await sendEmail({
      to: targetEmail,
      subject: `Salary Slip for ${payPeriod} — ${emp.name} (Secured Engineers)`,
      html,
      text,
    });

    if (mailResult.skipped) {
      return res.status(422).json({
        success: false,
        skipped: true,
        reason: mailResult.reason,
        error: `Email sending skipped: ${mailResult.reason}. Please check Admin -> Email Settings.`,
      });
    }

    // Persist email delivery timestamp in payroll_runs if finalised snapshot exists
    if (finalised) {
      db.prepare(`UPDATE payroll_runs SET email_sent_at=CURRENT_TIMESTAMP, email_sent_to=? WHERE month=? AND employee_id=?`)
        .run(targetEmail, emp.id);
    }

    logAuditEvent({
      user: req.user,
      action: 'PAYROLL_SLIP_EMAIL_SENT',
      entity_type: 'payroll',
      entity_label: `${emp.name} (${month})`,
      method: 'POST',
      path: `/api/payroll/send-slip/${emp.id}`,
      status_code: 200,
    });

    return res.json({
      success: true,
      message: `Salary slip sent successfully to ${targetEmail}`,
      email_sent_to: targetEmail,
      email_sent_at: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error sending salary slip email:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST send bulk salary slips via email
router.post('/send-bulk-slips', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const { month, recipients } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return res.status(400).json({ error: 'recipients list is required' });
    }

    const db = getDb();
    ensureHolidaysTable(db);
    const settings = getSettings(db);
    const finalised = db.prepare('SELECT COUNT(*) as c FROM payroll_runs WHERE month=? AND status=?').get(month, 'finalised').c;

    const results = [];
    let sentCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const item of recipients) {
      const empId = item.employee_id;
      const emp = db.prepare('SELECT * FROM employees WHERE id=?').get(empId);
      if (!emp) {
        results.push({ employee_id: empId, name: 'Unknown', status: 'failed', error: 'Employee not found' });
        failedCount++;
        continue;
      }

      const targetEmail = (item.email || emp.personal_email || '').trim();
      if (!targetEmail || !targetEmail.includes('@')) {
        results.push({ employee_id: emp.id, name: emp.name, status: 'failed', error: 'No personal email configured' });
        failedCount++;
        continue;
      }

      let slipData;
      if (finalised) {
        const snap = db.prepare('SELECT * FROM payroll_runs WHERE month=? AND employee_id=?').get(month, emp.id);
        if (snap) {
          const live = calculateForEmployee(db, settings, emp, month);
          slipData = { ...live, ...snap, settings };
        } else {
          slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
        }
      } else {
        slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
      }

      const { html, text, payPeriod } = generateSalarySlipEmailContent(slipData, month, emp);

      try {
        const mailResult = await sendEmail({
          to: targetEmail,
          subject: `Salary Slip for ${payPeriod} — ${emp.name} (Secured Engineers)`,
          html,
          text,
        });

        if (mailResult.skipped) {
          results.push({ employee_id: emp.id, name: emp.name, email: targetEmail, status: 'skipped', reason: mailResult.reason });
          skippedCount++;
        } else {
          if (finalised) {
            db.prepare(`UPDATE payroll_runs SET email_sent_at=CURRENT_TIMESTAMP, email_sent_to=? WHERE month=? AND employee_id=?`)
              .run(targetEmail, emp.id);
          }
          results.push({ employee_id: emp.id, name: emp.name, email: targetEmail, status: 'sent' });
          sentCount++;
        }
      } catch (sendErr) {
        results.push({ employee_id: emp.id, name: emp.name, email: targetEmail, status: 'failed', error: sendErr.message });
        failedCount++;
      }
    }

    logAuditEvent({
      user: req.user,
      action: 'PAYROLL_BULK_SLIP_EMAIL',
      entity_type: 'payroll',
      entity_label: `${month} (${sentCount} sent, ${failedCount} failed, ${skippedCount} skipped)`,
      method: 'POST',
      path: '/api/payroll/send-bulk-slips',
      status_code: 200,
    });

    res.json({
      message: `Processed ${recipients.length} salary slips: ${sentCount} sent, ${skippedCount} skipped, ${failedCount} failed`,
      sentCount,
      skippedCount,
      failedCount,
      results,
    });
  } catch (err) {
    console.error('Error in send-bulk-slips:', err);
    res.status(500).json({ error: err.message });
  }
});

// POST send test / preview salary slip email
router.post('/send-test-slip', requirePermission('payroll', 'edit'), async (req, res) => {
  try {
    const { month, test_email, employee_id } = req.body;
    if (!month || !/^\d{4}-\d{2}$/.test(month)) return res.status(400).json({ error: 'month=YYYY-MM required' });
    const targetEmail = (test_email || '').trim();
    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({ error: 'Valid test_email is required' });
    }

    const db = getDb();
    ensureHolidaysTable(db);
    const settings = getSettings(db);

    let emp;
    if (employee_id) {
      emp = db.prepare('SELECT * FROM employees WHERE id=?').get(employee_id);
    }
    if (!emp) {
      emp = db.prepare(`SELECT * FROM employees WHERE status='active' AND salary > 0 LIMIT 1`).get();
    }
    if (!emp) {
      return res.status(404).json({ error: 'No active employee with salary found to generate sample slip' });
    }

    const slipData = { ...calculateForEmployee(db, settings, emp, month), settings };
    const { html, text, payPeriod } = generateSalarySlipEmailContent(slipData, month, emp, true);

    const mailResult = await sendEmail({
      to: targetEmail,
      subject: `[TEST SAMPLE] Salary Slip for ${payPeriod} — ${emp.name} (Secured Engineers)`,
      html,
      text,
    });

    if (mailResult.skipped) {
      return res.status(422).json({
        success: false,
        skipped: true,
        reason: mailResult.reason,
        error: `Email skipped: ${mailResult.reason}. Please configure SMTP in Admin -> Email Settings.`,
      });
    }

    return res.json({
      success: true,
      message: `Test salary slip email sent to ${targetEmail} (Sample Employee: ${emp.name})`,
    });
  } catch (err) {
    console.error('Error in send-test-slip:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

