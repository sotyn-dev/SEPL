const { TRANSITIONS, MANUAL_STATUSES, STATUS_LABELS } = require('./constants');
const {
  isBusinessOwner,
  isItManager,
  isAdminUser,
  canTransition,
  canAssign,
  canToggleWorkStatus,
  canChangeStatus,
} = require('./permissions');
const {
  getTeamSettings,
  isAssignableUser,
  isBusinessOwnerId,
  primaryItManagerId,
  isValidReassignTarget,
  reassignRoleForStatus,
} = require('./access');
const { appendHistory } = require('./history');

function allowedTargets(fromStatus) {
  return TRANSITIONS[fromStatus] || [];
}

function clearApprovals(db, requirementId) {
  db.prepare(`
    UPDATE sysreq_requirements SET
      business_approved_at = NULL,
      business_approved_by = NULL,
      it_approved_at = NULL,
      it_approved_by = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(requirementId);
}

/** Route / return ticket to priority (first) IT manager. */
function assignPrimaryManager(db, requirementId, actorId) {
  const primary = primaryItManagerId(db);
  if (!primary) return null;
  db.prepare(`
    UPDATE sysreq_requirements SET
      assignee_id = ?,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = ?
    WHERE id = ?
  `).run(primary, actorId, requirementId);
  return primary;
}

/**
 * Assign to IT manager or IT team member → Pending.
 * Kept for API back-compat; UI prefers side-by-side assignee + status.
 */
function applyAssign(db, { requirement, user, assigneeId, note }) {
  if (!canAssign(db, user)) {
    const err = new Error('Only IT managers (or admin) can assign tickets');
    err.status = 403;
    throw err;
  }
  const target = Number(assigneeId);
  if (!Number.isFinite(target) || target <= 0) {
    const err = new Error('assignee_id is required');
    err.status = 400;
    throw err;
  }
  if (!isAssignableUser(db, target)) {
    const err = new Error('Assignee must be an IT manager or IT team member (Settings)');
    err.status = 400;
    throw err;
  }

  const from = requirement.status;
  const uid = Number(user.id);
  const blocked = ['released', 'closed', 'archived', 'under_review'];
  if (blocked.includes(from)) {
    const err = new Error(`Cannot assign while status is ${from}`);
    err.status = 400;
    throw err;
  }

  db.prepare(`
    UPDATE sysreq_requirements SET
      assignee_id = ?,
      status = 'pending',
      updated_at = CURRENT_TIMESTAMP,
      updated_by = ?
    WHERE id = ?
  `).run(target, uid, requirement.id);

  appendHistory(db, {
    requirementId: requirement.id,
    eventType: 'assignment_changed',
    actorId: uid,
    fromStatus: from,
    toStatus: 'pending',
    payload: { assignee_id: target, note: note || null },
  });
  if (from !== 'pending') {
    appendHistory(db, {
      requirementId: requirement.id,
      eventType: 'status_changed',
      actorId: uid,
      fromStatus: from,
      toStatus: 'pending',
      payload: { via: 'assign' },
    });
  }

  return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(requirement.id);
}

/** Business approve or reject → back to IT managers (Waiting + primary). */
function returnToItManagers(db, { requirement, user, eventType, note, businessApproved }) {
  const from = requirement.status;
  const uid = Number(user.id);
  const primary = primaryItManagerId(db);

  if (businessApproved) {
    db.prepare(`
      UPDATE sysreq_requirements SET
        business_approved_at = CURRENT_TIMESTAMP,
        business_approved_by = ?,
        status = 'submitted',
        assignee_id = COALESCE(?, assignee_id),
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
      WHERE id = ?
    `).run(uid, primary, uid, requirement.id);
  } else {
    clearApprovals(db, requirement.id);
    db.prepare(`
      UPDATE sysreq_requirements SET
        status = 'submitted',
        assignee_id = COALESCE(?, assignee_id),
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
      WHERE id = ?
    `).run(primary, uid, requirement.id);
  }

  appendHistory(db, {
    requirementId: requirement.id,
    eventType,
    actorId: uid,
    fromStatus: from,
    toStatus: 'submitted',
    payload: {
      note: note || null,
      returned_to_it_managers: true,
      primary_it_manager_id: primary,
      business_rejected: !businessApproved,
    },
  });

  return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(requirement.id);
}

/**
 * Keep status; only swap assignee (inactive recovery). Pool depends on status.
 */
function applyReassign(db, { requirement, user, assigneeId, note }) {
  if (!canAssign(db, user)) {
    const err = new Error('Only IT managers (or admin) can reassign');
    err.status = 403;
    throw err;
  }
  const target = Number(assigneeId);
  if (!Number.isFinite(target) || target <= 0) {
    const err = new Error('assignee_id is required');
    err.status = 400;
    throw err;
  }
  if (!isValidReassignTarget(db, requirement.status, target)) {
    const role = reassignRoleForStatus(requirement.status);
    const err = new Error(
      role === 'business_owner'
        ? 'Pick an active business owner from Settings'
        : role === 'it_manager'
          ? 'Pick an active IT manager from Settings'
          : 'Pick an active IT manager or IT team member from Settings'
    );
    err.status = 400;
    throw err;
  }

  const uid = Number(user.id);
  db.prepare(`
    UPDATE sysreq_requirements SET
      assignee_id = ?,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = ?
    WHERE id = ?
  `).run(target, uid, requirement.id);

  appendHistory(db, {
    requirementId: requirement.id,
    eventType: 'assignment_changed',
    actorId: uid,
    fromStatus: requirement.status,
    toStatus: requirement.status,
    payload: {
      assignee_id: target,
      via: 'reassign',
      role: reassignRoleForStatus(requirement.status),
      note: note || 'Reassigned (previous assignee inactive or unavailable)',
    },
  });

  return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(requirement.id);
}

/**
 * action: 'assign', 'reassign', 'request_business_approval', 'approve_business', 'reject',
 * 'need_clarification', 'close', or plain status (pending / in_progress / …).
 */
function applyTransition(db, { requirement, user, action, note, assigneeId }) {
  const from = requirement.status;
  const uid = Number(user.id);

  if (action === 'assign') {
    return applyAssign(db, { requirement, user, assigneeId, note });
  }

  if (action === 'reassign') {
    return applyReassign(db, { requirement, user, assigneeId, note });
  }

  if (action === 'request_business_approval') {
    if (!isItManager(db, user) && !isAdminUser(user)) {
      const err = new Error('Only IT managers can request business approval');
      err.status = 403;
      throw err;
    }
    const { business_owner_ids } = getTeamSettings(db);
    if (!business_owner_ids.length) {
      const err = new Error('No business owners configured — ask an admin to set them in Settings');
      err.status = 400;
      throw err;
    }
    const target = Number(assigneeId);
    if (!Number.isFinite(target) || target <= 0) {
      const err = new Error('Pick one business owner for approval');
      err.status = 400;
      throw err;
    }
    if (!isBusinessOwnerId(db, target)) {
      const err = new Error('Assignee must be a business owner from Settings');
      err.status = 400;
      throw err;
    }
    clearApprovals(db, requirement.id);
    db.prepare(`
      UPDATE sysreq_requirements SET
        status = 'under_review',
        assignee_id = ?,
        updated_at = CURRENT_TIMESTAMP,
        updated_by = ?
      WHERE id = ?
    `).run(target, uid, requirement.id);
    appendHistory(db, {
      requirementId: requirement.id,
      eventType: 'status_changed',
      actorId: uid,
      fromStatus: from,
      toStatus: 'under_review',
      payload: {
        note: note || 'Requested business approval',
        business_approval: true,
        business_owner_id: target,
      },
    });
    appendHistory(db, {
      requirementId: requirement.id,
      eventType: 'assignment_changed',
      actorId: uid,
      fromStatus: from,
      toStatus: 'under_review',
      payload: { assignee_id: target, via: 'business_approval' },
    });
    return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(requirement.id);
  }

  if (action === 'approve_business') {
    if (!isBusinessOwner(db, user) && !isAdminUser(user)) {
      const err = new Error('Only business owners can approve');
      err.status = 403;
      throw err;
    }
    if (from !== 'under_review') {
      const err = new Error('Business approval only applies while Under Review');
      err.status = 400;
      throw err;
    }
    return returnToItManagers(db, {
      requirement,
      user,
      eventType: 'business_approved',
      note,
      businessApproved: true,
    });
  }

  // Business reject → back to IT managers (rework or close — not terminal)
  if (action === 'reject' && from === 'under_review') {
    if (!isBusinessOwner(db, user) && !isAdminUser(user)) {
      const err = new Error('Only business owners can reject while Under Review');
      err.status = 403;
      throw err;
    }
    return returnToItManagers(db, {
      requirement,
      user,
      eventType: 'approval_rejected',
      note,
      businessApproved: false,
    });
  }

  // IT manager terminal close after triage / post-reject
  if (action === 'close') {
    action = 'closed';
  }

  let toStatus = action;
  if (action === 'reject') toStatus = 'rejected';
  if (action === 'need_clarification') toStatus = 'need_clarification';

  // Status dropdown path — block while under business approval (except business actions above)
  if (from === 'under_review' && toStatus !== 'need_clarification') {
    const err = new Error('Status is locked while waiting for business approval');
    err.status = 400;
    throw err;
  }

  const requesterDraftSubmit = from === 'draft' && toStatus === 'submitted'
    && canTransition(db, user, requirement, toStatus);
  const businessClarify = from === 'under_review' && toStatus === 'need_clarification';
  if (!requesterDraftSubmit && !businessClarify && !canChangeStatus(db, user, requirement)) {
    const err = new Error('You cannot change status on this ticket');
    err.status = 403;
    throw err;
  }

  const isWorkToggle = ['pending', 'in_progress'].includes(toStatus);
  if (isWorkToggle) {
    if (!canToggleWorkStatus(db, user, requirement) && !canTransition(db, user, requirement, toStatus)) {
      const err = new Error('You do not have permission to change work status');
      err.status = 403;
      throw err;
    }
    const allowed = allowedTargets(from).includes(toStatus)
      || (from === 'in_development' && ['pending', 'in_progress'].includes(toStatus));
    if (!allowed) {
      const err = new Error(`Cannot move from ${from} to ${toStatus}`);
      err.status = 400;
      throw err;
    }
  } else {
    if (!canTransition(db, user, requirement, toStatus)) {
      const err = new Error('You do not have permission for this transition');
      err.status = 403;
      throw err;
    }
    if (!allowedTargets(from).includes(toStatus)) {
      const err = new Error(`Cannot move from ${from} to ${toStatus}`);
      err.status = 400;
      throw err;
    }
  }

  if (from === 'under_review' && toStatus === 'need_clarification') {
    if (!isBusinessOwner(db, user) && !isAdminUser(user)) {
      const err = new Error('Only business owners can request clarification');
      err.status = 403;
      throw err;
    }
  }

  const extras = [];
  if (toStatus === 'released' || toStatus === 'closed') {
    extras.push(`completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP)`);
  }
  if (toStatus === 'need_clarification' || toStatus === 'rejected' || toStatus === 'reopened') {
    clearApprovals(db, requirement.id);
  }
  if (toStatus === 'under_review') {
    clearApprovals(db, requirement.id);
  }

  const eventType =
    toStatus === 'rejected' ? 'approval_rejected'
      : toStatus === 'in_progress' ? 'development_started'
        : toStatus === 'pending' ? 'status_changed'
          : toStatus === 'testing' ? 'testing_started'
            : toStatus === 'released' ? 'released'
              : toStatus === 'closed' ? 'closed'
                : toStatus === 'reopened' ? 'reopened'
                  : toStatus === 'need_clarification' ? 'clarification_requested'
                    : 'status_changed';

  db.prepare(`
    UPDATE sysreq_requirements SET
      status = ?,
      updated_at = CURRENT_TIMESTAMP,
      updated_by = ?
      ${extras.length ? ', ' + extras.join(', ') : ''}
    WHERE id = ?
  `).run(toStatus, uid, requirement.id);

  if (toStatus === 'submitted' && from === 'draft') {
    const primary = assignPrimaryManager(db, requirement.id, uid);
    if (primary) {
      appendHistory(db, {
        requirementId: requirement.id,
        eventType: 'assignment_changed',
        actorId: uid,
        fromStatus: from,
        toStatus: 'submitted',
        payload: { assignee_id: primary, via: 'primary_it_manager' },
      });
    }
  }

  // Need Clarification from business → IT owns it again (primary manager)
  if (from === 'under_review' && toStatus === 'need_clarification') {
    const primary = assignPrimaryManager(db, requirement.id, uid);
    if (primary) {
      appendHistory(db, {
        requirementId: requirement.id,
        eventType: 'assignment_changed',
        actorId: uid,
        fromStatus: from,
        toStatus: 'need_clarification',
        payload: { assignee_id: primary, via: 'primary_it_manager', reason: 'need_clarification' },
      });
    }
  }

  appendHistory(db, {
    requirementId: requirement.id,
    eventType,
    actorId: uid,
    fromStatus: from,
    toStatus,
    payload: note ? { note } : null,
  });

  return db.prepare('SELECT * FROM sysreq_requirements WHERE id=?').get(requirement.id);
}

/**
 * Action buttons only for business tangent + request approval.
 * Assignee + Status are side-by-side controls (not buttons).
 */
function nextActionsFor(db, user, requirement) {
  const from = requirement.status;
  const actions = [];
  const it = isItManager(db, user) || isAdminUser(user);
  const biz = isBusinessOwner(db, user) || isAdminUser(user);

  if (from === 'under_review' && biz) {
    actions.push({ action: 'approve_business', label: 'Approve (Business)' });
    actions.push({ action: 'need_clarification', label: 'Need Clarification' });
    actions.push({ action: 'reject', label: 'Reject → IT managers' });
    return actions;
  }

  if (from === 'draft' && canTransition(db, user, requirement, 'submitted')) {
    actions.push({ action: 'submitted', label: 'Submit' });
  }

  if (it && ['submitted', 'need_clarification', 'pending', 'in_progress', 'planned', 'assigned', 'approved', 'reopened', 'in_development'].includes(from)) {
    actions.push({ action: 'request_business_approval', label: 'Request business approval' });
  }

  return actions;
}

/** Options for the Status dropdown (respects transitions + lock). */
function statusOptionsFor(db, user, requirement) {
  const from = requirement.status;
  if (!canChangeStatus(db, user, requirement)) {
    return [{
      value: from,
      label: STATUS_LABELS[from] || from,
      disabled: true,
    }];
  }
  const opts = [];
  const seen = new Set();
  const add = (value) => {
    if (seen.has(value)) return;
    if (!MANUAL_STATUSES.includes(value) && value !== from) return;
    seen.add(value);
    opts.push({ value, label: STATUS_LABELS[value] || value });
  };
  add(from);
  for (const to of allowedTargets(from)) {
    if (to === 'under_review') continue; // tangent via Request business approval
    if (MANUAL_STATUSES.includes(to) && canTransition(db, user, requirement, to)) {
      add(to);
    }
  }
  if (from === 'draft' && canTransition(db, user, requirement, 'submitted')) {
    add('submitted');
  }
  return opts;
}

module.exports = {
  allowedTargets,
  applyTransition,
  applyAssign,
  applyReassign,
  nextActionsFor,
  statusOptionsFor,
  clearApprovals,
  assignPrimaryManager,
  returnToItManagers,
};
