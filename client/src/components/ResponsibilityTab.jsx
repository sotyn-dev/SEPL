// Reusable "Responsible" tab — drop <ResponsibilityTab module="crm_funnel" />
// into any module page to get the per-record RACI + SLA time-tracking board
// (mam 2026-06-27). Per step you pick Responsible / Accountable / Consulted /
// Informed + the target time (SLA hours); the board shows the actual time each
// step took and who ran late, plus a By-Person performance summary. Backed by
// /api/raci/board/:module + /api/raci/record/:module/:id (shared engine).
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

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
  const { isAdmin } = useAuth();
  const [data, setData] = useState(null);
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);

  // L2 (second) approval on/off — the switch now lives ONLY on the "Indent L2
  // Approval" step inside the ⚙ editor (it writes app_settings.indent_l2_enabled
  // via /raci/record). Here we just READ the current state to show a read-only
  // note in the header banner (mam 2026-07-22: parent screen = note only, no
  // button). We re-read on editor close so the note stays fresh.
  const isIndent = module === 'indent_to_dispatch';
  const [l2Enabled, setL2Enabled] = useState(false);
  const fetchL2 = useCallback(() => {
    if (!isIndent) return;
    api.get('/procurement/l2-setting').then(r => setL2Enabled(!!r.data?.enabled)).catch(() => {});
  }, [isIndent]);
  useEffect(() => { fetchL2(); }, [fetchL2]);
  const [view, setView] = useState('grid');         // 'grid' | 'summary'
  const [q, setQ] = useState('');
  // The per-record board loads ALL records × steps — heavy enough to hang big
  // modules on the small VPS (mam 2026-06-29: "per enquiry no need to show — it
  // takes data and hangs; only need Set RACI for whole module"). So it's now
  // opt-in: the tab opens straight to the whole-module RACI setter and the board
  // loads only when the user clicks "Show per-record board".
  const [showBoard, setShowBoard] = useState(false);

  // Editor modal
  const [editRec, setEditRec] = useState(null);      // record being edited
  const [editSteps, setEditSteps] = useState([]);
  const [busy, setBusy] = useState(false);

  // Users for the R/A/C/I dropdowns — light; always loaded so the whole-module
  // editor works without pulling the heavy board.
  useEffect(() => {
    api.get('/auth/users').then(u => setUsers((u.data || []).filter(x => x.active !== 0))).catch(() => {});
  }, []);

  // Heavy per-record board — loaded only on demand (see showBoard note above).
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const b = await api.get(`/raci/board/${module}`);
      setData(b.data);
      setShowBoard(true);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not load the Responsible board');
    } finally { setLoading(false); }
  }, [module]);

  const openEditor = async (rec) => {
    setEditRec(rec); setBusy(true);
    try {
      const cfg = await api.get(`/raci/record/${module}/${rec.id}`);
      setEditSteps(cfg.data.steps || []);
    } catch { toast.error('Could not load RACI for this record'); }
    finally { setBusy(false); }
  };
  // Close the editor and refresh the header L2 note (it may have been flipped on
  // the "Indent L2 Approval" step inside the modal).
  const closeEditor = () => { setEditRec(null); fetchL2(); };
  const setField = (i, k, v) => setEditSteps(s => s.map((x, idx) => idx === i ? { ...x, [k]: v } : x));
  // Indent approver guard rails (mam 2026-07-21/22). In the indent whole-module
  // editor: l1/l2/crm are gate steps (admin-only). L1 is a mandatory gate but it
  // falls back to the user tagged Indent Approval Role = L1 (approval_role='l1'),
  // so it's only "missing" when NEITHER an explicit name NOR that default exists.
  const isIndentDefault = module === 'indent_to_dispatch' && editRec?.id === 0;
  const GATE_KEYS = ['l1', 'l2', 'crm'];
  const l1Resp = editSteps.find(s => s.key === 'l1')?.responsible_id || null;
  const l2Resp = editSteps.find(s => s.key === 'l2')?.responsible_id || null;
  // Default L1/L2 approvers derived from the already-loaded users list — each
  // carries approval_role (GET /auth/users). No extra fetch; mirrors the server's
  // getL1Approver/getL2Approver fallback.
  const defaultL1 = users.find(u => u.approval_role === 'l1') || null;
  const defaultL2 = users.find(u => u.approval_role === 'l2') || null;
  const l1ApproverOk = !!l1Resp || !!defaultL1;       // explicit pick OR seeded default
  const l2ApproverOk = !!l2Resp || !!defaultL2;
  const l1Missing = isIndentDefault && !l1ApproverOk; // no L1 approver anywhere → block save
  const gateLocked = isIndentDefault && !isAdmin();   // non-admin: gate rows read-only

  const save = async () => {
    if (!editRec) return;
    if (l1Missing) { toast.error("Set an L1 approver — pick a Responsible, or set a user's Indent Approval Role = L1 in User Management."); return; }
    setBusy(true);
    try {
      await api.put(`/raci/record/${module}/${editRec.id}`, {
        // Non-admins can't change the gate steps — drop them from the payload so
        // a normal RACI edit on other steps isn't rejected.
        steps: editSteps.filter(s => !(gateLocked && GATE_KEYS.includes(s.key))).map(s => ({
          step_key: s.key,
          responsible_id: s.responsible_id || null, accountable_id: s.accountable_id || null,
          consulted_id: s.consulted_id || null, informed_id: s.informed_id || null,
          sla_hours: s.sla_hours === '' || s.sla_hours == null ? null : +s.sla_hours,
          weight: s.weight === '' || s.weight == null ? null : +s.weight,
          commitment: s.commitment && String(s.commitment).trim() !== '' ? s.commitment : null,
          enabled: s.enabled !== false,   // per-step ON/OFF (mam 2026-07-21)
        })),
      });
      toast.success('Saved'); closeEditor(); if (showBoard) load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  // Quick "mark done" (or reopen) for one step — stamps the completion date the
  // scoring view uses for elapsed/late time. value = 'YYYY-MM-DD' to set, null to
  // reopen. This is the "time" half of mam's "person name + time" per step.
  const stampStep = async (rec, step, value) => {
    try {
      await api.put(`/raci/step-done/${module}/${rec.id}`, { step_key: step.key, done_at: value || null });
      toast.success(value ? `${step.label} marked done` : `${step.label} reopened`);
      if (showBoard) load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not update the step'); }
  };
  const todayStr = () => { const d = new Date(), p = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };

  const rows = (data?.rows || []).filter(r => {
    if (!q.trim()) return true;
    const s = (r.title + ' ' + (r.subtitle || '')).toLowerCase();
    return s.includes(q.trim().toLowerCase());
  });
  const summary = data?.summary || [];

  return (
    <div className="space-y-3">
      {/* L2 (second) approval status — read-only note (mam 2026-07-22: parent
          screen shows a note only, no button). The actual ON/OFF lives on the
          "Indent L2 Approval" step inside ⚙ Set RACI for whole module. */}
      {isIndent && isAdmin() && (
        <div className="flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          <span className={`shrink-0 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold border ${l2Enabled ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-100 text-slate-500 border-slate-300'}`}>
            <span className={`inline-block w-2 h-2 rounded-full ${l2Enabled ? 'bg-emerald-500' : 'bg-slate-400'}`} />
            L2 {l2Enabled ? 'ON' : 'OFF'}
          </span>
          <div className="text-xs text-slate-600">
            {l2Enabled
              ? 'Indents need L1 then L2 sign-off. Change this on the “Indent L2 Approval” step in ⚙ Set RACI for whole module.'
              : 'L1 is the final approval (no second sign-off). Turn L2 on from the “Indent L2 Approval” step in ⚙ Set RACI for whole module.'}
          </div>
        </div>
      )}
      {/* Header / controls */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-gray-800">{title || data?.label || 'Responsible'} — who owns each step & how long it took</h3>
          <p className="text-[11px] text-gray-500">Assign R / A / C / I + target time per step on each record. Red = ran past the target (late).</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Set RACI ONCE for the whole module (default for every record, mam
              2026-06-27: "whole module raci one"). Each record inherits it unless
              it has its own override. Stored under record_id 0. */}
          <button
            onClick={() => openEditor({ id: 0, title: 'Whole module — default for all records' })}
            className="text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 rounded px-2.5 h-8">
            ⚙ Set RACI for whole module
          </button>
          {!showBoard ? (
            <button onClick={load} disabled={loading} className="btn btn-secondary h-8 text-xs">
              {loading ? 'Loading…' : 'Show per-record board'}
            </button>
          ) : (
            <>
              <input className="input text-xs h-8 w-44" placeholder="Search…" value={q} onChange={e => setQ(e.target.value)} />
              <div className="flex rounded-lg overflow-hidden border border-gray-300 text-xs">
                <button onClick={() => setView('grid')} className={`px-3 py-1.5 ${view === 'grid' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>Per record</button>
                <button onClick={() => setView('summary')} className={`px-3 py-1.5 ${view === 'summary' ? 'bg-indigo-600 text-white' : 'bg-white text-gray-600'}`}>By person</button>
              </div>
              <button onClick={load} className="btn btn-secondary h-8 text-xs">↻</button>
            </>
          )}
        </div>
      </div>

      {!showBoard ? (
        <div className="py-8 px-4 text-center text-gray-500 text-sm border rounded-lg bg-white">
          Use <b>⚙ Set RACI for whole module</b> to assign Responsible / Accountable / Consulted / Informed, SLA, weight &amp; commitment once — it applies to every record.
          <div className="text-xs text-gray-400 mt-1">The per-record list is hidden for speed. Click <b>Show per-record board</b> above only if you need to assign or mark steps on individual records.</div>
        </div>
      ) : loading && !data ? (
        <div className="py-12 text-center text-gray-400 text-sm">Loading…</div>
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
                <tr><td colSpan="7" className="text-center p-6 text-gray-400">No responsible assignments yet. Assign people per step in the “Per record” view.</td></tr>
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
        // ── Per-record grid ──
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
                    : s.status === 'current' ? 'bg-amber-50 border-amber-200'
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
                      {/* Mark-done date — the "time" half of person + time, fed to scoring.
                          Works even for steps with no native date (e.g. Negotiation). */}
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

      {/* Per-record editor */}
      <Modal isOpen={!!editRec} onClose={closeEditor} title={`Responsible & time — ${editRec?.title || ''}`} xwide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Pick the <b>R</b>esponsible / <b>A</b>ccountable / <b>C</b>onsulted / <b>I</b>nformed person, the target time (SLA hours), the <b>Weight %</b> (makes the scorecard step-wise % weighted) and a <b>Commitment</b> for next week — for each step of <b>this</b> record.</p>
          {busy && editSteps.length === 0 ? (
            <div className="py-8 text-center text-gray-400 text-sm">Loading…</div>
          ) : (
            <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
              {editSteps.map((s, i) => {
                const stepOn = s.enabled !== false;
                // Gate steps (indent l1/l2/crm) are admin-only.
                const isGate = isIndentDefault && GATE_KEYS.includes(s.key);
                const readOnlyGate = gateLocked && isGate;
                // Indent L2 switch is blocked until BOTH L1 and L2 have an approver
                // (explicit name or the seeded Indent Approval Role default) — the
                // server enforces the same in /raci/record.
                const l2ToggleBlocked = isIndentDefault && s.key === 'l2' && !(l1ApproverOk && l2ApproverOk);
                // Indent L1 — mandatory gate. Empty is fine IF a default approver
                // (approval_role='l1' user) exists; only "hard missing" when neither.
                const l1Empty = isIndentDefault && s.key === 'l1' && !s.responsible_id;
                const l1HardMissing = l1Empty && !defaultL1;
                return (
                <div key={s.key} className={`border rounded-lg p-3 bg-white ${l1HardMissing ? 'ring-1 ring-rose-300' : ''}`}>
                  <div className="flex items-center justify-between gap-2 mb-2">
                    <div className="font-semibold text-sm text-gray-800">
                      {s.label}
                      {isIndentDefault && !stepOn && <span className="ml-2 text-[10px] font-normal text-rose-500">(OFF — skipped in flow)</span>}
                      {readOnlyGate && <span className="ml-2 text-[10px] font-normal text-gray-400">(admin only)</span>}
                    </div>
                    {/* Per-step control is INDENT-ONLY (the reporting toggle was
                        retired elsewhere, mam 2026-07-22). L2 = real workflow ON/OFF
                        switch; L1 = static "always on" tag; CRM's switch lives in the
                        card's bottom row; the other 6 have none. Non-indent modules
                        have no per-step toggle at all. */}
                    {isIndentDefault && (
                      s.key === 'l2' ? (
                        <button type="button" disabled={readOnlyGate || l2ToggleBlocked} onClick={() => !(readOnlyGate || l2ToggleBlocked) && setField(i, 'enabled', !stepOn)}
                          title={readOnlyGate ? 'Only an admin can change this' : (l2ToggleBlocked ? 'Set the Indent L1 and L2 approvers first (a name here, or the Indent Approval Role in User Management)' : 'Turn L2 (second) approval on/off — OFF skips it in the real flow')}
                          className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border transition disabled:opacity-40 disabled:cursor-not-allowed ${stepOn ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-100'}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${stepOn ? 'bg-white' : 'bg-slate-400'}`} />
                          {stepOn ? 'ON' : 'OFF'}
                        </button>
                      ) : s.key === 'l1' ? (
                        <span title="L1 is mandatory — always on" className="shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border bg-slate-100 text-slate-500 border-slate-300">
                          Required · always on
                        </span>
                      ) : null
                    )}
                  </div>
                  {l1Empty && (defaultL1
                    ? <div className="text-[11px] text-slate-500 mb-2">Defaults to <b>{defaultL1.name}</b> — set via Admin → User Management → Indent Approval Role. Pick a name here to override.</div>
                    : <div className="text-[11px] text-rose-600 font-medium mb-2">Set an L1 approver — pick a Responsible below, or set a user's Indent Approval Role = L1 in Admin → User Management.</div>
                  )}
                  <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-8 gap-2">
                    {RACI_FIELDS.map(([field, label, tint]) => (
                      <div key={field}>
                        <label className={`label text-[10px] ${tint}`}>{label}</label>
                        <select className="input text-xs" disabled={readOnlyGate && field === 'responsible_id'} value={s[field] || ''} onChange={e => setField(i, field, e.target.value ? +e.target.value : null)}>
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
                  {/* CRM (billable) — Responsible is scorecard credit only (the real
                      approval gate is anyone with CRM access / the Client-PO CRM
                      person), and the stage's ON/OFF bypass sits here in its own
                      row, decoupled from the name. mam 2026-07-22. */}
                  {isIndentDefault && s.key === 'crm' && (
                    <>
                      <div className="text-[11px] text-slate-500 mt-2">
                        Responsible here = <b>scorecard credit only</b>. CRM approval is done by anyone with CRM access, or the CRM person on the Client PO — not necessarily this name.
                      </div>
                      <div className="mt-2 pt-2 border-t border-black/5 flex items-center justify-between gap-2">
                        <div className="text-[11px] text-slate-600">
                          <span className="font-semibold text-slate-800">CRM approval stage</span> — billable Extra indents route through CRM first; OFF skips it (billable line won't be auto-created).
                        </div>
                        <button type="button" disabled={readOnlyGate} onClick={() => !readOnlyGate && setField(i, 'enabled', !stepOn)}
                          title={readOnlyGate ? 'Only an admin can change this' : 'Turn the CRM approval stage on/off — OFF skips it in the real approval flow'}
                          className={`shrink-0 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold border transition disabled:opacity-40 disabled:cursor-not-allowed ${stepOn ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700' : 'bg-white text-slate-500 border-slate-300 hover:bg-slate-100'}`}>
                          <span className={`inline-block w-1.5 h-1.5 rounded-full ${stepOn ? 'bg-white' : 'bg-slate-400'}`} />
                          {stepOn ? 'ON' : 'OFF'}
                        </button>
                      </div>
                    </>
                  )}
                </div>
                );
              })}
            </div>
          )}
          <div className="flex justify-end items-center gap-2 pt-2 border-t">
            {l1Missing && <span className="text-[11px] text-rose-600 mr-auto">Set an L1 approver (a name here, or Indent Approval Role = L1 in User Management) to save.</span>}
            <button onClick={closeEditor} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={busy || editSteps.length === 0 || l1Missing} className="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
