// Storage seam — makes uploaded FILES driver-agnostic so moving to object storage
// (Cloudflare R2 / S3) is a config flip rather than a code change.
//
// STORAGE_DRIVER=local (default) behaves exactly as the app always has: files under
// data/uploads/. STORAGE_DRIVER=s3 puts them in a bucket instead. Nothing else in the
// app changes — DB rows keep storing "/uploads/<key>" under BOTH drivers, because
// publicUrl() always returns that shape and the /uploads route resolves it. That is
// what makes the switch reversible.
//
// A `key` is always uploads-relative, POSIX style: "site-chat/1699-photo.jpg", or
// "1699-file.pdf" for the flat root. Never an absolute path, never with a leading slash.
//
// Two namespaces exist, mirroring the two local roots:
//   NS.UPLOADS    — live files          (local: UPLOADS_ROOT,    s3: <prefix>uploads/)
//   NS.QUARANTINE — soft-deleted files  (local: QUARANTINE_ROOT, s3: <prefix>quarantine/)
//
// NOTE this module only READS and WRITES. It never decides what to delete — the orphan
// sweep owns that, and its scope is deliberately narrower (see sweep-uploads.js).
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT, QUARANTINE_ROOT, ensureDir } = require('./paths');

const NS = { UPLOADS: 'uploads', QUARANTINE: 'quarantine' };

const DRIVER = (process.env.STORAGE_DRIVER || 'local').toLowerCase();
const isRemote = DRIVER === 's3';

// THE decoupling point for multi-tenant. Today one org, one prefix from env. If tenant
// orchestration ever lands, this single function resolves the prefix per request and
// every verb below follows — no other code moves.
function keyPrefix() {
  const p = process.env.S3_KEY_PREFIX || '';
  if (!p) return '';
  return p.endsWith('/') ? p : `${p}/`;
}

// Guard every key before it reaches a driver. Mirrors quarantine.normalizeKey so the two
// can never disagree about what a valid key is — a traversal that slipped past here would
// escape the uploads root on local, and poison the bucket namespace on s3.
function safeKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const parts = key.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null;
  return parts.join('/');
}

const localRoot = (ns) => (ns === NS.QUARANTINE ? QUARANTINE_ROOT : UPLOADS_ROOT);
const localPath = (ns, key) => path.join(localRoot(ns), ...key.split('/'));
const remoteKey = (ns, key) => `${keyPrefix()}${ns}/${key}`;

// ── s3 client (lazy) ────────────────────────────────────────────────────────────
// The AWS SDK is deliberately NOT a package.json dependency. This whole phase is about
// reclaiming disk on a RAM/disk-constrained VPS, so shipping ~20 MB of SDK to every
// install for a feature that is OFF by default would work against the goal. Enabling s3
// is a two-step opt-in: `npm i @aws-sdk/client-s3` + STORAGE_DRIVER=s3.
//
// EVERY SDK access goes through this one loader, because the verbs below call sdk() to
// grab a command class BEFORE they call s3() — putting the friendly error only in s3()
// would let a bare MODULE_NOT_FOUND escape first.
function sdk() {
  try {
    return require('@aws-sdk/client-s3');
  } catch (e) {
    // Reached via STORAGE_DRIVER=s3 OR BACKUP_S3=true, so name both rather than
    // sending someone to check the one setting they didn't change.
    throw new Error(
      'The AWS SDK is not installed (required by STORAGE_DRIVER=s3 or BACKUP_S3=true). '
      + 'Run: npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
    );
  }
}

let _s3 = null;
function s3() {
  if (_s3) return _s3;
  const { S3Client } = sdk();
  _s3 = new S3Client({
    region: process.env.S3_REGION || 'auto',        // R2 wants "auto"
    endpoint: process.env.S3_ENDPOINT || undefined,
    forcePathStyle: true,                            // MinIO + R2 friendly
    credentials: {
      accessKeyId: process.env.S3_ACCESS_KEY_ID,
      secretAccessKey: process.env.S3_SECRET_ACCESS_KEY,
    },
  });
  return _s3;
}
const bucket = () => process.env.S3_BUCKET;

const streamToBuffer = (stream) => new Promise((resolve, reject) => {
  const chunks = [];
  stream.on('data', c => chunks.push(c));
  stream.on('end', () => resolve(Buffer.concat(chunks)));
  stream.on('error', reject);
});

// ── verbs ───────────────────────────────────────────────────────────────────────

async function putObject({ key, body, contentType, ns = NS.UPLOADS }) {
  const k = safeKey(key);
  if (!k) throw new Error('Invalid storage key');
  if (!isRemote) {
    const abs = localPath(ns, k);
    ensureDir(path.dirname(abs));
    fs.writeFileSync(abs, body);
    return k;
  }
  const { PutObjectCommand } = sdk();
  await s3().send(new PutObjectCommand({
    Bucket: bucket(), Key: remoteKey(ns, k), Body: body,
    ContentType: contentType || 'application/octet-stream',
  }));
  return k;
}

// Size + mtime for one key, or null when absent. The sweep and quarantine both need the
// size (to report reclaimed bytes), and on s3 that costs a HeadObject either way — so
// exists() is defined in terms of this rather than duplicating the round-trip.
async function statKey(key, ns = NS.UPLOADS) {
  const k = safeKey(key);
  if (!k) return null;
  if (!isRemote) {
    try {
      const st = fs.statSync(localPath(ns, k));
      return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
    } catch { return null; }
  }
  const { HeadObjectCommand } = sdk();
  try {
    const r = await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: remoteKey(ns, k) }));
    return { size: r.ContentLength || 0, mtimeMs: r.LastModified ? new Date(r.LastModified).getTime() : 0 };
  } catch (e) {
    // ONLY a genuine 404 means "absent". Any other failure (credentials, DNS, timeout,
    // throttling) must propagate: silently reporting "not there" would tell the sweep
    // every file is an orphan, and would make restoreKey drop live manifest rows. A
    // loud failure is always recoverable; a silent wrong answer deletes data.
    // A 404 is only trustworthy once the bucket itself is known to exist — see above.
    if (isNotFound(e)) { await assertBucketExists(); return null; }
    throw e;
  }
}

const isNotFound = (e) =>
  e && (e.name === 'NotFound' || e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404);

// HeadObject sends an EMPTY body on error, so the SDK cannot parse a code and reports a
// bare "NotFound"/404 for BOTH a missing key and a missing/misnamed bucket. Verified
// against MinIO — the two are genuinely indistinguishable from the error alone.
//
// That ambiguity is dangerous: a typo'd S3_BUCKET would make every file look absent, and
// restoreKey would then drop every live manifest row. So prove the bucket exists ONCE per
// process; after that a NotFound really does mean the key is gone. Only the positive
// result is cached, so a genuine outage keeps failing loudly instead of latching.
// Cache the NAME that was verified, not a bare boolean — otherwise a changed S3_BUCKET
// would inherit the previous bucket's clean bill of health.
let _bucketOk = null;
async function assertBucketExists() {
  const b = bucket();
  if (_bucketOk === b) return;
  const { HeadBucketCommand } = sdk();
  try {
    await s3().send(new HeadBucketCommand({ Bucket: b }));
    _bucketOk = b;
  } catch (e) {
    throw new Error(
      `S3 bucket "${b}" is not reachable (${e.name || e.message}). `
      + 'Refusing to report files as missing — check S3_BUCKET and credentials.'
    );
  }
}

async function exists(key, ns = NS.UPLOADS) {
  return (await statKey(key, ns)) !== null;
}

// Returns a Buffer, or null when absent. Buffer (not a stream) because callers either
// pipe it straight to a response or write it to disk, and uploads are capped at 20 MB.
async function getObject(key, ns = NS.UPLOADS) {
  const k = safeKey(key);
  if (!k) return null;
  if (!isRemote) {
    const abs = localPath(ns, k);
    return fs.existsSync(abs) ? fs.readFileSync(abs) : null;
  }
  const { GetObjectCommand } = sdk();
  try {
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: remoteKey(ns, k) }));
    return await streamToBuffer(r.Body);
  } catch (e) {
    // null here means "serve the local copy instead" (the /uploads dual-read fallback),
    // so unlike statKey it is safe — and desirable — to swallow transient errors too.
    if (!isNotFound(e)) console.warn(`[storage] read failed for ${k}: ${e.message}`);
    return null;
  }
}

// ALWAYS "/uploads/<key>" regardless of driver — this is what gets stored in the DB, so
// it must never encode where the bytes actually live. Changing this would strand every
// existing row.
function publicUrl(key) {
  const k = safeKey(key);
  return k ? `/uploads/${k}` : null;
}

// Take a file multer has already streamed to local disk and put it where the driver wants it.
//
// This is how uploads reach S3 *inline* without ever buffering a whole file in RAM:
// multer.diskStorage streams the request to disk (flat memory), then this streams that
// file up and unlinks it. memoryStorage would have been the obvious route to inline S3
// and is exactly the wrong one on a 1-2 GB box.
//
// Returns "/uploads/<key>" either way, so callers store the same DB value on both drivers.
//
// NEVER throws for a storage failure. If the bucket is unreachable the local file is left
// in place and the URL is still returned: the /uploads resolver serves it from disk via
// dual-read, and the migration job (or the nightly) moves it later. A hiccup in the bucket
// must not fail a user's upload or lose their file.
async function adoptLocalFile(absPath, key, contentType) {
  const k = safeKey(key);
  if (!k) throw new Error('Invalid storage key');
  // Local driver: multer already wrote it to its final home. Nothing to do.
  if (!isRemote) return publicUrl(k);

  let size = 0;
  try { size = fs.statSync(absPath).size; } catch { return publicUrl(k); }

  try {
    const { PutObjectCommand } = sdk();
    await s3().send(new PutObjectCommand({
      Bucket: bucket(), Key: remoteKey(NS.UPLOADS, k),
      Body: fs.createReadStream(absPath),
      ContentLength: size,
      ContentType: contentType || 'application/octet-stream',
    }));
    // Verify before the local copy is treated as expendable.
    const st = await statKey(k, NS.UPLOADS);
    if (!st || st.size !== size) {
      console.warn(`[storage] adopt verify failed for ${k} — keeping local copy`);
      return publicUrl(k);
    }
    try { fs.unlinkSync(absPath); } catch { /* keeping it is harmless */ }
  } catch (e) {
    console.warn(`[storage] adopt failed for ${k} (kept on local disk): ${e.message}`);
  }
  return publicUrl(k);
}

// Open a readable stream for a key, or null when absent.
//
// Streamed rather than buffered because callers pipe straight to an HTTP response and
// some of these files are 30 MB drawings with no bound on concurrent viewers — getObject's
// Buffer would be N x 30 MB of heap.
//
// Mirrors the /uploads resolver's dual-read: on the s3 driver a bucket miss falls back to
// the local file, so anything not yet migrated keeps serving.
async function openStream(key, ns = NS.UPLOADS) {
  const k = safeKey(key);
  if (!k) return null;

  const localOpen = () => {
    const abs = localPath(ns, k);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return null;
      return { stream: fs.createReadStream(abs), size: st.size };
    } catch { return null; }
  };

  if (!isRemote) return localOpen();

  try {
    const { GetObjectCommand } = sdk();
    const r = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: remoteKey(ns, k) }));
    return { stream: r.Body, size: typeof r.ContentLength === 'number' ? r.ContentLength : undefined };
  } catch (e) {
    if (!isNotFound(e)) console.warn(`[storage] stream failed for ${k}: ${e.message}`);
    return localOpen();   // dual-read
  }
}

async function removeKey(key, ns = NS.UPLOADS) {
  const k = safeKey(key);
  if (!k) return false;
  if (!isRemote) {
    const abs = localPath(ns, k);
    try { fs.unlinkSync(abs); return true; } catch { return false; }
  }
  const { DeleteObjectCommand } = sdk();
  try {
    await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: remoteKey(ns, k) }));
    return true;
  } catch { return false; }
}

// Move within or across namespaces — the operation quarantine/restore is built on.
// Local uses rename (atomic, instant) with a copy+unlink fallback for cross-device or
// locked files, matching what quarantine.js did before the seam. S3 has no move, so it
// is copy-then-delete; the delete is only reached if the copy succeeded, so a failure
// leaves the source intact rather than losing the file.
async function moveKey(fromKey, toKey, { fromNs = NS.UPLOADS, toNs = NS.QUARANTINE } = {}) {
  const a = safeKey(fromKey), b = safeKey(toKey);
  if (!a || !b) throw new Error('Invalid storage key');
  if (!isRemote) {
    const src = localPath(fromNs, a), dst = localPath(toNs, b);
    if (!fs.existsSync(src)) return false;
    ensureDir(path.dirname(dst));
    try {
      fs.renameSync(src, dst);
    } catch {
      fs.copyFileSync(src, dst);
      fs.unlinkSync(src);
    }
    return true;
  }
  const { CopyObjectCommand } = sdk();
  try {
    await s3().send(new CopyObjectCommand({
      Bucket: bucket(),
      CopySource: `${bucket()}/${remoteKey(fromNs, a)}`,
      Key: remoteKey(toNs, b),
    }));
  } catch { return false; }

  // The copy landed, so the destination is authoritative from here. If removing the
  // source fails the object briefly exists in BOTH namespaces — a genuine duplicate, so
  // say so loudly rather than returning success silently.
  //
  // It still returns TRUE: the file really is at the destination, and reporting failure
  // would be worse than the duplicate. quarantineKey treats false as "nothing moved" and
  // skips its manifest write, which would leave a quarantined object no longer tracked by
  // the manifest — unrestorable and never purged. A stale source copy is the lesser evil,
  // and the next sweep/migration reconciles it.
  const removed = await removeKey(a, fromNs);
  if (!removed) {
    console.warn(`[storage] moveKey: copied to ${toNs}/${b} but could not remove ${fromNs}/${a} — both copies exist until the next reconcile`);
  }
  return true;
}

// List uploads-relative keys under a prefix ("site-chat/" or "" for everything), each
// with mtimeMs so the sweep can apply its grace period. Returns [] for a missing prefix.
async function listKeys(prefix = '', ns = NS.UPLOADS) {
  const p = prefix ? (safeKey(prefix) || '') : '';
  if (!isRemote) {
    const base = localRoot(ns);
    const start = p ? path.join(base, ...p.split('/')) : base;
    const out = [];
    (function walk(dir) {
      let entries;
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) { walk(abs); continue; }
        let st; try { st = fs.statSync(abs); } catch { continue; }
        out.push({ key: path.relative(base, abs).split(path.sep).join('/'), mtimeMs: st.mtimeMs, size: st.size });
      }
    })(start);
    return out;
  }
  // ListObjectsV2 caps at 1000 per call — page until the bucket says it's done, or a
  // large folder would silently look half-empty to the sweep.
  const { ListObjectsV2Command } = sdk();
  const full = `${keyPrefix()}${ns}/`;
  const out = [];
  let token;
  do {
    const r = await s3().send(new ListObjectsV2Command({
      Bucket: bucket(), Prefix: `${full}${p}`, ContinuationToken: token,
    }));
    for (const o of r.Contents || []) {
      out.push({ key: o.Key.slice(full.length), mtimeMs: o.LastModified ? new Date(o.LastModified).getTime() : 0, size: o.Size });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

module.exports = {
  NS, DRIVER, isRemote, keyPrefix, safeKey,
  putObject, getObject, exists, statKey, publicUrl, removeKey, moveKey, listKeys,
  adoptLocalFile, openStream,
  // exposed for the backup push (5c), which writes outside the uploads namespace
  _s3: { client: s3, bucket, sdk, remoteKey },
};
