const { getDb } = require('../db/schema');
const { istToday } = require('../lib/istDate');

// Default Nancy Email & Profile
const COMPLIANCE_MONITOR_EMAIL = 'nancy@securedengineers.com';
const COMPLIANCE_MONITOR_NAME = 'Nancy';

/**
 * Ensures the compliance monitor (Nancy) exists in users table and has the monitor role.
 */
function getOrCreateComplianceMonitor(db) {
  let user = db.prepare('SELECT id, name, email, role FROM users WHERE LOWER(email) = LOWER(?)').get(COMPLIANCE_MONITOR_EMAIL);
  
  if (!user) {
    user = db.prepare("SELECT id, name, email, role FROM users WHERE LOWER(name) LIKE '%nancy%'").get();
  }

  if (!user) {
    // Provision Nancy user
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('Nancy@123456', 10);
    const res = db.prepare(`
      INSERT INTO users (name, email, password, role, department, active)
      VALUES (?, ?, ?, 'user', 'HR / Compliance', 1)
    `).run(COMPLIANCE_MONITOR_NAME, COMPLIANCE_MONITOR_EMAIL, hash);
    
    user = { id: res.lastInsertRowid, name: COMPLIANCE_MONITOR_NAME, email: COMPLIANCE_MONITOR_EMAIL, role: 'user' };
  }

  // Ensure role is assigned
  const role = db.prepare("SELECT id FROM roles WHERE name = 'Compliance Monitor'").get();
  if (role) {
    const hasRole = db.prepare('SELECT id FROM user_roles WHERE user_id = ? AND role_id = ?').get(user.id, role.id);
    if (!hasRole) {
      db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)').run(user.id, role.id);
    }
  }

  // Ensure standard test field employee exists
  let testEmp = db.prepare("SELECT id, name, email FROM users WHERE LOWER(email) = 'rahul@securedengineers.com' OR LOWER(username) = 'rahul'").get();
  if (!testEmp) {
    const bcrypt = require('bcryptjs');
    const hash = bcrypt.hashSync('User@123456', 10);
    const r = db.prepare(`
      INSERT INTO users (name, email, username, password, role, department, active)
      VALUES ('Rahul Sharma', 'rahul@securedengineers.com', 'rahul', ?, 'user', 'Site Operations', 1)
    `).run(hash);
    testEmp = { id: r.lastInsertRowid, name: 'Rahul Sharma', email: 'rahul@securedengineers.com' };
  }

  return user;
}

/**
 * Checks if user is Managing Director (Ankur Kaplesh / director@securedengineers.com).
 * Exempt from location tracking and GPS compliance alerts.
 */
function isMdLocationExempt(user) {
  if (!user) return false;
  const email = (user.email || '').toLowerCase().trim();
  const name = (user.name || user.employee_name || '').toLowerCase().trim();
  if (email === 'director@securedengineers.com') return true;
  if (name.includes('ankur') && name.includes('kaplesh')) return true;
  return false;
}

/**
 * Generates next sequential case number: CMP-YYYYMM-XXXX
 */
function generateCaseNumber(db) {
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // IST
  const yyyy = now.getUTCFullYear();
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const prefix = `CMP-${yyyy}${mm}-`;

  const lastCase = db.prepare(`
    SELECT case_number FROM compliance_cases 
    WHERE case_number LIKE ? 
    ORDER BY id DESC LIMIT 1
  `).get(`${prefix}%`);

  let nextSeq = 1;
  if (lastCase && lastCase.case_number) {
    const parts = lastCase.case_number.split('-');
    if (parts.length === 3) {
      const num = parseInt(parts[2], 10);
      if (!isNaN(num)) nextSeq = num + 1;
    }
  }

  return `${prefix}${String(nextSeq).padStart(4, '0')}`;
}

/**
 * Creates a new compliance violation case with audit logging and dual notifications.
 */
function createComplianceCase({
  userId,
  employeeName,
  violationType,
  title,
  description,
  slaHours = 4,
  metadata = null,
  impactsAttendance = 1,
  impactsExpense = 1,
  dbInstance = null,
}) {
  const db = dbInstance || getDb();
  const monitor = getOrCreateComplianceMonitor(db);

  // Robustly resolve userId to users.id
  let resolvedUserId = userId;
  let userRow = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  
  if (!userRow) {
    const emp = db.prepare('SELECT id, user_id, name, email FROM employees WHERE id = ?').get(userId);
    if (emp) {
      if (emp.user_id) {
        resolvedUserId = emp.user_id;
        userRow = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(emp.user_id);
      } else if (emp.email) {
        userRow = db.prepare('SELECT id, name, email FROM users WHERE LOWER(email) = LOWER(?)').get(emp.email);
        if (userRow) resolvedUserId = userRow.id;
      }
      if (!employeeName) employeeName = emp.name;
    }
  }

  // Fallback match by employee name if still not resolved
  if ((!userRow || !resolvedUserId) && employeeName) {
    userRow = db.prepare('SELECT id, name FROM users WHERE LOWER(name) = LOWER(?)').get(employeeName);
    if (userRow) resolvedUserId = userRow.id;
  }

  if (!employeeName && userRow) {
    employeeName = userRow.name;
  }
  if (!employeeName) {
    employeeName = `User #${resolvedUserId || userId}`;
  }
  userId = resolvedUserId || userId;

  // Do not track location compliance for MD Ankur Kaplesh (director@securedengineers.com)
  if (['location_off', 'location_unavailable', 'geofence_breach'].includes(violationType)) {
    if (isMdLocationExempt(userRow) || isMdLocationExempt({ name: employeeName })) {
      return null;
    }
  }

  const caseNumber = generateCaseNumber(db);
  const now = new Date();
  const slaDeadline = new Date(now.getTime() + slaHours * 3600 * 1000).toISOString();
  const nowIso = now.toISOString();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const res = db.prepare(`
    INSERT INTO compliance_cases (
      case_number, user_id, employee_name, violation_type, title, description,
      detected_at, sla_deadline, assigned_to, assigned_at, alert_sent, alert_sent_at,
      employee_notified, monitor_notified, followup_status, status,
      impacts_attendance, impacts_expense, metadata, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 1, 1, 'pending', 'open', ?, ?, ?, ?, ?)
  `).run(
    caseNumber,
    userId,
    employeeName,
    violationType,
    title,
    description || '',
    nowIso,
    slaDeadline,
    monitor.id,
    nowIso,
    nowIso,
    impactsAttendance ? 1 : 0,
    impactsExpense ? 1 : 0,
    metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
    nowIso,
    nowIso
  );

  const caseId = res.lastInsertRowid;

  // Log creation in audit trail
  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performer_name, notes, metadata, created_at)
    VALUES (?, 'case_created', 'System Monitor', ?, ?, ?)
  `).run(
    caseId,
    `Violation detected: ${title}. Assigned to ${monitor.name} with ${slaHours}h SLA.`,
    metadata ? (typeof metadata === 'string' ? metadata : JSON.stringify(metadata)) : null,
    nowStr
  );

  // 1. Mandatory Notification to Employee
  db.prepare(`
    INSERT INTO notifications (
      user_id, type, title, body, link_url, channel_sent,
      is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
    ) VALUES (?, 'compliance_alert', ?, ?, ?, 'in_app', 1, 1, 'compliance_case', ?, ?, 'active', ?)
  `).run(
    userId,
    `[MANDATORY] Compliance Alert: ${title}`,
    `A compliance alert (${caseNumber}) has been flagged regarding: ${description || title}. Please acknowledge and respond immediately.`,
    `/compliance?case_id=${caseId}`,
    caseId,
    nowStr,
    nowStr
  );

  // 2. Alert Notification to Compliance Monitor (Nancy)
  if (monitor.id !== userId) {
    db.prepare(`
      INSERT INTO notifications (
        user_id, type, title, body, link_url, channel_sent,
        is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
      ) VALUES (?, 'compliance_monitor_alert', ?, ?, ?, 'in_app', 1, 1, 'compliance_case_monitor', ?, ?, 'active', ?)
    `).run(
      monitor.id,
      `New Compliance Case: ${caseNumber} - ${employeeName}`,
      `Violation [${violationType}]: ${title} for ${employeeName}. Follow-up required before ${slaDeadline}.`,
      `/compliance?case_id=${caseId}`,
      caseId,
      nowStr,
      nowStr
    );
  }

  // 3. Instant Real-Time Socket.IO Notification to Nancy & Employee (Targeted, no spam to other admins)
  try {
    const { getIO } = require('../lib/chatSocket');
    const io = getIO();
    if (io) {
      io.to('u:' + monitor.id).emit('notification:new', {
        type: 'compliance_monitor_alert',
        title: `New Compliance Case: ${caseNumber} - ${employeeName}`,
        body: `Violation [${violationType}]: ${title} for ${employeeName}.`,
        link_url: `/compliance?case_id=${caseId}`,
        created_at: nowStr,
      });

      if (monitor.id !== userId) {
        io.to('u:' + userId).emit('notification:new', {
          type: 'compliance_alert',
          title: `[MANDATORY] Compliance Alert: ${title}`,
          body: `A compliance alert (${caseNumber}) has been flagged: ${description || title}.`,
          link_url: `/compliance?case_id=${caseId}`,
          created_at: nowStr,
        });
      }
    }
  } catch (_) {}

  return { caseId, caseNumber, monitorId: monitor.id };
}

/**
 * Creates a mandatory notification linked to a system task.
 */
function createMandatoryTaskNotification({
  userId,
  taskType,
  taskId,
  title,
  body,
  linkUrl,
  dbInstance = null,
}) {
  const db = dbInstance || getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  // Check if identical active mandatory notification already exists
  const existing = db.prepare(`
    SELECT id FROM notifications 
    WHERE user_id = ? AND task_type = ? AND task_id = ? AND status = 'active'
  `).get(userId, taskType, taskId);

  if (existing) return existing.id;

  const res = db.prepare(`
    INSERT INTO notifications (
      user_id, type, title, body, link_url, channel_sent,
      is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
    ) VALUES (?, 'mandatory_task', ?, ?, ?, 'in_app', 1, 1, ?, ?, ?, 'active', ?)
  `).run(
    userId,
    `[MANDATORY] ${title}`,
    body,
    linkUrl,
    taskType,
    taskId,
    nowStr,
    nowStr
  );

  return res.lastInsertRowid;
}

/**
 * Acknowledges a mandatory notification (records timestamp, keeps mandatory active).
 */
function acknowledgeMandatoryNotification(notificationId, userId, dbInstance = null) {
  const db = dbInstance || getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const notif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(notificationId);
  if (!notif) return null;

  let hasAccess = !userId || notif.user_id === userId;
  if (!hasAccess && userId) {
    try {
      const userRow = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId);
      const userEmail = (userRow?.email || '').trim().toLowerCase();
      const userName = (userRow?.name || '').trim();
      const isNancyOrAdmin = userRow?.role === 'admin' || userName.toLowerCase().includes('nancy') || userEmail.includes('nancy');

      if (isNancyOrAdmin) {
        hasAccess = true;
      } else {
        const emps = db.prepare('SELECT id, user_id, name, email FROM employees WHERE user_id = ? OR (email IS NOT NULL AND LOWER(email) = ?) OR LOWER(name) = LOWER(?)').all(userId, userEmail, userName);
        const empIds = emps.map(e => e.id);
        const allUserIds = [userId, ...empIds];

        if (allUserIds.includes(notif.user_id)) {
          hasAccess = true;
        } else if (notif.task_type === 'compliance_case' && notif.task_id) {
          const cc = db.prepare('SELECT * FROM compliance_cases WHERE id = ?').get(notif.task_id);
          if (cc && (allUserIds.includes(cc.user_id) || emps.some(e => e.name && cc.employee_name && e.name.toLowerCase() === cc.employee_name.toLowerCase()))) {
            hasAccess = true;
          }
        }
      }
    } catch (_) {}
  }

  if (!hasAccess) return null;

  db.prepare(`
    UPDATE notifications 
    SET acknowledged_at = COALESCE(acknowledged_at, ?), read_at = COALESCE(read_at, ?)
    WHERE id = ?
  `).run(nowStr, nowStr, notificationId);

  // If this was a compliance case notification, update the case log
  if (notif.task_type === 'compliance_case' && notif.task_id) {
    try {
      db.prepare(`
        INSERT INTO compliance_case_logs (case_id, action, performed_by, notes, created_at)
        VALUES (?, 'employee_acknowledged', ?, 'Employee acknowledged notification alert', ?)
      `).run(notif.task_id, userId, nowStr);
    } catch (_) {}
  }

  return { success: true, acknowledged_at: nowStr };
}

/**
 * Closes mandatory task notifications when the task is officially completed or approved in DB.
 */
function closeMandatoryTaskNotification(taskType, taskId, completedByUserId = null, dbInstance = null) {
  const db = dbInstance || getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const res = db.prepare(`
    UPDATE notifications 
    SET status = 'closed', is_pending = 0, completed_at = COALESCE(completed_at, ?), closed_at = ?
    WHERE task_type = ? AND task_id = ? AND status = 'active'
  `).run(nowStr, nowStr, taskType, taskId);

  return res.changes;
}

/**
 * Calculates Nancy's Compliance Monitoring KPI
 * Formula & Weights:
 *   1. Compliance cases followed up on time (within SLA): 30%
 *   2. Open violations successfully brought to closure: 30%
 *   3. Overdue task violations followed up: 20%
 *   4. Field-location violations followed up: 20%
 *   Total = 100%
 */
function calculateComplianceKpi(startDate = null, endDate = null, dbInstance = null) {
  const db = dbInstance || getDb();

  let dateFilter = '';
  const params = [];
  if (startDate && endDate) {
    dateFilter = 'AND detected_at >= ? AND detected_at <= ?';
    params.push(startDate, endDate);
  }

  const totalCases = db.prepare(`SELECT COUNT(*) as count FROM compliance_cases WHERE 1=1 ${dateFilter}`).get(...params)?.count || 0;
  
  if (totalCases === 0) {
    return {
      totalCases: 0,
      onTimeFollowUpScore: 100,
      closureScore: 100,
      taskViolationScore: 100,
      locationViolationScore: 100,
      overallKpi: 100,
      details: {
        total: 0,
        followedUpOnTime: 0,
        closedCases: 0,
        taskCases: 0,
        taskFollowedUp: 0,
        locationCases: 0,
        locationFollowedUp: 0,
      }
    };
  }

  // 1. Followed up on time (within SLA): followed_up_at <= sla_deadline or (resolved_at <= sla_deadline)
  const onTimeFollowUps = db.prepare(`
    SELECT COUNT(*) as count FROM compliance_cases 
    WHERE (
      (followed_up_at IS NOT NULL AND followed_up_at <= sla_deadline) OR
      (resolved_at IS NOT NULL AND resolved_at <= sla_deadline)
    ) ${dateFilter}
  `).get(...params)?.count || 0;

  // 2. Brought to closure: status IN ('resolved', 'closed')
  const closedCases = db.prepare(`
    SELECT COUNT(*) as count FROM compliance_cases 
    WHERE status IN ('resolved', 'closed') ${dateFilter}
  `).get(...params)?.count || 0;

  // 3. Overdue Task Violations Followed Up
  const taskCases = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN followup_status != 'pending' OR status IN ('resolved', 'closed') THEN 1 ELSE 0 END) as followed_up
    FROM compliance_cases 
    WHERE violation_type IN ('mandatory_task_overdue', 'task_notification_unresponsive') ${dateFilter}
  `).get(...params);

  // 4. Field-Location Violations Followed Up
  const locationCases = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN followup_status != 'pending' OR status IN ('resolved', 'closed') THEN 1 ELSE 0 END) as followed_up
    FROM compliance_cases 
    WHERE violation_type IN ('location_off', 'location_unavailable', 'geofence_breach') ${dateFilter}
  `).get(...params);

  const totalTask = taskCases?.total || 0;
  const followedTask = taskCases?.followed_up || 0;
  const totalLoc = locationCases?.total || 0;
  const followedLoc = locationCases?.followed_up || 0;

  // Sub-scores (0-100)
  const onTimeFollowUpScore = totalCases > 0 ? Math.min(100, Math.round((onTimeFollowUps / totalCases) * 100)) : 100;
  const closureScore = totalCases > 0 ? Math.min(100, Math.round((closedCases / totalCases) * 100)) : 100;
  const taskViolationScore = totalTask > 0 ? Math.min(100, Math.round((followedTask / totalTask) * 100)) : 100;
  const locationViolationScore = totalLoc > 0 ? Math.min(100, Math.round((followedLoc / totalLoc) * 100)) : 100;

  // Weighted overall KPI: 30% + 30% + 20% + 20%
  const overallKpi = Math.round(
    (onTimeFollowUpScore * 0.30) +
    (closureScore * 0.30) +
    (taskViolationScore * 0.20) +
    (locationViolationScore * 0.20)
  );

  return {
    totalCases,
    onTimeFollowUpScore,
    closureScore,
    taskViolationScore,
    locationViolationScore,
    overallKpi,
    weights: {
      onTimeFollowUp: '30%',
      closure: '30%',
      taskViolations: '20%',
      locationViolations: '20%',
    },
    details: {
      total: totalCases,
      followedUpOnTime: onTimeFollowUps,
      closedCases,
      taskCases: totalTask,
      taskFollowedUp: followedTask,
      locationCases: totalLoc,
      locationFollowedUp: followedLoc,
    }
  };
}

/**
 * Formats duration in milliseconds to human-readable English string (e.g., '1 hr 15 mins' or '25 mins')
 */
function formatDuration(ms) {
  const totalMins = Math.max(1, Math.round(ms / (60 * 1000)));
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0 && mins > 0) return `${hrs} hr ${mins} min${mins > 1 ? 's' : ''}`;
  if (hrs > 0) return `${hrs} hr${hrs > 1 ? 's' : ''}`;
  return `${mins} min${mins > 1 ? 's' : ''}`;
}

/**
 * Formats a Date object to IST 12-hour time string (e.g., '12:10 PM')
 */
function formatISTTime(dateObj) {
  const d = dateObj ? new Date(dateObj.getTime() + 5.5 * 3600 * 1000) : new Date(Date.now() + 5.5 * 3600 * 1000);
  const hh = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  const ampm = hh >= 12 ? 'PM' : 'AM';
  const displayH = hh % 12 || 12;
  return `${displayH}:${mm} ${ampm}`;
}

/**
 * Handles GPS OFF event lifecycle:
 * - Initial detection: creates case + sends initial alerts to Monitor and Employee.
 * - Ongoing GPS OFF:
 *   • Employee: receives simple reminder every 15 minutes.
 *   • Monitor (Nancy): receives escalation follow-up alert every 30 minutes with elapsed duration.
 */
function handleGpsOffEvent({ userId, employeeName, reason, dbInstance = null }) {
  const db = dbInstance || getDb();
  const today = istToday();

  // Do not track location compliance for MD Ankur Kaplesh (director@securedengineers.com)
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  if (isMdLocationExempt(user) || isMdLocationExempt({ name: employeeName })) {
    return null;
  }

  // STRICT REQUIREMENT: Only trigger GPS OFF compliance when user is currently PUNCHED IN and NOT PUNCHED OUT
  const attRecord = db.prepare(`
    SELECT id, punch_in_time, punch_out_time, status, COALESCE(admin_marked, 0) as admin_marked 
    FROM attendance 
    WHERE user_id = ? AND date = ?
  `).get(userId, today);

  const isPunchedIn = attRecord && (attRecord.punch_in_time || attRecord.admin_marked === 1 || ['present', 'late', 'half_day'].includes(attRecord.status)) && !attRecord.punch_out_time;
  if (!isPunchedIn) {
    // User has not punched in today, or has already punched out (shift ended). No compliance violation.
    return null;
  }

  const monitor = getOrCreateComplianceMonitor(db);
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const nowStr = new Date(nowMs + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const timeFormatted = formatISTTime(new Date());

  // Check for active open location_off case
  const activeCase = db.prepare(`
    SELECT * FROM compliance_cases 
    WHERE user_id = ? AND violation_type = 'location_off' AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `).get(userId);

  if (!activeCase) {
    // Initial GPS OFF Event -> Create Case + Send Initial Notifications
    const metaObj = {
      off_at: nowIso,
      last_employee_notified_at: nowIso,
      last_monitor_notified_at: nowIso,
      reason: reason || 'GPS location turned off on mobile',
    };

    return createComplianceCase({
      userId,
      employeeName,
      violationType: 'location_off',
      title: `GPS Location Turned Off: ${employeeName} (${timeFormatted} IST)`,
      description: `Employee reported GPS turned off during duty hours at ${timeFormatted} IST. Reason: ${reason || 'GPS location turned off on mobile'}.`,
      slaHours: 2,
      impactsAttendance: 1,
      impactsExpense: 1,
      metadata: metaObj,
      dbInstance: db,
    });
  }

  // Active open case exists -> Check 15m employee reminder & 30m monitor reminder
  let meta = {};
  try {
    meta = typeof activeCase.metadata === 'string' ? JSON.parse(activeCase.metadata) : (activeCase.metadata || {});
  } catch (_) { meta = {}; }

  const offAt = new Date(meta.off_at || activeCase.detected_at);
  const offTimeStr = formatISTTime(offAt);
  const lastEmpNotif = new Date(meta.last_employee_notified_at || activeCase.detected_at);
  const lastMonNotif = new Date(meta.last_monitor_notified_at || activeCase.detected_at);

  let updated = false;

  // 1. Employee Reminder: every 15 minutes (in English)
  if (nowMs - lastEmpNotif.getTime() >= 15 * 60 * 1000) {
    const elapsedStr = formatDuration(nowMs - offAt.getTime());
    db.prepare(`
      INSERT INTO notifications (
        user_id, type, title, body, link_url, channel_sent,
        is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
      ) VALUES (?, 'compliance_alert', ?, ?, ?, 'in_app', 1, 1, 'compliance_case', ?, ?, 'active', ?)
    `).run(
      userId,
      `[REMINDER] GPS Location Still Turned Off`,
      `Your device GPS is still turned off since ${offTimeStr} IST (${elapsedStr} elapsed). Please turn on your device GPS immediately.`,
      `/compliance?case_id=${activeCase.id}`,
      activeCase.id,
      nowStr,
      nowStr
    );

    try {
      const { getIO } = require('../lib/chatSocket');
      const io = getIO();
      if (io) {
        io.to('u:' + userId).emit('notification:new', {
          type: 'compliance_alert',
          title: `[REMINDER] GPS Location Still Turned Off`,
          body: `Your device GPS is still turned off since ${offTimeStr} IST (${elapsedStr} elapsed). Please turn on your device GPS immediately.`,
          link_url: `/compliance?case_id=${activeCase.id}`,
          created_at: nowStr,
        });
      }
    } catch (_) {}

    meta.last_employee_notified_at = nowIso;
    updated = true;
  }

  // 2. Nancy Monitor Escalation Reminder: every 30 minutes (in English)
  if (nowMs - lastMonNotif.getTime() >= 30 * 60 * 1000) {
    const elapsedStr = formatDuration(nowMs - offAt.getTime());
    db.prepare(`
      INSERT INTO notifications (
        user_id, type, title, body, link_url, channel_sent,
        is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
      ) VALUES (?, 'compliance_monitor_alert', ?, ?, ?, 'in_app', 1, 1, 'compliance_case_monitor', ?, ?, 'active', ?)
    `).run(
      monitor.id,
      `[URGENT] GPS Still OFF: ${activeCase.employee_name} (${elapsedStr})`,
      `Employee ${activeCase.employee_name} has kept GPS turned off since ${offTimeStr} IST (${elapsedStr} elapsed without turning ON). Follow-up required.`,
      `/compliance?case_id=${activeCase.id}`,
      activeCase.id,
      nowStr,
      nowStr
    );

    try {
      const { getIO } = require('../lib/chatSocket');
      const io = getIO();
      if (io) {
        io.to('u:' + monitor.id).emit('notification:new', {
          type: 'compliance_monitor_alert',
          title: `[URGENT] GPS Still OFF: ${activeCase.employee_name} (${elapsedStr})`,
          body: `Employee ${activeCase.employee_name} has kept GPS turned off since ${offTimeStr} IST (${elapsedStr} elapsed without turning ON). Follow-up required.`,
          link_url: `/compliance?case_id=${activeCase.id}`,
          created_at: nowStr,
        });
      }
    } catch (_) {}

    db.prepare(`
      INSERT INTO compliance_case_logs (case_id, action, performer_name, notes, created_at)
      VALUES (?, 'followup_reminder', 'System Monitor', ?, ?)
    `).run(
      activeCase.id,
      `GPS still OFF after ${elapsedStr} (since ${offTimeStr} IST). Escalation alert sent to monitor.`,
      nowStr
    );

    meta.last_monitor_notified_at = nowIso;
    updated = true;
  }

  if (updated) {
    db.prepare(`
      UPDATE compliance_cases 
      SET metadata = ?, updated_at = ?
      WHERE id = ?
    `).run(JSON.stringify(meta), nowIso, activeCase.id);
  }
}

/**
 * Handles GPS Restored event:
 * - Calculates total off duration and compiles full lifecycle incident report.
 * - Updates case status to 'resolved' with full resolution notes.
 * - Notifies Nancy with complete restoration report (Off Time, On Time, Duration, Location).
 * - Notifies Employee that GPS signal is successfully restored and active.
 */
function handleGpsRestoredEvent({ userId, latitude, longitude, siteName, dbInstance = null }) {
  const db = dbInstance || getDb();

  // Do not track location compliance for MD Ankur Kaplesh (director@securedengineers.com)
  const user = db.prepare('SELECT id, name, email FROM users WHERE id = ?').get(userId);
  if (isMdLocationExempt(user)) return;
  const today = istToday();
  const nowIso = new Date().toISOString();
  const nowMs = Date.now();
  const nowStr = new Date(nowMs + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const activeCase = db.prepare(`
    SELECT * FROM compliance_cases 
    WHERE user_id = ? AND violation_type IN ('location_off', 'location_unavailable') 
      AND status = 'open'
    ORDER BY id DESC LIMIT 1
  `).get(userId);

  if (!activeCase) return;

  let meta = {};
  try {
    meta = typeof activeCase.metadata === 'string' ? JSON.parse(activeCase.metadata) : (activeCase.metadata || {});
  } catch (_) { meta = {}; }

  const offAt = new Date(meta.off_at || activeCase.detected_at);
  const onAt = new Date();
  const offTimeStr = formatISTTime(offAt);
  const onTimeStr = formatISTTime(onAt);
  const durationStr = formatDuration(onAt.getTime() - offAt.getTime());
  const monitor = getOrCreateComplianceMonitor(db);
  const empName = activeCase.employee_name || `User #${userId}`;

  // 1. Resolve case in compliance_cases
  const resNotes = `GPS restored at ${onTimeStr} IST on site: ${siteName} (${Number(latitude).toFixed(5)}, ${Number(longitude).toFixed(5)}). Total off duration: ${durationStr} (from ${offTimeStr} to ${onTimeStr} IST).`;

  db.prepare(`
    UPDATE compliance_cases 
    SET status = 'resolved', resolution_notes = ?, resolved_at = ?, updated_at = ?
    WHERE id = ?
  `).run(resNotes, nowIso, nowIso, activeCase.id);

  // 2. Audit log entry
  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performer_name, notes, created_at)
    VALUES (?, 'gps_restored', 'System Monitor', ?, ?)
  `).run(
    activeCase.id,
    resNotes,
    nowStr
  );

  // 3. Complete Lifecycle Report Notification to Nancy (in English)
  db.prepare(`
    INSERT INTO notifications (
      user_id, type, title, body, link_url, channel_sent,
      is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
    ) VALUES (?, 'compliance_monitor_alert', ?, ?, ?, 'in_app', 0, 0, 'compliance_case_monitor', ?, ?, 'active', ?)
  `).run(
    monitor.id,
    `GPS Restored: ${empName} (Was OFF for ${durationStr})`,
    `Employee ${empName} restored GPS at ${onTimeStr} IST on ${siteName}. Total off duration: ${durationStr} (from ${offTimeStr} to ${onTimeStr} IST).`,
    `/compliance?case_id=${activeCase.id}`,
    activeCase.id,
    nowStr,
    nowStr
  );

  try {
    const { getIO } = require('../lib/chatSocket');
    const io = getIO();
    if (io) {
      io.to('u:' + monitor.id).emit('notification:new', {
        type: 'compliance_monitor_alert',
        title: `GPS Restored: ${empName} (Was OFF for ${durationStr})`,
        body: `Employee ${empName} restored GPS at ${onTimeStr} IST on ${siteName}. Total off duration: ${durationStr} (from ${offTimeStr} to ${onTimeStr} IST).`,
        link_url: `/compliance?case_id=${activeCase.id}`,
        created_at: nowStr,
      });
    }
  } catch (_) {}

  // 4. Confirmation Notification to Employee (in English)
  db.prepare(`
    INSERT INTO notifications (
      user_id, type, title, body, link_url, channel_sent,
      is_mandatory, is_pending, task_type, task_id, delivered_at, status, created_at
    ) VALUES (?, 'compliance_alert', ?, ?, ?, 'in_app', 0, 0, 'compliance_case', ?, ?, 'active', ?)
  `).run(
    userId,
    `GPS Signal Restored`,
    `Your device GPS is active and verified at ${siteName}. Thank you.`,
    `/compliance?case_id=${activeCase.id}`,
    activeCase.id,
    nowStr,
    nowStr
  );

  try {
    const { getIO } = require('../lib/chatSocket');
    const io = getIO();
    if (io) {
      io.to('u:' + userId).emit('notification:new', {
        type: 'compliance_alert',
        title: `GPS Signal Restored`,
        body: `Your device GPS is active and verified at ${siteName}. Thank you.`,
        link_url: `/compliance?case_id=${activeCase.id}`,
        created_at: nowStr,
      });
    }
  } catch (_) {}
}

module.exports = {
  COMPLIANCE_MONITOR_EMAIL,
  COMPLIANCE_MONITOR_NAME,
  getOrCreateComplianceMonitor,
  generateCaseNumber,
  createComplianceCase,
  createMandatoryTaskNotification,
  acknowledgeMandatoryNotification,
  closeMandatoryTaskNotification,
  calculateComplianceKpi,
  formatDuration,
  formatISTTime,
  handleGpsOffEvent,
  handleGpsRestoredEvent,
  isMdLocationExempt,
};
