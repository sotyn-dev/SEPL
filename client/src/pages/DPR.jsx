import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiMapPin, FiAlertTriangle, FiCheck, FiEye, FiTrash2 } from 'react-icons/fi';

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
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split('T')[0]);
  const [poItemsForSite, setPoItemsForSite] = useState([]);
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
      api.get(`/dpr/sites/${siteId}/po-items`).then(r => setPoItemsForSite(r.data)).catch(() => setPoItemsForSite([]));
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
    } else { setPoItemsForSite([]); }
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
      <div className="flex gap-2 flex-wrap">
        {['dashboard', 'reports', 'sites'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t === 'dashboard' ? 'Dashboard' : t === 'reports' ? 'Daily Reports' : 'Sites'}
          </button>
        ))}
      </div>

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
              setModal(true);
            }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Submit DPR</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
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
          <div className="card p-0 overflow-x-auto"><table>
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
              <div><label className="label">Contractor Name</label><input className="input" value={form.contractor_name || ''} onChange={e => setForm({ ...form, contractor_name: e.target.value })} /></div>
              <div><label className="label">Contractor Manpower</label><input className="input" type="number" value={form.contractor_manpower || ''} onChange={e => setForm({ ...form, contractor_manpower: +e.target.value })} /></div>
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
            {poItemsForSite.length > 0 ? (
              <>
                <div className="hidden md:grid grid-cols-12 gap-1 text-[10px] font-bold text-gray-600 mb-1 px-1 uppercase">
                  <div className="md:col-span-4">BOQ Item</div><div className="md:col-span-1">Qty</div><div className="md:col-span-2">Location</div><div className="md:col-span-2">Rate (Rs)</div><div className="md:col-span-2">Amount (Rs)</div><div></div>
                </div>
                {workItems.map((w, i) => (
                  <div key={i} className="grid grid-cols-12 gap-1 mb-1.5 items-start bg-white rounded p-1">
                    <div className="col-span-12 md:col-span-4">
                      <SearchableSelect
                        options={poItemsForSite.map(item => ({
                          id: item.id,
                          label: `${item.description} (BOQ:${item.quantity} | Remaining:${item.remaining_qty ?? item.quantity} ${item.unit})${item.remaining_qty <= 0 ? ' — COMPLETED' : ''}`,
                          ...item
                        }))}
                        value={w.po_item_id || null}
                        valueKey="id"
                        displayKey="label"
                        placeholder="-- Select PO Item --"
                        onChange={(item) => selectWorkItem(i, item?.id || '')}
                      />
                    </div>
                    <div className="col-span-3 md:col-span-1">
                      <input className="input text-sm text-center w-full" type="number" placeholder="Qty" max={w.remaining_qty || w.boq_qty || 999999} value={w.qty || ''} onChange={e => {
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
                    <input className="input col-span-3 md:col-span-2 text-sm" placeholder="Loc (GF/1F)" value={w.location || ''} onChange={e => updateWork(i, 'location', e.target.value)} />
                    <input className="input col-span-3 md:col-span-2 text-sm" type="number" placeholder="Rate" value={w.rate || ''} onChange={e => updateWork(i, 'rate', +e.target.value)} />
                    <div className="col-span-2 md:col-span-2 text-sm font-bold text-right pr-2">Rs {(w.amount || 0).toLocaleString()}</div>
                    <button type="button" onClick={() => removeWorkItem(i)} className="col-span-1 p-1 text-red-400 hover:text-red-600 flex justify-center"><FiTrash2 size={13} /></button>
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
              <div><strong>Contractor:</strong> {selectedDpr.contractor_name || '-'}</div>
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
    </div>
  );
}
