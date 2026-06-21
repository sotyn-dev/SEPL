// Solar Quotation module — schema + seed (mam 2026-06-21).
// Creates the dedicated solar rate tables + the solar_quotations store, then
// seeds the rate book from server/db/seed/solar-item-master.json on first boot.
// Idempotent: tables use CREATE TABLE IF NOT EXISTS; each table is only seeded
// when empty, so re-runs (and existing installs) are no-ops.
const fs = require('fs');
const path = require('path');

const SEED_JSON = path.join(__dirname, 'seed', 'solar-item-master.json');
const n = (v) => (v === undefined ? null : v); // better-sqlite3 rejects undefined

function ensureSolarSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS solar_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT, brand TEXT, model TEXT, technology TEXT,
      wattage_wp REAL, cell_content TEXT,
      voc_v REAL, vmp_v REAL, imp_a REAL, isc_a REAL,
      temp_coef_voc REAL, module_eff REAL,
      warranty_product_yrs INTEGER, warranty_perf_yrs INTEGER,
      purchase_rate_per_wp REAL, gst REAL, tier INTEGER,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_inverters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT, brand TEXT, model TEXT, type TEXT,
      rated_kw REAL, phase TEXT, mppt_count INTEGER,
      mppt_v_min REAL, mppt_v_max REAL, max_dc_v REAL, max_input_current_a REAL,
      euro_eff REAL, warranty_yrs INTEGER, warranty_ext_yrs INTEGER,
      purchase_rate_per_w REAL, gst REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_structure (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      make_label TEXT, material TEXT, galvanization_micron REAL,
      default_mount TEXT, design_wind_basis_ms REAL, steel_kg_per_kw REAL,
      purchase_rate_per_wp REAL, gst REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_cables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      brand TEXT, application TEXT, size_sqmm REAL, cores TEXT,
      conductor TEXT, grade TEXT, voltage_grade TEXT,
      purchase_rate_per_m REAL, gst REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_bos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT, category TEXT, description TEXT, brand TEXT, unit TEXT,
      purchase_rate REAL, gst REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_labour (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity TEXT, unit TEXT, rate REAL, gst REAL,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Engineering multipliers: kind = mount | array | state
    --   mount  → name=mount_type, val1=structure_cost_multiplier, val2=area_sqm_per_kWp
    --   array  → name=array_type,  val1=structure_multiplier,      val2=yield_multiplier
    --   state  → name=state,       val1=specific_yield, val2=t_min, val3=t_max
    CREATE TABLE IF NOT EXISTS solar_factors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, name TEXT, val1 REAL, val2 REAL, val3 REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Global constants (gst_blended, acc_pct, pr, degradation, co2, default_margin, min_floor, tariff)
    CREATE TABLE IF NOT EXISTS solar_settings (
      key TEXT PRIMARY KEY, value TEXT, unit TEXT, note TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Saved solar quotations: scalar columns for listing/reporting, JSON for full state.
    CREATE TABLE IF NOT EXISTS solar_quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quote_no TEXT, lead_id INTEGER, client_name TEXT, address TEXT,
      project_type TEXT, capacity_kw REAL, dc_ac_ratio REAL,
      panel_make TEXT, inverter_make TEXT,
      inputs_json TEXT, boq_json TEXT, engineering_json TEXT, roi_json TEXT,
      cost REAL DEFAULT 0, margin_pct REAL DEFAULT 0, sell REAL DEFAULT 0,
      sell_per_w REAL DEFAULT 0, gst_amt REAL DEFAULT 0, grand_total REAL DEFAULT 0,
      status TEXT DEFAULT 'draft', created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

function seedSolarRates(db) {
  if (!fs.existsSync(SEED_JSON)) return { seeded: 0 };
  const d = JSON.parse(fs.readFileSync(SEED_JSON, 'utf8'));
  const empty = (t) => db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n === 0;
  let seeded = 0;

  if (empty('solar_panels')) {
    const ins = db.prepare(`INSERT INTO solar_panels
      (item_code,brand,model,technology,wattage_wp,cell_content,voc_v,vmp_v,imp_a,isc_a,temp_coef_voc,module_eff,warranty_product_yrs,warranty_perf_yrs,purchase_rate_per_wp,gst,tier)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => d.panels.forEach(p => { ins.run(n(p.item_code),n(p.brand),n(p.model),n(p.technology),n(p.wattage_wp),n(p.cell_content),n(p.voc_v),n(p.vmp_v),n(p.imp_a),n(p.isc_a),n(p['temp_coef_voc_%/°C']),n(p['module_eff_%']),n(p.warranty_product_yrs),n(p.warranty_perf_yrs),n(p['purchase_rate_₹/Wp']),n(p['gst_%']),n(p.tier)); seeded++; }))();
  }
  if (empty('solar_inverters')) {
    const ins = db.prepare(`INSERT INTO solar_inverters
      (item_code,brand,model,type,rated_kw,phase,mppt_count,mppt_v_min,mppt_v_max,max_dc_v,max_input_current_a,euro_eff,warranty_yrs,warranty_ext_yrs,purchase_rate_per_w,gst)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => d.inverters.forEach(p => { ins.run(n(p.item_code),n(p.brand),n(p.model),n(p.type),n(p.rated_kw),n(p.phase),n(p.mppt_count),n(p.mppt_v_min),n(p.mppt_v_max),n(p.max_dc_v),n(p.max_input_current_a),n(p['euro_eff_%']),n(p.warranty_yrs),n(p.warranty_ext_yrs),n(p['purchase_rate_₹/W']),n(p['gst_%'])); seeded++; }))();
  }
  if (empty('solar_structure')) {
    const ins = db.prepare(`INSERT INTO solar_structure
      (make_label,material,galvanization_micron,default_mount,design_wind_basis_ms,steel_kg_per_kw,purchase_rate_per_wp,gst)
      VALUES (?,?,?,?,?,?,?,?)`);
    db.transaction(() => d.structure.forEach(p => { ins.run(n(p.make_label),n(p.material),n(p.galvanization_micron),n(p.default_mount),n(p.design_wind_basis_ms),n(p.steel_kg_per_kW),n(p['purchase_rate_₹/Wp']),n(p['gst_%'])); seeded++; }))();
  }
  if (empty('solar_cables')) {
    const ins = db.prepare(`INSERT INTO solar_cables
      (brand,application,size_sqmm,cores,conductor,grade,voltage_grade,purchase_rate_per_m,gst)
      VALUES (?,?,?,?,?,?,?,?,?)`);
    db.transaction(() => d.cables.forEach(p => { ins.run(n(p.brand),n(p.application),n(p.size_sqmm),n(p.cores),n(p.conductor),n(p.grade),n(p.voltage_grade),n(p['purchase_rate_₹/m']),n(p['gst_%'])); seeded++; }))();
  }
  if (empty('solar_bos')) {
    const ins = db.prepare(`INSERT INTO solar_bos
      (item_code,category,description,brand,unit,purchase_rate,gst)
      VALUES (?,?,?,?,?,?,?)`);
    db.transaction(() => d.bos.forEach(p => { ins.run(n(p.item_code),n(p.category),n(p.description),n(p.brand),n(p.unit),n(p['purchase_rate_₹/unit']),n(p['gst_%'])); seeded++; }))();
  }
  if (empty('solar_labour')) {
    const ins = db.prepare(`INSERT INTO solar_labour (activity,unit,rate,gst) VALUES (?,?,?,?)`);
    db.transaction(() => d.labour.forEach(p => { ins.run(n(p.activity),n(p.unit),n(p['rate_₹']),n(p['gst_%'])); seeded++; }))();
  }
  if (empty('solar_factors')) {
    const ins = db.prepare(`INSERT INTO solar_factors (kind,name,val1,val2,val3) VALUES (?,?,?,?,?)`);
    db.transaction(() => {
      (d.factors?.mount || []).forEach(m => { ins.run('mount', n(m.mount_type), n(m.structure_cost_multiplier), n(m.area_sqm_per_kWp), null); seeded++; });
      (d.factors?.array || []).forEach(a => { ins.run('array', n(a.array_type), n(a.structure_multiplier), n(a.yield_multiplier), null); seeded++; });
      (d.factors?.state || []).forEach(s => { ins.run('state', n(s.state), n(s['specific_yield_kWh/kWp']), n(s['t_min_°C']), n(s['t_max_°C'])); seeded++; });
    })();
  }
  if (empty('solar_settings')) {
    const ins = db.prepare(`INSERT INTO solar_settings (key,value,unit,note) VALUES (?,?,?,?)`);
    db.transaction(() => (d.settings || []).forEach(s => { ins.run(n(s.key), String(n(s.value)), n(s.unit), n(s.note)); seeded++; }))();
  }
  return { seeded };
}

function initSolar(db) {
  ensureSolarSchema(db);
  return seedSolarRates(db);
}

module.exports = { ensureSolarSchema, seedSolarRates, initSolar };
