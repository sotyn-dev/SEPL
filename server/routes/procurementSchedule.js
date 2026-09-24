// Procurement Schedule — Phase A (mam 2026-05-28).
//
// What it does
//   Given a project's completion_date, work BACKWARDS through 6 phases
//   per BOQ item to surface "the date by which you MUST raise the
//   indent". Saves a row per (item, phase) so the Gantt page can paint
//   bars without redoing the math on every page load.
//
//   Phase                            Default days (per category, admin-tunable)
//   ──────────────────────────────   ─────────────────────────────────────────
//   1. Indent raise                  3 (L1 + L2 approval slack)
//   2. Vendor quotes (3 RFQs)        2
//   3. PO sent (Tally generation)    2
//   4. Vendor dispatch               variable per category
//   5. Site receive (GRN, transport) 1
//   6. Install on site               1 (Phase B will allow per-item override)
//
// Day counting
//   Business days excluding Sundays + admin-editable holidays. So 14 days
//   of vendor lead time really means 14 *working* days.
//
// Out of scope for Phase A (Phase B / C tracker)
//   Drag-edit, live BOQ-change recompute, critical path highlight,
//   indent-deadline alerts, AI drawing extraction.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const storage = require('../lib/storage');
const { uploadsSub, ensureDir } = require('../lib/paths');
const { aiComplete, aiConfig, aiErrorMessage, aiNotConfiguredMessage, extractJsonArray } = require('../lib/aiComplete');

const router = express.Router();
router.use(authMiddleware);

// Drawing uploads — Bundle A (mam 2026-05-28). Stored only for now;
// vision-API reading is Bundle B if mam wants to pay the token cost.
// uploadsSub() honours DATA_ROOT (lib/paths) instead of hardcoding data/uploads.
const DRAWING_FOLDER = 'procurement-schedule';
const drawingDir = ensureDir(uploadsSub(DRAWING_FOLDER));
const drawingUpload = multer({
  storage: multer.diskStorage({
    destination: drawingDir,
    filename: (req, file, cb) => {
      const safe = (file.originalname || 'drawing').replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `psd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${safe}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// Six phase IDs in execution order. Backward-pass walks them right→left.
const PHASES = ['indent', 'quotes', 'po', 'dispatch', 'receive', 'install'];

// Categories we seed defaults for. Admin can rename / add / delete later
// via the phase_rules editor without code changes.
const DEFAULT_CATEGORIES = [
  { category: 'Fire Fighting', vendor_lead: 14 },
  { category: 'Plumbing',      vendor_lead: 10 },
  { category: 'Electrical',    vendor_lead:  7 },
  { category: 'HVAC',          vendor_lead: 21 },
  { category: 'Solar',         vendor_lead: 14 },
  { category: 'Cable',         vendor_lead:  5 },
  { category: 'Civil',         vendor_lead:  3 },
  { category: 'Networking',    vendor_lead:  7 },
  { category: 'CCTV',          vendor_lead:  7 },
  { category: 'Other',         vendor_lead: 10 },
];

// Fixed-cost phases that don't vary per category. Admin can override per
// category via the rules table if a particular trade needs different slack.
// Mam 2026-05-29: 'for indent raise only one day required'. Indent is a
// single action that happens ON a date, not a multi-day window — the
// L1+L2 approval slack lives inside the indent.end date math implicitly.
const FIXED_PHASE_DAYS = { indent: 1, quotes: 2, po: 2, receive: 1, install: 1 };

// Major 2026 Indian public holidays — seeded once so business-day math
// is sane out of the box. Admin can add / remove via the holidays endpoint.
const SEED_HOLIDAYS_2026 = [
  ['2026-01-01', "New Year's Day"],
  ['2026-01-14', 'Makar Sankranti / Pongal'],
  ['2026-01-26', 'Republic Day'],
  ['2026-03-04', 'Holi'],
  ['2026-03-31', 'Eid al-Fitr'],
  ['2026-04-14', 'Ambedkar Jayanti'],
  ['2026-05-01', 'Labour Day'],
  ['2026-06-07', 'Eid al-Adha'],
  ['2026-08-15', 'Independence Day'],
  ['2026-08-26', 'Janmashtami'],
  ['2026-10-02', 'Gandhi Jayanti'],
  ['2026-10-20', 'Diwali'],
  ['2026-11-04', 'Guru Nanak Jayanti'],
  ['2026-12-25', 'Christmas'],
];

// ── Schema (idempotent) ───────────────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS procurement_phase_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT NOT NULL,
      phase TEXT NOT NULL,
      days INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(category, phase)
    );
    CREATE TABLE IF NOT EXISTS procurement_holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      holiday_date DATE NOT NULL UNIQUE,
      label TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS procurement_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      item_id INTEGER,            -- po_items.id; NULL means a synthetic trade-rollup row
      trade TEXT,                 -- category bucket for the two-tier Gantt
      phase TEXT NOT NULL,        -- one of PHASES
      start_date DATE NOT NULL,
      end_date DATE NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',  -- planned | in_progress | done | overdue
      lead_days INTEGER,
      ai_reasoning TEXT,          -- AI's one-line justification (mam 2026-05-28)
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Bundle A (mam 2026-05-28): per-project user-overridable start/end +
    -- client requirements text. Falls back to business_book's committed
    -- dates when this row is absent. Single row per project_id.
    CREATE TABLE IF NOT EXISTS procurement_schedule_meta (
      project_id INTEGER PRIMARY KEY,
      start_date DATE,
      end_date DATE,
      client_requirements TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Drawings linked to a project. Stored as files for now; AI reads
    -- only the filename + count as a context hint (cheap). Vision-API
    -- ingestion of the file BYTES is Bundle B.
    CREATE TABLE IF NOT EXISTS procurement_schedule_drawings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      storage_path TEXT NOT NULL,
      file_type TEXT,
      file_size INTEGER,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_procsch_drawings_project ON procurement_schedule_drawings(project_id);

    -- Bundle C (mam 2026-05-28): immutable snapshot of every approved
    -- schedule so the user can browse the history, download as PDF, and
    -- compare AI runs over time. rows_json + meta_json are full JSON dumps
    -- so a restore is a one-line UPDATE on procurement_schedule.
    CREATE TABLE IF NOT EXISTS procurement_schedule_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      label TEXT,
      rows_json TEXT NOT NULL,
      meta_json TEXT,
      items_scheduled INTEGER,
      earliest_indent_date DATE,
      anchor_date DATE,
      generated_by INTEGER REFERENCES users(id),
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_procsch_snap_project ON procurement_schedule_snapshots(project_id, generated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_procsch_project ON procurement_schedule(project_id);
    CREATE INDEX IF NOT EXISTS idx_procsch_item    ON procurement_schedule(item_id);
  `);

  // Seed phase rules if empty. Combines per-category vendor_lead with the
  // shared FIXED_PHASE_DAYS so every (category, phase) cell has a value.
  const ruleCount = db.prepare('SELECT COUNT(*) AS n FROM procurement_phase_rules').get().n;
  if (ruleCount === 0) {
    const ins = db.prepare('INSERT INTO procurement_phase_rules (category, phase, days) VALUES (?, ?, ?)');
    for (const { category, vendor_lead } of DEFAULT_CATEGORIES) {
      for (const phase of PHASES) {
        const days = phase === 'dispatch' ? vendor_lead : FIXED_PHASE_DAYS[phase];
        ins.run(category, phase, days);
      }
    }
    console.log(`[procurement-schedule] seeded ${DEFAULT_CATEGORIES.length * PHASES.length} phase rules`);
  }

  // One-time: flatten the legacy indent rules from 3 → 1 day (mam: 'only
  // one day required'). Idempotent via app_settings flag so mam can
  // still tune the indent days per category later via the admin UI
  // without this overwriting her edits.
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='procsch_indent_one_day_v1'").get();
    if (!done) {
      const r = db.prepare(`UPDATE procurement_phase_rules SET days=1 WHERE phase='indent' AND days <> 1`).run();
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('procsch_indent_one_day_v1', '1')").run();
      if (r.changes > 0) console.log(`[procurement-schedule] flattened ${r.changes} indent rules to 1 day`);
    }
  } catch (_) {}

  // Seed Indian 2026 holidays if empty. Admin can add/remove later.
  const holCount = db.prepare('SELECT COUNT(*) AS n FROM procurement_holidays').get().n;
  if (holCount === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO procurement_holidays (holiday_date, label) VALUES (?, ?)');
    for (const [d, label] of SEED_HOLIDAYS_2026) ins.run(d, label);
    console.log(`[procurement-schedule] seeded ${SEED_HOLIDAYS_2026.length} default 2026 holidays`);
  }
} catch (e) {
  console.error('[procurement-schedule] schema init failed:', e.message);
}
// Idempotent column add for existing DBs where the original CREATE
// landed before ai_reasoning was added.
try { getDb().exec(`ALTER TABLE procurement_schedule ADD COLUMN ai_reasoning TEXT`); } catch (_) {}

// (The old local getAiSetting() is gone — the AI endpoint reads provider/key/
// model through server/lib/aiComplete.js since 2026-08-21.)

// ── Business-day arithmetic ───────────────────────────────────────
// JS Date math, ISO-string in, ISO-string out. Sundays + holiday set are
// skipped. We re-fetch the holiday set per regenerate run so admin edits
// take effect on the next regen without a server restart.
function loadHolidays(db) {
  const rows = db.prepare('SELECT holiday_date FROM procurement_holidays').all();
  return new Set(rows.map(r => r.holiday_date));
}
function isWorkingDay(isoDate, holidays) {
  const d = new Date(isoDate + 'T00:00:00');
  if (d.getDay() === 0) return false;          // Sunday
  if (holidays.has(isoDate)) return false;
  return true;
}
function addDaysISO(isoDate, n) {
  const d = new Date(isoDate + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}
// Subtract N business days (skipping Sundays + holidays). Returns the
// last working date that satisfies the count.
function subBusinessDays(isoDate, n, holidays) {
  let cur = isoDate;
  let remaining = Math.max(0, n);
  while (remaining > 0) {
    cur = addDaysISO(cur, -1);
    if (isWorkingDay(cur, holidays)) remaining--;
  }
  return cur;
}

// ── Helpers ───────────────────────────────────────────────────────
function getPhaseDaysMap(db) {
  const rows = db.prepare('SELECT category, phase, days FROM procurement_phase_rules').all();
  const map = {};
  for (const r of rows) {
    (map[r.category] = map[r.category] || {})[r.phase] = r.days;
  }
  return map;
}
// Item Master uses short codes ('FF', 'ELE', 'LV', ...). Map them to
// the long-form category names we seed lead-time rules against.
const CODE_TO_CATEGORY = {
  FF:    'Fire Fighting',
  ELE:   'Electrical',
  LV:    'Cable',
  CCTV:  'CCTV',
  AC:    'HVAC',
  HVAC:  'HVAC',
  NET:   'Networking',
  SOL:   'Solar',
  PLUMB: 'Plumbing',
  CIV:   'Civil',
};
function pickCategory(item, ruleMap) {
  const dept = (item.department || item.category || '').trim();
  if (!dept) return 'Other';
  if (ruleMap[dept]) return dept;                  // exact long-form match
  if (CODE_TO_CATEGORY[dept.toUpperCase()]) {      // code → long-form
    const long = CODE_TO_CATEGORY[dept.toUpperCase()];
    if (ruleMap[long]) return long;
  }
  // Loose match — case + hyphen tolerant
  const norm = dept.toLowerCase().replace(/[-_\s]/g, '');
  for (const k of Object.keys(ruleMap)) {
    if (k.toLowerCase().replace(/[-_\s]/g, '') === norm) return k;
  }
  return 'Other';
}

// ── ROUTES ────────────────────────────────────────────────────────

// GET /procurement-schedule/phase-rules — admin lead-time table
router.get('/phase-rules', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const rows = getDb().prepare('SELECT category, phase, days FROM procurement_phase_rules ORDER BY category, phase').all();
  // Pivot to {category: {phase: days}} for easier client-side editing
  const grouped = {};
  for (const r of rows) {
    (grouped[r.category] = grouped[r.category] || {})[r.phase] = r.days;
  }
  res.json({ phases: PHASES, categories: Object.keys(grouped), grouped });
});

// PUT /procurement-schedule/phase-rules — bulk-replace all rules.
// Body: { rules: [{ category, phase, days }, ...] }
router.put('/phase-rules', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const { rules } = req.body || {};
  if (!Array.isArray(rules)) return res.status(400).json({ error: 'rules:array required' });
  const db = getDb();
  const tx = db.transaction(() => {
    for (const r of rules) {
      if (!r.category || !PHASES.includes(r.phase)) continue;
      const days = Math.max(0, Math.min(365, +r.days || 0));
      db.prepare(
        `INSERT INTO procurement_phase_rules (category, phase, days) VALUES (?, ?, ?)
         ON CONFLICT(category, phase) DO UPDATE SET days = excluded.days, updated_at = CURRENT_TIMESTAMP`
      ).run(r.category.trim(), r.phase, days);
    }
  });
  tx();
  res.json({ ok: true, count: rules.length });
});

// GET /procurement-schedule/holidays
router.get('/holidays', requirePermission('procurement_schedule', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT id, holiday_date, label FROM procurement_holidays ORDER BY holiday_date').all());
});

// POST /procurement-schedule/holidays — add one
router.post('/holidays', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const { holiday_date, label } = req.body || {};
  if (!holiday_date) return res.status(400).json({ error: 'holiday_date required (YYYY-MM-DD)' });
  try {
    const r = getDb().prepare('INSERT INTO procurement_holidays (holiday_date, label) VALUES (?, ?)').run(holiday_date, label || null);
    res.status(201).json({ id: r.lastInsertRowid });
  } catch (e) {
    if (String(e.message).includes('UNIQUE')) return res.status(409).json({ error: 'That date is already in the holiday list' });
    throw e;
  }
});

// DELETE /procurement-schedule/holidays/:id
router.delete('/holidays/:id', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  getDb().prepare('DELETE FROM procurement_holidays WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ── META (per-project user overrides) + DRAWINGS endpoints ───────

// GET /procurement-schedule/:project_id/meta — pull the user-saved
// dates + client requirements + uploaded drawings list. Falls back to
// business_book.committed_* when nothing has been saved yet.
router.get('/:project_id/meta', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const db = getDb();
  const pid = +req.params.project_id;
  const project = db.prepare(
    `SELECT bb.id, bb.company_name AS project_name, bb.client_name,
            bb.committed_start_date, bb.committed_completion_date
       FROM business_book bb WHERE bb.id = ?`
  ).get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const meta = db.prepare('SELECT start_date, end_date, client_requirements, updated_at FROM procurement_schedule_meta WHERE project_id = ?').get(pid);
  const drawings = db.prepare(
    `SELECT d.id, d.filename, d.file_size, d.uploaded_at, u.name AS uploaded_by_name
       FROM procurement_schedule_drawings d
       LEFT JOIN users u ON u.id = d.uploaded_by
      WHERE d.project_id = ?
      ORDER BY d.uploaded_at DESC`
  ).all(pid);
  res.json({
    project,
    start_date: meta?.start_date || project.committed_start_date || null,
    end_date:   meta?.end_date   || project.committed_completion_date || null,
    client_requirements: meta?.client_requirements || '',
    drawings,
  });
});

// PUT /procurement-schedule/:project_id/meta — save user overrides.
// Body: { start_date?, end_date?, client_requirements? } — any subset.
router.put('/:project_id/meta', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const db = getDb();
  const pid = +req.params.project_id;
  const { start_date, end_date, client_requirements } = req.body || {};
  const project = db.prepare('SELECT id FROM business_book WHERE id = ?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  db.prepare(
    `INSERT INTO procurement_schedule_meta (project_id, start_date, end_date, client_requirements, updated_by)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       start_date          = COALESCE(excluded.start_date, procurement_schedule_meta.start_date),
       end_date            = COALESCE(excluded.end_date,   procurement_schedule_meta.end_date),
       client_requirements = COALESCE(excluded.client_requirements, procurement_schedule_meta.client_requirements),
       updated_by          = excluded.updated_by,
       updated_at          = CURRENT_TIMESTAMP`
  ).run(pid, start_date || null, end_date || null, client_requirements ?? null, req.user.id);
  res.json({ ok: true });
});

// POST /procurement-schedule/:project_id/drawings — multipart upload.
router.post('/:project_id/drawings', requirePermission('procurement_schedule', 'edit'),
  drawingUpload.single('file'), (req, res) => {
    const db = getDb();
    const pid = +req.params.project_id;
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const project = db.prepare('SELECT id FROM business_book WHERE id = ?').get(pid);
    if (!project) return res.status(404).json({ error: 'Project not found' });
    const r = db.prepare(
      `INSERT INTO procurement_schedule_drawings
         (project_id, filename, storage_path, file_type, file_size, uploaded_by)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pid, req.file.originalname, req.file.filename, req.file.mimetype, req.file.size, req.user.id);
    res.status(201).json({ id: r.lastInsertRowid, filename: req.file.originalname });
  });

// GET /procurement-schedule/drawing/:fileId — stream the file (admin-readable
// only, since drawings can be commercially sensitive).
router.get('/drawing/:fileId', requirePermission('procurement_schedule', 'view'), async (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT filename, storage_path, file_type FROM procurement_schedule_drawings WHERE id = ?')
    .get(+req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });

  res.setHeader('Content-Type', f.file_type || 'application/octet-stream');
  res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(f.filename)}"`);

  // LOCAL driver: keep res.sendFile. Files never leave local disk on this driver, and
  // sendFile gives Accept-Ranges, ETag, Last-Modified and 304s for free. Without them a
  // 30 MB drawing is re-downloaded in full on every view and the browser cannot
  // range-stream it — a real regression on the biggest files the app serves.
  if (!storage.isRemote) {
    const fullPath = path.join(drawingDir, f.storage_path);
    if (!fs.existsSync(fullPath)) return res.status(404).json({ error: 'File missing on disk' });
    return res.sendFile(fullPath);
  }

  // REMOTE driver: the local copy may be gone, so stream from the bucket (openStream
  // falls back to local for anything not yet migrated).
  //
  // Deliberately NOT a redirect to /uploads/<key>: that mount has no auth middleware, and
  // these drawings are permission-gated and commercially sensitive. The bytes must keep
  // flowing through this handler, behind requirePermission.
  //
  // Streamed, not buffered — drawings run to 30 MB and any number of people may open one
  // at once, so a Buffer per request would be real heap pressure.
  let obj = null;
  try {
    obj = await storage.openStream(`${DRAWING_FOLDER}/${f.storage_path}`);
  } catch (e) {
    return res.status(502).json({ error: `Storage unavailable: ${e.message}` });
  }
  if (!obj) return res.status(404).json({ error: 'File missing on disk' });

  if (obj.size != null) res.setHeader('Content-Length', obj.size);
  obj.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); else res.destroy(); });
  obj.stream.pipe(res);
});

// DELETE /procurement-schedule/drawing/:fileId
router.delete('/drawing/:fileId', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const db = getDb();
  const f = db.prepare('SELECT storage_path FROM procurement_schedule_drawings WHERE id = ?').get(+req.params.fileId);
  if (!f) return res.status(404).json({ error: 'File not found' });
  try { fs.unlinkSync(path.join(drawingDir, f.storage_path)); } catch (_) {}
  db.prepare('DELETE FROM procurement_schedule_drawings WHERE id = ?').run(+req.params.fileId);
  res.json({ ok: true });
});

// GET /procurement-schedule/projects — projects ELIGIBLE for scheduling.
// A project must have a completion_date and at least one BOQ item.
router.get('/projects', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT bb.id, bb.company_name, bb.client_name, bb.committed_completion_date AS completion_date,
           (SELECT COUNT(*) FROM purchase_orders po
              JOIN po_items pi ON pi.po_id = po.id
            WHERE po.business_book_id = bb.id) AS boq_items,
           (SELECT COUNT(*) FROM procurement_schedule WHERE project_id = bb.id) AS scheduled_rows
      FROM business_book bb
     WHERE bb.committed_completion_date IS NOT NULL
     ORDER BY bb.committed_completion_date
  `).all();
  res.json(rows);
});

// GET /procurement-schedule/:project_id — the saved Gantt bars.
// Joins back to po_items so the client gets description / department per row.
router.get('/:project_id', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const db = getDb();
  const pid = +req.params.project_id;
  const project = db.prepare('SELECT id, company_name AS project_name, client_name, committed_completion_date AS completion_date FROM business_book WHERE id = ?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  const rows = db.prepare(`
    SELECT s.*, pi.description AS item_description, pi.unit, pi.quantity AS boq_qty,
           im.department AS item_department, im.item_code
      FROM procurement_schedule s
      LEFT JOIN po_items pi ON pi.id = s.item_id
      LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE s.project_id = ?
     ORDER BY s.trade, s.item_id, s.start_date
  `).all(pid);
  const lastGen = rows.length ? rows[0].generated_at : null;
  res.json({ project, rows, generated_at: lastGen });
});

// POST /procurement-schedule/:project_id/ai-suggest
// Calls Claude to predict trade + dispatch lead time + reasoning per
// BOQ item. Returns the suggestions WITHOUT writing to procurement_schedule
// so the user can review/edit before approving.
router.post('/:project_id/ai-suggest', requirePermission('procurement_schedule', 'edit'), async (req, res) => {
  // Provider comes from Admin → AI Settings (anthropic OR gemini) via the
  // shared one-shot helper — the old copy hardcoded "Anthropic" here, which
  // was simply wrong once mam switched to Gemini (2026-08-21).
  const cfg = aiConfig(getDb());
  if (!cfg.configured) return res.status(503).json({ error: aiNotConfiguredMessage(cfg.provider) });

  const db = getDb();
  const pid = +req.params.project_id;
  const project = db.prepare(
    `SELECT id, company_name AS project_name, client_name, committed_completion_date AS completion_date
       FROM business_book WHERE id = ?`
  ).get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.completion_date) return res.status(400).json({ error: 'Project has no completion_date set' });

  const items = db.prepare(`
    SELECT pi.id, pi.description, pi.unit, pi.quantity, pi.item_master_id,
           im.department, im.item_code, im.item_name, im.specification, im.size, im.make
      FROM purchase_orders po
      JOIN po_items pi ON pi.po_id = po.id
      LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE po.business_book_id = ?
  `).all(pid);
  if (items.length === 0) return res.status(400).json({ error: 'No BOQ items on this project — upload the Client PO first' });

  // Bundle A context — user-overridable dates + client requirements +
  // drawing filename hints. body fields take precedence over the saved
  // meta, which in turn takes precedence over business_book defaults.
  const meta = db.prepare('SELECT start_date, end_date, client_requirements FROM procurement_schedule_meta WHERE project_id = ?').get(pid);
  const bbDates = db.prepare('SELECT committed_start_date, committed_completion_date FROM business_book WHERE id = ?').get(pid);
  const startDate = req.body?.start_date || meta?.start_date || bbDates?.committed_start_date || null;
  const endDate   = req.body?.end_date   || meta?.end_date   || bbDates?.committed_completion_date || project.completion_date;
  const clientReq = (req.body?.client_requirements ?? meta?.client_requirements ?? '').toString().trim();
  const drawings = db.prepare(
    'SELECT id, filename, storage_path, file_type, file_size FROM procurement_schedule_drawings WHERE project_id = ? ORDER BY uploaded_at'
  ).all(pid);
  // Bundle B (mam 2026-05-28): vision API reads the drawings unless the
  // client opted out for cost control. Attachments are provider-NEUTRAL
  // ({ mime, data, name }) since 2026-08-21 — lib/aiComplete.js reshapes them
  // into Anthropic document/image blocks or Gemini inlineData parts.
  // CAVEAT: Gemini accepts inline PDFs, but a 25MB multi-drawing payload will
  // often 429 / exceed request limits on the free tier — that is a data-volume
  // reality of Gemini, not a regression; the error mapper now says so plainly.
  const useVision = req.body?.skip_drawings ? false : true;
  const VISION_CAP_BYTES = 25 * 1024 * 1024;   // 25MB total per request
  const visionBlocks = [];
  let visionBytesUsed = 0;
  let visionSkipped = [];
  if (useVision && drawings.length > 0) {
    for (const d of drawings) {
      if (visionBytesUsed + d.file_size > VISION_CAP_BYTES) {
        visionSkipped.push({ filename: d.filename, reason: 'budget exceeded' });
        continue;
      }
      try {
        const full = path.join(drawingDir, d.storage_path);
        if (!fs.existsSync(full)) { visionSkipped.push({ filename: d.filename, reason: 'missing on disk' }); continue; }
        const buf = fs.readFileSync(full);
        const mime = d.file_type || (d.filename.toLowerCase().endsWith('.pdf') ? 'application/pdf' : 'image/png');
        if (mime === 'application/pdf' || mime.startsWith('image/')) {
          // name → Anthropic's per-block title (helps Claude say which drawing
          // it is reading); Gemini has no equivalent field and drops it.
          visionBlocks.push({ mime, data: buf.toString('base64'), name: d.filename });
        } else {
          visionSkipped.push({ filename: d.filename, reason: `unsupported type ${mime}` });
          continue;
        }
        visionBytesUsed += d.file_size;
      } catch (e) {
        visionSkipped.push({ filename: d.filename, reason: e.message });
      }
    }
  }

  // Trim payload so the model doesn't choke on huge prompts.
  const slim = items.map(it => ({
    id: it.id,
    code: it.item_code || null,
    name: it.item_name || it.description,
    spec: it.specification || null,
    size: it.size || null,
    make: it.make || null,
    qty: it.quantity,
    unit: it.unit,
    dept: it.department,
  }));

  // Bundle A prompt — same backbone, more context blocks. Each block
  // is wrapped in a clear header so the model can locate it. Drawings
  // are listed by NAME only (no bytes sent yet — vision API is Bundle B).
  let prompt = `You are a senior procurement planner for SEPL Engineers, an Indian MEPF (Mechanical, Electrical, Plumbing, Fire-fighting) subcontractor.

## Project window
Project: "${project.project_name}"${project.client_name ? ' (client: ' + project.client_name + ')' : ''}
${startDate ? `Start date: ${startDate}` : 'Start date: not specified'}
End / completion date: ${endDate}
${startDate && endDate ? `Total duration: ${Math.max(1, Math.round((new Date(endDate) - new Date(startDate)) / (1000*60*60*24)))} calendar days` : ''}
`;
  if (clientReq) {
    prompt += `\n## Client / project requirements (free-text from procurement team)\n${clientReq.slice(0, 4000)}\n`;
  }
  if (drawings.length > 0) {
    const visionList = drawings.map((d, i) => {
      // Match on `name` — the provider-neutral attachment shape is
      // { mime, data, name } (audit 2026-08-21: this still probed the old
      // Anthropic block's b.title / b.type, so every attached drawing was
      // announced to the model as "filename only").
      const sent = visionBlocks.find(b => b.name === d.filename);
      const status = useVision && sent ? 'attached as image/PDF below'
                   : visionSkipped.find(s => s.filename === d.filename) ? `skipped (${visionSkipped.find(s=>s.filename===d.filename).reason})`
                   : 'filename only';
      return `${i+1}. ${d.filename} (${(d.file_size/1024).toFixed(0)} KB) — ${status}`;
    }).join('\n');
    prompt += `\n## Drawings attached\n${visionList}\n`;
    if (visionBlocks.length > 0) {
      prompt += `\nYou can SEE the attached drawings above. Use them to (a) cross-check the BOQ for items that appear in the drawing but are missing from the list, (b) refine lead-time predictions when the drawing reveals make/spec/quantity details, and (c) note any unusual scope (imported equipment, special-purpose rooms, phasing) in the "reasoning" field.\n`;
    } else {
      prompt += `\nNo drawings were sent as images this call. Use the filenames as hints (e.g. "FF Layout L2.pdf" suggests fire-fighting on level 2).\n`;
    }
  }
  prompt += `
## Your task
For EACH BOQ item below, predict three things:
  1. "trade" — exactly one of: Fire Fighting, Plumbing, Electrical, HVAC, Solar, Networking, CCTV, Cable, Civil, Other
  2. "dispatch_days" — typical business days from PO placed to material reaching site in Indian conditions (vendor lead + transport). Use real-world experience: standard items 5-10 d, imported/custom items 21-45 d, civil bulk 2-3 d, cable 5-7 d, fire pumps 14-21 d, AHUs 21-30 d. If the client requirements mention urgency / phasing / specific milestones, adjust accordingly.
  3. "reasoning" — ONE compact line (<= 140 chars). Mam 2026-05-29 wants the WEEKLY install/delivery breakdown surfaced here whenever it matters. Format guidance:
       • If qty is high (e.g. 100+ valves, 500+ m of cable, 50+ DBs) → start with the weekly rate, e.g. "Install ~25/wk × 4 wks; ask vendor for staggered delivery (site storage tight)".
       • If qty is small + one-shot (e.g. 1 pump, 3 AHUs) → mention it's a single delivery, e.g. "One-shot; 2 units used in week 6 commissioning".
       • For bulk consumables (cable, pipe, brick) → suggest 2-3 delivery slots if the install window > 2 weeks.
       • For imported / long-lead items → emphasise the lead time and any phasing hint from client requirements.
       • Always reference project context when relevant ("imported AHU per Phase 2 spec", "standard local pipe — quick").

## BOQ items
${JSON.stringify(slim)}

## Output format
Reply with ONLY a JSON array, no preamble, no markdown fences:
[{"item_id": <number>, "trade": "<string>", "dispatch_days": <number>, "reasoning": "<string>"}, ...]`;

  try {
    // Multimodal user message: drawings first (so the model has them in
    // context when reading the BOQ), then the text prompt last — the helper
    // appends the text part after the attachments, same order as before.
    const out = await aiComplete(getDb(), {
      prompt, maxTokens: 8192, timeout: 180000, json: true, attachments: visionBlocks,   // long timeout — PDFs take longer
      // retries429: 0 — one attempt here is already up to 180s with drawings
      // attached; the default 4s+8s back-off would hold the request ~9 min,
      // long past nginx/the browser. Fail fast and let mam re-run (2026-08-21).
      retries429: 0,
    });
    const model = out.model;
    const suggestions = extractJsonArray(out.text);
    if (!suggestions) throw new Error('AI returned no JSON array');

    // Attach the original item context so the UI can render rich rows
    const byId = new Map(items.map(it => [it.id, it]));
    const enriched = suggestions.map(s => {
      const it = byId.get(s.item_id);
      return {
        item_id: s.item_id,
        item_code: it?.item_code || null,
        item_description: it?.item_name || it?.description || '(no description)',
        item_qty: it?.quantity,
        item_unit: it?.unit,
        trade: s.trade || 'Other',
        dispatch_days: Math.max(1, Math.min(120, +s.dispatch_days || 7)),
        reasoning: String(s.reasoning || '').slice(0, 320),
      };
    });
    res.json({
      project: { id: project.id, project_name: project.project_name, completion_date: project.completion_date },
      suggestions: enriched,
      model,
      vision: {
        sent: visionBlocks.length,
        skipped: visionSkipped,
        bytes_used: visionBytesUsed,
        cap_bytes: VISION_CAP_BYTES,
        used: useVision && visionBlocks.length > 0,
      },
      input_tokens: out.usage?.input_tokens,
      output_tokens: out.usage?.output_tokens,
    });
  } catch (e) {
    console.error('[procurement-schedule] ai-suggest error:', e.status || '', e.message);
    // Actionable, provider-correct wording instead of the raw SDK/Google body.
    res.status(e.status === 429 ? 429 : 502).json({ error: aiErrorMessage(e, cfg.provider) });
  }
});

// POST /procurement-schedule/:project_id/regenerate
// Wipes old rows for this project and writes a fresh backward-pass.
//
// Body (optional): { suggestions: [{ item_id, trade, dispatch_days, reasoning }] }
// When supplied (after the user approves an AI draft), each item uses the
// per-item dispatch_days instead of the category default. Other 5 phase
// days still come from the seeded fixed values.
router.post('/:project_id/regenerate', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const db = getDb();
  const pid = +req.params.project_id;
  const project = db.prepare('SELECT id, company_name AS project_name, committed_completion_date AS completion_date FROM business_book WHERE id = ?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  // Anchor priority: explicit end_date in body → saved meta → business_book.
  // Bundle A (mam 2026-05-28) — user override always wins so AI-suggested
  // adjustments stay coupled to whatever date the user agreed to.
  const meta = db.prepare('SELECT end_date FROM procurement_schedule_meta WHERE project_id = ?').get(pid);
  const anchorEnd = req.body?.end_date || meta?.end_date || project.completion_date;
  if (!anchorEnd) return res.status(400).json({ error: 'Project has no end date — set one in the Setup card or fill committed_completion_date on the Business Book row' });
  project.completion_date = anchorEnd;

  const items = db.prepare(`
    SELECT pi.id, pi.description, pi.unit, pi.quantity, pi.item_master_id,
           im.department AS category, im.item_code, im.item_name
      FROM purchase_orders po
      JOIN po_items pi ON pi.po_id = po.id
      LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE po.business_book_id = ?
  `).all(pid);
  if (items.length === 0) {
    return res.status(400).json({ error: 'No BOQ items linked to this project (need a Client PO uploaded first)' });
  }

  const holidays = loadHolidays(db);
  const rules = getPhaseDaysMap(db);
  // Per-item AI overrides keyed by item_id → { trade, dispatch_days, reasoning }
  const overrides = new Map();
  if (Array.isArray(req.body?.suggestions)) {
    for (const s of req.body.suggestions) {
      if (!s || !s.item_id) continue;
      overrides.set(+s.item_id, {
        trade: s.trade || null,
        dispatch_days: Math.max(1, Math.min(120, +s.dispatch_days || 0)),
        reasoning: s.reasoning || null,
      });
    }
  }

  const newRows = [];
  for (const it of items) {
    const ov = overrides.get(it.id);
    const cat = ov?.trade || pickCategory(it, rules);
    const catRules = rules[cat] || rules['Other'] || {};
    const dispatchDays = ov?.dispatch_days || catRules.dispatch || 7;

    const installEnd     = project.completion_date;
    const installStart   = subBusinessDays(installEnd,    catRules.install  || 1, holidays);
    const receiveEnd     = addDaysISO(installStart, -1);
    const receiveStart   = subBusinessDays(receiveEnd,    catRules.receive  || 1, holidays);
    const dispatchEnd    = addDaysISO(receiveStart, -1);
    const dispatchStart  = subBusinessDays(dispatchEnd,   dispatchDays, holidays);
    const poEnd          = addDaysISO(dispatchStart, -1);
    const poStart        = subBusinessDays(poEnd,         catRules.po       || 2, holidays);
    const quotesEnd      = addDaysISO(poStart, -1);
    const quotesStart    = subBusinessDays(quotesEnd,     catRules.quotes   || 2, holidays);
    const indentEnd      = addDaysISO(quotesStart, -1);
    const indentStart    = subBusinessDays(indentEnd,     catRules.indent   || 3, holidays);

    const reasoning = ov?.reasoning || null;
    const phaseRows = [
      ['indent',   indentStart,   indentEnd,   catRules.indent   || 3, null],
      ['quotes',   quotesStart,   quotesEnd,   catRules.quotes   || 2, null],
      ['po',       poStart,       poEnd,       catRules.po       || 2, null],
      ['dispatch', dispatchStart, dispatchEnd, dispatchDays,           reasoning],
      ['receive',  receiveStart,  receiveEnd,  catRules.receive  || 1, null],
      ['install',  installStart,  installEnd,  catRules.install  || 1, null],
    ];
    for (const [phase, start, end, days, reason] of phaseRows) {
      newRows.push({ project_id: pid, item_id: it.id, trade: cat, phase, start_date: start, end_date: end, status: 'planned', lead_days: days, ai_reasoning: reason });
    }
  }

  const tx = db.transaction(() => {
    db.prepare('DELETE FROM procurement_schedule WHERE project_id = ?').run(pid);
    const ins = db.prepare(`INSERT INTO procurement_schedule
      (project_id, item_id, trade, phase, start_date, end_date, status, lead_days, ai_reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of newRows) {
      ins.run(r.project_id, r.item_id, r.trade, r.phase, r.start_date, r.end_date, r.status, r.lead_days, r.ai_reasoning);
    }
  });
  tx();

  const earliestIndent = db.prepare(
    `SELECT MIN(start_date) AS d FROM procurement_schedule WHERE project_id = ? AND phase = 'indent'`
  ).get(pid).d;

  // Bundle C (mam 2026-05-28): snapshot every approval so the user can
  // browse history and download past Gantts. Stores the full row dump
  // + meta context so future restore is one UPDATE without re-running AI.
  try {
    const metaForSnap = db.prepare('SELECT start_date, end_date, client_requirements FROM procurement_schedule_meta WHERE project_id = ?').get(pid);
    const label = `${overrides.size > 0 ? 'AI · ' : ''}Approved by ${req.user?.name || 'user'} · ${new Date().toISOString().slice(0,16).replace('T',' ')}`;
    db.prepare(`INSERT INTO procurement_schedule_snapshots
      (project_id, label, rows_json, meta_json, items_scheduled, earliest_indent_date, anchor_date, generated_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
      pid,
      label,
      JSON.stringify(newRows),
      JSON.stringify({ meta: metaForSnap || null, used_ai_suggestions: overrides.size }),
      items.length,
      earliestIndent,
      project.completion_date,
      req.user.id,
    );
  } catch (e) {
    console.warn('[procurement-schedule] snapshot write failed:', e.message);
  }

  res.json({
    ok: true,
    items_scheduled: items.length,
    rows_written: newRows.length,
    earliest_indent_date: earliestIndent,
    anchor_date: project.completion_date,
    used_ai_suggestions: overrides.size,
  });
});

// GET /procurement-schedule/:project_id/snapshots — Records tab list.
router.get('/:project_id/snapshots', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT s.id, s.label, s.items_scheduled, s.earliest_indent_date, s.anchor_date,
           s.generated_at, u.name AS generated_by_name
      FROM procurement_schedule_snapshots s
      LEFT JOIN users u ON u.id = s.generated_by
     WHERE s.project_id = ?
     ORDER BY s.generated_at DESC
  `).all(+req.params.project_id);
  res.json(rows);
});

// GET /procurement-schedule/snapshot/:id — load a specific snapshot for
// viewing in the Gantt OR for PDF generation. Joins rows_json back into
// the same shape the live schedule endpoint returns.
router.get('/snapshot/:id', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const db = getDb();
  const snap = db.prepare(`
    SELECT s.*, u.name AS generated_by_name, bb.company_name AS project_name,
           bb.client_name, bb.committed_completion_date
      FROM procurement_schedule_snapshots s
      LEFT JOIN users u ON u.id = s.generated_by
      LEFT JOIN business_book bb ON bb.id = s.project_id
     WHERE s.id = ?
  `).get(+req.params.id);
  if (!snap) return res.status(404).json({ error: 'Snapshot not found' });
  let rows = [];
  try { rows = JSON.parse(snap.rows_json) || []; } catch (_) {}
  // Hydrate item descriptions by re-joining against po_items (since
  // rows_json only stores item_id) — keeps the snapshot small.
  if (rows.length > 0) {
    const ids = [...new Set(rows.map(r => r.item_id).filter(Boolean))];
    if (ids.length > 0) {
      const items = db.prepare(`
        SELECT pi.id, pi.description, pi.unit, pi.quantity, im.item_code, im.department
          FROM po_items pi LEFT JOIN item_master im ON im.id = pi.item_master_id
         WHERE pi.id IN (${ids.map(() => '?').join(',')})
      `).all(...ids);
      const byId = new Map(items.map(i => [i.id, i]));
      rows = rows.map(r => {
        const it = byId.get(r.item_id);
        return { ...r, item_description: it?.description || null, unit: it?.unit, boq_qty: it?.quantity, item_code: it?.item_code, item_department: it?.department };
      });
    }
  }
  res.json({
    snapshot: {
      id: snap.id, label: snap.label, generated_at: snap.generated_at,
      generated_by_name: snap.generated_by_name,
      items_scheduled: snap.items_scheduled, anchor_date: snap.anchor_date,
      earliest_indent_date: snap.earliest_indent_date,
    },
    project: { id: snap.project_id, project_name: snap.project_name, client_name: snap.client_name, completion_date: snap.committed_completion_date },
    rows,
    generated_at: snap.generated_at,
    meta: (() => { try { return JSON.parse(snap.meta_json); } catch (_) { return null; } })(),
  });
});

// DELETE /procurement-schedule/snapshot/:id — admin clean-up.
router.delete('/snapshot/:id', requirePermission('procurement_schedule', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM procurement_schedule_snapshots WHERE id = ?').run(+req.params.id);
  res.json({ ok: true });
});

// ─── GOOGLE GANTTER / WBS EXECUTION SCHEDULE PARSERS ──────────────

function normalizeDateISO(str) {
  if (!str) return null;
  const s = String(str).trim();
  if (!s) return null;
  // Match YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // Match DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\.-](\d{1,2})[\/\.-](\d{4})/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }
  // Try Date parse
  const parsed = Date.parse(s);
  if (!isNaN(parsed)) {
    return new Date(parsed).toISOString().slice(0, 10);
  }
  return null;
}

function parseDurationDays(str, start, end) {
  if (typeof str === 'number') return Math.max(0, Math.round(str));
  const s = String(str || '').trim().toLowerCase();
  const numMatch = s.match(/^(\d+(?:\.\d+)?)/);
  if (numMatch) return Math.max(0, Math.round(parseFloat(numMatch[1])));
  // If ISO duration PT40H0M0S
  const isoMatch = s.match(/pt(?:(\d+)h)?(?:(\d+)m)?/i);
  if (isoMatch) {
    const hrs = parseInt(isoMatch[1] || '0', 10);
    return Math.max(1, Math.round(hrs / 8));
  }
  if (start && end) {
    const d1 = new Date(start + 'T00:00:00').getTime();
    const d2 = new Date(end + 'T00:00:00').getTime();
    const diff = Math.round((d2 - d1) / (1000 * 60 * 60 * 24));
    return Math.max(0, diff);
  }
  return 1;
}

function parseGantterXml(xml) {
  const tasks = [];
  const taskRegex = /<Task\b[^>]*>([\s\S]*?)<\/Task>/gi;
  let match;
  let order = 0;
  while ((match = taskRegex.exec(xml)) !== null) {
    const body = match[1];
    const getTag = (tag) => {
      const m = body.match(new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'));
      return m ? m[1].trim() : '';
    };

    const name = getTag('Name');
    if (!name) continue;

    const uid = getTag('UID') || getTag('ID');
    const wbs = getTag('OutlineNumber') || getTag('WBS');
    const outlineLevel = parseInt(getTag('OutlineLevel') || '1', 10);
    const start = normalizeDateISO(getTag('Start'));
    const finish = normalizeDateISO(getTag('Finish'));
    const duration = parseDurationDays(getTag('Duration'), start, finish);
    const percentComplete = Math.min(100, Math.max(0, parseInt(getTag('PercentComplete') || '0', 10)));
    const isMilestone = getTag('Milestone') === '1' || duration === 0 ? 1 : 0;

    const preds = [];
    const predRegex = /<PredecessorLink\b[^>]*>([\s\S]*?)<\/PredecessorLink>/gi;
    let pMatch;
    while ((pMatch = predRegex.exec(body)) !== null) {
      const pBody = pMatch[1];
      const pUidMatch = pBody.match(/<PredecessorUID[^>]*>([^<]*)<\/PredecessorUID>/i);
      const pTypeMatch = pBody.match(/<Type[^>]*>([^<]*)<\/Type>/i);
      if (pUidMatch) {
        preds.push({
          uid: pUidMatch[1].trim(),
          type: (pTypeMatch && pTypeMatch[1] === '0') ? 'FF' : 'FS'
        });
      }
    }

    order++;
    tasks.push({
      uid,
      wbs_code: wbs || String(order),
      task_name: name,
      outline_level: outlineLevel || 1,
      start_date: start,
      end_date: finish || start,
      duration_days: duration,
      progress_pct: percentComplete,
      dependencies: preds.length > 0 ? JSON.stringify(preds) : null,
      is_milestone: isMilestone,
      sort_order: order,
    });
  }
  return tasks;
}

function parseSpreadsheetSchedule(text) {
  if (!text || !text.trim()) return [];
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  const firstLine = lines[0];
  let delimiter = '\t';
  if (firstLine.includes('\t')) delimiter = '\t';
  else if (firstLine.includes(';') && (firstLine.split(';').length > firstLine.split(',').length)) delimiter = ';';
  else if (firstLine.includes(',')) delimiter = ',';

  const splitLine = (l) => {
    if (delimiter === '\t') return l.split('\t').map(c => c.trim().replace(/^"|"$/g, ''));
    const pattern = new RegExp(`(?:^|${delimiter})(?:"([^"]*(?:""[^"]*)*)"|([^"${delimiter}]*))`, 'g');
    const cols = [];
    let m;
    while ((m = pattern.exec(l)) !== null) {
      cols.push((m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] || '').trim());
    }
    return cols;
  };

  const headerCols = splitLine(firstLine).map(h => h.toLowerCase().replace(/[^a-z0-9]/g, ''));
  let startRow = 0;

  let wbsIdx = headerCols.findIndex(h => h === 'wbs' || h === 'id' || h === 'no');
  let nameIdx = headerCols.findIndex(h => h.includes('task') || h.includes('name') || h.includes('activity') || h.includes('description'));
  let durIdx = headerCols.findIndex(h => h.includes('duration') || h.includes('days'));
  let startIdx = headerCols.findIndex(h => h.includes('start') || h.includes('from') || h.includes('begin'));
  let endIdx = headerCols.findIndex(h => h.includes('end') || h.includes('finish') || h.includes('to') || h.includes('completion'));
  let predIdx = headerCols.findIndex(h => h.includes('pred') || h.includes('depend') || h.includes('link'));
  let progIdx = headerCols.findIndex(h => h.includes('prog') || h.includes('percent') || h.includes('complete') || h.includes('%'));
  let assignIdx = headerCols.findIndex(h => h.includes('assign') || h.includes('resource') || h.includes('owner'));

  if (nameIdx !== -1 || (startIdx !== -1 && endIdx !== -1)) {
    startRow = 1;
  } else {
    wbsIdx = 0; nameIdx = 1; durIdx = 2; startIdx = 3; endIdx = 4; predIdx = 5; progIdx = 6;
    startRow = 0;
  }

  const tasks = [];
  let order = 0;
  for (let i = startRow; i < lines.length; i++) {
    const cols = splitLine(lines[i]);
    const taskName = nameIdx !== -1 ? cols[nameIdx] : (cols[1] || cols[0]);
    if (!taskName) continue;

    order++;
    const wbs = wbsIdx !== -1 && cols[wbsIdx] ? cols[wbsIdx] : String(order);
    const start = startIdx !== -1 ? normalizeDateISO(cols[startIdx]) : null;
    const end = endIdx !== -1 ? normalizeDateISO(cols[endIdx]) : null;
    const durRaw = durIdx !== -1 ? cols[durIdx] : null;
    const duration = parseDurationDays(durRaw, start, end);
    const preds = predIdx !== -1 && cols[predIdx] ? cols[predIdx] : null;
    const progRaw = progIdx !== -1 ? cols[progIdx] : null;
    let progress = 0;
    if (progRaw) {
      const p = parseFloat(progRaw.replace('%', ''));
      if (!isNaN(p)) progress = p > 1 ? Math.min(100, Math.round(p)) : Math.round(p * 100);
    }
    const assigned = assignIdx !== -1 && cols[assignIdx] ? cols[assignIdx] : null;

    const level = wbs ? wbs.split('.').filter(Boolean).length : 1;
    const isMilestone = duration === 0 || /milestone/i.test(taskName) ? 1 : 0;

    tasks.push({
      wbs_code: wbs,
      task_name: taskName,
      outline_level: Math.max(1, level),
      start_date: start || new Date().toISOString().slice(0, 10),
      end_date: end || start || new Date().toISOString().slice(0, 10),
      duration_days: duration,
      progress_pct: progress,
      dependencies: preds,
      is_milestone: isMilestone,
      assigned_to: assigned,
      sort_order: order,
    });
  }
  return tasks;
}

function parseGantterJson(json) {
  let list = [];
  if (Array.isArray(json)) list = json;
  else if (json && Array.isArray(json.tasks)) list = json.tasks;
  else if (json && Array.isArray(json.data)) list = json.data;

  let order = 0;
  return list.map(t => {
    order++;
    const start = normalizeDateISO(t.start || t.start_date || t.startDate);
    const end = normalizeDateISO(t.finish || t.end || t.end_date || t.endDate);
    const duration = parseDurationDays(t.duration || t.duration_days, start, end);
    const wbs = t.wbs || t.wbs_code || t.outline_number || String(order);
    const level = t.level || t.outline_level || (wbs ? wbs.split('.').length : 1);
    const progress = Math.min(100, Math.max(0, parseInt(t.progress || t.progress_pct || t.percent_complete || '0', 10)));
    const isMilestone = t.is_milestone || t.milestone || duration === 0 ? 1 : 0;
    const preds = typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : (t.predecessors || null));

    return {
      wbs_code: wbs,
      task_name: t.name || t.task_name || `Task ${order}`,
      outline_level: level,
      start_date: start,
      end_date: end || start,
      duration_days: duration,
      progress_pct: progress,
      dependencies: preds,
      is_milestone: isMilestone,
      assigned_to: t.assigned_to || t.resource || null,
      sort_order: order,
    };
  });
}

// ─── EXECUTION TASKS ENDPOINTS (GANTTER / WBS) ────────────────────

// GET /procurement-schedule/:project_id/execution-tasks
router.get('/:project_id/execution-tasks', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const pid = +req.params.project_id;
  const db = getDb();
  const tasks = db.prepare('SELECT * FROM project_schedule_tasks WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(pid);
  res.json(tasks);
});

// POST /procurement-schedule/:project_id/execution-tasks — Create task
router.post('/:project_id/execution-tasks', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const pid = +req.params.project_id;
  const t = req.body || {};
  if (!t.task_name || !t.task_name.trim()) return res.status(400).json({ error: 'task_name is required' });
  const db = getDb();

  const maxOrder = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM project_schedule_tasks WHERE project_id = ?').get(pid).m;
  const r = db.prepare(`
    INSERT INTO project_schedule_tasks (
      project_id, wbs_code, task_name, parent_id, outline_level,
      start_date, end_date, duration_days, progress_pct,
      dependencies, is_milestone, assigned_to, status, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    pid,
    t.wbs_code || String(maxOrder + 1),
    t.task_name.trim(),
    t.parent_id || null,
    t.outline_level || 1,
    t.start_date || new Date().toISOString().slice(0, 10),
    t.end_date || t.start_date || new Date().toISOString().slice(0, 10),
    t.duration_days !== undefined ? +t.duration_days : 1,
    t.progress_pct !== undefined ? +t.progress_pct : 0,
    typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : null),
    t.is_milestone ? 1 : 0,
    t.assigned_to || null,
    t.status || 'planned',
    maxOrder + 1
  );

  const newTask = db.prepare('SELECT * FROM project_schedule_tasks WHERE id = ?').get(r.lastInsertRowid);
  res.status(201).json({ task: newTask });
});

// PUT /procurement-schedule/:project_id/execution-tasks/:taskId — Update task
router.put('/:project_id/execution-tasks/:taskId', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const pid = +req.params.project_id;
  const taskId = +req.params.taskId;
  const t = req.body || {};
  const db = getDb();

  db.prepare(`
    UPDATE project_schedule_tasks SET
      wbs_code = COALESCE(?, wbs_code),
      task_name = COALESCE(?, task_name),
      parent_id = ?,
      outline_level = COALESCE(?, outline_level),
      start_date = COALESCE(?, start_date),
      end_date = COALESCE(?, end_date),
      duration_days = COALESCE(?, duration_days),
      progress_pct = COALESCE(?, progress_pct),
      dependencies = ?,
      is_milestone = COALESCE(?, is_milestone),
      assigned_to = ?,
      status = COALESCE(?, status),
      sort_order = COALESCE(?, sort_order),
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND project_id = ?
  `).run(
    t.wbs_code,
    t.task_name ? t.task_name.trim() : null,
    t.parent_id !== undefined ? t.parent_id : null,
    t.outline_level,
    t.start_date,
    t.end_date,
    t.duration_days !== undefined ? +t.duration_days : null,
    t.progress_pct !== undefined ? +t.progress_pct : null,
    typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : null),
    t.is_milestone !== undefined ? (t.is_milestone ? 1 : 0) : null,
    t.assigned_to !== undefined ? t.assigned_to : null,
    t.status,
    t.sort_order !== undefined ? +t.sort_order : null,
    taskId,
    pid
  );

  const updated = db.prepare('SELECT * FROM project_schedule_tasks WHERE id = ?').get(taskId);
  res.json({ task: updated });
});

// DELETE /procurement-schedule/:project_id/execution-tasks/:taskId
router.delete('/:project_id/execution-tasks/:taskId', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const pid = +req.params.project_id;
  const taskId = +req.params.taskId;
  const db = getDb();
  db.prepare('DELETE FROM project_schedule_tasks WHERE (id = ? OR parent_id = ?) AND project_id = ?').run(taskId, taskId, pid);
  res.json({ ok: true });
});

// POST /procurement-schedule/:project_id/execution-tasks/bulk-save — Bulk save / reorder
router.post('/:project_id/execution-tasks/bulk-save', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const pid = +req.params.project_id;
  const { tasks } = req.body || {};
  if (!Array.isArray(tasks)) return res.status(400).json({ error: 'tasks:array required' });

  const db = getDb();
  const tx = db.transaction(() => {
    for (let i = 0; i < tasks.length; i++) {
      const t = tasks[i];
      if (t.id) {
        db.prepare(`
          UPDATE project_schedule_tasks SET
            wbs_code = ?, task_name = ?, parent_id = ?, outline_level = ?,
            start_date = ?, end_date = ?, duration_days = ?, progress_pct = ?,
            dependencies = ?, is_milestone = ?, assigned_to = ?, status = ?,
            sort_order = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND project_id = ?
        `).run(
          t.wbs_code || String(i + 1), t.task_name, t.parent_id || null, t.outline_level || 1,
          t.start_date, t.end_date, t.duration_days || 1, t.progress_pct || 0,
          typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : null),
          t.is_milestone ? 1 : 0, t.assigned_to || null, t.status || 'planned',
          i + 1, t.id, pid
        );
      } else {
        db.prepare(`
          INSERT INTO project_schedule_tasks (
            project_id, wbs_code, task_name, parent_id, outline_level,
            start_date, end_date, duration_days, progress_pct,
            dependencies, is_milestone, assigned_to, status, sort_order
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          pid, t.wbs_code || String(i + 1), t.task_name, t.parent_id || null, t.outline_level || 1,
          t.start_date, t.end_date, t.duration_days || 1, t.progress_pct || 0,
          typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : null),
          t.is_milestone ? 1 : 0, t.assigned_to || null, t.status || 'planned', i + 1
        );
      }
    }
  });
  tx();
  const all = db.prepare('SELECT * FROM project_schedule_tasks WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(pid);
  res.json({ tasks: all, count: all.length });
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

// POST /procurement-schedule/:project_id/import-gantter — Import XML/JSON/CSV/pasted spreadsheet
router.post('/:project_id/import-gantter', requirePermission('procurement_schedule', 'edit'), importUpload.single('file'), (req, res) => {
  const pid = +req.params.project_id;
  const rawText = req.file ? req.file.buffer.toString('utf8') : (req.body?.content || req.body?.text || '');
  const mode = req.body?.mode || 'replace';

  if (!rawText || !rawText.trim()) return res.status(400).json({ error: 'Schedule data is required' });

  let parsed = [];
  const raw = rawText.trim();

  if (raw.startsWith('<?xml') || raw.startsWith('<Project') || /<Task\b/i.test(raw)) {
    parsed = parseGantterXml(raw);
  } else if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      const json = JSON.parse(raw);
      parsed = parseGantterJson(json);
    } catch (_) {
      parsed = parseSpreadsheetSchedule(raw);
    }
  } else {
    parsed = parseSpreadsheetSchedule(raw);
  }

  if (parsed.length === 0) {
    return res.status(400).json({ error: 'Could not parse any tasks from provided data. Please check format.' });
  }

  const db = getDb();
  const tx = db.transaction(() => {
    if (mode !== 'append') {
      db.prepare('DELETE FROM project_schedule_tasks WHERE project_id = ?').run(pid);
    }
    const currentMax = db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM project_schedule_tasks WHERE project_id = ?').get(pid).m;
    const ins = db.prepare(`
      INSERT INTO project_schedule_tasks (
        project_id, wbs_code, task_name, parent_id, outline_level,
        start_date, end_date, duration_days, progress_pct,
        dependencies, is_milestone, assigned_to, status, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (let i = 0; i < parsed.length; i++) {
      const t = parsed[i];
      const pct = Math.max(0, Math.min(100, t.progress_pct || 0));
      const status = t.status || (pct === 100 ? 'completed' : pct > 0 ? 'in_progress' : 'planned');
      ins.run(
        pid,
        t.wbs_code || String(currentMax + i + 1),
        t.task_name,
        t.parent_id || null,
        t.outline_level || 1,
        t.start_date || new Date().toISOString().slice(0, 10),
        t.end_date || t.start_date || new Date().toISOString().slice(0, 10),
        t.duration_days ?? (t.is_milestone ? 0 : 1),
        pct,
        typeof t.dependencies === 'string' ? t.dependencies : (t.dependencies ? JSON.stringify(t.dependencies) : null),
        t.is_milestone ? 1 : 0,
        t.assigned_to || null,
        status,
        currentMax + i + 1
      );
    }
  });
  tx();

  const all = db.prepare('SELECT * FROM project_schedule_tasks WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(pid);
  res.json({ success: true, count: all.length, tasks: all });
});

// GET /procurement-schedule/:project_id/export-gantter — Export to CSV
router.get('/:project_id/export-gantter', requirePermission('procurement_schedule', 'view'), (req, res) => {
  const pid = +req.params.project_id;
  const db = getDb();
  const tasks = db.prepare('SELECT * FROM project_schedule_tasks WHERE project_id = ? ORDER BY sort_order ASC, id ASC').all(pid);

  const headers = ['WBS', 'Task Name', 'Duration (Days)', 'Start Date', 'Finish Date', 'Predecessors', '% Complete', 'Milestone', 'Assigned To', 'Status'];
  const rows = tasks.map(t => [
    t.wbs_code || '',
    t.task_name || '',
    t.duration_days || 0,
    t.start_date || '',
    t.end_date || '',
    t.dependencies || '',
    t.progress_pct || 0,
    t.is_milestone ? 'Yes' : 'No',
    t.assigned_to || '',
    t.status || ''
  ]);

  const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename=project-${pid}-schedule.csv`);
  res.send(csv);
});

// POST /procurement-schedule/:project_id/ai-monthly-milestones (TSK-0827)
// AI decomposition of project BOQ items into Monthly Milestones & WBS Tasks
router.post('/:project_id/ai-monthly-milestones', requirePermission('procurement_schedule', 'edit'), async (req, res) => {
  const pid = +req.params.project_id;
  const db = getDb();
  const cfg = aiConfig(db);
  if (!cfg.configured) {
    return res.status(400).json({ error: aiNotConfiguredMessage(cfg.provider) });
  }

  let project = db.prepare('SELECT id, company_name AS project_name, committed_completion_date AS completion_date, created_at FROM business_book WHERE id = ?').get(pid);
  if (!project) {
    const site = db.prepare('SELECT id, name, created_at FROM sites WHERE id = ? OR business_book_id = ?').get(pid, pid);
    if (site) {
      project = { id: pid, project_name: site.name, completion_date: null, created_at: site.created_at };
    }
  }
  if (!project) return res.status(404).json({ error: 'Project record not found' });

  // Explicit or saved anchor dates
  const meta = db.prepare('SELECT start_date, end_date FROM procurement_schedule_meta WHERE project_id = ?').get(pid);
  const startDate = req.body?.start_date || meta?.start_date || (project.created_at ? project.created_at.slice(0, 10) : new Date().toISOString().slice(0, 10));
  const endDate = req.body?.end_date || meta?.end_date || project.completion_date;

  const items = db.prepare(`
    SELECT pi.id, pi.description, pi.unit, pi.quantity, pi.rate,
           im.department AS category, im.item_code, im.item_name
      FROM purchase_orders po
      JOIN po_items pi ON pi.po_id = po.id
      LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE po.business_book_id = ?
  `).all(pid);

  if (items.length === 0) {
    return res.status(400).json({ error: 'No BOQ items linked to this project (upload client PO or BOQ first)' });
  }

  const itemsSummary = items.slice(0, 40).map(it => ({
    id: it.id,
    desc: it.item_name || it.description,
    qty: it.quantity,
    unit: it.unit,
    trade: it.category || 'General'
  }));

  const prompt = `You are a Chief Project Planner for an Indian MEPF / Engineering Contracting Company.
Project Name: "${project.project_name}"
Start Date: ${startDate}
Target Completion Date: ${endDate || '3 to 4 months from start'}

## PROJECT BOQ SCOPE:
${JSON.stringify(itemsSummary)}

## TASK:
Decompose this project into a 3 to 5 Monthly Milestone Schedule (WBS structure).
Break it down month by month in execution sequence:
- Month 1: Mobilization, Engineering Approvals, Underground/First-Fix Piping, Sleeve Marking.
- Month 2: Risers, Cable Trays, Main Piping Distribution, Panel Insets.
- Month 3: Equipment Positioning (Pumps/AHUs/Inverters), Wiring, Secondary Piping.
- Month 4 (if needed): Terminal fixtures, Trim, Pressure Testing, Flusing.
- Month 5 (Final): Pre-commissioning, Testing & Commissioning, Snag closure, Handover.

Format each task as a valid item for a Project Gantt / WBS:
- "wbs_code": e.g. "1.0", "1.1", "1.2", "2.0", "2.1", etc.
- "task_name": Clear description (e.g. "Month 1 Milestone: First-Fix & Rough-in", "Core cutting & insert placement")
- "outline_level": 1 for Month Milestone header, 2 for subtasks
- "is_milestone": 1 for Month Milestone header, 0 for subtasks
- "duration_days": realistic business days
- "start_date": YYYY-MM-DD
- "end_date": YYYY-MM-DD
- "dependencies": predecessor WBS code (e.g. "1.1") or empty string
- "progress_pct": 0
- "status": "planned"

OUTPUT FORMAT:
Reply with ONLY a valid JSON object:
{
  "monthly_overview": "2-3 sentences summarizing the monthly phased rollout",
  "tasks": [
    {
      "wbs_code": "1.0",
      "task_name": "Month 1 Milestone: Site Mobilization & First-Fix",
      "outline_level": 1,
      "is_milestone": 1,
      "duration_days": 30,
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD",
      "dependencies": "",
      "progress_pct": 0,
      "status": "planned"
    },
    {
      "wbs_code": "1.1",
      "task_name": "Sleeve marking and core cutting",
      "outline_level": 2,
      "is_milestone": 0,
      "duration_days": 10,
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD",
      "dependencies": "",
      "progress_pct": 0,
      "status": "planned"
    }
  ]
}`;

  try {
    const out = await aiComplete(db, {
      prompt,
      maxTokens: 3500,
      json: true,
      timeout: 60000,
    });

    let parsed = null;
    try {
      parsed = JSON.parse(out.text);
    } catch (_) {
      const m = out.text.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch (__) {} }
    }

    if (!parsed || !Array.isArray(parsed.tasks)) {
      throw new Error('AI could not generate monthly milestone tasks');
    }

    res.json({
      project_id: pid,
      project_name: project.project_name,
      start_date: startDate,
      end_date: endDate,
      monthly_overview: parsed.monthly_overview || '',
      tasks: parsed.tasks,
      model: out.model
    });
  } catch (e) {
    console.error('[procurementSchedule] ai-monthly-milestones failed:', e.status || '', e.message);
    res.status(e.status === 429 ? 429 : 500).json({ error: aiErrorMessage(e, cfg.provider) });
  }
});

module.exports = router;
