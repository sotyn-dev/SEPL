const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const attendanceRouter = require('../attendance');
const evaluateLeaveAutoApproval = attendanceRouter.evaluateLeaveAutoApproval;

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT,
      email TEXT,
      role TEXT
    );
    CREATE TABLE employees (
      id INTEGER PRIMARY KEY,
      user_id INTEGER,
      join_date TEXT,
      joining_date TEXT,
      cl_eligible INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active'
    );
    CREATE TABLE leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      leave_type TEXT,
      from_date TEXT,
      to_date TEXT,
      from_time TEXT,
      to_time TEXT,
      days REAL DEFAULT 0,
      hours REAL DEFAULT 0,
      reason TEXT,
      status TEXT DEFAULT 'pending',
      approved_by INTEGER,
      remarks TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  return db;
}

describe('Leave Request Rules & Auto-Approval', () => {
  it('probation employee (< 3 months) gets pending status with notice of 0 paid leave', () => {
    const db = setupTestDb();
    // Joined 1 month ago
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (1, 'Probation User', 'p@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, join_date, status) VALUES (1, 1, '2026-10-01', 'active')").run();

    const result = evaluateLeaveAutoApproval(db, 1, {
      leave_type: 'casual',
      from_date: '2026-11-10',
      to_date: '2026-11-10',
      days: 1
    });

    assert.equal(result.status, 'pending');
    assert.match(result.remarks, /Probation period active.*unpaid/i);
  });

  it('confirmed employee (>= 3 months): first full-day leave in month is auto-approved', () => {
    const db = setupTestDb();
    // Joined 6 months ago
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (2, 'Confirmed User', 'c@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, join_date, status) VALUES (2, 2, '2026-01-01', 'active')").run();

    const result = evaluateLeaveAutoApproval(db, 2, {
      leave_type: 'casual',
      from_date: '2026-11-10',
      to_date: '2026-11-10',
      days: 1
    });

    assert.equal(result.status, 'approved');
    assert.match(result.remarks, /Auto-approved.*1.*day/i);
  });

  it('confirmed employee: second full-day leave in the same month is auto-rejected (quota exceeded)', () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (2, 'Confirmed User', 'c@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, join_date, status) VALUES (2, 2, '2026-01-01', 'active')").run();

    // Already had 1 full day approved in November
    db.prepare(`
      INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, status)
      VALUES (2, 'casual', '2026-11-05', '2026-11-05', 1, 'approved')
    `).run();

    const result = evaluateLeaveAutoApproval(db, 2, {
      leave_type: 'sick',
      from_date: '2026-11-20',
      to_date: '2026-11-20',
      days: 1
    });

    assert.equal(result.status, 'rejected');
    assert.match(result.remarks, /Auto-rejected.*monthly paid leave allowance.*already utilized/i);
  });

  it('confirmed employee: can take up to 2 half-days in a month; 3rd half-day is auto-rejected', () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (3, 'Half Day User', 'h@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, join_date, status) VALUES (3, 3, '2026-01-01', 'active')").run();

    // 1st half day: auto-approved
    const res1 = evaluateLeaveAutoApproval(db, 3, {
      leave_type: 'half_day',
      from_date: '2026-11-05',
      to_date: '2026-11-05',
      days: 0.5
    });
    assert.equal(res1.status, 'approved');
    db.prepare("INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, status) VALUES (3, 'half_day', '2026-11-05', '2026-11-05', 0.5, 'approved')").run();

    // 2nd half day: auto-approved (total 1.0 day / 2 half days)
    const res2 = evaluateLeaveAutoApproval(db, 3, {
      leave_type: 'half_day',
      from_date: '2026-11-12',
      to_date: '2026-11-12',
      days: 0.5
    });
    assert.equal(res2.status, 'approved');
    db.prepare("INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, days, status) VALUES (3, 'half_day', '2026-11-12', '2026-11-12', 0.5, 'approved')").run();

    // 3rd half day: auto-rejected (monthly limit reached)
    const res3 = evaluateLeaveAutoApproval(db, 3, {
      leave_type: 'half_day',
      from_date: '2026-11-25',
      to_date: '2026-11-25',
      days: 0.5
    });
    assert.equal(res3.status, 'rejected');
    assert.match(res3.remarks, /Auto-rejected.*monthly paid leave allowance.*already utilized/i);
  });

  it('short leave: up to 4 hours/month auto-approved; exceeding hours auto-rejected', () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (4, 'Short Leave User', 's@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, joining_date, status) VALUES (4, 4, '2026-01-01', 'active')").run();

    // 1st short leave: 2 hrs -> auto-approved
    const res1 = evaluateLeaveAutoApproval(db, 4, {
      leave_type: 'short_leave',
      from_date: '2026-11-03',
      to_date: '2026-11-03',
      hours: 2
    });
    assert.equal(res1.status, 'approved');
    db.prepare("INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, hours, status) VALUES (4, 'short_leave', '2026-11-03', '2026-11-03', 2, 'approved')").run();

    // 2nd short leave: 2 hrs -> auto-approved (total 4 hrs)
    const res2 = evaluateLeaveAutoApproval(db, 4, {
      leave_type: 'short_leave',
      from_date: '2026-11-15',
      to_date: '2026-11-15',
      hours: 2
    });
    assert.equal(res2.status, 'approved');
    db.prepare("INSERT INTO leave_requests (user_id, leave_type, from_date, to_date, hours, status) VALUES (4, 'short_leave', '2026-11-15', '2026-11-15', 2, 'approved')").run();

    // 3rd short leave: 1 hr -> exceeds 4 hrs -> auto-rejected
    const res3 = evaluateLeaveAutoApproval(db, 4, {
      leave_type: 'short_leave',
      from_date: '2026-11-20',
      to_date: '2026-11-20',
      hours: 1
    });
    assert.equal(res3.status, 'rejected');
    assert.match(res3.remarks, /Auto-rejected.*Monthly short leave limit is 4 hrs/i);
  });

  it('multi-day leave (>1 day) submitted at once is auto-rejected if exceeding monthly allowance', () => {
    const db = setupTestDb();
    db.prepare("INSERT INTO users (id, name, email, role) VALUES (5, 'Multi Day User', 'm@test.com', 'user')").run();
    db.prepare("INSERT INTO employees (id, user_id, joining_date, status) VALUES (5, 5, '2026-01-01', 'active')").run();

    const result = evaluateLeaveAutoApproval(db, 5, {
      leave_type: 'casual',
      from_date: '2026-11-10',
      to_date: '2026-11-12',
      days: 3
    });

    assert.equal(result.status, 'rejected');
    assert.match(result.remarks, /Auto-rejected: 3 days exceeds the monthly paid leave allowance/i);
  });
});
