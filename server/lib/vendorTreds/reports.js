const { buildQuery, listEntity, isoDate } = require('./queries');
const { getConfig, weekPeriod, istToday, getWeeklyKpis, scopeFor, commonFilters } = require('./kpis');

const REPORT_CATALOG = [
  { key: 'daily_registrations', label: 'Daily Vendor Registration Report', entity: 'registrations' },
  { key: 'weekly_registrations', label: 'Weekly Vendor Registration Report', entity: 'registrations' },
  { key: 'vendor_approvals', label: 'Vendor Approval Report', entity: 'approvals' },
  { key: 'vendor_codes', label: 'Vendor Code Report', entity: 'registrations' },
  { key: 'enquiries', label: 'Enquiry / RFQ Report', entity: 'enquiries' },
  { key: 'po_conversion', label: 'PO Conversion Report', entity: 'enquiries' },
  { key: 'treds_registration', label: 'TReDS Registration Report', entity: 'accounts' },
  { key: 'invoice_uploads', label: 'Invoice Upload Report', entity: 'invoices' },
  { key: 'funding', label: 'Funding Report', entity: 'funding' },
  { key: 'pending_followups', label: 'Pending Follow-up Report', entity: 'followups' },
  { key: 'weekly_kpi_scorecard', label: 'Weekly KPI Scorecard', entity: 'dashboard' },
];
const column = (key, label, type = 'text') => ({ key, label, type });
const SHARED = [column('id', 'Record #', 'number'), column('company_name', 'Company / Client'), column('owner_name', 'Owner'), column('created_at', 'Recorded At (UTC)', 'datetime')];
const CANONICAL = [column('canonical_amount_paise', 'Current ERP Invoice Amount (₹)', 'paise'), column('canonical_invoice_date', 'Current ERP Invoice Date', 'date'), column('canonical_warning', 'Canonical Invoice Warning')];
const COLUMNS = {
  registrations: [...SHARED, column('sector', 'Sector'), column('registration_date', 'Registration Business Date', 'date'), column('status', 'Status'), column('vendor_code', 'Vendor Code'), column('enquiry_status', 'Latest Enquiry Status'), column('treds_status', 'TReDS Platform Status'), column('source', 'Source'), column('last_followup_at', 'Last Follow-up', 'datetime'), column('next_followup_at', 'Next Follow-up', 'datetime')],
  approvals: [...SHARED, column('application_date', 'Application Date', 'date'), column('status', 'Status'), column('vendor_code', 'Vendor Code'), column('approval_date', 'Approval Date', 'date'), column('valid_until', 'Valid Till', 'date')],
  enquiries: [...SHARED, column('rfq_number', 'RFQ #'), column('product_service', 'Product / Service'), column('enquiry_date', 'Enquiry Date', 'date'), column('expected_amount_paise', 'Expected Value (₹)', 'paise'), column('due_date', 'Due Date', 'date'), column('status', 'Status'), column('is_mnc', 'MNC', 'boolean')],
  accounts: [column('id', 'Record #', 'number'), column('platform_name', 'Platform'), column('vendor_name', 'Vendor'), column('owner_name', 'Owner'), column('registration_date', 'Registration Date', 'date'), column('status', 'Registration Status'), column('account_status', 'Account Status'), column('last_verified_date', 'Last Verified', 'date')],
  invoices: [...SHARED, column('external_invoice_number', 'Invoice #'), column('po_number', 'PO #'), column('invoice_date', 'Invoice Date', 'date'), column('amount_paise', 'Invoice Amount (₹)', 'paise'), column('platform_name', 'Platform'), column('uploaded_at', 'Uploaded', 'datetime'), column('accepted_at', 'Accepted', 'datetime'), column('bid_at', 'Bid Received', 'datetime'), column('funded_at', 'Funded', 'datetime'), column('status', 'Status')],
  funding: [...SHARED, column('external_invoice_number', 'Invoice #'), column('invoice_date', 'Invoice Date', 'date'), column('invoice_amount_paise', 'Invoice Face Value (₹)', 'paise'), column('platform_name', 'Platform'), column('uploaded_at', 'Uploaded', 'datetime'), column('accepted_at', 'Accepted', 'datetime'), column('bid_at', 'Bid Received', 'datetime'), column('approved_at', 'Funding Approved', 'datetime'), column('funded_at', 'Funded', 'datetime'), column('principal_paise', 'Financed Principal (₹)', 'paise'), column('discount_rate', 'Discount Rate (%)', 'number'), column('basis', 'Rate Basis'), column('term_days', 'Tenor (Days)', 'number'), column('day_basis', 'Day Count', 'number'), column('discount_paise', 'Discount (₹)', 'paise'), column('fees_paise', 'Fees (₹)', 'paise'), column('taxes_paise', 'Taxes (₹)', 'paise'), column('expected_net_paise', 'Expected Net Proceeds (₹)', 'paise'), column('actual_received_paise', 'Actual Amount Received (₹)', 'paise'), column('expected_settlement', 'Expected Settlement', 'date'), column('bank_reference', 'Bank Reference'), column('status', 'Status')],
  followups: [...SHARED, column('contact_at', 'Contact Date', 'datetime'), column('next_followup_at', 'Next Follow-up', 'datetime'), column('notes', 'Notes'), column('reminder_at', 'Reminder', 'datetime'), column('completed_at', 'Completed', 'datetime'), column('status', 'Status')],
  dashboard: [column('label', 'KPI'), column('target', 'Target', 'metric'), column('actual', 'Actual', 'metric'), column('unit', 'Unit'), column('achievement_pct', 'Achievement %', 'number'), column('status', 'Status'), column('definition', 'Definition')],
};

function reportDefinition(key) {
  const report = REPORT_CATALOG.find(item => item.key === key);
  if (!report) { const error = new Error('Unknown report'); error.status = 404; throw error; }
  return report;
}
function reportFilters(db, report, filters = {}) {
  const result = { ...filters };
  // A report uses the same entity-specific dashboard cohort. Qualified status
  // filters for another entity and unsupported deadlines never reach its SQL.
  for (const key of ['status','status_entity','source','overdue_as_of']) delete result[key];
  Object.assign(result,commonFilters(filters,report.entity));
  const today = filters.as_of || istToday();
  if (!isoDate(today)) { const error = new Error('Invalid report date'); error.status = 400; throw error; }
  if (report.key === 'daily_registrations') {
    result.date_from = filters.date_from || today; result.date_to = filters.date_to || result.date_from;
    result.stage_event = 'registered'; result.date_field = 'registration_date';
  }
  if (report.key === 'weekly_registrations') {
    const reference = filters.week_start || filters.date_from || today;
    const period = weekPeriod(reference, getConfig(db, reference));
    result.date_from = filters.date_from || period.date_from; result.date_to = filters.date_to || period.date_to;
    result.stage_event = 'registered'; result.date_field = 'registration_date';
  }
  if (report.key === 'vendor_codes') { result.vendor_code = 'available'; result.stage_event = 'approved'; result.date_field = 'approval_date'; }
  if (report.key === 'po_conversion') { result.stage_event = 'po_received'; result.date_field = 'po_received_at'; }
  if (report.key === 'invoice_uploads') { result.stage_event = 'uploaded'; result.date_field = 'uploaded_at'; }
  if (report.key === 'funding' && !filters.date_field && !filters.stage_event) result.date_field = 'funded_at';
  if (report.key === 'pending_followups') {
    result.status = 'pending'; result.date_field = filters.date_field || 'next_followup_at';
    if (filters.overdue) result.overdue_as_of = today;
  }
  return result;
}
function reportRows(db, key, filters = {}, scope, options = {}) {
  const report = reportDefinition(key);
  if (report.entity === 'dashboard') {
    const kpis = getWeeklyKpis(db, filters, scope, options);
    return { report, columns: COLUMNS.dashboard, rows: kpis.rows, total: kpis.rows.length, page: 1, limit: kpis.rows.length,
      filters: { ...filters, ...kpis.period }, definition: 'Automatically computed transactional KPIs. Targets use the settings version effective at the beginning of the reporting period.' };
  }
  const cohort = reportFilters(db, report, filters);
  const entityScope = scopeFor(report.entity, scope, options);
  const all = options.all === true || filters.all === true || filters.all === '1';
  let data;
  if (all) {
    const query = buildQuery(report.entity, cohort, entityScope);
    const total = db.prepare(query.countSql).get(...query.params).total;
    const cap = Math.min(10000, Number(options.maxRows) || 10000);
    if (total > cap) { const error = new Error(`This report exceeds ${cap.toLocaleString()} rows. Narrow the filters before exporting.`); error.status = 413; throw error; }
    data = { rows: db.prepare(query.sql).all(...query.params), total, page: 1, limit: cap };
  } else data = listEntity(db, report.entity, cohort, entityScope);
  const columns = ['invoices','funding'].includes(report.entity) ? [...COLUMNS[report.entity],...CANONICAL] : COLUMNS[report.entity];
  return { report, columns, ...data, filters: cohort,
    definition: report.key === 'funding' ? 'Actual receipts, financed principal, invoice face value and expected proceeds are separate; blank financial terms remain unknown.' : report.key === 'po_conversion' ? 'One enquiry per first recorded PO-received transition.' : undefined };
}
async function exportXlsx(db, key, filters = {}, scope, options = {}) {
  const payload = reportRows(db, key, filters, scope, { ...options, all: true });
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'Secured Engineers ERP'; workbook.created = new Date();
  const sheet = workbook.addWorksheet(payload.report.label.slice(0, 31));
  sheet.columns = payload.columns.map(item => ({ key: item.key, header: item.label, width: item.key === 'definition' ? 60 : item.type === 'text' ? 26 : 20 }));
  for (const row of payload.rows) {
    const output = {};
    for (const item of payload.columns) {
      const value = row[item.key];
      const monetary = item.type === 'paise' || (item.type === 'metric' && row.unit === 'paise');
      output[item.key] = value === undefined || value === null ? null : monetary ? value / 100 : item.type === 'boolean' ? value ? 'Yes' : 'No' : value;
    }
    const added = sheet.addRow(output);
    payload.columns.forEach((item, index) => {
      if (item.type === 'paise' || (item.type === 'metric' && row.unit === 'paise')) added.getCell(index + 1).numFmt = '"₹" #,##0.00';
      else if (item.type === 'number' || item.type === 'metric') added.getCell(index + 1).numFmt = '#,##0.00';
    });
  }
  sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
  sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF17365D' } };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: Math.max(1, sheet.rowCount), column: payload.columns.length } };
  sheet.eachRow(row => { row.alignment = { vertical: 'top', wrapText: true }; });
  sheet.pageSetup = { orientation: 'landscape', paperSize: 9, fitToPage: true, fitToWidth: 1, fitToHeight: 0 };
  const metadata = workbook.addWorksheet('Report Filters');
  metadata.columns = [{ header: 'Field', key: 'field', width: 30 }, { header: 'Value', key: 'value', width: 65 }];
  metadata.addRow({ field: 'Report', value: payload.report.label });
  metadata.addRow({ field: 'Generated at UTC', value: new Date().toISOString() });
  metadata.addRow({ field: 'Rows', value: payload.total });
  for (const [field, value] of Object.entries(payload.filters)) if (!['page', 'limit', 'all'].includes(field)) metadata.addRow({ field, value: typeof value === 'object' ? JSON.stringify(value) : String(value) });
  if (payload.definition) metadata.addRow({ field: 'Definition', value: payload.definition });
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

module.exports = { REPORT_CATALOG, COLUMNS, reportDefinition, reportFilters, reportRows, exportXlsx };
