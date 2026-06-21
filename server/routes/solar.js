// Solar Quotation module API (mam 2026-06-21).
// Dedicated solar rate book (panels/inverters/structure/cables/bos/labour),
// engineering factors + settings, and saved solar quotations. Gated by the
// `solar_quotation` module permission. Tables created/seeded by db/seedSolar.js.
const express = require('express');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { ensureSolarSchema } = require('../db/seedSolar');

const router = express.Router();
router.use(authMiddleware);

// Defensive: guarantee tables exist even if the boot seed was skipped.
try { ensureSolarSchema(getDb()); } catch (e) { console.warn('[solar] ensureSchema:', e.message); }

const n = (v) => (v === undefined ? null : v);

// ── Rate book: the single payload the engine loads. Solar equipment rates come
//    from the shared item_master (department='SOLAR'); labour from labour_rates
//    (category='SOLAR'); only engineering factors + settings are solar-only.
router.get('/rate-book', requirePermission('solar_quotation', 'view'), (req, res) => {
  const db = getDb();
  const items = db.prepare("SELECT type, make, item_name, specification, size, current_price FROM item_master WHERE type LIKE 'solar-%'").all();
  const ui = { panel: {}, inverter: {}, structure: {}, cable: {} };
  const bos = {};
  const invSizes = new Set();
  const counts = { panels: 0, inverters: 0, structure: 0, cables: 0, bos: 0 };
  for (const r of items) {
    const p = +r.current_price || 0;
    switch (r.type) {
      case 'solar-panel':
        ui.panel[r.make] = ui.panel[r.make] || [null, null];
        ui.panel[r.make][r.specification === 'DCR' ? 1 : 0] = p; counts.panels++; break;
      case 'solar-inverter': {
        ui.inverter[r.make] = p; const kw = parseFloat(r.size); if (kw) invSizes.add(kw); counts.inverters++; break;
      }
      case 'solar-structure':
        ui.structure[r.make] = p; counts.structure++; break;
      case 'solar-cable': {
        ui.cable[r.make] = ui.cable[r.make] || [null, null];
        const sz = parseFloat(r.size);
        if (r.specification === 'DC String' && sz === 4) ui.cable[r.make][0] = p;
        if (r.specification === 'AC LT') ui.cable[r.make][1] = p;
        counts.cables++; break;
      }
      case 'solar-bos':
        bos[r.item_name] = p; counts.bos++; break;
    }
  }
  const labour = {};
  for (const r of db.prepare("SELECT item_name, rate FROM labour_rates WHERE category='SOLAR'").all()) labour[r.item_name] = +r.rate || 0;

  const mount = {}, array = {}, state = {};
  for (const f of db.prepare('SELECT * FROM solar_factors').all()) {
    if (f.kind === 'mount') mount[f.name] = { struct_mult: f.val1, area_per_kwp: f.val2 };
    if (f.kind === 'array') array[f.name] = { struct_mult: f.val1, yield_mult: f.val2 };
    if (f.kind === 'state') state[f.name] = { specific_yield: f.val1, t_min: f.val2, t_max: f.val3 };
  }
  const settingsObj = {};
  for (const s of db.prepare('SELECT key, value FROM solar_settings').all()) settingsObj[s.key] = isNaN(+s.value) ? s.value : +s.value;
  const inverterSizes = [...invSizes].sort((a, b) => b - a);

  res.json({ ui, factors: { mount, array, state }, settings: settingsObj, inverterSizes, bos, labour, counts });
});

// ── Factors & settings (Rate Master) ──────────────────────────────
router.get('/factors', requirePermission('solar_quotation', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM solar_factors ORDER BY kind, name').all());
});
router.put('/factors/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const b = req.body || {};
  getDb().prepare('UPDATE solar_factors SET val1=?, val2=?, val3=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(n(b.val1), n(b.val2), n(b.val3), req.params.id);
  res.json({ message: 'Updated' });
});
router.get('/settings', requirePermission('solar_quotation', 'view'), (req, res) => {
  res.json(getDb().prepare('SELECT * FROM solar_settings ORDER BY key').all());
});
router.put('/settings/:key', requirePermission('solar_quotation', 'edit'), (req, res) => {
  getDb().prepare('UPDATE solar_settings SET value=?, updated_at=CURRENT_TIMESTAMP WHERE key=?')
    .run(String(req.body?.value ?? ''), req.params.key);
  res.json({ message: 'Updated' });
});

// ── Saved solar quotations ────────────────────────────────────────
router.get('/quotations', requirePermission('solar_quotation', 'view'), (req, res) => {
  res.json(getDb().prepare(`SELECT id, quote_no, client_name, project_type, capacity_kw,
    cost, margin_pct, sell, sell_per_w, grand_total, status, updated_at, created_at
    FROM solar_quotations ORDER BY updated_at DESC`).all());
});
router.get('/quotations/:id', requirePermission('solar_quotation', 'view'), (req, res) => {
  const r = getDb().prepare('SELECT * FROM solar_quotations WHERE id=?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Not found' });
  res.json({ ...r,
    inputs: JSON.parse(r.inputs_json || '{}'), boq: JSON.parse(r.boq_json || '[]'),
    engineering: JSON.parse(r.engineering_json || '{}'), roi: JSON.parse(r.roi_json || '{}') });
});
function quoteParams(b) {
  return [n(b.quote_no), n(b.lead_id), n(b.client_name), n(b.address), n(b.project_type),
    Number(b.capacity_kw) || 0, Number(b.dc_ac_ratio) || 0, n(b.panel_make), n(b.inverter_make),
    JSON.stringify(b.inputs || {}), JSON.stringify(b.boq || []), JSON.stringify(b.engineering || {}),
    JSON.stringify(b.roi || {}), Number(b.cost) || 0, Number(b.margin_pct) || 0, Number(b.sell) || 0,
    Number(b.sell_per_w) || 0, Number(b.gst_amt) || 0, Number(b.grand_total) || 0, b.status || 'draft'];
}
router.post('/quotations', requirePermission('solar_quotation', 'create'), (req, res) => {
  const db = getDb();
  const r = db.prepare(`INSERT INTO solar_quotations
    (quote_no,lead_id,client_name,address,project_type,capacity_kw,dc_ac_ratio,panel_make,inverter_make,
     inputs_json,boq_json,engineering_json,roi_json,cost,margin_pct,sell,sell_per_w,gst_amt,grand_total,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...quoteParams(req.body || {}), req.user.id);
  // Funnel auto-advance: a quote created from a deal pushes it to the Quotation stage.
  if (req.body?.deal_id) { try { advanceDealOnQuote(db, req.body.deal_id, r.lastInsertRowid, req.user); } catch (e) { console.warn('[solar] deal advance:', e.message); } }
  res.json({ id: r.lastInsertRowid, message: 'Saved' });
});
router.put('/quotations/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const ex = getDb().prepare('SELECT id FROM solar_quotations WHERE id=?').get(req.params.id);
  if (!ex) return res.status(404).json({ error: 'Not found' });
  getDb().prepare(`UPDATE solar_quotations SET quote_no=?,lead_id=?,client_name=?,address=?,project_type=?,
    capacity_kw=?,dc_ac_ratio=?,panel_make=?,inverter_make=?,inputs_json=?,boq_json=?,engineering_json=?,roi_json=?,
    cost=?,margin_pct=?,sell=?,sell_per_w=?,gst_amt=?,grand_total=?,status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...quoteParams(req.body || {}), req.params.id);
  res.json({ message: 'Updated' });
});
router.delete('/quotations/:id', requirePermission('solar_quotation', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM solar_quotations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Excel export of a solar quote (BOQ sheet + commercial summary).
router.post('/quotations/export', requirePermission('solar_quotation', 'view'), (req, res) => {
  try {
    const b = req.body || {};
    const boq = b.boq || [];
    const wb = XLSX.utils.book_new();
    const aoa = [['S.No', 'Description', 'Unit', 'Make', 'Qty', 'Purch ₹/u', 'PP ₹', 'TPA ₹ (cost)', 'Margin %', 'SP ₹', 'Rate ₹']];
    boq.forEach((l, i) => aoa.push([i + 1, l.desc || '', l.unit || '', l.make || '', l.qty || 0,
      r2(l.ppUnit), r2(l.pp), r2(l.tpa), l.tpa ? r2((l.sp - l.tpa) / l.tpa * 100) : 0, r2(l.sp), r2(l.rate)]));
    aoa.push([]);
    aoa.push(['', 'TOTAL (ex-GST)', '', '', '', '', r2(b.cost), r2(b.cost), r2(b.margin_pct), r2(b.sell), `₹${r2(b.sell_per_w)}/W`]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), 'BOQ');

    const sum = [];
    sum.push(['Secured Engineers India']);
    sum.push([`QUOTATION FOR ${b.capacity_kw || ''} KW ${(b.project_type || 'ON GRID').toUpperCase()} SOLAR SYSTEM`]);
    sum.push(['Client', b.client_name || '', '', 'Date', new Date().toISOString().slice(0, 10)]);
    sum.push(['Address', b.address || '', '', 'Quote No', b.quote_no || '']);
    sum.push([]);
    sum.push(['System (DC)', `${b.capacity_dc_kwp || b.capacity_kw || ''} kWp`]);
    sum.push(['Base price (ex-GST)', r2(b.sell), `₹${r2(b.sell_per_w)}/watt`]);
    sum.push(['GST', r2(b.gst_amt)]);
    sum.push(['Grand total (incl GST)', r2(b.grand_total)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'SUMMARY');
    wb.SheetNames.unshift(wb.SheetNames.pop());

    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    res.setHeader('Content-Disposition', `attachment; filename="solar-quote-${String(b.client_name || 'quote').replace(/[^a-z0-9]/gi, '_')}.xlsx"`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Export failed: ' + err.message });
  }
});
function r2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

// ════════════════ Solar Sales Funnel ════════════════
const STAGES = [
  { key: 'inquiry', label: 'New Inquiry', sla: 2, prob: 10, action: 'Call & qualify the requirement' },
  { key: 'qualification', label: 'Qualification', sla: 3, prob: 20, action: 'Collect load / electricity bill & site type' },
  { key: 'survey', label: 'Site Survey', sla: 5, prob: 35, action: 'Schedule & complete the site survey' },
  { key: 'design', label: 'Design & BOQ', sla: 4, prob: 50, action: 'Prepare system design + BOQ' },
  { key: 'quotation', label: 'Quotation Sent', sla: 5, prob: 65, action: 'Send the solar quotation & follow up' },
  { key: 'negotiation', label: 'Negotiation', sla: 7, prob: 80, action: 'Negotiate price / terms, revise if needed' },
  { key: 'approval', label: 'Approval', sla: 7, prob: 90, action: 'Secure subsidy / loan / PO approval' },
  { key: 'won', label: 'Won', sla: 0, prob: 100, action: 'Handover to installation' },
];
const STAGE_IDX = Object.fromEntries(STAGES.map((s, i) => [s.key, i]));
const stageMeta = (k) => STAGES[STAGE_IDX[k]] || null;

function logDealEvent(db, dealId, type, fromStage, toStage, note, user) {
  db.prepare(`INSERT INTO solar_deal_events (deal_id,type,from_stage,to_stage,note,by_user,by_name) VALUES (?,?,?,?,?,?,?)`)
    .run(dealId, type, fromStage || null, toStage || null, note || null, user?.id || null, user?.name || null);
}
// Push a deal to at least the Quotation stage when a quote is created from it.
function advanceDealOnQuote(db, dealId, quotationId, user) {
  const d = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(dealId);
  if (!d) return;
  db.prepare('UPDATE solar_deals SET quotation_id=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(quotationId, dealId);
  if (d.status === 'open' && STAGE_IDX[d.stage] < STAGE_IDX['quotation']) {
    db.prepare(`UPDATE solar_deals SET stage='quotation', stage_updated_at=CURRENT_TIMESTAMP,
       next_action=?, next_action_due=date('now','+5 days'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(stageMeta('quotation').action, dealId);
    logDealEvent(db, dealId, 'stage', d.stage, 'quotation', `Auto-advanced: quotation #${quotationId} created`, user);
  }
}

router.get('/funnel/config', requirePermission('solar_quotation', 'view'), (req, res) => res.json({ stages: STAGES }));

router.get('/deals', requirePermission('solar_quotation', 'view'), (req, res) => {
  const { stage, owner_id, q, include_lost } = req.query;
  const cl = [], p = [];
  if (!include_lost) cl.push("status != 'lost'");
  if (stage) { cl.push('stage=?'); p.push(stage); }
  if (owner_id) { cl.push('owner_id=?'); p.push(owner_id); }
  if (q) { cl.push('(client_name LIKE ? OR company LIKE ? OR deal_no LIKE ?)'); const s = `%${q}%`; p.push(s, s, s); }
  const where = cl.length ? 'WHERE ' + cl.join(' AND ') : '';
  const rows = getDb().prepare(`SELECT *, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage FROM solar_deals ${where} ORDER BY stage_updated_at DESC`).all(...p);
  res.json(rows.map((r) => ({ ...r, stuck: r.status === 'open' && r.days_in_stage > (stageMeta(r.stage)?.sla ?? 99) })));
});

router.get('/deals/:id', requirePermission('solar_quotation', 'view'), (req, res) => {
  const d = getDb().prepare('SELECT * FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  d.events = getDb().prepare('SELECT * FROM solar_deal_events WHERE deal_id=? ORDER BY created_at DESC').all(d.id);
  res.json(d);
});

router.post('/deals', requirePermission('solar_quotation', 'create'), (req, res) => {
  const b = req.body || {};
  const stage = STAGE_IDX[b.stage] != null ? b.stage : 'inquiry';
  const db = getDb();
  const r = db.prepare(`INSERT INTO solar_deals
    (lead_id,client_name,company,phone,location,state,capacity_kw,project_type,value,source,stage,owner_id,owner_name,next_action,next_action_due,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    n(b.lead_id), n(b.client_name), n(b.company), n(b.phone), n(b.location), n(b.state),
    Number(b.capacity_kw) || 0, n(b.project_type), Number(b.value) || 0, n(b.source), stage,
    n(b.owner_id), n(b.owner_name), b.next_action || stageMeta(stage)?.action, n(b.next_action_due), req.user.id);
  const id = r.lastInsertRowid;
  const deal_no = `SOL-${String(id).padStart(4, '0')}`;
  db.prepare('UPDATE solar_deals SET deal_no=? WHERE id=?').run(deal_no, id);
  if (stage === 'won') db.prepare("UPDATE solar_deals SET status='won' WHERE id=?").run(id);
  logDealEvent(db, id, 'created', null, stage, 'Deal created', req.user);
  res.json({ id, deal_no, message: 'Created' });
});

router.put('/deals/:id', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const b = req.body || {};
  const cols = ['client_name', 'company', 'phone', 'location', 'state', 'capacity_kw', 'project_type', 'value', 'source', 'owner_id', 'owner_name', 'next_action', 'next_action_due', 'lead_id'];
  const set = cols.filter((c) => c in b);
  if (!set.length) return res.json({ message: 'No change' });
  getDb().prepare(`UPDATE solar_deals SET ${set.map((c) => `${c}=?`).join(',')}, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(...set.map((c) => n(b[c])), req.params.id);
  res.json({ message: 'Updated' });
});

router.post('/deals/:id/move', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const to = req.body?.stage;
  if (STAGE_IDX[to] == null) return res.status(400).json({ error: 'Bad stage' });
  const m = stageMeta(to);
  db.prepare(`UPDATE solar_deals SET stage=?, stage_updated_at=CURRENT_TIMESTAMP, status=?,
     next_action=?, next_action_due=date('now','+'||?||' days'), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(to, to === 'won' ? 'won' : 'open', m.action, m.sla || 3, req.params.id);
  logDealEvent(db, d.id, 'stage', d.stage, to, req.body?.note || null, req.user);
  res.json({ message: 'Moved' });
});

router.post('/deals/:id/lose', requirePermission('solar_quotation', 'edit'), (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT stage FROM solar_deals WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  db.prepare("UPDATE solar_deals SET status='lost', lost_reason=?, updated_at=CURRENT_TIMESTAMP WHERE id=?").run(n(req.body?.reason), req.params.id);
  logDealEvent(db, req.params.id, 'lost', d.stage, null, req.body?.reason || null, req.user);
  res.json({ message: 'Marked lost' });
});

router.delete('/deals/:id', requirePermission('solar_quotation', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM solar_deal_events WHERE deal_id=?').run(req.params.id);
  getDb().prepare('DELETE FROM solar_deals WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Conversion analytics — reached / conversion% / drop-off / avg-days / stuck.
router.get('/funnel/analytics', requirePermission('solar_quotation', 'view'), (req, res) => {
  const db = getDb();
  const deals = db.prepare('SELECT id, stage, status, value FROM solar_deals').all();
  const events = db.prepare("SELECT deal_id, to_stage FROM solar_deal_events WHERE to_stage IS NOT NULL").all();
  const furthest = {};
  for (const d of deals) furthest[d.id] = STAGE_IDX[d.stage] ?? 0;
  for (const e of events) { const i = STAGE_IDX[e.to_stage]; if (i != null && i > (furthest[e.deal_id] ?? 0)) furthest[e.deal_id] = i; }
  const reached = STAGES.map(() => 0);
  for (const d of deals) { const f = furthest[d.id] ?? 0; for (let i = 0; i <= f; i++) reached[i]++; }
  const cur = STAGES.map(() => ({ n: 0, val: 0 }));
  for (const d of deals) { if (d.status === 'lost') continue; const i = STAGE_IDX[d.stage]; if (i != null) { cur[i].n++; cur[i].val += d.value || 0; } }
  const days = db.prepare("SELECT stage, AVG(julianday('now')-julianday(stage_updated_at)) AS d FROM solar_deals WHERE status='open' GROUP BY stage").all();
  const dayMap = {}; for (const r of days) dayMap[r.stage] = r.d;
  const byStage = STAGES.map((s, i) => ({
    key: s.key, label: s.label, reached: reached[i], current: cur[i].n, value: Math.round(cur[i].val),
    conversion: i === 0 ? 100 : (reached[i - 1] ? Math.round(reached[i] / reached[i - 1] * 100) : 0),
    dropoff: i === 0 ? 0 : Math.max(0, reached[i - 1] - reached[i]),
    avg_days: Math.round(dayMap[s.key] || 0),
  }));
  const won = deals.filter((d) => d.status === 'won');
  const lost = deals.filter((d) => d.status === 'lost');
  const open = deals.filter((d) => d.status === 'open');
  const stuck = db.prepare(`SELECT id, deal_no, client_name, stage, value, CAST(julianday('now')-julianday(stage_updated_at) AS INTEGER) AS days_in_stage
     FROM solar_deals WHERE status='open'`).all()
    .filter((r) => r.days_in_stage > (stageMeta(r.stage)?.sla ?? 99))
    .map((r) => ({ ...r, sla: stageMeta(r.stage)?.sla, stage_label: stageMeta(r.stage)?.label }));
  res.json({
    stages: STAGES, byStage,
    totals: {
      open: open.length, won: won.length, lost: lost.length,
      open_value: Math.round(open.reduce((a, d) => a + (d.value || 0), 0)),
      won_value: Math.round(won.reduce((a, d) => a + (d.value || 0), 0)),
      overall_conversion: reached[0] ? Math.round(won.length / reached[0] * 100) : 0,
    },
    stuck,
  });
});

module.exports = router;
