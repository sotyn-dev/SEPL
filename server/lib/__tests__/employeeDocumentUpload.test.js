const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const express = require('express');
const fs = require('fs');

test('employee document upload validates permission, format, content and 10 MB limit', async () => {
  const original = Module._load;
  let adopted = 0;
  Module._load = function(name, parent, ...rest) {
    if (parent?.filename.endsWith('employeeDocumentUpload.js')) {
      if (name === '../middleware/auth') return { getUserPermissions: () => ({}) };
      if (name === './storage') return { adoptLocalFile: async (file,key) => { adopted++; assert.ok(fs.existsSync(file)); fs.unlinkSync(file); return `/uploads/${key}`; } };
    }
    return original.call(this,name,parent,...rest);
  };
  let handler; try { handler = require('../employeeDocumentUpload'); } finally { Module._load = original; }
  const app = express(); app.post('/upload',(req,res,next)=>{req.user={id:1,role:req.headers['x-role'] || 'admin'};next();},handler);
  const server = app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const send = async (name,bytes,role='admin') => {
    const form = new FormData(); form.append('file',new Blob([bytes]),name);
    return fetch(`http://127.0.0.1:${server.address().port}/upload?purpose=employee-document`,{method:'POST',headers:{'x-role':role},body:form});
  };
  try {
    assert.equal((await send('document.pdf','%PDF-1.4\n','user')).status,403);
    assert.equal((await send('document.exe','invalid')).status,400);
    assert.equal((await send('document.pdf','<script>invalid</script>')).status,400);
    assert.equal((await send('document.pdf',Buffer.alloc(10*1024*1024+1))).status,400);
    const result=await send('document.pdf','%PDF-1.4\n%%EOF');
    assert.equal(result.status,200); const data=await result.json();
    assert.match(data.url,/^\/uploads\/employee-documents\/.+\.pdf$/); assert.equal(data.filename,'document.pdf'); assert.equal(adopted,1);
  } finally { await new Promise(resolve=>server.close(resolve)); }
});
