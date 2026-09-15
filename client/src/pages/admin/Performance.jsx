// Admin ▸ Performance — what is slow on the LIVE server, right now.
//
// Hang audit 2026-09-05. The server is one synchronous-SQLite process, so a
// single slow request freezes every user. The server-side hang detector keeps
// the last stalls, slow requests and per-route blocking totals in memory
// (server/lib/hangDetector.js) and /api/admin/perf serves them — this page
// shows them so nobody needs the VPS terminal to answer "why did it hang?".
import { useState, useEffect, useCallback, createElement } from 'react';
import api from '../../api';
import toast from 'react-hot-toast';
import { FiActivity, FiRefreshCw, FiZap, FiClock, FiAlertTriangle, FiTrash2 } from 'react-icons/fi';
import { fmtDateTime } from '../../utils/datetime';

const ms = (v) => (v == null ? '—' : v >= 1000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);
const mb = (b) => (b == null ? '—' : `${(b / 1048576).toFixed(1)} MB`);
const ago = (t) => {
  if (!t) return '—';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  return `${(s / 3600).toFixed(1)} h ago`;
};

function Tile({ icon, label, value, sub, tone = 'gray' }) {
  const tones = {
    gray: 'bg-white border-gray-200 text-gray-900',
    red: 'bg-red-50 border-red-200 text-red-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    green: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  };
  return (
    <div className={`rounded-lg border p-3 ${tones[tone]}`}>
      <div className="flex items-center gap-2 text-xs uppercase tracking-wide opacity-70">{createElement(icon, { size: 14 })} {label}</div>
      <div className="text-2xl font-semibold mt-1">{value}</div>
      {sub && <div className="text-xs opacity-70 mt-0.5">{sub}</div>}
    </div>
  );
}

export default function Performance() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [auto, setAuto] = useState(true);

  const load = useCallback(async (silent) => {
    if (!silent) setLoading(true);
    try {
      const r = await api.get('/admin/perf');
      setData(r.data);
    } catch (e) {
      if (!silent) toast.error(e.response?.data?.error || e.message || 'Could not load performance data');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => { load(false); }, [load]);
  useEffect(() => {
    if (!auto) return undefined;
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(true); }, 15000);
    return () => clearInterval(t);
  }, [auto, load]);

  const reset = async () => {
    if (!window.confirm('Reset the performance counters? The history since the last restart is cleared.')) return;
    try { await api.post('/admin/perf/reset'); toast.success('Counters reset'); load(false); }
    catch (e) { toast.error(e.response?.data?.error || e.message); }
  };

  const t = data?.totals || {};
  const stallTone = !t.stalls ? 'green' : t.stall_max_ms >= 5000 ? 'red' : 'amber';
  const slowTone = !t.slow_requests ? 'green' : t.slow_requests > 20 ? 'red' : 'amber';

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-gray-900 flex items-center gap-2"><FiActivity /> Performance</h1>
          <p className="text-sm text-gray-500">
            Live view of what is slow on this server. One slow request blocks everyone, so the routes at the top of the
            table are the ones to fix first.
            {data && <> Since restart {ago(data.since)} · {data.totals.requests.toLocaleString()} requests.</>}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-gray-600 flex items-center gap-1">
            <input type="checkbox" checked={auto} onChange={e => setAuto(e.target.checked)} /> auto-refresh
          </label>
          <button onClick={() => load(false)} className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 flex items-center gap-1">
            <FiRefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button onClick={reset} className="px-3 py-1.5 text-sm rounded border border-gray-300 bg-white hover:bg-gray-50 text-gray-600 flex items-center gap-1">
            <FiTrash2 size={14} /> Reset
          </button>
        </div>
      </div>

      {!data ? (
        <div className="p-6 text-sm text-gray-500">Loading…</div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <Tile icon={FiAlertTriangle} label="Stalls" value={t.stalls} tone={stallTone}
              sub={`longest ${ms(t.stall_max_ms)} · ${ms(t.stall_total_ms)} total (> ${ms(data.thresholds.lag_ms)})`} />
            <Tile icon={FiClock} label="Slow requests" value={t.slow_requests} tone={slowTone}
              sub={`> ${ms(data.thresholds.slow_ms)} · ${t.requests ? ((100 * t.slow_requests) / t.requests).toFixed(2) : 0}% of all`} />
            <Tile icon={FiZap} label="In flight now" value={data.in_flight.length}
              sub={data.in_flight[0] ? `${data.in_flight[0].label.slice(0, 40)} (${ms(data.in_flight[0].ms)})` : 'idle'} />
            <Tile icon={FiActivity} label="Memory" value={`${data.memory.rss_mb} MB`}
              sub={`heap ${data.memory.heap_used_mb} / ${data.memory.heap_total_mb} MB`} />
            <Tile icon={FiActivity} label="Database" value={mb(data.db.bytes)}
              sub={`WAL ${mb(data.db.wal_bytes)}${data.cache ? ` · cache ${data.cache.entries}` : ''}`} />
          </div>

          <section className="bg-white rounded-lg border border-gray-200">
            <header className="px-4 py-2 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-medium text-gray-800">Routes by blocking time</h2>
              <span className="text-xs text-gray-500">requests ≥ {ms(data.thresholds.track_ms)}, ids collapsed to :id</span>
            </header>
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 text-gray-600 text-xs uppercase">
                  <tr>
                    <th className="text-left px-4 py-2">Route</th>
                    <th className="text-right px-3 py-2">Total</th>
                    <th className="text-right px-3 py-2">Count</th>
                    <th className="text-right px-3 py-2">Avg</th>
                    <th className="text-right px-3 py-2">Max</th>
                    <th className="text-right px-3 py-2">&gt; slow</th>
                    <th className="text-right px-4 py-2">Last</th>
                  </tr>
                </thead>
                <tbody>
                  {data.routes.length === 0 && (
                    <tr><td colSpan={7} className="px-4 py-6 text-center text-gray-500">Nothing over {ms(data.thresholds.track_ms)} since restart — the server is fast.</td></tr>
                  )}
                  {data.routes.map(r => (
                    <tr key={r.route} className="border-t border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-1.5 font-mono text-xs text-gray-800 break-all">{r.route}</td>
                      <td className="px-3 py-1.5 text-right font-medium">{ms(r.total_ms)}</td>
                      <td className="px-3 py-1.5 text-right">{r.count}</td>
                      <td className="px-3 py-1.5 text-right">{ms(r.avg_ms)}</td>
                      <td className={`px-3 py-1.5 text-right ${r.max_ms >= data.thresholds.slow_ms ? 'text-red-700 font-medium' : ''}`}>{ms(r.max_ms)}</td>
                      <td className="px-3 py-1.5 text-right">{r.over_slow || ''}</td>
                      <td className="px-4 py-1.5 text-right text-gray-500 whitespace-nowrap">{ago(r.last_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <div className="grid md:grid-cols-2 gap-4">
            <section className="bg-white rounded-lg border border-gray-200">
              <header className="px-4 py-2 border-b border-gray-100">
                <h2 className="font-medium text-gray-800">Recent stalls</h2>
                <p className="text-xs text-gray-500">The event loop stopped for this long. The request named is the one that was running — that is the culprit.</p>
              </header>
              <ul className="divide-y divide-gray-100 max-h-[28rem] overflow-y-auto">
                {data.stalls.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-500">No stalls recorded.</li>}
                {data.stalls.map((s, i) => (
                  <li key={i} className="px-4 py-2 text-sm">
                    <div className="flex items-center justify-between">
                      <span className={`font-medium ${s.lag_ms >= 5000 ? 'text-red-700' : 'text-amber-700'}`}>blocked {ms(s.lag_ms)}</span>
                      <span className="text-xs text-gray-500">{fmtDateTime(new Date(s.at).toISOString())}</span>
                    </div>
                    {s.just_finished && <div className="text-xs text-gray-700 font-mono break-all mt-0.5">just finished: {s.just_finished}</div>}
                    {s.inflight.length > 0 && <div className="text-xs text-gray-500 font-mono break-all mt-0.5">in flight: {s.inflight.join(' | ')}</div>}
                    {!s.just_finished && s.inflight.length === 0 && <div className="text-xs text-gray-500 mt-0.5">no request in flight — cron, backup or GC</div>}
                  </li>
                ))}
              </ul>
            </section>

            <section className="bg-white rounded-lg border border-gray-200">
              <header className="px-4 py-2 border-b border-gray-100">
                <h2 className="font-medium text-gray-800">Recent slow requests</h2>
                <p className="text-xs text-gray-500">Anything over {ms(data.thresholds.slow_ms)}, newest first.</p>
              </header>
              <ul className="divide-y divide-gray-100 max-h-[28rem] overflow-y-auto">
                {data.slow.length === 0 && <li className="px-4 py-6 text-center text-sm text-gray-500">No slow requests recorded.</li>}
                {data.slow.map((s, i) => (
                  <li key={i} className="px-4 py-2 text-sm">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-xs text-gray-800 break-all">{s.method} {s.url}</span>
                      <span className={`whitespace-nowrap font-medium ${s.ms >= 10000 ? 'text-red-700' : 'text-amber-700'}`}>{ms(s.ms)}</span>
                    </div>
                    <div className="text-xs text-gray-500 mt-0.5">status {s.status} · user {s.user} · {fmtDateTime(new Date(s.at).toISOString())}</div>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </>
      )}
    </div>
  );
}
