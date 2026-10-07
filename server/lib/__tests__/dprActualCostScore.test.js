const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { dprActualCostScore } = require('../dprActualCostScore');

function fixture(t) {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE dpr(
    id INTEGER PRIMARY KEY, site_id INTEGER, submitted_by INTEGER,
    report_date TEXT, submission_time TEXT, created_at TEXT,
    is_planned_template INTEGER, approval_status TEXT,
    grand_total_b REAL, grand_total_a REAL, profit_loss REAL,
    planned_cost_b REAL
  );`);
  t.after(() => db.close());
  const insert = db.prepare(`INSERT INTO dpr(site_id,submitted_by,report_date,
    submission_time,created_at,is_planned_template,approval_status,
    grand_total_b,grand_total_a,profit_loss,planned_cost_b)
    VALUES(@site,@user,@date,@submitted,@created,@planned,@approval,
      @cost,@revenue,@profit,@planCost)`);
  return {
    db,
    add: values => insert.run({ site: 1, user: 7, date: '2026-10-05',
      submitted: '2026-10-05 06:00:00', created: '2026-10-05 05:00:00',
      planned: 0, approval: 'pending', cost: 0, revenue: 90000,
      profit: 88888, planCost: 77777, ...values }),
  };
}

test('Actual is the Table B daily cost amount; company and uploader scopes are distinct', t => {
  const { db, add } = fixture(t);
  add({ cost: 1386.67 });
  add({ site: 2, cost: 833.33 });
  add({ user: 8, cost: 4166.67 });
  add({ user: null, cost: 5066.67 });
  assert.deepEqual(dprActualCostScore(db, '2026-10-05', '2026-10-10'), { given: null, done: 11453.34 });
  assert.deepEqual(dprActualCostScore(db, '2026-10-05', '2026-10-10', { userId: 7 }), { given: null, done: 2220 });
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { userId: 8 }).done, 4166.67);
  db.exec('UPDATE dpr SET grand_total_a=1, profit_loss=-999999, planned_cost_b=1');
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10').done, 11453.34);
});

test('assigned-site scope counts those sites across uploaders, dedupes IDs and keeps unmapped employees at zero', t => {
  const { db, add } = fixture(t);
  add({ site: 1, user: 7, cost: 10 });
  add({ site: 1, user: 8, cost: 20 });
  add({ site: 2, user: 7, cost: 30 });
  add({ site: 3, user: 7, cost: 40 });
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { siteIds: [1, 1] }).done, 30);
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { siteIds: [1, 2] }).done, 60);
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { userId: 7 }).done, 80);
  assert.deepEqual(dprActualCostScore(db, '2026-10-05', '2026-10-10', { siteIds: [] }), { given: null, done: 0 });
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { siteIds: null }).done, 0);
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { siteIds: ['1) OR 1=1 --', 0, -1] }).done, 0);
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10', { userId: null }).done, 0);
});

test('selected Mon-Sat week follows report_date, with separate previous and next weeks', t => {
  const { db, add } = fixture(t);
  add({ date: '2026-09-28', cost: 10 });
  add({ date: '2026-10-03', cost: 20 });
  add({ date: '2026-10-04', cost: 9000 });
  add({ date: '2026-10-05', cost: 30, submitted: '2026-10-15 09:00:00', created: '2026-09-25 09:00:00' });
  add({ date: '2026-10-10', cost: 40 });
  add({ date: '2026-10-11', cost: 8000 });
  add({ date: '2026-10-12', cost: 50 });
  assert.equal(dprActualCostScore(db, '2026-09-28', '2026-10-03').done, 30);
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10').done, 70);
  assert.equal(dprActualCostScore(db, '2026-10-12', '2026-10-17').done, 50);
});

test('matches displayed actual rows regardless of approval or legacy missing submission time', t => {
  const { db, add } = fixture(t);
  add({ cost: 10, approval: 'pending' });
  add({ cost: 20, approval: 'approved' });
  add({ cost: 30, approval: 'rejected' });
  add({ cost: 40, submitted: null, planned: null });
  add({ cost: 99999, planned: 1, submitted: null });
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10').done, 100);
  db.exec("UPDATE dpr SET approval_status='approved'");
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10').done, 100);
});

test('sums before rounding, ignores null amounts and returns zero for empty cohorts', t => {
  const { db, add } = fixture(t);
  assert.deepEqual(dprActualCostScore(db, '2026-10-05', '2026-10-10'), { given: null, done: 0 });
  add({ cost: 0.104 });
  add({ cost: 0.104 });
  add({ cost: null });
  add({ cost: 0 });
  assert.equal(dprActualCostScore(db, '2026-10-05', '2026-10-10').done, 0.21);
  assert.deepEqual(dprActualCostScore(db, '2026-10-05', '2026-10-10', { userId: 999 }), { given: null, done: 0 });
  assert.equal(dprActualCostScore(db, '2026-09-28', '2026-10-03').done, 0);
});
