const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture } = require('./fixtures/indentReviewFixture');
const flow = require('../indentRaiserApproval');

test('new indent review and original-raiser approval through real procurement routes', async t => {
  const { app, db, setToday } = fixture();
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (url, user, body, method = 'PUT') => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/${url}`, { method, headers: { 'content-type': 'application/json', 'x-demo-user': String(user) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const make = async () => {
    const r = await request('procurement/indents', 9002, {
      site_name: 'DEMO Site A', raised_by_name: 'Site Engineer A', indent_category: 'rgp',
      emergency_reason: 'Local demo date window', notes: 'Synthetic fixture',
      items: [{ item_master_id: 90001, description: 'Demo drill', quantity: 2, unit: 'nos', item_type: 'RGP' }],
    }, 'POST');
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return db.prepare('SELECT * FROM indents ORDER BY id DESC LIMIT 1').get();
  };
  await t.test('cutoff snapshots only new indents, old pending records stay legacy', async () => {
    setToday('2026-09-27'); const old = await make();
    assert.equal(old.raiser_approval_required, 0);
    setToday('2026-09-28');
    assert.equal(flow.usesRaiserApproval(db.prepare('SELECT * FROM indents WHERE id=?').get(old.id)), false);
    const legacyApproval = await request(`procurement/indents/${old.id}`, 9001, { status: 'approved' });
    assert.equal(legacyApproval.status, 200, JSON.stringify(legacyApproval.body));
    assert.equal(db.prepare('SELECT approved_by FROM indents WHERE id=?').get(old.id).approved_by, 9001);
    assert.equal((await make()).raiser_approval_required, 1);
  });
  const row = await make();
  const url = `procurement/indents/${row.id}`;
  const act = (status, user, revision = 0, extra = {}) => request(url, user, { status, review_revision: revision, ...extra });
  await t.test('reviewer, raiser, and admin cannot skip review or forge final approval', async () => {
    for (const user of [9001, 9002, 9003, 9004]) assert.notEqual((await act('approved', user)).status, 200);
    assert.equal((await act('reviewed', 9003)).status, 403);
    assert.equal((await act('reviewed', 9004)).status, 403);
    assert.equal((await act('received', 9001)).status, 403);
    for (const user of [9001, 9002, 9004]) assert.equal((await act('rejected', user, 0, { reason: 'No reject in new flow' })).status, 403);
    assert.equal(db.prepare('SELECT status FROM indents WHERE id=?').get(row.id).status, 'submitted');
  });
  await t.test('correct review waits for raiser, records audit and in-app notification without issuing goods', async () => {
    assert.equal((await act('reviewed', 9001)).status, 200);
    assert.equal(db.prepare('SELECT status FROM indents WHERE id=?').get(row.id).status, 'l1_approved');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM delivery_notes WHERE indent_id=?').get(row.id).n, 0);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=9002 AND dedupe_key=?").get(`indent-raiser:${row.id}:0`).n, 1);
    assert.equal((await act('approved', 9001)).status, 403);
    assert.equal((await act('approved', 9003)).status, 403);
    assert.equal((await act('approved', 9004)).status, 403);
  });
  await t.test('edits invalidate review, stale approval cannot approve a revised indent', async () => {
    const r = await request(url, 9001, { site_name: row.site_name, raised_by_name: 'Display name cannot transfer ownership', notes: 'Corrected quantity', items: [{ item_master_id: 90001, description: 'Demo drill', quantity: 3, unit: 'nos', item_type: 'RGP' }] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const edited = db.prepare('SELECT * FROM indents WHERE id=?').get(row.id);
    assert.equal(edited.created_by, 9002);
    assert.equal(edited.review_revision, 1);
    assert.equal(edited.status, 'submitted');
    assert.equal((await act('approved', 9002)).status, 409);
    assert.equal((await act('reviewed', 9001, 1)).status, 200);
    assert.equal((await act('approved', 9002, 0)).status, 409);
  });
  await t.test('only original raiser finalizes reviewed version; subsequent calls cannot replay', async () => {
    assert.equal((await act('approved', 9002, 1, { quantity_overrides: { 1: 9 } })).status, 400);
    const r = await act('approved', 9002, 1);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const done = db.prepare('SELECT * FROM indents WHERE id=?').get(row.id);
    assert.equal(done.status, 'approved'); assert.equal(done.approved_by, 9002); assert.equal(done.l1_by, 9001);
    assert.equal((await act('approved', 9002, 1)).status, 409);
    assert.deepEqual(db.prepare('SELECT action FROM indent_review_audit WHERE indent_id=? ORDER BY id').all(row.id).map(x => x.action), ['marked_correct', 'edited_review_invalidated', 'marked_correct', 'raiser_approved']);
  });
  await t.test('dashboard and tracker cannot bypass the new workflow', async () => {
    const pending = await make();
    assert.equal((await request(`dashboards/approve/indents/${pending.id}`, 9004, {}, 'POST')).status, 409);
    assert.equal((await request(`indent-fms/tracker/${pending.id}/stage`, 9004, { stage: 'approved' }, 'POST')).status, 409);
    assert.equal(db.prepare('SELECT status FROM indents WHERE id=?').get(pending.id).status, 'submitted');
  });
  await t.test('CRM and global L2 settings cannot replace the new reviewer and raiser sequence', async () => {
    const extra = await make();
    db.prepare("UPDATE indents SET approval_policy='crm_two_level', crm_status='pending', indent_category='extra_non_schedule' WHERE id=?").run(extra.id);
    const extraUrl = `procurement/indents/${extra.id}`;
    assert.equal((await request(extraUrl, 9001, { status: 'reviewed', review_revision: 0 })).status, 409);
    assert.equal((await request(extraUrl, 9004, { status: 'approved' })).status, 200);
    assert.equal(db.prepare('SELECT status FROM indents WHERE id=?').get(extra.id).status, 'crm_approved');
    db.prepare("INSERT OR REPLACE INTO indent_to_dispatch_settings(key,value) VALUES ('approval.l2.enabled','1')").run();
    assert.equal((await request(extraUrl, 9001, { status: 'reviewed', review_revision: 0 })).status, 200);
    assert.equal((await request(extraUrl, 9004, { status: 'approved', review_revision: 0 })).status, 403);
    assert.equal((await request(extraUrl, 9002, { status: 'approved', review_revision: 0 })).status, 200);
    flow.migrate(db); flow.migrate(db);
    assert.equal(db.prepare('SELECT raiser_approval_required FROM indents WHERE id=?').get(extra.id).raiser_approval_required, 1);
  });
});
