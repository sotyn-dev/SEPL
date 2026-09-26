// One drawing — its identity, its full revision timeline, and every revision
// still openable no matter how many newer ones exist.
//
// Two things this page must never do:
//   - open the latest revision when the user asked for an older one
//   - let someone read a superseded revision without knowing it is superseded
import { useState, useEffect, useCallback } from 'react';
import { useParams, Link } from 'react-router-dom';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import {
  FiArrowLeft, FiUpload, FiEye, FiDownload, FiColumns, FiX, FiSlash, FiExternalLink, FiEdit2,
  FiCheckCircle, FiClock, FiAlertTriangle, FiSend, FiPrinter, FiUserCheck, FiFileText, FiCheck, FiBell, FiShield,
  FiUsers,
} from 'react-icons/fi';
// The viewer and the upload modal are shared with the Revision Matrix, so
// the superseded warning and the upload rules live in exactly one place.
import {
  RevisionViewer, UploadRevisionModal, useRevisionBlob, REV_CLS, isPdf, isDwg, getRevExtension,
  fmtDrawingDate as fmtDate,
} from '../components/DrawingRevisionModals';
import { EditDrawingModal } from './DrawingTracker';
import DrawingRaciModal from '../components/DrawingRaciModal';

const fmtSize = (n) => {
  const b = Number(n || 0);
  if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
  if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
  return b + ' B';
};

export default function DrawingDetail() {
  const { id } = useParams();
  const { canCreate, canEdit, canDelete } = useAuth();
  const [data, setData] = useState(null);
  const [opts, setOpts] = useState(null);
  const [viewing, setViewing] = useState(null);   // revision being viewed
  const [uploadOpen, setUploadOpen] = useState(false);
  const [compareOpen, setCompareOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [editRev, setEditRev] = useState(null);

  // SOP-06 Workflow Modals
  const [reviewModalOpen, setReviewModalOpen] = useState(false);
  const [submitModalOpen, setSubmitModalOpen] = useState(false);
  const [reminderModalOpen, setReminderModalOpen] = useState(false);
  const [releaseModalOpen, setReleaseModalOpen] = useState(false);
  const [viewReleaseNoteOpen, setViewReleaseNoteOpen] = useState(false);
  const [raciOpen, setRaciOpen] = useState(false);
  const [raci, setRaci] = useState(null);

  const load = useCallback(() => {
    api.get(`/drawing-tracker/drawings/${id}`)
      .then(r => setData(r.data)).catch(() => toast.error('Could not load drawing'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/drawing-tracker/options').then(r => {
      setOpts(r.data);
      if (r.data?.raci) setRaci(r.data.raci);
    }).catch(() => {});
  }, []);
  const loadRaci = useCallback(() => {
    api.get('/drawing-tracker/raci').then(r => setRaci(r.data.raci)).catch(() => {});
  }, []);
  useEffect(() => { loadRaci(); }, [loadRaci]);

  if (!data) return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  const current = data.revisions.find(r => r.status === 'current');

  const SOP_STEPS = [
    { key: 's1', label: 'S1 · Register', role: 'ERP', who: '—', desc: 'Drawing list & target date' },
    { key: 's2', label: 'S2 · Drafting', role: 'Design Engg', who: raci?.s1_s2_drafting?.assigned_name || 'MD Asad', desc: 'CAD / Vendor intake' },
    { key: 's3', label: 'S3 · Pre-Check', role: 'Senior Engg', who: raci?.s3_senior_check?.assigned_name || 'Ambuj', desc: '4-hr in-house check' },
    { key: 's4', label: 'S4 · Submission', role: 'Coordinator', who: raci?.s4_client_submit?.assigned_name || 'Lovely', desc: 'Client sent & clock starts' },
    { key: 's5', label: 'S5 · SLA Clock', role: 'Management', who: raci?.s5_escalation_80?.assigned_name || 'Rajat sir', desc: '50% & 80% escalation' },
    { key: 's6', label: 'S6 · Site Release', role: 'Senior Engg', who: raci?.s6_site_release?.assigned_name || 'Ambuj', desc: 'GFC Release Note & checklist' },
  ];

  const getStepIndex = () => {
    if (data.sop_stage === 's6_approved_site' || data.site_release_status === 'released') return 5;
    if (data.sop_stage === 's5_under_review' || data.client_submitted_at) return 4;
    if (data.sop_stage === 's4_client_submitted' || data.internal_review_status === 'approved') return 3;
    if (data.sop_stage === 's3_internal_check' || (data.revisions && data.revisions.length > 0)) return 2;
    if (data.sop_stage === 's2_drafting') return 1;
    return 0;
  };
  const stepIdx = getStepIndex();

  const computeSla = () => {
    if (!data.client_submitted_at || !data.client_expected_date) return null;
    const start = new Date(data.client_submitted_at).getTime();
    const end = new Date(data.client_expected_date).getTime();
    const now = Date.now();
    const totalDays = Math.max(1, Math.round((end - start) / (1000 * 60 * 60 * 24)));
    const elapsedDays = Math.max(0, Math.round((now - start) / (1000 * 60 * 60 * 24)));
    const remainingDays = Math.round((end - now) / (1000 * 60 * 60 * 24));
    const percent = Math.min(100, Math.max(0, Math.round((elapsedDays / totalDays) * 100)));
    return {
      totalDays, elapsedDays, remainingDays, percent,
      is50: percent >= 50, is80: percent >= 80, isOverdue: remainingDays < 0,
    };
  };
  const sla = computeSla();

  const download = async (rev) => {
    try {
      const r = await api.get(`/drawing-tracker/revisions/${rev.id}/file?download=1`, { responseType: 'blob' });
      const ext = getRevExtension(rev);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = `${data.drawing_number}_Rev${rev.revision_no}${ext}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { toast.error('Download failed'); }
  };

  const downloadBoq = async () => {
    try {
      const r = await api.get(`/drawing-tracker/drawings/${data.id}/boq`, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = data.boq_file_name || `${data.drawing_number}_BOQ.xlsx`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch { toast.error('BOQ download failed'); }
  };

  const cancelRev = async (rev) => {
    const reason = window.prompt(`Cancel Rev ${rev.revision_no}? This keeps the file and the record — it only marks it cancelled.\n\nReason:`);
    if (!reason) return;
    try {
      await api.post(`/drawing-tracker/revisions/${rev.id}/cancel`, { reason });
      toast.success(`Rev ${rev.revision_no} cancelled`); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not cancel'); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <Link to="/drawing-tracker" className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-1">
            <FiArrowLeft size={12} /> Drawing Tracker
          </Link>
          <h1 className="text-2xl font-semibold font-mono text-red-600">{data.drawing_number}</h1>
          <p className="text-sm text-gray-600">{data.title || '—'}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => setRaciOpen(true)} className="btn btn-secondary text-sm flex items-center gap-1.5" title="View or Configure SOP-06 Roles & Delegation">
            <FiUsers size={14} className="text-slate-600" /> Roles (RACI)
          </button>
          {canEdit('drawing_tracker') && (
            <button onClick={() => setEditOpen(true)} className="btn btn-secondary text-sm flex items-center gap-1">
              <FiEdit2 size={14} /> Edit Drawing
            </button>
          )}
          {data.revisions.length > 1 && (
            <button onClick={() => setCompareOpen(true)} className="btn btn-secondary text-sm flex items-center gap-1">
              <FiColumns size={14} /> Compare
            </button>
          )}
          {canCreate('drawing_tracker') && (
            <button onClick={() => setUploadOpen(true)} className="btn btn-primary text-sm flex items-center gap-1">
              <FiUpload size={14} /> Upload New Revision
            </button>
          )}
        </div>
      </div>

      {/* ─── SOP-06 DRAWING APPROVAL WORKFLOW BANNER ────────────────────── */}
      <div className="card p-4 bg-slate-900 text-white rounded-xl shadow-md space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <span className="bg-red-600 text-white text-[11px] font-bold px-2 py-0.5 rounded tracking-wide uppercase">
              SOP-06 Flow
            </span>
            <span className="font-semibold text-sm text-slate-100">Drawing Approval Pipeline</span>
            <span className="text-xs text-slate-400 hidden sm:inline">
              · Owner: Design Head ({[raci?.s1_s2_drafting?.assigned_name, raci?.s3_senior_check?.assigned_name, raci?.s4_client_submit?.assigned_name, raci?.s5_escalation_80?.assigned_name].filter(Boolean).join(' · ') || 'Asad · Ambuj · Lovely · Rajat sir'})
            </span>
          </div>
          <div className="flex items-center gap-2">
            {data.target_date && (
              <span className="text-xs text-slate-300 flex items-center gap-1 bg-slate-800 px-2.5 py-1 rounded-md border border-slate-700">
                <FiClock className="text-amber-400" /> Needed by: <strong className="text-amber-300">{fmtDate(data.target_date)}</strong>
              </span>
            )}
            <span className={`text-xs px-2.5 py-1 rounded-md font-bold uppercase ${
              stepIdx === 5 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' :
              stepIdx === 4 ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40' :
              stepIdx === 3 ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40' :
              stepIdx === 2 ? 'bg-amber-500/20 text-amber-300 border border-amber-500/40' :
              'bg-slate-700 text-slate-300'
            }`}>
              {SOP_STEPS[stepIdx].label}
            </span>
          </div>
        </div>

        {/* 6-Step Stepper */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
          {SOP_STEPS.map((s, idx) => {
            const isDone = idx < stepIdx || (idx === 5 && stepIdx === 5);
            const isCurrent = idx === stepIdx && stepIdx !== 5;
            return (
              <div
                key={s.key}
                className={`p-2.5 rounded-lg border transition-all text-xs ${
                  isDone
                    ? 'bg-emerald-950/40 border-emerald-600/50 text-emerald-200'
                    : isCurrent
                    ? 'bg-amber-950/40 border-amber-500 ring-1 ring-amber-400/50 text-amber-100'
                    : 'bg-slate-800/60 border-slate-700/60 text-slate-400'
                }`}
              >
                <div className="flex items-center justify-between text-[10px] font-bold uppercase mb-1">
                  <span className={isDone ? 'text-emerald-400' : isCurrent ? 'text-amber-300 font-extrabold' : 'text-slate-400'}>
                    {s.label}
                  </span>
                  {isDone ? (
                    <FiCheckCircle className="text-emerald-400 text-xs shrink-0" />
                  ) : isCurrent ? (
                    <span className="w-2 h-2 rounded-full bg-amber-400 animate-pulse" />
                  ) : (
                    <span className="w-2 h-2 rounded-full bg-slate-600" />
                  )}
                </div>
                <div className="text-[11px] font-medium text-slate-200">{s.desc}</div>
                <div className="text-[10px] text-slate-400 mt-1 flex items-center justify-between">
                  <span>{s.role}</span>
                  <span className="font-semibold text-slate-300">{s.who}</span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Active Stage Action Area */}
        <div className="pt-2 border-t border-slate-800">
          {/* S3: Senior Pre-Check Active */}
          {stepIdx === 2 && (
            <div className="bg-amber-950/60 border border-amber-500/60 rounded-lg p-3.5 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-start gap-2.5">
                <FiShield className="text-amber-400 mt-0.5 text-lg shrink-0" />
                <div>
                  <div className="font-semibold text-amber-200 text-sm">
                    SOP-06.3 · In-House Senior Review Required (Senior Engineer: {raci?.s3_senior_check?.assigned_name || 'Ambuj'})
                  </div>
                  <div className="text-xs text-amber-300/80 mt-0.5">
                    Rev {current?.revision_no ?? 0} uploaded by {current?.uploaded_by_name || raci?.s1_s2_drafting?.assigned_name || 'MD Asad'}. 4-hour SLA active. Must catch all mistakes in-house before sending to client.
                  </div>
                  {data.internal_review_status === 'rejected' && (
                    <div className="text-xs text-red-300 font-semibold mt-1">
                      ⚠️ Previous review returned for corrections: {data.internal_review_notes}
                    </div>
                  )}
                </div>
              </div>
              <button
                onClick={() => setReviewModalOpen(true)}
                className="btn btn-warning text-xs font-bold px-4 py-2 flex items-center gap-1.5 shadow-md"
              >
                <FiUserCheck size={14} /> Conduct Senior Pre-Check ({raci?.s3_senior_check?.assigned_name || 'Ambuj'})
              </button>
            </div>
          )}

          {/* S4: Client Submission Ready */}
          {stepIdx === 3 && (
            <div className="bg-blue-950/60 border border-blue-500/60 rounded-lg p-3.5 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-start gap-2.5">
                <FiSend className="text-blue-400 mt-0.5 text-lg shrink-0" />
                <div>
                  <div className="font-semibold text-blue-200 text-sm">
                    SOP-06.4 · Ready for Client Submission (Coordinator: {raci?.s4_client_submit?.assigned_name || 'Lovely'})
                  </div>
                  <div className="text-xs text-blue-300/80 mt-0.5">
                    Pre-check passed by {data.internal_reviewed_by_name || raci?.s3_senior_check?.assigned_name || 'Ambuj'}. Transmit drawing to client to start the turnaround clock.
                  </div>
                </div>
              </div>
              <button
                onClick={() => setSubmitModalOpen(true)}
                className="btn btn-primary text-xs font-bold px-4 py-2 flex items-center gap-1.5 shadow-md"
              >
                <FiSend size={14} /> Submit Drawing to Client ({raci?.s4_client_submit?.assigned_name || 'Lovely'})
              </button>
            </div>
          )}

          {/* S5: Client Review with SLA Clock */}
          {stepIdx === 4 && (
            <div className="bg-purple-950/60 border border-purple-500/60 rounded-lg p-3.5 space-y-3">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <FiClock className="text-purple-400 text-lg" />
                  <span className="font-semibold text-purple-200 text-sm">
                    SOP-06.5 · Under Client Review &amp; SLA Tracking (Escalation: {raci?.s5_escalation_80?.assigned_name || 'Rajat sir'})
                  </span>
                  <span className="bg-purple-900/80 text-purple-200 text-xs px-2 py-0.5 rounded border border-purple-700">
                    Ref: {data.submission_ref_no || 'Client Transmittal'}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-xs">
                  <span className="text-slate-300">Submitted: {fmtDate(data.client_submitted_at)}</span>
                  <span className="text-purple-300 font-bold">Due: {fmtDate(data.client_expected_date)}</span>
                </div>
              </div>

              {/* SLA Progress Bar */}
              {sla && (
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-slate-300">
                    <span>Approval SLA: <strong>{sla.elapsedDays} / {sla.totalDays} days</strong> elapsed ({sla.percent}%)</span>
                    <span className={sla.isOverdue ? 'text-red-400 font-bold animate-pulse' : 'text-emerald-400 font-bold'}>
                      {sla.isOverdue ? `${Math.abs(sla.remainingDays)} DAYS OVERDUE` : `${sla.remainingDays} days remaining`}
                    </span>
                  </div>
                  <div className="w-full bg-slate-800 rounded-full h-2.5 overflow-hidden relative">
                    <div
                      className={`h-full transition-all duration-500 ${
                        sla.isOverdue ? 'bg-red-500' : sla.is80 ? 'bg-amber-500' : 'bg-purple-500'
                      }`}
                      style={{ width: `${sla.percent}%` }}
                    />
                    <div className="absolute top-0 bottom-0 left-[50%] w-0.5 bg-yellow-400/80" title="50% Reminder" />
                    <div className="absolute top-0 bottom-0 left-[80%] w-0.5 bg-red-400/80" title="80% Urgent Escalation" />
                  </div>
                  <div className="flex justify-between text-[10px] text-slate-400 pt-0.5">
                    <span>Submitted</span>
                    <span className="text-yellow-400">50% Milestone (PM)</span>
                    <span className="text-red-400">80% Urgent (Rajat sir)</span>
                    <span>Due Date</span>
                  </div>
                </div>
              )}

              <div className="flex items-center justify-between pt-1 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => setReminderModalOpen(true)}
                    className="btn btn-secondary text-xs bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-700 flex items-center gap-1.5"
                  >
                    <FiBell size={13} className="text-yellow-400" /> Milestone Reminder / Escalation
                  </button>
                  {data.reminder_escalation_status && (
                    <span className="text-[11px] text-purple-300 italic">
                      Last: {data.reminder_escalation_status}
                    </span>
                  )}
                </div>
                <button
                  onClick={() => setReleaseModalOpen(true)}
                  className="btn btn-success text-xs font-bold px-4 py-2 flex items-center gap-1.5 shadow-md"
                >
                  <FiCheckCircle size={14} /> Client Approved → Release to Site (SOP-06.6)
                </button>
              </div>
            </div>
          )}

          {/* S6: Released to Site */}
          {stepIdx === 5 && (
            <div className="bg-emerald-950/60 border border-emerald-500/60 rounded-lg p-3.5 flex items-center justify-between flex-wrap gap-3">
              <div className="flex items-start gap-2.5">
                <FiCheckCircle className="text-emerald-400 mt-0.5 text-xl shrink-0" />
                <div>
                  <div className="font-semibold text-emerald-200 text-sm flex items-center gap-2">
                    <span>SOP-06.6 · Approved &amp; Released to Site (Good For Construction)</span>
                    <span className="bg-emerald-500/20 text-emerald-300 text-xs px-2 py-0.5 rounded font-mono font-bold border border-emerald-500/40">
                      {data.release_note_no}
                    </span>
                  </div>
                  <div className="text-xs text-emerald-300/80 mt-0.5">
                    Released on {fmtDate(data.site_released_at)} by {data.site_released_by_name || raci?.s6_site_release?.assigned_name || 'Ambuj'}. Site ready-checklist ticked.
                  </div>
                </div>
              </div>
              <button
                onClick={() => setViewReleaseNoteOpen(true)}
                className="btn btn-success text-xs font-bold px-4 py-2 flex items-center gap-1.5 shadow-md bg-emerald-600 hover:bg-emerald-500 text-white border-0"
              >
                <FiPrinter size={14} /> View / Print Drawing Release Note (SOP-06.6)
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="card p-4 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <div><div className="text-xs text-gray-500">Project</div>{data.project_name || '—'}</div>
        <div><div className="text-xs text-gray-500">Site</div>{data.site_name || '—'}</div>
        <div><div className="text-xs text-gray-500">Discipline</div>{data.discipline || '—'}</div>
        <div><div className="text-xs text-gray-500">Drawing Type</div>{data.drawing_type || '—'}</div>
        <div>
          <div className="text-xs text-gray-500">BOQ Required</div>
          {data.boq_required ? (
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-semibold text-emerald-700">Yes</span>
              {data.boq_file_url ? (
                <button
                  type="button"
                  onClick={downloadBoq}
                  className="text-xs text-blue-600 hover:underline flex items-center gap-0.5">
                  <FiDownload size={11} /> {data.boq_file_name || 'Download BOQ'}
                </button>
              ) : (
                <span className="text-[11px] text-gray-400">(No file)</span>
              )}
            </div>
          ) : (
            <span className="text-gray-500">No</span>
          )}
        </div>
        <div><div className="text-xs text-gray-500">Current Revision</div>
          <span className="font-semibold text-emerald-700">Rev {current?.revision_no ?? '—'}</span>
        </div>
        <div><div className="text-xs text-gray-500">Total Versions</div>{data.revisions.length}</div>
        <div><div className="text-xs text-gray-500">Last Revised</div>{fmtDate(current?.uploaded_at)}</div>
        <div><div className="text-xs text-gray-500">By</div>{current?.uploaded_by_name || '—'}</div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Timeline */}
        <div className="card p-4">
          <h3 className="text-sm font-semibold mb-3">Revision Timeline</h3>
          <div className="space-y-0">
            {data.revisions.map((r, i) => (
              <div key={r.id} className="flex gap-3">
                <div className="flex flex-col items-center">
                  <div className={`w-3 h-3 rounded-full border-2 ${r.status === 'current' ? 'bg-emerald-500 border-emerald-500' : r.status === 'cancelled' ? 'bg-red-400 border-red-400' : 'bg-white border-gray-300'}`} />
                  {i < data.revisions.length - 1 && <div className="w-px flex-1 bg-gray-200 my-1" />}
                </div>
                <div className="pb-4 flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold text-sm">Rev {r.revision_no}</span>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${REV_CLS[r.status]}`}>
                      {r.status === 'current' ? 'CURRENT' : r.status.toUpperCase()}
                    </span>
                  </div>
                  <div className="text-xs text-gray-600 mt-0.5">{r.revision_description}</div>
                  <div className="text-[10px] text-gray-400 mt-0.5">
                    {fmtDate(r.revision_date || r.uploaded_at)} · {r.uploaded_by_name || '—'}
                    {r.revision_reason ? ` · ${r.revision_reason}` : ''}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* History table */}
        <div className="card p-0 overflow-x-auto">
          <h3 className="text-sm font-semibold px-4 pt-4">Revision History</h3>
          <table className="min-w-full mt-2 text-sm">
            <thead><tr className="bg-gray-50 text-xs text-gray-600">
              <th className="px-3 py-2 text-center">Rev</th>
              <th className="px-3 py-2 text-left">Date</th>
              <th className="px-3 py-2 text-left">Description</th>
              <th className="px-3 py-2 text-center">Status</th>
              <th className="px-3 py-2 text-left">By</th>
              <th className="px-3 py-2 text-center">Action</th>
            </tr></thead>
            <tbody className="divide-y divide-gray-100">
              {data.revisions.map(r => (
                <tr key={r.id} className={r.status === 'current' ? 'bg-emerald-50/40' : ''}>
                  <td className="px-3 py-2 text-center font-semibold">{r.revision_no}</td>
                  <td className="px-3 py-2 text-xs">{fmtDate(r.revision_date || r.uploaded_at)}</td>
                  <td className="px-3 py-2 text-xs">{r.revision_description}</td>
                  <td className="px-3 py-2 text-center">
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border ${REV_CLS[r.status]}`}>{r.status}</span>
                  </td>
                  <td className="px-3 py-2 text-xs">{r.uploaded_by_name || '—'}</td>
                  <td className="px-3 py-2">
                    <div className="flex items-center justify-center gap-2">
                      <button onClick={() => setViewing(r)} className="text-gray-400 hover:text-red-600" title={`View Rev ${r.revision_no}`}><FiEye size={13} /></button>
                      <a href={`/drawing-view/${r.id}`} target="_blank" rel="noreferrer"
                        className="text-gray-400 hover:text-red-600" title={`Open Rev ${r.revision_no} in a new tab`}><FiExternalLink size={13} /></a>
                      <button onClick={() => download(r)} className="text-gray-400 hover:text-blue-600" title={`Download Rev ${r.revision_no}`}><FiDownload size={13} /></button>
                      {canEdit('drawing_tracker') && (
                        <button onClick={() => setEditRev(r)} className="text-gray-400 hover:text-blue-600" title={`Edit details of Rev ${r.revision_no}`}><FiEdit2 size={13} /></button>
                      )}
                      {canDelete('drawing_tracker') && r.status === 'superseded' && (
                        <button onClick={() => cancelRev(r)} className="text-gray-400 hover:text-red-600" title="Cancel this revision"><FiSlash size={13} /></button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {viewing && (
        <RevisionViewer revision={viewing} drawingNumber={data.drawing_number} current={current}
          onClose={() => setViewing(null)} onViewLatest={() => setViewing(current)} />
      )}
      {uploadOpen && (
        <UploadRevisionModal drawingId={data.id} drawingNumber={data.drawing_number}
          revisions={data.revisions} onClose={() => setUploadOpen(false)}
          onSaved={() => { setUploadOpen(false); load(); }} />
      )}
      {editOpen && (
        <EditDrawingModal drawing={data} opts={opts} onClose={() => setEditOpen(false)} onSaved={() => { setEditOpen(false); load(); }} />
      )}
      {editRev && (
        <EditRevisionModal rev={editRev} onClose={() => setEditRev(null)} onSaved={() => { setEditRev(null); load(); }} />
      )}
      {compareOpen && <CompareModal drawing={data} onClose={() => setCompareOpen(false)} />}

      {/* SOP-06 Workflow Modals */}
      {raciOpen && (
        <DrawingRaciModal onClose={() => setRaciOpen(false)} onSaved={() => { load(); loadRaci(); }} />
      )}
      {reviewModalOpen && (
        <PreCheckModal drawing={data} currentRev={current} raci={raci} onClose={() => setReviewModalOpen(false)} onSaved={() => { setReviewModalOpen(false); load(); }} />
      )}
      {submitModalOpen && (
        <ClientSubmitModal drawing={data} raci={raci} onClose={() => setSubmitModalOpen(false)} onSaved={() => { setSubmitModalOpen(false); load(); }} />
      )}
      {reminderModalOpen && (
        <ReminderModal drawing={data} sla={sla} raci={raci} onClose={() => setReminderModalOpen(false)} onSaved={() => { setReminderModalOpen(false); load(); }} />
      )}
      {releaseModalOpen && (
        <ReleaseToSiteModal drawing={data} currentRev={current} raci={raci} onClose={() => setReleaseModalOpen(false)} onSaved={() => { setReleaseModalOpen(false); load(); }} />
      )}
      {viewReleaseNoteOpen && (
        <ViewReleaseNoteModal drawing={data} currentRev={current} raci={raci} onClose={() => setViewReleaseNoteOpen(false)} />
      )}
    </div>
  );
}

function EditRevisionModal({ rev, onClose, onSaved }) {
  const [form, setForm] = useState({
    revision_description: rev.revision_description || '',
    revision_reason: rev.revision_reason || '',
    revision_date: rev.revision_date ? rev.revision_date.slice(0, 10) : '',
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);

  const save = async (e) => {
    e.preventDefault();
    if (!form.revision_description.trim()) return toast.error('Revision description is required');
    setBusy(true);
    try {
      const fd = new FormData();
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      if (file) fd.append('file', file);
      await api.put(`/drawing-tracker/revisions/${rev.id}`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      toast.success(file ? `Rev ${rev.revision_no} file & details updated` : `Rev ${rev.revision_no} updated`);
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Update failed');
    } finally {
      setBusy(false);
    }
  };

  const downloadCurrentFile = async () => {
    try {
      const r = await api.get(`/drawing-tracker/revisions/${rev.id}/file?download=1`, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = rev.file_name || `Revision_${rev.revision_no}`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch {
      toast.error('Download failed');
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Edit Revision ${rev.revision_no}`}>
      <form onSubmit={save} className="space-y-3">
        {/* Current File Display */}
        <div className="text-xs bg-gray-50 p-2.5 rounded border border-gray-200 flex items-center justify-between">
          <div className="truncate mr-2">
            <span className="text-gray-500 mr-1.5">Current File:</span>
            <span className="font-mono font-medium text-gray-800 truncate">{rev.file_name || 'Attached Drawing File'}</span>
          </div>
          <button
            type="button"
            onClick={downloadCurrentFile}
            className="text-blue-600 hover:underline text-xs flex items-center gap-1 whitespace-nowrap ml-2">
            <FiDownload size={11} /> Download
          </button>
        </div>

        {/* Replace Drawing File Option */}
        <div>
          <label className="label">
            Replace Drawing File <span className="text-gray-400 font-normal">(optional — choose file if wrong design was uploaded)</span>
          </label>
          <input
            type="file"
            className="input text-xs"
            onChange={e => setFile(e.target.files?.[0] || null)}
          />
          {file && (
            <p className="text-[11px] text-amber-700 mt-1 font-semibold">
              ⚠️ Note: Uploading this file will replace the design file for Rev {rev.revision_no}.
            </p>
          )}
        </div>

        <div>
          <label className="label">Revision Date</label>
          <input type="date" className="input" value={form.revision_date}
            onChange={e => setForm(f => ({ ...f, revision_date: e.target.value }))} />
        </div>
        <div>
          <label className="label">Revision Description *</label>
          <textarea className="input" rows={3} value={form.revision_description}
            onChange={e => setForm(f => ({ ...f, revision_description: e.target.value }))} required />
        </div>
        <div>
          <label className="label">Revision Reason</label>
          <input className="input" value={form.revision_reason}
            onChange={e => setForm(f => ({ ...f, revision_reason: e.target.value }))} placeholder="e.g. Client Revision, Site Requirement" />
        </div>
        <div className="flex justify-end gap-2 pt-2 border-t">
          <button type="button" onClick={onClose} className="btn btn-secondary">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Saving…' : 'Save'}</button>
        </div>
      </form>
    </Modal>
  );
}


// ─── Compare two revisions side by side ────────────────────────────────
function CompareModal({ drawing, onClose }) {
  const revs = drawing.revisions;
  const [leftId, setLeftId] = useState(revs[1]?.id ?? revs[0]?.id);
  const [rightId, setRightId] = useState(revs[0]?.id);
  const left = revs.find(r => r.id === Number(leftId));
  const right = revs.find(r => r.id === Number(rightId));
  const lBlob = useRevisionBlob(leftId);
  const rBlob = useRevisionBlob(rightId);

  const Pane = ({ rev, blob, side }) => (
    <div className="flex-1 flex flex-col min-w-0 border rounded overflow-hidden">
      <div className="bg-gray-50 p-2 border-b">
        <select className="select text-sm w-full" value={rev?.id || ''}
          onChange={e => (side === 'l' ? setLeftId(e.target.value) : setRightId(e.target.value))}>
          {revs.map(r => <option key={r.id} value={r.id}>Rev {r.revision_no} — {r.status}</option>)}
        </select>
      </div>
      <div className="flex-1 bg-gray-100 min-h-[45vh] overflow-auto">
        {blob.err && <div className="p-6 text-center text-red-600 text-xs">{blob.err}</div>}
        {!blob.err && !blob.url && <div className="p-6 text-center text-gray-400 text-xs">Loading…</div>}
        {blob.url && isPdf(rev) && <iframe src={blob.url} title={`Rev ${rev.revision_no}`} className="w-full h-full min-h-[45vh] border-0" />}
        {blob.url && isDwg(rev) && (
          <div className="p-6 text-center space-y-3">
            <div className="text-xs font-semibold text-gray-700">{rev.file_name} (.DWG)</div>
            <p className="text-xs text-gray-500">AutoCAD DWG binary files cannot be rendered directly inside the comparison pane.</p>
            <div className="flex justify-center gap-2">
              <a href={blob.url} download={`${drawing.drawing_number}_Rev${rev.revision_no}${getRevExtension(rev)}`} className="btn btn-primary text-xs">Download DWG</a>
              <a href="https://viewer.autodesk.com" target="_blank" rel="noreferrer" className="btn btn-secondary text-xs">Autodesk Viewer</a>
            </div>
          </div>
        )}
        {blob.url && !isPdf(rev) && !isDwg(rev) && (
          <div className="p-6 text-center text-xs text-gray-600">
            {rev.file_name} can't be previewed in the browser — compare the details below, or download it.
            <div className="mt-2"><a href={blob.url} download={`${drawing.drawing_number}_Rev${rev.revision_no}${getRevExtension(rev)}`} className="btn btn-secondary text-xs">Download</a></div>
          </div>
        )}
      </div>
      <div className="p-2 text-[11px] space-y-0.5 border-t bg-white">
        <div><span className="text-gray-500">Description:</span> {rev?.revision_description || '—'}</div>
        <div><span className="text-gray-500">Reason:</span> {rev?.revision_reason || '—'}</div>
        <div><span className="text-gray-500">Date:</span> {fmtDate(rev?.revision_date || rev?.uploaded_at)}</div>
        <div><span className="text-gray-500">Uploaded by:</span> {rev?.uploaded_by_name || '—'}</div>
        <div><span className="text-gray-500">File:</span> {rev?.file_name} ({fmtSize(rev?.file_size)})</div>
      </div>
    </div>
  );

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex flex-col" onClick={onClose}>
      <div className="bg-white m-4 rounded-lg flex-1 flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b">
          <h3 className="font-semibold">Compare Revisions — <span className="font-mono text-red-600">{drawing.drawing_number}</span></h3>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><FiX size={20} /></button>
        </div>
        {/* Honest about what this can and can't tell you. */}
        <div className="px-3 py-2 text-[11px] text-gray-500 border-b bg-gray-50">
          Both revisions are shown as they were uploaded. This is a side-by-side view for your own
          eyes — the system does not detect or highlight the differences between them.
        </div>
        <div className="flex-1 flex gap-3 p-3 overflow-hidden flex-col md:flex-row">
          <Pane rev={left} blob={lBlob} side="l" />
          <Pane rev={right} blob={rBlob} side="r" />
        </div>
      </div>
    </div>
  );
}

// ─── SOP-06.3: Senior In-House Pre-Check Modal (Ambuj) ───────────────────
function PreCheckModal({ drawing, currentRev, raci, onClose, onSaved }) {
  const [checklist, setChecklist] = useState({
    chk_title_block: false,
    chk_dimensions: false,
    chk_specs: false,
    chk_scale: false,
    chk_clash: false,
  });
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const toggle = (k) => setChecklist(prev => ({ ...prev, [k]: !prev[k] }));
  const checkedCount = Object.values(checklist).filter(Boolean).length;
  const allChecked = checkedCount === 5;

  const handleApprove = async () => {
    if (!allChecked) {
      toast.error('All 5 checklist items must be verified before internal sign-off.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/drawing-tracker/drawings/${drawing.id}/sop/internal-review`, {
        status: 'approved',
        checklist,
        notes,
      });
      toast.success(`Internal Pre-Check Passed by ${raci?.s3_senior_check?.assigned_name || 'Ambuj'} (SOP-06.3)! Ready for client submission.`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to submit review');
    } finally {
      setBusy(false);
    }
  };

  const handleReject = async () => {
    if (!notes.trim()) {
      toast.error('Please specify correction notes explaining the mistakes caught.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/drawing-tracker/drawings/${drawing.id}/sop/internal-review`, {
        status: 'rejected',
        checklist,
        notes,
      });
      toast.error(`Drawing returned for corrections (${raci?.s1_s2_drafting?.assigned_name || 'MD Asad'}).`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to submit rejection');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`SOP-06.3 · Senior Pre-Submission Check — ${raci?.s3_senior_check?.assigned_name || 'Ambuj'}`} wide>
      <div className="space-y-4">
        <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-900 flex items-start gap-2">
          <FiAlertTriangle className="text-amber-600 mt-0.5 shrink-0 text-base" />
          <div>
            <strong>Mandatory QC Gate (Senior Engineer: {raci?.s3_senior_check?.assigned_name || 'Ambuj'} · 4-hr SLA):</strong>
            <p className="mt-0.5 text-amber-800">
              Our senior must check the drawing BEFORE it goes to the client. All mistakes must be caught in-house.
            </p>
          </div>
        </div>

        <div className="border border-gray-200 rounded-lg p-3 bg-white space-y-2">
          <div className="flex items-center justify-between border-b pb-2">
            <span className="text-xs font-semibold text-gray-700">Pre-Submission Quality Checklist</span>
            <span className={`text-xs px-2 py-0.5 rounded font-bold ${allChecked ? 'bg-emerald-100 text-emerald-800 border border-emerald-300' : 'bg-amber-100 text-amber-800'}`}>
              {checkedCount}/5 Verified
            </span>
          </div>

          {[
            ['chk_title_block', '1. Title block, Project Name, Drawing No., and Revision tag verified'],
            ['chk_dimensions', '2. Dimensions, grid lines, elevations, and structural levels verified'],
            ['chk_specs', '3. Specifications, materials, equipment tags, and design notes match project scope'],
            ['chk_scale', '4. Standard drafting scale, legends, symbology, and line weights followed (SOP-06.2)'],
            ['chk_clash', '5. Clash detection with other disciplines (MEP / HVAC / Structural / Architectural) verified'],
          ].map(([k, label]) => (
            <label key={k} className="flex items-start gap-2.5 p-2 rounded hover:bg-gray-50 cursor-pointer text-xs text-gray-800 select-none">
              <input
                type="checkbox"
                checked={!!checklist[k]}
                onChange={() => toggle(k)}
                className="mt-0.5 h-4 w-4 rounded border-gray-300 text-amber-600 focus:ring-amber-500 cursor-pointer"
              />
              <span className={checklist[k] ? 'font-medium text-gray-900' : 'text-gray-600'}>{label}</span>
            </label>
          ))}
        </div>

        <div>
          <label className="label text-xs">Reviewer Notes &amp; Observations</label>
          <textarea
            className="input w-full text-xs"
            rows={3}
            placeholder="Add observations, checked notes, or specific mistakes found for drafting..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <button
            type="button"
            disabled={busy || !allChecked}
            onClick={handleApprove}
            className="btn btn-success flex-1 text-xs py-2 disabled:opacity-50"
          >
            <FiCheck className="inline mr-1" /> Approve &amp; Sign Off (Move to S4)
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={handleReject}
            className="btn btn-danger flex-1 text-xs py-2"
          >
            <FiX className="inline mr-1" /> Return for Revision ({raci?.s1_s2_drafting?.assigned_name || 'MD Asad'})
          </button>
          <button
            type="button"
            onClick={onClose}
            className="btn btn-secondary text-xs"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ─── SOP-06.4: Client Submission Modal (Lovely) ──────────────────────────
function ClientSubmitModal({ drawing, raci, onClose, onSaved }) {
  const [submittedAt, setSubmittedAt] = useState(new Date().toISOString().slice(0, 16));
  const defaultDueDate = () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return d.toISOString().slice(0, 10);
  };
  const [expectedDate, setExpectedDate] = useState(defaultDueDate());
  const [refNo, setRefNo] = useState(`TRN-${new Date().getFullYear()}-${drawing.drawing_number}`);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!expectedDate) {
      toast.error('Expected client approval date is required.');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/drawing-tracker/drawings/${drawing.id}/sop/client-submit`, {
        client_submitted_at: submittedAt,
        client_expected_date: expectedDate,
        submission_ref_no: refNo,
        submission_notes: notes,
      });
      toast.success(`Drawing submitted to client (${raci?.s4_client_submit?.assigned_name || 'Lovely'} · SOP-06.4). SLA clock started!`);
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to log client submission');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`SOP-06.4 · Submit Drawing to Client — ${drawing.drawing_number}`}>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-900 flex items-start gap-2">
          <FiSend className="text-blue-600 mt-0.5 shrink-0 text-base" />
          <div>
            <strong>Client Submission &amp; SLA Clock Start ({raci?.s4_client_submit?.assigned_name || 'Lovely'} / Coordinator):</strong>
            <p className="mt-0.5 text-blue-800">
              The clock starts now. Automated reminders will trigger at 50% and 80% elapsed time to ensure approval before deadline.
            </p>
          </div>
        </div>

        <div>
          <label className="label text-xs">Submission Timestamp *</label>
          <input
            type="datetime-local"
            className="input w-full text-xs"
            value={submittedAt}
            onChange={e => setSubmittedAt(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label text-xs">Transmittal / Dispatch Ref Number *</label>
          <input
            className="input w-full text-xs"
            placeholder="TRN-2026-001 / Email Dispatch Ref"
            value={refNo}
            onChange={e => setRefNo(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label text-xs">Expected Client Approval Date (SLA Target) *</label>
          <input
            type="date"
            className="input w-full text-xs"
            value={expectedDate}
            onChange={e => setExpectedDate(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label text-xs">Submission Notes / Client Contact</label>
          <textarea
            className="input w-full text-xs"
            rows={2}
            placeholder="Recipient email, transmittal remarks, special client instructions..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <button type="submit" disabled={busy} className="btn btn-primary flex-1 text-xs py-2">
            <FiSend className="inline mr-1" /> Log Submission &amp; Start Clock (Move to S5)
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── SOP-06.5: Reminder Modal (50% / 80% / Rajat sir) ────────────────────
function ReminderModal({ drawing, sla, raci, onClose, onSaved }) {
  const [type, setType] = useState(sla?.percent >= 80 ? '80' : '50');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);

  const handleSend = async () => {
    setBusy(true);
    try {
      await api.post(`/drawing-tracker/drawings/${drawing.id}/sop/client-reminder`, {
        reminder_type: type,
        notes,
      });
      toast.success(type === '80' ? `Urgent 80% escalation sent to ${raci?.s5_escalation_80?.assigned_name || 'Rajat sir'} & Design Head!` : `50% milestone reminder sent to ${raci?.s5_reminder_50?.assigned_name || 'PM'} & Design Head.`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to dispatch reminder');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`SOP-06.5 · SLA Follow-Up & Reminder — ${drawing.drawing_number}`}>
      <div className="space-y-3">
        <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-xs text-purple-900 flex items-start gap-2">
          <FiClock className="text-purple-600 mt-0.5 shrink-0 text-base" />
          <div>
            <strong>SOP-06.5 Escalation Rule Card:</strong>
            <p className="mt-0.5 text-purple-800">
              Reminders at half time (50%) and 80% time — before the date, not after. Escalation chain: {raci?.s5_reminder_50?.assigned_name || 'PM'} → Head → {raci?.s5_escalation_80?.assigned_name || 'MD (Rajat sir)'}.
            </p>
          </div>
        </div>

        <div className="space-y-2">
          <label className="text-xs font-semibold text-gray-700">Select Reminder Milestone:</label>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setType('50')}
              className={`p-2.5 rounded-lg border text-left text-xs transition-all ${type === '50' ? 'border-amber-500 bg-amber-50 ring-1 ring-amber-500 font-bold' : 'border-gray-200 bg-white'}`}
            >
              <div className="text-amber-700 font-semibold">50% Half-Time Reminder</div>
              <div className="text-[10px] text-gray-500 mt-0.5">{raci?.s5_reminder_50?.assigned_name || 'PM'} → Design Head</div>
            </button>
            <button
              type="button"
              onClick={() => setType('80')}
              className={`p-2.5 rounded-lg border text-left text-xs transition-all ${type === '80' ? 'border-red-500 bg-red-50 ring-1 ring-red-500 font-bold' : 'border-gray-200 bg-white'}`}
            >
              <div className="text-red-700 font-semibold">80% Urgent Escalation</div>
              <div className="text-[10px] text-gray-500 mt-0.5">Design Head → {raci?.s5_escalation_80?.assigned_name || 'MD (Rajat sir)'}</div>
            </button>
          </div>
        </div>

        <div>
          <label className="label text-xs">Follow-Up Note / Action Taken</label>
          <textarea
            className="input w-full text-xs"
            rows={2}
            placeholder="Details of client call / email sent / expected sign-off date..."
            value={notes}
            onChange={e => setNotes(e.target.value)}
          />
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <button type="button" disabled={busy} onClick={handleSend} className="btn btn-primary flex-1 text-xs py-2">
            <FiBell className="inline mr-1" /> Dispatch Milestone Alert (SOP-06.5)
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Cancel</button>
        </div>
      </div>
    </Modal>
  );
}

// ─── SOP-06.6: Release to Site Modal (Ambuj) ─────────────────────────────
function ReleaseToSiteModal({ drawing, currentRev, raci, onClose, onSaved }) {
  const year = new Date().getFullYear();
  const [releaseNoteNo, setReleaseNoteNo] = useState(`DRN-${year}-${String(drawing.id).padStart(4, '0')}`);
  const [remarks, setRemarks] = useState('Approved by client — Issued Good For Construction (GFC) to site.');
  const [readyTicked, setReadyTicked] = useState(true);
  const [busy, setBusy] = useState(false);

  const handleRelease = async (e) => {
    e.preventDefault();
    if (!readyTicked) {
      toast.error('The site ready-checklist must be ticked upon release (SOP-06.6).');
      return;
    }
    setBusy(true);
    try {
      await api.post(`/drawing-tracker/drawings/${drawing.id}/sop/release-to-site`, {
        release_note_no: releaseNoteNo,
        site_release_remarks: remarks,
      });
      toast.success(`Drawing Released to Site (GFC) under ${releaseNoteNo}! Ready checklist ticked.`);
      onSaved();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to release drawing');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal isOpen onClose={onClose} title={`SOP-06.6 · Release Drawing to Site (GFC) — ${drawing.drawing_number}`}>
      <form onSubmit={handleRelease} className="space-y-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900 flex items-start gap-2">
          <FiCheckCircle className="text-emerald-600 mt-0.5 shrink-0 text-base" />
          <div>
            <strong>Drawing Release Note &amp; Ready-Checklist ({raci?.s6_site_release?.assigned_name || 'Ambuj'} · SOP-06.6):</strong>
            <p className="mt-0.5 text-emerald-800">
              Approved drawing goes to site. The official Drawing Release Note (DRN) will be generated and the site ready-checklist will be ticked.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 text-xs bg-gray-50 p-3 rounded-lg border border-gray-200">
          <div><span className="text-gray-500">Drawing:</span> <span className="font-mono font-bold text-red-600">{drawing.drawing_number}</span></div>
          <div><span className="text-gray-500">Released Revision:</span> <span className="font-bold text-emerald-700">Rev {currentRev?.revision_no ?? 0}</span></div>
          <div><span className="text-gray-500">Project:</span> <span className="font-medium">{drawing.project_name || '—'}</span></div>
          <div><span className="text-gray-500">Site:</span> <span className="font-medium">{drawing.site_name || '—'}</span></div>
        </div>

        <div>
          <label className="label text-xs">Drawing Release Note (DRN) Number *</label>
          <input
            className="input w-full text-xs font-mono font-semibold"
            value={releaseNoteNo}
            onChange={e => setReleaseNoteNo(e.target.value)}
            required
          />
        </div>

        <div>
          <label className="label text-xs">Release Remarks / Construction Instructions</label>
          <textarea
            className="input w-full text-xs"
            rows={2}
            value={remarks}
            onChange={e => setRemarks(e.target.value)}
          />
        </div>

        <div className="p-3 bg-emerald-50/60 border border-emerald-200 rounded-lg">
          <label className="flex items-center gap-2 cursor-pointer text-xs font-semibold text-emerald-950">
            <input
              type="checkbox"
              checked={readyTicked}
              onChange={e => setReadyTicked(e.target.checked)}
              className="h-4 w-4 text-emerald-600 rounded border-emerald-300"
            />
            <span>Tick Site Ready-Checklist (SOP-06.6 Requirement)</span>
          </label>
          <p className="text-[11px] text-emerald-700 ml-6 mt-0.5">
            Confirms site operations are cleared to proceed with construction using this GFC revision.
          </p>
        </div>

        <div className="flex gap-2 pt-2 border-t">
          <button type="submit" disabled={busy} className="btn btn-success flex-1 text-xs py-2">
            <FiCheckCircle className="inline mr-1" /> Confirm Site Release &amp; Generate Note (SOP-06.6)
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Cancel</button>
        </div>
      </form>
    </Modal>
  );
}

// ─── SOP-06.6: Document View / Print Release Note Modal ──────────────────
function ViewReleaseNoteModal({ drawing, currentRev, raci, onClose }) {
  return (
    <Modal isOpen onClose={onClose} title={`Drawing Release Note — ${drawing.release_note_no || 'DRN'}`} wide>
      <div className="space-y-4">
        {/* Printable Release Note Certificate */}
        <div id="printable-release-note" className="p-6 bg-white border border-gray-300 rounded-lg space-y-5 text-gray-900">
          <div className="flex items-center justify-between border-b pb-4">
            <div>
              <h2 className="text-xl font-bold tracking-tight text-blue-900">Secured Engineers Pvt. Ltd.</h2>
              <p className="text-xs text-gray-500">Corporate &amp; Site Engineering Management</p>
            </div>
            <div className="text-right">
              <span className="bg-emerald-100 text-emerald-800 text-xs px-2.5 py-1 rounded font-bold border border-emerald-300">
                GOOD FOR CONSTRUCTION (GFC)
              </span>
              <div className="text-xs font-mono font-bold text-gray-700 mt-1">{drawing.release_note_no}</div>
            </div>
          </div>

          <div className="text-center py-1">
            <h3 className="text-base font-bold uppercase tracking-wider text-gray-800">Drawing Release Note (SOP-06.6)</h3>
            <p className="text-xs text-gray-500">Formal Engineering Document Clearance &amp; Site Distribution</p>
          </div>

          <div className="grid grid-cols-2 gap-4 text-xs bg-gray-50 p-4 rounded-lg border border-gray-200">
            <div><span className="text-gray-500">Project Name:</span> <span className="font-semibold">{drawing.project_name || '—'}</span></div>
            <div><span className="text-gray-500">Site Location:</span> <span className="font-semibold">{drawing.site_name || '—'}</span></div>
            <div><span className="text-gray-500">Drawing Number:</span> <span className="font-mono font-bold text-red-600">{drawing.drawing_number}</span></div>
            <div><span className="text-gray-500">Approved Revision:</span> <span className="font-bold text-emerald-700">Rev {currentRev?.revision_no ?? 0}</span></div>
            <div><span className="text-gray-500">Discipline:</span> <span className="font-medium">{drawing.discipline || 'General'}</span></div>
            <div><span className="text-gray-500">Drawing Type:</span> <span className="font-medium">{drawing.drawing_type || 'GFC Drawing'}</span></div>
            <div><span className="text-gray-500">Client Transmittal Ref:</span> <span className="font-medium">{drawing.submission_ref_no || '—'}</span></div>
            <div><span className="text-gray-500">Release Date:</span> <span className="font-medium">{fmtDate(drawing.site_released_at)}</span></div>
          </div>

          <div className="space-y-1 text-xs">
            <div className="font-semibold text-gray-700">Construction Instructions &amp; Remarks:</div>
            <div className="p-3 bg-gray-50 rounded border border-gray-200 text-gray-700 italic">
              "{drawing.site_release_remarks || 'This drawing is approved by client and issued as Good For Construction (GFC). All previous revisions are superseded.'}"
            </div>
          </div>

          <div className="border-t pt-4 grid grid-cols-3 gap-4 text-center text-xs">
            <div className="p-2 border rounded bg-gray-50">
              <div className="text-[10px] text-gray-400">DRAFTED BY</div>
              <div className="font-semibold mt-1">{drawing.created_by_name || raci?.s1_s2_drafting?.assigned_name || 'MD Asad'}</div>
              <div className="text-[10px] text-gray-500">Design Engineer (SOP-06.2)</div>
            </div>
            <div className="p-2 border rounded bg-gray-50">
              <div className="text-[10px] text-gray-400">CHECKED &amp; RELEASED BY</div>
              <div className="font-semibold mt-1">{drawing.site_released_by_name || raci?.s6_site_release?.assigned_name || 'Ambuj'}</div>
              <div className="text-[10px] text-gray-500">Senior Engineer (SOP-06.3 / 06.6)</div>
            </div>
            <div className="p-2 border rounded bg-emerald-50 border-emerald-200">
              <div className="text-[10px] text-emerald-600">READY-CHECKLIST</div>
              <div className="font-bold text-emerald-800 mt-1 flex items-center justify-center gap-1">
                <FiCheckCircle /> CONFIRMED TICKED
              </div>
              <div className="text-[10px] text-emerald-600">Site Operations Cleared</div>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 border-t pt-3">
          <button
            type="button"
            onClick={() => window.print()}
            className="btn btn-primary text-xs flex items-center gap-1.5"
          >
            <FiPrinter size={13} /> Print Release Note
          </button>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs">Close</button>
        </div>
      </div>
    </Modal>
  );
}
