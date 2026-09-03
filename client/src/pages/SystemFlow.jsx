// SYSTEM FLOW & ERP IMPLEMENTATION CONTROL (mam 2026-09-01)
// One page, 8 deep-linkable tabs (?tab=) — the sidebar's ERP MANAGEMENT
// group items all land here. WHAT → WHO → WHEN → STATUS → WHY DELAYED →
// WHAT IS BLOCKING → HOW MANY AFFECTED → WHO MUST SOLVE IT.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';

const TABS = [
  { id: 'dashboard',    label: 'Flow Dashboard' },
  { id: 'flows',        label: 'System Flow' },
  { id: 'bottlenecks',  label: 'Bottleneck Center' },
  { id: 'timeline',     label: 'Timeline' },
  { id: 'performance',  label: 'Person Performance' },
  { id: 'escalations',  label: 'Escalations' },
  { id: 'master',       label: 'Step Master' },
];

const STATUS_META = {
  not_started: { label: 'Not Started', cls: 'bg-gray-100 text-gray-600',   icon: '○' },
  in_progress: { label: 'In Progress', cls: 'bg-blue-100 text-blue-700',   icon: '◔' },
  testing:     { label: 'Testing',     cls: 'bg-purple-100 text-purple-700', icon: '🧪' },
  waiting:     { label: 'Waiting',     cls: 'bg-amber-100 text-amber-700', icon: '⏳' },
  blocked:     { label: 'Blocked',     cls: 'bg-red-100 text-red-700',     icon: '🔴' },
  completed:   { label: 'Completed',   cls: 'bg-green-100 text-green-700', icon: '✅' },
  cancelled:   { label: 'Cancelled',   cls: 'bg-gray-100 text-gray-400 line-through', icon: '✕' },
};
const SEV_CLS = {
  none: 'bg-gray-100 text-gray-500', low: 'bg-yellow-100 text-yellow-700',
  medium: 'bg-amber-100 text-amber-800', high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-600 text-white',
};
const PRIORITIES = ['low', 'medium', 'high', 'critical'];

const StatusBadge = ({ s }) => {
  const m = STATUS_META[s] || STATUS_META.not_started;
  return <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${m.cls}`}>{m.icon} {m.label}</span>;
};
const SevBadge = ({ s }) => s && s !== 'none'
  ? <span className={`px-2 py-0.5 rounded-full text-xs font-semibold uppercase ${SEV_CLS[s]}`}>{s}</span> : null;

const fmtD = (d) => d ? new Date(d + (d.length === 10 ? 'T00:00:00' : '')).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : '—';

export default function SystemFlow() {
  const { canCreate, canEdit, canApprove, isAdmin } = useAuth();
  const [params, setParams] = useSearchParams();
  // Unknown/removed tab ids (e.g. the old ?tab=my) fall back to the dashboard.
  const rawTab = params.get('tab') || 'dashboard';
  const tab = TABS.some(t => t.id === rawTab) ? rawTab : 'dashboard';
  const setTab = (t) => setParams({ tab: t });

  const [meta, setMeta] = useState({ processes: [], steps: [], users: [], statuses: [], escalation: {} });
  const [flows, setFlows] = useState([]);
  const [dash, setDash] = useState(null);
  const [detailId, setDetailId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editFlow, setEditFlow] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = () => setRefreshKey(k => k + 1);

  useEffect(() => {
    api.get('/system-flow/meta').then(r => setMeta(r.data)).catch(() => toast.error('Could not load System Flow masters'));
  }, [refreshKey]);
  useEffect(() => {
    api.get('/system-flow/flows').then(r => setFlows(r.data)).catch(() => {});
    api.get('/system-flow/dashboard').then(r => setDash(r.data)).catch(() => {});
  }, [refreshKey]);

  const openDetail = (id) => setDetailId(id);

  return (
    <div className="p-4 md:p-6 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-bold">🛠️ ERP Management — System Flow</h1>
        <span className="text-xs text-gray-500 hidden md:inline">plan → assign → develop → test → complete, with automatic bottleneck detection</span>
        <div className="ml-auto flex gap-2">
          {canCreate('system_flow') && (
            <button onClick={() => setShowCreate(true)}
              className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">+ Create System Flow</button>
          )}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 overflow-x-auto border-b border-gray-200 -mb-px">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`px-3 py-2 text-sm whitespace-nowrap rounded-t-lg border-b-2 ${tab === t.id
              ? 'border-blue-600 text-blue-700 font-semibold bg-blue-50'
              : 'border-transparent text-gray-500 hover:text-gray-800'}`}>{t.label}</button>
        ))}
      </div>

      {tab === 'dashboard'   && <DashboardTab dash={dash} flows={flows} openDetail={openDetail} />}
      {tab === 'flows'       && <FlowsTab meta={meta} flows={flows} openDetail={openDetail} onEdit={setEditFlow} canEdit={canEdit('system_flow')} refreshKey={refreshKey} />}
      {tab === 'bottlenecks' && <BottlenecksTab openDetail={openDetail} refreshKey={refreshKey} />}
      {tab === 'timeline'    && <TimelineTab meta={meta} flows={flows} openDetail={openDetail} />}
      {tab === 'performance' && <PerformanceTab refreshKey={refreshKey} onPick={() => setTab('flows')} />}
      {tab === 'escalations' && <EscalationsTab openDetail={openDetail} refreshKey={refreshKey} />}
      {tab === 'master'      && <MasterTab meta={meta} canManage={canEdit('system_flow') || isAdmin()} refresh={refresh} />}

      {showCreate && <FlowModal meta={meta} flows={flows} onClose={() => setShowCreate(false)} onSaved={() => { setShowCreate(false); refresh(); }} />}
      {editFlow && <FlowModal meta={meta} flows={flows} flow={editFlow} onClose={() => setEditFlow(null)} onSaved={() => { setEditFlow(null); refresh(); }} />}
      {detailId && <DetailDrawer id={detailId} meta={meta} onClose={() => setDetailId(null)} onChanged={refresh}
        canApproveOverride={canApprove('system_flow') || isAdmin()} onEdit={(f) => { setDetailId(null); setEditFlow(f); }} canEdit={canEdit('system_flow')} />}
    </div>
  );
}

/* ─── Dashboard ──────────────────────────────────────────────────────── */
function DashboardTab({ dash, openDetail }) {
  const [report, setReport] = useState(null);
  if (!dash) return <div className="text-gray-400 py-10 text-center">Loading dashboard…</div>;
  const k = dash.kpis;
  const cards = [
    ['TOTAL STEPS', k.total, 'bg-slate-50 border-slate-200 text-slate-700'],
    ['COMPLETED', k.completed, 'bg-green-50 border-green-200 text-green-700'],
    ['IN PROGRESS', k.in_progress, 'bg-blue-50 border-blue-200 text-blue-700'],
    ['BLOCKED', k.blocked, 'bg-red-50 border-red-200 text-red-700'],
    ['OVERDUE', k.overdue, 'bg-orange-50 border-orange-200 text-orange-700'],
    ['DUE THIS WEEK', k.due_this_week, 'bg-amber-50 border-amber-200 text-amber-700'],
    ['COMPLETION %', `${k.completion_pct}%`, 'bg-emerald-50 border-emerald-200 text-emerald-700'],
    ['AVG DELAY', `${k.avg_delay}d`, 'bg-rose-50 border-rose-200 text-rose-700'],
  ];
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {cards.map(([label, val, cls]) => (
          <div key={label} className={`border rounded-xl p-3 ${cls}`}>
            <div className="text-[11px] font-semibold tracking-wide opacity-80">{label}</div>
            <div className="text-2xl font-bold">{val}</div>
          </div>
        ))}
      </div>

      {/* WHY IS THE FLOW STOPPED? */}
      <div className="bg-white border border-red-200 rounded-xl p-4">
        <h2 className="font-bold text-red-700 mb-3">🛑 WHY IS THE FLOW STOPPED?</h2>
        {dash.processes.filter(p => p.stopped_at).length === 0 && (
          <div className="text-sm text-green-700">No process is currently stopped — no blocked or overdue actionable step. 🎉</div>
        )}
        <div className="grid md:grid-cols-2 gap-3">
          {dash.processes.filter(p => p.stopped_at).map(p => (
            <div key={p.process_id} className="border border-red-100 bg-red-50/50 rounded-lg p-3 cursor-pointer hover:bg-red-50" onClick={() => openDetail(p.stopped_at.id)}>
              <div className="text-xs font-semibold text-gray-500">{p.process_name} FLOW</div>
              <div className="font-bold text-red-700">FLOW STOPPED AT: {p.stopped_at.step_name}</div>
              <div className="text-sm mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span className="text-gray-500">Owner</span><span className="font-medium">{p.stopped_at.owner}</span>
                <span className="text-gray-500">Reason</span><span>{p.stopped_at.reason || '—'}</span>
                <span className="text-gray-500">Downstream impact</span><span className="font-semibold">{p.stopped_at.downstream_impact} step(s) waiting</span>
                <span className="text-gray-500">Recommended action</span><span>{p.stopped_at.required_action}</span>
              </div>
              <div className="mt-1"><SevBadge s={p.stopped_at.severity} /></div>
            </div>
          ))}
        </div>
      </div>

      {/* Process flow visualization */}
      <div className="bg-white border rounded-xl p-4">
        <h2 className="font-bold mb-3">Process Flow</h2>
        {dash.processes.length === 0 && <div className="text-sm text-gray-400">No flows created yet — use “+ Create System Flow”.</div>}
        <div className="space-y-4">
          {dash.processes.map(p => {
            // Hierarchy: PROCESS → SYSTEM → its chain of steps (mam 2026-09-01:
            // "under process like 4 steps" — group by system under the process).
            const systems = [];
            for (const s of p.steps) {
              let g = systems.find(x => x.name === s.system_name);
              if (!g) { g = { name: s.system_name, steps: [] }; systems.push(g); }
              g.steps.push(s);
            }
            return (
              <div key={p.process_id} className="border border-gray-100 rounded-lg p-3 bg-gray-50/50">
                <div className="text-sm font-bold text-gray-700 tracking-wide mb-2">📁 {p.process_name}</div>
                <div className="space-y-2 pl-3 border-l-2 border-gray-200">
                  {systems.map(sys => (
                    <div key={sys.name}>
                      <div className="text-xs font-semibold text-blue-700 mb-1">🗂 {sys.name} <span className="text-gray-400 font-normal">({sys.steps.length} step{sys.steps.length > 1 ? 's' : ''})</span></div>
                      <div className="flex items-center gap-1 overflow-x-auto pb-1">
                        {sys.steps.map((s, i) => (
                          <div key={s.id} className="flex items-center gap-1 shrink-0">
                            {i > 0 && <span className="text-gray-300">→</span>}
                            <button onClick={() => openDetail(s.id)}
                              className={`text-left border rounded-lg px-3 py-2 min-w-[130px] hover:shadow transition
                                ${s.is_primary_bottleneck ? 'border-red-500 ring-2 ring-red-200 bg-red-50'
                                  : s.status === 'completed' ? 'border-green-200 bg-green-50'
                                  : s.derived_waiting || s.status === 'waiting' ? 'border-amber-200 bg-amber-50'
                                  : 'border-gray-200 bg-white'}`}>
                              <div className="text-sm font-semibold truncate max-w-[160px]">{s.step_name}</div>
                              <div className="text-xs text-gray-500 truncate">{s.owner}</div>
                              <div className="mt-1 flex items-center gap-1">
                                <StatusBadge s={s.derived_waiting && s.status === 'not_started' ? 'waiting' : s.status} />
                                {s.delay_days > 0 && <span className="text-xs font-bold text-red-600">{s.delay_days}d</span>}
                              </div>
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Weekly report */}
      <div className="bg-white border rounded-xl p-4">
        <div className="flex items-center gap-3">
          <h2 className="font-bold">Weekly Management Report</h2>
          <button onClick={() => api.get('/system-flow/weekly-report').then(r => setReport(r.data))}
            className="px-3 py-1 text-sm border rounded-lg hover:bg-gray-50">Generate</button>
        </div>
        {report && (
          <div className="mt-3 grid md:grid-cols-2 gap-4 text-sm">
            <div className="space-y-1">
              <div className="grid grid-cols-2 gap-x-4 gap-y-1">
                <span className="text-gray-500">Total steps</span><b>{report.total}</b>
                <span className="text-gray-500">Completed this week</span><b>{report.completed_this_week}</b>
                <span className="text-gray-500">New this week</span><b>{report.new_this_week}</b>
                <span className="text-gray-500">Pending</span><b>{report.pending}</b>
                <span className="text-gray-500">Blocked</span><b className="text-red-600">{report.blocked}</b>
                <span className="text-gray-500">Overdue</span><b className="text-orange-600">{report.overdue}</b>
                <span className="text-gray-500">Completion %</span><b>{report.completion_pct}%</b>
                <span className="text-gray-500">Avg delay</span><b>{report.avg_delay}d</b>
              </div>
              <div className="pt-2"><span className="text-gray-500">Systems completed this week:</span> {report.systems_completed_this_week.join(', ') || '—'}</div>
            </div>
            <div className="space-y-2">
              <div>
                <div className="font-semibold text-xs text-gray-500 uppercase">Top 5 bottlenecks</div>
                {report.top_bottlenecks.length === 0 && <div className="text-gray-400">none</div>}
                {report.top_bottlenecks.map(b => <div key={b.id}>{b.step_name} · {b.responsible_name} · <SevBadge s={b.severity} /></div>)}
              </div>
              <div>
                <div className="font-semibold text-xs text-gray-500 uppercase">Top delayed persons</div>
                {report.top_delayed_persons.map(p => <div key={p.person}>{p.person} — {p.delay} delay-days</div>)}
                {report.top_delayed_persons.length === 0 && <div className="text-gray-400">none</div>}
              </div>
              <div>
                <div className="font-semibold text-xs text-gray-500 uppercase">Systems with highest delay</div>
                {report.systems_highest_delay.map(s => <div key={s.system}>{s.system} — {s.delay} delay-days</div>)}
                {report.systems_highest_delay.length === 0 && <div className="text-gray-400">none</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Flows list ─────────────────────────────────────────────────────── */
const emptyFilters = { process: '', step: '', person: '', developer: '', status: '', priority: '', overdue: '', blocked: '', from: '', to: '', q: '' };
function FlowsTab({ meta, openDetail, onEdit, canEdit, refreshKey }) {
  const [filters, setFilters] = useState(emptyFilters);
  const [rows, setRows] = useState([]);
  const load = useCallback(() => {
    const qs = Object.entries(filters).filter(([, v]) => v !== '').map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    api.get(`/system-flow/flows${qs ? '?' + qs : ''}`).then(r => setRows(r.data)).catch(() => {});
  }, [filters]);
  // refreshKey: re-fetch after a save/edit/status change elsewhere on the
  // page — without it the table kept showing stale rows after Save Changes
  // (mam 2026-09-02: "if i edit not update").
  useEffect(() => { load(); }, [load, refreshKey]);

  const set = (k, v) => setFilters(f => ({ ...f, [k]: v }));
  const sel = 'border rounded-lg px-2 py-1.5 text-sm bg-white';

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center bg-white border rounded-xl p-3">
        <input placeholder="Search flow / step / person / remarks…" value={filters.q} onChange={e => set('q', e.target.value)} className={`${sel} w-56`} />
        <select value={filters.process} onChange={e => set('process', e.target.value)} className={sel}>
          <option value="">Process</option>{meta.processes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={filters.step} onChange={e => set('step', e.target.value)} className={sel}>
          <option value="">Step</option>{meta.steps.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
        <select value={filters.person} onChange={e => set('person', e.target.value)} className={sel}>
          <option value="">Responsible</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={filters.developer} onChange={e => set('developer', e.target.value)} className={sel}>
          <option value="">Developer</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={filters.status} onChange={e => set('status', e.target.value)} className={sel}>
          <option value="">Status</option>{Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <select value={filters.priority} onChange={e => set('priority', e.target.value)} className={sel}>
          <option value="">Priority</option>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={filters.overdue === '1'} onChange={e => set('overdue', e.target.checked ? '1' : '')} /> Overdue</label>
        <label className="text-sm flex items-center gap-1"><input type="checkbox" checked={filters.blocked === '1'} onChange={e => set('blocked', e.target.checked ? '1' : '')} /> Blocked</label>
        <input type="date" value={filters.from} onChange={e => set('from', e.target.value)} className={sel} title="Target from" />
        <input type="date" value={filters.to} onChange={e => set('to', e.target.value)} className={sel} title="Target to" />
        <button onClick={() => setFilters(emptyFilters)} className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">Clear Filters</button>
        <button onClick={() => exportCsv('system-flows',
          ['Flow ID','Process','System','Step','Seq','Responsible','Developer','Start','Target','Completed','Status','Priority','Delay Days','Downstream','Severity','Remarks'],
          rows.map(r => [r.flow_no, r.process_name, r.system_name, r.step_name, r.seq, r.responsible_name, r.developer_name,
            r.start_date, r.target_date, r.actual_completion_date || '', r.status, r.priority, r.delay_days, r.downstream_impact, r.severity, r.remarks || '']))}
          className="px-3 py-1.5 text-sm border rounded-lg hover:bg-gray-50">Export</button>
        <span className="text-xs text-gray-400 ml-auto">{rows.length} step(s)</span>
      </div>

      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
            {['Flow ID','Process','System','Step','Owner','Developer','Start','Target','Status','Priority','Delay','Waiting on','Downstream',''].map(h => <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b last:border-0 hover:bg-blue-50/40 cursor-pointer" onClick={() => openDetail(r.id)}>
                <td className="px-3 py-2 font-mono text-xs whitespace-nowrap">{r.flow_no}</td>
                <td className="px-3 py-2">{r.process_name}</td>
                <td className="px-3 py-2">{r.system_name}</td>
                <td className="px-3 py-2 font-medium">{r.step_name}<span className="text-gray-400 text-xs"> #{r.seq}</span></td>
                <td className="px-3 py-2">{r.responsible_name}</td>
                <td className="px-3 py-2">{r.developer_name}</td>
                <td className="px-3 py-2 whitespace-nowrap">{fmtD(r.start_date)}</td>
                <td className={`px-3 py-2 whitespace-nowrap ${r.is_overdue ? 'text-red-600 font-semibold' : ''}`}>{fmtD(r.target_date)}</td>
                <td className="px-3 py-2"><StatusBadge s={r.derived_waiting && r.status === 'not_started' ? 'waiting' : r.status} /></td>
                <td className="px-3 py-2 capitalize">{r.priority}</td>
                <td className="px-3 py-2">{r.delay_days > 0 ? <span className="text-red-600 font-bold">{r.delay_days}d</span> : '—'}</td>
                <td className="px-3 py-2 text-xs text-amber-700">{r.waiting_for || '—'}</td>
                <td className="px-3 py-2 text-center">{r.downstream_impact || '—'}</td>
                <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                  {canEdit && <button onClick={() => onEdit(r)} className="text-blue-600 text-xs hover:underline">Edit</button>}
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={14} className="px-3 py-8 text-center text-gray-400">No flows match these filters</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ─── Bottleneck Center ──────────────────────────────────────────────── */
function BottlenecksTab({ openDetail, refreshKey }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/system-flow/bottlenecks').then(r => setRows(r.data)).catch(() => {}); }, [refreshKey]);
  return (
    <div className="bg-white border rounded-xl overflow-x-auto">
      <table className="w-full text-sm">
        <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
          {['Rank','Flow ID','Process','System','Step','Owner','Developer','Delay','Blocked','Downstream Waiting','Depends On','Reason','Severity','Required Action'].map(h => <th key={h} className="px-3 py-2 whitespace-nowrap">{h}</th>)}
        </tr></thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.id} onClick={() => openDetail(r.id)}
              className={`border-b last:border-0 cursor-pointer hover:bg-blue-50/40 ${r.is_primary_bottleneck ? '' : 'opacity-60'}`}>
              <td className="px-3 py-2 font-bold">{r.is_primary_bottleneck ? `#${r.rank}` : '↳'}</td>
              <td className="px-3 py-2 font-mono text-xs">{r.flow_no}</td>
              <td className="px-3 py-2">{r.process_name}</td>
              <td className="px-3 py-2">{r.system_name}</td>
              <td className="px-3 py-2 font-medium">{r.step_name}{!r.is_primary_bottleneck && <span className="text-xs text-gray-400"> (downstream impacted)</span>}</td>
              <td className="px-3 py-2">{r.responsible_name}</td>
              <td className="px-3 py-2">{r.developer_name}</td>
              <td className="px-3 py-2">{r.delay_days > 0 ? <b className="text-red-600">{r.delay_days}d</b> : '—'}</td>
              <td className="px-3 py-2">{r.blocked_days > 0 ? <b className="text-red-600">{r.blocked_days}d</b> : '—'}</td>
              <td className="px-3 py-2 text-center font-semibold">{r.downstream_impact}</td>
              <td className="px-3 py-2 text-xs">{r.dep_step_name || '—'}</td>
              <td className="px-3 py-2 text-xs max-w-[220px] truncate" title={r.blocked_reason || ''}>{r.blocked_reason || (r.is_overdue ? 'Overdue' : r.derived_waiting ? `Waiting for ${r.waiting_for}` : '—')}</td>
              <td className="px-3 py-2" title={`score ${r.bottleneck_score} = delay ${r.score_parts.delay} + blocked ${r.score_parts.blocked} + downstream ${r.score_parts.downstream} + priority ${r.score_parts.priority}`}>
                <SevBadge s={r.severity} /></td>
              <td className="px-3 py-2 text-xs">{r.required_action || '—'}</td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={14} className="px-3 py-8 text-center text-green-600">No bottlenecks right now 🎉</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Timeline (CSS gantt) ───────────────────────────────────────────── */
function TimelineTab({ meta, flows, openDetail }) {
  const [f, setF] = useState({ process: '', person: '', status: '', priority: '' });
  const rows = flows.filter(r =>
    (!f.process || r.process_id === +f.process) &&
    (!f.person || r.responsible_id === +f.person) &&
    (!f.status || r.status === f.status) &&
    (!f.priority || r.priority === f.priority));
  const dates = rows.flatMap(r => [r.start_date, r.target_date, r.actual_completion_date].filter(Boolean));
  const min = dates.length ? dates.reduce((a, b) => a < b ? a : b) : null;
  const max = dates.length ? dates.reduce((a, b) => a > b ? a : b) : null;
  const span = min && max ? Math.max(1, (new Date(max) - new Date(min)) / 86400000) : 1;
  const pct = (d) => `${Math.min(100, Math.max(0, (new Date(d) - new Date(min)) / 86400000 / span * 100))}%`;
  const today = new Date().toISOString().slice(0, 10);
  const sel = 'border rounded-lg px-2 py-1.5 text-sm bg-white';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 bg-white border rounded-xl p-3">
        <select value={f.process} onChange={e => setF({ ...f, process: e.target.value })} className={sel}>
          <option value="">Process</option>{meta.processes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <select value={f.person} onChange={e => setF({ ...f, person: e.target.value })} className={sel}>
          <option value="">Person</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <select value={f.status} onChange={e => setF({ ...f, status: e.target.value })} className={sel}>
          <option value="">Status</option>{Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
        </select>
        <select value={f.priority} onChange={e => setF({ ...f, priority: e.target.value })} className={sel}>
          <option value="">Priority</option>{PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
        </select>
        <span className="text-xs text-gray-400 self-center ml-auto">{min && `${fmtD(min)} → ${fmtD(max)}`}</span>
      </div>
      <div className="bg-white border rounded-xl p-4 overflow-x-auto">
        {rows.length === 0 && <div className="text-gray-400 text-sm text-center py-6">No steps for these filters</div>}
        <div className="min-w-[640px] space-y-1.5 relative">
          {min && today >= min && today <= max && (
            <div className="absolute top-0 bottom-0 border-l-2 border-dashed border-blue-400 z-10" style={{ left: `calc(240px + (100% - 240px) * ${(new Date(today) - new Date(min)) / 86400000 / span})` }} title="Today" />
          )}
          {rows.map(r => {
            const end = r.actual_completion_date || (r.is_overdue ? today : r.target_date);
            const left = pct(r.start_date);
            const width = `${Math.max(2, (new Date(end) - new Date(r.start_date)) / 86400000 / span * 100)}%`;
            return (
              <div key={r.id} className="flex items-center gap-2 group cursor-pointer" onClick={() => openDetail(r.id)}>
                <div className="w-[240px] shrink-0 text-xs truncate">
                  <b>{r.step_name}</b> <span className="text-gray-400">· {r.responsible_name}</span>
                </div>
                <div className="flex-1 relative h-5 bg-gray-50 rounded">
                  <div className={`absolute h-5 rounded text-[10px] text-white px-1 flex items-center overflow-hidden group-hover:opacity-90
                    ${r.status === 'completed' ? 'bg-green-500' : r.is_overdue ? 'bg-red-500' : r.status === 'blocked' ? 'bg-red-400' : r.status === 'in_progress' || r.status === 'testing' ? 'bg-blue-500' : 'bg-gray-400'}`}
                    style={{ left, width }}>
                    {r.is_overdue ? `${r.delay_days}d late` : STATUS_META[r.status]?.label}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/* ─── Person performance ─────────────────────────────────────────────── */
function PerformanceTab({ refreshKey }) {
  const [rows, setRows] = useState([]);
  const [pick, setPick] = useState(null);
  const [pickRows, setPickRows] = useState([]);
  useEffect(() => { api.get('/system-flow/performance').then(r => setRows(r.data)).catch(() => {}); }, [refreshKey]);
  useEffect(() => {
    if (pick) api.get(`/system-flow/flows?person=${pick.person_id}`).then(r => setPickRows(r.data)).catch(() => {});
  }, [pick]);
  return (
    <div className="space-y-3">
      <div className="bg-white border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="text-left text-xs text-gray-500 border-b bg-gray-50">
            {['Person','Total','Completed','In Progress','Pending','Blocked','Overdue','Completion %','Avg Delay','Bottlenecks'].map(h => <th key={h} className="px-3 py-2">{h}</th>)}
          </tr></thead>
          <tbody>
            {rows.map(p => (
              <tr key={p.person_id} className="border-b last:border-0 hover:bg-blue-50/40 cursor-pointer" onClick={() => setPick(p)}>
                <td className="px-3 py-2 font-medium">{p.person}</td>
                <td className="px-3 py-2">{p.total}</td>
                <td className="px-3 py-2 text-green-700">{p.completed}</td>
                <td className="px-3 py-2 text-blue-700">{p.in_progress}</td>
                <td className="px-3 py-2">{p.pending}</td>
                <td className="px-3 py-2 text-red-600">{p.blocked}</td>
                <td className="px-3 py-2 text-orange-600">{p.overdue}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <div className="w-20 h-2 bg-gray-100 rounded-full overflow-hidden"><div className={`h-2 ${p.completion_pct >= 80 ? 'bg-green-500' : p.completion_pct >= 50 ? 'bg-amber-500' : 'bg-red-500'}`} style={{ width: `${p.completion_pct}%` }} /></div>
                    <b>{p.completion_pct}%</b>
                  </div>
                </td>
                <td className="px-3 py-2">{p.avg_delay}d</td>
                <td className="px-3 py-2 font-bold">{p.bottlenecks || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-400">No assignments yet</td></tr>}
          </tbody>
        </table>
      </div>
      {pick && (
        <div className="bg-white border rounded-xl p-3">
          <div className="font-semibold mb-2">{pick.person} — assigned steps</div>
          <div className="grid md:grid-cols-3 gap-2">
            {pickRows.map(r => (
              <div key={r.id} className="border rounded-lg p-2 text-sm">
                <div className="font-medium">{r.step_name}</div>
                <div className="text-xs text-gray-500">{r.process_name} · target {fmtD(r.target_date)}</div>
                <div className="mt-1 flex gap-1"><StatusBadge s={r.status} />{r.delay_days > 0 && <span className="text-xs text-red-600 font-bold">{r.delay_days}d</span>}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Escalations ────────────────────────────────────────────────────── */
function EscalationsTab({ openDetail, refreshKey }) {
  const [rows, setRows] = useState([]);
  useEffect(() => { api.get('/system-flow/escalations').then(r => setRows(r.data)).catch(() => {}); }, [refreshKey]);
  const LEVEL_CLS = { 3: 'border-red-300 bg-red-50', 2: 'border-orange-300 bg-orange-50', 1: 'border-amber-300 bg-amber-50' };
  return (
    <div className="space-y-2">
      {rows.length === 0 && <div className="text-green-700 text-sm bg-white border rounded-xl p-6 text-center">No escalations — nothing overdue or blocked beyond the configured thresholds 🎉</div>}
      {rows.map(r => (
        <button key={r.id} onClick={() => openDetail(r.id)} className={`w-full text-left border rounded-xl p-3 hover:shadow ${LEVEL_CLS[r.escalation_level]}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-red-700">🔴 {r.escalation_label}</span>
            <SevBadge s={r.severity} />
            <span className="font-mono text-xs text-gray-500 ml-auto">{r.flow_no}</span>
          </div>
          <div className="mt-1 grid md:grid-cols-4 gap-x-4 text-sm">
            <div><span className="text-gray-500">Task:</span> <b>{r.step_name}</b> ({r.system_name})</div>
            <div><span className="text-gray-500">Owner:</span> {r.responsible_name}</div>
            <div><span className="text-gray-500">Delay:</span> <b className="text-red-600">{Math.max(r.delay_days, r.blocked_days)} day(s)</b></div>
            <div><span className="text-gray-500">Impact:</span> {r.downstream_impact} downstream step(s)</div>
          </div>
          <div className="text-sm mt-0.5"><span className="text-gray-500">Action:</span> {r.required_action || (r.escalation_level === 3 ? 'Management review required' : r.escalation_level === 2 ? 'System head to intervene' : 'Owner to resolve')}</div>
        </button>
      ))}
    </div>
  );
}

/* ─── Step / Process master ──────────────────────────────────────────── */
function MasterTab({ meta, canManage, refresh }) {
  const [steps, setSteps] = useState([]);
  const [newStep, setNewStep] = useState('');
  const [newProc, setNewProc] = useState('');
  const load = () => api.get('/system-flow/steps').then(r => setSteps(r.data)).catch(() => {});
  useEffect(() => { load(); }, []);
  const addStep = async () => {
    if (!newStep.trim()) return;
    try { await api.post('/system-flow/steps', { name: newStep.trim() }); setNewStep(''); load(); refresh(); toast.success('Step added'); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const toggle = async (s) => {
    try { await api.put(`/system-flow/steps/${s.id}`, { active: s.active ? 0 : 1 }); load(); refresh(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const rename = async (s) => {
    const name = prompt('Rename step', s.name);
    if (!name || name === s.name) return;
    try { await api.put(`/system-flow/steps/${s.id}`, { name }); load(); refresh(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const setLink = async (s) => {
    const erp_path = prompt('ERP page this step links to (in-app path, e.g. /procurement). Empty = no link.', s.erp_path || '/');
    if (erp_path === null) return;
    try { await api.put(`/system-flow/steps/${s.id}`, { erp_path }); load(); refresh(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const addProc = async () => {
    if (!newProc.trim()) return;
    try { await api.post('/system-flow/processes', { name: newProc.trim() }); setNewProc(''); refresh(); toast.success('Process added'); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  return (
    <div className="grid md:grid-cols-2 gap-4">
      <div className="bg-white border rounded-xl p-4">
        <h2 className="font-bold mb-2">System Step Master</h2>
        <p className="text-xs text-gray-500 mb-3">The “System Step Name” dropdown loads from here. Deactivated steps disappear for NEW flows; old records keep them.</p>
        {canManage && (
          <div className="flex gap-2 mb-3">
            <input value={newStep} onChange={e => setNewStep(e.target.value)} onKeyDown={e => e.key === 'Enter' && addStep()}
              placeholder="New step name…" className="border rounded-lg px-3 py-1.5 text-sm flex-1" />
            <button onClick={addStep} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg">Add</button>
          </div>
        )}
        <div className="divide-y max-h-[480px] overflow-y-auto">
          {steps.map(s => (
            <div key={s.id} className="flex items-center gap-2 py-1.5 text-sm">
              <span className={s.active ? '' : 'text-gray-400 line-through'}>{s.name}</span>
              <span className="text-xs text-gray-400">({s.used_count} used)</span>
              {s.erp_path && <span className="text-xs text-blue-600 font-mono">🔗 {s.erp_path}</span>}
              {canManage && <span className="ml-auto flex gap-2">
                <button onClick={() => setLink(s)} className="text-blue-600 text-xs hover:underline">ERP Link</button>
                <button onClick={() => rename(s)} className="text-blue-600 text-xs hover:underline">Rename</button>
                <button onClick={() => toggle(s)} className={`text-xs hover:underline ${s.active ? 'text-red-600' : 'text-green-600'}`}>{s.active ? 'Deactivate' : 'Activate'}</button>
              </span>}
            </div>
          ))}
        </div>
      </div>
      <div className="bg-white border rounded-xl p-4">
        <h2 className="font-bold mb-2">Process Master</h2>
        {canManage && (
          <div className="flex gap-2 mb-3">
            <input value={newProc} onChange={e => setNewProc(e.target.value)} onKeyDown={e => e.key === 'Enter' && addProc()}
              placeholder="New process (e.g. QUALITY)…" className="border rounded-lg px-3 py-1.5 text-sm flex-1" />
            <button onClick={addProc} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg">Add</button>
          </div>
        )}
        <div className="divide-y">
          {meta.processes.map(p => <div key={p.id} className="py-1.5 text-sm">{p.name}</div>)}
        </div>
      </div>
    </div>
  );
}

/* ─── Create / Edit modal ────────────────────────────────────────────── */
function FlowModal({ meta, flows, flow, onClose, onSaved }) {
  const isEdit = !!flow;
  const [f, setF] = useState(() => flow ? {
    process_id: flow.process_id, system_name: flow.system_name, step_id: flow.step_id, seq: flow.seq,
    depends_on_id: flow.depends_on_id || '', responsible_id: flow.responsible_id, developer_id: flow.developer_id,
    start_date: flow.start_date, target_date: flow.target_date, priority: flow.priority, remarks: flow.remarks || '',
    required_action: flow.required_action || '',
  } : {
    process_id: '', system_name: '', step_id: '', seq: 1, depends_on_id: '', responsible_id: '', developer_id: '',
    start_date: new Date().toISOString().slice(0, 10), target_date: '', priority: 'medium', remarks: '', required_action: '',
  });
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setF(x => ({ ...x, [k]: v }));
  const inp = 'w-full border rounded-lg px-3 py-2 text-sm';
  const save = async () => {
    setSaving(true);
    try {
      if (isEdit) { await api.put(`/system-flow/flows/${flow.id}`, f); toast.success('Flow updated'); }
      else {
        const r = await api.post('/system-flow/flows', f);
        toast.success(`Flow Created Successfully — ${r.data.flow_no}`);
      }
      onSaved();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setSaving(false); }
  };
  const depOptions = flows.filter(r => !isEdit || r.id !== flow.id);
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start md:items-center justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl p-5" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold mb-4">{isEdit ? `Edit ${flow.flow_no}` : 'Create System Flow'}</h2>
        <div className="grid md:grid-cols-2 gap-3">
          <label className="text-sm">Process *<select value={f.process_id} onChange={e => set('process_id', e.target.value)} className={inp}>
            <option value="">— select —</option>{meta.processes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="text-sm">System Name *<input value={f.system_name} onChange={e => set('system_name', e.target.value)} className={inp} placeholder="e.g. Sales Management" /></label>
          <label className="text-sm">System Step Name * <span className="text-xs text-gray-400">(from Step Master)</span>
            <select value={f.step_id} onChange={e => set('step_id', e.target.value)} className={inp}>
              <option value="">— select —</option>{meta.steps.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
          <label className="text-sm">Step Sequence *<input type="number" min="1" value={f.seq} onChange={e => set('seq', e.target.value)} className={inp} /></label>
          <label className="text-sm md:col-span-2">Previous Step / Dependency<select value={f.depends_on_id} onChange={e => set('depends_on_id', e.target.value)} className={inp}>
            <option value="">— none —</option>
            {depOptions.map(r => <option key={r.id} value={r.id}>{r.flow_no} · {r.process_name} · {r.step_name}</option>)}</select></label>
          <label className="text-sm">Responsible Person *<select value={f.responsible_id} onChange={e => set('responsible_id', e.target.value)} className={inp}>
            <option value="">— select —</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="text-sm">Developer / Creator *<select value={f.developer_id} onChange={e => set('developer_id', e.target.value)} className={inp}>
            <option value="">— select —</option>{meta.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
          <label className="text-sm">Start Date *<input type="date" value={f.start_date} onChange={e => set('start_date', e.target.value)} className={inp} /></label>
          <label className="text-sm">Target Completion Date *<input type="date" value={f.target_date} onChange={e => set('target_date', e.target.value)} className={inp} /></label>
          <label className="text-sm">Priority<select value={f.priority} onChange={e => set('priority', e.target.value)} className={inp}>
            {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}</select></label>
          <label className="text-sm">Required Action<input value={f.required_action} onChange={e => set('required_action', e.target.value)} className={inp} placeholder="what unblocks this, if stuck" /></label>
          <label className="text-sm md:col-span-2">Remarks<textarea value={f.remarks} onChange={e => set('remarks', e.target.value)} className={inp} rows={2} /></label>
        </div>
        <div className="flex justify-end gap-2 mt-4">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg">Cancel</button>
          <button onClick={save} disabled={saving} className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg disabled:opacity-50">
            {saving ? 'Saving…' : isEdit ? 'Save Changes' : 'Create Flow'}</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Detail drawer + status update + activity ───────────────────────── */
function DetailDrawer({ id, onClose, onChanged, canApproveOverride, onEdit, canEdit }) {
  const { user } = useAuth();
  const [d, setD] = useState(null);
  const [status, setStatus] = useState('');
  const [blockedReason, setBlockedReason] = useState('');
  const [remarks, setRemarks] = useState('');
  const [progress, setProgress] = useState(0);
  const load = useCallback(() => {
    api.get(`/system-flow/flows/${id}`).then(r => {
      setD(r.data); setStatus(r.data.status); setProgress(r.data.progress || 0);
      setBlockedReason(r.data.blocked_reason || '');
    }).catch(() => toast.error('Could not load step'));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  const isOwn = d && (user?.id === d.responsible_id || user?.id === d.developer_id);
  const mayUpdate = isOwn || canEdit;

  const updateStatus = async (override = false) => {
    try {
      await api.put(`/system-flow/flows/${id}/status`, {
        status, blocked_reason: blockedReason, remarks: remarks || null, progress, override,
      });
      toast.success('Status updated'); setRemarks(''); load(); onChanged();
    } catch (e) {
      const r = e.response?.data;
      if (r?.need_override && canApproveOverride) {
        if (confirm(`Dependency is not completed yet. Override and complete anyway?`)) return updateStatus(true);
      } else toast.error(r?.error || 'Update failed');
    }
  };

  if (!d) return null;
  const Row = ({ l, v, cls }) => <div className="contents"><div className="text-gray-500">{l}</div><div className={`font-medium ${cls || ''}`}>{v ?? '—'}</div></div>;
  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex justify-end" onClick={onClose}>
      <div className="bg-white w-full max-w-xl h-full overflow-y-auto p-5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center gap-2">
          <h2 className="text-lg font-bold">{d.step_name}</h2>
          <span className="font-mono text-xs text-gray-400">{d.flow_no}</span>
          <span className="ml-auto flex gap-2 items-center">
            {canEdit && <button onClick={() => onEdit(d)} className="text-sm text-blue-600 hover:underline">Edit</button>}
            <button onClick={onClose} className="text-2xl leading-none text-gray-400 hover:text-gray-700">×</button>
          </span>
        </div>
        <div className="flex flex-wrap gap-2 mt-2">
          <StatusBadge s={d.derived_waiting && d.status === 'not_started' ? 'waiting' : d.status} />
          <SevBadge s={d.severity} />
          {d.is_primary_bottleneck ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-red-600 text-white">PRIMARY BOTTLENECK</span> : null}
          {d.is_overdue ? <span className="px-2 py-0.5 rounded-full text-xs font-bold bg-orange-100 text-orange-700">OVERDUE {d.delay_days}d</span> : null}
        </div>

        <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm mt-4">
          <Row l="Process" v={d.process_name} /><Row l="System" v={d.system_name} />
          <Row l="Sequence" v={`#${d.seq}`} /><Row l="Priority" v={d.priority} cls="capitalize" />
          <Row l="Owner (Responsible)" v={d.responsible_name} /><Row l="Developer" v={d.developer_name} />
          <Row l="Start Date" v={fmtD(d.start_date)} /><Row l="Target Date" v={fmtD(d.target_date)} cls={d.is_overdue ? 'text-red-600' : ''} />
          <Row l="Actual Completion" v={fmtD(d.actual_completion_date)} /><Row l="Progress" v={`${d.progress || 0}%`} />
          <Row l="Delay Days" v={d.delay_days > 0 ? `${d.delay_days}d` : '—'} cls={d.delay_days > 0 ? 'text-red-600' : ''} />
          <Row l="Blocked Days" v={d.blocked_days > 0 ? `${d.blocked_days}d` : '—'} cls="text-red-600" />
          <Row l="Downstream Impact" v={`${d.downstream_impact} step(s) waiting`} />
          <Row l="Bottleneck score" v={`${d.bottleneck_score} (delay ${d.score_parts?.delay} + blocked ${d.score_parts?.blocked} + downstream ${d.score_parts?.downstream} + priority ${d.score_parts?.priority})`} />
        </div>

        {/* Dependency */}
        <div className="mt-4 border rounded-xl p-3 bg-gray-50">
          <div className="text-xs font-bold text-gray-500 uppercase mb-1">Dependency</div>
          {d.depends_on_id ? (
            <div className="text-sm">Depends on: <b>{d.dep_step_name}</b> <span className="font-mono text-xs text-gray-400">{d.dep_flow_no}</span>
              <span className="ml-2"><StatusBadge s={d.dep_status} /></span>
              {d.dep_incomplete ? <div className="text-amber-700 text-xs mt-1">⏳ Waiting for {d.dep_step_name} to complete</div> : null}
            </div>
          ) : <div className="text-sm text-gray-400">No dependency — this step can start any time.</div>}
          {d.next_steps?.length > 0 && (
            <div className="text-sm mt-2">Next steps: {d.next_steps.map(n => <span key={n.id} className="inline-block mr-2">{n.step_name} <StatusBadge s={n.status} /></span>)}</div>
          )}
        </div>

        {d.blocked_reason && (
          <div className="mt-3 border border-red-200 bg-red-50 rounded-xl p-3 text-sm">
            <b className="text-red-700">Blocked reason:</b> {d.blocked_reason}
            {d.blocked_since && <div className="text-xs text-gray-500">since {fmtD(d.blocked_since.slice(0, 10))}</div>}
          </div>
        )}
        {d.required_action && <div className="mt-2 text-sm"><b>Required action:</b> {d.required_action}</div>}
        {d.remarks && <div className="mt-2 text-sm"><b>Remarks:</b> {d.remarks}</div>}

        {/* Actual ERP module link + live pending (mam 2026-09-01). The link
            is set by the step's DEVELOPER when the screen is built (mam
            2026-09-02) — logged to Activity History for performance review. */}
        <div className="mt-4 border border-blue-200 bg-blue-50/50 rounded-xl p-3">
          <div className="text-xs font-bold text-blue-700 uppercase mb-1">Actual ERP Module</div>
          <div className="flex flex-wrap items-center gap-3 text-sm">
            {d.erp_path ? (
              <button onClick={() => window.open(d.erp_path, '_blank')}
                className="px-3 py-1.5 bg-white border border-blue-300 text-blue-700 rounded-lg text-sm font-medium hover:bg-blue-100">
                🔗 Open {d.step_name} in ERP →
              </button>
            ) : (
              <span className="text-gray-500">No ERP link yet — the developer adds it once the screen is built.</span>
            )}
            {d.erp_pending && (
              <span className={`font-semibold ${d.erp_pending.count > 0 ? 'text-amber-700' : 'text-green-700'}`}>
                {d.erp_pending.count > 0 ? '⏳' : '✅'} {d.erp_pending.count} {d.erp_pending.label}
              </span>
            )}
            {mayUpdate && (
              <button onClick={async () => {
                const erp_path = prompt('ERP page for this step (in-app path, e.g. /leads):', d.erp_path || '/');
                if (!erp_path) return;
                try {
                  await api.put(`/system-flow/flows/${id}/erp-link`, { erp_path });
                  toast.success('ERP link saved — logged to activity'); load(); onChanged();
                } catch (e2) { toast.error(e2.response?.data?.error || 'Failed'); }
              }} className="text-xs text-blue-600 hover:underline ml-auto">{d.erp_path ? 'Change link' : '+ Add link'}</button>
            )}
          </div>
          <div className="text-xs text-gray-500 mt-1">
            {d.erp_path ? 'Live from the real module — verify there before marking this step done.'
              : 'Adding the link is part of delivering the step — it shows in Activity History with name and time.'}
          </div>
        </div>

        {/* Status update */}
        {mayUpdate && (
          <div className="mt-4 border rounded-xl p-3">
            <div className="text-xs font-bold text-gray-500 uppercase mb-2">Update Status</div>
            <div className="flex flex-wrap gap-2">
              <select value={status} onChange={e => setStatus(e.target.value)} className="border rounded-lg px-2 py-1.5 text-sm">
                {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
              <input type="number" min="0" max="100" value={progress} onChange={e => setProgress(e.target.value)}
                className="border rounded-lg px-2 py-1.5 text-sm w-24" title="Progress %" placeholder="%" />
              <button onClick={() => updateStatus(false)} className="px-3 py-1.5 bg-blue-600 text-white text-sm rounded-lg">Save</button>
            </div>
            {status === 'blocked' && (
              <input value={blockedReason} onChange={e => setBlockedReason(e.target.value)}
                placeholder="Blocked reason (required)" className="mt-2 w-full border rounded-lg px-3 py-1.5 text-sm" />
            )}
            <input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Remark for the activity log (optional)"
              className="mt-2 w-full border rounded-lg px-3 py-1.5 text-sm" />
          </div>
        )}

        {/* Activity history */}
        <div className="mt-4">
          <div className="text-xs font-bold text-gray-500 uppercase mb-2">Activity History</div>
          <div className="space-y-2">
            {d.activity?.map(a => (
              <div key={a.id} className="text-sm border-l-2 border-gray-200 pl-3">
                <div className="text-xs text-gray-400">{fmtDateTime(a.created_at)} · {a.user_name || 'system'}</div>
                <div><b className="capitalize">{a.action.replace(/_/g, ' ')}</b>
                  {a.old_value != null && a.new_value != null && <span className="text-gray-500"> — {String(a.old_value)} → {String(a.new_value)}</span>}
                  {a.old_value == null && a.new_value != null && <span className="text-gray-500"> — {String(a.new_value)}</span>}
                </div>
                {a.reason && <div className="text-xs text-gray-500">Reason: {a.reason}</div>}
              </div>
            ))}
            {(!d.activity || d.activity.length === 0) && <div className="text-sm text-gray-400">No activity yet</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
