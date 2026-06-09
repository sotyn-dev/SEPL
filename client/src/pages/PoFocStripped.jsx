import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiTrash2, FiDownload } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';

// PO/FOC Stripped (mam 2026-06-09).
// Each card = one PO item (type=PO) + up to 10 FOC items (type=FOC) + manual
// labour + a margin %.  TPA = (PO Rate×Qty + Σ FOC Rate×Qty + Labour) × (1 + margin%).

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

  const Field = ({ label, children }) => (
    <div>
      <label className="block text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-0.5">{label}</label>
      {children}
    </div>
  );

  return (
    <div className="max-w-4xl mx-auto space-y-4 pb-24">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">📦 PO/FOC Stripped</h1>
          <p className="text-sm text-gray-500">Pick a PO item, attach up to {MAX_FOC} FOC items, add labour and a margin — TPA builds automatically.</p>
        </div>
        <div className="text-right bg-emerald-50 border border-emerald-100 rounded-xl px-4 py-2">
          <div className="text-[10px] uppercase tracking-wide text-emerald-600 font-semibold">Total TPA</div>
          <div className="text-2xl font-bold text-emerald-700">₹{fmt(totals.tpa)}</div>
          <div className="text-[10px] text-gray-400">cost ₹{fmt(totals.cost)}</div>
        </div>
      </div>

      {/* Cards — one per PO item */}
      {rows.map((row, i) => {
        const c = calc(row);
        const focCount = (row.focs || []).length;
        return (
          <div key={i} className="card p-4 space-y-3">
            {/* Card header */}
            <div className="flex items-center justify-between gap-2 border-b border-gray-100 pb-2">
              <span className="inline-flex items-center justify-center w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 text-sm font-bold">{i + 1}</span>
              <div className="flex items-center gap-4">
                <div className="text-right">
                  <span className="text-[10px] uppercase tracking-wide text-gray-400">TPA</span>
                  <span className="ml-2 text-lg font-bold text-emerald-700">₹{fmt(c.tpa)}</span>
                  <span className="ml-2 text-[11px] text-gray-400">cost ₹{fmt(c.cost)}</span>
                </div>
                <button type="button" title="Remove this PO item"
                  onClick={() => setRows(rs => rs.length > 1 ? rs.filter((_, idx) => idx !== i) : [blankRow()])}
                  className="text-red-400 hover:text-red-600"><FiTrash2 size={16} /></button>
              </div>
            </div>

            {/* PO item picker */}
            <Field label="PO Item (type to search)">
              <SearchableSelect options={poItems} value={row.po_item_id} valueKey="id"
                displayKey="display_name" placeholder="Search PO items…"
                onChange={opt => pickPo(i, opt)} />
            </Field>

            {/* Numbers grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Field label="Qty">
                <input className="input text-right" type="number" min="1" value={row.qty || ''}
                  onChange={e => patchRow(i, { qty: e.target.value })} />
              </Field>
              <Field label="PO Rate ₹">
                <input className="input text-right" type="number" min="0" value={row.po_rate || ''}
                  onChange={e => patchRow(i, { po_rate: e.target.value })} />
              </Field>
              <Field label="Labour ₹">
                <input className="input text-right" type="number" min="0" value={row.labour || ''}
                  onChange={e => patchRow(i, { labour: e.target.value })} placeholder="0" />
              </Field>
              <Field label="Margin %">
                <select className="select" value={row.margin} onChange={e => patchRow(i, { margin: +e.target.value })}>
                  {MARGINS.map(m => <option key={m} value={m}>{m}%</option>)}
                </select>
              </Field>
            </div>

            {/* FOC items */}
            <div className="bg-gray-50 rounded-lg p-3 border border-gray-100">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-600">FOC Items <span className="text-gray-400">({focCount}/{MAX_FOC})</span></span>
                <button type="button" disabled={focCount >= MAX_FOC}
                  onClick={() => addFoc(i)}
                  className={`text-xs flex items-center gap-1 px-2 py-1 rounded ${focCount >= MAX_FOC ? 'text-gray-300' : 'text-indigo-600 hover:bg-indigo-50'}`}>
                  <FiPlus size={13} /> Add FOC
                </button>
              </div>
              {focCount === 0 && <div className="text-[11px] text-gray-400 italic">No FOC items. Click “Add FOC” to attach (up to {MAX_FOC}).</div>}
              <div className="space-y-2">
                {(row.focs || []).map((f, fi) => (
                  <div key={fi} className="flex items-center gap-2">
                    <span className="text-[10px] text-gray-400 w-4">{fi + 1}</span>
                    <div className="flex-1 min-w-0">
                      <SearchableSelect options={focItems} value={f.item_id} valueKey="id"
                        displayKey="display_name" placeholder="Search FOC item…"
                        onChange={opt => pickFoc(i, fi, opt)} />
                    </div>
                    <div className="w-16">
                      <select className="select text-xs py-1.5" value={f.qty}
                        onChange={e => patchFoc(i, fi, { qty: +e.target.value })} title="Qty 1–10">
                        {Array.from({ length: 10 }, (_, n) => <option key={n + 1} value={n + 1}>{n + 1}</option>)}
                      </select>
                    </div>
                    <div className="w-24">
                      <input className="input text-right text-xs py-1.5" type="number" min="0" value={f.rate || ''}
                        onChange={e => patchFoc(i, fi, { rate: e.target.value })} placeholder="rate" title="Rate (from item)" />
                    </div>
                    <button type="button" className="text-red-300 hover:text-red-500"
                      onClick={() => removeFoc(i, fi)}><FiTrash2 size={13} /></button>
                  </div>
                ))}
              </div>
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
