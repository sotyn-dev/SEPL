import { useState, useEffect } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiSearch, FiExternalLink, FiClock, FiCheck, FiShoppingBag, FiGlobe, FiAlertCircle } from 'react-icons/fi';

export default function MarketRatesModal({ isOpen, onClose, item, onApplyRate }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('online'); // 'online' | 'internal'

  useEffect(() => {
    if (isOpen && item) {
      const initialQuery = item.item_name || item.name || '';
      setQuery(initialQuery);
      if (initialQuery) {
        fetchRates(initialQuery);
      }
    } else {
      setData(null);
    }
  }, [isOpen, item]);

  const fetchRates = async (searchQuery) => {
    const q = (searchQuery || query || '').trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await api.get('/market-rates/search', { params: { q } });
      setData(res.data);
    } catch (err) {
      toast.error('Could not load market rates');
    } finally {
      setLoading(false);
    }
  };

  const handleSearchSubmit = (e) => {
    e.preventDefault();
    fetchRates(query);
  };

  if (!isOpen) return null;

  const pastPoRates = data?.internalHistory?.pastPoRates || [];
  const masterRate = data?.internalHistory?.masterRate || null;
  const moglixItems = data?.moglix || [];
  const indiamartItems = data?.indiamart || [];
  const directLinks = data?.directLinks || {
    moglix: `https://www.moglix.com/search?controller=search&s=${encodeURIComponent(query)}`,
    indiamart: `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(query)}`,
    amazon: `https://www.amazon.in/s?k=${encodeURIComponent(query)}`,
    industrybuying: `https://www.industrybuying.com/search/?q=${encodeURIComponent(query)}`,
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Live Market Rates & Price Discovery (TSK-0378)" wide>
      <div className="space-y-4">
        {/* TOP SEARCH BAR */}
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
            <input
              type="text"
              className="input pl-9 text-sm w-full"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search Moglix, IndiaMART & ERP POs by product name or spec..."
            />
          </div>
          <button type="submit" disabled={loading} className="btn btn-primary text-sm flex items-center gap-1.5 px-4">
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {/* EXTERNAL DIRECT SEARCH SHORTCUTS */}
        <div className="flex flex-wrap items-center gap-2 p-2.5 bg-gray-50 border border-gray-200 rounded-lg text-xs">
          <span className="font-semibold text-gray-700 flex items-center gap-1">
            <FiGlobe size={13} className="text-blue-600" />
            Direct Portals:
          </span>
          <a
            href={directLinks.moglix}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-orange-50 border border-orange-200 text-orange-700 rounded font-medium shadow-2xs transition-colors"
          >
            <span>Moglix</span>
            <FiExternalLink size={11} />
          </a>
          <a
            href={directLinks.indiamart}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-emerald-50 border border-emerald-200 text-emerald-700 rounded font-medium shadow-2xs transition-colors"
          >
            <span>IndiaMART</span>
            <FiExternalLink size={11} />
          </a>
          <a
            href={directLinks.industrybuying}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-amber-50 border border-amber-200 text-amber-700 rounded font-medium shadow-2xs transition-colors"
          >
            <span>IndustryBuying</span>
            <FiExternalLink size={11} />
          </a>
          <a
            href={directLinks.amazon}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 px-2.5 py-1 bg-white hover:bg-blue-50 border border-blue-200 text-blue-700 rounded font-medium shadow-2xs transition-colors"
          >
            <span>Amazon Business</span>
            <FiExternalLink size={11} />
          </a>
        </div>

        {/* PRICE SUMMARY BANNER (IF AVAILABLE) */}
        {data?.summary && (
          <div className="grid grid-cols-3 gap-3 p-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-200 rounded-lg text-center">
            <div>
              <div className="text-[10px] uppercase font-semibold text-gray-500">Lowest Market Rate</div>
              <div className="text-lg font-bold text-emerald-700">₹ {data.summary.lowestPrice.toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-gray-500">Average Rate</div>
              <div className="text-lg font-bold text-blue-700">₹ {data.summary.averagePrice.toLocaleString('en-IN')}</div>
            </div>
            <div>
              <div className="text-[10px] uppercase font-semibold text-gray-500">Highest Rate</div>
              <div className="text-lg font-bold text-gray-700">₹ {data.summary.highestPrice.toLocaleString('en-IN')}</div>
            </div>
          </div>
        )}

        {/* TABS: ONLINE vs INTERNAL ERP HISTORY */}
        <div className="border-b border-gray-200 flex gap-2">
          <button
            type="button"
            onClick={() => setActiveTab('online')}
            className={`py-2 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'online'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FiShoppingBag size={13} />
            <span>Online Portals ({moglixItems.length + indiamartItems.length} Offers)</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('internal')}
            className={`py-2 px-3 text-xs font-semibold border-b-2 transition-colors flex items-center gap-1.5 ${
              activeTab === 'internal'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}
          >
            <FiClock size={13} />
            <span>Internal SEPL Records ({pastPoRates.length + (masterRate ? 1 : 0)})</span>
          </button>
        </div>

        {/* TAB 1: ONLINE PORTALS */}
        {activeTab === 'online' && (
          <div className="space-y-4 max-h-[380px] overflow-y-auto pr-1">
            {loading ? (
              <div className="py-10 text-center text-sm text-gray-400">
                <div className="animate-spin inline-block w-6 h-6 border-2 border-blue-600 border-t-transparent rounded-full mb-2"></div>
                <div>Fetching live rates from Moglix and IndiaMART…</div>
              </div>
            ) : (
              <>
                {/* Moglix Section */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-xs font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-orange-500 inline-block"></span>
                      Moglix Live Catalog ({moglixItems.length})
                    </h5>
                    <a href={directLinks.moglix} target="_blank" rel="noopener noreferrer" className="text-xs text-orange-600 hover:underline flex items-center gap-1">
                      View all on Moglix <FiExternalLink size={10} />
                    </a>
                  </div>
                  {moglixItems.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {moglixItems.map((p, idx) => (
                        <div key={idx} className="border border-gray-200 rounded-lg p-2.5 bg-white hover:shadow-xs transition-shadow flex flex-col justify-between">
                          <div>
                            <div className="text-xs font-semibold text-gray-900 line-clamp-2" title={p.title}>{p.title}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5">Brand: <span className="font-medium text-gray-700">{p.brand}</span></div>
                          </div>
                          <div className="mt-2 pt-2 border-t flex items-center justify-between">
                            <div>
                              <div className="text-sm font-bold text-gray-900">₹ {p.price.toLocaleString('en-IN')}</div>
                              {p.mrp > p.price && <div className="text-[10px] text-gray-400 line-through">₹ {p.mrp}</div>}
                            </div>
                            <div className="flex items-center gap-1.5">
                              {onApplyRate && p.price > 0 && (
                                <button
                                  type="button"
                                  onClick={() => onApplyRate(p.price, `Moglix (${p.brand})`)}
                                  className="btn btn-secondary text-[11px] py-1 px-2"
                                  title="Use this rate in RFQ vendor quotes"
                                >
                                  Apply Rate
                                </button>
                              )}
                              <a href={p.url} target="_blank" rel="noopener noreferrer" className="p-1.5 text-gray-400 hover:text-orange-600" title="Open product page">
                                <FiExternalLink size={13} />
                              </a>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 bg-gray-50 border border-dashed rounded text-xs text-gray-500 flex items-center justify-between">
                      <span>No direct product listings parsed for "{query}".</span>
                      <a href={directLinks.moglix} target="_blank" rel="noopener noreferrer" className="btn btn-secondary text-[11px] py-1 px-2 flex items-center gap-1 text-orange-700">
                        Search on Moglix Website <FiExternalLink size={11} />
                      </a>
                    </div>
                  )}
                </div>

                {/* IndiaMART Section */}
                <div className="pt-2 border-t">
                  <div className="flex items-center justify-between mb-2">
                    <h5 className="text-xs font-bold text-gray-700 uppercase tracking-wide flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-500 inline-block"></span>
                      IndiaMART Verified Suppliers ({indiamartItems.length})
                    </h5>
                    <a href={directLinks.indiamart} target="_blank" rel="noopener noreferrer" className="text-xs text-emerald-600 hover:underline flex items-center gap-1">
                      View all on IndiaMART <FiExternalLink size={10} />
                    </a>
                  </div>
                  {indiamartItems.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                      {indiamartItems.map((im, idx) => (
                        <div key={idx} className="border border-gray-200 rounded-lg p-2.5 bg-white hover:shadow-xs transition-shadow flex flex-col justify-between">
                          <div>
                            <div className="text-xs font-semibold text-gray-900 line-clamp-2" title={im.title}>{im.title}</div>
                            <div className="text-[11px] text-gray-500 mt-0.5">Supplier: <span className="font-medium text-emerald-800">{im.supplier}</span></div>
                            <div className="text-[10px] text-gray-400">{im.location}</div>
                          </div>
                          <div className="mt-2 pt-2 border-t flex items-center justify-between">
                            <div className="text-sm font-bold text-emerald-700">
                              {im.price > 0 ? `₹ ${im.price.toLocaleString('en-IN')}` : (im.priceRange || 'Call for Quote')}
                            </div>
                            <div className="flex items-center gap-1.5">
                              {onApplyRate && im.price > 0 && (
                                <button
                                  type="button"
                                  onClick={() => onApplyRate(im.price, `${im.supplier} (IndiaMART)`)}
                                  className="btn btn-secondary text-[11px] py-1 px-2"
                                  title="Use this supplier rate in RFQ vendor quotes"
                                >
                                  Apply Rate
                                </button>
                              )}
                              <a href={im.url} target="_blank" rel="noopener noreferrer" className="p-1.5 text-gray-400 hover:text-emerald-600" title="Open listing on IndiaMART">
                                <FiExternalLink size={13} />
                              </a>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-lg flex items-center justify-between">
                      <div>
                        <div className="text-xs font-semibold text-emerald-900">Verified IndiaMART Suppliers for "{query}"</div>
                        <div className="text-[11px] text-emerald-700 mt-0.5">Explore manufacturer bids, bulk price slabs, and verified dealer contacts.</div>
                      </div>
                      <a
                        href={directLinks.indiamart}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn btn-primary text-xs py-1.5 px-3 flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-700 border-none shadow-xs text-white shrink-0"
                      >
                        <span>View Live Bids</span>
                        <FiExternalLink size={11} />
                      </a>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        {/* TAB 2: INTERNAL SEPL ERP HISTORY */}
        {activeTab === 'internal' && (
          <div className="space-y-3 max-h-[380px] overflow-y-auto pr-1">
            {/* Item Master Baseline */}
            {masterRate && (
              <div className="p-3 bg-blue-50/70 border border-blue-200 rounded-lg flex items-center justify-between">
                <div>
                  <div className="text-[10px] font-bold text-blue-900 uppercase">Item Master Baseline</div>
                  <div className="text-xs font-semibold text-gray-800">{masterRate.item_name} ({masterRate.item_code})</div>
                  <div className="text-[11px] text-gray-500">Source: {masterRate.source_type || 'Manual'} {masterRate.make ? `· Make: ${masterRate.make}` : ''}</div>
                </div>
                <div className="text-right">
                  <div className="text-base font-bold text-blue-800">₹ {Number(masterRate.current_price || 0).toLocaleString('en-IN')}</div>
                  {onApplyRate && (
                    <button
                      type="button"
                      onClick={() => onApplyRate(masterRate.current_price, `Item Master (${masterRate.item_code})`)}
                      className="btn btn-secondary text-[10px] py-0.5 px-2 mt-1"
                    >
                      Use Master Rate
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* Vendor PO History */}
            <div>
              <h5 className="text-xs font-bold text-gray-700 uppercase tracking-wide mb-2">Previous Vendor POs ({pastPoRates.length})</h5>
              {pastPoRates.length > 0 ? (
                <div className="border border-gray-200 rounded-lg overflow-hidden">
                  <table className="w-full text-xs text-left">
                    <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                      <tr>
                        <th className="px-3 py-2">PO # / Date</th>
                        <th className="px-3 py-2">Vendor</th>
                        <th className="px-3 py-2">Item Description</th>
                        <th className="px-3 py-2 text-right">Qty</th>
                        <th className="px-3 py-2 text-right">Rate</th>
                        {onApplyRate && <th className="px-3 py-2 text-right">Action</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {pastPoRates.map((po, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-[11px]">
                            <div className="font-semibold text-gray-800">{po.po_number || 'PO'}</div>
                            <div className="text-[10px] text-gray-400">{po.po_date || String(po.created_at || '').slice(0, 10)}</div>
                          </td>
                          <td className="px-3 py-2 font-medium text-gray-800">{po.vendor_name || 'Vendor'}</td>
                          <td className="px-3 py-2 text-gray-600 truncate max-w-[180px]" title={po.description}>{po.description}</td>
                          <td className="px-3 py-2 text-right text-gray-600">{po.quantity}</td>
                          <td className="px-3 py-2 text-right font-bold text-gray-900">₹ {Number(po.rate || 0).toLocaleString('en-IN')}</td>
                          {onApplyRate && (
                            <td className="px-3 py-2 text-right">
                              <button
                                type="button"
                                onClick={() => onApplyRate(po.rate, po.vendor_name)}
                                className="btn btn-secondary text-[10px] py-0.5 px-2"
                              >
                                Apply
                              </button>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <div className="p-6 text-center text-xs text-gray-400 border border-dashed rounded-lg">
                  No previous Vendor PO items found matching "{query}".
                </div>
              )}
            </div>
          </div>
        )}

        {/* MODAL FOOTER */}
        <div className="flex justify-between items-center pt-2 border-t text-[11px] text-gray-500">
          <span>💡 Integrates Moglix & IndiaMART market discovery directly into SEPL procurement.</span>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
