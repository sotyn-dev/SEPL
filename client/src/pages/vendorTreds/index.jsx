import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { LoadState } from '../../components/vendorTreds/Common';
import { useRemote } from '../../components/vendorTreds/hooks';
import { RecordList } from '../../components/vendorTreds/Records';
import { BASE, KIND_TAB, TABS, definition, filterParams } from '../../components/vendorTreds/model';
import Dashboard from './Dashboard';
import Reports from './Reports';
import Masters from './Masters';
import Settings from './Settings';
import TrackerEvents from './TrackerEvents';

const FILTER_KEYS = ['search', 'owner_id', 'customer_id', 'status', 'status_entity', 'platform_id', 'sector_id', 'sector', 'source', 'vendor_code', 'enquiry_received', 'treds_status', 'date_from', 'date_to', 'date_field', 'stage_event', 'overdue_as_of', 'registration_id', 'invoice_id', 'is_mnc', 'pending_funding', 'documents_pending', 'mapping_contacts', 'known_funding_time', 'known_discount_rate', 'effective_account_status', 'account_status', 'sort', 'direction', 'kind', 'active', 'dated_events', 'same_day'];

export default function VendorTreds() {
  const { canView } = useAuth();
  const [params, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const { data: options, loading, error } = useRemote(`${BASE}/options`, {}, revision);
  const available = TABS.filter(tab => canView(tab.permission));
  const requested = params.get('tab') || available[0]?.id || 'dashboard';
  const tab = TABS.find(item => item.id === requested);
  const denied = !tab || !canView(tab.permission);
  const refresh = () => setRevision(v => v + 1);
  const filters = Object.fromEntries(FILTER_KEYS.filter(key => params.has(key)).map(key => [key, params.get(key)]));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = [15, 25, 50, 100].includes(Number(params.get('limit'))) ? Number(params.get('limit')) : 25;
  const updateFilters = next => {
    const nextParams = new URLSearchParams(params);
    FILTER_KEYS.forEach(key => nextParams.delete(key));
    Object.entries(filterParams(next)).forEach(([key, value]) => nextParams.set(key, value));
    nextParams.delete('page'); setParams(nextParams, { replace: true });
  };
  const updatePage = patch => { const next = new URLSearchParams(params); Object.entries(patch).forEach(([key, value]) => next.set(key, value)); setParams(next); };
  const switchTab = next => setParams({ tab: next });
  const switchKind = kind => setParams({ tab: requested, sub: kind });
  const openRecord = (id, action) => { const next = new URLSearchParams(params); if (id) next.set('record', id); else next.delete('record'); if (action) next.set('action', action); else next.delete('action'); setParams(next); };
  const drill = descriptor => {
    if (!descriptor?.entity) return;
    const entity = descriptor.entity;
    const targetTab = KIND_TAB[entity] || descriptor.tab;
    if (!targetTab) return;
    const next = { tab: targetTab, ...filterParams(descriptor.filters) };
    if (['accounts', 'mappings', 'contacts', 'followups', 'tasks', 'history'].includes(entity)) next.sub = entity;
    if (descriptor.record) next.record = descriptor.record;
    setParams(next);
  };
  let kind = requested === 'discounting' ? 'funding' : requested === 'treds' ? params.get('sub') || 'accounts' : requested === 'masters' ? params.get('sub') || 'catalog' : requested === 'dashboard' && ['tasks', 'history'].includes(params.get('sub')) ? params.get('sub') : requested === 'enquiries' && params.get('sub') === 'followups' ? 'followups' : requested;
  const allowedKinds = requested === 'treds' ? ['accounts', 'mappings'] : requested === 'masters' ? ['catalog', 'contacts'] : requested === 'enquiries' ? ['enquiries', 'followups'] : [kind];
  if (!allowedKinds.includes(kind)) kind = allowedKinds[0];
  const common = { kind, options: options || {}, filters, onFilters: updateFilters, page, limit, onPage: updatePage, revision, onRefresh: refresh, recordId: params.get('record'), recordAction: params.get('action'), onRecord: openRecord };
  return <div className="space-y-4">
    <div><h2 className="text-xl font-bold text-slate-800">Vendor &amp; TReDS Management</h2><p className="text-sm text-slate-500 mt-1">Track vendor registration through bill discounting and funding.</p></div>
    <nav aria-label="Vendor and TReDS sections" className="flex gap-2 flex-wrap">{available.map(item => <button type="button" key={item.id} onClick={() => switchTab(item.id)} aria-current={item.id === requested ? 'page' : undefined} className={`px-3 py-2 rounded-lg text-xs font-semibold border ${item.id === requested ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'}`}>{item.label}</button>)}</nav>
    {denied ? <div className="card p-8 text-center text-slate-500">You do not have permission to view this section. Contact your administrator.</div> : <>
      <LoadState loading={loading} error={error} onRetry={refresh} />
      {options && !loading && !error && <>
        {requested === 'dashboard' && !['tasks', 'history'].includes(kind) && <Dashboard {...common} onDrill={drill} />}
        {kind === 'history' && <TrackerEvents {...common} onDrill={drill} />}
        {requested === 'reports' && <Reports {...common} />}
        {requested === 'masters' && <Masters {...common} onKind={switchKind} />}
        {requested === 'settings' && <Settings {...common} />}
        {['treds', 'enquiries'].includes(requested) && <div className="flex gap-2 flex-wrap">{allowedKinds.map(item => <button key={item} type="button" className={`btn ${kind === item ? 'btn-primary' : 'btn-secondary'}`} onClick={() => switchKind(item)}>{definition(options, item).label || item}</button>)}</div>}
        {!['reports', 'masters', 'settings'].includes(requested) && (requested !== 'dashboard' || kind === 'tasks') && (definition(options, kind).permission && canView(definition(options, kind).permission) ? <RecordList key={`${requested}-${kind}`} {...common} /> : <div className="card p-6 text-sm text-slate-500">This record type is not available for your access.</div>)}
      </>}
    </>}
  </div>;
}
