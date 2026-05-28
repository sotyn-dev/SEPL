// Sub-contractor Hiring workflow tracker (mam 2026-05-28).
// Phase A: manual step tracker, file uploads, vendor candidate list,
// award flow, two PASS gates (Pre-Qualify + Docs Complete) with the
// loop-back arrows from mam's flowchart wired into the server.
//
// Two views in one page:
//   - List   : every workflow, current step + phase badge, open/delete
//   - Detail : 14-step vertical stepper with notes, uploads, candidates

import { useEffect, useState, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiPlus, FiTrash2, FiArrowLeft, FiUpload, FiDownload, FiPaperclip,
  FiUserPlus, FiCheckCircle, FiAlertTriangle, FiClock, FiAward, FiX,
} from 'react-icons/fi';

const PHASE_LABEL = { pre_award: 'Phase 1 · Pre-Award', onboarding: 'Phase 2 · Onboarding', done: 'Done' };
const STATUS_LABEL = { pending: 'Pending', in_progress: 'In Progress', done: 'Done', blocked: 'Blocked' };
const STATUS_CLS = {
  pending:     'bg-gray-100 text-gray-600 border-gray-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-300',
  done:        'bg-emerald-50 text-emerald-700 border-emerald-300',
  blocked:     'bg-red-50 text-red-700 border-red-300',
};

export default function SubconHiring() {
  const { canEdit, canDelete, canCreate } = useAuth();
  const [list, setList] = useState([]);
  const [openId, setOpenId] = useState(null);          // null = list view
  const [createOpen, setCreateOpen] = useState(false);
  const [sites, setSites] = useState([]);

  const load = useCallback(() => {
    api.get('/subcon-hiring').then(r => setList(r.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/dpr/sites').then(r => setSites(r.data || [])).catch(() => setSites([]));
  }, []);

  return (
    <div className="space-y-4">
      {openId == null && (
        <ListView
          list={list}
          onOpen={setOpenId}
          onCreate={() => setCreateOpen(true)}
          onReload={load}
          canCreate={canCreate('subcon_hiring')}
          canDelete={canDelete('subcon_hiring')}
        />
      )}
      {openId != null && (
        <DetailView
          id={openId}
          onBack={() => { setOpenId(null); load(); }}
          canEdit={canEdit('subcon_hiring')}
        />
      )}

      <Modal isOpen={createOpen} onClose={() => setCreateOpen(false)} title="Start new sub-contractor hiring">
        <CreateForm sites={sites} onDone={(id) => { setCreateOpen(false); load(); setOpenId(id); }} />
      </Modal>
    </div>
  );
}

// ─── LIST VIEW ────────────────────────────────────────────────────
function ListView({ list, onOpen, onCreate, onReload, canCreate, canDelete }) {
  const del = async (row) => {
    if (!confirm(`Delete hiring workflow for "${row.site_name}"? This removes all steps, candidates, files.`)) return;
    try { await api.delete(`/subcon-hiring/${row.id}`); toast.success('Deleted'); onReload(); }
    catch { toast.error('Delete failed'); }
  };
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xl font-bold flex items-center gap-2"><FiAward className="text-red-600" /> Sub-contractor Hiring</h2>
          <p className="text-xs text-gray-500">14-step workflow per site · Pre-Award → Onboarding</p>
        </div>
        {canCreate && (
          <button onClick={onCreate} className="btn btn-primary flex items-center gap-2"><FiPlus size={14} /> New Hiring</button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
            <tr>
              <th className="text-left p-2">Site</th>
              <th className="text-left p-2">Scope</th>
              <th className="text-center p-2">Phase</th>
              <th className="text-center p-2">Current Step</th>
              <th className="text-left p-2">Awarded Vendor</th>
              <th className="text-left p-2">Raised By</th>
              <th className="text-center p-2">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {list.map(r => (
              <tr key={r.id} className="hover:bg-red-50/30">
                <td className="p-2 font-semibold">{r.site_name}</td>
                <td className="p-2 text-xs text-gray-600 truncate max-w-[260px]">{r.scope_description || <em className="text-gray-400">—</em>}</td>
                <td className="p-2 text-center">
                  <span className={`inline-block text-[10px] font-bold uppercase px-2 py-0.5 rounded ${
                    r.status === 'completed' ? 'bg-emerald-100 text-emerald-700' :
                    r.phase === 'pre_award' ? 'bg-sky-100 text-sky-700' :
                    'bg-purple-100 text-purple-700'}`}>
                    {r.status === 'completed' ? 'Completed' : PHASE_LABEL[r.phase] || r.phase}
                  </span>
                </td>
                <td className="p-2 text-center font-mono text-xs">Step {r.current_step} / 14</td>
                <td className="p-2 text-xs">{r.awarded_vendor_name || <em className="text-gray-400">— not yet —</em>}</td>
                <td className="p-2 text-xs text-gray-600">{r.created_by_name || '—'}</td>
                <td className="p-2 text-center">
                  <div className="flex justify-center gap-1">
                    <button onClick={() => onOpen(r.id)} className="btn btn-secondary text-xs">Open</button>
                    {canDelete && <button onClick={() => del(r)} className="p-1.5 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {list.length === 0 && (
              <tr><td colSpan="7" className="text-center py-10 text-gray-400 text-sm">
                <FiAward size={32} className="mx-auto mb-2 opacity-30" />
                No hiring workflows yet. Click <b>New Hiring</b> to start one.
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}

// ─── CREATE FORM ──────────────────────────────────────────────────
function CreateForm({ sites, onDone }) {
  const [siteId, setSiteId] = useState('');
  const [scope, setScope] = useState('');
  const [saving, setSaving] = useState(false);
  const submit = async (e) => {
    e.preventDefault();
    if (!siteId) { toast.error('Pick a site'); return; }
    setSaving(true);
    try {
      const r = await api.post('/subcon-hiring', { site_id: siteId, scope_description: scope });
      toast.success('Workflow created');
      onDone(r.data.id);
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
    setSaving(false);
  };
  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label className="label">Site *</label>
        <SearchableSelect
          options={sites.map(s => ({ id: s.id, label: `${s.name}${s.client_name ? ` · ${s.client_name}` : ''}` }))}
          value={siteId}
          valueKey="id"
          displayKey="label"
          placeholder="Pick a project / site…"
          onChange={v => setSiteId(v?.id || '')}
        />
      </div>
      <div>
        <label className="label">Scope description</label>
        <input className="input" value={scope} onChange={e => setScope(e.target.value)}
               placeholder="e.g. Plumbing trade for HERO Homes, Phase 2" />
        <p className="text-[11px] text-gray-500 mt-1">Free-text — what's the sub-let scope? Trade name, area, etc.</p>
      </div>
      <div className="flex justify-end gap-2">
        <button type="submit" disabled={saving} className="btn btn-primary disabled:opacity-40">{saving ? 'Creating…' : 'Create & Open'}</button>
      </div>
    </form>
  );
}

// ─── DETAIL VIEW ──────────────────────────────────────────────────
function DetailView({ id, onBack, canEdit }) {
  const [data, setData] = useState(null);
  const [vendors, setVendors] = useState([]);

  const load = useCallback(() => {
    api.get(`/subcon-hiring/${id}`).then(r => setData(r.data)).catch(() => toast.error('Failed to load'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/sub-contractors').then(r => setVendors(r.data || [])).catch(() => setVendors([]));
  }, []);

  if (!data) return <div className="card p-6 text-center text-gray-400">Loading…</div>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="btn btn-secondary text-xs flex items-center gap-1"><FiArrowLeft size={14} /> Back</button>
          <div>
            <h2 className="text-lg font-bold">{data.site_name}</h2>
            <p className="text-xs text-gray-500">{data.scope_description || <em>No scope set</em>} · {data.client_name || '—'}</p>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] uppercase text-gray-500">{PHASE_LABEL[data.phase]}</div>
          <div className="text-base font-bold text-red-700">Step {data.current_step} / 14</div>
          {data.awarded_vendor_name && (
            <div className="text-xs mt-0.5"><FiAward className="inline text-amber-600 mr-1" size={12} />Awarded: <b>{data.awarded_vendor_name}</b></div>
          )}
        </div>
      </div>

      {/* Candidate vendors panel (Step 3-6) */}
      <CandidatesPanel hiringId={id} data={data} vendors={vendors} canEdit={canEdit} onReload={load} />

      {/* 14-step stepper */}
      <div className="card p-0 overflow-hidden">
        {data.steps_meta.map(meta => {
          const step = data.steps.find(s => s.step_no === meta.no);
          return (
            <StepRow
              key={meta.no}
              meta={meta}
              step={step}
              hiringId={id}
              files={data.files.filter(f => f.step_no === meta.no)}
              canEdit={canEdit}
              onReload={load}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─── ONE STEP ROW ─────────────────────────────────────────────────
function StepRow({ meta, step, hiringId, files, canEdit, onReload }) {
  const [editing, setEditing] = useState(false);
  const [notes, setNotes] = useState(step?.notes || '');
  const [statusDraft, setStatusDraft] = useState(step?.status || 'pending');
  const [decisionVal, setDecisionVal] = useState(step?.decision_value ?? '');
  const [uploading, setUploading] = useState(false);

  const isGate = !!meta.gate;
  const statusCls = STATUS_CLS[step?.status || 'pending'];

  const save = async () => {
    try {
      await api.post(`/subcon-hiring/${hiringId}/step/${meta.no}`, {
        status: statusDraft, notes, decision_value: decisionVal === '' ? null : +decisionVal,
      });
      toast.success(`Step ${meta.no} saved`);
      setEditing(false); onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const decideGate = async (pass) => {
    const reason = pass ? null : prompt('Reason for failing this gate (loops back)?');
    if (!pass && reason === null) return;
    try {
      const gate = meta.gate; // 'prequalify' or 'docs'
      await api.post(`/subcon-hiring/${hiringId}/gate/${gate}`, {
        pass, decision_value: decisionVal === '' ? null : +decisionVal,
        notes: reason ? `LOOP-BACK: ${reason}` : 'PASS',
      });
      toast.success(pass ? 'Gate passed — advanced' : 'Looped back to earlier step');
      onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Gate failed'); }
  };

  const upload = async (e) => {
    const f = e.target.files?.[0]; if (!f) return;
    const fd = new FormData(); fd.append('file', f);
    setUploading(true);
    try {
      await api.post(`/subcon-hiring/${hiringId}/step/${meta.no}/upload`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success('Uploaded'); onReload();
    } catch { toast.error('Upload failed'); }
    setUploading(false); e.target.value = '';
  };

  const delFile = async (fileId) => {
    if (!confirm('Delete this file?')) return;
    try { await api.delete(`/subcon-hiring/file/${fileId}`); toast.success('Deleted'); onReload(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className={`border-b border-gray-100 ${step?.status === 'in_progress' ? 'bg-amber-50/40' : ''}`}>
      <div className="flex items-start gap-3 p-3">
        {/* Step number bubble */}
        <div className={`flex-shrink-0 w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm ${
          step?.status === 'done' ? 'bg-emerald-600 text-white' :
          step?.status === 'in_progress' ? 'bg-amber-500 text-white animate-pulse' :
          step?.status === 'blocked' ? 'bg-red-500 text-white' :
          'bg-gray-200 text-gray-500'
        }`}>
          {step?.status === 'done' ? <FiCheckCircle size={18} /> : meta.no}
        </div>

        {/* Step body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <div>
              <div className="font-semibold text-sm flex items-center gap-2">
                {meta.label}
                {isGate && <span className="text-[9px] font-bold uppercase px-1.5 py-0.5 rounded bg-purple-100 text-purple-700 border border-purple-300">GATE</span>}
              </div>
              <div className="text-[10px] text-gray-500 uppercase tracking-wide">{meta.owner}</div>
            </div>
            <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded border ${statusCls}`}>
              {STATUS_LABEL[step?.status || 'pending']}
            </span>
          </div>

          {step?.notes && !editing && (
            <p className="mt-1.5 text-xs text-gray-600 italic whitespace-pre-wrap">{step.notes}</p>
          )}
          {step?.decision_value != null && !editing && (
            <p className="mt-0.5 text-[11px] text-purple-700"><b>Score / decision:</b> {step.decision_value}</p>
          )}
          {step?.completed_by_name && step?.completed_at && (
            <p className="mt-0.5 text-[10px] text-gray-400">Done by {step.completed_by_name} · {String(step.completed_at).replace('T', ' ').slice(0, 16)}</p>
          )}

          {/* Files */}
          {files.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {files.map(f => (
                <span key={f.id} className="inline-flex items-center gap-1 text-[11px] bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-0.5">
                  <FiPaperclip size={10} />
                  <a href={`/api/subcon-hiring/file/${f.id}`} target="_blank" rel="noreferrer" className="hover:underline truncate max-w-[180px]">{f.filename}</a>
                  {canEdit && <button onClick={() => delFile(f.id)} className="text-blue-400 hover:text-red-600 ml-0.5"><FiX size={10} /></button>}
                </span>
              ))}
            </div>
          )}

          {/* Editor */}
          {editing && (
            <div className="mt-2 space-y-2 bg-gray-50 border border-gray-200 rounded p-2">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <div>
                  <label className="text-[10px] font-semibold uppercase text-gray-500">Status</label>
                  <select className="select text-xs" value={statusDraft} onChange={e => setStatusDraft(e.target.value)}>
                    <option value="pending">Pending</option>
                    <option value="in_progress">In Progress</option>
                    <option value="done">Done</option>
                    <option value="blocked">Blocked</option>
                  </select>
                </div>
                {isGate && (
                  <div>
                    <label className="text-[10px] font-semibold uppercase text-gray-500">
                      {meta.gate === 'prequalify' ? 'Vendor score (0–10)' : 'Docs % complete'}
                    </label>
                    <input type="number" min="0" max="10" step="0.1" className="input text-xs"
                      value={decisionVal} onChange={e => setDecisionVal(e.target.value)} placeholder="e.g. 7.5" />
                  </div>
                )}
              </div>
              <div>
                <label className="text-[10px] font-semibold uppercase text-gray-500">Notes</label>
                <textarea className="input text-xs" rows="2" value={notes} onChange={e => setNotes(e.target.value)}
                  placeholder="What happened on this step?" />
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={() => setEditing(false)} className="btn btn-secondary text-xs">Cancel</button>
                <button onClick={save} className="btn btn-primary text-xs">Save</button>
              </div>
            </div>
          )}

          {/* Action row */}
          {canEdit && !editing && (
            <div className="mt-2 flex flex-wrap gap-1.5 items-center">
              <button onClick={() => setEditing(true)} className="btn btn-secondary text-xs">Edit · Notes</button>
              <label className="btn btn-secondary text-xs flex items-center gap-1 cursor-pointer mb-0">
                <FiUpload size={12} />{uploading ? 'Uploading…' : 'Upload File'}
                <input type="file" className="hidden" onChange={upload} disabled={uploading} />
              </label>
              {isGate && step?.status !== 'done' && (
                <>
                  <button onClick={() => decideGate(true)} className="btn btn-success text-xs">Gate PASS → advance</button>
                  <button onClick={() => decideGate(false)} className="btn btn-danger text-xs">Gate FAIL → loop back</button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── CANDIDATES PANEL (Steps 3-6 supporting data) ────────────────
function CandidatesPanel({ hiringId, data, vendors, canEdit, onReload }) {
  const [vendorId, setVendorId] = useState('');
  const [quote, setQuote] = useState('');
  const [score, setScore] = useState('');

  const add = async () => {
    if (!vendorId) { toast.error('Pick a vendor'); return; }
    try {
      await api.post(`/subcon-hiring/${hiringId}/candidate`, {
        vendor_id: vendorId, quote_amount: quote ? +quote : null, qualification_score: score ? +score : null,
      });
      toast.success('Vendor shortlisted');
      setVendorId(''); setQuote(''); setScore(''); onReload();
    } catch (e) { toast.error(e.response?.data?.error || 'Failed'); }
  };

  const award = async (cid) => {
    if (!confirm('Award the work to this vendor? This sets them as the winner of this hiring.')) return;
    try { await api.post(`/subcon-hiring/${hiringId}/award/${cid}`); toast.success('Awarded'); onReload(); }
    catch { toast.error('Failed'); }
  };

  const remove = async (cid) => {
    if (!confirm('Remove this candidate from the shortlist?')) return;
    try { await api.delete(`/subcon-hiring/candidate/${cid}`); toast.success('Removed'); onReload(); }
    catch { toast.error('Failed'); }
  };

  return (
    <div className="card p-3 space-y-2">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold text-sm flex items-center gap-2"><FiUserPlus className="text-red-600" /> Candidate Vendors</h3>
        <span className="text-[10px] text-gray-500">Used by Steps 3 (Source) → 4 (Pre-Qualify) → 5 (RFQ) → 6 (Award)</span>
      </div>

      {data.candidates.length === 0 && (
        <p className="text-xs text-gray-400 italic">No candidates yet. Add at least 3 vendors per mam's flowchart spec.</p>
      )}
      {data.candidates.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
              <tr>
                <th className="text-left p-1.5">Vendor</th>
                <th className="text-left p-1.5">Trade</th>
                <th className="text-right p-1.5">Quote (₹)</th>
                <th className="text-center p-1.5">Score / 10</th>
                <th className="text-center p-1.5">Status</th>
                {canEdit && <th className="text-center p-1.5">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {data.candidates.map(c => (
                <tr key={c.id} className={c.status === 'awarded' ? 'bg-amber-50' : ''}>
                  <td className="p-1.5 font-medium">{c.vendor_name}</td>
                  <td className="p-1.5 text-gray-600">{c.specialization || '—'}</td>
                  <td className="p-1.5 text-right">{c.quote_amount ? `Rs ${(+c.quote_amount).toLocaleString('en-IN')}` : '—'}</td>
                  <td className="p-1.5 text-center">{c.qualification_score ?? '—'}</td>
                  <td className="p-1.5 text-center">
                    {c.status === 'awarded' && <span className="text-[10px] font-bold text-amber-700"><FiAward className="inline" size={11} /> AWARDED</span>}
                    {c.status === 'rejected' && <span className="text-[10px] text-red-600">Rejected</span>}
                    {c.status === 'shortlisted' && <span className="text-[10px] text-gray-600">Shortlisted</span>}
                  </td>
                  {canEdit && (
                    <td className="p-1.5 text-center">
                      <div className="flex justify-center gap-1">
                        {c.status !== 'awarded' && !data.awarded_vendor_id && (
                          <button onClick={() => award(c.id)} className="btn btn-success text-[10px] py-0.5 px-1.5" title="Award">Award</button>
                        )}
                        <button onClick={() => remove(c.id)} className="p-1 text-gray-400 hover:text-red-600" title="Remove"><FiX size={12} /></button>
                      </div>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canEdit && (
        <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end pt-2 border-t border-gray-100">
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Add vendor from Master Detail</label>
            <SearchableSelect
              options={vendors.map(v => ({ id: v.id, label: `${v.name}${v.specialization ? ` · ${v.specialization}` : ''}` }))}
              value={vendorId}
              valueKey="id"
              displayKey="label"
              placeholder="Pick a sub-contractor…"
              onChange={v => setVendorId(v?.id || '')}
            />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Quote ₹</label>
            <input type="number" className="input text-xs w-28" value={quote} onChange={e => setQuote(e.target.value)} placeholder="0" />
          </div>
          <div>
            <label className="text-[10px] font-semibold uppercase text-gray-500">Score /10</label>
            <input type="number" min="0" max="10" step="0.1" className="input text-xs w-20" value={score} onChange={e => setScore(e.target.value)} placeholder="0.0" />
          </div>
          <button onClick={add} className="btn btn-primary text-xs flex items-center gap-1"><FiPlus size={12} /> Add</button>
        </div>
      )}
    </div>
  );
}
