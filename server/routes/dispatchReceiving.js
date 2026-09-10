const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const storage = require('../lib/storage');
const { sites, indentsForSite, normalize } = require('../lib/dispatchReceiving');
const router = express.Router();
router.use(authMiddleware);
router.get('/sites', requirePermission('procurement', 'view'), (req, res) => res.json(sites(getDb())));
router.get('/indents', requirePermission('procurement', 'view'), (req, res) => {
  const site = sites(getDb()).find(s => s.value === normalize(req.query.site));
  if (!site) return res.status(400).json({ error: 'Select a valid Business Book site' });
  res.json(indentsForSite(getDb(), site.value));
});
router.get('/', requirePermission('procurement', 'view'), (req, res) => {
  res.json(getDb().prepare(`SELECT r.*, u.name AS created_by_name
    FROM dispatch_receiving r
    LEFT JOIN users u ON u.id=r.created_by ORDER BY r.id DESC`).all());
});
router.post('/', requirePermission('procurement', 'create'), async (req, res, next) => {
  try {
  const db = getDb();
  const site = sites(db).find(s => s.value === normalize(req.body.site));
  if (!site) return res.status(400).json({ error: 'Site Name is required' });
  // Typed by hand. Linked to the indent record only when the text matches one
  // of this site's indents — never rejected for not matching.
  const indentNumber = typeof req.body.indent_number === 'string' ? req.body.indent_number.trim() : '';
  if (!indentNumber || indentNumber.length > 100) return res.status(400).json({ error: 'Indent No. is required (maximum 100 characters)' });
  const indent = indentsForSite(db, site.value).find(i => normalize(i.indent_number) === normalize(indentNumber));
  const bill = typeof req.body.bill_number === 'string' ? req.body.bill_number.trim() : '';
  if (!bill || bill.length > 100) return res.status(400).json({ error: 'Bill Number is required (maximum 100 characters)' });
  const url = typeof req.body.receiving_url === 'string' ? req.body.receiving_url : '';
  // Receiving proof must be a real file from the ERP uploader, not a URL or
  // an arbitrary server path. Flat uploads are excluded from the orphan sweep.
  const filename = url.startsWith('/uploads/') ? url.slice(9) : '';
  if (!/^[a-zA-Z0-9_.-]+\.(pdf|png|jpe?g|webp|heic|heif)$/i.test(filename)
    || !(await storage.exists(filename))) {
    return res.status(400).json({ error: 'Upload Receiving is required. Upload an image or PDF.' });
  }
  const result = db.prepare(`INSERT INTO dispatch_receiving
    (site_name, indent_id, indent_number, bill_number, receiving_url, created_by) VALUES (?,?,?,?,?,?)`)
    .run(site.label, indent ? indent.id : null, indentNumber, bill, url, req.user.id);
  res.status(201).json({ id: result.lastInsertRowid, message: 'Dispatch receiving saved' });
  } catch (error) { next(error); }
});
module.exports = router;
