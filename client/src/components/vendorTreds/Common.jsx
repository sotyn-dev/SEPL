import { useEffect, useRef, useState } from 'react';
import { FiAlertCircle, FiRefreshCw, FiSearch, FiX } from 'react-icons/fi';
import { BASE, choice, isPaise, label, money, recordLabel } from './model';
import { useDebounced, useRemote } from './hooks';
import { fmtDate, fmtDateTime } from '../../utils/datetime';

export function LoadState({ loading, error, empty, onRetry }) {
  if (loading) return <div role="status" className="card p-6 text-center text-sm text-slate-500">Loading…</div>;
  if (error) return <div role="alert" className="card p-4 border-red-200 text-red-700 text-sm flex flex-wrap items-center gap-3"><FiAlertCircle /><span className="flex-1">{error}</span>{onRetry && <button className="btn btn-secondary" onClick={onRetry}><FiRefreshCw /> Retry</button>}</div>;
  if (empty) return <div className="card p-8 text-center text-sm text-slate-500">No records match these filters.</div>;
  return null;
}

export function StatusBadge({ value, displayLabel }) {
  if (!value) return <span className="text-slate-400">—</span>;
  const tone = /reject|cancel|frozen|blocked|expired|lost/.test(value) ? 'badge-red' : ['approved', 'active', 'funded', 'completed', 'reconciled', 'closed', 'po_received', 'achieved', 'verified'].includes(value) ? 'badge-green' : /pending|hold|review|progress|below_target/.test(value) ? 'badge-yellow' : 'badge-gray';
  return <span className={`badge ${tone} whitespace-normal`}>{displayLabel || label(value)}</span>;
}

export function Value({ value, field = {}, fieldKey = '', displayLabel }) {
  if (value == null || value === '') return <span className="text-slate-400">—</span>;
  if (field.type === 'metric' && typeof value === 'object') return <span>{value.value == null ? '—' : value.unit === 'paise' ? money(value.value, true) : `${value.value}${value.unit === 'percent' ? '%' : value.unit === 'days' ? ' days' : ''}`}</span>;
  if (field.type === 'paise' || isPaise({ ...field, key: fieldKey || field.key })) return <span className="tabular-nums">{money(value, true)}</span>;
  if (field.type === 'money') return <span className="tabular-nums">{money(value)}</span>;
  if (field.type === 'boolean' || typeof value === 'boolean') return <span>{value === true || value === 1 || value === '1' ? 'Yes' : 'No'}</span>;
  if (field.type === 'date') return <span>{fmtDate(value)}</span>;
  if (field.type === 'datetime' || /_at$/.test(fieldKey)) return <span>{fmtDateTime(value)}</span>;
  if (field.type === 'status' || fieldKey === 'status' || /_status$/.test(fieldKey)) return <StatusBadge value={String(value)} displayLabel={displayLabel} />;
  if (typeof value === 'object') return <span>{JSON.stringify(value)}</span>;
  return <span className="break-words">{String(value)}</span>;
}

export function RemoteSelect({ entity, value, onChange, onSelected, selectedLabel, required, disabled, id, label: accessibleLabel }) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null);
  const ref = useRef(null);
  const q = useDebounced(search);
  const { data, loading, error } = useRemote(open ? `${BASE}/lookups/${entity}` : null, { q, page: 1, limit: 30 });
  const rows = Array.isArray(data) ? data : data?.rows || [];
  useEffect(() => {
    const close = event => { if (ref.current && !ref.current.contains(event.target)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const selectedText = selected && String(selected.id ?? selected.value) === String(value) ? recordLabel(selected) : selectedLabel || (value ? `Selected #${value}` : 'Search and select…');
  return <div ref={ref} className="relative">
    <button id={id} type="button" disabled={disabled} aria-label={accessibleLabel} aria-expanded={open} onClick={() => setOpen(v => !v)} className="input text-left flex items-center gap-2 w-full"><span className={`flex-1 truncate ${value ? '' : 'text-slate-400'}`}>{selectedText}</span><FiSearch size={14} /></button>
    {open && <div className="absolute z-[70] left-0 right-0 mt-1 bg-white border rounded-xl shadow-xl overflow-hidden">
      <div className="p-2"><input autoFocus className="input" aria-label={`Search ${accessibleLabel || entity}`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Type to search…" onKeyDown={event => { if (event.key === 'Escape') setOpen(false); }} /></div>
      <div className="max-h-60 overflow-y-auto">
        {!required && <button type="button" className="w-full text-left px-3 py-2 text-sm text-slate-500" onClick={() => { onChange(null); onSelected?.(null); setSelected(null); setOpen(false); }}>Clear selection</button>}
        {loading && <p className="px-3 py-3 text-sm text-slate-500">Searching…</p>}
        {error && <p role="alert" className="px-3 py-3 text-xs text-red-700">{error}</p>}
        {rows.map((row, index) => <button type="button" key={row.id ?? row.value ?? index} className="w-full text-left px-3 py-2.5 text-sm hover:bg-blue-50 break-words" onClick={() => { const idValue = row.id ?? row.value ?? row.code; onChange(idValue); onSelected?.(row); setSelected(row); setOpen(false); }}>{recordLabel(row)}</button>)}
        {!loading && !error && rows.length === 0 && <p className="px-3 py-3 text-xs text-slate-500">No matches found.</p>}
        {data?.total > rows.length && <p className="px-3 py-2 text-xs text-slate-500 bg-slate-50">Type more to narrow {data.total} matches.</p>}
      </div>
    </div>}
  </div>;
}

export function Filters({ value, onChange, statuses = [], statusGroups = [], sourceOptions = [], sourceLabel = 'Source', tredsStatuses = [], showDeadline = true, visibility = {}, extended = false }) {
  const change = (key, next) => onChange({ ...value, [key]: next });
  return <div className="card p-3 space-y-3">
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
      <label className="block"><span className="label">Search</span><input className="input" placeholder="Company, invoice, reference…" value={value.search || ''} onChange={event => change('search', event.target.value)} /></label>
      <label className="block"><span className="label">Owner</span><RemoteSelect entity="users" value={value.owner_id} onChange={v => change('owner_id', v)} label="Owner" /></label>
      <label className="block"><span className="label">Company / Client</span><RemoteSelect entity="customers" value={value.customer_id} onChange={v => change('customer_id', v)} label="Company / Client" /></label>
      {statusGroups.length > 0 ? <label className="block"><span className="label">Workflow status</span><select className="select" value={value.status ? `${value.status_entity || 'registrations'}:${value.status}` : ''} onChange={event => { const [entity = '', status = ''] = event.target.value.split(':'); onChange({ ...value, status_entity: entity, status }); }}><option value="">All workflow statuses</option>{statusGroups.map(group => <optgroup key={group.entity} label={group.label}>{group.statuses.map(status => { const option = choice(status); return <option key={option.value} value={`${group.entity}:${option.value}`}>{option.label}</option>; })}</optgroup>)}</select><span className="text-[11px] text-slate-500">Applies to the selected workflow.</span></label> : <label className="block"><span className="label">Status</span><select className="select" value={value.status || ''} onChange={event => change('status', event.target.value)}><option value="">All statuses</option>{statuses.map(status => { const option = choice(status); return <option key={option.value} value={option.value}>{option.label}</option>; })}</select></label>}
    </div>
    <details open={extended} className="text-sm"><summary className="cursor-pointer text-blue-700 font-medium">More filters</summary>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-3">
        <label><span className="label">From</span><input type="date" className="input" value={value.date_from || ''} onChange={event => change('date_from', event.target.value)} /></label>
        <label><span className="label">To</span><input type="date" className="input" value={value.date_to || ''} onChange={event => change('date_to', event.target.value)} /></label>
        {visibility.platform !== false && <label><span className="label">TReDS platform</span><RemoteSelect entity="platform" value={value.platform_id} onChange={v => change('platform_id', v)} label="TReDS platform" /></label>}
        {visibility.sector !== false && <label><span className="label">Sector</span><input className="input" value={value.sector || ''} placeholder="Sector name" onChange={event => change('sector', event.target.value)} /></label>}
        {sourceOptions.length > 0 && <label><span className="label">{sourceLabel}</span><select className="select" value={value.source || ''} onChange={event => change('source', event.target.value)}><option value="">Any source</option>{sourceOptions.map(item => { const option = choice(item); return <option key={option.value} value={option.value}>{option.label}</option>; })}</select></label>}
        {visibility.vendorCode !== false && <label><span className="label">Vendor code</span><select className="select" value={value.vendor_code || ''} onChange={event => change('vendor_code', event.target.value)}><option value="">Any</option><option value="1">Available</option><option value="0">Missing</option></select></label>}
        {visibility.enquiryReceived !== false && <label><span className="label">Enquiry received</span><select className="select" value={value.enquiry_received || ''} onChange={event => change('enquiry_received', event.target.value)}><option value="">Any</option><option value="1">Yes</option><option value="0">No</option></select></label>}
        {visibility.tredsStatus !== false && tredsStatuses.length > 0 && <label><span className="label">TReDS status</span><select className="select" value={value.treds_status || ''} onChange={event => change('treds_status', event.target.value)}><option value="">Any TReDS status</option>{tredsStatuses.map(status => { const option = choice(status); return <option key={option.value} value={option.value}>{option.label}</option>; })}</select></label>}
        {showDeadline && visibility.deadline !== false && <label><span className="label">Follow-up due before</span><input type="date" className="input" value={value.overdue_as_of || ''} onChange={event => change('overdue_as_of', event.target.value)} /></label>}
      </div>
    </details>
    {Object.values(value).some(v => v !== '' && v != null) && <button type="button" className="text-xs text-blue-700 flex items-center gap-1" onClick={() => onChange({})}><FiX /> Clear filters</button>}
  </div>;
}
