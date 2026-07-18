// Scoped orphan-uploads sweep + quarantine.
//
// SAFETY: this only ever looks inside the SWEEP_FOLDERS (site-chat, help-tickets)
// under the uploads root. The flat root and every other feature subdir are NEVER
// scanned, quarantined, or deleted.
//
// A file in a swept folder is an ORPHAN only if its basename is referenced by NO
// row in either DB AND it's older than GRACE_DAYS. Orphans are MOVED to
// quarantine (reversible); quarantined files older than QUARANTINE_TTL_DAYS are
// purged. Before classifying, any quarantined file whose basename is referenced
// again (e.g. after a DB revert) is restored — self-healing.
//
// Runs on-demand (admin endpoint) or: node server/scripts/sweep-uploads.js [--dry-run]

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { UPLOADS_ROOT, DB_PATH, CHAT_DB_PATH, SWEEP_FOLDERS, uploadsSub } = require('../lib/paths');
const quarantine = require('../lib/quarantine');

const GRACE_DAYS = 30;            // don't touch files younger than this (in-flight/abandoned-recent)
const QUARANTINE_TTL_DAYS = 45;   // > 30-day backup horizon, so a DB revert can still recover

const FILE_RE = /[\w.\-]+\.(?:pdf|jpe?g|png|gif|webp|bmp|svg|xlsx?|docx?|pptx?|csv|txt|mp3|mp4|wav|ogg|webm|zip|rar)/gi;

// Pull filename tokens out of one cell value into the keep-set.
function addTokens(v, set) {
  if (typeof v !== 'string' || !v) return;
  const urls = v.match(/\/uploads\/[^\s"']+/g);
  if (urls) for (const u of urls) set.add(path.posix.basename(u.split('?')[0]));
  const files = v.match(FILE_RE);
  if (files) for (const f of files) set.add(f);
}

// Scan every text column of every table in one DB, adding referenced basenames.
function collectRefs(dbPath, set) {
  if (!fs.existsSync(dbPath)) return;
  const db = new Database(dbPath, { readonly: true });
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    for (const t of tables) {
      let cols;
      try { cols = db.prepare(`PRAGMA table_info("${t}")`).all(); } catch { continue; }
      // TEXT-ish columns (declared text/char/clob, or untyped) can hold paths/urls.
      const textCols = cols.filter(c => /char|clob|text/i.test(c.type || '') || (c.type || '') === '').map(c => c.name);
      for (const col of textCols) {
        let rows;
        try { rows = db.prepare(`SELECT DISTINCT "${col}" AS v FROM "${t}" WHERE "${col}" IS NOT NULL`).all(); } catch { continue; }
        for (const r of rows) addTokens(r.v, set);
      }
    }
  } finally { db.close(); }
}

function buildKeepSet() {
  const set = new Set();
  collectRefs(DB_PATH, set);
  collectRefs(CHAT_DB_PATH, set);
  return set;
}

// Recursively list files under a dir as { key (posix, rel to uploads root), mtimeMs }.
function walk(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) { walk(abs, out); continue; }
    if (!e.isFile()) continue;
    const rel = path.relative(UPLOADS_ROOT, abs).split(path.sep).join('/');
    let mtimeMs = 0; try { mtimeMs = fs.statSync(abs).mtimeMs; } catch {}
    out.push({ key: rel, size: (() => { try { return fs.statSync(abs).size; } catch { return 0; } })(), mtimeMs });
  }
  return out;
}

function runSweep({ dryRun = false, silent = false } = {}) {
  const keep = buildKeepSet();

  // 0. Rehydrate — restore any quarantined file whose basename is referenced again.
  let restored = 0;
  for (const e of quarantine.list()) {
    if (keep.has(path.posix.basename(e.key))) {
      if (dryRun) restored++;
      else if (quarantine.restoreKey(e.key)) restored++;
    }
  }

  // 1. Classify orphans — ONLY inside the swept folders.
  const cutoff = Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000;
  let scanned = 0, quarantined = 0, quarantinedBytes = 0;
  const orphans = [];
  for (const folder of SWEEP_FOLDERS) {
    const root = uploadsSub(folder);
    if (!fs.existsSync(root)) continue;
    for (const f of walk(root, [])) {
      scanned++;
      const base = path.posix.basename(f.key);
      if (keep.has(base)) continue;             // referenced anywhere → keep
      if (f.mtimeMs > cutoff) continue;         // too recent → grace window
      orphans.push(f);
    }
  }
  for (const o of orphans) {
    if (dryRun) { quarantined++; quarantinedBytes += o.size; continue; }
    const r = quarantine.quarantineKey(o.key);
    if (r.ok) { quarantined++; quarantinedBytes += r.size || 0; }
  }

  // 2. Purge quarantined files past the TTL.
  let purged = 0, purgedBytes = 0;
  if (dryRun) {
    const cut = Date.now() - QUARANTINE_TTL_DAYS * 24 * 60 * 60 * 1000;
    for (const e of quarantine.list()) {
      const a = new Date(e.movedAt).getTime();
      if (Number.isFinite(a) && a < cut) { purged++; purgedBytes += e.size || 0; }
    }
  } else {
    const r = quarantine.purgeExpired(QUARANTINE_TTL_DAYS);
    purged = r.purged; purgedBytes = r.bytes;
  }

  const summary = { dryRun, referenced: keep.size, scanned, restored, quarantined, quarantinedBytes, purged, purgedBytes };
  if (!silent) {
    console.log(`[sweep]${dryRun ? ' DRY-RUN' : ''} refs=${summary.referenced} scanned=${scanned} restored=${restored} quarantined=${quarantined} (${(quarantinedBytes / 1024 / 1024).toFixed(2)} MB) purged=${purged} (${(purgedBytes / 1024 / 1024).toFixed(2)} MB)`);
  }
  return summary;
}

module.exports = { runSweep, GRACE_DAYS, QUARANTINE_TTL_DAYS };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  runSweep({ dryRun });
  process.exit(0);
}
