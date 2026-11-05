// Seed realistic local test data for SOTYN Vendor Registration & Marketing Pipeline

const { getDb } = require('./schema');
const { encryptPassword } = require('../lib/credentialVault');

function seedVendorRegistrationData() {
  const db = getDb();
  console.log('[seedVendorRegistration] Seeding local test data...');

  // Clean previous demo seed records if re-running
  db.prepare(`
    DELETE FROM vendor_registrations 
    WHERE company_name IN (
      'Reliance Industries Limited',
      'Larsen & Toubro (L&T)',
      'Godrej Properties',
      'Adani Enterprises (Solar & Infra)',
      'Tata Projects Limited',
      'JCB India Limited',
      'Havells India',
      'ITC Limited'
    )
  `).run();

  const standardChecklist = [
    { id: 'gst', name: 'GST Certificate', ready: true },
    { id: 'pan', name: 'Company PAN Card', ready: true },
    { id: 'bank', name: 'Cancelled Cheque & Bank Details', ready: true },
    { id: 'financials', name: 'Last 3 Years Balance Sheet / ITR', ready: true },
    { id: 'msme', name: 'MSME / Udyam Certificate', ready: true },
    { id: 'mep_certs', name: 'MEP Project Completion Certificates', ready: true },
    { id: 'elec_license', name: 'Electrical Contractor License', ready: true },
    { id: 'iso_safety', name: 'ISO / Safety Policy Certifications', ready: false },
    { id: 'pf_esic', name: 'PF & ESIC Registration Proofs', ready: true },
  ];

  // Helper date generators
  const today = new Date().toISOString().split('T')[0];
  const twoDaysAgo = new Date(Date.now() - 2 * 86400000).toISOString().split('T')[0];
  const fourDaysAgo = new Date(Date.now() - 4 * 86400000).toISOString().split('T')[0];
  const sixDaysAgo = new Date(Date.now() - 6 * 86400000).toISOString().split('T')[0];
  const inTwoDays = new Date(Date.now() + 2 * 86400000).toISOString().split('T')[0];

  // ── 1. Reliance Industries (Empaneled & Credentials in Vault) ──────────
  const rilEncryptedPass = encryptPassword('Ril#Portal2026Secure!');
  const insRil = db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, required_documents_json, mep_categories, registered_email,
      registration_date, application_number,
      submission_proof_url, submission_proof_filename,
      credentials_received, credentials_received_date,
      vendor_id_code, portal_username, portal_login_url,
      encrypted_password, credential_notes,
      marketing_status, marketing_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Reliance Industries Limited',
    'https://scm.ril.com',
    'Industrial & Manufacturing',
    'Procurement Recommendation',
    sixDaysAgo,
    1,
    'Anchal',
    'credentials_received',
    JSON.stringify(standardChecklist.map(d => ({ ...d, ready: true }))),
    'HVAC, Electrical, Fire Fighting, Industrial Piping',
    'vendor.registration@sotyn.com',
    fourDaysAgo,
    'RIL-VREG-2026-98124',
    '/uploads/demo-proofs/reliance-acknowledgement.png',
    'reliance-acknowledgement.png',
    1,
    today,
    'V-RIL-88432',
    'sotyn_mep_corp',
    'https://scm.ril.com/vendor-login',
    rilEncryptedPass,
    'Official SCM Vendor Code assigned. OTP sent to registered mobile for first login.',
    'ready_for_marketing',
    'Empaneled for Jamnagar, Hazira & Dahej MEP contractor packages. Ready for RFQ bid submissions.'
  );
  const rilId = insRil.lastInsertRowid;

  // Documents for Reliance
  db.prepare(`
    INSERT INTO vendor_registration_documents (
      registration_id, doc_type, title, file_url, filename, uploaded_by_name
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    rilId,
    'screenshot',
    'Submission Success Screenshot',
    '/uploads/demo-proofs/reliance-ack-screen.png',
    'reliance-ack-screen.png',
    'Anchal'
  );

  // Inbound Emails for Reliance
  db.prepare(`
    INSERT INTO vendor_registration_emails (
      registration_id, company_name, matched_by, sender, sender_name,
      subject, email_type, body_snippet, has_attachments, received_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    rilId,
    'Reliance Industries Limited',
    'domain',
    'supplier.helpdesk@ril.com',
    'Reliance SCM Portal',
    'Vendor Empanelment Confirmed - Vendor Code: V-RIL-88432',
    'credentials',
    'Dear M/s SOTYN, Congratulations! Your vendor registration has been approved. Your Vendor ID is V-RIL-88432. You may now log in to the portal.',
    1,
    today + 'T10:30:00Z'
  );

  // History for Reliance
  const rilHistory = [
    ['company_identified', 'Company Identified', 'Identified Reliance Industries as primary MEP client target.'],
    ['portal_found', 'Portal Found', 'Located official registration portal scm.ril.com.'],
    ['requirements_checked', 'Requirements Checked', 'All 9 compliance documents verified & ready.'],
    ['registration_submitted', 'Registration Submitted', 'Online form filled. Registered email: vendor.registration@sotyn.com. App No: RIL-VREG-2026-98124.'],
    ['proof_uploaded', 'Proof Uploaded', 'Uploaded submission confirmation screenshot.'],
    ['credentials_received', 'Credentials Stored', 'Vendor ID V-RIL-88432 received and encrypted in Vault. Handed over to BD.'],
  ];
  for (const [stg, act, nts] of rilHistory) {
    db.prepare(`
      INSERT INTO vendor_registration_history (registration_id, stage, action, notes, performed_by_name)
      VALUES (?, ?, ?, ?, 'Anchal')
    `).run(rilId, stg, act, nts);
  }

  // ── 2. Godrej Properties (Awaiting Credentials — OVERDUE Follow-up Alert) ──
  const insGodrej = db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, required_documents_json, mep_categories, registered_email,
      registration_date, application_number, next_followup_date, followup_count,
      submission_proof_url, submission_proof_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Godrej Properties',
    'https://procurement.godrejproperties.com',
    'Commercial Real Estate',
    'LinkedIn Procurement Post',
    sixDaysAgo,
    1,
    'Anchal',
    'awaiting_credentials',
    JSON.stringify(standardChecklist),
    'HVAC, Electrical, Plumbing, Fire Fighting',
    'vendor.registration@sotyn.com',
    fourDaysAgo,
    'GPL-MEP-55421',
    twoDaysAgo, // Overdue by 2 days!
    1,
    '/uploads/demo-proofs/godrej-submission.pdf',
    'godrej-submission.pdf'
  );
  const godrejId = insGodrej.lastInsertRowid;

  db.prepare(`
    INSERT INTO vendor_registration_history (registration_id, stage, action, notes, performed_by_name)
    VALUES (?, 'registration_submitted', 'Registration Submitted', 'Submitted on Godrej portal. Follow-up was due on 2 days ago.', 'Anchal')
  `).run(godrejId);

  // ── 3. Larsen & Toubro (Registration Submitted — Follow-up In 2 Days) ─────
  const insLt = db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, required_documents_json, mep_categories, registered_email,
      registration_date, application_number, next_followup_date,
      submission_proof_url, submission_proof_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Larsen & Toubro (L&T)',
    'https://eproc.larsentoubro.com/vendor',
    'EPC & Infrastructure',
    'Tender Notice',
    twoDaysAgo,
    1,
    'Anchal',
    'registration_submitted',
    JSON.stringify(standardChecklist),
    'Electrical Substations, Solar, HVAC, Fire Fighting',
    'vendor.registration@sotyn.com',
    today,
    'LT-EPS-2026-9021',
    inTwoDays,
    '/uploads/demo-proofs/lt-ack.png',
    'lt-ack.png'
  );
  const ltId = insLt.lastInsertRowid;

  db.prepare(`
    INSERT INTO vendor_registration_history (registration_id, stage, action, notes, performed_by_name)
    VALUES (?, 'registration_submitted', 'Form Submitted', 'Online vendor empanelment form completed. App No: LT-EPS-2026-9021.', 'Anchal')
  `).run(ltId);

  // ── 4. Adani Enterprises (Proof Uploaded) ─────────────────────────────────
  const insAdani = db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, required_documents_json, mep_categories, registered_email,
      registration_date, application_number, next_followup_date,
      submission_proof_url, submission_proof_filename
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Adani Enterprises (Solar & Infra)',
    'https://supplier.adani.com/onboard',
    'Power & Energy',
    'Client Referral',
    twoDaysAgo,
    1,
    'Anchal',
    'proof_uploaded',
    JSON.stringify(standardChecklist),
    'Solar EPC, HT/LT Electrical, Fire Protection',
    'vendor.registration@sotyn.com',
    today,
    'ADANI-ONB-77412',
    inTwoDays,
    '/uploads/demo-proofs/adani-ack.pdf',
    'adani-ack.pdf'
  );
  const adaniId = insAdani.lastInsertRowid;

  db.prepare(`
    INSERT INTO vendor_registration_documents (
      registration_id, doc_type, title, file_url, filename, uploaded_by_name
    ) VALUES (?, 'ack_pdf', 'Official Adani Acknowledgement Slip', '/uploads/demo-proofs/adani-ack.pdf', 'adani-ack.pdf', 'Anchal')
  `).run(adaniId);

  // ── 5. Tata Projects Limited (Requirements Checked) ─────────────────────
  db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, required_documents_json, mep_categories, registered_email,
      requirements_notes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Tata Projects Limited',
    'https://eps.tataprojects.com/suppliers',
    'EPC & Infrastructure',
    'Web Search',
    today,
    1,
    'Anchal',
    'requirements_checked',
    JSON.stringify(standardChecklist),
    'HVAC, Electrical, Plumbing, BMS',
    'vendor.registration@sotyn.com',
    'Requires minimum ₹15 Cr turnover proof & ISO 45001 safety certification.'
  );

  // ── 6. JCB India Limited (Portal Found) ──────────────────────────────────
  db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, mep_categories, registered_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'JCB India Limited',
    'https://supplier.jcb.com/india-facilities',
    'Automotive & Engineering',
    'Factory Expansion Tender',
    today,
    1,
    'Anchal',
    'portal_found',
    'HVAC & Industrial Electricals',
    'vendor.registration@sotyn.com'
  );

  // ── 7. Havells India (Company Identified) ────────────────────────────────
  db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, mep_categories, registered_email
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'Havells India',
    'https://vendor.havells.com',
    'Industrial & Manufacturing',
    'Web Search',
    today,
    1,
    'Anchal',
    'company_identified',
    'Electrical Contracting & Solar',
    'vendor.registration@sotyn.com'
  );

  // ── 8. ITC Limited (Additional Info Required) ────────────────────────────
  db.prepare(`
    INSERT INTO vendor_registrations (
      company_name, portal_url, company_category, source_of_portal,
      date_identified, registration_owner_id, registration_owner_name,
      status, mep_categories, registered_email, application_number,
      requirements_notes, next_followup_date
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    'ITC Limited',
    'https://supplier.itcportal.com',
    'FMCG & Food Processing',
    'Procurement RFP',
    fourDaysAgo,
    1,
    'Anchal',
    'additional_info_required',
    'HVAC Clean Rooms & Fire Suppression',
    'vendor.registration@sotyn.com',
    'ITC-SUP-33120',
    'ITC SCM requested revised ISO Safety manual & client recommendation letters for food processing plants.',
    today
  );

  console.log('[seedVendorRegistration] Successfully seeded 8 companies across all 7 stages!');
}

module.exports = { seedVendorRegistrationData };

if (require.main === module) {
  seedVendorRegistrationData();
}

