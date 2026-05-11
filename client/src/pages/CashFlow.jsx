import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { FiPlus, FiTrendingUp, FiTrendingDown, FiCalendar, FiTrash2, FiSearch, FiEdit2, FiCheck, FiX } from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';
import { useAuth } from '../context/AuthContext';

export default function CashFlow() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState('projects');
  const [projects, setProjects] = useState([]);
  const [summary, setSummary] = useState(null);
  const [dailySummary, setDailySummary] = useState(null);
  const [entries, setEntries] = useState([]);
  const [selectedDate, setSelectedDate] = useState(new Date().toISOString().split('T')[0]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ date: '', type: 'inflow', category: '', description: '', amount: 0, payment_mode: '', party_name: '' });
  const [search, setSearch] = useState('');
  const [crmFilter, setCrmFilter] = useState('');
  // Last-payment-date filter — buckets projects by how stale their last
  // received payment is. Useful for chasing collections (90+ days = call
  // first). 'never' = no payment ever received (no Inv Days, no Total Days).
  const [pmtAgeFilter, setPmtAgeFilter] = useState('');
  // Date-range filter on Last Payment Date — mam: 'filter from to date as
  // per last payment date'. Both buckets above and date-range below can
  // coexist (AND filter); empty = no constraint.
  const [pmtFromDate, setPmtFromDate] = useState('');
  const [pmtToDate, setPmtToDate] = useState('');
  const [editRow, setEditRow] = useState(null);
  const [editForm, setEditForm] = useState({});

  const load = () => {
    api.get('/cashflow/projects').then(r => { setProjects(r.data.projects); setSummary(r.data.summary); }).catch(() => {});
    api.get('/cashflow/summary', { params: { date: selectedDate } }).then(r => setDailySummary(r.data)).catch(() => {});
    api.get(`/cashflow/entries/${selectedDate}`).then(r => setEntries(r.data)).catch(() => {});
  };
  useEffect(() => { load(); }, [selectedDate]);

  const saveEntry = async (e) => {
    e.preventDefault();
    await api.post('/cashflow/entry', { ...form, date: form.date || selectedDate });
    toast.success('Entry added'); setModal(false); load();
  };

  const deleteEntry = async (id) => {
    if (!confirm('Delete?')) return;
    await api.delete(`/cashflow/entry/${id}`); toast.success('Deleted'); load();
  };

  const inflowCategories = ['Collection', 'Advance Received', 'Milestone Payment', 'Handover Payment', 'Delivery Payment', 'Refund', 'Other Income'];
  const outflowCategories = ['Indent Payment', 'Vendor Payment', 'Salary', 'Rent', 'Transport', 'TA/DA', 'Labour', 'Office Expense', 'Tax', 'EMI', 'Other'];
  const fmt = (n) => `Rs ${(n || 0).toLocaleString('en-IN')}`;

  // Strip CSV-import quote artifacts ("""M/s X""") and trailing
  // whitespace from project names so the tracker reads clean.
  const cleanName = (s) => (s || '').replace(/^[\s"'`]+|[\s"'`]+$/g, '').replace(/\s+/g, ' ').trim();
  // Compact date: '2026-05-05' → '5 May'
  const fmtDate = (iso) => {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    return `${d.getDate()} ${months[d.getMonth()]}`;
  };
  // Soft dash for empty cells
  const dash = <span className="text-gray-300">—</span>;
  // Mam wants amounts shown in full Indian-format rupees (e.g. 40,00,000)
  // not the compact "40.00L" lakh form. Keeping fmtL as an alias of fmt
  // so existing call sites work without churn — every amount renders the
  // same way: comma-separated full number.
  const fmtL = (n) => fmt(n);

  // Compute days-since-last-payment for a project — same logic as the
  // 'Last Pmt Date' column. Returns null if no Inv Days and no Total Days.
  const daysSinceLastPmt = (p) => {
    const live = p.live_date ? new Date(p.live_date) : null;
    if (!live || isNaN(live)) return null;
    const days = +p.payment_investment_days > 0
      ? +p.payment_investment_days
      : (+p.total_days > 0 ? +p.total_days : null);
    return days;
  };

  // The actual Last Payment Date as YYYY-MM-DD (or null), reusing the
  // same calc shown in the 'Last Pmt Date' column. Used by the From/To
  // filter so what mam sees in the column matches what the filter uses.
  const lastPmtDateIso = (p) => {
    const live = p.live_date ? new Date(p.live_date) : null;
    if (!live || isNaN(live)) return null;
    const d = daysSinceLastPmt(p);
    if (!d) return null;
    return new Date(live.getTime() - d * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  };

  const filtered = projects.filter(p => {
    if (crmFilter && !(p.crm_person || '').toLowerCase().includes(crmFilter.toLowerCase())) return false;
    if (search && !(p.project_name || '').toLowerCase().includes(search.toLowerCase()) && !(p.crm_person || '').toLowerCase().includes(search.toLowerCase())) return false;
    if (pmtAgeFilter) {
      const d = daysSinceLastPmt(p);
      if (pmtAgeFilter === 'never' && d !== null) return false;
      if (pmtAgeFilter === 'recent' && (d === null || d > 30)) return false;
      if (pmtAgeFilter === '30-60' && (d === null || d <= 30 || d > 60)) return false;
      if (pmtAgeFilter === '60-90' && (d === null || d <= 60 || d > 90)) return false;
      if (pmtAgeFilter === '90plus' && (d === null || d <= 90)) return false;
    }
    // Date-range filter: keep only rows whose computed Last Payment Date
    // falls inside [pmtFromDate, pmtToDate]. Either bound is optional.
    if (pmtFromDate || pmtToDate) {
      const lpd = lastPmtDateIso(p);
      if (!lpd) return false;
      if (pmtFromDate && lpd < pmtFromDate) return false;
      if (pmtToDate && lpd > pmtToDate) return false;
    }
    return true;
  });

  const saveManualFields = async (projectId) => {
    try {
      await api.post(`/cashflow/projects/${projectId}/update`, editForm);
      toast.success('Updated'); setEditRow(null); load();
    } catch { toast.error('Failed'); }
  };

  // Get unique CRM persons
  const crmPersons = [...new Set(projects.map(p => p.crm_person).filter(Boolean))];

  return (
    <div className="space-y-4">
      <div className="flex gap-2 flex-wrap">
        <button onClick={() => setTab('projects')} className={`btn ${tab === 'projects' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Project Finance</button>
        <button onClick={() => setTab('daily')} className={`btn ${tab === 'daily' ? 'btn-primary' : 'btn-secondary'} text-sm`}>Daily Cash Flow</button>
      </div>

      {tab === 'projects' && (
        <>
          {summary && (
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Projects</p><p className="text-2xl font-bold">{summary.projectCount}</p></div>
              <div className="card p-3 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Total Sale Value</p><p className="text-xl font-bold text-emerald-600">{fmtL(summary.totalSale)}</p></div>
              <div className="card p-3 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Total Received</p><p className="text-xl font-bold text-amber-600">{fmtL(summary.totalReceived)}</p></div>
              {/* Total Value = sum of Aanchal Values across all projects.
                  Comes from the backend already pre-multiplied to rupees. */}
              <div className="card p-3 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Total Value</p><p className="text-xl font-bold text-blue-600">{fmtL(summary.totalValue)}</p></div>
              <div className="card p-3 border-l-4 border-red-500"><p className="text-xs text-gray-500">Total Purchase</p><p className="text-xl font-bold text-red-600">{fmtL(summary.totalPurchase)}</p></div>
            </div>
          )}
          {/* CRM Filter — admin only. Non-admin CRM users see just their own projects (backend-scoped). */}
          {isAdmin() && (
            <div className="flex gap-2 flex-wrap items-center">
              <button onClick={() => setCrmFilter('')} className={`btn ${!crmFilter ? 'btn-primary' : 'btn-secondary'} text-xs`}>All ({projects.length})</button>
              {crmPersons.map(c => (
                <button key={c} onClick={() => setCrmFilter(c)} className={`btn ${crmFilter === c ? 'btn-primary' : 'btn-secondary'} text-xs`}>{c} ({projects.filter(p => (p.crm_person || '').toLowerCase() === c.toLowerCase()).length})</button>
              ))}
            </div>
          )}
          {/* Search + Last-Payment-Date filters row */}
          <div className="flex flex-wrap gap-3 items-end">
            <div className="relative flex-1 min-w-[260px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" placeholder="Search project..." value={search} onChange={e => setSearch(e.target.value)} />
            </div>
            <div className="flex items-center gap-2">
              <div>
                <label className="text-[10px] text-gray-500 uppercase block mb-0.5">Bucket</label>
                <select className="select text-sm" value={pmtAgeFilter} onChange={e => setPmtAgeFilter(e.target.value)}>
                  <option value="">All</option>
                  <option value="recent">≤ 30 days</option>
                  <option value="30-60">31–60 days</option>
                  <option value="60-90">61–90 days</option>
                  <option value="90plus">90+ days (overdue)</option>
                  <option value="never">Never received</option>
                </select>
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase block mb-0.5">From</label>
                <input type="date" className="input text-sm" value={pmtFromDate} onChange={e => setPmtFromDate(e.target.value)} title="Last Payment Date — from" />
              </div>
              <div>
                <label className="text-[10px] text-gray-500 uppercase block mb-0.5">To</label>
                <input type="date" className="input text-sm" value={pmtToDate} onChange={e => setPmtToDate(e.target.value)} title="Last Payment Date — to" />
              </div>
              {(pmtAgeFilter || pmtFromDate || pmtToDate) && (
                <button
                  onClick={() => { setPmtAgeFilter(''); setPmtFromDate(''); setPmtToDate(''); }}
                  className="text-[11px] text-gray-500 hover:text-red-600 underline self-end mb-1"
                  title="Clear all Last-Payment filters"
                >clear</button>
              )}
            </div>
          </div>
          <div className="card p-0 overflow-hidden">
            <div className="p-3 border-b bg-gradient-to-r from-red-50 to-amber-50 flex items-center justify-between">
              <div>
                <h4 className="font-bold text-red-800">All New Projects · Financial Tracker</h4>
                <p className="text-[11px] text-gray-500 mt-0.5">Click any row's pencil to edit · totals auto-update at bottom</p>
              </div>
              <div className="text-[11px] text-gray-500">{filtered.length} projects</div>
            </div>
            <div className="overflow-x-auto"><table className="min-w-[1200px] text-xs cf-tracker-table">
              <thead>
                <tr className="bg-gray-100 text-[10px] uppercase text-gray-600">
                  <th className="px-2 py-2 sticky left-0 bg-gray-100 z-10">Sr</th>
                  <th className="px-2 py-2 text-left sticky left-10 bg-gray-100 z-10 min-w-[200px]">Project</th>
                  <th className="px-2 py-2 text-left">CRM</th>
                  <th className="px-2 py-2 text-right" title="Sale value of the project (PO amount, ex-GST)">Sale ₹</th>
                  <th className="px-2 py-2 text-right" title="Amount actually received from client so far">Received ₹</th>
                  <th className="px-2 py-2 text-center" title="Current milestone — handover / delivery / etc.">Milestone</th>
                  <th className="px-2 py-2 text-right" title="Aanchal value (manual ₹ in lakhs × 1,00,000)">Aanchal ₹</th>
                  <th className="px-2 py-2 text-right" title="Total purchase / cost spent on this project">Purchase ₹</th>
                  <th className="px-2 py-2 text-right" title="Cash velocity = received ÷ purchase. ≥1 means we're cash-positive">Velocity</th>
                  <th className="px-2 py-2 text-center" title="Project go-live date">Live</th>
                  <th className="px-2 py-2 text-right" title="Payment-investment days (manual)">Inv Days</th>
                  <th className="px-2 py-2 text-right" title="Completion days (manual override available)">Compl.</th>
                  <th className="px-2 py-2 text-right" title="Payment days (manual)">Pmt</th>
                  <th className="px-2 py-2 text-right font-bold" title="Total = Completion + Payment">Total</th>
                  <th className="px-2 py-2 text-center" title="Last payment received date — auto-calculated as Live - Inv Days. Updates the moment you save Inv Days / Completion / Payment days.">Last Pmt Date</th>
                  <th className="px-2 py-2 text-center w-16"></th>
                </tr>
              </thead>
              <tbody>{filtered.map(p => {
                const editing = editRow === p.id;
                return (
                <tr key={p.id} className={`border-b transition-colors ${editing ? 'bg-amber-50' : 'bg-white hover:bg-red-50/40'}`}>
                  <td className={`px-2 py-2 font-bold text-gray-400 sticky left-0 ${editing ? 'bg-amber-50' : 'bg-white'}`}>{p.sr_no}</td>
                  <td className={`px-2 py-2 font-semibold text-red-700 sticky left-10 max-w-[260px] ${editing ? 'bg-amber-50' : 'bg-white'}`} title={`${cleanName(p.project_name)}${p.bb_entry_count > 1 ? ` — sum of ${p.bb_entry_count} Business Book entries` : ''}`}>
                    <div className="truncate">{cleanName(p.project_name)}</div>
                    {p.bb_entry_count > 1 && (
                      <span className="text-[9px] font-normal text-gray-400 normal-case">{p.bb_entry_count} BB entries summed</span>
                    )}
                  </td>
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-24" value={editForm.crm_person||''} onChange={e=>setEditForm({...editForm,crm_person:e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2">{p.crm_person ? (
                      <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium ${(p.crm_person).toLowerCase().includes('sushila') ? 'bg-gray-800 text-white' : (p.crm_person).toLowerCase().includes('lovely') ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-700'}`}>{p.crm_person}</span>
                    ) : dash}</td>
                  )}
                  <td className="px-2 py-2 text-right font-semibold text-red-600 tabular-nums">{p.sale_amount > 0 ? fmtL(p.sale_amount) : dash}</td>
                  {editing ? (<>
                    <td className="px-1 py-1"><input className="input text-xs w-24" type="number" value={editForm.amount_received||''} onChange={e=>setEditForm({...editForm,amount_received:+e.target.value})} /></td>
                    <td className="px-1 py-1"><select className="input text-xs w-24" value={editForm.milestone_name||''} onChange={e=>setEditForm({...editForm,milestone_name:e.target.value})}><option value="">—</option><option>milestone</option><option>handover</option><option>delivery</option></select></td>
                    <td className="px-1 py-1"><input className="input text-xs w-20" type="number" step="0.01" value={editForm.aanchal_value||''} onChange={e=>setEditForm({...editForm,aanchal_value:+e.target.value})} placeholder="lakhs" /></td>
                  </>) : (<>
                    <td className="px-2 py-2 text-right font-medium text-emerald-700 tabular-nums">{p.amount_received > 0 ? fmt(p.amount_received) : dash}</td>
                    <td className="px-2 py-2 text-center">{p.milestone_name ? (
                      <span className="text-[10px] bg-blue-100 text-blue-700 px-1.5 py-0.5 rounded font-medium">{p.milestone_name}</span>
                    ) : dash}</td>
                    <td className="px-2 py-2 text-right font-semibold tabular-nums">{p.aanchal_value > 0 ? fmt(p.aanchal_value * 100000) : dash}</td>
                  </>)}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-24" type="number" value={editForm.manual_purchase_value||''} onChange={e=>setEditForm({...editForm,manual_purchase_value:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right font-semibold text-red-600 tabular-nums">{p.purchase_value > 0 ? fmtL(p.purchase_value) : dash}</td>
                  )}
                  <td className={`px-2 py-2 text-right font-bold tabular-nums ${p.cash_velocity >= 1 ? 'text-emerald-600' : p.cash_velocity > 0 ? 'text-amber-600' : 'text-gray-300'}`}>
                    {p.cash_velocity > 0 ? (
                      <span className="inline-flex items-center gap-1">
                        <span className={`w-1.5 h-1.5 rounded-full ${p.cash_velocity >= 1 ? 'bg-emerald-500' : 'bg-amber-500'}`}></span>
                        {p.cash_velocity.toFixed(2)}
                      </span>
                    ) : dash}
                  </td>
                  <td className="px-2 py-2 text-center text-[10px] text-gray-500 whitespace-nowrap" title={p.live_date}>{fmtDate(p.live_date)}</td>
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.payment_investment_days||''} onChange={e=>setEditForm({...editForm,payment_investment_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.payment_investment_days || dash}</td>
                  )}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.manual_completion_days||''} onChange={e=>setEditForm({...editForm,manual_completion_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.completion_days || dash}</td>
                  )}
                  {editing ? (
                    <td className="px-1 py-1"><input className="input text-xs w-14" type="number" value={editForm.payment_days||''} onChange={e=>setEditForm({...editForm,payment_days:+e.target.value})} /></td>
                  ) : (
                    <td className="px-2 py-2 text-right tabular-nums">{p.payment_days || dash}</td>
                  )}
                  <td className="px-2 py-2 text-right font-bold text-base text-gray-800 tabular-nums">{p.total_days || dash}</td>
                  {/* Last Payment Received Date — auto-calculated. Mam:
                      'in here last payment rec date calculate when I update
                      inv days, complete date, payment days'.
                      Formula: LIVE date − Inv Days. If Inv Days isn't set,
                      falls back to LIVE − Total Days (completion + payment).
                      Read-only — refreshes automatically on every save. */}
                  <td className="px-2 py-2 text-center text-[11px] text-blue-700 font-semibold whitespace-nowrap">
                    {(() => {
                      const live = p.live_date ? new Date(p.live_date) : null;
                      if (!live || isNaN(live)) return dash;
                      const daysToBack = +p.payment_investment_days > 0
                        ? +p.payment_investment_days
                        : (+p.total_days > 0 ? +p.total_days : 0);
                      if (!daysToBack) return dash;
                      const lastPaid = new Date(live.getTime() - daysToBack * 24 * 60 * 60 * 1000);
                      return fmtDate(lastPaid.toISOString().slice(0, 10));
                    })()}
                  </td>
                  <td className="px-1 py-1 text-center">{editing ? (
                    <div className="flex gap-1 justify-center">
                      <button onClick={()=>saveManualFields(p.id)} className="p-1.5 bg-emerald-100 text-emerald-700 hover:bg-emerald-200 rounded" title="Save"><FiCheck size={14} /></button>
                      <button onClick={()=>setEditRow(null)} className="p-1.5 bg-gray-100 text-gray-500 hover:bg-gray-200 rounded" title="Cancel"><FiX size={14} /></button>
                    </div>
                  ) : (
                    <button onClick={()=>{setEditRow(p.id);setEditForm({crm_person:p.crm_person,amount_received:p.amount_received,milestone_name:p.milestone_name,aanchal_value:p.aanchal_value,payment_investment_days:p.payment_investment_days,payment_days:p.payment_days,manual_purchase_value:p.purchase_value,manual_completion_days:p.completion_days});}}
                            className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Edit row"><FiEdit2 size={13} /></button>
                  )}</td>
                </tr>
              );})}</tbody>
              <tfoot><tr className="bg-gray-100 font-bold text-xs border-t-2 border-gray-300">
                <td className="px-2 py-3 sticky left-0 bg-gray-100" colSpan="3">TOTAL · {filtered.length} project{filtered.length !== 1 ? 's' : ''}</td>
                <td className="px-2 py-3 text-right text-red-700 tabular-nums">{fmtL(filtered.reduce((s, p) => s + p.sale_amount, 0))}</td>
                <td className="px-2 py-3 text-right text-emerald-700 tabular-nums">{fmt(filtered.reduce((s, p) => s + p.amount_received, 0))}</td>
                <td></td>
                <td className="px-2 py-3 text-right tabular-nums">{fmt(filtered.reduce((s, p) => s + p.aanchal_value, 0) * 100000)}</td>
                <td className="px-2 py-3 text-right text-red-700 tabular-nums">{fmtL(filtered.reduce((s, p) => s + p.purchase_value, 0))}</td>
                <td colSpan="8"></td>
              </tr></tfoot>
            </table></div>
          </div>
        </>
      )}

      {tab === 'daily' && dailySummary && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="card p-3"><LuIndianRupee className="text-red-600 inline mr-1" /><span className="text-xs text-gray-500">Opening</span><p className="text-lg font-bold">{fmt(dailySummary.today.opening_balance)}</p></div>
            <div className="card p-3"><FiTrendingUp className="text-emerald-600 inline mr-1" /><span className="text-xs text-gray-500">Inflows</span><p className="text-lg font-bold text-emerald-600">+{fmt(dailySummary.today.total_inflows)}</p></div>
            <div className="card p-3"><FiTrendingDown className="text-red-600 inline mr-1" /><span className="text-xs text-gray-500">Outflows</span><p className="text-lg font-bold text-red-600">-{fmt(dailySummary.today.total_outflows)}</p></div>
            <div className="card p-3"><LuIndianRupee className="text-purple-600 inline mr-1" /><span className="text-xs text-gray-500">Closing</span><p className="text-lg font-bold text-purple-600">{fmt(dailySummary.today.closing_balance)}</p></div>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2"><FiCalendar className="text-gray-400" /><input type="date" className="input w-48" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} /></div>
            <button onClick={() => { setForm({ date: selectedDate, type: 'inflow', category: '', description: '', amount: 0, payment_mode: '', party_name: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus /> Add Entry</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table className="text-sm"><thead><tr><th>Date</th><th>Opening</th><th className="text-emerald-600">Inflows</th><th className="text-red-600">Outflows</th><th className="text-purple-600">Closing</th></tr></thead>
            <tbody>{dailySummary.last7Days.map(d => (
              <tr key={d.id} className={d.date === selectedDate ? 'bg-red-50' : ''} onClick={() => setSelectedDate(d.date)} style={{ cursor: 'pointer' }}>
                <td className="font-medium">{d.date}</td><td>{fmt(d.opening_balance)}</td>
                <td className="text-emerald-600 font-semibold">+{fmt(d.total_inflows)}</td><td className="text-red-600 font-semibold">-{fmt(d.total_outflows)}</td>
                <td className="font-bold text-purple-600">{fmt(d.closing_balance)}</td>
              </tr>
            ))}</tbody>
          </table></div>
          <div className="card p-0 overflow-x-auto"><div className="p-3 border-b"><h4 className="font-semibold text-sm">Entries - {selectedDate}</h4></div><table className="text-sm"><thead><tr><th>Type</th><th>Category</th><th>Description</th><th>Party</th><th>Amount</th><th></th></tr></thead>
            <tbody>{entries.map(e => (
              <tr key={e.id}><td><span className={`badge ${e.type === 'inflow' ? 'badge-green' : 'badge-red'}`}>{e.type}</span></td>
                <td>{e.category}</td><td>{e.description}</td><td>{e.party_name}</td>
                <td className={`font-semibold ${e.type === 'inflow' ? 'text-emerald-600' : 'text-red-600'}`}>{e.type === 'inflow' ? '+' : '-'}{fmt(e.amount)}</td>
                <td><button onClick={() => deleteEntry(e.id)} className="p-1 hover:bg-red-50 rounded text-red-500"><FiTrash2 size={14} /></button></td>
              </tr>
            ))}{entries.length === 0 && <tr><td colSpan="6" className="text-center py-4 text-gray-400">No entries</td></tr>}</tbody>
          </table></div>
        </>
      )}

      <Modal isOpen={modal} onClose={() => setModal(false)} title="Add Cash Flow Entry">
        <form onSubmit={saveEntry} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Date</label><input className="input" type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></div>
            <div><label className="label">Type</label><select className="select" value={form.type} onChange={e => setForm({ ...form, type: e.target.value, category: '' })}><option value="inflow">Inflow</option><option value="outflow">Outflow</option></select></div>
            <div><label className="label">Category *</label><select className="select" value={form.category} onChange={e => setForm({ ...form, category: e.target.value })} required><option value="">Select</option>{(form.type === 'inflow' ? inflowCategories : outflowCategories).map(c => <option key={c}>{c}</option>)}</select></div>
            <div><label className="label">Amount *</label><input className="input" type="number" value={form.amount} onChange={e => setForm({ ...form, amount: +e.target.value })} required /></div>
          </div>
          <div><label className="label">Description *</label><input className="input" value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} required /></div>
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Party Name</label><input className="input" value={form.party_name} onChange={e => setForm({ ...form, party_name: e.target.value })} /></div>
            <div><label className="label">Payment Mode</label><select className="select" value={form.payment_mode} onChange={e => setForm({ ...form, payment_mode: e.target.value })}><option value="">Select</option><option>Cash</option><option>Bank Transfer</option><option>UPI</option><option>Cheque</option><option>NEFT</option></select></div>
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Add</button></div>
        </form>
      </Modal>
    </div>
  );
}
