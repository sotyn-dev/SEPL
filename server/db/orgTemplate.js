// Org Structure — designation-catalog templates (Mandatory Field Spec HR-2)
// + the shared department skeleton (HR-3).
//
// TEMPLATES is a LIST so more than one catalog can exist side by side — e.g.
// today's generic draft plus, later, the real Role Master Sheet 03 once
// management delivers it, or a second scenario someone wants to try. The Org
// Structure page's "Load Template" picker (client/src/pages/hr/OrgStructure.jsx)
// reads this list to populate its dropdown; Preview/Set act on whichever
// template id the admin has selected. ADD A NEW TEMPLATE by pushing another
// entry below — no other file needs to change, the dropdown and the
// Preview/Set flow pick it up automatically.
//
// COMPANY_TITLES sit at the root (Managing Director) or a specific function
// node (CFO under Finance, COO under Operation) rather than a leaf — they're
// singleton roles (org_designations.singleton=1: only one active holder at a
// time), not tied to a single department's day-to-day headcount.
//
// DEPARTMENT_TITLES are per-leaf-department roles, keyed by LEAF department
// name (the 11 from SPEC_DEPARTMENTS, flattened).

const FUNCTION_NODES = ['Business', 'Operation', 'Finance', 'HR & Admin', 'System & Process'];

// The department skeleton is SHARED across every template — it's the HR-3
// dept master, seeded once at boot (orgSchema.js) regardless of which
// designation catalog (below) an admin later applies. Mirrors orgSchema.js's
// SPEC_DEPTS — kept here too so this file stays a self-contained reference.
const SPEC_DEPARTMENTS = {
  'Business': ['Sales', 'Marketing', 'CRM'],
  'Operation': ['Operations', 'Purchase', 'Design', 'Service'],
  'Finance': ['Finance'],
  'HR & Admin': ['HR', 'Admin'],
  'System & Process': ['IT'],
};

const TEMPLATES = [
  {
    id: 'draft-generic-v1',
    name: 'Draft Starter (generic EPC/solar titles)',
    description: 'Generic placeholder titles, until the real Role Master arrives.',
    // { name, tagName, attachTo: function-node name | null (null = root) }
    companyTitles: [
      { name: 'Managing Director', tagName: 'MD', attachTo: null },
      { name: 'Chief Financial Officer', tagName: 'CFO', attachTo: 'Finance' },
      { name: 'Chief Operating Officer', tagName: 'COO', attachTo: 'Operation' },
    ],
    departmentTitles: {
      'Sales': ['Sales Executive', 'Sales Manager'],
      'Marketing': ['Marketing Executive', 'Marketing Manager'],
      'CRM': ['CRM Executive', 'CRM Manager'],
      'Operations': ['Site Engineer', 'Site Supervisor', 'Project Manager'],
      'Purchase': ['Purchase Executive', 'Purchase Manager'],
      'Design': ['Design Engineer', 'Estimation Engineer'],
      'Service': ['Service Engineer', 'Service Manager'],
      'Finance': ['Accountant', 'Finance Manager'],
      'HR': ['HR Executive', 'HR Manager'],
      'Admin': ['Admin Executive', 'Office Assistant'],
      'IT': ['IT Executive', 'System Administrator'],
    },
  },
];

function getTemplate(id) {
  return TEMPLATES.find((t) => t.id === id) || null;
}

module.exports = { FUNCTION_NODES, SPEC_DEPARTMENTS, TEMPLATES, getTemplate };
