import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// PO/FOC Stripped (mam 2026-06-09). Horizontal layout: each PO item is one
// row (item + qty + rate + labour + margin + TPA), with FOC items (type=FOC,
// max 10) flowing side-by-side beneath it.
// TPA = (PO Rate×Qty + Σ FOC Rate×Qty + Labour) × (1 + margin%).

const MARGINS = [10, 20, 30, 40, 50, 75, 100];
const MAX_FOC = 10;
const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const blankFoc = () => ({ item_id: null, name: '', qty: 1, rate: 0 });
const blankRow = () => ({ po_item_id: null, po_name: '', po_rate: 0, qty: 1, focs: [], margin: 30, labour: 0 });

const Lbl = ({ children }) => (
  <div className="text-[9px] font-semibold uppercase tracking-wide text-gray-400 mb-0.5">{children}</div>
);

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
    if ((r.focs || []).length >= MAX_FOC) { toast.error(`Max ${MAX_FOC} FOC items per item`); return r; }
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
    <div className="space-y-4 pb-24">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">📦 PO/FOC Stripped</h1>
          <p className="text-sm text-gray-500">One PO item per row — attach up to {MAX_FOC} FOC items, add labour and a margin. TPA builds automatically.</p>
        </div>
        <div className="text-right bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-2">
          <div className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">Total TPA</div>
          <div className="text-2xl font-bold text-emerald-700">₹{fmt(totals.tpa)}</div>
          <div className="text-[10px] text-gray-400">cost ₹{fmt(totals.cost)}</div>
        </div>
      </div>

      {/* One horizontal row per PO item */}
      {rows.map((row, i) => {
        const c = calc(row);
        const focCount = (row.focs || []).length;
        return (
          <div key={i} className="card p-3">
            {/* Main horizontal line */}
            <div className="flex items-end gap-3 flex-wrap">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-sm font-bold shrink-0">{i + 1}</span>
              <div className="flex-1 min-w-[220px]">
                <Lbl>PO Item (type to search)</Lbl>
                <SearchableSelect options={poItems} value={row.po_item_id} valueKey="id"
                  displayKey="display_name" placeholder="Search PO items…" onChange={opt => pickPo(i, opt)} />
              </div>
              <div className="w-16">
                <Lbl>Qty</Lbl>
                <input className="input text-right py-1.5" type="number" min="1" value={row.qty || ''}
                  onChange={e => patchRow(i, { qty: e.target.value })} />
              </div>
              <div className="w-24">
                <Lbl>PO Rate ₹</Lbl>
                <input className="input text-right py-1.5" type="number" min="0" value={row.po_rate || ''}
                  onChange={e => patchRow(i, { po_rate: e.target.value })} />
              </div>
              <div className="w-24">
                <Lbl>Labour ₹</Lbl>
                <input className="input text-right py-1.5" type="number" min="0" value={row.labour || ''}
                  onChange={e => patchRow(i, { labour: e.target.value })} placeholder="0" />
              </div>
              <div className="w-20">
                <Lbl>Margin %</Lbl>
                <select className="select py-1.5" value={row.margin} onChange={e => patchRow(i, { margin: +e.target.value })}>
                  {MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}
                </select>
              </div>
              <div className="text-right min-w-[96px]">
                <Lbl>TPA ₹</Lbl>
                <div className="text-lg font-bold text-emerald-700 leading-tight">{fmt(c.tpa)}</div>
                <div className="text-[9px] text-gray-400">cost {fmt(c.cost)}</div>
              </div>
              <button type="button" title="Remove this PO item"
                onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [blankRow()])}
                className="text-red-400 hover:text-red-600 mb-1.5"><FiTrash2 size={16} /></button>
            </div>

            {/* FOC items — flowing side by side */}
            <div className="mt-2 pt-2 border-t border-gray-100 flex items-end gap-2 flex-wrap">
              <span className="text-[11px] font-semibold text-gray-500 mb-2 whitespace-nowrap">FOC ({focCount}/{MAX_FOC}):</span>
              {(row.focs || []).map((f, fi) => (
                <div key={fi} className="inline-flex items-end gap-1 border border-gray-200 rounded-lg px-2 py-1 bg-gray-50">
                  <div className="w-40">
                    <Lbl>FOC item</Lbl>
                    <SearchableSelect options={focItems} value={f.item_id} valueKey="id"
                      displayKey="display_name" placeholder="Search FOC…" onChange={opt => pickFoc(i, fi, opt)} />
                  </div>
                  <div className="w-12">
                    <Lbl>Qty</Lbl>
                    <select className="select py-1.5 text-xs" value={f.qty} onChange={e => patchFoc(i, fi, { qty: +e.target.value })}>
                      {Array.from({ length: 10 }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                    </select>
                  </div>
                  <div className="w-16">
                    <Lbl>Rate ₹</Lbl>
                    <input className="input text-right py-1.5 text-xs" type="number" min="0" value={f.rate || ''}
                      onChange={e => patchFoc(i, fi, { rate: e.target.value })} placeholder="0" />
                  </div>
                  <button type="button" className="text-red-300 hover:text-red-500 mb-1.5" onClick={() => removeFoc(i, fi)}><FiTrash2 size={12} /></button>
                </div>
              ))}
              <button type="button" disabled={focCount >= MAX_FOC} onClick={() => addFoc(i)}
                className={`text-xs flex items-center gap-1 px-2 py-1.5 rounded border mb-0.5 ${focCount >= MAX_FOC ? 'text-gray-300 border-gray-100' : 'text-indigo-600 border-indigo-200 hover:bg-indigo-50'}`}>
                <FiPlus size={13} /> Add FOC
              </button>
            </div>
          </div>
        );
      })}

      {/* Actions */}
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={() => setRows(rs => [...rs, blankRow()])} className="btn btn-secondary flex items-center gap-1">
          <FiPlus size={15} /> Add PO Item
        </button>
        <button type="button" onClick={exportSheet} className="btn btn-primary flex items-center gap-1">
          <FiDownload size={15} /> Export (Excel)
        </button>
      </div>

      <p className="text-xs text-gray-400">
        TPA = (PO Rate × Qty + Σ FOC Rate × Qty + Labour Rate) × (1 + Margin%). Item Name lists PO-type items; FOC lists FOC-type items (max {MAX_FOC} per PO item). Rates default from the item and stay editable.
      </p>
    </div>
  );
}
