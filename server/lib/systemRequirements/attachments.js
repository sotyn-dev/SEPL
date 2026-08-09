const path = require('path');
const crypto = require('crypto');
const quarantine = require('../quarantine');
const storage = require('../storage');

const VIDEO_RE = /^video\//i;
const MAX_BYTES = 25 * 1024 * 1024;
/** Single Development-tab files bucket (not per-section). */
const DEV_SECTION = 'development';
const UPLOAD_PREFIX = 'system_requirements/attachments';

function isVideoMime(mime) {
  return !!(mime && VIDEO_RE.test(mime));
}

// Best-effort: move each uploads key to quarantine (reversible; lazy-restored on
// re-serve if a DB revert re-references it). Never throws — attachment cleanup
// must not block the soft-delete response.
function quarantineKeys(keys) {
  for (const k of keys) {
    if (k) { try { quarantine.quarantineKey(k).catch(() => {}); } catch (e) { /* best-effort */ } }
  }
}

async function storeFile({
  buffer,
  originalFilename,
  mimeType,
  requirementId,
  uploadedBy,
  db,
  commentId = null,
  devSection = null,
}) {
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
  if (commentId && devSection) {
    const err = new Error('Attachment cannot be both comment- and development-scoped');
    err.status = 400;
    throw err;
  }
  if (devSection && devSection !== DEV_SECTION) {
    const err = new Error('Invalid development section');
    err.status = 400;
    throw err;
  }

  const ext = path.extname(originalFilename || '').slice(0, 20);
  const stored = `${Date.now()}_${crypto.randomBytes(8).toString('hex')}${ext}`;
  const relativePath = `${UPLOAD_PREFIX}/${stored}`;

  // Goes through the storage seam so local disk and S3 stay interchangeable.
  await storage.putObject({
    key: relativePath,
    body: buffer,
    contentType: mimeType || 'application/octet-stream',
  });

  const info = db.prepare(`
    INSERT INTO sysreq_attachments
      (requirement_id, comment_id, dev_section, original_filename, stored_filename, relative_path, file_size, mime_type, uploaded_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    requirementId,
    commentId || null,
    devSection || null,
    originalFilename || stored,
    stored,
    relativePath,
    buffer.length,
    mimeType || null,
    uploadedBy || null,
  );

  return db.prepare('SELECT * FROM sysreq_attachments WHERE id=?').get(info.lastInsertRowid);
}

// Soft-delete + quarantine. Clears stored_filename / relative_path so the orphan
// sweep's keep-set (which scans every text column) does not rehydrate the file
// back into uploads while the row is still soft-deleted.
function softDeleteAttachment(db, attachmentId, actorId) {
  const row = db.prepare(`
    SELECT * FROM sysreq_attachments WHERE id = ? AND soft_deleted_at IS NULL
  `).get(attachmentId);
  if (!row) return null;

  const key = row.relative_path || (row.stored_filename ? `${UPLOAD_PREFIX}/${row.stored_filename}` : null);
  // Placeholder paths (no file extension) so the orphan sweep's keep-set — which
  // scans every text column — cannot rehydrate this file while soft-deleted.
  // Columns stay NOT NULL; original_filename is kept for history/UI.
  db.prepare(`
    UPDATE sysreq_attachments
       SET soft_deleted_at = CURRENT_TIMESTAMP,
           stored_filename = 'deleted',
           relative_path = 'deleted'
     WHERE id = ? AND soft_deleted_at IS NULL
  `).run(attachmentId);
  if (key) quarantineKeys([key]);
  return { id: attachmentId, deleted_by: actorId, key };
}

// Soft-delete every live attachment on a requirement (or one comment) and quarantine.
function softDeleteAttachmentsFor(db, { requirementId, commentId = null } = {}) {
  let rows;
  if (commentId != null) {
    rows = db.prepare(`
      SELECT id, relative_path, stored_filename FROM sysreq_attachments
      WHERE requirement_id = ? AND comment_id = ? AND soft_deleted_at IS NULL
    `).all(requirementId, commentId);
  } else {
    rows = db.prepare(`
      SELECT id, relative_path, stored_filename FROM sysreq_attachments
      WHERE requirement_id = ? AND soft_deleted_at IS NULL
    `).all(requirementId);
  }
  if (!rows.length) return { count: 0 };

  const keys = [];
  const upd = db.prepare(`
    UPDATE sysreq_attachments
       SET soft_deleted_at = CURRENT_TIMESTAMP,
           stored_filename = 'deleted',
           relative_path = 'deleted'
     WHERE id = ? AND soft_deleted_at IS NULL
  `);
  for (const r of rows) {
    upd.run(r.id);
    keys.push(r.relative_path || (r.stored_filename ? `${UPLOAD_PREFIX}/${r.stored_filename}` : null));
  }
  quarantineKeys(keys);
  return { count: rows.length };
}

module.exports = {
  MAX_BYTES,
  DEV_SECTION,
  UPLOAD_PREFIX,
  isVideoMime,
  storeFile,
  softDeleteAttachment,
  softDeleteAttachmentsFor,
  quarantineKeys,
};
