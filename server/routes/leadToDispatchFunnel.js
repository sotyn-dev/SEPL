// Lead-to-Dispatch Funnel — API, mounted at /api/lead-funnel.
//
// Isolation: every write here targets the funnel DB (getFunnelDb). Reads of
// the main ERP are read-only and live in the AI engine, not here. The main
// listing is visible to any authenticated user; settings + PO approval are
// admin-only (mirrors aiAgent.js's adminOnly). The Twilio webhook is mounted
// BEFORE authMiddleware (Twilio can't send a JWT).

const express = require('express');
const { getFunnelDb, getFunnelSetting, setFunnelSetting } = require('../db/leadToDispatchFunnelDb');
const { nextSequence } = require('../db/nextSequence');
const { authMiddleware } = require('../middleware/auth');
const { isValidStage, STAGES, SIDE_STATES } = require('../lib/l2dStages');
const { parseInboundButton, sendTemplate } = require('../lib/whatsappSend');
const { draftVendorPo } = require('../lib/lead2DispatchFunnelAi');
const { normalisePhone } = require('../utils/whatsapp');

const router = express.Router();

function adminOnly(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

function recordStage(db, leadId, toStage, req, note) {
  const cur = db.prepare('SELECT stage FROM l2d_leads WHERE id=?').get(leadId);
  db.prepare(
    `INSERT INTO l2d_stage_history (lead_id, from_stage, to_stage, changed_by, changed_by_name, note)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(leadId, cur?.stage || null, toStage, req?.user?.id || null, req?.user?.name || 'system', note || null);
  db.prepare('UPDATE l2d_leads SET stage=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(toStage, leadId);
}

// ─── Twilio inbound webhook (NO AUTH — must precede authMiddleware) ───
// A quick-reply tap advances the pipeline:
//   Confirm Order → ORDER_CONFIRMED, then auto-send the bank-details template → BANK_SENT
//   Expect a Call → CALL_REQUESTED (sales coordinator follows up)
router.post('/whatsapp/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  // Always 200 quickly so Twilio doesn't retry; do work best-effort.
  res.status(200).type('text/xml').send('<Response></Response>');
  try {
    const { from, action, text } = parseInboundButton(req.body || {});
    if (!from) return;
    const db = getFunnelDb();
    const last10 = from.slice(-10);
    const lead = db.prepare(
      `SELECT * FROM l2d_leads WHERE sender_mobile LIKE ? ORDER BY created_at DESC LIMIT 1`
    ).get(`%${last10}%`);
    // Log the inbound regardless so it shows in the message log.
    db.prepare(
      `INSERT INTO l2d_messages (lead_id, direction, channel, template, body, status)
       VALUES (?, 'in', 'whatsapp', NULL, ?, 'received')`
    ).run(lead?.id || 0, text || '');
    if (!lead) return;

    if (action === 'confirm_order') {
      recordStage(db, lead.id, 'ORDER_CONFIRMED', null, 'client tapped Confirm Order');
      const bankSid = getFunnelSetting('bank_template_sid') || process.env.L2D_BANK_TEMPLATE_SID || null;
      const sent = await sendTemplate({ lead, templateSid: bankSid, templateLabel: 'bank', variables: { 1: lead.sender_name || 'there' } });
      recordStage(db, lead.id, 'BANK_SENT', null, `bank details ${sent.ok ? 'sent' : 'send failed: ' + sent.error}`);
    } else if (action === 'expect_call') {
      recordStage(db, lead.id, 'CALL_REQUESTED', null, 'client tapped Expect a Call');
    } else {
      // Free-text reply → mark interested so a human takes over in the 24h window.
      if (lead.stage === 'WELCOME_SENT') recordStage(db, lead.id, 'INTERESTED', null, `inbound: "${(text || '').slice(0, 80)}"`);
    }
  } catch (e) {
    console.error('[lead-funnel] webhook error:', e.message);
  }
});

// Everything below requires auth.
router.use(authMiddleware);

// ─── Leads ───────────────────────────────────────────────────────────
router.get('/leads', (req, res) => {
  const db = getFunnelDb();
  const { stage, source, tag } = req.query;
  const where = [];
  const params = [];
  if (stage) { where.push('stage = ?'); params.push(stage); }
  if (source) { where.push('source = ?'); params.push(source); }
  if (tag) { where.push('ai_verdict = ?'); params.push(tag); }
  const sql = `SELECT * FROM l2d_leads ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT 1000`;
  res.json(db.prepare(sql).all(...params));
});

router.get('/leads/:id', (req, res) => {
  const db = getFunnelDb();
  const lead = db.prepare('SELECT * FROM l2d_leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const history = db.prepare('SELECT * FROM l2d_stage_history WHERE lead_id=? ORDER BY created_at ASC').all(lead.id);
  const messages = db.prepare('SELECT * FROM l2d_messages WHERE lead_id=? ORDER BY created_at ASC').all(lead.id);
  const vendorPo = db.prepare('SELECT * FROM l2d_vendor_po WHERE lead_id=? ORDER BY created_at DESC').all(lead.id);
  const followups = db.prepare('SELECT * FROM l2d_followups WHERE lead_id=? ORDER BY due_date ASC').all(lead.id);
  res.json({ lead, history, messages, vendorPo, followups });
});

router.patch('/leads/:id/stage', (req, res) => {
  const db = getFunnelDb();
  const { stage, note } = req.body || {};
  if (!isValidStage(stage)) return res.status(400).json({ error: 'Invalid stage' });
  const lead = db.prepare('SELECT id FROM l2d_leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  recordStage(db, lead.id, stage, req, note || 'manual stage change');
  res.json({ message: 'Stage updated', stage });
});

// Capture fields (steps 8–12) + opt-out. Whitelisted columns only.
const CAPTURE_COLS = [
  'po_number', 'po_amount', 'payment_ref', 'dispatch_ref', 'purchase_bill_url',
  'purchase_bill_number', 'sales_bill_number', 'sales_bill_amount', 'receipt_amount',
  'receipt_date', 'opted_out', 'assigned_to', 'quoted_price', 'matched_item_name',
];
router.patch('/leads/:id', (req, res) => {
  const db = getFunnelDb();
  const lead = db.prepare('SELECT id FROM l2d_leads WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  const sets = [];
  const params = [];
  for (const col of CAPTURE_COLS) {
    if (Object.prototype.hasOwnProperty.call(req.body || {}, col)) {
      sets.push(`${col} = ?`);
      params.push(req.body[col]);
    }
  }
  if (!sets.length) return res.status(400).json({ error: 'No updatable fields provided' });
  params.push(lead.id);
  db.prepare(`UPDATE l2d_leads SET ${sets.join(', ')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(...params);
  res.json({ message: 'Lead updated' });
});

// ─── Stats (funnel summary) ──────────────────────────────────────────
router.get('/stats', (req, res) => {
  const db = getFunnelDb();
  const rows = db.prepare('SELECT stage, COUNT(*) AS n FROM l2d_leads GROUP BY stage').all();
  const counts = Object.fromEntries(rows.map(r => [r.stage, r.n]));
  const total = rows.reduce((s, r) => s + r.n, 0);
  res.json({
    total,
    counts,
    stages: STAGES.map(s => ({ ...s, count: counts[s.key] || 0 })),
    sideStates: SIDE_STATES.map(s => ({ ...s, count: counts[s.key] || 0 })),
  });
});

// ─── Vendor PO (funnel-only draft; never touches main ERP vendor_pos) ──
router.post('/vendor-po/:leadId/draft', async (req, res) => {
  const db = getFunnelDb();
  const lead = db.prepare('SELECT * FROM l2d_leads WHERE id=?').get(req.params.leadId);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  try {
    const draft = await draftVendorPo(lead, { item_id: lead.matched_item_id, item_name: lead.matched_item_name });
    const poNumber = nextSequence(db, 'l2d_vendor_po', 'po_number', 'VPO-', { pad: 4 });
    const rate = Number(draft.rate) || 0;
    const qty = Number(draft.qty) || 1;
    const info = db.prepare(
      `INSERT INTO l2d_vendor_po (lead_id, po_number, item_id, item_name, qty, rate, amount, vendor_candidates_json, status, drafted_by_ai)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1)`
    ).run(lead.id, poNumber, draft.item_id, draft.item_name, qty, rate, qty * rate, JSON.stringify(draft.vendor_candidates || []));
    recordStage(db, lead.id, 'PO_DRAFTED', req, `vendor PO ${poNumber} drafted (AI shortlist of ${(draft.vendor_candidates || []).length})`);
    res.json({ message: 'PO draft created', id: info.lastInsertRowid, po_number: poNumber, vendor_candidates: draft.vendor_candidates });
  } catch (e) {
    console.error('[lead-funnel] PO draft failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

router.post('/vendor-po/:poId/approve', adminOnly, (req, res) => {
  const db = getFunnelDb();
  const { vendor, rate, qty } = req.body || {};
  if (!vendor) return res.status(400).json({ error: 'vendor is required to approve' });
  const po = db.prepare('SELECT * FROM l2d_vendor_po WHERE id=?').get(req.params.poId);
  if (!po) return res.status(404).json({ error: 'PO not found' });
  const newRate = rate != null ? Number(rate) : po.rate;
  const newQty = qty != null ? Number(qty) : po.qty;
  db.prepare(
    `UPDATE l2d_vendor_po SET vendor=?, rate=?, qty=?, amount=?, status='approved',
       approved_by=?, approved_by_name=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`
  ).run(vendor, newRate, newQty, newRate * newQty, req.user.id, req.user.name, po.id);
  // Reflect on the lead for quick reference (funnel DB only).
  db.prepare('UPDATE l2d_leads SET po_number=?, po_amount=? WHERE id=?').run(po.po_number, newRate * newQty, po.lead_id);
  res.json({ message: 'PO approved', vendor });
});

// ─── Follow-ups (step 13) ────────────────────────────────────────────
router.post('/followups', (req, res) => {
  const db = getFunnelDb();
  const { lead_id, due_date, note } = req.body || {};
  if (!lead_id || !due_date) return res.status(400).json({ error: 'lead_id and due_date required' });
  const info = db.prepare('INSERT INTO l2d_followups (lead_id, due_date, note) VALUES (?, ?, ?)').run(lead_id, due_date, note || null);
  res.json({ message: 'Follow-up scheduled', id: info.lastInsertRowid });
});

router.patch('/followups/:id', (req, res) => {
  const db = getFunnelDb();
  const { sent, note, due_date } = req.body || {};
  const sets = [];
  const params = [];
  if (sent != null) { sets.push('sent = ?', 'sent_at = CURRENT_TIMESTAMP'); params.push(sent ? 1 : 0); }
  if (note != null) { sets.push('note = ?'); params.push(note); }
  if (due_date != null) { sets.push('due_date = ?'); params.push(due_date); }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE l2d_followups SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Follow-up updated' });
});

// ─── Settings (admin) ────────────────────────────────────────────────
function mask(v) { return v ? `${String(v).slice(0, 4)}…${String(v).slice(-4)}` : null; }

router.get('/settings', adminOnly, (req, res) => {
  const crmKey = getFunnelSetting('indiamart_crm_key');
  res.json({
    keyword_include: getFunnelSetting('keyword_include') || '[]',
    keyword_exclude: getFunnelSetting('keyword_exclude') || '[]',
    ai_scope_prompt: getFunnelSetting('ai_scope_prompt') || '',
    margin_pct: getFunnelSetting('margin_pct') || '0',
    welcome_template_sid: getFunnelSetting('welcome_template_sid') || '',
    bank_template_sid: getFunnelSetting('bank_template_sid') || '',
    followup_template_sid: getFunnelSetting('followup_template_sid') || '',
    indiamart_crm_key_set: !!crmKey,
    indiamart_crm_key_masked: mask(crmKey),
  });
});

router.put('/settings', adminOnly, (req, res) => {
  const b = req.body || {};
  const passthrough = ['keyword_include', 'keyword_exclude', 'ai_scope_prompt', 'margin_pct',
    'welcome_template_sid', 'bank_template_sid', 'followup_template_sid'];
  for (const k of passthrough) {
    if (Object.prototype.hasOwnProperty.call(b, k)) {
      let v = b[k];
      if ((k === 'keyword_include' || k === 'keyword_exclude') && Array.isArray(v)) v = JSON.stringify(v);
      setFunnelSetting(k, v);
    }
  }
  // CRM key only overwritten when a non-empty value is sent (keeps current otherwise).
  if (typeof b.indiamart_crm_key === 'string' && b.indiamart_crm_key.trim()) {
    setFunnelSetting('indiamart_crm_key', b.indiamart_crm_key.trim());
  }
  res.json({ message: 'Funnel settings saved' });
});

// Admin: run the poller on demand (verify ingestion without waiting 15 min).
router.post('/run-poll-now', adminOnly, async (req, res) => {
  try {
    const { runOnce } = require('../scripts/indiamartPollCron');
    const r = await runOnce();
    res.json({ message: 'Poll complete', ...r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
