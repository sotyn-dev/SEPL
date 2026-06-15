import { useState, useEffect } from 'react';
import toast from 'react-hot-toast';
import { FiChevronDown, FiChevronUp, FiFlag } from 'react-icons/fi';
import Drawer from './funnel/Drawer';
import PhaseStepper from './funnel/PhaseStepper';
import useLeadDecision from '../hooks/useLeadDecision';
import { leadFunnel } from '../api';
import { stageLabel } from '../data/l2dStages';
import { fmtIST } from '../utils/dateIST';

const money = (n) => '₹' + (Number(n) || 0).toLocaleString('en-IN');

// Lead workspace in a full-height side drawer. The spine is a 6-milestone stepper
// (PhaseStepper) whose current node shows the one due action; client/enquiry/AI
// context sits in a collapsed accordion below to keep the action front-and-centre.
export default function FunnelLeadDrawer({ leadId, onClose, onChanged }) {
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
  const messages = data?.messages || [];
  const decision = useLeadDecision(lead, messages);

  // Gate decisions (approve / reject / price / send template).
  const advance = async (body) => {
    setBusy(true);
    try {
      await leadFunnel.advance(leadId, body);
      toast.success(`Moved to ${stageLabel(body.to)}`);
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusy(false); }
  };

  const setStage = async (stage) => {
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

  // Persist the current stage's fields, then move the pointer — one reload, no flicker.
  const saveAndAdvance = async (nextKey) => {
    setBusy(true);
    try {
      await leadFunnel.update(leadId, cap);
      if (nextKey) await leadFunnel.setStage(leadId, { stage: nextKey });
      toast.success(nextKey ? `Saved · moved to ${stageLabel(nextKey)}` : 'Saved');
      load(); onChanged?.();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    finally { setBusy(false); }
  };

  return (
    <Drawer isOpen={!!leadId} onClose={onClose} header={lead ? <LeadTitle lead={lead} /> : 'Lead'}>
      {loading || !lead ? (
        <div className="text-sm text-gray-400 py-8 text-center">Loading…</div>
      ) : (
        <div className="space-y-5">
          <ContextPanel lead={lead} />
          <PhaseStepper
            lead={lead}
            decision={decision}
            history={data.history || []}
            messages={messages}
            cap={cap}
            setCap={setCap}
            busy={busy}
            onAdvance={advance}
            onSave={saveCapture}
            onSaveAndAdvance={saveAndAdvance}
            onSetStage={setStage}
          />
        </div>
      )}
    </Drawer>
  );
}

// Collapsible reference context — Client / Enquiry / AI — kept out of the way.
function ContextPanel({ lead }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="border rounded-md p-3">
      <button onClick={() => setOpen(!open)} className="w-full flex items-center justify-between">
        <div className="flex items-center justify-start text-sm font-semibold text-blue-700">
          <FiFlag size={14} className="text-blue-700 mr-1" />
          Lead details
        </div>
        {open ? <FiChevronDown size={14} className="text-gray-400" /> : <FiChevronUp size={14} className="text-gray-400" />}
      </button>
      {open && (
        <div className="mt-3 space-y-4">
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
              {lead.quoted_price > 0 && <Field k="Quoted price" v={`${money(lead.quoted_price)} (${lead.price_source || ''})`} />}
            </Section>
          )}
        </div>
      )}
    </div>
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

// Drawer header: unique_query_id as bold title, sender_name subtitle, stage pill.
function LeadTitle({ lead }) {
  return (
    <div className="flex items-center gap-3 min-w-0">
      <div className="min-w-0">
        <div className="font-bold text-gray-900 text-base leading-tight truncate">#{lead.unique_query_id || lead.id}</div>
        {lead.sender_name && <div className="text-xs text-gray-500 font-normal leading-tight truncate">{lead.sender_name}</div>}
      </div>
      <StageBadge stage={lead.stage} />
    </div>
  );
}

const STAGE_BADGE_COLORS = {
  NEEDS_REVIEW: 'bg-amber-100 text-amber-700',
  REJECTED: 'bg-red-100 text-red-700',
  CALL_REQUESTED: 'bg-blue-100 text-blue-700',
  KEEP_IN_TOUCH: 'bg-green-100 text-green-700',
};

function StageBadge({ stage }) {
  const cls = STAGE_BADGE_COLORS[stage] || 'bg-gray-100 text-gray-600';
  return <span className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ${cls}`}>{stageLabel(stage)}</span>;
}

function seedCapture(lead) {
  const out = {};
  for (const k of ['payment_ref', 'payment_amount', 'po_amount', 'dispatch_ref', 'purchase_bill_number', 'sales_bill_number', 'sales_bill_amount', 'receipt_amount', 'receipt_date', 'opted_out']) {
    out[k] = lead[k] ?? '';
  }
  return out;
}
