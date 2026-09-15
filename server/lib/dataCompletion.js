// Data Completion — one definition of "is this record actually filled in",
// shared by the on-page bar and the Data Entry KPI on the scorecard.
//
// MD 2026-09-03: "count this full kitting on above like data completion and
// want to take in data entry score". The bar existed only on Item Master, with
// its field list hard-coded inside routes/itemmaster.js. Business Book,
// Employees and Users now want the same bar, and the scorecard wants to score
// off it — so the spec lives HERE, once. If the bar and the score read
// different field lists they will disagree in front of the MD, which is the
// one outcome worth engineering against.
//
// A module entry is:
//   table   - the table to count over
//   noun    - what one row is called, for the UI ("13 of 20 projects complete")
//   label   - module name for the scorecard breakdown
//   where   - optional SQL filter, so archived/inactive rows are not scored
//   fields  - { key: { label, cond } }  where cond is SQL that is TRUE when filled
//
// Condition style, matched to the column's type:
//   text    TRIM(COALESCE(col,''))<>''
//   number  COALESCE(col,0)>0        (only when 0 is genuinely not a valid value)
//   fk      col IS NOT NULL

const MODULES = {
  // Mirrors the list that routes/itemmaster.js used to hold inline, and the
  // page's own save-time validation (ItemMaster.jsx).
  item_master: {
    table: 'item_master',
    noun: 'items',
    label: 'Item Master',
    fields: {
      item_name: { label: 'Item Name', cond: "TRIM(COALESCE(item_name,''))<>''" },
      type: { label: 'Type', cond: "TRIM(COALESCE(type,''))<>''" },
      specification: { label: 'Specification', cond: "TRIM(COALESCE(specification,''))<>''" },
      size: { label: 'Size', cond: "TRIM(COALESCE(size,''))<>''" },
      uom: { label: 'UOM', cond: "TRIM(COALESCE(uom,''))<>''" },
      gst: { label: 'GST', cond: "TRIM(COALESCE(gst,''))<>''" },
      make: { label: 'Make', cond: "TRIM(COALESCE(make,''))<>''" },
      rate: { label: 'Rate', cond: 'COALESCE(current_price,0)>0' },
      vendor: { label: 'Vendor', cond: 'vendor_id IS NOT NULL' },
      source_type: { label: 'Source', cond: "TRIM(COALESCE(source_type,''))<>''" },
      bill_po_number: { label: 'Bill/PO No', cond: "TRIM(COALESCE(bill_po_number,''))<>''" },
      bill_po_date: { label: 'Bill/PO Date', cond: "TRIM(COALESCE(bill_po_date,''))<>''" },
    },
  },

  // The three below were added for the MD's 2026-09-03 request. Each field list
  // mirrors the page's OWN required markers / save-time validation, so the bar
  // scores exactly what the form already refuses to save without — audit
  // columns, derived totals and optional attachments are deliberately out.
  // MD 2026-09-03, on seeing 104 x 14 = 1,456: "even one entry have near about
  // 60+ field then how do you count?" — fair. The list below is now EXACTLY the
  // page's own mandatory set (BusinessBook.jsx REQUIRED + client_name +
  // sale_amount + actual_margin = 33), which is what the New Entry form already
  // refuses to save without. Before this it counted 14, so an entry could score
  // 100% here while the form still called it incomplete — the bar was easier
  // than the form, which is the wrong way round.
  //
  // The six payment percentages are TEXT and are scored on PRESENCE, not > 0:
  // "0% retention" is a real answer, and the form's own check is the same
  // (String(v).trim() === ''). Sale Amount and Actual Margin keep > 0 because
  // that is what the form demands of them.
  business_book: {
    table: 'business_book',
    noun: 'entries',
    label: 'Business Book',
    fields: {
      client_name: { label: 'Client Name', cond: "TRIM(COALESCE(client_name,''))<>''" },
      company_name: { label: 'Company / Department', cond: "TRIM(COALESCE(company_name,''))<>''" },
      client_contact: { label: 'Client Contact No.', cond: "TRIM(COALESCE(client_contact,''))<>''" },
      client_email: { label: 'Client Email ID', cond: "TRIM(COALESCE(client_email,''))<>''" },
      source_of_enquiry: { label: 'Source of Enquiry', cond: "TRIM(COALESCE(source_of_enquiry,''))<>''" },
      customer_type: { label: 'Customer Type', cond: "TRIM(COALESCE(customer_type,''))<>''" },
      client_type: { label: 'Client Type', cond: "TRIM(COALESCE(client_type,''))<>''" },
      state: { label: 'State', cond: "TRIM(COALESCE(state,''))<>''" },
      district: { label: 'District', cond: "TRIM(COALESCE(district,''))<>''" },
      state_code: { label: 'State Code', cond: "TRIM(COALESCE(state_code,''))<>''" },
      gstin: { label: 'Client GSTIN', cond: "TRIM(COALESCE(gstin,''))<>''" },
      billing_address: { label: 'Billing Address', cond: "TRIM(COALESCE(billing_address,''))<>''" },
      shipping_address: { label: 'Shipping / Site Address', cond: "TRIM(COALESCE(shipping_address,''))<>''" },
      project_name: { label: 'Project Name', cond: "TRIM(COALESCE(project_name,''))<>''" },
      category: { label: 'Category', cond: "TRIM(COALESCE(category,''))<>''" },
      committed_start_date: { label: 'Committed Start', cond: "TRIM(COALESCE(committed_start_date,''))<>''" },
      committed_delivery_date: { label: 'Committed Delivery', cond: "TRIM(COALESCE(committed_delivery_date,''))<>''" },
      committed_completion_date: { label: 'Committed Completion', cond: "TRIM(COALESCE(committed_completion_date,''))<>''" },
      payment_advance: { label: 'Advance %', cond: "TRIM(COALESCE(CAST(payment_advance AS TEXT),''))<>''" },
      payment_against_delivery: { label: 'Against Delivery %', cond: "TRIM(COALESCE(CAST(payment_against_delivery AS TEXT),''))<>''" },
      payment_against_installation: { label: 'Against Installation %', cond: "TRIM(COALESCE(CAST(payment_against_installation AS TEXT),''))<>''" },
      payment_against_commissioning: { label: 'Against Commissioning %', cond: "TRIM(COALESCE(CAST(payment_against_commissioning AS TEXT),''))<>''" },
      payment_retention: { label: 'Retention %', cond: "TRIM(COALESCE(CAST(payment_retention AS TEXT),''))<>''" },
      payment_credit: { label: 'Handover %', cond: "TRIM(COALESCE(CAST(payment_credit AS TEXT),''))<>''" },
      employee_assigned: { label: 'Employee Name', cond: "TRIM(COALESCE(employee_assigned,''))<>''" },
      management_person_name: { label: 'Management Person', cond: "TRIM(COALESCE(management_person_name,''))<>''" },
      management_person_contact: { label: 'Management Contact', cond: "TRIM(COALESCE(management_person_contact,''))<>''" },
      accounts_person_name: { label: 'Accounts Person', cond: "TRIM(COALESCE(accounts_person_name,''))<>''" },
      accounts_person_contact: { label: 'Accounts Contact', cond: "TRIM(COALESCE(accounts_person_contact,''))<>''" },
      working_sheet_link: { label: 'Working Sheet', cond: "TRIM(COALESCE(working_sheet_link,''))<>''" },
      boq_file_link: { label: 'BOQ File', cond: "TRIM(COALESCE(boq_file_link,''))<>''" },
      sale_amount_without_gst: { label: 'Sale Amount', cond: 'COALESCE(sale_amount_without_gst,0)>0' },
      actual_margin_pct: { label: 'Actual Margin %', cond: 'COALESCE(actual_margin_pct,0)>0' },
    },
  },

  employees: {
    table: 'employees',
    noun: 'employees',
    label: 'Employees',
    // People who have LEFT are excluded. Nobody is ever going to fill in a
    // departed employee's missing PAN, so scoring them would permanently drag
    // the number down and the score would stop being actionable.
    where: "COALESCE(status,'active') <> 'inactive'",
    fields: {
      name: { label: 'Name', cond: "TRIM(COALESCE(name,''))<>''" },
      phone: { label: 'Phone', cond: "TRIM(COALESCE(phone,''))<>''" },
      email: { label: 'Email', cond: "TRIM(COALESCE(email,''))<>''" },
      designation: { label: 'Designation', cond: "TRIM(COALESCE(designation,''))<>''" },
      department: { label: 'Department', cond: "TRIM(COALESCE(department,''))<>''" },
      join_date: { label: 'Join Date', cond: "TRIM(COALESCE(join_date,''))<>''" },
      salary: { label: 'Salary', cond: 'COALESCE(salary,0)>0' },
      user_id: { label: 'Linked Login', cond: 'user_id IS NOT NULL' },
      aadhar_file: { label: 'Aadhar', cond: "TRIM(COALESCE(aadhar_file,''))<>''" },
      pan_file: { label: 'PAN', cond: "TRIM(COALESCE(pan_file,''))<>''" },
      qualification_file: { label: 'Qualification Cert', cond: "TRIM(COALESCE(qualification_file,''))<>''" },
    },
  },

  users: {
    table: 'users',
    noun: 'users',
    label: 'Users',
    // Archived / disabled logins are excluded for the same reason as above.
    where: 'COALESCE(archived,0) = 0 AND COALESCE(active,1) = 1',
    fields: {
      name: { label: 'Full Name', cond: "TRIM(COALESCE(name,''))<>''" },
      email: { label: 'Email', cond: "TRIM(COALESCE(email,''))<>''" },
      username: { label: 'Username', cond: "TRIM(COALESCE(username,''))<>''" },
      phone: { label: 'Phone', cond: "TRIM(COALESCE(phone,''))<>''" },
      department: { label: 'Department', cond: "TRIM(COALESCE(department,''))<>''" },
      role: { label: 'System Role', cond: "TRIM(COALESCE(role,''))<>''" },
      avatar_url: { label: 'Photo', cond: "TRIM(COALESCE(avatar_url,''))<>''" },
      manager_id: { label: 'Reporting Manager', cond: 'manager_id IS NOT NULL' },
      // NOTE: password / recovery_code_hash / token columns are NEVER scored.
    },
  },
};

function registerModule(key, spec) { MODULES[key] = spec; }

function moduleKeys() { return Object.keys(MODULES); }

// Completion for ONE module. Same response shape the Item Master bar already
// consumed, plus `noun`/`label` so the shared component can caption itself.
function completionFor(db, key) {
  const m = MODULES[key];
  if (!m) return null;
  const keys = Object.keys(m.fields);
  if (!keys.length) return null;

  const F = (expr) => `SUM(CASE WHEN ${expr} THEN 1 ELSE 0 END)`;
  const selects = keys.map(k => `${F(m.fields[k].cond)} AS ${k}`).join(', ');
  const allFilled = keys.map(k => `(${m.fields[k].cond})`).join(' AND ');
  const where = m.where ? ` WHERE ${m.where}` : '';

  const row = db.prepare(
    `SELECT COUNT(*) AS total, ${selects}, ${F(allFilled)} AS complete_items FROM ${m.table}${where}`
  ).get();

  const total = row.total || 0;
  const per_field = keys.map(k => ({
    key: k,
    label: m.fields[k].label,
    filled: row[k] || 0,
    missing: total - (row[k] || 0),
  }));
  const filled_total = per_field.reduce((s, x) => s + x.filled, 0);

  return {
    module: key,
    label: m.label,
    noun: m.noun,
    total_items: total,
    field_count: keys.length,
    required_total: total * keys.length,
    filled_total,
    complete_items: row.complete_items || 0,
    per_field,
  };
}

// Every module rolled into one figure — what the Data Entry KPI scores on.
// A module whose query fails (a column dropped by a future migration, say) is
// skipped rather than taking the whole score down with it; `errors` says which.
function completionAll(db) {
  const modules = [];
  const errors = [];
  for (const key of Object.keys(MODULES)) {
    try {
      const c = completionFor(db, key);
      if (c) modules.push(c);
    } catch (e) {
      errors.push({ module: key, error: e.message });
      console.error(`[data-completion] ${key} failed:`, e.message);
    }
  }
  const required_total = modules.reduce((s, m) => s + m.required_total, 0);
  const filled_total = modules.reduce((s, m) => s + m.filled_total, 0);
  return {
    required_total,
    filled_total,
    pct: required_total ? Math.round((filled_total / required_total) * 1000) / 10 : 0,
    total_items: modules.reduce((s, m) => s + m.total_items, 0),
    complete_items: modules.reduce((s, m) => s + m.complete_items, 0),
    modules,
    errors,
  };
}

module.exports = { MODULES, registerModule, moduleKeys, completionFor, completionAll };
