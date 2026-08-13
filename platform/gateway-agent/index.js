'use strict';

/**
 * Gateway agent — primary-only edge helper.
 * Writes nginx Sotyn fragments, HTTP-01 Certbot, nginx -t / reload.
 * Does not talk to Docker tenants (worker-agent owns that).
 */
const fs = require('fs');
const path = require('path');

(function loadGatewayEnv() {
  const file = path.join(__dirname, '..', 'gateway.env');
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
const conf = require('./lib/config');
const routes = require('./lib/routes');
const certs = require('./lib/certs');
const nginx = require('./lib/nginx');

const PORT = conf.PORT;
const BIND = conf.BIND;
const TOKEN = conf.TOKEN;

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

const server = http.createServer(async (req, res) => {
  try {
    const url = (req.url || '').split('?')[0];

    if (url === '/v1/health' && req.method === 'GET') {
      return json(res, 200, {
        ok: true,
        service: 'sotyn-gateway-agent',
        dryRun: conf.DRY_RUN,
        sotynDir: conf.SOTYN_DIR,
        webroot: conf.WEBROOT,
        nginxContainer: conf.NGINX_CONTAINER || null,
        certbot: certs.certbotAvailable(),
      });
    }

    if (!authorized(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    if (url === '/v1/routes/sync' && req.method === 'POST') {
      const body = await readBody(req);
      const result = routes.sync(body);
      const reload = await nginx.testAndReload();
      return json(res, 200, { ...result, reload });
    }

    if (url === '/v1/certs/ensure' && req.method === 'POST') {
      const body = await readBody(req);
      const result = await certs.ensure(body);
      if (result.ok !== false && (result.issued || result.already || result.dryRun)) {
        const refreshed = routes.refreshTls(result.hostname);
        const reload = await nginx.testAndReload();
        return json(res, 200, { ...result, refreshed, reload });
      }
      return json(res, result.ok === false ? 502 : 200, result);
    }

    return json(res, 404, { error: 'Not found', path: url });
  } catch (e) {
    const code = e.status || 500;
    return json(res, code, { error: e.message || String(e), detail: e.detail });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[gateway-agent] http://${BIND}:${PORT}/v1 (Bearer token set)`);
  console.log(`[gateway-agent] sotynDir=${conf.SOTYN_DIR} webroot=${conf.WEBROOT} dryRun=${conf.DRY_RUN}`);
});
