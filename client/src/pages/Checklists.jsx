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
  const [view, setView] = useState('current'); // 'current' | 'by-date'
  const [historyDate, setHistoryDate] = useState(new Date().toISOString().slice(0, 10));
  const [historyRows, setHistoryRows] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

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
  const visible = personFilter
    ? checklists.filter(c => String(c.assigned_to) === String(personFilter))
    : checklists;
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

      {/* View toggle — "Current" = standard live list,
          "By Date" = historical / per-day view with proof + approval. */}
      <div className="flex gap-2 flex-wrap items-center">
        <button onClick={() => setView('current')}
                className={`btn ${view === 'current' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          Current
        </button>
        <button onClick={() => { setView('by-date'); loadHistory(historyDate); }}
                className={`btn ${view === 'by-date' ? 'btn-primary' : 'btn-secondary'} text-sm flex items-center gap-1.5`}>
          <FiCalendar size={13} /> By Date · Approve / Reject
        </button>
        {view === 'by-date' && (
          <>
            <input type="date" className="input text-sm w-44" value={historyDate}
                   onChange={e => { setHistoryDate(e.target.value); loadHistory(e.target.value); }} />
            <button onClick={() => { const y = new Date(); y.setDate(y.getDate() - 1); const iso = y.toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Yesterday</button>
            <button onClick={() => { const iso = new Date().toISOString().slice(0, 10); setHistoryDate(iso); loadHistory(iso); }}
                    className="btn btn-secondary text-xs">Today</button>
            <span className="text-xs text-gray-500 ml-2">
              {historyLoading ? 'loading…' : `${historyRows.length} row${historyRows.length === 1 ? '' : 's'} · ${historyRows.filter(r => r.completion_id).length} done · ${historyRows.filter(r => r.approval_status === 'pending').length} pending approval`}
            </span>
          </>
        )}
      </div>

      {/* ─── BY-DATE / APPROVAL view ─────────────────────────────── */}
      {view === 'by-date' && (
        <div className="card p-0 overflow-x-auto">
          <table className="freeze-head">
            <thead>
              <tr>
                <th>Person</th>
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
                <tr><td colSpan={isAdmin() ? 8 : 7} className="text-center py-6 text-gray-400">
                  No checklists for this date.
                </td></tr>
              )}
              {historyRows.map(r => {
                const done = !!r.completion_id;
                const apStat = r.approval_status || (done ? 'pending' : '—');
                const apBadge = apStat === 'approved' ? 'bg-emerald-100 text-emerald-700'
                              : apStat === 'rejected' ? 'bg-red-100 text-red-700'
                              : apStat === 'pending' ? 'bg-amber-100 text-amber-700'
                              : 'bg-gray-100 text-gray-500';
                return (
                  <tr key={r.id} className={done ? '' : 'bg-gray-50/50'}>
                    <td className="text-xs font-medium">{r.assigned_to_name || '—'}</td>
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
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-semibold uppercase">Filter by person:</label>
          <select className="select text-sm max-w-xs" value={personFilter} onChange={e => setPersonFilter(e.target.value)}>
            <option value="">All people</option>
            {users.filter(u => u.active !== 0).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="text-xs text-gray-400">{visible.length} task{visible.length === 1 ? '' : 's'}</span>
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
            <thead><tr><th>Task</th><th>Frequency</th><th>Due Date / Time</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {byPerson[personName].map(c => (
                <tr key={c.id}>
                  <td className="font-medium max-w-md"><div className="line-clamp-2">{c.description || c.title}</div></td>
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
                options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Search user by name…"
                onChange={(u) => setForm({ ...form, assigned_to: u?.id || '' })}
              />
            </div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['pending','in_progress','completed','overdue'].map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select></div>}
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
