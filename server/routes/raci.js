// RACI + SLA, PER RECORD (mam 2026-06-25: "RACI should be per-record, not a
// fixed template"). On each individual record (a payment request, indent, DPR,
// …) the user picks the Responsible / Accountable / Consulted / Informed
// employee for each step and sets the expected time (SLA hours); the system
// then tracks how long each step actually took and flags who is late and by
// how much. Generic + module-keyed so every module plugs in the same way.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { MODULE_DEFS, tsMs } = require('../utils/raciModules');
const router = express.Router();
router.use(authMiddleware);

// Per-record RACI assignment: one row per (module, record, step).
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS raci_assignment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      record_id INTEGER NOT NULL,
      step_key TEXT NOT NULL,
      responsible_id INTEGER, accountable_id INTEGER,
      consulted_id INTEGER, informed_id INTEGER,
      sla_hours REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(module, record_id, step_key)
    );
  `);
} catch (e) { /* ignore */ }

// done_at / done_by — a manual per-step completion stamp (mam 2026-06-27:
// "by default I add person name with time"). Steps like CRM-funnel Negotiation
// have no date column of their own, so the user marks the step done and the
// board uses this timestamp to compute elapsed time + late-by for scoring.
// Guarded ALTERs so they run once on existing databases without a migration.
for (const col of ['done_at DATETIME', 'done_by INTEGER']) {
  try { getDb().exec(`ALTER TABLE raci_assignment ADD COLUMN ${col}`); } catch (e) { /* already exists */ }
}

// The steps each module exposes come from the shared MODULE_DEFS catalogue
// (server/utils/raciModules.js) so the editor, the board and the timing logic
// all agree. Adding a module = adding one entry there, not here.
const MODULE_STEPS = Object.fromEntries(
  Object.entries(MODULE_DEFS).map(([key, m]) => [key, { label: m.label, steps: m.steps }])
);

// All RACI rows for ONE record → { step_key: row }. One query, no N+1.
function getRecordRaci(db, module, recordId) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT * FROM raci_assignment WHERE module=? AND record_id=?').all(module, recordId)) map[r.step_key] = r;
  } catch (_) {}
  return map;
}
// Batch: all RACI rows for MANY records → { record_id: { step_key: row } }.
function getRaciForRecords(db, module, ids) {
  const out = {};
  if (!ids || !ids.length) return out;
  try {
    for (let i = 0; i < ids.length; i += 900) {
      const chunk = ids.slice(i, i + 900);
      const ph = chunk.map(() => '?').join(',');
      for (const r of db.prepare(`SELECT * FROM raci_assignment WHERE module=? AND record_id IN (${ph})`).all(module, ...chunk)) {
        (out[r.record_id] = out[r.record_id] || {})[r.step_key] = r;
      }
    }
  } catch (_) {}
  return out;
}

// Module + step list (so the editor knows the steps to show).
router.get('/modules', (req, res) => {
  res.json(Object.entries(MODULE_STEPS).map(([key, m]) => ({ key, label: m.label, steps: m.steps })));
});

// Per-record RACI for the editor — step list merged with this record's saved
// assignment + resolved employee names.
router.get('/record/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const saved = getRecordRaci(db, req.params.module, +req.params.recordId);
  const nm = (id) => { if (!id) return null; const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(id); return u || null; };
  res.json({
    module: req.params.module, record_id: +req.params.recordId, label: mod.label,
    steps: mod.steps.map(s => {
      const c = saved[s.key] || {};
      return {
        ...s,
        responsible_id: c.responsible_id || null, responsible: nm(c.responsible_id),
        accountable_id: c.accountable_id || null, accountable: nm(c.accountable_id),
        consulted_id: c.consulted_id || null, consulted: nm(c.consulted_id),
        informed_id: c.informed_id || null, informed: nm(c.informed_id),
        sla_hours: c.sla_hours != null ? +c.sla_hours : null,
      };
    }),
  });
});

// Save this record's RACI (any user who can see the module can set it).
router.put('/record/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const validKeys = new Set(mod.steps.map(s => s.key));
  const rows = Array.isArray(req.body.steps) ? req.body.steps : [];
  const up = db.prepare(`
    INSERT INTO raci_assignment (module, record_id, step_key, responsible_id, accountable_id, consulted_id, informed_id, sla_hours, updated_at)
    VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, record_id, step_key) DO UPDATE SET
      responsible_id=excluded.responsible_id, accountable_id=excluded.accountable_id,
      consulted_id=excluded.consulted_id, informed_id=excluded.informed_id,
      sla_hours=excluded.sla_hours, updated_at=CURRENT_TIMESTAMP`);
  const id = (v) => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
  const sla = (v) => (v != null && v !== '' && +v >= 0) ? +v : null;
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!validKeys.has(String(r.step_key))) continue;
      up.run(req.params.module, +req.params.recordId, String(r.step_key),
        id(r.responsible_id), id(r.accountable_id), id(r.consulted_id), id(r.informed_id), sla(r.sla_hours));
    }
  });
  tx();
  res.json({ message: 'RACI saved' });
});

// Mark ONE step done (stamp its completion time, used for elapsed + scoring) or
// clear it. One-click action from the board; it never touches the step's
// R/A/C/I or SLA. Body: { step_key, done_at } — a 'YYYY-MM-DD' / ISO string, or
// null/'' to re-open the step.
router.put('/step-done/:module/:recordId', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const stepKey = String(req.body.step_key || '');
  if (!mod.steps.some(s => s.key === stepKey)) return res.status(400).json({ error: 'Unknown step' });

  // Normalise done_at: a bare date is stored at local-noon so a day-only stamp
  // doesn't slide to the previous day when re-read as UTC.
  let doneAt = req.body.done_at;
  if (doneAt === '' || doneAt == null) doneAt = null;
  else { doneAt = String(doneAt).trim(); if (/^\d{4}-\d{2}-\d{2}$/.test(doneAt)) doneAt += ' 12:00:00'; }
  const doneBy = doneAt ? (req.user?.id || null) : null;

  db.prepare(`
    INSERT INTO raci_assignment (module, record_id, step_key, done_at, done_by, updated_at)
    VALUES (?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, record_id, step_key) DO UPDATE SET
      done_at=excluded.done_at, done_by=excluded.done_by, updated_at=CURRENT_TIMESTAMP
  `).run(req.params.module, +req.params.recordId, stepKey, doneAt, doneBy);

  res.json({ message: doneAt ? 'Step marked done' : 'Step reopened', done_at: doneAt });
});

// GET /api/raci/board/:module — the "Responsible" tab feed. For every record of
// the module: each step with its assigned R/A/C/I, the SLA, the ACTUAL time the
// step took (elapsed) and how late it ran (late_hours). Plus a per-person
// summary (steps owned / total hours / late count) so mam can judge people on
// quality·quantity·time from one screen (mam 2026-06-27).
router.get('/board/:module', (req, res) => {
  const db = getDb();
  const def = MODULE_DEFS[req.params.module];
  if (!def) return res.status(404).json({ error: 'Unknown module' });

  let recs = [];
  try { recs = def.rows(db) || []; } catch (e) { return res.status(500).json({ error: e.message }); }
  const raci = getRaciForRecords(db, req.params.module, recs.map(r => r.id));

  const nameCache = {};
  const nm = (id) => { if (!id) return null; if (!(id in nameCache)) nameCache[id] = db.prepare('SELECT name FROM users WHERE id=?').get(id)?.name || null; return nameCache[id]; };

  const HOUR = 3600000, now = Date.now();
  const people = {};                  // name -> { name, steps, total_hours, late_count, late_hours }
  const bump = (name, hrs, late) => {
    if (!name) return;
    const p = people[name] || (people[name] = { name, steps: 0, total_hours: 0, late_count: 0, late_hours: 0 });
    p.steps += 1;
    if (hrs != null) p.total_hours += hrs;
    if (late > 0) { p.late_count += 1; p.late_hours += late; }
  };

  const rows = recs.map(rec => {
    const recRaci = raci[rec.id] || {};
    // A step's completion time = the manual "mark done" stamp if set, else the
    // module's own date column for that step (some steps, e.g. Negotiation, have
    // no native date — manual stamping is the only source).
    const stampOf = (k) => (recRaci[k] && recRaci[k].done_at) || rec.stamps[k] || null;
    const anyManual = def.steps.some(s => recRaci[s.key] && recRaci[s.key].done_at);
    // When the module exposes an owner, or the user is hand-stamping steps, the
    // "current" (running) step is the first one still without a stamp. Modules
    // that do neither keep their own current_key — no change for the Payables
    // pilot or any other already-live module.
    const useMerged = anyManual || rec.owner_id != null;
    const currentKey = useMerged
      ? (rec.current_key == null ? null : ((def.steps.find(s => !stampOf(s.key)) || {}).key || null))
      : rec.current_key;

    let prev = tsMs(rec.created_at);
    const steps = def.steps.map(s => {
      const cfg = recRaci[s.key] || {};
      const sla = cfg.sla_hours != null ? +cfg.sla_hours : (s.default_sla != null ? +s.default_sla : null);
      const stampRaw = stampOf(s.key);
      const atMs = stampRaw ? tsMs(stampRaw) : null;
      const isCurrent = !atMs && s.key === currentKey;
      let elapsed = null;
      if (atMs != null && prev != null) { elapsed = Math.max(0, (atMs - prev) / HOUR); prev = atMs; }
      else if (isCurrent && prev != null) { elapsed = Math.max(0, (now - prev) / HOUR); }
      const late = (elapsed != null && sla != null && elapsed > sla) ? elapsed - sla : 0;
      // Person = the explicitly-assigned Responsible, else the record owner
      // (the lead's salesperson) as the default so scoring fills in by itself.
      const responsible_id = cfg.responsible_id || rec.owner_id || null;
      const responsible = nm(responsible_id);
      bump(responsible, atMs != null ? elapsed : null, atMs != null ? late : 0);
      return {
        key: s.key, label: s.label,
        status: atMs ? 'done' : (isCurrent ? 'current' : 'pending'),
        at: stampRaw || null,
        done_at: cfg.done_at || null,                                  // the manual stamp (if any)
        responsible_id, responsible,
        responsible_default: !cfg.responsible_id && !!rec.owner_id,    // true when shown from owner
        accountable_id: cfg.accountable_id || null, accountable: nm(cfg.accountable_id),
        consulted_id: cfg.consulted_id || null, consulted: nm(cfg.consulted_id),
        informed_id: cfg.informed_id || null, informed: nm(cfg.informed_id),
        sla_hours: sla,
        elapsed_hours: elapsed != null ? Math.round(elapsed * 10) / 10 : null,
        late_hours: late > 0 ? Math.round(late * 10) / 10 : 0,
      };
    });
    return { id: rec.id, title: rec.title, subtitle: rec.subtitle, created_at: rec.created_at, steps };
  });

  const summary = Object.values(people)
    .map(p => ({
      name: p.name, steps: p.steps,
      total_hours: Math.round(p.total_hours * 10) / 10,
      avg_hours: p.steps ? Math.round((p.total_hours / p.steps) * 10) / 10 : 0,
      late_count: p.late_count,
      late_hours: Math.round(p.late_hours * 10) / 10,
      late_pct: p.steps ? Math.round((p.late_count / p.steps) * 100) : 0,
    }))
    .sort((a, b) => b.steps - a.steps);

  res.json({ module: req.params.module, label: def.label, steps: def.steps, rows, summary });
});

module.exports = { router, getRecordRaci, getRaciForRecords };
