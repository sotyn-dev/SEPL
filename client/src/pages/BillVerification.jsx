import NumberedTable from '../components/NumberedTable';
// Labour Management System — Modules 4-6: Bill Verification chain,
// Bills & Finance, Payments.
//
//   Bills           the 4-stage queue: Contractor Uploaded -> Site Engineer
//                   -> Finance -> Payment. Verify / Reject / Send Back / Hold per bill.
//   Vendor Ledger   per-contractor running balance (Module 6)
//   Dashboard       bills awaiting verification by stage, paid this month
import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  FiFileText, FiDollarSign, FiTrendingUp, FiPlus, FiCheck, FiX, FiCornerUpLeft,
  FiChevronRight, FiPause, FiPlay, FiPrinter, FiUpload, FiAlertTriangle, FiTrash2,
  FiExternalLink
} from 'react-icons/fi';

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const STAGE_LABEL = {
  contractor_uploaded: 'Contractor Uploaded',
  site_engineer: 'Site Engineer',
  site_head: 'Site Head',
  project_manager: 'Project Manager',
  finance: 'Finance',
  accounts: 'Accounts',
  payment: 'Payment',
};
// Simplified 4-stage chain: Contractor Upload -> Site Engineer -> Finance -> Payment.
const STAGES = ['contractor_uploaded', 'site_engineer', 'finance', 'payment'];

export default function BillVerification() {
  const [tab, setTab] = useUrlTab('bills');
  const TABS = [
    ['bills', 'Bills', FiFileText],
    ['ledger', 'Vendor Ledger', FiDollarSign],
    ['dashboard', 'Dashboard', FiTrendingUp],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FiFileText className="text-red-600" /> Bill Verification
        </h1>
        <p className="text-sm text-gray-500">Contractor bill → Site Engineer → Finance → Payment (Linked to BOQ PO items).</p>
      </div>

      <div className="flex gap-2 border-b border-gray-200 flex-wrap">
        {TABS.map(([k, text, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5 ${tab === k
              ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon size={14} /> {text}
          </button>
        ))}
      </div>

      {tab === 'bills' && <BillsTab />}
      {tab === 'ledger' && <LedgerTab />}
      {tab === 'dashboard' && <DashboardTab />}
    </div>
  );
}

// ─── Bills queue ────────────────────────────────────────────────────────
function BillsTab() {
  const { canCreate, canApprove } = useAuth();
  const [rows, setRows] = useState([]);
  const [stageFilter, setStageFilter] = useState('');
  const [newModal, setNewModal] = useState(false);
  const [drawerBill, setDrawerBill] = useState(null);
  const [workOrders, setWorkOrders] = useState([]);

  // Bill builder form state
  const [form, setForm] = useState({
    work_order_id: '',
    invoice_number: '',
    gross_amount: '',
    gst_pct: '18',
    tds_pct: '2',
    remarks: '',
    bill_file: ''
  });
  const [billItems, setBillItems] = useState([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const load = useCallback(() => {
    api.get('/bill-verification/bills', { params: stageFilter ? { current_stage: stageFilter } : {} })
      .then(r => setRows(r.data || [])).catch(() => toast.error('Could not load bills'));
  }, [stageFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/indent-labour-payment/active-work-orders')
      .then(r => setWorkOrders(r.data || []))
      .catch(() => setWorkOrders([]));
  }, []);

  // When a work order is selected in the bill modal, fetch billable PO items
  const onSelectWorkOrder = async (woId) => {
    setForm(f => ({ ...f, work_order_id: woId }));
    if (!woId) {
      setBillItems([]);
      return;
    }
    setLoadingItems(true);
    try {
      const res = await api.get('/bill-verification/boq-po-items', { params: { work_order_id: woId } });
      const raw = Array.isArray(res.data) ? res.data : (res.data?.items || []);
      const mapped = raw.map(it => ({
        boq_item_id: it.boq_item_id,
        source_table: it.source_table,
        item_code: it.item_code || '',
        item_description: it.item_description || it.description || '',
        uom: it.uom || it.unit || 'nos',
        boq_qty: Number(it.boq_qty) || 0,
        prev_billed_qty: Number(it.prev_billed_qty) || 0,
        balance_qty: Number(it.balance_qty) || 0,
        current_billed_qty: '',
        rate: Number(it.rate) || 0,
        amount: 0,
        remarks: ''
      }));
      setBillItems(mapped);
    } catch {
      toast.error('Could not load BOQ items for this work order');
      setBillItems([]);
    } finally {
      setLoadingItems(false);
    }
  };

  const updateItem = (index, field, value) => {
    setBillItems(prev => {
      const copy = [...prev];
      const item = { ...copy[index], [field]: value };
      const qty = Number(item.current_billed_qty) || 0;
      const rate = Number(item.rate) || 0;
      item.amount = Math.round(qty * rate * 100) / 100;
      copy[index] = item;
      return copy;
    });
  };

  const fillRemaining = (index) => {
    setBillItems(prev => {
      const copy = [...prev];
      const item = { ...copy[index] };
      const rem = Math.max(0, item.balance_qty);
      item.current_billed_qty = rem;
      const rate = Number(item.rate) || 0;
      item.amount = Math.round(rem * rate * 100) / 100;
      copy[index] = item;
      return copy;
    });
  };

  const addItemRow = () => {
    setBillItems(prev => [
      ...prev,
      {
        boq_item_id: null,
        item_code: '',
        item_description: '',
        uom: 'nos',
        boq_qty: 0,
        prev_billed_qty: 0,
        balance_qty: 0,
        current_billed_qty: 1,
        rate: 0,
        amount: 0,
        remarks: ''
      }
    ]);
  };

  const removeItemRow = (index) => {
    setBillItems(prev => prev.filter((_, i) => i !== index));
  };

  // Financial calculations
  const itemsTotal = useMemo(() => {
    return billItems.reduce((sum, it) => sum + (Number(it.amount) || 0), 0);
  }, [billItems]);

  const effectiveGross = billItems.length > 0 ? itemsTotal : (Number(form.gross_amount) || 0);
  const gstAmount = Math.round(effectiveGross * (Number(form.gst_pct) || 0) / 100);
  const tdsAmount = Math.round(effectiveGross * (Number(form.tds_pct) || 0) / 100);
  const netAmount = effectiveGross - tdsAmount;

  const createBill = async (e) => {
    e.preventDefault();
    if (!form.work_order_id) return toast.error('Work Order is required');
    if (effectiveGross <= 0) return toast.error('Total bill gross amount must be greater than zero');

    // Warn if any item exceeds cumulative BOQ qty
    const overbilled = billItems.filter(it => it.boq_qty > 0 && (Number(it.prev_billed_qty) + Number(it.current_billed_qty) > it.boq_qty));
    if (overbilled.length > 0) {
      const proceed = window.confirm(`Notice: ${overbilled.length} item(s) exceed the approved BOQ quantity. Proceed with submission?`);
      if (!proceed) return;
    }

    setSubmitting(true);
    try {
      const validItems = billItems.filter(it => Number(it.current_billed_qty) > 0 || Number(it.amount) > 0);
      await api.post('/bill-verification/bills', {
        work_order_id: form.work_order_id,
        invoice_number: form.invoice_number,
        gross_amount: effectiveGross,
        remarks: form.remarks,
        bill_file: form.bill_file,
        items: validItems,
        deductions: [
          { label: 'GST', pct: form.gst_pct, amount: gstAmount },
          { label: 'TDS', pct: form.tds_pct, amount: tdsAmount },
        ],
      });
      toast.success('Contractor bill submitted successfully (Stage: Site Engineer)');
      setNewModal(false);
      setBillItems([]);
      setForm({ work_order_id: '', invoice_number: '', gross_amount: '', gst_pct: '18', tds_pct: '2', remarks: '', bill_file: '' });
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not create bill');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setStageFilter('')} className={`text-xs px-2.5 py-1 rounded border ${!stageFilter ? 'bg-red-600 text-white border-red-600 font-medium' : 'border-gray-200 text-gray-600'}`}>All</button>
          {STAGES.filter(s => s !== 'contractor_uploaded').map(s => (
            <button key={s} onClick={() => setStageFilter(s)} className={`text-xs px-2.5 py-1 rounded border ${stageFilter === s ? 'bg-red-600 text-white border-red-600 font-medium' : 'border-gray-200 text-gray-600'}`}>{STAGE_LABEL[s]}</button>
          ))}
        </div>
        {canCreate('bill_verification') && (
          <button
            onClick={() => {
              setForm({ work_order_id: '', invoice_number: '', gross_amount: '', gst_pct: '18', tds_pct: '2', remarks: '', bill_file: '' });
              setBillItems([]);
              setNewModal(true);
            }}
            className="btn btn-primary flex items-center gap-1.5 text-sm shadow-sm"
          >
            <FiPlus size={15} /> New Contractor Bill
          </button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto shadow-sm">
        <NumberedTable className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600 border-b">
            <th className="px-3 py-2 text-left">RA No</th>
            <th className="px-3 py-2 text-left">Contractor</th>
            <th className="px-3 py-2 text-left">Work Order</th>
            <th className="px-3 py-2 text-right">Gross</th>
            <th className="px-3 py-2 text-right">Net Amount</th>
            <th className="px-3 py-2 text-center">Status</th>
            <th className="px-3 py-2 text-left">Current Stage</th>
            <th className="px-3 py-2 text-center">Action</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-red-50/40 cursor-pointer transition-colors" onClick={() => setDrawerBill(r.id)}>
                <td className="px-3 py-2.5 font-mono text-xs font-bold text-red-600">{r.ra_no}</td>
                <td className="px-3 py-2.5 font-medium text-gray-800">{r.contractor_name || r.sub_contractor_name || '—'}</td>
                <td className="px-3 py-2.5 text-xs text-gray-600">{r.wo_number || '—'}</td>
                <td className="px-3 py-2.5 text-right text-gray-600">{money(r.gross_amount)}</td>
                <td className="px-3 py-2.5 text-right font-semibold text-emerald-700">{money(r.net_amount)}</td>
                <td className="px-3 py-2.5 text-center">
                  <span className={`text-[10px] px-2 py-0.5 rounded font-medium ${r.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : r.status === 'cancelled' ? 'bg-red-100 text-red-700' : r.status === 'on_hold' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'}`}>
                    {r.status === 'on_hold' ? 'on hold' : r.status}
                  </span>
                </td>
                <td className="px-3 py-2.5 text-xs font-medium text-blue-700">
                  <span className="bg-blue-50 px-2 py-0.5 rounded border border-blue-200">{STAGE_LABEL[r.current_stage] || r.current_stage}</span>
                </td>
                <td className="px-3 py-2.5 text-center"><FiChevronRight className="inline text-gray-400" /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">No contractor bills found</td></tr>}
          </tbody>
        </NumberedTable>
      </div>

      {/* Itemized BOQ PO Bill Builder Modal */}
      <Modal isOpen={newModal} onClose={() => setNewModal(false)} title="New Contractor Bill (Linked to BOQ PO Items)">
        <form onSubmit={createBill} className="space-y-4 max-w-4xl max-h-[85vh] overflow-y-auto pr-1">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label text-xs font-semibold">Select Work Order *</label>
              <select
                className="select text-sm w-full"
                value={form.work_order_id}
                onChange={e => onSelectWorkOrder(e.target.value)}
                required
              >
                <option value="">-- Choose Work Order --</option>
                {workOrders.map(w => (
                  <option key={w.id} value={w.id}>
                    {w.wo_number} — {w.sub_contractor_name} {w.project_name ? `(${w.project_name})` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label text-xs font-semibold">Invoice Number</label>
              <input
                className="input text-sm w-full"
                placeholder="e.g. INV-2026-001"
                value={form.invoice_number}
                onChange={e => setForm(f => ({ ...f, invoice_number: e.target.value }))}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="label text-xs font-semibold flex items-center gap-1">
                <FiUpload size={13} /> Bill Scan / Invoice File Link
              </label>
              <input
                className="input text-sm w-full"
                placeholder="https://... or /uploads/bill.pdf"
                value={form.bill_file}
                onChange={e => setForm(f => ({ ...f, bill_file: e.target.value }))}
              />
            </div>
            <div>
              <label className="label text-xs font-semibold">Remarks / Work Notes</label>
              <input
                className="input text-sm w-full"
                placeholder="e.g. 1st Running Bill for Ground Floor Piping"
                value={form.remarks}
                onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))}
              />
            </div>
          </div>

          {/* BOQ PO Items Section */}
          <div className="border border-gray-200 rounded-lg p-3 bg-gray-50/60 space-y-2">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold uppercase text-gray-700 flex items-center gap-1.5">
                  <FiFileText size={14} className="text-red-600" /> Approved BOQ PO Items
                </h3>
                <p className="text-[11px] text-gray-500">Only approved PO-type BOQ line items are billable.</p>
              </div>
              <button
                type="button"
                onClick={addItemRow}
                className="btn btn-xs btn-secondary flex items-center gap-1 text-[11px]"
              >
                <FiPlus size={12} /> Add Item Row
              </button>
            </div>

            {loadingItems && (
              <div className="py-6 text-center text-xs text-gray-500 italic">
                Loading billable BOQ items for this work order…
              </div>
            )}

            {!loadingItems && form.work_order_id && billItems.length === 0 && (
              <div className="py-5 text-center text-xs text-gray-500 bg-white border border-dashed rounded p-3">
                No PO items linked to this work order yet. Click "+ Add Item Row" or enter a flat amount below.
              </div>
            )}

            {!loadingItems && billItems.length > 0 && (
              <div className="overflow-x-auto border border-gray-200 rounded bg-white">
                <table className="min-w-full text-xs divide-y divide-gray-200">
                  <thead className="bg-gray-100/80 text-gray-700 font-semibold">
                    <tr>
                      <th className="px-2 py-1.5 text-left w-6">#</th>
                      <th className="px-2 py-1.5 text-left min-w-[200px]">Item Description</th>
                      <th className="px-2 py-1.5 text-center w-16">UOM</th>
                      <th className="px-2 py-1.5 text-right w-16">BOQ Qty</th>
                      <th className="px-2 py-1.5 text-right w-16">Prev</th>
                      <th className="px-2 py-1.5 text-right w-16">Bal</th>
                      <th className="px-2 py-1.5 text-right w-24 font-bold text-indigo-700">This Bill Qty</th>
                      <th className="px-2 py-1.5 text-right w-20">Rate (₹)</th>
                      <th className="px-2 py-1.5 text-right w-24">Amount (₹)</th>
                      <th className="px-2 py-1.5 text-center w-10"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {billItems.map((it, idx) => {
                      const isOver = it.boq_qty > 0 && (Number(it.prev_billed_qty) + Number(it.current_billed_qty) > it.boq_qty);
                      return (
                        <tr key={idx} className={isOver ? 'bg-amber-50/70' : 'hover:bg-gray-50'}>
                          <td className="px-2 py-1.5 text-gray-400 font-mono text-[10px]">{idx + 1}</td>
                          <td className="px-2 py-1.5">
                            <input
                              className="w-full text-xs border border-transparent hover:border-gray-300 focus:border-red-400 rounded px-1 py-0.5 bg-transparent"
                              value={it.item_description}
                              onChange={e => updateItem(idx, 'item_description', e.target.value)}
                              placeholder="Description"
                            />
                            {it.item_code && <span className="text-[10px] text-gray-400 font-mono ml-1">({it.item_code})</span>}
                            {isOver && (
                              <div className="text-[10px] text-amber-700 font-medium flex items-center gap-1 mt-0.5">
                                <FiAlertTriangle size={11} /> Over BOQ by {(Number(it.prev_billed_qty) + Number(it.current_billed_qty) - it.boq_qty).toFixed(2)} {it.uom}
                              </div>
                            )}
                          </td>
                          <td className="px-2 py-1.5 text-center text-gray-500 font-mono">
                            <input
                              className="w-12 text-center text-xs border border-transparent hover:border-gray-300 rounded px-0.5 py-0.5 bg-transparent"
                              value={it.uom}
                              onChange={e => updateItem(idx, 'uom', e.target.value)}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right font-medium">{it.boq_qty}</td>
                          <td className="px-2 py-1.5 text-right text-gray-500">{it.prev_billed_qty}</td>
                          <td className="px-2 py-1.5 text-right text-gray-600">
                            <button
                              type="button"
                              onClick={() => fillRemaining(idx)}
                              title="Click to bill remaining balance"
                              className="hover:text-indigo-600 hover:underline cursor-pointer"
                            >
                              {it.balance_qty}
                            </button>
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              step="any"
                              min="0"
                              className="w-20 text-right text-xs border border-indigo-200 focus:border-indigo-500 rounded px-1.5 py-1 font-bold text-indigo-700 bg-indigo-50/40"
                              placeholder="0"
                              value={it.current_billed_qty}
                              onChange={e => updateItem(idx, 'current_billed_qty', e.target.value)}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right">
                            <input
                              type="number"
                              step="any"
                              min="0"
                              className="w-16 text-right text-xs border border-gray-200 focus:border-red-400 rounded px-1 py-1"
                              value={it.rate}
                              onChange={e => updateItem(idx, 'rate', e.target.value)}
                            />
                          </td>
                          <td className="px-2 py-1.5 text-right font-semibold text-gray-900">
                            ₹{Number(it.amount || 0).toLocaleString('en-IN')}
                          </td>
                          <td className="px-2 py-1.5 text-center">
                            <button
                              type="button"
                              onClick={() => removeItemRow(idx)}
                              className="text-gray-300 hover:text-red-500 p-0.5"
                              title="Remove item"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Financial Calculation Summary */}
          <div className="card p-3 bg-red-50/30 border border-red-100 rounded-lg space-y-2">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <div>
                <label className="text-gray-500 font-medium">Gross Amount</label>
                {billItems.length > 0 ? (
                  <div className="text-base font-bold text-gray-800">{money(effectiveGross)}</div>
                ) : (
                  <input
                    type="number"
                    min="0"
                    className="input text-sm mt-1"
                    placeholder="Enter Gross"
                    value={form.gross_amount}
                    onChange={e => setForm(f => ({ ...f, gross_amount: e.target.value }))}
                    required
                  />
                )}
              </div>
              <div>
                <label className="text-gray-500 font-medium">GST ({form.gst_pct}%)</label>
                <div className="flex items-center gap-1 mt-1">
                  <input
                    type="number"
                    className="input text-xs w-14"
                    value={form.gst_pct}
                    onChange={e => setForm(f => ({ ...f, gst_pct: e.target.value }))}
                  />
                  <span className="text-xs font-semibold text-gray-700">+{money(gstAmount)}</span>
                </div>
              </div>
              <div>
                <label className="text-gray-500 font-medium">TDS ({form.tds_pct}%)</label>
                <div className="flex items-center gap-1 mt-1">
                  <input
                    type="number"
                    className="input text-xs w-14"
                    value={form.tds_pct}
                    onChange={e => setForm(f => ({ ...f, tds_pct: e.target.value }))}
                  />
                  <span className="text-xs font-semibold text-red-600">-{money(tdsAmount)}</span>
                </div>
              </div>
              <div>
                <label className="text-gray-500 font-medium">Net Payable</label>
                <div className="text-base font-bold text-emerald-700 mt-1">{money(netAmount)}</div>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setNewModal(false)} className="btn">Cancel</button>
            <button type="submit" disabled={submitting} className="btn btn-primary flex items-center gap-1.5">
              <FiCheck size={14} /> Submit Bill to Site Engineer
            </button>
          </div>
        </form>
      </Modal>

      <BillDrawer billId={drawerBill} onClose={() => setDrawerBill(null)} onChanged={load} canApprove={canApprove} />
    </div>
  );
}

// ─── Bill Drawer with Itemized Details & Verification Actions ───────────
function BillDrawer({ billId, onClose, onChanged, canApprove }) {
  const [bill, setBill] = useState(null);
  const [action, setAction] = useState({
    remarks: '',
    measurement_notes: '',
    quantity_verified: '',
    gst_verified: false,
    tax_verified: false,
    previous_payment_verified: false,
    payment_mode: '',
    transaction_id: ''
  });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!billId) return;
    api.get(`/bill-verification/bills/${billId}`)
      .then(r => setBill(r.data))
      .catch(() => toast.error('Could not load bill'));
  }, [billId]);

  useEffect(() => { load(); }, [load]);
  if (!billId) return null;

  // The active stage waiting for approval
  const currentActingStage = bill?.current_stage === 'contractor_uploaded' ? 'site_engineer' : bill?.current_stage;

  const act = async (actionType) => {
    if (actionType === 'rejected' && !action.remarks.trim()) return toast.error('A reason is required to reject');
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/action`, { action: actionType, ...action });
      toast.success(actionType === 'verified' ? 'Bill verified & advanced' : actionType === 'rejected' ? 'Bill rejected' : 'Sent back to contractor');
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Action failed');
    } finally {
      setBusy(false);
    }
  };

  const hold = async () => {
    if (!action.remarks.trim()) return toast.error('A reason is required to hold a bill');
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/hold`, { reason: action.remarks });
      toast.success('Bill put on hold');
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not hold bill');
    } finally {
      setBusy(false);
    }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/resume`, {});
      toast.success('Bill resumed');
      onChanged?.();
      onClose();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not resume bill');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30">
      <div className="bg-white h-full w-full sm:w-[540px] shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <div>
            <h3 className="text-base font-semibold">{bill?.ra_no}</h3>
            <p className="text-xs text-gray-500">{bill?.contractor_name || bill?.sub_contractor_name} — {bill?.project_name}</p>
          </div>
          <div className="flex items-center gap-1">
            {billId && (
              <a href={`/bill-print/${billId}`} target="_blank" rel="noreferrer" className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500" title="Print / Save as PDF">
                <FiPrinter size={18} />
              </a>
            )}
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><FiX size={20} /></button>
          </div>
        </div>

        {bill && (
          <div className="p-4 space-y-4">
            {/* 4-Stage Progress Pills */}
            <div className="flex flex-wrap gap-1">
              {STAGES.map((s, i) => {
                const activeIdx = STAGES.indexOf(currentActingStage);
                const isDone = bill.status === 'paid' || i < activeIdx;
                const isCurrent = bill.status !== 'paid' && i === activeIdx;
                return (
                  <span key={s} className={`text-[10px] px-2 py-0.5 rounded font-medium ${
                    isDone ? 'bg-emerald-100 text-emerald-700' :
                    isCurrent ? 'bg-blue-100 text-blue-700 ring-1 ring-blue-400' :
                    'bg-gray-100 text-gray-400'
                  }`}>
                    {STAGE_LABEL[s]}
                  </span>
                );
              })}
            </div>

            {/* Financial Overview Card */}
            <div className="card p-3 bg-gray-50 grid grid-cols-2 gap-2 text-sm border border-gray-200">
              <div><div className="text-xs text-gray-500">Gross Amount</div><div className="font-semibold">{money(bill.gross_amount)}</div></div>
              <div><div className="text-xs text-gray-500">Net Payable</div><div className="font-bold text-emerald-700">{money(bill.net_amount)}</div></div>
              <div><div className="text-xs text-gray-500">Status</div><div className="capitalize font-medium">{bill.status === 'on_hold' ? 'On Hold' : bill.status}</div></div>
              <div><div className="text-xs text-gray-500">Invoice #</div><div className="font-mono text-xs">{bill.invoice_number || '—'}</div></div>
              <div><div className="text-xs text-gray-500">Work Order</div><div className="font-mono text-xs">{bill.wo_number || '—'}</div></div>
              <div><div className="text-xs text-gray-500">Current Stage</div><div className="font-semibold text-blue-700">{STAGE_LABEL[bill.current_stage] || bill.current_stage}</div></div>
            </div>

            {/* Bill File attachment preview if present */}
            {bill.bill_file && (
              <div className="p-2.5 bg-blue-50/70 border border-blue-200 rounded-lg flex items-center justify-between text-xs">
                <div className="flex items-center gap-1.5 text-blue-800">
                  <FiFileText size={16} />
                  <span className="font-medium">Attached Invoice / Bill Scan</span>
                </div>
                <a
                  href={bill.bill_file}
                  target="_blank"
                  rel="noreferrer"
                  className="btn btn-xs btn-primary flex items-center gap-1 text-[11px]"
                >
                  <FiExternalLink size={12} /> View File
                </a>
              </div>
            )}

            {/* On Hold Banner */}
            {bill.status === 'on_hold' && (
              <div className="card p-3 space-y-2 border border-slate-300 bg-slate-50">
                <h4 className="text-sm font-semibold flex items-center gap-1.5"><FiPause size={14} /> On Hold — {STAGE_LABEL[bill.current_stage]}</h4>
                <p className="text-xs text-gray-600">"{bill.hold_reason}" — {bill.held_by_name}, {bill.held_at ? new Date(bill.held_at).toLocaleString('en-IN') : ''}</p>
                {canApprove('bill_verification') && (
                  <button disabled={busy} onClick={resume} className="btn btn-primary text-xs flex items-center gap-1 justify-center w-full">
                    <FiPlay size={13} /> Resume Bill
                  </button>
                )}
              </div>
            )}

            {/* Itemized BOQ PO Items Breakdown */}
            {bill.items?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1.5 flex items-center justify-between">
                  <span>Billed Items ({bill.items.length})</span>
                  <span className="text-[10px] font-normal text-gray-500">Linked strictly to PO</span>
                </h4>
                <div className="border border-gray-200 rounded-lg overflow-x-auto text-xs bg-white">
                  <table className="min-w-full divide-y divide-gray-200">
                    <thead className="bg-gray-50 text-gray-600">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Item Description</th>
                        <th className="px-2 py-1.5 text-center">UOM</th>
                        <th className="px-2 py-1.5 text-right">BOQ</th>
                        <th className="px-2 py-1.5 text-right">Prev</th>
                        <th className="px-2 py-1.5 text-right font-bold text-indigo-700">This Bill</th>
                        <th className="px-2 py-1.5 text-right">Rate</th>
                        <th className="px-2 py-1.5 text-right font-semibold">Amount</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {bill.items.map((it, idx) => {
                        const isOver = Number(it.boq_qty) > 0 && (Number(it.prev_billed_qty) + Number(it.current_billed_qty) > Number(it.boq_qty));
                        return (
                          <tr key={it.id || idx} className={isOver ? 'bg-amber-50/70' : ''}>
                            <td className="px-2 py-1.5 max-w-[150px] truncate" title={it.item_description}>
                              <div className="font-medium text-gray-800">{it.item_description}</div>
                              {it.item_code && <div className="text-[10px] text-gray-400 font-mono">{it.item_code}</div>}
                              {isOver && <div className="text-[10px] text-amber-700 font-semibold">⚠️ Exceeds BOQ</div>}
                            </td>
                            <td className="px-2 py-1.5 text-center text-gray-500 font-mono">{it.uom}</td>
                            <td className="px-2 py-1.5 text-right">{it.boq_qty}</td>
                            <td className="px-2 py-1.5 text-right text-gray-500">{it.prev_billed_qty}</td>
                            <td className="px-2 py-1.5 text-right font-bold text-indigo-700">{it.current_billed_qty}</td>
                            <td className="px-2 py-1.5 text-right">₹{Number(it.rate).toLocaleString('en-IN')}</td>
                            <td className="px-2 py-1.5 text-right font-semibold text-gray-900">₹{Number(it.amount).toLocaleString('en-IN')}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* Deductions Breakdown */}
            {bill.deductions?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1">Deductions</h4>
                <div className="border border-gray-100 rounded p-2 bg-gray-50 space-y-1">
                  {bill.deductions.map(d => (
                    <div key={d.id} className="text-xs flex justify-between">
                      <span className="text-gray-600">{d.label} ({d.pct}%)</span>
                      <span className="font-medium">{money(d.amount)}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Stage Action Approval Box */}
            {bill.status === 'raised' && currentActingStage && canApprove('bill_verification') && (
              <div className="card p-3 space-y-3 border border-red-200 bg-red-50/20 rounded-lg">
                <h4 className="text-sm font-semibold flex items-center gap-1.5 text-red-800">
                  <FiCheck size={15} /> Action at: {STAGE_LABEL[currentActingStage]}
                </h4>

                {currentActingStage === 'site_engineer' && (
                  <div className="space-y-2">
                    <div>
                      <label className="label text-xs font-medium">Measurement Notes / Work Verified</label>
                      <input
                        className="input text-xs"
                        placeholder="e.g. Physical verification completed at 2nd floor"
                        value={action.measurement_notes}
                        onChange={e => setAction(a => ({ ...a, measurement_notes: e.target.value }))}
                      />
                    </div>
                    <div>
                      <label className="label text-xs font-medium">Verified Quantity</label>
                      <input
                        type="number"
                        className="input text-xs"
                        placeholder="Total quantity checked"
                        value={action.quantity_verified}
                        onChange={e => setAction(a => ({ ...a, quantity_verified: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                {currentActingStage === 'finance' && (
                  <div className="space-y-2 text-sm bg-white p-2.5 rounded border border-gray-200">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={action.gst_verified}
                        onChange={e => setAction(a => ({ ...a, gst_verified: e.target.checked }))}
                      />
                      <span>GST Compliance & Portal 2B Verified</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={action.tax_verified}
                        onChange={e => setAction(a => ({ ...a, tax_verified: e.target.checked }))}
                      />
                      <span>TDS Deductions & Tax Invoices Validated</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={action.previous_payment_verified}
                        onChange={e => setAction(a => ({ ...a, previous_payment_verified: e.target.checked }))}
                      />
                      <span>Previous Cumulative Payments Checked</span>
                    </label>
                  </div>
                )}

                {currentActingStage === 'payment' && (
                  <div className="space-y-2">
                    <div>
                      <label className="label text-xs font-medium">Payment Mode *</label>
                      <select
                        className="select text-xs"
                        value={action.payment_mode}
                        onChange={e => setAction(a => ({ ...a, payment_mode: e.target.value }))}
                      >
                        <option value="">Select Mode</option>
                        <option>Bank Transfer (NEFT/RTGS)</option>
                        <option>Cheque</option>
                        <option>UPI</option>
                        <option>Cash</option>
                      </select>
                    </div>
                    <div>
                      <label className="label text-xs font-medium">Transaction / UTR Reference</label>
                      <input
                        className="input text-xs"
                        placeholder="e.g. UTR293849102"
                        value={action.transaction_id}
                        onChange={e => setAction(a => ({ ...a, transaction_id: e.target.value }))}
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="label text-xs">Remarks <span className="text-gray-400 font-normal">(required for Reject or Hold)</span></label>
                  <input
                    className="input text-xs"
                    placeholder="Enter approval or rejection comments"
                    value={action.remarks}
                    onChange={e => setAction(a => ({ ...a, remarks: e.target.value }))}
                  />
                </div>

                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button
                    disabled={busy}
                    onClick={() => act('verified')}
                    className="btn btn-primary text-xs flex items-center gap-1 justify-center col-span-2 py-2"
                  >
                    <FiCheck size={14} /> {currentActingStage === 'payment' ? 'Release Payment' : 'Verify & Advance to Next Stage'}
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => act('sent_back')}
                    className="btn btn-secondary text-xs flex items-center gap-1 justify-center"
                  >
                    <FiCornerUpLeft size={13} /> Send Back
                  </button>
                  <button
                    disabled={busy}
                    onClick={hold}
                    className="btn btn-secondary text-xs flex items-center gap-1 justify-center"
                  >
                    <FiPause size={13} /> Put on Hold
                  </button>
                  <button
                    disabled={busy}
                    onClick={() => act('rejected')}
                    className="btn btn-secondary text-xs flex items-center gap-1 justify-center text-red-600 col-span-2"
                  >
                    <FiX size={13} /> Reject Bill
                  </button>
                </div>
              </div>
            )}

            {/* Stage Audit Log */}
            <div>
              <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1">Stage Log</h4>
              <div className="space-y-1.5">
                {bill.stage_log?.map(l => (
                  <div key={l.id} className="text-xs border-b border-gray-100 py-1.5">
                    <span className="font-semibold text-gray-800">{STAGE_LABEL[l.stage] || l.stage}</span> — <span className="capitalize font-medium text-gray-700">{l.action}</span> by {l.acted_by_name} <span className="text-gray-400">({new Date(l.acted_at).toLocaleString('en-IN')})</span>
                    {l.remarks && <div className="text-gray-600 italic mt-0.5">"{l.remarks}"</div>}
                    {l.measurement_notes && <div className="text-gray-500 text-[11px] mt-0.5">📐 Notes: {l.measurement_notes}</div>}
                  </div>
                ))}
                {(!bill.stage_log || bill.stage_log.length === 0) && <div className="text-xs text-gray-400 py-1">No approval actions logged yet</div>}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Vendor Ledger ────────────────────────────────────────────────────
function LedgerTab() {
  const [contractors, setContractors] = useState([]);
  const [contractorId, setContractorId] = useState('');
  const [data, setData] = useState(null);

  useEffect(() => { api.get('/sub-contractors').then(r => setContractors(r.data || [])).catch(() => setContractors([])); }, []);
  useEffect(() => {
    if (!contractorId) return setData(null);
    api.get(`/bill-verification/vendor-ledger/contractor/${contractorId}`).then(r => setData(r.data)).catch(() => toast.error('Could not load ledger'));
  }, [contractorId]);

  return (
    <div className="space-y-3">
      <div className="card p-3">
        <label className="label text-xs">Contractor</label>
        <select className="select" value={contractorId} onChange={e => setContractorId(e.target.value)}>
          <option value="">Select contractor</option>
          {contractors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </div>
      {data && (
        <>
          <div className="card p-3 bg-emerald-50 border border-emerald-200">
            <div className="text-xs text-gray-500">Balance Due</div>
            <div className="text-xl font-semibold text-emerald-700">{money(data.balance_due)}</div>
          </div>
          <div className="card p-0 overflow-x-auto">
            <NumberedTable className="min-w-full text-sm">
              <thead><tr className="bg-gray-50 text-xs text-gray-600">
                <th className="px-3 py-2 text-left">Date</th>
                <th className="px-3 py-2 text-left">Bill</th>
                <th className="px-3 py-2 text-left">Type</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2 text-right">Running Balance</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-100">
                {data.rows.map(r => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 text-xs">{new Date(r.created_at).toLocaleDateString('en-IN')}</td>
                    <td className="px-3 py-2 font-mono text-xs">{r.ra_no || '—'}</td>
                    <td className="px-3 py-2 text-xs capitalize">{r.entry_type}{r.remarks ? ` — ${r.remarks}` : ''}</td>
                    <td className="px-3 py-2 text-right">{r.entry_type === 'bill' ? money(r.amount) : `-${money(r.amount)}`}</td>
                    <td className="px-3 py-2 text-right font-medium">{money(r.running_balance)}</td>
                  </tr>
                ))}
              </tbody>
            </NumberedTable>
          </div>
        </>
      )}
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────
function DashboardTab() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/bill-verification/reports/dashboard').then(r => setData(r.data)).catch(() => {}); }, []);
  if (!data) return <div className="text-gray-400 text-sm">Loading…</div>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="card p-4"><div className="text-xs text-gray-500">Bills in Chain</div><div className="text-2xl font-semibold">{data.cards.bills_in_chain}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Paid This Month</div><div className="text-2xl font-semibold text-emerald-700">{money(data.cards.paid_this_month)}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Rejected This Month</div><div className="text-2xl font-semibold text-red-600">{data.cards.rejected_this_month}</div></div>
        <div className="card p-4"><div className="text-xs text-gray-500">Total Outstanding</div><div className="text-2xl font-semibold">{money(data.cards.total_outstanding)}</div></div>
      </div>
      <div className="card p-0 overflow-x-auto">
        <h3 className="text-sm font-medium px-4 pt-4">Bills Awaiting Verification, by Stage</h3>
        <NumberedTable className="min-w-full mt-2 text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600"><th className="px-3 py-2 text-left">Stage</th><th className="px-3 py-2 text-right">Bills</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {data.by_stage.map(s => <tr key={s.stage}><td className="px-3 py-2">{s.label}</td><td className="px-3 py-2 text-right">{s.bills}</td><td className="px-3 py-2 text-right">{money(s.amount)}</td></tr>)}
            {data.by_stage.length === 0 && <tr><td colSpan={3} className="text-center py-6 text-gray-400">Nothing pending</td></tr>}
          </tbody>
        </NumberedTable>
      </div>
    </div>
  );
}
