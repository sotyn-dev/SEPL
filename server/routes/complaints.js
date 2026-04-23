const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();

// Public endpoint for client complaint registration (no auth)
router.post('/public', (req, res) => {
  const b = req.body;
  if (!b.client_name || !b.mobile_number || !b.problem_detail) return res.status(400).json({ error: 'Name, mobile, problem required' });
  const db = getDb();

  // Safe migrations
  const newCols = ['client_name TEXT','company_name TEXT','mobile_number TEXT','category TEXT','problem_detail TEXT','customer_type TEXT','complaint_type TEXT','emp_name TEXT','step1_planned_date DATE','step1_actual_date DATE','step1_time_delay INTEGER','step1_assigned_to TEXT','step2_planned_date DATE','step2_actual_date DATE','step2_time_delay INTEGER','step2_assigned_to TEXT','service_report TEXT','updated_at DATETIME'];
  newCols.forEach(col => { try { db.exec(`ALTER TABLE complaints ADD COLUMN ${col}`); } catch(e){} });

  const { nextSequence } = require('../db/nextSequence');
  const cn = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    `INSERT INTO complaints
      (complaint_number, client_name, company_name, mobile_number, category, state,
       problem_detail, customer_type, complaint_type, emp_name, remarks, description, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
    b.problem_detail, b.customer_type, b.complaint_type, b.emp_name, b.remarks || null,
    b.problem_detail, 'open');
  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cn, message: 'Complaint registered. Our team will contact you soon.' });
});

// All routes below require auth
router.use(authMiddleware);

router.get('/', requirePermission('complaints', 'view'), (req, res) => {
  const { status, search, category } = req.query;
  let sql = `SELECT c.*, u.name as assigned_to_name FROM complaints c LEFT JOIN users u ON c.assigned_to=u.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND c.status=?'; params.push(status); }
  if (category) { sql += ' AND c.category=?'; params.push(category); }
  if (search) { sql += ' AND (c.client_name LIKE ? OR c.complaint_number LIKE ? OR c.company_name LIKE ? OR c.mobile_number LIKE ?)'; params.push(`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`); }
  sql += ' ORDER BY c.created_at DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/stats', requirePermission('complaints', 'view'), (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM complaints').get();
  const open = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='open'").get();
  const inProgress = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'").get();
  const resolved = db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='resolved'").get();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM complaints WHERE category IS NOT NULL GROUP BY category").all();
  res.json({ total: total.c, open: open.c, inProgress: inProgress.c, resolved: resolved.c, byCategory });
});

router.get('/:id', requirePermission('complaints', 'view'), (req, res) => {
  const c = getDb().prepare('SELECT * FROM complaints WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Not found' });
  res.json(c);
});

// Admin/CRM create
router.post('/', requirePermission('complaints', 'create'), (req, res) => {
  const b = req.body;
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const cn = nextSequence(db, 'complaints', 'complaint_number', 'CMP-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    `INSERT INTO complaints
      (complaint_number, client_name, company_name, mobile_number, category, state,
       problem_detail, customer_type, complaint_type, emp_name, remarks,
       step1_planned_date, step1_assigned_to, description, status, created_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(cn, b.client_name, b.company_name, b.mobile_number, b.category, b.state || null,
    b.problem_detail, b.customer_type, b.complaint_type, b.emp_name, b.remarks || null,
    b.step1_planned_date, b.step1_assigned_to, b.problem_detail, 'open', req.user.id);
  res.status(201).json({ id: r.lastInsertRowid, complaint_number: cn });
});

// Update (Step 1 / Step 2 progression)
router.put('/:id', requirePermission('complaints', 'edit'), (req, res) => {
  const b = req.body;
  const db = getDb();

  // Calculate time delays
  const calcDelay = (planned, actual) => {
    if (!planned || !actual) return 0;
    const diff = (new Date(actual) - new Date(planned)) / (1000 * 60 * 60 * 24);
    return Math.round(diff);
  };

  const s1Delay = calcDelay(b.step1_planned_date, b.step1_actual_date);
  const s2Delay = calcDelay(b.step2_planned_date, b.step2_actual_date);

  db.prepare(`UPDATE complaints SET
    client_name=COALESCE(?,client_name), company_name=COALESCE(?,company_name), mobile_number=COALESCE(?,mobile_number),
    category=COALESCE(?,category), problem_detail=COALESCE(?,problem_detail), customer_type=COALESCE(?,customer_type),
    complaint_type=COALESCE(?,complaint_type), emp_name=COALESCE(?,emp_name),
    step1_planned_date=COALESCE(?,step1_planned_date), step1_actual_date=COALESCE(?,step1_actual_date), step1_time_delay=?, step1_assigned_to=COALESCE(?,step1_assigned_to),
    step2_planned_date=COALESCE(?,step2_planned_date), step2_actual_date=COALESCE(?,step2_actual_date), step2_time_delay=?, step2_assigned_to=COALESCE(?,step2_assigned_to),
    service_report=COALESCE(?,service_report), status=COALESCE(?,status), priority=COALESCE(?,priority),
    updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
    b.client_name, b.company_name, b.mobile_number, b.category, b.problem_detail, b.customer_type, b.complaint_type, b.emp_name,
    b.step1_planned_date, b.step1_actual_date, s1Delay, b.step1_assigned_to,
    b.step2_planned_date, b.step2_actual_date, s2Delay, b.step2_assigned_to,
    b.service_report, b.status, b.priority, req.params.id
  );
  res.json({ message: 'Updated' });
});

router.delete('/:id', requirePermission('complaints', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM complaints WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
