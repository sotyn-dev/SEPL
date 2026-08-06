import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import api from '../../api';
import toast from 'react-hot-toast';
import { useUrlTab } from '../../hooks/useUrlTab';
import {
  FiPlus, FiSettings, FiRefreshCw, FiSearch, FiClipboard,
} from 'react-icons/fi';
import { exportCsv } from '../../utils/exportCsv';
import { fmtDate, fmtDateTime } from '../../utils/datetime';
import CreateModal from './CreateModal';
import SettingsModal from './SettingsModal';
import {
  TYPES, PRIORITIES, STATUSES, STATUS_COLORS, PRIORITY_COLORS,
  REPORTS, labelOf,
} from './constants';

function Chip({ label, value, active, onClick, tone = 'gray' }) {
  const tones = {
    gray: active ? 'bg-gray-900 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200',
    amber: active ? 'bg-amber-600 text-white' : 'bg-amber-50 text-amber-800 hover:bg-amber-100',
    red: active ? 'bg-red-600 text-white' : 'bg-red-50 text-red-700 hover:bg-red-100',
    sky: active ? 'bg-sky-600 text-white' : 'bg-sky-50 text-sky-800 hover:bg-sky-100',
    green: active ? 'bg-emerald-600 text-white' : 'bg-emerald-50 text-emerald-800 hover:bg-emerald-100',
  };
  return (
    <button type="button" onClick={onClick} className={`px-3 py-2 rounded-xl text-left min-w-[110px] ${tones[tone]}`}>
      <div className="text-lg font-semibold leading-none">{value ?? 0}</div>
      <div className="text-xs mt-1 opacity-90">{label}</div>
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
      .then(r => setCanEditSettings(!!r.data?.me?.can_edit_settings))
      .catch(() => setCanEditSettings(false));
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
  useEffect(() => { if (tab === 'reports') loadReport(); }, [tab, loadReport]);

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
          <button type="button" onClick={() => setCreateOpen(true)} className="px-3 py-2 text-sm rounded-lg bg-red-600 text-white inline-flex items-center gap-1">
            <FiPlus size={14} /> New
          </button>
        </div>
      </div>

      <div className="flex gap-1 border-b border-gray-200">
        {['board', 'reports'].map(t => (
          <button
            key={t}
            type="button"
            onClick={() => setTab(t)}
            className={`px-3 py-2 text-sm capitalize border-b-2 ${
              tab === t ? 'border-red-600 text-red-700 font-medium' : 'border-transparent text-gray-500'
            }`}
          >
            {t === 'board' ? 'Control Center' : 'Reports'}
          </button>
        ))}
      </div>

      {tab === 'board' && (
        <>
          <div className="flex flex-wrap gap-2">
            <Chip label="Open" value={dash?.counts?.open} onClick={() => { setStatus(''); setOverdue(false); setStale(false); setInactiveAssignee(false); }} active={!status && !overdue && !stale && !inactiveAssignee} />
            <Chip label="Waiting" value={dash?.counts?.with_it_managers} onClick={() => applyChip('it')} tone="amber" active={status === 'submitted'} />
            <Chip label="Business approval" value={dash?.counts?.waiting_approval} onClick={() => applyChip('waiting')} tone="amber" active={status === 'under_review'} />
            <Chip label="Pending" value={dash?.counts?.pending} onClick={() => applyChip('pending')} tone="sky" active={status === 'pending'} />
            <Chip label="In Progress" value={dash?.counts?.in_progress} onClick={() => applyChip('progress')} tone="sky" active={status === 'in_progress'} />
            <Chip label="Testing" value={dash?.counts?.testing} onClick={() => applyChip('testing')} tone="sky" active={status === 'testing'} />
            <Chip label="Released this month" value={dash?.counts?.released_this_month} tone="green" onClick={() => setStatus('released,closed')} active={status === 'released,closed'} />
            <Chip label="Overdue" value={dash?.counts?.overdue} onClick={() => applyChip('overdue')} tone="red" active={overdue} />
            <Chip label="Inactive assignee" value={dash?.counts?.inactive_assignee} onClick={() => applyChip('inactive')} tone="red" active={inactiveAssignee} />
            <Chip label="Need clarification" value={dash?.counts?.need_clarification} onClick={() => applyChip('clarification')} tone="amber" active={status === 'need_clarification'} />
            <Chip label="Stale" value={dash?.counts?.stale} onClick={() => applyChip('stale')} tone="amber" active={stale} />
          </div>

          {(dash?.assignee_workload || []).length > 0 && (
            <div className="card p-3">
              <div className="text-xs font-semibold text-gray-500 mb-2">Open work by assignee</div>
              <div className="flex flex-wrap gap-2">
                {dash.assignee_workload.map(a => (
                  <span key={a.id} className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-700">
                    {a.name} <strong>{a.cnt}</strong>
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            <div className="lg:col-span-2 card p-0 overflow-hidden">
              <div className="p-3 border-b flex flex-wrap gap-2 items-center">
                <div className="relative flex-1 min-w-[180px]">
                  <FiSearch className="absolute left-2 top-2.5 text-gray-400" size={14} />
                  <input
                    className="input w-full pl-8"
                    placeholder="Search number, title…"
                    value={q}
                    onChange={e => setQ(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && loadList()}
                  />
                </div>
                <select className="input" value={type} onChange={e => setType(e.target.value)}>
                  <option value="">All types</option>
                  {TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <select className="input" value={priority} onChange={e => setPriority(e.target.value)}>
                  <option value="">All priorities</option>
                  {PRIORITIES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  <option value="high,urgent">High + Urgent</option>
                </select>
                <select className="input" value={status} onChange={e => setStatus(e.target.value)}>
                  <option value="">Active statuses</option>
                  {STATUSES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
                <button type="button" onClick={loadList} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white">Filter</button>
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
                        <td className="px-3 py-2 font-medium text-gray-800">{r.title}</td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[r.status]}`}>
                            {labelOf(STATUSES, r.status)}
                          </span>
                        </td>
                        <td className="px-3 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_COLORS[r.priority]}`}>
                            {labelOf(PRIORITIES, r.priority)}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">
                          <span className="inline-flex items-center gap-1.5 flex-wrap">
                            {r.assignee_name || '—'}
                            {r.assignee_inactive && (
                              <span className="text-[10px] uppercase tracking-wide font-semibold bg-amber-200 text-amber-900 rounded px-1.5 py-0.5">
                                Inactive
                              </span>
                            )}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-gray-600">{r.due_date ? fmtDate(r.due_date) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-3 py-2 text-xs text-gray-400 border-t">{total} shown (active filter)</div>
            </div>

            <div className="space-y-4">
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
              <div className="card p-3">
                <div className="text-xs font-semibold text-gray-500 mb-2">My assigned</div>
                <ul className="space-y-2">
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
            </div>
          </div>
        </>
      )}

      {tab === 'reports' && (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2 items-center">
            <select className="input" value={reportKey} onChange={e => setReportKey(e.target.value)}>
              {REPORTS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
            </select>
            <button type="button" onClick={loadReport} className="px-3 py-2 text-sm rounded-lg bg-gray-900 text-white">Run</button>
            <button type="button" onClick={exportReport} className="px-3 py-2 text-sm rounded-lg border border-gray-300">Export CSV</button>
          </div>
          <div className="card p-0 overflow-hidden">
            {report?.averages && (
              <div className="p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                {Object.entries(report.averages).map(([k, v]) => (
                  <div key={k} className="bg-gray-50 rounded-xl p-3">
                    <div className="text-xs text-gray-500 capitalize">{k.replace(/_/g, ' ')}</div>
                    <div className="text-xl font-semibold">{v == null ? '—' : `${v}d`}</div>
                  </div>
                ))}
              </div>
            )}
            {report?.by_month && (
              <div className="p-4 flex flex-wrap gap-2 border-b">
                {report.by_month.map(m => (
                  <span key={m.month} className="text-xs px-2 py-1 rounded-lg bg-emerald-50 text-emerald-800">{m.month}: {m.cnt}</span>
                ))}
              </div>
            )}
            <table className="w-full text-sm">
              <thead className="bg-gray-50 text-left text-xs text-gray-500">
                <tr>
                  {report?.rows?.[0] && Object.keys(report.rows[0]).map(k => (
                    <th key={k} className="px-3 py-2 capitalize">{k.replace(/_/g, ' ')}</th>
                  ))}
                  {report?.outcomes && !report?.rows && (
                    <><th className="px-3 py-2">Status</th><th className="px-3 py-2">Count</th></>
                  )}
                </tr>
              </thead>
              <tbody>
                {(report?.rows || []).map((row, i) => (
                  <tr key={i} className="border-t border-gray-100">
                    {Object.values(row).map((v, j) => (
                      <td key={j} className="px-3 py-2">{String(v ?? '—')}</td>
                    ))}
                  </tr>
                ))}
                {(report?.outcomes || []).map((o, i) => (
                  <tr key={`o-${i}`} className="border-t border-gray-100">
                    <td className="px-3 py-2">{o.status}</td>
                    <td className="px-3 py-2">{o.cnt}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
