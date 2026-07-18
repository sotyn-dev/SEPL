// Shared quarantine store for uploaded files — used by both the scoped orphan
// sweep (sweep-uploads.js) and the event-driven cleanup on chat/ticket delete.
//
// A quarantined file is MOVED (not deleted) from UPLOADS_ROOT/<key> to
// QUARANTINE_ROOT/<key> (same relative subpath preserved) and recorded in a
// manifest. It can be restored to its original path, and is only permanently
// purged after a TTL that outlives the DB-backup horizon — so a DB revert that
// re-references a "deleted" file can still recover it.
//
// `key` is the file's path relative to the uploads root, POSIX-style, e.g.
// "site-chat/1699-photo.jpg". A stored URL like "/uploads/site-chat/x.jpg" maps
// to key "site-chat/x.jpg".
const fs = require('fs');
const path = require('path');
const { UPLOADS_ROOT, QUARANTINE_ROOT, ensureDir } = require('./paths');

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

function absUpload(key) { return path.join(UPLOADS_ROOT, ...key.split('/')); }
function absQuar(key) { return path.join(QUARANTINE_ROOT, ...key.split('/')); }

function move(from, to) {
  ensureDir(path.dirname(to));
  try {
    fs.renameSync(from, to);
  } catch (e) {
    // Cross-device or locked — fall back to copy+unlink.
    fs.copyFileSync(from, to);
    fs.unlinkSync(from);
  }
}

// Move a live upload into quarantine. Idempotent-ish: no-op if already gone.
function quarantineKey(key) {
  const k = normalizeKey(key);
  if (!k) return { ok: false, reason: 'invalid' };
  const src = absUpload(k);
  if (!fs.existsSync(src)) return { ok: false, reason: 'missing' };
  const dest = absQuar(k);
  move(src, dest);
  let size = 0; try { size = fs.statSync(dest).size; } catch {}
  const list = loadManifest().filter(e => e.key !== k);
  list.push({ key: k, size, movedAt: new Date().toISOString() });
  saveManifest(list);
  return { ok: true, key: k, size };
}

// Convenience: quarantine by stored URL string.
function quarantineUrl(url) {
  const k = keyFromUrl(url);
  return k ? quarantineKey(k) : { ok: false, reason: 'not-local' };
}

// Restore a quarantined file back to its uploads path. Returns true if restored.
function restoreKey(key) {
  const k = normalizeKey(key);
  if (!k) return false;
  const src = absQuar(k);
  if (!fs.existsSync(src)) {
    // Not physically present — still drop any stale manifest row.
    const list = loadManifest();
    const next = list.filter(e => e.key !== k);
    if (next.length !== list.length) saveManifest(next);
    return false;
  }
  move(src, absUpload(k));
  saveManifest(loadManifest().filter(e => e.key !== k));
  return true;
}

// Is this key currently quarantined (physically present)?
function isQuarantined(key) {
  const k = normalizeKey(key);
  return !!k && fs.existsSync(absQuar(k));
}

// Permanently delete anything older than ttlDays. Returns { purged, bytes }.
function purgeExpired(ttlDays) {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;
  const list = loadManifest();
  const keep = [];
  let purged = 0, bytes = 0;
  for (const e of list) {
    const age = new Date(e.movedAt).getTime();
    if (Number.isFinite(age) && age < cutoff) {
      try { fs.unlinkSync(absQuar(e.key)); } catch {}
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
  isQuarantined, purgeExpired, list, absUpload, absQuar,
};
