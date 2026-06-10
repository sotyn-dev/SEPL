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
// Score 0..1 for how well an Item Master item matches a BOQ line. Coverage of
// the item's tokens, BUT weighted down hard for thin evidence: a single common
// material word (e.g. "cement" mentioned inside "construct brick masonry
// manhole") must NOT score high. Real confidence needs several matched
// keywords. The LLM pass (below) makes the final call when configured.
function scoreMatch(lineSet, itemTokens) {
  if (!itemTokens.length) return 0;
  let hit = 0;
  for (const t of itemTokens) if (lineSet.has(t)) hit++;
  if (hit === 0) return 0;
  let score = hit / itemTokens.length;
  if (lineSet.has(itemTokens[0])) score += 0.1;
  // Specificity: scale by matched-keyword count (need ~3 for full weight),
  // and cap matches resting on 0–1 keywords to a weak score.
  score *= Math.min(1, hit / 3);
  if (hit < 2) score = Math.min(score, 0.25);
  return Math.min(1, score);
}

// Read an app_settings value (AI key/model live there, set via AI Settings UI).
function aiSetting(key) {
  try { const r = getDb().prepare('SELECT value FROM app_settings WHERE key=?').get(key); return r ? r.value : null; }
  catch (e) { return null; }
}

// Claude pass: for each line, pick the best catalog item from its fuzzy
// shortlist, or null for composite WORK items that have no single catalog
// match. Returns an array indexed by line, or null if AI isn't configured.
async function llmRefine(ranked) {
  const apiKey = aiSetting('ai_api_key');
  if (!apiKey) return null;
  let Anthropic;
  try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { return null; }
  const model = aiSetting('ai_model') || 'claude-opus-4-7';
  const client = new Anthropic.default({ apiKey, timeout: 55000 });
  const blocks = ranked.map((r, i) => {
    const cands = r.scored.slice(0, 8).map(s =>
      `${s.it.id}=${[s.it.item_name, s.it.specification, s.it.size].filter(Boolean).join(' ')}`).join(' | ');
    return `[${i}] "${String(r.line.description).slice(0, 280)}"\n   options: ${cands || '(none)'}`;
  }).join('\n');
  const prompt = `You match client BOQ lines to a company's Item Master (catalog of materials/products it sells).
For each BOQ line, pick the ONE option id that is the SAME product, or null if none genuinely match.
CRITICAL: many lines are CONSTRUCTION WORK (e.g. "construct brick masonry manhole", "lay RCC pipe in trench") that has NO single catalog item — return null for those; do NOT match a material merely mentioned inside the text.
Return ONLY a JSON array, one object per line: {"line": <index>, "item_id": <id or null>, "confidence": <0-100>}.

${blocks}`;
  const resp = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  const text = (resp.content || []).map(c => c.text || '').join('');
  const a = text.indexOf('['), b = text.lastIndexOf(']');
  if (a === -1 || b === -1) return null;
  const arr = JSON.parse(text.slice(a, b + 1));
  const out = [];
  for (const o of arr) if (o && typeof o.line === 'number') out[o.line] = { item_id: o.item_id ?? null, confidence: Number(o.confidence) || 0 };
  return out;
}

// POST a CLIENT BOQ Excel → auto-match each line to Item Master and return a
// suggested item + rate + confidence per line (the "AI" auto-quotation).
router.post('/auto-match-boq', upload.single('file'), async (req, res) => {
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
    const itemById = new Map(items.map(it => [it.id, it]));
    const itemTok = items.map(it => ({ it, toks: tokens([it.item_name, it.specification, it.size].filter(Boolean).join(' ')) }));

    const mk = (it, score) => it ? {
      item_id: it.id, code: it.item_code,
      name: [it.item_name, it.specification, it.size].filter(Boolean).join(' / '),
      department: it.department || 'General', rate: it.current_price || 0,
      uom: it.uom || '', score: Math.round(score || 0),
    } : null;

    // Fuzzy shortlist per line (also the candidate set handed to the AI).
    const ranked = lines.map(line => {
      const lset = new Set(tokens(line.description));
      const scored = itemTok.map(({ it, toks }) => ({ it, score: scoreMatch(lset, toks) }))
        .filter(s => s.score > 0).sort((a, b) => b.score - a.score).slice(0, 8);
      return { line, scored };
    });

    // Best-effort AI refinement; falls back to fuzzy if not configured / errors.
    let llm = null;
    try { llm = await llmRefine(ranked); } catch (e) { llm = null; }

    const rows = ranked.map((r, i) => {
      const { line, scored } = r;
      const alts = scored.map(s => mk(s.it, s.score * 100)).filter(Boolean);
      if (llm && llm[i] !== undefined) {
        const pick = llm[i];
        const it = (pick.item_id != null) ? itemById.get(pick.item_id) : null;
        const cf = Number(pick.confidence) || 0;
        const conf = it ? (cf >= 70 ? 'high' : cf >= 40 ? 'medium' : 'low') : 'none';
        return {
          description: line.description, qty: line.qty, unit: line.unit,
          confidence: it ? conf : 'none', match: it ? mk(it, cf) : null,
          alternatives: alts.filter(a => !it || a.item_id !== it.id).slice(0, 3),
        };
      }
      const best = scored[0];
      const sc = best ? best.score : 0;
      const conf = sc === 0 ? 'none' : sc < 0.3 ? 'low' : sc < 0.6 ? 'medium' : 'high';
      return {
        description: line.description, qty: line.qty, unit: line.unit,
        confidence: best ? conf : 'none', match: best ? mk(best.it, sc * 100) : null,
        alternatives: alts.slice(1, 4),
      };
    });
    res.json({ count: rows.length, rows, matched_by: llm ? 'ai' : 'keyword' });
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

// ── PO/FOC Stripped (mam 2026-06-09) ──────────────────────────────
// Each entry = one PO item + FOC items + labour + margin, with an
// approval workflow (non_approved → approved → re_approved on later edit).
function computePoFoc(body) {
  const qty = Number(body.qty) || 0;
  const poRate = Number(body.po_rate) || 0;
  const labour = Number(body.labour) || 0;
  const margin = Number(body.margin) || 0;
  const focs = Array.isArray(body.focs) ? body.focs.filter(f => f && (f.item_id || f.name)).map(f => ({
    item_id: f.item_id || null, name: f.name || '', qty: Number(f.qty) || 1, rate: Number(f.rate) || 0,
  })) : [];
  const poAmt = poRate * qty;
  const focAmt = focs.reduce((t, f) => t + f.rate * f.qty, 0);
  const cost = Math.round((poAmt + focAmt + labour) * 100) / 100;
  const tpa = Math.round(cost * (1 + margin / 100) * 100) / 100;
  return { qty, poRate, labour, margin, focs, cost, tpa };
}

router.get('/po-foc', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM po_foc_entries ORDER BY updated_at DESC, id DESC').all();
  const counts = { non_approved: 0, approved: 0, re_approved: 0 };
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  res.json({ rows: rows.map(r => ({ ...r, focs: JSON.parse(r.focs_json || '[]') })), counts });
});

router.get('/po-foc/:id', (req, res) => {
  const r = getDb().prepare('SELECT * FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, focs: JSON.parse(r.focs_json || '[]') });
});

router.post('/po-foc', (req, res) => {
  const c = computePoFoc(req.body);
  const r = getDb().prepare(
    `INSERT INTO po_foc_entries (po_item_id, po_name, po_rate, qty, labour, margin, focs_json, cost, tpa, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?, 'non_approved', ?)`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/po-foc/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT status FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const c = computePoFoc(req.body);
  // Editing an APPROVED entry sends it to re_approved (mam's rule).
  const newStatus = cur.status === 'approved' ? 're_approved' : cur.status;
  db.prepare(
    `UPDATE po_foc_entries SET po_item_id=?, po_name=?, po_rate=?, qty=?, labour=?, margin=?,
            focs_json=?, cost=?, tpa=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour, c.margin,
        JSON.stringify(c.focs), c.cost, c.tpa, newStatus, req.params.id);
  res.json({ message: 'Updated', status: newStatus });
});

router.post('/po-foc/:id/approve', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT id FROM po_foc_entries WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  db.prepare(`UPDATE po_foc_entries SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(req.user.id, req.params.id);
  res.json({ message: 'Approved' });
});

router.delete('/po-foc/:id', (req, res) => {
  getDb().prepare('DELETE FROM po_foc_entries WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
