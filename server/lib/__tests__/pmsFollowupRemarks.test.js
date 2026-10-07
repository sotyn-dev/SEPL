const { test } = require('node:test');
const assert = require('node:assert/strict');
process.env.ERP_DB_PATH = ':memory:';

test('PMS follow-up remarks persist separately from task completion', async t => {
  const {app,db}=require('./fixtures/indentReviewFixture').fixture();
  app.use('/api/pms-tasks',require('../../routes/pmstasks'));
  db.exec(`INSERT INTO pms_tasks(id,title,description,assigned_by,assigned_to,status,proof_url,due_date,reject_reason)
    VALUES(9501,'Sample PMS task','Check site documents',9001,9002,'rejected','/sample-proof.pdf','2026-10-07','More detail required'),
      (9502,'Other task','Confirm dispatch',9001,9002,'pending',NULL,'2026-10-08',NULL);
    INSERT INTO roles(id,name) VALUES(9501,'PMS follow-up viewer');
    INSERT INTO role_permissions(role_id,module,can_view,can_approve) VALUES(9501,'pms_tasks',1,0);
    INSERT INTO user_roles(user_id,role_id) VALUES(9003,9501);`);
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.on('listening',resolve));
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));db.close();});
  const request=async(path,method='GET',body,user=9004)=>{
    const r=await fetch(`http://127.0.0.1:${server.address().port}/api/pms-tasks${path}`,{
      method,headers:{'x-demo-user':String(user),'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),
    });
    return {status:r.status,body:await r.json()};
  };
  const taskBefore=db.prepare('SELECT * FROM pms_tasks WHERE id=9501').get();
  await t.test('admin, assigner and assignee can append remarks with server-owned authorship',async()=>{
    for(const user of [9004,9001,9002]){
      const r=await request('/9501/followup-remarks','POST',{
        remark:`  Follow-up from ${user}\nAwaiting site confirmation.  `,
        user_id:9003,author_name:'Spoofed author',created_at:'1999-01-01',status:'approved',
      },user);
      assert.equal(r.status,201); assert.equal(r.body.user_id,user);
      assert.equal(r.body.author_name,db.prepare('SELECT name FROM users WHERE id=?').get(user).name);
      assert.equal(r.body.remark,`Follow-up from ${user}\nAwaiting site confirmation.`);
      assert.notEqual(r.body.created_at,'1999-01-01');
    }
    assert.deepEqual(db.prepare('SELECT * FROM pms_tasks WHERE id=9501').get(),taskBefore);
  });
  await t.test('history and latest-row summary remain task-specific after reloading',async()=>{
    const history=await request('/9501/followup-remarks');
    assert.equal(history.status,200); assert.equal(history.body.length,3);
    assert.deepEqual(history.body.map(r=>r.user_id),[9002,9001,9004]);
    assert.deepEqual((await request('/9502/followup-remarks')).body,[]);
    const rows=(await request('/?scope=followup')).body;
    const row=rows.find(r=>r.id===9501);
    assert.equal(row.followup_remark,history.body[0].remark);
    assert.equal(row.followup_remark_by,history.body[0].author_name);
    assert.equal(row.followup_remark_count,3); assert.equal(row.can_add_followup_remark,true);
  });
  await t.test('a viewer can read history but cannot change another person’s follow-up',async()=>{
    assert.equal((await request('/9501/followup-remarks','GET',undefined,9003)).status,200);
    assert.equal((await request('/9501/followup-remarks','POST',{remark:'Unauthorized'},9003)).status,403);
    assert.equal((await request('/?scope=followup','GET',undefined,9003)).body.find(r=>r.id===9501).can_add_followup_remark,false);
  });
  await t.test('project CRM owners and PMS approvers can follow up other tasks',async()=>{
    db.prepare("UPDATE pms_tasks SET crm_name='Other' WHERE id=9502").run();
    assert.equal((await request('/9502/followup-remarks','POST',{remark:'CRM follow-up'},9003)).status,201);
    db.prepare('UPDATE pms_tasks SET crm_name=NULL WHERE id=9502').run();
    db.prepare("UPDATE role_permissions SET can_approve=1 WHERE role_id=9501 AND module='pms_tasks'").run();
    assert.equal((await request('/9502/followup-remarks','POST',{remark:'Approver follow-up'},9003)).status,201);
    db.prepare("UPDATE role_permissions SET can_approve=0 WHERE role_id=9501 AND module='pms_tasks'").run();
  });
  await t.test('blank, non-text, oversized and missing-task requests are rejected',async()=>{
    for(const remark of ['', '   ', {text:'Not a string'}, 'x'.repeat(2001)]) {
      assert.equal((await request('/9501/followup-remarks','POST',{remark})).status,400);
    }
    assert.equal((await request('/999999/followup-remarks')).status,404);
    assert.equal((await request('/999999/followup-remarks','POST',{remark:'No task'})).status,404);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pms_followup_remarks WHERE task_id=9501').get().n,3);
  });
  await t.test('history is denied when the user has no task relation or PMS view access',async()=>{
    db.prepare("UPDATE role_permissions SET can_view=0 WHERE role_id=9501 AND module='pms_tasks'").run();
    assert.equal((await request('/9501/followup-remarks','GET',undefined,9003)).status,403);
  });
  await t.test('deleting a task clears only that task’s remarks through the foreign key',async()=>{
    assert.equal((await request('/9502','DELETE')).status,200);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pms_followup_remarks WHERE task_id=9502').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM pms_followup_remarks WHERE task_id=9501').get().n,3);
  });
});
