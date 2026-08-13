'use strict';

/**
 * Shared HTTP-shaped handler for worker agent /v1 routes.
 * Used by the local :7200 server and by the outbound Platform WSS client.
 */
const {
  TENANTS_ROOT,
  PORT_MIN,
  PORT_MAX,
  REPO_ROOT,
  ERP_ENV_FILE,
  assertSlug,
  legacyImportSlug,
  legacyDataDir,
  legacyBackupDir,
} = require('./paths');
const driver = require('./dockerDriver');
const restore = require('./restore');

function match(url, method, pattern) {
  if (method !== pattern.method) return null;
  const m = url.match(pattern.re);
  return m ? m.groups || {} : null;
}

/**
 * @returns {{ status: number, data: object }}
 */
async function handleV1({ method, path, body = {}, query = {} }) {
  const url = (path || '').split('?')[0];
  const mth = String(method || 'GET').toUpperCase();

  if (url === '/v1/health' && mth === 'GET') {
    const d = driver.dockerAvailable();
    return {
      status: 200,
      data: {
        ok: true,
        service: 'sotyn-worker-agent',
        mode: 'docker',
        docker: d.ok,
        dockerError: d.ok ? undefined : d.error,
      },
    };
  }

  if (url === '/v1/host' && mth === 'GET') {
    const d = driver.dockerAvailable();
    return {
      status: 200,
      data: {
        hostId: process.env.HOST_ID || 'host_local',
        mode: 'docker',
        docker: d.ok,
        dockerError: d.ok ? undefined : d.error,
        repoRoot: REPO_ROOT,
        tenantsRoot: TENANTS_ROOT,
        envFile: ERP_ENV_FILE,
        portRange: [PORT_MIN, PORT_MAX],
        image: driver.IMAGE,
        legacyImportSlug: legacyImportSlug(),
        legacyDataDir: legacyDataDir(),
        legacyBackupDir: legacyBackupDir(),
      },
    };
  }

  if (url === '/v1/images' && mth === 'GET') {
    return {
      status: 200,
      data: {
        hostId: process.env.HOST_ID || 'host_local',
        images: driver.listImages(),
      },
    };
  }

  if (url === '/v1/images/prune' && mth === 'POST') {
    const result = driver.pruneImages(body || {});
    return {
      status: 200,
      data: {
        hostId: process.env.HOST_ID || 'host_local',
        ...result,
      },
    };
  }

  let mImg = match(url, mth, {
    method: 'DELETE',
    re: /^\/v1\/images\/(?<tag>[^/]+)$/,
  });
  if (mImg) {
    const result = driver.deleteImage(decodeURIComponent(mImg.tag));
    return {
      status: 200,
      data: {
        hostId: process.env.HOST_ID || 'host_local',
        ...result,
      },
    };
  }

  if (url === '/v1/deploy' && mth === 'POST') {
    const result = driver.startDeploy(body || {});
    return { status: 202, data: result };
  }

  let m = match(url, mth, {
    method: 'GET',
    re: /^\/v1\/deploy\/jobs\/(?<id>[a-f0-9]+)$/,
  });
  if (m) {
    const job = driver.getDeployJob(m.id);
    if (!job) return { status: 404, data: { error: 'job not found' } };
    return { status: 200, data: { job } };
  }

  if (url === '/v1/tenants' && mth === 'GET') {
    return { status: 200, data: { tenants: driver.listTenants() } };
  }

  if (url === '/v1/tenants' && mth === 'POST') {
    if (body.importLegacy || body.import_legacy) {
      const result = driver.startImportProvision(body);
      return { status: 202, data: result };
    }
    const tenant = driver.provision(body);
    return { status: 201, data: { tenant } };
  }

  m = match(url, mth, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)$/ });
  if (m) {
    assertSlug(m.slug);
    const tenant = driver.getTenant(m.slug);
    if (!tenant) return { status: 404, data: { error: 'tenant not found' } };
    return { status: 200, data: { tenant } };
  }

  m = match(url, mth, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/start$/ });
  if (m) {
    assertSlug(m.slug);
    return { status: 200, data: { tenant: driver.start(m.slug) } };
  }

  m = match(url, mth, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/stop$/ });
  if (m) {
    assertSlug(m.slug);
    return { status: 200, data: { tenant: driver.stop(m.slug) } };
  }

  m = match(url, mth, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/restart$/ });
  if (m) {
    assertSlug(m.slug);
    return { status: 200, data: { tenant: driver.restart(m.slug) } };
  }

  m = match(url, mth, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/logs$/ });
  if (m) {
    assertSlug(m.slug);
    const tail = query.tail;
    return { status: 200, data: driver.getLogs(m.slug, { tail }) };
  }

  m = match(url, mth, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/backups$/ });
  if (m) {
    assertSlug(m.slug);
    return { status: 200, data: restore.listBackups(m.slug) };
  }

  m = match(url, mth, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/restore$/ });
  if (m) {
    assertSlug(m.slug);
    const result = restore.startRestore(m.slug, body.file || body.filename);
    return { status: 202, data: result };
  }

  m = match(url, mth, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/backup$/ });
  if (m) {
    assertSlug(m.slug);
    const result = restore.startBackup(m.slug);
    return { status: 202, data: result };
  }

  m = match(url, mth, {
    method: 'GET',
    re: /^\/v1\/tenants\/(?<slug>[^/]+)\/(?:restore\/)?jobs\/(?<id>[a-f0-9]+)$/,
  });
  if (m) {
    assertSlug(m.slug);
    const job = restore.getRestoreJob(m.id);
    if (!job) return { status: 404, data: { error: 'job not found' } };
    if (job.slug && job.slug !== m.slug) {
      return { status: 404, data: { error: 'job not found' } };
    }
    return { status: 200, data: { job } };
  }

  m = match(url, mth, { method: 'DELETE', re: /^\/v1\/tenants\/(?<slug>[^/]+)$/ });
  if (m) {
    assertSlug(m.slug);
    const wipeData = body.wipeData === true
      || body.wipeData === 1
      || body.wipeData === '1'
      || query.wipeData === '1'
      || query.wipeData === 'true';
    const result = driver.destroy(m.slug, { wipeData });
    return { status: 200, data: result };
  }

  return {
    status: 501,
    data: {
      error: 'Not implemented',
      path: url,
      note: 'entitlements / nginx later',
    },
  };
}

module.exports = { handleV1 };
