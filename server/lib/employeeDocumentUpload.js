// Scoped extension of the existing upload endpoint; other upload consumers are unchanged.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const { getUserPermissions } = require('../middleware/auth');
const { ensureDir, uploadsSub } = require('./paths');
const storage = require('./storage');
const upload = multer({ storage: multer.diskStorage({
  destination: (req, file, cb) => cb(null, ensureDir(uploadsSub('employee-documents'))),
  filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`),
}), limits: { fileSize: 10 * 1024 * 1024, files: 1 }, fileFilter: (req, file, cb) => cb(/\.(pdf|jpe?g|png)$/i.test(file.originalname) ? null : new Error('Choose a PDF, JPG or PNG'), /\.(pdf|jpe?g|png)$/i.test(file.originalname)) }).single('file');
module.exports = function employeeDocumentUpload(req, res, next) {
  if (req.query.purpose !== 'employee-document') return next();
  const permissions = getUserPermissions(req.user.id);
  if (req.user.role !== 'admin' && !(permissions.employees?.can_view && (permissions.employees?.can_edit || permissions.employees?.can_create))) return res.status(403).json({ error: 'Employee document permission required' });
  upload(req, res, async error => {
    if (error) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Document must be 10 MB or smaller' : error.message });
    if (!req.file) return res.status(400).json({ error: 'Choose a document' });
    try {
      const head = Buffer.alloc(8); const fd = fs.openSync(req.file.path, 'r');
      try { fs.readSync(fd, head, 0, 8, 0); } finally { fs.closeSync(fd); }
      const extension = path.extname(req.file.filename);
      const valid = extension === '.pdf' ? head.subarray(0,5).toString() === '%PDF-' : extension === '.png' ? head.equals(Buffer.from([137,80,78,71,13,10,26,10])) : head[0] === 255 && head[1] === 216 && head[2] === 255;
      if (!valid) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'File content must match PDF, JPG or PNG format' }); }
      const url = await storage.adoptLocalFile(req.file.path, `employee-documents/${req.file.filename}`, extension === '.pdf' ? 'application/pdf' : extension === '.png' ? 'image/png' : 'image/jpeg');
      res.json({ url, filename: req.file.originalname, size: req.file.size });
    } catch { if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path); res.status(500).json({ error: 'Document upload failed. Please retry.' }); }
  });
};
