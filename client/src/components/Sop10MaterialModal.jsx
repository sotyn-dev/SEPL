// ═════════════════════════════════════════════════════════════════════════════
// SOP-10: Material use at site (Owner: Project Manager — Adarsh Kumar)
// Breadcrumb: daily reports -> daily reports -> store issue/return
// 5 Stages:
//   S1: Material issued against work area — mobile slip (Store Keeper: Ajmer)
//   S2: Daily report shows how much got installed in that area (Site Engineer)
//   S3: System compares issued vs installed vs BOQ (ERP Automatic Difference Rule Card)
//   S4: Monthly physical counting at site; tally with system (Ajmer + PM)
//   S5: Left-over material goes back to store or another site — never wasted (Transfer Note)
// ═════════════════════════════════════════════════════════════════════════════

import { useState, useEffect, useCallback } from 'react';
import Modal from './Modal';
import NumberedTable from './NumberedTable';
import api from '../api';
import toast from 'react-hot-toast';
import {
  FiPackage, FiAlertTriangle, FiCheckCircle, FiClock, FiFileText,
  FiPrinter, FiRefreshCw, FiShield, FiTruck, FiPlus, FiArrowRight,
  FiInfo, FiDollarSign, FiCheck, FiFilter, FiCalendar
} from 'react-icons/fi';

export default function Sop10MaterialModal({
  isOpen,
  onClose,
  initialSiteId = '',
  sites = [],
  users = [],
  onSlipCreated,
}) {
  const [activeTab, setActiveTab] = useState('slips'); // 'slips' | 'reconciliation' | 'count_sheet'
  const [selectedSiteId, setSelectedSiteId] = useState(initialSiteId || '');

  // ── S1 & S5 Slips State ───────────────────────────────────────────────────
  const [slipType, setSlipType] = useState('issue'); // 'issue' | 'return' | 'transfer'
  const [slipDate, setSlipDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [slipWorkArea, setSlipWorkArea] = useState('General Work Area');
  const [workAreaOptions, setWorkAreaOptions] = useState([]);
  const [slipTo, setSlipTo] = useState('');
  const [slipNotes, setSlipNotes] = useState('');
  const [slipShift, setSlipShift] = useState('day');
  const [slipRows, setSlipRows] = useState([]);
  const [slipBusy, setSlipBusy] = useState(false);
  const [slipsToday, setSlipsToday] = useState([]);
  const [destWarehouses, setDestWarehouses] = useState([]);
  const [slipToWarehouse, setSlipToWarehouse] = useState('');

  // ── S3 Difference Flag Rule Card State ────────────────────────────────────
  const [reconData, setReconData] = useState(null);
  const [reconLoading, setReconLoading] = useState(false);
  const [reconAreaFilter, setReconAreaFilter] = useState('');

  // ── S4 Monthly Physical Count Sheet State ─────────────────────────────────
  const [countSheets, setCountSheets] = useState([]);
  const [countSheetsLoading, setCountSheetsLoading] = useState(false);
  const [countEntryOpen, setCountEntryOpen] = useState(false);
  const [countViewSheet, setCountViewSheet] = useState(null);
  const [countForm, setCountForm] = useState({
    month_year: new Date().toISOString().slice(0, 7), // YYYY-MM
    count_date: new Date().toISOString().slice(0, 10),
    conducted_by: 'Ajmer / Store Keeper',
    verified_by: 'Adarsh Kumar / PM',
    remarks: '',
    items: [],
  });
  const [countSaving, setCountSaving] = useState(false);

  // Sync initial site ID
  useEffect(() => {
    if (initialSiteId) setSelectedSiteId(initialSiteId);
  }, [initialSiteId]);

  // Load Work Areas for Site (SOP-10.1 Area-Wise)
  const loadWorkAreas = useCallback(async (siteId) => {
    if (!siteId) return;
    try {
      const res = await api.get(`/dpr/sites/${siteId}/work-areas`);
      const areas = res.data || [];
      setWorkAreaOptions(areas);
      if (areas.length && (!slipWorkArea || slipWorkArea === 'General Work Area')) {
        setSlipWorkArea(areas[0]);
      }
    } catch {
      setWorkAreaOptions(['Ground Floor', '1st Floor', '2nd Floor', 'Main Work Area', 'Electrical Room', 'Block A']);
    }
  }, [slipWorkArea]);

  // Load Destination Warehouses for Transfers (SOP-10.5)
  const loadDestWarehouses = useCallback(async (siteId) => {
    if (!siteId) return;
    try {
      const res = await api.get('/dpr/destination-warehouses', { params: { exclude_site_id: siteId } });
      const whs = res.data || [];
      setDestWarehouses(whs);
      const office = whs.find(w => w.type === 'office' || w.warehouse_type === 'office') || whs[0];
      if (office) setSlipToWarehouse(String(office.id));
      else setSlipToWarehouse('');
    } catch {
      setDestWarehouses([]);
      setSlipToWarehouse('');
    }
  }, []);

  // Load Slip Rows (Caps, live stock, plan)
  const loadSlipRows = useCallback(async (siteId, type, dateIso) => {
    if (!siteId) { setSlipRows([]); setSlipsToday([]); return; }
    try {
      if (type === 'issue') {
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
            unit: it.uom || 'nos',
            cap: +it.stock_qty || 0,
            planned_today: sug ? +(sug.planned).toFixed(3) : 0,
            age_days: it.age_days,
            age_status: it.age_status,
            qty: suggest > 0 ? +suggest.toFixed(3) : '',
          });
        });
        const boqItems = Array.isArray(boq.data) ? boq.data : (boq.data?.items || []);
        boqItems.forEach(b => {
          if (!b.item_master_id || rows.has(b.item_master_id)) return;
          const sug = plannedByItem.get(b.item_master_id);
          rows.set(b.item_master_id, {
            item_master_id: b.item_master_id,
            name: [b.master_name, b.master_specification, b.master_size].filter(Boolean).join(' ') || b.description,
            unit: b.master_uom || b.unit || 'nos',
            cap: 0,
            planned_today: sug ? +(sug.planned).toFixed(3) : 0,
            age_days: null,
            age_status: 'unknown',
            qty: '',
          });
        });
        setSlipRows([...rows.values()].sort((a, b) => (b.cap - a.cap) || a.name.localeCompare(b.name)));
      } else if (type === 'transfer') {
        const r = await api.get(`/dpr/sites/${siteId}/store-stock`);
        const rows = (r.data?.items || [])
          .filter(it => +it.stock_qty > 0)
          .map(it => ({
            item_master_id: it.item_master_id,
            name: [it.item_name, it.specification, it.size].filter(Boolean).join(' '),
            unit: it.uom || 'nos',
            cap: +it.stock_qty || 0,
            planned_today: 0,
            age_days: it.age_days,
            age_status: it.age_status,
            qty: '',
          }));
        setSlipRows(rows.sort((a, b) => (b.cap - a.cap) || a.name.localeCompare(b.name)));
      } else {
        const r = await api.get(`/dpr/sites/${siteId}/consumption`, { params: { date: dateIso } });
        setSlipRows((r.data?.lines || [])
          .filter(l => (l.issued - l.returned) > 0)
          .map(l => ({
            item_master_id: l.item_master_id,
            name: l.item_name || `Item #${l.item_master_id}`,
            unit: l.unit || 'nos',
            cap: +(l.issued - l.returned).toFixed(3),
            qty: '',
          })));
      }
      const sl = await api.get('/dpr/site-slips', { params: { site_id: siteId, date: dateIso } });
      setSlipsToday(sl.data || []);
    } catch {
      setSlipRows([]);
      setSlipsToday([]);
    }
  }, []);

  // Load S3 Reconciliation & Difference Rule Cards
  const loadReconciliation = useCallback(async (siteId, dateIso, area = '') => {
    if (!siteId) return;
    setReconLoading(true);
    try {
      const params = {};
      if (dateIso) params.date = dateIso;
      if (area) params.work_area = area;
      const res = await api.get(`/dpr/sites/${siteId}/sop10-reconciliation`, { params });
      setReconData(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to calculate SOP-10 reconciliation');
      setReconData(null);
    } finally {
      setReconLoading(false);
    }
  }, []);

  // Load S4 Monthly Count Sheets
  const loadCountSheets = useCallback(async (siteId) => {
    if (!siteId) return;
    setCountSheetsLoading(true);
    try {
      const res = await api.get(`/dpr/sites/${siteId}/count-sheets`);
      setCountSheets(res.data || []);
    } catch {
      setCountSheets([]);
    } finally {
      setCountSheetsLoading(false);
    }
  }, []);

  // Trigger data load on site / tab change
  useEffect(() => {
    if (!isOpen || !selectedSiteId) return;
    loadWorkAreas(selectedSiteId);
    if (activeTab === 'slips') {
      loadSlipRows(selectedSiteId, slipType, slipDate);
      loadDestWarehouses(selectedSiteId);
    } else if (activeTab === 'reconciliation') {
      loadReconciliation(selectedSiteId, slipDate, reconAreaFilter);
    } else if (activeTab === 'count_sheet') {
      loadCountSheets(selectedSiteId);
    }
  }, [isOpen, selectedSiteId, activeTab, slipType, slipDate, reconAreaFilter, loadWorkAreas, loadSlipRows, loadDestWarehouses, loadReconciliation, loadCountSheets]);

  // Handle Save Slip (S1 Area-Wise Issue & S5 Transfer)
  const saveSlip = async () => {
    const items = slipRows.filter(r => +r.qty > 0).map(r => ({ item_master_id: r.item_master_id, quantity: +r.qty }));
    if (!selectedSiteId) return toast.error('Pick a site first');
    if (!items.length) return toast.error('Enter quantity on at least one item');
    if (!slipWorkArea.trim()) return toast.error('Work Area / Zone is required (SOP-10.1 Area-wise)');
    if (slipType === 'transfer') {
      if (!slipToWarehouse) return toast.error('Pick destination store / warehouse');
      if (!slipTo.trim()) return toast.error('Carrier / Transferred By name is required');
    } else {
      if (!slipTo.trim()) return toast.error(slipType === 'issue' ? 'Issued To (Site Engineer / Team) is required' : 'Returned By is required');
    }

    const over = slipRows.find(r => +r.qty > 0 && +r.qty > r.cap);
    if (over) return toast.error(`${over.name}: max ${over.cap} ${slipType === 'issue' || slipType === 'transfer' ? 'in stock' : 'outstanding'}`);

    setSlipBusy(true);
    try {
      const payload = {
        site_id: selectedSiteId,
        slip_type: slipType,
        slip_date: slipDate,
        work_area: slipWorkArea.trim(),
        issued_to: slipTo.trim(),
        notes: slipNotes,
        shift: slipShift,
        items,
        ...(slipType === 'transfer' ? { to_warehouse_id: slipToWarehouse } : {}),
      };
      const r = await api.post('/dpr/site-slips', payload);
      toast.success(`${r.data.slip_number} saved (SOP-10.${slipType === 'issue' ? '1' : '5'}) — opening print`);
      window.open(`/site-slip/${r.data.id}/print`, '_blank');
      loadSlipRows(selectedSiteId, slipType, slipDate);
      setSlipTo('');
      setSlipNotes('');
      if (onSlipCreated) onSlipCreated();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save slip');
    } finally {
      setSlipBusy(false);
    }
  };

  // Open New Physical Count Sheet Entry (SOP-10.4)
  const openNewCountSheet = async () => {
    if (!selectedSiteId) return toast.error('Pick a site first');
    try {
      const r = await api.get(`/dpr/sites/${selectedSiteId}/store-stock`);
      const stockItems = (r.data?.items || []).map(it => ({
        item_master_id: it.item_master_id,
        name: [it.item_name, it.specification, it.size].filter(Boolean).join(' '),
        unit: it.uom || 'nos',
        system_qty: +it.stock_qty || 0,
        rate: +it.avg_rate || 0,
        physical_qty: +it.stock_qty || 0, // default physical count to system stock for convenient tally
        variance_qty: 0,
        variance_value: 0,
        reason_remarks: '',
      }));
      setCountForm({
        month_year: new Date().toISOString().slice(0, 7),
        count_date: new Date().toISOString().slice(0, 10),
        conducted_by: 'Ajmer / Store Keeper',
        verified_by: 'Adarsh Kumar / PM',
        remarks: 'Monthly store physical count tally against ERP ledger (SOP-10.4)',
        items: stockItems,
      });
      setCountEntryOpen(true);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load store stock for count sheet');
    }
  };

  // Save S4 Monthly Count Sheet
  const handleSaveCountSheet = async (e) => {
    e.preventDefault();
    if (!selectedSiteId) return toast.error('Select site first');
    if (!countForm.items.length) return toast.error('No items to count');

    setCountSaving(true);
    try {
      const payload = {
        count_date: countForm.count_date,
        month_year: countForm.month_year,
        conducted_by: countForm.conducted_by,
        verified_by: countForm.verified_by,
        remarks: countForm.remarks,
        items: countForm.items.map(it => ({
          item_master_id: it.item_master_id,
          physical_qty: +it.physical_qty || 0,
          rate: +it.rate || 0,
          reason_remarks: it.reason_remarks || '',
        })),
      };
      await api.post(`/dpr/sites/${selectedSiteId}/count-sheets`, payload);
      toast.success('Monthly Physical Count Sheet saved successfully (SOP-10.4)');
      setCountEntryOpen(false);
      loadCountSheets(selectedSiteId);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save count sheet');
    } finally {
      setCountSaving(false);
    }
  };

  // View Single Count Sheet
  const viewCountSheet = async (id) => {
    try {
      const res = await api.get(`/dpr/count-sheets/${id}`);
      setCountViewSheet(res.data);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load count sheet');
    }
  };

  // PM Verification of Count Sheet (SOP-10.4)
  const handleVerifyCountSheet = async (sheetId) => {
    try {
      const res = await api.post(`/dpr/count-sheets/${sheetId}/verify`);
      toast.success(res.data?.message || 'Count sheet verified by Project Manager!');
      if (countViewSheet?.id === sheetId) {
        setCountViewSheet(prev => ({ ...prev, status: 'verified', verified_by: 'Adarsh Kumar (PM)' }));
      }
      loadCountSheets(selectedSiteId);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Verification failed');
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Material Use at Site — SOP-10 (Owner: PM Adarsh Kumar)" wide>
      <div className="space-y-4">
        {/* SOP-10 Governance Header Banner */}
        <div className="p-3 bg-gradient-to-r from-slate-900 to-indigo-950 text-white rounded-lg shadow-sm flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-md bg-blue-600 flex items-center justify-center font-bold text-base shadow">
              📦
            </div>
            <div>
              <div className="text-xs font-semibold uppercase tracking-wider text-blue-300">
                SOP-10 Execution & Control Desk
              </div>
              <div className="text-sm font-bold flex items-center gap-2">
                <span>Material Use at Site</span>
                <span className="text-[10px] bg-blue-500/30 text-blue-200 px-2 py-0.5 rounded border border-blue-400/30">
                  Daily Leakage Control
                </span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-300">
            <div>
              <span className="text-slate-400">Owner:</span> <strong className="text-white">Adarsh Kumar (PM)</strong>
            </div>
            <div className="h-4 w-px bg-slate-700" />
            <div>
              <span className="text-slate-400">Store Keeper:</span> <strong className="text-amber-300">Ajmer</strong>
            </div>
          </div>
        </div>

        {/* Tab Navigation */}
        <div className="flex border-b border-gray-200">
          <button
            type="button"
            onClick={() => setActiveTab('slips')}
            className={`py-2 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'slips'
                ? 'border-blue-600 text-blue-700 bg-blue-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FiPackage className="text-sm" />
            <span>S1 &amp; S5 Slips (Issue / Return / Transfer)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('reconciliation')}
            className={`py-2 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'reconciliation'
                ? 'border-red-600 text-red-700 bg-red-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FiAlertTriangle className="text-sm text-red-500" />
            <span>S3 Difference Flag Rule Card</span>
            {reconData?.summary?.red_flags > 0 && (
              <span className="bg-red-600 text-white text-[10px] px-1.5 py-0.2 rounded-full font-extrabold animate-pulse">
                {reconData.summary.red_flags} Alert
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('count_sheet')}
            className={`py-2 px-4 text-xs font-bold border-b-2 flex items-center gap-2 transition-colors ${
              activeTab === 'count_sheet'
                ? 'border-indigo-600 text-indigo-700 bg-indigo-50/50'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FiFileText className="text-sm" />
            <span>S4 Monthly Physical Count Sheet</span>
          </button>
        </div>

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 1: SLIPS COUNTER (S1 AREA-WISE ISSUE, EVENING RETURN, S5 TRANSFER)
            ═══════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'slips' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3">
              <div>
                <label className="label">Site *</label>
                <select
                  className="select"
                  value={selectedSiteId}
                  onChange={e => {
                    const sId = e.target.value;
                    setSelectedSiteId(sId);
                    loadSlipRows(sId, slipType, slipDate);
                    loadDestWarehouses(sId);
                    loadWorkAreas(sId);
                  }}
                >
                  <option value="">— Pick site —</option>
                  {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div>
                <label className="label">Type *</label>
                <div className="flex rounded border overflow-hidden">
                  <button
                    type="button"
                    onClick={() => { setSlipType('issue'); loadSlipRows(selectedSiteId, 'issue', slipDate); }}
                    className={`flex-1 py-1.5 text-[11px] sm:text-xs font-semibold ${slipType === 'issue' ? 'bg-red-600 text-white' : 'bg-white text-gray-600'}`}
                  >
                    🌅 S1 Issue
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSlipType('return'); loadSlipRows(selectedSiteId, 'return', slipDate); }}
                    className={`flex-1 py-1.5 text-[11px] sm:text-xs font-semibold ${slipType === 'return' ? 'bg-emerald-600 text-white' : 'bg-white text-gray-600'}`}
                  >
                    🌇 S1 Return
                  </button>
                  <button
                    type="button"
                    onClick={() => { setSlipType('transfer'); loadSlipRows(selectedSiteId, 'transfer', slipDate); if (!destWarehouses.length && selectedSiteId) loadDestWarehouses(selectedSiteId); }}
                    className={`flex-1 py-1.5 text-[11px] sm:text-xs font-semibold ${slipType === 'transfer' ? 'bg-purple-700 text-white' : 'bg-white text-gray-600'}`}
                  >
                    🚚 S5 Transfer
                  </button>
                </div>
              </div>

              <div>
                <label className="label">Slip Date</label>
                <input
                  type="date"
                  className="input"
                  value={slipDate}
                  onChange={e => {
                    setSlipDate(e.target.value);
                    loadSlipRows(selectedSiteId, slipType, e.target.value);
                  }}
                />
              </div>

              <div>
                <label className="label flex items-center justify-between">
                  <span>Work Area / Zone *</span>
                  <span className="text-[10px] text-blue-600 font-semibold">SOP-10.1</span>
                </label>
                <input
                  className="input"
                  list="sop10-work-area-suggestions"
                  placeholder="e.g. 1st Floor, Block A, Main Array…"
                  value={slipWorkArea}
                  onChange={e => setSlipWorkArea(e.target.value)}
                  required
                />
                <datalist id="sop10-work-area-suggestions">
                  {workAreaOptions.map((area, idx) => <option key={idx} value={area} />)}
                </datalist>
                <span className="text-[10px] text-gray-500 mt-0.5 block">Golden Rule S1: Area-wise, not project-wise</span>
              </div>
            </div>

            {slipType === 'transfer' && (
              <div className="bg-purple-50 border border-purple-200 rounded p-2.5">
                <label className="label text-purple-900 font-semibold mb-1">
                  Destination Store / Warehouse (SOP-10.5 Left-Over Return or Transfer) *
                </label>
                <select
                  className="select bg-white"
                  value={slipToWarehouse}
                  onChange={e => setSlipToWarehouse(e.target.value)}
                >
                  <option value="">— Pick destination store / warehouse —</option>
                  {destWarehouses.map(w => {
                    const isOffice = w.type === 'office' || w.warehouse_type === 'office';
                    return (
                      <option key={w.id} value={w.id}>
                        {isOffice ? '🏢 ' : '🏗️ '}
                        {w.name} {isOffice ? '(Central / Office Store)' : `(Site Store — ${w.site_name || 'Site'})`}
                      </option>
                    );
                  })}
                </select>
                <div className="text-[11px] text-purple-700 mt-1">
                  ✓ SOP-10.5: Left-over material goes back to store or another site — never wasted. Auto-updates both ledgers.
                </div>
              </div>
            )}

            {/* Shift selector & Store Keeper indicator */}
            <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t border-gray-100">
              <div className="flex items-center gap-2">
                <span className="text-[11px] text-gray-500 font-semibold">Shift:</span>
                {[['day', '🌅 Morning 9–6'], ['evening', '🌆 Evening 6–10'], ['night', '🌙 Night 10–2']].map(([k, l]) => (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setSlipShift(k)}
                    className={`text-[11px] px-2 py-0.5 rounded border font-semibold ${slipShift === k ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-gray-600 border-gray-300'}`}
                  >
                    {l}
                  </button>
                ))}
              </div>
              <div className="text-xs text-slate-500">
                Store Keeper: <strong className="text-gray-800">Ajmer</strong>
              </div>
            </div>

            <div>
              <label className="label">
                {slipType === 'issue'
                  ? 'Issued To (Site Engineer / Team taking material) *'
                  : slipType === 'transfer'
                    ? 'Carrier / Transferred By (Driver / Vehicle No. / Carrier info) *'
                    : 'Returned By (Site Engineer / Team returning material) *'}
              </label>
              <input
                className="input"
                list="sop10-person-suggestions"
                placeholder={slipType === 'transfer' ? 'Driver name, vehicle number…' : 'Type name or select user…'}
                value={slipTo}
                onChange={e => setSlipTo(e.target.value)}
              />
              <datalist id="sop10-person-suggestions">
                {(users || []).map(u => <option key={u.id} value={u.name} />)}
              </datalist>
            </div>

            {selectedSiteId && slipRows.length === 0 && (
              <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2">
                {slipType === 'issue' ? (
                  'This site\'s store has no stock available. Add stock via Inventory Opening Stock, PO Receiving, or Office Store Transfer.'
                ) : slipType === 'transfer' ? (
                  'No stock available to transfer in this site store.'
                ) : (
                  'Nothing outstanding to return — no net material issued on this date.'
                )}
              </div>
            )}

            {slipRows.length > 0 && (
              <div className="overflow-x-auto border rounded-lg">
                <NumberedTable className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b bg-gray-50">
                      <th className="text-left py-1.5 pr-2">Material</th>
                      <th className="text-right py-1.5 px-2 whitespace-nowrap">
                        {slipType === 'issue' || slipType === 'transfer' ? 'Store Balance' : 'Outstanding'}
                      </th>
                      {slipType === 'issue' && <th className="text-right py-1.5 px-2 whitespace-nowrap">Aaj Ka Plan</th>}
                      <th className="text-right py-1.5 pl-2 w-32 whitespace-nowrap">
                        {slipType === 'issue' ? 'Issue Qty (Suggested)' : slipType === 'transfer' ? 'Transfer Qty' : 'Return Qty'}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {slipRows.map((r, i) => (
                      <tr key={r.item_master_id} className="border-b">
                        <td className="py-1.5 pr-2 min-w-[150px]">
                          <div className="font-medium text-gray-800">{r.name}</div>
                          <div className="text-[10px] text-gray-400">Unit: {r.unit}</div>
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{r.cap}</td>
                        {slipType === 'issue' && (
                          <td className="py-1.5 px-2 text-right tabular-nums text-blue-700">
                            {r.planned_today > 0 ? r.planned_today : '—'}
                          </td>
                        )}
                        <td className="py-1.5 pl-2 text-right">
                          <input
                            type="number"
                            min="0"
                            max={r.cap}
                            step="0.01"
                            disabled={slipType === 'issue' && r.cap <= 0}
                            className={`input text-xs text-right w-full ${
                              slipType === 'issue' && r.cap <= 0 ? 'bg-gray-100 text-gray-400' : ''
                            } ${+r.qty > r.cap ? '!border-red-400 bg-red-50' : ''}`}
                            value={r.qty}
                            placeholder="0"
                            onChange={e => {
                              const val = e.target.value;
                              setSlipRows(prev => prev.map((x, j) => j === i ? { ...x, qty: val } : x));
                            }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </NumberedTable>
              </div>
            )}

            <div>
              <label className="label">Notes / Purpose</label>
              <input
                className="input"
                value={slipNotes}
                onChange={e => setSlipNotes(e.target.value)}
                placeholder="Optional — e.g. Riser cabling on 2nd floor, solar inverter mounting"
              />
            </div>

            {/* Today's Slips Register */}
            {slipsToday.length > 0 && (
              <div className="bg-gray-50 border rounded-lg p-2.5">
                <div className="text-[11px] font-bold text-gray-700 mb-1 flex items-center justify-between">
                  <span>Slips Generated for {slipDate}</span>
                  <span className="text-[10px] text-gray-500 font-normal">{slipsToday.length} slip(s)</span>
                </div>
                <div className="space-y-1">
                  {slipsToday.map(s => (
                    <div key={s.id} className="flex flex-wrap items-center justify-between text-[11px] py-1 border-b last:border-b-0 border-gray-200">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono font-bold ${s.slip_type === 'issue' ? 'text-red-700' : s.slip_type === 'transfer' ? 'text-purple-700' : 'text-emerald-700'}`}>
                          {s.slip_number}
                        </span>
                        <span className="text-gray-500">
                          [{s.work_area || 'General'}] → {s.issued_to}
                        </span>
                        <span className="text-[10px] text-gray-400">({(s.items || []).length} items)</span>
                      </div>
                      <a
                        href={`/site-slip/${s.id}/print`}
                        target="_blank"
                        rel="noreferrer"
                        className="text-blue-700 hover:underline font-semibold flex items-center gap-1"
                      >
                        <FiPrinter size={12} /> Print GRN
                      </a>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
              <button
                type="button"
                onClick={saveSlip}
                disabled={slipBusy || !selectedSiteId}
                className="btn btn-primary text-xs flex items-center gap-1.5"
              >
                {slipBusy ? 'Saving…' : (
                  <>
                    <FiPrinter size={14} />
                    <span>
                      {slipType === 'issue'
                        ? 'Save Area Issue Slip & Print (SOP-10.1)'
                        : slipType === 'transfer'
                          ? 'Save Transfer Note & Print (SOP-10.5)'
                          : 'Save Return Slip & Print (SOP-10.5)'}
                    </span>
                  </>
                )}
              </button>
            </div>
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 2: DIFFERENCE FLAG RULE CARD (S3 ISSUED VS INSTALLED VS BOQ)
            ═══════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'reconciliation' && (
          <div className="space-y-3">
            {/* S3 Rule Callout */}
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-xs text-red-900 flex items-start gap-2.5">
              <FiAlertTriangle className="text-red-600 shrink-0 mt-0.5 text-base" />
              <div>
                <strong className="block font-bold">SOP-10.3 Rule Card: Same-Day Leakage Detection</strong>
                <span>
                  The ERP compares <strong>Net Store Issued vs DPR Installed vs BOQ</strong> automatically.
                  If the difference exceeds the scrap tolerance, it raises an instant SAME-DAY RED FLAG so leakage is
                  caught immediately, not months later at handover!
                </span>
              </div>
            </div>

            {/* Filter controls */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50 p-2.5 rounded-lg border">
              <div>
                <label className="label">Site</label>
                <select
                  className="select bg-white"
                  value={selectedSiteId}
                  onChange={e => {
                    setSelectedSiteId(e.target.value);
                    loadReconciliation(e.target.value, slipDate, reconAreaFilter);
                  }}
                >
                  <option value="">— Pick site —</option>
                  {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>

              <div>
                <label className="label">Date (or leave blank for cumulative)</label>
                <input
                  type="date"
                  className="input bg-white"
                  value={slipDate}
                  onChange={e => {
                    setSlipDate(e.target.value);
                    loadReconciliation(selectedSiteId, e.target.value, reconAreaFilter);
                  }}
                />
              </div>

              <div>
                <label className="label">Work Area Filter</label>
                <select
                  className="select bg-white"
                  value={reconAreaFilter}
                  onChange={e => {
                    setReconAreaFilter(e.target.value);
                    loadReconciliation(selectedSiteId, slipDate, e.target.value);
                  }}
                >
                  <option value="">— All Work Areas —</option>
                  {workAreaOptions.map((a, i) => <option key={i} value={a}>{a}</option>)}
                </select>
              </div>
            </div>

            {/* Summary KPI Badges */}
            {reconData && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                <div className="p-2.5 bg-slate-50 border rounded-lg text-center">
                  <div className="text-[10px] uppercase font-bold text-gray-500">Tracked Materials</div>
                  <div className="text-lg font-bold text-gray-800">{reconData.summary.total_items}</div>
                </div>
                <div className="p-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-center">
                  <div className="text-[10px] uppercase font-bold text-emerald-700">🟢 Exact / Matched</div>
                  <div className="text-lg font-bold text-emerald-800">{reconData.summary.green_flags}</div>
                </div>
                <div className="p-2.5 bg-amber-50 border border-amber-200 rounded-lg text-center">
                  <div className="text-[10px] uppercase font-bold text-amber-700">🟡 Watch / Pending Return</div>
                  <div className="text-lg font-bold text-amber-800">{reconData.summary.amber_flags}</div>
                </div>
                <div className="p-2.5 bg-red-50 border border-red-200 rounded-lg text-center">
                  <div className="text-[10px] uppercase font-bold text-red-700">🔴 Same-Day Leakage Alert</div>
                  <div className="text-lg font-bold text-red-800">{reconData.summary.red_flags}</div>
                </div>
              </div>
            )}

            {reconLoading ? (
              <div className="py-8 text-center text-xs text-gray-500 flex items-center justify-center gap-2">
                <FiRefreshCw className="animate-spin" /> Evaluating SOP-10.3 Difference Rule Card…
              </div>
            ) : !reconData || !reconData.items.length ? (
              <div className="py-8 text-center text-xs text-gray-400 bg-gray-50 rounded-lg border">
                No store issue or installation data found for this date &amp; area.
              </div>
            ) : (
              <div className="overflow-x-auto border rounded-lg">
                <NumberedTable className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b bg-gray-50">
                      <th className="text-left py-2 pr-2">Material / Item</th>
                      <th className="text-left py-2 px-2">Work Area</th>
                      <th className="text-right py-2 px-2">Net Issued</th>
                      <th className="text-right py-2 px-2">DPR Installed</th>
                      <th className="text-right py-2 px-2">Difference</th>
                      <th className="text-right py-2 px-2">BOQ Limit</th>
                      <th className="text-left py-2 pl-2">SOP-10.3 Rule Card Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconData.items.map((it, idx) => {
                      const isRed = it.flag_status === 'red';
                      const isAmber = it.flag_status === 'amber';
                      return (
                        <tr key={idx} className={`border-b ${isRed ? 'bg-red-50/60' : isAmber ? 'bg-amber-50/40' : ''}`}>
                          <td className="py-1.5 pr-2 font-medium">
                            <div className="text-gray-800">{it.item_name}</div>
                            <div className="text-[10px] text-gray-400">{it.unit} · Stock: {it.current_store_stock}</div>
                          </td>
                          <td className="py-1.5 px-2">
                            <span className="font-semibold text-gray-700 bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                              {it.work_area}
                            </span>
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-blue-800">
                            {it.net_issued_qty}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums font-semibold text-emerald-800">
                            {it.installed_qty}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums">
                            <span className={`font-bold ${it.variance > 0 ? 'text-red-700' : it.variance < 0 ? 'text-amber-700' : 'text-gray-600'}`}>
                              {it.variance > 0 ? `+${it.variance}` : it.variance}
                            </span>
                            {it.net_issued_qty > 0 && it.variance !== 0 && (
                              <div className="text-[9px] text-gray-500">({it.variance_pct}%)</div>
                            )}
                          </td>
                          <td className="py-1.5 px-2 text-right tabular-nums text-gray-600">
                            {it.boq_qty > 0 ? it.boq_qty : '—'}
                          </td>
                          <td className="py-1.5 pl-2">
                            <div className="flex items-center gap-1.5">
                              {isRed ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-red-600 text-white px-2 py-0.5 rounded">
                                  🔴 {it.flag_title}
                                </span>
                              ) : isAmber ? (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-500 text-white px-2 py-0.5 rounded">
                                  🟡 {it.flag_title}
                                </span>
                              ) : (
                                <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-600 text-white px-2 py-0.5 rounded">
                                  🟢 {it.flag_title}
                                </span>
                              )}
                            </div>
                            <div className="text-[10px] text-gray-600 mt-0.5 max-w-xs leading-tight">
                              {it.flag_message}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </NumberedTable>
              </div>
            )}
          </div>
        )}

        {/* ═══════════════════════════════════════════════════════════════════════
            TAB 3: MONTHLY PHYSICAL COUNT SHEET (S4 AJMER + PM ADARSH KUMAR)
            ═══════════════════════════════════════════════════════════════════════ */}
        {activeTab === 'count_sheet' && (
          <div className="space-y-3">
            {/* S4 Rule Callout */}
            <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg text-xs text-indigo-900 flex items-start justify-between gap-3">
              <div className="flex items-start gap-2.5">
                <FiFileText className="text-indigo-600 shrink-0 mt-0.5 text-base" />
                <div>
                  <strong className="block font-bold">SOP-10.4: Monthly Physical Counting at Site</strong>
                  <span>
                    Monthly physical count sheet tally with the system ledger. Conducted by{' '}
                    <strong>Store Keeper (Ajmer)</strong> and verified by <strong>PM (Adarsh Kumar)</strong>.
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={openNewCountSheet}
                className="btn btn-primary text-xs shrink-0 flex items-center gap-1 shadow-sm"
              >
                <FiPlus size={14} /> New Physical Count
              </button>
            </div>

            {/* List of past count sheets */}
            {countSheetsLoading ? (
              <div className="py-8 text-center text-xs text-gray-500">Loading monthly count sheets…</div>
            ) : !countSheets.length ? (
              <div className="py-8 text-center text-xs text-gray-400 bg-gray-50 rounded-lg border">
                No monthly count sheets recorded for this site yet. Click &quot;New Physical Count&quot; to begin.
              </div>
            ) : (
              <div className="overflow-x-auto border rounded-lg">
                <NumberedTable className="w-full text-xs">
                  <thead>
                    <tr className="text-gray-500 border-b bg-gray-50">
                      <th className="text-left py-2 pr-2">Month / Date</th>
                      <th className="text-left py-2 px-2">Store / Warehouse</th>
                      <th className="text-left py-2 px-2">Conducted By</th>
                      <th className="text-left py-2 px-2">PM Verification</th>
                      <th className="text-right py-2 px-2">Items Counted</th>
                      <th className="text-right py-2 px-2">Total Variance (₹)</th>
                      <th className="text-center py-2 pl-2">Status</th>
                      <th className="text-right py-2 pl-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {countSheets.map(cs => (
                      <tr key={cs.id} className="border-b">
                        <td className="py-2 pr-2 font-semibold">
                          <div>{cs.month_year}</div>
                          <div className="text-[10px] text-gray-400 font-normal">{cs.count_date}</div>
                        </td>
                        <td className="py-2 px-2 text-gray-700">{cs.warehouse_name || 'Site Store'}</td>
                        <td className="py-2 px-2">{cs.conducted_by}</td>
                        <td className="py-2 px-2">{cs.verified_by || '—'}</td>
                        <td className="py-2 px-2 text-right tabular-nums font-semibold">{cs.item_count}</td>
                        <td className={`py-2 px-2 text-right tabular-nums font-bold ${cs.total_variance_value < 0 ? 'text-red-600' : cs.total_variance_value > 0 ? 'text-emerald-600' : 'text-gray-600'}`}>
                          ₹{Number(cs.total_variance_value || 0).toLocaleString('en-IN')}
                        </td>
                        <td className="py-2 pl-2 text-center">
                          {cs.status === 'verified' ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-emerald-100 text-emerald-800 px-2 py-0.5 rounded-full">
                              <FiCheck size={11} /> Verified
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded-full">
                              <FiClock size={11} /> Awaiting PM
                            </span>
                          )}
                        </td>
                        <td className="py-2 pl-2 text-right">
                          <button
                            type="button"
                            onClick={() => viewCountSheet(cs.id)}
                            className="text-xs text-blue-700 font-semibold hover:underline"
                          >
                            View Sheet
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </NumberedTable>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Sub-Modal: Entry Form for S4 Monthly Count Sheet ─────────────────── */}
      {countEntryOpen && (
        <Modal isOpen={countEntryOpen} onClose={() => setCountEntryOpen(false)} title="SOP-10.4 · Monthly Physical Count Entry" wide>
          <form onSubmit={handleSaveCountSheet} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 bg-gray-50 p-3 rounded-lg border text-xs">
              <div>
                <label className="label">Month / Year *</label>
                <input
                  type="month"
                  className="input bg-white"
                  value={countForm.month_year}
                  onChange={e => setCountForm({ ...countForm, month_year: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">Physical Count Date *</label>
                <input
                  type="date"
                  className="input bg-white"
                  value={countForm.count_date}
                  onChange={e => setCountForm({ ...countForm, count_date: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">Conducted By (Store Keeper) *</label>
                <input
                  className="input bg-white"
                  value={countForm.conducted_by}
                  onChange={e => setCountForm({ ...countForm, conducted_by: e.target.value })}
                  required
                />
              </div>
              <div>
                <label className="label">PM Verifier (SOP Owner)</label>
                <input
                  className="input bg-white"
                  value={countForm.verified_by}
                  onChange={e => setCountForm({ ...countForm, verified_by: e.target.value })}
                />
              </div>
            </div>

            <div className="overflow-x-auto max-h-[350px] border rounded-lg">
              <NumberedTable className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b bg-gray-100 sticky top-0">
                    <th className="text-left py-2 pr-2">Material / Description</th>
                    <th className="text-right py-2 px-2">ERP System Qty</th>
                    <th className="text-right py-2 px-2 w-28">Physical Count</th>
                    <th className="text-right py-2 px-2">Variance</th>
                    <th className="text-right py-2 px-2">Rate (₹)</th>
                    <th className="text-right py-2 px-2">Variance Value (₹)</th>
                    <th className="text-left py-2 pl-2">Reason / Discrepancy Note</th>
                  </tr>
                </thead>
                <tbody>
                  {countForm.items.map((it, idx) => {
                    const variance = +(+it.physical_qty - +it.system_qty).toFixed(3);
                    const varVal = +(variance * (+it.rate || 0)).toFixed(2);
                    return (
                      <tr key={idx} className="border-b">
                        <td className="py-1.5 pr-2">
                          <div className="font-semibold text-gray-800">{it.name}</div>
                          <div className="text-[10px] text-gray-400">Unit: {it.unit}</div>
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums font-semibold">{it.system_qty}</td>
                        <td className="py-1.5 px-2 text-right">
                          <input
                            type="number"
                            step="0.01"
                            className="input text-xs text-right w-full font-bold"
                            value={it.physical_qty}
                            onChange={e => {
                              const p = e.target.value;
                              setCountForm(prev => {
                                const copy = [...prev.items];
                                copy[idx] = { ...copy[idx], physical_qty: p };
                                return { ...prev, items: copy };
                              });
                            }}
                            required
                          />
                        </td>
                        <td className={`py-1.5 px-2 text-right tabular-nums font-bold ${variance < 0 ? 'text-red-600' : variance > 0 ? 'text-emerald-600' : 'text-gray-600'}`}>
                          {variance > 0 ? `+${variance}` : variance}
                        </td>
                        <td className="py-1.5 px-2 text-right tabular-nums text-gray-500">₹{it.rate}</td>
                        <td className={`py-1.5 px-2 text-right tabular-nums font-bold ${varVal < 0 ? 'text-red-600' : varVal > 0 ? 'text-emerald-600' : 'text-gray-600'}`}>
                          ₹{varVal.toLocaleString('en-IN')}
                        </td>
                        <td className="py-1.5 pl-2">
                          <input
                            className="input text-xs w-full"
                            placeholder="Reason if any discrepancy…"
                            value={it.reason_remarks}
                            onChange={e => {
                              const r = e.target.value;
                              setCountForm(prev => {
                                const copy = [...prev.items];
                                copy[idx] = { ...copy[idx], reason_remarks: r };
                                return { ...prev, items: copy };
                              });
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </NumberedTable>
            </div>

            <div>
              <label className="label">General Remarks</label>
              <input
                className="input"
                value={countForm.remarks}
                onChange={e => setCountForm({ ...countForm, remarks: e.target.value })}
                placeholder="Remarks on physical tally…"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => setCountEntryOpen(false)} className="btn btn-secondary text-xs">
                Cancel
              </button>
              <button type="submit" disabled={countSaving} className="btn btn-primary text-xs flex items-center gap-1.5">
                <FiCheck size={14} /> {countSaving ? 'Saving…' : 'Submit Count Sheet (SOP-10.4)'}
              </button>
            </div>
          </form>
        </Modal>
      )}

      {/* ── Sub-Modal: View & Verify Count Sheet Detail ─────────────────────── */}
      {countViewSheet && (
        <Modal isOpen={!!countViewSheet} onClose={() => setCountViewSheet(null)} title={`Physical Count Sheet — ${countViewSheet.month_year}`} wide>
          <div className="space-y-3 text-xs">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 p-2.5 rounded-lg border">
              <div><span className="text-gray-500">Site:</span> <strong>{countViewSheet.site_name}</strong></div>
              <div><span className="text-gray-500">Date:</span> <strong>{countViewSheet.count_date}</strong></div>
              <div><span className="text-gray-500">Conducted By:</span> <strong>{countViewSheet.conducted_by}</strong></div>
              <div><span className="text-gray-500">Status:</span> <strong>{countViewSheet.status?.toUpperCase()}</strong></div>
            </div>

            <div className="overflow-x-auto max-h-[350px] border rounded-lg">
              <NumberedTable className="w-full text-xs">
                <thead>
                  <tr className="text-gray-500 border-b bg-gray-100">
                    <th className="text-left py-2 pr-2">Material</th>
                    <th className="text-right py-2 px-2">ERP System Qty</th>
                    <th className="text-right py-2 px-2">Physical Counted</th>
                    <th className="text-right py-2 px-2">Variance</th>
                    <th className="text-right py-2 px-2">Variance Value (₹)</th>
                    <th className="text-left py-2 pl-2">Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {(countViewSheet.items || []).map((it, idx) => (
                    <tr key={idx} className="border-b">
                      <td className="py-1.5 pr-2 font-medium">{it.item_name} ({it.unit})</td>
                      <td className="py-1.5 px-2 text-right tabular-nums">{it.system_qty}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums font-bold">{it.physical_qty}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums font-bold ${it.variance_qty < 0 ? 'text-red-600' : it.variance_qty > 0 ? 'text-emerald-600' : 'text-gray-600'}`}>
                        {it.variance_qty > 0 ? `+${it.variance_qty}` : it.variance_qty}
                      </td>
                      <td className={`py-1.5 px-2 text-right tabular-nums font-bold ${it.variance_value < 0 ? 'text-red-600' : it.variance_value > 0 ? 'text-emerald-600' : 'text-gray-600'}`}>
                        ₹{Number(it.variance_value || 0).toLocaleString('en-IN')}
                      </td>
                      <td className="py-1.5 pl-2 text-gray-600">{it.reason_remarks || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </NumberedTable>
            </div>

            <div className="flex items-center justify-between pt-2 border-t">
              <div className="text-gray-500">
                Verified By: <strong>{countViewSheet.verified_by || 'Pending PM Verification'}</strong>
              </div>
              <div className="flex gap-2">
                <button type="button" onClick={() => setCountViewSheet(null)} className="btn btn-secondary text-xs">
                  Close
                </button>
                {countViewSheet.status !== 'verified' && (
                  <button
                    type="button"
                    onClick={() => handleVerifyCountSheet(countViewSheet.id)}
                    className="btn btn-primary text-xs flex items-center gap-1.5"
                  >
                    <FiShield size={14} /> Verify &amp; Sign Off (PM Adarsh Kumar)
                  </button>
                )}
              </div>
            </div>
          </div>
        </Modal>
      )}
    </Modal>
  );
}

