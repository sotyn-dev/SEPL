// CRM Full Kitting — mam (2026-05-21):
//   "3 stages of crm full kitting of project which i need in erp.
//    drop down is :- Yes, No, Partially, N/A with upload photo of every
//    points.  and this also happen today upload photo after 5 days also
//    can upload photo but we see prvious history photo also".
//
// Page flow:
//   1. Project picker (typeahead) — sources from Business Book.
//   2. After pick, render 3 stage cards.  Each card is a list of
//      checkpoints.  Each checkpoint row shows: label, current status
//      chip, observation date, latest photo thumbnail, "Update" button
//      (opens modal), and "History (N)" link (opens drawer).
//   3. Admin gets a "⚙ Manage Checkpoints" pill (top-right) that
//      opens an editor drawer.
//
// Royal-blue theme to match the rest of the ERP.

import { useState, useEffect, useMemo } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import {
  FiCheckCircle, FiXCircle, FiAlertCircle, FiMinusCircle,
  FiCamera, FiClock, FiSettings, FiPlus, FiTrash2, FiEdit2,
  FiChevronDown, FiChevronUp, FiSearch, FiPackage, FiX,
  FiCalendar, FiUser,
} from 'react-icons/fi';

const STATUS_META = {
  yes:       { label: 'Yes',       icon: FiCheckCircle, chip: 'bg-emerald-100 text-emerald-700 border-emerald-200', dot: 'bg-emerald-500' },
  no:        { label: 'No',        icon: FiXCircle,     chip: 'bg-rose-100 text-rose-700 border-rose-200',          dot: 'bg-rose-500' },
  partially: { label: 'Partially', icon: FiAlertCircle, chip: 'bg-amber-100 text-amber-700 border-amber-200',       dot: 'bg-amber-500' },
  na:        { label: 'N/A',       icon: FiMinusCircle, chip: 'bg-slate-100 text-slate-600 border-slate-200',       dot: 'bg-slate-400' },
};

const STAGE_META = {
  1: { title: 'Stage 1 · Pre-Production / Order Confirmation', accent: 'from-blue-800 to-blue-900' },
  2: { title: 'Stage 2 · Production & Dispatch',                accent: 'from-indigo-800 to-indigo-900' },
  3: { title: 'Stage 3 · Site Installation & Handover',         accent: 'from-violet-800 to-violet-900' },
};

const todayISO = () => new Date().toISOString().slice(0, 10);
const minObsISO = () => {
  const d = new Date(); d.setDate(d.getDate() - 5);
  return d.toISOString().slice(0, 10);
};
const fmtDt = (iso) => iso ? new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' }) : '—';
const fmtD  = (iso) => iso ? new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium', timeZone: 'Asia/Kolkata' }) : '—';

// Cash-Flow-style ₹ formatter (lakh / cr) — matches the existing
// Cash Flow page so the kitting picker reads the same way mam expects.
const fmtINRShort = (v) => {
  const n = Number(v) || 0;
  if (n >= 1e7) return `₹${(n / 1e7).toFixed(2)} cr`;
  if (n >= 1e5) return `₹${(n / 1e5).toFixed(2)} L`;
  return `₹${n.toLocaleString('en-IN')}`;
};

export default function CRMKitting() {
  const { user, isAdmin } = useAuth();
  const [projects, setProjects] = useState([]);
  const [projectQuery, setProjectQuery] = useState('');
  const [selectedKey, setSelectedKey] = useState(null);     // company_name
  const [projectData, setProjectData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [expandedStages, setExpandedStages] = useState({ 1: true, 2: true, 3: true });

  // Update modal
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateRow, setUpdateRow] = useState(null);  // checkpoint object
  const [updateStatus, setUpdateStatus] = useState('yes');
  const [updateObsDate, setUpdateObsDate] = useState(todayISO());
  const [updateRemarks, setUpdateRemarks] = useState('');
  const [updatePhoto, setUpdatePhoto] = useState(null);
  const [saving, setSaving] = useState(false);

  // History drawer
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyRow, setHistoryRow] = useState(null);
  const [historyEntries, setHistoryEntries] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  // Admin checkpoint drawer
  const [manageOpen, setManageOpen] = useState(false);
  const [checkpointsAdmin, setCheckpointsAdmin] = useState([]);
  const [cpDraft, setCpDraft] = useState({ stage_no: 1, sort_order: 100, label: '', description: '' });

  // ── Fetch projects on mount ────────────────────────────────────
  useEffect(() => {
    api.get('/crm-kitting/projects')
      .then(r => setProjects(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load projects'));
  }, []);

  // ── Fetch project data when selected ───────────────────────────
  const loadProject = (key) => {
    if (!key) return;
    setLoading(true);
    api.get('/crm-kitting/project', { params: { key } })
      .then(r => setProjectData(r.data))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load project'))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    if (selectedKey) loadProject(selectedKey);
    else setProjectData(null);
  }, [selectedKey]);

  // ── Project search filter ──────────────────────────────────────
  const filteredProjects = useMemo(() => {
    const q = projectQuery.trim().toLowerCase();
    if (!q) return projects.slice(0, 50);
    return projects.filter(p =>
      (p.project_name || '').toLowerCase().includes(q) ||
      (p.client_name || '').toLowerCase().includes(q) ||
      (p.lead_no || '').toLowerCase().includes(q) ||
      (p.crm_person || '').toLowerCase().includes(q)
    ).slice(0, 50);
  }, [projects, projectQuery]);

  // ── Checkpoints grouped by stage ───────────────────────────────
  const byStage = useMemo(() => {
    const map = { 1: [], 2: [], 3: [] };
    (projectData?.checkpoints || []).forEach(cp => {
      if (map[cp.stage_no]) map[cp.stage_no].push(cp);
    });
    return map;
  }, [projectData]);

  // ── Open update modal ──────────────────────────────────────────
  const openUpdate = (cp, presetStatus) => {
    setUpdateRow(cp);
    setUpdateStatus(presetStatus || cp.latest?.status || 'yes');
    setUpdateObsDate(todayISO());
    setUpdateRemarks('');
    setUpdatePhoto(null);
    setUpdateOpen(true);
  };

  // ── Save entry ─────────────────────────────────────────────────
  const saveEntry = async () => {
    if (!updateRow || !selectedKey) return;
    if (updateObsDate > todayISO()) {
      toast.error('Observation date cannot be in the future');
      return;
    }
    if (updateObsDate < minObsISO()) {
      toast.error('Observation date cannot be more than 5 days in the past');
      return;
    }
    setSaving(true);
    try {
      const fd = new FormData();
      fd.append('project_key', selectedKey);
      fd.append('checkpoint_id', updateRow.id);
      fd.append('status', updateStatus);
      fd.append('observation_date', updateObsDate);
      if (updateRemarks) fd.append('remarks', updateRemarks);
      if (updatePhoto) fd.append('photo', updatePhoto);
      await api.post('/crm-kitting/entry', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('Saved');
      setUpdateOpen(false);
      loadProject(selectedKey);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  // ── History drawer ─────────────────────────────────────────────
  const openHistory = (cp) => {
    setHistoryRow(cp);
    setHistoryEntries([]);
    setHistoryOpen(true);
    setHistoryLoading(true);
    api.get('/crm-kitting/history', { params: { key: selectedKey, cp: cp.id } })
      .then(r => setHistoryEntries(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load history'))
      .finally(() => setHistoryLoading(false));
  };

  // ── Manage checkpoints (admin) ─────────────────────────────────
  const loadCheckpointsAdmin = () => {
    api.get('/crm-kitting/checkpoints')
      .then(r => setCheckpointsAdmin(r.data || []))
      .catch(e => toast.error(e.response?.data?.error || 'Failed to load checkpoints'));
  };
  const openManage = () => { loadCheckpointsAdmin(); setManageOpen(true); };

  const addCheckpoint = async () => {
    if (!cpDraft.label.trim()) return toast.error('Label required');
    try {
      await api.post('/crm-kitting/checkpoints', cpDraft);
      toast.success('Checkpoint added');
      setCpDraft({ stage_no: cpDraft.stage_no, sort_order: 100, label: '', description: '' });
      loadCheckpointsAdmin();
      if (selectedKey) loadProject(selectedKey);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to add');
    }
  };

  const updateCheckpoint = async (id, patch) => {
    try {
      await api.put(`/crm-kitting/checkpoints/${id}`, patch);
      toast.success('Updated');
      loadCheckpointsAdmin();
      if (selectedKey) loadProject(selectedKey);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to update');
    }
  };

  const deleteCheckpoint = async (id) => {
    if (!window.confirm('Disable this checkpoint? Existing history is preserved.')) return;
    try {
      await api.delete(`/crm-kitting/checkpoints/${id}`);
      toast.success('Disabled');
      loadCheckpointsAdmin();
      if (selectedKey) loadProject(selectedKey);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to delete');
    }
  };

  // ── Render ─────────────────────────────────────────────────────
  return (
    <div className="p-3 sm:p-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="bg-gradient-to-br from-blue-900 to-blue-950 text-white rounded-xl p-4 sm:p-6 mb-4 shadow-lg">
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold flex items-center gap-2">
              <FiPackage /> CRM Full Kitting
            </h1>
            <p className="text-blue-200 text-sm mt-1">
              3-stage project kitting tracker · Yes / No / Partially / N/A per checkpoint · photo + history retained
            </p>
          </div>
          {isAdmin && isAdmin() && (
            <button
              onClick={openManage}
              className="px-3 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-sm flex items-center gap-1.5"
            >
              <FiSettings /> Manage Checkpoints
            </button>
          )}
        </div>
      </div>

      {/* Project picker */}
      <div className="bg-white border rounded-xl p-3 sm:p-4 mb-4 shadow-sm">
        <label className="text-xs font-semibold text-gray-600 uppercase tracking-wide">Select Project</label>
        <div className="mt-2 relative">
          <FiSearch className="absolute left-3 top-3 text-gray-400" />
          <input
            value={projectQuery}
            onChange={e => setProjectQuery(e.target.value)}
            placeholder="Search by company, project name, or lead number…"
            className="w-full pl-9 pr-3 py-2 border rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
          />
        </div>
        {projectQuery && (
          <div className="mt-2 max-h-80 overflow-y-auto border rounded-lg divide-y">
            {filteredProjects.length === 0 ? (
              <div className="p-3 text-sm text-gray-500">No matching projects.</div>
            ) : filteredProjects.map(p => (
              <button
                key={p.project_key}
                onClick={() => { setSelectedKey(p.project_key); setProjectQuery(''); }}
                className="w-full text-left p-3 hover:bg-blue-50 transition"
              >
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <div className="font-medium text-gray-900 flex-1 min-w-0 truncate">
                    {p.project_name || '(unnamed project)'}
                  </div>
                  {p.bb_entry_count > 1 && (
                    <span className="text-[10px] font-medium text-amber-700 bg-amber-100 border border-amber-200 px-1.5 py-0.5 rounded">
                      {p.bb_entry_count} BB rows
                    </span>
                  )}
                  {p.sale_amount_without_gst > 0 && (
                    <span className="text-xs font-semibold text-emerald-700">
                      {fmtINRShort(p.sale_amount_without_gst)}
                    </span>
                  )}
                </div>
                <div className="text-xs text-gray-600 mt-0.5 flex items-center gap-2 flex-wrap">
                  {p.lead_no && <span className="font-mono">{p.lead_no}</span>}
                  {p.client_name && p.client_name !== p.project_name && <span>· {p.client_name}</span>}
                  {p.crm_person && <span>· CRM: {p.crm_person}</span>}
                  {p.state && <span>· {p.state}</span>}
                </div>
              </button>
            ))}
          </div>
        )}
        {projectData?.project && (
          <div className="mt-3 flex items-center justify-between bg-blue-50 border border-blue-200 rounded-lg p-3 flex-wrap gap-2">
            <div className="min-w-0">
              <div className="font-semibold text-blue-900 truncate">
                {projectData.project.project_name}
              </div>
              <div className="text-xs text-blue-700 flex items-center gap-2 flex-wrap">
                {projectData.project.lead_no && <span className="font-mono">{projectData.project.lead_no}</span>}
                {projectData.project.client_name && projectData.project.client_name !== projectData.project.project_name && (
                  <span>· {projectData.project.client_name}</span>
                )}
                {projectData.project.crm_person && <span>· CRM: {projectData.project.crm_person}</span>}
                {projectData.project.state && <span>· {projectData.project.state}</span>}
                {projectData.project.bb_entry_count > 1 && (
                  <span className="text-amber-700 font-medium">· rolls up {projectData.project.bb_entry_count} BB rows</span>
                )}
                {projectData.project.sale_amount_without_gst > 0 && (
                  <span>· Sale: <span className="font-semibold">{fmtINRShort(projectData.project.sale_amount_without_gst)}</span></span>
                )}
              </div>
            </div>
            <button
              onClick={() => setSelectedKey(null)}
              className="text-sm text-blue-700 hover:underline"
            >
              Change project
            </button>
          </div>
        )}
      </div>

      {loading && (
        <div className="text-center py-10 text-gray-500">Loading checkpoints…</div>
      )}

      {/* Stage cards */}
      {!loading && projectData && (
        <div className="space-y-4">
          {/* Stage summary strip */}
          <div className="grid grid-cols-3 gap-2 sm:gap-3">
            {[1, 2, 3].map(sn => {
              const s = projectData.summary[sn] || { total: 0, yes: 0, no: 0, partially: 0, na: 0, pending: 0 };
              const pct = s.total ? Math.round(((s.yes + s.na) / s.total) * 100) : 0;
              return (
                <div key={sn} className={`bg-gradient-to-br ${STAGE_META[sn].accent} text-white rounded-xl p-3 shadow`}>
                  <div className="text-xs uppercase opacity-80">Stage {sn}</div>
                  <div className="text-2xl font-bold leading-tight">{pct}%</div>
                  <div className="text-xs opacity-90 mt-1">
                    {s.yes + s.na}/{s.total} clear · {s.pending} pending
                  </div>
                </div>
              );
            })}
          </div>

          {[1, 2, 3].map(sn => (
            <div key={sn} className="bg-white border rounded-xl shadow-sm overflow-hidden">
              <button
                onClick={() => setExpandedStages(es => ({ ...es, [sn]: !es[sn] }))}
                className={`w-full bg-gradient-to-r ${STAGE_META[sn].accent} text-white px-4 py-3 flex items-center justify-between`}
              >
                <div className="flex items-center gap-2 font-semibold">
                  {STAGE_META[sn].title}
                  <span className="text-xs bg-white/20 px-2 py-0.5 rounded-full">
                    {byStage[sn].length} checkpoints
                  </span>
                </div>
                {expandedStages[sn] ? <FiChevronUp /> : <FiChevronDown />}
              </button>
              {expandedStages[sn] && (
                <div className="divide-y">
                  {byStage[sn].length === 0 ? (
                    <div className="p-4 text-sm text-gray-500">No checkpoints in this stage.</div>
                  ) : byStage[sn].map(cp => {
                    const meta = cp.latest ? STATUS_META[cp.latest.status] : null;
                    return (
                      <div key={cp.id} className="p-3 sm:p-4 flex flex-col sm:flex-row gap-3 hover:bg-gray-50 transition">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-start gap-2 flex-wrap">
                            <div className="font-medium text-gray-900">{cp.label}</div>
                            {meta && (
                              <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${meta.chip}`}>
                                <meta.icon size={12} /> {meta.label}
                              </span>
                            )}
                            {!cp.latest && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border bg-gray-100 text-gray-600 border-gray-200">
                                Pending
                              </span>
                            )}
                          </div>
                          {cp.description && (
                            <div className="text-xs text-gray-500 mt-0.5">{cp.description}</div>
                          )}
                          {cp.latest && (
                            <div className="text-xs text-gray-600 mt-1 flex items-center gap-3 flex-wrap">
                              <span className="inline-flex items-center gap-1"><FiCalendar size={11} /> Observed: {fmtD(cp.latest.observation_date)}</span>
                              <span className="inline-flex items-center gap-1"><FiClock size={11} /> Uploaded: {fmtDt(cp.latest.uploaded_at)}</span>
                              {cp.latest.uploaded_by_name && (
                                <span className="inline-flex items-center gap-1"><FiUser size={11} /> {cp.latest.uploaded_by_name}</span>
                              )}
                            </div>
                          )}
                          {cp.latest?.remarks && (
                            <div className="text-xs italic text-gray-600 mt-1">"{cp.latest.remarks}"</div>
                          )}
                        </div>
                        <div className="flex sm:flex-col items-center sm:items-end gap-2">
                          {cp.latest?.photo_path ? (
                            <a href={cp.latest.photo_path} target="_blank" rel="noreferrer" title="Open latest photo">
                              <img
                                src={cp.latest.photo_path}
                                alt="latest"
                                className="w-16 h-16 object-cover rounded-lg border shadow-sm"
                              />
                            </a>
                          ) : (
                            <div className="w-16 h-16 bg-gray-100 border rounded-lg flex items-center justify-center text-gray-400">
                              <FiCamera />
                            </div>
                          )}
                          <div className="flex gap-1.5">
                            <button
                              onClick={() => openUpdate(cp)}
                              className="px-2.5 py-1.5 text-xs bg-blue-700 hover:bg-blue-800 text-white rounded-lg"
                            >
                              Update
                            </button>
                            {cp.latest?.history_count > 0 && (
                              <button
                                onClick={() => openHistory(cp)}
                                className="px-2.5 py-1.5 text-xs bg-white border border-blue-200 text-blue-700 hover:bg-blue-50 rounded-lg"
                              >
                                History ({cp.latest.history_count})
                              </button>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Update modal */}
      <Modal isOpen={updateOpen} onClose={() => setUpdateOpen(false)} title={updateRow ? `Update: ${updateRow.label}` : 'Update'}>
        {updateRow && (
          <div className="space-y-3">
            <div>
              <label className="text-xs font-semibold text-gray-700">Status</label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-1">
                {Object.keys(STATUS_META).map(k => {
                  const m = STATUS_META[k];
                  const active = updateStatus === k;
                  return (
                    <button
                      key={k}
                      onClick={() => setUpdateStatus(k)}
                      className={`px-2 py-2 rounded-lg border text-sm flex items-center justify-center gap-1.5 transition ${
                        active ? `${m.chip} border-current font-semibold shadow-sm` : 'border-gray-300 hover:bg-gray-50'
                      }`}
                    >
                      <m.icon size={14} /> {m.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-semibold text-gray-700">Observation date</label>
                <input
                  type="date"
                  value={updateObsDate}
                  onChange={e => setUpdateObsDate(e.target.value)}
                  min={minObsISO()}
                  max={todayISO()}
                  className="w-full mt-1 px-2 py-1.5 border rounded-lg"
                />
                <p className="text-[10px] text-gray-500 mt-0.5">Today or up to 5 days back</p>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-700">Photo</label>
                <input
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={e => setUpdatePhoto(e.target.files?.[0] || null)}
                  className="w-full mt-1 text-xs"
                />
                <p className="text-[10px] text-gray-500 mt-0.5">JPG / PNG · up to 10 MB</p>
              </div>
            </div>

            <div>
              <label className="text-xs font-semibold text-gray-700">Remarks (optional)</label>
              <textarea
                value={updateRemarks}
                onChange={e => setUpdateRemarks(e.target.value)}
                rows={2}
                className="w-full mt-1 px-2 py-1.5 border rounded-lg text-sm"
                placeholder="What was checked, who confirmed, blockers, etc."
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button
                onClick={() => setUpdateOpen(false)}
                className="px-3 py-2 text-sm rounded-lg border hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                onClick={saveEntry}
                disabled={saving}
                className="px-3 py-2 text-sm rounded-lg bg-blue-700 hover:bg-blue-800 text-white disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save entry'}
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* History drawer */}
      {historyOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setHistoryOpen(false)}>
          <div className="bg-white w-full sm:max-w-md h-full overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-900 to-blue-950 text-white p-4 flex items-center justify-between sticky top-0 z-10">
              <div>
                <div className="text-xs opacity-80">Checkpoint history</div>
                <div className="font-semibold">{historyRow?.label}</div>
              </div>
              <button onClick={() => setHistoryOpen(false)} className="p-1 hover:bg-white/10 rounded">
                <FiX size={20} />
              </button>
            </div>
            <div className="p-3 space-y-3">
              {historyLoading && <div className="text-sm text-gray-500">Loading…</div>}
              {!historyLoading && historyEntries.length === 0 && (
                <div className="text-sm text-gray-500">No entries yet.</div>
              )}
              {historyEntries.map(e => {
                const m = STATUS_META[e.status];
                return (
                  <div key={e.id} className="border rounded-lg p-2.5 bg-gray-50">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border ${m.chip}`}>
                        <m.icon size={12} /> {m.label}
                      </span>
                      <span className="text-[11px] text-gray-500">{fmtDt(e.uploaded_at)}</span>
                    </div>
                    <div className="text-xs text-gray-600 mt-1.5 flex items-center gap-3 flex-wrap">
                      <span className="inline-flex items-center gap-1"><FiCalendar size={11} /> {fmtD(e.observation_date)}</span>
                      {e.uploaded_by_name && (
                        <span className="inline-flex items-center gap-1"><FiUser size={11} /> {e.uploaded_by_name}</span>
                      )}
                    </div>
                    {e.remarks && <div className="text-xs italic text-gray-700 mt-1">"{e.remarks}"</div>}
                    {e.photo_path && (
                      <a href={e.photo_path} target="_blank" rel="noreferrer" className="block mt-2">
                        <img src={e.photo_path} alt="entry" className="w-full max-h-60 object-cover rounded border" />
                      </a>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Manage checkpoints drawer (admin) */}
      {manageOpen && (
        <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={() => setManageOpen(false)}>
          <div className="bg-white w-full sm:max-w-lg h-full overflow-y-auto shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-blue-900 to-blue-950 text-white p-4 flex items-center justify-between sticky top-0 z-10">
              <div className="font-semibold">Manage Checkpoints</div>
              <button onClick={() => setManageOpen(false)} className="p-1 hover:bg-white/10 rounded">
                <FiX size={20} />
              </button>
            </div>
            <div className="p-3 space-y-3">
              {/* Add form */}
              <div className="border rounded-lg p-3 bg-blue-50/60">
                <div className="text-sm font-semibold text-blue-900 mb-2">Add checkpoint</div>
                <div className="grid grid-cols-3 gap-2">
                  <select
                    value={cpDraft.stage_no}
                    onChange={e => setCpDraft(d => ({ ...d, stage_no: Number(e.target.value) }))}
                    className="px-2 py-1.5 border rounded text-sm"
                  >
                    <option value={1}>Stage 1</option>
                    <option value={2}>Stage 2</option>
                    <option value={3}>Stage 3</option>
                  </select>
                  <input
                    type="number"
                    value={cpDraft.sort_order}
                    onChange={e => setCpDraft(d => ({ ...d, sort_order: Number(e.target.value) }))}
                    placeholder="Sort"
                    className="px-2 py-1.5 border rounded text-sm"
                  />
                  <button
                    onClick={addCheckpoint}
                    className="px-2 py-1.5 bg-blue-700 hover:bg-blue-800 text-white rounded text-sm flex items-center justify-center gap-1"
                  >
                    <FiPlus size={14} /> Add
                  </button>
                </div>
                <input
                  value={cpDraft.label}
                  onChange={e => setCpDraft(d => ({ ...d, label: e.target.value }))}
                  placeholder="Label (e.g., 'Material received')"
                  className="w-full px-2 py-1.5 border rounded text-sm mt-2"
                />
                <input
                  value={cpDraft.description}
                  onChange={e => setCpDraft(d => ({ ...d, description: e.target.value }))}
                  placeholder="Description (optional)"
                  className="w-full px-2 py-1.5 border rounded text-sm mt-2"
                />
              </div>

              {/* Existing list grouped by stage */}
              {[1, 2, 3].map(sn => (
                <div key={sn} className="border rounded-lg overflow-hidden">
                  <div className={`bg-gradient-to-r ${STAGE_META[sn].accent} text-white px-3 py-2 text-sm font-semibold`}>
                    {STAGE_META[sn].title}
                  </div>
                  <div className="divide-y">
                    {checkpointsAdmin.filter(c => c.stage_no === sn).length === 0 ? (
                      <div className="p-3 text-xs text-gray-500">None.</div>
                    ) : checkpointsAdmin.filter(c => c.stage_no === sn).map(c => (
                      <EditableCheckpointRow
                        key={c.id}
                        row={c}
                        onSave={(patch) => updateCheckpoint(c.id, patch)}
                        onDelete={() => deleteCheckpoint(c.id)}
                      />
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Inline editor row for the admin drawer ──────────────────────
function EditableCheckpointRow({ row, onSave, onDelete }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState({
    label: row.label,
    description: row.description || '',
    sort_order: row.sort_order,
    stage_no: row.stage_no,
  });
  useEffect(() => setDraft({
    label: row.label, description: row.description || '',
    sort_order: row.sort_order, stage_no: row.stage_no,
  }), [row]);

  if (!editing) {
    return (
      <div className="p-2.5 flex items-start justify-between gap-2 hover:bg-gray-50">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-900">
            <span className="text-[10px] font-mono bg-gray-100 px-1 rounded mr-1">#{row.sort_order}</span>
            {row.label}
          </div>
          {row.description && <div className="text-xs text-gray-500">{row.description}</div>}
        </div>
        <div className="flex gap-1">
          <button onClick={() => setEditing(true)} className="p-1.5 hover:bg-blue-100 text-blue-700 rounded" title="Edit">
            <FiEdit2 size={14} />
          </button>
          <button onClick={onDelete} className="p-1.5 hover:bg-rose-100 text-rose-700 rounded" title="Disable">
            <FiTrash2 size={14} />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="p-2.5 bg-blue-50/40 space-y-2">
      <div className="grid grid-cols-3 gap-2">
        <select
          value={draft.stage_no}
          onChange={e => setDraft(d => ({ ...d, stage_no: Number(e.target.value) }))}
          className="px-2 py-1 border rounded text-xs"
        >
          <option value={1}>Stage 1</option>
          <option value={2}>Stage 2</option>
          <option value={3}>Stage 3</option>
        </select>
        <input
          type="number"
          value={draft.sort_order}
          onChange={e => setDraft(d => ({ ...d, sort_order: Number(e.target.value) }))}
          className="px-2 py-1 border rounded text-xs"
        />
        <div className="flex gap-1">
          <button
            onClick={() => { onSave(draft); setEditing(false); }}
            className="flex-1 px-2 py-1 text-xs bg-blue-700 hover:bg-blue-800 text-white rounded"
          >
            Save
          </button>
          <button
            onClick={() => setEditing(false)}
            className="flex-1 px-2 py-1 text-xs border rounded hover:bg-gray-100"
          >
            Cancel
          </button>
        </div>
      </div>
      <input
        value={draft.label}
        onChange={e => setDraft(d => ({ ...d, label: e.target.value }))}
        className="w-full px-2 py-1 border rounded text-sm"
      />
      <input
        value={draft.description}
        onChange={e => setDraft(d => ({ ...d, description: e.target.value }))}
        placeholder="Description (optional)"
        className="w-full px-2 py-1 border rounded text-xs"
      />
    </div>
  );
}
