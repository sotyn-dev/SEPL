'use strict';

const { spawnSync } = require('child_process');
const conf = require('./config');

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', shell: false, timeout: 60000 });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').toString(),
    stderr: (r.stderr || '').toString(),
    error: r.error ? r.error.message : undefined,
  };
}

function runShell(line) {
  const r = spawnSync(line, {
    encoding: 'utf8',
    shell: true,
    timeout: 60000,
  });
  return {
    ok: r.status === 0,
    status: r.status,
    stdout: (r.stdout || '').toString(),
    stderr: (r.stderr || '').toString(),
    error: r.error ? r.error.message : undefined,
  };
}

/**
 * Test + reload host or sibling nginx.
 * Prefer GATEWAY_NGINX_*_CMD; else docker kill -s HUP on GATEWAY_NGINX_CONTAINER.
 */
async function testAndReload() {
  if (conf.DRY_RUN) {
    return { ok: true, dryRun: true, skipped: true };
  }

  if (conf.NGINX_TEST_CMD) {
    const t = runShell(conf.NGINX_TEST_CMD);
    if (!t.ok) {
      const err = new Error('nginx test failed');
      err.status = 502;
      err.detail = t;
      throw err;
    }
  }

  if (conf.NGINX_RELOAD_CMD) {
    const r = runShell(conf.NGINX_RELOAD_CMD);
    if (!r.ok) {
      const err = new Error('nginx reload failed');
      err.status = 502;
      err.detail = r;
      throw err;
    }
    return { ok: true, via: 'reload_cmd' };
  }

  if (conf.NGINX_CONTAINER) {
    const t = run('docker', ['exec', conf.NGINX_CONTAINER, 'nginx', '-t']);
    if (!t.ok) {
      const err = new Error('nginx -t failed in container');
      err.status = 502;
      err.detail = t;
      throw err;
    }
    const r = run('docker', ['kill', '-s', 'HUP', conf.NGINX_CONTAINER]);
    if (!r.ok) {
      const err = new Error('nginx HUP failed');
      err.status = 502;
      err.detail = r;
      throw err;
    }
    return { ok: true, via: 'docker_hup', container: conf.NGINX_CONTAINER };
  }

  return {
    ok: true,
    skipped: true,
    message: 'No GATEWAY_NGINX_CONTAINER / RELOAD_CMD — conf written; reload nginx yourself',
  };
}

module.exports = { testAndReload };
