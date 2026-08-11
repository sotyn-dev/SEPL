'use strict';

const express = require('express');
const { agentFetch, getLocalHost } = require('../lib/agentClient');

const router = express.Router();

router.get('/host', (_req, res) => {
  try {
    const host = getLocalHost();
    res.json({ host });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

router.get('/images', async (_req, res) => {
  try {
    const { host, data } = await agentFetch('/v1/images');
    res.json({ hostId: host.id, images: data.images || [] });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.post('/', async (req, res) => {
  try {
    const { tag, build } = req.body || {};
    const { host, data, status } = await agentFetch('/v1/deploy', {
      method: 'POST',
      body: JSON.stringify({ tag, build }),
    });
    res.status(status === 202 ? 202 : 200).json({
      hostId: host.id,
      ...data,
      note: 'Deploy recreates containers only; host data/ is never deleted',
    });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

router.get('/jobs/:id', async (req, res) => {
  try {
    const { host, data } = await agentFetch(`/v1/deploy/jobs/${encodeURIComponent(req.params.id)}`);
    res.json({ hostId: host.id, job: data.job });
  } catch (e) {
    res.status(e.status || 502).json({ error: e.message, detail: e.detail });
  }
});

module.exports = router;
