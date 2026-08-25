// Labour Management System — one page, three tabs.
//
//   Dashboard            KPIs across quotations, work orders and labour cost
//   Quotations           raise -> threshold rule -> approve -> Work Order
//   Labour Rate Master   HR-owned crew rates behind the Labour Rate Window
//
// Client, contractor and project are picked from the modules that already own
// that data (CRM customers, Procurement sub-contractors, Projects) — nothing
// is re-keyed here. Work Orders themselves live on the existing Projects &
// Work Orders page; this page links across rather than duplicating them.
import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import { exportCsv } from '../utils/exportCsv';
import {
  FiUsers, FiFileText, FiTool, FiTrendingUp, FiPlus, FiEdit2, FiTrash2,
  FiSearch, FiDownload, FiClock, FiCheck, FiX, FiAlertTriangle, FiExternalLink,
  FiCamera, FiImage, FiPaperclip,
} from 'react-icons/fi';

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const today = () => new Date().toLocaleDateString('en-CA');
const UNITS = ['Day', 'Hour', 'Month'];
const SKILLS = ['Skilled', 'Semi-skilled', 'Unskilled', 'Highly Skilled'];

const STATUS_STYLE = {
  draft: 'bg-gray-100 text-gray-700',
  below_threshold: 'bg-blue-100 text-blue-800',
  waiting_approval: 'bg-amber-100 text-amber-800',
  approved: 'bg-emerald-100 text-emerald-800',
  wo_generated: 'bg-emerald-100 text-emerald-800',
  rejected: 'bg-red-100 text-red-700',
};
const label = (s) => String(s || '').replace(/_/g, ' ');

export default function LabourManagementSystem() {
  const [tab, setTab] = useUrlTab('dashboard');
  const TABS = [
    ['dashboard', 'Dashboard', FiTrendingUp],
    ['quotations', 'Quotations', FiFileText],
    ['rates', 'Labour Rate Master', FiTool],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FiUsers className="text-red-600" /> Labour Management System
        </h1>
        <p className="text-sm text-gray-500">
          Quotation → approval → Work Order → labour cost, priced from the rates HR maintains.
        </p>
      </div>

      <div className="flex gap-2 border-b border-gray-200 flex-wrap">
        {TABS.map(([k, text, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5 ${tab === k
              ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon size={14} /> {text}
          </button>
        ))}
      </div>

      {tab === 'dashboard' && <DashboardTab />}
      {tab === 'quotations' && <QuotationsTab />}
      {tab === 'rates' && <RatesTab />}
    </div>
  );
}

function Card({ label: text, value, sub, tone }) {
  const cls = tone === 'good' ? 'text-emerald-700' : tone === 'warn' ? 'text-amber-700' : 'text-gray-900';
  return (
    <div className="card p-4">
      <div className="text-xs text-gray-500">{text}</div>
      <div className={`text-2xl font-semibold ${cls}`}>{value}</div>
      {sub && <div className="text-xs text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// DASHBOARD
// ═══════════════════════════════════════════════════════════════════════
function DashboardTab() {
  const [q, setQ] = useState(null);
  const [r, setR] = useState(null);

  useEffect(() => {
    api.get('/labour-quotations/reports/dashboard').then(x => setQ(x.data)).catch(() => {});
    api.get('/labour-rate-master/reports/dashboard').then(x => setR(x.data)).catch(() => {});
  }, []);

  if (!q) return <div className="card p-8 text-center text-gray-500">Loading…</div>;
  const c = q.cards;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card label="Total quotations" value={c.total_quotations} />
        <Card label="Pending approvals" value={c.waiting_approval} tone="warn" />
        <Card label="Approved" value={c.approved} tone="good" />
        <Card label="Rejected" value={c.rejected} />
        <Card label="Work Orders" value={c.work_orders} />
        <Card label="Quoted value" value={money(c.quoted_value)} />
        <Card label="Approved value" value={money(c.approved_value)} tone="good" />
        <Card label="Labour cost committed" value={money(c.labour_cost)} tone="good" />
        <Card label="Active contractors" value={c.active_contractors} />
        <Card label="Active sites" value={c.active_sites} />
        {r && <Card label="Active labour rates" value={r.cards.active_rates} />}
        {r && <Card label="Avg day rate" value={money(r.cards.avg_day_rate)} />}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-medium px-4 pt-4">Pending approvals</h3>
          <QuotationMiniTable rows={q.pending_approvals}
            empty="Nothing waiting for approval." />
        </div>
        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-medium px-4 pt-4">Recent quotations</h3>
          <QuotationMiniTable rows={q.recent} empty="No quotations yet." />
        </div>
      </div>

      {r && (
        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-medium px-4 pt-4">Latest HR rate updates</h3>
          <table className="min-w-full mt-2">
            <thead><tr className="bg-gray-50 text-xs text-gray-600">
              <th className="px-3 py-2 text-left font-semibold">When</th>
              <th className="px-3 py-2 text-left font-semibold">Category</th>
              <th className="px-3 py-2 text-left font-semibold">Action</th>
              <th className="px-3 py-2 text-right font-semibold">Old</th>
              <th className="px-3 py-2 text-right font-semibold">New</th>
              <th className="px-3 py-2 text-left font-semibold">By</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {r.latest_updates.length === 0 && (
                <tr><td colSpan={6} className="px-3 py-6 text-center text-gray-500">No rate changes yet.</td></tr>
              )}
              {r.latest_updates.map(h => (
                <tr key={h.id}>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    {h.changed_at ? new Date(h.changed_at).toLocaleString('en-IN') : '—'}
                  </td>
                  <td className="px-3 py-2 text-sm">{h.labour_category}</td>
                  <td className="px-3 py-2 text-xs">{h.action}</td>
                  <td className="px-3 py-2 text-right text-sm text-gray-600">
                    {h.old_rate != null ? money(h.old_rate) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-sm font-medium">
                    {h.new_rate != null ? money(h.new_rate) : '—'}
                  </td>
                  <td className="px-3 py-2 text-sm">{h.changed_by_name || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function QuotationMiniTable({ rows, empty }) {
  return (
    <table className="min-w-full mt-2">
      <thead><tr className="bg-gray-50 text-xs text-gray-600">
        <th className="px-3 py-2 text-left font-semibold">Quotation</th>
        <th className="px-3 py-2 text-left font-semibold">Project</th>
        <th className="px-3 py-2 text-right font-semibold">Amount</th>
        <th className="px-3 py-2 text-center font-semibold">Status</th>
      </tr></thead>
      <tbody className="divide-y divide-gray-100">
        {(rows || []).length === 0 && (
          <tr><td colSpan={4} className="px-3 py-6 text-center text-gray-500">{empty}</td></tr>
        )}
        {(rows || []).map(r => (
          <tr key={r.id}>
            <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{r.quotation_number}</td>
            <td className="px-3 py-2 text-sm">{r.project_name || '—'}</td>
            <td className="px-3 py-2 text-right text-sm font-semibold">{money(r.amount)}</td>
            <td className="px-3 py-2 text-center">
              <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_STYLE[r.status] || 'bg-gray-100'}`}>
                {label(r.status)}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// QUOTATIONS
// ═══════════════════════════════════════════════════════════════════════
const emptyQuote = {
  project_id: '', project_name: '', customer_id: '', client_name: '',
  contractor_id: '', contractor_name: '', contractor_aadhaar: '', labour_category: '',
  description: '', amount: '', remarks: '', attachment_url: '',
};
// PDF, or a photo of the site/rate card/client BOQ — same /upload endpoint
// AnnouncementBell already uses, just attached to the quotation instead.
const isImageUrl = (url) => url && /\.(jpe?g|png|gif|webp|bmp)(\?|$)/i.test(url);
// Above-threshold (Rule 1) quotations must be signed off by one of these —
// same fixed list Work Orders use for "Approved By". A shared login doesn't
// say who actually approved, so the server requires this on every above-
// threshold approve/reject, not just the UI.
const SENIOR_APPROVERS = ['Ankur Kalpesh', 'Nitin Jain', 'Prabhdeep Singh'];

function QuotationsTab() {
  const { canCreate, canEdit, canDelete, canApprove, isAdmin } = useAuth();
  const admin = typeof isAdmin === 'function' ? isAdmin() : !!isAdmin;
  const [rows, setRows] = useState([]);
  const [totals, setTotals] = useState({ c: 0, v: 0 });
  const [ref, setRef] = useState(null);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);   // null | 'new' | row
  // Bumped every time the modal opens or closes — checked before an
  // in-flight attachment upload is allowed to write into `form` (mam
  // 2026-08-24: "sometimes wrong upload"). Covers both "opened a different
  // quotation's edit form" and "cancelled and reopened New Quotation" mid-upload.
  const modalTokenRef = useRef(0);
  const [form, setForm] = useState({ ...emptyQuote });
  const [saving, setSaving] = useState(false);
  const [rejecting, setRejecting] = useState(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectApprover, setRejectApprover] = useState('');
  const [approving, setApproving] = useState(null);
  const [approverName, setApproverName] = useState('');
  const [q, setQ] = useState({ search: '', status: '' });
  const [uploadingFile, setUploadingFile] = useState(false);

  const uploadAttachment = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error('File too large (max 10 MB)');
    const forToken = modalTokenRef.current;
    setUploadingFile(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      if (modalTokenRef.current !== forToken) {
        toast('That upload finished after you switched forms — please attach again here.', { icon: '⚠️' });
        return;
      }
      setForm(f => ({ ...f, attachment_url: r.data?.url || '' }));
      toast.success('File attached');
    } catch (err) {
      if (modalTokenRef.current !== forToken) return;
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploadingFile(false);
    }
  };

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    for (const [k, v] of Object.entries(q)) if (v) params[k] = v;
    api.get('/labour-quotations', { params })
      .then(r => { setRows(r.data.rows || []); setTotals(r.data.totals || { c: 0, v: 0 }); })
      .catch(e => toast.error(e.response?.data?.error || 'Could not load quotations'))
      .finally(() => setLoading(false));
  }, [q]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/labour-quotations/reference').then(r => setRef(r.data)).catch(() => {}); }, []);

  const threshold = ref?.threshold ?? 200000;
  const amountNum = Number(form.amount) || 0;
  const willNeedApproval = amountNum > threshold;

  const save = async (e) => {
    e.preventDefault();
    if (!(Number(form.amount) > 0)) return toast.error('Enter the quotation amount');
    if (!form.labour_category && !form.description) {
      return toast.error('Give at least a labour category or a description');
    }
    setSaving(true);
    try {
      if (modal === 'new') {
        const r = await api.post('/labour-quotations', form);
        toast.success(r.data.status === 'waiting_approval'
          ? `${r.data.quotation_number} raised — above ${money(threshold)}, sent for approval`
          : r.data.wo_number
            ? `${r.data.quotation_number} raised — below threshold, Work Order ${r.data.wo_number} created automatically`
            : `${r.data.quotation_number} raised — below threshold, no approval needed. Pick a project to auto-generate the Work Order.`);
      } else {
        await api.put(`/labour-quotations/${modal.id}`, form);
        toast.success('Quotation updated');
      }
      modalTokenRef.current += 1; setModal(null); load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
    }
    setSaving(false);
  };

  const doApprove = async () => {
    if (!SENIOR_APPROVERS.includes(approverName)) return toast.error('Pick who is approving this');
    try {
      const r = await api.post(`/labour-quotations/${approving.id}/approve`, { approved_by_name: approverName });
      toast.success(`Approved by ${approverName} — Work Order ${r.data.wo_number} created`);
      setApproving(null); setApproverName(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not approve'); }
  };

  const doReject = async () => {
    if (rejectReason.trim().length < 3) return toast.error('Give a reason');
    if (!SENIOR_APPROVERS.includes(rejectApprover)) return toast.error('Pick who is rejecting this');
    try {
      await api.post(`/labour-quotations/${rejecting.id}/reject`, { reason: rejectReason, rejected_by_name: rejectApprover });
      toast.success('Rejected'); setRejecting(null); setRejectReason(''); setRejectApprover(''); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not reject'); }
  };

  const remove = async (row) => {
    if (!window.confirm(`Delete ${row.quotation_number}?`)) return;
    try { await api.delete(`/labour-quotations/${row.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not delete'); }
  };

  // Selecting from a master fills both the id and the readable name, so a
  // historical quotation still reads correctly if the master row is renamed.
  const pickFrom = (list, id, nameKey, idKey) => {
    const hit = (list || []).find(x => String(x.id) === String(id));
    setForm(f => ({ ...f, [idKey]: id, [nameKey]: hit?.name || '' }));
  };

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label" htmlFor="lq-search">Search</label>
          <div className="relative">
            <FiSearch className="absolute left-2 top-2.5 text-gray-400" />
            <input id="lq-search" className="input w-full pl-8" placeholder="Quotation, project, client, contractor"
              value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="lq-status">Status</label>
          <select id="lq-status" className="input" value={q.status}
            onChange={e => setQ({ ...q, status: e.target.value })}>
            <option value="">All</option>
            {['draft', 'below_threshold', 'waiting_approval', 'wo_generated', 'rejected']
              .map(s => <option key={s} value={s}>{label(s)}</option>)}
          </select>
        </div>
        <button className="btn" onClick={load}>Apply</button>
        <button className="btn flex items-center gap-1" onClick={() => exportCsv(
          'labour_quotations',
          ['Quotation', 'Project', 'Client', 'Contractor', 'Category', 'Amount', 'Threshold', 'Rule', 'Status', 'WO', 'Raised By', 'Date'],
          rows.map(r => [r.quotation_number, r.project_name, r.client_name, r.contractor_name,
            r.labour_category, r.amount, r.threshold, r.rule_no, r.status, r.wo_number,
            r.created_by_name, r.created_at]))}>
          <FiDownload size={14} /> Export
        </button>
        {(admin || canCreate('labour_quotation')) && (
          <button className="btn btn-primary flex items-center gap-1"
            onClick={() => { setForm({ ...emptyQuote }); modalTokenRef.current += 1; setModal('new'); }}>
            <FiPlus size={14} /> New Quotation
          </button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-3 text-left font-semibold">Quotation</th>
            <th className="px-3 py-3 text-left font-semibold">Project / Site</th>
            <th className="px-3 py-3 text-left font-semibold">Client</th>
            <th className="px-3 py-3 text-left font-semibold">Contractor</th>
            <th className="px-3 py-3 text-left font-semibold">Category</th>
            <th className="px-3 py-3 text-right font-semibold">Amount</th>
            <th className="px-3 py-3 text-center font-semibold">Rule</th>
            <th className="px-3 py-3 text-center font-semibold">Status</th>
            <th className="px-3 py-3 text-left font-semibold">Work Order</th>
            <th className="px-3 py-3 text-center font-semibold">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading && <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-500">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                No quotations yet. Click New Quotation to raise the first one.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">
                  <div className="flex items-center gap-1">
                    {r.quotation_number}
                    {r.attachment_url && (
                      <a href={r.attachment_url} target="_blank" rel="noreferrer" title="View attached document"
                        className="text-gray-400 hover:text-blue-600">
                        <FiPaperclip size={11} />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-sm">
                  {r.project_name || '—'}
                  {r.site_name && <div className="text-xs text-gray-500">{r.site_name}</div>}
                </td>
                <td className="px-3 py-2 text-sm">{r.client_name || '—'}</td>
                <td className="px-3 py-2 text-sm">{r.contractor_name || '—'}</td>
                <td className="px-3 py-2 text-sm">{r.labour_category || '—'}</td>
                <td className="px-3 py-2 text-right text-sm font-semibold">{money(r.amount)}</td>
                <td className="px-3 py-2 text-center text-xs">
                  {r.rule_no ? <span className="px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">Rule {r.rule_no}</span> : '—'}
                </td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${STATUS_STYLE[r.status] || 'bg-gray-100'}`}>
                    {label(r.status)}
                  </span>
                </td>
                <td className="px-3 py-2 text-xs">
                  {r.wo_number
                    ? <Link to="/indent-labour-payment" className="text-blue-600 underline inline-flex items-center gap-1">
                        {r.wo_number} <FiExternalLink size={10} />
                      </Link>
                    : '—'}
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    {r.status === 'waiting_approval' && (admin || canApprove('labour_quotation')) && (
                      <>
                        <button onClick={() => { setApproving(r); setApproverName(''); }} title="Approve and generate the Work Order"
                          className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600"><FiCheck size={14} /></button>
                        <button onClick={() => { setRejecting(r); setRejectReason(''); setRejectApprover(''); }} title="Reject"
                          className="p-1.5 rounded hover:bg-red-50 text-red-600"><FiX size={14} /></button>
                      </>
                    )}
                    {!['wo_generated', 'approved'].includes(r.status) && (admin || canEdit('labour_quotation')) && (
                      <button onClick={() => { setForm({ ...emptyQuote, ...r }); modalTokenRef.current += 1; setModal(r); }} title="Edit"
                        className="p-1.5 rounded hover:bg-amber-50 text-amber-600"><FiEdit2 size={14} /></button>
                    )}
                    {(admin || canDelete('labour_quotation')) && !r.work_order_id && (
                      <button onClick={() => remove(r)} title="Delete"
                        className="p-1.5 rounded hover:bg-red-50 text-red-600"><FiTrash2 size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length > 0 && (
        <p className="text-sm text-gray-600">
          {totals.c} quotation(s) · total value <strong>{money(totals.v)}</strong> ·
          approval threshold {money(threshold)}
        </p>
      )}

      {/* New / edit quotation */}
      <Modal isOpen={!!modal} onClose={() => { modalTokenRef.current += 1; setModal(null); }} wide
        title={modal === 'new' ? 'New Labour Quotation' : `Edit ${modal?.quotation_number || ''}`}>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label" htmlFor="q-project">Project *</label>
              <select id="q-project" className="input w-full" value={form.project_id}
                onChange={e => pickFrom(ref?.projects, e.target.value, 'project_name', 'project_id')}>
                <option value="">Select from Projects…</option>
                {(ref?.projects || []).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <p className="text-[10px] text-gray-500 mt-0.5">Required before approval — the Work Order is created against it.</p>
            </div>
            <div>
              <label className="label" htmlFor="q-client">Client (CRM)</label>
              <select id="q-client" className="input w-full" value={form.customer_id}
                onChange={e => pickFrom(ref?.customers, e.target.value, 'client_name', 'customer_id')}>
                <option value="">Select from Customers…</option>
                {(ref?.customers || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label" htmlFor="q-contractor">Contractor</label>
              <input id="q-contractor" className="input w-full" placeholder="Contractor name"
                value={form.contractor_name} onChange={e => setForm({ ...form, contractor_name: e.target.value, contractor_id: '' })} />
            </div>
            <div>
              <label className="label" htmlFor="q-contractor-aadhaar">Contractor Aadhaar</label>
              <input id="q-contractor-aadhaar" className="input w-full" placeholder="1234 5678 9012"
                value={form.contractor_aadhaar} onChange={e => setForm({ ...form, contractor_aadhaar: e.target.value })} />
            </div>
            <div>
              <label className="label" htmlFor="q-cat">Labour Category</label>
              <input id="q-cat" className="input w-full" list="q-cat-list" placeholder="Electrician"
                value={form.labour_category} onChange={e => setForm({ ...form, labour_category: e.target.value })} />
              <datalist id="q-cat-list">
                {(ref?.labour_categories || []).map(c => <option key={c.name} value={c.name} />)}
              </datalist>
            </div>
          </div>

          <div>
            <label className="label" htmlFor="q-desc">Description</label>
            <textarea id="q-desc" className="input w-full" rows={2} placeholder="Scope of labour work"
              value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} />
          </div>

          <div>
            <label className="label" htmlFor="q-amt">Quotation Amount (Rs) *</label>
            <input id="q-amt" className="input w-full" inputMode="decimal" required placeholder="600000"
              value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} />
          </div>

          {amountNum > 0 && (
            <div className={`rounded border p-3 text-sm flex items-start gap-2 ${willNeedApproval
              ? 'border-amber-300 bg-amber-50 text-amber-900' : 'border-blue-200 bg-blue-50 text-blue-900'}`}>
              <FiAlertTriangle className="mt-0.5 shrink-0" />
              <span>
                {willNeedApproval
                  ? <>At {money(amountNum)} this is above the {money(threshold)} threshold — it will be saved as <strong>Waiting for Approval</strong> under Rule 1, and a Work Order is generated automatically once approved.</>
                  : <>At {money(amountNum)} this is at or below the {money(threshold)} threshold — it will be saved as <strong>Below Threshold</strong>, needs no approval, and its Work Order is generated straight away.</>}
              </span>
            </div>
          )}

          <div>
            <label className="label">Supporting Document</label>
            {form.attachment_url ? (
              <div className="relative inline-block">
                {isImageUrl(form.attachment_url) ? (
                  <img src={form.attachment_url} alt="Attachment preview"
                    className="max-h-32 rounded border border-gray-300 object-cover"/>
                ) : (
                  <a href={form.attachment_url} target="_blank" rel="noreferrer"
                    className="inline-flex items-center gap-1 px-2 py-1 bg-gray-100 rounded border border-gray-300 text-xs text-blue-700 hover:underline">
                    <FiPaperclip size={11}/> View attached file
                  </a>
                )}
                <button type="button" onClick={() => setForm(f => ({ ...f, attachment_url: '' }))}
                  className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-5 h-5 flex items-center justify-center text-[10px] shadow"
                  title="Remove attachment">
                  <FiX size={10}/>
                </button>
              </div>
            ) : (
              <div className="flex gap-1.5 items-center flex-wrap">
                <label className="flex items-center gap-1 text-xs text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1.5 bg-blue-50 border border-blue-200 rounded">
                  <FiCamera size={13}/> Take Photo
                  <input type="file" accept="image/*" capture="environment" className="hidden"
                    disabled={uploadingFile} onChange={e => uploadAttachment(e.target.files?.[0])} />
                </label>
                <label className="flex items-center gap-1 text-xs text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1.5 bg-blue-50 border border-blue-200 rounded">
                  <FiImage size={13}/> Photo / PDF
                  <input type="file" accept="image/*,application/pdf" className="hidden"
                    disabled={uploadingFile} onChange={e => uploadAttachment(e.target.files?.[0])} />
                </label>
                {uploadingFile && (
                  <span className="text-[10px] text-gray-500 flex items-center gap-1">
                    <span className="inline-block w-2.5 h-2.5 border-2 border-blue-300 border-t-blue-700 rounded-full animate-spin"/>
                    Uploading…
                  </span>
                )}
              </div>
            )}
          </div>

          <div>
            <label className="label" htmlFor="q-remarks">Remarks</label>
            <input id="q-remarks" className="input w-full"
              value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn" onClick={() => { modalTokenRef.current += 1; setModal(null); }}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : modal === 'new' ? 'Raise Quotation' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Approve */}
      <Modal isOpen={!!approving} onClose={() => setApproving(null)}
        title={`Approve ${approving?.quotation_number || ''}`}>
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            {money(approving?.amount)} is above the {money(approving?.threshold)} threshold — pick who is approving it.
          </p>
          <div>
            <label className="label" htmlFor="q-approver">Approved By *</label>
            <select id="q-approver" className="input w-full" value={approverName}
              onChange={e => setApproverName(e.target.value)}>
              <option value="">Select approver…</option>
              {SENIOR_APPROVERS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setApproving(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doApprove}>Approve</button>
          </div>
        </div>
      </Modal>

      {/* Reject */}
      <Modal isOpen={!!rejecting} onClose={() => setRejecting(null)}
        title={`Reject ${rejecting?.quotation_number || ''}`}>
        <div className="space-y-3">
          <div>
            <label className="label" htmlFor="q-rejector">Rejected By *</label>
            <select id="q-rejector" className="input w-full" value={rejectApprover}
              onChange={e => setRejectApprover(e.target.value)}>
              <option value="">Select approver…</option>
              {SENIOR_APPROVERS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <label className="label" htmlFor="q-reject">Reason *</label>
          <textarea id="q-reject" className="input w-full" rows={3} value={rejectReason}
            onChange={e => setRejectReason(e.target.value)}
            placeholder="Why is this being rejected?" />
          <div className="flex justify-end gap-2">
            <button className="btn" onClick={() => setRejecting(null)}>Cancel</button>
            <button className="btn btn-primary" onClick={doReject}>Reject</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// LABOUR RATE MASTER
// ═══════════════════════════════════════════════════════════════════════
const emptyRate = {
  labour_category: '', labour_type: '', trade: '', department: '', skill_level: '',
  unit: 'Day', standard_rate: '', overtime_rate: '',
  effective_from: today(), effective_to: '', status: 'active', remarks: '', reason: '',
};

function RatesTab() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const admin = typeof isAdmin === 'function' ? isAdmin() : !!isAdmin;
  const mayWrite = admin || canCreate('labour_rate_master') || canEdit('labour_rate_master');

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ...emptyRate });
  const [saving, setSaving] = useState(false);
  const [historyFor, setHistoryFor] = useState(null);
  const [q, setQ] = useState({ search: '', department: '', trade: '', status: '' });

  const load = useCallback(() => {
    setLoading(true);
    const params = {};
    for (const [k, v] of Object.entries(q)) if (v) params[k] = v;
    api.get('/labour-rate-master', { params })
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Could not load labour rates'))
      .finally(() => setLoading(false));
  }, [q]);
  useEffect(() => { load(); }, [load]);

  const editingRateChanged = modal && modal !== 'new'
    && Number(form.standard_rate) !== Number(modal.standard_rate);

  const save = async (e) => {
    e.preventDefault();
    if (!form.labour_category.trim()) return toast.error('Labour category is required');
    if (editingRateChanged && !form.reason.trim()) {
      return toast.error('Give a reason for the rate change — it goes into the audit trail');
    }
    setSaving(true);
    try {
      if (modal === 'new') { await api.post('/labour-rate-master', form); toast.success('Labour rate added'); }
      else { await api.put(`/labour-rate-master/${modal.id}`, form); toast.success('Labour rate updated'); }
      setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not save'); }
    setSaving(false);
  };

  const toggleStatus = async (r) => {
    const next = r.status === 'active' ? 'inactive' : 'active';
    try {
      await api.put(`/labour-rate-master/${r.id}`, { status: next, reason: `Marked ${next}` });
      toast.success(`Rate marked ${next}`); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not change status'); }
  };

  const remove = async (r) => {
    if (!window.confirm(`Delete the ${r.labour_category} rate? If a Work Order used it, set it Inactive instead.`)) return;
    try { await api.delete(`/labour-rate-master/${r.id}`); toast.success('Rate deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not delete'); }
  };

  const openHistory = async (r) => {
    try {
      const { data } = await api.get(`/labour-rate-master/${r.id}/history`);
      setHistoryFor({ rate: r, rows: data || [] });
    } catch { toast.error('Could not load history'); }
  };

  const departments = useMemo(() => [...new Set(rows.map(r => r.department).filter(Boolean))].sort(), [rows]);
  const trades = useMemo(() => [...new Set(rows.map(r => r.trade).filter(Boolean))].sort(), [rows]);

  return (
    <div className="space-y-3">
      {!mayWrite && (
        <div className="card p-3 border border-blue-200 bg-blue-50 text-sm text-blue-900">
          You have read-only access. Labour rates are maintained by HR.
        </div>
      )}

      <div className="card p-3 flex flex-wrap gap-2 items-end">
        <div className="flex-1 min-w-[200px]">
          <label className="label" htmlFor="lr-search">Search</label>
          <div className="relative">
            <FiSearch className="absolute left-2 top-2.5 text-gray-400" />
            <input id="lr-search" className="input w-full pl-8" placeholder="Category, trade, department"
              value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label" htmlFor="lr-dept">Department</label>
          <select id="lr-dept" className="input" value={q.department}
            onChange={e => setQ({ ...q, department: e.target.value })}>
            <option value="">All</option>
            {departments.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lr-trade">Trade</label>
          <select id="lr-trade" className="input" value={q.trade}
            onChange={e => setQ({ ...q, trade: e.target.value })}>
            <option value="">All</option>
            {trades.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="lr-status">Status</label>
          <select id="lr-status" className="input" value={q.status}
            onChange={e => setQ({ ...q, status: e.target.value })}>
            <option value="">All</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </select>
        </div>
        <button className="btn" onClick={load}>Apply</button>
        <button className="btn flex items-center gap-1" onClick={() => exportCsv(
          'labour_rate_master',
          ['Category', 'Type', 'Trade', 'Department', 'Skill', 'Unit', 'Standard Rate',
            'Overtime Rate', 'Effective From', 'Effective To', 'Status', 'Remarks', 'Created By', 'Updated By'],
          rows.map(r => [r.labour_category, r.labour_type, r.trade, r.department, r.skill_level,
            r.unit, r.standard_rate, r.overtime_rate, r.effective_from, r.effective_to,
            r.status, r.remarks, r.created_by_name, r.updated_by_name]))}>
          <FiDownload size={14} /> Export CSV
        </button>
        <a href="/labour-rate-master-print" target="_blank" rel="noreferrer" className="btn flex items-center gap-1">
          <FiDownload size={14} /> Export PDF
        </a>
        {mayWrite && (
          <button className="btn btn-primary flex items-center gap-1"
            onClick={() => { setForm({ ...emptyRate }); setModal('new'); }}>
            <FiPlus size={14} /> Add Rate
          </button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-3 text-left font-semibold">Labour Category</th>
            <th className="px-3 py-3 text-left font-semibold">Type / Skill</th>
            <th className="px-3 py-3 text-left font-semibold">Trade</th>
            <th className="px-3 py-3 text-left font-semibold">Department</th>
            <th className="px-3 py-3 text-center font-semibold">Unit</th>
            <th className="px-3 py-3 text-right font-semibold">Standard Rate</th>
            <th className="px-3 py-3 text-right font-semibold">Overtime</th>
            <th className="px-3 py-3 text-left font-semibold">Effective</th>
            <th className="px-3 py-3 text-center font-semibold">Status</th>
            <th className="px-3 py-3 text-center font-semibold">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {loading && <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-500">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="px-3 py-8 text-center text-gray-500">
                No labour rates yet.{mayWrite ? ' Click Add Rate to create the first one.' : ''}
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id} className={r.status === 'inactive' ? 'bg-gray-50/60 text-gray-500' : 'hover:bg-gray-50'}>
                <td className="px-3 py-2 font-medium text-sm">{r.labour_category}</td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {[r.labour_type, r.skill_level].filter(Boolean).join(' · ') || '—'}
                </td>
                <td className="px-3 py-2 text-sm">{r.trade || '—'}</td>
                <td className="px-3 py-2 text-sm">{r.department || '—'}</td>
                <td className="px-3 py-2 text-center text-xs">
                  <span className="inline-flex px-2 py-0.5 rounded bg-gray-100 text-gray-700">{r.unit}</span>
                </td>
                <td className="px-3 py-2 text-right text-sm font-semibold">{money(r.standard_rate)}</td>
                <td className="px-3 py-2 text-right text-sm text-gray-600">
                  {r.overtime_rate ? money(r.overtime_rate) : '—'}
                </td>
                <td className="px-3 py-2 text-xs text-gray-600">
                  {r.effective_from}{r.effective_to ? ` → ${r.effective_to}` : ''}
                </td>
                <td className="px-3 py-2 text-center">
                  <button onClick={() => mayWrite && toggleStatus(r)} disabled={!mayWrite}
                    title={mayWrite ? 'Click to toggle' : 'HR maintains rate status'}
                    className={`text-[10px] px-1.5 py-0.5 rounded ${r.status === 'active'
                      ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-200 text-gray-700'} ${mayWrite ? 'hover:opacity-80' : 'cursor-default'}`}>
                    {r.status === 'active' ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td className="px-3 py-2">
                  <div className="flex items-center justify-center gap-1">
                    <button onClick={() => openHistory(r)} title="Rate history"
                      className="p-1.5 rounded hover:bg-gray-100 text-gray-600"><FiClock size={14} /></button>
                    {mayWrite && (
                      <button onClick={() => { setForm({ ...emptyRate, ...r, effective_to: r.effective_to || '', remarks: r.remarks || '', reason: '' }); setModal(r); }}
                        title="Edit" className="p-1.5 rounded hover:bg-amber-50 text-amber-600"><FiEdit2 size={14} /></button>
                    )}
                    {(admin || canDelete('labour_rate_master')) && (
                      <button onClick={() => remove(r)} title="Delete"
                        className="p-1.5 rounded hover:bg-red-50 text-red-600"><FiTrash2 size={14} /></button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add / edit rate */}
      <Modal isOpen={!!modal} onClose={() => setModal(null)} wide
        title={modal === 'new' ? 'Add Labour Rate' : `Edit — ${modal?.labour_category || ''}`}>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Labour Category *" id="r-cat">
              <input id="r-cat" className="input w-full" required placeholder="Electrician"
                value={form.labour_category} onChange={e => setForm({ ...form, labour_category: e.target.value })} />
            </Field>
            <Field label="Labour Type" id="r-type">
              <input id="r-type" className="input w-full" placeholder="Skilled / Contract"
                value={form.labour_type} onChange={e => setForm({ ...form, labour_type: e.target.value })} />
            </Field>
            <Field label="Trade" id="r-trade">
              <input id="r-trade" className="input w-full" placeholder="Electrical"
                value={form.trade} onChange={e => setForm({ ...form, trade: e.target.value })} />
            </Field>
            <Field label="Department" id="r-dept">
              <input id="r-dept" className="input w-full" placeholder="ELE"
                value={form.department} onChange={e => setForm({ ...form, department: e.target.value })} />
            </Field>
            <Field label="Skill Level" id="r-skill">
              <select id="r-skill" className="input w-full" value={form.skill_level}
                onChange={e => setForm({ ...form, skill_level: e.target.value })}>
                <option value="">—</option>
                {SKILLS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </Field>
            <Field label="Unit *" id="r-unit">
              <select id="r-unit" className="input w-full" value={form.unit}
                onChange={e => setForm({ ...form, unit: e.target.value })}>
                {UNITS.map(u => <option key={u} value={u}>{u}</option>)}
              </select>
            </Field>
            <Field label="Standard Rate (Rs) *" id="r-rate">
              <input id="r-rate" className="input w-full" inputMode="decimal" required placeholder="1200"
                value={form.standard_rate} onChange={e => setForm({ ...form, standard_rate: e.target.value })} />
            </Field>
            <Field label="Overtime Rate (Rs per hour)" id="r-ot">
              <input id="r-ot" className="input w-full" inputMode="decimal" placeholder="150"
                value={form.overtime_rate} onChange={e => setForm({ ...form, overtime_rate: e.target.value })} />
            </Field>
            <Field label="Effective From *" id="r-from">
              <input id="r-from" type="date" className="input w-full" required
                value={form.effective_from} onChange={e => setForm({ ...form, effective_from: e.target.value })} />
            </Field>
            <Field label="Effective To (blank = open-ended)" id="r-to">
              <input id="r-to" type="date" className="input w-full"
                value={form.effective_to} onChange={e => setForm({ ...form, effective_to: e.target.value })} />
            </Field>
            <Field label="Status" id="r-status">
              <select id="r-status" className="input w-full" value={form.status}
                onChange={e => setForm({ ...form, status: e.target.value })}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </Field>
          </div>

          <Field label="Remarks" id="r-remarks">
            <textarea id="r-remarks" className="input w-full" rows={2}
              value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} />
          </Field>

          {editingRateChanged && (
            <div className="rounded border border-amber-300 bg-amber-50 p-3 space-y-2">
              <div className="text-sm text-amber-900 flex items-start gap-2">
                <FiAlertTriangle className="mt-0.5 shrink-0" />
                <span>
                  Changing {modal.labour_category} from {money(modal.standard_rate)} to {money(form.standard_rate)}.
                  Work Orders already created keep the old rate; only new ones use this.
                </span>
              </div>
              <Field label="Reason for the change *" id="r-reason">
                <input id="r-reason" className="input w-full" required
                  placeholder="e.g. Annual wage revision August 2026"
                  value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} />
              </Field>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button type="button" className="btn" onClick={() => setModal(null)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving}>
              {saving ? 'Saving…' : modal === 'new' ? 'Add Rate' : 'Save Changes'}
            </button>
          </div>
        </form>
      </Modal>

      {/* Per-rate history */}
      <Modal isOpen={!!historyFor} onClose={() => setHistoryFor(null)} wide
        title={`Rate History — ${historyFor?.rate?.labour_category || ''}`}>
        {historyFor && (historyFor.rows.length === 0
          ? <p className="text-sm text-gray-500">No changes recorded yet.</p>
          : (
            <table className="min-w-full">
              <thead><tr className="bg-gray-50 text-xs text-gray-600">
                <th className="px-3 py-2 text-left font-semibold">When</th>
                <th className="px-3 py-2 text-left font-semibold">Action</th>
                <th className="px-3 py-2 text-right font-semibold">Old</th>
                <th className="px-3 py-2 text-right font-semibold">New</th>
                <th className="px-3 py-2 text-left font-semibold">Reason</th>
                <th className="px-3 py-2 text-left font-semibold">By</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {historyFor.rows.map(h => (
                  <tr key={h.id}>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {h.changed_at ? new Date(h.changed_at).toLocaleString('en-IN') : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">{h.action}</td>
                    <td className="px-3 py-2 text-right text-sm text-gray-600">
                      {h.old_rate != null ? money(h.old_rate) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-medium">
                      {h.new_rate != null ? money(h.new_rate) : '—'}
                    </td>
                    <td className="px-3 py-2 text-sm text-gray-600">{h.reason || '—'}</td>
                    <td className="px-3 py-2 text-sm">{h.changed_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ))}
      </Modal>
    </div>
  );
}

function Field({ label: text, id, children }) {
  return (
    <div>
      <label className="label" htmlFor={id}>{text}</label>
      {children}
    </div>
  );
}
