// Client Snag — client-facing snags (e.g. a bill that came back without the
// client's signature), raised against a client/site.
//
// Two identity-gated actions (enforced server-side, this page only mirrors
// it for a clean UI): Ajmer uploads/replaces the snag photo and submits for
// approval; Lovely Sharma approves or rejects (rejection needs a reason).
// Everyone else can view according to the normal client_snag role
// permission.
//
// Workflow: awaiting_document → pending_approval → approved (locked)
//                                                 → rejected → resubmit

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiCamera, FiPlus, FiCheckCircle, FiXCircle, FiUploadCloud, FiTrash2, FiSearch, FiSettings } from 'react-icons/fi';
import { fmtDate, fmtDateTime } from '../utils/datetime';

const STATUS_PILL = {
  awaiting_document: 'bg-amber-100 text-amber-700',
  pending_approval: 'bg-blue-100 text-blue-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};
const STATUS_LABEL = {
  awaiting_document: 'Awaiting Document',
  pending_approval: 'Pending Approval',
  approved: 'Approved',
  rejected: 'Rejected',
};
const PRIORITY_PILL = {
  low: 'bg-gray-100 text-gray-600 border-gray-300',
  medium: 'bg-blue-50 text-blue-700 border-blue-300',
  high: 'bg-amber-50 text-amber-700 border-amber-300',
  critical: 'bg-red-50 text-red-700 border-red-300',
};

export default function ClientSnag() {
  const { canCreate, canDelete, isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [counters, setCounters] = useState(null);
  const [filters, setFilters] = useState({ status: '', priority: '', client: '', site: '', date: '', search: '' });
  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({});
  const [detail, setDetail] = useState(null);        // full detail of the open snag
  const [uploading, setUploading] = useState(false);
  const [rejectFor, setRejectFor] = useState(null);   // snag id being rejected
  const [rejectReason, setRejectReason] = useState('');
  const [approveFor, setApproveFor] = useState(null); // snag id being approved (confirm modal)
  const [gate, setGate] = useState(null);              // admin reassign panel
  const [users, setUsers] = useState([]);              // every ERP user — for Assign To + admin Reassign

  const load = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/client-snag?${params}`).then(r => setRows(r.data || [])).catch(() => {});
  }, [filters]);

  const loadCounters = useCallback(() => {
    api.get('/client-snag/counters').then(r => setCounters(r.data)).catch(() => {});
  }, []);

  useEffect(() => { load(); loadCounters(); }, [load, loadCounters]);
  // Assign To needs every person in the ERP, not just active ones.
  useEffect(() => { api.get('/auth/users').then(r => setUsers(r.data || [])).catch(() => {}); }, []);

  const upload = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch (err) {
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
      return null;
    } finally { setUploading(false); }
  };

  const openCreate = () => {
    setForm({ priority: 'medium' });
    setCreateModal(true);
  };
  // field is 'before_photo_url' (open to whoever raises the snag) or
  // 'photo_url' (the After Photo — convenience upload, Ajmer-only; the
  // backend independently re-checks who's allowed to attach it).
  const uploadForCreate = async (field, file) => {
    const url = await upload(file);
    if (url) setForm(f => ({ ...f, [field]: url, [`${field}_at_preview`]: new Date().toISOString() }));
  };
  const create = async (e) => {
    e.preventDefault();
    if (!form.client_name?.trim()) return toast.error('Client is required');
    if (!form.assigned_to) return toast.error('Assign To is required');
    if (!form.site_name?.trim()) return toast.error('Site Name is required');
    if (!form.location?.trim()) return toast.error('Location is required');
    if (!form.description?.trim()) return toast.error('Description is required');
    if (!form.before_photo_url) return toast.error('Before Photo is required');
    try {
      const r = await api.post('/client-snag', form);
      // Attach the photo right away if one was picked here (uploader only —
      // the backend re-checks this independently either way).
      if (form.photo_url) {
        try { await api.post(`/client-snag/${r.data.id}/document`, { photo_url: form.photo_url }); }
        catch (err) { toast.error(err.response?.data?.error || 'Photo could not be attached'); }
      }
      toast.success(`Created ${r.data.snag_no}`);
      setCreateModal(false); setForm({}); load(); loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openDetail = (id) => {
    api.get(`/client-snag/${id}`).then(r => setDetail(r.data)).catch(() => toast.error('Failed to load'));
  };
  const refreshDetail = () => { if (detail) openDetail(detail.id); };

  const uploadDocument = async (file) => {
    const url = await upload(file);
    if (!url || !detail) return;
    try {
      await api.post(`/client-snag/${detail.id}/document`, { photo_url: url });
      toast.success('Photo uploaded');
      refreshDetail(); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const submitForApproval = async () => {
    if (!detail) return;
    try {
      await api.post(`/client-snag/${detail.id}/submit`);
      toast.success('Submitted for approval');
      refreshDetail(); load(); loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doApprove = async () => {
    if (!approveFor) return;
    try {
      await api.post(`/client-snag/${approveFor}/approve`);
      toast.success('Approved');
      setApproveFor(null);
      if (detail?.id === approveFor) refreshDetail();
      load(); loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doReject = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) return toast.error('Rejection reason is required');
    try {
      await api.post(`/client-snag/${rejectFor}/reject`, { reason: rejectReason });
      toast.success('Rejected — uploader can resubmit');
      const wasDetail = detail?.id === rejectFor;
      setRejectFor(null); setRejectReason('');
      if (wasDetail) refreshDetail();
      load(); loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.snag_no}?`)) return;
    try { await api.delete(`/client-snag/${row.id}`); toast.success('Deleted'); load(); loadCounters(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  const openGate = () => {
    api.get('/client-snag/settings/gate').then(r => setGate(r.data)).catch(() => toast.error('Failed to load'));
  };
  const reassign = async (roleKey, userId) => {
    if (!userId) return;
    try {
      await api.put('/client-snag/settings/gate', { role_key: roleKey, user_id: userId });
      toast.success('Reassigned');
      openGate(); load(); loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiCamera className="text-red-600" /> Client Snag</h1>
          <p className="text-sm text-gray-500">Client-facing snags — e.g. a bill missing the client's signature.</p>
        </div>
        <div className="flex gap-2">
          {isAdmin() && (
            <button onClick={openGate} className="btn btn-secondary flex items-center gap-1 text-sm"><FiSettings size={14} /> Reassign</button>
          )}
          {canCreate('client_snag') && (
            <button onClick={openCreate} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> New Client Snag</button>
          )}
        </div>
      </div>

      {counters && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {counters.is_uploader && (
            <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Awaiting Document</p><p className="text-2xl font-bold text-amber-600">{counters.awaiting_document}</p></div>
          )}
          <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Pending Approval</p><p className="text-2xl font-bold text-blue-600">{counters.pending_approval}</p></div>
          <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-emerald-600">{counters.approved}</p></div>
          <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Rejected</p><p className="text-2xl font-bold text-red-700">{counters.rejected}</p></div>
        </div>
      )}

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[160px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9 text-sm" placeholder="Search snag #, client, site, description…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        <div className="w-40 shrink-0">
          <label className="label">Client</label>
          <input className="input" value={filters.client} onChange={e => setFilters(f => ({ ...f, client: e.target.value }))} />
        </div>
        <div className="w-40 shrink-0">
          <label className="label">Site / Location</label>
          <input className="input" value={filters.site} onChange={e => setFilters(f => ({ ...f, site: e.target.value }))} />
        </div>
        <div className="w-32 shrink-0">
          <label className="label">Priority</label>
          <select className="select" value={filters.priority} onChange={e => setFilters(f => ({ ...f, priority: e.target.value }))}>
            <option value="">All</option>
            <option value="critical">Critical</option>
            <option value="high">High</option>
            <option value="medium">Medium</option>
            <option value="low">Low</option>
          </select>
        </div>
        <div className="w-44 shrink-0">
          <label className="label">Status</label>
          <select className="select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All</option>
            <option value="awaiting_document">Awaiting Document</option>
            <option value="pending_approval">Pending Approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
        <div className="w-40 shrink-0">
          <label className="label">Date</label>
          <input type="date" className="input" value={filters.date} onChange={e => setFilters(f => ({ ...f, date: e.target.value }))} />
        </div>
      </div>

      <div className="card p-0">
        <div className="overflow-auto max-h-[70vh]">
        <table className="freeze-head freeze-col min-w-[850px]">
          <thead>
            <tr>
              <th>Snag ID</th><th>Client</th><th>Assign To</th><th>Before Photo</th><th>Raised Date</th>
              <th>After Photo</th><th>Site / Location</th><th>Description</th><th>Priority</th><th>Status</th><th>Action</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan="11" className="text-center py-8 text-gray-400">No Client Snags yet</td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="font-bold text-red-700 text-xs">{r.snag_no}</td>
                <td className="text-xs">{r.client_name || '—'}</td>
                <td className="text-xs">{r.assigned_to_user_name || r.assigned_to_name || <span className="text-gray-300">—</span>}</td>
                <td>
                  {r.before_photo_url
                    ? <a href={r.before_photo_url} target="_blank" rel="noreferrer"><img src={r.before_photo_url} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded" /></a>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="text-xs">{r.raised_at ? fmtDate(r.raised_at) : '—'}</td>
                <td>
                  {r.photo_url
                    ? <a href={r.photo_url} target="_blank" rel="noreferrer"><img src={r.photo_url} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded ring-2 ring-emerald-400" /></a>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="text-xs">
                  <div className="font-medium">{r.site_name || '—'}</div>
                  {r.location && <div className="text-[10px] text-gray-500">{r.location}</div>}
                </td>
                <td className="text-xs max-w-md">
                  <div className="line-clamp-2" title={r.description}>{r.description}</div>
                  {r.status === 'rejected' && r.rejection_reason && (
                    <div className="text-[10px] text-red-600 mt-0.5 italic" title={r.rejection_reason}>↳ rejected: {r.rejection_reason.slice(0, 60)}</div>
                  )}
                </td>
                <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[r.priority] || ''}`}>{r.priority}</span></td>
                <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[r.status] || ''}`}>{STATUS_LABEL[r.status] || r.status}</span></td>
                <td className="whitespace-nowrap">
                  <button onClick={() => openDetail(r.id)} className="btn btn-secondary text-[10px] px-2 py-1 mr-1">View</button>
                  {canDelete('client_snag') && (
                    <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* CREATE MODAL */}
      <Modal isOpen={createModal} onClose={() => { setCreateModal(false); setForm({}); }} title="New Client Snag" wide>
        <form onSubmit={create} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Client *</label>
              <input className="input" required value={form.client_name || ''} onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))} placeholder="Client name" />
            </div>
            <div>
              <label className="label">Assign To *</label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                value={form.assigned_to || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick person…"
                onChange={(u) => setForm(f => ({ ...f, assigned_to: u?.id || '', assigned_to_name: u?.name || '' }))}
              />
            </div>
            <div>
              <label className="label">Site Name *</label>
              <input className="input" required value={form.site_name || ''} onChange={e => setForm(f => ({ ...f, site_name: e.target.value }))} />
            </div>
            <div>
              <label className="label">Location *</label>
              <input className="input" required value={form.location || ''} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. 2nd floor accounts desk" />
            </div>
            <div className="col-span-1 sm:col-span-2">
              <label className="label">Description *</label>
              <textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What's the snag?" />
            </div>
            <div>
              <label className="label">Priority *</label>
              <select className="select" required value={form.priority || 'medium'} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
          </div>

          {/* Before Photo — documents the problem at raise time. Open to
              whoever raises the snag, not identity-gated. */}
          <div>
            <label className="label">Before Photo *</label>
            {form.before_photo_url ? (
              <div className="flex items-start gap-3">
                <img src={form.before_photo_url} alt="" width="96" height="96" decoding="async" className="w-24 h-24 object-cover rounded border" />
                <div className="text-xs text-gray-500">
                  <div>Date of Upload: {form.before_photo_url_at_preview ? fmtDateTime(form.before_photo_url_at_preview) : '—'}</div>
                  <button type="button" onClick={() => setForm(f => ({ ...f, before_photo_url: '', before_photo_url_at_preview: null }))} className="text-red-500 mt-1">Remove</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                  <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => { await uploadForCreate('before_photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                  <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                  <input type="file" accept="image/*,.pdf" className="hidden" onChange={async e => { await uploadForCreate('before_photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </div>

          {/* After Photo upload here is a convenience for the uploader
              (Ajmer) only — anyone else can still create the record and
              Ajmer uploads it afterwards from the detail view. The backend
              independently re-checks who's allowed to attach it either way. */}
          {counters?.is_uploader && (
            <div>
              <label className="label">After Photo <span className="text-gray-400 font-normal text-[10px]">(optional here — you'll normally upload this once the snag is resolved)</span></label>
              {form.photo_url ? (
                <div className="flex items-start gap-3">
                  <img src={form.photo_url} alt="" width="96" height="96" decoding="async" className="w-24 h-24 object-cover rounded border" />
                  <div className="text-xs text-gray-500">
                    <div>Date of Upload: {form.photo_url_at_preview ? fmtDateTime(form.photo_url_at_preview) : '—'}</div>
                    <button type="button" onClick={() => setForm(f => ({ ...f, photo_url: '', photo_url_at_preview: null }))} className="text-red-500 mt-1">Remove</button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => { await uploadForCreate('photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={async e => { await uploadForCreate('photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </div>
              )}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => { setCreateModal(false); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Create'}</button>
          </div>
        </form>
      </Modal>

      {/* DETAIL MODAL */}
      <Modal isOpen={!!detail} onClose={() => setDetail(null)} title={detail ? `${detail.snag_no}` : ''} wide>
        {detail && (
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded text-sm grid grid-cols-1 sm:grid-cols-2 gap-2">
              <div><span className="text-gray-500">Client:</span> {detail.client_name || '—'}</div>
              <div><span className="text-gray-500">Assign To:</span> {detail.assigned_to_user_name || detail.assigned_to_name || '—'}</div>
              <div><span className="text-gray-500">Site / Location:</span> {detail.site_name || '—'}{detail.location ? ` · ${detail.location}` : ''}</div>
              <div><span className="text-gray-500">Priority:</span> <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[detail.priority] || ''}`}>{detail.priority}</span></div>
              <div className="col-span-1 sm:col-span-2"><span className="text-gray-500">Description:</span> {detail.description}</div>
              <div><span className="text-gray-500">Status:</span> <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[detail.status] || ''}`}>{STATUS_LABEL[detail.status] || detail.status}</span></div>
              <div><span className="text-gray-500">Raised:</span> {detail.raised_at ? fmtDateTime(detail.raised_at) : '—'} {detail.raised_by_name ? `· by ${detail.raised_by_name}` : ''}</div>
            </div>

            <div>
              <label className="label">Before Photo</label>
              {detail.before_photo_url ? (
                <a href={detail.before_photo_url} target="_blank" rel="noreferrer">
                  <img src={detail.before_photo_url} alt="" width="160" height="160" decoding="async" className="w-40 h-40 object-cover rounded border" />
                </a>
              ) : (
                <div className="text-xs text-gray-400">No before photo uploaded.</div>
              )}
            </div>

            <div>
              <label className="label">After Photo</label>
              {detail.photo_url ? (
                <div className="flex items-start gap-3">
                  <a href={detail.photo_url} target="_blank" rel="noreferrer">
                    <img src={detail.photo_url} alt="" width="160" height="160" decoding="async" className="w-40 h-40 object-cover rounded border" />
                  </a>
                  <div className="text-xs text-gray-500">
                    <div>Uploaded By: {detail.uploaded_by_name || '—'}</div>
                    <div>Uploaded At: {detail.uploaded_at ? fmtDateTime(detail.uploaded_at) : '—'}</div>
                  </div>
                </div>
              ) : (
                <div className="text-xs text-gray-400">No after photo uploaded yet.</div>
              )}
              {detail.status === 'rejected' && detail.rejection_reason && (
                <div className="text-xs text-red-600 mt-1 italic">Rejected — {detail.rejection_reason}</div>
              )}
            </div>

            {/* Ajmer's actions — upload/replace + submit. Never approve/reject. */}
            {detail.can_upload && (
              <div className="border-t pt-3 space-y-2">
                <label className="label">{detail.photo_url ? 'Replace After Photo' : 'Upload After Photo'}</label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => { await uploadDocument(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={async e => { await uploadDocument(e.target.files?.[0]); e.target.value = ''; }} />
                  </label>
                </div>
                {detail.photo_url && detail.status === 'awaiting_document' && (
                  <button onClick={submitForApproval} disabled={uploading} className="btn btn-primary flex items-center gap-1">
                    <FiUploadCloud size={14} /> Submit for Approval
                  </button>
                )}
              </div>
            )}

            {/* Lovely Sharma's actions — approve/reject only, never upload. */}
            {detail.can_approve_this && (
              <div className="border-t pt-3 flex gap-2">
                <button onClick={() => setApproveFor(detail.id)} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={14} /> Approve</button>
                <button onClick={() => { setRejectFor(detail.id); setRejectReason(''); }} className="btn btn-danger flex items-center gap-1"><FiXCircle size={14} /> Reject</button>
              </div>
            )}

            <div className="border-t pt-3">
              <div className="text-xs font-semibold text-gray-700 mb-1">History</div>
              <div className="space-y-1 max-h-48 overflow-y-auto border rounded p-2 bg-gray-50">
                {(detail.history || []).length === 0 && <div className="text-[11px] text-gray-400">No activity yet.</div>}
                {(detail.history || []).map(h => (
                  <div key={h.id} className="text-[11px] text-gray-700 border-b last:border-0 pb-1">
                    <span className="text-gray-400 font-mono">{fmtDateTime(h.created_at)}</span>
                    <span className="ml-1 font-semibold">{h.action}</span>
                    {h.note && <span className="text-gray-600"> · {h.note}</span>}
                    {h.user_name && <span className="text-gray-400"> · by {h.user_name}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* APPROVE CONFIRM MODAL */}
      <Modal isOpen={!!approveFor} onClose={() => setApproveFor(null)} title="Approve Client Snag?">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Are you sure you want to approve this Client Snag?</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setApproveFor(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={doApprove} className="btn btn-success">Approve</button>
          </div>
        </div>
      </Modal>

      {/* REJECT MODAL — mandatory reason */}
      <Modal isOpen={!!rejectFor} onClose={() => { setRejectFor(null); setRejectReason(''); }} title="Reject Client Snag">
        <form onSubmit={doReject} className="space-y-3">
          <label className="label">Reason for rejection *</label>
          <textarea className="input" rows="3" required value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="Why is this being rejected?" />
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => { setRejectFor(null); setRejectReason(''); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={!rejectReason.trim()} className="btn btn-danger">Reject Snag</button>
          </div>
        </form>
      </Modal>

      {/* ADMIN REASSIGN PANEL */}
      <Modal isOpen={!!gate} onClose={() => setGate(null)} title="Reassign Uploader / Approver">
        {gate && (
          <div className="space-y-4">
            {['uploader', 'approver'].map(roleKey => (
              <div key={roleKey}>
                <label className="label capitalize">{roleKey} {roleKey === 'uploader' ? '(uploads the snag photo)' : '(approves / rejects)'}</label>
                <div className="text-xs text-gray-500 mb-1">
                  Currently: {gate[roleKey]?.user_name || 'unresolved'} {gate[roleKey]?.source === 'name_fallback' && <span className="italic">(name match, not yet set explicitly)</span>}
                </div>
                <SearchableSelect
                  options={users.map(u => ({ ...u, label: u.name }))}
                  value={gate[roleKey]?.user_id || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Pick user…"
                  onChange={(u) => reassign(roleKey, u?.id)}
                />
              </div>
            ))}
          </div>
        )}
      </Modal>
    </div>
  );
}
