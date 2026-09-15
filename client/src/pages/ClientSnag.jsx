// Client Snags & Site Readiness FMS
//
//   Dual-mode module:
//   Tab 1 · Site Readiness FMS (Client Scope):
//           Tracks what civil / prerequisite work is left at client side
//           (e.g., is plaster left? tiles left? core cutting? civil base?).
//           Follows FMS lifecycle: Reported on Site → Intimated to Client →
//           Under Execution (Overdue Tracking) → Cleared & Verified.
//           Includes Before & Cleared photo proof + Formal Client Notice generator.
//   Tab 2 · Billing & Document Snags:
//           Preserves the original billing snag flow (e.g., bill missing client
//           signature). Identity-gated: Ajmer uploads after photo; Lovely Sharma
//           approves/rejects.

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import Pagination from '../components/Pagination';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiCamera, FiPlus, FiCheckCircle, FiXCircle, FiUploadCloud, FiTrash2,
  FiSearch, FiSettings, FiCalendar, FiClock, FiAlertTriangle, FiFileText,
  FiShare2, FiCheck, FiPrinter, FiCopy, FiExternalLink, FiMapPin,
  FiAlertCircle, FiLayers, FiChevronUp, FiChevronDown, FiRefreshCw
} from 'react-icons/fi';
import { fmtDate, fmtDateTime } from '../utils/datetime';

const SCOPE_CATEGORIES = [
  { id: 'Plastering', label: 'Plastering (Wall / Ceiling)', icon: '🧱', badge: 'bg-orange-100 text-orange-800 border-orange-300' },
  { id: 'Tiling (Floor/Wall)', label: 'Tiling (Floor / Wall)', icon: '🔲', badge: 'bg-blue-100 text-blue-800 border-blue-300' },
  { id: 'Civil Foundation / Plinth', label: 'Civil Foundation / Plinth', icon: '🏗️', badge: 'bg-stone-100 text-stone-800 border-stone-300' },
  { id: 'Core Cutting / Openings', label: 'Core Cutting / Sleeves / Openings', icon: '🕳️', badge: 'bg-purple-100 text-purple-800 border-purple-300' },
  { id: 'Site Clearance / Debris', label: 'Site Clearance / Space Debris', icon: '🧹', badge: 'bg-amber-100 text-amber-800 border-amber-300' },
  { id: 'Power / Water Supply', label: 'Testing Utilities (Power / Water)', icon: '⚡', badge: 'bg-yellow-100 text-yellow-800 border-yellow-300' },
  { id: 'Other Civil Work', label: 'Other Civil Work', icon: '📌', badge: 'bg-gray-100 text-gray-800 border-gray-300' },
];

const FLOOR_ZONES = [
  'Basement 2', 'Basement 1', 'Ground Floor', '1st Floor', '2nd Floor',
  '3rd Floor', '4th Floor', '5th Floor', 'Terrace', 'Pump Room',
  'Substation / Meter Room', 'Shaft Area', 'External Yard', 'Whole Site', 'Other'
];

const FMS_STAGES = {
  reported: { label: 'Reported on Site', pill: 'bg-amber-100 text-amber-800 border-amber-300' },
  intimated: { label: 'Intimated to Client', pill: 'bg-blue-100 text-blue-800 border-blue-300' },
  in_progress: { label: 'Client In Progress', pill: 'bg-indigo-100 text-indigo-800 border-indigo-300' },
  cleared: { label: 'Cleared & Verified', pill: 'bg-emerald-100 text-emerald-800 border-emerald-300' },
};

const LEGACY_STATUS_PILL = {
  awaiting_document: 'bg-amber-100 text-amber-700',
  pending_approval: 'bg-blue-100 text-blue-700',
  approved: 'bg-emerald-100 text-emerald-700',
  rejected: 'bg-red-100 text-red-700',
};
const LEGACY_STATUS_LABEL = {
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
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  // Mode Tab: 'site_readiness' (default) vs 'billing_doc'
  const activeTab = searchParams.get('tab') || 'site_readiness';

  // Server-side filter & pagination params from URL
  const page = parseInt(searchParams.get('page') || '1', 10);
  const limitParam = searchParams.get('limit');
  const limit = limitParam === 'all' ? 'all' : parseInt(limitParam || '15', 10);
  const search = searchParams.get('search') || '';
  const site = searchParams.get('site') || searchParams.get('site_id') || '';
  const civilScopeType = searchParams.get('civilScopeType') || searchParams.get('scope_category') || '';
  const floor = searchParams.get('floor') || searchParams.get('floor_zone') || '';
  const stage = searchParams.get('stage') || searchParams.get('fms_stage') || '';
  const date = searchParams.get('date') || '';
  const client = searchParams.get('client') || '';
  const priority = searchParams.get('priority') || '';
  const status = searchParams.get('status') || '';
  const sortBy = searchParams.get('sortBy') || '';
  const sortOrder = searchParams.get('sortOrder') || 'desc';

  // Data & Pagination state returned from backend
  const [rows, setRows] = useState([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [paginationFrom, setPaginationFrom] = useState(0);
  const [paginationTo, setPaginationTo] = useState(0);
  const [counters, setCounters] = useState(null);
  const [loading, setLoading] = useState(false);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);

  // Local search input for debounced typing
  const [searchInput, setSearchInput] = useState(search);
  useEffect(() => {
    setSearchInput(search);
  }, [search]);

  // Helper to update URL search parameters (syncs state and triggers backend fetch)
  const updateFilter = useCallback((updates, replaceUrl = false) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      Object.entries(updates).forEach(([k, v]) => {
        if (v === '' || v === null || v === undefined) {
          next.delete(k);
        } else {
          next.set(k, String(v));
        }
      });
      // If changing a filter other than page, reset page back to 1
      if (!('page' in updates)) {
        next.delete('page');
      }
      return next;
    }, { replace: replaceUrl });
  }, [setSearchParams]);

  // Debounce search update: triggers API call only after user stops typing for 500ms
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== search) {
        updateFilter({ search: searchInput }, true);
      }
    }, 500);
    return () => clearTimeout(timer);
  }, [searchInput, search, updateFilter]);

  const handleTabChange = (newTab) => {
    const next = new URLSearchParams();
    if (newTab !== 'site_readiness') next.set('tab', newTab);
    setSearchParams(next);
  };

  const handleSort = (col) => {
    const isCurrent = sortBy === col;
    const newOrder = isCurrent && sortOrder === 'asc' ? 'desc' : 'asc';
    updateFilter({ sortBy: col, sortOrder: newOrder });
  };

  const renderSortIcon = (col) => {
    if (sortBy !== col) return null;
    return sortOrder === 'asc'
      ? <FiChevronUp className="inline ml-1 text-indigo-600" size={12} />
      : <FiChevronDown className="inline ml-1 text-indigo-600" size={12} />;
  };

  // Modals
  const [createModal, setCreateModal] = useState(false);
  const [form, setForm] = useState({});
  const [detail, setDetail] = useState(null);        // full detail of the open snag
  // Which snag id openDetail() was last called for — checked before its
  // fetch is allowed to overwrite `detail` (mam 2026-08-24: "sometimes
  // wrong upload"). Without this, uploading a photo on snag A, then opening
  // snag B before A's post-upload refresh completes, snaps the panel back
  // to snag A's stale data right after B was opened — and a subsequent
  // action (submit/approve) would then silently apply to A, not B.
  const detailIdRef = useRef(null);
  // Same idea for the "New Client Snag" create form: bumped each time the
  // create modal opens, so a photo upload started before a Cancel+reopen
  // can't land in the fresh blank form.
  const createAttemptRef = useRef(0);
  const [uploading, setUploading] = useState(false);

  // FMS Action Modals (Site Readiness)
  const [intimateModal, setIntimateModal] = useState(null); // snag row being intimated
  const [intimateForm, setIntimateForm] = useState({});
  const [clearanceModal, setClearanceModal] = useState(null); // snag row being cleared
  const [clearanceForm, setClearanceForm] = useState({});
  const [noticeModal, setNoticeModal] = useState(null); // snag row for formal client notice
  const [copiedNotice, setCopiedNotice] = useState(false);

  // Legacy Billing Snag Modals
  const [rejectFor, setRejectFor] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [approveFor, setApproveFor] = useState(null);
  const [gate, setGate] = useState(null);

  // Load sites & users on mount
  useEffect(() => {
    api.get('/client-snag/sites').then(r => setSites(r.data || [])).catch(() => { });
    api.get('/auth/users').then(r => setUsers(r.data || [])).catch(() => { });
  }, []);

  // Server-side fetch: sends all search, filter, sort & pagination parameters to backend API
  const load = useCallback(() => {
    setLoading(true);
    const params = {
      snag_type: activeTab,
      page,
      limit,
      search,
      site,
      civilScopeType,
      floor,
      stage,
      date,
      client,
      priority,
      status,
      sortBy,
      sortOrder,
    };
    Object.keys(params).forEach(k => {
      if (params[k] === '' || params[k] === null || params[k] === undefined) delete params[k];
    });

    api.get('/client-snag', { params })
      .then(r => {
        const data = r.data;
        if (data && Array.isArray(data.rows)) {
          setRows(data.rows);
          setTotal(data.total || 0);
          setPages(data.pages || 1);
          setPaginationFrom(data.from || 0);
          setPaginationTo(data.to || 0);
          if (data.counters) setCounters(data.counters);
        } else if (Array.isArray(data)) {
          setRows(data);
          setTotal(data.length);
          setPages(1);
          setPaginationFrom(0);
          setPaginationTo(data.length);
        }
      })
      .catch(err => toast.error(`Failed to load snags: ${err.response?.data?.error || err.message}`))
      .finally(() => setLoading(false));
  }, [activeTab, page, limit, search, site, civilScopeType, floor, stage, date, client, priority, status, sortBy, sortOrder]);

  useEffect(() => {
    load();
  }, [load]);

  const loadCounters = useCallback(() => {
    api.get('/client-snag/counters').then(r => setCounters(r.data)).catch(() => { });
  }, []);

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

  // field is 'before_photo_url' (open to whoever raises the snag) or
  // 'photo_url' (the After Photo — convenience upload, Ajmer-only; the
  // backend independently re-checks who's allowed to attach it).
  const uploadForCreate = async (field, file) => {
    const attempt = createAttemptRef.current;
    const url = await upload(file);
    if (!url) return;
    if (createAttemptRef.current !== attempt) {
      toast('That upload finished after you restarted this form — please upload again.', { icon: '⚠️' });
      return;
    }
    setForm(f => ({ ...f, [field]: url, [`${field}_at_preview`]: new Date().toISOString() }));
  };

  const openCreate = () => {
    createAttemptRef.current += 1;
    setForm({
      snag_type: activeTab,
      priority: 'medium',
      scope_category: activeTab === 'site_readiness' ? 'Plastering' : '',
      floor_zone: activeTab === 'site_readiness' ? 'Ground Floor' : '',
    });
    setCreateModal(true);
  };

  const handleSiteSelect = (siteObj) => {
    if (!siteObj) {
      setForm(f => ({ ...f, site_id: '', site_name: '', client_name: '' }));
      return;
    }
    setForm(f => ({
      ...f,
      site_id: siteObj.id,
      site_name: siteObj.name,
      client_name: siteObj.company_name || siteObj.client_name || f.client_name || '',
    }));
  };

  const create = async (e) => {
    e.preventDefault();
    if (!form.client_name?.trim()) return toast.error('Client is required');
    if (!form.site_name?.trim()) return toast.error('Site Name is required');
    if (!form.description?.trim()) return toast.error('Description is required');
    if (!form.before_photo_url) return toast.error('Before Photo is required as physical proof');

    if (activeTab === 'site_readiness') {
      if (!form.scope_category) return toast.error('Civil Scope Category is required');
      if (!form.floor_zone) return toast.error('Floor / Zone is required');
    } else {
      if (!form.assigned_to) return toast.error('Assign To is required');
      if (!form.location?.trim()) return toast.error('Location is required');
    }

    try {
      const payload = { ...form, snag_type: activeTab };
      const r = await api.post('/client-snag', payload);

      if (activeTab === 'billing_doc' && form.photo_url) {
        try { await api.post(`/client-snag/${r.data.id}/document`, { photo_url: form.photo_url }); } catch { }
      }
      toast.success(`Logged ${r.data.snag_no}`);
      createAttemptRef.current += 1;
      setCreateModal(false);
      setForm({});
      load();
      loadCounters();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create');
    }
  };

  // FMS Step 2: Intimate to Client & Record Promised Date
  const openIntimate = (row) => {
    setIntimateModal(row);
    setIntimateForm({
      client_promised_date: row.client_promised_date || '',
      client_contact_person: row.client_contact_person || '',
      client_contact_phone: row.client_contact_phone || '',
      intimation_notes: row.intimation_notes || '',
    });
  };

  const submitIntimation = async (e) => {
    e.preventDefault();
    if (!intimateForm.client_promised_date) return toast.error('Client promised date is required');
    try {
      await api.post(`/client-snag/${intimateModal.id}/intimate`, intimateForm);
      toast.success('Client intimation and target date recorded');
      setIntimateModal(null);
      load();
      loadCounters();
      if (detail?.id === intimateModal.id) openDetail(detail.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to record intimation');
    }
  };

  // FMS Step 4: Clear Civil Work with verification photo
  const openClearance = (row) => {
    setClearanceModal(row);
    setClearanceForm({ cleared_photo_url: '', notes: '' });
  };

  const submitClearance = async (e) => {
    e.preventDefault();
    if (!clearanceForm.cleared_photo_url) return toast.error('Clearance photo proof is required');
    try {
      await api.post(`/client-snag/${clearanceModal.id}/clear`, clearanceForm);
      toast.success('Civil scope marked as Cleared & Verified!');
      setClearanceModal(null);
      load();
      loadCounters();
      if (detail?.id === clearanceModal.id) openDetail(detail.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to clear');
    }
  };

  // Formal Notice Generator Modal
  const openNotice = (row) => {
    setNoticeModal(row);
    setCopiedNotice(false);
  };

  const getNoticeText = (row) => {
    if (!row) return '';
    const dateStr = fmtDate(row.raised_at || new Date());
    const isOverdue = row.days_overdue > 0;
    return `*SECURED ENGINEERS PVT. LTD.*
*SITE READINESS & PENDING CLIENT SCOPE INTIMATION*

*Site:* ${row.site_name || '—'}
*Client:* ${row.client_name || '—'}
*Date Observed:* ${dateStr}
*Ref No:* ${row.snag_no}

*Location / Floor:* ${row.floor_zone || '—'}${row.location ? ' · ' + row.location : ''}
*Pending Civil Scope:* ${row.scope_category || 'Civil Work'}
*Description:* ${row.description}
*Client Promised Date:* ${row.client_promised_date ? fmtDate(row.client_promised_date) : 'Pending Confirmation'}
*Status:* ${isOverdue ? `⚠️ OVERDUE by ${row.days_overdue} days` : 'Awaiting Civil Clearance'}

*Impact on MEPF Execution:*
Please note that our installation piping, brackets, and fixtures cannot proceed in this zone until the client's civil team completes the prerequisite work (plastering/tiling/foundations). Continued delay in civil handover directly holds up project milestones.

*Kindly expedite civil clearance.*`;
  };

  const copyNoticeToClipboard = () => {
    const text = getNoticeText(noticeModal);
    navigator.clipboard.writeText(text);
    setCopiedNotice(true);
    toast.success('Notice copied to clipboard for WhatsApp/Email!');
    setTimeout(() => setCopiedNotice(false), 3000);
  };

  const openDetail = (id) => {
    detailIdRef.current = id;
    api.get(`/client-snag/${id}`).then(r => {
      // The user may have opened a DIFFERENT snag (or closed this panel)
      // while this fetch was in flight — don't let a stale response snap
      // the panel back to the wrong record.
      if (detailIdRef.current !== id) return;
      setDetail(r.data);
    }).catch(() => toast.error('Failed to load'));
  };

  const remove = async (row) => {
    if (!confirm(`Delete ${row.snag_no}?`)) return;
    try {
      await api.delete(`/client-snag/${row.id}`);
      toast.success('Deleted');
      load();
      loadCounters();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // Legacy Billing Doc functions
  const uploadDocument = async (file) => {
    const forId = detailIdRef.current;
    const url = await upload(file);
    if (!url || !detail || detailIdRef.current !== forId) {
      if (url && detailIdRef.current !== forId) toast('That upload finished after you switched snags — please upload again here.', { icon: '⚠️' });
      return;
    }
    try {
      await api.post(`/client-snag/${detail.id}/document`, { photo_url: url });
      toast.success('Photo uploaded');
      openDetail(detail.id);
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const submitForApproval = async () => {
    if (!detail) return;
    try {
      await api.post(`/client-snag/${detail.id}/submit`);
      toast.success('Submitted for approval');
      openDetail(detail.id);
      load();
      loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doApprove = async () => {
    if (!approveFor) return;
    try {
      await api.post(`/client-snag/${approveFor}/approve`);
      toast.success('Approved');
      setApproveFor(null);
      if (detail?.id === approveFor) openDetail(detail.id);
      load();
      loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doReject = async (e) => {
    e.preventDefault();
    if (!rejectReason.trim()) return toast.error('Rejection reason is required');
    try {
      await api.post(`/client-snag/${rejectFor}/reject`, { reason: rejectReason });
      toast.success('Rejected — uploader can resubmit');
      const wasDetail = detail?.id === rejectFor;
      setRejectFor(null);
      setRejectReason('');
      if (wasDetail) openDetail(rejectFor);
      load();
      loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const openGate = () => {
    api.get('/client-snag/settings/gate').then(r => setGate(r.data)).catch(() => toast.error('Failed to load'));
  };

  const reassign = async (roleKey, userId) => {
    if (!userId) return;
    try {
      await api.put('/client-snag/settings/gate', { role_key: roleKey, user_id: userId });
      toast.success('Reassigned');
      openGate();
      load();
      loadCounters();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FiCamera className="text-red-600" />
            Client Snags & Site Readiness FMS
          </h1>
          <p className="text-sm text-gray-500">
            {activeTab === 'site_readiness'
              ? 'Site-to-Client civil readiness register — tracks if plaster, tiles, foundations, or cutouts are left at site.'
              : "Client-facing document snags — e.g. bill missing client's signature (Ajmer / Lovely Sharma approval)."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {activeTab === 'billing_doc' && isAdmin() && (
            <button onClick={openGate} className="btn btn-secondary flex items-center gap-1 text-sm">
              <FiSettings size={14} /> Reassign
            </button>
          )}
          {canCreate('client_snag') && (
            <button onClick={openCreate} className="btn btn-primary flex items-center gap-1 shadow-sm">
              <FiPlus size={14} />
              {activeTab === 'site_readiness' ? 'Log Civil Work Left' : 'New Client Snag'}
            </button>
          )}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex border-b border-gray-200">
        <button
          onClick={() => handleTabChange('site_readiness')}
          className={`px-5 py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition ${activeTab === 'site_readiness'
              ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
        >
          <FiLayers size={16} />
          🏗️ Site Readiness FMS (Client Scope)
          {counters?.sr_total_open > 0 && (
            <span className="ml-1.5 px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-800 font-bold">
              {counters.sr_total_open}
            </span>
          )}
        </button>

        <button
          onClick={() => handleTabChange('billing_doc')}
          className={`px-5 py-3 text-sm font-semibold border-b-2 flex items-center gap-2 transition ${activeTab === 'billing_doc'
              ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
              : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
        >
          <FiFileText size={16} />
          📄 Billing & Document Snags
          {counters?.pending_approval > 0 && (
            <span className="ml-1.5 px-2 py-0.5 text-xs rounded-full bg-blue-100 text-blue-800 font-bold">
              {counters.pending_approval}
            </span>
          )}
        </button>
      </div>

      {/* Metric Cards (Clickable Server Filters) */}
      {counters && (
        activeTab === 'site_readiness' ? (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div
              onClick={() => updateFilter({ stage: '', civilScopeType: '' })}
              className={`card p-3 border-l-4 border-indigo-500 cursor-pointer hover:shadow-md transition bg-gradient-to-br from-white to-indigo-50/30 ${!stage && !civilScopeType ? 'ring-2 ring-indigo-400' : ''}`}
              title="Click to view all open clearances"
            >
              <p className="text-xs text-gray-500 font-medium">Total Open Clearances</p>
              <p className="text-2xl font-bold text-indigo-700">{counters.sr_total_open || 0}</p>
            </div>
            <div
              onClick={() => updateFilter({ civilScopeType: civilScopeType === 'Plastering' ? '' : 'Plastering' })}
              className={`card p-3 border-l-4 border-orange-500 cursor-pointer hover:shadow-md transition bg-gradient-to-br from-white to-orange-50/30 ${civilScopeType === 'Plastering' ? 'ring-2 ring-orange-400' : ''}`}
              title="Click to filter by Plaster Pending"
            >
              <p className="text-xs text-gray-500 font-medium">🧱 Plaster Pending</p>
              <p className="text-2xl font-bold text-orange-700">{counters.sr_plaster || 0}</p>
            </div>
            <div
              onClick={() => updateFilter({ civilScopeType: civilScopeType === 'Tiling (Floor/Wall)' ? '' : 'Tiling (Floor/Wall)' })}
              className={`card p-3 border-l-4 border-blue-500 cursor-pointer hover:shadow-md transition bg-gradient-to-br from-white to-blue-50/30 ${civilScopeType === 'Tiling (Floor/Wall)' ? 'ring-2 ring-blue-400' : ''}`}
              title="Click to filter by Tiles Pending"
            >
              <p className="text-xs text-gray-500 font-medium">🔲 Tiles Pending</p>
              <p className="text-2xl font-bold text-blue-700">{counters.sr_tiles || 0}</p>
            </div>
            <div
              onClick={() => updateFilter({ stage: stage === 'overdue' ? '' : 'overdue' })}
              className={`card p-3 border-l-4 border-red-500 cursor-pointer hover:shadow-md transition bg-gradient-to-br from-white to-red-50/30 ${stage === 'overdue' ? 'ring-2 ring-red-400' : ''}`}
              title="Click to filter Overdue Items"
            >
              <p className="text-xs text-gray-500 font-medium">⚠️ Overdue (&gt; Promised Date)</p>
              <p className="text-2xl font-bold text-red-700">{counters.sr_overdue || 0}</p>
            </div>
            <div
              onClick={() => updateFilter({ stage: stage === 'cleared' ? '' : 'cleared' })}
              className={`card p-3 border-l-4 border-emerald-500 cursor-pointer hover:shadow-md transition bg-gradient-to-br from-white to-emerald-50/30 ${stage === 'cleared' ? 'ring-2 ring-emerald-400' : ''}`}
              title="Click to filter Cleared & Verified"
            >
              <p className="text-xs text-gray-500 font-medium">✅ Cleared &amp; Verified</p>
              <p className="text-2xl font-bold text-emerald-700">{counters.sr_cleared || 0}</p>
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {counters.is_uploader && (
              <div
                onClick={() => updateFilter({ status: status === 'awaiting_document' ? '' : 'awaiting_document' })}
                className={`card p-3 border-l-4 border-amber-500 cursor-pointer hover:shadow-md transition ${status === 'awaiting_document' ? 'ring-2 ring-amber-400' : ''}`}
                title="Click to filter Awaiting Document"
              >
                <p className="text-xs text-gray-500">Awaiting Document</p>
                <p className="text-2xl font-bold text-amber-600">{counters.awaiting_document}</p>
              </div>
            )}
            <div
              onClick={() => updateFilter({ status: status === 'pending_approval' ? '' : 'pending_approval' })}
              className={`card p-3 border-l-4 border-blue-500 cursor-pointer hover:shadow-md transition ${status === 'pending_approval' ? 'ring-2 ring-blue-400' : ''}`}
              title="Click to filter Pending Approval"
            >
              <p className="text-xs text-gray-500">Pending Approval</p>
              <p className="text-2xl font-bold text-blue-600">{counters.pending_approval}</p>
            </div>
            <div
              onClick={() => updateFilter({ status: status === 'approved' ? '' : 'approved' })}
              className={`card p-3 border-l-4 border-emerald-500 cursor-pointer hover:shadow-md transition ${status === 'approved' ? 'ring-2 ring-emerald-400' : ''}`}
              title="Click to filter Approved"
            >
              <p className="text-xs text-gray-500">Approved</p>
              <p className="text-2xl font-bold text-emerald-600">{counters.approved}</p>
            </div>
            <div
              onClick={() => updateFilter({ status: status === 'rejected' ? '' : 'rejected' })}
              className={`card p-3 border-l-4 border-red-500 cursor-pointer hover:shadow-md transition ${status === 'rejected' ? 'ring-2 ring-red-400' : ''}`}
              title="Click to filter Rejected"
            >
              <p className="text-xs text-gray-500">Rejected</p>
              <p className="text-2xl font-bold text-red-700">{counters.rejected}</p>
            </div>
          </div>
        )
      )}

      {/* Filter Bar */}
      <div className="card p-3 flex flex-wrap items-end gap-3 bg-white shadow-sm">
        <div className="relative flex-1 min-w-[200px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input
            className="input pl-9 pr-8 text-sm w-full"
            placeholder={activeTab === 'site_readiness' ? "Search site, client, plaster, tiles, floor…" : "Search snag #, client, description…"}
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') {
                e.preventDefault();
                updateFilter({ search: searchInput }, true);
              }
            }}
          />
          {searchInput && (
            <button
              onClick={() => {
                setSearchInput('');
                updateFilter({ search: '' }, true);
              }}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 p-0.5"
              title="Clear search"
              type="button"
            >
              <FiXCircle size={14} />
            </button>
          )}
        </div>

        {activeTab === 'site_readiness' ? (
          <>
            <div className="w-48 shrink-0">
              <label className="label text-xs">Site</label>
              <select
                className="select text-xs"
                value={site}
                onChange={e => updateFilter({ site: e.target.value })}
              >
                <option value="">All Sites</option>
                {sites.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div className="w-48 shrink-0">
              <label className="label text-xs">Civil Scope Type</label>
              <select
                className="select text-xs"
                value={civilScopeType}
                onChange={e => updateFilter({ civilScopeType: e.target.value })}
              >
                <option value="">All Civil Works</option>
                {SCOPE_CATEGORIES.map(c => (
                  <option key={c.id} value={c.id}>{c.icon} {c.id}</option>
                ))}
              </select>
            </div>

            <div className="w-36 shrink-0">
              <label className="label text-xs">Floor / Zone</label>
              <select
                className="select text-xs"
                value={floor}
                onChange={e => updateFilter({ floor: e.target.value })}
              >
                <option value="">All Floors</option>
                {FLOOR_ZONES.map(z => (
                  <option key={z} value={z}>{z}</option>
                ))}
              </select>
            </div>

            <div className="w-44 shrink-0">
              <label className="label text-xs">FMS Stage</label>
              <select
                className="select text-xs"
                value={stage}
                onChange={e => updateFilter({ stage: e.target.value })}
              >
                <option value="">All Stages</option>
                <option value="reported">Reported on Site</option>
                <option value="intimated">Intimated to Client</option>
                <option value="in_progress">Client In Progress</option>
                <option value="overdue">⚠️ Overdue (&gt; Promised)</option>
                <option value="cleared">Cleared &amp; Verified</option>
              </select>
            </div>
          </>
        ) : (
          <>
            <div className="w-40 shrink-0">
              <label className="label text-xs">Client</label>
              <input
                className="input text-xs"
                value={client}
                onChange={e => updateFilter({ client: e.target.value })}
                placeholder="Filter client..."
              />
            </div>
            <div className="w-40 shrink-0">
              <label className="label text-xs">Site / Location</label>
              <input
                className="input text-xs"
                value={site}
                onChange={e => updateFilter({ site: e.target.value })}
                placeholder="Filter site/location..."
              />
            </div>
            <div className="w-32 shrink-0">
              <label className="label text-xs">Priority</label>
              <select
                className="select text-xs"
                value={priority}
                onChange={e => updateFilter({ priority: e.target.value })}
              >
                <option value="">All</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </div>
            <div className="w-44 shrink-0">
              <label className="label text-xs">Status</label>
              <select
                className="select text-xs"
                value={status}
                onChange={e => updateFilter({ status: e.target.value })}
              >
                <option value="">All</option>
                <option value="awaiting_document">Awaiting Document</option>
                <option value="pending_approval">Pending Approval</option>
                <option value="approved">Approved</option>
                <option value="rejected">Rejected</option>
              </select>
            </div>
          </>
        )}

        <div className="w-36 shrink-0">
          <label className="label text-xs">Date</label>
          <input
            type="date"
            className="input text-xs"
            value={date}
            onChange={e => updateFilter({ date: e.target.value })}
          />
        </div>

        {(search || site || civilScopeType || floor || stage || date || client || priority || status || sortBy) && (
          <button
            onClick={() => {
              setSearchInput('');
              const next = new URLSearchParams();
              if (activeTab !== 'site_readiness') next.set('tab', activeTab);
              setSearchParams(next);
            }}
            className="btn btn-secondary text-xs px-2.5 py-1.5 shrink-0 text-gray-500 hover:text-red-600 transition"
            title="Reset all filters"
          >
            Reset Filters
          </button>
        )}
      </div>

      {/* Main Table */}
      <div className="card p-0 shadow-sm border overflow-hidden">
        <div className="overflow-auto max-h-[70vh]">
          {activeTab === 'site_readiness' ? (
            <table className="freeze-head freeze-col w-full min-w-[1150px] text-left">
              <thead>
                <tr>
                  <th onClick={() => handleSort('snag_no')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Item Ref {renderSortIcon('snag_no')}
                  </th>
                  <th onClick={() => handleSort('site_name')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Site &amp; Client {renderSortIcon('site_name')}
                  </th>
                  <th onClick={() => handleSort('floor_zone')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Floor / Zone {renderSortIcon('floor_zone')}
                  </th>
                  <th onClick={() => handleSort('scope_category')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Civil Scope Left {renderSortIcon('scope_category')}
                  </th>
                  <th>Before Photo</th>
                  <th onClick={() => handleSort('client_promised_date')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Client Promised Date {renderSortIcon('client_promised_date')}
                  </th>
                  <th onClick={() => handleSort('fms_stage')} className="cursor-pointer hover:text-indigo-600 select-none">
                    FMS Stage {renderSortIcon('fms_stage')}
                  </th>
                  <th>Clearance Photo</th>
                  <th onClick={() => handleSort('priority')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Priority {renderSortIcon('priority')}
                  </th>
                  <th onClick={() => handleSort('raised_at')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Raised {renderSortIcon('raised_at')}
                  </th>
                  <th className="text-right">Action / FMS Next</th>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr>
                    <td colSpan="11" className="text-center py-12 text-gray-400">
                      <FiCheckCircle size={32} className="mx-auto mb-2 text-emerald-400 opacity-60" />
                      No pending client civil snags found matching current filters.
                    </td>
                  </tr>
                )}
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-indigo-50/30 transition">
                    <td className="font-bold text-indigo-950 text-xs whitespace-nowrap">
                      <span className="cursor-pointer hover:underline" onClick={() => openDetail(r.id)}>
                        {r.snag_no}
                      </span>
                    </td>
                    <td className="text-xs">
                      <div className="font-semibold text-gray-900">{r.site_name || '—'}</div>
                      <div className="text-[11px] text-gray-500">{r.client_name || '—'}</div>
                    </td>
                    <td className="text-xs font-medium text-gray-800">
                      <div>{r.floor_zone || '—'}</div>
                      {r.location && <div className="text-[10px] text-gray-500 font-normal">{r.location}</div>}
                    </td>
                    <td className="text-xs">
                      <span className={`inline-block px-2 py-0.5 rounded text-[11px] font-semibold border ${getScopeCategoryBadge(r.scope_category)}`}>
                        {r.scope_category || 'Civil Work'}
                      </span>
                    </td>
                    <td>
                      {r.before_photo_url ? (
                        <a href={r.before_photo_url} target="_blank" rel="noreferrer">
                          <img
                            src={r.before_photo_url}
                            alt="Before"
                            width="48"
                            height="48"
                            loading="lazy"
                            decoding="async"
                            className="w-12 h-12 object-cover rounded border hover:opacity-80 transition shadow-xs"
                          />
                        </a>
                      ) : (
                        <span className="text-gray-300 text-xs">—</span>
                      )}
                    </td>
                    <td className="text-xs whitespace-nowrap">
                      {r.client_promised_date ? (
                        <div>
                          <div className={r.days_overdue > 0 ? 'text-red-600 font-bold' : 'text-gray-900 font-medium'}>
                            {fmtDate(r.client_promised_date)}
                          </div>
                          {r.days_overdue > 0 ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-bold bg-red-100 text-red-700 border border-red-200 mt-0.5 inline-block">
                              ⚠️ {r.days_overdue} d late
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-500">On schedule</span>
                          )}
                        </div>
                      ) : (
                        <span className="text-amber-600 font-semibold text-[11px]">Not Intimated</span>
                      )}
                    </td>

                    <td className="whitespace-nowrap">
                      {getFmsStagePill(r.fms_stage)}
                    </td>

                    <td>
                      {r.cleared_photo_url ? (
                        <a href={r.cleared_photo_url} target="_blank" rel="noreferrer" title="Clearance Photo Proof">
                          <img
                            src={r.cleared_photo_url}
                            alt="Cleared"
                            width="52"
                            height="52"
                            loading="lazy"
                            className="w-12 h-12 object-cover rounded ring-2 ring-emerald-500 hover:scale-105 transition shadow-xs"
                          />
                        </a>
                      ) : (
                        <span className="text-gray-400 text-xs italic">Pending</span>
                      )}
                    </td>

                    <td>
                      <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[r.priority] || ''}`}>
                        {r.priority}
                      </span>
                    </td>

                    <td className="text-xs text-gray-500 whitespace-nowrap">
                      {r.raised_at ? fmtDate(r.raised_at) : '—'}
                    </td>

                    <td className="whitespace-nowrap text-right pr-4 min-w-[220px]">
                      <div className="flex items-center justify-end gap-1.5">
                        {/* Step 2: Intimate / Set Client Target */}
                        {r.fms_stage !== 'cleared' && (
                          <button
                            onClick={() => openIntimate(r)}
                            className="btn btn-secondary text-[11px] px-2 py-1 flex items-center gap-1 shadow-xs hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 transition"
                            title="Intimate to Client / Update Promised Date"
                          >
                            <FiCalendar size={12} /> Intimate
                          </button>
                        )}

                        {/* Step 4: Mark Cleared */}
                        {r.fms_stage !== 'cleared' && (
                          <button
                            onClick={() => openClearance(r)}
                            className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1 shadow-xs transition"
                            title="Upload Finished Civil Work Photo & Mark Cleared"
                          >
                            <FiCheckCircle size={12} /> Clear
                          </button>
                        )}

                        {/* Formal Notice generator */}
                        <button
                          onClick={() => openNotice(r)}
                          className="p-1.5 text-indigo-600 hover:bg-indigo-50 rounded border border-indigo-200 transition"
                          title="Generate Formal Client Notice (WhatsApp/Print)"
                        >
                          <FiShare2 size={13} />
                        </button>

                        {/* Details */}
                        <button
                          onClick={() => openDetail(r.id)}
                          className="btn btn-secondary text-[11px] px-2 py-1 transition"
                        >
                          View
                        </button>

                        {canDelete('client_snag') && (
                          <button onClick={() => remove(r)} className="p-1.5 text-gray-400 hover:text-red-600 transition" title="Delete">
                            <FiTrash2 size={13} />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            /* Tab 2: Legacy Billing & Document Snags */
            <table className="freeze-head freeze-col w-full min-w-[1100px] text-left">
              <thead>
                <tr>
                  <th onClick={() => handleSort('snag_no')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Snag ID {renderSortIcon('snag_no')}
                  </th>
                  <th onClick={() => handleSort('client_name')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Client {renderSortIcon('client_name')}
                  </th>
                  <th>Assign To</th>
                  <th>Before Photo</th>
                  <th onClick={() => handleSort('raised_at')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Raised Date {renderSortIcon('raised_at')}
                  </th>
                  <th>After Photo</th>
                  <th onClick={() => handleSort('site_name')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Site / Location {renderSortIcon('site_name')}
                  </th>
                  <th>Description</th>
                  <th onClick={() => handleSort('priority')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Priority {renderSortIcon('priority')}
                  </th>
                  <th onClick={() => handleSort('status')} className="cursor-pointer hover:text-indigo-600 select-none">
                    Status {renderSortIcon('status')}
                  </th>
                  <th className="text-right pr-4 min-w-[120px]">Action</th>
                </tr>
              </thead>
              <tbody>
                {loading && rows.length === 0 && (
                  <tr>
                    <td colSpan="11" className="text-center py-12 text-gray-400">
                      <div className="flex items-center justify-center gap-2">
                        <FiRefreshCw className="animate-spin text-indigo-600" size={16} />
                        <span>Querying database...</span>
                      </div>
                    </td>
                  </tr>
                )}
                {!loading && rows.length === 0 && (
                  <tr>
                    <td colSpan="11" className="text-center py-12 text-gray-400">
                      No Client Snags found. Click "New Client Snag" or reset filters.
                    </td>
                  </tr>
                )}
                {rows.map(r => (
                  <tr key={r.id} className="hover:bg-gray-50/80 transition">
                    <td className="font-bold text-red-700 text-xs">{r.snag_no}</td>
                    <td className="text-xs">{r.client_name || '—'}</td>
                    <td className="text-xs">{r.assigned_to_user_name || r.assigned_to_name || <span className="text-gray-300">—</span>}</td>
                    <td>
                      {r.before_photo_url ? (
                        <a href={r.before_photo_url} target="_blank" rel="noreferrer">
                          <img src={r.before_photo_url} alt="" width="48" height="48" loading="lazy" className="w-12 h-12 object-cover rounded" />
                        </a>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                    <td className="text-xs">{r.raised_at ? fmtDate(r.raised_at) : '—'}</td>
                    <td>
                      {r.photo_url ? (
                        <a href={r.photo_url} target="_blank" rel="noreferrer">
                          <img src={r.photo_url} alt="" width="48" height="48" loading="lazy" className="w-12 h-12 object-cover rounded ring-2 ring-emerald-400" />
                        </a>
                      ) : <span className="text-gray-300 text-xs">—</span>}
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
                    <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${LEGACY_STATUS_PILL[r.status] || ''}`}>{LEGACY_STATUS_LABEL[r.status] || r.status}</span></td>
                    <td className="whitespace-nowrap text-right pr-4 min-w-[120px]">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => openDetail(r.id)} className="btn btn-secondary text-[10px] px-2 py-1">View</button>
                        {canDelete('client_snag') && (
                          <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={12} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Server-side Pagination Bar */}
        <Pagination
          pg={{
            page,
            pages,
            perPage: limit === 'all' ? Math.max(total, 1) : limit,
            total,
            from: paginationFrom,
            to: paginationTo,
            setPage: (p) => updateFilter({ page: p }),
            hasPrev: page > 1,
            hasNext: page < pages,
          }}
          setPerPage={(newLimit) => updateFilter({ limit: newLimit, page: 1 })}
          perPageOptions={[15, 50, 100, 'all']}
          className="border-t border-gray-100 bg-gray-50/60 px-4 py-2"
        />
      </div>

      {/* CREATE MODAL */}
      <Modal
        isOpen={createModal}
        onClose={() => { createAttemptRef.current += 1; setCreateModal(false); setForm({}); }}
        title={activeTab === 'site_readiness' ? '🏗️ Log Pending Client Civil Work (Plaster / Tiles / etc.)' : '📄 New Client Snag (Billing / Document)'}
        wide
      >
        <form onSubmit={create} className="space-y-4">
          {activeTab === 'site_readiness' ? (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {/* Site Select from Sites Master */}
              <div>
                <label className="label">Site Name *</label>
                <SearchableSelect
                  options={sites.map(s => ({ ...s, label: `${s.name}${s.company_name ? ' (' + s.company_name + ')' : ''}` }))}
                  value={form.site_id || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Select site / project…"
                  onChange={handleSiteSelect}
                />
              </div>

              {/* Client Name (auto-populated or manual) */}
              <div>
                <label className="label">Client Name *</label>
                <input
                  className="input"
                  required
                  value={form.client_name || ''}
                  onChange={e => setForm(f => ({ ...f, client_name: e.target.value }))}
                  placeholder="Client / Company name"
                />
              </div>

              {/* Civil Scope Category */}
              <div>
                <label className="label">Civil Scope Left *</label>
                <select
                  className="select"
                  required
                  value={form.scope_category || ''}
                  onChange={e => setForm(f => ({ ...f, scope_category: e.target.value }))}
                >
                  {SCOPE_CATEGORIES.map(c => (
                    <option key={c.id} value={c.id}>{c.icon} {c.label}</option>
                  ))}
                </select>
              </div>

              {/* Floor / Zone */}
              <div>
                <label className="label">Floor / Zone *</label>
                <select
                  className="select"
                  required
                  value={form.floor_zone || ''}
                  onChange={e => setForm(f => ({ ...f, floor_zone: e.target.value }))}
                >
                  {FLOOR_ZONES.map(z => (
                    <option key={z} value={z}>{z}</option>
                  ))}
                </select>
              </div>

              {/* Specific Location details */}
              <div className="col-span-2">
                <label className="label">Specific Location / Room Details (optional)</label>
                <input
                  className="input"
                  value={form.location || ''}
                  onChange={e => setForm(f => ({ ...f, location: e.target.value }))}
                  placeholder="e.g. West corridor, Pump room pedestal area, Flat 204 bathroom"
                />
              </div>

              {/* Description */}
              <div className="col-span-2">
                <label className="label">Work Pending Description *</label>
                <textarea
                  className="input"
                  rows="3"
                  required
                  value={form.description || ''}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Describe what client civil work is pending and why SEPL installation cannot proceed (e.g. Wall plaster not done, hydrant pipe clamping stopped)."
                />
              </div>

              {/* Client Promised Date (optional at raise time) */}
              <div>
                <label className="label">Client Promised Date (if committed)</label>
                <input
                  type="date"
                  className="input"
                  value={form.client_promised_date || ''}
                  onChange={e => setForm(f => ({ ...f, client_promised_date: e.target.value }))}
                />
              </div>

              {/* Priority */}
              <div>
                <label className="label">Installation Impact Priority *</label>
                <select
                  className="select"
                  required
                  value={form.priority || 'medium'}
                  onChange={e => setForm(f => ({ ...f, priority: e.target.value }))}
                >
                  <option value="low">Low — Alternate areas available</option>
                  <option value="medium">Medium — Work progress slowed</option>
                  <option value="high">High — Work on floor stopped</option>
                  <option value="critical">Critical — Entire site labour idle</option>
                </select>
              </div>
            </div>
          ) : (
            /* Legacy Billing Snag Form */
            <div className="grid grid-cols-2 gap-3">
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
              <div className="col-span-2">
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
          )}

          {/* Mandatory Before Photo */}
          <div>
            <label className="label">
              Before Photo (Mandatory Proof of Incomplete Civil Work) *
            </label>
            {form.before_photo_url ? (
              <div className="flex items-start gap-3 bg-gray-50 p-2.5 rounded-lg border">
                <img src={form.before_photo_url} alt="" width="96" height="96" className="w-24 h-24 object-cover rounded border" />
                <div className="text-xs text-gray-500">
                  <div className="font-medium text-gray-700">Photo Attached</div>
                  <div>Uploaded: {form.before_photo_url_at_preview ? fmtDateTime(form.before_photo_url_at_preview) : 'Just now'}</div>
                  <button type="button" onClick={() => setForm(f => ({ ...f, before_photo_url: '', before_photo_url_at_preview: null }))} className="text-red-600 font-semibold mt-1">Remove &amp; Re-upload</button>
                </div>
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-2">
                <label className="cursor-pointer border-2 border-indigo-200 hover:border-indigo-400 bg-indigo-50/60 rounded-lg p-3 text-center transition flex items-center justify-center gap-1.5">
                  <span className="text-indigo-700 font-semibold text-sm">📷 Take Site Photo</span>
                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => { await uploadForCreate('before_photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                </label>
                <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-3 text-center transition flex items-center justify-center gap-1.5">
                  <span className="text-gray-700 font-semibold text-sm">📂 Upload Image File</span>
                  <input type="file" accept="image/*" className="hidden" onChange={async e => { await uploadForCreate('before_photo_url', e.target.files?.[0]); e.target.value = ''; }} />
                </label>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t">
            <button type="button" onClick={() => { setCreateModal(false); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploading} className="btn btn-primary">
              {uploading ? 'Uploading…' : activeTab === 'site_readiness' ? 'Log Site Blocker' : 'Create Snag'}
            </button>
          </div>
        </form>
      </Modal>

      {/* FMS STEP 2: INTIMATE TO CLIENT & COMMITMENT MODAL */}
      <Modal
        isOpen={!!intimateModal}
        onClose={() => setIntimateModal(null)}
        title="📅 FMS Step 2 · Client Intimation & Promised Date"
      >
        {intimateModal && (
          <form onSubmit={submitIntimation} className="space-y-3">
            <div className="bg-gray-50 p-3 rounded text-xs space-y-1">
              <div><strong>Site:</strong> {intimateModal.site_name} · <strong>Area:</strong> {intimateModal.floor_zone}</div>
              <div><strong>Pending Work:</strong> {intimateModal.scope_category}</div>
              <div className="text-gray-600">{intimateModal.description}</div>
            </div>

            <div>
              <label className="label">Client Committed Clearance Date *</label>
              <input
                type="date"
                required
                className="input"
                value={intimateForm.client_promised_date || ''}
                onChange={e => setIntimateForm(f => ({ ...f, client_promised_date: e.target.value }))}
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div>
                <label className="label">Client Contact Person</label>
                <input
                  className="input"
                  value={intimateForm.client_contact_person || ''}
                  onChange={e => setIntimateForm(f => ({ ...f, client_contact_person: e.target.value }))}
                  placeholder="e.g. Er. Sharma (Civil Head)"
                />
              </div>
              <div>
                <label className="label">Phone / WhatsApp</label>
                <input
                  className="input"
                  value={intimateForm.client_contact_phone || ''}
                  onChange={e => setIntimateForm(f => ({ ...f, client_contact_phone: e.target.value }))}
                  placeholder="98765..."
                />
              </div>
            </div>

            <div>
              <label className="label">Discussion / Intimation Notes</label>
              <textarea
                className="input"
                rows="2"
                value={intimateForm.intimation_notes || ''}
                onChange={e => setIntimateForm(f => ({ ...f, intimation_notes: e.target.value }))}
                placeholder="e.g. Spoke with client site manager. Tiles promised to be laid by this date. Shared photos."
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => setIntimateModal(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">Save Commitment</button>
            </div>
          </form>
        )}
      </Modal>

      {/* FMS STEP 4: VERIFY & CLEAR MODAL */}
      <Modal
        isOpen={!!clearanceModal}
        onClose={() => setClearanceModal(null)}
        title="✅ FMS Step 4 · Verify Finished Civil Scope & Mark Cleared"
      >
        {clearanceModal && (
          <form onSubmit={submitClearance} className="space-y-4">
            <div className="bg-emerald-50 border border-emerald-200 p-3 rounded text-xs space-y-1 text-emerald-900">
              <div className="font-semibold text-sm">Clearance Verification</div>
              <div><strong>Site:</strong> {clearanceModal.site_name} ({clearanceModal.floor_zone})</div>
              <div><strong>Scope:</strong> {clearanceModal.scope_category}</div>
            </div>

            <div>
              <label className="label">
                Clearance Verification Photo (Mandatory Proof of Completed Civil Work) *
              </label>
              {clearanceForm.cleared_photo_url ? (
                <div className="flex items-start gap-3 bg-gray-50 p-2.5 rounded border">
                  <img src={clearanceForm.cleared_photo_url} alt="Cleared" width="96" height="96" className="w-24 h-24 object-cover rounded ring-2 ring-emerald-500" />
                  <div className="text-xs text-gray-500">
                    <div className="font-semibold text-emerald-700">Verification Photo Attached</div>
                    <button type="button" onClick={() => setClearanceForm(f => ({ ...f, cleared_photo_url: '' }))} className="text-red-600 font-medium mt-1">Remove &amp; Re-take</button>
                  </div>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-emerald-200 hover:border-emerald-400 bg-emerald-50/60 rounded-lg p-3 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-emerald-800 font-semibold text-sm">📷 Take Verification Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => { const url = await upload(e.target.files?.[0]); if (url) setClearanceForm(f => ({ ...f, cleared_photo_url: url })); e.target.value = ''; }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-3 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Upload Photo</span>
                    <input type="file" accept="image/*" className="hidden" onChange={async e => { const url = await upload(e.target.files?.[0]); if (url) setClearanceForm(f => ({ ...f, cleared_photo_url: url })); e.target.value = ''; }} />
                  </label>
                </div>
              )}
            </div>

            <div>
              <label className="label">Verification Notes</label>
              <textarea
                className="input"
                rows="2"
                value={clearanceForm.notes || ''}
                onChange={e => setClearanceForm(f => ({ ...f, notes: e.target.value }))}
                placeholder="e.g. Inspected on site. Wall plaster completed and cured. Cleared for piping installation."
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => setClearanceModal(null)} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={!clearanceForm.cleared_photo_url} className="btn btn-success">
                Mark as Cleared
              </button>
            </div>
          </form>
        )}
      </Modal>

      {/* FORMAL CLIENT NOTICE MODAL */}
      <Modal
        isOpen={!!noticeModal}
        onClose={() => setNoticeModal(null)}
        title="📢 Formal Site Readiness Memo / Client Notice"
        wide
      >
        {noticeModal && (
          <div className="space-y-4">
            <div className="flex justify-end gap-2">
              <button
                onClick={copyNoticeToClipboard}
                className="btn btn-primary flex items-center gap-1.5 text-xs"
              >
                {copiedNotice ? <FiCheck size={14} /> : <FiCopy size={14} />}
                {copiedNotice ? 'Copied to Clipboard!' : 'Copy for WhatsApp / Email'}
              </button>
              <button
                onClick={() => window.print()}
                className="btn btn-secondary flex items-center gap-1.5 text-xs"
              >
                <FiPrinter size={14} /> Print Memo
              </button>
            </div>

            {/* Printable Memo Paper */}
            <div className="border border-gray-300 rounded-lg p-6 bg-white shadow-sm space-y-4 text-gray-800 text-xs">
              <div className="border-b pb-3 flex justify-between items-start">
                <div>
                  <h2 className="text-base font-bold text-gray-900 tracking-wide">SECURED ENGINEERS PVT. LTD.</h2>
                  <p className="text-[11px] text-gray-500">Fire Protection · Solar · MEPF Contracting Systems</p>
                </div>
                <div className="text-right text-[11px] text-gray-500">
                  <div><strong>Ref:</strong> {noticeModal.snag_no}</div>
                  <div><strong>Date:</strong> {fmtDate(noticeModal.raised_at || new Date())}</div>
                </div>
              </div>

              <div className="bg-amber-50/80 border border-amber-200 rounded p-2 text-center font-bold text-amber-900 uppercase tracking-wider text-xs">
                MEMORANDUM: SITE READINESS &amp; PENDING CLIENT CIVIL SCOPE
              </div>

              <div className="grid grid-cols-2 gap-3 bg-gray-50 p-3 rounded border">
                <div><strong>Project / Site:</strong> {noticeModal.site_name}</div>
                <div><strong>Client:</strong> {noticeModal.client_name}</div>
                <div><strong>Floor / Zone:</strong> {noticeModal.floor_zone} {noticeModal.location ? `(${noticeModal.location})` : ''}</div>
                <div><strong>Civil Work Left:</strong> <span className="font-bold text-indigo-800">{noticeModal.scope_category}</span></div>
                <div><strong>Client Promised Date:</strong> {noticeModal.client_promised_date ? fmtDate(noticeModal.client_promised_date) : 'Pending Confirmation'}</div>
                <div>
                  <strong>Status:</strong>{' '}
                  {noticeModal.days_overdue > 0 ? (
                    <span className="text-red-700 font-bold">⚠️ OVERDUE by {noticeModal.days_overdue} days</span>
                  ) : (
                    <span className="text-amber-700 font-medium">Awaiting Civil Handover</span>
                  )}
                </div>
              </div>

              <div>
                <strong>Scope Description / Site Observation:</strong>
                <p className="mt-1 p-2 bg-gray-50 rounded border text-gray-700">{noticeModal.description}</p>
              </div>

              <div className="p-3 bg-red-50/80 border border-red-200 rounded text-red-900 text-[11px] leading-relaxed">
                <strong>Important Notice to Client / Project Management Consultant (PMC):</strong>
                <p className="mt-0.5">
                  Please be advised that MEPF / Fire Protection installation work at the above referenced location is currently suspended / blocked due to pending civil prerequisites (e.g. wall/ceiling plaster, flooring, pedestals). In accordance with contracting standards, continued delay in handing over clear civil work will directly affect project handover milestones. Kindly expedite clearance.
                </p>
              </div>

              {noticeModal.before_photo_url && (
                <div>
                  <strong>Site Photographic Evidence:</strong>
                  <div className="mt-1.5 flex gap-3">
                    <div>
                      <img
                        src={noticeModal.before_photo_url}
                        alt="Site Condition"
                        width="160"
                        height="160"
                        className="w-40 h-40 object-cover rounded border"
                      />
                      <div className="text-[10px] text-gray-500 mt-1">Observed Condition at Site</div>
                    </div>
                    {noticeModal.cleared_photo_url && (
                      <div>
                        <img
                          src={noticeModal.cleared_photo_url}
                          alt="Cleared Condition"
                          width="160"
                          height="160"
                          className="w-40 h-40 object-cover rounded border ring-2 ring-emerald-500"
                        />
                        <div className="text-[10px] text-emerald-700 font-semibold mt-1">Verified Cleared Condition</div>
                      </div>
                    )}
                  </div>
                </div>
              )}

              <div className="pt-4 border-t flex justify-between text-[11px] text-gray-500">
                <div>Reported by: SEPL Site Engineering Team</div>
                <div>Secured Engineers Pvt. Ltd.</div>
              </div>
            </div>
          </div>
        )}
      </Modal>

      {/* DETAIL MODAL */}
      <Modal isOpen={!!detail} onClose={() => { setDetail(null); detailIdRef.current = null; }} title={detail ? `${detail.snag_no}` : ''} wide>
        {detail && (
          <div className="space-y-4">
            <div className="bg-gray-50 p-3 rounded text-sm grid grid-cols-1 sm:grid-cols-2 gap-2 border">
              <div><span className="text-gray-500">Client:</span> <span className="font-medium">{detail.client_name || '—'}</span></div>
              <div><span className="text-gray-500">Site:</span> <span className="font-medium">{detail.site_name || '—'}</span></div>
              <div><span className="text-gray-500">Floor / Zone:</span> <span className="font-medium">{detail.floor_zone || detail.location || '—'}</span></div>
              <div><span className="text-gray-500">Scope Type:</span> <span className="font-bold text-indigo-700">{detail.scope_category || detail.snag_type || '—'}</span></div>
              <div><span className="text-gray-500">Priority:</span> <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[detail.priority] || ''}`}>{detail.priority}</span></div>
              <div><span className="text-gray-500">Stage / Status:</span> <span className="font-semibold">{detail.fms_stage || detail.status}</span></div>
              {detail.client_promised_date && (
                <div><span className="text-gray-500">Promised Date:</span> <span className="font-medium text-blue-700">{fmtDate(detail.client_promised_date)}</span></div>
              )}
              {detail.days_overdue > 0 && (
                <div><span className="text-red-600 font-bold">⚠️ Overdue by {detail.days_overdue} days</span></div>
              )}
              <div className="col-span-1 sm:col-span-2"><span className="text-gray-500">Description:</span> {detail.description}</div>
              <div className="col-span-1 sm:col-span-2 text-xs text-gray-400">Raised: {detail.raised_at ? fmtDateTime(detail.raised_at) : '—'} {detail.raised_by_name ? `by ${detail.raised_by_name}` : ''}</div>
            </div>

            {/* Photos */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label font-semibold">Before Photo (Incomplete Work)</label>
                {detail.before_photo_url ? (
                  <a href={detail.before_photo_url} target="_blank" rel="noreferrer">
                    <img src={detail.before_photo_url} alt="Before" width="160" height="160" className="w-44 h-44 object-cover rounded border hover:opacity-90" />
                  </a>
                ) : (
                  <div className="text-xs text-gray-400">No before photo uploaded.</div>
                )}
              </div>

              <div>
                <label className="label font-semibold">Clearance / After Photo</label>
                {detail.cleared_photo_url || detail.photo_url ? (
                  <a href={detail.cleared_photo_url || detail.photo_url} target="_blank" rel="noreferrer">
                    <img src={detail.cleared_photo_url || detail.photo_url} alt="Cleared" width="160" height="160" className="w-44 h-44 object-cover rounded ring-2 ring-emerald-500 hover:opacity-90" />
                  </a>
                ) : (
                  <div className="text-xs text-gray-400">Civil work pending clearance.</div>
                )}
              </div>
            </div>

            {/* Legacy Ajmer / Lovely Gates for billing snags */}
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

            {detail.can_approve_this && (
              <div className="border-t pt-3 flex gap-2">
                <button onClick={() => setApproveFor(detail.id)} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={14} /> Approve</button>
                <button onClick={() => { setRejectFor(detail.id); setRejectReason(''); }} className="btn btn-danger flex items-center gap-1"><FiXCircle size={14} /> Reject</button>
              </div>
            )}

            {/* Activity History */}
            <div className="border-t pt-3">
              <div className="text-xs font-semibold text-gray-700 mb-1">FMS Audit Trail &amp; History</div>
              <div className="space-y-1 max-h-40 overflow-y-auto border rounded p-2 bg-gray-50">
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

      {/* APPROVE CONFIRM MODAL (Legacy) */}
      <Modal isOpen={!!approveFor} onClose={() => setApproveFor(null)} title="Approve Client Snag?">
        <div className="space-y-3">
          <p className="text-sm text-gray-600">Are you sure you want to approve this Client Snag?</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setApproveFor(null)} className="btn btn-secondary">Cancel</button>
            <button onClick={doApprove} className="btn btn-success">Approve</button>
          </div>
        </div>
      </Modal>

      {/* REJECT MODAL (Legacy) */}
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

      {/* ADMIN REASSIGN PANEL (Legacy) */}
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
