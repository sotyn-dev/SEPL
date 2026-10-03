const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { dispatchReceivingScore } = require('../dispatchReceivingScore');

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dispatch_receiving(id INTEGER PRIMARY KEY, created_by INTEGER, created_at TEXT,
    receiving_url TEXT, status TEXT, approved_by INTEGER, approved_at TEXT, updated_at TEXT);`);
  return db;
}

test('Planned is this uploader’s weekly records; Actual is approvals from the same records', () => {
  const db = fixture();
  db.exec(`INSERT INTO dispatch_receiving VALUES
    (1,7,'2026-09-28 06:00:00','/uploads/a.pdf','approved',8,'2026-09-29',NULL),
    (2,7,'2026-09-29 06:00:00','/uploads/b.pdf','pending',NULL,NULL,NULL),
    (3,7,'2026-09-30 06:00:00','/uploads/c.pdf','rejected',8,'2026-10-01',NULL),
    (4,7,'2026-09-21 06:00:00','/uploads/old.pdf','approved',9,'2026-10-01',NULL),
    (5,8,'2026-09-28 06:00:00','/uploads/other.pdf','approved',9,'2026-10-01',NULL),
    (6,7,'2026-09-28 06:00:00','  ','approved',8,'2026-10-01',NULL);`);
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-09-28','2026-10-03'),{given:3,done:1});
  assert.deepEqual(dispatchReceivingScore(db,8,'2026-09-28','2026-10-03'),{given:1,done:1});
  assert.deepEqual(dispatchReceivingScore(db,9,'2026-09-28','2026-10-03'),{given:0,done:0});
  // Approval performed later by an admin credits the original uploader/week.
  db.exec("UPDATE dispatch_receiving SET status='approved',approved_by=9,approved_at='2026-10-06' WHERE id=2");
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-09-28','2026-10-03'),{given:3,done:2});
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-10-05','2026-10-10'),{given:0,done:0});
  db.close();
});

test('uses the existing Monday–Saturday scoring week in IST, including exact boundaries', () => {
  const db = fixture();
  const insert=db.prepare("INSERT INTO dispatch_receiving(id,created_by,created_at,receiving_url,status) VALUES(?,7,?,'/uploads/proof.pdf','approved')");
  for (const [id,date] of [
    [1,'2026-09-27 18:29:59'], [2,'2026-09-27 18:30:00'],
    [3,'2026-10-03T18:29:59Z'], [4,'2026-10-03T18:30:00Z'],
    [5,'2026-09-28T00:00:00+05:30'], [6,'invalid'],
  ]) insert.run(id,date);
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-09-28','2026-10-03'),{given:3,done:3});
  db.close();
});

test('editing or replacing proof retains upload week and removes approval until reapproved', () => {
  const db = fixture();
  db.exec("INSERT INTO dispatch_receiving VALUES(1,7,'2026-09-28 06:00:00','/uploads/old.pdf','approved',8,'2026-09-29',NULL)");
  db.exec("UPDATE dispatch_receiving SET receiving_url='/uploads/new.pdf',status='pending',approved_by=NULL,approved_at=NULL,updated_at='2026-10-06'");
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-09-28','2026-10-03'),{given:1,done:0});
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-10-05','2026-10-10'),{given:0,done:0});
  db.exec("UPDATE dispatch_receiving SET status='approved',approved_by=8,approved_at='2026-10-07'");
  assert.deepEqual(dispatchReceivingScore(db,7,'2026-09-28','2026-10-03'),{given:1,done:1});
  db.close();
});

test('Performance engine auto-fills and locks Planned, preserves weight, and ignores stale manual counts', () => {
  const { db } = require('./fixtures/indentReviewFixture').fixture();
  const { computeScorecard } = require('../../routes/scoring');
  db.exec(`INSERT INTO score_templates(id,name) VALUES(9001,'Receiving test');
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9001);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source,default_planned)
      VALUES(9001,9001,'Weekly','Purchase to Rec',35,'higher_better','auto:dispatch_receiving_approved',100);
    INSERT INTO score_entries(user_id,kpi_id,week_start,planned,actual) VALUES(9002,9001,'2026-09-28',99,88);
    INSERT INTO score_user_kpi_target(user_id,kpi_id,planned_value,weight_override) VALUES(9002,9001,50,20);
    INSERT INTO dispatch_receiving(site_name,indent_number,bill_number,receiving_url,created_by,created_at,status) VALUES
      ('Sample site','I-1','B-1','/uploads/1.pdf',9002,'2026-09-28 06:00:00','approved'),
      ('Sample site','I-2','B-2','/uploads/2.pdf',9002,'2026-09-29 06:00:00','pending'),
      ('Sample site','I-3','B-3','/uploads/3.pdf',9003,'2026-09-29 06:00:00','approved');`);
  const row = computeScorecard(db,9002,'2026-09-28').kpis[0];
  assert.equal(row.planned,2); assert.equal(row.actual,1); assert.equal(row.actual_pct,50);
  assert.equal(row.target_auto,true); assert.equal(row.is_auto,true);
  assert.equal(row.weightage,20); assert.equal(row.template_weightage,35);
  assert.equal(db.prepare('SELECT planned,actual FROM score_entries WHERE kpi_id=9001').get().actual,88);
  const empty = computeScorecard(db,9002,'2026-10-05').kpis[0];
  assert.equal(empty.planned,0); assert.equal(empty.actual,0); assert.equal(empty.target_auto,true);
  db.close();
});
