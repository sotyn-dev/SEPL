import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2 } from 'react-icons/fi';

// Labour Rate sheet (mam 2026-06-10) — item-wise labour / sub-contractor
// rates by UOM and category. Seeded from her uploaded sheet; add/edit here.
const UOMS = ['Kg', 'PCS', 'Nos', 'Each', 'Per Ltr', 'mtrs', 'RMT', 'RFT', 'R mtr', 'Per Point'];
const CATEGORIES = ['Low Voltage', 'ELECTRICAL', 'Fire Fighting'];
const RENDER_CAP = 200;
const fmt = (n) => (Number(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 2 });
const blank = () => ({ id: null, item_name: '', rate: '', uom: 'PCS', category: 'Low Voltage' });

export default function LabourRate() {
  const [rows, setRows] = useState([]);
  // Opened from the PO/FOC labour ✎ via ?edit=<name> (auto-opens that item's
  // edit modal) or the ➕ via ?add (opens a blank add modal). ?search= pre-filters.
  const [search, setSearch] = useState(() => { const p = new URLSearchParams(window.location.search); return p.get('search') || p.get('edit') || ''; });
  const [catFilter, setCatFilter] = useState('');
  const [form, setForm] = useState(blank());
  // Add/Edit now open in a modal (mam 2026-06-11: the inline form above the
  // table was a poor interface — match the Item Master add window instead).
  const [modal, setModal] = useState(() => (new URLSearchParams(window.location.search)).has('add'));
  const autoEditName = useRef((new URLSearchParams(window.location.search)).get('edit'));
  const autoEditDone = useRef(false);

  const load = useCallback(() => { api.get('/quotations/labour-rates').then(r => setRows(r.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);
  // Auto-open the Edit modal when launched via ?edit=<name> (the PO/FOC ✎).
  useEffect(() => {
    if (autoEditDone.current || !autoEditName.current || !rows.length) return;
    const r = rows.find(x => String(x.item_name || '').toLowerCase() === String(autoEditName.current).toLowerCase());
    if (r) { setForm({ id: r.id, item_name: r.item_name, rate: r.rate, uom: r.uom || 'PCS', category: r.category || 'Low Voltage' }); setModal(true); autoEditDone.current = true; }
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (catFilter) list = list.filter(r => r.category === catFilter);
    const q = search.toLowerCase().trim();
    if (q) { const toks = q.split(/\s+/).filter(Boolean); list = list.filter(r => toks.every(t => (r.item_name || '').toLowerCase().includes(t))); }
    return list;
  }, [rows, catFilter, search]);

  const setF = (patch) => setForm(f => ({ ...f, ...patch }));
  const openAdd = () => { setForm(blank()); setModal(true); };
  const openEdit = (r) => { setForm({ id: r.id, item_name: r.item_name, rate: r.rate, uom: r.uom || 'PCS', category: r.category || 'Low Voltage' }); setModal(true); };
  const save = async () => {
    if (!form.item_name.trim()) { toast.error('Item name required'); return; }
    try {
      const payload = { item_name: form.item_name, rate: form.rate, uom: form.uom, category: form.category };
      if (form.id) await api.put(`/quotations/labour-rates/${form.id}`, payload);
      else await api.post('/quotations/labour-rates', payload);
      toast.success(form.id ? 'Updated' : 'Added');
      setModal(false); setForm(blank()); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };
  const del = async (id) => { if (!confirm('Delete this labour rate?')) return; try { await api.delete(`/quotations/labour-rates/${id}`); load(); } catch (e) { toast.error('Failed'); } };

  return (
    <div className="space-y-4 pb-24">
      <div className="flex items-end justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">🛠 Labour Rate</h1>
          <p className="text-sm text-gray-500">Item-wise labour / sub-contractor rates by UOM and category.</p>
        </div>
        <button onClick={openAdd} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Labour Item</button>
      </div>

      {/* Filters */}
      <div className="flex items-center gap-2 flex-wrap">
        {['', ...CATEGORIES].map(c => (
          <button key={c || 'all'} onClick={() => setCatFilter(c)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold border ${catFilter === c ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-gray-600 border-gray-200 hover:bg-gray-50'}`}>
            {c || 'All'}
          </button>
        ))}
        <input className="input ml-auto max-w-xs" placeholder="Search item…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Table */}
      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-gray-50 text-left text-[11px] uppercase text-gray-500">
              <th className="p-2 w-20">Task ID</th>
              <th className="p-2">Item Name</th>
              <th className="p-2 text-right w-28">Rate ₹</th>
              <th className="p-2 w-24">UOM</th>
              <th className="p-2 w-36">Category</th>
              <th className="p-2 w-20"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.slice(0, RENDER_CAP).map(r => (
              <tr key={r.id} className="border-t border-gray-100 hover:bg-gray-50">
                <td className="p-2 text-gray-400 font-mono text-xs">LR-{r.id}</td>
                <td className="p-2 font-medium text-gray-800">{r.item_name}</td>
                <td className="p-2 text-right">{fmt(r.rate)}</td>
                <td className="p-2 text-gray-600">{r.uom}</td>
                <td className="p-2 text-gray-600">{r.category}</td>
                <td className="p-2">
                  <div className="flex items-center gap-2">
                    <button onClick={() => openEdit(r)} className="text-indigo-500 hover:text-indigo-700"><FiEdit2 size={14} /></button>
                    <button onClick={() => del(r.id)} className="text-red-400 hover:text-red-600"><FiTrash2 size={14} /></button>
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && <tr><td colSpan={6} className="p-6 text-center text-gray-400 text-sm">No labour rates. Click “Add Labour Item”.</td></tr>}
          </tbody>
        </table>
        {filtered.length > RENDER_CAP && <div className="p-2 text-center text-xs text-gray-400">Showing {RENDER_CAP} of {filtered.length} — search or filter to narrow.</div>}
      </div>
      <div className="text-xs text-gray-400">{filtered.length} item(s){catFilter ? ` in ${catFilter}` : ''}.</div>

      {/* Add / Edit modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={form.id ? `Edit Labour Item — LR-${form.id}` : 'Add Labour Item'}>
        <div className="space-y-3">
          <div>
            <label className="block text-[10px] font-semibold uppercase text-gray-400 mb-0.5">Item Name</label>
            <input autoFocus className="input" value={form.item_name} onChange={e => setF({ item_name: e.target.value })} placeholder="e.g. SENSOR INSTALLATION" />
          </div>
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-[10px] font-semibold uppercase text-gray-400 mb-0.5">Rate ₹</label>
              <input className="input text-right" type="number" min="0" value={form.rate} onChange={e => setF({ rate: e.target.value })} placeholder="0" />
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase text-gray-400 mb-0.5">UOM</label>
              <select className="select" value={form.uom} onChange={e => setF({ uom: e.target.value })}>{UOMS.map(u => <option key={u} value={u}>{u}</option>)}</select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold uppercase text-gray-400 mb-0.5">Category</label>
              <select className="select" value={form.category} onChange={e => setF({ category: e.target.value })}>{CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}</select>
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={save} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> {form.id ? 'Update' : 'Add'}</button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
