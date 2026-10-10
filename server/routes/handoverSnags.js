// SOP-15: Handover & Snags Route Module
// Owner: Project Manager — Adarsh Kumar
//
// Lifecycle:
// S1: Work reaches 100% → Handover process starts; cost booking locked.
// S2: Joint Snag walk with client → every snag noted separately.
// S3: Snag task clock & escalation (overdue → PM, then Head).
// S4: Snag closed with photo; client ticks each one (Lovely / CRM).
// S5: All snags closed → Handover certificate auto-generated (HC-YYYY-XXXX).
// S6: Signed handover starts final bill, retention schedule, and warranty period.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();
router.use(authMiddleware);

// ─── Default SOP-15 RACI Matrix (Configurable, Admin-Editable) ──────────
const DEFAULT_SOP15_RACI = {
  sop_owner: {
    key: 'sop_owner',
    role_name: 'SOP-15 Owner / Project Manager',
    raci_type: 'A',
    stage_label: 'Overall Process Owner',
    default_name: 'Adarsh Kumar (PM)',
    description: 'Overall Process Owner accountable for end-to-end Handover & Snags delivery, timeline adherence, and final sign-off.'
  },
  s1_cost_lock: {
    key: 's1_cost_lock',
    role_name: 'Handover & Cost-Lock Authority',
    raci_type: 'A',
    stage_label: 'S1 Work 100% / Cost Lock',
    default_name: 'Adarsh Kumar (PM)',
    description: 'Declares work 100% complete and enforces immediate cost lock on ERP to prevent cost leakage.'
  },
  s2_snag_walk: {
    key: 's2_snag_walk',
    role_name: 'Joint Client Snag Walk Lead',
    raci_type: 'R',
    stage_label: 'S2 Snag Walk',
    default_name: 'Site Engineer',
    description: 'Conducts on-site joint snag walk with client representative and logs all punch items with photos.'
  },
  s3_snag_clock: {
    key: 's3_snag_clock',
    role_name: 'Snag Clock & Escalation Authority',
    raci_type: 'A',
    stage_label: 'S3 Snag Clock & Escalation',
    default_name: 'Adarsh Kumar (PM)',
    description: 'Monitors daily snag resolution clock; receives escalations when target dates are breached.'
  },
  s4_client_tick: {
    key: 's4_client_tick',
    role_name: 'Client Verification & Snag Sign-off',
    raci_type: 'R',
    stage_label: 'S4 Snag Closure & Client Tick',
    default_name: 'Lovely (CRM)',
    description: 'Coordinates client sign-off tick for each rectified snag with after-photo proof (no email chains).'
  },
  s5_handover_cert: {
    key: 's5_handover_cert',
    role_name: 'Handover Certificate Issuing Authority',
    raci_type: 'A',
    stage_label: 'S5 Handover Certificate',
    default_name: 'Lovely (CRM)',
    description: 'Generates official Handover Certificate (HC-YYYY-XXXX) once 100% of snags are closed.'
  },
  s6_retention_warranty: {
    key: 's6_retention_warranty',
    role_name: 'Final Billing, Retention & Warranty Authority',
    raci_type: 'A',
    stage_label: 'S6 Financial & Warranty Closure',
    default_name: 'Lovely (CRM) / Accounts',
    description: 'Triggers final sales bill, schedules retention release calendar, and initiates warranty period.'
  }
};

function getHandoverRaci(db) {
  let saved = {};
  try {
    const row = db.prepare("SELECT value FROM app_settings WHERE key='sop15_handover_raci'").get();
    if (row?.value) saved = JSON.parse(row.value);
  } catch (_) {}

  let users = [];
  try {
    users = db.prepare("SELECT id, name, email, department, role FROM users WHERE active=1 ORDER BY name").all();
  } catch (_) {}
  const userMap = new Map(users.map(u => [u.id, u]));

  const result = {};
  for (const [k, def] of Object.entries(DEFAULT_SOP15_RACI)) {
    const s = saved[k] || {};
    const uid = s.user_id ? Number(s.user_id) : null;
    const u = uid ? userMap.get(uid) : null;
    result[k] = {
      ...def,
      user_id: uid,
      assigned_name: u ? u.name : (s.custom_name || def.default_name),
      assigned_email: u ? u.email : null,
      assigned_department: u ? u.department : null,
      is_custom: !!u || !!s.custom_name,
    };
  }

  // If sop_owner is configured, and S1/S3 were left on standard default,
  // align S1 and S3's default_name to match the active SOP-15 Owner!
  const ownerName = result.sop_owner?.assigned_name || 'Adarsh Kumar (PM)';
  if (result.s1_cost_lock && !result.s1_cost_lock.is_custom) {
    result.s1_cost_lock.default_name = ownerName;
    result.s1_cost_lock.assigned_name = ownerName;
    result.s1_cost_lock.user_id = result.sop_owner?.user_id;
  }
  if (result.s3_snag_clock && !result.s3_snag_clock.is_custom) {
    result.s3_snag_clock.default_name = ownerName;
    result.s3_snag_clock.assigned_name = ownerName;
    result.s3_snag_clock.user_id = result.sop_owner?.user_id;
  }

  return { raci: result, users };
}

// ─── Notification Dispatcher for SOP-15 ────────────────────────────────
function notifyHandoverSOP(db, siteId, event, actor, alert) {
  try {
    const site = db.prepare('SELECT id, name, client_name FROM sites WHERE id=?').get(siteId);
    if (!site) return;

    const raciData = getHandoverRaci(db).raci;
    let targetUserId = null;
    if (event === 's1_cost_locked') targetUserId = raciData.s2_snag_walk?.user_id;
    else if (event === 's2_walk_recorded') targetUserId = raciData.s3_snag_clock?.user_id;
    else if (event === 's3_escalation') targetUserId = raciData.s3_snag_clock?.user_id;
    else if (event === 's4_snags_cleared') targetUserId = raciData.s5_handover_cert?.user_id;
    else if (event === 's5_cert_ready') targetUserId = raciData.s6_retention_warranty?.user_id;
    else if (event === 's6_closed') targetUserId = raciData.s6_retention_warranty?.user_id;

    const recipients = db.prepare(`
      SELECT DISTINCT ur.user_id AS id FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE rp.module IN ('snags', 'project_dashboard') AND rp.can_view = 1
       UNION SELECT id FROM users WHERE (role='admin' OR department IN ('Site Operations', 'Project Management', 'CRM', 'Management')) AND active=1
    `).all();

    if (targetUserId && !recipients.some(r => r.id === targetUserId)) {
      recipients.push({ id: targetUserId });
    }

    const title = alert.title || `Handover Update: ${site.name}`;
    const body = alert.body || `Site ${site.name} SOP-15 stage updated.`;
    const linkUrl = `/snags?site_id=${siteId}`;
    const dedupeKey = `handover:${siteId}:${event}:${Date.now()}`;

    const ins = db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?, 'handover_snags', ?, ?, ?, 'in_app', ?)
    `);

    for (const r of recipients) {
      if (r.id === actor?.id) continue;
      try { ins.run(r.id, title, body, linkUrl, `${dedupeKey}:${r.id}`); } catch (_) {}
    }

    if (recipients.length > 0) {
      try {
        const { notifyMany } = require('../lib/push');
        notifyMany(recipients.map(r => r.id), {
          title: `🏁 ${title}`,
          body,
          url: linkUrl,
        });
      } catch (_) {}
    }

    try {
      const { getIO } = require('../lib/chatSocket');
      const io = getIO();
      if (io) io.emit('notification:new', { type: 'handover_snags', title, body, url: linkUrl });
    } catch (_) {}
  } catch (e) {
    console.warn('[handover-snags] notifyHandoverSOP failed:', e.message);
  }
}

// ─── RACI Routes ───────────────────────────────────────────────────────
// View RACI: Anyone with view permissions on snags or project_dashboard
router.get('/raci', (req, res) => {
  const db = getDb();
  res.json(getHandoverRaci(db));
});

// Edit RACI: STRICTLY ADMIN ONLY
router.put('/raci', (req, res) => {
  if (req.user?.role !== 'admin') {
    return res.status(403).json({ error: 'Only administrators can modify SOP-15 RACI role delegations' });
  }
  const db = getDb();
  const assignments = req.body.assignments || {};
  const toSave = {};

  for (const [key, val] of Object.entries(assignments)) {
    if (DEFAULT_SOP15_RACI[key]) {
      toSave[key] = {
        user_id: val.user_id ? Number(val.user_id) : null,
        custom_name: val.custom_name ? String(val.custom_name).trim() : null,
      };
    }
  }

  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at)
    VALUES ('sop15_handover_raci', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).run(JSON.stringify(toSave));

  logAuditEvent({
    user: req.user,
    action: 'HANDOVER_RACI_UPDATED',
    entity_type: 'handover_snags',
    entity_id: 0,
    entity_label: 'SOP-15 RACI Roles',
    after: toSave,
  });

  res.json(getHandoverRaci(db));
});

// ─── GET /site-status/:site_id — Comprehensive Site Handover Status ─────
router.get('/site-status/:site_id', (req, res) => {
  try {
    const db = getDb();
    const siteId = Number(req.params.site_id);
    const site = db.prepare(`
      SELECT s.*, 
             u.name AS cost_locked_by_name,
             se.name AS site_engineer_name
        FROM sites s
        LEFT JOIN users u ON u.id = s.cost_locked_by
        LEFT JOIN users se ON se.id = s.site_engineer_id
       WHERE s.id = ?
    `).get(siteId);

    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Snag counts
    const snags = db.prepare(`
      SELECT id, snag_no, description, location, priority, status, 
             raised_at, target_date, photo_url, proof_url,
             is_client_walk, walk_date, client_verified, client_verified_at, client_verified_by_name,
             escalation_level
        FROM snags
       WHERE site_id = ?
       ORDER BY id DESC
    `).all(siteId);

    const totalSnags = snags.length;
    const closedSnags = snags.filter(s => s.status === 'approved').length;
    const openSnags = totalSnags - closedSnags;
    const clientWalkSnags = snags.filter(s => s.is_client_walk === 1).length;
    const clientVerifiedSnags = snags.filter(s => s.client_verified === 1).length;

    // Check if certificate exists
    let certificate = null;
    if (site.handover_cert_id) {
      certificate = db.prepare('SELECT * FROM handover_certificates WHERE id=?').get(site.handover_cert_id);
    } else {
      certificate = db.prepare('SELECT * FROM handover_certificates WHERE site_id=? ORDER BY id DESC LIMIT 1').get(siteId);
    }

    // Determine current SOP-15 stage index
    let currentStage = site.handover_stage || 's0_in_progress';
    if (certificate && certificate.status === 'signed') currentStage = 's6_closed';
    else if (certificate && certificate.status === 'draft') currentStage = 's5_cert_ready';
    else if (totalSnags > 0 && openSnags === 0 && clientVerifiedSnags > 0) currentStage = 's4_snags_cleared';
    else if (totalSnags > 0) currentStage = 's3_snags_active';
    else if (site.client_walk_date) currentStage = 's2_snag_walk';
    else if (site.cost_locked === 1 || site.work_completed_100 === 1) currentStage = 's1_work_100';

    res.json({
      site: {
        ...site,
        handover_stage: currentStage,
      },
      snags_summary: {
        total: totalSnags,
        closed: closedSnags,
        open: openSnags,
        client_walk: clientWalkSnags,
        client_verified: clientVerifiedSnags,
      },
      snags,
      certificate,
      raci: getHandoverRaci(db).raci,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S1: Start Handover & Enforce Cost Lock ────────────────────────────
router.post('/start-handover', (req, res) => {
  try {
    const db = getDb();
    const { site_id, notes } = req.body;
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });

    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    db.prepare(`
      UPDATE sites
         SET work_completed_100 = 1,
             work_completed_at = CURRENT_TIMESTAMP,
             cost_locked = 1,
             cost_locked_at = CURRENT_TIMESTAMP,
             cost_locked_by = ?,
             handover_stage = 's1_work_100'
       WHERE id = ?
    `).run(req.user.id, site_id);

    logAuditEvent({
      user: req.user,
      action: 'SOP15_HANDOVER_STARTED_S1',
      entity_type: 'sites',
      entity_id: site_id,
      entity_label: site.name,
      after: { work_completed_100: 1, cost_locked: 1, notes },
    });

    notifyHandoverSOP(db, site_id, 's1_cost_locked', req.user, {
      title: `SOP-15.1 · Handover Started (${site.name})`,
      body: `Work marked 100% complete and costs locked by ${req.user.name}. Schedule joint client snag walk (S2).`,
    });

    res.json({
      message: 'Work reached 100% — Handover process started and costs locked successfully (SOP-15.1)',
      site_id,
      cost_locked: 1,
      handover_stage: 's1_work_100',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S2: Record Joint Snag Walk with Client ────────────────────────────
router.post('/client-walk', (req, res) => {
  try {
    const db = getDb();
    const { site_id, walk_date, client_rep_name, client_rep_phone, notes, snag_ids } = req.body;
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });

    const site = db.prepare('SELECT * FROM sites WHERE id=?').get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    const todayDate = walk_date || new Date().toISOString().slice(0, 10);

    db.prepare(`
      UPDATE sites
         SET client_walk_date = ?,
             client_rep_name = ?,
             client_rep_phone = ?,
             handover_stage = 's2_snag_walk'
       WHERE id = ?
    `).run(todayDate, client_rep_name || null, client_rep_phone || null, site_id);

    // If specific existing snags were identified during walk, tag them
    if (Array.isArray(snag_ids) && snag_ids.length > 0) {
      const placeholders = snag_ids.map(() => '?').join(',');
      db.prepare(`
        UPDATE snags
           SET is_client_walk = 1,
               walk_date = ?
         WHERE id IN (${placeholders}) AND site_id = ?
      `).run(todayDate, ...snag_ids, site_id);
    }

    logAuditEvent({
      user: req.user,
      action: 'SOP15_CLIENT_WALK_RECORDED_S2',
      entity_type: 'sites',
      entity_id: site_id,
      entity_label: site.name,
      after: { walk_date: todayDate, client_rep_name, client_rep_phone, notes },
    });

    notifyHandoverSOP(db, site_id, 's2_walk_recorded', req.user, {
      title: `SOP-15.2 · Snag Walk Recorded (${site.name})`,
      body: `Joint client snag walk conducted on ${todayDate} with ${client_rep_name || 'Client'}. Snag clock active (S3).`,
    });

    res.json({
      message: 'Joint client snag walk recorded successfully (SOP-15.2)',
      site_id,
      walk_date: todayDate,
      handover_stage: 's2_snag_walk',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S3: Snag Clock & Escalations Query / Scanner ──────────────────────
router.get('/escalations', (req, res) => {
  try {
    const db = getDb();
    const siteId = req.query.site_id ? Number(req.query.site_id) : null;
    const today = new Date().toISOString().slice(0, 10);

    let query = `
      SELECT s.id, s.snag_no, s.site_id, s.site_name, s.description, s.location, s.priority,
             s.target_date, s.raised_at, s.status, s.assigned_to_name, s.is_client_walk,
             s.escalation_level, s.escalated_pm_at, s.escalated_head_at
        FROM snags s
       WHERE s.status != 'approved'
         AND s.target_date IS NOT NULL
         AND s.target_date < ?
    `;
    const params = [today];
    if (siteId) {
      query += ` AND s.site_id = ?`;
      params.push(siteId);
    }
    query += ` ORDER BY s.target_date ASC`;

    const overdueSnags = db.prepare(query).all(...params);

    const raciData = getHandoverRaci(db).raci;
    const pmName = raciData.s3_snag_clock?.assigned_name || raciData.sop_owner?.assigned_name || 'Adarsh Kumar (PM)';
    // Compute SLA overdue days and recommended escalation tier
    const enriched = overdueSnags.map(s => {
      const diffMs = Date.now() - new Date(s.target_date).getTime();
      const overdueDays = Math.max(1, Math.floor(diffMs / (1000 * 60 * 60 * 24)));
      // Rule: 1-3 days overdue -> Level 1 (PM), >3 days overdue -> Level 2 (Head)
      const targetLevel = overdueDays > 3 ? 2 : 1;
      return {
        ...s,
        overdue_days: overdueDays,
        days_overdue: overdueDays,
        target_escalation: targetLevel === 2 ? 'Project Head' : `Project Manager (${pmName})`,
        escalated_to: targetLevel === 2 ? 'Project Head' : `Project Manager (${pmName})`,
        urgency: targetLevel === 2 ? 'CRITICAL_HEAD' : 'HIGH_PM',
      };
    });

    res.json({
      overdue_count: enriched.length,
      escalations: enriched,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S4: Snag Resolution & Client Tick (No Email Chains) ───────────────
router.post('/client-tick/:id', (req, res) => {
  try {
    const db = getDb();
    const snagId = Number(req.params.id);
    const snag = db.prepare('SELECT * FROM snags WHERE id=?').get(snagId);
    if (!snag) return res.status(404).json({ error: 'Snag not found' });

    const raci = getHandoverRaci(db).raci;
    const coordinatorName = raci.s4_client_tick?.assigned_name || 'Lovely (CRM)';
    const verifierName = req.user?.name ? `${req.user.name} / ${coordinatorName}` : coordinatorName;

    // Tick the snag with client verification & mark approved/closed
    db.prepare(`
      UPDATE snags
         SET client_verified = 1,
             client_verified_at = CURRENT_TIMESTAMP,
             client_verified_by = ?,
             client_verified_by_name = ?,
             status = 'approved',
             approved_by = COALESCE(approved_by, ?),
             approved_at = COALESCE(approved_at, CURRENT_TIMESTAMP)
       WHERE id = ?
    `).run(req.user.id, verifierName, req.user.id, snagId);

    // Check if all snags for this site are now closed
    const openRemaining = db.prepare(`
      SELECT COUNT(*) AS c FROM snags WHERE site_id=? AND status != 'approved'
    `).get(snag.site_id)?.c || 0;

    if (openRemaining === 0) {
      db.prepare(`
        UPDATE sites SET handover_stage = 's4_snags_cleared' WHERE id = ?
      `).run(snag.site_id);

      notifyHandoverSOP(db, snag.site_id, 's4_snags_cleared', req.user, {
        title: `SOP-15.4 · All Snags Closed! (${snag.site_name || 'Site'})`,
        body: `100% of punch-list snags are resolved and client-ticked. Ready to issue Handover Certificate (S5).`,
      });
    }

    res.json({
      message: `Snag ${snag.snag_no} verified and client-ticked successfully (SOP-15.4)`,
      snag_id: snagId,
      client_verified: 1,
      open_remaining_on_site: openRemaining,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S5: Auto-Generate Handover Certificate (HC-YYYY-XXXX) ─────────────
router.post('/generate-certificate', (req, res) => {
  try {
    const db = getDb();
    const { site_id, handover_date, client_signatory, company_signatory, retention_pct, notes } = req.body;
    if (!site_id) return res.status(400).json({ error: 'site_id is required' });

    const site = db.prepare(`
      SELECT s.*, bb.project_name, bb.sale_amount_without_gst, bb.po_amount
        FROM sites s
        LEFT JOIN business_book bb ON bb.id = s.business_book_id
       WHERE s.id = ?
    `).get(site_id);
    if (!site) return res.status(404).json({ error: 'Site not found' });

    // Validate that all snags are closed
    const unclosed = db.prepare(`SELECT COUNT(*) AS c FROM snags WHERE site_id=? AND status != 'approved'`).get(site_id)?.c || 0;
    if (unclosed > 0) {
      return res.status(400).json({ error: `Cannot generate Handover Certificate: ${unclosed} snag(s) are still open. All snags must be closed first (SOP-15.5).` });
    }

    const totalSnagsCount = db.prepare(`SELECT COUNT(*) AS c FROM snags WHERE site_id=?`).get(site_id)?.c || 0;
    const certDate = handover_date || new Date().toISOString().slice(0, 10);

    // Calculate Retention Money
    const contractVal = Number(site.sale_amount_without_gst || site.po_amount || 0);
    const rPct = Number(retention_pct || 5.0);
    const retentionAmt = contractVal > 0 ? Math.round((contractVal * rPct) / 100) : 0;

    // Calculate Retention Due Date & Warranty End Date (12 months from handover)
    const dueDateObj = new Date(certDate);
    dueDateObj.setFullYear(dueDateObj.getFullYear() + 1);
    const warrantyEnd = dueDateObj.toISOString().slice(0, 10);

    const defaultCompanySignatory = raci.s5_handover_cert?.assigned_name || (raci.sop_owner?.assigned_name ? `${raci.sop_owner.assigned_name} / Lovely (CRM)` : 'Adarsh Kumar (PM) / Lovely (CRM)');

    // Generate sequential certificate number HC-YYYY-XXXX
    const certNum = nextSequence(db, 'handover_certificates', 'certificate_number', 'HC-', { pad: 4 });

    const r = db.prepare(`
      INSERT INTO handover_certificates (
        site_id, project_name, client_name, certificate_number, handover_date,
        client_signatory, company_signatory, notes, snags_total, snags_closed,
        retention_pct, retention_amount, retention_due_date, retention_status,
        warranty_start_date, warranty_end_date, warranty_months,
        generated_by, generated_by_name, status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')
    `).run(
      site_id,
      site.project_name || site.name,
      site.client_name || 'Valued Client',
      certNum,
      certDate,
      client_signatory || site.client_rep_name || 'Client Authorized Representative',
      company_signatory || defaultCompanySignatory,
      notes || 'Handover certificate generated upon 100% snag rectification under SOP-15.5.',
      totalSnagsCount,
      totalSnagsCount,
      rPct,
      retentionAmt,
      warrantyEnd,
      'pending',
      certDate,
      warrantyEnd,
      12,
      req.user.id,
      req.user.name
    );

    const certId = r.lastInsertRowid;

    // Link certificate to site and transition stage
    db.prepare(`
      UPDATE sites
         SET handover_cert_id = ?,
             handover_stage = 's5_cert_ready'
       WHERE id = ?
    `).run(certId, site_id);

    logAuditEvent({
      user: req.user,
      action: 'SOP15_CERTIFICATE_GENERATED_S5',
      entity_type: 'handover_certificates',
      entity_id: certId,
      entity_label: certNum,
      after: { certificate_number: certNum, site_id, retention_amount: retentionAmt, warranty_end: warrantyEnd },
    });

    notifyHandoverSOP(db, site_id, 's5_cert_ready', req.user, {
      title: `SOP-15.5 · Handover Certificate Generated (${certNum})`,
      body: `Certificate ${certNum} generated for ${site.name}. Ready for client signature and final bill initiation.`,
    });

    res.status(201).json({
      message: 'Handover Certificate generated successfully (SOP-15.5)',
      certificate_id: certId,
      certificate_number: certNum,
      handover_stage: 's5_cert_ready',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── S6: Sign Handover & Trigger Retention / Warranty ──────────────────
router.post('/sign-handover', (req, res) => {
  try {
    const db = getDb();
    const { cert_id, signed_date, signed_file_url, notes } = req.body;
    if (!cert_id) return res.status(400).json({ error: 'cert_id is required' });

    const cert = db.prepare('SELECT * FROM handover_certificates WHERE id=?').get(cert_id);
    if (!cert) return res.status(404).json({ error: 'Certificate not found' });

    const signDate = signed_date || new Date().toISOString().slice(0, 10);

    db.prepare(`
      UPDATE handover_certificates
         SET status = 'signed',
             signed_date = ?,
             signed_file_url = ?,
             final_bill_triggered = 1,
             final_bill_triggered_at = CURRENT_TIMESTAMP
       WHERE id = ?
    `).run(signDate, signed_file_url || null, cert_id);

    // Update site stage to closed & status to completed
    if (cert.site_id) {
      db.prepare(`
        UPDATE sites
           SET handover_stage = 's6_closed',
               status = 'completed'
         WHERE id = ?
      `).run(cert.site_id);
    }

    logAuditEvent({
      user: req.user,
      action: 'SOP15_HANDOVER_SIGNED_S6',
      entity_type: 'handover_certificates',
      entity_id: cert_id,
      entity_label: cert.certificate_number,
      after: { signed_date: signDate, final_bill_triggered: 1, retention_due_date: cert.retention_due_date },
    });

    if (cert.site_id) {
      notifyHandoverSOP(db, cert.site_id, 's6_closed', req.user, {
        title: `SOP-15.6 · Project Handover Completed (${cert.certificate_number})`,
        body: `Signed certificate received. Final bill, retention release calendar, and warranty period activated!`,
      });
    }

    res.json({
      message: 'Signed handover processed — Final Bill, Retention Schedule, and Warranty Period initiated (SOP-15.6)',
      certificate_id: cert_id,
      certificate_number: cert.certificate_number,
      retention_amount: cert.retention_amount,
      retention_due_date: cert.retention_due_date,
      warranty_end_date: cert.warranty_end_date,
      handover_stage: 's6_closed',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /certificate/:id — Print / View Certificate ───────────────────
router.get('/certificate/:id', (req, res) => {
  try {
    const db = getDb();
    const cert = db.prepare(`
      SELECT hc.*, s.name AS site_name, s.address AS site_address,
             bb.client_name AS bb_client, bb.lead_no, bb.committed_delivery_date
        FROM handover_certificates hc
        LEFT JOIN sites s ON s.id = hc.site_id
        LEFT JOIN business_book bb ON bb.id = s.business_book_id
       WHERE hc.id = ?
    `).get(req.params.id);

    if (!cert) return res.status(404).json({ error: 'Certificate not found' });
    res.json(cert);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
