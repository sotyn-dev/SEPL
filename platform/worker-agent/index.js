'use strict';

/**
 * Worker agent — Docker driver for tenant ERP containers.
 * Platform talks here; mounts host data → /app/data and backups → /app/backups.
 * Deploy recreates containers only — never deletes host data/ or backups/.
 */
const fs = require('fs');
const path = require('path');

/** Load platform/agent.env before paths/driver read process.env (file wins only if unset). */
(function loadAgentEnv() {
  const file = path.join(__dirname, '..', 'agent.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if (
      (v.startsWith('"') && v.endsWith('"'))
      || (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
})();

const http = require('http');
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
} = require('./lib/paths');
const driver = require('./lib/dockerDriver');
const restore = require('./lib/restore');

const PORT = Number(process.env.AGENT_PORT || 7200);
const TOKEN = process.env.AGENT_TOKEN || 'dev-agent-token';

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorized(req) {
  const h = req.headers.authorization || '';
  return h === `Bearer ${TOKEN}`;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(Object.assign(new Error('Invalid JSON'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function match(url, method, pattern) {
  if (method !== pattern.method) return null;
  const m = url.match(pattern.re);
  return m ? m.groups || {} : null;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0];

    if (url === '/v1/health' && req.method === 'GET') {
      const d = driver.dockerAvailable();
      return json(res, 200, {
        ok: true,
        service: 'sotyn-worker-agent',
        mode: 'docker',
        docker: d.ok,
        dockerError: d.ok ? undefined : d.error,
      });
    }

    if (!authorized(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    if (url === '/v1/host' && req.method === 'GET') {
      const d = driver.dockerAvailable();
      return json(res, 200, {
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
      });
    }

    if (url === '/v1/images' && req.method === 'GET') {
      return json(res, 200, {
        hostId: process.env.HOST_ID || 'host_local',
        images: driver.listImages(),
      });
    }

    if (url === '/v1/images/prune' && req.method === 'POST') {
      const body = await readBody(req);
      const result = driver.pruneImages(body);
      return json(res, 200, {
        hostId: process.env.HOST_ID || 'host_local',
        ...result,
      });
    }

    let mImg = match(url, req.method, {
      method: 'DELETE',
      re: /^\/v1\/images\/(?<tag>[^/]+)$/,
    });
    if (mImg) {
      const result = driver.deleteImage(decodeURIComponent(mImg.tag));
      return json(res, 200, {
        hostId: process.env.HOST_ID || 'host_local',
        ...result,
      });
    }

    if (url === '/v1/deploy' && req.method === 'POST') {
      const body = await readBody(req);
      const result = driver.startDeploy(body);
      return json(res, 202, result);
    }

    let m = match(url, req.method, {
      method: 'GET',
      re: /^\/v1\/deploy\/jobs\/(?<id>[a-f0-9]+)$/,
    });
    if (m) {
      const job = driver.getDeployJob(m.id);
      if (!job) return json(res, 404, { error: 'job not found' });
      return json(res, 200, { job });
    }

    if (url === '/v1/tenants' && req.method === 'GET') {
      return json(res, 200, { tenants: driver.listTenants() });
    }

    if (url === '/v1/tenants' && req.method === 'POST') {
      const body = await readBody(req);
      if (body.importLegacy || body.import_legacy) {
        const result = driver.startImportProvision(body);
        return json(res, 202, result);
      }
      const tenant = driver.provision(body);
      return json(res, 201, { tenant });
    }

    m = match(url, req.method, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)$/ });
    if (m) {
      assertSlug(m.slug);
      const tenant = driver.getTenant(m.slug);
      if (!tenant) return json(res, 404, { error: 'tenant not found' });
      return json(res, 200, { tenant });
    }

    m = match(url, req.method, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/start$/ });
    if (m) {
      assertSlug(m.slug);
      return json(res, 200, { tenant: driver.start(m.slug) });
    }

    m = match(url, req.method, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/stop$/ });
    if (m) {
      assertSlug(m.slug);
      return json(res, 200, { tenant: driver.stop(m.slug) });
    }

    m = match(url, req.method, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/restart$/ });
    if (m) {
      assertSlug(m.slug);
      return json(res, 200, { tenant: driver.restart(m.slug) });
    }

    m = match(url, req.method, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/logs$/ });
    if (m) {
      assertSlug(m.slug);
      const q = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      const tail = q.get('tail');
      return json(res, 200, driver.getLogs(m.slug, { tail }));
    }

    m = match(url, req.method, { method: 'GET', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/backups$/ });
    if (m) {
      assertSlug(m.slug);
      return json(res, 200, restore.listBackups(m.slug));
    }

    m = match(url, req.method, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/restore$/ });
    if (m) {
      assertSlug(m.slug);
      const body = await readBody(req);
      const result = restore.startRestore(m.slug, body.file || body.filename);
      return json(res, 202, result);
    }

    m = match(url, req.method, { method: 'POST', re: /^\/v1\/tenants\/(?<slug>[^/]+)\/backup$/ });
    if (m) {
      assertSlug(m.slug);
      const result = restore.startBackup(m.slug);
      return json(res, 202, result);
    }

    m = match(url, req.method, {
      method: 'GET',
      re: /^\/v1\/tenants\/(?<slug>[^/]+)\/(?:restore\/)?jobs\/(?<id>[a-f0-9]+)$/,
    });
    if (m) {
      assertSlug(m.slug);
      const job = restore.getRestoreJob(m.id);
      if (!job) return json(res, 404, { error: 'job not found' });
      if (job.slug && job.slug !== m.slug) {
        return json(res, 404, { error: 'job not found' });
      }
      return json(res, 200, { job });
    }

    m = match(url, req.method, { method: 'DELETE', re: /^\/v1\/tenants\/(?<slug>[^/]+)$/ });
    if (m) {
      assertSlug(m.slug);
      const q = new URL(req.url || '/', 'http://127.0.0.1').searchParams;
      const body = await readBody(req).catch(() => ({}));
      const wipeData = body.wipeData === true
        || body.wipeData === 1
        || body.wipeData === '1'
        || q.get('wipeData') === '1'
        || q.get('wipeData') === 'true';
      const result = driver.destroy(m.slug, { wipeData });
      return json(res, 200, result);
    }

    return json(res, 501, {
      error: 'Not implemented',
      path: url,
      note: 'entitlements / nginx later',
    });
  } catch (e) {
    const code = e.status || 500;
    return json(res, code, { error: e.message || String(e), detail: e.detail });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[worker-agent] docker mode http://127.0.0.1:${PORT}/v1 (Bearer ${TOKEN})`);
  console.log(`[worker-agent] tenantsRoot=${TENANTS_ROOT}`);
  console.log(`[worker-agent] envFile=${ERP_ENV_FILE || '(none)'}`);
});
