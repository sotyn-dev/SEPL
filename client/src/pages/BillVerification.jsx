// Labour Management System — Modules 4-6: Bill Verification chain,
// Bills & Finance, Payments.
//
//   Bills           the 4-stage queue: Contractor Uploaded -> Site Engineer
//                   -> Finance -> Payment. Verify / Reject / Send Back / Hold per bill.
//   Vendor Ledger   per-contractor running balance (Module 6)
//   Dashboard       bills awaiting verification by stage, paid this month
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  FiFileText, FiDollarSign, FiTrendingUp, FiPlus, FiCheck, FiX, FiCornerUpLeft,
  FiChevronRight, FiPause, FiPlay, FiPrinter,
} from 'react-icons/fi';

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const STAGE_LABEL = {
  contractor_uploaded: 'Contractor Uploaded', site_engineer: 'Site Engineer',
  site_head: 'Site Head', project_manager: 'Project Manager',
  finance: 'Finance', accounts: 'Accounts', payment: 'Payment',
};
// Simplified 4-stage chain (2026-08): Contractor Upload -> Site Engineer -> Finance -> Payment.
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
        <p className="text-sm text-gray-500">Contractor bill → Site Engineer → Finance → Payment.</p>
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
  const [form, setForm] = useState({ work_order_id: '', invoice_number: '', gross_amount: '', gst_pct: '18', tds_pct: '2', remarks: '' });

  const load = useCallback(() => {
    api.get('/bill-verification/bills', { params: stageFilter ? { current_stage: stageFilter } : {} })
      .then(r => setRows(r.data || [])).catch(() => toast.error('Could not load bills'));
  }, [stageFilter]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/indent-labour-payment/active-work-orders').then(r => setWorkOrders(r.data || [])).catch(() => setWorkOrders([])); }, []);

  const createBill = async (e) => {
    e.preventDefault();
    if (!form.work_order_id) return toast.error('Work Order is required');
    const gross = Number(form.gross_amount) || 0;
    const gst = Math.round(gross * (Number(form.gst_pct) || 0) / 100);
    const tds = Math.round(gross * (Number(form.tds_pct) || 0) / 100);
    try {
      await api.post('/bill-verification/bills', {
        work_order_id: form.work_order_id, invoice_number: form.invoice_number,
        gross_amount: gross, remarks: form.remarks,
        deductions: [{ label: 'GST', pct: form.gst_pct, amount: gst }, { label: 'TDS', pct: form.tds_pct, amount: tds }],
      });
      toast.success('Bill uploaded');
      setNewModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not create bill'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="flex gap-1 flex-wrap">
          <button onClick={() => setStageFilter('')} className={`text-xs px-2 py-1 rounded border ${!stageFilter ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 text-gray-600'}`}>All</button>
          {STAGES.filter(s => s !== 'contractor_uploaded').map(s => (
            <button key={s} onClick={() => setStageFilter(s)} className={`text-xs px-2 py-1 rounded border ${stageFilter === s ? 'bg-red-600 text-white border-red-600' : 'border-gray-200 text-gray-600'}`}>{STAGE_LABEL[s]}</button>
          ))}
        </div>
        {canCreate('bill_verification') && <button onClick={() => { setForm({ work_order_id: '', invoice_number: '', gross_amount: '', gst_pct: '18', tds_pct: '2', remarks: '' }); setNewModal(true); }} className="btn btn-primary flex items-center gap-1 text-sm"><FiPlus size={14} /> New Bill</button>}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">RA No</th>
            <th className="px-3 py-2 text-left">Contractor</th>
            <th className="px-3 py-2 text-left">WO</th>
            <th className="px-3 py-2 text-right">Net Amount</th>
            <th className="px-3 py-2 text-center">Status</th>
            <th className="px-3 py-2 text-left">Stage</th>
            <th className="px-3 py-2 text-center">Action</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-red-50/30 cursor-pointer" onClick={() => setDrawerBill(r.id)}>
                <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{r.ra_no}</td>
                <td className="px-3 py-2">{r.contractor_name || r.sub_contractor_name || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.wo_number || '—'}</td>
                <td className="px-3 py-2 text-right">{money(r.net_amount)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.status === 'paid' ? 'bg-emerald-100 text-emerald-700' : r.status === 'cancelled' ? 'bg-red-100 text-red-700' : r.status === 'on_hold' ? 'bg-slate-200 text-slate-700' : 'bg-amber-100 text-amber-800'}`}>{r.status === 'on_hold' ? 'on hold' : r.status}</span>
                </td>
                <td className="px-3 py-2 text-xs">{STAGE_LABEL[r.current_stage] || r.current_stage}</td>
                <td className="px-3 py-2 text-center"><FiChevronRight className="inline text-gray-400" /></td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={7} className="text-center py-8 text-gray-400">No bills found</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={newModal} onClose={() => setNewModal(false)} title="New Contractor Bill">
        <form onSubmit={createBill} className="space-y-3">
          <div><label className="label">Work Order *</label>
            <select className="select" value={form.work_order_id} onChange={e => setForm(f => ({ ...f, work_order_id: e.target.value }))} required>
              <option value="">Select Work Order</option>
              {workOrders.map(w => <option key={w.id} value={w.id}>{w.wo_number} — {w.sub_contractor_name}</option>)}
            </select>
          </div>
          <div><label className="label">Invoice Number</label><input className="input" value={form.invoice_number} onChange={e => setForm(f => ({ ...f, invoice_number: e.target.value }))} /></div>
          <div><label className="label">Gross Amount *</label><input type="number" min="0" className="input" value={form.gross_amount} onChange={e => setForm(f => ({ ...f, gross_amount: e.target.value }))} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">GST %</label><input type="number" min="0" className="input" value={form.gst_pct} onChange={e => setForm(f => ({ ...f, gst_pct: e.target.value }))} /></div>
            <div><label className="label">TDS %</label><input type="number" min="0" className="input" value={form.tds_pct} onChange={e => setForm(f => ({ ...f, tds_pct: e.target.value }))} /></div>
          </div>
          <div><label className="label">Remarks</label><input className="input" value={form.remarks} onChange={e => setForm(f => ({ ...f, remarks: e.target.value }))} /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setNewModal(false)} className="btn">Cancel</button>
            <button type="submit" className="btn btn-primary">Upload Bill</button>
          </div>
        </form>
      </Modal>

      <BillDrawer billId={drawerBill} onClose={() => setDrawerBill(null)} onChanged={load} canApprove={canApprove} />
    </div>
  );
}

function BillDrawer({ billId, onClose, onChanged, canApprove }) {
  const [bill, setBill] = useState(null);
  const [action, setAction] = useState({ remarks: '', measurement_notes: '', quantity_verified: '', gst_verified: false, tax_verified: false, previous_payment_verified: false, payment_mode: '', transaction_id: '' });
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (!billId) return;
    api.get(`/bill-verification/bills/${billId}`).then(r => setBill(r.data)).catch(() => toast.error('Could not load bill'));
  }, [billId]);
  useEffect(() => { load(); }, [load]);
  if (!billId) return null;

  const nextStage = bill ? STAGES[bill.stage_index + 1] : null;

  const act = async (actionType) => {
    if (actionType === 'rejected' && !action.remarks.trim()) return toast.error('A reason is required to reject');
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/action`, { action: actionType, ...action });
      toast.success(actionType === 'verified' ? 'Advanced to next stage' : actionType === 'rejected' ? 'Bill rejected' : 'Sent back to contractor');
      onChanged?.(); onClose();
    } catch (e) { toast.error(e.response?.data?.error || 'Action failed'); }
    finally { setBusy(false); }
  };

  const hold = async () => {
    if (!action.remarks.trim()) return toast.error('A reason is required to hold a bill');
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/hold`, { reason: action.remarks });
      toast.success('Bill put on hold');
      onChanged?.(); onClose();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not hold bill'); }
    finally { setBusy(false); }
  };

  const resume = async () => {
    setBusy(true);
    try {
      await api.post(`/bill-verification/bills/${billId}/resume`, {});
      toast.success('Bill resumed');
      onChanged?.(); onClose();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not resume bill'); }
    finally { setBusy(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/30" onClick={onClose}>
      <div className="bg-white h-full w-full sm:w-[480px] shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b sticky top-0 bg-white z-10">
          <div><h3 className="text-base font-semibold">{bill?.ra_no}</h3><p className="text-xs text-gray-500">{bill?.contractor_name}</p></div>
          <div className="flex items-center gap-1">
            {billId && <a href={`/bill-print/${billId}`} target="_blank" rel="noreferrer" className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-500" title="Print / Save as PDF"><FiPrinter size={18} /></a>}
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><FiX size={20} /></button>
          </div>
        </div>
        {bill && (
          <div className="p-4 space-y-4">
            {/* Progress */}
            <div className="flex flex-wrap gap-1">
              {STAGES.map((s, i) => (
                <span key={s} className={`text-[10px] px-1.5 py-0.5 rounded ${i <= bill.stage_index ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-400'}`}>{STAGE_LABEL[s]}</span>
              ))}
            </div>

            <div className="card p-3 bg-gray-50 grid grid-cols-2 gap-2 text-sm">
              <div><div className="text-xs text-gray-500">Gross</div>{money(bill.gross_amount)}</div>
              <div><div className="text-xs text-gray-500">Net</div>{money(bill.net_amount)}</div>
              <div><div className="text-xs text-gray-500">Status</div>{bill.status === 'on_hold' ? 'on hold' : bill.status}</div>
              <div><div className="text-xs text-gray-500">Invoice #</div>{bill.invoice_number || '—'}</div>
            </div>

            {bill.status === 'on_hold' && (
              <div className="card p-3 space-y-2 border border-slate-300 bg-slate-50">
                <h4 className="text-sm font-semibold flex items-center gap-1.5"><FiPause size={14} /> On Hold — {STAGE_LABEL[bill.current_stage]}</h4>
                <p className="text-xs text-gray-600">"{bill.hold_reason}" — {bill.held_by_name}, {bill.held_at ? new Date(bill.held_at).toLocaleString('en-IN') : ''}</p>
                {canApprove('bill_verification') && (
                  <button disabled={busy} onClick={resume} className="btn btn-primary text-xs flex items-center gap-1 justify-center w-full">
                    <FiPlay size={13} /> Resume
                  </button>
                )}
              </div>
            )}

            {bill.deductions?.length > 0 && (
              <div>
                <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1">Deductions</h4>
                {bill.deductions.map(d => <div key={d.id} className="text-xs flex justify-between py-0.5"><span>{d.label} ({d.pct}%)</span><span>{money(d.amount)}</span></div>)}
              </div>
            )}

            {bill.status === 'raised' && nextStage && canApprove('bill_verification') && (
              <div className="card p-3 space-y-2 border border-red-200">
                <h4 className="text-sm font-semibold">Action at: {STAGE_LABEL[nextStage]}</h4>
                {nextStage === 'site_engineer' && (
                  <>
                    <div><label className="label text-xs">Measurement Notes</label><input className="input" value={action.measurement_notes} onChange={e => setAction(a => ({ ...a, measurement_notes: e.target.value }))} /></div>
                    <div><label className="label text-xs">Quantity Verified</label><input type="number" className="input" value={action.quantity_verified} onChange={e => setAction(a => ({ ...a, quantity_verified: e.target.value }))} /></div>
                  </>
                )}
                {nextStage === 'finance' && (
                  <div className="space-y-1 text-sm">
                    <label className="flex items-center gap-2"><input type="checkbox" checked={action.gst_verified} onChange={e => setAction(a => ({ ...a, gst_verified: e.target.checked }))} /> GST verified</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={action.tax_verified} onChange={e => setAction(a => ({ ...a, tax_verified: e.target.checked }))} /> Tax verified</label>
                    <label className="flex items-center gap-2"><input type="checkbox" checked={action.previous_payment_verified} onChange={e => setAction(a => ({ ...a, previous_payment_verified: e.target.checked }))} /> Previous payment checked</label>
                  </div>
                )}
                {nextStage === 'payment' && (
                  <>
                    <div><label className="label text-xs">Payment Mode</label>
                      <select className="select" value={action.payment_mode} onChange={e => setAction(a => ({ ...a, payment_mode: e.target.value }))}>
                        <option value="">Select</option>
                        <option>Bank Transfer</option><option>Cheque</option><option>UPI</option><option>Cash</option>
                      </select>
                    </div>
                    <div><label className="label text-xs">Transaction ID</label><input className="input" value={action.transaction_id} onChange={e => setAction(a => ({ ...a, transaction_id: e.target.value }))} /></div>
                  </>
                )}
                <div><label className="label text-xs">Remarks {' '}<span className="text-gray-400">(required for Reject or Hold)</span></label><input className="input" value={action.remarks} onChange={e => setAction(a => ({ ...a, remarks: e.target.value }))} /></div>
                <div className="grid grid-cols-2 gap-2 pt-1">
                  <button disabled={busy} onClick={() => act('verified')} className="btn btn-primary text-xs flex items-center gap-1 justify-center col-span-2"><FiCheck size={13} /> {nextStage === 'payment' ? 'Release' : 'Verify'}</button>
                  <button disabled={busy} onClick={() => act('sent_back')} className="btn btn-secondary text-xs flex items-center gap-1 justify-center"><FiCornerUpLeft size={13} /> Send Back</button>
                  <button disabled={busy} onClick={hold} className="btn btn-secondary text-xs flex items-center gap-1 justify-center"><FiPause size={13} /> Hold</button>
                  <button disabled={busy} onClick={() => act('rejected')} className="btn btn-secondary text-xs flex items-center gap-1 justify-center text-red-600 col-span-2"><FiX size={13} /> Reject</button>
                </div>
              </div>
            )}

            <div>
              <h4 className="text-xs font-semibold text-gray-600 uppercase mb-1">Stage Log</h4>
              {bill.stage_log?.map(l => (
                <div key={l.id} className="text-xs border-b border-gray-100 py-1.5">
                  <span className="font-medium">{STAGE_LABEL[l.stage]}</span> — {l.action} by {l.acted_by_name} <span className="text-gray-400">({new Date(l.acted_at).toLocaleString('en-IN')})</span>
                  {l.remarks && <div className="text-gray-500 italic">"{l.remarks}"</div>}
                </div>
              ))}
              {(!bill.stage_log || bill.stage_log.length === 0) && <div className="text-xs text-gray-400">No actions yet</div>}
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
            <table className="min-w-full text-sm">
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
            </table>
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
        <table className="min-w-full mt-2 text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600"><th className="px-3 py-2 text-left">Stage</th><th className="px-3 py-2 text-right">Bills</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
          <tbody className="divide-y divide-gray-100">
            {data.by_stage.map(s => <tr key={s.stage}><td className="px-3 py-2">{s.label}</td><td className="px-3 py-2 text-right">{s.bills}</td><td className="px-3 py-2 text-right">{money(s.amount)}</td></tr>)}
            {data.by_stage.length === 0 && <tr><td colSpan={3} className="text-center py-6 text-gray-400">Nothing pending</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
