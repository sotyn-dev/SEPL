// Snag List — site defects / punch-list items, with a delegation-style
// proof + approval workflow.
//
// Status flow (mam: "assign employee will upload proof and after
// approval task close like delegation"):
//
//   open       → raised; assignee has not yet uploaded proof
//   submitted  → assignee uploaded proof_url; raiser/admin reviewing
//   approved   → raiser/admin accepted proof — task closed
//   rejected   → raiser/admin rejected proof; assignee can resubmit
//
// Permissions:
//   view     — see snags
//   create   — Raise Snag (management / anyone mam ticks)
//   edit     — edit fields, assignee submits proof
//   approve  — approve / reject submitted proof, also acts as admin scope
//   delete   — delete a snag (audit-friendly, admins typically only)

const express = require('express');
const { istToday } = require('../lib/istDate');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

function isApprover(db, user) {
  if (user.role === 'admin') return true;
  const r = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'snags'
  `).get(user.id);
  return !!r?.ok;
}

// Site scope for non-privileged users (mam 2026-08-13: "user can show their
// snag according to their site" — a Site Engineer was seeing all 484 company
// snags). Admin + snag-approvers (management raisers) keep the full company
// view; everyone else sees only: snags of THEIR sites (same user→site mapping
// the Scorecard engine uses — sites.site_engineer_id / supervisor_id, legacy
// supervisor name, PO site-engineer links) + anything they raised + anything
// assigned to them (by id OR name — imported rows link assignees by name).
// Returns null for full-view users, else { where, params } with `s.` aliases.
function siteScopeWhere(db, user) {
  if (isApprover(db, user)) return null;
  const uname = db.prepare('SELECT name FROM users WHERE id=?').get(user.id)?.name || '';
  // The user's sites as id + NAME pairs.  Imported / WhatsApp-raised snags
  // often carry ONLY site_name text (site_id NULL — e.g. "CONSERN PHARMA"),
  // so matching by id alone showed an engineer an empty list (mam
  // 2026-08-13: "consern side site eng i select but not showing him snag").
  // Junior engineers on the PO (jr_site_engineer_ids CSV) count too.
  const rows = db.prepare(`
    SELECT id, name FROM sites WHERE site_engineer_id = ? OR supervisor_id = ?
    UNION
    SELECT id, name FROM sites WHERE LOWER(TRIM(COALESCE(supervisor,''))) = LOWER(TRIM(?))
    UNION
    SELECT s.id, s.name FROM sites s
    JOIN purchase_orders po ON po.id = s.po_id
    WHERE po.site_engineer_id = ?
       OR (',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ?
       OR (',' || COALESCE(po.jr_site_engineer_ids,'') || ',') LIKE ?
  `).all(user.id, user.id, uname, user.id, `%,${user.id},%`, `%,${user.id},%`);
  const ids = rows.map(r => r.id).filter(Boolean);
  const names = [...new Set(rows.map(r => String(r.name || '').trim().toLowerCase()).filter(Boolean))];
  const parts = [];
  const params = [];
  if (ids.length) parts.push(`s.site_id IN (${ids.join(',')})`);
  if (names.length) {
    parts.push(`LOWER(TRIM(COALESCE(s.site_name,''))) IN (${names.map(() => '?').join(',')})`);
    params.push(...names);
  }
  parts.push('s.raised_by = ?', 's.assigned_to = ?', '(s.assigned_to IS NULL AND s.assigned_to_name = ?)', 'CAST(s.assigned_to AS TEXT) = ?');
  params.push(user.id, user.id, uname, uname);
  return { where: `(${parts.join(' OR ')})`, params };
}

// Shared filtered-list query — used by the JSON list AND the .xlsx export so
// a downloaded sheet always matches what's on screen.
function buildSnagQuery(db, req) {
  const { status, priority, site_id, assigned_to, scope, search } = req.query;
  let sql = `
    SELECT s.*,
           rb.name as raised_by_name,
           at.name as assigned_to_user_name,
           ap.name as approved_by_name,
           ps.name as proof_submitted_by_name,
           site.name as site_name_live
    FROM snags s
    LEFT JOIN users rb ON rb.id = s.raised_by
    LEFT JOIN users at ON at.id = s.assigned_to
    LEFT JOIN users ap ON ap.id = s.approved_by
    LEFT JOIN users ps ON ps.id = s.proof_submitted_by
    LEFT JOIN sites site ON site.id = s.site_id
    WHERE 1=1
  `;
  const params = [];
  // Mandatory per-site visibility for non-privileged users — applies on top
  // of every optional filter below, so search/site/status can never widen
  // the window back to company-wide.
  const scopeW = siteScopeWhere(db, req.user);
  if (scopeW) { sql += ` AND ${scopeW.where}`; params.push(...scopeW.params); }
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  if (priority) { sql += ' AND s.priority = ?'; params.push(priority); }
  if (site_id) { sql += ' AND s.site_id = ?'; params.push(site_id); }
  if (assigned_to) { sql += ' AND s.assigned_to = ?'; params.push(assigned_to); }
  // scope=mine → only those raised-by or assigned-to me
  if (scope === 'mine') {
    sql += ' AND (s.raised_by = ? OR s.assigned_to = ?)';
    params.push(req.user.id, req.user.id);
  }
  if (search) {
    sql += ' AND (s.description LIKE ? OR s.location LIKE ? OR s.snag_no LIKE ? OR s.site_name LIKE ?)';
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }
  // Open / submitted at top so urgent things are visible first
  sql += ` ORDER BY
    CASE s.status WHEN 'submitted' THEN 0 WHEN 'open' THEN 1 WHEN 'rejected' THEN 2 ELSE 3 END,
    s.raised_at DESC`;
  return { sql, params };
}

// LIST
router.get('/', requirePermission('snags', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { sql, params } = buildSnagQuery(db, req);
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.get('/stats', requirePermission('snags', 'view'), (req, res) => {
  try {
    const db = getDb();
    // Same per-site window as the list, so the tiles always match the rows.
    const scopeW = siteScopeWhere(db, req.user);
    const base = `FROM snags s WHERE ${scopeW ? scopeW.where : '1=1'}`;
    const P = scopeW ? scopeW.params : [];
    const cnt = (extra) => db.prepare(`SELECT COUNT(*) as c ${base}${extra}`).get(...P).c;
    const total = cnt('');
    const open = cnt(" AND s.status='open'");
    const submitted = cnt(" AND s.status='submitted'");
    const approved = cnt(" AND s.status='approved'");
    const rejected = cnt(" AND s.status='rejected'");
    const critical = cnt(" AND s.priority='critical' AND s.status NOT IN ('approved')");
    res.json({ total, open, submitted, approved, rejected, critical });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EXPORT — a real .xlsx of the snag list with the defect + proof photos
// embedded, so the downloaded punch-list is self-explanatory without opening
// the app (client 2026-07: "download the sheet with the uploaded images too").
// Respects the same filters as the list (?status/?priority/?site_id/…).
router.get('/export.xlsx', requirePermission('snags', 'view'), async (req, res) => {
  try {
    const db = getDb();
    const { sql, params } = buildSnagQuery(db, req);
    const rows = db.prepare(sql).all(...params);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    wb.creator = 'Secured Engineers Pvt Ltd';
    const ws = wb.addWorksheet('Snags');
    ws.columns = [
      { header: 'Snag #', key: 'snag_no', width: 12 },
      { header: 'Site', key: 'site', width: 20 },
      { header: 'Location', key: 'location', width: 18 },
      { header: 'Description', key: 'description', width: 42 },
      { header: 'Priority', key: 'priority', width: 10 },
      { header: 'Status', key: 'status', width: 12 },
      { header: 'Raised By', key: 'raised_by', width: 16 },
      { header: 'Assigned To', key: 'assigned_to', width: 16 },
      { header: 'Target Date', key: 'target_date', width: 13 },
      { header: 'Raised At', key: 'raised_at', width: 18 },
      { header: 'Snag Photo', key: 'photo', width: 24 },
      { header: 'Proof Photo', key: 'proof', width: 24 },
    ];
    // Navy header row (matches the quotation export style).
    const head = ws.getRow(1); head.height = 22;
    head.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
      cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads');
    // Resolve a stored /uploads/<file> URL to an on-disk path — local uploads
    // only, so this can never read arbitrary files; remote URLs are skipped.
    const resolveLocal = (url) => {
      const m = typeof url === 'string' && url.match(/\/uploads\/([^/?#]+)$/);
      if (!m) return null;
      const p = path.join(uploadsDir, decodeURIComponent(m[1]));
      return fs.existsSync(p) ? p : null;
    };
    const extOf = (p) => { const e = path.extname(p).toLowerCase().slice(1); return e === 'jpg' ? 'jpeg' : e; };
    const IMG = { width: 150, height: 110 };

    // Image budget (2026-09-04 — mam: "unable to export excel" on a 672-row
    // list). Every photo was read in full as base64 and retained in the
    // workbook, then the whole thing was buffered TWICE on the way out. Site
    // photos come off phones at 2-5MB, so 600+ rows x 2 photos is multiple GB
    // against a 512MB heap cap (ecosystem.config.js --max-old-space-size) —
    // the request didn't just fail, it took the Node process down with it.
    // Now bounded on three axes; past the budget the cell degrades to the
    // photo URL as text, so the sheet stays useful instead of not arriving.
    //   ?photos=0  → skip images entirely (always-works fast path)
    const wantPhotos = req.query.photos !== '0';
    const MAX_IMG_BYTES = 2 * 1024 * 1024;       // skip any single photo over 2MB
    const IMG_BUDGET_BYTES = 48 * 1024 * 1024;   // total raw bytes embedded per sheet
    let imgBytesUsed = 0;
    let imgSkipped = 0;

    rows.forEach((s) => {
      const row = ws.addRow({
        snag_no: s.snag_no || '',
        site: s.site_name_live || s.site_name || '',
        location: s.location || '',
        description: s.description || '',
        priority: s.priority || '',
        status: s.status || '',
        raised_by: s.raised_by_name || '',
        assigned_to: s.assigned_to_user_name || s.assigned_to_name || '',
        target_date: s.target_date || '',
        raised_at: s.raised_at || '',
      });
      row.alignment = { vertical: 'top', wrapText: true };
      const embed = (url, colIndex0) => {
        const local = resolveLocal(url);
        if (!local) return false;
        const ext = extOf(local);
        if (!['png', 'jpeg', 'gif'].includes(ext)) return false;
        if (!wantPhotos) { imgSkipped++; return false; }
        try {
          // Check the size BEFORE reading — statSync costs nothing, whereas
          // readFileSync on a 5MB photo has already blown the budget by the
          // time we could measure the buffer.
          const size = fs.statSync(local).size;
          if (size > MAX_IMG_BYTES || imgBytesUsed + size > IMG_BUDGET_BYTES) { imgSkipped++; return false; }
          // Feed the image bytes as base64 so the picture is embedded straight
          // into the .xlsx (no S3 / external URL — the sheet is self-contained).
          const base64 = fs.readFileSync(local).toString('base64');
          imgBytesUsed += size;
          const id = wb.addImage({ base64, extension: ext });
          ws.addImage(id, { tl: { col: colIndex0 + 0.15, row: (row.number - 1) + 0.1 }, ext: IMG });
          return true;
        } catch { return false; }
      };
      const a = embed(s.photo_url, 10);  // 'Snag Photo'  → 0-based col 10
      const b = embed(s.proof_url, 11);  // 'Proof Photo' → 0-based col 11
      // Not embedded but a photo exists → write the link so the row still
      // points at the evidence rather than showing an empty cell.
      if (!a && s.photo_url) row.getCell('photo').value = String(s.photo_url);
      if (!b && s.proof_url) row.getCell('proof').value = String(s.proof_url);
      row.height = (a || b) ? 88 : 18;   // give image rows room; keep text rows compact
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="snags-${istToday()}.xlsx"`);
    // Surfaced so the client can tell the user some photos were left out.
    if (imgSkipped) res.setHeader('X-Photos-Skipped', String(imgSkipped));
    // Stream the workbook straight to the response instead of writeBuffer()
    // + Buffer.from(), which held two full copies of the finished file in
    // memory on top of every embedded image.
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    // Log it — a silent 500 here is why this looked like "the button does
    // nothing". Visible in `pm2 logs erp | grep '\[snags\]'`.
    console.error('[snags] export.xlsx failed:', err);
    if (!res.headersSent) res.status(500).json({ error: err.message });
    else res.destroy();
  }
});

// RAISE
router.post('/', requirePermission('snags', 'create'), (req, res) => {
  try {
    const b = req.body;
    if (!b.description || !String(b.description).trim()) {
      return res.status(400).json({ error: 'Description is required' });
    }
    const db = getDb();
    const { nextSequence } = require('../db/nextSequence');
    const yr = new Date().getFullYear();
    const snagNo = nextSequence(db, 'snags', 'snag_no', `SNAG-${yr}-`, { startFrom: 0, pad: 4 });
    const priority = ['low','medium','high','critical'].includes(b.priority) ? b.priority : 'medium';

    let siteName = b.site_name || null;
    if (!siteName && b.site_id) {
      const s = db.prepare('SELECT name FROM sites WHERE id=?').get(b.site_id);
      siteName = s?.name || null;
    }
    let assigneeName = b.assigned_to_name || null;
    if (!assigneeName && b.assigned_to) {
      const u = db.prepare('SELECT name FROM users WHERE id=?').get(b.assigned_to);
      assigneeName = u?.name || null;
    }

    const r = db.prepare(`
      INSERT INTO snags (
        snag_no, site_id, site_name, location, description, photo_url,
        priority, status, assigned_to, assigned_to_name,
        raised_by, target_date
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      snagNo, b.site_id || null, siteName, b.location || null,
      b.description, b.photo_url || null,
      priority, 'open', b.assigned_to || null, assigneeName,
      req.user.id, b.target_date || null
    );

    // Notify the assignee that a snag was raised against them.
    try {
      const { notifyMany } = require('../lib/push');
      if (b.assigned_to && b.assigned_to !== req.user.id) {
        notifyMany([b.assigned_to], {
          title: `🚧 ${snagNo} assigned to you`,
          body: `${siteName ? siteName + ' · ' : ''}${b.location ? b.location + ' · ' : ''}${String(b.description).slice(0, 80)}`,
          url: '/snags',
          tag: `snag-${r.lastInsertRowid}`,
        });
      }
    } catch {}

    res.status(201).json({ id: r.lastInsertRowid, snag_no: snagNo });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// EDIT (raiser / admin / approver — not the assignee)
// Lets the raiser change description / site / location / assignee /
// priority / target. Status is NOT editable here — use submit/approve/reject.
router.put('/:id', requirePermission('snags', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    const cur = db.prepare('SELECT raised_by, status FROM snags WHERE id=?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Snag not found' });
    if (cur.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can edit this snag' });
    }

    // snag_no is deliberately NOT in this allowlist — editing (target date
    // included) can never change the snag number (mam 2026-08-31).
    const fields = ['site_id','site_name','location','description','photo_url','priority','assigned_to','assigned_to_name','target_date'];
    const sets = []; const vals = [];
    // '' → NULL: the edit form sends '' for a cleared site/assignee, and a
    // bare '' in the site_id/assigned_to FK columns made the whole UPDATE die
    // with "FOREIGN KEY constraint failed" (so editing a snag with no site
    // was impossible — people deleted + re-raised, burning a new snag no).
    for (const f of fields) if (b[f] !== undefined) { sets.push(`${f}=?`); vals.push(b[f] === '' ? null : b[f]); }
    if (!sets.length) return res.status(400).json({ error: 'No fields to update' });
    vals.push(req.params.id);
    db.prepare(`UPDATE snags SET ${sets.join(', ')} WHERE id=?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SUBMIT PROOF (assignee uploads photo + optional notes)
// Approvers / admin can also submit on behalf of the assignee (matches
// the delegations.js convenience for WhatsApp-handover photos).
router.post('/:id/submit', (req, res) => {
  try {
    const { proof_url, proof_notes } = req.body;
    if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.assigned_to !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the assignee or an approver can submit proof' });
    }
    if (s.status === 'approved') return res.status(400).json({ error: 'Already approved' });

    db.prepare(`
      UPDATE snags
         SET proof_url=?, proof_notes=?, proof_submitted_by=?, proof_submitted_at=CURRENT_TIMESTAMP,
             status='submitted', reject_reason=NULL, rejected_at=NULL
       WHERE id=?
    `).run(proof_url, proof_notes || null, req.user.id, req.params.id);

    // Notify the raiser that proof is in for review.
    try {
      const { notifyMany } = require('../lib/push');
      if (s.raised_by && s.raised_by !== req.user.id) {
        notifyMany([s.raised_by], {
          title: `✅ ${s.snag_no} — proof submitted`,
          body: `${s.site_name ? s.site_name + ' · ' : ''}Awaiting your approval`,
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Proof submitted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// APPROVE — raiser or approver closes the snag.
router.post('/:id/approve', (req, res) => {
  try {
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can approve' });
    }
    if (s.status !== 'submitted') return res.status(400).json({ error: 'No submitted proof to approve' });

    db.prepare(`
      UPDATE snags SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).run(req.user.id, req.params.id);

    try {
      const { notifyMany } = require('../lib/push');
      if (s.assigned_to && s.assigned_to !== req.user.id) {
        notifyMany([s.assigned_to], {
          title: `🎉 ${s.snag_no} approved`,
          body: 'Snag closed — proof accepted.',
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Approved' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// REJECT — raiser sends it back with a reason; assignee resubmits.
router.post('/:id/reject', (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Reason is required' });
    const db = getDb();
    const s = db.prepare('SELECT * FROM snags WHERE id=?').get(req.params.id);
    if (!s) return res.status(404).json({ error: 'Not found' });
    if (s.raised_by !== req.user.id && !isApprover(db, req.user)) {
      return res.status(403).json({ error: 'Only the raiser or an approver can reject' });
    }
    if (s.status !== 'submitted') return res.status(400).json({ error: 'No submitted proof to reject' });

    db.prepare(`
      UPDATE snags SET status='rejected', reject_reason=?, rejected_at=CURRENT_TIMESTAMP
       WHERE id=?
    `).run(reason, req.params.id);

    try {
      const { notifyMany } = require('../lib/push');
      if (s.assigned_to && s.assigned_to !== req.user.id) {
        notifyMany([s.assigned_to], {
          title: `⚠️ ${s.snag_no} — proof rejected`,
          body: String(reason).slice(0, 140),
          url: '/snags',
          tag: `snag-${s.id}`,
        });
      }
    } catch {}

    res.json({ message: 'Rejected — assignee can resubmit' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('snags', 'delete'), (req, res) => {
  try {
    getDb().prepare('DELETE FROM snags WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
