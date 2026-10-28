// server/lib/dailyAbsenteeismNotifier.js
//
// Implements Daily Absenteeism Notification at 6:30 PM (End of Day).
//
// Scans for active employees who:
//   1. Have NOT punched in today (no punch_in_time and no admin_marked attendance).
//   2. Have NOT applied for any leave (Casual, Sick, Earned, Comp-off, Short Leave — Approved or Pending).
//   3. Are active (status = 'active', user.active = 1, join_date <= today, not exited, not salary_exempt).
//   4. Excludes Sundays and Company Holidays.
//
// Dispatches an Uninformed Absence Notice via Email, WhatsApp/SMS, and In-App notification
// with deduplication to prevent duplicate sends.

const { sendText } = require('../services/notify');
const { sendEmail } = require('./email');

function istTodayStr() {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
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

function buildAbsenteeismPayload({ empName, date }) {
  const whatsapp =
`*SEPL Attendance Alert: Uninformed Absence Notice* ⚠️

Dear *${empName}*,
Our attendance system recorded no punch-in for you today (*${date}*) by the 6:30 PM shift end, and no prior leave application was found on record.

*Status:* Marked Absent (Uninformed / Loss of Pay)

_If you were on approved official field work, client duty, or facing an emergency, please apply for leave immediately on the ERP portal (/attendance) or contact your Manager / HR to regularize this absence before month-end payroll._

— Secured Engineers Pvt. Ltd.`;

  const emailSubject = `[SEPL ERP] Uninformed Absence Notice for ${date}`;
  const emailHtml = `
<div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e5e7eb; border-radius: 8px; overflow: hidden; background: #ffffff;">
  <div style="background: #991b1b; color: #ffffff; padding: 18px 24px;">
    <h2 style="margin: 0; font-size: 18px; font-weight: bold;">SEPL Attendance Notice: Uninformed Absence ⚠️</h2>
    <p style="margin: 4px 0 0 0; font-size: 13px; opacity: 0.95;">No Punch-In Recorded · No Prior Leave on File</p>
  </div>
  <div style="padding: 24px; color: #1f2937;">
    <p style="font-size: 15px; margin-top: 0;">Dear <b>${empName}</b>,</p>
    <p style="font-size: 14px; line-height: 1.5; color: #4b5563;">
      Our attendance system recorded that you did not punch in today (<b>${date}</b>) by the 6:30 PM shift end, and no leave application was found in the ERP system.
    </p>

    <div style="background: #fef2f2; border-left: 4px solid #991b1b; padding: 14px 16px; border-radius: 4px; margin: 18px 0;">
      <table style="width: 100%; font-size: 13px; border-collapse: collapse;">
        <tr>
          <td style="padding: 4px 0; color: #991b1b; width: 45%;">Date:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">${date}</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Shift Status:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #dc2626;">Absent (No Punch Recorded)</td>
        </tr>
        <tr>
          <td style="padding: 4px 0; color: #991b1b;">Leave Application:</td>
          <td style="padding: 4px 0; font-weight: bold; color: #991b1b;">None on file</td>
        </tr>
        <tr style="border-top: 1px dashed #ef4444;">
          <td style="padding: 8px 0 4px 0; color: #991b1b; font-weight: bold; font-size: 14px;">Payroll Impact:</td>
          <td style="padding: 8px 0 4px 0; font-weight: bold; font-size: 14px; color: #b91c1c;">1 Day Loss of Pay (Unless regularized)</td>
        </tr>
      </table>
    </div>

    <p style="font-size: 13px; color: #4b5563; line-height: 1.5;">
      📌 <b>Action Required:</b> If you were engaged in official field duty, client site work, or have an emergency reason:
    </p>
    <ul style="font-size: 13px; color: #4b5563; line-height: 1.5; padding-left: 20px; margin: 8px 0;">
      <li>Log in to the ERP portal and submit a leave application or request regularization under <b>Attendance &gt; Leaves</b>.</li>
      <li>Or contact your Manager / HR immediately with supporting proof so this day can be verified before payroll finalization.</li>
    </ul>

    <p style="font-size: 12px; color: #9ca3af; margin-top: 20px; border-top: 1px solid #f3f4f6; padding-top: 12px;">
      This is an automated system notification from Secured Engineers Attendance &amp; Payroll Management.
    </p>
  </div>
</div>`;

  return {
    whatsapp,
    emailSubject,
    emailHtml,
    inAppTitle: `Uninformed Absence Marked for ${date}`,
    inAppBody: `No punch-in recorded by 6:30 PM shift end and no leave on file. Please contact HR or apply leave.`
  };
}

/**
 * Scans for all active employees who did not punch in and have no leave applied today.
 * Dispatches Email, WhatsApp, and In-App notifications.
 */
async function scanAndNotifyAbsentEmployees(db, options = {}) {
  const targetDate = options.targetDate || istTodayStr();
  const forceTimeCheck = !!options.forceTimeCheck;

  const dateObj = new Date(targetDate + 'T00:00:00Z');
  const dow = dateObj.getUTCDay();
  if (dow === 0) {
    return { skipped: true, reason: 'sunday', date: targetDate };
  }

  // Check 6:30 PM (18:30 IST) condition unless forceTimeCheck is enabled
  if (!forceTimeCheck) {
    const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const istHour = ist.getUTCHours();
    const istMin = ist.getUTCMinutes();
    if (istHour < 18 || (istHour === 18 && istMin < 30)) {
      return { skipped: true, reason: 'before_18_30_ist', date: targetDate };
    }
  }

  // Check company holiday
  try {
    const hol = db.prepare('SELECT name FROM payroll_holidays WHERE date=?').get(targetDate);
    if (hol) {
      return { skipped: true, reason: 'company_holiday', holiday: hol.name, date: targetDate };
    }
  } catch (_) {}

  // Fetch all active employees
  let employees = [];
  try {
    employees = db.prepare(`
      SELECT e.id AS employee_id, e.user_id, e.name, e.email, e.phone, e.department, e.designation,
             u.name AS user_name, u.email AS user_email, u.phone AS user_phone
      FROM employees e
      JOIN users u ON u.id = e.user_id
      WHERE COALESCE(u.active, 1) = 1
        AND COALESCE(e.status, 'active') = 'active'
        AND (e.join_date IS NULL OR e.join_date <= ?)
        AND (e.exit_date IS NULL OR e.exit_date >= ?)
        AND COALESCE(e.salary_exempt, 0) = 0
        AND COALESCE(u.auto_mark_present, 0) = 0
    `).all(targetDate, targetDate);
  } catch (err) {
    console.error('[dailyAbsenteeismNotifier] query employees error:', err.message);
    return { error: err.message };
  }

  const notified = [];

  for (const emp of employees) {
    const userId = emp.user_id;

    // 1. Check if employee already punched in or has admin-marked attendance
    try {
      const att = db.prepare(`
        SELECT id, punch_in_time, admin_marked FROM attendance 
        WHERE user_id = ? AND date = ?
      `).get(userId, targetDate);
      if (att && (att.punch_in_time || att.admin_marked)) {
        continue; // Attended today
      }
    } catch (_) {}

    // 2. Check if employee has ANY leave applied for today (Approved or Pending)
    try {
      const leave = db.prepare(`
        SELECT id, leave_type, status FROM leave_requests
        WHERE user_id = ? AND status IN ('approved', 'pending')
          AND ? BETWEEN from_date AND to_date
      `).get(userId, targetDate);
      if (leave) {
        continue; // On approved or pending leave
      }
    } catch (_) {}

    // 3. Deduplication check
    const dedupeKey = `absent_notice:${userId}:${targetDate}`;
    try {
      const existing = db.prepare('SELECT id FROM notifications WHERE dedupe_key=?').get(dedupeKey);
      if (existing) {
        continue; // Already notified today
      }
    } catch (_) {}

    const empName = emp.user_name || emp.name || 'Employee';
    const empEmail = emp.email || emp.user_email || null;
    const empPhone = emp.phone || emp.user_phone || null;

    const payload = buildAbsenteeismPayload({ empName, date: targetDate });
    const channels = [];

    // Dispatch WhatsApp
    if (empPhone) {
      try {
        const waRes = await sendText({ mobile: empPhone, body: payload.whatsapp });
        if (waRes.ok) channels.push('whatsapp');
      } catch (err) {
        console.warn('[dailyAbsenteeismNotifier] WhatsApp send error:', err.message);
      }
    }

    // Dispatch Email
    if (empEmail) {
      try {
        const mailRes = await sendEmail({
          to: empEmail,
          subject: payload.emailSubject,
          html: payload.emailHtml,
          text: payload.whatsapp,
        });
        if (mailRes.sent) channels.push('email');
      } catch (err) {
        console.warn('[dailyAbsenteeismNotifier] Email send error:', err.message);
      }
    }

    // Record In-App notification
    try {
      channels.push('in_app');
      db.prepare(`
        INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
        VALUES (?, 'attendance_absent', ?, ?, '/attendance', ?, ?)
      `).run(
        userId,
        payload.inAppTitle,
        payload.inAppBody,
        channels.join(','),
        dedupeKey
      );
    } catch (err) {
      console.warn('[dailyAbsenteeismNotifier] in-app notification insert error:', err.message);
    }

    notified.push({ userId, name: empName, channels });
  }

  return {
    date: targetDate,
    totalScanned: employees.length,
    absentNotifiedCount: notified.length,
    notified,
  };
}

module.exports = {
  scanAndNotifyAbsentEmployees,
  buildAbsenteeismPayload,
  istTodayStr,
};
