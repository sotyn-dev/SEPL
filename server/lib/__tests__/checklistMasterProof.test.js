const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('checklist occurrences follow the master proof setting and retain dated notes', async t => {
  const { app, db, setToday } = require('./fixtures/indentReviewFixture').fixture();
  setToday('2026-10-05');
  app.use('/api/hr',require('../../routes/hr'));
  const types = ['none','text','photo','pdf','file'];
  types.forEach((type,i) => db.prepare(`INSERT INTO checklists
    (id,title,description,frequency,assigned_to,proof_type,proof_label,recurrence_start_date,recurrence_end_date,created_at,status)
    VALUES(?,?,?,'daily',9002,?,?,'2026-09-28','2026-10-31','2026-09-28 01:00:00','pending')`)
    .run(9401+i,`Sample ${type}`,`Sample ${type}`,type,type==='text'?'Daily Note':null));
  const server = app.listen(0,'127.0.0.1');
  await new Promise(resolve => server.on('listening',resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); db.close(); });
  const request = async (url,method='GET',body,user=9002) => {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/hr${url}`,{
      method,headers:{'x-demo-user':String(user),'content-type':'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status:r.status,body:await r.json()};
  };
  await t.test('both admin and assignee Follow-up rows contain master proof type and label',async () => {
    for (const user of [9002,9004]) {
      const r = await request('/checklists/followup?back=7&forward=7','GET',undefined,user);
      assert.equal(r.status,200);
      for (const [i,type] of types.entries()) assert.equal(r.body.rows.find(x=>x.id===9401+i).proof_type,type);
      assert.equal(r.body.rows.find(x=>x.id===9402).proof_label,'Daily Note');
    }
  });
  await t.test('no-proof completion needs no file and preserves the requested older date',async () => {
    const r = await request('/checklists/9401/complete','POST',{completion_date:'2026-10-03'});
    assert.equal(r.status,200);
    const saved = db.prepare('SELECT * FROM checklist_completions WHERE checklist_id=9401').get();
    assert.equal(saved.completion_date,'2026-10-03');
    assert.equal(saved.proof_url,null); assert.equal(saved.approval_status,'pending');
    const rows = (await request('/checklists/followup?back=7')).body.rows;
    assert.equal(rows.find(r=>r.id===9401).cells.find(c=>c.date==='2026-10-03').status,'done_pending');
    assert.equal(rows.find(r=>r.id===9401).cells.find(c=>c.date==='2026-10-05').status,'today');
  });
  await t.test('text proof requires a note and remains visible in Follow-up and By Date',async () => {
    assert.equal((await request('/checklists/9402/complete','POST',{notes:'  ',completion_date:'2026-10-03'})).status,400);
    assert.equal((await request('/checklists/9402/complete','POST',{notes:'Confirmed the daily schedule',completion_date:'2026-10-03'})).status,200);
    const follow = (await request('/checklists/followup?back=7')).body.rows.find(r=>r.id===9402);
    assert.equal(follow.cells.find(c=>c.date==='2026-10-03').notes,'Confirmed the daily schedule');
    const dated = (await request('/checklists/by-date?date=2026-10-03')).body.rows.find(r=>r.id===9402);
    assert.equal(dated.notes,'Confirmed the daily schedule'); assert.equal(dated.proof_type,'text');
  });
  await t.test('file proof types still require an attachment',async () => {
    for (let i=2;i<types.length;i++) {
      assert.equal((await request(`/checklists/${9401+i}/complete`,'POST',{})).status,400);
      assert.equal((await request(`/checklists/${9401+i}/complete`,'POST',{proof_url:`/uploads/sample.${types[i]==='photo'?'png':types[i]==='pdf'?'pdf':'docx'}`})).status,200);
    }
  });
  await t.test('master edits apply to existing outstanding occurrences immediately',async () => {
    const r = await request('/checklists/9403','PUT',{
      title:'Sample photo',description:'Sample photo',status:'pending',frequency:'daily',assigned_to:9002,
      due_date:null,due_time:null,proof_type:'none',proof_label:'',recurrence_start_date:'2026-09-28',recurrence_end_date:'2026-10-31',
    },9004);
    assert.equal(r.status,200);
    const task = (await request('/checklists/followup?back=7')).body.rows.find(r=>r.id===9403);
    assert.equal(task.proof_type,'none'); assert.equal(task.proof_label,null);
    assert.equal((await request('/checklists/9403/complete','POST',{completion_date:'2026-10-02'})).status,200);
  });
  await t.test('rejected text proof can be resubmitted on the same date for fresh approval',async () => {
    const row = db.prepare('SELECT id FROM checklist_completions WHERE checklist_id=9402').get();
    assert.equal((await request(`/checklists/completions/${row.id}/decision`,'POST',{status:'rejected',note:'Add details'},9004)).status,200);
    assert.equal((await request('/checklists/9402/complete','POST',{completion_date:'2026-10-03',notes:'Confirmed schedule and notified the team'})).status,200);
    const saved = db.prepare('SELECT * FROM checklist_completions WHERE id=?').get(row.id);
    assert.equal(saved.approval_status,'pending'); assert.equal(saved.approval_note,null);
    assert.equal(saved.completion_date,'2026-10-03'); assert.match(saved.notes,/notified the team/);
  });
});
