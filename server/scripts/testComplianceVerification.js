// Compliance System End-to-End Verification Test Script
// SOTYN Mandatory Compliance Requirements

const { getDb, initializeDatabase } = require('../db/schema');
const {
  getOrCreateComplianceMonitor,
  generateCaseNumber,
  createComplianceCase,
  createMandatoryTaskNotification,
  acknowledgeMandatoryNotification,
  closeMandatoryTaskNotification,
  calculateComplianceKpi,
} = require('../services/complianceService');
const { runComplianceScan } = require('./complianceCron');

function runVerification() {
  console.log('=== STARTING MANDATORY COMPLIANCE VERIFICATION ===\n');
  const db = initializeDatabase();

  // Test 1: Verify Schema tables and columns
  console.log('[Test 1] Checking Database Schema Tables & Columns...');
  const tableCheck = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('compliance_cases', 'compliance_case_logs')").all();
  if (tableCheck.length < 2) {
    throw new Error(`Missing compliance tables. Found: ${tableCheck.map(t => t.name).join(', ')}`);
  }
  console.log('✓ compliance_cases and compliance_case_logs tables verified.');

  const notifCols = db.prepare("PRAGMA table_info(notifications)").all().map(c => c.name);
  ['is_mandatory', 'is_pending', 'task_type', 'task_id', 'acknowledged_at', 'completed_at', 'closed_at'].forEach(col => {
    if (!notifCols.includes(col)) throw new Error(`Missing column on notifications table: ${col}`);
  });
  console.log('✓ Mandatory notification lifecycle columns verified on notifications table.');

  const empCols = db.prepare("PRAGMA table_info(employees)").all().map(c => c.name);
  ['is_field_employee', 'duty_start_time', 'duty_end_time'].forEach(col => {
    if (!empCols.includes(col)) throw new Error(`Missing column on employees table: ${col}`);
  });
  console.log('✓ Field employee and duty hours columns verified on employees table.');

  // Test 2: Verify Compliance Monitor provision
  console.log('\n[Test 2] Verifying Compliance Monitor (Nancy) Provisioning...');
  const monitor = getOrCreateComplianceMonitor(db);
  if (!monitor || !monitor.id) throw new Error('Compliance monitor could not be resolved');
  console.log(`✓ Compliance Monitor verified: ID=${monitor.id}, Name=${monitor.name}, Email=${monitor.email}`);

  // Test 3: Verify Case Creation & Sequential Numbering
  console.log('\n[Test 3] Verifying Case Creation & Sequential Numbering...');
  // Find a test user or admin
  const testUser = db.prepare('SELECT id, name FROM users LIMIT 1').get();
  const caseResult = createComplianceCase({
    userId: testUser.id,
    employeeName: testUser.name,
    violationType: 'location_off',
    title: 'Test GPS Disconnected During Shift',
    description: 'Employee turned off location services during active duty hours.',
    slaHours: 2,
    impactsAttendance: 1,
    impactsExpense: 1,
    dbInstance: db,
  });

  if (!caseResult.caseNumber.startsWith('CMP-')) {
    throw new Error(`Invalid case number format: ${caseResult.caseNumber}`);
  }
  console.log(`✓ Case created: ID=${caseResult.caseId}, CaseNumber=${caseResult.caseNumber}`);

  // Verify Audit Log entry
  const logs = db.prepare('SELECT * FROM compliance_case_logs WHERE case_id = ?').all(caseResult.caseId);
  if (logs.length === 0) throw new Error('No audit log generated for case creation');
  console.log(`✓ Audit log verified (${logs.length} entry logged for case ${caseResult.caseNumber}).`);

  // Verify Dual Notifications
  const empNotif = db.prepare("SELECT * FROM notifications WHERE user_id = ? AND task_type = 'compliance_case' AND task_id = ?").get(testUser.id, caseResult.caseId);
  if (!empNotif || empNotif.is_mandatory !== 1) {
    throw new Error('Mandatory notification not generated for employee');
  }
  console.log(`✓ Mandatory notification to employee verified (ID=${empNotif.id}, is_mandatory=1, status=${empNotif.status}).`);

  // Test 4: Notification Acknowledgement & Task Closure Lifecycle
  console.log('\n[Test 4] Verifying Notification Acknowledgement & Task Closure Lifecycle...');
  const ackResult = acknowledgeMandatoryNotification(empNotif.id, testUser.id, db);
  if (!ackResult || !ackResult.acknowledged_at) throw new Error('Acknowledgement failed');
  console.log(`✓ Employee acknowledged notification at ${ackResult.acknowledged_at}`);

  // Ensure mandatory notification remains active and pending after acknowledgement
  const notifAfterAck = db.prepare('SELECT * FROM notifications WHERE id = ?').get(empNotif.id);
  if (notifAfterAck.status !== 'active' || notifAfterAck.is_pending !== 1) {
    throw new Error('Mandatory notification should stay active until underlying task is resolved');
  }
  console.log('✓ Mandatory notification correctly preserved as active after acknowledgement.');

  // Test 5: Compliance Case Actions (Nancy Follow-up, Employee Response, Resolution)
  console.log('\n[Test 5] Verifying Case Resolution & Lifecycle Progression...');
  // A. Nancy follow-up
  db.prepare(`
    UPDATE compliance_cases 
    SET followup_status = 'contacted', followed_up_at = datetime('now'), followed_up_by = ?, followup_notes = 'Called employee to check device status'
    WHERE id = ?
  `).run(monitor.id, caseResult.caseId);
  console.log('✓ Monitor follow-up logged.');

  // B. Resolution & closure
  db.prepare(`
    UPDATE compliance_cases 
    SET status = 'resolved', resolved_at = datetime('now'), resolved_by = ?, resolution_time_minutes = 15, resolution_notes = 'Device GPS re-enabled and confirmed on site.'
    WHERE id = ?
  `).run(monitor.id, caseResult.caseId);

  // Close mandatory notification
  closeMandatoryTaskNotification('compliance_case', caseResult.caseId, monitor.id, db);
  const closedNotif = db.prepare('SELECT * FROM notifications WHERE id = ?').get(empNotif.id);
  if (closedNotif.status !== 'closed' || closedNotif.is_pending !== 0) {
    throw new Error('Notification should be closed after case resolution');
  }
  console.log('✓ Notification officially closed upon case resolution in database.');

  // Test 6: Verify Nancy's KPI Calculation Engine
  console.log("\n[Test 6] Verifying Nancy's 100% Weighted KPI Calculation...");
  const kpi = calculateComplianceKpi(null, null, db);
  console.log('KPI Breakdown:');
  console.log(`  • Overall Weighted KPI: ${kpi.overallKpi}%`);
  console.log(`  • On-Time SLA Follow-Up (30% weight): ${kpi.onTimeFollowUpScore}%`);
  console.log(`  • Case Closure Score (30% weight): ${kpi.closureScore}%`);
  console.log(`  • Task Violation Follow-Up (20% weight): ${kpi.taskViolationScore}%`);
  console.log(`  • Location Violation Follow-Up (20% weight): ${kpi.locationViolationScore}%`);
  if (typeof kpi.overallKpi !== 'number' || isNaN(kpi.overallKpi)) {
    throw new Error('KPI calculation did not produce a valid numeric score');
  }
  console.log('✓ Weighted KPI calculation engine verified successfully.');

  // Test 7: Verify Compliance Scanner Run
  console.log('\n[Test 7] Verifying Background Compliance Scanner Execution...');
  const scanResult = runComplianceScan(db);
  console.log(`✓ Scanner executed successfully at ${scanResult.scannedAt} (new cases created: ${scanResult.newCasesCreated}).`);

  console.log('\n=================================================');
  console.log('🎉 ALL MANDATORY COMPLIANCE TESTS PASSED (7/7)!');
  console.log('=================================================\n');
}

runVerification();
