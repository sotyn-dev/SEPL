const {test}=require('node:test');
const assert=require('node:assert/strict');
const express=require('express');
const {fixture}=require('./fixture');
const {createRouter}=require('../../../routes/vendorTreds');
const {scan}=require('../../../scripts/vendorTredsReminderCron');
const storage=require('../../storage');
async function harness(){
  const db=fixture(),files=new Map(),original={putObject:storage.putObject,openStream:storage.openStream,removeKey:storage.removeKey};
  storage.putObject=async({key,body})=>{files.set(key,body);return key;};
  storage.removeKey=async key=>files.delete(key);
  storage.openStream=async key=>files.has(key)?{stream:require('node:stream').Readable.from(files.get(key)),size:files.get(key).length}:null;
  const app=express();app.use(express.json());app.use('/uploads/vendor-treds',(req,res)=>res.status(404).end());
  app.use('/api/vendor-treds',createRouter({dbProvider:()=>db,authenticate:(req,res,next)=>{
    const u=db.prepare('SELECT id,name,role FROM users WHERE id=?').get(Number(req.headers['x-test-user']));
    if(!u)return res.status(401).json({error:'Sign in'});req.user=u;next();
  },auditEvent:()=>{}}));
  app.use((e,req,res,next)=>{res.status(e.status||500).json({error:e.message});});
  const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  const origin=`http://127.0.0.1:${server.address().port}`;
  const request=async(url,{user=1,method='GET',body,form}={})=>{
    const headers={'x-test-user':String(user)};if(body)headers['content-type']='application/json';
    const response=await fetch(origin+'/api/vendor-treds'+url,{method,headers,body:form||body&&JSON.stringify(body)});
    if(response.headers.get('content-type')?.includes('json'))return {status:response.status,data:await response.json(),response};
    return {status:response.status,buffer:Buffer.from(await response.arrayBuffer()),response};
  };
  return {db,files,origin,request,close:async()=>{await new Promise(r=>server.close(r));db.close();Object.assign(storage,original);}};
}
const regData=(name='Client Alpha')=>({company_name:name,website_url:`https://${name.toLowerCase().replaceAll(' ','-')}.example.invalid`,owner_id:2,registration_date:'2026-10-07'});
test('four stages keep one company through documents, portal acceptance and multiple enquiries',async()=>{
  const h=await harness();try{
    const today=require('../kpis').istToday();
    const call=async(url,options={},expected=200)=>{
      const result=await h.request(url,options);
      assert.equal(result.status,expected,`${url}: ${JSON.stringify(result.data)}`);return result.data;
    };
    let reg=await call('/registrations',{method:'POST',body:{company_name:'Four Stage Test Company',contact_person:'Test Contact',phone:'1234567890',owner_id:2,registration_date:today}},201);
    const originalId=reg.id,customerId=reg.customer_id;
    const stage=(action,extra={},expected=200)=>call(`/registrations/${reg.id}/stage`,{method:'POST',body:{version:reg.version,action,...extra}},expected);
    const checkStage=async(number)=>{
      const list=await call(`/registration-stages?workflow_stage=${number}`);
      assert.equal(list.total,1);assert.equal(list.rows[0].id,originalId);assert.equal(list.rows[0].workflow_stage,number);
      assert.deepEqual(list.counts,Object.fromEntries([1,2,3,4].map(n=>[n,n===number?1:0])));
    };
    await checkStage(1);
    assert.equal((await stage('accept_portal',{portal_url:'https://portal.example.invalid',approval_date:today},409)).code,'DOCUMENTS_NOT_SUBMITTED');
    assert.equal((await stage('record_enquiry',{enquiry_date:today,product_service:'Too early'},409)).code,'PORTAL_NOT_ACCEPTED');
    reg=await stage('start_documents');await checkStage(2);
    assert.equal((await stage('submit_documents',{},409)).code,'DOCUMENTS_PENDING');
    const types=(await call('/options')).catalog.filter(type=>type.kind==='doc_type'&&type.required);
    for(const type of types){
      const form=new FormData();form.append('file',new Blob(['%PDF-1.4\nFour-stage isolated fixture'],{type:'application/pdf'}),`${type.code}.pdf`);form.append('type_id',String(type.id));
      await call(`/registrations/${reg.id}/documents`,{method:'POST',form},201);
    }
    reg=await stage('submit_documents');assert(reg.submitted_at);await checkStage(2);
    const submittedVersion=reg.version;
    // A failure inside acceptance rolls back the portal update and approval insert.
    await stage('accept_portal',{portal_url:'https://portal.example.invalid',approval_date:today,remarks:42},400);
    const afterFailure=(await call(`/registrations/${reg.id}`)).record;
    assert.equal(afterFailure.version,submittedVersion);assert.equal(afterFailure.portal_url,null);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM vt_approvals').get().n,0);
    await stage('accept_portal',{approval_date:today},400);
    reg=await stage('accept_portal',{portal_url:'https://portal.example.invalid',portal_login_id:'test-login',approval_date:today});
    assert.equal(reg.status,'approved');assert.equal(reg.owner_name,'Test Owner');await checkStage(3);
    const approval=h.db.prepare('SELECT * FROM vt_approvals').get();assert.equal(approval.status,'approved');assert.equal(approval.vendor_code,null);assert.equal(approval.application_date,today);
    await call(`/registrations/${reg.id}/stage`,{method:'POST',body:{version:submittedVersion,action:'accept_portal',portal_url:'https://portal.example.invalid',approval_date:today}},409);
    const firstEnquiryVersion=reg.version;
    reg=await stage('record_enquiry',{enquiry_date:today,product_service:'Test material requirement',rfq_number:'TEST-RFQ-1',due_date:''});
    assert.equal(reg.customer_id,customerId);await checkStage(4);
    await call(`/registrations/${reg.id}/stage`,{method:'POST',body:{version:firstEnquiryVersion,action:'record_enquiry',enquiry_date:today,product_service:'Duplicate retry'}},409);
    const secondVersion=reg.version;
    reg=await stage('record_enquiry',{enquiry_date:today,product_service:'Second requirement',rfq_number:'TEST-RFQ-2'});
    assert(reg.version>secondVersion);await checkStage(4);
    const list=await call('/registration-stages?workflow_stage=4');assert.equal(list.rows[0].enquiry_count,2);
    const enquiries=await call(`/enquiries?registration_id=${reg.id}`);assert.equal(enquiries.total,2);assert(enquiries.rows.every(e=>e.customer_id===customerId&&e.owner_id===2));
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM customers').get().n,1);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM vt_registrations').get().n,1);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM crm_funnel').get().n,2);
  }finally{await h.close();}
});

test('four-stage counts and mutations respect ownership, filters, permissions and versions',async()=>{
  const h=await harness();try{
    const today=require('../kpis').istToday();
    const create=async(name,owner_id)=>(await h.request('/registrations',{method:'POST',body:{company_name:name,owner_id,registration_date:today}})).data;
    const owned=await create('Owned Stage Company',2),other=await create('Other Stage Company',3);
    const ownList=await h.request('/registration-stages?workflow_stage=1&limit=1',{user:2});assert.equal(ownList.status,200);assert.equal(ownList.data.total,1);assert.deepEqual(ownList.data.counts,{1:1,2:0,3:0,4:0});
    const adminList=await h.request('/registration-stages?workflow_stage=1&limit=1');assert.equal(adminList.data.total,2);assert.equal(adminList.data.rows.length,1);assert.equal(adminList.data.counts[1],2);
    assert.equal((await h.request('/registration-stages?workflow_stage=1&search=Owned')).data.total,1);
    assert.equal((await h.request('/registration-stages?workflow_stage=5')).status,400);
    assert.equal((await h.request('/registration-stages',{user:3})).status,403);
    const mutate=(id,action,user=2,extra={})=>h.request(`/registrations/${id}/stage`,{user,method:'POST',body:{version:1,action,...extra}});
    assert.equal((await mutate(other.id,'start_documents')).status,404);
    assert.equal((await mutate(owned.id,'accept_portal',2,{portal_url:'https://portal.example.invalid',approval_date:today})).status,403);
    assert.equal((await mutate(owned.id,'record_enquiry',2,{enquiry_date:today,product_service:'Test'})).status,403);
    assert.equal((await mutate(owned.id,'start_documents',2,{owner_id:3})).status,400);
    assert.equal((await mutate(owned.id,'start_documents')).status,200);
    assert.equal((await mutate(owned.id,'start_documents')).status,409);
    const result=await h.request('/registration-stages?workflow_stage=2',{user:4});assert.equal(result.data.total,1);assert.deepEqual(result.data.counts,{1:0,2:1,3:0,4:0});
    assert.equal((await h.request('/registration-stages?owner_id=3',{user:2})).data.total,0);
  }finally{await h.close();}
});

test('merged permissions apply consistently to list/detail/edit and finance stays scoped',async()=>{
  const h=await harness();try{
    const created=await h.request('/registrations',{user:2,method:'POST',body:regData()});assert.equal(created.status,201,JSON.stringify(created.data));
    const id=created.data.id;
    const detail=await h.request(`/registrations/${id}`,{user:2});assert.equal(detail.status,200);assert.equal(detail.data.record.company_name,'Client Alpha');assert(detail.data.history.length);
    const edited=await h.request(`/registrations/${id}`,{user:2,method:'PATCH',body:{version:1,remarks:'Recorded follow-up'}});assert.equal(edited.status,200);
    const stale=await h.request(`/registrations/${id}`,{user:2,method:'PATCH',body:{version:1,remarks:'Stale edit'}});assert.equal(stale.status,409);
    const other=await h.request('/registrations',{method:'POST',body:{...regData('Client Beta'),owner_id:3}});assert.equal(other.status,201);
    assert.equal((await h.request(`/registrations/${other.data.id}`,{user:2})).status,404);
    assert.equal((await h.request('/registrations',{user:2})).data.total,1);
    assert.equal((await h.request('/registrations',{user:4})).data.total,1);
    const dash=await h.request('/dashboard?date_from=2026-10-05&date_to=2026-10-10',{user:2});assert.equal(dash.status,200,JSON.stringify(dash.data));
    assert(dash.data.cards.every(c=>!['invoice_value','amount_funded','invoices_uploaded'].includes(c.key)));
    assert.equal((await h.request('/funding',{user:2})).status,403);
    assert.equal((await h.request('/registrations?sort=DROP%20TABLE%20users',{user:2})).status,400);
  }finally{await h.close();}
});
test('document upload and preview enforce record ownership, file content and protected storage',async()=>{
  const h=await harness();try{
    const reg=(await h.request('/registrations',{method:'POST',body:regData()})).data;
    const type=h.db.prepare("SELECT id FROM vt_catalog WHERE code='pan'").get().id;
    const form=()=>{const f=new FormData();f.append('file',new Blob(['%PDF-1.4\nTest-only document'],{type:'application/pdf'}),'fixture.pdf');f.append('type_id',String(type));return f;};
    assert.equal((await h.request(`/registrations/${reg.id}/documents`,{user:3,method:'POST',form:form()})).status,403);
    const upload=await h.request(`/registrations/${reg.id}/documents`,{user:2,method:'POST',form:form()});assert.equal(upload.status,201,JSON.stringify(upload.data));assert(!upload.data.storage_key);
    assert.equal((await fetch(h.origin+'/uploads/vendor-treds/known.pdf')).status,404);
    const download=await h.request(upload.data.download_url.replace('/vendor-treds',''),{user:2});assert.equal(download.status,200);assert(download.buffer.toString().startsWith('%PDF-'));assert.equal(download.response.headers.get('cache-control'),'private, no-store');
    assert.equal((await h.request(upload.data.download_url.replace('/vendor-treds',''),{user:0})).status,401);
    const bad=new FormData();bad.append('file',new Blob(['html']), 'bad.pdf');bad.append('type_id',String(type));
    assert.equal((await h.request(`/registrations/${reg.id}/documents`,{user:2,method:'POST',form:bad})).status,400);
    const started=(await h.request(`/registrations/${reg.id}/status`,{user:2,method:'POST',body:{status:'started',version:reg.version}})).data;
    assert.equal((await h.request(`/registrations/${reg.id}/status`,{user:2,method:'POST',body:{status:'submitted',version:started.version}})).status,409);
    assert.equal(h.files.size,1);
  }finally{await h.close();}
});
test('one combined registration file covers selected types with separate reviews and private downloads',async()=>{
  const h=await harness();try{
    let reg=(await h.request('/registrations',{method:'POST',body:regData()})).data;
    const ids=['pan','gst'].map(code=>h.db.prepare('SELECT id FROM vt_catalog WHERE code=?').get(code).id);
    const form=()=>{const f=new FormData();f.append('file',new Blob(['%PDF-1.4\nCombined synthetic PAN and GST'],{type:'application/pdf'}),'combined.pdf');f.append('type_ids',JSON.stringify([...ids,ids[0]]));f.append('expiry_date','2099-12-31');f.append('remarks','Combined registration pack');return f;};
    const other=(await h.request('/registrations',{method:'POST',body:{...regData('Other Company'),owner_id:3}})).data;
    assert.equal((await h.request(`/registrations/${other.id}/documents`,{user:2,method:'POST',form:form()})).status,404);
    assert.equal(h.files.size,0);
    const upload=await h.request(`/registrations/${reg.id}/documents`,{user:2,method:'POST',form:form()});
    assert.equal(upload.status,201,JSON.stringify(upload.data));assert.equal(upload.data.documents.length,2);
    assert.deepEqual(upload.data.documents.map(d=>d.type_id),ids,'Duplicate selections create only one entry per type');
    assert.equal(h.files.size,1,'Only one physical file is stored');
    assert.equal(h.db.prepare('SELECT COUNT(DISTINCT storage_key) n FROM vt_documents').get().n,1);
    for(const document of upload.data.documents){
      assert.equal(document.registration_id,reg.id);assert.equal(document.expiry_date,'2099-12-31');assert.equal(document.remarks,'Combined registration pack');assert(!document.storage_key);
      const download=await h.request(document.download_url.replace('/vendor-treds',''),{user:2});assert.equal(download.status,200);assert.equal(download.buffer.toString(),'%PDF-1.4\nCombined synthetic PAN and GST');
      assert.equal((await h.request(document.download_url.replace('/vendor-treds',''),{user:0})).status,401);
    }
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM vt_history WHERE event='document_uploaded'").get().n,2);
    reg=(await h.request(`/registrations/${reg.id}/stage`,{user:2,method:'POST',body:{version:reg.version,action:'start_documents'}})).data;
    const submitted=await h.request(`/registrations/${reg.id}/stage`,{user:2,method:'POST',body:{version:reg.version,action:'submit_documents'}});
    assert.equal(submitted.status,200,JSON.stringify(submitted.data));
    const pan=upload.data.documents[0],gst=upload.data.documents[1];
    assert.equal((await h.request(`/documents/${pan.id}`,{method:'PATCH',body:{version:pan.version,status:'rejected',remarks:'PAN page needs replacement'}})).status,200);
    const detail=await h.request(`/registrations/${reg.id}`);
    assert.equal(detail.data.documents.find(d=>d.id===pan.id).status,'rejected');
    assert.equal(detail.data.documents.find(d=>d.id===gst.id).status,'uploaded','Reviewing PAN leaves GST unchanged');
  }finally{await h.close();}
});

test('combined uploads reject invalid selections before storage and roll back every link on failure',async()=>{
  const h=await harness();try{
    const reg=(await h.request('/registrations',{method:'POST',body:regData()})).data;
    const ids=['pan','gst'].map(code=>h.db.prepare('SELECT id FROM vt_catalog WHERE code=?').get(code).id);
    const form=(types,extra={})=>{const f=new FormData();f.append('file',new Blob(['%PDF-1.4\nSynthetic batch'],{type:'application/pdf'}),'combined.pdf');f.append('type_ids',typeof types==='string'?types:JSON.stringify(types));for(const [key,value] of Object.entries(extra))f.append(key,value);return f;};
    const send=f=>h.request(`/registrations/${reg.id}/documents`,{user:2,method:'POST',form:f});
    for(const invalid of [[],[ids[0],999999],[ids[0],true],'{invalid',String(ids[0]),Array(101).fill(ids[0])]){
      const result=await send(form(invalid));assert.equal(result.status,400,JSON.stringify(result.data));
    }
    assert.equal((await send(form(ids,{type_id:String(ids[0])}))).status,400);
    h.db.prepare('UPDATE vt_catalog SET active=0 WHERE id=?').run(ids[1]);
    assert.equal((await send(form(ids))).status,400);assert.equal(h.files.size,0);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM vt_documents').get().n,0);
    h.db.prepare('UPDATE vt_catalog SET active=1 WHERE id=?').run(ids[1]);
    h.db.exec(`CREATE TRIGGER fail_second_document BEFORE INSERT ON vt_documents WHEN NEW.type_id=${ids[1]} BEGIN SELECT RAISE(ABORT,'Synthetic insert failure'); END;`);
    assert.equal((await send(form(ids))).status,500);
    assert.equal(h.files.size,0,'Failed transaction removes the unreferenced file');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM vt_documents').get().n,0,'No partial checklist entries');
    assert.equal(h.db.prepare("SELECT COUNT(*) n FROM vt_history WHERE event='document_uploaded'").get().n,0);
  }finally{await h.close();}
});

test('task adapter reuses PMS without fabricating a schedule and reminders persist once',async()=>{
  const h=await harness();try{
    const create=await h.request('/tasks',{method:'POST',body:{title:'Review vendor documents',owner_id:2,due_date:'2026-10-07',reminder_at:'2026-10-07T09:00:00',priority:'high'}});
    assert.equal(create.status,201,JSON.stringify(create.data));assert.equal(h.db.prepare('SELECT COUNT(*) n FROM pms_tasks').get().n,1);assert.equal(h.db.prepare('SELECT COUNT(*) n FROM daily_work_plans').get().n,0);
    const detail=await h.request(`/tasks/${create.data.id}`);assert.equal(detail.status,200);assert.equal(detail.data.record.status,'not_started');
    assert.equal(scan(h.db,'2026-10-07').created,1);assert.equal(scan(h.db,'2026-10-07').created,0);
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM notifications').get().n,1);
    const done=await h.request(`/tasks/${create.data.id}/status`,{method:'POST',body:{version:create.data.version,status:'completed',remarks:'Reviewed'}});assert.equal(done.status,200);assert(done.data.completed_at);
    assert.equal((await h.request('/tasks?status=completed')).data.total,1);
  }finally{await h.close();}
});
test('all report routes export true XLSX with filters and historical settings cannot be replaced',async()=>{
  const h=await harness();try{
    await h.request('/registrations',{method:'POST',body:regData()});
    const report=await h.request('/reports/weekly_registrations?date_from=2026-10-05&date_to=2026-10-10');assert.equal(report.status,200);assert.equal(report.data.total,1);
    const xlsx=await h.request('/reports/weekly_registrations/export?date_from=2026-10-05&date_to=2026-10-10');assert.equal(xlsx.status,200,JSON.stringify(xlsx.data));assert.equal(xlsx.buffer.subarray(0,2).toString(),'PK');
    const save=await h.request('/settings',{method:'PATCH',body:{effective_from:new Date(Date.now()+19800000).toISOString().slice(0,10),program_start_date:'2026-10-05',responsible_owner_ids:[2]}});assert.equal(save.status,200,JSON.stringify(save.data));
    assert.equal((await h.request('/settings',{method:'PATCH',body:{effective_from:save.data.versions.at(-1).effective_from}})).status,409);
    const settings=await h.request('/settings');assert.equal(settings.data.versions.length,2);
    assert.deepEqual(settings.data.owner_names,[{id:2,name:'Test Owner'}]);
    const nextEffective=new Date(Date.now()+19800000+86400000).toISOString().slice(0,10);
    for(const responsible_owner_ids of [[999999],'2']){
      const invalid=await h.request('/settings',{method:'PATCH',body:{effective_from:nextEffective,responsible_owner_ids}});
      assert.equal(invalid.status,400,JSON.stringify(invalid.data));
    }
    const invalidOverride=await h.request('/settings',{method:'PATCH',body:{effective_from:nextEffective,owner_overrides:{999999:{registrations_daily:1}}}});
    assert.equal(invalidOverride.status,400);assert.equal((await h.request('/settings')).data.versions.length,2,'Invalid owners do not append versions');
    const catalog=await h.request('/catalog?kind=platform');assert.equal(catalog.status,200,JSON.stringify(catalog.data));assert.equal(catalog.data.total,4);
  }finally{await h.close();}
});

test('complete API journey preserves invoice identity, dashboard cohorts and client receivables through funding',async()=>{
  const h=await harness();try{
    const today=require('../kpis').istToday();
    const call=async(url,options={},expected=200)=>{
      const response=await h.request(url,options);
      assert.equal(response.status,expected,`${options.method||'GET'} ${url}: ${JSON.stringify(response.data)}`);
      return response.data;
    };
    const create=(kind,body)=>call(`/${kind}`,{method:'POST',body},201);
    const detail=async(kind,id)=>(await call(`/${kind}/${id}`)).record;
    const move=async(kind,id,status,extra={})=>{
      const current=await detail(kind,id);
      return call(`/${kind}/${id}/status`,{method:'POST',body:{version:current.version,status,remarks:`Synthetic journey: ${status}`,...extra}});
    };
    const dashboard=()=>call(`/dashboard?${new URLSearchParams({as_of:today,date_from:today,date_to:today})}`);
    const findMetric=(data,key)=>{
      const metric=[...data.cards,...data.weekly_kpis,...data.funding_metrics].find(row=>row.key===key);
      assert(metric,`Dashboard includes ${key}`);return metric;
    };
    const assertMetric=async(data,key,value,ids,amountField)=>{
      const metric=findMetric(data,key);assert.equal(metric.value,value,key);
      const cohort=await call(`/${metric.drilldown.entity}?${new URLSearchParams({...metric.drilldown.filters,limit:100})}`);
      assert.equal(cohort.total,ids.length,`${key} drilldown count`);
      assert.deepEqual(cohort.rows.map(row=>row.id).sort((a,b)=>a-b),[...ids].sort((a,b)=>a-b),`${key} exact cohort`);
      if(amountField)assert.equal(cohort.rows.reduce((sum,row)=>sum+row[amountField],0),value,`${key} matches listed money`);
    };
    const upload=async(kind,id,fields,name)=>{
      const form=new FormData();form.append('file',new Blob(['%PDF-1.4\nSynthetic isolated journey fixture'],{type:'application/pdf'}),name);
      for(const [key,value] of Object.entries(fields))form.append(key,String(value));
      return call(`/${kind}/${id}/documents`,{method:'POST',form},201);
    };

    const issuer=Number(h.db.prepare('INSERT INTO vendors(vendor_code,name) VALUES(?,?)').run('TEST-ISSUER','Synthetic Invoice Issuer').lastInsertRowid);
    let reg=await create('registrations',{...regData('Synthetic Journey Client'),registration_date:today,vendor_id:issuer,pan:'ABCDE1234F',gst_number:'27ABCDE1234F1Z5'});
    const client=reg.customer_id;
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM customers').get().n,1);
    let dash=await dashboard();
    await assertMetric(dash,'registrations_today',1,[reg.id]);
    await assertMetric(dash,'documents_pending',1,[reg.id]);
    reg=await move('registrations',reg.id,'started');
    const missing=await h.request(`/registrations/${reg.id}/status`,{method:'POST',body:{version:reg.version,status:'submitted',remarks:'Documents are still missing'}});
    assert.equal(missing.status,409);assert.equal(missing.data.code,'DOCUMENTS_PENDING');
    reg=await move('registrations',reg.id,'docs_pending');
    const types=(await call('/options')).catalog.filter(row=>row.kind==='doc_type'&&row.required);
    assert(types.length>0,'Fixture has required registration document types');
    for(const type of types){
      const document=await upload('registrations',reg.id,{type_id:type.id,expiry_date:'2099-12-31',remarks:`Synthetic ${type.label}`},`${type.code}.pdf`);
      await call(`/documents/${document.id}`,{method:'PATCH',body:{status:'verified',version:document.version,remarks:'Checked synthetic document'}});
    }
    reg=await move('registrations',reg.id,'submitted');assert(reg.submitted_at);
    dash=await dashboard();await assertMetric(dash,'documents_pending',0,[]);

    let approval=await create('approvals',{registration_id:reg.id,application_date:today,owner_id:2});
    const noCode=await h.request(`/approvals/${approval.id}/status`,{method:'POST',body:{version:approval.version,status:'approved',remarks:'Missing client vendor code'}});
    assert.equal(noCode.status,400);assert.equal(noCode.data.code,'VENDOR_CODE_REQUIRED');
    approval=await call(`/approvals/${approval.id}`,{method:'PATCH',body:{version:approval.version,vendor_code:'CLIENT-TEST-42',valid_until:'2099-12-31'}});
    await move('approvals',approval.id,'approved');
    reg=await detail('registrations',reg.id);assert.equal(reg.status,'approved');
    dash=await dashboard();await assertMetric(dash,'approved_vendor_codes',1,[reg.id]);

    let enquiry=await create('enquiries',{registration_id:reg.id,customer_id:client,enquiry_date:today,owner_id:2,rfq_number:'RFQ-JOURNEY-1',product_service:'Synthetic supply',expected_amount_paise:3500000,is_mnc:1});
    assert(h.db.prepare('SELECT id FROM crm_funnel WHERE id=?').get(enquiry.crm_funnel_id),'Enquiry reuses the canonical CRM funnel');
    dash=await dashboard();await assertMetric(dash,'enquiries',1,[enquiry.id]);await assertMetric(dash,'mnc_enquiries_weekly',1,[enquiry.id]);
    enquiry=await move('enquiries',enquiry.id,'quote_preparing');
    const noQuote=await h.request(`/enquiries/${enquiry.id}/status`,{method:'POST',body:{version:enquiry.version,status:'quote_sent',remarks:'No ERP quotation exists'}});
    assert.equal(noQuote.status,409);assert.equal(noQuote.data.code,'QUOTATION_REQUIRED');
    // These are synthetic canonical ERP records, representing the existing
    // quotation/order workflow; every Vendor & TReDS operation uses HTTP.
    const quote=Number(h.db.prepare("INSERT INTO quotations(quotation_number,crm_funnel_id,total_amount,final_amount,status,created_by) VALUES(?,?,?,?,?,?)").run('QUOTE-JOURNEY-1',enquiry.crm_funnel_id,35000,35000,'sent',1).lastInsertRowid);
    enquiry=await move('enquiries',enquiry.id,'quote_sent');
    assert.equal((await detail('registrations',reg.id)).status,'quote_sent');
    const noPo=await h.request(`/enquiries/${enquiry.id}/status`,{method:'POST',body:{version:enquiry.version,status:'po_received',remarks:'No received client PO exists'}});
    assert.equal(noPo.status,409);assert.equal(noPo.data.code,'PO_REQUIRED');
    const order=Number(h.db.prepare('INSERT INTO business_book(client_name,company_name,customer_code,po_number,po_date,po_amount,created_by) VALUES(?,?,?,?,?,?,?)').run('Synthetic Journey Client','Synthetic Journey Client',h.db.prepare('SELECT customer_code FROM customers WHERE id=?').get(client).customer_code,'PO-JOURNEY-1',today,35000,1).lastInsertRowid);
    h.db.prepare("UPDATE quotations SET status='accepted',business_book_id=? WHERE id=?").run(order,quote);
    const po=Number(h.db.prepare('INSERT INTO purchase_orders(business_book_id,quotation_id,po_number,po_date,total_amount,created_by) VALUES(?,?,?,?,?,?)').run(order,quote,'PO-JOURNEY-1',today,35000,1).lastInsertRowid);
    await move('enquiries',enquiry.id,'po_received');
    assert.equal((await detail('registrations',reg.id)).status,'po_received');
    const conversion=await call(`/reports/po_conversion?${new URLSearchParams({date_from:today,date_to:today})}`);
    assert.equal(conversion.total,1);assert.equal(conversion.rows[0].id,enquiry.id);

    const platform=(await call('/options')).catalog.find(row=>row.kind==='platform'&&row.code==='rxil').id;
    let account=await create('accounts',{platform_id:platform,vendor_id:issuer,registration_date:today,owner_id:2,login_id:'synthetic-fixture-login'});
    for(const status of ['registration_started','pending_verification','active'])account=await move('accounts',account.id,status);
    const contact=await create('contacts',{customer_id:client,kind:'ap',name:'Synthetic AP Contact',email:'ap@example.invalid',owner_id:2});
    const mapping=await create('mappings',{customer_id:client,platform_id:platform,account_id:account.id,contact_id:contact.id,acceptance_confirmed:1,turnover_over_250cr:1,owner_id:2});
    await create('followups',{mapping_id:mapping.id,owner_id:2,notes:'AP confirmed platform acceptance in this synthetic test',contact_at:new Date().toISOString()});
    dash=await dashboard();
    const platformMetric=dash.platforms.find(row=>row.id===platform);assert.equal(platformMetric.total,1);assert.equal(platformMetric.active,1);
    const active=await call(`/accounts?${new URLSearchParams(platformMetric.drilldowns.active.filters)}`);assert.equal(active.total,1);assert.equal(active.rows[0].id,account.id);
    assert.equal(findMetric(dash,'ap_contacts').value,1);

    const invoiceBody={customer_id:client,vendor_id:issuer,registration_id:reg.id,account_id:account.id,platform_id:platform,invoice_date:today,owner_id:2,po_number:'PO-JOURNEY-1'};
    let invoiceOne=await create('invoices',{...invoiceBody,external_invoice_number:'INV-JOURNEY-1',amount_paise:1000000});
    const existingBill=Number(h.db.prepare('INSERT INTO sales_bills(po_id,bill_number,bill_date,amount,gst_amount,total_amount,customer_name,payment_status,created_by) VALUES(?,?,?,?,?,?,?,?,?)').run(po,'INV-JOURNEY-2',today,25000,0,25000,'Synthetic Journey Client','pending',1).lastInsertRowid);
    const invoiceTwo=await create('invoices',{...invoiceBody,sales_bill_id:existingBill,external_invoice_number:'INV-JOURNEY-2',amount_paise:2500000});
    assert.notEqual(invoiceOne.id,invoiceTwo.id);assert.notEqual(invoiceOne.sales_bill_id,invoiceTwo.sales_bill_id);assert.equal(invoiceTwo.sales_bill_id,existingBill);
    for(const invoice of [invoiceOne,invoiceTwo]){
      for(const purpose of ['invoice','proof']){
        const document=await upload('invoices',invoice.id,{purpose,remarks:'Synthetic invoice evidence'},`${invoice.external_invoice_number}-${purpose}.pdf`);
        const download=await h.request(document.download_url.replace('/vendor-treds',''));
        assert.equal(download.status,200);assert(download.buffer.toString().startsWith('%PDF-'));
      }
      const evidence=await call(`/invoices/${invoice.id}`);assert.deepEqual(evidence.documents.map(row=>row.purpose).sort(),['invoice','proof']);
    }
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM sales_bills').get().n,2,'Canonical invoice reuse creates no duplicate bill');
    const arIds=[invoiceOne,invoiceTwo].map(invoice=>Number(h.db.prepare('INSERT INTO receivables(client_name,invoice_number,invoice_date,invoice_amount,received_amount,outstanding_amount,owner_id) VALUES(?,?,?,?,?,?,?)').run('Synthetic Journey Client',invoice.external_invoice_number,today,invoice.amount_paise/100,0,invoice.amount_paise/100,2).lastInsertRowid));
    const arBefore=arIds.map(id=>h.db.prepare('SELECT * FROM receivables WHERE id=?').get(id));
    dash=await dashboard();
    await assertMetric(dash,'invoices_uploaded',2,[invoiceOne.id,invoiceTwo.id]);
    await assertMetric(dash,'invoice_value_paise',3500000,[invoiceOne.id,invoiceTwo.id],'amount_paise');
    await assertMetric(dash,'pending_value_paise',3500000,[invoiceOne.id,invoiceTwo.id],'amount_paise');

    let funding=await create('funding',{invoice_id:invoiceOne.id,owner_id:2,principal_paise:1000000,discount_rate:1,basis:'flat',fees_paise:1000,taxes_paise:180});
    assert.equal(funding.expected_net_paise,988820);assert.equal(funding.actual_received_paise,null);
    invoiceOne=await move('invoices',invoiceOne.id,'accepted');
    funding=await detail('funding',funding.id);assert.equal(funding.status,'client_accepted');assert(invoiceOne.accepted_at);
    dash=await dashboard();await assertMetric(dash,'accepted_value_paise',1000000,[invoiceOne.id],'amount_paise');
    invoiceOne=await move('invoices',invoiceOne.id,'bid_received');
    funding=await detail('funding',funding.id);assert.equal(funding.status,'bid_received');assert(invoiceOne.bid_at);
    dash=await dashboard();await assertMetric(dash,'bid_value_paise',1000000,[invoiceOne.id],'amount_paise');
    funding=await move('funding',funding.id,'funding_approved');assert(funding.approved_at);
    dash=await dashboard();await assertMetric(dash,'actual_received_paise',0,[]);
    funding=await call(`/funding/${funding.id}`,{method:'PATCH',body:{version:funding.version,actual_received_paise:988820,bank_reference:'BANK-JOURNEY-1',remarks:'Actual synthetic financier credit recorded'}});
    funding=await move('funding',funding.id,'funded');assert(funding.funded_at);
    assert.equal((await detail('invoices',invoiceOne.id)).status,'funded');
    dash=await dashboard();
    await assertMetric(dash,'amount_funded_paise',988820,[funding.id],'actual_received_paise');
    await assertMetric(dash,'actual_received_paise',988820,[funding.id],'actual_received_paise');
    await assertMetric(dash,'financed_principal_paise',1000000,[funding.id],'principal_paise');
    await assertMetric(dash,'pending_value_paise',2500000,[invoiceTwo.id],'amount_paise');
    const noCredit=await h.request(`/funding/${funding.id}/status`,{method:'POST',body:{version:funding.version,status:'reconciled',remarks:'Missing bank evidence'}});
    assert.equal(noCredit.status,400);assert.equal(noCredit.data.code,'RECEIPT_REQUIRED');
    const bank=Number(h.db.prepare('INSERT INTO bank_transactions(txn_date,ref_no,credit,debit) VALUES(?,?,?,?)').run(today,'BANK-JOURNEY-1',9888.2,0).lastInsertRowid);
    funding=await call(`/funding/${funding.id}`,{method:'PATCH',body:{version:funding.version,bank_transaction_id:bank,remarks:'Attached the real stored synthetic bank credit'}});
    funding=await move('funding',funding.id,'reconciled');funding=await move('funding',funding.id,'closed');
    assert(funding.approved_at<=funding.funded_at&&funding.funded_at<=funding.reconciled_at&&funding.reconciled_at<=funding.closed_at);
    const final=await call(`/funding/${funding.id}`);assert.equal(final.record.status,'closed');
    for(const status of ['funding_approved','funded','reconciled','closed'])assert(final.history.some(row=>row.new_status===status),`Immutable history includes ${status}`);
    dash=await dashboard();await assertMetric(dash,'amount_funded_paise',988820,[funding.id],'actual_received_paise');
    const qualified=await call(`/dashboard?${new URLSearchParams({date_from:today,date_to:today,status_entity:'funding',status:'closed',source:'manual'})}`);
    await assertMetric(qualified,'amount_funded_paise',988820,[funding.id],'actual_received_paise');
    await assertMetric(qualified,'invoices_uploaded',2,[invoiceOne.id,invoiceTwo.id]);
    const tracker=findMetric(qualified,'tracker_same_day_percent');
    assert.equal(tracker.drilldown.filters.status_entity,'funding');assert.equal(tracker.drilldown.filters.status,'closed');
    const history=await call(`/history?${new URLSearchParams({...tracker.drilldown.filters,limit:100})}`);
    assert.equal(history.total,tracker.eligible,'Qualified tracker history replays its dashboard denominator');
    assert.equal(history.rows.reduce((sum,row)=>sum+row.same_day,0),tracker.same_day,'Qualified tracker numerator matches history');
    const legacy=await call(`/dashboard?${new URLSearchParams({date_from:today,date_to:today,status:'funded'})}`);
    assert.equal(findMetric(legacy,'invoices_uploaded').value,1,'Legacy status remains valid only for compatible workflows');
    assert.deepEqual(arIds.map(id=>h.db.prepare('SELECT * FROM receivables WHERE id=?').get(id)),arBefore,'Financier credit never mutates client AR');
    for(const invoice of [invoiceOne,invoiceTwo])assert.equal(h.db.prepare('SELECT payment_status FROM sales_bills WHERE id=?').get(invoice.sales_bill_id).payment_status,'pending');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM collections').get().n,0,'Funding creates no client collection');
    assert.deepEqual(h.db.prepare('SELECT matched_type,matched_id FROM bank_transactions WHERE id=?').get(bank),{matched_type:'vt_funding',matched_id:funding.id},'Financier credit is reserved against double matching');
    assert.deepEqual(h.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await h.close();}
});

test('unassigned client identities redact tax details and reject master overwrites while permitting missing-field enrichment',async()=>{
  const h=await harness();try{
    // A populated canonical client with no assigned registration belongs to
    // another team's master-data scope until a new assignment is created.
    const customer=Number(h.db.prepare('INSERT INTO customers(customer_code,company_name,website_url,website_domain,pan,gst_number) VALUES(?,?,?,?,?,?)').run('TEST-PROTECTED','Protected Client','https://protected-client.example.invalid','protected-client.example.invalid','ABCDE1234F','27ABCDE1234F1Z5').lastInsertRowid);
    const profile=await h.request(`/customers/${customer}/profile`,{user:2});assert.equal(profile.status,200);
    assert.equal(profile.data.company_name,'Protected Client');assert.equal(profile.data.website_url,'https://protected-client.example.invalid');
    assert(!Object.hasOwn(profile.data,'pan'));assert(!Object.hasOwn(profile.data,'gst_number'));
    const overwrite=await h.request('/registrations',{user:2,method:'POST',body:{customer_id:customer,company_name:'Overwritten Client',website_url:profile.data.website_url,owner_id:2,registration_date:'2026-10-07'}});
    assert.equal(overwrite.status,403);assert.equal(h.db.prepare('SELECT company_name FROM customers WHERE id=?').get(customer).company_name,'Protected Client');
    assert.equal(h.db.prepare('SELECT COUNT(*) n FROM vt_registrations WHERE customer_id=?').get(customer).n,0,'Denied create rolls back completely');
    const duplicate=await h.request('/registrations',{user:2,method:'POST',body:{...regData('Different Client Spelling'),pan:'ABCDE1234F'}});
    assert.equal(duplicate.status,409);assert.equal(duplicate.data.code,'POSSIBLE_DUPLICATE_VENDOR');assert(duplicate.data.candidates.length>0);
    for(const candidate of duplicate.data.candidates){assert(!Object.hasOwn(candidate,'pan'));assert(!Object.hasOwn(candidate,'gst_number'));}
    assert(!JSON.stringify(duplicate.data.candidates).includes('ABCDE1234F'));
    const enriched=await h.request('/registrations',{user:2,method:'POST',body:{customer_id:customer,company_name:profile.data.company_name,website_url:profile.data.website_url,owner_id:2,registration_date:'2026-10-07',phone:'9000000000'}});
    assert.equal(enriched.status,201,JSON.stringify(enriched.data));
    const saved=h.db.prepare('SELECT company_name,pan,gst_number,contact_no FROM customers WHERE id=?').get(customer);
    assert.deepEqual(saved,{company_name:'Protected Client',pan:'ABCDE1234F',gst_number:'27ABCDE1234F1Z5',contact_no:'9000000000'});
  }finally{await h.close();}
});
