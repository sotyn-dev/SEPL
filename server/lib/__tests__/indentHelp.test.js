const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Indent Help stays inside procurement, requires an indent and only the assignee can complete it', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const role = db.prepare("INSERT INTO roles(name) VALUES('Indent Help test access')").run().lastInsertRowid;
  db.prepare("INSERT INTO role_permissions(role_id,module,can_view) VALUES(?,'procurement',1)").run(role);
  for (const id of [9001,9002,9003]) db.prepare('INSERT INTO user_roles(user_id,role_id) VALUES(?,?)').run(id, role);
  db.exec(`INSERT INTO users(id,name,email,username,password,role,active) VALUES
    (9010,'No module access','no-module@example.invalid','no-module','test','user',1),
    (9011,'Inactive person','inactive@example.invalid','inactive','test','user',0),
    (9012,'Unrelated viewer','unrelated@example.invalid','unrelated','test','user',1);
    INSERT INTO indents(id,indent_number,site_name,created_by,raised_by_name,status) VALUES
    (92001,'IND-DEMO-01','Sample Site A',9002,'Site Engineer A (Demo raiser)','approved'),
    (92002,'IND-DEMO-02','Sample Site B',9003,'Other Engineer (Demo)','submitted');`);
  db.prepare('INSERT INTO user_roles(user_id,role_id) VALUES(9012,?)').run(role);
  const generalCount = db.prepare('SELECT COUNT(*) n FROM support_tickets').get().n;
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.on('listening', r));
  t.after(() => { server.close(); db.close(); });
  const request = async (path = '', method = 'GET', body, user = 9002) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/procurement/indent-help${path}`, {
      method, headers: { 'x-demo-user': String(user), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, body: await r.json() };
  };
  let seq = 0;
  const payload = extra => ({ indent_id: 92001, assigned_to: 9003, subject: 'Confirm dispatch date', description: 'Please confirm when the approved material will leave store.', stage: 'Dispatch', priority: 'normal', request_id: `indent-help-test-${++seq}`, ...extra });
  let id;
  await t.test('missing or nonexistent indent cannot create a ticket', async () => {
    for (const indent_id of [null, '', 0, 'IND-DEMO-01', 987654, 1.5]) assert.equal((await request('', 'POST', payload({ indent_id }))).status, 400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM indent_help').get().n, 0);
  });
  await t.test('module access, indent visibility and active assignee are enforced', async () => {
    assert.equal((await request('', 'GET', null, 9010)).status, 403);
    assert.equal((await request('/options', 'GET', null, 9010)).status, 403);
    assert.equal((await request('', 'POST', payload(), 9010)).status, 403);
    assert.equal((await request('', 'POST', payload({ indent_id: 92002 }))).status, 400);
    for (const assigned_to of [null, 0, 9010, 9011, 99999]) assert.equal((await request('', 'POST', payload({ assigned_to }))).status, 400);
    const opts = (await request('/options')).body;
    assert.deepEqual(opts.indents.map(i => i.id), [92001]);
    assert.equal(opts.people.some(p => p.id === 9010 || p.id === 9011), false);
  });
  await t.test('issue details and enums are validated on the server', async () => {
    for (const extra of [{subject:' '}, {description:''}, {stage:'invalid'}, {priority:'unknown'}, {request_id:'bad'}, {subject:'x'.repeat(181)}])
      assert.equal((await request('', 'POST', payload(extra))).status, 400);
  });
  await t.test('create saves one local-module ticket and an in-app assignment, retries do not duplicate it', async () => {
    const body = payload();
    const result = await request('', 'POST', body); assert.equal(result.status, 201, JSON.stringify(result.body)); id = result.body.id;
    const retry = await request('', 'POST', body); assert.equal(retry.status, 200); assert.equal(retry.body.id, id);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM indent_help').get().n, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM support_tickets').get().n, generalCount);
    const notifications = db.prepare("SELECT * FROM notifications WHERE type='indent_help'").all();
    assert.equal(notifications.length, 1); assert.equal(notifications[0].user_id, 9003);
    assert.equal(notifications[0].link_url, '/procurement?tab=indenthelp');
  });
  await t.test('raiser, assignee and authorized overseer can see the linked ticket', async () => {
    const given = await request('?scope=raised'); assert.equal(given.body.total, 1); assert.equal(given.body.rows[0].indent_number, 'IND-DEMO-01');
    const mine = await request('?scope=mine', 'GET', null, 9003); assert.equal(mine.body.stats.assigned_to_me, 1); assert.equal(mine.body.total, 1);
    assert.equal((await request('?scope=mine')).body.total, 0);
    assert.equal((await request('', 'GET', null, 9004)).body.total, 1);
    assert.equal((await request('?q=IND-DEMO-01')).body.total, 1);
    assert.equal((await request('?q=missing')).body.total, 0);
  });
  await t.test('unrelated viewers cannot see other tickets, even with scope=all', async () => {
    assert.equal((await request('?scope=all', 'GET', null, 9012)).body.total, 0);
    assert.equal((await request('', 'GET', null, 9012)).body.stats.total, 0);
  });
  await t.test('neither the raiser nor admin nor an unrelated user can mark Done', async () => {
    for (const user of [9002, 9004, 9001]) assert.equal((await request(`/${id}/done`, 'PATCH', {}, user)).status, 403);
    assert.equal(db.prepare('SELECT status FROM indent_help WHERE id=?').get(id).status, 'open');
  });
  await t.test('assignee marks Done without proof and repeat completion preserves the original record', async () => {
    const result = await request(`/${id}/done`, 'PATCH', { completion_note: 'Dispatch confirmed for tomorrow.' }, 9003);
    assert.equal(result.status, 200); assert.equal(result.body.status, 'done');
    const done = db.prepare('SELECT * FROM indent_help WHERE id=?').get(id);
    assert.equal(done.completed_by, 9003); assert.ok(done.completed_at); assert.equal(done.completion_note, 'Dispatch confirmed for tomorrow.');
    await request(`/${id}/done`, 'PATCH', { completion_note: 'Repeat click' }, 9003);
    assert.deepEqual(db.prepare('SELECT * FROM indent_help WHERE id=?').get(id), done);
    assert.equal((await request('?status=open')).body.total, 0);
    assert.equal((await request('?status=done')).body.stats.done, 1);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM support_tickets').get().n, generalCount);
  });
  await t.test('completion note is optional', async () => {
    const fresh = await request('', 'POST', payload({ assigned_to: 9002 }));
    assert.equal(fresh.status, 201);
    assert.equal((await request(`/${fresh.body.id}/done`, 'PATCH', {})).status, 200);
    assert.equal(db.prepare('SELECT completion_note FROM indent_help WHERE id=?').get(fresh.body.id).completion_note, null);
  });
});
