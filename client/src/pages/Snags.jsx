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
import Pagination from '../components/Pagination';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiAlertTriangle, FiCheckCircle, FiXCircle, FiUploadCloud, FiTrash2,
  FiEdit2, FiSearch, FiDownload, FiCamera, FiLayers, FiUsers, FiLock, FiUnlock,
  FiPrinter, FiClock, FiShield, FiFileText, FiCheck, FiChevronRight, FiChevronDown, FiChevronUp, FiCalendar
} from 'react-icons/fi';
import HandoverRaciModal from '../components/HandoverRaciModal';
import HandoverCertificateModal from '../components/HandoverCertificateModal';
import { StartHandoverModal, ClientWalkModal, GenerateCertificateModal } from '../components/HandoverWorkflowModals';
import { fmtDate } from '../utils/datetime';
import { compressImage } from '../utils/compressImage';

const toThumb = (url, w = 120) => {
  if (!url || typeof url !== 'string' || !url.startsWith('/uploads/')) return url;
  if (/\.pdf$/i.test(url)) return url;
  return `/api/thumbnail?url=${encodeURIComponent(url)}&w=${w}`;
};

// ── Ageing helpers ──────────────────────────────────────────────────────────
// Target: every open/submitted snag must be resolved within 72 hours of being
// raised. Returns { hours, label, cls } for the badge.
const SLA_HOURS = 72;
function snagAge(raised_at) {
  if (!raised_at) return null;
  const hours = (Date.now() - new Date(raised_at).getTime()) / 3600000;
  const h = Math.floor(hours);
  const days = Math.floor(h / 24);
  const rem = h % 24;
  const label = days > 0 ? `${days}d ${rem}h` : `${h}h`;
  if (hours < 24) return { hours, label, cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' };
  if (hours < SLA_HOURS) return { hours, label, cls: 'bg-amber-50 text-amber-700 border-amber-200' };
  return { hours, label: `${label} ⚠`, cls: 'bg-red-50 text-red-700 border-red-300 font-bold' };
}
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

// Common site defect presets for 1-tap entry during site walks
const COMMON_DEFECTS = [
  { label: '⚡ Earthing / Cable', text: 'Earthing missing / loose cable termination' },
  { label: '🔧 Pipe Clamping', text: 'Pipe clamping / support loose or missing' },
  { label: '📏 Alignment / Level', text: 'Equipment alignment / leveling required' },
  { label: '🎨 Paint / Touch-up', text: 'Surface scratch / paint touch-up required' },
  { label: '🏷️ Label / Ferrule', text: 'Identification label / ferrule missing' },
  { label: '🧹 Cleanliness', text: 'Debris / construction scrap clearance needed' },
  { label: '💧 Leakage / Seepage', text: 'Leakage / pressure drop observed' },
  { label: '🚪 Fire Seal', text: 'Fire barrier penetration / seal incomplete' },
];

function defaultTargetDate() {
  const d = new Date();
  d.setDate(d.getDate() + 3);
  return d.toISOString().slice(0, 10);
}

export default function Snags() {
  const { canCreate, canEdit, canDelete, canApprove, isAdmin, user } = useAuth();
  const [snags, setSnags] = useState([]);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [filters, setFilters] = useState({ status: '', priority: '', search: '', scope: '', site_id: '', due_from: '', due_to: '' });
  const [searchInput, setSearchInput] = useState('');
  const [modal, setModal] = useState(false);          // raise/edit
  const [snagMode, setSnagMode] = useState('single'); // 'single' | 'walk'
  const [walkItems, setWalkItems] = useState([]);     // items for multi-photo snag walk
  const [proofModal, setProofModal] = useState(null); // snag obj being submitted
  // Which snag's proof modal is actually open right now — checked before an
  // in-flight upload is allowed to write into proofForm (mam 2026-08-24:
  // "sometimes wrong upload" — switching snags mid-upload used to let a
  // stale file land on whatever snag is open when the upload finishes).
  const proofModalIdRef = useRef(null);
  const [proofForm, setProofForm] = useState({});
  const [form, setForm] = useState({});
  const [editingId, setEditingId] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [, setAgeingTick] = useState(0);
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(15);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [serverStats, setServerStats] = useState(null);
  const [, setLoading] = useState(false);
  const scrollBoxRef = useRef(null);   // the table's own overflow container

  // SOP-15 Handover & Snags Pipeline State
  const [raci, setRaci] = useState(null);
  const [raciOpen, setRaciOpen] = useState(false);
  const [handoverSiteId, setHandoverSiteId] = useState('');
  const [handoverData, setHandoverData] = useState(null);
  const [startHandoverOpen, setStartHandoverOpen] = useState(false);
  const [clientWalkOpen, setClientWalkOpen] = useState(false);
  const [generateCertOpen, setGenerateCertOpen] = useState(false);
  const [viewCert, setViewCert] = useState(null);
  const [escalationsModalOpen, setEscalationsModalOpen] = useState(false);
  const [escalationsList, setEscalationsList] = useState([]);
  const [sop15Expanded, setSop15Expanded] = useState(true);

  const loadRaci = useCallback(() => {
    api.get('/snags/sop15/raci').then(r => setRaci(r.data.raci)).catch(() => { });
  }, []);

  const loadHandoverStatus = useCallback((siteId) => {
    if (!siteId) { setHandoverData(null); return; }
    api.get(`/snags/sop15/site-status/${siteId}`)
      .then(r => setHandoverData(r.data))
      .catch(() => { });
  }, []);

  useEffect(() => { loadRaci(); }, [loadRaci]);

  useEffect(() => {
    if (filters.site_id && filters.site_id !== handoverSiteId) {
      setHandoverSiteId(filters.site_id);
      loadHandoverStatus(filters.site_id);
    }
  }, [filters.site_id, handoverSiteId, loadHandoverStatus]);

  const onSelectHandoverSite = (sid) => {
    setHandoverSiteId(sid);
    loadHandoverStatus(sid);
    if (sid) setFilters(f => ({ ...f, site_id: sid }));
  };

  const handleClientTick = async (s) => {
    try {
      await api.post(`/snags/sop15/client-tick/${s.id}`);
      toast.success(`Snag ${s.snag_no} verified and client-ticked (SOP-15.4)`);
      load();
      if (handoverSiteId) loadHandoverStatus(handoverSiteId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to client tick');
    }
  };

  const handleViewEscalations = async () => {
    try {
      const res = await api.get('/snags/sop15/escalations', {
        params: handoverSiteId ? { site_id: handoverSiteId } : {}
      });
      setEscalationsList(res.data.escalations || []);
      setEscalationsModalOpen(true);
    } catch (_) {
      toast.error('Failed to load escalations');
    }
  };

  // 500ms debounced search input sync with filters.search
  useEffect(() => {
    const timer = setTimeout(() => {
      setFilters(f => {
        if (f.search === searchInput) return f;
        return { ...f, search: searchInput };
      });
    }, 500);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const load = useCallback(() => {
    setLoading(true);
    const params = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
    params.set('page', String(page));
    params.set('limit', String(perPage));

    api.get(`/snags?${params}`)
      .then(r => {
        const data = r.data;
        if (data && typeof data === 'object' && Array.isArray(data.rows)) {
          setSnags(data.rows);
          setTotal(data.total || 0);
          setTotalPages(data.pages || 1);
          if (data.stats) setServerStats(data.stats);
        } else if (Array.isArray(data)) {
          setSnags(data);
          setTotal(data.length);
          setTotalPages(1);
        }
      })
      .catch(() => { })
      .finally(() => setLoading(false));
  }, [filters, page, perPage]);

  // Derived stats: prefer server-calculated stats across entire filtered dataset
  const stats = serverStats || {
    total,
    open: 0,
    submitted: 0,
    approved: 0,
    rejected: 0,
    critical: 0,
    overdue: 0,
  };

  // Re-render ageing badges and the overdue counter while the page stays open.
  useEffect(() => {
    const timer = setInterval(() => setAgeingTick(tick => tick + 1), 60000);
    return () => clearInterval(timer);
  }, []);

  // Server-side pagination object for <Pagination />
  const pg = useMemo(() => {
    const isAll = perPage === 'all';
    const size = isAll ? Math.max(total, 1) : perPage;
    const cur = Math.min(Math.max(1, page), totalPages);
    const from = total === 0 ? 0 : (cur - 1) * size;
    const to = Math.min(from + size, total);
    return {
      page: cur,
      pages: totalPages,
      perPage: size,
      isAll,
      total,
      from,
      to,
      setPage,
      rows: snags,
      hasPrev: cur > 1,
      hasNext: cur < totalPages,
    };
  }, [page, totalPages, perPage, total, snags]);

  useEffect(() => { setPage(1); }, [filters]);
  useEffect(() => {
    scrollBoxRef.current?.scrollTo({ top: 0 });
  }, [page, perPage, filters]);

  // Export the (filtered) snag list as a real .xlsx WITH the defect + proof
  // photos embedded. CSV can't carry images, so this hits the server which
  // builds the workbook; filters mirror the on-screen list.
  const exportXlsx = async (photos = true) => {
    if (total === 0 && snags.length === 0) { toast.error('No data to export'); return; }
    try {
      const params = new URLSearchParams();
      Object.entries(filters).forEach(([k, v]) => v && params.set(k, v));
      if (!photos) params.set('photos', '0');
      const resp = await api.get(`/snags/export.xlsx?${params}`, { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `snags-${new Date().toISOString().slice(0, 10)}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const skipped = Number(resp.headers?.['x-photos-skipped'] || 0);
      if (skipped) toast.success(`Downloaded — ${skipped} photo(s) too large to embed, link in the cell instead`);
      else toast.success(photos ? 'Downloaded snags with photos' : 'Downloaded snags (no photos)');
    } catch (e) {
      // responseType 'blob' means an error body arrives as a Blob, not JSON —
      // reading it is the only way to see what the server actually said.
      // Without this the user just got "Export failed" with no clue why.
      let msg = '';
      try {
        if (e.response?.data instanceof Blob) msg = JSON.parse(await e.response.data.text())?.error || '';
        else msg = e.response?.data?.error || '';
      } catch { /* not JSON — fall through to the generic message */ }
      if (photos) {
        toast.error(msg ? `Export failed: ${msg} — retrying without photos` : 'Export failed — retrying without photos');
        return exportXlsx(false);
      }
      toast.error(msg ? `Export failed: ${msg}` : 'Export failed');
    }
  };

  useEffect(() => {
    load();
    api.get('/dpr/sites?all=1').then(r => setSites(r.data || [])).catch(() => { });
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => { });
  }, [load]);

  const upload = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const toSend = file.type?.startsWith('image/') ? await compressImage(file) : file;
      const fd = new FormData();
      fd.append('file', toSend);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch (err) {
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
      return null;
    } finally { setUploading(false); }
  };

  const openRaise = () => {
    setEditingId(null);
    setSnagMode('single');
    setWalkItems([]);
    const preselectedSite = filters.site_id ? sites.find(s => String(s.id) === String(filters.site_id)) : null;
    setForm({
      site_id: preselectedSite?.id || '',
      site_name: preselectedSite?.name || '',
      location: '',
      description: '',
      photo_url: '',
      priority: 'medium',
      assigned_to: preselectedSite?.site_engineer_id || '',
      assigned_to_name: preselectedSite?.engineer_name || '',
      target_date: defaultTargetDate(),
    });
    setModal(true);
  };

  const openEdit = (s) => {
    setEditingId(s.id);
    setSnagMode('single');
    setWalkItems([]);
    setForm({
      site_id: s.site_id || '',
      site_name: s.site_name || '',
      location: s.location || '',
      description: s.description || '',
      photo_url: s.photo_url || '',
      priority: s.priority || 'medium',
      assigned_to: s.assigned_to || '',
      assigned_to_name: s.assigned_to_name || '',
      // Date input needs bare YYYY-MM-DD — imported rows may carry a timestamp.
      target_date: (s.target_date || '').slice(0, 10),
    });
    setModal(true);
  };

  const save = async (e, addNext = false) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!form.description?.trim()) return toast.error('Description is required');
    try {
      if (editingId) {
        // Clearing the date stores NULL, not '' — and the snag number is
        // never sent, so editing can never change it (server allowlist too).
        await api.put(`/snags/${editingId}`, { ...form, target_date: form.target_date || null });
        toast.success('Snag updated');
        setModal(false); setForm({}); setEditingId(null); load();
      } else {
        const r = await api.post('/snags', form);
        toast.success(`Raised ${r.data.snag_no}`);
        if (addNext) {
          // Keep site, location, assignee, priority, target_date!
          // Clear description and photo_url for immediate next point
          setForm(f => ({
            ...f,
            description: '',
            photo_url: '',
          }));
          load();
        } else {
          setModal(false); setForm({}); setEditingId(null); load();
        }
      }
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Snag Walk: multi-photo batch handler
  const handleWalkPhotos = async (files) => {
    if (!files || files.length === 0) return;
    const fileList = Array.from(files);
    const newItems = fileList.map((file, idx) => ({
      id: `${Date.now()}_${idx}_${Math.random().toString(36).slice(2, 7)}`,
      file,
      photo_url: '',
      location: form.location || '',
      description: '',
      priority: form.priority || 'medium',
      uploading: true,
    }));
    setWalkItems(prev => [...prev, ...newItems]);

    for (const it of newItems) {
      const url = await upload(it.file);
      setWalkItems(prev => prev.map(p => p.id === it.id ? { ...p, photo_url: url || '', uploading: false } : p));
    }
  };

  const saveWalk = async (e) => {
    if (e && e.preventDefault) e.preventDefault();
    if (!walkItems || walkItems.length === 0) {
      return toast.error('Please add at least one photo / snag item');
    }
    const emptyDesc = walkItems.some(it => !it.description?.trim());
    if (emptyDesc) {
      return toast.error('Please enter a description for all snag items');
    }
    const isStillUploading = walkItems.some(it => it.uploading);
    if (isStillUploading) {
      return toast.error('Photos are still uploading, please wait a moment');
    }
    try {
      setUploading(true);
      const r = await api.post('/snags/batch', {
        site_id: form.site_id || null,
        site_name: form.site_name || null,
        assigned_to: form.assigned_to || null,
        assigned_to_name: form.assigned_to_name || null,
        priority: form.priority || 'medium',
        target_date: form.target_date || null,
        items: walkItems.map(it => ({
          location: it.location || form.location || null,
          description: it.description,
          photo_url: it.photo_url || null,
          priority: it.priority || form.priority || 'medium',
          target_date: it.target_date || form.target_date || null,
        })),
      });
      toast.success(`Raised ${r.data.count} snags successfully!`);
      setModal(false); setForm({}); setWalkItems([]); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to raise batch snags');
    } finally {
      setUploading(false);
    }
  };

  const submitProof = async (e) => {
    e.preventDefault();
    if (!proofForm.proof_url) return toast.error('Please upload the proof photo');
    try {
      await api.post(`/snags/${proofModal.id}/submit`, proofForm);
      toast.success('Proof submitted — awaiting approval');
      setProofModal(null); proofModalIdRef.current = null; setProofForm({}); load();
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

  // Target-date overdue check on the India calendar (target dates are stored
  // as bare YYYY-MM-DD strings from the date picker).
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const isOverdue = (s) => s.target_date && s.status !== 'approved' && String(s.target_date).slice(0, 10) < todayIST;

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiAlertTriangle className="text-red-600" /> Snag List</h1>
          <p className="text-sm text-gray-500">Management raises site snags · assignee uploads proof · raiser approves to close.</p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setRaciOpen(true)}
            className="btn btn-secondary flex items-center gap-1.5 text-sm"
            title="View or Configure SOP-15 Roles & Delegation"
          >
            <FiUsers size={14} className="text-slate-600" /> Roles (RACI)
          </button>
          <button onClick={() => exportXlsx(true)}
            className="btn btn-secondary flex items-center gap-1 text-sm"><FiDownload size={14} /> Export Excel</button>
          {canCreate('snags') && (
            <button onClick={openRaise} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Raise Snag</button>
          )}
        </div>
      </div>

      {/* ─── SOP-15: HANDOVER & SNAGS WORKFLOW PIPELINE ─────────────────── */}
      <div className="card p-4 bg-slate-900 text-white rounded-xl shadow-md space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">

            <span className="font-semibold text-sm text-slate-100">Handover &amp; Snags Pipeline</span>
            <span className="text-xs text-slate-400 hidden sm:inline">
              · Owner: <span className="text-slate-200 font-medium">{raci?.sop_owner?.assigned_name ? (raci.sop_owner.assigned_name.toLowerCase().includes('project manager') || raci.sop_owner.assigned_name.toLowerCase().includes('(pm)') ? raci.sop_owner.assigned_name : `Project Manager — ${raci.sop_owner.assigned_name}`) : 'Project Manager — Adarsh Kumar'}</span> ({[raci?.s1_cost_lock?.assigned_name, raci?.s2_snag_walk?.assigned_name, raci?.s4_client_tick?.assigned_name].filter(Boolean).join(' · ') || 'Site Eng · Lovely'})
            </span>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            {/* Site Selector for Handover */}
            <div className="w-56">
              <select
                className="select text-xs w-full bg-slate-800 text-slate-200 border-slate-700 py-1"
                value={handoverSiteId}
                onChange={e => onSelectHandoverSite(e.target.value)}
              >
                <option value="">— Select Site for Handover —</option>
                {sites.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            {/* Cost Lock Badge */}
            {handoverData?.site?.cost_locked === 1 ? (
              <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs px-2.5 py-1 rounded font-bold flex items-center gap-1" title="Costs Locked: No new indents allowed">
                <FiLock size={12} /> Costs Locked (S1)
              </span>
            ) : handoverSiteId ? (
              <span className="bg-slate-800 text-slate-400 border border-slate-700 text-xs px-2.5 py-1 rounded flex items-center gap-1">
                <FiUnlock size={12} /> Costs Open
              </span>
            ) : null}

            <button
              type="button"
              onClick={() => setSop15Expanded(e => !e)}
              className="text-slate-400 hover:text-white p-1 text-xs"
              title={sop15Expanded ? 'Collapse' : 'Expand'}
            >
              {sop15Expanded ? <FiChevronUp size={16} /> : <FiChevronDown size={16} />}
            </button>
          </div>
        </div>

        {sop15Expanded && (
          <div className="space-y-4">
            {/* 6-Step Stepper */}
            <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
              {[
                { key: 's1', num: 'S1', title: 'Work 100%', who: raci?.s1_cost_lock?.assigned_name || raci?.sop_owner?.assigned_name || 'Adarsh Kumar', desc: 'Costs Locked', done: handoverData?.site?.work_completed_100 === 1 },
                { key: 's2', num: 'S2', title: 'Snag Walk', who: raci?.s2_snag_walk?.assigned_name || 'Site Eng + Client', desc: handoverData?.site?.client_walk_date ? fmtDate(handoverData.site.client_walk_date) : 'Joint Client Walk', done: Boolean(handoverData?.site?.client_walk_date) },
                { key: 's3', num: 'S3', title: 'Snag Clock', who: raci?.s3_snag_clock?.assigned_name || raci?.sop_owner?.assigned_name || 'Adarsh Kumar (PM)', desc: `${handoverData?.snags_summary?.open || 0} open snags`, done: Boolean(handoverData?.snags_summary?.total > 0 && handoverData?.snags_summary?.open === 0) },
                { key: 's4', num: 'S4', title: 'Client Tick', who: raci?.s4_client_tick?.assigned_name || 'Lovely (CRM)', desc: `${handoverData?.snags_summary?.client_verified || 0} ticked`, done: Boolean(handoverData?.snags_summary?.total > 0 && handoverData?.snags_summary?.client_verified === handoverData?.snags_summary?.total) },
                { key: 's5', num: 'S5', title: 'Handover Cert', who: raci?.s5_handover_cert?.assigned_name || 'Lovely (CRM)', desc: handoverData?.certificate?.certificate_number || 'HC-YYYY-XXXX', done: Boolean(handoverData?.certificate) },
                { key: 's6', num: 'S6', title: 'Final Bill & Ret.', who: raci?.s6_retention_warranty?.assigned_name || 'Lovely (CRM)', desc: handoverData?.certificate?.status === 'signed' ? 'Active ✓' : 'Retention & Warranty', done: handoverData?.certificate?.status === 'signed' },
              ].map(st => (
                <div
                  key={st.key}
                  className={`p-2.5 rounded-lg border text-left transition-all ${st.done
                      ? 'bg-emerald-950/60 border-emerald-500/60 text-emerald-200'
                      : 'bg-slate-800/80 border-slate-700 text-slate-300'
                    }`}
                >
                  <div className="flex items-center justify-between text-[10px] font-bold uppercase mb-1">
                    <span className="font-mono text-red-400">{st.num}</span>
                    {st.done ? (
                      <span className="text-emerald-400 flex items-center gap-0.5">✓ Done</span>
                    ) : (
                      <span className="text-slate-500">Pending</span>
                    )}
                  </div>
                  <div className="font-semibold text-xs text-white truncate">{st.title}</div>
                  <div className="text-[10px] text-slate-400 truncate mt-0.5" title={st.who}>👤 {st.who}</div>
                  <div className="text-[10px] text-slate-500 truncate mt-0.5">{st.desc}</div>
                </div>
              ))}
            </div>

            {/* Contextual Action Bar for Selected Site */}
            {handoverSiteId ? (
              <div className="pt-2 border-t border-slate-800 flex items-center justify-between flex-wrap gap-3">
                <div className="text-xs text-slate-300 flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-white">Active Site: {handoverData?.site?.name}</span>
                  {handoverData?.site?.client_rep_name && (
                    <span className="text-slate-400">· Client Rep: {handoverData.site.client_rep_name}</span>
                  )}
                  {handoverData?.certificate && (
                    <span className="text-emerald-400 font-mono font-bold bg-emerald-950 px-2 py-0.5 rounded border border-emerald-800">
                      Cert: {handoverData.certificate.certificate_number} ({handoverData.certificate.status})
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                  {/* S1 Action */}
                  {handoverData?.site?.work_completed_100 !== 1 && (
                    <button
                      onClick={() => setStartHandoverOpen(true)}
                      className="btn btn-warning text-xs font-bold px-3 py-1.5 flex items-center gap-1.5 shadow-sm"
                    >
                      <FiLock size={13} /> Declare 100% Work &amp; Lock Costs (S1)
                    </button>
                  )}

                  {/* S2 Action */}
                  <button
                    onClick={() => setClientWalkOpen(true)}
                    className="btn btn-secondary text-xs font-semibold px-3 py-1.5 flex items-center gap-1.5 bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700"
                  >
                    <FiCalendar size={13} /> {handoverData?.site?.client_walk_date ? 'Update Client Walk (S2)' : 'Record Client Walk (S2)'}
                  </button>

                  {/* S3 Action: View Escalation Clock */}
                  <button
                    onClick={handleViewEscalations}
                    className="btn btn-secondary text-xs font-semibold px-3 py-1.5 flex items-center gap-1.5 bg-slate-800 text-slate-200 border-slate-700 hover:bg-slate-700"
                  >
                    <FiClock size={13} /> Snag Clock &amp; Escalations (S3)
                  </button>

                  {/* S5 Action: Generate Certificate */}
                  {!handoverData?.certificate && handoverData?.snags_summary?.total > 0 && handoverData?.snags_summary?.open === 0 && (
                    <button
                      onClick={() => setGenerateCertOpen(true)}
                      className="btn btn-primary text-xs font-bold px-3 py-1.5 flex items-center gap-1.5 shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                    >
                      <FiFileText size={13} /> Generate Handover Certificate (S5)
                    </button>
                  )}

                  {/* S5/S6 Action: View or Sign Certificate */}
                  {handoverData?.certificate && (
                    <button
                      onClick={() => setViewCert(handoverData.certificate)}
                      className="btn btn-success text-xs font-bold px-3 py-1.5 flex items-center gap-1.5 shadow-sm bg-emerald-600 hover:bg-emerald-700 text-white border-0"
                    >
                      <FiPrinter size={13} /> View / Sign Handover Certificate (S5 &amp; S6)
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div className="pt-2 border-t border-slate-800 text-xs text-slate-400">
                💡 Select a site from the dropdown above to view or update its SOP-15 Handover Pipeline.
              </div>
            )}
          </div>
        )}
      </div>

      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-6 gap-3">
          <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Open</p><p className="text-2xl font-bold text-amber-600">{stats.open}</p></div>
          <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Awaiting Approval</p><p className="text-2xl font-bold text-blue-600">{stats.submitted}</p></div>
          <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Approved</p><p className="text-2xl font-bold text-emerald-600">{stats.approved}</p></div>
          <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Critical Open</p><p className="text-2xl font-bold text-red-700">{stats.critical}</p></div>
          <div className={`card p-3 border-l-4 ${stats.overdue > 0 ? 'border-red-600 bg-red-50' : 'border-gray-300'}`}>
            <p className="text-xs text-gray-500">Overdue (72h+)</p>
            <p className={`text-2xl font-bold ${stats.overdue > 0 ? 'text-red-700' : 'text-gray-400'}`}>{stats.overdue}</p>
          </div>
          <div className="card p-3 border-l-4 border-gray-500"><p className="text-xs text-gray-500">Total</p><p className="text-2xl font-bold">{stats.total}</p></div>
        </div>
      )}

      <div className="card p-3 flex flex-wrap items-end gap-3">
        <div className="relative flex-1 min-w-[160px]">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input className="input pl-9 text-sm" placeholder="Search snag #, site, location, description…" value={searchInput} onChange={e => setSearchInput(e.target.value)} />
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
        {/* Due (target) date window — inclusive, runs server-side so the
            cards and the Excel export follow it too. */}
        <div className="w-36 shrink-0">
          <label className="label">Due From</label>
          <input type="date" className="input" value={filters.due_from} max={filters.due_to || undefined}
            onChange={e => setFilters(f => ({ ...f, due_from: e.target.value }))} />
        </div>
        <div className="w-36 shrink-0">
          <label className="label">Due To</label>
          <input type="date" className="input" value={filters.due_to} min={filters.due_from || undefined}
            onChange={e => setFilters(f => ({ ...f, due_to: e.target.value }))} />
        </div>
        {(filters.due_from || filters.due_to) && (
          <button type="button" className="text-xs text-gray-500 hover:text-gray-800 underline pb-2"
            onClick={() => setFilters(f => ({ ...f, due_from: '', due_to: '' }))}>Clear dates</button>
        )}
      </div>

      {/* Reverted to the original 10-column table per mam
          (2026-05-21: "dont change also snag list old is ok"). */}
      <div className="card p-0">
        {/* Own bounded scroll box → the sticky `freeze-head` thead pins to
            THIS container's top (Excel-style frozen header), and `freeze-col`
            keeps the Snag-No column fixed during horizontal scroll.
            mam (2026-07-28): "freeze like excel". */}
        <div ref={scrollBoxRef} className="overflow-auto max-h-[70vh]">
          <table className="freeze-head freeze-col min-w-[850px]">
            <thead>
              <tr>
                <th>Snag No</th><th>Raised</th><th>Aging</th><th>Site / Location</th><th>Description</th>
                <th>Snag Photo</th><th>Assigned To</th><th>Target Date</th><th>Proof</th>
                <th>Priority</th><th>Status</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {snags.length === 0 && (
                <tr><td colSpan="11" className="text-center py-8 text-gray-400">No snags raised yet</td></tr>
              )}
              {pg.rows.map(s => (
                <tr key={s.id}>
                  <td className="font-bold text-red-700 text-xs">
                    <div>{s.snag_no}</div>
                    {s.is_client_walk === 1 && (
                      <span className="inline-block text-[9px] bg-purple-100 text-purple-700 font-bold px-1 rounded mt-0.5" title="Logged during Joint Client Walk (SOP-15.2)">
                        Client Walk
                      </span>
                    )}
                  </td>
                  <td className="text-xs">
                    <div>{s.raised_at ? fmtDate(s.raised_at) : '—'}</div>
                    <div className="text-[10px] text-gray-500">{s.raised_by_name || '—'}</div>
                  </td>
                  <td className="text-xs whitespace-nowrap">
                    {s.status !== 'approved' ? (() => {
                      const age = snagAge(s.raised_at);
                      if (!age) return <span className="text-gray-300">—</span>;
                      return (
                        <span className={`text-[10px] px-1.5 py-0.5 rounded border ${age.cls}`}>
                          {age.label}
                        </span>
                      );
                    })() : <span className="text-gray-300 text-[10px]">—</span>}
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
                      ? <a href={s.photo_url} target="_blank" rel="noreferrer"><img src={toThumb(s.photo_url, 120)} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded" /></a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="text-xs">{s.assigned_to_user_name || s.assigned_to_name || <span className="text-gray-300">—</span>}</td>
                  <td className="text-xs whitespace-nowrap">
                    {s.target_date
                      ? <span className={isOverdue(s) ? 'text-red-600 font-bold' : ''}>{fmtDate(s.target_date)}{isOverdue(s) && <span className="block text-[9px] font-semibold">OVERDUE</span>}</span>
                      : <span className="text-gray-300">—</span>}
                  </td>
                  <td>
                    {s.proof_url
                      ? <a href={s.proof_url} target="_blank" rel="noreferrer"><img src={toThumb(s.proof_url, 120)} alt="" width="48" height="48" loading="lazy" decoding="async" className="w-12 h-12 object-cover rounded ring-2 ring-emerald-400" /></a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold border ${PRIORITY_PILL[s.priority] || ''}`}>{s.priority}</span>
                  </td>
                  <td>
                    <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[s.status] || ''}`}>{STATUS_LABEL[s.status] || s.status}</span>
                    {s.status === 'approved' && (
                      s.client_verified ? (
                        <span className="block text-[9px] text-emerald-700 font-semibold mt-0.5">✓ Client Ticked</span>
                      ) : (
                        <span className="block text-[9px] text-amber-600 font-medium mt-0.5">⏳ Awaiting Tick</span>
                      )
                    )}
                  </td>
                  <td className="whitespace-nowrap">
                    {s.status === 'approved' && !s.client_verified && (
                      <button
                        onClick={() => handleClientTick(s)}
                        className="btn btn-sm text-[10px] px-2 py-1 bg-purple-600 hover:bg-purple-700 text-white font-bold mr-1 inline-flex items-center gap-1 shadow-xs"
                        title="Client Tick: Verify & Close defect per SOP-15.4 (Lovely / Client)"
                      >
                        <FiCheck size={11} /> Client Tick (S4)
                      </button>
                    )}
                    {(isAssignee(s) || canApprove('snags') || isAdmin()) && (s.status === 'open' || s.status === 'rejected') && (
                      <button onClick={() => { setProofModal(s); proofModalIdRef.current = s.id; setProofForm({}); }} className="btn btn-primary text-[10px] px-2 py-1 mr-1" title="Upload proof"><FiUploadCloud size={11} className="inline" /> {s.status === 'rejected' ? 'Resubmit' : 'Submit Proof'}</button>
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

      <Pagination pg={pg} setPerPage={setPerPage} className="card !px-8 !py-6" />

      {/* RAISE / EDIT MODAL */}
      <Modal isOpen={modal} onClose={() => { setModal(false); setEditingId(null); setForm({}); setWalkItems([]); }} title={editingId ? 'Edit Snag' : (snagMode === 'walk' ? 'Snag Walk — Batch Defect Logger' : 'Raise Snag')} wide>
        {!editingId && (
          <div className="flex border-b mb-3 -mt-1 pb-2 gap-2">
            <button
              type="button"
              onClick={() => setSnagMode('single')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition ${snagMode === 'single'
                  ? 'bg-blue-600 text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
                }`}
            >
              <FiPlus size={13} /> Single Snag
            </button>
            <button
              type="button"
              onClick={() => setSnagMode('walk')}
              className={`px-3 py-1.5 text-xs font-semibold rounded-lg flex items-center gap-1.5 transition ${snagMode === 'walk'
                  ? 'bg-indigo-600 text-white shadow-sm'
                  : 'text-gray-600 hover:bg-gray-100'
                }`}
            >
              <FiLayers size={13} /> Snag Walk (Multi-Photo Batch)
            </button>
          </div>
        )}

        {snagMode === 'walk' && !editingId ? (
          <form onSubmit={saveWalk} className="space-y-3">
            <div className="bg-indigo-50/50 p-3 rounded-lg border border-indigo-100 space-y-3">
              <div className="text-xs font-bold text-indigo-900 flex items-center gap-1.5">
                <FiLayers className="text-indigo-600" /> Walk Parameters (Shared for all photos on this walk)
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-xs">
                <div>
                  <label className="label">Site Name</label>
                  <SearchableSelect
                    options={sites}
                    value={form.site_id || null}
                    valueKey="id"
                    displayKey="name"
                    placeholder="Pick site…"
                    onChange={(s) => setForm(f => ({
                      ...f,
                      site_id: s?.id || '',
                      site_name: s?.name || '',
                      assigned_to: s?.site_engineer_id || f.assigned_to || '',
                      assigned_to_name: s?.engineer_name || f.assigned_to_name || '',
                    }))}
                  />
                </div>
                <div>
                  <label className="label">Assign To</label>
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
                  <label className="label">Target Date (SLA)</label>
                  <input type="date" className="input" value={form.target_date || ''} onChange={e => setForm(f => ({ ...f, target_date: e.target.value }))} />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <label className="cursor-pointer border-2 border-dashed border-indigo-200 hover:border-indigo-400 bg-indigo-50/40 rounded-lg p-3 text-center transition flex items-center justify-center gap-2">
                <FiCamera className="text-indigo-600" size={16} />
                <span className="text-indigo-700 font-semibold text-xs">📷 Take / Add Photo</span>
                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { handleWalkPhotos(e.target.files); e.target.value = ''; }} />
              </label>
              <label className="cursor-pointer border-2 border-dashed border-blue-200 hover:border-blue-400 bg-blue-50/40 rounded-lg p-3 text-center transition flex items-center justify-center gap-2">
                <FiUploadCloud className="text-blue-600" size={16} />
                <span className="text-blue-700 font-semibold text-xs">📂 Select Multiple Photos</span>
                <input type="file" accept="image/*" multiple className="hidden" onChange={e => { handleWalkPhotos(e.target.files); e.target.value = ''; }} />
              </label>
            </div>

            {walkItems.length === 0 ? (
              <div className="text-center py-8 border-2 border-dashed rounded-lg bg-gray-50 text-gray-400 text-xs">
                No snag photos added yet. Snap or select multiple photos above to quickly log defect points during your site walk!
              </div>
            ) : (
              <div className="space-y-2.5 max-h-[50vh] overflow-auto pr-1">
                <div className="flex justify-between items-center text-xs font-semibold text-gray-600 px-1">
                  <span>Logged Points ({walkItems.length})</span>
                  <button type="button" onClick={() => setWalkItems([])} className="text-red-500 hover:underline text-[11px]">Clear all</button>
                </div>
                {walkItems.map((it, idx) => (
                  <div key={it.id} className="p-2.5 bg-gray-50 border rounded-lg flex flex-col sm:flex-row gap-3 items-start">
                    <div className="relative w-20 h-20 shrink-0 bg-gray-200 rounded border overflow-hidden flex items-center justify-center">
                      {it.uploading ? (
                        <div className="text-[10px] text-gray-500 flex flex-col items-center">
                          <span className="animate-spin text-sm">⏳</span>
                          <span>Uploading…</span>
                        </div>
                      ) : it.photo_url ? (
                        <img src={toThumb(it.photo_url, 160)} alt="" className="w-full h-full object-cover" />
                      ) : (
                        <span className="text-[10px] text-red-500">Failed</span>
                      )}
                    </div>
                    <div className="flex-1 space-y-1.5 w-full">
                      <div className="flex gap-2 items-center">
                        <span className="text-xs font-bold text-gray-400">#{idx + 1}</span>
                        <input
                          className="input text-xs py-1 flex-1"
                          placeholder="Location (e.g. 2nd floor shaft)"
                          value={it.location || ''}
                          onChange={e => {
                            const v = e.target.value;
                            setWalkItems(items => items.map(x => x.id === it.id ? { ...x, location: v } : x));
                          }}
                        />
                        <select
                          className="select text-xs py-1 w-28 shrink-0"
                          value={it.priority || form.priority || 'medium'}
                          onChange={e => {
                            const v = e.target.value;
                            setWalkItems(items => items.map(x => x.id === it.id ? { ...x, priority: v } : x));
                          }}
                        >
                          <option value="low">Low</option>
                          <option value="medium">Medium</option>
                          <option value="high">High</option>
                          <option value="critical">Critical</option>
                        </select>
                        <button
                          type="button"
                          onClick={() => setWalkItems(items => items.filter(x => x.id !== it.id))}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          title="Remove item"
                        >
                          <FiTrash2 size={13} />
                        </button>
                      </div>
                      <input
                        className="input text-xs py-1 w-full"
                        placeholder="Description (What's wrong / needs fixing?) *"
                        value={it.description || ''}
                        onChange={e => {
                          const v = e.target.value;
                          setWalkItems(items => items.map(x => x.id === it.id ? { ...x, description: v } : x));
                        }}
                      />
                      <div className="flex flex-wrap gap-1">
                        {COMMON_DEFECTS.slice(0, 6).map(def => (
                          <button
                            key={def.label}
                            type="button"
                            onClick={() => {
                              setWalkItems(items => items.map(x => x.id === it.id ? {
                                ...x,
                                description: x.description?.trim() ? `${x.description.trim()} · ${def.text}` : def.text
                              } : x));
                            }}
                            className="text-[10px] px-1.5 py-0.5 bg-white hover:bg-blue-50 text-gray-600 hover:text-blue-700 rounded border border-gray-200 transition"
                          >
                            {def.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}

            <div className="flex justify-between items-center pt-2 border-t">
              <div className="text-[11px] text-gray-400">
                {walkItems.length > 0 && `${walkItems.length} point(s) ready to create.`}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setModal(false); setEditingId(null); setForm({}); setWalkItems([]); }} className="btn btn-secondary">Cancel</button>
                <button
                  type="submit"
                  disabled={uploading || walkItems.length === 0 || walkItems.some(it => it.uploading)}
                  className="btn btn-primary"
                >
                  {uploading ? 'Creating…' : `Raise All (${walkItems.length}) Snags`}
                </button>
              </div>
            </div>
          </form>
        ) : (
          <form onSubmit={save} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="label">Site Name</label>
                <SearchableSelect
                  options={sites}
                  value={form.site_id || null}
                  valueKey="id"
                  displayKey="name"
                  placeholder="Pick site…"
                  onChange={(s) => setForm(f => ({
                    ...f,
                    site_id: s?.id || '',
                    site_name: s?.name || '',
                    assigned_to: s?.site_engineer_id || f.assigned_to || '',
                    assigned_to_name: s?.engineer_name || f.assigned_to_name || '',
                  }))}
                />
              </div>
              <div>
                <label className="label">Location <span className="text-gray-400 font-normal text-[10px]">(within site)</span></label>
                <input className="input" value={form.location || ''} onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="e.g. 2nd floor pump room" />
              </div>

              <div className="col-span-1 sm:col-span-2">
                <div className="flex items-center justify-between mb-1">
                  <label className="label mb-0">Description *</label>
                  <span className="text-[11px] text-gray-400 font-medium">Quick Tags:</span>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {COMMON_DEFECTS.map(def => (
                    <button
                      key={def.label}
                      type="button"
                      onClick={() => setForm(f => ({
                        ...f,
                        description: f.description?.trim() ? `${f.description.trim()} · ${def.text}` : def.text
                      }))}
                      className="text-[11px] px-2 py-0.5 bg-gray-100 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-300 text-gray-700 rounded border border-gray-200 transition"
                    >
                      {def.label}
                    </button>
                  ))}
                </div>
                <textarea className="input" rows="3" required value={form.description || ''} onChange={e => setForm(f => ({ ...f, description: e.target.value }))} placeholder="What's wrong / needs fixing?" />
              </div>

              <div className="col-span-1 sm:col-span-2">
                <label className="label">Snag Photo</label>
                {form.photo_url ? (
                  <div className="flex items-start gap-3">
                    <img src={toThumb(form.photo_url, 256)} alt="" width="128" height="128" decoding="async" className="w-32 h-32 object-cover rounded border" />
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
            <div className="flex justify-between items-center pt-2 border-t">
              <div>
                {!editingId && (
                  <span className="text-[11px] text-gray-400">💡 Click "Save & Add Next" to keep site locked for the next point.</span>
                )}
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => { setModal(false); setEditingId(null); setForm({}); }} className="btn btn-secondary">Cancel</button>
                {!editingId && (
                  <button
                    type="button"
                    disabled={uploading}
                    onClick={(e) => save(e, true)}
                    className="btn btn-secondary border-blue-400 text-blue-700 hover:bg-blue-50 font-semibold"
                    title="Save this snag and keep site & assignee locked for next entry"
                  >
                    Save & Add Next
                  </button>
                )}
                <button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : (editingId ? 'Save' : 'Raise Snag')}</button>
              </div>
            </div>
          </form>
        )}
      </Modal>

      {/* SUBMIT PROOF MODAL */}
      <Modal isOpen={!!proofModal} onClose={() => { setProofModal(null); proofModalIdRef.current = null; setProofForm({}); }} title={proofModal ? `Submit Proof — ${proofModal.snag_no}` : ''}>
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
                  <img src={toThumb(proofForm.proof_url, 256)} alt="" width="128" height="128" decoding="async" className="w-32 h-32 object-cover rounded border" />
                  <button type="button" onClick={() => setProofForm(f => ({ ...f, proof_url: '' }))} className="text-red-500 text-xs">Remove</button>
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2">
                  <label className="cursor-pointer border-2 border-blue-200 hover:border-blue-400 bg-blue-50/60 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-blue-700 font-semibold text-sm">📷 Take Photo</span>
                    <input type="file" accept="image/*" capture="environment" className="hidden" onChange={async e => {
                      const forId = proofModalIdRef.current;
                      const url = await upload(e.target.files?.[0]);
                      if (url && proofModalIdRef.current === forId) setProofForm(f => ({ ...f, proof_url: url }));
                      else if (url) toast('That upload finished after you switched snags — please upload again here.', { icon: '⚠️' });
                      e.target.value = '';
                    }} />
                  </label>
                  <label className="cursor-pointer border-2 border-gray-200 hover:border-gray-400 bg-gray-50 rounded-lg p-2 text-center transition flex items-center justify-center gap-1.5">
                    <span className="text-gray-700 font-semibold text-sm">📂 Choose File</span>
                    <input type="file" accept="image/*,.pdf" className="hidden" onChange={async e => {
                      const forId = proofModalIdRef.current;
                      const url = await upload(e.target.files?.[0]);
                      if (url && proofModalIdRef.current === forId) setProofForm(f => ({ ...f, proof_url: url }));
                      else if (url) toast('That upload finished after you switched snags — please upload again here.', { icon: '⚠️' });
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
              <button type="button" onClick={() => { setProofModal(null); proofModalIdRef.current = null; setProofForm({}); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" disabled={uploading || !proofForm.proof_url} className="btn btn-primary">{uploading ? 'Uploading…' : 'Submit Proof'}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* ─── SOP-15 MODALS ────────────────────────────────────────────── */}
      {raciOpen && (
        <HandoverRaciModal
          onClose={() => setRaciOpen(false)}
          onSaved={() => {
            loadRaci();
            if (handoverSiteId) loadHandoverStatus(handoverSiteId);
          }}
        />
      )}

      {startHandoverOpen && handoverData?.site && (
        <StartHandoverModal
          site={handoverData.site}
          raci={raci}
          onClose={() => setStartHandoverOpen(false)}
          onSaved={() => {
            loadHandoverStatus(handoverSiteId);
            load();
          }}
        />
      )}

      {clientWalkOpen && handoverData?.site && (
        <ClientWalkModal
          site={handoverData.site}
          raci={raci}
          onClose={() => setClientWalkOpen(false)}
          onSaved={() => {
            loadHandoverStatus(handoverSiteId);
            load();
          }}
        />
      )}

      {generateCertOpen && handoverData?.site && (
        <GenerateCertificateModal
          site={handoverData.site}
          raci={raci}
          onClose={() => setGenerateCertOpen(false)}
          onSaved={() => {
            loadHandoverStatus(handoverSiteId);
            load();
          }}
        />
      )}

      {viewCert && (
        <HandoverCertificateModal
          cert={viewCert}
          onClose={() => setViewCert(null)}
          onSigned={() => {
            loadHandoverStatus(handoverSiteId);
            load();
          }}
        />
      )}

      {escalationsModalOpen && (
        <Modal
          isOpen
          onClose={() => setEscalationsModalOpen(false)}
          title={`SOP-15.3 · Snag Turnaround Clock & Escalations ${handoverData?.site?.name ? `(${handoverData.site.name})` : ''}`}
          wide
        >
          <div className="space-y-4 text-xs">
            <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-red-900 space-y-1">
              <div className="font-bold flex items-center gap-1.5">
                <FiClock size={14} className="text-red-700" /> Automated Turnaround Clock &amp; Escalation Gate (SOP-15.3):
              </div>
              <p>
                Every open snag tracks target turnaround time. Overdue by 1–3 days escalates directly to <strong>Project Manager ({raci?.s3_snag_clock?.assigned_name || raci?.sop_owner?.assigned_name || 'Adarsh Kumar'})</strong>. Overdue by &gt;3 days escalates to <strong>Project Head</strong>.
              </p>
            </div>

            {escalationsList.length === 0 ? (
              <div className="text-center py-8 text-gray-500 bg-gray-50 rounded-lg border">
                <FiCheckCircle className="mx-auto text-emerald-500 mb-2" size={28} />
                <div className="font-semibold text-gray-700">No Overdue Snags!</div>
                <p className="text-gray-400 text-xs mt-1">All snags are currently on schedule or closed within turnaround targets.</p>
              </div>
            ) : (
              <div className="overflow-x-auto max-h-96 border rounded-lg">
                <table className="w-full text-left">
                  <thead className="bg-gray-100 text-gray-600 uppercase text-[10px] font-bold sticky top-0">
                    <tr>
                      <th className="p-2.5">Snag #</th>
                      <th className="p-2.5">Site / Location</th>
                      <th className="p-2.5">Assigned To</th>
                      <th className="p-2.5">Target Date</th>
                      <th className="p-2.5">Days Overdue</th>
                      <th className="p-2.5">Escalation Level</th>
                      <th className="p-2.5">Escalated To</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-200">
                    {escalationsList.map(e => (
                      <tr key={e.id} className="hover:bg-red-50/50">
                        <td className="p-2.5 font-bold text-red-700">{e.snag_no}</td>
                        <td className="p-2.5">
                          <div className="font-semibold">{e.site_name}</div>
                          <div className="text-[10px] text-gray-400">{e.location || '—'}</div>
                        </td>
                        <td className="p-2.5">{e.assigned_to_name || '—'}</td>
                        <td className="p-2.5 text-red-600 font-semibold">{fmtDate(e.target_date)}</td>
                        <td className="p-2.5 font-bold text-red-700">{e.days_overdue} days</td>
                        <td className="p-2.5">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase ${e.escalation_level === 'head' ? 'bg-red-600 text-white' : 'bg-amber-100 text-amber-800 border border-amber-300'
                            }`}>
                            {e.escalation_level === 'head' ? 'Level 2 · Head' : 'Level 1 · PM'}
                          </span>
                        </td>
                        <td className="p-2.5 font-semibold text-gray-800">{e.escalated_to}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            <div className="flex justify-end pt-2 border-t">
              <button type="button" onClick={() => setEscalationsModalOpen(false)} className="btn btn-secondary text-sm">Close</button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
