// Drawing Tracker — project drawings with a permanent revision history.
//
// The one rule the whole module exists to guarantee: a revision is NEVER
// overwritten or deleted. Uploading Rev 11 leaves Rev 10's row and its file
// completely untouched and still downloadable. There is no code path here that
// UPDATEs a revision's file_url, and no hard DELETE of a revision.
//
// Two safety properties are enforced by the DATABASE, not by this file:
//   UNIQUE(drawing_id, revision_no)        — no duplicate "Rev 5"; also makes
//                                            simultaneous uploads safe (the
//                                            loser retries with the next free
//                                            number instead of overwriting)
//   partial UNIQUE ... WHERE status='current'
//                                          — exactly one Current per drawing,
//                                            even momentarily mid-transaction
//
// Project comes from EITHER existing master (they are unlinked in this schema):
// business_book (sites.business_book_id points here, so the Site dropdown can
// cascade) or proj_projects. No new project/site master is created.
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { logAuditEvent } = require('../middleware/audit');
const { uploadsSub, ensureDir } = require('../lib/paths');
const storage = require('../lib/storage');

const router = express.Router();
router.use(authMiddleware);

const MODULE = 'drawing_tracker';
const canView = requirePermission(MODULE, 'view');
const canCreate = requirePermission(MODULE, 'create');
const canEdit = requirePermission(MODULE, 'edit');
const canDelete = requirePermission(MODULE, 'delete');

const str = (v) => { const t = String(v ?? '').trim(); return t || null; };
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; };

// Drawing files live in their own subfolder, deliberately NOT added to
// SWEEP_FOLDERS in lib/paths.js — the orphan sweep only deletes inside those
// folders, so keeping 'drawings' out of the list means a drawing revision can
// never be auto-deleted by a background job. That is the point of the module.
const DRAWINGS_FOLDER = 'drawings';

// Module-local multer at 100 MB. The ERP-wide /api/upload stays at 20 MB —
// this larger limit applies only to drawing files (CAD/PDF run big).
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, ensureDir(uploadsSub(DRAWINGS_FOLDER))),
    // Same <epoch>-<rand>-<sanitised> convention as /api/upload. The revision
    // number is NOT in the on-disk name because it isn't known until the
    // transaction runs; the download route sets a Content-Disposition filename
    // of {DrawingNumber}_Rev{N}.{ext} instead, which is what the user sees.
    filename: (req, file, cb) => cb(null,
      `${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`),
  }),
  limits: { fileSize: 100 * 1024 * 1024 },
});

// Best-effort cleanup when a DB write fails after the file already landed.
function discardFile(file) {
  if (!file?.path) return;
  try { fs.unlinkSync(file.path); } catch (_) { /* already gone — fine */ }
}

const DEFAULT_DISCIPLINES = ['Architectural', 'Civil', 'Structural', 'Electrical', 'Mechanical', 'HVAC', 'Plumbing', 'Fire Fighting', 'Fire Alarm', 'ELV', 'Solar', 'Interior', 'Other'];
const DEFAULT_TYPES = ['Shop Drawing', 'IFC Drawing', 'GFC Drawing', 'As-Built Drawing', 'Design Drawing', 'Working Drawing', 'Construction Drawing', 'Coordination Drawing', 'Schematic', 'Detail Drawing'];
const DEFAULT_REASONS = ['Client Revision', 'Consultant Revision', 'Site Requirement', 'Design Change', 'Coordination Change', 'Material Change', 'Error Correction', 'Approval Comment', 'Construction Requirement', 'Other'];

// Configurable lists live in app_settings (the house convention for settings)
// so an admin can extend them without a code change.
function listSetting(key, fallback) {
  const row = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  const csv = String(row?.value || '').split(',').map(s => s.trim()).filter(Boolean);
  return csv.length ? csv : fallback;
}

const DWG_COLS = `d.id, d.project_source, d.project_id, d.project_name, d.site_id, d.site_name,
  d.drawing_number, d.title, d.discipline, d.drawing_type, d.current_revision_id, d.remarks,
  d.boq_required, d.boq_file_url, d.boq_file_name,
  d.created_by, d.created_by_name, d.created_at, d.updated_at,
  r.revision_no AS current_revision_no, r.status AS current_status,
  r.uploaded_at AS last_revised_at, r.uploaded_by_name AS last_revised_by,
  (SELECT COUNT(*) FROM drawing_revisions x WHERE x.drawing_id = d.id) AS revision_count`;

const DWG_FROM = `FROM drawings d LEFT JOIN drawing_revisions r ON r.id = d.current_revision_id`;

// ─── Dropdown options ──────────────────────────────────────────────────
// Both project masters are offered because the ERP has two unlinked ones.
// Sites cascade off business_book only (sites.business_book_id) — there is no
// column linking sites to proj_projects, so a proj_project drawing gets the
// full site list. That's a schema limitation, surfaced honestly to the UI.
router.get('/options', canView, (req, res) => {
  const db = getDb();
  let projectsSalesFunnel = [];
  try {
    projectsSalesFunnel = db.prepare(`
      SELECT id, lead_no, client_name, company_name, project_name, project_location, address, district, state, current_stage, is_qualified,
             COALESCE(NULLIF(TRIM(project_name),''), client_name, company_name) AS name
        FROM sales_funnel
       WHERE current_stage != 'lost'
       ORDER BY id DESC LIMIT 1000`).all();
  } catch (_) {}

  let projectsSolar = [];
  try {
    projectsSolar = db.prepare(`
      SELECT id, deal_no, client_name, company, location, state, district, stage,
             COALESCE(NULLIF(TRIM(company),''), client_name) AS name
        FROM solar_deals
       WHERE status != 'lost'
       ORDER BY id DESC LIMIT 1000`).all();
  } catch (_) {}

  res.json({
    disciplines: listSetting('drawing_disciplines', DEFAULT_DISCIPLINES),
    drawing_types: listSetting('drawing_types', DEFAULT_TYPES),
    revision_reasons: listSetting('drawing_revision_reasons', DEFAULT_REASONS),
    projects_business_book: db.prepare(`
      SELECT id, COALESCE(NULLIF(TRIM(project_name),''), client_name) AS name, client_name, lead_no
        FROM business_book
       WHERE COALESCE(NULLIF(TRIM(project_name),''), client_name) IS NOT NULL
       ORDER BY name LIMIT 2000`).all(),
    projects_sales_funnel: projectsSalesFunnel,
    projects_solar: projectsSolar,
    projects_module: db.prepare(`SELECT id, name FROM proj_projects ORDER BY name`).all(),
    sites: db.prepare(`SELECT id, name, business_book_id FROM sites ORDER BY name`).all(),
  });
});

// ─── Drawings list ─────────────────────────────────────────────────────
router.get('/drawings', canView, (req, res) => {
  const db = getDb();
  const q = req.query || {};
  const where = [];
  const args = [];

  if (q.project_source) { where.push('d.project_source = ?'); args.push(q.project_source); }
  if (q.project_id) { where.push('d.project_id = ?'); args.push(int(q.project_id)); }
  if (q.site_id) { where.push('d.site_id = ?'); args.push(int(q.site_id)); }
  if (q.discipline) { where.push('d.discipline = ?'); args.push(q.discipline); }
  if (q.drawing_type) { where.push('d.drawing_type = ?'); args.push(q.drawing_type); }
  if (q.status) { where.push('r.status = ?'); args.push(q.status); }
  if (q.uploaded_by) { where.push('r.uploaded_by_name LIKE ?'); args.push(`%${q.uploaded_by}%`); }
  if (q.revision_no) { where.push('r.revision_no = ?'); args.push(int(q.revision_no)); }
  if (q.from) { where.push('DATE(r.uploaded_at) >= DATE(?)'); args.push(q.from); }
  if (q.to) { where.push('DATE(r.uploaded_at) <= DATE(?)'); args.push(q.to); }
  if (q.search) {
    where.push(`(d.drawing_number LIKE ? OR d.title LIKE ? OR d.project_name LIKE ? OR d.site_name LIKE ? OR d.discipline LIKE ?)`);
    const s = `%${q.search}%`;
    args.push(s, s, s, s, s);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Server-side pagination — the module is specified to hold thousands of
  // drawings, so the browser never receives the whole set.
  const limit = Math.min(int(q.limit) || 50, 200);
  const offset = int(q.offset) || 0;
  const total = db.prepare(`SELECT COUNT(*) c ${DWG_FROM} ${whereSql}`).get(...args).c;
  const rows = db.prepare(`
    SELECT ${DWG_COLS} ${DWG_FROM} ${whereSql}
     ORDER BY r.uploaded_at DESC, d.id DESC
     LIMIT ? OFFSET ?`).all(...args, limit, offset);

  res.json({ rows, total, limit, offset });
});

// ─── Drawing detail + full revision history ────────────────────────────
router.get('/drawings/:id', canView, (req, res) => {
  const db = getDb();
  const drawing = db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} WHERE d.id = ?`).get(req.params.id);
  if (!drawing) return res.status(404).json({ error: 'Drawing not found' });
  // Newest first — every revision ever uploaded, including superseded and
  // cancelled ones. Nothing is filtered out; that is the audit trail.
  const revisions = db.prepare(
    `SELECT * FROM drawing_revisions WHERE drawing_id = ? ORDER BY revision_no DESC`
  ).all(req.params.id);
  res.json({ ...drawing, revisions });
});

// ─── Create a drawing + its Rev 0, in one transaction ──────────────────
router.post('/drawings', canCreate, upload.fields([{ name: 'file', maxCount: 1 }, { name: 'boq_file', maxCount: 1 }]), async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const drawingFile = req.files?.file?.[0] || req.file;
  const boqFile = req.files?.boq_file?.[0];
  const fail = (code, error) => {
    discardFile(drawingFile);
    discardFile(boqFile);
    return res.status(code).json({ error });
  };

  if (!str(b.drawing_number)) return fail(400, 'Drawing number is required');
  if (!str(b.revision_description)) return fail(400, 'Revision description is required');
  if (!drawingFile) return fail(400, 'A drawing file is required');
  const validSources = ['business_book', 'proj_project', 'sales_funnel', 'solar_deal'];
  const projectSource = validSources.includes(b.project_source) ? b.project_source : 'business_book';

  // Land the drawing file in storage first (no-op locally, uploads to S3 when remote),
  // then do the DB work synchronously. better-sqlite3 transactions are sync, so
  // an await must never sit inside one.
  let url;
  try {
    url = await storage.adoptLocalFile(drawingFile.path, `${DRAWINGS_FOLDER}/${drawingFile.filename}`, drawingFile.mimetype);
  } catch (e) {
    console.error('[drawing-tracker] file adopt failed:', e.message);
    return fail(500, 'Could not store the uploaded file.');
  }

  let boqUrl = null;
  let boqName = null;
  if (boqFile) {
    try {
      boqUrl = await storage.adoptLocalFile(boqFile.path, `${DRAWINGS_FOLDER}/${boqFile.filename}`, boqFile.mimetype);
      boqName = boqFile.originalname;
    } catch (e) {
      console.error('[drawing-tracker] boq file adopt failed:', e.message);
    }
  }
  const boqRequired = (b.boq_required === '1' || b.boq_required === 'true' || b.boq_required === true) ? 1 : 0;
  if (boqRequired && !boqFile) {
    return fail(400, 'BOQ file is required when BOQ Required is checked');
  }

  try {
    const result = db.transaction(() => {
      const info = db.prepare(`
        INSERT INTO drawings
          (project_source, project_id, project_name, site_id, site_name, drawing_number,
           title, discipline, drawing_type, remarks, boq_required, boq_file_url, boq_file_name,
           created_by, created_by_name)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        projectSource, int(b.project_id), str(b.project_name), int(b.site_id), str(b.site_name),
        str(b.drawing_number), str(b.title), str(b.discipline), str(b.drawing_type),
        str(b.remarks), boqRequired, boqUrl, boqName, req.user.id, req.user.name || null);
      const drawingId = info.lastInsertRowid;

      // Rev 0 is the starting drawing. It is current until something supersedes it.
      const rev = db.prepare(`
        INSERT INTO drawing_revisions
          (drawing_id, revision_no, revision_date, revision_description, revision_reason,
           status, file_url, file_name, file_type, file_size, uploaded_by, uploaded_by_name)
        VALUES (?,0,?,?,?,'current',?,?,?,?,?,?)`).run(
        drawingId, str(b.revision_date) || new Date().toISOString().slice(0, 10),
        str(b.revision_description), str(b.revision_reason),
        url, drawingFile.originalname, drawingFile.mimetype, drawingFile.size,
        req.user.id, req.user.name || null);

      db.prepare('UPDATE drawings SET current_revision_id=? WHERE id=?').run(rev.lastInsertRowid, drawingId);
      return { drawingId, revisionId: rev.lastInsertRowid };
    })();

    notify(db, result.drawingId, 'created', 0, req.user);
    const out = db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} WHERE d.id = ?`).get(result.drawingId);
    res.status(201).json(out);
  } catch (e) {
    discardFile(drawingFile);
    discardFile(boqFile);
    // SQLite reports a unique-index violation by naming the COLUMNS, not the
    // index ("UNIQUE constraint failed: drawings.project_source, …"), so match
    // on that rather than on uq_dwg_identity.
    if (/UNIQUE/i.test(e.message) && /drawing_number/.test(e.message)) {
      return res.status(409).json({
        error: `Drawing number "${str(b.drawing_number)}" already exists for this project. Open it and upload a new revision instead.`,
      });
    }
    console.error('[drawing-tracker] create failed:', e.message);
    res.status(500).json({ error: 'Could not create the drawing.' });
  }
});

// ─── Upload a NEW revision — the supersede swap ────────────────────────
// The previous current revision is only ever flipped to 'superseded'. Its row,
// its file_url and its file on disk are untouched.
router.post('/drawings/:id/revisions', canCreate, upload.single('file'), async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const fail = (code, error) => { discardFile(req.file); return res.status(code).json({ error }); };

  const drawing = db.prepare('SELECT * FROM drawings WHERE id=?').get(req.params.id);
  if (!drawing) return fail(404, 'Drawing not found');
  if (!str(b.revision_description)) return fail(400, 'Revision description is required');
  if (!req.file) return fail(400, 'A drawing file is required');

  let url;
  try {
    url = await storage.adoptLocalFile(req.file.path, `${DRAWINGS_FOLDER}/${req.file.filename}`, req.file.mimetype);
  } catch (e) {
    console.error('[drawing-tracker] file adopt failed:', e.message);
    return fail(500, 'Could not store the uploaded file.');
  }

  // Explicit numbers are accepted only when they are exactly the next number.
  // An omitted number is assigned automatically inside the transaction.
  const hasExplicit = b.revision_no !== undefined && b.revision_no !== '';
  const explicitValue = hasExplicit ? String(b.revision_no).trim() : '';
  const explicit = hasExplicit && /^\d+$/.test(explicitValue) ? int(explicitValue) : null;
  if (hasExplicit && explicit === null) {
    return fail(400, 'Revision number must be a non-negative integer.');
  }

  // One retry: if a concurrent upload took the number we computed, recompute and
  // go again rather than failing a legitimate upload.
  const attempt = (revisionNo) => db.transaction(() => {
    const nextNo = db.prepare(
      'SELECT COALESCE(MAX(revision_no), -1) + 1 AS n FROM drawing_revisions WHERE drawing_id=?'
    ).get(drawing.id).n;
    if (revisionNo != null && revisionNo !== nextNo) {
      const error = new Error(`Revision must be the next sequential number: Rev ${nextNo}.`);
      error.code = 'REVISION_SEQUENCE';
      throw error;
    }
    const no = revisionNo != null ? revisionNo : nextNo;

    // ORDER MATTERS. The partial unique index (…WHERE status='current') is
    // checked per-statement, not deferred to COMMIT — so inserting the new row
    // as 'current' while the old one is still 'current' fails immediately.
    // Supersede first, then insert. Both are inside one transaction, so if the
    // insert then fails (e.g. duplicate revision_no) the supersede rolls back
    // and the drawing is left exactly as it was.
    db.prepare(`UPDATE drawing_revisions SET status='superseded'
                 WHERE drawing_id=? AND status='current'`).run(drawing.id);

    const rev = db.prepare(`
      INSERT INTO drawing_revisions
        (drawing_id, revision_no, revision_date, revision_description, revision_reason,
         status, file_url, file_name, file_type, file_size, uploaded_by, uploaded_by_name)
      VALUES (?,?,?,?,?,'current',?,?,?,?,?,?)`).run(
      drawing.id, no, str(b.revision_date) || new Date().toISOString().slice(0, 10),
      str(b.revision_description), str(b.revision_reason),
      url, req.file.originalname, req.file.mimetype, req.file.size,
      req.user.id, req.user.name || null);

    db.prepare('UPDATE drawings SET current_revision_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(rev.lastInsertRowid, drawing.id);
    return { revisionId: rev.lastInsertRowid, revisionNo: no };
  })();

  let result;
  try {
    result = attempt(explicit);
  } catch (e) {
    if (e.code === 'REVISION_SEQUENCE') {
      discardFile(req.file);
      return res.status(400).json({ error: e.message });
    }
    if (/UNIQUE/i.test(e.message) && explicit !== null) {
      discardFile(req.file);
      return res.status(409).json({ error: `Revision ${explicit} is no longer the next sequential revision.` });
    }
    if (/UNIQUE/i.test(e.message)) {
      try {
        result = attempt(null);           // someone else grabbed it — take the next
      } catch (e2) {
        discardFile(req.file);
        console.error('[drawing-tracker] revision insert failed twice:', e2.message);
        return res.status(409).json({ error: 'Another revision was uploaded at the same moment. Please try again.' });
      }
    } else {
      discardFile(req.file);
      console.error('[drawing-tracker] revision insert failed:', e.message);
      return res.status(500).json({ error: 'Could not save the revision.' });
    }
  }

  logAuditEvent({
    user: req.user, action: 'REVISION_UPLOADED', entity_type: 'drawings',
    entity_id: drawing.id, entity_label: `${drawing.drawing_number} Rev ${result.revisionNo}`,
    after: { revision_no: result.revisionNo, description: str(b.revision_description) },
  });
  notify(db, drawing.id, 'revised', result.revisionNo, req.user);

  const out = db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} WHERE d.id = ?`).get(drawing.id);
  res.status(201).json({ ...out, new_revision_no: result.revisionNo });
});

// ─── One revision's metadata + enough context to warn about it ─────────
// Feeds the full-page viewer. Returns the CURRENT revision alongside the
// requested one so the page can say "you're on Rev 6, latest is Rev 10"
// without a second round trip.
router.get('/revisions/:id', canView, (req, res) => {
  const db = getDb();
  const revision = db.prepare(`
    SELECT r.*, d.id AS drawing_id, d.drawing_number, d.title, d.discipline,
           d.drawing_type, d.project_name, d.site_name
      FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
     WHERE r.id = ?`).get(req.params.id);
  if (!revision) return res.status(404).json({ error: 'Revision not found' });
  const current = db.prepare(
    `SELECT id, revision_no, status FROM drawing_revisions WHERE drawing_id=? AND status='current'`
  ).get(revision.drawing_id);
  res.json({ revision, current });
});

// ─── View / download a specific revision ───────────────────────────────
// Permission-checked and audit-logged, because these are GETs and
// auditMiddleware only auto-logs POST/PUT/PATCH/DELETE.
//
// Serves the EXACT revision requested — never silently the latest one.
router.get('/revisions/:id/file', canView, async (req, res) => {
  const db = getDb();
  const rev = db.prepare(`
    SELECT r.*, d.drawing_number FROM drawing_revisions r
      JOIN drawings d ON d.id = r.drawing_id WHERE r.id = ?`).get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revision not found' });

  const key = String(rev.file_url || '').replace(/^\/uploads\//, '');
  let opened = null;
  try { opened = await storage.openStream(key); } catch (_) { opened = null; }
  if (!opened) return res.status(404).json({ error: 'The file for this revision could not be found.' });

  const download = req.query.download === '1';
  let ext = path.extname(rev.file_name || '') || path.extname(key) || '';
  if (!ext && /\.dwg$/i.test(rev.file_name || '')) ext = '.dwg';
  // The user-facing filename follows the spec convention even though the
  // on-disk name can't (the revision number isn't known at multer time).
  const nice = `${rev.drawing_number}_Rev${rev.revision_no}${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');

  logAuditEvent({
    user: req.user, action: download ? 'REVISION_DOWNLOADED' : 'REVISION_VIEWED',
    entity_type: 'drawing_revisions', entity_id: rev.id,
    entity_label: `${rev.drawing_number} Rev ${rev.revision_no}`,
    method: 'GET', path: req.originalUrl, ip: req.ip, user_agent: req.get('user-agent'),
  });

  let contentType = rev.file_type;
  if (ext.toLowerCase() === '.dwg') {
    contentType = 'application/acad';
  } else if (!contentType) {
    contentType = 'application/octet-stream';
  }
  res.setHeader('Content-Type', contentType);
  if (opened.size) res.setHeader('Content-Length', opened.size);
  res.setHeader('Content-Disposition', `${download ? 'attachment' : 'inline'}; filename="${nice}"`);
  opened.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  opened.stream.pipe(res);
});

// ─── Cancel a revision (never a hard delete) ───────────────────────────
router.post('/revisions/:id/cancel', canDelete, (req, res) => {
  const db = getDb();
  const rev = db.prepare('SELECT * FROM drawing_revisions WHERE id=?').get(req.params.id);
  if (!rev) return res.status(404).json({ error: 'Revision not found' });
  if (rev.status === 'current') {
    return res.status(409).json({
      error: 'The current revision cannot be cancelled — upload a newer revision first, then cancel this one.',
    });
  }
  const reason = str(req.body?.reason);
  if (!reason) return res.status(400).json({ error: 'A reason is required to cancel a revision.' });

  // Status change only. The row and the file stay exactly where they are.
  db.prepare(`UPDATE drawing_revisions SET status='cancelled',
      remarks = COALESCE(remarks || ' | ', '') || ? WHERE id=?`).run(`Cancelled: ${reason}`, rev.id);
  logAuditEvent({
    user: req.user, action: 'REVISION_CANCELLED', entity_type: 'drawing_revisions',
    entity_id: rev.id, before: { status: rev.status }, after: { status: 'cancelled', reason },
  });
  res.json({ ok: true });
});

// ─── Edit drawing metadata + optional BOQ file ─────────────────────────
router.put('/drawings/:id', canEdit, upload.single('boq_file'), async (req, res) => {
  const db = getDb();
  const before = db.prepare('SELECT * FROM drawings WHERE id=?').get(req.params.id);
  if (!before) {
    discardFile(req.file);
    return res.status(404).json({ error: 'Drawing not found' });
  }
  const b = req.body || {};
  try {
    const validSources = ['business_book', 'proj_project', 'sales_funnel', 'solar_deal'];
    const projectSource = b.project_source && validSources.includes(b.project_source) ? b.project_source : before.project_source;
    const projectId = b.project_id !== undefined ? int(b.project_id) : before.project_id;
    const projectName = b.project_name !== undefined ? str(b.project_name) : before.project_name;
    const drawingNumber = str(b.drawing_number) || before.drawing_number;

    // Check unique identity constraint if drawing number or project changed
    if (drawingNumber !== before.drawing_number || projectId !== before.project_id || projectSource !== before.project_source) {
      const conflict = db.prepare(`
        SELECT id FROM drawings
         WHERE project_source = ? AND project_id IS ? AND drawing_number = ? AND id != ?
      `).get(projectSource, projectId, drawingNumber, before.id);
      if (conflict) {
        discardFile(req.file);
        return res.status(409).json({ error: `Drawing number "${drawingNumber}" already exists for this project.` });
      }
    }

    let boqUrl = before.boq_file_url;
    let boqName = before.boq_file_name;
    if (req.file) {
      try {
        boqUrl = await storage.adoptLocalFile(req.file.path, `${DRAWINGS_FOLDER}/${req.file.filename}`, req.file.mimetype);
        boqName = req.file.originalname;
      } catch (e) {
        console.error('[drawing-tracker] boq update adopt failed:', e.message);
      }
    } else if (b.remove_boq === 'true' || b.remove_boq === '1') {
      boqUrl = null;
      boqName = null;
    }

    const boqRequired = b.boq_required !== undefined
      ? ((b.boq_required === '1' || b.boq_required === 'true' || b.boq_required === true) ? 1 : 0)
      : before.boq_required;

    if (boqRequired && !boqUrl) {
      discardFile(req.file);
      return res.status(400).json({ error: 'BOQ file is required when BOQ Required is checked' });
    }

    db.prepare(`UPDATE drawings SET
        drawing_number = ?,
        title = COALESCE(?, title),
        discipline = COALESCE(?, discipline),
        drawing_type = COALESCE(?, drawing_type),
        project_source = ?,
        project_id = ?,
        project_name = ?,
        site_id = ?,
        site_name = ?,
        remarks = ?,
        boq_required = ?,
        boq_file_url = ?,
        boq_file_name = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`).run(
      drawingNumber,
      str(b.title), str(b.discipline), str(b.drawing_type),
      projectSource, projectId, projectName,
      b.site_id !== undefined ? int(b.site_id) : before.site_id,
      b.site_name !== undefined ? str(b.site_name) : before.site_name,
      b.remarks !== undefined ? str(b.remarks) : before.remarks,
      boqRequired, boqUrl, boqName,
      req.params.id);

    logAuditEvent({
      user: req.user, action: 'DRAWING_UPDATED', entity_type: 'drawings',
      entity_id: before.id, entity_label: drawingNumber,
      before: { drawing_number: before.drawing_number, title: before.title, site_name: before.site_name },
      after: { drawing_number: drawingNumber, title: str(b.title), site_name: str(b.site_name) },
    });
  } catch (e) {
    discardFile(req.file);
    console.error('[drawing-tracker] update failed:', e.message);
    return res.status(500).json({ error: 'Could not update the drawing.' });
  }
  res.json(db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} WHERE d.id = ?`).get(req.params.id));
});

// ─── Download BOQ file ────────────────────────────────────────────────
router.get('/drawings/:id/boq', canView, async (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT id, drawing_number, boq_file_url, boq_file_name FROM drawings WHERE id = ?').get(req.params.id);
  if (!d || !d.boq_file_url) return res.status(404).json({ error: 'No BOQ file attached for this drawing.' });

  const key = String(d.boq_file_url || '').replace(/^\/uploads\//, '');
  let opened = null;
  try { opened = await storage.openStream(key); } catch (_) { opened = null; }
  if (!opened) return res.status(404).json({ error: 'The BOQ file could not be found.' });

  const ext = path.extname(d.boq_file_name || '') || path.extname(key) || '.xlsx';
  const nice = `${d.drawing_number}_BOQ${ext}`.replace(/[^a-zA-Z0-9._-]/g, '_');

  res.setHeader('Content-Disposition', `attachment; filename="${nice}"`);
  if (opened.size) res.setHeader('Content-Length', opened.size);
  opened.stream.on('error', () => { if (!res.headersSent) res.status(500).end(); });
  opened.stream.pipe(res);
});

// ─── Edit revision remarks/date + optional file replacement ───────────
router.put('/revisions/:id', canEdit, upload.single('file'), async (req, res) => {
  const db = getDb();
  const rev = db.prepare('SELECT * FROM drawing_revisions WHERE id=?').get(req.params.id);
  if (!rev) {
    discardFile(req.file);
    return res.status(404).json({ error: 'Revision not found' });
  }
  const b = req.body || {};
  let fileUpdated = false;
  let fileUrl = rev.file_url;
  let fileName = rev.file_name;
  let fileType = rev.file_type;
  let fileSize = rev.file_size;

  if (req.file) {
    try {
      fileUrl = await storage.adoptLocalFile(req.file.path, `${DRAWINGS_FOLDER}/${req.file.filename}`, req.file.mimetype);
      fileName = req.file.originalname;
      fileType = req.file.mimetype;
      fileSize = req.file.size;
      fileUpdated = true;
    } catch (e) {
      discardFile(req.file);
      console.error('[drawing-tracker] revision file replace failed:', e.message);
      return res.status(500).json({ error: 'Could not store the replacement file.' });
    }
  }

  try {
    db.prepare(`UPDATE drawing_revisions SET
        revision_description = COALESCE(?, revision_description),
        revision_reason = COALESCE(?, revision_reason),
        revision_date = COALESCE(?, revision_date),
        file_url = ?,
        file_name = ?,
        file_type = ?,
        file_size = ?
      WHERE id = ?`).run(
      str(b.revision_description), str(b.revision_reason), str(b.revision_date),
      fileUrl, fileName, fileType, fileSize, rev.id
    );

    logAuditEvent({
      user: req.user,
      action: fileUpdated ? 'REVISION_FILE_REPLACED' : 'REVISION_EDITED',
      entity_type: 'drawing_revisions',
      entity_id: rev.id,
      entity_label: `Rev ${rev.revision_no}`,
      after: {
        revision_description: b.revision_description,
        revision_reason: b.revision_reason,
        file_replaced: fileUpdated,
        file_name: fileName,
      },
    });
  } catch (e) {
    return res.status(500).json({ error: 'Could not update revision details.' });
  }
  res.json(db.prepare('SELECT * FROM drawing_revisions WHERE id=?').get(rev.id));
});

// ─── Dashboard ─────────────────────────────────────────────────────────
router.get('/dashboard', canView, (req, res) => {
  const db = getDb();
  const one = (sql) => db.prepare(sql).get();
  res.json({
    cards: {
      total_drawings: one('SELECT COUNT(*) c FROM drawings').c,
      total_revisions: one('SELECT COUNT(*) c FROM drawing_revisions').c,
      current_drawings: one("SELECT COUNT(*) c FROM drawing_revisions WHERE status='current'").c,
      superseded_revisions: one("SELECT COUNT(*) c FROM drawing_revisions WHERE status='superseded'").c,
      recently_revised: one(`SELECT COUNT(DISTINCT drawing_id) c FROM drawing_revisions
        WHERE julianday('now') - julianday(uploaded_at) <= 7`).c,
      cancelled_revisions: one("SELECT COUNT(*) c FROM drawing_revisions WHERE status='cancelled'").c,
      disciplines_covered: one("SELECT COUNT(DISTINCT discipline) c FROM drawings WHERE COALESCE(TRIM(discipline),'') <> ''").c,
      projects_covered: one('SELECT COUNT(DISTINCT project_id) c FROM drawings WHERE project_id IS NOT NULL').c,
    },
    by_discipline: db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(discipline),''),'(none)') AS name,
             COUNT(*) AS drawings,
             (SELECT COUNT(*) FROM drawing_revisions r WHERE r.drawing_id IN
               (SELECT id FROM drawings d2 WHERE COALESCE(NULLIF(TRIM(d2.discipline),''),'(none)') = COALESCE(NULLIF(TRIM(drawings.discipline),''),'(none)'))) AS revisions
        FROM drawings GROUP BY name ORDER BY drawings DESC`).all(),
    recent: db.prepare(`
      SELECT r.id, r.revision_no, r.revision_description, r.uploaded_at, r.uploaded_by_name,
             d.id AS drawing_id, d.drawing_number, d.title, d.site_name, d.project_name
        FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
       ORDER BY r.uploaded_at DESC LIMIT 15`).all(),
  });
});

// ─── Matrix: one row per drawing, one column per revision ──────────────
// Feeds the frozen-left / scroll-right grid. Every revision a drawing has
// ever had comes back, so the grid can show Rev 0…Rev N across and let the
// user open any cell. Deliberately one query for drawings and one for all
// their revisions (not N+1), then stitched in JS.
router.get('/matrix', canView, (req, res) => {
  const db = getDb();
  const q = req.query || {};
  const where = [];
  const args = [];
  if (q.site_id) { where.push('d.site_id = ?'); args.push(int(q.site_id)); }
  if (q.discipline) { where.push('d.discipline = ?'); args.push(q.discipline); }
  if (q.search) {
    where.push('(d.drawing_number LIKE ? OR d.title LIKE ? OR d.site_name LIKE ?)');
    const s = `%${q.search}%`; args.push(s, s, s);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const drawings = db.prepare(`
    SELECT d.id, d.drawing_number, d.title, d.discipline, d.drawing_type,
           d.site_id, d.site_name, d.project_name, d.current_revision_id
      FROM drawings d ${whereSql}
     ORDER BY d.site_name, d.drawing_number`).all(...args);

  if (!drawings.length) return res.json({ drawings: [], max_revision: -1 });

  const ids = drawings.map(d => d.id);
  const revs = db.prepare(`
    SELECT id, drawing_id, revision_no, status, revision_description, revision_date,
           uploaded_at, uploaded_by_name, file_name, file_type
      FROM drawing_revisions
     WHERE drawing_id IN (${ids.map(() => '?').join(',')})
     ORDER BY revision_no`).all(...ids);

  const byDrawing = new Map(ids.map(id => [id, []]));
  let maxRev = -1;
  for (const r of revs) {
    byDrawing.get(r.drawing_id)?.push(r);
    if (r.revision_no > maxRev) maxRev = r.revision_no;
  }

  res.json({
    drawings: drawings.map(d => ({ ...d, revisions: byDrawing.get(d.id) || [] })),
    max_revision: maxRev,
  });
});

// ─── By Site: every site that has drawings, with its counts ────────────
router.get('/sites', canView, (req, res) => {
  const db = getDb();
  res.json(db.prepare(`
    SELECT d.site_id, COALESCE(NULLIF(TRIM(d.site_name),''), s.name, '(no site)') AS site_name,
           COUNT(DISTINCT d.id) AS drawing_count,
           COUNT(r.id)          AS revision_count,
           MAX(r.uploaded_at)   AS last_activity
      FROM drawings d
      LEFT JOIN drawing_revisions r ON r.drawing_id = d.id
      LEFT JOIN sites s ON s.id = d.site_id
     GROUP BY d.site_id, site_name
     ORDER BY revision_count DESC, site_name`).all());
});

// ─── One site: its drawings + a combined revision activity feed ────────
router.get('/sites/:id', canView, (req, res) => {
  const db = getDb();
  // site_id '0' / 'null' means the "(no site)" bucket.
  const siteId = int(req.params.id);
  const cond = siteId === null ? 'd.site_id IS NULL' : 'd.site_id = ?';
  const args = siteId === null ? [] : [siteId];

  const drawings = db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} WHERE ${cond}
     ORDER BY d.drawing_number`).all(...args);

  // Every revision across every drawing at this site, newest first — answers
  // "what changed at this site recently" in one query.
  const activity = db.prepare(`
    SELECT r.id, r.revision_no, r.revision_description, r.revision_reason, r.status,
           r.uploaded_at, r.uploaded_by_name,
           d.id AS drawing_id, d.drawing_number, d.title, d.discipline
      FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
     WHERE ${cond}
     ORDER BY r.uploaded_at DESC, r.id DESC LIMIT 500`).all(...args);

  const site = siteId ? db.prepare('SELECT id, name FROM sites WHERE id=?').get(siteId) : null;
  res.json({
    site: site || { id: null, name: drawings[0]?.site_name || '(no site)' },
    drawings,
    activity,
    totals: { drawings: drawings.length, revisions: activity.length },
  });
});

// ─── Reports ───────────────────────────────────────────────────────────
router.get('/reports/:kind', canView, (req, res) => {
  const db = getDb();
  const kind = req.params.kind;
  if (kind === 'register') {
    return res.json(db.prepare(`SELECT ${DWG_COLS} ${DWG_FROM} ORDER BY d.project_name, d.site_name, d.drawing_number`).all());
  }
  if (kind === 'history') {
    const where = req.query.drawing_id ? 'WHERE r.drawing_id = ?' : '';
    const args = req.query.drawing_id ? [int(req.query.drawing_id)] : [];
    return res.json(db.prepare(`
      SELECT r.*, d.drawing_number, d.title, d.project_name, d.site_name, d.discipline
        FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
        ${where} ORDER BY d.drawing_number, r.revision_no DESC`).all(...args));
  }
  if (kind === 'superseded') {
    return res.json(db.prepare(`
      SELECT r.*, d.drawing_number, d.title, d.project_name, d.site_name, d.discipline
        FROM drawing_revisions r JOIN drawings d ON d.id = r.drawing_id
       WHERE r.status='superseded' ORDER BY r.uploaded_at DESC`).all());
  }
  if (kind === 'discipline') {
    return res.json(db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(d.discipline),''),'(none)') AS discipline,
             COUNT(DISTINCT d.id) AS drawings, COUNT(r.id) AS revisions
        FROM drawings d LEFT JOIN drawing_revisions r ON r.drawing_id = d.id
       GROUP BY discipline ORDER BY drawings DESC`).all());
  }
  if (kind === 'project') {
    return res.json(db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(d.project_name),''),'(none)') AS project, d.project_source,
             COUNT(DISTINCT d.id) AS drawings, COUNT(r.id) AS revisions
        FROM drawings d LEFT JOIN drawing_revisions r ON r.drawing_id = d.id
       GROUP BY project, d.project_source ORDER BY drawings DESC`).all());
  }
  if (kind === 'site') {
    return res.json(db.prepare(`
      SELECT COALESCE(NULLIF(TRIM(d.site_name),''),'(none)') AS site,
             COUNT(DISTINCT d.id) AS drawings, COUNT(r.id) AS revisions
        FROM drawings d LEFT JOIN drawing_revisions r ON r.drawing_id = d.id
       GROUP BY site ORDER BY drawings DESC`).all());
  }
  res.status(400).json({ error: `Unknown report: ${kind}` });
});

// ─── Notifications ─────────────────────────────────────────────────────
// Same dedupe-key-before-insert shape used across the ERP (see dpr.js).
// Best-effort: a failed notification must never fail the upload.
function notify(db, drawingId, event, revisionNo, actor) {
  try {
    const d = db.prepare('SELECT drawing_number, title FROM drawings WHERE id=?').get(drawingId);
    if (!d) return;
    const recipients = db.prepare(`
      SELECT DISTINCT ur.user_id AS id FROM user_roles ur
        JOIN role_permissions rp ON rp.role_id = ur.role_id
       WHERE rp.module = 'drawing_tracker' AND rp.can_view = 1
       UNION SELECT id FROM users WHERE role='admin' AND active=1`).all();
    const title = event === 'created'
      ? `New drawing — ${d.drawing_number}`
      : `${d.drawing_number} revised to Rev ${revisionNo}`;
    const body = event === 'created'
      ? `${actor?.name || 'Someone'} added ${d.drawing_number}${d.title ? ` (${d.title})` : ''} at Rev 0.`
      : `${actor?.name || 'Someone'} uploaded Rev ${revisionNo}. Rev ${revisionNo - 1} is now superseded — please use Rev ${revisionNo}.`;
    const dedupe = `drawing:${drawingId}:${event}:${revisionNo}`;
    const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
                            VALUES (?,?,?,?,?,?,?)`);
    for (const r of recipients) {
      if (r.id === actor?.id) continue;
      const key = `${dedupe}:${r.id}`;
      if (!db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(r.id, key)) {
        ins.run(r.id, 'drawing_tracker', title, body, `/drawing-tracker/${drawingId}`, 'in_app', key);
      }
    }
  } catch (e) {
    console.warn('[drawing-tracker] notify failed:', e.message);
  }
}

module.exports = router;
