import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';

const labels = {not_selected:'Select make',pending:'Pending approval',approved:'Approved',rejected:'Rejected',needs_resubmission:'BOQ changed — submit again'};
export default function MakeApproval({ orders }) {
  const { canEdit, isAdmin } = useAuth();
  const [poId,setPoId]=useState('');
  const [data,setData]=useState({items:[],makes:[]});
  const [drafts,setDrafts]=useState({});
  const [loading,setLoading]=useState(false);
  const [busy,setBusy]=useState(null);
  const [error,setError]=useState('');
  const [version,setVersion]=useState(0);
  useEffect(()=>{
    let active=true;
    setData({items:[],makes:[]});setDrafts({});setError('');
    if(!poId) return ()=>{active=false;};
    setLoading(true);
    api.get(`/orders/make-approval/${poId}`).then(r=>{if(active){setData(r.data);setDrafts(Object.fromEntries(r.data.items.map(i=>[i.id,i.selected_make || ''])));}})
      .catch(e=>{if(active)setError(e.response?.data?.error || 'Could not load BOQ items');})
      .finally(()=>{if(active)setLoading(false);});
    return ()=>{active=false;};
  },[poId,version]);
  const act=async(i,status)=>{
    setBusy(i.id);
    try{
      if(status) await api.post(`/orders/make-approval/${poId}/${i.id}/review`,{status,make:i.selected_make});
      else await api.put(`/orders/make-approval/${poId}/${i.id}`,{make:drafts[i.id]});
      toast.success(status==='approved'?'Make approved':status==='rejected'?'Make rejected':'Make submitted');
      setVersion(v=>v+1);
    }catch(e){toast.error(e.response?.data?.error || 'Could not save');}
    finally{setBusy(null);}
  };
  return <section className="space-y-4">
    <div><h3 className="font-semibold text-lg">Make Approval</h3><p className="text-sm text-gray-500">Select the brand / make for each BOQ item. Admin approves the selection for procurement.</p></div>
    <label className="block max-w-xl"><span className="label">Purchase order / project</span>
      <select className="select w-full" value={poId} disabled={busy!==null} onChange={e=>setPoId(e.target.value)}>
        <option value="">Select an order</option>
        {[...new Map(orders.map(p=>[p.id,p])).values()].map(p=><option key={p.id} value={p.id}>{p.po_number} — {p.bb_project || p.bb_client || p.company_name || ''}</option>)}
      </select>
    </label>
    {error && <div role="alert" className="text-red-600">{error} <button onClick={()=>setVersion(v=>v+1)} className="underline">Retry</button></div>}
    {loading?<p className="text-gray-500">Loading BOQ items…</p>:!poId?<p className="text-gray-500">Choose an order to review its makes.</p>:!error && <div className="card p-0 overflow-x-auto"><table className="w-full text-sm min-w-[750px]">
      <thead><tr><th>BOQ item</th><th>Quantity</th><th>Brand / make</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>{data.items.map(i=><tr key={i.id}>
        <td className="max-w-sm whitespace-normal">{i.description}</td><td>{i.quantity} {i.unit}</td>
        <td className="min-w-[220px]"><input aria-label={`Make for ${i.description}`} className="input w-full" list="po-make-options" placeholder="Choose or type make" maxLength={120} disabled={!canEdit('orders') || busy!==null} value={drafts[i.id] || ''} onChange={e=>setDrafts(d=>({...d,[i.id]:e.target.value}))}/></td>
        <td><span className={i.make_status==='approved'?'text-emerald-700':i.make_status==='rejected'?'text-red-600':'text-amber-700'}>{labels[i.make_status]}</span>{i.reviewed_by_name && <div className="text-xs text-gray-500">{i.reviewed_by_name} · {i.reviewed_at}</div>}</td>
        <td><div className="flex flex-wrap gap-2">
          {canEdit('orders') && <button className="btn btn-secondary text-xs" disabled={busy!==null || !(drafts[i.id] || '').trim()} onClick={()=>act(i)}>{busy===i.id?'Saving…':'Submit make'}</button>}
          {isAdmin() && i.make_status==='pending' && <><button className="btn btn-primary text-xs" disabled={busy!==null || drafts[i.id]!==i.selected_make} onClick={()=>act(i,'approved')}>Approve</button><button className="btn btn-secondary text-xs" disabled={busy!==null || drafts[i.id]!==i.selected_make} onClick={()=>act(i,'rejected')}>Reject</button></>}
        </div></td>
      </tr>)}{data.items.length===0 && <tr><td colSpan={5} className="text-center py-8 text-gray-500">No BOQ items saved for this order.</td></tr>}</tbody>
    </table></div>}
    <datalist id="po-make-options">{data.makes.map(m=><option key={m} value={m}/>)}</datalist>
  </section>;
}
