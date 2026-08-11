'use strict';

const path = require('path');
const fs = require('fs');

/** Monorepo root (platform/worker-agent → ../..) */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const TENANTS_ROOT = process.env.TENANTS_ROOT
  ? path.resolve(process.env.TENANTS_ROOT)
  : path.join(REPO_ROOT, 'tenants');

const SECURED_DATA_PATH = process.env.SECURED_DATA_PATH
  ? path.resolve(process.env.SECURED_DATA_PATH)
  : path.join(REPO_ROOT, 'data');

const PORT_MIN = Number(process.env.AGENT_PORT_MIN || 5101);
const PORT_MAX = Number(process.env.AGENT_PORT_MAX || 5199);

const IMAGE = process.env.ERP_IMAGE || 'sotyn-erp:local';
const CONTAINER_DATA = '/app/data';
const CONTAINER_PORT = 5000;

/** Host env file for tenant containers (--env-file). Empty string disables. */
const ERP_ENV_FILE = (() => {
  if (process.env.ERP_ENV_FILE === '') return null;
  if (process.env.ERP_ENV_FILE) return path.resolve(process.env.ERP_ENV_FILE);
  const def = path.join(REPO_ROOT, '.env');
  return fs.existsSync(def) ? def : null;
})();

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/;
const TAG_RE = /^[a-zA-Z0-9._-]+$/;

function containerName(slug) {
  return `sotyn-tenant-${slug}`;
}

/**
 * Host folder to bind-mount. secured = adopt existing path (no tenants/secured).
 */
function dataPathFor(slug) {
  if (slug === 'secured') return SECURED_DATA_PATH;
  return path.join(TENANTS_ROOT, slug, 'data');
}

function assertSlug(slug) {
  if (!slug || typeof slug !== 'string' || !SLUG_RE.test(slug)) {
    const err = new Error('Invalid slug (lowercase letters, digits, hyphens; max 48)');
    err.status = 400;
    throw err;
  }
}

function assertTag(tag) {
  if (!tag || typeof tag !== 'string' || !TAG_RE.test(tag)) {
    const err = new Error('Invalid image tag (letters, digits, . _ -)');
    err.status = 400;
    throw err;
  }
}

function imageRef(tag) {
  return `sotyn-erp:${tag}`;
}

module.exports = {
  REPO_ROOT,
  TENANTS_ROOT,
  SECURED_DATA_PATH,
  PORT_MIN,
  PORT_MAX,
  IMAGE,
  ERP_ENV_FILE,
  CONTAINER_DATA,
  CONTAINER_PORT,
  containerName,
  dataPathFor,
  assertSlug,
  assertTag,
  imageRef,
  TAG_RE,
};
