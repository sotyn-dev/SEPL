// Admin "Daily Activity / Word Count" dashboard.
//
// Pick a date (or range), see who typed how many words into the ERP that
// day, broken down by user, by module, and by action. Powered by
// /api/admin/word-count which walks the audit_log body_summary.
//
// Use case: mam tracks how much real data-entry work each employee did.

import { useState, useEffect } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiBarChart2, FiCalendar, FiRefreshCw, FiUser, FiPackage, FiAlertCircle, FiX, FiEye } from 'react-icons/fi';

const todayIso = () => new Date().toISOString().slice(0, 10);

const ACTION_COLORS = {
  CREATE: 'bg-emerald-100 text-emerald-700',
  UPDATE: 'bg-blue-100 text-blue-700',
  DELETE: 'bg-red-100 text-red-700',
};

// Friendly module labels — keep in sync with the sidebar in Layout.jsx so
// mam recognises each row at a glance ("BOQ & Quotations" instead of
// "quotations", "DPR" instead of "dpr", etc.). Anything not in the map
// falls back to the raw entity_type with hyphens/underscores prettified.
const MODULE_LABELS = {
  dpr: 'DPR',
  quotations: 'BOQ & Quotations',
  'business-book': 'Business Book',
  'item-master': 'Item Master',
  'pms-tasks': 'PMS Tasks',
  'payment-required': 'Payment Required',
  'indent-fms': 'Indent FMS',
  procurement: 'Indent to Dispatch',
  complaints: 'Complaints',
  leads: 'Leads / CRM',
  vendors: 'Vendors',
  customers: 'Customers',
  orders: 'Orders & Planning',
  installation: 'Installation',
  billing: 'Billing',
  hr: 'HR & Hiring',
  employees: 'Employees',
  expenses: 'Expenses',
  attendance: 'Attendance',
  collections: 'Collection Engine',
  cashflow: 'Cash Flow',
  delegations: 'Delegations',
  checklists: 'Checklists',
  auth: 'Login / Account',
  admin: 'Admin Settings',
};
const moduleLabel = (m) => MODULE_LABELS[m] || String(m || '—').replace(/[-_]/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

export default function WordCount() {
  const [date, setDate] = useState(todayIso());
  const [dateTo, setDateTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [drillUser, setDrillUser] = useState(null); // { user_id, user_name }
  const [detail, setDetail] = useState([]);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateTo && dateTo !== date) {
        params.set('date_from', date);
        params.set('date_to', dateTo);
      } else {
        params.set('date', date);
      }
      const r = await api.get(`/admin/word-count?${params.toString()}`);
      setData(r.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load');
    }
    setLoading(false);
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [date, dateTo]);

  const openDrill = async (u) => {
    setDrillUser(u);
    setDetailLoading(true);
    try {
      const params = new URLSearchParams();
      if (dateTo && dateTo !== date) {
        params.set('date_from', date); params.set('date_to', dateTo);
      } else {
        params.set('date', date);
      }
      params.set('user_id', u.user_id);
      const r = await api.get(`/admin/word-count/detail?${params.toString()}`);
      setDetail(r.data || []);
    } catch (err) {
      toast.error('Failed to load details');
      setDetail([]);
    }
    setDetailLoading(false);
  };

  const fmtNum = (n) => (n || 0).toLocaleString('en-IN');

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
            <FiBarChart2 className="text-red-600" /> Daily Activity
          </h3>
          <p className="text-sm text-gray-500">
            How many entries each user made on the selected date — across all create / update / delete actions.
            Word count shown alongside as a measure of how much was typed.
          </p>
        </div>
        <button onClick={load} disabled={loading} className="btn btn-secondary flex items-center gap-2">
          <FiRefreshCw className={loading ? 'animate-spin' : ''} size={14} /> Refresh
        </button>
      </div>

      {/* Date picker */}
      <div className="card p-4">
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
          <div>
            <label className="label flex items-center gap-1"><FiCalendar size={12} /> Date</label>
            <input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} />
          </div>
          <div>
            <label className="label">To (optional, for range)</label>
            <input type="date" className="input" value={dateTo} onChange={e => setDateTo(e.target.value)} min={date} />
            {dateTo && <button onClick={() => setDateTo('')} className="text-[11px] text-red-600 hover:underline mt-1">Clear range</button>}
          </div>
          <div className="text-xs text-gray-500 sm:text-right">
            {dateTo && dateTo !== date
              ? <>Showing <span className="font-semibold">{date}</span> to <span className="font-semibold">{dateTo}</span></>
              : <>Showing single day: <span className="font-semibold">{date}</span></>}
          </div>
        </div>
      </div>

      {/* Top-line cards — entry count is the primary metric (mam's
          ask: "count data entry per selected date"). Word count
          shown beneath as a secondary depth-of-typing indicator. */}
      {data && (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
          <div className="card p-4 bg-gradient-to-br from-red-50 to-white border-l-4 border-red-500">
            <div className="text-xs text-gray-500 uppercase font-semibold">Total Entries</div>
            <div className="text-3xl font-bold text-gray-800 mt-1">{fmtNum(data.total_activities)}</div>
            <div className="text-[11px] text-gray-400 mt-1">creates + updates + deletes</div>
          </div>
          <div className="card p-4 bg-gradient-to-br from-emerald-50 to-white border-l-4 border-emerald-500">
            <div className="text-xs text-gray-500 uppercase font-semibold">Active Users</div>
            <div className="text-3xl font-bold text-gray-800 mt-1">{data.by_user.filter(u => u.activities > 0).length}</div>
            <div className="text-[11px] text-gray-400 mt-1">people who entered data</div>
          </div>
          <div className="card p-4 bg-gradient-to-br from-blue-50 to-white border-l-4 border-blue-500">
            <div className="text-xs text-gray-500 uppercase font-semibold">Modules Touched</div>
            <div className="text-3xl font-bold text-gray-800 mt-1">{data.by_module.length}</div>
            <div className="text-[11px] text-gray-400 mt-1">parts of the ERP used</div>
          </div>
          <div className="card p-4 bg-gradient-to-br from-amber-50 to-white border-l-4 border-amber-500">
            <div className="text-xs text-gray-500 uppercase font-semibold">Total Words Typed</div>
            <div className="text-3xl font-bold text-gray-800 mt-1">{fmtNum(data.total_words)}</div>
            <div className="text-[11px] text-gray-400 mt-1">across all entries</div>
          </div>
        </div>
      )}

      {/* Caveat banner if any rows were truncated */}
      {data && data.truncated_activities > 0 && (
        <div className="card p-3 bg-amber-50 border-l-4 border-amber-400 flex items-start gap-2 text-xs text-amber-900">
          <FiAlertCircle className="mt-0.5 flex-shrink-0" />
          <div>
            <span className="font-semibold">{data.truncated_activities}</span> activities had very large payloads that were
            truncated by the audit log (2000-char cap), so their word count is a lower bound.
          </div>
        </div>
      )}

      {/* Two-column: by user (left) + by module (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* By user */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50 flex items-center justify-between">
            <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiUser size={14} className="text-red-600" /> By User</h4>
            <span className="text-[11px] text-gray-400">click a row for details</span>
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50/60">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">User</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Entries</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase">Words</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_user || []).slice().sort((a, b) => b.activities - a.activities).map(u => (
                  <tr
                    key={u.user_id || u.user_name}
                    onClick={() => u.user_id && openDrill(u)}
                    className="border-t hover:bg-red-50/40 cursor-pointer"
                  >
                    <td className="px-3 py-2 font-medium text-gray-800">{u.user_name}</td>
                    <td className="px-3 py-2 text-right font-bold text-red-700 text-base">{fmtNum(u.activities)}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">{fmtNum(u.words)}</td>
                  </tr>
                ))}
                {data && data.by_user.length === 0 && (
                  <tr><td colSpan="3" className="text-center py-8 text-gray-400 text-sm">No activity on this date</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* By module */}
        <div className="card p-0 overflow-hidden">
          <div className="px-4 py-3 border-b bg-gray-50">
            <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiPackage size={14} className="text-red-600" /> By Module</h4>
          </div>
          <div className="overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50/60">
                <tr>
                  <th className="text-left px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Module</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-500 uppercase">Entries</th>
                  <th className="text-right px-3 py-2 text-[11px] font-semibold text-gray-400 uppercase">Words</th>
                </tr>
              </thead>
              <tbody>
                {(data?.by_module || []).slice().sort((a, b) => b.activities - a.activities).map(m => (
                  <tr key={m.module} className="border-t hover:bg-gray-50">
                    <td className="px-3 py-2 text-gray-800">{moduleLabel(m.module)}</td>
                    <td className="px-3 py-2 text-right font-bold text-red-700 text-base">{fmtNum(m.activities)}</td>
                    <td className="px-3 py-2 text-right text-gray-500 text-xs">{fmtNum(m.words)}</td>
                  </tr>
                ))}
                {data && data.by_module.length === 0 && (
                  <tr><td colSpan="3" className="text-center py-8 text-gray-400 text-sm">—</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* By action breakdown — small pill row */}
      {data && data.by_action.length > 0 && (
        <div className="card p-4">
          <div className="text-[11px] font-semibold text-gray-500 uppercase mb-2">By Action</div>
          <div className="flex flex-wrap gap-2">
            {data.by_action.map(a => (
              <div key={a.action} className={`px-3 py-1.5 rounded-lg text-xs ${ACTION_COLORS[a.action] || 'bg-gray-100 text-gray-700'}`}>
                <span className="font-semibold">{a.action}</span>
                <span className="ml-2">{fmtNum(a.activities)} entries</span>
                <span className="ml-1 opacity-60">/ {fmtNum(a.words)} words</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Drill-down modal — what a single user typed on this day */}
      {drillUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60" onClick={() => setDrillUser(null)}>
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b flex items-center justify-between">
              <div>
                <h3 className="font-bold text-gray-800 flex items-center gap-2">
                  <FiEye className="text-red-600" /> {drillUser.user_name} — what they entered
                </h3>
                <p className="text-[11px] text-gray-500 mt-0.5">
                  {dateTo && dateTo !== date ? `${date} to ${dateTo}` : date} ·
                  <span className="font-semibold text-red-700"> {fmtNum(drillUser.activities)} entries</span> · {fmtNum(drillUser.words)} words
                </p>
              </div>
              <button onClick={() => setDrillUser(null)} className="p-1 text-gray-400 hover:text-gray-700"><FiX size={18} /></button>
            </div>
            <div className="overflow-y-auto p-4">
              {detailLoading ? (
                <div className="text-center text-gray-400 py-12 text-sm">Loading...</div>
              ) : detail.length === 0 ? (
                <div className="text-center text-gray-400 py-12 text-sm">No activity</div>
              ) : (
                <table className="text-xs w-full">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-32">Time</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold w-20">Action</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold">Module</th>
                      <th className="text-left px-2 py-2 text-gray-500 uppercase font-semibold">Entry</th>
                      <th className="text-right px-2 py-2 text-gray-500 uppercase font-semibold w-16">Words</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.map(d => (
                      <tr key={d.id} className="border-t hover:bg-gray-50">
                        <td className="px-2 py-1.5 text-gray-500 font-mono text-[11px]">
                          {new Date(d.at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-2 py-1.5">
                          <span className={`px-1.5 py-0.5 rounded text-[10px] ${ACTION_COLORS[d.action] || 'bg-gray-100 text-gray-700'}`}>{d.action}</span>
                        </td>
                        <td className="px-2 py-1.5 capitalize">{String(d.module || '—').replace(/_/g, ' ').replace(/-/g, ' ')}</td>
                        <td className="px-2 py-1.5 text-gray-600 truncate max-w-[260px]" title={d.entity_label || d.path}>
                          {d.entity_label || d.path || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-right font-semibold text-red-700">{fmtNum(d.words)}{d.truncated && <span title="truncated" className="text-amber-500">*</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
