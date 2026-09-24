import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import { exportCsv } from '../utils/exportCsv';
import './projectProfit.css';

const money = value => new Intl.NumberFormat('en-IN', { style:'currency',currency:'INR',maximumFractionDigits:2 }).format(value || 0);
const csvText = value => /^[=+@\-\t\r]/.test(String(value || '')) ? `'${value}` : value;
const categories = ['Overhead','Transport','Travel','Salary','Material','Labour','Revenue correction','Other'];
const today = () => new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const basisNames = {sales:'Sales invoices',client_ra:'Client RA bills',dpr:'DPR work value'};
const initial = () => ({kind:'cost',category:'Overhead',amount:'',entry_date:today(),reason:''});

export default function ProjectProfit() {
  const {can} = useAuth();
  const reviewRef = useRef(null);
  const [basis,setBasis]=useState('sales');
  const [from,setFrom]=useState(''),[to,setTo]=useState('');
  const [search,setSearch]=useState(''),[status,setStatus]=useState('all');
  const [data,setData]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(true);
  const [selected,setSelected]=useState(null),[refresh,setRefresh]=useState(0);
  const [form,setForm]=useState(initial),[saving,setSaving]=useState(false),[saveError,setSaveError]=useState('');
  const [voidId,setVoidId]=useState(null),[voidReason,setVoidReason]=useState('');
  const [notice,setNotice]=useState('');
  useEffect(() => { if (reviewRef.current) { reviewRef.current.focus({preventScroll:true}); reviewRef.current.scrollIntoView({block:'start'}); } }, [selected]);
  useEffect(()=>{
    const controller=new AbortController();setLoading(true);setError('');
    api.get('/project-profit',{params:{basis,from,to},signal:controller.signal})
      .then(r=>{if(!controller.signal.aborted)setData(r.data);})
      .catch(e=>{if(!controller.signal.aborted)setError(e.response?.data?.error || 'Could not load project totals. Retry below.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return ()=>controller.abort();
  },[basis,from,to,refresh]);
  const rows=(data?.rows || []).filter(p=>`${p.name} ${p.company_name || ''} ${p.client_name || ''} ${p.lead_no || ''}`.toLowerCase().includes(search.toLowerCase()))
    .filter(p=>status==='all'||(status==='loss'?p.has_activity&&p.profit<0:status==='profit'?p.has_activity&&p.profit>0:!p.has_activity))
    .sort((a,b)=>a.profit-b.profit);
  const totals=rows.reduce((t,p)=>({...t,revenue:t.revenue+p.revenue,cost:t.cost+p.cost,profit:t.profit+p.profit,losses:t.losses+(p.has_activity&&p.profit<0?1:0)}),{revenue:0,cost:0,profit:0,losses:0});
  const project=data?.rows.find(p=>p.id===selected);
  const change=e=>setForm(f=>({...f,[e.target.name]:e.target.value}));
  const open=p=>{setSelected(p.id);setForm({...initial(),project_id:p.id});setSaveError('');setVoidId(null);};
  const save=async e=>{
    e.preventDefault();setSaving(true);setSaveError('');
    try {await api.post('/project-profit/adjustments',{...form,project_id:Number(form.project_id || selected),basis,amount:Number(form.amount)});setForm({...initial(),project_id:Number(form.project_id || selected)});setNotice('Adjustment saved. Totals refreshed.');setRefresh(n=>n+1);}
    catch(e){setSaveError(e.response?.data?.error || 'Could not save adjustment.');}finally{setSaving(false);}
  };
  const voidEntry=async e=>{
    e.preventDefault();setSaving(true);setSaveError('');
    try {await api.post(`/project-profit/adjustments/${voidId}/void`,{reason:voidReason});setVoidId(null);setVoidReason('');setNotice('Adjustment voided. The history is retained.');setRefresh(n=>n+1);}
    catch(e){setSaveError(e.response?.data?.error || 'Could not void adjustment.');}finally{setSaving(false);}
  };
  const download=()=>exportCsv('project-profit-loss',['Project','Order','Basis','Period from','Period to','Contract ex GST','Auto revenue','Manual revenue','Auto cost','Manual cost','Profit / loss','Margin %','Data status'],rows.map(p=>[csvText(p.name),csvText(p.lead_no),basisNames[basis],from||'All time',to||'All time',p.contract_value,p.auto_revenue,p.manual_revenue,p.auto_cost,p.manual_cost,p.profit,p.margin??'',p.has_activity?'Provisional':'No activity']));
  return <main className="ppl">
    <header className="ppl-head"><div><p className="ppl-eyebrow">FINANCE / PROJECT PERFORMANCE</p><h1>Project profit & loss</h1><p>Recorded revenue, recorded costs, and the difference. Review each project before closing its books.</p></div><button className="btn-secondary" disabled={loading||!!error||!rows.length} onClick={download}>Export CSV</button></header>
    <section className="ppl-controls" aria-label="Report filters">
      <label>Revenue basis<select value={basis} onChange={e=>{setBasis(e.target.value);setSelected(null);}}>{Object.entries(basisNames).map(([k,v])=><option key={k} value={k}>{v}</option>)}</select></label>
      <label>From<input type="date" value={from} onChange={e=>setFrom(e.target.value)} /></label>
      <label>To<input type="date" value={to} onChange={e=>setTo(e.target.value)} /></label>
      <label>Find a project<input type="search" placeholder="Project, client or order…" value={search} onChange={e=>setSearch(e.target.value)} /></label>
      <label>Show<select value={status} onChange={e=>setStatus(e.target.value)}><option value="all">All projects</option><option value="loss">Loss-making</option><option value="profit">Profitable</option><option value="empty">No activity</option></select></label>
      <button className="btn-secondary" onClick={()=>setRefresh(n=>n+1)} disabled={loading}>Refresh</button>
    </section>
    <details className="ppl-method"><summary>How these totals are calculated</summary>
      <p><strong>Profit / loss = revenue − costs.</strong> Orders with the same project name are combined into one row, ignoring capitalization and extra spaces. Individual orders remain available in Review. Contract value is context only and is never counted as earned revenue.</p>
      <p>{basis==='dpr'?'DPR view: only approved, submitted actual DPRs contribute their recorded work value (A) and costs (B). Planned templates, pending and rejected reports are excluded. No invoices or payment requests are added to this view.':`${basis==='sales'?'Sales view: approved delivery and installation invoices plus approved legacy invoices, using amounts before GST. Sales orders (type 1) and final summaries (type 4) are excluded to avoid counting the same contract twice.':'Client RA view: non-cancelled client RA gross amounts, separate from sales invoices.'} Costs include linked purchase bills before GST, non-cancelled contractor RA gross amounts, and final-approved travel/transport requests at their recorded amount. Salary, overhead and other missing costs can be added manually.`}</p>
      <p>Automatic sources refresh on opening this page or clicking Refresh. Manual adjustments belong only to the selected basis. Negative cost reverses cost; negative revenue reduces revenue. Verify tax treatment, missing bills and overlaps before relying on profit. These are provisional management totals, not a final accounting statement.</p>
      <p>Date filters use invoice date, RA raised date, expense creation date and DPR report date. Undated records appear only in All time. No fuzzy name matching or automatic allocation of unlinked records.</p>
    </details>
    {notice&&<p role="status" className="ppl-notice">{notice}</p>}
    {error?<div role="alert" className="ppl-error">{error}<button onClick={()=>setRefresh(n=>n+1)}>Retry</button></div>:loading?<p role="status" className="ppl-empty">Loading project totals…</p>:<>
      <section className="ppl-summary" aria-label="Totals for filtered projects"><div><span>Recorded revenue</span><strong>{money(totals.revenue)}</strong></div><div><span>Recorded costs</span><strong>{money(totals.cost)}</strong></div><div className={totals.profit<0?'ppl-loss':'ppl-gain'}><span>Provisional profit / loss</span><strong>{money(totals.profit)}</strong></div><div><span>Projects requiring attention</span><strong>{totals.losses} <small>in loss / {rows.length} shown</small></strong></div></section>
      {(data?.warnings.unlinked_count>0||data?.warnings.undated_count>0)&&<details className="ppl-warning"><summary>{data.warnings.unlinked_count} unlinked entries · {data.warnings.undated_count} undated entries across this basis</summary><p>Unlinked entries are excluded from project totals. Correct the source project link before adding a manual amount, to avoid counting it again later.</p>{data.unlinked.slice(0,50).map(e=><p key={e.id}>{e.source} #{e.record_id} · {e.reference} · {money(e.amount)}</p>)}{data.unlinked.length>50&&<p>Showing first 50 entries.</p>}</details>}
      <div className="ppl-table-wrap"><table><caption>Project comparison · {basisNames[basis]} · amounts in rupees</caption><thead><tr><th>Project / order</th><th>Contract value</th><th>Revenue</th><th>Costs</th><th>Profit / loss</th><th>Margin</th><th>Source coverage</th><th>Details</th></tr></thead><tbody>{rows.map(p=><tr key={p.id}><td><strong>{p.name}</strong><small>{p.order_count > 1 ? `${p.order_count} orders combined` : p.lead_no || `Order #${p.id}`} · {p.client_name || p.company_name || 'Client not recorded'}</small></td><td>{money(p.contract_value)}</td><td>{money(p.revenue)}<small>Manual {money(p.manual_revenue)}</small></td><td>{money(p.cost)}<small>Manual {money(p.manual_cost)}</small></td><td className={p.profit<0?'ppl-loss':'ppl-gain'}><strong>{p.has_activity?money(p.profit):'—'}</strong></td><td>{p.margin===null?'—':`${p.margin}%`}</td><td><span>{p.has_activity?`${p.auto_count} auto / ${p.manual_count} manual`:'No recorded activity'}</span>{p.has_activity&&(!p.revenue||!p.cost)&&<small className="ppl-loss">{!p.revenue?'Revenue':'Costs'} missing or zero</small>}</td><td><button className="btn-secondary" onClick={()=>open(p)}>Review</button></td></tr>)}</tbody></table>{!rows.length&&<p className="ppl-empty">No projects match. Clear filters or add an order in <Link to="/business-book">Business Book</Link>.</p>}</div>
      {project&&<section className="ppl-detail" ref={reviewRef} tabIndex={-1} aria-label="Selected project"><header><div><p className="ppl-eyebrow">PROJECT REVIEW · {project.lead_no || project.id}</p><h2>{project.name}</h2><p>{basisNames[basis]} · {money(project.profit)} provisional profit / loss</p></div><button className="btn-secondary" onClick={()=>setSelected(null)}>Close review</button></header>
        <details className="ppl-method"><summary>{project.order_count} included orders · contract total {money(project.contract_value)}</summary>{project.orders.map(o=><p key={o.id}><strong>{o.lead_no || `Order #${o.id}`}</strong> · Contract {money(o.contract_value)} · Revenue {money(o.revenue)} · Costs {money(o.cost)} · Profit / loss {money(o.profit)}</p>)}</details><div className="ppl-detail-grid"><div><h3>Source ledger</h3><p>Only entries within the selected period are shown.</p><div className="ppl-ledger">{project.ledger.map(e=><article key={e.id}><div><strong>{e.source}</strong><span>{e.order_reference} · {e.entry_date || 'No date'} · {e.manual?'Manual':`Record #${e.record_id}`}</span><p>{e.reference}</p></div><div><small>{e.kind}</small><strong>{money(e.amount)}</strong></div></article>)}{!project.ledger.length&&<p>No entries in this period. Add missing records in the source module or a manual adjustment.</p>}</div></div>
        <div><h3>Add a manual adjustment</h3><p>For missing items or corrections only. Do not re-enter costs already in the source ledger.</p>{can('project_profit','create')?<form onSubmit={save} className="ppl-adjust">
          <label className="ppl-wide">Apply to order<select name="project_id" value={form.project_id || selected} onChange={change}>{project.orders.map(o=><option key={o.id} value={o.id}>{o.lead_no || `Order #${o.id}`}</option>)}</select></label>
          <label>Entry type<select name="kind" value={form.kind} onChange={change}><option value="cost">Cost</option><option value="revenue">Revenue</option></select></label>
          <label>Category<select name="category" value={form.category} onChange={change}>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
          <label>Date<input required type="date" name="entry_date" value={form.entry_date} onChange={change}/></label>
          <label>Amount (₹)<input required type="number" step="0.01" name="amount" value={form.amount} onChange={change}/></label>
          <label className="ppl-wide">Reason / source reference<textarea required minLength={5} maxLength={1000} name="reason" value={form.reason} onChange={change}/></label>
          <button className="btn-primary ppl-wide" disabled={saving}>{saving?'Saving…':'Save adjustment'}</button>
        </form>:<p>Ask your administrator for Create access to Project Profit & Loss to add adjustments.</p>}
        {saveError&&<p className="ppl-error" role="alert">{saveError}</p>}
        <h3>Adjustment history · all dates</h3>{project.adjustments.map(a=><article className="ppl-history" key={a.id}><strong>{a.kind} · {money(a.amount)} {a.voided_at?'· Voided':''}</strong><p>{a.reason}</p><small>{a.order_reference} · {a.entry_date} · {a.created_by_name || 'User'} · {a.created_at}</small>{a.voided_at?<p>Voided by {a.voided_by_name || 'User'}: {a.void_reason}</p>:can('project_profit','delete')&&<button disabled={saving} onClick={()=>{setVoidId(a.id);setVoidReason('');}}>Void adjustment</button>}</article>)}
        {voidId&&<form onSubmit={voidEntry} className="ppl-adjust"><label className="ppl-wide">Reason for voiding #{voidId}<input required minLength={5} maxLength={1000} value={voidReason} onChange={e=>setVoidReason(e.target.value)}/></label><button disabled={saving} className="btn-secondary">Confirm void</button><button type="button" onClick={()=>setVoidId(null)}>Cancel</button></form>}
        </div></div>
      </section>}
    </>}
  </main>;
}
