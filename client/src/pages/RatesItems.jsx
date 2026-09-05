// SOP-05 ITEM-WISE register (mam 2026-08-31: "i need item wise system") —
// one row per BOQ item of the booked orders, each carrying its own stage
// status: S1 package date → S2/S3 vendor quotes (3-quote rule) → S4/S5
// finalise + above-estimate→MD → S6 rate contract → S7 long-delivery flag.
// Feeds from GET /procurement/rates-items; S7 toggles on the Item Master.
import { useState, useEffect, useCallback } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
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
  // 1. map → link the BOQ line to its Item Master (inline modal)
  const [mapRow, setMapRow] = useState(null);
  const [masters, setMasters] = useState([]);
  useEffect(() => { api.get('/item-master/dropdown').then(r => setMasters(r.data || [])).catch(() => {}); }, []);
  const saveMap = async (mi) => {
    try {
      await api.put(`/procurement/rates-items/map/${mapRow.id}`, { item_master_id: mi?.id || null });
      toast.success(mi ? `Mapped to [${mi.item_code}]` : 'Mapping cleared');
      setMapRow(null); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Map failed'); }
  };
  // 2. ⚡ Plan → S1: create the order plan for the item's PO (items auto-inherit)
  const makePlan = async (row) => {
    if (!row.po_id) return toast.error('This item has no PO — attach it via Orders first');
    try {
      await api.post('/orders/planning', { po_id: row.po_id });
      toast.success('⚡ Plan created — the PO\'s items joined it automatically (set dates in Order Planning)');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Plan failed'); }
  };
  // 3. ₹ Quotes → S2-S6: enter the 3 vendor quotes + finalise the Rate Contract
  const [quoteRow, setQuoteRow] = useState(null);
  const [qf, setQf] = useState({});
  const openQuotes = (row) => {
    if (!row.item_master_id) return toast.error('Map the item to the Item Master first');
    setQuoteRow(row);
    setQf({
      vendor1_name: row.vendor1_name || '', vendor1_rate: row.vendor1_rate || '',
      vendor2_name: row.vendor2_name || '', vendor2_rate: row.vendor2_rate || '',
      vendor3_name: row.vendor3_name || '', vendor3_rate: row.vendor3_rate || '',
      final_rate: row.final_rate || '', final_vendor_name: row.final_vendor_name || '',
    });
  };
  const saveQuotes = async () => {
    try {
      const r = await api.put(`/procurement/rates-items/quotes/${quoteRow.item_master_id}`, qf);
      toast.success(r.data.locked ? '🔒 Rate Contract locked for the project' : 'Quotes saved — finalise when all 3 are in');
      setQuoteRow(null); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

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

  const toggleS7 = async (row) => {
    if (!row.item_master_id) return toast.error('Map this item to the Item Master first (Edit PO → Map item)');
    try {
      await api.put(`/procurement/rates-items/long-delivery/${row.item_master_id}`, { flag: row.long_delivery ? 0 : 1 });
      toast.success(row.long_delivery ? 'Long-delivery flag removed' : '🚚 Flagged long delivery — order today (SOP-05.7)');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Toggle failed'); }
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
                        ? <button onClick={() => setMapRow(r)} className="text-indigo-600 font-semibold hover:underline" title="Change the Item Master mapping">[{r.item_code}]</button>
                        : <button onClick={() => setMapRow(r)} className="px-1.5 py-0.5 rounded bg-red-600 text-white font-bold hover:bg-red-700" title="Link this line to the Item Master">🔗 map</button>}
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

      {/* Map-to-Item-Master modal */}
      <Modal isOpen={!!mapRow} onClose={() => setMapRow(null)} title={`Map to Item Master`}>
        {mapRow && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">{mapRow.description}</p>
            <SearchableSelect
              options={masters.map(mi => ({ id: mi.id, label: `[${mi.item_code}] ${mi.display_name}`, ...mi }))}
              value={mapRow.item_master_id || null}
              valueKey="id" displayKey="label" placeholder="🔗 Search the Item Master…"
              buttonClassName="input text-left text-sm px-3 py-2 w-full flex items-center justify-between gap-1 cursor-pointer"
              onChange={(mi) => saveMap(mi)}
            />
            <p className="text-[10px] text-gray-400">Picking an item saves immediately. Rates lock per Item Master — the same contract serves every order of this item.</p>
          </div>
        )}
      </Modal>

      {/* Quotes + Rate Contract modal (SOP-05 S2 → S6) */}
      <Modal isOpen={!!quoteRow} onClose={() => setQuoteRow(null)} title={`Rate Contract — ${quoteRow?.item_code ? `[${quoteRow.item_code}]` : ''}`} wide>
        {quoteRow && (
          <div className="space-y-3">
            <p className="text-xs text-gray-500">{quoteRow.description} · our estimate: <b>{+quoteRow.estimate_rate > 0 ? `Rs ${(+quoteRow.estimate_rate).toLocaleString()}` : '—'}</b></p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              {[1, 2, 3].map(n => (
                <div key={n} className="border rounded-lg p-2.5 space-y-1.5">
                  <p className="text-[10px] font-bold text-gray-500 uppercase">Vendor {n}</p>
                  <input className="input text-xs" placeholder="Vendor name" value={qf[`vendor${n}_name`] || ''}
                    onChange={e => setQf(f => ({ ...f, [`vendor${n}_name`]: e.target.value }))} />
                  <input className="input text-xs" type="number" placeholder="Rate (full project qty)" value={qf[`vendor${n}_rate`] || ''}
                    onChange={e => setQf(f => ({ ...f, [`vendor${n}_rate`]: e.target.value }))} />
                </div>
              ))}
            </div>
            <div className="border border-emerald-300 bg-emerald-50 rounded-lg p-3 grid grid-cols-1 sm:grid-cols-3 gap-3 items-end">
              <div>
                <label className="label">Final Rate (lock 🔒)</label>
                <input className="input" type="number" value={qf.final_rate || ''}
                  onChange={e => setQf(f => ({ ...f, final_rate: e.target.value }))} />
              </div>
              <div>
                <label className="label">Final Vendor</label>
                <select className="select" value={qf.final_vendor_name || ''} onChange={e => setQf(f => ({ ...f, final_vendor_name: e.target.value }))}>
                  <option value="">Select</option>
                  {[qf.vendor1_name, qf.vendor2_name, qf.vendor3_name].filter(Boolean).map(v => <option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              <div className="text-[11px]">
                {+qf.final_rate > 0 && +quoteRow.estimate_rate > 0 && (
                  +qf.final_rate > +quoteRow.estimate_rate
                    ? <span className="text-red-700 font-bold">⏳ ABOVE estimate — goes to MD sir (SOP-05.5)</span>
                    : <span className="text-emerald-700 font-bold">✓ Within estimate — locks on its own</span>
                )}
              </div>
            </div>
            <p className="text-[10px] text-gray-400">Big quantity = better rate — quote for the FULL project quantity (SOP-05.2). Once locked, no rate talk at indent time (SOP-05.6).</p>
            <div className="flex justify-end gap-3">
              <button onClick={() => setQuoteRow(null)} className="btn btn-secondary">Cancel</button>
              <button onClick={saveQuotes} className="btn btn-primary">{+qf.final_rate > 0 ? '🔒 Save & Lock Contract' : 'Save Quotes'}</button>
            </div>
          </div>
        )}
      </Modal>

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
