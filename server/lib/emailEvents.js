// Email-trigger event catalog (mam 2026-06-03: "lots of email with trigger
// and pattern with my selected things, dynamic").
//
// Each event declares:
//   key      — stable identifier fired from server code (fireEmailEvent)
//   label    — human name shown in the Email Triggers UI
//   group    — bucket for the UI ("Indent", "DPR & Site", ...)
//   live     — true when server code actually fires this event today
//   vars     — template variables available in subject/body as {{name}}
//   people   — dynamic recipients resolvable from the event context
//              (each maps to an email the engine pulls out of context)
//   fields   — condition-able fields (for the optional "only if" filter)
//
// Adding a new source later = (1) add an entry here, (2) call
// fireEmailEvent(key, context) from that route with the documented vars +
// *_email people.  The UI and engine pick it up automatically.

const EVENTS = {
  'indent.raised': {
    label: 'Indent raised',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'raised_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.crm_approved': {
    label: 'Indent — CRM approved (Extra item)',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'margin_pct', 'crm_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.l1_approved': {
    label: 'Indent — L1 approved',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'l1_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.approved': {
    label: 'Indent — fully approved',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'approved_by', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'crm_owner_email', label: 'Project CRM owner' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'indent.rejected': {
    label: 'Indent rejected',
    group: 'Indent',
    live: true,
    vars: ['indent_no', 'site', 'category', 'amount', 'rejected_by', 'reason', 'date'],
    people: [
      { key: 'raiser_email', label: 'Indent raiser' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'dpr.loss_streak': {
    label: 'DPR — consecutive loss days',
    group: 'DPR & Site',
    live: true,
    vars: ['site', 'days', 'total_loss', 'date'],
    people: [
      { key: 'director_email', label: 'Director (default recipient)' },
      { key: 'site_engineer_email', label: 'Site engineer' },
    ],
    fields: ['site', 'days'],
  },
};

// Sample values so "Send test" renders a realistic preview without needing
// a live record.
const SAMPLE_CONTEXT = {
  indent_no: 'IND-0123',
  site: 'HERO HOMES',
  category: 'extra_non_schedule',
  amount: '12,500',
  raised_by: 'Raushan Kumar',
  approved_by: 'Nitin Sir',
  l1_by: 'Nitin Jain',
  crm_by: 'Sushila',
  rejected_by: 'Admin',
  reason: 'Budget exceeded',
  margin_pct: '15',
  days: '3',
  total_loss: '45,000',
  date: '2026-06-03',
};

function listEvents() {
  return Object.entries(EVENTS).map(([key, e]) => ({ key, ...e }));
}

module.exports = { EVENTS, SAMPLE_CONTEXT, listEvents };
