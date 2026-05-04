// Seeds the 20 role-specific MIS scorecard templates mam shared on
// 2026-05-04. Runs once on server boot — only seeds when the
// score_templates table is empty so re-runs are no-ops.
//
// Sources: PDFs in C:\Users\admin\Desktop\scoring\ (Aanchal, Site Eng,
// Supervisor, Monika, Anmol, Ankush, Ajmer, Gaganpreet, Indresh, Lovely,
// Nancy, Nitin, Parul, Pradeep Panda, Raj Kumar, Rajeev Sood, Riti,
// Ruksana, Shubham, Sushila).
//
// data_source on each KPI:
//   'manual'              — admin / user types the actual each week
//   'auto:delegations'    — engine pulls from delegations table
//   'auto:pms'            — engine pulls from pms_tasks
//   'auto:checklists'     — engine pulls from checklist_completions
//   'auto:tickets'        — engine pulls from support_tickets

const TEMPLATES = [
  {
    name: 'Site Engineer',
    description: 'Site execution KPIs — DPR, indents, billing, manpower',
    kpis: [
      { group: 'Weekly', name: 'Weekly DPR Profit', weight: 25, source: 'auto:dpr_profit' },
      { group: 'Weekly', name: 'Indent Accuracy', weight: 10, source: 'auto:indents_in_week' },
      { group: 'Weekly', name: 'Project in Budget', weight: 0 },
      { group: 'Weekly', name: 'MB Signed from Client', weight: 10, source: 'auto:mb_signed' },
      { group: 'Weekly', name: 'Full kitting of manpower and tools before material', weight: 0 },
      { group: 'Weekly', name: 'Indent vs Bill', weight: 10 },
      { group: 'Weekly', name: 'Buffer used', weight: 10 },
      { group: 'Weekly', name: 'Scrap', weight: 5 },
      { group: 'Weekly', name: 'Rework', weight: 5, direction: 'lower_better' },
      { group: 'Weekly', name: 'Milestone completed', weight: 10 },
      { group: 'Weekly', name: 'Indent vs Consumption', weight: 10 },
      { group: 'Weekly', name: 'Stock at site', weight: 5, source: 'auto:stock_at_site' },
    ],
  },
  {
    name: 'Supervisor',
    description: 'On-ground supervision KPIs — DPR, full-kit, stock, photos',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Rework', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'DPR Planning', weight: 10, source: 'auto:dpr_count' },
      { group: 'Weekly', name: 'DPR Daily Actual', weight: 10, source: 'auto:dpr_count' },
      { group: 'Weekly', name: 'Full kit verification before start', weight: 10 },
      { group: 'Weekly', name: 'Material Receiving signed from client', weight: 10 },
      { group: 'Weekly', name: 'Stock report accuracy', weight: 10 },
      { group: 'Weekly', name: 'Daily Manpower photo', weight: 5 },
      { group: 'Weekly', name: 'Tools List submission', weight: 5 },
      { group: 'Weekly', name: 'Material Loss / Pilferage', weight: 5, direction: 'lower_better' },
      { group: 'Weekly', name: 'DPR Cost Accuracy', weight: 5 },
      { group: 'Weekly', name: 'DPR Profitability Accuracy', weight: 10 },
    ],
  },
  {
    name: 'Aanchal — Finance Executive',
    description: 'Cash-flow + recovery + expense control',
    kpis: [
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Overdue Recovery', weight: 15 },
      { group: 'Weekly', name: 'Expense Control (As Per Budget)', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Cash Flow Forecast Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Cash Flow Positive', weight: 15 },
      { group: 'Weekly', name: 'Weekly Amount Received', weight: 30 },
    ],
  },
  {
    name: 'Monika — AI Implementation Head',
    description: 'AI roll-out, automations, ROI',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 10, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Weekly', name: 'New Tool Evaluated / Month', weight: 15 },
      { group: 'Weekly', name: 'Automations Live Count', weight: 20 },
      { group: 'Weekly', name: 'Hours Saved Company Wide / Month', weight: 20 },
      { group: 'Weekly', name: 'ROI of AI Dept (X)', weight: 30 },
    ],
  },
  {
    name: 'Anmol — DPR / Score Card',
    description: 'DPR planning + actual + score-card accuracy',
    kpis: [
      { group: 'Weekly', name: 'DPR Planning', weight: 10 },
      { group: 'Weekly', name: 'DPR Actual Collection', weight: 10 },
      { group: 'Weekly', name: 'DPR Planning Profit', weight: 10 },
      { group: 'Weekly', name: 'DPR Actual Profit', weight: 15 },
      { group: 'Weekly', name: 'Score Card Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Data Accuracy', weight: 10 },
      { group: 'Weekly', name: 'System Running FMS', weight: 15 },
      { group: 'Weekly', name: 'Checklist', weight: 10, source: 'auto:checklists' },
      { group: 'Weekly', name: 'AI Automation Created', weight: 5 },
      { group: 'Weekly', name: 'Time Saved', weight: 5 },
    ],
  },
  {
    name: 'Ankush — HR Ops + Marketing',
    description: 'Hiring, social media, complaints, training',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Basic',  name: 'MEP Marketing Qualified Lead', weight: 10 },
      { group: 'Basic',  name: 'GEM Project Qualified Supply', weight: 10 },
      { group: 'Basic',  name: 'Company Social Media Post / Reels', weight: 10 },
      { group: 'Basic',  name: 'Company Social Media Likes', weight: 10 },
      { group: 'Basic',  name: 'Personal Social Media Post', weight: 10 },
      { group: 'HR',     name: 'Manpower Required Blue', weight: 15 },
      { group: 'HR',     name: 'Manpower Required White', weight: 15 },
      { group: 'Operations', name: 'Complaint Solved %', weight: 5 },
      { group: 'Operations', name: 'Documentation', weight: 5 },
      { group: 'Operations', name: 'Training', weight: 5 },
    ],
  },
  {
    name: 'Ajmer — Procurement Lead',
    description: 'Purchase to receiving + transport savings',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS', weight: 0, source: 'auto:pms' },
      { group: 'Weekly', name: 'Purchase to Rec', weight: 35 },
      { group: 'Weekly', name: 'Transportation Saving', weight: 45 },
      { group: 'Weekly', name: 'Rental Tools Cost', weight: 20, direction: 'lower_better' },
    ],
  },
  {
    name: 'Gaganpreet — Cash Flow Manager',
    description: 'Cash positive, billing conversion, AR control',
    kpis: [
      { group: 'Weekly', name: 'Cash Positive', weight: 15 },
      { group: 'Weekly', name: 'Billing Conversion', weight: 10 },
      { group: 'Weekly', name: 'AR Control', weight: 15 },
      { group: 'Weekly', name: 'Unbilled Revenue', weight: 20, direction: 'lower_better' },
      { group: 'Weekly', name: 'PO to Purchase Bill', weight: 0 },
      { group: 'Weekly', name: 'Cash Forecast Accuracy', weight: 10 },
      { group: 'Weekly', name: 'Vendor Payment Discipline', weight: 15 },
      { group: 'Weekly', name: 'Top 10 Client Collection', weight: 15 },
      { group: 'Monthly', name: 'Monthly Throughput (Sales-TVC)', weight: 0 },
      { group: 'Monthly', name: 'PAT %', weight: 0 },
      { group: 'Monthly', name: 'Gross Margin %', weight: 0 },
      { group: 'Monthly', name: 'AR Days', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Cash Conversion Cycle', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Billing Cycle Time', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Interest Cost %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Budget Variance %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'GST Recovery %', weight: 0 },
      { group: 'Monthly', name: 'Cash Reserve Days', weight: 0 },
      { group: 'Monthly', name: 'Compliance', weight: 0 },
    ],
  },
  {
    name: 'Indresh — Billing Engineer',
    description: 'RA bills, MB sheets, AI templates',
    kpis: [
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'RA Bills Raised Weekly', weight: 0, source: 'auto:ra_bills' },
      { group: 'Weekly', name: 'Measurement Sheet Submitted', weight: 0 },
      { group: 'Weekly', name: 'RA Bill Value (Lakhs)', weight: 0 },
      { group: 'Monthly', name: 'RA Bills Raised / Month', weight: 0 },
      { group: 'Monthly', name: 'RA Bill Value (Lakhs) Monthly', weight: 0 },
      { group: 'Monthly', name: 'RA Bill Rejection %', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'AI Auto RA / MB Templates Used %', weight: 0 },
      { group: 'Monthly', name: 'AI Billing TAT Reduction %', weight: 0 },
    ],
  },
  {
    name: 'Lovely — Sales Coordinator',
    description: 'Payments, response time, full kitting, complaints',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Payments Cleared (In lakh)', weight: 20 },
      { group: 'Weekly', name: 'Response Client Time On Whatsapp', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Response Client Time On Email', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Number of Escalations to MD', weight: 10, direction: 'lower_better' },
      { group: 'Full Kitting', name: 'Before Start', weight: 10 },
      { group: 'Full Kitting', name: 'Running', weight: 10 },
      { group: 'Full Kitting', name: 'Handover', weight: 10 },
      { group: 'Full Kitting', name: 'Complaint Resolved', weight: 10 },
      { group: 'Full Kitting', name: 'On Time', weight: 5 },
      { group: 'Monthly', name: 'AR Cleared (In CR)', weight: 0 },
      { group: 'Monthly', name: 'AR (In CR)', weight: 0, direction: 'lower_better' },
    ],
  },
  {
    name: 'Nancy — Estimation & Costing Head',
    description: 'BOQ delivery, TAT, margin, conversion',
    kpis: [
      { group: 'Weekly',    name: 'BOQ / Estimates Delivered', weight: 35 },
      { group: 'Weekly',    name: 'Estimation TAT', weight: 20, direction: 'lower_better' },
      { group: 'Weekly',    name: 'Revisions per Project', weight: 10, direction: 'lower_better' },
      { group: 'Weekly',    name: 'Margin Protected on Quotes', weight: 15 },
      { group: 'Weekly',    name: 'BOQ Accuracy %', weight: 0 },
      { group: 'Weekly',    name: 'Conversion', weight: 15 },
      { group: 'Weekly',    name: 'Costing Variance vs Actual', weight: 0, direction: 'lower_better' },
      { group: 'Data Entry', name: 'Lead Win to Business Book', weight: 0 },
      { group: 'Data Entry', name: 'Lead Entry Indent & Lead', weight: 1 },
      { group: 'Data Entry', name: 'Delegation Entry', weight: 2, source: 'auto:delegations' },
      { group: 'Data Entry', name: 'Task Entry', weight: 2 },
    ],
  },
  {
    name: 'Nitin Sir — MD',
    description: 'Throughput, cash flow, full kitting, DSO',
    kpis: [
      { group: 'Basic',  name: 'SR. Delegation', weight: 3, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 2, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Throughput', weight: 15 },
      { group: 'Weekly', name: 'Barchart vs Per Plan', weight: 10 },
      { group: 'Weekly', name: 'Cash Flow Positive', weight: 45 },
      { group: 'Weekly', name: 'WIP Control', weight: 0 },
      { group: 'Weekly', name: 'Full Kitting Execution', weight: 15 },
      { group: 'Weekly', name: 'Daily Sales Outstanding', weight: 10, direction: 'lower_better' },
    ],
  },
  {
    name: 'Parul — Compliance & Tender',
    description: 'Govt tender, compliance, bad debts, litigation',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Govt Tender Conversion %', weight: 10 },
      { group: 'Weekly', name: 'Compliance', weight: 15 },
      { group: 'Weekly', name: 'Bad Debts', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Gaganpreet Score', weight: 50 },
      { group: 'Monthly', name: 'Conversion %', weight: 15 },
      { group: 'Monthly', name: 'Litigation (1 case per month)', weight: 10 },
      { group: 'Monthly', name: 'Compliance (Monthly)', weight: 25 },
    ],
  },
  {
    name: 'Pradeep Panda — Operations Lead',
    description: 'Site labour, escalations, meetings, calendar',
    kpis: [
      { group: 'Weekly', name: 'Labour at Site', weight: 20 },
      { group: 'Weekly', name: 'Email Reply in 24hrs', weight: 10 },
      { group: 'Weekly', name: 'MD Sir Call Escalation', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'All Company Delegation Task', weight: 20, source: 'auto:delegations' },
      { group: 'Weekly', name: 'Help Ticket', weight: 10, source: 'auto:tickets' },
      { group: 'Weekly', name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Regular Meetings', weight: 10 },
      { group: 'Weekly', name: '50% Calendar Blank', weight: 5 },
      { group: 'Weekly', name: 'Travel Schedule', weight: 10 },
    ],
  },
  {
    name: 'Raj Kumar — Procurement Manager',
    description: 'Material, credit period, full kitting, vendor',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Negotiated Savings % (Estimation)', weight: 10 },
      { group: 'Weekly', name: 'Material on Credit %', weight: 10 },
      { group: 'Weekly', name: 'Credit Period Days', weight: 10 },
      { group: 'Weekly', name: 'Comparison to PO', weight: 10 },
      { group: 'Weekly', name: 'Full Kitting', weight: 10 },
      { group: 'Weekly', name: 'No Stock Out of Site', weight: 5 },
      { group: 'Weekly', name: 'Material Ready Before Schedule', weight: 10 },
      { group: 'Weekly', name: 'Indent to Receiving', weight: 10 },
      { group: 'Weekly', name: 'Order to Planning', weight: 5 },
      { group: 'Monthly', name: 'Cost Saving', weight: 0 },
      { group: 'Monthly', name: 'Indent to Receiving (Monthly)', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'Vendor Performance Score', weight: 0 },
      { group: 'Monthly', name: 'Procurement Impact on Delays', weight: 0, direction: 'lower_better' },
    ],
  },
  {
    name: 'Rajeev Sood — Quotation',
    description: 'Quotation quantity, TAT, conversion, costing accuracy',
    kpis: [
      { group: 'Quotation', name: 'Quantity', weight: 25 },
      { group: 'Quotation', name: 'Turnaround Time', weight: 35, direction: 'lower_better' },
      { group: 'Quotation', name: 'Conversion', weight: 20 },
      { group: 'Quotation', name: 'Costing Accuracy', weight: 10 },
      { group: 'Quotation', name: 'Revision Turnaround Time', weight: 10, direction: 'lower_better' },
      { group: 'Monthly', name: 'GP %', weight: 0 },
      { group: 'Monthly', name: 'Conversion (Monthly)', weight: 0 },
    ],
  },
  {
    name: 'Riti — Sales Coordinator (Sales Side)',
    description: 'Meetings, average ticket, response time, lead time',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 5, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Weekly', name: 'Meeting Planned', weight: 25 },
      { group: 'Weekly', name: 'Average Ticket', weight: 30 },
      { group: 'Weekly', name: 'Client Response Time Email', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Client Response Time Whatsapp', weight: 0, direction: 'lower_better' },
      { group: 'Weekly', name: 'Proposal Turnaround Time', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Lead Time to Call', weight: 10, direction: 'lower_better' },
      { group: 'Weekly', name: 'Sales to Execution Handover', weight: 15 },
      { group: 'Weekly', name: 'Escalation Matrix to MD', weight: 5, direction: 'lower_better' },
      { group: 'Monthly', name: 'Conversion %', weight: 20 },
      { group: 'Monthly', name: 'Sales Pipeline %', weight: 30 },
    ],
  },
  {
    name: 'Ruksana — HR Hiring',
    description: 'Sub-contractor + secured employee hiring',
    kpis: [
      { group: 'Basic',  name: 'Delegation', weight: 0, source: 'auto:delegations' },
      { group: 'Basic',  name: 'PMS Task', weight: 0, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Contractor', name: 'Sub-Contractor Blue Collar Lead to Call', weight: 0 },
      { group: 'Contractor', name: 'On-Board', weight: 0 },
      { group: 'Contractor', name: 'Labour Cost Variance', weight: 0, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'SEPL White Collar Lead to Call', weight: 10 },
      { group: 'Secured Emp', name: 'SEPL Blue Collar Lead to Call', weight: 10 },
      { group: 'Secured Emp', name: 'SEPL White Collar Cost', weight: 15, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'SEPL Blue Collar Cost', weight: 10, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'Shortlisted Turnaround Time', weight: 20, direction: 'lower_better' },
      { group: 'Secured Emp', name: 'Joining Conversion', weight: 35 },
    ],
  },
  {
    name: 'Shubham — Accounts',
    description: 'Indent comparison, budgeting, project planning, compliance',
    kpis: [
      { group: 'Basic',  name: 'PMS', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Checklist', weight: 5, source: 'auto:checklists' },
      { group: 'Basic',  name: 'Help Ticket', weight: 5, source: 'auto:tickets' },
      { group: 'Weekly', name: 'Indent to Comparison', weight: 10 },
      { group: 'Weekly', name: 'Budgeting vs Actual', weight: 15 },
      { group: 'Weekly', name: 'Project-wise Budget vs Actual', weight: 10 },
      { group: 'Weekly', name: 'Project-wise Cash Flow Planning', weight: 10 },
      { group: 'Weekly', name: 'Project-wise Planning Accuracy', weight: 20 },
      { group: 'Weekly', name: 'Purchase Bill to Receiving', weight: 10 },
      { group: 'Weekly', name: 'Compliance', weight: 5 },
      { group: 'Weekly', name: 'Compliance on Time', weight: 5 },
      { group: 'Monthly', name: 'Indent vs Receiving', weight: 0 },
      { group: 'Monthly', name: 'Budget vs Actual', weight: 0 },
      { group: 'Monthly', name: 'Cash Flow Forecasting', weight: 0 },
      { group: 'Monthly', name: 'Billing TAT', weight: 0, direction: 'lower_better' },
      { group: 'Monthly', name: 'AI Tools', weight: 0 },
      { group: 'Monthly', name: 'Compliance Qty', weight: 0 },
    ],
  },
  {
    name: 'Sushila — Sales Coordinator',
    description: 'Same template family as Lovely (Sales Coordinator)',
    kpis: [
      { group: 'Basic',  name: 'PMS Task', weight: 5, source: 'auto:pms' },
      { group: 'Basic',  name: 'Help Ticket', weight: 0, source: 'auto:tickets' },
      { group: 'Basic',  name: 'Checklist', weight: 0, source: 'auto:checklists' },
      { group: 'Weekly', name: 'Payments Cleared (In lakh)', weight: 15 },
      { group: 'Weekly', name: 'Response Client Time On Whatsapp', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Response Client Time On Email', weight: 15, direction: 'lower_better' },
      { group: 'Weekly', name: 'Number of Escalations to MD', weight: 10, direction: 'lower_better' },
      { group: 'Full Kitting', name: 'Before Start', weight: 10 },
      { group: 'Full Kitting', name: 'Running', weight: 15 },
      { group: 'Full Kitting', name: 'Handover', weight: 15 },
      { group: 'Full Kitting', name: 'Complaint Resolved', weight: 0 },
      { group: 'Full Kitting', name: 'On Time', weight: 0 },
      { group: 'Monthly', name: 'AR Cleared (In CR)', weight: 0 },
      { group: 'Monthly', name: 'AR (In CR)', weight: 0, direction: 'lower_better' },
    ],
  },
];

// One-time data_source upgrade for templates seeded BEFORE the auto-fetch
// patches landed. Maps (template_name, kpi_metric_name) -> new data_source.
// Idempotent — only updates rows where data_source is still 'manual'.
function upgradeAutoSources(db) {
  const map = [
    ['Site Engineer', 'Weekly DPR Profit', 'auto:dpr_profit'],
    ['Site Engineer', 'Indent Accuracy', 'auto:indents_in_week'],
    ['Site Engineer', 'MB Signed from Client', 'auto:mb_signed'],
    ['Site Engineer', 'Stock at site', 'auto:stock_at_site'],
    ['Supervisor', 'DPR Planning', 'auto:dpr_count'],
    ['Supervisor', 'DPR Daily Actual', 'auto:dpr_count'],
    ['Indresh — Billing Engineer', 'RA Bills Raised Weekly', 'auto:ra_bills'],
  ];
  const upd = db.prepare(`
    UPDATE score_kpis
       SET data_source = ?
     WHERE data_source = 'manual'
       AND metric_name = ?
       AND template_id = (SELECT id FROM score_templates WHERE name = ? LIMIT 1)
  `);
  let changed = 0;
  for (const [tpl, kpi, src] of map) {
    const r = upd.run(src, kpi, tpl);
    changed += r.changes || 0;
  }
  return changed;
}

function seedScoringTemplates(db) {
  // Always run the upgrade pass — does nothing if already done.
  const upgraded = upgradeAutoSources(db);
  // Skip initial seed if templates already exist
  const count = db.prepare('SELECT COUNT(*) as c FROM score_templates').get().c;
  if (count > 0) return { seeded: 0, skipped: count, upgraded };

  const insertTemplate = db.prepare(
    'INSERT INTO score_templates (name, description) VALUES (?, ?)'
  );
  const insertKpi = db.prepare(
    `INSERT INTO score_kpis (template_id, group_name, metric_name, weightage, direction, data_source, display_order)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );

  const tx = db.transaction(() => {
    for (const t of TEMPLATES) {
      const r = insertTemplate.run(t.name, t.description || null);
      const tid = r.lastInsertRowid;
      let order = 0;
      for (const k of t.kpis) {
        insertKpi.run(
          tid,
          k.group || 'Weekly',
          k.name,
          k.weight || 0,
          k.direction || 'higher_better',
          k.source || 'manual',
          order++
        );
      }
    }
  });
  tx();
  return { seeded: TEMPLATES.length, skipped: 0 };
}

module.exports = { seedScoringTemplates, TEMPLATES };
