const { getTeamSettings, assignableIds } = require('./access');

/** Fields a plain requester may edit on an open ticket. */
const REQUESTER_OPEN_FIELDS = new Set(['title', 'description']);

/** All patchable requirement fields (tech operators). */
const ALL_EDIT_FIELDS = [
  'title', 'description', 'type', 'priority',
  'requested_by', 'assignee_id', 'due_date', 'target_start_date',
  'target_version', 'release_version', 'release_notes',
  'tech_analysis', 'impl_strategy', 'dev_notes',
  'testing_notes', 'completion_summary',
];

function isAdminUser(user) {
  return user?.role === 'admin';
}

function userId(user) {
  return Number(user?.id);
}

function isItManager(db, user) {
  const { it_manager_ids } = getTeamSettings(db);
  return it_manager_ids.includes(userId(user));
}

function isItTeamMember(db, user) {
  const { it_team_ids } = getTeamSettings(db);
  return it_team_ids.includes(userId(user));
}

function isBusinessOwner(db, user) {
  const { business_owner_ids } = getTeamSettings(db);
  return business_owner_ids.includes(userId(user));
}

/** Admin ∪ IT managers (scrum) ∪ IT team — full board / reports / assign. */
function isTechOperator(db, user) {
  return isAdminUser(user)
    || isItManager(db, user)
    || isItTeamMember(db, user);
}

/**
 * Back-compat alias: "staff" now means tech operator only.
 * Business owners are not staff for edit/list (approve-only when under_review).
 */
function isStaffUser(db, user) {
  return isTechOperator(db, user);
}

function isRaiser(user, reqRow) {
  if (!reqRow) return false;
  const uid = userId(user);
  return reqRow.requested_by === uid || reqRow.created_by === uid;
}

function canEditSettings(_db, user) {
  return isAdminUser(user);
}

function canSoftDelete(db, user) {
  return isAdminUser(user) || isItManager(db, user);
}

/** Assign + due-date edit: admin, IT managers, IT team. */
function canAssign(db, user) {
  return isTechOperator(db, user);
}

/** Assignee side control. Locked during business approval tangent. */
function canChangeAssignee(db, user, reqRow) {
  if (reqRow?.status === 'under_review') return false;
  return canAssign(db, user);
}

/**
 * Status dropdown: tech operators.
 * Locked while under business approval tangent.
 */
function canChangeStatus(db, user, reqRow) {
  if (reqRow?.status === 'under_review') return false;
  return isTechOperator(db, user);
}

function canEditRequirement(db, user, reqRow) {
  if (isTechOperator(db, user)) return true;
  if (isRaiser(user, reqRow)) return true;
  return false;
}

function editableFields(db, user, reqRow) {
  if (isTechOperator(db, user)) return [...ALL_EDIT_FIELDS];
  if (isRaiser(user, reqRow)) return [...REQUESTER_OPEN_FIELDS];
  return [];
}

function canEditField(db, user, reqRow, field) {
  return editableFields(db, user, reqRow).includes(field);
}

/** Work status toggles: tech operators (assignees are from IT pool). */
function canToggleWorkStatus(db, user, _reqRow) {
  return isTechOperator(db, user);
}

/**
 * Reopen rules:
 * - closed / rejected → reopened: IT manager / admin only
 * - released / done → reopened: raiser ∪ IT manager ∪ IT team ∪ admin
 */
function canReopen(db, user, reqRow) {
  const from = reqRow?.status;
  if (from === 'closed' || from === 'rejected') {
    return isAdminUser(user) || isItManager(db, user);
  }
  if (from === 'released' || from === 'done') {
    return isTechOperator(db, user) || isRaiser(user, reqRow);
  }
  return false;
}

function canTransition(db, user, reqRow, toStatus) {
  if (reqRow.status === 'under_review' && !['need_clarification', 'submitted', 'approved'].includes(toStatus)) {
    if (!(isBusinessOwner(db, user) || isAdminUser(user))) return false;
  }
  if (isAdminUser(user) || isItManager(db, user)) return true;
  const uid = userId(user);

  if (toStatus === 'reopened' && canReopen(db, user, reqRow)) {
    return true;
  }

  if (['submitted', 'draft'].includes(toStatus) &&
      (reqRow.requested_by === uid || reqRow.created_by === uid)) {
    return true;
  }

  if (['pending', 'in_progress'].includes(toStatus) && canToggleWorkStatus(db, user, reqRow)) {
    return true;
  }

  if (isTechOperator(db, user) && reqRow.assignee_id === uid &&
      ['testing', 'released', 'done', 'assigned', 'planned', 'pending', 'in_progress'].includes(toStatus)) {
    return true;
  }

  if (isBusinessOwner(db, user) &&
      ['need_clarification', 'submitted', 'approved'].includes(toStatus)) {
    return true;
  }

  if (isItTeamMember(db, user) && assignableIds(db).includes(uid) &&
      ['pending', 'in_progress', 'testing', 'submitted', 'need_clarification', 'released', 'done', 'reopened'].includes(toStatus)) {
    return true;
  }

  return false;
}

const isItApprover = isItManager;
const isBusinessApprover = isBusinessOwner;
const isApprover = (db, user) => isItManager(db, user) || isBusinessOwner(db, user);

module.exports = {
  isAdminUser,
  userId,
  isItTeamMember,
  isBusinessOwner,
  isItManager,
  isTechOperator,
  isStaffUser,
  isRaiser,
  isItApprover,
  isBusinessApprover,
  isApprover,
  canEditSettings,
  canSoftDelete,
  canAssign,
  canChangeAssignee,
  canChangeStatus,
  canEditRequirement,
  editableFields,
  canEditField,
  canToggleWorkStatus,
  canReopen,
  canTransition,
  REQUESTER_OPEN_FIELDS,
  ALL_EDIT_FIELDS,
};
