// Tally Bills — Bill lifecycle: Upload → PMS Tasks → Approval → Payment
// (Director change request 2026-08-13; target 11.5 working days end-to-end).
//
// The Material / Testing & Commissioning / Handover tabs are FILTER CHIPS over
// ONE shared record set (spec §3) — a bill uploaded under any tab is visible in
// all of them; default view shows every category.
//
// Permission verbs (module `tally_bills`):
//   create  → Stage 1 upload          edit → Stage 5 record payment
//   approve → Stage 2 task sign-off + Stage 4 approve/hold/reject
//   admin   → Director acts: second approval, unlock, SLA settings
//
// Every action button rendered in the desktop table is mirrored in the
// `md:hidden` mobile card (mobile↔desktop parity rule).

import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDateTime, fmtDate } from '../utils/datetime';
import { exportCsv } from '../utils/exportCsv';
import {
  FiPlus, FiDownload, FiFilter, FiPaperclip, FiClock, FiCheckCircle,
  FiPauseCircle, FiPlayCircle, FiXCircle, FiUnlock, FiSettings, FiEye, FiTrash2,
} from 'react-icons/fi';

const CATS = [
  { id: '', label: 'All' },
  { id: 'material', label: 'Material' },
  { id: 'testing', label: 'Testing & Commissioning' },
  { id: 'handover', label: 'Handover' },
];

const STAGE_STATUSES = [
  ['', 'All stages'],
  ['pending_task_creation', 'Pending Task Creation'],
  ['tasks_in_progress', 'Tasks In Progress'],
  ['pending_approval', 'Pending Approval'],
  ['payment_pending', 'Payment Pending'],
  ['partially_paid', 'Partially Paid'],
  ['closed', 'Closed'],
  ['on_hold', 'On Hold'],
  ['rejected', 'Rejected'],
];

const inr = (n) => `Rs ${(+n || 0).toLocaleString('en-IN')}`;

// One register page. The server caps its own response too — this just sizes
// the request (hang-audit: unbounded register was the top finding).
const PAGE_SIZE = 200;

// Render ONLY the active layout instead of mounting the table and the mobile
// cards both (the CSS-hidden copy still costs DOM + reconcile time).
function useIsDesktop() {
  const [is, setIs] = useState(() => window.matchMedia('(min-width: 768px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 768px)');
    const fn = (e) => setIs(e.matches);
    mq.addEventListener('change', fn);
    return () => mq.removeEventListener('change', fn);
  }, []);
  return is;
}

// Green / Amber / Red pill (§7). Hold and closed get their own looks so a
// paused clock never reads as "someone is late".
function RagPill({ sla }) {
  if (!sla) return null;
  const map = {
    green: 'bg-emerald-100 text-emerald-700',
    amber: 'bg-amber-100 text-amber-700',
    red: 'bg-red-100 text-red-700',
    hold: 'bg-slate-200 text-slate-600',
    grey: 'bg-gray-100 text-gray-500',
  };
  const label = sla.on_hold ? 'ON HOLD' : sla.rag === 'red' ? (sla.overdue ? 'OVERDUE' : 'LATE') : sla.rag.toUpperCase();
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${map[sla.rag] || map.grey}`}>
      {label}{!sla.on_hold && sla.pct > 0 && sla.rag !== 'grey' ? ` · ${sla.pct}%` : ''}
    </span>
  );
}

function StatusBadgePill({ bill }) {
  const map = {
    pending_task_creation: 'bg-blue-50 text-blue-700 border-blue-200',
    tasks_in_progress: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    pending_approval: 'bg-purple-50 text-purple-700 border-purple-200',
    payment_pending: 'bg-amber-50 text-amber-700 border-amber-200',
    partially_paid: 'bg-orange-50 text-orange-700 border-orange-200',
    closed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    on_hold: 'bg-slate-100 text-slate-600 border-slate-300',
    rejected: 'bg-red-50 text-red-700 border-red-200',
  };
  return (
    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${map[bill.status] || ''}`}>
      {bill.status_label}
    </span>
  );
}

export default function TallyBills() {
  const { canCreate, canEdit, canDelete, canApprove, isAdmin } = useAuth();
  const admin = isAdmin();          // isAdmin is a function — call once, use the boolean
  const M = 'tally_bills';
  // Param is 'view', NOT 'tab': this page also renders embedded as a tab
  // inside Collections, whose own useUrlTab owns '?tab=' — sharing the key
  // would bounce the user out of the embed when switching to Reports.
  const [tab, setTab] = useUrlTab(['register', 'reports'], 'register', 'view');
  const [cat, setCat] = useUrlTab('', 'cat');

  const [bills, setBills] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState({ vendor: '', status: '', project_id: '', from: '', to: '', breached: false, search: '' });
  const [showFilters, setShowFilters] = useState(false);

  const [uploadModal, setUploadModal] = useState(false);
  // Deep link: /tally-bills?bill=123 (from notifications / escalations) —
  // resolved as the lazy initial value so no effect has to set state for it.
  const [detailId, setDetailId] = useState(() => {
    const id = new URLSearchParams(window.location.search).get('bill');
    return id ? +id : null;
  });
  const [settingsModal, setSettingsModal] = useState(false);
  const [page, setPage] = useState(0);
  const [total, setTotal] = useState(0);
  const isDesktop = useIsDesktop();

  // Text inputs (vendor/search) refetch only after a 400ms typing pause —
  // never per keystroke (hang-audit finding #5). Selects/chips stay instant.
  const [debouncedText, setDebouncedText] = useState({ vendor: '', search: '' });
  useEffect(() => {
    const t = setTimeout(() => setDebouncedText({ vendor: filters.vendor, search: filters.search }), 400);
    return () => clearTimeout(t);
  }, [filters.vendor, filters.search]);

  // Stale-response guard: only the latest request may land (out-of-order
  // responses on slow links would otherwise flash old pages).
  const loadSeq = useRef(0);

  // All setState here happens inside .then/.finally (async), never in the
  // effect body itself — react-hooks/set-state-in-effect stays quiet.
  const load = useCallback(() => {
    const p = new URLSearchParams();
    if (cat) p.set('category', cat);
    if (filters.project_id) p.set('project_id', filters.project_id);
    if (filters.status) p.set('status', filters.status);
    if (filters.from) p.set('from', filters.from);
    if (filters.to) p.set('to', filters.to);
    if (filters.breached) p.set('breached', '1');
    if (debouncedText.vendor) p.set('vendor', debouncedText.vendor);
    if (debouncedText.search) p.set('search', debouncedText.search);
    p.set('limit', String(PAGE_SIZE));
    p.set('offset', String(page * PAGE_SIZE));
    const seq = ++loadSeq.current;
    api.get(`/tally-bills?${p.toString()}`)
      .then(r => {
        if (seq !== loadSeq.current) return;               // a newer request superseded us
        setBills(r.data);
        setTotal(parseInt(r.headers['x-total-count'], 10) || r.data.length);
      })
      .catch(e => { if (seq === loadSeq.current) toast.error(e.response?.data?.error || 'Failed to load bills'); })
      .finally(() => { if (seq === loadSeq.current) setLoading(false); });
  }, [cat, filters.project_id, filters.status, filters.from, filters.to, filters.breached, debouncedText, page]);

  useEffect(() => { load(); }, [load]);

  // Any filter/tab change starts back at page 0 (done in the change handlers,
  // not an effect, to avoid a sync-setState-in-effect render cascade).
  const updFilter = (patch) => { setFilters(f => ({ ...f, ...patch })); setPage(0); };
  const pickCat = (id) => { setCat(id); setPage(0); };
  useEffect(() => { api.get('/tally-bills/meta').then(r => setMeta(r.data)).catch(() => {}); }, []);

  const exportRegister = () => exportCsv('tally-bill-register',
    ['Register No', 'Bill No', 'Vendor', 'Project', 'Category', 'Bill Amount', 'Approved', 'Variance', 'Received', 'Stage', 'Owner', 'Days in Stage', 'SLA', 'Total Days', 'Status'],
    bills.map(b => [b.register_no, b.bill_number, b.vendor_name, b.project_name, b.category_label,
      b.bill_amount, b.approved_amount ?? '', b.variance_amount ?? '', b.amount_received,
      b.sla.current_stage_label, b.current_owner_name ?? '', b.sla.days_in_stage,
      b.sla.on_hold ? 'HOLD' : b.sla.rag.toUpperCase(), b.sla.total_days_since_upload, b.status_label]));

  return (
    <div className="space-y-4">
      {/* Header row: page tabs + actions */}
      <div className="flex gap-2 flex-wrap items-center justify-between">
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('register')} className={`btn ${tab === 'register' ? 'btn-primary' : 'btn-secondary'}`}>Bill Register</button>
          <button onClick={() => setTab('reports')} className={`btn ${tab === 'reports' ? 'btn-primary' : 'btn-secondary'}`}>Reports</button>
        </div>
        <div className="flex gap-2 flex-wrap">
          {admin && (
            <button onClick={() => setSettingsModal(true)} className="btn btn-secondary flex items-center gap-1 text-sm" title="SLA rules + stage owners">
              <FiSettings /> SLA Settings
            </button>
          )}
          {tab === 'register' && (
            <button onClick={exportRegister} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload /> Export Excel</button>
          )}
          {canCreate(M) && (
            <button onClick={() => setUploadModal(true)} className="btn btn-primary flex items-center gap-2"><FiPlus /> Upload Tally Bill</button>
          )}
        </div>
      </div>

      {tab === 'register' && (
        <>
          {/* Category filter chips — §3: default All, one chip per category */}
          <div className="flex gap-1 flex-wrap items-center">
            {CATS.map(c => (
              <button key={c.id} onClick={() => pickCat(c.id)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold border transition ${
                  cat === c.id
                    ? 'bg-blue-700 text-white border-blue-700 shadow-sm'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300 hover:text-blue-700'
                }`}>
                {c.label}
              </button>
            ))}
            <button onClick={() => setShowFilters(s => !s)}
              className={`ml-auto btn btn-secondary flex items-center gap-1 text-sm ${showFilters ? 'ring-2 ring-blue-300' : ''}`}>
              <FiFilter /> Filters
            </button>
          </div>

          {showFilters && (
            <div className="card p-3 grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
              <div>
                <label className="label text-[11px]">Project</label>
                <select className="select text-sm" value={filters.project_id} onChange={e => updFilter({ project_id: e.target.value })}>
                  <option value="">All</option>
                  {(meta?.projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div>
                <label className="label text-[11px]">Vendor</label>
                <input className="input text-sm" value={filters.vendor} onChange={e => updFilter({ vendor: e.target.value })} placeholder="Vendor name" />
              </div>
              <div>
                <label className="label text-[11px]">Stage</label>
                <select className="select text-sm" value={filters.status} onChange={e => updFilter({ status: e.target.value })}>
                  {STAGE_STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </div>
              <div>
                <label className="label text-[11px]">From</label>
                <input className="input text-sm" type="date" value={filters.from} onChange={e => updFilter({ from: e.target.value })} />
              </div>
              <div>
                <label className="label text-[11px]">To</label>
                <input className="input text-sm" type="date" value={filters.to} onChange={e => updFilter({ to: e.target.value })} />
              </div>
              <div>
                <label className="label text-[11px]">Search</label>
                <input className="input text-sm" value={filters.search} onChange={e => updFilter({ search: e.target.value })} placeholder="Bill no / register / project" />
              </div>
              <label className="flex items-center gap-2 text-xs font-semibold text-red-700 pb-2 cursor-pointer">
                <input type="checkbox" checked={filters.breached} onChange={e => updFilter({ breached: e.target.checked })} />
                SLA breached only
              </label>
            </div>
          )}

          {/* ── Desktop register (only the ACTIVE layout is mounted) ── */}
          {isDesktop && <div className="card p-0 overflow-x-auto">
            <table className="freeze-head">
              <thead><tr>
                <th>Bill</th><th>Vendor</th><th>Project</th><th>Category</th>
                <th className="text-right">Bill Amt</th><th className="text-right">Approved</th>
                <th className="text-right">Variance</th><th>Stage</th><th>Owner</th>
                <th className="text-right">Days in Stage</th><th>SLA</th>
                <th className="text-right">Total Days</th><th>Actions</th>
              </tr></thead>
              <tbody>
                {bills.map(b => (
                  <tr key={b.id} className="cursor-pointer hover:bg-blue-50/40" onClick={() => setDetailId(b.id)}>
                    <td>
                      <div className="font-medium">{b.bill_number}</div>
                      <div className="text-[10px] text-gray-400">{b.register_no} · {fmtDate(b.bill_date)}</div>
                    </td>
                    <td>{b.vendor_name}</td>
                    <td className="max-w-[160px] truncate">{b.project_name}</td>
                    <td><span className="text-xs">{b.category_label}</span></td>
                    <td className="text-right tabular-nums font-semibold">{inr(b.bill_amount)}</td>
                    <td className="text-right tabular-nums">{b.approved_amount != null ? inr(b.approved_amount) : '—'}</td>
                    <td className={`text-right tabular-nums ${b.variance_amount ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
                      {b.variance_amount != null && b.variance_amount !== 0 ? `${inr(b.variance_amount)} (${b.variance_pct}%)` : '—'}
                    </td>
                    <td><StatusBadgePill bill={b} /></td>
                    <td className="text-xs">{b.current_owner_name || '—'}</td>
                    <td className="text-right tabular-nums">{b.sla.days_in_stage}</td>
                    <td><RagPill sla={b.sla} /></td>
                    <td className="text-right tabular-nums">{b.sla.total_days_since_upload}</td>
                    <td onClick={e => e.stopPropagation()}>
                      <div className="flex gap-1">
                        <button onClick={() => setDetailId(b.id)} className="p-1 text-gray-400 hover:text-blue-600" title="Open"><FiEye size={15} /></button>
                        {canDelete(M) && (
                          <button onClick={async () => {
                            if (!confirm(`Delete bill "${b.bill_number}" (${b.register_no})?`)) return;
                            try { await api.delete(`/tally-bills/${b.id}`); toast.success('Deleted'); load(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                          }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={15} /></button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {!loading && bills.length === 0 && (
                  <tr><td colSpan="13" className="text-center py-10 text-gray-400">No bills yet — upload the first Tally bill</td></tr>
                )}
              </tbody>
            </table>
          </div>}

          {/* ── Mobile cards (parity: open + delete mirrored) ── */}
          {!isDesktop && <div className="space-y-2">
            {bills.map(b => (
              <div key={b.id} className="card p-3 space-y-2" onClick={() => setDetailId(b.id)}>
                <div className="flex justify-between items-start gap-2">
                  <div>
                    <div className="font-semibold text-sm">{b.bill_number} <span className="text-[10px] text-gray-400 font-normal">{b.register_no}</span></div>
                    <div className="text-xs text-gray-500">{b.vendor_name} · {b.category_label}</div>
                    <div className="text-[11px] text-gray-400 truncate max-w-[220px]">{b.project_name}</div>
                  </div>
                  <div className="text-right shrink-0">
                    <div className="font-bold tabular-nums text-sm">{inr(b.bill_amount)}</div>
                    <RagPill sla={b.sla} />
                  </div>
                </div>
                <div className="flex justify-between items-center text-[11px] text-gray-500">
                  <StatusBadgePill bill={b} />
                  <span>{b.current_owner_name || '—'} · {b.sla.days_in_stage}d in stage · {b.sla.total_days_since_upload}d total</span>
                </div>
                <div className="flex justify-end gap-3 pt-1 border-t border-gray-100" onClick={e => e.stopPropagation()}>
                  <button onClick={() => setDetailId(b.id)} className="text-blue-600 text-xs font-semibold flex items-center gap-1"><FiEye size={13} /> Open</button>
                  {canDelete(M) && (
                    <button onClick={async () => {
                      if (!confirm(`Delete bill "${b.bill_number}"?`)) return;
                      try { await api.delete(`/tally-bills/${b.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="text-red-500 text-xs font-semibold flex items-center gap-1"><FiTrash2 size={13} /> Delete</button>
                  )}
                </div>
              </div>
            ))}
            {!loading && bills.length === 0 && <div className="card p-8 text-center text-gray-400 text-sm">No bills yet</div>}
          </div>}

          {/* Pager — the register is paginated server-side (200/page) */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-3 text-xs text-gray-600">
              <button disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}
                className="btn btn-secondary text-xs py-1 disabled:opacity-40">‹ Prev</button>
              <span className="tabular-nums">
                Showing {page * PAGE_SIZE + 1}–{Math.min(total, (page + 1) * PAGE_SIZE)} of {total}
              </span>
              <button disabled={(page + 1) * PAGE_SIZE >= total} onClick={() => setPage(p => p + 1)}
                className="btn btn-secondary text-xs py-1 disabled:opacity-40">Next ›</button>
            </div>
          )}
        </>
      )}

      {tab === 'reports' && <ReportsTab />}

      {uploadModal && meta && (
        <UploadModal meta={meta} onClose={() => setUploadModal(false)} onSaved={() => { setUploadModal(false); load(); }} />
      )}
      {detailId && (
        <DetailModal id={detailId} meta={meta}
          canEditM={canEdit(M)} canApproveM={canApprove(M)} canDeleteM={canDelete(M)} isAdmin={admin}
          onClose={() => { setDetailId(null); load(); }} />
      )}
      {settingsModal && <SettingsModal onClose={() => setSettingsModal(false)} />}
    </div>
  );
}

// ─── Stage 1: upload modal ───────────────────────────────────────────
function UploadModal({ meta, onClose, onSaved }) {
  const [form, setForm] = useState({ project_id: '', site_id: '', category: 'material', vendor_id: '', vendor_name: '', bill_number: '', bill_date: '', bill_amount: '', remarks: '' });
  const [files, setFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (!files.length) return toast.error('Attach the Tally bill (PDF/JPG/PNG)');
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) if (v !== '') fd.append(k, v);
    for (const f of files) fd.append('files', f);
    setBusy(true);
    try {
      await api.post('/tally-bills', fd);
      toast.success('Bill uploaded — SLA clock started');
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally { setBusy(false); }
  };

  const pickVendor = (id) => {
    const v = (meta.vendors || []).find(x => String(x.id) === String(id));
    setForm(f => ({ ...f, vendor_id: id, vendor_name: v ? (v.firm_name || v.name) : f.vendor_name }));
  };

  return (
    <Modal isOpen onClose={onClose} title="Upload Tally Bill (Stage 1)">
      <form onSubmit={save} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div>
            <label className="label">Project / Site *</label>
            <select className="select" value={form.project_id} onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))} required>
              <option value="">Select project</option>
              {(meta.projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Category *</label>
            <select className="select" value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} required>
              <option value="material">Material</option>
              <option value="testing">Testing & Commissioning</option>
              <option value="handover">Handover</option>
            </select>
          </div>
          <div>
            <label className="label">Vendor *</label>
            <select className="select" value={form.vendor_id} onChange={e => pickVendor(e.target.value)}>
              <option value="">— pick from master —</option>
              {(meta.vendors || []).map(v => <option key={v.id} value={v.id}>{v.firm_name || v.name}</option>)}
            </select>
            <input className="input mt-1 text-sm" placeholder="…or type vendor name" value={form.vendor_name}
              onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value, vendor_id: '' }))} required />
          </div>
          <div>
            <label className="label">Bill Number *</label>
            <input className="input" value={form.bill_number} onChange={e => setForm(f => ({ ...f, bill_number: e.target.value }))} required />
            <p className="text-[10px] text-gray-400 mt-0.5">Must be unique for this vendor</p>
          </div>
          <div>
            <label className="label">Bill Date *</label>
            <input className="input" type="date" value={form.bill_date} onChange={e => setForm(f => ({ ...f, bill_date: e.target.value }))} required />
          </div>
          <div>
            <label className="label">Bill Amount (Rs) *</label>
            <input className="input text-right tabular-nums" type="number" step="0.01" min="0.01" value={form.bill_amount}
              onChange={e => setForm(f => ({ ...f, bill_amount: e.target.value }))} required />
          </div>
        </div>
        <div>
          <label className="label">Upload Bill * <span className="text-[10px] text-gray-400">(PDF / JPG / PNG · max 10 MB each · multiple allowed)</span></label>
          <input className="input" type="file" multiple accept=".pdf,.jpg,.jpeg,.png"
            onChange={e => setFiles([...e.target.files])} />
          {files.length > 0 && <p className="text-xs text-emerald-700 mt-1">{files.length} file(s) selected</p>}
        </div>
        <div>
          <label className="label">Remarks</label>
          <textarea className="input" rows="2" value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
        </div>
        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Uploading…' : 'Upload & Start Clock'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── Detail modal: stage timeline + all stage actions ────────────────
function DetailModal({ id, meta, canEditM, canApproveM, canDeleteM, isAdmin, onClose }) {
  const [d, setD] = useState(null);
  const [action, setAction] = useState(null);   // 'task' | 'approve' | 'hold' | 'reject' | 'payment' | 'unlock' | null
  const [form, setForm] = useState({});
  const [payFiles, setPayFiles] = useState([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api.get(`/tally-bills/${id}`).then(r => setD(r.data))
      .catch(e => { toast.error(e.response?.data?.error || 'Failed to load bill'); onClose(); });
  }, [id, onClose]);
  useEffect(() => { load(); }, [load]);

  if (!d) return <Modal isOpen onClose={onClose} title="Loading…"><div className="py-10 text-center text-gray-400">Loading…</div></Modal>;

  const act = async (path, body = {}, msg = 'Done') => {
    setBusy(true);
    try {
      await api.post(`/tally-bills/${id}/${path}`, body);
      toast.success(msg); setAction(null); setForm({}); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Action failed'); }
    finally { setBusy(false); }
  };

  const submitPayment = async (e) => {
    e.preventDefault();
    const fd = new FormData();
    fd.append('amount', form.amount || '');
    fd.append('received_date', form.received_date || '');
    if (form.utr_ref) fd.append('utr_ref', form.utr_ref);
    if (form.remarks) fd.append('remarks', form.remarks);
    for (const f of payFiles) fd.append('files', f);
    setBusy(true);
    try {
      const r = await api.post(`/tally-bills/${id}/payments`, fd);
      toast.success(r.data.status === 'closed' ? 'Balance cleared — bill CLOSED' : `Recorded · balance ${inr(r.data.balance)}`);
      setAction(null); setForm({}); setPayFiles([]); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Payment failed'); }
    finally { setBusy(false); }
  };

  const stages = d.sla?.stages || {};
  const stageRows = [
    { key: 'upload', label: 'Bill Uploaded (T0)', at: d.t0_uploaded_at, always: true },
    { key: 'task_creation', label: 'PMS Tasks Created (T1)', at: d.t1_tasks_created_at, s: stages.task_creation },
    { key: 'task_completion', label: 'Tasks Completed (T2)', at: d.t2_tasks_completed_at, s: stages.task_completion },
    { key: 'approval', label: 'Approved (T3)', at: d.t3_approved_at, s: stages.approval },
    { key: 'payment', label: 'Payment Complete (T4)', at: d.t4_closed_at, s: stages.payment },
  ];

  const balance = d.approved_amount != null ? Math.round(((+d.approved_amount || 0) - (+d.amount_received || 0)) * 100) / 100 : null;
  const live = !['closed', 'rejected'].includes(d.status);
  const secondPending = !!d.second_approval_required && !d.t3_approved_at;

  return (
    <Modal isOpen onClose={onClose} title={`${d.register_no} — ${d.bill_number}`} xwide>
      <div className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">

        {/* Summary strip */}
        <div className="flex flex-wrap gap-2 items-center">
          <StatusBadgePill bill={d} />
          <RagPill sla={d.sla} />
          {d.locked === 1 && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-gray-800 text-white">LOCKED</span>}
          {secondPending && <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-600 text-white">AWAITING DIRECTOR</span>}
          <span className="text-xs text-gray-500 ml-auto">{d.category_label} · {d.project_name} · uploaded {fmtDateTime(d.t0_uploaded_at)}</span>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="card p-2"><div className="text-[10px] text-gray-400">Vendor</div><div className="text-sm font-semibold">{d.vendor_name}</div></div>
          <div className="card p-2"><div className="text-[10px] text-gray-400">Bill Amount</div><div className="text-sm font-bold tabular-nums">{inr(d.bill_amount)}</div></div>
          <div className="card p-2"><div className="text-[10px] text-gray-400">Approved</div><div className="text-sm font-bold tabular-nums">{d.approved_amount != null ? inr(d.approved_amount) : '—'}</div>
            {d.variance_amount ? <div className="text-[10px] text-red-600">variance {inr(d.variance_amount)} ({d.variance_pct}%)</div> : null}</div>
          <div className="card p-2"><div className="text-[10px] text-gray-400">Received / Balance</div>
            <div className="text-sm font-bold tabular-nums text-emerald-700">{inr(d.amount_received)}</div>
            {balance != null && balance > 0 && <div className="text-[10px] text-red-600 font-semibold">balance {inr(balance)}</div>}</div>
        </div>

        {/* Stage timeline — owner, due, actual, on-time (§6) */}
        <div className="card p-3">
          <h4 className="text-xs font-bold text-gray-500 uppercase mb-2 flex items-center gap-1"><FiClock /> Stage Clock</h4>
          <div className="space-y-1.5">
            {stageRows.map(r => {
              const done = !!r.at;
              const s = r.s;
              return (
                <div key={r.key} className="flex items-center gap-2 text-xs">
                  <span className={`w-4 h-4 rounded-full flex items-center justify-center shrink-0 ${done ? 'bg-emerald-500 text-white' : s ? 'bg-amber-400 text-white' : 'bg-gray-200'}`}>
                    {done ? <FiCheckCircle size={10} /> : null}
                  </span>
                  <span className={`w-44 shrink-0 ${done ? 'font-medium' : 'text-gray-500'}`}>{r.label}</span>
                  <span className="text-gray-500 w-36 shrink-0">{done ? fmtDateTime(r.at) : s ? `due ${fmtDateTime(s.due_at)}` : '—'}</span>
                  {s && (
                    <span className={`tabular-nums ${s.on_time === false || s.overdue ? 'text-red-600 font-semibold' : s.on_time ? 'text-emerald-600' : 'text-gray-500'}`}>
                      {s.elapsed_days}d / {s.budget_days}d
                      {s.on_time === true && ' · on time'}
                      {s.on_time === false && ` · late ${s.delay} ${s.unit}`}
                      {s.on_time === null && s.overdue && ` · OVERDUE`}
                    </span>
                  )}
                </div>
              );
            })}
            {d.sla?.hold_hours > 0 && <div className="text-[11px] text-slate-500 pl-6">Held for {d.sla.hold_hours} business hrs (clock paused)</div>}
          </div>
        </div>

        {/* Attachments */}
        <div className="card p-3">
          <h4 className="text-xs font-bold text-gray-500 uppercase mb-2 flex items-center gap-1"><FiPaperclip /> Bill Attachments</h4>
          <div className="flex flex-wrap gap-2">
            {d.files.filter(f => f.kind === 'bill').map(f => (
              <a key={f.id} href={f.file_url} target="_blank" rel="noreferrer"
                className="px-2 py-1 bg-blue-50 text-blue-700 rounded text-xs hover:bg-blue-100">{f.file_name || 'file'}</a>
            ))}
            {d.files.filter(f => f.kind === 'bill').length === 0 && <span className="text-xs text-gray-400">None</span>}
          </div>
        </div>

        {/* Linked PMS tasks */}
        <div className="card p-3">
          <div className="flex justify-between items-center mb-2">
            <h4 className="text-xs font-bold text-gray-500 uppercase">PMS Tasks ({d.tasks.length})</h4>
            {canApproveM && live && !d.t2_tasks_completed_at && (
              <div className="flex gap-2">
                <button onClick={() => { setAction('task'); setForm({}); }} className="btn btn-secondary text-xs py-1">+ Add Task</button>
                {!d.t1_tasks_created_at && d.tasks.length > 0 && (
                  <button onClick={() => act('tasks-complete', {}, 'Task creation complete — T1 stamped')} disabled={busy}
                    className="btn btn-primary text-xs py-1">Task Creation Complete</button>
                )}
              </div>
            )}
          </div>
          {d.tasks.length === 0 && <p className="text-xs text-gray-400">No tasks yet{d.status === 'pending_task_creation' ? ' — create tasks, then mark Task Creation Complete' : ''}</p>}
          {d.tasks.map(t => (
            <div key={t.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50 last:border-0">
              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${t.status === 'approved' ? 'bg-emerald-100 text-emerald-700' : t.status === 'submitted' ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-600'}`}>{t.status}</span>
              <span className="font-medium">{t.title}</span>
              <span className="text-gray-400 ml-auto">{t.assigned_to_name || '—'}{t.due_date ? ` · due ${fmtDate(t.due_date)}` : ''}</span>
            </div>
          ))}
          {action === 'task' && (
            <form onSubmit={e => { e.preventDefault(); act('tasks', form, 'Task created'); }} className="mt-2 p-2 bg-gray-50 rounded space-y-2">
              <input className="input text-sm" placeholder="Task title *" value={form.title || ''} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} required />
              <div className="grid grid-cols-2 gap-2">
                <select className="select text-sm" value={form.assigned_to || ''} onChange={e => setForm(f => ({ ...f, assigned_to: e.target.value }))} required>
                  <option value="">Assign to *</option>
                  {(meta?.users || []).map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
                <input className="input text-sm" type="date" value={form.due_date || ''} onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))} />
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setAction(null)} className="btn btn-secondary text-xs py-1">Cancel</button>
                <button type="submit" disabled={busy} className="btn btn-primary text-xs py-1">Create Task</button>
              </div>
            </form>
          )}
        </div>

        {/* Stage 4 — approval block */}
        {d.status === 'pending_approval' && canApproveM && !secondPending && (
          <div className="card p-3 border-purple-200 bg-purple-50/40">
            <h4 className="text-xs font-bold text-purple-700 uppercase mb-2">Approval + Payment Release (4 business hrs)</h4>
            {action !== 'approve' ? (
              <div className="flex flex-wrap gap-2">
                <button onClick={() => { setAction('approve'); setForm({ approved_amount: d.bill_amount }); }} className="btn btn-primary text-sm flex items-center gap-1"><FiCheckCircle /> Approve</button>
                <button onClick={() => { setAction('hold'); setForm({}); }} className="btn btn-secondary text-sm flex items-center gap-1"><FiPauseCircle /> Hold</button>
                <button onClick={() => { setAction('reject'); setForm({}); }} className="btn btn-secondary text-sm text-red-600 flex items-center gap-1"><FiXCircle /> Reject</button>
              </div>
            ) : (
              <form onSubmit={e => { e.preventDefault(); act('approve', form, 'Approved — payment pending'); }} className="space-y-2">
                {/* Server treats an EMPTY amount as "approve as billed" (spec §4:
                    default = Tally amount) — mirrored below so a cleared field
                    doesn't flash a bogus "remark mandatory" warning. */}
                <div>
                  <label className="label text-[11px]">Payment Amount (pre-filled = Tally amount)</label>
                  <input className="input text-right tabular-nums" type="number" step="0.01" value={form.approved_amount}
                    onChange={e => setForm(f => ({ ...f, approved_amount: e.target.value }))} />
                  {form.approved_amount !== '' && +form.approved_amount !== +d.bill_amount && (
                    <p className="text-[11px] text-red-600 mt-0.5 font-semibold">
                      Amount differs from bill ({inr(d.bill_amount)}) — remark is mandatory.
                      Variance {inr((+d.bill_amount || 0) - (+form.approved_amount || 0))}
                    </p>
                  )}
                </div>
                <textarea className="input text-sm" rows="2"
                  placeholder={form.approved_amount !== '' && +form.approved_amount !== +d.bill_amount ? 'Remark (mandatory — amount edited)' : 'Remark (optional)'}
                  value={form.remark || ''} onChange={e => setForm(f => ({ ...f, remark: e.target.value }))} />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAction(null)} className="btn btn-secondary text-xs py-1">Cancel</button>
                  <button type="submit" disabled={busy} className="btn btn-primary text-xs py-1">Confirm Approval</button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Director second approval */}
        {secondPending && isAdmin && (
          <div className="card p-3 border-purple-300 bg-purple-50">
            <h4 className="text-xs font-bold text-purple-700 uppercase mb-1">Director Second Approval Required</h4>
            <p className="text-xs text-gray-600 mb-2">Approved {inr(d.approved_amount)} exceeds bill {inr(d.bill_amount)}.</p>
            <form onSubmit={e => { e.preventDefault(); act('second-approve', form, 'Second approval given'); }} className="flex gap-2">
              <input className="input text-sm flex-1" placeholder="Remark (required)" value={form.remark || ''} onChange={e => setForm(f => ({ ...f, remark: e.target.value }))} required />
              <button type="submit" disabled={busy} className="btn btn-primary text-sm">Approve as Director</button>
            </form>
          </div>
        )}

        {/* Hold / reject / release / unlock row */}
        <div className="flex flex-wrap gap-2">
          {live && d.status !== 'on_hold' && d.status !== 'pending_approval' && canApproveM && (
            <>
              <button onClick={() => { setAction('hold'); setForm({}); }} className="btn btn-secondary text-xs flex items-center gap-1"><FiPauseCircle /> Hold</button>
              <button onClick={() => { setAction('reject'); setForm({}); }} className="btn btn-secondary text-xs text-red-600 flex items-center gap-1"><FiXCircle /> Reject</button>
            </>
          )}
          {d.status === 'on_hold' && canApproveM && (
            <button onClick={() => act('release', {}, 'Hold released — clock resumed')} disabled={busy}
              className="btn btn-primary text-xs flex items-center gap-1"><FiPlayCircle /> Release Hold</button>
          )}
          {d.locked === 1 && isAdmin && (
            <button onClick={() => { setAction('unlock'); setForm({}); }} className="btn btn-secondary text-xs flex items-center gap-1"><FiUnlock /> Director Unlock</button>
          )}
        </div>

        {(action === 'hold' || action === 'reject' || action === 'unlock') && (
          <form onSubmit={e => {
            e.preventDefault();
            if (action === 'hold') act('hold', { reason: form.reason }, 'Bill on hold — clock paused');
            if (action === 'reject') act('reject', { reason: form.reason }, 'Bill rejected');
            if (action === 'unlock') act('unlock', { reason: form.reason }, 'Bill unlocked');
          }} className="card p-3 bg-gray-50 flex gap-2">
            <input className="input text-sm flex-1" placeholder={`Reason for ${action} (required)`} value={form.reason || ''}
              onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} required />
            <button type="button" onClick={() => setAction(null)} className="btn btn-secondary text-xs">Cancel</button>
            <button type="submit" disabled={busy} className={`btn text-xs ${action === 'reject' ? 'bg-red-600 text-white hover:bg-red-700' : 'btn-primary'}`}>Confirm {action}</button>
          </form>
        )}

        {/* Stage 5 — payments */}
        {(d.status === 'payment_pending' || d.status === 'partially_paid' || d.payments.length > 0) && (
          <div className="card p-3">
            <div className="flex justify-between items-center mb-2">
              <h4 className="text-xs font-bold text-gray-500 uppercase">Payments {d.payment_expected_date ? `· expected by ${fmtDate(d.payment_expected_date)}` : ''}</h4>
              {canEditM && live && d.t3_approved_at && balance > 0 && (
                <button onClick={() => { setAction('payment'); setForm({}); }} className="btn btn-primary text-xs py-1">+ Record Payment</button>
              )}
            </div>
            {d.payments.map(p => (
              <div key={p.id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-50 last:border-0">
                <span className="font-semibold tabular-nums text-emerald-700">{inr(p.amount)}</span>
                <span className="text-gray-500">{fmtDate(p.received_date)}</span>
                {p.utr_ref && <span className="text-gray-400">UTR {p.utr_ref}</span>}
                {p.proof_url && <a href={p.proof_url} target="_blank" rel="noreferrer" className="text-blue-600">proof</a>}
                <span className="text-gray-400 ml-auto">{p.created_by_name}</span>
                {canDeleteM && (
                  <button onClick={async () => {
                    if (!confirm(`Reverse payment of ${inr(p.amount)}?`)) return;
                    try { await api.delete(`/tally-bills/${id}/payments/${p.id}`); toast.success('Payment reversed'); load(); }
                    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                  }} className="p-0.5 text-gray-300 hover:text-red-600"><FiTrash2 size={12} /></button>
                )}
              </div>
            ))}
            {d.payments.length === 0 && <p className="text-xs text-gray-400">None yet</p>}
            {action === 'payment' && (
              <form onSubmit={submitPayment} className="mt-2 p-2 bg-gray-50 rounded space-y-2">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="label text-[11px]">Amount Received * <span className="text-gray-400">(balance {inr(balance)})</span></label>
                    <input className="input text-sm text-right tabular-nums" type="number" step="0.01" min="0.01" value={form.amount || ''}
                      onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} required />
                  </div>
                  <div>
                    <label className="label text-[11px]">Received Date *</label>
                    <input className="input text-sm" type="date" value={form.received_date || ''} onChange={e => setForm(f => ({ ...f, received_date: e.target.value }))} required />
                  </div>
                  <input className="input text-sm" placeholder="UTR / Reference No." value={form.utr_ref || ''} onChange={e => setForm(f => ({ ...f, utr_ref: e.target.value }))} />
                  <input className="input text-sm" type="file" accept=".pdf,.jpg,.jpeg,.png" onChange={e => setPayFiles([...e.target.files])} />
                </div>
                <input className="input text-sm" placeholder="Remarks" value={form.remarks || ''} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
                <div className="flex justify-end gap-2">
                  <button type="button" onClick={() => setAction(null)} className="btn btn-secondary text-xs py-1">Cancel</button>
                  <button type="submit" disabled={busy} className="btn btn-primary text-xs py-1">Save Payment</button>
                </div>
              </form>
            )}
          </div>
        )}

        {/* Audit trail (§9) */}
        <details className="card p-3">
          <summary className="text-xs font-bold text-gray-500 uppercase cursor-pointer">Audit Trail ({d.audit.length})</summary>
          <div className="mt-2 space-y-1 max-h-56 overflow-y-auto">
            {d.audit.map(a => (
              <div key={a.id} className="text-[11px] text-gray-600 flex gap-2 border-b border-gray-50 py-0.5">
                <span className="text-gray-400 shrink-0 w-28">{fmtDateTime(a.at)}</span>
                <span className="font-medium shrink-0">{a.user_name || 'system'}</span>
                <span>
                  {a.action}{a.field ? ` · ${a.field}` : ''}
                  {a.old_value != null || a.new_value != null ? `: ${a.old_value ?? '—'} → ${a.new_value ?? '—'}` : ''}
                  {a.note ? ` (${a.note})` : ''}
                </span>
              </div>
            ))}
          </div>
        </details>
      </div>
    </Modal>
  );
}

// ─── Reports tab (§7) ────────────────────────────────────────────────
function ReportsTab() {
  const [kind, setKind] = useUrlTab('sla-compliance', 'report');
  // Stored as {kind, rows} so a kind switch never renders the previous
  // report's payload under the wrong renderer (their shapes differ).
  const [report, setReport] = useState(null);
  const [range, setRange] = useState({ from: '', to: '' });
  const data = report?.kind === kind ? report.rows : null;

  // Reports are the heaviest endpoints — debounce date-input changes and let
  // only the latest response land (kind check alone can't catch range races).
  const [debouncedRange, setDebouncedRange] = useState(range);
  useEffect(() => {
    const t = setTimeout(() => setDebouncedRange(range), 400);
    return () => clearTimeout(t);
  }, [range]);
  const seqRef = useRef(0);

  useEffect(() => {
    const p = new URLSearchParams();
    if (debouncedRange.from) p.set('from', debouncedRange.from);
    if (debouncedRange.to) p.set('to', debouncedRange.to);
    const seq = ++seqRef.current;
    api.get(`/tally-bills/reports/${kind}?${p}`)
      .then(r => { if (seq === seqRef.current) setReport({ kind, rows: r.data }); })
      .catch(e => { if (seq === seqRef.current) toast.error(e.response?.data?.error || 'Report failed'); });
  }, [kind, debouncedRange]);

  const kinds = [
    ['sla-compliance', 'SLA Compliance'],
    ['ageing', 'Ageing'],
    ['bottleneck', 'Bottleneck'],
    ['variance', 'Payment Variance'],
    ['outstanding', 'Outstanding'],
  ];

  const exportReport = () => {
    if (!data) return;
    if (kind === 'sla-compliance') {
      exportCsv('sla-compliance-by-stage', ['Stage', 'Completed', 'On Time', 'Compliance %', 'Avg Delay'],
        data.by_stage.map(s => [s.stage, s.total, s.on_time, s.compliance_pct, s.avg_delay]));
      exportCsv('sla-compliance-by-person', ['Person', 'Stages Done', 'On Time', 'Compliance %'],
        data.by_person.map(p => [p.person, p.total, p.on_time, p.compliance_pct]));
    } else if (kind === 'ageing') {
      exportCsv('ageing', ['Bucket', 'Bill', 'Vendor', 'Project', 'Amount', 'Days', 'Stage'],
        data.flatMap(b => b.items.map(i => [b.bucket, i.bill_number, i.vendor_name, i.project_name, i.bill_amount, i.days, i.stage])));
    } else if (kind === 'bottleneck') {
      exportCsv('bottleneck', ['Stage', 'Bills', 'Avg Days', 'Budget Days', 'Breaches'],
        data.map(r => [r.stage, r.samples, r.avg_days, r.budget_days, r.breaches]));
    } else if (kind === 'variance') {
      exportCsv('payment-variance', ['Bill', 'Vendor', 'Project', 'Bill Amt', 'Approved', 'Received', 'Variance', 'Variance %', 'Remark'],
        data.map(r => [r.bill_number, r.vendor_name, r.project_name, r.bill_amount, r.approved_amount, r.received_amount, r.variance, r.variance_pct, r.remark]));
    } else if (kind === 'outstanding') {
      exportCsv('outstanding-payments', ['Bill', 'Vendor', 'Project', 'Approved', 'Received', 'Balance', 'Expected', 'Days Overdue'],
        data.map(r => [r.bill_number, r.vendor_name, r.project_name, r.approved_amount, r.received_amount, r.balance, r.expected_date, r.days_overdue]));
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2 flex-wrap items-center">
        {kinds.map(([k, l]) => (
          <button key={k} onClick={() => setKind(k)}
            className={`px-3 py-1.5 rounded-lg text-xs font-semibold border ${kind === k ? 'bg-blue-700 text-white border-blue-700' : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300'}`}>
            {l}
          </button>
        ))}
        <div className="ml-auto flex gap-2 items-center">
          <input className="input text-xs py-1" type="date" value={range.from} onChange={e => setRange(r => ({ ...r, from: e.target.value }))} />
          <span className="text-xs text-gray-400">to</span>
          <input className="input text-xs py-1" type="date" value={range.to} onChange={e => setRange(r => ({ ...r, to: e.target.value }))} />
          <button onClick={exportReport} className="btn btn-secondary text-xs flex items-center gap-1"><FiDownload /> Export</button>
        </div>
      </div>

      {!data && <div className="card p-8 text-center text-gray-400 text-sm">Loading…</div>}

      {data && kind === 'sla-compliance' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="card p-0 overflow-x-auto"><table className="text-sm w-full">
            <thead><tr><th>Stage</th><th className="text-right">Done</th><th className="text-right">On Time</th><th className="text-right">Compliance</th><th className="text-right">Avg Delay</th></tr></thead>
            <tbody>{data.by_stage.map(s => (
              <tr key={s.stage}><td>{s.stage}</td><td className="text-right tabular-nums">{s.total}</td><td className="text-right tabular-nums">{s.on_time}</td>
                <td className={`text-right tabular-nums font-bold ${s.compliance_pct >= 80 ? 'text-emerald-600' : 'text-red-600'}`}>{s.compliance_pct}%</td>
                <td className="text-right tabular-nums">{s.avg_delay}</td></tr>))}
              {data.by_stage.length === 0 && <tr><td colSpan="5" className="text-center py-6 text-gray-400">No completed stages yet</td></tr>}
            </tbody></table></div>
          <div className="card p-0 overflow-x-auto"><table className="text-sm w-full">
            <thead><tr><th>Person</th><th className="text-right">Stages</th><th className="text-right">On Time</th><th className="text-right">Compliance</th></tr></thead>
            <tbody>{data.by_person.map(p => (
              <tr key={p.person}><td>{p.person}</td><td className="text-right tabular-nums">{p.total}</td><td className="text-right tabular-nums">{p.on_time}</td>
                <td className={`text-right tabular-nums font-bold ${p.compliance_pct >= 80 ? 'text-emerald-600' : 'text-red-600'}`}>{p.compliance_pct}%</td></tr>))}
              {data.by_person.length === 0 && <tr><td colSpan="4" className="text-center py-6 text-gray-400">No data</td></tr>}
            </tbody></table></div>
        </div>
      )}

      {data && kind === 'ageing' && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {data.map(b => (
            <div key={b.bucket} className="card p-3">
              <div className="flex justify-between items-baseline">
                <span className="text-lg font-bold">{b.bucket} <span className="text-[10px] text-gray-400 font-normal">days</span></span>
                <span className={`text-2xl font-black tabular-nums ${b.bucket === '15+' && b.count ? 'text-red-600' : ''}`}>{b.count}</span>
              </div>
              <div className="text-xs text-gray-500 tabular-nums">{inr(b.amount)}</div>
              <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {b.items.map(i => (
                  <div key={i.id} className="text-[11px] border-t border-gray-50 pt-1">
                    <span className="font-medium">{i.bill_number}</span> · {i.vendor_name}
                    <div className="text-gray-400">{i.stage} · {i.days}d</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {data && kind === 'bottleneck' && (
        <div className="card p-0 overflow-x-auto"><table className="text-sm w-full">
          <thead><tr><th>Stage</th><th className="text-right">Bills</th><th className="text-right">Avg Days</th><th className="text-right">Budget</th><th className="text-right">Breaches</th><th>Load</th></tr></thead>
          <tbody>{data.map(r => {
            const over = r.budget_days > 0 ? r.avg_days / r.budget_days : 0;
            return (<tr key={r.stage}>
              <td>{r.stage}</td><td className="text-right tabular-nums">{r.samples}</td>
              <td className={`text-right tabular-nums font-bold ${over > 1 ? 'text-red-600' : ''}`}>{r.avg_days}</td>
              <td className="text-right tabular-nums text-gray-400">{r.budget_days}</td>
              <td className={`text-right tabular-nums ${r.breaches ? 'text-red-600 font-semibold' : ''}`}>{r.breaches}</td>
              <td><div className="w-32 bg-gray-100 rounded h-2"><div className={`h-2 rounded ${over > 1 ? 'bg-red-500' : 'bg-emerald-500'}`} style={{ width: `${Math.min(100, over * 100)}%` }} /></div></td>
            </tr>);
          })}
            {data.length === 0 && <tr><td colSpan="6" className="text-center py-6 text-gray-400">No data</td></tr>}
          </tbody></table></div>
      )}

      {data && kind === 'variance' && (
        <div className="card p-0 overflow-x-auto"><table className="text-sm w-full">
          <thead><tr><th>Bill</th><th>Vendor</th><th className="text-right">Bill Amt</th><th className="text-right">Approved</th><th className="text-right">Received</th><th className="text-right">Variance</th><th>Remark</th></tr></thead>
          <tbody>{data.map(r => (
            <tr key={r.id}><td className="font-medium">{r.bill_number}</td><td>{r.vendor_name}</td>
              <td className="text-right tabular-nums">{inr(r.bill_amount)}</td>
              <td className="text-right tabular-nums">{inr(r.approved_amount)}</td>
              <td className="text-right tabular-nums text-emerald-700">{inr(r.received_amount)}</td>
              <td className={`text-right tabular-nums font-bold ${r.variance > 0 ? 'text-red-600' : 'text-purple-700'}`}>{inr(r.variance)} ({r.variance_pct}%)</td>
              <td className="max-w-[200px] truncate text-xs text-gray-500">{r.remark}</td></tr>))}
            {data.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">No variances recorded</td></tr>}
          </tbody></table></div>
      )}

      {data && kind === 'outstanding' && (
        <div className="card p-0 overflow-x-auto"><table className="text-sm w-full">
          <thead><tr><th>Bill</th><th>Vendor</th><th className="text-right">Approved</th><th className="text-right">Received</th><th className="text-right">Balance</th><th>Expected</th><th className="text-right">Days Overdue</th></tr></thead>
          <tbody>{data.map(r => (
            <tr key={r.id}><td className="font-medium">{r.bill_number}</td><td>{r.vendor_name}</td>
              <td className="text-right tabular-nums">{inr(r.approved_amount)}</td>
              <td className="text-right tabular-nums text-emerald-700">{inr(r.received_amount)}</td>
              <td className="text-right tabular-nums font-bold text-red-600">{inr(r.balance)}</td>
              <td className="text-xs">{r.expected_date ? fmtDate(r.expected_date) : '—'}</td>
              <td className={`text-right tabular-nums font-bold ${r.days_overdue > 0 ? 'text-red-600' : 'text-emerald-600'}`}>{r.days_overdue}</td></tr>))}
            {data.length === 0 && <tr><td colSpan="7" className="text-center py-6 text-gray-400">Nothing outstanding</td></tr>}
          </tbody></table></div>
      )}
    </div>
  );
}

// ─── Admin: SLA config + stage owners (§2, §6, §11) ──────────────────
function SettingsModal({ onClose }) {
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/tally-bills/settings/all').then(r => setS({
      ...r.data,
      config: { ...r.data.config },
      owners: { ...r.data.owners },
    })).catch(e => { toast.error(e.response?.data?.error || 'Failed to load settings'); onClose(); });
  }, [onClose]);

  if (!s) return <Modal isOpen onClose={onClose} title="SLA Settings"><div className="py-10 text-center text-gray-400">Loading…</div></Modal>;

  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.put('/tally-bills/settings/all', { config: s.config, owners: s.owners });
      toast.success('Settings saved');
      onClose();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  const C = (k, v) => setS(x => ({ ...x, config: { ...x.config, [k]: v } }));
  const O = (k, v) => setS(x => ({ ...x, owners: { ...x.owners, [k]: v } }));
  const OWNER_LABELS = {
    site_engineer: 'Site Engineer (Stage 1 upload + Stage 5 payment)',
    coordinator: 'PMS Coordinator (Stage 2 tasks + Stage 4 approval)',
    executor: 'PMS Executor (Stage 3 default doer)',
    director: 'Director (2nd approval + 150% escalation)',
    manager: 'Reporting Manager (100% escalation fallback)',
  };

  return (
    <Modal isOpen onClose={onClose} title="Tally Bills — SLA Settings" wide>
      <form onSubmit={save} className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <div>
          <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Stage SLAs</h4>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div><label className="label text-[11px]">Task creation (working days)</label>
              <input className="input text-sm" type="number" min="0.5" step="0.5" value={s.config.stage2_days} onChange={e => C('stage2_days', +e.target.value)} /></div>
            <div><label className="label text-[11px]">Task completion (working days)</label>
              <input className="input text-sm" type="number" min="0.5" step="0.5" value={s.config.stage3_days} onChange={e => C('stage3_days', +e.target.value)} /></div>
            <div><label className="label text-[11px]">Approval (business hours)</label>
              <input className="input text-sm" type="number" min="1" step="0.5" value={s.config.stage4_hours} onChange={e => C('stage4_hours', +e.target.value)} /></div>
            <div><label className="label text-[11px]">Payment plan (days)</label>
              <input className="input text-sm" type="number" min="1" value={s.config.payment_days} onChange={e => C('payment_days', +e.target.value)} /></div>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div><label className="label text-[11px]">Payment day basis</label>
            <select className="select text-sm" value={s.config.payment_basis} onChange={e => C('payment_basis', e.target.value)}>
              <option value="calendar">Calendar days</option>
              <option value="working">Working days</option>
            </select></div>
          <div><label className="label text-[11px]">Business hours start</label>
            <input className="input text-sm" value={s.config.work_start} onChange={e => C('work_start', e.target.value)} placeholder="09:30" /></div>
          <div><label className="label text-[11px]">Business hours end</label>
            <input className="input text-sm" value={s.config.work_end} onChange={e => C('work_end', e.target.value)} placeholder="18:30" /></div>
          <div><label className="label text-[11px]">Saturday working?</label>
            <select className="select text-sm" value={String(s.config.saturday_working)} onChange={e => C('saturday_working', +e.target.value)}>
              <option value="1">Yes (Mon–Sat)</option>
              <option value="0">No (Mon–Fri)</option>
            </select></div>
        </div>

        <div>
          <label className="label text-[11px]">Second-approval threshold (Rs over bill amount before Director sign-off is needed)</label>
          <input className="input text-sm w-48" type="number" min="0" value={s.config.second_approval_threshold} onChange={e => C('second_approval_threshold', +e.target.value)} />
          <p className="text-[10px] text-gray-400 mt-0.5">0 = any approved amount above the bill amount goes to the Director.</p>
        </div>

        <div>
          <h4 className="text-xs font-bold text-gray-500 uppercase mb-2">Stage Owners (role seats — configurable, not hardcoded)</h4>
          <div className="space-y-2">
            {s.owner_keys.map(k => (
              <div key={k} className="grid grid-cols-2 gap-2 items-center">
                <label className="text-xs text-gray-600">{OWNER_LABELS[k] || k}</label>
                <select className="select text-sm" value={s.owners[k] || ''} onChange={e => O(k, e.target.value ? +e.target.value : null)}>
                  <option value="">— not set —</option>
                  {s.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        </div>

        <div className="text-[11px] text-gray-500 bg-gray-50 rounded p-2">
          Holiday master is shared with Procurement Schedule ({s.holidays.length} holidays loaded).
          Escalations: 80% → owner reminder · 100% → reporting manager · 150% → Director.
        </div>

        <div className="flex justify-end gap-3">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Saving…' : 'Save Settings'}</button>
        </div>
      </form>
    </Modal>
  );
}
