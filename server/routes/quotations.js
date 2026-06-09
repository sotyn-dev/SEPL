const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Tokenise a description for fuzzy item matching — drop noise words so the
// distinctive keywords (Excavation, MS Pipe, 25mm…) carry the match.
const STOP = new Set(['of','in','the','and','for','with','as','to','a','an','or','on','at','by','is','be','all','any','from','up','its','shall','etc','per','no','nos','each','including','include','included','complete','work','works','type','make','suitable','required','approved','rate','item','sqm','rmt']);
function tokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ')
    .filter(t => t && t.length >= 2 && !STOP.has(t));
}
// Score 0..1 = fraction of the item's (short, specific) tokens that appear in
// the BOQ line, with a boost when the item's leading keyword is present.
function scoreMatch(lineSet, itemTokens) {
  if (!itemTokens.length) return 0;
  let hit = 0;
  for (const t of itemTokens) if (lineSet.has(t)) hit++;
  let score = hit / itemTokens.length;
  if (lineSet.has(itemTokens[0])) score += 0.15;
  return Math.min(1, score);
}

// POST a CLIENT BOQ Excel → auto-match each line to Item Master and return a
// suggested item + rate + confidence per line (the "AI" auto-quotation).
router.post('/auto-match-boq', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const wb = XLSX.readFile(req.file.path);
    const parseNum = (v) => {
      if (v == null || v === '') return 0;
      if (typeof v === 'number') return v;
      const m = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return m ? parseFloat(m[0]) : 0;
    };
    const parseSheet = (name) => {
      const ws = wb.Sheets[name]; if (!ws) return [];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      const KW = ['description', 'particulars', 'item', 'work', 'qty', 'quantity', 'unit', 'rate', 's.no', 'sr no', 'sn'];
      let h = -1;
      for (let i = 0; i < Math.min(25, data.length); i++) {
        const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
        if (KW.filter(k => row.some(c => c === k || c.includes(k))).length >= 2) { h = i; break; }
      }
      if (h === -1) return [];
      const headers = (data[h] || []).map(x => String(x || '').toLowerCase().trim());
      const col = {};
      headers.forEach((hd, i) => {
        if (col.name === undefined && (hd.includes('description') || hd.includes('particular') || hd === 'item' || hd === 'items' || hd === 'work' || hd.includes('work description'))) col.name = i;
        if (col.qty === undefined && (hd === 'qty' || hd === 'quantity' || hd.includes('qty'))) col.qty = i;
        if (col.unit === undefined && (hd === 'unit' || hd === 'uom' || hd.includes('unit'))) col.unit = i;
      });
      if (col.name === undefined) return [];
      const out = [];
      for (let i = h + 1; i < data.length; i++) {
        const row = data[i] || [];
        const desc = String(row[col.name] || '').trim();
        if (!desc || desc.length < 3) continue;
        out.push({
          description: desc,
          qty: col.qty !== undefined ? (parseNum(row[col.qty]) || 1) : 1,
          unit: col.unit !== undefined ? String(row[col.unit] || '').trim() : '',
        });
      }
      return out;
    };
    let lines = [];
    for (const name of wb.SheetNames) { const r = parseSheet(name); if (r.length > lines.length) lines = r; }
    if (!lines.length) return res.status(400).json({ error: 'Could not read the BOQ. Ensure there is a header row with a "Description" (and ideally "Qty") column.' });

    const items = getDb().prepare(`SELECT id, item_code, department, item_name, specification, size, uom, current_price FROM item_master`).all();
    const itemTok = items.map(it => ({ it, toks: tokens([it.item_name, it.specification, it.size].filter(Boolean).join(' ')) }));

    const mk = (s) => (s && s.score > 0) ? {
      item_id: s.it.id, code: s.it.item_code,
      name: [s.it.item_name, s.it.specification, s.it.size].filter(Boolean).join(' / '),
      department: s.it.department || 'General', rate: s.it.current_price || 0,
      uom: s.it.uom || '', score: Math.round(s.score * 100),
    } : null;

    const rows = lines.map(line => {
      const lset = new Set(tokens(line.description));
      const scored = itemTok.map(({ it, toks }) => ({ it, score: scoreMatch(lset, toks) }))
        .sort((a, b) => b.score - a.score).slice(0, 4);
      const best = scored[0];
      const conf = (!best || best.score === 0) ? 'none' : best.score < 0.3 ? 'low' : best.score < 0.6 ? 'medium' : 'high';
      return {
        description: line.description, qty: line.qty, unit: line.unit,
        confidence: conf, match: mk(best), alternatives: scored.slice(1).map(mk).filter(Boolean),
      };
    });
    res.json({ count: rows.length, rows });
  } catch (err) {
    res.status(500).json({ error: 'Failed to parse BOQ: ' + err.message });
  } finally {
    try { if (req.file) fs.unlinkSync(req.file.path); } catch (e) { /* ignore */ }
  }
});

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
