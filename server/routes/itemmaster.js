const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// GET all items with filters
router.get('/', requirePermission('item_master', 'view'), (req, res) => {
  const { department, type, search } = req.query;
  let sql = 'SELECT * FROM item_master WHERE 1=1';
  const params = [];
  if (department) { sql += ' AND department=?'; params.push(department); }
  if (type) { sql += ' AND type=?'; params.push(type); }
  if (search) {
    sql += ' AND (item_name LIKE ? OR specification LIKE ? OR size LIKE ? OR item_code LIKE ? OR make LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY item_code';
  res.json(getDb().prepare(sql).all(...params));
});

// GET all items for dropdown (lightweight - combined name/spec/size)
router.get('/dropdown', (req, res) => {
  const { type } = req.query;
  let sql = 'SELECT id, item_code, department, item_name, specification, size, uom, gst, type, current_price FROM item_master';
  if (type) sql += ` WHERE type='${type}'`;
  sql += ' ORDER BY department, item_name';
  const items = getDb().prepare(sql).all();
  const result = items.map(i => ({
    ...i,
    display_name: [i.item_name, i.specification, i.size].filter(Boolean).join(' / ')
  }));
  res.json(result);
});

// GET single item
router.get('/:id', requirePermission('item_master', 'view'), (req, res) => {
  const item = getDb().prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json(item);
});

// Inline price update — used by the Inventory Stock tab so mam can set
// the Item Master current_price directly when reviewing stock without
// navigating to Item Master. Admin or anyone with item_master.edit.
router.patch('/:id/price', requirePermission('item_master', 'edit'), (req, res) => {
  const price = +req.body?.current_price;
  if (!(price >= 0)) return res.status(400).json({ error: 'Price must be a positive number' });
  const r = getDb().prepare('UPDATE item_master SET current_price=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(price, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ message: 'Price updated', current_price: price });
});

// POST create
router.post('/', requirePermission('item_master', 'create'), (req, res) => {
  const { item_code, department, item_name, specification, size, uom, gst, type, make, model_number, current_price, catalogue_link, photo_link } = req.body;
  if (!item_name) return res.status(400).json({ error: 'Item name required' });

  // Auto-generate item_code if not provided. Uses nextSequence so deletes
  // don't cause UNIQUE-constraint collisions.
  let code = item_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    const dept = (department || 'GEN').toUpperCase().substring(0, 3);
    code = nextSequence(getDb(), 'item_master', 'item_code', dept, { startFrom: 0, pad: 4 });
  }

  const r = getDb().prepare(
    'INSERT INTO item_master (item_code, department, item_name, specification, size, uom, gst, type, make, model_number, current_price, catalogue_link, photo_link) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)'
  ).run(code, department, item_name, specification, size, uom || 'PCS', gst || '18%', type || 'PO', make, model_number, current_price || 0, catalogue_link, photo_link);
  res.status(201).json({ id: r.lastInsertRowid, item_code: code });
});

// PUT update
router.put('/:id', requirePermission('item_master', 'edit'), (req, res) => {
  const { item_code, department, item_name, specification, size, uom, gst, type, make, model_number, current_price, catalogue_link, photo_link } = req.body;
  getDb().prepare(
    'UPDATE item_master SET item_code=?, department=?, item_name=?, specification=?, size=?, uom=?, gst=?, type=?, make=?, model_number=?, current_price=?, catalogue_link=?, photo_link=?, updated_at=CURRENT_TIMESTAMP WHERE id=?'
  ).run(item_code, department, item_name, specification, size, uom, gst, type, make, model_number, current_price || 0, catalogue_link, photo_link, req.params.id);
  res.json({ message: 'Updated' });
});

// DELETE
router.delete('/:id', requirePermission('item_master', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM item_master WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// POST bulk import
router.post('/bulk', requirePermission('item_master', 'create'), (req, res) => {
  const { items } = req.body;
  if (!items || !Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'No data' });
  const db = getDb();
  const insert = db.prepare('INSERT OR IGNORE INTO item_master (item_code, department, item_name, specification, size, uom, gst, type, make, current_price) VALUES (?,?,?,?,?,?,?,?,?,?)');
  let added = 0, errors = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item.item_name || !item.item_name.trim()) { errors.push(`Row ${i + 1}: Item name required`); continue; }
    try {
      insert.run(item.item_code || '', item.department || '', item.item_name.trim(), item.specification || '', item.size || '', item.uom || 'PCS', item.gst || '18%', item.type || 'PO', item.make || '', item.current_price || 0);
      added++;
    } catch (err) { errors.push(`Row ${i + 1}: ${err.message}`); }
  }
  res.json({ added, errors, total: items.length });
});

module.exports = router;
