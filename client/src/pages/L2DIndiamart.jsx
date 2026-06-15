import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import {
  FiDownload, FiRefreshCw, FiChevronUp, FiChevronDown,
  FiUsers, FiAlertTriangle, FiTruck,
} from 'react-icons/fi';
import { leadFunnel } from '../api';
import { useAuth } from '../context/AuthContext';
import { stageLabel } from '../data/l2dStages';
import { fmtIST } from '../utils/dateIST';
import { exportCsv } from '../utils/exportCsv';
import FunnelLeadDrawer from '../components/FunnelLeadDrawer';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const ITEMS_PER_PAGE = 15;

// Tab cards filter by a *set* of stages (empty = all). "Needs Action" merges the
// three states that wait on the coordinator: fresh leads, AI-flagged reviews, and
// customer callback requests.
const METRIC_CARDS = [
  { stages: [],                                                 label: 'All Leads',    sub: 'Active funnel',            Icon: FiUsers,         strip: 'bg-slate-400', activeBg: 'bg-slate-50', activeStrip: 'bg-slate-600', count: 'text-slate-800' },
  { stages: ['LEAD_ENTERED', 'NEEDS_REVIEW', 'CALL_REQUESTED'], label: 'Needs Action', sub: 'New · flagged · callback', Icon: FiAlertTriangle, strip: 'bg-amber-400', activeBg: 'bg-amber-50', activeStrip: 'bg-amber-500', count: 'text-amber-700' },
  { stages: ['DISPATCH_CONFIRMED'],                             label: 'Dispatched',   sub: 'Ready for billing',        Icon: FiTruck,         strip: 'bg-green-300', activeBg: 'bg-green-50', activeStrip: 'bg-green-500', count: 'text-green-700' },
];

// Stage dropdown, grouped to mirror the drawer's milestone vocabulary, split at the
// "got paid" boundary. KEEP_IN_TOUCH is intentionally omitted — it's post-sale/closed,
// not part of the active funnel a coordinator filters by.
const STAGE_FILTER_GROUPS = [
  { label: 'Needs Action',    keys: ['LEAD_ENTERED', 'NEEDS_REVIEW', 'CALL_REQUESTED'] },
  { label: 'Lead Nurturing',  keys: ['WELCOME_SENT', 'INTERESTED', 'ORDER_CONFIRMED', 'BANK_SENT'] },
  { label: 'Sales Execution', keys: ['PAYMENT_CONFIRMED', 'PO_DRAFTED', 'DISPATCH_CONFIRMED', 'PURCHASE_BILL', 'SALES_BILL', 'RECEIPT'] },
  { label: 'Status',          keys: ['REJECTED'] },
];

const sameStageSet = (a, b) => a.length === b.length && a.every(s => b.includes(s));

function pageWindows(current, total) {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total));
  return [...pages].sort((a, b) => a - b);
}

export default function L2DIndiamart() {
  const { isAdmin } = useAuth();
  const [stats, setStats]     = useState(null);
  const [rows, setRows]       = useState([]);
  const [loading, setLoading] = useState(true);
  const [stageFilter, setStageFilter] = useState([]); // [] = all; tabs + dropdown both drive this
  const [q, setQ]             = useState('');
  const [openId, setOpenId]   = useState(null);
  const [sortBy, setSortBy]   = useState('desc');
  const [page, setPage]       = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo]     = useState('');

  const loadStats = useCallback(() => {
    leadFunnel.stats().then(setStats).catch(() => {});
  }, []);

  const loadRows = useCallback(() => {
    setLoading(true);
    // Stage filtering is client-side (rows cap at 1000), so a multi-stage tab works
    // and switching tabs never re-hits the server.
    leadFunnel.list({})
      .then(setRows)
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load leads'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);

  const getTimestamp = (r) => {
    const ts = r.query_time || r.created_at;
    if (!ts) return 0;
    const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };

  const filtered = rows
    .filter(r => stageFilter.length === 0 || stageFilter.includes(r.stage))
    .filter(r => {
      if (!q.trim()) return true;
      const hay = [r.sender_name, r.sender_company, r.sender_mobile, r.query_product_name].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q.trim().toLowerCase());
    })
    .filter(r => {
      if (!dateFrom && !dateTo) return true;
      const ts = getTimestamp(r);
      if (dateFrom && ts < new Date(dateFrom).getTime()) return false;
      if (dateTo && ts > new Date(dateTo).getTime() + 86400000) return false;
      return true;
    })
    .sort((a, b) => {
      const aTime = getTimestamp(a);
      const bTime = getTimestamp(b);
      return sortBy === 'asc' ? aTime - bTime : bTime - aTime;
    });

  const totalPages = Math.ceil(filtered.length / ITEMS_PER_PAGE);
  const paginated  = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const hasFilters = stageFilter.length || q || dateFrom || dateTo;

  const counts = stats?.counts || {};
  // Card count = total for "All", else the sum across the card's stage set.
  const getCount = (stages) => stages.length === 0
    ? (stats?.total || 0)
    : stages.reduce((sum, s) => sum + (counts[s] || 0), 0);

  // Clicking a card toggles its stage set on/off (off = back to All).
  const pickCard = (stages) => {
    setStageFilter(prev => sameStageSet(prev, stages) ? [] : stages);
    setPage(1);
  };

  const doExport = () => {
    exportCsv('l2d-indiamart',
      ['ID', 'Name', 'Company', 'Mobile', 'Product', 'Stage', 'Quoted', 'Received'],
      filtered.map(r => [r.unique_query_id || r.id, r.sender_name, r.sender_company, r.sender_mobile, r.query_product_name, stageLabel(r.stage), r.quoted_price || '', fmtIST(r.query_time) || fmtIST(r.created_at)]));
  };

  return (<>
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 leading-tight">Leads</h1>
          <p className="text-sm text-blue-600 mt-0.5">Manage and track your industrial leads.</p>
        </div>
        <div className="flex gap-2 shrink-0">
          <button onClick={() => { loadStats(); loadRows(); }} className="btn btn-secondary btn-sm">
            <FiRefreshCw className="inline mr-1" size={13} /> Refresh
          </button>
          <button onClick={doExport} className="btn btn-secondary btn-sm">
            <FiDownload className="inline mr-1" size={13} /> Export
          </button>
        </div>
      </div>

      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
        {METRIC_CARDS.map(card => {
          const isActive = sameStageSet(stageFilter, card.stages);
          const count    = getCount(card.stages);
          return (
            <button
              key={card.label}
              onClick={() => pickCard(card.stages)}
              className={`relative text-left rounded-lg border pl-4 pr-3 py-3 transition-all overflow-hidden
                ${isActive
                  ? `${card.activeBg} border-gray-300 shadow-sm`
                  : 'bg-white border-gray-200 hover:bg-gray-50 hover:border-gray-300'}`}
            >
              {/* Left accent strip */}
              <div className={`absolute left-0 top-0 bottom-0 w-1 rounded-l-lg transition-colors ${isActive ? card.activeStrip : card.strip}`} />

              <div className="flex items-start justify-between mb-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{card.label}</span>
                <card.Icon size={14} className={isActive ? card.count : 'text-gray-300'} />
              </div>
              <div className={`text-2xl font-bold tabular-nums leading-none ${isActive ? card.count : 'text-gray-800'}`}>
                {stats ? count : <span className="text-gray-300">—</span>}
              </div>
              <div className="text-[11px] text-gray-400 mt-1">{card.sub}</div>
            </button>
          );
        })}
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          className="input input-sm flex-1 min-w-[180px] max-w-xs"
          placeholder="Search name / company / product…"
          aria-label="Search leads by name, company or product"
          value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }}
        />
        <select
          className="input input-sm w-44"
          aria-label="Filter by stage"
          value={stageFilter.length === 1 ? stageFilter[0] : ''}
          onChange={e => { setStageFilter(e.target.value ? [e.target.value] : []); setPage(1); }}
        >
          <option value="">All stages</option>
          {STAGE_FILTER_GROUPS.map(g => (
            <optgroup key={g.label} label={g.label}>
              {g.keys.map(k => <option key={k} value={k}>{stageLabel(k)}</option>)}
            </optgroup>
          ))}
        </select>
        {/* Received-date range, grouped as one labeled unit */}
        <div className="inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white pl-2.5 pr-1.5 py-1">
          <span className="text-xs font-medium text-gray-500 whitespace-nowrap">Received</span>
          <input
            type="date"
            className="input input-sm w-32 border-0 shadow-none px-1 focus:ring-0"
            aria-label="Received from date"
            value={dateFrom}
            onChange={e => { setDateFrom(e.target.value); setPage(1); }}
          />
          <span className="text-xs text-gray-400">–</span>
          <input
            type="date"
            className="input input-sm w-32 border-0 shadow-none px-1 focus:ring-0"
            aria-label="Received to date"
            value={dateTo}
            onChange={e => { setDateTo(e.target.value); setPage(1); }}
          />
        </div>
        {hasFilters && (
          <button
            onClick={() => { setStageFilter([]); setQ(''); setDateFrom(''); setDateTo(''); setPage(1); }}
            className="text-xs text-blue-600 hover:underline whitespace-nowrap"
          >
            Clear
          </button>
        )}
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
              <th className="p-2 w-28">ID</th>
              <th className="p-2">Client</th>
              <th className="p-2">Product</th>
              <th className="p-2">Stage</th>
              <th className="p-2 text-right">Quoted</th>
              <th
                className={`p-2 cursor-pointer select-none hover:bg-gray-100 ${sortBy ? 'text-blue-600' : ''}`}
                onClick={() => { setSortBy(sortBy === 'asc' ? 'desc' : 'asc'); setPage(1); }}
              >
                <div className="flex items-center gap-1">
                  Received
                  {sortBy === 'asc' ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
                </div>
              </th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="6" className="p-4 text-gray-400 text-center">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan="6" className="p-6 text-gray-400 text-center">No leads match the current filters.</td></tr>
            ) : paginated.map(r => (
              <tr key={r.id} className="border-b hover:bg-blue-50/40 cursor-pointer" onClick={() => setOpenId(r.id)}>
                <td className="p-2 font-mono text-xs text-gray-400 whitespace-nowrap">
                  {r.unique_query_id || ('#' + r.id)}
                </td>
                <td className="p-2">
                  <div className="font-medium text-gray-800">{r.sender_name || '—'}</div>
                  <div className="text-xs text-gray-400">{r.sender_company || r.sender_mobile || ''}</div>
                </td>
                <td className="p-2 text-gray-700">{r.query_product_name || '—'}</td>
                <td className="p-2">
                  <span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{stageLabel(r.stage)}</span>
                </td>
                <td className="p-2 text-right text-gray-700">{r.quoted_price ? money(r.quoted_price) : '—'}</td>
                <td className="p-2 text-xs text-gray-400">{fmtIST(r.query_time) || fmtIST(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {filtered.length > ITEMS_PER_PAGE && (
        <div className="flex items-center justify-between flex-wrap gap-2 text-sm">
          <span className="text-xs text-gray-500">
            {(page - 1) * ITEMS_PER_PAGE + 1}–{Math.min(page * ITEMS_PER_PAGE, filtered.length)} of {filtered.length}
          </span>
          <div className="flex items-center gap-1">
            <button disabled={page === 1} onClick={() => setPage(page - 1)} className="btn btn-sm btn-outline">Prev</button>
            {pageWindows(page, totalPages).reduce((acc, p, i, arr) => {
              if (i > 0 && p - arr[i - 1] > 1) acc.push(<span key={`gap-${p}`} className="px-1 text-gray-400">…</span>);
              acc.push(
                <button key={p} onClick={() => setPage(p)} className={`btn btn-sm ${page === p ? 'btn-primary' : 'btn-outline'}`}>{p}</button>
              );
              return acc;
            }, [])}
            <button disabled={page === totalPages} onClick={() => setPage(page + 1)} className="btn btn-sm btn-outline">Next</button>
          </div>
        </div>
      )}


    </div>
    {openId && (
      <FunnelLeadDrawer
        leadId={openId}
        isAdmin={isAdmin()}
        onClose={() => setOpenId(null)}
        onChanged={() => { loadStats(); loadRows(); }}
      />
    )}
  </>);
}
