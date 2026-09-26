import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { indiaDay } from '../utils/dashboardWorkGroups.mjs';
const day=stamp=>new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(stamp));
const groupOf=r=>{
  if(!r.roles.some(role=>['responsible','accountable'].includes(role)))return 'info';
  if(!r.current)return 'waiting';
  const stamp=r.due_at||r.started_at;
  if(!stamp)return 'undated';
  const value=day(stamp),today=indiaDay();return value<today?'previous':value===today?'today':'upcoming';
};
export default function DashboardRaci(){
  const [data,setData]=useState({rows:[],unavailable:[]}),[error,setError]=useState(''),[refresh,setRefresh]=useState(0),[loading,setLoading]=useState(true);
  useEffect(()=>{
    let active=true,sequence=0;
    const load=async()=>{const n=++sequence;try{const r=await api.get('/raci/my-work');if(active&&n===sequence){setData(r.data);setError('');}}catch{if(active&&n===sequence)setError('Could not refresh RACI work. Please retry.');}finally{if(active&&n===sequence)setLoading(false);}};
    load();const tick=()=>{if(!document.hidden)load();};const timer=setInterval(tick,60000);window.addEventListener('focus',tick);
    return()=>{active=false;clearInterval(timer);window.removeEventListener('focus',tick);};
  },[refresh]);
  return <section className="card" aria-label="My Assigned Records"><div className="flex justify-between gap-3 mb-3"><h3 className="font-semibold">My Assigned Records</h3><button className="btn btn-secondary text-xs" onClick={()=>setRefresh(n=>n+1)}>Refresh records</button></div><p className="text-xs text-gray-500 mb-4">Records currently at a step where you are Responsible or Accountable. Due dates use the assigned SLA; without an SLA, groups use the date the record entered its current step.</p>
    {loading&&<p>Loading workflow steps…</p>}{error&&<p role="alert" className="text-red-700">{error}</p>}{data.unavailable.length>0&&<p className="text-amber-700 text-sm">Some modules could not be loaded: {data.unavailable.join(', ')}</p>}
    <div className="space-y-4">{[['today',"Today's Pending Tasks"],['previous','Previous Pending Tasks'],['upcoming','Upcoming Tasks'],['waiting','Waiting for Previous Step'],['undated','Timing Not Configured'],['info','Consulted / Informed']].map(([key,label])=>{
      const rows=data.rows.filter(r=>groupOf(r)===key);if(!rows.length&&!['today','previous'].includes(key))return null;
      return <section key={key} className="space-y-2"><h4 className={`font-semibold text-sm ${key==='previous'?'text-red-700':'text-indigo-800'}`}>{label} ({rows.length})</h4>{!loading&&!error&&!rows.length&&<p className="text-xs text-gray-500">No steps in this group.</p>}{rows.length>0&&<div className="overflow-x-auto"><table className="w-full text-xs"><thead><tr>{['Record / Client','Company / Site','Module / Stage','Your Role','Responsible / Accountable','Due / Pending Since','Action'].map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.key}><td><span className="font-semibold">{r.title}</span><br/>{r.subtitle}</td><td>{r.company||r.location||'—'}</td><td>{r.module_label}<br/><span className="text-indigo-700">{r.step}</span></td><td className="capitalize">{r.roles.join(' / ')}</td><td>{r.responsible||'Not assigned'}<br/>{r.accountable||'Not assigned'}</td><td>{r.due_at?new Date(r.due_at).toLocaleString('en-IN',{timeZone:'Asia/Kolkata'}):r.started_at?day(r.started_at):'Not configured'}<br/>{r.due_at?'SLA due (IST)':'Pending since · no SLA'}</td><td><Link className="text-indigo-700 underline" to={r.path}>Open records →</Link></td></tr>)}</tbody></table></div>}</section>;
    })}</div>
  </section>;
}
