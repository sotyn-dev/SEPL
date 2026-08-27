// Shared Drawing Tracker pieces — used by BOTH the drawing detail page and
// the revision matrix, so the viewer's superseded warning and the upload
// rules exist in exactly one place.
import { useState, useEffect } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from './Modal';
import { FiAlertTriangle, FiX, FiExternalLink } from 'react-icons/fi';

export const fmtDrawingDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d);
  return isNaN(dt) ? d : dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

export const REV_CLS = {
  current: 'bg-emerald-100 text-emerald-700 border-emerald-300',
  superseded: 'bg-gray-100 text-gray-500 border-gray-300',
  cancelled: 'bg-red-100 text-red-700 border-red-300',
};

export const isPdf = (rev) => /pdf/i.test(rev?.file_type || '') || /\.pdf$/i.test(rev?.file_name || '');

// Fetches a revision's file through the permission-checked route and turns it
// into an object URL. An <iframe> can't send an Authorization header, so the
// blob is how the gated route stays gated while still being viewable inline.
export function useRevisionBlob(revisionId) {
  const [url, setUrl] = useState(null);
  const [err, setErr] = useState(null);
  useEffect(() => {
    if (!revisionId) return undefined;
    let objectUrl = null;
    let cancelled = false;
    setUrl(null); setErr(null);
    api.get(`/drawing-tracker/revisions/${revisionId}/file`, { responseType: 'blob' })
      .then(r => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(r.data);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setErr('Could not load this file.'); });
    return () => { cancelled = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [revisionId]);
  return { url, err };
}

// Always shows the revision that was asked for — never silently the latest.
export function RevisionViewer({ revision, drawingNumber, current, onClose, onViewLatest }) {
  const { url, err } = useRevisionBlob(revision?.id);
  const stale = revision && revision.status !== 'current';
  if (!revision) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex flex-col" onClick={onClose}>
      <div className="bg-white m-4 rounded-lg flex-1 flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-3 border-b">
          <div>
            <span className="font-mono font-bold text-red-600">{drawingNumber}</span>
            <span className="ml-2 font-semibold">Rev {revision.revision_no}</span>
            <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded border ${REV_CLS[revision.status]}`}>{revision.status}</span>
          </div>
          <div className="flex items-center gap-2">
            <a href={`/drawing-view/${revision.id}`} target="_blank" rel="noreferrer"
              className="btn btn-secondary text-xs flex items-center gap-1" title="Open this revision in a new tab">
              <FiExternalLink size={13} /> Open in new tab
            </a>
            <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><FiX size={20} /></button>
          </div>
        </div>

        {/* Never let an old revision be mistaken for the live one. */}
        {stale && current && (
          <div className="bg-amber-50 border-b border-amber-300 px-4 py-2.5 flex items-center gap-2 text-sm text-amber-900">
            <FiAlertTriangle className="shrink-0" />
            <span>
              <strong>This drawing is superseded.</strong> You are viewing Rev {revision.revision_no}.
              The latest issued revision is <strong>Rev {current.revision_no}</strong> — do not build from this one.
            </span>
            {onViewLatest && (
              <button onClick={onViewLatest} className="btn btn-primary text-xs ml-auto shrink-0">
                View Rev {current.revision_no}
              </button>
            )}
          </div>
        )}

        <div className="flex-1 bg-gray-100 overflow-auto">
          {err && <div className="p-8 text-center text-red-600 text-sm">{err}</div>}
          {!err && !url && <div className="p-8 text-center text-gray-400 text-sm">Loading file…</div>}
          {url && isPdf(revision) && <iframe src={url} title={`Rev ${revision.revision_no}`} className="w-full h-full min-h-[60vh] border-0" />}
          {url && !isPdf(revision) && (
            <div className="p-8 text-center text-sm text-gray-600">
              <p className="mb-3">{revision.file_name} — this file type can't be previewed in the browser.</p>
              <a href={url} download={`${drawingNumber}_Rev${revision.revision_no}`} className="btn btn-primary text-sm">
                Download Rev {revision.revision_no}
              </a>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Uploads the next revision. The previous one is superseded, never replaced.
export function UploadRevisionModal({ drawingId, drawingNumber, revisions, onClose, onSaved }) {
  const nextNo = revisions?.length ? Math.max(...revisions.map(r => r.revision_no)) + 1 : 0;
  const [form, setForm] = useState({
    revision_description: '', revision_reason: '',
    revision_date: new Date().toLocaleDateString('en-CA'),
  });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [reasons, setReasons] = useState([]);
  useEffect(() => {
    api.get('/drawing-tracker/options').then(r => setReasons(r.data.revision_reasons || [])).catch(() => {});
  }, []);

  const save = async (e) => {
    e.preventDefault();
    if (!form.revision_description.trim()) return toast.error('Please describe what changed');
    if (!file) return toast.error('Please choose the drawing file');
    setBusy(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      Object.entries(form).forEach(([k, v]) => fd.append(k, v ?? ''));
      const r = await api.post(`/drawing-tracker/drawings/${drawingId}/revisions`, fd,
        { headers: { 'Content-Type': 'multipart/form-data' } });
      const n = r.data.new_revision_no;
      toast.success(n > 0 ? `Rev ${n} uploaded — Rev ${n - 1} is now superseded` : `Rev ${n} uploaded`);
      onSaved();
    } catch (e) {
      toast.error(e.response?.data?.error || 'Upload failed');
    } finally { setBusy(false); }
  };

  return (
    <Modal isOpen onClose={onClose} title={`Upload Rev ${nextNo} — ${drawingNumber}`}>
      <form onSubmit={save} className="space-y-3">
        <div className="text-xs bg-blue-50 border border-blue-200 rounded p-2 text-blue-900">
          This will become <strong>Rev {nextNo}</strong> and the current revision. Every earlier
          revision stays exactly as it is and remains downloadable.
        </div>
        <div><label className="label">Drawing File * <span className="text-gray-400 font-normal">(up to 100 MB)</span></label>
          <input type="file" className="input" onChange={e => setFile(e.target.files?.[0] || null)} required />
        </div>
        <div><label className="label">What changed? *</label>
          <input className="input" value={form.revision_description}
            onChange={e => setForm(f => ({ ...f, revision_description: e.target.value }))}
            placeholder="e.g. Cable routing on Ground Floor changed from red to blue" required />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Reason</label>
            <select className="select" value={form.revision_reason}
              onChange={e => setForm(f => ({ ...f, revision_reason: e.target.value }))}>
              <option value="">Select</option>
              {reasons.map(r => <option key={r} value={r}>{r}</option>)}
            </select>
          </div>
          <div><label className="label">Revision Date</label>
            <input type="date" className="input" value={form.revision_date}
              onChange={e => setForm(f => ({ ...f, revision_date: e.target.value }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn">Cancel</button>
          <button type="submit" disabled={busy} className="btn btn-primary">{busy ? 'Uploading…' : `Upload Rev ${nextNo}`}</button>
        </div>
      </form>
    </Modal>
  );
}
