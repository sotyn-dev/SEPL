import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiPlus, FiX, FiTrendingUp, FiAlertTriangle, FiFileText, FiTrash2 } from 'react-icons/fi';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import SearchableSelect from '../components/SearchableSelect';
import { num as fmt, inr } from '../lib/solar/format';
import { PROJECT_TYPES } from '../lib/solar/engine';

const cr = (v) => `₹${fmt((v || 0) / 1e7, 2)} Cr`;

export default function SolarFunnel() {
  const { user } = useAuth();
  const nav = useNavigate();
  const [stages, setStages] = useState([]);
  const [deals, setDeals] = useState([]);
  const [analytics, setAnalytics] = useState(null);
  const [leads, setLeads] = useState([]);
  const [tab, setTab] = useState('pipeline');
  const [modal, setModal] = useState(null); // null | {} (new) | deal (edit)

  const load = () => {
    api.get('/solar/deals').then((r) => setDeals(r.data || [])).catch(() => toast.error('Could not load deals'));
    api.get('/solar/funnel/analytics').then((r) => setAnalytics(r.data)).catch(() => {});
  };
  useEffect(() => {
    api.get('/solar/funnel/config').then((r) => setStages(r.data.stages || [])).catch(() => {});
    api.get('/leads').then((r) => setLeads(r.data || [])).catch(() => {});
    load();
  }, []); // eslint-disable-line

  const byStage = useMemo(() => {
    const m = {}; stages.forEach((s) => (m[s.key] = []));
    deals.forEach((d) => { (m[d.stage] = m[d.stage] || []).push(d); });
    return m;
  }, [deals, stages]);
  const conv = useMemo(() => {
    const m = {}; (analytics?.byStage || []).forEach((s) => (m[s.key] = s)); return m;
  }, [analytics]);

  const move = async (deal, stage) => {
    if (stage === deal.stage) return;
    try { await api.post(`/solar/deals/${deal.id}/move`, { stage }); load(); } catch { toast.error('Move failed'); }
  };

  const T = analytics?.totals;

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Sales Funnel</h1>
          <p className="text-xs text-gray-500">Every solar opportunity, stage by stage — with conversion, next actions and stuck-deal alerts driving each step.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('pipeline')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'pipeline' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Pipeline</button>
          <button onClick={() => setTab('analytics')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'analytics' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}><FiTrendingUp className="inline mr-1" />Conversion</button>
          <button onClick={() => setModal({ owner_name: user?.name || '', stage: 'inquiry', project_type: 'ongrid' })} className="btn btn-primary text-sm flex items-center gap-1"><FiPlus size={14} /> New Deal</button>
        </div>
      </div>

      {/* KPI strip */}
      {T && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Open deals</p><p className="text-xl font-bold">{T.open}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Open pipeline</p><p className="text-xl font-bold text-indigo-700">{cr(T.open_value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Won</p><p className="text-xl font-bold text-emerald-600">{T.won} · {cr(T.won_value)}</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Overall conversion</p><p className="text-xl font-bold">{T.overall_conversion}%</p></div>
          <div className="card p-3"><p className="text-[10px] text-gray-500 uppercase">Lost</p><p className="text-xl font-bold text-rose-500">{T.lost}</p></div>
        </div>
      )}

      {/* Stuck alerts */}
      {analytics?.stuck?.length > 0 && (
        <div className="card p-3 border-l-4 border-rose-400 bg-rose-50/50">
          <p className="text-xs font-bold text-rose-700 flex items-center gap-1 mb-1"><FiAlertTriangle size={13} /> {analytics.stuck.length} deal(s) stuck past their stage SLA — act now to keep them converting</p>
          <div className="flex flex-wrap gap-2">
            {analytics.stuck.map((s) => (
              <button key={s.id} onClick={() => api.get(`/solar/deals/${s.id}`).then((r) => setModal(r.data))} className="text-[11px] bg-white border border-rose-200 rounded-full px-2 py-1 hover:bg-rose-100">
                {s.deal_no} · {s.client_name} — {s.stage_label} · <b>{s.days_in_stage}d</b> (SLA {s.sla}d)</button>))}
          </div>
        </div>
      )}

      {tab === 'pipeline' ? (
        <div className="overflow-x-auto pb-2">
          <div className="flex gap-3 min-w-max">
            {stages.map((s) => {
              const list = byStage[s.key] || [];
              const stat = conv[s.key] || {};
              return (
                <div key={s.key} className="w-64 flex-shrink-0">
                  <div className="rounded-t-lg bg-blue-900 text-white px-3 py-2">
                    <div className="flex items-center justify-between"><span className="text-xs font-semibold">{s.label}</span><span className="text-[10px] bg-white/20 rounded-full px-2">{list.length}</span></div>
                    <div className="flex items-center justify-between text-[10px] text-blue-200 mt-0.5">
                      <span>{cr(stat.value)}</span><span>conv {stat.conversion ?? '—'}%</span></div>
                  </div>
                  <div className="bg-gray-50 rounded-b-lg p-2 space-y-2 min-h-[120px]">
                    {list.map((d) => (
                      <div key={d.id} className={`bg-white rounded-lg border p-2 shadow-sm cursor-pointer ${d.stuck ? 'border-rose-300 ring-1 ring-rose-200' : ''}`}
                        onClick={() => api.get(`/solar/deals/${d.id}`).then((r) => setModal(r.data))}>
                        <div className="flex items-center justify-between">
                          <span className="text-[11px] font-semibold text-blue-900">{d.deal_no}</span>
                          {d.stuck && <FiAlertTriangle className="text-rose-500" size={12} />}
                        </div>
                        <p className="text-xs font-medium truncate">{d.client_name || '—'}</p>
                        <p className="text-[10px] text-gray-500">{fmt(d.capacity_kw)} kW · {inr(d.value)}</p>
                        {d.next_action && <p className="text-[10px] text-gray-600 mt-1 truncate">→ {d.next_action}</p>}
                        <div className="flex items-center justify-between mt-1">
                          <span className="text-[9px] text-gray-400">{d.owner_name || ''}</span>
                          <select onClick={(e) => e.stopPropagation()} onChange={(e) => move(d, e.target.value)} value={d.stage}
                            className="text-[9px] border rounded px-1 py-0.5 bg-white">
                            {stages.map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}
                          </select>
                        </div>
                      </div>))}
                    {!list.length && <p className="text-[10px] text-gray-300 text-center py-4">—</p>}
                  </div>
                </div>);
            })}
          </div>
        </div>
      ) : (
        <div className="card p-4">
          <p className="font-semibold text-sm mb-3">Conversion funnel</p>
          <div className="space-y-1.5">
            {(analytics?.byStage || []).map((s, i) => {
              const max = analytics.byStage[0]?.reached || 1;
              return (
                <div key={s.key} className="flex items-center gap-3 text-xs">
                  <div className="w-32 text-right text-gray-600">{s.label}</div>
                  <div className="flex-1 bg-gray-100 rounded h-6 relative overflow-hidden">
                    <div className="h-6 bg-blue-700/80 rounded flex items-center px-2 text-white text-[11px]" style={{ width: `${Math.max(6, s.reached / max * 100)}%` }}>{s.reached}</div>
                  </div>
                  <div className="w-16 text-center">{i === 0 ? '—' : <span className={s.conversion < 50 ? 'text-rose-600 font-semibold' : 'text-emerald-600'}>{s.conversion}%</span>}</div>
                  <div className="w-20 text-gray-400">drop {s.dropoff}</div>
                  <div className="w-20 text-gray-400">{s.avg_days}d avg</div>
                  <div className="w-24 text-right text-gray-600">{cr(s.value)}</div>
                </div>);
            })}
          </div>
          <p className="text-[10px] text-gray-400 mt-3">Conversion = % of deals that reached the previous stage which advanced to this one. Drop = deals lost between stages. Avg-days = time deals currently sit in each stage.</p>
        </div>
      )}

      {modal && <DealModal deal={modal} stages={stages} leads={leads} user={user} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} nav={nav} />}
    </div>
  );
}

function DealModal({ deal, stages, leads, user, onClose, onSaved, nav }) {
  const [d, setD] = useState({ ...deal });
  const isNew = !deal.id;
  const set = (k, v) => setD((p) => ({ ...p, [k]: v }));
  const F = (k, label, props = {}) => (
    <label className="block"><span className="label">{label}</span>
      <input className="input-compact w-full" value={d[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} /></label>);

  const save = async () => {
    if (!d.client_name) return toast.error('Client name required');
    try {
      if (isNew) await api.post('/solar/deals', d);
      else await api.put(`/solar/deals/${d.id}`, d);
      toast.success('Saved'); onSaved();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };
  const move = async (stage) => { try { await api.post(`/solar/deals/${d.id}/move`, { stage }); toast.success('Moved'); onSaved(); } catch { toast.error('Move failed'); } };
  const lose = async () => { const reason = prompt('Reason for losing this deal?'); if (reason === null) return; try { await api.post(`/solar/deals/${d.id}/lose`, { reason }); toast.success('Marked lost'); onSaved(); } catch { toast.error('Failed'); } };
  const del = async () => { if (!confirm('Delete this deal?')) return; try { await api.delete(`/solar/deals/${d.id}`); onSaved(); } catch { toast.error('Failed'); } };
  const toQuote = () => nav(`/solar-quotation?deal=${d.id}&client=${encodeURIComponent(d.client_name || '')}&kw=${d.capacity_kw || ''}&conn=${d.project_type || 'ongrid'}`);

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-start justify-center overflow-y-auto p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8">
        <div className="px-5 py-3 border-b flex items-center justify-between">
          <h3 className="font-bold">{isNew ? 'New Solar Deal' : `${deal.deal_no} · ${deal.client_name}`}</h3>
          <button onClick={onClose}><FiX /></button>
        </div>
        <div className="p-5 space-y-3">
          {isNew && (
            <label className="block"><span className="label">From Lead (optional)</span>
              <SearchableSelect options={leads} value={d.lead_id || ''} displayKey="company_name" valueKey="id" placeholder="Pick a lead…"
                onChange={(o) => o && setD((p) => ({ ...p, lead_id: o.id, client_name: o.company_name || o.client_name || p.client_name, company: o.company_name || p.company, phone: o.phone || p.phone, location: o.district || o.location || p.location, state: o.state || p.state }))} /></label>)}
          <div className="grid grid-cols-2 gap-2">
            {F('client_name', 'Client name')}{F('company', 'Company')}
            {F('phone', 'Phone')}{F('location', 'Location')}
            {F('state', 'State')}{F('capacity_kw', 'Capacity (kW)', { type: 'number' })}
            <label className="block"><span className="label">Project type</span>
              <select className="input-compact w-full" value={d.project_type || 'ongrid'} onChange={(e) => set('project_type', e.target.value)}>
                {PROJECT_TYPES.map((o) => <option key={o.v} value={o.v}>{o.label}</option>)}</select></label>
            {F('value', 'Deal value ₹', { type: 'number' })}
            {F('owner_name', 'Owner')}{F('source', 'Source')}
            {F('next_action', 'Next action')}{F('next_action_due', 'Next action due', { type: 'date' })}
          </div>

          {!isNew && (
            <div className="flex flex-wrap items-center gap-2 pt-1">
              <span className="label">Move to:</span>
              {stages.map((s) => <button key={s.key} onClick={() => move(s.key)} className={`text-[11px] px-2 py-1 rounded border ${s.key === d.stage ? 'bg-blue-800 text-white border-blue-800' : 'bg-white border-gray-200'}`}>{s.label}</button>)}
            </div>)}

          {!isNew && deal.events?.length > 0 && (
            <details className="text-xs"><summary className="cursor-pointer text-gray-500">Activity ({deal.events.length})</summary>
              <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                {deal.events.map((e) => <li key={e.id} className="text-gray-600">• <b>{e.type}</b> {e.from_stage ? `${e.from_stage}→${e.to_stage}` : (e.to_stage || '')} {e.note ? `· ${e.note}` : ''} <span className="text-gray-400">— {(e.created_at || '').slice(0, 16)} {e.by_name || ''}</span></li>)}
              </ul></details>)}
        </div>
        <div className="px-5 py-3 border-t flex items-center justify-between">
          <div className="flex gap-2">
            {!isNew && <button onClick={toQuote} className="btn btn-secondary text-sm flex items-center gap-1"><FiFileText size={14} /> Create Quotation</button>}
            {!isNew && <button onClick={lose} className="text-sm text-rose-600">Mark Lost</button>}
            {!isNew && <button onClick={del} className="text-sm text-gray-400"><FiTrash2 size={14} /></button>}
          </div>
          <div className="flex gap-2">
            <button onClick={onClose} className="btn btn-secondary text-sm">Cancel</button>
            <button onClick={save} className="btn btn-primary text-sm">Save</button>
          </div>
        </div>
      </div>
    </div>);
}
