// SOP-07 Procurement Flow Board (mam 2026-08-28) — thin config over the
// shared FlowBoard component (design + behaviour live there; the SOP-05
// Rates Board reuses the same shell).
//
// 2026-08-31 (mam: "click on record → open pop of action like po approval"):
// clicking a record card in the Indent Approval or PO Approval columns opens
// an Approve/Reject popup right on the board instead of deep-linking. The
// popup is the SIMPLE action — approve as-is / reject with reason; qty
// overrides and from-store splits still live in the tab's full modal
// ("Open in tab →" inside the popup). All authority checks stay server-side
// (RACI / Workflow-Settings approvers get a clear 403 message).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import FlowBoard from '../components/FlowBoard';
import Modal from '../components/Modal';
import { FiFileText, FiCheckCircle, FiTruck, FiPackage, FiCreditCard, FiAlertTriangle, FiClock, FiDollarSign, FiFilePlus, FiXCircle } from 'react-icons/fi';

const STAGE_LINKS = {
  indent: '/procurement?tab=indents',
  rates: '/procurement?tab=rates',
  po_create: '/procurement?tab=vendorpo',
  po_approval: '/procurement?tab=vendorpo',
  purchase_bill: '/procurement?tab=bills',
  sales_bill: '/procurement?tab=dispatch',
  received: '/procurement?tab=dispatch',
  billed: '/procurement?tab=bills',
};

const STAGE_ICONS = {
  indent: FiFileText, rates: FiDollarSign, po_create: FiFilePlus, po_approval: FiCheckCircle,
  purchase_bill: FiCreditCard, sales_bill: FiTruck, received: FiPackage, billed: FiFileText,
};

export default function ProcurementBoard() {
  // Action popup state — { stage: 'indent' | 'po_approval', card, reload }.
  const [act, setAct] = useState(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const close = () => { setAct(null); setReason(''); };

  const approve = async () => {
    if (!act || saving) return;
    setSaving(true);
    try {
      if (act.stage === 'indent') {
        const r = await api.put(`/procurement/indents/${act.card.rid}`, { status: 'approved' });
        toast.success(r.data?.stage === 'l1_done' ? `${act.card.ref} — L1 approved, awaiting L2` : `${act.card.ref} approved`);
      } else {
        const r = await api.post(`/procurement/vendor-po/${act.card.rid}/po-approve`);
        toast.success(r.data?.po_approval === 'pending_l2' ? `${act.card.ref} — L1 approved, awaiting L2` : `${act.card.ref} approved`);
      }
      act.reload(); close();
    } catch (e) { toast.error(e.response?.data?.error || 'Approve failed'); }
    finally { setSaving(false); }
  };

  const reject = async () => {
    if (!act || saving) return;
    const r = String(reason || '').trim();
    if (r.length < 3) return toast.error('Please enter a rejection reason (min 3 chars)');
    setSaving(true);
    try {
      if (act.stage === 'indent') await api.put(`/procurement/indents/${act.card.rid}`, { status: 'rejected', reason: r });
      else await api.post(`/procurement/vendor-po/${act.card.rid}/po-reject`, { reason: r });
      toast.success(`${act.card.ref} rejected`);
      act.reload(); close();
    } catch (e) { toast.error(e.response?.data?.error || 'Reject failed'); }
    finally { setSaving(false); }
  };

  // The tab where the FULL action UI lives (qty overrides, from-store, etc.),
  // pre-filtered to just this record.
  const tabLink = act
    ? `${STAGE_LINKS[act.stage]}&q=${encodeURIComponent(act.card.ref)}`
    : '#';

  return (
    <>
    <FlowBoard
      cardAction={(stage, card, reload) =>
        (stage === 'indent' || stage === 'po_approval') && card.rid
          ? () => { setAct({ stage, card, reload }); setReason(''); }
          : null}
      title="Procurement Flow"
      subtitle="SOP-07 · Indent to material at site — live board"
      endpoint="/procurement/flow-board"
      stageLinks={STAGE_LINKS}
      stageIcons={STAGE_ICONS}
      openTo={{ link: '/procurement', label: 'Open Procurement' }}
      distsOf={(d) => [
        { title: 'Indent Status Distribution', data: d.indentDist || [] },
        { title: 'PO Stage Distribution', data: d.poDist || [] },
      ]}
      extraTiles={(d) => [
        { label: 'Open Debit Notes', title: 'Open Debit Notes — S10 short/bad material',
          value: d.kpis.debit_open.value, sub: 'S10 short/bad', subClass: 'text-gray-400',
          icon: FiAlertTriangle, iconClass: 'bg-red-100 text-red-600', cardClass: 'bg-red-50 border-red-100' },
        ...(d.kpis.overdue ? [{
          label: 'Overdue Process', title: 'Overdue Process — past the SOP clock, in hours',
          value: d.kpis.overdue.value,
          sub: d.kpis.overdue.value > 0 ? `oldest ${d.kpis.overdue.oldest_hrs} hrs` : 'on time ✓',
          subClass: d.kpis.overdue.value > 0 ? 'text-amber-700 font-semibold' : 'text-emerald-600',
          icon: FiClock,
          iconClass: d.kpis.overdue.value > 0 ? 'bg-amber-100 text-amber-600' : 'bg-emerald-100 text-emerald-600',
          cardClass: d.kpis.overdue.value > 0 ? 'bg-amber-50 border-amber-200' : '',
        }] : []),
      ]}
      activityBadge={(k) => ({
        indent: { bg: 'bg-violet-500', txt: 'IN' }, po: { bg: 'bg-blue-500', txt: 'PO' },
        grn: { bg: 'bg-emerald-500', txt: 'GR' }, bill: { bg: 'bg-amber-500', txt: '₹' },
        debit: { bg: 'bg-red-500', txt: 'DN' },
      }[k] || { bg: 'bg-gray-400', txt: '·' })}
    />

    {/* ── Action popup (mam 2026-08-31) — approve/reject the record right
        here, PO-approval style. */}
    <Modal isOpen={!!act} onClose={close}
      title={act ? `${act.stage === 'indent' ? 'Indent Approval' : 'PO Approval'} — ${act.card.ref}` : ''}>
      {act && (
        <div className="space-y-3">
          <div className="bg-gray-50 rounded-lg p-3 text-sm">
            <div className="font-semibold">{act.card.title}</div>
            {act.stage === 'indent' ? (
              <div className="text-xs text-gray-500 mt-0.5">
                Raised by {act.card.owner || '—'}
                {act.card.items_n != null && <> · {act.card.items_n} item(s)</>}
                {' '}· awaiting approval
              </div>
            ) : (
              <div className="text-xs text-gray-500 mt-0.5">
                {act.card.owner}
                {+act.card.amount > 0 && <> · ₹{(+act.card.amount).toLocaleString('en-IN')}</>}
              </div>
            )}
          </div>
          <div>
            <label className="label">Rejection Reason <span className="text-gray-400 font-normal text-[10px]">(only needed to reject)</span></label>
            <textarea className="input" rows="2" value={reason} onChange={e => setReason(e.target.value)}
              placeholder="Why is this being rejected?" />
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
            {/* Full modal (qty overrides / from-store / line edits) lives in the tab. */}
            <Link to={tabLink} onClick={close} className="btn btn-secondary text-xs">Open in tab →</Link>
            <div className="flex gap-2">
              <button type="button" onClick={reject} disabled={saving}
                className="btn btn-danger flex items-center gap-1"><FiXCircle size={14} /> Reject</button>
              <button type="button" onClick={approve} disabled={saving}
                className="btn btn-success flex items-center gap-1"><FiCheckCircle size={14} /> {saving ? 'Saving…' : 'Approve'}</button>
            </div>
          </div>
        </div>
      )}
    </Modal>
    </>
  );
}
