import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { FiSun, FiX, FiAlertTriangle, FiCheckCircle, FiTrash2, FiTool, FiPlus, FiFileText, FiCalendar } from 'react-icons/fi';
import api from '../api';
import { num as fmt, inr } from '../lib/solar/format';

const COMPONENT_CATEGORIES = ['panel', 'inverter', 'battery', 'structure', 'monitoring', 'other'];
const DISCOM_STAGES = [
  { v: 'not_started', label: 'Not started' }, { v: 'applied', label: 'Application filed' },
  { v: 'inspection_scheduled', label: 'Inspection scheduled' }, { v: 'inspection_done', label: 'Inspection done' },
  { v: 'approved', label: 'Approved' }, { v: 'meter_installed', label: 'Net-meter installed' },
];

const cr = (v) => `₹${fmt((v || 0) / 1e7, 2)} Cr`;

export default function SolarProjects() {
  const [stages, setStages] = useState([]);
  const [projects, setProjects] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [tab, setTab] = useState('pipeline');
  const [modal, setModal] = useState(null);

  const load = () => {
    api.get('/solar/projects').then((r) => setProjects(r.data || [])).catch(() => toast.error('Could not load projects'));
    api.get('/solar/projects/stats/analytics').then((r) => setAnalytics(r.data)).catch(() => {});
  };
  useEffect(() => { api.get('/solar/projects/config').then((r) => setStages(r.data.stages || [])); load(); }, []); // eslint-disable-line

  const byStage = useMemo(() => {
    const m = {}; stages.forEach((s) => (m[s.key] = []));
    projects.forEach((p) => { (m[p.stage] = m[p.stage] || []).push(p); });
    return m;
  }, [projects, stages]);

  const move = async (p, stage) => { if (stage === p.stage) return; try { await api.post(`/solar/projects/${p.id}/move`, { stage }); load(); } catch { toast.error('Move failed'); } };
  const open = (id) => api.get(`/solar/projects/${id}`).then((r) => setModal(r.data));
  const T = analytics?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTool className="text-amber-600" /> Solar Projects — Execution &amp; AMC</h1>
          <p className="text-xs text-gray-500">Every won deal from Order → Design/Approvals → Procurement → Installation → Commissioning → Handover → AMC, with payment milestones and stuck-stage alerts.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setTab('pipeline')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'pipeline' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Pipeline</button>
          <button onClick={() => setTab('cash')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'cash' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Cash &amp; Stages</button>
        </div>
      </div>

      {T && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Active projects</p><p className="text-xl font-bold">{T.active}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Order value</p><p className="text-xl font-bold text-indigo-700">{cr(T.value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Cash collected</p><p className="text-xl font-bold text-emerald-600">{cr(T.collected)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Cash pending</p><p className="text-xl font-bold text-amber-600">{cr(T.pending)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Stuck (constraint)</p><p className={`text-xl font-bold ${T.stuck ? 'text-rose-600' : ''}`}>{T.stuck}</p></div>
        </div>
      )}

      {analytics?.amcDue?.length > 0 && (
        <div className="card p-3 border-l-4 border-amber-400 bg-amber-50/50 text-xs">
          <p className="font-bold text-amber-700 flex items-center gap-1 mb-1"><FiAlertTriangle size={13} /> {analytics.amcDue.length} AMC service(s) due within 30 days</p>
          <div className="flex flex-wrap gap-2">{analytics.amcDue.map((a) => <button key={a.id} onClick={() => open(a.id)} className="bg-white border border-amber-200 rounded-full px-2 py-1 hover:bg-amber-100">{a.project_no} · {a.client_name} — due {a.amc_next_due}</button>)}</div>
        </div>
      )}

      {tab === 'pipeline' ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {stages.map((s) => (
              <div key={s.key} className="w-64 flex-shrink-0">
                <div className="rounded-t-lg bg-blue-900 text-white px-3 py-2 flex items-center justify-between">
                  <span className="text-xs font-semibold">{s.label}</span><span className="text-[10px] bg-white/20 rounded-full px-2">{(byStage[s.key] || []).length}</span>
                </div>
                <div className="bg-gray-50 rounded-b-lg p-2 space-y-2 min-h-[120px]">
                  {(byStage[s.key] || []).map((p) => (
                    <div key={p.id} className={`bg-white rounded-lg border p-2 shadow-sm cursor-pointer ${p.stuck ? 'border-rose-300 ring-1 ring-rose-200' : ''}`} onClick={() => open(p.id)}>
                      <div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-blue-900">{p.project_no}</span>{p.stuck && <FiAlertTriangle className="text-rose-500" size={12} />}</div>
                      <p className="text-xs font-medium truncate">{p.client_name}</p>
                      <p className="text-[10px] text-gray-500">{fmt(p.capacity_kw)} kW · {inr(p.value)}</p>
                      <p className="text-[10px] mt-0.5"><span className="text-emerald-600">{inr(p.collected)}</span> <span className="text-gray-400">/ {inr(p.pending)} due</span></p>
                      {p.next_action && <p className="text-[10px] text-gray-600 mt-1 truncate">→ {p.next_action}</p>}
                      <select onClick={(e) => e.stopPropagation()} onChange={(e) => move(p, e.target.value)} value={p.stage} className="text-[9px] border rounded px-1 py-0.5 bg-white mt-1 w-full">
                        {stages.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                      </select>
                    </div>))}
                  {!(byStage[s.key] || []).length && <p className="text-[10px] text-gray-300 text-center py-4">—</p>}
                </div>
              </div>))}
          </div>
        </div>
      ) : (
        <div className="card p-4">
          <p className="font-semibold text-sm mb-3">Order value by stage · cash position</p>
          <div className="space-y-1.5 mb-4">
            {(analytics?.byStage || []).map((s) => {
              const max = Math.max(...(analytics.byStage.map((x) => x.value)), 1);
              return (
                <div key={s.key} className="flex items-center gap-3 text-xs">
                  <div className="w-36 text-right text-gray-600">{s.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-6"><div className="h-6 bg-blue-700/80 rounded flex items-center px-2 text-white text-[11px]" style={{ width: `${Math.max(4, s.value / max * 100)}%` }}>{s.count}</div></div>
                  <div className="w-28 text-right text-gray-600">{cr(s.value)}</div>
                </div>);
            })}
          </div>
          {T && (
            <div className="flex gap-4 text-xs border-t pt-3">
              <div>Collected <b className="text-emerald-600">{cr(T.collected)}</b></div>
              <div>Pending <b className="text-amber-600">{cr(T.pending)}</b></div>
              <div className="flex-1 bg-gray-100 rounded h-4 self-center max-w-md"><div className="h-4 bg-emerald-500 rounded" style={{ width: `${T.value ? T.collected / T.value * 100 : 0}%` }} /></div>
            </div>)}
        </div>
      )}

      {modal && <ProjectModal project={modal} stages={stages} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} reopen={open} />}
    </div>
  );
}

function ProjectModal({ project, stages, onClose, onSaved, reopen }) {
  const [p, setP] = useState({ ...project });
  const [mtab, setMtab] = useState('overview');
  const ms = p.milestones || [];
  const cl = p.checklist || [];

  const saveField = async (patch) => { try { await api.put(`/solar/projects/${p.id}`, patch); setP((x) => ({ ...x, ...patch })); } catch { toast.error('Save failed'); } };
  const toggleMs = async (i) => {
    const next = ms.map((m, idx) => idx === i ? { ...m, status: m.status === 'collected' ? 'pending' : 'collected', collected_on: m.status === 'collected' ? null : new Date().toISOString().slice(0, 10) } : m);
    await saveField({ milestones: next });
  };
  const toggleCl = async (i) => { const next = cl.map((c, idx) => idx === i ? { ...c, done: !c.done } : c); await saveField({ checklist: next }); };
  const move = async (stage) => { try { await api.post(`/solar/projects/${p.id}/move`, { stage }); toast.success('Moved'); onSaved(); } catch { toast.error('Move failed'); } };
  const del = async () => { if (!confirm('Delete this project?')) return; try { await api.delete(`/solar/projects/${p.id}`); onSaved(); } catch { toast.error('Failed'); } };
  const collected = ms.filter((m) => m.status === 'collected').reduce((a, m) => a + (m.amount || 0), 0);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-3xl my-8">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-bold">{p.project_no} · {p.client_name} <span className="text-xs font-normal text-gray-500">· {fmt(p.capacity_kw)} kW · {inr(p.value)}</span></h3>
          <button onClick={onClose}><FiX /></button>
        </div>
        <div className="px-5 pt-3 flex gap-1.5 border-b overflow-x-auto">
          {[['overview', 'Overview'], ['components', 'Components'], ['amc', 'AMC Visits'], ['discom', 'DISCOM']].map(([k, l]) => (
            <button key={k} onClick={() => setMtab(k)} className={`text-xs px-3 py-1.5 rounded-t-md font-semibold whitespace-nowrap ${mtab === k ? 'bg-blue-800 text-white' : 'bg-gray-100 text-gray-600'}`}>{l}</button>
          ))}
        </div>
        <div className="p-5 space-y-4 max-h-[65vh] overflow-y-auto">
          {mtab === 'overview' && (<>
          <div className="flex flex-wrap items-center gap-2">
            <span className="label">Stage:</span>
            {stages.map((s) => <button key={s.key} onClick={() => move(s.key)} className={`text-[11px] px-2 py-1 rounded border ${s.key === p.stage ? 'bg-blue-800 text-white border-blue-800' : 'bg-white border-gray-200'}`}>{s.label}</button>)}
          </div>

          <div>
            <p className="font-semibold text-xs mb-1">Payment milestones — collected {inr(collected)} / {inr(p.value)}</p>
            <table className="w-full text-xs">
              <tbody>{ms.map((m, i) => (
                <tr key={i} className="border-t">
                  <td className="p-1">{m.label} <span className="text-gray-400">({m.pct}%)</span></td>
                  <td className="p-1 text-right">{inr(m.amount)}</td>
                  <td className="p-1 text-right w-28">
                    <button onClick={() => toggleMs(i)} className={`px-2 py-0.5 rounded text-[11px] ${m.status === 'collected' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>
                      {m.status === 'collected' ? `✓ ${m.collected_on || ''}` : 'Mark collected'}</button>
                  </td>
                </tr>))}</tbody>
            </table>
          </div>

          <div>
            <p className="font-semibold text-xs mb-1">Execution checklist</p>
            <div className="grid md:grid-cols-2 gap-x-4 gap-y-0.5 text-xs">
              {cl.map((c, i) => (
                <label key={i} className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={!!c.done} onChange={() => toggleCl(i)} />
                  <span className={c.done ? 'line-through text-gray-400' : ''}>{c.item}</span>
                  <span className="text-[9px] text-gray-300 ml-auto">{c.stage}</span>
                </label>))}
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs border-t pt-3">
            <label className="block"><span className="label">AMC annual fee ₹</span><input className="input-compact w-full" type="number" defaultValue={p.amc_annual_fee} onBlur={(e) => saveField({ amc_annual_fee: e.target.value })} /></label>
            <label className="block"><span className="label">AMC free until</span><input className="input-compact w-full" type="date" defaultValue={(p.amc_free_until || '').slice(0, 10)} onBlur={(e) => saveField({ amc_free_until: e.target.value })} /></label>
            <label className="block"><span className="label">AMC next due</span><input className="input-compact w-full" type="date" defaultValue={(p.amc_next_due || '').slice(0, 10)} onBlur={(e) => saveField({ amc_next_due: e.target.value })} /></label>
            <label className="block"><span className="label">Target handover</span><input className="input-compact w-full" type="date" defaultValue={(p.target_handover || '').slice(0, 10)} onBlur={(e) => saveField({ target_handover: e.target.value })} /></label>
          </div>

          {p.events?.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-gray-500">Activity ({p.events.length})</summary>
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">{p.events.map((e) => <li key={e.id} className="text-gray-600">• <b>{e.type}</b> {e.from_stage ? `${e.from_stage}→${e.to_stage}` : (e.to_stage || '')} {e.note ? `· ${e.note}` : ''} <span className="text-gray-400">— {(e.created_at || '').slice(0, 16)} {e.by_name || ''}</span></li>)}</ul></details>)}
          </>)}

          {mtab === 'components' && <ComponentsTab projectId={p.id} />}
          {mtab === 'amc' && <AmcVisitsTab projectId={p.id} />}
          {mtab === 'discom' && <DiscomTab p={p} saveField={saveField} />}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <button onClick={del} className="text-sm text-gray-400"><FiTrash2 size={14} /></button>
          <button onClick={onClose} className="btn btn-primary text-sm">Done</button>
        </div>
      </div>
    </div>);
}

const EMPTY_COMPONENT = { category: 'panel', make: '', model: '', rating: '', serial_no: '', qty: 1, install_date: '', warranty_years: '' };

function ComponentsTab({ projectId }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState(EMPTY_COMPONENT);
  const [adding, setAdding] = useState(false);
  const load = () => api.get(`/solar/projects/${projectId}/components`).then((r) => setRows(r.data || [])).catch(() => toast.error('Could not load components'));
  useEffect(() => { load(); }, [projectId]); // eslint-disable-line

  const add = async () => {
    if (!form.make) return toast.error('Make is required');
    try { await api.post(`/solar/projects/${projectId}/components`, form); setForm(EMPTY_COMPONENT); setAdding(false); load(); toast.success('Added'); }
    catch { toast.error('Save failed'); }
  };
  const del = async (id) => { try { await api.delete(`/solar/components/${id}`); load(); } catch { toast.error('Delete failed'); } };

  const warrantyBadge = (till) => {
    if (!till) return null;
    const days = (new Date(till) - new Date()) / 86400000;
    if (days < 0) return <span className="text-red-600">expired {till}</span>;
    if (days < 90) return <span className="text-amber-600">{till} (soon)</span>;
    return <span className="text-emerald-700">{till}</span>;
  };

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-gray-500">Serial numbers &amp; warranty per installed component — for future OEM claims. Panels are usually one bulk row (qty = count); inverters/batteries are worth entering per serial.</p>
      <table className="w-full text-xs">
        <thead><tr className="bg-gray-50 text-left text-gray-500 uppercase text-[10px]">
          <th className="p-1.5">Category</th><th className="p-1.5">Make / Model</th><th className="p-1.5">Rating</th>
          <th className="p-1.5">Serial</th><th className="p-1.5 text-right">Qty</th><th className="p-1.5">Installed</th><th className="p-1.5">Warranty till</th><th></th>
        </tr></thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.id} className="border-t">
              <td className="p-1.5 capitalize">{c.category}</td>
              <td className="p-1.5">{c.make} {c.model && <span className="text-gray-400">· {c.model}</span>}</td>
              <td className="p-1.5">{c.rating}</td>
              <td className="p-1.5 font-mono text-[10px]">{c.serial_no || '—'}</td>
              <td className="p-1.5 text-right">{c.qty}</td>
              <td className="p-1.5">{c.install_date || '—'}</td>
              <td className="p-1.5">{warrantyBadge(c.warranty_till) || '—'}</td>
              <td className="p-1.5"><button onClick={() => del(c.id)} className="text-red-400"><FiTrash2 size={12} /></button></td>
            </tr>))}
          {!rows.length && <tr><td colSpan={8} className="p-4 text-center text-gray-300">No components recorded yet.</td></tr>}
        </tbody>
      </table>

      {adding ? (
        <div className="border rounded-lg p-3 bg-gray-50 grid grid-cols-2 md:grid-cols-4 gap-2">
          <label className="block"><span className="label">Category</span>
            <select className="input-compact w-full" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {COMPONENT_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          <label className="block"><span className="label">Make</span><input className="input-compact w-full" value={form.make} onChange={(e) => setForm({ ...form, make: e.target.value })} /></label>
          <label className="block"><span className="label">Model</span><input className="input-compact w-full" value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} /></label>
          <label className="block"><span className="label">Rating (e.g. 550 Wp)</span><input className="input-compact w-full" value={form.rating} onChange={(e) => setForm({ ...form, rating: e.target.value })} /></label>
          <label className="block"><span className="label">Serial no (blank = bulk)</span><input className="input-compact w-full" value={form.serial_no} onChange={(e) => setForm({ ...form, serial_no: e.target.value })} /></label>
          <label className="block"><span className="label">Qty</span><input type="number" className="input-compact w-full" value={form.qty} onChange={(e) => setForm({ ...form, qty: e.target.value })} /></label>
          <label className="block"><span className="label">Install date</span><input type="date" className="input-compact w-full" value={form.install_date} onChange={(e) => setForm({ ...form, install_date: e.target.value })} /></label>
          <label className="block"><span className="label">Warranty (years)</span><input type="number" step="0.5" className="input-compact w-full" value={form.warranty_years} onChange={(e) => setForm({ ...form, warranty_years: e.target.value })} /></label>
          <div className="col-span-2 md:col-span-4 flex gap-2">
            <button onClick={add} className="btn btn-primary text-xs">Add component</button>
            <button onClick={() => { setAdding(false); setForm(EMPTY_COMPONENT); }} className="btn btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={13} /> Add component</button>
      )}
    </div>
  );
}

function AmcVisitsTab({ projectId }) {
  const [rows, setRows] = useState([]);
  const [gen, setGen] = useState({ start_date: new Date().toISOString().slice(0, 10), frequency: 'half-yearly', years: 5 });
  const load = () => api.get(`/solar/projects/${projectId}/amc-visits`).then((r) => setRows(r.data || [])).catch(() => toast.error('Could not load AMC visits'));
  useEffect(() => { load(); }, [projectId]); // eslint-disable-line

  const generate = async () => {
    try { const { data } = await api.post(`/solar/projects/${projectId}/amc-visits/generate`, gen); toast.success(`${data.created} visit(s) scheduled`); load(); }
    catch { toast.error('Could not generate schedule'); }
  };
  const complete = async (id) => { try { await api.put(`/solar/amc-visits/${id}`, { status: 'completed', completed_date: new Date().toISOString().slice(0, 10) }); load(); } catch { toast.error('Failed'); } };
  const toggleItem = async (visit, i) => {
    const next = visit.checklist.map((c, idx) => idx === i ? { ...c, done: !c.done } : c);
    try { await api.put(`/solar/amc-visits/${visit.id}`, { checklist: next }); load(); } catch { toast.error('Failed'); }
  };
  const del = async (id) => { try { await api.delete(`/solar/amc-visits/${id}`); load(); } catch { toast.error('Delete failed'); } };

  const today = new Date().toISOString().slice(0, 10);
  return (
    <div className="space-y-3">
      {!rows.length && (
        <div className="border rounded-lg p-3 bg-gray-50 grid grid-cols-2 md:grid-cols-4 gap-2 items-end">
          <label className="block"><span className="label">Start date</span><input type="date" className="input-compact w-full" value={gen.start_date} onChange={(e) => setGen({ ...gen, start_date: e.target.value })} /></label>
          <label className="block"><span className="label">Frequency</span>
            <select className="input-compact w-full" value={gen.frequency} onChange={(e) => setGen({ ...gen, frequency: e.target.value })}>
              <option value="quarterly">Quarterly</option><option value="half-yearly">Half-yearly</option><option value="annual">Annual</option>
            </select></label>
          <label className="block"><span className="label">For how many years</span><input type="number" className="input-compact w-full" value={gen.years} onChange={(e) => setGen({ ...gen, years: e.target.value })} /></label>
          <button onClick={generate} className="btn btn-primary text-xs flex items-center gap-1"><FiCalendar size={13} /> Generate schedule</button>
        </div>
      )}
      <div className="space-y-2">
        {rows.map((v) => {
          const done = (v.checklist || []).filter((c) => c.done).length;
          const overdue = v.status === 'scheduled' && v.scheduled_date < today;
          return (
            <div key={v.id} className={`border rounded-lg p-2.5 ${overdue ? 'border-rose-300 bg-rose-50/40' : v.status === 'completed' ? 'bg-emerald-50/40' : ''}`}>
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold">{v.scheduled_date}</span>
                  <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-600 capitalize">{v.visit_type}</span>
                  {v.status === 'completed'
                    ? <span className="text-[10px] text-emerald-700 flex items-center gap-1"><FiCheckCircle size={11} /> Completed {v.completed_date}</span>
                    : overdue ? <span className="text-[10px] text-rose-600 font-semibold">Overdue</span> : <span className="text-[10px] text-gray-400">{done}/{(v.checklist || []).length} checked</span>}
                </div>
                <div className="flex gap-2">
                  {v.status !== 'completed' && <button onClick={() => complete(v.id)} className="text-[11px] text-emerald-700">Mark complete</button>}
                  <button onClick={() => del(v.id)} className="text-red-400"><FiTrash2 size={12} /></button>
                </div>
              </div>
              {v.status !== 'completed' && (v.checklist || []).length > 0 && (
                <div className="grid md:grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] mt-2 pt-2 border-t">
                  {v.checklist.map((c, i) => (
                    <label key={i} className="flex items-center gap-2 cursor-pointer">
                      <input type="checkbox" checked={!!c.done} onChange={() => toggleItem(v, i)} />
                      <span className={c.done ? 'line-through text-gray-400' : ''}>{c.item}</span>
                    </label>))}
                </div>
              )}
            </div>
          );
        })}
        {!rows.length && <p className="text-center text-gray-300 text-xs py-4">No AMC visits scheduled yet — generate a schedule above.</p>}
      </div>
    </div>
  );
}

function DiscomTab({ p, saveField }) {
  const idx = DISCOM_STAGES.findIndex((s) => s.v === (p.discom_status || 'not_started'));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-1">
        {DISCOM_STAGES.map((s, i) => (
          <button key={s.v} onClick={() => saveField({ discom_status: s.v })}
            className={`text-[10px] px-2 py-1 rounded-full whitespace-nowrap ${i <= idx ? 'bg-blue-800 text-white' : 'bg-gray-100 text-gray-500'}`}>
            {i < idx ? '✓ ' : ''}{s.label}
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs">
        <label className="block"><span className="label">Consumer / account no.</span><input className="input-compact w-full" defaultValue={p.discom_consumer_no || ''} onBlur={(e) => saveField({ discom_consumer_no: e.target.value })} /></label>
        <label className="block"><span className="label">Application ref no.</span><input className="input-compact w-full" defaultValue={p.discom_application_ref || ''} onBlur={(e) => saveField({ discom_application_ref: e.target.value })} /></label>
        <label className="block"><span className="label">Application filed on</span><input type="date" className="input-compact w-full" defaultValue={(p.discom_application_date || '').slice(0, 10)} onBlur={(e) => saveField({ discom_application_date: e.target.value })} /></label>
        <label className="block"><span className="label">Inspection date</span><input type="date" className="input-compact w-full" defaultValue={(p.discom_inspection_date || '').slice(0, 10)} onBlur={(e) => saveField({ discom_inspection_date: e.target.value })} /></label>
        <label className="block"><span className="label">Approval date</span><input type="date" className="input-compact w-full" defaultValue={(p.discom_approval_date || '').slice(0, 10)} onBlur={(e) => saveField({ discom_approval_date: e.target.value })} /></label>
        <label className="block"><span className="label">Net-meter installed on</span><input type="date" className="input-compact w-full" defaultValue={(p.net_meter_installed_date || '').slice(0, 10)} onBlur={(e) => saveField({ net_meter_installed_date: e.target.value })} /></label>
      </div>
      <label className="block"><span className="label">Notes</span><textarea className="input-compact w-full" rows={2} defaultValue={p.discom_notes || ''} onBlur={(e) => saveField({ discom_notes: e.target.value })} /></label>
      <button onClick={() => window.open(`/solar-projects/${p.id}/net-metering-print`, '_blank')} className="btn btn-secondary text-xs flex items-center gap-1">
        <FiFileText size={13} /> Net-metering application summary
      </button>
      <p className="text-[10px] text-gray-400">A summary of the technical details DISCOM applications ask for — not an official state form. No Indian DISCOM exposes a public submission API, so this stays a status tracker, not automation.</p>
    </div>
  );
}
