// Lead-to-Dispatch Funnel — ISOLATED database connection.
//
// Hard constraint (mam): "want to make this feature database separate,
// donot want to disturb any flow." This module owns its OWN better-sqlite3
// connection to data/lead_to_dispatch_funnel.db and NEVER imports
// db/schema.js. Nothing here ever writes to the main ERP (erp.db). The
// funnel reads the main ERP read-only elsewhere (item_master, app_settings,
// vendors …) via the main getDb(); those reads stay out of this file.
//
// All tables are prefixed l2d_. Init is idempotent (CREATE TABLE IF NOT
// EXISTS), same style as ensureReminderTable in procurementReminderCron.js,
// so calling initFunnelDb() on every boot is safe.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Mirror schema.js path resolution exactly, just a different file name so
// the funnel DB sits beside erp.db in data/ but is a fully distinct file.
const DB_PATH = path.join(__dirname, '..', '..', 'data', 'lead_to_dispatch_funnel.db');

let db;

function getFunnelDb() {
  if (!db) {
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initFunnelDb() {
  const d = getFunnelDb();
  d.exec(`
    -- Key/value config (mirrors app_settings shape). Owns: last_poll_end_time,
    -- indiamart_crm_key (UI override), keyword_include / keyword_exclude,
    -- ai_scope_prompt, margin_pct, welcome/bank/followup template SIDs.
    CREATE TABLE IF NOT EXISTS l2d_settings (
      key   TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per IndiaMART enquiry. Dedup is per-enquiry on unique_query_id.
    CREATE TABLE IF NOT EXISTS l2d_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL DEFAULT 'indiamart',
      unique_query_id TEXT UNIQUE,
      query_type TEXT,
      query_time TEXT,
      sender_name TEXT,
      sender_mobile TEXT,
      sender_email TEXT,
      sender_company TEXT,
      sender_city TEXT,
      sender_state TEXT,
      sender_country_iso TEXT,
      query_product_name TEXT,
      query_mcat_name TEXT,
      query_message TEXT,
      call_duration TEXT,
      receiver_mobile TEXT,
      raw_json TEXT,

      -- Pipeline state
      stage TEXT NOT NULL DEFAULT 'LEAD_ENTERED',

      -- AI lead-classifier verdict (only set for borderline leads)
      ai_verdict TEXT,
      ai_confidence REAL,
      ai_reason TEXT,

      -- AI product match + price
      matched_item_id INTEGER,
      matched_item_name TEXT,
      quoted_price REAL,
      price_source TEXT,

      -- Steps 8–12 capture fields (human-recorded, never auto-detected)
      po_number TEXT,
      po_amount REAL,
      payment_ref TEXT,
      dispatch_ref TEXT,
      purchase_bill_url TEXT,
      purchase_bill_number TEXT,
      sales_bill_number TEXT,
      sales_bill_amount REAL,
      receipt_amount REAL,
      receipt_date TEXT,

      assigned_to INTEGER,
      opted_out INTEGER NOT NULL DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_l2d_leads_stage  ON l2d_leads(stage);
    CREATE INDEX IF NOT EXISTS idx_l2d_leads_source ON l2d_leads(source);
    CREATE INDEX IF NOT EXISTS idx_l2d_leads_created ON l2d_leads(created_at);

    -- Audit trail of every stage transition.
    CREATE TABLE IF NOT EXISTS l2d_stage_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      from_stage TEXT,
      to_stage TEXT NOT NULL,
      changed_by INTEGER,
      changed_by_name TEXT,
      note TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_l2d_hist_lead ON l2d_stage_history(lead_id);

    -- Outbound template sends + inbound button replies (WhatsApp).
    CREATE TABLE IF NOT EXISTS l2d_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      direction TEXT NOT NULL DEFAULT 'out',   -- 'out' | 'in'
      channel TEXT NOT NULL DEFAULT 'whatsapp',
      template TEXT,
      body TEXT,
      twilio_sid TEXT,
      status TEXT,                              -- queued|sent|delivered|failed|received
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_l2d_msg_lead ON l2d_messages(lead_id);

    -- Funnel-only PO draft (step 8). NEVER touches the main ERP vendor_pos.
    -- vendor_candidates_json holds the AI's ranked shortlist; a human
    -- confirms the final vendor + approves before status flips.
    CREATE TABLE IF NOT EXISTS l2d_vendor_po (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      po_number TEXT,
      item_id INTEGER,
      item_name TEXT,
      qty REAL DEFAULT 1,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      vendor TEXT,
      vendor_candidates_json TEXT,
      status TEXT NOT NULL DEFAULT 'draft',     -- draft | approved
      drafted_by_ai INTEGER NOT NULL DEFAULT 1,
      approved_by INTEGER,
      approved_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_l2d_po_lead ON l2d_vendor_po(lead_id);

    -- Step-13 keep-in-touch reminders. Honours l2d_leads.opted_out on send.
    CREATE TABLE IF NOT EXISTS l2d_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      due_date TEXT NOT NULL,
      note TEXT,
      sent INTEGER NOT NULL DEFAULT 0,
      sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_l2d_followups_due ON l2d_followups(due_date, sent);
  `);
  // Idempotent column adds (CREATE TABLE IF NOT EXISTS won't add new columns to
  // an existing table, so back-fill any missing ones here on every boot).
  ensureColumn(d, 'l2d_leads', 'payment_amount', 'REAL');
  return d;
}

// Add a column only if it's missing — safe to call on every boot.
function ensureColumn(d, table, column, type) {
  const cols = d.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some(c => c.name === column)) {
    d.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

// Small key/value helpers over l2d_settings (mirrors aiAgent.js getSetting).
function getFunnelSetting(key) {
  const row = getFunnelDb().prepare('SELECT value FROM l2d_settings WHERE key=?').get(key);
  return row?.value ?? null;
}

function setFunnelSetting(key, value) {
  getFunnelDb().prepare(
    `INSERT INTO l2d_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`
  ).run(key, value == null ? null : String(value));
}

module.exports = { getFunnelDb, initFunnelDb, getFunnelSetting, setFunnelSetting };
