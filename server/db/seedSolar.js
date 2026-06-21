// Solar Quotation module — schema + seed (mam 2026-06-21).
// Solar equipment RATES live in the shared `item_master` (department='SOLAR')
// and solar LABOUR in the shared `labour_rates` (category='SOLAR') — ONE item
// master + one labour master for the whole ERP. Only the solar engine config
// (engineering factors + global settings) and the funnel / saved quotes get
// their own small tables. Idempotent: tables use IF NOT EXISTS; masters seed
// only when no SOLAR rows exist yet.
const fs = require('fs');
const path = require('path');

const SEED_JSON = path.join(__dirname, 'seed', 'solar-item-master.json');
const n = (v) => (v === undefined ? null : v);

function ensureSolarSchema(db) {
  db.exec(`
    -- Engineering multipliers: kind = mount | array | state (NOT a rate master)
    CREATE TABLE IF NOT EXISTS solar_factors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT, name TEXT, val1 REAL, val2 REAL, val3 REAL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_settings (
      key TEXT PRIMARY KEY, value TEXT, unit TEXT, note TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
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
    CREATE TABLE IF NOT EXISTS solar_deals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_no TEXT, lead_id INTEGER, client_name TEXT, company TEXT, phone TEXT, location TEXT, state TEXT,
      capacity_kw REAL, project_type TEXT, value REAL DEFAULT 0, source TEXT,
      stage TEXT DEFAULT 'inquiry', stage_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      owner_id INTEGER, owner_name TEXT, next_action TEXT, next_action_due DATE,
      quotation_id INTEGER, status TEXT DEFAULT 'open', lost_reason TEXT,
      created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_deal_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER, type TEXT, from_stage TEXT, to_stage TEXT, note TEXT,
      by_user INTEGER, by_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

// Map the JSON rate book → rows in the shared item_master (department='SOLAR').
// Convention so the rate-book endpoint can rebuild the engine's lookups:
//   type='solar-panel'     make=brand    specification=Non-DCR|DCR   size=<Wp>     uom=Wp   price=₹/Wp
//   type='solar-inverter'  make=brand    specification=model         size=<kW>     uom=W    price=₹/W
//   type='solar-structure' make=label                                              uom=Wp   price=₹/Wp
//   type='solar-cable'     make=brand    specification=application   size=<sqmm>   uom=Mtr  price=₹/m
//   type='solar-bos'       item_name=category  make=brand            uom=unit               price=₹/unit
function seedSolarRates(db) {
  if (!fs.existsSync(SEED_JSON)) return { seeded: 0 };
  const d = JSON.parse(fs.readFileSync(SEED_JSON, 'utf8'));
  let seeded = 0;

  // ── Solar equipment → item_master (only if the engine's structured rate rows
  //    aren't there yet). Keyed on type LIKE 'solar-%' so it coexists with any
  //    existing generic items already in the SOLAR department. ──
  const haveSolar = db.prepare("SELECT COUNT(*) AS n FROM item_master WHERE type LIKE 'solar-%'").get().n;
  if (!haveSolar) {
    const ins = db.prepare(`INSERT INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make, model_number, current_price)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    let i = 0;
    const code = (pfx) => `SOL-${pfx}-${String(++i).padStart(3, '0')}`;
    const gstStr = (g) => (g != null ? `${g}%` : '18%');
    const tx = db.transaction(() => {
      for (const p of d.panels) {
        ins.run(code('PN'), 'SOLAR', `${p.brand} ${p.wattage_wp}Wp ${p.technology}`, p.cell_content,
          `${p.wattage_wp}Wp`, 'Wp', gstStr(p['gst_%']), 'solar-panel', p.brand, p.model, p['purchase_rate_₹/Wp']); seeded++;
      }
      for (const p of d.inverters) {
        ins.run(code('IN'), 'SOLAR', `${p.brand} ${p.rated_kw}kW Inverter`, p.model,
          `${p.rated_kw}`, 'W', gstStr(p['gst_%']), 'solar-inverter', p.brand, p.model, p['purchase_rate_₹/W']); seeded++;
      }
      for (const p of d.structure) {
        ins.run(code('ST'), 'SOLAR', `Mounting Structure — ${p.make_label}`, p.material,
          null, 'Wp', gstStr(p['gst_%']), 'solar-structure', p.make_label, null, p['purchase_rate_₹/Wp']); seeded++;
      }
      for (const p of d.cables) {
        ins.run(code('CB'), 'SOLAR', `${p.brand} ${p.application} ${p.size_sqmm}mm²`, p.application,
          `${p.size_sqmm}`, 'Mtr', gstStr(p['gst_%']), 'solar-cable', p.brand, null, p['purchase_rate_₹/m']); seeded++;
      }
      for (const p of d.bos) {
        ins.run(code('BS'), 'SOLAR', p.category, p.description, null, p.unit, gstStr(p['gst_%']),
          'solar-bos', p.brand, null, p['purchase_rate_₹/unit']); seeded++;
      }
    });
    tx();
  }

  // ── Solar labour → labour_rates (only if no SOLAR labour yet) ──
  try {
    const haveLab = db.prepare("SELECT COUNT(*) AS n FROM labour_rates WHERE category='SOLAR'").get().n;
    if (!haveLab) {
      const insL = db.prepare(`INSERT INTO labour_rates (item_name, specification, size, rate, uom, category) VALUES (?,?,?,?,?,?)`);
      db.transaction(() => { for (const l of (d.labour || [])) { insL.run(l.activity, null, null, l['rate_₹'], l.unit, 'SOLAR'); seeded++; } })();
    }
  } catch (e) { console.warn('[seed] solar labour skipped:', e.message); }

  // ── Engine config (factors + settings) — small solar-only tables ──
  if (db.prepare('SELECT COUNT(*) AS n FROM solar_factors').get().n === 0) {
    const ins = db.prepare(`INSERT INTO solar_factors (kind,name,val1,val2,val3) VALUES (?,?,?,?,?)`);
    db.transaction(() => {
      (d.factors?.mount || []).forEach((m) => { ins.run('mount', n(m.mount_type), n(m.structure_cost_multiplier), n(m.area_sqm_per_kWp), null); seeded++; });
      (d.factors?.array || []).forEach((a) => { ins.run('array', n(a.array_type), n(a.structure_multiplier), n(a.yield_multiplier), null); seeded++; });
      (d.factors?.state || []).forEach((s) => { ins.run('state', n(s.state), n(s['specific_yield_kWh/kWp']), n(s['t_min_°C']), n(s['t_max_°C'])); seeded++; });
    })();
  }
  if (db.prepare('SELECT COUNT(*) AS n FROM solar_settings').get().n === 0) {
    const ins = db.prepare(`INSERT INTO solar_settings (key,value,unit,note) VALUES (?,?,?,?)`);
    db.transaction(() => (d.settings || []).forEach((s) => { ins.run(n(s.key), String(n(s.value)), n(s.unit), n(s.note)); seeded++; }))();
  }
  return { seeded };
}

function initSolar(db) {
  ensureSolarSchema(db);
  return seedSolarRates(db);
}

module.exports = { ensureSolarSchema, seedSolarRates, initSolar };
