import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import StatusBadge from '../components/StatusBadge';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiCalendar, FiCheckCircle, FiUser, FiFileText, FiAward } from 'react-icons/fi';

const candidateStatuses = ['lead','called','qualified','interview_scheduled','interview_done','offer_sent','accepted','onboarded','rejected'];
const sources = ['facebook','naukri','linkedin','reference','other'];

// ---------- Pipeline stage helper ----------
// Translate a candidate row into a clear "current stage" label + the next
// allowed action(s). mam's flow is:
//   1) Lead              → Schedule Interview
//   2) Interview Scheduled → Mark Interview Done (decision)
//   3) Qualified (shortlisted by interviewer) → Schedule MD Interview, then MD Decision
//   4) Offer Sent        → Mark Accepted / Onboarded
//   5) Onboarded / Rejected — final
function pipelineFor(c) {
  const s = c.status || 'lead';
  if (s === 'lead' || s === 'called') {
    return { label: 'New Lead', color: 'bg-gray-100 text-gray-700 border-gray-300', next: 'schedule_interview' };
  }
  if (s === 'interview_scheduled') {
    return { label: 'Interview Scheduled', color: 'bg-blue-100 text-blue-700 border-blue-300', next: 'interview_done' };
  }
  if (s === 'interview_done') {
    // On-hold or pending decision after first interview
    return { label: 'Interview Done · pending decision', color: 'bg-amber-100 text-amber-700 border-amber-300', next: 'interview_decision' };
  }
  if (s === 'qualified') {
    // Shortlisted by interviewer; decide if MD round is scheduled yet.
    if (c.md_interview_date && !c.md_decision) {
      return { label: 'MD Interview Scheduled', color: 'bg-purple-100 text-purple-700 border-purple-300', next: 'md_decision' };
    }
    return { label: 'Shortlisted · MD round pending', color: 'bg-emerald-50 text-emerald-700 border-emerald-300', next: 'schedule_md' };
  }
  if (s === 'offer_sent') {
    return { label: 'Offer Sent', color: 'bg-indigo-100 text-indigo-700 border-indigo-300', next: 'finalize' };
  }
  if (s === 'accepted') {
    return { label: 'Offer Accepted', color: 'bg-teal-100 text-teal-700 border-teal-300', next: 'finalize' };
  }
  if (s === 'onboarded') {
    return { label: 'Onboarded ✓', color: 'bg-green-100 text-green-800 border-green-400', next: null };
  }
  if (s === 'rejected') {
    return { label: 'Rejected', color: 'bg-red-100 text-red-700 border-red-300', next: null };
  }
  return { label: s, color: 'bg-gray-100 text-gray-700 border-gray-300', next: null };
}

export default function HR() {
  const { canDelete } = useAuth();
  const [tab, setTab] = useState('candidates');
  const [candidates, setCandidates] = useState([]);
  const [contractors, setContractors] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [stageForm, setStageForm] = useState({});
  const [stageRow, setStageRow] = useState(null);
  const [uploading, setUploading] = useState(false);

  const load = () => {
    api.get('/hr/candidates').then(r => setCandidates(r.data));
    api.get('/hr/sub-contractors').then(r => setContractors(r.data));
    api.get('/hr/employees').then(r => setEmployees(r.data || [])).catch(() => setEmployees([]));
  };
  useEffect(() => { load(); }, []);

  // Generic file upload helper — reuses /upload, returns the served URL.
  const uploadFile = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data.url;
    } catch {
      toast.error('Upload failed');
      return null;
    } finally { setUploading(false); }
  };

  const saveCandidate = async (e) => {
    e.preventDefault();
    // Upload the resume first (if attached) and stash the URL on the
    // candidate row so the same file flows naturally into Stage 2's
    // schedule-interview screen — no need to re-upload there.
    let payload = { ...form };
    delete payload._file; // never POST the File object itself
    if (form._file) {
      const url = await uploadFile(form._file);
      if (!url) return; // uploadFile shows its own error toast
      payload.resume_file = url;
    }
    if (editing) { await api.put(`/hr/candidates/${editing.id}`, payload); }
    else { await api.post('/hr/candidates', payload); }
    toast.success(editing ? 'Updated' : 'Added candidate (Stage 1 — Lead)');
    setModal(false); load();
  };

  const saveContractor = async (e) => {
    e.preventDefault();
    if (editing) { await api.put(`/hr/sub-contractors/${editing.id}`, form); }
    else { await api.post('/hr/sub-contractors', form); }
    toast.success(editing ? 'Updated' : 'Created');
    setModal(false); load();
  };

  // ---------- Pipeline action handlers ----------
  const openStage = (row, stage) => { setStageRow(row); setStageForm({}); setModal(stage); };

  const submitScheduleInterview = async (e) => {
    e.preventDefault();
    if (!stageForm.interviewer_id) return toast.error('Pick an interviewer');
    if (!stageForm.interview_date) return toast.error('Pick interview date & time');
    let resumeUrl = stageForm.resume_file || stageRow?.resume_file || null;
    if (stageForm._file) resumeUrl = await uploadFile(stageForm._file);
    if (!resumeUrl) return toast.error('Upload the candidate resume');
    await api.post(`/hr/candidates/${stageRow.id}/schedule-interview`, {
      interviewer_id: +stageForm.interviewer_id,
      interview_date: stageForm.interview_date,
      resume_file: resumeUrl,
      notes: stageForm.notes,
    });
    toast.success('Interview scheduled — Stage 2');
    setModal(false); load();
  };

  const submitInterviewDecision = async (e) => {
    e.preventDefault();
    if (!stageForm.decision) return toast.error('Pick a decision');
    await api.post(`/hr/candidates/${stageRow.id}/interview-done`, {
      decision: stageForm.decision,
      notes: stageForm.notes,
    });
    const m = stageForm.decision === 'shortlisted' ? 'Shortlisted — schedule MD interview next'
            : stageForm.decision === 'rejected'    ? 'Marked rejected'
            : 'On hold — keep in pipeline';
    toast.success(m);
    setModal(false); load();
  };

  const submitScheduleMD = async (e) => {
    e.preventDefault();
    if (!stageForm.md_interview_date) return toast.error('Pick MD interview date & time');
    await api.post(`/hr/candidates/${stageRow.id}/schedule-md-interview`, {
      md_interview_date: stageForm.md_interview_date,
      notes: stageForm.notes,
    });
    toast.success('MD interview scheduled — Stage 4');
    setModal(false); load();
  };

  const submitMDDecision = async (e) => {
    e.preventDefault();
    if (!stageForm.decision) return toast.error('Pick a decision');
    let offerUrl = stageForm.offer_letter_file || null;
    if (stageForm.decision === 'shortlisted') {
      if (stageForm._file) offerUrl = await uploadFile(stageForm._file);
      if (!offerUrl) return toast.error('Upload the offer letter PDF');
    }
    await api.post(`/hr/candidates/${stageRow.id}/md-decision`, {
      decision: stageForm.decision,
      notes: stageForm.notes,
      offer_letter_file: offerUrl,
    });
    toast.success(stageForm.decision === 'shortlisted' ? 'Offer letter sent ✓' : 'Rejected by MD');
    setModal(false); load();
  };

  const submitFinalize = async (e) => {
    e.preventDefault();
    if (!stageForm.final_status) return toast.error('Pick final status');
    await api.post(`/hr/candidates/${stageRow.id}/finalize`, {
      final_status: stageForm.final_status,
      notes: stageForm.notes,
    });
    toast.success('Status updated');
    setModal(false); load();
  };

  const fmtDt = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  };

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <button onClick={() => setTab('candidates')} className={`btn ${tab === 'candidates' ? 'btn-primary' : 'btn-secondary'}`}>Candidates</button>
        <button onClick={() => setTab('contractors')} className={`btn ${tab === 'contractors' ? 'btn-primary' : 'btn-secondary'}`}>Sub-Contractors</button>
      </div>

      {tab === 'candidates' && (
        <>
          <div className="flex justify-between items-center flex-wrap gap-2">
            <div>
              <h3 className="font-semibold">Hiring Pipeline</h3>
              <p className="text-[11px] text-gray-500">5 stages: Lead → Schedule Interview → Interview Decision → MD Round → Offer & Onboarding</p>
            </div>
            <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', source: 'naukri', position: '', notes: '' }); setModal('candidate'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Candidate</button>
          </div>

          <div className="card p-0 overflow-x-auto">
            <table className="text-sm w-full">
              <thead className="bg-gray-50">
                <tr>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Candidate</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Position / Source</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Pipeline Stage</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Interview Details</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Files</th>
                  <th className="text-left px-3 py-2 text-[10px] font-semibold text-gray-500 uppercase">Actions</th>
                </tr>
              </thead>
              <tbody>
                {candidates.map(c => {
                  const p = pipelineFor(c);
                  return (
                    <tr key={c.id} className="border-t hover:bg-gray-50/60 align-top">
                      <td className="px-3 py-2">
                        <div className="font-medium text-gray-900">{c.name}</div>
                        {c.phone && <div className="text-[11px] text-gray-500">📞 {c.phone}</div>}
                        {c.email && <div className="text-[11px] text-gray-500">✉️ {c.email}</div>}
                      </td>
                      <td className="px-3 py-2 text-[12px]">
                        <div>{c.position || <span className="text-gray-300">—</span>}</div>
                        <div className="text-[10px] text-gray-400 capitalize">{c.source}</div>
                      </td>
                      <td className="px-3 py-2">
                        <span className={`text-[11px] font-bold uppercase px-2 py-1 rounded border ${p.color}`}>{p.label}</span>
                      </td>
                      <td className="px-3 py-2 text-[11px] space-y-0.5">
                        {c.interviewer_name && <div><FiUser className="inline mr-1 text-gray-400" size={11}/>{c.interviewer_name}</div>}
                        {c.interview_date && <div><FiCalendar className="inline mr-1 text-gray-400" size={11}/>1st: {fmtDt(c.interview_date)}</div>}
                        {c.interview_decision && (
                          <div className={`inline-block text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ${c.interview_decision === 'shortlisted' ? 'bg-emerald-100 text-emerald-700' : c.interview_decision === 'rejected' ? 'bg-red-100 text-red-700' : 'bg-amber-100 text-amber-700'}`}>1st: {c.interview_decision}</div>
                        )}
                        {c.md_interview_date && <div><FiCalendar className="inline mr-1 text-purple-400" size={11}/>MD: {fmtDt(c.md_interview_date)}</div>}
                        {c.md_decision && (
                          <div className={`inline-block text-[9px] uppercase font-bold px-1.5 py-0.5 rounded ml-1 ${c.md_decision === 'shortlisted' ? 'bg-emerald-100 text-emerald-700' : 'bg-red-100 text-red-700'}`}>MD: {c.md_decision}</div>
                        )}
                      </td>
                      <td className="px-3 py-2 text-[11px] space-y-1">
                        {c.resume_file && <a href={c.resume_file} target="_blank" rel="noreferrer" className="block text-blue-600 hover:underline"><FiFileText className="inline mr-1" size={11}/>Resume</a>}
                        {c.offer_letter_file && <a href={c.offer_letter_file} target="_blank" rel="noreferrer" className="block text-emerald-600 hover:underline"><FiAward className="inline mr-1" size={11}/>Offer Letter</a>}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-wrap gap-1">
                          {p.next === 'schedule_interview' && <button onClick={() => openStage(c, 'schedule_interview')} className="btn btn-primary text-[11px] py-1 px-2"><FiCalendar size={11} className="inline mr-1"/>Schedule Interview</button>}
                          {p.next === 'interview_done' && <button onClick={() => openStage(c, 'interview_decision')} className="btn btn-primary text-[11px] py-1 px-2"><FiCheckCircle size={11} className="inline mr-1"/>Mark Interview Done</button>}
                          {p.next === 'interview_decision' && <button onClick={() => openStage(c, 'interview_decision')} className="btn btn-primary text-[11px] py-1 px-2">Decision</button>}
                          {p.next === 'schedule_md' && <button onClick={() => openStage(c, 'schedule_md')} className="btn btn-primary text-[11px] py-1 px-2"><FiCalendar size={11} className="inline mr-1"/>Schedule MD Interview</button>}
                          {p.next === 'md_decision' && <button onClick={() => openStage(c, 'md_decision')} className="btn btn-primary text-[11px] py-1 px-2"><FiAward size={11} className="inline mr-1"/>MD Decision + Offer</button>}
                          {p.next === 'finalize' && <button onClick={() => openStage(c, 'finalize')} className="btn btn-primary text-[11px] py-1 px-2"><FiCheckCircle size={11} className="inline mr-1"/>Mark Onboarded</button>}
                          <button onClick={() => { setEditing(c); setForm(c); setModal('candidate'); }} className="p-1 text-gray-400 hover:text-blue-600" title="Edit basic info"><FiEdit2 size={14} /></button>
                          {canDelete('hr') && <button onClick={async () => {
                            if (!confirm(`Delete candidate "${c.name}"?`)) return;
                            try { await api.delete(`/hr/candidates/${c.id}`); toast.success('Deleted'); load(); }
                            catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                          }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {candidates.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No candidates yet — click "Add Candidate" to start the pipeline</td></tr>}
              </tbody>
            </table>
          </div>
        </>
      )}

      {tab === 'contractors' && (
        <>
          <div className="flex justify-between items-center">
            <h3 className="font-semibold">Sub-Contractors</h3>
            <button onClick={() => { setEditing(null); setForm({ name: '', phone: '', email: '', specialization: '', rate: 0, rate_unit: 'per_day', notes: '' }); setModal('contractor'); }} className="btn btn-primary flex items-center gap-2"><FiPlus /> Add Contractor</button>
          </div>
          <div className="card p-0 overflow-x-auto"><table>
            <thead><tr><th>Name</th><th>Phone</th><th>Specialization</th><th>Rate</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
              {contractors.map(c => (
                <tr key={c.id}>
                  <td className="font-medium">{c.name}</td><td>{c.phone}</td><td>{c.specialization}</td>
                  <td>Rs {c.rate}/{c.rate_unit?.replace(/_/g,' ')}</td><td><StatusBadge status={c.status} /></td>
                  <td><div className="flex gap-1">
                    <button onClick={() => { setEditing(c); setForm(c); setModal('contractor'); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiEdit2 size={15} /></button>
                    {canDelete('hr') && <button onClick={async () => {
                      if (!confirm(`Delete contractor "${c.name}"?`)) return;
                      try { await api.delete(`/hr/sub-contractors/${c.id}`); toast.success('Deleted'); load(); }
                      catch (err) { toast.error(err.response?.data?.error || 'Delete failed'); }
                    }} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={14} /></button>}
                  </div></td>
                </tr>
              ))}
              {contractors.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No contractors yet</td></tr>}
            </tbody>
          </table></div>
        </>
      )}

      {/* ADD / EDIT CANDIDATE — basic info only. Stage actions live in their own modals. */}
      <Modal isOpen={modal === 'candidate'} onClose={() => setModal(false)} title={editing ? 'Edit Candidate' : 'Add Candidate'}>
        <form onSubmit={saveCandidate} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div><label className="label">Position</label><input className="input" value={form.position || ''} onChange={e => setForm({...form, position: e.target.value})} /></div>
            <div><label className="label">Source</label><select className="select" value={form.source || ''} onChange={e => setForm({...form, source: e.target.value})}>{sources.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{candidateStatuses.map(s => <option key={s} value={s}>{s.replace(/_/g,' ')}</option>)}</select></div>}
          </div>
          <div>
            <label className="label">Resume <span className="text-gray-400 font-normal text-[10px]">(optional · PDF / DOC / DOCX)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.doc,.docx"
              onChange={e => setForm({...form, _file: e.target.files?.[0] || null})}
            />
            {/* Show the existing resume link when editing — uploading a new
                file replaces it; otherwise the existing URL is preserved. */}
            {editing && form.resume_file && !form._file && (
              <p className="text-[10px] text-emerald-600 mt-0.5">Existing: <a href={form.resume_file} target="_blank" rel="noreferrer" className="underline">view resume</a> · upload a new file to replace</p>
            )}
            {form._file && <p className="text-[10px] text-blue-600 mt-0.5">Selected: {form._file.name}</p>}
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : (editing ? 'Update' : 'Add Candidate')}</button></div>
        </form>
      </Modal>

      {/* STAGE 2 — SCHEDULE FIRST INTERVIEW */}
      <Modal isOpen={modal === 'schedule_interview'} onClose={() => setModal(false)} title={`Schedule Interview — ${stageRow?.name || ''}`}>
        <form onSubmit={submitScheduleInterview} className="space-y-3">
          <p className="text-[11px] text-blue-700 bg-blue-50 border border-blue-100 rounded px-3 py-2">Pick the concerned interviewer (an employee), set a date/time, and upload the candidate's resume. Status will move to "Interview Scheduled".</p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Interviewer (Employee) *</label>
              <select className="select" required value={stageForm.interviewer_id || ''} onChange={e => setStageForm(f => ({ ...f, interviewer_id: e.target.value }))}>
                <option value="">— Pick employee —</option>
                {employees.map(e => <option key={e.id} value={e.id}>{e.name}{e.designation ? ` (${e.designation})` : ''}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Interview Date & Time *</label>
              <input className="input" type="datetime-local" required value={stageForm.interview_date || ''} onChange={e => setStageForm(f => ({ ...f, interview_date: e.target.value }))} />
            </div>
          </div>
          <div>
            <label className="label">Resume <span className="text-red-500">*</span> <span className="text-gray-400 font-normal text-[10px]">(PDF / DOC / DOCX)</span></label>
            <input className="input" type="file" accept=".pdf,.doc,.docx" onChange={e => setStageForm(f => ({ ...f, _file: e.target.files?.[0] || null }))} />
            {stageRow?.resume_file && !stageForm._file && (
              <p className="text-[10px] text-emerald-600 mt-0.5">Existing: <a href={stageRow.resume_file} target="_blank" rel="noreferrer" className="underline">view resume</a> · upload a new one to replace</p>
            )}
          </div>
          <div><label className="label">Notes / Instructions</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="e.g. Test technical aptitude on JavaScript / specific topics" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Schedule Interview'}</button></div>
        </form>
      </Modal>

      {/* STAGE 3 — INTERVIEW DECISION */}
      <Modal isOpen={modal === 'interview_decision'} onClose={() => setModal(false)} title={`Interview Decision — ${stageRow?.name || ''}`}>
        <form onSubmit={submitInterviewDecision} className="space-y-3">
          <p className="text-[11px] text-amber-700 bg-amber-50 border border-amber-100 rounded px-3 py-2">After the first interview — record the interviewer's decision. <b>Shortlisted</b> moves to MD round; <b>Rejected</b> ends the pipeline.</p>
          {stageRow?.interview_date && <div className="text-[12px] text-gray-600">Interview held: <b>{fmtDt(stageRow.interview_date)}</b>{stageRow.interviewer_name ? ` · by ${stageRow.interviewer_name}` : ''}</div>}
          <div>
            <label className="label">Decision *</label>
            <div className="grid grid-cols-3 gap-2">
              {['shortlisted','on_hold','rejected'].map(d => (
                <button type="button" key={d} onClick={() => setStageForm(f => ({ ...f, decision: d }))}
                  className={`px-3 py-2 rounded-lg border text-xs font-bold uppercase ${stageForm.decision === d
                    ? (d === 'shortlisted' ? 'bg-emerald-600 text-white border-emerald-600' : d === 'rejected' ? 'bg-red-600 text-white border-red-600' : 'bg-amber-500 text-white border-amber-500')
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'}`}>
                  {d === 'on_hold' ? '⏸ On Hold' : d === 'shortlisted' ? '✓ Shortlist' : '✗ Reject'}
                </button>
              ))}
            </div>
          </div>
          <div><label className="label">Interview Notes (what did the interviewer think)</label><textarea className="input" rows="3" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="Strengths / weaknesses / fit / red flags" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save Decision</button></div>
        </form>
      </Modal>

      {/* STAGE 4 — SCHEDULE MD INTERVIEW */}
      <Modal isOpen={modal === 'schedule_md'} onClose={() => setModal(false)} title={`Schedule MD Interview — ${stageRow?.name || ''}`}>
        <form onSubmit={submitScheduleMD} className="space-y-3">
          <p className="text-[11px] text-purple-700 bg-purple-50 border border-purple-100 rounded px-3 py-2">Final round with MD Sir. Set a date/time. After MD's decision, the offer letter can be uploaded and sent.</p>
          <div>
            <label className="label">MD Interview Date & Time *</label>
            <input className="input" type="datetime-local" required value={stageForm.md_interview_date || ''} onChange={e => setStageForm(f => ({ ...f, md_interview_date: e.target.value }))} />
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} placeholder="Brief MD on the candidate's strengths" /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Schedule MD Round</button></div>
        </form>
      </Modal>

      {/* STAGE 5 — MD DECISION + OFFER LETTER */}
      <Modal isOpen={modal === 'md_decision'} onClose={() => setModal(false)} title={`MD Decision — ${stageRow?.name || ''}`}>
        <form onSubmit={submitMDDecision} className="space-y-3">
          <p className="text-[11px] text-indigo-700 bg-indigo-50 border border-indigo-100 rounded px-3 py-2">If MD shortlisted — upload the offer letter (PDF) and the candidate moves to "Offer Sent". If rejected — pipeline ends.</p>
          {stageRow?.md_interview_date && <div className="text-[12px] text-gray-600">MD round: <b>{fmtDt(stageRow.md_interview_date)}</b></div>}
          <div>
            <label className="label">MD's Decision *</label>
            <div className="grid grid-cols-2 gap-2">
              {['shortlisted','rejected'].map(d => (
                <button type="button" key={d} onClick={() => setStageForm(f => ({ ...f, decision: d }))}
                  className={`px-3 py-2 rounded-lg border text-xs font-bold uppercase ${stageForm.decision === d
                    ? (d === 'shortlisted' ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-red-600 text-white border-red-600')
                    : 'bg-white border-gray-200 hover:bg-gray-50 text-gray-700'}`}>
                  {d === 'shortlisted' ? '✓ Shortlist & Send Offer' : '✗ Reject'}
                </button>
              ))}
            </div>
          </div>
          {stageForm.decision === 'shortlisted' && (
            <div>
              <label className="label">Offer Letter <span className="text-red-500">*</span> <span className="text-gray-400 font-normal text-[10px]">(PDF / DOC / DOCX)</span></label>
              <input className="input" type="file" accept=".pdf,.doc,.docx" onChange={e => setStageForm(f => ({ ...f, _file: e.target.files?.[0] || null }))} />
            </div>
          )}
          <div><label className="label">MD's Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" disabled={uploading} className="btn btn-primary">{uploading ? 'Uploading…' : 'Save Decision'}</button></div>
        </form>
      </Modal>

      {/* STAGE 6 — FINALIZE (Onboarded / Accepted / Rejected) */}
      <Modal isOpen={modal === 'finalize'} onClose={() => setModal(false)} title={`Finalize — ${stageRow?.name || ''}`}>
        <form onSubmit={submitFinalize} className="space-y-3">
          <p className="text-[11px] text-teal-700 bg-teal-50 border border-teal-100 rounded px-3 py-2">Update final state — Accepted (offer accepted, joining pending) → Onboarded (candidate has joined).</p>
          <div>
            <label className="label">Final Status *</label>
            <select className="select" required value={stageForm.final_status || ''} onChange={e => setStageForm(f => ({ ...f, final_status: e.target.value }))}>
              <option value="">— Pick —</option>
              <option value="accepted">Offer Accepted (joining pending)</option>
              <option value="onboarded">Onboarded (joined, in payroll)</option>
              <option value="rejected">Candidate declined / Withdrawn</option>
            </select>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={stageForm.notes || ''} onChange={e => setStageForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Save</button></div>
        </form>
      </Modal>

      <Modal isOpen={modal === 'contractor'} onClose={() => setModal(false)} title={editing ? 'Edit Contractor' : 'Add Contractor'}>
        <form onSubmit={saveContractor} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div><label className="label">Specialization</label><input className="input" value={form.specialization || ''} onChange={e => setForm({...form, specialization: e.target.value})} /></div>
            <div><label className="label">Rate (Rs)</label><input className="input" type="number" value={form.rate || 0} onChange={e => setForm({...form, rate: +e.target.value})} /></div>
            <div><label className="label">Rate Unit</label><select className="select" value={form.rate_unit || 'per_day'} onChange={e => setForm({...form, rate_unit: e.target.value})}><option value="per_day">Per Day</option><option value="per_hour">Per Hour</option><option value="per_sqft">Per Sqft</option><option value="lump_sum">Lump Sum</option></select></div>
            {editing && <div><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['qualified','negotiation','onboarded','active','inactive'].map(s => <option key={s} value={s}>{s}</option>)}</select></div>}
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="3" value={form.notes || ''} onChange={e => setForm({...form, notes: e.target.value})} /></div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">{editing ? 'Update' : 'Create'}</button></div>
        </form>
      </Modal>
    </div>
  );
}
