// Tally Bill → PMS Task → Approval → Payment  (Director CR, 2026-08-13)
//
// ONE SLA-driven lifecycle, target 11.5 working days end-to-end:
//
//   Stage 1  Upload Tally bill        Site Engineer    → T0   (starts the clock)
//   Stage 2  Create PMS tasks         Coordinator      → T1   SLA 2 working days from T0
//   Stage 3  Complete PMS tasks       Executor         → T2   SLA 2 working days from T1
//   Stage 4  Approve + release        Coordinator      → T3   SLA 4 business hours from T2
//   Stage 5  Payment received         Site Engineer    → T4   plan 7 days from T3
//
// The three tabs (Material / T&C / Handover) are a FILTER on one shared record
// set, never three tables — spec §3.  Clock/holiday math is in lib/tallySla.js.
//
// Permissions (spec §2 — "role-based, not hardcoded to names"): the module key
// is `tally_bills` and the stage actor comes from the verb, not a person —
//   create  → Stage 1        edit → Stage 5        approve → Stages 2 + 4
//   admin   → Director: second-level approval, post-approval unlock
// Stage 3 is owned by whoever the PMS task is assigned to.
// The *notification* recipient per stage is separately configurable in Settings
// (tally_owner_* app_settings), so Aanchal/Lovely/Sushila are data, not code.

const express = require('express');
const { istToday } = require('../lib/istDate');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { uploadsSub, ensureDir } = require('../lib/paths');
const storage = require('../lib/storage');
const push = require('../lib/push');
const { fireEmailEvent } = require('../lib/emailRules');
const sla = require('../lib/tallySla');

const router = express.Router();
router.use(authMiddleware);

// ─── Uploads ─────────────────────────────────────────────────────────
// Spec §4 Stage 1: PDF / JPG / PNG, max 10 MB, multi-file.
const UPLOAD_FOLDER = 'tally-bills';
const uploadDir = ensureDir(uploadsSub(UPLOAD_FOLDER));
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png']);
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/jpg', 'image/png']);

const upload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname || '').toLowerCase() || '.pdf';
      cb(null, `tb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`);
    },
  }),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ALLOWED_EXT.has(ext) && ALLOWED_MIME.has(String(file.mimetype).toLowerCase())) return cb(null, true);
    cb(new Error('Only PDF, JPG or PNG files are allowed'));
  },
});

// multer rejects (bad type / >10 MB) arrive as errors on the middleware chain;
// without this they'd surface as an opaque 500 with no hint for the user.
function handleUploadErrors(err, req, res, next) {
  if (!err) return next();
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(400).json({ error: 'Each file must be 10 MB or smaller' });
    if (err.code === 'LIMIT_FILE_COUNT') return res.status(400).json({ error: 'Maximum 10 files per upload' });
    return res.status(400).json({ error: err.message });
  }
  return res.status(400).json({ error: err.message || 'Upload failed' });
}

// Persist multer's temp files, pushing to the bucket when STORAGE_DRIVER=s3.
async function adoptFiles(files) {
  const out = [];
  for (const f of files || []) {
    const url = await storage.adoptLocalFile(f.path, `${UPLOAD_FOLDER}/${f.filename}`, f.mimetype);
    out.push({ url, name: f.originalname || f.filename, size: f.size });
  }
  return out;
}

const unlinkQuiet = (files) => { for (const f of files || []) { try { fs.unlinkSync(f.path); } catch (_) {} } };

// ─── Small helpers ───────────────────────────────────────────────────
const CATEGORIES = { material: 'Material', testing: 'Testing & Commissioning', handover: 'Handover' };
const STATUS_LABEL = {
  pending_task_creation: 'Pending Task Creation',
  tasks_in_progress: 'Tasks In Progress',
  pending_approval: 'Pending Approval',
  payment_pending: 'Payment Pending',
  partially_paid: 'Partially Paid',
  closed: 'Closed',
  on_hold: 'On Hold',
  rejected: 'Rejected',
};
// Stage seats. `manager` is not a stage owner — it is the 100%-escalation
// recipient, kept here so it is configured in the same place (this schema has
// no user→manager edge to infer it from; see scripts/tallySlaCron.js).
const OWNER_KEYS = ['site_engineer', 'coordinator', 'executor', 'director', 'manager'];
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);
// Money comparisons are on REAL columns; ₹1 of slack keeps float noise from
// leaving a bill one paisa short of Closed forever.
const PAISA = 1;

function isAdmin(user) { return user?.role === 'admin'; }

function canApprove(db, user) {
  if (isAdmin(user)) return true;
  const r = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) AS ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module = 'tally_bills'
  `).get(user.id);
  return !!r?.ok;
}

function nextRegisterNo(db) {
  const yr = new Date().getUTCFullYear();
  const last = db.prepare(
    `SELECT register_no FROM tally_bills WHERE register_no LIKE ? ORDER BY id DESC LIMIT 1`
  ).get(`TB-${yr}-%`);
  const n = last ? (parseInt(String(last.register_no).split('-').pop(), 10) || 0) + 1 : 1;
  return `TB-${yr}-${String(n).padStart(4, '0')}`;
}

// ─── Field-level audit (spec §9) ─────────────────────────────────────
// Append-only. Nothing in this file ever UPDATEs or DELETEs tally_bill_audit.
function audit(db, billId, action, entries, req, note = null) {
  const ins = db.prepare(`
    INSERT INTO tally_bill_audit (bill_id, action, field, old_value, new_value, note, user_id, user_name)
    VALUES (?,?,?,?,?,?,?,?)`);
  const uname = req.user?.name || req.user?.username || null;
  const list = Array.isArray(entries) ? entries : [entries];
  for (const e of list) {
    if (!e) continue;
    const o = e.old === undefined || e.old === null ? null : String(e.old);
    const n = e.new === undefined || e.new === null ? null : String(e.new);
    if (e.field && o === n) continue;             // no-op edit — don't pad the trail
    ins.run(billId, action, e.field || null, o, n, e.note || note, req.user?.id || null, uname);
  }
}

// ─── Stage owners (configurable, not name-bound — spec §2) ───────────
function getOwners(db) {
  const out = {};
  try {
    const keys = OWNER_KEYS.map(k => `tally_owner_${k}`);
    const ph = keys.map(() => '?').join(',');
    const rows = db.prepare(`SELECT key, value FROM app_settings WHERE key IN (${ph})`).all(...keys);
    for (const r of rows) out[r.key.replace('tally_owner_', '')] = r.value ? Number(r.value) : null;
  } catch (e) { /* defaults below */ }
  return out;
}

function ownerUser(db, ownerKey, bill) {
  const owners = getOwners(db);
  const id = owners[ownerKey];
  if (id) {
    const u = db.prepare('SELECT id, name, email FROM users WHERE id=?').get(id);
    if (u) return u;
  }
  // Fallback so a bill is never ownerless before Settings is filled in:
  // the person who uploaded it.
  if (bill?.created_by) return db.prepare('SELECT id, name, email FROM users WHERE id=?').get(bill.created_by) || null;
  return null;
}

// Request-scoped owner resolver (hang-audit findings #2/#12/#26). ownerUser()
// costs 2 fresh queries per call — fine for a single-bill action, an N+1 when a
// register page or report calls it per row/stage. This builds the ≤5 configured
// seat users + every distinct created_by fallback in 2 queries total, then
// resolves from Maps.
function makeOwnerResolver(db, bills) {
  const owners = getOwners(db);
  const ids = new Set(Object.values(owners).filter(Boolean));
  for (const b of bills) if (b.created_by) ids.add(b.created_by);
  const usersById = new Map();
  const idList = [...ids];
  for (let i = 0; i < idList.length; i += 400) {
    const chunk = idList.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const u of db.prepare(`SELECT id, name, email FROM users WHERE id IN (${ph})`).all(...chunk)) {
      usersById.set(u.id, u);
    }
  }
  return (ownerKey, bill) => {
    const u = usersById.get(owners[ownerKey]);
    if (u) return u;
    return bill?.created_by ? (usersById.get(bill.created_by) || null) : null;
  };
}

// ─── Notifications (spec §8) ─────────────────────────────────────────
// In-app row + web push + the configurable email-trigger engine. Never throws
// into the request path — a bill must save even if the mail server is down.
function notify(db, userIds, { type, title, body, link, dedupe }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  if (!ids.length) return;
  try {
    const ins = db.prepare(`
      INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?,?,?,?,?,'in_app',?)`);
    for (const id of ids) ins.run(id, type, title, body || null, link || null, dedupe || null);
  } catch (e) { console.warn('[tally-bills] in-app notify failed:', e.message); }
  try { push.notifyMany(ids, { title, body: body || '', url: link || '/tally-bills' }); }
  catch (e) { console.warn('[tally-bills] push failed:', e.message); }
}

function billEmailCtx(db, bill) {
  const owners = getOwners(db);
  const mail = (k) => {
    const id = owners[k];
    if (!id) return null;
    return db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || null;
  };
  return {
    register_no: bill.register_no,
    bill_no: bill.bill_number,
    vendor: bill.vendor_name,
    project: bill.project_name || '',
    category: CATEGORIES[bill.category] || bill.category,
    amount: bill.bill_amount,
    approved_amount: bill.approved_amount ?? '',
    status: STATUS_LABEL[bill.status] || bill.status,
    date: istToday(),
    site_engineer_email: mail('site_engineer'),
    coordinator_email: mail('coordinator'),
    executor_email: mail('executor'),
    director_email: mail('director'),
  };
}

const fireMail = (event, db, bill, extra = {}) => {
  try { fireEmailEvent(event, { ...billEmailCtx(db, bill), ...extra }); }
  catch (e) { console.warn('[tally-bills] email event failed:', e.message); }
};

// ─── Reads ───────────────────────────────────────────────────────────
const getBill = (db, id) => db.prepare('SELECT * FROM tally_bills WHERE id=?').get(id);
const getHolds = (db, id) => db.prepare('SELECT from_at, to_at FROM tally_bill_holds WHERE bill_id=? ORDER BY id').all(id);

// Holds for many bills at once, so the register doesn't run one query per row.
function holdsByBill(db, ids) {
  const out = {};
  for (let i = 0; i < ids.length; i += 400) {
    const chunk = ids.slice(i, i + 400);
    const ph = chunk.map(() => '?').join(',');
    for (const h of db.prepare(
      `SELECT bill_id, from_at, to_at FROM tally_bill_holds WHERE bill_id IN (${ph}) ORDER BY id`
    ).all(...chunk)) {
      (out[h.bill_id] = out[h.bill_id] || []).push(h);
    }
  }
  return out;
}

function linkedTasks(db, billId) {
  try {
    return db.prepare(`
      SELECT t.id, t.title, t.status, t.due_date, t.assigned_to, t.proof_url,
             t.reviewed_at, t.submitted_at, t.created_at, u.name AS assigned_to_name
        FROM pms_tasks t LEFT JOIN users u ON u.id = t.assigned_to
       WHERE t.tally_bill_id = ? ORDER BY t.id`).all(billId);
  } catch (e) { return []; }
}

// Attach the computed SLA block + display labels to a raw row. `resolve` is a
// makeOwnerResolver() map lookup when decorating many rows; the per-call
// ownerUser fallback stays for single-bill paths (detail, actions).
function decorate(db, bill, ctx, holds, nowMs = Date.now(), resolve = null) {
  const s = sla.billSla(bill, holds, ctx, nowMs);
  const owner = s.current_owner_key
    ? (resolve ? resolve(s.current_owner_key, bill) : ownerUser(db, s.current_owner_key, bill))
    : null;
  const approved = bill.approved_amount == null ? null : num(bill.approved_amount);
  return {
    ...bill,
    category_label: CATEGORIES[bill.category] || bill.category,
    status_label: STATUS_LABEL[bill.status] || bill.status,
    sla: s,
    current_owner_id: owner?.id || null,
    current_owner_name: owner?.name || null,
    balance: approved == null ? null : round2(approved - num(bill.amount_received)),
    variance_amount: bill.variance_amount == null ? null : round2(bill.variance_amount),
  };
}

// ─── Stage 3 auto-close ──────────────────────────────────────────────
// A bill leaves Stage 3 when the LAST linked PMS task closes.  Called from the
// PMS task approve handler (routes/pmstasks.js) AND lazily on every read here,
// so the stage still advances if a task was closed by some other path.
// Returns true when it moved the bill forward.
function syncTaskCompletion(db, billId, actor = null) {
  const bill = getBill(db, billId);
  if (!bill) return false;
  if (!bill.t1_tasks_created_at || bill.t2_tasks_completed_at) return false;
  if (bill.status === 'on_hold' || bill.status === 'rejected') return false;

  const tasks = linkedTasks(db, billId);
  if (!tasks.length) return false;
  if (!tasks.every(t => t.status === 'approved')) return false;

  const ctx = sla.makeCtx(db);
  const nowMs = Date.now();
  const t2 = sla.toSqlUtc(nowMs);
  // Stage 4 starts now, so no hold time can exist inside its window yet.
  const t3Due = sla.toSqlUtc(sla.addBusinessMinutes(nowMs, ctx.cfg.stage4_hours * 60, ctx));

  db.prepare(`UPDATE tally_bills
                 SET t2_tasks_completed_at=?, t3_due_at=?, status='pending_approval',
                     updated_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(t2, t3Due, billId);

  try {
    db.prepare(`INSERT INTO tally_bill_audit (bill_id, action, field, old_value, new_value, note, user_id, user_name)
                VALUES (?,?,?,?,?,?,?,?)`)
      .run(billId, 'stage', 'status', bill.status, 'pending_approval',
           `All ${tasks.length} linked PMS task(s) completed — T2`, actor?.id || null, actor?.name || null);
  } catch (e) { /* audit must never block the transition */ }

  const fresh = getBill(db, billId);
  const coord = ownerUser(db, 'coordinator', fresh);
  notify(db, coord?.id, {
    type: 'tally_bill_approval',
    title: `Bill ${fresh.register_no} ready for approval`,
    body: [fresh.vendor_name, CATEGORIES[fresh.category], `Rs ${num(fresh.bill_amount).toLocaleString('en-IN')}`].filter(Boolean).join(' · '),
    link: `/tally-bills?bill=${billId}`,
    dedupe: `tally-approval-${billId}`,
  });
  fireMail('tally_bill.tasks_completed', db, fresh);
  return true;
}

// ─── Bill Register (spec §7) ─────────────────────────────────────────
// Hang-audit findings #1/#6/#11: everything here is bounded per request —
// SQL-side LIMIT/OFFSET (X-Total-Count carries the full count), ONE query
// (targeted re-reads only for bills the self-heal actually advanced), and the
// stage-3 self-heal batched to one grouped query instead of per-bill probing.
const REGISTER_PAGE_MAX = 2000;
router.get('/', requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { category, project_id, vendor, status, owner, from, to, search } = req.query;
    const breachedOnly = req.query.breached === '1' || req.query.breached === 'true';
    const limit = Math.min(REGISTER_PAGE_MAX, Math.max(1, parseInt(req.query.limit, 10) || 500));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

    let where = ' WHERE 1=1';
    const p = [];
    // Default view is ALL categories (§3) — the tab only narrows when asked.
    if (category && CATEGORIES[category]) { where += ' AND b.category = ?'; p.push(category); }
    if (project_id) { where += ' AND b.project_id = ?'; p.push(project_id); }
    if (vendor) { where += ' AND b.vendor_name LIKE ?'; p.push(`%${vendor}%`); }
    if (status) { where += ' AND b.status = ?'; p.push(status); }
    if (from) { where += ' AND date(b.bill_date) >= date(?)'; p.push(from); }
    if (to) { where += ' AND date(b.bill_date) <= date(?)'; p.push(to); }
    if (search) {
      where += ' AND (b.bill_number LIKE ? OR b.vendor_name LIKE ? OR b.register_no LIKE ? OR b.project_name LIKE ?)';
      const q = `%${search}%`; p.push(q, q, q, q);
    }

    const total = db.prepare(`SELECT COUNT(*) AS c FROM tally_bills b${where}`).get(...p).c;
    // Live work first, closed/rejected at the bottom.
    const rows = db.prepare(`
      SELECT b.*, u.name AS created_by_name
        FROM tally_bills b LEFT JOIN users u ON u.id = b.created_by
        ${where}
       ORDER BY CASE WHEN b.status IN ('closed','rejected') THEN 1 ELSE 0 END, b.created_at DESC
       LIMIT ? OFFSET ?`).all(...p, limit, offset);

    // Lazy Stage-3 self-heal, batched: ONE grouped query finds which candidate
    // bills have all their tasks approved; only those run syncTaskCompletion
    // (which re-verifies internally) and only those are re-read afterwards.
    const candidates = rows.filter(r =>
      r.t1_tasks_created_at && !r.t2_tasks_completed_at && !['on_hold', 'rejected'].includes(r.status));
    if (candidates.length) {
      const ids = candidates.map(r => r.id);
      const ph = ids.map(() => '?').join(',');
      const ready = db.prepare(`
        SELECT tally_bill_id AS id FROM pms_tasks
         WHERE tally_bill_id IN (${ph})
         GROUP BY tally_bill_id
        HAVING COUNT(*) > 0 AND SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END) = COUNT(*)`).all(...ids);
      for (const r of ready) {
        try {
          if (syncTaskCompletion(db, r.id, req.user)) {
            const idx = rows.findIndex(x => x.id === r.id);
            if (idx >= 0) rows[idx] = { ...rows[idx], ...getBill(db, r.id) };
          }
        } catch (e) { /* keep listing */ }
      }
    }

    const ctx = sla.makeCtx(db);
    const nowMs = Date.now();
    const holds = holdsByBill(db, rows.map(r => r.id));
    const resolve = makeOwnerResolver(db, rows);
    let out = rows.map(b => decorate(db, b, ctx, holds[b.id] || [], nowMs, resolve));

    // Owner/breached depend on computed state, so they filter the page —
    // acceptable at ≤500 rows, unlike the old whole-table decoration.
    if (owner) out = out.filter(b => String(b.current_owner_id) === String(owner));
    if (breachedOnly) out = out.filter(b => b.sla.overdue);

    res.set('X-Total-Count', String(total));
    res.json(out);
  } catch (e) {
    console.error('[tally-bills] list failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Dropdown data for the form — projects, vendors, sites, assignable users.
router.get('/meta', requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    res.json({
      // Business Book PROJECT NAMES ONLY (mam 2026-08-13) — no client-name
      // fallback (it filled the picker with client names and junk rows), and
      // exact duplicate names collapse to the most recent entry.
      projects: db.prepare(
        `SELECT MAX(id) AS id, TRIM(project_name) AS name
           FROM business_book
          WHERE project_name IS NOT NULL AND TRIM(project_name) <> ''
          GROUP BY LOWER(TRIM(project_name))
          ORDER BY name COLLATE NOCASE`).all(),
      vendors: db.prepare(`SELECT id, name, firm_name FROM vendors ORDER BY name LIMIT 1000`).all(),
      sites: db.prepare(`SELECT id, name FROM sites WHERE status='active' ORDER BY name`).all(),
      users: db.prepare(`SELECT id, name, email FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 ORDER BY name`).all(),
      categories: CATEGORIES,
      statuses: STATUS_LABEL,
      can_approve: canApprove(db, req.user),
      is_admin: isAdmin(req.user),
      config: sla.getConfig(db),
      owners: getOwners(db),
    });
  } catch (e) {
    console.error('[tally-bills] meta failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Full detail — attachments, payments, linked tasks, holds, audit trail.
router.get('/:id', requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    const id = +req.params.id;
    if (!getBill(db, id)) return res.status(404).json({ error: 'Bill not found' });
    try { syncTaskCompletion(db, id, req.user); } catch (e) { /* keep serving */ }

    const bill = getBill(db, id);
    const ctx = sla.makeCtx(db);
    const holds = getHolds(db, id);
    res.json({
      ...decorate(db, bill, ctx, holds),
      files: db.prepare('SELECT * FROM tally_bill_files WHERE bill_id=? ORDER BY id').all(id),
      payments: db.prepare(
        `SELECT p.*, u.name AS created_by_name FROM tally_bill_payments p
           LEFT JOIN users u ON u.id = p.created_by
          WHERE p.bill_id=? ORDER BY p.received_date, p.id`).all(id),
      tasks: linkedTasks(db, id),
      holds: db.prepare(
        `SELECT h.*, hu.name AS held_by_name, ru.name AS released_by_name
           FROM tally_bill_holds h
           LEFT JOIN users hu ON hu.id = h.held_by
           LEFT JOIN users ru ON ru.id = h.released_by
          WHERE h.bill_id=? ORDER BY h.id`).all(id),
      audit: db.prepare('SELECT * FROM tally_bill_audit WHERE bill_id=? ORDER BY id DESC LIMIT 500').all(id),
    });
  } catch (e) {
    console.error('[tally-bills] detail failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Stage 1: upload the Tally bill (T0 — starts the SLA clock) ──────
router.post('/', requirePermission('tally_bills', 'create'),
  upload.array('files', 10), handleUploadErrors, async (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const cleanup = () => unlinkQuiet(req.files);
  try {
    const category = String(b.category || '').trim();
    const vendorName = String(b.vendor_name || '').trim();
    const billNumber = String(b.bill_number || '').trim();

    if (!CATEGORIES[category]) { cleanup(); return res.status(400).json({ error: 'Category must be Material, Testing & Commissioning or Handover' }); }
    if (!b.project_id)  { cleanup(); return res.status(400).json({ error: 'Project / Site is required' }); }
    // Vendor is OPTIONAL (mam 2026-08-13 "no need here vendor"). With no
    // vendor the unique index's LOWER(TRIM('')) leg still holds, so the
    // duplicate rule degrades to bill-number-only among vendor-less bills.
    if (!billNumber)    { cleanup(); return res.status(400).json({ error: 'Bill Number is required' }); }
    if (!b.bill_date)   { cleanup(); return res.status(400).json({ error: 'Bill Date is required' }); }
    if (!(num(b.bill_amount) > 0)) { cleanup(); return res.status(400).json({ error: 'Bill Amount must be greater than zero' }); }
    if (!req.files || !req.files.length) { cleanup(); return res.status(400).json({ error: 'At least one bill file must be uploaded' }); }

    // Acceptance criterion 4 — duplicate Bill Number for the SAME vendor is
    // rejected. Checked here for a readable message; the unique index in
    // schema.js is the real guarantee against a concurrent double-submit.
    const dupe = db.prepare(
      `SELECT register_no FROM tally_bills
        WHERE LOWER(TRIM(vendor_name)) = LOWER(TRIM(?)) AND LOWER(TRIM(bill_number)) = LOWER(TRIM(?))`
    ).get(vendorName, billNumber);
    if (dupe) {
      cleanup();
      return res.status(400).json({
        error: vendorName
          ? `Bill ${billNumber} already exists for ${vendorName} (${dupe.register_no})`
          : `Bill ${billNumber} already exists (${dupe.register_no})`,
      });
    }

    const project = db.prepare(
      `SELECT COALESCE(NULLIF(project_name,''), client_name) AS name FROM business_book WHERE id=?`
    ).get(b.project_id);
    const site = b.site_id ? db.prepare('SELECT name FROM sites WHERE id=?').get(b.site_id) : null;

    const stored = await adoptFiles(req.files);

    const ctx = sla.makeCtx(db);
    const nowMs = Date.now();
    const t0 = sla.toSqlUtc(nowMs);
    const t1Due = sla.toSqlUtc(sla.addBusinessMinutes(nowMs, ctx.cfg.stage2_days * ctx.perDay, ctx));
    const registerNo = nextRegisterNo(db);

    const info = db.prepare(`
      INSERT INTO tally_bills
        (register_no, project_id, project_name, site_id, site_name, category,
         vendor_id, vendor_name, bill_number, bill_date, bill_amount, remarks,
         status, t0_uploaded_at, t1_due_at, created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending_task_creation',?,?,?)`).run(
      registerNo, +b.project_id, project?.name || null, b.site_id ? +b.site_id : null, site?.name || null,
      category, b.vendor_id ? +b.vendor_id : null, vendorName, billNumber, b.bill_date,
      round2(b.bill_amount), b.remarks || null, t0, t1Due, req.user.id);

    const billId = info.lastInsertRowid;
    const insFile = db.prepare(
      `INSERT INTO tally_bill_files (bill_id, kind, file_url, file_name, file_size, uploaded_by)
       VALUES (?,'bill',?,?,?,?)`);
    for (const f of stored) insFile.run(billId, f.url, f.name, f.size, req.user.id);

    audit(db, billId, 'create', [
      { field: 'status', old: null, new: 'pending_task_creation', note: 'Bill uploaded — T0, SLA clock started' },
      { field: 'bill_amount', old: null, new: round2(b.bill_amount) },
      vendorName ? { field: 'vendor_name', old: null, new: vendorName } : null,
      { field: 'bill_number', old: null, new: billNumber },
      { field: 'category', old: null, new: category },
      { field: 'attachments', old: null, new: `${stored.length} file(s)` },
    ], req);

    const bill = getBill(db, billId);
    const coord = ownerUser(db, 'coordinator', bill);
    notify(db, coord?.id, {
      type: 'tally_bill_uploaded',
      title: `New bill ${registerNo} — create PMS tasks`,
      body: [vendorName, CATEGORIES[category], `Rs ${round2(b.bill_amount).toLocaleString('en-IN')}`, `due ${t1Due} UTC`].filter(Boolean).join(' · '),
      link: `/tally-bills?bill=${billId}`,
      dedupe: `tally-upload-${billId}`,
    });
    fireMail('tally_bill.uploaded', db, bill);

    res.status(201).json(decorate(db, bill, ctx, []));
  } catch (e) {
    cleanup();
    if (String(e.message).includes('UNIQUE constraint failed')) {
      return res.status(400).json({ error: 'That bill number already exists for this vendor' });
    }
    console.error('[tally-bills] create failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Edit header fields. After approval the amount + attachments are locked (§9);
// a Director unlock is required to touch them again.
router.put('/:id', requirePermission('tally_bills', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const id = +req.params.id;
    const bill = getBill(db, id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });

    const b = req.body || {};
    const changes = [];
    const sets = [];
    const vals = [];

    const put = (field, value, { locked = false } = {}) => {
      if (value === undefined) return;
      const cur = bill[field];
      const next = value === '' ? null : value;
      if (String(cur ?? '') === String(next ?? '')) return;
      if (locked && bill.locked) {
        const err = new Error(`${field} is locked after approval — a Director unlock with reason is required`);
        err.status = 423;
        throw err;
      }
      sets.push(`${field}=?`); vals.push(next);
      changes.push({ field, old: cur, new: next });
    };

    put('bill_amount', b.bill_amount === undefined ? undefined : round2(b.bill_amount), { locked: true });
    put('bill_number', b.bill_number === undefined ? undefined : String(b.bill_number).trim(), { locked: true });
    put('vendor_name', b.vendor_name === undefined ? undefined : String(b.vendor_name).trim(), { locked: true });
    put('bill_date', b.bill_date, { locked: true });
    put('category', b.category && CATEGORIES[b.category] ? b.category : undefined);
    put('remarks', b.remarks);
    if (b.project_id !== undefined) {
      const pr = db.prepare(
        `SELECT COALESCE(NULLIF(project_name,''), client_name) AS name FROM business_book WHERE id=?`).get(b.project_id);
      put('project_id', +b.project_id);
      put('project_name', pr?.name || null);
    }
    if (b.site_id !== undefined) {
      const st = b.site_id ? db.prepare('SELECT name FROM sites WHERE id=?').get(b.site_id) : null;
      put('site_id', b.site_id ? +b.site_id : null);
      put('site_name', st?.name || null);
    }

    if (!sets.length) return res.json({ ok: true, unchanged: true });

    // Re-check the duplicate pair when either half of the key moved.
    if (b.bill_number !== undefined || b.vendor_name !== undefined) {
      const vn = b.vendor_name !== undefined ? String(b.vendor_name).trim() : bill.vendor_name;
      const bn = b.bill_number !== undefined ? String(b.bill_number).trim() : bill.bill_number;
      const dupe = db.prepare(
        `SELECT register_no FROM tally_bills
          WHERE LOWER(TRIM(vendor_name))=LOWER(TRIM(?)) AND LOWER(TRIM(bill_number))=LOWER(TRIM(?)) AND id<>?`
      ).get(vn, bn, id);
      if (dupe) return res.status(400).json({ error: `Bill ${bn} already exists for ${vn} (${dupe.register_no})` });
    }

    db.prepare(`UPDATE tally_bills SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...vals, id);
    audit(db, id, 'update', changes, req);
    res.json({ ok: true });
  } catch (e) {
    if (e.status === 423) return res.status(423).json({ error: e.message });
    console.error('[tally-bills] update failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id', requirePermission('tally_bills', 'delete'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    // Cash has moved — deleting would orphan the payment record.
    if (num(bill.amount_received) > 0 && !isAdmin(req.user)) {
      return res.status(400).json({ error: 'Payments are recorded against this bill — only an admin can delete it' });
    }
    db.prepare('DELETE FROM tally_bills WHERE id=?').run(bill.id);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] delete failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Attachments ─────────────────────────────────────────────────────
router.post('/:id/files', requirePermission('tally_bills', 'edit'),
  upload.array('files', 10), handleUploadErrors, async (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) { unlinkQuiet(req.files); return res.status(404).json({ error: 'Bill not found' }); }
    if (bill.locked) { unlinkQuiet(req.files); return res.status(423).json({ error: 'Attachments are locked after approval — a Director unlock is required' }); }
    if (!req.files?.length) return res.status(400).json({ error: 'No files uploaded' });

    const stored = await adoptFiles(req.files);
    const ins = db.prepare(
      `INSERT INTO tally_bill_files (bill_id, kind, file_url, file_name, file_size, uploaded_by)
       VALUES (?,'bill',?,?,?,?)`);
    for (const f of stored) ins.run(bill.id, f.url, f.name, f.size, req.user.id);
    audit(db, bill.id, 'update', { field: 'attachments', old: null, new: stored.map(f => f.name).join(', ') }, req);
    res.json({ ok: true, files: stored });
  } catch (e) {
    unlinkQuiet(req.files);
    console.error('[tally-bills] file add failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/files/:fileId', requirePermission('tally_bills', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.locked) return res.status(423).json({ error: 'Attachments are locked after approval — a Director unlock is required' });
    const f = db.prepare('SELECT * FROM tally_bill_files WHERE id=? AND bill_id=?').get(+req.params.fileId, bill.id);
    if (!f) return res.status(404).json({ error: 'File not found' });
    db.prepare('DELETE FROM tally_bill_files WHERE id=?').run(f.id);
    audit(db, bill.id, 'update', { field: 'attachments', old: f.file_name, new: null, note: 'Attachment removed' }, req);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] file delete failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Stage 2: PMS tasks ──────────────────────────────────────────────
// Create a task against the bill. Mirrors the PMS Tasks module's own shape so
// the task shows up there exactly like any other, just carrying tally_bill_id.
router.post('/:id/tasks', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is On Hold — release it first' });
    if (bill.status === 'rejected') return res.status(400).json({ error: 'Bill was rejected' });
    if (bill.t2_tasks_completed_at) return res.status(400).json({ error: 'Task stage is already complete for this bill' });

    const t = req.body || {};
    if (!String(t.title || '').trim()) return res.status(400).json({ error: 'Task title is required' });
    if (!t.assigned_to) return res.status(400).json({ error: 'Task must be assigned to someone' });

    const info = db.prepare(`
      INSERT INTO pms_tasks (title, description, project_id, project_name_snapshot,
                             assigned_by, assigned_to, due_date, status, tally_bill_id)
      VALUES (?,?,?,?,?,?,?,'pending',?)`).run(
      String(t.title).trim(), t.description || null, bill.project_id, bill.project_name,
      req.user.id, +t.assigned_to, t.due_date || null, bill.id);

    audit(db, bill.id, 'update',
      { field: 'pms_task', old: null, new: String(t.title).trim(), note: `Task #${info.lastInsertRowid} created` }, req);

    notify(db, +t.assigned_to, {
      type: 'tally_bill_task',
      title: `New task for bill ${bill.register_no}`,
      body: String(t.title).trim(),
      link: `/pms-tasks`,
    });
    res.status(201).json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    console.error('[tally-bills] task create failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// "Task Creation Complete" — T1. Requires at least one linked task (§4 Stage 2).
router.post('/:id/tasks-complete', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is On Hold — release it first' });
    if (bill.t1_tasks_created_at) return res.status(400).json({ error: 'Task creation is already marked complete' });

    const tasks = linkedTasks(db, bill.id);
    if (!tasks.length) return res.status(400).json({ error: 'Create at least one PMS task before marking this complete' });

    const ctx = sla.makeCtx(db);
    const nowMs = Date.now();
    const t1 = sla.toSqlUtc(nowMs);
    const t2Due = sla.toSqlUtc(sla.addBusinessMinutes(nowMs, ctx.cfg.stage3_days * ctx.perDay, ctx));

    db.prepare(`UPDATE tally_bills SET t1_tasks_created_at=?, t2_due_at=?, status='tasks_in_progress',
                                       updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(t1, t2Due, bill.id);
    audit(db, bill.id, 'stage', {
      field: 'status', old: bill.status, new: 'tasks_in_progress',
      note: `Task creation complete — T1, ${tasks.length} task(s)`,
    }, req);

    const fresh = getBill(db, bill.id);
    notify(db, tasks.map(t => t.assigned_to), {
      type: 'tally_bill_task',
      title: `Tasks live for bill ${bill.register_no}`,
      body: `Complete your task(s) by ${t2Due} UTC`,
      link: '/pms-tasks',
      dedupe: `tally-tasks-live-${bill.id}`,
    });
    fireMail('tally_bill.tasks_created', db, fresh, { task_count: tasks.length });
    // A single-task bill whose task is already approved should not sit and wait.
    syncTaskCompletion(db, bill.id, req.user);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] tasks-complete failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Stage 4: approval + payment release ─────────────────────────────
router.post('/:id/approve', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is On Hold — release it first' });
    // No stage skipping (§9).
    if (bill.status !== 'pending_approval') {
      return res.status(400).json({ error: `Bill is "${STATUS_LABEL[bill.status]}" — it can only be approved from Pending Approval` });
    }

    const billAmt = num(bill.bill_amount);
    // Spec §4: the field is PRE-FILLED with the Tally amount, so an omitted
    // value means "approve as billed", not "approve zero".
    const approved = req.body.approved_amount === undefined || req.body.approved_amount === ''
      ? billAmt : round2(req.body.approved_amount);
    const remark = String(req.body.remark || '').trim();

    if (!(approved > 0)) return res.status(400).json({ error: 'Approved amount must be greater than zero' });
    // Editing the amount forces a remark (§4 / acceptance criterion 3).
    if (Math.abs(approved - billAmt) > PAISA && !remark) {
      return res.status(400).json({ error: 'A remark is mandatory when the payment amount is changed from the bill amount' });
    }

    const cfg = sla.getConfig(db);
    const threshold = num(cfg.second_approval_threshold);
    const needsSecond = approved > billAmt + threshold + PAISA;

    const variance = round2(billAmt - approved);
    const variancePct = billAmt > 0 ? round2((variance / billAmt) * 100) : 0;

    if (needsSecond && !isAdmin(req.user)) {
      // Park it: the amount is recorded but T3 is NOT stamped, so the Stage 4
      // clock keeps running until the Director signs off.
      db.prepare(`UPDATE tally_bills
                     SET approved_amount=?, approval_remark=?, variance_amount=?, variance_pct=?,
                         approved_by=?, second_approval_required=1, updated_at=CURRENT_TIMESTAMP
                   WHERE id=?`).run(approved, remark || null, variance, variancePct, req.user.id, bill.id);
      audit(db, bill.id, 'stage', [
        { field: 'approved_amount', old: bill.approved_amount, new: approved,
          note: `Exceeds bill amount by Rs ${round2(approved - billAmt)} — Director approval required` },
        { field: 'second_approval_required', old: 0, new: 1 },
      ], req, remark || null);

      const fresh = getBill(db, bill.id);
      const dir = ownerUser(db, 'director', fresh);
      notify(db, dir?.id, {
        type: 'tally_bill_second_approval',
        title: `Director approval needed — ${bill.register_no}`,
        body: `Approved Rs ${approved.toLocaleString('en-IN')} vs bill Rs ${billAmt.toLocaleString('en-IN')}`,
        link: `/tally-bills?bill=${bill.id}`,
        dedupe: `tally-second-${bill.id}`,
      });
      fireMail('tally_bill.second_approval_required', db, fresh);
      return res.json({ ok: true, second_approval_required: true });
    }

    finaliseApproval(db, bill, { approved, remark, variance, variancePct, req, second: needsSecond });
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] approve failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Stamp T3, set the payment plan date, and lock the bill.
function finaliseApproval(db, bill, { approved, remark, variance, variancePct, req, second }) {
  const ctx = sla.makeCtx(db);
  const nowMs = Date.now();
  const t3 = sla.toSqlUtc(nowMs);
  const expectedMs = sla.addDaysByBasis(nowMs, ctx.cfg.payment_days, ctx);
  const t4Due = sla.toSqlUtc(expectedMs);
  const expectedDate = new Date(expectedMs).toISOString().slice(0, 10);

  db.prepare(`UPDATE tally_bills
                 SET approved_amount=?, approval_remark=?, variance_amount=?, variance_pct=?,
                     approved_by=COALESCE(approved_by, ?), t3_approved_at=?, t4_due_at=?,
                     payment_expected_date=?, status='payment_pending', locked=1,
                     second_approval_required=?, updated_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(
    approved, remark || null, variance, variancePct, req.user.id, t3, t4Due,
    expectedDate, second ? 1 : 0, bill.id);

  audit(db, bill.id, 'stage', [
    { field: 'status', old: bill.status, new: 'payment_pending', note: 'Approved — T3; bill locked' },
    { field: 'approved_amount', old: bill.approved_amount, new: approved },
    { field: 'variance_amount', old: bill.variance_amount, new: variance },
    { field: 'payment_expected_date', old: bill.payment_expected_date, new: expectedDate },
  ], req, remark || null);

  const fresh = getBill(db, bill.id);
  const eng = ownerUser(db, 'site_engineer', fresh);
  notify(db, eng?.id, {
    type: 'tally_bill_approved',
    title: `Bill ${bill.register_no} approved — payment due ${expectedDate}`,
    body: `Rs ${approved.toLocaleString('en-IN')}${bill.vendor_name ? ` to ${bill.vendor_name}` : ''}`,
    link: `/tally-bills?bill=${bill.id}`,
    dedupe: `tally-approved-${bill.id}`,
  });
  fireMail('tally_bill.approved', db, fresh, { expected_date: expectedDate });
}

// Director second-level sign-off for an over-bill approval (§4).
router.post('/:id/second-approve', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Director / admin can give second-level approval' });
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (!bill.second_approval_required || bill.t3_approved_at) {
      return res.status(400).json({ error: 'This bill is not awaiting second-level approval' });
    }
    // finaliseApproval writes status — on a held bill that would silently
    // overwrite 'on_hold' and leave the hold window open forever.
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is On Hold — release it first' });
    const remark = String(req.body.remark || '').trim();
    if (!remark) return res.status(400).json({ error: 'A remark is required for second-level approval' });

    db.prepare(`UPDATE tally_bills SET second_approved_by=?, second_approved_at=CURRENT_TIMESTAMP,
                                       second_approval_remark=? WHERE id=?`).run(req.user.id, remark, bill.id);
    audit(db, bill.id, 'stage', { field: 'second_approval', old: 'pending', new: 'approved' }, req, remark);

    finaliseApproval(db, getBill(db, bill.id), {
      approved: num(bill.approved_amount),
      remark: bill.approval_remark,
      variance: num(bill.variance_amount),
      variancePct: num(bill.variance_pct),
      req, second: true,
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] second-approve failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Hold / release / reject ─────────────────────────────────────────
router.post('/:id/hold', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is already on hold' });
    if (['closed', 'rejected'].includes(bill.status)) return res.status(400).json({ error: 'Bill is already closed' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to put a bill on hold' });

    const stageKey = sla.currentStageKey(bill);
    db.prepare(`INSERT INTO tally_bill_holds (bill_id, stage_key, reason, held_by) VALUES (?,?,?,?)`)
      .run(bill.id, stageKey, reason, req.user.id);
    db.prepare(`UPDATE tally_bills SET status='on_hold', status_before_hold=?, hold_reason=?,
                                       held_at=CURRENT_TIMESTAMP, held_by=?, updated_at=CURRENT_TIMESTAMP
                 WHERE id=?`).run(bill.status, reason, req.user.id, bill.id);
    audit(db, bill.id, 'hold', { field: 'status', old: bill.status, new: 'on_hold' }, req, reason);
    fireMail('tally_bill.held', db, getBill(db, bill.id), { reason });
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] hold failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/release', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (bill.status !== 'on_hold') return res.status(400).json({ error: 'Bill is not on hold' });

    const open = db.prepare(
      'SELECT id FROM tally_bill_holds WHERE bill_id=? AND to_at IS NULL ORDER BY id DESC LIMIT 1').get(bill.id);
    if (open) {
      db.prepare('UPDATE tally_bill_holds SET to_at=CURRENT_TIMESTAMP, released_by=?, release_remark=? WHERE id=?')
        .run(req.user.id, req.body.remark || null, open.id);
    }
    const restore = bill.status_before_hold || 'pending_task_creation';
    db.prepare(`UPDATE tally_bills SET status=?, status_before_hold=NULL, hold_reason=NULL,
                                       updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(restore, bill.id);
    audit(db, bill.id, 'hold', { field: 'status', old: 'on_hold', new: restore, note: 'Hold released — clock resumed' },
      req, req.body.remark || null);
    res.json({ ok: true, status: restore });
  } catch (e) {
    console.error('[tally-bills] release failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/reject', requirePermission('tally_bills', 'approve'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (['closed', 'rejected'].includes(bill.status)) return res.status(400).json({ error: 'Bill is already closed' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to reject a bill' });

    db.prepare(`UPDATE tally_bills SET status='rejected', reject_reason=?, rejected_by=?,
                                       rejected_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
                 WHERE id=?`).run(reason, req.user.id, bill.id);
    audit(db, bill.id, 'stage', { field: 'status', old: bill.status, new: 'rejected' }, req, reason);

    const fresh = getBill(db, bill.id);
    notify(db, [fresh.created_by, ownerUser(db, 'site_engineer', fresh)?.id], {
      type: 'tally_bill_rejected',
      title: `Bill ${fresh.register_no} rejected`,
      body: reason,
      link: `/tally-bills?bill=${bill.id}`,
      dedupe: `tally-rejected-${bill.id}`,
    });
    fireMail('tally_bill.rejected', db, fresh, { reason });
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] reject failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// Director override — unlock an approved bill so amount/attachments can change (§9).
router.post('/:id/unlock', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only a Director / admin can unlock an approved bill' });
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    if (!bill.locked) return res.status(400).json({ error: 'Bill is not locked' });
    const reason = String(req.body.reason || '').trim();
    if (!reason) return res.status(400).json({ error: 'A reason is required to unlock a bill' });

    db.prepare(`UPDATE tally_bills SET locked=0, unlock_reason=?, unlocked_by=?,
                                       unlocked_at=CURRENT_TIMESTAMP WHERE id=?`).run(reason, req.user.id, bill.id);
    audit(db, bill.id, 'unlock', { field: 'locked', old: 1, new: 0 }, req, reason);
    res.json({ ok: true });
  } catch (e) {
    console.error('[tally-bills] unlock failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Stage 5: payment received (partial payments supported) ──────────
router.post('/:id/payments', requirePermission('tally_bills', 'edit'),
  upload.array('files', 5), handleUploadErrors, async (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) { unlinkQuiet(req.files); return res.status(404).json({ error: 'Bill not found' }); }
    if (!bill.t3_approved_at) { unlinkQuiet(req.files); return res.status(400).json({ error: 'Bill is not approved yet — no payment can be recorded' }); }
    if (bill.status === 'rejected') { unlinkQuiet(req.files); return res.status(400).json({ error: 'Bill was rejected' }); }
    // A held bill's status is the hold itself; writing partially_paid/closed
    // here would be undone by Release restoring status_before_hold.
    if (bill.status === 'on_hold') { unlinkQuiet(req.files); return res.status(400).json({ error: 'Bill is On Hold — release it before recording a payment' }); }

    const amount = round2(req.body.amount);
    const receivedDate = req.body.received_date;
    if (!(amount > 0)) { unlinkQuiet(req.files); return res.status(400).json({ error: 'Amount Received is required' }); }
    if (!receivedDate) { unlinkQuiet(req.files); return res.status(400).json({ error: 'Payment Received Date is required' }); }

    const approved = num(bill.approved_amount);
    const already = num(db.prepare('SELECT COALESCE(SUM(amount),0) AS s FROM tally_bill_payments WHERE bill_id=?').get(bill.id).s);
    if (already + amount > approved + PAISA) {
      unlinkQuiet(req.files);
      return res.status(400).json({
        error: `That would exceed the approved amount. Approved Rs ${approved.toLocaleString('en-IN')}, already received Rs ${already.toLocaleString('en-IN')}, balance Rs ${round2(approved - already).toLocaleString('en-IN')}`,
      });
    }

    const stored = await adoptFiles(req.files);
    const info = db.prepare(`
      INSERT INTO tally_bill_payments (bill_id, received_date, amount, utr_ref, proof_url, remarks, created_by)
      VALUES (?,?,?,?,?,?,?)`).run(
      bill.id, receivedDate, amount, req.body.utr_ref || null,
      stored[0]?.url || null, req.body.remarks || null, req.user.id);

    const insFile = db.prepare(
      `INSERT INTO tally_bill_files (bill_id, payment_id, kind, file_url, file_name, file_size, uploaded_by)
       VALUES (?,?,'payment_proof',?,?,?,?)`);
    for (const f of stored) insFile.run(bill.id, info.lastInsertRowid, f.url, f.name, f.size, req.user.id);

    const received = round2(already + amount);
    const fullyPaid = received >= approved - PAISA;
    const status = fullyPaid ? 'closed' : 'partially_paid';
    const t4 = fullyPaid ? sla.toSqlUtc(Date.now()) : null;

    db.prepare(`UPDATE tally_bills SET amount_received=?, status=?, t4_closed_at=COALESCE(?, t4_closed_at),
                                       updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(received, status, t4, bill.id);

    audit(db, bill.id, 'payment', [
      { field: 'amount_received', old: already, new: received,
        note: `Payment Rs ${amount.toLocaleString('en-IN')} on ${receivedDate}${req.body.utr_ref ? ` · UTR ${req.body.utr_ref}` : ''}` },
      { field: 'status', old: bill.status, new: status, note: fullyPaid ? 'Balance cleared — T4, bill Closed' : null },
    ], req, req.body.remarks || null);

    if (fullyPaid) fireMail('tally_bill.closed', db, getBill(db, bill.id));
    res.status(201).json({ ok: true, amount_received: received, balance: round2(approved - received), status });
  } catch (e) {
    unlinkQuiet(req.files);
    console.error('[tally-bills] payment failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/payments/:pid', requirePermission('tally_bills', 'delete'), (req, res) => {
  try {
    const db = getDb();
    const bill = getBill(db, +req.params.id);
    if (!bill) return res.status(404).json({ error: 'Bill not found' });
    const pay = db.prepare('SELECT * FROM tally_bill_payments WHERE id=? AND bill_id=?').get(+req.params.pid, bill.id);
    if (!pay) return res.status(404).json({ error: 'Payment not found' });
    // Same status-clobber risk as recording a payment — the reversal below
    // recomputes status, which must not overwrite 'on_hold'.
    if (bill.status === 'on_hold') return res.status(400).json({ error: 'Bill is On Hold — release it before reversing a payment' });

    db.prepare('DELETE FROM tally_bill_payments WHERE id=?').run(pay.id);
    const received = round2(num(db.prepare(
      'SELECT COALESCE(SUM(amount),0) AS s FROM tally_bill_payments WHERE bill_id=?').get(bill.id).s));
    const approved = num(bill.approved_amount);
    // Reversing a payment must reopen the bill, otherwise a deleted receipt
    // would leave it sitting in Closed with a non-zero balance.
    const status = received >= approved - PAISA ? 'closed' : (received > 0 ? 'partially_paid' : 'payment_pending');
    db.prepare(`UPDATE tally_bills SET amount_received=?, status=?,
                                       t4_closed_at = CASE WHEN ? = 'closed' THEN t4_closed_at ELSE NULL END,
                                       updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(received, status, status, bill.id);
    audit(db, bill.id, 'payment', [
      { field: 'amount_received', old: bill.amount_received, new: received, note: `Payment of Rs ${num(pay.amount).toLocaleString('en-IN')} reversed` },
      { field: 'status', old: bill.status, new: status },
    ], req);
    res.json({ ok: true, amount_received: received, status });
  } catch (e) {
    console.error('[tally-bills] payment delete failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Settings: SLA config, stage owners, holiday master (§6, §11) ────
router.get('/settings/all', requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    let holidays = [];
    try { holidays = db.prepare('SELECT holiday_date, label FROM procurement_holidays ORDER BY holiday_date').all(); }
    catch (e) { /* holiday table belongs to procurement-schedule; absent on a fresh DB */ }
    res.json({
      config: sla.getConfig(db),
      defaults: sla.DEFAULTS,
      owners: getOwners(db),
      owner_keys: OWNER_KEYS,
      users: db.prepare('SELECT id, name, email FROM users WHERE COALESCE(active,1)=1 AND COALESCE(archived,0)=0 ORDER BY name').all(),
      holidays,
    });
  } catch (e) {
    console.error('[tally-bills] settings read failed:', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings/all', (req, res) => {
  try {
    const db = getDb();
    if (!isAdmin(req.user)) return res.status(403).json({ error: 'Only an admin can change SLA settings' });
    const written = sla.saveConfig(db, req.body.config || {});
    if (req.body.owners) {
      const up = db.prepare(
        `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP`);
      for (const k of OWNER_KEYS) {
        if (req.body.owners[k] === undefined) continue;
        up.run(`tally_owner_${k}`, req.body.owners[k] ? String(req.body.owners[k]) : '');
      }
    }
    res.json({ ok: true, config: sla.getConfig(db), owners: getOwners(db), written });
  } catch (e) {
    console.error('[tally-bills] settings write failed:', e);
    res.status(500).json({ error: e.message });
  }
});

// ─── Reports (spec §7) ───────────────────────────────────────────────
// One pass over the register feeds all five, so the numbers can never disagree
// with each other or with the grid. Hang-audit findings #4/#15/#27: the date
// range cuts in SQL (not JS-after-the-fact), the SLA walk is computed only for
// report kinds that read it, and owner lookups come from one request-scoped map.
function reportRows(db, { from, to, needSla = true } = {}) {
  let where = ' WHERE 1=1';
  const p = [];
  if (from) { where += ' AND date(bill_date) >= date(?)'; p.push(from); }
  if (to) { where += ' AND date(bill_date) <= date(?)'; p.push(to); }
  const bills = db.prepare(`SELECT * FROM tally_bills${where} ORDER BY id`).all(...p);
  if (!needSla) return { rows: bills.map(b => ({ bill: b, s: null })), resolve: null };
  const ctx = sla.makeCtx(db);
  const holds = holdsByBill(db, bills.map(b => b.id));
  const nowMs = Date.now();
  const resolve = makeOwnerResolver(db, bills);
  return { rows: bills.map(b => ({ bill: b, s: sla.billSla(b, holds[b.id] || [], ctx, nowMs) })), resolve };
}

router.get('/reports/:kind', requirePermission('tally_bills', 'view'), (req, res) => {
  try {
    const db = getDb();
    const kind = req.params.kind;
    const { from, to } = req.query;
    // 'variance' is pure column arithmetic — no SLA walk needed at all.
    const { rows: scoped, resolve } = reportRows(db, { from, to, needSla: kind !== 'variance' });

    // 1. SLA compliance % by person and by stage.
    if (kind === 'sla-compliance') {
      const byStage = {}, byPerson = {};
      for (const { bill, s } of scoped) {
        for (const [key, st] of Object.entries(s.stages)) {
          if (st.on_time === null) continue;                 // still running — not yet a result
          const stg = byStage[key] || (byStage[key] = { stage: st.label, total: 0, on_time: 0, avg_delay: 0 });
          stg.total++; if (st.on_time) stg.on_time++; stg.avg_delay += st.delay;

          const u = resolve(st.owner_key, bill);
          const name = u?.name || '(unassigned)';
          const per = byPerson[name] || (byPerson[name] = { person: name, total: 0, on_time: 0 });
          per.total++; if (st.on_time) per.on_time++;
        }
      }
      const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
      return res.json({
        by_stage: Object.values(byStage).map(s => ({ ...s, avg_delay: round2(s.avg_delay / s.total), compliance_pct: pct(s.on_time, s.total) })),
        by_person: Object.values(byPerson).map(p => ({ ...p, compliance_pct: pct(p.on_time, p.total) })).sort((a, b) => b.total - a.total),
      });
    }

    // 2. Ageing — open bills bucketed by days since upload.
    if (kind === 'ageing') {
      const buckets = { '0-3': [], '4-7': [], '8-15': [], '15+': [] };
      for (const { bill, s } of scoped) {
        if (['closed', 'rejected'].includes(bill.status)) continue;
        buckets[sla.ageingBucket(s.total_days_since_upload)].push({
          id: bill.id, register_no: bill.register_no, bill_number: bill.bill_number,
          vendor_name: bill.vendor_name, project_name: bill.project_name,
          category: bill.category, bill_amount: bill.bill_amount,
          days: s.total_days_since_upload, stage: s.current_stage_label,
        });
      }
      return res.json(Object.entries(buckets).map(([bucket, items]) => ({
        bucket, count: items.length,
        amount: round2(items.reduce((t, i) => t + num(i.bill_amount), 0)), items,
      })));
    }

    // 3. Bottleneck — average days per stage.
    if (kind === 'bottleneck') {
      const agg = {};
      for (const { s } of scoped) {
        for (const [key, st] of Object.entries(s.stages)) {
          const a = agg[key] || (agg[key] = { stage: st.label, stage_no: st.stage_no, samples: 0, total_days: 0, breaches: 0, budget_days: st.budget_days });
          a.samples++; a.total_days += st.elapsed_days;
          if (st.on_time === false || st.overdue) a.breaches++;
        }
      }
      return res.json(Object.values(agg)
        .map(a => ({ ...a, avg_days: round2(a.total_days / a.samples) }))
        .sort((a, b) => a.stage_no - b.stage_no));
    }

    // 4. Payment variance — bill vs approved vs received.
    if (kind === 'variance') {
      return res.json(scoped
        .filter(({ bill }) => bill.approved_amount != null)
        .map(({ bill }) => ({
          id: bill.id, register_no: bill.register_no, bill_number: bill.bill_number,
          vendor_name: bill.vendor_name, project_name: bill.project_name, category: bill.category,
          bill_amount: round2(bill.bill_amount), approved_amount: round2(bill.approved_amount),
          received_amount: round2(bill.amount_received),
          variance: round2(bill.variance_amount), variance_pct: round2(bill.variance_pct),
          remark: bill.approval_remark, status: STATUS_LABEL[bill.status],
        }))
        .filter(r => Math.abs(r.variance) > PAISA || req.query.all === '1'));
    }

    // 5. Outstanding — approved but not fully received, with days overdue.
    if (kind === 'outstanding') {
      const nowMs = Date.now();
      return res.json(scoped
        .filter(({ bill }) => bill.t3_approved_at && !['closed', 'rejected'].includes(bill.status))
        .map(({ bill, s }) => {
          const dueMs = sla.tsMs(bill.t4_due_at);
          const overdue = dueMs ? Math.max(0, (nowMs - dueMs) / 86400000) : 0;
          return {
            id: bill.id, register_no: bill.register_no, bill_number: bill.bill_number,
            vendor_name: bill.vendor_name, project_name: bill.project_name, category: bill.category,
            approved_amount: round2(bill.approved_amount), received_amount: round2(bill.amount_received),
            balance: round2(num(bill.approved_amount) - num(bill.amount_received)),
            expected_date: bill.payment_expected_date, days_overdue: round2(overdue),
            status: STATUS_LABEL[bill.status], rag: s.rag,
          };
        })
        .sort((a, b) => b.days_overdue - a.days_overdue));
    }

    res.status(404).json({ error: `Unknown report "${kind}"` });
  } catch (e) {
    console.error('[tally-bills] report failed:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
module.exports.syncTaskCompletion = syncTaskCompletion;
