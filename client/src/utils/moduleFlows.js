// Stable module IDs: append new entries; never renumber for menu order or roles.
// Steps are guidance, not completion status or mandatory approval gates.
const definitions = [
  ['/orders', 'Order to Planning', 'Select project and PO|Open or upload PO items|Check descriptions, quantities, units and rates|Save PO items|Open Order Planning|Review item-wise planning and need dates'],
  ['/dpr', 'Daily Reports', 'Select site and report date|Select PO work items|Enter planned and actual quantities|Record labour and material usage|Review and save report|Review approval and billing readiness'],
  ['/installation', 'Sales Billing', 'Select order or approved DPRs|Review bill type and source|Review quantities, units and rates|Generate bill|Review approval and payments|Open Print / Save PDF'],
  ['/procurement', 'Indent to Dispatch', 'Select project|Review indent items and quantities|Review required rates|Review vendor PO|Track dispatch and delivery|Review receipt and billing'],
  ['/influencers', 'Partners', 'Find partner|Open partner details|Review contacts and follow-ups|Save changes'],
  ['/crm-funnel', 'CRM Sales Funnel', 'Find enquiry|Review customer and requirement|Review current stage|Record follow-up|Update outcome'],
  ['/leads', 'Sales Funnel', 'Find lead|Review requirement|Record follow-up|Update lead stage|Review outcome'],
  ['/sotyn-leads', 'Sotyn Leads', 'Review incoming enquiries|Open enquiry|Check contact and requirement|Convert to Sales Funnel'],
  ['/business-book', 'Business Book', 'Find business order|Review client and project|Review PO and order values|Update order details|Save changes'],
  ['/customers', 'Customers', 'Find customer|Review contact details|Review billing and tax details|Save changes'],
  ['/crm-kitting', 'Full Kitting', 'Select project|Review kitting requirements|Update pending items|Review readiness'],
  ['/labour-management', 'Quotations & Rates', 'Select project|Review labour quotation|Review item rates|Submit for approval|Review approval outcome'],
  ['/indent-labour-payment', 'Projects & Work Orders', 'Select project|Review work orders|Review contractor and scope|Track work progress|Review labour payments'],
  ['/labour-master', 'Labour Master', 'Find labour item|Review description and unit|Review rate|Save changes'],
  ['/bill-verification', 'Bill Verification', 'Select bill|Review supporting work details|Check quantities and rates|Record verification outcome'],
  ['/solar-funnel', 'Solar Sales Funnel', 'Find enquiry|Review site requirement|Record follow-up|Update stage'],
  ['/solar-site-design', '3D Shadow Analysis', 'Select site|Review roof layout|Configure obstacles and panels|Review shadow analysis'],
  ['/solar-quotation', 'Solar Quotation', 'Select customer and site|Review system requirements|Review materials and pricing|Save quotation|Review quotation output'],
  ['/solar-projects', 'Solar Projects', 'Select project|Review project details|Track execution|Review net metering progress'],
  ['/solar-material-master', 'Solar Material Master', 'Find material|Review specifications|Review pricing|Save changes'],
  ['/solar-labour-master', 'Solar Labour Master', 'Find labour entry|Review work description|Review rate|Save changes'],
  ['/solar-rate-master', 'Solar Settings', 'Open rate settings|Review current values|Edit required values|Save changes'],
  ['/quotations', 'Quotations', 'Select client and project|Add quotation items|Review quantities, units and prices|Review totals and terms|Save quotation|Review approval and print'],
  ['/estimator', 'AI Auto-Quotation', 'Enter project requirements|Generate estimate|Review suggested items and quantities|Review pricing|Review quotation output'],
  ['/po-foc-stripped', 'Price Breakup Master', 'Select order|Review item price breakup|Edit required values|Save changes'],
  ['/labour-rate', 'Labour Rate', 'Find work item|Review unit and labour rate|Edit required rate|Save changes'],
  ['/item-master', 'Items', 'Find item|Review name and specification|Review unit and classification|Save changes'],
  ['/price-required', 'RFQ Queue', 'Review items requiring prices|Open item request|Review pricing details|Update price response'],
  ['/vendors', 'Vendors', 'Find vendor|Review contacts|Review tax and payment details|Save changes'],
  ['/procurement-schedule', 'Schedule (Gantt)', 'Select project|Review need dates|Review procurement timeline|Update schedule|Review overdue items'],
  ['/snags', 'Snags', 'Select site|Review or record snag|Assign responsibility|Update correction and proof|Review closure'],
  ['/fire-noc', 'Fire NOC Renewal', 'Select renewal record|Review expiry and requirements|Track renewal steps|Review documents and completion'],
  ['/tally-bills', 'Tally Bills', 'Review imported bills|Open bill details|Review linked PMS task|Track approval'],
  ['/drawing-tracker', 'Drawings', 'Select project|Review drawing register|Open drawing and revision|Update drawing progress'],
  ['/drawing-tracker?tab=reports', 'Drawing Reports', 'Select report filters|Review drawing progress|Review delays and pending work'],
  ['/cheques', 'Cheques', 'Find cheque|Review cheque details|Review due date|Update cheque status'],
  ['/payment-required', 'Payables', 'Review pending payments|Open payable|Review amount and due date|Review approval|Record payment progress'],
  ['/collections', 'Collections', 'Review receivables|Select client or invoice|Review amount due|Record follow-up|Update collection progress'],
  ['/cash-flow-tracker', 'Cash Flow Tracker', 'Select period|Review expected collections|Review planned payments|Review projected balance'],
  ['/billing', 'Invoices', 'Select invoice|Review line items|Review tax and totals|Review invoice status|Open invoice output'],
  ['/client-snag', 'Client Snag', 'Select bill or site|Review missing client signature|Review supporting proof|Update completion'],
  ['/bank', 'Bank', 'Select bank account|Import statement|Review transactions|Match receipts and payments|Review unmatched entries'],
  ['/hr', 'Hiring', 'Review manpower requirement|Review candidates|Schedule interview|Record interview decision|Review MD round|Track offer|Finalize onboarding'],
  ['/subcon-hiring', 'Sub-contractor Hiring', 'Review hiring requirement|Review contractor candidates|Review current hiring stage|Record stage outcome|Review onboarding progress'],
  ['/induction', 'Onboarding', 'Select employee|Review onboarding requirements|Complete pending activities|Review completion'],
  ['/training', 'Training', 'Review assigned training|Open training material|Complete required activities|Review progress'],
  ['/attendance', 'Attendance', 'Select date and site|Review attendance entries|Review missing or incorrect entries|Save permitted corrections'],
  ['/payroll', 'Payroll', 'Select payroll period|Review employees and attendance|Review earnings and deductions|Review payroll totals|Review payment status'],
  ['/employees', 'Employees', 'Find employee|Review employment details|Review documents and contacts|Save changes'],
  ['/scorecard', 'Performance', 'Select period|Review targets|Review actual results|Review score and pending actions'],
  ['/champions', 'Champions League', 'Select ranking period|Review leaderboard|Review individual results'],
  ['/module-owners', 'Module Owners', 'Find module|Review assigned owner|Update responsibility|Save changes'],
  ['/sub-contractors', 'Sub-contractor Master Detail', 'Find contractor|Review trade and contacts|Review supporting details|Save changes'],
  ['/rental-tools', 'Tool Rentals', 'Review rental requirements|Select tool rental|Review issue and return dates|Review rental charges'],
  ['/company-assets', 'Assets', 'Find asset|Review assignment|Review asset condition|Update asset record'],
  ['/inventory', 'Inventory', 'Select store or site|Find item|Review stock and movements|Review available balance'],
  ['/tools', 'Tools', 'Find tool|Review tool details|Review allocation and availability|Update tool record'],
  ['/rentals', 'Room Rentals', 'Find rental|Review location and agreement|Review rent and due dates|Update rental record'],
  ['/delegations', 'Delegations', 'Review or create delegation|Assign person and due date|Track progress|Review completion'],
  ['/pms-tasks', 'PMS Tasks', 'Select project|Review assigned tasks|Update task progress|Attach required proof|Review completion'],
  ['/checklists', 'Checklists', 'Review due checklist|Open checklist items|Complete required checks|Review pending checks'],
  ['/complaints', 'Complaints', 'Open or register complaint|Review issue|Assign responsibility|Record resolution|Review closure'],
  ['/help-tickets', 'Help Tickets', 'Open or create ticket|Describe issue|Track replies|Review resolution'],
  ['/system-requirements', 'System Requirements', 'Create or select requirement|Review details and attachments|Review discussion|Track implementation|Review outcome'],
  ['/system-flow', 'ERP Management', 'Create system|Align with responsible people|Roll out system|Review alignment and score'],
  ['/dashboard/war-room', 'War Room', 'Review current indicators|Identify exceptions|Review required actions'],
  ['/dashboard/cmd', 'Operating Console', 'Review business indicators|Inspect priority issues|Review actions and owners'],
  ['/dashboard/cmd-toc', 'TOC View', 'Review constraints|Review priorities|Review required actions'],
  ['/admin/word-count', 'Activity Log', 'Select filters|Review user activity|Inspect activity details'],
  ['/admin/locations', 'Location', 'Select person and period|Review recorded locations|Inspect location details'],
  ['/admin/backups', 'Backups', 'Review available backups|Review backup date|Select required backup action'],
  ['/admin/ai-settings', 'AI', 'Review AI settings|Edit required configuration|Save changes'],
  ['/admin/email-settings', 'Email', 'Review email configuration|Edit required settings|Save changes'],
  ['/admin/email-triggers', 'Email Triggers', 'Review trigger rules|Select trigger|Review recipients and conditions|Save changes'],
  ['/admin/users', 'Users', 'Find user|Review account details|Review assigned role|Save changes'],
  ['/admin/roles', 'Roles & Permissions', 'Select role|Review module access|Edit required permissions|Save changes'],
  ['/admin/audit', 'Audit Log', 'Select filters|Review audit entries|Inspect change details'],
  ['/admin/performance', 'System Performance', 'Review performance indicators|Inspect slow requests|Review errors'],
  ['/', 'Dashboard', 'Review summary|Identify pending work|Open relevant module'],
  ['/sotyn-flow', 'SOTYN Flow', 'Select board|Review tasks|Open task details|Update progress'],
  ['/expenses', 'Expenses', 'Select or create expense|Review amount and category|Review supporting receipt|Review approval'],
  ['/procurement-board', 'Procurement Board', 'Select project|Review pipeline stages|Open pending item|Update stage progress'],
  ['/rates-board', 'Rates Board', 'Review pending rates|Select item|Review vendor pricing|Update pricing progress'],
  ['/rates-items', 'Item-wise Rates', 'Select project|Review item requirements|Review need dates and rates|Save changes'],
  ['/site-chat', 'SOTYN Chat', 'Select conversation|Review messages|Write message or attach file|Send message'],
  ['/indent-fms', 'Indent FMS', 'Select indent|Review current stage|Review pending actions|Update progress'],
  ['/admin/collections-md', 'Collections Review', 'Review collection targets|Review receipts|Review outstanding amounts|Review follow-ups'],
];

export const MODULE_FLOWS = definitions.map(([path, title, steps], index) => ({
  path, title, number: index + 1, steps: steps.split('|'),
}));

export function getModuleFlow(pathname, search = '') {
  const exactQuery = MODULE_FLOWS.find(flow => flow.path.includes('?')
    && flow.path.split('?')[0] === pathname
    && [...new URLSearchParams(flow.path.split('?')[1])].every(([key, value]) => new URLSearchParams(search).get(key) === value));
  return exactQuery || MODULE_FLOWS.find(flow => flow.path === pathname)
    || MODULE_FLOWS.filter(flow => flow.path !== '/' && !flow.path.includes('?') && pathname.startsWith(`${flow.path}/`))
      .sort((a, b) => b.path.length - a.path.length)[0];
}

export function flowLabel(path, label) {
  const [pathname, search] = path.split('?');
  const flow = getModuleFlow(pathname, search);
  return flow ? `${flow.number} · ${label}` : label;
}
