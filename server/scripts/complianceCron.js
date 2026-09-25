// Compliance Monitoring Cron Scanner
// SOTYN Mandatory Compliance Requirements

const { getDb } = require('../db/schema');
const { istToday } = require('../lib/istDate');
const { createComplianceCase } = require('../services/complianceService');

const SCAN_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Checks if current time is within employee duty hours (IST)
 */
function isWithinDutyHours(dutyStart = '09:00', dutyEnd = '18:30') {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
  const curHours = String(now.getUTCHours()).padStart(2, '0');
  const curMinutes = String(now.getUTCMinutes()).padStart(2, '0');
  const curTime = `${curHours}:${curMinutes}`;

  return curTime >= dutyStart && curTime <= dutyEnd;
}

/**
 * Runs the compliance scan for location tracking and overdue tasks.
 */
function runComplianceScan(dbInstance = null) {
  const db = dbInstance || getDb();
  const today = istToday();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  let newCasesCount = 0;

  try {
    // ── 1. SCAN FIELD EMPLOYEES LOCATION COMPLIANCE ──
    // Find active staff who punched in today
    const fieldStaffPunchedIn = db.prepare(`
      SELECT u.id as user_id, u.name as employee_name, u.email, u.role, u.department,
             a.id as attendance_id, a.punch_in_time, a.punch_out_time
      FROM users u
      JOIN attendance a ON a.user_id = u.id AND a.date = ?
      WHERE u.active = 1
        AND a.punch_in_time IS NOT NULL 
        AND (a.punch_out_time IS NULL OR a.punch_out_time = '')
    `).all(today);

    for (const staff of fieldStaffPunchedIn) {
      // Do not track location compliance for MD Ankur Kaplesh (director@securedengineers.com)
      const staffEmail = (staff.email || '').toLowerCase().trim();
      const staffName = (staff.employee_name || '').toLowerCase().trim();
      if (staffEmail === 'director@securedengineers.com' || (staffName.includes('ankur') && staffName.includes('kaplesh'))) {
        continue;
      }

      // Check latest location ping
      const latestPing = db.prepare(`
        SELECT time, latitude, longitude, site_name, COALESCE(gps_off, 0) as gps_off 
        FROM location_tracking 
        WHERE user_id = ? AND date = ?
        ORDER BY time DESC LIMIT 1
      `).get(staff.user_id, today);

      let isViolation = false;
      let violationReason = '';
      let violationType = 'location_off';

      if (!latestPing) {
        // Punched in but zero location pings
        isViolation = true;
        violationReason = `Punched in at ${staff.in_time} today but no location signal received during duty hours.`;
        violationType = 'location_unavailable';
      } else if (latestPing.gps_off === 1) {
        isViolation = true;
        violationReason = `GPS is turned OFF on device during active field duty hours (last ping: ${latestPing.time}).`;
        violationType = 'location_off';
      } else {
        // Check if last ping is older than 30 minutes
        const lastPingTime = new Date(latestPing.time).getTime();
        const curTimeMs = new Date(nowStr).getTime();
        const diffMinutes = Math.round((curTimeMs - lastPingTime) / (60 * 1000));

        if (diffMinutes > 30) {
          isViolation = true;
          violationReason = `No GPS location signal received for ${diffMinutes} minutes during active field duty hours (last ping: ${latestPing.time}).`;
          violationType = 'location_unavailable';
        }
      }

      if (isViolation) {
        // Check if an open case already exists for this employee today for location violation
        const existingCase = db.prepare(`
          SELECT id FROM compliance_cases 
          WHERE user_id = ? 
            AND violation_type IN ('location_off', 'location_unavailable')
            AND DATE(detected_at) = ?
            AND status NOT IN ('resolved', 'closed')
        `).get(staff.user_id, today);

        if (!existingCase) {
          createComplianceCase({
            userId: staff.user_id,
            employeeName: staff.employee_name,
            violationType,
            title: `Field Location Tracking Interrupted: ${staff.employee_name}`,
            description: violationReason,
            slaHours: 2,
            impactsAttendance: 1,
            impactsExpense: 1,
            metadata: { attendance_id: staff.attendance_id, last_ping: latestPing },
            dbInstance: db,
          });
          newCasesCount++;
        }
      }
    }

    // ── 2. SCAN OVERDUE MANDATORY DELEGATIONS & TASKS ──
    // A. Overdue Delegations
    try {
      const overdueDelegations = db.prepare(`
        SELECT d.id, d.title, d.assigned_to, d.deadline, u.name as employee_name
        FROM delegations d
        JOIN users u ON d.assigned_to = u.id
        WHERE d.status NOT IN ('completed', 'approved', 'closed', 'cancelled')
          AND d.deadline IS NOT NULL
          AND d.deadline < ?
      `).all(nowStr);

      for (const task of overdueDelegations) {
        const existingCase = db.prepare(`
          SELECT id FROM compliance_cases 
          WHERE user_id = ? 
            AND violation_type = 'mandatory_task_overdue'
            AND metadata LIKE ?
            AND status NOT IN ('resolved', 'closed')
        `).get(task.assigned_to, `%"task_type":"delegation","task_id":${task.id}%`);

        if (!existingCase) {
          createComplianceCase({
            userId: task.assigned_to,
            employeeName: task.employee_name,
            violationType: 'mandatory_task_overdue',
            title: `Mandatory Delegation Overdue: "${task.title}"`,
            description: `Delegation task "${task.title}" was due by ${task.deadline} and remains incomplete.`,
            slaHours: 4,
            impactsAttendance: 0,
            impactsExpense: 0,
            metadata: { task_type: 'delegation', task_id: task.id, deadline: task.deadline },
            dbInstance: db,
          });
          newCasesCount++;
        }
      }
    } catch (_) { }

    // B. Overdue PMS Tasks
    try {
      const overduePmsTasks = db.prepare(`
        SELECT p.id, p.title, p.user_id, p.due_date, u.name as employee_name
        FROM pms_tasks p
        JOIN users u ON p.user_id = u.id
        WHERE p.status NOT IN ('completed', 'closed', 'verified')
          AND p.due_date IS NOT NULL
          AND p.due_date < ?
      `).all(today);

      for (const pms of overduePmsTasks) {
        const existingCase = db.prepare(`
          SELECT id FROM compliance_cases 
          WHERE user_id = ? 
            AND violation_type = 'mandatory_task_overdue'
            AND metadata LIKE ?
            AND status NOT IN ('resolved', 'closed')
        `).get(pms.user_id, `%"task_type":"pms_task","task_id":${pms.id}%`);

        if (!existingCase) {
          createComplianceCase({
            userId: pms.user_id,
            employeeName: pms.employee_name,
            violationType: 'mandatory_task_overdue',
            title: `PMS Mandatory Task Overdue: "${pms.title}"`,
            description: `PMS Task "${pms.title}" exceeded due date ${pms.due_date} without completion.`,
            slaHours: 4,
            impactsAttendance: 0,
            impactsExpense: 0,
            metadata: { task_type: 'pms_task', task_id: pms.id, due_date: pms.due_date },
            dbInstance: db,
          });
          newCasesCount++;
        }
      }
    } catch (_) { }

  } catch (err) {
    console.error('[compliance-cron] error during compliance scan:', err.message);
  }

  return { scannedAt: nowStr, newCasesCreated: newCasesCount };
}

/**
 * Starts the compliance background scanner cron.
 */
function startComplianceCron() {
  if (process.env.ERP_DISABLE_COMPLIANCE_CRON === '1') {
    console.log('[compliance-cron] disabled via ERP_DISABLE_COMPLIANCE_CRON=1');
    return null;
  }

  console.log('[compliance-cron] starting compliance scanner interval (every 15m)');
  // Run first scan after 10 seconds of server boot
  setTimeout(() => {
    try { runComplianceScan(); } catch (e) { console.warn('[compliance-cron] initial run error:', e.message); }
  }, 10000);

  const timer = setInterval(() => {
    try { runComplianceScan(); } catch (e) { console.warn('[compliance-cron] interval run error:', e.message); }
  }, SCAN_INTERVAL_MS);

  return timer;
}

module.exports = {
  runComplianceScan,
  startComplianceCron,
  isWithinDutyHours,
};
