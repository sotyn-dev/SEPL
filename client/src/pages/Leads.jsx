import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiSearch, FiEye, FiEdit2, FiTrash2, FiChevronRight, FiCheck, FiX, FiUpload, FiCalendar, FiFileText, FiTarget, FiTrendingUp } from 'react-icons/fi';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts';

const STAGES = ['new_lead','qualified','meeting_assigned','mom_uploaded','drawing_uploaded','boq_created','quotation_sent','won','lost'];
// Stage labels match mam's spec: each is a clear, numbered step in the
// funnel so the tabs read like Indent-to-Dispatch (Stage 1 → Stage 9).
const STAGE_LABELS = {
  new_lead:        'Stage 1 — Lead Capture',
  qualified:       'Stage 2 — First Call / Qualify',
  meeting_assigned:'Stage 3 — Meeting',
  mom_uploaded:    'Stage 4 — MOM + Drawings',
  drawing_uploaded:'Stage 5 — Drawings',
  boq_created:     'Stage 6 — BOQ',
  quotation_sent:  'Stage 7 — Quotation Sent',
  won:             'Stage 8 — Won',
  lost:            'Stage 9 — Lost',
};
// Compact label used inside the funnel chart / dashboard widgets where
// the long "Stage N — …" name doesn't fit.
const STAGE_SHORT = { new_lead:'New Leads', qualified:'Qualified', meeting_assigned:'Meetings', mom_uploaded:'MOM Done', drawing_uploaded:'Drawings', boq_created:'BOQ Ready', quotation_sent:'Quotation Sent', won:'Won', lost:'Lost' };
const STAGE_COLORS = { new_lead:'#3b82f6', qualified:'#6366f1', meeting_assigned:'#8b5cf6', mom_uploaded:'#a855f7', drawing_uploaded:'#f59e0b', boq_created:'#f97316', quotation_sent:'#06b6d4', won:'#10b981', lost:'#ef4444' };
const TAB_STYLES = { new_lead:'bg-red-500', qualified:'bg-red-500', meeting_assigned:'bg-purple-500', mom_uploaded:'bg-violet-500', drawing_uploaded:'bg-amber-500', boq_created:'bg-orange-500', quotation_sent:'bg-cyan-500', won:'bg-emerald-500', lost:'bg-red-500' };
// Sales-funnel category list — exactly mam's 7-option spec (Section 3 of 7
// of her form): Low Voltage, Fire Fighting, Electrical, SOLAR, MEP, HVAC,
// Plumbing. Order and casing kept verbatim per mam's screenshot.
const CATEGORIES = ['Low Voltage','Fire Fighting','Electrical','SOLAR','MEP','HVAC','Plumbing'];
const PIE_COLORS = ['#3b82f6','#6366f1','#8b5cf6','#f59e0b','#f97316','#06b6d4','#10b981','#ef4444','#ec4899'];

export default function Leads() {
  const { canCreate, canEdit, canDelete, user } = useAuth();
  const [tab, setTab] = useState('dashboard');
  const [stageTab, setStageTab] = useState('all');
  const [leads, setLeads] = useState([]);
  const [dashboard, setDashboard] = useState(null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [viewData, setViewData] = useState(null);
  const [stageForm, setStageForm] = useState({});
  // Which stage's "Next Action" form is currently visible. Defaults to the
  // lead's current_stage. Clicking any pipeline pill sets this, so admin can
  // jump backwards (to correct) or forwards (to skip optional steps).
  const [viewStage, setViewStage] = useState(null);
  const [followups, setFollowups] = useState([]);
  const [fuForm, setFuForm] = useState({ followup_date: '', followup_time: '', type: 'call', notes: '' });
  // Employees list for the "Assign Meeting" dropdown — only active staff
  // are shown so dropped/inactive employees don't clutter the list.
  // Each option carries user_id so the lead row stores both the display
  // name and the FK to users(id) for "My Planned Meetings" filtering.
  const [employees, setEmployees] = useState([]);

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (search) params.set('search', search);
    if (stageTab !== 'all' && stageTab !== 'dashboard') params.set('stage', stageTab);
    api.get(`/sales-funnel?${params}`).then(r => setLeads(r.data)).catch(() => {});
    api.get('/sales-funnel/dashboard').then(r => setDashboard(r.data)).catch(() => {});
  }, [search, stageTab]);

  useEffect(() => { load(); }, [load]);

  // Load active employees once for the Assign Meeting dropdown.
  // Filter to active so dropped employees don't show in the picker.
  useEffect(() => {
    api.get('/hr/employees')
      .then(r => setEmployees((r.data || []).filter(e => !e.status || e.status === 'active')))
      .catch(() => setEmployees([]));
  }, []);

  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const fmt = n => `Rs ${(n||0).toLocaleString('en-IN')}`;

  const saveLead = async (e) => {
    e.preventDefault();
    try {
      if (form.id) { await api.put(`/sales-funnel/${form.id}`, form); toast.success('Updated'); }
      else { const res = await api.post('/sales-funnel', form); toast.success(`Lead ${res.data.lead_no} created`); }
      setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const advanceStage = async (id, stage, data) => {
    try { await api.post(`/sales-funnel/${id}/stage`, { stage, ...data }); toast.success(`${STAGE_LABELS[stage]||stage}`); setModal(null); setViewData(null); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Error'); }
  };

  const uploadFile = async (file) => { const fd = new FormData(); fd.append('file', file); const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } }); return r.data.url; };
  const viewLead = (l) => { setViewData(l); setStageForm({}); setViewStage(null); setModal('view'); api.get(`/sales-funnel/${l.id}/followups`).then(r=>setFollowups(r.data)).catch(()=>setFollowups([])); };

  const addFollowup = async () => {
    if (!fuForm.followup_date) return toast.error('Date required');
    try { await api.post(`/sales-funnel/${viewData.id}/followup`, fuForm); toast.success('Follow-up scheduled'); setFuForm({followup_date:'',followup_time:'',type:'call',notes:''}); api.get(`/sales-funnel/${viewData.id}/followups`).then(r=>setFollowups(r.data)); }
    catch(err) { toast.error(err.response?.data?.error||'Error'); }
  };

  const logFollowup = async (fid, outcome) => {
    const notes = prompt('Notes:');
    const next = prompt('Next follow-up date (YYYY-MM-DD) or leave empty:');
    try { await api.put(`/sales-funnel/followup/${fid}`, { outcome, notes, next_followup_date: next||null }); toast.success('Logged'); api.get(`/sales-funnel/${viewData.id}/followups`).then(r=>setFollowups(r.data)); load(); }
    catch(err) { toast.error('Error'); }
  };

  // Chart data
  const stageChartData = dashboard?.byStage?.map(s => ({ name: STAGE_SHORT[s.current_stage]||s.current_stage, count: s.count, fill: STAGE_COLORS[s.current_stage]||'#888' })) || [];
  const catChartData = dashboard?.byCategory?.map((c,i) => ({ name: c.category, value: c.count, fill: PIE_COLORS[i%PIE_COLORS.length] })) || [];
  const scChartData = dashboard?.bySC?.map((s,i) => ({ name: s.assigned_sc, count: s.count, fill: PIE_COLORS[i%PIE_COLORS.length] })) || [];

  // Funnel data
  const funnelData = STAGES.filter(s=>s!=='lost').map(s => ({ stage: STAGE_SHORT[s], count: dashboard?.byStage?.find(b=>b.current_stage===s)?.count||0 }));

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <h1 className="text-xl font-bold flex items-center gap-2"><FiTarget className="text-red-600" /> Sales Funnel</h1>
        {canCreate('leads') && <button onClick={() => { setForm({ client_name:'',company_name:'',phone:'',email:'',category:'',address:'',source:'',assigned_sc:user?.name||'',assigned_asm:'',remarks:'' }); setModal('add'); }} className="btn btn-primary flex items-center gap-2 text-sm"><FiPlus size={15}/> New Lead</button>}
      </div>

      {/* Sales Funnel stage tabs — same pill-button style as the
          Indent-to-Dispatch tabs (Raise Indent / Vendor Rates / …) so
          each stage is a clearly visible step. ALL stages are always
          shown (even when count=0) so mam can see the full pipeline at
          a glance. The count chip on each tab makes it obvious where
          the leads are sitting today. */}
      <div className="flex gap-2 flex-wrap items-center">
        <button
          onClick={() => { setTab('dashboard'); setStageTab('dashboard'); }}
          className={`btn ${tab === 'dashboard' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          <FiTrendingUp size={14} /> Dashboard
        </button>
        <button
          onClick={() => { setTab('list'); setStageTab('all'); }}
          className={`btn ${tab === 'list' && stageTab === 'all' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
        >
          All Leads
          <span className="bg-white/30 text-white px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center">
            {dashboard?.total || 0}
          </span>
        </button>
        {STAGES.map(s => {
          const count = dashboard?.byStage?.find(b => b.current_stage === s)?.count || 0;
          const isActive = stageTab === s && tab === 'list';
          return (
            <button
              key={s}
              onClick={() => { setTab('list'); setStageTab(s); }}
              className={`btn ${isActive ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1.5`}
              title={STAGE_LABELS[s]}
            >
              {STAGE_LABELS[s]}
              <span className={`px-1.5 rounded-full text-[10px] font-bold min-w-[18px] text-center ${isActive ? 'bg-white/30 text-white' : 'text-white ' + (TAB_STYLES[s] || 'bg-gray-400')}`}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Dashboard Tab */}
      {tab === 'dashboard' && dashboard && (
        <div className="space-y-4">
          {/* Stats Row */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Total Leads</p><p className="text-3xl font-extrabold text-red-600">{dashboard.total}</p></div>
            <div className="card p-4 border-l-4 border-purple-500"><p className="text-[10px] text-gray-500 font-bold uppercase">This Month</p><p className="text-3xl font-extrabold text-purple-600">{dashboard.thisMonth}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Won Deals</p><p className="text-3xl font-extrabold text-emerald-600">{dashboard.won?.c||0}</p><p className="text-xs text-emerald-500">{dashboard.won?.amount>0?fmt(dashboard.won.amount):''}</p></div>
            <div className="card p-4 border-l-4 border-red-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Lost</p><p className="text-3xl font-extrabold text-red-600">{dashboard.lost?.c||0}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Win Rate</p><p className="text-3xl font-extrabold text-amber-600">{dashboard.total>0?Math.round(((dashboard.won?.c||0)/dashboard.total)*100):0}%</p></div>
            {(dashboard.todayFollowups>0||dashboard.overdueFollowups>0)&&<div className="card p-4 border-l-4 border-orange-500"><p className="text-[10px] text-gray-500 font-bold uppercase">Follow-ups</p><p className="text-xl font-bold text-orange-600">{dashboard.todayFollowups} today</p>{dashboard.overdueFollowups>0&&<p className="text-xs text-red-600 font-bold">{dashboard.overdueFollowups} overdue!</p>}</div>}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Stage Bar Chart */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">Pipeline by Stage</h4>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={stageChartData}><XAxis dataKey="name" tick={{fontSize:9}} angle={-20} textAnchor="end" height={50}/><YAxis tick={{fontSize:10}}/><Tooltip/><Bar dataKey="count" radius={[4,4,0,0]}>{stageChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}</Bar></BarChart>
              </ResponsiveContainer>
            </div>

            {/* Category Pie */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">By Category</h4>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart><Pie data={catChartData} cx="50%" cy="50%" outerRadius={80} dataKey="value" label={({name,value})=>`${name}: ${value}`} labelLine={false}>
                  {catChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}</Pie><Legend iconSize={10} wrapperStyle={{fontSize:10}}/></PieChart>
              </ResponsiveContainer>
            </div>

            {/* Funnel */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">Sales Funnel</h4>
              <div className="space-y-1">{funnelData.map((f,i) => {
                const maxCount = Math.max(...funnelData.map(d=>d.count),1);
                const width = Math.max(20, (f.count/maxCount)*100);
                return (<div key={i} className="flex items-center gap-2">
                  <span className="text-[9px] w-16 text-right text-gray-500 font-medium">{f.stage}</span>
                  <div className="flex-1 bg-gray-100 rounded-full h-6 overflow-hidden">
                    <div className="h-full rounded-full flex items-center px-2 transition-all" style={{width:`${width}%`, backgroundColor:Object.values(STAGE_COLORS)[i]||'#888'}}>
                      <span className="text-white text-[10px] font-bold">{f.count}</span>
                    </div>
                  </div>
                </div>);
              })}</div>
            </div>

            {/* SC Performance */}
            <div className="card">
              <h4 className="font-bold text-sm text-gray-700 mb-3">By Sales Coordinator</h4>
              <ResponsiveContainer width="100%" height={250}>
                <PieChart><Pie data={scChartData} cx="50%" cy="50%" innerRadius={40} outerRadius={80} dataKey="count" label={({name,count})=>`${name}: ${count}`}>
                  {scChartData.map((e,i)=>(<Cell key={i} fill={e.fill}/>))}</Pie><Legend iconSize={10} wrapperStyle={{fontSize:10}}/></PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* List Tab */}
      {tab === 'list' && (<>
        <div className="relative"><FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16}/><input className="input pl-10" placeholder="Search client, company, lead no, phone..." value={search} onChange={e=>setSearch(e.target.value)}/></div>
        <div className="card p-0 overflow-x-auto"><table className="text-xs">
          <thead><tr><th className="px-3 py-2">Lead No</th><th className="px-3 py-2">Client</th><th className="px-3 py-2">Company</th><th className="px-3 py-2">Category</th><th className="px-3 py-2">Location</th><th className="px-3 py-2">SC</th><th className="px-3 py-2">Stage</th><th className="px-3 py-2">SLA</th><th className="px-3 py-2">Date</th><th className="px-3 py-2">Actions</th></tr></thead>
          <tbody>{leads.map(l => {
            // SLA chip: shows "due in Xh" / "overdue by Xd" / "—" based on
            // sla_minutes_left from the backend. Overdue rows get a red chip
            // so mam's team can spot them instantly in the list.
            let slaChip = <span className="text-gray-300 text-[10px]">—</span>;
            if (l.sla_minutes_left !== null && l.sla_minutes_left !== undefined) {
              const m = l.sla_minutes_left;
              if (m < 0) {
                const abs = -m;
                const label = abs < 60 ? `${abs}m` : abs < 1440 ? `${Math.round(abs/60)}h` : `${Math.round(abs/1440)}d`;
                slaChip = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-red-100 text-red-700 border border-red-200">OVERDUE {label}</span>;
              } else if (m < 60) {
                slaChip = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 border border-amber-200">{m}m left</span>;
              } else if (m < 1440) {
                slaChip = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200">{Math.round(m/60)}h left</span>;
              } else {
                slaChip = <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-gray-100 text-gray-600 border border-gray-200">{Math.round(m/1440)}d left</span>;
              }
            }
            return (<tr key={l.id} className="border-b hover:bg-red-50/40 cursor-pointer" onClick={()=>viewLead(l)}>
            <td className="px-3 py-2.5 font-bold text-red-600">{l.lead_no}</td>
            <td className="px-3 py-2.5"><div className="font-semibold">{l.client_name}</div></td>
            <td className="px-3 py-2.5 text-gray-600">{l.company_name||'-'}</td>
            <td className="px-3 py-2.5"><span className="text-[9px] bg-gray-100 px-2 py-0.5 rounded-full font-medium">{l.category||'-'}</span></td>
            <td className="px-3 py-2.5 text-gray-500">{l.district||l.address||'-'}</td>
            <td className="px-3 py-2.5">{l.assigned_sc||'-'}</td>
            <td className="px-3 py-2.5"><span className="text-[9px] px-2 py-1 rounded-full font-bold text-white" style={{backgroundColor:STAGE_COLORS[l.current_stage]||'#888'}}>{STAGE_SHORT[l.current_stage]||l.current_stage}</span></td>
            <td className="px-3 py-2.5">{slaChip}</td>
            <td className="px-3 py-2.5 text-[10px] text-gray-400">{l.created_at?.split('T')[0]}</td>
            <td className="px-3 py-2.5" onClick={e=>e.stopPropagation()}>
              <div className="flex gap-1">
                <button onClick={()=>viewLead(l)} className="p-1 text-red-600 hover:bg-red-50 rounded"><FiEye size={14}/></button>
                {canEdit('leads')&&<button onClick={()=>{setForm(l);setModal('edit');}} className="p-1 text-amber-600 hover:bg-amber-50 rounded"><FiEdit2 size={14}/></button>}
                {canDelete('leads')&&<button onClick={async()=>{if(!confirm('Delete?'))return;await api.delete(`/sales-funnel/${l.id}`);toast.success('Deleted');load();}} className="p-1 text-red-600 hover:bg-red-50 rounded"><FiTrash2 size={14}/></button>}
              </div>
            </td>
          </tr>);
          })}{leads.length===0&&<tr><td colSpan="10" className="text-center py-8 text-gray-400">No leads</td></tr>}</tbody>
        </table></div>
      </>)}

      {/* View + Stage Actions */}
      <Modal isOpen={modal==='view'} onClose={()=>{setModal(null);setViewData(null);setViewStage(null);}} title={`${viewData?.lead_no} - ${viewData?.client_name}`} wide>
        {viewData && (<div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Pipeline pills — all clickable. Clicking one sets `viewStage`
              so the "Next Action" form for that stage is shown. Admin can
              use this to jump back (correct a past step) or skip forward
              (for optional stages like Drawings). The lead's own
              `current_stage` doesn't change until the form is submitted. */}
          <div className="flex gap-1 overflow-x-auto pb-2">{STAGES.filter(s=>s!=='lost').map((key,idx)=>{
            const keys=STAGES.filter(s=>s!=='lost'); const si=keys.indexOf(viewData.current_stage); const ti=keys.indexOf(key);
            const done=ti<=si; const cur=viewData.current_stage===key;
            const selected=(viewStage||viewData.current_stage)===key;
            return(<div key={key} className="flex items-center">
              <button
                type="button"
                onClick={()=>{setViewStage(key);setStageForm({});}}
                className={`px-2 py-1 rounded text-[9px] font-bold min-w-[50px] text-center transition-all hover:scale-105 ${selected?'ring-2 ring-offset-1 ring-red-500':''}`}
                style={{backgroundColor:cur||done?STAGE_COLORS[key]:'#e5e7eb',color:cur||done?'white':'#9ca3af'}}
                title={selected ? 'Currently viewing this stage' : `Click to view ${STAGE_LABELS[key]} form`}
              >{STAGE_SHORT[key]}</button>
              {idx<keys.length-1&&<FiChevronRight size={10} className="text-gray-300 mx-0.5"/>}
            </div>);
          })}</div>
          {viewStage && viewStage !== viewData.current_stage && (
            <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1.5 flex items-center justify-between">
              <span>
                {STAGES.indexOf(viewStage) < STAGES.indexOf(viewData.current_stage)
                  ? <>You're viewing a <b>past stage</b> — submitting will set the lead back to this stage (to correct data).</>
                  : <>You're <b>skipping ahead</b> from {STAGE_LABELS[viewData.current_stage]} to {STAGE_LABELS[viewStage]} — some intermediate steps won't be filled.</>}
              </span>
              <button onClick={()=>{setViewStage(null);setStageForm({});}} className="text-amber-700 hover:underline font-bold">Back to current</button>
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2 text-sm">
            <div><span className="text-gray-400 text-[10px]">Client</span><br/><strong>{viewData.client_name}</strong></div>
            <div><span className="text-gray-400 text-[10px]">Company</span><br/>{viewData.company_name||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">Category</span><br/>{viewData.category||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">Phone</span><br/>{viewData.phone||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">SC</span><br/>{viewData.assigned_sc||'-'}</div>
            <div><span className="text-gray-400 text-[10px]">ASM</span><br/>{viewData.assigned_asm||'-'}</div>
          </div>
          {viewData.qualified_remarks&&<div className="bg-red-50 p-2 rounded text-xs"><strong>Qualified:</strong> {viewData.qualified_remarks}</div>}
          {viewData.meeting_date&&<div className="bg-purple-50 p-2 rounded text-xs"><strong>Meeting:</strong> {viewData.meeting_date} - {viewData.meeting_location}</div>}
          {viewData.mom_notes&&<div className="bg-violet-50 p-2 rounded text-xs"><strong>MOM:</strong> {viewData.mom_notes} {viewData.mom_file_link&&<a href={viewData.mom_file_link} className="text-red-600 underline" target="_blank" rel="noreferrer">File</a>}</div>}
          {viewData.drawing_file1&&<div className="bg-amber-50 p-2 rounded text-xs"><strong>Drawings:</strong> <a href={viewData.drawing_file1} className="text-red-600 underline" target="_blank" rel="noreferrer">1</a> {viewData.drawing_file2&&<a href={viewData.drawing_file2} className="text-red-600 underline ml-2" target="_blank" rel="noreferrer">2</a>} {viewData.drawing_file3&&<a href={viewData.drawing_file3} className="text-red-600 underline ml-2" target="_blank" rel="noreferrer">3</a>}</div>}
          {viewData.boq_file_link&&<div className="bg-orange-50 p-2 rounded text-xs"><strong>BOQ:</strong> Rs {viewData.boq_amount?.toLocaleString()} <a href={viewData.boq_file_link} className="text-red-600 underline" target="_blank" rel="noreferrer">View</a></div>}
          {viewData.quotation_number&&<div className="bg-cyan-50 p-2 rounded text-xs"><strong>Quotation:</strong> {viewData.quotation_number} - Rs {viewData.quotation_amount?.toLocaleString()}</div>}
          {viewData.result&&<div className={`p-3 rounded font-bold text-center text-lg ${viewData.result==='won'?'bg-emerald-100 text-emerald-700':'bg-red-100 text-red-700'}`}>{viewData.result.toUpperCase()} {viewData.won_amount>0&&`- ${fmt(viewData.won_amount)}`}</div>}

          {/* Follow-ups */}
          <div className="border rounded-xl p-3 space-y-2">
            <div className="flex justify-between items-center"><h5 className="font-bold text-sm">Follow-ups</h5></div>
            <div className="flex gap-2 items-end">
              <div className="flex-1"><input className="input text-xs" type="date" value={fuForm.followup_date} onChange={e=>setFuForm({...fuForm,followup_date:e.target.value})}/></div>
              <div><input className="input text-xs" type="time" value={fuForm.followup_time||''} onChange={e=>setFuForm({...fuForm,followup_time:e.target.value})}/></div>
              <select className="select text-xs w-24" value={fuForm.type} onChange={e=>setFuForm({...fuForm,type:e.target.value})}><option value="call">Call</option><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="visit">Visit</option></select>
              <input className="input text-xs flex-1" placeholder="Notes" value={fuForm.notes||''} onChange={e=>setFuForm({...fuForm,notes:e.target.value})}/>
              <button onClick={addFollowup} className="btn btn-primary text-xs px-3">Add</button>
            </div>
            {followups.length>0&&<div className="space-y-1 max-h-32 overflow-y-auto">{followups.map(f=>(
              <div key={f.id} className={`flex items-center justify-between text-xs p-2 rounded ${f.done?'bg-gray-50':'bg-amber-50 border border-amber-200'}`}>
                <div><span className="font-medium">{f.followup_date}</span> {f.followup_time&&<span className="text-gray-400">{f.followup_time}</span>} <span className="capitalize bg-gray-100 px-1 rounded text-[9px]">{f.type}</span> {f.notes&&<span className="text-gray-500 ml-1">{f.notes}</span>}</div>
                <div>{f.done?<span className="text-emerald-600 font-bold text-[9px]">{f.outcome}</span>:(
                  <div className="flex gap-1">
                    <button onClick={()=>logFollowup(f.id,'connected')} className="text-[9px] text-emerald-600 font-bold">Connected</button>
                    <button onClick={()=>logFollowup(f.id,'not_reachable')} className="text-[9px] text-red-600 font-bold">NR</button>
                    <button onClick={()=>logFollowup(f.id,'callback')} className="text-[9px] text-amber-600 font-bold">Callback</button>
                    <button onClick={()=>logFollowup(f.id,'interested')} className="text-[9px] text-red-600 font-bold">Interested</button>
                  </div>
                )}</div>
              </div>
            ))}</div>}
          </div>

          {(() => {
            // Effective stage for the "Next Action" panel — clicking a pill
            // above sets viewStage, so the user can jump to any stage's form.
            const activeStage = viewStage || viewData.current_stage;
            if (activeStage === 'won' || activeStage === 'lost') return null;
            return (
            <div className="border-2 rounded-xl p-4 space-y-3" style={{borderColor:STAGE_COLORS[activeStage],backgroundColor:STAGE_COLORS[activeStage]+'10'}}>
              <h5 className="font-bold flex items-center justify-between" style={{color:STAGE_COLORS[activeStage]}}>
                <span>{STAGE_LABELS[activeStage]} — Action</span>
                {viewStage && viewStage !== viewData.current_stage && (
                  <span className="text-[10px] font-normal text-gray-500">Lead is currently at: <b>{STAGE_LABELS[viewData.current_stage]}</b></span>
                )}
              </h5>
              {activeStage==='new_lead'&&(<div className="space-y-2">
                <textarea className="input" rows="2" placeholder="Remarks..." value={stageForm.qualified_remarks||''} onChange={e=>setStageForm({...stageForm,qualified_remarks:e.target.value})}/>
                <div className="flex gap-2"><button onClick={()=>advanceStage(viewData.id,'qualified',stageForm)} className="btn btn-success flex-1"><FiCheck className="inline mr-1"/>Qualified</button><button onClick={()=>advanceStage(viewData.id,'not_qualified',stageForm)} className="btn btn-danger flex-1"><FiX className="inline mr-1"/>Not Qualified</button></div>
              </div>)}
              {activeStage==='qualified'&&(<div className="space-y-2">
                <input className="input" type="datetime-local" value={stageForm.meeting_date||''} onChange={e=>setStageForm({...stageForm,meeting_date:e.target.value})}/>
                <input className="input" placeholder="Location" value={stageForm.meeting_location||''} onChange={e=>setStageForm({...stageForm,meeting_location:e.target.value})}/>
                {/* Assign Meeting → searchable employee dropdown. Stores
                    both the name (for display) and user_id (so the
                    assignee's dashboard can filter to their meetings). */}
                <SearchableSelect
                  options={employees.map(e => ({
                    value: e.id,
                    label: e.name + (e.designation ? ' — ' + e.designation : ''),
                    name: e.name,
                    user_id: e.user_id,
                  }))}
                  value={stageForm.meeting_assigned_employee_id || ''}
                  onChange={(opt) => setStageForm({
                    ...stageForm,
                    meeting_assigned_employee_id: opt?.value || null,
                    meeting_assigned_to: opt?.name || '',
                    meeting_assigned_to_id: opt?.user_id || null,
                  })}
                  placeholder="Assign To (search employee)..."
                />
                <button onClick={()=>advanceStage(viewData.id,'meeting_assigned',stageForm)} className="btn btn-primary w-full">Assign Meeting</button>
              </div>)}
              {/* Fill MOM — matches mam's Google Form layout (2026-04-23).
                  Customer Category + Customer Type are radios (not read-only)
                  so the field engineer can correct / confirm them at the site.
                  They also update the lead record itself. */}
              {activeStage==='meeting_assigned'&&(<div className="space-y-3">
                {/* Customer Category — radio buttons matching the Google Form */}
                <div>
                  <label className="label text-[10px]">Customer Category *</label>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-1">
                    {['Fire Fighting','Electrical','Low Voltage','HVAC','MEPF','Solar','Plumbing','Other'].map(cat => (
                      <label key={cat} className={`flex items-center gap-1.5 px-2 py-1.5 border rounded text-xs cursor-pointer ${(stageForm.category||viewData.category)===cat ? 'border-red-500 bg-red-50 text-red-700' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <input type="radio" name="customer_category" value={cat} checked={(stageForm.category||viewData.category)===cat} onChange={()=>setStageForm({...stageForm,category:cat})} />
                        {cat}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Customer Type — Existing / New */}
                <div>
                  <label className="label text-[10px]">Customer Type *</label>
                  <div className="flex gap-2">
                    {['Existing','New'].map(t => (
                      <label key={t} className={`flex-1 flex items-center justify-center gap-1.5 px-3 py-2 border rounded text-xs cursor-pointer ${(stageForm.lead_type||viewData.lead_type)===t ? 'border-red-500 bg-red-50 text-red-700 font-bold' : 'border-gray-200 hover:bg-gray-50'}`}>
                        <input type="radio" name="customer_type" value={t} checked={(stageForm.lead_type||viewData.lead_type)===t} onChange={()=>setStageForm({...stageForm,lead_type:t})} />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>

                {/* Meeting Location context (editable) */}
                <div>
                  <label className="label text-[10px]">Meeting Location</label>
                  <input className="input" value={stageForm.meeting_location ?? (viewData.meeting_location||'')} onChange={e=>setStageForm({...stageForm,meeting_location:e.target.value})} placeholder="Site / office / online"/>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="label text-[10px]">Purpose of Meeting *</label>
                    <input className="input" value={stageForm.meeting_purpose||''} onChange={e=>setStageForm({...stageForm,meeting_purpose:e.target.value})} placeholder="e.g. site survey / requirement gathering" required/>
                  </div>
                  <div>
                    <label className="label text-[10px]">Meeting Format</label>
                    <select className="select" value={stageForm.meeting_format||''} onChange={e=>setStageForm({...stageForm,meeting_format:e.target.value})}>
                      <option value="">— Select —</option>
                      <option value="in_person">In-Person</option>
                      <option value="phone">Phone</option>
                      <option value="video_call">Video Call</option>
                      <option value="email">Email</option>
                    </select>
                  </div>
                  <div>
                    <label className="label text-[10px]">Meeting Scheduled By</label>
                    <input className="input" value={stageForm.meeting_scheduled_by||''} onChange={e=>setStageForm({...stageForm,meeting_scheduled_by:e.target.value})} placeholder="Name of scheduler"/>
                  </div>
                  <div>
                    <label className="label text-[10px]">Time Spent (minutes)</label>
                    <input className="input" type="number" min="0" value={stageForm.meeting_time_spent_min||''} onChange={e=>setStageForm({...stageForm,meeting_time_spent_min:+e.target.value})} placeholder="e.g. 45"/>
                  </div>
                </div>

                <div>
                  <label className="label text-[10px]">Pain Points</label>
                  <textarea className="input" rows="2" value={stageForm.pain_points||''} onChange={e=>setStageForm({...stageForm,pain_points:e.target.value})} placeholder="Client's current challenges / issues"/>
                </div>
                <div>
                  <label className="label text-[10px]">Requirements</label>
                  <textarea className="input" rows="2" value={stageForm.requirements||''} onChange={e=>setStageForm({...stageForm,requirements:e.target.value})} placeholder="What client needs — scope / quantities / standards"/>
                </div>
                <div>
                  <label className="label text-[10px]">M.O.M. (Minutes of Meeting) *</label>
                  <textarea className="input" rows="3" value={stageForm.mom_notes||''} onChange={e=>setStageForm({...stageForm,mom_notes:e.target.value})} placeholder="What was discussed / agreed" required/>
                </div>
                <div>
                  <label className="label text-[10px]">Action Planned</label>
                  <textarea className="input" rows="2" value={stageForm.action_planned||''} onChange={e=>setStageForm({...stageForm,action_planned:e.target.value})} placeholder="Next steps — who does what by when"/>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="label text-[10px]">Timestamp Photo <span className="text-gray-400 font-normal">(selfie at site with date stamp)</span></label>
                    <input type="file" accept="image/*" capture="environment" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,meeting_timestamp_photo_url:url}));toast.success('Photo uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                    {stageForm.meeting_timestamp_photo_url && <p className="text-[10px] text-emerald-600 mt-0.5">✓ Photo attached</p>}
                  </div>
                  <div>
                    <label className="label text-[10px]">MOM File <span className="text-gray-400 font-normal">(optional PDF/doc)</span></label>
                    <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,mom_file_link:url}));toast.success('MOM file uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                    {stageForm.mom_file_link && <p className="text-[10px] text-emerald-600 mt-0.5">✓ File attached</p>}
                  </div>
                </div>

                <button onClick={()=>advanceStage(viewData.id,'mom_uploaded',stageForm)} disabled={!stageForm.mom_notes||!stageForm.meeting_purpose} className="btn btn-primary w-full disabled:opacity-50">Submit MOM</button>
              </div>)}
              {activeStage==='mom_uploaded'&&(<div className="space-y-2">
                {[1,2,3].map(n=>(<div key={n} className="flex items-center gap-2"><span className="text-xs w-16">Drawing {n}:</span><input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{const url=await uploadFile(f);setStageForm(s=>({...s,[`drawing_file${n}`]:url}));toast.success(`Drawing ${n}`);}catch{toast.error('Failed');}}} className="text-xs flex-1"/>{stageForm[`drawing_file${n}`]&&<span className="text-emerald-600 text-xs">OK</span>}</div>))}
                <button onClick={()=>advanceStage(viewData.id,'drawing_uploaded',stageForm)} disabled={!stageForm.drawing_file1} className="btn btn-primary w-full disabled:opacity-50">Submit Drawings</button>
              </div>)}
              {activeStage==='drawing_uploaded'&&(<div className="space-y-2">
                <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{stageForm.boq_file_link=await uploadFile(f);toast.success('BOQ uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                <input className="input" type="number" placeholder="BOQ Amount" value={stageForm.boq_amount||''} onChange={e=>setStageForm({...stageForm,boq_amount:+e.target.value})}/>
                <button onClick={()=>advanceStage(viewData.id,'boq_created',stageForm)} className="btn btn-primary w-full">Submit BOQ</button>
              </div>)}
              {activeStage==='boq_created'&&(<div className="space-y-2">
                <input className="input" placeholder="Quotation Number" value={stageForm.quotation_number||''} onChange={e=>setStageForm({...stageForm,quotation_number:e.target.value})}/>
                <input className="input" type="number" placeholder="Amount" value={stageForm.quotation_amount||''} onChange={e=>setStageForm({...stageForm,quotation_amount:+e.target.value})}/>
                <input type="file" onChange={async(e)=>{const f=e.target.files[0];if(!f)return;try{stageForm.quotation_file_link=await uploadFile(f);toast.success('Uploaded');}catch{toast.error('Failed');}}} className="text-xs"/>
                <button onClick={()=>advanceStage(viewData.id,'quotation_sent',stageForm)} className="btn btn-primary w-full">Send Quotation</button>
              </div>)}
              {activeStage==='quotation_sent'&&(<div className="space-y-2">
                <textarea className="input" rows="2" placeholder="Remarks..." value={stageForm.result_remarks||''} onChange={e=>setStageForm({...stageForm,result_remarks:e.target.value})}/>
                <input className="input" type="number" placeholder="Won Amount" value={stageForm.won_amount||''} onChange={e=>setStageForm({...stageForm,won_amount:+e.target.value})}/>
                <div className="flex gap-2"><button onClick={()=>advanceStage(viewData.id,'won',stageForm)} className="btn btn-success flex-1">WON</button><button onClick={()=>advanceStage(viewData.id,'lost',stageForm)} className="btn btn-danger flex-1">LOST</button></div>
              </div>)}
            </div>
            );
          })()}
        </div>)}
      </Modal>

      {/* Add/Edit */}
      {/* STAGE 1 — Lead / Tender Capture (mam's funnel spec).
          Lead Kind toggle: Private vs Government. Govt-specific fields
          (Tender ID, bid deadline, EMD, PBG) appear only when needed. */}
      <Modal isOpen={modal==='add'||modal==='edit'} onClose={()=>setModal(null)} title={modal==='edit'?'Edit Lead':'Stage 1 — Lead / Tender Capture'} wide>
        <form onSubmit={saveLead} className="space-y-4 max-h-[75vh] overflow-y-auto pr-1">
          {/* Lead Kind selector — drives the rest of the form */}
          <div>
            <label className="label">Lead Kind *</label>
            <div className="flex gap-2">
              {[
                { v: 'private', label: '🏢 Private (Quote)', desc: 'Direct customer, RFQ-based' },
                { v: 'government', label: '🏛 Government (Tender)', desc: 'GeM / CPPP / state portal' },
              ].map(o => (
                <label key={o.v} className={`flex-1 cursor-pointer border-2 rounded-lg p-3 text-center transition ${(form.lead_kind || 'private') === o.v ? 'border-red-500 bg-red-50 text-red-700 font-bold' : 'border-gray-200 hover:bg-gray-50'}`}>
                  <input type="radio" name="lead_kind" value={o.v} checked={(form.lead_kind || 'private') === o.v} onChange={e => F('lead_kind', e.target.value)} className="sr-only" />
                  <div className="text-sm">{o.label}</div>
                  <div className="text-[10px] text-gray-500 font-normal mt-0.5">{o.desc}</div>
                </label>
              ))}
            </div>
          </div>

          {/* Customer block */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Customer</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div><label className="label">Customer Name *</label><input className="input" value={form.client_name||''} onChange={e=>F('client_name',e.target.value)} required/></div>
            <div><label className="label">Company / Entity</label><input className="input" value={form.company_name||''} onChange={e=>F('company_name',e.target.value)}/></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone||''} onChange={e=>F('phone',e.target.value)}/></div>
            <div><label className="label">Email</label><input className="input" type="email" value={form.email||''} onChange={e=>F('email',e.target.value)}/></div>
            <div><label className="label">GST Number</label><input className="input font-mono uppercase" value={form.gst_number||''} onChange={e=>F('gst_number',e.target.value.toUpperCase())} placeholder="03ABCDE1234F1Z5" maxLength="15"/></div>
            <div><label className="label">PAN Number</label><input className="input font-mono uppercase" value={form.pan_number||''} onChange={e=>F('pan_number',e.target.value.toUpperCase())} placeholder="ABCDE1234F" maxLength="10"/></div>
          </div>

          {/* Project block */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Project</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div className="md:col-span-2"><label className="label">Project Name {modal!=='edit' && '*'}</label><input className="input" value={form.project_name||''} onChange={e=>F('project_name',e.target.value)} required={modal!=='edit'}/></div>
            <div><label className="label">PIN Code</label><input className="input" value={form.pin_code||''} onChange={e=>F('pin_code',e.target.value)} maxLength="6"/></div>
            <div className="md:col-span-3"><label className="label">Project Location</label><input className="input" value={form.project_location||''} onChange={e=>F('project_location',e.target.value)} placeholder="Site address / city"/></div>
            <div><label className="label">District</label><input className="input" value={form.district||''} onChange={e=>F('district',e.target.value)}/></div>
            <div><label className="label">State</label><input className="input" value={form.state||''} onChange={e=>F('state',e.target.value)}/></div>
            <div><label className="label">Estimated Value (₹)</label><input className="input" type="number" min="0" value={form.estimated_value||0} onChange={e=>F('estimated_value',+e.target.value)}/></div>
            <div className="md:col-span-3"><label className="label">Tentative Timeline</label><input className="input" value={form.tentative_timeline||''} onChange={e=>F('tentative_timeline',e.target.value)} placeholder="e.g. 4 months / Q3 2026"/></div>
          </div>

          {/* Category + Sub-trades */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Scope</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Category *</label>
              {/* 7-option dropdown matching mam's spec (Section 3 of 7).
                  Required — every lead must declare its trade category so
                  the right team picks it up. */}
              <select className="select" required value={form.category||''} onChange={e=>F('category',e.target.value)}>
                <option value="">Select Category</option>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            {/* Sub-trades Scope removed at mam's request — the 7-option
                Category above already captures the trade. The sub_trades_scope
                column stays in the schema (harmless, NULL on new rows). */}
          </div>

          {/* Government-only block */}
          {form.lead_kind === 'government' && (
            <>
              <div className="border-t pt-3"><h5 className="font-bold text-sm text-amber-700 mb-2">🏛 Government / Tender Details</h5></div>
              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 bg-amber-50/40 p-3 rounded-lg border border-amber-200">
                <div className="md:col-span-2"><label className="label">Tender ID *</label><input className="input" value={form.tender_id||''} onChange={e=>F('tender_id',e.target.value)} required={form.lead_kind==='government'} placeholder="e.g. GEM/2026/B/12345"/></div>
                <div><label className="label">Bid Deadline</label><input className="input" type="date" value={form.bid_deadline||''} onChange={e=>F('bid_deadline',e.target.value)} min={new Date().toISOString().slice(0,10)}/></div>
                <div><label className="label">EMD Amount (₹)</label><input className="input" type="number" min="0" value={form.emd_amount||0} onChange={e=>F('emd_amount',+e.target.value)}/></div>
                <div className="md:col-span-4 flex items-center gap-2 pt-1">
                  <input id="pbg" type="checkbox" className="w-4 h-4" checked={!!form.pbg_required} onChange={e=>F('pbg_required',e.target.checked?1:0)}/>
                  <label htmlFor="pbg" className="text-sm">PBG (Performance Bank Guarantee) Required</label>
                </div>
              </div>
            </>
          )}

          {/* Source + assignment */}
          <div className="border-t pt-3"><h5 className="font-bold text-sm text-red-700 mb-2">Source &amp; Assignment</h5></div>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3">
            <div>
              <label className="label">Source</label>
              <select className="select" value={form.source||''} onChange={e=>F('source',e.target.value)}>
                <option value="">Select</option>
                {['Website','Referral','Cold','IPC','GeM','CPPP','State Portal','Repeat'].map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <div><label className="label">SC (Sales Coordinator)</label><input className="input" value={form.assigned_sc||''} onChange={e=>F('assigned_sc',e.target.value)}/></div>
            <div>
              <label className="label">ASM (Area Sales Mgr / BD)</label>
              {/* Employee dropdown with search — same pattern as Assign
                  Meeting. Stores name (display) + user_id (for the ASM
                  dashboard so they can find their assigned leads). */}
              <SearchableSelect
                options={employees.map(e => ({
                  value: e.id,
                  label: e.name + (e.designation ? ' — ' + e.designation : ''),
                  name: e.name,
                  user_id: e.user_id,
                }))}
                value={form.assigned_asm_employee_id || ''}
                onChange={(opt) => setForm(f => ({
                  ...f,
                  assigned_asm_employee_id: opt?.value || null,
                  assigned_asm: opt?.name || '',
                  assigned_asm_id: opt?.user_id || null,
                }))}
                placeholder="Search employee..."
              />
            </div>
          </div>
          <div><label className="label">Remarks</label><textarea className="input" rows="2" value={form.remarks||''} onChange={e=>F('remarks',e.target.value)}/></div>

          <div className="flex justify-end gap-3 pt-3 border-t">
            <button type="button" onClick={()=>setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{modal==='edit'?'Update':'Save & Assign'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
