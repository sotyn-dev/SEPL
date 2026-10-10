const {test}=require('node:test');
const assert=require('node:assert/strict');
const {fixture}=require('../vendorTreds/__tests__/fixture');
const {createTask,updateTask,listTasks}=require('../vendorTreds/tasks');
const {scan,schedule}=require('../../scripts/vendorTredsReminderCron');
const {addDocument}=require('../vendorTreds/documents');
const storage=require('../storage');
const user={id:1,role:'admin',scope:{ownerIds:null}};
const task={title:'Verify document expiry',owner_id:2,due_date:'2026-10-08',reminder_at:'2026-10-08T00:15:00',priority:'high'};

test('task reminders normalize IST instants and trigger only after the scheduled time',()=>{
  const db=fixture();try{
    const row=createTask(db,task,user);
    assert.equal(row.reminder_at,'2026-10-07T18:45:00.000Z');
    const messages=[];
    assert.equal(scan(db,'2026-10-07',n=>messages.push(n),{now:'2026-10-07T18:30:00.000Z'}).created,0);
    assert.equal(scan(db,'2026-10-08',n=>messages.push(n),{now:'2026-10-07T19:00:00.000Z'}).created,1);
    assert.equal(scan(db,'2026-10-08',n=>messages.push(n),{now:'2026-10-07T19:00:00.000Z'}).created,0);
    assert.equal(messages.length,1);
    assert.equal(db.prepare('SELECT channel_sent FROM notifications').get().channel_sent,'in_app');
    assert.match(db.prepare('SELECT link_url FROM notifications').get().link_url,/tab=dashboard&sub=tasks&record=\d+$/);
  }finally{db.close();}
});

test('task mutations validate editable values and mismatched client links before writing',()=>{
  const db=fixture();try{
    for(const value of ['bad','2026-02-31T09:00:00','2026-10-08T24:00:00'])assert.throws(()=>createTask(db,{...task,reminder_at:value},user),error=>error.status===400);
    const row=createTask(db,task,user);
    for(const input of [{priority:'super-high'},{title:{}},{title:''},{reminder_at:'not a time'},{customer_id:999}]){
      assert.throws(()=>updateTask(db,row.id,{version:row.version,...input},user),error=>error.status===400);
    }
    assert.equal(db.prepare('SELECT version FROM vt_task_links WHERE id=?').get(row.id).version,row.version);
    db.prepare("INSERT INTO customers(id,customer_code,company_name) VALUES(1,'C-1','Client One'),(2,'C-2','Client Two')").run();
    db.prepare("INSERT INTO vt_registrations(id,customer_id,owner_id,registration_date) VALUES(1,1,2,'2026-10-07')").run();
    assert.throws(()=>createTask(db,{...task,customer_id:2,registration_id:1},user),error=>error.status===400);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM vt_task_links').get().n,1);
    assert.equal(listTasks(db,{page:1.5,limit:1.5},{ownerIds:[2]}).limit,1);
    assert.equal(listTasks(db,{}, {ownerIds:[]}).total,0);
    assert.throws(()=>listTasks(db,{date_from:'2026-02-31'},{ownerIds:[2]}),error=>error.status===400);
    assert.throws(()=>listTasks(db,{owner_id:'bad'},{ownerIds:[2]}),error=>error.status===400);
  }finally{db.close();}
});

test('preview scheduling is disabled and reminders use IST follow-up calendar days',()=>{
  const prior=process.env.NODE_ENV;process.env.NODE_ENV='preview';
  try{assert.equal(schedule(),undefined);}finally{if(prior===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=prior;}
  const db=fixture();try{
    db.prepare("INSERT INTO customers(id,customer_code,company_name) VALUES(1,'C-1','Client One')").run();
    db.prepare("INSERT INTO vt_registrations(id,customer_id,owner_id,registration_date,status,next_followup_at) VALUES(1,1,2,'2026-10-07','approved','2026-10-07T23:00:00.000Z')").run();
    scan(db,'2026-10-07');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE title='Registration follow-up due'").get().n,0);
    scan(db,'2026-10-08');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE title='Registration follow-up due'").get().n,1);
  }finally{db.close();}
});

test('private funding edits do not restart pending-stage reminder ageing',()=>{
  const db=fixture();try{
    const platform=db.prepare("SELECT id FROM vt_catalog WHERE kind='platform' AND code='rxil'").get().id;
    db.exec("INSERT INTO customers(id,customer_code,company_name) VALUES(1,'C-1','Client One'); INSERT INTO role_permissions(role_id,module,can_view) VALUES(1,'bill_discounting',1)");
    db.prepare("INSERT INTO sales_bills(id,bill_number,bill_date,total_amount,created_by) VALUES(1,'Bill-1','2026-10-01',100,2)").run();
    db.prepare("INSERT INTO vt_accounts(id,platform_id,owner_id,status,account_status) VALUES(1,?,2,'active','active')").run(platform);
    db.prepare("INSERT INTO vt_invoices(id,sales_bill_id,customer_id,account_id,platform_id,external_invoice_number,invoice_number_key,invoice_date,amount_paise,owner_id,status,uploaded_at,bid_at) VALUES(1,1,1,1,?,'Bill-1','BILL-1','2026-10-01',10000,2,'bid_received','2026-10-01T00:00:00.000Z','2026-10-02T00:00:00.000Z')").run(platform);
    db.prepare("INSERT INTO vt_funding(invoice_id,principal_paise,owner_id,status,approved_at,updated_at) VALUES(1,10000,2,'funding_approved','2026-10-02T00:00:00.000Z','2026-10-07T10:00:00.000Z')").run();
    scan(db,'2026-10-07');
    assert.equal(db.prepare("SELECT COUNT(*) n FROM notifications WHERE title='Funding pending'").get().n,1);
  }finally{db.close();}
});

test('private documents refuse public remote storage before any object is written',async()=>{
  const original={isRemote:storage.isRemote,putObject:storage.putObject},prior=process.env.S3_PUBLIC_BASE_URL;
  let writes=0;storage.isRemote=true;storage.putObject=async()=>{writes++;throw new Error('Remote storage must never be called');};
  process.env.S3_PUBLIC_BASE_URL='https://public-documents.example.invalid';
  try{
    await assert.rejects(()=>addDocument(null,'registrations',{id:1},{},{originalname:'pan.pdf',buffer:Buffer.from('%PDF-1.4')},user),error=>error.status===503&&/private storage namespace/.test(error.message));
    assert.equal(writes,0);
  }finally{Object.assign(storage,original);if(prior===undefined)delete process.env.S3_PUBLIC_BASE_URL;else process.env.S3_PUBLIC_BASE_URL=prior;}
});
