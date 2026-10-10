process.env.ERP_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { dateTime, hoursFromDates, metricSettings } = require('../scoreMetricValues');
const { leadResponseScore } = require('../leadResponseScore');

test('date/time validation and elapsed versus late hours use IST', () => {
  assert.equal(hoursFromDates('2026-10-05T23:30', '2026-10-06T01:00'), 1.5);
  assert.equal(hoursFromDates('2026-10-05T09:00', '2026-10-05T09:15'), 0.25);
  assert.equal(hoursFromDates('2026-10-05T09:00', null), null);
  assert.equal(hoursFromDates('2026-10-05T09:00', '2026-10-05T08:00', 'delay'), 0);
  assert.throws(() => hoursFromDates('2026-10-05T09:00', '2026-10-05T08:00'), /on or after/);
  for (const value of ['2026-02-30', '2026-10-05T25:30', 'yesterday', {}, 42]) assert.throws(() => dateTime(value));
  assert.throws(() => metricSettings({ actual_mode: 'dates' }), /Hours/);
  assert.throws(() => metricSettings({ planned_mode: 'anything' }), /valid/);
});

test('independent metric modes, dated values and automatic response time work through the API', async t => {
  const { adminOnly } = require('../../middleware/auth');
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  require.cache[require.resolve('../../middleware/auth')].exports.adminOnly = adminOnly;
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);
  app.use('/api/sales-funnel', require('../../routes/salesfunnel'));
  db.exec(`INSERT INTO score_templates(id,name,active) VALUES(9501,'Flexible metrics demo',1);
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9501);
    INSERT INTO pms_tasks(title,assigned_by,assigned_to,due_date,status,reviewed_at) VALUES
      ('Current approved',9001,9002,'2026-10-05','approved','2026-10-05 10:00:00'),
      ('Current pending',9001,9002,'2026-10-06','pending',NULL),
      ('Previous approved',9001,9002,'2026-09-28','approved','2026-09-28 10:00:00');`);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (path, method = 'GET', body, user = 9004, prefix = '/api/scoring') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${prefix}${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-demo-user': String(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async options => {
    const response = await request('/templates/9501/kpis', 'POST', { metric_name: 'Test', ...options });
    assert.equal(response.status, 201, JSON.stringify(response.body)); return response.body.id;
  };
  const save = (id, values, week = '2026-10-05', user = 9002) => request('/scorecard/entry', 'PUT', { user_id: 9002, kpi_id: id, week_start: week, ...values }, user);
  const row = (id, week = '2026-10-05') => scoring.computeScorecard(db, 9002, week).kpis.find(k => k.kpi_id === id);
  let mixed, reverse, dates, amount, autoHours;
  await t.test('creation retains the target and saves manual Plan with automatic Actual', async () => {
    mixed = await create({ data_source: 'auto:pms', default_planned: 3, planned_mode: 'manual' });
    assert.equal(row(mixed).planned, 3); assert.equal(row(mixed).actual, 1);
    assert.equal((await save(mixed, { planned: 4, actual: 999 })).status, 200);
    assert.equal(row(mixed).planned, 4); assert.equal(row(mixed).actual, 1);
    assert.equal(row(mixed).actual_pct, 25); assert.equal(row(mixed).planned_editable, true);
    assert.equal((await save(mixed, { planned: 0 })).status, 200);
    assert.equal(row(mixed).planned, 0);
    await save(mixed, { planned: 4 });
    await save(mixed, { planned: 2, actual: 999 }, '2026-09-28');
    assert.equal(row(mixed).previous_planned, 2); assert.equal(row(mixed).previous_actual, 1);
    assert.equal(row(mixed).last_week_pct, 50);
  });
  await t.test('automatic Plan with manual Actual preserves the manual value', async () => {
    reverse = await create({ data_source: 'auto:pms', actual_mode: 'manual' });
    await save(reverse, { planned: 999, actual: 7 });
    assert.equal(row(reverse).planned, 2); assert.equal(row(reverse).actual, 7);
    assert.equal(row(reverse).actual_auto, false); assert.equal(row(reverse).planned_editable, false);
    const card = scoring.computeScorecard(db, 9002, '2026-10-05');
    assert.equal(card.activity, 1, 'manual Actual must not inflate automatic work activity');
    assert.equal(row(reverse).previous_planned, 1);
  });
  await t.test('incompatible settings, invalid targets and unauthorized writes are rejected', async () => {
    assert.equal((await request(`/kpis/${mixed}`, 'PUT', { actual_mode: 'dates' })).status, 400);
    assert.equal((await request(`/kpis/${mixed}`, 'PUT', { default_planned: 'not a number' })).status, 400);
    assert.equal((await request(`/kpis/${mixed}`, 'PUT', { planned_mode: 'source' }, 9002)).status, 403);
    assert.equal((await save(mixed, { planned: 12 }, '2026-10-05', 9003)).status, 403);
    assert.equal(row(mixed).planned, 4);
  });
  await t.test('Actual is calculated server-side from timestamps and incomplete times have no score', async () => {
    dates = await create({ metric_name: 'Lead response', metric_type: 'hours', planned_mode: 'manual', actual_mode: 'dates', direction: 'lower_better', default_planned: 1 });
    assert.equal(row(dates).actual, null); assert.equal(row(dates).actual_pct, null);
    const saved = await save(dates, { planned_at: '2026-10-05T09:00', actual_at: '2026-10-05T10:30', actual: 999 });
    assert.equal(saved.status, 200); assert.equal(saved.body.actual, 1.5);
    assert.equal(row(dates).actual, 1.5); assert.equal(row(dates).actual_pct, 67);
    await save(dates, { commitment: 'Call within one hour', pending_work: 0 });
    assert.equal(row(dates).actual_at, '2026-10-05T10:30'); assert.equal(row(dates).actual, 1.5);
    assert.equal((await save(dates, { actual_at: '2026-10-05T08:00' })).status, 400);
    assert.equal((await save(dates, { planned_at: '2026-02-30T09:00' })).status, 400);
    await save(dates, { actual_at: null });
    assert.equal(row(dates).actual, null); assert.equal(row(dates).actual_pct, null);
    await save(dates, { actual_at: '2026-10-05T10:30' });
    await save(dates, { planned: 2, planned_at: '2026-09-28T09:00', actual_at: '2026-09-28T11:00' }, '2026-09-28');
    assert.equal(row(dates).previous_actual, 2); assert.equal(row(dates).last_week_pct, 100);
    assert.equal(row(dates, '2026-10-19').previous_actual, null, 'do not substitute an older saved week');
  });
  await t.test('late-hours mode accepts early responses as zero delay', async () => {
    const late = await create({ metric_name: 'Response delay', metric_type: 'hours', planned_mode: 'manual', actual_mode: 'dates', time_basis: 'delay', direction: 'lower_better' });
    assert.equal((await save(late, { planned_at: '2026-10-05T10:00', actual_at: '2026-10-05T09:00' })).status, 200);
    assert.equal(row(late).actual, 0); assert.equal(row(late).actual_pct, 100);
    await request(`/kpis/${late}`, 'PUT', { time_basis: 'elapsed' });
    assert.equal(row(late).actual, null, 'changing the timing method must not break the entire scorecard');
    assert.match(row(late).date_error, /on or after/);
    await request(`/kpis/${late}`, 'PUT', { time_basis: 'delay' });
  });
  await t.test('amounts retain decimals and optional dates across later saves', async () => {
    amount = await create({ metric_name: 'Collection amount', metric_type: 'amount', planned_mode: 'manual', actual_mode: 'manual' });
    assert.equal((await save(amount, { planned: 1500.5, actual: 750.25, planned_at: '2026-10-07', actual_at: '2026-10-12' })).status, 200);
    assert.equal(row(amount).actual_pct, 50); assert.equal(row(amount).actual_at, '2026-10-12');
    await save(amount, { commitment: 'Balance next week' });
    assert.equal(row(amount).planned_at, '2026-10-07'); assert.equal(row(amount).actual, 750.25);
  });
  await t.test('period view averages recorded hours while summing counts and amounts', async () => {
    const result = await request('/scorecard-range?user_id=9002&from=2026-09-28&to=2026-10-10');
    assert.equal(result.status, 200);
    const find = id => result.body.kpis.find(k => k.kpi_id === id);
    assert.equal(find(dates).actual, 1.75); assert.equal(find(dates).planned, 1.5);
    assert.equal(find(mixed).planned, 6); assert.equal(find(mixed).actual, 2);
    assert.equal(find(amount).actual, 750.25);
  });
  await t.test('automatic response uses the first completed follow-up, with IST week boundaries and no historical guesses', async () => {
    // Fresh test installs retain a legacy nullable FK to this retired table.
    db.exec(`CREATE TABLE IF NOT EXISTS influencers(id INTEGER PRIMARY KEY);
      INSERT INTO sales_funnel(id,client_name,created_at) VALUES
      (9501,'First response','2026-10-04 19:00:00'),
      (9502,'Legacy response','2026-10-05 03:00:00'),
      (9503,'Other user response','2026-10-05 03:00:00'),
      (9504,'Previous week','2026-10-04 18:00:00'),
      (9505,'Scheduled only','2026-10-05 03:00:00');
      INSERT INTO lead_followups(lead_id,followup_date,done,done_by,created_at,completed_at) VALUES
      (9501,'2026-10-05',1,9002,'2026-10-04 19:10:00','2026-10-04 21:00:00'),
      (9501,'2026-10-05',1,9002,'2026-10-04 19:10:00','2026-10-05 01:00:00'),
      (9502,'2026-10-05',1,9002,'2026-10-05 03:00:00',NULL),
      (9502,'2026-10-05',1,9002,'2026-10-05 03:00:00','2026-10-05 08:00:00'),
      (9503,'2026-10-05',1,9003,'2026-10-05 03:00:00','2026-10-05 08:00:00'),
      (9504,'2026-10-05',1,9002,'2026-10-04 18:00:00','2026-10-05 08:00:00'),
      (9505,'2026-10-05',0,NULL,'2026-10-05 03:00:00',NULL);`);
    const result = leadResponseScore(db, 9002, '2026-10-05', '2026-10-10');
    assert.equal(result.done, 2); assert.equal(result.observations, 1);
    autoHours = await create({ metric_name: 'Automatic response', data_source: 'auto:lead_response_hours', metric_type: 'hours', planned_mode: 'manual', direction: 'lower_better', default_planned: 1 });
    assert.equal(row(autoHours).actual, 2); assert.equal(row(autoHours).actual_pct, 50);
    assert.equal(row(autoHours, '2026-10-12').actual, null);
  });
  await t.test('completion records the original time and actor only once', async () => {
    const id = db.prepare("INSERT INTO lead_followups(lead_id,followup_date,created_by) VALUES(9505,'2026-10-07',9002)").run().lastInsertRowid;
    const complete = user => request(`/followup/${id}`, 'PUT', { outcome: 'connected', notes: 'Sample response' }, user, '/api/sales-funnel');
    assert.equal((await complete(9002)).status, 200);
    const first = db.prepare('SELECT done,done_by,completed_at FROM lead_followups WHERE id=?').get(id);
    assert.equal(first.done, 1); assert.equal(first.done_by, 9002); assert.ok(first.completed_at);
    assert.equal((await complete(9003)).status, 200);
    assert.deepEqual(db.prepare('SELECT done,done_by,completed_at FROM lead_followups WHERE id=?').get(id), first);
  });
});
