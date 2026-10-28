const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  scanAndNotifyAbsentEmployees,
  buildAbsenteeismPayload,
} = require('../dailyAbsenteeismNotifier');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      phone TEXT,
      role TEXT,
      auto_mark_present INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1
    );

    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      email TEXT,
      phone TEXT,
      department TEXT,
      designation TEXT,
      status TEXT DEFAULT 'active',
      join_date TEXT,
      exit_date TEXT,
      salary_exempt INTEGER DEFAULT 0
    );

    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT,
      punch_in_time TEXT,
      punch_out_time TEXT,
      status TEXT,
      admin_marked INTEGER DEFAULT 0
    );

    CREATE TABLE leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      leave_type TEXT,
      from_date TEXT,
      to_date TEXT,
      status TEXT DEFAULT 'approved'
    );

    CREATE TABLE payroll_holidays (
      date TEXT PRIMARY KEY,
      name TEXT
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
  `);
  return db;
}

test('dailyAbsenteeism - Skips on Sunday', async () => {
  const db = setupTestDb();
  // 2026-10-25 was Sunday
  const res = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-25', forceTimeCheck: true });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'sunday');
});

test('dailyAbsenteeism - Skips on Company Holiday', async () => {
  const db = setupTestDb();
  db.exec(`INSERT INTO payroll_holidays (date, name) VALUES ('2026-10-28', 'Diwali');`);
  const res = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-28', forceTimeCheck: true });
  assert.equal(res.skipped, true);
  assert.equal(res.reason, 'company_holiday');
  assert.equal(res.holiday, 'Diwali');
});

test('dailyAbsenteeism - Attended or On-Leave employees are not notified, only uninformed absentees', async () => {
  const db = setupTestDb();
  db.exec(`
    -- User 1: Punched in today (attended)
    INSERT INTO users (id, name, email, phone, active) VALUES (1, 'Attended Emp', 'user1@example.com', '9876543201', 1);
    INSERT INTO employees (user_id, name, status, join_date) VALUES (1, 'Attended Emp', 'active', '2026-01-01');
    INSERT INTO attendance (user_id, date, punch_in_time, status) VALUES (1, '2026-10-28', '2026-10-28T04:00:00Z', 'present');

    -- User 2: Applied for Casual Leave (pending or approved)
    INSERT INTO users (id, name, email, phone, active) VALUES (2, 'Leave Emp', 'user2@example.com', '9876543202', 1);
    INSERT INTO employees (user_id, name, status, join_date) VALUES (2, 'Leave Emp', 'active', '2026-01-01');
    INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, status)
    VALUES (2, 'casual', '2026-10-28', '2026-10-28', 'pending');

    -- User 3: Inactive / Resigned
    INSERT INTO users (id, name, email, phone, active) VALUES (3, 'Exited Emp', 'user3@example.com', '9876543203', 0);
    INSERT INTO employees (user_id, name, status, join_date, exit_date) VALUES (3, 'Exited Emp', 'terminated', '2026-01-01', '2026-10-01');

    -- User 4: Active, NO punch and NO leave (Uninformed Absentee)
    INSERT INTO users (id, name, email, phone, active) VALUES (4, 'Absent Emp', 'user4@example.com', '9876543204', 1);
    INSERT INTO employees (user_id, name, status, join_date) VALUES (4, 'Absent Emp', 'active', '2026-01-01');
  `);

  const res = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-28', forceTimeCheck: true });
  assert.equal(res.absentNotifiedCount, 1);
  assert.equal(res.notified[0].userId, 4);

  // Check notifications table recorded the row
  const notif = db.prepare('SELECT * FROM notifications WHERE user_id=? AND dedupe_key=?').get(4, 'absent_notice:4:2026-10-28');
  assert.ok(notif);
  assert.equal(notif.type, 'attendance_absent');
  assert.match(notif.title, /Uninformed Absence/);
});

test('dailyAbsenteeism - Deduplication prevents sending twice on the same day', async () => {
  const db = setupTestDb();
  db.exec(`
    INSERT INTO users (id, name, email, phone, active) VALUES (4, 'Absent Emp', 'user4@example.com', '9876543204', 1);
    INSERT INTO employees (user_id, name, status, join_date) VALUES (4, 'Absent Emp', 'active', '2026-01-01');
  `);

  const firstRun = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-28', forceTimeCheck: true });
  assert.equal(firstRun.absentNotifiedCount, 1);

  // Second run on same date should notify 0 employees
  const secondRun = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-28', forceTimeCheck: true });
  assert.equal(secondRun.absentNotifiedCount, 0);
});

test('dailyAbsenteeism - Payload contains clear HR notice and regularization instructions', () => {
  const payload = buildAbsenteeismPayload({ empName: 'Rajat Sharma', date: '2026-10-28' });
  assert.match(payload.whatsapp, /Marked Absent \(Uninformed \/ Loss of Pay\)/);
  assert.match(payload.whatsapp, /6:30 PM shift end/);
  assert.match(payload.emailSubject, /Uninformed Absence Notice for 2026-10-28/);
  assert.match(payload.emailHtml, /1 Day Loss of Pay/);
  assert.match(payload.emailHtml, /Attendance &gt; Leaves/);
});

test('dailyAbsenteeism - auto_mark_present main persons are exempt, while regular staff with admin role who punch daily ARE checked', async () => {
  const db = setupTestDb();
  db.exec(`
    -- Main Person (Director/Admin with auto_mark_present=1) -> EXEMPT
    INSERT INTO users (id, name, email, phone, role, auto_mark_present, active)
    VALUES (10, 'Director Admin', 'director@example.com', '9876543210', 'admin', 1, 1);
    INSERT INTO employees (user_id, name, status, join_date)
    VALUES (10, 'Director Admin', 'active', '2026-01-01');

    -- Regular employee with admin role access (auto_mark_present=0, salary_exempt=0) -> MUST be checked
    INSERT INTO users (id, name, email, phone, role, auto_mark_present, active)
    VALUES (11, 'IT Support Admin', 'support@example.com', '9876543211', 'admin', 0, 1);
    INSERT INTO employees (user_id, name, status, join_date)
    VALUES (11, 'IT Support Admin', 'active', '2026-01-01');
  `);

  const res = await scanAndNotifyAbsentEmployees(db, { targetDate: '2026-10-28', forceTimeCheck: true });
  // Director Admin (id 10) must be skipped, but IT Support Admin (id 11) must be notified!
  assert.equal(res.absentNotifiedCount, 1);
  assert.equal(res.notified[0].userId, 11);
});

