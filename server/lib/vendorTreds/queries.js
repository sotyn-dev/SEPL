// All lists, aggregates and exports share these predicates. User filters only narrow scope.
const {ENTITY_DEFS}=require('./model');
const isoDate = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const dateOnly = expression => `date(${expression})`;
const istDay = expression => `date(${expression}, '+5 hours', '+30 minutes')`;
const COMMON_DATES = { created_at: 't.created_at', updated_at: 't.updated_at' };
const REGISTRATION_STAGE = "CASE WHEN t.status IN ('enquiry_received','quote_sent','po_received') THEN 4 WHEN t.status='approved' THEN 3 WHEN t.status IN ('started','submitted','docs_pending') THEN 2 ELSE 1 END";
const CANONICAL_WARNING = 'The ERP invoice amount or date differs from the recorded snapshot. Historical totals retain the snapshot; resolve the discrepancy before financial actions.';
function canonicalProjection(invoiceAlias) {
  const amount = 'CAST(ROUND(sb.total_amount*100) AS INTEGER)';
  const mismatch = `(sb.id IS NULL OR ${amount} IS NOT ${invoiceAlias}.amount_paise OR sb.bill_date IS NOT ${invoiceAlias}.invoice_date)`;
  return `${amount} AS canonical_amount_paise, sb.bill_date AS canonical_invoice_date,
    CASE WHEN ${mismatch} THEN 1 ELSE 0 END AS canonical_mismatch,
    CASE WHEN ${mismatch} THEN '${CANONICAL_WARNING}' ELSE NULL END AS canonical_warning`;
}
const base = (table, extra = {}) => ({
  table, alias: 't', owner: 't.owner_id', customer: 't.customer_id',
  registration: 't.registration_id', platform: null,
  joins: 'LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.owner_id',
  select: 't.*, c.company_name, c.sector, u.name AS owner_name',
  search: ['c.company_name', 't.remarks'], dates: COMMON_DATES,
  defaultDate: 'created_at', stages: {}, ...extra,
});
const ENTITIES = {
  catalog: base('vt_catalog', { owner: null, customer: null, registration: null, platform: null,
    joins: '', select: 't.*', search: ['t.label','t.code'], metadata: true }),
  registrations: base('vt_registrations', {
    registration: 't.id', search: ['c.company_name', 't.portal_url', 't.remarks'],
    dates: { ...COMMON_DATES, registration_date: 't.registration_date', submitted_at: 't.submitted_at', next_followup_at: 't.next_followup_at',
      approval_date: `(SELECT MIN(va.approval_date) FROM vt_approvals va WHERE va.registration_id=t.id AND va.status='approved' AND TRIM(COALESCE(va.vendor_code,''))<>'')` },
    defaultDate: 'registration_date', stages: { registered: 'registration_date', submitted: 'submitted_at', approved: 'approval_date' },
    select: `t.*, c.company_name, c.sector, c.website_url, u.name AS owner_name, ${REGISTRATION_STAGE} AS workflow_stage,
      (SELECT COUNT(*) FROM vt_enquiries e WHERE e.registration_id=t.id) AS enquiry_count,
      (SELECT MAX(a.approval_date) FROM vt_approvals a WHERE a.registration_id=t.id AND a.status='approved') AS accepted_date,
      (SELECT a.vendor_code FROM vt_approvals a WHERE a.registration_id=t.id
        AND a.status='approved' AND TRIM(COALESCE(a.vendor_code,''))<>'' ORDER BY a.approval_date DESC,a.id DESC LIMIT 1) AS vendor_code,
      (SELECT ve.status FROM vt_enquiries ve WHERE ve.registration_id=t.id
        ORDER BY ve.enquiry_date DESC,ve.id DESC LIMIT 1) AS enquiry_status,
      (SELECT GROUP_CONCAT(pp.label || ': ' || COALESCE(NULLIF(aa.account_status,''),aa.status,'mapped'), ', ')
        FROM vt_mappings mm JOIN vt_catalog pp ON pp.id=mm.platform_id LEFT JOIN vt_accounts aa ON aa.id=mm.account_id
        WHERE mm.customer_id=t.customer_id) AS treds_status`,
  }),
  approvals: base('vt_approvals', {
    customer: 'r.customer_id', joins: 'JOIN vt_registrations r ON r.id=t.registration_id LEFT JOIN customers c ON c.id=r.customer_id LEFT JOIN users u ON u.id=t.owner_id',
    search: ['c.company_name', 't.vendor_code', 't.remarks'],
    dates: { ...COMMON_DATES, application_date: 't.application_date', approval_date: 't.approval_date', valid_until: 't.valid_until' },
    defaultDate: 'application_date', stages: { approved: 'approval_date', applied: 'application_date' },
  }),
  enquiries: base('vt_enquiries', {
    search: ['c.company_name', 't.rfq_number', 't.product_service', 't.remarks'],
    dates: { ...COMMON_DATES, enquiry_date: 't.enquiry_date', due_date: 't.due_date', next_followup_at: 't.next_followup_at',
      po_received_at: `(SELECT MIN(h.changed_at) FROM vt_history h WHERE h.entity_type='enquiries' AND h.entity_id=t.id AND h.new_status='po_received')` },
    defaultDate: 'enquiry_date', stages: { received: 'enquiry_date', po_received: 'po_received_at' },
  }),
  accounts: base('vt_accounts', {
    customer: null, registration: null, platform: 't.platform_id',
    joins: 'LEFT JOIN vt_catalog p ON p.id=t.platform_id LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN vendors v ON v.id=t.vendor_id',
    select: 't.*, p.label AS platform_name, u.name AS owner_name, v.name AS vendor_name',
    search: ['p.label', 't.login_id', 't.remarks'],
    dates: { ...COMMON_DATES, registration_date: 't.registration_date', last_verified_date: 't.last_verified_date' }, defaultDate: 'registration_date',
  }),
  mappings: base('vt_mappings', {
    registration: null, platform: 't.platform_id',
    joins: 'LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN vt_catalog p ON p.id=t.platform_id LEFT JOIN vt_contacts ct ON ct.id=t.contact_id',
    select: 't.*, c.company_name, c.sector, u.name AS owner_name, p.label AS platform_name, ct.name AS contact_name, ct.email AS contact_email, ct.phone AS contact_phone',
    dates: { ...COMMON_DATES, last_contact_at: 't.last_contact_at', next_followup_at: 't.next_followup_at' }, stages: { contacted: 'last_contact_at' },
  }),
  invoices: base('vt_invoices', {
    platform: 't.platform_id',
    joins: 'LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN vt_catalog p ON p.id=t.platform_id LEFT JOIN vt_funding f ON f.invoice_id=t.id LEFT JOIN sales_bills sb ON sb.id=t.sales_bill_id',
    select: `t.*, c.company_name, c.sector, u.name AS owner_name, p.label AS platform_name, ${canonicalProjection('t')}`,
    search: ['c.company_name', 't.external_invoice_number', 't.po_number', 't.remarks'],
    dates: { ...COMMON_DATES, invoice_date: 't.invoice_date', due_date: 't.due_date', uploaded_at: 't.uploaded_at', accepted_at: 't.accepted_at', bid_at: 't.bid_at', funded_at: 't.funded_at' },
    defaultDate: 'invoice_date', stages: { uploaded: 'uploaded_at', accepted: 'accepted_at', bid: 'bid_at', funded: 'funded_at' },
  }),
  funding: base('vt_funding', {
    customer: 'i.customer_id', registration: 'i.registration_id', platform: 'i.platform_id',
    joins: 'JOIN vt_invoices i ON i.id=t.invoice_id LEFT JOIN customers c ON c.id=i.customer_id LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN vt_catalog p ON p.id=i.platform_id LEFT JOIN sales_bills sb ON sb.id=i.sales_bill_id',
    select: `t.*, c.company_name, c.sector, u.name AS owner_name, p.label AS platform_name,
      i.platform_id, i.customer_id, i.registration_id, i.external_invoice_number,
      i.invoice_date, i.due_date, i.amount_paise AS invoice_amount_paise,
      i.uploaded_at, i.accepted_at, i.bid_at, ${canonicalProjection('i')},
      CASE WHEN i.uploaded_at IS NOT NULL AND t.funded_at IS NOT NULL
        THEN (julianday(t.funded_at)-julianday(i.uploaded_at)) ELSE NULL END AS funding_days`,
    search: ['c.company_name', 'i.external_invoice_number', 't.bank_reference', 't.remarks'],
    dates: { ...COMMON_DATES, invoice_date: 'i.invoice_date', due_date: 'i.due_date', uploaded_at: 'i.uploaded_at', accepted_at: 'i.accepted_at', bid_at: 'i.bid_at', approved_at: 't.approved_at', funded_at: 't.funded_at', reconciled_at: 't.reconciled_at', closed_at: 't.closed_at', expected_settlement: 't.expected_settlement' },
    defaultDate: 'created_at', stages: { uploaded: 'uploaded_at', accepted: 'accepted_at', bid: 'bid_at', approved: 'approved_at', funded: 'funded_at', reconciled: 'reconciled_at', closed: 'closed_at' },
  }),
  contacts: base('vt_contacts', { registration: null, search: ['c.company_name', 't.name', 't.email', 't.phone', 't.remarks'] }),
  followups: base('vt_followups', {
    customer: 'COALESCE(e.customer_id,m.customer_id,r.customer_id)', registration: 'COALESCE(t.registration_id,e.registration_id)', platform: 'm.platform_id',
    joins: `LEFT JOIN vt_enquiries e ON e.id=t.enquiry_id LEFT JOIN vt_mappings m ON m.id=t.mapping_id
      LEFT JOIN vt_registrations r ON r.id=t.registration_id
      LEFT JOIN customers c ON c.id=COALESCE(e.customer_id,m.customer_id,r.customer_id)
      LEFT JOIN users u ON u.id=t.owner_id LEFT JOIN vt_catalog p ON p.id=m.platform_id`,
    select: `t.*, c.company_name, c.sector, u.name AS owner_name, m.platform_id, p.label AS platform_name,
      CASE WHEN t.completed_at IS NOT NULL THEN 'completed' ELSE 'pending' END AS status`,
    status: "CASE WHEN t.completed_at IS NOT NULL THEN 'completed' ELSE 'pending' END",
    search: ['c.company_name', 't.notes'],
    dates: { ...COMMON_DATES, contact_at: 't.contact_at', next_followup_at: 't.next_followup_at', reminder_at: 't.reminder_at', completed_at: 't.completed_at' },
    defaultDate: 'contact_at', stages: { contacted: 'contact_at', completed: 'completed_at' },
  }),
  tasks: base('vt_task_links', {
    owner: 'w.user_id', registration: 't.registration_id',
    joins: `JOIN daily_work_plans w ON w.id=t.daily_work_plan_id
      LEFT JOIN pms_tasks pt ON w.source='pms_tasks' AND pt.id=w.source_id
      LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN users u ON u.id=w.user_id`,
    select: 't.*, w.user_id AS owner_id, u.name AS owner_name, c.company_name, c.sector, w.work_date AS due_date, w.priority, w.state AS status, w.blocker, w.instructions, w.started_at, pt.title, pt.description, pt.reviewed_at AS completed_at',
    status: 'w.state', search: ['c.company_name', 'w.instructions', 'pt.description', 'pt.title'],
    dates: { ...COMMON_DATES, work_date: 'w.work_date', due_date: 'w.work_date', started_at: 'w.started_at', completed_at: 'pt.reviewed_at' }, defaultDate: 'work_date',
  }),
};

function idValue(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error(`${field} must be a positive integer`);
  return id;
}
function scopeIds(scope) {
  const ids = scope && !Array.isArray(scope) ? scope.ownerIds : scope;
  if (ids === null) return null;
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map(id => idValue(id, 'owner scope')))];
}
function flag(value) {
  if ([true, 1, '1', 'true', 'yes'].includes(value)) return true;
  if ([false, 0, '0', 'false', 'no'].includes(value)) return false;
  throw new Error('Boolean filter must be true or false');
}
function buildQueryUnchecked(kind, filters = {}, scope) {
  const def = ENTITIES[kind];
  if (!def) throw new Error('Unknown Vendor & TReDS entity');
  const predicates = ['1=1']; const params = [];
  const add = (sql, ...values) => { predicates.push(sql); params.push(...values); };
  const owners = scopeIds(scope);
  if (owners !== null) {
    if (owners.length && def.owner) add(`${def.owner} IN (${owners.map(() => '?').join(',')})`, ...owners);
    else if (owners.length && def.metadata) { /* Actor's catalog permission is checked by the router. */ }
    else add('0=1');
  }
  if (filters.owner_id !== undefined && filters.owner_id !== '') {
    if (!def.owner && !def.metadata) throw new Error('This entity has no owner filter');
    if (def.owner) add(`${def.owner}=?`, idValue(filters.owner_id, 'owner_id'));
  }
  if (kind === 'catalog') {
    if (filters.kind) {
      if (!['platform','doc_type','sector','service'].includes(filters.kind)) throw new Error('Invalid catalog kind');
      add('t.kind=?', filters.kind);
    }
    if (filters.active !== undefined && filters.active !== '') add('t.active=?', flag(filters.active) ? 1 : 0);
  }
  if (filters.customer_id !== undefined && filters.customer_id !== '') {
    const id = idValue(filters.customer_id, 'customer_id');
    if (def.customer) add(`${def.customer}=?`, id);
    else if (kind === 'accounts') add('EXISTS(SELECT 1 FROM vt_mappings mm WHERE mm.account_id=t.id AND mm.customer_id=?)', id);
    else add('0=1');
  }
  if (filters.registration_id !== undefined && filters.registration_id !== '') {
    if (def.registration) add(`${def.registration}=?`, idValue(filters.registration_id, 'registration_id'));
    else add('0=1');
  }
  if (filters.platform_id !== undefined && filters.platform_id !== '') {
    const id = idValue(filters.platform_id, 'platform_id');
    if (def.platform) add(`${def.platform}=?`, id);
    else if (def.customer) add(`EXISTS(SELECT 1 FROM vt_mappings mm WHERE mm.customer_id=${def.customer} AND mm.platform_id=?)`, id);
    else add('0=1');
  }
  const statusExpression = def.status || (['contacts', 'mappings', 'catalog'].includes(kind) ? null : 't.status');
  if(kind==='registrations'&&filters.workflow_stage!=null&&filters.workflow_stage!=='') {
    const stage=Number(filters.workflow_stage);
    if(![1,2,3,4].includes(stage))throw new Error('Invalid registration stage');
    add(`${REGISTRATION_STAGE}=?`,stage);
  }
  if (filters.status !== undefined && filters.status !== '') {
    if (!statusExpression) throw new Error('This entity has no status filter');
    const statuses = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (statuses.length > 30) throw new Error('Too many status filters');
    const choices = kind === 'followups' ? ['pending','completed'] : kind === 'tasks' ? ['planned','running','paused','blocked','cancelled','completed'] : ENTITY_DEFS[kind]?.statuses;
    if (statuses.some(value => typeof value !== 'string' || value.length > 100 || (choices && !choices.includes(value)))) throw new Error('Invalid status filter');
    if (!statuses.length) add('0=1');
    else add(`${statusExpression} IN (${statuses.map(() => '?').join(',')})`, ...statuses);
  }
  if (filters.account_status && kind === 'accounts') add('t.account_status=?', String(filters.account_status));
  if (filters.effective_account_status && kind === 'accounts') add("COALESCE(NULLIF(t.account_status,''),t.status)=?", String(filters.effective_account_status));
  if (filters.contact_kind && kind === 'contacts') add('t.kind=?', String(filters.contact_kind));
  if (filters.acceptance_confirmed !== undefined && filters.acceptance_confirmed !== '' && kind === 'mappings') add('t.acceptance_confirmed=?', flag(filters.acceptance_confirmed) ? 1 : 0);
  if (filters.invoice_id !== undefined && filters.invoice_id !== '' && kind === 'funding') add('t.invoice_id=?', idValue(filters.invoice_id, 'invoice_id'));
  if (filters.pending_funding !== undefined && kind === 'invoices' && flag(filters.pending_funding)) add("t.status NOT IN ('cancelled','rejected') AND COALESCE(f.actual_received_paise,0)=0");
  if (filters.known_funding_time !== undefined && kind === 'funding' && flag(filters.known_funding_time)) add('i.uploaded_at IS NOT NULL AND t.funded_at IS NOT NULL AND julianday(t.funded_at)>=julianday(i.uploaded_at)');
  if (filters.known_discount_rate !== undefined && kind === 'funding' && flag(filters.known_discount_rate)) add('t.discount_rate IS NOT NULL AND t.basis IS NOT NULL AND t.principal_paise>0');
  if (filters.documents_pending !== undefined && kind === 'registrations') {
    const incomplete = `EXISTS(SELECT 1 FROM vt_catalog dc WHERE dc.kind='doc_type' AND dc.active=1 AND dc.required=1
      AND NOT EXISTS(SELECT 1 FROM vt_documents vd WHERE vd.registration_id=t.id AND vd.type_id=dc.id
        AND vd.status IN ('uploaded','verified') AND (vd.expiry_date IS NULL OR vd.expiry_date>=?)))`;
    const asOf = filters.as_of || new Date(Date.now()+19800000).toISOString().slice(0,10);
    if (!isoDate(asOf)) throw new Error('Invalid document-check date');
    add(flag(filters.documents_pending) ? incomplete : `NOT (${incomplete})`, asOf);
  }
  if (filters.sector !== undefined && filters.sector !== '') {
    if (def.customer) add('c.sector=?', String(filters.sector)); else add('0=1');
  }
  if (filters.source && kind === 'registrations') add('t.source=?', String(filters.source));
  if (filters.is_mnc !== undefined && filters.is_mnc !== '' && kind === 'enquiries') add('t.is_mnc=?', flag(filters.is_mnc) ? 1 : 0);
  if (filters.mapping_contacts !== undefined && filters.mapping_contacts !== '' && kind === 'followups') {
    add(flag(filters.mapping_contacts) ? 't.mapping_id IS NOT NULL' : 't.mapping_id IS NULL');
  }
  if (filters.vendor_code !== undefined && filters.vendor_code !== '') {
    const exists = def.registration ? `EXISTS(SELECT 1 FROM vt_approvals va WHERE va.registration_id=${def.registration} AND va.status='approved' AND TRIM(COALESCE(va.vendor_code,''))<>'')` : '0';
    if (['available', 'missing', true, false, 1, 0, '1', '0', 'true', 'false'].includes(filters.vendor_code)) {
      const available = filters.vendor_code === 'available' || (filters.vendor_code !== 'missing' && flag(filters.vendor_code));
      add(available ? exists : `NOT (${exists})`);
    } else if (def.registration) add(`EXISTS(SELECT 1 FROM vt_approvals va WHERE va.registration_id=${def.registration} AND va.vendor_code=?)`, String(filters.vendor_code));
    else add('0=1');
  }
  if (filters.enquiry_received !== undefined && filters.enquiry_received !== '') {
    const exists = def.registration ? `EXISTS(SELECT 1 FROM vt_enquiries ve WHERE ve.registration_id=${def.registration})` : '0';
    add(flag(filters.enquiry_received) ? exists : `NOT (${exists})`);
  }
  if (filters.treds_status && def.customer) add(`EXISTS(SELECT 1 FROM vt_mappings mm JOIN vt_accounts aa ON aa.id=mm.account_id WHERE mm.customer_id=${def.customer} AND aa.status=?)`, String(filters.treds_status));
  if (filters.search) {
    const term = String(filters.search).trim().slice(0, 300);
    if (term) add(`(${def.search.map(expression => `COALESCE(${expression},'') LIKE ? ESCAPE '\\'`).join(' OR ')})`, ...def.search.map(() => `%${term.replace(/[\\%_]/g, match => '\\' + match)}%`));
  }
  let stageField = null;
  if (filters.stage_event) {
    stageField = def.stages[filters.stage_event];
    if (!stageField) throw new Error('Invalid stage event');
    add(`${def.dates[stageField]} IS NOT NULL`);
    if (filters.stage_event === 'approved' && kind === 'approvals') add("t.status='approved'");
    if (filters.stage_event === 'funded') {
      if (kind === 'funding') add('t.actual_received_paise>0');
      else if (kind === 'invoices') add('f.actual_received_paise>0');
    }
  }
  const dateField = filters.date_field || stageField || def.defaultDate;
  if (!Object.hasOwn(def.dates, dateField)) throw new Error('Invalid date field');
  const dateExpression = dateField.endsWith('_at') ? istDay(def.dates[dateField]) : dateOnly(def.dates[dateField]);
  const from = filters.date_from || filters.datefrom;
  const to = filters.date_to || filters.dateto;
  if (from) { if (!isoDate(from)) throw new Error('Invalid date_from'); add(`${dateExpression}>=?`, from); }
  if (to) { if (!isoDate(to)) throw new Error('Invalid date_to'); add(`${dateExpression}<=?`, to); }
  if (from && to && from > to) throw new Error('Date range is reversed');
  if (filters.overdue_as_of) {
    if (!isoDate(filters.overdue_as_of)) throw new Error('Invalid overdue date');
    const dueField = ['followups', 'mappings', 'registrations', 'enquiries'].includes(kind) ? 'next_followup_at' : kind === 'funding' ? 'expected_settlement' : 'due_date';
    if (!def.dates[dueField]) throw new Error('This entity has no follow-up deadline');
    add(`${dueField.endsWith('_at') ? istDay(def.dates[dueField]) : dateOnly(def.dates[dueField])}<?`, filters.overdue_as_of);
    if (kind === 'followups') add('t.completed_at IS NULL');
  }
  const sorts = { id: 't.id', created_at: 't.created_at', updated_at: 't.updated_at', date: dateExpression };
  if (def.owner) sorts.owner_name = 'u.name';
  if (kind === 'catalog') { sorts.label = 't.label'; sorts.code = 't.code'; }
  if (statusExpression) sorts.status = statusExpression;
  if (def.customer) sorts.company_name = 'c.company_name';
  if (def.platform) sorts.platform_name = 'p.label';
  if (kind === 'invoices') sorts.amount_paise = 't.amount_paise';
  if (kind === 'enquiries') sorts.expected_amount_paise = 't.expected_amount_paise';
  if (kind === 'funding') { sorts.actual_received_paise = 't.actual_received_paise'; sorts.principal_paise = 't.principal_paise'; }
  const sort = filters.sort_by || filters.sort || 'id';
  if (!Object.hasOwn(sorts, sort)) throw new Error('Invalid sort field');
  const direction = String(filters.sort_dir || filters.direction || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(direction)) throw new Error('Invalid sort direction');
  const fromSql = `FROM ${def.table} t ${def.joins}`;
  const where = `WHERE ${predicates.join(' AND ')}`;
  const order = `ORDER BY ${sorts[sort]} ${direction.toUpperCase()}, t.id ${direction.toUpperCase()}`;
  return { kind, table: def.table, alias: 't', select: def.select, from: fromSql, where, params, order, dateExpression,
    sql: `SELECT ${def.select} ${fromSql} ${where} ${order}`,
    countSql: `SELECT COUNT(*) AS total ${fromSql} ${where}` };
}
function buildQuery(kind, filters = {}, scope) {
  try { return buildQueryUnchecked(kind, filters, scope); }
  catch (error) { if (!error.status) error.status=400; throw error; }
}
function filterClause(kind, filters = {}, scope) {
  const query = buildQuery(kind, filters, scope);
  return { sql: query.where, where: query.where, params: query.params, from: query.from, alias: 't' };
}
function listEntity(db, kind, filters = {}, scope) {
  const query = buildQuery(kind, filters, scope);
  const page = Math.max(1, Math.min(1000000, Math.floor(Number(filters.page) || 1)));
  const limit = Math.max(1, Math.min(200, Math.floor(Number(filters.limit) || 25)));
  const total = db.prepare(query.countSql).get(...query.params).total;
  const rows = db.prepare(`${query.sql} LIMIT ? OFFSET ?`).all(...query.params, limit, (page - 1) * limit);
  return { rows, total, page, limit };
}

// The router calls this after authorizing the detail record. Lists use the same
// projection in their single SQL query, so linked invoices never add an N+1 read.
function canonicalInvoiceWarning(db, invoiceId) {
  const id = idValue(invoiceId, 'invoice_id');
  return db.prepare(`SELECT ${canonicalProjection('i')} FROM vt_invoices i
    LEFT JOIN sales_bills sb ON sb.id=i.sales_bill_id WHERE i.id=?`).get(id) || null;
}

module.exports = { REGISTRATION_STAGE, ENTITIES, CANONICAL_WARNING, isoDate, istDay, scopeIds, buildQuery, filterClause, listEntity, canonicalInvoiceWarning };
