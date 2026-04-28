// Print-friendly Vendor PO page.
//
// Opens at /vendor-po/:id/print — a clean full-screen render with the
// SEPL header, vendor block, item table, totals, terms, and signature
// line. Two action buttons (hidden on print): Print/Save-PDF and Share
// via WhatsApp (uses the vendor's phone number).
//
// Browser's "Print → Save as PDF" handles the PDF generation, no
// server-side library needed.

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import { FiPrinter, FiArrowLeft, FiShare2, FiMessageCircle } from 'react-icons/fi';

const fmt = (n) => 'Rs ' + (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

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
  const subtotal = items.reduce((s, it) => s + (+it.amount || +it.rate * +it.quantity || 0), 0);
  const total = +po.total_amount || subtotal;

  // WhatsApp share — opens chat with vendor's number prefilled and the
  // page link in the message body. mam can edit the message before sending.
  const sharePO = () => {
    const phone = String(po.vendor_phone || '').replace(/\D/g, '');
    const url = window.location.href;
    const msg = `*PO ${po.po_number}* from Secured Engineers Pvt Ltd\n\nDear ${po.contact_person || po.vendor_name || 'Sir/Madam'},\n\nPlease find our Purchase Order below. View / download:\n${url}\n\nTotal: ${fmt(total)}\n\nRegards,\nSEPL`;
    if (!phone) {
      // Generic share if no phone on file
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

      {/* PO body — printable */}
      <div className="max-w-4xl mx-auto bg-white shadow-sm my-6 print:my-0 print:shadow-none">
        <div className="p-8 print:p-6 text-gray-800">
          {/* Header */}
          <div className="flex items-start justify-between border-b-2 border-red-700 pb-4 mb-6">
            <div>
              <h1 className="text-2xl font-bold text-red-700">SECURED ENGINEERS PVT LTD</h1>
              <p className="text-xs text-gray-600 mt-1">Fire Fighting · Electrical · MEP Solutions</p>
              <p className="text-[11px] text-gray-500 mt-2">Email: sepl@securedengineers.com · Web: securedengineers.com</p>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase text-gray-500 tracking-wider">Purchase Order</div>
              <div className="text-2xl font-extrabold text-red-700">{po.po_number}</div>
              <div className="text-[11px] text-gray-600 mt-1">Date: {po.po_date || new Date(po.created_at).toLocaleDateString('en-IN')}</div>
              {po.indent_number && <div className="text-[10px] text-gray-500 mt-0.5">Indent: {po.indent_number}{po.site_name ? ` · ${po.site_name}` : ''}</div>}
            </div>
          </div>

          {/* Vendor + Ship-to blocks */}
          <div className="grid grid-cols-2 gap-6 mb-6 text-sm">
            <div>
              <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-1">Vendor</div>
              <div className="font-semibold text-gray-800 text-base">{po.vendor_name || '—'}</div>
              {po.firm_name && po.firm_name !== po.vendor_name && <div className="text-xs text-gray-600">{po.firm_name}</div>}
              {po.contact_person && <div className="text-xs text-gray-600">Attn: {po.contact_person}</div>}
              {po.vendor_address && <div className="text-xs text-gray-600">{po.vendor_address}</div>}
              {(po.district || po.state) && <div className="text-xs text-gray-600">{[po.district, po.state].filter(Boolean).join(', ')}</div>}
              {po.vendor_phone && <div className="text-xs text-gray-600">📞 {po.vendor_phone}</div>}
              {po.vendor_email && <div className="text-xs text-gray-600">✉ {po.vendor_email}</div>}
              {po.gst_number && <div className="text-xs text-gray-600 mt-1">GSTIN: {po.gst_number}</div>}
            </div>
            <div>
              <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-1">Deliver To</div>
              <div className="font-semibold text-gray-800 text-base">{po.site_name || 'Office Store'}</div>
              <div className="text-xs text-gray-600">Secured Engineers Pvt Ltd</div>
              {po.raised_by_name && <div className="text-xs text-gray-600 mt-1">Site Engineer: {po.raised_by_name}</div>}
            </div>
          </div>

          {/* Items table */}
          <table className="w-full text-sm border border-gray-300 mb-6">
            <thead className="bg-gray-100">
              <tr className="text-[11px] uppercase text-gray-700">
                <th className="border border-gray-300 px-2 py-2 text-left w-10">#</th>
                <th className="border border-gray-300 px-2 py-2 text-left">Item Description</th>
                <th className="border border-gray-300 px-2 py-2 text-right w-20">Qty</th>
                <th className="border border-gray-300 px-2 py-2 text-left w-16">Unit</th>
                <th className="border border-gray-300 px-2 py-2 text-right w-24">Rate</th>
                <th className="border border-gray-300 px-2 py-2 text-right w-28">Amount</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => {
                const desc = [it.master_name || it.description, it.specification, it.size]
                  .filter(Boolean).join(' / ');
                const make = it.im_make || it.ii_make;
                const amt = +it.amount || (+it.rate * +it.quantity);
                return (
                  <tr key={it.id}>
                    <td className="border border-gray-300 px-2 py-2 text-gray-500">{idx + 1}</td>
                    <td className="border border-gray-300 px-2 py-2">
                      {it.item_code && <div className="text-[10px] font-mono text-gray-500">[{it.item_code}]</div>}
                      <div>{desc || '—'}</div>
                      {make && <div className="text-[10px] text-gray-500">Make: {make}</div>}
                      {it.boq_description && (
                        <div className="text-[10px] text-gray-400 italic mt-1">BOQ: {it.boq_description.slice(0, 100)}{it.boq_description.length > 100 ? '…' : ''}</div>
                      )}
                    </td>
                    <td className="border border-gray-300 px-2 py-2 text-right tabular-nums">{(+it.quantity || 0).toLocaleString('en-IN')}</td>
                    <td className="border border-gray-300 px-2 py-2 text-xs">{it.unit || it.uom || '—'}</td>
                    <td className="border border-gray-300 px-2 py-2 text-right tabular-nums">{fmt(it.rate)}</td>
                    <td className="border border-gray-300 px-2 py-2 text-right tabular-nums font-semibold">{fmt(amt)}</td>
                  </tr>
                );
              })}
              {items.length === 0 && (
                <tr><td colSpan="6" className="border border-gray-300 px-2 py-6 text-center text-gray-400">No line items</td></tr>
              )}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50">
                <td colSpan="5" className="border border-gray-300 px-2 py-2 text-right font-semibold">Total</td>
                <td className="border border-gray-300 px-2 py-2 text-right text-lg font-bold text-red-700 tabular-nums">{fmt(total)}</td>
              </tr>
            </tfoot>
          </table>

          {/* Terms */}
          <div className="mb-6">
            <div className="text-[10px] uppercase text-gray-500 font-semibold tracking-wider mb-2">Terms & Conditions</div>
            <ol className="list-decimal list-inside text-xs text-gray-700 space-y-1 leading-relaxed">
              {po.terms && <li className="font-medium">Payment Terms: {po.terms}{po.credit_days ? ` (${po.credit_days} days credit)` : ''}</li>}
              <li>Goods are to be delivered to the site mentioned above.</li>
              <li>Original challan / invoice must accompany the delivery; receipt requires our stamped acknowledgement.</li>
              <li>Vendor to provide test certificates / warranty documents where applicable.</li>
              <li>Any defect or shortage will be notified within 7 days of receipt for replacement.</li>
              <li>This PO is governed by the laws of India; jurisdiction: Lucknow.</li>
              {po.remarks && <li className="font-medium text-amber-800">Special Notes: {po.remarks}</li>}
            </ol>
          </div>

          {/* Signature */}
          <div className="grid grid-cols-2 gap-6 mt-12">
            <div>
              <div className="border-t border-gray-400 pt-2 text-xs">
                <div className="font-semibold">Vendor Acknowledgement</div>
                <div className="text-gray-500">Signature & Seal</div>
              </div>
            </div>
            <div className="text-right">
              <div className="border-t border-gray-400 pt-2 text-xs">
                <div className="font-semibold">For Secured Engineers Pvt Ltd</div>
                <div className="text-gray-500">{po.created_by_name || 'Authorized Signatory'}</div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div className="mt-8 pt-3 border-t text-[10px] text-gray-400 text-center">
            Generated from SEPL ERP · {new Date().toLocaleString('en-IN')}
          </div>
        </div>
      </div>

      <style>{`
        @media print {
          body { background: white !important; }
          .print\\:hidden { display: none !important; }
          .print\\:my-0 { margin-top: 0 !important; margin-bottom: 0 !important; }
          .print\\:p-6 { padding: 1.5rem !important; }
          .print\\:shadow-none { box-shadow: none !important; }
        }
      `}</style>
    </div>
  );
}
