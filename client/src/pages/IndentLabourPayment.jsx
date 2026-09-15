// Indent Labour Payment — full project execution + billing pipeline.
// Mam (2026-06-01, amended 2026-06-02): Projects are manually entered
// with a unique name.  Each project owns three labour spend streams:
//   L1 Salary       — legacy bulk + ongoing monthly entries
//   L2 Daily Wages  — legacy bulk + per_day_rate × days_required entries
//   L3 Sub-contract — Work Orders with file upload + value + amount paid
// Budget = L1 + L2 + L3 running total per project.

import { useState, useEffect, useMemo } from 'react';
import { flowStepLabel } from '../utils/moduleFlows';
import { Link } from 'react-router-dom';
import api from '../api';
import StatusMultiSelect from '../components/StatusMultiSelect';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import LabourRateWindow from '../components/LabourRateWindow';
import toast from 'react-hot-toast';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid,
} from 'recharts';
import {
  FiClipboard, FiSearch, FiBriefcase, FiUsers, FiTool, FiBookOpen,
  FiDollarSign, FiTrendingUp, FiPlus, FiTrash2, FiEdit2, FiUpload,
  FiExternalLink, FiSend, FiPrinter, FiLock, FiCheckCircle, FiUserCheck,
} from 'react-icons/fi';

const WO_STATUS_LABEL = {
  draft: 'Draft', submitted: 'Submitted', approved: 'Approved',
  work_started: 'Work Started', in_progress: 'In Progress', completed: 'Completed',
  active: 'Active', closed: 'Closed', cancelled: 'Cancelled',
};
const WO_STATUS_CLS = {
  draft: 'bg-gray-100 text-gray-600', submitted: 'bg-blue-100 text-blue-700',
  approved: 'bg-indigo-100 text-indigo-700', work_started: 'bg-amber-100 text-amber-800',
  in_progress: 'bg-amber-100 text-amber-800', completed: 'bg-emerald-100 text-emerald-700',
  active: 'bg-amber-100 text-amber-800', closed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};
const WO_STATUS_OPTIONS = ['draft', 'submitted', 'approved', 'work_started', 'in_progress', 'completed', 'cancelled'];
import { fmtDate } from '../utils/datetime';

const fmtINR = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e3).toFixed(1)} K`;
  return `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
};
const fmtINRFull = (n) => `₹${Math.round(Number(n || 0)).toLocaleString('en-IN')}`;

const TABS = [
  { id: 'projects',   label: 'Projects',     icon: FiBriefcase, phase: 1 },
  { id: 'workorders', label: 'Work Orders',  icon: FiTool,      phase: 3 },
  { id: 'mb',         label: 'MB / CDPR',    icon: FiBookOpen,  phase: 5 },
  { id: 'rabills',    label: 'RA Bills',     icon: FiDollarSign, phase: 6 },
  { id: 'dashboard',  label: 'Dashboard',    icon: FiTrendingUp, phase: 6 },
];

export default function IndentLabourPayment() {
  const [tab, setTab] = useUrlTab('projects');

  return (
    <div className="space-y-4 p-3 sm:p-4">
      <div className="bg-gradient-to-br from-indigo-900 to-indigo-950 text-white rounded-xl p-4 shadow-lg">
        <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
          <FiClipboard /> Indent Labour Payment
        </h1>
        <p className="text-indigo-200 text-xs sm:text-sm mt-0.5">
          Project Execution &amp; Billing — each project owns Salary (L1) + Daily Wages (L2) + Sub-contract WOs (L3).
        </p>
      </div>

      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
              <Icon size={14} /> {flowStepLabel('/indent-labour-payment', t.label)}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                active ? 'bg-white text-indigo-700' : 'bg-gray-200 text-gray-600'
              }`}>P{t.phase}</span>
            </button>
          );
        })}
      </div>

      {tab === 'projects' && <ProjectsTab />}
      {tab === 'workorders' && <WorkOrdersTab />}
      {tab === 'mb' && <MbTab />}
      {tab === 'rabills' && <RaBillsTab />}
      {tab === 'dashboard' && <ProjectsDashboardTab />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// PROJECTS TAB — list + create + click-into detail
// ═══════════════════════════════════════════════════════════════
function ProjectsTab() {
  const [rows, setRows] = useState([]);
  const [owners, setOwners] = useState([]);
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [detailId, setDetailId] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/indent-labour-payment/projects', { params: { q: q || undefined, owner: owner || undefined } })
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load projects'))
      .finally(() => setLoading(false));
    api.get('/indent-labour-payment/owners').then(r => setOwners(r.data || [])).catch(() => {});
  };
  useEffect(load, [q, owner]);

  const totals = useMemo(() => rows.reduce((acc, r) => {
    acc.l1 += Number(r.l1 || 0);
    acc.l2 += Number(r.l2 || 0);
    acc.l3 += Number(r.l3 || 0);
    acc.work_orders += Number(r.work_order_count || 0);
    return acc;
  }, { l1: 0, l2: 0, l3: 0, work_orders: 0 }), [rows]);
  const totalBudget = totals.l1 + totals.l2 + totals.l3;

  return (
    <div className="space-y-3">
      {/* Filter + add */}
      <div className="card p-3 flex gap-3 flex-wrap items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs text-gray-600 block mb-1">Search project / notes</label>
          <div className="relative">
            <FiSearch size={12} className="absolute left-2 top-2.5 text-gray-400" />
            <input value={q} onChange={e => setQ(e.target.value)}
              placeholder="Start typing…"
              className="border rounded pl-7 pr-2 py-1.5 text-sm w-full" />
          </div>
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-1">Owner</label>
          <select value={owner} onChange={e => setOwner(e.target.value)}
            className="border rounded px-2 py-1.5 text-sm">
            <option value="">All owners</option>
            {owners.map(o => <option key={o.owner} value={o.owner}>{o.owner} ({o.project_count})</option>)}
          </select>
        </div>
        <button onClick={load} className="btn btn-secondary">Refresh</button>
        <button onClick={() => setCreateOpen(true)} className="btn btn-primary flex items-center gap-1.5">
          <FiPlus size={14} /> New Project
        </button>
      </div>

      {/* Roll-up tiles — L1 + L2 + L3 + Total Budget */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <Tile label="Projects"          value={rows.length}             color="indigo" />
        <Tile label="L1 Salary"         value={fmtINR(totals.l1)}       color="emerald" />
        <Tile label="L2 Daily Wages"    value={fmtINR(totals.l2)}       color="amber" />
        <Tile label="L3 Sub-contract"   value={fmtINR(totals.l3)}       color="blue" />
        <Tile label="Total Budget"      value={fmtINR(totalBudget)}     color="violet" />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Project</th>
              <th className="text-left">Owner</th>
              <th className="text-right">L1 Salary</th>
              <th className="text-right">L2 Daily</th>
              <th className="text-right">L3 Sub-con</th>
              <th className="text-right">Budget</th>
              <th className="text-right">WOs</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={8} className="text-center py-6 text-gray-400">Loading…</td></tr>)}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={8} className="text-center py-8 text-gray-400">
                No projects yet — click <strong>New Project</strong> to create one.
              </td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="font-semibold">{r.name}</td>
                <td>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                    {r.owner}
                  </span>
                </td>
                <td className="text-right text-emerald-700">{fmtINR(r.l1)}</td>
                <td className="text-right text-amber-700">{fmtINR(r.l2)}</td>
                <td className="text-right text-blue-700">{fmtINR(r.l3)}</td>
                <td className="text-right font-bold text-violet-700">{fmtINR(r.budget)}</td>
                <td className="text-right">{r.work_order_count}</td>
                <td>
                  <button onClick={() => setDetailId(r.id)} className="text-xs text-blue-600 hover:underline">
                    Open →
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {createOpen && (
        <CreateProjectModal
          onClose={() => setCreateOpen(false)}
          onCreated={(newId) => { setCreateOpen(false); load(); setDetailId(newId); }}
        />
      )}

      {detailId && (
        <ProjectDetailModal
          projectId={detailId}
          onClose={() => { setDetailId(null); load(); }}
        />
      )}
    </div>
  );
}

function Tile({ label, value, color }) {
  const colors = {
    indigo:  { border: 'border-indigo-500',  text: 'text-indigo-700'  },
    emerald: { border: 'border-emerald-500', text: 'text-emerald-700' },
    amber:   { border: 'border-amber-500',   text: 'text-amber-700'   },
    blue:    { border: 'border-blue-500',    text: 'text-blue-700'    },
    violet:  { border: 'border-violet-500',  text: 'text-violet-700'  },
  };
  const c = colors[color] || colors.indigo;
  return (
    <div className={`card text-center border-l-4 py-2 ${c.border}`}>
      <div className={`text-xl font-bold ${c.text}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

// ─── Create Project modal ──────────────────────────────────────
function CreateProjectModal({ onClose, onCreated }) {
  const [form, setForm] = useState({ name: '', owner: 'Aanchal', notes: '' });
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) { toast.error('Project name is required'); return; }
    setSaving(true);
    try {
      const r = await api.post('/indent-labour-payment/projects', form);
      toast.success('Project created');
      onCreated(r.data.id);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Create failed');
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title="New Project">
      <form onSubmit={submit} className="space-y-3">
        <div>
          <label className="label">Project Name *</label>
          <input className="input" value={form.name}
            onChange={e => setForm({ ...form, name: e.target.value })}
            placeholder="e.g. GADVASU HVAC · Phase 2"
            required autoFocus />
          <div className="text-[10px] text-gray-500 mt-1">Must be unique across all projects.</div>
        </div>
        <div>
          <label className="label">Owner</label>
          <input className="input" value={form.owner}
            onChange={e => setForm({ ...form, owner: e.target.value })}
            placeholder="Aanchal (default)" />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">
            {saving ? 'Saving…' : 'Create'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// PROJECT DETAIL MODAL — 3 sub-tabs for L1 / L2 / L3
// ═══════════════════════════════════════════════════════════════
function ProjectDetailModal({ projectId, onClose }) {
  const [project, setProject] = useState(null);
  const [overview, setOverview] = useState(null);
  const [sub, setSub] = useState('overview');

  const reload = () => {
    api.get(`/indent-labour-payment/projects/${projectId}`).then(r => setProject(r.data));
    api.get(`/indent-labour-payment/projects/${projectId}/overview`).then(r => setOverview(r.data)).catch(() => setOverview(null));
  };
  useEffect(reload, [projectId]);

  if (!project) return (
    <Modal isOpen={true} onClose={onClose} title="Loading…" wide>
      <div className="text-center py-6 text-gray-400 text-sm">Loading project…</div>
    </Modal>
  );

  return (
    <Modal isOpen={true} onClose={onClose} title={project.name} wide>
      <div className="space-y-3">
        {/* Header strip */}
        <div className="bg-indigo-50 border border-indigo-200 rounded-lg p-3 grid grid-cols-2 md:grid-cols-5 gap-2 text-center">
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Owner</div>
            <div className="font-semibold text-indigo-700">{project.owner}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L1 Salary</div>
            <div className="font-bold text-emerald-700">{fmtINR(project.l1)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L2 Daily</div>
            <div className="font-bold text-amber-700">{fmtINR(project.l2)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">L3 Sub-con</div>
            <div className="font-bold text-blue-700">{fmtINR(project.l3)}</div>
          </div>
          <div>
            <div className="text-[10px] text-gray-500 uppercase">Budget</div>
            <div className="font-extrabold text-violet-700">{fmtINR(project.budget)}</div>
          </div>
        </div>

        <div className="flex gap-1.5">
          {[
            { id: 'overview', label: 'Overview', icon: FiBriefcase },
            { id: 'l1', label: 'L1 Salary', icon: FiUsers },
            { id: 'l2', label: 'L2 Daily Wages', icon: FiTool },
            { id: 'l3', label: 'L3 Work Orders', icon: FiDollarSign },
          ].map(t => (
            <button key={t.id} onClick={() => setSub(t.id)}
              className={`px-3 py-1.5 rounded-lg text-sm font-semibold border ${
                sub === t.id ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-700 border-gray-200'
              }`}>
              {t.label}
            </button>
          ))}
        </div>

        {sub === 'overview' && <ProjectOverview data={overview} />}
        {sub === 'l1' && <L1Salary projectId={projectId} onChange={reload} />}
        {sub === 'l2' && <L2DailyWages projectId={projectId} onChange={reload} />}
        {sub === 'l3' && <L3WorkOrders projectId={projectId} onChange={reload} />}

        <div className="flex justify-end pt-2 border-t">
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── Overview sub-tab (2026-08) — "click a project, see everything":
// work progress + money + bill status in one place, so nobody has to hop
// between L1/L2/L3 and Bill Verification separately.
const BILL_STATUS_CLS = { paid: 'bg-emerald-100 text-emerald-700', raised: 'bg-amber-100 text-amber-800', cancelled: 'bg-red-100 text-red-700', on_hold: 'bg-slate-200 text-slate-700' };
function ProjectOverview({ data }) {
  if (!data) return <div className="text-center py-8 text-gray-400 text-sm">Loading overview…</div>;
  const totalBills = data.bills_by_status.reduce((s, b) => s + b.count, 0);
  return (
    <div className="space-y-4">
      {/* Work progress */}
      <div className="card p-4">
        <div className="flex items-center justify-between mb-1">
          <h4 className="text-sm font-semibold">Work Progress</h4>
          <span className="text-lg font-bold text-indigo-700">{data.work_progress_pct}%</span>
        </div>
        <div className="w-full h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div className="h-full bg-indigo-500" style={{ width: `${Math.min(100, data.work_progress_pct)}%` }} />
        </div>
        <p className="text-[10px] text-gray-500 mt-1">DPR-claimed amount vs planned Work Order value, across all WOs</p>
      </div>

      {/* Money */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
        <div className="card p-3 text-center"><div className="text-[10px] text-gray-500 uppercase">L1 Salary</div><div className="font-bold text-emerald-700">{fmtINR(data.money.l1_salary)}</div></div>
        <div className="card p-3 text-center"><div className="text-[10px] text-gray-500 uppercase">L2 Daily</div><div className="font-bold text-amber-700">{fmtINR(data.money.l2_daily_wage)}</div></div>
        <div className="card p-3 text-center"><div className="text-[10px] text-gray-500 uppercase">L3 Paid</div><div className="font-bold text-blue-700">{fmtINR(data.money.l3_paid)}</div></div>
        <div className="card p-3 text-center"><div className="text-[10px] text-gray-500 uppercase">L3 Planned</div><div className="font-bold text-gray-600">{fmtINR(data.money.l3_planned)}</div></div>
        <div className="card p-3 text-center bg-violet-50"><div className="text-[10px] text-gray-500 uppercase">Budget Spent</div><div className="font-extrabold text-violet-700">{fmtINR(data.money.budget)}</div></div>
      </div>

      {/* Work Orders by status */}
      <div className="card p-4">
        <h4 className="text-sm font-semibold mb-2">Work Orders by Status</h4>
        <div className="flex flex-wrap gap-2">
          {data.work_orders_by_status.map(w => (
            <span key={w.status} className={`text-xs px-2.5 py-1 rounded-full ${WO_STATUS_CLS[w.status] || 'bg-gray-100 text-gray-600'}`}>
              {WO_STATUS_LABEL[w.status] || w.status}: {w.count} ({fmtINR(w.value)})
            </span>
          ))}
          {data.work_orders_by_status.length === 0 && <span className="text-xs text-gray-400">No Work Orders yet</span>}
        </div>
      </div>

      {/* Bills */}
      <div className="card p-4">
        <h4 className="text-sm font-semibold mb-2">Contractor Bills ({totalBills})</h4>
        <div className="flex flex-wrap gap-2 mb-2">
          {data.bills_by_status.map(b => (
            <span key={b.status} className={`text-xs px-2.5 py-1 rounded-full ${BILL_STATUS_CLS[b.status] || 'bg-gray-100 text-gray-600'}`}>
              {b.status}: {b.count} ({fmtINR(b.amount)})
            </span>
          ))}
          {data.bills_by_status.length === 0 && <span className="text-xs text-gray-400">No bills yet</span>}
        </div>
        {data.bills_pending_by_stage.length > 0 && (
          <div className="text-xs text-gray-600">
            Waiting at: {data.bills_pending_by_stage.map(s => `${s.current_stage} (${s.count})`).join(', ')}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── L1 Salary sub-section ─────────────────────────────────────
function L1Salary({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [adding, setAdding] = useState(null); // null | 'legacy' | 'monthly'

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/salary`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const remove = async (id) => {
    if (!confirm('Delete this salary entry?')) return;
    try {
      await api.delete(`/indent-labour-payment/salary/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const hasLegacy = rows.some(r => r.kind === 'legacy');

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button onClick={() => setAdding('legacy')} disabled={hasLegacy}
          className="btn btn-secondary text-xs flex items-center gap-1"
          title={hasLegacy ? 'Legacy already captured' : 'One-off pre-SOTYN.AI salary spend'}>
          <FiPlus size={12} /> {hasLegacy ? '✓ Legacy captured' : 'Add Legacy Salary'}
        </button>
        <button onClick={() => setAdding('monthly')} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Monthly Entry
        </button>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">Kind</th>
              <th className="text-left px-2 py-1.5">Employee</th>
              <th className="text-left px-2 py-1.5">Month</th>
              <th className="text-right px-2 py-1.5">Amount</th>
              <th className="text-left px-2 py-1.5">Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={6} className="text-center py-4 text-gray-400">No salary entries yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="border-t">
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                    r.kind === 'legacy' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                  }`}>{r.kind}</span>
                </td>
                <td className="px-2 py-1.5">{r.employee_name || '—'}</td>
                <td className="px-2 py-1.5">{r.period_month || '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{fmtINRFull(r.amount)}</td>
                <td className="px-2 py-1.5 text-xs text-gray-600">{r.notes || '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddSalaryEntry kind={adding} projectId={projectId}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); load(); onChange(); }} />
      )}
    </div>
  );
}

function AddSalaryEntry({ kind, projectId, onClose, onSaved }) {
  const [form, setForm] = useState({
    employee_name: '',
    period_month: kind === 'monthly' ? new Date().toISOString().slice(0, 7) : '',
    amount: '',
    notes: '',
  });
  const submit = async (e) => {
    e.preventDefault();
    if (!Number(form.amount) || Number(form.amount) <= 0) { toast.error('Amount must be > 0'); return; }
    if (kind === 'monthly' && !form.period_month) { toast.error('Month required'); return; }
    try {
      await api.post(`/indent-labour-payment/projects/${projectId}/salary`, { ...form, kind, amount: Number(form.amount) });
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title={kind === 'legacy' ? 'Legacy Salary (pre-SOTYN.AI carry)' : 'Monthly Salary Entry'}>
      <form onSubmit={submit} className="space-y-3">
        {kind === 'legacy' && (
          <div className="text-xs bg-amber-50 border-l-2 border-amber-400 p-2 rounded">
            One-off bulk capture of salary already spent on this project before the SOTYN.AI went live.  Only one legacy row per project.
          </div>
        )}
        <div>
          <label className="label">Employee Name {kind === 'monthly' && '*'}</label>
          <input className="input" value={form.employee_name}
            onChange={e => setForm({ ...form, employee_name: e.target.value })}
            placeholder={kind === 'legacy' ? '(optional — bulk row)' : 'Staff member'} />
        </div>
        {kind === 'monthly' && (
          <div>
            <label className="label">Month *</label>
            <input type="month" className="input" value={form.period_month}
              onChange={e => setForm({ ...form, period_month: e.target.value })} required />
          </div>
        )}
        <div>
          <label className="label">Amount (₹) *</label>
          <input type="number" min="0" step="1" className="input" value={form.amount}
            onChange={e => setForm({ ...form, amount: e.target.value })} required autoFocus />
        </div>
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── L2 Daily Wages sub-section ────────────────────────────────
function L2DailyWages({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [adding, setAdding] = useState(null);

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/daily-wages`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const remove = async (id) => {
    if (!confirm('Delete this daily wage entry?')) return;
    try {
      await api.delete(`/indent-labour-payment/daily-wages/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const hasLegacy = rows.some(r => r.kind === 'legacy');

  return (
    <div className="space-y-2">
      <div className="flex gap-2">
        <button onClick={() => setAdding('legacy')} disabled={hasLegacy}
          className="btn btn-secondary text-xs flex items-center gap-1">
          <FiPlus size={12} /> {hasLegacy ? '✓ Legacy captured' : 'Add Legacy Daily Wages'}
        </button>
        <button onClick={() => setAdding('entry')} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Entry (rate × days)
        </button>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">Kind</th>
              <th className="text-left px-2 py-1.5">Description</th>
              <th className="text-right px-2 py-1.5">Per Day ₹</th>
              <th className="text-right px-2 py-1.5">Days</th>
              <th className="text-right px-2 py-1.5">Total</th>
              <th className="text-left px-2 py-1.5">Notes</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="text-center py-4 text-gray-400">No daily wage entries yet</td></tr>}
            {rows.map(r => (
              <tr key={r.id} className="border-t">
                <td className="px-2 py-1.5">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                    r.kind === 'legacy' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
                  }`}>{r.kind}</span>
                </td>
                <td className="px-2 py-1.5">{r.description || '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.kind === 'entry' ? fmtINRFull(r.per_day_rate) : '—'}</td>
                <td className="px-2 py-1.5 text-right">{r.kind === 'entry' ? r.days_required : '—'}</td>
                <td className="px-2 py-1.5 text-right font-semibold">{fmtINRFull(r.total_amount)}</td>
                <td className="px-2 py-1.5 text-xs text-gray-600">{r.notes || '—'}</td>
                <td className="px-2 py-1.5 text-right">
                  <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {adding && (
        <AddDailyWage kind={adding} projectId={projectId}
          onClose={() => setAdding(null)}
          onSaved={() => { setAdding(null); load(); onChange(); }} />
      )}
    </div>
  );
}

function AddDailyWage({ kind, projectId, onClose, onSaved }) {
  const [form, setForm] = useState({
    description: '', per_day_rate: '', days_required: '', total_amount: '', notes: '',
  });
  const computed = kind === 'entry'
    ? (Number(form.per_day_rate) || 0) * (Number(form.days_required) || 0)
    : Number(form.total_amount) || 0;
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/indent-labour-payment/projects/${projectId}/daily-wages`, {
        ...form, kind,
        per_day_rate: Number(form.per_day_rate) || 0,
        days_required: Number(form.days_required) || 0,
        total_amount: kind === 'legacy' ? Number(form.total_amount) || 0 : 0,
      });
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };
  return (
    <Modal isOpen={true} onClose={onClose} title={kind === 'legacy' ? 'Legacy Daily Wages (pre-SOTYN.AI)' : 'Daily Wage Entry'}>
      <form onSubmit={submit} className="space-y-3">
        {kind === 'legacy' && (
          <div className="text-xs bg-amber-50 border-l-2 border-amber-400 p-2 rounded">
            One-off bulk capture of daily wages paid before the SOTYN.AI went live.
          </div>
        )}
        <div>
          <label className="label">Description</label>
          <input className="input" value={form.description}
            onChange={e => setForm({ ...form, description: e.target.value })}
            placeholder="e.g. Mason gang · structural work" />
        </div>
        {kind === 'entry' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Per Day Rate ₹ *</label>
                <input type="number" min="0" step="1" className="input" value={form.per_day_rate}
                  onChange={e => setForm({ ...form, per_day_rate: e.target.value })} required autoFocus />
              </div>
              <div>
                <label className="label">Days Required *</label>
                <input type="number" min="0" step="0.5" className="input" value={form.days_required}
                  onChange={e => setForm({ ...form, days_required: e.target.value })} required />
              </div>
            </div>
            <div className="bg-violet-50 border border-violet-200 p-2 rounded text-sm">
              Computed total: <strong className="text-violet-700">{fmtINRFull(computed)}</strong>
            </div>
          </>
        ) : (
          <div>
            <label className="label">Bulk Amount (₹) *</label>
            <input type="number" min="0" step="1" className="input" value={form.total_amount}
              onChange={e => setForm({ ...form, total_amount: e.target.value })} required autoFocus />
          </div>
        )}
        <div>
          <label className="label">Notes</label>
          <textarea className="input" rows={2} value={form.notes}
            onChange={e => setForm({ ...form, notes: e.target.value })} />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── L3 Work Orders sub-section ────────────────────────────────
function L3WorkOrders({ projectId, onChange }) {
  const [rows, setRows] = useState([]);
  const [editing, setEditing] = useState(null); // null | { id?: number, ... }
  // Phase 4 (mam 2026-06-02): when mam clicks the "Linked DPRs" badge
  // on a WO row we open a slide-out / modal listing every DPR work
  // line that referenced that WO — site, date, qty, amount, who
  // submitted.  Lets her audit the progress claim before releasing
  // the next payment.
  const [dprLinksFor, setDprLinksFor] = useState(null); // { wo, items: [] }

  const load = () => {
    api.get(`/indent-labour-payment/projects/${projectId}/work-orders`).then(r => setRows(r.data || []));
  };
  useEffect(load, [projectId]);

  const openDprLinks = async (wo) => {
    setDprLinksFor({ wo, items: null });  // null = loading
    try {
      const r = await api.get(`/indent-labour-payment/work-orders/${wo.id}/dpr-items`);
      setDprLinksFor({ wo, items: r.data || [] });
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load linked DPRs');
      setDprLinksFor({ wo, items: [] });
    }
  };

  const remove = async (id) => {
    if (!confirm('Delete this Work Order?')) return;
    try {
      await api.delete(`/indent-labour-payment/work-orders/${id}`);
      toast.success('Deleted'); load(); onChange();
    } catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  const changeStatus = async (id, status) => {
    try {
      await api.put(`/indent-labour-payment/work-orders/${id}`, { status });
      toast.success('Status updated'); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update status'); }
  };

  const routeWO = async (id, routed_to) => {
    try {
      const r = await api.post(`/indent-labour-payment/work-orders/${id}/route`, { routed_to });
      toast.success(`Sent to ${r.data.routed_to === 'site_engineer' ? 'Site Engineer' : 'Contractor'}`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not route'); }
  };

  return (
    <div className="space-y-2">
      <div className="flex gap-2 items-center">
        <button onClick={() => setEditing({})} className="btn btn-primary text-xs flex items-center gap-1">
          <FiPlus size={12} /> Add Work Order
        </button>
        <div className="text-[10px] text-gray-500 ml-2">Count is dynamic — add as many WOs as the project needs.</div>
      </div>

      <div className="overflow-x-auto border rounded">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th className="text-left px-2 py-1.5">WO #</th>
              <th className="text-left px-2 py-1.5">Sub-contractor</th>
              <th className="text-left px-2 py-1.5">Scope</th>
              <th className="text-right px-2 py-1.5">Value</th>
              <th className="text-right px-2 py-1.5">Paid</th>
              <th className="text-right px-2 py-1.5">Balance</th>
              {/* Phase 4 — DPR progress badge column */}
              <th className="text-center px-2 py-1.5">DPR Progress</th>
              <th className="text-center px-2 py-1.5">Status</th>
              <th className="text-left px-2 py-1.5">File</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={10} className="text-center py-4 text-gray-400">No work orders yet</td></tr>}
            {rows.map(r => {
              const pct = +r.dpr_progress_pct || 0;
              const cnt = +r.dpr_linked_count || 0;
              // Colour the chip by claim health vs payment:
              //   green   — claim ≤ paid (you're ahead, fully paid)
              //   amber   — claim > paid (sub-con has earned more, release)
              //   red     — claim > 110% of WO value (sanity warn)
              //   gray    — no DPR yet
              let chipCls = 'bg-gray-100 text-gray-500 border-gray-200';
              if (cnt > 0) {
                if (pct > 110) chipCls = 'bg-red-100 text-red-700 border-red-300';
                else if ((+r.dpr_linked_amount || 0) > (+r.amount_paid || 0)) chipCls = 'bg-amber-100 text-amber-700 border-amber-300';
                else chipCls = 'bg-emerald-100 text-emerald-700 border-emerald-300';
              }
              return (
                <tr key={r.id} className="border-t">
                  <td className="px-2 py-1.5 font-mono text-xs">{r.wo_number || '—'}</td>
                  <td className="px-2 py-1.5">{r.sub_contractor_name || '—'}</td>
                  <td className="px-2 py-1.5 text-xs">{r.scope || '—'}</td>
                  <td className="px-2 py-1.5 text-right">{fmtINRFull(r.planned_value)}</td>
                  <td className="px-2 py-1.5 text-right text-emerald-700 font-semibold">{fmtINRFull(r.amount_paid)}</td>
                  <td className={`px-2 py-1.5 text-right font-semibold ${r.balance > 0 ? 'text-amber-700' : 'text-gray-400'}`}>
                    {fmtINRFull(r.balance)}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    {cnt > 0 ? (
                      <button
                        onClick={() => openDprLinks(r)}
                        className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${chipCls} hover:shadow-sm`}
                        title="Click to see each DPR line that contributed to this %"
                      >
                        {pct.toFixed(1)}% · {cnt} DPR{cnt === 1 ? '' : 's'}
                      </button>
                    ) : (
                      <span className="text-[10px] text-gray-400 italic">no DPR yet</span>
                    )}
                  </td>
                  <td className="px-2 py-1.5 text-center">
                    <select
                      value={r.status || 'draft'}
                      onChange={e => changeStatus(r.id, e.target.value)}
                      className={`text-[10px] font-semibold rounded-full border-0 px-2 py-0.5 ${WO_STATUS_CLS[r.status] || 'bg-gray-100 text-gray-600'}`}
                    >
                      {WO_STATUS_OPTIONS.map(s => <option key={s} value={s}>{WO_STATUS_LABEL[s]}</option>)}
                    </select>
                    {r.routed_to && (
                      <div className="text-[9px] text-gray-400 mt-0.5">→ {r.routed_to === 'site_engineer' ? 'Site Engineer' : 'Contractor'}</div>
                    )}
                  </td>
                  <td className="px-2 py-1.5">
                    {r.work_order_file_url
                      ? <a href={r.work_order_file_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline flex items-center gap-1 text-xs">
                          <FiExternalLink size={11} /> View
                        </a>
                      : <span className="text-gray-300 text-xs">—</span>}
                  </td>
                  <td className="px-2 py-1.5 text-right flex gap-2 justify-end items-center">
                    <a href={`/work-order-print/${r.id}`} target="_blank" rel="noreferrer" className="text-gray-400 hover:text-gray-700" title="Print / Save as PDF"><FiPrinter size={12} /></a>
                    <button onClick={() => routeWO(r.id, 'site_engineer')} className="text-gray-400 hover:text-indigo-600" title="Send to Site Engineer"><FiSend size={12} /></button>
                    <button onClick={() => setEditing(r)} className="text-blue-500 hover:text-blue-700"><FiEdit2 size={12} /></button>
                    <button onClick={() => remove(r.id)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <AddOrEditWorkOrder wo={editing} projectId={projectId}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); load(); onChange(); }} />
      )}

      {dprLinksFor && (
        <DprLinksModal data={dprLinksFor} onClose={() => setDprLinksFor(null)} />
      )}
    </div>
  );
}

// Phase 4 modal — shows every DPR work line that touched this WO.
// Each row is the contractor's claim of work-done that mam is verifying.
function DprLinksModal({ data, onClose }) {
  const { wo, items } = data;
  const totalAmount = (items || []).reduce((s, it) => s + (+it.amount || 0), 0);
  return (
    <Modal isOpen={true} onClose={onClose} title={`Linked DPRs — ${wo.wo_number || `WO #${wo.id}`}`} wide>
      <div className="space-y-3">
        <div className="grid grid-cols-3 gap-3 text-xs">
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">Sub-contractor</div>
            <div className="font-semibold">{wo.sub_contractor_name || '—'}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">WO Value</div>
            <div className="font-semibold text-gray-800">{fmtINRFull(wo.planned_value)}</div>
          </div>
          <div className="bg-gray-50 rounded p-2">
            <div className="text-[10px] text-gray-500 uppercase">Already Paid</div>
            <div className="font-semibold text-emerald-700">{fmtINRFull(wo.amount_paid)}</div>
          </div>
        </div>
        {items === null && <div className="text-center py-6 text-gray-400 text-sm">Loading linked DPRs…</div>}
        {items && items.length === 0 && (
          <div className="text-center py-6 text-gray-400 text-sm">
            No DPR work items linked to this WO yet.
            <div className="text-[10px] text-gray-400 mt-1">Once site engineers tag work lines against this WO in their DPRs, they'll show up here.</div>
          </div>
        )}
        {items && items.length > 0 && (
          <div className="overflow-x-auto border rounded">
            <table className="w-full text-xs">
              <thead className="bg-gray-50 text-gray-600">
                <tr>
                  <th className="text-left px-2 py-1.5">Date</th>
                  <th className="text-left px-2 py-1.5">Site</th>
                  <th className="text-left px-2 py-1.5">Description</th>
                  <th className="text-left px-2 py-1.5">Location</th>
                  <th className="text-right px-2 py-1.5">Qty</th>
                  <th className="text-left px-2 py-1.5">Unit</th>
                  <th className="text-right px-2 py-1.5">Rate</th>
                  <th className="text-right px-2 py-1.5">Amount</th>
                  <th className="text-left px-2 py-1.5">By</th>
                </tr>
              </thead>
              <tbody>
                {items.map(it => (
                  <tr key={it.id} className="border-t">
                    <td className="px-2 py-1.5 whitespace-nowrap">
                      {it.report_date ? fmtDate(it.report_date, { day: '2-digit', month: 'short', year: '2-digit' }) : '—'}
                    </td>
                    <td className="px-2 py-1.5">{it.site_name || '—'}</td>
                    <td className="px-2 py-1.5">{it.description || '—'}</td>
                    <td className="px-2 py-1.5 text-gray-500">{it.floor_zone || '—'}</td>
                    <td className="px-2 py-1.5 text-right font-semibold">{(+it.actual_qty || 0).toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1.5">{it.unit || '—'}</td>
                    <td className="px-2 py-1.5 text-right">₹{(+it.rate || 0).toLocaleString('en-IN')}</td>
                    <td className="px-2 py-1.5 text-right font-semibold text-emerald-700">{fmtINRFull(it.amount)}</td>
                    <td className="px-2 py-1.5 text-[10px] text-gray-500">{it.submitted_by_name || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-emerald-50 font-semibold">
                <tr>
                  <td colSpan={7} className="px-2 py-2 text-right">Total claimed via DPR →</td>
                  <td className="px-2 py-2 text-right text-emerald-700">{fmtINRFull(totalAmount)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
        <div className="flex justify-end pt-2 border-t">
          <button onClick={onClose} className="btn btn-secondary">Close</button>
        </div>
      </div>
    </Modal>
  );
}

function AddOrEditWorkOrder({ wo, projectId, onClose, onSaved }) {
  const isEdit = !!wo.id;
  // Labour costing (Labour Management System, 2026-08). Lines carry the rate
  // snapshotted from the Labour Rate Master at the moment they were added, so
  // an existing WO keeps its price after HR revises the master.
  const [labour, setLabour] = useState([]);
  const [labourWindowOpen, setLabourWindowOpen] = useState(false);
  const [pendingLabour, setPendingLabour] = useState([]);

  useEffect(() => {
    if (!isEdit) return;
    api.get(`/indent-labour-payment/work-orders/${wo.id}/labour`)
      .then(r => setLabour(r.data?.rows || []))
      .catch(() => {});
  }, [isEdit, wo.id]);

  const allLabour = isEdit ? labour : pendingLabour;

  // Man-days, not a sum of `days`: two crews each running 10 days is 10
  // calendar days but 130 man-days, and man-days is what drives cost.
  const labourSummary = allLabour.reduce((a, l) => {
    const qty = Number(l.quantity) || 0;
    const days = Number(l.days) || 0;
    const rate = Number(l.rate_snapshot ?? l.standard_rate) || 0;
    return {
      categories: a.categories + 1,
      labourers: a.labourers + qty,
      man_days: a.man_days + qty * days,
      total: a.total + (l.amount != null ? Number(l.amount) : rate * qty * days),
    };
  }, { categories: 0, labourers: 0, man_days: 0, total: 0 });

  const addLabour = async (line) => {
    if (!isEdit) { setPendingLabour(prev => [...prev, { ...line, ...line.preview }]); return; }
    try {
      const r = await api.post(`/indent-labour-payment/work-orders/${wo.id}/labour`, {
        rate_id: line.rate_id, quantity: line.quantity, days: line.days,
        overtime_hours: line.overtime_hours || 0,
      });
      setLabour(prev => [...prev, { ...line.preview, id: r.data.id, amount: r.data.amount,
        rate_snapshot: line.preview.standard_rate }]);
      toast.success('Labour line added');
    } catch (e) { toast.error(e.response?.data?.error || 'Could not add'); }
  };

  const removeLabour = async (line, idx) => {
    if (!isEdit || !line.id) { setPendingLabour(prev => prev.filter((_, i) => i !== idx)); return; }
    try {
      await api.delete(`/indent-labour-payment/work-orders/labour/${line.id}`);
      setLabour(prev => prev.filter((_, i) => i !== idx));
      toast.success('Labour line removed');
    } catch (e) { toast.error(e.response?.data?.error || 'Could not remove'); }
  };

  const [form, setForm] = useState({
    wo_number: wo.wo_number || '',
    sub_contractor_name: wo.sub_contractor_name || '',
    scope: wo.scope || '',
    planned_value: wo.planned_value || '',
    amount_paid: wo.amount_paid || '',
    work_order_file_url: wo.work_order_file_url || '',
    planned_start: wo.planned_start || '',
    planned_end: wo.planned_end || '',
  });
  const [uploading, setUploading] = useState(false);

  const upload = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, work_order_file_url: r.data.url }));
      toast.success('Uploaded');
    } catch (e) { toast.error('Upload failed'); }
    finally { setUploading(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    const payload = {
      ...form,
      planned_value: Number(form.planned_value) || 0,
      amount_paid: Number(form.amount_paid) || 0,
    };
    try {
      if (isEdit) {
        await api.put(`/indent-labour-payment/work-orders/${wo.id}`, payload);
      } else {
        const r = await api.post(`/indent-labour-payment/projects/${projectId}/work-orders`, payload);
        // Labour lines FK to the work order, so they can only be written once
        // the row exists. Each POST re-reads the rate from the master — the
        // preview shown while picking is never trusted as the price.
        const woId = r.data?.id;
        const failed = [];
        for (const l of pendingLabour) {
          try {
            await api.post(`/indent-labour-payment/work-orders/${woId}/labour`, {
              rate_id: l.rate_id, quantity: l.quantity, days: l.days,
              overtime_hours: l.overtime_hours || 0,
            });
          } catch (err) {
            failed.push(`${l.labour_category || 'line'}: ${err.response?.data?.error || 'failed'}`);
          }
        }
        // The Work Order itself saved. Say plainly which lines didn't, rather
        // than a blanket "Saved" that hides a missing crew.
        if (failed.length) {
          toast.error(`Work Order saved, but ${failed.length} labour line(s) failed — ${failed[0]}`);
          onSaved();
          return;
        }
      }
      toast.success('Saved'); onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Save failed'); }
  };

  return (
    <Modal isOpen={true} onClose={onClose} title={isEdit ? `Edit ${wo.wo_number || 'Work Order'}` : 'New Work Order'} wide>
      <form onSubmit={submit} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WO Number</label>
            <input className="input" value={form.wo_number}
              onChange={e => setForm({ ...form, wo_number: e.target.value })}
              placeholder="WO/2026/SEPL/0023" />
          </div>
          <div>
            <label className="label">Sub-contractor</label>
            <input className="input" value={form.sub_contractor_name}
              onChange={e => setForm({ ...form, sub_contractor_name: e.target.value })}
              placeholder="Company / name" />
          </div>
        </div>
        <div>
          <label className="label">Scope</label>
          <textarea className="input" rows={2} value={form.scope}
            onChange={e => setForm({ ...form, scope: e.target.value })} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WO Value (₹) *</label>
            <input type="number" min="0" step="1" className="input" value={form.planned_value}
              onChange={e => setForm({ ...form, planned_value: e.target.value })} required />
          </div>
          <div>
            <label className="label">Amount Paid (₹)</label>
            <input type="number" min="0" step="1" className="input" value={form.amount_paid}
              onChange={e => setForm({ ...form, amount_paid: e.target.value })} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Planned Start</label>
            <input type="date" className="input" value={form.planned_start}
              onChange={e => setForm({ ...form, planned_start: e.target.value })} />
          </div>
          <div>
            <label className="label">Planned End</label>
            <input type="date" className="input" value={form.planned_end}
              onChange={e => setForm({ ...form, planned_end: e.target.value })} />
          </div>
        </div>
        <div>
          <label className="label">Work Order File</label>
          <div className="flex items-center gap-2">
            <input type="file" onChange={e => upload(e.target.files[0])} className="text-xs" />
            {uploading && <span className="text-xs text-gray-500">Uploading…</span>}
            {form.work_order_file_url && (
              <a href={form.work_order_file_url} target="_blank" rel="noreferrer"
                 className="text-xs text-blue-600 underline flex items-center gap-1">
                <FiExternalLink size={11} /> View uploaded
              </a>
            )}
          </div>
        </div>

        {/* ── Labour cost (Labour Management System, 2026-08) ──────────
            Rates come from the HR-maintained Labour Rate Master and are never
            typed here. planned_value above is untouched — it stays the
            sub-contract / quotation figure, with labour as its own total. */}
        <div className="border-t pt-3 space-y-2">
          <div className="flex items-center justify-between">
            <div>
              <div className="text-sm font-semibold">Labour Cost</div>
              <div className="text-[10px] text-gray-500">
                Rates are set by HR and cannot be edited here. Existing Work Orders keep their original rates.
              </div>
            </div>
            <button type="button" onClick={() => setLabourWindowOpen(true)}
              className="btn btn-secondary text-xs flex items-center gap-1">
              <FiPlus size={12} /> Labour Rate Window
            </button>
          </div>

          {allLabour.length === 0 ? (
            <div className="text-xs text-gray-400 border rounded p-3 text-center">
              No labour added. Open the Labour Rate Window to pick categories.
            </div>
          ) : (
            <>
              <div className="overflow-x-auto border rounded">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50"><tr>
                    <th className="text-left px-2 py-1.5">Category</th>
                    <th className="text-left px-2 py-1.5">Trade</th>
                    <th className="text-right px-2 py-1.5">Rate</th>
                    <th className="text-right px-2 py-1.5">Labourers</th>
                    <th className="text-right px-2 py-1.5">Days</th>
                    <th className="text-right px-2 py-1.5">Total</th>
                    <th></th>
                  </tr></thead>
                  <tbody>
                    {allLabour.map((l, i) => {
                      const rate = Number(l.rate_snapshot ?? l.standard_rate) || 0;
                      const total = l.amount != null ? Number(l.amount)
                        : rate * (Number(l.quantity) || 0) * (Number(l.days) || 0);
                      return (
                        <tr key={l.id || `pending-${i}`} className="border-t">
                          <td className="px-2 py-1.5 font-medium">{l.labour_category}</td>
                          <td className="px-2 py-1.5 text-gray-600">{l.trade || '—'}</td>
                          <td className="px-2 py-1.5 text-right">
                            ₹{rate.toLocaleString('en-IN')}
                            <span className="text-[10px] text-gray-400"> /{l.unit || 'Day'}</span>
                          </td>
                          <td className="px-2 py-1.5 text-right">{l.quantity}</td>
                          <td className="px-2 py-1.5 text-right">{l.days}</td>
                          <td className="px-2 py-1.5 text-right font-semibold">
                            ₹{total.toLocaleString('en-IN')}
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <button type="button" onClick={() => removeLabour(l, i)}
                              className="p-1 rounded hover:bg-red-50 text-red-600" title="Remove">
                              <FiTrash2 size={12} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
                {[
                  ['Categories', labourSummary.categories],
                  ['Total labourers', labourSummary.labourers],
                  ['Man-days', labourSummary.man_days],
                  ['Avg per category', '₹' + Math.round(labourSummary.categories
                    ? labourSummary.total / labourSummary.categories : 0).toLocaleString('en-IN')],
                  ['Total labour cost', '₹' + Math.round(labourSummary.total).toLocaleString('en-IN')],
                ].map(([lbl, value], i, arr) => (
                  <div key={lbl} className={`rounded p-2 ${i === arr.length - 1
                    ? 'bg-emerald-50 border border-emerald-200' : 'bg-gray-50'}`}>
                    <div className="text-[10px] text-gray-500 uppercase">{lbl}</div>
                    <div className={`font-semibold ${i === arr.length - 1 ? 'text-emerald-800' : ''}`}>{value}</div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" className="btn btn-primary">Save</button>
        </div>
      </form>

      <LabourRateWindow
        isOpen={labourWindowOpen}
        picked={allLabour}
        onPick={addLabour}
        onClose={() => setLabourWindowOpen(false)}
      />
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// WORK ORDERS TAB — Phase 3.  Global registry across every project
// (the L3 tab inside a project's detail view stays the place to
// manage a single project's WOs day-to-day; this is the cross-
// project list + quick-create).
// ═══════════════════════════════════════════════════════════════
function WorkOrdersTab() {
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState('');
  const [status, setStatus] = useState([]);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    api.get('/indent-labour-payment/projects').then(r => setProjects(r.data || [])).catch(() => {});
  }, []);

  const load = () => {
    setLoading(true);
    const params = {};
    if (pid) params.project_id = pid;
    if (status.length) params.status = status.join(',');
    api.get('/indent-labour-payment/work-orders', { params })
      .then(r => setRows(r.data || []))
      .catch(() => toast.error('Could not load Work Orders'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [pid, status]);

  const remove = async (row) => {
    if (!window.confirm(`Delete ${row.wo_number || 'this Work Order'}?`)) return;
    try { await api.delete(`/indent-labour-payment/work-orders/${row.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not delete'); }
  };

  const totals = useMemo(() => rows.reduce((acc, r) => {
    acc.planned += Number(r.planned_value || 0);
    acc.paid += Number(r.amount_paid || 0);
    return acc;
  }, { planned: 0, paid: 0 }), [rows]);

  return (
    <div className="space-y-3">
      <div className="card p-3 flex gap-3 flex-wrap items-end">
        <div>
          <label className="text-xs text-gray-600 block mb-1">Project</label>
          <select value={pid} onChange={e => setPid(e.target.value)} className="border rounded px-2 py-1.5 text-sm min-w-[200px]">
            <option value="">All projects</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-600 block mb-1">Status</label>
{/* Status - tick as many as you like (mam 2026-09-12). */}
          <div className="w-[248px]">
            <StatusMultiSelect
              options={WO_STATUS_OPTIONS.map(s => ({ id: s, name: WO_STATUS_LABEL[s] }))}
              value={status}
              onChange={setStatus}
              placeholder="All statuses"
              label=""
            />
          </div>
        </div>
        <button onClick={load} className="btn btn-secondary">Refresh</button>
        <button onClick={() => setNewOpen(true)} className="btn btn-primary flex items-center gap-1.5">
          <FiPlus size={14} /> New Work Order
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Work Orders" value={rows.length} color="indigo" />
        <Tile label="Planned value" value={fmtINR(totals.planned)} color="blue" />
        <Tile label="Paid so far" value={fmtINR(totals.paid)} color="emerald" />
        <Tile label="Balance" value={fmtINR(totals.planned - totals.paid)} color="amber" />
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">WO No</th>
              <th className="text-left">Project</th>
              <th className="text-left">Contractor</th>
              <th className="text-left">Location</th>
              <th className="text-right">Planned</th>
              <th className="text-right">Paid</th>
              <th className="text-right">Balance</th>
              <th className="text-left">Approved By</th>
              <th className="text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={10} className="text-center py-6 text-gray-400">Loading…</td></tr>)}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={10} className="text-center py-8 text-gray-400">No Work Orders yet.</td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="font-semibold">
                  <div className="flex items-center gap-1">
                    {r.wo_number || '—'}
                    {r.work_order_file_url && (
                      <a href={r.work_order_file_url} target="_blank" rel="noreferrer" title="View file"
                        className="text-gray-400 hover:text-blue-600">
                        <FiUpload size={11} />
                      </a>
                    )}
                  </div>
                </td>
                <td>{r.project_name}</td>
                <td>
                  <div className="flex items-center gap-1">
                    {r.sub_contractor_name || '—'}
                    {r.contractor_document_url && (
                      <a href={r.contractor_document_url} target="_blank" rel="noreferrer" title="View contractor document"
                        className="text-gray-400 hover:text-blue-600">
                        <FiUpload size={11} />
                      </a>
                    )}
                  </div>
                  {r.contact_number && <div className="text-xs text-gray-500">{r.contact_number}</div>}
                </td>
                <td className="text-xs text-gray-600">{r.location || '—'}</td>
                <td className="text-right">{fmtINRFull(r.planned_value)}</td>
                <td className="text-right">{fmtINRFull(r.amount_paid)}</td>
                <td className="text-right">{fmtINRFull(r.balance)}</td>
                <td className="text-xs">{r.approved_by || '—'}</td>
                <td>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${WO_STATUS_CLS[r.status] || 'bg-gray-100'}`}>
                    {WO_STATUS_LABEL[r.status] || r.status}
                  </span>
                </td>
                <td className="text-right space-x-2">
                  <Link to={`/work-order-print/${r.id}`} target="_blank" className="text-xs text-blue-600 hover:underline">
                    <FiPrinter size={11} className="inline" /> Print
                  </Link>
                  <button onClick={() => remove(r)} className="text-xs text-red-600 hover:underline">Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {newOpen && (
        <NewWorkOrderModal
          projects={projects}
          defaultProjectId={pid}
          onClose={() => setNewOpen(false)}
          onCreated={() => { setNewOpen(false); load(); }}
        />
      )}
    </div>
  );
}

const WO_APPROVERS = ['Ankur Kalpesh', 'Nitin Jain', 'Prabhdeep Singh'];

function NewWorkOrderModal({ projects, defaultProjectId, onClose, onCreated }) {
  const [form, setForm] = useState({
    project_id: defaultProjectId || '', wo_number: '', sub_contractor_name: '',
    contact_number: '', location: '', scope: '', planned_value: '',
    planned_start: '', planned_end: '', approved_by: '',
    work_order_file_url: '', contractor_document_url: '',
  });
  const [saving, setSaving] = useState(false);
  const [uploadingField, setUploadingField] = useState(null); // 'work_order_file_url' | 'contractor_document_url' | null

  const uploadFile = async (field, file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error('File too large (max 10 MB)');
    setUploadingField(field);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, [field]: r.data?.url || '' }));
      toast.success('File attached');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploadingField(null);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.project_id) return toast.error('Pick a project');
    if (!form.wo_number && !form.sub_contractor_name && !form.scope) {
      return toast.error('Provide at least WO number, contractor name, or scope');
    }
    setSaving(true);
    try {
      await api.post(`/indent-labour-payment/projects/${form.project_id}/work-orders`, form);
      toast.success('Work Order created');
      onCreated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
    }
    setSaving(false);
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="New Work Order" wide>
      <form onSubmit={save} className="space-y-3">
        <div>
          <label className="label">Project</label>
          <select required className="input" value={form.project_id}
            onChange={e => setForm(f => ({ ...f, project_id: e.target.value }))}>
            <option value="">Select project…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">WO Number</label>
            <input className="input" value={form.wo_number}
              onChange={e => setForm(f => ({ ...f, wo_number: e.target.value }))} placeholder="Auto if left blank" />
          </div>
          <div>
            <label className="label">Contractor Name</label>
            <input className="input" value={form.sub_contractor_name}
              onChange={e => setForm(f => ({ ...f, sub_contractor_name: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Contact Number</label>
            <input type="tel" className="input" value={form.contact_number}
              onChange={e => setForm(f => ({ ...f, contact_number: e.target.value }))} placeholder="9876543210" />
          </div>
          <div>
            <label className="label">Location</label>
            <input className="input" value={form.location}
              onChange={e => setForm(f => ({ ...f, location: e.target.value }))} placeholder="Site / floor / zone" />
          </div>
        </div>
        <div>
          <label className="label">Contractor Document (PDF / JPG)</label>
          <FileField url={form.contractor_document_url} uploading={uploadingField === 'contractor_document_url'}
            onUpload={file => uploadFile('contractor_document_url', file)}
            onRemove={() => setForm(f => ({ ...f, contractor_document_url: '' }))} />
          <p className="text-[10px] text-gray-500 mt-1">ID proof, registration or agreement — the contractor's own paperwork, separate from the WO file.</p>
        </div>
        <div>
          <label className="label">Scope</label>
          <textarea className="input" rows={2} value={form.scope}
            onChange={e => setForm(f => ({ ...f, scope: e.target.value }))} />
        </div>
        <div className="grid grid-cols-3 gap-3">
          <div>
            <label className="label">Rate / Amount (Rs)</label>
            <input type="number" step="any" className="input" value={form.planned_value}
              onChange={e => setForm(f => ({ ...f, planned_value: e.target.value }))} />
          </div>
          <div>
            <label className="label">Start Date</label>
            <input type="date" className="input" value={form.planned_start}
              onChange={e => setForm(f => ({ ...f, planned_start: e.target.value }))} />
          </div>
          <div>
            <label className="label">End</label>
            <input type="date" className="input" value={form.planned_end}
              onChange={e => setForm(f => ({ ...f, planned_end: e.target.value }))} />
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3 items-start">
          <div>
            <label className="label">Approved By</label>
            <select className="input" value={form.approved_by}
              onChange={e => setForm(f => ({ ...f, approved_by: e.target.value }))}>
              <option value="">Select approver…</option>
              {WO_APPROVERS.map(a => <option key={a} value={a}>{a}</option>)}
            </select>
          </div>
          <div>
            <label className="label">Work Order File (PDF / JPG)</label>
            <FileField url={form.work_order_file_url} uploading={uploadingField === 'work_order_file_url'}
              onUpload={file => uploadFile('work_order_file_url', file)}
              onRemove={() => setForm(f => ({ ...f, work_order_file_url: '' }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// Shared upload/preview control for a single PDF/JPG field — used by both
// the Work Order File and Contractor Document fields above.
function FileField({ url, uploading, onUpload, onRemove }) {
  if (url) {
    return (
      <div className="flex items-center gap-2">
        <a href={url} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 px-2 py-1.5 bg-gray-100 rounded border border-gray-300 text-xs text-blue-700 hover:underline">
          <FiUpload size={12} /> View file
        </a>
        <button type="button" onClick={onRemove} className="text-xs text-red-600 hover:underline">Remove</button>
      </div>
    );
  }
  return (
    <label className="flex items-center gap-1.5 text-xs text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1.5 bg-blue-50 border border-blue-200 rounded w-fit">
      <FiUpload size={13} /> {uploading ? 'Uploading…' : 'Choose file'}
      <input type="file" accept="application/pdf,image/jpeg,image/jpg" className="hidden"
        disabled={uploading} onChange={e => onUpload(e.target.files?.[0])} />
    </label>
  );
}

// ═══════════════════════════════════════════════════════════════
// MB / CDPR TAB — Phase 5.  Period snapshot of WO lines per project,
// lockable once finalised.
// ═══════════════════════════════════════════════════════════════
function MbTab() {
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newOpen, setNewOpen] = useState(false);

  useEffect(() => {
    api.get('/indent-labour-payment/projects').then(r => {
      setProjects(r.data || []);
      if (!pid && r.data?.length) setPid(String(r.data[0].id));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = () => {
    if (!pid) return;
    setLoading(true);
    api.get(`/indent-labour-payment/projects/${pid}/mb`)
      .then(r => setRows(r.data || []))
      .catch(() => toast.error('Could not load MB sheets'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [pid]);

  const finalize = async (row) => {
    if (!window.confirm(`Finalise ${row.mb_no}? This locks it permanently.`)) return;
    try { await api.post(`/indent-labour-payment/mb/${row.id}/finalize`); toast.success('MB finalised'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not finalise'); }
  };
  const remove = async (row) => {
    if (!window.confirm(`Delete ${row.mb_no}?`)) return;
    try { await api.delete(`/indent-labour-payment/mb/${row.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Could not delete'); }
  };

  return (
    <div className="space-y-3">
      <div className="card p-3 flex gap-3 flex-wrap items-end">
        <div>
          <label className="text-xs text-gray-600 block mb-1">Project</label>
          <select value={pid} onChange={e => setPid(e.target.value)} className="border rounded px-2 py-1.5 text-sm min-w-[220px]">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <button onClick={load} className="btn btn-secondary">Refresh</button>
        <button onClick={() => setNewOpen(true)} disabled={!pid} className="btn btn-primary flex items-center gap-1.5">
          <FiPlus size={14} /> New MB Sheet
        </button>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">MB No</th>
              <th className="text-left">Period</th>
              <th className="text-right">Lines</th>
              <th className="text-right">Qty</th>
              <th className="text-right">Amount</th>
              <th className="text-left">Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={7} className="text-center py-6 text-gray-400">Loading…</td></tr>)}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">No MB sheets yet for this project.</td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="font-semibold">{r.mb_no}</td>
                <td>{fmtDate(r.period_from)} – {fmtDate(r.period_to)}</td>
                <td className="text-right">{r.line_count}</td>
                <td className="text-right">{r.total_qty}</td>
                <td className="text-right font-semibold">{fmtINRFull(r.total_amount)}</td>
                <td>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                    r.status === 'finalised' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-600'}`}>
                    {r.status === 'finalised' ? <FiLock size={10} className="inline mr-1" /> : null}
                    {r.status}
                  </span>
                </td>
                <td className="text-right space-x-2">
                  {r.status !== 'finalised' && (
                    <>
                      <button onClick={() => finalize(r)} className="text-xs text-emerald-600 hover:underline">Finalise</button>
                      <button onClick={() => remove(r)} className="text-xs text-red-600 hover:underline">Delete</button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {newOpen && <NewMbModal projectId={pid} onClose={() => setNewOpen(false)} onCreated={() => { setNewOpen(false); load(); }} />}
    </div>
  );
}

function NewMbModal({ projectId, onClose, onCreated }) {
  const [form, setForm] = useState({ period_from: '', period_to: '', remarks: '' });
  const [lines, setLines] = useState([{ description: '', unit: 'nos', qty: '', rate: '' }]);
  const [saving, setSaving] = useState(false);

  const addLine = () => setLines(l => [...l, { description: '', unit: 'nos', qty: '', rate: '' }]);
  const updateLine = (i, field, val) => setLines(l => l.map((x, idx) => idx === i ? { ...x, [field]: val } : x));
  const removeLine = (i) => setLines(l => l.filter((_, idx) => idx !== i));

  const total = lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.rate) || 0), 0);

  const save = async (e) => {
    e.preventDefault();
    if (!form.period_from || !form.period_to) return toast.error('Pick both period dates');
    const validLines = lines.filter(l => l.description.trim());
    setSaving(true);
    try {
      await api.post(`/indent-labour-payment/projects/${projectId}/mb`, { ...form, lines: validLines });
      toast.success('MB sheet created');
      onCreated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not save');
    }
    setSaving(false);
  };

  return (
    <Modal isOpen={true} onClose={onClose} title="New MB / CDPR Sheet" wide>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Period From</label>
            <input type="date" required className="input" value={form.period_from}
              onChange={e => setForm(f => ({ ...f, period_from: e.target.value }))} />
          </div>
          <div>
            <label className="label">Period To</label>
            <input type="date" required className="input" value={form.period_to}
              onChange={e => setForm(f => ({ ...f, period_to: e.target.value }))} />
          </div>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="label mb-0">Lines</label>
            <button type="button" onClick={addLine} className="text-xs text-blue-600 hover:underline flex items-center gap-1">
              <FiPlus size={12} /> Add line
            </button>
          </div>
          <div className="space-y-1.5">
            {lines.map((l, i) => (
              <div key={i} className="grid grid-cols-12 gap-1.5 items-center">
                <input placeholder="Description" className="input col-span-5 text-xs"
                  value={l.description} onChange={e => updateLine(i, 'description', e.target.value)} />
                <input placeholder="Unit" className="input col-span-2 text-xs"
                  value={l.unit} onChange={e => updateLine(i, 'unit', e.target.value)} />
                <input placeholder="Qty" type="number" step="any" className="input col-span-2 text-xs"
                  value={l.qty} onChange={e => updateLine(i, 'qty', e.target.value)} />
                <input placeholder="Rate" type="number" step="any" className="input col-span-2 text-xs"
                  value={l.rate} onChange={e => updateLine(i, 'rate', e.target.value)} />
                <button type="button" onClick={() => removeLine(i)} className="col-span-1 text-red-500 hover:text-red-700 flex justify-center">
                  <FiTrash2 size={12} />
                </button>
              </div>
            ))}
          </div>
          <div className="text-right text-sm font-semibold mt-2">Total: {fmtINRFull(total)}</div>
        </div>

        <div>
          <label className="label">Remarks</label>
          <textarea className="input" rows={2} value={form.remarks}
            onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={saving} className="btn btn-primary">Save</button>
        </div>
      </form>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════════
// RA BILLS TAB — Phase 6.  Reads the Bill Verification chain
// (server/routes/billVerification.js), scoped to a project. Actions
// (verify/reject/hold) live on the dedicated Bill Verification page —
// this is a project-scoped read view with a link across.
// ═══════════════════════════════════════════════════════════════
const RA_STAGE_LABEL = {
  contractor_uploaded: 'Contractor Uploaded', site_engineer: 'Site Engineer',
  finance: 'Finance', payment: 'Payment',
};
const RA_STATUS_CLS = {
  raised: 'bg-amber-100 text-amber-800', paid: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700', on_hold: 'bg-gray-200 text-gray-700',
};

function RaBillsTab() {
  const [projects, setProjects] = useState([]);
  const [pid, setPid] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    api.get('/indent-labour-payment/projects').then(r => {
      setProjects(r.data || []);
      if (!pid && r.data?.length) setPid(String(r.data[0].id));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = () => {
    if (!pid) return;
    setLoading(true);
    api.get('/bill-verification/bills', { params: { project_id: pid } })
      .then(r => setRows(r.data || []))
      .catch(() => toast.error('Could not load RA bills'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [pid]);

  const totals = useMemo(() => {
    const t = rows.reduce((acc, r) => {
      const net = Number(r.net_amount || 0);
      acc.gross += Number(r.gross_amount || 0);
      acc.net += net;
      // 'raised' is the only non-terminal status here — it's still moving
      // through Contractor Uploaded -> Site Engineer -> Finance -> Payment.
      // 'on_hold' and 'cancelled' are excluded from "left to pay": on_hold
      // is paused (not actively owed right now) and cancelled is dead.
      if (r.status === 'raised') { acc.pending += 1; acc.pendingNet += net; }
      if (r.status === 'paid') { acc.paid += 1; acc.paidNet += net; }
      return acc;
    }, { gross: 0, net: 0, pending: 0, pendingNet: 0, paid: 0, paidNet: 0 });
    t.pctPaid = t.net > 0 ? Math.round((t.paidNet / t.net) * 1000) / 10 : 0;
    return t;
  }, [rows]);

  return (
    <div className="space-y-3">
      <div className="card p-3 flex gap-3 flex-wrap items-end justify-between">
        <div>
          <label className="text-xs text-gray-600 block mb-1">Project</label>
          <select value={pid} onChange={e => setPid(e.target.value)} className="border rounded px-2 py-1.5 text-sm min-w-[220px]">
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </div>
        <div className="flex gap-2">
          <button onClick={load} className="btn btn-secondary">Refresh</button>
          <Link to="/bill-verification" className="btn btn-primary flex items-center gap-1.5">
            <FiExternalLink size={14} /> Raise / act on a bill
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Bills" value={rows.length} color="indigo" />
        <Tile label="Net value" value={fmtINR(totals.net)} color="violet" />
        <Tile label="Left to pay" value={totals.pending} color="amber" />
        <Tile label="Amount left to pay" value={fmtINR(totals.pendingNet)} color="amber" />
      </div>

      {rows.length > 0 && (
        <div className="card p-3 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-semibold text-gray-700">Paid to contractor by Finance</span>
            <span className="font-semibold">{totals.pctPaid}% ({fmtINRFull(totals.paidNet)} of {fmtINRFull(totals.net)})</span>
          </div>
          <div className="bg-gray-100 rounded-full h-2.5 overflow-hidden">
            <div className={`h-2.5 rounded-full ${totals.pctPaid >= 100 ? 'bg-emerald-500' : totals.pctPaid >= 50 ? 'bg-amber-500' : 'bg-indigo-500'}`}
              style={{ width: `${Math.min(100, totals.pctPaid)}%` }} />
          </div>
          {totals.pctPaid >= 50 && totals.pending > 0 && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded px-2 py-1.5">
              Past the halfway mark — <strong>{totals.pending} bill{totals.pending === 1 ? '' : 's'}</strong> worth{' '}
              <strong>{fmtINRFull(totals.pendingNet)}</strong> still to be paid to the contractor by Finance.
            </div>
          )}
          {totals.pending === 0 && totals.paid > 0 && (
            <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded px-2 py-1.5">
              All bills for this project are paid — nothing left owed to the contractor.
            </div>
          )}
        </div>
      )}

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">RA No</th>
              <th className="text-left">Work Order</th>
              <th className="text-left">Contractor</th>
              <th className="text-right">Gross</th>
              <th className="text-right">Net</th>
              <th className="text-left">Stage</th>
              <th className="text-left">Status</th>
            </tr>
          </thead>
          <tbody>
            {loading && (<tr><td colSpan={7} className="text-center py-6 text-gray-400">Loading…</td></tr>)}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={7} className="text-center py-8 text-gray-400">No RA bills yet for this project.</td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id} className="hover:bg-gray-50">
                <td className="font-semibold">{r.ra_no}</td>
                <td>{r.wo_number || '—'}</td>
                <td>{r.contractor_name || r.sub_contractor_name || '—'}</td>
                <td className="text-right">{fmtINRFull(r.gross_amount)}</td>
                <td className="text-right font-semibold">{fmtINRFull(r.net_amount)}</td>
                <td className="text-xs">{RA_STAGE_LABEL[r.current_stage] || r.current_stage}</td>
                <td>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${RA_STATUS_CLS[r.status] || 'bg-gray-100'}`}>
                    {r.status}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// DASHBOARD TAB — Phase 6.  Per-project spend + progress rollup,
// budget chart, and "today" — labourers logged / sites reporting.
// ═══════════════════════════════════════════════════════════════
function ProjectsDashboardTab() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = () => {
    setLoading(true);
    api.get('/indent-labour-payment/dashboard/overview')
      .then(r => setData(r.data))
      .catch(() => toast.error('Could not load dashboard'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  if (loading) return <div className="card p-8 text-center text-gray-400">Loading…</div>;
  if (!data) return null;

  const chartData = data.projects.map(p => ({
    name: p.name.length > 14 ? p.name.slice(0, 14) + '…' : p.name,
    Planned: Math.round(p.l3_planned),
    Paid: Math.round(p.l3_paid),
  }));

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Total Budget" value={fmtINR(data.totals.budget)} color="violet" />
        <Tile label="Work Orders" value={data.totals.wo_count} color="blue" />
        <Tile label="Labourers Today" value={data.totals.today_labourers} color="emerald" />
        <Tile label="Sites Reported Today" value={data.totals.today_sites_reported} color="amber" />
      </div>

      <div className="card p-3">
        <div className="text-sm font-semibold text-gray-700 mb-2">Work Order value — Planned vs Paid, by project</div>
        <div style={{ height: 260 }}>
          <ResponsiveContainer>
            <BarChart data={chartData} margin={{ top: 5, right: 5, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" vertical={false} />
              <XAxis dataKey="name" tick={{ fontSize: 10 }} />
              <YAxis tick={{ fontSize: 10 }} tickFormatter={fmtINR} width={60} />
              <Tooltip formatter={(v) => fmtINRFull(v)} />
              <Bar dataKey="Planned" fill="#c7d2fe" radius={[3, 3, 0, 0]} />
              <Bar dataKey="Paid" fill="#4f46e5" radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Project</th>
              <th className="text-left">Progress (claimed / planned)</th>
              <th className="text-right">Budget</th>
              <th className="text-right">WOs</th>
              <th className="text-right">Labourers today</th>
              <th className="text-right">Sites reported today</th>
            </tr>
          </thead>
          <tbody>
            {data.projects.length === 0 && (
              <tr><td colSpan={6} className="text-center py-8 text-gray-400">No projects yet.</td></tr>
            )}
            {data.projects.map(p => (
              <tr key={p.id} className="hover:bg-gray-50">
                <td className="font-semibold">{p.name}</td>
                <td className="min-w-[160px]">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-gray-100 rounded-full h-2 overflow-hidden">
                      <div className={`h-2 rounded-full ${p.progress_pct >= 100 ? 'bg-emerald-500' : 'bg-indigo-500'}`}
                        style={{ width: `${Math.min(100, p.progress_pct)}%` }} />
                    </div>
                    <span className="text-xs text-gray-500 w-10 text-right">{p.progress_pct}%</span>
                  </div>
                </td>
                <td className="text-right font-semibold">{fmtINR(p.budget)}</td>
                <td className="text-right">{p.wo_active}/{p.wo_count}</td>
                <td className="text-right">
                  {p.today_labourers > 0
                    ? <span className="inline-flex items-center gap-1 text-emerald-700 font-semibold"><FiUserCheck size={12} />{p.today_labourers}</span>
                    : <span className="text-gray-400">—</span>}
                </td>
                <td className="text-right">
                  {p.today_sites_reported > 0
                    ? <span className="inline-flex items-center gap-1 text-emerald-700"><FiCheckCircle size={12} />{p.today_sites_reported}</span>
                    : <span className="text-gray-400">Not reported yet</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
