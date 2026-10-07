import { useState } from 'react';
import { useAuth } from '../../context/AuthContext';
import { Filters, LoadState, Value } from '../../components/vendorTreds/Common';
import { useDebounced, useRemote } from '../../components/vendorTreds/hooks';
import { History } from '../../components/vendorTreds/Forms';
import { ServerPager } from '../../components/vendorTreds/Records';
import { BASE, definition, label, workflowStatusGroups } from '../../components/vendorTreds/model';

export default function TrackerEvents({ options, filters, onFilters, page, limit, onPage, revision, onDrill }) {
  const [expanded, setExpanded] = useState(null);
  const { canView } = useAuth();
  const search = useDebounced(filters.search || '');
  const { data, loading, error } = useRemote(`${BASE}/history`, { ...filters, search, page, limit }, revision);
  const rows = data?.rows || [];
  return <section className="space-y-4"><div><h3 className="text-lg font-semibold text-slate-800">Same-day Tracker Events</h3><p className="text-xs text-slate-500 mt-1">Recorded business events that make up the tracker-update KPI.</p></div><Filters value={filters} onChange={onFilters} statusGroups={workflowStatusGroups(options, canView).filter(group => group.entity !== 'tasks')} /><LoadState loading={loading} error={error} empty={!loading && !error && !rows.length} />{rows.map((row, index) => <article key={row.id || index} className="card p-3 space-y-2"><div className="flex flex-wrap gap-2 items-center"><h4 className="font-semibold text-sm flex-1">{label(row.entity_type || row.entity)} #{row.entity_id} · {label(row.event)}</h4><span className={`badge ${row.same_day ? 'badge-green' : 'badge-yellow'}`}>{row.same_day ? 'Updated same day' : 'Updated later'}</span></div><div className="text-xs text-slate-500 flex flex-wrap gap-3"><span>{row.actor_name || row.owner_name || '—'}</span><span>Business event: <Value field={{ type: 'date' }} value={row.happened_date || row.event_date || row.business_date} /></span><span>Recorded: <Value fieldKey="changed_at" value={row.changed_at || row.created_at} /></span></div><div className="flex flex-wrap gap-3 text-xs"><button className="text-blue-700" onClick={() => setExpanded(expanded === index ? null : index)}>Recorded changes</button>{canView(definition(options, row.entity_type).permission) && <button className="text-blue-700" onClick={() => onDrill({ entity: row.entity_type, record: row.entity_id, filters: {} })}>Open record</button>}</div>{expanded === index && <History rows={[row]} />}</article>)}<ServerPager page={page} limit={limit} total={data?.total || 0} onChange={onPage} /></section>;
}
