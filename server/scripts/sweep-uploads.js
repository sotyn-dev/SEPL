// Scoped orphan-uploads sweep + quarantine.
//
// SAFETY: this only ever looks inside the SWEEP_FOLDERS (site-chat, help-tickets)
// under the uploads root. The flat root and every other feature subdir are NEVER
// scanned, quarantined, or deleted.
//
// A file in a swept folder is an ORPHAN only if its basename is referenced by NO
// row in ANY DB under data/ AND it's older than GRACE_DAYS. Orphans are MOVED to
// quarantine (reversible); quarantined files older than QUARANTINE_TTL_DAYS are
// purged. Before classifying, any quarantined file whose basename is referenced
// again (e.g. after a DB revert) is restored — self-healing.
//
// Runs on-demand (admin endpoint) or: node server/scripts/sweep-uploads.js [--dry-run]

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { DATA_ROOT, SWEEP_FOLDERS } = require('../lib/paths');
const quarantine = require('../lib/quarantine');
const storage = require('../lib/storage');

const GRACE_DAYS = 30;            // don't touch files younger than this (in-flight/abandoned-recent)
const QUARANTINE_TTL_DAYS = 45;   // > 30-day backup horizon, so a DB revert can still recover

// Matches a BARE filename in a text column. Only used for references that are NOT stored
// as a "/uploads/..." URL — addTokens keeps URL basenames regardless of extension, so this
// list only ever matters for columns holding a bare name (procurement_schedule_drawings
// .storage_path and subcon_hiring_files.storage_path are the ones that do).
//
// A production DB audit found live references to .heic (288), .jfif (97), .dwg and .mov
// that this list did not cover; CAD formats are added alongside because those two tables
// exist to hold drawings.
//
// Widening is safe BY CONSTRUCTION: the keep-set is only ever asked "is this referenced?",
// so more matches means more files KEPT by the sweep and more files MIGRATED by the
// backfill. It can never cause a deletion.
const FILE_RE = /[\w.\-]+\.(?:pdf|jpe?g|jfif|png|gif|webp|bmp|svg|heic|heif|xlsx?|docx?|pptx?|csv|txt|mp3|mp4|mov|avi|mkv|wav|ogg|webm|zip|rar|7z|dwg|dxf|dwf|step|stp|iges|igs)/gi;

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
  // Scan EVERY database under data/ (erp, chat, + any feature DB like sotynflow) so a
  // file referenced by any DB stays in the keep-set — errs toward keeping. Auto-discovery
  // (like the backup) means new feature DBs are honored with no per-DB wiring; collectRefs
  // guards absence + opens read-only. `.db` excludes -wal/-shm sidecars.
  if (fs.existsSync(DATA_ROOT)) {
    for (const f of fs.readdirSync(DATA_ROOT)) {
      if (f.endsWith('.db')) collectRefs(path.join(DATA_ROOT, f), set);
    }
  }
  return set;
}

// File listing now comes from the storage seam (lib/storage.listKeys), which returns
// the same { key (posix, rel to uploads root), size, mtimeMs } shape the old local
// walk() produced — so classification below is unchanged, only the source of the list
// differs. That is what makes this work identically on local disk and on a bucket.
async function runSweep({ dryRun = false, silent = false } = {}) {
  const keep = buildKeepSet();

  // 0. Rehydrate — restore any quarantined file whose basename is referenced again.
  let restored = 0;
  for (const e of quarantine.list()) {
    if (keep.has(path.posix.basename(e.key))) {
      if (dryRun) restored++;
      else if (await quarantine.restoreKey(e.key)) restored++;
    }
  }

  // 1. Classify orphans — ONLY inside the swept folders.
  const cutoff = Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000;
  let scanned = 0, quarantined = 0, quarantinedBytes = 0;
  const orphans = [];
  for (const folder of SWEEP_FOLDERS) {
    // listKeys returns [] for a folder that doesn't exist, so no existence pre-check.
    for (const f of await storage.listKeys(`${folder}/`, storage.NS.UPLOADS)) {
      scanned++;
      const base = path.posix.basename(f.key);
      if (keep.has(base)) continue;             // referenced anywhere → keep
      if (f.mtimeMs > cutoff) continue;         // too recent → grace window
      orphans.push(f);
    }
  }
  for (const o of orphans) {
    if (dryRun) { quarantined++; quarantinedBytes += o.size; continue; }
    const r = await quarantine.quarantineKey(o.key);
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
    const r = await quarantine.purgeExpired(QUARANTINE_TTL_DAYS);
    purged = r.purged; purgedBytes = r.bytes;
  }

  const summary = { dryRun, referenced: keep.size, scanned, restored, quarantined, quarantinedBytes, purged, purgedBytes };
  if (!silent) {
    console.log(`[sweep]${dryRun ? ' DRY-RUN' : ''} refs=${summary.referenced} scanned=${scanned} restored=${restored} quarantined=${quarantined} (${(quarantinedBytes / 1024 / 1024).toFixed(2)} MB) purged=${purged} (${(purgedBytes / 1024 / 1024).toFixed(2)} MB)`);
  }
  return summary;
}

// ── nightly scheduler ───────────────────────────────────────────────────────────
// Until this existed the sweep ran ONLY from the admin endpoint, which meant the
// QUARANTINE_TTL_DAYS expiry never fired on its own: every file quarantined by a
// delete sat on disk indefinitely, and no orphan was ever collected unless somebody
// remembered to press a button.
//
// OFF unless ERP_ENABLE_SWEEP_CRON=1, and DRY-RUN even then unless
// ERP_SWEEP_CRON_DRYRUN=0. Both defaults are the safe direction: enabling the cron
// gets you a nightly log line and nothing else, so you can read a week of
// "quarantined=N purged=M" before anything is allowed to move a file.
//
// 02:20 is not arbitrary — it sits inside the existing nightly chain:
//   02:00 backup (rollback point) → 02:15 db-maintenance (VACUUM) → 02:20 sweep
//   → 02:30 backfill-uploads-s3.
// Sweeping BEFORE the S3 backfill means we don't pay to upload files that are about
// to be quarantined; sweeping AFTER any row deletion means the orphans those
// deletions created are already visible in the keep-set.
//
// Driver-agnostic by construction: runSweep goes through the storage seam
// (listKeys/quarantineKey), so this schedules identically on local disk and on S3.
function scheduleNightlySweep() {
  if (process.env.ERP_ENABLE_SWEEP_CRON !== '1') {
    console.log('[sweep] Scheduler not started: set ERP_ENABLE_SWEEP_CRON=1 to enable.');
    return;                                  // return WITHOUT arming a timer; never exit
  }
  const dryRun = process.env.ERP_SWEEP_CRON_DRYRUN !== '0';   // dry-run unless explicitly disarmed
  const nextRun = () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 20, 0, 0); // 02:20 today
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    setTimeout(async () => {
      try {
        const r = await runSweep({ dryRun, silent: true });
        // Dry-run always reports (that IS the deliverable during the trial week).
        // A live run stays quiet on a no-op night, like the backfill does.
        if (dryRun || r.restored || r.quarantined || r.purged) {
          console.log(`[sweep] nightly${dryRun ? ' DRY-RUN' : ''}: refs=${r.referenced} scanned=${r.scanned} restored=${r.restored} quarantined=${r.quarantined} (${(r.quarantinedBytes / 1024 / 1024).toFixed(2)} MB) purged=${r.purged} (${(r.purgedBytes / 1024 / 1024).toFixed(2)} MB)`);
        }
      } catch (e) {
        // A bad night must not kill the chain — log and let it reschedule below.
        console.error('[sweep] Scheduled run failed:', e.message);
      }
      nextRun();
    }, delay);
    console.log(`[sweep] Next scheduled run at ${target.toISOString()} (in ${Math.round(delay / 60000)} min)${dryRun ? ' — DRY-RUN (set ERP_SWEEP_CRON_DRYRUN=0 to arm)' : ' — LIVE'}`);
  };
  nextRun();
}

// buildKeepSet/collectRefs are exported so the S3 backfill can reuse the EXACT same
// notion of "referenced" — two different answers to that question is how you lose a file.
module.exports = { runSweep, scheduleNightlySweep, buildKeepSet, collectRefs, GRACE_DAYS, QUARANTINE_TTL_DAYS };

if (require.main === module) {
  const dryRun = process.argv.includes('--dry-run');
  // runSweep is async now — exiting synchronously would kill it mid-move and could
  // leave a file renamed but unrecorded in the manifest.
  runSweep({ dryRun })
    .then(() => process.exit(0))
    .catch((e) => { console.error('[sweep] failed:', e.message); process.exit(1); });
}
