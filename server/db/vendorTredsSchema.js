// Additive, module-owned schema. Never initializes or seeds unrelated ERP modules.
const COMMON = `version INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP`;

const DOCUMENT_TYPES = [
  ['pan','PAN',1], ['gst','GST',1], ['udyam','Udyam',0],
  ['cancelled_cheque','Cancelled Cheque',0], ['bank_letter','Bank Letter',0],
  ['incorporation','Certificate of Incorporation',0], ['aoa','AOA',0],
  ['board_resolution','Board Resolution',0], ['epf','EPF',0], ['esic','ESIC',0],
  ['shops_establishment','Shops & Establishment Certificate',0], ['tan','TAN',0],
  ['workmen_compensation','Workmen Compensation Policy',0],
  ['ca_turnover','CA Certified Turnover',0], ['company_itr','Company ITR',0],
  ['iso_9001','ISO 9001',0], ['electrical_licence','Electrical Contractor Licence',0],
];

function addColumn(db, table, definition) {
  const name = definition.split(/\s+/)[0];
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === name)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
  }
}

function ensureVendorTredsSchema(db) {
  // Required masters are supplied by the existing ERP, including in test fixtures.
  for (const name of ['users','customers','vendors','crm_funnel','sales_bills','receivables','collections','bank_transactions','daily_work_plans','pms_tasks']) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)) {
      throw new Error(`Vendor & TReDS requires the existing ${name} table`);
    }
  }
  const migrate = db.transaction(() => {
    for (const field of ['website_url TEXT','website_domain TEXT','pan TEXT','gst_number TEXT',
      'udyam TEXT','sector TEXT','plant_location TEXT','turnover_amount REAL','city TEXT','state TEXT']) {
      addColumn(db, 'customers', field);
    }
    addColumn(db, 'sales_bills', 'vt_origin TEXT');
    db.exec(`
      CREATE TABLE IF NOT EXISTS vt_catalog (
        id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('platform','doc_type','sector','service')),
        code TEXT NOT NULL, label TEXT NOT NULL, required INTEGER NOT NULL DEFAULT 0 CHECK(required IN (0,1)),
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0,1)), ${COMMON}, UNIQUE(kind,code)
      );
      CREATE TABLE IF NOT EXISTS vt_registrations (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        vendor_id INTEGER REFERENCES vendors(id), owner_id INTEGER NOT NULL REFERENCES users(id),
        registration_date TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'manual', portal_url TEXT,
        portal_login_id TEXT, status TEXT NOT NULL DEFAULT 'not_started', submitted_at TEXT,
        last_followup_at TEXT, next_followup_at TEXT, remarks TEXT, ${COMMON}
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vt_registration_party ON vt_registrations(customer_id,COALESCE(vendor_id,0));
      CREATE TABLE IF NOT EXISTS vt_contacts (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        kind TEXT NOT NULL DEFAULT 'general' CHECK(kind IN ('general','procurement','ap')),
        name TEXT NOT NULL, email TEXT, phone TEXT, owner_id INTEGER NOT NULL REFERENCES users(id),
        remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_documents (
        id INTEGER PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES vt_registrations(id),
        type_id INTEGER NOT NULL REFERENCES vt_catalog(id), storage_key TEXT NOT NULL,
        filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
        uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expiry_date TEXT,
        status TEXT NOT NULL DEFAULT 'uploaded', remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_approvals (
        id INTEGER PRIMARY KEY, registration_id INTEGER NOT NULL REFERENCES vt_registrations(id),
        application_date TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', vendor_code TEXT,
        approval_date TEXT, valid_until TEXT, document_id INTEGER REFERENCES vt_documents(id),
        owner_id INTEGER NOT NULL REFERENCES users(id), remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_enquiries (
        id INTEGER PRIMARY KEY, crm_funnel_id INTEGER NOT NULL UNIQUE REFERENCES crm_funnel(id),
        registration_id INTEGER NOT NULL REFERENCES vt_registrations(id),
        customer_id INTEGER NOT NULL REFERENCES customers(id), contact_id INTEGER REFERENCES vt_contacts(id),
        product_service TEXT, enquiry_date TEXT NOT NULL, rfq_number TEXT,
        expected_amount_paise INTEGER CHECK(expected_amount_paise IS NULL OR expected_amount_paise>=0),
        due_date TEXT, owner_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'enquiry_received',
        is_mnc INTEGER NOT NULL DEFAULT 0 CHECK(is_mnc IN (0,1)), next_followup_at TEXT, remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_accounts (
        id INTEGER PRIMARY KEY, platform_id INTEGER NOT NULL REFERENCES vt_catalog(id),
        vendor_id INTEGER REFERENCES vendors(id), registration_date TEXT,
        status TEXT NOT NULL DEFAULT 'not_started', account_status TEXT NOT NULL DEFAULT 'inactive',
        login_id TEXT, last_verified_date TEXT, owner_id INTEGER NOT NULL REFERENCES users(id),
        remarks TEXT, ${COMMON}
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vt_account_party ON vt_accounts(platform_id,COALESCE(vendor_id,0));
      CREATE TABLE IF NOT EXISTS vt_mappings (
        id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL REFERENCES customers(id),
        platform_id INTEGER NOT NULL REFERENCES vt_catalog(id), account_id INTEGER REFERENCES vt_accounts(id),
        contact_id INTEGER REFERENCES vt_contacts(id), turnover_over_250cr INTEGER CHECK(turnover_over_250cr IN (0,1)),
        acceptance_confirmed INTEGER CHECK(acceptance_confirmed IN (0,1)),
        last_contact_at TEXT, next_followup_at TEXT, owner_id INTEGER NOT NULL REFERENCES users(id),
        remarks TEXT, ${COMMON}, UNIQUE(customer_id,platform_id)
      );
      CREATE TABLE IF NOT EXISTS vt_followups (
        id INTEGER PRIMARY KEY, enquiry_id INTEGER REFERENCES vt_enquiries(id),
        mapping_id INTEGER REFERENCES vt_mappings(id), registration_id INTEGER REFERENCES vt_registrations(id),
        owner_id INTEGER NOT NULL REFERENCES users(id), contact_at TEXT, next_followup_at TEXT,
        notes TEXT NOT NULL, reminder_at TEXT, completed_at TEXT, ${COMMON},
        CHECK((enquiry_id IS NOT NULL)+(mapping_id IS NOT NULL)+(registration_id IS NOT NULL)=1)
      );
      CREATE TABLE IF NOT EXISTS vt_invoices (
        id INTEGER PRIMARY KEY, sales_bill_id INTEGER NOT NULL UNIQUE REFERENCES sales_bills(id),
        customer_id INTEGER NOT NULL REFERENCES customers(id), vendor_id INTEGER REFERENCES vendors(id),
        registration_id INTEGER REFERENCES vt_registrations(id), account_id INTEGER NOT NULL REFERENCES vt_accounts(id),
        platform_id INTEGER NOT NULL REFERENCES vt_catalog(id), external_invoice_number TEXT NOT NULL,
        invoice_number_key TEXT NOT NULL, invoice_date TEXT NOT NULL, due_date TEXT,
        amount_paise INTEGER NOT NULL CHECK(amount_paise>0), po_number TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id), status TEXT NOT NULL DEFAULT 'uploaded',
        uploaded_at TEXT, accepted_at TEXT, bid_at TEXT, funded_at TEXT,
        remarks TEXT, ${COMMON}
      );
      CREATE UNIQUE INDEX IF NOT EXISTS vt_invoice_identity ON vt_invoices(customer_id,COALESCE(vendor_id,0),invoice_number_key);
      CREATE TABLE IF NOT EXISTS vt_invoice_documents (
        id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL REFERENCES vt_invoices(id),
        purpose TEXT NOT NULL CHECK(purpose IN ('invoice','proof')), storage_key TEXT NOT NULL,
        filename TEXT NOT NULL, mime TEXT NOT NULL, size_bytes INTEGER NOT NULL CHECK(size_bytes>0),
        uploaded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, expiry_date TEXT,
        status TEXT NOT NULL DEFAULT 'uploaded', remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_funding (
        id INTEGER PRIMARY KEY, invoice_id INTEGER NOT NULL UNIQUE REFERENCES vt_invoices(id),
        principal_paise INTEGER CHECK(principal_paise IS NULL OR principal_paise>0),
        discount_rate REAL CHECK(discount_rate IS NULL OR (discount_rate>=0 AND discount_rate<=100)),
        basis TEXT CHECK(basis IN ('flat','annualized')), term_days INTEGER CHECK(term_days IS NULL OR term_days>=0),
        day_basis INTEGER CHECK(day_basis IN (360,365)), discount_paise INTEGER CHECK(discount_paise IS NULL OR discount_paise>=0),
        fees_paise INTEGER CHECK(fees_paise IS NULL OR fees_paise>=0), taxes_paise INTEGER CHECK(taxes_paise IS NULL OR taxes_paise>=0),
        expected_net_paise INTEGER, actual_received_paise INTEGER CHECK(actual_received_paise IS NULL OR actual_received_paise>=0),
        expected_settlement TEXT, bank_reference TEXT, receivable_id INTEGER REFERENCES receivables(id),
        collection_id INTEGER REFERENCES collections(id), bank_transaction_id INTEGER REFERENCES bank_transactions(id),
        status TEXT NOT NULL DEFAULT 'invoice_uploaded',
        approved_at TEXT, funded_at TEXT, reconciled_at TEXT, closed_at TEXT,
        owner_id INTEGER NOT NULL REFERENCES users(id), remarks TEXT, ${COMMON}
      );
      CREATE TABLE IF NOT EXISTS vt_history (
        id INTEGER PRIMARY KEY, entity_type TEXT NOT NULL, entity_id INTEGER NOT NULL, event TEXT NOT NULL,
        old_status TEXT, new_status TEXT, before_json TEXT, after_json TEXT,
        actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL, changed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, remarks TEXT
      );
      CREATE TRIGGER IF NOT EXISTS vt_history_no_update BEFORE UPDATE ON vt_history BEGIN SELECT RAISE(ABORT,'Workflow history is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS vt_history_no_delete BEFORE DELETE ON vt_history BEGIN SELECT RAISE(ABORT,'Workflow history is immutable'); END;
      CREATE TABLE IF NOT EXISTS vt_task_links (
        id INTEGER PRIMARY KEY, daily_work_plan_id INTEGER UNIQUE REFERENCES daily_work_plans(id),
        pms_task_id INTEGER UNIQUE REFERENCES pms_tasks(id),
        customer_id INTEGER REFERENCES customers(id), registration_id INTEGER REFERENCES vt_registrations(id), reminder_at TEXT,
        priority TEXT NOT NULL DEFAULT 'normal', planning_state TEXT NOT NULL DEFAULT 'planned', remarks TEXT, ${COMMON},
        CHECK(daily_work_plan_id IS NOT NULL OR pms_task_id IS NOT NULL)
      );
      CREATE TABLE IF NOT EXISTS vt_reminder_keys (
        user_id INTEGER NOT NULL REFERENCES users(id), key TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,key)
      );
      CREATE INDEX IF NOT EXISTS vt_registration_owner_date ON vt_registrations(owner_id,registration_date,id);
      CREATE INDEX IF NOT EXISTS vt_registration_followup ON vt_registrations(status,next_followup_at,id);
      CREATE INDEX IF NOT EXISTS vt_document_registration ON vt_documents(registration_id,type_id);
      CREATE INDEX IF NOT EXISTS vt_document_expiry ON vt_documents(expiry_date) WHERE expiry_date IS NOT NULL;
      CREATE INDEX IF NOT EXISTS vt_approval_expiry ON vt_approvals(status,valid_until);
      CREATE INDEX IF NOT EXISTS vt_approval_registration ON vt_approvals(registration_id);
      CREATE INDEX IF NOT EXISTS vt_contact_customer ON vt_contacts(customer_id,kind);
      CREATE INDEX IF NOT EXISTS vt_enquiry_owner_date ON vt_enquiries(owner_id,enquiry_date,id);
      CREATE INDEX IF NOT EXISTS vt_enquiry_due ON vt_enquiries(status,due_date,id);
      CREATE INDEX IF NOT EXISTS vt_enquiry_registration ON vt_enquiries(registration_id);
      CREATE INDEX IF NOT EXISTS vt_followup_due ON vt_followups(owner_id,completed_at,next_followup_at);
      CREATE INDEX IF NOT EXISTS vt_followup_enquiry ON vt_followups(enquiry_id);
      CREATE INDEX IF NOT EXISTS vt_followup_mapping ON vt_followups(mapping_id);
      CREATE INDEX IF NOT EXISTS vt_followup_registration ON vt_followups(registration_id);
      CREATE INDEX IF NOT EXISTS vt_mapping_owner ON vt_mappings(owner_id,next_followup_at);
      CREATE INDEX IF NOT EXISTS vt_account_owner ON vt_accounts(owner_id,status);
      CREATE INDEX IF NOT EXISTS vt_invoice_status_date ON vt_invoices(status,uploaded_at,id);
      CREATE INDEX IF NOT EXISTS vt_invoice_owner ON vt_invoices(owner_id,invoice_date,id);
      CREATE INDEX IF NOT EXISTS vt_invoice_platform ON vt_invoices(platform_id,account_id);
      CREATE INDEX IF NOT EXISTS vt_invoice_registration ON vt_invoices(registration_id);
      CREATE INDEX IF NOT EXISTS vt_invoice_document_invoice ON vt_invoice_documents(invoice_id,purpose);
      CREATE INDEX IF NOT EXISTS vt_funding_settlement ON vt_funding(status,expected_settlement,id);
      CREATE INDEX IF NOT EXISTS vt_funding_date ON vt_funding(funded_at,id);
      CREATE UNIQUE INDEX IF NOT EXISTS vt_funding_bank_receipt ON vt_funding(bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS vt_funding_collection_receipt ON vt_funding(collection_id) WHERE collection_id IS NOT NULL;
      CREATE INDEX IF NOT EXISTS vt_history_entity ON vt_history(entity_type,entity_id,changed_at,id);
      CREATE INDEX IF NOT EXISTS vt_customer_domain ON customers(website_domain) WHERE website_domain IS NOT NULL;
      CREATE INDEX IF NOT EXISTS vt_customer_pan ON customers(pan) WHERE pan IS NOT NULL;
      CREATE INDEX IF NOT EXISTS vt_customer_gst ON customers(gst_number) WHERE gst_number IS NOT NULL;
    `);
    const seed = db.prepare('INSERT INTO vt_catalog(kind,code,label,required) VALUES(?,?,?,?) ON CONFLICT(kind,code) DO NOTHING');
    for (const [code,label,required] of DOCUMENT_TYPES) seed.run('doc_type',code,label,required);
    for (const [code,label] of [['rxil','RXIL'],['m1xchange','M1xchange'],['invoicemart','InvoiceMart'],['c2treds','C2treds']]) seed.run('platform',code,label,0);
    // Seed catalogue metadata only. Targets, users and transactions are never invented.
    db.prepare("INSERT INTO app_settings(key,value) VALUES('vendor_treds_schema_version','1') ON CONFLICT(key) DO UPDATE SET value=excluded.value").run();
  });
  migrate();
}

module.exports = { ensureVendorTredsSchema, DOCUMENT_TYPES };
