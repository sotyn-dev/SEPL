// Labour Analytics (director ask, 2026-07-26): per-project labour budget
// vs consumed, manhours, target-vs-actual manpower, ₹ earned per manhour.
// Read-only rollup over DPR data — accuracy flows from the Quick DPR +
// material-issue discipline feeding it.

import { useState, useEffect } from 'react';
import api from '../api';
import { FiUsers, FiClock, FiTrendingUp, FiAlertTriangle } from 'react-icons/fi';

const fmtRs = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
const fmtShort = n => {
  const v = +n || 0;
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(2)} L`;
  return fmtRs(v);
};

export default function LabourAnalytics() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  useEffect(() => {
    setLoading(true);
    api.get('/labour-analytics', { params: { date_from: dateFrom || undefined, date_to: dateTo || undefined } })
      .then(r => setRows(r.data?.rows || []))
      .catch(() => setRows([]))
      .finally(() => setLoading(false));
  }, [dateFrom, dateTo]);

  const tot = rows.reduce((a, r) => ({
    budget: a.budget + r.budget_labour, consumed: a.consumed + r.consumed_labour_cost,
    manhours: a.manhours + r.manhours, work: a.work + r.work_value,
  }), { budget: 0, consumed: 0, manhours: 0, work: 0 });

  const pctBadge = (pct, invert = false) => {
    if (pct === null || pct === undefined) return <span className="text-gray-300 text-xs">—</span>;
    const bad = invert ? pct < 70 : pct > 100;
    const warn = invert ? pct < 90 : pct > 85;
    const cls = bad ? 'bg-red-100 text-red-700' : warn ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700';
    return <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${cls}`}>{pct}%</span>;
  };

  return (
    <div className="space-y-4">
      <div className="text-xs text-gray-600 bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-100 rounded-lg px-4 py-2.5">
        <b>Budget</b> = BOQ labour value (labour rate, else 11% of SITC). <b>Consumed</b> = Skilled+Helper cost from filed DPRs.
        <b> Manhours</b> = (skilled + helper + contractor manpower) × 8h per DPR day. <b>₹/manhour</b> = work value earned ÷ manhours — falling means the site is burning labour without producing billable progress.
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-gray-500">From <input type="date" className="input text-sm ml-1" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
        <label className="text-xs text-gray-500">To <input type="date" className="input text-sm ml-1" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
        <span className="text-[11px] text-gray-400">(blank = all time)</span>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {[
          { label: 'Labour Budget', value: fmtShort(tot.budget), icon: FiTrendingUp, ring: 'bg-blue-100 text-blue-600' },
          { label: 'Labour Consumed', value: fmtShort(tot.consumed), sub: tot.budget > 0 ? `${Math.round((tot.consumed / tot.budget) * 100)}% of budget` : '', icon: FiAlertTriangle, ring: tot.consumed > tot.budget ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-600' },
          { label: 'Total Manhours', value: Math.round(tot.manhours).toLocaleString('en-IN'), icon: FiClock, ring: 'bg-indigo-100 text-indigo-600' },
          { label: 'Avg ₹/Manhour', value: tot.manhours > 0 ? fmtRs(tot.work / tot.manhours) : '—', sub: 'work value ÷ manhours', icon: FiUsers, ring: 'bg-amber-100 text-amber-600' },
        ].map((c, i) => {
          const Icon = c.icon;
          return (
            <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4 flex items-center gap-3">
              <div className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${c.ring}`}><Icon size={18} /></div>
              <div className="min-w-0">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold truncate">{c.label}</div>
                <div className="text-xl font-bold leading-tight">{c.value}</div>
                {c.sub && <div className="text-[10px] text-gray-400">{c.sub}</div>}
              </div>
            </div>
          );
        })}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="text-sm w-full">
            <thead>
              <tr className="bg-gradient-to-b from-gray-50 to-gray-100 border-b border-gray-200 text-[10px] uppercase tracking-wider text-gray-500">
                <th className="px-4 py-3 text-left font-semibold">Project</th>
                <th className="px-4 py-3 text-right font-semibold">Labour Budget</th>
                <th className="px-4 py-3 text-right font-semibold">Consumed</th>
                <th className="px-4 py-3 text-center font-semibold" title="Consumed ÷ budget — over 100% means labour overrun">Budget Used</th>
                <th className="px-4 py-3 text-right font-semibold">Manhours</th>
                <th className="px-4 py-3 text-center font-semibold" title="Average daily manpower vs the value-slab target">Manpower (avg / target)</th>
                <th className="px-4 py-3 text-center font-semibold">Coverage</th>
                <th className="px-4 py-3 text-right font-semibold" title="Work value earned per manhour">₹/Manhour</th>
                <th className="px-4 py-3 text-center font-semibold">DPR Days</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan="9" className="text-center py-10 text-gray-400">Loading…</td></tr>
              ) : rows.length === 0 ? (
                <tr><td colSpan="9" className="text-center py-10 text-gray-400">No labour data yet — file DPRs to populate this.</td></tr>
              ) : rows.map((r, i) => (
                <tr key={r.key} className={`border-b border-gray-100 ${i % 2 ? 'bg-gray-50/40' : 'bg-white'}`}>
                  <td className="px-4 py-2.5 font-medium text-gray-800">{r.project}<span className="block text-[10px] text-gray-400">{fmtShort(r.value)} project</span></td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap">{fmtShort(r.budget_labour)}</td>
                  <td className="px-4 py-2.5 text-right whitespace-nowrap font-semibold">{fmtShort(r.consumed_labour_cost)}</td>
                  <td className="px-4 py-2.5 text-center">{pctBadge(r.budget_used_pct)}</td>
                  <td className="px-4 py-2.5 text-right">{r.manhours.toLocaleString('en-IN')}</td>
                  <td className="px-4 py-2.5 text-center whitespace-nowrap"><b>{r.avg_manpower}</b> <span className="text-gray-400">/ {r.required_manpower}</span></td>
                  <td className="px-4 py-2.5 text-center">{pctBadge(r.manpower_coverage_pct, true)}</td>
                  <td className="px-4 py-2.5 text-right">{r.productivity_per_hour != null ? fmtRs(r.productivity_per_hour) : '—'}</td>
                  <td className="px-4 py-2.5 text-center text-gray-500">{r.dpr_days}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
