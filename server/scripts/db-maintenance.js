// Nightly live-DB compaction — reclaim disk that SQLite won't give back on its own.
//
// Two problems this fixes:
//  1. The -wal can grow large under a long-lived connection. wal_checkpoint(TRUNCATE)
//     folds it back into the main file and truncates it to zero.
//  2. SQLite reuses freed pages but never SHRINKS the .db file after deletes — the
//     file stays at its high-water mark. VACUUM rewrites it compactly, but it's
//     expensive (rewrites the whole file, takes a write lock, blocks the event
//     loop since better-sqlite3 is synchronous), so we only VACUUM when there's
//     enough free space to be worth it. That's why it runs at ~02:15 (low traffic),
//     right after the nightly backup — so a fresh backup exists before we rewrite.
//
// Reuses the app's OWN open handles (getDb / getChatDb) so there's no second
// connection contending for the lock. Also runnable manually:
//   node server/scripts/db-maintenance.js

const fs = require('fs');
const { getDb } = require('../db/schema');
const { getChatDb } = require('../db/chatDb');
const { getBoardDb } = require('../db/sotynFlowDb');

// VACUUM only when reclaimable space is meaningful — avoids a nightly full-file
// rewrite when there's almost nothing to reclaim.
const VACUUM_MIN_FREE_PAGES = 2000;   // absolute floor (large DB)
const VACUUM_MIN_FREE_RATIO = 0.10;   // or ≥10% of the file is free pages
const VACUUM_RATIO_MIN_PAGES = 200;   // ...but ignore the ratio on tiny DBs

const p = (db, key) => db.pragma(key, { simple: true });
const sizeAt = (f) => { try { return fs.statSync(f).size; } catch { return 0; } };
const sizeOf = (db) => sizeAt(db.name);

function maintainOne(label, db, silent) {
  const before = sizeOf(db);
  const walPath = db.name + '-wal';
  const walBefore = sizeAt(walPath);

  // 1. Checkpoint the WAL into the main file (cheap, every run). The main win
  //    here is truncating the -wal back to 0 — that's what reclaims disk nightly.
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
  } catch (e) {
    if (!silent) console.warn(`[db-maint] ${label}: checkpoint failed: ${e.message}`);
  }
  const walReclaimed = Math.max(0, walBefore - sizeAt(walPath));

  // 2. Threshold-gated VACUUM.
  const freelist = p(db, 'freelist_count');
  const pages = p(db, 'page_count');
  const ratio = pages > 0 ? freelist / pages : 0;
  const shouldVacuum = freelist >= VACUUM_MIN_FREE_PAGES
    || (freelist >= VACUUM_RATIO_MIN_PAGES && ratio >= VACUUM_MIN_FREE_RATIO);

  let vacuumed = false;
  if (shouldVacuum) {
    try {
      db.exec('VACUUM');
      vacuumed = true;
    } catch (e) {
      if (!silent) console.warn(`[db-maint] ${label}: VACUUM failed: ${e.message}`);
    }
  }

  const after = sizeOf(db);
  const vacuumReclaimed = Math.max(0, before - after);
  const mb = (b) => (b / 1024 / 1024).toFixed(2);
  if (!silent) {
    console.log(`[db-maint] ${label}: WAL -${mb(walReclaimed)} MB; freelist ${freelist}/${pages} (${(ratio * 100).toFixed(1)}%); ${vacuumed ? `VACUUM -${mb(vacuumReclaimed)} MB` : 'VACUUM skipped'}`);
  }
  return { db: label, sizeBefore: before, sizeAfter: after, walReclaimedBytes: walReclaimed, vacuumReclaimedBytes: vacuumReclaimed, vacuumed };
}

function runMaintenance({ silent = false } = {}) {
  const results = [];
  const targets = [];
  try { targets.push(['erp.db', getDb()]); } catch (e) { if (!silent) console.warn('[db-maint] erp.db unavailable:', e.message); }
  try { targets.push(['chat.db', getChatDb()]); } catch (e) { if (!silent) console.warn('[db-maint] chat.db unavailable:', e.message); }
  // sotynflow.db was missing here since the module landed — its WAL was never
  // checkpointed and the file never compacted by the nightly pass.
  try { targets.push(['sotynflow.db', getBoardDb()]); } catch (e) { if (!silent) console.warn('[db-maint] sotynflow.db unavailable:', e.message); }
  for (const [label, db] of targets) {
    try { results.push(maintainOne(label, db, silent)); }
    catch (e) { if (!silent) console.error(`[db-maint] ${label} failed:`, e.message); }
  }
  return results;
}

// Nightly at 02:15 local — after the 02:00 backup. Self-rescheduling one-shot
// (picks up DST/timezone shifts each day), mirroring the backup scheduler.
function scheduleNightlyMaintenance() {
  const nextRun = () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 15, 0, 0); // 02:15 today
    if (target <= now) target.setDate(target.getDate() + 1);
    const delay = target - now;
    setTimeout(() => {
      try { runMaintenance(); } catch (e) { console.error('[db-maint] Scheduled run failed:', e.message); }
      nextRun();
    }, delay);
    console.log(`[db-maint] Next scheduled run at ${target.toISOString()} (in ${Math.round(delay / 60000)} min)`);
  };
  nextRun();
}

module.exports = { runMaintenance, scheduleNightlyMaintenance };

// Manual one-shot: node server/scripts/db-maintenance.js
if (require.main === module) {
  runMaintenance();
  process.exit(0);
}
