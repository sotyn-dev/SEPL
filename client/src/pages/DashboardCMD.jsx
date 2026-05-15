// CMD Dashboard — TOC v3 spec, dark-navy style mam approved on
// 2026-05-15 (reference screenshot of the Support Team Slide
// Dashboard).  All numbers come from one fetch of
// /api/dashboards/kpi which under the hood calls the same compute
// function as the external /audit/kpi endpoint — single source of
// truth for the 09:00 email and these in-app pages.
//
// Layout:
//   Row 1 — six KPI tiles (CCC, DSO, DPO, AR Outstanding, Bank,
//           WIP Unbilled) with green/red trend hints
//   Row 2 — three half-gauges (On-time Milestone %, Lead→PO %,
//           Quote Lead Time) + AR aging donut on the right
//   Row 3 — three charts (Revenue per FTE bars, AR aging stack,
//           Project margin variance — worst 5)

import { useState, useEffect } from 'react';
import api from '../api';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, AreaChart, Area, RadialBarChart, RadialBar,
} from 'recharts';
import { FiTrendingUp, FiTrendingDown, FiRefreshCw, FiDownload } from 'react-icons/fi';
import toast from 'react-hot-toast';

const fmtINR = (v) => {
  if (v == null || isNaN(v)) return '—';
  if (Math.abs(v) >= 1e7) return `₹${(v / 1e7).toFixed(2)}Cr`;
  if (Math.abs(v) >= 1e5) return `₹${(v / 1e5).toFixed(2)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
};

const fmtNum = (v) => (v == null || isNaN(v) ? '—' : v.toLocaleString('en-IN'));

// Tile — large value, small label, optional trend arrow.  Color
// semantics: red for "lower is better but going up" (CCC, DSO),
// emerald for "higher is better" (Bank, Free Inventory).
function Tile({ label, value, sublabel, accent = 'sky' }) {
  const accentMap = {
    sky: 'border-sky-500',
    red: 'border-red-500',
    amber: 'border-amber-500',
    emerald: 'border-emerald-500',
    purple: 'border-purple-500',
    rose: 'border-rose-500',
  };
  return (
    <div className={`rounded-xl bg-slate-800/60 border-l-4 ${accentMap[accent] || accentMap.sky} p-4 shadow-lg`}>
      <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">{label}</div>
      <div className="text-3xl font-extrabold text-white tabular-nums leading-none">{value}</div>
      {sublabel ? <div className="text-[11px] text-slate-400 mt-2">{sublabel}</div> : null}
    </div>
  );
}

// Half-gauge using RadialBarChart.  Value clamped 0–100.
function Gauge({ label, value, max = 100, unit = '%', accent = '#38bdf8' }) {
  const v = Math.max(0, Math.min(max, value ?? 0));
  const data = [{ name: label, value: v, fill: accent }];
  return (
    <div className="rounded-xl bg-slate-800/60 p-4 shadow-lg flex flex-col">
      <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-2">{label}</div>
      <div className="relative flex-1" style={{ minHeight: 140 }}>
        <ResponsiveContainer>
          <RadialBarChart cx="50%" cy="100%" innerRadius="100%" outerRadius="180%"
            barSize={18} data={data} startAngle={180} endAngle={0}>
            <RadialBar background={{ fill: '#1e293b' }} dataKey="value" cornerRadius={9} />
          </RadialBarChart>
        </ResponsiveContainer>
        <div className="absolute inset-0 flex items-end justify-center pb-2">
          <div className="text-center">
            <div className="text-3xl font-extrabold text-white tabular-nums">{value == null ? '—' : value}</div>
            <div className="text-[10px] text-slate-400 -mt-1">{unit}</div>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DashboardCMD() {
  const [kpi, setKpi] = useState(null);
  const [days, setDays] = useState(30);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState(null);

  const load = async (d = days) => {
    setLoading(true); setErr(null);
    try {
      const r = await api.get(`/dashboards/kpi?days=${d}`);
      setKpi(r.data);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
      toast.error('Could not load KPI feed — admin role required');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { load(); }, []);

  if (err && !kpi) {
    return (
      <div className="bg-slate-900 text-slate-100 rounded-2xl p-8 -mx-2 md:-mx-6 -mt-2 md:-mt-6 min-h-screen">
        <h1 className="text-2xl font-bold">CMD Dashboard</h1>
        <p className="mt-4 text-red-300">Failed to load: {err}</p>
      </div>
    );
  }
  if (!kpi) {
    return (
      <div className="bg-slate-900 text-slate-100 rounded-2xl p-8 -mx-2 md:-mx-6 -mt-2 md:-mt-6 min-h-screen flex items-center justify-center">
        <div className="text-slate-400">Loading dashboard…</div>
      </div>
    );
  }

  const ccc = kpi.cash_conversion_cycle;
  const ar = kpi.ar;
  const ap = kpi.ap;
  const inv = kpi.inventory;
  const sales = kpi.sales;
  const bank = kpi.bank;
  const wip = kpi.wip;
  const funnel = kpi.funnel;
  const rpf = kpi.revenue_per_fte;
  const margin = kpi.project_margin_variance;

  const arAgingChart = [
    { name: '0-30',   value: ar.aging.bucket_0_30,    fill: '#10b981' },
    { name: '31-60',  value: ar.aging.bucket_31_60,   fill: '#fbbf24' },
    { name: '61-90',  value: ar.aging.bucket_61_90,   fill: '#fb923c' },
    { name: '90+',    value: ar.aging.bucket_90_plus, fill: '#ef4444' },
  ];

  const deptChart = (rpf.by_department || []).map(r => ({
    name: r.department,
    rev_per_fte: r.rev_per_fte || 0,
    fte: r.fte,
  }));

  const worstMargins = (margin.worst_5 || []).map(r => ({
    name: r.client?.slice(0, 16) || r.po_number || '—',
    variance: r.variance,
  }));

  return (
    <div className="bg-slate-900 text-slate-100 rounded-2xl p-6 -mx-2 md:-mx-6 -mt-2 md:-mt-6 min-h-screen">
      {/* Header */}
      <div className="flex items-center justify-between mb-5 flex-wrap gap-3">
        <div>
          <h1 className="text-3xl font-extrabold tracking-tight">CMD Dashboard</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {kpi.window.from} → {kpi.window.to} · last {kpi.window.days} days · refreshed {new Date(kpi.generated_at).toLocaleTimeString('en-IN')}
          </p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={days} onChange={e => { setDays(+e.target.value); load(+e.target.value); }}
            className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm">
            <option value={7}>7 days</option>
            <option value={30}>30 days</option>
            <option value={90}>90 days</option>
            <option value={180}>6 months</option>
            <option value={365}>1 year</option>
          </select>
          <button onClick={() => load(days)} disabled={loading}
            className="bg-slate-800 hover:bg-slate-700 border border-slate-700 rounded-lg px-3 py-1.5 text-sm flex items-center gap-1.5">
            <FiRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {/* Row 1 — 6 KPI tiles */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3 mb-4">
        <Tile label="Cash Conversion Cycle"     value={ccc.ccc != null ? `${ccc.ccc}d` : '—'} sublabel={`DSO ${ccc.dso ?? '—'} + DIO ${ccc.dio ?? '—'} − DPO ${ccc.dpo ?? '—'}`} accent={ccc.ccc != null && ccc.ccc > 60 ? 'red' : 'emerald'} />
        <Tile label="AR Outstanding"             value={fmtINR(ar.outstanding_total)} sublabel={`${fmtINR(ar.aging.bucket_90_plus)} overdue 90+`} accent="amber" />
        <Tile label="AP Outstanding"             value={fmtINR(ap.outstanding_total)} sublabel={`vs ${fmtINR(ap.purchases_in_window)} purchases`} accent="rose" />
        <Tile label="Bank Closing"               value={bank ? fmtINR(bank.closing_balance) : '—'} sublabel={bank ? `as of ${bank.date}` : 'no cash_flow_daily row'} accent="emerald" />
        <Tile label="WIP Unbilled"               value={fmtINR(wip.unbilled)} sublabel={`${fmtINR(wip.billed)} billed of ${fmtINR(wip.book_value)}`} accent="purple" />
        <Tile label="Free Inventory"             value={fmtINR(inv.free_to_use_value)} sublabel={`of ${fmtINR(inv.total_value)} total`} accent="sky" />
      </div>

      {/* Row 2 — 3 gauges + AR aging donut */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3 mb-4">
        <Gauge label="On-Time Milestone %"  value={kpi.on_time_milestone_pct}    accent="#10b981" />
        <Gauge label="Lead → PO %"           value={funnel.lead_to_po_pct}        accent="#38bdf8" />
        <Gauge label="Quote Lead Time"       value={funnel.quote_lead_time_days_avg} unit="days" max={30} accent="#fb923c" />

        {/* AR aging donut */}
        <div className="rounded-xl bg-slate-800/60 p-4 shadow-lg">
          <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">AR Aging Mix</div>
          <div className="text-xs text-slate-500 mb-1">{fmtINR(ar.outstanding_total)} total</div>
          <div style={{ height: 140 }}>
            <ResponsiveContainer>
              <PieChart>
                <Pie data={arAgingChart} dataKey="value" nameKey="name" innerRadius={32} outerRadius={56} paddingAngle={2}>
                  {arAgingChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Pie>
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }} formatter={(v) => fmtINR(v)} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="grid grid-cols-2 gap-1 text-[10px] mt-1">
            {arAgingChart.map((d, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full" style={{ background: d.fill }} />
                <span className="text-slate-300">{d.name}</span>
                <span className="text-slate-500 ml-auto">{fmtINR(d.value)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Row 3 — Revenue per FTE bars + AR aging stacked + worst margin */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="rounded-xl bg-slate-800/60 p-4 shadow-lg">
          <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">Revenue per FTE — by Department</div>
          <div className="text-xs text-slate-500 mb-2">overall {fmtINR(rpf.overall)} · {rpf.active_employees} FTE</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={deptChart} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtINR(v)} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }} formatter={(v) => fmtINR(v)} />
                <Bar dataKey="rev_per_fte" radius={[6, 6, 0, 0]}>
                  {deptChart.map((_, i) => (
                    <Cell key={i} fill={['#38bdf8','#10b981','#fb923c','#f472b6','#a78bfa','#fbbf24'][i % 6]} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-4 shadow-lg">
          <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">AR Outstanding by Bucket</div>
          <div className="text-xs text-slate-500 mb-2">red &gt;= 60 days collection risk</div>
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={arAgingChart} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                <XAxis dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => fmtINR(v)} />
                <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }} formatter={(v) => fmtINR(v)} />
                <Bar dataKey="value" radius={[6, 6, 0, 0]}>
                  {arAgingChart.map((d, i) => <Cell key={i} fill={d.fill} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-xl bg-slate-800/60 p-4 shadow-lg">
          <div className="text-[10px] font-semibold tracking-wider uppercase text-slate-400 mb-1">Worst-5 Project Margins</div>
          <div className="text-xs text-slate-500 mb-2">avg variance {margin.avg_variance_pct ?? '—'}% · n={margin.sample_size}</div>
          {worstMargins.length === 0 ? (
            <div className="text-slate-500 text-sm py-8 text-center">No margin variance data yet — needs DPR cost_b and BB actual_margin_pct on the same PO.</div>
          ) : (
            <div style={{ height: 220 }}>
              <ResponsiveContainer>
                <BarChart data={worstMargins} layout="vertical" margin={{ top: 5, right: 10, left: 60, bottom: 5 }}>
                  <XAxis type="number" tick={{ fill: '#94a3b8', fontSize: 10 }} axisLine={false} tickLine={false} tickFormatter={(v) => `${v}%`} />
                  <YAxis type="category" dataKey="name" tick={{ fill: '#94a3b8', fontSize: 11 }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8, color: '#e2e8f0' }} formatter={(v) => `${v}% variance`} />
                  <Bar dataKey="variance" fill="#ef4444" radius={[0, 6, 6, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Funnel + revenue summary footer */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
        <div className="rounded-xl bg-slate-800/40 p-3 flex items-center justify-between">
          <span className="text-slate-400 uppercase tracking-wider text-[10px]">Sales this window</span>
          <span className="text-lg font-bold text-emerald-400">{fmtINR(sales.total_in_window)}</span>
        </div>
        <div className="rounded-xl bg-slate-800/40 p-3 flex items-center justify-between">
          <span className="text-slate-400 uppercase tracking-wider text-[10px]">Leads → Won</span>
          <span className="text-lg font-bold">{funnel.won_in_window} <span className="text-slate-500 text-sm">/ {funnel.leads_in_window}</span></span>
        </div>
        <div className="rounded-xl bg-slate-800/40 p-3 flex items-center justify-between">
          <span className="text-slate-400 uppercase tracking-wider text-[10px]">Free Inventory</span>
          <span className="text-lg font-bold text-sky-400">{fmtINR(inv.free_to_use_value)}</span>
        </div>
      </div>
    </div>
  );
}
