process.env.ERP_DB_PATH = ':memory:';
const { test } = require('node:test');
const assert = require('node:assert/strict');

test('Help Ticket detail edits enforce permissions and preserve resolution/proof and Performance counts', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  app.use('/api/support', require('../../routes/support'));
  app.use('/api/scoring', require('../../routes/scoring'));
  db.exec(`INSERT INTO users(id,name,email,username,password,role,active) VALUES
    (9010,'Approval overseer','approval@example.invalid','approval-demo','test','user',1),
    (9011,'Inactive assignee','inactive@example.invalid','inactive-demo','test','user',0),
    (9012,'Unrelated viewer','unrelated@example.invalid','unrelated-demo','test','user',1);
    INSERT INTO roles(id,name) VALUES(97001,'Ticket follow-up'),(97002,'Ticket approval'),(97003,'Ticket view');
    INSERT INTO role_permissions(role_id,module,can_view,can_see_all,can_approve) VALUES
      (97001,'help_tickets',1,1,0),(97002,'help_tickets',1,0,1),(97003,'help_tickets',1,0,0);
    INSERT INTO user_roles(user_id,role_id) VALUES(9001,97001),(9010,97002),(9012,97003);
    INSERT INTO score_templates(id,name) VALUES(97001,'Help Ticket edit test');
    INSERT INTO score_user_template(user_id,template_id) VALUES(9003,97001);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source)
      VALUES(97001,97001,'Weekly','Help Tickets',100,'higher_better','auto:tickets');`);
  const insert = db.prepare(`INSERT INTO support_tickets
    (id,ticket_no,user_id,assigned_to,subject,description,category,priority,status,module,deadline_date,
     attachment_link,proof_url,proof_notes,proof_submitted_at,proof_submitted_by,reject_reason,
     admin_response,resolved_at,resolved_by,created_at,updated_at)
    VALUES(?,?,9002,9003,'Original subject','Original description','bug','medium',?,'Procurement',?,
      '/uploads/attachment.pdf','/uploads/proof.pdf','Original proof','2026-10-05 10:00:00',9003,?,
      'Original response',?,?,'2026-09-21 10:00:00','2026-09-21 10:00:00')`);
  const cases = [
    [97001, 'resolved', '2026-09-28', '2026-10-06 10:00:00'],
    [97002, 'open', '2026-10-06', null],
    [97003, 'closed', '2026-10-06', '2026-10-05 10:00:00'],
    [97004, 'submitted', '2026-10-06', null],
    [97005, 'rejected', '2026-10-06', null],
  ];
  for (const [id, status, due, resolved] of cases) insert.run(id, `TK-DEMO-${id}`, status, due,
    status === 'rejected' ? 'Please re-upload' : null, resolved, resolved ? 9004 : null);
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const request = async (path, method = 'PATCH', body, user = 9004) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, {
      method, headers: { 'content-type': 'application/json', 'x-demo-user': String(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  };
  const edit = (id, body, user) => request(`/support/${id}/details`, 'PATCH', body, user);
  const ticket = id => db.prepare('SELECT * FROM support_tickets WHERE id=?').get(id);
  const score = async () => {
    const r = await request('/scoring/scorecard?user_id=9003&week_start=2026-10-05', 'GET');
    assert.equal(r.status, 200);
    const k = r.body.kpis.find(row => row.kpi_id === 97001);
    return { planned: k.planned, actual: k.actual, pending: k.pending_uptodate, done: k.pending_work, score: r.body.score };
  };

  await t.test('raiser, admin, See All and approval overseers can edit; assignees and unrelated viewers cannot', async () => {
    for (const user of [9002, 9004, 9001, 9010]) assert.equal((await edit(97002, { subject: `Edited by ${user}` }, user)).status, 200);
    for (const user of [9003, 9012]) {
      const before = ticket(97002);
      assert.equal((await edit(97002, { description: 'Unauthorized change' }, user)).status, 403);
      assert.deepEqual(ticket(97002), before);
    }
    assert.equal((await edit(99999, { subject: 'Missing' })).status, 404);
  });
  await t.test('detail edits preserve every workflow field for open, submitted, rejected and completed tickets', async () => {
    for (const [id] of cases) {
      const before = ticket(id);
      const fields = { subject: ' Corrected subject ', description: ' Corrected details ', category: 'material', priority: 'urgent', module: ' Store ' };
      assert.equal((await edit(id, fields)).status, 200);
      const after = ticket(id);
      assert.equal(after.subject, 'Corrected subject'); assert.equal(after.description, 'Corrected details');
      assert.equal(after.category, 'material'); assert.equal(after.priority, 'urgent'); assert.equal(after.module, 'Store');
      for (const key of Object.keys(before).filter(key => !Object.keys(fields).includes(key) && key !== 'updated_at')) {
        assert.deepEqual(after[key], before[key], `${before.status} ticket: ${key} must be preserved`);
      }
    }
  });
  await t.test('only admin/follow-up can reassign, unchanged assignee can be included by the raiser', async () => {
    assert.equal((await edit(97004, { assigned_to: '9003', description: 'Details only' }, 9002)).status, 200);
    assert.equal((await edit(97004, { assigned_to: 9001 }, 9002)).status, 403);
    assert.equal((await edit(97004, { assigned_to: null }, 9002)).status, 403);
    assert.equal(ticket(97004).assigned_to, 9003);
    assert.equal((await edit(97004, { assigned_to: 9001 }, 9010)).status, 200);
    assert.equal(ticket(97004).assigned_to, 9001);
    assert.equal((await edit(97004, { assigned_to: null }, 9004)).status, 200);
    assert.equal(ticket(97004).assigned_to, null);
    assert.equal((await edit(97004, { assigned_to: 9003 }, 9001)).status, 200);
  });
  await t.test('invalid details and workflow injection fail atomically without changing any ticket fields', async () => {
    const invalid = [
      {}, [], { subject: '' }, { subject: '  ', priority: 'high' }, { description: null }, { description: 42 },
      { category: 'invalid' }, { priority: 'invalid' }, { module: {} }, { deadline_date: '2026-02-30' },
      { deadline_date: 'tomorrow' }, { assigned_to: -1 }, { assigned_to: 0 }, { assigned_to: 9003.5 },
      { assigned_to: {} }, { assigned_to: true }, { assigned_to: 99999 }, { assigned_to: 9011 },
      { status: 'resolved' }, { resolved_at: '2026-10-07' }, { proof_url: '/uploads/replacement.pdf' },
      { subject: 'Must not save', resolved_by: 9002 },
    ];
    for (const body of invalid) {
      const before = ticket(97002);
      assert.equal((await edit(97002, body)).status, 400, JSON.stringify(body));
      assert.deepEqual(ticket(97002), before);
    }
  });
  await t.test('an existing inactive assignee is retained during unrelated edits but cannot be newly selected', async () => {
    db.prepare('UPDATE support_tickets SET assigned_to=9011 WHERE id=97004').run();
    assert.equal((await edit(97004, { assigned_to: '9011', subject: 'Retain historical assignee' }, 9002)).status, 200);
    assert.equal(ticket(97004).assigned_to, 9011);
    assert.equal((await edit(97002, { assigned_to: 9011 })).status, 400);
    assert.equal((await edit(97004, { assigned_to: 9003 })).status, 200);
  });
  await t.test('subject/priority edits leave weekly and previous backlog scores unchanged', async () => {
    const before = await score();
    assert.deepEqual([before.planned, before.actual, before.pending, before.done], [4, 1, 1, 1]);
    for (const id of [97001, 97002, 97003]) {
      assert.equal((await edit(id, { subject: 'Scoring stays unchanged', priority: 'low' })).status, 200);
    }
    assert.deepEqual(await score(), before);
  });
  await t.test('an explicit deadline change moves the ticket between due-week cohorts, without changing resolution or proof', async () => {
    const before = ticket(97002);
    assert.equal((await edit(97002, { deadline_date: '2026-10-12' })).status, 200);
    const later = await score();
    assert.deepEqual([later.planned, later.actual, later.pending, later.done], [3, 1, 1, 1]);
    assert.equal((await edit(97002, { deadline_date: '2026-09-29' })).status, 200);
    const previous = await score();
    assert.deepEqual([previous.planned, previous.actual, previous.pending, previous.done], [3, 1, 2, 1]);
    assert.equal((await edit(97002, { deadline_date: '' })).status, 200);
    assert.equal(ticket(97002).deadline_date, null);
    assert.equal((await edit(97002, { deadline_date: before.deadline_date })).status, 200);
    for (const key of ['status', 'resolved_at', 'resolved_by', 'proof_url', 'proof_submitted_at']) assert.equal(ticket(97002)[key], before[key]);
    const restored = await score();
    assert.deepEqual([restored.planned, restored.actual, restored.pending, restored.done], [4, 1, 1, 1]);
  });
});
