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
// mam's address / GSTIN changes. Could move to a settings table down the
// road; for now hard-coded matches the sample PDF exactly.
const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD - 24-25',
  gstin: '03AASCS7836D2Z3',
  pan: 'AASCS7836D',
  state: 'Punjab',
  state_code: '03',
  address: '2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003, India',
};

export default function VendorPOPrint() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api.get(`/procurement/vendor-po/${id}/print`)
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Failed to load'));
  }, [id]);

  if (error) return <div className="min-h-screen flex items-center justify-center text-red-600">{error}</div>;
  if (!data) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading…</div>;
  const { po, items } = data;

  // Subtotal across line items. Falls back to qty × rate if amount column
  // wasn't filled when the row was saved.
  const subtotal = items.reduce((s, it) => s + (+it.amount || (+it.rate * +it.quantity) || 0), 0);

  // GST split. Same-state vendor → CGST 9% + SGST 9% (intra). Different
  // state → IGST 18%. Defaults to intra-state when state is missing,
  // matching mam's sample (Punjab buyer, Punjab vendor).
  const sameState = !po.state || String(po.state).trim().toLowerCase() === COMPANY.state.toLowerCase();
  const gstRate = 0.18;
  const cgst = sameState ? subtotal * (gstRate / 2) : 0;
  const sgst = sameState ? subtotal * (gstRate / 2) : 0;
  const igst = sameState ? 0 : subtotal * gstRate;

  // Round to nearest rupee — the difference between the rupee total and
  // the paise-precision running total goes on the ROUND OFF line. So the
  // grand total is always clean rupees.
  const beforeRound = subtotal + cgst + sgst + igst;
  const grandTotal = Math.round(beforeRound);
  const roundOff = +(grandTotal - beforeRound).toFixed(2);

  // Total quantity sum (e.g. "60 LTR") — uses the most common unit across
  // line items. Falls back to "—" if mixed.
  const totalQty = items.reduce((s, it) => s + (+it.quantity || 0), 0);
  const units = [...new Set(items.map(it => (it.unit || it.uom || '').toUpperCase()).filter(Boolean))];
  const totalUnit = units.length === 1 ? units[0] : '';

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
          <div className="flex gap-2">
            <button onClick={sharePO} className="btn btn-success flex items-center gap-2" title="Share via WhatsApp">
              <FiMessageCircle size={14} /> WhatsApp
            </button>
            <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2">
              <FiPrinter size={14} /> Print / Save as PDF
            </button>
          </div>
        </div>
      </div>

      {/* PO body — printable. Branded Tally style with SEPL red accents. */}
      <div className="max-w-4xl mx-auto bg-white shadow-lg my-6 print:my-0 print:shadow-none border border-gray-800 print:border-black text-[12px] text-gray-900 overflow-hidden">
        {/* RED branded title bar — pops the document immediately as a SEPL PO */}
        <div className="bg-red-700 text-white text-center py-2.5 px-3 print:bg-red-700">
          <div className="font-extrabold text-[16px] tracking-[0.3em] uppercase">Purchase Order</div>
          <div className="flex justify-between mt-1.5 text-[10px] opacity-95 font-medium">
            <span>GSTIN : {COMPANY.gstin}</span>
            <span>PAN : {COMPANY.pan}</span>
          </div>
        </div>

        {/* Company name + address — clean white with red underline */}
        <div className="text-center py-3 px-3 border-b-2 border-red-700 bg-gradient-to-b from-red-50/60 to-white">
          <div className="text-[22px] font-extrabold tracking-tight text-gray-900 leading-tight">{COMPANY.name}</div>
          <div className="text-[10.5px] text-gray-600 mt-1">{COMPANY.address}</div>
        </div>

        {/* TWO-COLUMN HEADER: Details of Vendor (left) | Voucher meta (right).
            Subtle blue-tinted backgrounds + red section labels for visual rhythm. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-3 bg-blue-50/30">
            <div className="text-[10px] uppercase tracking-wider font-bold text-red-700 mb-1">Details of Vendor</div>
            <div className="font-extrabold text-[14px]">{po.vendor_name || '—'}</div>
            {po.firm_name && po.firm_name !== po.vendor_name && <div className="text-[11px]">{po.firm_name}</div>}
            {po.vendor_address && <div className="text-[11px] text-gray-700 whitespace-pre-line mt-1">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-[11px] text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            <div className="mt-2 text-[11px]">
              {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN&nbsp;&nbsp;:</span> <span className="font-semibold">{po.gst_number}</span></div>}
              {po.state && <div><span className="text-gray-500">State Name :</span> {po.state}, Code : {po.state_code || ''}</div>}
            </div>
          </div>
          <div className="p-0 text-[11px]">
            {/* Right-side meta block — 2-cell-per-row table layout with red labels */}
            <table className="w-full">
              <tbody>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-1.5 w-1/2"><span className="text-red-700 font-semibold">Voucher No.:</span> <span className="font-bold">SEPL-{po.id}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-1.5 w-1/2"><span className="text-red-700 font-semibold">Date :</span> <span className="font-bold">{fmtDate(po.po_date || po.created_at)}</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-1.5"><span className="text-red-700 font-semibold">SEPL PO No.:</span> <span className="font-bold">{po.po_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-1.5"><span className="text-gray-500">Vender Code:</span></td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-1.5"><span className="text-red-700 font-semibold">SEPL Indent No.:</span> <span className="font-bold">{po.indent_number || ''}</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-1.5"><span className="text-gray-500">Contact Person:</span> {po.contact_person || ''}</td>
                </tr>
                <tr>
                  <td className="border-b border-r border-gray-800 print:border-black px-2 py-1.5"><span className="text-gray-500">SEPL Lead No.:</span></td>
                  <td className="border-b border-gray-800 print:border-black px-2 py-1.5"><span className="text-gray-500">Contact No.:</span> {po.vendor_phone || ''}</td>
                </tr>
                <tr>
                  <td colSpan="2" className="px-2 py-1.5"><span className="text-gray-500">Ref Quote No.:</span></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* TWO-COLUMN: Supplier (Bill from) | Consignee (Ship to). Different
            subtle bg tints to differentiate the two address blocks. */}
        <div className="grid grid-cols-2 border-b border-gray-800 print:border-black">
          <div className="border-r border-gray-800 print:border-black p-3 text-[11px] bg-amber-50/30">
            <div className="text-[10px] uppercase tracking-wider font-bold text-amber-700 mb-1">Supplier (Bill from)</div>
            <div className="font-extrabold text-[13px]">{po.vendor_name || '—'}</div>
            {po.vendor_address && <div className="whitespace-pre-line text-gray-700 mt-1">{po.vendor_address}</div>}
            {(po.district || po.state) && <div className="text-gray-700">{[po.district, po.state].filter(Boolean).join(', ')} - India</div>}
            <div className="mt-2">
              {po.gst_number && <div><span className="text-gray-500">GSTIN/UIN&nbsp;&nbsp;:</span> <span className="font-semibold">{po.gst_number}</span></div>}
              {po.state && <div><span className="text-gray-500">State Name :</span> {po.state}, Code : {po.state_code || ''}</div>}
            </div>
          </div>
          <div className="p-3 text-[11px] bg-emerald-50/30">
            <div className="text-[10px] uppercase tracking-wider font-bold text-emerald-700 mb-1">Consignee (Ship to)</div>
            <div className="font-extrabold text-[13px]">{po.site_name || COMPANY.name}</div>
            <div className="text-[10px] text-gray-600 mt-2 italic">
              Ship to the site mentioned above. For exact address coordinate with the site engineer{po.raised_by_name ? ` — ${po.raised_by_name}` : ''}.
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
              Grand Total in bold + larger size + thicker top border */}
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="border-b-2 border-gray-800 print:border-black bg-red-700 text-white text-[10px] uppercase tracking-wide font-bold print:bg-red-700">
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-8">Sl<br/>No.</th>
              <th className="border-r border-red-800 print:border-black px-2 py-2 text-left">Description of Goods</th>
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-20">Due on</th>
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-20">Quantity</th>
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-20">Rate</th>
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-12">per</th>
              <th className="border-r border-red-800 print:border-black px-1 py-2 w-12">Disc.%</th>
              <th className="px-2 py-2 w-24 text-right">Amount</th>
            </tr>
          </thead>
          <tbody>
            {items.map((it, idx) => {
              const desc = it.master_name || it.description || '—';
              const detail = [it.size, it.specification].filter(Boolean).join(' · ');
              const make = it.im_make || it.ii_make;
              const unit = String(it.unit || it.uom || '').toUpperCase();
              const amount = +it.amount || (+it.rate * +it.quantity) || 0;
              const dueOn = fmtDate(po.expected_receipt_date || po.po_date || po.created_at);
              const stripeBg = idx % 2 === 1 ? 'bg-gray-50/40' : '';
              return (
                <tr key={it.id} className={`align-top ${stripeBg}`}>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-500">{idx + 1}</td>
                  <td className="border-r border-gray-800 print:border-black px-2 py-2">
                    {/* Item code chip + bold name on first visual line, then
                        a subtle secondary line with size · spec · make so
                        long descriptions don't dominate the cell. */}
                    <div className="flex items-baseline gap-1.5 flex-wrap">
                      {it.item_code && <span className="font-mono text-[9px] text-gray-500 bg-gray-100 px-1 py-0.5 rounded">{it.item_code}</span>}
                      <span className="font-bold text-[11.5px] leading-snug">{desc}{unit && desc && !desc.toUpperCase().includes(unit) ? ' ' + unit : ''}</span>
                    </div>
                    {(detail || make) && (
                      <div className="text-[9.5px] text-gray-600 mt-0.5 leading-tight">
                        {detail && <span>{detail}</span>}
                        {detail && make && <span className="mx-1">·</span>}
                        {make && <span>Make: <span className="font-semibold text-gray-700">{make}</span></span>}
                      </div>
                    )}
                  </td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 italic text-center text-gray-700">{dueOn}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums font-bold">{(+it.quantity || 0).toLocaleString('en-IN')} {unit}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right tabular-nums">{fmtMoney(it.rate)}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-center text-gray-600">{unit}</td>
                  <td className="border-r border-gray-800 print:border-black px-1 py-2 text-right text-gray-500">{it.disc_pct ? `${it.disc_pct}%` : ''}</td>
                  <td className="px-2 py-2 text-right tabular-nums font-bold text-gray-900">{fmtMoney(amount)}</td>
                </tr>
              );
            })}

            {/* SUBTOTAL — bold separator line */}
            <tr className="border-t-2 border-gray-800 print:border-black">
              <td className="border-r border-gray-800 print:border-black px-1 py-1.5"></td>
              <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1.5 text-right text-[11px] font-semibold text-gray-700">Sub Total</td>
              <td className="px-2 py-1.5 text-right tabular-nums font-bold">{fmtMoney(subtotal)}</td>
            </tr>

            {/* GST + Round off — muted */}
            {sameState ? (
              <>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">CGST @ 9%</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(cgst)}</td>
                </tr>
                <tr className="text-gray-600">
                  <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                  <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">SGST @ 9%</td>
                  <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(sgst)}</td>
                </tr>
              </>
            ) : (
              <tr className="text-gray-600">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">IGST @ 18%</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(igst)}</td>
              </tr>
            )}
            {Math.abs(roundOff) > 0.001 && (
              <tr className="text-gray-500">
                <td className="border-r border-gray-800 print:border-black px-1 py-1"></td>
                <td colSpan="6" className="border-r border-gray-800 print:border-black px-2 py-1 text-right italic">Round Off</td>
                <td className="px-2 py-1 text-right tabular-nums">{fmtMoney(roundOff)}</td>
              </tr>
            )}

            {/* GRAND TOTAL — red branded bg, larger fonts for visual pop */}
            <tr className="border-t-2 border-b-2 border-gray-800 print:border-black bg-red-700 text-white print:bg-red-700">
              <td className="border-r border-red-800 print:border-black px-1 py-3 text-right font-extrabold uppercase text-[13px] tracking-wide" colSpan="3">Grand Total</td>
              <td className="border-r border-red-800 print:border-black px-1 py-3 text-right tabular-nums font-bold text-[13px]">{totalQty.toLocaleString('en-IN')} {totalUnit}</td>
              <td className="border-r border-red-800 print:border-black px-1 py-3"></td>
              <td className="border-r border-red-800 print:border-black px-1 py-3"></td>
              <td className="border-r border-red-800 print:border-black px-1 py-3"></td>
              <td className="px-2 py-3 text-right tabular-nums font-extrabold text-[18px]">₹ {fmtMoney(grandTotal)}</td>
            </tr>
          </tbody>
        </table>

        {/* Terms & Conditions — branded section header + numbered list */}
        <div className="border-t border-gray-800 print:border-black px-4 py-3 text-[11px] bg-gray-50/40 print:bg-transparent">
          <div className="text-[11px] uppercase tracking-wider font-bold text-red-700 mb-2 border-b border-red-700/30 pb-1">Terms &amp; Conditions</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
            <div className="text-[11px]"><span className="text-gray-500">Payment Terms&nbsp;&nbsp;:</span> <span className="font-semibold">{po.terms || '—'}{po.credit_days ? ` (${po.credit_days} days)` : ''}</span></div>
            <div className="text-[11px]"><span className="text-gray-500">Terms for Delivery&nbsp;&nbsp;:</span> <span className="font-semibold">{po.expected_receipt_date ? `Delivery by ${fmtDate(po.expected_receipt_date)}` : '—'}</span></div>
          </div>
          <ol className="mt-1 space-y-0.5 text-[10px] leading-snug list-decimal list-inside text-gray-700">
            <li>Please mention PO No, Item Code and HSN on all the Invoices.</li>
            <li>Raw Material of Item must be mentioned and certified with Test Certificate.</li>
            <li>Goods should contain Packing Slip with description of Item's Name and Quantity.</li>
            <li>Buyer reserves the right to cancel, amend this PO or any percentage thereof.</li>
            <li>Buyer assumes no obligation in relation to any goods delivered in excess of those ordered.</li>
            <li>GST Amount will be paid only if our GSTIN details are mentioned in Tax Invoice issued. Liabilities of GST paid &amp; GST Return file intimation against this Purchase Order.</li>
            <li>In case of any credit, refund or other benefit is denied or delayed to the buyer due to any non-compliance by the seller (such as failure to upload the details of supply on GSTIN Portal, failure to Pay GST to the GOVT.) due to non-furnishing of incorrect or incomplete document/details/information by the seller, the seller would reimburse the buyer the loss to buyer including, but not limited.</li>
            <li>If there is any dispute then first it will be solved by arbitrator of the company and then by the court. <b>ALL RESPECT TO LUDHIANA JURISDICTION.</b></li>
          </ol>
          {po.remarks && (
            <div className="mt-3 text-[11px] bg-amber-50 border-l-4 border-amber-400 px-3 py-1.5">
              <b className="text-amber-800">Special Notes:</b> {po.remarks}
            </div>
          )}
        </div>

        {/* Footer — branded red bar */}
        <div className="text-center border-t-2 border-red-700 py-2 text-[11px] font-semibold italic bg-red-50/60 print:bg-red-50 text-red-900">
          This is a Computer Generated Voucher. No Signature Required.
        </div>
      </div>

      <style>{`
        @media print {
          @page { size: A4; margin: 6mm; }
          body { background: white !important; }
          /* Force browsers to print background colors / images so the red
             header bar, totals bar and section tints appear in the PDF. */
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:shadow-none { box-shadow: none !important; }
          .print\\:border-black { border-color: black !important; }
          .print\\:bg-red-700 { background-color: #b91c1c !important; color: white !important; }
          .print\\:bg-red-50 { background-color: #fef2f2 !important; }
          .print\\:bg-transparent { background-color: transparent !important; }
        }
      `}</style>
    </div>
  );
}
