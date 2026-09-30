import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';

export default function BalanceDeliveryModal({ bill, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [notes, setNotes] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [requestId] = useState(() => crypto.randomUUID());
  useEffect(() => {
    let active = true;
    api.get(`/procurement/purchase-bills/${bill.id}/delivery-balance`).then(r => {
      if (active) setData(r.data);
    }).catch(e => { if (active) setError(e.response?.data?.error || 'Could not load delivery balance'); });
    return () => { active = false; };
  }, [bill.id]);
  const pending = data?.items.some(it => it.remaining_qty > 0);
  const save = async e => {
    e.preventDefault(); if (saving) return;
    setSaving(true); setError('');
    try {
      const r = await api.post(`/procurement/purchase-bills/${bill.id}/balance-delivery`, {
        request_id: requestId, delivery_date: date, notes,
        items: data.items.map(it => ({ vendor_po_item_id: it.vpi_id, received_qty: quantities[it.vpi_id] || 0 })),
      });
      toast.success(`Delivery recorded as ${r.data.document_number}. Upload site receiving proof in Dispatch & Receiving.`);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || 'Could not save delivery'); }
    finally { setSaving(false); }
  };
  return <Modal isOpen onClose={() => !saving && onClose()} title={`Delivery balance — ${bill.bill_number || 'Purchase bill'}`} wide>
    <form onSubmit={save} className="space-y-4">
      <p className="text-sm text-gray-600">Enter only the quantity arriving in this delivery. Earlier deliveries and the bill amount stay unchanged. Site receiving proof can be added against the new challan.</p>
      {error && <p role="alert" className="text-red-700 bg-red-50 p-2 rounded">{error}</p>}
      {!data ? <p>Loading delivery quantities…</p> : <>
        <div className="space-y-2">{data.items.map(it => <div key={it.vpi_id} className="border rounded-lg p-3 bg-gray-50">
          <div className="font-semibold text-sm">{it.description}</div>
          <div className="text-xs text-gray-600 mt-1">Ordered: {it.ordered_qty} {it.unit} · Already received: {it.received_qty} · <span className={it.remaining_qty ? 'text-amber-700 font-semibold' : 'text-emerald-700'}>Balance: {it.remaining_qty}</span></div>
          {it.remaining_qty > 0 && <label className="flex justify-between items-center text-sm mt-2">Received now
            <input aria-label={`Received now — ${it.description}`} className="input w-28 text-right" type="number" min="0" max={it.remaining_qty} step="any" value={quantities[it.vpi_id] || ''} placeholder="0" onChange={e => setQuantities(q => ({ ...q, [it.vpi_id]: e.target.value }))} />
          </label>}
        </div>)}</div>
        {pending ? <>
          <label className="block text-sm">Delivery date<input className="input mt-1" type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="block text-sm">Delivery reference / notes<input className="input mt-1" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Vendor challan number or notes" /></label>
          <button className="btn btn-primary w-full" disabled={saving}>{saving ? 'Saving…' : 'Record this delivery'}</button>
        </> : <p className="text-emerald-700 font-semibold">All PO quantities received. No balance pending.</p>}
        <details className="text-xs"><summary className="cursor-pointer font-semibold">Delivery history ({data.history.length})</summary>{data.history.map((h,i) => <p className="mt-2" key={i}>{h.delivery_date} · {h.document_number}</p>)}</details>
      </>}
    </form>
  </Modal>;
}
