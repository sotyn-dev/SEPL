// Snag List — site defects raised by management.
//
// Workflow (mam: 'assign employee will upload proof and after approval
// task close like delegation'):
//
//   Raise Snag (mgmt)
//       ↓ status=open, assignee notified
//   Submit Proof (assignee uploads photo)
//       ↓ status=submitted, raiser notified
//   Approve  → status=approved (closed)
//   Reject   → status=rejected, assignee can resubmit
//
// Permission gates: snags.view / create / edit / approve / delete.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiAlertTriangle, FiCheckCircle, FiXCircle, FiUploadCloud, FiTrash2, FiEdit2, FiSearch, FiDownload } from 'react-icons/fi';
import { fmtDate } from '../utils/datetime';

// How many rows we ADD to the DOM each time the user scrolls near the bottom
// of the table box. This is render-only chunking, NOT pagination: the whole
// filtered list stays in memory (and drives the summary cards + export) — we
// just don't mount 200+ <tr>s, each with two thumbnails, up front.
const CHUNK = 50;
// Start mounting the next chunk this far before the last row scrolls into
// view, so rows are ready by the time the user gets to them.
const PREFETCH_PX = 400;

const STATUS_PILL = {
  open: 'bg-amber-100 text-amber-700',
  submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};
const STATUS_LABEL = {
  open: 'Open',
  submitted: 'Awaiting Approval',
  approved: 'Approved',
  rejected: 'Rejected — Resubmit',
};
const PRIORITY_PILL = {
  low: 'bg-gray-100 text-gray-600 border-gray-300',
  medium: 'bg-blue-50 text-blue-700 border-blue-300',
  high: 'bg-amber-50 text-amber-700 border-amber-300',
  critical: 'bg-red-50 text-red-700 border-red-300',
};

export default function Snags() {
  const { canCreate, canEdit, canDelete, canApprove, isAdmin, user } = useAuth();
  const [snags, setSnags] = useState([]);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ status: '', priority: '', search: '', scope: '', site_id: '' });
  const [modal, setModal] = useState(false);          // raise/edit
  const [proofModal, setProofModal] = useState(null); // snag obj being submitted
  const [proofForm, setProofForm] = useState({});
  const [form, setForm] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  // Rows currently mounted. Grows by CHUNK as the user scrolls; reset back to
  // one chunk whenever the list itself changes (new filter/search result).
  const [visibleCount, setVisibleCount] = useState(CHUNK);
  const scrollBoxRef = useRef(null);   // the table's own overflow container
  const [lastRowEl, setLastRowEl] = useState(null); // last mounted <tr>

  const load = useCallback(() => {
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    api.get(`/snags?${params}`).then(r => setSnags(r.data || [])).catch(() => {});
  }, [filters]);

  // Summary cards reflect exactly what the filtered list shows (site,
  // status, priority, search, scope) — derived from the loaded rows so
  // the numbers always match the table below.
  const stats = useMemo(() => {
    const s = { total: snags.length, open: 0, submitted: 0, approved: 0, rejected: 0, critical: 0 };
    for (const x of snags) {
      if (x.status === 'open') s.open++;
      else if (x.status === 'submitted') s.submitted++;
      else if (x.status === 'approved') s.approved++;
      else if (x.status === 'rejected') s.rejected++;
      if (x.priority === 'critical' && x.status !== 'approved') s.critical++;
    }
    return s;
  }, [snags]);

  // ─── Scroll-in rendering ────────────────────────────────────────────
  // Search / status / priority / site / scope all run SERVER-side (see load
  // above), so `snags` is always the complete matching set — every filter
  // still searches the whole list, not just what's on screen. All this does
  // is meter how much of that set is in the DOM at once.
  const visibleRows = useMemo(() => snags.slice(0, visibleCount), [snags, visibleCount]);
  const hasMore = visibleCount < snags.length;
  // A fresh result set (any filter change) starts from the top again.
  useEffect(() => { setVisibleCount(CHUNK); scrollBoxRef.current?.scrollTo({ top: 0 }); }, [snags]);

  // Watch the last mounted row; when it nears the bottom of the scroll box,
  // mount the next chunk. Runs as an effect (not a ref callback) so
  // scrollBoxRef is guaranteed to be attached before the observer is built.
  useEffect(() => {
    if (!lastRowEl || !hasMore) return;
    const io = new IntersectionObserver(
      entries => { if (entries[0].isIntersecting) setVisibleCount(c => Math.min(c + CHUNK, snags.length)); },
      { root: scrollBoxRef.current, rootMargin: `0px 0px ${PREFETCH_PX}px 0px` },
    );
    io.observe(lastRowEl);
    return () => io.disconnect();
  }, [lastRowEl, hasMore, snags.length]);

  // Export the (filtered) snag list as a real .xlsx WITH the defect + proof
  // photos embedded. CSV can't carry images, so this hits the server which
  // builds the workbook; filters mirror the on-screen list.
  const exportXlsx = async () => {
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      const resp = await api.get(`/snags/export.xlsx?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `snags-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success('Downloaded snags with photos');
    } catch (e) { toast.error('Export failed'); }
  };

  useEffect(() => {
    load();
    api.get('/dpr/sites?all=1').then(r => setSites(r.data || [])).catch(() => {});
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
  }, [load]);

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

  const openRaise = () => {
    setEditingId(null);
    setForm({ priority: 'medium' });
    setModal(true);
  };
  const openEdit = (s) => {
    setEditingId(s.id);
    setForm({
      site_id: s.site_id || '',
      site_name: s.site_name || '',
      location: s.location || '',
      description: s.description || '',
      photo_url: s.photo_url || '',
      priority: s.priority || 'medium',
      assigned_to: s.assigned_to || '',
      assigned_to_name: s.assigned_to_name || '',
      target_date: s.target_date || '',
    });
    setModal(true);
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.description?.trim()) return toast.error('Description is required');
    try {
      if (editingId) {
        await api.put(`/snags/${editingId}`, form);
        toast.success('Snag updated');
      } else {
        const r = await api.post('/snags', form);
        toast.success(`Raised ${r.data.snag_no}`);
      }
      setModal(false); setForm({}); setEditingId(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const submitProof = async (e) => {
    e.preventDefault();
    if (!proofForm.proof_url) return toast.error('Please upload the proof photo');
    try {
      await api.post(`/snags/${proofModal.id}/submit`, proofForm);
      toast.success('Proof submitted — awaiting approval');
      setProofModal(null); setProofForm({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const approve = async (s) => {
    if (!confirm(`Approve ${s.snag_no} and close it?`)) return;
    try { await api.post(`/snags/${s.id}/approve`); toast.success('Approved — snag closed'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const reject = async (s) => {
    const reason = prompt(`Reject ${s.snag_no}.\n\nReason (assignee will see this):`);
    if (!reason) return;
    try { await api.post(`/snags/${s.id}/reject`, { reason }); toast.success('Rejected — assignee can resubmit'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const remove = async (s) => {
    if (!confirm(`Delete ${s.snag_no}?`)) return;
    try { await api.delete(`/snags/${s.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
  };

  // Helpers for action visibility
  const isMine = (s) => s.raised_by === user?.id;
  const isAssignee = (s) => s.assigned_to === user?.id;
  const canActAsApprover = (s) => isMine(s) || canApprove('snags') || isAdmin();

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiAlertTriangle className="text-red-600" /> Snag List</h1>
          <p className="text-sm text-gray-500">Management raises site snags · assignee uploads proof · raiser approves to close.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={exportXlsx}
            className="btn btn-secondary flex items-center gap-1 text-sm"><FiDownload size={14} /> Export Excel</button>
          {canCreate('snags') && (
            <button onClick={openRaise} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Raise Snag</button>
          )}
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Open</p><p className="text-2xl font-bold text-amber-600">{stats.open}</p></div>
          <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Awaiting Approval</p><p className="text-2xl font-bold text-blue-600">{stats.submitted}</p></div>
          <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-emerald-600">{stats.approved}</p></div>
          <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Critical Open</p><p className="text-2xl font-bold text-red-700">{stats.critical}</p></div>
          <div className="card p-3 border-l-4 border-gray-500"><p className="text-xs text-gray-500">Total</p><p className="text-2xl font-bold">{stats.total}</p></div>
        </div>
      )}

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[160px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9 text-sm" placeholder="Search snag #, site, location, description…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
        </div>
        <div className="w-36 shrink-0">
          <label className="label">Scope</label>
          <select className="select" value={filters.scope} onChange={e => setFilters(f => ({ ...f, scope: e.target.value }))}>
            <option value="">All</option>
            <option value="mine">Mine (raised / assigned)</option>
          </select>
        </div>
        <div className="w-48 shrink-0">
          <label className="label">Site</label>
          <select className="select" value={filters.site_id} onChange={e => setFilters(f => ({ ...f, site_id: e.target.value }))}>
            <option value="">All</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div className="w-40 shrink-0">
          <label className="label">Status</label>
          <select className="select" value={filters.status} onChange={e => setFilters(f => ({ ...f, status: e.target.value }))}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="submitted">Awaiting Approval</option>
            <option value="approved">Approved</option>
            <option value="rejected">Rejected</option>
          </select>
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
      </div>

      {/* Reverted to the original 10-column table per mam
          (2026-05-21: "dont change also snag list old is ok"). */}
      <div className="card p-0">
        {/* Own bounded scroll box → the sticky `freeze-head` thead pins to
            THIS container's top (Excel-style frozen header), and `freeze-col`
            keeps the Snag-No column fixed during horizontal scroll.
            mam (2026-07-28): "freeze like excel". */}
        <div ref={scrollBoxRef} className="overflow-auto max-h-[70vh]">
        <table className="freeze-head freeze-col w-full">
          <thead>
            <tr>
              <th>Snag No</th><th>Raised</th><th>Site / Location</th><th>Description</th>
              <th>Snag Photo</th><th>Assigned To</th><th>Proof</th>
              <th>Priority</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {snags.length === 0 && (
              <tr><td colSpan="10" className="text-center py-8 text-gray-400">No snags raised yet</td></tr>
            )}
            {visibleRows.map((s, i) => (
              <tr key={s.id} ref={i === visibleRows.length - 1 ? setLastRowEl : undefined}>
                <td className="font-bold text-red-700 text-xs">{s.snag_no}</td>
                <td className="text-xs">
                  <div>{s.raised_at ? fmtDate(s.raised_at) : '—'}</div>
                  <div className="text-[10px] text-gray-500">{s.raised_by_name || '—'}</div>
                </td>
                <td className="text-xs">
                  <div className="font-medium">{s.site_name || s.site_name_live || '—'}</div>
                  {s.location && <div className="text-[10px] text-gray-500">{s.location}</div>}
                </td>
                <td className="text-xs max-w-md">
                  <div className="line-clamp-2" title={s.description}>{s.description}</div>
                  {s.status === 'rejected' && s.reject_reason && (
                    <div className="text-[10px] text-red-600 mt-0.5 italic" title={s.reject_reason}>↳ rejected: {s.reject_reason.slice(0, 60)}</div>
                  )}
                </td>
                <td>
                  {s.photo_url
                    ? <a href={s.photo_url} target="_blank" rel="noreferrer"><img src={s.photo_url} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded" /></a>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="text-xs">{s.assigned_to_user_name || s.assigned_to_name || <span className="text-gray-300">—</span>}</td>
                <td>
                  {s.proof_url
                    ? <a href={s.proof_url} target="_blank" rel="noreferrer"><img src={s.proof_url} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded ring-2 ring-emerald-400" /></a>
                    : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[s.priority] || ''}`}>{s.priority}</span>
                </td>
                <td>
                  <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[s.status] || ''}`}>{STATUS_LABEL[s.status] || s.status}</span>
                </td>
                <td className="whitespace-nowrap">
                  {(isAssignee(s) || canApprove('snags') || isAdmin()) && (s.status === 'open' || s.status === 'rejected') && (
                    <button onClick={() => { setProofModal(s); setProofForm({}); }} className="btn btn-primary text-[10px] px-2 py-1 mr-1" title="Upload proof"><FiUploadCloud size={11} className="inline" /> {s.status === 'rejected' ? 'Resubmit' : 'Submit Proof'}</button>
                  )}
                  {s.status === 'submitted' && canActAsApprover(s) && (
                    <>
                      <button onClick={() => approve(s)} className="btn btn-success text-[10px] px-2 py-1 mr-1"><FiCheckCircle size={11} className="inline" /> Approve</button>
                      <button onClick={() => reject(s)} className="btn btn-danger text-[10px] px-2 py-1 mr-1"><FiXCircle size={11} className="inline" /> Reject</button>
                    </>
                  )}
                  {(canEdit('snags') || isAdmin()) && s.status !== 'approved' && (
                    <button onClick={() => openEdit(s)} className="p-1 text-gray-400 hover:text-blue-600" title="Edit"><FiEdit2 size={12} /></button>
                  )}
                  {canDelete('snags') && (
                    <button onClick={() => remove(s)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      </div>

      {/* RAISE / EDIT MODAL */}
      <Modal isOpen={modal} onClose={() => { setModal(false); setEditingId(null); setForm({}); }} title={editingId ? 'Edit Snag' : 'Raise Snag'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Site Name</label>
              <SearchableSelect
                options={sites}
                value={form.site_id || null}
                valueKey="id"
                displayKey="name"
                placeholder="Pick site…"
                onChange={(s) => setForm(f => ({ ...f, site_id: s?.id || '', site_name: s?.name || '' }))}
              />
            </div>
            <div>
              <label className="label">Location <span className="text-gray-400 font-normal text-[10px]">(within site)</span></label>
              <input className="input" value={form.location || ''} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. 2nd floor pump room" />
            </div>
            <div className="col-span-2">
              <label className="label">Description *</label>
              <textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What's wrong / needs fixing?" />
            </div>
            <div className="col-span-2">
              <label className="label">Snag Photo</label>
              {form.photo_url ? (
                <div className="flex items-start gap-3">
                  <img src={form.photo_url} alt="" width="128" height="128" decoding="async" className="w-32 h-32 object-cover rounded border" />
                  <button type="button" onClick={() => setForm(f => ({ ...f, photo_url: '' }))} className="text-red-500 text-xs">Remove</button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => {
                      const url = await upload(e.target.files?.[0]); if (url) setForm(f => ({ ...f, photo_url: url }));
                      e.target.value = '';
                    }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                    <input type="file" accept="image/*" className="hidden" onChange={async e => {
                      const url = await upload(e.target.files?.[0]); if (url) setForm(f => ({ ...f, photo_url: url }));
                      e.target.value = '';
                    }} />
                  </label>
                </div>
              )}
            </div>
            <div>
              <label className="label">Assign To <span className="text-gray-400 font-normal text-[10px]">(employee)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                value={form.assigned_to || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick employee…"
                onChange={(u) => setForm(f => ({ ...f, assigned_to: u?.id || '', assigned_to_name: u?.name || '' }))}
              />
            </div>
            <div>
              <label className="label">Priority</label>
              <select className="select" value={form.priority || 'medium'} onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}>
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
                <option value="critical">Critical</option>
              </select>
            </div>
            <div>
              <label className="label">Target Date</label>
              <input type="date" className="input" value={form.target_date || ''} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => { setModal(false); setEditingId(null); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : (editingId ? 'Save' : 'Raise Snag')}</button>
          </div>
        </form>
      </Modal>

      {/* SUBMIT PROOF MODAL */}
      <Modal isOpen={!!proofModal} onClose={() => { setProofModal(null); setProofForm({}); }} title={proofModal ? `Submit Proof — ${proofModal.snag_no}` : ''}>
        {proofModal && (
          <form onSubmit={submitProof} className="space-y-3">
            <div className="bg-gray-50 p-3 rounded text-sm">
              <div className="font-medium">{proofModal.site_name || '—'}</div>
              {proofModal.location && <div className="text-xs text-gray-500">{proofModal.location}</div>}
              <div className="text-xs text-gray-700 mt-1">{proofModal.description}</div>
            </div>
            <div>
              <label className="label">Proof Photo *</label>
              {proofForm.proof_url ? (
                <div className="flex items-start gap-3">
                  <img src={proofForm.proof_url} alt="" width="128" height="128" decoding="async" className="w-32 h-32 object-cover rounded border" />
                  <button type="button" onClick={() => setProofForm(f => ({ ...f, proof_url: '' }))} className="text-red-500 text-xs">Remove</button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => {
                      const url = await upload(e.target.files?.[0]); if (url) setProofForm(f => ({ ...f, proof_url: url }));
                      e.target.value = '';
                    }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={async e => {
                      const url = await upload(e.target.files?.[0]); if (url) setProofForm(f => ({ ...f, proof_url: url }));
                      e.target.value = '';
                    }} />
                  </label>
                </div>
              )}
            </div>
            <div>
              <label className="label">Notes <span className="text-gray-400 font-normal text-[10px]">(optional)</span></label>
              <textarea className="input" rows="2" value={proofForm.proof_notes || ''} onChange={e => setProofForm(f => ({ ...f, proof_notes: e.target.value }))} placeholder="What was done?" />
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => { setProofModal(null); setProofForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={uploading || !proofForm.proof_url} className="btn btn-primary">{uploading ? 'Uploading…' : 'Submit Proof'}</button>
            </div>
          </form>
        )}
      </Modal>
    </div>
  );
}
