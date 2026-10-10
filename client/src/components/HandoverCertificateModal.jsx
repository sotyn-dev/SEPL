// SOP-15.5 & SOP-15.6 Handover Certificate Modal
// View, Sign, and Print Official Handover Certificate (HC-YYYY-XXXX)

import { useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiCheckCircle, FiPrinter, FiShield, FiCalendar, FiClock, FiDollarSign } from 'react-icons/fi';
import { fmtDate } from '../utils/datetime';

export default function HandoverCertificateModal({ cert, onClose, onSigned }) {
  const [signing, setSigning] = useState(false);
  const [signedDate, setSignedDate] = useState(new Date().toISOString().slice(0, 10));

  if (!cert) return null;

  const handleSign = async () => {
    if (!window.confirm(`Sign Handover Certificate ${cert.certificate_number}?\n\nThis will trigger the Final Sales Bill, schedule the Retention payment, and start the 12-month Warranty period (SOP-15.6).`)) return;
    setSigning(true);
    try {
      await api.post('/snags/sop15/sign-handover', {
        cert_id: cert.id,
        signed_date: signedDate,
      });
      toast.success(`Handover Certificate ${cert.certificate_number} signed! Final bill and warranty initiated.`);
      if (onSigned) onSigned();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to sign certificate');
    } finally {
      setSigning(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  return (
    <Modal isOpen onClose={onClose} title={`Handover Certificate · ${cert.certificate_number}`} wide>
      <div className="space-y-6">
        {/* Printable Certificate Sheet */}
        <div className="border-2 border-slate-800 p-6 md:p-8 rounded-lg bg-white shadow-sm print:border-0 print:p-0 print:shadow-none font-sans text-slate-800">
          {/* Header */}
          <div className="border-b-2 border-slate-800 pb-4 flex flex-col md:flex-row justify-between items-start md:items-end gap-3">
            <div>
              <div className="text-xl md:text-2xl font-black tracking-wider text-slate-900 uppercase">
                SECURED ENGINEERS PVT. LTD.
              </div>
              <div className="text-xs text-slate-600 font-medium">
                Fire Protection · MEPF Contracting · Turnkey Engineering Services
              </div>
            </div>
            <div className="text-right">
              <span className="bg-emerald-100 text-emerald-800 border border-emerald-300 px-3 py-1 rounded text-xs font-mono font-bold uppercase tracking-wide">
                {cert.status === 'signed' ? '✓ SIGNED & EXECUTED' : 'DRAFT CERTIFICATE'}
              </span>
              <div className="text-xs font-mono text-slate-500 mt-1">
                Ref: <strong className="text-slate-900">{cert.certificate_number}</strong>
              </div>
            </div>
          </div>

          <div className="text-center my-6">
            <h2 className="text-lg md:text-xl font-bold tracking-wide uppercase text-slate-900 underline decoration-slate-400 underline-offset-4">
              Project Handover &amp; Completion Certificate (SOP-15)
            </h2>
            <p className="text-xs text-slate-500 mt-1">
              Issued in accordance with Contracting Standards and Client Handover Protocol
            </p>
          </div>

          {/* Details Table */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs border border-slate-200 rounded-lg p-4 bg-slate-50/50 mb-6">
            <div>
              <span className="text-slate-500 block">Project / Site Name:</span>
              <span className="font-bold text-slate-900 text-sm">{cert.project_name || cert.site_name || '—'}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Client Organization:</span>
              <span className="font-bold text-slate-900 text-sm">{cert.client_name || '—'}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Handover Date:</span>
              <span className="font-semibold text-slate-900">{fmtDate(cert.handover_date)}</span>
            </div>
            <div>
              <span className="text-slate-500 block">Snag Rectification Status:</span>
              <span className="font-semibold text-emerald-700 flex items-center gap-1">
                <FiCheckCircle size={13} /> 100% Resolved &amp; Client Ticked ({cert.snags_closed || 0}/{cert.snags_total || 0} Snags)
              </span>
            </div>
          </div>

          {/* Declaration Clause */}
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-4 text-xs space-y-2 mb-6">
            <div className="font-semibold text-slate-900">Completion &amp; Handover Declaration:</div>
            <p className="text-slate-600 leading-relaxed">
              This is to certify that the MEPF / Fire Protection works contracted to Secured Engineers Pvt. Ltd. at the aforementioned site have reached 100% physical completion. A joint snag inspection was carried out with the Client's Representative, and all items on the punch-list have been fully addressed, verified, and accepted.
            </p>
            <p className="text-slate-600 leading-relaxed">
              Upon mutual execution of this certificate, the installation is officially handed over to the Client for active operation and maintenance.
            </p>
          </div>

          {/* Retention & Warranty Terms (SOP-15.6) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 border border-slate-200 rounded-lg p-3.5 bg-white text-xs mb-8">
            <div className="p-2.5 rounded bg-blue-50/60 border border-blue-200">
              <span className="text-[11px] font-semibold text-blue-900 block flex items-center gap-1">
                <FiDollarSign size={12} /> Retention Schedule (5%)
              </span>
              <div className="font-bold text-sm text-blue-800 mt-1">
                ₹{Number(cert.retention_amount || 0).toLocaleString('en-IN')}
              </div>
              <span className="text-[10px] text-blue-600 mt-0.5 block">
                Due: {fmtDate(cert.retention_due_date)}
              </span>
            </div>

            <div className="p-2.5 rounded bg-purple-50/60 border border-purple-200">
              <span className="text-[11px] font-semibold text-purple-900 block flex items-center gap-1">
                <FiShield size={12} /> Warranty Period (DLP)
              </span>
              <div className="font-bold text-sm text-purple-800 mt-1">
                {cert.warranty_months || 12} Months
              </div>
              <span className="text-[10px] text-purple-600 mt-0.5 block">
                Until: {fmtDate(cert.warranty_end_date)}
              </span>
            </div>

            <div className="p-2.5 rounded bg-emerald-50/60 border border-emerald-200">
              <span className="text-[11px] font-semibold text-emerald-900 block flex items-center gap-1">
                <FiClock size={12} /> Final Sales Billing
              </span>
              <div className="font-bold text-sm text-emerald-800 mt-1">
                {cert.final_bill_triggered ? 'Triggered ✓' : 'Queued for Signature'}
              </div>
              <span className="text-[10px] text-emerald-600 mt-0.5 block">
                SOP-15.6 Trigger
              </span>
            </div>
          </div>

          {/* Signatures Section */}
          <div className="grid grid-cols-2 gap-8 pt-8 border-t border-slate-300 text-xs mt-8">
            <div className="space-y-6">
              <span className="text-slate-500 font-medium block">Handed Over By (Secured Engineers):</span>
              <div className="border-b border-slate-400 w-48 h-8"></div>
              <div>
                <strong className="block text-slate-900">{cert.company_signatory || 'Authorized Signatory'}</strong>
                <span className="text-slate-500 text-[11px]">Secured Engineers Pvt. Ltd.</span>
              </div>
            </div>

            <div className="space-y-6 text-right">
              <span className="text-slate-500 font-medium block">Accepted &amp; Received By (Client):</span>
              <div className="border-b border-slate-400 w-48 h-8 ml-auto"></div>
              <div>
                <strong className="block text-slate-900">{cert.client_signatory || 'Client Authorized Representative'}</strong>
                <span className="text-slate-500 text-[11px]">{cert.client_name || 'Client Organization'}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer Actions */}
        <div className="flex items-center justify-between border-t pt-3 flex-wrap gap-2 text-xs">
          <div className="text-slate-500">
            {cert.status === 'signed' ? (
              <span className="text-emerald-700 font-semibold flex items-center gap-1">
                <FiCheckCircle size={14} /> Certificate signed on {fmtDate(cert.signed_date)}. Final bill &amp; retention active.
              </span>
            ) : (
              <span>Ready for signing. Client signature initiates final bill &amp; retention schedule.</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={handlePrint} className="btn btn-secondary text-sm flex items-center gap-1.5">
              <FiPrinter size={14} /> Print Certificate
            </button>
            {cert.status !== 'signed' && (
              <button
                type="button"
                onClick={handleSign}
                disabled={signing}
                className="btn btn-primary text-sm flex items-center gap-1.5 shadow-sm"
              >
                <FiCheckCircle size={14} /> {signing ? 'Signing…' : 'Sign & Complete Handover (S6)'}
              </button>
            )}
            <button type="button" onClick={onClose} className="btn btn-secondary text-sm">
              Close
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
