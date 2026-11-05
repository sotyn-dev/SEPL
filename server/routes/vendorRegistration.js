// SOTYN VENDOR REGISTRATION & EMPANELMENT ROUTER
// Manages the complete lifecycle: Company Identified -> Portal Found -> Requirements ->
// Submission -> Proof -> Follow-up Reminders -> Encrypted Vault -> Marketing Handover.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { encryptPassword, decryptPassword } = require('../lib/credentialVault');
const { scanAndSyncVendorEmails } = require('../lib/vendorRegistrationMailbox');

const router = express.Router();
router.use(authMiddleware);

// Standard MEP Document Checklist Template
const DEFAULT_DOCUMENTS_CHECKLIST = [
  { id: 'gst', name: 'GST Certificate', ready: false },
  { id: 'pan', name: 'Company PAN Card', ready: false },
  { id: 'bank', name: 'Cancelled Cheque & Bank Account Details', ready: false },
  { id: 'financials', name: 'Last 3 Years Audited Balance Sheet & ITR', ready: false },
  { id: 'msme', name: 'MSME / Udyam Certificate', ready: false },
  { id: 'mep_certs', name: 'MEP Project Completion & Experience Certificates', ready: false },
  { id: 'elec_license', name: 'Electrical Contractor License', ready: false },
  { id: 'iso_safety', name: 'ISO / Safety Policy Certificates', ready: false },
  { id: 'pf_esic', name: 'PF & ESIC Registration Proofs', ready: false },
];

const VALID_STAGES = [
  'company_identified',
  'portal_found',
  'requirements_checked',
  'registration_submitted',
  'proof_uploaded',
  'awaiting_credentials',
  'additional_info_required',
  'activation_pending',
  'credentials_received',
  'rejected',
];

// Helper: Append history
function logHistory(db, registrationId, stage, action, notes, user) {
  try {
    db.prepare(`
      INSERT INTO vendor_registration_history (
        registration_id, stage, action, notes, performed_by, performed_by_name
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      registrationId,
      stage,
      action,
      notes || null,
      user?.id || null,
      user?.name || 'System'
    );
  } catch (err) {
    console.warn('[vendorRegistration] history log failed:', err.message);
  }
}

// ── 1. GET / — List registrations with filters & pagination ──────────────
router.get('/', requirePermission('vendor_registration', 'view'), (req, res) => {
  const db = getDb();
  const { status, owner_id, category, q, overdue, marketing_status } = req.query;
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);

  const where = [];
  const params = [];

  if (status && VALID_STAGES.includes(status)) {
    where.push('vr.status = ?');
    params.push(status);
  }
  if (owner_id) {
    where.push('vr.registration_owner_id = ?');
    params.push(+owner_id);
  }
  if (category) {
    where.push('vr.company_category = ?');
    params.push(category);
  }
  if (marketing_status) {
    where.push('vr.marketing_status = ?');
    params.push(marketing_status);
  }
  if (overdue === '1' || overdue === 'true') {
    where.push("vr.status IN ('awaiting_credentials', 'registration_submitted', 'additional_info_required') AND vr.next_followup_date IS NOT NULL AND date(vr.next_followup_date) <= date('now', '+330 minutes')");
  }
  if (q) {
    const like = `%${q}%`;
    where.push('(vr.company_name LIKE ? OR vr.portal_url LIKE ? OR vr.application_number LIKE ? OR vr.vendor_id_code LIKE ?)');
    params.push(like, like, like, like);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const totalRow = db.prepare(`SELECT COUNT(*) as count FROM vendor_registrations vr ${whereClause}`).get(...params);
    const total = totalRow?.count || 0;

    const rows = db.prepare(`
      SELECT 
        vr.*,
        u.name as owner_user_name,
        u.email as owner_user_email,
        (SELECT COUNT(*) FROM vendor_registration_documents WHERE registration_id = vr.id) as docs_count,
        (SELECT COUNT(*) FROM vendor_registration_emails WHERE registration_id = vr.id) as emails_count,
        CASE 
          WHEN vr.next_followup_date IS NOT NULL AND date(vr.next_followup_date) < date('now', '+330 minutes') AND vr.status NOT IN ('credentials_received', 'rejected') THEN 1
          ELSE 0 
        END as is_overdue,
        CASE 
          WHEN vr.registration_date IS NOT NULL THEN 
            CAST(julianday('now') - julianday(vr.registration_date) AS INTEGER)
          ELSE 
            CAST(julianday('now') - julianday(vr.date_identified) AS INTEGER)
        END as days_in_pipeline
      FROM vendor_registrations vr
      LEFT JOIN users u ON vr.registration_owner_id = u.id
      ${whereClause}
      ORDER BY 
        is_overdue DESC,
        CASE vr.status
          WHEN 'awaiting_credentials' THEN 1
          WHEN 'additional_info_required' THEN 2
          WHEN 'registration_submitted' THEN 3
          WHEN 'proof_uploaded' THEN 4
          WHEN 'requirements_checked' THEN 5
          WHEN 'portal_found' THEN 6
          WHEN 'company_identified' THEN 7
          WHEN 'credentials_received' THEN 8
          ELSE 9
        END,
        vr.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // Mask passwords in list
    const sanitizedRows = rows.map(r => ({
      ...r,
      encrypted_password: r.encrypted_password ? '••••••••' : null,
      has_password: !!r.encrypted_password,
    }));

    res.json({
      total,
      rows: sanitizedRows,
      limit,
      offset,
    });
  } catch (err) {
    console.error('[vendorRegistration] list error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 2. GET /dashboard — High-level metrics & pipeline counts ──────────────
router.get('/dashboard', requirePermission('vendor_registration', 'view'), (req, res) => {
  const db = getDb();
  try {
    const totalPortals = db.prepare('SELECT COUNT(*) as c FROM vendor_registrations').get()?.c || 0;
    const submitted = db.prepare("SELECT COUNT(*) as c FROM vendor_registrations WHERE status IN ('registration_submitted', 'proof_uploaded', 'awaiting_credentials', 'additional_info_required', 'activation_pending', 'credentials_received')").get()?.c || 0;
    const awaiting = db.prepare("SELECT COUNT(*) as c FROM vendor_registrations WHERE status IN ('awaiting_credentials', 'proof_uploaded', 'additional_info_required', 'activation_pending')").get()?.c || 0;
    const received = db.prepare("SELECT COUNT(*) as c FROM vendor_registrations WHERE status = 'credentials_received' OR credentials_received = 1").get()?.c || 0;
    const followupsDue = db.prepare("SELECT COUNT(*) as c FROM vendor_registrations WHERE next_followup_date IS NOT NULL AND date(next_followup_date) <= date('now', '+330 minutes') AND status NOT IN ('credentials_received', 'rejected')").get()?.c || 0;

    // Stage pipeline distribution
    const stageRows = db.prepare(`
      SELECT status, COUNT(*) as count 
      FROM vendor_registrations 
      GROUP BY status
    `).all();

    const pipeline = {
      company_identified: 0,
      portal_found: 0,
      requirements_checked: 0,
      registration_submitted: 0,
      proof_uploaded: 0,
      awaiting_credentials: 0,
      additional_info_required: 0,
      activation_pending: 0,
      credentials_received: 0,
      rejected: 0,
    };
    for (const row of stageRows) {
      if (pipeline[row.status] !== undefined) {
        pipeline[row.status] = row.count;
      }
    }

    // Recent activity history (last 15 events)
    const recentActivity = db.prepare(`
      SELECT 
        vh.*,
        vr.company_name,
        vr.portal_url
      FROM vendor_registration_history vh
      JOIN vendor_registrations vr ON vh.registration_id = vr.id
      ORDER BY vh.created_at DESC
      LIMIT 15
    `).all();

    // Marketing pipeline count
    const readyForMarketing = db.prepare("SELECT COUNT(*) as c FROM vendor_registrations WHERE marketing_status = 'ready_for_marketing'").get()?.c || 0;

    res.json({
      counters: {
        totalPortals,
        submitted,
        awaiting,
        received,
        followupsDue,
        readyForMarketing,
      },
      pipeline,
      recentActivity,
    });
  } catch (err) {
    console.error('[vendorRegistration] dashboard error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 3. GET /settings — Read SLA and Mailbox settings ───────────────────────
router.get('/settings', requirePermission('vendor_registration', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare('SELECT key, value FROM vendor_registration_settings').all();
    const settings = {};
    for (const r of rows) settings[r.key] = r.value;
    
    // Mask email password
    if (settings.email_imap_pass) {
      settings.email_imap_pass = '••••••••';
    }
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 4. PUT /settings — Update settings ────────────────────────────────────
router.put('/settings', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const allowedKeys = [
    'reminder_first_days',
    'reminder_followup_days',
    'default_registered_email',
    'auto_email_scan_enabled',
    'email_imap_host',
    'email_imap_port',
    'email_imap_secure',
    'email_imap_user',
    'email_imap_pass',
    'email_imap_folder',
    'email_lookback_days',
  ];

  try {
    const updateStmt = db.prepare('INSERT OR REPLACE INTO vendor_registration_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)');
    for (const key of allowedKeys) {
      if (req.body[key] !== undefined) {
        // If password is still masked, skip overwriting
        if (key === 'email_imap_pass' && req.body[key] === '••••••••') continue;
        updateStmt.run(key, String(req.body[key]));
      }
    }
    res.json({ success: true, message: 'Settings saved successfully' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 5. POST /scan-mailbox — Trigger IMAP email scan ───────────────────────
router.post('/scan-mailbox', requirePermission('vendor_registration', 'edit'), async (req, res) => {
  try {
    const result = await scanAndSyncVendorEmails();
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 6. GET /:id — Get single record with documents, history, emails ───────
router.get('/:id', requirePermission('vendor_registration', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  try {
    const reg = db.prepare(`
      SELECT 
        vr.*,
        u.name as owner_user_name,
        u.email as owner_user_email
      FROM vendor_registrations vr
      LEFT JOIN users u ON vr.registration_owner_id = u.id
      WHERE vr.id = ?
    `).get(id);

    if (!reg) return res.status(404).json({ error: 'Vendor registration record not found' });

    // Documents
    const documents = db.prepare(`
      SELECT * FROM vendor_registration_documents
      WHERE registration_id = ?
      ORDER BY created_at DESC
    `).all(id);

    // History
    const history = db.prepare(`
      SELECT * FROM vendor_registration_history
      WHERE registration_id = ?
      ORDER BY created_at DESC
    `).all(id);

    // Matched emails
    const emails = db.prepare(`
      SELECT * FROM vendor_registration_emails
      WHERE registration_id = ?
      ORDER BY received_at DESC
    `).all(id);

    let parsedChecklist = [];
    try {
      parsedChecklist = reg.required_documents_json ? JSON.parse(reg.required_documents_json) : DEFAULT_DOCUMENTS_CHECKLIST;
    } catch {
      parsedChecklist = DEFAULT_DOCUMENTS_CHECKLIST;
    }

    res.json({
      ...reg,
      has_password: !!reg.encrypted_password,
      encrypted_password: reg.encrypted_password ? '••••••••' : null,
      required_documents: parsedChecklist,
      documents,
      history,
      emails,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 7. POST / — Create new portal registration ────────────────────────────
router.post('/', requirePermission('vendor_registration', 'create'), (req, res) => {
  const db = getDb();
  const {
    company_name,
    portal_url,
    company_category,
    source_of_portal,
    date_identified,
    registration_owner_id,
    registration_owner_name,
    mep_categories,
    registered_email,
    requirements_notes,
  } = req.body || {};

  if (!company_name || !String(company_name).trim()) {
    return res.status(400).json({ error: 'Company Name is required' });
  }
  if (!portal_url || !String(portal_url).trim()) {
    return res.status(400).json({ error: 'Portal URL is required' });
  }

  // Resolve owner
  let ownerId = registration_owner_id ? +registration_owner_id : req.user.id;
  let ownerName = registration_owner_name;
  if (!ownerName) {
    const ownerUser = db.prepare('SELECT name FROM users WHERE id=?').get(ownerId);
    ownerName = ownerUser?.name || req.user.name;
  }

  // Get default email if not supplied
  let emailUsed = registered_email;
  if (!emailUsed) {
    const defEmailRow = db.prepare("SELECT value FROM vendor_registration_settings WHERE key='default_registered_email'").get();
    emailUsed = defEmailRow?.value || 'vendor.registration@sotyn.com';
  }

  try {
    const checklistJson = JSON.stringify(DEFAULT_DOCUMENTS_CHECKLIST);
    const initialStatus = 'portal_found';

    const insertResult = db.prepare(`
      INSERT INTO vendor_registrations (
        company_name, portal_url, company_category, source_of_portal,
        date_identified, registration_owner_id, registration_owner_name,
        status, required_documents_json, mep_categories, registered_email,
        requirements_notes, created_by
      ) VALUES (?, ?, ?, ?, COALESCE(?, date('now')), ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      company_name.trim(),
      portal_url.trim(),
      company_category || 'MEP Contractor',
      source_of_portal || 'Web Search',
      date_identified || null,
      ownerId,
      ownerName,
      initialStatus,
      checklistJson,
      mep_categories || 'HVAC, Electrical, Plumbing, Fire Fighting',
      emailUsed,
      requirements_notes || null,
      req.user.id
    );

    const newId = insertResult.lastInsertRowid;

    // Log history
    logHistory(
      db,
      newId,
      initialStatus,
      'Portal Identified',
      `Identified ${company_name} vendor portal: ${portal_url}. Assigned to ${ownerName}.`,
      req.user
    );

    res.status(201).json({ id: newId, message: 'Vendor registration record created successfully' });
  } catch (err) {
    console.error('[vendorRegistration] create error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 8. PUT /:id — Update general details & checklist ──────────────────────
router.put('/:id', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  const {
    company_name,
    portal_url,
    company_category,
    source_of_portal,
    registration_owner_id,
    registration_owner_name,
    status,
    is_registration_open,
    requirements_notes,
    required_documents,
    mep_categories,
    registered_email,
    registration_date,
    application_number,
    submission_proof_url,
    submission_proof_filename,
    submission_ack_pdf_url,
    next_followup_date,
    rejection_reason,
    marketing_status,
    marketing_notes,
  } = req.body || {};

  try {
    let checklistJson = cur.required_documents_json;
    if (required_documents && Array.isArray(required_documents)) {
      checklistJson = JSON.stringify(required_documents);
    }

    const newStatus = (status && VALID_STAGES.includes(status)) ? status : cur.status;
    const statusChanged = newStatus !== cur.status;

    db.prepare(`
      UPDATE vendor_registrations SET
        company_name = COALESCE(?, company_name),
        portal_url = COALESCE(?, portal_url),
        company_category = COALESCE(?, company_category),
        source_of_portal = COALESCE(?, source_of_portal),
        registration_owner_id = COALESCE(?, registration_owner_id),
        registration_owner_name = COALESCE(?, registration_owner_name),
        status = ?,
        is_registration_open = COALESCE(?, is_registration_open),
        requirements_notes = COALESCE(?, requirements_notes),
        required_documents_json = ?,
        mep_categories = COALESCE(?, mep_categories),
        registered_email = COALESCE(?, registered_email),
        registration_date = COALESCE(?, registration_date),
        application_number = COALESCE(?, application_number),
        submission_proof_url = COALESCE(?, submission_proof_url),
        submission_proof_filename = COALESCE(?, submission_proof_filename),
        submission_ack_pdf_url = COALESCE(?, submission_ack_pdf_url),
        next_followup_date = ?,
        rejection_reason = COALESCE(?, rejection_reason),
        marketing_status = COALESCE(?, marketing_status),
        marketing_notes = COALESCE(?, marketing_notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      company_name,
      portal_url,
      company_category,
      source_of_portal,
      registration_owner_id ? +registration_owner_id : null,
      registration_owner_name,
      newStatus,
      is_registration_open !== undefined ? (is_registration_open ? 1 : 0) : null,
      requirements_notes,
      checklistJson,
      mep_categories,
      registered_email,
      registration_date,
      application_number,
      submission_proof_url,
      submission_proof_filename,
      submission_ack_pdf_url,
      next_followup_date !== undefined ? next_followup_date : cur.next_followup_date,
      rejection_reason,
      marketing_status,
      marketing_notes,
      id
    );

    if (statusChanged) {
      logHistory(
        db,
        id,
        newStatus,
        'Status Changed',
        `Status transitioned from "${cur.status}" to "${newStatus}".`,
        req.user
      );
    }

    res.json({ success: true, message: 'Vendor registration updated' });
  } catch (err) {
    console.error('[vendorRegistration] update error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 9. POST /:id/stage — Step transition with SLA auto-calculation ─────────
router.post('/:id/stage', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { stage, notes, application_number, registration_date } = req.body || {};

  if (!stage || !VALID_STAGES.includes(stage)) {
    return res.status(400).json({ error: 'Valid stage is required' });
  }

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  try {
    let nextFollowup = cur.next_followup_date;
    let regDate = registration_date || cur.registration_date;

    // SLA Rules:
    // When moved to 'registration_submitted' or 'proof_uploaded' or 'awaiting_credentials'
    // calculate Day 2 reminder if no follow-up date already exists
    if (['registration_submitted', 'proof_uploaded', 'awaiting_credentials'].includes(stage)) {
      if (!regDate) {
        regDate = new Date().toISOString().split('T')[0];
      }
      const reminderDays = +(db.prepare("SELECT value FROM vendor_registration_settings WHERE key='reminder_first_days'").get()?.value || 2);
      const targetDate = new Date(Date.now() + reminderDays * 86400000);
      nextFollowup = targetDate.toISOString().split('T')[0];
    }

    db.prepare(`
      UPDATE vendor_registrations SET
        status = ?,
        application_number = COALESCE(?, application_number),
        registration_date = COALESCE(?, registration_date),
        next_followup_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      stage,
      application_number || null,
      regDate || null,
      nextFollowup,
      id
    );

    logHistory(
      db,
      id,
      stage,
      'Stage Advanced',
      notes || `Advanced stage to ${stage}. Next follow-up scheduled for ${nextFollowup || 'N/A'}.`,
      req.user
    );

    res.json({ success: true, stage, next_followup_date: nextFollowup });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 10. POST /:id/proof — Attach submission proof (screenshot or PDF) ─────
router.post('/:id/proof', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const {
    file_url,
    filename,
    file_size,
    mime_type,
    doc_type,
    title,
    application_number,
  } = req.body || {};

  if (!file_url || !filename) {
    return res.status(400).json({ error: 'file_url and filename are required' });
  }

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  try {
    // 1. Insert into documents table
    db.prepare(`
      INSERT INTO vendor_registration_documents (
        registration_id, doc_type, title, file_url, filename, file_size, mime_type,
        uploaded_by, uploaded_by_name
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      doc_type || 'screenshot',
      title || (doc_type === 'ack_pdf' ? 'Registration Acknowledgment PDF' : 'Submission Screenshot Proof'),
      file_url,
      filename,
      file_size || null,
      mime_type || null,
      req.user.id,
      req.user.name
    );

    // 2. Update main record proof fields
    const updates = ['submission_proof_url = ?', 'submission_proof_filename = ?', 'updated_at = CURRENT_TIMESTAMP'];
    const params = [file_url, filename];

    if (application_number) {
      updates.push('application_number = ?');
      params.push(application_number);
    }

    // Auto-advance to 'proof_uploaded' or 'awaiting_credentials'
    let nextStage = cur.status;
    if (cur.status === 'registration_submitted' || cur.status === 'requirements_checked') {
      nextStage = 'proof_uploaded';
      updates.push('status = ?');
      params.push(nextStage);
    }

    params.push(id);
    db.prepare(`UPDATE vendor_registrations SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    logHistory(
      db,
      id,
      nextStage,
      'Proof Uploaded',
      `Uploaded ${filename} as submission proof. (App No: ${application_number || cur.application_number || 'N/A'})`,
      req.user
    );

    res.json({ success: true, message: 'Proof uploaded and linked successfully', stage: nextStage });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 11. POST /:id/credentials — Store Encrypted Credentials in Vault ───────
router.post('/:id/credentials', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const {
    vendor_id_code,
    portal_username,
    password,
    portal_login_url,
    credential_notes,
    credentials_received_date,
  } = req.body || {};

  if (!vendor_id_code && !portal_username && !password) {
    return res.status(400).json({ error: 'Vendor ID, Username, or Password is required' });
  }

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  try {
    let encryptedPass = cur.encrypted_password;
    if (password && String(password).trim() && password !== '••••••••') {
      encryptedPass = encryptPassword(String(password).trim());
    }

    const receivedDate = credentials_received_date || new Date().toISOString().split('T')[0];

    db.prepare(`
      UPDATE vendor_registrations SET
        credentials_received = 1,
        credentials_received_date = ?,
        vendor_id_code = COALESCE(?, vendor_id_code),
        portal_username = COALESCE(?, portal_username),
        portal_login_url = COALESCE(?, portal_login_url),
        encrypted_password = ?,
        credential_notes = COALESCE(?, credential_notes),
        status = 'credentials_received',
        marketing_status = CASE WHEN marketing_status = 'pending' THEN 'ready_for_marketing' ELSE marketing_status END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      receivedDate,
      vendor_id_code || null,
      portal_username || null,
      portal_login_url || cur.portal_url,
      encryptedPass,
      credential_notes || null,
      id
    );

    logHistory(
      db,
      id,
      'credentials_received',
      'Credentials Stored',
      `Vendor credentials successfully received & secured in encrypted vault. Vendor ID: ${vendor_id_code || 'Issued'}, Username: ${portal_username || 'Issued'}. Empanelment complete!`,
      req.user
    );

    res.json({
      success: true,
      message: 'Credentials safely stored in Vault. SOTYN is now empaneled with ' + cur.company_name,
    });
  } catch (err) {
    console.error('[vendorRegistration] credentials save error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── 12. GET /:id/reveal-password — Decrypt password (audited) ─────────────
router.get('/:id/reveal-password', requirePermission('vendor_registration', 'view'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  // Security gate: Admin or Assigned Owner only
  const isOwner = req.user.id === cur.registration_owner_id;
  const isAdmin = req.user.role === 'admin';
  if (!isAdmin && !isOwner) {
    return res.status(403).json({ error: 'Access denied: Only admin or assigned registration owner can view vault passwords.' });
  }

  if (!cur.encrypted_password) {
    return res.status(404).json({ error: 'No password stored for this vendor portal.' });
  }

  const plainPassword = decryptPassword(cur.encrypted_password);
  if (!plainPassword) {
    return res.status(500).json({ error: 'Unable to decrypt password. Key may have changed.' });
  }

  // Audit log entry
  logHistory(
    db,
    id,
    cur.status,
    'Vault Password Accessed',
    `User ${req.user.name} (${req.user.email}) accessed the portal password from Vault.`,
    req.user
  );

  res.json({ password: plainPassword });
});

// ── 13. POST /:id/followup — Record a follow-up action / call ─────────────
router.post('/:id/followup', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { notes, next_followup_date } = req.body || {};

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  try {
    const nextDate = next_followup_date || new Date(Date.now() + 3 * 86400000).toISOString().split('T')[0];

    db.prepare(`
      UPDATE vendor_registrations SET
        followup_count = followup_count + 1,
        last_followup_at = CURRENT_TIMESTAMP,
        next_followup_date = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(nextDate, id);

    logHistory(
      db,
      id,
      cur.status,
      'Follow-up Recorded',
      notes || `Follow-up made with portal helpdesk. Next follow-up scheduled for ${nextDate}.`,
      req.user
    );

    res.json({ success: true, next_followup_date: nextDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 14. POST /:id/handover-marketing — Transfer to BD / Marketing ─────────
router.post('/:id/handover-marketing', requirePermission('vendor_registration', 'edit'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { marketing_notes, campaign_type } = req.body || {};

  const cur = db.prepare('SELECT * FROM vendor_registrations WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Record not found' });

  if (cur.status !== 'credentials_received' && !cur.credentials_received) {
    return res.status(400).json({ error: 'Company must be empaneled (Credentials Received) before handing over to Marketing.' });
  }

  try {
    db.prepare(`
      UPDATE vendor_registrations SET
        marketing_status = 'campaign_active',
        marketing_handover_at = CURRENT_TIMESTAMP,
        marketing_handover_by = ?,
        marketing_notes = COALESCE(?, marketing_notes),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(req.user.id, marketing_notes || `Handed over for ${campaign_type || 'MEP Tendering & BD outreach'}`, id);

    logHistory(
      db,
      id,
      cur.status,
      'Handover to Marketing',
      `Transferred to Marketing & BD Pipeline. Status set to "campaign_active". Focus: ${campaign_type || 'MEP Contractor Works'}.`,
      req.user
    );

    res.json({ success: true, message: 'Successfully handed over to Marketing & BD Pipeline' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── 15. DELETE /:id — Delete registration (Admin only) ────────────────────
router.delete('/:id', requirePermission('vendor_registration', 'delete'), (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  try {
    const cur = db.prepare('SELECT company_name FROM vendor_registrations WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: 'Record not found' });

    db.prepare('DELETE FROM vendor_registrations WHERE id=?').run(id);
    res.json({ success: true, message: `Deleted registration for ${cur.company_name}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

