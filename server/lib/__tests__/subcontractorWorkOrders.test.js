const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initialize, recordWorkOrder, countWorkOrders } = require('../subcontractorWorkOrders');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE sub_contractors(id INTEGER PRIMARY KEY,work_order_file TEXT,created_by INTEGER);
    CREATE TABLE audit_log(id INTEGER PRIMARY KEY,entity_type TEXT,entity_id TEXT,method TEXT,status_code INTEGER,at TEXT,user_id INTEGER,body_summary TEXT);
    CREATE TABLE score_kpis(id INTEGER PRIMARY KEY,metric_name TEXT,data_source TEXT,default_planned REAL);
    CREATE TABLE score_user_kpi_target(user_id INTEGER,kpi_id INTEGER,planned_value REAL);
    INSERT INTO score_kpis VALUES(1,'Work Order','auto:raci_step:subcon_hiring:12',0),(2,'Another KPI','auto:raci_step:subcon_hiring:12',8);
    INSERT INTO score_user_kpi_target VALUES(29,1,0),(30,1,5);`);
  return db;
}

test('backfill counts first saved uploads, not later edits or subcontractor creation', () => {
  const db = fixture();
  db.prepare('INSERT INTO sub_contractors VALUES(1,?,29)').run('/uploads/new.pdf');
  const audit = db.prepare("INSERT INTO audit_log(entity_type,entity_id,method,status_code,at,user_id,body_summary) VALUES('sub-contractors',?,'PUT',?,?,29,?)");
  for (const [id, status, at, file] of [
    [1,200,'2026-09-19 08:00:00','/uploads/old.pdf'],
    [1,200,'2026-09-21 08:00:00','/uploads/old.pdf'],
    [1,200,'2026-09-22 08:00:00','/uploads/new.pdf'],
    [1,400,'2026-09-23 08:00:00','/uploads/failed.pdf'],
  ]) audit.run(id,status,at,JSON.stringify({ work_order_file:file }));
  initialize(db);
  assert.equal(countWorkOrders(db,'2026-09-14','2026-09-19'),1);
  assert.equal(countWorkOrders(db,'2026-09-21','2026-09-26'),1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM subcontractor_work_order_uploads').get().n,2);
  assert.equal(db.prepare('SELECT data_source FROM score_kpis WHERE id=1').get().data_source,'auto:subcontractor_work_orders');
  assert.equal(db.prepare('SELECT default_planned FROM score_kpis WHERE id=1').get().default_planned,2);
  assert.equal(db.prepare('SELECT planned_value FROM score_user_kpi_target WHERE user_id=29').get().planned_value,2);
  assert.equal(db.prepare('SELECT planned_value FROM score_user_kpi_target WHERE user_id=30').get().planned_value,5);
  assert.equal(db.prepare('SELECT default_planned FROM score_kpis WHERE id=2').get().default_planned,8);
  initialize(db);
  assert.equal(countWorkOrders(db,'2026-09-21','2026-09-26'),1);
  db.close();
});

test('weekly upload dates use IST and every saved file counts only once', () => {
  const db = fixture(); initialize(db);
  recordWorkOrder(db,1,'/uploads/before.pdf',29,'2026-09-20 18:29:59');
  recordWorkOrder(db,1,'/uploads/monday.pdf',29,'2026-09-20 18:30:00');
  recordWorkOrder(db,2,'/uploads/saturday.pdf',1,'2026-09-26 18:29:59');
  recordWorkOrder(db,2,'/uploads/sunday.pdf',29,'2026-09-26 18:30:00');
  recordWorkOrder(db,1,' /uploads/monday.pdf ',29,'2026-09-28 10:00:00');
  recordWorkOrder(db,1,'',29,'2026-09-21 10:00:00');
  assert.equal(countWorkOrders(db,'2026-09-21','2026-09-26'),2);
  assert.equal(countWorkOrders(db,'2026-09-28','2026-10-03'),0);
  db.close();
});

test('legacy create audits use file ownership and timestamped uploads supply missing dates', () => {
  const db = fixture();
  db.prepare('INSERT INTO sub_contractors VALUES(1,?,29)').run('/uploads/create.pdf');
  db.prepare('INSERT INTO sub_contractors VALUES(2,?,29)').run(`/uploads/${Date.parse('2026-09-23T10:00:00Z')}-legacy.pdf`);
  db.prepare("INSERT INTO audit_log VALUES(1,'sub-contractors',NULL,'POST',201,'2026-09-22 10:00:00',29,?)")
    .run(JSON.stringify({ work_order_file:'/uploads/create.pdf' }));
  initialize(db);
  assert.equal(countWorkOrders(db,'2026-09-21','2026-09-26'),2);
  db.close();
});
