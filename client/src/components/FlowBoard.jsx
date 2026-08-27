// Generic SOP flow board (mam 2026-08-28) — the reference dashboard design
// shared by the SOP-07 Procurement Flow Board and the SOP-05 Rates Board:
// one-row compact tiles (stage counts + done/all×100−100 %), chevron
// pipeline with record cards, SLA alerts, tasks due today, donuts and an
// activity feed. Every tile, stage header, record card and "+N more" is a
// link to the tab where that process is completed (mam: "any record
// clickable to complete that process").
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { FiFileText, FiAlertTriangle, FiClock, FiRefreshCw } from 'react-icons/fi';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip } from 'recharts';

export const STAGE_COLORS = ['#8b5cf6', '#6366f1', '#3b82f6', '#06b6d4', '#f59e0b', '#f97316', '#10b981', '#22c55e'];
const DONUT_COLORS = ['#8b5cf6', '#3b82f6', '#06b6d4', '#f59e0b', '#10b981', '#94a3b8'];

export const timeAgo = (ts) => {
  if (!ts) return '';
  const ms = Date.now() - new Date(String(ts).replace(' ', 'T') + 'Z').getTime();
  if (!Number.isFinite(ms) || ms < 0) return '';
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  return `${Math.floor(h / 24)} d ago`;
};

// Stage % — scorecard convention: 0% green = all through, −100% red = none.
const StagePct = ({ pct }) => (
  <span className={`text-[10px] font-semibold ${pct == null ? 'text-gray-300' : pct >= 0 ? 'text-emerald-600' : pct >= -50 ? 'text-amber-600' : 'text-red-500'}`}
    title="work done ÷ total ×100 −100">
    {pct == null ? 'clear ✓' : `${pct > 0 ? '+' : ''}${pct}%${pct === -100 ? ' · not done' : pct === 0 ? ' ✓' : ''}`}
  </span>
);

// cardExtra(stageKey, card, reload) — optional render prop: an ACTION row
// inside a record card (e.g. ⚡ Make Plan / 📄 Enquiry Sheet) so the step
// can be completed right on the board (mam 2026-08-28 "make it here system").
export default function FlowBoard({ title, subtitle, endpoint, stageLinks = {}, stageIcons = {}, distsOf, extraTiles, activityBadge, openTo, cardExtra }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  // "+N more" expands the column INLINE (mam 2026-08-28: "show all data
  // below — it open page which is wrong").
  const [expanded, setExpanded] = useState({});
  // A record card opens the tab pre-filtered to JUST that record via ?q=
  // (mam: "click → open only that thing, action open to complete").
  const recordLink = (stageKey, card) => {
    const base = stageLinks[stageKey] || '#';
    if (!card.ref || base === '#') return base;
    return `${base}${base.includes('?') ? '&' : '?'}q=${encodeURIComponent(card.ref)}`;
  };
  const load = () => api.get(endpoint).then(r => setD(r.data)).catch(e => setErr(e.response?.data?.error || 'Failed to load'));
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, [endpoint]);

  if (err) return <div className="p-10 text-center text-red-600">{err}</div>;
  if (!d) return <div className="p-10 text-center text-gray-400">Loading flow board…</div>;

  const tiles = d.pipeline.map((c, i) => ({
    key: c.key, label: c.label, value: c.total, color: STAGE_COLORS[i % STAGE_COLORS.length],
    icon: stageIcons[c.key] || FiFileText, pct: c.pct, link: stageLinks[c.key] || openTo?.link || '#',
  }));
  const dists = distsOf ? distsOf(d) : [];
  const extras = extraTiles ? extraTiles(d) : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{title}</h1>
          <p className="text-sm text-gray-500">{subtitle}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs text-gray-500 bg-white border rounded-lg px-3 py-1.5">This Week ({d.week.from} → {d.week.to})</span>
          <button onClick={load} className="btn btn-secondary text-xs flex items-center gap-1"><FiRefreshCw size={13} /> Refresh</button>
          {openTo && <Link to={openTo.link} className="btn btn-primary text-xs">{openTo.label}</Link>}
        </div>
      </div>

      {/* Tiles — one per stage + extras, single congested row on desktop */}
      <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(148px, 1fr))' }}>
        {tiles.map(t => (
          <Link key={t.key} to={t.link} className="card p-2.5 flex items-center gap-2 hover:shadow-md transition" title={`Open ${t.label}`}>
            <div className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0"
                 style={{ background: `${t.color}22`, color: t.color }}><t.icon size={16} /></div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 truncate" title={t.label}>{t.label}</p>
              <p className="text-xl font-extrabold leading-5">{t.value}</p>
              <StagePct pct={t.pct} />
            </div>
          </Link>
        ))}
        {extras.map(t => (
          <div key={t.label} className={`card p-2.5 flex items-center gap-2 ${t.cardClass || ''}`}>
            <div className={`w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 ${t.iconClass}`}><t.icon size={16} /></div>
            <div className="min-w-0">
              <p className="text-[10px] text-gray-500 truncate" title={t.title || t.label}>{t.label}</p>
              <p className="text-xl font-extrabold leading-5">{t.value}</p>
              <span className={`text-[10px] font-semibold ${t.subClass || 'text-gray-400'}`}>{t.sub}</span>
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <div className="xl:col-span-3 space-y-4">
          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-bold">Pipeline</h3>
              <span className="text-[11px] text-gray-400">{d.pipeline.map(c => c.sop).join(' → ')}</span>
            </div>
            <div className="overflow-x-auto">
              <div className="grid gap-2" style={{ gridTemplateColumns: `repeat(${d.pipeline.length}, minmax(0,1fr))`, minWidth: d.pipeline.length * 155 }}>
                {d.pipeline.map((c, i) => (
                  <div key={c.key}>
                    <Link to={stageLinks[c.key] || '#'} className="block text-white text-center py-2 px-1 text-[11px] font-bold leading-tight hover:opacity-90"
                      style={{ background: STAGE_COLORS[i % STAGE_COLORS.length], clipPath: i === d.pipeline.length - 1 ? undefined : 'polygon(0 0, calc(100% - 12px) 0, 100% 50%, calc(100% - 12px) 100%, 0 100%)', borderRadius: 6 }}
                      title={`Open ${c.label}`}>
                      <div className="opacity-80">{c.sop}</div>
                      {c.label}
                    </Link>
                    <div className="text-center py-1.5 border-b mb-1">
                      <span className="text-xl font-extrabold">{c.total}</span>
                      <span className="text-[10px] text-gray-400 block -mt-1">records</span>
                    </div>
                    <div className={`space-y-1.5 ${expanded[c.key] ? 'max-h-[420px] overflow-y-auto pr-0.5' : ''}`}>
                      {/* Record cards — each opens its tab filtered to JUST
                          that record (?q=ref) so the completing action is
                          right in front. */}
                      {(expanded[c.key] ? c.cards : c.cards.slice(0, 3)).map((card, j) => (
                        <Link key={j} to={recordLink(c.key, card)} className="block border rounded-lg p-2 bg-white hover:shadow hover:border-indigo-300 transition"
                          title={`Open ${card.ref} to complete this step`}>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-bold text-indigo-700 truncate">{card.ref}</span>
                            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: STAGE_COLORS[i % STAGE_COLORS.length] }} />
                          </div>
                          <div className="text-[11px] font-medium truncate" title={card.title}>{card.title}</div>
                          <div className="text-[10px] text-gray-400 flex justify-between gap-1">
                            <span className="truncate">{card.owner}</span>
                            <span className="whitespace-nowrap">{timeAgo(card.created_at)}</span>
                          </div>
                          {cardExtra && cardExtra(c.key, card, load)}
                        </Link>
                      ))}
                      {/* "+N more" expands INLINE below — no page jump. */}
                      {!expanded[c.key] && c.cards.length > 3 && (
                        <button onClick={() => setExpanded(e => ({ ...e, [c.key]: true }))}
                          className="block w-full text-center text-[11px] text-blue-600 font-semibold hover:underline"
                          title={`Show all ${c.total} here`}>
                          + {c.total - 3} more
                        </button>
                      )}
                      {expanded[c.key] && (
                        <div className="text-center space-x-2">
                          <button onClick={() => setExpanded(e => ({ ...e, [c.key]: false }))}
                            className="text-[11px] text-gray-500 font-semibold hover:underline">show less</button>
                          {c.total > c.cards.length && (
                            <Link to={stageLinks[c.key] || '#'} className="text-[11px] text-blue-600 font-semibold hover:underline">
                              all {c.total} in tab →
                            </Link>
                          )}
                        </div>
                      )}
                      {c.total === 0 && <div className="text-center text-[10px] text-gray-300 py-2">clear ✓</div>}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {dists.map(({ title: dt, data }) => {
              const total = (data || []).reduce((s, x) => s + x.c, 0);
              return (
                <div key={dt} className="card p-4">
                  <h3 className="font-bold mb-1">{dt}</h3>
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
              {d.activity.map((a, i) => {
                const badge = activityBadge ? activityBadge(a.k) : { bg: 'bg-gray-400', txt: a.k.slice(0, 2).toUpperCase() };
                return (
                  <div key={i} className="flex items-start gap-2">
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white flex-shrink-0 ${badge.bg}`}>{badge.txt}</div>
                    <div className="text-[12px] leading-tight">
                      <span className="font-semibold">{a.who || 'System'}</span> {a.verb} <span className="font-semibold text-indigo-700">{a.ref}</span>
                      <div className="text-[10px] text-gray-400">{timeAgo(a.created_at)}</div>
                    </div>
                  </div>
                );
              })}
              {d.activity.length === 0 && <p className="text-sm text-gray-400">No activity yet</p>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
