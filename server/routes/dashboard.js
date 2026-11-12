const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { getActiveProjectMetric, listActiveProjects } = require('../lib/activeProjects');
const router = express.Router();
router.use(authMiddleware);

router.get('/active-projects', (req, res) => {
  const db = getDb();
  // Aggregate access matches existing dashboard statistics; names are admin-only.
  if (req.query.details === '1' && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required for project details' });
  }
  res.set('Cache-Control', 'no-store');
  res.json(db.transaction(() => ({
    ...getActiveProjectMetric(db),
    ...(req.query.details === '1' ? { projects: listActiveProjects(db) } : {}),
  }))());
});


// TK-01554: Executive Action & Approval Center for MD Sir & Management
// Pulls all pending items requiring executive sign-off:
// 1. Delegated tasks where assignee uploaded completion proof
// 2. Deadline extension requests on delegated tasks
// 3. Help tickets where assignee submitted resolution proof
router.get('/executive-approvals', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const isAdmin = req.user.role === 'admin';
  const isMD = isAdmin || String(req.user.email || '').toLowerCase() === 'director@securedengineers.com';

  try {
    // 1. Delegated tasks awaiting proof review
    let delegSql = `
      SELECT 
        d.id,
        d.title,
        d.description,
        d.assigned_by,
        d.assigned_to,
        d.due_date,
        d.status,
        d.proof_url,
        d.proof_remarks,
        d.submitted_at,
        d.project_name,
        d.attachment_url,
        u_to.name as assigned_to_name,
        u_by.name as assigned_by_name,
        ROUND((julianday('now') - julianday(COALESCE(d.submitted_at, 'now'))) * 24, 1) as hours_waiting
      FROM delegations d
      LEFT JOIN users u_to ON u_to.id = d.assigned_to
      LEFT JOIN users u_by ON u_by.id = d.assigned_by
      WHERE d.status = 'submitted'
    `;
    const delegParams = [];
    if (!isMD) {
      delegSql += ' AND d.assigned_by = ?';
      delegParams.push(uid);
    }
    delegSql += ' ORDER BY d.submitted_at ASC';
    const delegations = db.prepare(delegSql).all(...delegParams);

    // 2. Deadline extension requests on delegated tasks
    let extSql = `
      SELECT 
        d.id,
        d.title,
        d.assigned_to,
        d.due_date,
        d.requested_due_date,
        d.extension_reason,
        d.extension_count,
        u_to.name as assigned_to_name,
        u_by.name as assigned_by_name
      FROM delegations d
      LEFT JOIN users u_to ON u_to.id = d.assigned_to
      LEFT JOIN users u_by ON u_by.id = d.assigned_by
      WHERE d.extension_status = 'pending'
    `;
    const extParams = [];
    if (!isMD) {
      extSql += ' AND d.assigned_by = ?';
      extParams.push(uid);
    }
    extSql += ' ORDER BY d.id DESC';
    const extensions = db.prepare(extSql).all(...extParams);

    // 3. Help tickets with submitted proof awaiting review / resolution
    let ticketsSql = `
      SELECT 
        t.id,
        t.ticket_no,
        t.subject,
        t.description,
        t.category,
        t.priority,
        t.status,
        t.proof_url,
        t.proof_notes,
        t.proof_submitted_at,
        t.deadline_date,
        t.module,
        u_to.name as assigned_to_name,
        u_by.name as user_name,
        ROUND((julianday('now') - julianday(COALESCE(t.proof_submitted_at, 'now'))) * 24, 1) as hours_waiting
      FROM support_tickets t
      LEFT JOIN users u_to ON u_to.id = t.assigned_to
      LEFT JOIN users u_by ON u_by.id = t.user_id
      WHERE t.status = 'submitted'
    `;
    const ticketsParams = [];
    if (!isMD) {
      ticketsSql += ' AND (t.user_id = ? OR t.assigned_to = ?)';
      ticketsParams.push(uid, uid);
    }
    ticketsSql += ' ORDER BY t.proof_submitted_at ASC';
    const tickets = db.prepare(ticketsSql).all(...ticketsParams);

    const totalCount = delegations.length + extensions.length + tickets.length;

    res.json({
      totalCount,
      delegationsCount: delegations.length,
      extensionsCount: extensions.length,
      ticketsCount: tickets.length,
      delegations,
      extensions,
      tickets
    });
  } catch (err) {
    console.error('[DashboardExecutiveApprovals] Error:', err.message);
    res.status(500).json({ error: 'Failed to fetch executive approvals' });
  }
});

router.get('/', (req, res) => {
  const db = getDb();
  const stats = {
    activeProjects: getActiveProjectMetric(db),
    leads: {
      total: db.prepare('SELECT COUNT(*) as c FROM leads').get().c,
      new: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='new'").get().c,
      qualified: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='qualified'").get().c,
      won: db.prepare("SELECT COUNT(*) as c FROM leads WHERE status='won'").get().c,
    },
    orders: {
      total: db.prepare('SELECT COUNT(*) as c FROM purchase_orders').get().c,
      totalValue: db.prepare('SELECT COALESCE(SUM(total_amount),0) as s FROM purchase_orders').get().s,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM purchase_orders WHERE status='in_progress'").get().c,
    },
    installations: {
      total: db.prepare('SELECT COUNT(*) as c FROM installations').get().c,
      pending: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='pending'").get().c,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='in_progress'").get().c,
      completed: db.prepare("SELECT COUNT(*) as c FROM installations WHERE status='completed'").get().c,
    },
    complaints: {
      open: db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='open'").get().c,
      inProgress: db.prepare("SELECT COUNT(*) as c FROM complaints WHERE status='in_progress'").get().c,
    },
    hr: {
      employees: db.prepare("SELECT COUNT(*) as c FROM employees WHERE status='active'").get().c,
      candidates: db.prepare('SELECT COUNT(*) as c FROM candidates').get().c,
      subContractors: db.prepare("SELECT COUNT(*) as c FROM sub_contractors WHERE status='active'").get().c,
    },
    expenses: {
      pending: db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='pending'").get().s,
      approved: db.prepare("SELECT COALESCE(SUM(amount),0) as s FROM expenses WHERE status='approved'").get().s,
    },
    recentLeads: db.prepare('SELECT id, company_name, status, created_at FROM leads ORDER BY created_at DESC LIMIT 5').all(),
    recentOrders: db.prepare('SELECT id, po_number, total_amount, status FROM purchase_orders ORDER BY created_at DESC LIMIT 5').all(),
    recentComplaints: db.prepare('SELECT id, complaint_number, description, status, priority FROM complaints ORDER BY created_at DESC LIMIT 5').all(),
  };
  res.json(stats);
});

module.exports = router;
