// Sales Bill Receive — client sales bill uploaded against an indent.
//
// Flow: pick indent number → site name (Business Book, auto-filled from the
// indent) → bill number → upload the received bill.
// Lookups live here so the page does not need Indent to Dispatch permission.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const canView = requirePermission('sales_bill_receive', 'view');
const canCreate = requirePermission('sales_bill_receive', 'create');
const canEdit = requirePermission('sales_bill_receive', 'edit');
const canDelete = requirePermission('sales_bill_receive', 'delete');

function rowWithNames(db, id) {
  return db.prepare(`
    SELECT r.*, u.name AS received_by_name
      FROM sales_bill_receives r
      LEFT JOIN users u ON u.id = r.received_by
     WHERE r.id = ?
  `).get(id);
}

// GET /lookups — indent picker + Business Book site names.
// Same site source as Indent to Dispatch (procurement/sites): one name per
// company/project, aggregated across Business Book + sites.
router.get('/lookups', canView, (req, res) => {
  try {
    const db = getDb();
    const indents = db.prepare(`
      SELECT id, indent_number, site_name
        FROM indents
       WHERE indent_number IS NOT NULL AND TRIM(indent_number) != ''
       ORDER BY id DESC
    `).all();
    const sites = db.prepare(
      `SELECT name, MAX(lead_no) as lead_no
       FROM (
         SELECT COALESCE(s.name, bb.project_name, bb.company_name) as name,
                bb.lead_no as lead_no
         FROM business_book bb
         LEFT JOIN sites s ON s.business_book_id = bb.id
         WHERE COALESCE(s.name, bb.project_name, bb.company_name) IS NOT NULL
           AND TRIM(COALESCE(s.name, bb.project_name, bb.company_name)) != ''
       )
       GROUP BY LOWER(TRIM(name))
       ORDER BY name COLLATE NOCASE`
    ).all();
    res.json({ indents, sites });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', canView, (req, res) => {
  try {
    const db = getDb();
    const { search } = req.query;
    let sql = `
      SELECT r.*, u.name AS received_by_name
        FROM sales_bill_receives r
        LEFT JOIN users u ON u.id = r.received_by
       WHERE 1=1
    `;
    const params = [];
    if (search) {
      sql += ` AND (r.indent_number LIKE ? OR r.site_name LIKE ? OR r.bill_number LIKE ?)`;
      const q = `%${search}%`;
      params.push(q, q, q);
    }
    sql += ' ORDER BY r.received_at DESC, r.id DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', canView, (req, res) => {
  try {
    const row = rowWithNames(getDb(), req.params.id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    res.json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', canCreate, (req, res) => {
  try {
    const b = req.body || {};
    const indentId = b.indent_id ? parseInt(b.indent_id, 10) : null;
    const billNumber = String(b.bill_number || '').trim();
    const fileUrl = String(b.file_url || '').trim();
    if (!indentId) return res.status(400).json({ error: 'Indent number is required' });
    if (!billNumber) return res.status(400).json({ error: 'Bill number is required' });
    if (!fileUrl) return res.status(400).json({ error: 'Upload the received bill' });

    const db = getDb();
    const indent = db.prepare('SELECT id, indent_number, site_name FROM indents WHERE id=?').get(indentId);
    if (!indent) return res.status(400).json({ error: 'Indent not found' });

    const siteName = String(b.site_name || indent.site_name || '').trim();
    if (!siteName) return res.status(400).json({ error: 'Site name is required' });

    const r = db.prepare(`
      INSERT INTO sales_bill_receives
        (indent_id, indent_number, site_name, bill_number, file_url, file_name, received_by)
      VALUES (?,?,?,?,?,?,?)
    `).run(
      indent.id,
      indent.indent_number || null,
      siteName,
      billNumber,
      fileUrl,
      b.file_name || null,
      req.user.id
    );

    res.status(201).json(rowWithNames(db, r.lastInsertRowid));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.put('/:id', canEdit, (req, res) => {
  try {
    const db = getDb();
    const cur = db.prepare('SELECT * FROM sales_bill_receives WHERE id=?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });

    const b = req.body || {};
    let indentId = cur.indent_id;
    let indentNumber = cur.indent_number;
    if (b.indent_id) {
      const indent = db.prepare('SELECT id, indent_number, site_name FROM indents WHERE id=?').get(parseInt(b.indent_id, 10));
      if (!indent) return res.status(400).json({ error: 'Indent not found' });
      indentId = indent.id;
      indentNumber = indent.indent_number || indentNumber;
    }

    const siteName = b.site_name !== undefined ? String(b.site_name || '').trim() : cur.site_name;
    const billNumber = b.bill_number !== undefined ? String(b.bill_number || '').trim() : cur.bill_number;
    if (!siteName) return res.status(400).json({ error: 'Site name is required' });
    if (!billNumber) return res.status(400).json({ error: 'Bill number is required' });

    const fileUrl = b.file_url !== undefined ? String(b.file_url || '').trim() : cur.file_url;
    if (!fileUrl) return res.status(400).json({ error: 'Upload the received bill' });
    const fileName = b.file_name !== undefined ? (b.file_name || null) : cur.file_name;

    db.prepare(`
      UPDATE sales_bill_receives
         SET indent_id=?, indent_number=?, site_name=?, bill_number=?, file_url=?, file_name=?
       WHERE id=?
    `).run(indentId, indentNumber, siteName, billNumber, fileUrl, fileName, cur.id);

    res.json(rowWithNames(db, cur.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', canDelete, (req, res) => {
  try {
    const db = getDb();
    const cur = db.prepare('SELECT * FROM sales_bill_receives WHERE id=?').get(req.params.id);
    if (!cur) return res.status(404).json({ error: 'Not found' });
    db.prepare('DELETE FROM sales_bill_receives WHERE id=?').run(cur.id);
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
