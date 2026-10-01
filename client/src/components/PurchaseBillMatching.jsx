import {useEffect,useState} from 'react';
import api from '../api';
import Modal from './Modal';

const money=n=>`₹${(+n||0).toLocaleString('en-IN',{maximumFractionDigits:2})}`;
export default function PurchaseBillMatching({target,onClose,onSaved,canApprove}) {
  const [data,setData]=useState(null),[error,setError]=useState(''),[reason,setReason]=useState(''),[saving,setSaving]=useState(false);
  useEffect(()=>{
    let active=true;
    api.get(`/procurement/${target.kind==='po'?'vendor-po':'purchase-bills'}/${target.id}/matching`)
      .then(r=>{if(active)setData(r.data);}).catch(e=>{if(active)setError(e.response?.data?.error||'Could not load matching details');});
    return()=>{active=false;};
  },[target.id,target.kind]);
  const accept=async e=>{
    e.preventDefault();if(saving)return;setSaving(true);setError('');
    try {const r=await api.post(`/procurement/purchase-bills/${target.id}/accept-rate`,{reason});setData(r.data);setReason('');onSaved();}
    catch(e){setError(e.response?.data?.error||'Could not save review');}finally{setSaving(false);}
  };
  return <Modal isOpen xwide title={`PO · Receiving · Bill matching — ${target.label||''}`} onClose={()=>!saving&&onClose()}>
    <div className="space-y-4">
      {error&&<p role="alert" className="bg-red-50 text-red-700 rounded p-3">{error}</p>}
      {!data?<p>Loading matching details…</p>:<>
        {data.status&&<>
          <div className={`p-3 rounded-lg ${data.status==='Verified'?'bg-emerald-50 text-emerald-800':'bg-amber-50 text-amber-900'}`}><b>{data.status}</b><p className="text-xs mt-1">{data.note}</p></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-sm">
            {[['Net payable',data.net_payable],['Already paid',data.paid_amount],['Pending verification / dispute',data.hold_amount],['Verified payment available',data.payable_now]].map(([label,value])=><div className="rounded border p-3" key={label}>{label}<p className="font-bold mt-1">{money(value)}</p></div>)}
          </div>
          <p className="text-xs text-gray-600">Accepted quantity below is allocated to this invoice only. A pending challan is not proof of receiving. Freight is held until this invoice’s quantities are accepted.</p>
          {data.items.length===0?<p className="border rounded p-3 text-sm">This invoice has no verified item allocation. Use “Reconcile items” after recording receiving. Its saved amount has not been changed.</p>:<div className="grid gap-3">{data.items.map(it=><div className="border rounded-lg p-3" key={it.id}>
            <b className="text-sm">{it.description}</b><span className="text-xs text-gray-500 ml-2">{it.po_number}</span>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 my-2 text-xs"><span>PO qty: {it.ordered_qty??'—'} {it.unit}</span><span>Billed: {it.billed_qty} {it.unit}</span><span>Accepted for bill: {it.accepted_qty}</span><span>PO rate: {money(it.po_rate)}</span><span>Bill rate: {money(it.bill_rate)}</span></div>
            <p className={`text-xs font-semibold ${it.status==='Matched'?'text-emerald-700':'text-amber-700'}`}>{it.status}{it.pending_qty>0?` · ${it.pending_qty} ${it.unit} awaiting acceptance`:''}</p>
          </div>)}</div>}
          {!data.rate_approved&&data.items.some(it=>it.rate_difference>0.005)&&canApprove&&<form onSubmit={accept} className="border rounded p-3 space-y-2 text-sm">
            <b>Review higher vendor rate</b><p className="text-xs text-gray-600">Accept the higher invoice rate only if agreed. This does not approve missing or rejected material, change the PO, or remove an existing debit note.</p>
            <textarea className="input" aria-label="Rate acceptance reason" required minLength={10} maxLength={1000} value={reason} onChange={e=>setReason(e.target.value)} placeholder="Reason for accepting the higher rate"/>
            <button className="btn btn-secondary" disabled={saving}>{saving?'Saving review…':'Accept rate with reason'}</button>
          </form>}
          {data.approval&&<p className="text-xs bg-emerald-50 p-3">Rate accepted: {data.approval.reason} · {data.approval.created_at}</p>}
        </>}
        <h4 className="font-semibold">PO delivery and billing balance</h4>
        <p className="text-xs text-gray-600">Balance expected means material still to be accepted; it is not automatically a final shortage. Purchase bill pending means accepted quantities not yet allocated to an invoice.</p>
        {data.pos.filter(Boolean).map(po=><div key={po.id} className="border rounded-lg p-3 space-y-2"><b>{po.po_number}</b>
          {po.reconciliation_required&&<p className="text-xs text-amber-700">Historical invoices or receipt links need reconciliation. Unbilled quantities are not estimated.</p>}
          {po.items.map(it=><div key={it.id} className="border-t pt-2 text-sm"><b>{it.description}</b><div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs mt-1"><span>Ordered: {it.ordered_qty} {it.unit}</span><span>Accepted: {it.accepted_qty}</span><span>Allocated to bills: {it.billed_qty}</span><span className="text-amber-700">Balance expected: {it.balance_expected}</span><span className="text-blue-700">Purchase bill pending: {it.unbilled_qty??'Review needed'}</span></div></div>)}
        </div>)}
      </>}
    </div>
  </Modal>;
}
