// One-time migration: copy existing LOCAL uploads into the object store.
//
//   node server/scripts/backfill-uploads-s3.js              # dry run (default)
//   node server/scripts/backfill-uploads-s3.js --commit     # actually upload
//   node server/scripts/backfill-uploads-s3.js --commit --delete-local
//
// Requires STORAGE_DRIVER=s3 plus the S3_* env vars — the destination is wherever the
// seam points, so there is no second place to configure a bucket.
//
// KEEP-SET DRIVEN, and that is the whole point: only files still REFERENCED by a row in
// some data/*.db are pushed. Years of unreferenced flat-root junk therefore never reaches
// the bucket (that junk is the disk problem, not something to pay to store). It reuses
// buildKeepSet() from the sweep so "referenced" means exactly one thing in this codebase.
//
// SAFE BY DEFAULT: local files are KEPT unless --delete-local is passed. Until they are
// removed, the /uploads dual-read fallback serves anything not yet in the bucket, so the
// cutover has no window where a file is unreachable. Verify, then delete in a second pass.
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../lib/paths');
const storage = require('../lib/storage');
const { buildKeepSet } = require('./sweep-uploads');

const COMMIT = process.argv.includes('--commit');
const DELETE_LOCAL = process.argv.includes('--delete-local');

// Walk the LOCAL uploads tree directly rather than via storage.listKeys — under the s3
// driver listKeys would enumerate the BUCKET, which is exactly the wrong side here.
function localKeys(dir = UPLOADS_ROOT, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { localKeys(abs, out); continue; }
    if (!e.isFile()) continue;
    out.push(path.relative(UPLOADS_ROOT, abs).split(path.sep).join('/'));
  }
  return out;
}

const CONTENT_TYPES = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.jfif': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.heic': 'image/heic', '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.zip': 'application/zip',
};
const contentType = (key) => CONTENT_TYPES[path.extname(key).toLowerCase()] || 'application/octet-stream';

async function main() {
  if (!storage.isRemote) {
    console.error('[backfill] STORAGE_DRIVER is not "s3" — nothing to back-fill into. Aborting.');
    process.exit(1);
  }

  const keep = buildKeepSet();
  const all = localKeys();
  const referenced = all.filter(k => keep.has(path.posix.basename(k)));
  const skipped = all.length - referenced.length;

  console.log(`[backfill]${COMMIT ? '' : ' DRY-RUN'} local=${all.length} referenced=${referenced.length} skipped-unreferenced=${skipped}`);
  if (!COMMIT) {
    let bytes = 0;
    for (const k of referenced) { try { bytes += fs.statSync(path.join(UPLOADS_ROOT, ...k.split('/'))).size; } catch {} }
    console.log(`[backfill] would upload ${referenced.length} files (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log('[backfill] re-run with --commit to perform the upload.');
    return;
  }

  let uploaded = 0, verified = 0, failed = 0, deleted = 0, bytes = 0;
  for (const key of referenced) {
    const abs = path.join(UPLOADS_ROOT, ...key.split('/'));
    let body;
    try { body = fs.readFileSync(abs); } catch { failed++; continue; }
    try {
      await storage.putObject({ key, body, contentType: contentType(key) });
      uploaded++;
    } catch (e) {
      console.error(`[backfill] upload failed ${key}: ${e.message}`);
      failed++; continue;
    }
    // Verify the object is really there BEFORE considering the local copy expendable.
    const st = await storage.statKey(key);
    if (!st || st.size !== body.length) {
      console.error(`[backfill] verify failed ${key} (remote size ${st ? st.size : 'absent'} vs local ${body.length})`);
      failed++; continue;
    }
    verified++; bytes += body.length;
    if (DELETE_LOCAL) { try { fs.unlinkSync(abs); deleted++; } catch {} }
  }

  console.log(`[backfill] uploaded=${uploaded} verified=${verified} failed=${failed} deleted-local=${deleted} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
  if (failed) console.log('[backfill] some files failed — local copies were KEPT and dual-read still serves them. Re-run to retry.');
}

module.exports = { main };

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error('[backfill] fatal:', e.message); process.exit(1); });
}
