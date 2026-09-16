// SOP-05 ITEM-WISE register (mam 2026-08-31: "i need item wise system") —
// one row per BOQ item of the booked orders, each carrying its own stage
// status: S1 package date → S2/S3 vendor quotes (3-quote rule) → S4/S5
// finalise + above-estimate→MD → S6 rate contract → S7 long-delivery flag.
// Feeds from GET /procurement/rates-items; S7 toggles on the Item Master.
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import { useRateActions } from '../components/RateActions';
import { FiSearch, FiChevronLeft, FiChevronRight, FiRefreshCw } from 'react-icons/fi';

const Chip = ({ on, label, title, color = 'emerald' }) => (
  <span title={title}
    className={`inline-block px-1.5 py-0.5 rounded text-[9px] font-bold ${on
      ? color === 'red' ? 'bg-red-100 text-red-700' : color === 'amber' ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'
      : 'bg-gray-100 text-gray-400'}`}>
    {label}
  </span>
);

// `embedded` = rendered inside another page's tab (Orders → Order Planning,
// mam 2026-09-05: "i want show first photo on second photo"). It only drops
// this page's own <h1> and Rates Board link, since the host already has them;
// everything else — search, table, actions, pager — is identical, so there is
// one implementation of this screen, not two that drift apart.
export default function RatesItems({ embedded = false }) {
  const [data, setData] = useState(null);
  // Deep link: the Rates Board opens this register pre-filtered to an order
  // (?q=<PO number>). Read once on mount; the box stays a normal input after.
  const [urlParams] = useSearchParams();
  const [search, setSearch] = useState(urlParams.get('q') || '');
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');

  const load = useCallback(() => {
    api.get('/procurement/rates-items', { params: { search, page } })
      .then(r => setData(r.data))
      .catch(e => setErr(e.response?.data?.error || 'Failed to load'));
  }, [search, page]);
  useEffect(() => { const t = setTimeout(load, search ? 350 : 0); return () => clearTimeout(t); }, [load, search]);

  // ── Row actions (mam 2026-08-31 "how can i do action?") ────────────────
  // Map-to-Item-Master, the Rate Contract modal and the S7 toggle are shared
  // with the Rates Board via useRateActions (mam 2026-09-05: the board's
  // cards open the same actions on click). One implementation, two screens.
  const { openMap, openQuotes, toggleS7, modals } = useRateActions({ onChanged: load });

  // Need-from / need-till, edited straight in the S1 cell. This is the one
  // thing the old Order Planning table did that this view could not, so it
  // moves here rather than being lost when that table goes. Same endpoint the
  // old table used, keyed on the SAME po_items id — it creates the PO's plan
  // on the fly, so a bare item can be dated in one action.
  const saveNeedDates = async (row, patch) => {
    try {
      await api.put(`/orders/planning-itemwise/${row.id}`, {
        planned_start: patch.need_date !== undefined ? (patch.need_date || null) : (row.need_date || null),
        planned_end: patch.need_till !== undefined ? (patch.need_till || null) : (row.need_till || null),
      });
      setData(d => d && { ...d, rows: d.rows.map(x => (x.id === row.id ? { ...x, ...patch } : x)) });
    } catch (e) { toast.error(e.response?.data?.error || 'Could not save the date'); }
  };

  const pages = data ? Math.max(1, Math.ceil(data.total / data.per)) : 1;

  return (
    <div className="space-y-4">
      {!embedded && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h1 className="text-2xl font-bold">Item-wise Rates</h1>
            <p className="text-sm text-gray-500">SOP-05 · every item's own journey — package → quotes → finalise → rate contract</p>
          </div>
          <div className="flex items-center gap-2">
            <Link to="/rates-board" className="btn btn-secondary text-xs">📊 Rates Board</Link>
            <button onClick={load} className="btn btn-secondary text-xs flex items-center gap-1"><FiRefreshCw size={13} /> Refresh</button>
          </div>
        </div>
      )}

      <div className="card p-3 flex items-center gap-2">
        <FiSearch className="text-gray-400" />
        <input className="input flex-1" placeholder="Search item / code / PO / client…"
          value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} />
        {data && <span className="text-xs text-gray-500 whitespace-nowrap">{data.total} item(s)</span>}
      </div>

      {err && <p className="text-red-600 text-sm">{err}</p>}
      {!data ? <p className="text-gray-400 text-sm p-6 text-center">Loading items…</p> : (
        <div className="card p-0 overflow-x-auto">
          <table className="w-full text-xs min-w-[1100px]">
            <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase sticky top-0">
              <tr>
                <th className="text-left p-2">Item</th>
                <th className="text-left p-2 w-32">PO / Client</th>
                <th className="text-center p-2 w-44">S1 · Package<br />(need from → till)</th>
                <th className="text-center p-2 w-20">S2-S3<br />Quotes</th>
                <th className="text-center p-2 w-24">Estimate</th>
                <th className="text-center p-2 w-32">S4-S6 · Rate Contract</th>
                <th className="text-center p-2 w-20">S5 · MD</th>
                <th className="text-center p-2 w-24">S7 · Long<br />Delivery</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map(r => (
                <tr key={r.id} className="border-t hover:bg-gray-50">
                  <td className="p-2">
                    <div className="font-medium max-w-[380px] truncate" title={r.description}>{r.description}</div>
                    <div className="text-[10px] text-gray-400 flex items-center gap-1.5">
                      {r.item_code
                        ? <button onClick={() => openMap(r)} className="text-indigo-600 font-semibold hover:underline" title="Change the Item Master mapping">[{r.item_code}]</button>
                        : <button onClick={() => openMap(r)} className="px-1.5 py-0.5 rounded bg-red-600 text-white font-bold hover:bg-red-700" title="Link this line to the Item Master">🔗 map</button>}
                      <span>· {r.quantity} {r.unit || ''}</span>
                    </div>
                  </td>
                  <td className="p-2">
                    <div className="font-semibold truncate max-w-[120px]" title={r.po_number}>{r.po_number || '—'}</div>
                    <div className="text-[10px] text-gray-400 truncate max-w-[120px]">{r.client_name || ''}</div>
                  </td>
                  <td className="text-center p-2">
                    {r.po_id ? (
                      <div className="flex flex-col gap-1 items-center">
                        <input type="date" className="input text-[10px] py-0.5 px-1 w-32" value={r.need_date || ''}
                          onChange={e => saveNeedDates(r, { need_date: e.target.value })}
                          title="Date the site will FIRST need this item (SOP-05.1)" />
                        <input type="date" className="input text-[10px] py-0.5 px-1 w-32" value={r.need_till || ''}
                          onChange={e => saveNeedDates(r, { need_till: e.target.value })}
                          title="Date the site needs it BY" />
                      </div>
                    ) : <Chip on={false} label="NO PO" title="No purchase order linked to this line" />}
                  </td>
                  <td className="text-center p-2">
                    <button onClick={() => openQuotes(r)} title="Enter the 3 vendor quotes / finalise — SOP-05.2-05.6" className="hover:opacity-75">
                      <span className={`font-bold ${r.quotes >= 3 ? 'text-emerald-700' : r.quotes > 0 ? 'text-amber-700' : 'text-blue-600 underline'}`}>{r.quotes}/3</span>
                      <div className="text-[9px] text-gray-400">{r.quotes >= 3 ? 'compare ready' : r.quotes > 0 ? 'enquiry partial' : '+ enter quotes'}</div>
                    </button>
                  </td>
                  <td className="text-center p-2 text-gray-600">{+r.estimate_rate > 0 ? `Rs ${(+r.estimate_rate).toLocaleString()}` : '—'}</td>
                  <td className="text-center p-2">
                    {+r.final_rate > 0 ? (
                      <button onClick={() => openQuotes(r)} className="hover:opacity-75" title="Open the Rate Contract — edit quotes / final">
                        <div className="font-bold text-emerald-700">Rs {(+r.final_rate).toLocaleString()} 🔒</div>
                        <div className="text-[9px] text-gray-400 truncate max-w-[120px]" title={r.final_vendor_name}>{r.final_vendor_name || ''} {r.finalized_at ? `· ${String(r.finalized_at).slice(0, 10)}` : ''}</div>
                      </button>
                    ) : (
                      <button onClick={() => openQuotes(r)} className="text-[10px] px-2 py-1 rounded bg-emerald-600 text-white font-bold hover:bg-emerald-700" title="Finalise the vendor + rate — SOP-05.4-05.6">₹ Finalise</button>
                    )}
                  </td>
                  <td className="text-center p-2">
                    {r.stage.md
                      ? <Chip on color="red" label="→ MD SIR" title={`Final Rs ${(+r.final_rate).toLocaleString()} is ABOVE the estimate Rs ${(+r.estimate_rate).toLocaleString()} — SOP-05.5, MD sees only the costly ones`} />
                      : +r.final_rate > 0 ? <Chip on label="WITHIN ✓" title="Locked on its own — within estimate" /> : <span className="text-gray-300">—</span>}
                  </td>
                  <td className="text-center p-2">
                    <button onClick={() => toggleS7(r)}
                      className={`text-[10px] px-2 py-1 rounded font-bold ${r.long_delivery ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-500 hover:bg-gray-200'}`}
                      title={r.long_delivery ? 'Flagged — order today (click to unflag)' : 'Flag as long-delivery item (SOP-05.7)'}>
                      {r.long_delivery ? '🚚 ORDER TODAY' : 'flag'}
                    </button>
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && <tr><td colSpan={8} className="text-center py-10 text-gray-400">No items found</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {/* Map-to-Item-Master + Rate Contract modals — shared with the Rates Board. */}
      {modals}

      {data && pages > 1 && (
        <div className="flex items-center justify-center gap-3 text-sm">
          <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="btn btn-secondary text-xs disabled:opacity-40"><FiChevronLeft /></button>
          <span className="text-gray-500">Page {page} / {pages}</span>
          <button disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="btn btn-secondary text-xs disabled:opacity-40"><FiChevronRight /></button>
        </div>
      )}
    </div>
  );
}
