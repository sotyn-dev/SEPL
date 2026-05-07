// Sentry MUST be required before express/route files so the v8 auto-
// instrumentation can hook into them. No-op if SENTRY_DSN is unset.
const sentry = require('./lib/sentry');

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { initializeDatabase } = require('./db/schema');

// Surface uncaught errors to Sentry (and the console). Without these,
// PM2 just silently restarts on a crash and we lose the stack trace.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  sentry.captureException(err);
});
process.on('unhandledRejection', (err) => {
  console.error('[unhandledRejection]', err);
  sentry.captureException(err);
});

const app = express();
const PORT = process.env.PORT || 5000;

// CORS - allow all origins in dev, restrict in production
app.use(cors({
  origin: process.env.NODE_ENV === 'production' ? false : '*',
  credentials: true
}));
app.use(express.json({ limit: '10mb' }));

// Trust proxy for cloud deployments
app.set('trust proxy', 1);

// File uploads
const multer = require('multer');
const fs = require('fs');
const uploadsDir = path.join(__dirname, '..', 'data', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024 } });

// Initialize DB
initializeDatabase();

// Seed the 20 MIS scorecard templates on first boot. Idempotent — re-runs
// when the table already has rows are no-ops.
try {
  const { seedScoringTemplates } = require('./db/seedScoring');
  const { getDb } = require('./db/schema');
  const r = seedScoringTemplates(getDb());
  if (r.seeded > 0) console.log(`[seed] scoring: seeded ${r.seeded} templates`);
} catch (e) {
  console.warn('[seed] scoring failed:', e.message);
}

// One-time cleanup: strip CSV-import quote artifacts ("""M/s X""") and
// extra whitespace from business_book text columns. Idempotent — only
// updates rows where the cleaned value differs.
try {
  const { getDb } = require('./db/schema');
  const db = getDb();
  const cols = ['client_name', 'company_name', 'project_name', 'district', 'state', 'po_number', 'category', 'employee_assigned'];
  const expr = (c) => `TRIM(REPLACE(REPLACE(REPLACE(REPLACE(${c}, '"', ''), CHAR(96), ''), CHAR(39), ''), CHAR(9), ' '))`;
  let total = 0;
  for (const c of cols) {
    const r = db.prepare(`UPDATE business_book SET ${c} = ${expr(c)} WHERE ${c} IS NOT NULL AND ${c} != ${expr(c)}`).run();
    total += r.changes || 0;
  }
  if (total > 0) console.log(`[cleanup] business_book: scrubbed ${total} cells`);
} catch (e) {
  // Non-fatal — DB may not have business_book yet
}

// Nightly DB backup scheduler — runs at 02:00 local time every day and
// keeps the last 30 backups. Backups go to ~/erp-backups on the VPS (or
// ../backups on Windows). Admin can also list / download / trigger manually
// via /api/admin/backups/*. Skip in dev via ERP_DISABLE_BACKUP_SCHEDULER=1.
if (!process.env.ERP_DISABLE_BACKUP_SCHEDULER) {
  try {
    const { scheduleNightly } = require('./scripts/backup-db');
    scheduleNightly();
  } catch (e) {
    console.warn('[backup] Scheduler not started:', e.message);
  }
}

// Audit middleware — runs before the routes so every mutating request
// (POST/PUT/PATCH/DELETE) is logged on response finish. Reads req.user set
// by authMiddleware inside each router. Fire-and-forget so it can't slow
// down or break real requests.
const { auditMiddleware } = require('./middleware/audit');
app.use(auditMiddleware);

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/admin/audit', require('./routes/audit'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/sales-funnel', require('./routes/salesfunnel'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/business-book', require('./routes/businessbook'));
app.use('/api/payment-required', require('./routes/paymentrequired'));
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/support', require('./routes/support'));
app.use('/api/item-master', require('./routes/itemmaster'));
app.use('/api/procurement', require('./routes/procurement'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/installation', require('./routes/installation'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/hr', require('./routes/hr'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/scoring', require('./routes/scoring'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/rentals', require('./routes/rentals'));
app.use('/api/snags', require('./routes/snags'));
app.use('/api/company-assets', require('./routes/companyAssets'));
app.use('/api/push', require('./routes/push'));

// Initialise VAPID keys on boot (auto-generates on first run, then
// persists in app_settings so PM2 restarts keep the same keys).
try {
  require('./lib/push').ensureVapid();
} catch (e) {
  console.warn('[push] VAPID init failed (web-push package may need npm install):', e.message);
}
app.use('/api/delegations', require('./routes/delegations'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/price-requests', require('./routes/pricerequests'));
app.use('/api/pms-tasks', require('./routes/pmstasks'));
app.use('/api/admin/backups', require('./routes/backups'));
app.use('/api/admin/word-count', require('./routes/wordcount'));
app.use('/api/admin/changelog', require('./routes/changelog'));
app.use('/api/admin/locations', require('./routes/locations'));
app.use('/api/inventory', require('./routes/inventory'));

// 4 Critical Systems
app.use('/api/cashflow', require('./routes/cashflow'));
app.use('/api/collections', require('./routes/collections'));
app.use('/api/indent-fms', require('./routes/indentfms'));
app.use('/api/dpr', require('./routes/dpr'));

// File upload endpoint
const { authMiddleware } = require('./middleware/auth');
app.post('/api/upload', authMiddleware, upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  res.json({ url: `/uploads/${req.file.filename}`, filename: req.file.originalname, size: req.file.size });
});

// Serve uploaded files
app.use('/uploads', express.static(uploadsDir));

// Health check for deployment platforms
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve React build in production
const clientBuild = path.join(__dirname, '..', 'client', 'dist');
const fs2 = require('fs');
if (fs2.existsSync(clientBuild)) {
  app.use(express.static(clientBuild));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      res.sendFile(path.join(clientBuild, 'index.html'));
    } else {
      // CRITICAL: must close the response for unmatched /api/* paths.
      // Without this `else`, the handler did nothing and the response
      // hung open for 60+ seconds — surfaced as 502/timeout in the
      // 13-endpoint audit on /api/orders (no GET / route) and
      // /api/expenses (route file doesn't exist).
      res.status(404).json({ error: 'Not found', path: req.path, method: req.method });
    }
  });
  console.log('Serving frontend from client/dist');
} else {
  console.log('WARNING: client/dist not found - API only mode');
  app.get('/', (req, res) => res.json({ status: 'API running', message: 'Frontend not built. Run: npm run build' }));
}

// Sentry's Express error handler — captures the error and forwards it
// to the next handler. No-op if Sentry isn't initialized.
sentry.setupExpressErrorHandler(app);

// Global Express error handler — MUST be after all routes. Ensures every
// crash in a route handler (including synchronous throws from better-sqlite3)
// returns a JSON body with the real error, instead of HTML or a blank 500.
// Without this, the client sees only "Request failed with status code 500"
// and has no way to know what actually broke.
app.use((err, req, res, next) => {
  console.error('[express-error]', req.method, req.originalUrl, '-', err.message);
  console.error(err.stack);
  if (res.headersSent) return next(err);
  res.status(500).json({
    error: err.message || 'Internal server error',
    path: req.originalUrl,
    method: req.method,
  });
});

const serverPort = process.env.PORT || 5000;
app.listen(serverPort, '0.0.0.0', () => {
  console.log(`\n======================================`);
  console.log(`  Business ERP Server`);
  console.log(`  Running on port ${serverPort}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================\n`);
});
