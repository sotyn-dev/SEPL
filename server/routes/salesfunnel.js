const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const STAGES = [
  { key: 'new_lead', label: 'New Lead', color: 'blue', who: 'SC' },
  { key: 'qualified', label: 'Qualified', color: 'indigo', who: 'SC' },
  { key: 'meeting_assigned', label: 'Meeting Assigned', color: 'purple', who: 'SC' },
  { key: 'mom_uploaded', label: 'MOM Uploaded', color: 'violet', who: 'ASM' },
  { key: 'drawing_uploaded', label: 'Drawing Uploaded', color: 'amber', who: 'ASM' },
  { key: 'boq_created', label: 'BOQ Created', color: 'orange', who: 'Designer' },
  { key: 'quotation_sent', label: 'Quotation Sent', color: 'cyan', who: 'SC' },
  { key: 'won', label: 'Won', color: 'emerald', who: 'SC' },
  { key: 'lost', label: 'Lost', color: 'red', who: 'SC' },
];

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
  res.json(getDb().prepare(sql).all(...params));
});

// GET stages info
router.get('/stages', (req, res) => res.json(STAGES));

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

// GET single
router.get('/:id', requirePermission('leads', 'view'), (req, res) => {
  const lead = getDb().prepare('SELECT * FROM sales_funnel WHERE id=?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Not found' });
  res.json(lead);
});

// POST create new lead (Stage 1: New Lead) — SC
router.post('/', requirePermission('leads', 'create'), (req, res) => {
  const b = req.body;
  if (!b.client_name) return res.status(400).json({ error: 'Client name required' });
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const leadNo = nextSequence(db, 'sales_funnel', 'lead_no', 'SEPL', { startFrom: 9000, pad: 4 });

  const r = db.prepare(`INSERT INTO sales_funnel (lead_no, client_name, company_name, phone, email, category, address, district, state, source, assigned_sc, assigned_asm, remarks, created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    leadNo, b.client_name, b.company_name, b.phone, b.email, b.category, b.address, b.district, b.state, b.source, b.assigned_sc, b.assigned_asm, b.remarks, req.user.id
  );
  res.status(201).json({ id: r.lastInsertRowid, lead_no: leadNo });
});

// PUT update lead details
router.put('/:id', requirePermission('leads', 'edit'), (req, res) => {
  const b = req.body;
  getDb().prepare(`UPDATE sales_funnel SET client_name=?, company_name=?, phone=?, email=?, category=?, address=?, district=?, state=?, source=?, assigned_sc=?, assigned_asm=?, remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(b.client_name, b.company_name, b.phone, b.email, b.category, b.address, b.district, b.state, b.source, b.assigned_sc, b.assigned_asm, b.remarks, req.params.id);
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
    case 'qualified':
      sql = 'UPDATE sales_funnel SET current_stage=?, is_qualified=1, qualified_by=?, qualified_date=CURRENT_TIMESTAMP, qualified_remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['qualified', b.qualified_by || req.user.name, b.qualified_remarks, req.params.id];
      break;

    case 'not_qualified':
      sql = 'UPDATE sales_funnel SET current_stage=?, is_qualified=0, qualified_by=?, qualified_date=CURRENT_TIMESTAMP, qualified_remarks=?, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['lost', b.qualified_by || req.user.name, b.qualified_remarks || 'Not qualified', req.params.id];
      break;

    case 'meeting_assigned':
      if (!b.meeting_date) return res.status(400).json({ error: 'Meeting date required' });
      sql = 'UPDATE sales_funnel SET current_stage=?, meeting_date=?, meeting_location=?, meeting_assigned_to=?, meeting_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['meeting_assigned', b.meeting_date, b.meeting_location, b.meeting_assigned_to, 'scheduled', req.params.id];
      break;

    case 'mom_uploaded':
      if (!b.mom_notes) return res.status(400).json({ error: 'MOM notes required' });
      sql = 'UPDATE sales_funnel SET current_stage=?, mom_notes=?, mom_file_link=?, mom_filled_by=?, mom_date=CURRENT_TIMESTAMP, meeting_status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['mom_uploaded', b.mom_notes, b.mom_file_link, b.mom_filled_by || req.user.name, 'completed', req.params.id];
      break;

    case 'drawing_uploaded':
      sql = 'UPDATE sales_funnel SET current_stage=?, drawing_file1=?, drawing_file2=?, drawing_file3=?, drawing_uploaded_by=?, drawing_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['drawing_uploaded', b.drawing_file1, b.drawing_file2, b.drawing_file3, b.drawing_uploaded_by || req.user.name, req.params.id];
      break;

    case 'boq_created':
      sql = 'UPDATE sales_funnel SET current_stage=?, boq_file_link=?, boq_created_by=?, boq_amount=?, boq_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['boq_created', b.boq_file_link, b.boq_created_by || req.user.name, b.boq_amount || 0, req.params.id];
      break;

    case 'quotation_sent':
      sql = 'UPDATE sales_funnel SET current_stage=?, quotation_number=?, quotation_file_link=?, quotation_amount=?, quotation_sent_by=?, quotation_sent_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['quotation_sent', b.quotation_number, b.quotation_file_link, b.quotation_amount || 0, b.quotation_sent_by || req.user.name, req.params.id];
      break;

    case 'won':
      sql = 'UPDATE sales_funnel SET current_stage=?, result=?, result_remarks=?, result_date=CURRENT_TIMESTAMP, won_amount=?, updated_at=CURRENT_TIMESTAMP WHERE id=?';
      params = ['won', 'won', b.result_remarks, b.won_amount || 0, req.params.id];
      break;

    case 'lost':
      sql = 'UPDATE sales_funnel SET current_stage=?, result=?, result_remarks=?, result_date=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?';
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
