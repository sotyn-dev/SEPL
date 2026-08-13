// Drawing Tracker — project drawings with a permanent revision history.
//
//   Dashboard  KPI cards, discipline breakdown, recent revision activity
//   Drawings   flat searchable/filterable table of every drawing
//   By Site    sites with drawing + revision counts, drill into one site
//   Reports    register / history / superseded / discipline / project / site
//
// A revision is never overwritten — uploading Rev 11 leaves Rev 10 fully
// readable. The UI reflects that: every revision stays listed and openable.
import { useState, useEffect, useCallback, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import { exportCsv } from '../utils/exportCsv';
import {
  FiPenTool, FiTrendingUp, FiGrid, FiMapPin, FiFileText, FiPlus, FiSearch,
  FiDownload, FiChevronRight, FiChevronLeft, FiLayers, FiClock, FiColumns, FiExternalLink,
} from 'react-icons/fi';
import { RevisionViewer, UploadRevisionModal } from '../components/DrawingRevisionModals';

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const REV_CLS = {
  current: 'bg-emerald-100 text-emerald-700',
  superseded: 'bg-gray-100 text-gray-500',
  cancelled: 'bg-red-100 text-red-700',
};

export default function DrawingTracker() {
  const [tab, setTab] = useUrlTab('drawings');
  const TABS = [
    ['dashboard', 'Dashboard', FiTrendingUp],
    ['drawings', 'Drawings', FiGrid],
    ['matrix', 'Revision Matrix', FiColumns],
    ['sites', 'By Site', FiMapPin],
    ['reports', 'Reports', FiFileText],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FiPenTool className="text-red-600" /> Drawing Tracker
        </h1>
        <p className="text-sm text-gray-500">
          Every revision is kept forever — uploading a new one never replaces the old drawing.
        </p>
      </div>

      <div className="flex gap-2 border-b border-gray-200 flex-wrap">
        {TABS.map(([k, label, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5 ${tab === k
              ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon size={14} /> {label}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'drawings' && <DrawingsTab />}
      {tab === 'matrix' && <MatrixTab />}
      {tab === 'sites' && <SitesTab />}
      {tab === 'reports' && <ReportsTab />}
    </div>
  );
}

// ─── Dashboard ─────────────────────────────────────────────────────────
function DashboardTab() {
  const [data, setData] = useState(null);
  useEffect(() => {
    api.get('/drawing-tracker/dashboard').then(r => setData(r.data)).catch(() => toast.error('Could not load dashboard'));
  }, []);
  if (!data) return <div className="text-sm text-gray-400">Loading…</div>;
  const c = data.cards;
  const cards = [
    ['Total Drawings', c.total_drawings, ''],
    ['Total Revisions', c.total_revisions, 'text-blue-700'],
    ['Current Drawings', c.current_drawings, 'text-emerald-700'],
    ['Superseded Revisions', c.superseded_revisions, 'text-gray-500'],
    ['Revised (last 7 days)', c.recently_revised, 'text-amber-700'],
    ['Cancelled Revisions', c.cancelled_revisions, 'text-red-600'],
    ['Disciplines Covered', c.disciplines_covered, ''],
    ['Projects Covered', c.projects_covered, ''],
  ];
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {cards.map(([label, val, cls]) => (
          <div key={label} className="card p-4">
            <div className="text-xs text-gray-500">{label}</div>
            <div className={`text-2xl font-semibold ${cls}`}>{val ?? 0}</div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-medium px-4 pt-4">Drawings by Discipline</h3>
          <table className="min-w-full mt-2 text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-600">
              <th className="px-3 py-2 text-left">Discipline</th>
              <th className="px-3 py-2 text-right">Drawings</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.by_discipline.map(d => (
                <tr key={d.name}><td className="px-3 py-2">{d.name}</td><td className="px-3 py-2 text-right">{d.drawings}</td></tr>
              ))}
              {data.by_discipline.length === 0 && <tr><td colSpan={2} className="text-center py-6 text-gray-400">No drawings yet</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-medium px-4 pt-4">Recent Revision Activity</h3>
          <table className="min-w-full mt-2 text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-600">
              <th className="px-3 py-2 text-left">Drawing</th>
              <th className="px-3 py-2 text-center">Rev</th>
              <th className="px-3 py-2 text-left">When</th>
              <th className="px-3 py-2 text-left">By</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.recent.map(r => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <Link to={`/drawing-tracker/${r.drawing_id}`} className="text-red-600 hover:underline font-mono text-xs">{r.drawing_number}</Link>
                    <div className="text-[10px] text-gray-500">{r.revision_description}</div>
                  </td>
                  <td className="px-3 py-2 text-center">Rev {r.revision_no}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.uploaded_at)}</td>
                  <td className="px-3 py-2 text-xs">{r.uploaded_by_name || '—'}</td>
                </tr>
              ))}
              {data.recent.length === 0 && <tr><td colSpan={4} className="text-center py-6 text-gray-400">Nothing yet</td></tr>}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// ─── Drawings (flat table + filters) ───────────────────────────────────
function DrawingsTab() {
  const { canCreate } = useAuth();
  const [data, setData] = useState({ rows: [], total: 0 });
  const [opts, setOpts] = useState(null);
  const [filters, setFilters] = useState({ search: '', site_id: '', discipline: '', drawing_type: '', status: '' });
  const [offset, setOffset] = useState(0);
  const [newOpen, setNewOpen] = useState(false);
  const LIMIT = 50;

  const load = useCallback(() => {
    const params = { limit: LIMIT, offset };
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    api.get('/drawing-tracker/drawings', { params })
      .then(r => setData(r.data)).catch(() => toast.error('Could not load drawings'));
  }, [filters, offset]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/drawing-tracker/options').then(r => setOpts(r.data)).catch(() => {}); }, []);
  useEffect(() => { setOffset(0); }, [filters]);

  const F = (k, v) => setFilters(f => ({ ...f, [k]: v }));

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label text-xs">Search</label>
          <div className="relative">
            <FiSearch className="absolute left-2 top-2.5 text-gray-400" size={14} />
            <input className="input pl-7 w-full" placeholder="Drawing no, title, project, site"
              value={filters.search} onChange={e => F('search', e.target.value)} />
          </div>
        </div>
        <div><label className="label text-xs">Site</label>
          <select className="select" value={filters.site_id} onChange={e => F('site_id', e.target.value)}>
            <option value="">All sites</option>
            {(opts?.sites || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label className="label text-xs">Discipline</label>
          <select className="select" value={filters.discipline} onChange={e => F('discipline', e.target.value)}>
            <option value="">All</option>
            {(opts?.disciplines || []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div><label className="label text-xs">Type</label>
          <select className="select" value={filters.drawing_type} onChange={e => F('drawing_type', e.target.value)}>
            <option value="">All</option>
            {(opts?.drawing_types || []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div><label className="label text-xs">Status</label>
          <select className="select" value={filters.status} onChange={e => F('status', e.target.value)}>
            <option value="">All</option>
            <option value="current">Current</option>
            <option value="superseded">Superseded</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        {canCreate('drawing_tracker') && (
          <button onClick={() => setNewOpen(true)} className="btn btn-primary flex items-center gap-1 text-sm ml-auto">
            <FiPlus size={14} /> New Drawing
          </button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Project</th>
            <th className="px-3 py-2 text-left">Site</th>
            <th className="px-3 py-2 text-left">Drawing No</th>
            <th className="px-3 py-2 text-left">Title</th>
            <th className="px-3 py-2 text-left">Discipline</th>
            <th className="px-3 py-2 text-center">Current Rev</th>
            <th className="px-3 py-2 text-center">Revisions</th>
            <th className="px-3 py-2 text-left">Last Revised</th>
            <th className="px-3 py-2 text-left">Uploaded By</th>
            <th className="px-3 py-2 text-center">Action</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {data.rows.map(r => (
              <tr key={r.id} className="hover:bg-red-50/30">
                <td className="px-3 py-2 text-xs">{r.project_name || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.site_name || '—'}</td>
                <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{r.drawing_number}</td>
                <td className="px-3 py-2">{r.title || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.discipline || '—'}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${REV_CLS[r.current_status] || 'bg-gray-100 text-gray-500'}`}>
                    Rev {r.current_revision_no ?? '—'}
                  </span>
                </td>
                <td className="px-3 py-2 text-center text-xs">{r.revision_count}</td>
                <td className="px-3 py-2 text-xs">{fmtDate(r.last_revised_at)}</td>
                <td className="px-3 py-2 text-xs">{r.last_revised_by || '—'}</td>
                <td className="px-3 py-2 text-center">
                  <Link to={`/drawing-tracker/${r.id}`} className="text-red-600 hover:underline text-xs">View</Link>
                </td>
              </tr>
            ))}
            {data.rows.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-gray-400">No drawings found</td></tr>}
          </tbody>
        </table>
        {data.total > LIMIT && (
          <div className="flex items-center justify-between px-4 py-3 bg-gray-50 text-xs border-t">
            <span>Showing {offset + 1}–{Math.min(offset + LIMIT, data.total)} of {data.total}</span>
            <div className="flex gap-2">
              <button className="btn btn-secondary text-xs" disabled={offset === 0}
                onClick={() => setOffset(o => Math.max(0, o - LIMIT))}>Prev</button>
              <button className="btn btn-secondary text-xs" disabled={offset + LIMIT >= data.total}
                onClick={() => setOffset(o => o + LIMIT)}>Next</button>
            </div>
          </div>
        )}
      </div>

      {newOpen && <NewDrawingModal opts={opts} onClose={() => setNewOpen(false)} onSaved={() => { setNewOpen(false); load(); }} />}
    </div>
  );
}

// ─── New drawing (creates the identity + its Rev 0 together) ───────────
function NewDrawingModal({ opts, onClose, onSaved }) {
  const [form, setForm] = useState({
    project_source: 'business_book', project_id: '', site_id: '',
    drawing_number: '', title: '', discipline: '', drawing_type: '',
    revision_description: '', revision_date: new Date().toLocaleDateString('en-CA'),
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // Sites only cascade off Business Book — sites.business_book_id is the only
  // project link that exists in this schema. For a Projects-module drawing the
  // full site list is offered instead.
  const projects = form.project_source === 'business_book' ? (opts?.projects_business_book || []) : (opts?.projects_module || []);
  const sites = form.project_source === 'business_book' && form.project_id
    ? (opts?.sites || []).filter(s => String(s.business_book_id) === String(form.project_id))
    : (opts?.sites || []);

  const save = async (e) => {
    e.preventDefault();
    if (!form.drawing_number.trim()) return toast.error('Drawing number is required');
    if (!form.revision_description.trim()) return toast.error('Revision description is required');
    if (!file) return toast.error('Please choose the drawing file');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      const proj = projects.find(p => String(p.id) === String(form.project_id));
      if (proj) fd.append('project_name', proj.name);
      const site = (opts?.sites || []).find(s => String(s.id) === String(form.site_id));
      if (site) fd.append('site_name', site.name);
      await api.post('/drawing-tracker/drawings', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Drawing created at Rev 0');
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not create the drawing');
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title="New Drawing — Rev 0" wide>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><label className="label">Project from</label>
            <select className="select" value={form.project_source}
              onChange={e => { F('project_source', e.target.value); F('project_id', ''); F('site_id', ''); }}>
              <option value="business_book">Business Book</option>
              <option value="proj_project">Projects module</option>
            </select>
          </div>
          <div><label className="label">Project</label>
            <select className="select" value={form.project_id} onChange={e => { F('project_id', e.target.value); F('site_id', ''); }}>
              <option value="">Select project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div><label className="label">Site</label>
            <select className="select" value={form.site_id} onChange={e => F('site_id', e.target.value)}>
              <option value="">Select site</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label className="label">Drawing Number *</label>
            <input className="input font-mono" value={form.drawing_number}
              onChange={e => F('drawing_number', e.target.value)} placeholder="ELEC-GF-001" required />
          </div>
          <div><label className="label">Drawing Title</label>
            <input className="input" value={form.title} onChange={e => F('title', e.target.value)}
              placeholder="Ground Floor Electrical Layout" />
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div><label className="label">Discipline</label>
            <select className="select" value={form.discipline} onChange={e => F('discipline', e.target.value)}>
              <option value="">Select</option>
              {(opts?.disciplines || []).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div><label className="label">Drawing Type</label>
            <select className="select" value={form.drawing_type} onChange={e => F('drawing_type', e.target.value)}>
              <option value="">Select</option>
              {(opts?.drawing_types || []).map(d => <option key={d} value={d}>{d}</option>)}
            </select>
          </div>
        </div>

        <div><label className="label">Drawing File * <span className="text-gray-400 font-normal">(PDF, DWG, DXF, XLSX, DOCX, JPG, PNG — up to 100 MB)</span></label>
          <input type="file" className="input" onChange={e => setFile(e.target.files?.[0] || null)} required />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div><label className="label">Revision Date</label>
            <input type="date" className="input" value={form.revision_date} onChange={e => F('revision_date', e.target.value)} />
          </div>
          <div className="sm:col-span-2"><label className="label">Revision Description *</label>
            <input className="input" value={form.revision_description}
              onChange={e => F('revision_description', e.target.value)} placeholder="Initial issue" required />
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Uploading…' : 'Create Drawing'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Revision Matrix ───────────────────────────────────────────────────
// One row per drawing. The left block (Sr · Site · Drawing No · Category)
// is frozen; the revision columns scroll sideways so Rev 0…Rev N are all
// reachable however many there are. The trailing "+" adds the next revision.
//
// Same frozen-column technique as the CRM Kitting matrix: table-layout
// fixed + a colgroup of exact pixel widths, and each sticky cell's `left`
// set to the cumulative width of the columns before it. If the widths and
// the offsets ever disagree the sticky cells overlap, so they are derived
// from one source (W) rather than typed twice.
function MatrixTab() {
  const { canCreate } = useAuth();
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState(null);
  const [filters, setFilters] = useState({ search: '', site_id: '', discipline: '' });
  const [viewing, setViewing] = useState(null);      // { revision, drawing }
  const [uploadFor, setUploadFor] = useState(null);  // drawing
  const scrollRef = useRef(null);
  // Direct scrollLeft assignment rather than scrollBy({behavior:'smooth'}):
  // the smooth variant is a no-op in some environments (verified — the
  // buttons did nothing), and a nudge that silently fails is worse than an
  // instant one. scroll-smooth on the container still animates it in
  // browsers that honour it.
  const scrollBy = (px) => { const el = scrollRef.current; if (el) el.scrollLeft += px; };

  const load = useCallback(() => {
    const params = {};
    for (const [k, v] of Object.entries(filters)) if (v) params[k] = v;
    api.get('/drawing-tracker/matrix', { params })
      .then(r => setData(r.data)).catch(() => toast.error('Could not load the matrix'));
  }, [filters]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/drawing-tracker/options').then(r => setOpts(r.data)).catch(() => {}); }, []);

  if (!data) return <div className="text-sm text-gray-400">Loading…</div>;

  const REV_W = 76;
  // Rev 0 is the ORIGINAL drawing, so it's frozen alongside the identity
  // columns — you can scroll out to Rev 20 and still see what the drawing
  // started as, which is the comparison people actually want.
  const W = { sr: 44, site: 160, dwg: 140, cat: 120, actual: REV_W };
  const L = {
    sr: 0,
    site: W.sr,
    dwg: W.sr + W.site,
    cat: W.sr + W.site + W.dwg,
    actual: W.sr + W.site + W.dwg + W.cat,
  };
  const FROZEN_W = L.actual + W.actual;
  const stickyShadow = 'shadow-[4px_0_6px_-2px_rgba(0,0,0,0.15)]';
  // Only Rev 1 and up scroll — Rev 0 has its own frozen column above.
  const revCols = Array.from({ length: Math.max(data.max_revision, 0) }, (_, i) => i + 1);
  const headCell = 'sticky top-0 z-30 bg-slate-800 text-white text-[10px] font-semibold border-r border-b border-slate-700';

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label text-xs">Search</label>
          <div className="relative">
            <FiSearch className="absolute left-2 top-2.5 text-gray-400" size={14} />
            <input className="input pl-7 w-full" placeholder="Drawing no, title, site"
              value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
          </div>
        </div>
        <div><label className="label text-xs">Site</label>
          <select className="select" value={filters.site_id} onChange={e => setFilters(f => ({ ...f, site_id: e.target.value }))}>
            <option value="">All sites</option>
            {(opts?.sites || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <div><label className="label text-xs">Category</label>
          <select className="select" value={filters.discipline} onChange={e => setFilters(f => ({ ...f, discipline: e.target.value }))}>
            <option value="">All</option>
            {(opts?.disciplines || []).map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-xs text-gray-500">{data.drawings.length} drawing(s)</span>
          {/* Explicit nudge buttons — the horizontal scrollbar sits at the
              bottom of a tall grid and is easy to miss, and trackpad users
              often don't think to shift-scroll. */}
          <div className="flex gap-1">
            <button onClick={() => scrollBy(-320)} className="btn btn-secondary text-xs px-2 py-1" title="Scroll to older revisions">
              <FiChevronLeft size={14} />
            </button>
            <button onClick={() => scrollBy(320)} className="btn btn-secondary text-xs px-2 py-1" title="Scroll to newer revisions">
              <FiChevronRight size={14} />
            </button>
          </div>
        </div>
      </div>

      {/* overflowX 'scroll' (not 'auto') keeps the horizontal bar permanently
          visible, so it's obvious the revision columns run further right even
          when the current set happens to fit. scrollbarWidth 'thin' keeps it
          unobtrusive. */}
      <div ref={scrollRef} className="card p-0"
        style={{ maxHeight: '70vh', overflowX: 'scroll', overflowY: 'auto', scrollbarWidth: 'thin' }}>
        <table className="border-collapse text-xs"
          style={{ tableLayout: 'fixed', width: FROZEN_W + revCols.length * REV_W + 56 }}>
          <colgroup>
            <col style={{ width: W.sr }} />
            <col style={{ width: W.site }} />
            <col style={{ width: W.dwg }} />
            <col style={{ width: W.cat }} />
            <col style={{ width: W.actual }} />
            {revCols.map(n => <col key={n} style={{ width: REV_W }} />)}
            <col style={{ width: 56 }} />
          </colgroup>

          <thead>
            <tr>
              <th className={`${headCell} sticky left-0 z-40 px-1 text-center`} style={{ left: L.sr, height: 40 }}>SR</th>
              <th className={`${headCell} sticky z-40 px-2 text-left`} style={{ left: L.site, height: 40 }}>SITE NAME</th>
              <th className={`${headCell} sticky z-40 px-2 text-left`} style={{ left: L.dwg, height: 40 }}>DRAWING NO</th>
              <th className={`${headCell} sticky z-40 px-2 text-left`} style={{ left: L.cat, height: 40 }}>CATEGORY</th>
              {/* Rev 0 — the original drawing. Frozen so it stays on screen
                  as a reference however far the revisions scroll. */}
              <th className={`sticky top-0 z-40 bg-slate-900 text-white text-[10px] font-bold text-center border-r border-b border-slate-700 ${stickyShadow}`}
                style={{ left: L.actual, height: 40 }}>ACTUAL</th>
              {revCols.map(n => (
                <th key={n} className="sticky top-0 z-20 bg-slate-700 text-white text-[10px] font-bold text-center border-r border-b border-slate-600" style={{ height: 40 }}>
                  REV {n}
                </th>
              ))}
              {/* Pinned to the RIGHT edge — the "+" must stay reachable no
                  matter how far the revision columns are scrolled. */}
              <th className="sticky top-0 right-0 z-40 bg-slate-900 text-white text-[10px] font-bold text-center border-b border-l border-slate-700 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.15)]" style={{ height: 40 }}>ADD</th>
            </tr>
          </thead>

          <tbody>
            {data.drawings.map((d, idx) => {
              const current = d.revisions.find(r => r.status === 'current');
              // One renderer for every revision cell, so the frozen Rev 0
              // column and the scrolling ones can never drift apart.
              const revCellBody = (rev, n) => {
                if (!rev) return <span className="text-[10px] text-gray-300">—</span>;
                const cls = rev.status === 'current'
                  ? 'bg-emerald-100 text-emerald-800 border-emerald-300 font-semibold'
                  : rev.status === 'cancelled'
                    ? 'bg-red-50 text-red-500 border-red-200 line-through'
                    : 'bg-white text-gray-600 border-gray-300';
                // Click = quick look in a modal. The ⧉ opens the full-page
                // viewer in its own tab, carrying the same superseded warning.
                return (
                  <div className="flex items-stretch gap-0.5">
                    <button
                      onClick={() => setViewing({ revision: rev, drawing: d, current })}
                      title={`Rev ${n} · ${rev.status}\n${rev.revision_description || ''}\n${rev.uploaded_by_name || ''}`}
                      className={`flex-1 rounded-l border px-1 py-1.5 text-[10px] leading-tight hover:ring-2 hover:ring-red-300 ${cls}`}
                    >
                      {rev.status === 'current' ? 'CURRENT' : 'view'}
                    </button>
                    <a
                      href={`/drawing-view/${rev.id}`} target="_blank" rel="noreferrer"
                      title={`Open Rev ${n} in a new tab`}
                      className={`rounded-r border border-l-0 px-1 flex items-center text-[9px] hover:ring-2 hover:ring-red-300 ${cls}`}
                    >
                      <FiExternalLink size={9} />
                    </a>
                  </div>
                );
              };
              return (
                <tr key={d.id} className="hover:bg-red-50/20">
                  <td className="sticky left-0 z-20 bg-white text-center text-gray-500 border-r border-b" style={{ left: L.sr }}>{idx + 1}</td>
                  <td className="sticky z-20 bg-white px-2 border-r border-b truncate" style={{ left: L.site }} title={d.site_name}>{d.site_name || '—'}</td>
                  <td className="sticky z-20 bg-white px-2 border-r border-b" style={{ left: L.dwg }}>
                    <Link to={`/drawing-tracker/${d.id}`} className="font-mono font-bold text-red-600 hover:underline">{d.drawing_number}</Link>
                    <div className="text-[9px] text-gray-400 truncate" title={d.title}>{d.title}</div>
                  </td>
                  <td className="sticky z-20 bg-white px-2 border-r border-b truncate" style={{ left: L.cat }} title={d.discipline}>{d.discipline || '—'}</td>

                  {/* ACTUAL = Rev 0, frozen beside the identity columns. */}
                  <td className={`sticky z-20 bg-white border-r border-b p-1 text-center align-middle ${stickyShadow}`} style={{ left: L.actual }}>
                    {revCellBody(d.revisions.find(r => r.revision_no === 0), 0)}
                  </td>

                  {revCols.map(n => {
                    const rev = d.revisions.find(r => r.revision_no === n);
                    if (!rev) return <td key={n} className="border-r border-b bg-gray-50/60" />;
                    return (
                      <td key={n} className="border-r border-b p-1 text-center align-middle">
                        {revCellBody(rev, n)}
                      </td>
                    );
                  })}

                  <td className="sticky right-0 z-20 bg-white border-b border-l text-center p-1 shadow-[-4px_0_6px_-2px_rgba(0,0,0,0.15)]">
                    {canCreate('drawing_tracker') && (
                      <button onClick={() => setUploadFor(d)} title={`Add Rev ${(current?.revision_no ?? -1) + 1}`}
                        className="w-8 h-8 rounded-full bg-red-600 text-white hover:bg-red-700 inline-flex items-center justify-center">
                        <FiPlus size={15} />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
            {data.drawings.length === 0 && (
              <tr><td colSpan={5 + revCols.length + 1} className="text-center py-8 text-gray-400">No drawings found</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="flex gap-4 text-[11px] text-gray-500">
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border bg-emerald-100 border-emerald-300" /> Current</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border bg-white border-gray-300" /> Superseded — still viewable</span>
        <span className="inline-flex items-center gap-1"><span className="w-3 h-3 rounded border bg-gray-50 border-gray-200" /> No revision at this number</span>
        <span className="text-gray-400">· ACTUAL = Rev 0, the original drawing — stays on screen while revisions scroll</span>
      </div>

      {viewing && (
        <RevisionViewer
          revision={viewing.revision}
          drawingNumber={viewing.drawing.drawing_number}
          current={viewing.current}
          onClose={() => setViewing(null)}
          onViewLatest={() => setViewing(v => ({ ...v, revision: v.current }))}
        />
      )}
      {uploadFor && (
        <UploadRevisionModal
          drawingId={uploadFor.id}
          drawingNumber={uploadFor.drawing_number}
          revisions={uploadFor.revisions}
          onClose={() => setUploadFor(null)}
          onSaved={() => { setUploadFor(null); load(); }}
        />
      )}
    </div>
  );
}

// ─── By Site ───────────────────────────────────────────────────────────
function SitesTab() {
  const [rows, setRows] = useState([]);
  const [openSite, setOpenSite] = useState(null);
  useEffect(() => {
    api.get('/drawing-tracker/sites').then(r => setRows(r.data || [])).catch(() => toast.error('Could not load sites'));
  }, []);

  if (openSite !== undefined && openSite !== null) {
    return <SiteDetail siteId={openSite} onBack={() => setOpenSite(null)} />;
  }

  return (
    <div className="card p-0 overflow-x-auto">
      <table className="min-w-full text-sm">
        <thead><tr className="bg-gray-50 text-xs text-gray-600">
          <th className="px-3 py-2 text-left">Site</th>
          <th className="px-3 py-2 text-right">Drawings</th>
          <th className="px-3 py-2 text-right">Total Revisions</th>
          <th className="px-3 py-2 text-left">Last Activity</th>
          <th className="px-3 py-2 text-center">Open</th>
        </tr></thead>
        <tbody className="divide-y divide-gray-100">
          {rows.map(s => (
            <tr key={String(s.site_id)} className="hover:bg-red-50/30 cursor-pointer" onClick={() => setOpenSite(s.site_id ?? 0)}>
              <td className="px-3 py-2 font-medium">{s.site_name}</td>
              <td className="px-3 py-2 text-right">{s.drawing_count}</td>
              <td className="px-3 py-2 text-right font-semibold text-blue-700">{s.revision_count}</td>
              <td className="px-3 py-2 text-xs">{fmtDate(s.last_activity)}</td>
              <td className="px-3 py-2 text-center"><FiChevronRight className="inline text-gray-400" /></td>
            </tr>
          ))}
          {rows.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No drawings at any site yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

// One site: its drawings, and a combined feed of every revision at that site.
function SiteDetail({ siteId, onBack }) {
  const [data, setData] = useState(null);
  const [sub, setSub] = useState('drawings');
  useEffect(() => {
    api.get(`/drawing-tracker/sites/${siteId}`).then(r => setData(r.data)).catch(() => toast.error('Could not load site'));
  }, [siteId]);
  if (!data) return <div className="text-sm text-gray-400">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <button onClick={onBack} className="btn btn-secondary text-xs">← All sites</button>
        <h2 className="text-lg font-semibold">{data.site?.name}</h2>
        <span className="text-xs text-gray-500">{data.totals.drawings} drawings · {data.totals.revisions} revisions</span>
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {[['drawings', 'Drawings', FiLayers], ['activity', 'Activity', FiClock]].map(([k, label, Icon]) => (
          <button key={k} onClick={() => setSub(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5 ${sub === k
              ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500'}`}>
            <Icon size={13} /> {label}
          </button>
        ))}
      </div>

      {sub === 'drawings' && (
        <div className="card p-0 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-600">
              <th className="px-3 py-2 text-left">Drawing No</th>
              <th className="px-3 py-2 text-left">Title</th>
              <th className="px-3 py-2 text-left">Discipline</th>
              <th className="px-3 py-2 text-center">Current</th>
              <th className="px-3 py-2 text-center">Versions</th>
              <th className="px-3 py-2 text-center">Open</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.drawings.map(d => (
                <tr key={d.id} className="hover:bg-red-50/30">
                  <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{d.drawing_number}</td>
                  <td className="px-3 py-2">{d.title || '—'}</td>
                  <td className="px-3 py-2 text-xs">{d.discipline || '—'}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${REV_CLS[d.current_status] || 'bg-gray-100'}`}>Rev {d.current_revision_no ?? '—'}</span>
                  </td>
                  <td className="px-3 py-2 text-center text-xs">{d.revision_count}</td>
                  <td className="px-3 py-2 text-center">
                    <Link to={`/drawing-tracker/${d.id}`} className="text-red-600 hover:underline text-xs">View</Link>
                  </td>
                </tr>
              ))}
              {data.drawings.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No drawings at this site</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {sub === 'activity' && (
        <div className="card p-4 space-y-2">
          {data.activity.map(a => (
            <div key={a.id} className="flex gap-3 items-start border-b border-gray-100 pb-2 last:border-0">
              <span className={`text-[10px] px-1.5 py-0.5 rounded mt-0.5 shrink-0 ${REV_CLS[a.status] || 'bg-gray-100'}`}>Rev {a.revision_no}</span>
              <div className="flex-1 min-w-0">
                <Link to={`/drawing-tracker/${a.drawing_id}`} className="font-mono text-xs font-bold text-red-600 hover:underline">{a.drawing_number}</Link>
                <span className="text-xs text-gray-500"> · {a.title || ''}</span>
                <div className="text-xs text-gray-600">{a.revision_description}</div>
                <div className="text-[10px] text-gray-400">{fmtDate(a.uploaded_at)} · {a.uploaded_by_name || '—'}{a.revision_reason ? ` · ${a.revision_reason}` : ''}</div>
              </div>
            </div>
          ))}
          {data.activity.length === 0 && <div className="text-center py-8 text-gray-400 text-sm">No revision activity at this site</div>}
        </div>
      )}
    </div>
  );
}

// ─── Reports ───────────────────────────────────────────────────────────
const REPORTS = [
  ['register', 'Drawing Register', ['Project', 'Site', 'Drawing No', 'Title', 'Discipline', 'Type', 'Current Rev', 'Status', 'Revisions', 'Last Revised'],
    r => [r.project_name, r.site_name, r.drawing_number, r.title, r.discipline, r.drawing_type, r.current_revision_no, r.current_status, r.revision_count, r.last_revised_at]],
  ['history', 'Revision History', ['Drawing No', 'Title', 'Rev', 'Date', 'Description', 'Reason', 'Status', 'Uploaded By'],
    r => [r.drawing_number, r.title, r.revision_no, r.revision_date, r.revision_description, r.revision_reason, r.status, r.uploaded_by_name]],
  ['superseded', 'Superseded Drawings', ['Drawing No', 'Title', 'Rev', 'Description', 'Superseded On', 'Uploaded By'],
    r => [r.drawing_number, r.title, r.revision_no, r.revision_description, r.uploaded_at, r.uploaded_by_name]],
  ['discipline', 'By Discipline', ['Discipline', 'Drawings', 'Revisions'], r => [r.discipline, r.drawings, r.revisions]],
  ['project', 'By Project', ['Project', 'Source', 'Drawings', 'Revisions'], r => [r.project, r.project_source, r.drawings, r.revisions]],
  ['site', 'By Site', ['Site', 'Drawings', 'Revisions'], r => [r.site, r.drawings, r.revisions]],
];

function ReportsTab() {
  const [kind, setKind] = useState('register');
  const [rows, setRows] = useState([]);
  const def = REPORTS.find(r => r[0] === kind);

  useEffect(() => {
    api.get(`/drawing-tracker/reports/${kind}`).then(r => setRows(r.data || [])).catch(() => toast.error('Could not load report'));
  }, [kind]);

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-2 items-center">
        <div className="flex gap-1 flex-wrap">
          {REPORTS.map(([k, label]) => (
            <button key={k} onClick={() => setKind(k)}
              className={`text-xs px-2 py-1 rounded border ${kind === k ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 text-gray-600'}`}>
              {label}
            </button>
          ))}
        </div>
        <div className="ml-auto flex gap-2">
          <button className="btn btn-secondary text-sm flex items-center gap-1"
            onClick={() => exportCsv(`drawing-${kind}`, def[2], rows.map(def[3]))}>
            <FiDownload size={14} /> Export CSV
          </button>
          <a href={`/drawing-register-print?kind=${kind}`} target="_blank" rel="noreferrer" className="btn btn-secondary text-sm flex items-center gap-1">
            <FiDownload size={14} /> Export PDF
          </a>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            {def[2].map(h => <th key={h} className="px-3 py-2 text-left">{h}</th>)}
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map((r, i) => (
              <tr key={r.id ?? i}>{def[3](r).map((c, j) => <td key={j} className="px-3 py-2 text-xs">{c ?? '—'}</td>)}</tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={def[2].length} className="text-center py-8 text-gray-400">Nothing to report yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
