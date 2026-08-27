// Online file viewer (mam 2026-08-27): opens ERP files in a browser tab
// instead of forcing a download. PDFs/images/text render natively in an
// iframe; Excel/Word/CSV are converted to HTML by GET /api/files/preview.
// Reached as /file-view?src=/uploads/<file> — a global click interceptor in
// Layout.jsx routes every office-file link here, whole-ERP, no per-page work.
import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../api';
import { FiDownload, FiExternalLink, FiFileText } from 'react-icons/fi';

const NATIVE_EXT = /\.(pdf|png|jpe?g|gif|webp|svg|txt)(\?|$)/i;

export default function FileViewer() {
  const [params] = useSearchParams();
  const src = params.get('src') || '';
  const name = decodeURIComponent((src.split('?')[0].split('/').pop()) || 'file');
  const isNative = NATIVE_EXT.test(src);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(0);

  useEffect(() => { document.title = `${name} — SOTYN.AI`; }, [name]);
  useEffect(() => {
    if (!src || isNative) return;
    api.get('/files/preview', { params: { src } })
      .then(r => setData(r.data))
      .catch(err => setError(err.response?.data?.error || 'Could not render this file'));
  }, [src, isNative]);

  if (!src) return <div className="p-10 text-center text-gray-400">No file given</div>;

  return (
    <div className="min-h-screen bg-gray-100 flex flex-col">
      <div className="bg-white border-b px-4 py-2.5 flex items-center gap-3 sticky top-0 z-10 shadow-sm">
        <FiFileText className="text-indigo-600 flex-shrink-0" />
        <div className="font-semibold text-sm truncate flex-1" title={name}>{name}</div>
        <a href={src} download className="btn btn-secondary text-xs flex items-center gap-1"><FiDownload size={13} /> Download</a>
        <a href={src} target="_blank" rel="noreferrer" className="btn btn-secondary text-xs flex items-center gap-1" title="Open the raw file"><FiExternalLink size={13} /> Raw</a>
      </div>

      {isNative ? (
        <iframe title={name} src={src} className="flex-1 w-full border-0" style={{ minHeight: 'calc(100vh - 46px)' }} />
      ) : error ? (
        <div className="p-10 text-center">
          <p className="text-gray-600 mb-3">{error}</p>
          <a href={src} download className="btn btn-primary inline-flex items-center gap-2"><FiDownload /> Download instead</a>
        </div>
      ) : !data ? (
        <div className="p-10 text-center text-gray-400">Opening {name}…</div>
      ) : (
        <div className="flex-1 overflow-auto">
          {data.kind === 'sheets' && data.sheets.length > 1 && (
            <div className="flex gap-1 px-4 pt-3 flex-wrap">
              {data.sheets.map((s, i) => (
                <button key={s.name} onClick={() => setTab(i)}
                  className={`text-xs px-3 py-1.5 rounded-t font-semibold ${tab === i ? 'bg-white border border-b-white text-indigo-700' : 'bg-gray-200 text-gray-600 hover:bg-gray-300'}`}>
                  {s.name}
                </button>
              ))}
            </div>
          )}
          <div className="bg-white m-4 mt-0 p-4 rounded shadow-sm overflow-x-auto file-preview-html"
               dangerouslySetInnerHTML={{ __html: data.kind === 'sheets' ? data.sheets[tab]?.html : data.html }} />
          {/* Spreadsheet/document styling for the converted HTML */}
          <style>{`
            .file-preview-html table { border-collapse: collapse; font-size: 12px; }
            .file-preview-html td, .file-preview-html th { border: 1px solid #e2e8f0; padding: 4px 8px; white-space: nowrap; }
            .file-preview-html tr:first-child td { background: #f1f5f9; font-weight: 600; }
            .file-preview-html p { margin: 0.5em 0; font-size: 14px; line-height: 1.55; }
            .file-preview-html h1, .file-preview-html h2, .file-preview-html h3 { margin: 0.8em 0 0.4em; font-weight: 700; }
            .file-preview-html img { max-width: 100%; }
          `}</style>
        </div>
      )}
    </div>
  );
}
