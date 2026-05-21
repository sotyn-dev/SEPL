const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
const router = express.Router();
router.use(authMiddleware);

// Is this user an EA / supervisor? Treated as having the can_approve flag on
// the delegations module — mam grants this to whoever's her assistant, and
// they get (a) the "All" tab across every user's tasks and (b) the ability
// to upload proof on anyone's behalf.
const isEA = (uid) => {
  const db = getDb();
  const row = db.prepare(
    `SELECT MAX(rp.can_approve) as allowed
     FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
     WHERE ur.user_id = ? AND rp.module = 'delegations'`
  ).get(uid);
  return !!row?.allowed;
};

// List delegations. By default, a user sees tasks assigned TO them. Admin
// and EA (can_approve on delegations) see everything via scope=all.
// Query params: ?scope=mine|given|all, ?status, ?assignee_id, ?date_from, ?date_to
router.get('/', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  const canSeeAll = isAdmin || isEA(uid);
  const { scope = 'mine', status, assignee_id, date_from, date_to } = req.query;

  const where = [];
  const params = [];
  if (canSeeAll && scope === 'all') {
    // no user filter — admin / EA sees everything
  } else if (scope === 'given') {
    where.push('d.assigned_by = ?'); params.push(uid);
  } else if (scope === 'mine') {
    where.push('d.assigned_to = ?'); params.push(uid);
  } else {
    where.push('(d.assigned_to = ? OR d.assigned_by = ?)'); params.push(uid, uid);
  }
  if (status) { where.push('d.status = ?'); params.push(status); }
  // Name filter — admin/EA filter by assignee_id from the dropdown
  if (assignee_id) { where.push('d.assigned_to = ?'); params.push(+assignee_id); }
  // Date range filters — inclusive on both ends. Uses due_date since that's
  // what mam typically cares about when chasing follow-ups.
  if (date_from) { where.push('d.due_date >= ?'); params.push(date_from); }
  if (date_to) { where.push('d.due_date <= ?'); params.push(date_to); }

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

// Per-person workload dashboard. mam's spec — one row per assignee with:
//   Total Tasks · Active · Completed · Delayed · Avg Delay (days) · WIP Limit · Status
// Status:
//   Overloaded — active_tasks > wip_limit
//   Constraint — >= 25% of tasks delayed OR avg_delay > 5 days
//   OK         — neither
// WIP limit is 5 by default for everyone; can be made per-user later.
router.get('/dashboard', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const WIP_LIMIT_DEFAULT = 5;

  const rows = db.prepare(`
    SELECT u.id, u.name as person, u.role, u.department,
           COUNT(d.id) as total_tasks,
           SUM(CASE WHEN d.status IN ('pending','submitted','rejected') THEN 1 ELSE 0 END) as active_tasks,
           SUM(CASE WHEN d.status = 'approved' THEN 1 ELSE 0 END) as completed,
           SUM(CASE WHEN d.status IN ('pending','submitted')
                     AND d.due_date IS NOT NULL AND d.due_date < ? THEN 1 ELSE 0 END) as delayed_tasks,
           ROUND(AVG(CASE WHEN d.status IN ('pending','submitted')
                           AND d.due_date IS NOT NULL AND d.due_date < ?
                          THEN julianday(?) - julianday(d.due_date) ELSE NULL END), 1) as avg_delay
      FROM users u
      LEFT JOIN delegations d ON d.assigned_to = u.id
     WHERE u.active = 1
     GROUP BY u.id
    HAVING total_tasks > 0
     ORDER BY active_tasks DESC, delayed_tasks DESC, person
  `).all(today, today, today);

  const out = rows.map(r => {
    const wip = WIP_LIMIT_DEFAULT;
    const delayedRatio = r.total_tasks > 0 ? r.delayed_tasks / r.total_tasks : 0;
    let status = 'OK';
    if (r.active_tasks > wip) status = 'Overloaded';
    else if (delayedRatio >= 0.25 || (r.avg_delay || 0) > 5) status = 'Constraint';
    return {
      id: r.id,
      person: r.person,
      role: r.role,
      department: r.department,
      total_tasks: r.total_tasks || 0,
      active_tasks: r.active_tasks || 0,
      completed: r.completed || 0,
      delayed_tasks: r.delayed_tasks || 0,
      avg_delay: r.avg_delay || 0,
      wip_limit: wip,
      status,
    };
  });
  res.json(out);
});

// Create a new delegation. Admin-only — regular users are recipients, not creators.
// Title is derived from the first line of the description (first 80 chars)
// since the UI no longer asks for it separately.
// project_name is optional — free text so admin can tag tasks with a project
// without depending on any master list.
router.post('/', (req, res) => {
  // Allow: legacy admin role OR any user whose role-matrix has
  // delegations.create / can_approve. Mam's MD (Ankur Kaplesh) is on
  // a non-admin role with full delegation perms via the matrix — the
  // old hardcoded `role !== 'admin'` check blocked him from raising
  // tasks even though he's the senior-most user. The matrix is the
  // source of truth now.
  const db = getDb();
  if (req.user.role !== 'admin') {
    const ok = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_create = 1 OR rp.can_approve = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'delegations'
    `).get(req.user.id);
    if (!ok?.ok) return res.status(403).json({ error: 'You need Delegations: Create permission to raise tasks' });
  }
  const { title, description, assigned_to, due_date, project_name, attachment_url } = req.body;
  const desc = String(description || '').trim();
  if (!desc) return res.status(400).json({ error: 'Description is required' });
  if (!assigned_to) return res.status(400).json({ error: 'Assignee is required' });
  const derivedTitle = (title && title.trim()) || desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'Task';
  const project = project_name && String(project_name).trim() ? String(project_name).trim() : null;
  const attachment = attachment_url && String(attachment_url).trim() ? String(attachment_url).trim() : null;

  // Mam (2026-05-21): block duplicate tasks — same description + same
  // assignee + same due-date = same task.  Toast surfaces the existing
  // TSK code so the user can find / extend it instead of re-raising.
  const dup = findDuplicate(db, {
    table: 'delegations',
    fields: { description: desc, assigned_to, due_date: due_date || null },
    codeColumn: 'id', codePrefix: 'TSK-', codePad: 4,
  });
  if (sendDuplicate(res, dup, 'Task')) return;

  const r = db.prepare(
    `INSERT INTO delegations (title, description, assigned_by, assigned_to, due_date, project_name, attachment_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(derivedTitle, desc, req.user.id, assigned_to, due_date || null, project, attachment);
  // Fire-and-forget push to the assignee
  try {
    const { notify } = require('../lib/push');
    notify(assigned_to, {
      title: '📋 New Delegation',
      body: `${req.user.name || 'Admin'} assigned: ${derivedTitle}${due_date ? ` · due ${due_date}` : ''}`,
      url: '/delegations',
      tag: `delegation-${r.lastInsertRowid}`,
    });
  } catch {}
  res.status(201).json({ id: r.lastInsertRowid });
});

// Full edit of an existing task — description, assignee, due date, project,
// attachment. Admin or the original assigner only. Allowed in any status
// (pending / submitted / approved / rejected) so mam can fix typos or
// reassign even after submission. Status / proof / reject_reason are NOT
// touched here — those go through their own endpoints.
router.put('/:id', (req, res) => {
  const db = getDb();
  const d = db.prepare('SELECT assigned_by FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.assigned_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the assigner or an admin can edit this task' });
  }
  const b = req.body || {};
  const desc = b.description != null ? String(b.description).trim() : null;
  if (b.description != null && !desc) return res.status(400).json({ error: 'Description cannot be empty' });
  const assignedTo = b.assigned_to != null ? +b.assigned_to : null;
  const dueDate = b.due_date != null ? (b.due_date || null) : undefined;
  const project = b.project_name != null ? (String(b.project_name).trim() || null) : undefined;
  const attachment = b.attachment_url != null ? (String(b.attachment_url).trim() || null) : undefined;
  const title = desc ? (desc.split(/\r?\n/)[0].slice(0, 80).trim() || 'Task') : null;

  // Build a partial UPDATE — only touch fields the caller actually sent
  const sets = []; const params = [];
  if (desc != null) { sets.push('description=?', 'title=?'); params.push(desc, title); }
  if (assignedTo) { sets.push('assigned_to=?'); params.push(assignedTo); }
  if (dueDate !== undefined) { sets.push('due_date=?'); params.push(dueDate); }
  if (project !== undefined) { sets.push('project_name=?'); params.push(project); }
  if (attachment !== undefined) { sets.push('attachment_url=?'); params.push(attachment); }
  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  params.push(req.params.id);
  db.prepare(`UPDATE delegations SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Task updated' });
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

// Submit proof. Originally assignee-only; now admin and EA can submit on
// behalf of the assignee too — mam asked for this so her EA can upload
// proof for team members who send photos/PDFs over WhatsApp.
router.post('/:id/submit', (req, res) => {
  const { proof_url } = req.body;
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  const canSubmit = d.assigned_to === req.user.id || req.user.role === 'admin' || isEA(req.user.id);
  if (!canSubmit) {
    return res.status(403).json({ error: 'Only the assignee, admin or EA can submit proof' });
  }
  if (!proof_url) return res.status(400).json({ error: 'Proof file is required' });
  db.prepare(
    `UPDATE delegations SET status='submitted', proof_url=?, submitted_at=CURRENT_TIMESTAMP, reject_reason=NULL WHERE id=?`
  ).run(proof_url, req.params.id);
  res.json({ message: 'Proof submitted, awaiting approval' });
});

// Approve / reject — admin-only. Per mam's flow: anyone can upload proof
// (assignee or EA), but only admin checks + approves/rejects the task.
router.post('/:id/approve', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can approve tasks' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
  if (d.status !== 'submitted') return res.status(400).json({ error: 'Task is not awaiting approval' });
  db.prepare(
    `UPDATE delegations SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewer_id=? WHERE id=?`
  ).run(req.user.id, req.params.id);
  res.json({ message: 'Task approved' });
});

router.post('/:id/reject', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only admin can reject tasks' });
  const { reason } = req.body;
  if (!reason || !reason.trim()) return res.status(400).json({ error: 'Rejection reason is required' });
  const db = getDb();
  const d = db.prepare('SELECT * FROM delegations WHERE id=?').get(req.params.id);
  if (!d) return res.status(404).json({ error: 'Task not found' });
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
