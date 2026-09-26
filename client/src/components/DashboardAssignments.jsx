import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { workGroup, workGroups } from '../utils/dashboardWorkGroups.mjs';
import { TicketAction } from './DashboardHelpTickets';
import ProofPreview from './ProofPreview';

export default function DashboardAssignments({ checklists = false }) {
  const { user } = useAuth();
  const [rows,setRows] = useState([]),[back,setBack] = useState(30),[window,setWindow] = useState(null);
  const [loading,setLoading] = useState(true),[error,setError] = useState(''),[action,setAction] = useState(null),[showDone,setShowDone] = useState(false);
  const requests = useRef({sequence:0});
  const title = checklists ? 'Checklists' : 'Delegation Tasks';
  const load = useCallback(async () => {
    const state=requests.current,current=++state.sequence;
    try {
      const response=await api.get(checklists ? `/hr/checklists/my-work?back=${back}` : '/delegations?scope=mine');
      if(current!==state.sequence)return;
      const data=checklists ? response.data.rows : response.data;
      setRows(data.map(t=>({...t,key:t.key || String(t.id),assignmentType:checklists?'checklists':'delegations',ticket_no:`#${t.id}${t.occurrence ? ` · ${t.occurrence}`:''}`,subject:t.title || t.description})));
      setWindow(checklists ? {from:response.data.from,to:response.data.to} : null);setError('');
    } catch {if(current===state.sequence)setError(`Could not refresh ${checklists?'checklists':'delegations'}. Please retry.`);}
    finally {if(current===state.sequence)setLoading(false);}
  },[checklists,back]);
  useEffect(()=>{
    const state=requests.current;
    // Retrieve the existing assignment state; updates occur after the API response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const refresh=()=>{if(!document.hidden)load();};
    const timer=setInterval(refresh,30000);globalThis.window.addEventListener('focus',refresh);
    return ()=>{state.sequence++;clearInterval(timer);globalThis.window.removeEventListener('focus',refresh);};
  },[load,user.id]);
  return <section className="card border-l-4 border-emerald-400" aria-label={`Dashboard ${title}`}>
    <div className="flex flex-wrap justify-between items-center gap-2 mb-3"><h3 className="font-semibold">{title}</h3><div className="flex gap-3 items-center"><button className="btn btn-secondary text-xs" onClick={load}>Refresh {title}</button><Link className="text-xs text-indigo-700" to={checklists?'/checklists':'/delegations'}>Open {title} →</Link></div></div>
    <p className="text-xs text-gray-500 mb-3">Assigned to you by management. Submitted work stays awaiting approval until reviewed. Updates every 30 seconds.</p>
    <div className="flex flex-wrap gap-3 items-center mb-3">{checklists && <label className="text-xs">Previous work <select className="input ml-2" value={back} onChange={e=>setBack(+e.target.value)}>{[7,30,90,365].map(n=><option value={n} key={n}>Last {n} days</option>)}</select></label>}<label className="text-xs flex gap-2"><input type="checkbox" checked={showDone} onChange={e=>setShowDone(e.target.checked)}/>Show approved</label></div>
    {window && <p className="text-xs text-gray-500 mb-3">Checklist occurrences: {window.from} to {window.to}. Existing recurrence and absence rules apply. Earlier dates remain in the checklist register.</p>}
    {loading && <p role="status">Loading…</p>}{error && <p role="alert" className="text-red-700 text-sm">{error}</p>}
    <div className="space-y-4 max-h-[42rem] overflow-y-auto">{workGroups.filter(([key])=>key!=='closed'||showDone).map(([key,label])=>{
      const group=rows.filter(t=>workGroup(t)===key);
      if(!group.length&&!['today','previous'].includes(key))return null;
      return <section key={key} className="space-y-2"><h4 className={`font-semibold text-sm ${key==='previous'?'text-red-700':'text-indigo-800'}`}>{key==='closed'?'Approved / Completed':label} ({group.length})</h4>{!loading&&!error&&!group.length&&<p className="text-xs text-gray-500">No tasks in this group.</p>}
        {group.map(t=><article key={t.key} className="border rounded-lg p-3 space-y-2 bg-white"><h5 className="font-semibold text-sm">{t.subject}</h5><p className="text-xs text-gray-500">{t.assigned_by_name ? `Assigned by ${t.assigned_by_name} · `:''}{t.due_date ? `Due ${t.due_date}`:'No due date'}{checklists?` · ${t.frequency}${t.due_time?` · ${t.due_time}`:''}`:''}</p>
          <p className="text-xs">{t.status==='submitted'?'Submitted for Approval':t.status==='approved'?'Approved / Completed':t.status==='rejected'?'Changes requested':'Pending'}</p>
          {t.reject_reason&&<p className="text-sm text-red-700">{t.reject_reason}</p>}{t.extension_status==='pending'&&<p className="text-xs text-amber-700">Requested deadline {t.requested_due_date} — awaiting management approval</p>}
          {t.proof_url&&<details><summary className="cursor-pointer text-xs text-indigo-700">View submitted proof</summary><ProofPreview url={t.proof_url} reviewOnly/></details>}{(t.proof_notes||t.proof_remarks)&&<p className="text-sm whitespace-pre-wrap">{t.proof_notes||t.proof_remarks}</p>}
          {!error&&['pending','open','rejected','active'].includes(t.status)&&<button className="btn btn-primary text-xs" onClick={()=>setAction({ticket:t,kind:'proof'})}>{checklists&&['text','none'].includes(t.proof_type)?'Submit completion':'Upload proof'}</button>}
        </article>)}
      </section>;
    })}</div>
    {action&&<TicketAction action={action} key={action.ticket.key} onClose={()=>setAction(null)} onSaved={()=>{setAction(null);load();}}/>}
  </section>;
}
