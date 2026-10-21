import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { 
  FiPrinter, FiCheck, FiX, FiExternalLink, FiClock, FiAlertTriangle, 
  FiTrendingUp, FiTrendingDown, FiShoppingBag, FiGlobe, FiRefreshCw,
  FiFileText, FiTag, FiDollarSign
} from 'react-icons/fi';

const inr = (n) => `₹${Math.round(+n || 0).toLocaleString('en-IN')}`;

export default function PoComparisonSheetModal({ isOpen, onClose, poId, onPoAction }) {
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [actionLoading, setActionLoading] = useState(false);

  const loadData = async () => {
    if (!poId) return;
    setLoading(true);
    try {
      const res = await api.get(`/procurement/vendor-po/${poId}/comparison-sheet`, { timeout: 120000 });
      setData(res.data);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load PO comparison sheet');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen && poId) {
      loadData();
    } else {
      setData(null);
    }
  }, [isOpen, poId]);

  const handleApprove = async () => {
    if (!data?.po?.id || actionLoading) return;
    setActionLoading(true);
    try {
      const res = await api.post(`/procurement/vendor-po/${data.po.id}/po-approve`);
      if (res.data?.auto_approved) {
        toast.success(`⚡ PO Auto-Approved: ${res.data.approval_note || 'All items within estimated cost'}`);
      } else if (res.data?.po_approval === 'pending_l2') {
        toast.success('PO L1 Approved → Forwarded to L2 (MD Sir) for final approval');
      } else {
        toast.success('PO Approved successfully');
      }
      loadData();
      if (onPoAction) onPoAction();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Approval failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handleReject = async () => {
    if (!data?.po?.id || actionLoading) return;
    const reason = prompt(`Reject Vendor PO "${data.po.po_number}"?\n\nEnter reason for rejection (required, min 3 characters):`);
    if (reason === null) return;
    if (!reason.trim() || reason.trim().length < 3) {
      return toast.error('A rejection reason is required');
    }
    setActionLoading(true);
    try {
      await api.post(`/procurement/vendor-po/${data.po.id}/po-reject`, { reason: reason.trim() });
      toast.success('PO Rejected');
      loadData();
      if (onPoAction) onPoAction();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Rejection failed');
    } finally {
      setActionLoading(false);
    }
  };

  const handlePrint = () => {
    window.print();
  };

  if (!isOpen) return null;

  const po = data?.po;
  const items = data?.items || [];
  const summary = data?.summary || {};
  const approval = data?.approval || {};

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={po ? `Comparative Statement · ${po.po_number}` : 'PO Comparison Sheet'}
      className="max-w-[1360px] w-full"
    >
      {/* Print stylesheet */}
      <style dangerouslySetInnerHTML={{ __html: `
        @media print {
          body * { visibility: hidden !important; }
          #po-cst-printable, #po-cst-printable * { visibility: visible !important; }
          #po-cst-printable {
            position: absolute !important;
            left: 0 !important;
            top: 0 !important;
            width: 100% !important;
            padding: 15px !important;
            background: white !important;
            color: black !important;
          }
          .no-print { display: none !important; }
          .print-break { page-break-before: always; }
        }
      `}} />

      {loading ? (
        <div className="py-20 text-center text-gray-500">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-red-600 mb-3" />
          <p className="text-sm font-medium">Aggregating PO, vendor quotes, and live online market benchmark data...</p>
        </div>
      ) : !data ? (
        <div className="py-16 text-center text-gray-400">
          <FiAlertTriangle size={36} className="mx-auto mb-2 opacity-40 text-amber-500" />
          <p className="font-semibold text-gray-700">Could not load comparison data</p>
          <button onClick={loadData} className="mt-3 btn btn-secondary text-xs inline-flex items-center gap-1">
            <FiRefreshCw size={12} /> Retry
          </button>
        </div>
      ) : (
        <div id="po-cst-printable" className="space-y-4">
          {/* Document Header for Print / Official Records */}
          <div className="border-b pb-3 flex flex-wrap justify-between items-start gap-4">
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200">
                  PO Comparative Statement (CST)
                </span>
                <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border ${
                  po.po_approval === 'approved' ? 'bg-emerald-100 text-emerald-800 border-emerald-300' :
                  po.po_approval === 'rejected' ? 'bg-red-100 text-red-800 border-red-300' :
                  'bg-amber-100 text-amber-800 border-amber-300'
                }`}>
                  {po.po_approval === 'approved' ? '✓ Approved' :
                   po.po_approval === 'rejected' ? '✕ Rejected' :
                   `Pending Approval (${po.po_approval === 'pending_l1' ? 'L1' : 'L2'})`}
                </span>
                {+po.po_auto_approved === 1 && (
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200">
                    ⚡ Auto-Approved
                  </span>
                )}
              </div>
              <h2 className="text-xl font-bold text-gray-900 mt-1">{po.po_number}</h2>
              <p className="text-xs text-gray-500">
                Created: <span className="font-medium text-gray-700">{po.po_date || po.created_at?.slice(0, 10)}</span>
                {po.created_by_name && <> by <span className="font-medium text-gray-700">{po.created_by_name}</span></>}
                {po.site_name && <> · Site: <span className="font-medium text-gray-800 font-semibold">{po.site_name}</span></>}
                {po.indent_number && <> · Indent: <span className="font-mono text-red-700 font-semibold">{po.indent_number}</span></>}
              </p>
            </div>

            <div className="text-right">
              <div className="text-xs text-gray-500 uppercase font-semibold">Vendor (Selected for PO)</div>
              <div className="text-base font-bold text-gray-900">{po.vendor_name || '—'}</div>
              {po.vendor_firm_name && <div className="text-xs text-gray-600">{po.vendor_firm_name}</div>}
              <div className="text-[11px] text-gray-500 mt-0.5">
                {po.payment_terms && <span className="mr-2">Terms: <b>{po.payment_terms}{po.credit_days ? ` (${po.credit_days}d)` : ''}</b></span>}
                {po.freight_terms && <span>Freight: <b>{po.freight_terms}</b></span>}
              </div>
            </div>
          </div>

          {/* Executive KPI Scorecard */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div className="p-3 rounded-lg border bg-blue-50/50 border-blue-200">
              <div className="text-[10px] font-bold uppercase tracking-wider text-blue-800 flex items-center justify-between">
                <span>Proposed PO Amount</span>
                <FiDollarSign size={13} />
              </div>
              <div className="text-lg font-bold text-blue-900 mt-1">{inr(summary.total_actual_amount)}</div>
              <div className="text-[10px] text-blue-700 mt-0.5">{summary.total_items} line item{summary.total_items > 1 ? 's' : ''}</div>
            </div>

            <div className="p-3 rounded-lg border bg-purple-50/50 border-purple-200">
              <div className="text-[10px] font-bold uppercase tracking-wider text-purple-800 flex items-center justify-between">
                <span>Online Market Benchmark</span>
                <FiGlobe size={13} />
              </div>
              <div className="text-lg font-bold text-purple-900 mt-1">
                {summary.total_online_amount > 0 ? inr(summary.total_online_amount) : '—'}
              </div>
              <div className="text-[10px] text-purple-700 mt-0.5">
                {summary.online_items_count > 0 ? (
                  summary.savings_vs_online >= 0 ? (
                    <span className="font-semibold text-emerald-700">✓ {inr(summary.savings_vs_online)} ({summary.savings_vs_online_pct}%) below online</span>
                  ) : (
                    <span className="font-semibold text-red-600">⚠ {inr(Math.abs(summary.savings_vs_online))} ({Math.abs(summary.savings_vs_online_pct)}%) above online</span>
                  )
                ) : (
                  'Live links available'
                )}
              </div>
            </div>

            <div className="p-3 rounded-lg border bg-amber-50/50 border-amber-200">
              <div className="text-[10px] font-bold uppercase tracking-wider text-amber-800 flex items-center justify-between">
                <span>BOQ Planned Target (PP)</span>
                <FiShoppingBag size={13} />
              </div>
              <div className="text-lg font-bold text-amber-900 mt-1">
                {summary.total_estimated_amount > 0 ? inr(summary.total_estimated_amount) : '—'}
              </div>
              <div className="text-[10px] text-amber-700 mt-0.5">
                {summary.estimated_items_count > 0 ? (
                  summary.savings_vs_estimated >= 0 ? (
                    <span className="font-semibold text-emerald-700">✓ {inr(summary.savings_vs_estimated)} ({summary.savings_vs_estimated_pct}%) within budget</span>
                  ) : (
                    <span className="font-semibold text-red-600">⚠ {inr(Math.abs(summary.savings_vs_estimated))} ({Math.abs(summary.savings_vs_estimated_pct)}%) overrun</span>
                  )
                ) : (
                  'No BOQ purchase price'
                )}
              </div>
            </div>

            <div className={`p-3 rounded-lg border ${
              summary.cost_status === 'cost_overrun' ? 'bg-rose-50 border-rose-300' :
              summary.cost_status === 'within_estimate' ? 'bg-emerald-50 border-emerald-300' :
              'bg-gray-50 border-gray-200'
            }`}>
              <div className="text-[10px] font-bold uppercase tracking-wider flex items-center justify-between">
                <span className={summary.cost_status === 'cost_overrun' ? 'text-rose-800' : 'text-emerald-800'}>
                  Evaluation Verdict
                </span>
                {summary.cost_status === 'cost_overrun' ? <FiAlertTriangle size={13} className="text-rose-600" /> : <FiCheck size={13} className="text-emerald-600" />}
              </div>
              <div className={`text-sm font-bold mt-1 ${
                summary.cost_status === 'cost_overrun' ? 'text-rose-900' : 'text-emerald-900'
              }`}>
                {summary.cost_status === 'cost_overrun' ? 'Cost Overrun (Needs MD Approval)' : 'Within Estimated Benchmark'}
              </div>
              <div className="text-[10px] text-gray-600 mt-0.5 truncate" title={summary.reason || ''}>
                {summary.reason || 'All items priced within safe bounds'}
              </div>
            </div>
          </div>

          {/* Comparative Table */}
          <div className="overflow-x-auto border border-gray-200 rounded-lg">
            <table className="min-w-full text-xs text-left divide-y divide-gray-200">
              <thead className="bg-gray-100 text-gray-700 font-bold text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-2.5 py-2.5" rowSpan="2">#</th>
                  <th className="px-3 py-2.5" rowSpan="2" style={{ minWidth: '220px' }}>Item & Specifications</th>
                  <th className="px-2.5 py-2.5 text-center" rowSpan="2">Qty</th>
                  <th className="px-3 py-2.5 text-right bg-blue-50/70 border-x border-blue-200" rowSpan="2">
                    Proposed PO Rate<br />
                    <span className="text-[9px] font-normal text-blue-700 normal-case">Selected: {po.vendor_name}</span>
                  </th>
                  <th className="px-3 py-1.5 text-center bg-gray-50 border-r border-gray-200" colSpan="3">
                    Indent Quotes (Offline 3 Quotes)
                  </th>
                  <th className="px-3 py-1.5 text-center bg-purple-50/60 border-r border-purple-200" colSpan="2">
                    Online Market Benchmark
                  </th>
                  <th className="px-2.5 py-2.5 text-right" rowSpan="2">Last PO Rate<br /><span className="text-[9px] font-normal text-gray-500 normal-case">(SEPL History)</span></th>
                  <th className="px-2.5 py-2.5 text-right" rowSpan="2">BOQ PP<br /><span className="text-[9px] font-normal text-gray-500 normal-case">(Budget)</span></th>
                  <th className="px-2.5 py-2.5 text-center" rowSpan="2">Variance</th>
                </tr>
                <tr className="text-[10px]">
                  <th className="px-2 py-1 bg-gray-50 border-r border-gray-200">Vendor 1</th>
                  <th className="px-2 py-1 bg-gray-50 border-r border-gray-200">Vendor 2</th>
                  <th className="px-2 py-1 bg-gray-50 border-r border-gray-200">Vendor 3</th>
                  <th className="px-2 py-1 bg-purple-50/60">Best Online</th>
                  <th className="px-2 py-1 bg-purple-50/60 border-r border-purple-200">Live Links</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {items.map((it, idx) => {
                  const isLowestQuote = it.quotes?.min_quote_rate && it.actual_rate <= it.quotes.min_quote_rate;
                  const onlineLowest = it.online?.lowest_price;

                  return (
                    <tr key={it.id || idx} className="hover:bg-gray-50/80 transition-colors">
                      <td className="px-2.5 py-2.5 text-gray-400 font-mono text-[10px] align-top">{idx + 1}</td>
                      
                      {/* Description & Specs */}
                      <td className="px-3 py-2.5 align-top">
                        <div className="font-semibold text-gray-900 text-xs">{it.description}</div>
                        {it.specification && <div className="text-[11px] text-gray-500 leading-snug">{it.specification}</div>}
                        <div className="flex flex-wrap gap-1.5 mt-1 text-[10px] text-gray-500">
                          {it.size && <span className="bg-gray-100 px-1.5 py-0.2 rounded font-mono">Size: {it.size}</span>}
                          {it.make && <span className="bg-gray-100 px-1.5 py-0.2 rounded">Make: {it.make}</span>}
                          {it.item_code && <span className="font-mono text-gray-400">[{it.item_code}]</span>}
                        </div>
                      </td>

                      {/* Qty & UoM */}
                      <td className="px-2.5 py-2.5 text-center font-semibold text-gray-800 whitespace-nowrap align-top">
                        {it.quantity} <span className="text-[10px] font-normal text-gray-500">{it.unit}</span>
                      </td>

                      {/* Proposed PO Rate & Amount */}
                      <td className="px-3 py-2.5 text-right font-bold text-blue-900 bg-blue-50/40 border-x border-blue-100 whitespace-nowrap align-top">
                        <div className="text-xs">{inr(it.actual_rate)}</div>
                        <div className="text-[10px] font-normal text-gray-500">{inr(it.actual_amount)}</div>
                        {isLowestQuote && (
                          <span className="inline-block mt-0.5 text-[9px] font-bold text-emerald-700 bg-emerald-50 px-1 rounded border border-emerald-200">
                            ★ Lowest Quote
                          </span>
                        )}
                      </td>

                      {/* Indent Quote 1 */}
                      <td className="px-2 py-2.5 text-xs border-r border-gray-100 align-top">
                        {it.quotes?.vendor1_rate > 0 ? (
                          <div>
                            <div className="font-semibold text-gray-800">{inr(it.quotes.vendor1_rate)}</div>
                            <div className="text-[10px] text-gray-500 truncate max-w-[90px]" title={it.quotes.vendor1_name}>{it.quotes.vendor1_name}</div>
                          </div>
                        ) : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Indent Quote 2 */}
                      <td className="px-2 py-2.5 text-xs border-r border-gray-100 align-top">
                        {it.quotes?.vendor2_rate > 0 ? (
                          <div>
                            <div className="font-semibold text-gray-800">{inr(it.quotes.vendor2_rate)}</div>
                            <div className="text-[10px] text-gray-500 truncate max-w-[90px]" title={it.quotes.vendor2_name}>{it.quotes.vendor2_name}</div>
                          </div>
                        ) : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Indent Quote 3 */}
                      <td className="px-2 py-2.5 text-xs border-r border-gray-200 align-top">
                        {it.quotes?.vendor3_rate > 0 ? (
                          <div>
                            <div className="font-semibold text-gray-800">{inr(it.quotes.vendor3_rate)}</div>
                            <div className="text-[10px] text-gray-500 truncate max-w-[90px]" title={it.quotes.vendor3_name}>{it.quotes.vendor3_name}</div>
                          </div>
                        ) : <span className="text-gray-300">—</span>}
                      </td>

                      {/* Online Market Best Rate */}
                      <td className="px-2.5 py-2.5 bg-purple-50/30 text-xs align-top">
                        {onlineLowest > 0 ? (
                          <div>
                            <div className="font-bold text-purple-900">{inr(onlineLowest)}</div>
                            {it.online.average_price && (
                              <div className="text-[9px] text-gray-400">avg {inr(it.online.average_price)}</div>
                            )}
                            {it.online.variance_pct_vs_online != null && (
                              <span className={`inline-block mt-0.5 text-[9px] font-semibold px-1 rounded ${
                                it.online.variance_pct_vs_online <= 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                              }`}>
                                {it.online.variance_pct_vs_online <= 0 ? `${Math.abs(it.online.variance_pct_vs_online)}% cheaper` : `+${it.online.variance_pct_vs_online}% over online`}
                              </span>
                            )}
                          </div>
                        ) : (
                          <span className="text-gray-400 text-[10px] italic">Search online ➔</span>
                        )}
                      </td>

                      {/* Online Search Links */}
                      <td className="px-2 py-2.5 bg-purple-50/30 border-r border-purple-100 align-top whitespace-nowrap">
                        <div className="flex flex-col gap-1 text-[10px]">
                          {it.online?.direct_links?.moglix && (
                            <a
                              href={it.online.direct_links.moglix}
                              target="_blank"
                              rel="noreferrer"
                              className="text-red-700 hover:text-red-900 inline-flex items-center gap-1 font-medium hover:underline"
                            >
                              <FiExternalLink size={10} /> Moglix
                            </a>
                          )}
                          {it.online?.direct_links?.indiamart && (
                            <a
                              href={it.online.direct_links.indiamart}
                              target="_blank"
                              rel="noreferrer"
                              className="text-emerald-700 hover:text-emerald-900 inline-flex items-center gap-1 font-medium hover:underline"
                            >
                              <FiExternalLink size={10} /> IndiaMART
                            </a>
                          )}
                          {it.online?.direct_links?.amazon && (
                            <a
                              href={it.online.direct_links.amazon}
                              target="_blank"
                              rel="noreferrer"
                              className="text-amber-700 hover:text-amber-900 inline-flex items-center gap-1 font-medium hover:underline"
                            >
                              <FiExternalLink size={10} /> Amazon
                            </a>
                          )}
                        </div>
                      </td>

                      {/* Last ERP PO History */}
                      <td className="px-2.5 py-2.5 text-right text-xs align-top whitespace-nowrap">
                        {it.history && it.history.length > 0 ? (
                          <div>
                            <div className="font-semibold text-gray-800">{inr(it.history[0].rate)}</div>
                            <div className="text-[10px] text-gray-400 font-mono" title={`Vendor: ${it.history[0].vendor_name || '—'}`}>
                              {it.history[0].po_number}
                            </div>
                            <div className="text-[9px] text-gray-400">{it.history[0].po_date || it.history[0].created_at?.slice(0, 10)}</div>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>

                      {/* BOQ Planned PP Rate */}
                      <td className="px-2.5 py-2.5 text-right text-xs align-top whitespace-nowrap font-medium text-gray-700">
                        {it.estimated_rate > 0 ? (
                          <div>
                            <div>{inr(it.estimated_rate)}</div>
                            <div className="text-[9px] text-gray-400">{it.benchmark_source}</div>
                          </div>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>

                      {/* Variance Status Tag */}
                      <td className="px-2.5 py-2.5 text-center align-top whitespace-nowrap">
                        {it.estimated_rate > 0 ? (
                          it.is_overrun ? (
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-rose-100 text-rose-700 border border-rose-200">
                              +{it.variance_pct}% Over
                            </span>
                          ) : (
                            <span className="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-700 border border-emerald-200">
                              {it.variance_pct <= 0 ? `${Math.abs(it.variance_pct)}% Under` : 'OK'}
                            </span>
                          )
                        ) : (
                          <span className="text-[10px] text-gray-400">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Signatures & Approval Footer (Formal CST Layout for Print) */}
          <div className="hidden print:grid grid-cols-3 gap-6 pt-8 mt-6 border-t border-gray-300 text-xs">
            <div className="border-t border-gray-400 pt-2 text-center">
              <div className="font-bold">Prepared By</div>
              <div className="text-gray-500">Purchase Executive</div>
            </div>
            <div className="border-t border-gray-400 pt-2 text-center">
              <div className="font-bold">Checked By (L1)</div>
              <div className="text-gray-500">Purchase Head / L1 Approver</div>
            </div>
            <div className="border-t border-gray-400 pt-2 text-center">
              <div className="font-bold">Approved By (L2)</div>
              <div className="text-gray-500">Managing Director / L2 Approver</div>
            </div>
          </div>

          {/* Interactive Action Bar (Screen Only) */}
          <div className="no-print pt-3 border-t flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handlePrint}
                className="btn btn-secondary text-xs flex items-center gap-1.5"
                title="Print official Comparative Statement"
              >
                <FiPrinter size={13} /> Print Comparative Statement
              </button>
              <button
                type="button"
                onClick={loadData}
                disabled={loading}
                className="btn btn-secondary text-xs flex items-center gap-1.5"
                title="Refresh latest online rates and benchmark data"
              >
                <FiRefreshCw size={13} className={loading ? 'animate-spin' : ''} /> Refresh Data
              </button>
            </div>

            <div className="flex items-center gap-2">
              {approval.is_approved ? (
                <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-emerald-100 text-emerald-800 border border-emerald-300">
                  <FiCheck size={14} /> Approved & Active
                </span>
              ) : approval.is_rejected ? (
                <span className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-bold bg-red-100 text-red-800 border border-red-300">
                  <FiX size={14} /> Rejected
                </span>
              ) : approval.can_approve ? (
                <>
                  <button
                    type="button"
                    onClick={handleReject}
                    disabled={actionLoading}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-red-700 bg-red-50 hover:bg-red-100 border border-red-200 transition"
                  >
                    ✕ Reject PO
                  </button>
                  <button
                    type="button"
                    onClick={handleApprove}
                    disabled={actionLoading}
                    className="btn btn-success text-xs font-bold flex items-center gap-1.5 shadow"
                  >
                    <FiCheck size={14} /> Approve PO ({approval.pending_level === 1 ? 'L1' : 'L2 · MD'})
                  </button>
                </>
              ) : (
                <span className="text-xs text-amber-700 font-medium px-2 py-1 bg-amber-50 rounded border border-amber-200">
                  {approval.pending_approvers?.length
                    ? `Awaiting approval from: ${approval.pending_approvers.join(', ')}`
                    : 'Awaiting PO approval'}
                </span>
              )}
              <button type="button" onClick={onClose} className="btn btn-secondary text-xs">
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
