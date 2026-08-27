// Solar Quotation module — schema + seed (mam 2026-06-21).
// The Solar Sales module owns its OWN material + labour master (separate from the
// generic ERP item_master / labour_rates):
//   solar_materials — one rate row per make/grade (panel/inverter/structure/cable/bos)
//   solar_labour    — solar labour activities (install, transport, …)
// Plus solar-only engine config (solar_factors, solar_settings), the funnel
// (solar_deals/solar_deal_events) and saved quotes (solar_quotations).
// Idempotent: tables use IF NOT EXISTS; each table seeds only when empty.
const fs = require('fs');
const path = require('path');

const SEED_JSON = path.join(__dirname, 'seed', 'solar-item-master.json');
const n = (v) => (v === undefined ? null : v);

function ensureSolarSchema(db) {
  // Additive columns (idempotent) for qualification answers, geo coords (Google
  // Earth) and the deal↔quote link (multiple quote options per client).
  const addCol = (sql) => { try { db.exec(sql); } catch (_) { /* exists */ } };
  db.exec(`
    -- Solar Material Master: rate per make/grade.  category = panel|inverter|structure|cable|bos
    CREATE TABLE IF NOT EXISTS solar_materials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category TEXT, make TEXT, grade TEXT, item_name TEXT, size TEXT, unit TEXT,
      rate REAL DEFAULT 0, gst REAL, active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Solar Labour Master
    CREATE TABLE IF NOT EXISTS solar_labour (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      activity TEXT, unit TEXT, rate REAL DEFAULT 0, gst REAL, active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Engineering multipliers: kind = mount | array | state (engine config, not a master)
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
    -- Solar Project Execution: a Won deal becomes a project that runs Order →
    -- Design/Approvals → Procurement → Installation → Commissioning → Handover → AMC.
    -- milestones_json holds the payment schedule (cash/throughput); amc_* the O&M.
    CREATE TABLE IF NOT EXISTS solar_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_no TEXT, deal_id INTEGER, quotation_id INTEGER,
      client_name TEXT, company TEXT, location TEXT, state TEXT,
      capacity_kw REAL, project_type TEXT, value REAL DEFAULT 0,
      stage TEXT DEFAULT 'order', stage_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      owner_id INTEGER, owner_name TEXT, next_action TEXT, next_action_due DATE,
      start_date DATE, target_handover DATE, handover_date DATE,
      milestones_json TEXT, checklist_json TEXT,
      amc_free_until DATE, amc_annual_fee REAL DEFAULT 0, amc_next_due DATE, amc_status TEXT DEFAULT 'pending',
      status TEXT DEFAULT 'active', created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS solar_project_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER, type TEXT, from_stage TEXT, to_stage TEXT, note TEXT,
      by_user INTEGER, by_name TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- 3D site study: the traced/LiDAR roof model + the shadow analysis run on it.
    -- site_json   = { surfaces:[…], obstructions:[…] } in local ENU metres
    -- result_json = per-panel placement, efficiency % and the summary roll-up
    CREATE TABLE IF NOT EXISTS solar_site_studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      deal_id INTEGER, name TEXT, address TEXT,
      lat REAL, lng REAL, altitude REAL DEFAULT 0,
      site_json TEXT, result_json TEXT,
      panel_count INTEGER DEFAULT 0, capacity_kwp REAL DEFAULT 0, annual_kwh REAL DEFAULT 0,
      mean_perf_pct REAL DEFAULT 0, shade_loss_pct REAL DEFAULT 0,
      lidar_source TEXT DEFAULT 'manual', created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_solar_site_studies_deal ON solar_site_studies(deal_id);
    -- Installed-component registry (director ask, 2026-08-08): panels/inverters/
    -- batteries actually installed at a customer site, for future warranty
    -- claims. Same serial+warranty idea as company_assets/tools, but those track
    -- internal assets reissued between employees — this tracks equipment
    -- permanently installed at a WON project. qty>1 + a blank serial covers bulk
    -- items (e.g. 900 panels installed as one lot); serial-tracked rows are for
    -- the handful of high-value units (inverters, batteries) worth it for.
    CREATE TABLE IF NOT EXISTS solar_project_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES solar_projects(id) ON DELETE CASCADE,
      category TEXT, make TEXT, model TEXT, rating TEXT, serial_no TEXT, qty INTEGER DEFAULT 1,
      install_date DATE, warranty_years REAL DEFAULT 0, warranty_till DATE, notes TEXT,
      created_by INTEGER, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_solar_components_project ON solar_project_components(project_id);
    -- AMC visit schedule — replaces the single amc_next_due date with an actual
    -- recurring calendar: /amc-visits/generate lays out N visits at the chosen
    -- frequency, each with its own checklist and completion record.
    CREATE TABLE IF NOT EXISTS solar_amc_visits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES solar_projects(id) ON DELETE CASCADE,
      scheduled_date DATE, visit_type TEXT DEFAULT 'routine', status TEXT DEFAULT 'scheduled',
      completed_date DATE, technician_name TEXT, checklist_json TEXT, notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_solar_amc_visits_project ON solar_amc_visits(project_id);
  `);
  addCol(`ALTER TABLE solar_deals ADD COLUMN qualification_json TEXT`);
  addCol(`ALTER TABLE solar_deals ADD COLUMN stage_data_json TEXT`);
  addCol(`ALTER TABLE solar_deals ADD COLUMN district TEXT`);
  addCol(`ALTER TABLE solar_deals ADD COLUMN pincode TEXT`);
  addCol(`ALTER TABLE solar_deals ADD COLUMN lat REAL`);
  addCol(`ALTER TABLE solar_deals ADD COLUMN lng REAL`);
  addCol(`ALTER TABLE solar_quotations ADD COLUMN deal_id INTEGER`);
  addCol(`ALTER TABLE solar_quotations ADD COLUMN variant_label TEXT`);
  // State-wise finance defaults (director ask, 2026-08-07: quotes were using
  // one flat ₹8/unit tariff for every state in India). val4 = typical tariff
  // ₹/unit, val5 = state subsidy top-up ₹ (on top of the central PM Surya
  // Ghar CFA). Both start NULL/0 on existing rows — deliberately NOT
  // backfilled with guessed figures; Solar Settings is where the director
  // enters confirmed numbers per state, and they stay editable per quote.
  addCol(`ALTER TABLE solar_factors ADD COLUMN val4 REAL`);
  addCol(`ALTER TABLE solar_factors ADD COLUMN val5 REAL`);
  // DISCOM approval tracking — structured, dated fields living directly on
  // solar_projects, the same way amc_* already does. No live DISCOM API exists
  // publicly, so this is status tracking + a generated application summary
  // (net-metering-print), not automated submission.
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_status TEXT DEFAULT 'not_started'`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_consumer_no TEXT`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_application_date DATE`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_application_ref TEXT`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_inspection_date DATE`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_approval_date DATE`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN net_meter_installed_date DATE`);
  addCol(`ALTER TABLE solar_projects ADD COLUMN discom_notes TEXT`);
  // Proposal branding — configurable instead of the hardcoded "Secured
  // Engineers India" text that used to be baked into every print page.
  // INSERT OR IGNORE so re-running never clobbers a value already set.
  const seedSetting = db.prepare(`INSERT OR IGNORE INTO solar_settings (key, value, note) VALUES (?,?,?)`);
  seedSetting.run('company_name', 'Secured Engineers India', 'Shown on quotations, design reports & DISCOM summaries');
  seedSetting.run('company_tagline', '', 'Optional line under the company name on printed documents');
  seedSetting.run('logo_url', '', 'Uploaded via Solar Settings → Branding; /uploads/… path');
}

function seedSolarRates(db) {
  if (!fs.existsSync(SEED_JSON)) return { seeded: 0 };
  const d = JSON.parse(fs.readFileSync(SEED_JSON, 'utf8'));
  let seeded = 0;

  // ── Solar Material Master ──
  if (db.prepare('SELECT COUNT(*) AS n FROM solar_materials').get().n === 0) {
    const ins = db.prepare(`INSERT INTO solar_materials (category,make,grade,item_name,size,unit,rate,gst) VALUES (?,?,?,?,?,?,?,?)`);
    db.transaction(() => {
      for (const p of d.panels) { ins.run('panel', p.brand, p.cell_content, `${p.brand} ${p.wattage_wp}Wp ${p.technology}`, `${p.wattage_wp}`, 'Wp', p['purchase_rate_₹/Wp'], n(p['gst_%'])); seeded++; }
      for (const p of d.inverters) { ins.run('inverter', p.brand, null, `${p.brand} ${p.rated_kw}kW Inverter`, `${p.rated_kw}`, 'W', p['purchase_rate_₹/W'], n(p['gst_%'])); seeded++; }
      for (const p of d.structure) { ins.run('structure', p.make_label, null, `Mounting Structure — ${p.make_label}`, null, 'Wp', p['purchase_rate_₹/Wp'], n(p['gst_%'])); seeded++; }
      for (const p of d.cables) { ins.run('cable', p.brand, p.application, `${p.brand} ${p.application} ${p.size_sqmm}mm²`, `${p.size_sqmm}`, 'Mtr', p['purchase_rate_₹/m'], n(p['gst_%'])); seeded++; }
      for (const p of d.bos) { ins.run('bos', p.brand, null, p.category, null, p.unit, p['purchase_rate_₹/unit'], n(p['gst_%'])); seeded++; }
    })();
  }

  // Battery bank rates (off-grid / hybrid) — own guard so they seed even when the
  // material master already had rows from an earlier boot.
  if (db.prepare("SELECT COUNT(*) AS n FROM solar_materials WHERE category='battery'").get().n === 0) {
    const ins = db.prepare(`INSERT INTO solar_materials (category,make,grade,item_name,size,unit,rate,gst) VALUES (?,?,?,?,?,?,?,?)`);
    db.transaction(() => { for (const [make, rate] of [['Li-ion LFP', 22000], ['Lead-acid Tubular', 12000]]) { ins.run('battery', make, null, `${make} battery bank`, null, 'kWh', rate, 18); seeded++; } })();
  }

  // ── Solar Labour Master ──
  if (db.prepare('SELECT COUNT(*) AS n FROM solar_labour').get().n === 0) {
    const ins = db.prepare(`INSERT INTO solar_labour (activity,unit,rate,gst) VALUES (?,?,?,?)`);
    db.transaction(() => (d.labour || []).forEach((l) => { ins.run(l.activity, l.unit, l['rate_₹'], n(l['gst_%'])); seeded++; }))();
  }

  // ── Engine config ──
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

  // ── One-time cleanup: pull any solar rows out of the SHARED ERP masters
  //    (left over from the brief "one master" approach). The Solar module owns
  //    its rates now. Guarded so it runs once. ──
  try {
    if (!db.prepare("SELECT 1 FROM solar_settings WHERE key='__shared_master_cleanup'").get()) {
      const a = db.prepare("DELETE FROM item_master WHERE type LIKE 'solar-%'").run();
      const b = db.prepare("DELETE FROM labour_rates WHERE category='SOLAR'").run();
      db.prepare("INSERT OR IGNORE INTO solar_settings (key,value,unit,note) VALUES ('__shared_master_cleanup','1','','internal flag')").run();
      if ((a.changes || 0) + (b.changes || 0) > 0) console.log(`[seed] solar: pulled ${a.changes} item + ${b.changes} labour rows out of shared masters`);
    }
  } catch (e) { /* item_master/labour_rates may not exist yet on a brand-new DB */ }

  return { seeded };
}

function initSolar(db) {
  ensureSolarSchema(db);
  return seedSolarRates(db);
}

module.exports = { ensureSolarSchema, seedSolarRates, initSolar };
