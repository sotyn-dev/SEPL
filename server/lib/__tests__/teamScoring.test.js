const test = require('node:test');
const assert = require('node:assert/strict');

test('TSK-0914: team scoring and viewable users under team leader', async (t) => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);

  // Setup team leader (9010), direct reports (9011, 9012) reporting to 9010
  db.exec(`
    INSERT INTO users (id, name, email, username, password, role, active, manager_id) VALUES
      (9010, 'Team Lead Rahul', 'rahul@example.invalid', 'rahul-demo', 'pw', 'user', 1, NULL),
      (9011, 'Engineer Amit', 'amit@example.invalid', 'amit-demo', 'pw', 'user', 1, 9010),
      (9012, 'Engineer Rohit', 'rohit@example.invalid', 'rohit-demo', 'pw', 'user', 1, 9010);

    INSERT INTO score_templates (id, name, active) VALUES (9101, 'Engineer Template', 1);
    INSERT INTO score_kpis (id, template_id, metric_name, weightage, default_planned, data_source) VALUES
      (9201, 9101, 'Manual Target', 100, 10, 'manual');

    INSERT INTO score_user_template (user_id, template_id) VALUES
      (9011, 9101),
      (9012, 9101);

    -- Week 2026-10-05: Amit scored 8/10 (80%), Rohit scored 10/10 (100%)
    INSERT INTO score_entries (user_id, kpi_id, week_start, planned, actual) VALUES
      (9011, 9201, '2026-10-05', 10, 8),
      (9012, 9201, '2026-10-05', 10, 10);
  `);

  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => {
    server.close();
    db.close();
  });

  const request = async (path, user = 9010) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/scoring${path}`, {
      headers: { 'x-demo-user': String(user) }
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  };

  await t.test('Team leader fetches team-summary with member scores and average', async () => {
    const res = await request('/team-summary?week_start=2026-10-05', 9010);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_team, true);
    assert.equal(res.body.team_count, 2);
    assert.equal(res.body.leader.name, 'Team Lead Rahul');

    const rohit = res.body.members.find(m => m.name === 'Engineer Rohit');
    const amit = res.body.members.find(m => m.name === 'Engineer Amit');
    assert.ok(rohit);
    assert.ok(amit);
    assert.equal(rohit.score, 100);
    assert.equal(amit.score, 80);
    assert.equal(res.body.team_average_score, 90);
  });

  await t.test('Non-leader gets empty team summary', async () => {
    const res = await request('/team-summary?week_start=2026-10-05', 9002);
    assert.equal(res.status, 200);
    assert.equal(res.body.has_team, false);
    assert.equal(res.body.team_count, 0);
    assert.equal(res.body.members.length, 0);
  });

  await t.test('Unauthorized user cannot view another leader team summary', async () => {
    const res = await request('/team-summary?leader_id=9010&week_start=2026-10-05', 9002);
    assert.equal(res.status, 403);
  });

  await t.test('Admin can view any leader team summary', async () => {
    const res = await request('/team-summary?leader_id=9010&week_start=2026-10-05', 9004); // 9004 is admin
    assert.equal(res.status, 200);
    assert.equal(res.body.team_count, 2);
  });

  await t.test('Viewable users returns direct reports for team leader', async () => {
    const res = await request('/viewable-users', 9010);
    assert.equal(res.status, 200);
    assert.equal(res.body.is_leader, true);
    assert.equal(res.body.users.length, 3); // Rahul (self) + Amit + Rohit
    assert.equal(res.body.users[0].name, 'Team Lead Rahul');
  });
});
