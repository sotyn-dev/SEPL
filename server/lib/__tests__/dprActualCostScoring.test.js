process.env.ERP_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('DPR Actual Cost sources retain manual amount targets and resolve weekly costs through the scoring API', async t => {
  const { adminOnly } = require('../../middleware/auth');
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  require.cache[require.resolve('../../middleware/auth')].exports.adminOnly = adminOnly;
  // This column is added by the DPR route on server startup, rather than by
  // initializeDatabase. Keep this isolated fixture equivalent without loading
  // unrelated DPR scheduling and submission side effects.
  if (!db.prepare('PRAGMA table_info(dpr)').all().some(c => c.name === 'is_planned_template')) {
    db.exec('ALTER TABLE dpr ADD COLUMN is_planned_template INTEGER DEFAULT 0');
  }
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);
  db.exec(`INSERT INTO score_templates(id,name,active) VALUES(9801,'DPR amounts demo',1);
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9801),(9003,9801),(9004,9801);
    INSERT INTO purchase_orders(id,po_number,po_date,site_engineer_ids)
      VALUES(9801,'DPR-AMOUNT-DEMO-PO','2026-10-01','9002,9002');
    INSERT INTO sites(id,name,site_engineer_id,supervisor_id,po_id) VALUES
      (9801,'Direct assigned demo site',9002,NULL,NULL),
      (9802,'Supervisor demo site',NULL,9002,NULL),
      (9803,'PO assigned demo site',NULL,NULL,9801),
      (9804,'Other engineer demo site',9003,NULL,NULL);`);
  const insertDpr = db.prepare(`INSERT INTO dpr(site_id,submitted_by,report_date,
    submission_time,is_planned_template,approval_status,grand_total_b,grand_total_a,profit_loss)
    VALUES(@site,@user,@date,@time,@planned,@approval,@cost,@revenue,@profit)`);
  const add = data => insertDpr.run({ site: 9801, user: 9002, date: '2026-10-05',
    time: '2026-10-05 06:00:00', planned: 0, approval: 'pending',
    cost: 0, revenue: 0, profit: 0, ...data });
  add({ cost: 1000.25, revenue: 1500, profit: 499.75, approval: 'approved' });
  add({ user: 9003, date: '2026-10-06', cost: 200.50, revenue: 250, profit: 49.50 });
  add({ site: 9802, user: 9003, date: '2026-10-07', cost: 300.25, revenue: 350, profit: 49.75, approval: 'rejected' });
  add({ site: 9803, user: 9003, date: '2026-10-08', cost: 400, revenue: 500, profit: 100, approval: 'approved' });
  add({ site: 9804, date: '2026-10-10', cost: 500, revenue: 600, profit: 100 });
  add({ planned: 1, time: null, cost: 99000, revenue: 88000, profit: 77000 });
  add({ date: '2026-10-09', time: null, cost: null });
  add({ user: 9003, date: '2026-09-28', cost: 50.25, revenue: 75, profit: 24.75 });
  add({ site: 9804, date: '2026-10-03', cost: 60.75, revenue: 70, profit: 9.25, approval: 'approved' });
  add({ date: '2026-10-04', cost: 90000 });
  add({ date: '2026-10-11', cost: 80000 });
  add({ date: '2026-10-12', cost: 700 });

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (path, method = 'GET', body, user = 9004) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scoring${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-demo-user': String(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const create = async data => {
    const response = await request('/templates/9801/kpis', 'POST', {
      metric_name: 'DPR cost demo', group_name: 'Weekly', weightage: 0,
      direction: 'higher_better', ...data,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    return response.body.id;
  };
  const save = (id, values, week = '2026-10-05') => request('/scorecard/entry', 'PUT', {
    user_id: 9002, kpi_id: id, week_start: week, ...values,
  }, 9002);
  const row = (id, week = '2026-10-05', user = 9002) =>
    scoring.computeScorecard(db, user, week).kpis.find(k => k.kpi_id === id);
  let all, sites, uploader, count, profitByUser, approvalCount, siteProfit;

  await t.test('three scopes are available with manual Plan and automatic amount Actual', async () => {
    all = await create({ data_source: 'auto:dpr_actual_cost_all', metric_type: 'amount', planned_mode: 'manual', actual_mode: 'source', default_planned: 37 });
    sites = await create({ data_source: 'auto:dpr_actual_cost_sites', metric_type: 'amount', planned_mode: 'manual', actual_mode: 'source', default_planned: 2000 });
    uploader = await create({ data_source: 'auto:dpr_actual_cost_by_user', metric_type: 'amount', planned_mode: 'manual', actual_mode: 'source', default_planned: 1600 });
    for (const [id, expected] of [[all, 2401], [sites, 1901], [uploader, 1500.25]]) {
      assert.equal(row(id).actual, expected);
      assert.equal(row(id).actual_auto, true);
      assert.equal(row(id).planned_editable, true);
      assert.equal(row(id).metric_type, 'amount');
      assert.equal(row(id).target_auto, false);
    }
    assert.equal(row(all).planned, 37);
    assert.equal(row(uploader, '2026-10-05', 9003).actual, 900.75);
    assert.equal(row(sites, '2026-10-05', 9003).actual, 500);
    assert.equal(row(all, '2026-10-05', 9004).actual, 2401);
    assert.equal(row(sites, '2026-10-05', 9004).actual, 0);
    assert.equal(row(uploader, '2026-10-05', 9004).actual, 0);
  });

  await t.test('stale saved counts never replace the live cost; manual zero and decimals remain editable', async () => {
    assert.equal((await save(all, { planned: 4000.5, actual: 37 })).status, 200);
    const response = await request('/scorecard?user_id=9002&week_start=2026-10-05');
    assert.equal(response.status, 200);
    const kpi = response.body.kpis.find(k => k.kpi_id === all);
    assert.equal(kpi.planned, 4000.5); assert.equal(kpi.actual, 2401);
    assert.equal(kpi.actual_pct, 60);
    assert.equal((await save(all, { planned: 0, actual: 999 })).status, 200);
    assert.equal(row(all).planned, 0); assert.equal(row(all).actual, 2401);
    assert.equal(row(all).actual_pct, 0); assert.equal(row(all).planned_editable, true);
    assert.equal((await save(all, { planned: 4000.5 })).status, 200);
    assert.equal(row(all).actual, 2401);
    assert.equal(db.prepare('SELECT actual FROM score_entries WHERE kpi_id=? AND week_start=?').get(all, '2026-10-05').actual, 999);
  });

  await t.test('previous-week and period views fetch costs from their own report-date cohorts', async () => {
    assert.equal((await save(all, { planned: 300, actual: 999 }, '2026-09-28')).status, 200);
    assert.equal(row(all).previous_planned, 300); assert.equal(row(all).previous_actual, 111);
    assert.equal(row(all).last_week_pct, 37);
    assert.equal(row(all, '2026-09-28').actual, 111);
    assert.equal(row(sites, '2026-09-28').actual, 50.25);
    assert.equal(row(uploader, '2026-09-28').actual, 60.75);
    assert.equal(row(all, '2026-10-12').actual, 700);
    assert.equal(row(all, '2026-10-19').actual, 0);
    const response = await request('/scorecard-range?user_id=9002&from=2026-09-28&to=2026-10-10');
    assert.equal(response.status, 200);
    const find = id => response.body.kpis.find(k => k.kpi_id === id);
    assert.equal(find(all).planned, 4300.5); assert.equal(find(all).actual, 2512);
    assert.equal(find(all).actual_pct, 58);
    assert.equal(find(sites).actual, 1951.25);
    assert.equal(find(uploader).actual, 1561);
  });

  await t.test('existing submission-count, approval-count and profit sources retain their semantics', async () => {
    count = await create({ data_source: 'auto:dpr_count' });
    profitByUser = await create({ data_source: 'auto:dpr_profit_by_user' });
    approvalCount = await create({ data_source: 'auto:dpr_cost_by_user' });
    siteProfit = await create({ data_source: 'auto:dpr_profit' });
    assert.equal(row(count).planned, 6); assert.equal(row(count).actual, 6);
    assert.equal(row(profitByUser).actual, 77599.75);
    assert.equal(row(approvalCount).planned, 4); assert.equal(row(approvalCount).actual, 1);
    assert.equal(row(siteProfit).planned, 151351.5); assert.equal(row(siteProfit).actual, 90600);
    assert.equal(row(all).actual, 2401); assert.equal(row(sites).actual, 1901);
    assert.equal(row(uploader).actual, 1500.25);
  });
});
