// Print-ready Site Store Issue / Return slip ("GRN bill", mam 2026-07-31).
//
// SPOS site-inventory cycle: the JR. site engineer (store responsible)
// issues material to the Sr. engineer on a numbered ISU slip in the
// morning and takes the unused balance back on an RTN slip in the
// evening. This page prints either slip with signature blocks so the
// paper trail matches the digital one.
//
// Same HTML→Ctrl+P→Save-as-PDF pattern as VendorPOPrint / DeliveryNotePrint.
// Route: /site-slip/:id/print

import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';

const COMPANY = {
  name: 'SECURED ENGINEERS PVT. LTD',
  gstin: '03AASCS7836D2Z3',
  pan:   'AASCS7836D',
  ho:    'HO: 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003',
  noida: 'Noida: 91, Springboard, Sector 2, Noida (UP)',
};

const fmtDateLong = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export default function SiteSlipPrint() {
  const { id } = useParams();
  const [slip, setSlip] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get(`/dpr/site-slips/${id}`)
      .then(r => setSlip(r.data))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load slip'));
  }, [id]);

  if (err) return <div className="p-8 text-center text-red-600">{err}</div>;
  if (!slip) return <div className="p-8 text-center text-gray-500">Loading slip…</div>;

  const isIssue = slip.slip_type === 'issue';
  const title = isIssue ? 'SITE STORE ISSUE SLIP' : 'SITE STORE RETURN SLIP';
  const rows = slip.items || [];
  const padded = [...rows];
  while (padded.length < 8) padded.push(null);

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0">
      <div className="max-w-[210mm] mx-auto mb-3 flex justify-end gap-2 print:hidden px-2">
        <button onClick={() => window.print()} className="bg-red-700 text-white text-sm font-semibold px-4 py-2 rounded shadow hover:bg-red-800">
          🖨 Print / Save as PDF
        </button>
      </div>

      <div className="bg-white max-w-[210mm] mx-auto shadow print:shadow-none text-[11px] leading-snug text-gray-900">
        {/* Red top strip */}
        <div className="bg-red-700 text-white flex justify-between items-center px-3 py-1 text-[10px] font-semibold">
          <span>GSTIN: {COMPANY.gstin}</span>
          <span className="text-[13px] tracking-wider">{title}</span>
          <span>PAN: {COMPANY.pan}</span>
        </div>

        {/* Company block */}
        <div className="text-center border-b border-gray-300 px-3 py-2">
          <div className="text-[16px] font-extrabold text-red-700 tracking-wide">{COMPANY.name}</div>
          <div className="text-[9.5px] text-gray-600">{COMPANY.ho}</div>
          <div className="text-[9.5px] text-gray-600">{COMPANY.noida}</div>
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 border-b border-gray-300 text-[10.5px]">
          <div className="px-3 py-1.5 border-r border-gray-200"><span className="text-gray-500">Slip No: </span><b className="font-mono">{slip.slip_number}</b></div>
          <div className="px-3 py-1.5 border-r border-gray-200"><span className="text-gray-500">Date: </span><b>{fmtDateLong(slip.slip_date)}</b></div>
          <div className="px-3 py-1.5 border-r border-gray-200"><span className="text-gray-500">Site: </span><b>{slip.site_name || '—'}</b></div>
          <div className="px-3 py-1.5"><span className="text-gray-500">Store: </span><b>{slip.store_name || '—'}</b></div>
        </div>

        {/* Parties */}
        <div className="grid grid-cols-2 border-b border-gray-300 text-[10.5px]">
          <div className="px-3 py-1.5 border-r border-gray-200">
            <span className="text-gray-500">{isIssue ? 'Issued To (Sr. Site Engineer / Team): ' : 'Returned By: '}</span>
            <b>{slip.issued_to || '—'}</b>
          </div>
          <div className="px-3 py-1.5">
            <span className="text-gray-500">Store In-charge (Jr. Site Engineer): </span>
            <b>{slip.created_by_name || '—'}</b>
          </div>
        </div>

        {/* Items table */}
        <table className="w-full border-collapse text-[10.5px]">
          <thead>
            <tr className="bg-red-50 text-red-800 font-bold uppercase text-[9.5px]">
              <td className="border border-gray-300 px-2 py-1 w-8 text-center">SL</td>
              <td className="border border-gray-300 px-2 py-1">Description of Material</td>
              <td className="border border-gray-300 px-2 py-1 w-16 text-center">UOM</td>
              <td className="border border-gray-300 px-2 py-1 w-24 text-right">{isIssue ? 'Qty Issued' : 'Qty Returned'}</td>
              <td className="border border-gray-300 px-2 py-1 w-28">Remarks</td>
            </tr>
          </thead>
          <tbody>
            {padded.map((it, i) => (
              <tr key={i}>
                <td className="border border-gray-300 px-2 py-1 text-center">{it ? i + 1 : ' '}</td>
                <td className="border border-gray-300 px-2 py-1">{it ? it.item_name : ''}</td>
                <td className="border border-gray-300 px-2 py-1 text-center">{it ? it.unit : ''}</td>
                <td className="border border-gray-300 px-2 py-1 text-right tabular-nums">{it ? it.quantity : ''}</td>
                <td className="border border-gray-300 px-2 py-1"></td>
              </tr>
            ))}
          </tbody>
        </table>

        {slip.notes && (
          <div className="px-3 py-1.5 border-b border-gray-300 text-[10px]"><span className="text-gray-500">Notes: </span>{slip.notes}</div>
        )}

        {/* Rule strip */}
        <div className="px-3 py-1.5 bg-amber-50 border-b border-gray-300 text-[9.5px] text-amber-800 font-semibold">
          {isIssue
            ? 'SPOS RULE: Material leaves the site store ONLY on this slip. Unused balance MUST return in the evening on a Return Slip — net consumption feeds the DPR automatically.'
            : 'SPOS RULE: Returned quantity goes back into site-store stock. Issued − Returned = today\'s consumption, auto-recorded in the DPR.'}
        </div>

        {/* Signatures */}
        <div className="grid grid-cols-2 text-[10px]">
          <div className="px-3 pt-6 pb-3 border-r border-gray-200">
            <div className="border-t border-gray-500 inline-block pt-1 min-w-[160px]">
              {isIssue ? 'Received By (Sr. Site Engineer)' : 'Returned By'} — Signature
            </div>
          </div>
          <div className="px-3 pt-6 pb-3 text-right">
            <div className="border-t border-gray-500 inline-block pt-1 min-w-[160px]">
              Store In-charge (Jr. Site Engineer) — Signature
            </div>
          </div>
        </div>

        <div className="text-center text-[8.5px] text-gray-400 py-1.5 border-t border-gray-200">
          Computer-generated slip · {slip.slip_number} · SEPL ERP (SPOS Site Inventory)
        </div>
      </div>
    </div>
  );
}
