const TYPES = [
  'new_feature', 'enhancement', 'bug_fix', 'ui_improvement', 'report_request',
  'automation', 'performance', 'integration', 'technical_debt', 'refactoring',
];

const TYPE_LABELS = {
  new_feature: 'New Feature',
  enhancement: 'Enhancement',
  bug_fix: 'Bug Fix',
  ui_improvement: 'UI Improvement',
  report_request: 'Report Request',
  automation: 'Automation',
  performance: 'Performance',
  integration: 'Integration',
  technical_debt: 'Technical Debt',
  refactoring: 'Refactoring',
};

/**
 * Full catalog (includes legacy keys for old rows).
 * Operator-facing set: see MANUAL_STATUSES + under_review tangent.
 */
const STATUSES = [
  'draft', 'submitted', 'under_review', 'need_clarification', 'approved', 'rejected',
  'planned', 'assigned', 'pending', 'in_progress', 'in_development',
  'testing', 'released', 'done', 'closed', 'archived', 'reopened',
];

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Waiting / Backlog',
  under_review: 'Business Approval',
  need_clarification: 'Need Clarification',
  approved: 'Approved',
  rejected: 'Rejected',
  planned: 'Planned',
  assigned: 'Assigned',
  pending: 'Pending',
  in_progress: 'In Progress',
  in_development: 'In Development', // legacy
  testing: 'Testing',
  released: 'Released',
  done: 'Done',
  closed: 'Closed', // early IT kill — not post-release
  archived: 'Archived',
  reopened: 'Reopened',
};

/**
 * Manual Status dropdown (Waiting / Backlog = submitted).
 * under_review is a tangent via Request business approval.
 */
const MANUAL_STATUSES = [
  'submitted', 'need_clarification', 'pending', 'in_progress',
  'testing', 'released', 'done', 'closed', 'reopened', 'rejected',
];

/** List-view status filter (lean). */
const FILTER_STATUSES = [
  'submitted', 'under_review', 'need_clarification', 'pending', 'in_progress',
  'testing', 'released', 'done', 'closed', 'reopened', 'rejected',
];

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

/** Still “on the board” for workload / open counts. */
const OPEN_STATUSES = STATUSES.filter(s =>
  !['done', 'closed', 'archived', 'rejected'].includes(s)
);

/** Finished / off the default board (`hide_done`). */
const DONE_STATUSES = ['done', 'closed', 'archived', 'rejected'];
const STALE_DAYS = 14;

/** Hard character limits (description + discussion comments). Dev notes are FE-only. */
const DESC_HARD_LIMIT = 2000;
const COMMENT_HARD_LIMIT = 2000;

/** Comment source: user chat vs business tangent auto-posts. */
const COMMENT_SOURCES = {
  user: 'user',
  businessReject: 'business_reject',
  businessClarify: 'business_clarify',
};

/** Single Development-tab attachment bucket. */
const DEV_SECTION = 'development';

const SETTINGS_KEYS = {
  itManagers: 'sysreq_it_manager_ids',
  itTeam: 'sysreq_it_team_ids',
  businessOwners: 'sysreq_business_owner_ids',
  // legacy keys still read for one-release migration
  itApproversLegacy: 'sysreq_it_approver_ids',
  businessApproversLegacy: 'sysreq_business_approver_ids',
};

/**
 * Allowed next statuses from a given status.
 * Business approve/reject → Waiting / Backlog (submitted). under_review is a tangent.
 * Closed = early kill. Done = post-release success. Reopen from finished states.
 */
const TRANSITIONS = {
  draft: ['submitted'],
  submitted: ['under_review', 'pending', 'closed', 'rejected'],
  under_review: ['need_clarification', 'submitted'],
  need_clarification: ['submitted', 'under_review', 'pending', 'closed'],
  approved: ['pending', 'submitted'], // legacy
  rejected: ['reopened', 'submitted', 'archived'],
  planned: ['pending', 'assigned'], // legacy
  assigned: ['pending'], // legacy
  pending: ['in_progress', 'testing', 'under_review', 'submitted', 'closed'],
  in_progress: ['pending', 'testing', 'under_review'],
  in_development: ['pending', 'in_progress', 'testing', 'under_review'], // legacy
  testing: ['in_progress', 'pending', 'released'],
  released: ['done', 'reopened'],
  done: ['reopened'],
  closed: ['reopened', 'archived'],
  reopened: ['pending', 'in_progress', 'submitted'],
  archived: [],
};

module.exports = {
  TYPES,
  TYPE_LABELS,
  STATUSES,
  STATUS_LABELS,
  MANUAL_STATUSES,
  FILTER_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  OPEN_STATUSES,
  DONE_STATUSES,
  STALE_DAYS,
  DESC_HARD_LIMIT,
  COMMENT_HARD_LIMIT,
  COMMENT_SOURCES,
  DEV_SECTION,
  SETTINGS_KEYS,
  TRANSITIONS,
};
