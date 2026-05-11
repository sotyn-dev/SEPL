const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// BOQ
router.get('/boq', (req, res) => {
  res.json(getDb().prepare(`SELECT b.*, l.company_name, u.name as created_by_name FROM boq b
    LEFT JOIN leads l ON b.lead_id=l.id LEFT JOIN users u ON b.created_by=u.id ORDER BY b.created_at DESC`).all());
});

router.post('/boq', (req, res) => {
  const { lead_id, title, drawing_required, items } = req.body;
  const db = getDb();
  const total = (items || []).reduce((s, i) => s + (i.quantity * i.rate), 0);
  const r = db.prepare('INSERT INTO boq (lead_id, title, drawing_required, total_amount, created_by) VALUES (?,?,?,?,?)')
    .run(lead_id, title, drawing_required ? 1 : 0, total, req.user.id);
  const insertItem = db.prepare('INSERT INTO boq_items (boq_id, description, quantity, unit, rate, amount, item_id) VALUES (?,?,?,?,?,?,?)');

  // AI Agent: when a line item is linked to a catalogue item AND has a
  // rate > 0, log it to item_price_history so everyone sees this rate
  // as a suggestion next time. Also bump item_master.current_price to
  // reflect the latest market rate the team is actually quoting.
  const insertHistory = db.prepare(`INSERT INTO item_price_history
    (item_id, rate, quantity, lead_id, company_name, boq_id, source, created_by, created_by_name)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const updateItemPrice = db.prepare('UPDATE item_master SET current_price=?, updated_at=CURRENT_TIMESTAMP WHERE id=?');
  const lead = lead_id ? db.prepare('SELECT company_name FROM leads WHERE id=?').get(lead_id) : null;
  const companyName = lead?.company_name || null;

  for (const i of (items || [])) {
    const itemId = i.item_id ? +i.item_id : null;
    insertItem.run(r.lastInsertRowid, i.description, i.quantity, i.unit, i.rate, i.quantity * i.rate, itemId);
    if (itemId && i.rate > 0) {
      insertHistory.run(itemId, i.rate, i.quantity || 0, lead_id || null, companyName, r.lastInsertRowid, 'boq', req.user.id, req.user.name || null);
      updateItemPrice.run(i.rate, itemId);
    }
  }
  res.status(201).json({ id: r.lastInsertRowid });
});

router.get('/boq/:id', (req, res) => {
  const boq = getDb().prepare('SELECT * FROM boq WHERE id=?').get(req.params.id);
  if (!boq) return res.status(404).json({ error: 'Not found' });
  boq.items = getDb().prepare('SELECT * FROM boq_items WHERE boq_id=?').all(req.params.id);
  res.json(boq);
});

// Quotations
router.get('/', (req, res) => {
  res.json(getDb().prepare(`SELECT q.*, l.company_name, u.name as created_by_name FROM quotations q
    LEFT JOIN leads l ON q.lead_id=l.id LEFT JOIN users u ON q.created_by=u.id ORDER BY q.created_at DESC`).all());
});

router.post('/', (req, res) => {
  const { lead_id, boq_id, total_amount, discount, final_amount, valid_until, notes } = req.body;
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const qNum = nextSequence(db, 'quotations', 'quotation_number', 'QTN-', { startFrom: 0, pad: 4 });
  const r = db.prepare(
    'INSERT INTO quotations (lead_id, boq_id, quotation_number, total_amount, discount, final_amount, valid_until, notes, created_by) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(lead_id, boq_id, qNum, total_amount, discount || 0, final_amount, valid_until, notes, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, quotation_number: qNum });
});

router.put('/:id', (req, res) => {
  const { total_amount, discount, final_amount, status, valid_until, notes } = req.body;
  getDb().prepare('UPDATE quotations SET total_amount=?, discount=?, final_amount=?, status=?, valid_until=?, notes=? WHERE id=?')
    .run(total_amount, discount, final_amount, status, valid_until, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/:id', (req, res) => {
  const db = getDb();
  const poCount = db.prepare('SELECT COUNT(*) as c FROM purchase_orders WHERE quotation_id=?').get(req.params.id).c;
  if (poCount > 0) return res.status(409).json({ error: 'Cannot delete: Purchase Orders reference this quotation' });
  db.prepare('DELETE FROM quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.delete('/boq/:id', (req, res) => {
  const db = getDb();
  const qCount = db.prepare('SELECT COUNT(*) as c FROM quotations WHERE boq_id=?').get(req.params.id).c;
  if (qCount > 0) return res.status(409).json({ error: 'Cannot delete: Quotations reference this BOQ' });
  db.prepare('DELETE FROM boq_items WHERE boq_id=?').run(req.params.id);
  db.prepare('DELETE FROM boq WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
