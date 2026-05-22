import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiUpload, FiExternalLink, FiDownload, FiCalendar, FiCheck, FiX, FiClock } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

export default function Checklists() {
  const { user, canDelete, isAdmin } = useAuth();
  const [checklists, setChecklists] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [personFilter, setPersonFilter] = useState('');
  // Today's completions keyed by checklist_id — lets us mark rows green + show proof link inline
  const [todayDone, setTodayDone] = useState({});
  const [uploadingId, setUploadingId] = useState(null);

  // History / approval tab — mam (2026-05-16): "where i can check as
  // per daily and previous check list done or not done proof and
  // after need to approval".  Switching to 'by-date' loads the
  // /hr/checklists/by-date endpoint with completion + approval data.
  // Mam (2026-05-22) shared her Google Sheet master+instances example;
  // the by-date view IS the instance grid she wants, so default to it.
  // 'master' = template list, 'by-date' = per-day instance grid.
  const [view, setView] = useState('by-date');
  const [historyDate, setHistoryDate] = useState(new Date().toISOString().slice(0, 10));
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all'); // all | done | not_done | pending | rejected
  const [deptFilter, setDeptFilter] = useState('');
  // Follow-up view (mam, 2026-05-22) — per-task timeline grid spanning
  // N days back → today → N days forward.  Server returns one cell
  // per (task, date) with status (done_approved / done_pending /
  // done_rejected / missed / today / future / na).
  const [followup, setFollowup] = useState(null);
  const [followupBack, setFollowupBack] = useState(7);
  const [followupForward, setFollowupForward] = useState(7);
  const loadFollowup = async (back = followupBack, forward = followupForward) => {
    try {
      const r = await api.get('/hr/checklists/followup', { params: { back, forward } });
      setFollowup(r.data);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to load follow-up'); }
  };

  const loadHistory = async (d) => {
    setHistoryLoading(true);
    try {
      const r = await api.get('/hr/checklists/by-date', { params: { date: d || historyDate } });
      setHistoryRows(r.data?.rows || []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load history');
    } finally {
      setHistoryLoading(false);
    }
  };

  // Admin approve / reject a completion.  Optional note via prompt
  // (will swap to a proper modal if mam asks for richer UX later).
  const decideCompletion = async (compId, status) => {
    let note = '';
    if (status === 'rejected') {
      note = prompt('Why rejected? (visible to the assignee)') || '';
      if (!note.trim()) { toast.error('Reason required for rejection'); return; }
    }
    try {
      await api.post(`/hr/checklists/completions/${compId}/decision`, { status, note });
      toast.success(`Marked ${status}`);
      loadHistory();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed');
    }
  };

  const load = () => {
    api.get('/hr/checklists').then(r => setChecklists(r.data));
    // Whether each of my own checklists is already done today (used for the inline upload button)
    api.get('/hr/checklists/my-today').then(r => {
      const map = {};
      (r.data || []).forEach(c => { if (c.completion_id) map[c.id] = { proof_url: c.proof_url, submitted_at: c.submitted_at }; });
      setTodayDone(map);
    }).catch(() => setTodayDone({}));
  };
  useEffect(() => { load(); api.get('/auth/users').then(r => setUsers(r.data)); }, []);
  // Auto-load today's instance grid on first paint so the page lands
  // straight on the actionable view (mam's preferred mental model).
  useEffect(() => { loadHistory(historyDate); /* eslint-disable-next-line */ }, []);

  // Inline "Upload Proof" — picks a file, uploads to /upload, then marks the
  // checklist complete for today with that URL. Appears only on rows assigned
  // to the logged-in user.
  const uploadProof = async (c, file) => {
    setUploadingId(c.id);
    try {
      const fd = new FormData(); fd.append('file', file);
      const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.post(`/hr/checklists/${c.id}/complete`, { proof_url: up.data.url });
      toast.success(`Proof uploaded for "${c.description || c.title}"`);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Upload failed'); }
    setUploadingId(null);
  };

  // Group checklists by assignee so the admin view shows one section per person.
  // Sections are ordered alphabetically by assignee name.
  const visible = checklists.filter(c => {
    if (personFilter && String(c.assigned_to) !== String(personFilter)) return false;
    if (deptFilter   && c.department !== deptFilter) return false;
    return true;
  });
  const byPerson = visible.reduce((acc, c) => {
    const key = c.assigned_to_name || 'Unassigned';
    (acc[key] = acc[key] || []).push(c);
    return acc;
  }, {});
  const groupOrder = Object.keys(byPerson).sort((a, b) => a.localeCompare(b));

  const save = async (e) => {
    e.preventDefault();
    if (editing) { await api.put(`/hr/checklists/${editing.id}`, form); }
    else { await api.post('/hr/checklists', form); }
    toast.success(editing ? 'Updated' : 'Created');
    setModal(false); load();
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <h3 className="font-semibold">Checklists & Recurring Tasks</h3>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('checklists',
            ['Description','Frequency','Due Date','Due Time','Assigned To','Status'],
            checklists.map(c => [c.description || c.title, c.frequency, c.due_date, c.due_time, c.assigned_to_name, c.status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          {isAdmin() && (
            <button onClick={() => { setEditing(null); setForm({ description: '', frequency: 'monthly', due_date: '', due_time: '', assigned_to: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Checklist</button>
          )}
        </div>
      </div>
      {!isAdmin() && (
        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Only admins can create checklists. Tap <span className="font-semibold text-emerald-700">Upload Proof</span> next to each of your tasks below to submit.
        </p>
      )}

      {/* Tab toggle — match mam's mental model from her Sheet:
          "By Date" = today's instance grid (default; her Sheet 2 view),
          "Master" = recurring-template editor (her Sheet 1 view). */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => { setView('by-date'); loadHistory(historyDate); }}
                className={`btn ${view === 'by-date' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          <FiCalendar size={13} /> Today / By Date
        </button>
        <button onClick={() => setView('current')}
                className={`btn ${view === 'current' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          Master Templates
        </button>
        {/* Mam (2026-05-22): "i need followup checklist where all
            record mention previous, present, future" — per-task
            timeline grid with past / today / upcoming cells. */}
        <button onClick={() => { setView('followup'); if (!followup) loadFollowup(); }}
                className={`btn ${view === 'followup' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          <FiClock size={13} /> Follow-up Timeline
        </button>
        {view === 'by-date' && (
          <>
            <input type="date" className="input text-sm w-44" value={historyDate}
                   onChange={e => { setHistoryDate(e.target.value); loadHistory(e.target.value); }} />
            <button onClick={() => { const y = new Date(); y.setDate(y.getDate() - 1); const iso = y.toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Yesterday</button>
            <button onClick={() => { const iso = new Date().toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Today</button>
          </>
        )}
      </div>

      {/* KPI strip on by-date view — mam's master-checklist summary */}
      {view === 'by-date' && !historyLoading && historyRows.length > 0 && (() => {
        const totals = {
          total:    historyRows.length,
          done:     historyRows.filter(r => r.completion_id).length,
          not_done: historyRows.filter(r => !r.completion_id).length,
          pending:  historyRows.filter(r => r.approval_status === 'pending' && r.completion_id).length,
          approved: historyRows.filter(r => r.approval_status === 'approved').length,
          rejected: historyRows.filter(r => r.approval_status === 'rejected').length,
        };
        const pill = (k, label, val, color) => (
          <button onClick={() => setStatusFilter(k)}
            className={`card p-3 border-l-4 ${color} text-left hover:shadow ${statusFilter === k ? 'ring-2 ring-offset-1 ring-blue-400' : ''}`}>
            <div className="text-[10px] uppercase text-gray-500">{label}</div>
            <div className="text-2xl font-bold">{val}</div>
          </button>
        );
        return (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-2">
            {pill('all',      'Total',    totals.total,    'border-l-gray-500')}
            {pill('done',     'Done',     totals.done,     'border-l-emerald-500')}
            {pill('not_done', 'Not Done', totals.not_done, 'border-l-rose-500')}
            {pill('pending',  'Pending Approval', totals.pending, 'border-l-amber-500')}
            {pill('approved', 'Approved', totals.approved, 'border-l-emerald-600')}
            {pill('rejected', 'Rejected', totals.rejected, 'border-l-red-600')}
          </div>
        );
      })()}

      {/* Department filter on by-date view */}
      {view === 'by-date' && historyRows.length > 0 && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-gray-500 font-semibold uppercase">Department:</label>
          <select className="select text-sm max-w-xs" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {[...new Set(historyRows.map(r => r.department).filter(Boolean))].sort().map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className="text-xs text-gray-400">
            {historyLoading ? 'loading…' : (() => {
              const filtered = historyRows.filter(r => {
                if (deptFilter && r.department !== deptFilter) return false;
                if (statusFilter === 'done')     return !!r.completion_id;
                if (statusFilter === 'not_done') return !r.completion_id;
                if (statusFilter === 'pending')  return r.approval_status === 'pending' && r.completion_id;
                if (statusFilter === 'approved') return r.approval_status === 'approved';
                if (statusFilter === 'rejected') return r.approval_status === 'rejected';
                return true;
              });
              return `${filtered.length} row${filtered.length === 1 ? '' : 's'}`;
            })()}
          </span>
        </div>
      )}

      {/* ─── BY-DATE / APPROVAL view ─────────────────────────────── */}
      {view === 'by-date' && (
        <div className="card p-0 overflow-x-auto">
          <table className="freeze-head">
            <thead>
              <tr>
                <th>Person</th>
                <th>Department</th>
                <th>Task</th>
                <th>Frequency</th>
                <th>Done?</th>
                <th>Proof</th>
                <th>Approval</th>
                <th>Submitted</th>
                {isAdmin() && <th>Actions</th>}
              </tr>
            </thead>
            <tbody>
              {historyRows.length === 0 && !historyLoading && (
                <tr><td colSpan={isAdmin() ? 9 : 8} className="text-center py-6 text-gray-400">
                  No checklists for this date.
                </td></tr>
              )}
              {historyRows.filter(r => {
                if (deptFilter && r.department !== deptFilter) return false;
                if (statusFilter === 'done')     return !!r.completion_id;
                if (statusFilter === 'not_done') return !r.completion_id;
                if (statusFilter === 'pending')  return r.approval_status === 'pending' && r.completion_id;
                if (statusFilter === 'approved') return r.approval_status === 'approved';
                if (statusFilter === 'rejected') return r.approval_status === 'rejected';
                return true;
              }).map(r => {
                const done = !!r.completion_id;
                const apStat = r.approval_status || (done ? 'pending' : '—');
                const apBadge = apStat === 'approved' ? 'bg-emerald-100 text-emerald-700'
                              : apStat === 'rejected' ? 'bg-red-100 text-red-700'
                              : apStat === 'pending' ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-500';
                return (
                  <tr key={r.id} className={done ? '' : 'bg-gray-50/50'}>
                    <td className="text-xs font-medium">{r.assigned_to_name || '—'}</td>
                    <td className="text-[10px]">
                      {r.department ? (
                        <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{r.department}</span>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="font-medium max-w-md"><div className="line-clamp-2">{r.description || r.title}</div></td>
                    <td className="capitalize text-xs">{r.frequency}</td>
                    <td>
                      {done ? (
                        <span className="text-emerald-700 font-bold inline-flex items-center gap-1 text-xs"><FiCheck size={12} /> Done</span>
                      ) : (
                        <span className="text-red-700 font-bold inline-flex items-center gap-1 text-xs"><FiX size={12} /> Not done</span>
                      )}
                    </td>
                    <td className="text-xs">
                      {r.proof_url ? (
                        <a href={r.proof_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:text-blue-800 underline inline-flex items-center gap-1">
                          <FiExternalLink size={11} /> View
                        </a>
                      ) : <span className="text-gray-400">—</span>}
                    </td>
                    <td>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-semibold uppercase ${apBadge}`}>{apStat}</span>
                      {r.approval_note && (
                        <div className="text-[10px] text-gray-500 italic mt-0.5" title={r.approval_note}>
                          {r.approval_note.slice(0, 40)}{r.approval_note.length > 40 ? '…' : ''}
                        </div>
                      )}
                      {r.approved_by_name && (
                        <div className="text-[10px] text-gray-500">by {r.approved_by_name}</div>
                      )}
                    </td>
                    <td className="text-xs text-gray-500 font-mono">
                      {r.submitted_at ? new Date(r.submitted_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) : '—'}
                    </td>
                    {isAdmin() && (
                      <td>
                        {done && apStat === 'pending' ? (
                          <div className="flex gap-1">
                            <button onClick={() => decideCompletion(r.completion_id, 'approved')}
                                    className="px-2 py-1 text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded font-semibold inline-flex items-center gap-1">
                              <FiCheck size={10} /> Approve
                            </button>
                            <button onClick={() => decideCompletion(r.completion_id, 'rejected')}
                                    className="px-2 py-1 text-[10px] bg-red-100 text-red-700 hover:bg-red-200 rounded font-semibold inline-flex items-center gap-1">
                              <FiX size={10} /> Reject
                            </button>
                          </div>
                        ) : done && apStat === 'rejected' ? (
                          <button onClick={() => decideCompletion(r.completion_id, 'approved')}
                                  className="px-2 py-1 text-[10px] bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded font-semibold inline-flex items-center gap-1">
                            <FiCheck size={10} /> Reverse to Approved
                          </button>
                        ) : done && apStat === 'approved' ? (
                          <button onClick={() => decideCompletion(r.completion_id, 'rejected')}
                                  className="text-[10px] text-gray-500 hover:text-red-600 underline">
                            Re-reject
                          </button>
                        ) : (
                          <span className="text-[10px] text-gray-400 italic">No submission</span>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}


      {/* Admin-only filter by assignee (regular users only see their own anyway).
          Hidden in the by-date / approval view since that has its own date picker. */}
      {view === 'current' && isAdmin() && (
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs text-gray-500 font-semibold uppercase">Person:</label>
          <select className="select text-sm max-w-xs" value={personFilter} onChange={e => setPersonFilter(e.target.value)}>
            <option value="">All people</option>
            {users.filter(u => u.active !== 0).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          {/* Department filter on Master Templates too (mam, 2026-05-22:
              department should be a first-class facet alongside person). */}
          <label className="text-xs text-gray-500 font-semibold uppercase ml-3">Department:</label>
          <select className="select text-sm max-w-xs" value={deptFilter} onChange={e => setDeptFilter(e.target.value)}>
            <option value="">All departments</option>
            {[...new Set(checklists.map(c => c.department).filter(Boolean))].sort().map(d => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <span className="text-xs text-gray-400">{visible.length} task{visible.length === 1 ? '' : 's'}</span>
        </div>
      )}

      {/* ─── FOLLOW-UP TIMELINE view ─────────────────────────────── */}
      {view === 'followup' && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs text-gray-500 font-semibold uppercase">Window:</label>
            <select className="select text-sm" value={followupBack} onChange={e => { const v = +e.target.value; setFollowupBack(v); loadFollowup(v, followupForward); }}>
              <option value={3}>3 days back</option>
              <option value={7}>7 days back</option>
              <option value={14}>14 days back</option>
              <option value={30}>30 days back</option>
            </select>
            <span className="text-xs text-gray-400">→ today →</span>
            <select className="select text-sm" value={followupForward} onChange={e => { const v = +e.target.value; setFollowupForward(v); loadFollowup(followupBack, v); }}>
              <option value={3}>3 days forward</option>
              <option value={7}>7 days forward</option>
              <option value={14}>14 days forward</option>
            </select>
            {/* Legend */}
            <div className="ml-auto flex items-center gap-2 text-[10px] text-gray-600">
              <Cell s="done_approved" /> Approved
              <Cell s="done_pending" /> Pending
              <Cell s="done_rejected" /> Rejected
              <Cell s="missed" /> Missed
              <Cell s="today" /> Today
              <Cell s="future" /> Future
            </div>
          </div>

          {!followup && <div className="card p-6 text-center text-gray-400">Loading…</div>}
          {followup && followup.rows.length === 0 && <div className="card p-8 text-center text-gray-400">No checklists yet</div>}
          {followup && followup.rows.length > 0 && (
            <div className="card p-0 overflow-x-auto">
              <table className="text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50">
                    <th className="text-left px-2 py-2 sticky left-0 bg-gray-50 z-10 min-w-[200px]">Task</th>
                    <th className="text-left px-2 py-2 sticky left-[200px] bg-gray-50 z-10">Person</th>
                    <th className="text-left px-2 py-2">Dept</th>
                    {followup.dates.map((d, i) => {
                      const dt = new Date(d);
                      const isToday = i === followup.today_index;
                      return (
                        <th key={d} className={`px-1 py-1 text-center text-[9px] uppercase ${isToday ? 'bg-blue-100 text-blue-700 font-bold' : 'text-gray-500'}`} style={{ width: 32 }}>
                          <div>{dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</div>
                          <div className="font-normal opacity-60">{dt.toLocaleDateString('en-IN', { weekday: 'short' })}</div>
                        </th>
                      );
                    })}
                  </tr>
                </thead>
                <tbody>
                  {followup.rows.map(r => (
                    <tr key={r.id} className="border-t hover:bg-blue-50/30">
                      <td className="px-2 py-1.5 sticky left-0 bg-white z-10 min-w-[200px]">
                        <div className="font-medium text-gray-800 text-[12px] line-clamp-2" title={r.description}>{r.description}</div>
                        <div className="text-[9px] text-gray-500 capitalize">{r.frequency}</div>
                      </td>
                      <td className="px-2 py-1.5 sticky left-[200px] bg-white z-10 text-[11px]">{r.assigned_to_name || '—'}</td>
                      <td className="px-2 py-1.5">
                        {r.department ? <span className="text-[10px] px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{r.department}</span> : <span className="text-gray-300 text-[10px]">—</span>}
                      </td>
                      {r.cells.map(c => (
                        <td key={c.date} className="px-0.5 py-1 text-center" style={{ width: 32 }}>
                          {c.proof_url
                            ? <a href={c.proof_url} target="_blank" rel="noreferrer" title={`${c.date} · ${c.status}\nClick to view proof`}><Cell s={c.status} /></a>
                            : <span title={`${c.date} · ${c.status}`}><Cell s={c.status} /></span>}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === 'current' && groupOrder.length === 0 && (
        <div className="card text-center py-8 text-gray-400">No checklists yet</div>
      )}
      {view === 'current' && groupOrder.map(personName => (
        <div key={personName} className="card p-0 overflow-x-auto">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
            <h4 className="font-bold text-gray-700 text-sm flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 text-[10px] font-extrabold">{personName.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}</span>
              {personName}
              <span className="text-xs font-normal text-gray-400">({byPerson[personName].length})</span>
            </h4>
          </div>
          <table className="freeze-head">
            <thead><tr><th>Task</th><th>Department</th><th>Frequency</th><th>Due Date / Time</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {byPerson[personName].map(c => (
                <tr key={c.id}>
                  <td className="font-medium max-w-md"><div className="line-clamp-2">{c.description || c.title}</div></td>
                  <td className="text-[11px]">
                    {c.department
                      ? <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded">{c.department}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="capitalize">{c.frequency}</td>
                  <td>
                    {c.frequency === 'daily'
                      ? (c.due_time ? <span className="font-mono">{c.due_time}</span> : <span className="text-gray-400">anytime</span>)
                      : <span>{c.due_date || '—'}{c.due_time ? ` · ${c.due_time}` : ''}</span>}
                  </td>
                  <td><StatusBadge status={c.status} /></td>
                  <td><div className="flex gap-1 flex-wrap items-center">
                    {/* Inline upload-proof for the assignee. Green badge when already done today. */}
                    {c.assigned_to === user?.id && (
                      todayDone[c.id] ? (
                        <span className="text-[10px] text-emerald-700 flex items-center gap-1 bg-emerald-50 px-2 py-1 rounded">
                          ✓ Done today {todayDone[c.id].proof_url && <a href={todayDone[c.id].proof_url} target="_blank" rel="noreferrer" className="text-emerald-800 hover:underline flex items-center gap-0.5"><FiExternalLink size={10} /> proof</a>}
                        </span>
                      ) : (
                        <label className={`btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 cursor-pointer ${uploadingId === c.id ? 'opacity-60 pointer-events-none' : ''}`}>
                          <FiUpload size={11} /> {uploadingId === c.id ? '...' : 'Upload Proof'}
                          <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="hidden"
                            onChange={e => { const f = e.target.files[0]; if (f) uploadProof(c, f); e.target.value = ''; }} />
                        </label>
                      )
                    )}
                    {isAdmin() && <button onClick={() => { setEditing(c); setForm(c); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>}
                    {isAdmin() && canDelete('checklists') && <button onClick={async () => {
                      if (!confirm(`Delete this checklist?`)) return;
                      try { await api.delete(`/hr/checklists/${c.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Checklist' : 'Add Checklist'}>
        <form onSubmit={save} className="space-y-4">
          <div><label className="label">Task Description *</label><textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm({...form, description: e.target.value})} placeholder="What needs to be done…" /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Frequency</label><select className="select" value={form.frequency || 'monthly'} onChange={e => setForm({...form, frequency: e.target.value})}>{['daily','weekly','monthly','quarterly','yearly','once'].map(f => <option key={f} value={f}>{f}</option>)}</select></div>
            {/* For 'once' tasks we keep the Due Date. For recurring (daily/weekly/…),
                we show Time of Day instead since the date is derived from the frequency. */}
            {form.frequency === 'daily' ? (
              <div><label className="label">Time of Day</label><input className="input" type="time" value={form.due_time || ''} onChange={e => setForm({...form, due_time: e.target.value})} /><p className="text-[10px] text-gray-400 mt-0.5">When should this task be done each day?</p></div>
            ) : (
              <div><label className="label">Due Date</label><input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({...form, due_date: e.target.value})} /></div>
            )}
            {form.frequency !== 'daily' && (
              <div><label className="label">Time of Day <span className="text-gray-400 font-normal">(optional)</span></label><input className="input" type="time" value={form.due_time || ''} onChange={e => setForm({...form, due_time: e.target.value})} /></div>
            )}
            <div>
              <label className="label">Assigned To *</label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') + (u.department ? ' · ' + u.department : '') }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Search user by name…"
                onChange={(u) => {
                  // Mam (2026-05-22): auto-fill department from the
                  // assignee's user record so admin doesn't have to
                  // re-type it.  Override is still allowed below.
                  setForm({
                    ...form,
                    assigned_to: u?.id || '',
                    department: form.department || u?.department || '',
                  });
                }}
              />
            </div>
            {/* Department — sourced from distinct users.department values
                in the loaded user list, with a datalist so admin can
                type a new one if needed.  Auto-populated above when an
                assignee is picked. */}
            <div>
              <label className="label">Department <span className="text-gray-400 font-normal text-[10px]">(auto-fills from assignee)</span></label>
              <input
                list="checklist-department-options"
                className="input"
                value={form.department || ''}
                onChange={e => setForm({ ...form, department: e.target.value })}
                placeholder="e.g. Accounts, HR, Procurement…"
              />
              <datalist id="checklist-department-options">
                {[...new Set(users.map(u => u.department).filter(Boolean))].sort().map(d => (
                  <option key={d} value={d} />
                ))}
              </datalist>
            </div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['pending','in_progress','completed','overdue'].map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select></div>}
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>
    </div>
  );
}

// Tiny coloured cell for the Follow-up timeline matrix.
// Status → background colour mapping kept in one place so the legend
// in the toolbar and the grid cells always match.
function Cell({ s }) {
  const map = {
    done_approved: 'bg-emerald-500',
    done_pending:  'bg-amber-400',
    done_rejected: 'bg-rose-500',
    missed:        'bg-red-200',
    today:         'bg-blue-200 ring-2 ring-blue-500',
    future:        'bg-gray-100',
    na:            'bg-white border border-dashed border-gray-200',
  };
  const cls = map[s] || 'bg-gray-100';
  return <span className={`inline-block w-4 h-4 rounded ${cls}`} />;
}
