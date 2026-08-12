'use strict';

const express = require('express');
const { getDb } = require('../lib/db');
const { agentFetch, DEFAULT_HOST_ID } = require('../lib/agentClient');

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
    backupPath: row.backup_path,
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

router.post('/', async (req, res) => {
  const {
    slug,
    displayName,
    tenantClass = 'mepf_erp',
    hostId = DEFAULT_HOST_ID,
    provision = false,
  } = req.body || {};
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

  const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId || DEFAULT_HOST_ID);
  if (!host) {
    return res.status(400).json({ error: `Unknown hostId: ${hostId}` });
  }

  const id = `tenant_${slug}`;
  db.prepare(`
    INSERT INTO tenants (id, slug, display_name, status, host_id, data_path, backup_path, s3_key_prefix, tenant_class)
    VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?)
  `).run(
    id,
    slug,
    String(displayName).trim(),
    host.id,
    slug,
    tenantClass,
  );
  db.prepare(`
    INSERT INTO tenant_branding (tenant_id, display_name, show_powered_by)
    VALUES (?, ?, 1)
  `).run(id, String(displayName).trim());

  let row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  let agent = null;

  if (provision) {
    try {
      const result = await provisionOnHost(row);
      row = result.row;
      agent = result.agent;
    } catch (e) {
      return res.status(e.status || 502).json({
        tenant: rowToTenant(row),
        error: e.message || String(e),
        detail: e.detail,
        note: 'Draft created in platform.db; agent provision failed — retry via Provision.',
      });
    }
  }

  res.status(201).json({ tenant: rowToTenant(row), agent });
});

/** Call worker agent to create the Docker tenant on the org's assigned host. */
async function provisionOnHost(tenantRow) {
  const db = getDb();
  const hostId = tenantRow.host_id || DEFAULT_HOST_ID;
  const { host, data } = await agentFetch('/v1/tenants', {
    hostId,
    method: 'POST',
    body: JSON.stringify({ slug: tenantRow.slug }),
  });

  const dataPath = data.dataPath || data.data_path || null;
  const backupPath = data.backupPath || data.backup_path || null;
  db.prepare(`
    UPDATE tenants
    SET status = 'live',
        data_path = COALESCE(?, data_path),
        backup_path = COALESCE(?, backup_path),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(dataPath, backupPath, tenantRow.id);

  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantRow.id);
  return {
    row,
    agent: {
      hostId: host.id,
      hostLabel: host.label,
      tenant: data,
    },
  };
}

router.post('/:slug/provision', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });

    if (req.body?.hostId) {
      const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(req.body.hostId);
      if (!host) return res.status(400).json({ error: `Unknown hostId: ${req.body.hostId}` });
      if (row.status === 'live' && row.host_id && row.host_id !== host.id) {
        return res.status(409).json({
          error: 'Tenant already live on another host — move between VPS is not built yet',
        });
      }
      db.prepare('UPDATE tenants SET host_id = ?, updated_at = datetime(\'now\') WHERE id = ?')
        .run(host.id, row.id);
    }

    const fresh = db.prepare('SELECT * FROM tenants WHERE id = ?').get(row.id);
    const result = await provisionOnHost(fresh);
    res.json({ tenant: rowToTenant(result.row), agent: result.agent });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

module.exports = router;
