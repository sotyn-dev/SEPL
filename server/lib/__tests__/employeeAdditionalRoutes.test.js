const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const Database = require('better-sqlite3');
const express = require('express');
const { FIELDS, SALARY_FIELDS } = require('../employeeTerms');
const pt = require('../employeeProfessionalTax');

test('real HR routes persist fields, redact salary and atomically assign vehicles', async () => {
  const db = new Database(':memory:');
  const core = ['user_id','name','phone','email','designation','department','join_date','salary','aadhar_file','pan_file','qualification_file','roster','date_of_birth','gender','guardian_title','guardian_relation','guardian_name','pan_number','aadhaar_last4','bank_name','bank_branch','bank_account_no','bank_ifsc','emergency_contact_name','emergency_contact_phone'];
  db.exec(`CREATE TABLE employees (id INTEGER PRIMARY KEY, status TEXT DEFAULT 'active', ${[...core,...FIELDS].map(f => `${f} ${['user_id','reports_to'].includes(f) ? 'INTEGER' : ['grade_band','salary_review_cycle'].includes(f) ? 'TEXT' : (f === 'salary' || SALARY_FIELDS.includes(f)) && f !== 'last_increment_date' ? 'REAL' : 'TEXT'}`).join(',')});
    CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT,email TEXT,username TEXT,active INTEGER,archived INTEGER,password TEXT,role TEXT,department TEXT,phone TEXT,must_change_password INTEGER DEFAULT 0);
    INSERT INTO users(id,name,email,username,active,archived) VALUES(7,'Test','test@example.test','test.user',1,0),(8,'Other','other@example.test','other.user',1,0);
    CREATE TABLE score_templates (id INTEGER PRIMARY KEY,name TEXT,active INTEGER); INSERT INTO score_templates VALUES(1,'Engineer',1);
    CREATE TABLE score_user_template (user_id INTEGER,template_id INTEGER); INSERT INTO score_user_template VALUES(7,1);
    CREATE TABLE company_assets (id INTEGER PRIMARY KEY,asset_no TEXT,name TEXT,category TEXT,status TEXT,current_user_id INTEGER,current_user_name TEXT,issued_at TEXT,returned_at TEXT);
    INSERT INTO company_assets (id,asset_no,name,category,status,current_user_id) VALUES(1,'AST-1','Car','Vehicle','available',NULL),(2,'AST-2','Other car','Vehicle','issued',8);
    CREATE TABLE company_asset_movements (id INTEGER PRIMARY KEY,asset_id INTEGER,movement_type TEXT,from_user_id INTEGER,to_user_id INTEGER,notes TEXT,performed_by INTEGER);`);
  pt.initialize(db); pt.initialize(db);
  const permissions = id => ({ employee_salary: { can_view: id === 1 }, company_assets: { can_edit: id === 1 } });
  const originalLoad = Module._load;
  Module._load = function(name, parent, ...rest) {
    if (parent?.filename.endsWith('routes\\hr.js') || parent?.filename.endsWith('routes/hr.js')) {
      if (name === '../db/schema') return { getDb: () => db };
      if (name === '../middleware/auth') return {
        authMiddleware: (req, res, next) => { req.user = { id: Number(req.headers['x-actor'] || 1), role: req.headers['x-actor'] === '2' ? 'user' : 'admin' }; next(); },
        requirePermission: module => (req, res, next) => module === 'employee_salary' && req.user.id !== 1 ? res.sendStatus(403) : next(),
        getUserPermissions: permissions,
        adminOnly: (req, res, next) => req.user.role === 'admin' ? next() : res.sendStatus(403),
      };
      if (name === '../middleware/audit') return { logAuditEvent() {} };
      if (name === '../utils/resumeParser') return { parseResume() {} };
    }
    return originalLoad.call(this, name, parent, ...rest);
  };
  let router;
  try { router = require('../../routes/hr'); } finally { Module._load = originalLoad; }
  const app = express(); app.use(express.json()); app.use('/hr', router);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const call = async (method, path, body, actor = 1) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/hr${path}`, { method, headers: { 'Content-Type': 'application/json', 'x-actor': String(actor) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = text; }
    return { status: r.status, data };
  };
  try {
    const body = { name: 'Test', phone: '9999999999', email: 'test@example.test', designation: 'Engineer', department: 'Operations', join_date: '2026-09-01', salary: 44000, status: 'active', user_id: 7,
      aadhar_file: '/uploads/a.pdf', pan_file: '/uploads/p.pdf', qualification_file: '/uploads/q.pdf', grade_band: 'L3', special_allowance: 1500, reimbursement_lta_annual: 12000, reimbursement_medical_annual: 6000, reimbursement_phone_annual: 2400, bonus_target_pct: 10, salary_review_cycle: 'joining_anniversary', vehicle_asset_id: 1 };
    const created = await call('POST', '/employees', body);
    assert.equal(created.status, 201, JSON.stringify(created.data));
    const id = created.data.id;
    let row = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    assert.equal(row.special_allowance, 1500); assert.equal(row.grade_band, 'L3'); assert.equal(row.salary, 44000); assert.equal(row.ctc_annual, 528000);
    assert.equal(db.prepare('SELECT current_user_id FROM company_assets WHERE id=1').get().current_user_id, 7);
    let updated = await call('PUT', `/employees/${id}`, { ...body, grade_band: 'L4', reimbursement_phone_annual: null });
    assert.equal(updated.status, 200, JSON.stringify(updated.data));
    row = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    assert.equal(row.grade_band, 'L4'); assert.equal(row.reimbursement_phone_annual, null);
    const conflict = await call('PUT', `/employees/${id}`, { ...body, grade_band: 'L5', vehicle_asset_id: 2 });
    assert.equal(conflict.status, 400); assert.equal(db.prepare('SELECT grade_band FROM employees WHERE id=?').get(id).grade_band, 'L4');
    const changedUser = await call('PUT', `/employees/${id}`, { ...body, user_id: 8, bonus_target_pct: null });
    assert.equal(changedUser.status, 400);
    const publicRow = (await call('GET', '/employees', null, 2)).data[0];
    for (const field of SALARY_FIELDS) assert.equal(field in publicRow, false, field);
    const forbidden = await call('PUT', `/employees/${id}`, { ...body, special_allowance: 9999, vehicle_asset_id: undefined }, 2);
    assert.equal(forbidden.status, 400, JSON.stringify(forbidden.data));
    assert.equal(db.prepare('SELECT special_allowance FROM employees WHERE id=?').get(id).special_allowance, 1500);
    assert.equal((await call('GET', '/professional-tax-preview?state=Punjab&salary=44000&month=2026-09', null, 2)).status, 403);
    const rule = { state: 'Punjab', min_salary: 0, max_salary: null, amount: 123, month: 0, effective_from: '2026-01' };
    assert.equal((await call('PUT', '/professional-tax-rules', { rules: [rule] }, 2)).status, 403);
    assert.equal((await call('PUT', '/professional-tax-rules', { rules: [rule] })).status, 200);
    assert.equal((await call('GET', '/professional-tax-preview?state=Punjab&salary=44000&month=2026-09')).data.amount, 123);
    assert.equal((await call('PUT', '/professional-tax-rules', { rules: [rule, rule] })).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM employee_pt_rules').get().n, 1);
    assert.equal((await call('PUT', `/employees/${id}`, { ...body, vehicle_asset_id: null })).status, 200);
    assert.equal(db.prepare('SELECT status FROM company_assets WHERE id=1').get().status, 'available');
    const before = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    assert.equal((await call('PUT', `/employees/${id}`, { grade_band: 'L6' })).status, 200);
    const after = db.prepare('SELECT * FROM employees WHERE id=?').get(id);
    for (const key of ['name','phone','email','salary','user_id','status','join_date','pan_file']) assert.equal(after[key], before[key], key + ' preserved on partial save');
    assert.equal((await call('PUT', `/employees/${id}`, { pan_file: null })).status, 200);
    assert.equal(db.prepare('SELECT pan_file FROM employees WHERE id=?').get(id).pan_file, null);
    assert.equal((await call('PUT', `/employees/${id}`, { salary: 45000, ctc_annual: 1 })).status, 200);
    assert.equal(db.prepare('SELECT ctc_annual FROM employees WHERE id=?').get(id).ctc_annual, 540000);
    const quick = { name: 'New employee', email: 'new@example.test', designation: 'Engineer', department: 'Operations', join_date: '2026-09-16', employment_type: 'permanent', reports_to: id, quick_onboarding: true };
    const lightweight = await call('POST', '/employees', quick);
    assert.equal(lightweight.status, 201, JSON.stringify(lightweight.data));
    assert.equal(lightweight.data.employee.aadhar_file, null);
    assert.ok(lightweight.data.employee.user_id);
    assert.equal(lightweight.data.login_details.username, 'new.employee');
    assert.equal(lightweight.data.login_details.initial_password, '123456');
    assert.equal(created.data.login_details.created, false);
    assert.equal(created.data.login_details.initial_password, undefined);
    assert.equal(lightweight.data.employee.profile_completion.sections.assets.total, 0);
    assert.equal(lightweight.data.employee.profile_completion.sections.statutory.total, 0);
    assert.equal((await call('POST', '/employees', { ...quick, reports_to: null })).status, 400);
    assert.equal((await call('POST', '/employees', { ...quick, quick_onboarding: false })).status, 400);
    for (const key of ['pan_number','bank_account_no','uan_number','aadhar_file']) assert.equal(key in publicRow, false, key + ' private');

  } finally { await new Promise(resolve => server.close(resolve)); db.close(); }
});
