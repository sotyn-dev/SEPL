'use strict';

const express = require('express');
const { getDb } = require('../lib/db');

const router = express.Router();

function rowToTenant(row) {
  if (!row) return null;
  return {
    id: row.id,
    slug: row.slug,
    displayName: row.display_name,
    status: row.status,
    hostId: row.host_id,
    dataPath: row.data_path,
    s3KeyPrefix: row.s3_key_prefix,
    tenantClass: row.tenant_class,
    hostname: `${row.slug}-erp.sotyn.com`,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

router.get('/', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM tenants ORDER BY created_at ASC').all();
  res.json({ tenants: rows.map(rowToTenant) });
});

router.get('/:slug', (req, res) => {
  const row = getDb().prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Tenant not found' });
  res.json({ tenant: rowToTenant(row) });
});

router.post('/', (req, res) => {
  const { slug, displayName, tenantClass = 'mepf_erp' } = req.body || {};
  if (!slug || !/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }
  if (!displayName || !String(displayName).trim()) {
    return res.status(400).json({ error: 'displayName required' });
  }
  const db = getDb();
  if (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) {
    return res.status(409).json({ error: 'Slug already exists' });
  }
  const id = `tenant_${slug}`;
  db.prepare(`
    INSERT INTO tenants (id, slug, display_name, status, host_id, s3_key_prefix, tenant_class, data_path)
    VALUES (?, ?, ?, 'draft', 'host_local', ?, ?, ?)
  `).run(
    id,
    slug,
    String(displayName).trim(),
    slug,
    tenantClass,
    null
  );
  db.prepare(`
    INSERT INTO tenant_branding (tenant_id, display_name, show_powered_by)
    VALUES (?, ?, 1)
  `).run(id, String(displayName).trim());

  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  res.status(201).json({ tenant: rowToTenant(row) });
});

module.exports = router;
