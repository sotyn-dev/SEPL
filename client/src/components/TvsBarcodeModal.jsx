import { useState, useRef } from 'react';
import { FiPrinter, FiX, FiCheckCircle, FiTag } from 'react-icons/fi';
import Modal from './Modal';
import { generateCode128Svg } from '../utils/barcode128';
import api from '../api';
import toast from 'react-hot-toast';

export default function TvsBarcodeModal({ isOpen, onClose, tools = [], onPrinted }) {
  const [labelSize, setLabelSize] = useState('50x25'); // '50x25' or '50x38'
  const [printing, setPrinting] = useState(false);
  const printAreaRef = useRef(null);

  if (!isOpen || !tools.length) return null;

  const handlePrint = async () => {
    setPrinting(true);
    try {
      // 1. Mark tools as printed by Nancy in backend
      const toolIds = tools.map(t => t.id);
      await api.post('/tools/stickers/batch-print', { tool_ids: toolIds });
      toast.success(`Printed ${tools.length} barcode sticker(s). Handed over to Ajmer for physical pasting.`);

      // 2. Trigger browser print dialog for TVS thermal label printer
      setTimeout(() => {
        window.print();
        if (onPrinted) onPrinted();
        onClose();
      }, 250);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update sticker print status');
    } finally {
      setPrinting(false);
    }
  };

  const isSmall = labelSize === '50x25';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`TVS Barcode Sticker Printing (${tools.length} Tool${tools.length === 1 ? '' : 's'})`}
      wide
    >
      <div className="space-y-4">
        {/* Controls & TVS Instructions */}
        <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-900">
          <div>
            <span className="font-bold flex items-center gap-1.5 text-sm text-amber-950 mb-0.5">
              <FiTag size={15} /> TVS Barcode Sticker Roll Workflow
            </span>
            <p>
              Nancy prints stickers on office TVS machine &rarr; Ajmer collects stickers &rarr; Pastes on physical machines/godown tools &rarr; Uploads photo proof.
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <label className="font-semibold text-amber-950">Roll Size:</label>
            <select
              value={labelSize}
              onChange={e => setLabelSize(e.target.value)}
              className="select text-xs py-1 px-2.5 bg-white border-amber-300 rounded-lg font-medium"
            >
              <option value="50x25">50mm × 25mm (Standard 2"×1")</option>
              <option value="50x38">50mm × 38mm (Large 2"×1.5")</option>
            </select>
          </div>
        </div>

        {/* Screen Preview Container */}
        <div className="border border-slate-200 rounded-xl bg-slate-100 p-4 max-h-[55vh] overflow-y-auto">
          <p className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">
            TVS Thermal Label Preview ({labelSize === '50x25' ? '50mm × 25mm' : '50mm × 38mm'}):
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            {tools.map((t, idx) => {
              const code = t.barcode || t.tool_code;
              const barcodeSvg = generateCode128Svg(code, {
                height: isSmall ? 26 : 34,
                barWidth: isSmall ? 1.2 : 1.4,
                showText: false
              });

              return (
                <div
                  key={t.id || idx}
                  className="bg-white border-2 border-slate-800 rounded shadow-md text-black flex flex-col justify-between overflow-hidden relative select-none"
                  style={{
                    width: isSmall ? '240px' : '260px',
                    height: isSmall ? '135px' : '175px',
                    padding: '6px 8px',
                    boxSizing: 'border-box'
                  }}
                >
                  {/* Top Company Header */}
                  <div className="flex justify-between items-start border-b border-black pb-1">
                    <div>
                      <div className="text-[9px] font-extrabold tracking-tight leading-none uppercase">
                        SECURED ENGINEERS PVT LTD
                      </div>
                      <div className="text-[8px] font-semibold text-slate-700 leading-tight">
                        RGP TOOL / ASSET
                      </div>
                    </div>
                    <div className="text-[9px] font-mono font-black text-right leading-none">
                      {t.tool_code}
                    </div>
                  </div>

                  {/* Middle: Barcode */}
                  <div className="my-auto text-center py-0.5">
                    <div
                      className="inline-block max-w-full"
                      dangerouslySetInnerHTML={{ __html: barcodeSvg }}
                    />
                    <div className="font-mono text-[10px] font-bold tracking-widest leading-none mt-0.5">
                      {code}
                    </div>
                  </div>

                  {/* Bottom: Tool details */}
                  <div className="border-t border-black pt-1 leading-tight text-[8px]">
                    <div className="font-bold truncate" title={t.name}>
                      {t.name}
                    </div>
                    <div className="flex justify-between items-center text-[7.5px] text-slate-800">
                      <span><strong>Make:</strong> {t.brand || t.make || 'SEPL'}</span>
                      <span><strong>Purchased:</strong> {t.purchase_date || 'N/A'}</span>
                    </div>
                    {t.serial_no && (
                      <div className="text-[7px] text-slate-600 truncate">
                        SN: {t.serial_no}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Modal Actions */}
        <div className="flex flex-col sm:flex-row items-center justify-between gap-3 pt-3 border-t">
          <div className="text-xs text-slate-500">
            Ready to print on TVS continuous thermal sticker roll.
          </div>
          <div className="flex items-center gap-2 w-full sm:w-auto">
            <button
              type="button"
              onClick={onClose}
              disabled={printing}
              className="btn btn-secondary flex-1 sm:flex-initial"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handlePrint}
              disabled={printing}
              className="btn btn-primary flex items-center justify-center gap-2 flex-1 sm:flex-initial bg-blue-700 hover:bg-blue-800 text-white font-semibold"
            >
              <FiPrinter size={15} />
              {printing ? 'Preparing…' : `Print ${tools.length} Sticker${tools.length === 1 ? '' : 's'} on TVS`}
            </button>
          </div>
        </div>
      </div>

      {/* Hidden TVS Print Container (Executed only on window.print()) */}
      <div id="tvs-print-container" ref={printAreaRef} className="hidden">
        {tools.map((t, idx) => {
          const code = t.barcode || t.tool_code;
          const barcodeSvg = generateCode128Svg(code, {
            height: isSmall ? 28 : 38,
            barWidth: isSmall ? 1.3 : 1.5,
            showText: false
          });

          return (
            <div
              key={`print-${t.id || idx}`}
              className="tvs-single-label"
              style={{
                width: isSmall ? '50mm' : '50mm',
                height: isSmall ? '25mm' : '38mm',
                pageBreakAfter: 'always',
                breakAfter: 'page',
                padding: '1.5mm 2mm',
                boxSizing: 'border-box',
                fontFamily: 'Arial, sans-serif',
                color: '#000',
                background: '#fff',
                display: 'flex',
                flexDirection: 'column',
                justifyContent: 'space-between',
                overflow: 'hidden'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', borderBottom: '1px solid #000', paddingBottom: '1px' }}>
                <div style={{ fontSize: '7pt', fontWeight: '900', lineHeight: 1 }}>SECURED ENGINEERS (SEPL)</div>
                <div style={{ fontSize: '7pt', fontWeight: '900', fontFamily: 'monospace', lineHeight: 1 }}>{t.tool_code}</div>
              </div>

              <div style={{ textAlign: 'center', margin: 'auto 0' }}>
                <div dangerouslySetInnerHTML={{ __html: barcodeSvg }} />
                <div style={{ fontFamily: 'monospace', fontSize: '8pt', fontWeight: 'bold', letterSpacing: '1px', lineHeight: 1 }}>
                  {code}
                </div>
              </div>

              <div style={{ borderTop: '1px solid #000', paddingTop: '1px', fontSize: '6.5pt', lineHeight: 1.1 }}>
                <div style={{ fontWeight: 'bold', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {t.name}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Make: {t.brand || t.make || 'SEPL'}</span>
                  <span>Date: {t.purchase_date || 'N/A'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Embedded CSS for Exact TVS Printer Dimensions */}
      <style>{`
        @media print {
          body * {
            visibility: hidden !important;
          }
          #tvs-print-container, #tvs-print-container * {
            visibility: visible !important;
          }
          #tvs-print-container {
            display: block !important;
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            margin: 0 !important;
            padding: 0 !important;
          }
          @page {
            size: ${isSmall ? '50mm 25mm' : '50mm 38mm'};
            margin: 0mm;
          }
          .tvs-single-label {
            page-break-after: always !important;
            break-after: page !important;
          }
        }
      `}</style>
    </Modal>
  );
}

