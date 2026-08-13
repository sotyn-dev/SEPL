'use strict';

const fs = require('fs');
const path = require('path');
const conf = require('./config');

function normalizeHostname(h) {
  const s = String(h || '').trim().toLowerCase();
  if (!s || s.length > 253 || !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(s)) {
    const err = new Error('Invalid hostname');
    err.status = 400;
    throw err;
  }
  return s;
}

function normalizeUpstream(u) {
  const s = String(u || '').trim();
  if (!/^[a-zA-Z0-9._-]+:\d{1,5}$/.test(s)) {
    const err = new Error('Invalid upstream (want host:port)');
    err.status = 400;
    throw err;
  }
  return s;
}

function fragmentName(hostname) {
  return `${hostname.replace(/[^a-z0-9.-]/g, '_')}.conf`;
}

function loadState() {
  conf.ensureDirs();
  if (!fs.existsSync(conf.STATE_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(conf.STATE_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function saveState(state) {
  conf.ensureDirs();
  fs.writeFileSync(conf.STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function certExists(hostname) {
  const live = path.join(conf.CERT_LIVE_ROOT, hostname);
  return fs.existsSync(path.join(live, 'fullchain.pem'))
    && fs.existsSync(path.join(live, 'privkey.pem'));
}

/**
 * HTTP always (ACME). HTTPS block only when cert files exist — avoids nginx -t
 * failure before Certbot finishes.
 */
function renderFragment(hostname, upstream, { withTls } = {}) {
  const tls = withTls === undefined ? certExists(hostname) : !!withTls;
  const certDir = path.posix.join(
    conf.CERT_LIVE_ROOT.replace(/\\/g, '/'),
    hostname
  );
  let out = `# managed by sotyn-gateway-agent — do not edit by hand
# ${hostname} → ${upstream}

server {
  listen 80;
  listen [::]:80;
  server_name ${hostname};

  location ^~ /.well-known/acme-challenge/ {
    root ${conf.WEBROOT.replace(/\\/g, '/')};
    default_type "text/plain";
  }

  location / {
    ${tls ? 'return 301 https://$host$request_uri;' : `proxy_pass http://${upstream};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;`}
  }
}
`;
  if (tls) {
    out += `
server {
  listen 443 ssl;
  listen [::]:443 ssl;
  server_name ${hostname};

  ssl_certificate     ${certDir}/fullchain.pem;
  ssl_certificate_key ${certDir}/privkey.pem;

  location / {
    proxy_pass http://${upstream};
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
  }
}
`;
  }
  return out;
}

function writeFragment(hostname, upstream) {
  const file = path.join(conf.SOTYN_DIR, fragmentName(hostname));
  fs.writeFileSync(file, renderFragment(hostname, upstream), 'utf8');
  return { file, tls: certExists(hostname) };
}

/**
 * Body shapes:
 *   { hostname, upstream, action?: 'upsert'|'delete' }
 *   { routes: [ { hostname, upstream } ], action?: 'replace' }
 */
function sync(body = {}) {
  conf.ensureDirs();
  const state = loadState();
  const changed = [];
  const removed = [];

  if (Array.isArray(body.routes) && body.action === 'replace') {
    const next = {};
    for (const r of body.routes) {
      const hostname = normalizeHostname(r.hostname);
      const upstream = normalizeUpstream(r.upstream);
      next[hostname] = { hostname, upstream, updatedAt: new Date().toISOString() };
    }
    for (const hostname of Object.keys(state)) {
      if (!next[hostname]) {
        const file = path.join(conf.SOTYN_DIR, fragmentName(hostname));
        if (fs.existsSync(file)) fs.unlinkSync(file);
        removed.push(hostname);
      }
    }
    for (const [hostname, row] of Object.entries(next)) {
      writeFragment(hostname, row.upstream);
      changed.push(hostname);
    }
    saveState(next);
    return { ok: true, mode: 'replace', changed, removed, count: Object.keys(next).length };
  }

  const action = (body.action || 'upsert').toLowerCase();
  const hostname = normalizeHostname(body.hostname);

  if (action === 'delete') {
    const file = path.join(conf.SOTYN_DIR, fragmentName(hostname));
    if (fs.existsSync(file)) fs.unlinkSync(file);
    delete state[hostname];
    saveState(state);
    removed.push(hostname);
    return { ok: true, mode: 'delete', changed, removed };
  }

  const upstream = normalizeUpstream(body.upstream);
  const written = writeFragment(hostname, upstream);
  state[hostname] = { hostname, upstream, updatedAt: new Date().toISOString() };
  saveState(state);
  changed.push(hostname);
  return { ok: true, mode: 'upsert', changed, removed, upstream, tls: written.tls };
}

/** Re-write fragment after cert issue so :443 block appears. */
function refreshTls(hostname) {
  const state = loadState();
  const row = state[hostname];
  if (!row) {
    return { ok: false, reason: 'no route state for hostname' };
  }
  const written = writeFragment(hostname, row.upstream);
  return { ok: true, hostname, tls: written.tls, upstream: row.upstream };
}

module.exports = {
  sync,
  refreshTls,
  normalizeHostname,
  normalizeUpstream,
  renderFragment,
  loadState,
  certExists,
  writeFragment,
};
