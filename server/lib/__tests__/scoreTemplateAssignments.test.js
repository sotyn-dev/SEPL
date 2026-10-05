const { test } = require('node:test');
process.env.ERP_DB_PATH = ':memory:';
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { initialize, setAssignments } = require('../scoreTemplateAssignments');

test('migrates single assignments without losing metadata and survives repeated startup', () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`CREATE TABLE users(id INTEGER PRIMARY KEY); INSERT INTO users VALUES(1),(2);
    CREATE TABLE score_templates(id INTEGER PRIMARY KEY); INSERT INTO score_templates VALUES(10),(11);
    CREATE TABLE score_user_template(user_id INTEGER PRIMARY KEY REFERENCES users(id),template_id INTEGER REFERENCES score_templates(id),assigned_at TEXT,assigned_by INTEGER REFERENCES users(id));
    INSERT INTO score_user_template VALUES(1,10,'2026-09-28 10:00:00',2),(2,NULL,NULL,NULL);`);
  initialize(db);
  assert.deepEqual(db.prepare('SELECT * FROM score_user_template').all(), [{user_id:1,template_id:10,assigned_at:'2026-09-28 10:00:00',assigned_by:2}]);
  db.prepare('INSERT INTO score_user_template(user_id,template_id) VALUES(1,11)').run();
  initialize(db);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM score_user_template').get().n, 2);
  assert.throws(() => db.prepare('INSERT INTO score_user_template(user_id,template_id) VALUES(1,11)').run(), /UNIQUE/);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('multiple assignments persist through the API and feed weekly, period and preview scores', async t => {
  // Use real admin enforcement with the fixture's synthetic identity middleware.
  const { adminOnly } = require('../../middleware/auth');
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  require.cache[require.resolve('../../middleware/auth')].exports.adminOnly = adminOnly;
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);
  db.exec(`INSERT INTO score_templates(id,name,active) VALUES(9101,'Office Store',1),(9102,'Purchase',1),(9103,'Inactive',0);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source,default_planned) VALUES
      (9101,9101,'Weekly','Weekly target',100,'higher_better','manual',10),
      (9102,9102,'Weekly','Weekly target',100,'higher_better','manual',4),
      (9103,9101,'Weekly','Receiving approval',0,'higher_better','auto:dispatch_receiving_approved',0),
      (9104,9102,'Weekly','Receiving approval',0,'higher_better','auto:dispatch_receiving_approved',0);
    INSERT INTO score_entries(user_id,kpi_id,week_start,planned,actual) VALUES
      (9002,9101,'2026-10-05',10,5),(9002,9102,'2026-10-05',4,4);
    INSERT INTO dispatch_receiving(site_name,indent_number,bill_number,receiving_url,created_by,created_at,status)
      VALUES('Sample','I-1','B-1','/uploads/demo.pdf',9002,'2026-10-05 06:00:00','approved');`);
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.on('listening', resolve));
  t.after(() => { server.close(); db.close(); });
  const request = async (path, method = 'GET', body, user = 9004) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/scoring${path}`, {
      method, headers: {'x-demo-user': String(user), 'content-type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:r.status, body:await r.json()};
  };
  await t.test('admin saves multiple unique templates; list has one employee row and accurate template counts', async () => {
    const saved = await request('/assignments/9002','PUT',{template_ids:[9101,'9102',9101]});
    assert.equal(saved.status,200); assert.deepEqual(saved.body.template_ids,[9101,9102]);
    const list = (await request('/assignments')).body.filter(a => a.user_id === 9002);
    assert.equal(list.length,1); assert.deepEqual(list[0].template_ids,[9101,9102]);
    assert.equal(list[0].template_name,'Office Store + Purchase');
    const templates = (await request('/templates')).body.filter(a => [9101,9102].includes(a.id));
    assert.deepEqual(templates.map(a => a.user_count),[1,1]);
  });
  await t.test('bad payloads, unknown employees and non-admins cannot alter assignments', async () => {
    for (const body of [{}, {template_ids:null}, {template_ids:'9101'}, {template_ids:[true]}, {template_ids:[1.5]}, {template_ids:[0]}, {template_ids:[{}]}, {template_ids:[9101,999999]}, {template_ids:[9103]}]) {
      assert.equal((await request('/assignments/9002','PUT',body)).status,400,JSON.stringify(body));
    }
    assert.equal((await request('/assignments/999999','PUT',{template_ids:[9101]})).status,404);
    assert.equal((await request('/assignments/9002','PUT',{template_ids:[]},9002)).status,403);
    assert.equal((await request('/assignments/9002','PUT',{template_id:9101})).status,409);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM score_user_template WHERE user_id=9002').get().n,2);
  });
  await t.test('weekly combines distinct KPI IDs and weights without doubling automatic activity', async () => {
    const card = (await request('/scorecard?user_id=9002&week_start=2026-10-05')).body;
    assert.equal(card.templates.length,2); assert.equal(card.kpis.length,4);
    assert.equal(card.score,75); assert.equal(card.total_weight,200); assert.equal(card.activity,1);
    assert.deepEqual(card.kpis.filter(k => k.data_source === 'manual').map(k => [k.template_name,k.planned,k.actual]), [['Office Store',10,5],['Purchase',4,4]]);
    const range = await request('/scorecard-range?user_id=9002&from=2026-10-05&to=2026-10-10');
    assert.equal(range.status,200); assert.equal(range.body.templates.length,2); assert.equal(range.body.score,75);
  });
  await t.test('template editor preview is isolated and personal overrides still apply', async () => {
    const preview = (await request('/scorecard?user_id=9002&week_start=2026-10-05&template_id=9102')).body;
    assert.deepEqual(preview.templates.map(t => t.id),[9102]); assert.equal(preview.score,100);
    await request('/users/9002/kpi-targets/9102','PUT',{weight_override:50});
    assert.equal(scoring.computeScorecard(db,9002,'2026-10-05').score,66.67);
    await request('/users/9002/kpi-targets/9102','PUT',{enabled:0});
    assert.equal(scoring.computeScorecard(db,9002,'2026-10-05').score,50);
    await request('/users/9002/kpi-targets/9102','PUT',{enabled:1});
  });
  await t.test('removing one or all templates preserves saved weekly values and personal targets', async () => {
    await request('/assignments/9002','PUT',{template_ids:[9102]});
    const card = scoring.computeScorecard(db,9002,'2026-10-05');
    assert.equal(card.template.id,9102); assert.equal(card.score,100);
    assert.equal(db.prepare('SELECT actual FROM score_entries WHERE kpi_id=9101').get().actual,5);
    assert.equal(db.prepare('SELECT weight_override FROM score_user_kpi_target WHERE kpi_id=9102').get().weight_override,50);
    await request('/assignments/9002','PUT',{template_ids:[]});
    assert.equal(scoring.computeScorecard(db,9002,'2026-10-05').template,null);
    assert.equal((await request('/assignments/9002','PUT',{template_id:9101})).status,200);
    assert.equal(scoring.computeScorecard(db,9002,'2026-10-05').score,50);
  });
  await t.test('inactive templates are excluded from scoring but can be removed or retained', () => {
    db.prepare('UPDATE score_templates SET active=0 WHERE id=9101').run();
    setAssignments(db,9002,{template_ids:[9101,9102]},9004);
    assert.deepEqual(scoring.computeScorecard(db,9002,'2026-10-05').templates.map(t => t.id),[9102]);
    setAssignments(db,9002,{template_ids:[9102]},9004);
    assert.throws(() => setAssignments(db,9002,{template_ids:[9101,9102]},9004), /active/);
  });
});
