'use strict';

/**
 * List + restore tenant ERP DB backups (zip archives and legacy dated .db files).
 * Never deletes host backups/. Undo = restore an older backup from the same list.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const {
  assertSlug,
  dataPathFor,
  backupPathFor,
  containerName,
} = require('./paths');
const state = require('./state');
const jobs = require('./jobs');

const ZIP_RE = /^backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip$/;
/** Any live DB stem + dated stamp: erp-<ts>.db, chat-<ts>.db, foo-<ts>.db → restores to erp.db / chat.db / foo.db */
const LEGACY_RE = /^([a-zA-Z0-9][a-zA-Z0-9_-]*)-(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\.db$/;

function legacyBackupDir() {
  const raw = process.env.LEGACY_BACKUP_DIR;
  if (!raw || !String(raw).trim()) return null;
  const p = path.resolve(String(raw).trim());
  return fs.existsSync(p) && fs.statSync(p).isDirectory() ? p : null;
}

function assertSafeFilename(file) {
  const f = String(file || '');
  if (!ZIP_RE.test(f) && !LEGACY_RE.test(f)) {
    const err = new Error('Invalid backup filename');
    err.status = 400;
    throw err;
  }
  if (f.includes('..') || f.includes('/') || f.includes('\\')) {
    const err = new Error('Invalid backup filename');
    err.status = 400;
    throw err;
  }
  return f;
}

function classify(filename) {
  if (ZIP_RE.test(filename)) return { kind: 'archive', db: 'archive' };
  const m = filename.match(LEGACY_RE);
  if (m) return { kind: 'legacy', db: m[1], stamp: m[2] };
  return { kind: 'unknown', db: null };
}

function listDirBackups(dir, source) {
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => ZIP_RE.test(f) || LEGACY_RE.test(f))
    .map((f) => {
      const full = path.join(dir, f);
      let st;
      try { st = fs.statSync(full); } catch { return null; }
      if (!st.isFile()) return null;
      const meta = classify(f);
      return {
        filename: f,
        db: meta.db,
        size: st.size,
        createdAt: st.mtime.toISOString(),
        source,
      };
    })
    .filter(Boolean);
}

function listBackups(slug) {
  assertSlug(slug);
  const tenantDir = backupPathFor(slug);
  const items = listDirBackups(tenantDir, 'tenant');
  const legacy = legacyBackupDir();
  if (legacy) {
    for (const b of listDirBackups(legacy, 'legacy')) {
      // Prefer tenant copy if same name exists in both.
      if (!items.some((x) => x.filename === b.filename)) items.push(b);
    }
  }
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {
    slug,
    backups: items,
    tenantBackupDir: tenantDir,
    legacyBackupDir: legacy,
  };
}

function resolveBackupFile(slug, filename) {
  const f = assertSafeFilename(filename);
  const tenantDir = backupPathFor(slug);
  const tenantPath = path.join(tenantDir, f);
  if (fs.existsSync(tenantPath) && fs.statSync(tenantPath).isFile()) {
    return { file: f, path: tenantPath, dir: tenantDir, source: 'tenant' };
  }
  const legacy = legacyBackupDir();
  if (legacy) {
    const p = path.join(legacy, f);
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return { file: f, path: p, dir: legacy, source: 'legacy' };
    }
  }
  const err = new Error(`Backup not found: ${f}`);
  err.status = 404;
  throw err;
}

/** Extract only top-level *.db members from a zip into destDir (no path traversal). */
function extractZipDbs(zipPath, destDir) {
  const buf = fs.readFileSync(zipPath);
  if (buf.length < 22) throw new Error('zip too small');

  // EOCD signature 0x06054b50
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65557; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('zip EOCD not found');

  const entryCount = buf.readUInt16LE(eocd + 10);
  let centralOffset = buf.readUInt32LE(eocd + 16);
  const written = [];

  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(centralOffset) !== 0x02014b50) {
      throw new Error('bad zip central directory');
    }
    const method = buf.readUInt16LE(centralOffset + 10);
    const compSize = buf.readUInt32LE(centralOffset + 20);
    const uncompSize = buf.readUInt32LE(centralOffset + 24);
    const nameLen = buf.readUInt16LE(centralOffset + 28);
    const extraLen = buf.readUInt16LE(centralOffset + 30);
    const commentLen = buf.readUInt16LE(centralOffset + 32);
    const localHeaderOffset = buf.readUInt32LE(centralOffset + 42);
    const name = buf.slice(centralOffset + 46, centralOffset + 46 + nameLen).toString('utf8');
    centralOffset += 46 + nameLen + extraLen + commentLen;

    const base = path.basename(name.replace(/\\/g, '/'));
    if (!base.endsWith('.db') || base.includes('..')) continue;
    if (name.includes('..')) continue;

    if (buf.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new Error(`bad local header for ${base}`);
    }
    const localNameLen = buf.readUInt16LE(localHeaderOffset + 26);
    const localExtraLen = buf.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLen + localExtraLen;
    const compressed = buf.slice(dataStart, dataStart + compSize);

    let data;
    if (method === 0) {
      data = compressed;
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressed);
    } else {
      throw new Error(`unsupported zip method ${method} for ${base}`);
    }
    if (data.length !== uncompSize && uncompSize !== 0) {
      // Some writers leave uncompSize 0; still accept inflate result.
    }
    fs.writeFileSync(path.join(destDir, base), data);
    written.push(base);
  }

  if (!written.length) throw new Error('zip contained no .db files');
  return written;
}

function applyLegacySet(resolved, dataPath) {
  const meta = classify(resolved.file);
  if (meta.kind !== 'legacy') throw new Error('not a legacy backup');
  const stamp = meta.stamp;
  const stampSuffix = `-${stamp}.db`;
  const names = fs.readdirSync(resolved.dir).filter((f) => {
    if (!f.endsWith(stampSuffix)) return false;
    return LEGACY_RE.test(f);
  });
  if (!names.includes(resolved.file)) {
    throw new Error(`missing selected file ${resolved.file}`);
  }
  const applied = [];
  for (const name of names) {
    const m = name.match(LEGACY_RE);
    if (!m) continue;
    const stem = m[1]; // erp-2026-….db → live erp.db
    const dest = path.join(dataPath, `${stem}.db`);
    fs.copyFileSync(path.join(resolved.dir, name), dest);
    applied.push(`${stem}.db`);
  }
  return applied;
}

function applyBackup(resolved, dataPath) {
  fs.mkdirSync(dataPath, { recursive: true });
  if (ZIP_RE.test(resolved.file)) {
    return extractZipDbs(resolved.path, dataPath);
  }
  return applyLegacySet(resolved, dataPath);
}

function docker(args, opts = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
}

function inspectStatus(name) {
  const r = docker(['inspect', '-f', '{{.State.Status}}', name]);
  if (r.status !== 0) return null;
  return (r.stdout || '').trim() || null;
}

function stopContainerIfRunning(slug, row) {
  if (!row) return { skipped: true, reason: 'not provisioned' };
  const name = row.containerName || containerName(slug);
  const st = inspectStatus(name);
  if (!st || st === 'exited' || st === 'created') {
    return { skipped: true, reason: st || 'missing' };
  }
  const r = docker(['stop', name]);
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'docker stop failed').trim());
  }
  state.upsert(slug, { status: 'exited' });
  return { stopped: true, name };
}

function startContainerIfProvisioned(slug, row) {
  if (!row) return { skipped: true, reason: 'not provisioned' };
  const name = row.containerName || containerName(slug);
  if (!inspectStatus(name)) {
    return { skipped: true, reason: 'container missing' };
  }
  const r = docker(['start', name]);
  if (r.status !== 0) {
    throw new Error((r.stderr || r.stdout || 'docker start failed').trim());
  }
  state.upsert(slug, { status: 'running' });
  return { started: true, name };
}

function startRestore(slug, filename) {
  assertSlug(slug);
  const resolved = resolveBackupFile(slug, filename);
  const row = state.get(slug);
  const dataPath = (row && row.dataPath) || dataPathFor(slug);

  const job = jobs.createJob({
    type: 'restore',
    slug,
    file: resolved.file,
    source: resolved.source,
  });

  setImmediate(() => runRestoreJob(job.id, { slug, resolved, row, dataPath }));

  return {
    jobId: job.id,
    status: job.status,
    slug,
    file: resolved.file,
    source: resolved.source,
  };
}

function runRestoreJob(jobId, { slug, resolved, row, dataPath }) {
  jobs.patchJob(jobId, { status: 'running' });
  try {
    jobs.addStep(jobId, {
      op: 'stop',
      message: `stop container for ${slug} if running`,
    });
    const stopped = stopContainerIfRunning(slug, row);
    jobs.addStep(jobId, { op: 'stop', ok: true, ...stopped });

    jobs.addStep(jobId, {
      op: 'apply',
      message: `apply ${resolved.file} (${resolved.source})`,
    });
    const written = applyBackup(resolved, dataPath);
    jobs.addStep(jobId, { op: 'apply', ok: true, files: written });

    jobs.addStep(jobId, { op: 'start', message: `start container for ${slug} if provisioned` });
    const started = startContainerIfProvisioned(slug, row);
    jobs.addStep(jobId, { op: 'start', ok: true, ...started });

    jobs.patchJob(jobId, { status: 'ok' });
    jobs.addStep(jobId, {
      op: 'done',
      message: `restored ${resolved.file} → ${dataPath}`,
    });
  } catch (e) {
    jobs.patchJob(jobId, { status: 'error', error: e.message || String(e) });
    jobs.addStep(jobId, { op: 'error', message: e.message || String(e) });
  }
}

function getRestoreJob(id) {
  return jobs.getJob(id);
}

/**
 * Run ERP backup-db.js inside the tenant container (writes to bind-mounted backups/).
 * Container must be provisioned; starts it if stopped.
 */
function startBackup(slug) {
  assertSlug(slug);
  const row = state.get(slug);
  if (!row) {
    const err = new Error('tenant not provisioned on this host');
    err.status = 404;
    throw err;
  }

  const job = jobs.createJob({
    type: 'backup',
    slug,
  });

  setImmediate(() => runBackupJob(job.id, { slug, row }));

  return {
    jobId: job.id,
    status: job.status,
    slug,
  };
}

function runBackupJob(jobId, { slug, row }) {
  jobs.patchJob(jobId, { status: 'running' });
  try {
    const name = row.containerName || containerName(slug);
    let st = inspectStatus(name);
    if (!st) {
      throw new Error(`container ${name} missing — provision/recreate first`);
    }
    if (st !== 'running') {
      jobs.addStep(jobId, { op: 'start', message: `start ${name} for backup` });
      const started = startContainerIfProvisioned(slug, row);
      jobs.addStep(jobId, { op: 'start', ok: true, ...started });
      st = 'running';
    } else {
      jobs.addStep(jobId, { op: 'start', skipped: true, message: 'container already running' });
    }

    jobs.addStep(jobId, {
      op: 'backup',
      message: 'docker exec … node server/scripts/backup-db.js',
    });
    const r = docker(
      ['exec', name, 'node', 'server/scripts/backup-db.js'],
      { timeout: 0, maxBuffer: 16 * 1024 * 1024 }
    );
    if (r.status !== 0) {
      throw new Error((r.stderr || r.stdout || 'backup-db.js failed').trim());
    }
    const out = `${r.stdout || ''}\n${r.stderr || ''}`;
    const m = out.match(/Wrote (backup-\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.zip)/);
    const filename = m ? m[1] : null;
    jobs.addStep(jobId, {
      op: 'backup',
      ok: true,
      filename,
      message: filename ? `wrote ${filename}` : 'backup ok',
    });

    jobs.patchJob(jobId, { status: 'ok', file: filename });
    jobs.addStep(jobId, {
      op: 'done',
      message: filename
        ? `backup ${filename} in tenant backups mount`
        : 'backup finished (see agent logs for name)',
    });
  } catch (e) {
    jobs.patchJob(jobId, { status: 'error', error: e.message || String(e) });
    jobs.addStep(jobId, { op: 'error', message: e.message || String(e) });
  }
}

module.exports = {
  listBackups,
  startRestore,
  startBackup,
  getRestoreJob,
  // test hooks
  assertSafeFilename,
  applyBackup,
  resolveBackupFile,
  extractZipDbs,
  ZIP_RE,
  LEGACY_RE,
};
