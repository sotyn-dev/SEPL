import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import ProofPreview from '../components/ProofPreview';

const today = () => new Intl.DateTimeFormat('en-CA', { timeZone:'Asia/Kolkata',year:'numeric',month:'2-digit',day:'2-digit' }).format(new Date());
const time = n => `${String(Math.floor(n % 1440 / 60)).padStart(2,'0')}:${String(n % 60).padStart(2,'0')}${n>=1440 ? ' (+1 day)':''}`;
const label = {planned:'Not started',running:'In progress',paused:'Paused',blocked:'Blocked',submitted:'Submitted for Approval',approved:'Approved / Completed'};
const base = t => t.source==='pms_tasks' ? `/pms-tasks/${t.id}` : t.source==='checklists' ? `/hr/checklists/${t.id}` : `/delegations/${t.id}`;
const errorText = e => e.response?.data?.error || e.message || 'Request failed';
const input = 'input w-full';
const button = 'btn btn-secondary text-xs';
const Field = ({title,children}) => <label className="block text-sm space-y-1"><span className="font-medium text-gray-700">{title}</span>{children}</label>;

function Dialog({title,onClose,children}) {
  const ref=useRef(null);
  useEffect(()=>{ const d=ref.current; d.showModal(); return ()=>d.close(); },[]);
  return <dialog ref={ref} onCancel={onClose} className="rounded-2xl p-0 w-[min(94vw,720px)] max-h-[90vh] backdrop:bg-black/40">
    <div className="p-5 border-b flex justify-between gap-4"><h2 className="text-lg font-semibold">{title}</h2><button aria-label="Close dialog" onClick={onClose}>✕</button></div>
    <div className="p-5">{children}</div>
  </dialog>;
}
function PlanEditor({task,tasks,date,userId,onSave,busy,schedule}) {
  const p=task.plan;
  const defaultStart=schedule.spans[0]?.[0] ?? 0;
  const [form,setForm]=useState({work_date:p?.work_date || date,start:time(p?.start_minute ?? defaultStart).slice(0,5),nextDay:(p?.start_minute ?? defaultStart)>=1440,
    duration:p?.duration || 30,priority:p?.priority || 'normal',steps:p?.steps || [{title:'Prepare and check required documents',duration:10,done:false},{title:'Finish work and review proof',duration:20,done:false}],
    instructions:p?.instructions || '',documents:(p?.documents || []).join('\n'),dependencies:p?.dependencies || [],reason:''});
  const set=(key,value)=>setForm(f=>({...f,[key]:value}));
  const submit=e=> {e.preventDefault(); const [h,m]=form.start.split(':').map(Number); onSave(`/daily-work/plan/${task.source}/${task.id}`,{
    ...form,user_id:userId,occurrence:task.occurrence,version:p?.version,start_minute:h*60+m+(form.nextDay?1440:0),duration:+form.duration,
    documents:form.documents.split('\n').map(s=>s.trim()).filter(Boolean),steps:form.steps.map(s=>({...s,duration:+s.duration}))},'put');};
  return <form onSubmit={submit} className="space-y-4">
    <p className="text-sm text-gray-600">Planning changes are recorded with your reason. The source deadline stays {task.due_date || 'unset'}.</p>
    <div className="grid grid-cols-2 gap-3">
      <Field title="Planned work date"><input className={input} type="date" required value={form.work_date} disabled={task.source==='checklists'} onChange={e=>set('work_date',e.target.value)}/></Field>
      <Field title="Start time (IST)"><input className={input} type="time" required value={form.start} onChange={e=>set('start',e.target.value)}/></Field>
      <Field title="Estimated minutes"><input className={input} type="number" min="1" max="1440" required value={form.duration} onChange={e=>set('duration',e.target.value)}/></Field>
      <Field title="Priority"><select className={input} value={form.priority} onChange={e=>set('priority',e.target.value)}>{['urgent','high','normal','low'].map(s=><option key={s}>{s}</option>)}</select></Field>
    </div>
    <label className="text-sm flex gap-2"><input type="checkbox" checked={form.nextDay} onChange={e=>set('nextDay',e.target.checked)}/>After midnight in this overnight shift</label>
    <div className="space-y-2"><h3 className="font-semibold">Steps and planned duration</h3>
      {form.steps.map((s,i)=><div className="flex gap-2 items-center" key={i}>
        <input aria-label={`Step ${i+1} instructions`} className={input} required maxLength="500" value={s.title} onChange={e=>set('steps',form.steps.map((x,j)=>j===i?{...x,title:e.target.value}:x))}/>
        <input aria-label={`Step ${i+1} minutes`} className="input w-20" type="number" min="1" required value={s.duration} onChange={e=>set('steps',form.steps.map((x,j)=>j===i?{...x,duration:e.target.value}:x))}/>
        <button type="button" aria-label={`Remove step ${i+1}`} onClick={()=>set('steps',form.steps.filter((_,j)=>j!==i))}>✕</button>
      </div>)}
      <button type="button" className={button} onClick={()=>set('steps',[...form.steps,{title:'',duration:10,done:false}])}>+ Add step</button>
    </div>
    <Field title="Instructions"><textarea className={input} rows="3" maxLength="5000" value={form.instructions} onChange={e=>set('instructions',e.target.value)}/></Field>
    <Field title="Required document links (one per line)"><textarea className={input} rows="2" value={form.documents} onChange={e=>set('documents',e.target.value)} placeholder="https://…"/></Field>
    <fieldset className="border rounded p-3 max-h-40 overflow-y-auto"><legend className="text-sm">Dependencies — must be approved before starting</legend>
      {tasks.filter(t=>t.key!==task.key).map(t=> {
        const checked=form.dependencies.some(d=>d.source===t.source && d.id===t.id && (d.occurrence || '')===t.occurrence);
        return <label key={t.key} className="flex gap-2 text-sm py-1"><input type="checkbox" checked={checked} onChange={()=>set('dependencies',checked?form.dependencies.filter(d=>!(d.source===t.source && d.id===t.id && (d.occurrence || '')===t.occurrence)):[...form.dependencies,{source:t.source,id:t.id,occurrence:t.occurrence}])}/>{t.title}</label>;
      })}
    </fieldset>
    <Field title="Reason for this plan / change"><textarea className={input} required maxLength="2000" value={form.reason} onChange={e=>set('reason',e.target.value)}/></Field>
    <button disabled={busy} className="btn btn-primary">{busy?'Saving…':'Save daily plan'}</button>
  </form>;
}
function ProofForm({task,onSave,busy,date}) {
  const [file,setFile]=useState(null), [localUrl,setLocalUrl]=useState(''),[uploaded,setUploaded]=useState(null),[progress,setProgress]=useState(0),[uploading,setUploading]=useState(false),[notes,setNotes]=useState(''),[checked,setChecked]=useState(false);
  const upload=useRef(null);
  const preview=useRef('');
  useEffect(()=>()=>{upload.current?.abort();if(preview.current)URL.revokeObjectURL(preview.current);},[]);
  const choose=async f=> {
    upload.current?.abort();setFile(f || null);setUploaded(null);setChecked(false);setProgress(0);
    if(preview.current)URL.revokeObjectURL(preview.current);
    preview.current=f?URL.createObjectURL(f):'';setLocalUrl(preview.current);
    if(!f) {setUploading(false);return;}
    const control=new AbortController(); upload.current=control;setUploading(true);
    try {
      const fd=new FormData();fd.append('file',f);
      const {data}=await api.post('/upload',fd,{signal:control.signal,onUploadProgress:e=>setProgress(e.total?Math.round(e.loaded/e.total*100):0)});
      if(!control.signal.aborted) setUploaded({url:data.url,name:f.name,type:f.type});
    } catch(e) {if(!control.signal.aborted) toast.error(errorText(e));}
    finally {if(!control.signal.aborted) setUploading(false);}
  };
  const requiredFile=!['none','text'].includes(task.proof_type);
  const submit=e=> { e.preventDefault(); onSave(`${base(task)}/${task.source==='checklists'?'complete':'submit'}`,{
    proof_url:uploaded?.url || null,proof_remarks:notes,notes,completion_date:task.occurrence || date,
  });};
  return <form onSubmit={submit} className="space-y-4">
    <p className="text-sm text-gray-600">This submits your work for review. It becomes completed only after approval.</p>
    {task.reject_reason && <p className="rounded bg-red-50 p-3 text-red-800">Previous rejection: {task.reject_reason}</p>}
    <p className="text-sm">Required proof: <b>{task.proof_type}</b></p>
    <div className="grid grid-cols-2 gap-3">
      <label className={`${button} cursor-pointer text-center`}>Take photo<input className="sr-only" type="file" accept="image/*" capture="environment" disabled={busy} onChange={e=>{choose(e.target.files[0]);e.target.value='';}}/></label>
      <label className={`${button} cursor-pointer text-center`}>Choose file<input className="sr-only" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx" disabled={busy} onChange={e=>{choose(e.target.files[0]);e.target.value='';}}/></label>
    </div>
    {uploading && <div role="status" className="text-sm text-blue-700">Uploading: {progress}%<progress value={progress} max="100" className="block w-full"/></div>}
    {(uploaded?.url || localUrl) && <ProofPreview key={uploaded?.url || localUrl} url={uploaded?.url || localUrl} name={file?.name} type={file?.type}/>}
    {file && !uploading && !uploaded && <p role="alert" className="text-red-700">Upload failed. Choose the file again to retry; it has not been submitted.</p>}
    {file && <button type="button" className={button} disabled={busy} onClick={()=>choose(null)}>Remove proof</button>}
    <Field title={task.proof_type==='text'?'Required completion note':'Remarks (up to 300 words)'}><textarea className={input} rows="3" required={task.proof_type==='text'} value={notes} onChange={e=>setNotes(e.target.value)}/></Field>
    <label className="flex gap-2 text-sm"><input type="checkbox" required checked={checked} onChange={e=>setChecked(e.target.checked)}/>I checked the proof and completion details.</label>
    <button className="btn btn-primary" disabled={busy || uploading || (requiredFile&&!uploaded) || (!!file&&!uploaded) || !checked || notes.trim().split(/\s+/).length>300}>Submit for Approval</button>
  </form>;
}
function ReasonForm({title,onSubmit,busy,extension=false,approve=false}) {
  const [reason,setReason]=useState(''),[day,setDay]=useState('');
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();onSubmit({reason,requested_due_date:day,note:reason});}}>
    <p className="text-sm text-gray-600">{title}</p>
    {extension && <Field title="Requested deadline"><input type="date" className={input} required value={day} onChange={e=>setDay(e.target.value)}/></Field>}
    <Field title={approve?'Review note':'Reason'}><textarea className={input} required={!approve} maxLength="2000" value={reason} onChange={e=>setReason(e.target.value)}/></Field>
    <button className="btn btn-primary" disabled={busy}>Confirm</button>
  </form>;
}
function ReviewForm({data,onSave,busy}) {
  const unfinished=data.tasks.filter(t=>(t.scheduled || t.overdue || t.due_date===data.date || t.status==='submitted') && t.status!=='approved');
  const [entries,setEntries]=useState(unfinished.map(t=>({key:t.key,title:t.title,reason:t.plan?.blocker || '',next_action:''}))),[summary,setSummary]=useState('');
  const set=(i,key,value)=>setEntries(rows=>rows.map((r,j)=>i===j?{...r,[key]:value}:r));
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();onSave('/daily-work/review',{date:data.date,entries,summary});}}>
    <p className="text-sm text-gray-600">Record what remains and the next action. Saving does not move tasks, extend deadlines, affect salary, or restrict attendance checkout.</p>
    {!entries.length && <p>All work for this day is complete.</p>}
    {entries.map((r,i)=><fieldset key={r.key} className="rounded border p-3 space-y-2"><legend className="font-semibold text-sm">{r.title}</legend>
      <Field title="Why is this unfinished / awaiting approval?"><textarea className={input} required maxLength="2000" value={r.reason} onChange={e=>set(i,'reason',e.target.value)}/></Field>
      <Field title="Next planned action"><textarea className={input} required maxLength="2000" value={r.next_action} onChange={e=>set(i,'next_action',e.target.value)}/></Field>
    </fieldset>)}
    <Field title="Day summary"><textarea className={input} maxLength="5000" value={summary} onChange={e=>setSummary(e.target.value)}/></Field>
    <button className="btn btn-primary" disabled={busy}>Save end-of-day review</button>
  </form>;
}
function ScheduleForm({data,onSave,busy}) {
  const [config,setConfig]=useState(data.schedule.config),[reason,setReason]=useState('');
  return <form className="space-y-4" onSubmit={e=>{e.preventDefault();onSave('/daily-work/schedule',{user_id:data.user.id,config,reason},'put');}}>
    <p className="text-sm text-gray-600">Planning hours in IST. An end time earlier than the start means an overnight shift. This does not change payroll or attendance rules.</p>
    <div className="grid grid-cols-2 gap-3">{['start','end'].map(key=><Field key={key} title={`Shift ${key}`}><input className={input} type="time" required value={config[key]} onChange={e=>setConfig({...config,[key]:e.target.value})}/></Field>)}</div>
    <fieldset className="flex flex-wrap gap-3"><legend className="text-sm mb-2">Working days</legend>{['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].map((s,i)=><label key={s} className="text-sm flex gap-1"><input type="checkbox" checked={config.weekdays.includes(i)} onChange={()=>setConfig({...config,weekdays:config.weekdays.includes(i)?config.weekdays.filter(d=>d!==i):[...config.weekdays,i]})}/>{s}</label>)}</fieldset>
    {config.breaks.map((b,i)=><div key={i} className="flex gap-2">{['start','end'].map(k=><input key={k} aria-label={`Break ${i+1} ${k}`} type="time" required className={input} value={b[k]} onChange={e=>setConfig({...config,breaks:config.breaks.map((x,j)=>j===i?{...x,[k]:e.target.value}:x)})}/>)}<button type="button" aria-label="Remove break" onClick={()=>setConfig({...config,breaks:config.breaks.filter((_,j)=>j!==i)})}>✕</button></div>)}
    <button type="button" className={button} onClick={()=>setConfig({...config,breaks:[...config.breaks,{start:'13:00',end:'13:30'}]})}>+ Add break</button>
    <Field title="Reason"><textarea className={input} required value={reason} onChange={e=>setReason(e.target.value)}/></Field>
    <button className="btn btn-primary" disabled={busy}>Save schedule</button>
  </form>;
}

export default function DailyWork({ embedded = false }) {
  const Heading = embedded ? 'h2' : 'h1';
  const {user,canApprove}=useAuth();
  const [date,setDate]=useState(today),[userId,setUserId]=useState(user.id),[data,setData]=useState(null),[team,setTeam]=useState([]),[tab,setTab]=useState('mine'),[loading,setLoading]=useState(true),[error,setError]=useState(''),[busy,setBusy]=useState(false),[modal,setModal]=useState(null),[history,setHistory]=useState([]);
  const sequence=useRef(0), mounted=useRef(true);
  const [approvals,setApprovals]=useState([]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const load=useCallback(async()=> {
    const seq=++sequence.current;setLoading(true);setError('');
    try { const [day,group,queue]=await Promise.all([api.get('/daily-work',{params:{date,user_id:userId}}),api.get('/daily-work/team',{params:{date}}),api.get('/daily-work/approvals')]); if(seq===sequence.current&&mounted.current){setData(day.data);setTeam(group.data);setApprovals(queue.data);} }
    catch(e){if(seq===sequence.current)setError(errorText(e));}
    finally{if(seq===sequence.current)setLoading(false);}
  },[date,userId]);
  useEffect(()=>{const timer=setTimeout(()=>load(),0);return()=>clearTimeout(timer);},[load]);
  useEffect(()=> { const refresh=()=>{if(document.visibilityState==='visible'&&!modal&&!busy)load();};const timer=setInterval(refresh,60000);window.addEventListener('focus',refresh);return()=>{clearInterval(timer);window.removeEventListener('focus',refresh);}; },[load,modal,busy]);
  const save=async(url,body,method='post',close=true)=> {
    if(busy)return;setBusy(true);
    try {const {data:r}=await api[method](url,body);toast.success(r.message || 'Saved');if(close)setModal(null);await load();}
    catch(e){toast.error(errorText(e));if(e.response?.status===409)await load();}
    finally{if(mounted.current)setBusy(false);}
  };
  const action=(t,a,extra={})=>save(`/daily-work/plan/${t.plan.id}/action`,{action:a,version:t.plan.version,...extra},'post',false);
  const openHistory=async t=>{try{const r=await api.get(`/daily-work/history/${t.source}/${t.id}`,{params:{user_id:userId,occurrence:t.occurrence}});setHistory(r.data);setModal({kind:'history',task:t});}catch(e){toast.error(errorText(e));}};
  const mine=+userId===user.id;
  const actionable=data?.tasks.filter(t=>t.scheduled&&!t.schedule_conflict&&!['submitted','approved','blocked'].includes(t.status)&&!t.dependencies.some(d=>!d.complete)) || [];
  const now=actionable.find(t=>t.status==='running') || (data?.schedule.spans.some(([a,b])=>data.now_minute>=a&&data.now_minute<b) ? actionable.find(t=>t.plan.start_minute<=data.now_minute) : null);
  const next=actionable.find(t=>t.key!==now?.key);
  const decision=(t,status)=>setModal({kind:'decision',task:t,status});
  const renderTask=t=><article key={t.key} className={`bg-white border rounded-xl p-4 space-y-3 ${t.key===now?.key?'border-blue-500 ring-1 ring-blue-100':''}`}>
    <div className="flex flex-wrap gap-3 justify-between"><div className="min-w-0 flex-1">
      <div className="text-xs text-gray-500 uppercase tracking-wide">{t.source.replace('_',' ')} · #{t.id}{t.occurrence&&` · ${t.occurrence}`}</div>
      <h3 className="font-semibold text-gray-900 break-words">{t.title}</h3>
    </div><span className={`text-xs rounded-full px-3 py-1 h-fit ${t.status==='approved'?'bg-green-100 text-green-800':t.status==='submitted'?'bg-purple-100 text-purple-800':t.status==='blocked'?'bg-red-100 text-red-800':'bg-blue-50 text-blue-800'}`}>{label[t.status]}</span></div>
    <div className="flex flex-wrap gap-2 text-xs">
      {t.key===now?.key&&<b className="text-blue-700">Do Now</b>}{t.key===next?.key&&<b className="text-indigo-700">Up Next</b>}
      {t.overdue&&<b className="text-red-700">Overdue</b>}
      <span>Deadline: {t.due_date || 'Not set by source'}</span>
      {t.plan&&<><span>Priority: {t.plan.priority}</span><span>{t.plan.duration} min estimated</span><span>Tracked: {Math.floor(t.plan.elapsed_seconds/60)} min{t.status==='running'?' + running':''}</span></>}
    </div>
    {t.plan&&<p className="text-sm text-gray-700">{t.plan.work_date} · {time(t.plan.start_minute)} – {time(t.plan.start_minute+t.plan.duration)} IST{!t.scheduled&&' · Not scheduled for the selected day'}</p>}
    {!t.plan&&<p className="text-sm text-amber-800">{['approved','submitted'].includes(t.status)?'No daily plan was recorded for this work.':'Needs a daily plan — choose a time and steps.'}</p>}
    {t.plan?.blocker&&<p className="bg-red-50 rounded p-2 text-sm text-red-800">Blocker: {t.plan.blocker}</p>}
    {t.schedule_conflict&&<p className="bg-amber-50 rounded p-2 text-sm text-amber-800">Schedule changed: this plan now overlaps unavailable time. Review and explicitly reschedule it.</p>}
    {t.extension_status==='pending'&&<p className="text-sm text-amber-800">More time requested: {t.requested_due_date} — {t.extension_reason}</p>}
    {t.plan?.steps?.length>0&&<ol className="space-y-2">{t.plan.steps.map((s,i)=><li key={i} className="flex items-start gap-2 text-sm">
      <input className="mt-1" type="checkbox" aria-label={`Complete step: ${s.title}`} checked={s.done} disabled={!mine||busy||['approved','submitted'].includes(t.status)} onChange={e=>action(t,'step',{index:i,done:e.target.checked})}/>
      <span className={s.done?'line-through text-gray-400':''}><span className="font-mono text-xs">{time(s.start_minute)}–{time(s.start_minute+s.duration)}</span> · {s.title}</span>
    </li>)}</ol>}
    <details className="text-sm"><summary className="cursor-pointer text-blue-700">Instructions, documents, dependencies & approval</summary><div className="mt-2 space-y-2 text-gray-700">
      <p className="whitespace-pre-wrap">{t.description || 'No source instructions provided.'}</p>{t.plan?.instructions&&<p className="whitespace-pre-wrap">{t.plan.instructions}</p>}
      <p>Approval: {t.approver}</p>
      {t.attachment_url&&<a className="block text-blue-700 underline" href={t.attachment_url} target="_blank" rel="noreferrer">Source attachment</a>}
      {(t.plan?.documents || []).map((d,i)=><a key={i} className="block text-blue-700 underline break-all" href={d} target="_blank" rel="noreferrer">Required document {i+1}</a>)}
      {t.dependencies.length?t.dependencies.map(d=><p key={`${d.source}:${d.id}:${d.occurrence}`}>{d.complete?'✓':'Waiting for approval:'} {d.title}</p>):<p>No dependencies recorded.</p>}
      {t.proof_url&&<ProofPreview key={t.proof_url} url={t.proof_url} reviewOnly/>}
    </div></details>
    <div className="flex flex-wrap gap-2">
      {!['submitted','approved'].includes(t.status)&&<button className={button} disabled={busy} onClick={()=>setModal({kind:'plan',task:t})}>{t.plan?'Edit / reschedule':'Plan task'}</button>}
      {mine&&t.plan&&!['submitted','approved'].includes(t.status)&&<>
        {t.status==='planned'&&<button className="btn btn-primary text-xs" disabled={busy||!t.scheduled} onClick={()=>action(t,'start')}>Start</button>}
        {t.status==='running'&&<button className={button} disabled={busy} onClick={()=>action(t,'pause')}>Pause</button>}
        {t.status==='paused'&&<button className={button} disabled={busy||!t.scheduled} onClick={()=>action(t,'resume')}>Resume</button>}
        {t.status==='blocked'&&<button className={button} onClick={()=>setModal({kind:'resume',task:t})}>Resolve & resume</button>}
        <button className={button} onClick={()=>setModal({kind:'block',task:t})}>Report blocker</button>
      </>}
      {mine&&!['submitted','approved'].includes(t.status)&&<button className="btn btn-primary text-xs" disabled={busy || (t.plan?.steps || []).some(s=>!s.done) || t.dependencies.some(d=>!d.complete)} onClick={()=>setModal({kind:'proof',task:t})}>Complete work / upload proof</button>}
      {mine&&t.can_extend&&<button className={button} onClick={()=>setModal({kind:'extension',task:t})}>Request more time</button>}
      {t.source_status==='submitted'&&t.can_approve&&<><button className={button} onClick={()=>decision(t,'approved')}>Review & approve</button><button className={button} onClick={()=>decision(t,'rejected')}>Reject</button></>}
      {t.extension_status==='pending'&&t.can_approve_extension&&<><button className={button} disabled={busy} onClick={()=>save(`${base(t)}/approve-extension`,{})}>Approve extension</button><button className={button} disabled={busy} onClick={()=>save(`${base(t)}/reject-extension`,{})}>Reject extension</button></>}
      <button className={button} onClick={()=>openHistory(t)}>History</button><Link className={`${button} inline-block`} to={t.path}>Open source module</Link>
    </div>
  </article>;
  return <div className={embedded ? 'space-y-5' : 'max-w-6xl mx-auto space-y-5 pb-12'}>
    <header className="flex flex-wrap items-start justify-between gap-4"><div><p className="text-xs uppercase tracking-widest text-blue-700 font-semibold">Your working day</p><Heading className="text-2xl font-bold">Daily Work</Heading><p className="text-sm text-gray-500">Plan the steps. Do the work. Review what remains.</p></div>
      <div className="flex gap-2 flex-wrap"><input aria-label="Work date" type="date" className="input" value={date} onChange={e=>setDate(e.target.value)}/><button className={button} onClick={load}>Refresh</button></div>
    </header>
    <div className="flex flex-wrap gap-2 items-center"><button className={tab==='mine'?'btn btn-primary':button} onClick={()=>setTab('mine')}>Daily timeline</button><button className={tab==='team'?'btn btn-primary':button} onClick={()=>setTab('team')}>Team overview</button>
      {data&&<select aria-label="Team member" className="input max-w-xs" value={userId} onChange={e=>{setUserId(+e.target.value);setTab('mine');}}>{data.members.map(u=><option key={u.id} value={u.id}>{u.name}{u.id===user.id?' (me)':''}</option>)}</select>}
    </div>
    {loading&&<p role="status">Loading daily work…</p>}{error&&<div role="alert" className="rounded bg-red-50 text-red-800 p-4">{error}<button className={`${button} ml-3`} onClick={load}>Retry</button></div>}
    {!loading&&!error&&approvals.length>0&&<section className="rounded-xl border border-purple-200 bg-purple-50 p-4 space-y-3"><h2 className="font-semibold">Approvals you can act on · {approvals.length}</h2>
      {approvals.map(t=><details key={t.key} className="bg-white rounded p-3 text-sm"><summary className="cursor-pointer">{t.title} · {t.assignee_name} {t.occurrence&&`· ${t.occurrence}`}</summary>
        {t.proof_url&&<ProofPreview url={t.proof_url} reviewOnly/>}<p className="whitespace-pre-wrap">{t.proof_remarks}</p>
        <div className="flex gap-2 flex-wrap mt-3">{t.source_status==='submitted'&&t.can_approve&&<><button className={button} onClick={()=>decision(t,'approved')}>Review & approve</button><button className={button} onClick={()=>decision(t,'rejected')}>Reject</button></>}
          {t.extension_status==='pending'&&t.can_approve_extension&&<><p className="w-full">Deadline {t.due_date} → requested {t.requested_due_date}: {t.extension_reason}</p><button className={button} disabled={busy} onClick={()=>save(`${base(t)}/approve-extension`,{})}>Approve extension</button><button className={button} disabled={busy} onClick={()=>save(`${base(t)}/reject-extension`,{})}>Reject extension</button></>}
        </div>
      </details>)}
    </section>}
    {data&&!loading&&!error&&tab==='mine'&&<>
      <section className="bg-blue-50 rounded-xl p-4 flex flex-wrap justify-between gap-3"><div><h2 className="font-semibold">{data.user.name} · {data.schedule.config.start}–{data.schedule.config.end} IST</h2><p className="text-sm">{data.schedule.origin} · {data.schedule.capacity_minutes} available minutes · {data.planned_minutes} planned</p>
        <p className="text-sm">{data.schedule.attendance?`Attendance: ${data.schedule.attendance.status}${data.schedule.attendance.punch_out_time?' · checked out':data.schedule.attendance.punch_in_time?' · checked in':''}`:'No attendance recorded'}</p>
        {[...data.schedule.reasons,...data.schedule.unavailable.map(l=>`${l.type}: ${l.start}–${l.end}`)].map((s,i)=><p key={i} className="text-sm text-amber-800">{s}</p>)}
        {data.planned_minutes>data.schedule.capacity_minutes&&<p className="text-red-700 text-sm">Workload exceeds available time — review the plan with your manager.</p>}
      </div>{(!mine||user.role==='admin'||canApprove('attendance'))&&<button className={`${button} h-fit`} onClick={()=>setModal({kind:'schedule'})}>Configure schedule</button>}</section>
      <section className="grid grid-cols-2 sm:grid-cols-5 gap-3">{Object.entries(data.counts).map(([key,value])=><div key={key} className="bg-white border rounded-xl p-3"><p className="text-2xl font-bold">{value}</p><p className="text-xs text-gray-500 capitalize">{key.replaceAll('_',' ')}</p></div>)}</section>
      <p className="text-xs text-gray-500">Progress covers work planned for this day, due or overdue work, and pending approvals. Overdue and blocked counts can overlap.</p>
      <section className="grid sm:grid-cols-2 gap-3">{[['Do Now',now],['Up Next',next]].map(([title,t])=><div key={title} className="rounded-xl border p-4 bg-white"><h2 className="text-sm font-semibold text-blue-700">{title}</h2><p className="mt-1">{t?.title || (title==='Do Now'?'No work ready within the current working hours.':'No next task planned.')}</p></div>)}</section>
      <section className="space-y-3"><h2 className="font-semibold text-lg">Daily timeline</h2>{data.tasks.filter(t=>t.scheduled).map(renderTask)}{!data.tasks.some(t=>t.scheduled)&&<p className="bg-white border rounded p-5 text-gray-500">No tasks planned for this day. Choose existing work below to plan it.</p>}</section>
      <section className="space-y-3"><h2 className="font-semibold text-lg">Other assigned work & approvals</h2><p className="text-sm text-gray-500">Earlier unfinished work stays visible here. It has not been automatically moved to this day.</p>{data.tasks.filter(t=>!t.scheduled).map(renderTask)}{!data.tasks.length&&<p>No assigned work in Delegations, PMS Tasks, or Checklists for this view.</p>}</section>
      <section className="rounded-xl bg-white border p-4 space-y-3"><div className="flex flex-wrap justify-between gap-3"><h2 className="font-semibold">End-of-day review</h2>{mine&&date<=data.today&&<button className="btn btn-primary" onClick={()=>setModal({kind:'review'})}>Review my day</button>}</div>
        {data.reviews.map(r=><details key={r.id}><summary className="text-sm cursor-pointer">Saved {r.created_at} UTC · {r.entries.length} unfinished items</summary><p className="text-sm whitespace-pre-wrap">{r.summary}</p>{r.entries.map(e=><div key={e.key} className="border-t py-2 text-sm"><b>{e.title}</b><p>Reason: {e.reason}</p><p>Next action: {e.next_action}</p></div>)}</details>)}
        {!data.reviews.length&&<p className="text-sm text-gray-500">No review saved for this day.</p>}
      </section>
    </>}
    {!loading&&!error&&tab==='team'&&<section className="space-y-3">{!team.length&&<p className="bg-white border rounded p-5">No direct reports configured. Ask an administrator to set reporting managers.</p>}{team.map(u=><article className="bg-white border rounded-xl p-4 space-y-2" key={u.id}><div className="flex justify-between gap-3"><h2 className="font-semibold">{u.name}</h2><button className={button} onClick={()=>{setUserId(u.id);setTab('mine');}}>View work & act</button></div><p className="text-sm">{u.planned_minutes}/{u.capacity_minutes} minutes planned · {u.counts.completed} completed · {u.counts.remaining} remaining · {u.counts.overdue} overdue · {u.counts.blocked} blocked · {u.counts.awaiting_approval} awaiting approval</p>{u.blockers.map((b,i)=><p key={i} className="text-sm text-red-700">{b.title}: {b.reason}</p>)}<p className="text-sm text-purple-700">{u.approvals.length} approvals / extensions you can act on</p><p className="text-xs text-gray-500">Review: {u.review?'Saved':'Not saved'} · {u.schedule_reasons.join(' · ')}</p></article>)}</section>}
    <p className="text-xs text-gray-500">Daily Work supports planning and accountability. It does not restrict leaving the office or deduct salary for unfinished work.</p>
    {modal&&data&&<Dialog title={modal.kind==='proof'?'Complete work — check proof before submission':modal.kind==='plan'?'Plan task':modal.kind==='review'?'End-of-day review':modal.kind==='schedule'?'Working schedule':modal.kind==='history'?'Task history':'Review work'} onClose={()=>{if(!busy)setModal(null);}}>
      {modal.kind==='plan'&&<PlanEditor task={modal.task} tasks={data.tasks} date={date} userId={userId} onSave={save} busy={busy} schedule={data.schedule}/>}
      {modal.kind==='proof'&&<ProofForm task={modal.task} onSave={save} date={date} busy={busy}/>}
      {modal.kind==='review'&&<ReviewForm data={data} onSave={save} busy={busy}/>}
      {modal.kind==='schedule'&&<ScheduleForm data={data} onSave={save} busy={busy}/>}
      {['block','resume'].includes(modal.kind)&&<ReasonForm title={modal.kind==='block'?'Describe what is preventing progress. Your manager will be notified.':'Explain how the blocker was resolved.'} busy={busy} onSubmit={b=>save(`/daily-work/plan/${modal.task.plan.id}/action`,{...b,action:modal.kind,version:modal.task.plan.version})}/>}
      {modal.kind==='extension'&&<ReasonForm title="Request a new deadline. The current deadline remains until the existing approver accepts." extension busy={busy} onSubmit={b=>save(`${base(modal.task)}/request-extension`,b)}/>}
      {modal.kind==='decision'&&<><p className="mb-3">{modal.task.title}</p>{modal.task.proof_url&&<ProofPreview url={modal.task.proof_url} reviewOnly/>}<ReasonForm title={modal.status==='approved'?'Review the proof before approving this work.':'Explain what needs correction.'} approve={modal.status==='approved'} busy={busy} onSubmit={b=>save(modal.task.source==='checklists'?`/hr/checklists/completions/${modal.task.completion_id}/decision`:`${base(modal.task)}/${modal.status==='approved'?'approve':'reject'}`,{...b,status:modal.status})}/></>}
      {modal.kind==='history'&&<div className="space-y-3">{!history.length&&<p>No recorded daily-work events yet.</p>}{history.map(e=><details key={e.id} className="border rounded p-3 text-sm"><summary>{e.created_at} UTC · {e.actor_name} · {e.action}</summary><p className="whitespace-pre-wrap">{e.reason}</p><pre className="overflow-auto text-xs mt-2">{JSON.stringify({before:e.before,after:e.after},null,2)}</pre></details>)}</div>}
    </Dialog>}
  </div>;
}
