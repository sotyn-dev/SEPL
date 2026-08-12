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
const hostsRouter = require('./routes/hosts');
const auditRouter = require('./routes/audit');
const { router: authRouter, requireAuth } = require('./routes/auth');
const { auditMiddleware } = require('./lib/audit');
const { scheduleNightly } = require('./lib/backup');

const PORT = Number(process.env.PLATFORM_PORT || 7100);
const BIND = process.env.PLATFORM_BIND || '127.0.0.1';
const SERVE_STATIC = process.env.PLATFORM_SERVE_STATIC === '1'
  || process.env.PLATFORM_SERVE_STATIC === 'true';
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');
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

if (SERVE_STATIC) {
  app.use(express.static(CLIENT_DIST));
}

app.use(requireAuth);
app.use(auditMiddleware);

app.use('/api/hosts', hostsRouter);
app.use('/api/tenants', tenantsRouter);
app.use('/api/branding', brandingRouter);
app.use('/api/deploy', deployRouter);
app.use('/api/users', usersRouter.router);
app.use('/api/backups', backups.router);
app.use('/api/audit', auditRouter);

if (SERVE_STATIC) {
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api')) return next();
    res.sendFile(path.join(CLIENT_DIST, 'index.html'), (err) => {
      if (err) next(err);
    });
  });
}

// Warm DB + seed on boot
getDb();
scheduleNightly();

app.listen(PORT, BIND, () => {
  console.log(`[platform] http://${BIND}:${PORT}  db=${DB_PATH}${SERVE_STATIC ? '  static=on' : ''}`);
});
