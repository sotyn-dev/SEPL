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
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

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
const FIXED_PHASE_DAYS = { indent: 3, quotes: 2, po: 2, receive: 1, install: 1 };

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
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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

// POST /procurement-schedule/:project_id/regenerate
// Wipes old rows for this project and writes a fresh backward-pass.
router.post('/:project_id/regenerate', requirePermission('procurement_schedule', 'edit'), (req, res) => {
  const db = getDb();
  const pid = +req.params.project_id;
  const project = db.prepare('SELECT id, company_name AS project_name, committed_completion_date AS completion_date FROM business_book WHERE id = ?').get(pid);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  if (!project.completion_date) return res.status(400).json({ error: 'Project has no completion_date — cannot anchor the backward-pass' });

  // Pull every BOQ item for this project. Joined to item_master for the
  // category, since po_items doesn't always carry its own.
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

  // Build the rows
  const newRows = [];
  for (const it of items) {
    const cat = pickCategory(it, rules);
    const catRules = rules[cat] || rules['Other'] || {};
    // Backward-pass — install ends ON completion_date.
    const installEnd     = project.completion_date;
    const installStart   = subBusinessDays(installEnd,    catRules.install  || 1, holidays);
    const receiveEnd     = addDaysISO(installStart, -1);
    const receiveStart   = subBusinessDays(receiveEnd,    catRules.receive  || 1, holidays);
    const dispatchEnd    = addDaysISO(receiveStart, -1);
    const dispatchStart  = subBusinessDays(dispatchEnd,   catRules.dispatch || 7, holidays);
    const poEnd          = addDaysISO(dispatchStart, -1);
    const poStart        = subBusinessDays(poEnd,         catRules.po       || 2, holidays);
    const quotesEnd      = addDaysISO(poStart, -1);
    const quotesStart    = subBusinessDays(quotesEnd,     catRules.quotes   || 2, holidays);
    const indentEnd      = addDaysISO(quotesStart, -1);
    const indentStart    = subBusinessDays(indentEnd,     catRules.indent   || 3, holidays);

    const itemRows = [
      ['indent',   indentStart,   indentEnd,   catRules.indent   || 3],
      ['quotes',   quotesStart,   quotesEnd,   catRules.quotes   || 2],
      ['po',       poStart,       poEnd,       catRules.po       || 2],
      ['dispatch', dispatchStart, dispatchEnd, catRules.dispatch || 7],
      ['receive',  receiveStart,  receiveEnd,  catRules.receive  || 1],
      ['install',  installStart,  installEnd,  catRules.install  || 1],
    ];
    for (const [phase, start, end, days] of itemRows) {
      newRows.push({ project_id: pid, item_id: it.id, trade: cat, phase, start_date: start, end_date: end, status: 'planned', lead_days: days });
    }
  }

  // Replace existing schedule for this project
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM procurement_schedule WHERE project_id = ?').run(pid);
    const ins = db.prepare(`INSERT INTO procurement_schedule
      (project_id, item_id, trade, phase, start_date, end_date, status, lead_days)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of newRows) {
      ins.run(r.project_id, r.item_id, r.trade, r.phase, r.start_date, r.end_date, r.status, r.lead_days);
    }
  });
  tx();

  // Critical-output: earliest indent.start across all items — the
  // "you must act by" date for the project.
  const earliestIndent = db.prepare(
    `SELECT MIN(start_date) AS d FROM procurement_schedule WHERE project_id = ? AND phase = 'indent'`
  ).get(pid).d;
  res.json({
    ok: true,
    items_scheduled: items.length,
    rows_written: newRows.length,
    earliest_indent_date: earliestIndent,
    anchor_date: project.completion_date,
  });
});

module.exports = router;
