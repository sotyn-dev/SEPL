import { useState, useEffect } from 'react';
import {
  FiCheckCircle, FiAlertCircle, FiClock, FiMapPin,
  FiUser, FiTag, FiSearch, FiPrinter, FiTruck, FiArrowDownCircle, FiX, FiImage
} from 'react-icons/fi';
import Modal from './Modal';
import { generateCode128Svg } from '../utils/barcode128';
import { fmtDateTime } from '../utils/datetime';
import api from '../api';
import toast from 'react-hot-toast';

export default function ToolInspectionModal({ isOpen, onClose, tool: initialTool, code, onActionTriggered }) {
  const [currentTool, setCurrentTool] = useState(initialTool || null);
  const [searchInput, setSearchInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState('');

  const fetchByCode = async (lookupCode) => {
    if (!lookupCode) return;
    setLoading(true);
    setErrorMsg('');
    try {
      const { data } = await api.get(`/tools/barcode/${encodeURIComponent(lookupCode.trim())}`);
      setCurrentTool(data);
    } catch (err) {
      setErrorMsg(err.response?.data?.error || `Tool not found for barcode "${lookupCode}"`);
      setCurrentTool(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (code) {
      fetchByCode(code);
    } else if (initialTool) {
      setCurrentTool(initialTool);
    }
  }, [code, initialTool]);

  if (!isOpen) return null;

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    if (searchInput.trim()) {
      fetchByCode(searchInput.trim());
    }
  };

  const t = currentTool;
  const barcodeValue = t ? (t.barcode || t.tool_code) : '';
  const barcodeSvg = barcodeValue ? generateCode128Svg(barcodeValue, { height: 32, barWidth: 1.3, showText: false }) : '';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="RGP Tool Inspection & Barcode Scan"
      wide
    >
      <div className="space-y-4">
        {/* Fast Scanner / Search Bar */}
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" size={16} />
            <input
              type="text"
              className="input pl-9 text-sm font-mono"
              placeholder="Scan or enter Tool Code / Barcode / Serial No (e.g. T-2026-0001)…"
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              autoFocus
            />
          </div>
          <button type="submit" disabled={loading} className="btn btn-primary px-4 text-xs font-semibold">
            {loading ? 'Searching…' : 'Inspect'}
          </button>
        </form>

        {errorMsg && (
          <div className="p-3 bg-red-50 border border-red-200 text-red-700 rounded-xl text-xs flex items-center gap-2">
            <FiAlertCircle size={16} />
            <span>{errorMsg}</span>
          </div>
        )}

        {/* Tool Inspection Card */}
        {t && (
          <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm space-y-4">
            {/* Header Identity Bar */}
            <div className="bg-gradient-to-r from-slate-900 to-slate-800 text-white p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
              <div>
                <span className="text-[10px] uppercase font-bold tracking-widest text-slate-400 block mb-0.5">
                  RGP ASSET IDENTITY CARD
                </span>
                <h2 className="text-xl font-extrabold flex items-center gap-2">
                  <span>{t.tool_code}</span>
                  <span className="text-sm font-normal text-slate-300">· {t.name}</span>
                </h2>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className={`px-2.5 py-1 rounded-full text-xs font-bold uppercase ${
                  t.status === 'available' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30' :
                  t.status === 'in_use' ? 'bg-blue-500/20 text-blue-300 border border-blue-500/30' :
                  'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                }`}>
                  ● {t.status ? t.status.replace('_', ' ') : 'available'}
                </span>
                <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-white/10 text-slate-200">
                  Cond: {t.condition || 'good'}
                </span>
              </div>
            </div>

            {/* Core Tool Attributes Grid */}
            <div className="p-4 grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4 text-xs">
              {/* Box 1: Make & Machine Info */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Machine Details</div>
                <div><span className="text-slate-500">Company / Make:</span> <strong className="text-slate-900 text-sm ml-1">{t.brand || t.make || 'SEPL / Standard'}</strong></div>
                <div><span className="text-slate-500">Category:</span> <span className="font-semibold text-slate-800 ml-1">{t.category || 'Power Tool'}</span></div>
                <div><span className="text-slate-500">Model:</span> <span className="font-mono text-slate-800 ml-1">{t.model || '—'}</span></div>
                <div><span className="text-slate-500">Serial No:</span> <span className="font-mono text-slate-800 ml-1">{t.serial_no || '—'}</span></div>
              </div>

              {/* Box 2: Purchase & Age */}
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-500">Purchase & Valuation</div>
                <div><span className="text-slate-500">Purchase Date:</span> <strong className="text-slate-900 ml-1">{t.purchase_date || 'N/A'}</strong></div>
                <div><span className="text-slate-500">Recorded Rate:</span> <span className="font-bold text-emerald-700 ml-1">₹ {Number(t.purchase_price || 0).toLocaleString('en-IN')}</span></div>
                <div><span className="text-slate-500">Quantity / Unit:</span> <span className="font-semibold text-slate-800 ml-1">{t.quantity || 1} {t.resolved_unit || t.unit || 'Nos'}</span></div>
                <div><span className="text-slate-500">Next Calibration:</span> <span className="text-slate-800 ml-1">{t.next_calibration_date || 'Not Scheduled'}</span></div>
              </div>

              {/* Box 3: Current Site & Custodian */}
              <div className="p-3 bg-blue-50/60 border border-blue-200 rounded-xl space-y-1.5">
                <div className="text-[10px] font-bold uppercase tracking-wider text-blue-700">Current Location</div>
                <div className="flex items-center gap-1.5 text-blue-900 font-bold text-sm">
                  <FiMapPin className="text-blue-600 shrink-0" />
                  <span>{t.current_site_name || 'SEPL Central Godown'}</span>
                </div>
                {t.current_user_name && (
                  <div className="flex items-center gap-1.5 text-slate-700">
                    <FiUser className="text-slate-500 shrink-0" />
                    <span>Issued To: <strong>{t.current_user_name}</strong></span>
                  </div>
                )}
                {t.site_engineer_name && (
                  <div className="text-slate-600 text-[11px]">
                    Site Engineer: {t.site_engineer_name} {t.site_engineer_phone ? `(${t.site_engineer_phone})` : ''}
                  </div>
                )}
              </div>
            </div>

            {/* TVS Sticker Status & Photos Section */}
            <div className="px-4 pb-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Barcode & TVS Sticker Preview */}
              <div className="border border-slate-200 rounded-xl p-3 bg-slate-50">
                <div className="flex justify-between items-center mb-2">
                  <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5">
                    <FiTag /> TVS Barcode Label
                  </span>
                  <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                    t.sticker_status === 'pasted' ? 'bg-emerald-100 text-emerald-800' :
                    t.sticker_status === 'printed' ? 'bg-blue-100 text-blue-800' :
                    'bg-amber-100 text-amber-800'
                  }`}>
                    {t.sticker_status === 'pasted' ? '✅ Pasted & Photo Verified' :
                     t.sticker_status === 'printed' ? '📦 Printed (Pending Paste)' :
                     '🖨️ Pending Nancy Print'}
                  </span>
                </div>
                <div className="bg-white p-3 rounded-lg border text-center">
                  <div dangerouslySetInnerHTML={{ __html: barcodeSvg }} />
                  <div className="font-mono text-xs font-extrabold tracking-wider mt-1">{barcodeValue}</div>
                  {t.qrDataUrl && (
                    <img src={t.qrDataUrl} alt="QR Code" className="w-16 h-16 mx-auto mt-2 border rounded" />
                  )}
                </div>
                <div className="text-[11px] text-slate-500 mt-2 space-y-0.5">
                  {t.sticker_printed_at && (
                    <div>🖨️ Printed on: {fmtDateTime(t.sticker_printed_at)} {t.sticker_printed_by_name ? `by ${t.sticker_printed_by_name}` : ''}</div>
                  )}
                  {t.sticker_pasted_at && (
                    <div>✅ Pasted on: {fmtDateTime(t.sticker_pasted_at)} {t.sticker_pasted_by_name ? `by ${t.sticker_pasted_by_name}` : ''}</div>
                  )}
                </div>
              </div>

              {/* Physical Sticker Pasted Photo Proof */}
              <div className="border border-slate-200 rounded-xl p-3 bg-slate-50 flex flex-col justify-between">
                <div>
                  <span className="text-xs font-bold text-slate-700 flex items-center gap-1.5 mb-2">
                    <FiImage /> Physical Sticker on Machine (Photo Proof)
                  </span>
                  {t.sticker_photo_url ? (
                    <div className="relative text-center">
                      <a href={t.sticker_photo_url} target="_blank" rel="noreferrer" title="Click to view full image">
                        <img
                          src={t.sticker_photo_url}
                          alt="Physical Sticker Proof"
                          className="max-h-48 rounded-lg border border-slate-300 shadow-sm mx-auto object-cover"
                        />
                      </a>
                      <p className="text-[10px] text-emerald-700 font-semibold mt-1">
                        ✓ Sticker verified in physical godown/site
                      </p>
                    </div>
                  ) : (
                    <div className="h-36 rounded-lg border-2 border-dashed border-slate-300 bg-white flex flex-col items-center justify-center text-slate-400 text-xs text-center p-3">
                      <FiImage size={24} className="mb-1 text-slate-300" />
                      <span>No sticker photo uploaded yet</span>
                      <span className="text-[10px] text-amber-600 mt-1">Ajmer Sir will paste sticker & upload photo</span>
                    </div>
                  )}
                </div>
                {t.sticker_notes && (
                  <div className="text-[11px] text-slate-600 bg-white p-2 rounded border mt-2">
                    <strong>Pasting Note:</strong> {t.sticker_notes}
                  </div>
                )}
              </div>
            </div>

            {/* Movement Timeline */}
            {t.movements && t.movements.length > 0 && (
              <div className="p-4 border-t border-slate-200">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-1">
                  <FiClock /> Movement & Gate Pass History
                </h3>
                <div className="space-y-2 text-xs">
                  {t.movements.map((m, i) => (
                    <div key={m.id || i} className="flex items-start gap-2 p-2 bg-slate-50 rounded-lg border border-slate-200">
                      <span className="font-bold text-blue-700 uppercase shrink-0">{m.action}</span>
                      <div className="flex-1">
                        <div>
                          {m.from_site_name && <span>From: {m.from_site_name} </span>}
                          {m.to_site_name && <span>&rarr; To: <strong>{m.to_site_name}</strong></span>}
                          {m.to_user_name && <span> (Issued to: {m.to_user_name})</span>}
                        </div>
                        {m.notes && <div className="text-[11px] text-slate-500">{m.notes}</div>}
                      </div>
                      <div className="text-[10px] text-slate-400 shrink-0">
                        {fmtDateTime(m.created_at)}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer */}
        <div className="flex justify-between items-center pt-3 border-t">
          <div className="text-xs text-slate-500">
            {t ? `Inspected ${t.tool_code}` : 'Enter barcode or tool code to inspect'}
          </div>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}

