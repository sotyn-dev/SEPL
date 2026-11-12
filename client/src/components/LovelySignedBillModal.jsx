import { useState } from 'react';
import { FiCheckCircle, FiUpload, FiFileText, FiAlertCircle, FiX, FiDownload, FiTruck } from 'react-icons/fi';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';
import { fmtDateTime } from '../utils/datetime';

export default function LovelySignedBillModal({ isOpen, onClose, deliveryNote, onSaved }) {
  const [file, setFile] = useState(null);
  const [notes, setNotes] = useState(deliveryNote?.lovely_signed_bill_notes || '');
  const [uploading, setUploading] = useState(false);

  if (!isOpen || !deliveryNote) return null;

  const currentFile = deliveryNote.lovely_signed_bill_file;
  const isPdf = currentFile && /\.pdf$/i.test(currentFile);
  const isDispatched = !!deliveryNote.lovely_signed_bill_file;

  const handleFileChange = (e) => {
    const selected = e.target.files?.[0];
    if (!selected) return;
    if (selected.size > 10 * 1024 * 1024) {
      return toast.error('File size must be under 10 MB');
    }
    setFile(selected);
  };

  const handleUpload = async (e) => {
    e.preventDefault();
    if (!file && !currentFile) {
      return toast.error('Please choose the signed and stamped bill file to upload');
    }

    setUploading(true);
    try {
      const fd = new FormData();
      if (file) fd.append('file', file);
      if (notes) fd.append('notes', notes);

      const { data } = await api.post(`/procurement/delivery-notes/${deliveryNote.id}/lovely-signed-bill`, fd, {
        headers: { 'Content-Type': 'multipart/form-data' }
      });

      toast.success(data.message || 'CRM signed bill uploaded successfully! Saman dispatch cleared.');
      if (onSaved) onSaved();
      onClose();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to upload signed bill');
    } finally {
      setUploading(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="CRM Signed & Stamped Bill — Dispatch Clearance (TSK-0784)"
      wide
    >
      <form onSubmit={handleUpload} className="space-y-4">
        {/* Document Header Details */}
        <div className="bg-slate-50 border border-slate-200 rounded-xl p-3.5 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3 text-xs">
          <div>
            <div className="font-mono font-bold text-blue-700 text-sm">
              {deliveryNote.document_number || `Challan #${deliveryNote.id}`}
            </div>
            <div className="text-slate-600 mt-0.5">
              Site: <strong className="text-slate-900">{deliveryNote.site_name || deliveryNote.company_name || 'Central Godown'}</strong>
              {deliveryNote.vendor_name ? ` · Vendor: ${deliveryNote.vendor_name}` : deliveryNote.source === 'store' ? ' · Store Issue' : ''}
            </div>
            {deliveryNote.indent_number && (
              <div className="text-slate-500 text-[11px]">
                Indent: <span className="font-mono">{deliveryNote.indent_number}</span>
              </div>
            )}
          </div>
          <div className="text-right">
            {isDispatched ? (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">
                <FiCheckCircle /> Stamped &amp; Saman Cleared
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-bold bg-rose-100 text-rose-800 border border-rose-200">
                <FiAlertCircle /> Saman Blocked (Bill Required)
              </span>
            )}
          </div>
        </div>

        {/* SOP Rule Banner */}
        <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-950 leading-relaxed space-y-1">
          <div className="font-bold flex items-center gap-1.5 text-amber-900">
            <FiTruck /> SOP-0784 Rule (CRM Sign &amp; Stamp Mandatory):
          </div>
          <p>
            Bill cut hone ke baad, uspe <strong>SEPL company stamp</strong> lagwa kar aur <strong>CRM ke signatures</strong> karwa kar <strong>Ajmer Sir</strong> usse SOTYN pe upload karenge.
            Iske bina godown se saman dispatch nahi hoga taki complete digital record maintain rahe.
          </p>
        </div>

        {/* Currently Uploaded Bill Record */}
        {currentFile && (
          <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-xl text-xs space-y-2">
            <div className="flex justify-between items-center">
              <span className="font-bold text-emerald-900 flex items-center gap-1.5">
                <FiCheckCircle className="text-emerald-600" /> Stamped Bill on Record:
              </span>
              <a
                href={currentFile}
                target="_blank"
                rel="noreferrer"
                className="btn btn-secondary text-xs px-2.5 py-1 text-blue-700 hover:text-blue-900 flex items-center gap-1 font-semibold"
              >
                <FiDownload size={13} /> View / Download Document
              </a>
            </div>
            <div className="text-[11px] text-slate-600 flex flex-wrap gap-x-4">
              <span>Uploaded By: <strong>{deliveryNote.lovely_signed_bill_uploaded_by_name || 'Ajmer Sir'}</strong></span>
              {deliveryNote.lovely_signed_bill_uploaded_at && (
                <span>Date: <strong>{fmtDateTime(deliveryNote.lovely_signed_bill_uploaded_at)}</strong></span>
              )}
            </div>
            {!isPdf && (
              <div className="mt-2 text-center">
                <img
                  src={currentFile}
                  alt="Stamped Bill"
                  className="max-h-48 mx-auto rounded border border-slate-300 shadow-sm"
                />
              </div>
            )}
          </div>
        )}

        {/* Upload Form Area */}
        <div className="space-y-3">
          <label className="block text-xs font-semibold text-slate-800">
            {currentFile ? 'Upload New / Replacement Stamped Bill (PDF or Photo)' : 'Choose Stamped & Signed Bill File *'}
          </label>
          <div className="border-2 border-dashed border-slate-300 hover:border-blue-400 rounded-xl p-5 text-center bg-slate-50 hover:bg-slate-100/60 transition-colors">
            <input
              type="file"
              id="lovely-signed-bill-input"
              accept=".pdf,image/png,image/jpeg,image/jpg,image/webp"
              onChange={handleFileChange}
              className="hidden"
            />
            {file ? (
              <div className="space-y-2">
                <div className="font-semibold text-sm text-slate-900 flex items-center justify-center gap-2">
                  <FiFileText className="text-blue-600" size={18} />
                  <span>{file.name}</span>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="text-red-500 hover:text-red-700"
                    title="Remove"
                  >
                    <FiX size={16} />
                  </button>
                </div>
                <div className="text-xs text-slate-500">
                  Size: {(file.size / (1024 * 1024)).toFixed(2)} MB
                </div>
              </div>
            ) : (
              <label htmlFor="lovely-signed-bill-input" className="cursor-pointer block space-y-2">
                <div className="w-12 h-12 bg-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto">
                  <FiUpload size={22} />
                </div>
                <div className="text-sm font-semibold text-slate-800">
                  Click to select signed &amp; stamped bill file
                </div>
                <div className="text-xs text-slate-500">
                  PDF or Scanned Photo / Camera Snap (PNG, JPG up to 10 MB)
                </div>
              </label>
            )}
          </div>
        </div>

        {/* Dispatch Remarks / Notes */}
        <div>
          <label className="block text-xs font-semibold text-slate-800 mb-1">
            Dispatch Remarks / Vehicle Details (Optional)
          </label>
          <textarea
            className="input w-full text-xs"
            rows="2"
            placeholder="e.g. Stamped & signed by CRM. Material dispatched in vehicle PB-10-XX with driver Ramesh."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        {/* Modal Buttons */}
        <div className="flex justify-end gap-2 pt-3 border-t">
          <button
            type="button"
            disabled={uploading}
            onClick={onClose}
            className="btn btn-secondary text-xs"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={uploading || (!file && !currentFile)}
            className="btn bg-emerald-600 hover:bg-emerald-700 text-white font-semibold text-xs flex items-center gap-1.5 shadow-sm disabled:opacity-40"
          >
            {uploading ? 'Uploading…' : (
              <>
                <FiCheckCircle size={14} />
                {currentFile && !file ? 'Save Remarks' : 'Upload Stamped Bill & Clear Saman'}
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
}

