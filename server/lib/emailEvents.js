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

  // ─── Payments & Bills ───────────────────────────────────────────────
  'payment.requested': {
    label: 'Payment request raised',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'site', 'purpose', 'requested_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'site', 'amount'],
  },
  'payment.approved': {
    label: 'Payment approved',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'step', 'approved_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'amount'],
  },
  'payment.rejected': {
    label: 'Payment rejected',
    group: 'Payments & Bills',
    live: true,
    vars: ['amount', 'party', 'category', 'rejected_by', 'reason', 'date'],
    people: [
      { key: 'requester_email', label: 'Requester' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'amount'],
  },
  'bill.uploaded': {
    label: 'Purchase bill uploaded',
    group: 'Payments & Bills',
    live: true,
    vars: ['bill_number', 'amount', 'vendor', 'uploaded_by', 'date'],
    people: [
      { key: 'uploader_email', label: 'Uploaded by' },
      { key: 'vendor_email', label: 'Vendor' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['vendor', 'amount'],
  },

  // ─── Complaints & Support ───────────────────────────────────────────
  'complaint.created': {
    label: 'Complaint registered',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'category', 'problem', 'created_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['category', 'client'],
  },
  'complaint.assigned': {
    label: 'Complaint assigned to engineer',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'engineer', 'date'],
    people: [
      { key: 'engineer_email', label: 'Assigned engineer' },
      { key: 'creator_email', label: 'Created by' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['client'],
  },
  'complaint.resolved': {
    label: 'Complaint resolved',
    group: 'Complaints & Support',
    live: true,
    vars: ['complaint_no', 'client', 'engineer', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'engineer_email', label: 'Assigned engineer' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['client'],
  },
  'ticket.created': {
    label: 'Help ticket created',
    group: 'Complaints & Support',
    live: true,
    vars: ['ticket_no', 'subject', 'priority', 'category', 'created_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['priority', 'category'],
  },
  'ticket.resolved': {
    label: 'Help ticket resolved',
    group: 'Complaints & Support',
    live: true,
    vars: ['ticket_no', 'subject', 'resolved_by', 'date'],
    people: [
      { key: 'creator_email', label: 'Created by' },
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: [],
  },

  // ─── HR ─────────────────────────────────────────────────────────────
  'leave.requested': {
    label: 'Leave request submitted',
    group: 'HR',
    live: true,
    vars: ['employee', 'leave_type', 'from_date', 'to_date', 'days', 'reason', 'date'],
    people: [
      { key: 'requester_email', label: 'Employee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['leave_type'],
  },
  'leave.decided': {
    label: 'Leave approved / rejected',
    group: 'HR',
    live: true,
    vars: ['employee', 'leave_type', 'status', 'decided_by', 'date'],
    people: [
      { key: 'requester_email', label: 'Employee' },
      { key: 'director_email', label: 'Director (default recipient)' },
    ],
    fields: ['leave_type', 'status'],
  },
  'task.assigned': {
    label: 'Task / delegation assigned',
    group: 'HR',
    live: true,
    vars: ['title', 'project', 'due_date', 'assigned_by', 'date'],
    people: [
      { key: 'assignee_email', label: 'Assignee' },
      { key: 'assigner_email', label: 'Assigned by' },
    ],
    fields: ['project'],
  },
  // ── Recruitment cron recipient lists (mam 2026-07-22) ────────────────
  // These two exist ONLY to hold the email recipients for the HR cron's
  // "offer pending" (Job 2) and "hiring request pending approval" (Job 3)
  // reminders. listOnly = the rule editor shows just By-role + Fixed
  // addresses (no dynamic people / conditions / template). The cron reads
  // the resolved recipient list as its PRIMARY email target and falls back
  // to findHrUsers when unset. Not fired through the engine.
  'hr.offer_pending': {
    label: 'Recruitment — offer pending response',
    group: 'HR',
    live: true,
    listOnly: true,
    vars: [], people: [], fields: [],
  },
  'hr.hiring_approval_pending': {
    label: 'Recruitment — hiring request pending approval',
    group: 'HR',
    live: true,
    listOnly: true,
    vars: [], people: [], fields: [],
  },

  // ── Tally Bill lifecycle (Director CR 2026-08-13 §8) ──────────────────
  // Every stage transition + every SLA breach is mailable. Recipients are the
  // configurable stage seats from Admin → Tally Bills Settings, so retargeting
  // "who gets told" never needs a code change.
  'tally_bill.uploaded': {
    label: 'Tally Bill — uploaded (T0)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'category', 'amount', 'status', 'date'],
    people: [
      { key: 'coordinator_email', label: 'PMS Coordinator' },
      { key: 'site_engineer_email', label: 'Site Engineer' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['category', 'project', 'amount', 'vendor'],
  },
  'tally_bill.tasks_created': {
    label: 'Tally Bill — PMS tasks created (T1)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'category', 'amount', 'task_count', 'date'],
    people: [
      { key: 'executor_email', label: 'PMS Executor' },
      { key: 'coordinator_email', label: 'PMS Coordinator' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['category', 'project', 'amount'],
  },
  'tally_bill.tasks_completed': {
    label: 'Tally Bill — tasks completed, awaiting approval (T2)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'category', 'amount', 'date'],
    people: [
      { key: 'coordinator_email', label: 'PMS Coordinator' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['category', 'project', 'amount'],
  },
  'tally_bill.second_approval_required': {
    label: 'Tally Bill — Director approval needed (over bill amount)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'amount', 'approved_amount', 'date'],
    people: [
      { key: 'director_email', label: 'Director' },
      { key: 'coordinator_email', label: 'PMS Coordinator' },
    ],
    fields: ['project', 'amount'],
  },
  'tally_bill.approved': {
    label: 'Tally Bill — approved, payment pending (T3)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'category', 'amount', 'approved_amount', 'expected_date', 'date'],
    people: [
      { key: 'site_engineer_email', label: 'Site Engineer' },
      { key: 'coordinator_email', label: 'PMS Coordinator' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['category', 'project', 'amount'],
  },
  'tally_bill.held': {
    label: 'Tally Bill — put on hold',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'amount', 'reason', 'date'],
    people: [
      { key: 'site_engineer_email', label: 'Site Engineer' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['project', 'amount'],
  },
  'tally_bill.rejected': {
    label: 'Tally Bill — rejected',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'amount', 'reason', 'date'],
    people: [
      { key: 'site_engineer_email', label: 'Site Engineer' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['project', 'amount'],
  },
  'tally_bill.closed': {
    label: 'Tally Bill — fully paid / closed (T4)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'category', 'approved_amount', 'date'],
    people: [
      { key: 'coordinator_email', label: 'PMS Coordinator' },
      { key: 'director_email', label: 'Director' },
    ],
    fields: ['category', 'project'],
  },
  'tally_bill.sla_breach': {
    label: 'Tally Bill — SLA reminder / breach (80 / 100 / 150%)',
    group: 'Tally Bills',
    live: true,
    vars: ['register_no', 'bill_no', 'vendor', 'project', 'amount', 'stage', 'level', 'pct', 'due_at', 'delay', 'date'],
    people: [
      { key: 'owner_email', label: 'Stage owner' },
      { key: 'director_email', label: 'Director' },
    ],
    // `level` lets one rule mail the owner at 80 and another mail the Director
    // at 150, instead of one blanket rule for every breach.
    fields: ['level', 'stage', 'project', 'amount'],
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
  // Payments & bills
  amount: '12,500',
  party: 'ABC Traders',
  purpose: 'Site material advance',
  requested_by: 'Raushan Kumar',
  step: 'L1',
  vendor: 'ABC Traders',
  bill_number: 'BILL-0042',
  uploaded_by: 'Store Team',
  // Complaints & support
  complaint_no: 'CMP-0007',
  client: 'Hero Homes',
  problem: 'AC not cooling',
  created_by: 'Front Desk',
  engineer: 'Aakash Chaudhary',
  ticket_no: 'TKT-0019',
  subject: 'Login not working',
  priority: 'High',
  resolved_by: 'Admin',
  // HR
  employee: 'Monika',
  leave_type: 'Casual',
  from_date: '2026-06-05',
  to_date: '2026-06-06',
  status: 'approved',
  decided_by: 'HR Manager',
  title: 'Submit weekly report',
  project: 'Hero Homes',
  due_date: '2026-06-07',
  assigned_by: 'Manager',
  // Tally Bills
  register_no: 'TB-2026-0007',
  bill_no: 'INV-4471',
  approved_amount: '11,800',
  expected_date: '2026-08-20',
  task_count: '3',
  stage: 'Approval + Release',
  level: '100',
  pct: '112',
  due_at: '2026-08-14 13:00:00',
  delay: '0.6',
  reason: 'Awaiting vendor GST correction',
};

function listEvents() {
  return Object.entries(EVENTS).map(([key, e]) => ({ key, ...e }));
}

module.exports = { EVENTS, SAMPLE_CONTEXT, listEvents };
