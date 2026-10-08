const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { getActiveProjectMetric, listActiveProjects, countActiveProjectsWithDpr } = require('../activeProjects');
const { computeCmdDetail } = require('../../utils/cmdDashboard');

function fixture(t) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE business_book (id INTEGER PRIMARY KEY, project_name TEXT, company_name TEXT);
    CREATE TABLE purchase_orders (id INTEGER PRIMARY KEY, business_book_id INTEGER);
    CREATE TABLE sites (id INTEGER PRIMARY KEY, name TEXT, status TEXT, business_book_id INTEGER, po_id INTEGER);
    CREATE TABLE dpr (id INTEGER PRIMARY KEY, site_id INTEGER, report_date TEXT, submission_time TEXT, is_planned_template INTEGER);
  `);
  return db;
}

test('counts projects once across repeated orders, duplicate sites and PO-only links', t => {
  const db = fixture(t);
  db.exec(`
    INSERT INTO business_book VALUES (1,'Plant A','Client'), (2,' Plant A ','client'),
      (3,'Plant B','Client'), (4,'Plant A','Other client'), (5,'No site','Client');
    INSERT INTO purchase_orders VALUES (1,2),(2,3);
    INSERT INTO sites VALUES
      (1,'Plant A','active',1,NULL), (2,'"Plant A"','active',2,NULL),
      (3,'Plant A','active',NULL,1), (4,' Plant A ','active',0,NULL),
      (5,'Plant B','active',NULL,2), (6,'Other location','active',4,NULL),
      (7,'Plant A','completed',1,NULL);
  `);
  const result = getActiveProjectMetric(db);
  assert.equal(result.count, 3);
  assert.equal(result.active_site_rows, 6);
  assert.equal(listActiveProjects(db).length, 3);
  assert.equal(listActiveProjects(db).find(p => p.active_site_rows === 4).name, 'Plant A');
});

test('only explicit Active sites qualify; status changes are reflected without cached totals', t => {
  const db = fixture(t);
  db.exec(`INSERT INTO sites VALUES
    (1,'Running','active',NULL,NULL), (2,'Stopped','on_hold',NULL,NULL),
    (3,'Finished','completed',NULL,NULL), (4,'Unknown',NULL,NULL,NULL),
    (5,'Other','cancelled',NULL,NULL), (6,'Case typo','Active',NULL,NULL);`);
  assert.equal(getActiveProjectMetric(db).count, 1);
  db.exec("UPDATE sites SET status='completed' WHERE id=1");
  assert.equal(getActiveProjectMetric(db).count, 0);
  db.exec("UPDATE sites SET status='active' WHERE id=2");
  assert.equal(getActiveProjectMetric(db).count, 1);
});

test('legacy quote/whitespace variants collapse; broken and zero links cannot double-count', t => {
  const db = fixture(t);
  const insert = db.prepare('INSERT INTO sites VALUES (?, ?, ?, ?, ?)');
  insert.run(1, ' Example Site ', 'active', null, null);
  insert.run(2, '"Example\u00a0Site"', 'active', 0, null);
  insert.run(3, "'Example\tSite'", 'active', 9999, null);
  insert.run(4, '', 'active', null, null);
  insert.run(5, '', 'active', null, null);
  assert.equal(getActiveProjectMetric(db).count, 3);
  assert.equal(getActiveProjectMetric(db).unlinked_site_rows, 5);
  assert.ok(listActiveProjects(db).some(p => p.name === 'Unnamed site #4'));
});

test('ambiguous shared site names never merge different clients; invalid direct link falls back to PO', t => {
  const db = fixture(t);
  db.exec(`INSERT INTO business_book VALUES (1,'Hospital','Client A'),(2,'Hospital','Client B');
    INSERT INTO purchase_orders VALUES (1,1);
    INSERT INTO sites VALUES (1,'Hospital','active',1,NULL), (2,'Hospital','active',2,NULL),
      (3,'Hospital','active',NULL,NULL), (4,'Alias','active',9999,1);`);
  assert.equal(getActiveProjectMetric(db).count, 3);
  assert.equal(listActiveProjects(db).filter(p => p.project_key.startsWith('project:')).length, 2);
});

test('DPR numerator counts the same cohort once, excluding inactive and plan-only reports', t => {
  const db = fixture(t);
  const date = require('../istDate').istToday();
  db.exec(`INSERT INTO sites VALUES (1,'Running','active',NULL,NULL), (2,' Running ','completed',NULL,NULL),
    (3,'Second','active',NULL,NULL), (4,'Finished','completed',NULL,NULL);
    INSERT INTO dpr VALUES (1,1,'${date}','09:00',0),(2,2,'${date}','10:00',0),
      (3,3,'${date}',NULL,1),(4,4,'${date}','09:00',0),(5,3,'2000-01-01','09:00',0);`);
  assert.equal(countActiveProjectsWithDpr(db, date), 1);
  const cmd = computeCmdDetail(db, 90);
  assert.equal(cmd.operations.active_projects.count, 2);
  assert.equal(cmd.operations.active_sites, 2);
  assert.equal(cmd.operations.dpr.missed, 1);
  assert.equal(cmd.pulse.dpr_adherence_pct, 50);
  assert.equal(computeCmdDetail(db, 7).operations.active_projects.count, 2);
});

test('empty data returns zero, but missing schema fails rather than inventing zero', t => {
  const db = fixture(t);
  assert.equal(getActiveProjectMetric(db).count, 0);
  db.exec('DROP TABLE sites');
  assert.throws(() => getActiveProjectMetric(db), /no such table/);
});
