'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const path = require('path');
const express = require('express');
const cors = require('cors');
const { getDb, DB_PATH } = require('./lib/db');
const tenantsRouter = require('./routes/tenants');
const brandingRouter = require('./routes/branding');
const deployRouter = require('./routes/deploy');
const usersRouter = require('./routes/users');
const backups = require('./routes/backups');
const { router: authRouter, requireAuth } = require('./routes/auth');
const { scheduleNightly } = require('./lib/backup');

const PORT = Number(process.env.PLATFORM_PORT || 7100);
const app = express();

app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'sotyn-platform',
    db: DB_PATH,
    time: new Date().toISOString(),
  });
});

app.use('/api/auth', authRouter);

// Zip download allows ?token= for browser <a> streaming (before global JWT gate)
app.get('/api/backups/:file/download', backups.downloadHandler);

app.use(requireAuth);

app.get('/api/hosts', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM hosts ORDER BY created_at ASC').all();
  res.json({
    hosts: rows.map((h) => ({
      id: h.id,
      label: h.label,
      agentUrl: h.agent_url,
      status: h.status,
      createdAt: h.created_at,
    })),
  });
});

app.use('/api/tenants', tenantsRouter);
app.use('/api/branding', brandingRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/users', usersRouter.router);
app.use('/api/backups', backups.router);

// Warm DB + seed on boot
getDb();
scheduleNightly();

app.listen(PORT, '127.0.0.1', () => {
  console.log(`[platform] http://127.0.0.1:${PORT}  db=${DB_PATH}`);
});
