'use strict';

const express = require('express');
const { agentDispatch, getHost, listHosts } = require('../lib/agentClient');

const router = express.Router();

function resolveHostId(req) {
  return (
    req.query.hostId
    || req.body?.hostId
    || req.headers['x-host-id']
    || undefined
  );
}

/** List registered worker hosts (multi-VPS ready; day‑1 usually one). */
router.get('/hosts', (_req, res) => {
  try {
    res.json({ hosts: listHosts() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/host', (req, res) => {
  try {
    const host = getHost(resolveHostId(req));
    res.json({ host });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/images', async (req, res) => {
  try {
    const hostId = resolveHostId(req);
    const { host, data } = await agentDispatch('/v1/images', { hostId });
    res.json({ hostId: host.id, hostLabel: host.label, images: data.images || [] });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.delete('/images/:tag', async (req, res) => {
  try {
    const hostId = resolveHostId(req);
    const tag = encodeURIComponent(req.params.tag);
    const { host, data } = await agentDispatch(`/v1/images/${tag}`, {
      method: 'DELETE',
      hostId,
    });
    res.json({ hostId: host.id, ...data });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.post('/images/prune', async (req, res) => {
  try {
    const hostId = resolveHostId(req);
    const { keepLatest, keepLatestTag } = req.body || {};
    const { host, data } = await agentDispatch('/v1/images/prune', {
      method: 'POST',
      hostId,
      body: JSON.stringify({ keepLatest, keepLatestTag }),
    });
    res.json({ hostId: host.id, ...data });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tag, build, hostId: bodyHostId, keepLatest, pruneAfter } = req.body || {};
    const hostId = bodyHostId || resolveHostId(req);
    const { host, data, status } = await agentDispatch('/v1/deploy', {
      method: 'POST',
      hostId,
      body: JSON.stringify({ tag, build, keepLatest, pruneAfter }),
    });
    res.status(status === 202 ? 202 : 200).json({
      hostId: host.id,
      ...data,
      note: 'Deploy recreates containers only; host data/ is never deleted. Unused images auto-pruned (keep-N) unless pruneAfter:false.',
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const hostId = resolveHostId(req);
    const { host, data } = await agentDispatch(
      `/v1/deploy/jobs/${encodeURIComponent(req.params.id)}`,
      { hostId }
    );
    res.json({ hostId: host.id, job: data.job });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

module.exports = router;
