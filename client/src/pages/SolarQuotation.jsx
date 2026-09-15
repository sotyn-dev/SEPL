import { useEffect, useMemo, useState, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import toast from 'react-hot-toast';
import { FiSun, FiSave, FiDownload, FiPrinter, FiZap, FiList, FiTrash2, FiFileText, FiShoppingCart } from 'react-icons/fi';
import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid } from 'recharts';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import { exportCsv } from '../utils/exportCsv';
import { num as fmt, inr } from '../lib/solar/format';

// 25-year cumulative-savings curve for the ROI chart. Uses the SAME 0.8%/yr
// degradation engine.js's computeROI() assumes for `sav25`, then scales so
// the chart's year-25 total lands exactly on the already-displayed sav25
// figure — the visual and the headline number must never quietly disagree.
// No live monitoring feed exists (that's explicitly out of scope) — this is
// the modelled projection, same as the number it's illustrating.
function buildSavingsSeries(annualSav, netCost, sav25) {
  if (!(annualSav > 0)) return [];
  let raw = 0;
  const factors = Array.from({ length: 25 }, (_, i) => { const f = Math.pow(1 - 0.008, i); raw += f; return f; });
  const scale = sav25 > 0 ? sav25 / (annualSav * raw) : 1;
  let cum = 0;
  return factors.map((f, i) => {
    cum += annualSav * f * scale;
    return { year: i + 1, cumulative: Math.round(cum), netCost: Math.round(netCost || 0) };
  });
}
import {
  DEFAULTS, compute, buildBOQ, groupBOQ, summarize, computeROI, computeFinance,
  PROJECT_TYPES, MOUNTS, ARRAY_TYPES, PROPERTY_TYPES, typeLabel,
} from '../lib/solar/engine';
import { STATES } from '../data/indiaLocations';
import { useUrlTab } from '../hooks/useUrlTab';

const EMPTY_RB = { ui: { panel: {}, inverter: {}, structure: {}, cable: {} }, factors: { mount: {}, array: {}, state: {} }, settings: {}, inverterSizes: [], bos: {}, labour: {} };

// Roof/mount surface label for the quotation title ("… System on RCC Roof").
const surfLabel = (m) => ({ ground: 'Ground', rcc: 'RCC Roof', tin: 'Tin Shed', carport: 'Carport', floating: 'Floating' }[m] || 'RCC Roof');

export default function SolarQuotation() {
  const [inp, setInp] = useState({ ...DEFAULTS });
  const [rb, setRb] = useState(EMPTY_RB);
  const [leads, setLeads] = useState([]);
  const [leadId, setLeadId] = useState('');
  const [view, setView] = useUrlTab(['internal', 'client'], 'internal', 'view');     // internal | client
  const [tab, setTab] = useUrlTab(['build', 'saved'], 'build');           // build | saved
  const [saved, setSaved] = useState([]);
  const [currentId, setCurrentId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [dealId, setDealId] = useState(null);
  const [variant, setVariant] = useState('');
  const [params] = useSearchParams();
  const set = (k, val) => setInp((p) => ({ ...p, [k]: val }));

  useEffect(() => {
    api.get('/solar/rate-book').then((r) => setRb({ ...EMPTY_RB, ...r.data })).catch(() => toast.error('Could not load solar rate book'));
    // Lead dropdown = SOLAR Sales-Funnel deals, so picking one fetches the
    // deal's client + sizing into the quotation (mam: "lead fetch from solar
    // sales funnel"). Each option carries a readable label (deal no · client · kW).
    api.get('/solar/deals').then((r) => setLeads((r.data || []).map((d) => ({
      ...d,
      _label: `${d.deal_no ? d.deal_no + ' · ' : ''}${d.client_name || d.company || 'Lead'}${Number(d.capacity_kw) > 0 ? ' · ' + fmt(d.capacity_kw) + ' kW' : ''}`,
    })))).catch(() => {});
  }, []);

  // Prefill when opened from a funnel deal ("Create Quotation") so the saved
  // quote links back and auto-advances the deal to the Quotation stage.
  useEffect(() => {
    if (params.get('deal')) setDealId(params.get('deal'));
    if (params.get('variant')) setVariant(params.get('variant'));
    const u = {};
    if (params.get('client')) u.client = params.get('client');
    if (params.get('kw')) u.kw = params.get('kw');
    if (params.get('conn')) u.conn = params.get('conn');
    if (params.get('state')) u.state = params.get('state');
    if (Object.keys(u).length) setInp((p) => ({ ...p, ...u }));
  }, []); // eslint-disable-line

  // Pick a SOLAR Sales-Funnel deal → fetch the full deal and prefill the
  // quotation's client + sizing from it (mam: "lead fetch from solar sales
  // funnel"). Links the saved quote back to the deal so it auto-advances.
  const pickFunnelDeal = async (o) => {
    if (!o) { setDealId(null); setLeadId(''); return; }
    setDealId(o.id);
    try {
      const { data: d } = await api.get(`/solar/deals/${o.id}`);
      setLeadId(d.lead_id || '');
      // The qualification call already asked the customer's ACTUAL tariff
      // and property type (qualification.js) — that's real, customer-specific
      // data, worth far more than a flat default or a state-average guess.
      // Carry it straight into the quote instead of losing it here.
      const q = d.qualification || {};
      setInp((p) => ({
        ...p,
        client: d.client_name || d.company || p.client,
        ...(Number(d.capacity_kw) > 0 ? { kw: String(d.capacity_kw) } : {}),
        ...(d.project_type ? { conn: d.project_type } : {}),
        ...(d.state ? { state: d.state } : {}),
        ...(d.location ? { addr: d.location } : {}),
        ...(Number(q.tariff) > 0 ? { tariff: q.tariff } : {}),
        ...(q.property_type ? { property_type: q.property_type } : {}),
        ...(q.subsidy === 'Interested' ? { subsidy: true } : {}),
      }));
      toast.success('Loaded from Sales Funnel');
    } catch { toast.error('Could not load that lead'); }
  };

  // State's "typical tariff" is only ever a starting point (Solar Settings),
  // and only worth offering when the director has actually configured one —
  // it must never silently overwrite a real, already-entered value.
  const stateTariffHint = rb.factors.state[inp.state]?.tariff || 0;
  const applyStateTariff = () => { set('tariff', stateTariffHint); toast.success(`Set to ${inp.state}'s typical rate — confirm against the customer's bill`); };

  // zero-export → net metering not applicable
  useEffect(() => { if (inp.conn === 'zeroexport' && inp.net) set('net', false); }, [inp.conn]); // eslint-disable-line

  const panelMakes = Object.keys(rb.ui.panel);
  const invMakes = Object.keys(rb.ui.inverter);
  const structMakes = Object.keys(rb.ui.structure);
  const cableMakes = Object.keys(rb.ui.cable);
  const battMakes = Object.keys(rb.ui.battery || {});
  const stateNames = Object.keys(rb.factors.state);
  const isBatt = inp.conn === 'offgrid' || inp.conn === 'hybrid';
  const brandName = String(rb.settings?.company_name || '').trim() || 'Secured Engineers India';
  const brandTagline = String(rb.settings?.company_tagline || '').trim();
  const brandLogoUrl = String(rb.settings?.logo_url || '').trim();

  const c = useMemo(() => compute(inp, rb), [inp, rb]);
  const lines = useMemo(() => buildBOQ(c, inp, rb), [c, inp, rb]);
  const groupedBoq = useMemo(() => groupBOQ(lines), [lines]);
  const tot = useMemo(() => summarize(lines, c), [lines, c]);

  const gstPct = parseFloat(inp.gst) || 0;
  const isZE = inp.conn === 'zeroexport';
  const netApplicable = inp.net && !isZE;
  const netchg = netApplicable ? (parseFloat(inp.netchg) || 0) : 0;
  const gstAmt = tot.totSP * gstPct / 100;
  const grand = tot.totSP + gstAmt + netchg;
  const roi = useMemo(() => computeROI(c, grand, inp, rb), [c, grand, inp, rb]);
  const finance = useMemo(() => computeFinance(Math.max(0, grand - roi.subsidy.totalSubsidy), inp), [grand, roi.subsidy.totalSubsidy, inp]);
  const savingsSeries = useMemo(() => buildSavingsSeries(roi.annualSav, roi.netCost, roi.sav25), [roi.annualSav, roi.netCost, roi.sav25]);
  const floor = parseFloat(inp.floor) || 0;
  const marginOk = tot.marginPct >= floor;

  const notes = useMemo(() => {
    // mam's standard quotation terms — verbatim from the format she shared
    // (Residence-114-1). Only the validity days flexes to the input; the rest
    // are her fixed standard terms so every quote reads identically.
    const validDays = parseInt(inp.valid) || 10;
    return [
      'AMC Charges: 10% of the Final project Value without taxes for one year.',
      'Payment Terms: 30% Advance along with PO, 60% before material dispatch, 10% against testing.',
      `Quotation is valid for ${validDays} days only.`,
      'Anything not mentioned here, if asked, would be charged extra.',
      'Delivery of material: 2-3 Weeks (Approx).',
      'Net Meter Charge / Liaisoning to be paid separately to local authority by beneficiary if any or as per actual.',
      'GST Excluded, and if any other government taxes as applicable at the time of invoicing is excluded.',
      'Transportation / Freight charges: Included in quotation.',
      "Warranty: Solar Panel & Inverter warranty period may vary as per manufacturer's policy. Solar Panels: 15 years manufacturing warranty for any defect. Solar Inverter: 5 years or as per manufacturer's warranty, whichever is maximum.",
    ];
  }, [inp]);

  const payload = () => ({
    quote_no: inp.quote_no || `SEPL-SOLAR-${String(Math.round(c.kwAC))}-${(saved.length + 1)}`,
    lead_id: leadId || null, client_name: inp.client, address: inp.addr,
    project_type: inp.conn, capacity_kw: c.kwAC, dc_ac_ratio: parseFloat(inp.dcac) || 0,
    panel_make: inp.panelmake, inverter_make: inp.invmake,
    inputs: inp, boq: lines, engineering: c, roi,
    cost: tot.totTPA, margin_pct: tot.marginPct, sell: tot.totSP, sell_per_w: tot.wpRate,
    gst_amt: gstAmt, grand_total: grand,
    capacity_dc_kwp: c.realKWp, deal_id: dealId || null, variant_label: variant || null,
    // Display fields for the PDF/Excel quotation (mam's format) — ignored on save.
    type_label: typeLabel(inp.conn), roof_label: surfLabel(inp.mount), notes, view,
    boq_grouped: groupedBoq,
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

  // Procurement today has no notion of a solar BOQ — it's built around
  // order_planning/business_book-linked indents raised only on Saturdays
  // (a deliberate gate, not an oversight). Rather than bypass that, this
  // hands the person raising the indent a clean, correctly-priced sheet —
  // no more retyping the BOQ from the quotation PDF by hand.
  const exportBoqForProcurement = () => {
    exportCsv(
      `solar-boq-procurement-${(inp.client || 'quote').replace(/[^a-z0-9]/gi, '_')}`,
      ['Description', 'Make', 'Unit', 'Quantity', 'Purchase Rate ₹', 'Purchase Amount ₹'],
      lines.map((l) => [l.desc, l.make, l.unit, fmt(l.qty), fmt(l.ppUnit, 2), fmt(l.pp, 2)]),
    );
  };

  // PDF in mam's quotation format (the Residence-114-1 layout she shared):
  // page 1 = BOQ (S.No/Description/Unit/Makes/Qty, no prices), page 2 =
  // commercial (client block + lumpsum base price + notes). Built as a
  // print-ready HTML doc opened in a new tab → Ctrl/⌘+P → Save as PDF, so it
  // needs no server-side PDF renderer.
  const printPdf = () => {
    const p = payload();
    const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
    // A window.open() popup starts at about:blank, so a relative /uploads/…
    // path won't resolve — the logo needs the app's actual origin prefixed.
    const brandLogo = String(rb.settings?.logo_url || '').trim();
    const brandLogoAbs = brandLogo ? `${window.location.origin}${brandLogo}` : '';
    const brandHtml = brandLogoAbs
      ? `<img src="${esc(brandLogoAbs)}" style="max-height:34px;max-width:180px;display:block;margin-bottom:2px" />`
      : `<div class="brand">${esc(brandName)}</div>`;
    const kw = Math.round(p.capacity_kw || 0);
    const tl = typeLabel(inp.conn);
    const roof = surfLabel(inp.mount);
    const sysTitle = `${kw} KW ${tl} SOLAR SYSTEM ON ${roof.toUpperCase()}`;
    const letter = (i) => String.fromCharCode(97 + i);
    const boqRows = (groupedBoq || []).map((cat) => {
      if (cat.grouped) {
        const head = `<tr><td class="c">${esc(cat.no)}</td><td><b>${esc(cat.name)}</b></td><td></td><td></td><td></td></tr>`;
        const subs = cat.items.map((it, j) => `<tr><td class="c">${letter(j)}</td><td>${esc(it.desc)}</td><td class="c">${esc(it.unit)}</td><td>${esc(it.make)}</td><td class="c">${esc(it.qty)}</td></tr>`).join('');
        return head + subs;
      }
      const it = cat.items[0] || {};
      return `<tr><td class="c">${esc(cat.no)}</td><td>${esc(it.desc)}</td><td class="c">${esc(it.unit)}</td><td>${esc(it.make)}</td><td class="c">${esc(it.qty)}</td></tr>`;
    }).join('');
    const noteRows = (notes || []).map((nn) => `<li>${esc(nn)}</li>`).join('');
    const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' });
    const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(p.quote_no)}</title><style>
@page { size: A4; margin: 14mm; }
* { box-sizing: border-box; }
body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 12px; margin: 0; }
.page { page-break-after: always; } .page:last-child { page-break-after: auto; }
.brand { color: #b91c1c; font-weight: 800; letter-spacing: .5px; font-size: 15px; }
.muted { color: #555; } h1 { font-size: 14px; margin: 4px 0 2px; }
.title { font-size: 13px; font-weight: 700; margin: 10px 0 2px; }
table { width: 100%; border-collapse: collapse; margin-top: 8px; }
th, td { border: 1px solid #999; padding: 5px 7px; vertical-align: top; }
th { background: #fde8e8; text-align: left; font-size: 11px; text-transform: uppercase; }
td.c, th.c { text-align: center; }
.kv { margin-top: 6px; } .kv td { border: none; padding: 2px 6px; }
ol { margin: 6px 0 0 16px; padding: 0; } ol li { margin: 3px 0; }
</style></head><body onload="setTimeout(function(){window.print();},200)">
<div class="page">
  ${brandHtml}
  <div class="title">Proposal for ${kw} KW ${esc(tl)} Solar System on ${esc(roof)}</div>
  <div class="muted">Providing, laying, testing &amp; commissioning of</div>
  <table><thead><tr><th class="c">S.NO.</th><th>DESCRIPTION</th><th class="c">UNIT</th><th>MAKES</th><th class="c">QTY</th></tr></thead>
  <tbody>${boqRows}</tbody></table>
</div>
<div class="page">
  ${brandHtml}
  <h1>QUOTATION FOR ${esc(sysTitle)}</h1>
  <table class="kv">
    <tr><td><b>NAME</b></td><td>${esc(p.client_name)}</td><td><b>Date</b></td><td>${esc(today)}</td></tr>
    <tr><td><b>ADDRESS</b></td><td>${esc(p.address)}</td><td><b>Quotation No</b></td><td>${esc(p.quote_no)}</td></tr>
  </table>
  <table><thead><tr><th class="c">S No.</th><th>Description</th><th class="c">Amount (In Rupees)</th></tr></thead>
  <tbody>
    <tr><td class="c">1</td><td>${esc(sysTitle)}</td><td class="c">${inr(p.sell)}</td></tr>
    <tr><td></td><td><b>BASE PRICE WITHOUT GST</b></td><td class="c">₹${fmt(p.sell_per_w, 2)}/watt</td></tr>
    ${p.roi.subsidy.eligible ? `<tr><td></td><td><b>LESS: PM SURYA GHAR SUBSIDY</b></td><td class="c">− ${inr(p.roi.subsidy.totalSubsidy)}</td></tr>
    <tr><td></td><td><b>YOUR NET INVESTMENT</b></td><td class="c">${inr(p.roi.netCost)}</td></tr>` : ''}
  </tbody></table>
  ${finance.emi > 0 ? `<div class="muted">EMI option: ₹${fmt(finance.emi, 0)}/month for ${fmt(inp.loanTenure, 0)} years (${fmt(inp.loanPct, 0)}% financed @ ${fmt(inp.loanRate, 1)}% p.a.)</div>` : ''}
  <div class="title">Note:</div>
  <ol>${noteRows}</ol>
</div>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) return toast.error('Allow pop-ups to open the PDF');
    w.document.write(html); w.document.close();
  };

  const loadSaved = async () => {
    try { const r = await api.get('/solar/quotations'); setSaved(r.data || []); } catch (e) { toast.error('Could not load saved'); }
  };
  useEffect(() => { if (tab === 'saved') loadSaved(); }, [tab]); // eslint-disable-line

  const openSaved = async (id) => {
    try {
      const r = await api.get(`/solar/quotations/${id}`);
      setInp({ ...DEFAULTS, ...(r.data.inputs || {}) });
      setLeadId(r.data.lead_id || ''); setDealId(r.data.deal_id || null); setCurrentId(id); setTab('build');
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
          <div className="table-responsive">
          <table className="w-full text-sm min-w-[700px]">
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
                  <td className="p-2 flex items-center gap-2">
                    <button onClick={(e) => { e.stopPropagation(); window.open(`/solar-quotations/${s.id}/design-report`, '_blank'); }} title="Engineering / Design Basis Report" className="text-blue-600"><FiFileText size={14} /></button>
                    <button onClick={(e) => { e.stopPropagation(); delSaved(s.id); }} className="text-red-500"><FiTrash2 size={14} /></button>
                  </td>
                </tr>))}
              {!saved.length && <tr><td colSpan={8} className="p-6 text-center text-gray-400">No saved solar quotations yet.</td></tr>}
            </tbody>
          </table>
          </div>
        </div>
      ) : (
      <div className="grid grid-cols-1 xl:grid-cols-[360px_1fr] gap-4">
        {/* INPUTS */}
        <div className="space-y-3 no-print">
          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">1 · Site &amp; client</p>
            <label className="block"><span className="label">Lead (Sales Funnel)</span>
              <SearchableSelect options={leads} value={dealId} displayKey="_label" valueKey="id"
                placeholder="Pick a lead…" onChange={pickFunnelDeal} /></label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Tx('client', 'Client name')}
              {Tx('addr', 'Address')}
              {Se('state', 'State', STATES)}
              {Se('property_type', 'Customer type', PROPERTY_TYPES)}
              {Se('conn', 'Connection', PROJECT_TYPES)}
              {Se('mount', 'Mounting', MOUNTS)}
              {Nu('area', 'Shadow-free area (m²)')}
              {Nu('wind', 'Design wind (m/s)')}
              {Nu('dist', 'Site distance (km)')}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">2 · Sizing</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Nu('kw', 'Capacity (kW AC)')}{Nu('dcac', 'DC : AC ratio', { step: '0.01' })}
              {Nu('wp', 'Panel (Wp)')}{Tx('ptype', 'Panel type')}
              {Nu('voc', 'Voc (V)', { step: '0.1' })}{Nu('vmp', 'Vmp (V)', { step: '0.1' })}
              {Nu('imp', 'Imp (A)', { step: '0.1' })}{Nu('tc', 'Voc temp-coef %/°C', { step: '0.01' })}
            </div>
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">2b · Equipment make &amp; grade <span className="text-rose-500 normal-case font-normal">(drives rate)</span></p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Nu('vdc', 'Inverter max DC (V)')}{Nu('mppt', 'MPPT min (V)')}
              {Nu('dcrun', 'DC run one-way (m)')}{Nu('acrun', 'AC run (m)')}
              {Nu('dcvd', 'DC volt-drop %', { step: '0.1' })}{Nu('acvd', 'AC volt-drop %', { step: '0.1' })}
            </div>
            <div className="grid grid-cols-2 gap-1">{Ck('dg', 'DG synchronization')}{Ck('rms', 'RMS monitoring')}{Ck('clean', 'Cleaning system')}{Ck('net', 'Net metering')}</div>
          </div>

          {isBatt && (
            <div className="card p-4 space-y-3 ring-1 ring-amber-200">
              <p className="font-bold text-[11px] uppercase tracking-wide text-amber-700">🔋 Battery sizing ({inp.conn === 'offgrid' ? 'off-grid' : 'hybrid'})</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {Nu('backupkw', 'Backup load (kW)')}{Nu('backuphrs', 'Backup hours')}
                {Nu('dod', 'Depth of discharge %')}
                {inp.conn === 'offgrid' && Nu('autonomy', 'Autonomy (days)')}
                {Se('batterytype', 'Battery type', battMakes.length ? battMakes : ['Li-ion LFP', 'Lead-acid Tubular'])}
              </div>
            </div>
          )}

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">4 · Commercials &amp; throughput margin</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {Nu('margin', 'Target margin %', { step: '0.5' })}{Nu('floor', 'Min-margin floor %', { step: '0.5' })}
              {Nu('gst', 'GST %', { step: '0.1' })}{Nu('netchg', 'Net-meter charge ₹')}
              {Nu('cont', 'Contingency %', { step: '0.5' })}
              <label className="block">
                <span className="label">Grid tariff ₹/unit (ROI)</span>
                <div className="flex gap-1">
                  <input className="input-compact w-full" type="number" value={inp.tariff ?? ''} onChange={(e) => set('tariff', e.target.value)} />
                  {stateTariffHint > 0 && <button type="button" onClick={applyStateTariff} title={`Use ${inp.state}'s typical rate: ₹${stateTariffHint}/unit`} className="btn btn-secondary text-[10px] px-2 shrink-0">₹{stateTariffHint}</button>}
                </div>
              </label>
              {Nu('valid', 'Quote validity (days)')}{Nu('amcfree', 'AMC free years')}
              {Nu('amcfee', 'AMC after, ₹/yr')}
            </div>
            <div className="grid grid-cols-2 gap-1">
              {Ck('transport', 'Transport included')}{Ck('escal', 'Price-escalation clause')}
              {Ck('subsidy', 'Apply PM Surya Ghar subsidy')}{Ck('scope', 'Scope list on client quote')}
            </div>
            {inp.subsidy && (
              roi.subsidy.eligible
                ? <p className="text-[11px] text-emerald-700">✓ Eligible — ₹{fmt(roi.subsidy.totalSubsidy, 0)} ({fmt(c.realKWp, 1)} kWp{roi.subsidy.stateSubsidy > 0 ? `, incl. ₹${fmt(roi.subsidy.stateSubsidy, 0)} state top-up` : ''})</p>
                : <p className="text-[11px] text-amber-700">⚠ {roi.subsidy.reason}</p>
            )}
          </div>

          <div className="card p-4 space-y-3">
            <p className="font-bold text-[11px] uppercase tracking-wide text-gray-700">5 · Finance (EMI calculator)</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              {Nu('loanPct', 'Financed %', { step: '5', min: '0', max: '100' })}
              {Nu('loanRate', 'Interest %/yr', { step: '0.1' })}
              {Nu('loanTenure', 'Tenure (yrs)', { step: '1' })}
            </div>
            <p className="text-[10px] text-gray-500">A calculator, not a live bank quote — set rate/tenure from whatever the customer's actual lender offers.</p>
          </div>
        </div>

        {/* OUTPUT */}
        <div className="space-y-4">
          {/* actions */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 no-print">
            <div className="flex gap-2 overflow-x-auto pb-1 scrollbar-none sm:flex-wrap">
              <button onClick={() => setView('internal')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap ${view === 'internal' ? 'bg-white text-gray-700 border-gray-200 shadow-sm' : 'bg-white text-gray-400 border-gray-100'}`}>Internal (our rates)</button>
              <button onClick={() => setView('client')} className={`px-3 py-1.5 rounded-full text-xs font-semibold border whitespace-nowrap ${view === 'client' ? 'bg-emerald-600 text-white border-emerald-600 shadow-sm' : 'bg-white text-gray-400 border-gray-100'}`}>Client (lumpsum)</button>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button onClick={() => window.print()} className="btn btn-secondary text-xs sm:text-sm flex items-center gap-1"><FiPrinter size={14} /> Print</button>
              <button onClick={printPdf} className="btn btn-secondary text-xs sm:text-sm flex items-center gap-1"><FiFileText size={14} /> PDF</button>
              <button onClick={exportXlsx} className="btn btn-secondary text-xs sm:text-sm flex items-center gap-1"><FiDownload size={14} /> Excel</button>
              <button onClick={exportBoqForProcurement} title="BOQ as a procurement-ready CSV — description, make, unit, qty, purchase rate" className="btn btn-secondary text-xs sm:text-sm flex items-center gap-1"><FiShoppingCart size={14} /> BOQ for Procurement</button>
              {currentId && <button onClick={() => window.open(`/solar-quotations/${currentId}/design-report`, '_blank')} className="btn btn-secondary text-xs sm:text-sm flex items-center gap-1"><FiFileText size={14} /> Design Report</button>}
              <button onClick={save} disabled={busy} className="btn btn-primary text-xs sm:text-sm flex items-center gap-1 font-semibold"><FiSave size={14} /> {currentId ? 'Update' : 'Save'}</button>
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
            {roi.subsidy.eligible && (
              <p className="text-[11px] text-emerald-700 mt-2">Payback above is net of ₹{fmt(roi.subsidy.totalSubsidy, 0)} PM Surya Ghar subsidy — gross cost would be {inr(grand)}, net {inr(roi.netCost)}.</p>
            )}
            {finance.emi > 0 && (
              <div className="mt-2 pt-2 border-t flex flex-wrap gap-4 text-xs">
                <span className="text-gray-500">EMI on {fmt(inp.loanPct, 0)}% financed ({inr(finance.principal)} @ {fmt(inp.loanRate, 1)}% / {fmt(inp.loanTenure, 0)} yr):</span>
                <b>₹{fmt(finance.emi, 0)}/month</b>
                <span className="text-gray-400">total interest {inr(finance.totalInterest)}</span>
              </div>
            )}
            {savingsSeries.length > 0 && <SavingsChart data={savingsSeries} netCost={roi.netCost} payback={roi.payback} />}
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
                {brandLogoUrl
                  ? <img src={brandLogoUrl} alt={brandName} className="h-8 ml-auto mb-0.5 object-contain" />
                  : <p className="font-bold text-blue-900">{brandName}</p>}
                {brandTagline && <p className="text-[10px] text-gray-400">{brandTagline}</p>}
                <p>Base: ₹{fmt(tot.wpRate, 2)}/watt · ₹{fmt(tot.kwRate, 0)}/kW (ex-GST)</p>
              </div>
            </div>

            {view === 'internal' ? (
              <div>
                <div className="px-5 pt-3 text-[11px] text-rose-600 font-semibold no-print">● INTERNAL working sheet — our purchase rates &amp; throughput margin. Never sent to client.</div>
                <div className="p-4 overflow-x-auto">
                  <table className="w-full text-xs min-w-[850px]">
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
                <div className="overflow-x-auto">
                <table className="w-full text-sm mb-5 min-w-[550px]">
                  <thead><tr className="border-b-2 text-left text-gray-600"><th className="p-2 w-12">S.No</th><th className="p-2">Description</th><th className="p-2 text-right">Amount (₹)</th></tr></thead>
                  <tbody>
                    <tr className="border-b"><td className="p-2 align-top">1</td>
                      <td className="p-2 font-semibold">{fmt(c.kwAC)} kW {typeLabel(inp.conn)} Solar Power Plant — supply, installation, testing &amp; commissioning (turnkey)</td>
                      <td className="p-2 text-right font-bold align-top">{inr(tot.totSP)}</td></tr>
                    <tr className="text-gray-600"><td></td><td className="p-2">Base price (ex-GST)</td><td className="p-2 text-right">₹{fmt(tot.wpRate, 2)}/watt · ₹{fmt(tot.kwRate, 0)}/kW</td></tr>
                    <tr className="text-gray-600"><td></td><td className="p-2">GST @ {gstPct}%</td><td className="p-2 text-right">{inr(gstAmt)}</td></tr>
                    {netApplicable && <tr className="text-gray-600"><td></td><td className="p-2">Net-meter charge (extra, at actual)</td><td className="p-2 text-right">{inr(netchg)}</td></tr>}
                    <tr className={`font-bold text-blue-900 ${roi.subsidy.eligible ? '' : 'border-t-2'}`}><td></td><td className="p-2">Grand total (incl GST)</td><td className="p-2 text-right">{inr(grand)}</td></tr>
                    {roi.subsidy.eligible && (<>
                      <tr className="text-emerald-700"><td></td><td className="p-2">Less: PM Surya Ghar subsidy{roi.subsidy.stateSubsidy > 0 ? ' + state top-up' : ''}</td><td className="p-2 text-right">− {inr(roi.subsidy.totalSubsidy)}</td></tr>
                      <tr className="border-t-2 font-bold text-blue-900"><td></td><td className="p-2">Your net investment</td><td className="p-2 text-right">{inr(roi.netCost)}</td></tr>
                    </>)}
                  </tbody>
                </table>
                </div>
                <div className="mb-4 p-3 bg-emerald-50 rounded-lg">
                  <p className="font-bold text-xs mb-1 text-emerald-800">Your savings at a glance</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div><p className="text-gray-500">Annual generation</p><p className="font-bold">{fmt(roi.annualKWh, 0)} kWh</p></div>
                    <div><p className="text-gray-500">Annual bill savings</p><p className="font-bold text-emerald-700">₹{fmt(roi.annualSav, 0)}</p></div>
                    <div><p className="text-gray-500">Payback period</p><p className="font-bold">{fmt(roi.payback, 1)} yrs</p></div>
                    <div><p className="text-gray-500">Lifetime (25-yr) savings</p><p className="font-bold text-emerald-700">₹{fmt(roi.sav25 / 1e7, 2)} Cr</p></div>
                  </div>
                  {finance.emi > 0 && (
                    <p className="text-[11px] text-emerald-800 mt-2 pt-2 border-t border-emerald-200">
                      Or pay via EMI: <b>₹{fmt(finance.emi, 0)}/month</b> for {fmt(inp.loanTenure, 0)} years ({fmt(inp.loanPct, 0)}% financed @ {fmt(inp.loanRate, 1)}% p.a.)
                    </p>
                  )}
                  {/* On-screen only (no-print) — recharts' responsive sizing
                      doesn't reflow reliably inside the print pass, and the
                      cumulative figures are already in the printed table above. */}
                  {savingsSeries.length > 0 && <div className="no-print"><SavingsChart data={savingsSeries} netCost={roi.netCost} payback={roi.payback} /></div>}
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

// 25-year cumulative-savings curve with the payback crossover marked — the
// same modelled numbers already on the page (annualSav/sav25/netCost/payback),
// just made legible at a glance instead of read off a table.
function SavingsChart({ data, netCost, payback }) {
  const paybackYear = payback > 0 && payback <= 25 ? Math.round(payback * 10) / 10 : null;
  return (
    <div className="mt-3 pt-3 border-t">
      <div className="flex items-center justify-between mb-1">
        <p className="text-[11px] font-semibold text-gray-600">Cumulative savings vs. net investment — 25 years</p>
        {paybackYear && <span className="text-[10px] text-gray-400">Break-even ≈ year {paybackYear}</span>}
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <AreaChart data={data} margin={{ top: 6, right: 12, bottom: 0, left: 0 }}>
          <defs>
            <linearGradient id="savingsFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#059669" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#059669" stopOpacity={0.03} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#e5e7eb" vertical={false} />
          <XAxis dataKey="year" tick={{ fontSize: 10 }} tickFormatter={(y) => `Y${y}`} interval={4} />
          <YAxis tick={{ fontSize: 10 }} tickFormatter={(v) => `₹${fmt(v / 1e5, 1)}L`} width={44} />
          <Tooltip
            formatter={(v, key) => [inr(v), key === 'cumulative' ? 'Cumulative savings' : 'Net investment']}
            labelFormatter={(y) => `Year ${y}`}
          />
          {netCost > 0 && <ReferenceLine y={netCost} stroke="#dc2626" strokeDasharray="4 3" label={{ value: 'Net investment', fontSize: 9, fill: '#dc2626', position: 'insideTopRight' }} />}
          <Area type="monotone" dataKey="cumulative" stroke="#059669" strokeWidth={2} fill="url(#savingsFill)" />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
