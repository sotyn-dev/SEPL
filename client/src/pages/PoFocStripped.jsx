import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// PO/FOC Stripped (mam 2026-06-09).
// Each row = one PO item (from type=PO) + up to 10 FOC items (type=FOC) +
// manual labour + a margin %.  TPA = (PO Rate×Qty + Σ FOC Rate×Qty + Labour)
// × (1 + margin%).  FOC items capped at 10 per row.

const MARGINS = [10, 20, 30, 40, 50, 75, 100];
const MAX_FOC = 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const blankFoc = () => ({ item_id: null, name: '', qty: 1, rate: 0 });
const blankRow = () => ({ po_item_id: null, po_name: '', po_rate: 0, qty: 1, focs: [], margin: 30, labour: 0 });

export default function PoFocStripped() {
  const [poItems, setPoItems] = useState([]);
  const [focItems, setFocItems] = useState([]);
  const [rows, setRows] = useState([blankRow()]);

  useEffect(() => {
    api.get('/item-master/dropdown?type=PO').then(r => setPoItems(r.data || [])).catch(() => {});
    api.get('/item-master/dropdown?type=FOC').then(r => setFocItems(r.data || [])).catch(() => {});
  }, []);

  const patchRow = (i, patch) => setRows(rs => rs.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  const pickPo = (i, opt) => patchRow(i, opt
    ? { po_item_id: opt.id, po_name: opt.display_name || opt.item_name, po_rate: opt.current_price || 0 }
    : { po_item_id: null, po_name: '', po_rate: 0 });

  const addFoc = (i) => setRows(rs => rs.map((r, idx) => {
    if (idx !== i) return r;
    if ((r.focs || []).length >= MAX_FOC) { toast.error(`Max ${MAX_FOC} FOC items per line`); return r; }
    return { ...r, focs: [...(r.focs || []), blankFoc()] };
  }));
  const patchFoc = (i, fi, patch) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, focs: r.focs.map((f, fj) => fj === fi ? { ...f, ...patch } : f) } : r));
  const removeFoc = (i, fi) => setRows(rs => rs.map((r, idx) => idx === i
    ? { ...r, focs: r.focs.filter((_, fj) => fj !== fi) } : r));
  const pickFoc = (i, fi, opt) => patchFoc(i, fi, opt
    ? { item_id: opt.id, name: opt.display_name || opt.item_name, rate: opt.current_price || 0 }
    : { item_id: null, name: '', rate: 0 });

  const calc = (row) => {
    const poAmt = r2((Number(row.po_rate) || 0) * (Number(row.qty) || 0));
    const focAmt = r2((row.focs || []).reduce((t, f) => t + (Number(f.rate) || 0) * (Number(f.qty) || 0), 0));
    const labour = Number(row.labour) || 0;
    const cost = r2(poAmt + focAmt + labour);
    const margin = Number(row.margin) || 0;
    const tpa = r2(cost * (1 + margin / 100));
    return { poAmt, focAmt, labour, cost, margin, tpa };
  };

  const totals = useMemo(() => rows.reduce((t, r) => {
    const c = calc(r); t.cost += c.cost; t.tpa += c.tpa; return t;
  }, { cost: 0, tpa: 0 }), [rows]);

  const exportSheet = () => {
    const headers = ['PO Item No', 'Item Name', 'Qty', 'PO Rate', 'FOC Items', 'FOC Amount', 'Labour Rate', 'Margin %', 'Cost', 'TPA'];
    const data = rows.filter(r => r.po_name).map((r, idx) => {
      const c = calc(r);
      const focStr = (r.focs || []).filter(f => f.name).map(f => `${f.name} x${f.qty} @${f.rate}`).join(' ; ');
      return [idx + 1, r.po_name, r.qty, r.po_rate, focStr, c.focAmt, c.labour, `${c.margin}%`, c.cost, c.tpa];
    });
    if (!data.length) { toast.error('Add at least one PO item'); return; }
    data.push(['', 'TOTAL', '', '', '', '', '', '', totals.cost, totals.tpa]);
    exportCsv('po-foc-stripped', headers, data);
  };

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">📦 PO/FOC Stripped</h1>
        <p className="text-sm text-gray-500">Pick a PO item, attach up to {MAX_FOC} FOC items, add labour and a margin. TPA builds automatically.</p>
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <th className="p-2">PO Item No</th>
              <th className="p-2 min-w-[240px]">Item Name (PO only)</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-right">PO Rate ₹</th>
              <th className="p-2 min-w-[260px]">FOC Items (max {MAX_FOC})</th>
              <th className="p-2 text-right">Labour ₹</th>
              <th className="p-2 text-center">Margin %</th>
              <th className="p-2 text-right" title="(PO Rate×Qty + Σ FOC + Labour) × (1 + Margin%)">TPA ₹</th>
              <th className="p-2"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => {
              const c = calc(row);
              return (
                <tr key={i} className="border-t border-gray-100 align-top">
                  <td className="p-2 text-gray-400 font-medium">{i + 1}</td>
                  <td className="p-2">
                    <SearchableSelect options={poItems} value={row.po_item_id} valueKey="id"
                      displayKey="display_name" placeholder="Search PO items…"
                      onChange={opt => pickPo(i, opt)} />
                    {row.po_name && <div className="text-[10px] text-gray-400 mt-0.5">rate ₹{fmt(row.po_rate)}</div>}
                  </td>
                  <td className="p-2 w-16">
                    <input className="input text-center py-1" type="number" min="1" value={row.qty || ''}
                      onChange={e => patchRow(i, { qty: e.target.value })} />
                  </td>
                  <td className="p-2 w-24">
                    <input className="input text-right py-1" type="number" min="0" value={row.po_rate || ''}
                      onChange={e => patchRow(i, { po_rate: e.target.value })} />
                  </td>
                  {/* FOC sub-items (up to 10) */}
                  <td className="p-2">
                    <div className="space-y-1">
                      {(row.focs || []).map((f, fi) => (
                        <div key={fi} className="flex items-center gap-1">
                          <div className="w-36">
                            <SearchableSelect options={focItems} value={f.item_id} valueKey="id"
                              displayKey="display_name" placeholder="FOC item…"
                              onChange={opt => pickFoc(i, fi, opt)} />
                          </div>
                          <select className="select py-0.5 text-xs w-14" value={f.qty}
                            onChange={e => patchFoc(i, fi, { qty: +e.target.value })} title="Qty 1-10">
                            {Array.from({ length: 10 }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                          </select>
                          <input className="input text-right py-0.5 text-xs w-16" type="number" min="0"
                            value={f.rate || ''} onChange={e => patchFoc(i, fi, { rate: e.target.value })} title="Rate (from item)" />
                          <button type="button" className="text-red-300 hover:text-red-500"
                            onClick={() => removeFoc(i, fi)}><FiTrash2 size={11} /></button>
                        </div>
                      ))}
                      <button type="button"
                        disabled={(row.focs || []).length >= MAX_FOC}
                        className={`text-[10px] ${(row.focs || []).length >= MAX_FOC ? 'text-gray-300' : 'text-indigo-600 hover:underline'}`}
                        onClick={() => addFoc(i)}>
                        + Add FOC ({(row.focs || []).length}/{MAX_FOC})
                      </button>
                    </div>
                  </td>
                  <td className="p-2 w-24">
                    <input className="input text-right py-1" type="number" min="0" value={row.labour || ''}
                      onChange={e => patchRow(i, { labour: e.target.value })} placeholder="0" />
                  </td>
                  <td className="p-2 w-20">
                    <select className="select py-1" value={row.margin}
                      onChange={e => patchRow(i, { margin: +e.target.value })}>
                      {MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}
                    </select>
                  </td>
                  <td className="p-2 text-right font-bold text-emerald-700">{fmt(c.tpa)}
                    <div className="text-[9px] font-normal text-gray-400">cost {fmt(c.cost)}</div>
                  </td>
                  <td className="p-2">
                    <button type="button" className="text-red-400 hover:text-red-600"
                      onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : rs)}>
                      <FiTrash2 size={15} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-gray-200 bg-gray-50 font-semibold">
              <td className="p-2" colSpan={7} ></td>
              <td className="p-2 text-right text-emerald-700 text-base">{fmt(totals.tpa)}
                <div className="text-[9px] font-normal text-gray-400">cost {fmt(totals.cost)}</div>
              </td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setRows(rs => [...rs, blankRow()])} className="btn btn-secondary text-sm flex items-center gap-1">
          <FiPlus size={14} /> Add PO Item
        </button>
        <button type="button" onClick={exportSheet} className="btn btn-primary text-sm flex items-center gap-1">
          <FiDownload size={14} /> Export (Excel)
        </button>
        <div className="ml-auto text-sm text-gray-600">
          Total TPA <b className="text-emerald-700 text-base">₹{fmt(totals.tpa)}</b>
        </div>
      </div>

      <p className="text-xs text-gray-400">
        Formula: TPA = (PO Rate × Qty + Σ FOC Rate × Qty + Labour Rate) × (1 + Margin%). Item Name lists PO-type items; FOC lists FOC-type items (max {MAX_FOC} per line). PO/FOC rates default from the item but are editable.
      </p>
    </div>
  );
}
