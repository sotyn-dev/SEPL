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
} from 'react-icons/fi';
// The viewer and the upload modal are shared with the Revision Matrix, so
// the superseded warning and the upload rules live in exactly one place.
import {
  RevisionViewer, UploadRevisionModal, useRevisionBlob, REV_CLS, isPdf, isDwg, getRevExtension,
  fmtDrawingDate as fmtDate,
} from '../components/DrawingRevisionModals';
import { EditDrawingModal } from './DrawingTracker';

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

  const load = useCallback(() => {
    api.get(`/drawing-tracker/drawings/${id}`)
      .then(r => setData(r.data)).catch(() => toast.error('Could not load drawing'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { api.get('/drawing-tracker/options').then(r => setOpts(r.data)).catch(() => {}); }, []);

  if (!data) return <div className="p-4 text-sm text-gray-400">Loading…</div>;
  const current = data.revisions.find(r => r.status === 'current');

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
