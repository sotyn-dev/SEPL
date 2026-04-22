const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// List delegations. By default, a user sees tasks assigned TO them and tasks
// they have assigned. Admins see everything. Query params: ?scope=mine|given|all|followup
// and ?status=pending|submitted|approved|rejected.
//
// scope=followup → ALL active tasks across users (not-yet-approved), so an EA
// or supervisor can chase what's pending across the team. Read-only view —
// action buttons still gate on assigner/assignee like every other scope.
router.get('/', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  const { scope = 'mine', status } = req.query;

  const where = [];
  const params = [];
  if (isAdmin && scope === 'all') {
    // no filter
  } else if (scope === 'followup') {
    // Everyone's active (non-approved) tasks, for follow-up purposes.
    where.push("d.status != 'approved'");
  } else if (scope === 'given') {
    where.push('d.assigned_by = ?'); params.push(uid);
  } else if (scope === 'mine') {
    where.push('d.assigned_to = ?'); params.push(uid);
  } else {
    where.push('(d.assigned_to = ? OR d.assigned_by = ?)'); params.push(uid, uid);
  }
  if (status) { where.push('d.status = ?'); params.push(status); }

  const sql = `SELECT d.*,
      au.name as assigned_by_name,
      tu.name as assigned_to_name,
      rv.name as reviewer_name
    FROM delegations d
    LEFT JOIN users au ON au.id = d.assigned_by
    LEFT JOIN users tu ON tu.id = d.assigned_to
    LEFT JOIN users rv ON rv.id = d.reviewer_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE d.status WHEN 'rejected' THEN 0 WHEN 'pending' THEN 1 WHEN 'submitted' THEN 2 ELSE 3 END,
      COALESCE(d.due_date, '9999-12-31') ASC,
      d.created_at DESC`;
  res.json(db.prepare(sql).all(...params));
});

// Create a new delegation. Admin-only — regular users are recipients, not creators.
// Title is derived from the first line of the description (first 80 chars)
// since the UI no longer asks for it separately.
// project_name is optional — free text so admin can tag tasks with a project
// without depending on any master list.
router.post('/', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admins can create tasks' });
  const { title, description, assigned_to, due_date, project_name } = req.body;
  const desc = String(description || '').trim();
  if (!desc) return res.status(400).json({ error: 'Description is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assignee is required' });
  const derivedTitle = (title && title.trim()) || desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'Task';
  const project = project_name && String(project_name).trim() ? String(project_name).trim() : null;
  const db = getDb();
  const r = db.prepare(
    `INSERT INTO delegations (title, description, assigned_by, assigned_to, due_date, project_name)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(derivedTitle, desc, req.user.id, assigned_to, due_date || null, project);
  res.status(201).json({ id: r.lastInsertRowid });
});

// Inline edit of project_name on an existing task. Admin or the assigner only,
// so random users can't retag someone else's tasks. Empty string clears it.
router.patch('/:id/project', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner or an admin can edit the project' });
  }
  const raw = req.body?.project_name;
  const value = raw && String(raw).trim() ? String(raw).trim() : null;
  db.prepare('UPDATE delegations SET project_name=? WHERE id=?').run(value, req.params.id);
  res.json({ message: 'Project updated', project_name: value });
});

// Assignee requests a due-date extension. Admin (not the assigner) approves.
router.post('/:id/request-extension', (req, res) => {
  const { requested_due_date, reason } = req.body;
  if (!requested_due_date) return res.status(400).json({ error: 'New due date is required' });
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Reason is required' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_to !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assignee can request an extension' });
  }
  if (d.status === 'approved') return res.status(400).json({ error: 'Task already approved — no extension needed' });
  db.prepare(
    `UPDATE delegations SET requested_due_date=?, extension_reason=?, extension_status='pending',
       extension_reviewed_at=NULL, extension_reviewed_by=NULL
     WHERE id=?`
  ).run(requested_due_date, reason.trim(), req.params.id);
  res.json({ message: 'Extension requested — admin will review' });
});

// Admin-only: approve the pending extension — updates due_date, clears request.
router.post('/:id/approve-extension', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can approve extensions' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.extension_status !== 'pending' || !d.requested_due_date) {
    return res.status(400).json({ error: 'No pending extension to approve' });
  }
  db.prepare(
    `UPDATE delegations SET due_date = requested_due_date,
       extension_status='approved', extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension approved — due date updated' });
});

// Admin-only: reject the pending extension.
router.post('/:id/reject-extension', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can reject extensions' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.extension_status !== 'pending') return res.status(400).json({ error: 'No pending extension' });
  db.prepare(
    `UPDATE delegations SET extension_status='rejected',
       extension_reviewed_at=CURRENT_TIMESTAMP, extension_reviewed_by=?
     WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Extension rejected' });
});

// Assignee submits proof. Moves status from pending/rejected → submitted.
router.post('/:id/submit', (req, res) => {
  const { proof_url } = req.body;
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_to !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assignee can submit proof' });
  }
  if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
  db.prepare(
    `UPDATE delegations SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`
  ).run(proof_url, req.params.id);
  res.json({ message: 'Proof submitted, awaiting approval' });
});

// Assigner (or admin) approves a submitted task.
router.post('/:id/approve', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner can approve' });
  }
  if (d.status !== 'submitted') return res.status(400).json({ error: 'Task is not awaiting approval' });
  db.prepare(
    `UPDATE delegations SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Task approved' });
});

// Assigner (or admin) rejects with a reason. Task returns to the assignee's
// dashboard as "pending with reject reason" so they can redo and resubmit.
router.post('/:id/reject', (req, res) => {
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner can reject' });
  }
  db.prepare(
    `UPDATE delegations SET status='rejected', reject_reason=?, reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(reason.trim(), req.user.id, req.params.id);
  res.json({ message: 'Task rejected, assignee notified' });
});

// Delete a delegation — only the assigner or an admin.
router.delete('/:id', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner can delete' });
  }
  db.prepare('DELETE FROM delegations WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Dashboard stats for the current user — minimal payload for the homepage widgets.
router.get('/stats', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const pending_mine = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status IN ('pending','rejected')`
  ).get(uid).c;
  const awaiting_approval = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_by=? AND status='submitted'`
  ).get(uid).c;
  const rejected_mine = db.prepare(
    `SELECT COUNT(*) as c FROM delegations WHERE assigned_to=? AND status='rejected'`
  ).get(uid).c;
  res.json({ pending_mine, awaiting_approval, rejected_mine });
});

module.exports = router;
