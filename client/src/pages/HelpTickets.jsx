import NumberedTable from '../components/NumberedTable';
import { useState, useEffect, useMemo, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiHelpCircle, FiPlus, FiCheckCircle, FiClock, FiAlertTriangle,
  FiEdit2, FiTrash2, FiSearch, FiUser, FiTag, FiDownload, FiUpload,
  FiExternalLink, FiRotateCcw, FiList, FiColumns, FiPaperclip,
  FiX, FiFile, FiCheck, FiArrowRight, FiEye, FiCamera, FiFilter, FiCheckSquare
} from 'react-icons/fi';
import StatusMultiSelect from '../components/StatusMultiSelect';
import { exportCsv } from '../utils/exportCsv';
import { fmtDate } from '../utils/datetime';
import { compressImage } from '../utils/compressImage';
import Pagination, { usePagination } from '../components/PaginationBar';

const STATUS_COLORS = {
  open: 'bg-red-50 text-red-700 border border-red-200',
  in_progress: 'bg-amber-50 text-amber-700 border border-amber-200',
  submitted: 'bg-blue-50 text-blue-700 border border-blue-200 font-semibold',
  resolved: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border border-rose-200',
  closed: 'bg-gray-100 text-gray-500 border border-gray-200',
};

const PRIORITY_COLORS = {
  low: 'text-gray-500 bg-gray-50 border border-gray-200',
  medium: 'text-blue-700 bg-blue-50 border border-blue-200',
  high: 'text-amber-700 bg-amber-50 border border-amber-200 font-medium',
  urgent: 'text-red-700 bg-red-50 border border-red-300 font-bold',
};

const KANBAN_COLUMNS = [
  { id: 'open', label: 'To Do / Open', color: 'border-t-red-500', bg: 'bg-red-50/20', badge: 'bg-red-100 text-red-700' },
  { id: 'in_progress', label: 'In Progress', color: 'border-t-amber-500', bg: 'bg-amber-50/20', badge: 'bg-amber-100 text-amber-800' },
  { id: 'submitted', label: 'Under Review', color: 'border-t-blue-500', bg: 'bg-blue-50/20', badge: 'bg-blue-100 text-blue-700' },
  { id: 'done', label: 'Resolved & Closed', color: 'border-t-emerald-500', bg: 'bg-emerald-50/20', badge: 'bg-emerald-100 text-emerald-800' },
];

export function parseFileUrls(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string') {
    val = val.trim();
    if (val.startsWith('[') && val.endsWith(']')) {
      try {
        const arr = JSON.parse(val);
        if (Array.isArray(arr)) return arr.filter(Boolean);
      } catch (_) {}
    }
    return [val];
  }
  return [];
}

const getFileName = (url) => {
  if (!url) return '';
  const part = url.split('/').pop() || '';
  return part.replace(/^\d+-[a-z0-9]+-/, '').replace(/^\d+-/, '') || 'file';
};

const isImageFile = (url) => /\.(png|jpe?g|gif|webp|bmp|svg)(\?|#|$)/i.test(url);

const PREVIEWABLE = /\.(png|jpe?g|gif|webp|bmp|svg|pdf)(\?|#|$)/i;
function FileLink({ url, label, className, iconSize = 13 }) {
  if (!url) return null;
  const preview = PREVIEWABLE.test(url);
  const Icon = preview ? FiExternalLink : FiDownload;
  if (!preview) {
    return (
      <a href={url} download className={className} onClick={e => e.stopPropagation()}>
        <Icon size={iconSize} /> {label}
      </a>
    );
  }
  const openNewTab = (e) => {
    e.stopPropagation();
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button === 1) return;
    e.preventDefault();
    const w = window.open(url, '_blank');
    if (w) { try { w.opener = null; } catch (_) {} }
    else { window.location.href = url; }
  };
  return (
    <a href={url} target="_blank" rel="noopener noreferrer" onClick={openNewTab} className={className}>
      <Icon size={iconSize} /> {label}
    </a>
  );
}

function FileGallery({ urls, title, canRemove = false, onRemove, emptyText = '' }) {
  const list = parseFileUrls(urls);
  if (!list.length) {
    if (!emptyText) return null;
    return <span className="text-gray-400 text-xs italic">{emptyText}</span>;
  }
  return (
    <div className="space-y-1.5">
      {title && (
        <div className="text-[11px] font-semibold text-gray-500 uppercase tracking-wide flex items-center gap-1">
          <FiPaperclip size={12} /> {title} ({list.length})
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        {list.map((u, i) => {
          const isImg = isImageFile(u);
          const fname = getFileName(u);
          return (
            <div
              key={i}
              className="group relative flex items-center gap-2 p-1.5 bg-gray-50 hover:bg-gray-100 border border-gray-200 rounded-lg text-xs transition-all shadow-sm"
            >
              {isImg ? (
                <a
                  href={u}
                  target="_blank"
                  rel="noreferrer"
                  onClick={e => e.stopPropagation()}
                  className="block overflow-hidden rounded border border-gray-300 w-10 h-10 flex-shrink-0 bg-white"
                  title="Click to view full image"
                >
                  <img src={u} alt={fname} className="w-full h-full object-cover group-hover:scale-105 transition-transform" />
                </a>
              ) : (
                <div className="w-10 h-10 rounded bg-blue-50 border border-blue-200 flex items-center justify-center text-blue-600 flex-shrink-0 font-bold text-[10px]">
                  DOC
                </div>
              )}
              <div className="flex flex-col min-w-0 pr-1">
                <FileLink
                  url={u}
                  label={fname}
                  iconSize={11}
                  className="font-medium text-gray-800 hover:text-red-600 truncate max-w-[130px] text-xs hover:underline"
                />
                <span className="text-[10px] text-gray-400">{isImg ? 'Image' : 'Document'}</span>
              </div>
              {canRemove && onRemove && (
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); onRemove(i); }}
                  className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                  title="Remove file"
                >
                  <FiX size={13} />
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

const todayStr = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const deadlineState = (t) => {
  const due = (t.deadline_date || '').slice(0, 10);
  if (!due) return null;
  const done = t.status === 'resolved' || t.status === 'closed';
  if (done) return { cls: 'text-gray-400 bg-gray-50 border border-gray-200', title: `Due ${due} · ticket already ${t.status}` };
  const today = todayStr();
  if (due < today) return { cls: 'bg-red-50 text-red-700 border border-red-200 font-semibold', suffix: '· Overdue', title: `Was due ${due}` };
  if (due === today) return { cls: 'bg-amber-50 text-amber-800 border border-amber-200 font-semibold', suffix: '· Today', title: `Due today (${due})` };
  return { cls: 'text-gray-600 bg-gray-50 border border-gray-200', title: `Due ${due}` };
};

const CATEGORIES = ['bug', 'feature_request', 'how_to', 'access_issue', 'data_issue', 'manpower', 'material', 'payment', 'other'];
const PRIORITIES = ['low', 'medium', 'high', 'urgent'];

export default function HelpTickets() {
  const { user, isAdmin, canSeeAll, canApprove } = useAuth();
  const canFollowAll = isAdmin() || canSeeAll('help_tickets') || canApprove('help_tickets');

  // View mode: 'list' or 'board'
  const [viewMode, setViewMode] = useState(() => localStorage.getItem('help_tickets_view_mode') || 'list');

  // Scope: 'mine' (Assigned to me) | 'given' (Raised by me) | 'all' (All tickets)
  const [scope, setScope] = useState('mine');

  // Quick interactive metric card filter: 'all' | 'attention' | 'open' | 'processing' | 'closed'
  const [quickFilter, setQuickFilter] = useState('all');

  // Workflow tab: 'active' (Default: hides closed) | 'closed' (Archive) | 'all'
  const [workflowTab, setWorkflowTab] = useState('active');

  // Priority filter
  const [priorityFilter, setPriorityFilter] = useState('');

  // Status multi-select filter
  const [statusFilter, setStatusFilter] = useState([]);

  // Single Omni-search string
  const [search, setSearch] = useState('');

  const [tickets, setTickets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [createModal, setCreateModal] = useState(false);
  const [editModal, setEditModal] = useState(null);
  const [savingTicket, setSavingTicket] = useState(false);
  const [viewModal, setViewModal] = useState(null);

  // Form for create / edit ticket
  const [form, setForm] = useState({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '' });
  const [createFiles, setCreateFiles] = useState([]);
  const [createUploading, setCreateUploading] = useState(false);

  // View modal state
  const [response, setResponse] = useState('');
  const [reassign, setReassign] = useState('');
  const [deadlineEdit, setDeadlineEdit] = useState('');
  const [proof, setProof] = useState({ urls: [], notes: '', uploading: false, pct: 0 });
  const [rejecting, setRejecting] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const closeTicketForm = () => {
    setCreateModal(false);
    setEditModal(null);
    setCreateFiles([]);
  };

  const openCreate = () => {
    setEditModal(null);
    setForm({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '' });
    setCreateFiles([]);
    setCreateModal(true);
  };

  const openEdit = (ticket) => {
    setViewModal(null);
    setCreateModal(false);
    setEditModal(ticket);
    setForm({
      subject: ticket.subject || '',
      description: ticket.description || '',
      category: ticket.category || 'bug',
      priority: ticket.priority || 'medium',
      module: ticket.module || '',
      assigned_to: ticket.assigned_to || '',
      deadline_date: (ticket.deadline_date || '').slice(0, 10),
    });
  };

  const assigneeOptions = employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }));
  if (editModal?.assigned_to && !employees.some(e => e.id === editModal.assigned_to)) {
    assigneeOptions.push({ id: editModal.assigned_to, label: `${editModal.assigned_to_name || 'Current assignee'} (inactive)` });
  }

  const openView = (t) => {
    setViewModal(t);
    setResponse('');
    setReassign(t.assigned_to || '');
    setDeadlineEdit((t.deadline_date || '').slice(0, 10));
    setProof({ urls: [], notes: '', uploading: false, pct: 0 });
    setRejecting(false);
    setRejectReason('');
  };

  // Helper to upload an array of files concurrently
  const uploadFilesToServer = async (fileList, folder = 'help-tickets') => {
    if (!fileList || !fileList.length) return [];
    const uploadedUrls = [];
    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const toSend = file.type?.startsWith('image/') ? await compressImage(file) : file;
      const fd = new FormData();
      fd.append('file', toSend);
      const res = await api.post(`/upload?folder=${folder}`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.url) {
        uploadedUrls.push(res.data.url);
      }
    }
    return uploadedUrls;
  };

  // Proof multi-file upload
  const uploadProofFiles = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setProof(p => ({ ...p, uploading: true, pct: 20 }));
    try {
      const urls = await uploadFilesToServer(fileList, 'help-tickets');
      setProof(p => ({
        ...p,
        urls: [...(p.urls || []), ...urls],
        uploading: false,
        pct: 100,
      }));
      toast.success(`${urls.length} proof file(s) attached`);
    } catch (err) {
      setProof(p => ({ ...p, uploading: false }));
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
    }
  };

  // Clipboard paste handler for Proof (view modal)
  const handleProofPaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const images = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        const blob = items[i].getAsFile();
        if (blob) {
          const file = new File([blob], `screenshot-${Date.now()}-${i + 1}.png`, { type: blob.type });
          images.push(file);
        }
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      uploadProofFiles(images);
      toast.success('Pasted screenshot captured & uploading…');
    }
  };

  // Create ticket attachments upload
  const uploadCreateFiles = async (fileList) => {
    if (!fileList || !fileList.length) return;
    setCreateUploading(true);
    try {
      const urls = await uploadFilesToServer(fileList, 'help-tickets');
      setCreateFiles(prev => [...prev, ...urls]);
      toast.success(`${urls.length} attachment(s) added`);
    } catch (err) {
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
    } finally {
      setCreateUploading(false);
    }
  };

  // Clipboard paste handler for Create ticket modal
  const handleCreatePaste = (e) => {
    const items = e.clipboardData?.items;
    if (!items || !items.length) return;
    const images = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].type && items[i].type.startsWith('image/')) {
        const blob = items[i].getAsFile();
        if (blob) {
          const file = new File([blob], `screenshot-${Date.now()}-${i + 1}.png`, { type: blob.type });
          images.push(file);
        }
      }
    }
    if (images.length > 0) {
      e.preventDefault();
      uploadCreateFiles(images);
      toast.success('Pasted screenshot captured & uploading…');
    }
  };

  const load = () => {
    const params = new URLSearchParams({ scope });
    if (statusFilter.length) params.set('status', statusFilter.join(','));
    api.get('/support?' + params.toString()).then(r => setTickets(r.data || [])).catch(() => setTickets([]));
  };

  useEffect(() => { load(); }, [scope, statusFilter]);

  useEffect(() => {
    api.get('/auth/users').then(r => setEmployees((r.data || []).filter(u => u.active !== 0))).catch(() => setEmployees([]));
    const sp = new URLSearchParams(window.location.search);
    const openId = sp.get('open');
    if (openId) {
      api.get(`/support/${openId}`).then(res => {
        if (res.data) openView(res.data);
      }).catch(() => {});
    }
  }, []);

  // Counts for the scope tab badges
  const [counts, setCounts] = useState({ mine: 0, given: 0, all: 0 });
  useEffect(() => {
    Promise.all([
      api.get('/support?scope=mine').then(r => r.data?.length || 0).catch(() => 0),
      api.get('/support?scope=given').then(r => r.data?.length || 0).catch(() => 0),
      canFollowAll ? api.get('/support?scope=all').then(r => r.data?.length || 0).catch(() => 0) : Promise.resolve(0),
    ]).then(([m, g, a]) => setCounts({ mine: m, given: g, all: a }));
  }, [tickets.length, canFollowAll]);

  // Context-aware KPI stats calculated over current active scope
  const scopeStats = useMemo(() => {
    const today = todayStr();
    let attentionCount = 0;
    let openCount = 0;
    let processingCount = 0;
    let closedCount = 0;

    tickets.forEach(t => {
      const isDone = t.status === 'resolved' || t.status === 'closed';
      const due = (t.deadline_date || '').slice(0, 10);
      if (!isDone && due && due <= today) {
        attentionCount++;
      }
      if (t.status === 'open') {
        openCount++;
      } else if (t.status === 'in_progress' || t.status === 'submitted' || t.status === 'rejected') {
        processingCount++;
      } else if (isDone) {
        closedCount++;
      }
    });

    return {
      attention: attentionCount,
      open: openCount,
      processing: processingCount,
      closed: closedCount,
      total: tickets.length,
    };
  }, [tickets]);

  // Submit new ticket or edit ticket
  const submit = async (e) => {
    e.preventDefault();
    if (savingTicket) return;
    if (editModal) {
      setSavingTicket(true);
      const payload = {
        subject: form.subject,
        description: form.description,
        category: form.category,
        priority: form.priority,
        module: form.module,
        deadline_date: form.deadline_date || null,
        ...(canFollowAll ? { assigned_to: form.assigned_to || null } : {}),
      };
      try {
        await api.patch(`/support/${editModal.id}/details`, payload);
        toast.success(`Ticket ${editModal.ticket_no} updated`);
        closeTicketForm();
        load();
      } catch (err) {
        toast.error(err.response?.data?.error || 'Failed to update ticket');
      } finally {
        setSavingTicket(false);
      }
      return;
    }

    setSavingTicket(true);
    let payload = { ...form };
    delete payload._file;
    if (createFiles.length === 1) payload.attachment_link = createFiles[0];
    else if (createFiles.length > 1) payload.attachment_link = JSON.stringify(createFiles);
    else payload.attachment_link = null;

    try {
      const r = await api.post('/support', payload);
      toast.success(`Ticket ${r.data.ticket_no} created`);
      closeTicketForm();
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create ticket');
    } finally {
      setSavingTicket(false);
    }
  };

  const update = async (id, payload) => {
    try {
      await api.put(`/support/${id}`, payload);
      toast.success('Updated');
      setViewModal(null);
      setResponse('');
      setReassign('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const del = async (t) => {
    if (!confirm(`Delete ticket ${t.ticket_no}?`)) return;
    try {
      await api.delete(`/support/${t.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  // Submit proof of fix
  const submitProof = async () => {
    const urls = proof.urls?.length ? proof.urls : (proof.url ? [proof.url] : []);
    if (!urls.length) return toast.error('Please upload or paste at least one proof file');
    try {
      const payload = {
        proof_url: urls.length === 1 ? urls[0] : JSON.stringify(urls),
        proof_notes: proof.notes,
      };
      await api.post(`/support/${viewModal.id}/submit-proof`, payload);
      toast.success('Proof submitted — awaiting approval');
      setViewModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const approveProof = async () => {
    try {
      await api.post(`/support/${viewModal.id}/approve`);
      toast.success('Proof approved — ticket resolved');
      setViewModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const rejectProof = async () => {
    if (!rejectReason.trim()) return toast.error('A reason is required to reject');
    try {
      await api.post(`/support/${viewModal.id}/reject`, { reason: rejectReason });
      toast.success('Proof rejected — assignee notified');
      setViewModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  // Final filtered list composing: quickFilter, workflowTab, priorityFilter, and search
  const filtered = useMemo(() => {
    const today = todayStr();
    return tickets.filter(t => {
      const isDone = t.status === 'resolved' || t.status === 'closed';
      const due = (t.deadline_date || '').slice(0, 10);

      // Workflow tab filter:
      if (workflowTab === 'active' && isDone) return false;
      if (workflowTab === 'closed' && !isDone) return false;

      // Quick interactive card filter:
      if (quickFilter === 'attention') {
        if (isDone || !due || due > today) return false;
      } else if (quickFilter === 'open') {
        if (t.status !== 'open') return false;
      } else if (quickFilter === 'processing') {
        if (!['in_progress', 'submitted', 'rejected'].includes(t.status)) return false;
      } else if (quickFilter === 'closed') {
        if (!isDone) return false;
      }

      // Priority filter:
      if (priorityFilter && t.priority !== priorityFilter) return false;

      // Single omni-search:
      if (search.trim()) {
        const q = search.toLowerCase();
        const matches = (t.ticket_no || '').toLowerCase().includes(q)
          || (t.subject || '').toLowerCase().includes(q)
          || (t.description || '').toLowerCase().includes(q)
          || (t.user_name || '').toLowerCase().includes(q)
          || (t.assigned_to_name || '').toLowerCase().includes(q)
          || (t.module || '').toLowerCase().includes(q)
          || (t.category || '').toLowerCase().includes(q);
        if (!matches) return false;
      }

      return true;
    });
  }, [tickets, quickFilter, workflowTab, priorityFilter, search]);

  // Group tickets into Kanban columns
  const kanbanGrouped = useMemo(() => {
    const groups = { open: [], in_progress: [], submitted: [], done: [] };
    filtered.forEach(t => {
      if (t.status === 'open') groups.open.push(t);
      else if (t.status === 'in_progress' || t.status === 'rejected') groups.in_progress.push(t);
      else if (t.status === 'submitted') groups.submitted.push(t);
      else if (t.status === 'resolved' || t.status === 'closed') groups.done.push(t);
    });
    return groups;
  }, [filtered]);

  // Pagination for List view
  const pager = usePagination(filtered, { resetKey: [scope, statusFilter, quickFilter, workflowTab, priorityFilter, search] });

  return (
    <div className="space-y-4">
      {/* Page Header & View Toggle */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiHelpCircle className="text-red-600" /> Help Tickets
          </h3>
          <p className="text-xs text-gray-500">Raise a ticket, follow up on what you've raised, or work on what's been assigned to you.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Dual View Toggle */}
          <div className="flex bg-gray-100 p-0.5 rounded-lg border border-gray-200">
            <button
              onClick={() => { setViewMode('list'); localStorage.setItem('help_tickets_view_mode', 'list'); }}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${viewMode === 'list' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              title="Spreadsheet list view"
            >
              <FiList size={13} /> List View
            </button>
            <button
              onClick={() => { setViewMode('board'); localStorage.setItem('help_tickets_view_mode', 'board'); }}
              className={`px-3 py-1.5 rounded-md text-xs font-semibold flex items-center gap-1.5 transition-all ${viewMode === 'board' ? 'bg-white shadow-sm text-gray-900' : 'text-gray-500 hover:text-gray-700'}`}
              title="Visual Kanban stage board"
            >
              <FiColumns size={13} /> Kanban Board
            </button>
          </div>

          <button
            onClick={() => exportCsv('help-tickets',
              ['Ticket #', 'Subject', 'Raised By', 'Assigned To', 'Priority', 'Status', 'Deadline', 'When'],
              filtered.map(t => [t.ticket_no, t.subject, t.user_name, t.assigned_to_name, t.priority, t.status, t.deadline_date || '', t.created_at]))}
            className="btn btn-secondary flex items-center gap-1.5 text-xs"
          >
            <FiDownload size={13} /> Export Excel
          </button>
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-1.5 text-xs">
            <FiPlus size={13} /> Raise New Ticket
          </button>
        </div>
      </div>

      {/* Interactive Context-Aware KPI Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div
          onClick={() => setQuickFilter(f => f === 'attention' ? 'all' : 'attention')}
          className={`card p-3 border-l-4 border-red-500 cursor-pointer transition-all hover:shadow-md ${quickFilter === 'attention' ? 'ring-2 ring-red-400 bg-red-50/40' : ''}`}
          title="Click to filter Overdue and Due Today tickets"
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 font-bold uppercase">🚨 Needs Attention</p>
            {quickFilter === 'attention' && <span className="text-[9px] bg-red-100 text-red-700 px-1 rounded font-bold">Filtered</span>}
          </div>
          <p className="text-2xl font-extrabold text-red-600">{scopeStats.attention}</p>
          <p className="text-[10px] text-gray-400">Overdue &amp; due today</p>
        </div>

        <div
          onClick={() => setQuickFilter(f => f === 'open' ? 'all' : 'open')}
          className={`card p-3 border-l-4 border-blue-500 cursor-pointer transition-all hover:shadow-md ${quickFilter === 'open' ? 'ring-2 ring-blue-400 bg-blue-50/40' : ''}`}
          title="Click to filter Open / To Do tickets"
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 font-bold uppercase">📌 Open / To Do</p>
            {quickFilter === 'open' && <span className="text-[9px] bg-blue-100 text-blue-700 px-1 rounded font-bold">Filtered</span>}
          </div>
          <p className="text-2xl font-extrabold text-blue-600">{scopeStats.open}</p>
          <p className="text-[10px] text-gray-400">Waiting to be started</p>
        </div>

        <div
          onClick={() => setQuickFilter(f => f === 'processing' ? 'all' : 'processing')}
          className={`card p-3 border-l-4 border-amber-500 cursor-pointer transition-all hover:shadow-md ${quickFilter === 'processing' ? 'ring-2 ring-amber-400 bg-amber-50/40' : ''}`}
          title="Click to filter In Progress & Under Review"
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 font-bold uppercase">⚡ In Progress &amp; Review</p>
            {quickFilter === 'processing' && <span className="text-[9px] bg-amber-100 text-amber-700 px-1 rounded font-bold">Filtered</span>}
          </div>
          <p className="text-2xl font-extrabold text-amber-600">{scopeStats.processing}</p>
          <p className="text-[10px] text-gray-400">Being worked or awaiting approval</p>
        </div>

        <div
          onClick={() => setQuickFilter(f => f === 'closed' ? 'all' : 'closed')}
          className={`card p-3 border-l-4 border-emerald-500 cursor-pointer transition-all hover:shadow-md ${quickFilter === 'closed' ? 'ring-2 ring-emerald-400 bg-emerald-50/40' : ''}`}
          title="Click to filter Resolved & Closed tickets"
        >
          <div className="flex items-center justify-between">
            <p className="text-[10px] text-gray-500 font-bold uppercase">✅ Resolved &amp; Closed</p>
            {quickFilter === 'closed' && <span className="text-[9px] bg-emerald-100 text-emerald-700 px-1 rounded font-bold">Filtered</span>}
          </div>
          <p className="text-2xl font-extrabold text-emerald-600">{scopeStats.closed}</p>
          <p className="text-[10px] text-gray-400">Completed archive</p>
        </div>
      </div>

      {/* Filter Bar & Scope Tabs */}
      <div className="card p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b pb-2">
          {/* Main Scope Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {[
              { id: 'mine', label: 'Assigned to me', count: counts.mine },
              { id: 'given', label: 'Raised by me', count: counts.given },
              ...(canFollowAll ? [{ id: 'all', label: isAdmin() ? 'All tickets (admin)' : 'All tickets (follow-up)', count: counts.all }] : []),
            ].map(t => (
              <button
                key={t.id}
                onClick={() => { setScope(t.id); setQuickFilter('all'); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition-all ${scope === t.id ? 'bg-red-600 text-white border-red-600 shadow-sm' : 'bg-white text-gray-700 border-gray-200 hover:bg-gray-50'}`}
              >
                {t.label} <span className={`ml-1 text-[10px] px-1.5 py-0.2 rounded-full ${scope === t.id ? 'bg-white/20 text-white' : 'bg-gray-100 text-gray-600 font-bold'}`}>{t.count}</span>
              </button>
            ))}
          </div>

          {/* Active Work vs Archive Toggle */}
          <div className="flex items-center bg-gray-100 p-0.5 rounded-lg text-xs font-medium">
            <button
              onClick={() => { setWorkflowTab('active'); setQuickFilter('all'); }}
              className={`px-2.5 py-1 rounded-md transition-all ${workflowTab === 'active' ? 'bg-white text-gray-900 font-bold shadow-xs' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Active Work
            </button>
            <button
              onClick={() => { setWorkflowTab('closed'); setQuickFilter('all'); }}
              className={`px-2.5 py-1 rounded-md transition-all ${workflowTab === 'closed' ? 'bg-white text-gray-900 font-bold shadow-xs' : 'text-gray-500 hover:text-gray-700'}`}
            >
              Archive / Done
            </button>
            <button
              onClick={() => { setWorkflowTab('all'); setQuickFilter('all'); }}
              className={`px-2.5 py-1 rounded-md transition-all ${workflowTab === 'all' ? 'bg-white text-gray-900 font-bold shadow-xs' : 'text-gray-500 hover:text-gray-700'}`}
            >
              All
            </button>
          </div>
        </div>

        {/* Search & Sub-filters */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {/* Unified Omni-Search */}
          <div className="relative flex-1 min-w-[240px]">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input
              className="input pl-9 text-xs py-1.5 w-full"
              placeholder="Search ticket #, subject, raiser, assignee, module..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                onClick={() => setSearch('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
              >
                <FiX size={13} />
              </button>
            )}
          </div>

          {/* Priority Filter */}
          <select
            className="select text-xs py-1.5 w-[130px]"
            value={priorityFilter}
            onChange={e => setPriorityFilter(e.target.value)}
          >
            <option value="">All Priorities</option>
            <option value="urgent">🔴 Urgent</option>
            <option value="high">🟠 High</option>
            <option value="medium">🔵 Medium</option>
            <option value="low">⚪ Low</option>
          </select>

          {/* Status Multi-Select */}
          <div className="w-[200px]">
            <StatusMultiSelect
              options={[
                { id: 'open', name: 'Open' },
                { id: 'in_progress', name: 'In Progress' },
                { id: 'submitted', name: 'Submitted (Review)' },
                { id: 'resolved', name: 'Resolved' },
                { id: 'rejected', name: 'Rejected' },
                { id: 'closed', name: 'Closed' },
              ]}
              value={statusFilter}
              onChange={setStatusFilter}
              placeholder="All Statuses"
            />
          </div>

          {(quickFilter !== 'all' || priorityFilter || statusFilter.length > 0 || search || workflowTab !== 'active') && (
            <button
              onClick={() => {
                setQuickFilter('all');
                setPriorityFilter('');
                setStatusFilter([]);
                setSearch('');
                setWorkflowTab('active');
              }}
              className="btn btn-secondary text-xs py-1.5 px-2 flex items-center gap-1 text-gray-600"
              title="Reset all filters"
            >
              <FiRotateCcw size={12} /> Reset
            </button>
          )}
        </div>
      </div>

      {/* Main View: Kanban Board or List View */}
      {viewMode === 'board' ? (
        /* KANBAN BOARD VIEW */
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 items-start">
          {KANBAN_COLUMNS.map(col => {
            const colTickets = kanbanGrouped[col.id] || [];
            return (
              <div key={col.id} className="bg-gray-100/70 border border-gray-200 rounded-xl flex flex-col max-h-[75vh]">
                <div className={`p-3 border-t-4 ${col.color} bg-white rounded-t-xl border-b border-gray-200 flex items-center justify-between`}>
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-xs text-gray-800 uppercase tracking-wide">{col.label}</span>
                    <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${col.badge}`}>
                      {colTickets.length}
                    </span>
                  </div>
                </div>

                <div className="p-2 space-y-2.5 overflow-y-auto flex-1">
                  {colTickets.length === 0 ? (
                    <div className="py-8 text-center text-xs text-gray-400 italic">No tickets in this stage</div>
                  ) : (
                    colTickets.map(t => {
                      const due = deadlineState(t);
                      const isAssignee = t.assigned_to === user?.id;
                      const isRaiser = t.user_id === user?.id;
                      const proofCount = parseFileUrls(t.proof_url).length;
                      const attachCount = parseFileUrls(t.attachment_link).length;

                      return (
                        <div
                          key={t.id}
                          onClick={() => openView(t)}
                          className="bg-white p-3 rounded-lg border border-gray-200 shadow-xs hover:shadow-md hover:border-red-300 transition-all cursor-pointer group space-y-2"
                        >
                          <div className="flex items-center justify-between gap-1 text-[11px]">
                            <span className="font-mono font-bold text-red-700">{t.ticket_no}</span>
                            <span className={`px-1.5 py-0.2 rounded text-[9px] uppercase font-semibold ${PRIORITY_COLORS[t.priority] || ''}`}>
                              {t.priority}
                            </span>
                          </div>

                          <h4 className="text-xs font-semibold text-gray-900 line-clamp-2 leading-snug group-hover:text-red-700 transition-colors" title={t.subject}>
                            {t.subject}
                          </h4>

                          {t.module && (
                            <span className="inline-block text-[10px] bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded font-medium">
                              🏷️ {t.module}
                            </span>
                          )}

                          <div className="flex items-center justify-between text-[11px] text-gray-500 pt-1 border-t border-gray-100">
                            <span className="truncate max-w-[120px]" title={`Raised by: ${t.user_name}`}>
                              👤 {t.user_name}
                            </span>
                            {due && (
                              <span className={`px-1.5 py-0.2 rounded text-[10px] ${due.cls}`} title={due.title}>
                                {fmtDate(t.deadline_date, { day: '2-digit', month: 'short' })} {due.suffix}
                              </span>
                            )}
                          </div>

                          {/* Indicators & Quick Action */}
                          <div className="flex items-center justify-between pt-1 text-[10px]">
                            <div className="flex items-center gap-1.5 text-gray-400">
                              {proofCount > 0 && <span className="text-emerald-700 font-medium">📎 {proofCount} proof</span>}
                              {attachCount > 0 && <span className="text-blue-700">📷 {attachCount}</span>}
                            </div>

                            {/* Contextual quick button */}
                            {col.id === 'open' && isAssignee && (
                              <button
                                onClick={(e) => { e.stopPropagation(); update(t.id, { status: 'in_progress' }); }}
                                className="px-2 py-0.5 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold text-[10px] flex items-center gap-1 transition-colors"
                              >
                                Start <FiArrowRight size={10} />
                              </button>
                            )}
                            {col.id === 'in_progress' && (isAssignee || canFollowAll) && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openView(t); }}
                                className="px-2 py-0.5 rounded bg-amber-50 text-amber-800 hover:bg-amber-100 font-semibold text-[10px] flex items-center gap-1 transition-colors"
                              >
                                <FiUpload size={10} /> Proof
                              </button>
                            )}
                            {col.id === 'submitted' && (isRaiser || canFollowAll) && (
                              <button
                                onClick={(e) => { e.stopPropagation(); openView(t); }}
                                className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-800 hover:bg-emerald-100 font-semibold text-[10px] flex items-center gap-1 transition-colors"
                              >
                                <FiCheck size={10} /> Review
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        /* SPREADSHEET LIST VIEW */
        <div className="card p-0 overflow-hidden">
          <div className="table-responsive max-h-[70vh] overflow-auto">
            <NumberedTable start={(pager.page - 1) * pager.perPage + 1} className="text-xs w-full min-w-[950px]">
              <thead className="sticky top-0 z-10 bg-gray-50 border-b">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 whitespace-nowrap">Ticket</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 min-w-[220px]">Subject &amp; Details</th>
                  {scope !== 'mine' && <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Assigned To</th>}
                  {scope !== 'given' && <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Raised By</th>}
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Priority</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Status</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500 min-w-[110px]">Proof</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Deadline</th>
                  <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When</th>
                  <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && (
                  <tr>
                    <td colSpan="10" className="text-center py-10 text-gray-400 text-sm">
                      No tickets found {scope === 'mine' ? 'assigned to you' : scope === 'given' ? 'raised by you' : ''} for the active filters.
                    </td>
                  </tr>
                )}
                {pager.pageItems.map(t => {
                  const isRaiser = t.user_id === user?.id;
                  const isAssignee = t.assigned_to === user?.id;
                  const canClose = canFollowAll || isRaiser;
                  const proofUrls = parseFileUrls(t.proof_url);
                  const due = deadlineState(t);

                  return (
                    <tr key={t.id} className="border-t hover:bg-gray-50/70 cursor-pointer transition-colors" onClick={() => openView(t)}>
                      <td className="px-3 py-2 font-mono font-bold text-red-700 whitespace-nowrap">{t.ticket_no}</td>
                      <td className="px-3 py-2 text-gray-900 font-medium max-w-[320px]">
                        <div className="truncate" title={t.subject}>{t.subject}</div>
                        {t.module && (
                          <div className="text-[10px] text-gray-500 font-normal mt-0.5">
                            🏷️ {t.module}
                          </div>
                        )}
                      </td>

                      {scope !== 'mine' && (
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                          {t.assigned_to_name || <span className="text-gray-300">—</span>}
                          {isAssignee && <span className="text-[10px] text-red-600 ml-1 font-bold">(you)</span>}
                        </td>
                      )}

                      {scope !== 'given' && (
                        <td className="px-3 py-2 text-gray-600 whitespace-nowrap">
                          {t.user_name}
                          {isRaiser && <span className="text-[10px] text-red-600 ml-1 font-bold">(you)</span>}
                        </td>
                      )}

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase ${PRIORITY_COLORS[t.priority] || ''}`}>
                          {t.priority}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        <span className={`px-2 py-0.5 rounded text-[10px] uppercase font-semibold ${STATUS_COLORS[t.status] || ''}`}>
                          {t.status?.replace('_', ' ')}
                        </span>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center gap-1.5">
                          {proofUrls.length > 0 ? (
                            <button
                              onClick={() => openView(t)}
                              className="text-[11px] text-emerald-700 hover:underline font-semibold inline-flex items-center gap-1"
                              title="View submitted proof"
                            >
                              <FiCheckSquare size={12} /> {proofUrls.length === 1 ? 'View Proof' : `${proofUrls.length} Proofs`}
                            </button>
                          ) : (isAssignee || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(t.status) ? (
                            <button
                              onClick={() => openView(t)}
                              className="text-[11px] text-blue-600 font-semibold hover:underline inline-flex items-center gap-1"
                            >
                              <FiUpload size={11} /> {t.status === 'rejected' ? 'Re-upload' : 'Upload'}
                            </button>
                          ) : (
                            <span className="text-gray-300">—</span>
                          )}
                        </div>
                      </td>

                      <td className="px-3 py-2 whitespace-nowrap">
                        {due ? (
                          <span className={`px-2 py-0.5 rounded text-[11px] ${due.cls}`} title={due.title}>
                            {fmtDate(t.deadline_date, { day: '2-digit', month: 'short' })}
                            {due.suffix && <span className="ml-1 font-bold">{due.suffix}</span>}
                          </span>
                        ) : (
                          <span className="text-gray-400">Not Assigned</span>
                        )}
                      </td>

                      <td className="px-3 py-2 text-gray-500 whitespace-nowrap">
                        {fmtDate(t.created_at, { day: '2-digit', month: 'short' })}
                      </td>

                      <td className="px-3 py-2 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                        <div className="flex items-center justify-end gap-1.5">
                          <button
                            onClick={() => openView(t)}
                            className="p-1 text-gray-500 hover:text-blue-600 hover:bg-gray-100 rounded"
                            title="View ticket details"
                          >
                            <FiEye size={13} />
                          </button>
                          {(canFollowAll || isRaiser) && (
                            <button
                              onClick={() => openEdit(t)}
                              className="p-1 text-gray-500 hover:text-blue-600 hover:bg-gray-100 rounded"
                              title="Edit ticket"
                            >
                              <FiEdit2 size={13} />
                            </button>
                          )}
                          {canClose && t.status !== 'resolved' && t.status !== 'closed' && (
                            <button
                              onClick={() => update(t.id, { status: 'resolved' })}
                              className="px-2 py-0.5 text-[10px] bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded font-bold border border-emerald-200"
                              title="Mark resolved"
                            >
                              Close
                            </button>
                          )}
                          {(canFollowAll || isRaiser) && (
                            <button
                              onClick={() => del(t)}
                              className="p-1 text-gray-400 hover:text-red-600 hover:bg-gray-100 rounded"
                              title="Delete ticket"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </NumberedTable>
          </div>
          <Pagination {...pager} />
        </div>
      )}

      {/* CREATE / EDIT TICKET MODAL */}
      <Modal isOpen={createModal || !!editModal} onClose={closeTicketForm} title={editModal ? `Edit Ticket — ${editModal.ticket_no}` : 'Raise New Ticket'}>
        <form onSubmit={submit} onPaste={!editModal ? handleCreatePaste : undefined} className="space-y-3">
          {editModal && <p className="text-xs text-gray-500">Update the ticket details. Status and submitted proof stay as recorded.</p>}

          <div>
            <label className="label" htmlFor="ticket-subject">Subject *</label>
            <input
              id="ticket-subject"
              className="input"
              required
              value={form.subject}
              onChange={e => setForm({ ...form, subject: e.target.value })}
              placeholder="Short title — e.g. Cannot upload PO file"
            />
          </div>

          <div>
            <label className="label" htmlFor="ticket-description">Description *</label>
            <textarea
              id="ticket-description"
              className="input"
              rows="3"
              required
              value={form.description}
              onChange={e => setForm({ ...form, description: e.target.value })}
              placeholder="What happened, what you expected, what module you were on"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="ticket-category">Category</label>
              <select
                id="ticket-category"
                className="select"
                value={form.category}
                onChange={e => setForm({ ...form, category: e.target.value })}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}
              </select>
            </div>

            <div>
              <label className="label" htmlFor="ticket-priority">Priority</label>
              <select
                id="ticket-priority"
                className="select"
                value={form.priority}
                onChange={e => setForm({ ...form, priority: e.target.value })}
              >
                {PRIORITIES.map(p => <option key={p} value={p}>{p.toUpperCase()}</option>)}
              </select>
            </div>

            <div className="sm:col-span-2">
              <label className="label" htmlFor="ticket-deadline">
                Deadline <span className="text-gray-400 font-normal text-[10px]">(optional target date)</span>
              </label>
              <input
                id="ticket-deadline"
                type="date"
                className="input"
                value={form.deadline_date}
                onChange={e => setForm({ ...form, deadline_date: e.target.value })}
              />
            </div>

            <div className="sm:col-span-2">
              <label className="label" htmlFor="ticket-module">Module (optional)</label>
              <input
                id="ticket-module"
                className="input"
                value={form.module}
                onChange={e => setForm({ ...form, module: e.target.value })}
                placeholder="e.g. Procurement, Delegations, Inventory"
              />
            </div>

            <div className="sm:col-span-2">
              <label className="label">Assign To (optional)</label>
              {editModal && !canFollowAll ? (
                <p className="input text-sm text-gray-500">{editModal.assigned_to_name || 'Unassigned'}</p>
              ) : (
                <SearchableSelect
                  options={assigneeOptions}
                  value={form.assigned_to || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Pick someone or leave blank for admin to triage"
                  onChange={(emp) => setForm(f => ({ ...f, assigned_to: emp?.id || '' }))}
                />
              )}
            </div>

            {/* Multiple Upload + Ctrl+V Paste Area for New Ticket */}
            {!editModal && (
              <div className="sm:col-span-2 space-y-2 border-t pt-2">
                <label className="label flex items-center justify-between">
                  <span>Attachments <span className="text-gray-400 font-normal text-[10px]">(photo, PDF, Excel, doc)</span></span>
                  <span className="text-[10px] text-blue-600 font-medium">💡 Tip: Press Ctrl + V to paste screenshots directly</span>
                </label>

                <div className="flex flex-wrap items-center gap-2">
                  <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                    <FiCamera size={12} /> Camera
                    <input
                      type="file"
                      accept="image/*"
                      capture="environment"
                      className="hidden"
                      disabled={createUploading}
                      onChange={e => {
                        const files = Array.from(e.target.files || []);
                        if (files.length) uploadCreateFiles(files);
                      }}
                    />
                  </label>

                  <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                    <FiUpload size={12} /> Browse Files (Multiple)
                    <input
                      type="file"
                      multiple
                      accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.log,.xlsx,.xls,.csv,.doc,.docx"
                      className="hidden"
                      disabled={createUploading}
                      onChange={e => {
                        const files = Array.from(e.target.files || []);
                        if (files.length) uploadCreateFiles(files);
                      }}
                    />
                  </label>

                  {createUploading && <span className="text-xs text-blue-600 font-medium">Uploading attachments…</span>}
                </div>

                {createFiles.length > 0 && (
                  <FileGallery
                    urls={createFiles}
                    title="Attached Files"
                    canRemove={true}
                    onRemove={(idx) => setCreateFiles(prev => prev.filter((_, i) => i !== idx))}
                  />
                )}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={closeTicketForm} className="btn btn-secondary" disabled={savingTicket}>
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={savingTicket || createUploading}>
              {savingTicket ? 'Saving…' : editModal ? 'Save Changes' : 'Raise Ticket'}
            </button>
          </div>
        </form>
      </Modal>

      {/* VIEW / UPDATE TICKET MODAL */}
      <Modal isOpen={!!viewModal} onClose={() => setViewModal(null)} title={viewModal ? `${viewModal.ticket_no} — ${viewModal.subject}` : 'Ticket'} wide>
        {viewModal && (() => {
          const isRaiser = viewModal.user_id === user?.id;
          const isAssignee = viewModal.assigned_to === user?.id;
          const canClose = canFollowAll || isRaiser;
          const canRespond = canFollowAll || isAssignee || isRaiser;
          const st = viewModal.status;
          const canReview = isRaiser || canFollowAll;
          const isSubmitted = st === 'submitted';
          const isClosedState = st === 'resolved' || st === 'closed';
          const isWorking = !isSubmitted && !isClosedState;

          return (
            <div className="space-y-4" onPaste={handleProofPaste}>
              {/* Ticket Meta Details */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 text-xs bg-gray-50/80 p-3 rounded-lg border border-gray-200">
                <div><span className="text-gray-400 block text-[10px] uppercase font-bold">Raised By</span> <b>{viewModal.user_name}</b></div>
                <div><span className="text-gray-400 block text-[10px] uppercase font-bold">Assigned To</span> <b>{viewModal.assigned_to_name || '—'}</b></div>
                <div><span className="text-gray-400 block text-[10px] uppercase font-bold">Category</span> {viewModal.category?.replace('_', ' ')}</div>
                <div>
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Priority</span>
                  <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] ${PRIORITY_COLORS[viewModal.priority] || ''}`}>
                    {viewModal.priority}
                  </span>
                </div>
                <div>
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Status</span>
                  <span className={`inline-block px-1.5 py-0.2 rounded text-[10px] ${STATUS_COLORS[viewModal.status] || ''}`}>
                    {viewModal.status?.replace('_', ' ')}
                  </span>
                </div>
                <div><span className="text-gray-400 block text-[10px] uppercase font-bold">Module</span> {viewModal.module || '—'}</div>
                <div><span className="text-gray-400 block text-[10px] uppercase font-bold">Created</span> {fmtDate(viewModal.created_at)}</div>
                <div>
                  <span className="text-gray-400 block text-[10px] uppercase font-bold">Deadline</span>
                  <b>{viewModal.deadline_date ? fmtDate(viewModal.deadline_date) : 'Not assigned'}</b>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="label">Description</label>
                <div className="bg-gray-50 border rounded p-3 text-sm whitespace-pre-wrap">{viewModal.description}</div>
              </div>

              {/* Initial Attachments */}
              {viewModal.attachment_link && (
                <div>
                  <FileGallery urls={viewModal.attachment_link} title="Initial Attachments" />
                </div>
              )}

              {/* Submitted Proof of Fix (Gallery View) */}
              {viewModal.proof_url && (
                <div className="bg-emerald-50/40 border border-emerald-200 rounded-lg p-3 space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-emerald-800 uppercase flex items-center gap-1">
                      <FiCheckCircle size={13} /> Submitted Proof of Fix
                      {viewModal.proof_submitted_by_name && (
                        <span className="font-normal text-emerald-600 normal-case"> · by {viewModal.proof_submitted_by_name}</span>
                      )}
                    </label>
                    {viewModal.proof_submitted_at && (
                      <span className="text-[10px] text-emerald-600 font-mono">
                        {fmtDate(viewModal.proof_submitted_at)}
                      </span>
                    )}
                  </div>

                  <FileGallery urls={viewModal.proof_url} title="" />

                  {viewModal.proof_notes && (
                    <div className="text-xs text-gray-700 bg-white p-2 rounded border border-emerald-100 whitespace-pre-wrap">
                      <b>Notes:</b> {viewModal.proof_notes}
                    </div>
                  )}
                </div>
              )}

              {/* Rejected notice */}
              {viewModal.status === 'rejected' && viewModal.reject_reason && (
                <div className="bg-red-50 border-l-4 border-red-500 rounded p-3">
                  <p className="text-xs font-bold text-red-700 mb-1">Proof rejected — please re-upload</p>
                  <p className="text-sm text-red-900 whitespace-pre-wrap">{viewModal.reject_reason}</p>
                </div>
              )}

              {/* MULTI-FILE & CTRL+V PROOF UPLOAD (Assignee or Admin) */}
              {(isAssignee || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(viewModal.status) && (
                <div className="border-2 border-dashed border-blue-200 bg-blue-50/20 rounded-xl p-3.5 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-bold text-blue-900 uppercase flex items-center gap-1">
                      <FiUpload size={13} /> Upload Proof of Fix
                    </label>
                    <span className="text-[10px] text-blue-600 font-medium">
                      💡 Tip: Press <b>Ctrl + V</b> anywhere to paste screenshot
                    </span>
                  </div>

                  {/* Upload Controls */}
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                      <FiCamera size={12} /> Camera
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        disabled={proof.uploading}
                        onChange={e => {
                          const files = Array.from(e.target.files || []);
                          if (files.length) uploadProofFiles(files);
                        }}
                      />
                    </label>

                    <label className="btn btn-secondary text-xs cursor-pointer flex items-center gap-1">
                      <FiUpload size={12} /> Browse Files (Multiple)
                      <input
                        type="file"
                        multiple
                        accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.doc,.docx,.xls,.xlsx"
                        className="hidden"
                        disabled={proof.uploading}
                        onChange={e => {
                          const files = Array.from(e.target.files || []);
                          if (files.length) uploadProofFiles(files);
                        }}
                      />
                    </label>

                    {proof.uploading && (
                      <span className="text-xs text-blue-600 font-semibold flex items-center gap-1">
                        <FiClock className="animate-spin" size={12} /> Uploading proof files…
                      </span>
                    )}
                  </div>

                  {/* Attached files preview chips with remove */}
                  {proof.urls?.length > 0 && (
                    <FileGallery
                      urls={proof.urls}
                      title="Attached Proof Files"
                      canRemove={true}
                      onRemove={(idx) => setProof(p => ({ ...p, urls: p.urls.filter((_, i) => i !== idx) }))}
                    />
                  )}

                  <textarea
                    className="input text-xs w-full"
                    rows="2"
                    value={proof.notes}
                    onChange={e => setProof(p => ({ ...p, notes: e.target.value }))}
                    placeholder="Optional note about the fix…"
                  />

                  <button
                    onClick={submitProof}
                    disabled={(!proof.urls?.length && !proof.url) || proof.uploading}
                    className="btn btn-primary text-xs flex items-center gap-1 disabled:opacity-50"
                  >
                    <FiCheck size={12} /> Submit Proof for Approval
                  </button>
                </div>
              )}

              {/* Review status notices */}
              {isSubmitted && canReview && (
                <div className="p-2.5 bg-blue-50 border border-blue-200 rounded text-xs text-blue-800 font-medium flex items-center gap-1.5">
                  <FiAlertTriangle size={14} className="text-blue-600" />
                  Proof submitted — review the proof above and choose <b>Approve &amp; Resolve</b> or <b>Reject</b> below.
                </div>
              )}
              {isSubmitted && !canReview && (
                <p className="text-[11px] text-gray-500 italic">Proof submitted — awaiting the raiser's approval.</p>
              )}

              {/* Response thread */}
              {viewModal.admin_response && (
                <div>
                  <label className="label">Latest Response</label>
                  <div className="bg-blue-50 border border-blue-200 rounded p-3 text-sm whitespace-pre-wrap text-blue-900">{viewModal.admin_response}</div>
                </div>
              )}

              {canRespond && (
                <div>
                  <label className="label">Add / Update Response</label>
                  <textarea
                    className="input text-xs"
                    rows="2"
                    value={response}
                    onChange={e => setResponse(e.target.value)}
                    placeholder="What's the status, plan, or fix..."
                  />
                  <div className="mt-1.5">
                    <button
                      onClick={() => update(viewModal.id, { admin_response: response })}
                      disabled={!response.trim()}
                      className="btn btn-primary text-xs disabled:opacity-50"
                    >
                      Save Response
                    </button>
                  </div>
                </div>
              )}

              {/* Reassign & Deadline editors */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                {canFollowAll && (
                  <div>
                    <label className="label">Reassign To</label>
                    <div className="flex gap-1.5 items-start">
                      <div className="flex-1">
                        <SearchableSelect
                          options={employees.map(e => ({ ...e, label: e.name + (e.department ? ' (' + e.department + ')' : '') }))}
                          value={reassign || null}
                          valueKey="id"
                          displayKey="label"
                          placeholder="Pick assignee"
                          onChange={(emp) => setReassign(emp?.id || '')}
                        />
                      </div>
                      <button
                        onClick={() => update(viewModal.id, { assigned_to: reassign || null })}
                        disabled={String(reassign || '') === String(viewModal.assigned_to || '')}
                        className="btn btn-secondary text-xs whitespace-nowrap disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}

                {(canFollowAll || isAssignee || viewModal.user_id === user?.id) && (
                  <div>
                    <label className="label">Deadline</label>
                    <div className="flex gap-1.5 items-start">
                      <input
                        type="date"
                        className="input flex-1 text-xs"
                        value={deadlineEdit}
                        onChange={e => setDeadlineEdit(e.target.value)}
                      />
                      <button
                        onClick={() => update(viewModal.id, { deadline_date: deadlineEdit || null })}
                        disabled={(deadlineEdit || '') === (viewModal.deadline_date || '').slice(0, 10)}
                        className="btn btn-secondary text-xs whitespace-nowrap disabled:opacity-50"
                      >
                        Save
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Inline reject reason */}
              {isSubmitted && canReview && rejecting && (
                <div className="border-t pt-3 space-y-2 bg-red-50/50 p-3 rounded border border-red-200">
                  <label className="label text-red-800">Reason for rejection <span className="text-gray-400 font-normal text-[10px]">(the assignee will see this)</span></label>
                  <textarea
                    className="input text-xs"
                    rows="2"
                    autoFocus
                    value={rejectReason}
                    onChange={e => setRejectReason(e.target.value)}
                    placeholder="e.g. Screenshot is blurry — please re-capture the fix"
                  />
                  <div className="flex justify-end gap-2">
                    <button onClick={() => { setRejecting(false); setRejectReason(''); }} className="btn btn-secondary text-xs">Cancel</button>
                    <button onClick={rejectProof} disabled={!rejectReason.trim()} className="btn btn-danger text-xs disabled:opacity-50">Confirm Reject</button>
                  </div>
                </div>
              )}

              {/* Action Footer */}
              <div className="flex flex-wrap justify-end items-center gap-2 pt-3 border-t">
                <button onClick={() => setViewModal(null)} className="btn btn-secondary text-xs">Close</button>

                {isWorking && canRespond && st !== 'in_progress' && (
                  <button onClick={() => update(viewModal.id, { status: 'in_progress', admin_response: response || viewModal.admin_response })} className="btn btn-secondary text-amber-700 text-xs">
                    Mark In Progress
                  </button>
                )}

                {isWorking && canClose && (
                  <button onClick={() => update(viewModal.id, { status: 'resolved', admin_response: response || viewModal.admin_response })} className="btn btn-success flex items-center gap-1 text-xs">
                    <FiCheckCircle size={12} /> Mark Resolved
                  </button>
                )}

                {isSubmitted && canReview && !rejecting && (
                  <>
                    <button onClick={() => { setRejecting(true); setRejectReason(''); }} className="btn btn-danger text-xs">
                      Reject…
                    </button>
                    <button onClick={approveProof} className="btn btn-success flex items-center gap-1 text-xs">
                      <FiCheckCircle size={12} /> Approve &amp; Resolve
                    </button>
                  </>
                )}

                {isClosedState && canClose && (
                  <button onClick={() => update(viewModal.id, { status: 'in_progress', admin_response: response || viewModal.admin_response })} className="btn btn-secondary text-amber-700 flex items-center gap-1 text-xs">
                    <FiRotateCcw size={12} /> Reopen
                  </button>
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
