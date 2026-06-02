// Indent Labour Payment — Project Execution & Billing pipeline.
// Mam (2026-06-01).  Coexists with the simpler /labour-payment
// module under Projects sidebar group.
//
// Phase 1 (today): Projects tab only (read-only list).
// Phases 2-6 are scaffolded as visible "coming soon" tabs so mam
// can see the planned scope and tell us if anything is mislabelled
// before backend / DB work lands.

import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import toast from 'react-hot-toast';
import {
  FiClipboard, FiSearch, FiBriefcase, FiUsers, FiTool, FiBookOpen,
  FiDollarSign, FiTrendingUp,
} from 'react-icons/fi';

// 12-hour 2-decimal Rs formatter — same shape as fmtINR used elsewhere.
const fmtINR = (n) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1e7) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e7).toFixed(2)} cr`;
  if (Math.abs(v) >= 1e5) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e5).toFixed(2)} L`;
  if (Math.abs(v) >= 1e3) return `${v < 0 ? '-' : ''}₹${(Math.abs(v) / 1e3).toFixed(1)} K`;
  return `${v < 0 ? '-' : ''}₹${Math.abs(Math.round(v)).toLocaleString('en-IN')}`;
};

const TABS = [
  { id: 'projects',  label: 'Projects',     icon: FiBriefcase, phase: 1 },
  { id: 'budgets',   label: 'Budgets',      icon: FiClipboard, phase: 2 },
  { id: 'wos',       label: 'Work Orders',  icon: FiTool,      phase: 2 },
  { id: 'muster',    label: 'Muster Roll',  icon: FiUsers,     phase: 3 },
  { id: 'mb',        label: 'MB / CDPR',    icon: FiBookOpen,  phase: 5 },
  { id: 'rabills',   label: 'RA Bills',     icon: FiDollarSign, phase: 6 },
  { id: 'dashboard', label: 'Dashboard',    icon: FiTrendingUp, phase: 6 },
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
          Project Execution &amp; Billing pipeline — Project → Budget → Work Orders → Muster &amp; DPR → MB → RA Bills.
        </p>
      </div>

      {/* Tab strip — Phase 1 lights up Projects; rest carry a chip
          marking the phase they belong to so mam can see the
          delivery order at a glance. */}
      <div className="flex gap-2 flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`btn ${active ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5 text-sm`}>
              <Icon size={14} /> {t.label}
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-bold ${
                active ? 'bg-white text-indigo-700' : 'bg-gray-200 text-gray-600'
              }`}>P{t.phase}</span>
            </button>
          );
        })}
      </div>

      {tab === 'projects' && <ProjectsTab />}
      {tab !== 'projects' && (
        <PhaseStub
          phase={TABS.find(t => t.id === tab)?.phase}
          label={TABS.find(t => t.id === tab)?.label}
        />
      )}
    </div>
  );
}

// ─── Phase 1 · Projects tab ─────────────────────────────────────
function ProjectsTab() {
  const [rows, setRows] = useState([]);
  const [owners, setOwners] = useState([]);
  const [q, setQ] = useState('');
  const [owner, setOwner] = useState('');
  const [loading, setLoading] = useState(false);

  const load = () => {
    setLoading(true);
    api.get('/indent-labour-payment/projects', { params: { q: q || undefined, owner: owner || undefined } })
      .then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load projects'))
      .finally(() => setLoading(false));
    api.get('/indent-labour-payment/owners')
      .then(r => setOwners(r.data || []))
      .catch(() => {});
  };
  useEffect(load, [q, owner]);

  const totals = useMemo(() => rows.reduce((acc, r) => {
    acc.po += Number(r.po_amount || 0);
    acc.legacy += Number(r.legacy_cost || 0);
    acc.work_orders += Number(r.work_order_count || 0);
    return acc;
  }, { po: 0, legacy: 0, work_orders: 0 }), [rows]);

  return (
    <div className="space-y-3">
      {/* Filter row */}
      <div className="card p-3 flex gap-3 flex-wrap items-end">
        <div className="flex-1 min-w-[220px]">
          <label className="text-xs text-gray-600 block mb-1">Search project / client / category</label>
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
        <button onClick={load} className="btn btn-primary">Refresh</button>
      </div>

      {/* Roll-up tiles */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Tile label="Projects"           value={rows.length}                color="indigo" />
        <Tile label="Total PO Value"     value={fmtINR(totals.po)}          color="emerald" />
        <Tile label="Legacy Cost Carry"  value={fmtINR(totals.legacy)}      color="amber" />
        <Tile label="Total Work Orders"  value={totals.work_orders}         color="blue" />
      </div>

      {/* List */}
      <div className="card p-0 overflow-x-auto">
        <table className="freeze-head w-full text-sm">
          <thead>
            <tr>
              <th className="text-left">Project</th>
              <th className="text-left">Client</th>
              <th className="text-left">Category</th>
              <th className="text-left">Owner</th>
              <th className="text-right">PO Value</th>
              <th className="text-right">Legacy Cost</th>
              <th className="text-right">Work Orders</th>
              <th className="text-right">Budget Lines</th>
              <th className="text-left">Target Close</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr><td colSpan={9} className="text-center py-6 text-gray-400">Loading…</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="text-center py-8 text-gray-400">No projects match the current filter.</td></tr>
            )}
            {!loading && rows.map(r => (
              <tr key={r.id}>
                <td className="font-semibold">{r.project_name}</td>
                <td className="text-gray-600">{r.client_name || '—'}</td>
                <td className="text-gray-600">{r.category || '—'}</td>
                <td>
                  <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                    {r.owner}
                  </span>
                </td>
                <td className="text-right font-medium">{fmtINR(r.po_amount)}</td>
                <td className={`text-right ${r.legacy_cost > 0 ? 'text-amber-700 font-semibold' : 'text-gray-400'}`}>
                  {r.legacy_cost > 0 ? fmtINR(r.legacy_cost) : '—'}
                </td>
                <td className="text-right">{r.work_order_count}</td>
                <td className="text-right">{r.budget_lines_count}</td>
                <td className="text-gray-600 text-xs">{r.target_close || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="text-[11px] text-gray-500 px-1">
        Phase 1 shows every project read-only.  Owner defaults to <strong>Aanchal</strong> for legacy rows
        (per-project edit lands in Phase 2 alongside Budget CRUD).
        Legacy Cost is the pre-ERP work-till-date carry that mam captures at kickoff.
      </div>
    </div>
  );
}

function Tile({ label, value, color }) {
  const colorMap = {
    indigo:  'border-indigo-500 text-indigo-700',
    emerald: 'border-emerald-500 text-emerald-700',
    amber:   'border-amber-500 text-amber-700',
    blue:    'border-blue-500 text-blue-700',
  };
  return (
    <div className={`card text-center border-l-4 py-2 ${colorMap[color] || colorMap.indigo}`}>
      <div className={`text-xl font-bold ${colorMap[color]?.split(' ')[1] || 'text-indigo-700'}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

// Placeholder for tabs whose backend lands in later phases.  Shows
// the planned scope so mam can flag any mislabelled tab now.
function PhaseStub({ phase, label }) {
  return (
    <div className="card p-6 text-center space-y-2">
      <div className="text-lg font-bold text-gray-700">{label}</div>
      <div className="text-sm text-gray-500">
        Coming in <span className="font-semibold text-indigo-700">Phase {phase}</span>.
      </div>
      <div className="text-xs text-gray-400 max-w-md mx-auto">
        Schema tables are already in place (idempotent migrations landed today).
        Endpoint + UI work scheduled per the plan mam approved on 2026-06-01.
      </div>
    </div>
  );
}
