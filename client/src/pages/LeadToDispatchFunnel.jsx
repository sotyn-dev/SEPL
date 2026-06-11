import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import { FiDownload, FiRefreshCw } from 'react-icons/fi';
import { leadFunnel } from '../api';
import { useAuth } from '../context/AuthContext';
import { stageLabel } from '../data/l2dStages';
import { fmtIST } from '../utils/dateIST';
import { exportCsv } from '../utils/exportCsv';
import FunnelSummary from '../components/FunnelSummary';
import FunnelLeadDrawer from '../components/FunnelLeadDrawer';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

// Lead-to-Dispatch Funnel — summary + leads table. No Kanban (movement is
// automatic); the table is filterable by stage / source and the row drawer
// shows the full pipeline for each lead.
export default function LeadToDispatchFunnel() {
  const { isAdmin } = useAuth();
  const [stats, setStats] = useState(null);
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState('');
  const [source, setSource] = useState('');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState(null);

  const loadStats = useCallback(() => {
    leadFunnel.stats().then(setStats).catch(() => {});
  }, []);

  const loadRows = useCallback(() => {
    setLoading(true);
    const params = {};
    if (stage) params.stage = stage;
    if (source) params.source = source;
    leadFunnel.list(params)
      .then(setRows)
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load leads'))
      .finally(() => setLoading(false));
  }, [stage, source]);

  useEffect(() => { loadStats(); }, [loadStats]);
  useEffect(() => { loadRows(); }, [loadRows]);

  const filtered = rows.filter(r => {
    if (!q.trim()) return true;
    const hay = [r.sender_name, r.sender_company, r.sender_mobile, r.query_product_name].filter(Boolean).join(' ').toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  const doExport = () => {
    exportCsv('lead-to-dispatch-funnel',
      ['Name', 'Company', 'Mobile', 'Product', 'Stage', 'Quoted', 'Source', 'Received'],
      filtered.map(r => [r.sender_name, r.sender_company, r.sender_mobile, r.query_product_name, stageLabel(r.stage), r.quoted_price || '', r.source, r.query_time || r.created_at]));
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-semibold text-gray-800">Lead → Dispatch Funnel</h1>
        <div className="flex gap-2">
          <button onClick={() => { loadStats(); loadRows(); }} className="btn btn-secondary btn-sm"><FiRefreshCw className="inline mr-1" size={13} /> Refresh</button>
          <button onClick={doExport} className="btn btn-secondary btn-sm"><FiDownload className="inline mr-1" size={13} /> Export</button>
        </div>
      </div>

      <FunnelSummary stats={stats} active={stage} onPick={setStage} />

      <div className="flex gap-2 flex-wrap items-center">
        <input className="input input-sm max-w-xs" placeholder="Search name / company / product…" value={q} onChange={e => setQ(e.target.value)} />
        <select className="select select-sm w-auto" value={source} onChange={e => setSource(e.target.value)}>
          <option value="">All sources</option>
          <option value="indiamart">IndiaMART</option>
        </select>
        {stage && <button onClick={() => setStage('')} className="text-xs text-blue-600 hover:underline">Clear stage filter ({stageLabel(stage)})</button>}
      </div>

      <div className="bg-white rounded-lg border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-gray-50 text-left text-xs text-gray-500">
              <th className="p-2">Client</th>
              <th className="p-2">Product</th>
              <th className="p-2">Stage</th>
              <th className="p-2 text-right">Quoted</th>
              <th className="p-2">Received</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="5" className="p-4 text-gray-400 text-center">Loading…</td></tr>
            ) : filtered.length === 0 ? (
              <tr><td colSpan="5" className="p-4 text-gray-400 text-center">No leads.</td></tr>
            ) : filtered.map(r => (
              <tr key={r.id} className="border-b hover:bg-blue-50/40 cursor-pointer" onClick={() => setOpenId(r.id)}>
                <td className="p-2">
                  <div className="font-medium text-gray-800">{r.sender_name || '—'}</div>
                  <div className="text-xs text-gray-400">{r.sender_company || r.sender_mobile || ''}</div>
                </td>
                <td className="p-2 text-gray-700">{r.query_product_name || '—'}</td>
                <td className="p-2"><span className="text-xs px-2 py-0.5 rounded-full bg-gray-100 text-gray-700">{stageLabel(r.stage)}</span></td>
                <td className="p-2 text-right text-gray-700">{r.quoted_price ? money(r.quoted_price) : '—'}</td>
                <td className="p-2 text-xs text-gray-400">{r.query_time || fmtIST(r.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
