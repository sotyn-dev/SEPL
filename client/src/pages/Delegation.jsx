import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMic, FiMicOff, FiUpload, FiCheck, FiX, FiTrash2, FiExternalLink, FiAlertTriangle, FiClock, FiCalendar } from 'react-icons/fi';

// Web Speech API — available as SpeechRecognition in Chromium-based browsers
const SR = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

export default function Delegation() {
  const { user, isAdmin, canApprove } = useAuth();
  const [tasks, setTasks] = useState([]);
  const [users, setUsers] = useState([]);
  // EA = anyone with approve permission on delegations (mam grants this to
  // her assistant). Admin also counts. Both see "All" tab + can upload proof
  // for anyone.
  const isEA = isAdmin() || canApprove('delegations');
  const [scope, setScope] = useState(isEA ? 'all' : 'mine'); // mine | given | all
  const [statusFilter, setStatusFilter] = useState('');
  const [assigneeFilter, setAssigneeFilter] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [createModal, setCreateModal] = useState(false);
  const [submitModal, setSubmitModal] = useState(null); // task being submitted
  const [rejectModal, setRejectModal] = useState(null); // task being rejected
  const [extendModal, setExtendModal] = useState(null); // task: assignee requests more time
  const [form, setForm] = useState({});
  const [submitForm, setSubmitForm] = useState({ proof_url: '', uploading: false });
  const [rejectReason, setRejectReason] = useState('');
  const [extendForm, setExtendForm] = useState({ requested_due_date: '', reason: '' });
  // Voice input
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef(null);

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter) params.set('status', statusFilter);
    if (assigneeFilter) params.set('assignee_id', assigneeFilter);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    api.get(`/delegations?${params.toString()}`).then(r => setTasks(r.data)).catch(() => setTasks([]));
  };
  useEffect(() => {
    load();
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
  }, [scope, statusFilter, assigneeFilter, dateFrom, dateTo]);

  // Voice → description. Appends to existing text so user can combine typing + voice.
  const toggleVoice = () => {
    if (!SR) {
      toast.error("Your browser doesn't support voice input. Use Chrome or Edge.");
      return;
    }
    if (listening) {
      recognitionRef.current?.stop();
      setListening(false);
      return;
    }
    const rec = new SR();
    rec.lang = 'en-IN';
    rec.interimResults = true;
    rec.continuous = true;
    let finalBuf = '';
    rec.onresult = (ev) => {
      let interim = '';
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const t = ev.results[i][0].transcript;
        if (ev.results[i].isFinal) finalBuf += t + ' ';
        else interim += t;
      }
      setForm(f => ({ ...f, description: ((f._base || '') + finalBuf + interim).trim() }));
    };
    rec.onstart = () => setForm(f => ({ ...f, _base: (f.description ? f.description + ' ' : '') }));
    rec.onerror = (e) => { toast.error('Voice error: ' + (e.error || 'unknown')); setListening(false); };
    rec.onend = () => setListening(false);
    recognitionRef.current = rec;
    rec.start();
    setListening(true);
  };

  const openCreate = () => {
    setForm({ description: '', assigned_to: '', due_date: new Date().toISOString().split('T')[0], project_name: '', attachment_file: null });
    setCreateModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!String(form.description || '').trim()) return toast.error('Description is required');
    try {
      // Optional attachment — upload first (if picked) to get a stable /uploads URL,
      // then send that URL with the task create. Keeps the task endpoint simple (JSON).
      let attachmentUrl = null;
      if (form.attachment_file) {
        const fd = new FormData(); fd.append('file', form.attachment_file);
        const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        attachmentUrl = up.data.url;
      }
      await api.post('/delegations', {
        description: form.description,
        assigned_to: form.assigned_to,
        due_date: form.due_date,
        project_name: form.project_name || null,
        attachment_url: attachmentUrl,
      });
      toast.success('Task assigned');
      setCreateModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create'); }
  };

  // Inline edit — save on blur / Enter. Optimistic: update local state, roll
  // back if the server rejects. Admin / assigner only (backend enforces it
  // too, but we also render the cell as read-only for other viewers).
  const saveProject = async (task, newValue) => {
    const trimmed = (newValue || '').trim();
    const current = task.project_name || '';
    if (trimmed === current) return; // no-op
    setTasks(prev => prev.map(t => t.id === task.id ? { ...t, project_name: trimmed || null } : t));
    try {
      await api.patch(`/delegations/${task.id}/project`, { project_name: trimmed });
    } catch (err) {
      // Revert on error
      setTasks(prev => prev.map(t => t.id === task.id ? { ...t, project_name: current || null } : t));
      toast.error(err.response?.data?.error || 'Failed to update project');
    }
  };

  // Extension request / approval (admin)
  const requestExtension = async (e) => {
    e.preventDefault();
    if (!extendForm.requested_due_date) return toast.error('Pick a new date');
    if (!extendForm.reason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/delegations/${extendModal.id}/request-extension`, extendForm);
      toast.success('Extension requested — admin will review');
      setExtendModal(null); setExtendForm({ requested_due_date: '', reason: '' }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approveExtension = async (task) => {
    if (!confirm(`Approve extension to ${task.requested_due_date}?`)) return;
    try { await api.post(`/delegations/${task.id}/approve-extension`); toast.success('Extension approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const rejectExtension = async (task) => {
    if (!confirm(`Reject extension request for "${task.title}"?`)) return;
    try { await api.post(`/delegations/${task.id}/reject-extension`); toast.success('Extension rejected'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Upload proof file then submit
  const uploadProof = async (file) => {
    const fd = new FormData(); fd.append('file', file);
    setSubmitForm(s => ({ ...s, uploading: true }));
    try {
      const res = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setSubmitForm({ proof_url: res.data.url, uploading: false });
      toast.success('File uploaded — click Submit');
    } catch { toast.error('Upload failed'); setSubmitForm(s => ({ ...s, uploading: false })); }
  };
  const submitProof = async (e) => {
    e.preventDefault();
    if (!submitForm.proof_url) return toast.error('Please upload proof first');
    try {
      await api.post(`/delegations/${submitModal.id}/submit`, { proof_url: submitForm.proof_url });
      toast.success('Proof submitted — awaiting approval');
      setSubmitModal(null); setSubmitForm({ proof_url: '', uploading: false }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const approve = async (task) => {
    if (!confirm(`Approve "${task.title}"?`)) return;
    try { await api.post(`/delegations/${task.id}/approve`); toast.success('Approved'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const reject = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) return toast.error('Reason is required');
    try {
      await api.post(`/delegations/${rejectModal.id}/reject`, { reason: rejectReason });
      toast.success('Rejected — assignee notified');
      setRejectModal(null); setRejectReason(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (task) => {
    if (!confirm(`Delete "${task.title}"?`)) return;
    try { await api.delete(`/delegations/${task.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Strip the legacy bracketed prefix '[TSK-N | project | category | by person]'
  // that existed in descriptions before we moved those fields into proper DB
  // columns. Keeps only the real task text the user typed.
  const cleanDesc = (s) => String(s || '').replace(/^\s*\[[^\]]*\]\s*/, '').trim();

  const statusBadge = (s) => {
    const map = {
      pending: 'bg-amber-100 text-amber-800 border-amber-200',
      submitted: 'bg-blue-100 text-blue-800 border-blue-200',
      approved: 'bg-emerald-100 text-emerald-800 border-emerald-200',
      rejected: 'bg-red-100 text-red-800 border-red-200',
    };
    return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${map[s] || 'bg-gray-100 text-gray-700 border-gray-200'}`}>{s}</span>;
  };

  return (
    <div className="space-y-4">
      {/* Header — only admin creates new tasks. Everyone else is a user who receives them. */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Delegations</h3>
          <p className="text-sm text-gray-500">{isAdmin() ? 'Assign tasks, upload proof, approve or reject' : 'Upload proof for tasks assigned to you'}</p>
        </div>
        {isAdmin() && (
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-2 w-full sm:w-auto justify-center"><FiPlus /> New Task</button>
        )}
      </div>

      {/* Filters — scope tabs, status, name (assignee), date from/to. The
          "All" tab shows for admin and EA (anyone with can_approve on
          delegations). Regular users only see their own tasks. */}
      <div className="flex flex-wrap gap-2 text-sm items-center">
        {[
          { id: 'mine', label: 'Assigned to me' },
          ...(isEA ? [{ id: 'all', label: 'All tasks' }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setScope(t.id)}
            className={`px-3 py-1.5 rounded-lg font-medium border ${scope === t.id ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {t.label}
          </button>
        ))}
        <select className="select text-sm max-w-[180px]" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">All statuses</option>
          <option value="pending">Pending</option>
          <option value="submitted">Submitted</option>
          <option value="approved">Approved</option>
          <option value="rejected">Rejected</option>
        </select>
        {/* Name + Date filters — only useful when looking across users, so
            only show on the "All" scope. */}
        {scope === 'all' && (
          <>
            <div className="w-[220px]">
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                value={assigneeFilter || null}
                valueKey="id" displayKey="label"
                placeholder="All assignees — search…"
                onChange={(u) => setAssigneeFilter(u?.id || '')}
              />
            </div>
            <div className="flex items-center gap-1 text-xs text-gray-500">
              <span>From</span>
              <input type="date" className="input py-1 text-xs w-36" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              <span>To</span>
              <input type="date" className="input py-1 text-xs w-36" value={dateTo} onChange={e => setDateTo(e.target.value)} />
              {(dateFrom || dateTo || assigneeFilter) && (
                <button onClick={() => { setAssigneeFilter(''); setDateFrom(''); setDateTo(''); }} className="text-[11px] text-red-600 hover:underline ml-1">Clear</button>
              )}
            </div>
          </>
        )}
      </div>

      {/* Table view — Serial / Task ID / Description / Project / Assigned To /
          Due / Status / Upload Proof / Extension / Actions.
          Shown on ALL screen sizes per mam's request (2026-04-23). On phones
          the parent scrolls horizontally so every column stays accessible. */}
      <div className="card p-0 overflow-x-auto">
        <table className="text-sm min-w-[1100px]">
          <thead>
            <tr>
              <th className="w-12 text-center">S.No.</th>
              <th>Task ID</th>
              <th>Description</th>
              <th>Project</th>
              <th>Assigned To</th>
              <th>Due / Completed</th>
              <th>Status</th>
              <th>Upload Proof</th>
              <th>Extension</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && <tr><td colSpan="10" className="text-center text-gray-400 py-8">No tasks</td></tr>}
            {tasks.map((t, idx) => {
              const isAssignee = t.assigned_to === user?.id;
              const isAssigner = t.assigned_by === user?.id;
              const canEditProject = isAdmin() || isAssigner;
              const completedDate = t.reviewed_at ? new Date(t.reviewed_at).toLocaleDateString() : null;
              return (
                <tr key={t.id} className={t.status === 'rejected' ? 'bg-red-50/40' : t.status === 'submitted' ? 'bg-blue-50/40' : ''}>
                  <td className="text-center text-xs text-gray-500 font-medium">{idx + 1}</td>
                  <td className="font-mono text-xs text-red-700 whitespace-nowrap">TSK-{String(t.id).padStart(4, '0')}</td>
                  <td className="max-w-md">
                    <div className="line-clamp-2 text-gray-800 font-medium">{cleanDesc(t.description || t.title)}</div>
                    {t.attachment_url && (
                      <a href={t.attachment_url} target="_blank" rel="noreferrer" className="text-[10px] text-blue-600 hover:underline flex items-center gap-1 mt-1">
                        <FiExternalLink size={10} /> View attachment
                      </a>
                    )}
                    {t.status === 'rejected' && t.reject_reason && (
                      <div className="text-[10px] text-red-700 mt-1 flex items-start gap-1"><FiAlertTriangle size={10} className="mt-0.5 flex-shrink-0" /> {t.reject_reason}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {canEditProject ? (
                      <input
                        type="text"
                        defaultValue={t.project_name || ''}
                        placeholder="— add —"
                        className="text-xs bg-transparent border border-transparent hover:border-gray-200 focus:border-red-400 focus:bg-white rounded px-1.5 py-0.5 w-32 focus:outline-none"
                        onBlur={e => saveProject(t, e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = t.project_name || ''; e.target.blur(); } }}
                        title="Click to edit project"
                      />
                    ) : (
                      <span className="text-xs text-gray-700">{t.project_name || <span className="text-gray-300">—</span>}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap">{t.assigned_to_name}</td>
                  <td className="whitespace-nowrap text-xs">
                    {completedDate
                      ? <span className="text-emerald-700 font-medium">Done {completedDate}</span>
                      : t.due_date
                        ? <span className="text-gray-600">Due {t.due_date}</span>
                        : <span className="text-gray-400">—</span>}
                  </td>
                  <td>{statusBadge(t.status)}</td>
                  <td>
                    {t.proof_url
                      ? <a href={t.proof_url} target="_blank" rel="noreferrer" className="text-red-600 text-xs hover:underline flex items-center gap-1"><FiExternalLink size={11} /> View</a>
                      : (isAssignee || isEA) && (t.status === 'pending' || t.status === 'rejected')
                        ? <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiUpload size={11} /> Upload</button>
                        : <span className="text-gray-400 text-xs">—</span>}
                  </td>
                  <td className="whitespace-nowrap">
                    {t.extension_status === 'pending' && t.requested_due_date ? (
                      <div className="flex flex-col gap-1">
                        <span className="text-[10px] text-amber-800 bg-amber-50 px-1.5 py-0.5 rounded border border-amber-200 inline-block">→ {t.requested_due_date}</span>
                        {isAdmin() && (
                          <div className="flex gap-1">
                            <button onClick={() => approveExtension(t)} className="text-[10px] text-emerald-600 font-bold hover:underline">Approve</button>
                            <button onClick={() => rejectExtension(t)} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                          </div>
                        )}
                      </div>
                    ) : isAssignee && t.status !== 'approved' ? (
                      <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="text-[11px] text-gray-500 hover:text-red-600 flex items-center gap-1"><FiCalendar size={11} /> Request</button>
                    ) : t.extension_status === 'rejected' ? (
                      <span className="text-[10px] text-gray-400">Rejected</span>
                    ) : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>
                    <div className="flex gap-1">
                      {isAdmin() && t.status === 'submitted' && (
                        <>
                          <button onClick={() => approve(t)} className="text-[10px] text-emerald-600 font-bold hover:underline">Approve</button>
                          <button onClick={() => { setRejectModal(t); setRejectReason(''); }} className="text-[10px] text-red-600 font-bold hover:underline">Reject</button>
                        </>
                      )}
                      {(isAssigner || isAdmin()) && <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12} /></button>}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Mobile-only card layout REMOVED — per mam's request, the desktop
          table is used on all screens now (horizontal scroll on phones).
          Kept the block below as `hidden` to avoid a rebase conflict if we
          ever want to restore it; adjust the `hidden` class below to
          `md:hidden space-y-2` to bring it back. */}
      <div className="hidden">
        {tasks.length === 0 && <div className="card text-center text-gray-400 py-8">No tasks</div>}
        {tasks.map((t, idx) => {
          const isAssignee = t.assigned_to === user?.id;
          const isAssigner = t.assigned_by === user?.id;
          const canEditProject = isAdmin() || isAssigner;
          const completedDate = t.reviewed_at ? new Date(t.reviewed_at).toLocaleDateString() : null;
          return (
            <div key={t.id} className={`card p-3 ${t.status === 'rejected' ? 'border-l-4 border-red-500' : t.status === 'submitted' ? 'border-l-4 border-blue-500' : ''}`}>
              <div className="flex justify-between items-start gap-2 mb-2">
                <span className="flex items-center gap-2">
                  <span className="text-[10px] text-gray-400 font-semibold">#{idx + 1}</span>
                  <span className="font-mono text-xs text-red-700">TSK-{String(t.id).padStart(4, '0')}</span>
                </span>
                {statusBadge(t.status)}
              </div>
              <p className="text-sm text-gray-800 font-medium mb-2 line-clamp-3">{cleanDesc(t.description || t.title)}</p>
              {t.attachment_url && (
                <a href={t.attachment_url} target="_blank" rel="noreferrer" className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 mb-2">
                  <FiExternalLink size={11} /> View attachment
                </a>
              )}

              {/* Project — always shown, inline-editable for admin/assigner,
                  read-only for others. Matches the desktop table column. */}
              <div className="mb-2 text-[11px] text-gray-600">
                <span className="text-gray-400">Project: </span>
                {canEditProject ? (
                  <input
                    type="text"
                    defaultValue={t.project_name || ''}
                    placeholder="— add —"
                    className="bg-transparent border border-transparent hover:border-gray-200 focus:border-red-400 focus:bg-white rounded px-1 py-0.5 text-[11px] font-semibold focus:outline-none w-[70%]"
                    onBlur={e => saveProject(t, e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); if (e.key === 'Escape') { e.target.value = t.project_name || ''; e.target.blur(); } }}
                  />
                ) : (
                  <b>{t.project_name || <span className="text-gray-300">—</span>}</b>
                )}
              </div>

              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px] text-gray-600 mb-2">
                <div><span className="text-gray-400">Assigned to:</span> <b>{t.assigned_to_name}</b></div>
                <div><span className="text-gray-400">By:</span> {t.assigned_by_name}</div>
                {completedDate ? (
                  <div className="col-span-2"><span className="text-gray-400">Completed:</span> <b className="text-emerald-700">{completedDate}</b></div>
                ) : t.due_date && (
                  <div className="col-span-2"><span className="text-gray-400">Due:</span> <b>{t.due_date}</b></div>
                )}
              </div>
              {t.status === 'rejected' && t.reject_reason && (
                <div className="bg-red-50 border border-red-200 rounded px-2 py-1 text-[11px] text-red-700 mb-2 flex items-start gap-1"><FiAlertTriangle size={11} className="mt-0.5" /> {t.reject_reason}</div>
              )}
              {t.extension_status === 'pending' && t.requested_due_date && (
                <div className="bg-amber-50 border border-amber-200 rounded px-2 py-1 text-[11px] text-amber-800 mb-2 flex items-start gap-1"><FiCalendar size={11} className="mt-0.5" /> Extension → {t.requested_due_date}</div>
              )}
              <div className="flex flex-wrap gap-1.5">
                {t.proof_url && <a href={t.proof_url} target="_blank" rel="noreferrer" className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiExternalLink size={11} /> Proof</a>}
                {(isAssignee || isEA) && (t.status === 'pending' || t.status === 'rejected') && (
                  <button onClick={() => { setSubmitModal(t); setSubmitForm({ proof_url: '', uploading: false }); }} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiUpload size={11} /> Upload Proof</button>
                )}
                {isAssignee && t.status !== 'approved' && t.extension_status !== 'pending' && (
                  <button onClick={() => { setExtendModal(t); setExtendForm({ requested_due_date: t.due_date || '', reason: '' }); }} className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1"><FiCalendar size={11} /> Extension</button>
                )}
                {isAdmin() && t.status === 'submitted' && (
                  <>
                    <button onClick={() => approve(t)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheck size={11} /> Approve</button>
                    <button onClick={() => { setRejectModal(t); setRejectReason(''); }} className="btn btn-danger text-[11px] px-2 py-1 flex items-center gap-1"><FiX size={11} /> Reject</button>
                  </>
                )}
                {isAdmin() && t.extension_status === 'pending' && (
                  <>
                    <button onClick={() => approveExtension(t)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheck size={11} /> Ext ✓</button>
                    <button onClick={() => rejectExtension(t)} className="btn btn-danger text-[11px] px-2 py-1 flex items-center gap-1"><FiX size={11} /> Ext ✗</button>
                  </>
                )}
                {(isAssigner || isAdmin()) && <button onClick={() => del(t)} className="p-1.5 text-gray-400 hover:text-red-600 ml-auto"><FiTrash2 size={13} /></button>}
              </div>
            </div>
          );
        })}
      </div>

      {/* Create Modal */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Assign New Task">
        <form onSubmit={save} className="space-y-3">
          <div>
            <label className="label flex items-center justify-between">
              <span>Task Description * {listening && <span className="ml-2 text-[10px] text-red-600 animate-pulse">● Listening…</span>}</span>
              <button type="button" onClick={toggleVoice} className={`text-[11px] px-2 py-1 rounded-full flex items-center gap-1 ${listening ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                {listening ? <><FiMicOff size={12} /> Stop</> : <><FiMic size={12} /> Voice</>}
              </button>
            </label>
            <textarea className="input" rows="4" required value={form.description || ''} onChange={e => setForm({ ...form, description: e.target.value, _base: undefined })} placeholder="Type or speak the task details…" />
            {!SR && <p className="text-[10px] text-amber-600 mt-0.5">Voice input needs Chrome or Edge browser.</p>}
          </div>
          <div>
            <label className="label">Assign To *</label>
            <SearchableSelect
              options={users.map(u => ({ ...u, label: `${u.name}${u.username ? ' (@' + u.username + ')' : ''}` }))}
              value={form.assigned_to || null}
              valueKey="id" displayKey="label"
              placeholder="Search user by name or username…"
              onChange={(u) => setForm({ ...form, assigned_to: u?.id || '' })}
            />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Due Date</label>
              <input className="input" type="date" value={form.due_date || ''} onChange={e => setForm({ ...form, due_date: e.target.value })} />
            </div>
            <div>
              <label className="label">Project Name <span className="text-gray-400 font-normal">(optional)</span></label>
              <input className="input" type="text" value={form.project_name || ''} onChange={e => setForm({ ...form, project_name: e.target.value })} placeholder="e.g. ONGC Mehsana" />
              <p className="text-[10px] text-gray-400 mt-0.5">Free text — you can edit this later from the list.</p>
            </div>
          </div>
          <div>
            <label className="label">Attachment <span className="text-gray-400 font-normal">(optional — e.g. brief, drawing, photo)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx"
              onChange={e => setForm({ ...form, attachment_file: e.target.files?.[0] || null })}
            />
            {form.attachment_file && <p className="text-[10px] text-emerald-600 mt-0.5">Selected: {form.attachment_file.name}</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Assign Task</button>
          </div>
        </form>
      </Modal>

      {/* Submit Proof Modal */}
      <Modal isOpen={!!submitModal} onClose={() => setSubmitModal(null)} title={submitModal ? `Submit proof — ${cleanDesc(submitModal.description || submitModal.title).slice(0, 60)}` : 'Submit proof'}>
        <form onSubmit={submitProof} className="space-y-3">
          {submitModal?.status === 'rejected' && submitModal.reject_reason && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
              <p className="font-semibold mb-0.5 flex items-center gap-1"><FiAlertTriangle size={12} /> Previous rejection</p>
              <p>{submitModal.reject_reason}</p>
            </div>
          )}
          <div>
            <label className="label">Upload proof (photo / PDF / doc)</label>
            <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" disabled={submitForm.uploading}
              onChange={e => { const f = e.target.files[0]; if (f) uploadProof(f); }}
              className="block w-full text-sm text-gray-500 file:mr-3 file:py-2 file:px-3 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
            {submitForm.uploading && <p className="text-xs text-red-500 mt-1">Uploading…</p>}
            {submitForm.proof_url && <p className="text-xs text-emerald-600 mt-1">✓ Ready to submit</p>}
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setSubmitModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={!submitForm.proof_url || submitForm.uploading} className="btn btn-primary disabled:opacity-50">Submit for Approval</button>
          </div>
        </form>
      </Modal>

      {/* Reject Modal */}
      <Modal isOpen={!!rejectModal} onClose={() => setRejectModal(null)} title={rejectModal ? `Reject — ${cleanDesc(rejectModal.description || rejectModal.title).slice(0, 60)}` : 'Reject'}>
        <form onSubmit={reject} className="space-y-3">
          <div>
            <label className="label">Reason for rejection *</label>
            <textarea className="input" rows="3" value={rejectReason} onChange={e => setRejectReason(e.target.value)} required placeholder="Explain what needs to change so the assignee can fix and resubmit" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setRejectModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-danger">Reject & Send Back</button>
          </div>
        </form>
      </Modal>

      {/* Request Extension Modal (assignee) — routed to admin for approval */}
      <Modal isOpen={!!extendModal} onClose={() => setExtendModal(null)} title="Request Due-Date Extension">
        <form onSubmit={requestExtension} className="space-y-3">
          <p className="text-xs text-gray-500">Ask admin for more time on this task. They will see your request and approve or reject it.</p>
          <div>
            <label className="label">New requested date *</label>
            <input className="input" type="date" required min={extendModal?.due_date || undefined}
              value={extendForm.requested_due_date} onChange={e => setExtendForm(s => ({ ...s, requested_due_date: e.target.value }))} />
            {extendModal?.due_date && <p className="text-[10px] text-gray-400 mt-0.5">Current due date: {extendModal.due_date}</p>}
          </div>
          <div>
            <label className="label">Reason *</label>
            <textarea className="input" rows="3" required value={extendForm.reason} onChange={e => setExtendForm(s => ({ ...s, reason: e.target.value }))} placeholder="Why do you need more time?" />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setExtendModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Send Request</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
