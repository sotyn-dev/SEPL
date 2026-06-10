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

// Turn extracted PDF/Word text into BOQ line items: each meaningful line is a
// description (header/note/total lines skipped); a trailing "<n> <unit>"
// becomes the qty.
function textToLines(text) {
  const raw = String(text || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const SKIP = /^(s\.?\s*no\.?|sr\.?\s*no\.?|sl\.?\s*no\.?|description|particulars?|hsn|grand total|sub\s*total|subtotal|total\b|note|notes|terms|page\b|quotation\b|date\b|validity|currency|subject|scope|to:|m\/s|email|website|secured ?engineers|fire ?fighting|#$|qty|quantity|uom|unit|rate|amount|gst|cgst|sgst|igst)\b/i;
  const isSerial = l => /^\d{1,3}$/.test(l);                         // item number on its own line
  const isPriceLine = l => /(mtrs?|nos|pcs|sets?|kg|each|point|rmt|rft|sqm|cum)\b/i.test(l) && /(₹|\brs\b|\d{2,})/i.test(l);
  const items = [];
  let cur = null;
  for (const l of raw) {
    if (SKIP.test(l)) continue;
    if (isSerial(l)) { if (cur && cur.parts.length) items.push(cur); cur = { parts: [] }; continue; }
    if (!cur) continue;                                              // skip the header preamble before item #1
    if (isPriceLine(l) && cur.parts.length) continue;                // drop the HSN/qty/rate/amount line
    // also handle a serial prefixed inline: "1. Supply of ..."
    const cleaned = l.replace(/^\s*\d+(\.\d+)*[).]\s+/, '').trim();
    if (cleaned.length >= 3) cur.parts.push(cleaned);
  }
  if (cur && cur.parts.length) items.push(cur);
  return items
    .map(it => ({ description: it.parts.join(' — ').replace(/\s+/g, ' ').trim(), qty: 1, unit: '' }))
    .filter(it => it.description.length > 3 && /[a-z]{3,}/i.test(it.description));
}

// Use Claude to extract clean BOQ line items from raw PDF/Word text — it
// groups multi-line descriptions (name + spec + make) into one item and skips
// headers/notes/totals. Returns [{description, qty}] or null if AI not set up.
async function llmExtractItems(text) {
  const apiKey = aiSetting('ai_api_key');
  if (!apiKey || !text) return null;
  let Anthropic; try { Anthropic = require('@anthropic-ai/sdk'); } catch (e) { return null; }
  const model = aiSetting('ai_model') || 'claude-opus-4-7';
  const client = new Anthropic.default({ apiKey, timeout: 55000 });
  const prompt = `Extract the BOQ / requirement line items from this client document text.
Each item may span SEVERAL lines (item name, long description, "Make: ...", size) — COMBINE those into ONE item's description.
Skip headers, column titles, notes, terms, totals, page numbers, addresses.
Return ONLY a JSON array, one object per item: {"description": "<full combined item text>", "qty": <number, default 1>}.

TEXT:
${String(text).slice(0, 14000)}`;
  const resp = await client.messages.create({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] });
  const t = (resp.content || []).map(c => c.text || '').join('');
  const a = t.indexOf('['), b = t.lastIndexOf(']');
  if (a === -1 || b === -1) return null;
  const arr = JSON.parse(t.slice(a, b + 1));
  const out = arr.filter(x => x && x.description && String(x.description).trim().length > 3)
    .map(x => ({ description: String(x.description).replace(/\s+/g, ' ').trim(), qty: Number(x.qty) || 1, unit: '' }));
  return out.length ? out : null;
}

// POST a CLIENT BOQ (Excel / PDF / Word) → auto-match each line to Item
// Master and return a suggested item + rate + confidence per line.
router.post('/auto-match-boq', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const ext = String(req.file.originalname || '').toLowerCase().split('.').pop();
    let lines = [];
    if (ext === 'pdf') {
      const pdfParse = require('pdf-parse');
      const data = await pdfParse(fs.readFileSync(req.file.path));
      lines = (await llmExtractItems(data.text).catch(() => null)) || textToLines(data.text);
    } else if (ext === 'docx' || ext === 'doc') {
      const mammoth = require('mammoth');
      const r = await mammoth.extractRawText({ path: req.file.path });
      lines = (await llmExtractItems(r.value).catch(() => null)) || textToLines(r.value);
    } else {
      // Excel / CSV — find the header row, then read Description/Qty/Unit cols.
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
      for (const name of wb.SheetNames) { const r = parseSheet(name); if (r.length > lines.length) lines = r; }
    }
    if (!lines.length) return res.status(400).json({ error: 'Could not read any items. For Excel: ensure a Description/Qty header row. For PDF/Word: the items must be text (not a scanned image).' });

    // Match the client BOQ against OUR PO items only (the ones quoted, with
    // PO/FOC kits) — mam 2026-06-10. FOC/consumables aren't quoted as lines.
    const items = getDb().prepare(`SELECT id, item_code, department, item_name, specification, size, uom, current_price FROM item_master WHERE type='PO'`).all();
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
  const labour = Number(body.labour) || 0;                 // labour rate (from labour_rates)
  const margin = Number(body.margin) || 0;
  const labourMargin = (body.labour_margin === '' || body.labour_margin == null) ? 50 : Number(body.labour_margin) || 0;
  const focs = Array.isArray(body.focs) ? body.focs.filter(f => f && (f.item_id || f.name)).map(f => ({
    item_id: f.item_id || null, name: f.name || '', qty: Number(f.qty) || 1, rate: Number(f.rate) || 0,
  })) : [];
  const poAmt = poRate * qty;
  const focAmt = focs.reduce((t, f) => t + f.rate * f.qty, 0);
  const labourAmt = labour * qty;                          // labour RATE × PO qty
  const cost = Math.round((poAmt + focAmt + labourAmt) * 100) / 100;
  // PO + FOC carry the item margin; labour carries its own labour margin.
  const tpa = Math.round(((poAmt + focAmt) * (1 + margin / 100) + labourAmt * (1 + labourMargin / 100)) * 100) / 100;
  return { qty, poRate, labour, margin, labourMargin, focs, cost, tpa };
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
    `INSERT INTO po_foc_entries (po_item_id, po_name, po_rate, qty, labour, labour_item_id, labour_name, labour_margin, margin, focs_json, cost, tpa, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'non_approved', ?)`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
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
    `UPDATE po_foc_entries SET po_item_id=?, po_name=?, po_rate=?, qty=?, labour=?, labour_item_id=?, labour_name=?, labour_margin=?, margin=?,
            focs_json=?, cost=?, tpa=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(req.body.po_item_id || null, req.body.po_name || '', c.poRate, c.qty, c.labour,
        req.body.labour_item_id || null, req.body.labour_name || '', c.labourMargin, c.margin,
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

// ── Labour Rate sheet (mam 2026-06-10) ────────────────────────────
router.get('/labour-rates', (req, res) => {
  const db = getDb();
  const { search, category } = req.query;
  const cond = [], args = [];
  if (category) { cond.push('category = ?'); args.push(category); }
  if (search) { cond.push('LOWER(item_name) LIKE ?'); args.push('%' + String(search).toLowerCase() + '%'); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  res.json(db.prepare(`SELECT * FROM labour_rates ${where} ORDER BY category, item_name`).all(...args));
});

router.post('/labour-rates', (req, res) => {
  const { item_name, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  const r = getDb().prepare('INSERT INTO labour_rates (item_name, rate, uom, category, created_by) VALUES (?,?,?,?,?)')
    .run(String(item_name).trim(), Number(rate) || 0, uom || '', category || '', req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});

router.put('/labour-rates/:id', (req, res) => {
  const { item_name, rate, uom, category } = req.body;
  if (!item_name || !String(item_name).trim()) return res.status(400).json({ error: 'Item name is required' });
  getDb().prepare('UPDATE labour_rates SET item_name=?, rate=?, uom=?, category=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(String(item_name).trim(), Number(rate) || 0, uom || '', category || '', req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/labour-rates/:id', (req, res) => {
  getDb().prepare('DELETE FROM labour_rates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ── Saved AI Auto-Quotation estimates (mam 2026-06-10) ────────────
router.get('/estimates', (req, res) => {
  const rows = getDb().prepare(`SELECT id, title, client_name, sp, cost, updated_at, created_at
    FROM estimate_quotations ORDER BY client_name COLLATE NOCASE, updated_at DESC`).all();
  res.json(rows);
});
router.get('/estimates/:id', (req, res) => {
  const r = getDb().prepare('SELECT * FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r, margins: JSON.parse(r.margins_json || '{}'), rows: JSON.parse(r.rows_json || '[]'), manpower: JSON.parse(r.manpower_json || '[]') });
});
router.post('/estimates', (req, res) => {
  const b = req.body || {};
  const r = getDb().prepare(`INSERT INTO estimate_quotations (title, lead_id, client_name, acc_pct, margins_json, rows_json, manpower_json, cost, sp, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
    JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []),
    Number(b.cost) || 0, Number(b.sp) || 0, req.user.id);
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});
router.put('/estimates/:id', (req, res) => {
  const b = req.body || {};
  const ex = getDb().prepare('SELECT id FROM estimate_quotations WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  getDb().prepare(`UPDATE estimate_quotations SET title=?, lead_id=?, client_name=?, acc_pct=?, margins_json=?, rows_json=?, manpower_json=?, cost=?, sp=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.title || '', b.lead_id || null, b.client_name || '', Number(b.acc_pct) || 0,
      JSON.stringify(b.margins || {}), JSON.stringify(b.rows || []), JSON.stringify(b.manpower || []),
      Number(b.cost) || 0, Number(b.sp) || 0, req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/estimates/:id', (req, res) => {
  getDb().prepare('DELETE FROM estimate_quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Build the multi-sheet quotation Excel (mam's saizar format): one sheet per
// category + a SUMMARY with letterhead, category totals and a manpower block.
router.post('/estimate-export', (req, res) => {
  try {
    const { title = '', client_name = '', client_address = '', quotation_no = '', prep_by = '',
      rows = [], manpower = [] } = req.body || {};
    const wb = XLSX.utils.book_new();
    const safeSheet = (s) => String(s || 'General').replace(/[\\/?*[\]:]/g, ' ').slice(0, 28).trim() || 'Sheet';
    const byCat = {};
    for (const r of rows) { const c = r.category || 'General'; (byCat[c] = byCat[c] || []).push(r); }

    const catTotals = [];
    for (const [cat, items] of Object.entries(byCat)) {
      const aoa = [['S.NO.', 'DESCRIPTION', 'MAKE', 'UNIT', 'QTY', 'RATE', 'AMOUNT', '', 'PP', 'ACCESS', 'LAB', 'TP', 'TPA', 'MARGIN', 'SP']];
      let sp = 0;
      items.forEach((it, i) => {
        aoa.push([i + 1, it.description || '', it.make || '', it.unit || '', it.qty || 0, it.rate || 0, it.sp || 0,
          '', it.pp || 0, it.acc || 0, it.lab || 0, it.tp || 0, it.tpa || 0, (it.margin || 0) + '%', it.sp || 0]);
        sp += Number(it.sp) || 0;
      });
      aoa.push(['TOTAL', '', '', '', '', '', Math.round(sp * 100) / 100, '', '', '', '', '', Math.round(sp * 100) / 100]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), safeSheet(cat));
      catTotals.push({ cat, sp });
    }

    const sum = [];
    sum.push(['SECURED ENGINEERS PVT. LTD']);
    sum.push(['H.O: 2480/1 , B.K. Towers, Janta Nagar, Gill Road, Ludhiana']);
    sum.push(['C.O : 58/A/1, First Floor, Kalu Sarai, New Delhi - 110016']);
    sum.push(['Website : www.securedengineers.com']);
    sum.push([`QUOTATION FOR ${title || 'WORK'}`]);
    sum.push(['NAME', client_name, '', 'Date-:', new Date().toISOString().slice(0, 10)]);
    sum.push(['ADDRESS', client_address, '', 'Quotation No', quotation_no]);
    sum.push(['PREP BY', prep_by, '', 'Revision No', 'R0']);
    sum.push([]);
    sum.push(['S.No.', 'Description', 'SP Amount (Rs)']);
    let grand = 0;
    catTotals.forEach((c, i) => { sum.push([i + 1, c.cat, Math.round(c.sp * 100) / 100]); grand += c.sp; });
    sum.push(['', 'SUB TOTAL', Math.round(grand * 100) / 100]);
    sum.push([]);
    sum.push(['Additional / Manpower Cost', 'Qty', 'Monthly Cost', 'Months', 'Amount']);
    let mTotal = 0;
    manpower.filter(m => m && m.name).forEach(m => {
      const amt = (Number(m.qty) || 0) * (Number(m.monthly_cost) || 0) * (Number(m.months) || 0);
      sum.push([m.name, m.qty || 0, m.monthly_cost || 0, m.months || 0, Math.round(amt * 100) / 100]);
      mTotal += amt;
    });
    sum.push(['', '', '', 'Manpower Total', Math.round(mTotal * 100) / 100]);
    sum.push(['', '', '', 'GRAND TOTAL', Math.round((grand + mTotal) * 100) / 100]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'SUMMARY');
    wb.SheetNames.unshift(wb.SheetNames.pop()); // SUMMARY first

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="quotation-${String(title || 'estimate').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});

module.exports = router;
