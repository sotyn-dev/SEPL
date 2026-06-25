// RACI + SLA, PER RECORD (mam 2026-06-25: "RACI should be per-record, not a
// fixed template"). On each individual record (a payment request, indent, DPR,
// …) the user picks the Responsible / Accountable / Consulted / Informed
// employee for each step and sets the expected time (SLA hours); the system
// then tracks how long each step actually took and flags who is late and by
// how much. Generic + module-keyed so every module plugs in the same way.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
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

// The steps each module exposes. Add the other modules here as they roll out.
const MODULE_STEPS = {
  payables: {
    label: 'Payables (Payment Required)',
    steps: [
      { key: '0', label: 'HR Approval' },
      { key: '1', label: 'L1 Approval (Accountant)' },
      { key: '2', label: 'L2 Approval' },
      { key: '3', label: 'L3 Approval (MD)' },
      { key: '5', label: 'Payment Release' },
    ],
  },
};

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

module.exports = { router, getRecordRaci, getRaciForRecords };
