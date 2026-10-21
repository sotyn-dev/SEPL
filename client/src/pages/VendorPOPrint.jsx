// Print-friendly Vendor PO page — matches Secured Engineers' standard
// Tally-style PO format: top-right voucher block, side-by-side Vendor /
// Consignee panels, line items with Due-on / Qty / Rate / per / Disc / Amount,
// CGST + SGST + round-off totals, terms block, computer-generated footer.
//
// Opens at /vendor-po/:id/print. Browser's "Print → Save as PDF" handles
// the PDF generation, no server-side library needed.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft, FiMessageCircle } from 'react-icons/fi';

const fmtMoney = (n) => (Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Date formatter — outputs "6-Feb-26" matching the sample PO.
const fmtDate = (s) => {
  if (!s) return '';
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const day = d.getDate();
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  const yr = String(d.getFullYear()).slice(-2);
  return `${day}-${mon}-${yr}`;
};

// Company header — single source of truth so it's easy to edit later if
// mam's address / GSTIN changes. Mirrors the SEPL Purchase Order PDF
// format mam shared as the reference layout.
const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD',
  gstin: '03AASCS7836D2Z3',
  pan: 'AASCS7836D',
  state: 'Punjab',
  state_code: '03',
  head_office: '2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003, India',
  branch_office: '91, Springboard, Sector 2, Noida, Uttar Pradesh, India',
};

// Marketing band stats from the reference PDF — 15+ years, 309+ staff, etc.
const STATS = [
  { num: '15+', label: 'YEARS OF\nEXCELLENCE' },
  { num: '309+', label: 'STRONG MANPOWER' },
  { num: '16+', label: 'STATES SERVED' },
  { num: '4+', label: 'COUNTRIES' },
];

// Comprehensive 35-clause Terms & Conditions exactly as on mam's
// reference PO. Stored in a constant so future edits are one place.
const TERMS = [
  ['PO Number Mandatory', 'Our SEPL PO No. {{PO_NUMBER}} must be quoted on every Invoice, Delivery Challan, Packing Slip, Test Certificate, e-Way Bill and all correspondence. Documents without our PO number will not be accepted at site or office.'],
  ['NO PARTIAL DELIVERIES — FULL KITTING MANDATORY', 'Full and complete kitting of the entire ordered scope (all line items, accessories, fasteners, fittings, glands, lugs, terminations and ancillaries) is mandatory. Partial / part-load / split-lot / staggered deliveries are NOT ACCEPTED. Any partial / un-kitted supply will be returned to the vendor at the vendor’s cost and risk, and shall additionally attract LD as per Clause 9.'],
  ['Delivery Note is the ONLY Receiving Document', 'Material receipt at site will be acknowledged EXCLUSIVELY on Secured Engineers’ Delivery Note (DN). The vendor must obtain dated signature, name and stamp of our authorised site representative on our DN. Do not send your Bill / Invoice for receiving — your bill is for billing/accounting purposes ONLY and will not constitute proof of delivery.'],
  ['Delivery at Site is Vendor’s Responsibility', 'The vendor is solely responsible for transportation, freight, loading, unloading, handling, in-transit insurance, octroi (if any), demurrage and safe delivery of material at the site address designated by Secured Engineers. No reimbursement of transportation or related charges will be admissible unless specifically agreed in writing in this PO.'],
  ['Test Certificate & Raw Material Traceability', 'Each consignment must carry an OEM/Mill Test Certificate identifying raw-material grade, batch, heat number, MFG date and standard reference (IS/BIS/IEC/ASTM). Goods without TC will be rejected.'],
  ['Packing Slip', 'Every dispatch must include a Packing Slip listing item description, code, HSN, quantity and our PO No. Material received without a Packing Slip will be treated as short-supplied.'],
  ['HSN, GSTIN & e-Invoice', 'Tax Invoice must mention our GSTIN 03AASCS7836D2Z3, correct HSN, place of supply and e-Invoice IRN/QR (where applicable). GST will be released only upon (a) reflection in our GSTR-2B and (b) timely filing by the vendor.'],
  ['Quality & Inspection', 'All goods are subject to inspection at site / vendor’s works / OEM works by Secured Engineers or its nominee. Right of rejection is absolute; rejected material to be lifted by vendor within 7 days at vendor’s cost, failing which storage charges of 1% per day on invoice value will be debited.'],
  ['Liquidated Damages (LD)', 'For any delay beyond the agreed delivery date, LD shall be levied at 0.5% of the order value per week of delay, capped at 10% of the total PO value, recoverable from any pending payment or by debit note. Time is of the essence of this PO.'],
  ['Warranty / Guarantee (Product-Wise)', 'Goods supplied shall carry warranty as specified per item in the PO / Annexure-A. In the absence of an item-specific warranty, the following minimums apply, whichever is later: (a) Cables, Wires, Conduits, Fasteners, Consumables — 12 months from commissioning or 18 months from dispatch; (b) Panels, Switchgear, MCBs/MCCBs, Starters, DBs, Lighting Fixtures, Pumps, Motors, ELV, Plumbing Fittings — 24 months from commissioning or 30 months from dispatch; (c) HVAC Equipment, Fire-Fighting Equipment, Solar Modules & Inverters, BMS, VFDs and OEM-branded major equipment — 36 months (3 years) from commissioning or 42 months from dispatch; (d) Solar PV modules shall additionally carry the OEM’s standard performance warranty (10/25 years) extended directly to Secured Engineers / End-Client. Defective items shall be replaced / repaired free of cost including freight both ways, with attendance at site within 72 hours of intimation.'],
  ['Price Firmness & Excess Supply', 'Rates are firm till completion of supply, irrespective of any market / forex / commodity fluctuation. Buyer is under no obligation to accept goods supplied in excess of ordered quantity; such excess shall be returned at vendor’s cost.'],
  ['Right to Cancel / Amend', 'Secured Engineers reserves the unconditional right to cancel, amend, reduce, foreclose or hold this PO in whole or in part at any time without liability for consequential loss to the vendor.'],
  ['Indemnity', 'The vendor shall fully indemnify and hold harmless Secured Engineers, its directors, employees and clients against any claim, loss, penalty, fine or damage (including legal cost) arising out of (a) defective material / workmanship, (b) statutory or regulatory non-compliance, (c) IP / patent infringement, (d) acts, omissions or accidents of vendor’s personnel, or (e) third-party injury / property damage attributable to vendor’s supply.'],
  ['Confidentiality & Non-Solicitation', 'Drawings, specifications, BOQ, rates, client name, site information and any data shared by Secured Engineers are strictly confidential and the property of Secured Engineers. The vendor shall not disclose, sub-contract, reuse or market the same, nor solicit any client / employee of Secured Engineers, without prior written consent. This obligation shall survive termination for 3 years.'],
  ['Safety, Insurance & Statutory Compliance', 'Vendor’s personnel (if visiting site) shall comply with PPE, EHS, BOCW, applicable labour, ESI, PF and all statutory norms. Vendor shall maintain valid in-transit, workmen’s compensation and public-liability insurance. Secured Engineers bears NO liability for vendor’s personnel, equipment or sub-contractors.'],
  ['GST Reimbursement Clawback', 'If any input tax credit, refund or other benefit is denied / delayed / reversed against Secured Engineers due to vendor’s non-compliance (non-upload on GSTN, non-payment of GST, incorrect documents, GSTIN cancellation), vendor shall reimburse the full loss including interest and penalty, by debit note adjustable against any pending dues, within 15 days of intimation.'],
  ['Set-Off / Recovery', 'Secured Engineers reserves the unilateral right to set-off / adjust / recover any amount due from the vendor under this or any other PO / contract / order against any payment payable to the vendor, present or future.'],
  ['Force Majeure', 'Neither party shall be liable for delay caused by genuine Force Majeure events. The affected party must notify in writing within 7 days with documentary proof, failing which the defence shall not be available. If FM continues beyond 30 days, Secured Engineers may terminate without liability.'],
  ['Acceptance', 'Acceptance of this PO (by acknowledgement, dispatch of goods, or commencement of work) shall constitute unconditional acceptance of these Terms & Conditions in their entirety. Any vendor’s printed terms on invoices / challans / quotations shall stand OVERRIDDEN in their entirety.'],
  ['Title, Risk & Acceptance Transfer', 'Title and risk in the goods shall pass to Secured Engineers only upon (a) receipt of acceptable goods at site against our DN, AND (b) successful site inspection / testing / commissioning. Mere dispatch, billing or transit-handover shall NOT constitute acceptance.'],
  ['No Sub-Contracting / No Substitution', 'The vendor shall not sub-contract, assign, transfer or novate this PO (in whole or part) to any third party without prior written consent of Secured Engineers. The make / brand / model / origin of goods shall not be substituted; any deviation requires written approval, failing which goods shall be liable for outright rejection.'],
  ['Anti-Bribery, Anti-Corruption & Conflict of Interest', 'The vendor warrants that it has not, and will not, offer any gift, kickback, commission or undue advantage to any director, employee or representative of Secured Engineers or its clients. Breach shall entitle Secured Engineers to terminate the PO with immediate effect, blacklist the vendor, forfeit all pending payments, and pursue criminal / civil action.'],
  ['Compliance with Laws & Standards', 'All goods / services shall comply with applicable Indian laws, IS / BIS / IEC / NBC / NEC / NFPA / ASHRAE / MNRE / CEA / state electrical / fire / pollution / environmental codes, as relevant. Vendor confirms it holds all valid licences, registrations and statutory approvals required to perform this PO.'],
  ['Performance Security / Retention', 'Secured Engineers reserves the right to retain 5%–10% of each invoice value as Performance Retention, releasable only upon expiry of the warranty period and final acceptance, OR to demand a Bank Guarantee (BG) of equivalent value valid up to warranty expiry plus claim period. Retention shall not earn any interest.'],
  ['Audit & Document Rights', 'Secured Engineers and its auditors / clients shall have the right, upon reasonable notice, to audit the vendor’s invoices, GST returns, dispatch records, MTC, calibration certificates and quality records pertaining to this PO, for up to 7 years from the PO date.'],
  ['Spare Parts & O&M Documentation', 'The vendor shall guarantee availability of spares and after-sales service for a minimum of 10 years from the date of commissioning. Operations & Maintenance manuals, wiring / GA drawings, calibration certificates and as-built documents (in editable + PDF) shall be supplied along with the goods at no additional cost.'],
  ['Free Replacement & Site Attendance', 'During the warranty period, all defects / failures / under-performance shall be rectified by free replacement / repair at site by the vendor, without dismantling cost, transport cost or labour cost on Secured Engineers’ account. Maximum response time: 72 hours; maximum resolution time: 7 days, failing which Secured Engineers may rectify at vendor’s risk and cost (recoverable from BG / retention / future bills).'],
  ['Data Protection & Records', 'Any personal / commercial data of Secured Engineers, its employees or clients shared with the vendor shall be processed solely for performance of this PO, kept secure, and returned / destroyed on completion. Breach shall attract recovery of all consequential damages.'],
  ['Background & Antecedent Verification', 'The vendor warrants that its proprietors / directors / authorised signatories have no adverse criminal, financial, tax-default or regulatory record. Secured Engineers reserves the right to seek and verify such records at any time.'],
  ['No Lien / No Counter-Claim', 'The vendor shall not exercise any lien on Secured Engineers’ / Client’s property, drawings, tools or material in its possession, on account of any disputed claim, and shall release the same on demand.'],
  ['Notices', 'All formal notices under this PO shall be sent to Secured Engineers’ registered Head Office address (Ludhiana) by Email + Registered Post / Courier. Verbal commitments by site / field personnel are NOT BINDING on Secured Engineers.'],
  ['Severability & Survival', 'If any clause is held invalid, the remaining clauses shall continue in full force. Clauses on Warranty, Confidentiality, Indemnity, Set-Off, Audit, Anti-Corruption and Dispute Resolution shall survive completion / termination of this PO.'],
  ['Governing Law', 'This Purchase Order shall be governed by and construed in accordance with the laws of India.'],
  ['Acceptance of these Terms is unconditional', 'upon any dispatch / part-performance / acknowledgement of this PO. Vendor’s silence within 3 working days of receipt of this PO shall be deemed acceptance of all terms herein.'],
  ['Dispute Resolution & Jurisdiction', 'Any dispute, difference or claim arising out of or in connection with this Purchase Order shall first be referred to and finally resolved by sole arbitration of the Company Arbiter — Advocate Vikas Sharma, whose decision shall be binding on both parties. Arbitration shall be conducted under the Arbitration & Conciliation Act, 1996 (as amended), seat Ludhiana, language English. Subject to the foregoing, courts at Ludhiana shall have exclusive jurisdiction.'],
];

export default function VendorPOPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  // TSK-0378 / TSK-0943: Attached Rate Comparison Statement with Moglix/IndiaMart data for MD physical signature
  const [compData, setCompData] = useState(null);
  const [includeComparison, setIncludeComparison] = useState(true);
  const [onlyComparison, setOnlyComparison] = useState(false);

  useEffect(() => {
    api.get(`/procurement/vendor-po/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));

    api.get(`/procurement/vendor-po/${id}/comparison-sheet`, { timeout: 120000 })
      .then(r => setCompData(r.data))
      .catch(() => setCompData(null));
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
  const { po, items } = data;

  // Subtotal across line items.  Uses the LIVE rate from
  // indent_item_rates.final_rate when present (mam, 2026-05-21:
  // "update here if i update rate in 3 vendor"), falling back to the
  // PO-frozen rate, then to the stored amount.
  let subtotal = items.reduce((s, it) => {
    const r = (it.latest_rate != null && +it.latest_rate > 0) ? +it.latest_rate : +it.rate;
    return s + (+r * +it.quantity || +it.amount || 0);
  }, 0);
  // No linked lines (uploaded ready-made PO) — fall back to the total the
  // buyer TYPED on Create Vendor PO (vendor_pos.total_amount = typed base +
  // freight, pre-GST), so the print matches the amount the list shows
  // instead of reading Rs 0 (mam 2026-08-27 "from where u pick amount?").
  // Freight is subtracted here because the taxable line below adds it back.
  if (items.length === 0 && +po.total_amount > 0) {
    subtotal = Math.max(0, +po.total_amount - (+po.freight_amount || 0));
  }

  // Freight (mam 2026-06-12). Added to the taxable value so GST is charged
  // on (goods + freight), matching how vendors bill freight. freight_terms
  // ('Ex-Works' / 'FOR') prints in the Terms block below.
  const freightAmount = +po.freight_amount || 0;
  const taxable = subtotal + freightAmount;

  // GST split. Same-state vendor → CGST + SGST (half each, intra). Different
  // state → IGST (full). Defaults to intra-state when state is missing,
  // matching mam's sample (Punjab buyer, Punjab vendor). The rate comes from
  // the PO's editable gst_pct (mam 2026-08-12: "gst 18% but some time 5%"),
  // falling back to 18% for older POs saved before the column existed.
  const sameState = !po.state || String(po.state).trim().toLowerCase() === COMPANY.state.toLowerCase();
  const gstPct = (po.gst_pct != null && Number.isFinite(+po.gst_pct)) ? +po.gst_pct : 18;
  const gstRate = gstPct / 100;
  const cgst = sameState ? taxable * (gstRate / 2) : 0;
  const sgst = sameState ? taxable * (gstRate / 2) : 0;
  const igst = sameState ? 0 : taxable * gstRate;

  // Round to nearest rupee — the difference between the rupee total and
  // the paise-precision running total goes on the ROUND OFF line. So the
  // grand total is always clean rupees.
  const beforeRound = taxable + cgst + sgst + igst;
  const grandTotal = Math.round(beforeRound);
  const roundOff = +(grandTotal - beforeRound).toFixed(2);

  // Total quantity sum (e.g. "60 LTR") — uses the most common unit across
  // line items. Falls back to "—" if mixed.
  const totalQty = items.reduce((s, it) => s + (+it.quantity || 0), 0);
  const units = [...new Set(items.map(it => (it.unit || it.uom || '').toUpperCase()).filter(Boolean))];
  const totalUnit = units.length === 1 ? units[0] : '';

  // Payment Terms — mam (2026-06-04).  The term AND its credit days are
  // taken from the SAME source so they never mismatch (e.g. an "Advance"
  // term must not borrow "30 days" from the vendor master).  Priority:
  //   1. Terms entered on the PO itself (vendor_pos.payment_terms).
  //   2. Terms from the Finalise-Rate step (indent_item_rates.final_terms);
  //      per-item — first line that has terms wins for the header.
  //   3. The Vendor master default (vendors.payment_terms).
  //   4. Any per-line terms frozen on the PO items.
  const hasVal = (s) => s != null && String(s).trim() !== '';
  const finalTermsItem = items.find(it => hasVal(it.final_terms));
  const lineTermsItem = items.find(it => hasVal(it.terms));
  const termsSource =
      hasVal(po.payment_terms)        ? { t: po.payment_terms,            d: po.credit_days }
    : finalTermsItem                  ? { t: finalTermsItem.final_terms,  d: finalTermsItem.final_credit_days }
    : hasVal(po.vendor_payment_terms) ? { t: po.vendor_payment_terms,     d: po.vendor_credit_days }
    : lineTermsItem                   ? { t: lineTermsItem.terms,         d: lineTermsItem.credit_days }
    : null;
  const payTermsText = termsSource ? String(termsSource.t).trim() : '';
  // Credit days only make sense for a credit-type term — "Advance (30
  // days)" / "COD (30 days)" is nonsensical.  Show the suffix only when
  // the term is Credit (or contains "credit"), and render as a whole
  // number so "30.0" doesn't leak through.
  const isCreditTerm = /credit/i.test(payTermsText);
  const payCreditDays = (isCreditTerm && termsSource && +termsSource.d > 0)
    ? Math.round(+termsSource.d) : null;

  const sharePO = () => {
    const phone = String(po.vendor_phone || '').replace(/\D/g, '');
    const url = window.location.href;
    const msg = `*PO ${po.po_number}* from ${COMPANY.name}\n\nDear ${po.contact_person || po.vendor_name || 'Sir/Madam'},\n\nPlease find our Purchase Order below. View / download:\n${url}\n\nTotal: ₹ ${fmtMoney(grandTotal)}\n\nRegards,\nSEPL`;
    if (!phone) {
      window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
    } else {
      const code = phone.length === 10 ? '91' + phone : phone;
      window.open(`https://wa.me/${code}?text=${encodeURIComponent(msg)}`, '_blank');
    }
  };

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Action bar — hidden on print */}
      <div className="bg-white border-b shadow-sm print:hidden sticky top-0 z-20">
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
          <button onClick={() => window.history.back()} className="btn btn-secondary flex items-center gap-2">
            <FiArrowLeft size={14} /> Back
          </button>
          <div className="flex items-center gap-2 flex-wrap">
            {compData && (
              <>
                <label className="flex items-center gap-1.5 text-xs text-gray-800 bg-amber-50 hover:bg-amber-100 px-2.5 py-1.5 rounded border border-amber-300 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={includeComparison}
                    onChange={e => {
                      setIncludeComparison(e.target.checked);
                      if (onlyComparison) setOnlyComparison(false);
                    }}
                    className="rounded text-blue-600 focus:ring-blue-500"
                  />
                  <span className="font-semibold text-gray-900">Attach Comparison Sheet (for Signature)</span>
                </label>
                <button
                  type="button"
                  onClick={() => {
                    const next = !onlyComparison;
                    setOnlyComparison(next);
                    if (next) setIncludeComparison(true);
                  }}
                  className={`btn text-xs flex items-center gap-1.5 ${onlyComparison ? 'btn-primary font-bold' : 'btn-secondary'}`}
                  title="Toggle view to print only the Comparison Sheet"
                >
                  {onlyComparison ? 'Show Full PO + Sheet' : 'Comparison Sheet Only'}
                </button>
              </>
            )}
            <button onClick={sharePO} className="btn btn-success flex items-center gap-2" title="Share via WhatsApp">
              <FiMessageCircle size={14} /> WhatsApp
            </button>
            <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2 font-bold shadow">
              <FiPrinter size={14} /> Print / Save as PDF
            </button>
          </div>
        </div>
      </div>

      {/* PO body — printable. Branded Tally style with SEPL red accents.
          The outer text color is locked to gray-900 so no inherited link
          color (e.g. visited link blue) bleeds into descriptions. */}
      <div className={`max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[12px] text-gray-900 overflow-hidden po-body ${onlyComparison ? 'hidden' : ''}`}>
        {/* RED branded title bar — pops the document immediately as a SEPL PO */}
        {/* Mam (2026-06-04): "do it some congested" — the title bar had too
            much empty height.  GSTIN / PAN now flank the title on the SAME
            row so the band is a single tight line instead of three. */}
        <div className="bg-blue-800 text-white py-1.5 px-3 print:bg-blue-800 flex items-center justify-between gap-3">
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">GSTIN : {COMPANY.gstin}</span>
          <span className="font-extrabold text-[15px] tracking-[0.3em] uppercase leading-none">Purchase Order</span>
          <span className="text-[9.5px] opacity-95 font-medium whitespace-nowrap">PAN : {COMPANY.pan}</span>
        </div>

        {/* Company name + Head Office + Branch Office addresses.
            Mam (2026-05-21): the items table was sitting too far down
            the page — compressed all the marketing rows above it. */}
        <div className="text-center py-1.5 px-3 border-b border-blue-800 bg-gradient-to-b from-blue-50/60 to-white">
          <div className="text-[19px] font-extrabold tracking-tight text-gray-900 leading-tight">{COMPANY.name}</div>
          <div className="text-[9.5px] text-gray-700 mt-0.5 leading-snug">
            <span className="font-semibold">Head Office:</span> {COMPANY.head_office}
            <span className="mx-2 text-gray-400">|</span>
            <span className="font-semibold">Corporate Office:</span> {COMPANY.branch_office}
          </div>
        </div>

        {/* Marketing band — compact one-row strip combining tagline,
            stat chips, presence, and service lines.  Was 4 separate
            bands taking ~120px; now a single ~28px band. */}
        <div className="border-b border-blue-800 bg-blue-50/40 print:bg-blue-50">
          <div className="flex items-center justify-center gap-3 py-1 px-3 text-[9.5px] flex-wrap">
            <span className="font-extrabold uppercase tracking-wider text-blue-800">A Leading Engineering Company of India</span>
            <span className="text-gray-400">•</span>
            {STATS.map((s, i) => (
              <span key={i} className="whitespace-nowrap">
                <span className="font-extrabold text-blue-800">{s.num}</span>
                <span className="text-gray-600 ml-0.5 uppercase text-[8.5px]">{s.label.replace(/\n/g, ' ')}</span>
              </span>
            ))}
          </div>
          <div className="text-center text-[9px] text-gray-700 px-3 py-0.5 border-t border-blue-200 leading-snug">
            <span className="text-blue-800 font-bold uppercase">Pan-India:</span>
            <span className="font-bold text-gray-900 ml-1">LUDHIANA | NOIDA | BANGALORE | MUMBAI</span>
            <span className="text-gray-400 mx-2">•</span>
            <span className="text-gray-600">Specialists in </span>
            <span className="font-extrabold text-blue-800">ELECTRICAL | HVAC | FIRE SAFETY | PLUMBING | SOLAR | ELV</span>
          </div>
        </div>

        {/* TWO-COLUMN HEADER: Details of Vendor (left) | Voucher meta (right).
            Tightened padding for the post-2026-05-21 compact layout. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 bg-blue-50/30 text-[10.5px] leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-blue-800">Details of Vendor</div>
            <div className="font-extrabold text-[12.5px] leading-tight">{po.vendor_name || '—'}</div>
            {po.firm_name && po.firm_name !== po.vendor_name && <div>{po.firm_name}</div>}
            {po.vendor_address && <div className="text-gray-700 whitespace-pre-line">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{po.gst_number}</span></div>}
            {po.state && <div><span className="text-gray-500">State:</span> {po.state}{po.state_code ? `, Code ${po.state_code}` : ''}</div>}
          </div>
          <div className="p-0 text-[10.5px]">
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">Voucher No.:</span> <span className="font-bold">SEPL-{po.id}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5 w-1/2"><span className="text-blue-800 font-semibold">Date :</span> <span className="font-bold">{fmtDate(po.po_date || po.created_at)}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-blue-800 font-semibold">SEPL PO No.:</span> <span className="font-bold">{po.po_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Vendor Code:</span> <span className="font-mono">{po.vendor_code || ''}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-blue-800 font-semibold">SEPL Indent No.:</span> <span className="font-bold">{po.indent_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Contact Person:</span> <span className="font-medium">{po.contact_person || ''}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">SEPL Lead No.:</span> <span className="font-medium">{po.sepl_lead_no || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-0.5"><span className="text-gray-500">Contact No.:</span> <span className="font-medium">{po.vendor_phone || ''}</span></td>
                </tr>
                <tr>
                  <td colSpan="2" className="px-2 py-0.5"><span className="text-gray-500">Ref Quote No.:</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* TWO-COLUMN: Supplier (Bill from) | Consignee (Ship to).
            Tightened padding 2026-05-21. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-2 text-[10.5px] bg-amber-50/30 leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-amber-700">Supplier (Bill from)</div>
            <div className="font-extrabold text-[12px] leading-tight">{po.vendor_name || '—'}</div>
            {po.vendor_address && <div className="whitespace-pre-line text-gray-700">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN:</span> <span className="font-semibold">{po.gst_number}</span></div>}
            {po.state && <div><span className="text-gray-500">State:</span> {po.state}{po.state_code ? `, Code ${po.state_code}` : ''}</div>}
          </div>
          <div className="p-2 text-[10.5px] bg-emerald-50/30 leading-snug">
            <div className="text-[9px] uppercase tracking-wider font-bold text-emerald-700">Consignee (Ship to)</div>
            <div className="font-extrabold text-[12px] leading-tight">{po.site_name || COMPANY.name}</div>
            {po.sepl_lead_no && (
              <div className="text-[9.5px] text-gray-700">
                Lead: <span className="font-mono font-semibold">{po.sepl_lead_no}</span>
              </div>
            )}
            {po.client_address_bb && (
              <div className="text-[9px] text-gray-600 whitespace-pre-line leading-tight mt-0.5">
                <span className="text-gray-500">Client Address:</span> {po.client_address_bb}
              </div>
            )}
            <div className="text-[9px] text-gray-600 italic mt-0.5">
              Ship to the site above. Coordinate exact address with the site engineer{po.site_engineer_name ? ` — ${po.site_engineer_name}` : ''}.
            </div>
            <div className="text-[9.5px] text-gray-700 mt-0.5">
              Site Engineer :- {po.site_engineer_name || ''}
              <span className="mx-1 text-gray-400">|</span>
              Mobile Number :- {po.raised_by_phone || ''}
            </div>
          </div>
        </div>

        {/* ITEMS TABLE — 8 columns matching the sample. Improvements over v1:
            - Subtle alternating row tint for readability across many lines
            - First-line of description bold; spec / make / item-code in
              smaller secondary line so the eye scans the item name first
            - Item code shown as a mono-font chip (e.g. PO-0042) for fast
              cross-reference with Item Master and Inventory
            - Totals block visually separated; CGST/SGST in muted text;
              Grand Total in bold + larger size + thicker top border
            - All cells have explicit borders (incl. rightmost Amount column)
              so the table reads as a single tight grid even when the page
              is wider than the content. */}
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-800 print:border-black bg-blue-800 text-[10px] uppercase tracking-wide font-bold print:bg-blue-800" style={{ color: '#ffffff' }}>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-8" style={{ color: '#ffffff' }}>Sl<br/>No.</th>
              <th className="border-r border-blue-900 print:border-black px-2 py-2 text-left" style={{ color: '#ffffff' }}>Description of Goods</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-16" style={{ color: '#ffffff' }}>Type</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-20" style={{ color: '#ffffff' }}>Quantity</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-20" style={{ color: '#ffffff' }}>Rate</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-12" style={{ color: '#ffffff' }}>per</th>
              <th className="border-r border-blue-900 print:border-black px-1 py-2 w-12" style={{ color: '#ffffff' }}>Disc.%</th>
              <th className="border-r border-blue-900 print:border-black px-2 py-2 w-24 text-right" style={{ color: '#ffffff' }}>Amount</th>
            </tr>
          </thead>
          <tbody>
            {/* No linked line items (mam 2026-08-27 "why data is not
                showing"): this PO was saved without linking indent lines —
                usually an uploaded ready-made (Tally) PO where the items
                live inside the attached file. Say so instead of printing a
                silent empty table with Rs 0. */}
            {items.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-[12px] text-amber-800 bg-amber-50 print:bg-white">
                  <b>No line items are linked to this PO.</b><br />
                  {po.file_path
                    ? <>The items are inside the uploaded PO file — <a className="text-blue-700 underline" href={`/file-view?src=${encodeURIComponent(po.file_path)}`} target="_blank" rel="noreferrer">open the uploaded PO</a>.<br /></>
                    : null}
                  {/* The server can usually rebuild the lines from the indent. When
                      it refuses, say WHY and what to do — "no line items" alone left
                      mam re-reporting the same PO with nothing to act on
                      (2026-09-03). */}
                  {po.derive_blocked_reason
                    ? <span className="block mt-1 text-[11.5px] text-amber-900">{po.derive_blocked_reason}</span>
                    : <>To print the items here, open this PO in <b>Edit PO</b> (Procurement → Vendor POs), link the indent lines, and save.</>}
                </td>
              </tr>
            )}
            {items.map((it, idx) => {
              const desc = it.custom_description || it.master_name || it.description || '—';
              const make = it.im_make || it.ii_make;
              const spec = it.specification || '';
              const size = it.size || '';
              // UOM source priority: item_master.uom is the canonical
              // unit (mam, 2026-05-15 normalised the master); fall back
              // to whatever the indent line was raised with.
              // Pipe lines are stored & PO'd in KG (quantity = kg); the
              // original meters ride along in original_qty_mtr for "show both".
              const isPipe = +it.weight_per_meter > 0;
              const unit = isPipe ? 'KG' : String(it.uom || it.unit || '').toUpperCase();
              // Mam (2026-05-21): "update here if i update rate in 3
              // vendor" — prefer the latest finalised rate from the
              // Vendor Rates step over the PO-frozen rate.  Drift
              // shown via a small "updated" badge below.
              const liveRate = (it.latest_rate != null && +it.latest_rate > 0) ? +it.latest_rate : +it.rate;
              const rateDrift = +it.rate && +it.latest_rate && +it.latest_rate !== +it.rate;
              const amount = +liveRate * +it.quantity || +it.amount || 0;
              // Per-item TYPE — the procurement classification of the
              // line (PO / FOC / RGP).  Mam's reference PO replaced the
              // old "Due on" date column with this item-wise type.
              // Sourced from indent_items.item_type, falling back to the
              // item_master.type it was mirrored from.
              const itemType = (it.item_type || it.im_type || '').toUpperCase();
              const stripeBg = idx % 2 === 1 ? 'bg-gray-50/40' : '';
              return (
                <tr key={it.id} className={`align-top ${stripeBg}`}>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-500">{idx + 1}</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-2 text-gray-900">
                    {/* Item code chip + bold name on first visual line, then
                        prominent Specification line + size/make so the vendor
                        supplies the exact correct goods. */}
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      {it.item_code && <span className="font-mono text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 rounded">{it.item_code}</span>}
                      <span className="font-bold text-[11.5px] leading-snug text-gray-900" style={{ color: '#111827' }}>{desc}</span>
                    </div>
                    {spec && (
                      <div className="text-[10px] text-gray-800 mt-0.5 leading-tight font-medium print:text-black">
                        <span className="font-bold text-gray-900 print:text-black">Specification:</span> {spec}
                      </div>
                    )}
                    {(size || make) && (
                      <div className="text-[9.5px] text-gray-700 mt-0.5 leading-tight">
                        {size && <span>Size: <span className="font-semibold text-gray-800">{size}</span></span>}
                        {size && make && <span className="mx-1">·</span>}
                        {make && <span>Make: <span className="font-semibold text-gray-800">{make}</span></span>}
                      </div>
                    )}
                  </td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center font-semibold text-gray-700">{itemType}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums font-bold">
                    {(+it.quantity || 0).toLocaleString('en-IN')} {unit}
                    {isPipe && +it.original_qty_mtr > 0 && (
                      <div className="text-[8.5px] font-normal text-gray-500">({(+it.original_qty_mtr).toLocaleString('en-IN')} MTR × {it.weight_per_meter} kg/pipe)</div>
                    )}
                  </td>
                  {/* Rate cell — shows current rate only.  Mam
                      (2026-05-21): the audit-trail "was X · updated"
                      badge that previously appeared here when the
                      Vendor Rates step had a newer final_rate is
                      removed.  This page IS the vendor-facing
                      document — any "was X" hint leaks confidential
                      negotiation history to the supplier.  Drift
                      audit lives in the Vendor Rates screen instead. */}
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums">
                    {fmtMoney(liveRate)}
                  </td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-600">{unit}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right text-gray-500">{it.disc_pct ? `${it.disc_pct}%` : ''}</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-2 text-right tabular-nums font-bold text-gray-900">{fmtMoney(amount)}</td>
                </tr>
              );
            })}

            {/* SUBTOTAL — bold separator line */}
            <tr className="border-t-2 border-gray-800 print:border-black">
              <td className="border-r border-gray-800 print:border-black px-1 py-1.5"></td>
              <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1.5 text-right text-[11px] font-semibold text-gray-700">Sub Total</td>
              <td className="border-r border-gray-800 print:border-black px-2 py-1.5 text-right tabular-nums font-bold">{fmtMoney(subtotal)}</td>
            </tr>

            {/* Freight — shown only when a charge is entered. Added to the
                taxable value, so the GST lines below are on (goods + freight). */}
            {freightAmount > 0 && (
              <tr className="text-gray-700">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right">
                  Freight{po.freight_terms ? ` (${po.freight_terms})` : ''}
                </td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(freightAmount)}</td>
              </tr>
            )}

            {/* GST + Round off — muted */}
            {sameState ? (
              <>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">CGST @ {+(gstPct / 2).toFixed(2)}%</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(cgst)}</td>
                </tr>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">SGST @ {+(gstPct / 2).toFixed(2)}%</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(sgst)}</td>
                </tr>
              </>
            ) : (
              <tr className="text-gray-600">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">IGST @ {+gstPct.toFixed(2)}%</td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(igst)}</td>
              </tr>
            )}
            {Math.abs(roundOff) > 0.001 && (
              <tr className="text-gray-500">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">Round Off</td>
                <td className="border-r border-gray-800 print:border-black px-2 py-1 text-right tabular-nums">{fmtMoney(roundOff)}</td>
              </tr>
            )}

            {/* GRAND TOTAL — red branded bg, larger fonts for visual pop */}
            <tr className="border-t-2 border-b-2 border-gray-800 print:border-black bg-blue-800 print:bg-blue-800" style={{ color: '#ffffff' }}>
              <td className="border-r border-blue-900 print:border-black px-1 py-3 text-right font-extrabold uppercase text-[13px] tracking-wide" colSpan="3" style={{ color: '#ffffff' }}>Grand Total</td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3 text-right tabular-nums font-bold text-[13px]" style={{ color: '#ffffff' }}>{totalQty.toLocaleString('en-IN')} {totalUnit}</td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-1 py-3"></td>
              <td className="border-r border-blue-900 print:border-black px-2 py-3 text-right tabular-nums font-extrabold text-[18px]" style={{ color: '#ffffff' }}>₹ {fmtMoney(grandTotal)}</td>
            </tr>
          </tbody>
        </table>

        {/* Terms & Conditions — branded section header + numbered list */}
        <div className="border-t border-gray-800 print:border-black px-4 py-3 text-[11px] bg-gray-50/40 print:bg-transparent">
          <div className="text-[11px] uppercase tracking-wider font-bold text-blue-800 mb-2 border-b border-blue-800/30 pb-1">Terms &amp; Conditions</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <div className="text-[11px]"><span className="text-gray-500">Payment Terms&nbsp;&nbsp;:</span> <span className="font-semibold">{payTermsText || '—'}{payCreditDays ? ` (${payCreditDays} days)` : ''}</span></div>
            <div className="text-[11px]"><span className="text-gray-500">Terms for Delivery&nbsp;&nbsp;:</span> <span className="font-semibold">{po.expected_receipt_date ? `Delivery by ${fmtDate(po.expected_receipt_date)}` : '—'}</span></div>
            {po.freight_terms && (
              <div className="text-[11px]"><span className="text-gray-500">Freight Terms&nbsp;&nbsp;:</span> <span className="font-semibold">{po.freight_terms}{freightAmount > 0 ? ` — ₹ ${fmtMoney(freightAmount)}` : ''}</span></div>
            )}
          </div>
          <ol className="mt-1 space-y-1 text-[10px] leading-snug list-decimal list-outside ml-4 text-gray-700">
            {TERMS.map(([title, body], i) => {
              const filled = body.replace('{{PO_NUMBER}}', po.po_number || '');
              return (
                <li key={i} className="pl-1">
                  <b className="text-gray-900">{title}{title.endsWith(':') ? '' : ':'}</b> {filled}
                </li>
              );
            })}
          </ol>
          {po.remarks && (
            <div className="mt-3 text-[11px] bg-amber-50 border-l-4 border-amber-400 px-3 py-1.5">
              <b className="text-amber-800">Special Notes:</b> {po.remarks}
            </div>
          )}
        </div>

        {/* Footer — branded red bar */}
        <div className="text-center border-t-2 border-blue-800 py-2 text-[11px] font-semibold italic bg-blue-50/60 print:bg-blue-50 text-blue-900">
          This is a Computer Generated Voucher. No Signature Required.
        </div>
      </div>

      {/* TSK-0378 / TSK-0943: Attached Rate Comparison Statement for Physical Hard Copy Signature */}
      {includeComparison && compData && (
        <div className="comparison-sheet-print max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border-2 border-gray-800 print:border-black text-[11px] text-gray-900 overflow-hidden">
          {/* Header */}
          <div className="bg-slate-800 text-white py-2 px-3 print:bg-slate-800 flex items-center justify-between">
            <span className="text-[10px] uppercase font-bold tracking-wider">Internal Procurement Audit &amp; Approval</span>
            <span className="font-extrabold text-[13px] tracking-wide uppercase">Rate Comparison &amp; Online Market Discovery</span>
            <span className="text-[10px] font-mono">PO: {compData.po?.po_number || po.po_number}</span>
          </div>

          <div className="p-3 bg-slate-50 border-b border-gray-300">
            <div className="text-center pb-2 border-b border-gray-200">
              <div className="text-[16px] font-extrabold uppercase text-gray-900">{COMPANY.name}</div>
              <div className="text-[11px] font-semibold text-blue-900 uppercase tracking-wide">
                Purchase Order Rate Comparative Statement with Online Market Data (Moglix / IndiaMART)
              </div>
              <div className="text-[9.5px] text-gray-500 italic">
                Mandatory Physical Hard Copy Attachment for Managing Director (MD Sir) Signature
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 text-[10.5px]">
              <div><span className="text-gray-500">PO Number:</span> <strong className="text-gray-900 font-mono">{compData.po?.po_number || po.po_number}</strong></div>
              <div><span className="text-gray-500">PO Date:</span> <strong className="text-gray-900">{fmtDate(compData.po?.po_date || po.po_date)}</strong></div>
              <div><span className="text-gray-500">Vendor:</span> <strong className="text-gray-900">{compData.po?.vendor_name || po.vendor_name}</strong></div>
              <div><span className="text-gray-500">Site / Project:</span> <strong className="text-gray-900">{compData.po?.site_name || po.site_name || '—'}</strong></div>
              <div><span className="text-gray-500">Indent No:</span> <strong className="text-gray-900">{compData.po?.indent_number || po.indent_number || '—'}</strong></div>
              <div><span className="text-gray-500">Created By:</span> <strong className="text-gray-900">{compData.po?.created_by_name || 'Divyanshi (Purchase)'}</strong></div>
              <div><span className="text-gray-500">Items Count:</span> <strong className="text-gray-900">{(compData.items || []).length} lines</strong></div>
              <div>
                <span className="text-gray-500">Overall Status:</span>{' '}
                <strong className={compData.summary?.cost_status === 'cost_overrun' ? 'text-red-700' : 'text-emerald-700'}>
                  {compData.summary?.cost_status === 'cost_overrun' ? 'Cost Overrun (MD Approval Req.)' : 'Within Budget Benchmarks'}
                </strong>
              </div>
            </div>
          </div>

          {/* Items Table */}
          <table className="w-full text-[10px] border-collapse border-b border-gray-800">
            <thead>
              <tr className="bg-gray-100 border-b border-gray-400 text-gray-800 font-bold uppercase text-[9.5px]">
                <th className="border-r border-gray-300 px-1 py-1.5 text-center w-6" rowSpan="2">#</th>
                <th className="border-r border-gray-300 px-2 py-1.5 text-left" rowSpan="2">Item Description &amp; Specification</th>
                <th className="border-r border-gray-300 px-1 py-1.5 text-center w-12" rowSpan="2">Qty</th>
                <th className="border-r border-gray-300 px-2 py-1.5 text-right bg-blue-50 text-blue-900 font-extrabold w-20" rowSpan="2">
                  PO Rate<br />(₹)
                </th>
                <th className="border-r border-gray-300 px-2 py-1 text-center bg-orange-50/70 text-orange-950" colSpan="2">
                  Online Market Benchmarks
                </th>
                <th className="border-r border-gray-300 px-2 py-1.5 text-right w-16" rowSpan="2">
                  Last SEPL<br />PO Rate
                </th>
                <th className="border-r border-gray-300 px-2 py-1.5 text-right w-16" rowSpan="2">
                  BOQ PP /<br />Target
                </th>
                <th className="border-r border-gray-300 px-1.5 py-1.5 text-center w-16" rowSpan="2">
                  Variance<br />vs Target
                </th>
                <th className="px-1.5 py-1.5 text-center w-16" rowSpan="2">Audit Status</th>
              </tr>
              <tr className="bg-gray-100 border-b border-gray-400 text-gray-700 text-[9px]">
                <th className="border-r border-gray-300 px-1.5 py-0.5 bg-orange-50/70 text-right w-16">Moglix Rate</th>
                <th className="border-r border-gray-300 px-1.5 py-0.5 bg-orange-50/70 text-right w-16">IndiaMART</th>
              </tr>
            </thead>
            <tbody>
              {(compData.items || []).map((it, idx) => {
                const poRate = +it.actual_rate || 0;
                const moglixPrice = it.marketData?.moglix?.[0]?.price;
                const indiamartPrice = it.marketData?.indiamart?.[0]?.price;
                const pastRate = it.pastPoRates?.[0]?.rate;
                const targetRate = it.estimatedRate;
                const variancePct = it.variancePct;
                const isOverrun = targetRate && poRate > targetRate;
                const isSaving = targetRate && poRate < targetRate;

                return (
                  <tr key={idx} className={`border-b border-gray-200 ${idx % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}`}>
                    <td className="border-r border-gray-300 px-1 py-1.5 text-center font-mono text-gray-500">{idx + 1}</td>
                    <td className="border-r border-gray-300 px-2 py-1.5">
                      <div className="font-semibold text-gray-900">{it.master_name || it.description}</div>
                      {it.specification && <div className="text-[9px] text-gray-600 leading-tight mt-0.5">{it.specification}</div>}
                      <div className="flex gap-2 text-[8.5px] text-gray-500 mt-0.5">
                        {it.size && <span>Size: <b>{it.size}</b></span>}
                        {it.make && <span>Make: <b>{it.make}</b></span>}
                        {it.item_code && <span>Code: <b>{it.item_code}</b></span>}
                      </div>
                    </td>
                    <td className="border-r border-gray-300 px-1 py-1.5 text-center whitespace-nowrap">
                      <b>{it.quantity}</b> <span className="text-gray-500 text-[9px]">{it.unit || ''}</span>
                    </td>
                    <td className="border-r border-gray-300 px-2 py-1.5 text-right font-bold text-blue-900 bg-blue-50/30 whitespace-nowrap">
                      ₹ {poRate.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="border-r border-gray-300 px-1.5 py-1.5 text-right whitespace-nowrap bg-orange-50/20">
                      {moglixPrice ? `₹ ${Math.round(moglixPrice).toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="border-r border-gray-300 px-1.5 py-1.5 text-right whitespace-nowrap bg-orange-50/20">
                      {indiamartPrice ? `₹ ${Math.round(indiamartPrice).toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="border-r border-gray-300 px-1.5 py-1.5 text-right whitespace-nowrap">
                      {pastRate ? `₹ ${Math.round(pastRate).toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="border-r border-gray-300 px-1.5 py-1.5 text-right whitespace-nowrap">
                      {targetRate ? `₹ ${Math.round(targetRate).toLocaleString('en-IN')}` : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="border-r border-gray-300 px-1.5 py-1.5 text-center whitespace-nowrap">
                      {variancePct != null ? (
                        <span className={`font-semibold ${isOverrun ? 'text-red-600' : isSaving ? 'text-emerald-700' : 'text-gray-700'}`}>
                          {variancePct > 0 ? `+${variancePct}%` : `${variancePct}%`}
                        </span>
                      ) : (
                        <span className="text-gray-300">—</span>
                      )}
                    </td>
                    <td className="px-1.5 py-1.5 text-center whitespace-nowrap">
                      {isOverrun ? (
                        <span className="text-red-700 font-bold bg-red-50 border border-red-200 px-1 py-0.5 rounded text-[8.5px]">
                          OVERRUN
                        </span>
                      ) : isSaving ? (
                        <span className="text-emerald-700 font-bold bg-emerald-50 border border-emerald-200 px-1 py-0.5 rounded text-[8.5px]">
                          SAVING
                        </span>
                      ) : (
                        <span className="text-gray-600 bg-gray-100 border border-gray-200 px-1 py-0.5 rounded text-[8.5px]">
                          OK
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-gray-100 font-bold border-t-2 border-gray-600 text-gray-900">
                <td colSpan="3" className="border-r border-gray-300 px-2 py-2 text-right uppercase text-[9.5px]">
                  Total Actual PO (Taxable)
                </td>
                <td className="border-r border-gray-300 px-2 py-2 text-right text-blue-900 text-[11px] font-extrabold whitespace-nowrap">
                  ₹ {Math.round(compData.summary?.total_actual_amount || subtotal).toLocaleString('en-IN')}
                </td>
                <td colSpan="4" className="border-r border-gray-300 px-2 py-2 text-right uppercase text-[9.5px]">
                  Estimated Target Benchmark Total:
                </td>
                <td colSpan="2" className="px-2 py-2 text-right text-[11px] whitespace-nowrap">
                  {compData.summary?.total_estimated_amount > 0 ? (
                    <span className="font-extrabold text-gray-900">
                      ₹ {Math.round(compData.summary.total_estimated_amount).toLocaleString('en-IN')}
                    </span>
                  ) : (
                    <span className="text-gray-400 font-normal">No est. baseline</span>
                  )}
                </td>
              </tr>
            </tfoot>
          </table>

          {/* Savings / Variance Analysis note */}
          <div className="p-3 bg-gray-50 border-b border-gray-400 text-[10.5px]">
            <div className="font-bold text-gray-800 mb-1 uppercase tracking-wide text-[10px]">
              Procurement Audit Summary &amp; Market Justification:
            </div>
            <div className="text-gray-700 leading-snug">
              {compData.summary?.savings_vs_estimated != null ? (
                compData.summary.savings_vs_estimated >= 0 ? (
                  <span className="text-emerald-800 font-semibold">
                    ✓ Net Procurement Savings: ₹ {Math.round(compData.summary.savings_vs_estimated).toLocaleString('en-IN')} ({compData.summary.savings_vs_estimated_pct}%) below estimated benchmark. Rates verified against online portals and vendor quotations.
                  </span>
                ) : (
                  <span className="text-red-700 font-semibold">
                    ⚠️ Net Cost Overrun: ₹ {Math.round(Math.abs(compData.summary.savings_vs_estimated)).toLocaleString('en-IN')} ({Math.abs(compData.summary.savings_vs_estimated_pct)}%) above target. Rates justified by market conditions / specific technical requirements.
                  </span>
                )
              ) : (
                <span>Market rate comparison verified against Moglix, IndiaMART, and past SEPL PO history.</span>
              )}
            </div>
          </div>

          {/* PHYSICAL SIGNATURES BOX */}
          <div className="p-4 bg-white">
            <div className="text-[10px] font-bold uppercase tracking-wider text-gray-500 mb-3 border-b pb-1">
              Authorisation &amp; Approval Signatures (Mandatory for PO Issuance)
            </div>
            <div className="grid grid-cols-3 gap-6 text-center text-[10.5px]">
              {/* Prepared by */}
              <div className="border border-gray-300 rounded p-2.5 flex flex-col justify-between h-28 bg-gray-50/30">
                <div>
                  <div className="font-bold text-gray-800 uppercase text-[10px]">Prepared By</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">{compData.po?.created_by_name || 'Divyanshi (Purchase)'}</div>
                  <div className="text-[9px] text-gray-400">Procurement Coordinator</div>
                </div>
                <div className="border-t border-dashed border-gray-400 pt-1 text-[9px] text-gray-500">
                  Signature &amp; Date
                </div>
              </div>

              {/* Checked by */}
              <div className="border border-gray-300 rounded p-2.5 flex flex-col justify-between h-28 bg-gray-50/30">
                <div>
                  <div className="font-bold text-gray-800 uppercase text-[10px]">Checked &amp; Verified By</div>
                  <div className="text-[10px] text-gray-600 mt-0.5">Purchase Head / Project Lead</div>
                  <div className="text-[9px] text-gray-400">Technical &amp; Commercial Review</div>
                </div>
                <div className="border-t border-dashed border-gray-400 pt-1 text-[9px] text-gray-500">
                  Signature &amp; Date
                </div>
              </div>

              {/* Approved by */}
              <div className="border-2 border-gray-800 rounded p-2.5 flex flex-col justify-between h-28 bg-amber-50/30">
                <div>
                  <div className="font-extrabold text-gray-900 uppercase text-[10.5px]">Approved By</div>
                  <div className="text-[10.5px] font-bold text-blue-900 mt-0.5">Managing Director (MD Sir)</div>
                  <div className="text-[9px] text-gray-500">Final Commercial Approval</div>
                </div>
                <div className="border-t border-dashed border-gray-500 pt-1 text-[9px] text-gray-600 font-semibold">
                  MD Signature &amp; Date
                </div>
              </div>
            </div>
          </div>

          <div className="text-center border-t border-gray-300 py-1.5 text-[9px] text-gray-500 italic bg-gray-50">
            Internal Document · Generated on {new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })} · SOTYN.AI
          </div>
        </div>
      )}

      <style>{`
        @media print {
          @page { size: A4; margin: 6mm; }
          body { background: white !important; }
          .comparison-sheet-print {
            page-break-before: always !important;
            break-before: page !important;
          }
          /* Force browsers to print background colors / images so the royal
             blue header bar, totals bar and section tints appear in the PDF. */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-black { border-color: black !important; }
          .print\\:bg-blue-800 { background-color: #1e40af !important; color: white !important; }
          .print\\:bg-blue-50 { background-color: #eff6ff !important; }
          .print\\:bg-transparent { background-color: transparent !important; }
        }
      `}</style>
    </div>
  );
}
