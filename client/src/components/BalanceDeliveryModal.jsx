import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';

export default function BalanceDeliveryModal({ bill, onClose, onSaved }) {
  const [data, setData] = useState(null);
  const [quantities, setQuantities] = useState({});
  const [date, setDate] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));
  const [notes, setNotes] = useState('');
  const [addBill, setAddBill] = useState(true);
  const [billNumber, setBillNumber] = useState('');
  const [billDate, setBillDate] = useState(date);
  const [amount, setAmount] = useState('');
  const [gst, setGst] = useState('');
  const [file, setFile] = useState(null);
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
      if (addBill && !file) throw new Error('Upload the purchase bill file');
      const body = new FormData();
      for (const [key,value] of Object.entries({request_id:requestId,delivery_date:date,notes,add_bill:addBill?'1':'0',bill_number:billNumber,bill_date:billDate,amount,gst_amount:gst || '0'})) body.append(key,value);
      body.append('items', JSON.stringify(data.items.map(it => ({ vendor_po_item_id: it.vpi_id, received_qty: quantities[it.vpi_id] || 0 }))));
      if (addBill && file) body.append('file',file);
      const r = await api.post(`/procurement/purchase-bills/${bill.id}/balance-delivery`, body);
      toast.success(`${addBill ? 'Purchase bill and delivery saved' : 'Delivery recorded'} as ${r.data.document_number}. Upload site receiving proof in Dispatch & Receiving.`);
      onSaved();
    } catch (e) { setError(e.response?.data?.error || e.message || 'Could not save delivery'); }
    finally { setSaving(false); }
  };
  return <Modal isOpen onClose={() => !saving && onClose()} title={`Delivery balance — ${bill.bill_number || 'Purchase bill'}`} wide>
    <form onSubmit={save} className="space-y-4">
      <p className="text-sm text-gray-600">Enter only the quantity arriving now and its new purchase bill. Earlier deliveries and bills stay unchanged. If the material was already billed, turn off the new-bill option below.</p>
      {error && <p role="alert" className="text-red-700 bg-red-50 p-2 rounded">{error}</p>}
      {!data ? <p>Loading delivery quantities…</p> : <>
        <div className="space-y-2">{data.items.map(it => <div key={it.vpi_id} className="border rounded-lg p-3 bg-gray-50">
          <div className="font-semibold text-sm">{it.description}</div>
          <div className="text-xs text-gray-600 mt-1">Ordered: {it.ordered_qty} {it.unit} · Already received: {it.received_qty} · <span className={it.remaining_qty ? 'text-amber-700 font-semibold' : 'text-emerald-700'}>Balance: {it.remaining_qty}</span></div>
          {it.remaining_qty > 0 && <label className="flex justify-between items-center text-sm mt-2">Received now
            <input aria-label={`Received now — ${it.description}`} className="input w-28 text-right" type="number" min="0" max={it.remaining_qty} step="any" value={quantities[it.vpi_id] || ''} placeholder="0" onChange={e => {
              const next = {...quantities,[it.vpi_id]:e.target.value}; setQuantities(next);
              setAmount(String(Math.round(data.items.reduce((sum,row)=>sum+(+next[row.vpi_id] || 0)*(+row.rate || 0),0)*100)/100));
            }} />
          </label>}
        </div>)}</div>
        {pending ? <>
          <label className="block text-sm">Delivery date<input className="input mt-1" type="date" required value={date} onChange={e => setDate(e.target.value)} /></label>
          <label className="flex items-center gap-2 text-sm font-semibold"><input type="checkbox" checked={addBill} onChange={e => setAddBill(e.target.checked)} />Upload a new purchase bill for this delivery</label>
          {addBill && <div className="border rounded-lg p-3 bg-blue-50 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <label className="text-sm">Bill number *<input className="input mt-1" required maxLength={100} value={billNumber} onChange={e=>setBillNumber(e.target.value)} /></label>
              <label className="text-sm">Bill date *<input className="input mt-1" type="date" required value={billDate} onChange={e=>setBillDate(e.target.value)} /></label>
              <label className="text-sm">Amount (before GST) *<input className="input mt-1" type="number" min="0" step="0.01" required value={amount} onChange={e=>setAmount(e.target.value)} /></label>
              <label className="text-sm">GST amount<input className="input mt-1" type="number" min="0" step="0.01" value={gst} placeholder="0" onChange={e=>setGst(e.target.value)} /></label>
              <label className="text-sm">Total<input className="input mt-1" readOnly value={((+amount || 0)+(+gst || 0)).toFixed(2)} /></label>
            </div>
            <p className="text-xs text-blue-700">Amount is suggested from this delivery’s quantities. Change it to match the vendor’s bill.</p>
            <label className="block text-sm">Purchase bill file *<input className="input mt-1" type="file" accept=".pdf,.jpg,.jpeg,.png,.xlsx" required onChange={e=>setFile(e.target.files?.[0] || null)} /></label>
          </div>}
          <label className="block text-sm">Delivery reference / notes<input className="input mt-1" maxLength={500} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Vendor challan number or notes" /></label>
          <button className="btn btn-primary w-full" disabled={saving}>{saving ? 'Saving…' : addBill ? 'Save purchase bill & delivery' : 'Record this delivery'}</button>
        </> : <p className="text-emerald-700 font-semibold">All PO quantities received. No balance pending.</p>}
        <details className="text-xs"><summary className="cursor-pointer font-semibold">Delivery history ({data.history.length})</summary>{data.history.map((h,i) => <p className="mt-2" key={i}>{h.delivery_date} · {h.document_number}{h.bill_number && <> · Bill {h.bill_number} · ₹{h.total_amount} {h.bill_file_path && <a className="text-blue-700 underline" href={h.bill_file_path} target="_blank" rel="noreferrer">View Bill</a>}</>}</p>)}</details>
      </>}
    </form>
  </Modal>;
}
