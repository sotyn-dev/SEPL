process.env.ERP_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('KPI commitments carry from the exact previous saved week without changing scores or writing defaults', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);
  db.exec(`
    INSERT INTO score_templates(id,name,active) VALUES(9701,'Commitment carry demo',1);
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9701),(9003,9701);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source,default_planned) VALUES
      (9711,9701,'Weekly','Calls',25,'higher_better','manual',4),
      (9712,9701,'Weekly','Uploads',75,'higher_better','manual',10),
      (9713,9701,'Weekly','Other calls',0,'higher_better','manual',0);
    INSERT INTO score_entries(user_id,kpi_id,week_start,planned,actual,actual_pct,commitment,commitment_prev,pending_uptodate,pending_work) VALUES
      (9002,9711,'2026-09-28',4,1,25,NULL,'Older backlog note',8,2),
      (9002,9712,'2026-09-28',10,4,40,NULL,'Uploads backlog note',7,1),
      (9002,9713,'2026-09-28',0,0,100,'82',NULL,NULL,NULL),
      (9003,9711,'2026-09-28',4,0,0,'91',NULL,NULL,NULL),
      (9002,9711,'2026-10-05',4,3,75,NULL,'Current backlog note',6,2),
      (9002,9712,'2026-10-05',10,5,50,NULL,NULL,4,1);
  `);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scoring${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-demo-user': '9002' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const card = (week = '2026-10-05', user = 9002) => scoring.computeScorecard(db, user, week);
  const row = (id = 9711, week = '2026-10-05', user = 9002) => card(week, user).kpis.find(k => k.kpi_id === id);
  const save = patch => request('/scorecard/entry', 'PUT', { user_id: 9002, kpi_id: 9711, week_start: '2026-10-05', ...patch });
  const savedEntries = () => db.prepare('SELECT * FROM score_entries ORDER BY user_id,kpi_id,week_start').all();
  const scoreValues = value => ({
    score: value.score, total_weight: value.total_weight, activity: value.activity,
    rows: value.kpis.map(k => ({ id: k.kpi_id, weight: k.weightage, planned: k.planned, actual: k.actual,
      actual_pct: k.actual_pct, previous_planned: k.previous_planned, previous_actual: k.previous_actual,
      previous_actual_pct: k.previous_actual_pct, last_week_pct: k.last_week_pct,
      pending_uptodate: k.pending_uptodate, pending_work: k.pending_work, pending_pct: k.pending_pct })),
  });
  const beforeValues = scoreValues(card());
  assert.equal(beforeValues.score, 56.25);

  await t.test('exact previous week supplies the default for the same user and KPI only', async () => {
    db.prepare("UPDATE score_entries SET commitment='12' WHERE user_id=9002 AND kpi_id=9711 AND week_start='2026-09-28'").run();
    const snapshot = savedEntries();
    const response = await request('/scorecard?user_id=9002&week_start=2026-10-05');
    assert.equal(response.status, 200);
    const calls = response.body.kpis.find(k => k.kpi_id === 9711);
    assert.equal(calls.commitment, '12');
    assert.equal(calls.commitment_inherited, true);
    assert.equal(calls.commitment_from_week, '2026-09-28');
    assert.equal(calls.commitment_prev, 'Current backlog note');
    assert.equal(row(9712).commitment, null);
    assert.equal(row(9712).commitment_prev, null, 'backlog commitment must not carry forward');
    assert.equal(row(9713).commitment, '82', 'other KPIs retain their own commitment');
    assert.equal(row(9711, '2026-10-05', 9003).commitment, '91', 'other users retain their own commitment');
    assert.deepEqual(savedEntries(), snapshot, 'reading must never persist inherited defaults');
    assert.deepEqual(scoreValues(response.body), beforeValues, 'commitments must not alter numeric pairs or weighted scores');
  });

  await t.test('a numeric edit does not materialize an inherited default', async () => {
    assert.equal((await save({ planned: 4, actual: 3 })).status, 200);
    const saved = db.prepare("SELECT commitment FROM score_entries WHERE user_id=9002 AND kpi_id=9711 AND week_start='2026-10-05'").get();
    assert.equal(saved.commitment, null);
    assert.equal(row().commitment, '12');
    assert.equal(row().commitment_inherited, true);
    assert.deepEqual(scoreValues(card()), beforeValues);
  });

  await t.test('current numeric zero and intentionally blank clear override the inherited default', async () => {
    assert.equal((await save({ commitment: 0 })).status, 200);
    assert.equal(Number(row().commitment), 0);
    assert.equal(row().commitment_inherited, false);
    assert.equal((await save({ commitment: '0' })).status, 200);
    assert.equal(row().commitment, '0');
    assert.equal(row().commitment_inherited, false);
    assert.equal(row().commitment_from_week, null);
    assert.equal((await save({ commitment: '' })).status, 200);
    assert.equal(row().commitment, '');
    assert.equal(row().commitment_inherited, false);
    assert.equal((await save({ notes: 'Another field changed' })).status, 200);
    assert.equal(row().commitment, '', 'clearing must survive unrelated later saves');
    assert.equal(row().commitment_prev, 'Current backlog note');
    assert.deepEqual(scoreValues(card()), beforeValues);
  });

  await t.test('a current explicit value wins and carries exactly one saved week', async () => {
    assert.equal((await save({ commitment: '14' })).status, 200);
    assert.equal(row().commitment, '14');
    assert.equal(row().commitment_inherited, false);
    const next = row(9711, '2026-10-12');
    assert.equal(next.commitment, '14');
    assert.equal(next.commitment_inherited, true);
    assert.equal(next.commitment_from_week, '2026-10-05');
    assert.equal(next.commitment_prev, null);
    const gap = row(9711, '2026-10-19');
    assert.equal(gap.commitment, null, 'do not skip a week without a saved commitment');
    assert.equal(gap.commitment_inherited, false);
    assert.equal(gap.commitment_from_week, null);
    assert.equal(gap.previous_period.period_id, '2026-10-05', 'historical score comparisons remain independent');
    assert.equal(gap.previous_planned, 4);
    assert.equal(gap.previous_actual, 3);
  });

  await t.test('prior numeric zero inherits, while prior blank or null does not', () => {
    const update = db.prepare("UPDATE score_entries SET commitment=? WHERE user_id=9002 AND kpi_id=9711 AND week_start='2026-10-05'");
    update.run('0');
    assert.equal(row(9711, '2026-10-12').commitment, '0');
    assert.equal(row(9711, '2026-10-12').commitment_inherited, true);
    for (const blank of ['', '   ', null]) {
      update.run(blank);
      const next = row(9711, '2026-10-12');
      assert.equal(next.commitment, null);
      assert.equal(next.commitment_inherited, false);
      assert.equal(next.commitment_from_week, null);
    }
  });

  await t.test('legacy text remains intact and period aggregation has no inherited commitment or writes', async () => {
    assert.equal((await save({ commitment: 'Call customers next week' })).status, 200);
    assert.equal(row(9711, '2026-10-12').commitment, 'Call customers next week');
    const snapshot = savedEntries();
    const range = await request('/scorecard-range?user_id=9002&from=2026-10-05&to=2026-10-18');
    assert.equal(range.status, 200);
    assert.equal(range.body.period, true);
    for (const k of range.body.kpis) {
      assert.equal(k.commitment, null);
      assert.equal(k.commitment_prev, null);
      assert.equal(k.commitment_inherited, false);
      assert.equal(k.commitment_from_week, null);
    }
    assert.deepEqual(savedEntries(), snapshot);
    assert.deepEqual(scoreValues(card()), beforeValues);
  });
});
