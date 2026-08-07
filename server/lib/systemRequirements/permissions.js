const { getTeamSettings, assignableIds } = require('./access');

/** Fields a plain requester may edit on an open ticket. */
const REQUESTER_OPEN_FIELDS = new Set(['title', 'description']);

/** All patchable requirement fields (staff). */
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

/** IT manager / IT team / business owner / admin — not a plain requester. */
function isStaffUser(db, user) {
  return isAdminUser(user)
    || isItManager(db, user)
    || isItTeamMember(db, user)
    || isBusinessOwner(db, user);
}

function canEditSettings(_db, user) {
  return isAdminUser(user);
}

function canSoftDelete(db, user) {
  return isAdminUser(user) || isItManager(db, user);
}

function canAssign(db, user) {
  return isAdminUser(user) || isItManager(db, user);
}

/** Assignee side control: Admin / IT manager. Locked during business approval tangent. */
function canChangeAssignee(db, user, reqRow) {
  if (reqRow?.status === 'under_review') return false;
  return canAssign(db, user);
}

/**
 * Status dropdown: Admin / IT manager / IT team.
 * Locked while under business approval tangent.
 */
function canChangeStatus(db, user, reqRow) {
  if (reqRow?.status === 'under_review') return false;
  return isAdminUser(user) || isItManager(db, user) || isItTeamMember(db, user);
}

function canEditRequirement(db, user, reqRow) {
  if (isStaffUser(db, user)) return true;
  const uid = userId(user);
  if (reqRow.requested_by === uid || reqRow.created_by === uid || reqRow.assignee_id === uid) return true;
  return false;
}

function editableFields(db, user, reqRow) {
  if (isStaffUser(db, user)) return [...ALL_EDIT_FIELDS];
  const uid = userId(user);
  if (reqRow.requested_by === uid || reqRow.created_by === uid) {
    return [...REQUESTER_OPEN_FIELDS];
  }
  if (reqRow.assignee_id === uid) return [...ALL_EDIT_FIELDS];
  return [];
}

function canEditField(db, user, reqRow, field) {
  return editableFields(db, user, reqRow).includes(field);
}

/** Manual status toggles assignee / IT manager / admin may perform. */
function canToggleWorkStatus(db, user, reqRow) {
  if (isAdminUser(user) || isItManager(db, user)) return true;
  return reqRow.assignee_id === userId(user);
}

function canTransition(db, user, reqRow, toStatus) {
  if (reqRow.status === 'under_review' && !['need_clarification', 'submitted', 'approved'].includes(toStatus)) {
    // Business tangent: only business actions (handled separately); block free status hops
    if (!(isBusinessOwner(db, user) || isAdminUser(user))) return false;
  }
  if (isAdminUser(user) || isItManager(db, user)) return true;
  const uid = userId(user);

  if (['submitted', 'draft'].includes(toStatus) &&
      (reqRow.requested_by === uid || reqRow.created_by === uid)) {
    return true;
  }

  if (['pending', 'in_progress'].includes(toStatus) && canToggleWorkStatus(db, user, reqRow)) {
    return true;
  }

  if (reqRow.assignee_id === uid &&
      ['testing', 'released', 'done', 'assigned', 'planned', 'pending', 'in_progress'].includes(toStatus)) {
    return true;
  }

  if (isBusinessOwner(db, user) &&
      ['need_clarification', 'submitted', 'approved'].includes(toStatus)) {
    return true;
  }

  if (isItTeamMember(db, user) && assignableIds(db).includes(uid) &&
      ['pending', 'in_progress', 'testing', 'submitted', 'need_clarification', 'released', 'done'].includes(toStatus)) {
    return true;
  }

  return false;
}

const isItApprover = isItManager;
const isBusinessApprover = isBusinessOwner;
const isApprover = (db, user) => isItManager(db, user) || isBusinessOwner(db, user);

module.exports = {
  isAdminUser,
  isItTeamMember,
  isBusinessOwner,
  isItManager,
  isStaffUser,
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
  canTransition,
  REQUESTER_OPEN_FIELDS,
  ALL_EDIT_FIELDS,
};
