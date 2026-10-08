const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const { initializeComplianceSchema } = require('../../db/complianceSchema');
const { validCoordinates } = require('../locationAvailability');

// No production DB, sockets, or notifications are used by these regressions.
let currentDb;
const delivered = [];
require.cache[require.resolve('../../db/schema')] = { exports: { getDb: () => {
  assert(currentDb, 'test database required'); return currentDb;
} } };
require.cache[require.resolve('../chatSocket')] = { exports: { getIO: () => ({
  to: room => ({ emit: (event, payload) => delivered.push({ room, event, payload }) }),
}) } };
const { handleGpsOffEvent, handleGpsRestoredEvent } = require('../../services/complianceService');
const { runComplianceScan } = require('../../scripts/complianceCron');
const MINUTE = 60000;
const BASE = Date.parse('2026-10-08T04:00:00.000Z');

function fixture(t, base = BASE) {
  const db = new Database(':memory:'); currentDb = db; delivered.length = 0;
  const source = fs.readFileSync(path.join(__dirname, '../../db/schema.js'), 'utf8');
  for (const table of ['users', 'roles', 'role_permissions', 'user_roles', 'employees',
    'notifications', 'attendance', 'location_tracking']) {
    const ddl = source.match(new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\([\\s\\S]*?\\n\\s*\\);`))?.[0];
    assert(ddl, `real ${table} schema found`); db.exec(ddl);
  }
  db.exec(`ALTER TABLE users ADD COLUMN username TEXT;
    ALTER TABLE attendance ADD COLUMN admin_marked INTEGER DEFAULT 0;
    CREATE TABLE sites(id INTEGER PRIMARY KEY);
    CREATE INDEX idx_location_test ON location_tracking(user_id, time);
    CREATE TABLE delegations(id INTEGER, title TEXT, assigned_to INTEGER, deadline TEXT, status TEXT);
    CREATE TABLE pms_tasks(id INTEGER, title TEXT, user_id INTEGER, due_date TEXT, status TEXT);
    INSERT INTO users(id,name,email,password,role) VALUES
      (1,'Employee One','one@example.invalid','test','user'),
      (2,'Nancy','nancy@securedengineers.com','test','user'),
      (3,'Unrelated Admin','admin@example.invalid','test','admin'),
      (4,'Rahul','rahul@securedengineers.com','test','user');`);
  initializeComplianceSchema(db);
  t.mock.timers.enable({ apis: ['Date'], now: base });
  t.after(() => { db.close(); currentDb = null; });
  const today = () => new Date(Date.now() + 5.5 * 3600000).toISOString().slice(0, 10);
  db.prepare(`INSERT INTO attendance(user_id,date,punch_in_time,status) VALUES(1,?,?,'present')`)
    .run(today(), new Date(base - MINUTE).toISOString());
  const at = ms => t.mock.timers.setTime(base + ms);
  const record = (good, reason = 'permission-denied', userId = 1) => {
    db.prepare(`INSERT INTO location_tracking(user_id,date,time,latitude,longitude,address,site_name)
      VALUES(?,?,?,?,?,?,?)`).run(userId, today(), new Date().toISOString(), good ? 28.6 : null,
        good ? 77.2 : null, good ? '' : reason, good ? 'Office' : 'GPS_OFF');
  };
  const off = (reason = 'permission-denied', userId = 1) => {
    record(false, reason, userId);
    return handleGpsOffEvent({ userId, employeeName: 'Employee One', dbInstance: db });
  };
  const on = (siteName = 'Office') => {
    record(true);
    return handleGpsRestoredEvent({ userId: 1, latitude: 28.6, longitude: 77.2, siteName, dbInstance: db });
  };
  const cases = () => db.prepare('SELECT * FROM compliance_cases ORDER BY id').all();
  const notifications = () => db.prepare('SELECT * FROM notifications ORDER BY id').all();
  const sustained = () => { off(); at(5 * MINUTE); return off(); };
  return { db, at, record, off, on, cases, notifications, sustained };
}

test('temporary browser errors and recovery create no cases or notifications', t => {
  const f = fixture(t);
  f.off('timeout'); f.at(5 * MINUTE - 1); f.off('position-unavailable');
  assert.equal(f.cases().length, 0); f.on();
  f.at(6 * MINUTE); f.off();
  assert.equal(f.cases().length, 0); assert.equal(f.notifications().length, 0);
});

test('five-minute loss sends accurate alerts only to employee and monitor', t => {
  const f = fixture(t); f.sustained();
  assert.equal(f.cases().length, 1);
  assert.equal(f.cases()[0].violation_type, 'location_unavailable');
  assert.match(f.cases()[0].description, /Browser location permission is denied/);
  assert.doesNotMatch(f.cases()[0].description, /Employee reported GPS turned off/);
  assert.deepEqual(f.notifications().map(n => n.user_id), [1, 2]);
  assert.deepEqual(delivered.map(n => n.room).sort(), ['u:1', 'u:2']);
  assert(delivered.every(n => n.event === 'notification:new'));
});

test('healthy phone takes precedence over failed laptop/tab for repeated cycles', t => {
  const f = fixture(t);
  for (let minute = 0; minute <= 40; minute++) {
    f.at(minute * MINUTE); f.on(); f.at(minute * MINUTE + 1000); f.off();
    assert.equal(runComplianceScan(f.db).newCasesCreated, 0);
  }
  assert.equal(f.cases().length, 0); assert.equal(f.notifications().length, 0);
});

test('another employee location cannot suppress this employee interruption', t => {
  const f = fixture(t); f.off(); f.at(5 * MINUTE); f.record(true, '', 3); f.off();
  assert.equal(f.cases().length, 1);
});

test('grace history survives module reload; no in-memory timer is required', t => {
  const f = fixture(t); f.off(); f.at(5 * MINUTE);
  delete require.cache[require.resolve('../../services/complianceService')];
  require('../../services/complianceService').handleGpsOffEvent({ userId: 1, employeeName: 'Employee One', dbInstance: f.db });
  assert.equal(f.cases().length, 1);
});

for (const status of ['open', 'in_progress', 'pending_employee']) {
  test(`${status} case prevents duplicates from both live pings and cron`, t => {
    const f = fixture(t); f.sustained();
    f.db.prepare('UPDATE compliance_cases SET status=?').run(status);
    f.at(6 * MINUTE); f.off(); runComplianceScan(f.db);
    assert.equal(f.cases().length, 1); assert.equal(f.notifications().length, 2);
  });
}

test('employee reminders every 15 minutes and monitor reminders every 30 minutes', t => {
  const f = fixture(t); f.sustained();
  f.at(20 * MINUTE - 1); f.off(); assert.equal(f.notifications().length, 2);
  f.at(20 * MINUTE); f.off(); assert.equal(f.notifications().length, 3);
  assert.equal(f.notifications()[2].user_id, 1);
  f.at(35 * MINUTE); f.off('timeout'); assert.equal(f.notifications().length, 5);
  assert.deepEqual(f.notifications().slice(3).map(n => n.user_id), [1, 2]);
  assert.match(f.notifications()[4].body, /timed out/);
  f.off(); runComplianceScan(f.db); assert.equal(f.notifications().length, 5);
});

test('recovery needs one minute, closes pending alerts and sends one confirmation each', t => {
  const f = fixture(t); f.sustained();
  f.at(6 * MINUTE); f.on(); assert.equal(f.cases()[0].status, 'open');
  f.at(6 * MINUTE + 30000); f.off(); f.on();
  f.at(7 * MINUTE); f.on('Outside');
  assert.equal(f.cases()[0].status, 'resolved');
  assert(f.notifications().slice(0, 2).every(n => n.status === 'closed' && n.is_pending === 0));
  assert.equal(f.notifications().length, 4);
  assert(f.notifications().slice(2).every(n => !n.body.includes('verified')));
  assert.deepEqual(delivered.map(n => n.room).sort(), ['u:1', 'u:1', 'u:2', 'u:2']);
  f.on(); f.off(); assert.equal(f.notifications().length, 4);
  for (let minute = 8; minute < 15; minute++) { f.at(minute * MINUTE); f.on(); f.off(); }
  assert.equal(f.cases().length, 1);
});

test('isolated recovery ping cannot close a case after another gap', t => {
  const f = fixture(t); f.sustained(); f.at(6 * MINUTE); f.on();
  f.at(8 * MINUTE); f.on(); assert.equal(f.cases()[0].status, 'open');
  f.at(9 * MINUTE); f.on(); assert.equal(f.cases()[0].status, 'resolved');
});

test('new sustained loss after confirmed recovery creates one new case', t => {
  const f = fixture(t); f.sustained(); f.at(6 * MINUTE); f.on(); f.at(7 * MINUTE); f.on();
  f.at(8 * MINUTE); f.off(); f.at(13 * MINUTE); f.off();
  assert.equal(f.cases().length, 2); assert.equal(f.cases()[1].status, 'open');
});

for (const mode of ['not-punched', 'punched-out', 'md-exempt']) {
  test(`${mode} gets no new location compliance case`, t => {
    const f = fixture(t);
    if (mode === 'not-punched') f.db.exec('DELETE FROM attendance');
    if (mode === 'punched-out') f.db.prepare('UPDATE attendance SET punch_out_time=?').run(new Date().toISOString());
    if (mode === 'md-exempt') f.db.exec("UPDATE users SET email='director@securedengineers.com' WHERE id=1");
    f.sustained(); runComplianceScan(f.db);
    assert.equal(f.cases().length, 0);
  });
}

test('no reports allows 30 minutes from punch-in, even across UTC/IST date boundary', t => {
  const f = fixture(t, Date.parse('2026-10-07T18:45:00.000Z'));
  f.at(29 * MINUTE - 1); assert.equal(runComplianceScan(f.db).newCasesCreated, 0);
  f.at(29 * MINUTE); assert.equal(runComplianceScan(f.db).newCasesCreated, 1);
  assert.match(f.cases()[0].description, /No recent location reading or browser heartbeat/);
  assert.equal(runComplianceScan(f.db).newCasesCreated, 0);
});

test('cron applies error grace with the actual schema (no gps_off column)', t => {
  const f = fixture(t); f.off('no-geolocation-api');
  f.at(4 * MINUTE); assert.equal(runComplianceScan(f.db).newCasesCreated, 0);
  f.at(5 * MINUTE); assert.equal(runComplianceScan(f.db).newCasesCreated, 1);
  assert.match(f.cases()[0].description, /does not support location sharing/);
});

test('stale successful reading does not trigger until 30 minutes without reports', t => {
  const f = fixture(t); f.on();
  f.at(30 * MINUTE - 1); assert.equal(runComplianceScan(f.db).newCasesCreated, 0);
  f.at(30 * MINUTE); assert.equal(runComplianceScan(f.db).newCasesCreated, 1);
});

test('pre-punch failures do not consume the current shift grace period', t => {
  const f = fixture(t); f.off(); f.at(10 * MINUTE);
  f.db.prepare('UPDATE attendance SET punch_in_time=?').run(new Date().toISOString());
  f.off(); assert.equal(f.cases().length, 0);
  f.at(15 * MINUTE); f.off(); assert.equal(f.cases().length, 1);
});

test('invalid coordinates cannot clear a compliance case; zero coordinates are valid', t => {
  const f = fixture(t); f.sustained();
  for (const [latitude, longitude] of [[null, 77], ['28', 77], [NaN, 77], [91, 77], [28, 181]]) {
    assert.equal(validCoordinates(latitude, longitude), false);
    handleGpsRestoredEvent({ userId: 1, latitude, longitude, siteName: 'Office', dbInstance: f.db });
  }
  assert(!JSON.parse(f.cases()[0].metadata).recovery_started_at);
  assert(validCoordinates(0, 0)); assert.equal(f.notifications().length, 2);
});

test('track-location endpoint records errors through the grace policy and validates recovery input', async t => {
  const f = fixture(t);
  f.db.exec('CREATE TABLE geofence_settings(id INTEGER, active INTEGER)');
  require.cache[require.resolve('../../middleware/auth')] = { exports: {
    authMiddleware: (req, res, next) => { req.user = { id: 1, name: 'Employee One' }; next(); },
    requirePermission: () => (req, res, next) => next(),
  } };
  const express = require('express');
  const app = express(); app.use(express.json());
  app.use('/attendance', require('../../routes/attendance'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const post = async (body, expected = 200) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/attendance/track-location`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    assert.equal(res.status, expected); return res.json();
  };
  await post({ gps_off: true, reason: 'timeout' }); assert.equal(f.cases().length, 0);
  f.at(5 * MINUTE); await post({ gps_off: true, reason: 'timeout' });
  assert.equal(f.cases().length, 1);
  await post({ latitude: 123, longitude: 77 }, 400);
  assert(!JSON.parse(f.cases()[0].metadata).recovery_started_at);
  f.at(6 * MINUTE); await post({ latitude: 0, longitude: 0 });
  assert.equal(f.cases()[0].status, 'open');
  f.at(7 * MINUTE); await post({ latitude: 28.6, longitude: 77.2 });
  assert.equal(f.cases()[0].status, 'resolved');
});
