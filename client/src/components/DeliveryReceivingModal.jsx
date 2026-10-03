import { useState, useRef } from 'react';
import Modal from './Modal';
import api from '../api';
import toast from 'react-hot-toast';

export default function DeliveryReceivingModal({ row, employees, warehouses, onClose, onSaved }) {
  const requestId = useRef(crypto.randomUUID());
  const savingRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date()));
  const [reason, setReason] = useState('');
  const [warehouse, setWarehouse] = useState('');
  const [files, setFiles] = useState([]);
  const [quantities, setQuantities] = useState(() => Object.fromEntries((row.dispatch_items || []).map(it => [it.line_key, it.remaining_qty ?? it.qty])));
  const items = row.dispatch_items || [];
  const historyCount = row.receiving_history?.length || 0;
  const save = async event => {
    event.preventDefault();
    if (savingRef.current) return;
    if (!name.trim() || !files.length) return toast.error('Enter the receiver and attach proof.');
    if (files.length > 10) return toast.error('Attach up to 10 files for one receiving.');
    if (!items.some(it => +quantities[it.line_key] > 0)) return toast.error('Enter at least one quantity received.');
    savingRef.current = true; setSaving(true);
    try {
      const form = new FormData();
      form.append('request_id', requestId.current);
      form.append('received_by_name', name.trim()); form.append('received_at', date);
      form.append('delay_reason', reason); if (warehouse) form.append('warehouse_id', warehouse);
      form.append('items_received', JSON.stringify(items.map(it => ({ line_key: it.line_key, received_qty: quantities[it.line_key] }))));
      for (const file of files) form.append('file', file);
      const result = await api.patch(`/procurement/delivery-notes/${row.id}/receive`, form);
      toast.success(result.data.message); onSaved();
    } catch (error) { toast.error(error.response?.data?.error || 'Could not save receiving. Try again.'); }
    finally { savingRef.current = false; setSaving(false); }
  };
  return <Modal isOpen onClose={() => !saving && onClose()} title={historyCount ? 'Add another receiving' : 'Upload receiving'} wide>
    <form onSubmit={save} className="space-y-4">
      <div className="rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm">
        <div className="font-semibold text-blue-900">{row.document_number} · {row.site_name || row.company_name}</div>
        <p className="mt-1 text-xs text-blue-800">Receiving {historyCount + 1} · Enter quantities arriving in this delivery. Earlier receipts stay saved.</p>
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full text-xs text-left"><thead className="bg-slate-50 text-slate-600"><tr>
          {['Material', 'Dispatch qty', 'Already received', 'Balance', 'Receiving now'].map(label => <th key={label} className="p-2">{label}</th>)}
        </tr></thead><tbody>{items.map(it => <tr key={it.line_key} className="border-t border-slate-100">
          <td className="p-2 font-medium">{it.description || it.item_name}<div className="text-slate-400 font-normal">{it.unit}</div></td>
          <td className="p-2">{it.qty}</td><td className="p-2">{it.received_qty || 0}</td><td className="p-2 font-semibold">{it.remaining_qty}</td>
          <td className="p-2"><input aria-label={`Receiving now: ${it.description || it.item_name}`} type="number" className="input w-24 text-right" min="0" max={it.remaining_qty} step="any" required disabled={saving || it.remaining_qty === 0}
            value={quantities[it.line_key]} onChange={e => setQuantities(q => ({ ...q, [it.line_key]: e.target.value }))} /></td>
        </tr>)}</tbody></table>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="text-xs font-medium">Received by *<input className="input mt-1" list="delivery-receivers" value={name} onChange={e => setName(e.target.value)} required disabled={saving} placeholder="Name of site receiver" /></label>
        <datalist id="delivery-receivers">{employees.map(e => <option key={e.id} value={e.name} />)}</datalist>
        <label className="text-xs font-medium">Received on *<input type="date" className="input mt-1" value={date} onChange={e => setDate(e.target.value)} required disabled={saving} /></label>
      </div>
      <label className="block text-xs font-medium">Reason for delay (if delivery is late)<textarea className="input mt-1" rows="2" value={reason} onChange={e => setReason(e.target.value)} disabled={saving} /></label>
      <label className="block text-xs font-medium">Receiving proof *<input type="file" className="input mt-1" accept=".pdf,.jpg,.jpeg,.png,.webp" multiple required disabled={saving} onChange={e => setFiles(Array.from(e.target.files || []))} />
        <span className="mt-1 block text-slate-500 font-normal">Attach all pages/photos of this receipt together (up to 10 files). They count as one receiving.</span>
        {!!files.length && <span className="mt-1 block text-emerald-700">{files.map(f => f.name).join(', ')}</span>}
      </label>
      {row.vendor_po_id && row.source !== 'store' && warehouses.length > 0 && <label className="block text-xs font-medium">Add received quantities to inventory (optional)
        <select className="select mt-1" value={warehouse} onChange={e => setWarehouse(e.target.value)} disabled={saving}><option value="">Do not add to inventory</option>{warehouses.filter(w => w.active).map(w => <option key={w.id} value={w.id}>{w.name}</option>)}</select>
      </label>}
      <p className="rounded-lg bg-slate-50 p-3 text-xs text-slate-600">Remaining quantities stay pending for the next delivery. Sales-bill status stays separate. This receiving goes to Lovely/admin for approval.</p>
      <div className="flex justify-end gap-2"><button type="button" className="btn btn-secondary" disabled={saving} onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={saving || !items.length}>{saving ? 'Saving…' : 'Save receiving'}</button></div>
    </form>
  </Modal>;
}
