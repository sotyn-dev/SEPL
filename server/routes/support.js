const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { fireEmailEvent } = require('../lib/emailRules');
const { getEmailConfig } = require('../lib/email');
const stUserEmail = (db, id) => { try { return db.prepare('SELECT email FROM users WHERE id=?').get(id)?.email || null; } catch { return null; } };
const stDirector = () => { try { return getEmailConfig().director; } catch { return null; } };
// Deadline date validation, shared by POST and PUT.
// Returns: null when the field is absent/blank (deadline is optional — every
// legacy ticket has none), the YYYY-MM-DD string when it's a real calendar
// date, or INVALID_DATE so the caller can 400. The calendar round-trip check
// rejects 2026-02-30 and 2025-02-29, which a regex alone would let through.
const INVALID_DATE = Symbol('invalid-date');
function normalizeDeadline(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return INVALID_DATE;
  const [y, m, d] = raw.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) return INVALID_DATE;
  return raw;
}

// Admin OR the help_tickets follow-up role (can_see_all / can_approve) may
// triage any ticket — approve/reject proof, submit on behalf of an
// unassigned ticket. Mirrors the inline canFollowAll checks in GET / PUT.
const ticketFollowAll = (db, userId) => {
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(userId);
  if (user?.role === 'admin') return true;
  const row = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_see_all = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'help_tickets'
  `).get(userId);
  return !!row?.ok;
};
const router = express.Router();
router.use(authMiddleware);

// GET tickets. Admin can see all by default; non-admin only sees tickets
// they raised or were assigned to. Optional ?scope=mine|given|all changes
// the slice:
//   mine  -> assigned_to = current user (default for non-admins on the page)
//   given -> user_id = current user (raised by me)
//   all   -> everything (admin OR users with help_tickets.see_all)
//
// Mam: 'help tickets also permission one PC we need to followup all help
// tickets'. The help_tickets module See All toggle in Roles & Permissions
// lets her give one specific user/role access to every ticket without
// making them full admin.
router.get('/', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const isAdmin = user?.role === 'admin';
  // can_see_all OR can_approve on help_tickets → treated as "follow-up everything"
  const seeAllRow = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_see_all = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'help_tickets'
  `).get(req.user.id);
  const canSeeAll = isAdmin || !!seeAllRow?.ok;
  const scope = String(req.query.scope || '').toLowerCase();
  const status = req.query.status;
  const where = [];
  const params = [];
  if (scope === 'mine') { where.push('t.assigned_to = ?'); params.push(req.user.id); }
  else if (scope === 'given') { where.push('t.user_id = ?'); params.push(req.user.id); }
  else if (scope === 'all' && !canSeeAll) {
    // No See-All permission → fall back to OR of mine+given so the URL
    // can't be used to leak other users' tickets.
    where.push('(t.user_id = ? OR t.assigned_to = ?)'); params.push(req.user.id, req.user.id);
  } else if (!scope && !canSeeAll) {
    where.push('(t.user_id = ? OR t.assigned_to = ?)'); params.push(req.user.id, req.user.id);
  }
  if (status) { where.push('t.status = ?'); params.push(status); }

  let sql = `SELECT t.*,
      u.name as user_name,
      r.name as resolved_by_name,
      a.name as assigned_to_name,
      p.name as proof_submitted_by_name
    FROM support_tickets t
    LEFT JOIN users u ON t.user_id = u.id
    LEFT JOIN users r ON t.resolved_by = r.id
    LEFT JOIN users a ON t.assigned_to = a.id
    LEFT JOIN users p ON t.proof_submitted_by = p.id`;
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

// GET stats (summary cards + admin dashboard)
//
// One GROUP BY instead of the four separate COUNT(*) scans this used to run —
// same numbers, a single pass over the table.
//
// The page shows THREE cards but the workflow has six statuses, so they are
// bucketed. The buckets are exhaustive on purpose: open + processing + closed
// always equals total, so a ticket can never go missing from the summary.
//   open       → open
//   processing → in_progress, submitted (proof awaiting approval), rejected
//                (sent back, still being worked)
//   closed     → resolved, closed
// 'resolved' MUST count as closed: the table's "Close" button sets
// status='resolved', so counting only status='closed' would show 0 for tickets
// the user just closed.
router.get('/stats', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT status, COUNT(*) AS c FROM support_tickets GROUP BY status').all();
  const by = Object.fromEntries(rows.map(r => [r.status || 'open', r.c]));
  const n = (...keys) => keys.reduce((sum, k) => sum + (by[k] || 0), 0);

  const open = n('open');
  const processing = n('in_progress', 'submitted', 'rejected');
  const closed = n('resolved', 'closed');
  const byCategory = db.prepare('SELECT category, COUNT(*) as count FROM support_tickets GROUP BY category').all();

  res.json({
    open,
    processing,
    closed,
    total: rows.reduce((s, r) => s + r.c, 0),
    // Legacy keys kept so nothing that already reads this endpoint breaks.
    inProgress: n('in_progress'),
    resolved: n('resolved'),
    byCategory,
  });
});

// POST new ticket. `assigned_to` is optional; when set, that user sees the
// ticket on their dashboard + can respond to it.
router.post('/', (req, res) => {
  const { subject, description, category, priority, attachment_link, module, assigned_to, deadline_date } = req.body;
  if (!subject || !description) return res.status(400).json({ error: 'Subject and description required' });
  const deadline = normalizeDeadline(deadline_date);
  if (deadline === INVALID_DATE) return res.status(400).json({ error: 'Deadline must be a valid date (YYYY-MM-DD)' });
  const db = getDb();
  const { nextSequence } = require('../db/nextSequence');
  const ticketNo = nextSequence(db, 'support_tickets', 'ticket_no', 'TK-', { startFrom: 1000, pad: 5 });
  const r = db.prepare(
    'INSERT INTO support_tickets (ticket_no, user_id, subject, description, category, priority, attachment_link, module, assigned_to, deadline_date) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(ticketNo, req.user.id, subject, description, category || 'bug', priority || 'medium', attachment_link, module, assigned_to ? +assigned_to : null, deadline);
  // Push to assignee (or every admin if unassigned)
  try {
    const { notify, notifyMany } = require('../lib/push');
    if (assigned_to) {
      notify(+assigned_to, {
        title: `🆘 ${ticketNo} — ${priority || 'medium'} priority`,
        body: subject,
        url: '/help-tickets',
        tag: `ticket-${r.lastInsertRowid}`,
      });
    } else {
      const admins = db.prepare(`SELECT id FROM users WHERE role='admin' AND COALESCE(active,1)=1`).all().map(u => u.id);
      notifyMany(admins, {
        title: `🆘 New unassigned ticket — ${ticketNo}`,
        body: subject,
        url: '/help-tickets',
        tag: `ticket-${r.lastInsertRowid}`,
      });
    }
  } catch {}
  fireEmailEvent('ticket.created', {
    ticket_no: ticketNo,
    subject: subject || '',
    priority: priority || 'medium',
    category: category || 'bug',
    created_by: req.user.name || '',
    date: new Date().toISOString().slice(0, 10),
    creator_email: req.user.email || stUserEmail(db, req.user.id),
    assignee_email: assigned_to ? stUserEmail(db, +assigned_to) : null,
    director_email: stDirector(),
  });
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
  const { status, admin_response, priority, assigned_to, deadline_date } = req.body;
  // Only touch the deadline when the caller actually sent the key, so a
  // status-only update can't wipe an existing date.
  const deadlineSent = deadline_date !== undefined;
  const deadline = deadlineSent ? normalizeDeadline(deadline_date) : null;
  if (deadline === INVALID_DATE) return res.status(400).json({ error: 'Deadline must be a valid date (YYYY-MM-DD)' });
  const db = getDb();
  const user = db.prepare('SELECT role FROM users WHERE id=?').get(req.user.id);
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isAdmin = user?.role === 'admin';
  // Mam's follow-up role: anyone with help_tickets.can_see_all OR
  // can_approve gets the same powers as admin for triage (close /
  // reassign / respond on any ticket).
  const seeAllRow = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_see_all = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'help_tickets'
  `).get(req.user.id);
  const canFollowAll = isAdmin || !!seeAllRow?.ok;
  const isAssignee = ticket.assigned_to === req.user.id;
  const isRaiser = ticket.user_id === req.user.id;
  const closing = (status === 'resolved' || status === 'closed');

  if (!canFollowAll) {
    if (closing && !isRaiser) {
      return res.status(403).json({ error: 'Only the person who raised this ticket (or admin) can close it' });
    }
    if (assigned_to !== undefined) return res.status(403).json({ error: 'Only admin / follow-up role can reassign a ticket' });
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
       assigned_to = ${canFollowAll && assigned_to !== undefined ? '?' : 'assigned_to'},
       deadline_date = ${deadlineSent ? '?' : 'deadline_date'},
       resolved_by = ?,
       resolved_at = ?,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(
    status, admin_response, priority,
    ...(canFollowAll && assigned_to !== undefined ? [assigned_to ? +assigned_to : null] : []),
    ...(deadlineSent ? [deadline] : []),
    resolvedBy, resolvedAt, req.params.id
  );
  if (closing) {
    fireEmailEvent('ticket.resolved', {
      ticket_no: ticket.ticket_no,
      subject: ticket.subject || '',
      resolved_by: req.user.name || '',
      date: new Date().toISOString().slice(0, 10),
      creator_email: stUserEmail(db, ticket.user_id),
      assignee_email: stUserEmail(db, ticket.assigned_to),
      director_email: stDirector(),
    });
  }
  res.json({ message: 'Updated' });
});

// ── Delegation-style proof flow ───────────────────────────────────────
// The assignee uploads proof of the fix (photo / PDF / Excel) → ticket goes
// 'submitted' → the raiser (issue owner) / admin / follow-up role approves
// (→ resolved) or rejects (→ in_progress with a reason). Admin's direct
// resolve/close in PUT above still works as an override.

// Submit proof. Assignee, or admin / follow-up role (the latter two can
// submit on behalf of the assignee, e.g. an unassigned ticket they handle).
router.post('/:id/submit-proof', (req, res) => {
  const { proof_url, proof_notes } = req.body;
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isAssignee = ticket.assigned_to === req.user.id;
  if (!isAssignee && !ticketFollowAll(db, req.user.id)) {
    return res.status(403).json({ error: 'Only the assignee or an admin / follow-up role can submit proof' });
  }
  if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
  db.prepare(
    `UPDATE support_tickets SET
       status = 'submitted', proof_url = ?, proof_notes = ?,
       proof_submitted_at = CURRENT_TIMESTAMP, proof_submitted_by = ?,
       reject_reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`
  ).run(proof_url, proof_notes || null, req.user.id, req.params.id);
  // Nudge the raiser that proof is awaiting their approval.
  try {
    const { notify } = require('../lib/push');
    if (ticket.user_id) notify(ticket.user_id, {
      title: `✅ Proof submitted — ${ticket.ticket_no}`,
      body: ticket.subject,
      url: '/help-tickets',
      tag: `ticket-${ticket.id}`,
    });
  } catch {}
  res.json({ message: 'Proof submitted, awaiting approval' });
});

// Approve the submitted proof — raiser, admin, or follow-up role. Resolves.
router.post('/:id/approve', (req, res) => {
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isRaiser = ticket.user_id === req.user.id;
  if (!isRaiser && !ticketFollowAll(db, req.user.id)) {
    return res.status(403).json({ error: 'Only the person who raised this ticket (or admin / follow-up role) can approve' });
  }
  if (ticket.status !== 'submitted') return res.status(400).json({ error: 'Ticket is not awaiting approval' });
  db.prepare(
    `UPDATE support_tickets SET status = 'resolved', resolved_by = ?, resolved_at = CURRENT_TIMESTAMP,
       reject_reason = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(req.user.id, req.params.id);
  fireEmailEvent('ticket.resolved', {
    ticket_no: ticket.ticket_no,
    subject: ticket.subject || '',
    resolved_by: req.user.name || '',
    date: new Date().toISOString().slice(0, 10),
    creator_email: stUserEmail(db, ticket.user_id),
    assignee_email: stUserEmail(db, ticket.assigned_to),
    director_email: stDirector(),
  });
  try {
    const { notify } = require('../lib/push');
    if (ticket.assigned_to) notify(ticket.assigned_to, {
      title: `✔️ Proof approved — ${ticket.ticket_no}`,
      body: ticket.subject,
      url: '/help-tickets',
      tag: `ticket-${ticket.id}`,
    });
  } catch {}
  res.json({ message: 'Proof approved, ticket resolved' });
});

// Reject the submitted proof (reason required) — raiser, admin, or follow-up
// role. Moves the ticket to 'rejected' (mirrors delegations) so the assignee
// sees the reason and re-uploads; the upload block re-appears for 'rejected'.
router.post('/:id/reject', (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDb();
  const ticket = db.prepare('SELECT * FROM support_tickets WHERE id=?').get(req.params.id);
  if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
  const isRaiser = ticket.user_id === req.user.id;
  if (!isRaiser && !ticketFollowAll(db, req.user.id)) {
    return res.status(403).json({ error: 'Only the person who raised this ticket (or admin / follow-up role) can reject' });
  }
  db.prepare(
    `UPDATE support_tickets SET status = 'rejected', reject_reason = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`
  ).run(reason.trim(), req.params.id);
  try {
    const { notify } = require('../lib/push');
    if (ticket.assigned_to) notify(ticket.assigned_to, {
      title: `❌ Proof rejected — ${ticket.ticket_no}`,
      body: reason.trim().slice(0, 120),
      url: '/help-tickets',
      tag: `ticket-${ticket.id}`,
    });
  } catch {}
  res.json({ message: 'Proof rejected, assignee notified' });
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
