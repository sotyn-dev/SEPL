import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import Modal from './Modal';
import FunnelStepper from './FunnelStepper';
import { leadFunnel } from '../api';
import { STAGES, SIDE_STATES, stageLabel } from '../data/l2dStages';
import { fmtIST } from '../utils/dateIST';
import { FiTruck, FiMessageCircle, FiCheckCircle } from 'react-icons/fi';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

// Lead detail panel (rendered in a wide Modal). Shows the client, the query,
// the vertical stepper, AI verdict, matched item + price, the message log,
// the steps 8–12 capture fields, and the funnel-only PO draft + approve.
export default function FunnelLeadDrawer({ leadId, isAdmin, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [cap, setCap] = useState({});

  const load = () => {
    setLoading(true);
    leadFunnel.get(leadId)
      .then(d => { setData(d); setCap(seedCapture(d.lead)); })
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load lead'))
      .finally(() => setLoading(false));
  };
  useEffect(() => { if (leadId) load(); }, [leadId]);

  const lead = data?.lead;

  const changeStage = async (stage) => {
    setBusy(true);
    try {
      await leadFunnel.setStage(leadId, { stage });
      toast.success(`Moved to ${stageLabel(stage)}`);
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusy(false); }
  };

  const saveCapture = async () => {
    setBusy(true);
    try {
      await leadFunnel.update(leadId, cap);
      toast.success('Saved');
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
    finally { setBusy(false); }
  };

  const draftPo = async () => {
    setBusy(true);
    try {
      const r = await leadFunnel.draftPo(leadId);
      toast.success(`PO ${r.po_number} drafted`);
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Draft failed'); }
    finally { setBusy(false); }
  };

  const approvePo = async (po) => {
    const vendor = window.prompt('Confirm vendor name for this PO:', po.vendor || (firstCandidate(po) || ''));
    if (!vendor) return;
    setBusy(true);
    try {
      await leadFunnel.approvePo(po.id, { vendor });
      toast.success('PO approved');
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Approve failed'); }
    finally { setBusy(false); }
  };

  return (
    <Modal isOpen={!!leadId} onClose={onClose} title={lead ? (lead.sender_name || 'Lead') : 'Lead'} wide>
      {loading || !lead ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
          {/* Left: stepper grid */}
          <div className="md:col-span-1">
            <FunnelStepper stage={lead.stage} onStageClick={changeStage} busy={busy} />
          </div>

          {/* Middle + right: details */}
          <div className="md:col-span-2 space-y-4">
            <Section title="Client">
              <Field k="Name" v={lead.sender_name} />
              <Field k="Mobile" v={lead.sender_mobile} />
              <Field k="Email" v={lead.sender_email} />
              <Field k="Company" v={lead.sender_company} />
              <Field k="Location" v={[lead.sender_city, lead.sender_state].filter(Boolean).join(', ')} />
              <Field k="Source" v={`${lead.source} · ${lead.query_type || ''}`} />
              <Field k="Received" v={fmtIST(lead.query_time) || fmtIST(lead.created_at)} />
            </Section>

            <Section title="Enquiry">
              <Field k="Product" v={lead.query_product_name} />
              <Field k="Category" v={lead.query_mcat_name} />
              <div className="text-xs text-gray-700 whitespace-pre-wrap bg-gray-50 rounded p-2 mt-1">{lead.query_message || '—'}</div>
            </Section>

            {(lead.ai_verdict || lead.matched_item_name) && (
              <Section title="AI assessment">
                {lead.ai_verdict && <Field k="Verdict" v={`${lead.ai_verdict}${lead.ai_confidence != null ? ` (${Math.round(lead.ai_confidence * 100)}%)` : ''}`} />}
                {lead.ai_reason && <Field k="Reason" v={lead.ai_reason} />}
                {lead.matched_item_name && <Field k="Matched item" v={lead.matched_item_name} />}
                {lead.quoted_price != null && lead.quoted_price > 0 && <Field k="Quoted price" v={`${money(lead.quoted_price)} (${lead.price_source || ''})`} />}
              </Section>
            )}

            {/* Vendor PO draft (funnel-only) */}
            <Section title="Vendor PO (draft)">
              {(data.vendorPo || []).length === 0 ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-gray-400">No PO drafted yet.</span>
                  <button onClick={draftPo} disabled={busy} className="btn btn-sm btn-secondary">
                    <FiTruck className="inline mr-1" size={13} /> AI draft PO
                  </button>
                </div>
              ) : (
                (data.vendorPo || []).map(po => (
                  <div key={po.id} className="border rounded p-2 mb-2 text-xs">
                    <div className="flex justify-between">
                      <span className="font-semibold">{po.po_number}</span>
                      <span className={po.status === 'approved' ? 'text-green-600' : 'text-yellow-600'}>{po.status}</span>
                    </div>
                    <div>{po.item_name} · qty {po.qty} · {money(po.rate)} = {money(po.amount)}</div>
                    {po.vendor && <div className="text-gray-700">Vendor: <b>{po.vendor}</b></div>}
                    {po.status !== 'approved' && (
                      <div className="mt-1">
                        <div className="text-gray-500 mb-1">AI shortlist (human confirms):</div>
                        <ul className="list-disc pl-4 space-y-0.5">
                          {parseCandidates(po).map((c, i) => (
                            <li key={i}>{c.name} {c.why ? <span className="text-gray-400">— {c.why}</span> : null}</li>
                          ))}
                        </ul>
                        {isAdmin && <button onClick={() => approvePo(po)} disabled={busy} className="btn btn-sm btn-primary mt-2"><FiCheckCircle className="inline mr-1" size={13} /> Confirm vendor & approve</button>}
                      </div>
                    )}
                  </div>
                ))
              )}
            </Section>

            {/* Steps 8–12 capture */}
            <Section title="Capture (steps 8–12)">
              <div className="grid grid-cols-2 gap-2">
                <Cap k="payment_ref" label="Payment ref" cap={cap} setCap={setCap} />
                <Cap k="po_amount" label="PO amount" cap={cap} setCap={setCap} type="number" />
                <Cap k="dispatch_ref" label="Dispatch ref" cap={cap} setCap={setCap} />
                <Cap k="purchase_bill_number" label="Purchase bill #" cap={cap} setCap={setCap} />
                <Cap k="sales_bill_number" label="Sales bill #" cap={cap} setCap={setCap} />
                <Cap k="sales_bill_amount" label="Sales bill amount" cap={cap} setCap={setCap} type="number" />
                <Cap k="receipt_amount" label="Receipt amount" cap={cap} setCap={setCap} type="number" />
                <Cap k="receipt_date" label="Receipt date" cap={cap} setCap={setCap} type="date" />
              </div>
              <label className="flex items-center gap-2 mt-2 text-xs">
                <input type="checkbox" checked={!!cap.opted_out} onChange={e => setCap({ ...cap, opted_out: e.target.checked ? 1 : 0 })} />
                Opted out of follow-up messages
              </label>
              <button onClick={saveCapture} disabled={busy} className="btn btn-sm btn-primary mt-2">Save capture</button>
            </Section>

            {/* Message log */}
            <Section title="Messages">
              {(data.messages || []).length === 0 ? <div className="text-xs text-gray-400">No messages.</div> : (
                <ul className="space-y-1">
                  {data.messages.map(m => (
                    <li key={m.id} className="text-xs flex gap-2">
                      <FiMessageCircle size={12} className={`mt-0.5 ${m.direction === 'in' ? 'text-green-600' : 'text-blue-500'}`} />
                      <span className="text-gray-400">{fmtIST(m.created_at)}</span>
                      <span className="flex-1">{m.template ? `[${m.template}] ` : ''}{m.body || ''} <span className="text-gray-400">{m.status}{m.error ? ` · ${m.error}` : ''}</span></span>
                    </li>
                  ))}
                </ul>
              )}
            </Section>

            {/* History */}
            <Section title="Stage history">
              <ul className="space-y-1">
                {(data.history || []).map(h => (
                  <li key={h.id} className="text-xs text-gray-600">
                    <span className="text-gray-400">{fmtIST(h.created_at)}</span> · {stageLabel(h.to_stage)}
                    {h.note ? <span className="text-gray-400"> — {h.note}</span> : null}
                    {h.changed_by_name ? <span className="text-gray-400"> ({h.changed_by_name})</span> : null}
                  </li>
                ))}
              </ul>
            </Section>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-xs font-semibold text-gray-800 uppercase tracking-wide mb-1">{title}</div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}
function Field({ k, v }) {
  if (!v) return null;
  return <div className="text-xs"><span className="text-gray-500">{k}: </span><span className="text-gray-800">{v}</span></div>;
}
function Cap({ k, label, cap, setCap, type = 'text' }) {
  return (
    <div>
      <label className="text-[10px] text-gray-500">{label}</label>
      <input type={type} className="input input-sm w-full" value={cap[k] ?? ''} onChange={e => setCap({ ...cap, [k]: e.target.value })} />
    </div>
  );
}

function seedCapture(lead) {
  const out = {};
  for (const k of ['payment_ref', 'po_amount', 'dispatch_ref', 'purchase_bill_number', 'sales_bill_number', 'sales_bill_amount', 'receipt_amount', 'receipt_date', 'opted_out']) {
    out[k] = lead[k] ?? '';
  }
  return out;
}
function parseCandidates(po) {
  try { const v = JSON.parse(po.vendor_candidates_json || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function firstCandidate(po) {
  const c = parseCandidates(po);
  return c[0]?.name || '';
}
