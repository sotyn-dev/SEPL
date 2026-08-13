'use strict';

const express = require('express');
const { getDb } = require('../lib/db');
const { agentDispatch, listHosts, getHostRow, rowToHost, DEFAULT_HOST_ID } = require('../lib/agentClient');
const hub = require('../lib/agentHub');

const router = express.Router();

const HOST_ID_RE = /^[a-z][a-z0-9_]{1,47}$/;

function publicHost(row) {
  const h = rowToHost(row);
  if (h) h.wsOnline = hub.isOnline(row.id);
  return h;
}

router.get('/', async (_req, res) => {
  const hosts = listHosts();
  // Best-effort: attach legacyImportSlug from each agent /v1/host (UI one-shot button).
  await Promise.all(
    hosts.map(async (h) => {
      try {
        const { data } = await agentDispatch('/v1/host', { hostId: h.id });
        h.legacyImportSlug = data.legacyImportSlug || null;
        h.legacyDataDir = data.legacyDataDir || null;
        h.legacyBackupDir = data.legacyBackupDir || null;
      } catch {
        h.legacyImportSlug = null;
      }
    })
  );
  res.json({ hosts });
});

router.post('/', (req, res) => {
  const { id, label, agentUrl, agentToken, status = 'remote' } = req.body || {};
  if (!id || !HOST_ID_RE.test(id)) {
    return res.status(400).json({
      error: 'Invalid host id (lowercase letter start; letters, digits, underscore; max 48)',
    });
  }
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: 'label required' });
  }
  if (!agentUrl || !String(agentUrl).trim()) {
    return res.status(400).json({ error: 'agentUrl required' });
  }
  let url;
  try {
    url = new URL(String(agentUrl).trim());
  } catch {
    return res.status(400).json({ error: 'agentUrl must be a valid URL' });
  }
  if (!/^https?:$/.test(url.protocol)) {
    return res.status(400).json({ error: 'agentUrl must be http(s)' });
  }

  const db = getDb();
  if (db.prepare('SELECT 1 FROM hosts WHERE id = ?').get(id)) {
    return res.status(409).json({ error: 'Host id already exists' });
  }

  const normalized = String(agentUrl).trim().replace(/\/$/, '');
  db.prepare(`
    INSERT INTO hosts (id, label, agent_url, agent_token, status)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    id,
    String(label).trim(),
    normalized,
    agentToken ? String(agentToken) : null,
    String(status || 'remote').slice(0, 32),
  );

  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
  res.status(201).json({
    host: publicHost(row),
    note: agentToken
      ? 'Host registered with its own agent token.'
      : 'No agentToken stored — platform AGENT_TOKEN env will be used until you set one.',
  });
});

router.patch('/:id', (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Host not found' });

  const { label, agentUrl, agentToken, status, clearToken } = req.body || {};
  let nextLabel = row.label;
  let nextUrl = row.agent_url;
  let nextToken = row.agent_token;
  let nextStatus = row.status;

  if (label != null) {
    if (!String(label).trim()) return res.status(400).json({ error: 'label required' });
    nextLabel = String(label).trim();
  }
  if (agentUrl != null) {
    try {
      const u = new URL(String(agentUrl).trim());
      if (!/^https?:$/.test(u.protocol)) {
        return res.status(400).json({ error: 'agentUrl must be http(s)' });
      }
    } catch {
      return res.status(400).json({ error: 'agentUrl must be a valid URL' });
    }
    nextUrl = String(agentUrl).trim().replace(/\/$/, '');
  }
  if (clearToken) {
    nextToken = null;
  } else if (agentToken != null && String(agentToken).length > 0) {
    nextToken = String(agentToken);
  }
  if (status != null) {
    nextStatus = String(status).slice(0, 32);
  }

  db.prepare(`
    UPDATE hosts SET label = ?, agent_url = ?, agent_token = ?, status = ?
    WHERE id = ?
  `).run(nextLabel, nextUrl, nextToken, nextStatus, row.id);

  const updated = db.prepare('SELECT * FROM hosts WHERE id = ?').get(row.id);
  res.json({ host: publicHost(updated) });
});

router.delete('/:id', (req, res) => {
  const id = req.params.id;
  if (id === DEFAULT_HOST_ID) {
    return res.status(403).json({ error: 'Cannot delete host_local' });
  }
  const db = getDb();
  const row = db.prepare('SELECT * FROM hosts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'Host not found' });

  const n = db.prepare('SELECT COUNT(*) AS n FROM tenants WHERE host_id = ?').get(id).n;
  if (n > 0) {
    return res.status(409).json({
      error: `Host has ${n} tenant(s) assigned — reassign or remove them first`,
    });
  }

  db.prepare('DELETE FROM hosts WHERE id = ?').run(id);
  res.json({ ok: true, id });
});

/** Ping agent health + host info for this registry row. */
router.post('/:id/health', async (req, res) => {
  try {
    getHostRow(req.params.id);
    const { host, data } = await agentDispatch('/v1/health', { hostId: req.params.id });
    let detail = data;
    try {
      const h = await agentDispatch('/v1/host', { hostId: req.params.id });
      detail = { ...data, host: h.data };
    } catch {
      /* health alone is enough */
    }
    getDb().prepare('UPDATE hosts SET status = ? WHERE id = ?').run(
      data.docker === false ? 'degraded' : (hub.isOnline(req.params.id) ? 'online' : 'ok'),
      req.params.id,
    );
    res.json({
      ok: true,
      hostId: host.id,
      agentUrl: host.agentUrl,
      wsOnline: hub.isOnline(req.params.id),
      health: detail,
    });
  } catch (e) {
    try {
      getDb().prepare('UPDATE hosts SET status = ? WHERE id = ?').run('unreachable', req.params.id);
    } catch (_) {
      /* ignore */
    }
    res.status(e.status || 502).json({
      ok: false,
      error: e.message || String(e),
      detail: e.detail,
    });
  }
});

module.exports = router;
