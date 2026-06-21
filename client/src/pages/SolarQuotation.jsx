import { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiSave, FiDownload, FiPrinter, FiZap, FiList, FiTrash2 } from 'react-icons/fi';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import { num as fmt, inr } from '../lib/solar/format';
import {
  DEFAULTS, compute, buildBOQ, summarize, computeROI,
  PROJECT_TYPES, MOUNTS, ARRAY_TYPES, typeLabel,
} from '../lib/solar/engine';

const EMPTY_RB = { ui: { panel: {}, inverter: {}, structure: {}, cable: {} }, factors: { mount: {}, array: {}, state: {} }, settings: {}, inverterSizes: [], bos: {}, labour: {} };

export default function SolarQuotation() {
  const [inp, setInp] = useState({ ...DEFAULTS });
  const [rb, setRb] = useState(EMPTY_RB);
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [view, setView] = useState('internal');     // internal | client
  const [tab, setTab] = useState('build');           // build | saved
  const [saved, setSaved] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dealId, setDealId] = useState(null);
  const [params] = useSearchParams();
  const set = (k, val) => setInp((p) => ({ ...p, [k]: val }));

  useEffect(() => {
    api.get('/solar/rate-book').then((r) => setRb({ ...EMPTY_RB, ...r.data })).catch(() => toast.error('Could not load solar rate book'));
    api.get('/leads').then((r) => setLeads(r.data || [])).catch(() => {});
  }, []);

  // Prefill when opened from a funnel deal ("Create Quotation") so the saved
  // quote links back and auto-advances the deal to the Quotation stage.
  useEffect(() => {
    if (params.get('deal')) setDealId(params.get('deal'));
    const u = {};
    if (params.get('client')) u.client = params.get('client');
    if (params.get('kw')) u.kw = params.get('kw');
    if (params.get('conn')) u.conn = params.get('conn');
    if (Object.keys(u).length) setInp((p) => ({ ...p, ...u }));
  }, []); // eslint-disable-line

  // zero-export → net metering not applicable
  useEffect(() => { if (inp.conn === 'zeroexport' && inp.net) set('net', false); }, [inp.conn]); // eslint-disable-line

  const panelMakes = Object.keys(rb.ui.panel);
  const invMakes = Object.keys(rb.ui.inverter);
  const structMakes = Object.keys(rb.ui.structure);
  const cableMakes = Object.keys(rb.ui.cable);
  const battMakes = Object.keys(rb.ui.battery || {});
  const stateNames = Object.keys(rb.factors.state);
  const isBatt = inp.conn === 'offgrid' || inp.conn === 'hybrid';

  const c = useMemo(() => compute(inp, rb), [inp, rb]);
  const lines = useMemo(() => buildBOQ(c, inp, rb), [c, inp, rb]);
  const tot = useMemo(() => summarize(lines, c), [lines, c]);

  const gstPct = parseFloat(inp.gst) || 0;
  const isZE = inp.conn === 'zeroexport';
  const netApplicable = inp.net && !isZE;
  const netchg = netApplicable ? (parseFloat(inp.netchg) || 0) : 0;
  const gstAmt = tot.totSP * gstPct / 100;
  const grand = tot.totSP + gstAmt + netchg;
  const roi = useMemo(() => computeROI(c, grand, inp, rb), [c, grand, inp, rb]);
  const floor = parseFloat(inp.floor) || 0;
  const marginOk = tot.marginPct >= floor;

  const notes = useMemo(() => {
    const out = [];
    if (isZE) out.push('Zero-export system: no power is fed to the grid — export limiter, grid CTs & reverse-power relay included. Net metering not applicable.');
    else out.push(`Net Meter Charge – ${inr(parseFloat(inp.netchg) || 0)} extra & Govt. fees as per actual.`);
    out.push(`GST @ ${gstPct}% excluded; any other Govt. taxes at the time of invoicing excluded.`);
    out.push(`Transportation / Freight charges: ${inp.transport ? 'Included' : 'Extra at actual'} in quotation.`);
    out.push(`Solar panel cleaning system ${inp.clean ? 'included' : 'not included'} in quotation.`);
    out.push('Warranty: Solar panels – 15 yrs manufacturing / 30 yrs performance. Inverter – 10 yrs + 5 yrs extended.');
    out.push(`AMC: Free for first ${parseInt(inp.amcfree) || 0} years; thereafter ${inr(parseFloat(inp.amcfee) || 0)} per annum.`);
    out.push('Payment terms: 25% Advance · 25% before structure delivery · 25% before panel delivery · 20% after pending items · 5% after handover.');
    out.push(`This quotation is valid for ${parseInt(inp.valid) || 0} days from the date of issue.`);
    if (inp.escal) out.push('Solar module & inverter prices are market-linked; rates are subject to revision if the order is not confirmed within the validity period.');
    if (inp.subsidy) out.push('Govt. subsidy (PM Surya Ghar) applicable for eligible residential connections — passed through at actual after sanction.');
    return out;
  }, [inp, gstPct, isZE]);

  const payload = () => ({
    quote_no: inp.quote_no || `SEPL-SOLAR-${String(Math.round(c.kwAC))}-${(saved.length + 1)}`,
    lead_id: leadId || null, client_name: inp.client, address: inp.addr,
    project_type: inp.conn, capacity_kw: c.kwAC, dc_ac_ratio: parseFloat(inp.dcac) || 0,
    panel_make: inp.panelmake, inverter_make: inp.invmake,
    inputs: inp, boq: lines, engineering: c, roi,
    cost: tot.totTPA, margin_pct: tot.marginPct, sell: tot.totSP, sell_per_w: tot.wpRate,
    gst_amt: gstAmt, grand_total: grand,
    capacity_dc_kwp: c.realKWp, deal_id: dealId || null,
  });

  const save = async () => {
    if (!inp.client && !leadId) return toast.error('Pick a Lead or enter a client name');
    setBusy(true);
    try {
      if (currentId) { await api.put(`/solar/quotations/${currentId}`, payload()); toast.success('Quotation updated'); }
      else { const r = await api.post('/solar/quotations', payload()); setCurrentId(r.data.id); toast.success('Quotation saved'); }
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); } finally { setBusy(false); }
  };

  const exportXlsx = async () => {
    try {
      const resp = await api.post('/solar/quotations/export', payload(), { responseType: 'blob' });
      const url = URL.createObjectURL(new Blob([resp.data]));
      const a = document.createElement('a');
      a.href = url; a.download = `solar-quote-${(inp.client || 'quote').replace(/[^a-z0-9]/gi, '_')}.xlsx`;
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { toast.error('Export failed'); }
  };

  const loadSaved = async () => {
    try { const r = await api.get('/solar/quotations'); setSaved(r.data || []); } catch (e) { toast.error('Could not load saved'); }
  };
  useEffect(() => { if (tab === 'saved') loadSaved(); }, [tab]); // eslint-disable-line

  const openSaved = async (id) => {
    try {
      const r = await api.get(`/solar/quotations/${id}`);
      setInp({ ...DEFAULTS, ...(r.data.inputs || {}) });
      setLeadId(r.data.lead_id || ''); setCurrentId(id); setTab('build');
      toast.success('Loaded');
    } catch (e) { toast.error('Could not open'); }
  };
  const delSaved = async (id) => {
    if (!confirm('Delete this quotation?')) return;
    try { await api.delete(`/solar/quotations/${id}`); loadSaved(); if (currentId === id) setCurrentId(null); } catch (e) { toast.error('Delete failed'); }
  };

  // ── small render helpers (closures, not components — keep input focus stable)
  const Tx = (k, label, props = {}) => (
    <label className="block"><span className="label">{label}</span>
      <input className="input-compact w-full" value={inp[k] ?? ''} onChange={(e) => set(k, e.target.value)} {...props} /></label>);
  const Nu = (k, label, props = {}) => Tx(k, label, { type: 'number', ...props });
  const Se = (k, label, opts) => (
    <label className="block"><span className="label">{label}</span>
      <select className="input-compact w-full" value={inp[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
        {opts.map((o) => typeof o === 'string'
          ? <option key={o} value={o}>{o}</option>
          : <option key={o.v} value={o.v}>{o.label}</option>)}
      </select></label>);
  const Ck = (k, label) => (
    <label className="flex items-center gap-2 text-sm mt-1"><input type="checkbox" checked={!!inp[k]} onChange={(e) => set(k, e.target.checked)} disabled={k === 'net' && isZE} /> {label}</label>);

  const Card = ({ label, value, sub, accent }) => (
    <div className="card p-3">
      <p className="text-[10px] text-gray-500 uppercase tracking-wide">{label}</p>
      <p className={`text-xl font-bold ${accent || 'text-gray-800'}`}>{value}</p>
      {sub && <p className="text-[10px]">{sub}</p>}
    </div>);

  const eng = [
    ['Panels', `${c.nPanels} × ${c.wp}Wp`], ['DC:AC', `${fmt(c.dcac, 2)} (${fmt(c.realKWp, 1)} kWp)`],
    ['String design', `${c.perString} mod/string · ${c.nStrings} strings`],
    ['String window', `${c.minSeries}–${c.maxSeries} (Voc-cold ${fmt(c.vocCold, 1)}V)`],
    ['Inverters', Object.entries(c.invSel).map(([k, n]) => `${n}×${k}kW`).join(' + ')],
    ['DC cable', `${c.dcSize} · ${fmt(c.totalDC)} m · VD ${fmt(c.dcVD, 2)}%`],
    ['AC cable', `${c.acRuns} run × 3.5C×300mm² Al · ${fmt(c.totalAC)} m`],
    ['AC current', `${fmt(c.iAC)} A`], ['Earthing', `${c.nPits} pits · ${fmt(c.earthCable)} m`],
    ['Lightning arr.', `${c.nLA} no (≈${fmt(c.footprint)} m²)`], ['MC4 pairs', `${c.nMC4}`],
    ['Spec. yield', `${fmt(c.yieldKwh)} kWh/kWp · PR 0.80`],
  ];
  if (isZE) eng.push(['Export control', 'Zero-export limiter + grid CTs']);
  if (c.isBatt) eng.push(['Battery bank', `${fmt(c.bankKWh)} kWh (usable ${fmt(c.usableKWh)})`]);

  return (
    <div className="space-y-4">
      <style>{`@media print {
        body * { visibility: hidden !important; }
        #solar-print, #solar-print * { visibility: visible !important; }
        #solar-print { position: absolute; left: 0; top: 0; width: 100%; }
      }`}</style>

      {/* Header */}
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiSun className="text-amber-500" /> Solar Quotation
            <span className="badge badge-blue">AI Auto-BOQ</span></h1>
          <p className="text-xs text-gray-500">Enter system size + site → the engine builds the full BOQ, sizing & throughput margin in one go.</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={() => setTab('build')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'build' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}>Build</button>
          <button onClick={() => setTab('saved')} className={`px-4 py-2 rounded-full text-sm font-semibold border ${tab === 'saved' ? 'bg-blue-800 text-white border-blue-800' : 'bg-white text-gray-600 border-gray-200'}`}><FiList className="inline mr-1" />Saved</button>
        </div>
      </div>

      {tab === 'saved' ? (
        <div className="card p-4">
          <table className="w-full text-sm">
            <thead><tr className="bg-gray-50 text-left text-[10px] uppercase text-gray-500">
              <th className="p-2">Quote</th><th className="p-2">Client</th><th className="p-2">Type</th>
              <th className="p-2 text-right">kW</th><th className="p-2 text-right">Sell ₹</th><th className="p-2 text-right">Margin</th><th className="p-2">Updated</th><th></th></tr></thead>
            <tbody>
              {saved.map((s) => (
                <tr key={s.id} className="border-t hover:bg-blue-50/40 cursor-pointer" onClick={() => openSaved(s.id)}>
                  <td className="p-2 font-medium">{s.quote_no}</td><td className="p-2">{s.client_name}</td>
                  <td className="p-2">{typeLabel(s.project_type)}</td><td className="p-2 text-right">{fmt(s.capacity_kw)}</td>
                  <td className="p-2 text-right">{inr(s.sell)}</td><td className="p-2 text-right text-emerald-600">{fmt(s.margin_pct, 1)}%</td>
                  <td className="p-2 text-gray-500">{(s.updated_at || '').slice(0, 10)}</td>
                  <td className="p-2"><button onClick={(e) => { e.stopPropagation(); delSaved(s.id); }} className="text-red-500"><FiTrash2 size={14} /></button></td>
                </tr>))}
              {!saved.length && <tr><td colSpan={8} className="p-6 text-center text-gray-400">No saved solar quotations yet.</td></tr>}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
        {/* INPUTS */}
        <div className="space-y-3 no-print">
          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">1 · Site &amp; client</p>
            <label className="block"><span className="label">Lead (Sales Funnel)</span>
              <SearchableSelect options={leads} value={leadId} displayKey="company_name" valueKey="id"
                placeholder="Pick a lead…" onChange={(o) => { setLeadId(o?.id || ''); if (o) set('client', o.company_name || o.client_name || ''); }} /></label>
            <div className="grid grid-cols-2 gap-2">
              {Tx('client', 'Client name')}
              {Tx('addr', 'Address')}
              {Se('state', 'State', stateNames.length ? stateNames : [inp.state])}
              {Se('conn', 'Connection', PROJECT_TYPES)}
              {Se('mount', 'Mounting', MOUNTS)}
              {Nu('area', 'Shadow-free area (m²)')}
              {Nu('wind', 'Design wind (m/s)')}
              {Nu('dist', 'Site distance (km)')}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">2 · Sizing</p>
            <div className="grid grid-cols-2 gap-2">
              {Nu('kw', 'Capacity (kW AC)')}{Nu('dcac', 'DC : AC ratio', { step: '0.01' })}
              {Nu('wp', 'Panel (Wp)')}{Tx('ptype', 'Panel type')}
              {Nu('voc', 'Voc (V)', { step: '0.1' })}{Nu('vmp', 'Vmp (V)', { step: '0.1' })}
              {Nu('imp', 'Imp (A)', { step: '0.1' })}{Nu('tc', 'Voc temp-coef %/°C', { step: '0.01' })}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">2b · Equipment make &amp; grade <span className="text-rose-500 normal-case font-normal">(drives rate)</span></p>
            <div className="grid grid-cols-2 gap-2">
              {Se('panelmake', 'Panel make', panelMakes.length ? panelMakes : [inp.panelmake])}
              {Se('dcr', 'Cell content', [{ v: '0', label: 'Non-DCR (import cell)' }, { v: '1', label: 'DCR (domestic)' }])}
              {Se('invmake', 'Inverter make', invMakes.length ? invMakes : [inp.invmake])}
              {Se('structmake', 'Structure / galv.', structMakes.length ? structMakes : [inp.structmake])}
              {Se('cablemake', 'Cable make', cableMakes.length ? cableMakes : [inp.cablemake])}
              {Se('tracker', 'Array type', ARRAY_TYPES)}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">3 · BOS &amp; electrical</p>
            <div className="grid grid-cols-2 gap-2">
              {Nu('vdc', 'Inverter max DC (V)')}{Nu('mppt', 'MPPT min (V)')}
              {Nu('dcrun', 'DC run one-way (m)')}{Nu('acrun', 'AC run (m)')}
              {Nu('dcvd', 'DC volt-drop %', { step: '0.1' })}{Nu('acvd', 'AC volt-drop %', { step: '0.1' })}
            </div>
            <div className="grid grid-cols-2 gap-1">{Ck('dg', 'DG synchronization')}{Ck('rms', 'RMS monitoring')}{Ck('clean', 'Cleaning system')}{Ck('net', 'Net metering')}</div>
          </div>

          {isBatt && (
            <div className="card p-4 space-y-3 ring-1 ring-amber-200">
              <p className="font-bold text-[11px] uppercase tracking-wide text-amber-700">🔋 Battery sizing ({inp.conn === 'offgrid' ? 'off-grid' : 'hybrid'})</p>
              <div className="grid grid-cols-2 gap-2">
                {Nu('backupkw', 'Backup load (kW)')}{Nu('backuphrs', 'Backup hours')}
                {Nu('dod', 'Depth of discharge %')}
                {inp.conn === 'offgrid' && Nu('autonomy', 'Autonomy (days)')}
                {Se('batterytype', 'Battery type', battMakes.length ? battMakes : ['Li-ion LFP', 'Lead-acid Tubular'])}
              </div>
            </div>
          )}

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">4 · Commercials &amp; throughput margin</p>
            <div className="grid grid-cols-2 gap-2">
              {Nu('margin', 'Target margin %', { step: '0.5' })}{Nu('floor', 'Min-margin floor %', { step: '0.5' })}
              {Nu('gst', 'GST %', { step: '0.1' })}{Nu('netchg', 'Net-meter charge ₹')}
              {Nu('cont', 'Contingency %', { step: '0.5' })}{Nu('tariff', 'Grid tariff ₹/unit (ROI)')}
              {Nu('valid', 'Quote validity (days)')}{Nu('amcfree', 'AMC free years')}
              {Nu('amcfee', 'AMC after, ₹/yr')}
            </div>
            <div className="grid grid-cols-2 gap-1">{Ck('transport', 'Transport included')}{Ck('escal', 'Price-escalation clause')}{Ck('subsidy', 'Apply subsidy line')}{Ck('scope', 'Scope list on client quote')}</div>
          </div>
        </div>

        {/* OUTPUT */}
        <div className="space-y-4">
          {/* actions */}
          <div className="flex items-center justify-between gap-2 flex-wrap no-print">
            <div className="flex gap-2">
              <button onClick={() => setView('internal')} className={`px-3 py-2 rounded-full text-xs font-semibold border ${view === 'internal' ? 'bg-white text-gray-700 border-gray-200' : 'bg-white text-gray-400 border-gray-100'}`}>Internal (our rates)</button>
              <button onClick={() => setView('client')} className={`px-3 py-2 rounded-full text-xs font-semibold border ${view === 'client' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-gray-400 border-gray-100'}`}>Client (lumpsum)</button>
            </div>
            <div className="flex gap-2">
              <button onClick={() => window.print()} className="btn btn-secondary text-sm flex items-center gap-1"><FiPrinter size={14} /> Print</button>
              <button onClick={exportXlsx} className="btn btn-secondary text-sm flex items-center gap-1"><FiDownload size={14} /> Excel</button>
              <button onClick={save} disabled={busy} className="btn btn-primary text-sm flex items-center gap-1"><FiSave size={14} /> {currentId ? 'Update' : 'Save'}</button>
            </div>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 no-print">
            <Card label="System (DC)" value={`${fmt(c.realKWp, 1)} kWp`} />
            <Card label="Sell ₹/watt · ₹/kW" value={`₹${fmt(tot.wpRate, 2)}`} sub={`₹${fmt(tot.kwRate, 0)}/kW`} accent="text-indigo-700" />
            <div className={`card p-3 ${marginOk ? '' : 'ring-2 ring-rose-400'}`}>
              <p className="text-[10px] text-gray-500 uppercase tracking-wide">Throughput margin</p>
              <p className={`text-xl font-bold ${marginOk ? 'text-gray-800' : 'text-rose-600'}`}>{fmt(tot.marginPct, 1)}%</p>
              <p className={`text-[10px] ${marginOk ? 'text-emerald-600' : 'text-rose-600 font-bold'}`}>{marginOk ? `✓ above floor ${floor}%` : `⚠ BELOW floor ${floor}%`}</p>
            </div>
            <Card label="Annual yield" value={`${fmt(c.annual, 0)} MWh`} accent="text-emerald-600" />
          </div>

          {/* ROI */}
          <div className="card p-4 no-print">
            <p className="font-semibold text-sm mb-2">📈 Client value &amp; ROI</p>
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-xs">
              {[['Annual generation', `${fmt(roi.annualKWh, 0)} kWh`], ['Annual bill savings', `₹${fmt(roi.annualSav, 0)}`],
                ['Payback', `${fmt(roi.payback, 1)} yrs`], ['25-yr savings', `₹${fmt(roi.sav25 / 1e7, 2)} Cr`], ['CO₂ offset', `${fmt(roi.co2, 0)} t/yr`]]
                .map(([k, v]) => <div key={k} className="border rounded-lg p-2"><p className="text-[10px] text-gray-400 uppercase">{k}</p><p className="font-semibold">{v}</p></div>)}
            </div>
          </div>

          {/* Engineering */}
          <div className="card p-4 no-print">
            <p className="font-semibold text-sm mb-2">🔧 Engineering design (auto-sized)</p>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 text-xs">
              {eng.map(([k, v]) => <div key={k} className="border rounded-lg p-2"><p className="text-[10px] text-gray-400 uppercase">{k}</p><p className="font-semibold">{v}</p></div>)}
            </div>
          </div>

          {/* PRINTABLE QUOTE */}
          <div id="solar-print" className="card p-0 overflow-hidden">
            <div className="px-5 pt-5 pb-3 border-b flex items-start justify-between">
              <div>
                <h3 className="text-base font-bold">QUOTATION FOR {fmt(c.kwAC)} KW {typeLabel(inp.conn)} SOLAR SYSTEM</h3>
                <p className="text-xs text-gray-500">{inp.client || '—'} · {inp.addr || '—'}</p>
              </div>
              <div className="text-right text-xs text-gray-600">
                <p className="font-bold text-blue-900">Secured Engineers India</p>
                <p>Base: ₹{fmt(tot.wpRate, 2)}/watt · ₹{fmt(tot.kwRate, 0)}/kW (ex-GST)</p>
              </div>
            </div>

            {view === 'internal' ? (
              <div>
                <div className="px-5 pt-3 text-[11px] text-rose-600 font-semibold no-print">● INTERNAL working sheet — our purchase rates &amp; throughput margin. Never sent to client.</div>
                <div className="p-4 overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead><tr className="bg-gray-50 text-left text-gray-600">
                      <th className="p-2">S.No</th><th className="p-2 min-w-[200px]">Description</th><th className="p-2">Unit</th>
                      <th className="p-2 text-right">Qty</th><th className="p-2 text-right">Purch ₹/u</th><th className="p-2 text-right">PP ₹</th>
                      <th className="p-2 text-right">TPA ₹</th><th className="p-2 text-right">Margin</th><th className="p-2 text-right">SP ₹</th><th className="p-2 text-right">Rate ₹</th></tr></thead>
                    <tbody>
                      {lines.map((l, i) => (
                        <tr key={i} className="border-t">
                          <td className="p-2">{i + 1}</td><td className="p-2">{l.desc}</td><td className="p-2">{l.unit}</td>
                          <td className="p-2 text-right">{fmt(l.qty)}</td><td className="p-2 text-right text-rose-600">{inr(l.ppUnit, 1)}</td>
                          <td className="p-2 text-right text-gray-600">{inr(l.pp)}</td><td className="p-2 text-right text-gray-500">{inr(l.tpa)}</td>
                          <td className="p-2 text-right text-emerald-700">{fmt(l.tpa ? (l.sp - l.tpa) / l.tpa * 100 : 0, 1)}%</td>
                          <td className="p-2 text-right font-semibold">{inr(l.sp)}</td><td className="p-2 text-right">{inr(l.rate, 1)}</td>
                        </tr>))}
                    </tbody>
                    <tfoot><tr className="bg-gray-50 font-semibold border-t-2">
                      <td className="p-2" colSpan={4}>TOTAL (ex-GST)</td><td></td>
                      <td className="p-2 text-right text-rose-700">{inr(tot.totPP)}</td><td className="p-2 text-right text-gray-600">{inr(tot.totTPA)}</td>
                      <td className="p-2 text-right text-emerald-700">{fmt(tot.marginPct, 1)}%</td><td className="p-2 text-right text-blue-900">{inr(tot.totSP)}</td>
                      <td className="p-2 text-right">₹{fmt(tot.wpRate, 2)}/W</td></tr></tfoot>
                  </table>
                </div>
                <div className="px-5 pb-4">
                  <div className="bg-gray-50 rounded-lg p-3 text-xs grid grid-cols-2 md:grid-cols-5 gap-2">
                    <div><p className="text-gray-500">Our cost (TPA)</p><p className="font-bold text-rose-600">{inr(tot.totTPA)}</p></div>
                    <div><p className="text-gray-500">Base sell (ex-GST)</p><p className="font-bold">{inr(tot.totSP)}</p></div>
                    <div><p className="text-gray-500">Throughput margin</p><p className={`font-bold ${marginOk ? 'text-emerald-700' : 'text-rose-600'}`}>{fmt(tot.marginPct, 1)}% · {inr(tot.totSP - tot.totTPA)}</p></div>
                    <div><p className="text-gray-500">GST @ {gstPct}%</p><p className="font-bold">{inr(gstAmt)}</p></div>
                    <div><p className="text-gray-500">Grand total</p><p className="font-bold text-blue-900">{inr(grand)}</p></div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="p-5">
                <div className="px-0 pb-2 text-[11px] text-emerald-600 font-semibold no-print">● CLIENT quotation — lumpsum per-kW price only. No rates, no breakup.</div>
                <table className="w-full text-sm mb-5">
                  <thead><tr className="border-b-2 text-left text-gray-600"><th className="p-2 w-12">S.No</th><th className="p-2">Description</th><th className="p-2 text-right">Amount (₹)</th></tr></thead>
                  <tbody>
                    <tr className="border-b"><td className="p-2 align-top">1</td>
                      <td className="p-2 font-semibold">{fmt(c.kwAC)} kW {typeLabel(inp.conn)} Solar Power Plant — supply, installation, testing &amp; commissioning (turnkey)</td>
                      <td className="p-2 text-right font-bold align-top">{inr(tot.totSP)}</td></tr>
                    <tr className="text-gray-600"><td></td><td className="p-2">Base price (ex-GST)</td><td className="p-2 text-right">₹{fmt(tot.wpRate, 2)}/watt · ₹{fmt(tot.kwRate, 0)}/kW</td></tr>
                    <tr className="text-gray-600"><td></td><td className="p-2">GST @ {gstPct}%</td><td className="p-2 text-right">{inr(gstAmt)}</td></tr>
                    {netApplicable && <tr className="text-gray-600"><td></td><td className="p-2">Net-meter charge (extra, at actual)</td><td className="p-2 text-right">{inr(netchg)}</td></tr>}
                    <tr className="border-t-2 font-bold text-blue-900"><td></td><td className="p-2">Grand total (incl GST)</td><td className="p-2 text-right">{inr(grand)}</td></tr>
                  </tbody>
                </table>
                <div className="mb-4 p-3 bg-emerald-50 rounded-lg">
                  <p className="font-bold text-xs mb-1 text-emerald-800">Your savings at a glance</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div><p className="text-gray-500">Annual generation</p><p className="font-bold">{fmt(roi.annualKWh, 0)} kWh</p></div>
                    <div><p className="text-gray-500">Annual bill savings</p><p className="font-bold text-emerald-700">₹{fmt(roi.annualSav, 0)}</p></div>
                    <div><p className="text-gray-500">Payback period</p><p className="font-bold">{fmt(roi.payback, 1)} yrs</p></div>
                    <div><p className="text-gray-500">Lifetime (25-yr) savings</p><p className="font-bold text-emerald-700">₹{fmt(roi.sav25 / 1e7, 2)} Cr</p></div>
                  </div>
                </div>
                {inp.scope && (
                  <div>
                    <p className="font-bold text-xs mb-1">Scope of supply (indicative — prices not itemised):</p>
                    <div className="text-[11px] text-gray-600" style={{ columnCount: 2, columnGap: '1.5rem' }}>
                      {lines.map((l, i) => <div key={i} className="mb-0.5">• {l.desc} — {l.make} ({fmt(l.qty)} {l.unit})</div>)}
                    </div>
                  </div>)}
              </div>
            )}

            <div className="px-5 pb-5 text-xs text-gray-700">
              <p className="font-bold">Notes:</p>
              <ol className="list-decimal ml-5 space-y-0.5">{notes.map((nn, i) => <li key={i}>{nn}</li>)}</ol>
            </div>
          </div>
        </div>
      </div>
      )}
    </div>
  );
}
