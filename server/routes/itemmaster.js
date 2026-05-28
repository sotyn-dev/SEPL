const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const ALLOWED_SOURCES = ['PO', 'Quote', 'Manual', 'Online'];

// MD Phase 1: "Right now Price is just a number — no date, no vendor,
// no bill. We can't trust it for tenders." Every Item Master row now
// surfaces:
//   - age_days     — days since the ACTUAL rate date (bill_po_date),
//                    NOT since the row was typed into ERP. Mam: "u
//                    pick its from when we enter in erp itemwise
//                    sheet" — a 2-year-old rate imported today should
//                    NOT show as 0 days. Falls back to priced_at /
//                    updated_at only when no bill_po_date is set.
//   - age_status   — green ≤30 / yellow 31-60 / red 60+ / never (no
//                    price set yet) so the UI can colour the row.
// And the filter param accepts status=expired|ageing|fresh|never|
// make_blank|no_vendor for the top-row filter pills.
function ageStatus(days) {
  if (days == null) return 'never';
  if (days <= 30) return 'green';
  if (days <= 60) return 'yellow';
  return 'red';
}

// SQL snippet that picks the right "rate date" to age from. Bill/PO
// date is the real-world evidence date; we fall back to priced_at
// (when staff captured it) only if no bill date was recorded. Returns
// NULL when no price/bill is set so the row shows NEVER.
const AGE_DATE_EXPR = `COALESCE(im.bill_po_date, im.priced_at, CASE WHEN im.current_price > 0 THEN im.updated_at END)`;

// Speed-up indexes for the filter pills (mam, 2026-05-28: "items wise
// master takes time to open like hang" — 2,385 rows × 5 filter columns
// without indexes meant each click did a full scan).
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_department    ON item_master(department)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_vendor_id     ON item_master(vendor_id)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_make          ON item_master(make)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_bill_po_date  ON item_master(bill_po_date)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_item_code     ON item_master(item_code)`); } catch (_) {}

// Builds the WHERE clause + params shared by the list endpoint and the
// COUNT(*) for the paginator. Keeping them in one place ensures the
// "Showing X-Y of Z" total always matches what the table shows.
function buildItemFilters(query) {
  const { department, type, search, status } = query;
  const clauses = [];
  const params = [];
  if (department) { clauses.push('im.department=?'); params.push(department); }
  if (type) { clauses.push('im.type=?'); params.push(type); }
  if (search) {
    clauses.push('(im.item_name LIKE ? OR im.specification LIKE ? OR im.size LIKE ? OR im.item_code LIKE ? OR im.make LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  if (status === 'expired')    clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) > 60`);
  if (status === 'ageing')     clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) BETWEEN 31 AND 60`);
  if (status === 'fresh')      clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) <= 30 AND ${AGE_DATE_EXPR} IS NOT NULL`);
  if (status === 'never')      clauses.push(`(${AGE_DATE_EXPR} IS NULL OR im.current_price = 0)`);
  if (status === 'make_blank') clauses.push(`(im.make IS NULL OR TRIM(im.make) = '')`);
  if (status === 'no_vendor')  clauses.push('im.vendor_id IS NULL');
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

// GET items, paginated. Response: { items, total, limit, offset }.
// Defaults to 100 per page so the client doesn't paint 2,385 rows at
// once (which is what was hanging the browser). Pass ?limit=99999 if
// you genuinely need everything (export, scripts).
router.get('/', requirePermission('item_master', 'view'), (req, res) => {
  const { where, params } = buildItemFilters(req.query);
  const limit  = Math.max(1, Math.min(99999, +req.query.limit  || 100));
  const offset = Math.max(0, +req.query.offset || 0);

  const sql = `
    SELECT im.*,
           v.name AS vendor_name,
           u.name AS priced_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
    ${where}
    ORDER BY im.item_code
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS n FROM item_master im ${where}`;

  const db = getDb();
  const rows  = db.prepare(sql).all(...params, limit, offset);
  const total = db.prepare(countSql).get(...params).n;
  res.json({
    items: rows.map(r => ({ ...r, age_status: ageStatus(r.age_days) })),
    total, limit, offset,
  });
});

// Lightweight dropdown — unchanged shape so callers don't break.
router.get('/dropdown', (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT id, item_code, department, item_name, specification, size, uom, gst, type, current_price FROM item_master';
  if (type) sql += ` WHERE type='${type}'`;
  sql += ' ORDER BY department, item_name';
  const items = getDb().prepare(sql).all();
  res.json(items.map(i => ({
    ...i,
    display_name: [i.item_name, i.specification, i.size].filter(Boolean).join(' / ')
  })));
});

// Single item — same shape as list, including age.
router.get('/:id', requirePermission('item_master', 'view'), (req, res) => {
  const item = getDb().prepare(`
    SELECT im.*, v.name AS vendor_name, u.name AS priced_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
     WHERE im.id = ?
  `).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ...item, age_status: ageStatus(item.age_days) });
});

// Price history for a single item — every prior captured price plus the
// vendor / source / bill that justified it.
router.get('/:id/price-history', requirePermission('item_master', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT iph.*, v.name AS vendor_name
      FROM item_price_history iph
      LEFT JOIN vendors v ON v.id = iph.vendor_id
     WHERE iph.item_id = ?
     ORDER BY iph.created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Helper — when the price (or its provenance) changes, snapshot the
// OLD row into item_price_history before overwriting. Never deletes.
function snapshotCurrentPrice(db, oldRow, actor) {
  if (!oldRow) return;
  // Only snapshot if there's a meaningful current price worth keeping.
  if (!(oldRow.current_price > 0)) return;
  db.prepare(`
    INSERT INTO item_price_history
      (item_id, rate, quantity, source, source_type, vendor_id,
       bill_po_number, bill_po_date, created_by, created_by_name, created_at)
    VALUES (?, ?, 0, 'item_master_edit', ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    oldRow.id,
    +oldRow.current_price || 0,
    oldRow.source_type || null,
    oldRow.vendor_id || null,
    oldRow.bill_po_number || null,
    oldRow.bill_po_date || null,
    oldRow.priced_by || actor?.id || null,
    actor?.name || null,
    oldRow.priced_at || oldRow.updated_at || null,
  );
}

// Inline price patch (Inventory page uses this). Snapshots history.
router.patch('/:id/price', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const price = +req.body?.current_price;
  if (!(price >= 0)) return res.status(400).json({ error: 'Price must be a positive number' });
  snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET current_price = ?,
           source_type = COALESCE(?, source_type, 'Manual'),
           priced_at = CURRENT_TIMESTAMP,
           priced_by = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(price, req.body?.source_type || null, req.user.id, req.params.id);
  res.json({ message: 'Price updated', current_price: price });
});

router.post('/', requirePermission('item_master', 'create'), (req, res) => {
  const b = req.body || {};
  if (!b.item_name) return res.status(400).json({ error: 'Item name required' });

  // Mam (2026-05-21): same item name + size + spec = same item.  This
  // matches the dedupe rule the master-sheet cleanup script used
  // (server/scripts/itemMasterCleanup.js).  Catches "MS PIPE 25mm
  // C-CLASS" being added twice with slight whitespace differences.
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  const dup = findDuplicate(getDb(), {
    table: 'item_master',
    fields: {
      item_name: b.item_name,
      size: b.size || '',
      specification: b.specification || '',
    },
    codeColumn: 'item_code',
  });
  if (sendDuplicate(res, dup, `Item "${b.item_name}"${b.size ? ' · ' + b.size : ''}`)) return;

  let code = b.item_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    const dept = (b.department || 'GEN').toUpperCase().substring(0, 3);
    code = nextSequence(getDb(), 'item_master', 'item_code', dept, { startFrom: 0, pad: 4 });
  }
  const sourceType = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : 'Manual';
  const price = +b.current_price || 0;
  const r = getDb().prepare(`
    INSERT INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make, model_number,
       current_price, catalogue_link, photo_link,
       vendor_id, source_type, bill_po_number, bill_po_date,
       priced_at, priced_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, b.department, b.item_name, b.specification, b.size,
    b.uom || 'PCS', b.gst || '18%', b.type || 'PO', b.make, b.model_number,
    price, b.catalogue_link, b.photo_link,
    b.vendor_id || null, sourceType, b.bill_po_number || null, b.bill_po_date || null,
    price > 0 ? new Date().toISOString() : null,
    price > 0 ? req.user.id : null,
  );
  res.status(201).json({ id: r.lastInsertRowid, item_code: code });
});

router.put('/:id', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const newPrice = +b.current_price || 0;
  const newVendor = b.vendor_id || null;
  const newSource = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : (old.source_type || 'Manual');
  const newBillNo = b.bill_po_number || null;
  const newBillDate = b.bill_po_date || null;
  // Detect "price provenance changed" — any of: rate, vendor, source,
  // bill number, bill date. If yes, snapshot old + bump priced_at.
  const priceProvenanceChanged =
    (+old.current_price || 0) !== newPrice ||
    (old.vendor_id || null) !== newVendor ||
    (old.source_type || null) !== newSource ||
    (old.bill_po_number || null) !== newBillNo ||
    (old.bill_po_date || null) !== newBillDate;
  if (priceProvenanceChanged) snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET item_code = ?, department = ?, item_name = ?, specification = ?, size = ?,
           uom = ?, gst = ?, type = ?, make = ?, model_number = ?,
           current_price = ?, catalogue_link = ?, photo_link = ?,
           vendor_id = ?, source_type = ?, bill_po_number = ?, bill_po_date = ?,
           priced_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE priced_at END,
           priced_by = CASE WHEN ? THEN ? ELSE priced_by END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    b.item_code, b.department, b.item_name, b.specification, b.size,
    b.uom, b.gst, b.type, b.make, b.model_number,
    newPrice, b.catalogue_link, b.photo_link,
    newVendor, newSource, newBillNo, newBillDate,
    priceProvenanceChanged ? 1 : 0,
    priceProvenanceChanged ? 1 : 0, req.user.id,
    req.params.id,
  );
  res.json({ message: 'Updated', price_history_snapshot: priceProvenanceChanged });
});

router.delete('/:id', requirePermission('item_master', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM item_master WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Bulk import — extended CSV header so MD's CSV template can carry
// vendor + source + bill data. New columns are optional; old templates
// still work.
router.post('/bulk', requirePermission('item_master', 'create'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No data' });
  const db = getDb();
  // Resolve vendor name → id at import time so the CSV can carry a name.
  const vendorByName = new Map(
    db.prepare('SELECT id, LOWER(TRIM(name)) AS k FROM vendors').all().map(r => [r.k, r.id])
  );
  const insert = db.prepare(`
    INSERT OR IGNORE INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make,
       current_price, vendor_id, source_type, bill_po_number, bill_po_date,
       priced_at, priced_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let added = 0;
  const errors = [];
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (!it.item_name || !String(it.item_name).trim()) { errors.push(`Row ${i + 1}: Item name required`); continue; }
    try {
      const vendorId = it.vendor_id != null
        ? +it.vendor_id || null
        : (it.vendor_name ? vendorByName.get(String(it.vendor_name).trim().toLowerCase()) || null : null);
      const source = ALLOWED_SOURCES.includes(it.source_type) ? it.source_type : (it.source_type ? null : 'Manual');
      const price = +it.current_price || 0;
      insert.run(
        it.item_code || '', it.department || '', String(it.item_name).trim(),
        it.specification || '', it.size || '', it.uom || 'PCS',
        it.gst || '18%', it.type || 'PO', it.make || '',
        price, vendorId, source, it.bill_po_number || null, it.bill_po_date || null,
        price > 0 ? new Date().toISOString() : null,
        price > 0 ? req.user.id : null,
      );
      added++;
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: items.length });
});

module.exports = router;
