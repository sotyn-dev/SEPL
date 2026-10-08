const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { rateLimit } = require('../lib/rateLimit');
const storage = require('../lib/storage');
const { DATA_ROOT, ensureDir } = require('../lib/paths');
const { UUID, MAX_FILE, canReadFile, fileUrl, sendShare, fail } = require('../lib/chatShare');

const TYPES = {
  '.pdf':'application/pdf', '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.png':'image/png',
  '.gif':'image/gif', '.webp':'image/webp', '.txt':'text/plain',
  '.doc':'application/msword', '.xls':'application/vnd.ms-excel', '.ppt':'application/vnd.ms-powerpoint',
  '.docx':'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx':'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx':'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
function validateFile(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!TYPES[ext] || !file.size) fail(400, 'Choose a nonempty PDF, image, Office document or TXT file');
  const head = Buffer.alloc(Math.min(4096, file.size));
  const fd = fs.openSync(file.path, 'r');
  try { fs.readSync(fd, head, 0, head.length, 0); } finally { fs.closeSync(fd); }
  const starts = bytes => head.subarray(0, bytes.length).equals(Buffer.from(bytes));
  const valid = ext === '.pdf' ? head.subarray(0,5).toString() === '%PDF-'
    : ['.jpg','.jpeg'].includes(ext) ? starts([255,216,255])
    : ext === '.png' ? starts([137,80,78,71,13,10,26,10])
    : ext === '.gif' ? /^GIF8[79]a/.test(head.toString('ascii',0,6))
    : ext === '.webp' ? head.toString('ascii',0,4) === 'RIFF' && head.toString('ascii',8,12) === 'WEBP'
    : ['.doc','.xls','.ppt'].includes(ext) ? starts([208,207,17,224,161,177,26,225])
    : ['.docx','.xlsx','.pptx'].includes(ext) ? starts([80,75,3,4])
    : !head.includes(0) && !head.subarray(0,2).equals(Buffer.from('MZ'));
  if (!valid) fail(400, 'File content does not match its file type');
  // Binary signatures are format checks, not an antivirus guarantee. Office/PDF
  // files are always downloaded; no server-side document execution or URL fetching.
  return TYPES[ext];
}
const safeName = name => path.basename(name.replace(/\\/g,'/')).replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g,'').slice(-180);

module.exports = function createChatShareRouter({ getChatDb, canAccess, markRead, emitChat,
  fileStorage = storage, uploadDir = path.join(DATA_ROOT, 'chat-private') }) {
  const router = express.Router();
  const limited = rateLimit({ windowMs:60000, max:30, keyFn:req => req.user.id });
  const upload = multer({ storage:multer.diskStorage({
    destination: (req,file,cb) => cb(null,ensureDir(uploadDir)),
    filename: (req,file,cb) => cb(null,`${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
  }), limits:{ fileSize:MAX_FILE, files:1, fields:0, parts:2 },
  fileFilter:(req,file,cb) => cb(TYPES[path.extname(file.originalname).toLowerCase()] ? null : Object.assign(new Error('Unsupported file type'),{status:400}), true),
  }).single('file');
  const errorResponse = (res,error) => res.status(error.status || 500).json({ error:error.status ? error.message : 'Sharing could not finish. Please retry.' });
  async function expireUnused(db) {
    const stale=db.prepare(`SELECT * FROM chat_share_uploads u WHERE created_at < ?
      AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.attachment_url LIKE '/api/site-chat/share/files/' || u.id || '/%') LIMIT 20`).all(Date.now()-86400000);
    // Remove metadata before awaiting I/O; another send can no longer claim an
    // expired upload. Any referenced message (even deleted) preserves its file.
    for(const row of stale) db.prepare('DELETE FROM chat_share_uploads WHERE id=?').run(row.id);
    await Promise.all(stale.map(row=>fileStorage.removeKey(row.storage_key,fileStorage.NS.CHAT_PRIVATE).catch(()=>{})));
  }

  router.post('/uploads/:uploadKey', limited, (req,res) => {
    if (!UUID.test(req.params.uploadKey)) return res.status(400).json({error:'Invalid upload ID'});
    // A publicly readable bucket cannot protect chat attachments. The existing
    // adapter still supports a private S3 bucket or local private storage.
    if (fileStorage.isRemote && (process.env.S3_PUBLIC_BASE_URL || process.env.CHAT_SHARE_PRIVATE_BUCKET !== 'true')) return res.status(503).json({error:'Chat sharing needs verified private file storage. Contact your administrator.'});
    upload(req,res,async error => {
      if (error) return res.status(400).json({error:error.code === 'LIMIT_FILE_SIZE' ? 'Each file must be 20 MB or less' : error.message});
      if (!req.file) return res.status(400).json({error:'Choose a file'});
      let adopted = false;
      try {
        const mime = validateFile(req.file), db = getChatDb();
        await expireUnused(db);
        const digest = crypto.createHash('sha256');
        for await (const chunk of fs.createReadStream(req.file.path)) digest.update(chunk);
        const sha256 = digest.digest('hex');
        const old = db.prepare('SELECT * FROM chat_share_uploads WHERE owner_id=? AND upload_key=?').get(req.user.id,req.params.uploadKey);
        if (old) {
          if (old.sha256 !== sha256 || old.name !== safeName(req.file.originalname)) fail(409,'This upload ID is already used by another file');
          return res.json({id:old.id,name:old.name,size:old.size,mime:old.mime});
        }
        const pending = db.prepare(`SELECT COALESCE(SUM(size),0) size FROM chat_share_uploads u WHERE owner_id=?
          AND NOT EXISTS(SELECT 1 FROM chat_messages m WHERE m.attachment_url LIKE '/api/site-chat/share/files/' || u.id || '/%')`).get(req.user.id).size;
        if (pending + req.file.size > 100*1024*1024) fail(413,'Your pending uploads exceed 100 MB. Discard an unused share first.');
        const row = { id:crypto.randomUUID(), owner_id:req.user.id, upload_key:req.params.uploadKey,
          storage_key:req.file.filename, name:safeName(req.file.originalname), mime, size:req.file.size, sha256, created_at:Date.now() };
        await fileStorage.adoptLocalFile(req.file.path,row.storage_key,mime,fileStorage.NS.CHAT_PRIVATE);
        const saved = db.prepare(`INSERT OR IGNORE INTO chat_share_uploads
          (id,owner_id,upload_key,storage_key,name,mime,size,sha256,created_at)
          VALUES (@id,@owner_id,@upload_key,@storage_key,@name,@mime,@size,@sha256,@created_at)`).run(row);
        if (!saved.changes) {
          await fileStorage.removeKey(row.storage_key,fileStorage.NS.CHAT_PRIVATE);
          const winner = db.prepare('SELECT * FROM chat_share_uploads WHERE owner_id=? AND upload_key=?').get(req.user.id,req.params.uploadKey);
          if (!winner || winner.sha256 !== sha256 || winner.name !== row.name) fail(409,'This upload ID is already used by another file');
          return res.json({id:winner.id,name:winner.name,size:winner.size,mime:winner.mime});
        }
        adopted = true;
        res.json({id:row.id,name:row.name,size:row.size,mime:row.mime});
      } catch (e) { errorResponse(res,e); }
      finally { if (!adopted) { try { fs.unlinkSync(req.file.path); } catch {} } }
    });
  });
  router.get('/files/:id/:name', async (req,res) => {
    try {
      const db = getChatDb();
      const row = db.prepare('SELECT * FROM chat_share_uploads WHERE id=?').get(req.params.id);
      if (!canReadFile(db,req,row,canAccess)) return res.status(404).end();
      const file = await fileStorage.openStream(row.storage_key,fileStorage.NS.CHAT_PRIVATE);
      if (!file) return res.status(404).end();
      res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',
        'Content-Security-Policy':"sandbox; default-src 'none'",'Content-Type':row.mime,
        'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`});
      if (file.size != null) res.set('Content-Length',String(file.size));
      file.stream.on('error',()=>res.destroy());
      res.on('close',()=>file.stream.destroy());
      file.stream.pipe(res);
    } catch(e) { if (!res.headersSent) errorResponse(res,e); }
  });
  router.delete('/uploads/:id', async (req,res) => {
    try {
      const db = getChatDb();
      const row = db.prepare('SELECT * FROM chat_share_uploads WHERE id=? AND owner_id=?').get(req.params.id,req.user.id);
      if (row && !db.prepare('SELECT 1 FROM chat_messages WHERE attachment_url=?').get(fileUrl(row))) {
        db.prepare('DELETE FROM chat_share_uploads WHERE id=?').run(row.id);
        await fileStorage.removeKey(row.storage_key,fileStorage.NS.CHAT_PRIVATE);
      }
      res.json({ok:true});
    } catch(e) { errorResponse(res,e); }
  });
  router.post('/send', limited, (req,res) => {
    try { res.json(sendShare({db:getChatDb(),req,canAccess,markRead,emitChat})); }
    catch(e) { errorResponse(res,e); }
  });
  return router;
};
module.exports.validateFile = validateFile;
