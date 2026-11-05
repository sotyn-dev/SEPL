// SOTYN VENDOR REGISTRATION & EMPANELMENT SCHEMA
// Tracks the end-to-end lifecycle of registering SOTYN as an MEP contractor
// on corporate vendor portals (Reliance, Tata, L&T, Havells, JCB, etc.)

function runVendorRegistrationMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS vendor_registrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      portal_url TEXT NOT NULL,
      company_category TEXT DEFAULT 'MEP Contractor', 
      source_of_portal TEXT,
      date_identified DATE DEFAULT (date('now')),
      registration_owner_id INTEGER REFERENCES users(id),
      registration_owner_name TEXT,
      status TEXT NOT NULL DEFAULT 'company_identified',
      -- Requirements check
      is_registration_open INTEGER DEFAULT 1,
      requirements_notes TEXT,
      required_documents_json TEXT, -- JSON checklist: [{id, name, ready}]
      mep_categories TEXT, -- HVAC, Electrical, Fire Fighting, Plumbing, Solar, BMS
      -- Submission
      registered_email TEXT,
      registration_date DATE,
      application_number TEXT,
      submission_proof_url TEXT,
      submission_proof_filename TEXT,
      submission_ack_pdf_url TEXT,
      -- Credentials & Vault
      credentials_received INTEGER DEFAULT 0,
      credentials_received_date DATE,
      vendor_id_code TEXT,
      portal_username TEXT,
      portal_login_url TEXT,
      encrypted_password TEXT,
      credential_notes TEXT,
      -- Follow-up & SLA reminders
      next_followup_date DATE,
      followup_count INTEGER DEFAULT 0,
      last_followup_at DATETIME,
      rejection_reason TEXT,
      -- Marketing Handover
      marketing_status TEXT DEFAULT 'pending', -- 'pending' | 'ready_for_marketing' | 'campaign_active'
      marketing_handover_at DATETIME,
      marketing_handover_by INTEGER REFERENCES users(id),
      marketing_notes TEXT,
      -- Meta
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_vreg_status ON vendor_registrations(status);
    CREATE INDEX IF NOT EXISTS idx_vreg_owner ON vendor_registrations(registration_owner_id);
    CREATE INDEX IF NOT EXISTS idx_vreg_followup ON vendor_registrations(next_followup_date);
    CREATE INDEX IF NOT EXISTS idx_vreg_app_no ON vendor_registrations(application_number);
    CREATE INDEX IF NOT EXISTS idx_vreg_comp ON vendor_registrations(company_name);

    -- History of stage changes & notes
    CREATE TABLE IF NOT EXISTS vendor_registration_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES vendor_registrations(id) ON DELETE CASCADE,
      stage TEXT NOT NULL,
      action TEXT NOT NULL,
      notes TEXT,
      performed_by INTEGER REFERENCES users(id),
      performed_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vreg_hist_reg ON vendor_registration_history(registration_id);

    -- Uploaded documents, proofs, ack PDFs
    CREATE TABLE IF NOT EXISTS vendor_registration_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER NOT NULL REFERENCES vendor_registrations(id) ON DELETE CASCADE,
      doc_type TEXT DEFAULT 'proof', -- 'screenshot', 'ack_pdf', 'certificate', 'other'
      title TEXT NOT NULL,
      file_url TEXT NOT NULL,
      filename TEXT NOT NULL,
      file_size INTEGER,
      mime_type TEXT,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vreg_docs_reg ON vendor_registration_documents(registration_id);

    -- Matched inbound emails from portals
    CREATE TABLE IF NOT EXISTS vendor_registration_emails (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      registration_id INTEGER REFERENCES vendor_registrations(id) ON DELETE SET NULL,
      company_name TEXT,
      matched_by TEXT, -- 'domain' | 'app_number' | 'email' | 'manual'
      sender TEXT NOT NULL,
      sender_name TEXT,
      subject TEXT NOT NULL,
      email_type TEXT DEFAULT 'confirmation', -- 'otp' | 'confirmation' | 'additional_info' | 'activation' | 'credentials' | 'rejection' | 'general'
      body_snippet TEXT,
      full_body_html TEXT,
      has_attachments INTEGER DEFAULT 0,
      received_at DATETIME,
      is_verified INTEGER DEFAULT 0,
      verified_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_vreg_emails_reg ON vendor_registration_emails(registration_id);
    CREATE INDEX IF NOT EXISTS idx_vreg_emails_type ON vendor_registration_emails(email_type);

    -- Module settings (SLA intervals, email scanning config)
    CREATE TABLE IF NOT EXISTS vendor_registration_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Default SLA settings
  const seedSettings = [
    ['reminder_first_days', '2'],
    ['reminder_followup_days', '5'],
    ['default_registered_email', 'vendor.registration@sotyn.com'],
    ['auto_email_scan_enabled', '0'],
    ['email_imap_host', ''],
    ['email_imap_port', '993'],
    ['email_imap_secure', '1'],
    ['email_imap_user', ''],
    ['email_imap_pass', ''],
    ['email_imap_folder', 'INBOX'],
    ['email_lookback_days', '30'],
  ];

  const stmt = db.prepare('INSERT OR IGNORE INTO vendor_registration_settings (key, value) VALUES (?, ?)');
  for (const [k, v] of seedSettings) {
    stmt.run(k, v);
  }
}

module.exports = {
  runVendorRegistrationMigrations,
};

