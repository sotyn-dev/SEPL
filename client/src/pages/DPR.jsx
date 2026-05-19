import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMapPin, FiAlertTriangle, FiCheck, FiEye, FiTrash2, FiAlertCircle, FiDownload, FiCalendar } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const SYSTEMS = ['Electrical', 'Fire Fighting', 'Fire Alarm', 'CCTV', 'Access Control', 'PA System', 'Plumbing', 'HVAC', 'Solar', 'Networking', 'Combined'];
const EQUIPMENT_LIST = ['Welding Machine', 'Pipe Threading Machine', 'Drill Machine', 'Grinder', 'Ladder', 'Scaffolding', 'Pipe Bending Machine', 'Cable Pulling Machine', 'Multimeter', 'Megger', 'Earth Tester', 'Hydro Test Pump', 'Generator', 'Compressor'];

export default function DPR() {
  const { user, isAdmin, canEdit, canDelete, canApprove } = useAuth();
  const [tab, setTab] = useState('dashboard');
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
    // Default to next Monday so today's plan stays untouched.
    const d = new Date();
    const day = d.getDay();             // 0=Sun, 1=Mon, …, 6=Sat
    const daysUntilMon = day === 0 ? 1 : (8 - day);
    d.setDate(d.getDate() + daysUntilMon);
    return d.toISOString().slice(0, 10);
  });
  const [planDays, setPlanDays] = useState([]); // 7-row array
  const [planSaving, setPlanSaving] = useState(false);
  // BOQ items for the picked site (mam, 2026-05-16: "planning giving
  // as per boq items").  Auto-fetched whenever planSiteId changes
  // so each row's "Planned Work" becomes a dropdown of real PO line
  // items + planned quantity.
  const [planBoqItems, setPlanBoqItems] = useState([]);

  // Rebuild the 7-row scaffold whenever the week-start changes.
  // Pre-loads any existing planned values via the week-view endpoint
  // so re-opening the modal shows what's already saved.
  const openPlanWeek = async (siteId, weekStartIso) => {
    setPlanSiteId(siteId || '');
    setPlanWeekStart(weekStartIso || planWeekStart);
    setPlanModal(true);
    setPlanBoqItems([]);
    // Build 7 day slots
    const slots = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(weekStartIso || planWeekStart);
      d.setDate(d.getDate() + i);
      const date = d.toISOString().slice(0, 10);
      slots.push({ date, planned_description: '', planned_manpower: 0, planned_grand_total_b: 0, planned_po_item_id: '', planned_qty: 0 });
    }
    setPlanDays(slots);
    if (siteId) {
      // Load BOQ items for this site so each row can pick from them.
      // Response is either an array (legacy) or { items, diagnostic }.
      try {
        const r = await api.get(`/dpr/sites/${siteId}/po-items`);
        const items = Array.isArray(r.data) ? r.data : (r.data?.items || []);
        setPlanBoqItems(items);
      } catch { setPlanBoqItems([]); }
      // Pre-fill existing planned values for the week.
      try {
        const r = await api.get('/dpr/week-view', { params: { site_id: siteId, week_start: weekStartIso || planWeekStart } });
        const byDate = Object.fromEntries((r.data?.days || []).map(d => [d.report_date, d]));
        setPlanDays(slots.map(s => {
          const existing = byDate[s.date];
          if (existing && (existing.planned_description || existing.planned_manpower || existing.grand_total_b || existing.planned_po_item_id)) {
            return {
              date: s.date,
              planned_description: existing.planned_description || '',
              planned_manpower: existing.planned_manpower || 0,
              planned_grand_total_b: existing.grand_total_b || 0,
              planned_po_item_id: existing.planned_po_item_id || '',
              planned_qty: existing.planned_qty || 0,
            };
          }
          return s;
        }));
      } catch { /* fall back to empty slots */ }
    }
  };

  const updatePlanDay = (i, patch) => {
    setPlanDays(prev => prev.map((d, idx) => idx === i ? { ...d, ...patch } : d));
  };

  const savePlanWeek = async () => {
    if (!planSiteId) { toast.error('Pick a site first'); return; }
    setPlanSaving(true);
    try {
      const r = await api.post('/dpr/plan-week', { site_id: planSiteId, week_start: planWeekStart, days: planDays });
      toast.success(`Week plan saved · ${r.data.created} created, ${r.data.updated} updated`);
      setPlanModal(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Save failed');
    } finally {
      setPlanSaving(false);
    }
  };
  const [selectedDpr, setSelectedDpr] = useState(null);
  const [form, setForm] = useState({});
  // Table A: Installation items from PO
  const [workItems, setWorkItems] = useState([]);
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
  // Mam: 'AT LEAST OPTION OF 5 CONTRACTOR' — start with 5 blank rows; "+ Add"
  // appends more, "×" removes (only when more than 5). Empty rows are
  // dropped server-side so we never save junk.
  const [contractors, setContractors] = useState(() => Array.from({ length: 5 }, () => ({ name: '', manpower: 0 })));
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const [poItemsForSite, setPoItemsForSite] = useState([]);
  // Server-side diagnostic when po_items can't be fetched (no BB, no
  // items, or rates not set). Surfaced as a yellow banner above the
  // work items grid so mam knows exactly what to fix.
  const [poItemsDiag, setPoItemsDiag] = useState(null);
  const [progress, setProgress] = useState([]);
  const [expandedSite, setExpandedSite] = useState({}); // { "engineerId-siteId": true }

  const load = () => {
    api.get('/dpr/summary').then(r => setSummary(r.data));
    // Stat-card filter on & user hasn't picked a date yet → fetch ALL DPRs
    // so Pending/Billing shows matches across every date by default.
    // Otherwise scope to the date (either user-picked or today's default).
    const params = (reportFilter && !dateTouched) ? {} : { date: filterDate };
    api.get('/dpr', { params }).then(r => setDprs(r.data));
    api.get('/dpr/sites').then(r => setSites(r.data));
    api.get('/auth/users').then(r => setUsers(r.data)).catch(() => {});
    api.get('/dpr/progress').then(r => setProgress(r.data)).catch(() => setProgress([]));
  };
  useEffect(() => { load(); }, [filterDate, reportFilter, dateTouched]);

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
      // Auto-fill Staff Cost rate from the site's PO engineers (salary/30).
      // Backend returns only aggregates + an optional diagnostic — no individual salaries.
      api.get(`/dpr/sites/${siteId}/staff-cost`).then(r => {
        const { per_day_cost = 0, engineer_count = 0, po_engineers = 0, diagnostic = null } = r.data || {};
        setCosts(prev => prev.map(c => c.type === 'Staff Cost'
          // When auto-pull found nothing, unlock the rate so the user can type a value
          ? { ...c, rate: per_day_cost, engineer_count, po_engineers, auto: per_day_cost > 0, diagnostic, amount: (c.qty || 0) * per_day_cost }
          : c));
      }).catch(() => {});
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
    } else { setPoItemsForSite([]); setPoItemsDiag(null); }
  };

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
    // Auto-fill SITC rate from po_items so the site engineer doesn't
    // have to re-type it. Can still be overridden inline.
    if (item) {
      n[i].rate = +item.rate || 0;
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

  const submitDpr = async (e) => {
    e.preventDefault();
    try {
      await api.post('/dpr', {
        ...form,
        work_items: workItems.filter(w => w.po_item_id || w.description),
        manpower: costs.filter(c => c.qty > 0 || c.amount > 0),
        machinery: machinery.filter(m => m.equipment),
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
  const viewDpr = async (id) => { const { data } = await api.get(`/dpr/${id}`); setSelectedDpr(data); setDetailModal(true); };

  if (!summary) return <div className="text-center py-10">Loading...</div>;

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex gap-2 flex-wrap">
          {['dashboard', 'reports', 'sites', 'losses'].map(t => (
            <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
              {t === 'dashboard' ? 'Dashboard' : t === 'reports' ? 'Daily Reports' : t === 'sites' ? 'Sites' : 'Loss Reasons'}
            </button>
          ))}
        </div>
      </div>

      {tab === 'losses' && <LossReasonsTab />}

      {tab === 'dashboard' && (
        <>
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <button type="button" onClick={() => { setReportFilter(''); setTab('sites'); }}
              className="card text-center border-l-4 border-red-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-red-600">{summary.activeSites}</div>
              <div className="text-sm text-gray-500">Active Sites <span className="text-[10px] text-red-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setFilterDate(new Date().toISOString().split('T')[0]); setDateTouched(true); setReportFilter(''); setTab('reports'); }}
              className="card text-center border-l-4 border-emerald-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-emerald-600">{summary.todaySubmissions}</div>
              <div className="text-sm text-gray-500">DPR Today <span className="text-[10px] text-emerald-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('pending'); setTab('reports'); }}
              className="card text-center border-l-4 border-amber-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-amber-600">{summary.pendingApproval}</div>
              <div className="text-sm text-gray-500">Pending Approval <span className="text-[10px] text-amber-600 font-semibold">→ view</span></div>
            </button>
            <button type="button" onClick={() => { setDateTouched(false); setReportFilter('billing'); setTab('reports'); }}
              className="card text-center border-l-4 border-purple-500 text-left hover:shadow-md transition-shadow cursor-pointer">
              <div className="text-3xl font-bold text-purple-600">{summary.billingReady}</div>
              <div className="text-sm text-gray-500">Billing Ready <span className="text-[10px] text-purple-600 font-semibold">→ view</span></div>
            </button>
          </div>
          {summary.missingSites.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-4">
              <div className="flex items-center gap-2 mb-2"><FiAlertTriangle className="text-red-600" size={20} /><h4 className="font-bold text-red-700">NO DPR - Payment Blocked!</h4></div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-2">{summary.missingSites.map(s => (
                <div key={s.id} className="bg-white border border-red-300 rounded-lg p-3 flex items-center gap-2"><FiMapPin className="text-red-500" /><div><div className="font-medium text-sm">{s.name}</div><div className="text-xs text-gray-500">{s.supervisor || 'N/A'}</div></div></div>
              ))}</div>
            </div>
          )}
          {summary.missingSites.length === 0 && summary.activeSites > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4 flex items-center gap-3"><FiCheck className="text-emerald-600" size={24} /><h4 className="font-bold text-emerald-700">All sites submitted DPR today!</h4></div>
          )}

          {/* BOQ vs DPR-consumed progress, grouped by engineer → site → item */}
          <div className="card p-0 overflow-x-auto">
            <div className="bg-gradient-to-r from-red-600 to-red-600 text-white px-4 py-3">
              <h3 className="font-bold text-base">Engineer Progress — BOQ vs DPR Consumed</h3>
              <p className="text-xs text-red-100">Per engineer, per site, per BOQ item. Incomplete items listed first.{!isAdmin() && ' Showing only your sites.'}</p>
            </div>
            <div className="p-3 space-y-3">
              {progress.length === 0 && (
                <div className="text-center py-6 text-gray-400 text-sm">No sites assigned yet</div>
              )}
              {progress.map(eng => {
                const engBoq = eng.sites.reduce((s, x) => s + (x.total_boq_amount || 0), 0);
                const engDone = eng.sites.reduce((s, x) => s + (x.total_done_amount || 0), 0);
                const engPct = engBoq > 0 ? Math.round((engDone / engBoq) * 1000) / 10 : 0;
                const engColor = engPct >= 90 ? 'text-emerald-600' : engPct >= 50 ? 'text-red-600' : engPct >= 20 ? 'text-amber-600' : 'text-red-500';
                const engBar = engPct >= 90 ? 'bg-emerald-500' : engPct >= 50 ? 'bg-red-500' : engPct >= 20 ? 'bg-amber-500' : 'bg-red-400';
                return (
                <div key={eng.engineer.id} className="border rounded-lg overflow-hidden">
                  <div className="bg-gradient-to-r from-red-50 to-red-50 px-3 py-2 border-b flex justify-between items-center gap-3">
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
                      {eng.sites.map(site => {
                        const key = `${eng.engineer.id}-${site.site_id}`;
                        const expanded = !!expandedSite[key];
                        const barColor = site.overall_pct >= 90 ? 'bg-emerald-500' : site.overall_pct >= 50 ? 'bg-red-500' : site.overall_pct >= 20 ? 'bg-amber-500' : 'bg-red-400';
                        return (
                          <div key={site.site_id}>
                            <button
                              type="button"
                              onClick={() => setExpandedSite(s => ({ ...s, [key]: !s[key] }))}
                              className="w-full flex items-center gap-3 px-3 py-2 hover:bg-gray-50 text-left"
                            >
                              <span className="text-gray-400 text-xs">{expanded ? '▼' : '▶'}</span>
                              <div className="flex-1 min-w-0">
                                <div className="font-semibold text-sm truncate">{site.site_name}</div>
                                <div className="text-[11px] text-gray-500 truncate">{site.client_name || ''} · {site.item_count} BOQ items</div>
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
                      })}
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
            <input type="date" className="input w-48" value={filterDate} onChange={e => { setFilterDate(e.target.value); setDateTouched(true); }} />
            <div className="flex gap-2">
              <button onClick={() => exportCsv('dpr-reports',
                ['Site','Date','Shift','Submitted By','Status','Total A','Cost B','P/L','Approval'],
                dprs.map(d => [d.site_name, d.report_date, d.shift, d.submitted_by_name, d.overall_status, d.grand_total_a, d.grand_total_b, d.profit_loss, d.approval_status]))}
                className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
              {/* Weekly planning entry-point (mam, 2026-05-16). Pre-fills
                  default site = the one in the daily form's site_id if
                  picked, else empty.  Default week-start = next Monday
                  so site eng files NEXT week's plan, not the current
                  one in flight. */}
              <button onClick={() => openPlanWeek(form.site_id || '', planWeekStart)}
                className="btn btn-secondary flex items-center gap-2"><FiCalendar /> Plan Week</button>
              <button onClick={() => {
                setForm({ site_id: '', report_date: filterDate, weather: 'clear', overall_status: 'on_track', system_type: '', shift: 'day', contractor_name: '', contractor_manpower: 0, mb_sheet_no: '', safety_toolbox_talk: false, safety_ppe_compliance: false, safety_incidents: '', next_day_plan: '', hindrances: '', hindrance_category: '', remarks: '' });
                setWorkItems([]); setPoItemsForSite([]);
                setCosts([
                  { type: 'Skilled Manpower', qty: 0, rate: 800, amount: 0, fixed: true },
                  { type: 'Helper', qty: 0, rate: 500, amount: 0, fixed: true },
                  { type: 'Rental Cost', qty: 0, rate: 0, amount: 0 },
                  { type: 'Staff Cost', qty: 1, rate: 0, amount: 0, auto: true, engineer_count: 0 },
                  { type: 'TA/DA', qty: 1, rate: 0, amount: 0, auto: true, ta_da_count: 0 },
                ]);
                setMachinery([{ equipment: '', quantity: 1, hours_used: 0, condition: 'working' }]);
                setContractors(Array.from({ length: 5 }, () => ({ name: '', manpower: 0 })));
                setModal(true);
              }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit DPR</button>
            </div>
          </div>
          <div className="card p-0"><table className="freeze-head">
            <thead><tr><th>Site</th><th>Date</th><th>Shift</th><th>By</th><th>Status</th><th>Total(A)</th><th>Cost(B)</th><th>P/L</th><th>Approval</th><th>Actions</th></tr></thead>
            <tbody>
              {dprs
                .filter(d => {
                  if (!reportFilter) return true;
                  if (reportFilter === 'pending') return d.approval_status === 'pending';
                  if (reportFilter === 'billing') return d.billing_ready === 1 || d.billing_ready === true;
                  return true;
                })
                .map(d => (
                <tr key={d.id}>
                  <td className="font-medium">{d.site_name}</td><td>{d.report_date}</td><td className="capitalize text-xs">{d.shift || '-'}</td>
                  <td>{d.submitted_by_name}</td><td><StatusBadge status={d.overall_status} /></td>
                  <td className="font-semibold text-emerald-600 text-sm">Rs {(d.grand_total_a || 0).toLocaleString()}</td>
                  <td className="font-semibold text-red-600 text-sm">Rs {(d.grand_total_b || 0).toLocaleString()}</td>
                  <td className={`font-bold text-sm ${(d.profit_loss || 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>Rs {(d.profit_loss || 0).toLocaleString()}</td>
                  <td><StatusBadge status={d.approval_status} /></td>
                  <td><div className="flex gap-1">
                    <button onClick={() => viewDpr(d.id)} className="p-1 hover:bg-red-50 rounded text-red-600"><FiEye size={14} /></button>
                    {d.approval_status === 'pending' && canApprove('dpr') && <>
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
              ))}
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
                      <input className="input col-span-7" placeholder={`Contractor ${i + 1} name`}
                        value={c.name}
                        onChange={e => { const n = [...contractors]; n[i] = { ...n[i], name: e.target.value }; setContractors(n); }} />
                      <input className="input col-span-4" type="number" placeholder="Manpower"
                        value={c.manpower || ''}
                        onChange={e => { const n = [...contractors]; n[i] = { ...n[i], manpower: +e.target.value || 0 }; setContractors(n); }} />
                      {contractors.length > 5 ? (
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
              <div><label className="label">MEPF System</label>
                <select className="select" value={form.system_type || ''} onChange={e => setForm({ ...form, system_type: e.target.value })}>
                  <option value="">Select</option>{SYSTEMS.map(s => <option key={s}>{s}</option>)}
                </select>
              </div>
              <div><label className="label">Weather</label>
                <select className="select" value={form.weather || 'clear'} onChange={e => setForm({ ...form, weather: e.target.value })}>
                  <option value="clear">Clear</option><option value="rainy">Rainy</option><option value="cloudy">Cloudy</option><option value="hot">Hot</option><option value="windy">Windy</option>
                </select>
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
                    <p className={`text-[10px] pl-1 mt-1 ${c.diagnostic ? 'text-amber-700' : 'text-gray-500'}`}>
                      {!form.site_id
                        ? 'Select a site first — Staff Cost auto-fills from that PO’s site engineers.'
                        : c.engineer_count > 0
                          ? `Auto: ${c.engineer_count} staff × Rs ${c.rate}/day (individual salaries not shown)`
                          : c.diagnostic
                            ? c.diagnostic.message
                            : c.po_engineers > 0
                              ? `${c.po_engineers} site engineer${c.po_engineers > 1 ? 's' : ''} are on this PO but none have a matching employee salary record. Type the rate manually, or ask HR to add your salary.`
                              : 'No site engineers / submitter salary found. Type the rate manually below, or ask HR to add your salary.'}
                    </p>
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
            <div><label className="label">Supervisor</label><input className="input" value={form.supervisor || ''} onChange={e => setForm({ ...form, supervisor: e.target.value })} /></div>
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
                  <tbody>{selectedDpr.work_items.map(w => (<tr key={w.id}><td>{w.description}</td><td className="font-bold">{w.actual_qty || w.planned_qty}</td><td>{w.floor_zone || '-'}</td><td>Rs {(w.rate || 0).toLocaleString()}</td><td className="font-bold text-emerald-600">Rs {(w.amount || 0).toLocaleString()}</td></tr>))}</tbody>
                </table>
                <div className="text-right font-bold text-red-800 mt-2">Grand Total (A): Rs {selectedDpr.work_items.reduce((s, w) => s + (w.amount || 0), 0).toLocaleString()}</div>
              </div>
            )}

            {selectedDpr.manpower?.length > 0 && (
              <div className="border-2 border-red-300 rounded-lg p-3">
                <h5 className="font-bold text-red-800 mb-2">TABLE B: Costs</h5>
                <table className="text-xs"><thead><tr><th>Type</th><th>Qty</th><th>Rate</th><th>Amount</th></tr></thead>
                  <tbody>{selectedDpr.manpower.map(m => (<tr key={m.id}><td>{m.trade}</td><td>{m.required}</td><td>Rs {(m.deployed || 0).toLocaleString()}</td><td className="font-bold text-red-600">Rs {(m.shortage || 0).toLocaleString()}</td></tr>))}</tbody>
                </table>
                <div className="text-right font-bold text-red-800 mt-2">Grand Total (B): Rs {selectedDpr.manpower.reduce((s, m) => s + (m.shortage || 0), 0).toLocaleString()}</div>
              </div>
            )}

            <div className={`border-2 rounded-lg p-3 text-center ${(selectedDpr.profit_loss || 0) >= 0 ? 'border-emerald-400 bg-emerald-50' : 'border-red-400 bg-red-50'}`}>
              <span className={`text-xl font-bold ${(selectedDpr.profit_loss || 0) >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                {(selectedDpr.profit_loss || 0) >= 0 ? 'PROFIT' : 'LOSS'}: Rs {Math.abs(selectedDpr.profit_loss || 0).toLocaleString()}
              </span>
            </div>

            {selectedDpr.machinery?.length > 0 && (
              <div><h5 className="font-semibold text-sm mb-2">Machinery/Tools</h5><table className="text-xs"><thead><tr><th>Equipment</th><th>Qty</th><th>Hours</th><th>Condition</th></tr></thead>
                <tbody>{selectedDpr.machinery.map(m => (<tr key={m.id}><td>{m.equipment}</td><td>{m.quantity}</td><td>{m.hours_used}h</td><td>{m.condition}</td></tr>))}</tbody></table></div>
            )}
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
      <Modal isOpen={planModal} onClose={() => setPlanModal(false)} title="Plan This Week — 7-Day DPR Plan" wide>
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
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

          <div className="overflow-x-auto">
            <table className="w-full text-xs border">
              <thead className="bg-gray-100">
                <tr>
                  <th className="px-2 py-1.5 text-left">#</th>
                  <th className="px-2 py-1.5 text-left">Day</th>
                  <th className="px-2 py-1.5 text-left">Date</th>
                  <th className="px-2 py-1.5 text-left">BOQ Item</th>
                  <th className="px-2 py-1.5 text-right w-24">Planned Qty</th>
                  <th className="px-2 py-1.5 text-right w-24">Manpower</th>
                  <th className="px-2 py-1.5 text-right w-32">Cost (₹)</th>
                </tr>
              </thead>
              <tbody>
                {planDays.map((d, i) => {
                  const dayName = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][new Date(d.date).getDay()];
                  const isSunday = dayName === 'Sun';
                  // Find picked BOQ item for unit display + remaining-qty warning
                  const item = planBoqItems.find(it => +it.id === +d.planned_po_item_id);
                  const remaining = item ? Math.max(0, (+item.quantity || 0) - (+item.executed_quantity || 0)) : null;
                  const exceedsRemaining = item && +d.planned_qty > remaining;
                  return (
                    <tr key={d.date} className={`border-t ${isSunday ? 'bg-gray-50 text-gray-500' : ''}`}>
                      <td className="px-2 py-1.5">{i + 1}</td>
                      <td className="px-2 py-1.5 font-semibold">{dayName}{isSunday ? ' · off' : ''}</td>
                      <td className="px-2 py-1.5 font-mono text-[11px]">{d.date}</td>
                      <td className="px-2 py-1.5">
                        {planBoqItems.length > 0 ? (
                          <select className="select text-xs w-full"
                                  value={d.planned_po_item_id || ''}
                                  onChange={e => updatePlanDay(i, { planned_po_item_id: e.target.value, planned_description: '' })}>
                            <option value="">— Pick BOQ item or skip —</option>
                            {planBoqItems.map(it => (
                              <option key={it.id} value={it.id}>
                                {it.item_name}{it.specification ? ` · ${it.specification}` : ''}{it.unit ? ` (${it.unit})` : ''}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input className="input text-xs w-full" value={d.planned_description}
                                 onChange={e => updatePlanDay(i, { planned_description: e.target.value })}
                                 placeholder={isSunday ? 'Weekly off (or planned OT)' : 'e.g. Conduit laying floor 3'} />
                        )}
                        {item && (
                          <div className="text-[10px] text-gray-500 mt-0.5">
                            BOQ qty: {item.quantity} {item.unit} · already planned/done: {item.executed_quantity || 0}{remaining !== null && <> · remaining: <strong className={remaining < 0 ? 'text-red-600' : ''}>{remaining}</strong></>}
                          </div>
                        )}
                        {exceedsRemaining && (
                          <div className="text-[10px] text-red-600 font-semibold mt-0.5">
                            ⚠ planned qty exceeds BOQ remaining
                          </div>
                        )}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input type="number" min="0" step="0.01" className="input text-xs text-right w-full"
                               value={d.planned_qty || ''}
                               onChange={e => updatePlanDay(i, { planned_qty: +e.target.value })}
                               disabled={!d.planned_po_item_id} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input type="number" min="0" className="input text-xs text-right w-full"
                               value={d.planned_manpower}
                               onChange={e => updatePlanDay(i, { planned_manpower: +e.target.value })} />
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <input type="number" min="0" step="100" className="input text-xs text-right w-full"
                               value={d.planned_grand_total_b}
                               onChange={e => updatePlanDay(i, { planned_grand_total_b: +e.target.value })} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot className="bg-gray-50 font-semibold">
                <tr>
                  <td colSpan="5" className="px-2 py-2 text-right">Week Totals →</td>
                  <td className="px-2 py-2 text-right">{planDays.reduce((s, d) => s + (+d.planned_manpower || 0), 0)} men-days</td>
                  <td className="px-2 py-2 text-right">Rs {planDays.reduce((s, d) => s + (+d.planned_grand_total_b || 0), 0).toLocaleString('en-IN')}</td>
                </tr>
              </tfoot>
            </table>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button onClick={() => setPlanModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={savePlanWeek} disabled={planSaving || !planSiteId} className="btn btn-primary">
              {planSaving ? 'Saving…' : 'Save Week Plan'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}

// LossReasonsTab — management dashboard for DPRs with profit_loss < 0.
// Each row shows the site, date, loss amount, hindrance category + reason
// the engineer filled in, plus a "consecutive loss days" streak. Rows
// with streak >= 3 are highlighted red because they trigger the automatic
// email to director@securedengineers.com.
function LossReasonsTab() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('all'); // 'all' | 'streak3' | 'pending'

  const load = () => {
    setLoading(true);
    api.get('/dpr/loss-dashboard').then(r => setRows(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load'))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  const toggleAddressed = async (row, addressed) => {
    let note = '';
    if (addressed) {
      note = prompt('Add a note about how this was followed up (optional)') || '';
    }
    try {
      await api.patch(`/dpr/${row.id}/loss-addressed`, { addressed, note });
      toast.success(addressed ? 'Marked as addressed' : 'Unmarked');
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
              <th>Site</th><th>Date</th><th>Loss (P/L)</th><th>Hindrance</th><th>Reason filled by engineer</th>
              <th>Streak</th><th>Submitted By</th><th>Followed Up?</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="8" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && filtered.length === 0 && (
              <tr><td colSpan="8" className="text-center py-8 text-gray-400">
                {filter === 'all' ? 'No loss DPRs — every site is on track 🎉' : 'Nothing matches this filter.'}
              </td></tr>
            )}
            {filtered.map(r => (
              <tr key={r.id} className={(r.consecutive_loss_days || 0) >= 3 && !r.loss_addressed ? 'bg-red-50/60' : ''}>
                <td className="font-medium">{r.site_name || `Site #${r.site_id}`}</td>
                <td>{r.report_date}</td>
                <td className="font-bold text-red-700">Rs {Math.abs(Math.round(+r.profit_loss || 0)).toLocaleString('en-IN')}</td>
                <td>{r.hindrance_category || <span className="text-gray-400">-</span>}</td>
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
                      <button onClick={() => toggleAddressed(r, false)} className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 hover:bg-emerald-200" title={r.loss_addressed_note || ''}>
                        <FiCheck size={10} /> Done by {r.addressed_by_name || '-'}
                      </button>
                      {r.loss_addressed_note && <div className="text-[10px] text-gray-500 max-w-[180px] truncate" title={r.loss_addressed_note}>{r.loss_addressed_note}</div>}
                    </div>
                  ) : (
                    <button onClick={() => toggleAddressed(r, true)} className="text-xs btn btn-secondary py-0.5 px-2">Mark addressed</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
