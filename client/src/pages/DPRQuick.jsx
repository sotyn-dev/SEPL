// Quick DPR — 30-second phone-first filing (director ask, 2026-07-25:
// "within 30 sec engineer can file a dpr, rest all will be automatic").
//
// Everything pre-fills from one round trip (GET /dpr/quick-prefill):
// yesterday's work items with refreshed remaining qty, yesterday's cost
// rows, today's contractor attendance (incl. sub-contractor self-service
// submissions), live weather. Staff Cost + TA/DA load in parallel from
// their existing endpoints. The engineer only:
//   1. adjusts today's quantities (+/- steppers, no typing)
//   2. types one line: tomorrow's plan (this powers tomorrow's prefill)
//   3. optionally snaps photos / flips a safety chip off
// then hits Submit. Totals & profit/loss compute automatically and POST
// to the SAME /dpr endpoint as the full form — no parallel data path.

import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import {
  FiCamera, FiTrash2, FiPlus, FiMinus, FiCheck, FiZap, FiChevronLeft,
  FiSun, FiCloudRain, FiCloud, FiWind, FiThermometer,
} from 'react-icons/fi';

const SKILLED_RATE = 800, HELPER_RATE = 500; // fixed company rates (same as full form)
const WEATHER_META = {
  clear:  { icon: FiSun,         label: 'Clear'  },
  rainy:  { icon: FiCloudRain,   label: 'Rainy'  },
  cloudy: { icon: FiCloud,       label: 'Cloudy' },
  hot:    { icon: FiThermometer, label: 'Hot'    },
  windy:  { icon: FiWind,        label: 'Windy'  },
};

export default function DPRQuick() {
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const today = new Date().toISOString().slice(0, 10);
  const [loading, setLoading] = useState(false);
  const [prefill, setPrefill] = useState(null);
  const [items, setItems] = useState([]);         // [{po_item_id, description, unit, rate, qty, remaining_qty, work_order_id, floor_zone}]
  const [skilled, setSkilled] = useState(0);
  const [helper, setHelper] = useState(0);
  const [rental, setRental] = useState(0);
  const [staffCost, setStaffCost] = useState({ per_day_cost: 0 });
  const [taDa, setTaDa] = useState({ total_amount: 0 });
  const [weather, setWeather] = useState('clear');
  const [toolbox, setToolbox] = useState(true);
  const [ppe, setPpe] = useState(true);
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [nextPlan, setNextPlan] = useState('');
  const [hindrance, setHindrance] = useState('');
  const [hindranceCat, setHindranceCat] = useState(''); // required only on loss days
  const [saving, setSaving] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [poItems, setPoItems] = useState([]);
  const startedAt = useRef(Date.now());

  // Engineer-scoped site list (GET /dpr/sites already filters to the caller's
  // own sites for non-admins). Auto-select when there's exactly one.
  useEffect(() => {
    api.get('/dpr/sites').then(r => {
      const active = (r.data || []).filter(s => s.status === 'active');
      setSites(active);
      if (active.length === 1) setSiteId(String(active[0].id));
    }).catch(() => setSites([]));
  }, []);

  // One-tap prefill the moment a site is picked.
  useEffect(() => {
    if (!siteId) return;
    setLoading(true);
    startedAt.current = Date.now();
    Promise.all([
      api.get('/dpr/quick-prefill', { params: { site_id: siteId, date: today } }),
      api.get(`/dpr/sites/${siteId}/staff-cost`).catch(() => ({ data: {} })),
      api.get(`/dpr/sites/${siteId}/ta-da-cost`).catch(() => ({ data: {} })),
    ]).then(([pf, sc, td]) => {
      const p = pf.data || {};
      setPrefill(p);
      setItems((p.work_items || []).map(it => ({
        ...it,
        qty: 0, // engineer sets TODAY's qty — yesterday's is shown as a hint
      })));
      const costOf = t => (p.costs || []).find(c => (c.type || '').toLowerCase().includes(t));
      setSkilled(+(costOf('skilled')?.qty || 0));
      setHelper(+(costOf('helper')?.qty || 0));
      setRental(+((costOf('rental')?.qty || 0) * (costOf('rental')?.rate || 0)) || 0);
      if (p.weather?.weather) setWeather(p.weather.weather);
      setStaffCost(sc.data || {});
      setTaDa(td.data || {});
      if (p.already_filed_today) toast('A DPR already exists for today — submitting will update it.', { icon: 'ℹ️' });
    }).catch(() => toast.error('Could not load prefill'))
      .finally(() => setLoading(false));
  }, [siteId, today]);

  const bump = (i, delta) => setItems(arr => arr.map((it, idx) => {
    if (idx !== i) return it;
    const max = it.remaining_qty ?? 999999;
    return { ...it, qty: Math.min(max, Math.max(0, (+it.qty || 0) + delta)) };
  }));
  const setQty = (i, v) => setItems(arr => arr.map((it, idx) => idx === i
    ? { ...it, qty: Math.min(it.remaining_qty ?? 999999, Math.max(0, +v || 0)) } : it));
  const removeItem = (i) => setItems(arr => arr.filter((_, idx) => idx !== i));

  const openAdd = () => {
    setAddOpen(true);
    if (!poItems.length) {
      api.get(`/dpr/sites/${siteId}/po-items`).then(r => {
        const list = Array.isArray(r.data) ? r.data : (r.data?.items || []);
        setPoItems(list);
      }).catch(() => {});
    }
  };
  const addItem = (po) => {
    if (items.some(it => it.po_item_id === po.id)) { setAddOpen(false); return; }
    setItems(arr => [...arr, {
      po_item_id: po.id, description: po.description, unit: po.unit || 'nos',
      rate: Math.round((+po.rate || 0) * 0.11 * 100) / 100, // labour = 11% of SITC, same as full form
      qty: 0, remaining_qty: po.remaining_qty ?? po.quantity, boq_qty: po.quantity, last_qty: null,
    }]);
    setAddOpen(false);
  };

  const uploadPhoto = async (file) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const { data } = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setPhotos(p => [...p, data.url]);
    } catch { toast.error('Photo upload failed'); }
    finally { setUploading(false); }
  };

  const totalA = items.reduce((s, it) => s + (+it.qty || 0) * (+it.rate || 0), 0);
  const staffPerDay = +staffCost.per_day_cost || 0;
  const taDaAmt = +taDa.total_amount || 0;
  const totalB = skilled * SKILLED_RATE + helper * HELPER_RATE + (+rental || 0) + staffPerDay + taDaAmt;
  const pl = totalA - totalB;

  const submit = async () => {
    if (!siteId) { toast.error('Pick a site'); return; }
    if (!nextPlan.trim()) { toast.error("Type tomorrow's plan — it becomes tomorrow's prefill"); return; }
    if (pl < 0 && !hindrance.trim()) { toast.error('Today is a loss — one line on the hindrance is required'); return; }
    if (pl < 0 && !hindranceCat) { toast.error('Pick the hindrance category (the 4M+S chips)'); return; }
    setSaving(true);
    try {
      const manpower = [
        { type: 'Skilled Manpower', qty: skilled, rate: SKILLED_RATE, amount: skilled * SKILLED_RATE },
        { type: 'Helper', qty: helper, rate: HELPER_RATE, amount: helper * HELPER_RATE },
        { type: 'Rental Cost', qty: rental > 0 ? 1 : 0, rate: +rental || 0, amount: +rental || 0 },
        { type: 'Staff Cost', qty: 1, rate: staffPerDay, amount: staffPerDay },
        { type: 'TA/DA', qty: 1, rate: taDaAmt, amount: taDaAmt },
      ].filter(c => c.amount > 0 || c.qty > 0);
      const { data } = await api.post('/dpr', {
        site_id: +siteId, report_date: today, weather, shift: prefill?.shift || 'day',
        system_type: prefill?.system_type || null, floor_zone: prefill?.floor_zone || null,
        overall_status: pl < 0 ? 'delayed' : 'on_track',
        safety_toolbox_talk: toolbox, safety_ppe_compliance: ppe,
        next_day_plan: nextPlan.trim(), hindrances: hindrance.trim() || null,
        hindrance_category: hindranceCat || null, remarks: 'Filed via Quick DPR',
        contractors: (prefill?.contractors || []).map(c => ({ name: c.name, manpower: c.manpower })),
        work_items: items.filter(it => it.qty > 0).map(it => ({
          po_item_id: it.po_item_id, description: it.description, unit: it.unit,
          qty: it.qty, rate: it.rate, amount: it.qty * it.rate,
          work_order_id: it.work_order_id || null, location: it.floor_zone || null,
        })),
        manpower,
        site_photos: photos,
        grand_total_a: totalA, grand_total_b: totalB, profit_loss: pl,
      });
      const secs = Math.round((Date.now() - startedAt.current) / 1000);
      toast.success(`DPR filed in ${secs}s ✓`);
      (data?.stock_shortfalls || []).forEach(s =>
        toast.error(`⚠ Stock short: ${s.material_name || 'item'} (short ${s.shortfall})`, { duration: 6000 }));
      // Reset for the (rare) second site of the day.
      setItems([]); setPhotos([]); setNextPlan(''); setHindrance(''); setPrefill(null); setSiteId('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit');
    } finally { setSaving(false); }
  };

  const fmtRs = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');
  const contractorTotal = (prefill?.contractors || []).reduce((s, c) => s + (+c.manpower || 0), 0);

  return (
    <div className="max-w-lg mx-auto space-y-3 pb-28">
      <div className="flex items-center justify-between">
        <h3 className="font-bold text-gray-800 flex items-center gap-1.5"><FiZap className="text-amber-500" /> Quick DPR</h3>
        <Link to="/dpr" className="text-xs text-blue-600 flex items-center gap-0.5"><FiChevronLeft size={12} /> Full form</Link>
      </div>

      {/* Site — auto-selected when the engineer has exactly one */}
      <select className="select w-full text-base" value={siteId} onChange={e => setSiteId(e.target.value)}>
        <option value="">-- Select site --</option>
        {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
      </select>

      {loading && <div className="card p-6 text-center text-gray-400 text-sm">Loading everything…</div>}

      {prefill && !loading && (
        <>
          {/* Auto-filled context strip — glance, don't type */}
          <div className="card p-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-xs text-gray-600">
            {(() => { const W = WEATHER_META[weather]?.icon || FiSun; return (
              <span className="flex items-center gap-1 font-semibold text-gray-800">
                <W size={14} className="text-amber-500" /> {WEATHER_META[weather]?.label || weather}
                {prefill.weather?.temperature != null && <span className="text-gray-400 font-normal">{Math.round(prefill.weather.temperature)}°C</span>}
              </span>
            ); })()}
            <span>👷 {contractorTotal} manpower ({(prefill.contractors || []).length} contractor{(prefill.contractors || []).length === 1 ? '' : 's'})</span>
            {staffPerDay > 0 && <span>Staff {fmtRs(staffPerDay)}/day</span>}
            {taDaAmt > 0 && <span>TA/DA {fmtRs(taDaAmt)}</span>}
            <span className="text-gray-400">— all auto</span>
          </div>

          {/* Yesterday's plan = today's todo hint */}
          {prefill.yesterday_plan && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-900">
              <b>Yesterday you planned:</b> {prefill.yesterday_plan}
            </div>
          )}

          {/* Work items — steppers only */}
          <div className="card p-3 space-y-2">
            <div className="flex items-center justify-between">
              <h4 className="font-semibold text-sm">Today's Work</h4>
              <button type="button" onClick={openAdd} className="text-xs text-blue-600 font-semibold flex items-center gap-0.5"><FiPlus size={12} /> Add item</button>
            </div>
            {items.length === 0 && <p className="text-xs text-gray-400 py-2">No carried-over items — tap "Add item".</p>}
            {items.map((it, i) => (
              <div key={i} className="border border-gray-100 rounded-xl p-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="text-sm font-medium leading-snug flex-1">{it.description}</div>
                  <button type="button" onClick={() => removeItem(i)} className="text-gray-300 hover:text-red-500 p-0.5"><FiTrash2 size={13} /></button>
                </div>
                <div className="flex items-center justify-between mt-2">
                  <div className="text-[10px] text-gray-400">
                    {it.last_qty != null && <span>Yesterday: <b className="text-gray-600">{it.last_qty}</b> · </span>}
                    {it.remaining_qty != null && <span>Left: <b className="text-gray-600">{it.remaining_qty} {it.unit}</b></span>}
                  </div>
                  <div className="flex items-center gap-1">
                    <button type="button" onClick={() => bump(i, -1)} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center active:bg-gray-200"><FiMinus size={15} /></button>
                    <input type="number" inputMode="numeric" className="w-14 h-9 text-center font-bold text-base border border-gray-200 rounded-lg"
                      value={it.qty || ''} placeholder="0" onChange={e => setQty(i, e.target.value)} />
                    <button type="button" onClick={() => bump(i, +1)} className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center active:bg-blue-700"><FiPlus size={15} /></button>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Manpower + photos on one compact card */}
          <div className="card p-3 space-y-2.5">
            {[['Skilled', skilled, setSkilled, SKILLED_RATE], ['Helper', helper, setHelper, HELPER_RATE]].map(([label, val, set, rate]) => (
              <div key={label} className="flex items-center justify-between">
                <span className="text-sm">{label} <span className="text-[10px] text-gray-400">@₹{rate}</span></span>
                <div className="flex items-center gap-1">
                  <button type="button" onClick={() => set(v => Math.max(0, v - 1))} className="w-9 h-9 rounded-full bg-gray-100 flex items-center justify-center active:bg-gray-200"><FiMinus size={15} /></button>
                  <span className="w-10 text-center font-bold">{val}</span>
                  <button type="button" onClick={() => set(v => v + 1)} className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center active:bg-blue-700"><FiPlus size={15} /></button>
                </div>
              </div>
            ))}
            <div className="flex items-center gap-2 pt-1 border-t border-gray-100">
              {photos.map((url, i) => (
                <div key={i} className="relative">
                  <img src={url} alt="" className="w-12 h-12 object-cover rounded-lg border border-gray-200" />
                  <button type="button" onClick={() => setPhotos(p => p.filter((_, x) => x !== i))} className="absolute -top-1 -right-1 bg-white rounded-full shadow p-0.5 text-red-500"><FiTrash2 size={10} /></button>
                </div>
              ))}
              <label className="w-12 h-12 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center text-gray-400 active:border-blue-400">
                {uploading ? <span className="text-[9px]">…</span> : <FiCamera size={18} />}
                <input type="file" accept="image/*" capture="environment" className="hidden" disabled={uploading}
                  onChange={e => { const f = e.target.files?.[0]; if (f) uploadPhoto(f); e.target.value = ''; }} />
              </label>
              {/* Safety chips — default YES, tap to flip */}
              <div className="flex gap-1.5 ml-auto">
                {[['Toolbox', toolbox, setToolbox], ['PPE', ppe, setPpe]].map(([label, val, set]) => (
                  <button key={label} type="button" onClick={() => set(v => !v)}
                    className={`px-2.5 h-9 rounded-full text-[11px] font-bold flex items-center gap-1 ${val ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>
                    {val ? <FiCheck size={11} /> : '✕'} {label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* The two human inputs */}
          <div className="card p-3 space-y-2">
            <textarea className="input w-full text-sm" rows="2" placeholder="Tomorrow's plan * (becomes tomorrow's prefill)"
              value={nextPlan} onChange={e => setNextPlan(e.target.value)} />
            <textarea className="input w-full text-sm" rows="1" placeholder={pl < 0 ? 'Hindrance / reason for loss * (required — loss day)' : 'Hindrance (optional)'}
              value={hindrance} onChange={e => setHindrance(e.target.value)} />
            {/* 4M+S category chips — only demanded on loss days (server rule) */}
            {pl < 0 && (
              <div className="flex flex-wrap gap-1.5">
                {['Money', 'Machine', 'Material', 'Manpower', 'Site Clearance'].map(c => (
                  <button key={c} type="button" onClick={() => setHindranceCat(c)}
                    className={`px-2.5 h-8 rounded-full text-[11px] font-bold ${hindranceCat === c ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-600'}`}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Sticky submit with live P/L */}
          <div className="fixed bottom-0 left-0 right-0 bg-white/95 backdrop-blur border-t border-gray-200 p-3 z-40">
            <div className="max-w-lg mx-auto flex items-center gap-3">
              <div className="text-xs leading-tight">
                <div className="text-gray-400">A {fmtRs(totalA)} − B {fmtRs(totalB)}</div>
                <div className={`font-bold text-base ${pl < 0 ? 'text-red-600' : 'text-emerald-600'}`}>{pl < 0 ? '−' : ''}{fmtRs(Math.abs(pl))}</div>
              </div>
              <button onClick={submit} disabled={saving} className="btn btn-primary flex-1 h-12 text-base font-bold">
                {saving ? 'Filing…' : 'Submit DPR'}
              </button>
            </div>
          </div>
        </>
      )}

      {/* Add-item sheet */}
      {addOpen && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center sm:justify-center" onClick={() => setAddOpen(false)}>
          <div className="bg-white w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl max-h-[70vh] overflow-y-auto p-3" onClick={e => e.stopPropagation()}>
            <h4 className="font-semibold text-sm mb-2">Add BOQ item</h4>
            {poItems.filter(p => (p.remaining_qty ?? p.quantity) > 0).map(p => (
              <button key={p.id} type="button" onClick={() => addItem(p)}
                className="w-full text-left p-2.5 rounded-lg hover:bg-gray-50 border-b border-gray-50 text-sm">
                {p.description}
                <span className="block text-[10px] text-gray-400">Left: {p.remaining_qty ?? p.quantity} {p.unit}</span>
              </button>
            ))}
            {poItems.length === 0 && <p className="text-xs text-gray-400 p-3">Loading items…</p>}
          </div>
        </div>
      )}
    </div>
  );
}
