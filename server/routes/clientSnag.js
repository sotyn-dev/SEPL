// Client Snag — a client-facing snag (e.g. a bill that came back without
// the client's signature), raised against a client / site much like the
// generic 'snags' module.
//
// Two identity-gated actions, NOT ordinary role permissions:
//   upload snag photo      — ONLY the resolved 'uploader' (Ajmer)
//   approve / reject       — ONLY the resolved 'approver' (Lovely Sharma)
// Both gates live in client_snag_gate_users (server/db/schema.js). If a role
// has no row there yet, the resolver falls back to a case-insensitive name
// match — same reasoning as the existing PO_APPROVERS / indent-to-dispatch
// precedent (server/routes/procurement.js, server/db/indentToDispatchSchema.js):
// nothing breaks before an admin sets the real row via PUT /settings/gate,
// and once set, the table always wins over the name fallback. Admin bypasses
// both gates everywhere, same as every other gate in this codebase.
//
// Ordinary CRUD (view/create/edit/delete) uses the normal
// requirePermission('client_snag', ...) role-permission system — only the
// two actions above are hardcoded to a specific person.
//
// Status flow:
//   awaiting_document → pending_approval → approved (locked)
//                                        → rejected → (Ajmer re-uploads) → awaiting_document

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { nextSequence } = require('../db/nextSequence');
const router = express.Router();
router.use(authMiddleware);

const LEGACY_NAMES = { uploader: 'Ajmer', approver: 'Lovely Sharma' };

function resolveByName(db, name) {
  return db.prepare(`SELECT id, name FROM users WHERE COALESCE(active,1)=1 AND LOWER(TRIM(name))=LOWER(TRIM(?))`).get(name)
    || db.prepare(`SELECT id, name FROM users WHERE COALESCE(active,1)=1 AND LOWER(name) LIKE LOWER(?) ORDER BY id LIMIT 1`).get(`%${name}%`);
}

// The user_id currently seated in a gate role — the admin-set row if one
// exists, otherwise the legacy name fallback. Never throws; returns null if
// neither resolves (e.g. the person hasn't been given an account yet).
function gateUserId(db, roleKey) {
  const row = db.prepare('SELECT user_id FROM client_snag_gate_users WHERE role_key=?').get(roleKey);
  if (row) return row.user_id;
  return resolveByName(db, LEGACY_NAMES[roleKey])?.id || null;
}

const isUploader = (db, user) => user.role === 'admin' || user.id === gateUserId(db, 'uploader');
const isApprover = (db, user) => user.role === 'admin' || user.id === gateUserId(db, 'approver');

function logStatus(db, clientSnagId, action, userId, fromStatus, toStatus, note) {
  db.prepare(`
    INSERT INTO client_snag_status_log (client_snag_id, action, user_id, from_status, to_status, note)
    VALUES (?,?,?,?,?,?)
  `).run(clientSnagId, action, userId || null, fromStatus || null, toStatus || null, note || null);
}

// Shared filtered-list query builder supporting full server-side filtering, searching, pagination, and sorting.
function buildListQuery(req) {
  const {
    status, priority, client, assigned_to, site, date, search,
    snag_type, scope_category, civilScopeType, floor_zone, floor,
    fms_stage, stage, site_id,
    sortBy, sortOrder,
  } = req.query || {};

  const typeVal = snag_type || null;
  const scopeVal = civilScopeType || scope_category || null;
  const floorVal = floor || floor_zone || null;
  const stageVal = stage || fms_stage || null;

  let where = 'WHERE 1=1';
  const params = [];

  if (typeVal) {
    where += ' AND COALESCE(cs.snag_type, \'billing_doc\') = ?';
    params.push(typeVal);
  }
  if (scopeVal) {
    where += ' AND cs.scope_category = ?';
    params.push(scopeVal);
  }
  if (floorVal) {
    where += ' AND cs.floor_zone = ?';
    params.push(floorVal);
  }
  if (site_id) {
    where += ' AND (cs.site_id = ? OR cs.site_name = ?)';
    params.push(site_id, site_id);
  }
  if (status) {
    where += ' AND cs.status = ?';
    params.push(status);
  }
  if (priority) {
    where += ' AND cs.priority = ?';
    params.push(priority);
  }
  if (client) {
    where += ' AND cs.client_name LIKE ?';
    params.push(`%${client}%`);
  }
  if (assigned_to) {
    where += ' AND cs.assigned_to = ?';
    params.push(assigned_to);
  }
  if (site) {
    where += ' AND (cs.site_name LIKE ? OR cs.location LIKE ? OR cs.site_id = ?)';
    params.push(`%${site}%`, `%${site}%`, site);
  }
  if (date) {
    where += ' AND date(cs.raised_at) = date(?)';
    params.push(date);
  }
  if (stageVal) {
    if (stageVal === 'overdue') {
      where += " AND cs.fms_stage != 'cleared' AND cs.client_promised_date IS NOT NULL AND date(cs.client_promised_date) < date('now', 'localtime')";
    } else {
      where += ' AND cs.fms_stage = ?';
      params.push(stageVal);
    }
  }
  if (search) {
    where += ` AND (
      cs.description LIKE ? OR
      cs.snag_no LIKE ? OR
      cs.client_name LIKE ? OR
      cs.site_name LIKE ? OR
      cs.scope_category LIKE ? OR
      cs.floor_zone LIKE ? OR
      cs.location LIKE ? OR
      at.name LIKE ?
    )`;
    const q = `%${search}%`;
    params.push(q, q, q, q, q, q, q, q);
  }

  const baseFrom = `
    FROM client_snags cs
    LEFT JOIN users at ON at.id = cs.assigned_to
    LEFT JOIN users up ON up.id = cs.uploaded_by
    LEFT JOIN users ap ON ap.id = cs.approved_by
    LEFT JOIN users rj ON rj.id = cs.rejected_by
    LEFT JOIN users rb ON rb.id = cs.raised_by
    LEFT JOIN users cb ON cb.id = cs.cleared_by
    LEFT JOIN sites s ON s.id = cs.site_id
  `;

  const selectFields = `
    SELECT cs.*,
           at.name as assigned_to_user_name,
           up.name as uploaded_by_name,
           ap.name as approved_by_name,
           rj.name as rejected_by_name,
           rb.name as raised_by_name,
           cb.name as cleared_by_name,
           s.name as site_master_name,
           CASE 
             WHEN cs.fms_stage != 'cleared' AND cs.client_promised_date IS NOT NULL AND date('now', 'localtime') > date(cs.client_promised_date)
             THEN CAST(julianday('now', 'localtime') - julianday(cs.client_promised_date) AS INT)
             ELSE 0
           END AS days_overdue
  `;

  const countSql = `SELECT COUNT(*) as c ${baseFrom} ${where}`;

  const sortMap = {
    snag_no: 'cs.snag_no',
    client_name: 'cs.client_name',
    site_name: 'cs.site_name',
    floor_zone: 'cs.floor_zone',
    scope_category: 'cs.scope_category',
    client_promised_date: 'cs.client_promised_date',
    fms_stage: 'cs.fms_stage',
    raised_at: 'cs.raised_at',
    priority: `CASE cs.priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END`,
    status: `CASE cs.status WHEN 'pending_approval' THEN 0 WHEN 'awaiting_document' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END`,
    days_overdue: `CASE WHEN cs.fms_stage != 'cleared' AND cs.client_promised_date IS NOT NULL AND date('now', 'localtime') > date(cs.client_promised_date) THEN CAST(julianday('now', 'localtime') - julianday(cs.client_promised_date) AS INT) ELSE 0 END`,
  };

  const validSort = sortBy && sortMap[sortBy];
  const orderDir = String(sortOrder).toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  let orderClause = '';
  if (validSort) {
    orderClause = `ORDER BY ${validSort} ${orderDir}, cs.id DESC`;
  } else {
    orderClause = `ORDER BY
      CASE WHEN cs.snag_type = 'site_readiness' THEN
        CASE WHEN cs.fms_stage = 'cleared' THEN 2 
             WHEN cs.client_promised_date IS NOT NULL AND date(cs.client_promised_date) < date('now', 'localtime') THEN 0 
             ELSE 1 END
      ELSE
        CASE cs.status WHEN 'pending_approval' THEN 0 WHEN 'awaiting_document' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END
      END,
      cs.raised_at DESC`;
  }

  const selectSql = `${selectFields} ${baseFrom} ${where} ${orderClause}`;

  return { selectSql, countSql, where, params, baseFrom, selectFields, orderClause };
}

// LIST — returns server-side filtered, paginated & counted dataset along with dashboard counters.
router.get('/', requirePermission('client_snag', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { selectSql, countSql, params } = buildListQuery(req);

    // Total count matching current filters
    const total = db.prepare(countSql).get(...params).c;

    // Pagination
    const isAll = String(req.query.limit).toLowerCase() === 'all';
    const limit = isAll ? Math.max(total, 1) : Math.max(1, Math.min(1000, parseInt(req.query.limit, 10) || 15));
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const offset = (page - 1) * limit;
    const pages = Math.max(1, Math.ceil(total / limit));
    const from = total === 0 ? 0 : offset;
    const to = Math.min(offset + limit, total);

    const rows = db.prepare(`${selectSql} LIMIT ? OFFSET ?`).all(...params, limit, offset);

    // Dashboard metrics (summary counts)
    const countMetric = (where, p = []) => db.prepare(`SELECT COUNT(*) as c FROM client_snags WHERE ${where}`).get(...p).c;
    const counters = {
      // Legacy Billing Doc Snags
      awaiting_document: countMetric(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='awaiting_document'`),
      pending_approval: countMetric(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='pending_approval'`),
      approved: countMetric(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='approved'`),
      rejected: countMetric(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='rejected'`),
      is_uploader: isUploader(db, req.user),
      is_approver: isApprover(db, req.user),

      // Site Readiness FMS Metrics
      sr_total_open: countMetric(`snag_type='site_readiness' AND fms_stage != 'cleared'`),
      sr_plaster: countMetric(`snag_type='site_readiness' AND fms_stage != 'cleared' AND scope_category LIKE '%Plaster%'`),
      sr_tiles: countMetric(`snag_type='site_readiness' AND fms_stage != 'cleared' AND scope_category LIKE '%Til%'`),
      sr_overdue: countMetric(`snag_type='site_readiness' AND fms_stage != 'cleared' AND client_promised_date IS NOT NULL AND date(client_promised_date) < date('now', 'localtime')`),
      sr_cleared: countMetric(`snag_type='site_readiness' AND fms_stage = 'cleared'`),
    };

    res.json({
      rows,
      total,
      page,
      limit: isAll ? 'all' : limit,
      pages,
      from,
      to,
      counters,
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SITES — helper for the Site picker in Site Readiness
router.get('/sites', requirePermission('client_snag', 'view'), (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare(`
      SELECT s.id, s.name, s.client_name, s.address, bb.company_name
        FROM sites s
        LEFT JOIN business_book bb ON bb.id = s.business_book_id
       WHERE COALESCE(s.status, 'active') = 'active'
       ORDER BY s.name ASC
    `).all();
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// COUNTERS — role-scoped dashboard cards for both Site Readiness FMS & Billing Snags.
router.get('/counters', requirePermission('client_snag', 'view'), (req, res) => {
  try {
    const db = getDb();
    const count = (where, params = []) => db.prepare(`SELECT COUNT(*) as c FROM client_snags WHERE ${where}`).get(...params).c;
    res.json({
      // Legacy Billing Doc Snags
      awaiting_document: count(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='awaiting_document'`),
      pending_approval: count(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='pending_approval'`),
      approved: count(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='approved'`),
      rejected: count(`COALESCE(snag_type, 'billing_doc')='billing_doc' AND status='rejected'`),
      is_uploader: isUploader(db, req.user),
      is_approver: isApprover(db, req.user),

      // Site Readiness FMS Metrics
      sr_total_open: count(`snag_type='site_readiness' AND fms_stage != 'cleared'`),
      sr_plaster: count(`snag_type='site_readiness' AND fms_stage != 'cleared' AND scope_category LIKE '%Plaster%'`),
      sr_tiles: count(`snag_type='site_readiness' AND fms_stage != 'cleared' AND scope_category LIKE '%Til%'`),
      sr_overdue: count(`snag_type='site_readiness' AND fms_stage != 'cleared' AND client_promised_date IS NOT NULL AND date(client_promised_date) < date('now', 'localtime')`),
      sr_cleared: count(`snag_type='site_readiness' AND fms_stage = 'cleared'`),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// DETAIL — includes the status timeline and what THIS user may do.
router.get('/:id', requirePermission('client_snag', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { selectFields, baseFrom } = buildListQuery({ query: {} });
    const cs = db.prepare(`${selectFields} ${baseFrom} WHERE cs.id = ?`).get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });
    const history = db.prepare(`
      SELECT l.*, u.name as user_name FROM client_snag_status_log l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.client_snag_id = ? ORDER BY l.created_at ASC, l.id ASC
    `).all(req.params.id);
    res.json({
      ...cs,
      history,
      can_upload: isUploader(db, req.user) && cs.status !== 'approved',
      can_approve_this: isApprover(db, req.user) && cs.status === 'pending_approval',
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// CREATE — raises a Client Snag or Site Readiness Item.
router.post('/', requirePermission('client_snag', 'create'), (req, res) => {
  try {
    const b = req.body;
    const snagType = b.snag_type || 'site_readiness';

    if (snagType === 'site_readiness') {
      const required = [
        ['client_name', 'Client'], ['site_name', 'Site Name'],
        ['scope_category', 'Civil Scope Category'], ['floor_zone', 'Floor / Zone'],
        ['description', 'Description'], ['before_photo_url', 'Before Photo'],
      ];
      for (const [field, label] of required) {
        if (!b[field] || !String(b[field]).trim()) return res.status(400).json({ error: `${label} is required` });
      }
    } else {
      const required = [
        ['client_name', 'Client'], ['assigned_to', 'Assign To'], ['site_name', 'Site Name'],
        ['location', 'Location'], ['description', 'Description'], ['before_photo_url', 'Before Photo'],
      ];
      for (const [field, label] of required) {
        if (!b[field] || !String(b[field]).trim()) return res.status(400).json({ error: `${label} is required` });
      }
    }

    const priority = ['low', 'medium', 'high', 'critical'].includes(b.priority) ? b.priority : 'medium';
    const db = getDb();

    let assigneeName = b.assigned_to_name || null;
    if (!assigneeName && b.assigned_to) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(b.assigned_to);
      assigneeName = u?.name || null;
    }

    const yr = new Date().getFullYear();
    const prefix = snagType === 'site_readiness' ? `SR-${yr}-` : `CS-${yr}-`;
    const snagNo = nextSequence(db, 'client_snags', 'snag_no', prefix, { startFrom: 0, pad: 4 });

    const fmsStage = b.client_promised_date ? 'intimated' : 'reported';
    const status = 'awaiting_document';

    const r = db.prepare(`
      INSERT INTO client_snags (
        snag_no, snag_type, client_name, assigned_to, assigned_to_name, site_name, site_id,
        location, floor_zone, scope_category, description, priority, before_photo_url,
        client_promised_date, client_contact_person, client_contact_phone,
        fms_stage, status, raised_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      snagNo, snagType, b.client_name || null, b.assigned_to || null, assigneeName,
      b.site_name || null, b.site_id || null, b.location || null, b.floor_zone || null,
      b.scope_category || null, b.description, priority, b.before_photo_url || null,
      b.client_promised_date || null, b.client_contact_person || null, b.client_contact_phone || null,
      fmsStage, status, req.user.id
    );

    const logNote = snagType === 'site_readiness'
      ? `Civil Scope: ${b.scope_category} on ${b.floor_zone}`
      : null;
    logStatus(db, r.lastInsertRowid, 'CREATED', req.user.id, null, status, logNote);
    logAuditEvent({
      user: req.user, action: 'CREATE', entity_type: 'client_snag', entity_id: r.lastInsertRowid,
      entity_label: snagNo, method: 'POST', path: '/api/client-snag', body: b,
    });

    res.status(201).json({ id: r.lastInsertRowid, snag_no: snagNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// UPLOAD / REPLACE SNAG PHOTO — Ajmer (the resolved 'uploader') only. The
// file itself is uploaded via the shared POST /api/upload first; this just
// attaches the returned URL. Locked once approved; while pending_approval,
// use /reject to send it back before it can be replaced (spec: "Ajmer can
// replace the photo only while the Client Snag is still awaiting
// photo/submission").
router.post('/:id/document', (req, res) => {
  try {
    const { photo_url } = req.body;
    if (!photo_url) return res.status(400).json({ error: 'photo_url is required' });
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });
    if (!isUploader(db, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to upload the Client Snag photo.' });
    }
    if (!['awaiting_document', 'rejected'].includes(cs.status)) {
      return res.status(400).json({ error: 'Photo is locked while pending approval or after approval.' });
    }

    const wasRejected = cs.status === 'rejected';
    db.prepare(`
      UPDATE client_snags
         SET photo_url=?, uploaded_by=?, uploaded_at=CURRENT_TIMESTAMP,
             status='awaiting_document', rejection_reason=NULL, rejected_at=NULL, rejected_by=NULL
       WHERE id=?
    `).run(photo_url, req.user.id, req.params.id);
    logStatus(db, cs.id, wasRejected ? 'RESUBMITTED' : 'DOCUMENT_UPLOADED', req.user.id, cs.status, 'awaiting_document', null);

    res.json({ message: 'Uploaded' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUBMIT FOR APPROVAL — Ajmer only; requires a photo already uploaded.
router.post('/:id/submit', (req, res) => {
  try {
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });
    if (!isUploader(db, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to submit this Client Snag.' });
    }
    if (!cs.photo_url) return res.status(400).json({ error: 'Upload the snag photo before submitting for approval.' });
    if (cs.status !== 'awaiting_document') return res.status(400).json({ error: 'Already submitted or decided.' });

    db.prepare(`UPDATE client_snags SET status='pending_approval', submitted_at=CURRENT_TIMESTAMP WHERE id=?`).run(cs.id);
    logStatus(db, cs.id, 'SUBMITTED', req.user.id, 'awaiting_document', 'pending_approval', null);

    try {
      const { notifyMany } = require('../lib/push');
      const approverId = gateUserId(db, 'approver');
      if (approverId && approverId !== req.user.id) {
        notifyMany([approverId], {
          title: `📋 ${cs.snag_no} — pending your approval`,
          body: `${cs.client_name ? cs.client_name + ' · ' : ''}${cs.site_name || ''} · ${String(cs.description || '').slice(0, 80)}`,
          url: '/client-snag',
          tag: `client-snag-${cs.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Submitted for approval' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// APPROVE — Lovely Sharma (the resolved 'approver') only.
router.post('/:id/approve', (req, res) => {
  try {
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });
    if (!isApprover(db, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to approve this Client Snag.' });
    }
    if (cs.status !== 'pending_approval') return res.status(400).json({ error: 'Nothing pending approval on this Client Snag.' });

    db.prepare(`UPDATE client_snags SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.user.id, cs.id);
    logStatus(db, cs.id, 'APPROVED', req.user.id, 'pending_approval', 'approved', null);
    logAuditEvent({
      user: req.user, action: 'APPROVE', entity_type: 'client_snag', entity_id: cs.id,
      entity_label: cs.snag_no, method: 'POST', path: `/api/client-snag/${cs.id}/approve`,
    });

    try {
      const { notifyMany } = require('../lib/push');
      if (cs.uploaded_by && cs.uploaded_by !== req.user.id) {
        notifyMany([cs.uploaded_by], {
          title: `🎉 ${cs.snag_no} approved`,
          body: 'Client Snag closed — bill accepted.',
          url: '/client-snag',
          tag: `client-snag-${cs.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REJECT — Lovely Sharma only; reason is mandatory.
router.post('/:id/reject', (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Rejection reason is required.' });
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });
    if (!isApprover(db, req.user)) {
      return res.status(403).json({ error: 'You do not have permission to reject this Client Snag.' });
    }
    if (cs.status !== 'pending_approval') return res.status(400).json({ error: 'Nothing pending approval on this Client Snag.' });

    db.prepare(`
      UPDATE client_snags SET status='rejected', rejected_by=?, rejected_at=CURRENT_TIMESTAMP, rejection_reason=?
       WHERE id=?
    `).run(req.user.id, reason, cs.id);
    logStatus(db, cs.id, 'REJECTED', req.user.id, 'pending_approval', 'rejected', reason);
    logAuditEvent({
      user: req.user, action: 'REJECT', entity_type: 'client_snag', entity_id: cs.id,
      entity_label: cs.snag_no, method: 'POST', path: `/api/client-snag/${cs.id}/reject`, body: { reason },
    });

    try {
      const { notifyMany } = require('../lib/push');
      if (cs.uploaded_by && cs.uploaded_by !== req.user.id) {
        notifyMany([cs.uploaded_by], {
          title: `⚠️ ${cs.snag_no} — rejected`,
          body: String(reason).slice(0, 140),
          url: '/client-snag',
          tag: `client-snag-${cs.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Rejected — uploader can resubmit' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// INTIMATE TO CLIENT (Site Readiness FMS) — records when the client was
// formally notified, their promised completion date for the civil scope, and notes.
router.post('/:id/intimate', requirePermission('client_snag', 'edit'), (req, res) => {
  try {
    const { client_promised_date, client_contact_person, client_contact_phone, intimation_notes } = req.body;
    if (!client_promised_date) return res.status(400).json({ error: 'Client promised date is required' });
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });

    db.prepare(`
      UPDATE client_snags
         SET client_promised_date=?, client_contact_person=?, client_contact_phone=?,
             intimation_notes=?, fms_stage='intimated'
       WHERE id=?
    `).run(client_promised_date, client_contact_person || null, client_contact_phone || null, intimation_notes || null, req.params.id);

    logStatus(db, cs.id, 'INTIMATED_TO_CLIENT', req.user.id, cs.fms_stage, 'intimated',
      `Promised date: ${client_promised_date}${intimation_notes ? ' · ' + intimation_notes : ''}`.trim());
    logAuditEvent({
      user: req.user, action: 'INTIMATE_CLIENT', entity_type: 'client_snag', entity_id: cs.id,
      entity_label: cs.snag_no, method: 'POST', path: `/api/client-snag/${cs.id}/intimate`, body: req.body,
    });

    res.json({ message: 'Client intimation recorded' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// MARK CIVIL WORK CLEARED (Site Readiness FMS) — uploads the verification photo
// showing the finished plaster/tiles and marks the item cleared.
router.post('/:id/clear', requirePermission('client_snag', 'edit'), (req, res) => {
  try {
    const { cleared_photo_url, notes } = req.body;
    if (!cleared_photo_url) return res.status(400).json({ error: 'Clearance verification photo is required' });
    const db = getDb();
    const cs = db.prepare('SELECT * FROM client_snags WHERE id=?').get(req.params.id);
    if (!cs) return res.status(404).json({ error: 'Not found' });

    db.prepare(`
      UPDATE client_snags
         SET cleared_photo_url=?, cleared_at=CURRENT_TIMESTAMP, cleared_by=?,
             fms_stage='cleared', status='approved'
       WHERE id=?
    `).run(cleared_photo_url, req.user.id, req.params.id);

    logStatus(db, cs.id, 'CIVIL_WORK_CLEARED', req.user.id, cs.fms_stage, 'cleared', notes || 'Civil scope verified ready for installation');
    logAuditEvent({
      user: req.user, action: 'CLEAR_CIVIL_SCOPE', entity_type: 'client_snag', entity_id: cs.id,
      entity_label: cs.snag_no, method: 'POST', path: `/api/client-snag/${cs.id}/clear`, body: req.body,
    });

    res.json({ message: 'Civil scope marked as cleared' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('client_snag', 'delete'), (req, res) => {
  try {
    getDb().prepare('DELETE FROM client_snags WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Gate settings (admin only) — reassign 'uploader'/'approver' without a
// redeploy. Returns both the raw table rows and the currently-effective
// resolution (table row, else name fallback) so the UI can show who's
// actually seated even before an admin ever sets anything explicitly.
router.get('/settings/gate', adminOnly, (req, res) => {
  try {
    const db = getDb();
    const effective = {};
    for (const roleKey of ['uploader', 'approver']) {
      const id = gateUserId(db, roleKey);
      const u = id ? db.prepare('SELECT id, name FROM users WHERE id=?').get(id) : null;
      const explicit = db.prepare('SELECT user_id FROM client_snag_gate_users WHERE role_key=?').get(roleKey);
      effective[roleKey] = { user_id: u?.id || null, user_name: u?.name || null, source: explicit ? 'configured' : 'name_fallback' };
    }
    res.json(effective);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.put('/settings/gate', adminOnly, (req, res) => {
  try {
    const { role_key, user_id } = req.body;
    if (!['uploader', 'approver'].includes(role_key)) return res.status(400).json({ error: 'role_key must be uploader or approver' });
    if (!user_id) return res.status(400).json({ error: 'user_id is required' });
    const db = getDb();
    const u = db.prepare('SELECT id, name FROM users WHERE id=?').get(user_id);
    if (!u) return res.status(404).json({ error: 'User not found' });

    db.prepare(`
      INSERT INTO client_snag_gate_users (role_key, user_id, updated_by) VALUES (?,?,?)
      ON CONFLICT(role_key) DO UPDATE SET user_id=excluded.user_id, updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by
    `).run(role_key, user_id, req.user.id);
    logAuditEvent({
      user: req.user, action: 'UPDATE', entity_type: 'client_snag_gate', entity_id: role_key,
      entity_label: `${role_key} -> ${u.name}`, method: 'PUT', path: '/api/client-snag/settings/gate', body: { role_key, user_id },
    });

    res.json({ message: `${role_key} set to ${u.name}` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
