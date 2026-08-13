'use strict';

/**
 * Worker agent — Docker driver for tenant ERP containers.
 * Platform talks here via HTTP :7200 and/or outbound WSS to Platform.
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
const { TENANTS_ROOT, ERP_ENV_FILE } = require('./lib/paths');
const { handleV1 } = require('./lib/httpApi');
const { startPlatformWs } = require('./lib/platformWs');

const PORT = Number(process.env.AGENT_PORT || 7200);
const BIND = process.env.AGENT_BIND || '127.0.0.1';
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

const server = http.createServer(async (req, res) => {
  try {
    const full = req.url || '/';
    const url = full.split('?')[0];
    const u = new URL(full, 'http://127.0.0.1');
    const query = Object.fromEntries(u.searchParams.entries());

    if (url === '/v1/health' && req.method === 'GET') {
      const out = await handleV1({ method: 'GET', path: url, query });
      return json(res, out.status, out.data);
    }

    if (!authorized(req)) {
      return json(res, 401, { error: 'Unauthorized' });
    }

    const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)
      ? await readBody(req).catch(() => ({}))
      : {};
    const out = await handleV1({
      method: req.method,
      path: url,
      body,
      query,
    });
    return json(res, out.status, out.data);
  } catch (e) {
    const code = e.status || 500;
    return json(res, code, { error: e.message || String(e), detail: e.detail });
  }
});

server.listen(PORT, BIND, () => {
  console.log(`[worker-agent] docker mode http://${BIND}:${PORT}/v1 (Bearer ${TOKEN})`);
  console.log(`[worker-agent] tenantsRoot=${TENANTS_ROOT}`);
  console.log(`[worker-agent] envFile=${ERP_ENV_FILE || '(none)'}`);
  startPlatformWs();
});
