const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const pt = require('../employeeProfessionalTax');
const { employeeTerms } = require('../employeeTerms');
const { assignVehicle } = require('../employeeVehicle');

const base = { state: 'Punjab', min_salary: 0, max_salary: null, amount: 100, month: 0, effective_from: '2026-04', effective_to: null };
test('PT slab boundaries, effective dates and month overrides', () => {
  const rules = pt.validateRules([{ ...base, max_salary: 20000, amount: 0 },
    { ...base, min_salary: 20000 }, { ...base, min_salary: 20000, month: 2, amount: 200 }], ['Punjab']);
  assert.equal(pt.calculate(rules, 'Punjab', 19999.99, '2026-09').amount, 0);
  assert.equal(pt.calculate(rules, 'Punjab', 20000, '2026-09').amount, 100);
  assert.equal(pt.calculate(rules, 'Punjab', 20000, '2027-02').amount, 200);
  assert.equal(pt.calculate(rules, 'Punjab', 20000, '2026-03').amount, null);
  assert.equal(pt.calculate(rules, 'Other state', 20000, '2026-09').amount, null);
  assert.equal(pt.calculate(rules, 'Not applicable', null, '2026-09').amount, 0);
  assert.equal(pt.calculate(rules, 'Punjab', '', '2026-09').amount, null);
  assert.throws(() => pt.calculate(rules, 'Punjab', 20000, '2026-13'));
});
test('PT rules reject ambiguous overlaps, invalid ranges and invalid amounts', () => {
  assert.throws(() => pt.validateRules([base, base], ['Punjab']), /Overlapping/);
  assert.throws(() => pt.validateRules([{ ...base, max_salary: 0 }], ['Punjab']));
  assert.throws(() => pt.validateRules([{ ...base, amount: -1 }], ['Punjab']));
  assert.throws(() => pt.validateRules([{ ...base, amount: '' }], ['Punjab']));
  assert.throws(() => pt.validateRules([{ ...base, state: 'Invalid' }], ['Punjab']));
  assert.equal(pt.validateRules([{ ...base, effective_to: '2026-09' }, { ...base, effective_from: '2026-10' }], ['Punjab']).length, 2);
});
test('employee enums, amounts and scorecard-linked bonus target', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE score_templates (id INTEGER,active INTEGER); CREATE TABLE score_user_template (user_id INTEGER,template_id INTEGER);
    INSERT INTO score_templates VALUES(1,1); INSERT INTO score_user_template VALUES(7,1);`);
  assert.equal(employeeTerms({ grade_band: 'L8', salary_review_cycle: 'apr_mar', special_allowance: 0, reimbursement_lta_annual: 12000, bonus_target_pct: 15, user_id: 7 }, db).bonus_target_pct, 15);
  for (const body of [{ grade_band: 'L9' }, { salary_review_cycle: 'other' }, { special_allowance: -1 }, { reimbursement_phone_annual: 'NaN' }, { bonus_target_pct: 101 }, { bonus_target_pct: 10, user_id: 8 }]) assert.throws(() => employeeTerms(body, db));
  assert.equal(employeeTerms({ reimbursement_lta_annual: '' }, db).reimbursement_lta_annual, null);
  db.close();
});
test('vehicle issue, replacement and clear use history and roll back on conflict', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY,name TEXT); INSERT INTO users VALUES(7,'Test'),(8,'Other');
    CREATE TABLE company_assets (id INTEGER PRIMARY KEY, category TEXT,status TEXT,current_user_id INTEGER,current_user_name TEXT,issued_at TEXT,returned_at TEXT);
    CREATE TABLE company_asset_movements (id INTEGER PRIMARY KEY,asset_id INTEGER,movement_type TEXT,from_user_id INTEGER,to_user_id INTEGER,notes TEXT,performed_by INTEGER);
    INSERT INTO company_assets (id,category,status,current_user_id) VALUES(1,'Vehicle','available',NULL),(2,'Vehicle','available',NULL),(3,'Vehicle','issued',8),(4,'Laptop','available',NULL);`);
  const set = (assetId, canEditAssets = true) => db.transaction(() => assignVehicle(db, { userId: 7, assetId, actorId: 1, canEditAssets }))();
  set(1); set(1, false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_asset_movements').get().n, 1);
  assert.throws(() => set(2, false), /permission/);
  assert.throws(() => set(3), /another user/);
  assert.throws(() => set(4), /unavailable/);
  assert.equal(db.prepare('SELECT current_user_id FROM company_assets WHERE id=1').get().current_user_id, 7);
  set(2); set(null);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM company_assets WHERE current_user_id=7").get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_asset_movements').get().n, 4);
  db.close();
});
const { assignEquipment } = require('../employeeVehicle');
test('multiple equipment types issue and return with permission and conflict protection', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE users(id INTEGER,name TEXT); INSERT INTO users VALUES(7,'Test');
    CREATE TABLE company_assets(id INTEGER,category TEXT,status TEXT,current_user_id INTEGER,current_user_name TEXT,issued_at TEXT,returned_at TEXT);
    CREATE TABLE company_asset_movements(asset_id INTEGER,movement_type TEXT,from_user_id INTEGER,to_user_id INTEGER,notes TEXT,performed_by INTEGER);
    INSERT INTO company_assets(id,category,status,current_user_id) VALUES(1,'Laptop','available',NULL),(2,'Mobile','available',NULL),(3,'SIM Card','issued',8),(4,'Vehicle','available',NULL);`);
  const set = (assetIds, canEditAssets=true) => db.transaction(() => assignEquipment(db,{userId:7,assetIds,actorId:1,canEditAssets}))();
  set([1,2]); set([1,2],false);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_asset_movements').get().n,2);
  assert.throws(()=>set([1],false),/permission/);
  assert.throws(()=>set([1,3]),/unavailable/);
  assert.throws(()=>set([4]),/unavailable/);
  assert.throws(()=>set([1,1]),/valid/);
  assert.equal(db.prepare('SELECT current_user_id FROM company_assets WHERE id=2').get().current_user_id,7);
  set([2]);set([]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM company_asset_movements').get().n,4);
  db.close();
});

test('annual CTC derives from salary and ignores supplied CTC', () => {
  assert.equal(employeeTerms({ salary: 44000, ctc_annual: 1 }, null).ctc_annual, 528000);
  assert.equal(employeeTerms({ salary: 12345.67 }, null).ctc_annual, 148148.04);
  assert.equal(employeeTerms({ salary: 0 }, null).ctc_annual, 0);
  assert.equal(employeeTerms({ salary: '' }, null).ctc_annual, null);
  assert.equal('ctc_annual' in employeeTerms({ ctc_annual: 999 }, null), false);
  assert.throws(() => employeeTerms({ salary: -1 }, null));
});
