const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// GET tickets. Admin can see all by default; non-admin only sees tickets
// they raised or were assigned to. Optional ?scope=mine|given|all changes
// the slice:
//   mine  -> assigned_to = current user (default for non-admins on the page)
//   given -> user_id = current user (raised by me)
//   all   -> everything (admin only)
router.get('/', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const isAdmin = user?.role === 'admin';
  const scope = String(req.query.scope || '').toLowerCase();
  const status = req.query.status;
  const where = [];
  const params = [];
  if (scope === 'mine') { where.push('t.assigned_to = ?'); params.push(req.user.id); }
  else if (scope === 'given') { where.push('t.user_id = ?'); params.push(req.user.id); }
  else if (scope === 'all' && !isAdmin) {
    // non-admins can't see everything; fall back to OR of mine+given
    where.push('(t.user_id = ? OR t.assigned_to = ?)'); params.push(req.user.id, req.user.id);
  } else if (!scope && !isAdmin) {
    where.push('(t.user_id = ? OR t.assigned_to = ?)'); params.push(req.user.id, req.user.id);
  }
  if (status) { where.push('t.status = ?'); params.push(status); }

  let sql = `SELECT t.*,
      u.name as user_name,
      r.name as resolved_by_name,
      a.name as assigned_to_name
    FROM support_tickets t
    LEFT JOIN users u ON t.user_id = u.id
    LEFT JOIN users r ON t.resolved_by = r.id
    LEFT JOIN users a ON t.assigned_to = a.id`;
  if (where.length) sql += ' WHERE ' + where.join(' AND ');
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

// PUT update ticket. Permission rules (mam's spec):
//   - Admin     -> can do anything (status, priority, response, assignee)
//   - Raiser    (user_id == current user) -> can resolve/close their own
//                ticket (they decide when their issue is fixed). Cannot
//                reassign — that stays admin-only.
//   - Assignee  (assigned_to == current user) -> can mark in_progress and
//                add a response; CANNOT close (only the raiser/admin can).
router.put('/:id', (req, res) => {
  const { status, admin_response, priority, assigned_to } = req.body;
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isAdmin = user?.role === 'admin';
  const isAssignee = ticket.assigned_to === req.user.id;
  const isRaiser = ticket.user_id === req.user.id;
  const closing = (status === 'resolved' || status === 'closed');

  if (!isAdmin) {
    if (closing && !isRaiser) {
      return res.status(403).json({ error: 'Only the person who raised this ticket (or admin) can close it' });
    }
    if (assigned_to !== undefined) return res.status(403).json({ error: 'Only admin can reassign a ticket' });
    if (!isAssignee && !isRaiser) {
      return res.status(403).json({ error: 'Only the assignee, raiser, or admin can update this ticket' });
    }
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
