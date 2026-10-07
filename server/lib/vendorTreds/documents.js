const crypto=require('crypto');
const storage=require('../storage');
const {fail}=require('./access');
const MAX_BYTES=10*1024*1024;
function fileType(file, invoiceOnly=false) {
  if(!file?.buffer?.length) fail('Choose a document',400);
  if(file.buffer.length>MAX_BYTES) fail('Document must be 10 MB or smaller',400);
  const name=String(file.originalname||'document').replace(/[\x00-\x1f<>:"/\\|?*]/g,'_').slice(0,180);
  const ext=name.split('.').pop().toLowerCase();
  const b=file.buffer;
  const pdf=ext==='pdf'&&b.subarray(0,5).toString()==='%PDF-';
  const png=ext==='png'&&b.length>=8&&b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg=['jpg','jpeg'].includes(ext)&&b[0]===255&&b[1]===216&&b[2]===255;
  if(!(pdf||(!invoiceOnly&&(png||jpeg)))) fail(invoiceOnly?'Invoice must be a PDF':'Choose a PDF, JPG or PNG with matching file content',400);
  return {filename:name,mime:pdf?'application/pdf':png?'image/png':'image/jpeg',ext};
}
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value||'')&&!Number.isNaN(Date.parse(value))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
}
async function addDocument(db,kind,parent,data,file,user,options={}) {
  if(!['registrations','invoices'].includes(kind)) fail('Invalid document parent',400);
  if(storage.isRemote&&String(process.env.S3_PUBLIC_BASE_URL||'').trim())fail('Private documents require a private storage namespace. Upload is unavailable while a public storage base URL is enabled.',503);
  const invoice=kind==='invoices',purpose=String(data.purpose||'invoice');
  if(invoice&&!['invoice','proof'].includes(purpose)) fail('Choose invoice or delivery proof',400);
  const type=fileType(file,invoice&&purpose==='invoice');
  if(data.expiry_date&&!validDate(data.expiry_date)) fail('Use a valid expiry date',400);
  if(!invoice&&!db.prepare("SELECT id FROM vt_catalog WHERE id=? AND kind='doc_type' AND active=1").get(Number(data.type_id))) fail('Choose an active document type',400);
  const key=`vendor-treds/${invoice?'invoices':'registrations'}/${parent.id}/${crypto.randomUUID()}.${type.ext}`;
  await storage.putObject({key,body:file.buffer,contentType:type.mime});
  try {
    return db.transaction(()=>{
      const at=options.now?options.now():new Date().toISOString();
      const table=invoice?'vt_invoice_documents':'vt_documents',parentKey=invoice?'invoice_id':'registration_id';
      const fields=[parentKey,invoice?'purpose':'type_id','storage_key','filename','mime','size_bytes','uploaded_at','expiry_date','status','remarks','created_by','updated_by'];
      const values=[parent.id,invoice?purpose:Number(data.type_id),key,type.filename,type.mime,file.buffer.length,at,data.expiry_date||null,'uploaded',String(data.remarks||'').slice(0,2000),user.id,user.id];
      const id=Number(db.prepare(`INSERT INTO ${table}(${fields.join(',')}) VALUES(${fields.map(()=>'?').join(',')})`).run(...values).lastInsertRowid);
      const record=db.prepare(`SELECT * FROM ${table} WHERE id=?`).get(id);
      let current;
      if(invoice&&purpose==='invoice') {
        current=db.prepare('SELECT * FROM vt_invoices WHERE id=?').get(parent.id);
        if(!current.uploaded_at) {
          const changed=db.prepare(`UPDATE vt_invoices SET uploaded_at=?,version=version+1,updated_by=?,updated_at=?
            WHERE id=? AND version=? AND uploaded_at IS NULL`).run(at,user.id,at,current.id,current.version);
          if(changed.changes!==1)fail('This invoice changed. Refresh before uploading.',409,'VERSION_CONFLICT');
          const uploaded=db.prepare('SELECT * FROM vt_invoices WHERE id=?').get(current.id);
          db.prepare(`INSERT INTO vt_history(entity_type,entity_id,event,old_status,new_status,before_json,after_json,actor_id,changed_at,remarks)
            VALUES('invoices',?,'status',?,'uploaded',?,?,?,?,?)`).run(current.id,current.status,JSON.stringify(current),JSON.stringify(uploaded),user.id,at,'First invoice PDF uploaded');
          current=uploaded;
        }
      }
      db.prepare('INSERT INTO vt_history(entity_type,entity_id,event,after_json,actor_id,changed_at,remarks) VALUES(?,?,?,?,?,?,?)').run(kind,parent.id,'document_uploaded',JSON.stringify({...record,storage_key:undefined}),user.id,at,record.remarks);
      return {...record,storage_key:undefined,parent_type:kind,parent_version:current?.version,download_url:`/vendor-treds/documents/${invoice?'invoice-':''}${id}/download`};
    })();
  } catch(e) { await storage.removeKey(key).catch(()=>{}); throw e; }
}
function documentsFor(db,kind,id) {
  const invoice=kind==='invoices',table=invoice?'vt_invoice_documents':'vt_documents',key=invoice?'invoice_id':'registration_id';
  return db.prepare(`SELECT d.*,${invoice?'NULL':'t.label'} AS type_label FROM ${table} d ${invoice?'':'LEFT JOIN vt_catalog t ON t.id=d.type_id'} WHERE d.${key}=? ORDER BY d.id DESC`).all(id).map(d=>({...d,storage_key:undefined,parent_type:kind,download_url:`/vendor-treds/documents/${invoice?'invoice-':''}${d.id}/download`}));
}
module.exports={MAX_BYTES,fileType,validDate,addDocument,documentsFor};
