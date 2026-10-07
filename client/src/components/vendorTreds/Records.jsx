import { useState } from 'react';
import { FiArrowDown, FiEdit2, FiEye, FiPlus, FiRefreshCw } from 'react-icons/fi';
import Modal from '../Modal';
import { useAuth } from '../../context/AuthContext';
import { Filters, LoadState, Value } from './Common';
import { useDebounced, useDesktop, useRemote } from './hooks';
import { DocumentsPanel, EntityForm, History, StatusForm } from './Forms';
import { BASE, definition, entityFilterVisibility, fieldsFor, label, recordLabel, recordStatusLabel } from './model';

const COLUMNS = {
  registrations: ['company_name', 'sector', 'portal_url', 'owner_name', 'registration_date', 'status', 'vendor_code', 'enquiry_status', 'treds_status', 'last_followup_at', 'next_followup_at'],
  enquiries: ['company_name', 'rfq_number', 'product_service', 'enquiry_date', 'expected_amount_paise', 'due_date', 'owner_name', 'status', 'next_followup_at'],
  approvals: ['company_name', 'application_date', 'status', 'vendor_code', 'approval_date', 'valid_until', 'owner_name'],
  accounts: ['platform_name', 'vendor_name', 'status', 'registration_date', 'account_status', 'login_id', 'last_verified_date', 'owner_name'],
  mappings: ['company_name', 'turnover_over_250cr', 'platform_name', 'contact_name', 'contact_email', 'contact_phone', 'acceptance_confirmed', 'last_contact_at', 'next_followup_at', 'owner_name'],
  contacts: ['company_name', 'kind', 'name', 'email', 'phone', 'owner_name'],
  invoices: ['company_name', 'external_invoice_number', 'invoice_date', 'amount_paise', 'due_date', 'platform_name', 'po_number', 'owner_name', 'status', 'canonical_warning'],
  funding: ['company_name', 'external_invoice_number', 'invoice_date', 'invoice_amount_paise', 'platform_name', 'uploaded_at', 'accepted_at', 'bid_at', 'funded_at', 'discount_rate', 'discount_paise', 'actual_received_paise', 'expected_settlement', 'bank_reference', 'status', 'canonical_warning'],
  followups: ['company_name', 'owner_name', 'contact_at', 'next_followup_at', 'reminder_at', 'notes', 'status'],
  tasks: ['title', 'owner_name', 'due_date', 'priority', 'status', 'reminder_at', 'completed_at'],
  catalog: ['kind', 'code', 'label', 'required', 'active'],
};
const LABELS = { company_name: 'Company / Client', external_invoice_number: 'Invoice', expected_amount_paise: 'Expected Value', amount_paise: 'Amount', invoice_amount_paise: 'Invoice Amount', actual_received_paise: 'Amount Received', discount_paise: 'Discount Amount', owner_name: 'Owner', platform_name: 'Platform', contact_name: 'AP Contact', contact_email: 'AP Email', contact_phone: 'AP Phone', valid_until: 'Valid Till', discount_rate: 'Discount %', canonical_warning: 'ERP Invoice Check' };

function columnsFor(kind, def = {}) {
  return (def.columns || COLUMNS[kind] || fieldsFor(def).slice(0, 8).map(field => field.key)).map(column => {
    if (typeof column === 'object') return column;
    const field = fieldsFor(def).find(item => item.key === column) || {};
    return { ...field, key: column, label: LABELS[column] || field.label || label(column), type: field.type || (/_date$|^valid_until$|^expected_settlement$|^due_date$/.test(column) ? 'date' : ['required', 'active'].includes(column) ? 'boolean' : undefined) };
  });
}

export function ServerPager({ page, limit, total, onChange }) {
  if (!total) return null;
  const pages = Math.max(1, Math.ceil(total / limit));
  return <div className="flex flex-wrap items-center gap-3 bg-white rounded-lg border p-3 text-xs text-slate-600">
    <span>Showing {(page - 1) * limit + 1}–{Math.min(page * limit, total)} of {total.toLocaleString('en-IN')}</span>
    <label className="flex items-center gap-2">Per page<select className="select !w-20 !py-1" value={limit} onChange={event => onChange({ page: 1, limit: Number(event.target.value) })}>{[15, 25, 50, 100].map(number => <option key={number}>{number}</option>)}</select></label>
    <div className="ml-auto flex items-center gap-2"><button className="btn btn-secondary text-xs" disabled={page <= 1} onClick={() => onChange({ page: page - 1 })}>Previous</button><span>{page} / {pages}</span><button className="btn btn-secondary text-xs" disabled={page >= pages} onClick={() => onChange({ page: page + 1 })}>Next</button></div>
  </div>;
}

export function RecordTable({ kind, def, rows, onOpen, onEdit, canEdit = false }) {
  const desktop = useDesktop();
  const columns = columnsFor(kind, def);
  const actions = row => <div className="flex flex-wrap gap-2"><button type="button" aria-label={`View ${recordLabel(row)}`} className="btn btn-secondary text-xs inline-flex gap-1 items-center" onClick={() => onOpen(row)}><FiEye />View</button>{canEdit && <button type="button" aria-label={`Edit ${recordLabel(row)}`} className="btn btn-secondary text-xs inline-flex gap-1 items-center" onClick={() => onEdit(row)}><FiEdit2 />Edit</button>}</div>;
  return desktop ? <div className="card p-0 overflow-x-auto"><table className="text-xs w-full"><thead><tr>{columns.map(column => <th key={column.key} className="whitespace-nowrap px-3 py-3 text-left">{column.label}</th>)}<th className="px-3 py-3 text-left">Actions</th></tr></thead><tbody>{rows.map(row => <tr key={row.id}>{columns.map(column => <td key={column.key} className="px-3 py-3 max-w-64"><Value value={row[column.key]} field={column} fieldKey={column.key} displayLabel={column.key === 'status' ? recordStatusLabel(kind, row) : undefined} /></td>)}<td className="px-3 py-3">{actions(row)}</td></tr>)}</tbody></table></div> : <div className="space-y-3">{rows.map(row => <article key={row.id} className="card p-3 space-y-3"><h4 className="font-semibold text-sm text-slate-800 break-words">{recordLabel(row)}</h4><dl className="grid grid-cols-2 gap-3">{columns.filter(column => row[column.key] != null && row[column.key] !== '').map(column => <div key={column.key} className={['notes', 'remarks', 'portal_url', 'canonical_warning'].includes(column.key) ? 'col-span-2' : ''}><dt className="text-[11px] text-slate-500">{column.label}</dt><dd className="text-xs mt-0.5 break-words"><Value value={row[column.key]} field={column} fieldKey={column.key} displayLabel={column.key === 'status' ? recordStatusLabel(kind, row) : undefined} /></dd></div>)}</dl>{actions(row)}</article>)}</div>;
}

export function RecordList({ kind, options, filters, onFilters, page, limit, onPage, revision, onRefresh, recordId, recordAction, onRecord }) {
  const def = definition(options, kind);
  const { canCreate, canEdit } = useAuth();
  const [creating, setCreating] = useState(false); const [editing, setEditing] = useState(null);
  const search = useDebounced(filters.search || '');
  const { data, error, loading } = useRemote(`${BASE}/${kind}`, { ...filters, search, page, limit }, revision);
  const rows = data?.rows || []; const total = data?.total || 0;
  const permission = def.permission;
  const editable = !!permission && canEdit(permission);
  const sourceOptions = fieldsFor(def).find(field => field.key === 'source')?.options || [];
  const sorts = [{ value: 'id', label: 'Newest record' }, { value: 'date', label: 'Date' }];
  if (kind !== 'catalog') sorts.push({ value: 'owner_name', label: 'Owner' });
  if (def.statuses?.length) sorts.push({ value: 'status', label: 'Status' });
  if (kind !== 'accounts' && kind !== 'catalog') sorts.push({ value: 'company_name', label: 'Company' });
  if (['accounts', 'mappings', 'invoices', 'funding'].includes(kind)) sorts.push({ value: 'platform_name', label: 'Platform' });
  if (kind === 'invoices') sorts.push({ value: 'amount_paise', label: 'Amount' });
  if (kind === 'funding') sorts.push({ value: 'actual_received_paise', label: 'Amount received' });
  const saved = () => { setCreating(false); setEditing(null); onRefresh(); };
  return <section className="space-y-4">
    <div className="flex flex-wrap justify-between gap-3 items-center"><div><h3 className="text-lg font-semibold text-slate-800">{def.label || label(kind)}</h3>{!loading && !error && <p className="text-xs text-slate-500 mt-1">{total.toLocaleString('en-IN')} matching records</p>}</div><div className="flex gap-2"><button className="btn btn-secondary inline-flex gap-1 items-center" onClick={onRefresh}><FiRefreshCw />Refresh</button>{permission && canCreate(permission) && <button className="btn btn-primary inline-flex gap-1 items-center" onClick={() => setCreating(true)}><FiPlus />New</button>}</div></div>
    {kind === 'catalog' ? <div className="card p-3 grid grid-cols-1 sm:grid-cols-3 gap-3"><label><span className="label">Search masters</span><input className="input" value={filters.search || ''} onChange={event => onFilters({ ...filters, search: event.target.value })} placeholder="Code or name…" /></label><label><span className="label">Master type</span><select className="select" value={filters.kind || ''} onChange={event => onFilters({ ...filters, kind: event.target.value })}><option value="">All types</option>{(fieldsFor(def).find(field => field.key === 'kind')?.options || []).map(value => <option key={value} value={value}>{label(value)}</option>)}</select></label><label><span className="label">Availability</span><select className="select" value={filters.active || ''} onChange={event => onFilters({ ...filters, active: event.target.value })}><option value="">All</option><option value="1">Active</option><option value="0">Inactive</option></select></label></div> : <Filters value={filters} onChange={onFilters} statuses={def.statuses || []} visibility={entityFilterVisibility(kind)} sourceOptions={sourceOptions} tredsStatuses={definition(options, 'accounts').statuses || []} />}
    <div className="flex flex-wrap gap-3 items-center text-xs"><span>Sort by</span><select aria-label="Sort field" className="select !w-auto" value={filters.sort || 'id'} onChange={event => onFilters({ ...filters, sort: event.target.value })}>{sorts.map(sort => <option key={sort.value} value={sort.value}>{sort.label}</option>)}</select><button className="btn btn-secondary inline-flex gap-1 items-center" onClick={() => onFilters({ ...filters, direction: filters.direction === 'asc' ? 'desc' : 'asc' })}><FiArrowDown className={filters.direction === 'asc' ? 'rotate-180' : ''} />{filters.direction === 'asc' ? 'Ascending' : 'Descending'}</button>{filters.stage_event && <span className="rounded bg-blue-50 text-blue-800 px-2 py-1">Stage: {label(filters.stage_event)}</span>}</div>
    <LoadState loading={loading} error={error} empty={!loading && !error && !rows.length} onRetry={onRefresh} />
    {!loading && !error && rows.length > 0 && <><RecordTable kind={kind} def={def} rows={rows} onOpen={row => onRecord(row.id)} onEdit={row => onRecord(row.id, 'edit')} canEdit={editable} /><ServerPager page={page} limit={limit} total={total} onChange={onPage} /></>}
    {creating && <EntityForm kind={kind} def={def} onClose={() => setCreating(false)} onSaved={saved} onOpenCandidate={candidate => { setCreating(false); onRecord(candidate.id); }} />}
    {editing && <EntityForm key={editing.id} kind={kind} def={def} record={editing} onClose={() => setEditing(null)} onSaved={saved} />}
    {recordId && <RecordDetail key={`${kind}-${recordId}`} kind={kind} id={recordId} options={options} revision={revision} onRefresh={onRefresh} onClose={() => onRecord(null)} onEdit={record => setEditing(record)} editRequested={recordAction === 'edit'} onCancelEdit={() => onRecord(recordId)} onEdited={() => { onRecord(recordId); onRefresh(); }} />}
  </section>;
}

export function RecordDetail({ kind, id, options, revision, onRefresh, onClose, onEdit, editRequested, onCancelEdit, onEdited }) {
  const def = definition(options, kind);
  const { canEdit, canApprove } = useAuth();
  const [statusOpen, setStatusOpen] = useState(false);
  const { data, loading, error } = useRemote(`${BASE}/${kind}/${id}`, {}, revision);
  const record = data?.record || data;
  const editable = def.permission && canEdit(def.permission);
  const approver = def.permission && canApprove(def.permission);
  const allowed = editable || approver ? data?.allowed_transitions || record?.allowed_transitions || [] : [];
  const fields = fieldsFor(def);
  const allFields = [...fields, ...['status', 'created_at', 'created_by_name', 'updated_at', 'updated_by_name', 'uploaded_at', 'accepted_at', 'bid_at', 'approved_at', 'funded_at', 'reconciled_at', 'closed_at', 'expected_net_paise'].filter(key => !fields.some(field => field.key === key) && record?.[key] != null).map(key => ({ key, label: label(key) }))];
  return <><Modal isOpen onClose={onClose} title={`${def.label || label(kind)} #${id}`} xwide>
    <LoadState loading={loading} error={error} onRetry={onRefresh} />
    {!loading && !error && record && <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-2"><h3 className="font-semibold text-slate-800 flex-1 break-words">{recordLabel(record)}</h3>{editable && <button className="btn btn-secondary inline-flex gap-1 items-center" onClick={() => onEdit(record)}><FiEdit2 />Edit</button>}{allowed.length > 0 && <button className="btn btn-primary" onClick={() => setStatusOpen(true)}>Change status</button>}</div>
      {kind === 'funding' && <p className="rounded bg-blue-50 text-blue-800 p-3 text-xs">Discount and expected proceeds are calculated when terms are complete. Actual receipts and accounting reconciliation require recorded evidence.</p>}
      {record.canonical_warning && <p role="alert" className="rounded-lg bg-amber-50 border border-amber-200 text-amber-900 p-3 text-sm">{record.canonical_warning}</p>}
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">{allFields.map(field => {
        const related = field.lookup ? record[field.labelKey || field.key.replace(/_id$/, '_name')] || (field.key === 'customer_id' ? record.company_name : null) : null;
        return <div key={field.key} className={['textarea', 'json'].includes(field.type) ? 'sm:col-span-2 lg:col-span-3' : ''}><dt className="text-xs text-slate-500">{field.label}</dt><dd className="text-sm mt-1 break-words"><Value value={related || record[field.key]} field={related ? {} : field} fieldKey={field.key} displayLabel={field.key === 'status' ? recordStatusLabel(kind, record) : undefined} /></dd></div>;
      })}</dl>
      {['registrations', 'invoices'].includes(kind) && <DocumentsPanel kind={kind} record={record} documents={data.documents || []} options={options} canUpload={editable} canReview={approver} onSaved={onRefresh} />}
      <History rows={data.history || []} />
    </div>}
  </Modal>{statusOpen && record && <StatusForm kind={kind} record={record} allowed={allowed} onClose={() => setStatusOpen(false)} onSaved={() => { setStatusOpen(false); onRefresh(); }} />}{editRequested && !loading && !error && record && editable && <EntityForm kind={kind} def={def} record={record} onClose={onCancelEdit} onSaved={onEdited} />}</>;
}
