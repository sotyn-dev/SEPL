import { useEffect, useRef, useState } from 'react';
import api from '../api';

// Fetch new private attachments with the existing auth client. Never place a JWT
// in an image/link URL. Legacy /uploads attachments keep their existing renderer.
export default function ChatSharedAttachment({ url, name, onImageClick }) {
  const image = /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif)$/i.test(name || '') || /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|avif)$/i.test(url || '');
  const [blobUrl, setBlobUrl] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0), [requested, setRequested] = useState(false);
  const host = useRef(null), downloadLink = useRef(null);
  useEffect(() => {
    if (!image) return;
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) {
        setRequested(true);
        observer.disconnect();
      }
    }, { rootMargin: '100px' });
    if (host.current) observer.observe(host.current);
    return () => observer.disconnect();
  }, [image, url]);
  useEffect(() => {
    if (!requested) return;
    let active = true, objectUrl;
    api.get(url.replace(/^\/api/, ''), { responseType: 'blob' }).then(({ data }) => {
      if (!active) return;
      objectUrl = URL.createObjectURL(data);
      setBlobUrl(objectUrl);
    }).catch(() => active && setError('File unavailable. Check your session or connection.'));
    return () => { active = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, retry, requested]);
  useEffect(() => { if (blobUrl && !image) downloadLink.current?.click(); }, [blobUrl, image]);
  if (error) return <button onClick={() => { setError(''); setRetry(n => n + 1); }} className="text-xs text-red-700 underline">{error} Retry</button>;
  if (!blobUrl) return <button ref={host} onClick={() => setRequested(true)} className="text-blue-700 underline mb-1 break-all">{requested ? 'Loading attachment…' : `${name || 'Attachment'} · Open / download`}</button>;

  if (image) {
    return (
      <div className="mb-1">
        <button
          type="button"
          onClick={() => {
            if (onImageClick) {
              onImageClick({ url: blobUrl || url, name, downloadUrl: blobUrl });
            } else {
              window.open(blobUrl, '_blank');
            }
          }}
          className="block text-left cursor-pointer group/img relative overflow-hidden rounded focus:outline-none focus:ring-2 focus:ring-blue-500"
          title="Tap to preview image"
        >
          <img src={blobUrl} alt={name || 'Attachment'} className="rounded max-h-52 max-w-full object-contain bg-gray-100 group-hover/img:opacity-90 active:opacity-75 transition" />
        </button>
        <a ref={downloadLink} href={blobUrl} download={name || 'attachment'} className="block text-blue-700 underline text-xs mt-0.5 break-all">
          {name || 'Attachment'} · Download
        </a>
      </div>
    );
  }

  return (
    <a ref={downloadLink} href={blobUrl} download={name || 'attachment'} className="block text-blue-700 underline mb-1 break-all">
      {name || 'Attachment'} · Open / download
    </a>
  );
}
