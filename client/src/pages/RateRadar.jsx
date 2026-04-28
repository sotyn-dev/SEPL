// Rate Radar — vendor price intelligence for one item.
//
// mam picks an item from the master, page shows everything we know
// about historical prices: lowest / highest / average finalized rate,
// top vendors by frequency, and the full quote / finalized / vendor PO
// trail. Used to decide a fair rate before quoting on a new indent.

import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import SearchableSelect from '../components/SearchableSelect';
import { FiTrendingUp, FiAward, FiSearch, FiCalendar, FiUser, FiTag, FiArrowDown, FiArrowUp } from 'react-icons/fi';

const fmtR = (n) => n == null ? '—' : 'Rs ' + Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const fmtN = (n) => (n == null ? 0 : +n).toLocaleString('en-IN');
const fmtDate = (s) => s ? new Date(s).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' }) : '—';

export default function RateRadar() {
  const [items, setItems] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [deptFilter, setDeptFilter] = useState('');

  useEffect(() => {
    api.get('/item-master/dropdown').then(r => {
      setItems((r.data || []).map(i => ({
        ...i,
        label: [i.item_code, i.item_name, i.specification, i.size, i.department && '· ' + i.department].filter(Boolean).join(' '),
      })));
    }).catch(() => setItems([]));
  }, []);

  const filteredItems = useMemo(() => {
    if (!deptFilter) return items;
    return items.filter(i => i.department === deptFilter);
  }, [items, deptFilter]);
  const departments = useMemo(() => [...new Set(items.map(i => i.department).filter(Boolean))].sort(), [items]);

  useEffect(() => {
    if (!selectedId) { setData(null); return; }
    setLoading(true);
    api.get(`/rate-radar/${selectedId}`)
      .then(r => setData(r.data))
      .catch(err => { toast.error(err.response?.data?.error || 'Failed'); setData(null); })
      .finally(() => setLoading(false));
  }, [selectedId]);

  return (
    <div className="space-y-4">
      <div>
        <h3 className="text-xl font-bold text-gray-800 flex items-center gap-2">
          <FiTrendingUp className="text-red-600" /> Rate Radar
        </h3>
        <p className="text-sm text-gray-500">
          Pick any item to see every vendor quote SEPL ever got for it · lowest / highest / average finalized rate · best vendor by frequency · actual purchase prices.
        </p>
      </div>

      {/* Department filter + Item picker */}
      <div className="card p-4 space-y-3">
        {departments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase">Department:</span>
            <button onClick={() => setDeptFilter('')} className={`px-3 py-1 rounded-lg text-xs font-medium border ${deptFilter === '' ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
              All ({items.length})
            </button>
            {departments.map(d => {
              const count = items.filter(i => i.department === d).length;
              return (
                <button key={d} onClick={() => setDeptFilter(d)} className={`px-3 py-1 rounded-lg text-xs font-medium border ${deptFilter === d ? 'bg-red-600 text-white border-red-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
                  {d} <span className="opacity-70">({count})</span>
                </button>
              );
            })}
          </div>
        )}
        <div>
          <label className="label flex items-center gap-1"><FiSearch size={12} /> Pick Item</label>
          <SearchableSelect
            options={filteredItems}
            value={selectedId}
            valueKey="id" displayKey="label"
            placeholder="Search by name / code / spec…"
            onChange={(opt) => setSelectedId(opt?.id || null)}
          />
        </div>
      </div>

      {loading && <div className="card p-6 text-center text-gray-400">Loading rate history…</div>}

      {!loading && !data && !selectedId && (
        <div className="card p-8 text-center text-gray-400 text-sm">
          ↑ Pick an item above to see its full rate history.
        </div>
      )}

      {!loading && data && (
        <>
          {/* Item details */}
          <div className="card p-4 bg-gradient-to-br from-red-50 to-white border-l-4 border-red-500">
            <div className="flex items-start justify-between flex-wrap gap-3">
              <div>
                <div className="text-[11px] font-mono text-gray-500">[{data.item.item_code}] · {data.item.type || '—'}</div>
                <div className="text-lg font-bold text-gray-800">{data.item.item_name}</div>
                <div className="text-xs text-gray-500 mt-0.5">
                  {[data.item.specification, data.item.size, data.item.uom && 'UOM: ' + data.item.uom, data.item.make && 'Make: ' + data.item.make].filter(Boolean).join(' · ')}
                </div>
              </div>
              {data.item.current_price > 0 && (
                <div className="text-right">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold">Master Price</div>
                  <div className="text-xl font-bold text-gray-800 tabular-nums">{fmtR(data.item.current_price)}</div>
                </div>
              )}
            </div>
          </div>

          {data.summary.count_finalized === 0 ? (
            <div className="card p-6 text-center text-gray-400">
              No finalized rates yet for this item. {data.summary.count_quotes > 0 && `(${data.summary.count_quotes} quote(s) entered but none finalized.)`}
            </div>
          ) : (
            <>
              {/* Summary stats */}
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                <div className="card p-3 border-l-4 border-emerald-500">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold flex items-center gap-1"><FiArrowDown size={10} /> Lowest</div>
                  <div className="text-lg font-bold text-emerald-700 mt-0.5 tabular-nums">{fmtR(data.summary.min_rate)}</div>
                </div>
                <div className="card p-3 border-l-4 border-red-500">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold flex items-center gap-1"><FiArrowUp size={10} /> Highest</div>
                  <div className="text-lg font-bold text-red-700 mt-0.5 tabular-nums">{fmtR(data.summary.max_rate)}</div>
                </div>
                <div className="card p-3 border-l-4 border-blue-500">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold">Average</div>
                  <div className="text-lg font-bold text-gray-800 mt-0.5 tabular-nums">{fmtR(data.summary.avg_rate)}</div>
                </div>
                <div className="card p-3 border-l-4 border-purple-500">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold">Latest</div>
                  <div className="text-lg font-bold text-gray-800 mt-0.5 tabular-nums">{fmtR(data.summary.latest_rate)}</div>
                  <div className="text-[10px] text-gray-500 truncate" title={data.summary.latest_vendor}>{data.summary.latest_vendor}</div>
                </div>
                <div className="card p-3 border-l-4 border-amber-500">
                  <div className="text-[10px] uppercase text-gray-500 font-semibold">Total Spend</div>
                  <div className="text-lg font-bold text-gray-800 mt-0.5 tabular-nums">{fmtR(data.summary.total_value)}</div>
                  <div className="text-[10px] text-gray-500">{data.summary.count_finalized} finalizations</div>
                </div>
              </div>

              {/* Recommended vendor */}
              {data.recommended && (
                <div className="card p-4 bg-emerald-50 border-l-4 border-emerald-500">
                  <div className="flex items-start justify-between flex-wrap gap-3">
                    <div>
                      <div className="text-[10px] uppercase text-emerald-700 font-semibold flex items-center gap-1">
                        <FiAward size={11} /> Recommended Vendor
                      </div>
                      <div className="text-xl font-bold text-gray-800 mt-0.5">{data.recommended.vendor}</div>
                      <div className="text-xs text-gray-600 mt-1">
                        Picked <b>{data.recommended.times_selected}</b> time(s) ·
                        Avg <b className="tabular-nums">{fmtR(data.recommended.avg_rate)}</b> ·
                        Lowest ever <b className="tabular-nums">{fmtR(data.recommended.min_rate)}</b>
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] uppercase text-emerald-700 font-semibold">Latest Rate</div>
                      <div className="text-2xl font-bold text-emerald-700 tabular-nums">{fmtR(data.recommended.latest_rate)}</div>
                      <div className="text-[10px] text-gray-500">on {fmtDate(data.recommended.latest_when)}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* Top vendors */}
              {data.top_vendors.length > 1 && (
                <div className="card p-0 overflow-hidden">
                  <div className="px-4 py-3 border-b bg-gray-50">
                    <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiUser size={13} className="text-red-600" /> All Vendors (by selection frequency)</h4>
                  </div>
                  <table className="text-sm w-full">
                    <thead className="bg-gray-50/60">
                      <tr>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Vendor</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Picked</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Avg Rate</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Lowest</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Latest Rate</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Latest Date</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.top_vendors.map(v => (
                        <tr key={v.vendor} className={`border-t ${v.vendor === data.recommended?.vendor ? 'bg-emerald-50/30' : 'hover:bg-gray-50'}`}>
                          <td className="px-3 py-2 font-medium text-gray-800">
                            {v.vendor === data.recommended?.vendor && <FiAward size={11} className="text-emerald-600 inline mr-1" />}
                            {v.vendor}
                          </td>
                          <td className="px-3 py-2 text-right tabular-nums">{v.times_selected}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtR(v.avg_rate)}</td>
                          <td className="px-3 py-2 text-right text-emerald-700 tabular-nums">{fmtR(v.min_rate)}</td>
                          <td className="px-3 py-2 text-right tabular-nums">{fmtR(v.latest_rate)}</td>
                          <td className="px-3 py-2 text-xs text-gray-500">{fmtDate(v.latest_when)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {/* Finalized history */}
              <div className="card p-0 overflow-hidden">
                <div className="px-4 py-3 border-b bg-gray-50">
                  <h4 className="font-semibold text-gray-700 flex items-center gap-2"><FiTag size={13} className="text-red-600" /> Finalized Rates ({data.finalized.length})</h4>
                </div>
                <div className="overflow-x-auto">
                  <table className="text-sm w-full">
                    <thead className="bg-gray-50/60">
                      <tr>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Indent</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Site</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Vendor</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Rate</th>
                        <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Qty</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Terms</th>
                        <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When / By</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.finalized.map((f, i) => (
                        <tr key={i} className="border-t hover:bg-gray-50">
                          <td className="px-3 py-2 font-mono text-xs text-red-700">{f.indent_number}</td>
                          <td className="px-3 py-2 text-xs text-gray-700">{f.site_name || '—'}</td>
                          <td className="px-3 py-2 font-medium text-gray-800">{f.vendor}</td>
                          <td className="px-3 py-2 text-right font-bold tabular-nums">{fmtR(f.rate)}</td>
                          <td className="px-3 py-2 text-right text-gray-600 tabular-nums">{fmtN(f.quantity)} {f.unit}</td>
                          <td className="px-3 py-2 text-xs">{f.terms || '—'}{f.credit_days ? ` · ${f.credit_days}d` : ''}</td>
                          <td className="px-3 py-2 text-[11px] text-gray-500">
                            <div>{fmtDate(f.when)}</div>
                            <div>by {f.by || '—'}</div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </>
          )}

          {/* All quotes */}
          {data.quotes.length > 0 && (
            <details className="card p-0 overflow-hidden">
              <summary className="px-4 py-3 border-b bg-gray-50 cursor-pointer flex items-center justify-between">
                <h4 className="font-semibold text-gray-700">All Quotes Received ({data.quotes.length})</h4>
                <span className="text-[11px] text-gray-400">click to expand</span>
              </summary>
              <div className="overflow-x-auto">
                <table className="text-sm w-full">
                  <thead className="bg-gray-50/60">
                    <tr>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Vendor</th>
                      <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Rate</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Terms</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Indent</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Site</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.quotes.map((q, i) => (
                      <tr key={i} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-2">{q.vendor}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtR(q.rate)}</td>
                        <td className="px-3 py-2 text-xs">{q.terms || '—'}{q.credit_days ? ` · ${q.credit_days}d` : ''}</td>
                        <td className="px-3 py-2 font-mono text-xs text-red-700">{q.indent_number}</td>
                        <td className="px-3 py-2 text-xs text-gray-700">{q.site_name || '—'}</td>
                        <td className="px-3 py-2 text-[11px] text-gray-500">{fmtDate(q.when)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}

          {/* Vendor POs (actual purchase rates) */}
          {data.vendor_pos.length > 0 && (
            <details className="card p-0 overflow-hidden">
              <summary className="px-4 py-3 border-b bg-gray-50 cursor-pointer flex items-center justify-between">
                <h4 className="font-semibold text-gray-700">Actual Purchases — Vendor POs ({data.vendor_pos.length})</h4>
                <span className="text-[11px] text-gray-400">click to expand</span>
              </summary>
              <div className="overflow-x-auto">
                <table className="text-sm w-full">
                  <thead className="bg-gray-50/60">
                    <tr>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">PO No</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Vendor</th>
                      <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Rate</th>
                      <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Qty</th>
                      <th className="text-right px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Amount</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">Terms</th>
                      <th className="text-left px-3 py-2 text-[10px] uppercase font-semibold text-gray-500">PO Date</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.vendor_pos.map((p, i) => (
                      <tr key={i} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-xs text-red-700">{p.po_number}</td>
                        <td className="px-3 py-2">{p.vendor_name || '—'}</td>
                        <td className="px-3 py-2 text-right font-semibold tabular-nums">{fmtR(p.rate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtN(p.quantity)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{fmtR(p.amount)}</td>
                        <td className="px-3 py-2 text-xs">{p.terms || '—'}{p.credit_days ? ` · ${p.credit_days}d` : ''}</td>
                        <td className="px-3 py-2 text-[11px] text-gray-500">{fmtDate(p.po_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </div>
  );
}
