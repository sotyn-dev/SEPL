// RACI + SLA framework (mam 2026-06-25). Admin assigns, per module step, the
// Responsible / Accountable / Consulted / Informed employee and an SLA (hours);
// each record's actual per-step time is compared to the SLA to flag who is late
// and by how much — ready for scoring. Generic + module-keyed so every module
// (payables, sales_funnel, indent_dispatch, cheque, dpr, sales_billing) plugs in
// the same way. Piloted on payables first.
const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// One-time table for the admin RACI/SLA template per (module, step).
try {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS raci_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      module TEXT NOT NULL,
      step_key TEXT NOT NULL,
      responsible_id INTEGER, accountable_id INTEGER,
      consulted_id INTEGER, informed_id INTEGER,
      sla_hours REAL DEFAULT 24,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(module, step_key)
    );
  `);
} catch (e) { /* ignore */ }

// The steps each module exposes for RACI config. Add the other modules here as
// they are rolled out — the rest of the framework is already generic.
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

// Map step_key -> { responsible_id, ..., sla_hours } for a module.
function getRaciMap(db, module) {
  const map = {};
  try {
    for (const r of db.prepare('SELECT * FROM raci_config WHERE module=?').all(module)) map[r.step_key] = r;
  } catch (_) {}
  return map;
}
// Resolve the R/A/C/I names + SLA for one step (for display enrichment).
function raciForStep(db, module, stepKey, _userNameCache) {
  const row = getRaciMap(db, module)[String(stepKey)];
  if (!row) return null;
  const nm = (id) => { if (!id) return null; const u = db.prepare('SELECT name FROM users WHERE id=?').get(id); return u?.name || null; };
  return {
    responsible: nm(row.responsible_id), accountable: nm(row.accountable_id),
    consulted: nm(row.consulted_id), informed: nm(row.informed_id),
    sla_hours: row.sla_hours != null ? +row.sla_hours : null,
  };
}

// List the modules + their steps (for the admin config screen).
router.get('/modules', (req, res) => {
  res.json(Object.entries(MODULE_STEPS).map(([key, m]) => ({ key, label: m.label, steps: m.steps })));
});

// Current config for a module, one row per step (merged with the step list so
// unconfigured steps still appear), incl. resolved employee names.
router.get('/config/:module', (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const cfg = getRaciMap(db, req.params.module);
  const nm = (id) => { if (!id) return null; const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(id); return u || null; };
  res.json({
    module: req.params.module, label: mod.label,
    steps: mod.steps.map(s => {
      const c = cfg[s.key] || {};
      return {
        ...s,
        responsible_id: c.responsible_id || null, responsible: nm(c.responsible_id),
        accountable_id: c.accountable_id || null, accountable: nm(c.accountable_id),
        consulted_id: c.consulted_id || null, consulted: nm(c.consulted_id),
        informed_id: c.informed_id || null, informed: nm(c.informed_id),
        sla_hours: c.sla_hours != null ? +c.sla_hours : 24,
      };
    }),
  });
});

// Save the RACI/SLA template for a module (admin only). Body: { steps: [{ step_key,
// responsible_id, accountable_id, consulted_id, informed_id, sla_hours }] }.
router.put('/config/:module', requirePermission('admin', 'edit'), adminOnly, (req, res) => {
  const db = getDb();
  const mod = MODULE_STEPS[req.params.module];
  if (!mod) return res.status(404).json({ error: 'Unknown module' });
  const validKeys = new Set(mod.steps.map(s => s.key));
  const rows = Array.isArray(req.body.steps) ? req.body.steps : [];
  const up = db.prepare(`
    INSERT INTO raci_config (module, step_key, responsible_id, accountable_id, consulted_id, informed_id, sla_hours, updated_at)
    VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
    ON CONFLICT(module, step_key) DO UPDATE SET
      responsible_id=excluded.responsible_id, accountable_id=excluded.accountable_id,
      consulted_id=excluded.consulted_id, informed_id=excluded.informed_id,
      sla_hours=excluded.sla_hours, updated_at=CURRENT_TIMESTAMP`);
  const num = (v) => { const n = +v; return Number.isFinite(n) && n > 0 ? n : null; };
  const tx = db.transaction(() => {
    for (const r of rows) {
      if (!validKeys.has(String(r.step_key))) continue;
      up.run(req.params.module, String(r.step_key), num(r.responsible_id), num(r.accountable_id),
        num(r.consulted_id), num(r.informed_id), (r.sla_hours != null && +r.sla_hours >= 0) ? +r.sla_hours : 24);
    }
  });
  tx();
  res.json({ message: 'RACI saved' });
});

module.exports = { router, raciForStep, getRaciMap };
