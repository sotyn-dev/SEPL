import { useState } from 'react';
export default function ProofPreview({ url, name, type }) {
  const [imageFailed, setImageFailed] = useState(false);
  if (!url) return null;
  const extension = (name || url).split(/[?#]/)[0].split('.').pop().toLowerCase();
  const isImage = type?.startsWith('image/') || ['jpg','jpeg','png','gif','webp','avif','bmp'].includes(extension);
  const isPdf = type === 'application/pdf' || extension === 'pdf';
  return (
    <div className="mt-3 rounded-lg border border-gray-200 bg-gray-50 p-3 space-y-2">
      <p className="text-sm font-semibold text-gray-800">Check your proof before submitting</p>
      <p className="text-xs text-gray-600 break-all">{name || 'Uploaded proof'}</p>
      {isImage && !imageFailed && <a href={url} target="_blank" rel="noopener noreferrer" className="block" aria-label="Open proof image at full size"><img src={url} alt={name ? 'Proof: ' + name : 'Uploaded proof'} onError={() => setImageFailed(true)} className="w-full max-h-72 object-contain rounded bg-white" /></a>}
      {isPdf && <iframe src={url} title="Uploaded proof PDF preview" className="w-full h-72 rounded border bg-white" />}
      {((!isImage && !isPdf) || imageFailed) && <p className="text-xs text-gray-600">Preview unavailable. Open or download the file to check its contents.</p>}
      <a href={url} target="_blank" rel="noopener noreferrer" className="inline-block text-sm text-blue-700 underline">Open / download proof</a>
      <p className="text-xs text-gray-500">Wrong file? Choose another file or take a new photo above.</p>
    </div>
  );
}
