import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import ResponsibilityTab from '../components/ResponsibilityTab';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiCheckCircle, FiDownload, FiGrid, FiFileText, FiPackage, FiClipboard, FiPrinter, FiUsers, FiChevronDown, FiChevronRight, FiCalendar } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import Pagination, { usePagination } from '../components/PaginationBar';
import { useUrlTab } from '../hooks/useUrlTab';

const TYPE_LABEL = { 1: 'Type 1 · Sales Order', 2: 'Type 2 · Material Delivery', 3: 'Type 3 · Installation', 4: 'Type 4 · Final' };
const fmt = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');

const TABS = [
  { id: 'dashboard', label: 'Dashboard', icon: FiGrid },
  { id: 'orders', label: 'Sales Order Bills', icon: FiFileText },
  { id: 'material', label: 'Material · PO vs Bill', icon: FiPackage },
  { id: 'dpr', label: 'DPR / Installation Bills', icon: FiClipboard },
  { id: 'responsible', label: 'Responsible', icon: FiUsers },
];

export default function SalesBilling() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useUrlTab(['dashboard', 'orders', 'material', 'dpr', 'responsible'], 'dashboard');
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [orders, setOrders] = useState([]);
  const [pending, setPending] = useState(null);        // { orders_without_so:[], dpr_ready:{count,value} }
  const [material, setMaterial] = useState([]);        // dispatch challans + sales-bill status

  const [modal, setModal] = useState(false);
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState(null);
  const [form, setForm] = useState({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
  const [saving, setSaving] = useState(false);
  const [payModal, setPayModal] = useState(null);
  const [payForm, setPayForm] = useState({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' });

  // DPR Installation Billing Selection Modal
  const [installModal, setInstallModal] = useState(false);
  const [unbilledOrders, setUnbilledOrders] = useState([]);
  const [loadingUnbilled, setLoadingUnbilled] = useState(false);
  const [selectedDprIds, setSelectedDprIds] = useState(new Set());
  const [expandedOrders, setExpandedOrders] = useState(new Set());
  const [installBillDate, setInstallBillDate] = useState(new Date().toISOString().split('T')[0]);
  const [generatingInstall, setGeneratingInstall] = useState(false);

  const load = () => {
    api.get('/sales-billing').then(r => setBills(r.data || [])).catch(() => setBills([])).finally(() => setLoading(false));
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    api.get('/sales-billing/pending').then(r => setPending(r.data)).catch(() => setPending(null));
    api.get('/sales-billing/material').then(r => setMaterial(r.data || [])).catch(() => setMaterial([]));
  };
  useEffect(() => { load(); }, []);

  const genSalesBill = async (challanId) => {
    try {
      const r = await api.post(`/procurement/delivery-notes/${challanId}/generate-sales-bill`, {});
      toast.success(r.data?.existing ? 'Sales bill already exists' : 'Sales bill generated');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const openNewFor = (oid) => {
    setForm({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    setModal(true);
    if (oid) pickOrder(String(oid));
  };

  // ── create ───────────────────────────────────────────────────────
  const openNew = () => {
    setOrderId(''); setOrder(null);
    setForm({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    setModal(true);
  };
  const pickOrder = (id) => {
    setOrderId(id); setOrder(null);
    if (!id) return;
    api.get(`/sales-billing/orders/${id}`).then(r => {
      setOrder(r.data);
      if (r.data.next_type === 4) {
        const priorSum = (r.data.bills || []).reduce((s, b) => s + (+b.amount || 0), 0);
        if (priorSum) setForm(f => ({ ...f, amount: String(priorSum) }));
      }
    }).catch(() => toast.error('Could not load order'));
  };
  const amount = +form.amount || 0;
  const gstRate = +form.gst_rate || 0;
  const gstAmount = Math.round(amount * gstRate) / 100;
  const total = Math.round((amount + gstAmount) * 100) / 100;
  const nextType = order?.next_type || null;
  const save = async () => {
    if (!orderId) return toast.error('Pick an order');
    if (!nextType) return toast.error('All bills already exist for this order');
    if (amount <= 0) return toast.error('Enter the bill amount');
    setSaving(true);
    try {
      const items = (order?.items || []).map(it => ({ description: it.description, qty_ordered: it.quantity, unit: it.unit, rate: it.rate, amount: it.amount }));
      const r = await api.post('/sales-billing', { business_book_id: orderId, bill_type: nextType, bill_date: form.bill_date, amount, gst_rate: gstRate, reference_doc_no: form.reference_doc_no, items });
      toast.success(r.data.message || 'Bill created');
      setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed to create bill'); }
    finally { setSaving(false); }
  };

  const approve = async (b) => {
    try {
      const next = b.approval_status === 'approved' ? 'draft' : 'approved';
      await api.put(`/sales-billing/${b.id}/approve`, { approval_status: next });
      toast.success(next === 'approved' ? 'Approved' : 'Reverted to draft'); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  // Open the printable TAX INVOICE (auth-protected HTML → blob → new tab).
  const printBill = async (b) => {
    try {
      const r = await api.get(`/sales-billing/${b.id}/print`, { responseType: 'arraybuffer' });
      window.open(URL.createObjectURL(new Blob([r.data], { type: 'text/html;charset=utf-8' })), '_blank');
    } catch { toast.error('Could not open the invoice'); }
  };
  const del = async (b) => {
    if (!confirm(`Delete bill ${b.bill_number}?`)) return;
    try { await api.delete(`/sales-billing/${b.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const openInstallModal = async () => {
    setInstallBillDate(new Date().toISOString().split('T')[0]);
    setInstallModal(true);
    setLoadingUnbilled(true);
    try {
      const r = await api.get('/sales-billing/unbilled-dprs');
      const data = r.data || [];
      setUnbilledOrders(data);
      const allIds = [];
      const allBbs = [];
      data.forEach(o => {
        allBbs.push(o.business_book_id);
        (o.dprs || []).forEach(d => allIds.push(d.dpr_id));
      });
      setSelectedDprIds(new Set(allIds));
      setExpandedOrders(new Set(allBbs));
    } catch (e) {
      toast.error('Could not load unbilled DPRs');
      setUnbilledOrders([]);
    } finally {
      setLoadingUnbilled(false);
    }
  };

  const toggleDpr = (id) => {
    setSelectedDprIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleOrderDprs = (order) => {
    const orderDprIds = (order.dprs || []).map(d => d.dpr_id);
    const allSelected = orderDprIds.length > 0 && orderDprIds.every(id => selectedDprIds.has(id));
    setSelectedDprIds(prev => {
      const next = new Set(prev);
      if (allSelected) {
        orderDprIds.forEach(id => next.delete(id));
      } else {
        orderDprIds.forEach(id => next.add(id));
      }
      return next;
    });
  };

  const toggleExpandOrder = (bbId) => {
    setExpandedOrders(prev => {
      const next = new Set(prev);
      if (next.has(bbId)) next.delete(bbId);
      else next.add(bbId);
      return next;
    });
  };

  const selectAllDprs = () => {
    const allIds = [];
    unbilledOrders.forEach(o => (o.dprs || []).forEach(d => allIds.push(d.dpr_id)));
    setSelectedDprIds(new Set(allIds));
  };

  const deselectAllDprs = () => {
    setSelectedDprIds(new Set());
  };

  const submitInstallBills = async () => {
    if (selectedDprIds.size === 0) return toast.error('Select at least one DPR to generate installation bills');
    setGeneratingInstall(true);
    try {
      const r = await api.post('/sales-billing/generate-installation', {
        dpr_ids: Array.from(selectedDprIds),
        checked: true,
        bill_date: installBillDate
      });
      toast.success(r.data.message || 'Installation bills generated');
      setInstallModal(false);
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to generate installation bills');
    } finally {
      setGeneratingInstall(false);
    }
  };

  const sendToClient = async (b) => {
    try { const r = await api.put(`/sales-billing/${b.id}/sent`, {}); toast.success(r.data.message || 'Updated'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const checkBill = async (b) => {
    try { await api.put(`/sales-billing/${b.id}/checked`, {}); toast.success('Checked / OK'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Could not record check'); }
  };

  const openPay = (b) => { setPayForm({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' }); setPayModal(b); };
  const savePay = async () => {
    if (!payModal) return;
    if ((+payForm.amount || 0) <= 0) return toast.error('Enter the payment amount');
    try { const r = await api.post(`/sales-billing/${payModal.id}/payment`, payForm); toast.success(r.data.message || 'Payment recorded'); setPayModal(null); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  // ── derived ──────────────────────────────────────────────────────
  const billedByOrder = bills.reduce((m, b) => { m[b.business_book_id] = (m[b.business_book_id] || 0) + (+b.total_amount || 0); return m; }, {});
  const t1 = bills.filter(b => b.bill_type === 1);
  const t3 = bills.filter(b => b.bill_type === 3);
  const t4 = bills.filter(b => b.bill_type === 4);
  const orderBills = bills.filter(b => b.bill_type === 1 || b.bill_type === 4);
  const totalBilled = bills.reduce((s, b) => s + (+b.total_amount || 0), 0);
  const received = t4.reduce((s, b) => s + (+b.received_amount || 0), 0);
  const outstanding = t4.reduce((s, b) => s + ((+b.total_amount || 0) - (+b.received_amount || 0)), 0);

  // Numbered pagination — one hook per major list (hooks live here, NOT in
  // BillTable: it's re-created each render so its state would reset).
  // Export keeps using the FULL list for the ACTIVE tab (never pageItems).
  const billsPager = usePagination(bills);        // Dashboard — all bills
  const t3Pager = usePagination(t3);              // DPR / installation bills
  const ordersPager = usePagination(orders);      // Sales Order Bills tab
  const materialPager = usePagination(material);  // Material · PO vs Bill tab

  // Selected statistics for the Install Modal
  const selectedStats = (() => {
    let orderCount = 0;
    let totalTaxable = 0;
    for (const o of unbilledOrders) {
      const selectedInOrder = (o.dprs || []).filter(d => selectedDprIds.has(d.dpr_id));
      if (selectedInOrder.length > 0) {
        orderCount++;
        const workVal = selectedInOrder.reduce((s, d) => s + (+d.work_value || 0), 0);
        const pct = o.inst_pct > 0 ? o.inst_pct : 100;
        const billAmt = Math.round((workVal * pct) / 100 * 100) / 100;
        totalTaxable += billAmt;
      }
    }
    const gst = Math.round(totalTaxable * 18) / 100;
    const total = Math.round((totalTaxable + gst) * 100) / 100;
    return {
      dprCount: selectedDprIds.size,
      orderCount,
      totalTaxable,
      gst,
      total
    };
  })();

  const StatusCell = (b) => (
    <span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 whitespace-nowrap">{b.bill_status}</span>
  );
  const ApprovalCell = (b) => (
    <button onClick={() => approve(b)} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${b.approval_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}>
      {b.approval_status === 'approved' ? '✓ Approved' : 'Approve'}
    </button>
  );

  const BillTable = ({ rows, showPayment, sentMode, pager }) => (<>
    <div className="card p-0 overflow-x-auto">
      <table className="text-sm w-full min-w-[850px]">
        <thead>
          <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
            <th className="px-3 py-2 text-left">Bill No</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Customer</th>
            <th className="px-3 py-2 text-left">Project</th>
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-right">Amount</th>
            <th className="px-3 py-2 text-right">GST</th>
            <th className="px-3 py-2 text-right">Total</th>
            <th className="px-3 py-2 text-center">Status</th>
            {sentMode && <th className="px-3 py-2 text-center">Checked / OK</th>}
            <th className="px-3 py-2 text-center">{sentMode ? 'Sent to Client' : 'Approval'}</th>
            {showPayment && <th className="px-3 py-2 text-center">Payment</th>}
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {loading ? (
            <tr><td colSpan={11 + Number(!!showPayment) + Number(!!sentMode)} className="text-center py-8 text-gray-400">Loading…</td></tr>
          ) : rows.length === 0 ? (
            <tr><td colSpan={11 + Number(!!showPayment) + Number(!!sentMode)} className="text-center py-8 text-gray-400">No bills here yet.</td></tr>
          ) : rows.map(b => (
            <tr key={b.id} className="border-t border-gray-100 hover:bg-blue-50/40">
              <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{b.bill_number}</td>
              <td className="px-3 py-2 text-xs whitespace-nowrap">{TYPE_LABEL[b.bill_type] || b.bill_type}</td>
              <td className="px-3 py-2">{b.customer_name || '-'}</td>
              <td className="px-3 py-2 text-gray-500">{b.project_name || '-'}</td>
              <td className="px-3 py-2 whitespace-nowrap">{b.bill_date}</td>
              <td className="px-3 py-2 text-right">{fmt(b.amount)}</td>
              <td className="px-3 py-2 text-right text-gray-500">{fmt(b.gst_amount)}<span className="text-[10px] ml-0.5">@{b.gst_rate}%</span></td>
              <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(b.total_amount)}</td>
              <td className="px-3 py-2 text-center">{StatusCell(b)}</td>
              {sentMode && <td className="px-3 py-2 text-center">
                {b.checked_at
                  ? <span className="text-xs text-emerald-700 whitespace-nowrap" title={`Checked ${b.checked_at}`}>✓ Checked / OK</span>
                  : <button onClick={() => checkBill(b)} className="btn btn-secondary text-xs whitespace-nowrap">Checked / OK</button>}
              </td>}
              <td className="px-3 py-2 text-center">
                {sentMode ? (
                  <button disabled={!b.checked_at && !b.sent_to_client} title={!b.checked_at && !b.sent_to_client ? 'Mark Checked / OK first' : undefined} onClick={() => sendToClient(b)} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full disabled:opacity-40 disabled:cursor-not-allowed ${b.sent_to_client ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700 hover:bg-blue-200'}`}>
                    {b.sent_to_client ? '✓ Sent to client' : 'Sent to client'}
                  </button>
                ) : ApprovalCell(b)}
              </td>
              {showPayment && (
                <td className="px-3 py-2 text-center">
                  {b.bill_type === 4 ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${b.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : b.payment_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                        {b.payment_status === 'paid' ? 'Paid' : b.payment_status === 'partial' ? 'Partial' : 'Unpaid'}
                      </span>
                      {b.received_amount > 0 && <span className="text-[10px] text-gray-400">{fmt(b.received_amount)} / {fmt(b.total_amount)}</span>}
                      {b.approval_status === 'approved' && b.payment_status !== 'paid' && <button onClick={() => openPay(b)} className="text-[10px] text-blue-600 hover:underline">+ Payment</button>}
                    </div>
                  ) : <span className="text-gray-300 text-xs">—</span>}
                </td>
              )}
              <td className="px-3 py-2 text-right whitespace-nowrap">
                <button onClick={() => printBill(b)} className="text-gray-400 hover:text-blue-700 mr-2" title="Print Tax Invoice (PDF)"><FiPrinter size={14} /></button>
                {canDelete && canDelete('installation') && <button onClick={() => del(b)} className="text-gray-300 hover:text-red-500" title="Delete"><FiTrash2 size={14} /></button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {pager && <Pagination {...pager} />}
  </>);

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <h3 className="font-semibold text-lg">Sales Billing</h3>
        <div className="flex gap-2">
          {tab === 'dpr' && <button onClick={openInstallModal} className="btn btn-secondary flex items-center gap-2" title="Check completed, approved DPRs to create their bills"><FiCheckCircle /> Check DPRs & Create Bills</button>}
          {(tab === 'orders' || tab === 'dashboard') && <button onClick={openNew} className="btn btn-primary flex items-center gap-2"><FiPlus /> New Sales Bill</button>}
          {tab !== 'responsible' && <button onClick={() => {
            // Export what the ACTIVE tab actually shows — each tab is a different
            // dataset (all bills / orders / challans / Type-3), never the raw `bills`.
            if (tab === 'dashboard') exportCsv('sales-bills', ['Bill No', 'Type', 'Customer', 'Project', 'Date', 'Amount', 'GST', 'Total', 'Status', 'Approval'],
              bills.map(b => [b.bill_number, TYPE_LABEL[b.bill_type], b.customer_name, b.project_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.bill_status, b.approval_status]));
            if (tab === 'dpr') exportCsv('installation-bills', ['Bill No', 'Type', 'Customer', 'Project', 'Date', 'Amount', 'GST', 'Total', 'Status', 'Sent to Client'],
              t3.map(b => [b.bill_number, TYPE_LABEL[b.bill_type], b.customer_name, b.project_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.bill_status, b.sent_to_client ? 'Yes' : 'No']));
            if (tab === 'orders') exportCsv('sales-order-bills', ['Order', 'Customer', 'Project', 'Order Value', 'SO Bill No', 'SO Total', 'SO Approval', 'Final Bill No', 'Final Total', 'Final Payment'],
              orders.map(o => {
                const so = bills.find(b => b.business_book_id === o.id && b.bill_type === 1);
                const final = bills.find(b => b.business_book_id === o.id && b.bill_type === 4);
                return [(o.status === 'planning' ? '★ ' : '') + (o.lead_no || ('BB#' + o.id)), o.customer_name, o.project_name, (+o.po_amount || +o.sale_amount_without_gst || 0),
                  so?.bill_number || '', so?.total_amount || '', so?.approval_status || '', final?.bill_number || '', final?.total_amount || '', final?.payment_status || ''];
              }));
            if (tab === 'material') exportCsv('material-po-vs-bill', ['Indent', 'Challan', 'Site', 'Date', 'Source', 'Items', 'Value', 'Sales Bill', 'Sales Bill No'],
              material.map(m => [m.indent_number, m.challan_no, m.site_name, m.date, m.source, m.item_count || 0, m.value, m.sales_bill_status, m.sales_bill_number]));
          }} className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export</button>}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 overflow-x-auto pb-1.5 scrollbar-none sm:flex-wrap">
        {TABS.map(t => {
          const Icon = t.icon;
          return (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-3 py-1.5 rounded-full text-sm font-medium flex items-center gap-1.5 ${tab === t.id ? 'bg-blue-600 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              <Icon size={14} /> {t.label}
            </button>
          );
        })}
      </div>

      {/* DASHBOARD */}
      {tab === 'dashboard' && (
        <div className="space-y-4">
          {/* Auto pendency alerts — what still needs billing */}
          {pending && (pending.orders_without_so.length > 0 || pending.dpr_ready.count > 0) ? (
            <div className="space-y-2">
              {pending.orders_without_so.length > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-semibold text-amber-800">⚠ {pending.orders_without_so.length} order(s) have NO Sales Order bill yet</span>
                    <span className="text-[11px] text-amber-600">don't forget to bill these</span>
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {pending.orders_without_so.slice(0, 12).map(o => (
                      <button key={o.id} onClick={() => openNewFor(o.id)}
                        className="text-[11px] bg-white border border-amber-200 rounded-full px-2 py-0.5 hover:bg-amber-100"
                        title={`${o.customer_name} · ${o.project_name || ''} · ${fmt(o.value)} · ${o.status}`}>
                        {o.lead_no || ('BB#' + o.id)} · {o.customer_name || 'order'} <span className="text-amber-600">+ bill</span>
                      </button>
                    ))}
                    {pending.orders_without_so.length > 12 && <span className="text-[11px] text-amber-600 self-center">+{pending.orders_without_so.length - 12} more</span>}
                  </div>
                </div>
              )}
              {pending.dpr_ready.count > 0 && (
                <div className="bg-indigo-50 border border-indigo-200 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                  <span className="text-sm font-semibold text-indigo-800">⚠ {pending.dpr_ready.count} approved DPR(s) ready to bill (≈ {fmt(pending.dpr_ready.value)}) — not billed yet</span>
                  <button onClick={openInstallModal} className="btn btn-primary text-xs">Generate Installation Bills</button>
                </div>
              )}
            </div>
          ) : (
            <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm font-semibold text-emerald-700">✓ All caught up — no orders or DPRs pending a bill.</div>
          )}

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {[
              { label: 'Total Bills', value: bills.length, sub: `${t1.length} SO · ${t3.length} install · ${t4.length} final`, ring: 'bg-slate-100 text-slate-700' },
              { label: 'Total Billed', value: fmt(totalBilled), sub: 'incl. GST', ring: 'bg-blue-100 text-blue-700' },
              { label: 'Received', value: fmt(received), sub: 'against final bills', ring: 'bg-emerald-100 text-emerald-700' },
              { label: 'Outstanding', value: fmt(outstanding), sub: 'to collect', ring: 'bg-rose-100 text-rose-700' },
            ].map((c, i) => (
              <div key={i} className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
                <div className="text-[11px] uppercase tracking-wide text-gray-400 font-semibold">{c.label}</div>
                <div className={`text-2xl font-bold leading-tight mt-1 ${c.ring.split(' ')[1]}`}>{c.value}</div>
                <div className="text-[10px] text-gray-400 mt-0.5">{c.sub}</div>
              </div>
            ))}
          </div>
          <div className="text-xs text-gray-500 bg-blue-50 border border-blue-100 rounded-lg px-4 py-2.5">
            Flow per order: <b>Sales Order (T1)</b> → <b>Material delivery (T2, billed in Dispatch)</b> → <b>Installation (T3, auto from DPRs)</b> → <b>Final (T4)</b>. Payment is taken against the Final bill.
          </div>
          <BillTable rows={billsPager.pageItems} pager={billsPager} showPayment />
        </div>
      )}

      {/* SALES ORDER BILLS — order-centric: every Business Book order IS a
          sales order; show its Type-1 bill status (create if missing) + Final. */}
      {tab === 'orders' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            Your <b>orders from Business Book</b> are the sales orders. Raise the <b>Sales Order bill</b> against each, then the Final bill. ★ = in Planning.
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead>
                <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 text-left">Order</th>
                  <th className="px-3 py-2 text-left">Customer</th>
                  <th className="px-3 py-2 text-left">Project</th>
                  <th className="px-3 py-2 text-right">Order value</th>
                  <th className="px-3 py-2 text-left">Sales Order bill</th>
                  <th className="px-3 py-2 text-left">Final bill / payment</th>
                </tr>
              </thead>
              <tbody>
                {orders.length === 0 ? (
                  <tr><td colSpan="6" className="text-center py-8 text-gray-400">No orders found in Business Book.</td></tr>
                ) : ordersPager.pageItems.map(o => {
                  const so = bills.find(b => b.business_book_id === o.id && b.bill_type === 1);
                  const final = bills.find(b => b.business_book_id === o.id && b.bill_type === 4);
                  const val = +o.po_amount || +o.sale_amount_without_gst || 0;
                  return (
                    <tr key={o.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                      <td className="px-3 py-2 font-medium whitespace-nowrap">{o.status === 'planning' ? '★ ' : ''}{o.lead_no || ('BB#' + o.id)}</td>
                      <td className="px-3 py-2">{o.customer_name || '-'}</td>
                      <td className="px-3 py-2 text-gray-500">{o.project_name || '-'}</td>
                      <td className="px-3 py-2 text-right">{fmt(val)}</td>
                      <td className="px-3 py-2">
                        {so ? (
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-gray-700">{so.bill_number}</span>
                            <span className="text-emerald-700">{fmt(so.total_amount)}</span>
                            {ApprovalCell(so)}
                          </div>
                        ) : (
                          <button onClick={() => openNewFor(o.id)} className="text-xs text-white bg-blue-600 hover:bg-blue-700 rounded-full px-3 py-1 flex items-center gap-1"><FiPlus size={12} /> Create Sales Order bill</button>
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {final ? (
                          <div className="flex items-center gap-2">
                            <span className="text-emerald-700">{fmt(final.total_amount)}</span>
                            <span className={`text-[10px] px-2 py-0.5 rounded-full ${final.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : final.payment_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>{final.payment_status === 'paid' ? 'Paid' : final.payment_status === 'partial' ? 'Partial' : 'Unpaid'}</span>
                            {final.approval_status === 'approved' && final.payment_status !== 'paid' && <button onClick={() => openPay(final)} className="text-[11px] text-blue-600 hover:underline">+ Payment</button>}
                          </div>
                        ) : so ? <span className="text-gray-300 text-xs">after installation</span> : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <Pagination {...ordersPager} />
        </div>
      )}

      {/* MATERIAL — dispatch challans by indent, sales-bill done/pending */}
      {tab === 'material' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            Each material dispatch (challan, by <b>indent number</b>) and whether its client <b>Sales Bill</b> is done or pending. Generating the bill uses the Dispatch flow.
            {material.length > 0 && <span className="ml-1 text-rose-600 font-semibold">{material.filter(m => m.sales_bill_status === 'pending').length} pending</span>}
          </div>
          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full min-w-[700px]">
              <thead>
                <tr className="bg-gray-50 text-[11px] uppercase tracking-wide text-gray-500">
                  <th className="px-3 py-2 text-left">Indent</th>
                  <th className="px-3 py-2 text-left">Challan</th>
                  <th className="px-3 py-2 text-left">Site</th>
                  <th className="px-3 py-2 text-left">Date</th>
                  <th className="px-3 py-2 text-left">Source</th>
                  <th className="px-3 py-2 text-right">Items</th>
                  <th className="px-3 py-2 text-right">Value</th>
                  <th className="px-3 py-2 text-left">Sales Bill</th>
                </tr>
              </thead>
              <tbody>
                {material.length === 0 ? (
                  <tr><td colSpan="8" className="text-center py-8 text-gray-400">No material dispatches yet. Challans raised in Dispatch will appear here.</td></tr>
                ) : materialPager.pageItems.map(m => (
                  <tr key={m.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                    <td className="px-3 py-2 font-medium whitespace-nowrap">{m.indent_number || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{m.challan_no || '-'}</td>
                    <td className="px-3 py-2 text-gray-500">{m.site_name || '-'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{m.date || '-'}</td>
                    <td className="px-3 py-2 text-xs uppercase text-gray-400">{m.source || '-'}</td>
                    <td className="px-3 py-2 text-right">{m.item_count || 0}</td>
                    <td className="px-3 py-2 text-right" title={m.boq_value ? `${m.delivery_pct}% of BOQ ${fmt(m.boq_value)}` : 'No BOQ rate matched for this challan'}>
                      {fmt(m.value)}{m.delivery_pct ? <span className="text-[9px] text-gray-400 ml-0.5">@{m.delivery_pct}%</span> : null}
                    </td>
                    <td className="px-3 py-2">
                      {m.sales_bill_status === 'done' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">✓ {m.sales_bill_number || 'Done'}</span>
                          {m.sales_bill_file && <a href={m.sales_bill_file} target="_blank" rel="noopener noreferrer" className="text-[11px] text-blue-600 hover:underline">📎 PDF</a>}
                        </div>
                      ) : m.sales_bill_status === 'pending' ? (
                        <div className="flex items-center gap-2">
                          <span className="text-[11px] px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">Pending</span>
                          <button onClick={() => genSalesBill(m.id)} className="text-[11px] text-blue-600 hover:underline">Generate</button>
                        </div>
                      ) : <span className="text-gray-300 text-xs">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Pagination {...materialPager} />
        </div>
      )}

      {/* DPR / INSTALLATION BILLS (Type 3) */}
      {tab === 'dpr' && (
        <div className="space-y-2">
          <div className="text-xs text-gray-500 bg-gray-50 border border-gray-100 rounded-lg px-4 py-2">
            <b>Done</b> → <b>Checked / OK</b> → Bill created → <b>Sent to Client</b>. Check completed, approved DPRs to create their bills automatically. Each DPR is billed once.
          </div>
          <BillTable rows={t3Pager.pageItems} pager={t3Pager} showPayment={false} sentMode />
        </div>
      )}

      {tab === 'responsible' && <ResponsibilityTab module="sales_billing" title="Sales Billing" />}

      {/* Selective Installation Bills Modal */}
      <Modal isOpen={installModal} onClose={() => !generatingInstall && setInstallModal(false)} title="Check DPRs & Create Bills" xwide>
        <div className="space-y-4">
          <div className="text-xs text-gray-600 bg-blue-50/70 border border-blue-200 rounded-lg p-3 leading-relaxed">
            Review the selected completed DPRs and amounts. Click <b>Checked / OK</b> to record your check and automatically create their bills. Sending to the client remains a separate step.
          </div>

          {/* Controls toolbar */}
          <div className="flex flex-wrap items-center justify-between gap-3 bg-gray-50 border border-gray-200 rounded-xl p-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-gray-700 flex items-center gap-1">
                <FiCalendar className="text-gray-500" /> Bill Date:
              </label>
              <input
                type="date"
                className="input text-xs py-1 px-2 border-gray-300 rounded"
                value={installBillDate}
                onChange={e => setInstallBillDate(e.target.value)}
              />
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={selectAllDprs}
                className="text-xs bg-white border border-gray-300 hover:bg-gray-100 rounded px-2.5 py-1 font-medium text-gray-700"
              >
                Select All
              </button>
              <button
                type="button"
                onClick={deselectAllDprs}
                className="text-xs bg-white border border-gray-300 hover:bg-gray-100 rounded px-2.5 py-1 font-medium text-gray-700"
              >
                Deselect All
              </button>
            </div>
          </div>

          {/* List of unbilled orders & DPRs */}
          {loadingUnbilled ? (
            <div className="py-12 text-center text-gray-400 text-sm">Loading approved unbilled DPRs…</div>
          ) : unbilledOrders.length === 0 ? (
            <div className="py-12 text-center text-gray-500 bg-gray-50 rounded-xl border border-gray-200 text-sm">
              ✓ No approved, unbilled DPRs pending billing right now.
            </div>
          ) : (
            <div className="space-y-3 max-h-[50vh] overflow-y-auto pr-1">
              {unbilledOrders.map(order => {
                const orderDprs = order.dprs || [];
                const selectedInOrder = orderDprs.filter(d => selectedDprIds.has(d.dpr_id));
                const allSelected = orderDprs.length > 0 && selectedInOrder.length === orderDprs.length;
                const someSelected = selectedInOrder.length > 0 && !allSelected;
                const isExpanded = expandedOrders.has(order.business_book_id);

                const selectedWorkVal = selectedInOrder.reduce((s, d) => s + (+d.work_value || 0), 0);
                const selectedBillAmt = Math.round((selectedWorkVal * (order.inst_pct || 0)) / 100 * 100) / 100;

                return (
                  <div key={order.business_book_id} className="border border-gray-200 rounded-xl overflow-hidden bg-white shadow-sm">
                    {/* Order header row */}
                    <div className="flex items-center justify-between p-3 bg-gray-50/80 hover:bg-gray-100/80 border-b border-gray-200 gap-2">
                      <div className="flex items-center gap-2.5 flex-1 min-w-0">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          ref={el => { if (el) el.indeterminate = someSelected; }}
                          onChange={() => toggleOrderDprs(order)}
                          className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                        />
                        <div className="truncate">
                          <div className="text-sm font-bold text-gray-900 truncate">
                            {order.customer_name} <span className="text-gray-400 font-normal">· {order.project_name}</span>
                          </div>
                          <div className="text-[11px] text-gray-500 flex flex-wrap gap-x-2">
                            <span>Order: <b>{order.lead_no || ('BB#' + order.business_book_id)}</b></span>
                            <span>Installation %: <b>{order.inst_pct}%</b></span>
                            <span>{orderDprs.length} DPR(s) available</span>
                            {order.inst_pct === 0 && (
                              <span className="text-amber-600 font-semibold">(No install % configured in Business Book)</span>
                            )}
                          </div>
                        </div>
                      </div>

                      <div className="flex items-center gap-3">
                        <div className="text-right">
                          <div className="text-xs font-bold text-emerald-700">
                            {fmt(selectedBillAmt)}
                          </div>
                          <div className="text-[10px] text-gray-400">
                            {selectedInOrder.length}/{orderDprs.length} DPRs selected
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => toggleExpandOrder(order.business_book_id)}
                          className="p-1 text-gray-400 hover:text-gray-700 rounded"
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <FiChevronDown size={18} /> : <FiChevronRight size={18} />}
                        </button>
                      </div>
                    </div>

                    {/* DPR list table when expanded */}
                    {isExpanded && (
                      <div className="p-0 overflow-x-auto">
                        <table className="text-xs w-full">
                          <thead>
                            <tr className="bg-gray-100/50 text-[10px] uppercase tracking-wide text-gray-500 border-b border-gray-100">
                              <th className="w-8 px-3 py-2 text-center">Pick</th>
                              <th className="px-3 py-2 text-left">Date</th>
                              <th className="px-3 py-2 text-left">Site</th>
                              <th className="px-3 py-2 text-left">Shift / By</th>
                              <th className="px-3 py-2 text-right">Work Value (BOQ)</th>
                              <th className="px-3 py-2 text-right">Est. Bill ({order.inst_pct}%)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {orderDprs.map(dpr => {
                              const isChecked = selectedDprIds.has(dpr.dpr_id);
                              return (
                                <tr
                                  key={dpr.dpr_id}
                                  onClick={() => toggleDpr(dpr.dpr_id)}
                                  className={`border-b border-gray-50 cursor-pointer transition-colors ${isChecked ? 'bg-blue-50/40 hover:bg-blue-50/70' : 'hover:bg-gray-50 text-gray-500'}`}
                                >
                                  <td className="px-3 py-2 text-center" onClick={e => e.stopPropagation()}>
                                    <input
                                      type="checkbox"
                                      checked={isChecked}
                                      onChange={() => toggleDpr(dpr.dpr_id)}
                                      className="h-3.5 w-3.5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                                    />
                                  </td>
                                  <td className="px-3 py-2 font-medium whitespace-nowrap">{dpr.report_date}</td>
                                  <td className="px-3 py-2">{dpr.site_name || '-'}</td>
                                  <td className="px-3 py-2 text-gray-400 whitespace-nowrap">{dpr.shift || 'day'} · {dpr.submitted_by_name || '-'}</td>
                                  <td className="px-3 py-2 text-right font-medium">{fmt(dpr.work_value)}</td>
                                  <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(dpr.estimated_bill)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Bottom Summary & Actions */}
          <div className="border-t border-gray-200 pt-3 flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs">
              <span className="font-semibold text-gray-700">Selected: </span>
              <span className="text-blue-700 font-bold">{selectedStats.orderCount} Order(s)</span>,{' '}
              <span className="text-blue-700 font-bold">{selectedStats.dprCount} DPR(s)</span>
              <span className="mx-2 text-gray-300">|</span>
              <span className="text-gray-600">Taxable: <b>{fmt(selectedStats.totalTaxable)}</b></span>
              <span className="mx-1 text-gray-400">+ GST 18%: {fmt(selectedStats.gst)}</span>
              <span className="mx-1 text-gray-300">→</span>
              <span className="text-emerald-700 font-bold text-sm">Total: {fmt(selectedStats.total)}</span>
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setInstallModal(false)}
                className="btn btn-secondary text-xs"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={submitInstallBills}
                disabled={generatingInstall || selectedStats.dprCount === 0}
                className="btn btn-primary text-xs flex items-center gap-1.5"
              >
                <FiCheckCircle size={14} />
                {generatingInstall
                  ? 'Generating…'
                  : `Checked / OK — Create Bills (${selectedStats.orderCount})`}
              </button>
            </div>
          </div>
        </div>
      </Modal>

      {/* Create modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title="New Sales Bill">
        <div className="space-y-3">
          <div>
            <label className="label">Order → Planning project <span className="text-[10px] font-normal text-gray-400">(★ = in Planning, shown first)</span></label>
            <select className="select w-full" value={orderId} onChange={e => pickOrder(e.target.value)}>
              <option value="">Select an order…</option>
              {orders.map(o => (
                <option key={o.id} value={o.id}>{o.status === 'planning' ? '★ ' : ''}{o.lead_no || ('BB#' + o.id)} — {o.customer_name || 'No name'}{o.project_name ? ` · ${o.project_name}` : ''}{o.po_amount ? ` (${fmt(o.po_amount)})` : ''}{o.status ? ` · ${o.status}` : ''}</option>
              ))}
            </select>
          </div>
          {order && (
            <>
              <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                <div><b>Customer:</b> {order.order.customer_name || '-'}</div>
                <div><b>Project:</b> {order.order.project_name || '-'}</div>
                <div><b>Order value:</b> {fmt(order.order.sale_amount_without_gst || order.order.po_amount)} {order.order.sale_amount_without_gst ? '(without GST)' : ''}</div>
                {order.bills.length > 0 && <div><b>Bills so far:</b> {order.bills.map(x => `T${x.bill_type}`).join(', ')}</div>}
              </div>
              {nextType ? (
                <div className="text-sm font-semibold text-blue-700 bg-blue-50 rounded-lg px-3 py-2">
                  Next bill: {TYPE_LABEL[nextType]}
                  {nextType === 4 && <div className="text-[11px] font-normal text-gray-600 mt-1">Amount pre-filled with the sum of bills {order.bills.map(x => `T${x.bill_type}`).join('+')} (₹{Math.round(order.bills.reduce((s, b) => s + (+b.amount || 0), 0)).toLocaleString('en-IN')}). Add commissioning on top — editable.</div>}
                </div>
              ) : (
                <div className="text-sm font-semibold text-gray-500 bg-gray-100 rounded-lg px-3 py-2">All bills already exist for this order.</div>
              )}
              {order.items.length > 0 && (
                <div className="max-h-32 overflow-y-auto border border-gray-100 rounded-lg">
                  <table className="text-[11px] w-full">
                    <thead><tr className="bg-gray-50 text-gray-500"><th className="px-2 py-1 text-left">Item</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-right">Amount</th></tr></thead>
                    <tbody>
                      {order.items.map(it => (
                        <tr key={it.id} className="border-t border-gray-50"><td className="px-2 py-1">{it.description}</td><td className="px-2 py-1 text-right">{it.quantity} {it.unit}</td><td className="px-2 py-1 text-right">{fmt(it.rate)}</td><td className="px-2 py-1 text-right">{fmt(it.amount)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {nextType && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div><label className="label">Bill date</label><input type="date" className="input w-full" value={form.bill_date} onChange={e => setForm({ ...form, bill_date: e.target.value })} /></div>
                  <div><label className="label">Reference doc no. (optional)</label><input className="input w-full" placeholder="SO / DC / DPR no." value={form.reference_doc_no} onChange={e => setForm({ ...form, reference_doc_no: e.target.value })} /></div>
                  <div><label className="label">Amount (without GST)</label><input type="number" min="0" className="input w-full text-right" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" /></div>
                  <div><label className="label">GST %</label><input type="number" min="0" max="100" className="input w-full text-right" value={form.gst_rate} onChange={e => setForm({ ...form, gst_rate: e.target.value })} /></div>
                  <div className="col-span-1 sm:col-span-2 flex justify-between text-sm border-t border-gray-100 pt-2">
                    <span className="text-gray-500">GST {gstRate}% = {fmt(gstAmount)}</span>
                    <span className="font-bold text-emerald-700">Total {fmt(total)}</span>
                  </div>
                </div>
              )}
            </>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} disabled={saving || !nextType} className="btn btn-primary flex items-center gap-1"><FiCheckCircle /> {saving ? 'Saving…' : 'Create Bill'}</button>
          </div>
        </div>
      </Modal>

      {/* Payment modal */}
      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title={payModal ? `Record Payment · ${payModal.bill_number}` : 'Record Payment'}>
        {payModal && (
          <div className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <div><b>Customer:</b> {payModal.customer_name}</div>
              <div><b>Final bill total:</b> {fmt(payModal.total_amount)}</div>
              <div><b>Received so far:</b> {fmt(payModal.received_amount)} · <b>Outstanding:</b> {fmt((payModal.total_amount || 0) - (payModal.received_amount || 0))}</div>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div><label className="label">Amount received</label><input type="number" min="0" className="input w-full text-right" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} placeholder="0" /></div>
              <div><label className="label">Date</label><input type="date" className="input w-full" value={payForm.payment_date} onChange={e => setPayForm({ ...payForm, payment_date: e.target.value })} /></div>
              <div><label className="label">Mode</label><select className="select w-full" value={payForm.payment_mode} onChange={e => setPayForm({ ...payForm, payment_mode: e.target.value })}>{['Bank', 'Cash', 'UPI', 'Cheque', 'NEFT/RTGS'].map(m => <option key={m} value={m}>{m}</option>)}</select></div>
              <div><label className="label">Reference no. (optional)</label><input className="input w-full" value={payForm.transaction_ref} onChange={e => setPayForm({ ...payForm, transaction_ref: e.target.value })} placeholder="UTR / cheque no." /></div>
            </div>
            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => setPayModal(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={savePay} className="btn btn-primary flex items-center gap-1"><FiCheckCircle /> Record Payment</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
