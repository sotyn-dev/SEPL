// Safe online DB backup → ONE compressed, self-contained archive per run.
//
// Why the .backup() API and not a plain file copy? SQLite runs in WAL mode, so a
// plain cp/copy can grab the main file mid-write and produce corruption. The
// backup API uses a proper cursor and produces a guaranteed-consistent snapshot
// even while the server is actively writing.
//
// Why one .zip (and consolidation)? The old scheme wrote each DB as a bare
// erp-<ts>.db whose backup destination was created in WAL mode and left
// un-checkpointed — so every backup was really 3 files (.db + -wal + -shm), the
// admin download only served the .db (incomplete), and rotated -wal/-shm leaked.
// Now: back up every data/*.db, checkpoint each snapshot into a single
// standalone file, and bundle them all into one backup-<ts>.zip (~70-90%
// smaller than raw .db). One atomic, complete, restorable download.
//
// Restore: unzip backup-<ts>.zip → erp.db, chat.db, … each a normal SQLite file.
//
// Output: <BACKUP_DIR>/backup-YYYY-MM-DD_HH-mm-ss.zip
// Retention: keeps the most recent KEEP_COUNT archives, deletes older.
// Callable from:
//   - the in-process scheduler (scheduleNightly)
//   - the admin API (router posts to /api/admin/backups/run)
//   - manually via: node server/scripts/backup-db.js

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const Database = require('better-sqlite3');

// Source databases live in data/. Every *.db here is auto-discovered and backed
// up, so a future DB is captured with no code change. (Phase 4 will repoint this
// to the tenant data dir via server/lib/paths.js.)
const DATA_DIR = path.join(__dirname, '..', '..', 'data');

// Keep backups OUTSIDE the data/ folder so a rogue data-wipe doesn't nuke the
// history too. ~/erp-backups/ on the VPS; ../../backups locally.
const BACKUP_DIR = process.env.ERP_BACKUP_DIR
  || (process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'backups')
    : path.join('/root', 'erp-backups'));
const KEEP_COUNT = 30;

const pad = (n) => String(n).padStart(2, '0');
const tsNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

// Discover every source DB in data/ (excludes -wal/-shm automatically — they
// don't end in .db).
function discoverDbs() {
  if (!fs.existsSync(DATA_DIR)) return [];
  return fs.readdirSync(DATA_DIR)
    .filter(f => f.endsWith('.db'))
    .map(f => ({ name: f, path: path.join(DATA_DIR, f) }))
    .filter(d => { try { return fs.statSync(d.path).isFile(); } catch { return false; } });
}

// Consistent snapshot of one DB into a single standalone file (no -wal/-shm).
async function stageOne(src, destPath) {
  const s = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await s.backup(destPath);
  } finally {
    s.close();
  }
  // Fold the WAL into the main file and drop -wal/-shm so the staged file is a
  // single, complete, restorable DB.
  const b = new Database(destPath);
  try {
    b.pragma('wal_checkpoint(TRUNCATE)');
    b.pragma('journal_mode = DELETE');
  } finally {
    b.close();
  }
}

// Stream the staged files into one .zip (streaming — never loads a DB into
// memory, so it stays under the VPS's 512 MB heap cap).
function zipStaged(stagingDir, stagedNames, zipPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);
    for (const name of stagedNames) {
      archive.file(path.join(stagingDir, name), { name });
    }
    archive.finalize();
  });
}

async function runBackup({ silent = false } = {}) {
  const dbs = discoverDbs();
  if (dbs.length === 0) {
    const msg = `[backup] No source DBs found in ${DATA_DIR}`;
    if (!silent) console.error(msg);
    return { ok: false, error: msg };
  }
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });

  const ts = tsNow();
  const stagingDir = path.join(BACKUP_DIR, `.staging-${ts}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    // 1. Stage a consolidated snapshot of each discovered DB.
    const stagedNames = [];
    for (const db of dbs) {
      const staged = path.join(stagingDir, db.name);
      try {
        await stageOne(db.path, staged);
        stagedNames.push(db.name);
      } catch (e) {
        if (!silent) console.warn(`[backup] skipped ${db.name}: ${e.message}`);
      }
    }
    if (stagedNames.length === 0) {
      return { ok: false, error: '[backup] no DBs could be staged' };
    }

    // 2. Bundle them into one compressed archive.
    const outName = `backup-${ts}.zip`;
    const outPath = path.join(BACKUP_DIR, outName);
    await zipStaged(stagingDir, stagedNames, outPath);
    const { size } = fs.statSync(outPath);

    // 3. Rotate — keep the last KEEP_COUNT archives only.
    const existing = fs.readdirSync(BACKUP_DIR)
      .filter(f => f.startsWith('backup-') && f.endsWith('.zip'))
      .sort();
    for (const f of existing.slice(0, Math.max(0, existing.length - KEEP_COUNT))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (e) { /* ignore */ }
    }

    if (!silent) {
      console.log(`[backup] Wrote ${outName} (${(size / 1024 / 1024).toFixed(2)} MB) — ${stagedNames.length} DB(s): ${stagedNames.join(', ')}; kept ${Math.min(existing.length, KEEP_COUNT)} total`);
    }
    return { ok: true, filename: outName, size, contents: stagedNames, backup_dir: BACKUP_DIR };
  } finally {
    // 4. Always clean the staging dir.
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

// Schedule the next run at 02:00 local time and keep it running daily.
// Uses setTimeout (one-shot) chained into itself so timezone/DST shifts are
// picked up automatically each day — cleaner than a fixed 24h setInterval.
function scheduleNightly() {
  const nextRun = () => {
    const now = new Date();
    const target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 2, 0, 0, 0); // 02:00 today
    if (target <= now) target.setDate(target.getDate() + 1); // if already past 2am, schedule for tomorrow
    const delay = target - now;
    setTimeout(async () => {
      try { await runBackup(); } catch (e) { console.error('[backup] Scheduled run failed:', e.message); }
      nextRun(); // reschedule the next one
    }, delay);
    console.log(`[backup] Next scheduled run at ${target.toISOString()} (in ${Math.round(delay / 60000)} min)`);
  };
  nextRun();
}

function listBackups() {
  if (!fs.existsSync(BACKUP_DIR)) return [];
  return fs.readdirSync(BACKUP_DIR)
    // New unified archives, plus any legacy erp-/chat- .db files still on disk.
    .filter(f => (f.startsWith('backup-') && f.endsWith('.zip'))
      || ((f.startsWith('erp-') || f.startsWith('chat-')) && f.endsWith('.db')))
    .map(f => {
      const full = path.join(BACKUP_DIR, f);
      const st = fs.statSync(full);
      const kind = f.endsWith('.zip') ? 'archive' : (f.startsWith('chat-') ? 'chat' : 'erp');
      return { filename: f, kind, size: st.size, created_at: st.mtime.toISOString() };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

module.exports = { runBackup, scheduleNightly, listBackups, BACKUP_DIR };

// If invoked directly via `node server/scripts/backup-db.js`, run once.
if (require.main === module) {
  runBackup()
    .then(r => { process.exit(r.ok ? 0 : 1); })
    .catch(err => { console.error('[backup]', err); process.exit(1); });
}
