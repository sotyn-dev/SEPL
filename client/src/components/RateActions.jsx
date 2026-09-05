// SOP-05 rate actions, shared (mam 2026-09-05: "click open first photo
// action so this flowboard good working like this all action show on click").
//
// The Rate Contract modal (3 vendor quotes → finalise → lock), the
// Map-to-Item-Master modal and the S7 long-delivery toggle used to live only
// inside the Item-wise Rates register. The Rates Board needs the SAME actions
// on its cards, so they live here once and both screens use this hook —
// one implementation, so a fix on one side cannot leave the other behind.
//
// Usage:  const { openMap, openQuotes, toggleS7, modals } = useRateActions({ onChanged });
//         …  <button onClick={() => openQuotes(row)} />  …  {modals}
// `row` needs: id (po_items id), item_master_id, item_code, description,
// estimate_rate, vendor1..3 _name/_rate, final_rate, final_vendor_name,
// long_delivery — exactly the row shape /procurement/rates-items returns,
// and what the board's item cards now carry too.
import { useState, useRef } from 'react';
import toast from 'react-hot-toast';
import api from '../api';
import Modal from './Modal';
import SearchableSelect from './SearchableSelect';

export function useRateActions({ onChanged } = {}) {
  const changed = () => { try { onChanged && onChanged(); } catch { /* reload is best-effort */ } };

  // 1. map → link the BOQ line to its Item Master
  const [mapRow, setMapRow] = useState(null);
  // The Item Master list is fetched the first time the Map modal opens,
  // not on mount — the board mounts this hook on every visit and most
  // visits never map anything (review 2026-09-05).
  const [masters, setMasters] = useState([]);
  const mastersLoaded = useRef(false);
  const ensureMasters = () => {
    if (mastersLoaded.current) return;
    mastersLoaded.current = true;
    api.get('/item-master/dropdown').then(r => setMasters(r.data || [])).catch(() => { mastersLoaded.current = false; });
  };
  const openMap = (row) => { ensureMasters(); setMapRow(row); };
  const saveMap = async (mi) => {
    try {
      await api.put(`/procurement/rates-items/map/${mapRow.id}`, { item_master_id: mi?.id || null });
      toast.success(mi ? `Mapped to [${mi.item_code}]` : 'Mapping cleared');
      const row = mapRow;
      setMapRow(null); changed();
      // Map → straight into the Rate Contract when the line was unmapped
      // (one click, not "map, then click the card again").
      if (mi && !row.item_master_id) openQuotes({ ...row, item_master_id: mi.id, item_code: mi.item_code });
    } catch (e) { toast.error(e.response?.data?.error || 'Map failed'); }
  };

  // 2. ₹ Quotes → S2-S6: the 3 vendor quotes + finalise the Rate Contract
  const [quoteRow, setQuoteRow] = useState(null);
  const [qf, setQf] = useState({});
  const openQuotes = (row) => {
    if (!row.item_master_id) { toast.error('Map the item to the Item Master first'); openMap(row); return; }
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
      setQuoteRow(null); changed();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  // 3. S7 — flag / unflag long delivery on the Item Master
  const toggleS7 = async (row) => {
    if (!row.item_master_id) return toast.error('Map this item to the Item Master first');
    try {
      await api.put(`/procurement/rates-items/long-delivery/${row.item_master_id}`, { flag: row.long_delivery ? 0 : 1 });
      toast.success(row.long_delivery ? 'Long-delivery flag removed' : '🚚 Flagged long delivery — order today (SOP-05.7)');
      changed();
    } catch (e) { toast.error(e.response?.data?.error || 'Toggle failed'); }
  };

  const modals = (
    <>
      {/* Map-to-Item-Master modal */}
      <Modal isOpen={!!mapRow} onClose={() => setMapRow(null)} title="Map to Item Master">
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
    </>
  );

  return { openMap, openQuotes, toggleS7, modals };
}
