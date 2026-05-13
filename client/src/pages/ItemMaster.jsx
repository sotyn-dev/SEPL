import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiSearch, FiDownload, FiUpload, FiPackage, FiFilter, FiX, FiClock, FiAlertTriangle } from 'react-icons/fi';

// MD's Phase 1 (this week):
//   "Right now Price is just a number — no date, no vendor, no bill.
//    We can't trust it for tenders."
// Replaces the bare current_price with structured pricing provenance:
//   Rate · Vendor (FK) · Source Type (PO/Quote/Manual/Online) · Bill/PO
//   Number · Bill/PO Date · Captured On (auto) · Captured By (auto)
// Plus Price Age colour-coded column (green ≤30 / yellow 31-60 / red
// 60+), filter pills (Expired / Ageing / Make blank / No vendor), and
// a non-destructive Price History viewer per row.

const DEPARTMENTS = ['FF', 'LV', 'ELE', 'CCTV', 'AC', 'NET', 'SOL', 'OTHER'];
const DEPT_LABELS = { FF: 'Fire Fighting', LV: 'Low Voltage', ELE: 'Electrical', CCTV: 'CCTV', AC: 'Access Control', NET: 'Networking', SOL: 'Solar', OTHER: 'Other' };
const TYPES = ['PO', 'FOC', 'RGP'];
const UOMS = ['PCS', 'MTR', 'KG', 'SQMM', 'PACKET', 'SET', 'LOT', 'PAIR', 'RFT', 'LTR', 'BOX'];
const SOURCE_TYPES = ['PO', 'Quote', 'Manual', 'Online'];

const emptyForm = {
  item_code: '', department: 'FF', item_name: '', specification: '', size: '',
  uom: 'PCS', gst: '18%', type: 'PO', make: '', model_number: '',
  current_price: 0,
  vendor_id: '', source_type: 'Manual', bill_po_number: '', bill_po_date: '',
};

// Pretty age badge — colours match MD's spec.
function AgeBadge({ status, days }) {
  if (status === 'never') return <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded border bg-gray-100 text-gray-500 border-gray-200">NEVER</span>;
  const cls = status === 'green'
    ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
    : status === 'yellow'
      ? 'bg-amber-100 text-amber-800 border-amber-300'
      : 'bg-red-100 text-red-700 border-red-300';
  const label = status === 'red' ? `${days}d · EXPIRED` : `${days}d`;
  return <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${cls}`}>{label}</span>;
}

export default function ItemMaster() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [items, setItems] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [modal, setModal] = useState(null);
  const [bulkModal, setBulkModal] = useState(false);
  const [historyModal, setHistoryModal] = useState(null); // { item, rows }
  const [form, setForm] = useState({ ...emptyForm });
  const [search, setSearch] = useState('');
  const [filterDept, setFilterDept] = useState('');
  const [statusFilter, setStatusFilter] = useState(''); // expired | ageing | fresh | never | make_blank | no_vendor
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (filterDept) params.set('department', filterDept);
    if (statusFilter) params.set('status', statusFilter);
    api.get(`/item-master?${params}`).then(r => setItems(r.data)).catch(() => {});
  }, [search, filterDept, statusFilter]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    // Lazy-load vendors so the Vendor dropdown in the modal works.
    api.get('/procurement/vendors').then(r => setVendors(r.data || [])).catch(() => setVendors([]));
  }, []);

  const handleSave = async (e) => {
    e.preventDefault();
    try {
      const payload = { ...form, vendor_id: form.vendor_id || null };
      if (modal === 'edit' && form.id) {
        await api.put(`/item-master/${form.id}`, payload);
        toast.success('Item updated');
      } else {
        const res = await api.post('/item-master', payload);
        toast.success(`Item created: ${res.data.item_code}`);
      }
      setModal(null); setForm({ ...emptyForm }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const handleDelete = async (id, code) => {
    if (!confirm(`Delete item ${code}?`)) return;
    try { await api.delete(`/item-master/${id}`); toast.success('Deleted'); load(); } catch { toast.error('Failed'); }
  };

  const openHistory = async (item) => {
    try {
      const r = await api.get(`/item-master/${item.id}/price-history`);
      setHistoryModal({ item, rows: r.data || [] });
    } catch { toast.error('Could not load history'); }
  };

  // CSV: matches the new column set MD asked for.
  const exportCSV = () => {
    if (items.length === 0) return toast.error('No data');
    const headers = ['Item Code', 'Department', 'Item Name', 'Specification', 'Size', 'UOM', 'GST', 'Type', 'Make', 'Model', 'Rate', 'Vendor Name', 'Source Type', 'Bill/PO Number', 'Bill/PO Date', 'Captured On', 'Captured By', 'Age (days)', 'Age Status'];
    const rows = items.map(i => [
      i.item_code, i.department, i.item_name, i.specification, i.size, i.uom, i.gst, i.type,
      i.make, i.model_number, i.current_price,
      i.vendor_name || '', i.source_type || '', i.bill_po_number || '', i.bill_po_date || '',
      (i.priced_at || '').replace('T', ' ').slice(0, 16), i.priced_by_name || '',
      i.age_days ?? '', i.age_status || '',
    ]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = `item-master-${new Date().toISOString().split('T')[0]}.csv`; a.click();
    toast.success('Exported');
  };

  const downloadTemplate = () => {
    const headers = 'Item Code,Department,Item Name,Specification,Size,UOM,GST,Type,Make,Rate,Vendor Name,Source Type,Bill/PO Number,Bill/PO Date';
    const sample = 'FF0100,FF,HYDRANT VALVE,SS BODY,63MM,PCS,18%,PO,AGNI,2500,Agni Devices Ltd,PO,SEPL/PO/2026/042,2026-04-15';
    const csv = headers + '\n' + sample;
    const blob = new Blob([csv], { type: 'text/csv' }); const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = 'item-master-template.csv'; a.click();
  };

  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    return lines.slice(1).map(line => {
      const c = line.split(',').map(v => v.replace(/^"|"$/g, '').trim());
      if (!c[2]) return null;
      return {
        item_code: c[0], department: c[1], item_name: c[2], specification: c[3], size: c[4],
        uom: c[5] || 'PCS', gst: c[6] || '18%', type: c[7] || 'PO', make: c[8],
        current_price: parseFloat(c[9]) || 0,
        vendor_name: c[10] || '',
        source_type: c[11] || 'Manual',
        bill_po_number: c[12] || '',
        bill_po_date: c[13] || '',
      };
    }).filter(Boolean);
  };

  const handleFile = (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => { setBulkData(ev.target.result); setBulkPreview(parseCSV(ev.target.result)); };
    reader.readAsText(file); e.target.value = '';
  };

  const bulkImport = async () => {
    if (bulkPreview.length === 0) return toast.error('No valid data');
    try {
      const res = await api.post('/item-master/bulk', { items: bulkPreview });
      toast.success(`Added ${res.data.added} of ${res.data.total} items`);
      setBulkModal(false); setBulkData(''); setBulkPreview([]); load();
    } catch { toast.error('Import failed'); }
  };

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));

  // MD's brief specified exactly 4 filter buttons (plus All to clear).
  // Per-item rate age has only 3 stages (green 0-30 / yellow 31-60 /
  // red 60+) — the badges colour-code each row, the pills filter the
  // list. Removed the earlier "Fresh" and "No Price Yet" extras that
  // weren't in MD's spec.
  const statusPills = [
    { id: '', label: 'All', cls: 'bg-gray-100 text-gray-700 border-gray-200' },
    { id: 'expired', label: 'Expired (60+ days)', cls: 'bg-red-100 text-red-700 border-red-300' },
    { id: 'ageing', label: 'Ageing (31–60 days)', cls: 'bg-amber-100 text-amber-800 border-amber-300' },
    { id: 'make_blank', label: 'Make Blank', cls: 'bg-purple-100 text-purple-700 border-purple-300' },
    { id: 'no_vendor', label: 'No Vendor Linked', cls: 'bg-indigo-100 text-indigo-700 border-indigo-300' },
  ];

  return (
    <div className="space-y-6">
      <div className="sticky-toolbar">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2"><FiPackage className="text-red-600" /> Item Master</h1>
            <p className="text-sm text-gray-500">{items.length} items · with vendor + bill + age tracking</p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export</button>
            {canCreate('item_master') && <>
              <button onClick={() => { setBulkData(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiUpload size={15} /> Bulk Import</button>
              <button onClick={() => { setForm({ ...emptyForm }); setModal('add'); }} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Item</button>
            </>}
          </div>
        </div>

        {/* MD's filter buttons */}
        <div className="flex flex-wrap gap-2">
          {statusPills.map(p => (
            <button
              key={p.id}
              onClick={() => setStatusFilter(p.id)}
              className={`text-[11px] font-semibold px-3 py-1.5 rounded-full border transition ${statusFilter === p.id ? `${p.cls} ring-2 ring-offset-1 ring-red-400` : 'bg-white text-gray-600 border-gray-200 hover:border-red-300 hover:text-red-700'}`}
            >
              {p.label}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[280px_1fr_auto] gap-3 items-end">
          <div>
            <label className="label flex items-center gap-1"><FiFilter size={12} /> Department</label>
            <select className="select" value={filterDept} onChange={e => setFilterDept(e.target.value)}>
              <option value="">All Departments</option>
              {DEPARTMENTS.map(d => <option key={d} value={d}>{d} — {DEPT_LABELS[d] || d}</option>)}
            </select>
          </div>
          <div>
            <label className="label flex items-center gap-1"><FiSearch size={12} /> Search by name / spec / code / make</label>
            <div className="relative">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
              <input className="input pl-10" placeholder="Type to search…" value={search} onChange={e => setSearch(e.target.value)} />
            </div>
          </div>
          {(search || filterDept || statusFilter) && (
            <button onClick={() => { setSearch(''); setFilterDept(''); setStatusFilter(''); }} className="btn btn-secondary text-red-500 flex items-center gap-1 whitespace-nowrap">
              <FiX size={14} /> Clear
            </button>
          )}
        </div>
      </div>

      {/* Table */}
      <div className="card p-0">
        <table className="min-w-full freeze-head">
          <thead><tr className="bg-gray-50">
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Code</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Dept</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Item / Spec / Size</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Make</th>
            <th className="px-3 py-3 text-right text-xs font-semibold text-gray-600">Rate (₹)</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Price Age</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Vendor</th>
            <th className="px-3 py-3 text-left text-xs font-semibold text-gray-600">Source · Bill / PO</th>
            <th className="px-3 py-3 text-center text-xs font-semibold text-gray-600">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {items.map(i => {
              const status = i.age_status || (i.current_price > 0 ? 'green' : 'never');
              const rowCls = status === 'red' ? 'bg-red-50/40 hover:bg-red-100/40' : status === 'yellow' ? 'bg-amber-50/40 hover:bg-amber-100/40' : 'hover:bg-red-50/30';
              const missingVendor = !i.vendor_id;
              const missingMake = !i.make || !i.make.trim();
              return (
                <tr key={i.id} className={rowCls}>
                  <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{i.item_code}</td>
                  <td className="px-3 py-2"><span className="inline-flex px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-700">{i.department}</span></td>
                  <td className="px-3 py-2">
                    <div className="font-medium text-sm">{i.item_name}</div>
                    <div className="text-xs text-gray-500">{[i.specification, i.size].filter(Boolean).join(' | ')}</div>
                  </td>
                  <td className="px-3 py-2 text-sm">
                    {missingMake ? <span className="text-[10px] text-purple-700 italic">— blank —</span> : i.make}
                  </td>
                  <td className="px-3 py-2 text-right font-semibold text-sm">
                    Rs {(+i.current_price || 0).toLocaleString('en-IN')}
                  </td>
                  <td className="px-3 py-2 text-center"><AgeBadge status={status} days={i.age_days} /></td>
                  <td className="px-3 py-2 text-sm">
                    {missingVendor
                      ? <span className="text-[10px] text-indigo-700 italic inline-flex items-center gap-0.5"><FiAlertTriangle size={10} /> not linked</span>
                      : i.vendor_name}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-600">
                    <div>{i.source_type || '—'}</div>
                    {i.bill_po_number && <div className="font-mono text-[10px] text-gray-500">{i.bill_po_number}{i.bill_po_date ? ` · ${i.bill_po_date}` : ''}</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-1">
                      <button onClick={() => openHistory(i)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded" title="Price history"><FiClock size={14} /></button>
                      {canEdit('item_master') && <button onClick={() => { setForm({ ...i, vendor_id: i.vendor_id || '' }); setModal('edit'); }} className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded"><FiEdit2 size={14} /></button>}
                      {canDelete('item_master') && <button onClick={() => handleDelete(i.id, i.item_code)} className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"><FiTrash2 size={14} /></button>}
                    </div>
                  </td>
                </tr>
              );
            })}
            {items.length === 0 && <tr><td colSpan="9" className="text-center py-12 text-gray-400"><FiPackage size={40} className="mx-auto mb-3 opacity-30" /><p>No items found</p></td></tr>}
          </tbody>
        </table>
      </div>

      {/* Add / Edit Modal */}
      <Modal isOpen={modal === 'add' || modal === 'edit'} onClose={() => setModal(null)} title={modal === 'edit' ? `Edit — ${form.item_code}` : 'Add Item'} wide>
        <form onSubmit={handleSave} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Item Code</label><input className="input font-mono" value={form.item_code || ''} onChange={e => F('item_code', e.target.value)} placeholder="Auto-generated if empty" /></div>
            <div><label className="label">Department *</label><select className="select" value={form.department} onChange={e => F('department', e.target.value)}>{DEPARTMENTS.map(d => <option key={d} value={d}>{d} - {DEPT_LABELS[d] || d}</option>)}</select></div>
            <div><label className="label">Type</label><select className="select" value={form.type} onChange={e => F('type', e.target.value)}>{TYPES.map(t => <option key={t}>{t}</option>)}</select></div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Item Name *</label><input className="input" value={form.item_name || ''} onChange={e => F('item_name', e.target.value)} required /></div>
            <div><label className="label">Specification</label><input className="input" value={form.specification || ''} onChange={e => F('specification', e.target.value)} /></div>
            <div><label className="label">Size</label><input className="input" value={form.size || ''} onChange={e => F('size', e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <div><label className="label">UOM</label><select className="select" value={form.uom} onChange={e => F('uom', e.target.value)}>{UOMS.map(u => <option key={u}>{u}</option>)}</select></div>
            <div><label className="label">GST</label><input className="input" value={form.gst || ''} onChange={e => F('gst', e.target.value)} /></div>
            <div><label className="label">Make</label><input className="input" value={form.make || ''} onChange={e => F('make', e.target.value)} /></div>
            <div><label className="label">Model #</label><input className="input" value={form.model_number || ''} onChange={e => F('model_number', e.target.value)} /></div>
          </div>

          {/* MD Phase 1 — pricing provenance block */}
          <div className="border border-red-200 bg-red-50/40 rounded-lg p-3 space-y-3">
            <div className="text-xs font-bold uppercase text-red-700">Pricing — full traceability for tenders</div>
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
              <div><label className="label">Rate (₹) *</label><input className="input" type="number" min="0" step="0.01" value={form.current_price || 0} onChange={e => F('current_price', +e.target.value)} /></div>
              <div>
                <label className="label">Vendor (link)</label>
                <SearchableSelect
                  options={vendors.map(v => ({ id: v.id, label: v.name, ...v }))}
                  value={form.vendor_id || null}
                  valueKey="id"
                  displayKey="label"
                  placeholder="Pick from Vendors Master…"
                  onChange={v => F('vendor_id', v?.id || '')}
                />
              </div>
              <div><label className="label">Source Type</label>
                <select className="select" value={form.source_type || 'Manual'} onChange={e => F('source_type', e.target.value)}>
                  {SOURCE_TYPES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div><label className="label">Bill / PO Number</label><input className="input" value={form.bill_po_number || ''} onChange={e => F('bill_po_number', e.target.value)} placeholder="e.g. SEPL/PO/2026/042" /></div>
              <div><label className="label">Bill / PO Date</label><input className="input" type="date" value={form.bill_po_date || ''} onChange={e => F('bill_po_date', e.target.value)} /></div>
              {modal === 'edit' && (
                <div className="text-[11px] text-gray-500 italic flex flex-col justify-end pb-1">
                  {form.priced_at && <div>Last captured: {String(form.priced_at).replace('T', ' ').slice(0, 16)}</div>}
                  {form.priced_by_name && <div>By: {form.priced_by_name}</div>}
                </div>
              )}
            </div>
            <p className="text-[11px] text-red-700">Changing Rate / Vendor / Source / Bill — saves the old price to history automatically (never deleted).</p>
          </div>

          <div className="bg-gray-50 p-2 rounded text-sm"><strong>Display in PO:</strong> {[form.item_name, form.specification, form.size].filter(Boolean).join(' / ') || '(enter item details)'}</div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{modal === 'edit' ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>

      {/* Price History Modal */}
      <Modal isOpen={!!historyModal} onClose={() => setHistoryModal(null)} title={historyModal ? `Price History — ${historyModal.item.item_code}` : 'Price History'} wide>
        {historyModal && (
          <div className="space-y-3">
            <div className="bg-gray-50 border border-gray-200 rounded p-2.5 text-xs grid grid-cols-2 gap-1">
              <div><b>Item:</b> {historyModal.item.item_name}</div>
              <div><b>Spec / Size:</b> {[historyModal.item.specification, historyModal.item.size].filter(Boolean).join(' / ') || '—'}</div>
              <div><b>Current rate:</b> Rs {(+historyModal.item.current_price || 0).toLocaleString('en-IN')}</div>
              <div><b>Current vendor:</b> {historyModal.item.vendor_name || '—'}</div>
            </div>
            {historyModal.rows.length === 0 ? (
              <p className="text-sm text-gray-400 italic text-center py-4">No history entries yet. Old prices land here automatically when Rate / Vendor / Source / Bill is changed.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50"><tr><th className="px-2 py-1 text-left">Captured</th><th className="px-2 py-1 text-right">Rate</th><th className="px-2 py-1 text-left">Vendor</th><th className="px-2 py-1 text-left">Source</th><th className="px-2 py-1 text-left">Bill / PO</th><th className="px-2 py-1 text-left">By</th></tr></thead>
                  <tbody>
                    {historyModal.rows.map(h => (
                      <tr key={h.id} className="border-b">
                        <td className="px-2 py-1 whitespace-nowrap">{(h.created_at || '').replace('T', ' ').slice(0, 16)}</td>
                        <td className="px-2 py-1 text-right font-semibold">Rs {(+h.rate || 0).toLocaleString('en-IN')}</td>
                        <td className="px-2 py-1">{h.vendor_name || '—'}</td>
                        <td className="px-2 py-1">{h.source_type || h.source || '—'}</td>
                        <td className="px-2 py-1 font-mono text-[10px]">{h.bill_po_number || '—'}{h.bill_po_date ? ` · ${h.bill_po_date}` : ''}</td>
                        <td className="px-2 py-1 text-gray-500">{h.created_by_name || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="flex justify-end"><button onClick={() => setHistoryModal(null)} className="btn btn-secondary">Close</button></div>
          </div>
        )}
      </Modal>

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Items" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">CSV columns (in order):</p>
            <p className="font-mono text-[11px]">Item Code, Department, Item Name, Specification, Size, UOM, GST, Type, Make, Rate, Vendor Name, Source Type, Bill/PO Number, Bill/PO Date</p>
            <p className="text-[11px] mt-1">Vendor Name is matched against the Vendors Master (case-insensitive). Source Type: PO / Quote / Manual / Online.</p>
          </div>
          <button onClick={downloadTemplate} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download Template</button>
          <div><label className="label">Upload CSV</label><input type="file" accept=".csv" onChange={handleFile} className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" /></div>
          <div><label className="label">Or Paste CSV</label><textarea className="input font-mono text-xs" rows="5" value={bulkData} onChange={e => { setBulkData(e.target.value); setBulkPreview(parseCSV(e.target.value)); }} placeholder="Item Code,Dept,Name,Spec,Size,UOM,GST,Type,Make,Rate,Vendor Name,Source,Bill/PO #,Bill/PO Date" /></div>
          {bulkPreview.length > 0 && (
            <div><p className="text-sm font-semibold mb-2">{bulkPreview.length} items to import</p>
              <div className="max-h-48 overflow-y-auto border rounded text-xs"><table><thead><tr className="bg-gray-50"><th className="px-2 py-1">Code</th><th className="px-2 py-1">Dept</th><th className="px-2 py-1">Name</th><th className="px-2 py-1">Rate</th><th className="px-2 py-1">Vendor</th><th className="px-2 py-1">Source</th><th className="px-2 py-1">Bill/PO</th></tr></thead>
                <tbody>{bulkPreview.map((i, idx) => <tr key={idx}><td className="px-2 py-1">{i.item_code}</td><td className="px-2 py-1">{i.department}</td><td className="px-2 py-1 font-medium">{i.item_name}</td><td className="px-2 py-1">{i.current_price}</td><td className="px-2 py-1">{i.vendor_name}</td><td className="px-2 py-1">{i.source_type}</td><td className="px-2 py-1">{i.bill_po_number}</td></tr>)}</tbody></table></div>
            </div>
          )}
          <div className="flex justify-end gap-3"><button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button><button onClick={bulkImport} disabled={bulkPreview.length === 0} className="btn btn-primary disabled:opacity-50 flex items-center gap-1"><FiUpload size={14} /> Import {bulkPreview.length} Items</button></div>
        </div>
      </Modal>
    </div>
  );
}
