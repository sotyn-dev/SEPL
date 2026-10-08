// Incoming shares use existing chat messages, permissions, reads and notifications.
// These tables contain upload ownership and retry receipts, not another message store.
const crypto = require('crypto');
const PREFIX = '/api/site-chat/share/files/';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
const fail = (status, message) => { throw Object.assign(new Error(message), { status }); };
function ensureSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS chat_share_uploads (
    id TEXT PRIMARY KEY, owner_id INTEGER NOT NULL, upload_key TEXT NOT NULL,
    storage_key TEXT NOT NULL, name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
    sha256 TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE(owner_id,upload_key));
    CREATE TABLE IF NOT EXISTS chat_share_receipts (
    sender_id INTEGER NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
    result_json TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY(sender_id,request_id));`);
}
const fileUrl = row => `${PREFIX}${row.id}/${encodeURIComponent(row.name)}`;
function attachmentId(url) {
  if (typeof url !== 'string') return null;
  // Also recognize absolute same-origin URLs and encoded paths on legacy send APIs.
  try {
    const pathname = decodeURIComponent(new URL(url, 'https://sotyn.invalid').pathname);
    if (!pathname.startsWith(PREFIX)) return null;
    return pathname.slice(PREFIX.length).split('/')[0];
  } catch { return null; }
}
function canReadFile(db, req, row, canAccess) {
  if (!row) return false;
  if (row.owner_id === req.user.id) return true;
  return db.prepare('SELECT DISTINCT group_id FROM chat_messages WHERE attachment_url=? AND deleted_at IS NULL')
    .all(fileUrl(row)).some(m => canAccess(db, req, m.group_id));
}
function guardAttachment(db, req, url, canAccess) {
  const id = attachmentId(url);
  if (!id) return;
  const row = db.prepare('SELECT * FROM chat_share_uploads WHERE id=?').get(id);
  if (!canReadFile(db, req, row, canAccess) || url !== fileUrl(row)) fail(403, 'This chat attachment is not available to you');
}
function sendShare({ db, req, canAccess, markRead, emitChat }) {
  const input = req.body || {};
  if (input.expected_sender_id !== req.user.id) fail(409, 'Your account changed. Sign in with the account that opened this draft.');
  if (!UUID.test(input.request_id || '')) fail(400, 'A valid share request ID is required');
  if (typeof input.text !== 'string' || input.text.length > 16000) fail(400, 'Share text must be 16,000 characters or fewer');
  if (!Array.isArray(input.group_ids) || !input.group_ids.length || input.group_ids.length > 10 ||
      !input.group_ids.every(id => Number.isSafeInteger(id) && id > 0)) fail(400, 'Select up to 10 conversations');
  if (!Array.isArray(input.attachment_ids) || input.attachment_ids.length > 10 ||
      !input.attachment_ids.every(id => typeof id === 'string' && UUID.test(id))) fail(400, 'Select up to 10 supported files');
  const groups = [...new Set(input.group_ids)].sort((a,b) => a-b);
  const ids = [...new Set(input.attachment_ids)];
  const text = input.text.trim();
  if (!text && !ids.length) fail(400, 'There is nothing to send');
  const hash = crypto.createHash('sha256').update(JSON.stringify({ groups, ids, text })).digest('hex');
  const result = db.transaction(() => {
    const old = db.prepare('SELECT * FROM chat_share_receipts WHERE sender_id=? AND request_id=?').get(req.user.id, input.request_id);
    if (old) {
      if (old.payload_hash !== hash) fail(409, 'This request ID was already used for a different share');
      return { ...JSON.parse(old.result_json), replayed: true };
    }
    // Validate EVERY destination before inserting ANY message. No partial sends.
    for (const id of groups) {
      const group = db.prepare('SELECT archived_at FROM chat_groups WHERE id=?').get(id);
      if (!group || !canAccess(db, req, id)) fail(403, 'You can no longer message one of the selected conversations');
      if (group.archived_at) fail(409, 'One of the selected conversations is archived');
    }
    const attachments = ids.map(id => {
      const row = db.prepare('SELECT * FROM chat_share_uploads WHERE id=? AND owner_id=?').get(id, req.user.id);
      if (!row) fail(403, 'A shared file is not owned by your account');
      return row;
    });
    if (attachments.reduce((sum,a) => sum+a.size,0) > MAX_TOTAL) fail(400, 'Shared files must total 50 MB or less');
    const messages = [];
    const insert = db.prepare(`INSERT INTO chat_messages
      (group_id,body,attachment_url,attachment_name,sender_id,sender_name) VALUES (?,?,?,?,?,?)`);
    for (const groupId of groups) {
      for (const [index, file] of (attachments.length ? attachments : [null]).entries()) {
        const info = insert.run(groupId, index === 0 ? text || null : null, file ? fileUrl(file) : null,
          file?.name || null, req.user.id, req.user.name || '');
        const message = db.prepare('SELECT * FROM chat_messages WHERE id=?').get(info.lastInsertRowid);
        markRead(db, groupId, req.user.id, message.id);
        messages.push(message);
      }
    }
    const receipt = { request_id: input.request_id, groups, message_ids: messages.map(m => m.id) };
    db.prepare('INSERT INTO chat_share_receipts VALUES (?,?,?,?,?)')
      .run(req.user.id, input.request_id, hash, JSON.stringify(receipt), Date.now());
    return { ...receipt, messages, replayed: false };
  })();
  // emitChat also invokes existing chat push. A replay never emits duplicates.
  for (const message of result.messages || []) emitChat(message.group_id, 'message', message);
  if (!result.replayed) for (const groupId of result.groups) emitChat(groupId, 'changed', { groupId });
  delete result.messages;
  return result;
}
module.exports = { ensureSchema, sendShare, guardAttachment, canReadFile, fileUrl, UUID, MAX_FILE, MAX_TOTAL, fail };
