'use strict';

/**
 * Platform control-plane backup — zip only (platform.db).
 * Same approach as ERP backup-db.js: better-sqlite3 .backup() + checkpoint + archiver zip.
 * Restore: unzip → replace platform.db (stop platform first).
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const Database = require('better-sqlite3');
const { DB_PATH, DATA_DIR } = require('./db');

const BACKUP_DIR = process.env.PLATFORM_BACKUP_DIR
  || (process.platform === 'win32'
    ? path.join(__dirname, '..', '..', 'backups')
    : path.join('/var', 'lib', 'sotyn', 'platform-backups'));

const KEEP_COUNT = Number(process.env.PLATFORM_BACKUP_KEEP || 30);

const pad = (n) => String(n).padStart(2, '0');
const tsNow = () => {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}-${pad(d.getMinutes())}-${pad(d.getSeconds())}`;
};

function ensureBackupDir() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

async function stageOne(src, destPath) {
  const s = new Database(src, { readonly: true, fileMustExist: true });
  try {
    await s.backup(destPath);
  } finally {
    s.close();
  }
  const b = new Database(destPath);
  try {
    b.pragma('wal_checkpoint(TRUNCATE)');
    b.pragma('journal_mode = DELETE');
  } finally {
    b.close();
  }
}

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
  if (!fs.existsSync(DB_PATH)) {
    const msg = `platform.db not found at ${DB_PATH}`;
    if (!silent) console.error(`[platform-backup] ${msg}`);
    return { ok: false, error: msg };
  }

  ensureBackupDir();
  const ts = tsNow();
  const stagingDir = path.join(BACKUP_DIR, `.staging-${ts}`);
  fs.mkdirSync(stagingDir, { recursive: true });

  try {
    const name = 'platform.db';
    await stageOne(DB_PATH, path.join(stagingDir, name));

    const outName = `platform-backup-${ts}.zip`;
    const outPath = path.join(BACKUP_DIR, outName);
    await zipStaged(stagingDir, [name], outPath);
    const { size } = fs.statSync(outPath);

    const existing = fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.startsWith('platform-backup-') && f.endsWith('.zip'))
      .sort();
    for (const f of existing.slice(0, Math.max(0, existing.length - KEEP_COUNT))) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch { /* ignore */ }
    }

    if (!silent) {
      console.log(`[platform-backup] Wrote ${outName} (${(size / 1024).toFixed(1)} KB)`);
    }
    return {
      ok: true,
      filename: outName,
      size,
      contents: [name],
      backup_dir: BACKUP_DIR,
      source_db: DB_PATH,
      data_dir: DATA_DIR,
    };
  } finally {
    try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function listBackups() {
  ensureBackupDir();
  return fs.readdirSync(BACKUP_DIR)
    .filter((f) => /^platform-backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/.test(f))
    .map((filename) => {
      const full = path.join(BACKUP_DIR, filename);
      const st = fs.statSync(full);
      return {
        filename,
        db: 'archive',
        size: st.size,
        created_at: st.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

function scheduleNightly() {
  const runAt = () => {
    const now = new Date();
    const next = new Date(now);
    next.setHours(2, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    const ms = next - now;
    setTimeout(async () => {
      try {
        await runBackup({ silent: false });
      } catch (e) {
        console.error('[platform-backup] nightly failed:', e.message);
      }
      runAt();
    }, ms);
    console.log(`[platform-backup] next nightly at ${next.toISOString()} → ${BACKUP_DIR}`);
  };
  runAt();
}

module.exports = {
  BACKUP_DIR,
  KEEP_COUNT,
  runBackup,
  listBackups,
  scheduleNightly,
};
