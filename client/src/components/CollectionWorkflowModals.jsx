// SOP-16 Collection Engine Workflow Modals
// Steps:
//   S1: Payment Stages on Day 1
//   S4: Escalation Ladder
//   S5: 60-Day Supply Stop Override
//   S6: Thank-You Payment Receipt

import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import {
  FiClock, FiAlertTriangle, FiCheckCircle, FiShield,
  FiFileText, FiPrinter, FiSend, FiUser, FiArrowRight, FiLock, FiUnlock
} from 'react-icons/fi';
import { LuIndianRupee } from 'react-icons/lu';

// ─── S1 & S2: Payment Stages Modal ─────────────────────────────────────
export function PaymentStagesModal({ site, onClose, onSaved }) {
  const [stages, setStages] = useState([]);
  const [poTotal, setPoTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!site?.id) return;
    setLoading(true);
    api.get(`/collections/sop16/stages/${site.id}`)
      .then(r => {
        setStages(r.data.stages || []);
        setPoTotal(r.data.po_total || 0);
      })
      .catch(() => toast.error('Could not load payment stages'))
      .finally(() => setLoading(false));
  }, [site?.id]);

  const updateStageField = (idx, field, val) => {
    setStages(prev => {
      const copy = [...prev];
      copy[idx] = { ...copy[idx], [field]: val };
      if (field === 'stage_percentage' && poTotal > 0) {
        copy[idx].stage_amount = Math.round((poTotal * Number(val || 0)) / 100);
      }
      return copy;
    });
  };

  const saveStages = async (e) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(`/collections/sop16/stages/${site.id}`, { stages });
      toast.success('Payment stages saved successfully per contract Day-1 terms');
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save payment stages');
    } finally {
      setBusy(false);
    }
  };

  const triggerDemand = async (stageId) => {
    if (!window.confirm('Trigger automated payment demand for this stage now? This will create a pending receivable.')) return;
    setBusy(true);
    try {
      const res = await api.post(`/collections/sop16/trigger-stage/${stageId}`);
      toast.success(res.data.message || 'Payment demand raised!');
      if (onSaved) onSaved();
      // Reload stages
      const r = await api.get(`/collections/sop16/stages/${site.id}`);
      setStages(r.data.stages || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not demand payment');
    } finally {
      setBusy(false);
    }
  };

  const totalPct = stages.reduce((acc, s) => acc + Number(s.stage_percentage || 0), 0);
  const totalAmt = stages.reduce((acc, s) => acc + Number(s.stage_amount || 0), 0);

  return (
    <Modal isOpen onClose={onClose} title={`SOP-16.1 · Contract Payment Stages (${site?.name})`} wide>
      <form onSubmit={saveStages} className="space-y-4 text-xs">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-blue-900 flex items-start justify-between gap-3">
          <div>
            <div className="font-bold flex items-center gap-1.5 text-blue-950">
              <FiFileText size={14} /> Day-1 Contract Payment Milestones (SOP-16.1):
            </div>
            <p className="mt-0.5 text-blue-800">
              Contract terms are fixed in the project record on Day 1. When an operational milestone completes,
              the system automatically raises the payment demand (SOP-16.2).
            </p>
          </div>
          {poTotal > 0 && (
            <div className="text-right shrink-0 bg-white/80 border border-blue-200 px-2.5 py-1 rounded">
              <span className="text-[10px] text-gray-500 block">Total PO Value</span>
              <span className="font-bold text-blue-900 text-sm">₹{poTotal.toLocaleString('en-IN')}</span>
            </div>
          )}
        </div>

        {loading ? (
          <div className="py-8 text-center text-gray-400">Loading contract stages…</div>
        ) : (
          <div className="space-y-3">
            <div className="overflow-x-auto border rounded-lg max-h-[50vh] overflow-y-auto">
              <table className="w-full text-left">
                <thead className="bg-gray-100 text-gray-700 font-bold uppercase text-[10px]">
                  <tr>
                    <th className="p-2.5">Milestone Name</th>
                    <th className="p-2.5 w-20 text-right">% Share</th>
                    <th className="p-2.5 w-32 text-right">Amount (₹)</th>
                    <th className="p-2.5">Trigger Event</th>
                    <th className="p-2.5 w-28">Status</th>
                    <th className="p-2.5 text-center w-28">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {stages.map((st, i) => (
                    <tr key={i} className="hover:bg-gray-50/60">
                      <td className="p-2.5">
                        <input
                          type="text"
                          className="input text-xs w-full py-1"
                          value={st.stage_name || ''}
                          disabled={st.status === 'demanded' || st.status === 'paid'}
                          onChange={e => updateStageField(i, 'stage_name', e.target.value)}
                        />
                      </td>
                      <td className="p-2.5 text-right">
                        <input
                          type="number"
                          step="0.1"
                          className="input text-xs w-full py-1 text-right"
                          value={st.stage_percentage || 0}
                          disabled={st.status === 'demanded' || st.status === 'paid'}
                          onChange={e => updateStageField(i, 'stage_percentage', e.target.value)}
                        />
                      </td>
                      <td className="p-2.5 text-right">
                        <input
                          type="number"
                          className="input text-xs w-full py-1 text-right font-medium"
                          value={st.stage_amount || 0}
                          disabled={st.status === 'demanded' || st.status === 'paid'}
                          onChange={e => updateStageField(i, 'stage_amount', e.target.value)}
                        />
                      </td>
                      <td className="p-2.5 text-gray-600">
                        <input
                          type="text"
                          className="input text-xs w-full py-1 text-gray-600"
                          value={st.trigger_event || ''}
                          disabled={st.status === 'demanded' || st.status === 'paid'}
                          onChange={e => updateStageField(i, 'trigger_event', e.target.value)}
                          placeholder="e.g. Material Dispatched"
                        />
                      </td>
                      <td className="p-2.5">
                        <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase inline-block ${
                          st.status === 'paid' ? 'bg-emerald-100 text-emerald-800' :
                          st.status === 'demanded' ? 'bg-blue-100 text-blue-800' :
                          'bg-amber-100 text-amber-800'
                        }`}>
                          {st.status || 'pending'}
                        </span>
                      </td>
                      <td className="p-2.5 text-center">
                        {st.status === 'pending' && st.id ? (
                          <button
                            type="button"
                            onClick={() => triggerDemand(st.id)}
                            className="btn btn-sm btn-primary text-[10px] py-1 px-2 flex items-center gap-1 mx-auto"
                            title="Auto-Demand payment per SOP-16.2"
                          >
                            <FiSend size={10} /> Demand
                          </button>
                        ) : st.status === 'demanded' ? (
                          <span className="text-[10px] text-blue-700 font-medium">Demanded ✓</span>
                        ) : (
                          <span className="text-[10px] text-gray-400">Save First</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-gray-50 font-bold border-t text-gray-700">
                  <tr>
                    <td className="p-2.5">Total Allocation</td>
                    <td className={`p-2.5 text-right ${totalPct === 100 ? 'text-emerald-700' : 'text-amber-700'}`}>
                      {totalPct}%
                    </td>
                    <td className="p-2.5 text-right">₹{totalAmt.toLocaleString('en-IN')}</td>
                    <td colSpan="3" className="p-2.5 text-[11px] text-gray-500 font-normal">
                      {totalPct === 100 ? '✓ Milestones cover 100% of contract' : `Warning: Totals ${totalPct}% (target 100%)`}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
              <button type="submit" disabled={busy} className="btn btn-primary text-xs flex items-center gap-1.5">
                <FiCheckCircle size={13} /> {busy ? 'Saving…' : 'Save Payment Stages'}
              </button>
            </div>
          </div>
        )}
      </form>
    </Modal>
  );
}

// ─── S4: Escalation Ladder Modal ───────────────────────────────────────
export function EscalationLadderModal({ onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get('/collections/sop16/escalations')
      .then(r => setData(r.data))
      .catch(() => toast.error('Could not load escalation ladder'))
      .finally(() => setLoading(false));
  }, []);

  return (
    <Modal isOpen onClose={onClose} title="SOP-16.4 · Fixed Follow-Up & Escalation Ladder" wide>
      <div className="space-y-4 text-xs">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-amber-900 space-y-1">
          <div className="font-bold flex items-center gap-1.5 text-amber-950">
            <FiClock size={14} className="text-amber-700" /> Fixed Calendar Escalation Ladder (SOP-16.4):
          </div>
          <p>
            Follow-up does not depend on memory. When an invoice is overdue, responsibility automatically climbs
            the ladder on fixed days:
            <strong> Collection Engineer (Days 1–7)</strong> $\to$
            <strong> PM ({data?.raci?.s4_ladder_pm?.assigned_name || 'Adarsh Kumar'}) (Day 15)</strong> $\to$
            <strong> Head ({data?.raci?.s4_ladder_head?.assigned_name || 'Nitin Jain'}) (Day 30)</strong> $\to$
            <strong> MD ({data?.raci?.s4_ladder_md?.assigned_name || 'Ankur Kaplesh'}) (Days 45–60+)</strong>.
          </p>
        </div>

        {/* 4 Ladder Metric Cards */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <div className="p-3 rounded-lg border bg-blue-50/70 border-blue-200">
            <div className="text-[10px] font-bold text-blue-700 uppercase">Level 1 · Days 1–7</div>
            <div className="text-xl font-bold text-blue-900 mt-1">{data?.summary?.l1_ce || 0}</div>
            <div className="text-[10px] text-blue-700 mt-0.5">{data?.raci?.s4_ladder_ce?.assigned_name || 'Collection Engineer'}</div>
          </div>
          <div className="p-3 rounded-lg border bg-amber-50/70 border-amber-200">
            <div className="text-[10px] font-bold text-amber-800 uppercase">Level 2 · Day 15</div>
            <div className="text-xl font-bold text-amber-950 mt-1">{data?.summary?.l2_pm || 0}</div>
            <div className="text-[10px] text-amber-800 mt-0.5">{data?.raci?.s4_ladder_pm?.assigned_name || 'Adarsh Kumar (PM)'}</div>
          </div>
          <div className="p-3 rounded-lg border bg-orange-50/70 border-orange-200">
            <div className="text-[10px] font-bold text-orange-800 uppercase">Level 3 · Day 30</div>
            <div className="text-xl font-bold text-orange-950 mt-1">{data?.summary?.l3_head || 0}</div>
            <div className="text-[10px] text-orange-800 mt-0.5">{data?.raci?.s4_ladder_head?.assigned_name || 'Nitin Jain (Head)'}</div>
          </div>
          <div className="p-3 rounded-lg border bg-red-50/70 border-red-200">
            <div className="text-[10px] font-bold text-red-700 uppercase">Level 4 · Day 45+</div>
            <div className="text-xl font-bold text-red-900 mt-1">{data?.summary?.l4_md || 0}</div>
            <div className="text-[10px] text-red-700 mt-0.5">{data?.raci?.s4_ladder_md?.assigned_name || 'Ankur Kaplesh (MD)'}</div>
          </div>
        </div>

        {loading ? (
          <div className="py-8 text-center text-gray-400">Loading escalation records…</div>
        ) : (data?.escalations || []).length === 0 ? (
          <div className="py-8 text-center text-gray-500 bg-gray-50 rounded-lg border">
            <FiCheckCircle className="mx-auto text-emerald-500 mb-2" size={28} />
            <div className="font-semibold text-gray-700">All Collections Up to Date!</div>
            <p className="text-xs text-gray-400 mt-0.5">No open receivables currently breached payment due dates.</p>
          </div>
        ) : (
          <div className="overflow-x-auto border rounded-lg max-h-96">
            <table className="w-full text-left">
              <thead className="bg-gray-100 text-gray-700 uppercase text-[10px] font-bold sticky top-0">
                <tr>
                  <th className="p-2.5">Client / Site</th>
                  <th className="p-2.5">Invoice #</th>
                  <th className="p-2.5 text-right">Outstanding (₹)</th>
                  <th className="p-2.5 text-right">Aging Days</th>
                  <th className="p-2.5">Escalated Authority</th>
                  <th className="p-2.5">Action Plan</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {data.escalations.map(esc => (
                  <tr key={esc.id} className={esc.is_material_blocked ? 'bg-red-50/50' : 'hover:bg-gray-50'}>
                    <td className="p-2.5">
                      <div className="font-bold text-gray-900">{esc.client_name}</div>
                      <div className="text-[10px] text-gray-500">{esc.project_name}</div>
                    </td>
                    <td className="p-2.5 font-mono text-gray-700">{esc.invoice_number || '—'}</td>
                    <td className="p-2.5 text-right font-bold text-gray-900">
                      ₹{esc.outstanding_amount?.toLocaleString('en-IN')}
                    </td>
                    <td className="p-2.5 text-right font-bold text-red-600">
                      {esc.ageing_days}d
                      {esc.is_material_blocked && (
                        <span className="block text-[9px] bg-red-600 text-white font-bold px-1 rounded mt-0.5">
                          Supply Blocked
                        </span>
                      )}
                    </td>
                    <td className="p-2.5">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold uppercase inline-block ${
                        esc.level_num === 4 ? 'bg-red-100 text-red-800 border border-red-300' :
                        esc.level_num === 3 ? 'bg-orange-100 text-orange-800 border border-orange-300' :
                        esc.level_num === 2 ? 'bg-amber-100 text-amber-800 border border-amber-300' :
                        'bg-blue-100 text-blue-800 border border-blue-300'
                      }`}>
                        {esc.level_title}
                      </span>
                      <div className="text-[10px] text-gray-600 mt-0.5">{esc.assigned_name}</div>
                    </td>
                    <td className="p-2.5 text-gray-600 text-[11px] max-w-xs">{esc.action_required}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="flex justify-end pt-2">
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── S5: Supply Block Override Modal ───────────────────────────────────
export function SupplyBlockOverrideModal({ site, onClose, onSaved }) {
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(true);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const siteKey = site?.id || site?.name || site?.client_name;
    if (!siteKey) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api.get(`/collections/sop16/supply-block-status/${encodeURIComponent(siteKey)}`)
      .then(r => setStatus(r.data))
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [site?.id, site?.name, site?.client_name]);

  const submitOverride = async (e) => {
    e.preventDefault();
    if (!reason.trim()) return toast.error('A written justification note is mandatory');
    setBusy(true);
    try {
      const targetId = status?.site_id || site?.id || site?.name || site?.client_name;
      await api.post('/collections/sop16/supply-block-override', {
        site_id: targetId,
        override_reason: reason.trim()
      });
      toast.success(`Exception override granted for ${status?.site_name || site?.name || 'site'}`);
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit override');
    } finally {
      setBusy(false);
    }
  };

  const displayName = status?.site_name || site?.name || site?.client_name || 'Site';

  return (
    <Modal isOpen onClose={onClose} title={`SOP-16.5 · Material Supply Stop Status (${displayName})`}>
      {loading ? (
        <div className="py-8 text-center text-gray-400 text-xs">Checking material supply block status…</div>
      ) : (
        <form onSubmit={submitOverride} className="space-y-4 text-xs">
          <div className={`p-3 rounded-lg border ${
            status?.blocked
              ? 'bg-red-50 border-red-200 text-red-900'
              : status?.has_override
              ? 'bg-amber-50 border-amber-200 text-amber-900'
              : 'bg-emerald-50 border-emerald-200 text-emerald-900'
          }`}>
            <div className="font-bold flex items-center gap-1.5 text-sm">
              {status?.blocked ? <FiLock className="text-red-600" /> : <FiUnlock className="text-emerald-600" />}
              {status?.blocked ? 'Material Supply Blocked (60+ Days Overdue)' :
               status?.has_override ? 'Material Supply Authorized (Head Exception Override Active)' :
               'Material Supply Open (Payment Health OK)'}
            </div>
            <p className="mt-1 leading-relaxed">
              {status?.blocked ? status.reason :
               status?.has_override ? `Overridden by ${status.overridden_by_name}: "${status.override_reason}"` :
               `Client is within payment terms. Oldest overdue: ${status?.max_days || 0} days.`}
            </p>
          </div>

          {status?.blocked && (
            <div className="space-y-2 border-t pt-3">
              <label className="font-semibold text-gray-700 block">
                Department Head Exception Justification <span className="text-red-500">*</span>
              </label>
              <textarea
                className="textarea text-xs w-full"
                rows={3}
                placeholder="State legitimate project reason why new material supply should continue despite >60 days overdue (e.g. Critical handover deadline, client promise letter attached, etc.)"
                value={reason}
                onChange={e => setReason(e.target.value)}
                required
              />
              <p className="text-[10px] text-gray-400">
                Only authorized by Department Head (Nitin Jain) or Admin. Action is permanently logged in the audit trail.
              </p>
            </div>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
            {status?.blocked && (
              <button type="submit" disabled={busy} className="btn btn-primary text-xs flex items-center gap-1.5">
                <FiCheckCircle size={13} /> {busy ? 'Authorizing…' : 'Grant Head Exception Override'}
              </button>
            )}
          </div>
        </form>
      )}
    </Modal>
  );
}

// ─── S6: Collection Thank-You Receipt Modal ────────────────────────────
export function CollectionReceiptModal({ receipt, onClose }) {
  if (!receipt) return null;

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal isOpen onClose={onClose} title={`Payment Receipt #${receipt.receipt_no}`} wide>
      <div className="space-y-6 p-4 bg-white text-gray-800 text-xs">
        {/* Receipt Header */}
        <div className="flex justify-between items-start border-b pb-4">
          <div>
            <h2 className="text-xl font-bold text-slate-900 tracking-tight">SECURED ENGINEERS PVT. LTD.</h2>
            <p className="text-gray-500 text-[11px]">Official Payment Acknowledgment &amp; Receipt</p>
          </div>
          <div className="text-right">
            <span className="font-mono text-base font-bold text-blue-700">{receipt.receipt_no}</span>
            <div className="text-[11px] text-gray-500">Date: {receipt.receipt_date}</div>
          </div>
        </div>

        {/* Client & Project Details */}
        <div className="grid grid-cols-2 gap-4 bg-gray-50 p-3 rounded-lg border">
          <div>
            <span className="text-[10px] text-gray-400 uppercase font-bold block">Received From</span>
            <span className="font-semibold text-gray-900 text-sm block">{receipt.client_name}</span>
            <span className="text-gray-600 block mt-0.5">{receipt.project_name || receipt.site_name || '—'}</span>
          </div>
          <div className="text-right">
            <span className="text-[10px] text-gray-400 uppercase font-bold block">Payment Mode</span>
            <span className="font-medium text-gray-800 block">{receipt.payment_mode || 'Bank'}</span>
            <span className="text-gray-500 font-mono text-[11px] block mt-0.5">Ref: {receipt.transaction_ref || '—'}</span>
          </div>
        </div>

        {/* Amount Box */}
        <div className="border rounded-lg overflow-hidden">
          <table className="w-full text-left">
            <thead className="bg-slate-100 text-slate-700 font-bold uppercase text-[10px]">
              <tr>
                <th className="p-3">Description</th>
                <th className="p-3 text-right">Amount (₹)</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-200">
              <tr>
                <td className="p-3">Amount Received (Net Bank Inflow)</td>
                <td className="p-3 text-right font-bold text-gray-900">₹{receipt.amount_received?.toLocaleString('en-IN')}</td>
              </tr>
              {Number(receipt.tds_deducted || 0) > 0 && (
                <tr>
                  <td className="p-3 text-gray-600">TDS / Statutory Deduction Credited</td>
                  <td className="p-3 text-right text-gray-700 font-medium">₹{receipt.tds_deducted?.toLocaleString('en-IN')}</td>
                </tr>
              )}
              <tr className="bg-emerald-50/60 font-bold text-emerald-950">
                <td className="p-3">Total Account Credit</td>
                <td className="p-3 text-right text-sm text-emerald-700">₹{(receipt.total_credit || receipt.amount_received)?.toLocaleString('en-IN')}</td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Notes & Thank you */}
        <div className="bg-blue-50/60 border border-blue-200 rounded-lg p-3 text-blue-900">
          <p className="italic">"{receipt.notes || 'Thank you for your valuable partnership. Your payment has been credited successfully.'}"</p>
        </div>

        {/* Signatory */}
        <div className="flex justify-between items-end pt-6 border-t">
          <div className="text-gray-400 text-[10px]">
            System generated via SOP-16 Collection Engine. No signature required.
          </div>
          <div className="text-right">
            <div className="h-10"></div>
            <div className="border-t border-gray-400 pt-1 font-semibold text-gray-800">
              {receipt.company_signatory || 'Accounts & Finance'}
            </div>
            <div className="text-[10px] text-gray-400">Secured Engineers Pvt. Ltd.</div>
          </div>
        </div>

        {/* Print / Close Bar */}
        <div className="flex justify-end gap-2 pt-2 print:hidden">
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
          <button type="button" onClick={handlePrint} className="btn btn-primary text-xs flex items-center gap-1.5">
            <FiPrinter size={13} /> Print Receipt
          </button>
        </div>
      </div>
    </Modal>
  );
}
