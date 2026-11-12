import { useState } from 'react';
import { FiZoomIn, FiExternalLink } from 'react-icons/fi';
import ImageViewerModal from './ImageViewerModal';

export default function ProofPreview({ url, name, type, reviewOnly = false }) {
  const [imageFailed, setImageFailed] = useState(false);
  const [isZoomOpen, setIsZoomOpen] = useState(false);

  if (!url) return null;
  const extension = (name || url).split(/[?#]/)[0].split('.').pop().toLowerCase();
  const isImage = type?.startsWith('image/') || ['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'bmp', 'svg'].includes(extension) || url.startsWith('data:image/');
  const isPdf = type === 'application/pdf' || extension === 'pdf' || url.startsWith('data:application/pdf');

  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-gray-800">
          {reviewOnly ? 'Submitted proof' : 'Check your proof before submitting'}
        </p>
        {isImage && !imageFailed && (
          <button
            type="button"
            onClick={() => setIsZoomOpen(true)}
            className="inline-flex items-center gap-1 text-xs font-bold text-indigo-700 hover:text-indigo-900 bg-indigo-50 hover:bg-indigo-100 px-2 py-0.5 rounded transition-colors"
          >
            <FiZoomIn size={13} />
            <span>Click to Zoom</span>
          </button>
        )}
      </div>
      <p className="text-xs text-gray-600 break-all">{name || 'Uploaded proof'}</p>

      {isImage && !imageFailed && (
        <div
          onClick={() => setIsZoomOpen(true)}
          className="group relative cursor-zoom-in rounded border bg-white overflow-hidden shadow-xs"
          title="Click to zoom in/out, pan, and view full screen"
        >
          <img
            src={url}
            alt={name ? 'Proof: ' + name : 'Uploaded proof'}
            onError={() => setImageFailed(true)}
            className="w-full max-h-80 object-contain mx-auto transition-transform group-hover:scale-[1.02]"
          />
          <div className="absolute inset-0 bg-black/10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
            <span className="bg-slate-900/80 text-white text-xs font-bold px-3 py-1.5 rounded-full shadow-lg flex items-center gap-1.5 backdrop-blur-sm">
              <FiZoomIn size={14} />
              Click to Zoom & Pan
            </span>
          </div>
        </div>
      )}

      {isPdf && (
        <div className="space-y-2">
          <iframe
            src={url}
            title="Uploaded proof PDF preview"
            className="w-full h-80 rounded border bg-white"
          />
        </div>
      )}

      {((!isImage && !isPdf) || imageFailed) && (
        <p className="text-xs text-gray-600">
          Preview unavailable. Open or download the file to check its contents.
        </p>
      )}

      <div className="flex items-center gap-3 pt-1">
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700 hover:text-blue-900 underline"
        >
          <FiExternalLink size={12} />
          <span>Open in new window / Full screen</span>
        </a>
      </div>

      {!reviewOnly && (
        <p className="text-xs text-gray-500">
          Wrong file? Choose another file or take a new photo above.
        </p>
      )}

      {isZoomOpen && isImage && (
        <ImageViewerModal
          src={url}
          name={name || 'Proof Preview'}
          downloadUrl={url}
          onClose={() => setIsZoomOpen(false)}
        />
      )}
    </div>
  );
}
