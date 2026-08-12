'use strict';

const path = require('path');
const fs = require('fs');

/** Monorepo root (platform/worker-agent → ../..) */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

const TENANTS_ROOT = process.env.TENANTS_ROOT
  ? path.resolve(process.env.TENANTS_ROOT)
  : path.join(REPO_ROOT, 'tenants');

const PORT_MIN = Number(process.env.AGENT_PORT_MIN || 5101);
const PORT_MAX = Number(process.env.AGENT_PORT_MAX || 5199);

const IMAGE = process.env.ERP_IMAGE || 'sotyn-erp:local';
const CONTAINER_DATA = '/app/data';
const CONTAINER_BACKUPS = '/app/backups';
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

/** Host folder to bind-mount: TENANTS_ROOT/{slug}/data */
function dataPathFor(slug) {
  return path.join(TENANTS_ROOT, slug, 'data');
}

/** Host folder for ERP backup zips: TENANTS_ROOT/{slug}/backups */
function backupPathFor(slug) {
  return path.join(TENANTS_ROOT, slug, 'backups');
}

function resolveExistingDir(envKey) {
  const raw = process.env[envKey];
  if (!raw || !String(raw).trim()) return null;
  const p = path.resolve(String(raw).trim());
  try {
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return p;
  } catch {
    /* ignore */
  }
  return null;
}

/** One-shot import: which slug may rsync from LEGACY_* then provision. */
function legacyImportSlug() {
  const raw = process.env.LEGACY_IMPORT_SLUG;
  if (!raw || !String(raw).trim()) return null;
  const s = String(raw).trim().toLowerCase();
  return SLUG_RE.test(s) ? s : null;
}

function legacyDataDir() {
  return resolveExistingDir('LEGACY_DATA_DIR');
}

function legacyBackupDir() {
  return resolveExistingDir('LEGACY_BACKUP_DIR');
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
  PORT_MIN,
  PORT_MAX,
  IMAGE,
  ERP_ENV_FILE,
  CONTAINER_DATA,
  CONTAINER_BACKUPS,
  CONTAINER_PORT,
  containerName,
  dataPathFor,
  backupPathFor,
  legacyImportSlug,
  legacyDataDir,
  legacyBackupDir,
  assertSlug,
  assertTag,
  imageRef,
  TAG_RE,
};
