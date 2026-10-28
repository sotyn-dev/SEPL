// SOP-17: Final Account & Retention Modal
// Owner: Finance Head — Parul Goyal
//
// S1: Final account made — booked value vs actual cost vs money received (Real profit finally visible)
// S2: Retention schedule made at handover, with due dates (Tracked money, not forgotten money)
// S3: Warranty period tracked; complaints closed before claiming retention (Site Engineer complaint log)
// S4: Retention due — claim raised on its own, into the same follow-up ladder as collection
// S5: Project's actual rates and usage go back into the Rate Master — next quote gets sharper

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiDollarSign, FiCheckCircle, FiAlertTriangle, FiClock, FiShield,
  FiTrendingUp, FiRefreshCw, FiCalendar, FiFileText, FiLock, FiUser,
  FiCheck, FiArrowRight, FiPlus, FiAlertCircle
} from 'react-icons/fi';
import { fmtDate } from '../utils/datetime';

export default function FinalAccountRetentionModal({ siteId, certId, onClose, onUpdated }) {
  const [activeTab, setActiveTab] = useState('s1'); // 's1' | 's2' | 's3' | 's4' | 's5'
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState(null);
  const [raci, setRaci] = useState(null);
  const [warrantyData, setWarrantyData] = useState(null);
  const [rateVariance, setRateVariance] = useState(null);

  // Action states
  const [finalizing, setFinalizing] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [syncingRates, setSyncingRates] = useState(false);
  const [newComplaintOpen, setNewComplaintOpen] = useState(false);
  const [complaintForm, setComplaintForm] = useState({
    problem_detail: '',
    category: 'Warranty / DLP Defect',
    priority: 'high',
  });
  const [savingComplaint, setSavingComplaint] = useState(false);

  const loadAll = useCallback(async () => {
    if (!siteId) return;
    setLoading(true);
    try {
      const [faRes, raciRes, warRes, rateRes] = await Promise.all([
        api.get(`/final-account/final-account/${siteId}`),
        api.get('/final-account/raci'),
        api.get(`/final-account/warranty-status/${siteId}`),
        api.get(`/final-account/rate-master-variance/${siteId}`),
      ]);
      setData(faRes.data);
      setRaci(raciRes.data);
      setWarrantyData(warRes.data);
      setRateVariance(rateRes.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load SOP-17 data');
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  // S1: Finalize Account
  const handleFinalize = async () => {
    if (!window.confirm('Finalize & freeze this project final account under SOP-17.1?\n\nRealized profit and margins will be locked into the financial ledger.')) return;
    setFinalizing(true);
    try {
      await api.post(`/final-account/finalize-account/${siteId}`, {
        notes: 'Final project account reviewed and approved by Finance Head (SOP-17.1)'
      });
      toast.success('Final account finalized and frozen (SOP-17.1)!');
      loadAll();
      if (onUpdated) onUpdated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to finalize account');
    } finally {
      setFinalizing(false);
    }
  };

  // S3: Log Warranty Complaint
  const handleSaveComplaint = async (e) => {
    e.preventDefault();
    if (!complaintForm.problem_detail.trim()) {
      toast.error('Problem detail is required');
      return;
    }
    setSavingComplaint(true);
    try {
      await api.post('/final-account/warranty-complaint', {
        site_id: siteId,
        ...complaintForm,
      });
      toast.success('Warranty complaint logged in Complaint Register (SOP-17.3)!');
      setNewComplaintOpen(false);
      setComplaintForm({ problem_detail: '', category: 'Warranty / DLP Defect', priority: 'high' });
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to log complaint');
    } finally {
      setSavingComplaint(false);
    }
  };

  // S4: Claim Retention
  const handleClaimRetention = async () => {
    if (!window.confirm(`Raise formal retention claim for ₹${Number(data?.certificate?.retention_amount || 0).toLocaleString('en-IN')}?\n\nThis will raise the retention demand and place it into the 7-level Collection follow-up ladder (SOP-17.4).`)) return;
    setClaiming(true);
    try {
      const res = await api.post(`/final-account/claim-retention/${siteId}`);
      toast.success(res.data?.message || 'Retention claim raised successfully!');
      loadAll();
      if (onUpdated) onUpdated();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to claim retention');
    } finally {
      setClaiming(false);
    }
  };

  // S5: Sync Rates to Rate Master
  const handleSyncRateMaster = async (itemsToSync) => {
    const list = itemsToSync || rateVariance?.items || [];
    if (list.length === 0) {
      toast('No materials available to sync');
      return;
    }
    setSyncingRates(true);
    try {
      const res = await api.post('/final-account/sync-rate-master', {
        site_id: siteId,
        site_name: data?.site?.name,
        items: list,
      });
      toast.success(res.data?.message || 'Rate Master updated with actual project rates!');
      loadAll();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to sync Rate Master');
    } finally {
      setSyncingRates(false);
    }
  };

  if (!siteId) return null;

  const fin = data?.financials || {};
  const cert = data?.certificate || {};
  const site = data?.site || {};
  const isFinalized = data?.saved_account?.status === 'finalized';
  const openComplaintsCount = warrantyData?.open_defects_count || 0;
  const canClaimRetention = warrantyData?.can_claim_retention && cert?.status === 'signed';

  return (
    <Modal
      isOpen
      onClose={onClose}
      title="SOP-17 · Final Account & Retention Management"
      wide
    >
      <div className="space-y-5 text-slate-800">
        {/* Header Summary Bar */}
        <div className="bg-slate-900 text-white p-4 rounded-xl shadow-sm border border-slate-800">
          <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b border-slate-800 pb-3">
            <div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono text-xs px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold uppercase">
                  SOP-17
                </span>
                <h3 className="font-bold text-base text-white">{site.name || 'Site Final Account'}</h3>
                {cert?.certificate_number && (
                  <span className="font-mono text-xs text-slate-400">
                    · Cert: <strong className="text-slate-200">{cert.certificate_number}</strong>
                  </span>
                )}
              </div>
              <div className="text-xs text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                <span>Client: <strong className="text-slate-300">{site.client_name || '—'}</strong></span>
                <span>·</span>
                <span>Process Owner: <strong className="text-emerald-400">{raci?.sop_owner?.assigned_name || 'Parul Goyal (Finance Head)'}</strong></span>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {site.cost_locked === 1 ? (
                <span className="bg-amber-500/20 text-amber-300 border border-amber-500/40 text-xs px-2.5 py-1 rounded font-bold flex items-center gap-1">
                  <FiLock size={12} /> Costs Locked (S1)
                </span>
              ) : (
                <span className="bg-slate-800 text-slate-400 text-xs px-2.5 py-1 rounded border border-slate-700">
                  Costs Open
                </span>
              )}
              {isFinalized ? (
                <span className="bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 text-xs px-2.5 py-1 rounded font-bold flex items-center gap-1">
                  <FiCheckCircle size={12} /> Account Frozen
                </span>
              ) : (
                <span className="bg-blue-500/20 text-blue-300 border border-blue-500/40 text-xs px-2.5 py-1 rounded font-bold">
                  Draft Account
                </span>
              )}
            </div>
          </div>

          {/* Stepper Navigation */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 pt-3">
            {[
              { id: 's1', num: 'S1', title: 'Final Account', desc: `Margin: ${fin.profit_margin_pct || 0}%`, done: isFinalized },
              { id: 's2', num: 'S2', title: 'Retention Sched.', desc: `₹${Number(cert.retention_amount || 0).toLocaleString('en-IN')}`, done: Boolean(cert.retention_due_date) },
              { id: 's3', num: 'S3', title: 'Warranty Log', desc: openComplaintsCount === 0 ? '✓ Complaints Clear' : `⚠ ${openComplaintsCount} Open`, done: openComplaintsCount === 0 },
              { id: 's4', num: 'S4', title: 'Retention Claim', desc: cert.retention_status === 'claimed' ? 'Claimed ✓' : 'Ladder Queue', done: cert.retention_status === 'claimed' },
              { id: 's5', num: 'S5', title: 'Rate Master', desc: `${rateVariance?.total_items_analyzed || 0} items analyzed`, done: false },
            ].map(tab => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`p-2 rounded-lg text-left transition-all border ${
                  activeTab === tab.id
                    ? 'bg-blue-600 text-white border-blue-400 shadow-sm'
                    : 'bg-slate-800/80 text-slate-300 border-slate-700 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-bold uppercase mb-0.5">
                  <span className={activeTab === tab.id ? 'text-blue-200' : 'text-slate-400'}>{tab.num}</span>
                  {tab.done && <span className="text-emerald-300 text-[10px]">✓</span>}
                </div>
                <div className="font-semibold text-xs truncate">{tab.title}</div>
                <div className={`text-[10px] truncate mt-0.5 ${activeTab === tab.id ? 'text-blue-100' : 'text-slate-400'}`}>
                  {tab.desc}
                </div>
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div className="py-12 text-center text-slate-400 text-sm">
            <FiRefreshCw className="animate-spin inline-block mr-2" /> Loading SOP-17 financial and warranty data...
          </div>
        ) : (
          <div>
            {/* ─── TAB S1: FINAL ACCOUNT ──────────────────────────────── */}
            {activeTab === 's1' && (
              <div className="space-y-4">
                {/* 5 Big Financial Metrics */}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  <div className="card p-3 border border-slate-200 bg-white">
                    <span className="text-[11px] font-semibold text-slate-500 block">Booked Contract Value</span>
                    <div className="text-base md:text-lg font-black text-slate-900 mt-1">
                      ₹{Number(fin.booked_contract_value || 0).toLocaleString('en-IN')}
                    </div>
                    <span className="text-[10px] text-slate-400 block mt-0.5">Business Book / PO</span>
                  </div>

                  <div className="card p-3 border border-slate-200 bg-white">
                    <span className="text-[11px] font-semibold text-slate-500 block">Invoiced Revenue</span>
                    <div className="text-base md:text-lg font-black text-blue-900 mt-1">
                      ₹{Number(fin.invoiced_revenue || 0).toLocaleString('en-IN')}
                    </div>
                    <span className="text-[10px] text-blue-600 block mt-0.5">Sales Invoices &amp; Client RAs</span>
                  </div>

                  <div className="card p-3 border border-slate-200 bg-white">
                    <span className="text-[11px] font-semibold text-slate-500 block">Money Received</span>
                    <div className="text-base md:text-lg font-black text-emerald-900 mt-1">
                      ₹{Number(fin.received_amount || 0).toLocaleString('en-IN')}
                    </div>
                    <span className="text-[10px] text-slate-500 block mt-0.5">
                      Bal: ₹{Number(fin.outstanding_amount || 0).toLocaleString('en-IN')}
                    </span>
                  </div>

                  <div className="card p-3 border border-slate-200 bg-white">
                    <span className="text-[11px] font-semibold text-slate-500 block">Total Actual Cost</span>
                    <div className="text-base md:text-lg font-black text-rose-900 mt-1">
                      ₹{Number(fin.total_actual_cost || 0).toLocaleString('en-IN')}
                    </div>
                    <span className="text-[10px] text-rose-600 block mt-0.5">Material + Labour + Overheads</span>
                  </div>

                  <div className={`card p-3 border ${
                    fin.net_profit >= 0 ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'
                  }`}>
                    <span className="text-[11px] font-semibold text-slate-600 block">Real Net Profit &amp; Margin</span>
                    <div className={`text-base md:text-lg font-black mt-1 ${
                      fin.net_profit >= 0 ? 'text-emerald-800' : 'text-rose-800'
                    }`}>
                      ₹{Number(fin.net_profit || 0).toLocaleString('en-IN')}
                    </div>
                    <span className={`text-[11px] font-bold block mt-0.5 ${
                      fin.net_profit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}>
                      Margin: {fin.profit_margin_pct || 0}% ({fin.variance_pct > 0 ? `+${fin.variance_pct}% vs quote` : `${fin.variance_pct}% vs quote`})
                    </span>
                  </div>
                </div>

                {/* Cost Breakdown Details */}
                <div className="border border-slate-200 rounded-lg p-4 bg-slate-50/50 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="font-bold text-xs uppercase text-slate-700 tracking-wider">
                      Actual Cost Ledger Breakdown (SOP-17.1)
                    </h4>
                    <span className="text-[11px] text-slate-500">
                      Enforced after S1 Cost Lock
                    </span>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-xs font-semibold text-slate-600 block">Material Costs</span>
                      <div className="text-base font-bold text-slate-900 mt-1">
                        ₹{Number(fin.material_cost || 0).toLocaleString('en-IN')}
                      </div>
                      <span className="text-[10px] text-slate-400 mt-0.5 block">Vendor POs &amp; Purchase Bills</span>
                    </div>

                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-xs font-semibold text-slate-600 block">Labour Costs</span>
                      <div className="text-base font-bold text-slate-900 mt-1">
                        ₹{Number(fin.labour_cost || 0).toLocaleString('en-IN')}
                      </div>
                      <span className="text-[10px] text-slate-400 mt-0.5 block">Contractor RA Bills</span>
                    </div>

                    <div className="bg-white p-3 rounded-lg border border-slate-200">
                      <span className="text-xs font-semibold text-slate-600 block">Travel &amp; Transport</span>
                      <div className="text-base font-bold text-slate-900 mt-1">
                        ₹{Number(fin.expense_cost || 0).toLocaleString('en-IN')}
                      </div>
                      <span className="text-[10px] text-slate-400 mt-0.5 block">Approved TA/DA &amp; Freight</span>
                    </div>
                  </div>
                </div>

                {/* Finalize Account Action Card */}
                <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-3 text-xs">
                  <div>
                    <div className="font-bold text-blue-950 flex items-center gap-1.5">
                      <FiCheckCircle size={15} className="text-blue-600" />
                      {isFinalized ? 'Final Account Frozen & Approved' : 'Ready for Finance Head Approval'}
                    </div>
                    <p className="text-blue-800 text-[11px] mt-0.5">
                      {isFinalized ? (
                        <>Approved by <strong>{data?.saved_account?.finalized_by_name || 'Finance Head'}</strong> on {fmtDate(data?.saved_account?.finalized_at)}.</>
                      ) : (
                        <>Freezes the final cost ledger, certifies the realized margin, and locks the project P&amp;L (SOP-17.1).</>
                      )}
                    </p>
                  </div>
                  {!isFinalized && (
                    <button
                      type="button"
                      onClick={handleFinalize}
                      disabled={finalizing}
                      className="btn btn-primary text-xs shrink-0 flex items-center gap-1.5 shadow-sm"
                    >
                      <FiCheckCircle size={13} /> {finalizing ? 'Freezing...' : 'Finalize & Freeze Account (S1)'}
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ─── TAB S2: RETENTION SCHEDULE ─────────────────────────── */}
            {activeTab === 's2' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="card p-4 border border-blue-200 bg-blue-50/50">
                    <span className="text-xs font-semibold text-blue-900 block flex items-center gap-1">
                      <FiDollarSign size={13} /> Retention Percentage &amp; Amount
                    </span>
                    <div className="text-xl font-black text-blue-950 mt-1">
                      ₹{Number(cert.retention_amount || 0).toLocaleString('en-IN')}
                    </div>
                    <span className="text-xs text-blue-700 mt-0.5 block">
                      {cert.retention_pct || 5.0}% of Booked Contract Value
                    </span>
                  </div>

                  <div className="card p-4 border border-purple-200 bg-purple-50/50">
                    <span className="text-xs font-semibold text-purple-900 block flex items-center gap-1">
                      <FiCalendar size={13} /> Retention Release Due Date
                    </span>
                    <div className="text-xl font-black text-purple-950 mt-1">
                      {fmtDate(cert.retention_due_date)}
                    </div>
                    <span className="text-xs text-purple-700 mt-0.5 block">
                      12 Months from Handover ({fmtDate(cert.handover_date)})
                    </span>
                  </div>

                  <div className="card p-4 border border-emerald-200 bg-emerald-50/50">
                    <span className="text-xs font-semibold text-emerald-900 block flex items-center gap-1">
                      <FiClock size={13} /> Collection Engine Status
                    </span>
                    <div className="text-xl font-black text-emerald-950 mt-1 capitalize">
                      {cert.retention_status || 'Pending'}
                    </div>
                    <span className="text-xs text-emerald-700 mt-0.5 block">
                      Milestone: Final Bill &amp; Retention (SOP-16 / 17.2)
                    </span>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-lg p-4 bg-white text-xs space-y-3">
                  <div className="font-bold text-slate-800">Retention Recovery Lifecycle:</div>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 text-slate-600">
                    <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
                      <strong className="block text-slate-900 mb-0.5">1. S2 Schedule Generated</strong>
                      Auto-created at certificate signature. Registered in Collections calendar.
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
                      <strong className="block text-slate-900 mb-0.5">2. S3 Warranty Watch</strong>
                      Site Engineer verifies 0 open complaints during the 12-month DLP.
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
                      <strong className="block text-slate-900 mb-0.5">3. S4 Claim Raised</strong>
                      Auto-raised on due date once warranty is clear. Enters follow-up ladder.
                    </div>
                    <div className="p-2.5 rounded bg-slate-50 border border-slate-200">
                      <strong className="block text-slate-900 mb-0.5">4. Bank Reconciliation</strong>
                      Matched with bank statement upon receipt; receipt ack sent to client.
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB S3: WARRANTY & COMPLAINT REGISTER ──────────────── */}
            {activeTab === 's3' && (
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                  <div className="card p-3 border border-purple-200 bg-purple-50/40">
                    <span className="text-xs font-semibold text-purple-900 block flex items-center gap-1">
                      <FiShield size={13} /> Defect Liability Period (DLP)
                    </span>
                    <div className="text-base font-bold text-purple-950 mt-1">
                      {warrantyData?.warranty?.months || 12} Months Warranty
                    </div>
                    <span className="text-[11px] text-purple-700 block mt-0.5">
                      Until {fmtDate(warrantyData?.warranty?.end_date)} ({warrantyData?.warranty?.days_remaining || 0} days remaining)
                    </span>
                  </div>

                  <div className="card p-3 border border-slate-200 bg-white">
                    <span className="text-xs font-semibold text-slate-600 block flex items-center gap-1">
                      <FiUser size={13} /> Warranty Lead / Resolver
                    </span>
                    <div className="text-base font-bold text-slate-900 mt-1">
                      {raci?.s3_warranty_log?.assigned_name || 'Site Engineer'}
                    </div>
                    <span className="text-[11px] text-slate-500 block mt-0.5">Responsible for Complaint Verification</span>
                  </div>

                  <div className={`card p-3 border ${
                    openComplaintsCount === 0 ? 'bg-emerald-50 border-emerald-300' : 'bg-rose-50 border-rose-300'
                  }`}>
                    <span className="text-xs font-semibold block flex items-center gap-1">
                      <FiAlertCircle size={13} /> Retention Clearance Gate
                    </span>
                    <div className={`text-base font-bold mt-1 ${
                      openComplaintsCount === 0 ? 'text-emerald-900' : 'text-rose-900'
                    }`}>
                      {openComplaintsCount === 0 ? '✓ Ready to Claim' : `⛔ Blocked (${openComplaintsCount} Open)`}
                    </div>
                    <span className={`text-[11px] font-medium block mt-0.5 ${
                      openComplaintsCount === 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}>
                      {openComplaintsCount === 0 ? 'Complaint register 100% clean' : 'Must close all tickets before claim'}
                    </span>
                  </div>
                </div>

                {/* Complaint Register Table */}
                <div className="border border-slate-200 rounded-lg p-4 bg-white space-y-3">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div>
                      <h4 className="font-bold text-xs uppercase text-slate-800 tracking-wider">
                        Post-Handover Complaint Register (SOP-17.3)
                      </h4>
                      <p className="text-[11px] text-slate-500">Every ticket must be resolved and verified before retention can be claimed</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setNewComplaintOpen(true)}
                      className="btn btn-secondary text-xs flex items-center gap-1"
                    >
                      <FiPlus size={13} /> Log Warranty Defect
                    </button>
                  </div>

                  {newComplaintOpen && (
                    <form onSubmit={handleSaveComplaint} className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2 text-xs">
                      <div className="font-semibold text-slate-800">Log New Warranty Issue:</div>
                      <div>
                        <label className="label text-[11px]">Problem Detail</label>
                        <textarea
                          rows={2}
                          className="input text-xs w-full"
                          placeholder="Describe the defect observed by client..."
                          value={complaintForm.problem_detail}
                          onChange={e => setComplaintForm(f => ({ ...f, problem_detail: e.target.value }))}
                        />
                      </div>
                      <div className="flex items-center justify-end gap-2 pt-1">
                        <button type="button" onClick={() => setNewComplaintOpen(false)} className="btn btn-secondary text-xs">
                          Cancel
                        </button>
                        <button type="submit" disabled={savingComplaint} className="btn btn-primary text-xs">
                          {savingComplaint ? 'Logging...' : 'Register Complaint'}
                        </button>
                      </div>
                    </form>
                  )}

                  <div className="overflow-x-auto">
                    <table className="table text-xs w-full">
                      <thead>
                        <tr className="bg-slate-50 text-slate-600">
                          <th>Ticket No</th>
                          <th>Problem Detail</th>
                          <th>Category</th>
                          <th>Priority</th>
                          <th>Assigned Engineer</th>
                          <th>Status</th>
                        </tr>
                      </thead>
                      <tbody>
                        {warrantyData?.complaints?.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center py-6 text-slate-400">
                              ✓ No complaints registered during warranty period. 100% clean!
                            </td>
                          </tr>
                        ) : (
                          warrantyData?.complaints?.map(c => (
                            <tr key={c.id}>
                              <td className="font-bold font-mono text-red-700">{c.complaint_number}</td>
                              <td>{c.problem_detail}</td>
                              <td>{c.category || '—'}</td>
                              <td>
                                <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                  c.priority === 'critical' || c.priority === 'high' ? 'bg-red-100 text-red-700' : 'bg-slate-100 text-slate-700'
                                }`}>
                                  {c.priority}
                                </span>
                              </td>
                              <td>{c.assigned_engineer_name || 'Site Engineer'}</td>
                              <td>
                                <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                                  ['resolved', 'closed'].includes(c.status) ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'
                                }`}>
                                  {c.status}
                                </span>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB S4: RETENTION CLAIM & COLLECTION LADDER ────────── */}
            {activeTab === 's4' && (
              <div className="space-y-4">
                <div className="border border-slate-200 rounded-lg p-4 bg-white space-y-4">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b pb-3">
                    <div>
                      <h4 className="font-bold text-sm text-slate-900">
                        Retention Recovery &amp; Collection Follow-up (SOP-17.4)
                      </h4>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Claim feeds into the exact 7-step Collection Escalation Ladder
                      </p>
                    </div>

                    <div className="flex items-center gap-2">
                      {cert.retention_status === 'claimed' ? (
                        <span className="bg-emerald-100 text-emerald-800 border border-emerald-300 text-xs px-3 py-1 rounded-full font-bold flex items-center gap-1">
                          <FiCheckCircle size={13} /> Claim Active in Collection Engine
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={handleClaimRetention}
                          disabled={claiming || !canClaimRetention}
                          className={`btn text-xs flex items-center gap-1.5 ${
                            canClaimRetention ? 'btn-primary shadow-sm' : 'btn-secondary opacity-50 cursor-not-allowed'
                          }`}
                          title={!canClaimRetention ? `Cannot claim: ${openComplaintsCount} open complaint(s) exist.` : ''}
                        >
                          <FiDollarSign size={14} /> {claiming ? 'Raising Claim...' : 'Raise Retention Claim (S4)'}
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Readiness Checklist */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                    <div className={`p-3 rounded-lg border ${
                      cert.status === 'signed' ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-slate-50 border-slate-200 text-slate-500'
                    }`}>
                      <div className="font-bold flex items-center gap-1.5">
                        <FiCheckCircle size={14} /> 1. Handover Executed
                      </div>
                      <span className="text-[11px] block mt-1">
                        Certificate {cert.certificate_number} is signed.
                      </span>
                    </div>

                    <div className={`p-3 rounded-lg border ${
                      openComplaintsCount === 0 ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-rose-50 border-rose-200 text-rose-900'
                    }`}>
                      <div className="font-bold flex items-center gap-1.5">
                        {openComplaintsCount === 0 ? <FiCheckCircle size={14} /> : <FiAlertTriangle size={14} />} 2. Complaints Verified (S3)
                      </div>
                      <span className="text-[11px] block mt-1">
                        {openComplaintsCount === 0 ? '0 open defects in complaint register.' : `${openComplaintsCount} open complaints pending resolution.`}
                      </span>
                    </div>

                    <div className={`p-3 rounded-lg border ${
                      cert.retention_status === 'claimed' ? 'bg-blue-50 border-blue-200 text-blue-900' : 'bg-slate-50 border-slate-200 text-slate-500'
                    }`}>
                      <div className="font-bold flex items-center gap-1.5">
                        <FiClock size={14} /> 3. Retention Due Date
                      </div>
                      <span className="text-[11px] block mt-1">
                        Due: {fmtDate(cert.retention_due_date)}
                      </span>
                    </div>
                  </div>

                  {/* 7-Step Escalation Ladder Overview */}
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs space-y-2">
                    <div className="font-semibold text-slate-800">
                      Standard Collection Follow-up Ladder (SOP-16 Engine):
                    </div>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-slate-600">
                      <div className="p-2 bg-white rounded border border-slate-200">
                        <strong className="block text-slate-800">Reminder 1 (T-3)</strong> WhatsApp friendly reminder
                      </div>
                      <div className="p-2 bg-white rounded border border-slate-200">
                        <strong className="block text-slate-800">Reminder 2 (Due)</strong> Due date payment request
                      </div>
                      <div className="p-2 bg-white rounded border border-slate-200">
                        <strong className="block text-slate-800">Reminder 3 (T+3)</strong> Grace period follow-up
                      </div>
                      <div className="p-2 bg-white rounded border border-slate-200">
                        <strong className="block text-slate-800">Call (T+7)</strong> Collection Engineer Phone Call
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* ─── TAB S5: RATE MASTER LEARNING LOOP ───────────────────── */}
            {activeTab === 's5' && (
              <div className="space-y-4">
                <div className="border border-slate-200 rounded-lg p-4 bg-white space-y-3">
                  <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-3 border-b pb-3">
                    <div>
                      <h4 className="font-bold text-sm text-slate-900">
                        Rate Master Learning Feedback Loop (SOP-17.5)
                      </h4>
                      <p className="text-xs text-slate-500 mt-0.5">
                        Project actual landed costs automatically feed back into Rate Master so next quotes become sharper
                      </p>
                    </div>

                    <button
                      type="button"
                      onClick={() => handleSyncRateMaster()}
                      disabled={syncingRates || !rateVariance?.items?.length}
                      className="btn btn-primary text-xs flex items-center gap-1.5 shadow-sm"
                    >
                      <FiTrendingUp size={13} /> {syncingRates ? 'Syncing...' : 'Sync Rates to Rate Master (S5)'}
                    </button>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="table text-xs w-full">
                      <thead>
                        <tr className="bg-slate-50 text-slate-600">
                          <th>Item Name</th>
                          <th>Unit</th>
                          <th>Qty Used</th>
                          <th>Actual Project Rate</th>
                          <th>Rate Master Price</th>
                          <th>Variance</th>
                          <th>Last Bill / Vendor</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rateVariance?.items?.length === 0 ? (
                          <tr>
                            <td colSpan={7} className="text-center py-6 text-slate-400">
                              No purchase bill items recorded for this project yet.
                            </td>
                          </tr>
                        ) : (
                          rateVariance?.items?.map((it, idx) => (
                            <tr key={idx}>
                              <td className="font-medium text-slate-900">{it.item_name}</td>
                              <td>{it.unit}</td>
                              <td>{it.total_quantity}</td>
                              <td className="font-bold text-slate-900">₹{it.avg_rate}</td>
                              <td className="text-slate-600">
                                {it.current_rate_master_price > 0 ? `₹${it.current_rate_master_price}` : 'Unset'}
                              </td>
                              <td>
                                {it.variance_pct !== 0 ? (
                                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                                    it.is_higher ? 'bg-rose-100 text-rose-800' : 'bg-emerald-100 text-emerald-800'
                                  }`}>
                                    {it.variance_pct > 0 ? `+${it.variance_pct}%` : `${it.variance_pct}%`}
                                  </span>
                                ) : (
                                  <span className="text-slate-400">Match</span>
                                )}
                              </td>
                              <td className="text-[11px] text-slate-500">
                                {it.vendor_name || '—'} {it.last_bill_number ? `(${it.last_bill_number})` : ''}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Modal Footer */}
        <div className="flex items-center justify-between border-t pt-3 text-xs text-slate-500">
          <div>
            SOP-17 · Final Account &amp; Retention · <strong>Parul Goyal (Finance Head)</strong>
          </div>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
