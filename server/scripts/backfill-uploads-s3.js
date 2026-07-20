// Move LOCAL uploads into the object store, in batches, freeing disk as it goes.
//
// Three callers, one implementation:
//   - the admin button        (POST /api/admin/uploads/migrate)
//   - the nightly job         (scheduleNightlyBackfill, 02:30)
//   - the CLI, over SSH       (node server/scripts/backfill-uploads-s3.js --commit …)
//
// Requires STORAGE_DRIVER=s3 plus the S3_* env vars — the destination is wherever the
// seam points, so there is no second place to configure a bucket.
//
// KEEP-SET DRIVEN, and that is the whole point: only files still REFERENCED by a row in
// some data/*.db are pushed. Years of unreferenced flat-root junk therefore never reaches
// the bucket (that junk is the disk problem, not something to pay to store). It reuses
// buildKeepSet() from the sweep so "referenced" means exactly one thing in this codebase.
//
// SAFETY, in order of importance:
//   1. Nothing is deleted until its remote copy is confirmed present at a matching size.
//   2. A failed upload leaves the local file alone — dual-read keeps serving it and the
//      next run retries. Interrupting this job can lose work, never data.
//   3. runBackfill() NEVER calls process.exit or reads process.argv: it runs inside the
//      long-lived ERP, where either would be a bug. Those live in the CLI wrapper only.
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT } = require('../lib/paths');
const storage = require('../lib/storage');
const { buildKeepSet } = require('./sweep-uploads');

// Files are handled in batches so disk is reclaimed progressively rather than only at the
// very end — which matters when the reason for running this is a nearly-full disk.
const BATCH_SIZE = 50;

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

const absOf = (key) => path.join(UPLOADS_ROOT, ...key.split('/'));
const sizeOf = (abs) => { try { return fs.statSync(abs).size; } catch { return null; } };

// Which referenced files are on local disk but NOT yet in the bucket. Used by the preview
// so the admin page can say whether a run would actually do anything.
async function findStragglers(referenced) {
  const out = [];
  for (const key of referenced) {
    const local = sizeOf(absOf(key));
    if (local === null) continue;
    const st = await storage.statKey(key);
    if (!st || st.size !== local) out.push(key);
  }
  return out;
}

// Returns a SUMMARY. Never throws for a per-file failure, never exits the process.
//   commit=false  -> report only, touch nothing
//   deleteLocal   -> unlink each verified upload (this is what frees disk)
//   onProgress({processed, total}) -> for the admin status endpoint
async function runBackfill({ commit = false, deleteLocal = false, silent = false, onProgress = null, batchSize = BATCH_SIZE } = {}) {
  // The server calls this. Refusing must be a return value, not an exit.
  if (!storage.isRemote) {
    if (!silent) console.log('[backfill] STORAGE_DRIVER is not "s3" — nothing to back-fill into.');
    return { ok: false, skipped: 'driver-not-s3' };
  }

  const keep = buildKeepSet();
  const all = localKeys();
  const referenced = all.filter(k => keep.has(path.posix.basename(k)));
  const skippedUnreferenced = all.length - referenced.length;

  if (!commit) {
    let bytes = 0;
    for (const k of referenced) bytes += sizeOf(absOf(k)) || 0;
    const stragglers = await findStragglers(referenced);
    if (!silent) {
      console.log(`[backfill] DRY-RUN local=${all.length} referenced=${referenced.length} skipped-unreferenced=${skippedUnreferenced} stragglers=${stragglers.length} (${(bytes / 1024 / 1024).toFixed(2)} MB)`);
    }
    return {
      ok: true, dryRun: true, local: all.length, referenced: referenced.length,
      skippedUnreferenced, stragglers: stragglers.length, bytes, uploaded: 0,
      verified: 0, skippedExisting: 0, failed: 0, deletedLocal: 0, freedBytes: 0,
    };
  }

  let uploaded = 0, verified = 0, skippedExisting = 0, failed = 0, deletedLocal = 0, freedBytes = 0;
  const total = referenced.length;
  let processed = 0;

  for (let i = 0; i < referenced.length; i += batchSize) {
    const batch = referenced.slice(i, i + batchSize);
    const done = [];   // {abs, size} verified present remotely — safe to unlink

    for (const key of batch) {
      const abs = absOf(key);
      const size = sizeOf(abs);
      processed++;
      if (size === null) { failed++; continue; }   // vanished under us

      // Already in the bucket at the right size? Don't pay to upload it again. This is
      // what makes a re-run (or an interrupted migration) cheap instead of a full repeat.
      let st = null;
      try { st = await storage.statKey(key); } catch (e) {
        console.error(`[backfill] stat failed ${key}: ${e.message}`);
        failed++; continue;
      }
      if (st && st.size === size) {
        skippedExisting++;
        done.push({ abs, size });
        continue;
      }

      try {
        // Streamed, with an explicit length — these can be tens of MB and this runs
        // unattended on a small box.
        const { PutObjectCommand } = storage._s3.sdk();
        await storage._s3.client().send(new PutObjectCommand({
          Bucket: storage._s3.bucket(),
          Key: storage._s3.remoteKey(storage.NS.UPLOADS, key),
          Body: fs.createReadStream(abs),
          ContentLength: size,
          ContentType: contentType(key),
        }));
        uploaded++;
      } catch (e) {
        console.error(`[backfill] upload failed ${key}: ${e.message}`);
        failed++; continue;
      }

      // VERIFY before the local copy is ever considered expendable.
      let after = null;
      try { after = await storage.statKey(key); } catch { /* treated as unverified */ }
      if (!after || after.size !== size) {
        console.error(`[backfill] verify failed ${key} (remote ${after ? after.size : 'absent'} vs local ${size})`);
        failed++; continue;
      }
      verified++;
      done.push({ abs, size });
    }

    // Free the batch together, so disk drops during the run rather than at the end.
    if (deleteLocal) {
      for (const d of done) {
        try { fs.unlinkSync(d.abs); deletedLocal++; freedBytes += d.size; } catch { /* leave it */ }
      }
    }
    if (onProgress) { try { onProgress({ processed, total }); } catch { /* never let a reporter break the job */ } }
  }

  const summary = {
    ok: true, dryRun: false, local: all.length, referenced: total, skippedUnreferenced,
    uploaded, verified, skippedExisting, failed, deletedLocal, freedBytes,
  };
  if (!silent) {
    console.log(`[backfill] uploaded=${uploaded} verified=${verified} skipped-existing=${skippedExisting} failed=${failed} deleted-local=${deletedLocal} (freed ${(freedBytes / 1024 / 1024).toFixed(2)} MB)`);
    if (failed) console.log('[backfill] some files failed — local copies were KEPT and dual-read still serves them. Re-run to retry.');
  }
  return summary;
}

// Nightly reconciler at 02:30. Deliberately AFTER the 02:00 backup and 02:15 compaction:
// the backup captures the DB rows that reference these files, so the restore point exists
// before anything moves.
//
// Covers every route that still writes to local disk, so those need no code change at all;
// it also picks up stragglers left by an inline push that failed while the bucket was down.
function scheduleNightlyBackfill() {
  // No S3 configured => no job. Return WITHOUT arming a timer; never exit the process.
  if (!storage.isRemote) {
    console.log('[backfill] Scheduler not started: STORAGE_DRIVER is not "s3".');
    return;
  }
  const nextRun = () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 30, 0, 0); // 02:30 today
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    setTimeout(async () => {
      try {
        const r = await runBackfill({ commit: true, deleteLocal: true, silent: true });
        // Stay quiet on a no-op night; say something only when work actually happened.
        if (r.ok && !r.dryRun && (r.uploaded || r.deletedLocal || r.failed)) {
          console.log(`[backfill] nightly: uploaded=${r.uploaded} deleted-local=${r.deletedLocal} failed=${r.failed} (freed ${(r.freedBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
      } catch (e) {
        // A bad night must not kill the chain — log and let it reschedule below.
        console.error('[backfill] Scheduled run failed:', e.message);
      }
      nextRun();
    }, delay);
    console.log(`[backfill] Next scheduled run at ${target.toISOString()} (in ${Math.round(delay / 60000)} min)`);
  };
  nextRun();
}

module.exports = { runBackfill, scheduleNightlyBackfill, BATCH_SIZE };

// ── CLI only ────────────────────────────────────────────────────────────────────
// process.argv and process.exit live HERE and nowhere else, so requiring this module
// from the server can never inherit the server's flags or terminate it.
if (require.main === module) {
  const commit = process.argv.includes('--commit');
  const deleteLocal = process.argv.includes('--delete-local');
  runBackfill({ commit, deleteLocal })
    .then((r) => {
      if (!r.ok && r.skipped) { console.error('[backfill] aborted:', r.skipped); process.exit(1); }
      if (!commit) console.log('[backfill] re-run with --commit to perform the upload.');
      process.exit(r.failed ? 1 : 0);
    })
    .catch((e) => { console.error('[backfill] fatal:', e.message); process.exit(1); });
}
