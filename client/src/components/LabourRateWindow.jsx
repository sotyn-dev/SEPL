// Labour Rate Window — the read-only rate picker used during Work Order
// creation. The official company labour rate reference: HR maintains the
// rates, everyone else reads them here and picks a crew off them.
//
// There is deliberately no way to type a rate in this component, and the
// server re-reads the rate from the master when the line is saved, ignoring
// any rate in the request body — so the read-only-ness is real, not a disabled
// input someone could work around.
import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiSearch, FiInfo, FiPlus, FiX } from 'react-icons/fi';

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });

export default function LabourRateWindow({ isOpen, onClose, onPick, picked = [] }) {
  const [rows, setRows] = useState([]);
  const [filters, setFilters] = useState({ departments: [], trades: [], categories: [], skill_levels: [] });
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState({ search: '', department: '', trade: '', labour_category: '', skill_level: '' });
  // Per-row crew inputs keyed by rate id. Only quantity and days are typed.
  const [crew, setCrew] = useState({});

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    api.get('/labour-rate-master/window')
      .then(r => { setRows(r.data.rows || []); setFilters(r.data.filters || {}); })
      .catch(e => toast.error(e.response?.data?.error || 'Could not load labour rates'))
      .finally(() => setLoading(false));
  }, [isOpen]);

  // Client-side filtering: the active rate set is small (tens of rows), so
  // this keeps typing instant instead of firing a request per keystroke.
  const visible = useMemo(() => {
    const s = q.search.trim().toLowerCase();
    return rows.filter(r => {
      if (q.department && r.department !== q.department) return false;
      if (q.trade && r.trade !== q.trade) return false;
      if (q.labour_category && r.labour_category !== q.labour_category) return false;
      if (q.skill_level && r.skill_level !== q.skill_level) return false;
      if (!s) return true;
      return [r.labour_category, r.trade, r.department, r.skill_level, r.labour_type]
        .filter(Boolean).some(v => String(v).toLowerCase().includes(s));
    });
  }, [rows, q]);

  const setField = (id, field, value) =>
    setCrew(prev => ({ ...prev, [id]: { ...(prev[id] || {}), [field]: value } }));

  const add = (r) => {
    const c = crew[r.id] || {};
    const quantity = Number(c.quantity);
    const days = Number(c.days);
    if (!(quantity > 0)) return toast.error('Enter the number of labourers');
    if (!(days > 0)) return toast.error('Enter the number of days');
    onPick({
      rate_id: r.id, quantity, days,
      overtime_hours: Number(c.overtime_hours) || 0,
      // For showing a total before saving only. The server re-reads the real
      // rate from the master and ignores this.
      preview: { ...r, quantity, days, amount: r.standard_rate * quantity * days },
    });
    setCrew(prev => ({ ...prev, [r.id]: {} }));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Labour Rate Window" xwide>
      <div className="space-y-3">
        <div className="flex items-start gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-900">
          <FiInfo className="mt-0.5 shrink-0" />
          <span>
            Current labour rates maintained by HR. Rates are read-only here — pick a category and
            enter how many labourers and days. Work Orders keep the rate they were created with,
            even if HR revises it later.
          </span>
        </div>

        <div className="flex flex-wrap gap-2 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="label" htmlFor="lrw-search">Search</label>
            <div className="relative">
              <FiSearch className="absolute left-2 top-2.5 text-gray-400" />
              <input id="lrw-search" className="input w-full pl-8" placeholder="Category, trade, department"
                value={q.search} onChange={e => setQ({ ...q, search: e.target.value })} />
            </div>
          </div>
          {[['department', 'Department', filters.departments],
            ['trade', 'Trade', filters.trades],
            ['labour_category', 'Category', filters.categories],
            ['skill_level', 'Skill level', filters.skill_levels]].map(([key, label, opts]) => (
            <div key={key}>
              <label className="label" htmlFor={`lrw-${key}`}>{label}</label>
              <select id={`lrw-${key}`} className="input" value={q[key]}
                onChange={e => setQ({ ...q, [key]: e.target.value })}>
                <option value="">All</option>
                {(opts || []).map(o => <option key={o} value={o}>{o}</option>)}
              </select>
            </div>
          ))}
          {Object.values(q).some(Boolean) && (
            <button className="btn text-sm flex items-center gap-1"
              onClick={() => setQ({ search: '', department: '', trade: '', labour_category: '', skill_level: '' })}>
              <FiX size={14} /> Clear
            </button>
          )}
        </div>

        <div className="card p-0 overflow-x-auto max-h-[50vh] overflow-y-auto">
          <table className="min-w-full">
            <thead><tr className="bg-gray-50 text-xs text-gray-600 sticky top-0">
              <th className="px-3 py-2 text-left font-semibold">Labour Category</th>
              <th className="px-3 py-2 text-left font-semibold">Trade</th>
              <th className="px-3 py-2 text-left font-semibold">Department</th>
              <th className="px-3 py-2 text-center font-semibold">Unit</th>
              <th className="px-3 py-2 text-right font-semibold">Standard Rate</th>
              <th className="px-3 py-2 text-right font-semibold">Overtime Rate</th>
              <th className="px-3 py-2 text-left font-semibold">Effective</th>
              <th className="px-3 py-2 text-center font-semibold">Status</th>
              <th className="px-3 py-2 text-center font-semibold">Labourers</th>
              <th className="px-3 py-2 text-center font-semibold">Days</th>
              <th className="px-3 py-2 text-right font-semibold">Line Total</th>
              <th className="px-3 py-2 text-center font-semibold">Add</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {loading && <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-500">Loading…</td></tr>}
              {!loading && visible.length === 0 && (
                <tr><td colSpan={12} className="px-3 py-8 text-center text-gray-500">
                  {rows.length === 0
                    ? 'No active labour rates yet. HR adds them on the Labour Rate Master tab.'
                    : 'No rates match these filters.'}
                </td></tr>
              )}
              {visible.map(r => {
                const c = crew[r.id] || {};
                const lineTotal = (Number(c.quantity) || 0) * (Number(c.days) || 0) * r.standard_rate;
                const already = picked.filter(p => p.rate_id === r.id).length;
                return (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-3 py-2">
                      <div className="text-sm font-medium">{r.labour_category}</div>
                      {r.skill_level && <div className="text-xs text-gray-500">{r.skill_level}</div>}
                    </td>
                    <td className="px-3 py-2 text-sm">{r.trade || '—'}</td>
                    <td className="px-3 py-2 text-sm">{r.department || '—'}</td>
                    <td className="px-3 py-2 text-center text-xs">
                      <span className="inline-flex px-2 py-0.5 rounded bg-gray-100 text-gray-700">{r.unit}</span>
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold">{money(r.standard_rate)}</td>
                    <td className="px-3 py-2 text-right text-sm text-gray-600">
                      {r.overtime_rate ? money(r.overtime_rate) : '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-gray-600">
                      {r.effective_from}{r.effective_to ? ` → ${r.effective_to}` : ''}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800">Active</span>
                    </td>
                    <td className="px-3 py-2">
                      <input className="input w-20 text-center" inputMode="numeric" placeholder="0"
                        aria-label={`Labourers for ${r.labour_category}`}
                        value={c.quantity ?? ''} onChange={e => setField(r.id, 'quantity', e.target.value)} />
                    </td>
                    <td className="px-3 py-2">
                      <input className="input w-20 text-center" inputMode="numeric" placeholder="0"
                        aria-label={`Days for ${r.labour_category}`}
                        value={c.days ?? ''} onChange={e => setField(r.id, 'days', e.target.value)} />
                    </td>
                    <td className="px-3 py-2 text-right text-sm font-semibold text-emerald-700">
                      {lineTotal > 0 ? money(lineTotal) : '—'}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button className="btn btn-primary text-xs inline-flex items-center gap-1"
                        onClick={() => add(r)} title="Add this category to the Work Order">
                        <FiPlus size={12} /> Add
                      </button>
                      {already > 0 && <div className="text-[10px] text-gray-500 mt-0.5">added {already}×</div>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div className="flex justify-between items-center">
          <p className="text-xs text-gray-500">
            {visible.length} of {rows.length} active rate(s). Rates are maintained by HR only.
          </p>
          <button className="btn" onClick={onClose}>Done</button>
        </div>
      </div>
    </Modal>
  );
}
