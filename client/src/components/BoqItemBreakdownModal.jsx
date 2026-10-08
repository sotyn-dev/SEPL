import React, { useState, useEffect } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';
import { FiCpu, FiCheckCircle, FiInfo, FiTrash2, FiPlus, FiRefreshCw, FiArrowRight, FiCheck } from 'react-icons/fi';

const TYPE_BADGES = {
  primary: { label: 'Primary Material', bg: 'bg-indigo-50', text: 'text-indigo-700', border: 'border-indigo-200' },
  accessory: { label: 'Fitting / Accessory', bg: 'bg-amber-50', text: 'text-amber-700', border: 'border-amber-200' },
  consumable: { label: 'Consumable', bg: 'bg-emerald-50', text: 'text-emerald-700', border: 'border-emerald-200' },
  labour: { label: 'Labour / Service', bg: 'bg-purple-50', text: 'text-purple-700', border: 'border-purple-200' }
};

const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function BoqItemBreakdownModal({ isOpen, onClose, boqLine, onApprove }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [items, setItems] = useState([]);
  const [summary, setSummary] = useState(null);

  // Trigger decomposition when opened with a BOQ line
  useEffect(() => {
    if (isOpen && boqLine && boqLine.description) {
      loadBreakdown();
    } else {
      setItems([]);
      setSummary(null);
      setError('');
    }
  }, [isOpen, boqLine?.description, boqLine?.quantity, boqLine?.unit]);

  const loadBreakdown = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await api.post('/quotations/boq-item-breakdown', {
        description: boqLine.description,
        quantity: boqLine.quantity || 1,
        unit: boqLine.unit || 'Nos',
        trade: boqLine.trade || boqLine.category || '',
        client_spec: boqLine.client_spec || ''
      });

      if (res.data?.items) {
        setItems(res.data.items.map(it => ({
          ...it,
          active_rate: it.selected_rate ?? (it.sepl_rate || it.perplexity_rate || 0),
          active_source: it.selected_rate_type || (it.sepl_rate ? 'sepl' : 'perplexity')
        })));
        setSummary(res.data.summary);
      } else {
        setError('No items could be decomposed from this BOQ line.');
      }
    } catch (err) {
      console.error('[BoqItemBreakdownModal]', err);
      setError(err.response?.data?.error || err.message || 'Failed to decompose BOQ line');
    } finally {
      setLoading(false);
    }
  };

  // Recalculate line amount & summary totals whenever items change
  const updateItem = (index, patch) => {
    setItems(prev => {
      const updated = prev.map((it, idx) => {
        if (idx !== index) return it;
        const next = { ...it, ...patch };
        const qty = Math.max(0, Number(next.total_qty) || 0);
        const rate = Math.max(0, Number(next.active_rate) || 0);
        next.amount = Math.round(qty * rate * 100) / 100;
        return next;
      });
      recalcSummary(updated);
      return updated;
    });
  };

  const recalcSummary = (itemList) => {
    const totalSepl = itemList.reduce((acc, it) => acc + ((Number(it.total_qty) || 0) * (Number(it.sepl_rate) || 0)), 0);
    const totalMkt = itemList.reduce((acc, it) => acc + ((Number(it.total_qty) || 0) * (Number(it.perplexity_rate) || 0)), 0);
    const totalActive = itemList.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    setSummary(prev => ({
      ...(prev || {}),
      total_items: itemList.length,
      total_sepl_cost: Math.round(totalSepl * 100) / 100,
      total_market_cost: Math.round(totalMkt * 100) / 100,
      total_active_cost: Math.round(totalActive * 100) / 100,
      variance: Math.round((totalSepl - totalMkt) * 100) / 100,
      variance_pct: totalMkt > 0 ? Math.round(((totalSepl - totalMkt) / totalMkt) * 1000) / 10 : 0
    }));
  };

  const handleUseRate = (index, rate, source) => {
    updateItem(index, {
      active_rate: Number(rate) || 0,
      active_source: source
    });
  };

  const handleDeleteRow = (index) => {
    setItems(prev => {
      const filtered = prev.filter((_, idx) => idx !== index);
      recalcSummary(filtered);
      return filtered;
    });
  };

  const handleAddRow = () => {
    const newItem = {
      index: items.length,
      item_name: 'New Custom Item',
      type: 'accessory',
      total_qty: 1,
      uom: 'Nos',
      sepl_matched: false,
      sepl_rate: 0,
      perplexity_rate: 0,
      active_rate: 0,
      active_source: 'custom',
      amount: 0
    };
    const nextList = [...items, newItem];
    setItems(nextList);
    recalcSummary(nextList);
  };

  const handleApprove = () => {
    if (!items.length) {
      toast.error('No items to approve');
      return;
    }
    if (onApprove) {
      onApprove(items, summary);
      toast.success(`Approved ${items.length} item-wise breakdown lines!`);
      onClose();
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="AI BOQ to Item-wise Breakdown (Draft Preview)" xwide>
      <div className="space-y-4 text-xs sm:text-sm">
        {/* Source BOQ Header Banner */}
        <div className="bg-gradient-to-r from-red-50 to-orange-50 border border-red-200 rounded-xl p-3 sm:p-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <span className="px-2 py-0.5 rounded text-[11px] font-semibold bg-red-800 text-white uppercase tracking-wider">
                  Source BOQ Item
                </span>
                {boqLine?.trade && (
                  <span className="px-2 py-0.5 rounded text-[11px] font-medium bg-red-100 text-red-800">
                    {boqLine.trade}
                  </span>
                )}
              </div>
              <h4 className="font-semibold text-gray-900 text-sm sm:text-base leading-snug">
                {boqLine?.description || '(No description)'}
              </h4>
            </div>
            <div className="text-right sm:min-w-[140px] bg-white/80 rounded-lg p-2 border border-red-100 shadow-xs">
              <span className="text-[11px] text-gray-500 block">Total BOQ Scope</span>
              <span className="font-bold text-gray-900 text-base">
                {boqLine?.quantity || 1} <span className="text-xs font-normal text-gray-600">{boqLine?.unit || 'Nos'}</span>
              </span>
            </div>
          </div>
        </div>

        {/* Informational Guidance Alert */}
        <div className="flex items-start gap-2 bg-blue-50/70 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-900">
          <FiInfo className="text-blue-600 shrink-0 mt-0.5" size={16} />
          <div>
            <span className="font-semibold">Dual Pricing Mode: </span>
            <span className="text-emerald-800 font-medium">🟢 SEPL Rate</span> is the primary rate from your Item Master/Past POs used for calculations.
            <span className="text-blue-800 font-medium ml-1">🔵 Perplexity Market Rate</span> is fetched for comparison. You can click any rate to swap or type your own.
            <span className="font-bold ml-1 text-red-700">Nothing is auto-saved</span> until you click "Approve & Save".
          </div>
        </div>

        {/* Loading State */}
        {loading && (
          <div className="py-12 flex flex-col items-center justify-center text-center space-y-3">
            <FiRefreshCw className="animate-spin text-red-600" size={32} />
            <div>
              <p className="font-semibold text-gray-800">Decomposing BOQ into Indian MEPF Standards...</p>
              <p className="text-xs text-gray-500">Matching SEPL Item Master and querying Perplexity live market rates</p>
            </div>
          </div>
        )}

        {/* Error State */}
        {!loading && error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 space-y-2">
            <p className="font-semibold">{error}</p>
            <button
              type="button"
              onClick={loadBreakdown}
              className="btn btn-sm btn-secondary flex items-center gap-1.5"
            >
              <FiRefreshCw size={13} /> Try Again
            </button>
          </div>
        )}

        {/* Breakdown Items Table (Draft Preview) */}
        {!loading && !error && items.length > 0 && (
          <div className="space-y-3">
            <div className="border border-gray-200 rounded-lg overflow-x-auto shadow-xs bg-white">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200 text-gray-600 font-semibold uppercase text-[11px] tracking-wider">
                    <th className="py-2.5 px-3 w-10 text-center">#</th>
                    <th className="py-2.5 px-3 w-28">Type</th>
                    <th className="py-2.5 px-3 min-w-[220px]">Item Description & Specs</th>
                    <th className="py-2.5 px-3 w-28 text-right">Qty & Unit</th>
                    <th className="py-2.5 px-3 w-36 text-right bg-emerald-50/50 text-emerald-900 border-l border-emerald-100">
                      🟢 SEPL Rate (₹)
                    </th>
                    <th className="py-2.5 px-3 w-36 text-right bg-blue-50/50 text-blue-900 border-l border-blue-100">
                      🔵 Perplexity Rate (₹)
                    </th>
                    <th className="py-2.5 px-3 w-32 text-right bg-gray-50 font-bold border-l border-gray-200">
                      Active Rate (₹)
                    </th>
                    <th className="py-2.5 px-3 w-32 text-right">Amount (₹)</th>
                    <th className="py-2.5 px-2 w-10 text-center"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {items.map((it, idx) => {
                    const badge = TYPE_BADGES[it.type] || TYPE_BADGES.accessory;
                    const isSeplActive = it.active_source === 'sepl';
                    const isMktActive = it.active_source === 'perplexity';

                    return (
                      <tr key={idx} className="hover:bg-gray-50/80 transition-colors">
                        <td className="py-2 px-3 text-center text-gray-400 font-mono text-[11px]">{idx + 1}</td>
                        <td className="py-2 px-3">
                          <span className={`px-2 py-0.5 rounded text-[10px] font-medium border ${badge.bg} ${badge.text} ${badge.border}`}>
                            {badge.label}
                          </span>
                        </td>
                        <td className="py-2 px-3">
                          <input
                            type="text"
                            value={it.item_name}
                            onChange={(e) => updateItem(idx, { item_name: e.target.value })}
                            className="w-full font-medium text-gray-900 bg-transparent border border-transparent hover:border-gray-300 focus:border-red-500 focus:bg-white rounded px-1.5 py-0.5 text-xs transition"
                          />
                          {it.sepl_matched && it.sepl_item_name && (
                            <div className="text-[10px] text-gray-500 truncate px-1 mt-0.5 flex items-center gap-1">
                              <span className="text-emerald-700">🔗 Matched SEPL:</span> {it.sepl_item_name}
                            </div>
                          )}
                        </td>
                        <td className="py-2 px-3 text-right">
                          <div className="flex items-center justify-end gap-1">
                            <input
                              type="number"
                              step="any"
                              value={it.total_qty}
                              onChange={(e) => updateItem(idx, { total_qty: e.target.value })}
                              className="w-16 text-right font-medium text-gray-900 border border-gray-200 rounded px-1.5 py-0.5 text-xs focus:border-red-500"
                            />
                            <span className="text-gray-500 text-[11px] w-8 text-left">{it.uom}</span>
                          </div>
                        </td>
                        {/* 🟢 SEPL Rate Column */}
                        <td className="py-2 px-3 text-right border-l border-emerald-100 bg-emerald-50/20">
                          {it.sepl_rate !== null && it.sepl_rate > 0 ? (
                            <div className="space-y-0.5">
                              <button
                                type="button"
                                onClick={() => handleUseRate(idx, it.sepl_rate, 'sepl')}
                                title="Click to use SEPL rate"
                                className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded transition ${
                                  isSeplActive
                                    ? 'bg-emerald-600 text-white shadow-xs'
                                    : 'text-emerald-800 hover:bg-emerald-100'
                                }`}
                              >
                                ₹ {fmt(it.sepl_rate)}
                              </button>
                              <span className="block text-[10px] text-emerald-600">
                                {it.sepl_rate_source === 'item_master' ? 'Item Master' : 'PO History'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-gray-400 italic">No Past Rate</span>
                          )}
                        </td>
                        {/* 🔵 Perplexity Rate Column */}
                        <td className="py-2 px-3 text-right border-l border-blue-100 bg-blue-50/20">
                          {it.perplexity_rate !== null && it.perplexity_rate > 0 ? (
                            <div className="space-y-0.5">
                              <button
                                type="button"
                                onClick={() => handleUseRate(idx, it.perplexity_rate, 'perplexity')}
                                title="Click to use Perplexity rate"
                                className={`font-mono text-xs font-semibold px-1.5 py-0.5 rounded transition ${
                                  isMktActive
                                    ? 'bg-blue-600 text-white shadow-xs'
                                    : 'text-blue-800 hover:bg-blue-100'
                                }`}
                              >
                                ₹ {fmt(it.perplexity_rate)}
                              </button>
                              <span className="block text-[10px] text-blue-600 truncate max-w-[120px] ml-auto">
                                {it.perplexity_source === 'perplexity_sonar' ? 'Perplexity' : 'Market Est.'}
                              </span>
                            </div>
                          ) : (
                            <span className="text-[11px] text-gray-400 italic">—</span>
                          )}
                        </td>
                        {/* Active Editable Rate */}
                        <td className="py-2 px-3 text-right border-l border-gray-200 bg-gray-50/40">
                          <input
                            type="number"
                            step="any"
                            value={it.active_rate}
                            onChange={(e) => updateItem(idx, { active_rate: e.target.value, active_source: 'custom' })}
                            className="w-24 text-right font-mono font-bold text-gray-900 border border-gray-300 rounded px-1.5 py-0.5 text-xs focus:border-red-500 focus:bg-white"
                          />
                        </td>
                        {/* Amount */}
                        <td className="py-2 px-3 text-right font-mono font-bold text-gray-900">
                          ₹ {fmt(it.amount)}
                        </td>
                        <td className="py-2 px-2 text-center">
                          <button
                            type="button"
                            onClick={() => handleDeleteRow(idx)}
                            className="text-gray-400 hover:text-red-600 p-1 rounded transition"
                            title="Remove row"
                          >
                            <FiTrash2 size={13} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Row Actions */}
            <div className="flex justify-between items-center pt-1">
              <button
                type="button"
                onClick={handleAddRow}
                className="btn btn-secondary btn-sm flex items-center gap-1.5 text-xs"
              >
                <FiPlus size={13} /> Add Custom Item
              </button>

              <button
                type="button"
                onClick={loadBreakdown}
                className="text-xs text-gray-500 hover:text-gray-800 flex items-center gap-1"
              >
                <FiRefreshCw size={12} /> Regenerate with AI
              </button>
            </div>

            {/* Summary Statistics Comparison Card */}
            {summary && (
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 pt-2 border-t border-gray-200">
                <div className="bg-gray-50 rounded-lg p-2.5 border border-gray-200">
                  <span className="text-[11px] text-gray-500 block">Total Breakdown Items</span>
                  <span className="font-bold text-gray-800 text-sm">{summary.total_items} items</span>
                  <span className="text-[10px] text-emerald-700 block mt-0.5">
                    {summary.sepl_matched_count || 0} matched in Item Master
                  </span>
                </div>

                <div className="bg-emerald-50/70 rounded-lg p-2.5 border border-emerald-200">
                  <span className="text-[11px] text-emerald-800 block font-medium">Total SEPL Cost (Baseline)</span>
                  <span className="font-bold font-mono text-emerald-900 text-sm">₹ {fmt(summary.total_sepl_cost)}</span>
                  <span className="text-[10px] text-emerald-700 block mt-0.5">From Item Master/POs</span>
                </div>

                <div className="bg-blue-50/70 rounded-lg p-2.5 border border-blue-200">
                  <span className="text-[11px] text-blue-800 block font-medium">Total Market Cost (Perplexity)</span>
                  <span className="font-bold font-mono text-blue-900 text-sm">₹ {fmt(summary.total_market_cost)}</span>
                  <span className="text-[10px] text-blue-700 block mt-0.5">
                    Variance: {summary.variance >= 0 ? '+' : ''}{fmt(summary.variance)} ({summary.variance_pct}%)
                  </span>
                </div>

                <div className="bg-gradient-to-br from-red-600 to-red-700 text-white rounded-lg p-2.5 shadow-sm">
                  <span className="text-[11px] text-red-100 block font-medium">Active Approved Total</span>
                  <span className="font-bold font-mono text-base block">₹ {fmt(summary.total_active_cost)}</span>
                  <span className="text-[10px] text-red-100 block">Calculated using selected rates</span>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Footer Actions */}
        <div className="flex items-center justify-between pt-4 border-t border-gray-200">
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs sm:text-sm px-4 py-2"
          >
            Cancel (Discard Draft)
          </button>

          <button
            type="button"
            onClick={handleApprove}
            disabled={loading || !items.length}
            className="btn btn-primary text-xs sm:text-sm px-5 py-2 flex items-center gap-2 disabled:opacity-50"
          >
            <FiCheck size={16} /> Approve & Save Breakdown
          </button>
        </div>
      </div>
    </Modal>
  );
}
