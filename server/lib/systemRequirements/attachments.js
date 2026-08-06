const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..', '..', '..', 'data', 'uploads', 'system_requirements', 'attachments');
const VIDEO_RE = /^video\//i;
const MAX_BYTES = 25 * 1024 * 1024;

function ensureDir() {
  if (!fs.existsSync(ROOT)) fs.mkdirSync(ROOT, { recursive: true });
}

function isVideoMime(mime) {
  return !!(mime && VIDEO_RE.test(mime));
}

function storeFile({ buffer, originalFilename, mimeType, requirementId, uploadedBy, db }) {
  if (isVideoMime(mimeType)) {
    const err = new Error('Video uploads are not supported');
    err.status = 400;
    throw err;
  }
  if (buffer.length > MAX_BYTES) {
    const err = new Error('File too large (max 25 MB)');
    err.status = 400;
    throw err;
  }

  ensureDir();
  const ext = path.extname(originalFilename || '').slice(0, 20);
  const stored = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
  const absolute = path.join(ROOT, stored);
  fs.writeFileSync(absolute, buffer);

  const relativePath = path.join('system_requirements', 'attachments', stored).replace(/\\/g, '/');
  const info = db.prepare(`
    INSERT INTO sysreq_attachments
      (requirement_id, original_filename, stored_filename, relative_path, file_size, mime_type, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    requirementId,
    originalFilename || stored,
    stored,
    relativePath,
    buffer.length,
    mimeType || null,
    uploadedBy || null,
  );

  return db.prepare('SELECT * FROM sysreq_attachments WHERE id=?').get(info.lastInsertRowid);
}

function absolutePathFor(row) {
  return path.join(ROOT, row.stored_filename);
}

function softDeleteAttachment(db, attachmentId, actorId) {
  db.prepare(`
    UPDATE sysreq_attachments SET soft_deleted_at = CURRENT_TIMESTAMP WHERE id = ? AND soft_deleted_at IS NULL
  `).run(attachmentId);
  return { id: attachmentId, deleted_by: actorId };
}

module.exports = {
  ROOT,
  MAX_BYTES,
  ensureDir,
  isVideoMime,
  storeFile,
  absolutePathFor,
  softDeleteAttachment,
};
