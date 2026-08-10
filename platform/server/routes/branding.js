'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const { getDb, SEED_ROOT } = require('../lib/db');

const router = express.Router();

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
    themeColor: row.theme_color,
    accentColor: row.accent_color,
    loginTagline: row.login_tagline,
    pwa,
    assets,
    updatedAt: row.updated_at,
  };
}

router.get('/:slug', (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT id, slug FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });
  const row = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenant.id);
  res.json({ branding: brandingFromRow(row, tenant.slug) });
});

router.put('/:slug', (req, res) => {
  const db = getDb();
  const tenant = db.prepare('SELECT id, slug FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

  const b = req.body || {};
  const existing = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenant.id);
  const next = {
    display_name: b.displayName ?? existing?.display_name ?? tenant.slug,
    short_name: b.shortName ?? existing?.short_name ?? null,
    legal_name: b.legalName ?? existing?.legal_name ?? null,
    product_mark: b.productMark ?? existing?.product_mark ?? null,
    show_powered_by: b.showPoweredBy === undefined
      ? (existing?.show_powered_by ?? 1)
      : (b.showPoweredBy ? 1 : 0),
    theme_color: b.themeColor ?? existing?.theme_color ?? null,
    accent_color: b.accentColor ?? existing?.accent_color ?? null,
    login_tagline: b.loginTagline ?? existing?.login_tagline ?? null,
    pwa_json: JSON.stringify(b.pwa ?? (existing ? JSON.parse(existing.pwa_json || '{}') : {})),
    assets_json: JSON.stringify(b.assets ?? (existing ? JSON.parse(existing.assets_json || '{}') : {})),
  };

  db.prepare(`
    INSERT INTO tenant_branding (
      tenant_id, display_name, short_name, legal_name, product_mark,
      show_powered_by, theme_color, accent_color, login_tagline, pwa_json, assets_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(tenant_id) DO UPDATE SET
      display_name = excluded.display_name,
      short_name = excluded.short_name,
      legal_name = excluded.legal_name,
      product_mark = excluded.product_mark,
      show_powered_by = excluded.show_powered_by,
      theme_color = excluded.theme_color,
      accent_color = excluded.accent_color,
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
    next.theme_color,
    next.accent_color,
    next.login_tagline,
    next.pwa_json,
    next.assets_json
  );

  if (b.displayName) {
    db.prepare(`UPDATE tenants SET display_name = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(b.displayName, tenant.id);
  }

  const row = db.prepare('SELECT * FROM tenant_branding WHERE tenant_id = ?').get(tenant.id);
  res.json({ branding: brandingFromRow(row, tenant.slug) });
});

/** Serve seeded / uploaded brand assets for a tenant (dev + platform preview). */
router.get('/:slug/assets/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const seedFile = path.join(SEED_ROOT, req.params.slug, 'assets', file);
  if (fs.existsSync(seedFile)) {
    return res.sendFile(seedFile);
  }
  return res.status(404).json({ error: 'Asset not found' });
});

module.exports = router;
