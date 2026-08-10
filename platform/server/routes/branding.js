'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const { getDb } = require('../lib/db');
const {
  ASSET_KINDS,
  ensureDir,
  durableAssetsDir,
  resolveAssetFile,
  relativeAssetPath,
} = require('../lib/assets');

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB
});

function brandingFromRow(row, slug) {
  if (!row) return null;
  let pwa = {};
  let assets = {};
  try { pwa = JSON.parse(row.pwa_json || '{}'); } catch { /* ignore */ }
  try { assets = JSON.parse(row.assets_json || '{}'); } catch { /* ignore */ }
  return {
    slug,
    displayName: row.display_name,
    shortName: row.short_name,
    legalName: row.legal_name,
    productMark: row.product_mark,
    showPoweredBy: !!row.show_powered_by,
    loginTagline: row.login_tagline,
    pwa,
    assets,
    updatedAt: row.updated_at,
  };
}

function getTenant(slug) {
  return getDb().prepare('SELECT id, slug FROM tenants WHERE slug = ?').get(slug);
}

function getBrandingRow(tenantId) {
  return getDb().prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenantId);
}

function parseAssets(row) {
  try {
    return JSON.parse(row?.assets_json || '{}');
  } catch {
    return {};
  }
}

router.get('/:slug', (req, res) => {
  const tenant = getTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const row = getBrandingRow(tenant.id);
  res.json({ branding: brandingFromRow(row, tenant.slug) });
});

router.put('/:slug', (req, res) => {
  const db = getDb();
  const tenant = getTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const b = req.body || {};
  const existing = getBrandingRow(tenant.id);
  const next = {
    display_name: b.displayName ?? existing?.display_name ?? tenant.slug,
    short_name: b.shortName ?? existing?.short_name ?? null,
    legal_name: b.legalName ?? existing?.legal_name ?? null,
    product_mark: b.productMark ?? existing?.product_mark ?? null,
    show_powered_by: b.showPoweredBy === undefined
      ? (existing?.show_powered_by ?? 1)
      : (b.showPoweredBy ? 1 : 0),
    login_tagline: b.loginTagline ?? existing?.login_tagline ?? null,
    pwa_json: JSON.stringify(b.pwa ?? (existing ? JSON.parse(existing.pwa_json || '{}') : {})),
    // Never wipe assets via text save unless client sends assets explicitly
    assets_json: b.assets !== undefined
      ? JSON.stringify(b.assets)
      : (existing?.assets_json || '{}'),
  };

  db.prepare(`
    INSERT INTO tenant_branding (
      tenant_id, display_name, short_name, legal_name, product_mark,
      show_powered_by, login_tagline, pwa_json, assets_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      display_name = excluded.display_name,
      short_name = excluded.short_name,
      legal_name = excluded.legal_name,
      product_mark = excluded.product_mark,
      show_powered_by = excluded.show_powered_by,
      login_tagline = excluded.login_tagline,
      pwa_json = excluded.pwa_json,
      assets_json = excluded.assets_json,
      updated_at = datetime('now')
  `).run(
    tenant.id,
    next.display_name,
    next.short_name,
    next.legal_name,
    next.product_mark,
    next.show_powered_by,
    next.login_tagline,
    next.pwa_json,
    next.assets_json
  );

  if (b.displayName) {
    db.prepare(`UPDATE tenants SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(b.displayName, tenant.id);
  }

  const row = getBrandingRow(tenant.id);
  res.json({ branding: brandingFromRow(row, tenant.slug) });
});

/**
 * Upload a branding asset into the durable store.
 * POST multipart field "file" → platform/data/tenants/{slug}/assets/
 * Updates tenant_branding.assets_json pointer for that kind.
 */
router.post('/:slug/assets/:kind', upload.single('file'), (req, res) => {
  const kind = req.params.kind;
  const spec = ASSET_KINDS[kind];
  if (!spec) {
    return res.status(400).json({
      error: `Unknown asset kind "${kind}"`,
      allowed: Object.keys(ASSET_KINDS),
    });
  }

  const tenant = getTenant(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  if (!req.file) {
    return res.status(400).json({ error: 'Missing file field "file"' });
  }

  const ext = path.extname(req.file.originalname || '').toLowerCase()
    || mimeToExt(req.file.mimetype);
  if (!spec.accept.includes(ext)) {
    return res.status(400).json({
      error: `Invalid type for ${kind}`,
      accept: spec.accept,
    });
  }

  const dir = durableAssetsDir(tenant.slug);
  ensureDir(dir);

  // Prefer kind-named file so overrides are obvious (logo.webp, icon.svg, …)
  const filename = `${spec.stem}${ext === '.jpeg' ? '.jpg' : ext}`;
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, req.file.buffer);

  const db = getDb();
  const existing = getBrandingRow(tenant.id);
  const assets = parseAssets(existing);
  assets[kind] = relativeAssetPath(filename);

  if (!existing) {
    db.prepare(`
      INSERT INTO tenant_branding (tenant_id, display_name, assets_json, updated_at)
      VALUES (?, ?, ?, datetime('now'))
    `).run(tenant.id, tenant.slug, JSON.stringify(assets));
  } else {
    db.prepare(`
      UPDATE tenant_branding
      SET assets_json = ?, updated_at = datetime('now')
      WHERE tenant_id = ?
    `).run(JSON.stringify(assets), tenant.id);
  }

  const row = getBrandingRow(tenant.id);
  res.status(201).json({
    ok: true,
    kind,
    path: assets[kind],
    store: 'durable',
    branding: brandingFromRow(row, tenant.slug),
  });
});

/** Serve durable first, then seed fallback. */
router.get('/:slug/assets/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const resolved = resolveAssetFile(req.params.slug, file);
  if (!resolved) return res.status(404).json({ error: 'Asset not found' });
  return res.sendFile(resolved);
});

function mimeToExt(mime) {
  switch (mime) {
    case 'image/webp': return '.webp';
    case 'image/png': return '.png';
    case 'image/jpeg': return '.jpg';
    case 'image/svg+xml': return '.svg';
    case 'image/x-icon':
    case 'image/vnd.microsoft.icon': return '.ico';
    default: return '';
  }
}

module.exports = router;
