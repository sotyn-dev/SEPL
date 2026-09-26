const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, getUserPermissions } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const {
  createComplianceCase,
  calculateComplianceKpi,
  getOrCreateComplianceMonitor,
  closeMandatoryTaskNotification,
} = require('../services/complianceService');
const { runComplianceScan } = require('../scripts/complianceCron');

const router = express.Router();
router.use(authMiddleware);

/**
 * Checks if user is Compliance Monitor, HR, or Admin
 */
function isMonitorOrAdmin(req) {
  if (req.user.role === 'admin') return true;
  const user = req.user;
  if (user.email && user.email.toLowerCase().includes('nancy')) return true;
  if (user.department && user.department.toLowerCase().includes('hr')) return true;
  const perms = getUserPermissions(user.id);
  if (perms?.compliance?.can_view) return true;
  return false;
}

// ── 1. COMPLIANCE DASHBOARD OVERVIEW & KPIS ──────────────────────
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const monitor = getOrCreateComplianceMonitor(db);
  const kpiData = calculateComplianceKpi(req.query.start_date, req.query.end_date, db);

  // Total open, in-progress, resolved counts
  const statusCounts = db.prepare(`
    SELECT status, COUNT(*) as count 
    FROM compliance_cases 
    GROUP BY status
  `).all().reduce((acc, row) => { acc[row.status] = row.count; return acc; }, {});

  // Violation type breakdown
  const violationCounts = db.prepare(`
    SELECT violation_type, COUNT(*) as count 
    FROM compliance_cases 
    GROUP BY violation_type
  `).all();

  // Pending follow-ups (overdue SLA)
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const overdueFollowups = db.prepare(`
    SELECT COUNT(*) as count 
    FROM compliance_cases 
    WHERE followup_status = 'pending' 
      AND status NOT IN ('resolved', 'closed') 
      AND sla_deadline < ?
  `).get(nowStr)?.count || 0;

  // Average resolution time in minutes
  const avgRes = db.prepare(`
    SELECT AVG(resolution_time_minutes) as avg_res 
    FROM compliance_cases 
    WHERE status IN ('resolved', 'closed') AND resolution_time_minutes IS NOT NULL
  `).get()?.avg_res || 0;

  // Recent 10 compliance cases
  const recentCases = db.prepare(`
    SELECT c.*, u.department as user_department, u.phone as user_phone
    FROM compliance_cases c
    LEFT JOIN users u ON c.user_id = u.id
    ORDER BY c.detected_at DESC LIMIT 10
  `).all();

  res.json({
    monitor: {
      id: monitor.id,
      name: monitor.name,
      email: monitor.email,
    },
    metrics: {
      totalViolations: kpiData.totalCases,
      openViolations: (statusCounts.open || 0) + (statusCounts.in_progress || 0) + (statusCounts.pending_employee || 0),
      resolvedViolations: (statusCounts.resolved || 0) + (statusCounts.closed || 0),
      overdueFollowups,
      avgResolutionTimeMinutes: Math.round(avgRes),
      statusCounts,
      violationCounts,
    },
    kpi: kpiData,
    recentCases,
  });
});

// ── 2. GET COMPLIANCE CASES LIST (WITH FILTERS) ─────────────────
router.get('/cases', (req, res) => {
  const db = getDb();
  const { status, violation_type, user_id, start_date, end_date, search, page = 1, limit = 50 } = req.query;

  let whereClauses = ['1=1'];
  const params = [];

  // If regular employee without monitor/admin access, restrict to own cases
  if (!isMonitorOrAdmin(req)) {
    whereClauses.push('c.user_id = ?');
    params.push(req.user.id);
  } else if (user_id) {
    whereClauses.push('c.user_id = ?');
    params.push(user_id);
  }

  if (status && status !== 'all') {
    whereClauses.push('c.status = ?');
    params.push(status);
  }

  if (violation_type && violation_type !== 'all') {
    whereClauses.push('c.violation_type = ?');
    params.push(violation_type);
  }

  if (start_date) {
    whereClauses.push('DATE(c.detected_at) >= ?');
    params.push(start_date);
  }

  if (end_date) {
    whereClauses.push('DATE(c.detected_at) <= ?');
    params.push(end_date);
  }

  if (search) {
    whereClauses.push('(c.case_number LIKE ? OR c.employee_name LIKE ? OR c.title LIKE ? OR c.description LIKE ?)');
    const term = `%${search}%`;
    params.push(term, term, term, term);
  }

  const offset = (Number(page) - 1) * Number(limit);
  const whereSql = whereClauses.join(' AND ');

  const total = db.prepare(`SELECT COUNT(*) as count FROM compliance_cases c WHERE ${whereSql}`).get(...params)?.count || 0;

  const cases = db.prepare(`
    SELECT c.*, 
           u.department as user_department, 
           u.phone as user_phone, 
           u.avatar_url,
           m.name as assigned_to_name
    FROM compliance_cases c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN users m ON c.assigned_to = m.id
    WHERE ${whereSql}
    ORDER BY c.detected_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, Number(limit), offset);

  res.json({ cases, total, page: Number(page), limit: Number(limit) });
});

// ── 3. GET SINGLE CASE DETAIL & AUDIT LOGS ──────────────────────
router.get('/cases/:id', (req, res) => {
  const db = getDb();
  const caseItem = db.prepare(`
    SELECT c.*, 
           u.department as user_department, 
           u.phone as user_phone, 
           u.email as user_email,
           m.name as assigned_to_name,
           fb.name as followed_up_by_name,
           rb.name as resolved_by_name
    FROM compliance_cases c
    LEFT JOIN users u ON c.user_id = u.id
    LEFT JOIN users m ON c.assigned_to = m.id
    LEFT JOIN users fb ON c.followed_up_by = fb.id
    LEFT JOIN users rb ON c.resolved_by = rb.id
    WHERE c.id = ?
  `).get(req.params.id);

  if (!caseItem) return res.status(404).json({ error: 'Compliance case not found' });

  // Security check: only own cases or monitor/admin
  if (!isMonitorOrAdmin(req) && caseItem.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied to this compliance case' });
  }

  const logs = db.prepare(`
    SELECT l.*, u.name as performer_name_resolved
    FROM compliance_case_logs l
    LEFT JOIN users u ON l.performed_by = u.id
    WHERE l.case_id = ?
    ORDER BY l.created_at ASC
  `).all(req.params.id);

  res.json({ caseItem, logs });
});

// ── 4. LOG NANCY / MONITOR FOLLOW-UP ────────────────────────────
router.post('/cases/:id/followup', (req, res) => {
  if (!isMonitorOrAdmin(req)) return res.status(403).json({ error: 'Only Compliance Monitor or Admin can log follow-ups' });

  const { notes, status = 'in_progress' } = req.body;
  if (!notes || !notes.trim()) return res.status(400).json({ error: 'Follow-up notes are required' });

  const db = getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const existing = db.prepare('SELECT * FROM compliance_cases WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Case not found' });

  db.prepare(`
    UPDATE compliance_cases 
    SET followup_status = 'contacted',
        followed_up_at = COALESCE(followed_up_at, ?),
        followed_up_by = ?,
        followup_notes = ?,
        status = ?,
        updated_at = ?
    WHERE id = ?
  `).run(nowStr, req.user.id, notes.trim(), status, nowStr, req.params.id);

  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performed_by, performer_name, notes, created_at)
    VALUES (?, 'monitor_followup', ?, ?, ?, ?)
  `).run(req.params.id, req.user.id, req.user.name, notes.trim(), nowStr);

  res.json({ message: 'Follow-up logged successfully', followed_up_at: nowStr });
});

// ── 5. EMPLOYEE OR MONITOR RESPONSE ─────────────────────────────
router.post('/cases/:id/employee-response', (req, res) => {
  const { response } = req.body;
  if (!response || !response.trim()) return res.status(400).json({ error: 'Response text is required' });

  const db = getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  const caseItem = db.prepare('SELECT * FROM compliance_cases WHERE id = ?').get(req.params.id);
  if (!caseItem) return res.status(404).json({ error: 'Case not found' });

  if (!isMonitorOrAdmin(req) && caseItem.user_id !== req.user.id) {
    return res.status(403).json({ error: 'Access denied' });
  }

  db.prepare(`
    UPDATE compliance_cases 
    SET employee_response = ?,
        employee_responded_at = ?,
        status = 'in_progress',
        updated_at = ?
    WHERE id = ?
  `).run(response.trim(), nowStr, nowStr, req.params.id);

  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performed_by, performer_name, notes, created_at)
    VALUES (?, 'employee_response', ?, ?, ?, ?)
  `).run(req.params.id, req.user.id, req.user.name, response.trim(), nowStr);

  res.json({ message: 'Response submitted successfully', employee_responded_at: nowStr });
});

// ── 6. RESOLVE & CLOSE CASE ─────────────────────────────────────
router.post('/cases/:id/resolve', (req, res) => {
  if (!isMonitorOrAdmin(req)) return res.status(403).json({ error: 'Only Compliance Monitor or Admin can resolve cases' });

  const { resolution_notes, status = 'resolved', impacts_attendance, impacts_expense } = req.body;
  if (!resolution_notes || !resolution_notes.trim()) return res.status(400).json({ error: 'Resolution notes are required' });

  const db = getDb();
  const caseItem = db.prepare('SELECT * FROM compliance_cases WHERE id = ?').get(req.params.id);
  if (!caseItem) return res.status(404).json({ error: 'Case not found' });

  const now = new Date(Date.now() + 5.5 * 3600 * 1000);
  const nowStr = now.toISOString().replace('T', ' ').slice(0, 19);

  const detectedMs = new Date(caseItem.detected_at).getTime();
  const resMs = now.getTime();
  const resolutionMinutes = Math.max(1, Math.round((resMs - detectedMs) / (60 * 1000)));

  db.prepare(`
    UPDATE compliance_cases 
    SET resolution_notes = ?,
        resolved_at = ?,
        resolved_by = ?,
        resolution_time_minutes = ?,
        status = ?,
        impacts_attendance = COALESCE(?, impacts_attendance),
        impacts_expense = COALESCE(?, impacts_expense),
        updated_at = ?
    WHERE id = ?
  `).run(
    resolution_notes.trim(),
    nowStr,
    req.user.id,
    resolutionMinutes,
    status,
    impacts_attendance !== undefined ? (impacts_attendance ? 1 : 0) : null,
    impacts_expense !== undefined ? (impacts_expense ? 1 : 0) : null,
    nowStr,
    req.params.id
  );

  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performed_by, performer_name, notes, created_at)
    VALUES (?, 'case_resolved', ?, ?, ?, ?)
  `).run(req.params.id, req.user.id, req.user.name, resolution_notes.trim(), nowStr);

  // Close linked mandatory notifications
  closeMandatoryTaskNotification('compliance_case', caseItem.id, req.user.id, db);

  res.json({ message: 'Case resolved and closed successfully', resolved_at: nowStr, resolution_time_minutes: resolutionMinutes });
});

// ── 7. UPDATE ATTENDANCE & EXPENSE REVIEW FLAGS ─────────────────
router.post('/cases/:id/review-flags', (req, res) => {
  if (!isMonitorOrAdmin(req)) return res.status(403).json({ error: 'Only Compliance Monitor or Admin can update review flags' });

  const { impacts_attendance, impacts_expense, attendance_flag_notes, expense_flag_notes } = req.body;
  const db = getDb();
  const nowStr = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19);

  db.prepare(`
    UPDATE compliance_cases 
    SET impacts_attendance = COALESCE(?, impacts_attendance),
        impacts_expense = COALESCE(?, impacts_expense),
        attendance_flag_notes = COALESCE(?, attendance_flag_notes),
        expense_flag_notes = COALESCE(?, expense_flag_notes),
        updated_at = ?
    WHERE id = ?
  `).run(
    impacts_attendance !== undefined ? (impacts_attendance ? 1 : 0) : null,
    impacts_expense !== undefined ? (impacts_expense ? 1 : 0) : null,
    attendance_flag_notes !== undefined ? attendance_flag_notes : null,
    expense_flag_notes !== undefined ? expense_flag_notes : null,
    nowStr,
    req.params.id
  );

  db.prepare(`
    INSERT INTO compliance_case_logs (case_id, action, performed_by, performer_name, notes, created_at)
    VALUES (?, 'flags_updated', ?, ?, 'Attendance & Field Expense flags updated', ?)
  `).run(req.params.id, req.user.id, req.user.name, nowStr);

  res.json({ message: 'Compliance flags updated successfully' });
});

// ── 8. GET NANCY KPI BREAKDOWN ──────────────────────────────────
router.get('/kpi', (req, res) => {
  const { start_date, end_date } = req.query;
  const kpiData = calculateComplianceKpi(start_date, end_date);
  res.json(kpiData);
});

// ── 9. EMPLOYEE MY-CASES ENDPOINT ───────────────────────────────
router.get('/my-cases', (req, res) => {
  const db = getDb();
  const myCases = db.prepare(`
    SELECT * FROM compliance_cases 
    WHERE user_id = ? 
    ORDER BY detected_at DESC
  `).all(req.user.id);

  res.json(myCases);
});

// ── 10. MANUAL SCAN TRIGGER ─────────────────────────────────────
router.post('/scan-now', (req, res) => {
  if (!isMonitorOrAdmin(req)) return res.status(403).json({ error: 'Access denied' });
  const result = runComplianceScan();
  res.json({ message: 'Compliance scan completed', ...result });
});

// ── 11. MANUAL CASE CREATION ────────────────────────────────────
router.post('/create-case', (req, res) => {
  if (!isMonitorOrAdmin(req)) return res.status(403).json({ error: 'Access denied' });

  const { user_id, violation_type, title, description, sla_hours = 4, impacts_attendance, impacts_expense } = req.body;
  if (!user_id || !violation_type || !title) {
    return res.status(400).json({ error: 'user_id, violation_type, and title are required' });
  }

  const result = createComplianceCase({
    userId: user_id,
    violationType: violation_type,
    title,
    description,
    slaHours: Number(sla_hours),
    impactsAttendance: impacts_attendance !== undefined ? impacts_attendance : 1,
    impactsExpense: impacts_expense !== undefined ? impacts_expense : 1,
  });

  res.status(201).json({ message: 'Compliance case created successfully', ...result });
});

module.exports = router;
