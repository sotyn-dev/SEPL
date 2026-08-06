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

/** Working statuses: pending + in_progress (replaces in_development). Keep legacy keys for old rows until migrated. */
const STATUSES = [
  'draft', 'submitted', 'under_review', 'need_clarification', 'approved', 'rejected',
  'planned', 'assigned', 'pending', 'in_progress', 'in_development',
  'testing', 'released', 'closed', 'archived', 'reopened',
];

const STATUS_LABELS = {
  draft: 'Draft',
  submitted: 'Waiting', // IT queue
  under_review: 'Business Approval', // tangent — not free-picked in status dropdown
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
  closed: 'Closed',
  archived: 'Archived',
  reopened: 'Reopened',
};

/** Statuses shown in the manual Status dropdown (Waiting = submitted). under_review is a tangent. */
const MANUAL_STATUSES = [
  'submitted', 'need_clarification', 'pending', 'in_progress',
  'testing', 'released', 'closed',
];

const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

const PRIORITY_LABELS = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  urgent: 'Urgent',
};

const OPEN_STATUSES = STATUSES.filter(s => !['closed', 'archived', 'rejected'].includes(s));
const DONE_STATUSES = ['released', 'closed', 'archived'];
const STALE_DAYS = 14;

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
 * Business approve/reject → Waiting (submitted). under_review is a tangent.
 */
const TRANSITIONS = {
  draft: ['submitted'],
  submitted: ['draft', 'under_review', 'pending', 'closed', 'rejected'],
  under_review: ['need_clarification', 'submitted'],
  need_clarification: ['submitted', 'under_review', 'pending', 'closed'],
  approved: ['pending', 'submitted'],
  rejected: ['submitted', 'closed', 'archived'],
  planned: ['pending', 'assigned'],
  assigned: ['pending'],
  pending: ['in_progress', 'testing', 'under_review', 'submitted'],
  in_progress: ['pending', 'testing', 'under_review'],
  in_development: ['pending', 'in_progress', 'testing', 'under_review'],
  testing: ['in_progress', 'pending', 'released'],
  released: ['closed'],
  closed: ['archived', 'reopened'],
  reopened: ['submitted', 'pending'],
  archived: [],
};

module.exports = {
  TYPES,
  TYPE_LABELS,
  STATUSES,
  STATUS_LABELS,
  MANUAL_STATUSES,
  PRIORITIES,
  PRIORITY_LABELS,
  OPEN_STATUSES,
  DONE_STATUSES,
  STALE_DAYS,
  SETTINGS_KEYS,
  TRANSITIONS,
};
