const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { kittingAllProjects, kittingProgress, kittingWeeklyProgress } = require('../crmKittingProgress');
const db = new Database(':memory:');
db.exec(`
  CREATE TABLE business_book (company_name TEXT, client_name TEXT);
  CREATE TABLE crm_kitting_project_meta (project_key TEXT, crm_owner TEXT, removed_at TEXT);
  CREATE TABLE crm_kitting_checkpoint (id INTEGER PRIMARY KEY, stage_no INTEGER, is_active INTEGER);
  CREATE TABLE crm_kitting_entry (id INTEGER PRIMARY KEY, project_key TEXT, checkpoint_id INTEGER, status TEXT, uploaded_by INTEGER, uploaded_at TEXT, observation_date TEXT);
  INSERT INTO business_book VALUES ('A','Client A'),(' A ','Duplicate A'),('B','Client B'),('Removed','Client R'),('','Fallback');
  INSERT INTO crm_kitting_project_meta VALUES ('A','Other user',NULL),('Removed','Owner','2026-09-01'),('Orphan','Owner',NULL);
  INSERT INTO crm_kitting_checkpoint VALUES (1,1,1),(2,2,1),(3,3,1),(4,3,1),(5,1,0);
  INSERT INTO crm_kitting_entry VALUES
    (1,'A',1,'yes',1,'2026-10-20 10:00:00','2026-10-20'),
    (2,'A',1,'no',1,'2026-10-21 11:00:00','2026-10-21'),
    (3,'A',2,'partially',1,'2026-10-22 12:00:00','2026-10-22'),
    (4,'A',3,'na',1,'2026-10-10 10:00:00','2026-10-10'),
    (5,'A',4,'yes',1,'2026-10-23 10:00:00','2026-10-23'),
    (6,'B',1,'yes',2,'2026-10-20 10:00:00','2026-10-20'),
    (7,'B',1,'',2,'2026-10-20 10:00:00','2026-10-20'),
    (8,'B',2,NULL,2,'2026-10-20 10:00:00','2026-10-20'),
    (9,'B',3,'   ',2,'2026-10-20 10:00:00','2026-10-20'),
    (10,'A',5,'yes',1,'2026-10-20 10:00:00','2026-10-20'),
    (11,'Removed',1,'yes',1,'2026-10-20 10:00:00','2026-10-20'),
    (12,'Orphan',1,'yes',1,'2026-10-20 10:00:00','2026-10-20'),
    (13,'Fallback',1,'yes',1,'2026-10-20 10:00:00','2026-10-20');
`);
const keys = kittingAllProjects(db);
assert.deepEqual(keys.sort(), ['A', 'B', 'Fallback']);
assert.deepEqual(kittingProgress(db, keys), { projects: 3, checkpoints: 4, given: 12, done: 5 });
assert.deepEqual(kittingProgress(db, [...keys, 'A']), kittingProgress(db, keys));
assert.deepEqual(kittingProgress(db, []), { projects: 0, checkpoints: 4, given: 0, done: 0 });
db.exec("UPDATE crm_kitting_project_meta SET removed_at=NULL WHERE project_key='Removed'");
assert.deepEqual(kittingProgress(db, kittingAllProjects(db)), { projects: 4, checkpoints: 4, given: 16, done: 6 });

// Test stage-disabling deduction from plan (given) and actual (done):
db.exec("ALTER TABLE crm_kitting_project_meta ADD COLUMN stage1_disabled_at DATETIME");
db.exec("ALTER TABLE crm_kitting_project_meta ADD COLUMN stage2_disabled_at DATETIME");
db.exec("ALTER TABLE crm_kitting_project_meta ADD COLUMN stage3_disabled_at DATETIME");
db.exec("UPDATE crm_kitting_project_meta SET stage1_disabled_at=CURRENT_TIMESTAMP WHERE project_key='A'");
// Project A has stage 1 disabled (1 checkpoint in stage 1).
// Plan drops from 16 to 15 (16 - 1 = 15).
// Done drops from 6 to 5 (checkpoint 1 on project A was in stage 1).
assert.deepEqual(kittingProgress(db, kittingAllProjects(db)), { projects: 4, checkpoints: 4, given: 15, done: 5 });

// Test Solution 1 weekly progress (kittingWeeklyProgress):
// Week of 2026-10-19 to 2026-10-24:
// Entries in week:
// id 1: A, cp 1
// id 2: A, cp 1 (duplicate cp on same project, DISTINCT cp counts 1)
// id 3: A, cp 2
// id 5: A, cp 4
// id 10: A, cp 5
// id 11: Removed, cp 1
// id 13: Fallback, cp 1
// (id 4 was on 2026-10-10 -> excluded)
// Across all projects for user 1:
const weekly = kittingWeeklyProgress(db, kittingAllProjects(db), 1, '2026-10-19 00:00:00', '2026-10-24 23:59:59');
assert.equal(weekly.done >= 3, true);

db.close();
console.log('Full-Kitting performance checks passed');

