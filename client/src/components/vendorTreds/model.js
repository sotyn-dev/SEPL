export const BASE = '/vendor-treds';

export const TABS = [
  { id: 'dashboard', label: 'Dashboard', permission: 'vendor_treds_dashboard' },
  { id: 'registrations', label: 'Vendor Registration', permission: 'vendor_registrations' },
  { id: 'enquiries', label: 'Enquiries / RFQs', permission: 'vendor_enquiries' },
  { id: 'approvals', label: 'Vendor Approvals', permission: 'vendor_approvals' },
  { id: 'treds', label: 'TReDS', permission: 'treds_accounts' },
  { id: 'invoices', label: 'Invoices', permission: 'treds_invoices' },
  { id: 'discounting', label: 'Bill Discounting', permission: 'bill_discounting' },
  { id: 'reports', label: 'Reports', permission: 'vendor_treds_reports' },
  { id: 'masters', label: 'Master Data', permission: 'vendor_treds_masters' },
  { id: 'settings', label: 'Settings', permission: 'vendor_treds_settings' },
];

export const KIND_TAB = { registrations: 'registrations', enquiries: 'enquiries', approvals: 'approvals', accounts: 'treds', mappings: 'treds', contacts: 'masters', invoices: 'invoices', funding: 'discounting', followups: 'enquiries', tasks: 'dashboard', history: 'dashboard', catalog: 'masters' };

export const REPORTS = [
  ['daily_registrations', 'Daily Vendor Registration'],
  ['weekly_registrations', 'Weekly Vendor Registration'],
  ['vendor_approvals', 'Vendor Approval'],
  ['vendor_codes', 'Vendor Codes'],
  ['enquiries', 'Enquiry / RFQ'],
  ['po_conversion', 'PO Conversion'],
  ['treds_registration', 'TReDS Registration'],
  ['invoice_uploads', 'Invoice Upload'],
  ['funding', 'Funding'],
  ['pending_followups', 'Pending Follow-up'],
  ['weekly_kpi_scorecard', 'Weekly KPI Scorecard'],
];

export function label(value) {
  return String(value ?? '').replaceAll('_', ' ').replaceAll('-', ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function definition(options, kind) {
  const defs = options?.entity_defs || {};
  return Array.isArray(defs) ? defs.find(d => d.kind === kind || d.key === kind) || {} : defs[kind] || {};
}

export function fieldsFor(def) {
  return Array.isArray(def.fields) ? def.fields : Object.entries(def.fields || {}).map(([key, f]) => ({ key, ...f }));
}

export function workflowStatusGroups(options, canView) {
  const defs = options?.entity_defs || {};
  const entries = Array.isArray(defs) ? defs.map(def => [def.kind || def.key, def]) : Object.entries(defs);
  return entries.filter(([, def]) => def.statuses?.length && def.permission && canView(def.permission))
    .map(([entity, def]) => ({ entity, label: def.label || label(entity), statuses: def.statuses }));
}

export function entityFilterVisibility(kind) {
  const registrationLinked = ['registrations', 'approvals', 'enquiries', 'followups', 'invoices', 'funding'].includes(kind);
  const deadline = ['registrations', 'enquiries', 'mappings', 'followups', 'invoices', 'funding', 'tasks'].includes(kind);
  if (kind === 'dashboard') return {};
  return { vendorCode: registrationLinked, enquiryReceived: registrationLinked,
    sector: !['accounts', 'tasks'].includes(kind), tredsStatus: !['accounts', 'tasks'].includes(kind),
    platform: kind !== 'tasks', deadline };
}

export function choice(value) {
  return typeof value === 'object' && value !== null
    ? { value: value.value ?? value.code ?? value.id ?? value.key, label: value.label ?? value.name ?? value.title ?? label(value.code ?? value.id) }
    : { value, label: label(value) };
}

export function money(value, paise = false) {
  if (value === '' || value == null || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(value) / (paise ? 100 : 1));
}

export function errorMessage(error) {
  const body = error?.response?.data;
  return body?.error || body?.message || error?.message || 'Unable to complete this action.';
}

export function filterParams(filters) {
  return Object.fromEntries(Object.entries(filters || {}).filter(([, value]) => value !== '' && value != null));
}

export function recordLabel(row) {
  return row.label || row.company_name || row.client_name || row.invoice_number || row.rfq_number || row.title || row.name || row.code || `Record #${row.id}`;
}

export function recordStatusLabel(kind, row) {
  return kind === 'invoices' && row.status === 'uploaded' && !row.uploaded_at ? 'Awaiting invoice PDF' : undefined;
}

export function isPaise(field) {
  return field.type === 'money_paise' || field.unit === 'paise' || /_paise$/.test(field.key || '');
}

export function downloadBlob(data, filename) {
  const url = URL.createObjectURL(data);
  const anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename;
  document.body.appendChild(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function contentFilename(response, fallback) {
  const header = response.headers?.['content-disposition'] || '';
  const match = header.match(/filename\*?=(?:UTF-8''|")?([^";]+)/i);
  if (!match) return fallback;
  try { return decodeURIComponent(match[1]); } catch { return match[1]; }
}
