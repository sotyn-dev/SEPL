// CRM Full Kitting — mam (2026-05-21):
// "3 stages of crm full kitting of project which i need in erp.
//  drop down is :- Yes, No, Partially, N/A with upload photo of every
//  points.  and this also happen today upload photo after 5 days also
//  can upload photo but we see prvious history photo also".
//
// Data model:
//   crm_kitting_checkpoint   master list of checkpoints, grouped by
//                            stage_no (1..3).  Editable by admin.
//   crm_kitting_entry        append-only history — every dropdown
//                            change + photo upload creates a new
//                            row.  The "current" status is the most
//                            recent row per (project_id, checkpoint_id).
//
// Endpoints:
//   GET    /api/crm-kitting/checkpoints                  list master
//   POST   /api/crm-kitting/checkpoints                  add (admin)
//   PUT    /api/crm-kitting/checkpoints/:id              edit (admin)
//   DELETE /api/crm-kitting/checkpoints/:id              soft-delete
//   GET    /api/crm-kitting/projects                     BB-derived project list
//   GET    /api/crm-kitting/project/:projectId           checkpoints + latest entry
//   POST   /api/crm-kitting/project/:projectId/entry     new entry (multipart for photo)
//   GET    /api/crm-kitting/project/:projectId/checkpoint/:cpId/history
//
// 5-day late uploads:  mam wants someone in the field to be able to
// upload yesterday's / 5-days-ago's photo with a back-dated
// observation_date.  We accept any observation_date <= today and
// >= today-5d (configurable via UPLOAD_BACK_DAYS).  uploaded_at is
// always now() — that's the audit timestamp.  observation_date is
// what the user is *claiming* the photo was taken on.

const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');

const router = express.Router();
router.use(authMiddleware);

const UPLOAD_BACK_DAYS = 5;

// Photo uploads
const photoDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'crm-kitting');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });
const photoUpload = multer({
  storage: multer.diskStorage({
    destination: photoDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '.jpg');
      cb(null, `kit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024 },  // 10 MB
});

// ── Idempotent schema migration ────────────────────────────────
try {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_kitting_checkpoint (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage_no INTEGER NOT NULL CHECK(stage_no IN (1,2,3)),
      sort_order INTEGER NOT NULL DEFAULT 0,
      label TEXT NOT NULL,
      description TEXT,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kit_cp_stage ON crm_kitting_checkpoint(stage_no, sort_order)`);

  // Entries are keyed by `project_key` (= business_book.company_name)
  // to match Cash Flow's grouping convention.  mam (2026-05-21):
  // "project name accordially pick from business book like cash flow
  // example".  A project in Cash Flow = unique bb.company_name.  Same
  // company_name can have many BB rows (multiple POs / milestones);
  // they all share one set of kitting checkpoints here.
  db.exec(`
    CREATE TABLE IF NOT EXISTS crm_kitting_entry (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_key TEXT NOT NULL,
      checkpoint_id INTEGER NOT NULL REFERENCES crm_kitting_checkpoint(id) ON DELETE CASCADE,
      status TEXT NOT NULL CHECK(status IN ('yes','no','partially','na')),
      photo_path TEXT,
      remarks TEXT,
      observation_date DATE,
      uploaded_by INTEGER REFERENCES users(id),
      uploaded_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  // Defensive migration: earlier deploys of this module had a
  // `project_id INTEGER FK business_book(id)` column.  If we find that
  // shape, add the new project_key column + backfill from BB.
  try {
    const cols = db.prepare(`PRAGMA table_info(crm_kitting_entry)`).all();
    const hasKey = cols.find(c => c.name === 'project_key');
    const hasId  = cols.find(c => c.name === 'project_id');
    if (!hasKey) {
      db.exec(`ALTER TABLE crm_kitting_entry ADD COLUMN project_key TEXT`);
    }
    if (hasId) {
      db.exec(`
        UPDATE crm_kitting_entry
        SET project_key = (SELECT company_name FROM business_book WHERE id = crm_kitting_entry.project_id)
        WHERE project_key IS NULL OR project_key = ''
      `);
    }
  } catch (e) {
    console.warn('[crm_kitting] project_key migration skipped:', e.message);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_kit_entry_proj ON crm_kitting_entry(project_key, checkpoint_id, uploaded_at DESC)`);

  // Stage-name override (admin-editable like rental_tools stage labels)
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);

  // Idempotent default seed — only runs if checkpoint table is empty.
  // mam can edit/add/remove from the admin UI later.
  const cnt = db.prepare(`SELECT COUNT(*) c FROM crm_kitting_checkpoint`).get();
  if (cnt.c === 0) {
    const insert = db.prepare(`INSERT INTO crm_kitting_checkpoint (stage_no, sort_order, label, description) VALUES (?,?,?,?)`);
    // Defaults inferred from typical CRM full-kitting workflow.
    // Admin can rename via the Manage Checkpoints drawer.
    const seeds = [
      // Stage 1 — Pre-Production / Order Confirmation
      [1, 10, 'Sales Order signed & uploaded', 'PO / Work Order signed copy received'],
      [1, 20, 'BOQ / SITC items locked in ERP', 'All items + rates + quantities frozen in Order Planning'],
      [1, 30, 'Advance payment received', 'As per PO terms — advance receipt updated in Collections'],
      [1, 40, 'Site survey + drawings finalised', 'Engineer site visit done, final drawing approved by client'],
      [1, 50, 'Kick-off meeting with client', 'KOM minutes circulated, project manager assigned'],
      // Stage 2 — Production & Dispatch
      [2, 10, 'Raw material indent raised', 'Indent FMS entry created against this project'],
      [2, 20, 'Vendor POs released', 'All vendor POs released, expected delivery dates locked'],
      [2, 30, 'Material received & QC done', 'Material in inventory, QC sheet uploaded'],
      [2, 40, 'Production / Assembly complete', 'Tools / panels / racks assembled and tested'],
      [2, 50, 'Packaging + Pre-dispatch inspection', 'PDI photos taken, packing list signed'],
      [2, 60, 'Dispatch from factory', 'LR / transport docket attached'],
      // Stage 3 — Site Installation & Handover
      [3, 10, 'Material reached site', 'GRN signed by site team, unloading photo'],
      [3, 20, 'Installation in progress', 'Daily DPR entries linked to this project'],
      [3, 30, 'Commissioning & testing', 'Test report signed by client engineer'],
      [3, 40, 'Snag list closed', 'All Snags module entries marked closed'],
      [3, 50, 'Training / handover to client', 'Operating manual + handover note signed'],
      [3, 60, 'Final bill raised', 'Sales bill generated, sent to client'],
      [3, 70, 'Final payment received', 'Closure entry in Collections'],
    ];
    for (const s of seeds) insert.run(...s);
  }
} catch (e) {
  console.warn('[crm_kitting] schema init failed:', e.message);
}

// ── Helpers ────────────────────────────────────────────────────
const STATUSES = ['yes', 'no', 'partially', 'na'];

function isAdmin(req) {
  return !!(req.user && (req.user.is_admin || req.user.role === 'admin'));
}

// ── GET /api/crm-kitting/checkpoints ────────────────────────────
router.get('/checkpoints', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT id, stage_no, sort_order, label, description, is_active
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/crm-kitting/checkpoints ────────────────────────────
router.post('/checkpoints', requirePermission('crm_kitting', 'create'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const { stage_no, sort_order, label, description } = req.body || {};
  if (![1, 2, 3].includes(Number(stage_no))) return res.status(400).json({ error: 'stage_no must be 1/2/3' });
  if (!label || !String(label).trim()) return res.status(400).json({ error: 'label required' });
  const db = getDb();
  try {
    const r = db.prepare(`
      INSERT INTO crm_kitting_checkpoint (stage_no, sort_order, label, description)
      VALUES (?,?,?,?)
    `).run(Number(stage_no), Number(sort_order) || 0, String(label).trim(), description || null);
    logAuditEvent({
      user: req.user, action: 'CREATE', entity_type: 'crm_kitting_checkpoint',
      entity_id: r.lastInsertRowid, entity_label: label,
      method: 'POST', path: '/api/crm-kitting/checkpoints', body: { stage_no, label },
    });
    res.json({ id: r.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── PUT /api/crm-kitting/checkpoints/:id ────────────────────────
router.put('/checkpoints/:id', requirePermission('crm_kitting', 'edit'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const { stage_no, sort_order, label, description, is_active } = req.body || {};
  const db = getDb();
  try {
    const existing = db.prepare(`SELECT * FROM crm_kitting_checkpoint WHERE id=?`).get(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    db.prepare(`
      UPDATE crm_kitting_checkpoint
      SET stage_no = ?, sort_order = ?, label = ?, description = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      stage_no != null ? Number(stage_no) : existing.stage_no,
      sort_order != null ? Number(sort_order) : existing.sort_order,
      label != null ? String(label).trim() : existing.label,
      description !== undefined ? description : existing.description,
      is_active != null ? (is_active ? 1 : 0) : existing.is_active,
      id
    );
    logAuditEvent({
      user: req.user, action: 'UPDATE', entity_type: 'crm_kitting_checkpoint',
      entity_id: id, entity_label: existing.label,
      method: 'PUT', path: `/api/crm-kitting/checkpoints/${id}`,
      before: existing, after: req.body,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── DELETE /api/crm-kitting/checkpoints/:id ─────────────────────
// Soft delete — keep entry history intact.
router.delete('/checkpoints/:id', requirePermission('crm_kitting', 'delete'), (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ error: 'Admin only' });
  const id = Number(req.params.id);
  const db = getDb();
  try {
    db.prepare(`UPDATE crm_kitting_checkpoint SET is_active = 0 WHERE id = ?`).run(id);
    logAuditEvent({
      user: req.user, action: 'DELETE', entity_type: 'crm_kitting_checkpoint',
      entity_id: id, method: 'DELETE', path: `/api/crm-kitting/checkpoints/${id}`,
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/crm-kitting/projects ───────────────────────────────
// Distinct projects from business_book — grouped by company_name to
// match Cash Flow's project-list convention (mam: "project name
// accordially pick from business book like cash flow example").  One
// row per unique company_name; bb_entry_count tells admin how many
// underlying BB rows roll up.  Rows with NULL/blank company_name are
// folded under the client_name so legacy entries still show up.
router.get('/projects', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key,
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_name,
        MIN(bb.id)              AS bb_id,
        MAX(bb.lead_no)         AS lead_no,
        MAX(bb.client_name)     AS client_name,
        MAX(bb.state)           AS state,
        MAX(bb.district)        AS district,
        MAX(bb.employee_assigned) AS crm_person,
        COALESCE(SUM(bb.sale_amount_without_gst), 0) AS sale_amount_without_gst,
        COALESCE(SUM(bb.po_amount), 0)               AS po_amount,
        COUNT(bb.id)            AS bb_entry_count,
        MIN(bb.committed_start_date)      AS committed_start_date,
        MAX(bb.committed_completion_date) AS committed_completion_date
      FROM business_book bb
      WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) IS NOT NULL
      GROUP BY COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
      ORDER BY project_name
    `).all();
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/crm-kitting/project?key=<company_name> ─────────────
// Returns the rolled-up project + checkpoint list with the latest
// entry per checkpoint.  Keyed on project_key (= bb.company_name) so
// multiple BB rows for the same logical project share one kitting
// state — mirrors Cash Flow's grouping (mam, 2026-05-21).
router.get('/project', requirePermission('crm_kitting', 'view'), (req, res) => {
  const db = getDb();
  const projectKey = String(req.query.key || '').trim();
  if (!projectKey) return res.status(400).json({ error: 'key (project_key / company_name) required' });
  try {
    const project = db.prepare(`
      SELECT
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key,
        COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_name,
        MIN(bb.id) AS bb_id,
        MAX(bb.lead_no) AS lead_no,
        MAX(bb.client_name) AS client_name,
        MAX(bb.state) AS state,
        MAX(bb.district) AS district,
        MAX(bb.employee_assigned) AS crm_person,
        COALESCE(SUM(bb.sale_amount_without_gst), 0) AS sale_amount_without_gst,
        COALESCE(SUM(bb.po_amount), 0) AS po_amount,
        COUNT(bb.id) AS bb_entry_count
      FROM business_book bb
      WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) = ?
      GROUP BY COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
    `).get(projectKey);
    if (!project) return res.status(404).json({ error: 'project not found' });

    const checkpoints = db.prepare(`
      SELECT id, stage_no, sort_order, label, description
      FROM crm_kitting_checkpoint
      WHERE is_active = 1
      ORDER BY stage_no, sort_order, id
    `).all();

    const latestStmt = db.prepare(`
      SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
             e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name,
             (SELECT COUNT(*) FROM crm_kitting_entry e2
              WHERE e2.project_key = e.project_key AND e2.checkpoint_id = e.checkpoint_id) AS history_count
      FROM crm_kitting_entry e
      LEFT JOIN users u ON u.id = e.uploaded_by
      WHERE e.project_key = ? AND e.checkpoint_id = ?
      ORDER BY e.uploaded_at DESC, e.id DESC
      LIMIT 1
    `);

    const withEntries = checkpoints.map(cp => ({
      ...cp,
      latest: latestStmt.get(projectKey, cp.id) || null,
    }));

    const summary = { 1: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 },
                      2: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 },
                      3: { yes: 0, no: 0, partially: 0, na: 0, pending: 0, total: 0 } };
    for (const cp of withEntries) {
      const s = summary[cp.stage_no];
      if (!s) continue;
      s.total += 1;
      if (cp.latest && cp.latest.status) s[cp.latest.status] += 1;
      else s.pending += 1;
    }

    res.json({ project, checkpoints: withEntries, summary });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/crm-kitting/entry ─────────────────────────────────
// Multipart: project_key, checkpoint_id, status, observation_date,
// remarks, photo (file).  Key in body (not URL) so company_names
// containing slashes / dots work without URL-encoding gymnastics.
router.post('/entry',
  requirePermission('crm_kitting', 'edit'),
  photoUpload.single('photo'),
  (req, res) => {
    const db = getDb();
    const projectKey = String(req.body?.project_key || '').trim();
    const { checkpoint_id, status, remarks } = req.body || {};
    let { observation_date } = req.body || {};

    if (!projectKey) return res.status(400).json({ error: 'project_key required' });
    if (!STATUSES.includes(String(status))) {
      return res.status(400).json({ error: `status must be one of ${STATUSES.join(',')}` });
    }
    const cpId = Number(checkpoint_id);
    if (!cpId) return res.status(400).json({ error: 'checkpoint_id required' });

    // observation_date validation — defaults to today, max 5 days back.
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const minDate = new Date(today); minDate.setDate(minDate.getDate() - UPLOAD_BACK_DAYS);
    let obs = today;
    if (observation_date) {
      const d = new Date(observation_date);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'invalid observation_date' });
      d.setHours(0, 0, 0, 0);
      if (d.getTime() > today.getTime()) return res.status(400).json({ error: 'observation_date cannot be in the future' });
      if (d.getTime() < minDate.getTime()) return res.status(400).json({ error: `observation_date cannot be more than ${UPLOAD_BACK_DAYS} days in the past` });
      obs = d;
    }
    observation_date = obs.toISOString().slice(0, 10);

    try {
      // Confirm the project_key still maps to at least one BB row.
      const projExists = db.prepare(`
        SELECT 1 FROM business_book
        WHERE COALESCE(NULLIF(TRIM(company_name),''), client_name) = ?
        LIMIT 1
      `).get(projectKey);
      if (!projExists) return res.status(404).json({ error: 'project not found in business book' });

      const cp = db.prepare(`SELECT id FROM crm_kitting_checkpoint WHERE id = ?`).get(cpId);
      if (!cp) return res.status(404).json({ error: 'checkpoint not found' });

      const photoPath = req.file ? `/uploads/crm-kitting/${path.basename(req.file.path)}` : null;
      const r = db.prepare(`
        INSERT INTO crm_kitting_entry
          (project_key, checkpoint_id, status, photo_path, remarks, observation_date, uploaded_by)
        VALUES (?,?,?,?,?,?,?)
      `).run(projectKey, cpId, String(status), photoPath, remarks || null, observation_date, req.user?.id || null);

      logAuditEvent({
        user: req.user, action: 'CREATE', entity_type: 'crm_kitting_entry',
        entity_id: r.lastInsertRowid, entity_label: `${projectKey} · cp=${cpId} · ${status}`,
        method: 'POST', path: '/api/crm-kitting/entry',
        body: { project_key: projectKey, checkpoint_id: cpId, status, observation_date },
      });
      res.json({ id: r.lastInsertRowid, photo_path: photoPath });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// ── GET /api/crm-kitting/history?key=...&cp=... ─────────────────
router.get('/history',
  requirePermission('crm_kitting', 'view'),
  (req, res) => {
    const db = getDb();
    const projectKey = String(req.query.key || '').trim();
    const cpId = Number(req.query.cp);
    if (!projectKey || !cpId) return res.status(400).json({ error: 'key + cp required' });
    try {
      const rows = db.prepare(`
        SELECT e.id, e.status, e.photo_path, e.remarks, e.observation_date,
               e.uploaded_at, e.uploaded_by, u.name AS uploaded_by_name
        FROM crm_kitting_entry e
        LEFT JOIN users u ON u.id = e.uploaded_by
        WHERE e.project_key = ? AND e.checkpoint_id = ?
        ORDER BY e.uploaded_at DESC, e.id DESC
      `).all(projectKey, cpId);
      res.json(rows);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

module.exports = router;
