import NumberedTable from './NumberedTable';
import { useState, useEffect } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import { FiSearch, FiExternalLink, FiClock, FiCheck, FiShoppingBag, FiGlobe, FiAlertCircle, FiTag } from 'react-icons/fi';

/**
 * Intelligent Query Extractor for EPC / MEP Tender Items (Solution A)
 */
export function extractCleanQuery(rawText, size = '', make = '', spec = '') {
  let text = String(rawText || '').trim();
  if (!text) return '';

  const hasBoqNoise = text.length > 25 && /(conforming to|together with|including|excavation|supply,?\s*install|providing|necessary|adapter pieces|flanges,\s*gaskets)/i.test(text);
  if (!hasBoqNoise && text.length <= 40) {
    if (size && !text.toLowerCase().includes(size.toLowerCase().replace(/\s*dia\b/i, ''))) {
      text = `${text} ${size}`.trim();
    }
    return text.replace(/\s+/g, ' ').trim();
  }

  // 1. Strip leading numbering / bullets: i), (i), 1., 1.1, a), (a), A., 1)
  text = text.replace(/^(\([0-9a-zivx]+\)|[0-9a-zivx]+[\).])\s*/i, '');

  // 2. Strip tender contract prefixes (case-insensitive)
  text = text.replace(/^(providing\s*(and|&)?\s*fixing(\s*of)?|supply\s*(and|&)?\s*delivery(\s*of)?|supply\s*,?\s*(installation\s*,?\s*)?testing\s*(and|&)?\s*commissioning(\s*of)?)\s*/i, '');
  text = text.replace(/^all\s+/i, '');

  // 3. Detect standards (IS 1239, IS 3589, BS 5154, ASTM A53) before cutting
  const standardMatch = text.match(/\b(IS\s*\d+|BS\s*\d+|ASTM\s*[A-Z0-9]+)\b/i);
  const standard = standardMatch ? standardMatch[1].replace(/\s+/g, ' ') : '';

  // 4. Cut off trailing contractual / site activity clauses
  const cutOffKeywords = [
    /\btogether with\b.*/i,
    /\balong with\b.*/i,
    /\bcomplete with\b.*/i,
    /\bincluding\b.*/i,
    /\bas per\b.*/i,
    /\bas specified\b.*/i,
    /\bconforming to\b.*/i,
    /\bnecessary\b.*/i
  ];
  for (const regex of cutOffKeywords) {
    text = text.replace(regex, '');
  }

  // 5. Clean brackets and extra punctuation
  text = text.replace(/[();:,]/g, ' ').replace(/\s+/g, ' ').trim();

  // 6. Domain-specific normalization:
  // PIPES:
  if (/\bpipes?\b/i.test(text)) {
    const isGI = /\b(gi|galvanised|galvanized)\b/i.test(rawText);
    const pipeType = isGI ? 'GI Pipe' : 'MS Pipe';
    const cls = rawText.match(/class[-\s]*([abc])/i);
    const classStr = cls ? 'Class ' + cls[1].toUpperCase() : '';
    text = `${pipeType} ${classStr}`.trim();
  }

  // 7. Append structured size if not already included
  if (size && !text.toLowerCase().includes(size.toLowerCase().replace(/\s*dia\b/i, ''))) {
    text = `${text} ${size}`.trim();
  }

  // 8. Append IS standard if extracted and not included
  if (standard && !text.toLowerCase().includes(standard.toLowerCase())) {
    text = `${text} ${standard}`.trim();
  }

  // 9. Append Make/Brand if valid single make
  if (make && !/^[—\-]|n\/?a|any|reputed|approved/i.test(make) && !text.toLowerCase().includes(make.toLowerCase())) {
    const firstMake = make.split(/[\/,]/)[0].trim();
    if (firstMake && firstMake.length > 1) {
      text = `${text} ${firstMake}`.trim();
    }
  }

  return text.replace(/\s+/g, ' ').trim();
}

export function getQuerySuggestions(rawText, size = '', make = '', spec = '') {
  const primary = extractCleanQuery(rawText, size, make, spec);
  const list = [];
  if (primary) list.push({ label: 'Clean Spec (Auto)', query: primary, type: 'primary' });

  // Shorter spec without brand/standard
  let simple = primary;
  if (make) {
    const firstMake = make.split(/[\/,]/)[0].trim();
    simple = simple.replace(new RegExp('\\b' + firstMake + '\\b', 'i'), '').trim();
  }
  simple = simple.replace(/\b(IS\s*\d+|BS\s*\d+)\b/i, '').replace(/\s+/g, ' ').trim();
  if (simple && simple !== primary) {
    list.push({ label: 'Generic Size', query: simple, type: 'simple' });
  }

  // Brand variant
  if (make && size && /\bpipe\b/i.test(primary)) {
    const firstMake = make.split(/[\/,]/)[0].trim();
    const brandQ = `${firstMake} Pipe ${size}`.trim();
    if (!list.some(x => x.query === brandQ)) {
      list.push({ label: `${firstMake} Pipe`, query: brandQ, type: 'brand' });
    }
  }

  // Original raw BOQ
  const rawClean = String(rawText || '').trim();
  if (rawClean && rawClean !== primary) {
    list.push({ label: 'Full BOQ Text', query: rawClean, type: 'raw' });
  }

  return list;
}

export default function MarketRatesModal({ isOpen, onClose, item, onApplyRate }) {
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState(null);
  const [activeTab, setActiveTab] = useState('online'); // 'online' | 'internal'
  const [suggestions, setSuggestions] = useState([]);

  useEffect(() => {
    if (isOpen && item) {
      const rawName = item.item_name || item.name || '';
      const suggs = getQuerySuggestions(rawName, item.size, item.make, item.specification);
      setSuggestions(suggs);
      const defaultQ = suggs[0]?.query || rawName;
      setQuery(defaultQ);
      if (defaultQ) {
        fetchRates(defaultQ);
      }
    } else {
      setData(null);
      setSuggestions([]);
    }
  }, [isOpen, item]);

  const fetchRates = async (searchQuery) => {
    const q = (searchQuery || query || '').trim();
    if (!q) return;
    setLoading(true);
    try {
      const res = await api.get('/market-rates/search', {
        params: {
          q,
          size: item?.size || '',
          make: item?.make || '',
          spec: item?.specification || ''
        }
      });
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
      <div className="space-y-3.5">
        {/* ITEM CONTEXT CARD (Shows original BOQ clause + structured attributes) */}
        {item && (
          <div className="text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="font-semibold text-slate-800 line-clamp-2 flex-1" title={item.item_name}>
                <span className="text-[10px] uppercase font-bold text-slate-400 mr-1.5 tracking-wider">BOQ Line:</span>
                {item.item_name}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-slate-600 bg-white px-2 py-0.5 rounded border border-slate-200">
                {item.size && <span>Size: <strong className="text-slate-900">{item.size}</strong></span>}
                {item.make && <span className="border-l pl-2 border-slate-200">Make: <strong className="text-slate-900">{item.make}</strong></span>}
                {item.uom && <span className="border-l pl-2 border-slate-200">UOM: <strong className="text-slate-900">{item.uom}</strong></span>}
              </div>
            </div>
          </div>
        )}

        {/* TOP SEARCH BAR */}
        <form onSubmit={handleSearchSubmit} className="flex gap-2">
          <div className="relative flex-1">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
            <input
              type="text"
              className="input pl-9 text-sm w-full font-medium"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder="Search Moglix, IndiaMART & ERP POs by product name or spec..."
            />
          </div>
          <button type="submit" disabled={loading} className="btn btn-primary text-sm flex items-center gap-1.5 px-4 font-semibold">
            {loading ? 'Searching…' : 'Search'}
          </button>
        </form>

        {/* SOLUTION B: QUICK SPECIFICATION SUGGESTION CHIPS */}
        {suggestions.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 -mt-1">
            <span className="text-[11px] font-semibold text-gray-400 uppercase tracking-wider mr-1 flex items-center gap-1">
              <FiTag size={10} /> Smart Suggestions:
            </span>
            {suggestions.map((s, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => {
                  setQuery(s.query);
                  fetchRates(s.query);
                }}
                className={`text-[11px] px-2.5 py-1 rounded-md border transition-all flex items-center gap-1 ${
                  query === s.query
                    ? 'bg-blue-600 text-white border-blue-600 shadow-2xs font-semibold'
                    : 'bg-white text-gray-700 border-gray-200 hover:border-blue-300 hover:bg-blue-50/50'
                }`}
                title={s.query}
              >
                <span className="text-[10px] opacity-75">{s.label}:</span>
                <span className="truncate max-w-[220px]">{s.query}</span>
              </button>
            ))}
          </div>
        )}

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
                  <NumberedTable className="w-full text-xs text-left">
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
                  </NumberedTable>
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
