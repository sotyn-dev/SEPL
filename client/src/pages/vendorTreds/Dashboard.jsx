import { useState } from 'react';
import { FiArrowRight, FiPlus, FiRefreshCw } from 'react-icons/fi';
import { useAuth } from '../../context/AuthContext';
import { Filters, LoadState, StatusBadge, Value } from '../../components/vendorTreds/Common';
import { useDebounced, useRemote } from '../../components/vendorTreds/hooks';
import { EntityForm } from '../../components/vendorTreds/Forms';
import { RecordDetail } from '../../components/vendorTreds/Records';
import { BASE, definition, fieldsFor, label, money, workflowStatusGroups } from '../../components/vendorTreds/model';

function metricValue(metric) {
  if (metric.value == null) return '—';
  if (['paise', 'money_paise', 'currency', 'INR'].includes(metric.unit)) return money(metric.value, true);
  if (metric.unit === 'percent') return `${metric.value}%`;
  return `${Number(metric.value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}${metric.unit === 'days' ? ' days' : ''}`;
}

function KpiCard({ metric, onDrill }) {
  const progress = metric.achievement_pct ?? metric.progress;
  return <button type="button" disabled={!metric.drilldown} onClick={() => onDrill(metric.drilldown)} className="card p-4 text-left hover:border-blue-400 focus-visible:outline-2 focus-visible:outline-blue-600 disabled:cursor-default">
    <div className="text-[11px] uppercase font-semibold tracking-wide text-slate-500">{metric.label || label(metric.key)}</div>
    <div className="text-2xl font-bold text-slate-800 mt-2 tabular-nums">{metricValue(metric)}</div>
    {metric.target != null && <p className="text-xs text-slate-500 mt-2">Target: {metricValue({ ...metric, value: metric.target })}</p>}
    {progress != null && <><div className="h-1.5 bg-slate-100 rounded-full mt-3 overflow-hidden"><div className={`h-full rounded-full ${Number(progress) >= 100 ? 'bg-emerald-500' : 'bg-blue-600'}`} style={{ width: `${Math.min(100, Math.max(0, Number(progress)))}%` }} /></div><p className="text-xs text-slate-500 mt-1">{Number(progress).toFixed(1)}% achieved</p></>}
    {metric.definition && <p className="text-[11px] text-slate-500 mt-2">{metric.definition}</p>}
    {metric.drilldown && <div className="flex items-center gap-1 text-blue-700 text-xs mt-3">View records <FiArrowRight /></div>}
  </button>;
}

function PlatformCard({ platform, onDrill }) {
  return <article className="border rounded-lg p-3 space-y-2"><h5 className="text-sm font-semibold">{platform.label || platform.name}</h5><button type="button" className="text-xs text-blue-700" onClick={() => onDrill(platform.drilldowns?.total || platform.drilldown || { entity: 'accounts', filters: { platform_id: platform.id } })}>{platform.accounts ?? platform.total ?? '—'} accounts</button><div className="flex flex-wrap gap-3 text-xs">{['active', 'frozen', 'inactive'].map(status => <button type="button" key={status} className={status === 'active' ? 'text-emerald-700' : status === 'frozen' ? 'text-red-700' : 'text-slate-600'} onClick={() => onDrill(platform.drilldowns?.[status] || { entity: 'accounts', filters: { platform_id: platform.id, effective_account_status: status } })}>{platform[status] ?? '—'} {status}</button>)}</div></article>;
}

export default function Dashboard({ options, filters, onFilters, revision, onRefresh, onDrill }) {
  const { canCreate, canEdit, canView } = useAuth();
  const [newTask, setNewTask] = useState(false); const [taskId, setTaskId] = useState(null); const [editingTask, setEditingTask] = useState(null);
  const search = useDebounced(filters.search || '');
  const { data, error, loading } = useRemote(`${BASE}/dashboard`, { ...filters, search }, revision);
  const taskDef = definition(options, 'tasks');
  const tasks = Array.isArray(data?.tasks) ? data.tasks : data?.tasks?.rows || [];
  const funding = data?.funding_metrics || (Array.isArray(data?.funding) ? data.funding : Object.entries(data?.funding || {}).map(([key, value]) => typeof value === 'object' && value !== null ? { key, ...value } : { key, label: label(key), value, unit: /paise|value|amount/.test(key) ? 'paise' : /percent|discount/.test(key) ? 'percent' : /time|days/.test(key) ? 'days' : 'count', drilldown: { entity: 'funding', filters: {} } }));
  const platforms = data?.platform_summary || data?.platforms || [];
  return <div className="space-y-4">
    <div className="flex flex-wrap justify-between items-center gap-3"><div><h3 className="text-lg font-semibold text-slate-800">Management Dashboard</h3><p className="text-xs text-slate-500 mt-1">Registrations → Approval → Enquiries → TReDS → Invoices → Funding</p></div><button className="btn btn-secondary inline-flex gap-2 items-center" onClick={onRefresh}><FiRefreshCw />Refresh</button></div>
    <Filters value={filters} onChange={onFilters} statusGroups={workflowStatusGroups(options, canView)} sourceLabel="Registration source" sourceOptions={fieldsFor(definition(options, 'registrations')).find(field => field.key === 'source')?.options || []} tredsStatuses={definition(options, 'accounts').statuses || []} />
    <LoadState loading={loading} error={error} onRetry={onRefresh} />
    {!loading && !error && data && <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{(data.cards || []).map(metric => <KpiCard key={metric.key} metric={metric} onDrill={onDrill} />)}</div>
      <section className="card p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2"><h4 className="font-semibold text-slate-800">Today’s Tasks</h4>{taskDef.permission && canCreate(taskDef.permission) && <button type="button" className="btn btn-primary text-xs inline-flex gap-1 items-center" onClick={() => setNewTask(true)}><FiPlus />New task</button>}</div>
        {tasks.length ? <div className="space-y-2">{tasks.map(task => <button key={task.id} type="button" onClick={() => setTaskId(task.id)} className="w-full rounded-xl border p-3 text-left hover:border-blue-300"><div className="flex flex-wrap items-center gap-2"><span className="font-medium text-sm flex-1 break-words">{task.title || task.instructions || `Task #${task.id}`}</span><StatusBadge value={task.display_status || task.status} /></div><div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500 mt-2"><span>{task.owner_name || 'Unassigned'}</span><span>Due: <Value field={{ type: 'date' }} value={task.due_date} /></span>{task.priority && <span>{label(task.priority)} priority</span>}{task.reminder_at && <span>Reminder: <Value fieldKey="reminder_at" value={task.reminder_at} /></span>}</div></button>)}</div> : <p className="text-sm text-slate-500 py-4">No tasks due today.</p>}
        {(data.tasks?.total || 0) > tasks.length && <button type="button" className="text-blue-700 text-sm" onClick={() => onDrill({ entity: 'tasks', filters: { date_from: data.today, date_to: data.today } })}>View all {data.tasks.total} tasks</button>}
      </section>
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <section className="card p-4 xl:col-span-2 space-y-3"><div><h4 className="font-semibold text-slate-800">Weekly KPI Summary</h4>{data.period && <p className="text-xs text-slate-500 mt-1">{data.period.week_start} – {data.period.week_end}{data.period.program_week ? ` · Program week ${data.period.program_week}` : ''}</p>}</div>
          <div className="space-y-2">{(data.weekly_kpis || []).map(metric => <button key={metric.key} type="button" disabled={!metric.drilldown} onClick={() => onDrill(metric.drilldown)} className="w-full border rounded-lg p-3 text-left hover:border-blue-300"><div className="flex flex-wrap justify-between gap-2"><span className="text-sm font-medium">{metric.label}</span>{metric.status && <StatusBadge value={metric.status} />}</div><div className="grid grid-cols-3 gap-2 text-xs mt-2"><div className="text-slate-500">Target <b className="block text-slate-800 mt-1">{metricValue({ ...metric, value: metric.target })}</b></div><div className="text-slate-500">Actual <b className="block text-slate-800 mt-1">{metricValue(metric)}</b></div><div className="text-slate-500">Achievement <b className="block text-slate-800 mt-1">{metric.achievement_pct == null ? '—' : `${metric.achievement_pct}%`}</b></div></div>{metric.definition && <p className="text-[11px] text-slate-500 mt-2">{metric.definition}</p>}</button>)}</div>
          {!data.weekly_kpis?.length && <p className="text-sm text-slate-500">No configured KPIs available for your access.</p>}
        </section>
        <section className="card p-4 space-y-3"><h4 className="font-semibold text-slate-800">TReDS Platform Status</h4>{platforms.map(platform => <PlatformCard key={platform.id || platform.key} platform={platform} onDrill={onDrill} />)}{!platforms.length && <p className="text-sm text-slate-500">No platform status available.</p>}</section>
      </div>
      {funding.length > 0 && <section className="space-y-3"><h4 className="font-semibold text-slate-800">Funding Dashboard</h4><div className="grid grid-cols-2 xl:grid-cols-4 gap-3">{funding.map(metric => <KpiCard key={metric.key} metric={metric} onDrill={onDrill} />)}</div></section>}
      <div className="flex flex-wrap gap-2">{options.navigation?.map(item => canView(item.permission) && <button key={item.id} className="btn btn-secondary" onClick={() => onDrill({ entity: item.entity, filters: {} })}>{item.label}</button>)}</div>
    </>}
    {newTask && <EntityForm kind="tasks" def={taskDef} onClose={() => setNewTask(false)} onSaved={() => { setNewTask(false); onRefresh(); }} />}
    {taskId && <RecordDetail kind="tasks" id={taskId} options={options} revision={revision} onRefresh={onRefresh} onClose={() => setTaskId(null)} onEdit={record => { if (canEdit(taskDef.permission)) setEditingTask(record); }} />}
    {editingTask && <EntityForm kind="tasks" def={taskDef} record={editingTask} onClose={() => setEditingTask(null)} onSaved={() => { setEditingTask(null); onRefresh(); }} />}
  </div>;
}
