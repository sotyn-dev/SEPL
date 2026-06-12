import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { FiDownload, FiRefreshCw, FiChevronUp, FiChevronDown } from 'react-icons/fi';
import { leadFunnel } from '../api';
import { useAuth } from '../context/AuthContext';
import { stageLabel } from '../data/l2dStages';
import { fmtIST } from '../utils/dateIST';
import { exportCsv } from '../utils/exportCsv';
import FunnelSummary from '../components/FunnelSummary';
import FunnelLeadDrawer from '../components/FunnelLeadDrawer';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');
const ITEMS_PER_PAGE = 15;

function pageWindows(current, total) {
  if (total <= 5) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set([1, total, current, current - 1, current + 1].filter(p => p >= 1 && p <= total));
  return [...pages].sort((a, b) => a - b);
}

export default function L2DIndiamart() {
  const { isAdmin } = useAuth();
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);
  const [sortBy, setSortBy] = useState('desc');
  const [page, setPage] = useState(1);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  const loadStats = useCallback(() => {
    leadFunnel.stats().then(setStats).catch(() => {});
  }, []);

  const loadRows = useCallback(() => {
    setLoading(true);
    const params = {};
    if (stage) params.stage = stage;
    leadFunnel.list(params)
      .then(setRows)
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load leads'))
      .finally(() => setLoading(false));
  }, [stage]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);

  const getTimestamp = (r) => {
    const ts = r.query_time || r.created_at;
    if (!ts) return 0;
    const d = new Date(ts.includes('T') ? ts : ts.replace(' ', 'T') + 'Z');
    return isNaN(d.getTime()) ? 0 : d.getTime();
  };

  const filtered = rows
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
  const paginated = filtered.slice((page - 1) * ITEMS_PER_PAGE, page * ITEMS_PER_PAGE);
  const hasFilters = stage || q || dateFrom || dateTo;

  const doExport = () => {
    exportCsv('l2d-indiamart',
      ['Name', 'Company', 'Mobile', 'Product', 'Stage', 'Quoted', 'Received'],
      filtered.map(r => [r.sender_name, r.sender_company, r.sender_mobile, r.query_product_name, stageLabel(r.stage), r.quoted_price || '', fmtIST(r.query_time) || fmtIST(r.created_at)]));
  };

  return (
    <div className="space-y-4">
      <FunnelSummary stats={stats} active={stage} onPick={s => { setStage(s); setPage(1); }} />

      {/* Filter + actions bar */}
      <div className="flex flex-wrap items-center gap-2 py-1">
        <input
          className="input input-sm flex-1 min-w-[180px] max-w-xs"
          placeholder="Search name / company / product…"
          value={q}
          onChange={e => { setQ(e.target.value); setPage(1); }}
        />
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-gray-500 whitespace-nowrap">Filter by date:</span>
          <input type="date" className="input input-sm w-36" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(1); }} />
          <span className="text-xs text-gray-400">—</span>
          <input type="date" className="input input-sm w-36" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(1); }} />
        </div>
        {hasFilters && (
          <button onClick={() => { setStage(''); setQ(''); setDateFrom(''); setDateTo(''); setPage(1); }} className="text-xs text-blue-600 hover:underline whitespace-nowrap">
            Clear filters
          </button>
        )}
        <div className="ml-auto flex gap-2 shrink-0">
          <button onClick={() => { loadStats(); loadRows(); }} className="btn btn-secondary btn-sm">
            <FiRefreshCw className="inline mr-1" size={13} /> Refresh
          </button>
          <button onClick={doExport} className="btn btn-secondary btn-sm">
            <FiDownload className="inline mr-1" size={13} /> Export
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
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
              <tr><td colSpan="5" className="p-4 text-gray-400 text-center">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan="5" className="p-6 text-gray-400 text-center">No leads match the current filters.</td></tr>
            ) : paginated.map(r => (
              <tr key={r.id} className="border-b hover:bg-blue-50/40 cursor-pointer" onClick={() => setOpenId(r.id)}>
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

      {openId && (
        <FunnelLeadDrawer
          leadId={openId}
          isAdmin={isAdmin()}
          onClose={() => setOpenId(null)}
          onChanged={() => { loadStats(); loadRows(); }}
        />
      )}
    </div>
  );
}
