'use strict';

const path = require('path');
const fs = require('fs');

const PORT = Number(process.env.GATEWAY_PORT || 7300);
const BIND = process.env.GATEWAY_BIND || '127.0.0.1';
const TOKEN = process.env.GATEWAY_TOKEN || 'dev-gateway-token';

const SOTYN_DIR = process.env.GATEWAY_SOTYN_DIR
  || path.join(__dirname, '..', 'data', 'gateway', 'sotyn.d');
const WEBROOT = process.env.GATEWAY_WEBROOT
  || path.join(__dirname, '..', 'data', 'gateway', 'acme');
const STATE_FILE = process.env.GATEWAY_STATE_FILE
  || path.join(__dirname, '..', 'data', 'gateway', 'routes.json');
const CERT_LIVE_ROOT = process.env.GATEWAY_CERT_LIVE_ROOT || '/etc/letsencrypt/live';
const NGINX_CONTAINER = process.env.GATEWAY_NGINX_CONTAINER || '';
const NGINX_TEST_CMD = process.env.GATEWAY_NGINX_TEST_CMD || '';
const NGINX_RELOAD_CMD = process.env.GATEWAY_NGINX_RELOAD_CMD || '';
const DRY_RUN = process.env.GATEWAY_DRY_RUN === '1'
  || process.env.GATEWAY_DRY_RUN === 'true';
const CERTBOT_EMAIL = process.env.GATEWAY_CERTBOT_EMAIL || '';
const CERTBOT_BIN = process.env.GATEWAY_CERTBOT_BIN || 'certbot';

function ensureDirs() {
  fs.mkdirSync(SOTYN_DIR, { recursive: true });
  fs.mkdirSync(WEBROOT, { recursive: true });
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
}

module.exports = {
  PORT,
  BIND,
  TOKEN,
  SOTYN_DIR,
  WEBROOT,
  STATE_FILE,
  CERT_LIVE_ROOT,
  NGINX_CONTAINER,
  NGINX_TEST_CMD,
  NGINX_RELOAD_CMD,
  DRY_RUN,
  CERTBOT_EMAIL,
  CERTBOT_BIN,
  ensureDirs,
};
