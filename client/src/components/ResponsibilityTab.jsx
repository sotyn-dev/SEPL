// Reusable "Responsible" tab — drop <ResponsibilityTab module="crm_funnel" />
// into any module page to get the per-record RACI + SLA time-tracking board
// (mam 2026-06-27). Per step you pick Responsible / Accountable / Consulted /
// Informed + the target time (SLA hours); the system tracks the actual time
// each step took and who ran late.
//
// Redesigned 2026-07-25 (mam: "team can't understand where the flow is broken
// and why — need full flow on one single screen"): the tab now opens straight
// into a FLOW BOARD — one row per in-flight record, one column per step,
// colour-coded cells (green done · amber running · red overdue · grey not
// reached) with a bottleneck strip on top counting how many records are stuck
// at each step. Loads only open records (?open=1) so it stays light on the
// VPS; "Show completed" pulls the full history. The old per-record cards and
// By-person summary remain as secondary views.
// Backed by /api/raci/board/:module + /api/raci/record/:module/:id.
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';

// hours → compact "2.5h" / "1d 3h" / "—"
function fmtDur(h) {
  if (h == null) return '—';
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.round(h * 10) / 10}h`;
  const d = Math.floor(h / 24); const rem = Math.round(h - d * 24);
  return rem ? `${d}d ${rem}h` : `${d}d`;
}

const RACI_FIELDS = [
  ['responsible_id', 'Responsible', 'text-emerald-600'],
  ['accountable_id', 'Accountable', 'text-blue-600'],
  ['consulted_id', 'Consulted', 'text-amber-600'],
  ['informed_id', 'Informed', 'text-gray-500'],
];

export default function ResponsibilityTab({ module, title }) {
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAll, setShowAll] = useState(false);      // false = in-flight only (?open=1)
  const [view, setView] = useState('flow');           // 'flow' | 'grid' | 'summary' | 'score'
  const [q, setQ] = useState('');
  const [stageFilter, setStageFilter] = useState(null); // step key from the bottleneck strip
  // 🏆 Scorecard — the cross-module /raci/performance leaderboard (mam
  // 2026-07-25: "make team more accountable, show scorecard"). Loaded on
  // demand when the view is opened; heavier than one board (walks every
  // RACI module) so never auto-fetched.
  const [perf, setPerf] = useState(null);
  const [perfLoading, setPerfLoading] = useState(false);

  // Editor modal
  const [editRec, setEditRec] = useState(null);
  const [editSteps, setEditSteps] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.get('/auth/users').then(u => setUsers((u.data || []).filter(x => x.active !== 0))).catch(() => {});
  }, []);

  const load = useCallback(async (all = showAll) => {
    setLoading(true);
    try {
      const b = await api.get(`/raci/board/${module}${all ? '' : '?open=1'}`);
      setData(b.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the flow board');
    } finally { setLoading(false); }
  }, [module, showAll]);

  // The flow board IS the tab — load it immediately (open records only, so
  // the payload stays small; the 2026-06-29 hang was full-history loads).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { load(false); }, [module]);

  const openEditor = async (rec) => {
    setEditRec(rec); setBusy(true);
    try {
      const cfg = await api.get(`/raci/record/${module}/${rec.id}`);
      setEditSteps(cfg.data.steps || []);
    } catch { toast.error('Could not load RACI for this record'); }
    finally { setBusy(false); }
  };
  const closeEditor = () => setEditRec(null);
  const setField = (i, k, v) => setEditSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));

  const save = async () => {
    if (!editRec) return;
    setBusy(true);
    try {
      await api.put(`/raci/record/${module}/${editRec.id}`, {
        steps: editSteps.map(s => ({
          step_key: s.key,
          responsible_id: s.responsible_id || null, accountable_id: s.accountable_id || null,
          consulted_id: s.consulted_id || null, informed_id: s.informed_id || null,
          sla_hours: s.sla_hours === '' || s.sla_hours == null ? null : +s.sla_hours,
          weight: s.weight === '' || s.weight == null ? null : +s.weight,
          commitment: s.commitment && String(s.commitment).trim() !== '' ? s.commitment : null,
          enabled: s.enabled !== false,
        })),
      });
      toast.success('Saved'); closeEditor(); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  const openScore = async () => {
    setView('score');
    if (perf || perfLoading) return;
    setPerfLoading(true);
    try {
      const r = await api.get('/raci/performance');
      setPerf(r.data);
    } catch (e) { toast.error(e.response?.data?.error || 'Scorecard load nahi hua — dobara try karein'); }
    finally { setPerfLoading(false); }
  };

  // Hinglish verdict — one line per person, no ambiguity about where they
  // stand (mam 2026-07-25: "write something in hinglish" — the team reads
  // this, so it talks like the team).
  const verdict = (score) => {
    if (score >= 80) return { txt: '🌟 Shabash! Kaam time pe — aise hi chalta rahe.', cls: 'text-emerald-700' };
    if (score >= 60) return { txt: '👍 Theek chal raha hai — thoda aur tez ho sakta hai.', cls: 'text-blue-700' };
    if (score >= 40) return { txt: '⚠️ Dhyan dein — kaam late ho raha hai, TAT miss ho rahi hai.', cls: 'text-amber-700' };
    return { txt: '🔴 Kaam atka hai — Monday review mein iska jawab dena hoga.', cls: 'text-rose-700' };
  };

  const stampStep = async (rec, step, value) => {
    try {
      await api.put(`/raci/step-done/${module}/${rec.id}`, { step_key: step.key, done_at: value || null });
      toast.success(value ? `${step.label} marked done` : `${step.label} reopened`);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update the step'); }
  };
  const todayStr = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  const stepDefs = data?.step_defaults || data?.steps || [];
  const allRows = data?.rows || [];
  const currentKeyOf = (r) => r.steps.find(s => s.status === 'current')?.key || null;

  // Worst offender on top: rows whose current step is most overdue come
  // first, so the fire is the first thing the team sees — not page 3.
  const overdueOf = (r) => r.steps.find(s => s.status === 'current')?.late_hours || 0;
  const runningOf = (r) => r.steps.find(s => s.status === 'current')?.elapsed_hours || 0;
  const rows = allRows.filter(r => {
    if (stageFilter && currentKeyOf(r) !== stageFilter) return false;
    if (!q.trim()) return true;
    return (r.title + ' ' + (r.subtitle || '')).toLowerCase().includes(q.trim().toLowerCase());
  }).sort((a, b) => overdueOf(b) - overdueOf(a) || runningOf(b) - runningOf(a));
  const summary = data?.summary || [];
  const totalLate = allRows.filter(r => overdueOf(r) > 0).length;

  // Bottleneck strip numbers: how many records are sitting at each step right
  // now, and how many of those have blown past their target.
  const strip = stepDefs.map(sd => {
    const here = allRows.filter(r => currentKeyOf(r) === sd.key);
    const late = here.filter(r => (r.steps.find(s => s.key === sd.key)?.late_hours || 0) > 0);
    return { ...sd, count: here.length, late: late.length };
  });
  const worstKey = strip.reduce((w, s) => (s.late > (w?.late || 0) ? s : w), null)?.key;

  // One cell of the flow board. The colour answers "where is it broken";
  // the text answers "who and by how much".
  const FlowCell = ({ rec, step }) => {
    if (!step) return <td className="border-l border-gray-100" />;
    const late = step.late_hours > 0;
    if (step.status === 'done') {
      return (
        <td className="border-l border-gray-100 px-1.5 py-1 text-center bg-emerald-50" title={`${step.label} — done ${step.at ? String(step.at).slice(0, 16) : ''} · took ${fmtDur(step.elapsed_hours)}${step.responsible ? ' · ' + step.responsible : ''}`}>
          <span className="text-emerald-700 font-bold text-xs">✓</span>
          <div className="text-[9px] text-emerald-700/80 leading-tight">{fmtDur(step.elapsed_hours)}</div>
        </td>
      );
    }
    if (step.status === 'current') {
      return (
        <td onClick={() => openEditor(rec)}
          className={`border-l px-1.5 py-1 text-center cursor-pointer ${late ? 'bg-rose-100 border-rose-200 animate-none' : 'bg-amber-50 border-amber-100'}`}
          title={`${step.label} — running ${fmtDur(step.elapsed_hours)}${step.sla_hours != null ? ' of ' + fmtDur(step.sla_hours) + ' target' : ''}${late ? ' · ' + fmtDur(step.late_hours) + ' OVER' : ''} · ${step.responsible || 'unassigned'} — click to assign / set target`}>
          <div className={`text-[10px] font-bold leading-tight ${late ? 'text-rose-700' : 'text-amber-700'}`}>
            {late ? '⚠ ' + fmtDur(step.late_hours) + ' over' : '● ' + fmtDur(step.elapsed_hours)}
          </div>
          <div className={`text-[9px] leading-tight truncate max-w-[90px] mx-auto ${late ? 'text-rose-600' : 'text-amber-600'}`}>
            {step.responsible || 'unassigned'}
          </div>
        </td>
      );
    }
    return <td className="border-l border-gray-100 px-1.5 py-1 text-center text-gray-300 text-[10px]">·</td>;
  };

  return (
    <div className="space-y-3">
      {/* Header / controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-gray-800">{title || data?.label || 'Responsible'} — live flow, one screen</h3>
          <p className="text-[11px] text-gray-500">
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-emerald-200 align-middle mr-1" />done
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-amber-200 align-middle mx-1 ml-3" />running (in target)
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-rose-300 align-middle mx-1 ml-3" />stuck — past target
            <span className="inline-block w-2.5 h-2.5 rounded-sm bg-gray-200 align-middle mx-1 ml-3" />not reached yet
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => openEditor({ id: 0, title: 'Whole module — default for all records' })}
            className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 h-8">
            ⚙ Owners &amp; targets
          </button>
          <input className="input text-xs h-8 w-40" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
          <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs">
            <button onClick={() => setView('flow')} className={`px-3 py-1.5 ${view === 'flow' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Flow board</button>
            <button onClick={() => setView('grid')} className={`px-3 py-1.5 ${view === 'grid' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Cards</button>
            <button onClick={() => setView('summary')} className={`px-3 py-1.5 ${view === 'summary' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>By person</button>
            <button onClick={openScore} className={`px-3 py-1.5 font-semibold ${view === 'score' ? 'bg-indigo-600 text-white' : 'bg-white text-amber-600'}`}>🏆 Scorecard</button>
          </div>
          <label className="flex items-center gap-1 text-[11px] text-gray-600 cursor-pointer select-none">
            <input type="checkbox" checked={showAll}
              onChange={e => { setShowAll(e.target.checked); load(e.target.checked); }} />
            incl. completed
          </label>
          <button onClick={() => load()} className="btn btn-secondary h-8 text-xs" title="Refresh">↻</button>
        </div>
      </div>

      {/* Bottleneck strip — where is work piling up RIGHT NOW. Click a stage
          to filter the board to the records sitting there. */}
      {stepDefs.length > 0 && (
        <div className="flex items-stretch gap-1 overflow-x-auto pb-1">
          {strip.map((s, i) => {
            const active = stageFilter === s.key;
            const tone = s.late > 0 ? 'border-rose-300 bg-rose-50' : s.count > 0 ? 'border-amber-300 bg-amber-50' : 'border-gray-200 bg-white';
            return (
              <div key={s.key} className="flex items-center shrink-0">
                <button onClick={() => setStageFilter(active ? null : s.key)}
                  className={`rounded-lg border px-2 py-1 text-left min-w-[92px] transition ${tone} ${active ? 'ring-2 ring-indigo-400' : 'hover:shadow-sm'} ${s.key === worstKey && s.late > 0 ? 'ring-2 ring-rose-400' : ''}`}
                  title={`${s.count} waiting here now${s.late ? `, ${s.late} past target` : ''}${s.responsible ? ` · owner: ${s.responsible}` : ''}${s.sla_hours != null ? ` · target ${fmtDur(s.sla_hours)}` : ''}`}>
                  <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-500 leading-tight truncate max-w-[110px]">{s.label}</div>
                  <div className="flex items-baseline gap-1">
                    <span className={`text-base font-bold leading-none ${s.late > 0 ? 'text-rose-600' : s.count > 0 ? 'text-amber-600' : 'text-gray-300'}`}>{s.count}</span>
                    {s.late > 0 && <span className="text-[9px] font-bold text-rose-600">{s.late} late</span>}
                  </div>
                  <div className="text-[9px] text-gray-500 leading-tight truncate max-w-[110px]">
                    {s.responsible || '—'}{s.sla_hours != null ? ` · ${fmtDur(s.sla_hours)}` : ''}
                  </div>
                </button>
                {i < strip.length - 1 && <span className="text-gray-300 mx-0.5">→</span>}
              </div>
            );
          })}
        </div>
      )}

      {/* Hinglish accountability banner — plain words, no jargon, so the whole
          team reads the same truth (mam 2026-07-25). */}
      {view === 'flow' && data && (
        totalLate > 0 ? (
          <div className="text-xs font-semibold text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">
            🔴 {totalLate} kaam target se late chal {totalLate > 1 ? 'rahe hain' : 'raha hai'} — jinke naam red box mein hain, kaam unke paas atka hai. Aaj hi clear karein. Jiska naam, uska kaam.
          </div>
        ) : (
          <div className="text-xs font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
            ✅ Sab kaam target ke andar chal rahe hain — shabash team! Aise hi chalta rahe.
          </div>
        )
      )}

      {loading && !data ? (
        <div className="py-12 text-center text-gray-400 text-sm">Loading…</div>
      ) : view === 'score' ? (
        // ── 🏆 SCORECARD — cross-module leaderboard. Score = (Quantity +
        // Time + Quality) / 3, straight from /api/raci/performance. Public
        // ranking is the accountability lever: same list every Monday.
        <div className="space-y-3">
          <div className="text-xs text-gray-600 bg-indigo-50 border border-indigo-200 rounded-lg px-3 py-2">
            <b>Score kaise banta hai:</b> Kitna kaam kiya (<b>Quantity</b>) + Time pe kiya (<b>Time</b>) + Jo naam pe tha wo poora kiya (<b>Quality</b>) — teeno ka average, 100 mein se. Har Monday review mein yehi list chalegi. Sab modules ka mila-jula score hai, sirf is page ka nahi.
          </div>
          {perfLoading ? (
            <div className="py-12 text-center text-gray-400 text-sm">Score ban raha hai…</div>
          ) : !perf || (perf.people || []).length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm border rounded-lg bg-white">
              Abhi kisi ke naam pe kaam assign nahi hai — pehle <b>⚙ Owners &amp; targets</b> se naam daaliye, phir score banega.
            </div>
          ) : (
            <>
              {(() => {
                const people = perf.people || [];
                const star = people[0];
                const slowest = [...people].sort((a, b) => b.late_hours - a.late_hours)[0];
                return (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div className="border border-emerald-200 bg-emerald-50 rounded-lg px-3 py-2 text-xs">
                      <span className="font-bold text-emerald-700">⭐ Star performer:</span>{' '}
                      <span className="font-semibold text-gray-800">{star.name}</span>
                      <span className="text-gray-600"> — score {star.score}/100, {star.on_time} kaam time pe. Isse seekho!</span>
                    </div>
                    {slowest && slowest.late_hours > 0 && (
                      <div className="border border-rose-200 bg-rose-50 rounded-lg px-3 py-2 text-xs">
                        <span className="font-bold text-rose-700">🐢 Sabse zyada atka:</span>{' '}
                        <span className="font-semibold text-gray-800">{slowest.name}</span>
                        <span className="text-gray-600"> — total {fmtDur(slowest.late_hours)} late, {slowest.late} kaam TAT ke baahar.</span>
                      </div>
                    )}
                  </div>
                );
              })()}
              <div className="overflow-x-auto border rounded-lg bg-white">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
                    <tr>
                      <th className="text-left p-2">#</th>
                      <th className="text-left p-2">Naam</th>
                      <th className="text-right p-2">Score</th>
                      <th className="text-left p-2 min-w-[130px]">Quantity · Time · Quality</th>
                      <th className="text-right p-2">Kaam (done/total)</th>
                      <th className="text-right p-2">Time pe %</th>
                      <th className="text-right p-2">Late kaam</th>
                      <th className="text-right p-2">Total late</th>
                      <th className="text-left p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(perf.people || []).map((p, i) => {
                      const v = verdict(p.score);
                      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
                      const bar = (val, cls) => (
                        <div className="h-1.5 rounded bg-gray-100 overflow-hidden w-full">
                          <div className={`h-full ${cls}`} style={{ width: `${Math.max(2, val)}%` }} />
                        </div>
                      );
                      const onTimePct = p.completed ? Math.round((p.on_time / p.completed) * 100) : 0;
                      return (
                        <tr key={p.name} className={`border-t ${i === 0 ? 'bg-emerald-50/40' : ''}`}>
                          <td className="p-2 text-sm">{medal}</td>
                          <td className="p-2 font-semibold text-gray-800">{p.name}
                            <div className="text-[9px] font-normal text-gray-400">{p.modules} module{p.modules > 1 ? 's' : ''}</div>
                          </td>
                          <td className={`p-2 text-right text-base font-bold ${p.score >= 80 ? 'text-emerald-600' : p.score >= 60 ? 'text-blue-600' : p.score >= 40 ? 'text-amber-600' : 'text-rose-600'}`}>{p.score}</td>
                          <td className="p-2">
                            <div className="space-y-0.5">
                              {bar(p.quantity_score, 'bg-indigo-400')}
                              {bar(p.time_score, 'bg-emerald-400')}
                              {bar(p.quality_score, 'bg-amber-400')}
                            </div>
                          </td>
                          <td className="p-2 text-right tabular-nums">{p.completed}/{p.owned}</td>
                          <td className={`p-2 text-right font-semibold ${onTimePct >= 80 ? 'text-emerald-600' : onTimePct >= 50 ? 'text-amber-600' : 'text-rose-600'}`}>{onTimePct}%</td>
                          <td className={`p-2 text-right ${p.late ? 'text-rose-600 font-semibold' : 'text-gray-400'}`}>{p.late || '—'}</td>
                          <td className={`p-2 text-right ${p.late_hours ? 'text-rose-600' : 'text-gray-400'}`}>{p.late_hours ? fmtDur(p.late_hours) : '—'}</td>
                          <td className={`p-2 text-[11px] ${v.cls}`}>{v.txt}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      ) : view === 'flow' ? (
        // ── THE FLOW BOARD — every in-flight record × every step, one screen ──
        <div className="overflow-x-auto border rounded-lg bg-white">
          <table className="w-full text-xs border-collapse">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide sticky top-0 z-10">
              <tr>
                <th className="text-left p-2 min-w-[150px]">Record</th>
                {stepDefs.map(sd => (
                  <th key={sd.key} className="p-1.5 border-l border-gray-100 min-w-[96px] text-center">
                    <div className="text-[9px] leading-tight">{sd.label}</div>
                    <div className="text-[9px] font-normal normal-case text-gray-400 leading-tight truncate max-w-[110px] mx-auto">
                      {sd.responsible || '—'}{sd.sla_hours != null ? ` · ${fmtDur(sd.sla_hours)}` : ''}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={1 + stepDefs.length} className="text-center p-8 text-gray-400">
                  {allRows.length === 0
                    ? (showAll ? 'No records.' : 'Nothing in flight right now — tick "incl. completed" to see history.')
                    : 'Nothing matches the current filter.'}
                </td></tr>
              ) : rows.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50/50">
                  <td className="p-2">
                    <button onClick={() => openEditor(r)} className="font-semibold text-gray-800 hover:text-indigo-700 text-left leading-tight">
                      {r.title}
                    </button>
                    <div className="text-[10px] text-gray-500 leading-tight truncate max-w-[150px]">{r.subtitle}</div>
                  </td>
                  {stepDefs.map(sd => <FlowCell key={sd.key} rec={r} step={r.steps.find(s => s.key === sd.key)} />)}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : view === 'summary' ? (
        // ── By-person performance summary ──
        <div className="overflow-x-auto border rounded-lg bg-white">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-gray-500 uppercase tracking-wide">
              <tr>
                <th className="text-left p-2">Person</th>
                <th className="text-right p-2">Steps owned</th>
                <th className="text-right p-2">Avg time / step</th>
                <th className="text-right p-2">Total time</th>
                <th className="text-right p-2">Late steps</th>
                <th className="text-right p-2">Late %</th>
                <th className="text-right p-2">Late hours</th>
              </tr>
            </thead>
            <tbody>
              {summary.length === 0 ? (
                <tr><td colSpan="7" className="text-center p-6 text-gray-400">No responsible assignments yet — use ⚙ Owners &amp; targets.</td></tr>
              ) : summary.map(p => (
                <tr key={p.name} className="border-t">
                  <td className="p-2 font-semibold text-gray-800">{p.name}</td>
                  <td className="p-2 text-right">{p.steps}</td>
                  <td className="p-2 text-right">{fmtDur(p.avg_hours)}</td>
                  <td className="p-2 text-right">{fmtDur(p.total_hours)}</td>
                  <td className={`p-2 text-right font-semibold ${p.late_count ? 'text-rose-600' : 'text-emerald-600'}`}>{p.late_count}</td>
                  <td className={`p-2 text-right ${p.late_pct >= 30 ? 'text-rose-600' : p.late_pct > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{p.late_pct}%</td>
                  <td className="p-2 text-right text-rose-600">{p.late_hours ? fmtDur(p.late_hours) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        // ── Per-record cards (with manual mark-done stamps) ──
        <div className="space-y-2">
          {rows.length === 0 ? (
            <div className="py-10 text-center text-gray-400 text-sm">No records.</div>
          ) : rows.map(r => (
            <div key={r.id} className="border rounded-lg bg-white p-2.5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <div className="min-w-0">
                  <span className="font-semibold text-sm text-gray-800">{r.title}</span>
                  <span className="text-xs text-gray-500"> · {r.subtitle}</span>
                </div>
                <button onClick={() => openEditor(r)}
                  className="shrink-0 text-[11px] font-semibold text-indigo-700 hover:text-white hover:bg-indigo-600 border border-indigo-300 rounded px-2 py-0.5 transition">
                  ⚙ Assign R/A/C/I + time
                </button>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {r.steps.map(s => {
                  const late = s.late_hours > 0;
                  const tint = s.status === 'done' ? 'bg-emerald-50 border-emerald-200'
                    : s.status === 'current' ? (late ? 'bg-rose-50 border-rose-200' : 'bg-amber-50 border-amber-200')
                    : 'bg-gray-50 border-gray-200';
                  return (
                    <div key={s.key} className={`border rounded-md px-2 py-1 text-[11px] min-w-[148px] ${tint}`} title={s.at ? `Completed: ${s.at}` : (s.status === 'current' ? 'In progress' : 'Not started')}>
                      <div className="font-semibold text-gray-700">{s.label}</div>
                      <div className="text-gray-600">
                        {s.responsible
                          ? <span className="text-emerald-700">R: {s.responsible}{s.responsible_default && <span className="text-gray-400 font-normal"> ·owner</span>}</span>
                          : <span className="text-gray-400">unassigned</span>}
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-gray-500">⏱ {fmtDur(s.elapsed_hours)}</span>
                        {s.sla_hours != null && <span className="text-gray-400">/ {fmtDur(s.sla_hours)}</span>}
                        {late && <span className="text-rose-600 font-semibold">⚠ {fmtDur(s.late_hours)} late</span>}
                      </div>
                      <div className="mt-1 pt-1 border-t border-black/5 flex items-center gap-1">
                        {s.done_at ? (
                          <>
                            <span className="text-emerald-700 font-semibold">✓ {String(s.done_at).slice(0, 10)}</span>
                            <button onClick={() => stampStep(r, s, null)} title="Reopen step" className="ml-auto text-gray-400 hover:text-rose-600">✕</button>
                          </>
                        ) : (
                          <>
                            <button onClick={() => stampStep(r, s, todayStr())} className="px-1.5 py-0.5 rounded bg-emerald-600 text-white hover:bg-emerald-700 text-[10px] font-semibold">✓ done</button>
                            <input type="date" onChange={e => e.target.value && stampStep(r, s, e.target.value)} title="or pick the date it was done" className="text-[10px] border border-gray-300 rounded px-1 py-0.5 text-gray-600 w-[110px]" />
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Per-record / whole-module editor */}
      <Modal isOpen={!!editRec} onClose={closeEditor} title={`Responsible & time — ${editRec?.title || ''}`} xwide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Pick the <b>R</b>esponsible / <b>A</b>ccountable / <b>C</b>onsulted / <b>I</b>nformed person, the target time (SLA hours), the <b>Weight %</b> (makes the scorecard step-wise % weighted) and a <b>Commitment</b> for next week — for each step of <b>this</b> record.</p>
          {busy && editSteps.length === 0 ? (
            <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {editSteps.map((s, i) => (
                <div key={s.key} className="border rounded-lg p-3 bg-white">
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-semibold text-sm text-gray-800">{s.label}</div>
                  </div>
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-2">
                    {RACI_FIELDS.map(([field, label, tint]) => (
                      <div key={field}>
                        <label className={`label text-[10px] ${tint}`}>{label}</label>
                        <select className="input text-xs" value={s[field] || ''} onChange={e => setField(i, field, e.target.value ? +e.target.value : null)}>
                          <option value="">— pick —</option>
                          {users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}
                        </select>
                      </div>
                    ))}
                    <div>
                      <label className="label text-[10px] text-rose-600">SLA (hours)</label>
                      <input type="number" min="0" step="any" className="input text-xs" placeholder="e.g. 24" value={s.sla_hours ?? ''} onChange={e => setField(i, 'sla_hours', e.target.value === '' ? '' : +e.target.value)} />
                    </div>
                    <div>
                      <label className="label text-[10px] text-indigo-600">Weight %</label>
                      <input type="number" min="0" step="any" className="input text-xs" placeholder="e.g. 20" value={s.weight ?? ''} onChange={e => setField(i, 'weight', e.target.value === '' ? '' : +e.target.value)} />
                    </div>
                    <div className="col-span-2 sm:col-span-3 lg:col-span-2">
                      <label className="label text-[10px] text-amber-600">Commitment (next wk)</label>
                      <input type="text" className="input text-xs" placeholder="for next week" value={s.commitment ?? ''} onChange={e => setField(i, 'commitment', e.target.value)} />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="flex justify-end items-center gap-2 pt-2 border-t">
            <button onClick={closeEditor} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={busy || editSteps.length === 0} className="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
