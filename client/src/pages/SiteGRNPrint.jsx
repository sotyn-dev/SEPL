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
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

function parsePhotos(val) {
  if (!val) return [];
  if (Array.isArray(val)) return val.filter(Boolean);
  if (typeof val === 'string') {
    try {
      const parsed = JSON.parse(val);
      if (Array.isArray(parsed)) return parsed.filter(Boolean);
    } catch (_) {}
    if (val.startsWith('/uploads') || val.startsWith('http')) {
      return val.split(',').map(s => s.trim()).filter(Boolean);
    }
  }
  return [];
}

function isPdfUrl(url) {
  return typeof url === 'string' && (/\.pdf($|\?)/i.test(url) || url.includes('/pdf'));
}

export default function SiteGRNPrint() {
  const { id } = useParams();
  const [grn, setGrn] = useState(null);
  const [err, setErr] = useState(null);

  useEffect(() => {
    api.get(`/site-grn/grn/${id}`)
      .then(res => setGrn(res.data))
      .catch(e => setErr(e?.response?.data?.error || e.message));
  }, [id]);

  if (err) return <div className="p-8 text-center text-red-600 font-semibold">{err}</div>;
  if (!grn) return <div className="p-8 text-center text-gray-500">Loading Goods Receipt Note…</div>;

  const items = grn.items || [];

  return (
    <div className="bg-gray-100 min-h-screen py-6 print:bg-white print:py-0 font-sans">
      {/* Print Trigger Button (Hidden in Print) */}
      <div className="max-w-[210mm] mx-auto mb-3 flex justify-end gap-2 print:hidden px-2">
        <button
          onClick={() => window.print()}
          className="bg-indigo-700 text-white text-sm font-semibold px-4 py-2 rounded shadow hover:bg-indigo-800 transition"
        >
          🖨 Print / Save as PDF
        </button>
      </div>

      {/* Main Document Box */}
      <div className="bg-white max-w-[210mm] mx-auto p-8 shadow-md print:shadow-none text-xs text-gray-900 border border-gray-200">
        {/* Company Header */}
        <div className="border-b-2 border-gray-900 pb-3 mb-4 flex justify-between items-start">
          <div>
            <h1 className="text-xl font-bold text-gray-900 tracking-tight">{COMPANY.name}</h1>
            <p className="text-[10px] text-gray-600 mt-0.5">{COMPANY.ho}</p>
            <p className="text-[10px] text-gray-600">{COMPANY.noida}</p>
            <div className="flex gap-4 mt-1 font-mono text-[10px] text-gray-700">
              <span><strong>GSTIN:</strong> {COMPANY.gstin}</span>
              <span><strong>PAN:</strong> {COMPANY.pan}</span>
            </div>
          </div>
          <div className="text-right">
            <span className="inline-block bg-gray-900 text-white font-bold px-3 py-1 text-sm tracking-wider uppercase">
              GOODS RECEIPT NOTE (GRN)
            </span>
            <div className="mt-2 text-right">
              <span className="text-gray-500 text-[10px] block">GRN NUMBER</span>
              <span className="font-mono text-base font-extrabold text-indigo-900">{grn.grn_number}</span>
            </div>
          </div>
        </div>

        {/* GRN & Delivery Details Grid */}
        <div className="grid grid-cols-2 gap-4 border border-gray-300 p-3 rounded mb-4 bg-gray-50/50">
          <div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr>
                  <td className="py-0.5 text-gray-500 w-32">GRN Date:</td>
                  <td className="py-0.5 font-bold">{fmtDateLong(grn.grn_date)}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Supplier / Vendor:</td>
                  <td className="py-0.5 font-bold text-gray-900">{grn.vendor_name || '—'}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Purchase Order (PO):</td>
                  <td className="py-0.5 font-mono font-semibold text-indigo-700">{grn.po_number || 'Direct/Indent'}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Received By:</td>
                  <td className="py-0.5">{grn.received_by_name || 'Store In-Charge'}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <div>
            <table className="w-full text-[11px]">
              <tbody>
                <tr>
                  <td className="py-0.5 text-gray-500 w-32">Site / Project:</td>
                  <td className="py-0.5 font-bold">{grn.site_name || 'General Site'}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Store / Warehouse:</td>
                  <td className="py-0.5 font-bold">{grn.warehouse_name || 'Site Store'}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Delivery Challan No:</td>
                  <td className="py-0.5 font-bold text-gray-900">{grn.delivery_challan_no}</td>
                </tr>
                <tr>
                  <td className="py-0.5 text-gray-500">Challan Date / Veh:</td>
                  <td className="py-0.5">{fmtDateLong(grn.challan_date)} {grn.vehicle_number ? `(${grn.vehicle_number})` : ''}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>

        {/* Material Items Table */}
        <div className="mb-4">
          <table className="w-full border-collapse border border-gray-300 text-[11px]">
            <thead>
              <tr className="bg-gray-100 text-gray-800 uppercase text-[10px]">
                <th className="border border-gray-300 py-1.5 px-2 text-center w-8">#</th>
                <th className="border border-gray-300 py-1.5 px-2 text-left">Item Description</th>
                <th className="border border-gray-300 py-1.5 px-2 text-center w-14">Unit</th>
                <th className="border border-gray-300 py-1.5 px-2 text-right w-16">PO Qty</th>
                <th className="border border-gray-300 py-1.5 px-2 text-right w-16">Prev Rec</th>
                <th className="border border-gray-300 py-1.5 px-2 text-right w-16">Received</th>
                <th className="border border-gray-300 py-1.5 px-2 text-right w-16 bg-emerald-50 text-emerald-900 font-bold">Accepted</th>
                <th className="border border-gray-300 py-1.5 px-2 text-right w-16 bg-rose-50 text-rose-900 font-bold">Rejected</th>
                <th className="border border-gray-300 py-1.5 px-2 text-left">Remarks / Rejection Reason</th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={idx} className="border-b border-gray-200">
                  <td className="border border-gray-300 py-1.5 px-2 text-center text-gray-500">{idx + 1}</td>
                  <td className="border border-gray-300 py-1.5 px-2 font-medium">
                    {it.material_name}
                    {it.item_code && <span className="text-[9px] text-gray-400 block font-mono">{it.item_code}</span>}
                  </td>
                  <td className="border border-gray-300 py-1.5 px-2 text-center text-gray-600">{it.unit}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-right font-mono text-gray-600">{it.po_qty}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-right font-mono text-gray-500">{it.prev_received_qty}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-right font-mono font-semibold">{it.curr_received_qty}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-right font-mono font-bold text-emerald-800 bg-emerald-50/50">{it.accepted_qty}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-right font-mono font-bold text-rose-800 bg-rose-50/50">{it.rejected_qty}</td>
                  <td className="border border-gray-300 py-1.5 px-2 text-gray-600 text-[10px]">
                    {it.rejection_reason ? <span className="text-rose-700 font-semibold">{it.rejection_reason}</span> : (it.remarks || '—')}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-gray-50 font-bold border-t-2 border-gray-400">
                <td colSpan="5" className="border border-gray-300 py-1.5 px-2 text-right uppercase text-[10px]">Total Quantities:</td>
                <td className="border border-gray-300 py-1.5 px-2 text-right font-mono">
                  {items.reduce((s, x) => s + Number(x.curr_received_qty || 0), 0)}
                </td>
                <td className="border border-gray-300 py-1.5 px-2 text-right font-mono text-emerald-800 bg-emerald-50">
                  {items.reduce((s, x) => s + Number(x.accepted_qty || 0), 0)}
                </td>
                <td className="border border-gray-300 py-1.5 px-2 text-right font-mono text-rose-800 bg-rose-50">
                  {items.reduce((s, x) => s + Number(x.rejected_qty || 0), 0)}
                </td>
                <td className="border border-gray-300 py-1.5 px-2"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        {/* Remarks and Conditions */}
        <div className="border border-gray-200 p-2.5 rounded mb-4 text-[10px] text-gray-600 bg-gray-50">
          <p><strong>Remarks / Gate Notes:</strong> {grn.remarks || 'Material physically checked, unloaded, and entered into Site Store ledger.'}</p>
          {grn.approval_remarks && (
            <p className="mt-1"><strong>Approval Notes:</strong> {grn.approval_remarks}</p>
          )}
          <p className="mt-1 text-[9px] text-gray-400 italic">
            * This document confirms physical receipt of goods at project site. Stock is automatically credited to the Site Store for Accepted Quantities only. Rejected items are held separately.
          </p>
        </div>

        {/* Attached Photos / Delivery Proofs (if any) */}
        {(grn.challan_doc_url || (grn.material_photos && grn.material_photos !== '[]')) && (
          <div className="border border-gray-200 p-2.5 rounded mb-5 bg-gray-50/50">
            <span className="text-[10px] font-bold text-gray-700 uppercase block mb-1.5">Attached Delivery Proofs & Photos:</span>
            <div className="flex flex-wrap gap-2.5 items-center">
              {grn.challan_doc_url && !isPdfUrl(grn.challan_doc_url) && (
                <div className="text-center">
                  <img src={grn.challan_doc_url} alt="Challan Doc" className="h-20 max-w-[120px] object-cover rounded border border-gray-300 shadow-2xs" />
                  <span className="text-[8px] text-gray-500 block mt-0.5 font-semibold">Challan Copy</span>
                </div>
              )}
              {parsePhotos(grn.material_photos).map((pUrl, pIdx) => (
                <div key={pIdx} className="text-center">
                  <img src={pUrl} alt="Unloading Photo" className="h-20 max-w-[120px] object-cover rounded border border-gray-300 shadow-2xs" />
                  <span className="text-[8px] text-gray-500 block mt-0.5">Photo #{pIdx + 1}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Signatures & Approvals Box */}
        <div className="grid grid-cols-4 gap-4 pt-6 border-t-2 border-gray-300 text-center text-[10px]">
          <div>
            <div className="h-10 border-b border-gray-300 flex items-end justify-center pb-1 text-gray-700 font-semibold">
              {grn.received_by_name || 'Store Keeper'}
            </div>
            <span className="text-gray-500 block mt-1 uppercase font-bold">Received By (Store)</span>
            <span className="text-gray-400 text-[9px]">{fmtDateLong(grn.created_at)}</span>
          </div>

          <div>
            <div className="h-10 border-b border-gray-300 flex items-end justify-center pb-1 text-gray-700 font-semibold">
              {grn.verified_by_name || (grn.status !== 'draft' ? 'Site Engineer' : '—')}
            </div>
            <span className="text-gray-500 block mt-1 uppercase font-bold">Verified By (Site Engg)</span>
            <span className="text-gray-400 text-[9px]">{fmtDateLong(grn.verified_at)}</span>
          </div>

          <div>
            <div className="h-10 border-b border-gray-300 flex items-end justify-center pb-1 text-gray-700 font-semibold">
              {grn.approved_by_name || (grn.status === 'approved' ? 'Project Manager' : '—')}
            </div>
            <span className="text-gray-500 block mt-1 uppercase font-bold">Approved By (Manager)</span>
            <span className="text-gray-400 text-[9px]">{fmtDateLong(grn.approved_at)}</span>
          </div>

          <div>
            <div className="h-10 border-b border-gray-300 flex items-end justify-center pb-1 text-gray-700 font-semibold">
              {grn.stock_updated === 1 ? 'Automated Ledger Entry' : '—'}
            </div>
            <span className="text-gray-500 block mt-1 uppercase font-bold">Site Stock Update Status</span>
            <span className="text-emerald-700 font-bold text-[9px]">
              {grn.stock_updated === 1 ? '✓ Stock Credited' : 'Pending Approval'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
