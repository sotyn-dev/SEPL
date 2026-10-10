const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('weekly checklist scores match assigned task/date approvals', async t => {
  const { app, db, setToday } = require('./fixtures/indentReviewFixture').fixture();
  setToday('2026-10-07');
  const scoring = require('../../routes/scoring');
  const { checklistWeekScore } = require('../checklistWeekScore');
  app.use('/api/hr', require('../../routes/hr'));
  app.use('/api/scoring', scoring);
  const tasks = [
    [9401, 'Daily task A', 'daily', null, 'none'],
    [9402, 'Daily task B', 'daily', null, 'text'],
    [9403, 'Monday review', 'weekly', '2026-09-28', 'photo'],
    [9404, 'Monday report', 'weekly', '2026-09-28', 'none'],
    [9405, 'Saturday interview', 'weekly', '2026-10-03', 'photo'],
    [9406, 'Saturday meeting', 'weekly', '2026-10-03', 'pdf'],
    [9407, 'Month-end costs', 'monthly', '2026-09-30', 'file'],
    [9408, 'Month-end bills', 'monthly', '2026-09-30', 'photo'],
    [9409, 'Monthly compliance', 'monthly', '2026-09-29', 'photo'],
  ];
  const insertTask = db.prepare(`INSERT INTO checklists
    (id,title,description,frequency,due_date,assigned_to,proof_type,recurrence_start_date,recurrence_end_date,created_at)
    VALUES(?,?,?,?,?,9002,?,'2026-09-21','2026-10-31','2026-09-20 00:00:00')`);
  tasks.forEach(([id,title,frequency,due,type]) => insertTask.run(id,title,title,frequency,due,type));
  db.exec(`INSERT INTO attendance(user_id,date,status) VALUES(9002,'2026-10-02','leave');
    INSERT INTO score_templates(id,name) VALUES(9401,'Checklist test');
    INSERT INTO score_user_template(user_id,template_id) VALUES(9002,9401),(9004,9401);
    INSERT INTO score_kpis(id,template_id,group_name,metric_name,weightage,direction,data_source)
      VALUES(9401,9401,'Weekly','Checklist',25,'higher_better','auto:checklists');
    INSERT INTO score_entries(user_id,kpi_id,week_start,planned,actual,actual_pct)
      VALUES(9002,9401,'2026-09-21',999,888,90);`);
  const complete = (id,date,user=9002,status='approved',submitted=date+' 10:00:00') => db.prepare(`
    INSERT INTO checklist_completions(checklist_id,user_id,completion_date,approval_status,submitted_at)
    VALUES(?,?,?,?,?)`).run(id,user,date,status,submitted);
  // Previous week: 12 daily and four weekly approved occurrences.
  for (const row of checklistWeekScore(db,9002,'2026-09-21').rows) complete(row.checklist_id,row.date);
  // Current week: five working days, 10 daily + two weekly approvals.
  const dailyDates = ['2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-03'];
  for (const date of dailyDates) for (const id of [9401,9402]) {
    complete(id,date,['2026-09-28','2026-09-29'].includes(date) ? 9004 : 9002);
  }
  complete(9404,'2026-09-28'); complete(9406,'2026-10-03');
  const card = (week='2026-09-28', user=9002) => scoring.computeScorecard(db,user,week).kpis[0];
  const count = (week='2026-09-28',user=9002) => {
    const {given,done}=checklistWeekScore(db,user,week); return [given,done];
  };
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const get = async path => {
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api${path}`,{headers:{'x-demo-user':'9004'}});
    assert.equal(r.status,200); return r.json();
  };

  await t.test('17 planned / 12 approved matches every Follow-up occurrence',async()=>{
    assert.deepEqual(count(),[17,12]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM checklist_completions WHERE user_id=9002 AND completion_date BETWEEN '2026-09-28' AND '2026-10-03'").get().n,8);
    const follow=await get('/hr/checklists/followup?back=30');
    const cells=follow.rows.filter(r=>r.assigned_to===9002).flatMap(r=>r.cells
      .filter(c=>c.date>='2026-09-28'&&c.date<='2026-10-03'&&c.status!=='na')
      .map(c=>({key:`${r.id}::${c.date}`,actual:c.status==='done_approved'?1:0})));
    assert.equal(cells.length,17);
    const byKey=new Map(cells.map(c=>[c.key,c.actual]));
    for(const row of checklistWeekScore(db,9002,'2026-09-28').rows) assert.equal(row.actual,byKey.get(row.id));
    assert.equal(card().actual,12); assert.equal(card().actual_pct,71);
  });
  await t.test('the uploader receives no credit for another employee’s assignments',()=>{
    assert.deepEqual(count('2026-09-28',9004),[0,0]);
    assert.equal(card('2026-09-28',9004).actual,0);
  });
  await t.test('latest submission wins; pending and rejected proof do not count',()=>{
    db.exec('SAVEPOINT latest_proof');
    try {
      complete(9401,'2026-10-01',9004,'pending','2026-10-05 10:00:00');
      assert.deepEqual(count(),[17,11]);
      db.prepare("UPDATE checklist_completions SET approval_status='rejected' WHERE checklist_id=9401 AND user_id=9004 AND completion_date='2026-10-01'").run();
      assert.deepEqual(count(),[17,11]);
      db.prepare("UPDATE checklist_completions SET approval_status='approved' WHERE checklist_id=9401 AND user_id=9004 AND completion_date='2026-10-01'").run();
      assert.deepEqual(count(),[17,12]); // duplicate approved rows still count once
      complete(9407,'2026-09-30',9004,'pending');
      complete(9408,'2026-09-30',9004,'rejected');
      assert.deepEqual(count(),[17,12]);
    } finally {db.exec('ROLLBACK TO latest_proof; RELEASE latest_proof');}
  });
  await t.test('Sunday, leave, wrong recurrence date, and inactive tasks cannot inflate Actual',()=>{
    db.exec('SAVEPOINT excluded');
    try {
      complete(9401,'2026-10-04'); complete(9401,'2026-10-02');
      complete(9403,'2026-09-29');
      insertTask.run(9410,'Inactive task','Inactive task','daily',null,'none');
      db.prepare('UPDATE checklists SET active=0 WHERE id=9410').run();
      complete(9410,'2026-09-28');
      assert.deepEqual(count(),[17,12]);
      db.prepare("UPDATE checklists SET recurrence_start_date='2026-10-01' WHERE id=9401").run();
      assert.deepEqual(count(),[14,9]);
    } finally {db.exec('ROLLBACK TO excluded; RELEASE excluded');}
  });
  await t.test('previous week recalculates approvals instead of trusting stale saved totals',()=>{
    const result=card();
    assert.equal(result.previous_planned,16); assert.equal(result.previous_actual,16);
    assert.equal(result.previous_period.period_id,'2026-09-21');
    assert.equal(result.last_week_pct,100);
    const following=card('2026-10-05');
    assert.equal(following.previous_planned,17); assert.equal(following.previous_actual,12);
    assert.equal(following.last_week_pct,71);
    assert.equal(db.prepare('SELECT planned FROM score_entries WHERE kpi_id=9401').get().planned,999);
  });
  await t.test('weekly overview, detail, scorecard and period totals agree',async()=>{
    const overview=await get('/scoring/weekly?week_start=2026-09-28');
    assert.deepEqual(overview.users.find(u=>u.user_id===9002).checklists,{given:17,done:12});
    const detail=await get('/scoring/weekly/detail?module=checklists&user_id=9002&week_start=2026-09-28');
    assert.equal(detail.rows.length,17); assert.equal(detail.rows.filter(r=>r.status==='approved').length,12);
    assert.equal(new Set(detail.rows.map(r=>r.id)).size,17);
    const weekly=await get('/scoring/scorecard?user_id=9002&week_start=2026-09-28');
    assert.equal(weekly.kpis[0].actual,12);
    const period=await get('/scoring/scorecard-range?user_id=9002&from=2026-09-21&to=2026-10-03');
    assert.equal(period.kpis[0].planned,33); assert.equal(period.kpis[0].actual,28);
  });
});
