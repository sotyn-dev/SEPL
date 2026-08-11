'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const {
  IMAGE,
  ERP_ENV_FILE,
  CONTAINER_DATA,
  CONTAINER_PORT,
  PORT_MIN,
  PORT_MAX,
  REPO_ROOT,
  containerName,
  dataPathFor,
  assertTag,
  imageRef,
} = require('./paths');
const state = require('./state');
const jobs = require('./jobs');

function docker(args, opts = {}) {
  const r = spawnSync('docker', args, {
    encoding: 'utf8',
    windowsHide: true,
    ...opts,
  });
  return {
    status: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error,
  };
}

function dockerAvailable() {
  const r = docker(['info'], { timeout: 8000 });
  if (r.error) return { ok: false, error: r.error.message };
  if (r.status !== 0) return { ok: false, error: r.stderr || 'docker info failed' };
  return { ok: true };
}

function inspectStatus(name) {
  const r = docker(['inspect', '-f', '{{.State.Status}}', name]);
  if (r.status !== 0) return null;
  return r.stdout || null;
}

function usedPorts() {
  const ports = new Set();
  for (const t of state.list()) {
    if (t.port) ports.add(Number(t.port));
  }
  return ports;
}

function allocatePort(preferred) {
  const used = usedPorts();
  if (preferred) {
    const p = Number(preferred);
    if (p < PORT_MIN || p > PORT_MAX) {
      const err = new Error(`port must be in ${PORT_MIN}-${PORT_MAX}`);
      err.status = 400;
      throw err;
    }
    if (used.has(p)) {
      const err = new Error(`port ${p} already allocated`);
      err.status = 409;
      throw err;
    }
    return p;
  }
  for (let p = PORT_MIN; p <= PORT_MAX; p++) {
    if (!used.has(p)) return p;
  }
  const err = new Error('no free ports in agent pool');
  err.status = 503;
  throw err;
}

function ensureDataDir(slug) {
  const dataPath = dataPathFor(slug);
  if (slug === 'secured') {
    if (!fs.existsSync(dataPath)) {
      fs.mkdirSync(dataPath, { recursive: true });
    }
    return dataPath;
  }
  fs.mkdirSync(dataPath, { recursive: true });
  return dataPath;
}

/**
 * docker run -d --name … -p host:5000 -v data:/app/data [--env-file] -e TENANT_ID …
 * Never deletes host data paths.
 */
function runContainer({ slug, port, dataPath, image = IMAGE, extraEnv = {} }) {
  const name = containerName(slug);
  const envArgs = [];
  if (ERP_ENV_FILE && fs.existsSync(ERP_ENV_FILE)) {
    envArgs.push('--env-file', ERP_ENV_FILE);
  }
  envArgs.push(
    '-e', `TENANT_ID=${slug}`,
    '-e', `PORT=${CONTAINER_PORT}`,
    '-e', 'ERP_DISABLE_BACKUP_SCHEDULER=1',
  );
  for (const [k, v] of Object.entries(extraEnv)) {
    if (v == null) continue;
    envArgs.push('-e', `${k}=${v}`);
  }

  const vol = `${dataPath}:${CONTAINER_DATA}`;

  const args = [
    'run', '-d',
    '--name', name,
    '-p', `${port}:${CONTAINER_PORT}`,
    '-v', vol,
    ...envArgs,
    image,
  ];

  const r = docker(args);
  if (r.status !== 0) {
    const err = new Error(r.stderr || r.stdout || 'docker run failed');
    err.status = 502;
    err.detail = r.stderr;
    throw err;
  }
  return { containerId: r.stdout, name };
}

function provision(body = {}) {
  const slug = String(body.slug || '').trim();
  const { assertSlug } = require('./paths');
  assertSlug(slug);

  const avail = dockerAvailable();
  if (!avail.ok) {
    const err = new Error(`Docker unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }

  if (state.get(slug)) {
    const err = new Error(`tenant ${slug} already provisioned`);
    err.status = 409;
    throw err;
  }

  const name = containerName(slug);
  if (inspectStatus(name)) {
    const err = new Error(`container ${name} already exists`);
    err.status = 409;
    throw err;
  }

  const port = allocatePort(body.port);
  const dataPath = ensureDataDir(slug);
  const image = body.image || IMAGE;
  const { containerId } = runContainer({
    slug,
    port,
    dataPath,
    image,
    extraEnv: body.env && typeof body.env === 'object' ? body.env : {},
  });

  const row = state.upsert(slug, {
    port,
    dataPath,
    containerName: name,
    containerId,
    image,
    status: 'running',
    createdAt: new Date().toISOString(),
  });

  return enrich(row);
}

function enrich(row) {
  if (!row) return null;
  const live = inspectStatus(row.containerName || containerName(row.slug));
  return {
    ...row,
    status: live || row.status || 'unknown',
    dockerStatus: live,
  };
}

function listTenants() {
  return state.list().map(enrich);
}

function getTenant(slug) {
  const row = state.get(slug);
  if (!row) return null;
  return enrich(row);
}

function start(slug) {
  const row = state.get(slug);
  if (!row) {
    const err = new Error('tenant not found');
    err.status = 404;
    throw err;
  }
  const avail = dockerAvailable();
  if (!avail.ok) {
    const err = new Error(`Docker unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }
  const name = row.containerName || containerName(slug);
  const r = docker(['start', name]);
  if (r.status !== 0) {
    const err = new Error(r.stderr || 'docker start failed');
    err.status = 502;
    throw err;
  }
  return enrich(state.upsert(slug, { status: 'running' }));
}

function stop(slug) {
  const row = state.get(slug);
  if (!row) {
    const err = new Error('tenant not found');
    err.status = 404;
    throw err;
  }
  const name = row.containerName || containerName(slug);
  const r = docker(['stop', name]);
  if (r.status !== 0) {
    const err = new Error(r.stderr || 'docker stop failed');
    err.status = 502;
    throw err;
  }
  return enrich(state.upsert(slug, { status: 'exited' }));
}

function restart(slug) {
  const row = state.get(slug);
  if (!row) {
    const err = new Error('tenant not found');
    err.status = 404;
    throw err;
  }
  const name = row.containerName || containerName(slug);
  const r = docker(['restart', name]);
  if (r.status !== 0) {
    const err = new Error(r.stderr || 'docker restart failed');
    err.status = 502;
    throw err;
  }
  return enrich(state.upsert(slug, { status: 'running' }));
}

function destroy(slug, { wipeData = false } = {}) {
  const row = state.get(slug);
  if (!row) {
    const err = new Error('tenant not found');
    err.status = 404;
    throw err;
  }
  if (wipeData && slug === 'secured') {
    const err = new Error('refuse wipeData for secured');
    err.status = 403;
    throw err;
  }
  const name = row.containerName || containerName(slug);
  docker(['rm', '-f', name]);
  if (wipeData && slug !== 'secured' && row.dataPath) {
    fs.rmSync(row.dataPath, { recursive: true, force: true });
  }
  state.remove(slug);
  return { ok: true, slug, wipedData: !!wipeData };
}

/**
 * Map tag → tenant slugs currently using that image (registry + live inspect).
 */
function imageUsageByTag() {
  const used = new Map();
  const add = (tag, slug) => {
    if (!tag || tag === '<none>') return;
    if (!used.has(tag)) used.set(tag, []);
    if (slug && !used.get(tag).includes(slug)) used.get(tag).push(slug);
  };

  for (const row of state.list()) {
    const img = String(row.image || '');
    const m = img.match(/^sotyn-erp:(.+)$/);
    if (m) add(m[1], row.slug);

    const name = row.containerName || containerName(row.slug);
    const r = docker(['inspect', '-f', '{{.Config.Image}}', name]);
    if (r.status === 0 && r.stdout) {
      const live = r.stdout.trim();
      const lm = live.match(/^sotyn-erp:(.+)$/);
      if (lm) add(lm[1], row.slug);
    }
  }
  return used;
}

function listImages() {
  const r = docker([
    'images',
    'sotyn-erp',
    '--format',
    '{{.Repository}}\t{{.Tag}}\t{{.ID}}\t{{.CreatedSince}}\t{{.Size}}\t{{.CreatedAt}}',
  ]);
  if (r.status !== 0) {
    const err = new Error(r.stderr || 'docker images failed');
    err.status = 502;
    throw err;
  }
  const usage = imageUsageByTag();
  const images = [];
  for (const line of (r.stdout || '').split('\n')) {
    if (!line.trim()) continue;
    const [repository, tag, id, created, size, createdAt] = line.split('\t');
    if (!tag || tag === '<none>') continue;
    const usedBy = usage.get(tag) || [];
    images.push({
      repository,
      tag,
      id,
      created,
      createdAt: createdAt || null,
      size,
      ref: `${repository}:${tag}`,
      inUse: usedBy.length > 0,
      usedBy,
    });
  }
  // Newest first when CreatedAt present
  images.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return images;
}

/**
 * Remove one local sotyn-erp tag. Refuses if any tenant container uses it.
 * Never touches host data/.
 */
function deleteImage(tag) {
  assertTag(tag);
  const avail = dockerAvailable();
  if (!avail.ok) {
    const err = new Error(`Docker unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }

  const images = listImages();
  const row = images.find((i) => i.tag === tag);
  if (!row) {
    const err = new Error(`image sotyn-erp:${tag} not found`);
    err.status = 404;
    throw err;
  }
  if (row.inUse) {
    const err = new Error(
      `image sotyn-erp:${tag} is in use by: ${(row.usedBy || []).join(', ') || 'tenant(s)'}`
    );
    err.status = 409;
    throw err;
  }

  const r = docker(['rmi', imageRef(tag)]);
  if (r.status !== 0) {
    const err = new Error(r.stderr || r.stdout || 'docker rmi failed');
    err.status = 502;
    err.detail = r.stderr;
    throw err;
  }
  return { ok: true, deleted: [tag], kept: [], hostDataUntouched: true };
}

/**
 * Delete unused sotyn-erp tags on this host only.
 * keepLatest: number of newest *unused* tags to retain for rollback (default 4).
 * Always keeps in-use tags. Optionally keep `latest` (default true).
 * Never touches host data/.
 */
function pruneImages(body = {}) {
  const avail = dockerAvailable();
  if (!avail.ok) {
    const err = new Error(`Docker unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }

  const keepLatest = body.keepLatest == null ? 4 : Number(body.keepLatest);
  if (!Number.isFinite(keepLatest) || keepLatest < 0 || keepLatest > 50) {
    const err = new Error('keepLatest must be 0–50');
    err.status = 400;
    throw err;
  }
  const keepLatestTag = body.keepLatestTag !== false && body.keepLatestTag !== 0;

  const images = listImages();
  const keep = new Set();
  for (const img of images) {
    if (img.inUse) keep.add(img.tag);
  }
  if (keepLatestTag) keep.add('latest');

  const unused = images.filter((i) => !keep.has(i.tag));
  const retainUnused = unused.slice(0, keepLatest);
  for (const img of retainUnused) keep.add(img.tag);

  const deleted = [];
  const errors = [];
  for (const img of images) {
    if (keep.has(img.tag)) continue;
    const r = docker(['rmi', img.ref]);
    if (r.status === 0) deleted.push(img.tag);
    else errors.push({ tag: img.tag, error: r.stderr || r.stdout || 'rmi failed' });
  }

  return {
    ok: errors.length === 0,
    deleted,
    kept: [...keep],
    errors,
    keepLatest,
    hostDataUntouched: true,
  };
}

/**
 * Recreate one tenant container on a new image. Container only — never touches data/.
 */
function recreateTenant(row, image) {
  const slug = row.slug;
  const name = row.containerName || containerName(slug);
  const port = row.port;
  const dataPath = row.dataPath || dataPathFor(slug);

  if (!port) {
    const err = new Error(`tenant ${slug} has no stored port`);
    err.status = 500;
    throw err;
  }
  if (!fs.existsSync(dataPath)) {
    const err = new Error(`data path missing for ${slug}: ${dataPath} (refusing to recreate)`);
    err.status = 500;
    throw err;
  }

  docker(['rm', '-f', name]);

  const { containerId } = runContainer({ slug, port, dataPath, image });
  return state.upsert(slug, {
    containerId,
    containerName: name,
    image,
    status: 'running',
    deployedAt: new Date().toISOString(),
  });
}

/**
 * Sync deploy body validation; returns job handle. Work runs async.
 * Hard rule: never delete host data directories.
 * After success, auto-prunes unused images (keepLatest default 4) unless pruneAfter:false.
 */
function startDeploy(body = {}) {
  const tag = String(body.tag || '').trim();
  assertTag(tag);
  const build = body.build === true || body.build === 1 || body.build === '1' || body.build === 'true';
  const image = imageRef(tag);
  const pruneAfter = !(body.pruneAfter === false || body.pruneAfter === 0 || body.pruneAfter === '0' || body.pruneAfter === 'false');
  const keepLatest = body.keepLatest == null ? 4 : Number(body.keepLatest);
  if (!Number.isFinite(keepLatest) || keepLatest < 0 || keepLatest > 50) {
    const err = new Error('keepLatest must be 0–50');
    err.status = 400;
    throw err;
  }

  const avail = dockerAvailable();
  if (!avail.ok) {
    const err = new Error(`Docker unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }

  if (!build) {
    const images = listImages();
    if (!images.some((i) => i.tag === tag)) {
      const err = new Error(`image ${image} not found locally (build:false)`);
      err.status = 404;
      throw err;
    }
  }

  const tenants = state.list();
  const job = jobs.createJob({
    tag,
    build,
    image,
    tenantCount: tenants.length,
    pruneAfter,
    keepLatest,
  });

  setImmediate(() => runDeployJob(job.id, { tag, build, image, tenants, pruneAfter, keepLatest }));

  return {
    jobId: job.id,
    status: job.status,
    tag,
    build,
    image,
    tenantCount: tenants.length,
    pruneAfter,
    keepLatest,
  };
}

function runDeployJob(jobId, { tag, build, image, tenants, pruneAfter, keepLatest }) {
  jobs.patchJob(jobId, { status: 'running' });
  try {
    if (build) {
      jobs.addStep(jobId, { op: 'build', message: `docker build -t ${image} -t sotyn-erp:latest` });
      const r = docker(
        ['build', '-t', image, '-t', 'sotyn-erp:latest', '.'],
        { cwd: REPO_ROOT, timeout: 0, maxBuffer: 64 * 1024 * 1024 }
      );
      if (r.status !== 0) {
        throw new Error(r.stderr || r.stdout || 'docker build failed');
      }
      jobs.addStep(jobId, { op: 'build', ok: true, message: 'build ok' });
    } else {
      jobs.addStep(jobId, { op: 'build', skipped: true, message: `using existing ${image}` });
    }

    for (const row of tenants) {
      jobs.addStep(jobId, {
        op: 'recreate',
        slug: row.slug,
        message: `recreate ${row.slug} (container only; data untouched)`,
      });
      recreateTenant(row, image);
      jobs.addStep(jobId, { op: 'recreate', slug: row.slug, ok: true });
    }

    if (pruneAfter) {
      jobs.addStep(jobId, {
        op: 'prune',
        message: `auto-prune unused images (keep ${keepLatest} unused + in-use + :latest)`,
      });
      const pruned = pruneImages({ keepLatest });
      jobs.addStep(jobId, {
        op: 'prune',
        ok: pruned.ok,
        message: pruned.deleted.length
          ? `removed ${pruned.deleted.join(', ')}`
          : 'nothing to prune',
        deleted: pruned.deleted,
        errors: pruned.errors,
      });
      if (pruned.errors?.length) {
        jobs.addStep(jobId, {
          op: 'prune',
          message: `prune warnings: ${pruned.errors.map((e) => `${e.tag}: ${e.error}`).join('; ')}`,
        });
      }
    } else {
      jobs.addStep(jobId, { op: 'prune', skipped: true, message: 'pruneAfter:false' });
    }

    jobs.patchJob(jobId, { status: 'ok', error: null });
    jobs.addStep(jobId, { op: 'done', message: `deployed ${image} to ${tenants.length} tenant(s)` });
  } catch (e) {
    jobs.patchJob(jobId, { status: 'error', error: e.message || String(e) });
    jobs.addStep(jobId, { op: 'error', message: e.message || String(e) });
  }
}

function getDeployJob(id) {
  return jobs.getJob(id);
}

module.exports = {
  dockerAvailable,
  provision,
  listTenants,
  getTenant,
  start,
  stop,
  restart,
  destroy,
  listImages,
  deleteImage,
  pruneImages,
  startDeploy,
  getDeployJob,
  IMAGE,
  ERP_ENV_FILE,
};
