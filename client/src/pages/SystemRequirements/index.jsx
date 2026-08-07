import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { useUrlTab } from '../../hooks/useUrlTab';
import {
  FiPlus, FiSettings, FiRefreshCw, FiSearch, FiClipboard, FiX,
} from 'react-icons/fi';
import { exportCsv } from '../../utils/exportCsv';
import { fmtDate, fmtDateTime } from '../../utils/datetime';
import CreateModal from './CreateModal';
import SettingsModal from './SettingsModal';
import {
  TYPES, PRIORITIES, FILTER_STATUSES, STATUSES, STATUS_COLORS, PRIORITY_COLORS,
  REPORTS, labelOf,
} from './constants';

function FilterStat({ label, value, active, onClick, tone = 'neutral' }) {
  const tones = {
    neutral: active
      ? 'bg-gray-900 text-white'
      : 'text-gray-700 hover:bg-gray-100',
    warn: active
      ? 'bg-amber-600 text-white'
      : 'text-gray-700 hover:bg-gray-100',
    danger: active
      ? 'bg-red-600 text-white'
      : 'text-gray-700 hover:bg-gray-100',
    info: active
      ? 'bg-sky-600 text-white'
      : 'text-gray-700 hover:bg-gray-100',
    success: active
      ? 'bg-emerald-600 text-white'
      : 'text-gray-700 hover:bg-gray-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between gap-2 px-2 py-0.5 rounded text-left text-xs transition-colors lg:text-sm ${tones[tone]}`}
    >
      <span className={`truncate ${active ? 'font-medium' : ''}`}>{label}</span>
      <span className={`shrink-0 tabular-nums font-semibold ${active ? 'opacity-100' : 'opacity-80'}`}>
        {value ?? 0}
      </span>
    </button>
  );
}

export default function SystemRequirementsBoard() {
  const navigate = useNavigate();
  const [tab, setTab] = useUrlTab(['board', 'reports'], 'board');
  const [dash, setDash] = useState(null);
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [priority, setPriority] = useState('');
  const [type, setType] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [stale, setStale] = useState(false);
  const [inactiveAssignee, setInactiveAssignee] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [canEditSettings, setCanEditSettings] = useState(false);
  const [canViewWorkload, setCanViewWorkload] = useState(false);
  const [isTechOperator, setIsTechOperator] = useState(false);
  const [reportKey, setReportKey] = useState('by_status');
  const [report, setReport] = useState(null);

  const loadDash = useCallback(async () => {
    try {
      const { data } = await api.get('/system-requirements/dashboard');
      setDash(data);
    } catch {
      toast.error('Dashboard failed to load');
    }
  }, []);

  useEffect(() => {
    api.get('/system-requirements/meta')
      .then(r => {
        const me = r.data?.me || {};
        setCanEditSettings(!!me.can_edit_settings);
        setCanViewWorkload(!!(me.is_admin || me.is_it_manager));
        setIsTechOperator(!!(me.is_tech_operator || me.is_staff));
      })
      .catch(() => {
        setCanEditSettings(false);
        setCanViewWorkload(false);
        setIsTechOperator(false);
      });
  }, []);

  const loadList = useCallback(async () => {
    try {
      const params = { hide_done: '1', limit: 100 };
      if (q) params.q = q;
      if (status) params.status = status;
      if (priority) params.priority = priority;
      if (type) params.type = type;
      if (overdue) params.overdue = '1';
      if (stale) params.stale = '1';
      if (inactiveAssignee) params.inactive_assignee = '1';
      const { data } = await api.get('/system-requirements', { params });
      setRows(data.rows || []);
      setTotal(data.total || 0);
    } catch {
      toast.error('List failed to load');
    }
  }, [q, status, priority, type, overdue, stale, inactiveAssignee]);

  const loadReport = useCallback(async () => {
    try {
      const { data } = await api.get(`/system-requirements/reports/${reportKey}`);
      setReport(data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Report failed');
    }
  }, [reportKey]);

  useEffect(() => { loadDash(); }, [loadDash]);
  useEffect(() => { if (tab === 'board') loadList(); }, [tab, loadList]);
  useEffect(() => { if (tab === 'reports' && isTechOperator) loadReport(); }, [tab, loadReport, isTechOperator]);
  useEffect(() => {
    if (!isTechOperator && tab === 'reports') setTab('board');
  }, [isTechOperator, tab, setTab]);

  const hasFilters = !!(q || status || priority || type || overdue || stale || inactiveAssignee);

  const clearFilters = () => {
    setQ('');
    setStatus('');
    setPriority('');
    setType('');
    setOverdue(false);
    setStale(false);
    setInactiveAssignee(false);
  };

  const applyChip = (kind) => {
    setOverdue(false);
    setStale(false);
    setInactiveAssignee(false);
    setStatus('');
    if (kind === 'waiting') setStatus('under_review');
    else if (kind === 'it') setStatus('submitted');
    else if (kind === 'pending') setStatus('pending');
    else if (kind === 'progress') setStatus('in_progress');
    else if (kind === 'testing') setStatus('testing');
    else if (kind === 'clarification') setStatus('need_clarification');
    else if (kind === 'overdue') setOverdue(true);
    else if (kind === 'stale') setStale(true);
    else if (kind === 'inactive') setInactiveAssignee(true);
    else if (kind === 'high') setPriority('high,urgent');
    setTab('board');
  };

  const exportReport = () => {
    if (!report) return;
    if (report.rows) {
      exportCsv(`sysreq-${reportKey}`, report.rows);
      return;
    }
    if (report.averages) {
      exportCsv(`sysreq-${reportKey}`, [
        ...Object.entries(report.averages).map(([k, v]) => ({ metric: k, days: v })),
        ...(report.outcomes || []).map(o => ({ metric: o.status, days: o.cnt })),
      ]);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiClipboard className="text-red-600" /> System Requirements
          </h2>
          <p className="text-sm text-gray-500">Track ERP ideas from request to release</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => { loadDash(); loadList(); }} className="px-3 py-2 text-sm rounded-lg border border-gray-300 inline-flex items-center gap-1">
            <FiRefreshCw size={14} /> Refresh
          </button>
          {canEditSettings && (
            <button type="button" onClick={() => setSettingsOpen(true)} className="px-3 py-2 text-sm rounded-lg border border-gray-300 inline-flex items-center gap-1">
              <FiSettings size={14} /> Settings
            </button>
          )}
          <button type="button" onClick={() => setCreateOpen(true)} className="px-3 py-2 btn-primary text-sm rounded-lg text-white inline-flex items-center gap-1">
            <FiPlus size={14} /> New
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {(isTechOperator ? ['board', 'reports'] : ['board']).map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize border-b-2 ${
              tab === t ? 'border-red-600 text-red-700 font-medium' : 'border-transparent text-gray-500'
            }`}
          >
            {t === 'board' ? (isTechOperator ? 'Control Center' : 'My tickets') : 'Reports'}
          </button>
        ))}
      </div>

      {tab === 'board' && (
        <>
          <div className="flex items-stretch gap-4 max-xl:flex-col">
            <div className="card p-2 flex-1">
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-x-2 gap-y-0.5">
                <FilterStat
                  label="Open work"
                  value={dash?.counts?.open}
                  active={!status && !overdue && !stale && !inactiveAssignee}
                  onClick={() => { setStatus(''); setOverdue(false); setStale(false); setInactiveAssignee(false); }}
                />
                <FilterStat
                  label="Waiting / Backlog"
                  value={dash?.counts?.with_it_managers}
                  tone="warn"
                  active={status === 'submitted'}
                  onClick={() => applyChip('it')}
                />
                <FilterStat
                  label="Business approval"
                  value={dash?.counts?.waiting_approval}
                  tone="warn"
                  active={status === 'under_review'}
                  onClick={() => applyChip('waiting')}
                />
                <FilterStat
                  label="Need clarification"
                  value={dash?.counts?.need_clarification}
                  tone="warn"
                  active={status === 'need_clarification'}
                  onClick={() => applyChip('clarification')}
                />
                <FilterStat
                  label="Pending"
                  value={dash?.counts?.pending}
                  tone="info"
                  active={status === 'pending'}
                  onClick={() => applyChip('pending')}
                />
                <FilterStat
                  label="In Progress"
                  value={dash?.counts?.in_progress}
                  tone="info"
                  active={status === 'in_progress'}
                  onClick={() => applyChip('progress')}
                />
                <FilterStat
                  label="Testing"
                  value={dash?.counts?.testing}
                  tone="info"
                  active={status === 'testing'}
                  onClick={() => applyChip('testing')}
                />
                <FilterStat
                  label="Released / Done (month)"
                  value={dash?.counts?.released_this_month}
                  tone="success"
                  active={status === 'released,done'}
                  onClick={() => { setOverdue(false); setStale(false); setInactiveAssignee(false); setStatus('released,done'); }}
                />
                <FilterStat
                  label="Overdue"
                  value={dash?.counts?.overdue}
                  tone="danger"
                  active={overdue}
                  onClick={() => applyChip('overdue')}
                />
                <FilterStat
                  label="Inactive assignee"
                  value={dash?.counts?.inactive_assignee}
                  tone="danger"
                  active={inactiveAssignee}
                  onClick={() => applyChip('inactive')}
                />
                <FilterStat
                  label="Stale (14d)"
                  value={dash?.counts?.stale}
                  tone="warn"
                  active={stale}
                  onClick={() => applyChip('stale')}
                />
              </div>
            </div>

            {canViewWorkload && (dash?.assignee_workload || []).length > 0 && (
              <div className="xl:w-[32.3%] xl:pl-2.5">
                <div className="text-xs font-semibold text-gray-500 mb-2">Open work by assignee</div>
                <div className="flex flex-wrap gap-2">
                  {dash.assignee_workload.map(a => (
                    <span key={a.id} className="cursor-default text-xs px-2 py-1 rounded bg-white border border-gray-200 text-gray-700">
                      {a.name} <strong>{a.cnt}</strong>
                    </span>
                  ))}
                </div>
              </div>
            )}

          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 card p-0 overflow-hidden">
              <div className="p-3 border-b grid grid-cols-1 sm:grid-cols-3 xl:grid-cols-4 gap-2 items-center">
                <div className="relative sm:col-span-3 xl:col-span-4">
                  <FiSearch className="absolute left-2 top-3.5 text-gray-400" size={14} />
                  <input
                    className="input w-full pl-8"
                    placeholder="Search number, title…"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                  />
                </div>
                <select className="input !text-sm !pl-2" value={type} onChange={e => setType(e.target.value)}>
                  <option value="">All types</option>
                  {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select className="input !text-sm !pl-2" value={priority} onChange={e => setPriority(e.target.value)}>
                  <option value="">All priorities</option>
                  {PRIORITIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  <option value="high,urgent">High + Urgent</option>
                </select>
                <select className="input !text-sm !pl-2" value={status} onChange={e => setStatus(e.target.value)}>
                  <option value="">Open work</option>
                  {FILTER_STATUSES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                {
                  hasFilters && (
                    <button
                      type="button"
                      onClick={clearFilters}
                      className="btn btn-secondary inline-flex items-center justify-center gap-1 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-gray-50"
                    >
                      <FiX size={14} /> Clear filters
                    </button>
                  )
                }
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left text-xs text-gray-500">
                    <tr>
                      <th className="px-3 py-2">Req</th>
                      <th className="px-3 py-2">Title</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2">Priority</th>
                      <th className="px-3 py-2">Assignee</th>
                      <th className="px-3 py-2">Due</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.length === 0 && (
                      <tr><td colSpan={6} className="px-3 py-8 text-center text-gray-400">No requirements match.</td></tr>
                    )}
                    {rows.map(r => (
                      <tr
                        key={r.id}
                        className={`border-t border-gray-100 hover:bg-red-50/40 cursor-pointer ${
                          r.assignee_inactive ? 'bg-amber-50/80 border-l-4 border-l-amber-500' : ''
                        }`}
                        onClick={() => navigate(`/system-requirements/${r.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs text-gray-500">{r.req_number}</td>
                        <td className="px-3 py-2 font-medium text-gray-800 text-xs min-w-[200]">{r.title}</td>
                        <td className="px-3 py-2">
                          <span className={`text-nowrap text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[r.status]}`}>
                            {labelOf(STATUSES, r.status)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_COLORS[r.priority]}`}>
                            {labelOf(PRIORITIES, r.priority)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">
                          <span className="inline-flex items-center gap-1.5 flex-wrap text-xs">
                            {r.assignee_name || '—'}
                            {r.assignee_inactive && (
                              <span className="text-[10px] uppercase tracking-wide font-semibold bg-amber-200 text-amber-900 rounded px-1.5 py-0.5">
                                Inactive
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="text-xs px-3 py-2 text-gray-600">{r.due_date ? fmtDate(r.due_date) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 text-xs text-gray-400 border-t">{total} shown (active filter)</div>
            </div>

            <div className="space-y-4">
              <div className="card p-3">
                <div className="text-xs font-semibold text-gray-500 mb-2 flex items-center justify-between">
                  <span>My assigned</span>
                  <span className="text-xs text-blue-800">{`( ${(dash?.my_assigned || []).length} )`}</span>
                </div>
                <ul className="space-y-2 overflow-y-auto max-h-[300px]">
                  {(dash?.my_assigned || []).length === 0 && <li className="text-sm text-gray-400">None assigned to you.</li>}
                  {(dash?.my_assigned || []).map(r => (
                    <li key={r.id}>
                      <Link to={`/system-requirements/${r.id}`} className="text-sm text-gray-800 hover:text-red-700">
                        {r.req_number} — {r.title}
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
              <div className="card p-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">Recent activity</div>
                <ul className="space-y-2 max-h-64 overflow-y-auto">
                  {(dash?.recent_activity || []).length === 0 && <li className="text-sm text-gray-400">Nothing yet.</li>}
                  {(dash?.recent_activity || []).map(a => (
                    <li key={a.id} className="text-xs">
                      <Link to={`/system-requirements/${a.requirement_id}`} className="font-medium text-gray-800 hover:text-red-700">
                        {a.req_number}
                      </Link>
                      <span className="text-gray-500"> · {a.event_type.replace(/_/g, ' ')}</span>
                      <div className="text-gray-400">{a.actor_name || 'System'} · {fmtDateTime(a.created_at)}</div>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>
        </>
      )}

      {tab === 'reports' && (
        <div className="space-y-4 min-h-[60vh]">
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input max-w-[240px]" value={reportKey} onChange={e => setReportKey(e.target.value)}>
              {REPORTS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button type="button" onClick={loadReport} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white">Run</button>
            <button type="button" onClick={exportReport} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Export CSV</button>
          </div>
          {(() => {
            const hasRows = (report?.rows || []).length > 0;
            const hasOutcomes = (report?.outcomes || []).length > 0;
            const hasAverages = report?.averages && Object.keys(report.averages).length > 0;
            const hasByMonth = (report?.by_month || []).length > 0;
            const hasReportData = hasRows || hasOutcomes || hasAverages || hasByMonth;

            if (!report) {
              return (
                <div className="card p-8 text-center text-sm text-gray-400">
                  Pick a report and click Run.
                </div>
              );
            }

            if (!hasReportData) {
              return (
                <div className="card p-8 text-center text-sm text-gray-400">
                  No reports found.
                </div>
              );
            }

            return (
              <div className="card p-0 overflow-hidden">
                {hasAverages && (
                  <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                    {Object.entries(report.averages).map(([k, v]) => (
                      <div key={k} className="bg-gray-50 rounded-xl p-3">
                        <div className="text-xs text-gray-500 capitalize">{k.replace(/_/g, ' ')}</div>
                        <div className="text-xl font-semibold">{v == null ? '—' : `${v}d`}</div>
                      </div>
                    ))}
                  </div>
                )}
                {hasByMonth && (
                  <div className="p-4 flex flex-wrap gap-2 border-b">
                    {report.by_month.map(m => (
                      <span key={m.month} className="text-xs px-2 py-1 rounded-lg bg-emerald-50 text-emerald-800">{m.month}: {m.cnt}</span>
                    ))}
                  </div>
                )}
                {(hasRows || hasOutcomes) && (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 text-left text-xs text-gray-500">
                      <tr>
                        {hasRows && Object.keys(report.rows[0]).map(k => (
                          <th key={k} className="px-3 py-2 capitalize">{k.replace(/_/g, ' ')}</th>
                        ))}
                        {hasOutcomes && !hasRows && (
                          <><th className="px-3 py-2">Status</th><th className="px-3 py-2">Count</th></>
                        )}
                      </tr>
                    </thead>
                    <tbody>
                      {(report.rows || []).map((row, i) => (
                        <tr key={i} className="border-t border-gray-100">
                          {Object.values(row).map((v, j) => (
                            <td key={j} className="px-3 py-2">{String(v ?? '—')}</td>
                          ))}
                        </tr>
                      ))}
                      {(report.outcomes || []).map((o, i) => (
                        <tr key={`o-${i}`} className="border-t border-gray-100">
                          <td className="px-3 py-2">{o.status}</td>
                          <td className="px-3 py-2">{o.cnt}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            );
          })()}
        </div>
      )}

      <CreateModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onCreated={(row) => {
          loadDash();
          loadList();
          navigate(`/system-requirements/${row.id}`);
        }}
      />
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} onSaved={loadDash} />
    </div>
  );
}
