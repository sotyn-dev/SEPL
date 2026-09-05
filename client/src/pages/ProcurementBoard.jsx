// SOP-07 Procurement Flow Board (mam 2026-08-28) — thin config over the
// shared FlowBoard component (design + behaviour live there; the SOP-05
// Rates Board reuses the same shell).
//
// 2026-08-31 (mam: "click on record → open pop of action like po approval"):
// clicking a record card in the Indent Approval or PO Approval columns opens
// an Approve/Reject popup right on the board instead of deep-linking.
//
// 2026-09-05 (mam: "here also open actions", after the Rates Board got the
// same): EVERY column's card now opens its own action popup — the stage's
// real action against the stage's real endpoint:
//   indent        → approve / reject                (PUT  /indents/:id)
//   rates         → 3 vendor quotes → finalise       (POST /item-rates, /item-rates/:id/finalize)
//   po_create     → Create Vendor PO (opens the tab's full form on this indent)
//   po_approval   → approve / reject                (POST /vendor-po/:id/po-approve|po-reject)
//   purchase_bill → expected-receipt date           (PUT  /vendor-po/:id)  + enter bill in tab
//   sales_bill    → generate Sales Bill / notes     (POST /delivery-notes/:id/generate-sales-bill, PUT /delivery-notes/:id)
//   received      → manual debit note on the GRN   (POST /debit-notes)
//   billed        → manual debit note on the bill  (POST /debit-notes)
// The popup is the SIMPLE action; qty overrides, from-store splits, the
// multer forms (PO / bill / receive-with-proof) still live in the tab —
// "Open in tab →" inside every popup. All authority checks stay server-side
// (RACI / Workflow-Settings approvers get a clear 403 message).
import { useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import FlowBoard from '../components/FlowBoard';
import Modal from '../components/Modal';
import { FiFileText, FiCheckCircle, FiTruck, FiPackage, FiCreditCard, FiAlertTriangle, FiClock, FiDollarSign, FiFilePlus, FiXCircle } from 'react-icons/fi';

// Tab keys must be ones Procurement.jsx accepts (VALID_TABS) — an unknown
// key silently lands on Indents. Dispatch / GRN live on 'delivery'.
const STAGE_LINKS = {
  indent: '/procurement?tab=indents',
  rates: '/procurement?tab=rates',
  po_create: '/procurement?tab=vendorpo',
  po_approval: '/procurement?tab=vendorpo',
  purchase_bill: '/procurement?tab=bills',
  sales_bill: '/procurement?tab=delivery',
  received: '/procurement?tab=delivery',
  billed: '/procurement?tab=bills',
};

const STAGE_ICONS = {
  indent: FiFileText, rates: FiDollarSign, po_create: FiFilePlus, po_approval: FiCheckCircle,
  purchase_bill: FiCreditCard, sales_bill: FiTruck, received: FiPackage, billed: FiFileText,
};

const STAGE_TITLES = {
  indent: 'Indent Approval', rates: 'Vendor Rates — 3 quotes → finalise', po_create: 'Create Vendor PO',
  po_approval: 'PO Approval', purchase_bill: 'Purchase Bill', sales_bill: 'Dispatch / Sales Bill',
  received: 'GRN · Debit Note', billed: 'Purchase Bill · Debit Note',
};

const DEBIT_TYPES = [
  { v: 'short_supply', l: 'Short supply' }, { v: 'rejected', l: 'Rejected material' }, { v: 'extra_rate', l: 'Extra rate (bill over PO)' },
];

const inr = (n) => `₹${(+n || 0).toLocaleString('en-IN')}`;

// What the popup's form starts with, per stage — pre-filled from the card
// so mam edits what is there instead of retyping it.
const initForm = (stage, card) => {
  switch (stage) {
    case 'rates': return {
      vendor1_name: card.vendor1_name || '', vendor1_rate: card.vendor1_rate || '',
      vendor2_name: card.vendor2_name || '', vendor2_rate: card.vendor2_rate || '',
      vendor3_name: card.vendor3_name || '', vendor3_rate: card.vendor3_rate || '',
      final_rate: card.final_rate || '', final_vendor_name: card.final_vendor_name || '',
    };
    case 'purchase_bill': return { expected_receipt_date: card.expected_receipt_date || '' };
    case 'sales_bill': return { notes: card.notes || '' };
    case 'received': return { type: 'short_supply', amount: '', reason: '' };
    case 'billed': return { type: 'extra_rate', amount: '', reason: '' };
    default: return { reason: '' };
  }
};

export default function ProcurementBoard() {
  // Action popup state — { stage, card, reload } + the stage's form.
  const [act, setAct] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const open = (stage, card, reload) => { setAct({ stage, card, reload }); setForm(initForm(stage, card)); };
  const close = () => { setAct(null); setForm({}); };
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const done = (msg) => { if (msg) toast.success(msg); act.reload(); close(); };
  const fail = (e, fallback) => toast.error(e.response?.data?.error || fallback);

  // ── indent / PO approval (2026-08-31) ───────────────────────────────
  const approve = async () => {
    if (!act || saving) return;
    setSaving(true);
    try {
      if (act.stage === 'indent') {
        const r = await api.put(`/procurement/indents/${act.card.rid}`, { status: 'approved' });
        done(r.data?.stage === 'l1_done' ? `${act.card.ref} — L1 approved, awaiting L2` : `${act.card.ref} approved`);
      } else {
        const r = await api.post(`/procurement/vendor-po/${act.card.rid}/po-approve`);
        done(r.data?.po_approval === 'pending_l2' ? `${act.card.ref} — L1 approved, awaiting L2` : `${act.card.ref} approved`);
      }
    } catch (e) { fail(e, 'Approve failed'); }
    finally { setSaving(false); }
  };

  const reject = async () => {
    if (!act || saving) return;
    const r = String(form.reason || '').trim();
    if (r.length < 3) return toast.error('Please enter a rejection reason (min 3 chars)');
    setSaving(true);
    try {
      if (act.stage === 'indent') await api.put(`/procurement/indents/${act.card.rid}`, { status: 'rejected', reason: r });
      else await api.post(`/procurement/vendor-po/${act.card.rid}/po-reject`, { reason: r });
      done(`${act.card.ref} rejected`);
    } catch (e) { fail(e, 'Reject failed'); }
    finally { setSaving(false); }
  };

  // ── rates: save the 3 quotes, then finalise when a final rate + vendor
  // is given. Two calls because they are two gates on the server (the
  // finalise refuses until all 3 slots have name + rate). If finalise is
  // refused the quotes are still saved — the board reloads to show N/3.
  const saveRates = async () => {
    if (!act || saving) return;
    const c = act.card;
    const body = { indent_item_id: c.indent_item_id };
    for (const n of [1, 2, 3]) {
      // COALESCE upsert on the server: null keeps what was there.
      body[`vendor${n}_name`] = String(form[`vendor${n}_name`] || '').trim() || null;
      body[`vendor${n}_rate`] = +form[`vendor${n}_rate`] > 0 ? +form[`vendor${n}_rate`] : null;
    }
    const wantFinal = +form.final_rate > 0 || form.final_vendor_name;
    if (wantFinal && !(+form.final_rate > 0 && form.final_vendor_name)) return toast.error('To finalise, give BOTH the final rate and the final vendor');
    setSaving(true);
    try {
      const r = await api.post('/procurement/item-rates', body);
      const rateId = r.data?.id || c.rate_id;
      if (!wantFinal) return done('Quotes saved — finalise when all 3 are in');
      try {
        await api.post(`/procurement/item-rates/${rateId}/finalize`, { final_rate: +form.final_rate, final_vendor_name: form.final_vendor_name });
        done(`${c.ref} · rate finalised at ${inr(form.final_rate)} (${form.final_vendor_name})`);
      } catch (e) { fail(e, 'Finalise failed'); act.reload(); }
    } catch (e) { fail(e, 'Could not save the quotes'); }
    finally { setSaving(false); }
  };

  // ── purchase_bill: the expected-receipt date on the PO (the bill itself
  // is a file upload → tab).
  const savePoDate = async () => {
    if (!act || saving) return;
    setSaving(true);
    try {
      await api.put(`/procurement/vendor-po/${act.card.rid}`, { expected_receipt_date: form.expected_receipt_date || null });
      done(form.expected_receipt_date ? `${act.card.ref} — expected on ${form.expected_receipt_date}` : `${act.card.ref} — expected date cleared`);
    } catch (e) { fail(e, 'Could not save the date'); }
    finally { setSaving(false); }
  };

  // ── sales_bill: generate the Sales Bill from this dispatch (idempotent
  // on the server — returns the existing one), or save notes. Status is
  // sent back unchanged: the endpoint overwrites it, and "received" needs
  // the proof-photo receive flow in the tab.
  const generateSalesBill = async () => {
    if (!act || saving) return;
    setSaving(true);
    try {
      const r = await api.post(`/procurement/delivery-notes/${act.card.rid}/generate-sales-bill`);
      done(r.data?.existing ? `Sales Bill already exists — ${r.data.document_number}` : `Sales Bill ${r.data?.document_number || ''} generated${r.data?.is_draft ? ' (draft)' : ''}`);
    } catch (e) { fail(e, 'Could not generate the Sales Bill'); }
    finally { setSaving(false); }
  };
  const saveDnNotes = async () => {
    if (!act || saving) return;
    setSaving(true);
    try {
      await api.put(`/procurement/delivery-notes/${act.card.rid}`, { status: act.card.status || 'pending', notes: form.notes || null });
      done(`${act.card.ref} — notes saved`);
    } catch (e) { fail(e, 'Could not save the notes'); }
    finally { setSaving(false); }
  };

  // ── received / billed: a manual (discretionary) debit note against the
  // PO, linked to this GRN or bill. Variance-driven ones (short supply at
  // receive, bill over PO, rejected at GRN) are raised automatically.
  const raiseDebit = async () => {
    if (!act || saving) return;
    const c = act.card;
    if (!c.vendor_po_id) return toast.error('No vendor PO on this record — a debit note needs a PO');
    if (!(+form.amount > 0)) return toast.error('Enter the debit amount');
    const reason = String(form.reason || '').trim();
    if (reason.length < 3) return toast.error('Enter the reason (min 3 chars)');
    setSaving(true);
    try {
      const r = await api.post('/procurement/debit-notes', {
        type: form.type, vendor_po_id: c.vendor_po_id, amount: +form.amount, reason,
        grn_id: act.stage === 'received' ? c.rid : null,
        purchase_bill_id: act.stage === 'billed' ? c.rid : null,
      });
      done(`Debit note ${r.data?.dn_number || ''} raised — ${inr(form.amount)}`);
    } catch (e) { fail(e, 'Could not raise the debit note'); }
    finally { setSaving(false); }
  };

  // The tab where the FULL action UI lives, pre-filtered to just this record.
  const tabLink = act ? `${STAGE_LINKS[act.stage]}&q=${encodeURIComponent(act.card.ref)}` : '#';
  // po_create: land on the Vendor PO tab with the Create form already open
  // on this indent (Procurement.jsx consumes ?new=po&indent=).
  const createPoLink = act ? `${STAGE_LINKS.po_create}&new=po&indent=${act.card.rid}&q=${encodeURIComponent(act.card.ref)}` : '#';

  const quotesIn = act?.stage === 'rates'
    ? [1, 2, 3].filter(n => String(form[`vendor${n}_name`] || '').trim() && +form[`vendor${n}_rate`] > 0).length : 0;

  return (
    <>
    <FlowBoard
      cardAction={(stage, card, reload) => (card.rid ? () => open(stage, card, reload) : null)}
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

    {/* ── Action popup — the stage's action, right here on the board. */}
    <Modal isOpen={!!act} onClose={close} wide={act?.stage === 'rates'}
      title={act ? `${STAGE_TITLES[act.stage] || 'Action'} — ${act.card.ref}` : ''}>
      {act && (() => {
        const { stage, card } = act;
        return (
        <div className="space-y-3">
          {/* Record header */}
          <div className="bg-gray-50 rounded-lg p-3 text-sm">
            <div className="font-semibold">{card.title}</div>
            <div className="text-xs text-gray-500 mt-0.5">
              {stage === 'indent' && <>Raised by {card.owner || '—'}{card.items_n != null && <> · {card.items_n} item(s)</>} · awaiting approval</>}
              {stage === 'rates' && <>{card.quantity} {card.unit || ''}{card.make ? ` · ${card.make}` : ''} · {card.owner}</>}
              {stage === 'po_create' && <>{card.owner} · every item has a finalised rate</>}
              {(stage === 'po_approval' || stage === 'purchase_bill') && <>{card.owner}{+card.amount > 0 && <> · {inr(card.amount)}</>}</>}
              {stage === 'sales_bill' && <>{card.owner}{card.sales_bill_number && <> · Sales Bill {card.sales_bill_number}</>}</>}
              {stage === 'received' && <>Received by {card.owner || '—'}{card.grn_date && <> · {card.grn_date}</>}</>}
              {stage === 'billed' && <>{card.owner}</>}
            </div>
          </div>

          {/* Stage body */}
          {(stage === 'indent' || stage === 'po_approval') && (
            <div>
              <label className="label">Rejection Reason <span className="text-gray-400 font-normal text-[10px]">(only needed to reject)</span></label>
              <textarea className="input" rows="2" value={form.reason || ''} onChange={e => set('reason', e.target.value)}
                placeholder="Why is this being rejected?" />
            </div>
          )}

          {stage === 'rates' && (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {[1, 2, 3].map(n => (
                  <div key={n} className="border rounded-lg p-2.5 space-y-1.5">
                    <p className="text-[10px] font-bold text-gray-500 uppercase">Vendor {n}</p>
                    <input className="input text-xs" placeholder="Vendor name" value={form[`vendor${n}_name`] || ''}
                      onChange={e => set(`vendor${n}_name`, e.target.value)} />
                    <input className="input text-xs" type="number" min="0" step="any" placeholder="Rate" value={form[`vendor${n}_rate`] || ''}
                      onChange={e => set(`vendor${n}_rate`, e.target.value)} />
                  </div>
                ))}
              </div>
              <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
                <div>
                  <label className="label">Final Rate (finalise 🔒)</label>
                  <input className="input" type="number" min="0" step="any" value={form.final_rate || ''} onChange={e => set('final_rate', e.target.value)} />
                </div>
                <div>
                  <label className="label">Final Vendor</label>
                  <select className="select" value={form.final_vendor_name || ''} onChange={e => set('final_vendor_name', e.target.value)}>
                    <option value="">Select</option>
                    {[form.vendor1_name, form.vendor2_name, form.vendor3_name].map(v => String(v || '').trim()).filter(Boolean)
                      .filter((v, i, a) => a.indexOf(v) === i).map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
                <div className="text-[11px]">
                  {quotesIn >= 3
                    ? <span className="text-emerald-700 font-bold">✓ 3/3 quotes — can finalise</span>
                    : <span className="text-amber-700 font-bold">{quotesIn}/3 quotes — all 3 (name + rate) needed to finalise</span>}
                </div>
              </div>
              <p className="text-[10px] text-gray-400">Save Quotes keeps the slots you filled; the final rate + vendor finalises the item (the PO then picks it up). Terms / credit days / AI market rate live in the Rates tab.</p>
            </>
          )}

          {stage === 'po_create' && (
            <div className="text-sm text-gray-600 space-y-1">
              <p><b>{card.items_n || 0}</b> item(s) of <b>{card.ref}</b> are rate-finalised and not yet on any PO.</p>
              <p className="text-xs text-gray-500">The PO form (vendor, terms, per-item picks, PO file) opens in the Vendor PO tab already set to this indent.</p>
            </div>
          )}

          {stage === 'purchase_bill' && (
            <div>
              <label className="label">Expected receipt date</label>
              <input type="date" className="input" value={form.expected_receipt_date || ''} onChange={e => set('expected_receipt_date', e.target.value)} />
              <p className="text-[10px] text-gray-400 mt-1">The delay clock runs against this date. The bill itself (with its file) is entered in the Bills tab.</p>
            </div>
          )}

          {stage === 'sales_bill' && (
            <div className="space-y-2">
              <div className="text-xs text-gray-500">
                {card.document_type || 'dispatch'} · {card.received_at ? `received ${String(card.received_at).slice(0, 10)}` : 'in transit'}
                {card.sales_bill_number ? <> · Sales Bill <b>{card.sales_bill_number}</b> exists</> : null}
              </div>
              <div>
                <label className="label">Notes</label>
                <textarea className="input" rows="2" value={form.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Transport / remarks" />
              </div>
              <p className="text-[10px] text-gray-400">Marking received needs the stamped proof photo — that is in the Delivery tab.</p>
            </div>
          )}

          {(stage === 'received' || stage === 'billed') && (
            <div className="space-y-2">
              {!card.vendor_po_id && <p className="text-xs text-red-600 font-semibold">No vendor PO on this record — a debit note cannot be raised here.</p>}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="label">Debit type</label>
                  <select className="select" value={form.type || ''} onChange={e => set('type', e.target.value)}>
                    {DEBIT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                  </select>
                </div>
                <div>
                  <label className="label">Amount (₹)</label>
                  <input type="number" min="0" step="any" className="input" value={form.amount || ''} onChange={e => set('amount', e.target.value)} />
                </div>
              </div>
              <div>
                <label className="label">Reason</label>
                <textarea className="input" rows="2" value={form.reason || ''} onChange={e => set('reason', e.target.value)} placeholder="What is being debited and why" />
              </div>
              <p className="text-[10px] text-gray-400">Variance debit notes (short at receive, bill over PO, rejected at GRN) are raised automatically — this is for a manual / discretionary one.</p>
            </div>
          )}

          {/* Footer: tab link left, the stage's buttons right */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t">
            <div className="flex gap-2">
              <Link to={tabLink} onClick={close} className="btn btn-secondary text-xs">Open in tab →</Link>
              {(stage === 'received' || stage === 'billed') && (
                <Link to="/procurement?tab=debitnotes" onClick={close} className="btn btn-secondary text-xs">Debit notes →</Link>
              )}
            </div>
            <div className="flex gap-2">
              {(stage === 'indent' || stage === 'po_approval') && (
                <>
                  <button type="button" onClick={reject} disabled={saving} className="btn btn-danger flex items-center gap-1"><FiXCircle size={14} /> Reject</button>
                  <button type="button" onClick={approve} disabled={saving} className="btn btn-success flex items-center gap-1"><FiCheckCircle size={14} /> {saving ? 'Saving…' : 'Approve'}</button>
                </>
              )}
              {stage === 'rates' && (
                <button type="button" onClick={saveRates} disabled={saving} className="btn btn-primary">
                  {saving ? 'Saving…' : (+form.final_rate > 0 || form.final_vendor_name) ? '🔒 Save & Finalise' : 'Save Quotes'}
                </button>
              )}
              {stage === 'po_create' && (
                <Link to={createPoLink} onClick={close} className="btn btn-primary flex items-center gap-1"><FiFilePlus size={14} /> Create Vendor PO →</Link>
              )}
              {stage === 'purchase_bill' && (
                <>
                  <Link to={tabLink} onClick={close} className="btn btn-secondary text-xs">Enter purchase bill →</Link>
                  <button type="button" onClick={savePoDate} disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : 'Save date'}</button>
                </>
              )}
              {stage === 'sales_bill' && (
                <>
                  <button type="button" onClick={saveDnNotes} disabled={saving} className="btn btn-secondary text-xs">Save notes</button>
                  {card.document_type !== 'sales_bill' && (
                    <button type="button" onClick={generateSalesBill} disabled={saving} className="btn btn-primary flex items-center gap-1">
                      <FiFileText size={14} /> {card.sales_bill_number ? 'Open Sales Bill' : saving ? 'Generating…' : 'Generate Sales Bill'}
                    </button>
                  )}
                </>
              )}
              {(stage === 'received' || stage === 'billed') && (
                <button type="button" onClick={raiseDebit} disabled={saving || !card.vendor_po_id} className="btn btn-danger flex items-center gap-1">
                  <FiAlertTriangle size={14} /> {saving ? 'Raising…' : 'Raise Debit Note'}
                </button>
              )}
            </div>
          </div>
        </div>
        );
      })()}
    </Modal>
    </>
  );
}
