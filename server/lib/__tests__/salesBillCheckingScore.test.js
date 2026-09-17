const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { salesBillCheckingScore, migrateSalesBillCheckingScore } = require('../salesBillCheckingScore');
const { dprBillCheckingScore, migrateDprBillCheckingScore } = require('../salesBillCheckingScore');

test('DPR to RA Bill counts the bill-date cohort even when admin checks later', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sales_bills(id INTEGER PRIMARY KEY, bill_type INTEGER, bill_date TEXT, checked_at TEXT);
    INSERT INTO sales_bills VALUES(1,3,'2026-09-09','2026-09-17 10:00:00'),
    (2,3,'2026-09-09',NULL),(3,3,'2026-09-17',NULL),(4,2,'2026-09-09','2026-09-17 10:00:00');
    CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE score_kpis(id INTEGER PRIMARY KEY, metric_name TEXT, data_source TEXT, weightage REAL);
    INSERT INTO score_kpis VALUES(1,'DPR to RA Bill','auto:dpr_billed_pct',0);`);
  assert.deepEqual(dprBillCheckingScore(db,'2026-09-07','2026-09-12'),{given:2,done:1});
  assert.deepEqual(dprBillCheckingScore(db,'2026-09-14','2026-09-19'),{given:1,done:0});
  assert.deepEqual(dprBillCheckingScore(db,'2026-08-03','2026-08-08'),{given:0,done:0});
  migrateDprBillCheckingScore(db);
  migrateDprBillCheckingScore(db);
  assert.deepEqual(db.prepare('SELECT data_source,weightage FROM score_kpis').get(),{data_source:'auto:dpr_bill_checking',weightage:0});
  db.close();
});

test('checking score uses checker and IST check date, never creation or sending', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE sales_bills(id INTEGER PRIMARY KEY, bill_type INTEGER, checked_by INTEGER, checked_at TEXT, sent_to_client INTEGER);
    INSERT INTO sales_bills VALUES
    (1,3,7,'2026-09-13 19:00:00',0),
    (2,3,7,'2026-09-19 18:29:59',1),
    (3,3,7,'2026-09-13 18:29:59',0),
    (4,3,7,'2026-09-19 18:30:00',0),
    (5,3,8,'2026-09-15 12:00:00',1),
    (6,3,NULL,NULL,1),
    (7,2,7,'2026-09-15 12:00:00',0);`);
  assert.deepEqual(salesBillCheckingScore(db, 7, '2026-09-14', '2026-09-19'), { given: null, done: 2 });
  db.exec('UPDATE sales_bills SET sent_to_client=1');
  assert.equal(salesBillCheckingScore(db, 7, '2026-09-14', '2026-09-19').done, 2);
  assert.equal(salesBillCheckingScore(db, 8, '2026-09-14', '2026-09-19').done, 1);
  db.close();
});

test('existing checking KPI is connected once without changing targets or unrelated metrics', () => {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE app_settings(key TEXT PRIMARY KEY,value TEXT);
    CREATE TABLE score_kpis(id INTEGER PRIMARY KEY, metric_name TEXT, data_source TEXT, default_planned REAL, weightage REAL);
    INSERT INTO score_kpis VALUES(1,'RA Bill/ Sales Bill Checking','manual',5,12),
    (2,'RA bills raised on time','auto:ra_bills',3,10);`);
  migrateSalesBillCheckingScore(db);
  assert.deepEqual(db.prepare('SELECT data_source,default_planned,weightage FROM score_kpis WHERE id=1').get(),
    { data_source: 'auto:sales_bill_checking', default_planned: 5, weightage: 12 });
  assert.equal(db.prepare('SELECT data_source FROM score_kpis WHERE id=2').get().data_source, 'auto:ra_bills');
  db.exec("UPDATE score_kpis SET data_source='manual' WHERE id=1");
  migrateSalesBillCheckingScore(db);
  assert.equal(db.prepare('SELECT data_source FROM score_kpis WHERE id=1').get().data_source, 'manual');
  db.close();
});
