'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const conf = require('./config');
const { normalizeHostname } = require('./routes');

function certbotAvailable() {
  if (conf.DRY_RUN) return { ok: true, dryRun: true };
  const r = spawnSync(conf.CERTBOT_BIN, ['--version'], { encoding: 'utf8' });
  if (r.error || r.status !== 0) {
    return { ok: false, error: (r.stderr || r.error && r.error.message || 'certbot missing').toString().trim() };
  }
  return { ok: true, version: (r.stdout || r.stderr || '').toString().trim() };
}

function certPaths(hostname) {
  const live = path.join(conf.CERT_LIVE_ROOT, hostname);
  return {
    live,
    fullchain: path.join(live, 'fullchain.pem'),
    privkey: path.join(live, 'privkey.pem'),
  };
}

function certExists(hostname) {
  const p = certPaths(hostname);
  return fs.existsSync(p.fullchain) && fs.existsSync(p.privkey);
}

/**
 * HTTP-01 ensure. Body: { hostname, email?, force? }
 */
function ensure(body = {}) {
  conf.ensureDirs();
  const hostname = normalizeHostname(body.hostname);
  const email = String(body.email || conf.CERTBOT_EMAIL || '').trim();
  const force = body.force === true || body.force === 1 || body.force === '1';

  if (certExists(hostname) && !force) {
    return {
      ok: true,
      hostname,
      already: true,
      issued: false,
      paths: certPaths(hostname),
    };
  }

  if (conf.DRY_RUN) {
    return {
      ok: true,
      hostname,
      dryRun: true,
      issued: false,
      already: false,
      message: 'GATEWAY_DRY_RUN=1 — skipped certbot; issue on a real primary with port 80',
    };
  }

  const avail = certbotAvailable();
  if (!avail.ok) {
    const err = new Error(`certbot unavailable: ${avail.error}`);
    err.status = 503;
    throw err;
  }

  if (!email) {
    const err = new Error('GATEWAY_CERTBOT_EMAIL or body.email required for HTTP-01');
    err.status = 400;
    throw err;
  }

  const args = [
    'certonly',
    '--webroot',
    '-w', conf.WEBROOT,
    '-d', hostname,
    '--non-interactive',
    '--agree-tos',
    '--email', email,
    '--keep-until-expiring',
  ];
  if (force) args.push('--force-renewal');

  const r = spawnSync(conf.CERTBOT_BIN, args, {
    encoding: 'utf8',
    timeout: 180000,
  });

  if (r.status !== 0) {
    return {
      ok: false,
      hostname,
      issued: false,
      detail: {
        status: r.status,
        stdout: (r.stdout || '').toString().slice(-2000),
        stderr: (r.stderr || '').toString().slice(-2000),
      },
      error: 'certbot failed',
    };
  }

  return {
    ok: true,
    hostname,
    issued: true,
    already: false,
    paths: certPaths(hostname),
  };
}

module.exports = {
  ensure,
  certbotAvailable,
  certExists,
  certPaths,
};
