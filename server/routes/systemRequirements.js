// System Requirements — REST API
// Open to any authenticated user. Approvers via in-module settings.

const express = require('express');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const { TYPES, PRIORITIES, STATUSES, MANUAL_STATUSES, STATUS_LABELS, DESC_HARD_LIMIT, COMMENT_HARD_LIMIT } = require('../lib/systemRequirements/constants');
const { appendHistory, listHistory } = require('../lib/systemRequirements/history');
const { applyTransition, nextActionsFor, statusOptionsFor } = require('../lib/systemRequirements/statusMachine');
const {
  getTeamSettings,
  saveTeamSettings,
  enrichTeamSettings,
  listAssignableUsers,
  listBusinessOwners,
  listActiveUsers,
  isAssignableUser,
  isBusinessOwnerId,
  primaryItManagerId,
  reassignPool,
  reassignRoleForStatus,
} = require('../lib/systemRequirements/access');
const { ASSIGNEE_INACTIVE_SQL } = require('../lib/systemRequirements/users');
const {
  canEditSettings,
  canSoftDelete,
  canEditRequirement,
  canEditField,
  editableFields,
  canAssign,
  canChangeAssignee,
  canChangeStatus,
  isAdminUser,
  isItManager,
  isItTeamMember,
  isBusinessOwner,
  isStaffUser,
} = require('../lib/systemRequirements/permissions');
const {
  storeFile,
  absolutePathFor,
  softDeleteAttachment,
  isVideoMime,
  MAX_BYTES,
} = require('../lib/systemRequirements/attachments');
const { dashboard, runReport } = require('../lib/systemRequirements/analytics');

const router = express.Router();
router.use(authMiddleware);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES },
});

const IN_TRANSIT_STATUSES = [
  'submitted', 'under_review', 'need_clarification', 'approved',
  'planned', 'assigned', 'pending', 'in_progress', 'in_development', 'testing', 'reopened',
];

function loadReq(db, id) {
  return db.prepare(`
    SELECT r.*,
      req_u.name AS requested_by_name,
      asg.name AS assignee_name,
      CASE
        WHEN r.assignee_id IS NULL THEN NULL
        WHEN asg.id IS NULL THEN 0
        WHEN (asg.active IS NULL OR asg.active = 1) AND COALESCE(asg.archived, 0) = 0 THEN 1
        ELSE 0
      END AS assignee_active,
      biz.name AS business_approver_name,
      it.name AS it_approver_name,
      cu.name AS created_by_name
    FROM sysreq_requirements r
    LEFT JOIN users req_u ON req_u.id = r.requested_by
    LEFT JOIN users asg ON asg.id = r.assignee_id
    LEFT JOIN users biz ON biz.id = r.business_approved_by
    LEFT JOIN users it ON it.id = r.it_approved_by
    LEFT JOIN users cu ON cu.id = r.created_by
    WHERE r.id = ? AND r.soft_deleted_at IS NULL
  `).get(id);
}

function enrichInactiveFlags(db, row) {
  if (!row) return row;
  const inTransit = IN_TRANSIT_STATUSES.includes(row.status);
  const assigneeInactive = inTransit && row.assignee_id != null && Number(row.assignee_active) === 0;
  const bizPool = row.status === 'under_review' ? reassignPool(db, 'under_review') : null;
  const approvalBlocked = row.status === 'under_review' && !(bizPool?.users?.length);
  const needsReassignment = assigneeInactive || approvalBlocked;
  const role = needsReassignment ? reassignRoleForStatus(row.status) : null;
  const pool = needsReassignment ? reassignPool(db, row.status) : { role: null, users: [] };
  return {
    ...row,
    assignee_inactive: !!assigneeInactive,
    approval_pool_empty: !!approvalBlocked,
    needs_reassignment: !!needsReassignment,
    reassign_role: role,
    reassign_users: pool.users || [],
  };
}

function capabilityPayload(db, user, row) {
  return {
    next_actions: nextActionsFor(db, user, row),
    status_options: statusOptionsFor(db, user, row),
    can_edit: canEditRequirement(db, user, row),
    editable_fields: editableFields(db, user, row),
    can_change_assignee: canChangeAssignee(db, user, row),
    can_change_status: canChangeStatus(db, user, row),
    can_delete: canSoftDelete(db, user),
    can_reassign: canAssign(db, user),
    is_staff: isStaffUser(db, user),
  };
}

function nextReqNumber(db) {
  const year = new Date().getFullYear();
  const prefix = `SR-${year}-`;
  const row = db.prepare(`
    SELECT req_number FROM sysreq_requirements
    WHERE req_number LIKE ?
    ORDER BY id DESC LIMIT 1
  `).get(`${prefix}%`);
  let seq = 1;
  if (row?.req_number) {
    const n = parseInt(row.req_number.slice(prefix.length), 10);
    if (Number.isFinite(n)) seq = n + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
}

function touch(db, id, userId) {
  db.prepare(`
    UPDATE sysreq_requirements SET updated_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?
  `).run(userId, id);
}

// ── Settings ───────────────────────────────────────────────────
router.get('/settings', (req, res) => {
  try {
    const db = getDb();
    const settings = enrichTeamSettings(db, getTeamSettings(db));
    res.json({
      ...settings,
      can_edit: canEditSettings(db, req.user),
    });
  } catch (e) {
    console.error('[sysreq] settings get', e);
    res.status(500).json({ error: e.message });
  }
});

router.put('/settings', (req, res) => {
  try {
    const db = getDb();
    if (!canEditSettings(db, req.user)) {
      return res.status(403).json({ error: 'Only admins can edit settings' });
    }
    const body = req.body || {};
    const saved = saveTeamSettings(db, {
      it_manager_ids: body.it_manager_ids ?? body.it_approver_ids,
      it_team_ids: body.it_team_ids || [],
      business_owner_ids: body.business_owner_ids ?? body.business_approver_ids,
    });
    res.json({ ...enrichTeamSettings(db, saved), can_edit: true });
  } catch (e) {
    console.error('[sysreq] settings put', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Dashboard & reports ────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  try {
    res.json(dashboard(getDb(), { userId: req.user.id }));
  } catch (e) {
    console.error('[sysreq] dashboard', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/reports/:key', (req, res) => {
  try {
    const days = req.query.days ? Number(req.query.days) : undefined;
    res.json(runReport(getDb(), req.params.key, { days }));
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[sysreq] report', e);
    res.status(status).json({ error: e.message });
  }
});

router.get('/meta', (req, res) => {
  const db = getDb();
  const settings = enrichTeamSettings(db, getTeamSettings(db));
  res.json({
    types: TYPES,
    priorities: PRIORITIES,
    statuses: STATUSES,
    status_labels: STATUS_LABELS,
    manual_statuses: MANUAL_STATUSES,
    settings,
    assignable_users: listAssignableUsers(db),
    business_owners: listBusinessOwners(db),
    it_team: listAssignableUsers(db),
    me: {
      id: req.user.id,
      is_admin: isAdminUser(req.user),
      is_it_manager: isItManager(db, req.user),
      is_it_team: isItTeamMember(db, req.user),
      is_business_owner: isBusinessOwner(db, req.user),
      is_staff: isStaffUser(db, req.user),
      can_assign: canAssign(db, req.user),
      can_change_assignee: canChangeAssignee(db, req.user, null),
      can_edit_settings: canEditSettings(db, req.user),
      can_delete: canSoftDelete(db, req.user),
    },
  });
});

router.get('/options/business-owners', (req, res) => {
  try {
    res.json({ rows: listBusinessOwners(getDb()) });
  } catch (e) {
    console.error('[sysreq] business-owners', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/options/it-users', (req, res) => {
  try {
    res.json({ rows: listAssignableUsers(getDb()) });
  } catch (e) {
    console.error('[sysreq] it-users', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/options/active-users', (req, res) => {
  try {
    res.json({ rows: listActiveUsers(getDb()) });
  } catch (e) {
    console.error('[sysreq] active-users', e);
    res.status(500).json({ error: e.message });
  }
});

// ── List ───────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const {
      status, type, priority, assignee_id, q,
      overdue, stale, inactive_assignee, hide_done = '1',
      limit = '50', offset = '0',
    } = req.query;

    const where = ['r.soft_deleted_at IS NULL'];
    const params = [];

    if (status) {
      const list = String(status).split(',').filter(Boolean);
      where.push(`r.status IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    } else if (hide_done === '1') {
      where.push(`r.status NOT IN ('closed','archived')`);
    }

    if (type) { where.push('r.type = ?'); params.push(type); }
    if (priority) {
      const list = String(priority).split(',').filter(Boolean);
      where.push(`r.priority IN (${list.map(() => '?').join(',')})`);
      params.push(...list);
    }
    if (assignee_id) { where.push('r.assignee_id = ?'); params.push(Number(assignee_id)); }
    if (overdue === '1') {
      where.push(`r.due_date IS NOT NULL AND r.due_date < date('now') AND r.status NOT IN ('released','closed','archived','rejected')`);
    }
    if (stale === '1') {
      where.push(`r.updated_at < datetime('now', '-14 days') AND r.status NOT IN ('closed','archived','rejected')`);
    }
    if (inactive_assignee === '1') {
      where.push(`r.status IN (${IN_TRANSIT_STATUSES.map(() => '?').join(',')})`);
      params.push(...IN_TRANSIT_STATUSES);
      where.push(`(${ASSIGNEE_INACTIVE_SQL})`);
    }
    if (q) {
      where.push(`(
        r.req_number LIKE ? OR r.title LIKE ? OR IFNULL(r.description,'') LIKE ?
        OR IFNULL(r.release_version,'') LIKE ?
      )`);
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    const lim = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const off = Math.max(parseInt(offset, 10) || 0, 0);

    const sqlWhere = where.join(' AND ');
    const total = db.prepare(`
      SELECT COUNT(*) c FROM sysreq_requirements r
      LEFT JOIN users asg ON asg.id = r.assignee_id
      WHERE ${sqlWhere}
    `).get(...params).c;
    const rows = db.prepare(`
      SELECT r.*, asg.name AS assignee_name, req_u.name AS requested_by_name,
        CASE
          WHEN r.assignee_id IS NULL THEN NULL
          WHEN asg.id IS NULL THEN 0
          WHEN (asg.active IS NULL OR asg.active = 1) AND COALESCE(asg.archived, 0) = 0 THEN 1
          ELSE 0
        END AS assignee_active
      FROM sysreq_requirements r
      LEFT JOIN users asg ON asg.id = r.assignee_id
      LEFT JOIN users req_u ON req_u.id = r.requested_by
      WHERE ${sqlWhere}
      ORDER BY r.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, lim, off);

    const enriched = rows.map(r => {
      const inTransit = IN_TRANSIT_STATUSES.includes(r.status);
      const assigneeInactive = inTransit && r.assignee_id != null && Number(r.assignee_active) === 0;
      return {
        ...r,
        assignee_inactive: !!assigneeInactive,
        reassign_role: assigneeInactive ? reassignRoleForStatus(r.status) : null,
      };
    });

    res.json({ rows: enriched, total, limit: lim, offset: off });
  } catch (e) {
    console.error('[sysreq] list', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Create ─────────────────────────────────────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    if (!b.title || !String(b.title).trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }
    if (b.type && !TYPES.includes(b.type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (b.priority && !PRIORITIES.includes(b.priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }
    if (b.description != null && String(b.description).length > DESC_HARD_LIMIT) {
      return res.status(400).json({ error: `Description max ${DESC_HARD_LIMIT} characters` });
    }

    const reqNumber = nextReqNumber(db);
    const status = b.submit ? 'submitted' : 'draft';
    const uid = req.user.id;
    // Primary rule: submitted tickets land with priority (first) IT manager
    const assigneeId = status === 'submitted' ? primaryItManagerId(db) : null;

    const info = db.prepare(`
      INSERT INTO sysreq_requirements (
        req_number, title, description, type, status, priority,
        requested_by, assignee_id,
        due_date, target_start_date, target_version,
        created_by, updated_by
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      reqNumber,
      String(b.title).trim(),
      b.description || null,
      b.type || 'enhancement',
      status,
      b.priority || 'medium',
      b.requested_by || uid,
      assigneeId,
      b.due_date || null,
      b.target_start_date || null,
      b.target_version || null,
      uid,
      uid,
    );

    const id = info.lastInsertRowid;
    appendHistory(db, {
      requirementId: id,
      eventType: 'created',
      actorId: uid,
      toStatus: status,
      payload: { title: b.title },
    });
    if (status === 'submitted') {
      appendHistory(db, {
        requirementId: id,
        eventType: 'status_changed',
        actorId: uid,
        fromStatus: 'draft',
        toStatus: 'submitted',
      });
      if (assigneeId) {
        appendHistory(db, {
          requirementId: id,
          eventType: 'assignment_changed',
          actorId: uid,
          toStatus: 'submitted',
          payload: { assignee_id: assigneeId, via: 'primary_it_manager' },
        });
      }
    }

    res.status(201).json(loadReq(db, id));
  } catch (e) {
    console.error('[sysreq] create', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Detail ─────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  try {
    const db = getDb();
    const row = loadReq(db, Number(req.params.id));
    if (!row) return res.status(404).json({ error: 'Not found' });

    const comments = db.prepare(`
      SELECT c.*, u.name AS author_name
      FROM sysreq_comments c
      LEFT JOIN users u ON u.id = c.author_id
      WHERE c.requirement_id = ? AND c.soft_deleted_at IS NULL
      ORDER BY c.created_at ASC
    `).all(row.id);

    const attachments = db.prepare(`
      SELECT a.*, u.name AS uploaded_by_name
      FROM sysreq_attachments a
      LEFT JOIN users u ON u.id = a.uploaded_by
      WHERE a.requirement_id = ? AND a.soft_deleted_at IS NULL
      ORDER BY a.created_at DESC
    `).all(row.id);

    const history = listHistory(db, row.id, { limit: 100 });
    const enriched = enrichInactiveFlags(db, row);

    res.json({
      ...enriched,
      comments,
      attachments,
      history,
      ...capabilityPayload(db, req.user, row),
    });
  } catch (e) {
    console.error('[sysreq] get', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canEditRequirement(db, req.user, row)) {
      return res.status(403).json({ error: 'Not allowed to edit' });
    }

    const b = req.body || {};
    const fields = [
      'title', 'description', 'type', 'priority',
      'requested_by', 'assignee_id', 'due_date', 'target_start_date',
      'target_version', 'release_version', 'release_notes',
      'tech_analysis', 'impl_strategy', 'dev_notes',
      'testing_notes', 'completion_summary',
    ];

    const sets = [];
    const params = [];
    const changed = {};

    for (const f of fields) {
      if (b[f] === undefined) continue;

      if (f === 'assignee_id') {
        if (!canChangeAssignee(db, req.user, row)) {
          return res.status(403).json({
            error: row.status === 'under_review'
              ? 'Assignee is locked during business approval'
              : 'Only IT managers (or admin) can change assignee',
          });
        }
      } else if (!canEditField(db, req.user, row, f)) {
        return res.status(403).json({ error: `Not allowed to edit ${f}` });
      }

      if (f === 'type' && b[f] && !TYPES.includes(b[f])) {
        return res.status(400).json({ error: 'Invalid type' });
      }
      if (f === 'priority' && b[f] && !PRIORITIES.includes(b[f])) {
        return res.status(400).json({ error: 'Invalid priority' });
      }
      if (f === 'description' && b[f] != null && String(b[f]).length > DESC_HARD_LIMIT) {
        return res.status(400).json({ error: `Description max ${DESC_HARD_LIMIT} characters` });
      }
      if (f === 'assignee_id' && b[f]) {
        const target = Number(b[f]);
        if (row.status === 'under_review') {
          if (!isBusinessOwnerId(db, target)) {
            return res.status(400).json({ error: 'While under business approval, assignee must be a business owner' });
          }
        } else if (!isAssignableUser(db, target)) {
          return res.status(400).json({ error: 'Assignee must be an IT manager or IT team member (Settings)' });
        }
      }
      if (row[f] !== b[f]) {
        changed[f] = { from: row[f], to: b[f] };
      }
      sets.push(`${f} = ?`);
      params.push(b[f] === '' ? null : b[f]);
    }

    if (!sets.length) {
      const fresh = loadReq(db, id);
      return res.json({ ...enrichInactiveFlags(db, fresh), ...capabilityPayload(db, req.user, fresh) });
    }

    sets.push('updated_at = CURRENT_TIMESTAMP', 'updated_by = ?');
    params.push(req.user.id, id);

    db.prepare(`UPDATE sysreq_requirements SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    if (changed.assignee_id) {
      appendHistory(db, {
        requirementId: id,
        eventType: 'assignment_changed',
        actorId: req.user.id,
        fromStatus: row.status,
        toStatus: row.status,
        payload: { ...changed.assignee_id, via: 'manual_assignee' },
      });
    } else if (Object.keys(changed).length) {
      appendHistory(db, {
        requirementId: id,
        eventType: 'field_updated',
        actorId: req.user.id,
        payload: changed,
      });
    }

    const fresh = loadReq(db, id);
    res.json({ ...enrichInactiveFlags(db, fresh), ...capabilityPayload(db, req.user, fresh) });
  } catch (e) {
    console.error('[sysreq] patch', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/:id/transition', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });

    const action = req.body?.action;
    if (!action) return res.status(400).json({ error: 'action is required' });

    const tx = db.transaction(() => {
      return applyTransition(db, {
        requirement: row,
        user: req.user,
        action,
        note: req.body?.note || null,
        assigneeId: req.body?.assignee_id,
      });
    });

    const updated = tx();
    const full = enrichInactiveFlags(db, loadReq(db, id));
    res.json({
      ...full,
      history: listHistory(db, id, { limit: 100 }),
      ...capabilityPayload(db, req.user, updated),
    });
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[sysreq] transition', e);
    res.status(status).json({ error: e.message });
  }
});

router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canSoftDelete(db, req.user)) {
      return res.status(403).json({ error: 'Not allowed to delete' });
    }
    db.prepare(`
      UPDATE sysreq_requirements SET soft_deleted_at = CURRENT_TIMESTAMP, updated_by = ? WHERE id = ?
    `).run(req.user.id, id);
    appendHistory(db, {
      requirementId: id,
      eventType: 'status_changed',
      actorId: req.user.id,
      fromStatus: row.status,
      toStatus: row.status,
      payload: { soft_deleted: true },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[sysreq] delete', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Comments ───────────────────────────────────────────────────
router.post('/:id/comments', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment body required' });
    if (body.length > COMMENT_HARD_LIMIT) {
      return res.status(400).json({ error: `Comment max ${COMMENT_HARD_LIMIT} characters` });
    }

    const info = db.prepare(`
      INSERT INTO sysreq_comments (requirement_id, parent_id, body, author_id)
      VALUES (?, ?, ?, ?)
    `).run(id, req.body.parent_id || null, body, req.user.id);

    touch(db, id, req.user.id);
    appendHistory(db, {
      requirementId: id,
      eventType: 'comment_added',
      actorId: req.user.id,
      payload: { comment_id: info.lastInsertRowid },
    });

    const comment = db.prepare(`
      SELECT c.*, u.name AS author_name FROM sysreq_comments c
      LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?
    `).get(info.lastInsertRowid);

    res.status(201).json(comment);
  } catch (e) {
    console.error('[sysreq] comment', e);
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id/comments/:commentId', (req, res) => {
  try {
    const db = getDb();
    const reqId = Number(req.params.id);
    const commentId = Number(req.params.commentId);
    if (!loadReq(db, reqId)) return res.status(404).json({ error: 'Not found' });

    const existing = db.prepare(`
      SELECT * FROM sysreq_comments
      WHERE id = ? AND requirement_id = ? AND soft_deleted_at IS NULL
    `).get(commentId, reqId);
    if (!existing) return res.status(404).json({ error: 'Comment not found' });

    const isAuthor = Number(existing.author_id) === Number(req.user.id);
    if (!isAuthor && !isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Only the author or admin can edit this comment' });
    }

    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'Comment body required' });
    if (body.length > COMMENT_HARD_LIMIT) {
      return res.status(400).json({ error: `Comment max ${COMMENT_HARD_LIMIT} characters` });
    }

    db.prepare(`
      UPDATE sysreq_comments SET body = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(body, commentId);

    touch(db, reqId, req.user.id);
    appendHistory(db, {
      requirementId: reqId,
      eventType: 'comment_updated',
      actorId: req.user.id,
      payload: { comment_id: commentId },
    });

    const comment = db.prepare(`
      SELECT c.*, u.name AS author_name FROM sysreq_comments c
      LEFT JOIN users u ON u.id = c.author_id WHERE c.id = ?
    `).get(commentId);

    res.json(comment);
  } catch (e) {
    console.error('[sysreq] comment patch', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/comments/:commentId', (req, res) => {
  try {
    const db = getDb();
    const reqId = Number(req.params.id);
    const commentId = Number(req.params.commentId);
    if (!loadReq(db, reqId)) return res.status(404).json({ error: 'Not found' });

    const existing = db.prepare(`
      SELECT * FROM sysreq_comments
      WHERE id = ? AND requirement_id = ? AND soft_deleted_at IS NULL
    `).get(commentId, reqId);
    if (!existing) return res.status(404).json({ error: 'Comment not found' });

    const isAuthor = Number(existing.author_id) === Number(req.user.id);
    if (!isAuthor && !isAdminUser(req.user)) {
      return res.status(403).json({ error: 'Only the author or admin can delete this comment' });
    }

    db.prepare(`
      UPDATE sysreq_comments SET soft_deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(commentId);

    touch(db, reqId, req.user.id);
    appendHistory(db, {
      requirementId: reqId,
      eventType: 'comment_deleted',
      actorId: req.user.id,
      payload: { comment_id: commentId },
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('[sysreq] comment delete', e);
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id/history', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!loadReq(db, id)) return res.status(404).json({ error: 'Not found' });
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const offset = parseInt(req.query.offset, 10) || 0;
    res.json({ rows: listHistory(db, id, { limit, offset }) });
  } catch (e) {
    console.error('[sysreq] history', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Attachments ────────────────────────────────────────────────
router.post('/:id/attachments', upload.single('file'), (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canEditRequirement(db, req.user, row)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    if (!req.file) return res.status(400).json({ error: 'file required' });
    if (isVideoMime(req.file.mimetype)) {
      return res.status(400).json({ error: 'Video uploads are not supported' });
    }

    const att = storeFile({
      buffer: req.file.buffer,
      originalFilename: req.file.originalname,
      mimeType: req.file.mimetype,
      requirementId: id,
      uploadedBy: req.user.id,
      db,
    });

    touch(db, id, req.user.id);
    appendHistory(db, {
      requirementId: id,
      eventType: 'attachment_uploaded',
      actorId: req.user.id,
      payload: { attachment_id: att.id, filename: att.original_filename },
    });

    res.status(201).json(att);
  } catch (e) {
    const status = e.status || 500;
    if (status === 500) console.error('[sysreq] upload', e);
    res.status(status).json({ error: e.message });
  }
});

router.get('/:id/attachments/:attId/download', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    if (!loadReq(db, id)) return res.status(404).json({ error: 'Not found' });
    const att = db.prepare(`
      SELECT * FROM sysreq_attachments
      WHERE id = ? AND requirement_id = ? AND soft_deleted_at IS NULL
    `).get(Number(req.params.attId), id);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    const abs = absolutePathFor(att);
    res.download(abs, att.original_filename);
  } catch (e) {
    console.error('[sysreq] download', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/:id/attachments/:attId', (req, res) => {
  try {
    const db = getDb();
    const id = Number(req.params.id);
    const row = loadReq(db, id);
    if (!row) return res.status(404).json({ error: 'Not found' });
    if (!canEditRequirement(db, req.user, row)) {
      return res.status(403).json({ error: 'Not allowed' });
    }
    const att = db.prepare(`
      SELECT * FROM sysreq_attachments
      WHERE id = ? AND requirement_id = ? AND soft_deleted_at IS NULL
    `).get(Number(req.params.attId), id);
    if (!att) return res.status(404).json({ error: 'Attachment not found' });

    softDeleteAttachment(db, att.id, req.user.id);
    touch(db, id, req.user.id);
    appendHistory(db, {
      requirementId: id,
      eventType: 'attachment_removed',
      actorId: req.user.id,
      payload: { attachment_id: att.id, filename: att.original_filename },
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('[sysreq] att delete', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
