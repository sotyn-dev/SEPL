'use strict';

const express = require('express');
const { getDb } = require('../lib/db');
const { agentFetch, DEFAULT_HOST_ID } = require('../lib/agentClient');
const { syncTenantEdge } = require('../lib/gatewayClient');
const { requireAdmin } = require('./users');

const router = express.Router();

const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;

function defaultHostname(slug) {
  return `${slug}-erp.sotyn.com`;
}

function normalizeHostname(raw, slug) {
  const h = String(raw || '').trim().toLowerCase() || defaultHostname(slug);
  if (!HOSTNAME_RE.test(h) || h.includes('..')) {
    const err = new Error('Invalid hostname');
    err.status = 400;
    throw err;
  }
  return h;
}

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
    hostname: row.hostname || defaultHostname(row.slug),
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

/** Update mutable identity fields (hostname). Slug is immutable. */
router.patch('/:slug', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
  if (!row) return res.status(404).json({ error: 'Tenant not found' });

  const { hostname: hostnameIn } = req.body || {};
  if (hostnameIn === undefined) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  let hostname;
  try {
    hostname = normalizeHostname(hostnameIn, row.slug);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const taken = db.prepare(
    'SELECT slug FROM tenants WHERE hostname = ? AND id != ?'
  ).get(hostname, row.id);
  if (taken) {
    return res.status(409).json({ error: `Hostname already used by ${taken.slug}` });
  }

  db.prepare(`
    UPDATE tenants SET hostname = ?, updated_at = datetime('now') WHERE id = ?
  `).run(hostname, row.id);

  const next = db.prepare('SELECT * FROM tenants WHERE id = ?').get(row.id);
  res.json({ tenant: rowToTenant(next) });
});

router.post('/', async (req, res) => {
  const {
    slug,
    displayName,
    tenantClass = 'mepf_erp',
    hostId = DEFAULT_HOST_ID,
    provision = false,
    hostname: hostnameIn,
  } = req.body || {};
  if (!slug || !/^[a-z0-9]([a-z0-9-]{0,46}[a-z0-9])?$/.test(slug)) {
    return res.status(400).json({ error: 'Invalid slug' });
  }
  if (!displayName || !String(displayName).trim()) {
    return res.status(400).json({ error: 'displayName required' });
  }

  let hostname;
  try {
    hostname = normalizeHostname(hostnameIn, slug);
  } catch (e) {
    return res.status(e.status || 400).json({ error: e.message });
  }

  const db = getDb();
  if (db.prepare('SELECT 1 FROM tenants WHERE slug = ?').get(slug)) {
    return res.status(409).json({ error: 'Slug already exists' });
  }
  const hostTaken = db.prepare('SELECT slug FROM tenants WHERE hostname = ?').get(hostname);
  if (hostTaken) {
    return res.status(409).json({ error: `Hostname already used by ${hostTaken.slug}` });
  }

  const host = db.prepare('SELECT * FROM hosts WHERE id = ?').get(hostId || DEFAULT_HOST_ID);
  if (!host) {
    return res.status(400).json({ error: `Unknown hostId: ${hostId}` });
  }

  const id = `tenant_${slug}`;
  db.prepare(`
    INSERT INTO tenants (id, slug, display_name, status, host_id, data_path, backup_path, hostname, s3_key_prefix, tenant_class)
    VALUES (?, ?, ?, 'draft', ?, NULL, NULL, ?, ?, ?)
  `).run(
    id,
    slug,
    String(displayName).trim(),
    host.id,
    hostname,
    slug,
    tenantClass,
  );
  db.prepare(`
    INSERT INTO tenant_branding (tenant_id, display_name, show_powered_by)
    VALUES (?, ?, 1)
  `).run(id, String(displayName).trim());

  let row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(id);
  let agent = null;
  let edge = null;

  if (provision) {
    try {
      const result = await provisionOnHost(row);
      if (result.async) {
        return res.status(202).json({
          tenant: rowToTenant(result.row),
          jobId: result.jobId,
          status: result.status,
          note: 'Draft created; legacy import job started — poll jobs until live.',
          importLegacy: true,
        });
      }
      row = result.row;
      agent = result.agent;
      edge = result.edge;
    } catch (e) {
      return res.status(e.status || 502).json({
        tenant: rowToTenant(row),
        error: e.message || String(e),
        detail: e.detail,
        note: 'Draft created in platform.db; agent provision failed — retry via Provision.',
      });
    }
  }

  res.status(201).json({ tenant: rowToTenant(row), agent, edge });
});

/** Call worker agent to create the Docker tenant on the org's assigned host. */
async function provisionOnHost(tenantRow, { importLegacy = false } = {}) {
  const db = getDb();
  const hostId = tenantRow.host_id || DEFAULT_HOST_ID;
  const body = { slug: tenantRow.slug };
  if (importLegacy) body.importLegacy = true;

  const { host, data } = await agentFetch('/v1/tenants', {
    hostId,
    method: 'POST',
    body: JSON.stringify(body),
  });

  // Async one-shot: rsync + provision job — caller polls; mark live when job ok.
  if (data.jobId) {
    return {
      async: true,
      jobId: data.jobId,
      status: data.status || 'queued',
      host,
      row: tenantRow,
    };
  }

  const agentTenant = data.tenant || data;
  const dataPath = agentTenant.dataPath || agentTenant.data_path || null;
  const backupPath = agentTenant.backupPath || agentTenant.backup_path || null;
  db.prepare(`
    UPDATE tenants
    SET status = 'live',
        data_path = COALESCE(?, data_path),
        backup_path = COALESCE(?, backup_path),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(dataPath, backupPath, tenantRow.id);

  const row = db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantRow.id);
  const port = agentTenant.port || agentTenant.publishedPort;
  const edge = port
    ? await syncTenantEdge(row, { port })
    : { skipped: true, reason: 'no port from agent' };
  return {
    async: false,
    row,
    agent: {
      hostId: host.id,
      hostLabel: host.label,
      tenant: agentTenant,
    },
    edge,
  };
}

function markTenantLiveFromAgent(tenantRow, agentTenant) {
  const db = getDb();
  const dataPath = agentTenant?.dataPath || agentTenant?.data_path || null;
  const backupPath = agentTenant?.backupPath || agentTenant?.backup_path || null;
  db.prepare(`
    UPDATE tenants
    SET status = 'live',
        data_path = COALESCE(?, data_path),
        backup_path = COALESCE(?, backup_path),
        updated_at = datetime('now')
    WHERE id = ?
  `).run(dataPath, backupPath, tenantRow.id);
  return db.prepare('SELECT * FROM tenants WHERE id = ?').get(tenantRow.id);
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
    const importLegacy = !!(req.body?.importLegacy || req.body?.import_legacy);
    const result = await provisionOnHost(fresh, { importLegacy });

    if (result.async) {
      return res.status(202).json({
        tenant: rowToTenant(result.row),
        jobId: result.jobId,
        status: result.status,
        hostId: result.host.id,
        hostLabel: result.host.label,
        importLegacy: true,
      });
    }

    res.json({
      tenant: rowToTenant(result.row),
      agent: result.agent,
      edge: result.edge,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.get('/:slug/logs', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const tail = req.query.tail || 200;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/logs?tail=${encodeURIComponent(tail)}`,
      { hostId }
    );
    res.json({
      tenant: rowToTenant(row),
      hostId: host.id,
      hostLabel: host.label,
      ...data,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.get('/:slug/backups', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/backups`,
      { hostId }
    );
    res.json({
      tenant: rowToTenant(row),
      hostId: host.id,
      hostLabel: host.label,
      ...data,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.post('/:slug/restore', requireAdmin, async (req, res) => {
  try {
    const file = req.body?.file || req.body?.filename;
    if (!file) return res.status(400).json({ error: 'file required' });

    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/restore`,
      {
        hostId,
        method: 'POST',
        body: JSON.stringify({ file }),
      }
    );
    res.status(202).json({
      tenant: rowToTenant(row),
      hostId: host.id,
      hostLabel: host.label,
      jobId: data.jobId,
      status: data.status,
      file: data.file,
      source: data.source,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.post('/:slug/backup', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/backup`,
      {
        hostId,
        method: 'POST',
        body: JSON.stringify({}),
      }
    );
    res.status(202).json({
      tenant: rowToTenant(row),
      hostId: host.id,
      hostLabel: host.label,
      jobId: data.jobId,
      status: data.status,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.get('/:slug/restore/jobs/:id', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/jobs/${encodeURIComponent(req.params.id)}`,
      { hostId }
    );
    res.json({
      hostId: host.id,
      hostLabel: host.label,
      job: data.job,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

router.get('/:slug/jobs/:id', async (req, res) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM tenants WHERE slug = ?').get(req.params.slug);
    if (!row) return res.status(404).json({ error: 'Tenant not found' });
    const hostId = row.host_id || DEFAULT_HOST_ID;
    const { host, data } = await agentFetch(
      `/v1/tenants/${encodeURIComponent(row.slug)}/jobs/${encodeURIComponent(req.params.id)}`,
      { hostId }
    );
    let tenant = rowToTenant(row);
    const job = data.job;
    if (
      job
      && job.status === 'ok'
      && job.type === 'import-provision'
      && job.tenant
      && row.status !== 'live'
    ) {
      const live = markTenantLiveFromAgent(row, job.tenant);
      tenant = rowToTenant(live);
    }
    res.json({
      hostId: host.id,
      hostLabel: host.label,
      job,
      tenant,
    });
  } catch (e) {
    res.status(e.status || 502).json({
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

module.exports = router;
