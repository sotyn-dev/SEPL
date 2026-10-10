process.env.ERP_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Dashboard, War Room, DPR and Cash Flow share the same live project total', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  app.use('/api/dashboard', require('../../routes/dashboard'));
  app.use('/api/dpr', require('../../routes/dpr'));
  app.use('/api/cashflow', require('../../routes/cashflow'));
  app.use((err, req, res, next) => res.status(500).json({ error: err.message }));
  const baseline = require('../activeProjects').getActiveProjectMetric(db);
  const financialBaseline = db.prepare('SELECT COUNT(*) n FROM (SELECT company_name FROM business_book GROUP BY company_name)').get().n;
  db.exec(`INSERT INTO business_book(id,lead_no,client_name,company_name,project_name) VALUES
    (9801,'DEMO-A','Client A','Company A','Plant'),
    (9802,'DEMO-B','Client A','Company A','Plant'),
    (9803,'DEMO-C','Client B','Company B','Plant'),
    (9804,'DEMO-D','Client C','Company C','Historical');
    INSERT INTO sites(id,name,status,business_book_id,site_engineer_id) VALUES
    (9801,'Plant A','active',9801,9002), (9802,'Plant A copy','active',9802,9003),
    (9803,'Plant B','active',9803,9003), (9804,'Historical','completed',9804,9003);`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (url, user = 9004) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api${url}`, { headers: { 'x-demo-user': String(user) } });
    return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
  };
  const check = async expected => {
    const paths = ['/dashboard/active-projects', '/dashboard', '/dashboards/cmd-detail?days=7', '/dashboards/cmd-detail?days=365', '/dpr/summary', '/cashflow/projects', '/dashboards/spos-kpis'];
    const responses = await Promise.all(paths.map(p => request(p)));
    responses.forEach((r, i) => assert.equal(r.status, 200, `${paths[i]}: ${JSON.stringify(r.body)}`));
    const [single, home, war, warYear, dpr, cash, spos] = responses.map(r => r.body);
    for (const metric of [single, home.activeProjects, war.operations.active_projects, warYear.operations.active_projects, dpr.activeProjects, cash.summary.activeProjects, spos.active_projects]) {
      assert.equal(metric.count, expected);
      assert.equal(metric.scope, 'company');
      assert.equal(metric.definition, single.definition);
    }
    assert.equal(cash.summary.projectCount, financialBaseline + 3, 'financial report retains historical projects');
    assert.equal(responses[0].cache, 'no-store');
  };
  await check(baseline.count + 2);
  const detail = await request('/dashboard/active-projects?details=1');
  assert.equal(detail.body.projects.length, baseline.count + 2);
  assert.equal(detail.body.active_site_rows, baseline.active_site_rows + 3);
  assert.equal((await request('/dashboard/active-projects?details=1', 9002)).status, 403);
  assert.equal((await request('/dashboard/active-projects', 999999)).status, 401);
  const employee = await request('/dashboard/active-projects?days=1&user_id=9002', 9002);
  assert.equal(employee.body.count, baseline.count + 2, 'aggregate stays explicitly company-wide');
  assert.equal(employee.body.projects, undefined, 'aggregate does not disclose project names');
  db.exec("UPDATE sites SET status='on_hold' WHERE id=9803");
  await check(baseline.count + 1);
});
