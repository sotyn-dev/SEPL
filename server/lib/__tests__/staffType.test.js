const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const Module = require('module');
const express = require('express');
const { ensureStaffTypeColumn, normalizeStaffType } = require('../staffType');
const { ensurePasswordChangeMetadata } = require('../passwordChangeMetadata');
const bcrypt = require('bcryptjs');

test('existing explicit staff types survive the unspecified-user backfill', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,staff_type TEXT); INSERT INTO users VALUES(1,'blue_collar'),(2,'white_collar'),(3,NULL),(4,'')");
    ensureStaffTypeColumn(db);
    assert.deepEqual(db.prepare('SELECT staff_type FROM users ORDER BY id').all().map(r=>r.staff_type), ['blue_collar','white_collar','white_collar','white_collar']);
  } finally { db.close(); }
});

test('staff-type migration preserves existing users and is repeatable', () => {
  const db = new Database(':memory:');
  try {
    db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, role TEXT); INSERT INTO users VALUES (1,'Existing','admin')");
    ensureStaffTypeColumn(db);
    assert.deepEqual(db.prepare('SELECT * FROM users').get(), { id: 1, name: 'Existing', role: 'admin', staff_type: 'white_collar' });
    db.prepare('UPDATE users SET staff_type=?').run('blue_collar');
    ensureStaffTypeColumn(db);
    assert.equal(db.prepare('SELECT staff_type FROM users').get().staff_type, 'blue_collar');
    db.prepare('UPDATE users SET staff_type=NULL').run();
    ensureStaffTypeColumn(db);
    assert.equal(db.prepare('SELECT staff_type FROM users').get().staff_type, null);
    assert.throws(() => db.prepare('UPDATE users SET staff_type=?').run('admin'));
    for (const value of [undefined, null, '']) assert.equal(normalizeStaffType(value), null);
    for (const value of ['admin', 'constructor', {}, [], 7]) assert.throws(() => normalizeStaffType(value));
  } finally { db.close(); }
});

test('admin can create, change and clear staff type; omitted type and permissions are preserved', async () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT UNIQUE NOT NULL,username TEXT,password TEXT,role TEXT,department TEXT,phone TEXT,active INTEGER DEFAULT 1,archived INTEGER DEFAULT 0,must_change_password INTEGER DEFAULT 0,token_revoked_at INTEGER,recovery_code_hash TEXT,approval_role TEXT,avatar_url TEXT);
    CREATE TABLE roles(id INTEGER PRIMARY KEY,name TEXT);
    CREATE TABLE user_roles(user_id INTEGER,role_id INTEGER);
    CREATE TABLE role_permissions(role_id INTEGER,module TEXT,can_view INTEGER,can_create INTEGER,can_edit INTEGER,can_delete INTEGER,can_approve INTEGER,can_see_all INTEGER);
    CREATE TABLE user_totp(user_id INTEGER,required INTEGER,enabled INTEGER,secret TEXT);
    INSERT INTO users(id,name,email,role) VALUES(1,'Admin','admin@example.test','admin');
    INSERT INTO roles VALUES(5,'Test role');`);
  ensureStaffTypeColumn(db);
  ensurePasswordChangeMetadata(db);
  const original = Module._load;
  Module._load = function(name, parent, ...rest) {
    if (parent && /(?:middleware|routes)[\\/]auth\.js$/.test(parent.filename) && name === '../db/schema') return { getDb: () => db };
    if (name === '../middleware/audit') return { logAuditEvent() {} };
    if (name === '../lib/destructiveBreaker') return { guardCheck: () => null };
    return original.call(this, name, parent, ...rest);
  };
  let auth, router;
  try { auth = require('../../middleware/auth'); router = require('../../routes/auth'); }
  finally { Module._load = original; }
  const app = express(); app.use(express.json()); app.use('/auth', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  let token = auth.generateToken(db.prepare('SELECT * FROM users WHERE id=1').get());
  const call = async (method, path, body) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/auth${path}`, { method,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  };
  try {
    const form = { name: 'Employee', email: 'employee@example.test', password: 'Test-only-password!', role: 'user', active: true, department: 'Operations', phone: '', role_ids: [5], staff_type: 'blue_collar' };
    const created = await call('POST', '/register', form);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.user.id;
    assert.equal(created.data.user.staff_type, 'blue_collar');
    const before = db.prepare('SELECT * FROM users WHERE id=?').get(id);
    assert.equal((await call('PUT', `/users/${id}`, { ...form, name: 'Should not save', staff_type: 'bad' })).status, 400);
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(id), before);
    const edit = { ...form }; delete edit.password; delete edit.role_ids;
    assert.equal((await call('PUT', `/users/${id}`, { ...edit, staff_type: 'white_collar' })).status, 200);
    assert.equal(db.prepare('SELECT staff_type FROM users WHERE id=?').get(id).staff_type, 'white_collar');
    delete edit.staff_type;
    assert.equal((await call('PUT', `/users/${id}`, edit)).status, 200);
    assert.equal(db.prepare('SELECT staff_type FROM users WHERE id=?').get(id).staff_type, 'white_collar');
    assert.deepEqual(db.prepare('SELECT * FROM user_roles WHERE user_id=?').all(id), [{ user_id: id, role_id: 5 }]);
    assert.equal(db.prepare('SELECT role FROM users WHERE id=?').get(id).role, 'user');
    assert.equal((await call('PUT', `/users/${id}`, { ...edit, staff_type: '' })).status, 200);
    assert.equal(db.prepare('SELECT staff_type FROM users WHERE id=?').get(id).staff_type, null);
    token = auth.generateToken(db.prepare('SELECT * FROM users WHERE id=?').get(id));
    assert.equal((await call('PUT', `/users/${id}`, { ...edit, staff_type: 'blue_collar' })).status, 403);
    assert.equal((await call('POST', '/register', { ...form, email: 'forbidden@example.test' })).status, 403);
    assert.equal((await call('POST', '/change-password', { current_password: 'wrong', new_password: 'New-test-password!' })).status, 401);
    assert.equal(db.prepare('SELECT password_changed_at FROM users WHERE id=?').get(id).password_changed_at, null);
    assert.equal((await call('POST', '/change-password', { current_password: form.password, new_password: 'New-test-password!' })).status, 200);
    const changed = db.prepare('SELECT password,password_changed_at FROM users WHERE id=?').get(id);
    assert.ok(changed.password_changed_at);
    assert.notEqual(changed.password, 'New-test-password!');
    assert.ok(bcrypt.compareSync('New-test-password!', changed.password));
  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
