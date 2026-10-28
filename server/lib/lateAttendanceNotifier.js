// server/lib/lateAttendanceNotifier.js
//
// Implements TK-01401 — automated smart-tiered WhatsApp & Email notifications
// when an employee punches in late.
//
// Tiers:
//   1. SHORT_LEAVE_PENDING: Short leave is applied and awaiting manager approval.
//      Notifies employee that their application is recorded and ₹0 is deducted pending review.
//   2. GRACE_WARNING (1st to 3rd late in month): ₹0 deduction, warns how many
//      grace days remain before ₹20/min deduction kicks in.
//   3. PER_MINUTE_DEDUCTION (4th late onwards): exact ₹ deduction calculated
//      at late_per_minute_rate (default ₹20/min) matching payroll.js line 1159.
//   4. HALF_DAY (arrival after half-day cutoff): 0.5 day salary deduction
//      calculated as (monthly_salary / days_in_month * 0.5) matching payroll.js line 1093.
//      Also checks remaining monthly Short Leave quota and suggests applying to avoid deduction.
//
// Hard Guarantees:
//   - Zero performance impact on punch-in API (runs asynchronously / non-blocking).
//   - Respects Sunday exemption, salary_exempt (fixed salary), and approved short leaves.
//   - Deduplication via unique dedupe_key so no employee is messaged twice for one day.
//   - Never throws or crashes the calling route.

const { rosterCutoffs } = require('./roster');
const { sendText } = require('../services/notify');
const { sendEmail } = require('./email');

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function timeToMinutes(t) {
  if (!t) return null;
  if (t.includes('T') || t.includes(' ')) {
    const d = new Date(t);
    if (isNaN(d)) return null;
    const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
    return ist.getUTCHours() * 60 + ist.getUTCMinutes();
  }
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + (m || 0);
}

function formatMinutesToTime(min) {
  if (min == null) return '';
  const h = Math.floor(min / 60);
  const m = min % 60;
  const period = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 || 12;
  return `${String(h12).padStart(2, '0')}:${String(m).padStart(2, '0')} ${period}`;
}

function getIstDateParts(isoOrDateStr) {
  const d = new Date(isoOrDateStr || Date.now());
  const ist = new Date(d.getTime() + 5.5 * 60 * 60 * 1000);
  return {
    year: ist.getUTCFullYear(),
    month: ist.getUTCMonth() + 1,
    day: ist.getUTCDate(),
    dayOfWeek: ist.getUTCDay(), // 0=Sun
    hours: ist.getUTCHours(),
    minutes: ist.getUTCMinutes(),
  };
}

/**
 * Counts previous late punch days in the current calendar month prior to `date`.
 * Matches the exact filtering logic in payroll.js lines 1099-1104.
 */
function countPreviousLatesThisMonth(db, userId, date, lateAfterMin, halfDayAfterMin, skipHalfDayIfShortLeave) {
  const monthStart = `${date.slice(0, 7)}-01`;
  try {
    const rows = db.prepare(`
      SELECT date, punch_in_time, status, admin_marked
      FROM attendance
      WHERE user_id = ? AND date >= ? AND date < ? AND punch_in_time IS NOT NULL
      ORDER BY date ASC
    `).all(userId, monthStart, date);

    let count = 0;
    for (const r of rows) {
      const dObj = new Date(r.date + 'T00:00:00Z');
      if (dObj.getUTCDay() === 0) continue; // Sunday rule

      if (skipHalfDayIfShortLeave) {
        try {
          const sl = db.prepare(`
            SELECT id FROM leave_requests 
            WHERE user_id = ? AND status IN ('approved', 'pending') AND leave_type = 'short_leave' 
              AND ? BETWEEN from_date AND to_date
          `).get(userId, r.date);
          if (sl) continue;
        } catch (_) {}
      }

      if (r.admin_marked && r.status === 'present') continue;

      const inMin = timeToMinutes(r.punch_in_time);
      if (inMin !== null && inMin >= lateAfterMin && inMin <= halfDayAfterMin) {
        count++;
      }
    }
    return count;
  } catch (err) {
    console.warn('[lateAttendanceNotifier] countPreviousLates error:', err.message);
    return 0;
  }
}

/**
 * Calculates remaining monthly Short Leave quota (default 4 hours per month).
 */
function getMonthlyShortLeaveRemaining(db, userId, date) {
  try {
    const monthPrefix = date.slice(0, 7);
    const row = db.prepare(`
      SELECT COALESCE(SUM(hours), 0) AS used
      FROM leave_requests
      WHERE user_id = ? AND leave_type = 'short_leave' AND status IN ('approved', 'pending')
        AND from_date LIKE ?
    `).get(userId, `${monthPrefix}%`);
    const usedHours = Number(row?.used || 0);
    return Math.max(0, round2(4 - usedHours));
  } catch (_) {
    return 0;
  }
}

/**
 * Evaluates whether an employee's punch-in is late, which tier applies,
 * and the exact salary deduction amount.
 */
function evaluateLateAttendance(db, { userId, punchInTime, date }) {
  if (!db || !userId || !punchInTime || !date) {
    return { shouldNotify: false, reason: 'missing_parameters' };
  }

  const istParts = getIstDateParts(punchInTime);
  if (istParts.dayOfWeek === 0) {
    // Sunday rule: no late marks or late deductions apply on Sunday
    return { shouldNotify: false, reason: 'sunday_work' };
  }

  // Fetch employee and user profiles
  let employee = null;
  try {
    employee = db.prepare('SELECT * FROM employees WHERE user_id=?').get(userId);
  } catch (_) {}

  let user = null;
  try {
    user = db.prepare('SELECT id, name, email, phone, auto_mark_present FROM users WHERE id=?').get(userId);
  } catch (_) {}

  if (!user && !employee) {
    return { shouldNotify: false, reason: 'user_not_found' };
  }

  // Exempt employees (directors / fixed salary or auto-mark allow-list) are never docked
  if (employee?.salary_exempt === 1 || user?.auto_mark_present === 1) {
    return { shouldNotify: false, reason: 'salary_exempt' };
  }

  // Fetch payroll settings
  let settings = {};
  try {
    settings = db.prepare('SELECT * FROM payroll_settings WHERE id=1').get() || {};
  } catch (_) {}

  // Check if employee has an active short leave application for today (pending or approved)
  let shortLeaveApp = null;
  if (settings.skip_half_day_if_short_leave) {
    try {
      shortLeaveApp = db.prepare(`
        SELECT id, status, hours FROM leave_requests 
        WHERE user_id=? AND leave_type='short_leave' AND status IN ('approved', 'pending')
          AND ? BETWEEN from_date AND to_date
      `).get(userId, date);
    } catch (_) {}
  }

  // If already approved, completely excused (no penalty, no message needed)
  if (shortLeaveApp && shortLeaveApp.status === 'approved') {
    return { shouldNotify: false, reason: 'excused_by_approved_short_leave' };
  }

  // Effective cutoffs based on the employee's roster (general vs early vs late)
  const cut = rosterCutoffs(settings, employee?.roster);
  const lateAfterMin = timeToMinutes(cut.late_after_time) ?? (9 * 60 + 46);
  const halfDayAfterMin = timeToMinutes(cut.half_day_after_time) ?? (10 * 60);
  const shiftStartMin = timeToMinutes(cut.roster_start) ?? (9 * 60 + 30);

  const punchInMin = timeToMinutes(punchInTime);
  if (punchInMin === null) {
    return { shouldNotify: false, reason: 'invalid_punch_time' };
  }

  // On time arrival (within shift start + 15 min buffer)
  if (punchInMin < lateAfterMin) {
    return { shouldNotify: false, status: 'present', reason: 'on_time' };
  }

  const punchTimeFormatted = formatMinutesToTime(punchInMin);
  const shiftStartFormatted = formatMinutesToTime(shiftStartMin);
  const lateCutoffFormatted = formatMinutesToTime(lateAfterMin);
  const halfDayCutoffFormatted = formatMinutesToTime(halfDayAfterMin);

  const empName = user?.name || employee?.name || 'Employee';
  const empEmail = user?.email || employee?.email || null;
  const empPhone = user?.phone || employee?.phone || null;

  // -------------------------------------------------------------
  // TIER: SHORT_LEAVE_PENDING
  // Employee already applied for short leave, but approval takes 3-4 days.
  // We notify them that their application is recorded and ₹0 is deducted pending review.
  // -------------------------------------------------------------
  if (shortLeaveApp && shortLeaveApp.status === 'pending') {
    return {
      shouldNotify: true,
      tier: 'SHORT_LEAVE_PENDING',
      status: 'late',
      userId,
      date,
      punchInTime,
      punchTimeFormatted,
      shiftName: cut.roster_label || cut.roster,
      shiftStartFormatted,
      minutesLate: Math.max(1, punchInMin - lateAfterMin + 1),
      deduction: 0,
      shortLeaveHours: Number(shortLeaveApp.hours || 0),
      empName,
      empEmail,
      empPhone,
    };
  }

  const [yStr, mStr] = date.split('-');
  const daysInMonth = new Date(Number(yStr), Number(mStr), 0).getDate() || 30;
  const monthlySalary = Number(employee?.salary || 0);

  // -------------------------------------------------------------
  // TIER 3: Half-Day (Arrived past half-day cutoff)
  // Also calculates remaining monthly short leave quota and provides CTA.
  // -------------------------------------------------------------
  if (punchInMin > halfDayAfterMin) {
    const minutesAfterCutoff = punchInMin - halfDayAfterMin;
    const perDaySalary = daysInMonth > 0 ? (monthlySalary / daysInMonth) : 0;
    const deduction = round2(perDaySalary * 0.5);
    const shortLeaveHoursRemaining = getMonthlyShortLeaveRemaining(db, userId, date);

    return {
      shouldNotify: true,
      tier: 'HALF_DAY',
      status: 'half_day',
      userId,
      date,
      punchInTime,
      punchTimeFormatted,
      shiftName: cut.roster_label || cut.roster,
      shiftStartFormatted,
      halfDayCutoffFormatted,
      minutesLate: minutesAfterCutoff,
      monthlySalary,
      deduction,
      hasSalaryConfigured: monthlySalary > 0,
      shortLeaveHoursRemaining,
      empName,
      empEmail,
      empPhone,
    };
  }

  // -------------------------------------------------------------
  // TIER 1 & TIER 2: Late Arrival (Between Late Cutoff & Half-Day Cutoff)
  // Minutes late formula: punchInMin - lateAfter + 1 (matches payroll.js line 1102)
  // -------------------------------------------------------------
  const minutesLate = punchInMin - lateAfterMin + 1;
  const graceLimit = Number(settings.late_grace_count != null ? settings.late_grace_count : 3);
  const perMinuteRate = Number(settings.late_per_minute_rate != null ? settings.late_per_minute_rate : 20);

  const prevLates = countPreviousLatesThisMonth(db, userId, date, lateAfterMin, halfDayAfterMin, !!settings.skip_half_day_if_short_leave);
  const lateRank = prevLates + 1;

  if (lateRank <= graceLimit) {
    // TIER 1: Grace Late (₹0 deduction)
    const graceRemaining = Math.max(0, graceLimit - lateRank);
    return {
      shouldNotify: true,
      tier: 'GRACE_WARNING',
      status: 'late',
      userId,
      date,
      punchInTime,
      punchTimeFormatted,
      shiftName: cut.roster_label || cut.roster,
      shiftStartFormatted,
      lateCutoffFormatted,
      minutesLate,
      lateRank,
      graceLimit,
      graceRemaining,
      perMinuteRate,
      deduction: 0,
      empName,
      empEmail,
      empPhone,
    };
  }

  // TIER 2: Per-Minute Penalty (Exceeded monthly grace)
  const deduction = round2(minutesLate * perMinuteRate);
  return {
    shouldNotify: true,
    tier: 'PER_MINUTE_DEDUCTION',
    status: 'late',
    userId,
    date,
    punchInTime,
    punchTimeFormatted,
    shiftName: cut.roster_label || cut.roster,
    shiftStartFormatted,
    lateCutoffFormatted,
    minutesLate,
    lateRank,
    graceLimit,
    perMinuteRate,
    deduction,
    empName,
    empEmail,
    empPhone,
  };
}

/**
 * Builds message bodies and templates for WhatsApp, Email and In-App notification.
 */
function buildLateNotificationPayload(evalResult) {
  const {
    tier, empName, date, punchTimeFormatted, shiftName, shiftStartFormatted,
    minutesLate, deduction, lateRank, graceLimit, graceRemaining,
    perMinuteRate, halfDayCutoffFormatted, hasSalaryConfigured,
    shortLeaveHoursRemaining
  } = evalResult;

  // -------------------------------------------------------------
  // SHORT_LEAVE_PENDING TEMPLATE
  // -------------------------------------------------------------
  if (tier === 'SHORT_LEAVE_PENDING') {
    const whatsapp = 
`*SEPL Attendance Update* ℹ️

Dear *${empName}*,
You punched in at *${punchTimeFormatted} IST* on ${date} (${minutesLate} min late for your ${shiftName} shift starting at ${shiftStartFormatted}).

*Status:* Short Leave Applied (Pending Manager Approval)
*Today's Salary Deduction:* ₹0.00 (Pending Review)

_Your Short Leave application is registered in the ERP. Once approved by your Manager / HR, this delay will be excused with ₹0 deduction._

— Secured Engineers Pvt. Ltd.`;

    const emailSubject = `SEPL Attendance Notice: Short Leave Pending for ${date}`;
    const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #ffffff;">
  <div style="background: #2563eb; color: #ffffff; padding: 18px 24px;">
    <h2 style="margin: 0; font-size: 18px; font-weight: bold;">SEPL Attendance Update ℹ️</h2>
    <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">Short Leave Applied · Pending Approval</p>
  </div>
  <div style="padding: 24px; color: #1f2937;">
    <p style="font-size: 15px; margin-top: 0;">Dear <b>${empName}</b>,</p>
    <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
      You punched in at <b>${punchTimeFormatted} IST</b> on <b>${date}</b>. Our records show you have already submitted a <b>Short Leave application</b> for today.
    </p>

    <div style="background: #eff6ff; border-left: 4px solid #2563eb; padding: 14px 16px; border-radius: 4px; margin: 18px 0;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #1e40af; width: 45%;">Punch In Time:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #1e40af;">${punchTimeFormatted} IST</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #1e40af;">Short Leave Status:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #d97706;">Pending Manager Approval</td>
        </tr>
        <tr style="border-top: 1px dashed #93c5fd;">
          <td style="padding: 8px 0 4px 0; color: #1e40af; font-weight: bold; font-size: 14px;">Current Deduction:</td>
          <td style="padding: 8px 0 4px 0; font-weight: bold; font-size: 14px; color: #047857;">₹0.00 (Pending Review)</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      📌 Once your Manager or HR approves your Short Leave request, this delay will be automatically excused and no deduction will be made.
    </p>
  </div>
</div>`;

    return {
      whatsapp,
      emailSubject,
      emailHtml,
      inAppTitle: `Short Leave Pending for ${date}`,
      inAppBody: `Punched in at ${punchTimeFormatted}. Your Short Leave is pending approval — ₹0 deducted pending review.`
    };
  }

  // -------------------------------------------------------------
  // GRACE_WARNING TEMPLATE
  // -------------------------------------------------------------
  if (tier === 'GRACE_WARNING') {
    const whatsapp = 
`*SEPL Attendance Alert* ⏰

Dear *${empName}*,
You punched in at *${punchTimeFormatted} IST* on ${date} (${minutesLate} min late for your ${shiftName} shift starting at ${shiftStartFormatted}).

*Status:* Grace Late (${lateRank}/${graceLimit})
*Today's Salary Deduction:* ₹0.00 (Grace Applied)
*Remaining Grace:* ${graceRemaining} late arrival(s) left this month.

_Note: Once the ${graceLimit} grace limit is exhausted, a deduction of ₹${perMinuteRate}/min applies as per company policy. If your delay was due to official client visit or field duty, please contact your Manager / HR to regularize._

— Secured Engineers Pvt. Ltd.`;

    const emailSubject = `SEPL Attendance Notice: Late Arrival (${punchTimeFormatted}) — Grace Used ${lateRank}/${graceLimit}`;
    const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #ffffff;">
  <div style="background: #f59e0b; color: #ffffff; padding: 18px 24px;">
    <h2 style="margin: 0; font-size: 18px; font-weight: bold;">SEPL Attendance Alert ⏰</h2>
    <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">Late Punch-In Notice · Grace Applied</p>
  </div>
  <div style="padding: 24px; color: #1f2937;">
    <p style="font-size: 15px; margin-top: 0;">Dear <b>${empName}</b>,</p>
    <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
      You punched in at <b>${punchTimeFormatted} IST</b> on <b>${date}</b>. This is recorded as late for your <b>${shiftName}</b> shift (start time: ${shiftStartFormatted}).
    </p>

    <div style="background: #fef3c7; border-left: 4px solid #f59e0b; padding: 14px 16px; border-radius: 4px; margin: 18px 0;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #92400e; width: 45%;">Late Duration:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #92400e;">${minutesLate} minutes</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #92400e;">Monthly Grace Count:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #92400e;">${lateRank} of ${graceLimit} used</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #92400e;">Remaining Grace Days:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #047857;">${graceRemaining} left this month</td>
        </tr>
        <tr style="border-top: 1px dashed #d97706;">
          <td style="padding: 8px 0 4px 0; color: #92400e; font-weight: bold; font-size: 14px;">Today's Salary Deduction:</td>
          <td style="padding: 8px 0 4px 0; font-weight: bold; font-size: 14px; color: #047857;">₹0.00</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      💡 <b>Policy Reminder:</b> After ${graceLimit} grace arrivals, late punches are deducted at ₹${perMinuteRate}/minute during month-end payroll calculation.
    </p>
    <p style="font-size: 12px; color: #9ca3af; margin-top: 18px; border-top: 1px solid #f3f4f6; padding-top: 12px;">
      If you were delayed due to genuine client site duty or official field work, please contact your Manager or HR to regularize your attendance with proof.
    </p>
  </div>
</div>`;

    return {
      whatsapp,
      emailSubject,
      emailHtml,
      inAppTitle: `Late Punch In: Grace ${lateRank}/${graceLimit} Used`,
      inAppBody: `Punched in at ${punchTimeFormatted} (${minutesLate} min late). ₹0 deducted today. ${graceRemaining} grace days left.`
    };
  }

  // -------------------------------------------------------------
  // PER_MINUTE_DEDUCTION TEMPLATE
  // -------------------------------------------------------------
  if (tier === 'PER_MINUTE_DEDUCTION') {
    const whatsapp = 
`*SEPL Salary Deduction Alert* ⚠️

Dear *${empName}*,
You punched in at *${punchTimeFormatted} IST* on ${date} (${minutesLate} min late for your ${shiftName} shift starting at ${shiftStartFormatted}).

*Monthly Grace Exhausted:* This is your *${lateRank}th* late arrival this month (allowed grace: ${graceLimit}).

*Status:* Late Arrival
*Calculated Salary Deduction:* *₹${deduction.toFixed(2)}* (${minutesLate} min × ₹${perMinuteRate}/min)

_This deduction has been recorded and will be reflected in your month-end payroll to prevent discrepancies. If your delay was due to official duty, please contact your Manager / HR immediately to regularize._

— Secured Engineers Pvt. Ltd.`;

    const emailSubject = `SEPL Salary Deduction Notice: ₹${deduction.toFixed(2)} for Late Punch-In on ${date}`;
    const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #ffffff;">
  <div style="background: #dc2626; color: #ffffff; padding: 18px 24px;">
    <h2 style="margin: 0; font-size: 18px; font-weight: bold;">SEPL Salary Deduction Notice ⚠️</h2>
    <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">Late Punch-In · Monthly Grace Exhausted</p>
  </div>
  <div style="padding: 24px; color: #1f2937;">
    <p style="font-size: 15px; margin-top: 0;">Dear <b>${empName}</b>,</p>
    <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
      You punched in at <b>${punchTimeFormatted} IST</b> on <b>${date}</b>. You have exceeded the company's monthly grace limit of ${graceLimit} late arrivals (this is your <b>${lateRank}th</b> late arrival this month).
    </p>

    <div style="background: #fef2f2; border-left: 4px solid #dc2626; padding: 14px 16px; border-radius: 4px; margin: 18px 0;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #991b1b; width: 45%;">Late Duration:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">${minutesLate} minutes</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Grace Status:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #dc2626;">Exhausted (${lateRank}th late)</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Penalty Rate:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">₹${perMinuteRate} / minute</td>
        </tr>
        <tr style="border-top: 1px dashed #ef4444;">
          <td style="padding: 8px 0 4px 0; color: #991b1b; font-weight: bold; font-size: 14px;">Today's Deduction:</td>
          <td style="padding: 8px 0 4px 0; font-weight: bold; font-size: 15px; color: #b91c1c;">₹${deduction.toFixed(2)}</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      📌 This deduction is automatically computed and will be adjusted in your month-end payroll so there are no surprises or disputes at salary time.
    </p>
    <p style="font-size: 12px; color: #9ca3af; margin-top: 18px; border-top: 1px solid #f3f4f6; padding-top: 12px;">
      If you were on approved official travel, client site visit or technical field work, please contact your Manager or HR to regularize this attendance entry with appropriate proof.
    </p>
  </div>
</div>`;

    return {
      whatsapp,
      emailSubject,
      emailHtml,
      inAppTitle: `Salary Deduction: ₹${deduction.toFixed(2)} for Late Punch`,
      inAppBody: `Late by ${minutesLate} min (Grace exhausted). ₹${deduction.toFixed(2)} will be adjusted in month-end payroll.`
    };
  }

  // -------------------------------------------------------------
  // TIER 3: HALF_DAY TEMPLATE (with Short Leave Quota Advice)
  // -------------------------------------------------------------
  const deductionText = hasSalaryConfigured ? `₹${deduction.toFixed(2)}` : '0.5 Day Pay';
  const shortLeaveTipWa = (shortLeaveHoursRemaining > 0)
    ? `\n\n💡 *Short Leave Available:* Aapke paas is month mein *${shortLeaveHoursRemaining}h Short Leave quota* available hai. Aap ERP portal par (/attendance) jaakar Short Leave apply kar sakte hain taaki yeh Half-Day deduction remove ho sake.`
    : '';

  const shortLeaveTipHtml = (shortLeaveHoursRemaining > 0)
    ? `
    <div style="background: #ecfdf5; border-left: 4px solid #10b981; padding: 12px 16px; border-radius: 4px; margin: 16px 0;">
      <b style="color: #065f46; font-size: 14px;">💡 Short Leave Quota Available (${shortLeaveHoursRemaining} hours remaining):</b>
      <p style="margin: 4px 0 0 0; font-size: 13px; color: #047857; line-height: 1.4;">
        You have <b>${shortLeaveHoursRemaining} hours</b> of Short Leave allowance remaining this month. If your delay was due to personal urgency or transit, you can apply for Short Leave on the Attendance portal (<b>/attendance</b>) to excuse this half-day deduction upon manager approval.
      </p>
    </div>`
    : '';

  const whatsapp = 
`*SEPL Attendance Alert: Half-Day Recorded* ⚠️

Dear *${empName}*,
You punched in at *${punchTimeFormatted} IST* on ${date}.

Because your arrival was after the half-day cutoff time of *${halfDayCutoffFormatted} IST* for your ${shiftName} shift, today is recorded as a *HALF-DAY*.

*Status:* Half-Day Arrival
*Estimated Salary Impact:* *${deductionText}* (0.5 day pay)${shortLeaveTipWa}

_This will reflect in your month-end payroll. If this was caused by official field work, client site delays, or an emergency, please contact your Manager / HR to regularize or apply for short leave._

— Secured Engineers Pvt. Ltd.`;

  const emailSubject = `SEPL Attendance Notice: Half-Day Recorded on ${date} (Arrival after ${halfDayCutoffFormatted})`;
  const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #ffffff;">
  <div style="background: #b91c1c; color: #ffffff; padding: 18px 24px;">
    <h2 style="margin: 0; font-size: 18px; font-weight: bold;">SEPL Attendance Notice: Half-Day ⚠️</h2>
    <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">Late Punch-In past Half-Day Cutoff</p>
  </div>
  <div style="padding: 24px; color: #1f2937;">
    <p style="font-size: 15px; margin-top: 0;">Dear <b>${empName}</b>,</p>
    <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
      You punched in at <b>${punchTimeFormatted} IST</b> on <b>${date}</b>. Because this is past the half-day cutoff time (<b>${halfDayCutoffFormatted} IST</b>) for your <b>${shiftName}</b> shift, today has been recorded as a <b>Half-Day</b>.
    </p>

    <div style="background: #fef2f2; border-left: 4px solid #b91c1c; padding: 14px 16px; border-radius: 4px; margin: 18px 0;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #991b1b; width: 45%;">Punch In Time:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">${punchTimeFormatted} IST</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Half-Day Cutoff:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">${halfDayCutoffFormatted} IST</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Attendance Status:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #dc2626;">Half Day (0.5 Day Worked)</td>
        </tr>
        <tr style="border-top: 1px dashed #ef4444;">
          <td style="padding: 8px 0 4px 0; color: #991b1b; font-weight: bold; font-size: 14px;">Estimated Deduction:</td>
          <td style="padding: 8px 0 4px 0; font-weight: bold; font-size: 15px; color: #b91c1c;">${deductionText}</td>
        </tr>
      </table>
    </div>
    ${shortLeaveTipHtml}

    <p style="font-size: 13px; color: #6b7280; line-height: 1.5;">
      📌 This will be factored into your month-end payroll calculation.
    </p>
    <p style="font-size: 12px; color: #9ca3af; margin-top: 18px; border-top: 1px solid #f3f4f6; padding-top: 12px;">
      If you were on duty, delayed by client issues, or have emergency reasons, please contact your Manager or HR to submit regularization with proof.
    </p>
  </div>
</div>`;

  return {
    whatsapp,
    emailSubject,
    emailHtml,
    inAppTitle: `Half-Day Recorded for ${date}`,
    inAppBody: `Punched in at ${punchTimeFormatted} (past ${halfDayCutoffFormatted}). Estimated deduction: ${deductionText}.`
  };
}

/**
 * Dispatches WhatsApp, Email, and In-App notification with deduplication.
 */
async function sendLateNotifications(db, evalResult) {
  if (!evalResult || !evalResult.shouldNotify) return { skipped: true };

  const { userId, date, empEmail, empPhone } = evalResult;
  const dedupeKey = `late_attendance_${userId}_${date}`;

  // Deduplication check
  try {
    const existing = db.prepare('SELECT id FROM notifications WHERE dedupe_key=?').get(dedupeKey);
    if (existing) {
      return { skipped: true, reason: 'already_notified' };
    }
  } catch (_) {}

  const payload = buildLateNotificationPayload(evalResult);
  const channels = [];

  // 1. WhatsApp / SMS via notify service (never throws)
  if (empPhone) {
    try {
      const waRes = await sendText({ mobile: empPhone, body: payload.whatsapp });
      if (waRes.ok) channels.push('whatsapp');
    } catch (err) {
      console.warn('[lateAttendanceNotifier] WhatsApp send error:', err.message);
    }
  }

  // 2. Email via email service (never throws)
  if (empEmail) {
    try {
      const emailRes = await sendEmail({
        to: empEmail,
        subject: payload.emailSubject,
        html: payload.emailHtml,
        text: payload.whatsapp,
      });
      if (emailRes.sent) channels.push('email');
    } catch (err) {
      console.warn('[lateAttendanceNotifier] Email send error:', err.message);
    }
  }

  // 3. In-App Notification record
  try {
    channels.push('in_app');
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?, 'attendance_late', ?, ?, '/attendance', ?, ?)
    `).run(
      userId,
      payload.inAppTitle,
      payload.inAppBody,
      channels.join(','),
      dedupeKey
    );
  } catch (err) {
    console.warn('[lateAttendanceNotifier] In-app notification insert error:', err.message);
  }

  return { ok: true, channels, tier: evalResult.tier, deduction: evalResult.deduction };
}

/**
 * Non-blocking entrypoint called from punch-in route or auto punch-in cron.
 */
async function processLatePunchNotification(db, { attendanceId, userId, punchInTime, date }) {
  try {
    const evalResult = evaluateLateAttendance(db, { userId, punchInTime, date });
    if (!evalResult.shouldNotify) return { skipped: true, reason: evalResult.reason };
    return await sendLateNotifications(db, evalResult);
  } catch (err) {
    console.error('[lateAttendanceNotifier] process error:', err.message);
    return { error: err.message };
  }
}

module.exports = {
  evaluateLateAttendance,
  buildLateNotificationPayload,
  sendLateNotifications,
  processLatePunchNotification,
  countPreviousLatesThisMonth,
  getMonthlyShortLeaveRemaining,
  timeToMinutes,
  formatMinutesToTime,
};
