const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  evaluateLateAttendance,
  buildLateNotificationPayload,
  sendLateNotifications,
  countPreviousLatesThisMonth,
} = require('../lateAttendanceNotifier');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      phone TEXT,
      role TEXT,
      auto_mark_present INTEGER DEFAULT 0
    );

    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      email TEXT,
      phone TEXT,
      roster TEXT,
      salary REAL DEFAULT 0,
      salary_exempt INTEGER DEFAULT 0
    );

    CREATE TABLE payroll_settings (
      id INTEGER PRIMARY KEY,
      late_grace_count INTEGER DEFAULT 3,
      late_per_minute_rate REAL DEFAULT 20,
      late_after_time TEXT DEFAULT '09:46',
      half_day_after_time TEXT DEFAULT '10:00',
      skip_half_day_if_short_leave INTEGER DEFAULT 1
    );

    CREATE TABLE leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      leave_type TEXT,
      from_date TEXT,
      to_date TEXT,
      status TEXT DEFAULT 'approved',
      hours REAL DEFAULT 0
    );

    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT,
      punch_in_time TEXT,
      status TEXT,
      admin_marked INTEGER DEFAULT 0
    );

    CREATE TABLE notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      type TEXT,
      title TEXT,
      body TEXT,
      link_url TEXT,
      channel_sent TEXT,
      dedupe_key TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT INTO payroll_settings (id, late_grace_count, late_per_minute_rate, late_after_time, half_day_after_time, skip_half_day_if_short_leave)
    VALUES (1, 3, 20, '09:46', '10:00', 1);
  `);
  return db;
}

test('evaluateLateAttendance - On-time punch in does not notify', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
  `);

  // Wednesday 2026-10-28 at 09:35 IST = 04:05 UTC (on time before 09:46 cutoff)
  const punchUtc = '2026-10-28T04:05:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, false);
  assert.equal(res.status, 'present');
});

test('evaluateLateAttendance - Sunday punch in does not notify', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
  `);

  // Sunday 2026-10-25 at 10:15 IST = 04:45 UTC
  const punchUtc = '2026-10-25T04:45:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-25' });

  assert.equal(res.shouldNotify, false);
  assert.equal(res.reason, 'sunday_work');
});

test('evaluateLateAttendance - salary_exempt employee does not notify', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (2, 'Director Sahib', 'director@example.com', '9876543211');
    INSERT INTO employees (user_id, name, roster, salary, salary_exempt) VALUES (2, 'Director Sahib', 'general', 100000, 1);
  `);

  // Wednesday at 10:05 IST
  const punchUtc = '2026-10-28T04:35:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 2, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, false);
  assert.equal(res.reason, 'salary_exempt');
});

test('evaluateLateAttendance - Approved short leave excuses late punch', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
    INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, status)
    VALUES (1, 'short_leave', '2026-10-28', '2026-10-28', 'approved');
  `);

  // Wednesday at 09:50 IST (would normally be late)
  const punchUtc = '2026-10-28T04:20:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, false);
  assert.equal(res.reason, 'excused_by_approved_short_leave');
});

test('evaluateLateAttendance - Pending short leave notifies with reassurance and ₹0 deduction', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
    INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, status, hours)
    VALUES (1, 'short_leave', '2026-10-28', '2026-10-28', 'pending', 2);
  `);

  // Wednesday at 09:50 IST (pending manager approval)
  const punchUtc = '2026-10-28T04:20:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'SHORT_LEAVE_PENDING');
  assert.equal(res.deduction, 0);

  const payload = buildLateNotificationPayload(res);
  assert.match(payload.whatsapp, /Short Leave Applied \(Pending Manager Approval\)/);
  assert.match(payload.whatsapp, /₹0\.00 \(Pending Review\)/);
  assert.match(payload.emailSubject, /Short Leave Pending/);
});

test('evaluateLateAttendance - Tier 1: Grace Late (1st late in month, ₹0 deduction)', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
  `);

  // Wednesday 2026-10-28 at 09:48 IST = 04:18 UTC (3 min late: 09:48 - 09:46 + 1 = 3)
  const punchUtc = '2026-10-28T04:18:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'GRACE_WARNING');
  assert.equal(res.deduction, 0);
  assert.equal(res.minutesLate, 3);
  assert.equal(res.lateRank, 1);
  assert.equal(res.graceRemaining, 2);

  const payload = buildLateNotificationPayload(res);
  assert.match(payload.whatsapp, /Grace Late \(1\/3\)/);
  assert.match(payload.whatsapp, /₹0\.00 \(Grace Applied\)/);
  assert.match(payload.emailSubject, /Grace Used 1\/3/);
});

test('evaluateLateAttendance - Tier 2: Per-Minute Penalty (4th late in month, ₹20/min deduction)', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);

    -- 3 previous late arrivals already this month
    INSERT INTO attendance (user_id, date, punch_in_time, status) VALUES
      (1, '2026-10-05', '2026-10-05T04:20:00.000Z', 'late'),
      (1, '2026-10-12', '2026-10-12T04:22:00.000Z', 'late'),
      (1, '2026-10-19', '2026-10-19T04:25:00.000Z', 'late');
  `);

  // 4th late: 2026-10-28 at 09:50 IST = 04:20 UTC (5 min late: 09:50 - 09:46 + 1 = 5)
  const punchUtc = '2026-10-28T04:20:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'PER_MINUTE_DEDUCTION');
  assert.equal(res.minutesLate, 5);
  assert.equal(res.lateRank, 4);
  assert.equal(res.perMinuteRate, 20);
  assert.equal(res.deduction, 100); // 5 min * 20 = ₹100

  const payload = buildLateNotificationPayload(res);
  assert.match(payload.whatsapp, /₹100\.00/);
  assert.match(payload.whatsapp, /Monthly Grace Exhausted/);
  assert.match(payload.emailSubject, /₹100\.00 for Late Punch-In/);
});

test('evaluateLateAttendance - Tier 3: Half-Day (Arrival past 10:00 cutoff)', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
  `);

  // 2026-10-28 at 10:15 IST = 04:45 UTC (cutoff is 10:00)
  // In October (31 days), per-day rate = 31000 / 31 = 1000. Half-day = 500
  const punchUtc = '2026-10-28T04:45:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'HALF_DAY');
  assert.equal(res.status, 'half_day');
  assert.equal(res.deduction, 500);
  assert.equal(res.shortLeaveHoursRemaining, 4); // 4 hours remaining

  const payload = buildLateNotificationPayload(res);
  assert.match(payload.whatsapp, /Half-Day Recorded/);
  assert.match(payload.whatsapp, /₹500\.00/);
  assert.match(payload.whatsapp, /Short Leave Available/);
  assert.match(payload.emailSubject, /Half-Day Recorded/);
  assert.match(payload.emailHtml, /Short Leave Quota Available \(4 hours remaining\)/);
});

test('evaluateLateAttendance - Early Shift (09:00 AM start, late after 09:16, half-day after 09:30)', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (3, 'Site Engineer Amit', 'amit@example.com', '9876543212');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (3, 'Site Engineer Amit', 'early', 30000);
  `);

  // Arrives at 09:20 IST = 03:50 UTC (5 min late: 09:20 - 09:16 + 1 = 5)
  const punchUtc = '2026-10-28T03:50:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 3, punchInTime: punchUtc, date: '2026-10-28' });

  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'GRACE_WARNING');
  assert.equal(res.minutesLate, 5);
  assert.equal(res.lateRank, 1);
});

test('sendLateNotifications - Deduplication prevents sending twice for same date', async () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone) VALUES (1, 'Rajat Sharma', 'rajat@example.com', '9876543210');
    INSERT INTO employees (user_id, name, roster, salary) VALUES (1, 'Rajat Sharma', 'general', 31000);
  `);

  const punchUtc = '2026-10-28T04:18:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 1, punchInTime: punchUtc, date: '2026-10-28' });

  const firstSend = await sendLateNotifications(db, res);
  assert.equal(firstSend.ok, true);

  // Check notifications table was populated
  const notif = db.prepare('SELECT * FROM notifications WHERE dedupe_key=?').get('late_attendance_1_2026-10-28');
  assert.ok(notif);
  assert.match(notif.title, /Grace 1\/3 Used/);

  // Second send with same evalResult should skip
  const secondSend = await sendLateNotifications(db, res);
  assert.equal(secondSend.skipped, true);
  assert.equal(secondSend.reason, 'already_notified');
});

test('evaluateLateAttendance - auto_mark_present=1 main persons are completely exempt', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone, role, auto_mark_present) VALUES (5, 'Main Person', 'main@example.com', '9876543215', 'admin', 1);
    INSERT INTO employees (user_id, name, roster, salary) VALUES (5, 'Main Person', 'general', 100000);
  `);

  const punchUtc = '2026-10-28T04:45:00.000Z'; // 10:15 IST
  const res = evaluateLateAttendance(db, { userId: 5, punchInTime: punchUtc, date: '2026-10-28' });
  assert.equal(res.shouldNotify, false);
  assert.equal(res.reason, 'salary_exempt');
});

test('evaluateLateAttendance - Employee with role=admin who punches daily DOES receive late alerts', () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone, role, auto_mark_present) VALUES (6, 'IT Admin Emp', 'it@example.com', '9876543216', 'admin', 0);
    INSERT INTO employees (user_id, name, roster, salary, salary_exempt) VALUES (6, 'IT Admin Emp', 'general', 35000, 0);
  `);

  // Arrives at 09:48 IST (3 min late on 1st grace)
  const punchUtc = '2026-10-28T04:18:00.000Z';
  const res = evaluateLateAttendance(db, { userId: 6, punchInTime: punchUtc, date: '2026-10-28' });
  assert.equal(res.shouldNotify, true);
  assert.equal(res.tier, 'GRACE_WARNING');
  assert.equal(res.minutesLate, 3);
});

