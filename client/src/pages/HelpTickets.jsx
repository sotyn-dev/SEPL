// Dedicated Help Tickets page — full-screen version of the floating
// HelpTicket panel. Adds tabs (Assigned to me / Assigned by me / All)
// per mam's spec, plus the same close-by-raiser permission applied
// on the server.

import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiHelpCircle, FiPlus, FiCheckCircle, FiClock, FiAlertTriangle, FiEdit2, FiTrash2, FiSearch, FiUser, FiTag, FiDownload, FiUpload, FiExternalLink, FiRotateCcw } from 'react-icons/fi';
import StatusMultiSelect from '../components/StatusMultiSelect';
import { exportCsv } from '../utils/exportCsv';
import { fmtDate } from '../utils/datetime';
import { compressImage } from '../utils/compressImage';
import Pagination, { usePagination } from '../components/PaginationBar';

const STATUS_COLORS = {
  open: 'bg-red-100 text-red-700',
  in_progress: 'bg-amber-100 text-amber-700',
  submitted: 'bg-blue-100 text-blue-700',
  resolved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
  closed: 'bg-gray-100 text-gray-500',
};
const PRIORITY_COLORS = {
  low: 'text-gray-500 bg-gray-50',
  medium: 'text-blue-700 bg-blue-50',
  high: 'text-amber-700 bg-amber-50',
  urgent: 'text-red-700 bg-red-50 font-bold',
};
// Files a browser can render inline (open in a new tab); everything else
// (Excel, Word, CSV, …) downloads on click via the `download` attribute so a
// View click never lands on a blank new browser screen.
const PREVIEWABLE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf)(\?|#|$)/i;
function FileLink({ url, label, className, iconSize = 13 }) {
  if (!url) return null;
  const preview = PREVIEWABLE.test(url);
  const Icon = preview ? FiExternalLink : FiDownload;
  if (!preview) {
    // Excel / Word / CSV etc. → download directly (never a blank new screen).
    return (
      <a href={url} download className={className}>
        <Icon size={iconSize} /> {label}
      </a>
    );
  }
  // Images / PDFs → open in exactly ONE new tab/window. We can't rely on the
  // anchor's target="_blank" alone (PWAs/webviews downgrade it to same-window),
  // so we open explicitly and always suppress the anchor's own navigation —
  // otherwise BOTH fire and two tabs open. Note: passing 'noopener' to
  // window.open makes it return null even on success, so we omit it and sever
  // `opener` manually; fall back to same-tab only if the popup is truly blocked.
  const openNewTab = (e) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return; // honour modifier / middle clicks
    e.preventDefault();
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch { /* cross-origin, ignore */ } }
    else { window.location.href = url; } // popup blocked → view in the same tab
  };
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={openNewTab} className={className}>
      <Icon size={iconSize} /> {label}
    </a>
  );
}

// Local calendar day as YYYY-MM-DD — NOT toISOString(), which is UTC and in
// IST (+5:30) would call a deadline "overdue" from 18:30 the day before.
const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

// Deadline traffic-light. Returns null when the ticket has no deadline (all
// legacy tickets), so the cell falls back to "Not Assigned".
// A finished ticket is never flagged overdue — closing it is the point.
const deadlineState = (t) => {
  const due = (t.deadline_date || '').slice(0, 10);
  if (!due) return null;
  const done = t.status === 'resolved' || t.status === 'closed';
  if (done) return { cls: 'text-gray-500', title: `Due ${due} · ticket already ${t.status}` };
  const today = todayStr();
  // Plain string compare is safe and timezone-free for YYYY-MM-DD.
  if (due < today) return { cls: 'bg-red-100 text-red-700 font-semibold', suffix: '· Overdue', title: `Was due ${due}` };
  if (due === today) return { cls: 'bg-amber-100 text-amber-700 font-semibold', suffix: '· Today', title: `Due today (${due})` };
  return { cls: 'text-gray-600', title: `Due ${due}` };
};

const CATEGORIES = ['bug', 'feature_request', 'how_to', 'access_issue', 'data_issue', 'manpower', 'material', 'payment', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export default function HelpTickets() {
  const { user, isAdmin, canSeeAll } = useAuth();
  // Mam: 'help tickets also permission one PC we need to followup all
  // help tickets'. Anyone with help_tickets.see_all (or admin) can see
  // every ticket and triage them.
  const canFollowAll = isAdmin() || canSeeAll('help_tickets');
  const [scope, setScope] = useState('mine');     // mine | given | all
  const [statusFilter, setStatusFilter] = useState([]);
  const [search, setSearch] = useState('');
  const [nameFilter, setNameFilter] = useState('');   // raiser / assignee name
  const [tickets, setTickets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [createModal, setCreateModal] = useState(false);
  const [viewModal, setViewModal] = useState(null);
  const [form, setForm] = useState({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '' });
  const [response, setResponse] = useState('');
  const [reassign, setReassign] = useState('');
  const [deadlineEdit, setDeadlineEdit] = useState('');   // deadline draft in the view modal
  // Delegation-style proof upload state for the currently-open ticket.
  const [proof, setProof] = useState({ url: '', notes: '', uploading: false, pct: 0 });
  // Inline reject-reason capture (replaces the native prompt()).
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const openView = (t) => {
    // Start the "Add / Update Response" box EMPTY — the saved response is shown
    // read-only in "Latest Response", so pre-filling it just duplicated the text.
    setViewModal(t); setResponse(''); setReassign(t.assigned_to || '');
    setDeadlineEdit((t.deadline_date || '').slice(0, 10));
    setProof({ url: '', notes: '', uploading: false, pct: 0 });
    setRejecting(false); setRejectReason('');
  };

  // Summary cards. Counts come from the server (one GROUP BY over the whole
  // table) rather than from `tickets`, which is only the current scope/filter
  // slice — otherwise the cards would change every time a tab or status filter
  // was clicked.
  const [stats, setStats] = useState(null);
  const loadStats = () => {
    api.get('/support/stats').then(r => setStats(r.data)).catch(() => setStats(null));
  };

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter.length) params.set('status', statusFilter.join(','));
    api.get('/support?' + params.toString()).then(r => setTickets(r.data || [])).catch(() => setTickets([]));
    // Every create / status change / delete already calls load(), so hanging
    // the stats refresh here keeps the cards in step with no extra wiring.
    loadStats();
  };
  useEffect(() => { load(); /* eslint-disable-next-line */ }, [scope, statusFilter]);
  useEffect(() => {
    api.get('/auth/users').then(r => setEmployees((r.data || []).filter(u => u.active !== 0))).catch(() => setEmployees([]));
  }, []);

  // Counts for the tab badges
  const [counts, setCounts] = useState({ mine: 0, given: 0, all: 0 });
  useEffect(() => {
    Promise.all([
      api.get('/support?scope=mine').then(r => r.data?.length || 0).catch(() => 0),
      api.get('/support?scope=given').then(r => r.data?.length || 0).catch(() => 0),
      canFollowAll ? api.get('/support?scope=all').then(r => r.data?.length || 0).catch(() => 0) : Promise.resolve(0),
    ]).then(([m, g, a]) => setCounts({ mine: m, given: g, all: a }));
  }, [tickets.length, canFollowAll]);

  const submit = async (e) => {
    e.preventDefault();
    // Upload optional attachment first (screenshot, log, PDF) and stash
    // its URL on attachment_link so admin / assignee can see the proof.
    let payload = { ...form };
    delete payload._file;
    if (form._file) {
      try {
        const fd = new FormData();
        fd.append('file', form._file);
        // ?folder=help-tickets → own uploads subfolder so the orphan sweep can target it.
        const up = await api.post('/upload?folder=help-tickets', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        payload.attachment_link = up.data?.url || null;
      } catch (err) {
        toast.error(`Attachment upload failed: ${err.response?.data?.error || err.message} — submitting without file`, { duration: 5000 });
      }
    }
    try {
      const r = await api.post('/support', payload);
      toast.success(`Ticket ${r.data.ticket_no} created`);
      setCreateModal(false);
      setForm({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '', _file: null });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const update = async (id, payload) => {
    try {
      await api.put(`/support/${id}`, payload);
      toast.success('Updated');
      setViewModal(null); setResponse(''); setReassign('');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete ticket ${t.ticket_no}?`)) return;
    try { await api.delete(`/support/${t.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // ── Proof of fix (Delegation-style) ──────────────────────────────────
  // Upload the file first (compress images, PDFs/Excel as-is) → get a URL →
  // submit it so the ticket moves to 'submitted' awaiting the raiser.
  const uploadProof = async (file) => {
    if (!file) return;
    setProof(p => ({ ...p, uploading: true, pct: 0 }));
    try {
      const toSend = file.type?.startsWith('image/') ? await compressImage(file) : file;
      const fd = new FormData();
      fd.append('file', toSend);
      const res = await api.post('/upload?folder=help-tickets', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (ev) => { if (ev.total) setProof(p => ({ ...p, pct: Math.round((ev.loaded / ev.total) * 100) })); },
      });
      setProof(p => ({ ...p, url: res.data?.url || '', uploading: false, pct: 100 }));
      toast.success('Proof uploaded — add a note (optional) and submit');
    } catch (err) {
      setProof(p => ({ ...p, uploading: false, pct: 0 }));
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
    }
  };
  const submitProof = async () => {
    if (!proof.url) return toast.error('Please upload a proof file first');
    try {
      await api.post(`/support/${viewModal.id}/submit-proof`, { proof_url: proof.url, proof_notes: proof.notes });
      toast.success('Proof submitted — awaiting approval');
      setViewModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approveProof = async () => {
    try {
      await api.post(`/support/${viewModal.id}/approve`);
      toast.success('Proof approved — ticket resolved');
      setViewModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const rejectProof = async () => {
    if (!rejectReason.trim()) return toast.error('A reason is required to reject');
    try {
      await api.post(`/support/${viewModal.id}/reject`, { reason: rejectReason });
      toast.success('Proof rejected — assignee notified');
      setViewModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Filters compose: name AND free-text, both on top of the scope tab +
  // status dropdown already applied server-side. Partial, case-insensitive
  // match on either side of the ticket ("dur" matches "Durgesh").
  const filtered = tickets.filter(t => {
    if (nameFilter) {
      const n = nameFilter.toLowerCase();
      const matchesName = (t.user_name || '').toLowerCase().includes(n)
        || (t.assigned_to_name || '').toLowerCase().includes(n);
      if (!matchesName) return false;
    }
    if (!search) return true;
    const q = search.toLowerCase();
    return (t.ticket_no || '').toLowerCase().includes(q)
      || (t.subject || '').toLowerCase().includes(q)
      || (t.description || '').toLowerCase().includes(q)
      || (t.user_name || '').toLowerCase().includes(q)
      || (t.assigned_to_name || '').toLowerCase().includes(q);
  });

  // Numbered pagination over the final filtered list (scope + status are
  // server-side; name + search compose above). Export keeps `filtered`.
  const pager = usePagination(filtered, { resetKey: [scope, statusFilter, nameFilter, search] });

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2"><FiHelpCircle className="text-red-600" /> Help Tickets</h3>
          <p className="text-sm text-gray-500">Raise a ticket, follow up on what you've raised, or work on what's been assigned to you.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button onClick={() => exportCsv('help-tickets',
            ['Ticket #','Subject','Raised By','Assigned To','Priority','Status','Deadline','When'],
            filtered.map(t => [t.ticket_no, t.subject, t.user_name, t.assigned_to_name, t.priority, t.status, t.deadline_date || '', t.created_at]))}
            className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={14} /> Export Excel</button>
          <button onClick={() => setCreateModal(true)} className="btn btn-primary flex items-center gap-2"><FiPlus size={14} /> Raise New Ticket</button>
        </div>
      </div>

      {/* Summary cards — same `card p-3 border-l-4` treatment the Snags and
          Inventory pages use, so the three modules read alike. Counts are
          whole-table totals, independent of the tab / status filter below. */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {[
            { key: 'open', label: 'Open Tickets', sub: 'Total Open Tickets', value: stats.open, bar: 'border-emerald-500', text: 'text-emerald-600' },
            { key: 'processing', label: 'In Processing', sub: 'Being worked on / awaiting approval', value: stats.processing, bar: 'border-amber-500', text: 'text-amber-600' },
            { key: 'closed', label: 'Closed Tickets', sub: 'Resolved & closed', value: stats.closed, bar: 'border-gray-400', text: 'text-gray-600' },
          ].map(c => (
            <div key={c.key} className={`card p-3 border-l-4 ${c.bar}`}>
              <p className="text-xs text-gray-500">{c.label}</p>
              <p className={`text-2xl font-bold ${c.text}`}>{c.value}</p>
              <p className="text-[10px] text-gray-400">{c.sub}</p>
            </div>
          ))}
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none sm:flex-wrap">
        {[
          { id: 'mine',  label: 'Assigned to me',  count: counts.mine },
          { id: 'given', label: 'Raised by me',    count: counts.given },
          ...(canFollowAll ? [{ id: 'all', label: isAdmin() ? 'All tickets (admin)' : 'All tickets (follow-up)', count: counts.all }] : []),
        ].map(t => (
          <button key={t.id} onClick={() => setScope(t.id)}
            className={`px-4 py-2 rounded-lg text-sm font-medium border ${scope === t.id ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}>
            {t.label} <span className={`ml-1 text-[10px] px-1.5 py-0.5 rounded ${scope === t.id ? 'bg-white/20' : 'bg-gray-100 text-gray-500'}`}>{t.count}</span>
          </button>
        ))}
{/* Status - tick as many as you like (mam 2026-09-12). */}
        <div className="w-[264px]">
          <StatusMultiSelect
            options={[
              { id: 'open', name: 'Open' },
              { id: 'in_progress', name: 'In Progress' },
              { id: 'submitted', name: 'Submitted (awaiting approval)' },
              { id: 'resolved', name: 'Resolved' },
              { id: 'rejected', name: 'Rejected' },
              { id: 'closed', name: 'Closed' },
            ]}
            value={statusFilter}
            onChange={setStatusFilter}
            placeholder="All statuses"
          />
        </div>
        {/* Dedicated NAME filter — narrows by the raiser's or assignee's name
            only, so you can isolate one person's tickets without the free-text
            box also matching a subject or description. Composes with the scope
            tabs, status dropdown and search; filtering is instant, matching the
            existing search behaviour. */}
        <div className="relative min-w-[180px]">
          <FiUser className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9" placeholder="Filter by name…" value={nameFilter} onChange={e => setNameFilter(e.target.value)} />
        </div>
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9" placeholder="Search ticket no / subject / person…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
      </div>

      {/* Tickets list — bounded scroll + sticky thead.  Mam, 2026-05-13. */}
      <div className="card p-0 table-responsive max-h-[70vh] overflow-auto">
        <table className="text-sm w-full min-w-[900px]">
          <thead className="sticky top-0 z-10 bg-gray-50">
            <tr>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Ticket</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Subject</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Raised By</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Assigned To</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Priority</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Status</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 min-w-24">Proof</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Deadline</th>
              <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400 text-sm">No tickets {scope === 'mine' ? 'assigned to you' : scope === 'given' ? 'raised by you' : ''} yet.</td></tr>}
            {pager.pageItems.map(t => {
              const isRaiser = t.user_id === user?.id;
              const isAssignee = t.assigned_to === user?.id;
              const canClose = canFollowAll || isRaiser;
              return (
                <tr key={t.id} className="border-t hover:bg-gray-50 cursor-pointer" onClick={() => openView(t)}>
                  <td className="px-3 py-2 font-mono text-xs text-red-700 font-semibold">{t.ticket_no}</td>
                  <td className="px-3 py-2 text-gray-800 max-w-[260px] truncate" title={t.subject}>{t.subject}</td>
                  <td className="px-3 py-2 text-gray-600">{t.user_name}{isRaiser && <span className="text-[10px] text-red-600 ml-1">(you)</span>}</td>
                  <td className="px-3 py-2 text-gray-600">{t.assigned_to_name || <span className="text-gray-300">—</span>}{isAssignee && <span className="text-[10px] text-red-600 ml-1">(you)</span>}</td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-[10px] uppercase ${PRIORITY_COLORS[t.priority] || ''}`}>{t.priority}</span></td>
                  <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded text-[10px] uppercase ${STATUS_COLORS[t.status] || ''}`}>{t.status?.replace('_', ' ')}</span></td>
                  {/* Proof / uploads — mirrors the Delegations "Upload Proof" column:
                      View link (image/PDF open in a new tab, xlsx/doc download) +
                      an Upload/Re-upload affordance for the assignee. */}
                  <td className="px-3 py-2" onClick={e => e.stopPropagation()}>
                    <div className="flex flex-col gap-1 items-start">
                      {t.proof_url && (
                        <FileLink url={t.proof_url} label="View" iconSize={11} className="text-red-600 text-xs hover:underline inline-flex items-center gap-1" />
                      )}
                      {(isAssignee || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(t.status) && (
                        <button onClick={() => openView(t)} className="text-[11px] text-blue-600 font-semibold hover:underline inline-flex items-center gap-1"><FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload'}</button>
                      )}
                      {!t.proof_url && !((isAssignee || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(t.status)) && (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </div>
                  </td>
                  {/* Deadline + due state. Same fmtDate() the When column uses,
                      so the two read alike. */}
                  <td className="px-3 py-2 text-[11px] whitespace-nowrap">
                    {(() => {
                      const due = deadlineState(t);
                      if (!due) return <span className="text-gray-400">Not Assigned</span>;
                      return (
                        <span className={`px-1.5 py-0.5 rounded ${due.cls}`} title={due.title}>
                          {fmtDate(t.deadline_date, { day: '2-digit', month: 'short' })}
                          {due.suffix && <span className="ml-1 font-bold">{due.suffix}</span>}
                        </span>
                      );
                    })()}
                  </td>
                  <td className="px-3 py-2 text-[11px] text-gray-500 whitespace-nowrap">{fmtDate(t.created_at, { day: '2-digit', month: 'short' })}</td>
                  <td className="px-3 py-2 text-right" onClick={e => e.stopPropagation()}>
                    {/* Quick close button only for the raiser / admin */}
                    {canClose && t.status !== 'resolved' && t.status !== 'closed' && (
                      <button onClick={() => update(t.id, { status: 'resolved' })} className="text-[10px] text-emerald-700 font-bold hover:underline mr-2" title="Mark resolved">Close</button>
                    )}
                    {(canFollowAll || isRaiser) && (
                      <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <Pagination {...pager} />

      {/* Create Ticket Modal */}
      <Modal isOpen={createModal} onClose={() => setCreateModal(false)} title="Raise New Ticket">
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="label">Subject *</label>
            <input className="input" required value={form.subject} onChange={e => setForm({ ...form, subject: e.target.value })} placeholder="Short title — e.g. Cannot upload PO file" />
          </div>
          <div>
            <label className="label">Description *</label>
            <textarea className="input" rows="4" required value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="What happened, what you expected, what module you were on" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Category</label>
              <select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Priority</label>
              <select className="select" value={form.priority} onChange={e => setForm({ ...form, priority: e.target.value })}>
                {PRIORITIES.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </div>
            <div className="sm:col-span-2">
              <label className="label">Deadline <span className="text-gray-400 font-normal text-[10px]">(optional · target date)</span></label>
              <input type="date" className="input" value={form.deadline_date}
                onChange={e => setForm({ ...form, deadline_date: e.target.value })} />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Module (optional)</label>
              <input className="input" value={form.module} onChange={e => setForm({ ...form, module: e.target.value })} placeholder="e.g. Procurement, Delegations, Inventory" />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Assign To (optional)</label>
              <SearchableSelect
                options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="Pick someone or leave blank for admin to triage"
                onChange={(emp) => setForm(f => ({ ...f, assigned_to: emp?.id || '' }))}
              />
            </div>
            <div className="sm:col-span-2">
              <label className="label">Attachment <span className="text-gray-400 font-normal text-[10px]">(optional · screenshot, log, PDF)</span></label>
              <input
                className="input"
                type="file"
                accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.log,.xlsx,.xls,.csv,.doc,.docx"
                onChange={e => setForm(f => ({ ...f, _file: e.target.files?.[0] || null }))}
              />
              {form._file && (
                <p className="text-[10px] text-blue-600 mt-1">Selected: {form._file.name} ({(form._file.size / 1024).toFixed(1)} KB)</p>
              )}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setCreateModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Raise Ticket</button>
          </div>
        </form>
      </Modal>

      {/* View / Update Ticket Modal */}
      <Modal isOpen={!!viewModal} onClose={() => setViewModal(null)} title={viewModal ? `${viewModal.ticket_no} — ${viewModal.subject}` : 'Ticket'} wide>
        {viewModal && (() => {
          const isRaiser = viewModal.user_id === user?.id;
          const isAssignee = viewModal.assigned_to === user?.id;
          const canClose = canFollowAll || isRaiser;
          const canRespond = canFollowAll || isAssignee || isRaiser;
          // State-aware action model — one consistent footer, one primary per
          // state, no competing/duplicate resolve buttons.
          const st = viewModal.status;
          const canReview = isRaiser || canFollowAll;          // approve/reject a submitted proof
          const isSubmitted = st === 'submitted';
          const isClosedState = st === 'resolved' || st === 'closed';
          const isWorking = !isSubmitted && !isClosedState;    // open / in_progress / rejected
          return (
            <div className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                <div><span className="text-gray-400 text-xs">Raised by:</span> <b>{viewModal.user_name}</b></div>
                <div><span className="text-gray-400 text-xs">Assigned to:</span> <b>{viewModal.assigned_to_name || '—'}</b></div>
                <div><span className="text-gray-400 text-xs">Category:</span> {viewModal.category?.replace('_', ' ')}</div>
                <div><span className="text-gray-400 text-xs">Priority:</span> <span className={`px-1.5 py-0.5 rounded text-[10px] ${PRIORITY_COLORS[viewModal.priority] || ''}`}>{viewModal.priority}</span></div>
                <div><span className="text-gray-400 text-xs">Status:</span> <span className={`px-1.5 py-0.5 rounded text-[10px] ${STATUS_COLORS[viewModal.status] || ''}`}>{viewModal.status?.replace('_', ' ')}</span></div>
                <div><span className="text-gray-400 text-xs">Module:</span> {viewModal.module || '—'}</div>
              </div>
              <div>
                <label className="label">Description</label>
                <div className="bg-gray-50 border rounded p-3 text-sm whitespace-pre-wrap">{viewModal.description}</div>
              </div>
              {viewModal.attachment_link && (
                <div>
                  <FileLink url={viewModal.attachment_link} label="View attachment" className="inline-flex items-center gap-1 text-blue-600 hover:underline text-sm font-semibold" />
                </div>
              )}
              {/* Submitted proof of fix */}
              {viewModal.proof_url && (
                <div>
                  <label className="label">Proof of fix{viewModal.proof_submitted_by_name ? ` — by ${viewModal.proof_submitted_by_name}` : ''}</label>
                  <FileLink url={viewModal.proof_url} label="View submitted proof" className="inline-flex items-center gap-1 text-emerald-700 hover:underline text-sm font-semibold" />
                  {viewModal.proof_notes && <p className="text-xs text-gray-600 mt-1 whitespace-pre-wrap">{viewModal.proof_notes}</p>}
                </div>
              )}
              {viewModal.status === 'rejected' && viewModal.reject_reason && (
                <div className="bg-red-50 border-l-4 border-red-500 rounded p-3">
                  <p className="text-xs font-bold text-red-700 mb-1">Proof rejected — please re-upload</p>
                  <p className="text-sm text-red-900 whitespace-pre-wrap">{viewModal.reject_reason}</p>
                </div>
              )}
              {/* Assignee uploads proof of the fix → ticket goes to the raiser */}
              {(isAssignee || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(viewModal.status) && (
                <div className="border-t pt-3 space-y-2">
                  <label className="label">Upload proof of fix <span className="text-gray-400 font-normal text-[10px]">(photo / PDF / Excel — sent to the raiser for approval)</span></label>
                  <div className="flex flex-wrap gap-2">
                    <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                      <FiUpload size={12} /> Camera
                      <input type="file" accept="image/*" capture="environment" className="hidden" disabled={proof.uploading}
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(f); }} />
                    </label>
                    <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                      <FiUpload size={12} /> File
                      <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="hidden" disabled={proof.uploading}
                        onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(f); }} />
                    </label>
                    {proof.uploading && <span className="text-xs text-gray-500 self-center">Uploading… {proof.pct}%</span>}
                    {proof.url && !proof.uploading && <span className="text-xs text-emerald-600 self-center">✓ File ready</span>}
                  </div>
                  <textarea className="input" rows="2" value={proof.notes} onChange={e => setProof(p => ({ ...p, notes: e.target.value }))} placeholder="Optional note about the fix…" />
                  <button onClick={submitProof} disabled={!proof.url || proof.uploading} className="btn btn-primary text-xs disabled:opacity-50">Submit Proof for Approval</button>
                </div>
              )}
              {/* Proof review actions now live in the single footer action bar
                  below — the body only shows proof info + review status. */}
              {isSubmitted && canReview && (
                <p className="text-[11px] text-blue-700 font-medium">Proof submitted — review it below (Approve &amp; Resolve or Reject).</p>
              )}
              {isSubmitted && !canReview && (
                <p className="text-[11px] text-gray-500 italic">Proof submitted — awaiting the raiser's approval.</p>
              )}
              {viewModal.admin_response && (
                <div>
                  <label className="label">Latest Response</label>
                  <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm whitespace-pre-wrap text-blue-900">{viewModal.admin_response}</div>
                </div>
              )}
              {canRespond && (
                <div>
                  <label className="label">Add / Update Response</label>
                  <textarea className="input" rows="3" value={response} onChange={e => setResponse(e.target.value)} placeholder="What's the status, plan, or fix..." />
                  {/* The Save button belongs with the field it acts on (proximity),
                      not in the workflow footer. Left-aligned + styled to match
                      "Submit Proof for Approval" for visible consistency; disabled
                      when empty. */}
                  <div className="mt-2">
                    <button onClick={() => update(viewModal.id, { admin_response: response })} disabled={!response.trim()} className="btn btn-primary text-xs disabled:opacity-50">Save Response</button>
                  </div>
                </div>
              )}
              {canFollowAll && (
                <div>
                  <label className="label">Reassign To</label>
                  <div className="flex gap-2 items-start">
                    <div className="flex-1">
                      <SearchableSelect
                        options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                        value={reassign || null}
                        valueKey="id" displayKey="label"
                        placeholder="Pick assignee"
                        onChange={(emp) => setReassign(emp?.id || '')}
                      />
                    </div>
                    <button onClick={() => update(viewModal.id, { assigned_to: reassign || null })} disabled={String(reassign || '') === String(viewModal.assigned_to || '')} className="btn btn-secondary text-xs whitespace-nowrap disabled:opacity-50">Save Assignee</button>
                  </div>
                </div>
              )}
              {/* Deadline editor — same "field + Save" shape as Reassign above.
                  Open to the raiser, assignee and follow-up roles; the server
                  applies the same permission rules as any other PUT field. */}
              {(canFollowAll || isAssignee || viewModal.user_id === user?.id) && (
                <div>
                  <label className="label">Deadline</label>
                  <div className="flex gap-2 items-start">
                    <input type="date" className="input flex-1" value={deadlineEdit}
                      onChange={e => setDeadlineEdit(e.target.value)} />
                    <button
                      onClick={() => update(viewModal.id, { deadline_date: deadlineEdit || null })}
                      disabled={(deadlineEdit || '') === (viewModal.deadline_date || '').slice(0, 10)}
                      className="btn btn-secondary text-xs whitespace-nowrap disabled:opacity-50">Save Deadline</button>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-0.5">Clear the field and save to remove the deadline.</p>
                </div>
              )}
              {/* Inline reject reason — replaces the native prompt() so the
                  reason is captured in-context with validation. */}
              {isSubmitted && canReview && rejecting && (
                <div className="border-t pt-3 space-y-2">
                  <label className="label">Reason for rejection <span className="text-gray-400 font-normal text-[10px]">(the assignee will see this)</span></label>
                  <textarea className="input" rows="2" autoFocus value={rejectReason} onChange={e => setRejectReason(e.target.value)} placeholder="e.g. Screenshot is blurry — please re-capture the fix" />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setRejecting(false); setRejectReason(''); }} className="btn btn-secondary text-xs">Cancel</button>
                    <button onClick={rejectProof} disabled={!rejectReason.trim()} className="btn btn-danger text-xs disabled:opacity-50">Confirm reject</button>
                  </div>
                </div>
              )}
              {/* Single action bar — one primary per state, no duplicate/competing
                  resolves. Green is reserved for the one positive terminal action. */}
              <div className="flex flex-wrap justify-end items-center gap-2 pt-2 border-t">
                <button onClick={() => setViewModal(null)} className="btn btn-secondary">Close</button>
                {/* Working states (open / in_progress / rejected) — direct transitions.
                    Note & assignee have their own Save buttons above; a typed-but-
                    unsaved note still rides along so it isn't lost. */}
                {isWorking && canRespond && st !== 'in_progress' && (
                  <button onClick={() => update(viewModal.id, { status: 'in_progress', admin_response: response || viewModal.admin_response })} className="btn btn-secondary text-amber-700">Mark In Progress</button>
                )}
                {isWorking && canClose && (
                  <button onClick={() => update(viewModal.id, { status: 'resolved', admin_response: response || viewModal.admin_response })} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={12} /> Mark Resolved</button>
                )}
                {/* Submitted — proof review is the ONLY resolve path */}
                {isSubmitted && canReview && !rejecting && (
                  <>
                    <button onClick={() => { setRejecting(true); setRejectReason(''); }} className="btn btn-danger">Reject…</button>
                    <button onClick={approveProof} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={12} /> Approve &amp; Resolve</button>
                  </>
                )}
                {/* Resolved / closed — reopen so it's never a dead end */}
                {isClosedState && canClose && (
                  <button onClick={() => update(viewModal.id, { status: 'in_progress', admin_response: response || viewModal.admin_response })} className="btn btn-secondary text-amber-700 flex items-center gap-1"><FiRotateCcw size={12} /> Reopen</button>
                )}
                {!canClose && isWorking && (
                  <span className="text-[11px] text-gray-500 italic self-center">Only the person who raised this ticket can close it.</span>
                )}
              </div>
            </div>
          );
        })()}
      </Modal>
    </div>
  );
}
