// Full-page drawing viewer — opens in its own browser tab.
//
// Why this exists rather than just linking straight at the file: the file
// route needs an Authorization header (a plain <a target="_blank"> can't
// send one), and a raw file tab would drop the superseded warning. This page
// fetches through the authenticated API, keeps the warning, and still gives
// the drawing the whole window.
import { useState, useEffect } from 'react';
import { useParams } from 'react-router-dom';
import api from '../api';
import { useRevisionBlob, isPdf, fmtDrawingDate } from '../components/DrawingRevisionModals';
import { FiAlertTriangle, FiDownload, FiExternalLink } from 'react-icons/fi';

export default function DrawingRevisionView() {
  const { id } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const { url, err } = useRevisionBlob(id);

  useEffect(() => {
    api.get(`/drawing-tracker/revisions/${id}`)
      .then(r => setData(r.data))
      .catch(e => setError(e.response?.data?.error || 'Could not load this revision'));
  }, [id]);

  // Put the drawing + revision in the tab title so several open tabs are
  // tellable apart at a glance.
  useEffect(() => {
    if (data?.revision) {
      document.title = `${data.revision.drawing_number} Rev ${data.revision.revision_no}`;
    }
  }, [data]);

  if (error) return <div className="p-8 text-red-600">{error}</div>;
  if (!data) return <div className="p-8 text-gray-400">Loading…</div>;

  const r = data.revision;
  const current = data.current;
  const stale = r.status !== 'current';

  const download = async () => {
    const resp = await api.get(`/drawing-tracker/revisions/${r.id}/file?download=1`, { responseType: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(resp.data);
    a.download = `${r.drawing_number}_Rev${r.revision_no}${(r.file_name || '').match(/\.[a-z0-9]+$/i)?.[0] || ''}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="h-screen flex flex-col bg-gray-100">
      <div className="bg-white border-b px-4 py-2.5 flex items-center gap-3 flex-wrap shrink-0">
        <div>
          <span className="font-mono font-bold text-red-600 text-lg">{r.drawing_number}</span>
          <span className="ml-2 font-semibold">Rev {r.revision_no}</span>
          <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded border ${
            r.status === 'current' ? 'bg-emerald-100 text-emerald-700 border-emerald-300'
              : r.status === 'cancelled' ? 'bg-red-100 text-red-700 border-red-300'
                : 'bg-gray-100 text-gray-500 border-gray-300'}`}>
            {r.status.toUpperCase()}
          </span>
          <div className="text-xs text-gray-500">
            {r.title} · {r.site_name || '—'} · {r.discipline || '—'} ·
            {' '}{fmtDrawingDate(r.revision_date || r.uploaded_at)} by {r.uploaded_by_name || '—'}
          </div>
        </div>
        <div className="ml-auto flex gap-2">
          <button onClick={download} className="btn btn-secondary text-sm flex items-center gap-1">
            <FiDownload size={14} /> Download
          </button>
          <a href={`/drawing-tracker/${r.drawing_id}`} className="btn btn-secondary text-sm flex items-center gap-1">
            <FiExternalLink size={14} /> All revisions
          </a>
        </div>
      </div>

      {r.revision_description && (
        <div className="bg-white border-b px-4 py-1.5 text-xs text-gray-600 shrink-0">
          <span className="text-gray-400">What changed:</span> {r.revision_description}
          {r.revision_reason ? ` · ${r.revision_reason}` : ''}
        </div>
      )}

      {/* The warning has to survive into this standalone tab too — it is the
          whole reason we don't just link at the raw file. */}
      {stale && current && (
        <div className="bg-amber-50 border-b border-amber-300 px-4 py-2.5 flex items-center gap-2 text-sm text-amber-900 shrink-0 flex-wrap">
          <FiAlertTriangle className="shrink-0" />
          <span>
            <strong>This drawing is superseded.</strong> You are viewing Rev {r.revision_no}.
            The latest issued revision is <strong>Rev {current.revision_no}</strong> — do not build from this one.
          </span>
          <a href={`/drawing-view/${current.id}`} className="btn btn-primary text-xs ml-auto shrink-0">
            Open Rev {current.revision_no}
          </a>
        </div>
      )}

      <div className="flex-1 min-h-0">
        {err && <div className="p-8 text-center text-red-600 text-sm">{err}</div>}
        {!err && !url && <div className="p-8 text-center text-gray-400 text-sm">Loading file…</div>}
        {url && isPdf(r) && <iframe src={url} title={`Rev ${r.revision_no}`} className="w-full h-full border-0" />}
        {url && !isPdf(r) && (
          <div className="p-10 text-center text-sm text-gray-600">
            <p className="mb-3">
              <strong>{r.file_name}</strong> can't be displayed in the browser
              — only PDFs and images preview inline.
            </p>
            <button onClick={download} className="btn btn-primary text-sm">
              Download Rev {r.revision_no}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
