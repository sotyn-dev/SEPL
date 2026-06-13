import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTrash2, FiCheckCircle, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

const TYPE_LABEL = { 1: 'Type 1 · Sales Order', 2: 'Type 2 · Material Delivery', 3: 'Type 3 · Installation', 4: 'Type 4 · Final' };
const fmt = n => '₹' + Math.round(+n || 0).toLocaleString('en-IN');

export default function SalesBilling() {
  const { canDelete } = useAuth();
  const [bills, setBills] = useState([]);
  const [loading, setLoading] = useState(true);
  const [modal, setModal] = useState(false);
  const [orders, setOrders] = useState([]);
  const [orderId, setOrderId] = useState('');
  const [order, setOrder] = useState(null);          // detail {order, items, bills, next_type}
  const [form, setForm] = useState({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
  const [saving, setSaving] = useState(false);
  const [payModal, setPayModal] = useState(null);   // the Type-4 bill being paid
  const [payForm, setPayForm] = useState({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' });

  const load = () => {
    api.get('/sales-billing').then(r => setBills(r.data || [])).catch(() => setBills([])).finally(() => setLoading(false));
  };
  useEffect(() => { load(); }, []);

  const openNew = () => {
    setOrderId(''); setOrder(null);
    setForm({ bill_date: new Date().toISOString().split('T')[0], amount: '', gst_rate: 18, reference_doc_no: '' });
    api.get('/sales-billing/orders').then(r => setOrders(r.data || [])).catch(() => setOrders([]));
    setModal(true);
  };

  const pickOrder = (id) => {
    setOrderId(id);
    setOrder(null);
    if (!id) return;
    api.get(`/sales-billing/orders/${id}`).then(r => {
      setOrder(r.data);
      // Type 4 (Final) auto-sums the prior bills (mam's rule) — pre-fill the
      // amount with the sum of Type 1+2+3 pre-GST amounts; she adds commissioning.
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
    if (!nextType) return toast.error('All 4 bills already exist for this order');
    if (amount <= 0) return toast.error('Enter the bill amount');
    setSaving(true);
    try {
      const items = (order?.items || []).map(it => ({
        description: it.description, qty_ordered: it.quantity, unit: it.unit, rate: it.rate, amount: it.amount,
      }));
      const r = await api.post('/sales-billing', {
        business_book_id: orderId, bill_type: nextType,
        bill_date: form.bill_date, amount, gst_rate: gstRate,
        reference_doc_no: form.reference_doc_no, items,
      });
      toast.success(r.data.message || 'Bill created');
      setModal(false); load();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to create bill');
    } finally { setSaving(false); }
  };

  const approve = async (b) => {
    try {
      const next = b.approval_status === 'approved' ? 'draft' : 'approved';
      await api.put(`/sales-billing/${b.id}/approve`, { approval_status: next });
      toast.success(next === 'approved' ? 'Approved' : 'Reverted to draft');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const del = async (b) => {
    if (!confirm(`Delete bill ${b.bill_number}?`)) return;
    try { await api.delete(`/sales-billing/${b.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const openPay = (b) => {
    setPayForm({ amount: '', payment_date: new Date().toISOString().split('T')[0], payment_mode: 'Bank', transaction_ref: '' });
    setPayModal(b);
  };
  const savePay = async () => {
    if (!payModal) return;
    if ((+payForm.amount || 0) <= 0) return toast.error('Enter the payment amount');
    try {
      const r = await api.post(`/sales-billing/${payModal.id}/payment`, payForm);
      toast.success(r.data.message || 'Payment recorded');
      setPayModal(null); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <div>
          <h3 className="font-semibold text-lg">Sales Billing</h3>
          <p className="text-xs text-gray-500">4 sequential bills per order: Sales Order → Material Delivery → Installation → Final. Payment is taken against the Final bill.</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('sales-bills',
            ['Bill No', 'Type', 'Customer', 'Project', 'Date', 'Amount', 'GST', 'Total', 'Status', 'Approval'],
            bills.map(b => [b.bill_number, TYPE_LABEL[b.bill_type], b.customer_name, b.project_name, b.bill_date, b.amount, b.gst_amount, b.total_amount, b.bill_status, b.approval_status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          <button onClick={openNew} className="btn btn-primary flex items-center gap-2"><FiPlus /> New Sales Bill</button>
        </div>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="text-sm w-full">
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
              <th className="px-3 py-2 text-center">Approval</th>
              <th className="px-3 py-2 text-center">Payment</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan="12" className="text-center py-8 text-gray-400">Loading…</td></tr>
            ) : bills.length === 0 ? (
              <tr><td colSpan="12" className="text-center py-8 text-gray-400">No sales bills yet. Click “New Sales Bill” to create a Type 1 from a Business Book order.</td></tr>
            ) : bills.map(b => (
              <tr key={b.id} className="border-t border-gray-100 hover:bg-blue-50/40">
                <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{b.bill_number}</td>
                <td className="px-3 py-2 text-xs whitespace-nowrap">{TYPE_LABEL[b.bill_type] || b.bill_type}</td>
                <td className="px-3 py-2">{b.customer_name || '-'}</td>
                <td className="px-3 py-2 text-gray-500">{b.project_name || '-'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{b.bill_date}</td>
                <td className="px-3 py-2 text-right">{fmt(b.amount)}</td>
                <td className="px-3 py-2 text-right text-gray-500">{fmt(b.gst_amount)}<span className="text-[10px] ml-0.5">@{b.gst_rate}%</span></td>
                <td className="px-3 py-2 text-right font-semibold text-emerald-700">{fmt(b.total_amount)}</td>
                <td className="px-3 py-2 text-center"><span className="text-[10px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 whitespace-nowrap">{b.bill_status}</span></td>
                <td className="px-3 py-2 text-center">
                  <button onClick={() => approve(b)} className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${b.approval_status === 'approved' ? 'bg-emerald-100 text-emerald-700' : 'bg-amber-100 text-amber-700 hover:bg-amber-200'}`}>
                    {b.approval_status === 'approved' ? '✓ Approved' : 'Approve'}
                  </button>
                </td>
                <td className="px-3 py-2 text-center">
                  {b.bill_type === 4 ? (
                    <div className="flex flex-col items-center gap-0.5">
                      <span className={`text-[10px] px-2 py-0.5 rounded-full whitespace-nowrap ${b.payment_status === 'paid' ? 'bg-emerald-100 text-emerald-700' : b.payment_status === 'partial' ? 'bg-amber-100 text-amber-700' : 'bg-rose-100 text-rose-700'}`}>
                        {b.payment_status === 'paid' ? 'Paid' : b.payment_status === 'partial' ? 'Partial' : 'Unpaid'}
                      </span>
                      {b.received_amount > 0 && <span className="text-[10px] text-gray-400">{fmt(b.received_amount)} / {fmt(b.total_amount)}</span>}
                      {b.approval_status === 'approved' && b.payment_status !== 'paid' && (
                        <button onClick={() => openPay(b)} className="text-[10px] text-blue-600 hover:underline">+ Payment</button>
                      )}
                    </div>
                  ) : <span className="text-gray-300 text-xs">—</span>}
                </td>
                <td className="px-3 py-2 text-right">
                  {canDelete && canDelete('installation') && (
                    <button onClick={() => del(b)} className="text-gray-300 hover:text-red-500" title="Delete"><FiTrash2 size={14} /></button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title="New Sales Bill">
        <div className="space-y-3">
          <div>
            <label className="label">Order → Planning project <span className="text-[10px] font-normal text-gray-400">(★ = in Planning, shown first)</span></label>
            <select className="select w-full" value={orderId} onChange={e => pickOrder(e.target.value)}>
              <option value="">Select an order…</option>
              {orders.map(o => (
                <option key={o.id} value={o.id}>
                  {o.status === 'planning' ? '★ ' : ''}{o.lead_no || ('BB#' + o.id)} — {o.customer_name || 'No name'}{o.project_name ? ` · ${o.project_name}` : ''}{o.po_amount ? ` (${fmt(o.po_amount)})` : ''}{o.status ? ` · ${o.status}` : ''}
                </option>
              ))}
            </select>
          </div>

          {order && (
            <>
              <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
                <div><b>Customer:</b> {order.order.customer_name || '-'}</div>
                <div><b>Project:</b> {order.order.project_name || '-'}</div>
                <div><b>Order value:</b> {fmt(order.order.sale_amount_without_gst || order.order.po_amount)} {order.order.sale_amount_without_gst ? '(without GST)' : ''}</div>
                {order.bills.length > 0 && (
                  <div><b>Bills so far:</b> {order.bills.map(x => `T${x.bill_type}`).join(', ')}</div>
                )}
              </div>

              {nextType ? (
                <div className="text-sm font-semibold text-blue-700 bg-blue-50 rounded-lg px-3 py-2">
                  Next bill: {TYPE_LABEL[nextType]}
                  {nextType === 4 && (
                    <div className="text-[11px] font-normal text-gray-600 mt-1">
                      Amount pre-filled with the sum of bills {order.bills.map(x => `T${x.bill_type}`).join('+')} (₹{Math.round(order.bills.reduce((s, b) => s + (+b.amount || 0), 0)).toLocaleString('en-IN')}). Add commissioning charges on top — it's editable.
                    </div>
                  )}
                </div>
              ) : (
                <div className="text-sm font-semibold text-gray-500 bg-gray-100 rounded-lg px-3 py-2">
                  All 4 bills already exist for this order.
                </div>
              )}

              {order.items.length > 0 && (
                <div className="max-h-32 overflow-y-auto border border-gray-100 rounded-lg">
                  <table className="text-[11px] w-full">
                    <thead><tr className="bg-gray-50 text-gray-500"><th className="px-2 py-1 text-left">Item</th><th className="px-2 py-1 text-right">Qty</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-right">Amount</th></tr></thead>
                    <tbody>
                      {order.items.map(it => (
                        <tr key={it.id} className="border-t border-gray-50">
                          <td className="px-2 py-1">{it.description}</td>
                          <td className="px-2 py-1 text-right">{it.quantity} {it.unit}</td>
                          <td className="px-2 py-1 text-right">{fmt(it.rate)}</td>
                          <td className="px-2 py-1 text-right">{fmt(it.amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {nextType && (
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="label">Bill date</label>
                    <input type="date" className="input w-full" value={form.bill_date} onChange={e => setForm({ ...form, bill_date: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Reference doc no. (optional)</label>
                    <input className="input w-full" placeholder="SO / DC / DPR no." value={form.reference_doc_no} onChange={e => setForm({ ...form, reference_doc_no: e.target.value })} />
                  </div>
                  <div>
                    <label className="label">Amount (without GST)</label>
                    <input type="number" min="0" className="input w-full text-right" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} placeholder="0" />
                  </div>
                  <div>
                    <label className="label">GST %</label>
                    <input type="number" min="0" max="100" className="input w-full text-right" value={form.gst_rate} onChange={e => setForm({ ...form, gst_rate: e.target.value })} />
                  </div>
                  <div className="col-span-2 flex justify-between text-sm border-t border-gray-100 pt-2">
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

      <Modal isOpen={!!payModal} onClose={() => setPayModal(null)} title={payModal ? `Record Payment · ${payModal.bill_number}` : 'Record Payment'}>
        {payModal && (
          <div className="space-y-3">
            <div className="bg-gray-50 rounded-lg p-3 text-xs space-y-1">
              <div><b>Customer:</b> {payModal.customer_name}</div>
              <div><b>Final bill total:</b> {fmt(payModal.total_amount)}</div>
              <div><b>Received so far:</b> {fmt(payModal.received_amount)} · <b>Outstanding:</b> {fmt((payModal.total_amount || 0) - (payModal.received_amount || 0))}</div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">Amount received</label>
                <input type="number" min="0" className="input w-full text-right" value={payForm.amount} onChange={e => setPayForm({ ...payForm, amount: e.target.value })} placeholder="0" />
              </div>
              <div>
                <label className="label">Date</label>
                <input type="date" className="input w-full" value={payForm.payment_date} onChange={e => setPayForm({ ...payForm, payment_date: e.target.value })} />
              </div>
              <div>
                <label className="label">Mode</label>
                <select className="select w-full" value={payForm.payment_mode} onChange={e => setPayForm({ ...payForm, payment_mode: e.target.value })}>
                  {['Bank', 'Cash', 'UPI', 'Cheque', 'NEFT/RTGS'].map(m => <option key={m} value={m}>{m}</option>)}
                </select>
              </div>
              <div>
                <label className="label">Reference no. (optional)</label>
                <input className="input w-full" value={payForm.transaction_ref} onChange={e => setPayForm({ ...payForm, transaction_ref: e.target.value })} placeholder="UTR / cheque no." />
              </div>
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
