'use strict';

const path = require('path');
const fs = require('fs');
const { DATA_DIR, SEED_ROOT } = require('./db');

/** Allowed branding asset kinds → stored filename stem */
const ASSET_KINDS = {
  logo: { stem: 'logo', accept: ['.webp', '.png', '.jpg', '.jpeg', '.svg'] },
  logoPng: { stem: 'logo', accept: ['.png'] },
  icon: { stem: 'icon', accept: ['.svg', '.png', '.webp'] },
  favicon: { stem: 'favicon', accept: ['.svg', '.png', '.ico'] },
  icons: { stem: 'icons', accept: ['.svg'] },
};

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

/** Durable per-tenant asset dir: platform/data/tenants/{slug}/assets */
function durableAssetsDir(slug) {
  return path.join(DATA_DIR, 'tenants', slug, 'assets');
}

function seedAssetsDir(slug) {
  return path.join(SEED_ROOT, slug, 'assets');
}

function resolveAssetFile(slug, filename) {
  const safe = path.basename(filename);
  const durable = path.join(durableAssetsDir(slug), safe);
  if (fs.existsSync(durable)) return durable;
  const seed = path.join(seedAssetsDir(slug), safe);
  if (fs.existsSync(seed)) return seed;
  return null;
}

function relativeAssetPath(filename) {
  return `assets/${path.basename(filename)}`;
}

module.exports = {
  ASSET_KINDS,
  ensureDir,
  durableAssetsDir,
  seedAssetsDir,
  resolveAssetFile,
  relativeAssetPath,
};
