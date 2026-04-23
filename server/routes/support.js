const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// GET tickets. Admin sees everything. A non-admin user sees:
//   (a) tickets they raised themselves (user_id)
//   (b) tickets assigned to them (assigned_to) — these show on dashboard too
// Also joins the assignee name so the UI can display "Assigned to Ravi"
router.get('/', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const isAdmin = user?.role === 'admin';
  let sql = `SELECT t.*,
      u.name as user_name,
      r.name as resolved_by_name,
      a.name as assigned_to_name
    FROM support_tickets t
    LEFT JOIN users u ON t.user_id = u.id
    LEFT JOIN users r ON t.resolved_by = r.id
    LEFT JOIN users a ON t.assigned_to = a.id`;
  const params = [];
  if (!isAdmin) {
    sql += ' WHERE t.user_id = ? OR t.assigned_to = ?';
    params.push(req.user.id, req.user.id);
  }
  sql += ' ORDER BY t.created_at DESC';
  res.json(db.prepare(sql).all(...params));
});

// Stats for the "Assigned to me" dashboard widget — count of active tickets
// assigned to the current user.
router.get('/mine', (req, res) => {
  const db = getDb();
  const active = db.prepare(
    "SELECT COUNT(*) as c FROM support_tickets WHERE assigned_to = ? AND status IN ('open','in_progress')"
  ).get(req.user.id);
  const recent = db.prepare(
    `SELECT t.*, u.name as user_name
     FROM support_tickets t
     LEFT JOIN users u ON t.user_id = u.id
     WHERE t.assigned_to = ? AND t.status IN ('open','in_progress')
     ORDER BY
       CASE t.priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END,
       t.created_at DESC
     LIMIT 5`
  ).all(req.user.id);
  res.json({ active: active.c, recent });
});

// GET stats (admin dashboard)
router.get('/stats', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COUNT(*) as c FROM support_tickets').get();
  const open = db.prepare("SELECT COUNT(*) as c FROM support_tickets WHERE status='open'").get();
  const inProgress = db.prepare("SELECT COUNT(*) as c FROM support_tickets WHERE status='in_progress'").get();
  const resolved = db.prepare("SELECT COUNT(*) as c FROM support_tickets WHERE status='resolved'").get();
  const byCategory = db.prepare("SELECT category, COUNT(*) as count FROM support_tickets GROUP BY category").all();
  res.json({ total: total.c, open: open.c, inProgress: inProgress.c, resolved: resolved.c, byCategory });
});

// POST new ticket. `assigned_to` is optional; when set, that user sees the
// ticket on their dashboard + can respond to it.
router.post('/', (req, res) => {
  const { subject, description, category, priority, attachment_link, module, assigned_to } = req.body;
  if (!subject || !description) return res.status(400).json({ error: 'Subject and description required' });
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const ticketNo = nextSequence(db, 'support_tickets', 'ticket_no', 'TK-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    'INSERT INTO support_tickets (ticket_no, user_id, subject, description, category, priority, attachment_link, module, assigned_to) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(ticketNo, req.user.id, subject, description, category || 'bug', priority || 'medium', attachment_link, module, assigned_to ? +assigned_to : null);
  res.status(201).json({ id: r.lastInsertRowid, ticket_no: ticketNo });
});

// PUT update ticket. Admin can change status/priority/response/assignee.
// The assignee (non-admin) can also set 'in_progress' and add a response so
// they can work on the ticket from their dashboard. Only admin can resolve/close.
router.put('/:id', (req, res) => {
  const { status, admin_response, priority, assigned_to } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isAdmin = user?.role === 'admin';
  const isAssignee = ticket.assigned_to === req.user.id;

  if (!isAdmin) {
    if (status === 'resolved' || status === 'closed') return res.status(403).json({ error: 'Only admin can resolve or close a ticket' });
    if (assigned_to !== undefined) return res.status(403).json({ error: 'Only admin can reassign a ticket' });
    if (!isAssignee) return res.status(403).json({ error: 'Only the assignee or admin can update this ticket' });
  }

  const resolvedBy = (status === 'resolved' || status === 'closed') ? req.user.id : null;
  const resolvedAt = (status === 'resolved' || status === 'closed') ? new Date().toISOString() : null;

  db.prepare(
    `UPDATE support_tickets SET
       status = COALESCE(?, status),
       admin_response = COALESCE(?, admin_response),
       priority = COALESCE(?, priority),
       assigned_to = ${isAdmin && assigned_to !== undefined ? '?' : 'assigned_to'},
       resolved_by = ?,
       resolved_at = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    status, admin_response, priority,
    ...(isAdmin && assigned_to !== undefined ? [assigned_to ? +assigned_to : null] : []),
    resolvedBy, resolvedAt, req.params.id
  );
  res.json({ message: 'Updated' });
});

// DELETE (admin only)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  if (user?.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  db.prepare('DELETE FROM support_tickets WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

module.exports = router;
