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

// Gzip compression — typical 60-80% smaller JSON responses, faster pages
// over slow networks (mobile / site engineers on 4G). Skip very small
// responses (level=6 default).
try {
  const compression = require('compression');
  app.use(compression());
  console.log('[perf] gzip compression enabled');
} catch (e) {
  console.warn('[perf] compression not installed — run npm install for faster pages');
}


// Hang detector — logs [slow] requests and [lag] event-loop stalls with the
// requests in flight, so `pm2 logs erp | grep -E '\[slow\]|\[lag\]'` names
// what froze the ERP (see lib/hangDetector.js). Must sit before the routers.
try { require('./lib/hangDetector').install(app); }
catch (e) { console.warn('[hang-detector] not started:', e.message); }

// Sotyn Leads public webhook. Mounted AFTER the hang detector so the one
// internet-facing route still gets [slow] logging and in-flight tracking, but
// BEFORE the global 10 MB JSON parser so its own 32 kb cap is real — behind
// that parser the cap was dead code and an unauthenticated caller could push
// 10 MB through a synchronous server (audit 2026-09-07).
app.use('/api/public', require('./routes/publicSotynLead'));

// Global body parser for every OTHER route. Deliberately last of the three:
// the hang detector must see all traffic, and the public webhook must parse
// its own body under a 32 kb cap before this 10 MB one can claim it.
app.use(express.json({ limit: '10mb' }));

// Cache static assets (logo, icons, JS bundles) for 1 day in browser.
// React build files have content-hashed filenames so they invalidate
// automatically on next deploy — safe to cache aggressively.
app.use((req, res, next) => {
  if (req.path.startsWith('/assets/') || req.path.endsWith('.webp') || req.path.endsWith('.png') || req.path.endsWith('.svg') || req.path.endsWith('.css') || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'public, max-age=86400');
  }
  next();
});

// Trust proxy for cloud deployments
app.set('trust proxy', 1);

// File uploads
const multer = require('multer');
const { UPLOADS_ROOT, SWEEP_FOLDERS, uploadsSub, ensureDir } = require('./lib/paths');
const quarantine = require('./lib/quarantine');
const storage = require('./lib/storage');
const uploadsDir = ensureDir(UPLOADS_ROOT);
// Uploads for these modules go into their own subfolder (whitelisted, so no path
// traversal) so the orphan sweep can target only them; everything else stays flat.
const UPLOAD_FOLDER_WHITELIST = new Set(SWEEP_FOLDERS);
const uploadFolder = (req) => {
  const f = String((req.query && req.query.folder) || '');
  return UPLOAD_FOLDER_WHITELIST.has(f) ? f : '';
};
// diskStorage, NOT memoryStorage. This is the busiest upload path in the app (site-chat,
// help-tickets, sotyn-flow, avatars, Business Book, Checklists, DPR), and memoryStorage
// buffers the whole file in RAM before it is written anywhere — 20 MB x concurrent
// uploads on a 1-2 GB VPS. diskStorage streams the request straight to disk, so memory
// stays flat no matter how many people upload at once.
//
// Reaching S3 is then storage.adoptLocalFile()'s job (see the handler): it streams the
// file up and unlinks it. Inline S3 without ever holding a file in memory.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const f = uploadFolder(req);
      cb(null, f ? ensureDir(uploadsSub(f)) : uploadsDir);
    },
    // <epoch>-<rand>-<sanitised name>. The random block matters: with only a timestamp,
    // two people uploading "photo.jpg" in the SAME millisecond produced the same name and
    // the second silently overwrote the first — on disk before, and in the bucket now.
    // The other upload routes (kit-/rt-/hr-) already do this; this brings /api/upload in
    // line. Only NEW filenames change; existing DB rows and objects are untouched.
    filename: (req, file, cb) => cb(null, `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`),
  }),
  limits: { fileSize: 20 * 1024 * 1024 },
});
// multer has already chosen the filename; the seam key is just <folder>/<that name>.
const uploadKey = (req, file) => {
  const f = uploadFolder(req);
  return f ? `${f}/${file.filename}` : file.filename;
};

// Initialize DB
initializeDatabase();

// Lock in the JWT signing secret NOW, while the DB is guaranteed ready and
// before any request can arrive. getSecret() persists the secret in
// app_settings on first call and memoizes it; calling it eagerly here
// removes the last "DB not ready → seed fallback → secret flips → everyone
// logged out" window (mam, repeatedly: "automatically logout — very bad").
// The boot log lets us confirm the secret is stable instead of guessing the
// next time a logout is reported.
try {
  const { getSecret } = require('./middleware/auth');
  if (typeof getSecret === 'function') {
    getSecret();
    console.log('[auth] JWT secret locked in at boot (stable across restarts)');
  }
} catch (e) {
  console.warn('[auth] could not pre-lock JWT secret:', e.message);
}

// Seed the 20 MIS scorecard templates on first boot. Idempotent — re-runs
// when the table already has rows are no-ops.
try {
  const { seedScoringTemplates } = require('./db/seedScoring');
  const { getDb } = require('./db/schema');
  const r = seedScoringTemplates(getDb());
  if (r.seeded > 0) console.log(`[seed] scoring: seeded ${r.seeded} templates`);
  if (r.raciAdded > 0) console.log(`[seed] scoring: added RACI row to ${r.raciAdded} templates`);
} catch (e) {
  console.warn('[seed] scoring failed:', e.message);
}

// Solar Quotation module — create tables + seed the rate book on first boot
// (mam 2026-06-21). Idempotent: tables use IF NOT EXISTS, rows only seed when
// each table is empty. Skip via ERP_DISABLE_SOLAR_SEED=1.
if (!process.env.ERP_DISABLE_SOLAR_SEED) {
  try {
    const { initSolar } = require('./db/seedSolar');
    const { getDb } = require('./db/schema');
    const r = initSolar(getDb());
    if (r.seeded > 0) console.log(`[seed] solar: seeded ${r.seeded} rate rows`);
  } catch (e) {
    console.warn('[seed] solar failed:', e.message);
  }
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

// Nightly DB compaction — checkpoints the WAL into each DB and VACUUMs when
// there's meaningful free space, so erp.db/chat.db actually shrink after
// deletes instead of only ever growing.
//
// DEFAULT-OFF (opt-in, not opt-out): VACUUM's temp rewrite may route through
// RAM (temp_store=MEMORY is set on erp.db) and this hasn't been measured
// against prod's real DB size on the VPS's 1-2 GB RAM. better-sqlite3 is also
// synchronous, so VACUUM blocks the whole Node event loop for its duration —
// unmeasured how long that is at scale. Until a VACUUM has been run against a
// copy of prod erp.db with RSS watched, leave this off and run
// `node server/scripts/db-maintenance.js` by hand when reclaiming is actually
// wanted. Set ERP_ENABLE_DB_MAINTENANCE=1 to arm the nightly scheduler.
if (process.env.ERP_ENABLE_DB_MAINTENANCE) {
  try {
    const { scheduleNightlyMaintenance } = require('./scripts/db-maintenance');
    scheduleNightlyMaintenance();
  } catch (e) {
    console.warn('[db-maint] Scheduler not started:', e.message);
  }
} else {
  console.log('[db-maint] Scheduler not started: set ERP_ENABLE_DB_MAINTENANCE=1 to enable.');
}

// Nightly uploads → S3 migration at 02:30. Ordering is deliberate: 02:00 backup
// captures the DB rows that reference these files, 02:15 compaction settles the DBs,
// and only THEN are files moved off local disk — so a restore point always exists
// before anything leaves. Never move this earlier.
//
// It self-disables (no timer at all) unless STORAGE_DRIVER=s3, so on the local driver
// this is inert. It exists to cover the feature routes that still write to local disk —
// they need no code change — plus any file whose inline push failed while the bucket was
// unreachable. Skip in dev via ERP_DISABLE_UPLOADS_BACKFILL=1.
if (!process.env.ERP_DISABLE_UPLOADS_BACKFILL) {
  try {
    const { scheduleNightlyBackfill } = require('./scripts/backfill-uploads-s3');
    scheduleNightlyBackfill();
  } catch (e) {
    console.warn('[backfill] Scheduler not started:', e.message);
  }
}

// 02:20 orphan sweep — slots between 02:15 compaction and the 02:30 S3 backfill, so
// orphans are quarantined BEFORE we pay to upload them, and after the 02:00 backup has
// captured the rows that reference them.
//
// Opt-in twice over: no timer at all unless ERP_ENABLE_SWEEP_CRON=1, and dry-run even
// then unless ERP_SWEEP_CRON_DRYRUN=0. Without this the QUARANTINE_TTL never fired
// outside a manual admin run, so quarantined files accumulated forever.
try {
  const { scheduleNightlySweep } = require('./scripts/sweep-uploads');
  scheduleNightlySweep();
} catch (e) {
  console.warn('[sweep] Scheduler not started:', e.message);
}

// Daily 07:30 AM audit JSON snapshot — TOC v3 P0 #5.  Writes the same
// JSON the /audit endpoints return into data/audit-snapshots/<date>/
// so the CMD's 09:00 email and the four role dashboards can render
// from a fixed "as of this morning" file.  Skip via
// ERP_DISABLE_AUDIT_SNAPSHOT=1 (dev / local runs).
try {
  const { scheduleDailyAuditSnapshot } = require('./scripts/dailyAuditSnapshot');
  scheduleDailyAuditSnapshot();
} catch (e) {
  console.warn('[audit-snapshot] Scheduler not started:', e.message);
}

// Daily 18:00 DPR auto-prompt — TOC v3 P1 #4.  Pushes a notification
// to every site engineer who hasn't submitted today's DPR for their
// active site(s).  Sunday off.  Sends a rollup to admins when overall
// adherence is below 50%.  Skip via ERP_DISABLE_DPR_PROMPT=1.
try {
  const { scheduleDprAutoPrompt } = require('./scripts/dprAutoPrompt');
  scheduleDprAutoPrompt();
} catch (e) {
  console.warn('[dpr-prompt] Scheduler not started:', e.message);
}

// Daily 09:00 morning-manpower reminder — SPOS (mam 2026-07-29). Pushes a
// notification to every site engineer whose active site has no contractor
// attendance punched yet today. Skip via ERP_DISABLE_PUNCH_PROMPT=1.
try {
  const { scheduleMorningPunchPrompt } = require('./scripts/morningPunchPrompt');
  scheduleMorningPunchPrompt();
} catch (e) {
  console.warn('[punch-prompt] Scheduler not started:', e.message);
}

// Daily 18:30 SPOS Exception Report — SPOS (mam 2026-07-29). The Project
// Coordinator's evening review, automated: sites missing morning punch /
// DPR / photos / approved weekly plan go to admins (in-app) + director
// (email). Skip via ERP_DISABLE_SPOS_REPORT=1.
try {
  const { scheduleSposExceptionReport } = require('./scripts/sposExceptionReport');
  scheduleSposExceptionReport();
} catch (e) {
  console.warn('[spos-report] Scheduler not started:', e.message);
}

// Bank statement mailbox poll (mam 2026-09-04) — the bank emails the
// statement, the ERP collects it and imports it, so nobody uploads anything.
// Inert until BANK_MAIL_* is set in .env. Skip via ERP_DISABLE_BANK_MAIL=1.
try {
  const { scheduleBankMailCron } = require('./scripts/bankMailCron');
  scheduleBankMailCron();
} catch (e) {
  console.warn('[bank-mail] Scheduler not started:', e.message);
}

// AR collection-day auto-roll — daily 01:00 moves unpaid, overdue AR entries
// to the next Mon/Thu (mam 2026-06-18). Skip via ERP_DISABLE_ARAP_ROLL=1.
try {
  const { scheduleArApRollCron } = require('./scripts/arApRollCron');
  scheduleArApRollCron();
} catch (e) {
  console.warn('[arap-roll] Scheduler not started:', e.message);
}

// Cash fidelity cron — audit items A7 + A14.  Daily 00:00 rolls over
// cash_flow_daily (so runway numbers don't drift on no-collection
// days); daily 01:00 recomputes receivables ageing across the board
// (replaces the manual "Refresh Ageing" button as primary truth).
// Skip via ERP_DISABLE_CASH_CRON=1.
try {
  const { scheduleCashFidelity } = require('./scripts/cashFidelityCron');
  scheduleCashFidelity();
} catch (e) {
  console.warn('[cash-fidelity] Scheduler not started:', e.message);
}

// Item Master cleanup — mam (2026-05-16): "correct item wise master
// sheet unit as per market if our wrong and no need duplicacy and
// correct the spelling".  One-shot, idempotent via
// app_settings.item_master_cleanup_v1.  Skip via
// ERP_DISABLE_ITEM_CLEANUP=1.
try {
  require('./scripts/itemMasterCleanup').runOnce();
} catch (e) {
  console.warn('[item-master-cleanup] failed to start:', e.message);
}

// One-time rate import — mam (2026-06-01): "according to this excel
// update rate in item wise in erp".  Reads data/itemwise-rates-
// 2026-06-01.json and updates item_master.current_price for the 140
// rows mam shared.  Guarded by an app_settings flag so it runs
// exactly once after deploy.  Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1.
try {
  require('./scripts/itemwiseRateImport').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import] failed to start:', e.message);
}

// v2 — second-pass rate import (mam 2026-06-01): broader CSV
// export with 2,496 rate rows.  Separate flag so v1 stays
// settled.  Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1 (same env
// var as v1 — disables both).
try {
  require('./scripts/itemwiseRateImportV2').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import-v2] failed to start:', e.message);
}

// v3 — third-pass rate import (mam 2026-06-01): 101 daybook-matched
// rows from final item.xlsx.  Separate flag, code-ci fallback added.
// Skip via ERP_DISABLE_ITEM_RATE_IMPORT=1 (same env var).
try {
  require('./scripts/itemwiseRateImportV3').runOnce();
} catch (e) {
  console.warn('[itemwise-rate-import-v3] failed to start:', e.message);
}

// One-time backfill — mam (2026-06-01): "this person every month
// make salary full" for Parul Goyal, Rajat Sir, Nitin Jain, Ankur
// Kaplesh, Pooja Kaplesh, D.S Kaplesh, Soma Kaplesh.  Sets
// employees.salary_exempt=1 for matches.  Skip via
// ERP_DISABLE_PAYROLL_EXEMPT_BACKFILL=1.
try {
  require('./scripts/payrollExemptBackfill').runOnce();
} catch (e) {
  console.warn('[payroll-exempt] failed to start:', e.message);
}

// Fire NOC auto-pilot — mam (2026-05-16): "i need easy to user for
// update but automatically things which you can done".  Backfills
// existing rows once on boot (idempotent via app_settings flag),
// then runs every hour to keep stages + statuses in sync with the
// passing days.  Skip via ERP_DISABLE_FIRE_NOC_CRON=1.
try {
  const { scheduleFireNocCron, backfillOnceOnBoot } = require('./scripts/fireNocCron');
  backfillOnceOnBoot();
  scheduleFireNocCron();
} catch (e) {
  console.warn('[fire-noc-cron] Scheduler not started:', e.message);
}

// HR Automations cron — mam (2026-05-22 Batch E module #15).
// Every 30 min: scans for interview reminders, stale offers, pending
// hiring-request approvals → creates in-app notifications + emails
// HR users.  Skip via ERP_DISABLE_HR_CRON=1.
try {
  require('./scripts/hrAutomationsCron').schedule();
} catch (e) {
  console.warn('[hr-cron] Scheduler not started:', e.message);
}

// Procurement schedule reminder cron — mam (2026-05-29):
// "only 1 day before reminder and suggestion".  Every weekday at
// 09:00 (and 60 s after boot for catch-up) scans the schedule for
// indent rows whose end_date == tomorrow's business day, and posts
// an announcement + push for each.  Dedup table guarantees no
// double-posts.  Skip via ERP_DISABLE_PROCSCH_REMINDER=1.
try {
  const { scheduleProcurementReminderCron } = require('./scripts/procurementReminderCron');
  scheduleProcurementReminderCron();
} catch (e) {
  console.warn('[procsch-reminder] Scheduler not started:', e.message);
}

// Tally Bill SLA escalation cron — Director CR (2026-08-13 §6):
// reminder at 80% of a stage SLA, reporting manager at 100%, Director at
// 150%.  Every 15 min (the Stage-4 approval SLA is only 4 business hours, so
// an hourly tick would deliver the 80% reminder after the fact).  Dedup table
// makes re-runs safe.  Skip via ERP_DISABLE_TALLY_SLA_CRON=1.
try {
  const { scheduleTallySlaCron } = require('./scripts/tallySlaCron');
  scheduleTallySlaCron();
} catch (e) {
  console.warn('[tally-sla] Scheduler not started:', e.message);
}

// Daily 09:00 CMD audit email — audit item B20 + TOC v3 P0 #5.
// Reads the 07:30 snapshot JSON (falls back to live /audit/kpi if
// the snapshot folder is missing) and emails the director address
// configured in Admin → Email Settings.  Skip via
// ERP_DISABLE_CMD_EMAIL=1.  Sunday off.
try {
  const { scheduleDailyCmdEmail } = require('./scripts/dailyCmdEmail');
  scheduleDailyCmdEmail();
} catch (e) {
  console.warn('[cmd-email] Scheduler not started:', e.message);
}

// Fortnightly (1st & 16th) installation-billing — auto-generates Type-3 sales
// bills from approved DPRs (work value × Against-Installation %). Idempotent;
// bills are approved but a human still clicks "Sent to Client".
// Skip via ERP_DISABLE_INSTALL_BILLING=1.
try {
  const { scheduleInstallationBillingCron } = require('./scripts/installationBillingCron');
  scheduleInstallationBillingCron();
} catch (e) {
  console.warn('[install-billing] Scheduler not started:', e.message);
}

// Admin-triggered procurement reminder run — fires the 1-day-before
// scan on demand so mam can verify the announcement + push delivery
// without waiting for the 09:00 cron tick.  Uses the same auth
// pattern as the CMD email manual trigger below.
const { authMiddleware: _procReminderAuthMw } = require('./middleware/auth');
app.post('/api/admin/procsch-reminder/run-now', _procReminderAuthMw, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { runOnce } = require('./scripts/procurementReminderCron');
    const r = runOnce();
    res.json({ message: 'Reminder scan complete', ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Admin-triggered CMD email — sends the same daily summary on
// demand so mam can verify SMTP + content without waiting for 9 AM.
// authMiddleware is required inline here because the original require
// is further down the file (line ~244) — using it earlier hit the
// const TDZ on boot. Idempotent: the second require below is a
// cache-hit, no double load.
const { authMiddleware: _authMw } = require('./middleware/auth');
app.post('/api/admin/cmd-email/send-now', _authMw, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { runOnce } = require('./scripts/dailyCmdEmail');
    runOnce().catch(e => console.error('[cmd-email manual]', e.message));
    res.json({ message: 'CMD email fired — check pm2 logs for delivery confirmation' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Audit middleware — runs before the routes so every mutating request
// (POST/PUT/PATCH/DELETE) is logged on response finish. Reads req.user set
// by authMiddleware inside each router. Fire-and-forget so it can't slow
// down or break real requests.
const { auditMiddleware } = require('./middleware/audit');
app.use(auditMiddleware);

// Module availability — the global on/off switch for whole features, one layer above
// role permissions (see lib/features.js). Mounted before the feature routes it gates.
const { requireModuleEnabled } = require('./lib/features');

// API Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/module-flags', require('./routes/moduleFlags'));
app.use('/api/admin/audit', require('./routes/audit'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/leads', require('./routes/leads'));
app.use('/api/sales-funnel', require('./routes/salesfunnel'));
app.use('/api/quotations', require('./routes/quotations'));
app.use('/api/files', require('./routes/filePreview'));
app.use('/api/solar', require('./routes/solar'));
app.use('/api/solar-site', require('./routes/solarSite'));
app.use('/api/orders', require('./routes/orders'));
app.use('/api/project-profit', require('./routes/projectProfit'));
app.use('/api/business-book', require('./routes/businessbook'));
app.use('/api/payment-required', require('./routes/paymentrequired'));
app.use('/api/raci', require('./routes/raci').router);
app.use('/api/attendance', require('./routes/attendance'));
app.use('/api/support', require('./routes/support'));
app.use('/api/item-master', require('./routes/itemmaster'));
app.use('/api/drawing-tracker', require('./routes/drawingTracker'));
app.use('/api/pipe-weights', require('./routes/pipeweights'));
app.use('/api/procurement', require('./routes/procurement'));
app.use('/api/sales-bill-receive', require('./routes/salesBillReceive'));
app.use('/api/dispatch-receiving', require('./routes/dispatchReceiving'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/installation', require('./routes/installation'));
app.use('/api/sales-billing', require('./routes/salesBilling'));
app.use('/api/complaints', require('./routes/complaints'));
app.use('/api/hr', require('./routes/hr'));
// Mam (2026-05-22 Batch D): unauthenticated public offer-accept
// endpoint.  Mounted as its own router (no auth middleware) so
// candidates can accept / decline via /offer/:token without
// logging in to the ERP.
app.use('/api/public', require('./routes/publicHr'));
// Public webhooks (securedengineers.com website leads) — secured via x-webhook-secret
app.use('/api/webhooks', require('./routes/webhooks'));
app.use('/api/public/leads', require('./routes/webhooks'));
app.use('/api/sotyn-leads', require('./routes/sotynLeads'));
app.use('/api/payroll', require('./routes/payroll'));
app.use('/api/scoring', require('./routes/scoring'));
app.use('/api/gamification', require('./routes/champions'));
app.use('/api/tools', require('./routes/tools'));
app.use('/api/rentals', require('./routes/rentals'));
app.use('/api/snags', require('./routes/snags'));
app.use('/api/client-snag', require('./routes/clientSnag'));
// Mam (2026-05-30): labour payment indents — sits in the Projects
// sidebar group, raised against a site + sub-contractor.
app.use('/api/labour-payment', require('./routes/labourPayment'));
// Indent Labour Payment — Phase 1 (mam 2026-06-01).
app.use('/api/indent-labour-payment', require('./routes/indentLabourPayment'));
// Labour Management System (2026-08) — the Indent Labour Payment pipeline
// extended with quotations and HR-owned crew rates. Mounted alongside it, not
// replacing it: the existing routes and permission key are untouched.
app.use('/api/labour-quotations', require('./routes/labourQuotations'));
app.use('/api/labour-rate-master', require('./routes/labourRateMaster'));
app.use('/api/labour-master', require('./routes/labourMaster'));
app.use('/api/bill-verification', require('./routes/billVerification'));
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
app.use('/api/tally-bills', require('./routes/tallyBills'));
app.use('/api/module-videos', require('./routes/moduleVideos'));
app.use('/api/admin/backups', require('./routes/backups'));
app.use('/api/admin/perf', require('./routes/perf'));         // Admin ▸ Performance (hang audit 2026-09-05)
app.use('/api/admin/uploads', require('./routes/uploadsSweep'));
app.use('/api/admin/word-count', require('./routes/wordcount'));
app.use('/api/admin/changelog', require('./routes/changelog'));
app.use('/api/admin/locations', require('./routes/locations'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/ai-agent', require('./routes/aiAgent'));
app.use('/api/email-rules', require('./routes/emailRules'));
app.use('/api/sub-contractors', require('./routes/subcontractors'));
app.use('/api/subcon-hiring', require('./routes/subconHiring'));
app.use('/api/procurement-schedule', require('./routes/procurementSchedule'));
app.use('/api/crm-funnel', require('./routes/crmFunnel'));
app.use('/api/cheques', require('./routes/cheques'));
app.use('/api/dashboards', require('./routes/dashboards'));
app.use('/api/fire-noc', require('./routes/fireNoc'));
app.use('/api/rental-tools', require('./routes/rentalTools'));
app.use('/api/influencers', require('./routes/influencers'));
app.use('/api/crm-kitting', require('./routes/crmKitting'));
app.use('/api/hr-system', require('./routes/hrSystem'));

// 4 Critical Systems
app.use('/api/cashflow', require('./routes/cashflow'));
// Bank module — statement import + reconciliation now, AA auto-sync later (mam 2026-08-31)
app.use('/api/bank', require('./routes/bank'));
app.use('/api/collections', require('./routes/collections'));
// AR/AP Tracker — rolling weekly cash-flow forecast (mam 2026-06-18)
app.use('/api/ar-ap-tracker', require('./routes/arApTracker'));
// Data Completion — "how much of the required data is actually filled", per
// module. Feeds the on-page bar and the Data Entry KPI (mam 2026-09-03).
app.use('/api/data-completion', require('./routes/dataCompletion'));
// Site Chat — internal WhatsApp-style message thread per site (mam 2026-06-18)
// requireModuleEnabled: admin can switch the whole module off (see lib/features.js);
// when off every endpoint 404s, so a pasted URL has nothing to load. NOTE this gates
// the chat FEATURE only — initChatSocket() below must still start, because SOTYN Flow
// and WebRTC call signalling both ride that same io.
app.use('/api/site-chat', requireModuleEnabled('site_chat'), require('./routes/siteChat'));
// SOTYN Flow — task boards (own DB sotynflow.db + shared socket)
app.use('/api/sotyn-flow', requireModuleEnabled('sotyn_flow'), require('./routes/sotynFlow'));
// System Requirements — product evolution tracker (upload-heavy; swept/quarantined)
app.use('/api/system-requirements', requireModuleEnabled('system_requirements'), require('./routes/systemRequirements'));
// System Flow & ERP Implementation Control (mam 2026-09-01)
// ERP Management retired; keep existing records, disable all API operations.
app.use('/api/system-flow', (req, res) => res.status(410).json({ error: 'ERP Management has been removed' }));
app.use('/api/indent-fms', require('./routes/indentfms'));
app.use('/api/dpr', require('./routes/dpr'));

// CMD Audit endpoint (Master Prompt v3) — lives at /audit (not /api/audit)
// so an external scheduler can hit `securederp.in/audit` directly with a
// bearer token, no session cookie required. Returns 12 KPI tiles, 5
// exception lists, plus /audit/data-quality and /audit/analytics.
// Set AUDIT_API_TOKEN in pm2 env (`pm2 set ERP:AUDIT_API_TOKEN <token>`)
// or .env to enable; without it the endpoint replies 503.
app.use('/audit', require('./routes/auditReport'));

// File upload endpoint
const { authMiddleware } = require('./middleware/auth');
app.post('/api/upload', authMiddleware, require('./lib/employeeDocumentUpload'), upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const key = uploadKey(req, req.file);
  // On local this is a no-op (multer already wrote the file where it belongs). On s3 it
  // streams the file into the bucket and removes the local copy — so uploads land in
  // object storage inline, at request time.
  //
  // It never throws for a storage failure: if the bucket is unreachable the file stays on
  // disk, the /uploads resolver serves it via dual-read, and the migration job moves it
  // later. The user's upload succeeds either way.
  const url = await storage.adoptLocalFile(req.file.path, key, req.file.mimetype);
  // Always "/uploads/<key>" under BOTH drivers, so the value stored in the DB is
  // identical to what this endpoint has always returned.
  res.json({ url, filename: req.file.originalname, size: req.file.size });
});

// Public, token-scoped upload for the employee self-fill form (2026-08-17).
// No login — the fill token IS the authorization: it must exist, be unused
// and unexpired, and only document-ish types are accepted. The token check
// runs BEFORE multer so invalid callers can't even write a temp file.
const FILL_UPLOAD_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']);
app.post('/api/public/employee-upload/:token',
  (req, res, next) => {
    try {
      const { getDb } = require('./db/schema');
      const link = getDb().prepare(
        `SELECT id FROM employee_fill_links
          WHERE token=? AND used_at IS NULL
            AND (expires_at IS NULL OR expires_at >= datetime('now'))`
      ).get(String(req.params.token || ''));
      if (!link) return res.status(403).json({ error: 'This link is not valid any more' });
      next();
    } catch (e) { res.status(500).json({ error: 'Upload unavailable' }); }
  },
  upload.single('file'),
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    if (!FILL_UPLOAD_TYPES.has(req.file.mimetype)) {
      try { require('fs').unlinkSync(req.file.path); } catch (_) { }
      return res.status(400).json({ error: 'Only JPG / PNG / WEBP images or PDF files are allowed' });
    }
    const key = uploadKey(req, req.file);
    const url = await storage.adoptLocalFile(req.file.path, key, req.file.mimetype);
    res.json({ url, filename: req.file.originalname, size: req.file.size });
  });

// Serve uploaded files
// Lazy restore: if a requested upload is missing from disk but sitting in
// quarantine (e.g. a chat/ticket was deleted, then a DB revert re-referenced its
// file), pull it back out of quarantine and serve it — automatic recovery, no
// manual sweep needed. Runs before express.static so the restored file is served.
// New employee documents require HR read access even when their URL is known.
app.use('/uploads/employee-documents', authMiddleware, require('./middleware/auth').requirePermission('employees', 'view'));
app.use('/uploads', async (req, res, next) => {
  let key = null;
  try {
    key = quarantine.normalizeKey(decodeURIComponent(req.path.replace(/^\/+/, '')));
  } catch (e) { return next(); }          // undecodable path — let static 404 it
  if (!key) return next();

  try {
    // Lazy restore, driver-agnostic: absent from live storage but sitting in
    // quarantine → pull it back before serving.
    if (!(await storage.exists(key)) && await quarantine.isQuarantined(key)) {
      await quarantine.restoreKey(key);
    }
  } catch (e) { /* ignore — fall through */ }

  // Local driver: nothing more to do, express.static below serves the file exactly as
  // it always has. This keeps the live path byte-for-byte the pre-seam behaviour.
  if (!storage.isRemote) return next();

  try {
    // A public bucket/CDN can serve the bytes directly — cheaper than proxying.
    if (process.env.S3_PUBLIC_BASE_URL) {
      return res.redirect(302, `${process.env.S3_PUBLIC_BASE_URL.replace(/\/+$/, '')}/${key}`);
    }
    const buf = await storage.getObject(key);
    if (buf) {
      res.type(path.extname(key) || 'application/octet-stream');
      return res.send(buf);
    }
  } catch (e) { /* fall through to the local fallback */ }

  // DUAL-READ: the object isn't in the bucket (or the bucket errored), so fall through
  // to express.static and serve the local copy. This is what makes the cutover
  // zero-downtime — files not yet migrated keep serving while the backfill runs.
  return next();
});
app.use('/uploads', express.static(uploadsDir));

// Health check for deployment platforms
// Health + DEPLOY FINGERPRINT.
//
// Static files under client/dist update the moment `git reset --hard` runs,
// but the Node process keeps serving the OLD server code until pm2 actually
// reloads it. That gap is invisible from outside and is exactly how prod once
// drifted 80 commits behind while every boot log looked healthy (2026-07-01).
// Reporting the commit the RUNNING process booted from makes "did the deploy
// take?" answerable in one request:
//     curl -s https://securederp.in/api/health
// If `commit` doesn't match the SHA you just pushed, pm2 never reloaded.
//
// Read once at boot from .git (no child process, no git binary needed); a
// deployment without a .git directory simply reports null.
const BOOT_COMMIT = (() => {
  try {
    const fsx = require('fs'); const px = require('path');
    const gitDir = px.join(__dirname, '..', '.git');
    const head = fsx.readFileSync(px.join(gitDir, 'HEAD'), 'utf8').trim();
    if (head.startsWith('ref: ')) {
      const ref = head.slice(5).trim();
      // Loose ref first, then packed-refs (a freshly cloned/reset repo may use either).
      const loose = px.join(gitDir, ref);
      if (fsx.existsSync(loose)) return fsx.readFileSync(loose, 'utf8').trim().slice(0, 40);
      const packed = fsx.readFileSync(px.join(gitDir, 'packed-refs'), 'utf8');
      const line = packed.split('\n').find(l => l.endsWith(' ' + ref));
      return line ? line.split(' ')[0].slice(0, 40) : null;
    }
    return head.slice(0, 40);   // detached HEAD
  } catch (_) { return null; }
})();
const BOOTED_AT = new Date().toISOString();

// Build id = the entry chunk named by the index.html THIS process serves
// (index-<hash>.js). The client compares it with the chunk it is running
// from (client/src/components/UpdateWatcher.jsx) and moves itself to the new
// build after a deploy (mam 2026-09-05: "it should be automatic"). Read once
// at boot — a deploy always restarts the process. Not the git commit: dist is
// built BEFORE the commit that ships it, so the commit would be one behind.
const BUILD_ID = (() => {
  try {
    const html = require('fs').readFileSync(path.join(__dirname, '..', 'client', 'dist', 'index.html'), 'utf8');
    const m = html.match(/<script[^>]+src="[^"]*\/(index-[A-Za-z0-9_-]+\.js)"/);
    return m ? m[1] : null;
  } catch (_) { return null; }
})();

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    commit: BOOT_COMMIT,
    commit_short: BOOT_COMMIT ? BOOT_COMMIT.slice(0, 8) : null,
    build: BUILD_ID,
    booted_at: BOOTED_AT,
    uptime_seconds: Math.round(process.uptime()),
  });
});

// Polled by every tab (focus / visibility / route change / 10 min) — keep it
// tiny and uncacheable. Public like /api/health: it reveals only the chunk
// name already visible in index.html.
app.get('/api/version', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({ build: BUILD_ID, commit_short: BOOT_COMMIT ? BOOT_COMMIT.slice(0, 8) : null, booted_at: BOOTED_AT });
});

// Serve React build in production.
// Mam (2026-06-02): mobile-card sweep landed but mam's iPhone kept
// showing the old desktop tables.  Root cause: express.static() used
// default cache headers, so browsers cached index.html itself.  Since
// index.html points at the content-hashed bundle name (e.g.
// index-CEasqyYx.js), a cached index.html keeps loading the OLD JS
// even after deploy.  Fix:
//   - Hashed asset files (under /assets/*) → cache forever (immutable)
//   - index.html + other root files → no-cache so a refresh ALWAYS
//     fetches the current bundle name.
// /join — the PERMANENT new-joiner URL (mam 2026-08-17 "only make link"):
// short enough to print in the joining kit / pin in WhatsApp. Redirects to
// the currently ACTIVE standing self-fill link, so rotating the token from
// the Employees page never changes the URL people share. No active link →
// the invalid-link card explains to contact HR.
app.get('/join', (req, res) => {
  try {
    const { getDb } = require('./db/schema');
    const db = getDb();
    let link = db.prepare(
      `SELECT token FROM employee_fill_links
        WHERE employee_id IS NULL AND COALESCE(multi_use,0)=1 AND used_at IS NULL
          AND (expires_at IS NULL OR expires_at >= datetime('now'))
        ORDER BY id DESC LIMIT 1`
    ).get();
    if (!link) {
      // Self-healing: /join must always work — provision a fresh standing
      // link when none is active (expired / first boot). HR can still rotate
      // it any time from the Employees page (new token, same /join URL).
      const token = require('crypto').randomBytes(24).toString('base64url');
      db.prepare(`INSERT INTO employee_fill_links (token, employee_id, created_by, expires_at, multi_use)
                  VALUES (?,NULL,NULL, datetime('now','+30 days'), 1)`).run(token);
      link = { token };
    }
    res.redirect(302, `/employee-fill/${link.token}`);
  } catch (e) {
    res.redirect(302, '/employee-fill/none-active');
  }
});

const clientBuild = path.join(__dirname, '..', 'client', 'dist');
const fs2 = require('fs');
if (fs2.existsSync(clientBuild)) {
  app.use(express.static(clientBuild, {
    setHeaders: (res, filePath) => {
      // Vite emits hashed filenames into /assets/* — safe to cache hard.
      // Everything else (index.html, manifest.json, sw.js, favicons) is
      // served no-cache so a re-deploy is picked up on next page load.
      if (filePath.includes(`${path.sep}assets${path.sep}`) || filePath.includes('/assets/')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
      }
    },
  }));
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api') && !req.path.startsWith('/uploads')) {
      // A request for a missing hashed asset (a STALE chunk after a re-deploy)
      // must 404 — NOT fall back to index.html. Serving HTML for a .js import
      // makes the dynamic import resolve to an HTML page → "Cannot read
      // properties of undefined (reading 'default')" in the browser, which
      // bypasses the client's stale-chunk auto-reload. A clean 404 surfaces as
      // "failed to fetch dynamically imported module", which DOES auto-recover
      // (mam 2026-06-27, /crm-funnel crash).
      if (req.path.startsWith('/assets/') || /\.(js|mjs|css|map|json|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|eot)$/i.test(req.path)) {
        return res.status(404).send('Not found');
      }
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
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
// Wrap Express in an HTTP server so Socket.IO (real-time chat) can attach to
// it — the chat uses its own DB + this socket, separate from the rest (mam
// 2026-06-18). Falls back gracefully if the socket layer fails to start.
const httpServer = require('http').createServer(app);
try {
  const io = require('./lib/chatSocket').initChatSocket(httpServer);
  console.log('[chat] Socket.IO ready');
  // SOTYN Flow reuses the SAME io (board rooms f:<id> + flow:* events) — chat is
  // untouched. seeAll lets a non-admin super-viewer (can_see_all on sotyn_flow)
  // join any board room; resolved from erp.db here so the socket file stays clean.
  const { getDb } = require('./db/schema');
  const flowSeeAll = (uid) => { try { return !!getDb().prepare("SELECT MAX(rp.can_see_all) a FROM user_roles ur JOIN role_permissions rp ON rp.role_id=ur.role_id WHERE ur.user_id=? AND rp.module='sotyn_flow'").get(uid)?.a; } catch { return false; } };
  require('./lib/sotynFlowSocket').registerBoardSocket(io, flowSeeAll);
  console.log('[flow] Socket.IO ready');
  // Live update push: every (re)connection is told which build this process
  // serves. `pm2 reload` drops all sockets → they reconnect → every open tab
  // hears the new build within seconds (UpdateWatcher.jsx does the rest).
  io.on('connection', (socket) => { try { socket.emit('app:version', { build: BUILD_ID }); } catch (_) { /* never break chat */ } });
}
catch (e) { console.warn('[chat] Socket.IO not started:', e.message); }
// Bind loopback-only by default (2026-08-26): on the VPS, nginx is the sole
// public front door (HTTPS, server_tokens off) — with 0.0.0.0 anyone could
// hit http://<vps-ip>:5000 directly, skipping nginx and sending logins over
// plain HTTP. Set HOST=0.0.0.0 explicitly (env) only when LAN access to the
// bare API is genuinely needed (e.g. phone testing against a dev machine).
const bindHost = process.env.HOST || '127.0.0.1';
httpServer.listen(serverPort, bindHost, () => {
  console.log(`\n======================================`);
  console.log(`  Business ERP Server`);
  console.log(`  Running on ${bindHost}:${serverPort}`);
  console.log(`  Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`======================================\n`);
});
