// Sub-contractor Attendance module (director ask, 2026-07-25): each
// sub-contractor gets their own login and submits their crew's daily
// attendance directly — named workers + team photos (max 4 faces/photo,
// enforced as a soft sanity check) — instead of the site engineer doing a
// manual morning headcount punch (server/routes/dpr.js contractor-
// attendance). On save, this bridges into the EXISTING contractor_attendance
// table so DPR's "Contractors on Site" prefill (dpr.js) picks it up with
// zero changes to DPR's own code.
//
// Access gate (same-day follow-up): "no work order no attendance" — a
// sub-contractor can only see and submit for sites where they hold an
// ACTIVE Work Order (lib/subcontractorWorkOrders.js).

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { sitesWithActiveWorkOrder } = require('../lib/subcontractorWorkOrders');
const router = express.Router();
router.use(authMiddleware);

// Resolve the caller's own sub_contractors row. Admins may pass ?sub_contractor_id=
// to act on behalf of one (e.g. testing / support) — everyone else is locked
// to whichever sub_contractors row has user_id = their own id.
function resolveOwnSubcontractor(req, res, next) {
  const db = getDb();
  if (req.user.role === 'admin' && req.query.sub_contractor_id) {
    req.subContractorId = +req.query.sub_contractor_id;
    return next();
  }
  const sc = db.prepare('SELECT id FROM sub_contractors WHERE user_id=?').get(req.user.id);
  if (!sc) return res.status(403).json({ error: 'This login is not linked to a sub-contractor. Ask admin to set it up in Sub-Contractors → Create Login.' });
  req.subContractorId = sc.id;
  next();
}
router.use(resolveOwnSubcontractor);

// Sites this sub-contractor can submit attendance for — gated by an ACTIVE
// Work Order. No manual site-assignment step — issuing a Work Order
// (Projects → Indent Labour Payment → Work Orders) for this sub-contractor
// at a project is what grants attendance access, automatically.
router.get('/my-sites', (req, res) => {
  res.json(sitesWithActiveWorkOrder(getDb(), req.subContractorId));
});

// Named worker roster.
router.get('/my-workers', (req, res) => {
  const rows = getDb().prepare(
    `SELECT * FROM sub_contractor_workers WHERE sub_contractor_id=? AND active=1 ORDER BY name COLLATE NOCASE`
  ).all(req.subContractorId);
  res.json(rows);
});

router.post('/my-workers', (req, res) => {
  const { name, phone, id_proof_no } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Worker name is required' });
  const r = getDb().prepare(
    `INSERT INTO sub_contractor_workers (sub_contractor_id, name, phone, id_proof_no) VALUES (?,?,?,?)`
  ).run(req.subContractorId, String(name).trim(), phone || null, id_proof_no || null);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/my-workers/:id', (req, res) => {
  const db = getDb();
  const worker = db.prepare('SELECT id FROM sub_contractor_workers WHERE id=? AND sub_contractor_id=?').get(req.params.id, req.subContractorId);
  if (!worker) return res.status(404).json({ error: 'Not found' });
  const { name, phone, id_proof_no, active } = req.body || {};
  db.prepare(
    `UPDATE sub_contractor_workers SET
       name = COALESCE(?, name), phone = COALESCE(?, phone), id_proof_no = COALESCE(?, id_proof_no),
       active = COALESCE(?, active)
     WHERE id=?`
  ).run(name || null, phone ?? null, id_proof_no ?? null, active === undefined ? null : (active ? 1 : 0), req.params.id);
  res.json({ message: 'Updated' });
});

// Today's (or any date's) submission for one site — lets the UI edit-in-place.
router.get('/attendance', (req, res) => {
  const { site_id, date } = req.query;
  if (!site_id || !date) return res.status(400).json({ error: 'site_id and date required' });
  const db = getDb();
  const att = db.prepare(
    `SELECT * FROM sub_contractor_attendance WHERE sub_contractor_id=? AND site_id=? AND attendance_date=?`
  ).get(req.subContractorId, site_id, date);
  if (!att) return res.json(null);
  const photos = db.prepare(`SELECT * FROM sub_contractor_attendance_photos WHERE attendance_id=?`).all(att.id);
  const workers = db.prepare(
    `SELECT aw.present, w.id as worker_id, w.name, w.phone
       FROM sub_contractor_attendance_workers aw JOIN sub_contractor_workers w ON w.id = aw.worker_id
      WHERE aw.attendance_id=?`
  ).all(att.id);
  res.json({ ...att, photos, workers });
});

// Submit/replace one day's attendance for one site.
// Body: { site_id, date, workers: [{worker_id, present}], photos: [url,...], notes }
router.post('/attendance', (req, res) => {
  const db = getDb();
  const { site_id, date, workers, photos, notes } = req.body || {};
  if (!site_id || !date) return res.status(400).json({ error: 'site_id and date required' });

  // Hard gate (director ask, 2026-07-25): "no work order no attendance".
  // Re-check server-side even though the client only ever offers sites from
  // /my-sites — a stale client or direct API call must not bypass this.
  const hasActiveWorkOrder = sitesWithActiveWorkOrder(db, req.subContractorId).some(s => s.site_id === +site_id);
  if (!hasActiveWorkOrder) {
    return res.status(403).json({ error: 'No active Work Order for this site. Ask admin to issue one (Projects → Indent Labour Payment → Work Orders) before submitting attendance.' });
  }

  // Every worker_id must belong to THIS sub-contractor's own roster.
  const ownWorkerIds = new Set(
    db.prepare('SELECT id FROM sub_contractor_workers WHERE sub_contractor_id=?').all(req.subContractorId).map(r => r.id)
  );
  const cleanWorkers = (Array.isArray(workers) ? workers : [])
    .filter(w => w && ownWorkerIds.has(+w.worker_id))
    .map(w => ({ worker_id: +w.worker_id, present: w.present === false || w.present === 0 ? 0 : 1 }));
  const presentCount = cleanWorkers.filter(w => w.present).length;

  const cleanPhotos = (Array.isArray(photos) ? photos : []).filter(Boolean).map(String);
  // Soft sanity check on "max 4 workers per photo" — informational only,
  // since photo content itself isn't verified server-side.
  const minPhotosNeeded = Math.ceil(presentCount / 4);
  const photoWarning = presentCount > 0 && cleanPhotos.length < minPhotosNeeded
    ? `Heads up: ${presentCount} present but only ${cleanPhotos.length} photo(s) uploaded — at most 4 workers should be visible per photo (need ${minPhotosNeeded}+).`
    : null;

  try {
    const attId = db.transaction(() => {
      const existing = db.prepare(
        `SELECT id FROM sub_contractor_attendance WHERE sub_contractor_id=? AND site_id=? AND attendance_date=?`
      ).get(req.subContractorId, site_id, date);
      let id;
      if (existing) {
        db.prepare(`UPDATE sub_contractor_attendance SET submitted_by=?, notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
          .run(req.user.id, notes || null, existing.id);
        id = existing.id;
        db.prepare(`DELETE FROM sub_contractor_attendance_workers WHERE attendance_id=?`).run(id);
        db.prepare(`DELETE FROM sub_contractor_attendance_photos WHERE attendance_id=?`).run(id);
      } else {
        id = db.prepare(
          `INSERT INTO sub_contractor_attendance (sub_contractor_id, site_id, attendance_date, submitted_by, notes) VALUES (?,?,?,?,?)`
        ).run(req.subContractorId, site_id, date, req.user.id, notes || null).lastInsertRowid;
      }
      const insWorker = db.prepare(`INSERT INTO sub_contractor_attendance_workers (attendance_id, worker_id, present) VALUES (?,?,?)`);
      for (const w of cleanWorkers) insWorker.run(id, w.worker_id, w.present);
      const insPhoto = db.prepare(`INSERT INTO sub_contractor_attendance_photos (attendance_id, photo_url) VALUES (?,?)`);
      for (const url of cleanPhotos) insPhoto.run(id, url);

      // Bridge into the EXISTING contractor_attendance table so DPR's
      // "Contractors on Site" prefill (dpr.js GET /contractor-attendance,
      // already consumed by DPR.jsx) picks this submission up unchanged.
      const sc = db.prepare('SELECT name, contractor_type FROM sub_contractors WHERE id=?').get(req.subContractorId);
      db.prepare(
        `INSERT INTO contractor_attendance (site_id, attendance_date, subcontractor_id, contractor_name, contractor_type, manpower, photo_url, marked_by)
         VALUES (?,?,?,?,?,?,?,?)
         ON CONFLICT(site_id, attendance_date, contractor_name) DO UPDATE SET
           manpower=excluded.manpower, photo_url=excluded.photo_url, marked_by=excluded.marked_by, updated_at=CURRENT_TIMESTAMP`
      ).run(site_id, date, req.subContractorId, sc?.name || `Sub-contractor #${req.subContractorId}`, sc?.contractor_type || null, presentCount, cleanPhotos[0] || null, req.user.id);

      return id;
    })();
    res.status(201).json({ id: attId, present_count: presentCount, warning: photoWarning });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
