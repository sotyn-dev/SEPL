const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('selected Indent to Dispatch steps use module weekly totals', async t => {
  const { app, db } = require('./fixtures/indentReviewFixture').fixture();
  const scoring = require('../../routes/scoring');
  app.use('/api/scoring', scoring);
  app.use('/api/raci', require('../../routes/raci').router);
  const { invalidateAll } = require('../readCache');
  const { raciUserWeekBreakdown } = require('../../utils/raciModules');
  t.after(() => { invalidateAll(); db.close(); });

  db.exec(`INSERT INTO score_templates(id,name) VALUES(9301,'Indent owner'),(9302,'Additional role');
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9301),(9002,9302),(9003,9301);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source) VALUES
      (9301,9301,'Weekly','Final approval',50,'higher_better','auto:raci_step:indent_to_dispatch:approved'),
      (9302,9301,'Weekly','Rates finalized',50,'higher_better','auto:raci_step:indent_to_dispatch:rates'),
      (9303,9302,'Weekly','Indent raised',0,'higher_better','auto:raci_step:indent_to_dispatch:raised'),
      (9304,9301,'Weekly','Personal RACI',0,'higher_better','auto:raci_steps_done'),
      (9305,9301,'Weekly','Personal cheque steps',0,'higher_better','auto:raci_step:cheques:raised');
    INSERT INTO raci_assignment(module,record_id,step_key,responsible_id,consulted_id)
      VALUES('indent_to_dispatch',0,'approved',9001,9002);
    INSERT INTO score_entries(user_id,kpi_id,week_start,planned,actual,actual_pct,pending_uptodate,pending_work)
      VALUES(9002,9301,'2026-10-05',999,999,100,999,999),
            (9002,9301,'2026-09-28',999,999,100,999,999);`);
  const add = (id, created, landed, approved = null, status = approved ? 'approved' : 'submitted', source = 'vendor') => {
    db.prepare(`INSERT INTO indents(id,indent_number,created_at,created_by,status,l1_at,l2_at,crm_at,approved_at)
      VALUES(?,?,?,9001,?,?,?,?,?)`).run(id, `TEST-${id}`, created, status, landed, landed, landed, approved);
    db.prepare(`INSERT INTO indent_items(indent_id,description,quantity,unit,source) VALUES(?,'Cable',10,'m',?)`).run(id, source);
  };
  add(9301,'2026-10-05 01:00:00','2026-10-05 02:00:00','2026-10-05 03:00:00');
  add(9302,'2026-10-06 01:00:00','2026-10-06 02:00:00');
  add(9303,'2026-09-28 01:00:00','2026-09-29 02:00:00');
  add(9304,'2026-09-29 01:00:00','2026-09-30 02:00:00','2026-10-07 03:00:00');
  add(9305,'2026-09-28 01:00:00','2026-09-28 02:00:00','2026-09-29 03:00:00');
  add(9306,'2026-10-08 01:00:00','2026-10-08 02:00:00','2026-10-12 03:00:00');
  const card = (user = 9002, week = '2026-10-05', opts) => scoring.computeScorecard(db, user, week, opts);
  const approval = (user = 9002, week = '2026-10-05') => card(user, week).kpis.find(k => k.kpi_id === 9301);
  const counts = k => [k.planned,k.actual,k.pending_uptodate,k.pending_work];
  invalidateAll();

  await t.test('Consulted and unassigned employees get identical module numbers, with live previous week', () => {
    assert.deepEqual(counts(approval()), [4,2,2,1]);
    assert.deepEqual(counts(approval(9003)), [4,2,2,1]);
    assert.equal(approval().last_week_pct,33);
    assert.equal(approval().target_auto,true);
    assert.equal(approval().pending_auto,true);
    assert.equal(db.prepare("SELECT consulted_id FROM raci_assignment WHERE step_key='approved'").get().consulted_id,9002);
  });
  await t.test('multiple templates and source selections each fetch their own counts', () => {
    const result = card();
    assert.equal(result.templates.length,2);
    assert.deepEqual(counts(result.kpis.find(k => k.kpi_id === 9302)),[2,0,1,0]);
    assert.deepEqual(counts(result.kpis.find(k => k.kpi_id === 9303)),[3,3,0,0]);
    const preview = card(9003,'2026-10-05',{templateId:9302});
    assert.equal(preview.kpis[0].actual,3);
  });
  await t.test('general and other-module RACI remain personal', () => {
    assert.deepEqual(counts(card().kpis.find(k => k.kpi_id === 9304)),[0,0,0,0]);
    assert.deepEqual(counts(card().kpis.find(k => k.kpi_id === 9305)),[0,0,0,0]);
    const responsible = raciUserWeekBreakdown(db,9001,'2026-10-05','2026-10-10').find(r => r.module === 'indent_to_dispatch' && r.step_key === 'approved');
    assert.equal(responsible.actual,2);
    assert.equal(raciUserWeekBreakdown(db,9002,'2026-10-05','2026-10-10').length,0);
  });
  await t.test('historical weeks keep work pending until its recorded completion', () => {
    assert.deepEqual(counts(approval(9002,'2026-09-28')),[3,1,0,0]);
    assert.deepEqual(counts(approval(9002,'2026-10-12')),[1,1,3,1]);
  });
  await t.test('full record set is counted beyond the 500-record board limit', () => {
    const insert = db.prepare("INSERT INTO indents(indent_number,created_at,status) VALUES(?,'2026-11-01 01:00:00','submitted')");
    db.transaction(() => { for (let i=0;i<501;i++) insert.run(`FUTURE-${i}`); })();
    invalidateAll();
    assert.deepEqual(counts(approval()),[4,2,2,1]);
    db.prepare("DELETE FROM indents WHERE indent_number LIKE 'FUTURE-%'").run();
    invalidateAll();
  });
  await t.test('native completion, rejected records and store-only exemptions are respected', () => {
    add(9307,'2026-10-05 01:00:00','2026-10-05 02:00:00',null,'rejected');
    add(9308,'2026-10-05 01:00:00','2026-10-05 02:00:00','2026-10-05 03:00:00','approved','store');
    db.exec(`INSERT INTO raci_assignment(module,record_id,step_key,done_at) VALUES
      ('indent_to_dispatch',9301,'rates','2026-10-08 03:00:00'),
      ('indent_to_dispatch',9308,'rates','2026-10-08 03:00:00');`);
    invalidateAll();
    assert.deepEqual(counts(approval()),[5,3,2,1]);
    assert.deepEqual(counts(card().kpis.find(k => k.kpi_id === 9302)),[2,0,1,0]);
  });
  await t.test('Monday-Saturday window excludes Sunday completions and next-week work', () => {
    add(9309,'2026-10-09 01:00:00','2026-10-09 02:00:00','2026-10-11 03:00:00');
    add(9310,'2026-10-12 01:00:00','2026-10-12 02:00:00');
    invalidateAll();
    assert.deepEqual(counts(approval()),[6,3,2,1]);
  });
  await t.test('weekly and period API responses carry the same module counts', async () => {
    const server = app.listen(0,'127.0.0.1');
    await new Promise(resolve => server.on('listening',resolve));
    try {
      for (const endpoint of ['scorecard?week_start=2026-10-05','scorecard-range?from=2026-10-05&to=2026-10-10']) {
        const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scoring/${endpoint}&user_id=9002`,{headers:{'x-demo-user':'9004'}});
        assert.equal(response.status,200);
        const result = await response.json();
        const row = result.kpis.find(k => k.kpi_id === 9301);
        assert.equal(row.planned,6); assert.equal(row.actual,3);
      }
    } finally { await new Promise(resolve => server.close(resolve)); }
  });
});
