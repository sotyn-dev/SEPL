// SOP-05.2 Rate Enquiry sheet (mam 2026-08-28 "make it here system") — the
// ready-made enquiry format opened from the Rates Board's 📄 button. Lists
// one indent's unrated items at FULL PROJECT QUANTITY ("big quantity =
// better rate") with blank rate/delivery/terms columns for the vendor to
// fill. Print / save-as-PDF / WhatsApp to vendors.
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { FiPrinter, FiArrowLeft } from 'react-icons/fi';

export default function RateEnquiryPrint() {
  const { id } = useParams();
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    api.get(`/procurement/rate-enquiry/${id}`).then(r => setD(r.data)).catch(e => setErr(e.response?.data?.error || 'Failed to load'));
  }, [id]);
  useEffect(() => { if (d) document.title = `Rate Enquiry — ${d.indent.indent_number}`; }, [d]);

  if (err) return <div className="min-h-screen flex items-center justify-center text-red-600">{err}</div>;
  if (!d) return <div className="min-h-screen flex items-center justify-center text-gray-400">Loading enquiry sheet…</div>;

  return (
    <div className="min-h-screen bg-gray-100 print:bg-white">
      <div className="max-w-4xl mx-auto p-4 print:p-0">
        <div className="flex justify-between items-center mb-3 print:hidden">
          <button onClick={() => window.close()} className="btn btn-secondary flex items-center gap-2"><FiArrowLeft /> Back</button>
          <button onClick={() => window.print()} className="btn btn-primary flex items-center gap-2"><FiPrinter /> Print / Save as PDF</button>
        </div>

        <div className="bg-white shadow print:shadow-none p-6">
          <div className="text-center border-b-2 border-gray-800 pb-3 mb-4">
            <div className="text-xl font-extrabold tracking-wide">SECURED ENGINEERS PVT. LTD.</div>
            <div className="text-sm font-bold mt-1 uppercase tracking-widest text-indigo-800">Rate Enquiry — Full Project Quantity</div>
            <div className="text-[11px] text-gray-600">SOP-05.2 · One negotiation for the whole project — quote your best rate for the FULL quantity below</div>
          </div>

          <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-[12px] mb-4">
            <div><b>Enquiry Ref:</b> RE/{d.indent.indent_number}</div>
            <div><b>Date:</b> {new Date().toLocaleDateString('en-IN')}</div>
            <div><b>Project / Site:</b> {d.indent.site_name || d.indent.client_name || '—'}</div>
            <div><b>SEPL Lead No.:</b> {d.indent.lead_no || '—'}</div>
            <div><b>Vendor (To):</b> ________________________________</div>
            <div><b>Reply By:</b> ____________ <span className="text-gray-500">(within 3 days — SOP-05.3)</span></div>
          </div>

          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-blue-800 text-white uppercase text-[10px]">
                <th className="border border-gray-800 px-1 py-1.5 w-8">Sl</th>
                <th className="border border-gray-800 px-2 py-1.5 text-left">Item · Specification · Make</th>
                <th className="border border-gray-800 px-1 py-1.5 w-12">UOM</th>
                <th className="border border-gray-800 px-1 py-1.5 w-20">Full Qty</th>
                <th className="border border-gray-800 px-1 py-1.5 w-20">Rate (Rs)</th>
                <th className="border border-gray-800 px-1 py-1.5 w-20">Delivery (days)</th>
                <th className="border border-gray-800 px-2 py-1.5 w-28">Terms / Credit</th>
              </tr>
            </thead>
            <tbody>
              {d.items.map((it, i) => (
                <tr key={it.id}>
                  <td className="border border-gray-400 px-1 py-1.5 text-center">{i + 1}</td>
                  <td className="border border-gray-400 px-2 py-1.5">
                    <b>{it.name}</b>
                    {(it.specification || it.size || it.make) && (
                      <div className="text-[10px] text-gray-600">{[it.specification, it.size, it.make && `Make: ${it.make}`].filter(Boolean).join(' · ')}</div>
                    )}
                  </td>
                  <td className="border border-gray-400 px-1 py-1.5 text-center">{String(it.uom || '').toUpperCase()}</td>
                  <td className="border border-gray-400 px-1 py-1.5 text-center font-bold">
                    {it.full_qty}
                    <div className="text-[9px] font-normal text-gray-500">{it.qty_source}</div>
                  </td>
                  <td className="border border-gray-400 px-1 py-1.5"></td>
                  <td className="border border-gray-400 px-1 py-1.5"></td>
                  <td className="border border-gray-400 px-2 py-1.5"></td>
                </tr>
              ))}
              {d.items.length === 0 && (
                <tr><td colSpan={7} className="border border-gray-400 px-2 py-6 text-center text-gray-500">
                  Every item on this indent already has vendor rates — nothing left to enquire.
                </td></tr>
              )}
            </tbody>
          </table>

          <div className="mt-4 text-[10px] text-gray-700 space-y-0.5">
            <p>1. Rates must be quoted for the FULL project quantity shown — not small lots (SOP-05.2).</p>
            <p>2. Mention delivery time in days and credit terms per line. A written delivery date is mandatory before any PO ("no date, no PO").</p>
            <p>3. Finalised rates stand as the Rate Contract for the entire project — no rate revision at indent time (SOP-05.6).</p>
          </div>

          <div className="flex justify-between mt-10 text-[11px]">
            <div className="text-center"><div className="border-t border-gray-500 pt-1 px-8">Vendor Sign &amp; Stamp</div></div>
            <div className="text-center"><div className="border-t border-gray-500 pt-1 px-8">For Secured Engineers Pvt. Ltd.</div></div>
          </div>
        </div>
      </div>
    </div>
  );
}
