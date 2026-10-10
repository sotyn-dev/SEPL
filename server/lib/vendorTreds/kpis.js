const { buildQuery, listEntity, isoDate, scopeIds, istDay } = require('./queries');
const { ENTITY_DEFS, normalizeKind } = require('./model');
const SETTINGS_KEY = 'vendor_treds_settings';
const TRACKER_DEFINITION = 'Dated registration, approval, enquiry, account, invoice, funding and contact-follow-up create/status events, recorded on the same IST calendar date as the business event. Remarks-only updates are excluded. Events are scoped to the current record owner.';
const addDays = (date, days) => new Date(Date.parse(date + 'T00:00:00Z') + days * 86400000).toISOString().slice(0, 10);
const istToday = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const clone = value => JSON.parse(JSON.stringify(value));
function badRequest(message) { const error = new Error(message); error.status = 400; return error; }

function getDefaultConfig() {
  return { versions: [{ effective_from: '1970-01-01', program_start_date: null, week_start: 1,
    working_days: [1, 2, 3, 4, 5, 6], responsible_owner_ids: [], owner_overrides: {},
    reminders: { enabled: true, expiry_lead_days: 7, pending_after_days: 2, repeat_days: 1, scan_minutes: 15 },
    targets: { registrations_daily: 10, registrations_weekly: 60, mnc_enquiries_weekly: 1,
      tracker_same_day_percent: 100, ap_contacts: { weeks_1_2: 10, week_3_onward: 5 },
      invoices_uploaded: { weeks_1_2: 3, week_3_onward: 5 },
      invoice_value_paise: { weeks_1_2: 100000000, week_3_onward: 150000000 },
      amount_funded_paise: { weeks_1_2: null, week_3_onward: 50000000 } } }] };
}
function normalizeTarget(value, key) {
  if (value === null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) {
    if (!value || !Object.hasOwn(value, 'weeks_1_2') || !Object.hasOwn(value, 'week_3_onward')) throw badRequest(`${key} needs both program-week targets`);
    return { weeks_1_2: normalizeTarget(value.weeks_1_2, key), week_3_onward: normalizeTarget(value.week_3_onward, key) };
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || (key.endsWith('_paise') && !Number.isSafeInteger(value))) throw badRequest(`Invalid ${key} target`);
  if (key.endsWith('_percent') && value > 100) throw badRequest('Percentage targets cannot exceed 100');
  return value;
}
function normalizeVersion(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Invalid settings version');
  const defaults = getDefaultConfig().versions[0];
  if (!isoDate(input.effective_from)) throw badRequest('A valid effective_from date is required');
  const start = input.program_start_date ?? null;
  if (start !== null && !isoDate(start)) throw badRequest('Invalid program_start_date');
  const weekStart = input.week_start ?? defaults.week_start;
  if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) throw badRequest('week_start must be between 0 and 6');
  const days = input.working_days ?? defaults.working_days;
  if (!Array.isArray(days) || !days.length || days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) throw badRequest('working_days must contain weekdays 0 through 6');
  const targets = {};
  for (const [key, value] of Object.entries({ ...defaults.targets, ...(input.targets || {}) })) {
    if (!Object.hasOwn(defaults.targets, key)) throw badRequest(`Unknown KPI target: ${key}`);
    targets[key] = normalizeTarget(value, key);
  }
  const overrides = {};
  for (const [id, values] of Object.entries(input.owner_overrides || {})) {
    if (!/^\d+$/.test(id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0 || !values || typeof values !== 'object' || Array.isArray(values)) throw badRequest('Invalid owner target override');
    overrides[id] = {};
    for (const [key, value] of Object.entries(values.targets || values)) {
      if (!Object.hasOwn(defaults.targets, key)) throw badRequest(`Unknown KPI target: ${key}`);
      overrides[id][key] = normalizeTarget(value, key);
    }
  }
  let owners;
  try { owners = scopeIds({ ownerIds: input.responsible_owner_ids ?? [] }); }
  catch (error) { throw badRequest(error.message); }
  if (owners === null) throw badRequest('Responsible owners must be an explicit list');
  const reminders = { ...defaults.reminders, ...(input.reminders || {}) };
  if (typeof reminders.enabled !== 'boolean') throw badRequest('Reminder enabled must be true or false');
  for (const [key, value] of Object.entries(reminders)) {
    if (key === 'enabled') continue;
    if (!Object.hasOwn(defaults.reminders, key) || !Number.isInteger(value) || value < (key === 'expiry_lead_days' || key === 'pending_after_days' ? 0 : 1) || value > (key === 'scan_minutes' ? 1440 : 3650)) throw badRequest(`Invalid reminder setting: ${key}`);
  }
  return { ...input, effective_from: input.effective_from, program_start_date: start,
    week_start: weekStart, working_days: [...new Set(days)].sort(), responsible_owner_ids: owners,
    targets, owner_overrides: overrides, reminders };
}
function normalizeConfig(input = getDefaultConfig()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw badRequest('Invalid settings configuration');
  const versions = input.versions || [input];
  if (!Array.isArray(versions) || !versions.length || versions.length > 200) throw badRequest('Settings need 1 to 200 effective versions');
  const normalized = versions.map(normalizeVersion).sort((a, b) => a.effective_from.localeCompare(b.effective_from));
  if (new Set(normalized.map(version => version.effective_from)).size !== normalized.length) throw badRequest('Settings effective dates must be unique');
  return { versions: normalized };
}
function readConfig(db) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(SETTINGS_KEY);
  if (!row?.value) return getDefaultConfig();
  try { return normalizeConfig(JSON.parse(row.value)); }
  catch (error) { throw new Error(`Vendor & TReDS settings are invalid: ${error.message}`); }
}
function getConfig(db, asOf = istToday(), ownerId = null) {
  if (!isoDate(asOf)) throw badRequest('Invalid settings date');
  const envelope = readConfig(db);
  const version = envelope.versions.filter(item => item.effective_from <= asOf).at(-1);
  if (!version) throw badRequest('No settings version applies to this date');
  const effective = clone(version);
  if (ownerId !== null) effective.targets = { ...effective.targets, ...(effective.owner_overrides[String(ownerId)] || {}) };
  const start = effective.program_start_date;
  effective.program_week = start && asOf >= start ? Math.floor((Date.parse(asOf) - Date.parse(start)) / (7 * 86400000)) + 1 : null;
  effective.as_of = asOf;
  return effective;
}
function appendConfigVersion(existing, patch, today = istToday()) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw badRequest('Invalid settings version');
  if (!isoDate(today)) throw badRequest('Invalid current date');
  const config = normalizeConfig(existing);
  const effective = patch.effective_from || today;
  if (!isoDate(effective) || effective < today) throw badRequest('New settings cannot rewrite a past effective date');
  if (config.versions.some(version => version.effective_from === effective)) {
    const error = new Error('A settings version already exists for this effective date'); error.status = 409; throw error;
  }
  const previous = config.versions.filter(version => version.effective_from <= effective).at(-1) || config.versions[0];
  const next = normalizeVersion({ ...previous, ...patch, effective_from: effective,
    targets: { ...previous.targets, ...(patch.targets || {}) },
    reminders: { ...previous.reminders, ...(patch.reminders || {}) },
    owner_overrides: patch.owner_overrides === undefined ? previous.owner_overrides : patch.owner_overrides });
  return normalizeConfig({ versions: [...config.versions, next] });
}
function weekPeriod(date, config) {
  if (!isoDate(date)) throw badRequest('Invalid week date');
  const weekday = new Date(date + 'T00:00:00Z').getUTCDay();
  const start = addDays(date, -((weekday - config.week_start + 7) % 7));
  const lastOffset = Math.max(...config.working_days.map(day => (day - config.week_start + 7) % 7));
  return { week_start: start, week_end: addDays(start, lastOffset), date_from: start, date_to: addDays(start, lastOffset) };
}
function scopeFor(kind, fallback, options = {}) {
  return options.scopes ? (Object.hasOwn(options.scopes, kind) ? options.scopes[kind] : { ownerIds: [] }) : fallback;
}
function available(kind, scope, options) {
  const owners = scopeIds(scopeFor(kind, scope, options));
  return owners === null || owners.length > 0;
}
function commonFilters(filters, kind) {
  const result = {};
  for (const key of ['owner_id', 'customer_id', 'platform_id', 'sector', 'search', 'registration_id', 'vendor_code', 'enquiry_received', 'treds_status']) {
    if (filters[key] !== undefined && filters[key] !== '') result[key] = filters[key];
  }
  const qualified = filters.status_entity ? normalizeKind(filters.status_entity) : null;
  if (qualified && !Object.hasOwn(ENTITY_DEFS, qualified) && qualified !== 'tasks') throw badRequest('Invalid status entity');
  if (filters.status !== undefined && filters.status !== '') {
    const states = Array.isArray(filters.status) ? filters.status : [filters.status];
    if (states.length > 30 || states.some(value => typeof value !== 'string')) throw badRequest('Invalid status filter');
    if (kind === 'history') {
      result.status = filters.status;
      if (qualified) result.status_entity = qualified;
    } else if (!qualified || qualified === kind) {
      const choices = kind === 'tasks' ? require('./tasks').DEFINITION.statuses : kind === 'followups' ? ['pending','completed'] : ENTITY_DEFS[kind]?.statuses || [];
      if (qualified && states.some(value => !choices.includes(value))) throw badRequest('Invalid status filter for the selected entity');
      const applicable = states.filter(value => choices.includes(value));
      if (applicable.length) result.status = Array.isArray(filters.status) ? applicable : applicable[0];
    }
  }
  if (filters.source && ['registrations','history'].includes(kind)) {
    const choices = ENTITY_DEFS.registrations.fields.find(field => field.key === 'source').options;
    if (!choices.includes(filters.source)) throw badRequest('Invalid registration source');
    result.source = filters.source;
  }
  if (filters.overdue_as_of && ['registrations','enquiries','mappings','followups','invoices','funding','tasks','history'].includes(kind)) {
    if (!isoDate(filters.overdue_as_of)) throw badRequest('Invalid overdue date');
    result.overdue_as_of = filters.overdue_as_of;
  }
  return result;
}
function aggregate(db, kind, filters, scope, expression = 'COUNT(*)') {
  const query = buildQuery(kind, filters, scope);
  return db.prepare(`SELECT ${expression} AS value ${query.from} ${query.where}`).get(...query.params).value;
}
function targetValue(value, week) {
  if (value && typeof value === 'object') return week === null ? null : value[week <= 2 ? 'weeks_1_2' : 'week_3_onward'];
  return value ?? null;
}
function targetFor(config, key, filters, scope) {
  let owners = scopeIds(scope);
  if (filters.owner_id) owners = [Number(filters.owner_id)].filter(id => owners === null || owners.includes(id));
  if (key === 'tracker_same_day_percent') return targetValue(config.targets[key], config.program_week);
  if (owners === null) owners = config.responsible_owner_ids;
  if (!owners?.length) return null;
  if (config.responsible_owner_ids.length) owners = owners.filter(id => config.responsible_owner_ids.includes(id));
  if (!owners.length) return null;
  const values = owners.map(id => targetValue(config.owner_overrides[String(id)]?.[key] ?? config.targets[key], config.program_week));
  return values.some(value => value === null) ? null : values.reduce((sum, value) => sum + value, 0);
}
function score(value, target) {
  const percentage = target === null || target <= 0 || value === null ? null : Math.round(value / target * 10000) / 100;
  return { target, achievement_pct: percentage, status: target === null ? 'not_configured' : target === 0 ? 'not_applicable' : value === null ? 'unknown' : value >= target ? 'achieved' : 'below_target' };
}
function metric(db, { key, label, entity, filters, expression, unit = 'count', target = null, definition }, scope) {
  const value = aggregate(db, entity, filters, scope, expression);
  return { key, label, value, actual: value, unit, ...score(value, target), definition,
    drilldown: { entity, filters } };
}
function buildTrackerQuery(db, filters, fallback, options = {}) {
  const parts = []; const params = [];
  const businessDate = {
    registrations: "CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.registration_date') WHEN h.new_status='submitted' THEN json_extract(h.after_json,'$.submitted_at') END",
    approvals: "CASE WHEN h.new_status='approved' OR json_extract(h.after_json,'$.status')='approved' THEN json_extract(h.after_json,'$.approval_date') ELSE json_extract(h.after_json,'$.application_date') END",
    enquiries: "CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.enquiry_date') WHEN h.new_status='po_received' THEN h.changed_at END",
    accounts: "CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.registration_date') END",
    invoices: "CASE h.new_status WHEN 'uploaded' THEN CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.uploaded_at') WHEN h.event='status' AND json_valid(h.before_json) THEN CASE WHEN json_extract(h.before_json,'$.uploaded_at') IS NULL THEN json_extract(h.after_json,'$.uploaded_at') END END WHEN 'accepted' THEN json_extract(h.after_json,'$.accepted_at') WHEN 'accepted_by_client' THEN json_extract(h.after_json,'$.accepted_at') WHEN 'bid_received' THEN json_extract(h.after_json,'$.bid_at') WHEN 'funded' THEN json_extract(h.after_json,'$.funded_at') ELSE CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.uploaded_at') END END",
    funding: "CASE h.new_status WHEN 'funding_approved' THEN json_extract(h.after_json,'$.approved_at') WHEN 'funded' THEN json_extract(h.after_json,'$.funded_at') WHEN 'amount_funded' THEN json_extract(h.after_json,'$.funded_at') WHEN 'payment_reconciled' THEN json_extract(h.after_json,'$.reconciled_at') WHEN 'reconciled' THEN json_extract(h.after_json,'$.reconciled_at') WHEN 'closed' THEN json_extract(h.after_json,'$.closed_at') END",
    followups: "CASE WHEN h.event='create' THEN json_extract(h.after_json,'$.contact_at') END",
  };
  for (const [kind, expression] of Object.entries(businessDate)) {
    if (!available(kind, fallback, options)) continue;
    const query = buildQuery(kind, commonFilters(filters, kind), scopeFor(kind, fallback, options));
    const happened = istDay(`(${expression})`);
    const company = kind === 'accounts' ? 'NULL' : 'c.company_name';
    parts.push(`SELECT h.id,h.entity_type,h.entity_id,h.event,h.old_status,h.new_status,h.actor_id,
      h.changed_at, ${happened} AS happened_date, ${happened} AS event_date, ${istDay('h.changed_at')} AS recorded_date,
      CASE WHEN ${happened}=${istDay('h.changed_at')} THEN 1 ELSE 0 END AS same_day,
      ${company} AS company_name,u.name AS owner_name,ua.name AS actor_name
      ${query.from} JOIN vt_history h ON h.entity_type=? AND h.entity_id=t.id LEFT JOIN users ua ON ua.id=h.actor_id
      ${query.where} AND h.event IN ('create','status') AND json_valid(h.after_json)
      AND ${happened}>=? AND ${happened}<=?`);
    params.push(kind, ...query.params, filters.date_from, filters.date_to);
  }
  if (!parts.length) return null;
  return { sql: parts.join(' UNION ALL '), params };
}
function trackerStats(db, filters, fallback, options = {}) {
  const query = buildTrackerQuery(db, filters, fallback, options);
  if (!query) return { eligible: 0, same_day: 0, percentage: null };
  const totals = db.prepare(`SELECT COUNT(*) AS eligible, COALESCE(SUM(same_day),0) AS same_day FROM (${query.sql})`).get(...query.params);
  return { ...totals, percentage: totals.eligible ? Math.round(totals.same_day / totals.eligible * 10000) / 100 : null };
}
function listTrackerEvents(db, filters = {}, scope, options = {}) {
  const reference = filters.week_start || filters.date_from || istToday();
  const calendar = weekPeriod(reference, getConfig(db, reference));
  const period = { date_from: filters.date_from || calendar.date_from, date_to: filters.date_to || calendar.date_to };
  if (!isoDate(period.date_from) || !isoDate(period.date_to) || period.date_from > period.date_to) throw badRequest('Invalid history period');
  const query = buildTrackerQuery(db, { ...filters, ...period }, scope, options);
  const page = Math.max(1, Math.floor(Number(filters.page) || 1));
  const limit = Math.min(200, Math.max(1, Math.floor(Number(filters.limit) || 25)));
  if (!query) return { rows: [], total: 0, page, limit, definition: TRACKER_DEFINITION };
  let where = '';
  if (filters.same_day !== undefined && filters.same_day !== '') {
    if (![true,false,1,0,'1','0','true','false'].includes(filters.same_day)) throw badRequest('Invalid same-day filter');
    where = 'WHERE same_day=?'; query.params.push([true,1,'1','true'].includes(filters.same_day) ? 1 : 0);
  }
  const total = db.prepare(`SELECT COUNT(*) AS total FROM (${query.sql}) ${where}`).get(...query.params).total;
  const rows = db.prepare(`SELECT * FROM (${query.sql}) ${where} ORDER BY changed_at DESC,id DESC LIMIT ? OFFSET ?`).all(...query.params,limit,(page-1)*limit);
  return { rows, total, page, limit, definition: TRACKER_DEFINITION };
}
function getWeeklyKpis(db, filters = {}, scope, options = {}) {
  const reference = filters.week_start || filters.date_from || istToday();
  const config = getConfig(db, reference);
  const calendar = weekPeriod(reference, config);
  const period = { ...calendar, date_from: filters.date_from || calendar.date_from, date_to: filters.date_to || calendar.date_to };
  if (!isoDate(period.date_from) || !isoDate(period.date_to) || period.date_from > period.date_to) throw badRequest('Invalid KPI period');
  const definitions = [
    { key: 'registrations_weekly', label: 'Vendor Registrations', entity: 'registrations', stage_event: 'registered' },
    { key: 'mnc_enquiries_weekly', label: 'MNC Enquiries / RFQs', entity: 'enquiries', stage_event: 'received', extra: { is_mnc: true } },
    { key: 'ap_contacts', label: 'TReDS AP Contacts', entity: 'followups', stage_event: 'contacted', extra: { mapping_contacts: true }, definition: 'Actual contact events recorded against TReDS client-platform mappings; creating an AP contact master alone does not count.' },
    { key: 'invoices_uploaded', label: 'Invoices Uploaded', entity: 'invoices', stage_event: 'uploaded' },
    { key: 'invoice_value_paise', label: 'Invoice Value Uploaded', entity: 'invoices', stage_event: 'uploaded', unit: 'paise', expression: 'COALESCE(SUM(t.amount_paise),0)' },
    { key: 'amount_funded_paise', label: 'Amount Funded', entity: 'funding', stage_event: 'funded', unit: 'paise', expression: 'COALESCE(SUM(t.actual_received_paise),0)', definition: 'Actual positive receipts with a recorded funded timestamp; invoice face value and financed principal are shown separately.' },
  ];
  const rows = definitions.filter(def => available(def.entity, scope, options)).map(def => {
    const entityScope = scopeFor(def.entity, scope, options);
    const cohort = { ...commonFilters(filters, def.entity), date_from: period.date_from, date_to: period.date_to, stage_event: def.stage_event, ...(def.extra || {}) };
    return metric(db, { ...def, filters: cohort, target: targetFor(config, def.key, filters, entityScope) }, entityScope);
  });
  if (['registrations', 'approvals', 'enquiries', 'accounts', 'invoices', 'funding', 'followups'].some(kind => available(kind, scope, options))) {
    const stats = trackerStats(db, { ...filters, ...period }, scope, options);
    rows.splice(Math.min(2, rows.length), 0, { key: 'tracker_same_day_percent', label: 'Tracker Updated Same Day', value: stats.percentage, actual: stats.percentage, unit: 'percent', ...stats,
      ...score(stats.percentage, config.targets.tracker_same_day_percent), definition: TRACKER_DEFINITION,
      drilldown: { entity: 'history', filters: { ...commonFilters(filters, 'history'), ...period, dated_events: true } } });
  }
  return { period: { ...period, program_week: config.program_week }, rows, config };
}
function getDashboard(db, filters = {}, scope, options = {}) {
  const today = options.today || istToday();
  if (!isoDate(today)) throw badRequest('Invalid dashboard date');
  const weekly = getWeeklyKpis(db, filters, scope, options);
  const { period, config } = weekly;
  const cards = [];
  if (available('registrations', scope, options)) {
    const entityScope = scopeFor('registrations', scope, options);
    cards.push(metric(db, { key: 'registrations_today', label: "Today's Vendor Registrations", entity: 'registrations',
      filters: { ...commonFilters(filters, 'registrations'), date_from: today, date_to: today, stage_event: 'registered' },
      target: targetFor(getConfig(db, today), 'registrations_daily', filters, entityScope) }, entityScope));
    const row = weekly.rows.find(item => item.key === 'registrations_weekly'); if (row) cards.push(row);
    cards.push(metric(db, { key: 'approved_vendor_codes', label: 'Approved Vendor Codes', entity: 'registrations',
      filters: { ...commonFilters(filters, 'registrations'), date_from: period.date_from, date_to: period.date_to, stage_event: 'approved', vendor_code: 'available' },
      definition: 'Distinct registrations with a vendor code; counted at the first recorded approved-code date.' }, entityScope));
    cards.push(metric(db, { key: 'documents_pending', label: 'Registrations with Documents Pending', entity: 'registrations',
      filters: { ...commonFilters(filters, 'registrations'), documents_pending: true, as_of: today },
      definition: 'Distinct registrations missing at least one active required document, including expired or rejected files.' }, entityScope));
  }
  if (available('enquiries', scope, options)) cards.push(metric(db, { key: 'enquiries', label: 'Enquiries / RFQs', entity: 'enquiries',
    filters: { ...commonFilters(filters, 'enquiries'), date_from: period.date_from, date_to: period.date_to, stage_event: 'received' } }, scopeFor('enquiries', scope, options)));
  for (const key of ['mnc_enquiries_weekly', 'invoices_uploaded', 'invoice_value_paise', 'amount_funded_paise']) {
    const row = weekly.rows.find(item => item.key === key); if (row) cards.push(row);
  }
  const funding = {};
  if (available('invoices', scope, options)) {
    const invoiceScope = scopeFor('invoices', scope, options);
    for (const [key, label, stage] of [['uploaded_value_paise', 'Invoice Value Uploaded', 'uploaded'], ['accepted_value_paise', 'Accepted Value', 'accepted'], ['bid_value_paise', 'Bid Received Value', 'bid']]) {
      funding[key] = metric(db, { key, label, entity: 'invoices', unit: 'paise', expression: 'COALESCE(SUM(t.amount_paise),0)',
        filters: { ...commonFilters(filters, 'invoices'), date_from: period.date_from, date_to: period.date_to, stage_event: stage } }, invoiceScope);
    }
    const pendingFilters = { ...commonFilters(filters, 'invoices'), date_from: period.date_from, date_to: period.date_to, stage_event: 'uploaded' };
    const pending = buildQuery('invoices', pendingFilters, invoiceScope);
    const value = db.prepare(`SELECT COALESCE(SUM(t.amount_paise),0) AS value ${pending.from} ${pending.where}
      AND t.status NOT IN ('cancelled','rejected') AND COALESCE(f.actual_received_paise,0)=0`).get(...pending.params).value;
    funding.pending_value_paise = { key: 'pending_value_paise', label: 'Pending Funding', value, unit: 'paise', definition: 'Uploaded active invoice face value with no positive actual receipt.',
      drilldown: { entity: 'invoices', filters: { ...pendingFilters, pending_funding: true } } };
  }
  if (available('funding', scope, options)) {
    const entityScope = scopeFor('funding', scope, options);
    const cohort = { ...commonFilters(filters, 'funding'), date_from: period.date_from, date_to: period.date_to, stage_event: 'funded' };
    const query = buildQuery('funding', cohort, entityScope);
    funding.actual_received_paise = metric(db, { key: 'actual_received_paise', label: 'Actual Amount Received', entity: 'funding', unit: 'paise', filters: cohort, expression: 'COALESCE(SUM(t.actual_received_paise),0)' }, entityScope);
    funding.financed_principal_paise = metric(db, { key: 'financed_principal_paise', label: 'Financed Principal', entity: 'funding', unit: 'paise', filters: cohort, expression: 'CASE WHEN COUNT(*)=0 THEN 0 WHEN COUNT(t.principal_paise)<COUNT(*) THEN NULL ELSE SUM(t.principal_paise) END' }, entityScope);
    funding.funded_face_value_paise = metric(db, { key: 'funded_face_value_paise', label: 'Funded Invoice Face Value', entity: 'funding', unit: 'paise', filters: cohort, expression: 'COALESCE(SUM(i.amount_paise),0)' }, entityScope);
    const times = db.prepare(`SELECT AVG(CASE WHEN julianday(t.funded_at)>=julianday(i.uploaded_at) THEN julianday(t.funded_at)-julianday(i.uploaded_at) END) AS average_days,
      COUNT(CASE WHEN julianday(t.funded_at)>=julianday(i.uploaded_at) THEN 1 END) AS known_count ${query.from} ${query.where}`).get(...query.params);
    funding.average_funding_days = { key: 'average_funding_days', label: 'Average Funding Time', value: times.average_days, known_count: times.known_count, unit: 'days', definition: 'Elapsed days from actual upload to actual funding, excluding unknown or reversed timestamps.', drilldown: { entity: 'funding', filters: { ...cohort, known_funding_time: true } } };
    const rates = db.prepare(`SELECT t.basis,t.day_basis, SUM(t.discount_rate*t.principal_paise)/NULLIF(SUM(t.principal_paise),0) AS average_rate, COUNT(*) AS known_count
      ${query.from} ${query.where} AND t.discount_rate IS NOT NULL AND t.basis IS NOT NULL AND t.principal_paise>0
      GROUP BY t.basis,CASE WHEN t.basis='annualized' THEN t.day_basis END`).all(...query.params);
    funding.average_discount_percent = { key: 'average_discount_percent', label: 'Average Discount %', value: rates.length === 1 ? rates[0].average_rate : null,
      unit: 'percent', basis: rates.length === 1 ? rates[0].basis : null, groups: rates,
      definition: 'Principal-weighted recorded rates; a combined rate is unknown when flat and annualized/day-count bases differ.', drilldown: { entity: 'funding', filters: { ...cohort, known_discount_rate: true } } };
  }
  const platforms = [];
  if (available('accounts', scope, options)) {
    const accountScope = scopeFor('accounts', scope, options);
    const query = buildQuery('accounts', commonFilters(filters, 'accounts'), accountScope);
    const rows = db.prepare(`SELECT p.id,p.label,COUNT(*) AS total,
      SUM(CASE WHEN COALESCE(NULLIF(t.account_status,''),t.status)='active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN COALESCE(NULLIF(t.account_status,''),t.status)='frozen' THEN 1 ELSE 0 END) AS frozen,
      SUM(CASE WHEN COALESCE(NULLIF(t.account_status,''),t.status)='inactive' THEN 1 ELSE 0 END) AS inactive
      ${query.from} ${query.where} GROUP BY p.id,p.label ORDER BY p.label`).all(...query.params);
    for (const row of rows) {
      const drilldown = { entity: 'accounts', filters: { ...commonFilters(filters, 'accounts'), platform_id: row.id } };
      const drilldowns = { total: drilldown };
      for (const status of ['active','frozen','inactive']) drilldowns[status] = { entity: 'accounts', filters: { ...drilldown.filters, effective_account_status: status } };
      platforms.push({ ...row, drilldown, drilldowns });
    }
  }
  const tasks = available('tasks', scope, options) ? require('./tasks').listTasks(db, { ...commonFilters(filters, 'tasks'), date_from: today, date_to: today, limit: 20 }, scopeFor('tasks', scope, options)) : { rows: [], total: 0, page: 1, limit: 20 };
  return { today, period, cards, weekly_kpis: weekly.rows, funding, platforms, tasks, config,
    funding_metrics: Object.values(funding),
    definitions: { funded: 'Actual receipts in paise, not invoice face value.', tracker_same_day: TRACKER_DEFINITION, program_weeks: 'Weeks 1–2 are per week, counted from the configured program start date.' } };
}

module.exports = { SETTINGS_KEY, TRACKER_DEFINITION, getDefaultConfig, normalizeConfig, normalizeVersion,
  readConfig, getConfig, appendConfigVersion, updateConfig: appendConfigVersion, weekPeriod, istToday,
  aggregate, getWeeklyKpis, getDashboard, trackerStats, buildTrackerQuery, listTrackerEvents, scopeFor, commonFilters };
