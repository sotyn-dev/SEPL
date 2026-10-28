const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  runSiteEngineerAttendanceMigrations,
  isSiteEngineer,
  evaluateSiteEngineerDpr,
  syncAttendanceWithDpr,
} = require('../../db/siteEngineerAttendanceSchema');

function setupTestDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      email TEXT,
      role TEXT,
      department TEXT
    );

    CREATE TABLE employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      name TEXT,
      designation TEXT,
      department TEXT,
      roster TEXT,
      is_field_employee INTEGER DEFAULT 0
    );

    CREATE TABLE sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      site_engineer_id INTEGER,
      site_engineer_ids TEXT,
      status TEXT DEFAULT 'active'
    );

    CREATE TABLE dpr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER,
      report_date TEXT,
      submitted_by INTEGER,
      grand_total_a REAL DEFAULT 0,
      grand_total_b REAL DEFAULT 0,
      profit_loss REAL DEFAULT 0,
      hindrances TEXT,
      hindrance_category TEXT,
      approval_status TEXT DEFAULT 'approved',
      is_planned_template INTEGER DEFAULT 0
    );

    CREATE TABLE attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date TEXT,
      punch_in_time TEXT,
      punch_out_time TEXT,
      original_punch_out TEXT,
      total_hours REAL DEFAULT 0,
      status TEXT DEFAULT 'present',
      ot_status TEXT,
      ot_rejection_reason TEXT,
      dpr_id INTEGER,
      dpr_profit_loss REAL,
      pm_approved_at TEXT,
      pm_approved_by INTEGER
    );
  `);
  runSiteEngineerAttendanceMigrations(db);
  return db;
}

test('isSiteEngineer identifies site engineers via site assignment, early roster, or field flag', () => {
  const db = setupTestDb();
  // User 1: Site Engineer assigned in sites
  db.prepare("INSERT INTO users (id, name, role, department) VALUES (1, 'Vikas', 'user', 'Site Operations')").run();
  db.prepare("INSERT INTO sites (id, name, site_engineer_id) VALUES (101, 'DLF Site', 1)").run();

  // User 2: Early roster employee (9:00 AM - 6:00 PM)
  db.prepare("INSERT INTO users (id, name, role, department) VALUES (2, 'Sunil', 'user', 'Operations')").run();
  db.prepare("INSERT INTO employees (user_id, name, roster) VALUES (2, 'Sunil', 'early')").run();

  // User 3: Office Sales Head (general roster 9:30 AM - 6:30 PM)
  db.prepare("INSERT INTO users (id, name, role, department) VALUES (3, 'Rajat', 'admin', 'Sales')").run();
  db.prepare("INSERT INTO employees (user_id, name, roster, department) VALUES (3, 'Rajat', 'general', 'Sales')").run();

  assert.equal(isSiteEngineer(db, 1), true, 'User 1 assigned to site must be site engineer');
  assert.equal(isSiteEngineer(db, 2), true, 'User 2 with early roster must be site engineer');
  assert.equal(isSiteEngineer(db, 3), false, 'User 3 in Sales head office must NOT be site engineer');
});

test('evaluateSiteEngineerDpr: Weekday under 10 hours does not require DPR', () => {
  const db = setupTestDb();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-27', false, 9);
  assert.equal(res.requiresDpr, false);
  assert.equal(res.ot_status, 'standard');
  assert.equal(res.shouldClampToShiftEnd, false);
});

test('evaluateSiteEngineerDpr: Weekday overtime (>10h) without DPR is clamped to 6:00 PM shift end (TK-01466)', () => {
  const db = setupTestDb();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-27', false, 11.5);
  assert.equal(res.requiresDpr, true);
  assert.equal(res.ot_status, 'clamped_no_dpr');
  assert.equal(res.shouldClampToShiftEnd, true);
  assert.match(res.ot_rejection_reason, /6:00 PM/);
});

test('evaluateSiteEngineerDpr: Weekday overtime (>10h) with profitable DPR is auto-approved', () => {
  const db = setupTestDb();
  db.prepare("INSERT INTO dpr (id, site_id, report_date, submitted_by, grand_total_a, grand_total_b, profit_loss) VALUES (1, 101, '2026-10-27', 1, 15000, 10000, 5000)").run();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-27', false, 11.5);
  assert.equal(res.requiresDpr, true);
  assert.equal(res.ot_status, 'approved');
  assert.equal(res.dpr_id, 1);
  assert.equal(res.dpr_profit_loss, 5000);
  assert.equal(res.shouldClampToShiftEnd, false);
});

test('evaluateSiteEngineerDpr: Overtime with loss DPR but legitimate hindrance enters Pending PM Exception', () => {
  const db = setupTestDb();
  db.prepare("INSERT INTO dpr (id, site_id, report_date, submitted_by, grand_total_a, grand_total_b, profit_loss, hindrance_category, hindrances) VALUES (2, 101, '2026-10-27', 1, 0, 4000, -4000, 'Material', 'Unloading of 10T pipes')").run();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-27', false, 11.5);
  assert.equal(res.requiresDpr, true);
  assert.equal(res.ot_status, 'pending_pm');
  assert.equal(res.shouldClampToShiftEnd, false);
  assert.match(res.ot_rejection_reason, /Pending PM Approval/);
});

test('evaluateSiteEngineerDpr: Sunday work without DPR disallows double attendance (TSK-1020)', () => {
  const db = setupTestDb();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-25', true, 8);
  assert.equal(res.requiresDpr, true);
  assert.equal(res.ot_status, 'rejected_no_dpr');
  assert.match(res.ot_rejection_reason, /Sunday double attendance disallowed/);
});

test('evaluateSiteEngineerDpr: Sunday work with profitable DPR approves Sunday double attendance', () => {
  const db = setupTestDb();
  db.prepare("INSERT INTO dpr (id, site_id, report_date, submitted_by, grand_total_a, grand_total_b, profit_loss) VALUES (3, 101, '2026-10-25', 1, 20000, 12000, 8000)").run();
  const res = evaluateSiteEngineerDpr(db, 1, '2026-10-25', true, 8);
  assert.equal(res.requiresDpr, true);
  assert.equal(res.ot_status, 'approved');
  assert.equal(res.dpr_profit_loss, 8000);
});

test('syncAttendanceWithDpr automatically updates clamped attendance when profitable DPR is submitted later', () => {
  const db = setupTestDb();
  db.prepare("INSERT INTO users (id, name) VALUES (1, 'Site Eng')").run();
  db.prepare("INSERT INTO sites (id, name, site_engineer_id) VALUES (101, 'Site A', 1)").run();
  // Site engineer punched in at 9:00 AM, punched out at 8:00 PM without DPR -> clamped to 6:00 PM
  db.prepare(`
    INSERT INTO attendance (id, user_id, date, punch_in_time, punch_out_time, original_punch_out, total_hours, ot_status, ot_rejection_reason)
    VALUES (10, 1, '2026-10-27', '2026-10-27T03:30:00.000Z', '2026-10-27T12:30:00.000Z', '2026-10-27T14:30:00.000Z', 9, 'clamped_no_dpr', 'Clamped to 6:00 PM')
  `).run();

  // Now DPR is submitted with profit
  db.prepare("INSERT INTO dpr (id, site_id, report_date, submitted_by, grand_total_a, grand_total_b, profit_loss) VALUES (5, 101, '2026-10-27', 1, 30000, 15000, 15000)").run();
  syncAttendanceWithDpr(db, 5);

  const updated = db.prepare('SELECT * FROM attendance WHERE id = 10').get();
  assert.equal(updated.ot_status, 'approved');
  assert.equal(updated.dpr_id, 5);
  assert.equal(updated.dpr_profit_loss, 15000);
  assert.equal(updated.total_hours, 11);
  assert.equal(updated.punch_out_time, '2026-10-27T14:30:00.000Z');
});
