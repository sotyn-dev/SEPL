import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
const round=n=>Math.round((n+Number.EPSILON)*100)/100;

export default function PurchaseBillReconciliation({vendors,initialVendor,initialPo,legacy,onClose,onSaved}) {
  const [freight,setFreight]=useState(legacy?.freight_amount || '');
  const [vendor,setVendor]=useState(String(legacy?.vendor_id||initialVendor||''));
  const [data,setData]=useState({pos:[],debits:[]}),[loading,setLoading]=useState(!!vendor),[error,setError]=useState('');
  const [selected,setSelected]=useState(initialPo?[+initialPo]:[]),[edits,setEdits]=useState({}),[debits,setDebits]=useState([]);
  const [number,setNumber]=useState(legacy?.bill_number||''),[date,setDate]=useState(legacy?.bill_date||new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Kolkata'}));
  const [file,setFile]=useState(null),[saving,setSaving]=useState(false),[key]=useState(()=>crypto.randomUUID());
  useEffect(()=>{
    let active=true;
    if(vendor)api.get('/procurement/purchase-bills/eligible',{params:{vendor_id:vendor,reconcile_bill_id:legacy?.id}}).then(r=>{if(active)setData(r.data);}).catch(e=>{if(active)setError(e.response?.data?.error||'Cannot load accepted receipts');}).finally(()=>{if(active)setLoading(false);});
    return()=>{active=false;};
  },[vendor,legacy?.id]);
  const rows=data.pos.filter(p=>selected.includes(p.id)).flatMap(p=>p.items.map(it=>({...it,po:p})));
  const value=it=>({quantity:edits[it.id]?.quantity??it.billable_qty,bill_rate:edits[it.id]?.bill_rate??it.po_rate,gst_percent:edits[it.id]?.gst_percent??0});
  const amounts=it=>{const v=value(it),amount=round((+v.quantity||0)*(+v.bill_rate||0)),gst=round(amount*(+v.gst_percent||0)/100);return {amount,gst,total:round(amount+gst)};};
  const subtotal=round(rows.reduce((s,it)=>s+amounts(it).amount,0)),gst=round(rows.reduce((s,it)=>s+amounts(it).gst,0)),total=round(subtotal+gst+(+freight||0));
  const allowedDebits=data.debits.filter(d=>selected.includes(d.vendor_po_id));
  const adjustment=round(allowedDebits.filter(d=>debits.includes(d.id)).reduce((s,d)=>s+d.amount,0));
  const edit=(id,k,v)=>setEdits(old=>({...old,[id]:{...old[id],[k]:v}}));
  const submit=async e=>{
    e.preventDefault();if(saving)return;setSaving(true);setError('');
    try {
      const body=new FormData();for(const [k,v] of Object.entries({vendor_id:vendor,bill_number:number,bill_date:date,request_key:key,freight_amount:freight||0}))body.append(k,v);
      body.append('items',JSON.stringify(rows.filter(it=>+value(it).quantity>0).map(it=>({vendor_po_id:it.po.id,vendor_po_item_id:it.id,...value(it)}))));
      body.append('debit_ids',JSON.stringify(allowedDebits.filter(d=>debits.includes(d.id)).map(d=>d.id)));
      if(file)body.append('file',file);
      await api.post(legacy?`/procurement/purchase-bills/${legacy.id}/reconcile`:'/procurement/purchase-bills',body);
      toast.success(legacy?'Historical bill reconciled':'Purchase bill saved against selected POs');onSaved();
    }catch(e){setError(e.response?.data?.error||'Could not save purchase bill');}finally{setSaving(false);}
  };
  return <Modal isOpen xwide title={legacy?'Reconcile historical purchase bill':'Upload Purchase Bill — PO reconciliation'} onClose={()=>!saving&&onClose()}>
    <form className="space-y-4" onSubmit={submit}>
      <p className="text-sm text-gray-600">Select accepted, unbilled items from one vendor’s POs. Bill rates are editable; PO rates remain unchanged. Bill upload does not receive material or change stock.</p>
      {legacy&&<p className="bg-amber-50 p-3 text-sm">Match the original invoice: taxable ₹{legacy.amount}, GST ₹{legacy.gst_amount}, total ₹{legacy.total_amount}. Existing totals and payments are preserved.</p>}
      <label className="block text-sm font-semibold">Vendor<select className="input mt-1" required value={vendor} disabled={!!legacy} onChange={e=>{setVendor(e.target.value);setSelected([]);setEdits({});setDebits([]);setData({pos:[],debits:[]});setError('');setLoading(!!e.target.value);}}><option value="">Select vendor</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {error&&<p role="alert" className="bg-red-50 text-red-700 p-3">{error}</p>}
      {loading?<p>Loading accepted receipts…</p>:<>
        {vendor&&data.pos.length===0&&<p className="bg-blue-50 p-3 text-sm">No accepted unbilled quantities. Record receiving first; fully billed POs do not appear here.</p>}
        <div className="grid sm:grid-cols-2 gap-2">{data.pos.map(p=><label key={p.id} className="border p-2 rounded text-sm flex items-start gap-2"><input className="mt-1" type="checkbox" disabled={p.reconciliation_required} checked={selected.includes(p.id)} onChange={e=>setSelected(old=>e.target.checked?[...old,p.id]:old.filter(id=>id!==p.id))}/><span><b>{p.po_number}</b> · Unbilled accepted value ₹{p.pending_value.toLocaleString('en-IN')}{p.reconciliation_required&&<span className="block text-amber-700">Historical bills or receipt lines need reconciliation. Open the historical bill’s Reconcile items action.</span>}</span></label>)}</div>
        {rows.length>0&&<div className="space-y-3">{rows.map(it=>{
          const v=value(it),a=amounts(it),variance=round((+v.bill_rate||0)-it.po_rate);
          return <div key={it.id} className="border rounded-lg p-3">
            <div className="font-semibold text-sm">{it.po.po_number} · {it.description}</div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 my-2 text-xs text-gray-600"><span>Ordered: {it.ordered_qty} {it.unit}</span><span>Accepted received: {it.received_qty}</span><span>Previously billed: {it.previously_billed_qty}</span><b className="text-emerald-700">Billable: {it.billable_qty}</b></div>
            <div className="grid grid-cols-2 md:grid-cols-6 gap-3 text-xs">
              <label>Bill qty<input aria-label={`Bill qty ${it.po.po_number} ${it.description}`} className="input mt-1" type="number" min="0" max={it.billable_qty} step="any" value={v.quantity} onChange={e=>edit(it.id,'quantity',e.target.value)}/></label>
              <label>PO rate<input className="input mt-1 bg-gray-50" readOnly value={it.po_rate}/></label>
              <label>Bill rate<input aria-label={`Bill rate ${it.po.po_number} ${it.description}`} className="input mt-1" required type="number" min="0" step="any" value={v.bill_rate} onChange={e=>edit(it.id,'bill_rate',e.target.value)}/></label>
              <label>GST %<input aria-label={`GST ${it.po.po_number} ${it.description}`} className="input mt-1" required type="number" min="0" max="100" step="any" value={v.gst_percent} onChange={e=>edit(it.id,'gst_percent',e.target.value)}/></label>
              <div>Rate difference<p className={variance?'text-amber-700 font-semibold mt-3':'mt-3'}>₹{variance}</p></div><div>Line total<p className="font-semibold mt-3">₹{a.total.toLocaleString('en-IN')}</p><span>GST ₹{a.gst}</span></div>
            </div>
          </div>;
        })}</div>}
        {!!allowedDebits.length&&!legacy&&<fieldset className="border rounded p-3 text-sm"><legend>Apply an agreed debit adjustment (optional)</legend><p className="text-xs text-gray-600 mb-2">Select only a valid adjustment to this invoice. A quantity/rate difference alone does not apply a debit.</p>{allowedDebits.map(d=><label key={d.id} className="flex gap-2 py-1"><input type="checkbox" checked={debits.includes(d.id)} onChange={e=>setDebits(old=>e.target.checked?[...old,d.id]:old.filter(id=>id!==d.id))}/>{d.dn_number} · {d.type} · ₹{d.amount} · {d.reason}</label>)}</fieldset>}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3 rounded bg-blue-50 p-3 text-sm">{[['Subtotal',subtotal],['GST',gst],['Bill total',total],['Valid debit',adjustment],['Net payable',Math.max(0,total-adjustment)]].map(([label,n])=><div key={label}>{label}<div className="font-semibold">₹{round(n).toLocaleString('en-IN')}</div></div>)}</div>
        <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">Bill number *<input className="input mt-1" required maxLength={100} readOnly={!!legacy} value={number} onChange={e=>setNumber(e.target.value)}/></label><label className="text-sm">Bill date *<input className="input mt-1" required type="date" value={date} onChange={e=>setDate(e.target.value)}/></label></div>
        <label className="block text-sm">Freight Amount<input className="input mt-1" type="number" min="0" step="0.01" placeholder="0" readOnly={!!legacy} value={freight} onChange={e=>setFreight(e.target.value)}/></label>
        <label className="block text-sm">Purchase bill upload {legacy?'(optional replacement)':'*'}<input className="input mt-1" type="file" required={!legacy} accept=".pdf,.jpg,.jpeg,.png,.xlsx" onChange={e=>setFile(e.target.files?.[0]||null)}/></label>
        <button disabled={saving||loading||!rows.some(it=>+value(it).quantity>0)} className="btn btn-primary w-full">{saving?'Saving…':legacy?'Save item reconciliation':'Save Purchase Bill'}</button>
      </>}
    </form>
  </Modal>;
}
