const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Sales Funnel stages + their SLAs (per mam's spec 2026-04-23).
// `sla_hours` is how long the lead can sit in this stage before it's overdue.
// null means "no fixed SLA" (T-X) — shown as "—" in the UI, no overdue flag.
const STAGES = [
  { key: 'new_lead', label: 'New Lead', color: 'blue', who: 'SC', sla_hours: 1 },
  { key: 'qualified', label: 'First Call Done', color: 'indigo', who: 'Ritti', sla_hours: 4 },
  { key: 'meeting_assigned', label: 'Meeting Scheduled', color: 'purple', who: 'Ritti', sla_hours: null },
  { key: 'mom_uploaded', label: 'MOM + Drawings', color: 'violet', who: 'Ritti', sla_hours: 24 },
  { key: 'drawing_uploaded', label: 'Drawings Uploaded', color: 'amber', who: 'ASM', sla_hours: null },
  { key: 'boq_created', label: 'BOQ Ready', color: 'orange', who: 'Designer', sla_hours: null },
  { key: 'quotation_sent', label: 'Proposal Sent', color: 'cyan', who: 'Estimation Team', sla_hours: 24 * 60 },
  { key: 'won', label: 'Won', color: 'emerald', who: 'ASM', sla_hours: null },
  { key: 'lost', label: 'Lost', color: 'red', who: 'ASM', sla_hours: null },
];

// Helper: add SLA info (due_at, is_overdue, minutes_remaining) to each lead row.
// Called by GET handlers so the client can render "due in 45 min / overdue" chips.
const withSla = (rows) => {
  const now = Date.now();
  return rows.map(r => {
    const stage = STAGES.find(s => s.key === r.current_stage);
    if (!stage || !stage.sla_hours || !r.stage_entered_at) {
      return { ...r, sla_due_at: null, sla_minutes_left: null, sla_overdue: false };
    }
    const enteredMs = new Date(r.stage_entered_at).getTime();
    const dueMs = enteredMs + stage.sla_hours * 3600 * 1000;
    const minutesLeft = Math.round((dueMs - now) / 60000);
    return {
      ...r,
      sla_due_at: new Date(dueMs).toISOString(),
      sla_minutes_left: minutesLeft,
      sla_overdue: minutesLeft < 0,
    };
  });
};

// GET all with filters
router.get('/', requirePermission('leads', 'view'), (req, res) => {
  const { stage, search, assigned_sc, category } = req.query;
  let sql = 'SELECT * FROM sales_funnel WHERE 1=1';
  const params = [];
  if (stage && stage !== 'all') { sql += ' AND current_stage=?'; params.push(stage); }
  if (assigned_sc) { sql += ' AND assigned_sc=?'; params.push(assigned_sc); }
  if (category) { sql += ' AND category LIKE ?'; params.push(`%${category}%`); }
  if (search) {
    sql += ' AND (client_name LIKE ? OR company_name LIKE ? OR lead_no LIKE ? OR phone LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  sql += ' ORDER BY created_at DESC';
  res.json(withSla(getDb().prepare(sql).all(...params)));
});

// GET stages info
router.get('/stages', (req, res) => res.json(STAGES));

// Spec-defined sources / categories / sub-trades.
// MUST be declared before `/:id` so Express doesn't treat 'meta' as a lead id.
const SOURCES = ['Website','Referral','Cold','IPC','GeM','CPPP','State Portal','Repeat'];
const CATEGORIES_SPEC = ['MEPF Project','Solar EPC'];
const SUB_TRADES = ['M','E','P','F','BMS','ELV','Solar'];
router.get('/meta', (req, res) => res.json({
  sources: SOURCES, categories: CATEGORIES_SPEC, sub_trades: SUB_TRADES, stages: STAGES,
}));

// GET pipeline dashboard
router.get('/dashboard', requirePermission('leads', 'view'), (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM sales_funnel').get();
  const bystage = db.prepare('SELECT current_stage, COUNT(*) as count FROM sales_funnel GROUP BY current_stage').all();
  const won = db.prepare("SELECT COUNT(*) as c, COALESCE(SUM(won_amount),0) as amount FROM sales_funnel WHERE current_stage='won'").get();
  const lost = db.prepare("SELECT COUNT(*) as c FROM sales_funnel WHERE current_stage='lost'").get();
  const thisMonth = db.prepare("SELECT COUNT(*) as c FROM sales_funnel WHERE created_at >= date('now','start of month')").get();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM sales_funnel WHERE category IS NOT NULL AND category != '' GROUP BY category").all();
  const bySC = db.prepare("SELECT assigned_sc, COUNT(*) as count FROM sales_funnel WHERE assigned_sc IS NOT NULL AND assigned_sc != '' GROUP BY assigned_sc").all();
  const recent = db.prepare('SELECT * FROM sales_funnel ORDER BY updated_at DESC LIMIT 10').all();
  const today = new Date().toISOString().split('T')[0];
  let todayFollowups = 0, overdueFollowups = 0;
  try {
    todayFollowups = db.prepare("SELECT COUNT(*) as c FROM lead_followups WHERE done=0 AND followup_date=?").get(today)?.c || 0;
    overdueFollowups = db.prepare("SELECT COUNT(*) as c FROM lead_followups WHERE done=0 AND followup_date<?").get(today)?.c || 0;
  } catch(e) {}
  res.json({ total: total.c, byStage: bystage, won, lost, thisMonth: thisMonth.c, byCategory, bySC, recent, stages: STAGES, todayFollowups, overdueFollowups });
});

// GET single (with SLA info)
router.get('/:id', requirePermission('leads', 'view'), (req, res) => {
  const lead = getDb().prepare('SELECT * FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(withSla([lead])[0]);
});

// Stage 1 validation per mam's spec — GST format, estimated value > 0,
// bid deadline > today (Govt only), required fields per kind.
function validateStage1(b, isCreate) {
  const errors = [];
  if (!b.client_name) errors.push('Customer name is required');
  if (!b.project_name && isCreate) errors.push('Project name is required');
  if (b.lead_kind && !['private','government'].includes(b.lead_kind)) errors.push('Invalid lead_kind');
  // GST format: 2-digit state code + 10-char PAN + 1Z + 1 check char
  if (b.gst_number && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(String(b.gst_number).toUpperCase())) {
    errors.push('GST number is invalid');
  }
  if (b.pan_number && !/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(String(b.pan_number).toUpperCase())) {
    errors.push('PAN number is invalid');
  }
  if (b.estimated_value !== undefined && +b.estimated_value < 0) errors.push('Estimated value must be ≥ 0');
  // Government-specific
  if (b.lead_kind === 'government') {
    if (!b.tender_id && isCreate) errors.push('Tender ID is required for Government leads');
    if (b.bid_deadline) {
      const today = new Date(); today.setHours(0,0,0,0);
      const deadline = new Date(b.bid_deadline);
      if (!isNaN(deadline) && deadline < today) errors.push('Bid deadline must be today or later');
    }
  }
  return errors;
}

// Helper: write an audit row — never throws, used everywhere.
function audit(db, lead_id, stage, action, user, opts = {}) {
  try {
    db.prepare(`
      INSERT INTO sales_funnel_audit (lead_id, stage, action, actor_id, actor_name, evidence_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(lead_id, stage || null, action, user?.id || null, user?.name || null, opts.evidence_url || null, opts.notes || null);
  } catch {}
}

// POST create — Stage 1 Lead / Tender Capture. Auto-stamps stage_entered_at
// so the 1-hour SLA for first-call starts ticking. Audit row written.
router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const b = req.body;
  const errors = validateStage1(b, true);
  if (errors.length) return res.status(400).json({ error: errors.join(' · ') });

  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });

  const subTrades = Array.isArray(b.sub_trades_scope) ? b.sub_trades_scope.join(',') : (b.sub_trades_scope || null);
  const leadKind = b.lead_kind === 'government' ? 'government' : 'private';

  const r = db.prepare(`INSERT INTO sales_funnel
    (lead_no, client_name, company_name, phone, email, category, lead_type, lead_kind,
     gst_number, pan_number, project_name, project_location, pin_code,
     estimated_value, tentative_timeline, sub_trades_scope,
     tender_id, bid_deadline, emd_amount, pbg_required,
     city, address, district, state, source, assigned_sc, assigned_asm, remarks, created_by,
     current_stage, stage_entered_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'new_lead', CURRENT_TIMESTAMP)`).run(
    leadNo, b.client_name, b.company_name || null, b.phone || null, b.email || null,
    b.category || null, b.lead_type || null, leadKind,
    b.gst_number ? String(b.gst_number).toUpperCase() : null,
    b.pan_number ? String(b.pan_number).toUpperCase() : null,
    b.project_name || null, b.project_location || null, b.pin_code || null,
    +b.estimated_value || 0, b.tentative_timeline || null, subTrades,
    b.tender_id || null, b.bid_deadline || null, +b.emd_amount || 0, b.pbg_required ? 1 : 0,
    b.city || null, b.address || null, b.district || null, b.state || null,
    b.source || null, b.assigned_sc || null, b.assigned_asm || null, b.remarks || null,
    req.user.id
  );
  audit(db, r.lastInsertRowid, 'new_lead', 'create', req.user, {
    notes: `Captured as ${leadKind === 'government' ? 'Government tender' : 'Private quote'}` + (b.tender_id ? ` · Tender ${b.tender_id}` : '')
  });
  res.status(201).json({ id: r.lastInsertRowid, lead_no: leadNo });
});

// POST drop — close a lead with mandatory reason. Forward-only state
// machine: a dropped lead can be reopened later but every transition
// is audited.
router.post('/:id/drop', requirePermission('leads', 'edit'), (req, res) => {
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) return res.status(400).json({ error: 'Drop reason is required' });
  const db = getDb();
  const cur = db.prepare('SELECT id, current_stage, dropped FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Lead not found' });
  if (cur.dropped) return res.status(400).json({ error: 'Lead is already dropped' });
  db.prepare(`
    UPDATE sales_funnel
       SET dropped=1, drop_reason=?, dropped_at=CURRENT_TIMESTAMP, dropped_by=?,
           current_stage='lost', updated_at=CURRENT_TIMESTAMP
     WHERE id=?
  `).run(String(reason).trim(), req.user.id, req.params.id);
  audit(db, cur.id, cur.current_stage, 'drop', req.user, { notes: reason });
  res.json({ message: 'Lead dropped' });
});

// GET audit log for a lead — read-only timeline for the audit panel.
router.get('/:id/audit', requirePermission('leads', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT a.*, u.name as actor_live_name
      FROM sales_funnel_audit a
      LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.lead_id = ?
     ORDER BY a.at DESC
  `).all(req.params.id);
  res.json(rows);
});

// PUT update — Stage 1 fields editable until lead leaves Stage 1.
// Audit row written for any field change.
router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const b = req.body;
  const errors = validateStage1(b, false);
  if (errors.length) return res.status(400).json({ error: errors.join(' · ') });
  const db = getDb();
  const cur = db.prepare('SELECT current_stage FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Lead not found' });

  const subTrades = Array.isArray(b.sub_trades_scope) ? b.sub_trades_scope.join(',') : (b.sub_trades_scope || null);
  const leadKind = b.lead_kind === 'government' ? 'government' : (b.lead_kind === 'private' ? 'private' : null);

  db.prepare(
    `UPDATE sales_funnel SET
       client_name=?, company_name=?, phone=?, email=?,
       category=?, lead_type=?, lead_kind=COALESCE(?, lead_kind),
       gst_number=?, pan_number=?,
       project_name=?, project_location=?, pin_code=?,
       estimated_value=?, tentative_timeline=?, sub_trades_scope=?,
       tender_id=?, bid_deadline=?, emd_amount=?, pbg_required=?,
       city=?, address=?, district=?, state=?, source=?,
       assigned_sc=?, assigned_asm=?, remarks=?,
       updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(
    b.client_name, b.company_name || null, b.phone || null, b.email || null,
    b.category || null, b.lead_type || null, leadKind,
    b.gst_number ? String(b.gst_number).toUpperCase() : null,
    b.pan_number ? String(b.pan_number).toUpperCase() : null,
    b.project_name || null, b.project_location || null, b.pin_code || null,
    +b.estimated_value || 0, b.tentative_timeline || null, subTrades,
    b.tender_id || null, b.bid_deadline || null, +b.emd_amount || 0, b.pbg_required ? 1 : 0,
    b.city || null, b.address || null, b.district || null, b.state || null,
    b.source || null, b.assigned_sc || null, b.assigned_asm || null, b.remarks || null,
    req.params.id
  );
  audit(db, req.params.id, cur.current_stage, 'edit', req.user, { notes: 'Stage 1 fields updated' });
  res.json({ message: 'Updated' });
});

// POST advance stage — each stage has specific fields
router.post('/:id/stage', requirePermission('leads', 'edit'), (req, res) => {
  const b = req.body;
  const db = getDb();
  const lead = db.prepare('SELECT * FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });

  const { stage } = b;
  let sql = '';
  let params = [];

  switch (stage) {
    // First Call Interested → advances to 'qualified'. Captures the new
    // first_call_status field (interested/not_interested) from mam's spec.
    case 'qualified':
      sql = `UPDATE sales_funnel SET
        current_stage=?, is_qualified=1, qualified_by=?, qualified_date=CURRENT_TIMESTAMP,
        qualified_remarks=?, first_call_status=?, first_call_at=CURRENT_TIMESTAMP,
        first_call_remarks=?, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['qualified', b.qualified_by || req.user.name, b.qualified_remarks,
        b.first_call_status || 'interested', b.first_call_remarks || b.qualified_remarks || null,
        req.params.id];
      break;

    // First Call Not Interested → lead goes to 'lost' immediately.
    case 'not_qualified':
      sql = `UPDATE sales_funnel SET
        current_stage=?, is_qualified=0, qualified_by=?, qualified_date=CURRENT_TIMESTAMP,
        qualified_remarks=?, first_call_status='not_interested', first_call_at=CURRENT_TIMESTAMP,
        first_call_remarks=?, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['lost', b.qualified_by || req.user.name, b.qualified_remarks || 'Not qualified',
        b.first_call_remarks || b.qualified_remarks || null, req.params.id];
      break;

    // Meeting Scheduled — now also captures recording URL + live location.
    // meeting_assigned_to (TEXT name snapshot) + meeting_assigned_to_id
    // (FK to users.id) are stored together so the assignee's dashboard
    // can filter their planned meetings by user_id reliably.
    case 'meeting_assigned':
      if (!b.meeting_date) return res.status(400).json({ error: 'Meeting date required' });
      sql = `UPDATE sales_funnel SET
        current_stage=?, meeting_date=?, meeting_location=?,
        meeting_assigned_to=?, meeting_assigned_to_id=?,
        meeting_status=?, meeting_recording_url=?,
        meeting_location_lat=?, meeting_location_lng=?,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['meeting_assigned', b.meeting_date, b.meeting_location,
        b.meeting_assigned_to || null, b.meeting_assigned_to_id || null,
        'scheduled', b.meeting_recording_url || null,
        b.meeting_location_lat || null, b.meeting_location_lng || null,
        req.params.id];
      break;

    // Face-to-Face outcome — new intermediate step before MOM
    case 'f2f_done':
      sql = `UPDATE sales_funnel SET
        current_stage='meeting_assigned', f2f_status=?, f2f_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = [b.f2f_status || 'done', req.params.id];
      break;

    // Fill MOM — captures all 12 fields from mam's Google-Form layout:
    //   Customer Category (radio) → updates sales_funnel.category
    //   Customer Type (radio)     → updates sales_funnel.lead_type
    //   Meeting Location          → updates sales_funnel.meeting_location
    //   Purpose / Pain Points / Requirements / M.O.M. / Action Planned
    //   Meeting Format / Scheduled By / Time Spent / Timestamp Photo / MOM file
    // Category/Type/Location use COALESCE so existing values aren't wiped when
    // the field engineer leaves them blank on the form.
    case 'mom_uploaded':
      if (!b.mom_notes) return res.status(400).json({ error: 'MOM notes required' });
      sql = `UPDATE sales_funnel SET
        current_stage=?, mom_notes=?, mom_file_link=?, mom_filled_by=?, mom_date=CURRENT_TIMESTAMP,
        meeting_status=?,
        category=COALESCE(?, category),
        lead_type=COALESCE(?, lead_type),
        meeting_location=COALESCE(?, meeting_location),
        meeting_purpose=?, meeting_timestamp_photo_url=?, pain_points=?, requirements=?,
        action_planned=?, meeting_format=?, meeting_scheduled_by=?, meeting_time_spent_min=?,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['mom_uploaded', b.mom_notes, b.mom_file_link, b.mom_filled_by || req.user.name,
        'completed',
        b.category || null,
        b.lead_type || null,
        b.meeting_location || null,
        b.meeting_purpose || null,
        b.meeting_timestamp_photo_url || null,
        b.pain_points || null,
        b.requirements || null,
        b.action_planned || null,
        b.meeting_format || null,
        b.meeting_scheduled_by || null,
        b.meeting_time_spent_min ? +b.meeting_time_spent_min : null,
        req.params.id];
      break;

    case 'drawing_uploaded':
      sql = `UPDATE sales_funnel SET
        current_stage=?, drawing_file1=?, drawing_file2=?, drawing_file3=?, drawing_uploaded_by=?,
        drawing_date=CURRENT_TIMESTAMP, stage_entered_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['drawing_uploaded', b.drawing_file1, b.drawing_file2, b.drawing_file3,
        b.drawing_uploaded_by || req.user.name, req.params.id];
      break;

    // BOQ stage now also captures Revised BOQ if one has been re-worked after
    // client feedback (mam's spec: "BOQ / Revised BOQ" columns side-by-side).
    case 'boq_created':
      sql = `UPDATE sales_funnel SET
        current_stage=?, boq_file_link=?, revised_boq_file_link=?,
        boq_created_by=?, boq_amount=?, boq_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['boq_created', b.boq_file_link, b.revised_boq_file_link || null,
        b.boq_created_by || req.user.name, b.boq_amount || 0, req.params.id];
      break;

    case 'quotation_sent':
      sql = `UPDATE sales_funnel SET
        current_stage=?, quotation_number=?, quotation_file_link=?, quotation_amount=?,
        quotation_sent_by=?, quotation_sent_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['quotation_sent', b.quotation_number, b.quotation_file_link, b.quotation_amount || 0,
        b.quotation_sent_by || req.user.name, req.params.id];
      break;

    case 'won':
      sql = `UPDATE sales_funnel SET
        current_stage=?, result=?, result_remarks=?, result_date=CURRENT_TIMESTAMP,
        won_amount=?, stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['won', 'won', b.result_remarks, b.won_amount || 0, req.params.id];
      break;

    case 'lost':
      sql = `UPDATE sales_funnel SET
        current_stage=?, result=?, result_remarks=?, result_date=CURRENT_TIMESTAMP,
        stage_entered_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`;
      params = ['lost', 'lost', b.result_remarks, req.params.id];
      break;

    default:
      return res.status(400).json({ error: 'Invalid stage' });
  }

  db.prepare(sql).run(...params);
  res.json({ message: `Stage updated to ${stage}` });
});

// ===== FOLLOW-UPS =====

// GET follow-ups for a lead
router.get('/:id/followups', requirePermission('leads', 'view'), (req, res) => {
  res.json(getDb().prepare(`SELECT f.*, u.name as created_by_name, u2.name as done_by_name FROM lead_followups f
    LEFT JOIN users u ON f.created_by=u.id LEFT JOIN users u2 ON f.done_by=u2.id
    WHERE f.lead_id=? ORDER BY f.followup_date DESC`).all(req.params.id));
});

// POST add follow-up
router.post('/:id/followup', requirePermission('leads', 'create'), (req, res) => {
  const { followup_date, followup_time, type, notes, next_followup_date } = req.body;
  if (!followup_date) return res.status(400).json({ error: 'Follow-up date required' });
  const r = getDb().prepare('INSERT INTO lead_followups (lead_id, followup_date, followup_time, type, notes, next_followup_date, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, followup_date, followup_time, type || 'call', notes, next_followup_date, req.user.id);
  res.status(201).json({ id: r.lastInsertRowid });
});

// PUT log follow-up outcome
router.put('/followup/:fid', requirePermission('leads', 'edit'), (req, res) => {
  const { outcome, notes, next_followup_date } = req.body;
  if (!outcome) return res.status(400).json({ error: 'Outcome required' });
  const db = getDb();
  db.prepare('UPDATE lead_followups SET outcome=?, notes=?, done=1, done_by=?, next_followup_date=? WHERE id=?')
    .run(outcome, notes, req.user.id, next_followup_date, req.params.fid);
  // Auto-create next follow-up if set
  if (next_followup_date) {
    const fu = db.prepare('SELECT lead_id FROM lead_followups WHERE id=?').get(req.params.fid);
    if (fu) {
      db.prepare('INSERT INTO lead_followups (lead_id, followup_date, type, notes, created_by) VALUES (?,?,?,?,?)')
        .run(fu.lead_id, next_followup_date, 'call', 'Auto-scheduled from previous follow-up', req.user.id);
    }
  }
  res.json({ message: 'Follow-up logged' });
});

// GET today's pending follow-ups (for dashboard)
router.get('/followups/today', requirePermission('leads', 'view'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const pending = getDb().prepare(`SELECT f.*, sf.lead_no, sf.client_name, sf.company_name, sf.phone, sf.current_stage
    FROM lead_followups f JOIN sales_funnel sf ON f.lead_id=sf.id
    WHERE f.done=0 AND f.followup_date <= ? ORDER BY f.followup_date`).all(today);
  res.json(pending);
});

// GET overdue follow-ups
router.get('/followups/overdue', requirePermission('leads', 'view'), (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const overdue = getDb().prepare(`SELECT f.*, sf.lead_no, sf.client_name, sf.company_name, sf.phone
    FROM lead_followups f JOIN sales_funnel sf ON f.lead_id=sf.id
    WHERE f.done=0 AND f.followup_date < ? ORDER BY f.followup_date`).all(today);
  res.json(overdue);
});

// DELETE
router.delete('/:id', requirePermission('leads', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM sales_funnel WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
