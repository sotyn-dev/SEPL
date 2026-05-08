const Database = require('better-sqlite3');
const path = require('path');
const bcrypt = require('bcryptjs');

const DB_PATH = path.join(__dirname, '..', '..', 'data', 'erp.db');

let db;

function getDb() {
  if (!db) {
    const fs = require('fs');
    const dataDir = path.join(__dirname, '..', '..', 'data');
    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    db = new Database(DB_PATH);
    // Performance pragmas — measurable speedup on the SEPL VPS:
    // - WAL: concurrent reads while a write is happening (mam: pages
    //   stay snappy even when multiple users punch / save simultaneously)
    // - synchronous=NORMAL: fewer fsyncs, still crash-safe in WAL mode
    // - cache_size=-64000: 64 MB page cache (was ~2 MB default)
    // - mmap_size=128 MB: read pages via memory-map, fewer syscalls
    // - temp_store=MEMORY: temp tables/indices in RAM, not disk
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -64000');
    db.pragma('mmap_size = 134217728');
    db.pragma('temp_store = MEMORY');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

function initializeDatabase() {
  const db = getDb();

  db.exec(`
    -- Users & Auth
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      role TEXT DEFAULT 'user' CHECK(role IN ('admin','manager','user')),
      department TEXT,
      phone TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Roles & Permissions (Admin customizable)
    CREATE TABLE IF NOT EXISTS roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      is_system INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Module-level permissions per role
    CREATE TABLE IF NOT EXISTS role_permissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      module TEXT NOT NULL,
      can_view INTEGER DEFAULT 0,
      can_create INTEGER DEFAULT 0,
      can_edit INTEGER DEFAULT 0,
      can_delete INTEGER DEFAULT 0,
      can_approve INTEGER DEFAULT 0,
      UNIQUE(role_id, module)
    );

    -- User-role assignment (a user can have a custom role)
    CREATE TABLE IF NOT EXISTS user_roles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      role_id INTEGER REFERENCES roles(id) ON DELETE CASCADE,
      UNIQUE(user_id, role_id)
    );

    -- Lead Sources
    CREATE TABLE IF NOT EXISTS lead_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    -- Leads / CRM (kept for backward compatibility)
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_name TEXT NOT NULL,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      source_id INTEGER REFERENCES lead_sources(id),
      status TEXT DEFAULT 'new',
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Funnel Pipeline
    CREATE TABLE IF NOT EXISTS sales_funnel (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT UNIQUE,
      -- Lead Details
      client_name TEXT NOT NULL,
      company_name TEXT,
      phone TEXT,
      email TEXT,
      category TEXT,
      address TEXT,
      district TEXT,
      state TEXT,
      source TEXT,
      assigned_sc TEXT,
      assigned_asm TEXT,
      -- Stage tracking
      current_stage TEXT DEFAULT 'new_lead',
      -- Stage 1: Qualified
      is_qualified INTEGER DEFAULT 0,
      qualified_by TEXT,
      qualified_date DATETIME,
      qualified_remarks TEXT,
      -- Stage 2: Meeting
      meeting_date DATETIME,
      meeting_location TEXT,
      meeting_assigned_to TEXT,
      meeting_status TEXT DEFAULT 'pending',
      -- Stage 3: MOM
      mom_notes TEXT,
      mom_file_link TEXT,
      mom_filled_by TEXT,
      mom_date DATETIME,
      -- Stage 4: Drawing
      drawing_file1 TEXT,
      drawing_file2 TEXT,
      drawing_file3 TEXT,
      drawing_uploaded_by TEXT,
      drawing_date DATETIME,
      -- Stage 5: BOQ
      boq_file_link TEXT,
      boq_created_by TEXT,
      boq_amount REAL DEFAULT 0,
      boq_date DATETIME,
      -- Stage 6: Quotation
      quotation_number TEXT,
      quotation_file_link TEXT,
      quotation_amount REAL DEFAULT 0,
      quotation_sent_by TEXT,
      quotation_sent_date DATETIME,
      -- Stage 7: Result
      result TEXT,
      result_remarks TEXT,
      result_date DATETIME,
      won_amount REAL DEFAULT 0,
      -- Meta
      remarks TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Help/Support Tickets
    CREATE TABLE IF NOT EXISTS support_tickets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticket_no TEXT UNIQUE,
      user_id INTEGER REFERENCES users(id),
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      category TEXT DEFAULT 'bug' CHECK(category IN ('bug','feature_request','how_to','access_issue','data_issue','manpower','material','payment','other')),
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','urgent')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
      attachment_link TEXT,
      module TEXT,
      admin_response TEXT,
      resolved_by INTEGER REFERENCES users(id),
      resolved_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Lead Follow-ups
    CREATE TABLE IF NOT EXISTS lead_followups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES sales_funnel(id) ON DELETE CASCADE,
      followup_date DATE NOT NULL,
      followup_time TEXT,
      type TEXT DEFAULT 'call' CHECK(type IN ('call','email','whatsapp','visit','other')),
      outcome TEXT CHECK(outcome IN ('connected','not_reachable','callback','interested','not_interested','meeting_fixed','quotation_asked','follow_later')),
      notes TEXT,
      next_followup_date DATE,
      done INTEGER DEFAULT 0,
      done_by INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Meetings
    CREATE TABLE IF NOT EXISTS meetings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      scheduled_at DATETIME NOT NULL,
      location TEXT,
      agenda TEXT,
      outcome TEXT,
      status TEXT DEFAULT 'scheduled' CHECK(status IN ('scheduled','completed','cancelled')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- BOQ (Bill of Quantities)
    CREATE TABLE IF NOT EXISTS boq (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      title TEXT NOT NULL,
      drawing_required INTEGER DEFAULT 0,
      drawing_file TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS boq_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      boq_id INTEGER REFERENCES boq(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0
    );

    -- Quotations
    CREATE TABLE IF NOT EXISTS quotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES leads(id),
      boq_id INTEGER REFERENCES boq(id),
      quotation_number TEXT UNIQUE,
      total_amount REAL DEFAULT 0,
      discount REAL DEFAULT 0,
      final_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','sent','negotiation','accepted','rejected')),
      valid_until DATE,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Orders (from client)
    CREATE TABLE IF NOT EXISTS purchase_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER REFERENCES business_book(id),
      lead_id INTEGER REFERENCES leads(id),
      quotation_id INTEGER REFERENCES quotations(id),
      po_number TEXT UNIQUE NOT NULL,
      po_date DATE NOT NULL,
      total_amount REAL DEFAULT 0,
      advance_amount REAL DEFAULT 0,
      advance_received INTEGER DEFAULT 0,
      po_copy_link TEXT,
      pt_advance REAL DEFAULT 0,
      pt_delivery REAL DEFAULT 0,
      pt_installation REAL DEFAULT 0,
      pt_commissioning REAL DEFAULT 0,
      pt_retention REAL DEFAULT 0,
      status TEXT DEFAULT 'received' CHECK(status IN ('received','booked','planning','in_progress','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Item Master (from Drive Item-wise sheet)
    CREATE TABLE IF NOT EXISTS item_master (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_code TEXT UNIQUE,
      department TEXT,
      item_name TEXT NOT NULL,
      specification TEXT,
      size TEXT,
      uom TEXT DEFAULT 'PCS',
      gst TEXT DEFAULT '18%',
      type TEXT DEFAULT 'PO',
      make TEXT,
      model_number TEXT,
      current_price REAL DEFAULT 0,
      catalogue_link TEXT,
      photo_link TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Business Book (Master New Business Booked Sheet - matches Google Form/Excel)
    CREATE TABLE IF NOT EXISTS business_book (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_no TEXT UNIQUE,
      lead_type TEXT DEFAULT 'Private' CHECK(lead_type IN ('Private','Government')),
      client_name TEXT NOT NULL,
      company_name TEXT,
      project_name TEXT,
      client_contact TEXT,
      client_email TEXT,
      email_address TEXT,
      source_of_enquiry TEXT,
      district TEXT,
      state TEXT,
      billing_address TEXT,
      shipping_address TEXT,
      guarantee_required TEXT DEFAULT 'No',
      guarantee_percentage TEXT,
      sale_amount_without_gst REAL DEFAULT 0,
      po_amount REAL DEFAULT 0,
      order_type TEXT DEFAULT 'Supply',
      penalty_clause TEXT DEFAULT 'No',
      penalty_clause_date DATE,
      committed_start_date DATE,
      committed_delivery_date DATE,
      committed_completion_date DATE,
      freight_extra TEXT DEFAULT 'No',
      category TEXT,
      customer_type TEXT,
      client_type TEXT,
      customer_code TEXT,
      -- People
      employee_assigned TEXT,
      employee_id INTEGER REFERENCES users(id),
      lead_by TEXT,
      management_person_name TEXT,
      management_person_contact TEXT,
      operations_person_name TEXT,
      operations_person_contact TEXT,
      pmc_person_name TEXT,
      pmc_person_contact TEXT,
      architect_person_name TEXT,
      architect_person_contact TEXT,
      accounts_person_name TEXT,
      accounts_person_contact TEXT,
      -- TPA Details
      tpa_items_count INTEGER DEFAULT 0,
      tpa_items_qty TEXT,
      tpa_material_amount REAL DEFAULT 0,
      tpa_labour_amount REAL DEFAULT 0,
      accessory_amount REAL DEFAULT 0,
      required_labour_per_day TEXT,
      actual_margin_pct REAL DEFAULT 0,
      -- Payment Terms
      payment_advance TEXT,
      payment_against_delivery TEXT,
      payment_against_installation TEXT,
      payment_against_commissioning TEXT,
      payment_retention TEXT,
      payment_credit TEXT,
      credit_days INTEGER DEFAULT 0,
      advance_received REAL DEFAULT 0,
      balance_amount REAL DEFAULT 0,
      -- PO Details (combined - no separate PO needed)
      po_number TEXT,
      po_date DATE,
      po_copy_link TEXT,
      -- File Links
      boq_file_link TEXT,
      boq_signed_link TEXT,
      tpa_material_link TEXT,
      tpa_material_signed_link TEXT,
      tpa_labour_link TEXT,
      tpa_labour_signed_link TEXT,
      final_drawing_link TEXT,
      -- Other
      remarks TEXT,
      status TEXT DEFAULT 'booked' CHECK(status IN ('booked','advance_received','planning','execution','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- PO Items (item-wise data for each PO / Business Book entry)
    CREATE TABLE IF NOT EXISTS po_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER REFERENCES business_book(id) ON DELETE CASCADE,
      item_master_id INTEGER REFERENCES item_master(id),
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      hsn_code TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Order Planning
    CREATE TABLE IF NOT EXISTS order_planning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      business_book_id INTEGER REFERENCES business_book(id),
      planned_start DATE,
      planned_end DATE,
      notes TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed')),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendors
    CREATE TABLE IF NOT EXISTS customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_code TEXT UNIQUE,
      category TEXT,
      company_name TEXT NOT NULL,
      sub_company_name TEXT,
      company_registration_address TEXT,
      contact_no TEXT,
      email TEXT,
      concern_person_name TEXT,
      concern_person_email TEXT,
      concern_person_address TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS vendors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_code TEXT UNIQUE,
      name TEXT NOT NULL,
      firm_name TEXT,
      contact_person TEXT,
      phone TEXT,
      email TEXT,
      district TEXT,
      state TEXT,
      address TEXT,
      category TEXT,
      deals_in TEXT,
      authorized_dealer TEXT,
      type TEXT,
      turnover TEXT,
      team_size TEXT,
      payment_terms TEXT,
      credit_days TEXT,
      gst_number TEXT,
      source TEXT,
      category_wise TEXT,
      sub_category TEXT,
      existing_vendor TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendor Rate Comparison
    CREATE TABLE IF NOT EXISTS vendor_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_id INTEGER REFERENCES order_planning(id),
      item_description TEXT NOT NULL,
      vendor1_id INTEGER REFERENCES vendors(id),
      vendor1_rate REAL DEFAULT 0,
      vendor2_id INTEGER REFERENCES vendors(id),
      vendor2_rate REAL DEFAULT 0,
      vendor3_id INTEGER REFERENCES vendors(id),
      vendor3_rate REAL DEFAULT 0,
      final_rate REAL DEFAULT 0,
      selected_vendor_id INTEGER REFERENCES vendors(id),
      approved_by TEXT,
      approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Indent (Material Request)
    CREATE TABLE IF NOT EXISTS indents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      planning_id INTEGER REFERENCES order_planning(id),
      indent_number TEXT UNIQUE,
      indent_date DATE DEFAULT CURRENT_DATE,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','po_sent','dispatched','received')),
      approved_by INTEGER REFERENCES users(id),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS indent_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      quantity REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      vendor_id INTEGER REFERENCES vendors(id)
    );

    -- Vendor PO (purchase order to vendor)
    CREATE TABLE IF NOT EXISTS vendor_pos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id),
      vendor_id INTEGER REFERENCES vendors(id),
      po_number TEXT UNIQUE,
      total_amount REAL DEFAULT 0,
      advance_required INTEGER DEFAULT 0,
      advance_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'sent' CHECK(status IN ('sent','acknowledged','dispatched','delivered','completed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Purchase Bills
    CREATE TABLE IF NOT EXISTS purchase_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      vendor_id INTEGER REFERENCES vendors(id),
      bill_number TEXT,
      bill_date DATE,
      amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Delivery Notes
    CREATE TABLE IF NOT EXISTS delivery_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      delivery_date DATE,
      received_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','received','partial','rejected')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Bills (to client)
    CREATE TABLE IF NOT EXISTS sales_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      bill_number TEXT UNIQUE,
      bill_date DATE,
      amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Installation
    CREATE TABLE IF NOT EXISTS installations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      po_id INTEGER REFERENCES purchase_orders(id),
      site_address TEXT,
      start_date DATE,
      end_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','testing')),
      assigned_to INTEGER REFERENCES users(id),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- RA Bill (Running Account Bill)
    CREATE TABLE IF NOT EXISTS ra_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      bill_number TEXT,
      bill_date DATE,
      work_done_amount REAL DEFAULT 0,
      previous_amount REAL DEFAULT 0,
      current_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- MB Bill (Measurement Book)
    CREATE TABLE IF NOT EXISTS mb_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ra_bill_id INTEGER REFERENCES ra_bills(id),
      installation_id INTEGER REFERENCES installations(id),
      bill_number TEXT,
      measurements TEXT,
      total_amount REAL DEFAULT 0,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','verified','approved')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Installation Bills
    CREATE TABLE IF NOT EXISTS installation_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      mb_bill_id INTEGER REFERENCES mb_bills(id),
      bill_number TEXT,
      amount REAL DEFAULT 0,
      payment_status TEXT DEFAULT 'pending' CHECK(payment_status IN ('pending','partial','paid')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Testing & Commissioning
    CREATE TABLE IF NOT EXISTS testing_commissioning (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      test_date DATE,
      test_type TEXT,
      result TEXT CHECK(result IN ('pass','fail','partial')),
      notes TEXT,
      tested_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Complaints
    CREATE TABLE IF NOT EXISTS complaints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      complaint_number TEXT UNIQUE,
      -- Step 1: Registration (Client)
      client_name TEXT NOT NULL,
      company_name TEXT,
      mobile_number TEXT,
      category TEXT,
      problem_detail TEXT NOT NULL,
      customer_type TEXT,
      complaint_type TEXT,
      emp_name TEXT,
      step1_planned_date DATE,
      step1_actual_date DATE,
      step1_time_delay INTEGER DEFAULT 0,
      step1_assigned_to TEXT,
      -- Step 2: Resolution (CRM/LV Team)
      step2_planned_date DATE,
      step2_actual_date DATE,
      step2_time_delay INTEGER DEFAULT 0,
      step2_assigned_to TEXT,
      service_report TEXT,
      -- Legacy fields for backward compat
      installation_id INTEGER REFERENCES installations(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      description TEXT,
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','in_progress','resolved','closed')),
      resolved_date DATE,
      resolution_notes TEXT,
      created_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Handover Certificates
    CREATE TABLE IF NOT EXISTS handover_certificates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      installation_id INTEGER REFERENCES installations(id),
      po_id INTEGER REFERENCES purchase_orders(id),
      certificate_number TEXT UNIQUE,
      handover_date DATE,
      client_signatory TEXT,
      company_signatory TEXT,
      notes TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','signed','completed')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Payment Tracking
    CREATE TABLE IF NOT EXISTS payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT CHECK(type IN ('receivable','payable')),
      reference_type TEXT,
      reference_id INTEGER,
      amount REAL DEFAULT 0,
      payment_date DATE,
      payment_mode TEXT,
      transaction_ref TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR: Job Candidates
    CREATE TABLE IF NOT EXISTS candidates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      source TEXT CHECK(source IN ('facebook','naukri','linkedin','reference','other')),
      position TEXT,
      status TEXT DEFAULT 'lead' CHECK(status IN ('lead','called','qualified','interview_scheduled','interview_done','offer_sent','accepted','onboarded','rejected')),
      resume_file TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- HR: Employees
    CREATE TABLE IF NOT EXISTS employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      designation TEXT,
      department TEXT,
      join_date DATE,
      salary REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','training','inactive','terminated')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sub-Contractors
    CREATE TABLE IF NOT EXISTS sub_contractors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      phone TEXT,
      email TEXT,
      specialization TEXT,
      rate REAL DEFAULT 0,
      rate_unit TEXT DEFAULT 'per_day',
      status TEXT DEFAULT 'qualified' CHECK(status IN ('qualified','negotiation','onboarded','active','inactive')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Expenses
    CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      amount REAL NOT NULL,
      category TEXT,
      expense_date DATE DEFAULT CURRENT_DATE,
      receipt_file TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected','paid')),
      submitted_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      paid_date DATE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Checklists
    CREATE TABLE IF NOT EXISTS checklists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      frequency TEXT DEFAULT 'monthly' CHECK(frequency IN ('daily','weekly','monthly','quarterly','yearly','once')),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','overdue')),
      assigned_to INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Activity Log
    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      module TEXT NOT NULL,
      action TEXT NOT NULL,
      record_id INTEGER,
      details TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 1: AUTOMATIC CASH FLOW SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS cash_flow_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date DATE UNIQUE NOT NULL,
      opening_balance REAL DEFAULT 0,
      total_inflows REAL DEFAULT 0,
      total_outflows REAL DEFAULT 0,
      closing_balance REAL DEFAULT 0,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS cash_flow_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      daily_id INTEGER REFERENCES cash_flow_daily(id),
      date DATE NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('inflow','outflow')),
      category TEXT NOT NULL,
      description TEXT NOT NULL,
      amount REAL NOT NULL,
      reference_type TEXT,
      reference_id INTEGER,
      payment_mode TEXT,
      party_name TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 2: COLLECTION ENGINE SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS receivables (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      client_name TEXT NOT NULL,
      project_name TEXT,
      po_id INTEGER REFERENCES purchase_orders(id),
      invoice_number TEXT,
      invoice_date DATE,
      invoice_amount REAL NOT NULL DEFAULT 0,
      received_amount REAL DEFAULT 0,
      outstanding_amount REAL DEFAULT 0,
      due_date DATE,
      ageing_days INTEGER DEFAULT 0,
      ageing_bucket TEXT DEFAULT '0-30' CHECK(ageing_bucket IN ('0-30','31-60','61-90','90+')),
      status TEXT DEFAULT 'red' CHECK(status IN ('green','yellow','red')),
      follow_up_status TEXT DEFAULT 'pending' CHECK(follow_up_status IN ('pending','contacted','promised','escalated','legal')),
      follow_up_date DATE,
      follow_up_notes TEXT,
      escalation_level INTEGER DEFAULT 0,
      owner_id INTEGER REFERENCES users(id),
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collection_follow_ups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receivable_id INTEGER REFERENCES receivables(id) ON DELETE CASCADE,
      follow_up_date DATE NOT NULL,
      contact_method TEXT CHECK(contact_method IN ('call','email','visit','whatsapp','legal_notice')),
      response TEXT,
      promised_date DATE,
      promised_amount REAL,
      status TEXT DEFAULT 'done',
      followed_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      receivable_id INTEGER REFERENCES receivables(id),
      amount REAL NOT NULL,
      collection_date DATE NOT NULL,
      payment_mode TEXT,
      transaction_ref TEXT,
      notes TEXT,
      collected_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- SYSTEM 3: INDENT TO PAYMENT FMS (Enhanced)
    -- ============================================
    CREATE TABLE IF NOT EXISTS grn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      indent_id INTEGER REFERENCES indents(id),
      grn_number TEXT UNIQUE,
      grn_date DATE NOT NULL,
      received_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','partial','complete','rejected')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS grn_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER REFERENCES grn(id) ON DELETE CASCADE,
      description TEXT NOT NULL,
      ordered_qty REAL DEFAULT 0,
      received_qty REAL DEFAULT 0,
      accepted_qty REAL DEFAULT 0,
      rejected_qty REAL DEFAULT 0,
      unit TEXT DEFAULT 'nos',
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      remarks TEXT
    );

    CREATE TABLE IF NOT EXISTS indent_tracker (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_id INTEGER REFERENCES indents(id),
      stage TEXT NOT NULL CHECK(stage IN ('indent_raised','approval_pending','approved','po_created','dispatched','grn_done','bill_entered','payment_done')),
      stage_date DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      notes TEXT
    );

    -- ============================================
    -- SYSTEM 4: DPR DAILY CALCULATION SYSTEM
    -- ============================================
    CREATE TABLE IF NOT EXISTS sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      client_name TEXT,
      po_id INTEGER REFERENCES purchase_orders(id),
      business_book_id INTEGER REFERENCES business_book(id),
      site_engineer_id INTEGER REFERENCES users(id),
      supervisor TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','on_hold')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS dpr (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      report_date DATE NOT NULL,
      submitted_by INTEGER REFERENCES users(id),
      submission_time DATETIME,
      weather TEXT DEFAULT 'clear' CHECK(weather IN ('clear','rainy','cloudy','hot','windy')),
      overall_status TEXT DEFAULT 'on_track' CHECK(overall_status IN ('on_track','delayed','ahead','blocked')),
      -- SEPL DPR format
      shift TEXT DEFAULT 'day',
      contractor_name TEXT,
      contractor_manpower INTEGER DEFAULT 0,
      mb_sheet_no TEXT,
      grand_total_a REAL DEFAULT 0,
      grand_total_b REAL DEFAULT 0,
      profit_loss REAL DEFAULT 0,
      floor_zone TEXT,
      system_type TEXT,
      safety_toolbox_talk INTEGER DEFAULT 0,
      safety_ppe_compliance INTEGER DEFAULT 0,
      safety_incidents TEXT,
      next_day_plan TEXT,
      hindrances TEXT,
      site_photos TEXT,
      remarks TEXT,
      billing_ready INTEGER DEFAULT 0,
      approved_by INTEGER REFERENCES users(id),
      approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending','approved','rejected')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Work items from PO (item name, qty, rate, amount + floor/zone + planned/actual)
    CREATE TABLE IF NOT EXISTS dpr_work_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id),
      description TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      floor_zone TEXT,
      boq_qty REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      planned_qty REAL DEFAULT 0,
      actual_qty REAL DEFAULT 0,
      cumulative_qty REAL DEFAULT 0,
      variance_pct REAL DEFAULT 0,
      remarks TEXT
    );

    -- MEPF Trade-wise manpower
    CREATE TABLE IF NOT EXISTS dpr_manpower (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      trade TEXT NOT NULL,
      required INTEGER DEFAULT 0,
      deployed INTEGER DEFAULT 0,
      shortage INTEGER DEFAULT 0
    );

    -- Material consumed from PO items
    CREATE TABLE IF NOT EXISTS dpr_material (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      po_item_id INTEGER REFERENCES po_items(id),
      material_name TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      boq_qty REAL DEFAULT 0,
      consumed_today REAL DEFAULT 0,
      cumulative_consumed REAL DEFAULT 0,
      balance_qty REAL DEFAULT 0,
      remarks TEXT
    );

    -- Machinery/Tools used on site
    CREATE TABLE IF NOT EXISTS dpr_machinery (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dpr_id INTEGER REFERENCES dpr(id) ON DELETE CASCADE,
      equipment TEXT NOT NULL,
      quantity INTEGER DEFAULT 1,
      hours_used REAL DEFAULT 0,
      condition TEXT DEFAULT 'working',
      remarks TEXT
    );

    -- ============================================
    -- PAYMENT REQUIRED MODULE (FMS)
    -- ============================================
    CREATE TABLE IF NOT EXISTS payment_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE,
      employee_name TEXT NOT NULL,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      department TEXT,
      contact_number TEXT,
      category TEXT NOT NULL CHECK(category IN ('TA/DA','Purchase','Labour','Transport')),
      amount REAL NOT NULL DEFAULT 0,
      purpose TEXT NOT NULL,
      payment_mode TEXT DEFAULT 'Bank' CHECK(payment_mode IN ('Cash','Bank','UPI')),
      required_by_date DATE,
      attachment_link TEXT,
      -- TA/DA fields
      travel_from_to TEXT,
      travel_dates TEXT,
      mode_of_travel TEXT,
      stay_details TEXT,
      ticket_upload TEXT,
      start_km REAL DEFAULT 0,
      end_km REAL DEFAULT 0,
      km_photo TEXT,
      -- Purchase fields
      indent_number TEXT,
      item_description TEXT,
      vendor_name TEXT,
      quotation_link TEXT,
      -- Labour fields
      labour_type TEXT,
      number_of_workers INTEGER DEFAULT 0,
      work_duration TEXT,
      site_engineer_name TEXT,
      -- Transport fields
      vehicle_type TEXT,
      from_to_location TEXT,
      material_description TEXT,
      driver_vendor_name TEXT,
      -- Status & Workflow
      current_step INTEGER DEFAULT 1,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','step1_approved','accounts_approved','dues_checked','velocity_checked','final_approved','rejected')),
      rejection_remarks TEXT,
      rejected_by INTEGER REFERENCES users(id),
      rejected_at DATETIME,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Approval trail for payment requests
    CREATE TABLE IF NOT EXISTS payment_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id INTEGER REFERENCES payment_requests(id) ON DELETE CASCADE,
      step INTEGER NOT NULL,
      step_name TEXT NOT NULL,
      action TEXT NOT NULL CHECK(action IN ('approved','rejected')),
      remarks TEXT,
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- ATTENDANCE MODULE (Geofencing + Live Photo)
    -- ============================================
    CREATE TABLE IF NOT EXISTS attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      punch_in_time DATETIME,
      punch_out_time DATETIME,
      punch_in_lat REAL,
      punch_in_lng REAL,
      punch_in_address TEXT,
      punch_in_photo TEXT,
      punch_out_lat REAL,
      punch_out_lng REAL,
      punch_out_address TEXT,
      punch_out_photo TEXT,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      total_hours REAL DEFAULT 0,
      status TEXT DEFAULT 'present' CHECK(status IN ('present','half_day','short_day','absent','late','leave','holiday')),
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Geofence settings per site
    CREATE TABLE IF NOT EXISTS geofence_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      radius_meters INTEGER DEFAULT 200,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Project Finance (manual fields for cash flow tracker)
    CREATE TABLE IF NOT EXISTS project_finance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      business_book_id INTEGER UNIQUE REFERENCES business_book(id),
      amount_received REAL DEFAULT 0,
      milestone_name TEXT,
      aanchal_value REAL DEFAULT 0,
      payment_investment_days INTEGER DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Location tracking (live tracking throughout the day)
    CREATE TABLE IF NOT EXISTS location_tracking (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      date DATE NOT NULL,
      time DATETIME NOT NULL,
      latitude REAL,
      longitude REAL,
      address TEXT,
      site_name TEXT
    );

    -- Leave requests
    CREATE TABLE IF NOT EXISTS leave_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      leave_type TEXT DEFAULT 'casual' CHECK(leave_type IN ('casual','sick','earned','half_day','short_leave','comp_off')),
      from_date DATE NOT NULL,
      to_date DATE NOT NULL,
      from_time TEXT,
      to_time TEXT,
      days INTEGER DEFAULT 1,
      hours REAL DEFAULT 0,
      reason TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
      approved_by INTEGER REFERENCES users(id),
      remarks TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Payroll settings (single-row config, id=1). Admin tunes every rule
    -- here so salary auto-calc isn't hardcoded — late cutoff, half-day
    -- cutoff, leave allowances, working days, OT rate, etc.
    CREATE TABLE IF NOT EXISTS payroll_settings (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      late_after_time TEXT DEFAULT '09:46',           -- start of late zone (after this = late mark)
      half_day_after_time TEXT DEFAULT '10:00',       -- after this time = half day deduction
      min_hours_full_day REAL DEFAULT 8,              -- below this hours = half day
      min_hours_half_day REAL DEFAULT 4,              -- below this hours = absent
      skip_half_day_if_short_leave INTEGER DEFAULT 1, -- if short leave applied that day → no half-day deduction
      late_grace_count INTEGER DEFAULT 3,             -- N late marks per month are free
      late_per_minute_rate REAL DEFAULT 20,           -- Rs / minute deduction once over grace
      lates_to_absent INTEGER DEFAULT 0,              -- N late marks = 1 absent (alternative model, 0 disables)
      basic_pct REAL DEFAULT 56.5,                    -- Salary breakdown (matches SEPL slip)
      conveyance_pct REAL DEFAULT 22.6,
      hra_pct REAL DEFAULT 5.9,
      adhoc_pct REAL DEFAULT 15.0,
      misc_pct REAL DEFAULT 0,
      working_days_per_month INTEGER DEFAULT 26,      -- divisor for per-day rate
      sundays_paid INTEGER DEFAULT 1,                 -- 1 = Sundays counted as paid for monthly staff
      cl_per_month REAL DEFAULT 1,                    -- paid casual leave allowance per month
      sl_per_month REAL DEFAULT 1,                    -- paid sick leave allowance
      pl_per_month REAL DEFAULT 1.5,                  -- paid privilege/earned leave
      short_leave_per_month INTEGER DEFAULT 2,        -- short-leave count allowed
      ot_threshold_hours REAL DEFAULT 8,              -- hours/day before OT kicks in
      ot_rate_multiplier REAL DEFAULT 1.5,            -- OT pay rate (× normal hourly)
      pay_cycle_start_day INTEGER DEFAULT 1,          -- 1 = month-start, 26 = 26th-to-25th
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );

    -- Saved monthly payroll runs — when admin "Finalises" a month the
    -- calculated salary snapshot is locked here so future attendance edits
    -- don't change historical payslips.
    CREATE TABLE IF NOT EXISTS payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      month TEXT NOT NULL,                            -- YYYY-MM
      employee_id INTEGER REFERENCES employees(id),
      employee_name TEXT,
      base_salary REAL DEFAULT 0,
      working_days INTEGER DEFAULT 0,
      paid_days REAL DEFAULT 0,
      half_days INTEGER DEFAULT 0,
      absent_days INTEGER DEFAULT 0,
      late_marks INTEGER DEFAULT 0,
      lates_converted_absent REAL DEFAULT 0,
      paid_leaves REAL DEFAULT 0,
      unpaid_leaves REAL DEFAULT 0,
      sundays REAL DEFAULT 0,
      ot_hours REAL DEFAULT 0,
      gross_earned REAL DEFAULT 0,
      ot_pay REAL DEFAULT 0,
      deductions REAL DEFAULT 0,
      net_pay REAL DEFAULT 0,
      breakdown_json TEXT,                            -- per-day breakdown for slip
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft','finalised','disbursed')),
      finalised_by INTEGER REFERENCES users(id),
      finalised_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(month, employee_id)
    );

    -- Score-card templates (one per role / job-type). Each template has
    -- many KPIs that sum to 100% weight. Mam shared 20 such templates as
    -- PDFs (Aanchal-Finance, Site Eng, Supervisor, etc.) on 2026-05-04.
    CREATE TABLE IF NOT EXISTS score_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- KPIs (metrics) within a template
    CREATE TABLE IF NOT EXISTS score_kpis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      template_id INTEGER REFERENCES score_templates(id) ON DELETE CASCADE,
      group_name TEXT,                       -- 'Basic' | 'Weekly' | 'Monthly' | custom
      metric_name TEXT NOT NULL,
      weightage REAL DEFAULT 0,              -- 0-100, sum to 100 per template
      direction TEXT DEFAULT 'higher_better',-- 'higher_better' or 'lower_better'
      data_source TEXT DEFAULT 'manual',     -- 'manual' | 'auto:delegations' | 'auto:pms' | 'auto:checklists' | 'auto:tickets'
      display_order INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      default_planned REAL DEFAULT 0,        -- fixed weekly target (mam's "this plan is fix")
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Each user is assigned to one template (their role's MIS)
    CREATE TABLE IF NOT EXISTS score_user_template (
      user_id INTEGER PRIMARY KEY REFERENCES users(id),
      template_id INTEGER REFERENCES score_templates(id),
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      assigned_by INTEGER REFERENCES users(id)
    );

    -- Weekly entries: one row per (user, kpi, week_start_monday)
    CREATE TABLE IF NOT EXISTS score_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER REFERENCES users(id),
      kpi_id INTEGER REFERENCES score_kpis(id),
      week_start DATE NOT NULL,
      planned REAL DEFAULT 0,
      actual REAL DEFAULT 0,
      actual_pct REAL,
      last_week_pct REAL,
      total_uptodate REAL,
      pending_uptodate REAL,
      pending_work REAL,
      pending_pct REAL,
      commitment TEXT,
      notes TEXT,
      updated_by INTEGER REFERENCES users(id),
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(user_id, kpi_id, week_start)
    );

    -- Web Push subscriptions — one row per (user × device). Multiple
    -- rows per user is fine (mam wants phone + laptop + desktop).
    -- VAPID keys stored in app_settings as a single row.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      device_label TEXT,
      active INTEGER DEFAULT 1,
      last_seen_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Generic key/value app settings — used for VAPID keys + future
    -- one-shot config that doesn't deserve its own table.
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Sales Funnel — universal stage audit log per mam's spec:
    -- 'every stage entry timestamp · actor (user_id) · action · evidence
    -- (file/note) · stage exit timestamp'. Forward-only state machine;
    -- backward transitions allowed only with reason + supervisor approval
    -- (also logged here).
    CREATE TABLE IF NOT EXISTS sales_funnel_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER REFERENCES sales_funnel(id) ON DELETE CASCADE,
      stage TEXT,                                  -- stage name at time of action
      action TEXT,                                 -- 'create' | 'enter_stage' | 'exit_stage' | 'drop' | 'reopen' | 'edit'
      actor_id INTEGER REFERENCES users(id),
      actor_name TEXT,                             -- snapshot
      evidence_url TEXT,                           -- optional file
      notes TEXT,                                  -- free-text reason / context
      at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_sf_audit_lead ON sales_funnel_audit(lead_id, at);

    -- Snag list — defects / punch-list items raised against a site,
    -- assigned to an employee, who uploads proof and only then it's
    -- closed by approval (delegation-style flow). Mam's ask:
    -- "assign employee will upload proof and after approval task close
    -- like delegation".
    --
    -- Status flow:
    --   open       → just raised, assignee hasn't submitted proof yet
    --   submitted  → assignee uploaded proof_url, awaiting approval
    --   approved   → raiser/admin accepted the proof, task closed
    --   rejected   → raiser rejected proof; goes back to 'open' next
    --                time assignee resubmits (reject_reason carries why)
    CREATE TABLE IF NOT EXISTS snags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snag_no TEXT UNIQUE,                       -- SNAG-YYYY-####
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,                            -- snapshot for display
      location TEXT,                             -- e.g. "2nd floor pump room"
      description TEXT NOT NULL,
      photo_url TEXT,                            -- the snag photo (raised)
      priority TEXT DEFAULT 'medium' CHECK(priority IN ('low','medium','high','critical')),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','submitted','approved','rejected')),
      assigned_to INTEGER REFERENCES users(id),
      assigned_to_name TEXT,                     -- snapshot
      raised_by INTEGER REFERENCES users(id),
      raised_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      target_date DATE,
      proof_url TEXT,                            -- assignee's fix photo / PDF
      proof_notes TEXT,                          -- assignee's note on submit
      proof_submitted_at DATETIME,
      proof_submitted_by INTEGER REFERENCES users(id),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      reject_reason TEXT,                        -- why proof was rejected
      rejected_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Rental properties — flats / houses / guest-houses we rent for
    -- staff accommodation (site engineers / supervisors stationed at
    -- project locations). One row per property, agreement-level info.
    CREATE TABLE IF NOT EXISTS rental_properties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      address TEXT,
      city TEXT,
      state TEXT,
      pincode TEXT,
      landlord_name TEXT,
      landlord_phone TEXT,
      landlord_email TEXT,
      monthly_rent REAL DEFAULT 0,
      deposit_paid REAL DEFAULT 0,
      agreement_start_date DATE,
      agreement_end_date DATE,
      bedrooms INTEGER DEFAULT 1,
      total_capacity INTEGER DEFAULT 1,
      amenities TEXT,                       -- comma-sep e.g. 'AC, Wifi, Geyser'
      agreement_file_url TEXT,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','expired','terminated')),
      notes TEXT,
      site_id INTEGER REFERENCES sites(id), -- optional linkage to project site
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Individual rooms within a property (a 3BHK flat has 3 rooms)
    CREATE TABLE IF NOT EXISTS rental_rooms (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES rental_properties(id) ON DELETE CASCADE,
      room_name TEXT NOT NULL,              -- e.g. 'Master Bedroom', 'Room A'
      capacity INTEGER DEFAULT 1,           -- bed count
      status TEXT DEFAULT 'available' CHECK(status IN ('available','occupied','maintenance','reserved')),
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Booking = an occupant stay. Multiple occupants can share a room
    -- (each gets their own row with rent_share splitting the room cost).
    CREATE TABLE IF NOT EXISTS rental_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id INTEGER REFERENCES rental_rooms(id),
      property_id INTEGER REFERENCES rental_properties(id),
      occupant_user_id INTEGER REFERENCES users(id),  -- nullable for non-employees
      occupant_name TEXT,                              -- snapshot
      occupant_phone TEXT,
      check_in_date DATE NOT NULL,
      check_out_date DATE,                             -- planned
      actual_checkout_date DATE,
      site_id INTEGER REFERENCES sites(id),            -- which project site
      rent_share REAL DEFAULT 0,                       -- per-occupant share of rent
      deposit_collected REAL DEFAULT 0,
      status TEXT DEFAULT 'active' CHECK(status IN ('active','completed','cancelled')),
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-month rent requests — site engineer fills in landlord
    -- details + Aadhar + outside photo + bank/UPI + month and submits.
    -- Admin / accountant approves → paid. Designed as a self-contained
    -- payment workflow (separate from the property/booking entity model).
    CREATE TABLE IF NOT EXISTS rent_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_no TEXT UNIQUE,                  -- RR-YYYY-####
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,                          -- snapshot for display
      arrange_for TEXT CHECK(arrange_for IN ('SEPL','Contractor')),
      contractor_name TEXT,                    -- only if Contractor
      owner_name TEXT NOT NULL,
      owner_phone TEXT,
      owner_aadhar_url TEXT,                   -- file upload (image / PDF)
      room_photo_url TEXT,                     -- outside-of-room photo
      photo_taken_at DATETIME,                 -- client-side timestamp
      photo_lat REAL,
      photo_lng REAL,
      payment_mode TEXT DEFAULT 'Bank' CHECK(payment_mode IN ('Bank','UPI','Scanner')),
      bank_account TEXT,
      ifsc_code TEXT,
      upi_id TEXT,                             -- UPI handle e.g. 9876543210@paytm
      scanner_url TEXT,                        -- UPI QR screenshot
      rent_month TEXT NOT NULL,                -- 'YYYY-MM'
      rent_amount REAL DEFAULT 0,
      pay_by_day INTEGER DEFAULT 10,           -- day-of-month rent must be paid by
      inactive INTEGER DEFAULT 0,              -- 1 = rental ended (no future rent expected)
      inactive_at DATETIME,
      inactive_reason TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','approved','paid','rejected')),
      approved_by INTEGER REFERENCES users(id),
      approved_at DATETIME,
      paid_by INTEGER REFERENCES users(id),
      paid_at DATETIME,
      paid_via TEXT,                           -- 'Bank' / 'UPI' / 'Cash'
      transaction_ref TEXT,
      receipt_url TEXT,
      reject_reason TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Monthly rent payments paid to landlord
    CREATE TABLE IF NOT EXISTS rental_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      property_id INTEGER REFERENCES rental_properties(id) ON DELETE CASCADE,
      period_month TEXT NOT NULL,           -- 'YYYY-MM'
      amount_paid REAL DEFAULT 0,
      paid_date DATE,
      paid_via TEXT,                        -- 'Bank' / 'UPI' / 'Cash'
      transaction_ref TEXT,
      receipt_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(property_id, period_month)
    );

    -- Tools master catalog (returnable assets, separate from consumable
    -- stock). Each tool is unique — drill machine, multimeter, ladder,
    -- etc. — and tracked individually with serial / current location.
    CREATE TABLE IF NOT EXISTS tools (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_code TEXT UNIQUE,                  -- e.g. T-2026-0001 auto-generated
      name TEXT NOT NULL,
      category TEXT,                          -- 'Drilling','Cutting','Measurement','Safety','Power','Hand','Other'
      brand TEXT,
      model TEXT,
      serial_no TEXT,
      purchase_date DATE,
      purchase_price REAL DEFAULT 0,
      condition TEXT DEFAULT 'good' CHECK(condition IN ('new','good','fair','poor','scrap')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available','in_use','maintenance','lost','scrapped')),
      current_site_id INTEGER REFERENCES sites(id),
      current_user_id INTEGER REFERENCES users(id),
      last_calibration_date DATE,
      next_calibration_date DATE,
      photo_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Movement log — every issue / return / transfer / maintenance / scrap
    -- captured here so admin can answer 'where did this drill go on Apr 5?'
    CREATE TABLE IF NOT EXISTS tool_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tool_id INTEGER REFERENCES tools(id) ON DELETE CASCADE,
      action TEXT NOT NULL CHECK(action IN ('issue','return','transfer','maintenance','repair','scrap','calibration')),
      from_site_id INTEGER REFERENCES sites(id),
      to_site_id INTEGER REFERENCES sites(id),
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER REFERENCES users(id),
      expected_return_date DATE,
      actual_return_date DATE,
      condition_at_action TEXT,
      notes TEXT,
      photo_url TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Weekly tools list submission per site (Supervisor MIS KPI: "Tools
    -- List submission as per given site name tools should be update").
    -- One row per (site, submitter, week_start) — UNIQUE prevents dupes.
    CREATE TABLE IF NOT EXISTS tools_list_submissions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_id INTEGER REFERENCES sites(id),
      submitted_by INTEGER REFERENCES users(id),
      week_start DATE NOT NULL,
      tools_count INTEGER DEFAULT 0,
      tools_json TEXT,                        -- JSON array of {tool_id, name, qty, condition}
      photo_url TEXT,
      notes TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(site_id, submitted_by, week_start)
    );

    -- Company Assets — IT / office equipment register: laptops, mobile
    -- phones, SIM cards, chargers, monitors, etc. Separate from Tools
    -- (which tracks construction equipment). Mam: "add also system
    -- company assets like laptop, sim, phone etc for maintain record".
    --
    -- Issue / Return / Maintenance / Scrap actions are recorded in
    -- company_asset_movements for full history.
    CREATE TABLE IF NOT EXISTS company_assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_no TEXT UNIQUE,                       -- AST-YYYY-####
      category TEXT,                              -- Laptop / Mobile / SIM / etc
      name TEXT NOT NULL,                         -- e.g. 'Dell Latitude 5420'
      brand TEXT,
      model TEXT,
      serial_no TEXT,                             -- serial / IMEI / SIM number
      mobile_number TEXT,                         -- for SIM cards
      carrier TEXT,                               -- for SIM cards (Jio / Airtel / VI)
      monthly_cost REAL DEFAULT 0,                -- monthly recharge / subscription
      purchase_date DATE,
      purchase_price REAL DEFAULT 0,
      vendor TEXT,
      warranty_till DATE,
      condition TEXT DEFAULT 'good' CHECK(condition IN ('new','good','fair','poor','damaged','scrap')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available','issued','maintenance','lost','scrapped')),
      current_user_id INTEGER REFERENCES users(id),
      current_user_name TEXT,                     -- snapshot for display
      issued_at DATETIME,
      returned_at DATETIME,
      photo_url TEXT,
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- One row per Issue / Return / Maintenance / Scrap event.
    CREATE TABLE IF NOT EXISTS company_asset_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asset_id INTEGER REFERENCES company_assets(id) ON DELETE CASCADE,
      movement_type TEXT CHECK(movement_type IN ('issue','return','maintenance','scrap')),
      from_user_id INTEGER REFERENCES users(id),
      to_user_id INTEGER REFERENCES users(id),
      notes TEXT,
      performed_by INTEGER REFERENCES users(id),
      performed_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Vendor PO ↔ Indent Item link (one PO can cover multiple indent items;
    -- one indent item can split across multiple POs for partial orders).
    CREATE TABLE IF NOT EXISTS vendor_po_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id) ON DELETE CASCADE,
      indent_item_id INTEGER REFERENCES indent_items(id),
      quantity REAL DEFAULT 0,
      rate REAL DEFAULT 0,
      amount REAL DEFAULT 0,
      terms TEXT,                 -- 'Advance' or 'Credit'
      credit_days INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Per-item vendor rates (3-vendor quote per indent line). Up to 3
    -- vendor_N columns keep the sheet-like layout mam asked for. final_rate
    -- + selected_vendor are set once the purchase manager / admin finalizes.
    CREATE TABLE IF NOT EXISTS indent_item_rates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      indent_item_id INTEGER REFERENCES indent_items(id) ON DELETE CASCADE,
      vendor1_name TEXT, vendor1_rate REAL DEFAULT 0, vendor1_terms TEXT, vendor1_credit_days INTEGER DEFAULT 0,
      vendor2_name TEXT, vendor2_rate REAL DEFAULT 0, vendor2_terms TEXT, vendor2_credit_days INTEGER DEFAULT 0,
      vendor3_name TEXT, vendor3_rate REAL DEFAULT 0, vendor3_terms TEXT, vendor3_credit_days INTEGER DEFAULT 0,
      final_rate REAL DEFAULT 0,
      final_vendor_name TEXT,
      final_terms TEXT,
      final_credit_days INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','quoted','finalized','rejected')),
      entered_by INTEGER REFERENCES users(id),
      finalized_by INTEGER REFERENCES users(id),
      finalized_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Delegations — a user assigns a task to another user; assignee uploads
    -- proof; assigner approves or rejects with a reason. Rejected tasks
    -- reappear on the assignee's dashboard with the reason, so they can redo.
    CREATE TABLE IF NOT EXISTS delegations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      assigned_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','submitted','approved','rejected')),
      proof_url TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewer_id INTEGER REFERENCES users(id),
      reject_reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Audit log — records every mutating action (POST / PUT / PATCH /
    -- DELETE) taken against the API. Populated automatically by the
    -- auditMiddleware so admins can answer "who changed what, when?".
    --
    -- before / after are optional JSON snapshots captured by routes that
    -- call the logAuditEvent() helper manually (e.g. when they have the
    -- pre-image of the row). Bulk-auto entries leave those as null.
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at DATETIME DEFAULT CURRENT_TIMESTAMP,
      user_id INTEGER REFERENCES users(id),
      user_name TEXT,
      user_role TEXT,
      action TEXT,                 -- 'CREATE' | 'UPDATE' | 'DELETE' | 'LOGIN' | ... (free-form, default derived from HTTP method)
      entity_type TEXT,            -- e.g. 'purchase_order' | 'complaint' | 'user'
      entity_id TEXT,              -- string so we can handle numeric + natural keys
      entity_label TEXT,           -- human-friendly label (optional)
      method TEXT,                 -- HTTP method
      path TEXT,                   -- request path (without query)
      query TEXT,                  -- JSON-encoded query string
      body_summary TEXT,           -- compact JSON summary of request body (secrets stripped)
      status_code INTEGER,
      ip TEXT,
      user_agent TEXT,
      before_json TEXT,            -- optional pre-image
      after_json TEXT              -- optional post-image
    );
    -- audit_log indexes are created post-migration in safeIndexes (some
    -- prod DBs predate the user_id column and we don't want to crash boot)

    -- Generic singleton key/value bag for app-level state that doesn't
    -- belong on a domain table (emergency reset hash, feature flags, etc).
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- ============================================
    -- INVENTORY MANAGEMENT
    -- ============================================
    -- Multiple physical stores: one Office Store (central) + one Site
    -- Store per active site. type='office' for the main warehouse,
    -- type='site_store' for site-attached stores (site_id NOT NULL).
    CREATE TABLE IF NOT EXISTS warehouses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'office' CHECK(type IN ('office','site_store')),
      site_id INTEGER REFERENCES sites(id),
      location TEXT,
      in_charge TEXT,
      active INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Live stock = quantity on hand per (item, warehouse) with running
    -- average rate so we can value the stock without a separate ledger.
    -- UNIQUE keeps it idempotent — INSERT OR conflict path updates qty.
    CREATE TABLE IF NOT EXISTS stock_balance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      item_master_id INTEGER NOT NULL REFERENCES item_master(id),
      quantity REAL NOT NULL DEFAULT 0,
      avg_rate REAL DEFAULT 0,
      reorder_level REAL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(warehouse_id, item_master_id)
    );
    -- Append-only journal of every stock change. type IN/OUT/TRANSFER/ADJUST.
    -- For TRANSFER we write TWO rows — one OUT from from_warehouse_id and one
    -- IN to to_warehouse_id, paired by the same reference_id so the UI can
    -- show them as a single movement.
    CREATE TABLE IF NOT EXISTS stock_movements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      warehouse_id INTEGER NOT NULL REFERENCES warehouses(id),
      item_master_id INTEGER NOT NULL REFERENCES item_master(id),
      type TEXT NOT NULL CHECK(type IN ('IN','OUT')),
      quantity REAL NOT NULL,
      rate REAL DEFAULT 0,
      total_value REAL DEFAULT 0,
      reference_type TEXT,        -- e.g. 'GRN','OPENING','TRANSFER','ISSUE','ADJUST','PURCHASE'
      reference_id TEXT,          -- pairs the two halves of a TRANSFER + links to GRN/Indent rows
      from_warehouse_id INTEGER REFERENCES warehouses(id),  -- only set on OUT side of a TRANSFER
      to_warehouse_id INTEGER REFERENCES warehouses(id),    -- only set on IN side of a TRANSFER
      site_id INTEGER REFERENCES sites(id),                 -- for site-issue movements
      notes TEXT,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- stock_movements indexes are created post-migration in safeIndexes

    -- ─── PERFORMANCE INDEXES on hot tables (fast page loads) ────────────
    -- These were originally inline here, but some prod DBs were created
    -- before certain columns existed (e.g. audit_log.user_id, vendor_pos
    -- .cancelled, support_tickets.assigned_to). When the rigid db.exec()
    -- block hit a CREATE INDEX on a missing column, SQLite aborted the
    -- whole exec → server crashed at boot. They now live in safeIndexes
    -- below, run AFTER migrations, each guarded by its own try/catch.

    -- SQLite query planner optimizations
    -- WAL mode = better concurrency under load (multiple reads while one
    -- write is happening). NORMAL sync = faster, still crash-safe.

    -- Announcements — admin posts, everyone reads. Pinned items rise to the top.
    -- expires_at is optional; rows without it stay visible forever until deleted.
    CREATE TABLE IF NOT EXISTS announcements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      body TEXT,
      pinned INTEGER DEFAULT 0,
      expires_at DATETIME,
      created_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_announcements_created ON announcements(created_at DESC);

    -- Tracks each user's last visit to the announcements panel so the bell
    -- icon can show a "new" count of announcements posted since.
    CREATE TABLE IF NOT EXISTS announcement_reads (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      last_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Price Required — site engineer raises a "we need price for this item"
    -- request when an item isn't yet in the catalog. Purchase team gathers 3
    -- vendor quotes, picks a final rate, and the system auto-promotes the
    -- finalized item into item_master so it can be used in future indents.
    --
    -- Identical requests from multiple sites (same name+size+spec+make+uom+type)
    -- merge in the UI so the purchase team only fills rates once.
    CREATE TABLE IF NOT EXISTS price_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_name TEXT,
      item_name TEXT NOT NULL,
      size TEXT,
      specification TEXT,
      make TEXT,
      uom TEXT DEFAULT 'PCS',
      item_type TEXT DEFAULT 'PO' CHECK(item_type IN ('PO','FOC','RGP')),
      notes TEXT,
      raised_by INTEGER REFERENCES users(id),
      status TEXT DEFAULT 'open' CHECK(status IN ('open','quoted','finalized','added')),
      -- 3 vendor quotes
      vendor1_name TEXT, vendor1_rate REAL, vendor1_terms TEXT,
      vendor2_name TEXT, vendor2_rate REAL, vendor2_terms TEXT,
      vendor3_name TEXT, vendor3_rate REAL, vendor3_terms TEXT,
      -- Final pick
      final_vendor_name TEXT,
      final_rate REAL,
      final_terms TEXT,
      finalized_by INTEGER REFERENCES users(id),
      finalized_at DATETIME,
      -- Set after the system promotes this to the catalog
      item_master_id INTEGER REFERENCES item_master(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_price_requests_status ON price_requests(status, created_at DESC);

    -- PMS Tasks — Project Management tasks created by CRM against a specific
    -- Business Book project. Same lifecycle as delegations (pending → submitted
    -- → approved/rejected) but each task is tied to a BB project_id so the
    -- project name + auto-captured CRM name stay authoritative. project_id is
    -- a soft reference to business_book.id so we can show project details even
    -- if the BB row is later edited.
    CREATE TABLE IF NOT EXISTS pms_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      project_id INTEGER REFERENCES business_book(id),
      project_name_snapshot TEXT,   -- captured at create time for history
      crm_name TEXT,                -- captured from the latest Client PO at create time
      assigned_by INTEGER REFERENCES users(id),
      assigned_to INTEGER REFERENCES users(id),
      due_date DATE,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending','submitted','approved','rejected')),
      proof_url TEXT,
      submitted_at DATETIME,
      reviewed_at DATETIME,
      reviewer_id INTEGER REFERENCES users(id),
      reject_reason TEXT,
      -- Date-extension request fields (same pattern as delegations)
      requested_due_date DATE,
      extension_reason TEXT,
      extension_status TEXT,
      extension_reviewed_at DATETIME,
      extension_reviewed_by INTEGER REFERENCES users(id),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Checklist completions — one row per (checklist, user, date). Used to
    -- show the daily checklist widget on dashboard and track whether the user
    -- uploaded proof today. Unique per-day so users can't double-complete.
    CREATE TABLE IF NOT EXISTS checklist_completions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      checklist_id INTEGER REFERENCES checklists(id),
      user_id INTEGER REFERENCES users(id),
      completion_date DATE NOT NULL,
      proof_url TEXT,
      notes TEXT,
      submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(checklist_id, user_id, completion_date)
    );
  `);

  // Safe schema migrations for columns added after initial release
  const migrations = [
    // Payroll grace + per-minute late penalty (added when mam moved from a
    // simple "late mark" model to a graduated penalty: 3 free late marks per
    // month, then ₹20/min off the salary for any further late punch).
    // Fixed weekly target per KPI (mam's "this plan is fix" — Monika's
    // ROI=1, Automations=4, etc.). Used as the Planned default when no
    // weekly entry exists.
    ['score_kpis', 'default_planned REAL DEFAULT 0'],
    // Supervisor → site linkage so Supervisor template KPIs (DPR Daily
    // Actual, Stock report, Tools List, Material Receiving) can scope
    // by site. The TEXT 'supervisor' column was insufficient for joins.
    ['sites', 'supervisor_id INTEGER REFERENCES users(id)'],
    // Rent request: due-by day of month (mam: 'date also mention like
    // 10 date of month need to submit'). Defaults to 10. Once past
    // (rent_month-01 + pay_by_day) and still pending/approved, the row
    // shows an Overdue badge. 'inactive' marks the rental as vacated
    // so it stops appearing in payment expectations.
    ['rent_requests', 'pay_by_day INTEGER DEFAULT 10'],
    ['rent_requests', 'inactive INTEGER DEFAULT 0'],
    ['rent_requests', 'inactive_at DATETIME'],
    ['rent_requests', 'inactive_reason TEXT'],
    // Payment-mode selector — Bank / UPI / Scanner. Form shows only
    // the matching fields (mam: 'if scanner upload scanner, if bank
    // then bank details, if upi fill upi').
    ['rent_requests', `payment_mode TEXT DEFAULT 'Bank'`],
    ['rent_requests', 'upi_id TEXT'],
    // Employee the rent is being arranged for (room occupant). Snapshot
    // the name so it survives if the user is later deactivated/renamed.
    ['rent_requests', 'employee_user_id INTEGER REFERENCES users(id)'],
    ['rent_requests', 'employee_name TEXT'],
    ['payroll_settings', 'late_grace_count INTEGER DEFAULT 3'],
    ['payroll_settings', 'late_per_minute_rate REAL DEFAULT 20'],
    // Salary breakdown percentages — match SEPL Tally slip format
    ['payroll_settings', 'basic_pct REAL DEFAULT 56.5'],
    ['payroll_settings', 'conveyance_pct REAL DEFAULT 22.6'],
    ['payroll_settings', 'hra_pct REAL DEFAULT 5.9'],
    ['payroll_settings', 'adhoc_pct REAL DEFAULT 15.0'],
    ['payroll_settings', 'misc_pct REAL DEFAULT 0'],
    // Snapshot fields for finalised runs so historical slips don't drift
    ['payroll_runs', 'late_penalty REAL DEFAULT 0'],
    ['payroll_runs', 'basic_pay REAL DEFAULT 0'],
    ['payroll_runs', 'conveyance REAL DEFAULT 0'],
    ['payroll_runs', 'hra REAL DEFAULT 0'],
    ['payroll_runs', 'adhoc REAL DEFAULT 0'],
    ['payroll_runs', 'misc REAL DEFAULT 0'],
    ['purchase_orders', 'site_engineer_id INTEGER REFERENCES users(id)'],
    ['purchase_orders', 'site_engineer_ids TEXT'],
    ['purchase_orders', 'crm_name TEXT'],
    ['purchase_orders', 'boq_file_link TEXT'],
    ['attendance', 'auto_punched_in INTEGER DEFAULT 0'],
    ['attendance', 'auto_punched_out INTEGER DEFAULT 0'],
    // Admin override: mam can mark a user present even if they didn't
    // punch (typically for site engineers whose phone died or had no
    // network). The flag hides the row from the user's own My Today /
    // My Month views so they don't see they were marked — only payroll
    // / admin / HR reports include it. marked_by stores who did it for
    // audit; remarks stores the reason mam typed.
    ['attendance', 'admin_marked INTEGER DEFAULT 0'],
    ['attendance', 'marked_by INTEGER REFERENCES users(id)'],
    // Auto-mark-present allow-list. Users with this flag set get an
    // admin_marked='present' row created automatically every day so
    // they don't show up in the 'Not Punched In Today' panel. Mam's
    // initial seed: management / admin accounts that don't punch.
    ['users', 'auto_mark_present INTEGER DEFAULT 0'],
    ['users', 'username TEXT'],
    // Inventory link on GRN — when goods are received we now auto-IN
    // them into a chosen warehouse. Both columns are nullable so old
    // GRNs without the link still work; only filled-in ones trigger
    // the stock movement.
    ['grn', 'warehouse_id INTEGER REFERENCES warehouses(id)'],
    ['grn_items', 'item_master_id INTEGER REFERENCES item_master(id)'],
    // Same auto-IN hook on the modern Procurement → Dispatch & Receiving
    // flow: when mam marks a delivery_note as Received, items from the
    // linked vendor_po_items auto-land in this warehouse. nullable —
    // existing receives without a warehouse just behave like before.
    ['delivery_notes', 'warehouse_id INTEGER REFERENCES warehouses(id)'],
    // Optional photo per stock movement — useful for opening-balance
    // entries at site stores so mam has visual proof of what's actually
    // there. Photo is never required; rendered as a thumbnail in the
    // movements list when set.
    ['stock_movements', 'photo_url TEXT'],
    // Item condition at the time of this movement — captured for
    // opening-balance entries so mam can tell brand-new stock apart from
    // already-used / scrap material on the same item line. NULL for older
    // rows + non-OPENING movements; UI dropdown is Used / Unused / Scrap.
    ['stock_movements', 'item_condition TEXT'],
    // Per-user opt-out from live location tracking. Admin / office-only
    // staff get track_location=0 so they don't show in Admin → Location
    // Tracking. Default 1 so existing field staff keep being tracked.
    ['users', 'track_location INTEGER DEFAULT 1'],
    // Collection Engine v2 — receivable now keyed by SITE (not free-text
    // client+project), CRM auto-fills from the latest PO of that site,
    // and Aanchal logs next-planned-date + last-discussion alongside.
    ['receivables', 'site_id INTEGER REFERENCES sites(id)'],
    ['receivables', 'site_name TEXT'],
    ['receivables', 'crm_name TEXT'],
    // Hiring Pipeline — extends candidates with interview / MD / offer tracking.
    // Status field on candidates already supports the high-level stages
    // (lead → interview_scheduled → interview_done → qualified → offer_sent →
    // accepted → onboarded → rejected). These additive columns capture the
    // detail at each stage so HR can see who's interviewing, when, and what
    // each interviewer's decision was. All nullable — old candidates stay
    // untouched.
    ['candidates', 'interviewer_id INTEGER REFERENCES employees(id)'],
    ['candidates', 'interview_date DATETIME'],
    ['candidates', 'interview_notes TEXT'],
    ['candidates', 'interview_decision TEXT'],     // 'shortlisted' | 'rejected' | 'on_hold'
    ['candidates', 'md_interview_date DATETIME'],
    ['candidates', 'md_interview_notes TEXT'],
    ['candidates', 'md_decision TEXT'],            // 'shortlisted' | 'rejected'
    ['candidates', 'offer_letter_file TEXT'],
    ['candidates', 'offer_sent_at DATETIME'],
    // price_requests carries the item's department (CIVIL / ELE / FF / etc.)
    // so the auto-promoted item_master row lands in the right department too.
    ['price_requests', 'department TEXT'],
    // leave_requests gained these columns over time but the migrations were
    // never registered — older production DBs (created when leave_requests
    // had only the basic from/to/reason set) were missing them, blocking
    // submission with "table leave_requests has no column named hours".
    ['leave_requests', 'hours REAL DEFAULT 0'],
    ['leave_requests', 'days INTEGER DEFAULT 1'],
    ['leave_requests', 'from_time TEXT'],
    ['leave_requests', 'to_time TEXT'],
    ['leave_requests', 'remarks TEXT'],
    // Soft-cancel for Vendor POs — hard delete is blocked by FK constraints
    // (purchase_bills + delivery_notes reference vendor_pos). Cancelling
    // hides the PO from active follow-up lists while preserving the audit
    // trail and any linked financial records.
    ['vendor_pos', 'cancelled INTEGER DEFAULT 0'],
    ['vendor_pos', 'cancelled_at DATETIME'],
    ['vendor_pos', 'cancelled_by INTEGER REFERENCES users(id)'],
    ['vendor_pos', 'cancel_reason TEXT'],
    // Mandatory employee documents — Aadhar / PAN / highest qualification
    // certificate. URLs (pointing at /uploads/<file>) so we can render them
    // as links and download / view directly. NOT NULL is intentionally
    // omitted at the DB level so legacy rows don't break — frontend
    // enforces required-on-create for new records.
    ['employees', 'aadhar_file TEXT'],
    ['employees', 'pan_file TEXT'],
    ['employees', 'qualification_file TEXT'],
    // can_see_all on role_permissions: explicit per-role-per-module toggle
    // for "scope = ALL records" vs "scope = OWN only". Decoupled from
    // can_approve so admin can grant a role full visibility without giving
    // them approval power (e.g. an auditor role). When can_see_all = 1 OR
    // can_approve = 1, the user sees every record in that module.
    ['role_permissions', 'can_see_all INTEGER DEFAULT 0'],
    // Announcements module — admin posts; everyone reads. Each user's
    // last-seen timestamp is tracked separately so the bell-icon counter
    // can show a "new" badge until they open the panel. Two tables created
    // unconditionally below via CREATE TABLE IF NOT EXISTS — no migration
    // entries needed for those.
    ['receivables', 'next_planned_date DATE'],
    ['receivables', 'last_discussion TEXT'],
    ['receivables', 'business_book_id INTEGER REFERENCES business_book(id)'],
    // DPR consumption now optionally links to the item_master so the
    // auto-OUT to inventory can decrement the right SKU's stock.
    ['dpr_material', 'item_master_id INTEGER REFERENCES item_master(id)'],
    // Self-service password recovery — user sets a personal recovery code
    // (stored as bcrypt hash) which they can later use along with their
    // username to reset their password from the login page. No SMTP needed.
    ['users', 'recovery_code_hash TEXT'],
    // Delegations — due-date extension request (assignee asks admin for more time)
    ['delegations', 'requested_due_date DATE'],
    ['delegations', 'extension_reason TEXT'],
    ['delegations', "extension_status TEXT"],
    ['delegations', 'extension_reviewed_at DATETIME'],
    ['delegations', 'extension_reviewed_by INTEGER REFERENCES users(id)'],
    // Time-of-day for recurring checklists (daily/weekly/…). Stored as 'HH:MM'.
    ['checklists', 'due_time TEXT'],
    // scoring.js / checklists routes query `WHERE ... COALESCE(active, 1) = 1`.
    // SQLite needs the column to physically exist or the query fails before
    // COALESCE runs — surfaces as 'no such column: active' on weekly score.
    ['checklists', 'active INTEGER DEFAULT 1'],
    // Category-specific asset identifiers — IP for laptops/routers/etc.,
    // IMEI for mobile/tablet (separate from generic serial_no).
    ['company_assets', 'ip_address TEXT'],
    ['company_assets', 'imei TEXT'],

    // ─── Sales Funnel — Stage 1: Lead / Tender Capture (mam's spec) ──
    // Distinguish Private quotes from Government tenders so the form
    // shows the correct fields and the audit / SLA rules differ.
    ['sales_funnel', "lead_kind TEXT DEFAULT 'private'"], // 'private' | 'government'
    // Customer GST / PAN — may be auto-fetched from MCA later.
    ['sales_funnel', 'gst_number TEXT'],
    ['sales_funnel', 'pan_number TEXT'],
    // Project header (separate from address — project_name is what mam
    // displays on the BOQ / quote / contract).
    ['sales_funnel', 'project_name TEXT'],
    ['sales_funnel', 'project_location TEXT'],
    ['sales_funnel', 'pin_code TEXT'],
    // Commercial header
    ['sales_funnel', 'estimated_value REAL DEFAULT 0'],
    ['sales_funnel', 'tentative_timeline TEXT'],
    // Sub-trades scope as CSV: M,E,P,F,BMS,ELV,Solar
    ['sales_funnel', 'sub_trades_scope TEXT'],
    // Government-only fields
    ['sales_funnel', 'tender_id TEXT'],
    ['sales_funnel', 'bid_deadline DATE'],
    ['sales_funnel', 'emd_amount REAL DEFAULT 0'],
    ['sales_funnel', 'pbg_required INTEGER DEFAULT 0'],
    // Drop tracking — mam's universal principle: 'Drop with reason'
    ['sales_funnel', 'dropped INTEGER DEFAULT 0'],
    ['sales_funnel', 'drop_reason TEXT'],
    ['sales_funnel', 'dropped_at DATETIME'],
    ['sales_funnel', 'dropped_by INTEGER REFERENCES users(id)'],
    // When a DPR shows a LOSS (Total B > Total A), mam wants the
    // hindrance category captured so we can analyse root causes
    // across sites. Required field at submit-time only when there's
    // a loss; optional otherwise.
    // Categories: Money / Machine / Material / Manpower / Site Clearance.
    ['dpr', 'hindrance_category TEXT'],
    // Per-entry working sheet upload on Business Book — mam: 'upload here
    // file option call working sheet'. Stores the URL of the uploaded
    // file (Excel / PDF / etc) so admin can attach the costing /
    // calculation sheet to each booked order.
    ['business_book', 'working_sheet_link TEXT'],
    // Indent items now pick from item_master; keeps backward-compat description too
    ['indent_items', 'item_master_id INTEGER REFERENCES item_master(id)'],
    ['indent_items', 'make TEXT'],                 // e.g. "Schneider", "L&T"
    ['indent_items', 'is_foc INTEGER DEFAULT 0'],  // free-of-cost flag
    ['indent_items', 'is_tool INTEGER DEFAULT 0'], // tools vs materials flag
    // Indent-level fields shown on the physical indent form
    ['indents', 'client_name TEXT'],   // kept for backward compat (superseded by site_name)
    ['indents', 'location TEXT'],      // kept for backward compat (now derived from site)
    ['indents', 'lead_no TEXT'],       // kept for backward compat (removed from UI)
    ['indents', 'site_name TEXT'],     // unique site name from Business Book
    ['indents', 'raised_by_name TEXT'],// employee who raised the indent
    // Item classification mirrored from item_master.type (PO / FOC / RGP)
    ['indent_items', 'item_type TEXT'],
    // Links this indent line back to the site BOQ row it was picked from
    ['indent_items', 'po_item_id INTEGER REFERENCES po_items(id)'],
    // Vendor POs are now uploaded from Tally rather than built inside the ERP.
    // po_date  — from the Tally PO (not the ERP creation timestamp)
    // file_path — relative URL under /uploads to the uploaded PO file (PDF/image/xlsx)
    // remarks   — free-text note from the uploader
    // expected_receipt_date — date by which goods are expected from the vendor;
    //   used by mam to chase follow-ups and trigger the purchase-bill upload.
    ['vendor_pos', 'po_date DATE'],
    ['vendor_pos', 'file_path TEXT'],
    ['vendor_pos', 'remarks TEXT'],
    ['vendor_pos', 'expected_receipt_date DATE'],
    // Purchase Bills also get an uploaded file (the bill PDF / image / excel)
    ['purchase_bills', 'file_path TEXT'],
    // Dispatch (delivery_notes) — upgraded from a simple "delivery record" to
    // either a Sales Bill (PO items we sell to client) or a Delivery Challan
    // (FOC / RGP items). document_type + document_number distinguish them,
    // file_path stores the scan/PDF, and received_by_name + received_at
    // capture who actually received the material on the site.
    ['delivery_notes', 'document_type TEXT'],           // 'sales_bill' | 'challan'
    ['delivery_notes', 'document_number TEXT'],         // sales-bill / challan number
    ['delivery_notes', 'file_path TEXT'],
    ['delivery_notes', 'received_by_name TEXT'],        // free text (site engineer / customer rep)
    ['delivery_notes', 'received_at DATETIME'],
    // Proof of receipt (stamped + signed photo of the sales bill / challan)
    // — critical for mam because without this the client sometimes denies
    // receiving material and SEPL takes the loss.
    ['delivery_notes', 'receipt_file_path TEXT'],
    // Support tickets — who is the ticket assigned to? When set, that user
    // sees the ticket on their dashboard and can respond / work on it.
    ['support_tickets', 'assigned_to INTEGER REFERENCES users(id)'],
    // --- Sales Funnel phase-A columns (mam's spec 2026-04-23) ---
    ['sales_funnel', 'first_call_status TEXT'],          // 'interested' | 'not_interested'
    ['sales_funnel', 'first_call_at DATETIME'],          // when the first call was made
    ['sales_funnel', 'first_call_remarks TEXT'],
    ['sales_funnel', 'meeting_recording_url TEXT'],      // phone / VC recording
    ['sales_funnel', 'meeting_location_lat REAL'],       // live location at meeting
    ['sales_funnel', 'meeting_location_lng REAL'],
    ['sales_funnel', 'f2f_status TEXT'],                 // 'done' | 'no_show' | 'rescheduled'
    ['sales_funnel', 'f2f_date DATETIME'],
    ['sales_funnel', 'revised_boq_file_link TEXT'],
    ['sales_funnel', 'lead_type TEXT'],                  // customer/lead type
    ['sales_funnel', 'city TEXT'],                       // separate from district
    // SLA tracking — stamp the timestamp when the lead entered its current
    // stage, so overdue detection knows the clock start. SLAs are:
    //   new_lead -> qualified: 1 hour
    //   qualified -> meeting_assigned: 4 hours
    //   meeting_assigned -> f2f: variable (T-X)
    //   f2f -> mom: 1 day
    //   mom -> quotation: variable (T-X)
    //   quotation -> won/lost: 60 days
    ['sales_funnel', 'stage_entered_at DATETIME'],
    // --- MOM form fields (mam's spec 2026-04-23) — a richer MOM capture:
    //   Customer Category / Type → already on the lead (category, lead_type)
    //   M.O.M. (notes)           → already on the lead (mom_notes)
    //   Meeting Location         → already on the lead
    // Below adds the remaining fields:
    ['sales_funnel', 'meeting_purpose TEXT'],               // Purpose Of Meeting
    ['sales_funnel', 'meeting_timestamp_photo_url TEXT'],   // Timestamp Photo (with GPS overlay)
    ['sales_funnel', 'pain_points TEXT'],                   // Pain Points
    ['sales_funnel', 'requirements TEXT'],                  // Requirements
    ['sales_funnel', 'action_planned TEXT'],                // Action Planned (next step)
    ['sales_funnel', 'meeting_format TEXT'],                // Phone / VC / In-Person
    ['sales_funnel', 'meeting_scheduled_by TEXT'],          // who scheduled the meeting
    ['sales_funnel', 'meeting_time_spent_min INTEGER'],     // minutes spent in the meeting
    // user_id of the employee the meeting is assigned to. Stored alongside
    // meeting_assigned_to (TEXT name) so the assigned employee's dashboard
    // can filter "My Planned Meetings" by user_id without name-matching.
    // Mam: 'so that assigned meeting user show their Meeting planned and
    // he will fill mom after on schedule day visit'.
    ['sales_funnel', 'meeting_assigned_to_id INTEGER REFERENCES users(id)'],
    // Complaints — mam's Google Form (2026-04-23) adds State and Remarks.
    // Complaint Type = Paid / Free (changed from Urgent/Normal/Low)
    // Customer Type = Old Site / Running Site (changed from New/Existing)
    ['complaints', 'state TEXT'],
    ['complaints', 'remarks TEXT'],
    // Delegations — optional project tag the admin can set while creating a
    // task or edit later from the list. Free-text so it doesn't depend on
    // any master list; keeps it flexible for mam's quick day-to-day tasks.
    ['delegations', 'project_name TEXT'],
    // Optional attachment (brief / drawing / photo / doc) the creator can
    // attach when assigning the task. Stored as a /uploads/<name> URL.
    ['delegations', 'attachment_url TEXT'],
  ];
  // Unique index on username — allows NULLs for legacy rows while enforcing uniqueness on set values
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL'); } catch (e) {}

  // Relax payment_requests.category CHECK to allow new categories like
  // 'Salary' and 'Compliance'. SQLite can't ALTER a CHECK constraint, so we
  // detect the old 4-category signature in sqlite_master and rebuild the
  // table via a data-preserving copy. Runs exactly once — the new CREATE
  // TABLE IF NOT EXISTS won't re-create if a relaxed version already exists.

  // Same rebuild pattern for support_tickets — the original CHECK on
  // category only allowed 'bug','feature_request','how_to','data_issue',
  // 'other'. Mam expanded the list to include access_issue, manpower,
  // material, payment. Strip the CHECK altogether (app layer validates
  // via the CATEGORIES list in HelpTickets.jsx) so future additions
  // don't need a migration.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='support_tickets'").get();
    if (row && /CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i.test(row.sql)
            && !/manpower/i.test(row.sql)) {
      db.exec('BEGIN');
      const newSql = row.sql
        .replace(/CREATE TABLE\s+support_tickets/i, 'CREATE TABLE support_tickets_new')
        .replace(/,?\s*CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i, '');
      db.exec(newSql);
      // Copy by column list so any future renames don't break this.
      const cols = db.prepare("PRAGMA table_info(support_tickets)").all().map(c => c.name).join(',');
      db.exec(`INSERT INTO support_tickets_new (${cols}) SELECT ${cols} FROM support_tickets`);
      db.exec('DROP TABLE support_tickets');
      db.exec('ALTER TABLE support_tickets_new RENAME TO support_tickets');
      db.exec('COMMIT');
      console.log('[migration] support_tickets rebuilt — category CHECK relaxed (manpower/material/payment now allowed)');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
  }

  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payment_requests'").get();
    if (row && /CHECK\s*\(\s*category\s+IN\s*\(\s*'TA\/DA'\s*,\s*'Purchase'\s*,\s*'Labour'\s*,\s*'Transport'\s*\)\s*\)/.test(row.sql)) {
      db.exec('BEGIN');
      // Build new table with no CHECK on category — app layer already validates via WORKFLOW
      const newSql = row.sql
        .replace(/CREATE TABLE\s+payment_requests/i, 'CREATE TABLE payment_requests_new')
        .replace(/CHECK\s*\(\s*category\s+IN\s*\([^)]*\)\s*\)/i, '');
      db.exec(newSql);
      db.exec('INSERT INTO payment_requests_new SELECT * FROM payment_requests');
      db.exec('DROP TABLE payment_requests');
      db.exec('ALTER TABLE payment_requests_new RENAME TO payment_requests');
      db.exec('COMMIT');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
  }

  // Relax attendance.status CHECK to allow 'short_day' (4-8 hours worked).
  // The punch-out code sets status='short_day' but the original CHECK
  // constraint omitted it, so existing DBs hit "CHECK constraint failed"
  // when an employee punched out with less than 8 hours. Same rebuild
  // pattern as payment_requests above; runs exactly once.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attendance'").get();
    if (row && !/short_day/.test(row.sql)) {
      db.exec('BEGIN');
      const newSql = row.sql
        .replace(/CREATE TABLE\s+attendance/i, 'CREATE TABLE attendance_new')
        .replace(/CHECK\s*\(\s*status\s+IN\s*\([^)]*\)\s*\)/i,
                 "CHECK(status IN ('present','half_day','short_day','absent','late','leave','holiday'))");
      db.exec(newSql);
      db.exec('INSERT INTO attendance_new SELECT * FROM attendance');
      db.exec('DROP TABLE attendance');
      db.exec('ALTER TABLE attendance_new RENAME TO attendance');
      db.exec('COMMIT');
      console.log('[migration] attendance.status CHECK relaxed to allow short_day');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[migration] attendance CHECK relax failed:', e.message);
  }

  // Relax leave_requests.leave_type CHECK to include 'short_leave'.
  // The Apply for Leave form on mobile sends leave_type='short_leave' for
  // hour-based leave requests, but the original CHECK constraint listed
  // only ('casual','sick','earned','half_day','comp_off') — so existing
  // production DBs threw "CHECK constraint failed" when users tried to
  // submit a short leave. Same table-rebuild pattern as attendance above.
  try {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='leave_requests'").get();
    if (row && !/short_leave/.test(row.sql)) {
      db.exec('BEGIN');
      const newSql = row.sql
        .replace(/CREATE TABLE\s+leave_requests/i, 'CREATE TABLE leave_requests_new')
        .replace(/CHECK\s*\(\s*leave_type\s+IN\s*\([^)]*\)\s*\)/i,
                 "CHECK(leave_type IN ('casual','sick','earned','half_day','short_leave','comp_off'))");
      db.exec(newSql);
      // Copy ONLY the columns that exist in the OLD table to be safe.
      const oldCols = db.prepare("PRAGMA table_info(leave_requests)").all().map(c => c.name);
      const newCols = db.prepare("PRAGMA table_info(leave_requests_new)").all().map(c => c.name);
      const shared = oldCols.filter(c => newCols.includes(c)).join(', ');
      db.exec(`INSERT INTO leave_requests_new (${shared}) SELECT ${shared} FROM leave_requests`);
      db.exec('DROP TABLE leave_requests');
      db.exec('ALTER TABLE leave_requests_new RENAME TO leave_requests');
      db.exec('COMMIT');
      console.log('[migration] leave_requests.leave_type CHECK relaxed to allow short_leave');
    }
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (e2) {}
    console.error('[migration] leave_requests CHECK relax failed:', e.message);
  }

  for (const [table, col] of migrations) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) {}
  }

  // ─── PERFORMANCE INDEXES on hot tables (fast page loads) ───────────
  // Runs AFTER migrations so columns added by ALTER TABLE above are
  // already present. Each index is guarded individually — if a column
  // is still missing on a particular DB (e.g. a very old prod that
  // hasn't been touched in a while), the index simply skips and the
  // server boots normally instead of crash-looping.
  // Mam: 'why it take time to reload data, how to fast it'.
  const safeIndexes = [
    // Audit log
    'CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log(at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_user ON audit_log(user_id, at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id)',
    'CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_log(action)',
    // Warehouses + stock
    'CREATE INDEX IF NOT EXISTS idx_warehouses_site ON warehouses(site_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_warehouse ON stock_balance(warehouse_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_item ON stock_balance(item_master_id)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_warehouse ON stock_movements(warehouse_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_item ON stock_movements(item_master_id, created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_stock_mvmt_ref ON stock_movements(reference_type, reference_id)',
    // Attendance — date filters, per-user month view, late stats
    'CREATE INDEX IF NOT EXISTS idx_att_user_date ON attendance(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date)',
    'CREATE INDEX IF NOT EXISTS idx_att_status ON attendance(status)',
    // Location tracking
    'CREATE INDEX IF NOT EXISTS idx_loc_user_date ON location_tracking(user_id, date)',
    'CREATE INDEX IF NOT EXISTS idx_loc_time ON location_tracking(time DESC)',
    // Leave requests
    'CREATE INDEX IF NOT EXISTS idx_leave_user ON leave_requests(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_leave_status ON leave_requests(status)',
    // Payment requests
    'CREATE INDEX IF NOT EXISTS idx_pr_status ON payment_requests(status)',
    'CREATE INDEX IF NOT EXISTS idx_pr_category ON payment_requests(category)',
    'CREATE INDEX IF NOT EXISTS idx_pr_site ON payment_requests(site_id)',
    'CREATE INDEX IF NOT EXISTS idx_pr_creator ON payment_requests(created_by)',
    // Business book
    'CREATE INDEX IF NOT EXISTS idx_bb_company ON business_book(company_name)',
    'CREATE INDEX IF NOT EXISTS idx_bb_employee ON business_book(employee_assigned)',
    'CREATE INDEX IF NOT EXISTS idx_bb_status ON business_book(status)',
    // Sites
    'CREATE INDEX IF NOT EXISTS idx_sites_name ON sites(name)',
    'CREATE INDEX IF NOT EXISTS idx_sites_bb ON sites(business_book_id)',
    // Indents
    'CREATE INDEX IF NOT EXISTS idx_indents_status ON indents(status)',
    'CREATE INDEX IF NOT EXISTS idx_indents_site ON indents(site_name)',
    'CREATE INDEX IF NOT EXISTS idx_indents_created ON indents(created_at DESC)',
    'CREATE INDEX IF NOT EXISTS idx_indent_items_indent ON indent_items(indent_id)',
    // Vendor POs
    'CREATE INDEX IF NOT EXISTS idx_vpo_indent ON vendor_pos(indent_id)',
    'CREATE INDEX IF NOT EXISTS idx_vpo_vendor ON vendor_pos(vendor_id)',
    'CREATE INDEX IF NOT EXISTS idx_vpo_cancelled ON vendor_pos(cancelled)',
    // DPR
    'CREATE INDEX IF NOT EXISTS idx_dpr_site_date ON dpr(site_id, report_date)',
    'CREATE INDEX IF NOT EXISTS idx_dpr_date ON dpr(report_date)',
    'CREATE INDEX IF NOT EXISTS idx_dpr_approval ON dpr(approval_status)',
    // Delegations
    'CREATE INDEX IF NOT EXISTS idx_del_assignee ON delegations(assigned_to, status)',
    'CREATE INDEX IF NOT EXISTS idx_del_user ON delegations(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_del_status ON delegations(status)',
    // Support / help tickets
    'CREATE INDEX IF NOT EXISTS idx_tk_user ON support_tickets(user_id, status)',
    'CREATE INDEX IF NOT EXISTS idx_tk_assignee ON support_tickets(assigned_to, status)',
    'CREATE INDEX IF NOT EXISTS idx_tk_status ON support_tickets(status)',
    // Snags + Company assets
    'CREATE INDEX IF NOT EXISTS idx_snags_status ON snags(status)',
    'CREATE INDEX IF NOT EXISTS idx_snags_assignee ON snags(assigned_to)',
    'CREATE INDEX IF NOT EXISTS idx_snags_raiser ON snags(raised_by)',
    'CREATE INDEX IF NOT EXISTS idx_assets_status ON company_assets(status)',
    'CREATE INDEX IF NOT EXISTS idx_assets_user ON company_assets(current_user_id)',
    'CREATE INDEX IF NOT EXISTS idx_assets_category ON company_assets(category)',
    // Cash flow
    'CREATE INDEX IF NOT EXISTS idx_cf_date ON cash_flow_entries(date)',
    'CREATE INDEX IF NOT EXISTS idx_cf_party ON cash_flow_entries(party_name)',
    // Receivables
    'CREATE INDEX IF NOT EXISTS idx_recv_status ON receivables(status)',
    'CREATE INDEX IF NOT EXISTS idx_recv_client ON receivables(client_name)',
    // Complaints
    'CREATE INDEX IF NOT EXISTS idx_cmp_status ON complaints(status)',
    'CREATE INDEX IF NOT EXISTS idx_cmp_category ON complaints(category)',
  ];
  for (const sql of safeIndexes) {
    try { db.exec(sql); } catch (e) { /* column missing on a stale DB — non-fatal */ }
  }

  // Re-classify attendance rows so status reflects the CURRENT cutoff
  // (payroll_settings.late_after_time, IST). Idempotent and bidirectional:
  // - Rows past the cutoff become 'late'
  // - Rows at/before the cutoff become 'present'
  // - half_day / short_day / on_leave / absent / admin_marked rows are
  //   left alone so we don't trample manual classifications.
  // Fixes both the original UTC-vs-IST bug AND the case where a previous
  // tighter cutoff left rows mismarked as 'late' after mam relaxed it.
  try {
    const ps = db.prepare("SELECT late_after_time FROM payroll_settings WHERE id=1").get();
    const cutoffStr = (ps?.late_after_time || '09:46').padEnd(5, '0').slice(0, 5);
    const r = db.prepare(`
      UPDATE attendance
         SET status = CASE
             WHEN time(datetime(punch_in_time, '+5 hours', '+30 minutes')) > ?
                  THEN 'late'
             ELSE 'present'
           END
       WHERE punch_in_time IS NOT NULL
         AND status IN ('present', 'late')
         AND COALESCE(admin_marked, 0) = 0
    `).run(cutoffStr + ':00');
    if (r.changes > 0) console.log(`[backfill] re-synced ${r.changes} attendance rows against cutoff ${cutoffStr} IST`);
  } catch (e) { /* non-fatal */ }

  // One-time seed of mam's auto-mark-present allow-list. Guarded by an
  // app_settings key so toggling someone OFF via the UI doesn't get
  // reverted on the next server restart.
  try {
    const seeded = db.prepare("SELECT value FROM app_settings WHERE key='seed_auto_mark_v1'").get();
    if (!seeded) {
      const seedNames = ['admin','rajat sharma','nitin jain','pooja kaplesh','ankur kaplesh','parul kaplesh','backup admin'];
      const placeholders = seedNames.map(() => '?').join(',');
      db.prepare(
        `UPDATE users SET auto_mark_present=1
          WHERE LOWER(TRIM(name)) IN (${placeholders})`
      ).run(...seedNames);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('seed_auto_mark_v1', '1')").run();
    }
  } catch (e) { /* non-fatal */ }

  // Seed lead sources
  const sources = ['Indiamart', 'WhatsApp', 'LinkedIn', 'Client Reference', 'YouTube', 'Instagram', 'Twitter'];
  const insertSource = db.prepare('INSERT OR IGNORE INTO lead_sources (name) VALUES (?)');
  for (const s of sources) insertSource.run(s);

  // Seed default roles
  const defaultRoles = [
    { name: 'Admin', desc: 'Full access to all modules', is_system: 1 },
    { name: 'Sales Manager', desc: 'Manage leads, quotations, orders', is_system: 0 },
    { name: 'Sales Executive', desc: 'View and create leads, quotations', is_system: 0 },
    { name: 'Purchase Manager', desc: 'Manage procurement and vendors', is_system: 0 },
    { name: 'Site Engineer', desc: 'Installation and testing', is_system: 0 },
    { name: 'HR Manager', desc: 'HR, hiring, employees', is_system: 0 },
    { name: 'Accountant', desc: 'Billing, expenses, payments', is_system: 0 },
    { name: 'Data Entry', desc: 'Data entry for Business Book and orders', is_system: 0 },
    { name: 'Billing Engineer', desc: 'Approves billing and payment requests', is_system: 0 },
    { name: 'Viewer', desc: 'View-only access to all modules', is_system: 0 },
  ];

  const ALL_MODULES = [
    'dashboard','leads','quotations','orders','business_book','item_master','vendors','customers','procurement','cashflow','collections','payment_required','attendance','indent_fms','dpr',
    'installation','billing','complaints','hr','employees','expenses','checklists','users','delegations','pms_tasks','inventory','snags','company_assets','help_tickets'
  ];

  const insertRole = db.prepare('INSERT OR IGNORE INTO roles (name, description, is_system) VALUES (?, ?, ?)');
  for (const r of defaultRoles) insertRole.run(r.name, r.desc, r.is_system);

  // Seed permissions for each role
  const adminRole = db.prepare("SELECT id FROM roles WHERE name='Admin'").get();
  if (adminRole) {
    const existingPerms = db.prepare('SELECT COUNT(*) as c FROM role_permissions WHERE role_id=?').get(adminRole.id);
    if (existingPerms.c === 0) {
      const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
      // Admin gets full access
      for (const m of ALL_MODULES) insertPerm.run(adminRole.id, m, 1, 1, 1, 1, 1);

      // Data Entry - full access to business_book + orders, view others
      const deRole = db.prepare("SELECT id FROM roles WHERE name='Data Entry'").get();
      if (deRole) {
        for (const m of ['dashboard']) insertPerm.run(deRole.id, m, 1, 0, 0, 0, 0);
        for (const m of ['business_book','orders']) insertPerm.run(deRole.id, m, 1, 1, 1, 1, 0);
        for (const m of ['leads','quotations','vendors','procurement','cashflow','collections','indent_fms','dpr','installation','billing','complaints','hr','employees','expenses','checklists']) insertPerm.run(deRole.id, m, 1, 0, 0, 0, 0);
      }

      // Sales Manager
      const smRole = db.prepare("SELECT id FROM roles WHERE name='Sales Manager'").get();
      if (smRole) {
        for (const m of ['dashboard','leads','quotations','orders']) insertPerm.run(smRole.id, m, 1, 1, 1, 1, 1);
        for (const m of ['business_book']) insertPerm.run(smRole.id, m, 1, 0, 0, 0, 0);
        for (const m of ['vendors','procurement','installation','billing','complaints']) insertPerm.run(smRole.id, m, 1, 0, 0, 0, 0);
      }

      // Sales Executive
      const seRole = db.prepare("SELECT id FROM roles WHERE name='Sales Executive'").get();
      if (seRole) {
        for (const m of ['dashboard','leads','quotations']) insertPerm.run(seRole.id, m, 1, 1, 1, 0, 0);
        for (const m of ['orders','business_book']) insertPerm.run(seRole.id, m, 1, 0, 0, 0, 0);
      }

      // Purchase Manager
      const pmRole = db.prepare("SELECT id FROM roles WHERE name='Purchase Manager'").get();
      if (pmRole) {
        for (const m of ['dashboard','vendors','procurement']) insertPerm.run(pmRole.id, m, 1, 1, 1, 1, 1);
        for (const m of ['orders','billing']) insertPerm.run(pmRole.id, m, 1, 1, 1, 0, 0);
        for (const m of ['business_book']) insertPerm.run(pmRole.id, m, 1, 0, 0, 0, 0);
      }

      // Site Engineer
      const engRole = db.prepare("SELECT id FROM roles WHERE name='Site Engineer'").get();
      if (engRole) {
        for (const m of ['dashboard','installation','complaints']) insertPerm.run(engRole.id, m, 1, 1, 1, 0, 0);
        for (const m of ['billing']) insertPerm.run(engRole.id, m, 1, 1, 0, 0, 0);
        for (const m of ['orders','business_book']) insertPerm.run(engRole.id, m, 1, 0, 0, 0, 0);
      }

      // HR Manager
      const hrRole = db.prepare("SELECT id FROM roles WHERE name='HR Manager'").get();
      if (hrRole) {
        for (const m of ['dashboard','hr','employees','expenses','checklists']) insertPerm.run(hrRole.id, m, 1, 1, 1, 1, 1);
        for (const m of ['business_book']) insertPerm.run(hrRole.id, m, 1, 0, 0, 0, 0);
      }

      // Accountant
      const accRole = db.prepare("SELECT id FROM roles WHERE name='Accountant'").get();
      if (accRole) {
        for (const m of ['dashboard','billing','expenses']) insertPerm.run(accRole.id, m, 1, 1, 1, 0, 1);
        for (const m of ['orders','procurement','vendors','business_book']) insertPerm.run(accRole.id, m, 1, 0, 0, 0, 0);
      }

      // Viewer
      const viewerRole = db.prepare("SELECT id FROM roles WHERE name='Viewer'").get();
      if (viewerRole) {
        for (const m of ALL_MODULES) insertPerm.run(viewerRole.id, m, 1, 0, 0, 0, 0);
      }
    }
  }

  // Migration: ensure ALL modules have permission rows for ALL roles
  const allRoles = db.prepare('SELECT id, name FROM roles').all();
  const insertPermIfMissing = db.prepare('INSERT OR IGNORE INTO role_permissions (role_id, module, can_view, can_create, can_edit, can_delete, can_approve) VALUES (?,?,?,?,?,?,?)');
  for (const role of allRoles) {
    for (const mod of ALL_MODULES) {
      const exists = db.prepare('SELECT id FROM role_permissions WHERE role_id=? AND module=?').get(role.id, mod);
      if (!exists) {
        if (role.name === 'Admin') {
          insertPermIfMissing.run(role.id, mod, 1, 1, 1, 1, 1);
        } else if (role.name === 'Site Engineer' && (mod === 'dpr' || mod === 'payment_required')) {
          insertPermIfMissing.run(role.id, mod, 1, 1, 1, 0, 0);
        } else if (role.name === 'Data Entry' && (mod === 'business_book' || mod === 'item_master' || mod === 'orders')) {
          insertPermIfMissing.run(role.id, mod, 1, 1, 1, 1, 0);
        } else if (role.name === 'Accountant' && (mod === 'cashflow' || mod === 'collections' || mod === 'payment_required')) {
          insertPermIfMissing.run(role.id, mod, 1, 1, 1, 0, 1);
        } else {
          insertPermIfMissing.run(role.id, mod, 1, 0, 0, 0, 0);
        }
      }
    }
  }

  // One-time upgrade: any authenticated user should be able to raise an indent.
  // Grant can_view + can_create on 'procurement' to every non-Viewer role that
  // doesn't have it yet. (Viewers stay view-only by design.)
  try {
    const viewer = db.prepare("SELECT id FROM roles WHERE name='Viewer'").get();
    db.prepare(
      `UPDATE role_permissions SET can_view=1, can_create=1
       WHERE module='procurement' AND (can_view=0 OR can_create=0) AND role_id != ?`
    ).run(viewer ? viewer.id : -1);
  } catch (e) {}

  // Seed default admin user
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get('admin@erp.com');
  if (!existing) {
    const hash = bcrypt.hashSync('admin123', 10);
    const r = db.prepare('INSERT INTO users (name, email, username, password, role, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Admin', 'admin@erp.com', 'admin', hash, 'admin', 'Management');
    // Assign Admin role
    if (adminRole) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(r.lastInsertRowid, adminRole.id);
    }
  } else {
    // Backfill username for the pre-existing admin row if empty
    try { db.prepare("UPDATE users SET username='admin' WHERE email='admin@erp.com' AND (username IS NULL OR username='')").run(); } catch (e) {}
  }

  // Seed a SECOND admin so a single forgotten password doesn't lock the
  // company out. If mam loses access to 'admin', she can sign in as
  // 'backup-admin' and reset the primary admin's password from User
  // Management — no SSH / developer required.
  const backupExists = db.prepare('SELECT id FROM users WHERE username = ?').get('backup-admin');
  if (!backupExists) {
    const backupPwd = 'sepl-backup-2026';
    const bhash = bcrypt.hashSync(backupPwd, 10);
    const br = db.prepare('INSERT INTO users (name, email, username, password, role, department) VALUES (?, ?, ?, ?, ?, ?)')
      .run('Backup Admin', 'backup-admin@erp.com', 'backup-admin', bhash, 'admin', 'Management');
    if (adminRole) {
      db.prepare('INSERT OR IGNORE INTO user_roles (user_id, role_id) VALUES (?, ?)').run(br.lastInsertRowid, adminRole.id);
    }
    console.log(`[seed] Created backup admin — username: backup-admin, password: ${backupPwd}`);
  }

  // ============================================
  // LOCATION TRACKING OPT-OUT seed (mam's request 2026-04-28)
  // ============================================
  // Admins and a hand-picked list of names get track_location=0 so they
  // don't appear in Admin -> Location Tracking. Idempotent: only sets
  // the flag where it's still default 1, so re-runs respect any manual
  // toggle mam later changes via the UI.
  try {
    db.prepare(`UPDATE users SET track_location=0 WHERE role='admin' AND track_location=1`).run();
    const excludedNames = ['Ankur Kaplesh'];
    for (const n of excludedNames) {
      db.prepare(`UPDATE users SET track_location=0 WHERE LOWER(name)=LOWER(?) AND track_location=1`).run(n);
    }
  } catch (e) { /* track_location column not yet there on first ever boot — silent */ }

  // ============================================
  // INVENTORY SEED — Office Store + ONE Site Store per UNIQUE site name
  // ============================================
  // The `sites` table has duplicates (one row per PO referring to the same
  // customer), so we dedupe by name. Only ONE warehouse per unique site
  // name, linked to the OLDEST site_id with that name.
  try {
    const officeExists = db.prepare("SELECT id FROM warehouses WHERE type='office'").get();
    if (!officeExists) {
      db.prepare("INSERT INTO warehouses (name, type, location, in_charge) VALUES ('Office Store','office','Head Office',?)")
        .run('Admin');
      console.log('[seed] Created Office Store warehouse');
    }

    // STEP 1 — clean up duplicate site_store warehouses created by the
    // earlier seed. For each duplicate name, keep the lowest id and merge
    // stock_balance + redirect stock_movements onto it before deleting.
    try {
      const dupes = db.prepare(`
        SELECT name, MIN(id) as keep_id, GROUP_CONCAT(id) as all_ids, COUNT(*) as c
          FROM warehouses
         WHERE type = 'site_store'
         GROUP BY name
        HAVING c > 1
      `).all();
      let mergedTotal = 0;
      for (const d of dupes) {
        const removeIds = d.all_ids.split(',').map(s => +s).filter(i => i !== d.keep_id);
        for (const rid of removeIds) {
          // Merge stock_balance: sum quantities, weighted-average rate
          const sourceBalances = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=?').all(rid);
          for (const sb of sourceBalances) {
            const target = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?')
              .get(d.keep_id, sb.item_master_id);
            if (target) {
              const totalQty = (+target.quantity || 0) + (+sb.quantity || 0);
              const totalVal = ((+target.quantity || 0) * (+target.avg_rate || 0)) + ((+sb.quantity || 0) * (+sb.avg_rate || 0));
              const newAvg = totalQty > 0 ? totalVal / totalQty : 0;
              db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
                .run(totalQty, newAvg, target.id);
              db.prepare('DELETE FROM stock_balance WHERE id=?').run(sb.id);
            } else {
              db.prepare('UPDATE stock_balance SET warehouse_id=? WHERE id=?').run(d.keep_id, sb.id);
            }
          }
          // Redirect any movements pointing at the duplicate warehouse
          db.prepare('UPDATE stock_movements SET warehouse_id=? WHERE warehouse_id=?').run(d.keep_id, rid);
          db.prepare('UPDATE stock_movements SET from_warehouse_id=? WHERE from_warehouse_id=?').run(d.keep_id, rid);
          db.prepare('UPDATE stock_movements SET to_warehouse_id=? WHERE to_warehouse_id=?').run(d.keep_id, rid);
          db.prepare('DELETE FROM warehouses WHERE id=?').run(rid);
          mergedTotal += 1;
        }
      }
      if (mergedTotal > 0) console.log(`[seed] Merged ${mergedTotal} duplicate site_store warehouse(s)`);
    } catch (e) {
      console.error('[seed] dedupe failed:', e.message);
    }

    // STEP 2 — create stores for any UNIQUE site names that don't have one yet.
    // GROUP BY name + MIN(id) so duplicates collapse to a single row.
    const sitesNeedingStores = db.prepare(`
      SELECT MIN(s.id) as id, s.name FROM sites s
       WHERE s.name IS NOT NULL AND s.name <> ''
         AND NOT EXISTS (
           SELECT 1 FROM warehouses w
            WHERE w.type='site_store' AND w.name = s.name || ' Store'
         )
       GROUP BY s.name
    `).all();
    if (sitesNeedingStores.length > 0) {
      const ins = db.prepare("INSERT INTO warehouses (name, type, site_id, location) VALUES (?, 'site_store', ?, ?)");
      for (const s of sitesNeedingStores) ins.run(`${s.name} Store`, s.id, s.name);
      console.log(`[seed] Auto-created ${sitesNeedingStores.length} site_store warehouse(s)`);
    }
  } catch (e) {
    console.error('[seed] Inventory warehouse seed failed:', e.message);
  }

  // Owner-only emergency reset code — last-resort master key for the company
  // owner. Generated ONCE on the first server start, written in plaintext to
  // data/RECOVERY.txt (gitignored, only on the VPS), and stored as a bcrypt
  // hash in app_settings. Mam should copy it from RECOVERY.txt into a safe
  // place (diary / password manager) immediately after deploy. With this
  // code + a username, /auth/emergency-reset can reset ANY user's password
  // — so total lockout is impossible as long as mam keeps the code.
  try {
    const fs = require('fs');
    const existingHash = db.prepare("SELECT value FROM app_settings WHERE key='emergency_reset_hash'").get();
    if (!existingHash) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
      const code = Array.from({ length: 16 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
      const hash = bcrypt.hashSync(code, 10);
      db.prepare("INSERT INTO app_settings (key, value) VALUES ('emergency_reset_hash', ?)").run(hash);
      const recoveryPath = path.join(__dirname, '..', '..', 'data', 'RECOVERY.txt');
      const banner = [
        '================================================================',
        '  SEPL ERP - OWNER EMERGENCY RECOVERY CODE',
        '================================================================',
        '',
        `  CODE: ${code}`,
        '',
        '  WHAT THIS IS:',
        '  Last-resort master key. Used with the "Forgot password?" link',
        '  on the login page (it works as a recovery code for ANY user)',
        '  or via the /api/auth/emergency-reset endpoint.',
        '',
        '  WHAT TO DO RIGHT NOW:',
        '  1. Copy the CODE line above into your diary / password manager.',
        `  2. Delete this file from the server  (rm ${recoveryPath})`,
        '     so anyone with VPS access can\'t see it.',
        '  3. Keep the code SECRET. Anyone with this code can reset any',
        '     user\'s password.',
        '',
        '  IF YOU LOSE THIS CODE:',
        '  Run: node server/scripts/regenerate-emergency-code.js',
        '  (overwrites the old code, writes a new RECOVERY.txt)',
        '',
        '================================================================',
        '',
      ].join('\n');
      try {
        fs.writeFileSync(recoveryPath, banner, { encoding: 'utf-8' });
        console.log(`[seed] Wrote owner emergency recovery code to ${recoveryPath}`);
        console.log(`[seed] !! IMPORTANT — open that file, save the code, then delete it !!`);
      } catch (e) {
        console.error('[seed] Could not write RECOVERY.txt — code is in the DB but you need to regenerate it. Error:', e.message);
      }
    }
  } catch (e) {
    console.error('[seed] Emergency recovery setup failed:', e.message);
  }

  // Seed Item Master FIRST (needed for PO items in Business Book seed)
  const itemCount = db.prepare('SELECT COUNT(*) as c FROM item_master').get().c;
  if (itemCount === 0) {
    const fs = require('fs');
    const seedFile = path.join(__dirname, 'items_seed.json');
    if (fs.existsSync(seedFile)) {
      const items = JSON.parse(fs.readFileSync(seedFile, 'utf-8'));
      const insertItem = db.prepare('INSERT OR IGNORE INTO item_master (item_code, department, item_name, specification, size, uom, gst, type, make, current_price) VALUES (?,?,?,?,?,?,?,?,?,?)');
      const insertMany = db.transaction((items) => {
        for (const [code, dept, name, spec, size, unit, price, type, make] of items) {
          insertItem.run(code, dept, name, spec || '', size || '', unit || 'PCS', '18%', type || 'PO', make || '', price || 0);
        }
      });
      insertMany(items);
      console.log(`Seeded ${items.length} Item Master entries from Excel sheet`);
    }
  }

  // Seed sample Business Book entries (last 10 from Master Sheet)
  const bbCount = db.prepare('SELECT COUNT(*) as c FROM business_book').get().c;
  if (bbCount === 0) {
    const insertBB = db.prepare(`INSERT OR IGNORE INTO business_book (
      lead_no, lead_type, client_name, company_name, client_contact, source_of_enquiry,
      district, state, billing_address, sale_amount_without_gst, order_type, penalty_clause,
      committed_start_date, committed_delivery_date, committed_completion_date,
      employee_assigned, category, management_person_name, management_person_contact,
      customer_code, client_type, po_copy_link, boq_file_link, tpa_material_link, final_drawing_link,
      status, created_by
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`);

    const seedData = [
      ['SEPL20001','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','Punjab','LUDHIANA',222000,'SITC','No','2026-01-31','2026-02-06','2026-01-10','MD SIR','Fire Fighting','Seema mahajan','9872655005','SEPLCC1341','CRR','https://drive.google.com/open?id=1N5d0ug3iobuS_v3JGvB1ie0KCFp86u4y','https://drive.google.com/open?id=1vi7Mu5mAiSS_qh7VIlc0tF8ZwDl0uVfg','https://drive.google.com/open?id=1SLLt9c0fZjwHIbu73jBz9kQEZnf3e7FH','https://drive.google.com/open?id=1n6hS884Q69rmDZVQF4dSOYcRmnaIK7SA','booked'],
      ['SEPL20002','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','ludhiana','punjab','ludhiana',553105,'SITC','No','2026-02-02','2026-02-09','2026-02-13','MD SIR','Fire Fighting','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=18DHkuCx7lRYPIvXwkwnh4JcLP-nt2vFA','https://drive.google.com/open?id=1TWwwaAhK6FJAHG7iVaaRFaqHnwZp6hpl','https://drive.google.com/open?id=1bbo4nUybZ1Qbw_g97ZJUmuH-PeiQtzYY','https://drive.google.com/open?id=1jACzRXmfCA7G4Uq228gBMv3SOCU3Bv1W','booked'],
      ['SEPL20003','Private','Gurpreet Sodi','V-GUARD INDUSTRIES LTD','9899900489','CRR','HARIDWAR','HARIDWAR','HARIDWAR',129537,'SITC','No','2026-02-02','2026-02-09','2026-02-13','Lovely Sharma','Fire Fighting','Gurpreet Sodi','9899900489','SEPLCC1076','CRR','https://drive.google.com/open?id=17KedC2fesfiuXaic3loCXk4aDQCPUdUv','https://drive.google.com/open?id=14alGn10sS4bXScYJL7I7xwIwckLiCLWN','https://drive.google.com/open?id=1sXE9BHLAeYZSZH6KcFOh1TqV3udKQ3Kh','https://drive.google.com/open?id=1bAwn6P1Uum8IYuVsABuI-MjXDj8_UzqE','booked'],
      ['SEPL20004','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','PUNJAB','LUDHIANA',450000,'SITC','No','2026-02-18','2026-02-25','2026-02-28','MD Sir','Water Tank','Seema mahajan','9872655005','SEPLCC1341','CRR','https://drive.google.com/open?id=151CXGmPlvxIraatRZktdi14_6L_C4UZM','https://drive.google.com/open?id=1Ius-YG-t60UNtLS3IhsNxu_vCRKRKvp5','https://drive.google.com/open?id=16a5R9FUraZwsowphPgKbFMrnj2RSePnV','https://drive.google.com/open?id=10-J4hi8qA2_peBwBgrE_navCi83DnOk2','booked'],
      ['SEPL20005','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUDHIANA','PUNJAB','LUDHIANA',825150,'SITC','Yes','2026-02-26','2026-02-28','2026-03-05','MD Sir','Electrical','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=1EMyfEpIjbdjy_YyqCU9snSkYqLAUs64z','https://drive.google.com/open?id=1fKH-EYr9jvpEx5BmkZ200kZ9f2Pz-Ilx','https://drive.google.com/open?id=1sdr872lipYaPt_cLPbk1yXaWcd9gW9jj','https://drive.google.com/open?id=1MC6rXQ_18eFETPMGmh1yYgm5wEhOp_7l','booked'],
      ['SEPL20006','Private','Shivam Porwal','Emerald land india pvt ltd (Imperial Golf)','7906673064','Inbound','ludhiana','punjab','ludhiana',350000,'SITC','No','2026-03-06','2026-03-13','2026-03-17','Ankur sir','Fire Fighting','Shivam Porwal','7906673064','SEPLCC1380','NBD','','','','','booked'],
      ['SEPL20007','Private','Harvinder Singh','Harvinder Singh','9501106700','Inbound','LUDHIANA','PUNJAB','LUDHIANA',85000,'Supply','No','2026-03-07','2026-03-09','2026-03-12','Lovely Sharma','Fire Fighting','Harvinder Singh','9501106700','SEPLCC1381','NBD','','','','','booked'],
      ['SEPL20008','Private','Robby Ji Team','Ramana Machine','9876792561','Inbound','Ludhiana','Punjab','Punjab',1221036,'SITC','No','2026-03-18','2026-03-23','2026-03-27','Ankur sir','Solar','Robby Ji Team','9876792561','SEPLCC1379','NBD','https://drive.google.com/open?id=1BKFKpZwilobNawHsQVExISUMKJyjArNH','https://drive.google.com/open?id=1XGDf-q70qDKSaLBO1FKuq8WkliVutSzb','https://drive.google.com/open?id=1QywIKR4VCMmYqeuv0xQ1lftmmaAXN83a','https://drive.google.com/open?id=178ejMW-nUG_hVUzXRpPCq64_mzup5xYY','booked'],
      ['SEPL20009','Private','Mayank','sbj (Nirmal Products)','9877669049','Inbound','PUNJAB','Ludhiana','Ludhiana',365000,'SITC','No','2026-03-25','2026-03-30','2026-04-02','lovely sharma','Water Tank','Mayank','9877669049','SEPLCC1373','CRR','https://drive.google.com/open?id=1348oaE5eSAkDHlPqUopG8CTP-hK56cls','https://drive.google.com/open?id=1DM7NdEdvD6A22RPtjcCr20-nl0Ta24_i','https://drive.google.com/open?id=1DKovp3s0kA2I4rrW_-_IB7JQMrMyMOJK','https://drive.google.com/open?id=1OXQI4Q5Ti5Jet5PWeVE2UEJRTGrywDBx','booked'],
      ['SEPL20010','Private','Seema mahajan','CONSERN PHARMA','9872655005','CRR','LUdhiana','Punjab','LUdhiana',157500,'SITC','No','2026-04-06','2026-04-13','2026-04-16','LOVELY SHARMA','Electrical','Seema mahajan','9872655005','SEPLCC1351','CRR','https://drive.google.com/open?id=1IiI2ETQRFvdAeQNkUAEe5luvUt4sQ7PI','https://drive.google.com/open?id=1d11zaDrp6pWKjo44Y23dPV0IB_M50_2w','https://drive.google.com/open?id=1ek_Rzv1bzliP9deihSjadltH6nXF0k4T','https://drive.google.com/open?id=1lOgP_SsqFJFK--tDjbZSjkQ-mE9QILZw','booked'],
    ];

    for (const d of seedData) {
      insertBB.run(...d);
    }

    // Auto-create sites + order planning for each Business Book entry (NO POs - user enters those)
    const allBB = db.prepare('SELECT id, lead_no, client_name, company_name, project_name, category, district, state, billing_address, shipping_address, employee_assigned, management_person_name, committed_start_date, committed_completion_date FROM business_book').all();
    const insertSite = db.prepare('INSERT INTO sites (name, address, client_name, business_book_id, supervisor) VALUES (?,?,?,?,?)');
    const insertPlan = db.prepare('INSERT INTO order_planning (business_book_id, planned_start, planned_end, notes) VALUES (?,?,?,?)');

    for (const bb of allBB) {
      const siteName = bb.company_name || bb.project_name || `${bb.client_name} - ${bb.category || 'Project'}`;
      const siteAddr = bb.shipping_address || bb.billing_address || `${bb.district}, ${bb.state}`;
      insertSite.run(siteName, siteAddr, bb.client_name || bb.company_name, bb.id, bb.employee_assigned || bb.management_person_name);
      insertPlan.run(bb.id, bb.committed_start_date || null, bb.committed_completion_date || null, `Auto: ${bb.lead_no} - ${siteName}`);
    }
    console.log('Seeded 10 Business Book entries with sites (POs to be entered by user)');
  }

  console.log('Database initialized successfully');
  return db;
}

module.exports = { getDb, initializeDatabase };
