// Shared quarantine store for uploaded files — used by both the scoped orphan
// sweep (sweep-uploads.js) and the event-driven cleanup on chat/ticket delete.
//
// A quarantined file is MOVED (not deleted) from the uploads namespace to the
// quarantine namespace (same relative subpath preserved) and recorded in a
// manifest. It can be restored to its original path, and is only permanently
// purged after a TTL that outlives the DB-backup horizon — so a DB revert that
// re-references a "deleted" file can still recover it.
//
// `key` is the file's path relative to the uploads root, POSIX-style, e.g.
// "site-chat/1699-photo.jpg". A stored URL like "/uploads/site-chat/x.jpg" maps
// to key "site-chat/x.jpg".
//
// STORAGE: every byte-moving operation now goes through lib/storage.js, so
// quarantine works unchanged whether files live on local disk or in a bucket.
// That makes the file-touching functions ASYNC — callers must await (or, for the
// best-effort fire-and-forget deletes in routes, attach a .catch()).
//
// The MANIFEST deliberately stays a local JSON file even under the s3 driver.
// It is small, tenant-local bookkeeping (like module-flags.json), it is read and
// written on nearly every sweep step, and keeping it local avoids turning each
// manifest touch into a network round-trip. It is not user data: losing it would
// only strand quarantined files, never live ones.
const fs = require('fs');
const path = require('path');
const { QUARANTINE_ROOT, ensureDir } = require('./paths');
const storage = require('./storage');

const { NS } = storage;
const MANIFEST = path.join(QUARANTINE_ROOT, 'manifest.json');

function loadManifest() {
  try { return JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { return []; }
}
function saveManifest(list) {
  ensureDir(QUARANTINE_ROOT);
  fs.writeFileSync(MANIFEST, JSON.stringify(list, null, 2));
}

// Map a stored value to a uploads-relative key, or null if it isn't a local
// /uploads/ reference we own.
function keyFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^\/?uploads\/(.+)$/);
  if (!m) return null;
  let rel;
  try { rel = decodeURIComponent(m[1]); } catch { rel = m[1]; }
  return normalizeKey(rel);
}

// Normalize + guard against path traversal; returns a safe posix key or null.
function normalizeKey(key) {
  if (typeof key !== 'string' || !key) return null;
  const parts = key.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..')) return null;
  return parts.join('/');
}

// Move a live upload into quarantine. Idempotent-ish: no-op if already gone.
async function quarantineKey(key) {
  const k = normalizeKey(key);
  if (!k) return { ok: false, reason: 'invalid' };
  // Size must be read BEFORE the move — afterwards the source is gone, and on s3
  // a second HeadObject on the destination would be a wasted round-trip.
  const st = await storage.statKey(k, NS.UPLOADS);
  if (!st) return { ok: false, reason: 'missing' };
  const moved = await storage.moveKey(k, k, { fromNs: NS.UPLOADS, toNs: NS.QUARANTINE });
  if (!moved) return { ok: false, reason: 'missing' };
  const size = st.size || 0;
  const list = loadManifest().filter(e => e.key !== k);
  list.push({ key: k, size, movedAt: new Date().toISOString() });
  saveManifest(list);
  return { ok: true, key: k, size };
}

// Convenience: quarantine by stored URL string.
async function quarantineUrl(url) {
  const k = keyFromUrl(url);
  return k ? quarantineKey(k) : { ok: false, reason: 'not-local' };
}

// Restore a quarantined file back to its uploads path. Returns true if restored.
async function restoreKey(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  if (!(await storage.exists(k, NS.QUARANTINE))) {
    // Not physically present — still drop any stale manifest row.
    const list = loadManifest();
    const next = list.filter(e => e.key !== k);
    if (next.length !== list.length) saveManifest(next);
    return false;
  }
  await storage.moveKey(k, k, { fromNs: NS.QUARANTINE, toNs: NS.UPLOADS });
  saveManifest(loadManifest().filter(e => e.key !== k));
  return true;
}

// Is this key currently quarantined (physically present)?
async function isQuarantined(key) {
  const k = normalizeKey(key);
  return !!k && (await storage.exists(k, NS.QUARANTINE));
}

// Permanently delete anything older than ttlDays. Returns { purged, bytes }.
async function purgeExpired(ttlDays) {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const list = loadManifest();
  const keep = [];
  let purged = 0, bytes = 0;
  for (const e of list) {
    const age = new Date(e.movedAt).getTime();
    if (Number.isFinite(age) && age < cutoff) {
      await storage.removeKey(e.key, NS.QUARANTINE);
      purged++; bytes += e.size || 0;
    } else {
      keep.push(e);
    }
  }
  if (keep.length !== list.length) saveManifest(keep);
  return { purged, bytes };
}

function list() { return loadManifest(); }

module.exports = {
  keyFromUrl, normalizeKey, quarantineKey, quarantineUrl, restoreKey,
  isQuarantined, purgeExpired, list,
};
