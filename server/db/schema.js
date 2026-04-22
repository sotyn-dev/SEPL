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
    db.pragma('journal_mode = WAL');
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
      category TEXT DEFAULT 'bug' CHECK(category IN ('bug','feature_request','how_to','data_issue','other')),
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
      status TEXT DEFAULT 'present' CHECK(status IN ('present','half_day','absent','late','leave','holiday')),
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
    ['purchase_orders', 'site_engineer_id INTEGER REFERENCES users(id)'],
    ['purchase_orders', 'site_engineer_ids TEXT'],
    ['purchase_orders', 'crm_name TEXT'],
    ['purchase_orders', 'boq_file_link TEXT'],
    ['attendance', 'auto_punched_in INTEGER DEFAULT 0'],
    ['attendance', 'auto_punched_out INTEGER DEFAULT 0'],
    ['users', 'username TEXT'],
    // Delegations — due-date extension request (assignee asks admin for more time)
    ['delegations', 'requested_due_date DATE'],
    ['delegations', 'extension_reason TEXT'],
    ['delegations', "extension_status TEXT"],
    ['delegations', 'extension_reviewed_at DATETIME'],
    ['delegations', 'extension_reviewed_by INTEGER REFERENCES users(id)'],
    // Time-of-day for recurring checklists (daily/weekly/…). Stored as 'HH:MM'.
    ['checklists', 'due_time TEXT'],
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
    ['vendor_pos', 'po_date DATE'],
    ['vendor_pos', 'file_path TEXT'],
    ['vendor_pos', 'remarks TEXT'],
  ];
  // Unique index on username — allows NULLs for legacy rows while enforcing uniqueness on set values
  try { db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username ON users(username) WHERE username IS NOT NULL'); } catch (e) {}

  // Relax payment_requests.category CHECK to allow new categories like
  // 'Salary' and 'Compliance'. SQLite can't ALTER a CHECK constraint, so we
  // detect the old 4-category signature in sqlite_master and rebuild the
  // table via a data-preserving copy. Runs exactly once — the new CREATE
  // TABLE IF NOT EXISTS won't re-create if a relaxed version already exists.
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
  for (const [table, col] of migrations) {
    try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) {}
  }

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
    'installation','billing','complaints','hr','employees','expenses','checklists','users','delegations'
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
