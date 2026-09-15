const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const storage = require('../lib/storage');
const { sites, indentsForSite, normalize, receivingApprovers, canApproveReceiving } = require('../lib/dispatchReceiving');
const { receivingEventContext } = require('../lib/receivingMail');
const { runRulesForEvent } = require('../lib/emailRules');
const router = express.Router();
router.use(authMiddleware);

// Receiving proof must be a real file from the ERP uploader, not a URL or
// an arbitrary server path. Flat uploads are excluded from the orphan sweep.
const PROOF_FILE = /^[a-zA-Z0-9_.-]+\.(pdf|png|jpe?g|webp|heic|heif)$/i;
async function validProof(url) {
  const filename = typeof url === 'string' && url.startsWith('/uploads/') ? url.slice(9) : '';
  return PROOF_FILE.test(filename) && await storage.exists(filename);
}

// Field checks shared by add and edit. Indent No. is typed by hand and linked
// to the indent record only when the text matches one of this site's indents —
// never rejected for not matching.
function readFields(db, body) {
  const site = sites(db).find(s => s.value === normalize(body.site));
  if (!site) return { error: 'Site Name is required' };
  const indentNumber = typeof body.indent_number === 'string' ? body.indent_number.trim() : '';
  if (!indentNumber || indentNumber.length > 100) return { error: 'Indent No. is required (maximum 100 characters)' };
  const bill = typeof body.bill_number === 'string' ? body.bill_number.trim() : '';
  if (!bill || bill.length > 100) return { error: 'Bill Number is required (maximum 100 characters)' };
  const indent = indentsForSite(db, site.value).find(i => normalize(i.indent_number) === normalize(indentNumber));
  return { site, indentNumber, bill, indentId: indent ? indent.id : null };
}

// Tell Lovely there is a receiving waiting (never the person who just saved it).
function notifyApprovers(db, row, actor, verb) {
  try {
    const ids = receivingApprovers(db).map(u => u.id).filter(id => id !== actor.id);
    if (!ids.length) return;
    const insert = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
      VALUES (?,?,?,?,?,?,?)`);
    const title = `Receiving to approve — ${row.site_name}`;
    const text = `${verb} by ${actor.name || 'a user'} · Bill ${row.bill_number} · Indent ${row.indent_number}`;
    for (const uid of ids) {
      insert.run(uid, 'dispatch_receiving', title, text, '/dispatch-receiving', 'in_app', `dispatch-receiving-${row.id}-${Date.now()}-${uid}`);
    }
  } catch (e) { console.warn('[dispatch-receiving] notify failed:', e.message); }
}

router.get('/sites', requirePermission('procurement', 'view'), (req, res) => res.json(sites(getDb())));
router.get('/indents', requirePermission('procurement', 'view'), (req, res) => {
  const site = sites(getDb()).find(s => s.value === normalize(req.query.site));
  if (!site) return res.status(400).json({ error: 'Select a valid Business Book site' });
  res.json(indentsForSite(getDb(), site.value));
});

router.get('/', requirePermission('procurement', 'view'), (req, res) => {
  const db = getDb();
  const approver = canApproveReceiving(db, req.user);
  const approverNames = receivingApprovers(db).map(u => u.name).join(', ') || 'Admin';
  const rows = db.prepare(`SELECT r.*, u.name AS created_by_name, au.name AS approved_by_name, eu.name AS updated_by_name
    FROM dispatch_receiving r
    LEFT JOIN users u ON u.id=r.created_by
    LEFT JOIN users au ON au.id=r.approved_by
    LEFT JOIN users eu ON eu.id=r.updated_by
    ORDER BY r.id DESC`).all();
  res.json(rows.map(r => ({ ...r, approver_names: approverNames, can_approve: approver && r.status === 'pending' })));
});

router.post('/', requirePermission('procurement', 'create'), async (req, res, next) => {
  try {
    const db = getDb();
    const f = readFields(db, req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    if (!(await validProof(req.body.receiving_url))) {
      return res.status(400).json({ error: 'Upload Receiving is required. Upload an image or PDF.' });
    }
    const result = db.prepare(`INSERT INTO dispatch_receiving
      (site_name, indent_id, indent_number, bill_number, receiving_url, created_by) VALUES (?,?,?,?,?,?)`)
      .run(f.site.label, f.indentId, f.indentNumber, f.bill, req.body.receiving_url, req.user.id);
    notifyApprovers(db, db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(result.lastInsertRowid), req.user, 'Added');
    res.status(201).json({ id: result.lastInsertRowid, message: 'Dispatch receiving saved' });
  } catch (error) { next(error); }
});

// Edit (mam 2026-09-11: "give here edit option"). Anyone who can add a
// receiving can correct one. The approval covered the OLD values, so an edited
// receiving goes back to Lovely as pending.
router.put('/:id', requirePermission('procurement', 'create'), async (req, res, next) => {
  try {
    const db = getDb();
    const row = db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Receiving not found' });
    const f = readFields(db, req.body);
    if (f.error) return res.status(400).json({ error: f.error });
    let url = row.receiving_url;
    if (req.body.receiving_url && req.body.receiving_url !== row.receiving_url) {
      if (!(await validProof(req.body.receiving_url))) return res.status(400).json({ error: 'Upload Receiving must be an image or PDF.' });
      url = req.body.receiving_url;
    }
    db.prepare(`UPDATE dispatch_receiving SET site_name=?, indent_id=?, indent_number=?, bill_number=?, receiving_url=?,
        status='pending', approved_by=NULL, approved_at=NULL, rejected_reason=NULL,
        updated_by=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?`).run(f.site.label, f.indentId, f.indentNumber, f.bill, url, req.user.id, row.id);
    notifyApprovers(db, db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(row.id), req.user, 'Edited');
    res.json({ message: 'Receiving updated — sent to Lovely for approval again' });
  } catch (error) { next(error); }
});

// Approve / reject (mam 2026-09-11: "Lovely will approve this receiving").
function decide(status) {
  return async (req, res) => {
    const db = getDb();
    if (!canApproveReceiving(db, req.user)) return res.status(403).json({ error: 'Only Lovely (or an admin) can approve receivings' });
    const row = db.prepare('SELECT * FROM dispatch_receiving WHERE id=?').get(req.params.id);
    if (!row) return res.status(404).json({ error: 'Receiving not found' });
    if (row.status !== 'pending') return res.status(409).json({ error: `This receiving is already ${row.status}` });
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : '';
    if (status === 'rejected' && (!reason || reason.length > 300)) {
      return res.status(400).json({ error: 'A reason is required to reject (maximum 300 characters)' });
    }
    db.prepare(`UPDATE dispatch_receiving SET status=?, approved_by=?, approved_at=CURRENT_TIMESTAMP, rejected_reason=?
      WHERE id=? AND status='pending'`).run(status, req.user.id, status === 'rejected' ? reason : null, row.id);
    // Approved → fire the 'receiving.approved' email trigger. What goes out (if
    // anything) is whatever rule mam built in Admin → Email Triggers; this route
    // only supplies the facts. Never blocks the approval, and the outcome rides
    // back so the page can say whether a mail actually went and to whom.
    let mail = null;
    if (status === 'approved') {
      try {
        const ctx = await receivingEventContext(db, row, req.user);
        const results = await runRulesForEvent('receiving.approved', ctx);
        mail = {
          rules: results.length,
          sent: results.filter(r => r.sent).map(r => ({ rule: r.rule, to: r.to, cc: r.cc, attached: r.attached })),
          skipped: results.filter(r => !r.sent).map(r => ({ rule: r.rule, reason: r.skipped || r.error })),
          customer_source: ctx.__customer_source,
          customer_reason: ctx.__customer_reason,
        };
      } catch (e) {
        console.warn('[receiving] approval mail failed:', e.message);
        mail = { rules: 0, sent: [], skipped: [{ rule: 'trigger', reason: e.message }] };
      }
    }
    res.json({ message: status === 'approved' ? 'Receiving approved' : 'Receiving rejected', mail });
  };
}
router.post('/:id/approve', requirePermission('procurement', 'view'), decide('approved'));
router.post('/:id/reject', requirePermission('procurement', 'view'), decide('rejected'));

module.exports = router;
