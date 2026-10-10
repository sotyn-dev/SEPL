// Energy Desk tables (docs on the website repo: docs/energy-desk-architecture.md §6).
//
// Prefixed ed_ so the module stays separate from the hundreds of ERP tables
// and can be removed whole. Phase 1a needs two: one row for the bill as
// entered, one for the report computed from it. The Compliance Radar tables
// arrive with Phase 2.

const crypto = require('crypto');

function ensureEnergyDeskSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ed_bill_extractions (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id        TEXT NOT NULL UNIQUE,
      token_hash       TEXT NOT NULL,
      source           TEXT NOT NULL CHECK (source IN ('upload','manual')),
      status           TEXT NOT NULL CHECK (status IN ('queued','processing','done','failed','manual')),
      files_json       TEXT,
      files_purged_at  DATETIME,
      model            TEXT,
      prompt_version   TEXT,
      input_tokens     INTEGER,
      output_tokens    INTEGER,
      cost_inr_est     REAL,
      fields_json      TEXT,
      months_json      TEXT,
      validation_json  TEXT,
      state            TEXT,
      discom           TEXT,
      category         TEXT,
      sanctioned_load       REAL,
      sanctioned_load_unit  TEXT CHECK (sanctioned_load_unit IN ('kW','kVA') OR sanctioned_load_unit IS NULL),
      contract_demand_kva   REAL,
      consent_at       DATETIME NOT NULL,
      consent_version  TEXT NOT NULL,
      ip_hash          TEXT,
      error            TEXT,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at       DATETIME
    );

    CREATE TABLE IF NOT EXISTS ed_energy_reports (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      public_id        TEXT NOT NULL UNIQUE,
      token_hash       TEXT NOT NULL,
      extraction_id    INTEGER NOT NULL REFERENCES ed_bill_extractions(id),
      confirmed_json   TEXT NOT NULL,
      site_lat         REAL,
      site_lon         REAL,
      roof_input       TEXT CHECK (roof_input IN ('drawn','typed','none')),
      roof_area_sqm    REAL,
      shift_pattern    TEXT,
      daytime_share    REAL,
      generation_json  TEXT,
      sizing_json      TEXT,
      finance_json     TEXT,
      opportunity_tags TEXT,
      lead_score       INTEGER,
      lead_band        TEXT,
      engine_version   TEXT NOT NULL,
      config_version   TEXT NOT NULL,
      lead_ref         TEXT UNIQUE,
      funnel_id        INTEGER REFERENCES sales_funnel(id),
      pdf_emailed_at   DATETIME,
      created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

const randomId = (bytes = 12) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

// The funnel row the website lead created, found the way the webhook itself
// de-duplicates: by the website reference written into its remarks.
function funnelIdForRef(db, leadRef) {
  if (!leadRef) return null;
  try {
    const row = db.prepare(`
      SELECT id FROM sales_funnel
      WHERE source = 'Website' AND remarks LIKE ?
      ORDER BY id DESC LIMIT 1
    `).get(`%Website ref: ${leadRef}%`);
    return row ? row.id : null;
  } catch (_) {
    return null;
  }
}

// Store one manual-path report. Idempotent on the website lead reference: the
// page posts once per accepted lead, but a retry must not make a second row.
function storeManualReport(db, { leadRef, inputs, report, engineVersion, configVersion, ip }) {
  ensureEnergyDeskSchema(db);
  const existing = db.prepare('SELECT public_id FROM ed_energy_reports WHERE lead_ref = ?').get(leadRef);
  if (existing) return { publicId: existing.public_id, duplicate: true };

  const funnelId = funnelIdForRef(db, leadRef);
  const insert = db.transaction(() => {
    const ex = db.prepare(`
      INSERT INTO ed_bill_extractions (
        public_id, token_hash, source, status, fields_json, state, discom, category,
        sanctioned_load, sanctioned_load_unit, consent_at, consent_version, ip_hash
      ) VALUES (?, ?, 'manual', 'manual', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, 'website-report-gate-v1', ?)
    `).run(
      randomId(), sha256(randomId(24)), JSON.stringify(inputs),
      inputs.state, inputs.discom || null, inputs.category,
      inputs.sanctionedLoad == null ? null : inputs.sanctionedLoad,
      inputs.sanctionedLoad == null ? null : (inputs.sanctionedLoadUnit || 'kW'),
      ip ? sha256(ip).slice(0, 16) : null,
    );
    const publicId = randomId();
    db.prepare(`
      INSERT INTO ed_energy_reports (
        public_id, token_hash, extraction_id, confirmed_json, roof_input, roof_area_sqm,
        daytime_share, generation_json, sizing_json, finance_json, opportunity_tags,
        engine_version, config_version, lead_ref, funnel_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publicId, sha256(randomId(24)), ex.lastInsertRowid, JSON.stringify(inputs),
      inputs.roofSqft ? 'typed' : 'none',
      inputs.roofSqft ? Math.round(inputs.roofSqft * 0.092903 * 10) / 10 : null,
      inputs.daytimeSharePct == null ? null : inputs.daytimeSharePct / 100,
      JSON.stringify({ basis: 'regional band', region: report.region, year1Kwh: report.year1GenerationKwh, monthlyKwh: report.monthlyGenerationKwh }),
      JSON.stringify({ kwp: report.kwp, limitedBy: report.limitedBy, limits: report.limits, kwpIfExportsCredited: report.kwpIfExportsCredited, notes: report.notes }),
      JSON.stringify({ rate: report.rate, year1SavingInr: report.year1SavingInr, capex: report.capex, payback: report.payback, irrMid: report.irrMid, co2TonnesPerYear: report.co2TonnesPerYear, price: report.price, sources: report.sources }),
      JSON.stringify(report.opportunities.map((o) => o.tag)),
      engineVersion, configVersion, leadRef, funnelId,
    );
    return publicId;
  });
  return { publicId: insert(), duplicate: false, funnelId };
}

module.exports = { ensureEnergyDeskSchema, storeManualReport, funnelIdForRef, sha256 };
