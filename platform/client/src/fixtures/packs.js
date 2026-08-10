/**
 * Pack-level catalog for entitlements pencil (not every RBAC leaf).
 * Aligned with docs/multitenancy/module-depends-graph.md product packs.
 */
export const PACK_CATALOG = [
  {
    key: 'chassis',
    name: 'Chassis',
    desc: 'Always-on: users, auth, dashboard shell',
    group: 'always',
    defaultOn: true,
    locked: true,
  },
  {
    key: 'erp_baseline',
    name: 'ERP baseline',
    desc: 'Employees, customers, vendors, business book, item master',
    group: 'erp',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'crm',
    name: 'CRM / leads',
    desc: 'Funnels, leads, quotations chain',
    group: 'erp',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'procurement',
    name: 'Procurement',
    desc: 'Indents, POs, schedule, inventory',
    group: 'erp',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'site_ops',
    name: 'Site ops',
    desc: 'DPR, snags, tools, attendance',
    group: 'erp',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'finance',
    name: 'Finance',
    desc: 'Collections, cash flow, AR-AP, payables',
    group: 'erp',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'hrms',
    name: 'HRMS lite',
    desc: 'Payroll, hiring — beyond chassis attendance',
    group: 'optional',
    defaultOnFor: ['mepf_erp'],
  },
  {
    key: 'site_chat',
    name: 'SOTYN Chat',
    desc: 'site_chat — messaging, groups, calls',
    group: 'apps',
    defaultOnFor: [],
  },
  {
    key: 'sotyn_flow',
    name: 'SOTYN Flow',
    desc: 'sotyn_flow — task boards',
    group: 'apps',
    defaultOnFor: [],
  },
  {
    key: 'solar',
    name: 'Solar',
    desc: 'Solar quotation / funnel island',
    group: 'optional',
    defaultOnFor: [],
  },
  {
    key: 'field_pwa',
    name: 'Field PWA',
    desc: 'Installable field shell (entitlement flag)',
    group: 'optional',
    defaultOnFor: [],
  },
];

export const PLAN_TEMPLATES = [
  {
    id: 'full_erp',
    name: 'Full ERP',
    packs: PACK_CATALOG.filter((p) => p.group === 'always' || p.group === 'erp' || p.key === 'hrms').map((p) => p.key),
  },
  {
    id: 'chat_only',
    name: 'Chat only',
    packs: ['chassis', 'site_chat'],
  },
  {
    id: 'feature_apps',
    name: 'Feature apps',
    packs: ['chassis', 'site_chat', 'sotyn_flow'],
  },
];

export function defaultPackState(tenantClass) {
  const on = {};
  for (const p of PACK_CATALOG) {
    if (p.locked || p.defaultOn) on[p.key] = true;
    else if (p.defaultOnFor?.includes(tenantClass || 'mepf_erp')) on[p.key] = true;
    else on[p.key] = false;
  }
  return on;
}

export function planLabelForClass(tenantClass) {
  if (tenantClass === 'feature_only') return 'Feature apps';
  if (tenantClass === 'exclusive_app') return 'Exclusive';
  return 'Full ERP';
}

export function modulesOnDisplay(tenantClass) {
  const state = defaultPackState(tenantClass);
  const on = Object.values(state).filter(Boolean).length;
  return `${on} / ${PACK_CATALOG.length}`;
}
