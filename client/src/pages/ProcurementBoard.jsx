// SOP-07 Procurement Flow Board (mam 2026-08-28): "same ditto" as the
// reference dashboard design she shared — KPI tiles with vs-last-week
// deltas, a chevron stage pipeline with record cards, SLA alerts, tasks
// due today, distribution donuts and an activity feed — but the stages
// are OUR actual Indent-to-Material-at-Site flow (SOP-07, owner Purchase
// Head). All data live from /procurement/flow-board.
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { FiFileText, FiCheckCircle, FiTruck, FiPackage, FiCreditCard, FiAlertTriangle, FiClock, FiRefreshCw, FiDollarSign, FiFilePlus } from 'react-icons/fi';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

const STAGE_COLORS = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#f59e0b', '#f97316', '#10b981', '#22c55e'];
// Where each stage's "+N more" / header lands in the Procurement page
// (mam 2026-08-28: "+6 more is not clickable").
const STAGE_LINKS = {
  indent: '/procurement?tab=indents',
  rates: '/procurement?tab=rates',
  po_create: '/procurement?tab=vendorpo',
  po_approval: '/procurement?tab=vendorpo',
  purchase_bill: '/procurement?tab=bills',
  sales_bill: '/procurement?tab=dispatch',
  received: '/procurement?tab=dispatch',
  billed: '/procurement?tab=bills',
};
const DONUT_COLORS = ['#8b5cf6', '#3b82f6', '#06b6d4', '#f59e0b', '#10b981', '#94a3b8'];

const timeAgo = (ts) => {
  if (!ts) return '';
  const ms = Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
};

const Delta = ({ cur, prev }) => {
  if (prev == null) return null;
  // Scorecard convention (mam 2026-08-28): 0% = work done / on pace (green),
  // −100% = work NOT done (red). A zero tile must never show a green ↑0%.
  let v;
  if (!cur) v = -100;                                   // nothing done this week
  else if (!prev) v = 0;                                // work done, no baseline
  else v = Math.round((cur / prev) * 100) - 100;        // vs last week, variance style
  const good = v >= 0;
  return <span className={`text-[10px] font-semibold leading-tight ${good ? 'text-emerald-600' : v >= -50 ? 'text-amber-600' : 'text-red-500'}`}
    title={v === -100 ? 'Work not done this week' : 'vs last week'}>
    {good ? '↑' : '↓'} {v > 0 ? '+' : ''}{v}%{v === -100 ? ' · not done' : ' vs last wk'}
  </span>;
};

export default function ProcurementBoard() {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const load = () => api.get('/procurement/flow-board').then(r => setD(r.data)).catch(e => setErr(e.response?.data?.error || 'Failed to load'));
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);

  if (err) return <div className="p-10 text-center text-red-600">{err}</div>;
  if (!d) return <div className="p-10 text-center text-gray-400">Loading flow board…</div>;

  // One tile per pipeline step (mam 2026-08-28 "add all step which is
  // below") — live counts, each clicks through to its Procurement tab.
  const STAGE_ICONS = { indent: FiFileText, rates: FiDollarSign, po_create: FiFilePlus, po_approval: FiCheckCircle, purchase_bill: FiCreditCard, sales_bill: FiTruck, received: FiPackage, billed: FiFileText };
  const WEEKLY_KEYS = ['sales_bill', 'received', 'billed'];   // these totals are this-week counts
  const tiles = d.pipeline.map((c, i) => ({
    key: c.key, label: c.label, value: c.total, color: STAGE_COLORS[i],
    icon: STAGE_ICONS[c.key] || FiFileText,
    pct: c.pct,                                     // done/all ×100 −100 (scorecard style)
    sub: WEEKLY_KEYS.includes(c.key) ? 'this week' : 'pending',
    link: STAGE_LINKS[c.key] || '/procurement',
  }));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">Procurement Flow</h1>
          <p className="text-sm text-gray-500">SOP-07 · Indent to material at site — live board</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 bg-white border rounded-lg px-3 py-1.5">This Week ({d.week.from} → {d.week.to})</span>
          <button onClick={load} className="btn btn-secondary text-xs flex items-center gap-1"><FiRefreshCw size={13} /> Refresh</button>
          <Link to="/procurement" className="btn btn-primary text-xs">Open Procurement</Link>
        </div>
      </div>

      {/* KPI tiles — compact single row (mam: "congested so that in row"),
          one per pipeline step + debit + overdue, all clickable. */}
      <div className="grid grid-cols-2 sm:grid-cols-5 xl:grid-cols-10 gap-2">
        {tiles.map(t => (
          <Link key={t.key} to={t.link} className="card p-2.5 flex items-center gap-2 hover:shadow-md transition" title={`Open ${t.label}`}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                 style={{ background: `${t.color}22`, color: t.color }}><t.icon size={16} /></div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 truncate" title={t.label}>{t.label}</p>
              <p className="text-xl font-extrabold leading-5">{t.value}</p>
              {/* Stage % = done/all ×100 −100 (mam 2026-08-28, scorecard
                  convention): 0% green = all work through the stage,
                  −100% red = nothing done, null = nothing reached it. */}
              <span className={`text-[10px] font-semibold ${t.pct == null ? 'text-gray-300' : t.pct >= 0 ? 'text-emerald-600' : t.pct >= -50 ? 'text-amber-600' : 'text-red-500'}`}
                title="work done ÷ total ×100 −100">
                {t.pct == null ? 'clear ✓' : `${t.pct > 0 ? '+' : ''}${t.pct}%${t.pct === -100 ? ' · not done' : t.pct === 0 ? ' ✓' : ''}`}
              </span>
            </div>
          </Link>
        ))}
        <div className="card p-2.5 flex items-center gap-2 bg-red-50 border-red-100">
          <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 bg-red-100 text-red-600"><FiAlertTriangle size={16} /></div>
          <div className="min-w-0">
            <p className="text-[10px] text-gray-500 truncate" title="Open Debit Notes — S10 short/bad material">Open Debit Notes</p>
            <p className="text-xl font-extrabold leading-5">{d.kpis.debit_open.value}</p>
            <span className="text-[10px] text-gray-400">S10 short/bad</span>
          </div>
        </div>
        {/* Overdue processes in HOURS (mam 2026-08-28): anything past its
            SOP clock — indent/PO approvals > 24h, deliveries past date. */}
        {d.kpis.overdue && (
          <div className={`card p-2.5 flex items-center gap-2 ${d.kpis.overdue.value > 0 ? 'bg-amber-50 border-amber-200' : ''}`}>
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${d.kpis.overdue.value > 0 ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600'}`}><FiClock size={16} /></div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 truncate" title="Overdue Process — past the SOP clock, in hours">Overdue Process</p>
              <p className="text-xl font-extrabold leading-5">{d.kpis.overdue.value}</p>
              <span className={`text-[10px] font-semibold ${d.kpis.overdue.value > 0 ? 'text-amber-700' : 'text-emerald-600'}`}>
                {d.kpis.overdue.value > 0 ? `oldest ${d.kpis.overdue.oldest_hrs} hrs` : 'on time ✓'}
              </span>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        {/* ── Left 3/4: pipeline + donuts ── */}
        <div className="xl:col-span-3 space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">Material Pipeline</h3>
              <span className="text-[11px] text-gray-400">indent → rate → PO create → approval → purchase bill → sales bill → GRN → debit</span>
            </div>
            <div className="overflow-x-auto">
              <div className="grid gap-2 min-w-[1250px]" style={{ gridTemplateColumns: `repeat(${d.pipeline.length}, minmax(0,1fr))` }}>
                {d.pipeline.map((c, i) => (
                  <div key={c.key}>
                    {/* chevron stage header — clicks through to the tab */}
                    <Link to={STAGE_LINKS[c.key] || '/procurement'} className="block text-white text-center py-2 px-1 text-[11px] font-bold leading-tight hover:opacity-90"
                      style={{ background: STAGE_COLORS[i], clipPath: i === d.pipeline.length - 1 ? undefined : 'polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)' , borderRadius: 6 }}
                      title={`Open ${c.label} in Procurement`}>
                      <div className="opacity-80">{c.sop}</div>
                      {c.label}
                    </Link>
                    <div className="text-center py-1.5 border-b mb-1">
                      <span className="text-xl font-extrabold">{c.total}</span>
                      <span className="text-[10px] text-gray-400 block -mt-1">records</span>
                    </div>
                    <div className="space-y-1.5">
                      {c.cards.map((card, j) => (
                        <div key={j} className="border rounded-lg p-2 bg-white hover:shadow-sm transition">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-indigo-700">{card.ref}</span>
                            <span className="w-2 h-2 rounded-full" style={{ background: STAGE_COLORS[i] }} />
                          </div>
                          <div className="text-[11px] font-medium truncate" title={card.title}>{card.title}</div>
                          <div className="text-[10px] text-gray-400 flex justify-between gap-1">
                            <span className="truncate">{card.owner}</span>
                            <span className="whitespace-nowrap">{timeAgo(card.created_at)}</span>
                          </div>
                        </div>
                      ))}
                      {c.total > c.cards.length && (
                        <Link to={STAGE_LINKS[c.key] || '/procurement'}
                          className="block text-center text-[11px] text-blue-600 font-semibold hover:underline"
                          title={`See all ${c.total} in Procurement`}>
                          + {c.total - c.cards.length} more
                        </Link>
                      )}
                      {c.total === 0 && <div className="text-center text-[10px] text-gray-300 py-2">clear ✓</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Donuts */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {[{ title: 'Indent Status Distribution', data: d.indentDist }, { title: 'PO Stage Distribution', data: d.poDist }].map(({ title, data }) => {
              const total = data.reduce((s, x) => s + x.c, 0);
              return (
                <div key={title} className="card p-4">
                  <h3 className="font-bold mb-1">{title}</h3>
                  {total === 0 ? <p className="text-sm text-gray-400 py-8 text-center">No data yet</p> : (
                    <div className="flex items-center gap-3">
                      <div className="relative" style={{ width: 150, height: 150 }}>
                        <ResponsiveContainer width="100%" height="100%">
                          <PieChart>
                            <Pie data={data} dataKey="c" nameKey="label" innerRadius={48} outerRadius={70} paddingAngle={2}>
                              {data.map((x, i) => <Cell key={i} fill={DONUT_COLORS[i % DONUT_COLORS.length]} />)}
                            </Pie>
                            <Tooltip formatter={(v, n) => [`${v}`, n]} />
                          </PieChart>
                        </ResponsiveContainer>
                        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
                          <span className="text-xl font-extrabold">{total}</span>
                          <span className="text-[9px] text-gray-400">Total</span>
                        </div>
                      </div>
                      <div className="space-y-1 text-[11px] flex-1">
                        {data.map((x, i) => (
                          <div key={x.label} className="flex items-center justify-between gap-2">
                            <span className="flex items-center gap-1.5 capitalize"><span className="w-2.5 h-2.5 rounded-full" style={{ background: DONUT_COLORS[i % DONUT_COLORS.length] }} />{String(x.label).replace(/_/g, ' ')}</span>
                            <span className="text-gray-500 font-semibold">{x.c} ({Math.round(x.c / total * 100)}%)</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {/* ── Right rail: SLA alerts, tasks, activity ── */}
        <div className="space-y-4">
          <div className="card p-4">
            <h3 className="font-bold mb-2 flex items-center gap-2"><FiAlertTriangle className="text-red-500" size={16} /> SLA Alerts</h3>
            {d.alerts.length === 0 && <p className="text-sm text-gray-400">All clear — no rule breaks 🎉</p>}
            <div className="space-y-2">
              {d.alerts.map((a, i) => (
                <div key={i} className={`rounded-lg border p-2.5 ${a.level === 'red' ? 'bg-red-50 border-red-200' : 'bg-amber-50 border-amber-200'}`}>
                  <div className="flex justify-between gap-2">
                    <span className="text-[12px] font-bold">{a.ref}</span>
                    <span className={`text-[11px] font-semibold whitespace-nowrap ${a.level === 'red' ? 'text-red-600' : 'text-amber-700'}`}>{timeAgo(a.at)}</span>
                  </div>
                  <p className={`text-[11px] ${a.level === 'red' ? 'text-red-700' : 'text-amber-800'}`}>{a.text}</p>
                  {a.owner && <p className="text-[10px] text-gray-500">Owner: {a.owner}</p>}
                </div>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-bold mb-2 flex items-center gap-2"><FiClock className="text-indigo-500" size={16} /> Tasks Due Today</h3>
            {d.tasks.length === 0 && <p className="text-sm text-gray-400">Nothing pending today</p>}
            <div className="space-y-1.5">
              {d.tasks.map((t, i) => (
                <label key={i} className="flex items-start gap-2 text-[12px]">
                  <input type="checkbox" className="mt-0.5" />
                  <span className="flex-1">{t.text}</span>
                  <span className="text-[9px] font-bold uppercase text-gray-400 whitespace-nowrap">{t.tag}</span>
                </label>
              ))}
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-bold mb-2">Activity Feed</h3>
            <div className="space-y-2.5">
              {d.activity.map((a, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0
                    ${a.k === 'indent' ? 'bg-violet-500' : a.k === 'po' ? 'bg-blue-500' : a.k === 'grn' ? 'bg-emerald-500' : a.k === 'bill' ? 'bg-amber-500' : 'bg-red-500'}`}>
                    {a.k === 'indent' ? 'IN' : a.k === 'po' ? 'PO' : a.k === 'grn' ? 'GR' : a.k === 'bill' ? '₹' : 'DN'}
                  </div>
                  <div className="text-[12px] leading-tight">
                    <span className="font-semibold">{a.who || 'System'}</span> {a.verb} <span className="font-semibold text-indigo-700">{a.ref}</span>
                    <div className="text-[10px] text-gray-400">{timeAgo(a.created_at)}</div>
                  </div>
                </div>
              ))}
              {d.activity.length === 0 && <p className="text-sm text-gray-400">No activity yet</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
