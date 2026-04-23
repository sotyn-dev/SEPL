import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiUpload, FiExternalLink } from 'react-icons/fi';

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
        {isAdmin() && (
          <button onClick={() => { setEditing(null); setForm({ description: '', frequency: 'monthly', due_date: '', due_time: '', assigned_to: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Checklist</button>
        )}
      </div>
      {!isAdmin() && (
        <p className="text-xs text-gray-500 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          Only admins can create checklists. Tap <span className="font-semibold text-emerald-700">Upload Proof</span> next to each of your tasks below to submit.
        </p>
      )}


      {/* Admin-only filter by assignee (regular users only see their own anyway) */}
      {isAdmin() && (
        <div className="flex items-center gap-2">
          <label className="text-xs text-gray-500 font-semibold uppercase">Filter by person:</label>
          <select className="select text-sm max-w-xs" value={personFilter} onChange={e => setPersonFilter(e.target.value)}>
            <option value="">All people</option>
            {users.filter(u => u.active !== 0).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
          </select>
          <span className="text-xs text-gray-400">{visible.length} task{visible.length === 1 ? '' : 's'}</span>
        </div>
      )}

      {groupOrder.length === 0 && (
        <div className="card text-center py-8 text-gray-400">No checklists yet</div>
      )}
      {groupOrder.map(personName => (
        <div key={personName} className="card p-0 overflow-x-auto">
          <div className="px-4 py-2.5 bg-gray-50 border-b border-gray-100 flex items-center justify-between">
            <h4 className="font-bold text-gray-700 text-sm flex items-center gap-2">
              <span className="inline-flex items-center justify-center w-6 h-6 rounded-full bg-red-100 text-red-700 text-[10px] font-extrabold">{personName.split(' ').map(s => s[0]).slice(0, 2).join('').toUpperCase()}</span>
              {personName}
              <span className="text-xs font-normal text-gray-400">({byPerson[personName].length})</span>
            </h4>
          </div>
          <table>
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
