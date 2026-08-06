export const TYPES = [
  { value: 'new_feature', label: 'New Feature' },
  { value: 'enhancement', label: 'Enhancement' },
  { value: 'bug_fix', label: 'Bug Fix' },
  { value: 'ui_improvement', label: 'UI Improvement' },
  { value: 'report_request', label: 'Report Request' },
  { value: 'automation', label: 'Automation' },
  { value: 'performance', label: 'Performance' },
  { value: 'integration', label: 'Integration' },
  { value: 'technical_debt', label: 'Technical Debt' },
  { value: 'refactoring', label: 'Refactoring' },
];

export const STATUSES = [
  { value: 'draft', label: 'Draft' },
  { value: 'submitted', label: 'Waiting' },
  { value: 'under_review', label: 'Business Approval' },
  { value: 'need_clarification', label: 'Need Clarification' },
  { value: 'approved', label: 'Approved' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'planned', label: 'Planned' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'testing', label: 'Testing' },
  { value: 'released', label: 'Released' },
  { value: 'closed', label: 'Closed' },
  { value: 'archived', label: 'Archived' },
  { value: 'reopened', label: 'Reopened' },
];

/** Manual Status dropdown options (Waiting = submitted). Business approval is a tangent. */
export const MANUAL_STATUSES = [
  { value: 'submitted', label: 'Waiting' },
  { value: 'need_clarification', label: 'Need Clarification' },
  { value: 'pending', label: 'Pending' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'testing', label: 'Testing' },
  { value: 'released', label: 'Released' },
  { value: 'closed', label: 'Closed' },
];

export const PRIORITIES = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

export const STATUS_COLORS = {
  draft: 'bg-gray-100 text-gray-600',
  submitted: 'bg-blue-100 text-blue-700',
  under_review: 'bg-amber-100 text-amber-800',
  need_clarification: 'bg-orange-100 text-orange-800',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  planned: 'bg-indigo-100 text-indigo-700',
  assigned: 'bg-violet-100 text-violet-700',
  pending: 'bg-slate-100 text-slate-700',
  in_progress: 'bg-sky-100 text-sky-800',
  in_development: 'bg-sky-100 text-sky-800',
  testing: 'bg-cyan-100 text-cyan-800',
  released: 'bg-green-100 text-green-800',
  closed: 'bg-gray-100 text-gray-500',
  archived: 'bg-gray-100 text-gray-400',
  reopened: 'bg-pink-100 text-pink-700',
};

export const PRIORITY_COLORS = {
  low: 'text-gray-500 bg-gray-50',
  medium: 'text-blue-700 bg-blue-50',
  high: 'text-amber-700 bg-amber-50',
  urgent: 'text-red-700 bg-red-50 font-semibold',
};

export const REPORTS = [
  { key: 'by_status', label: 'By Status' },
  { key: 'by_priority', label: 'By Priority' },
  { key: 'assignee_workload', label: 'Assignee Workload' },
  { key: 'stale', label: 'Stale / Aging' },
  { key: 'cycle_times', label: 'Cycle Times' },
  { key: 'delivery_log', label: 'Delivery Log' },
];

export function labelOf(list, value) {
  return list.find(x => x.value === value)?.label || value || '—';
}

export function prettyAction(action) {
  if (action === 'request_business_approval') return 'Request business approval';
  if (action === 'approve_business') return 'Approve (Business)';
  if (action === 'need_clarification') return 'Need Clarification';
  if (action === 'reject') return 'Reject → IT managers';
  if (action === 'submitted') return 'Submit';
  if (action === 'close') return 'Close';
  return String(action || '').replace(/_/g, ' ');
}

/** Length limits (characters). */
export const DESC_HARD_LIMIT = 2000;
export const COMMENT_HARD_LIMIT = 2000;
/** Development panel notes — frontend only (no server reject). */
export const DEV_NOTES_HARD_LIMIT = 5000;

export const DESC_GUIDANCE = 'Keep it clear and concise — module / department context can go here.';

export function lengthHint(text = '', limit, guidance = null) {
  const n = String(text || '').length;
  if (n >= limit) {
    return {
      tone: 'warn',
      text: `Limit reached (${n.toLocaleString()} / ${limit.toLocaleString()} characters).`,
    };
  }
  if (n > Math.floor(limit * 0.9)) {
    return {
      tone: 'warn',
      text: `Approaching limit (${n.toLocaleString()} / ${limit.toLocaleString()} characters).`,
    };
  }
  if (guidance) {
    return { tone: 'soft', text: `${guidance} (${n.toLocaleString()} / ${limit.toLocaleString()})` };
  }
  return { tone: 'soft', text: `${n.toLocaleString()} / ${limit.toLocaleString()}` };
}

export function descLengthHint(text = '') {
  return lengthHint(text, DESC_HARD_LIMIT, DESC_GUIDANCE);
}

export function commentLengthHint(text = '') {
  return lengthHint(text, COMMENT_HARD_LIMIT);
}

export function clipToLimit(text, limit) {
  const s = String(text ?? '');
  return s.length <= limit ? s : s.slice(0, limit);
}

