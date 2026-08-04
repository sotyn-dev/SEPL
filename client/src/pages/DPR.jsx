import { useState, useEffect, useRef } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import ResponsibilityTab from '../components/ResponsibilityTab';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMapPin, FiAlertTriangle, FiCheck, FiEye, FiTrash2, FiAlertCircle, FiDownload, FiCalendar, FiUsers, FiCamera, FiList, FiPackage } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import EngineerPerformance from '../components/EngineerPerformance';

// IST calendar date + Monday snap — SPOS rules run on India wall-clock
// (audit 2026-07-31: UTC dates misjudged everything between 00:00 and
// 05:30 IST, and a non-Monday week_start made plans invisible to the
// compliance grid / KPI lookups which key on Mondays).
const istTodayIso = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
const mondayOfIso = (iso) => {
  const d = new Date((iso || istTodayIso()) + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

// Mam (2026-05-30): the PO/BOQ rate is the FULL SITC value (Supply +
// Installation + Testing & Commissioning) and already includes labour.
// The DPR's Table A rate should carry only the labour portion, taken as
// 11% of the SITC rate (e.g. 1810 → 199.1). Until real labour rates are
// collected, this 11% is the agreed placeholder.
const LABOUR_RATE_PCT = 0.11;

const SYSTEMS = ['Electrical', 'Fire Fighting', 'Fire Alarm', 'CCTV', 'Access Control', 'PA System', 'Plumbing', 'HVAC', 'Solar', 'Networking', 'Combined'];

// Mam (2026-05-30): "MEPF System only :- Fire Fighting, Electrical,
// Low Voltage, Plumbing, HVAC, Solar advance radio type button".
// Tight 6-system list rendered as colour-coded chip radios instead
// of a free-form dropdown.  Each entry carries the Tailwind colour
// classes used when that chip is selected — pure CSS, no extra
// dependency.
const MEPF_SYSTEMS = [
  { key: 'Fire Fighting', icon: '🔥', sel: 'bg-red-600 text-white border-red-600',          dot: 'bg-red-500' },
  { key: 'Electrical',    icon: '⚡', sel: 'bg-yellow-500 text-white border-yellow-500',    dot: 'bg-yellow-400' },
  { key: 'Low Voltage',   icon: '📡', sel: 'bg-blue-600 text-white border-blue-600',        dot: 'bg-blue-500' },
  { key: 'Plumbing',      icon: '💧', sel: 'bg-cyan-600 text-white border-cyan-600',        dot: 'bg-cyan-500' },
  { key: 'HVAC',          icon: '❄️', sel: 'bg-indigo-600 text-white border-indigo-600',    dot: 'bg-indigo-500' },
  { key: 'Solar',         icon: '☀️', sel: 'bg-amber-500 text-white border-amber-500',      dot: 'bg-amber-400' },
];

// Mam (2026-05-30): "same radio button as weather type" — Weather
// becomes the same chip-radio shape as MEPF System.  Value stays
// lowercase (clear / rainy / …) for backward compat with existing
// DPR rows; only the display label is title-case.
const WEATHER_OPTIONS = [
  { key: 'clear',  label: 'Clear',  icon: '☀️',  sel: 'bg-yellow-500 text-white border-yellow-500', dot: 'bg-yellow-400' },
  { key: 'rainy',  label: 'Rainy',  icon: '🌧️', sel: 'bg-blue-600 text-white border-blue-600',     dot: 'bg-blue-500' },
  { key: 'cloudy', label: 'Cloudy', icon: '☁️',  sel: 'bg-gray-500 text-white border-gray-500',     dot: 'bg-gray-400' },
  { key: 'hot',    label: 'Hot',    icon: '🥵',  sel: 'bg-orange-600 text-white border-orange-600', dot: 'bg-orange-500' },
  { key: 'windy',  label: 'Windy',  icon: '💨',  sel: 'bg-teal-600 text-white border-teal-600',     dot: 'bg-teal-500' },
];
const EQUIPMENT_LIST = ['Welding Machine', 'Pipe Threading Machine', 'Drill Machine', 'Grinder', 'Ladder', 'Scaffolding', 'Pipe Bending Machine', 'Cable Pulling Machine', 'Multimeter', 'Megger', 'Earth Tester', 'Hydro Test Pump', 'Generator', 'Compressor'];

export default function DPR() {
  const { user, isAdmin, canEdit, canDelete, canApprove } = useAuth();
  const [tab, setTab] = useUrlTab('dashboard');
  const [reportFilter, setReportFilter] = useState(''); // when set by stat-card click, filters Daily Reports tab
  const [dateTouched, setDateTouched] = useState(false); // true once user explicitly picks a date
  const [summary, setSummary] = useState(null);
  const [dprs, setDprs] = useState([]);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [siteModal, setSiteModal] = useState(false);
  const [detailModal, setDetailModal] = useState(false);

  // Weekly planning modal (mam, 2026-05-16: "i want site eng fill
  // full week planning one day fill 7 days plaaning and actual per
  // day according to that").  Site eng picks site + Monday-of-week,
  // fills 7 rows of planned work/manpower/cost in one go.  Backend
  // creates 7 dpr stub rows; daily DPR submission then updates the
  // matching row by date.
  const [planModal, setPlanModal] = useState(false);
  const [planSiteId, setPlanSiteId] = useState('');
  const [planWeekStart, setPlanWeekStart] = useState(() => {
    // Default to NEXT Monday (IST) so today's plan stays untouched. The old
    // local-time + toISOString combo could land on a Sunday for IST users
    // between midnight and 05:30 (audit 2026-07-31).
    const d = new Date(istTodayIso() + 'T00:00:00Z');
    const day = d.getUTCDay();          // 0=Sun, 1=Mon, …, 6=Sat
    d.setUTCDate(d.getUTCDate() + (day === 0 ? 1 : (8 - day)));
    return d.toISOString().slice(0, 10);
  });
  const [planDays, setPlanDays] = useState([]); // 7-row array
  const [planSaving, setPlanSaving] = useState(false);
  // BOQ items for the picked site (mam, 2026-05-16: "planning giving
  // as per boq items").  Auto-fetched whenever planSiteId changes
  // so each row's "Planned Work" becomes a dropdown of real PO line
  // items + planned quantity.
  const [planBoqItems, setPlanBoqItems] = useState([]);

  // SPOS approval flow (mam 2026-07-29): saving a week plan submits it for
  // PM approval; approving runs the site-store stock check and auto-raises
  // a Material indent for the shortfall.
  const [planHeader, setPlanHeader] = useState(null);        // weekly_plans row for the open (site, week)
  const [planShortfall, setPlanShortfall] = useState(null);  // PM preview: planned vs stock vs to-indent
  const [planWeather, setPlanWeather] = useState(null);      // 7-day forecast strip (mam 2026-07-31)
  const [planActing, setPlanActing] = useState(false);
  const [pendingPlans, setPendingPlans] = useState([]);      // status='submitted' headers for the badge
  const [pendingPlansModal, setPendingPlansModal] = useState(false);

  // Friday cutoff = 3 days before the Monday week-start (SPOS: plan is
  // finalized every Friday). After it, saves are flagged LATE server-side.
  const planFridayCutoff = (weekStartIso) => {
    if (!weekStartIso) return '';
    const d = new Date(weekStartIso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - 3);
    return d.toISOString().slice(0, 10);
  };
  const planIsLate = planWeekStart && istTodayIso() > planFridayCutoff(planWeekStart);

  const loadPendingPlans = async () => {
    if (!canApprove('dpr')) return;
    try {
      const r = await api.get('/dpr/weekly-plans', { params: { status: 'submitted' } });
      setPendingPlans(Array.isArray(r.data) ? r.data : []);
    } catch { setPendingPlans([]); }
  };
  useEffect(() => { loadPendingPlans(); }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // Monotonic request id — openPlanWeek/loadPlanShortfall drop responses
  // that arrive after the PM has switched site/week, so a slow response
  // can never paint Site A's plan under Site B's selection (audit).
  const planReqSeq = useRef(0);
  const [planShortfallErr, setPlanShortfallErr] = useState(false);
  const loadPlanShortfall = async (planId, seq) => {
    setPlanShortfallErr(false);
    try {
      const r = await api.get(`/dpr/weekly-plans/${planId}/shortfall`);
      if (seq !== undefined && seq !== planReqSeq.current) return;
      setPlanShortfall(r.data);
    } catch {
      if (seq !== undefined && seq !== planReqSeq.current) return;
      setPlanShortfall(null);
      setPlanShortfallErr(true);
    }
  };

  const approveWeeklyPlan = async () => {
    if (!planHeader?.id) return;
    setPlanActing(true);
    try {
      const r = await api.post(`/dpr/weekly-plans/${planHeader.id}/approve`);
      toast.success(r.data?.message || 'Plan approved');
      await openPlanWeek(planSiteId, planWeekStart);   // refresh header + banner
      loadPendingPlans();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Approve failed');
    } finally { setPlanActing(false); }
  };

  const rejectWeeklyPlan = async () => {
    if (!planHeader?.id) return;
    const reason = window.prompt('Rejection reason (the site engineer will see this):');
    if (!reason || !reason.trim()) return;
    setPlanActing(true);
    try {
      await api.post(`/dpr/weekly-plans/${planHeader.id}/reject`, { reason: reason.trim() });
      toast.success('Plan rejected');
      await openPlanWeek(planSiteId, planWeekStart);
      loadPendingPlans();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Reject failed');
    } finally { setPlanActing(false); }
  };

  // Rebuild the 7-row scaffold whenever the week-start changes.
  // Pre-loads any existing planned values via the week-view endpoint
  // so re-opening the modal shows what's already saved.
  const openPlanWeek = async (siteId, weekStartIso) => {
    // Snap to Monday — the server now rejects non-Monday week starts, and
    // every compliance/KPI lookup keys on the Monday (audit 2026-07-31).
    const week = mondayOfIso(weekStartIso || planWeekStart);
    const seq = ++planReqSeq.current;
    setPlanSiteId(siteId || '');
    setPlanWeekStart(week);
    setPlanModal(true);
    setPlanBoqItems([]);
    setPlanHeader(null);
    setPlanShortfall(null);
    setPlanShortfallErr(false);
    weekStartIso = week;   // downstream code uses weekStartIso || planWeekStart
    // Build 7 day slots.  `items` is the per-day list of BOQ
    // line plans (multi-item, mam 2026-05-16: "in one day multiple
    // boq item have").  Each entry: { po_item_id, planned_qty }.
    const slots = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartIso || planWeekStart);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      slots.push({ date, planned_manpower: 0, planned_grand_total_b: 0, items: [] });
    }
    setPlanDays(slots);
    if (siteId) {
      // Load BOQ items for this site so each row can pick from them.
      try {
        const r = await api.get(`/dpr/sites/${siteId}/po-items`);
        if (seq !== planReqSeq.current) return;   // selection changed mid-flight
        const items = Array.isArray(r.data) ? r.data : (r.data?.items || []);
        setPlanBoqItems(items);
      } catch { setPlanBoqItems([]); }
      // 7-day weather forecast (mam 2026-07-31): barish wale din indoor
      // kaam plan karo. Best-effort — the strip hides on failure.
      setPlanWeather(null);
      api.get(`/dpr/sites/${siteId}/weather`)
        .then(r => { if (seq === planReqSeq.current) setPlanWeather(r.data?.available ? r.data : null); })
        .catch(() => setPlanWeather(null));
      // Pre-fill existing planned values for the week.
      try {
        const r = await api.get('/dpr/week-view', { params: { site_id: siteId, week_start: weekStartIso || planWeekStart } });
        if (seq !== planReqSeq.current) return;   // selection changed mid-flight
        // SPOS approval header + PM shortfall preview
        const hdr = r.data?.plan || null;
        setPlanHeader(hdr);
        if (hdr && hdr.status === 'submitted' && canApprove('dpr')) loadPlanShortfall(hdr.id, seq);
        const byDate = Object.fromEntries((r.data?.days || []).map(d => [d.report_date, d]));
        setPlanDays(slots.map(s => {
          const existing = byDate[s.date];
          if (!existing) return s;
          return {
            date: s.date,
            planned_manpower: existing.planned_manpower || 0,
            planned_grand_total_b: existing.grand_total_b || 0,
            items: (existing.items || []).map(it => ({
              po_item_id: it.po_item_id,
              planned_qty: it.planned_qty || 0,
            })),
          };
        }));
      } catch { /* fall back to empty slots */ }
    }
  };

  // Helpers for the multi-item rows
  const addPlanItem = (dayIdx) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: [...(d.items || []), { po_item_id: '', planned_qty: 0 }] } : d));
  const removePlanItem = (dayIdx, itemIdx) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: d.items.filter((_, j) => j !== itemIdx) } : d));
  const updatePlanItem = (dayIdx, itemIdx, patch) => setPlanDays(prev => prev.map((d, i) =>
    i === dayIdx ? { ...d, items: d.items.map((it, j) => j === itemIdx ? { ...it, ...patch } : it) } : d));

  const updatePlanDay = (i, patch) => {
    setPlanDays(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  };

  const savePlanWeek = async () => {
    if (!planSiteId) { toast.error('Pick a site first'); return; }
    setPlanSaving(true);
    try {
      const r = await api.post('/dpr/plan-week', { site_id: planSiteId, week_start: planWeekStart, days: planDays });
      toast.success(`Week plan saved — sent for PM approval${r.data.submitted_late ? ' (flagged LATE — after Friday cutoff)' : ''}`);
      setPlanModal(false);
      load();
      loadPendingPlans();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally {
      setPlanSaving(false);
    }
  };
  const [selectedDpr, setSelectedDpr] = useState(null);
  const [viewStaff, setViewStaff] = useState(null); // attendance-filtered staff breakdown for the viewed DPR
  const [form, setForm] = useState({});
  // Table A: Installation items from PO
  const [workItems, setWorkItems] = useState([]);
  // Phase 4 (mam 2026-06-02): active Work Orders across all projects.
  // Each Table-A row can optionally pick the WO its work belongs to —
  // the dpr_work_items.work_order_id link feeds the Indent Labour
  // Payment dashboard's contractor-progress rollup.
  const [activeWorkOrders, setActiveWorkOrders] = useState([]);
  // Table B: Costs — Skilled @ Rs 800/qty, Helper @ Rs 500/qty (fixed company rates)
  // Staff Cost rate is auto-pulled from the SITE's PO engineers (sum of their
  // monthly salary / 30). Individual salaries are never exposed to the client.
  const [costs, setCosts] = useState([
    { type: 'Skilled Manpower', qty: 0, rate: 800, amount: 0, fixed: true },
    { type: 'Helper', qty: 0, rate: 500, amount: 0, fixed: true },
    { type: 'Rental Cost', qty: 0, rate: 0, amount: 0 },
    { type: 'Staff Cost', qty: 1, rate: 0, amount: 0, auto: true, engineer_count: 0 },
    { type: 'TA/DA', qty: 1, rate: 0, amount: 0, auto: true, ta_da_count: 0 },
  ]);
  const [machinery, setMachinery] = useState([{ equipment: '', quantity: 1, hours_used: 0, condition: 'working' }]);
  // SPOS (mam 2026-07-29): materials consumed today, auto-loaded from the
  // site store. Engineer only types the consumed qty; submit auto-OUTs the
  // stock (dpr_material + stock_movements DPR_CONSUMPTION, server-side).
  const [dprMaterials, setDprMaterials] = useState([]);
  const [dprStoreName, setDprStoreName] = useState(null);
  const [dprStoreErr, setDprStoreErr] = useState(false);
  // Merges live store stock with today's Issue/Return slip totals (mam
  // 2026-07-31): items with slips get consumed = issued − returned,
  // READ-ONLY (from_slips) — the jr. engineer's slips are the source of
  // truth, nobody re-types stock numbers.
  const loadStoreStock = (siteId, dateIso) => {
    if (!siteId) { setDprMaterials([]); setDprStoreName(null); setDprStoreErr(false); return; }
    setDprStoreErr(false);
    const date = dateIso || form.report_date || filterDate;
    Promise.all([
      api.get(`/dpr/sites/${siteId}/store-stock`),
      api.get(`/dpr/sites/${siteId}/consumption`, { params: { date } }).catch(() => ({ data: { lines: [] } })),
    ]).then(([r, c]) => {
      setDprStoreName(r.data?.store?.name || null);
      const byId = new Map();
      (r.data?.items || []).forEach(it => byId.set(it.item_master_id, {
        item_master_id: it.item_master_id,
        material_name: [it.item_name, it.specification, it.size].filter(Boolean).join(' '),
        unit: it.uom || 'nos',
        stock_qty: +it.stock_qty || 0,
        issued_today: 0, returned_today: 0, consumed_today: 0, from_slips: false,
      }));
      (c.data?.lines || []).forEach(l => {
        const row = byId.get(l.item_master_id) || {
          item_master_id: l.item_master_id,
          material_name: l.item_name || `Item #${l.item_master_id}`,
          unit: l.unit || 'nos', stock_qty: 0,
          issued_today: 0, returned_today: 0, consumed_today: 0, from_slips: false,
        };
        row.issued_today = l.issued;
        row.returned_today = l.returned;
        if (l.issued > 0) { row.consumed_today = l.net_consumed; row.from_slips = true; }
        byId.set(l.item_master_id, row);
      });
      setDprMaterials([...byId.values()]);
    }).catch(() => { setDprMaterials([]); setDprStoreName(null); setDprStoreErr(true); });
  };

  // ── Site-store Issue / Return slip modal (jr. site engineer's counter) ──
  const [slipModal, setSlipModal] = useState(false);
  const [slipType, setSlipType] = useState('issue');
  const [slipSite, setSlipSite] = useState('');
  const [slipDate, setSlipDate] = useState(istTodayIso());
  const [slipTo, setSlipTo] = useState('');
  const [slipNotes, setSlipNotes] = useState('');
  const [slipRows, setSlipRows] = useState([]);      // {item_master_id, name, unit, cap, qty}
  const [slipBusy, setSlipBusy] = useState(false);
  const [slipsToday, setSlipsToday] = useState([]);  // register for the picked site+date

  const loadSlipRows = async (siteId, type, dateIso) => {
    if (!siteId) { setSlipRows([]); setSlipsToday([]); return; }
    try {
      if (type === 'issue') {
        // Issue caps = live store stock. Suggested qty = today's PLANNED
        // requirement minus what's already issued (mam 2026-07-31: "jr.
        // engineer simply issues the suggested material"). Age chips show
        // the 15/30-day inventory ageing rule.
        const [r, tp, boq] = await Promise.all([
          api.get(`/dpr/sites/${siteId}/store-stock`),
          api.get(`/dpr/sites/${siteId}/today-plan`, { params: { date: dateIso } }).catch(() => ({ data: { items: [] } })),
          api.get(`/dpr/sites/${siteId}/po-items`).catch(() => ({ data: [] })),
        ]);
        const plannedByItem = new Map();
        (tp.data?.items || []).forEach(p => {
          if (!p.item_master_id) return;
          const prev = plannedByItem.get(p.item_master_id) || { planned: 0, issued: 0 };
          prev.planned += +p.planned_qty || 0;
          prev.issued = Math.max(prev.issued, +p.issued_today || 0);
          plannedByItem.set(p.item_master_id, prev);
        });
        const rows = new Map();
        (r.data?.items || []).forEach(it => {
          const sug = plannedByItem.get(it.item_master_id);
          const remaining = sug ? Math.max(0, sug.planned - sug.issued) : 0;
          const suggest = Math.min(remaining, +it.stock_qty || 0);
          rows.set(it.item_master_id, {
            item_master_id: it.item_master_id,
            name: [it.item_name, it.specification, it.size].filter(Boolean).join(' '),
            unit: it.uom || 'nos', cap: +it.stock_qty || 0,
            planned_today: sug ? +(sug.planned).toFixed(3) : 0,
            age_days: it.age_days, age_status: it.age_status,
            qty: suggest > 0 ? +suggest.toFixed(3) : '',
          });
        });
        // Mam (2026-08-03, "where is items and qty with unit"): the item
        // list must ALWAYS be visible — BOQ-mapped items with zero stock
        // show as "0 in store" (input disabled) instead of hiding the
        // whole table behind an empty-store message.
        const boqItems = Array.isArray(boq.data) ? boq.data : (boq.data?.items || []);
        boqItems.forEach(b => {
          if (!b.item_master_id || rows.has(b.item_master_id)) return;
          const sug = plannedByItem.get(b.item_master_id);
          rows.set(b.item_master_id, {
            item_master_id: b.item_master_id,
            name: [b.master_name, b.master_specification, b.master_size].filter(Boolean).join(' ') || b.description,
            unit: b.master_uom || b.unit || 'nos', cap: 0,
            planned_today: sug ? +(sug.planned).toFixed(3) : 0,
            age_days: null, age_status: 'unknown',
            qty: '',
          });
        });
        setSlipRows([...rows.values()].sort((a, b) => (b.cap - a.cap) || a.name.localeCompare(b.name)));
      } else {
        // Return caps = issued today − already returned
        const r = await api.get(`/dpr/sites/${siteId}/consumption`, { params: { date: dateIso } });
        setSlipRows((r.data?.lines || [])
          .filter(l => (l.issued - l.returned) > 0)
          .map(l => ({
            item_master_id: l.item_master_id, name: l.item_name || `Item #${l.item_master_id}`,
            unit: l.unit || 'nos', cap: +(l.issued - l.returned).toFixed(3), qty: '',
          })));
      }
      const sl = await api.get('/dpr/site-slips', { params: { site_id: siteId, date: dateIso } });
      setSlipsToday(sl.data || []);
    } catch { setSlipRows([]); setSlipsToday([]); }
  };
  const [slipShift, setSlipShift] = useState('day');
  const autoSlipShift = () => {
    const h = +new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    return (h >= 9 && h < 18) ? 'day' : (h >= 18 && h < 22) ? 'evening' : 'night';
  };
  const openSlipModal = (siteId) => {
    const today = istTodayIso();
    setSlipModal(true); setSlipType('issue'); setSlipSite(siteId || '');
    setSlipDate(today); setSlipTo(''); setSlipNotes(''); setSlipRows([]); setSlipsToday([]);
    setSlipShift(autoSlipShift());
    if (siteId) loadSlipRows(siteId, 'issue', today);
  };
  const saveSlip = async () => {
    const items = slipRows.filter(r => +r.qty > 0).map(r => ({ item_master_id: r.item_master_id, quantity: +r.qty }));
    if (!slipSite) return toast.error('Pick a site first');
    if (!items.length) return toast.error('Enter a quantity on at least one item');
    if (!slipTo.trim()) return toast.error(slipType === 'issue' ? 'Issued To is required — who is taking the material?' : 'Returned By is required');
    const over = slipRows.find(r => +r.qty > 0 && +r.qty > r.cap);
    if (over) return toast.error(`${over.name}: max ${over.cap} ${slipType === 'issue' ? 'in stock' : 'outstanding'}`);
    setSlipBusy(true);
    try {
      const r = await api.post('/dpr/site-slips', { site_id: slipSite, slip_type: slipType, slip_date: slipDate, issued_to: slipTo.trim(), notes: slipNotes, shift: slipShift, items });
      toast.success(`${r.data.slip_number} saved — opening print`);
      window.open(`/site-slip/${r.data.id}/print`, '_blank');
      loadSlipRows(slipSite, slipType, slipDate);
      setSlipTo(''); setSlipNotes('');
      if (String(form.site_id || '') === String(slipSite)) loadStoreStock(slipSite);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save slip');
    } finally { setSlipBusy(false); }
  };
  // Mam: 'AT LEAST OPTION OF 5 CONTRACTOR' — start with 5 blank rows; "+ Add"
  // appends more, "×" removes (only when more than 5). Empty rows are
  // dropped server-side so we never save junk.
  const [contractors, setContractors] = useState(() => [{ name: '', manpower: 0 }]);
  // Morning Manpower punch (mam 2026-06-22): site engineer records contractor
  // attendance in the morning; it pre-fills the DPR "Contractors on Site".
  const [mmModal, setMmModal] = useState(false);
  const [mmSite, setMmSite] = useState('');
  const [mmDate, setMmDate] = useState(new Date().toISOString().split('T')[0]);
  const [mmRows, setMmRows] = useState([{ name: '', manpower: 0, subcontractor_id: null, contractor_type: '' }]);
  const [mmBusy, setMmBusy] = useState(false);
  // Attendance Records view (mam 2026-06-24) — a register of all saved
  // morning-manpower across sites/dates.
  const [mmRecModal, setMmRecModal] = useState(false);
  const [mmRecRows, setMmRecRows] = useState([]);
  const [mmRecBusy, setMmRecBusy] = useState(false);
  const [mmRecSite, setMmRecSite] = useState('');
  const [mmRecFrom, setMmRecFrom] = useState('');
  const [mmRecTo, setMmRecTo] = useState('');
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const [poItemsForSite, setPoItemsForSite] = useState([]);
  // Server-side diagnostic when po_items can't be fetched (no BB, no
  // items, or rates not set). Surfaced as a yellow banner above the
  // work items grid so mam knows exactly what to fix.
  const [poItemsDiag, setPoItemsDiag] = useState(null);
  // Sub-contractor master list for the DPR contractor-name picker.
  // Mam (2026-05-30): "contractor name drop down from master sub-
  // contactor".  Lazy-loaded the first time the DPR submit modal opens
  // (engineers won't hit the lookup endpoint while just browsing DPRs).
  const [subcons, setSubcons] = useState([]);
  const [progress, setProgress] = useState([]);
  const [expandedSite, setExpandedSite] = useState({}); // { "engineerId-siteId": true }
  // Progress widget grouping — 'engineer' (default) or 'site'. Mam
  // (2026-05-30): "not particular user name wise — set here site name of
  // completion." Site view dedupes the same site shown under multiple
  // engineers and lists each site once with its completion.
  const [progressView, setProgressView] = useState('engineer');

  // Mam (2026-05-29): "erp is hange make it lite".  The page used to
  // fire ALL FIVE endpoints in parallel on mount AND block the whole
  // page on `if (!summary) Loading...` until the slowest one (the
  // BOQ-progress widget — N×M×K SUM queries) returned.  Now each tab
  // fetches only what it needs, and load() refreshes only the slices
  // already in scope so submit/approve/delete actions don't re-fire
  // dormant tabs.
  const loadSummary  = () => api.get('/dpr/summary').then(r => setSummary(r.data)).catch(() => {});
  const loadSites    = () => api.get('/dpr/sites').then(r => setSites(r.data)).catch(() => {});
  const loadUsers    = () => api.get('/auth/users?active_only=1').then(r => setUsers(r.data)).catch(() => {});
  const loadDprs     = () => {
    const params = (reportFilter && !dateTouched) ? {} : { date: filterDate };
    return api.get('/dpr', { params }).then(r => setDprs(r.data)).catch(() => {});
  };
  const loadProgress = () => api.get('/dpr/progress').then(r => setProgress(r.data)).catch(() => setProgress([]));

  // Refresh whatever is already on screen.  Called after submit /
  // approve / delete actions.  Doesn't pull dormant tabs into scope.
  const load = () => {
    loadSummary();
    loadSites();              // always needed: site picker in submit modal
    loadUsers();               // always needed: engineer picker in site modal
    if (tab === 'reports' || dprs.length)   loadDprs();
    if (tab === 'dashboard' || progress.length) loadProgress();
  };
  // Mount: pull only the always-needed bits (summary tiles + sites
  // picker + users for the Site modal) so the page paints instantly.
  // Heavy slices (BOQ progress, DPR list) come in via the tab-change
  // effect below — only when that tab is actually opened.
  useEffect(() => {
    loadSummary();
    loadSites();
    loadUsers();
    // Phase 4 — load active Work Orders once on mount so the work-item
    // picker has data the first time mam expands the submit modal.
    // Best-effort fetch: if mam doesn't have indent_labour_payment.view
    // permission, the catch silently falls back to an empty list (the
    // WO picker simply doesn't render — DPR still saves as before).
    api.get('/indent-labour-payment/active-work-orders')
      .then(r => setActiveWorkOrders(r.data || []))
      .catch(() => setActiveWorkOrders([]));
  }, []);

  // DPR list refetches whenever the date / status filter changes — but
  // ONLY if the user is on (or has visited) the Daily Reports tab.
  useEffect(() => {
    if (tab === 'reports' || dprs.length) loadDprs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterDate, reportFilter, dateTouched, tab]);

  // Heavy BOQ-progress widget loads only when the dashboard tab is
  // active (and once loaded, refreshes on subsequent dashboard visits
  // via the same effect re-firing).  This is the single biggest
  // reason the page used to hang at "Loading...".
  useEffect(() => {
    if (tab === 'dashboard' && progress.length === 0) loadProgress();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  // Auto-pull Staff Cost by NAME, attendance-filtered for the report date (mam
  // 2026-06-30). Keyed on site + date so it refreshes when either changes — staff
  // who didn't mark attendance that day are dropped from the cost.
  useEffect(() => {
    const siteId = form.site_id; const scDate = form.report_date || filterDate || '';
    if (!siteId) return;
    api.get(`/dpr/sites/${siteId}/staff-cost`, { params: scDate ? { date: scDate } : {} }).then(r => {
      const { per_day_cost = 0, engineer_count = 0, po_engineers = 0, diagnostic = null, staff = [] } = r.data || {};
      setCosts(prev => prev.map(c => c.type === 'Staff Cost'
        ? { ...c, rate: per_day_cost, engineer_count, po_engineers, auto: per_day_cost > 0, diagnostic, staff, amount: (c.qty || 0) * per_day_cost }
        : c));
    }).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.site_id, form.report_date]);

  const handleSiteSelect = (siteId) => {
    setForm(f => ({ ...f, site_id: siteId }));
    setWorkItems([]);
    if (siteId) {
      // Response is now { items, diagnostic, total_count } — older format
      // was a bare array. Handle both for robustness.
      api.get(`/dpr/sites/${siteId}/po-items`).then(r => {
        if (Array.isArray(r.data)) {
          setPoItemsForSite(r.data);
          setPoItemsDiag(null);
        } else {
          setPoItemsForSite(r.data?.items || []);
          setPoItemsDiag(r.data?.diagnostic || null);
        }
      }).catch(() => { setPoItemsForSite([]); setPoItemsDiag(null); });
      // Staff Cost is auto-pulled in a dedicated effect keyed on site + date, so
      // it refreshes when the report date changes (attendance differs per day).
      // Auto-fill TA/DA from approved payment_requests for this site (mam:
      // 'according to site TA/DA that site show here automatically which we
      // fill in payment category TA/DA only'). Engineer can still edit if
      // the figure is wrong.
      api.get(`/dpr/sites/${siteId}/ta-da-cost`).then(r => {
        const { total_amount = 0, count = 0 } = r.data || {};
        setCosts(prev => prev.map(c => c.type === 'TA/DA'
          ? { ...c, qty: 1, rate: total_amount, amount: total_amount, auto: total_amount > 0, ta_da_count: count }
          : c));
      }).catch(() => {});
      // Pre-fill "Contractors on Site" from the morning manpower punch for this
      // site + date (mam 2026-06-22). Only fills when the engineer hasn't already
      // typed contractors, so it never clobbers in-progress edits.
      api.get('/dpr/contractor-attendance', { params: { site_id: siteId, date: form.report_date || filterDate } })
        .then(r => {
          const rows = r.data || [];
          if (!rows.length) return;
          setContractors(prev => (prev.some(c => c.name && c.name.trim())
            ? prev
            : rows.map(x => ({ name: x.contractor_name, manpower: x.manpower }))));
        }).catch(() => {});
      // SPOS: auto-load the site store so Material Consumed is pick-a-number,
      // not free-typing (keeps the stock ledger honest).
      loadStoreStock(siteId);
    } else { setPoItemsForSite([]); setPoItemsDiag(null); setDprMaterials([]); setDprStoreName(null); }
  };

  // ── Morning Manpower (contractor attendance) handlers ──────────────────
  const loadMorningManpower = (siteId, date) => {
    if (!siteId || !date) { setMmRows([{ name: '', manpower: 0 }]); return; }
    api.get('/dpr/contractor-attendance', { params: { site_id: siteId, date } })
      .then(r => {
        const rows = r.data || [];
        setMmRows(rows.length
          ? rows.map(x => ({ name: x.contractor_name, manpower: x.manpower, subcontractor_id: x.subcontractor_id, contractor_type: x.contractor_type, photo_url: x.photo_url }))
          : [{ name: '', manpower: 0 }]);
      }).catch(() => setMmRows([{ name: '', manpower: 0 }]));
  };
  const openMorningManpower = () => {
    const site = form.site_id || '';
    setMmSite(site);
    setMmDate(filterDate);
    if (subcons.length === 0) api.get('/sub-contractors/lookup').then(r => setSubcons(r.data || [])).catch(() => {});
    loadMorningManpower(site, filterDate);
    setMmModal(true);
  };
  // Upload a contractor's gang photo and let AI count the people → manpower.
  const countFromPhoto = async (i, file) => {
    if (!file) return;
    const setRow = (patch) => setMmRows(rows => rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setRow({ counting: true });
    try {
      const fd = new FormData(); fd.append('file', file);
      const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const photo_url = up.data.url;
      setRow({ photo_url });
      const r = await api.post('/dpr/contractor-attendance/count-photo', { photo_url });
      setRow({ manpower: r.data.count, counting: false });
      toast.success(`AI counted ${r.data.count} people from the photo`);
    } catch (e) {
      setRow({ counting: false });
      toast.error(e.response?.data?.error || 'Photo head-count failed');
    }
  };
  const saveMorningManpower = async () => {
    if (!mmSite) return toast.error('Pick a site');
    if (!mmDate) return toast.error('Pick a date');
    setMmBusy(true);
    try {
      const rows = mmRows
        .filter(r => r.name && r.name.trim())
        .map(r => ({ contractor_name: r.name.trim(), manpower: +r.manpower || 0, subcontractor_id: r.subcontractor_id || null, contractor_type: r.contractor_type || null, photo_url: r.photo_url || null }));
      await api.post('/dpr/contractor-attendance', { site_id: mmSite, date: mmDate, rows });
      const total = rows.reduce((s, r) => s + (+r.manpower || 0), 0);
      toast.success(`Morning manpower saved — ${rows.length} contractor(s), ${total} manpower`);
      setMmModal(false);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to save'); }
    finally { setMmBusy(false); }
  };
  // Load the saved contractor-attendance register (optionally filtered).
  const loadAttendanceRecords = (filters = {}) => {
    setMmRecBusy(true);
    const params = {};
    const site = 'site' in filters ? filters.site : mmRecSite;
    const from = 'from' in filters ? filters.from : mmRecFrom;
    const to = 'to' in filters ? filters.to : mmRecTo;
    if (site) params.site_id = site;
    if (from) params.from = from;
    if (to) params.to = to;
    api.get('/dpr/contractor-attendance/records', { params })
      .then(r => setMmRecRows(r.data || []))
      .catch(() => setMmRecRows([]))
      .finally(() => setMmRecBusy(false));
  };
  const openAttendanceRecords = () => { setMmRecModal(true); loadAttendanceRecords({ site: '', from: '', to: '' }); };

  const addWorkItem = () => setWorkItems([...workItems, { po_item_id: '', description: '', qty: 0, location: '', rate: 0, amount: 0 }]);
  const removeWorkItem = (i) => setWorkItems(workItems.filter((_, idx) => idx !== i));
  const selectWorkItem = (i, poItemId) => {
    const item = poItemsForSite.find(p => p.id === +poItemId);
    const n = [...workItems];
    n[i].po_item_id = +poItemId || '';
    n[i].description = item?.description || '';
    n[i].unit = item?.unit || 'nos';
    n[i].boq_qty = item?.quantity || 0;
    n[i].remaining_qty = item?.remaining_qty ?? item?.quantity ?? 0;
    n[i].filled_qty = item?.filled_qty || 0;
    // Auto-fill the DPR rate from the PO item. The PO rate is the full
    // SITC value (incl. labour); the DPR carries only the labour portion
    // = 11% of SITC (LABOUR_RATE_PCT). Keep the original SITC on the row
    // so the UI can show "11% of SITC ₹X". Rate can still be overridden.
    if (item) {
      const sitc = +item.rate || 0;
      n[i].sitc_rate = sitc;
      n[i].rate = Math.round(sitc * LABOUR_RATE_PCT * 100) / 100;
      n[i].amount = (+n[i].qty || 0) * n[i].rate;
    }
    setWorkItems(n);
  };
  const updateWork = (i, field, val) => {
    const n = [...workItems];
    n[i][field] = val;
    if (field === 'qty' || field === 'rate') n[i].amount = (n[i].qty || 0) * (n[i].rate || 0);
    setWorkItems(n);
  };
  const updateCost = (i, field, val) => {
    const n = [...costs];
    // Block manual rate edits on fixed-rate rows (Skilled 800, Helper 500)
    if (field === 'rate' && n[i].fixed) return;
    n[i][field] = val;
    if (field === 'qty' || field === 'rate') n[i].amount = (n[i].qty || 0) * (n[i].rate || 0);
    setCosts(n);
  };

  const grandTotalA = workItems.reduce((s, w) => s + (w.amount || 0), 0);
  const grandTotalB = costs.reduce((s, c) => s + (c.amount || 0), 0);
  const profitLoss = grandTotalA - grandTotalB;

  // Render one expandable site row (BOQ vs DPR-consumed). Shared by the
  // engineer-grouped view and the site-name view so both stay in sync.
  // `key` is the unique expand-state key; `subLabel` (optional) shows the
  // assigned engineer(s) in the site view.
  const renderSiteRow = (site, key, subLabel) => {
    const expanded = !!expandedSite[key];
    const barColor = site.overall_pct >= 90 ? 'bg-emerald-500' : site.overall_pct >= 50 ? 'bg-red-500' : site.overall_pct >= 20 ? 'bg-amber-500' : 'bg-red-400';
    return (
      <div key={key}>
        <button
          type="button"
          onClick={() => setExpandedSite(s => ({ ...s, [key]: !s[key] }))}
          className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left"
        >
          <span className="text-gray-400 text-xs">{expanded ? '▼' : '▶'}</span>
          <div className="flex-1 min-w-0">
            <div className="font-semibold text-sm truncate">{site.site_name}</div>
            <div className="text-[11px] text-gray-500 truncate">{site.client_name || ''} · {site.item_count} BOQ items{subLabel ? ` · 👷 ${subLabel}` : ''}</div>
          </div>
          <div className="hidden md:block w-40">
            <div className="h-2.5 bg-gray-200 rounded-full overflow-hidden">
              <div className={`h-full ${barColor} transition-all`} style={{ width: `${Math.min(100, site.overall_pct)}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 text-right mt-0.5">
              Rs {site.total_done_amount.toLocaleString()} / Rs {site.total_boq_amount.toLocaleString()}
            </div>
          </div>
          <div className="w-16 text-right">
            <span className={`text-base font-bold ${site.overall_pct >= 90 ? 'text-emerald-600' : site.overall_pct >= 50 ? 'text-red-600' : site.overall_pct >= 20 ? 'text-amber-600' : 'text-red-500'}`}>
              {site.overall_pct}%
            </span>
          </div>
        </button>
        {expanded && (
          <div className="bg-gray-50/60 px-3 py-2">
            {site.items.length === 0 ? (
              <p className="text-xs text-gray-400 py-2">No BOQ items linked to this site yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b">
                      <th className="px-2 py-1.5 text-left">BOQ Item</th>
                      <th className="px-2 py-1.5 text-center">Unit</th>
                      <th className="px-2 py-1.5 text-right">BOQ Qty</th>
                      <th className="px-2 py-1.5 text-right">Done</th>
                      <th className="px-2 py-1.5 text-right">Remaining</th>
                      <th className="px-2 py-1.5 text-left w-36">Progress</th>
                      <th className="px-2 py-1.5 text-right">%</th>
                    </tr>
                  </thead>
                  <tbody>
                    {site.items.map(it => {
                      const ib = it.pct_complete >= 100 ? 'bg-emerald-500' : it.pct_complete >= 50 ? 'bg-red-500' : it.pct_complete >= 20 ? 'bg-amber-500' : 'bg-red-400';
                      return (
                        <tr key={it.po_item_id} className="border-b last:border-0 hover:bg-white">
                          <td className="px-2 py-1 whitespace-normal break-words leading-snug max-w-md">{it.description}</td>
                          <td className="px-2 py-1 text-center text-gray-500">{it.unit || '-'}</td>
                          <td className="px-2 py-1 text-right font-mono">{it.boq_qty}</td>
                          <td className="px-2 py-1 text-right font-mono text-emerald-700 font-semibold">{it.done_qty}</td>
                          <td className="px-2 py-1 text-right font-mono text-red-600">{it.remaining_qty}</td>
                          <td className="px-2 py-1">
                            <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                              <div className={`h-full ${ib}`} style={{ width: `${Math.min(100, it.pct_complete)}%` }} />
                            </div>
                          </td>
                          <td className="px-2 py-1 text-right font-semibold">{it.pct_complete}%</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  // Flatten engineer→sites into a deduped site-name list for the "By Site"
  // view. The same site shown under several engineers collapses to one row
  // (identical completion); we collect the engineer name(s) for the label.
  const siteRowsByName = (() => {
    const m = new Map();
    for (const eng of progress) {
      for (const site of (eng.sites || [])) {
        const k = site.site_name;
        if (!m.has(k)) m.set(k, { site, engineers: new Set() });
        if (eng.engineer?.name) m.get(k).engineers.add(eng.engineer.name);
      }
    }
    return [...m.values()]
      .map(({ site, engineers }) => ({ ...site, engineerNames: [...engineers].join(', ') }))
      .sort((a, b) => a.site_name.localeCompare(b.site_name));
  })();

  const submitDpr = async (e) => {
    e.preventDefault();
    // Over-stock guard (audit 2026-07-31): the server silently skips the
    // stock cut when consumed > stock — block it here so the ledger and
    // the DPR never diverge without the engineer knowing.
    const over = dprMaterials.find(m => !m.from_slips && +m.consumed_today > 0 && +m.consumed_today > +m.stock_qty);
    if (over) return toast.error(`${over.material_name}: consumed ${over.consumed_today} is more than the ${over.stock_qty} in store. Correct the qty, or record the extra material IN first.`);
    try {
      await api.post('/dpr', {
        ...form,
        work_items: workItems.filter(w => w.po_item_id || w.description),
        manpower: costs.filter(c => c.qty > 0 || c.amount > 0),
        machinery: machinery.filter(m => m.equipment),
        // SPOS: only rows the engineer actually consumed; server auto-OUTs
        // the site-store stock per row (DPR_CONSUMPTION movements).
        materials: dprMaterials.filter(m => +m.consumed_today > 0).map(m => ({
          item_master_id: m.item_master_id,
          material_name: m.material_name,
          unit: m.unit,
          consumed_today: +m.consumed_today,
          cumulative_consumed: +m.consumed_today,
          // Slip rows: stock already moved at issue/return time — the flag
          // tells the server NOT to auto-OUT again (double-count guard).
          from_slips: m.from_slips ? 1 : 0,
          balance_qty: m.from_slips ? (+m.stock_qty || 0) : Math.max(0, (+m.stock_qty || 0) - (+m.consumed_today || 0)),
        })),
        contractors: contractors.filter(c => (c.name && c.name.trim()) || c.manpower > 0),
        grand_total_a: grandTotalA,
        grand_total_b: grandTotalB,
        profit_loss: profitLoss
      });
      toast.success('DPR submitted!'); setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const createSite = async (e) => { e.preventDefault(); await api.post('/dpr/sites', form); toast.success('Site created'); setSiteModal(false); load(); };
  const approveDpr = async (id, status, billingReady) => { await api.put(`/dpr/${id}/approve`, { approval_status: status, billing_ready: billingReady }); toast.success(`DPR ${status}`); load(); };
  const viewDpr = async (id) => {
    setViewStaff(null);
    const { data } = await api.get(`/dpr/${id}`);
    setSelectedDpr(data); setDetailModal(true);
    // Recompute the staff cost by name, attendance-filtered for this DPR's date,
    // so old + new DPRs both show who was counted (mam 2026-06-30).
    if (data?.site_id) {
      api.get(`/dpr/sites/${data.site_id}/staff-cost`, { params: data.report_date ? { date: data.report_date } : {} })
        .then(r => setViewStaff(r.data || null)).catch(() => setViewStaff(null));
    }
  };

  // Mam (2026-05-29): we used to gate the WHOLE page on `summary`
  // here — meaning the toolbar didn't even render until /dpr/summary
  // returned.  Now we paint immediately and the Dashboard tab below
  // shows a thin skeleton while summary loads.

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap">
          {/* SPOS: PM's pending-approvals badge lives beside the tabs so it's
              visible on EVERY tab — the page defaults to Dashboard and a
              reports-tab-only badge went unseen (audit 2026-07-31). */}
          {canApprove('dpr') && pendingPlans.length > 0 && (
            <button onClick={() => setPendingPlansModal(true)}
              className="btn btn-secondary flex items-center gap-2 !border-amber-400 !text-amber-700 order-last">
              <FiCalendar /> Plan Approvals
              <span className="bg-amber-500 text-white rounded-full px-1.5 text-[10px] font-bold">{pendingPlans.length}</span>
            </button>
          )}
          {['dashboard', 'aaj', 'reports', 'compliance', 'sites', 'losses', 'responsible'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
              {t === 'dashboard' ? 'Dashboard'
                : t === 'aaj' ? '🏗️ Aaj Ka Update'
                : t === 'reports' ? 'Daily Reports'
                : t === 'compliance' ? 'Engineer Compliance'
                : t === 'sites' ? 'Sites'
                : t === 'losses' ? 'Loss Reasons'
                : 'Responsible'}
            </button>
          ))}
          {/* Always-visible morning contractor-attendance punch (mam 2026-06-22:
              "where is attendance of contractor" — was hidden on the Reports tab). */}
          <button onClick={openMorningManpower}
            className="btn btn-secondary flex items-center gap-2 ml-auto"
            title="Record contractor manpower attendance (morning punch)">
            <FiUsers /> Contractor Attendance
          </button>
        </div>
      </div>

      {/* Mam (2026-05-30): keep Engineer Compliance HERE in Daily
          Reports AND under HR System → Performance.  Same shared
          component drives both — single source of truth. */}
      {tab === 'losses' && <LossReasonsTab />}
      {tab === 'aaj' && <AajKaUpdate />}
      {tab === 'compliance' && <><SposComplianceGrid /><EngineerPerformance /></>}
      {tab === 'responsible' && <ResponsibilityTab module="dpr" title="DPR" />}

      {tab === 'dashboard' && (
        <>
          {/* SPOS live inventory ageing (mam 2026-07-31) — Sr. Engineer's watch */}
          <AgeingWidget />
          {/* 2-up on mobile/tablet (was 1-up, wasting width) — tighter
              padding/font through md so 4 tiles don't feel oversized below
              desktop; full size returns at lg (mam 2026-08-01). */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 md:gap-3 lg:gap-4">
            <button type="button" onClick={() => { setReportFilter(''); setTab('sites'); }}
              className="card text-center border-l-4 border-red-500 hover:shadow-md transition-shadow cursor-pointer p-3 lg:p-4">
              <div className="text-xl lg:text-3xl font-bold text-red-600">{summary ? summary.activeSites : '—'}</div>
              <div className="text-xs lg:text-sm text-gray-500">Active Sites <span className="text-[10px] text-red-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setFilterDate(new Date().toISOString().split('T')[0]); setDateTouched(true); setReportFilter(''); setTab('reports'); }}
              className="card text-center border-l-4 border-emerald-500 hover:shadow-md transition-shadow cursor-pointer p-3 lg:p-4">
              <div className="text-xl lg:text-3xl font-bold text-emerald-600">{summary ? summary.todaySubmissions : '—'}</div>
              <div className="text-xs lg:text-sm text-gray-500">DPR Today <span className="text-[10px] text-emerald-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('pending'); setTab('reports'); }}
              className="card text-center border-l-4 border-amber-500 hover:shadow-md transition-shadow cursor-pointer p-3 lg:p-4">
              <div className="text-xl lg:text-3xl font-bold text-amber-600">{summary ? summary.pendingApproval : '—'}</div>
              <div className="text-xs lg:text-sm text-gray-500">Pending Approval <span className="text-[10px] text-amber-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('billing'); setTab('reports'); }}
              className="card text-center border-l-4 border-purple-500 hover:shadow-md transition-shadow cursor-pointer p-3 lg:p-4">
              <div className="text-xl lg:text-3xl font-bold text-purple-600">{summary ? summary.billingReady : '—'}</div>
              <div className="text-xs lg:text-sm text-gray-500">Billing Ready <span className="text-[10px] text-purple-600 font-semibold">→ view</span></div>
            </button>
          </div>
          {summary && summary.missingSites.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><FiAlertTriangle className="text-red-600" size={20} /><h4 className="font-bold text-red-700">NO DPR - Payment Blocked!</h4></div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">{summary.missingSites.map(s => (
                <div key={s.id} className="bg-white border border-red-300 rounded-lg p-3 flex items-center gap-2"><FiMapPin className="text-red-500" /><div><div className="font-medium text-sm">{s.name}</div><div className="text-xs text-gray-500">{s.supervisor || 'N/A'}</div></div></div>
              ))}</div>
            </div>
          )}
          {summary && summary.missingSites.length === 0 && summary.activeSites > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3"><FiCheck className="text-emerald-600" size={24} /><h4 className="font-bold text-emerald-700">All sites submitted DPR today!</h4></div>
          )}
          {!summary && (
            <div className="text-center py-4 text-gray-400 text-sm">Loading dashboard summary…</div>
          )}

          {/* BOQ vs DPR-consumed progress, grouped by engineer → site → item */}
          <div className="card p-0 overflow-x-auto">
            <div className="bg-gradient-to-r from-blue-700 to-blue-800 text-white px-4 py-3 flex items-start justify-between gap-3 flex-wrap">
              <div>
                <h3 className="font-bold text-base">{progressView === 'site' ? 'Site Progress' : 'Engineer Progress'} — BOQ vs DPR Consumed</h3>
                <p className="text-xs text-blue-100">
                  {progressView === 'site'
                    ? 'Per site, per BOQ item. Each site listed once.'
                    : 'Per engineer, per site, per BOQ item. Incomplete items first.'}
                  {!isAdmin() && ' Showing only your sites.'}
                </p>
              </div>
              {/* Group-by toggle — mam: site-name-wise completion view */}
              <div className="flex rounded-lg overflow-hidden border border-white/30 text-xs flex-shrink-0">
                <button onClick={() => setProgressView('engineer')}
                  className={`px-3 py-1 font-semibold ${progressView === 'engineer' ? 'bg-white text-blue-700' : 'bg-transparent text-white hover:bg-white/10'}`}>By Engineer</button>
                <button onClick={() => setProgressView('site')}
                  className={`px-3 py-1 font-semibold ${progressView === 'site' ? 'bg-white text-blue-700' : 'bg-transparent text-white hover:bg-white/10'}`}>By Site</button>
              </div>
            </div>
            <div className="p-3 space-y-3">
              {progress.length === 0 && (
                <div className="text-center py-6 text-gray-400 text-sm">No sites assigned yet</div>
              )}

              {/* BY SITE — each site listed once with its completion; the
                  assigned engineer(s) show as a sub-label. */}
              {progressView === 'site' && progress.length > 0 && (
                siteRowsByName.length === 0
                  ? <div className="text-center py-6 text-gray-400 text-sm">No sites assigned yet</div>
                  : <div className="border rounded-lg overflow-hidden divide-y">
                      {siteRowsByName.map(site => renderSiteRow(site, `site-${site.site_name}`, site.engineerNames))}
                    </div>
              )}

              {/* BY ENGINEER — engineer → their sites */}
              {progressView === 'engineer' && progress.map(eng => {
                const engBoq = eng.sites.reduce((s, x) => s + (x.total_boq_amount || 0), 0);
                const engDone = eng.sites.reduce((s, x) => s + (x.total_done_amount || 0), 0);
                const engPct = engBoq > 0 ? Math.round((engDone / engBoq) * 1000) / 10 : 0;
                const engColor = engPct >= 90 ? 'text-emerald-600' : engPct >= 50 ? 'text-red-600' : engPct >= 20 ? 'text-amber-600' : 'text-red-500';
                const engBar = engPct >= 90 ? 'bg-emerald-500' : engPct >= 50 ? 'bg-red-500' : engPct >= 20 ? 'bg-amber-500' : 'bg-red-400';
                return (
                <div key={eng.engineer.id} className="border rounded-lg overflow-hidden">
                  <div className="bg-gradient-to-r from-blue-50 to-blue-50 px-3 py-2 border-b flex justify-between items-center gap-3">
                    <div className="min-w-0">
                      <div className="font-bold text-sm text-gray-800">{eng.engineer.name}</div>
                      <div className="text-[11px] text-gray-500 truncate">{eng.engineer.email} · {eng.site_count} site{eng.site_count === 1 ? '' : 's'}</div>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div className="hidden sm:block w-36">
                        <div className="h-2 bg-white/60 rounded-full overflow-hidden">
                          <div className={`h-full ${engBar}`} style={{ width: `${Math.min(100, engPct)}%` }} />
                        </div>
                        <div className="text-[10px] text-gray-500 text-right mt-0.5">Rs {engDone.toLocaleString()} / {engBoq.toLocaleString()}</div>
                      </div>
                      <div className="text-right">
                        <div className={`text-xl font-extrabold ${engColor}`}>{engPct}%</div>
                        <div className="text-[9px] uppercase text-gray-400 tracking-wider">completion</div>
                      </div>
                    </div>
                  </div>
                  {eng.sites.length === 0 ? (
                    <p className="p-3 text-xs text-gray-400">No sites assigned</p>
                  ) : (
                    <div className="divide-y">
                      {eng.sites.map(site => renderSiteRow(site, `${eng.engineer.id}-${site.site_id}`))}
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          </div>
        </>
      )}

      {tab === 'reports' && (
        <>
          {reportFilter && (
            <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center justify-between">
              <span>Filtered: <b>{reportFilter === 'pending' ? 'Pending Approval' : reportFilter === 'billing' ? 'Billing Ready' : reportFilter}</b> <span className="text-[10px] text-red-500 font-normal">· any date (pick a date below to narrow)</span></span>
              <button type="button" onClick={() => setReportFilter('')} className="text-red-600 hover:underline">Clear filter</button>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-4">
            <input type="date" className="input w-full sm:w-48" value={filterDate} onChange={e => { setFilterDate(e.target.value); setDateTouched(true); }} />
            {/* flex-wrap: mobile par 6 buttons ek line mein screen se bahar
                chale jate the (741px) — ab wrap hote hain (mam 2026-08-03) */}
            <div className="flex flex-wrap gap-2 w-full sm:w-auto">
              <button onClick={() => exportCsv('dpr-reports',
                ['Site','Date','By','Status','Plan Cost (B-plan)','Actual Cost (B-actual)','Actual Total (A)','Variance (B-act − B-plan)','Approval'],
                dprs.map(d => {
                  const planned = !!d.is_planned_template;
                  const planB = +d.planned_cost_b || 0;
                  const actB = planned ? '' : (+d.grand_total_b || 0);
                  const actA = planned ? '' : (+d.grand_total_a || 0);
                  const variance = (!planned && planB > 0) ? ((+d.grand_total_b || 0) - planB) : '';
                  return [
                    d.site_name, d.report_date, d.submitted_by_name,
                    planned ? 'PLANNED' : 'SUBMITTED',
                    planB || '', actB, actA, variance,
                    planned ? '' : d.approval_status,
                  ];
                }))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              {/* Weekly planning entry-point (mam, 2026-05-16). Pre-fills
                  default site = the one in the daily form's site_id if
                  picked, else empty.  Default week-start = next Monday
                  so site eng files NEXT week's plan, not the current
                  one in flight. */}
              <button onClick={() => openPlanWeek(form.site_id || '', planWeekStart)}
                className="btn btn-secondary flex items-center gap-2"><FiCalendar /> Plan Week</button>
              {/* Morning Manpower — contractor attendance punch (mam 2026-06-22) */}
              <button onClick={openMorningManpower}
                className="btn btn-secondary flex items-center gap-2"><FiUsers /> Morning Manpower</button>
              {/* Site-store Issue/Return slips — the jr. engineer's GRN counter (mam 2026-07-31) */}
              <button onClick={() => openSlipModal(form.site_id || '')}
                className="btn btn-secondary flex items-center gap-2"><FiPackage /> Store Issue/Return</button>
              {/* Attendance Records — register of all saved morning manpower (mam 2026-06-24) */}
              <button onClick={openAttendanceRecords}
                className="btn btn-secondary flex items-center gap-2"><FiList /> Attendance Records</button>
              <button onClick={() => {
                setForm({ site_id: '', report_date: filterDate, weather: 'clear', overall_status: 'on_track', system_type: '', shift: 'day', contractor_name: '', contractor_manpower: 0, mb_sheet_no: '', safety_toolbox_talk: false, safety_ppe_compliance: false, safety_incidents: '', next_day_plan: '', hindrances: '', hindrance_category: '', remarks: '' });
                setWorkItems([]); setPoItemsForSite([]);
                setDprMaterials([]); setDprStoreName(null);
                setCosts([
                  { type: 'Skilled Manpower', qty: 0, rate: 800, amount: 0, fixed: true },
                  { type: 'Helper', qty: 0, rate: 500, amount: 0, fixed: true },
                  { type: 'Rental Cost', qty: 0, rate: 0, amount: 0 },
                  { type: 'Staff Cost', qty: 1, rate: 0, amount: 0, auto: true, engineer_count: 0 },
                  { type: 'TA/DA', qty: 1, rate: 0, amount: 0, auto: true, ta_da_count: 0 },
                ]);
                setMachinery([{ equipment: '', quantity: 1, hours_used: 0, condition: 'working' }]);
                setContractors([{ name: '', manpower: 0 }]);
                // Lazy-fetch the sub-contractor master so the contractor
                // dropdown lands populated.  Cached after first open.
                if (subcons.length === 0) {
                  api.get('/sub-contractors/lookup').then(r => setSubcons(r.data || [])).catch(() => {});
                }
                setModal(true);
              }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit DPR</button>
            </div>
          </div>
          {/* ─── MOBILE CARDS ───────────────────────────────────────
              Mam (2026-06-02): phone version of the Daily Reports
              table.  Same data, stacked card per DPR — keeps the
              key money columns (Plan / Actual / Variance) visible
              without horizontal scroll. */}
          <div className="md:hidden space-y-3">
            {dprs
              .filter(d => {
                if (!reportFilter) return true;
                if (reportFilter === 'pending') return d.approval_status === 'pending';
                if (reportFilter === 'billing') return d.billing_ready === 1 || d.billing_ready === true;
                return true;
              })
              .map(d => {
                const planned = !!d.is_planned_template;
                const planB = +d.planned_cost_b || 0;
                const actB = +d.grand_total_b || 0;
                const actA = +d.grand_total_a || 0;
                const hasPlan = planB > 0;
                const variance = (!planned && hasPlan) ? (actB - planB) : null;
                return (
                  <div key={d.id} className="card p-3 space-y-2">
                    <div className="flex justify-between items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">DPR</div>
                        <div className="text-base font-bold text-gray-900 truncate">{d.site_name}</div>
                        <div className="text-[11px] text-gray-500">{d.report_date} · {d.submitted_by_name || '—'}</div>
                      </div>
                      {planned
                        ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"><FiCalendar size={10}/> PLANNED</span>
                        : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">✓ SUBMITTED</span>}
                    </div>
                    {!planned && (
                      <div className="grid grid-cols-3 gap-1 text-center pt-1 border-t border-gray-100">
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Plan B</div>
                          <div className="text-xs font-bold text-sky-700">{hasPlan ? `₹${Math.round(planB/1000)}K` : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Actual B</div>
                          <div className="text-xs font-bold text-red-600">{`₹${Math.round(actB/1000)}K`}</div>
                        </div>
                        <div>
                          <div className="text-[9px] uppercase text-gray-400">Revenue A</div>
                          <div className="text-xs font-bold text-emerald-600">{`₹${Math.round(actA/1000)}K`}</div>
                        </div>
                      </div>
                    )}
                    {variance !== null && (
                      <div className={`text-[11px] text-center py-1 rounded ${variance > 0 ? 'bg-red-50 text-red-700' : variance < 0 ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-50 text-gray-500'}`}>
                        Variance: <strong>{variance > 0 ? '+' : variance < 0 ? '−' : ''}₹{Math.abs(variance).toLocaleString()}</strong>
                      </div>
                    )}
                    <div className="flex justify-between items-center pt-1 border-t border-gray-100">
                      {!planned ? <StatusBadge status={d.approval_status} /> : <span className="text-[10px] text-gray-400">plan template</span>}
                      <div className="flex gap-1">
                        <button onClick={() => viewDpr(d.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                        {!planned && d.approval_status === 'pending' && canApprove('dpr') && <>
                          <button onClick={() => approveDpr(d.id, 'approved', true)} className="btn btn-success text-[10px] py-0.5 px-1.5">Approve+Bill</button>
                          <button onClick={() => approveDpr(d.id, 'rejected', false)} className="btn btn-danger text-[10px] py-0.5 px-1.5">Reject</button>
                        </>}
                        {canDelete('dpr') && <button onClick={async () => {
                          if (!confirm(`Delete DPR for "${d.site_name}" on ${d.report_date}?`)) return;
                          try { await api.delete(`/dpr/${d.id}`); toast.success('Deleted'); load(); }
                          catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                        }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                      </div>
                    </div>
                  </div>
                );
              })}
            {dprs.length === 0 && <div className="card p-6 text-center text-gray-400 text-sm">No DPR for this date</div>}
          </div>

          {/* ─── DESKTOP TABLE (md+) ───────────────────────────────── */}
          <div className="hidden md:block card p-0"><table className="freeze-head">
            <thead><tr>
              <th>Site</th><th>Date</th><th>By</th><th>Status</th>
              <th>Plan Cost<div className="text-[10px] font-normal text-gray-400">(B-plan)</div></th>
              <th>Actual Cost<div className="text-[10px] font-normal text-gray-400">(B-actual)</div></th>
              <th>Actual Total(A)<div className="text-[10px] font-normal text-gray-400">(revenue)</div></th>
              <th>Variance<div className="text-[10px] font-normal text-gray-400">(B-act − B-plan)</div></th>
              <th>Approval</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {dprs
                .filter(d => {
                  if (!reportFilter) return true;
                  if (reportFilter === 'pending') return d.approval_status === 'pending';
                  if (reportFilter === 'billing') return d.billing_ready === 1 || d.billing_ready === true;
                  return true;
                })
                .map(d => {
                  const planned = !!d.is_planned_template;
                  const planB = +d.planned_cost_b || 0;
                  const actB = +d.grand_total_b || 0;
                  const actA = +d.grand_total_a || 0;
                  const hasPlan = planB > 0;
                  const variance = (!planned && hasPlan) ? (actB - planB) : null;
                  return (
                <tr key={d.id}>
                  <td className="font-medium">{d.site_name}</td>
                  <td>{d.report_date}</td>
                  <td>{d.submitted_by_name}</td>
                  <td>
                    {planned
                      ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200"><FiCalendar size={10}/> PLANNED</span>
                      : <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">✓ SUBMITTED</span>}
                  </td>
                  <td className="font-semibold text-sky-700 text-sm">{hasPlan ? `Rs ${planB.toLocaleString()}` : <span className="text-gray-300">—</span>}</td>
                  <td className="font-semibold text-red-600 text-sm">{planned ? <span className="text-gray-300">—</span> : `Rs ${actB.toLocaleString()}`}</td>
                  <td className="font-semibold text-emerald-600 text-sm">{planned ? <span className="text-gray-300">—</span> : `Rs ${actA.toLocaleString()}`}</td>
                  <td className={`font-bold text-sm ${variance === null ? '' : (variance > 0 ? 'text-red-600' : variance < 0 ? 'text-emerald-600' : 'text-gray-500')}`}>
                    {variance === null ? <span className="text-gray-300">—</span> : `${variance > 0 ? '+' : variance < 0 ? '−' : ''}Rs ${Math.abs(variance).toLocaleString()}`}
                  </td>
                  <td>{planned ? <span className="text-gray-300">—</span> : <StatusBadge status={d.approval_status} />}</td>
                  <td><div className="flex gap-1">
                    <button onClick={() => viewDpr(d.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                    {!planned && d.approval_status === 'pending' && canApprove('dpr') && <>
                      <button onClick={() => approveDpr(d.id, 'approved', true)} className="btn btn-success text-[10px] py-0.5 px-1.5">Approve+Bill</button>
                      <button onClick={() => approveDpr(d.id, 'rejected', false)} className="btn btn-danger text-[10px] py-0.5 px-1.5">Reject</button>
                    </>}
                    {canDelete('dpr') && <button onClick={async () => {
                      if (!confirm(`Delete DPR for "${d.site_name}" on ${d.report_date}?`)) return;
                      try { await api.delete(`/dpr/${d.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
                  );
                })}
              {dprs.length === 0 && <tr><td colSpan="10" className="text-center py-8 text-gray-400">No DPR for this date</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {tab === 'sites' && (
        <>
          <div className="flex justify-between items-center"><h4 className="font-semibold">Project Sites</h4>
            <button onClick={() => { setForm({ name: '', address: '', client_name: '', site_engineer_id: '', supervisor: '' }); setSiteModal(true); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Site</button>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Lead No</th><th>Site</th><th>Address</th><th>Client</th><th>Engineer</th><th>Supervisor</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>{sites.map(s => (
              <tr key={s.id}>
                <td className="text-red-600 font-bold">{s.lead_no || '-'}</td>
                <td className="font-medium">{s.name}</td>
                <td>{s.address}</td>
                <td>{s.client_name}</td>
                <td>{s.engineer_name}</td>
                <td>{s.supervisor}</td>
                <td><StatusBadge status={s.status} /></td>
                <td>
                  {/* Deactivate flips status to 'on_hold' (DPR site picker
                      filters status='active' so this hides the site without
                      destroying any DPR / PO / booking history). Reactivate
                      flips it back. */}
                  {(canEdit('dpr') || isAdmin()) && (
                    s.status === 'active' ? (
                      <button onClick={async () => {
                        if (!confirm(`Deactivate site "${s.name}"?\n\nIt will stop appearing in the DPR site picker. You can reactivate it any time.`)) return;
                        try {
                          await api.put(`/dpr/sites/${s.id}`, {
                            name: s.name, address: s.address, client_name: s.client_name,
                            site_engineer_id: s.site_engineer_id, supervisor: s.supervisor,
                            status: 'on_hold',
                          });
                          toast.success('Deactivated');
                          api.get('/dpr/sites').then(r => setSites(r.data));
                        } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                      }} className="btn btn-secondary text-xs py-1 px-2">Deactivate</button>
                    ) : (
                      <button onClick={async () => {
                        try {
                          await api.put(`/dpr/sites/${s.id}`, {
                            name: s.name, address: s.address, client_name: s.client_name,
                            site_engineer_id: s.site_engineer_id, supervisor: s.supervisor,
                            status: 'active',
                          });
                          toast.success('Reactivated');
                          api.get('/dpr/sites').then(r => setSites(r.data));
                        } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
                      }} className="btn btn-success text-xs py-1 px-2">Reactivate</button>
                    )
                  )}
                </td>
              </tr>
            ))}
              {sites.length === 0 && <tr><td colSpan="8" className="text-center py-8 text-gray-400">No sites</td></tr>}</tbody>
          </table></div>
        </>
      )}

      {/* ===== SUBMIT DPR MODAL - Matches SEPL DPR Format ===== */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="DAILY PROGRESS SHEET - SECURED ENGINEERS PVT LTD" wide>
        <form onSubmit={submitDpr} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">

          {/* Header */}
          <div className="border rounded-lg p-3 bg-gray-50">
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div><label className="label">Site Name *</label>
                <select className="select" value={form.site_id || ''} onChange={e => handleSiteSelect(e.target.value)} required>
                  <option value="">Select Site</option>{sites.filter(s => s.status === 'active').map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
                </select>
              </div>
              <div><label className="label">Date *</label><input className="input" type="date" value={form.report_date || ''} onChange={e => setForm({ ...form, report_date: e.target.value })} required /></div>
              {isAdmin() ? (
                <div>
                  <label className="label">Engineer Name</label>
                  <SearchableSelect
                    options={users.map(u => ({ ...u, label: u.name + (u.username ? ' (@' + u.username + ')' : '') }))}
                    value={form.engineer_id || null}
                    valueKey="id" displayKey="label"
                    placeholder="Search engineer…"
                    onChange={(u) => setForm({ ...form, engineer_id: u?.id || '' })}
                  />
                </div>
              ) : (
                <div><label className="label">Engineer Name</label><div className="input bg-gray-100 text-gray-700">{user?.name}</div></div>
              )}
              <div className="sm:col-span-2">
                <div className="flex items-baseline justify-between mb-1">
                  <label className="label mb-0">Contractors on Site</label>
                  <button type="button" onClick={() => setContractors([...contractors, { name: '', manpower: 0 }])}
                    className="text-xs text-red-600 hover:underline">+ Add Contractor</button>
                </div>
                <div className="space-y-1.5">
                  {contractors.map((c, i) => (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center">
                      {/* Mam (2026-05-30): "contractor name drop down from
                          master sub-contactor".  SearchableSelect lists every
                          active sub-contractor with their trade in the label
                          so engineers can find by company OR by trade type.
                          We bind by name (string) — keeps backward compat
                          with legacy contractor_name TEXT in older DPRs. */}
                      <div className="col-span-7">
                        <SearchableSelect
                          options={[
                            // Existing free-text values from legacy DPRs land
                            // here too, so re-opening a draft doesn't lose them.
                            ...(c.name && !subcons.find(s => s.name === c.name)
                              ? [{ name: c.name, label: `${c.name} (manual)` }]
                              : []),
                            ...subcons.map(s => ({
                              ...s,
                              label: s.contractor_type ? `${s.name} — ${s.contractor_type}` : s.name,
                            })),
                          ]}
                          value={c.name || ''}
                          valueKey="name"
                          displayKey="label"
                          placeholder={`Contractor ${i + 1}…`}
                          onChange={(s) => {
                            const n = [...contractors];
                            n[i] = { ...n[i], name: s?.name || '' };
                            setContractors(n);
                          }}
                        />
                      </div>
                      <input className="input col-span-4" type="number" placeholder="Manpower"
                        value={c.manpower || ''}
                        onChange={e => { const n = [...contractors]; n[i] = { ...n[i], manpower: +e.target.value || 0 }; setContractors(n); }} />
                      {contractors.length > 1 ? (
                        <button type="button"
                          onClick={() => setContractors(contractors.filter((_, idx) => idx !== i))}
                          className="col-span-1 text-gray-400 hover:text-red-600 text-lg leading-none">×</button>
                      ) : <div className="col-span-1" />}
                    </div>
                  ))}
                </div>
              </div>
              <div><label className="label">Shift</label>
                <div className="flex gap-4 mt-1">
                  {['day', 'evening', 'night'].map(s => (
                    <label key={s} className="flex items-center gap-1 cursor-pointer">
                      <input type="radio" name="shift" value={s} checked={form.shift === s} onChange={() => setForm({ ...form, shift: s })} className="w-4 h-4" />
                      <span className="text-sm capitalize">{s}</span>
                    </label>
                  ))}
                </div>
              </div>
              {/* MEPF System — compact chip-radio.  Mam (2026-05-30):
                  "mepf system , weather look consume space more" —
                  shrunk padding + dropped the unselected color dot. */}
              <div className="sm:col-span-2 md:col-span-3">
                <label className="label">MEPF System</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {MEPF_SYSTEMS.map(s => {
                    const active = form.system_type === s.key;
                    return (
                      <button key={s.key} type="button"
                        onClick={() => setForm({ ...form, system_type: active ? '' : s.key })}
                        className={`px-2 py-1 rounded-full text-xs font-medium border transition inline-flex items-center gap-1 ${
                          active
                            ? `${s.sel} shadow-sm`
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}>
                        <span className="text-sm leading-none">{s.icon}</span>
                        {s.key}
                      </button>
                    );
                  })}
                </div>
                {form.system_type && !MEPF_SYSTEMS.find(s => s.key === form.system_type) && (
                  <div className="text-[11px] text-gray-500 mt-1">
                    Legacy value: <strong>{form.system_type}</strong>
                    <button type="button" onClick={() => setForm({ ...form, system_type: '' })}
                      className="ml-2 text-red-600 hover:underline">clear</button>
                  </div>
                )}
              </div>
              {/* Weather — same compact chip pattern as MEPF. */}
              <div className="sm:col-span-2 md:col-span-3">
                <label className="label">Weather</label>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {WEATHER_OPTIONS.map(w => {
                    const active = (form.weather || 'clear') === w.key;
                    return (
                      <button key={w.key} type="button"
                        onClick={() => setForm({ ...form, weather: w.key })}
                        className={`px-2 py-1 rounded-full text-xs font-medium border transition inline-flex items-center gap-1 ${
                          active
                            ? `${w.sel} shadow-sm`
                            : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
                        }`}>
                        <span className="text-sm leading-none">{w.icon}</span>
                        {w.label}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>

          {/* TABLE A: Installation Work from PO */}
          <div className="border-2 border-red-300 rounded-lg p-3 bg-red-50">
            <div className="flex justify-between items-center mb-3">
              <h5 className="font-bold text-red-800">TABLE A: Installation Work (BOQ Items from PO)</h5>
              {poItemsForSite.length > 0 && <button type="button" onClick={addWorkItem} className="btn btn-secondary text-xs flex items-center gap-1"><FiPlus size={12} /> Add Item</button>}
            </div>
            {/* Server-side diagnostic — tells mam exactly why items aren't
                fully populated (no Business Book link, no BOQ uploaded,
                or labour rates missing). */}
            {poItemsDiag && (
              <div className="bg-amber-50 border border-amber-300 rounded px-3 py-2 text-xs text-amber-900 mb-2 flex items-start gap-2">
                <FiAlertCircle className="flex-shrink-0 mt-0.5" size={14} />
                <div>
                  <div className="font-bold mb-0.5">
                    {poItemsDiag.reason === 'no_business_book' ? 'No Business Book linked' :
                     poItemsDiag.reason === 'no_po_items' ? 'No BOQ items yet' :
                     poItemsDiag.reason === 'rates_missing'
                       ? `${poItemsDiag.total_count} item${poItemsDiag.total_count === 1 ? '' : 's'} loaded · ${poItemsDiag.total_count - (poItemsDiag.missing_sitc_count || 0)} have a rate set`
                       : 'Heads up'}
                  </div>
                  <div>{poItemsDiag.message}</div>
                </div>
              </div>
            )}
            {poItemsForSite.length > 0 ? (
              <>
                <div className="hidden md:grid grid-cols-12 gap-1 text-[10px] font-bold text-gray-600 mb-1 px-1 uppercase">
                  <div className="md:col-span-4">BOQ Item</div><div className="md:col-span-1">Qty</div><div className="md:col-span-2">Location</div><div className="md:col-span-2">Rate (Rs)</div><div className="md:col-span-2">Amount (Rs)</div><div></div>
                </div>
                {workItems.map((w, i) => (
                  // Mobile-friendly row layout — mam: "qty is very small not
                  // showing peroper when we enter". Mobile splits each work
                  // item into 3 readable rows; desktop keeps the compact 12-
                  // col grid. Each input gets its own mobile-only label so
                  // the user always knows what they're typing into.
                  <div key={i} className="grid grid-cols-12 gap-1 mb-3 md:mb-1.5 items-start bg-white rounded p-2 md:p-1 border md:border-0 border-gray-100">
                    <div className="col-span-12 md:col-span-4">
                      <SearchableSelect
                        options={poItemsForSite.map(item => {
                          // Prepend item_code + append a hidden suffix of
                          // master_name / specification / size / make / type
                          // so substring search finds "raceway" etc. even
                          // when the BOQ description uses different wording.
                          const rateBit = +item.rate > 0 ? `Rs ${(+item.rate).toLocaleString('en-IN')}` : '⚠ no rate';
                          const completedBit = item.remaining_qty <= 0 ? ' — COMPLETED' : '';
                          const codeBit = item.item_code ? `[${item.item_code}] ` : '';
                          const searchSuffix = [
                            item.master_name, item.master_specification, item.master_size,
                            item.master_make, item.master_type,
                          ].filter(Boolean).join(' ');
                          return {
                            id: item.id,
                            label: `${codeBit}${item.description} (BOQ:${item.quantity} | Rem:${item.remaining_qty ?? item.quantity} ${item.unit} | ${rateBit})${completedBit}${searchSuffix ? ' · ' + searchSuffix : ''}`,
                            ...item,
                          };
                        })}
                        value={w.po_item_id || null}
                        valueKey="id"
                        displayKey="label"
                        placeholder="-- Select PO Item --"
                        onChange={(item) => selectWorkItem(i, item?.id || '')}
                      />
                    </div>
                    {/* Qty — col-span-4 on mobile (~33% width, room for 4–5 digits) */}
                    <div className="col-span-4 md:col-span-1">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Qty</div>
                      <input className="input text-sm w-full" type="number" placeholder="Qty" max={w.remaining_qty || w.boq_qty || 999999} value={w.qty || ''} onChange={e => {
                        const val = +e.target.value;
                        const maxQty = w.remaining_qty ?? w.boq_qty ?? 999999;
                        if (val > maxQty) { toast.error(`Max qty: ${maxQty} (BOQ: ${w.boq_qty}, Already filled: ${w.filled_qty || 0})`); return; }
                        updateWork(i, 'qty', val);
                      }} />
                      {w.po_item_id && (
                        <div className="text-[9px] leading-tight mt-0.5 text-center">
                          <div className="text-gray-500">BOQ: <span className="font-semibold">{w.boq_qty} {w.unit || ''}</span></div>
                          <div className={w.remaining_qty > 0 ? 'text-emerald-600 font-semibold' : 'text-red-500 font-semibold'}>
                            Rem: {w.remaining_qty ?? 0} {w.unit || ''}
                          </div>
                        </div>
                      )}
                    </div>
                    {/* Location — col-span-8 mobile (rest of the qty row) */}
                    <div className="col-span-8 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Location</div>
                      <input className="input text-sm w-full" placeholder="Loc (GF/1F)" value={w.location || ''} onChange={e => updateWork(i, 'location', e.target.value)} />
                    </div>
                    {/* Rate — col-span-6 mobile (half of new row) */}
                    <div className="col-span-6 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Rate (Rs)</div>
                      <input className="input text-sm w-full" type="number" placeholder="Rate" value={w.rate || ''} onChange={e => updateWork(i, 'rate', +e.target.value)} />
                      {w.sitc_rate > 0 && (
                        <div className="text-[9px] leading-tight mt-0.5 text-gray-500">
                          Labour = 11% of SITC ₹{(+w.sitc_rate).toLocaleString('en-IN')}
                        </div>
                      )}
                    </div>
                    {/* Amount — col-span-5 mobile */}
                    <div className="col-span-5 md:col-span-2">
                      <div className="md:hidden text-[10px] font-semibold text-gray-500 uppercase mb-0.5">Amount</div>
                      <div className="text-sm font-bold text-right pr-2 pt-2 md:pt-0">Rs {(w.amount || 0).toLocaleString()}</div>
                    </div>
                    {/* Trash — col-span-1 (just enough for the icon) */}
                    <div className="col-span-1 flex justify-center pt-2 md:pt-0">
                      <button type="button" onClick={() => removeWorkItem(i)} className="p-1 text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                    {/* Phase 4 — Work Order picker.  Spans the full row
                        below the qty / rate / amount inputs so it doesn't
                        squeeze the existing layout, and only renders when
                        the project has at least one active Work Order to
                        choose from (mam 2026-06-02: DPR → Indent Labour
                        Payment progress link). */}
                    {activeWorkOrders.length > 0 && (
                      <div className="col-span-12 flex items-center gap-2 mt-1.5 pt-1.5 border-t border-gray-100">
                        <span className="text-[10px] font-semibold text-gray-500 uppercase whitespace-nowrap">Work Order</span>
                        <div className="flex-1 min-w-0">
                          <SearchableSelect
                            options={activeWorkOrders.map(wo => ({
                              id: wo.id,
                              label: `${wo.wo_number || `WO#${wo.id}`} · ${wo.sub_contractor_name || '—'}${wo.project_name ? ' · ' + wo.project_name : ''}${wo.scope ? ' — ' + wo.scope.slice(0, 40) : ''}`,
                              ...wo,
                            }))}
                            value={w.work_order_id || null}
                            valueKey="id"
                            displayKey="label"
                            placeholder="— optional · link to sub-contractor WO —"
                            buttonClassName="input text-xs w-full text-left flex items-center justify-between gap-1 cursor-pointer"
                            onChange={(wo) => updateWork(i, 'work_order_id', wo?.id || '')}
                          />
                        </div>
                        {w.work_order_id && (
                          <button
                            type="button"
                            onClick={() => updateWork(i, 'work_order_id', '')}
                            className="text-[10px] text-gray-400 hover:text-red-600 px-1"
                            title="Unlink Work Order"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
                {workItems.length === 0 && <p className="text-xs text-gray-400 text-center py-3">Click "+ Add Item" for items installed today</p>}
                <div className="mt-2 pt-2 border-t-2 border-red-300 text-right">
                  <span className="font-bold text-red-800 text-lg">Grand Total (A): Rs {grandTotalA.toLocaleString()}</span>
                </div>
              </>
            ) : <p className="text-xs text-amber-600">{form.site_id ? 'No PO items for this site. Add PO items in Orders first.' : 'Select a site to load PO items.'}</p>}
          </div>

          {/* TABLE B: Costs */}
          <div className="border-2 border-red-300 rounded-lg p-3 bg-red-50">
            <h5 className="font-bold text-red-800 mb-3">TABLE B: Costs</h5>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-1 text-[10px] font-bold text-gray-600 mb-1 px-1 uppercase">
              <div>Type</div><div>Qty</div><div>Rate (Rs)</div><div>Amount (Rs)</div>
            </div>
            {costs.map((c, i) => {
              const isStaff = c.type === 'Staff Cost';
              const isTaDa = c.type === 'TA/DA';
              // Staff rate is locked only when auto-fetch succeeded. When it
              // returns 0 (no employee/salary), let the user type a rate manually.
              const staffRateLocked = isStaff && c.auto;
              // TA/DA stays editable even when auto-filled, so the engineer
              // can override if the auto-pulled total doesn't match reality
              // for that day.
              const rateLocked = c.fixed || staffRateLocked;
              return (
                <div key={i} className="bg-white rounded p-1 mb-1.5">
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-1 items-center">
                    <div className="text-sm font-medium">
                      {c.type}
                      {c.fixed && <span className="ml-1 text-[9px] text-gray-400">(fixed)</span>}
                      {isStaff && c.auto && <span className="ml-1 text-[9px] text-emerald-600">(auto, 1 day)</span>}
                      {isStaff && !c.auto && c.engineer_count === 0 && <span className="ml-1 text-[9px] text-amber-600">(manual — see below)</span>}
                      {isTaDa && c.auto && <span className="ml-1 text-[9px] text-emerald-600">(auto from {c.ta_da_count || 0} approved request{(c.ta_da_count || 0) === 1 ? '' : 's'})</span>}
                      {isTaDa && !c.auto && <span className="ml-1 text-[9px] text-gray-400">(no approved TA/DA for this site)</span>}
                    </div>
                    {isStaff ? (
                      <div className="text-sm text-center text-gray-500 font-medium">1</div>
                    ) : (
                      <input className="input text-sm text-center" type="number" placeholder="0" value={c.qty || ''} onChange={e => updateCost(i, 'qty', +e.target.value)} />
                    )}
                    <input
                      className={`input text-sm text-center ${rateLocked ? 'bg-gray-50 text-gray-500 cursor-not-allowed' : ''}`}
                      type="number"
                      placeholder="0"
                      value={c.rate || ''}
                      readOnly={rateLocked}
                      onChange={e => updateCost(i, 'rate', +e.target.value)}
                      title={c.fixed ? `Fixed company rate: Rs ${c.rate}` : (staffRateLocked ? 'Auto: sum of PO site engineers’ monthly salary ÷ 30' : (isStaff ? 'Type the staff per-day cost manually' : ''))}
                    />
                    <div className="text-sm font-bold text-right pr-2">Rs {(c.amount || 0).toLocaleString()}</div>
                  </div>
                  {isStaff && (
                    <div className="text-[10px] pl-1 mt-1">
                      {!form.site_id ? (
                        <p className="text-gray-500">Select a site first — Staff Cost auto-fills from that PO’s site engineers.</p>
                      ) : (c.staff && c.staff.length > 0) ? (
                        <div className="space-y-0.5">
                          <div className="text-gray-500">Staff cost by name (attendance of {form.report_date || filterDate || 'the date'}):</div>
                          {c.staff.map(s => (
                            <div key={s.user_id} className={`flex justify-between ${s.present ? 'text-gray-700' : 'text-gray-400 line-through'}`}
                              title={s.present ? 'Attendance marked — counted' : 'No attendance / absent — excluded'}>
                              <span>{s.present ? '✓' : '✗'} {s.name}</span>
                              <span>Rs {(s.per_day || 0).toLocaleString()}{!s.present && ' · excluded'}</span>
                            </div>
                          ))}
                          {c.diagnostic && <p className="text-amber-700">{c.diagnostic.message}</p>}
                        </div>
                      ) : (
                        <p className={c.diagnostic ? 'text-amber-700' : 'text-gray-500'}>
                          {c.diagnostic ? c.diagnostic.message
                            : c.po_engineers > 0
                              ? `${c.po_engineers} site engineer${c.po_engineers > 1 ? 's' : ''} are on this PO but none have a matching employee salary record. Type the rate manually, or ask HR to add your salary.`
                              : 'No site engineers / submitter salary found. Type the rate manually below, or ask HR to add your salary.'}
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
            <button type="button" onClick={() => setCosts([...costs, { type: '', qty: 0, rate: 0, amount: 0 }])} className="text-xs text-red-700 hover:underline">+ Add Cost Type</button>
            <div className="mt-2 pt-2 border-t-2 border-red-300 text-right">
              <span className="font-bold text-red-800 text-lg">Grand Total (B): Rs {grandTotalB.toLocaleString()}</span>
            </div>
          </div>

          {/* Profit/Loss */}
          <div className={`border-2 rounded-lg p-4 text-center ${profitLoss >= 0 ? 'border-emerald-400 bg-emerald-50' : 'border-red-400 bg-red-50'}`}>
            <span className={`text-2xl font-bold ${profitLoss >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
              {profitLoss >= 0 ? 'PROFIT' : 'LOSS'}: Rs {Math.abs(profitLoss).toLocaleString()}
            </span>
            <p className="text-xs text-gray-500 mt-1">(A) Rs {grandTotalA.toLocaleString()} - (B) Rs {grandTotalB.toLocaleString()}</p>
          </div>

          {/* Machinery/Tools */}
          <div className="border rounded-lg p-3 bg-cyan-50">
            <h5 className="font-semibold text-sm text-cyan-700 mb-2">Machinery / Tools Used</h5>
            {machinery.map((m, i) => (
              <div key={i} className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-1.5">
                <select className="input text-sm" value={m.equipment} onChange={e => { const n = [...machinery]; n[i].equipment = e.target.value; setMachinery(n); }}>
                  <option value="">Select</option>{EQUIPMENT_LIST.map(eq => <option key={eq}>{eq}</option>)}
                </select>
                <input className="input text-sm" type="number" placeholder="Qty" value={m.quantity || ''} onChange={e => { const n = [...machinery]; n[i].quantity = +e.target.value; setMachinery(n); }} />
                <input className="input text-sm" type="number" placeholder="Hours" value={m.hours_used || ''} onChange={e => { const n = [...machinery]; n[i].hours_used = +e.target.value; setMachinery(n); }} />
                <select className="input text-sm" value={m.condition || 'working'} onChange={e => { const n = [...machinery]; n[i].condition = e.target.value; setMachinery(n); }}>
                  <option value="working">Working</option><option value="idle">Idle</option><option value="breakdown">Breakdown</option>
                </select>
              </div>
            ))}
            <button type="button" onClick={() => setMachinery([...machinery, { equipment: '', quantity: 1, hours_used: 0, condition: 'working' }])} className="text-xs text-cyan-700 hover:underline">+ Add Equipment</button>
          </div>

          {/* SPOS (mam 2026-07-29): Material Consumed — auto-loaded from the
              site store; consumed qty auto-reduces stock at submit. */}
          <div className="border rounded-lg p-3 bg-indigo-50">
            <div className="flex items-center justify-between mb-2 flex-wrap gap-1">
              <h5 className="font-semibold text-sm text-indigo-700">Material Consumed Today {dprStoreName ? <span className="font-normal text-indigo-500">· {dprStoreName}</span> : ''}</h5>
              <button type="button" onClick={() => loadStoreStock(form.site_id)} className="text-xs text-indigo-700 hover:underline">↻ Reload stock</button>
            </div>
            {dprStoreErr ? (
              <div className="text-xs text-red-600">
                Could not load the site store (network/server error) — <button type="button" className="underline font-semibold" onClick={() => loadStoreStock(form.site_id)}>tap to retry</button>. Don't assume the store is empty.
              </div>
            ) : dprMaterials.length === 0 ? (
              <div className="text-xs text-gray-500">
                No live stock in this site's store yet — item names appear here from the site store's inventory.
                Fill it via <b>Inventory → Opening Stock</b> (material already at site), an <b>office → site transfer</b>, or by <b>receiving a PO into the site store</b> (Dispatch &amp; Receiving → pick the site warehouse).
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b">
                      <th className="text-left py-1 pr-2">Material</th>
                      <th className="text-right py-1 px-2 whitespace-nowrap">In Store</th>
                      <th className="text-right py-1 px-2 whitespace-nowrap">Issued</th>
                      <th className="text-right py-1 px-2 whitespace-nowrap">Returned</th>
                      <th className="text-right py-1 pl-2 w-32 whitespace-nowrap">Consumed Today</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dprMaterials.map((m, i) => (
                      <tr key={m.item_master_id} className="border-b border-indigo-100">
                        <td className="py-1 pr-2 min-w-[150px] break-words">{m.material_name} <span className="text-gray-400 whitespace-nowrap">({m.unit})</span></td>
                        <td className="py-1 px-2 text-right tabular-nums whitespace-nowrap">{m.stock_qty}</td>
                        <td className="py-1 px-2 text-right tabular-nums whitespace-nowrap">{m.issued_today > 0 ? m.issued_today : <span className="text-gray-300">—</span>}</td>
                        <td className="py-1 px-2 text-right tabular-nums whitespace-nowrap">{m.returned_today > 0 ? m.returned_today : <span className="text-gray-300">—</span>}</td>
                        <td className="py-1 pl-2 text-right min-w-[100px]">
                          {m.from_slips ? (
                            <span className="font-semibold text-indigo-800 tabular-nums" title="Auto from issue/return slips — the jr. engineer's GRN slips are the source of truth">
                              {m.consumed_today} <span className="text-[9px] font-normal text-indigo-500">auto·slips</span>
                            </span>
                          ) : (
                            <input type="number" min="0" max={m.stock_qty} step="0.01"
                              className={`input text-xs text-right w-full ${+m.consumed_today > +m.stock_qty ? '!border-red-400 bg-red-50' : ''}`}
                              value={m.consumed_today || ''}
                              placeholder="0"
                              onChange={e => { const n = [...dprMaterials]; n[i] = { ...m, consumed_today: e.target.value }; setDprMaterials(n); }} />
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="text-[10px] text-gray-500 mt-1">
                  Items with Issue/Return slips are <b>auto-computed</b> (issued − returned) and locked — use <b>Store Issue/Return</b> to correct them.
                  Items without slips can be typed directly and auto-reduce store stock on submit. SPOS: zero manual stock calculations.
                </p>
              </div>
            )}
          </div>

          {/* Safety */}
          <div className="border rounded-lg p-3 bg-red-50">
            <h5 className="font-semibold text-sm text-red-700 mb-2">Safety & Compliance</h5>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="w-4 h-4 rounded" checked={form.safety_toolbox_talk || false} onChange={e => setForm({ ...form, safety_toolbox_talk: e.target.checked })} /><span className="text-sm">Toolbox Talk (TBT)</span></label>
              <label className="flex items-center gap-2 cursor-pointer"><input type="checkbox" className="w-4 h-4 rounded" checked={form.safety_ppe_compliance || false} onChange={e => setForm({ ...form, safety_ppe_compliance: e.target.checked })} /><span className="text-sm">PPE Compliance</span></label>
            </div>
            <div className="mt-2"><input className="input" value={form.safety_incidents || ''} onChange={e => setForm({ ...form, safety_incidents: e.target.value })} placeholder="Safety Incidents (Nil if none)" /></div>
          </div>

          {/* Hindrances + Next Day. Mam's rule: when the day ended in a
              LOSS (profitLoss < 0), category + reason are MANDATORY so we
              can analyse root causes across sites. Becomes required
              automatically based on the live profit/loss calc above. */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className={`border rounded-lg p-3 ${profitLoss < 0 ? 'border-red-400 bg-red-50' : 'bg-orange-50'}`}>
              <h5 className="font-semibold text-sm text-orange-700 mb-2">
                Hindrances / Issues {profitLoss < 0 && <span className="text-red-700 text-[10px] font-bold ml-1">⚠ MANDATORY (Loss)</span>}
              </h5>
              <div className="mb-2">
                <label className="text-[11px] font-bold text-gray-700 uppercase">Category {profitLoss < 0 && <span className="text-red-600">*</span>}</label>
                <select
                  className="select"
                  required={profitLoss < 0}
                  value={form.hindrance_category || ''}
                  onChange={e => setForm({ ...form, hindrance_category: e.target.value })}
                >
                  <option value="">— pick category —</option>
                  <option value="Money">Money</option>
                  <option value="Machine">Machine</option>
                  <option value="Material">Material</option>
                  <option value="Manpower">Manpower</option>
                  <option value="Site Clearance">Site Clearance</option>
                </select>
              </div>
              <label className="text-[11px] font-bold text-gray-700 uppercase">Reason {profitLoss < 0 && <span className="text-red-600">*</span>}</label>
              <textarea
                className="input"
                rows="2"
                required={profitLoss < 0}
                value={form.hindrances || ''}
                onChange={e => setForm({ ...form, hindrances: e.target.value })}
                placeholder={profitLoss < 0 ? 'Why did this site lose money today? (mandatory)' : 'Material shortage, Drawing pending...'}
              />
            </div>
            <div className="border rounded-lg p-3 bg-emerald-50">
              <h5 className="font-semibold text-sm text-emerald-700 mb-2">Next Day Plan</h5>
              <textarea className="input" rows="2" value={form.next_day_plan || ''} onChange={e => setForm({ ...form, next_day_plan: e.target.value })} placeholder="Tomorrow's work plan..." />
            </div>
          </div>

          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks || ''} onChange={e => setForm({ ...form, remarks: e.target.value })} /></div>

          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Submit DPR</button></div>
        </form>
      </Modal>

      {/* Site Modal */}
      <Modal isOpen={siteModal} onClose={() => setSiteModal(false)} title="Add Project Site">
        <form onSubmit={createSite} className="space-y-4">
          <div><label className="label">Site Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({ ...form, name: e.target.value })} required /></div>
          <div><label className="label">Address</label><textarea className="input" rows="2" value={form.address || ''} onChange={e => setForm({ ...form, address: e.target.value })} /></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Client</label><input className="input" value={form.client_name || ''} onChange={e => setForm({ ...form, client_name: e.target.value })} /></div>
            <div><label className="label">Supervisor</label><input className="input" list="dprUsersDL" value={form.supervisor || ''} onChange={e => setForm({ ...form, supervisor: e.target.value })} placeholder="Pick or type" /><datalist id="dprUsersDL">{users.map(u => <option key={u.id} value={u.name} />)}</datalist></div>
            <div><label className="label">Site Engineer</label><select className="select" value={form.site_engineer_id || ''} onChange={e => setForm({ ...form, site_engineer_id: e.target.value })}><option value="">Select</option>{users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setSiteModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create Site</button></div>
        </form>
      </Modal>

      {/* DPR Detail Modal */}
      <Modal isOpen={detailModal} onClose={() => setDetailModal(false)} title={`DPR - ${selectedDpr?.site_name} - ${selectedDpr?.report_date}`} wide>
        {selectedDpr && (
          <div className="space-y-4 max-h-[70vh] overflow-y-auto">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm bg-gray-50 p-3 rounded-lg">
              <div><strong>Site:</strong> {selectedDpr.site_name}</div>
              <div><strong>Date:</strong> {selectedDpr.report_date}</div>
              <div><strong>Shift:</strong> {selectedDpr.shift || '-'}</div>
              <div className="col-span-2 md:col-span-4"><strong>Contractors:</strong>{' '}
                {selectedDpr.contractors?.length
                  ? selectedDpr.contractors.map(c => `${c.name || '(unnamed)'}${c.manpower ? ` × ${c.manpower}` : ''}`).join(', ')
                  : (selectedDpr.contractor_name ? `${selectedDpr.contractor_name}${selectedDpr.contractor_manpower ? ` × ${selectedDpr.contractor_manpower}` : ''}` : '-')}
              </div>
              <div><strong>System:</strong> {selectedDpr.system_type || '-'}</div>
              <div><strong>Weather:</strong> {selectedDpr.weather}</div>
              <div><strong>By:</strong> {selectedDpr.submitted_by_name}</div>
              <div><strong>Status:</strong> <StatusBadge status={selectedDpr.overall_status} /></div>
            </div>

            {selectedDpr.work_items?.length > 0 && (
              <div className="border-2 border-red-300 rounded-lg p-3">
                <h5 className="font-bold text-red-800 mb-2">TABLE A: Installation Work</h5>
                <table className="text-xs"><thead><tr><th>BOQ Item</th><th>Qty</th><th>Location</th><th>Rate</th><th>Amount</th></tr></thead>
                  <tbody>{selectedDpr.work_items.map(w => (<tr key={w.id}><td>{w.shift === 'evening' ? '🌆 ' : w.shift === 'night' ? '🌙 ' : ''}{w.description}</td><td className="font-bold">{w.actual_qty || w.planned_qty}</td><td>{w.floor_zone || '-'}</td><td>Rs {(w.rate || 0).toLocaleString()}</td><td className="font-bold text-emerald-600">Rs {(w.amount || 0).toLocaleString()}</td></tr>))}</tbody>
                </table>
                <div className="text-right font-bold text-red-800 mt-2">Grand Total (A): Rs {selectedDpr.work_items.reduce((s, w) => s + (w.amount || 0), 0).toLocaleString()}</div>
              </div>
            )}

            {selectedDpr.manpower?.length > 0 && (() => {
              const nonStaffB = selectedDpr.manpower.filter(m => m.trade !== 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const storedStaffB = selectedDpr.manpower.filter(m => m.trade === 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const hasBreakdown = !!(viewStaff && viewStaff.staff && viewStaff.staff.length > 0);
              const staffB = hasBreakdown ? (viewStaff.per_day_cost || 0) : storedStaffB;
              const grandB = nonStaffB + staffB;
              const present = (viewStaff?.staff || []).filter(s => s.present);
              const excluded = (viewStaff?.staff || []).filter(s => !s.present);
              return (
                <div className="border-2 border-red-300 rounded-lg p-3">
                  <h5 className="font-bold text-red-800 mb-2">TABLE B: Costs</h5>
                  <table className="text-xs"><thead><tr><th>Type</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
                    <tbody>
                      {/* Non-staff rows as saved. Staff Cost is replaced by the by-name,
                          attendance-filtered breakdown when available (mam 2026-06-30). */}
                      {selectedDpr.manpower.filter(m => m.trade !== 'Staff Cost' || !hasBreakdown).map(m => (
                        <tr key={m.id}><td>{m.trade}</td><td>{m.required}</td><td>Rs {(m.deployed || 0).toLocaleString()}</td><td className="font-bold text-red-600">Rs {(m.shortage || 0).toLocaleString()}</td></tr>
                      ))}
                      {hasBreakdown && present.map(s => (
                        <tr key={'st' + s.user_id}><td>Staff: {s.name}</td><td>1</td><td>Rs {(s.per_day || 0).toLocaleString()}</td><td className="font-bold text-red-600">Rs {(s.per_day || 0).toLocaleString()}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  {hasBreakdown && excluded.length > 0 && (
                    <div className="text-[11px] text-gray-400 mt-1">Excluded (no attendance / absent on {selectedDpr.report_date}): {excluded.map(s => s.name).join(', ')}</div>
                  )}
                  {hasBreakdown && Math.abs(staffB - storedStaffB) > 1 && (
                    <div className="text-[11px] text-amber-600 mt-0.5">Staff cost recomputed by attendance: Rs {staffB.toLocaleString()} (saved was Rs {storedStaffB.toLocaleString()})</div>
                  )}
                  <div className="text-right font-bold text-red-800 mt-2">Grand Total (B): Rs {grandB.toLocaleString()}</div>
                </div>
              );
            })()}

            {(() => {
              // Recompute LOSS/PROFIT with the attendance-filtered staff cost so it
              // matches the by-name Table B above (mam 2026-06-30). Falls back to the
              // saved profit_loss when the breakdown isn't loaded.
              const nonStaffB = (selectedDpr.manpower || []).filter(m => m.trade !== 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const storedStaffB = (selectedDpr.manpower || []).filter(m => m.trade === 'Staff Cost').reduce((s, m) => s + (m.shortage || 0), 0);
              const hasBreakdown = !!(viewStaff && viewStaff.staff && viewStaff.staff.length > 0);
              const staffB = hasBreakdown ? (viewStaff.per_day_cost || 0) : storedStaffB;
              const pl = hasBreakdown ? ((selectedDpr.grand_total_a || 0) - (nonStaffB + staffB)) : (selectedDpr.profit_loss || 0);
              return (
                <div className={`border-2 rounded-lg p-3 text-center ${pl >= 0 ? 'border-emerald-400 bg-emerald-50' : 'border-red-400 bg-red-50'}`}>
                  <span className={`text-xl font-bold ${pl >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {pl >= 0 ? 'PROFIT' : 'LOSS'}: Rs {Math.abs(pl).toLocaleString()}
                  </span>
                </div>
              );
            })()}

            {selectedDpr.machinery?.length > 0 && (
              <div><h5 className="font-semibold text-sm mb-2">Machinery/Tools</h5><table className="text-xs"><thead><tr><th>Equipment</th><th>Qty</th><th>Hours</th><th>Condition</th></tr></thead>
                <tbody>{selectedDpr.machinery.map(m => (<tr key={m.id}><td>{m.equipment}</td><td>{m.quantity}</td><td>{m.hours_used}h</td><td>{m.condition}</td></tr>))}</tbody></table></div>
            )}

            {/* SPOS (mam 2026-07-31): the report shows the day's site-store
                cycle item-wise — Issued (morning slips) / Returned (evening
                slips) / Consumed — merged from the GRN slips + dpr_material. */}
            {(() => {
              const moves = selectedDpr.store_movements || [];
              const mats = selectedDpr.materials || [];
              if (!moves.length && !mats.length) return null;
              const byKey = new Map();
              moves.forEach(mv => byKey.set(mv.item_master_id || mv.item_name, {
                name: mv.item_name || `Item #${mv.item_master_id}`, unit: mv.unit || '',
                issued: mv.issued, returned: mv.returned, consumed: mv.net_consumed, balance: null,
              }));
              mats.forEach(m => {
                const k = m.item_master_id || m.material_name;
                const row = byKey.get(k) || { name: m.material_name, unit: m.unit || '', issued: 0, returned: 0, consumed: 0, balance: null };
                row.consumed = +m.consumed_today || row.consumed;
                row.balance = m.balance_qty;
                byKey.set(k, row);
              });
              const rows = [...byKey.values()];
              return (
                <div>
                  <h5 className="font-semibold text-sm mb-2">Material — Site Store (item-wise)</h5>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead><tr className="text-gray-500 border-b text-left">
                        <th className="py-1 pr-2">Material</th>
                        <th className="py-1 px-2 text-right">Issued</th>
                        <th className="py-1 px-2 text-right">Returned</th>
                        <th className="py-1 px-2 text-right">Consumed</th>
                        <th className="py-1 pl-2 text-right">Store Balance</th>
                      </tr></thead>
                      <tbody>
                        {rows.map((r, i) => (
                          <tr key={i} className="border-b">
                            <td className="py-1 pr-2">{r.name} {r.unit ? <span className="text-gray-400">({r.unit})</span> : null}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{r.issued > 0 ? r.issued : '—'}</td>
                            <td className="py-1 px-2 text-right tabular-nums">{r.returned > 0 ? r.returned : '—'}</td>
                            <td className="py-1 px-2 text-right tabular-nums font-semibold">{r.consumed > 0 ? r.consumed : '—'}</td>
                            <td className="py-1 pl-2 text-right tabular-nums">{r.balance != null ? r.balance : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="text-[10px] text-gray-400 mt-1">Issued/Returned come from the jr. engineer's GRN slips (ISU/RTN); Consumed = issued − returned (or typed when no slips).</p>
                  </div>
                </div>
              );
            })()}
            {selectedDpr.safety_toolbox_talk !== undefined && (
              <div className="flex gap-4 text-sm">
                <span className={selectedDpr.safety_toolbox_talk ? 'text-emerald-600 font-bold' : 'text-red-500'}>TBT: {selectedDpr.safety_toolbox_talk ? 'Done' : 'Not Done'}</span>
                <span className={selectedDpr.safety_ppe_compliance ? 'text-emerald-600 font-bold' : 'text-red-500'}>PPE: {selectedDpr.safety_ppe_compliance ? 'OK' : 'No'}</span>
              </div>
            )}
            {selectedDpr.hindrances && (
              <div className="bg-orange-50 p-3 rounded text-sm">
                <strong className="text-orange-700">Hindrances:</strong>
                {selectedDpr.hindrance_category && <span className="ml-1 text-[10px] px-2 py-0.5 rounded bg-red-100 text-red-700 font-bold uppercase">{selectedDpr.hindrance_category}</span>}
                <div className="mt-1">{selectedDpr.hindrances}</div>
              </div>
            )}
            {selectedDpr.next_day_plan && <div className="bg-emerald-50 p-3 rounded text-sm"><strong className="text-emerald-700">Next Day Plan:</strong> {selectedDpr.next_day_plan}</div>}
            {selectedDpr.remarks && <div className="text-sm"><strong>Remarks:</strong> {selectedDpr.remarks}</div>}
          </div>
        )}
      </Modal>

      {/* ─── Weekly Plan Modal ─────────────────────────────────────
          Site eng picks a site + week-start, fills 7 rows of planned
          work / manpower / cost in one go.  Saves create or update
          the matching dpr rows (one per day) with planned fields
          populated and actuals left blank. */}
      {/* ── Morning Manpower — contractor attendance punch (mam 2026-06-22) ── */}
      <Modal isOpen={mmModal} onClose={() => setMmModal(false)} title="Morning Manpower — Contractor Attendance">
        <div className="space-y-3">
          <p className="text-xs text-gray-500">Record which contractors are on site this morning and how many manpower each brought. This pre-fills the DPR’s “Contractors on Site” when you submit it.</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <select className="select" value={mmSite}
                onChange={e => { setMmSite(e.target.value); loadMorningManpower(e.target.value, mmDate); }}>
                <option value="">Select Site</option>
                {sites.filter(s => s.status === 'active').map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Date *</label>
              <input className="input" type="date" value={mmDate}
                onChange={e => { setMmDate(e.target.value); loadMorningManpower(mmSite, e.target.value); }} />
            </div>
          </div>
          <div>
            <div className="flex items-baseline justify-between mb-1">
              <label className="label mb-0">Contractors present</label>
              <button type="button" onClick={() => setMmRows([...mmRows, { name: '', manpower: 0 }])}
                className="text-xs text-red-600 hover:underline">+ Add Contractor</button>
            </div>
            <div className="space-y-1.5">
              {mmRows.map((c, i) => (
                <div key={i} className="space-y-1">
                  <div className="grid grid-cols-12 gap-2 items-center">
                    <div className="col-span-6">
                      <SearchableSelect
                        options={[
                          ...(c.name && !subcons.find(s => s.name === c.name) ? [{ name: c.name, label: `${c.name} (manual)` }] : []),
                          ...subcons.map(s => ({ ...s, label: s.contractor_type ? `${s.name} — ${s.contractor_type}` : s.name })),
                        ]}
                        value={c.name || ''}
                        valueKey="name"
                        displayKey="label"
                        placeholder={`Contractor ${i + 1}…`}
                        onChange={(s) => { const n = [...mmRows]; n[i] = { ...n[i], name: s?.name || '', subcontractor_id: s?.id || null, contractor_type: s?.contractor_type || null }; setMmRows(n); }}
                      />
                    </div>
                    <input className="input col-span-3" type="number" min="0" placeholder="Manpower"
                      value={c.manpower || ''}
                      onChange={e => { const n = [...mmRows]; n[i] = { ...n[i], manpower: +e.target.value || 0 }; setMmRows(n); }} />
                    {/* Photo → AI auto-counts the people into Manpower (mam 2026-06-22) */}
                    <label className={`col-span-2 btn btn-secondary !py-2 text-[11px] flex items-center justify-center gap-1 cursor-pointer ${c.counting ? 'opacity-60 pointer-events-none' : ''}`}
                      title="Upload a photo of the gang — AI counts the people">
                      <FiCamera size={13} /> {c.counting ? '…' : 'Photo'}
                      <input type="file" accept="image/*" className="hidden" disabled={c.counting}
                        onChange={e => { countFromPhoto(i, e.target.files?.[0]); e.target.value = ''; }} />
                    </label>
                    {mmRows.length > 1 ? (
                      <button type="button" onClick={() => setMmRows(mmRows.filter((_, idx) => idx !== i))}
                        className="col-span-1 text-gray-400 hover:text-red-600 text-lg leading-none">×</button>
                    ) : <div className="col-span-1" />}
                  </div>
                  {(c.photo_url || c.counting) && (
                    <div className="flex items-center gap-2 pl-1">
                      {c.photo_url && <img src={c.photo_url} alt="" className="w-9 h-9 object-cover rounded border" />}
                      <span className="text-[11px] text-gray-500">{c.counting ? 'Counting people in the photo…' : 'Manpower auto-counted from photo — edit if needed'}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <div className="text-xs text-gray-500 mt-2">Total manpower: <b>{mmRows.reduce((s, r) => s + (+r.manpower || 0), 0)}</b> across {mmRows.filter(r => r.name && r.name.trim()).length} contractor(s)</div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => setMmModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="button" onClick={saveMorningManpower} disabled={mmBusy} className="btn btn-primary disabled:opacity-50">{mmBusy ? 'Saving…' : 'Save Morning Manpower'}</button>
          </div>
        </div>
      </Modal>

      {/* ── Contractor Attendance — saved records register (mam 2026-06-24) ── */}
      <Modal isOpen={mmRecModal} onClose={() => setMmRecModal(false)} title="Contractor Attendance — Records" wide>
        <div className="space-y-3">
          <p className="text-xs text-gray-500">All saved morning-manpower attendance. Filter by site and date range.</p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 items-end">
            <div>
              <label className="label">Site</label>
              <select className="select" value={mmRecSite} onChange={e => { setMmRecSite(e.target.value); loadAttendanceRecords({ site: e.target.value }); }}>
                <option value="">All sites</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.lead_no ? `[${s.lead_no}] ` : ''}{s.name}</option>)}
              </select>
            </div>
            <div><label className="label">From</label><input type="date" className="input" value={mmRecFrom} onChange={e => { setMmRecFrom(e.target.value); loadAttendanceRecords({ from: e.target.value }); }} /></div>
            <div><label className="label">To</label><input type="date" className="input" value={mmRecTo} onChange={e => { setMmRecTo(e.target.value); loadAttendanceRecords({ to: e.target.value }); }} /></div>
            {(mmRecSite || mmRecFrom || mmRecTo) && (
              <button type="button" onClick={() => { setMmRecSite(''); setMmRecFrom(''); setMmRecTo(''); loadAttendanceRecords({ site: '', from: '', to: '' }); }} className="btn btn-secondary text-red-500">Clear</button>
            )}
          </div>

          {mmRecBusy ? (
            <p className="text-sm text-gray-400 text-center py-8">Loading…</p>
          ) : mmRecRows.length === 0 ? (
            <p className="text-sm text-gray-400 text-center py-8">No attendance records found.</p>
          ) : (
            <div className="overflow-x-auto max-h-[58vh] border rounded-lg">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 sticky top-0">
                  <tr>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Date</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Site</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Contractor</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Type</th>
                    <th className="px-2 py-2 text-right text-xs font-semibold text-gray-600">Manpower</th>
                    <th className="px-2 py-2 text-center text-xs font-semibold text-gray-600">Photo</th>
                    <th className="px-2 py-2 text-left text-xs font-semibold text-gray-600">Marked By</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {mmRecRows.map(r => (
                    <tr key={r.id} className="hover:bg-gray-50">
                      <td className="px-2 py-1.5 whitespace-nowrap">{r.attendance_date}</td>
                      <td className="px-2 py-1.5">{r.site_name || '—'}</td>
                      <td className="px-2 py-1.5 font-medium">{r.contractor_name}</td>
                      <td className="px-2 py-1.5 text-gray-500">{r.contractor_type || '—'}</td>
                      <td className="px-2 py-1.5 text-right font-semibold">{r.manpower}</td>
                      <td className="px-2 py-1.5 text-center">
                        {r.photo_url
                          ? <a href={r.photo_url} target="_blank" rel="noreferrer"><img src={r.photo_url} alt="" className="w-8 h-8 object-cover rounded border inline-block hover:ring-2 hover:ring-red-300 cursor-zoom-in" /></a>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-2 py-1.5 text-gray-500">{r.marked_by_name || '—'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-100 font-bold border-t-2 border-gray-300">
                    <td className="px-2 py-2" colSpan="4">Total — {mmRecRows.length} record(s)</td>
                    <td className="px-2 py-2 text-right">{mmRecRows.reduce((s, r) => s + (+r.manpower || 0), 0)}</td>
                    <td colSpan="2"></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          <div className="flex justify-end"><button type="button" onClick={() => setMmRecModal(false)} className="btn btn-secondary">Close</button></div>
        </div>
      </Modal>

      <Modal isOpen={planModal} onClose={() => setPlanModal(false)} title="Plan This Week — 7-Day DPR Plan" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <select className="select" value={planSiteId}
                      onChange={e => { setPlanSiteId(e.target.value); openPlanWeek(e.target.value, planWeekStart); }}>
                <option value="">— Pick site —</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Week Starting (Mon) *</label>
              <input type="date" className="input" value={planWeekStart}
                     onChange={e => { setPlanWeekStart(e.target.value); openPlanWeek(planSiteId, e.target.value); }} />
            </div>
          </div>

          {/* ── SPOS approval status banner (mam 2026-07-29) ── */}
          {planHeader?.status === 'submitted' && (
            <div className="bg-blue-50 border border-blue-200 rounded p-2 text-[11px] text-blue-900 flex flex-wrap items-center gap-2">
              <span className="font-semibold">⏳ Pending PM approval</span>
              <span>submitted by {planHeader.submitted_by_name || '—'}</span>
              {!!planHeader.submitted_late && <span className="bg-amber-500 text-white rounded px-1.5 py-0.5 text-[10px] font-bold">LATE</span>}
            </div>
          )}
          {planHeader?.status === 'approved' && (
            <div className="bg-emerald-50 border border-emerald-200 rounded p-2 text-[11px] text-emerald-900 flex flex-wrap items-center gap-2">
              <span className="font-semibold">✓ Approved by {planHeader.approved_by_name || 'PM'}</span>
              {planHeader.auto_indent_number
                ? <span>· auto-indent <span className="font-mono font-semibold">{planHeader.auto_indent_number}</span> raised for the material shortfall</span>
                : <span>· stock covered the full requirement — no indent needed</span>}
            </div>
          )}
          {planHeader?.status === 'rejected' && (
            <div className="bg-red-50 border border-red-200 rounded p-2 text-[11px] text-red-900">
              <span className="font-semibold">✗ Rejected by {planHeader.rejected_by_name || 'PM'}</span>
              {planHeader.rejection_reason ? <> — {planHeader.rejection_reason}</> : null}
              <span className="text-red-700"> · edit the plan and Save to resubmit.</span>
            </div>
          )}
          {planIsLate && (!planHeader || planHeader.status !== 'approved') && (
            <div className="bg-amber-50 border border-amber-300 rounded p-2 text-[11px] text-amber-800">
              Friday cutoff ({planFridayCutoff(planWeekStart)}) has passed — this plan {planHeader ? 'is' : 'will be'} flagged <strong>LATE</strong>.
              Plans must be finalised by Friday for the following week (SPOS rule).
            </div>
          )}

          {/* ── PM approval panel: stock check + auto-indent preview ── */}
          {canApprove('dpr') && planHeader?.status === 'submitted' && (
            <div className="border border-blue-300 bg-blue-50/60 rounded p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-xs font-semibold text-blue-900">PM Approval — automatic stock check &amp; shortfall indent</div>
                <div className="flex gap-2">
                  <button type="button" onClick={rejectWeeklyPlan} disabled={planActing}
                          className="btn btn-danger text-xs py-1">Reject</button>
                  {/* Approve stays disabled until the stock-check preview
                      actually loaded — no blind approvals (audit). */}
                  <button type="button" onClick={approveWeeklyPlan} disabled={planActing || !planShortfall}
                          title={!planShortfall ? 'Wait for the stock check to load' : ''}
                          className="btn btn-success text-xs py-1">{planActing ? 'Working…' : 'Approve & Auto-Indent'}</button>
                </div>
              </div>
              {planShortfall ? (
                planShortfall.lines.length === 0 ? (
                  <div className="text-[11px] text-gray-600">No BOQ items with planned quantities in this week — approving will not raise any indent.</div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-[11px]">
                      <thead>
                        <tr className="text-gray-500 border-b">
                          <th className="text-left py-1 pr-2">BOQ Item</th>
                          <th className="text-right py-1 px-2">Planned</th>
                          <th className="text-right py-1 px-2">Site Stock</th>
                          <th className="text-right py-1 px-2">In Pipeline</th>
                          <th className="text-right py-1 pl-2 font-semibold">To Indent</th>
                        </tr>
                      </thead>
                      <tbody>
                        {planShortfall.lines.map(l => (
                          <tr key={l.po_item_id} className="border-b border-blue-100">
                            <td className="py-1 pr-2">{l.description}{l.unit ? ` (${l.unit})` : ''}</td>
                            <td className="py-1 px-2 text-right">{l.planned_qty}</td>
                            <td className="py-1 px-2 text-right">{l.site_stock}</td>
                            <td className="py-1 px-2 text-right">{l.pipeline_qty}</td>
                            <td className={`py-1 pl-2 text-right font-semibold ${l.to_indent > 0 || l.capped ? 'text-red-700' : 'text-emerald-700'}`}>
                              {l.to_indent > 0 ? l.to_indent
                                : l.capped ? 'SHORT — BOQ cap reached'
                                : '✓ covered'}
                              {l.capped && l.to_indent > 0 && <span title="Clamped to remaining BOQ cap" className="ml-1 text-amber-600">⚠BOQ cap</span>}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {!planShortfall.has_store && (
                      <div className="text-[10px] text-amber-700 mt-1">No site store found for this site — stock counted as 0. Create one in Inventory → Warehouses for real stock checks.</div>
                    )}
                    <div className="text-[10px] text-gray-500 mt-1">
                      To Indent = Planned − Site Stock − qty already on open indents (capped to remaining BOQ). Approving raises ONE Material indent into the normal L1/L2 queue.
                    </div>
                  </div>
                )
              ) : planShortfallErr ? (
                <div className="text-[11px] text-red-600 flex items-center gap-2">
                  Stock check failed to load — Approve stays disabled.
                  <button type="button" className="text-blue-700 hover:underline font-medium"
                          onClick={() => planHeader?.id && loadPlanShortfall(planHeader.id)}>↻ Retry</button>
                </div>
              ) : (
                <div className="text-[11px] text-gray-500">Loading stock check…</div>
              )}
            </div>
          )}

          {/* 7-day weather guide (mam 2026-07-31) */}
          {planWeather?.days?.length > 0 && (
            <div className="bg-sky-50 border border-sky-200 rounded p-2">
              <div className="text-[10px] font-semibold text-sky-800 mb-1">🌤 Agle 7 din ka mausam — {planWeather.place} <span className="font-normal text-sky-600">(barish wale din indoor kaam plan karo)</span></div>
              <div className="flex gap-1 overflow-x-auto">
                {planWeather.days.map(d => (
                  <div key={d.date} className={`flex-1 min-w-[64px] text-center rounded border px-1 py-1 ${d.key === 'rainy' ? 'bg-red-50 border-red-200' : 'bg-white border-sky-100'}`}>
                    <div className="text-[9px] text-gray-500">{new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit' })}</div>
                    <div className="text-base leading-5">{d.emoji}</div>
                    <div className="text-[9px] font-semibold text-gray-700">{d.tmax}°/{d.tmin}°</div>
                    {d.rain_prob != null && d.rain_prob >= 40 && <div className="text-[8px] font-bold text-red-600">☔ {d.rain_prob}%</div>}
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-[11px] text-gray-700">
            Pick a BOQ item from the site's PO and the quantity planned for that day.
            Manpower + budgeted cost are filled alongside. The site engineer updates the
            <strong> actual </strong> values daily via the Submit DPR form — the row for that date will be filled in,
            not duplicated.
            {planSiteId && planBoqItems.length === 0 && (
              <div className="mt-1 text-amber-700">
                <strong>No BOQ items found</strong> for this site's PO. You can still plan with free-text descriptions below,
                or upload the BOQ via Orders & Planning → PO Upload.
              </div>
            )}
          </div>

          {/* Per-day cards.  Each day has a header row (day, date,
              manpower, cost) and a nested table of BOQ items the
              user can add / remove / edit. */}
          <div className="space-y-3">
            {planDays.map((d, i) => {
              const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d.date).getDay()];
              const isSunday = dayName === 'Sun';
              return (
                <div key={d.date} className={`border rounded ${isSunday ? 'bg-gray-50' : 'bg-white'}`}>
                  <div className="grid grid-cols-12 gap-2 items-center px-3 py-2 border-b bg-gray-50/50 text-xs">
                    <div className="col-span-1 font-semibold">{i + 1}</div>
                    <div className="col-span-2 font-semibold">{dayName}{isSunday ? ' · off' : ''}</div>
                    <div className="col-span-3 font-mono text-[11px]">{d.date}</div>
                    <div className="col-span-2 text-right text-gray-600">Manpower</div>
                    <div className="col-span-2">
                      <input type="number" min="0" className="input text-xs text-right w-full"
                             value={d.planned_manpower}
                             onChange={e => updatePlanDay(i, { planned_manpower: +e.target.value })} />
                    </div>
                    <div className="col-span-2">
                      <input type="number" min="0" step="100" className="input text-xs text-right w-full"
                             placeholder="Cost (₹)"
                             value={d.planned_grand_total_b}
                             onChange={e => updatePlanDay(i, { planned_grand_total_b: +e.target.value })} />
                    </div>
                  </div>

                  <div className="px-3 py-2">
                    {planBoqItems.length === 0 && !isSunday && (
                      <div className="text-[11px] text-amber-700">No BOQ items found for this site's PO — upload BOQ via Orders & Planning to enable item-level planning.</div>
                    )}
                    {planBoqItems.length > 0 && (
                      <>
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="text-gray-500">
                              <th className="text-left py-1">BOQ Item</th>
                              <th className="text-right py-1 w-32">Planned Qty</th>
                              <th className="w-8"></th>
                            </tr>
                          </thead>
                          <tbody>
                            {(d.items || []).map((it, j) => {
                              const boq = planBoqItems.find(b => +b.id === +it.po_item_id);
                              return (
                                <tr key={j} className="border-t">
                                  <td className="py-1 pr-2">
                                    <select className="select text-xs w-full"
                                            value={it.po_item_id || ''}
                                            onChange={e => updatePlanItem(i, j, { po_item_id: e.target.value })}>
                                      <option value="">— Pick BOQ item —</option>
                                      {planBoqItems.map(b => (
                                        <option key={b.id} value={b.id}>
                                          {b.description || `Item #${b.id}`}{b.unit ? ` (${b.unit})` : ''}{b.quantity ? ` · BOQ qty: ${b.quantity}` : ''}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="py-1 text-right">
                                    <input type="number" min="0" step="0.01" className="input text-xs text-right w-full"
                                           value={it.planned_qty || ''}
                                           onChange={e => updatePlanItem(i, j, { planned_qty: +e.target.value })}
                                           disabled={!it.po_item_id}
                                           placeholder={boq?.unit || 'qty'} />
                                  </td>
                                  <td className="py-1 text-center">
                                    <button type="button" onClick={() => removePlanItem(i, j)}
                                            className="text-gray-400 hover:text-red-600 text-lg leading-none px-1"
                                            title="Remove item">×</button>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <button type="button" onClick={() => addPlanItem(i)}
                                className="text-[11px] text-red-600 hover:text-red-800 underline mt-1">
                          + Add BOQ item to this day
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Week totals + planned labour P/L (mam 2026-07-31: "weekly &
              daily profit/loss in planning & actual both" — labour rates
              from data, NOT BOQ SITC; 11% fallback until rates collected). */}
          {(() => {
            const rateOf = (poItemId) => {
              const it = planBoqItems.find(b => +b.id === +poItemId);
              if (!it) return 0;
              return +it.labour_rate > 0 ? +it.labour_rate : (+it.rate || 0) * 0.11;
            };
            const dayA = (d) => (d.items || []).reduce((s, it) => s + (+it.planned_qty || 0) * rateOf(it.po_item_id), 0);
            const totalA = planDays.reduce((s, d) => s + dayA(d), 0);
            const totalB = planDays.reduce((s, d) => s + (+d.planned_grand_total_b || 0), 0);
            const totalPl = totalA - totalB;
            return (
              <div className="bg-gray-50 border rounded px-3 py-2 text-xs space-y-1">
                <div className="flex flex-wrap justify-between gap-x-2 gap-y-0.5 font-semibold">
                  <span>Week Totals</span>
                  <span className="text-right">{planDays.reduce((s, d) => s + (+d.planned_manpower || 0), 0)} men-days · Labour (A) ₹{Math.round(totalA).toLocaleString('en-IN')} · Cost (B) ₹{Math.round(totalB).toLocaleString('en-IN')}</span>
                </div>
                <div className="flex justify-between items-center">
                  <span className="text-gray-500">Plan P/L (labour rates se — BOQ rate nahi)</span>
                  <span className={`font-bold ${totalPl >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {totalPl >= 0 ? 'PROFIT' : 'LOSS'} ₹{Math.abs(Math.round(totalPl)).toLocaleString('en-IN')}
                  </span>
                </div>
                <div className="text-[10px] text-gray-500 flex flex-wrap gap-x-3">
                  {planDays.map((d, i) => {
                    const a = dayA(d), b = +d.planned_grand_total_b || 0, p = a - b;
                    if (!a && !b) return null;
                    return <span key={i}>{new Date(d.date + 'T00:00:00').toLocaleDateString('en-IN', { weekday: 'short' })}: <b className={p >= 0 ? 'text-emerald-700' : 'text-red-600'}>₹{Math.round(p).toLocaleString('en-IN')}</b></span>;
                  })}
                </div>
              </div>
            );
          })()}

          <div className="flex flex-wrap justify-end items-center gap-2 pt-2 border-t">
            {planHeader?.status === 'approved' && !isAdmin() && (
              <div className="text-[11px] text-gray-500 mr-auto">✓ Approved &amp; locked — ask an admin to change this week (re-approval needed).</div>
            )}
            <button onClick={() => setPlanModal(false)} className="btn btn-secondary">Cancel</button>
            {(planHeader?.status !== 'approved' || isAdmin()) && (
              <button onClick={savePlanWeek} disabled={planSaving || !planSiteId} className="btn btn-primary">
                {planSaving ? 'Saving…' : planHeader ? 'Save & Resubmit for Approval' : 'Save Week Plan'}
              </button>
            )}
          </div>
        </div>
      </Modal>

      {/* Site-store Issue/Return slip counter (mam 2026-07-31): jr. site
          engineer issues material on a numbered ISU slip (stock OUT now),
          takes back the evening balance on an RTN slip (stock IN). Net
          consumption auto-fills the DPR. Every slip prints as a GRN bill. */}
      <Modal isOpen={slipModal} onClose={() => setSlipModal(false)} title="Site Store — Material Issue / Return (GRN Slip)" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Site *</label>
              <select className="select" value={slipSite}
                      onChange={e => { setSlipSite(e.target.value); loadSlipRows(e.target.value, slipType, slipDate); }}>
                <option value="">— Pick site —</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Type *</label>
              <div className="flex rounded border overflow-hidden">
                <button type="button" onClick={() => { setSlipType('issue'); loadSlipRows(slipSite, 'issue', slipDate); }}
                        className={`flex-1 py-2 text-xs font-semibold ${slipType === 'issue' ? 'bg-red-600 text-white' : 'bg-white text-gray-600'}`}>
                  🌅 Morning Issue
                </button>
                <button type="button" onClick={() => { setSlipType('return'); loadSlipRows(slipSite, 'return', slipDate); }}
                        className={`flex-1 py-2 text-xs font-semibold ${slipType === 'return' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600'}`}>
                  🌇 Evening Return
                </button>
              </div>
            </div>
            <div>
              <label className="label">Date</label>
              <input type="date" className="input" value={slipDate}
                     onChange={e => { setSlipDate(e.target.value); loadSlipRows(slipSite, slipType, e.target.value); }} />
            </div>
          </div>

          {/* Shift tag (mam 2026-07-31: 3-shift method) — auto from IST clock */}
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[11px] text-gray-500 font-semibold">Shift:</span>
            {[['day', '🌅 Morning 9–6'], ['evening', '🌆 Evening 6–10'], ['night', '🌙 Night 10–2']].map(([k, l]) => (
              <button key={k} type="button" onClick={() => setSlipShift(k)}
                className={`text-[11px] px-2 py-1 rounded border font-semibold ${slipShift === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}>{l}</button>
            ))}
          </div>

          <div>
            <label className="label">{slipType === 'issue' ? 'Issued To (Sr. Site Engineer / team) *' : 'Returned By *'}</label>
            <input className="input" list="slip-person-suggestions" placeholder="Type a name or pick from the team…"
                   value={slipTo} onChange={e => setSlipTo(e.target.value)} />
            <datalist id="slip-person-suggestions">
              {(users || []).map(u => <option key={u.id} value={u.name} />)}
            </datalist>
          </div>

          {slipSite && slipRows.length === 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
              {slipType === 'issue' ? (
                <>
                  <b>This site's store has no stock yet</b> — item names appear here from the site store's inventory. Fill it in any of 3 ways (Inventory module):
                  <ul className="list-disc ml-4 mt-1 space-y-0.5">
                    <li><b>Opening Stock (item-wise)</b> — record material already lying at site.</li>
                    <li><b>Issue / Transfer (OUT)</b> — move stock office store → this site's store.</li>
                    <li><b>Receive a PO</b> into this site's store warehouse (Dispatch &amp; Receiving → Mark Received → pick the site warehouse).</li>
                  </ul>
                </>
              ) : 'Nothing outstanding to return — no material issued (and not yet returned) on this date.'}
            </div>
          )}
          {slipRows.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b">
                    <th className="text-left py-1 pr-2">Material</th>
                    <th className="text-right py-1 px-2 whitespace-nowrap">{slipType === 'issue' ? 'In Store' : 'Outstanding'}</th>
                    {slipType === 'issue' && <th className="text-right py-1 px-2 whitespace-nowrap">Aaj Ka Plan</th>}
                    <th className="text-right py-1 pl-2 w-32 whitespace-nowrap">{slipType === 'issue' ? 'Issue Qty (suggested)' : 'Return Qty'}</th>
                  </tr>
                </thead>
                <tbody>
                  {slipRows.map((r, i) => (
                    <tr key={r.item_master_id} className="border-b">
                      <td className="py-1 pr-2 min-w-[150px] break-words">
                        {r.name} <span className="text-gray-400 whitespace-nowrap">({r.unit})</span>
                        {r.age_status === 'orange' && <span title={`${r.age_days} din se store mein pada hai (15 allowed)`} className="ml-1 text-[9px] font-bold px-1 py-0.5 rounded border bg-amber-50 text-amber-700 border-amber-300">🟠 {r.age_days}d</span>}
                        {r.age_status === 'red' && <span title={`${r.age_days} din se store mein pada hai (max 30!)`} className="ml-1 text-[9px] font-bold px-1 py-0.5 rounded border bg-red-50 text-red-700 border-red-300">🔴 {r.age_days}d</span>}
                      </td>
                      <td className="py-1 px-2 text-right tabular-nums whitespace-nowrap">{r.cap}</td>
                      {slipType === 'issue' && <td className="py-1 px-2 text-right tabular-nums text-blue-700 whitespace-nowrap">{r.planned_today > 0 ? r.planned_today : <span className="text-gray-300">—</span>}</td>}
                      <td className="py-1 pl-2 text-right min-w-[100px]">
                        <input type="number" min="0" max={r.cap} step="0.01"
                               disabled={slipType === 'issue' && r.cap <= 0}
                               title={slipType === 'issue' && r.cap <= 0 ? 'Store mein 0 hai — pehle stock lao (Opening Stock / transfer / PO receive)' : ''}
                               className={`input text-xs text-right w-full ${slipType === 'issue' && r.cap <= 0 ? 'bg-gray-100 text-gray-400 cursor-not-allowed' : ''} ${+r.qty > r.cap ? '!border-red-400 bg-red-50' : ''} ${slipType === 'issue' && +r.qty > 0 && +r.qty === +r.planned_today ? 'bg-blue-50' : ''}`}
                               value={r.qty} placeholder="0"
                               onChange={e => setSlipRows(prev => prev.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div>
            <label className="label">Notes</label>
            <input className="input" value={slipNotes} onChange={e => setSlipNotes(e.target.value)} placeholder="Optional — e.g. 3rd floor riser work" />
          </div>

          {/* Today's register — reprint any slip */}
          {slipsToday.length > 0 && (
            <div className="bg-gray-50 border rounded p-2">
              <div className="text-[11px] font-semibold text-gray-600 mb-1">Slips on {slipDate}</div>
              {slipsToday.map(s => (
                <div key={s.id} className="flex flex-wrap items-center gap-2 text-[11px] py-0.5">
                  <span className={`font-mono font-semibold ${s.slip_type === 'issue' ? 'text-red-700' : 'text-emerald-700'}`}>{s.slip_number}</span>
                  <span>{s.shift === 'evening' ? '🌆' : s.shift === 'night' ? '🌙' : '🌅'}</span>
                  <span className="text-gray-500">{s.slip_type === 'issue' ? 'Issue →' : 'Return ←'} {s.issued_to}</span>
                  <span className="text-gray-400">· {(s.items || []).length} item(s)</span>
                  <a className="text-blue-700 hover:underline font-medium" href={`/site-slip/${s.id}/print`} target="_blank" rel="noreferrer">Print</a>
                </div>
              ))}
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setSlipModal(false)} className="btn btn-secondary">Close</button>
            <button onClick={saveSlip} disabled={slipBusy || !slipSite} className="btn btn-primary">
              {slipBusy ? 'Saving…' : slipType === 'issue' ? 'Save Issue Slip & Print' : 'Save Return Slip & Print'}
            </button>
          </div>
        </div>
      </Modal>

      {/* SPOS (mam 2026-07-29): PM's queue of weekly plans awaiting approval */}
      <Modal isOpen={pendingPlansModal} onClose={() => setPendingPlansModal(false)} title="Weekly Plans — Pending PM Approval">
        <div className="space-y-2">
          {pendingPlans.length === 0 && <div className="text-sm text-gray-500">Nothing pending — all weekly plans are approved.</div>}
          {pendingPlans.map(p => (
            <div key={p.id} className="border rounded p-2 flex flex-wrap items-center gap-2 text-xs">
              <div className="flex-1 min-w-[160px]">
                <div className="font-semibold">{p.site_name}</div>
                <div className="text-gray-500">
                  week of {p.week_start} · by {p.submitted_by_name || '—'}
                  {!!p.submitted_late && <span className="ml-1 bg-amber-500 text-white rounded px-1 text-[10px] font-bold">LATE</span>}
                </div>
              </div>
              <button className="btn btn-primary text-xs py-1"
                      onClick={() => { setPendingPlansModal(false); openPlanWeek(String(p.site_id), p.week_start); }}>
                Open &amp; Review
              </button>
            </div>
          ))}
        </div>
      </Modal>
    </div>
  );
}

// AgeingWidget — SPOS inventory ageing (mam 2026-07-31): "sr. engineer is
// responsible for inventory ageing, 15 days allowed only, maximum 30 —
// make it live." Live read of site-store stock vs last IN date.
function AgeingWidget() {
  const [data, setData] = useState(null);
  const [lastAt, setLastAt] = useState(null);
  // LIVE (mam 2026-08-03: "make it live") — refreshes every 60s while the
  // dashboard is open, so the ageing count is never stale.
  useEffect(() => {
    const pull = () => api.get('/dpr/site-store-ageing')
      .then(r => { setData(r.data); setLastAt(new Date()); })
      .catch(() => {});
    pull();
    const t = setInterval(pull, 60000);
    return () => clearInterval(t);
  }, []);
  const rows = data?.rows || [];
  const flagged = rows.filter(r => r.status === 'orange' || r.status === 'red');
  const redCount = data?.red_count || 0;
  return (
    <div className={`card p-4 border-l-4 ${redCount > 0 ? 'border-red-500' : flagged.length ? 'border-amber-500' : 'border-emerald-500'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div>
          <h3 className="font-semibold text-gray-800">🕰 Inventory Ageing — Site Store <span className="text-xs font-normal text-gray-500">(Sr. Site Engineer ki zimmedari)</span></h3>
          <p className="text-xs text-gray-500">
            SPOS RULE: material site store mein <b>15 din tak allowed</b>, <b className="text-red-600">maximum 30 din</b> — uske baad management report mein jayega.
            Age = aakhri material IN hone ke baad ke din. {lastAt && <span className="text-gray-400">LIVE · updated {lastAt.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}</span>}
          </p>
        </div>
        {rows.length === 0
          ? <span className="text-xs font-semibold text-gray-500 bg-gray-50 border border-gray-200 rounded px-2 py-1">Site stores khaali hain — stock aate hi ageing yahan LIVE dikhega</span>
          : flagged.length === 0
          ? <span className="text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-300 rounded px-2 py-1">✓ Sab fresh hai ({rows.length} item, sab ≤ 15 din)</span>
          : <span className={`text-xs font-bold rounded px-2 py-1 border ${redCount > 0 ? 'bg-red-50 text-red-700 border-red-300 animate-pulse' : 'bg-amber-50 text-amber-700 border-amber-300'}`}>
              {flagged.length} item purane {redCount > 0 ? `· ${redCount} RED (30+ din!)` : ''}
            </span>}
      </div>
      {flagged.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-gray-500 border-b text-left">
              <th className="py-1 pr-2">Site</th>
              <th className="py-1 px-2">Sr. Engineer (responsible)</th>
              <th className="py-1 px-2">Material</th>
              <th className="py-1 px-2 text-right">Qty</th>
              <th className="py-1 pl-2 text-right">Kitne din se pada hai</th>
            </tr></thead>
            <tbody>
              {flagged.slice(0, 15).map((r, i) => (
                <tr key={i} className="border-b">
                  <td className="py-1 pr-2 min-w-[120px] break-words">{r.site_name}</td>
                  <td className="py-1 px-2 min-w-[110px]">{r.engineer_name || <span className="text-red-500 font-semibold whitespace-nowrap">koi assign nahi!</span>}</td>
                  <td className="py-1 px-2 min-w-[140px] break-words">{r.material_name} <span className="text-gray-400 whitespace-nowrap">({r.uom || 'nos'})</span></td>
                  <td className="py-1 px-2 text-right tabular-nums whitespace-nowrap">{r.quantity}</td>
                  <td className="py-1 pl-2 text-right whitespace-nowrap">
                    <span className={`font-bold px-1.5 py-0.5 rounded border text-[10px] ${r.status === 'red' ? 'bg-red-50 text-red-700 border-red-300' : 'bg-amber-50 text-amber-700 border-amber-300'}`}>
                      {r.age_days} din {r.status === 'red' ? '🔴' : '🟠'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="text-[10px] text-gray-500 mt-1">Kya karna hai: use karo (DPR consumption) · doosri site bhejo · office wapas bhejo (transfer). 30+ din wale items roz shaam 6:30 ki Exception Report mein management ko jate hain.</p>
        </div>
      )}
    </div>
  );
}

// AajKaUpdate — SPOS "Aaj Ka Update" (mam 2026-07-31, UX redesign prompt):
// ek hi sawaal — "Aaj kya kaam hua?" 90% auto-filled from the approved
// weekly plan + GRN slips + morning punch; engineer sirf "kitna hua" +
// photos deta hai. Submit auto-builds the full DPR (labour-rate P/L —
// BOQ SITC rates NOT used; po_items.labour_rate, else 11% fallback).
function AajKaUpdate() {
  const istToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const autoShift = () => {
    const h = +new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: '2-digit', hour12: false });
    return (h >= 9 && h < 18) ? 'day' : (h >= 18 && h < 22) ? 'evening' : 'night';
  };
  const [sites, setSites] = useState([]);
  const [siteId, setSiteId] = useState('');
  const date = istToday();
  const [shift, setShift] = useState(autoShift());
  const [plan, setPlan] = useState(null);
  const [rows, setRows] = useState([]);
  const [mats, setMats] = useState([]);
  const [men, setMen] = useState(0);
  const [menRate, setMenRate] = useState(800);
  const [photos, setPhotos] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState('');
  const [problemCat, setProblemCat] = useState('');
  const [weather, setWeather] = useState(null);
  const [pl, setPl] = useState(null);
  const [aged, setAged] = useState([]);   // 15+/30+ din old store items (site-wise)
  const [busy, setBusy] = useState(false);
  const siteRef = useRef('');             // stale-response guard for async loads

  useEffect(() => { api.get('/dpr/sites').then(r => setSites(r.data || [])).catch(() => {}); }, []);

  const load = async (sid) => {
    siteRef.current = String(sid || '');
    setSiteId(sid); setPlan(null); setRows([]); setMats([]); setPhotos([]); setProblem(''); setProblemCat(''); setPl(null); setWeather(null); setAged([]);
    if (!sid) return;
    try {
      const [tp, cons, pls, ag] = await Promise.all([
        api.get(`/dpr/sites/${sid}/today-plan`, { params: { date } }),
        api.get(`/dpr/sites/${sid}/consumption`, { params: { date } }),
        api.get('/dpr/pl-summary', { params: { site_id: sid, date } }).catch(() => ({ data: null })),
        api.get('/dpr/site-store-ageing', { params: { site_id: sid } }).catch(() => ({ data: { rows: [] } })),
      ]);
      if (siteRef.current !== String(sid)) return;   // site changed mid-flight
      setPlan(tp.data);
      setRows((tp.data.items || []).map(it => ({ ...it, done: '' })));
      setMats((cons.data?.lines || []).filter(l => l.issued > 0 || l.net_consumed > 0));
      setMen(tp.data.punched_manpower || 0);
      setPl(pls.data);
      setAged((ag.data?.rows || []).filter(r => r.status === 'orange' || r.status === 'red'));
    } catch (e) { toast.error(e.response?.data?.error || 'Load fail hua'); }
    // Weather loads in the background — a slow/blocked weather API must
    // never delay the screen (mam 2026-08-03: "erp will not hang").
    // Stale-response guard: drop the reply if the site changed meanwhile.
    api.get(`/dpr/sites/${sid}/weather`)
      .then(w => { if (siteRef.current === String(sid)) setWeather(w.data?.available ? w.data : null); })
      .catch(() => {});
  };

  const uploadPhotos = async (files) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        const fd = new FormData(); fd.append('file', f);
        const up = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        if (up.data?.url) setPhotos(prev => [...prev, up.data.url]);
      }
      toast.success('Photo upload ho gayi 📸');
    } catch { toast.error('Photo upload fail hui — dobara try karo'); }
    finally { setUploading(false); }
  };

  const doneA = rows.reduce((s, r) => s + (+r.done || 0) * (+r.labour_rate || 0), 0);
  const costB = (+men || 0) * (+menRate || 0);
  const livePl = Math.round((doneA - costB) * 100) / 100;
  const shiftsDone = plan?.shifts_submitted || [];
  const SHIFT_META = { day: ['🌅', 'Morning 9–6'], evening: ['🌆', 'Evening 6–10'], night: ['🌙', 'Night 10–2'] };

  const submit = async () => {
    if (!siteId) return toast.error('Pehle site chuno');
    if (!rows.some(r => +r.done > 0) && !mats.some(m => m.net_consumed > 0)) return toast.error('Kitna kaam hua — kam se kam ek activity mein qty bharo');
    if (livePl < 0 && (!problem.trim() || !problemCat)) return toast.error('Aaj loss dikh raha hai — Problem aur category batana zaroori hai');
    setBusy(true);
    try {
      await api.post('/dpr', {
        site_id: +siteId, report_date: date, shift,
        weather: weather?.current?.key || 'clear',
        overall_status: livePl >= 0 ? 'on_track' : 'delayed',
        work_items: rows.filter(r => +r.done > 0).map(r => ({
          po_item_id: r.po_item_id, description: r.description, unit: r.unit,
          qty: +r.done, rate: Math.round((+r.labour_rate || 0) * 100) / 100, location: '',
        })),
        manpower: [{ type: 'Skilled Manpower', qty: +men || 0, rate: +menRate || 0, amount: costB }],
        machinery: [],
        materials: mats.filter(m => m.net_consumed > 0).map(m => ({
          item_master_id: m.item_master_id, material_name: m.item_name, unit: m.unit,
          consumed_today: m.net_consumed, cumulative_consumed: m.net_consumed, from_slips: 1, balance_qty: 0,
        })),
        contractors: [],
        site_photos: photos,
        hindrances: problem.trim() || null,
        hindrance_category: problemCat || null,
        grand_total_a: Math.round(doneA * 100) / 100,
        grand_total_b: costB,
        profit_loss: livePl,
      });
      toast.success('✅ DPR ban gaya — shabash!');
      load(siteId);
    } catch (e) { toast.error(e.response?.data?.error || 'Submit fail hua'); }
    finally { setBusy(false); }
  };

  const plChip = (label, v) => v && (
    <div className="text-center px-3">
      <div className={`text-sm font-bold ${v.actual.pl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>₹{Math.round(v.actual.pl).toLocaleString('en-IN')}</div>
      <div className="text-[10px] text-gray-500">{label} (plan ₹{Math.round(v.planned.pl).toLocaleString('en-IN')})</div>
    </div>
  );

  return (
    <div className="max-w-3xl mx-auto space-y-4">
      <div className="card p-4">
        <h2 className="text-lg font-bold text-gray-800">🏗️ Aaj Ka Update</h2>
        <p className="text-xs text-gray-500">Ek hi sawaal: <b>aaj kitna kaam hua?</b> Baaki sab (plan, material, log) auto hai — 5 minute se kam lagega.</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
          <select className="select text-base" value={siteId} onChange={e => load(e.target.value)}>
            <option value="">— Apni site chuno —</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <div className="flex rounded border overflow-hidden">
            {[['day', '🌅 Morning', '9–6'], ['evening', '🌆 Evening', '6–10'], ['night', '🌙 Night', '10–2']].map(([k, l, t]) => (
              <button key={k} type="button" onClick={() => setShift(k)}
                className={`flex-1 py-2 text-xs font-semibold ${shift === k ? 'bg-blue-600 text-white' : 'bg-white text-gray-600'}`}>
                {l}<span className="block text-[9px] font-normal opacity-80">{t}</span>
              </button>
            ))}
          </div>
        </div>
        {weather?.current && (
          <div className="mt-2 text-xs bg-sky-50 border border-sky-200 rounded px-2 py-1.5 inline-flex items-center gap-2">
            {weather.current.emoji} <b>{weather.current.label}</b> · {weather.current.temp}°C
            <span className="text-gray-400">· {weather.place}</span>
            <span className="text-gray-400">(DPR mein auto bharega)</span>
          </div>
        )}
        {/* Three-shift status (mam 2026-08-03): har shift ka data ADD hota
            hai — morning ke upar evening, evening ke upar night. */}
        {siteId && shiftsDone.length > 0 && (
          <div className="mt-2 text-xs bg-emerald-50 border border-emerald-300 rounded px-2 py-1.5 flex flex-wrap items-center gap-2">
            {['day', 'evening', 'night'].map(k => shiftsDone.includes(k) && (
              <span key={k} className="font-semibold text-emerald-700">{SHIFT_META[k][0]} {SHIFT_META[k][1]} ✓</span>
            ))}
            <span className="text-gray-500">— ab {SHIFT_META[shift][0]} {SHIFT_META[shift][1]} bharo: data <b>add</b> hoga, pehle wali shift replace nahi hogi. (Same shift dobara bharoge to sirf usi shift ka data update hoga.)</span>
          </div>
        )}
      </div>

      {siteId && (
        <>
          {/* Inventory ageing nudge (mam 2026-08-03): purana material pehle
              lagao — 15 din allowed, 30 max, Sr. Engineer responsible. */}
          {aged.length > 0 && (
            <div className={`card p-3 border-l-4 ${aged.some(a => a.status === 'red') ? 'border-red-500 bg-red-50' : 'border-amber-500 bg-amber-50'}`}>
              <div className="text-xs font-bold text-gray-800 mb-1">🕰 Purana material store mein pada hai — pehle inko lagao! <span className="font-normal text-gray-500">(15 din allowed · 30 max)</span></div>
              <div className="flex flex-wrap gap-1.5">
                {aged.map((a, i) => (
                  <span key={i} className={`text-[10px] font-semibold px-1.5 py-0.5 rounded border ${a.status === 'red' ? 'bg-white text-red-700 border-red-300' : 'bg-white text-amber-700 border-amber-300'}`}>
                    {a.status === 'red' ? '🔴' : '🟠'} {a.material_name} · {a.quantity} {a.uom || ''} · {a.age_days} din
                  </span>
                ))}
              </div>
            </div>
          )}

          <div className="card p-4">
            <h3 className="font-semibold text-sm text-gray-800 mb-1">1️⃣ Aaj Ka Kaam <span className="text-xs font-normal text-gray-400">(weekly plan se auto)</span></h3>
            {rows.length === 0 ? (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">Aaj ke liye plan mein koi activity nahi hai. Sr. Engineer se weekly plan approve karwao.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-gray-500 text-xs border-b text-left">
                    <th className="py-1 pr-2">Kaam</th><th className="py-1 px-2 text-right">Target</th>
                    <th className="py-1 pl-2 text-right w-28">Kitna Hua?</th>
                  </tr></thead>
                  <tbody>
                    {rows.map((r, i) => (
                      <tr key={i} className="border-b">
                        {/* min-widths: crush hone ki jagah table scroll kare —
                            mobile par words kabhi na kate (mam 2026-08-03) */}
                        <td className="py-2 pr-2 min-w-[150px] break-words">{r.description} <span className="text-gray-400 text-xs whitespace-nowrap">({r.unit})</span></td>
                        <td className="py-2 px-2 text-right tabular-nums text-gray-600 whitespace-nowrap">{r.planned_qty}</td>
                        <td className="py-2 pl-2 min-w-[150px]">
                          <div className="flex items-center gap-1">
                            <input type="number" min="0" step="0.01" placeholder="0"
                              className="input text-right text-base font-semibold w-full min-w-[70px]"
                              value={r.done}
                              onChange={e => setRows(prev => prev.map((x, j) => j === i ? { ...x, done: e.target.value } : x))} />
                            {/* One-tap confirm: "target jitna hua" — deliberate
                                tap, not auto-fill, so 100% days stay honest */}
                            <button type="button" title="Target jitna hua — ek tap"
                              onClick={() => setRows(prev => prev.map((x, j) => j === i ? { ...x, done: String(x.planned_qty) } : x))}
                              className={`text-[10px] font-semibold border rounded px-1.5 py-1 whitespace-nowrap flex-shrink-0 ${+r.done === +r.planned_qty && +r.done > 0 ? 'bg-emerald-600 text-white border-emerald-600' : 'text-emerald-700 border-emerald-300 hover:bg-emerald-50'}`}>
                              ✓ full
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-sm text-gray-800 mb-1">2️⃣ Material <span className="text-xs font-normal text-gray-400">(GRN slips se auto — kuch nahi bharna)</span></h3>
            {mats.length === 0
              ? <div className="text-xs text-gray-500">Aaj koi material issue nahi hua. Store se material lena ho to <b>Daily Reports → Store Issue/Return</b> se slip banao.</div>
              : (
                <table className="w-full text-xs">
                  <thead><tr className="text-gray-500 border-b text-left"><th className="py-1 pr-2">Material</th><th className="py-1 px-2 text-right">Issue</th><th className="py-1 px-2 text-right">Wapas</th><th className="py-1 pl-2 text-right">Laga (auto)</th></tr></thead>
                  <tbody>{mats.map((m, i) => (
                    <tr key={i} className="border-b">
                      <td className="py-1 pr-2">{m.item_name} <span className="text-gray-400">({m.unit})</span></td>
                      <td className="py-1 px-2 text-right tabular-nums">{m.issued}</td>
                      <td className="py-1 px-2 text-right tabular-nums">{m.returned}</td>
                      <td className="py-1 pl-2 text-right tabular-nums font-bold text-indigo-700">{m.net_consumed}</td>
                    </tr>
                  ))}</tbody>
                </table>
              )}
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-sm text-gray-800 mb-1">3️⃣ Kitne Log Lage? <span className="text-xs font-normal text-gray-400">(morning punch se auto — badal sakte ho)</span></h3>
            <div className="flex items-center gap-3 flex-wrap">
              <input type="number" min="0" className="input text-2xl font-bold text-center w-28" value={men} onChange={e => setMen(e.target.value)} />
              <span className="text-sm text-gray-500">log</span>
              <span className="text-xs text-gray-400">× ₹</span>
              <input type="number" min="0" className="input text-sm w-24" value={menRate} onChange={e => setMenRate(e.target.value)} title="Per din labour rate" />
              <span className="text-xs text-gray-400">/din = <b className="text-gray-700">₹{costB.toLocaleString('en-IN')}</b> labour cost</span>
            </div>
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-sm text-gray-800 mb-1">4️⃣ 📸 Site Photos</h3>
            <label className="block border-2 border-dashed border-gray-300 rounded-lg p-4 text-center cursor-pointer hover:border-blue-400">
              <input type="file" accept="image/*" multiple capture="environment" className="hidden"
                onChange={e => { uploadPhotos(e.target.files); e.target.value = ''; }} />
              <span className="text-sm text-gray-600">{uploading ? 'Upload ho rahi hai…' : '📷 Photo kheenchо ya chuno (multiple chalega)'}</span>
            </label>
            {photos.length > 0 && (
              <div className="flex gap-2 mt-2 flex-wrap">
                {photos.map((p, i) => (
                  <div key={i} className="relative">
                    <img src={p} alt="" className="w-16 h-16 object-cover rounded border" />
                    <button type="button" onClick={() => setPhotos(prev => prev.filter((_, j) => j !== i))}
                      className="absolute -top-1.5 -right-1.5 bg-red-600 text-white rounded-full w-4 h-4 text-[10px] leading-4">×</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="card p-4">
            <h3 className="font-semibold text-sm text-gray-800 mb-1">⚠ Koi Problem? <span className="text-xs font-normal text-gray-400">(optional — loss ho to zaroori)</span></h3>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select className="select text-sm" value={problemCat} onChange={e => setProblemCat(e.target.value)}>
                <option value="">— category —</option>
                {['Money', 'Machine', 'Material', 'Manpower', 'Site Clearance'].map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <input className="input text-sm sm:col-span-2" placeholder="Kya problem aayi? (e.g. drawing nahi mili, material late)"
                value={problem} onChange={e => setProblem(e.target.value)} />
            </div>
          </div>

          <div className="card p-4 flex flex-wrap items-center justify-between gap-3 sticky bottom-2 shadow-lg border-blue-200">
            <div className="flex items-center gap-1 flex-wrap">
              <div className="text-center px-3">
                <div className={`text-sm font-bold ${livePl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>₹{Math.round(livePl).toLocaleString('en-IN')}</div>
                <div className="text-[10px] text-gray-500">Aaj ka P/L (₹{Math.round(doneA).toLocaleString('en-IN')} − ₹{costB.toLocaleString('en-IN')})</div>
              </div>
              {plChip('Is hafte', pl?.weekly)}
              {plChip('Is mahine', pl?.monthly)}
            </div>
            <button onClick={submit} disabled={busy || uploading}
              className="btn btn-primary text-base font-bold px-6 py-3 w-full sm:w-auto">
              {busy ? 'Ban raha hai…' : '✅ DPR SUBMIT KARO'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// SposComplianceGrid — SPOS Daily Compliance (mam 2026-07-29, SPOS PDF).
// One row per active site, four checks from the SPOS HR checklist:
// morning punch by 09:00 · DPR by evening cutoff · site photos · weekly
// plan approved. Renders above the Engineer Compliance analytics; the
// same data feeds the 18:30 Exception Report email to management.
function SposComplianceGrid() {
  const [date, setDate] = useState(istTodayIso());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.get('/dpr/spos-compliance', { params: { date } })
      .then(r => setData(r.data)).catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [date]);

  const fmtT = (ts) => {
    if (!ts) return '';
    try {
      return new Date(String(ts).replace(' ', 'T') + 'Z')
        .toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  };
  const Chip = ({ tone, children }) => {
    const cls = tone === 'ok' ? 'bg-emerald-50 text-emerald-700 border-emerald-300'
      : tone === 'warn' ? 'bg-amber-50 text-amber-700 border-amber-300'
      : tone === 'bad' ? 'bg-red-50 text-red-700 border-red-300'
      : 'bg-gray-50 text-gray-400 border-gray-200';
    return <span className={`inline-block text-[10px] font-semibold px-1.5 py-0.5 rounded border whitespace-nowrap ${cls}`}>{children}</span>;
  };
  const Pct = ({ v, label }) => (
    <div className="text-center px-3">
      <div className={`text-xl font-bold ${v >= 90 ? 'text-emerald-600' : v >= 50 ? 'text-amber-600' : 'text-red-600'}`}>{v}%</div>
      <div className="text-[10px] text-gray-500 uppercase">{label}</div>
    </div>
  );

  return (
    <div className="card p-4 mb-4 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="font-semibold text-gray-800">SPOS Daily Compliance</h3>
          <p className="text-xs text-gray-500">Per site: morning punch by 9 AM · DPR by evening cutoff · photos · weekly plan approved. Gaps go to management in the 6:30 PM Exception Report.</p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {data && <>
            <Pct v={data.summary.punch_pct} label="Punch" />
            <Pct v={data.summary.dpr_pct} label="DPR" />
            <Pct v={data.summary.photos_pct} label="Photos" />
            <Pct v={data.summary.plan_approved_pct} label="Plan ✓" />
          </>}
          <input type="date" className="input text-xs w-36" value={date} onChange={e => setDate(e.target.value)} />
        </div>
      </div>
      {loading ? <div className="text-sm text-gray-400 py-4 text-center">Loading…</div>
        : !data ? <div className="text-sm text-red-500 py-4 text-center">Could not load compliance data.</div>
        : data.sites.length === 0 ? <div className="text-sm text-gray-400 py-4 text-center">No active sites.</div>
        : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 border-b text-left">
                <th className="py-1.5 pr-2">Site</th>
                <th className="py-1.5 px-2">Engineer</th>
                <th className="py-1.5 px-2">Morning Punch</th>
                <th className="py-1.5 px-2">DPR</th>
                <th className="py-1.5 px-2">Photos</th>
                <th className="py-1.5 pl-2">Week Plan</th>
              </tr>
            </thead>
            <tbody>
              {data.sites.map(r => (
                <tr key={r.site_id} className="border-b hover:bg-gray-50">
                  <td className="py-1.5 pr-2 font-medium">{r.site}</td>
                  <td className="py-1.5 px-2 text-gray-600">{r.engineer || <span className="text-gray-300">—</span>}</td>
                  <td className="py-1.5 px-2">
                    {!r.punch_done ? <Chip tone="bad">✗ missing</Chip>
                      : r.punch_by_9 ? <Chip tone="ok">✓ {fmtT(r.punch_at)}</Chip>
                      : <Chip tone="warn">⚠ after 9 · {fmtT(r.punch_at)}</Chip>}
                  </td>
                  <td className="py-1.5 px-2">
                    {!r.dpr_done ? <Chip tone="bad">✗ missing</Chip>
                      : r.dpr_by_cutoff ? <Chip tone="ok">✓ {fmtT(r.dpr_at)}</Chip>
                      : <Chip tone="warn">⚠ late · {fmtT(r.dpr_at)}</Chip>}
                  </td>
                  <td className="py-1.5 px-2">
                    {r.photos_done ? <Chip tone="ok">✓</Chip>
                      : r.dpr_done ? <Chip tone="bad">✗ none</Chip>
                      : <Chip tone="none">—</Chip>}
                  </td>
                  <td className="py-1.5 pl-2">
                    {r.plan_status === 'approved' ? <Chip tone="ok">✓ approved{r.plan_late ? ' (late)' : ''}</Chip>
                      : r.plan_status === 'submitted' ? <Chip tone="warn">⏳ pending PM</Chip>
                      : r.plan_status === 'rejected' ? <Chip tone="bad">✗ rejected</Chip>
                      : <Chip tone="bad">✗ no plan</Chip>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// LossReasonsTab — management dashboard for DPRs with profit_loss < 0.
// Each row shows the site, date, loss amount, hindrance category + reason
// the engineer filled in, plus a "consecutive loss days" streak. Rows
// with streak >= 3 are highlighted red because they trigger the automatic
// email to director@securedengineers.com.
// Category-to-owner map (mam, 2026-05-16: "if manpower then ruksana,
// material then raj kumar, money then aanchal, machine then ajmer,
// site clearance crm as per site name").  Site Clearance falls back
// to the row's CRM resolved server-side (sites.business_book →
// employee_assigned).  Stored as a constant so future re-assignments
// only need a code change here.
const HINDRANCE_OWNERS = {
  Manpower: 'Ruksana',
  Material: 'Raj Kumar',
  Money: 'Aanchal',
  Machine: 'Ajmer',
};
const ownerFor = (row) => {
  if (row.hindrance_category === 'Site Clearance') {
    return row.site_crm_name || row.supervisor || '—';
  }
  return HINDRANCE_OWNERS[row.hindrance_category] || '—';
};


function LossReasonsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'streak3' | 'pending'
  // Proof-attach modal (mam: "on address click proof so that problem
  // can solve and identify").  null = closed; { row, note, file,
  // uploading } when open.
  const [addressModal, setAddressModal] = useState(null);

  const load = () => {
    setLoading(true);
    api.get('/dpr/loss-dashboard').then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  // Open the proof-attach modal instead of a bare prompt
  const openAddressModal = (row) => setAddressModal({ row, note: '', file: null, uploading: false });

  // Save: optional file → /api/upload → use returned URL as proof_url.
  // PATCH /dpr/:id/loss-addressed with the note + proof_url.
  const submitAddressed = async () => {
    if (!addressModal) return;
    setAddressModal(a => ({ ...a, uploading: true }));
    let proof_url = null;
    if (addressModal.file) {
      try {
        const fd = new FormData();
        fd.append('file', addressModal.file);
        const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        proof_url = r.data?.url || null;
      } catch {
        toast.error('Proof upload failed — submitting without file');
      }
    }
    try {
      await api.patch(`/dpr/${addressModal.row.id}/loss-addressed`, {
        addressed: true,
        note: addressModal.note || null,
        proof_url,
      });
      toast.success('Marked as addressed');
      setAddressModal(null);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
      setAddressModal(a => ({ ...a, uploading: false }));
    }
  };

  // Reverse: unmark (no modal, simple confirm)
  const unmarkAddressed = async (row) => {
    if (!confirm('Re-open this loss row as pending follow-up?')) return;
    try {
      await api.patch(`/dpr/${row.id}/loss-addressed`, { addressed: false });
      toast.success('Re-opened');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const filtered = rows.filter(r => {
    if (filter === 'streak3') return (r.consecutive_loss_days || 0) >= 3;
    if (filter === 'pending') return !r.loss_addressed;
    return true;
  });

  const streak3Count = rows.filter(r => (r.consecutive_loss_days || 0) >= 3 && !r.loss_addressed).length;
  const totalLoss = rows.reduce((s, r) => s + (+r.profit_loss || 0), 0);

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <button onClick={() => setFilter('all')} className={`card text-left ${filter === 'all' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-gray-800">{rows.length}</div>
          <div className="text-xs text-gray-500">All loss DPRs</div>
        </button>
        <button onClick={() => setFilter('streak3')} className={`card text-left ${filter === 'streak3' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-red-700">{streak3Count}</div>
          <div className="text-xs text-gray-500">3+ day streaks · pending — director gets emailed</div>
        </button>
        <button onClick={() => setFilter('pending')} className={`card text-left ${filter === 'pending' ? 'ring-2 ring-red-400' : ''}`}>
          <div className="text-2xl font-bold text-amber-700">{rows.filter(r => !r.loss_addressed).length}</div>
          <div className="text-xs text-gray-500">Pending follow-up</div>
        </button>
      </div>

      <div className="card p-3 text-sm text-gray-600 flex items-center justify-between">
        <div>Total loss across all rows: <span className="font-bold text-red-700">Rs {Math.abs(Math.round(totalLoss)).toLocaleString('en-IN')}</span></div>
        <div className="text-xs">Email alerts go to <span className="font-mono">director@securedengineers.com</span> when a site hits 3 consecutive loss days.</div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table>
          <thead>
            <tr>
              <th>Site</th><th>Date</th><th>Loss (P/L)</th><th>Hindrance</th>
              <th>Assigned To</th>
              <th>Reason filled by engineer</th>
              <th>Streak</th><th>Submitted By</th><th>Followed Up?</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="9" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan="9" className="text-center py-8 text-gray-400">
                {filter === 'all' ? 'No loss DPRs — every site is on track 🎉' : 'Nothing matches this filter.'}
              </td></tr>
            )}
            {filtered.map(r => {
              const owner = ownerFor(r);
              return (
              <tr key={r.id} className={(r.consecutive_loss_days || 0) >= 3 && !r.loss_addressed ? 'bg-red-50/60' : ''}>
                <td className="font-medium">{r.site_name || `Site #${r.site_id}`}</td>
                <td>{r.report_date}</td>
                <td className="font-bold text-red-700">Rs {Math.abs(Math.round(+r.profit_loss || 0)).toLocaleString('en-IN')}</td>
                <td>{r.hindrance_category || <span className="text-gray-400">-</span>}</td>
                {/* Auto-resolved owner per category.  Mam: fixed mapping for
                    Manpower/Material/Money/Machine; Site Clearance =
                    site's CRM. */}
                <td>
                  {owner === '—' ? (
                    <span className="text-gray-400">-</span>
                  ) : (
                    <span className="text-xs font-semibold text-gray-800 bg-amber-100 px-2 py-0.5 rounded">{owner}</span>
                  )}
                </td>
                <td className="max-w-[320px] text-xs text-gray-700 whitespace-normal break-words" title={r.hindrances}>{r.hindrances || <span className="text-gray-400">-</span>}</td>
                <td>
                  {(r.consecutive_loss_days || 0) >= 3
                    ? <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800"><FiAlertTriangle size={10} /> {r.consecutive_loss_days} DAYS</span>
                    : <span className="text-xs text-gray-600">{r.consecutive_loss_days || 1} day{r.consecutive_loss_days > 1 ? 's' : ''}</span>}
                </td>
                <td className="text-xs">{r.submitted_by_name || '-'}</td>
                <td>
                  {r.loss_addressed ? (
                    <div className="space-y-0.5">
                      <button onClick={() => unmarkAddressed(r)} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200" title={r.loss_addressed_note || ''}>
                        <FiCheck size={10} /> Done by {r.addressed_by_name || '-'}
                      </button>
                      {r.loss_addressed_proof_url && (
                        <a href={r.loss_addressed_proof_url} target="_blank" rel="noopener noreferrer"
                           className="block text-[10px] text-blue-600 hover:text-blue-800 underline">
                          View proof
                        </a>
                      )}
                      {r.loss_addressed_note && <div className="text-[10px] text-gray-500 max-w-[180px] truncate" title={r.loss_addressed_note}>{r.loss_addressed_note}</div>}
                    </div>
                  ) : (
                    <button onClick={() => openAddressModal(r)} className="text-xs btn btn-secondary py-0.5 px-2">Mark addressed</button>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Proof-of-resolution modal */}
      {addressModal && (
        <Modal isOpen={true} onClose={() => !addressModal.uploading && setAddressModal(null)} title="Mark loss as addressed">
          <div className="space-y-3 text-sm">
            <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-gray-700">
              <div><strong>Site:</strong> {addressModal.row.site_name}</div>
              <div><strong>Date:</strong> {addressModal.row.report_date}</div>
              <div><strong>Issue:</strong> {addressModal.row.hindrance_category} — {addressModal.row.hindrances}</div>
              <div><strong>Owner:</strong> {ownerFor(addressModal.row)}</div>
            </div>
            <div>
              <label className="label">How was it resolved?</label>
              <textarea className="input" rows="3"
                        value={addressModal.note}
                        onChange={e => setAddressModal(a => ({ ...a, note: e.target.value }))}
                        placeholder="e.g. Extra 4 helpers arranged from Mohali, deployed 17 May 7 AM" />
            </div>
            <div>
              <label className="label">Attach proof (photo / PDF / receipt)</label>
              <input type="file" accept="image/*,application/pdf"
                     onChange={e => setAddressModal(a => ({ ...a, file: e.target.files?.[0] || null }))}
                     className="text-xs" />
              <p className="text-[10px] text-gray-500 mt-1">
                e.g. site photo showing resolution, vendor invoice, delivery challan, signed clearance email — anything that lets management verify the problem is actually solved.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button onClick={() => setAddressModal(null)} disabled={addressModal.uploading} className="btn btn-secondary">Cancel</button>
              <button onClick={submitAddressed} disabled={addressModal.uploading} className="btn btn-primary">
                {addressModal.uploading ? 'Saving…' : 'Mark Addressed'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
