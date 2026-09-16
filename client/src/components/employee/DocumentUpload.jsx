import { useRef, useState } from 'react';
import api from '../../api';
import { FiFileText, FiUpload, FiX, FiExternalLink } from 'react-icons/fi';

export default function DocumentUpload({ field, value, file, disabled, onFile, onRemove, error }) {
  const input = useRef(null);
  const [localError, setLocalError] = useState('');
  const [viewing, setViewing] = useState(false);
  const view = async () => {
    const preview = window.open('', '_blank');
    if (preview) preview.opener = null;
    setViewing(true); setLocalError('');
    try {
      const blob = file || (await api.get(value, { baseURL: '', responseType: 'blob' })).data;
      const url = URL.createObjectURL(blob);
      if (preview) preview.location.replace(url);
      else { URL.revokeObjectURL(url); throw new Error('Allow document previews in your browser, then try View again.'); }
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (error) { preview?.close(); setLocalError(error.message || 'Unable to view document'); }
    finally { setViewing(false); }
  };
  const name = file?.name || (value ? value.split('/').pop() : '');
  const choose = event => {
    const next = event.target.files?.[0]; event.target.value = '';
    if (!next) return;
    if (!/\.(pdf|jpe?g|png)$/i.test(next.name) || next.size > 10 * 1024 * 1024) {
      setLocalError('Choose a PDF, JPG or PNG up to 10 MB.'); return;
    }
    setLocalError(''); onFile(next);
  };
  return <div className="em-upload">
    <div className="flex items-start gap-3">
      <span className="em-file-icon"><FiFileText size={20} /></span>
      <div className="min-w-0 flex-1"><h4 className="font-semibold text-sm text-slate-800">{field.label}</h4>
        <p className="text-xs text-slate-500 mt-1">PDF, JPG or PNG · Up to 10 MB</p>
        {name && <p className="text-xs text-slate-700 mt-2 break-all">{name}</p>}
        {name && <p className={`text-xs mt-1 ${file ? 'text-amber-700' : 'text-emerald-700'}`}>{file ? 'Selected · uploads when you save' : 'Uploaded'}</p>}
      </div>
    </div>
    <input ref={input} type="file" className="sr-only" tabIndex={-1} aria-label={`Choose ${field.label}`} accept=".pdf,.jpg,.jpeg,.png" disabled={disabled} onChange={choose} />
    <div className="flex flex-wrap gap-3 mt-4 items-center">
      {!disabled && <button type="button" className="btn btn-secondary inline-flex items-center gap-2" onClick={() => input.current?.click()}><FiUpload size={14} />{name ? 'Replace' : `Upload ${field.label}`}</button>}
      {(value || file) && <button type="button" disabled={viewing} onClick={view} className="em-text-button inline-flex items-center gap-1"><FiExternalLink />{viewing ? "Opening…" : "View"}</button>}
      {name && !disabled && <button type="button" className="text-xs text-red-700 inline-flex items-center gap-1" onClick={() => { setLocalError(''); onRemove(); }}><FiX /> Remove</button>}
    </div>
    {(localError || error) && <p role="alert" className="text-xs text-red-700 mt-2">{localError || error}</p>}
  </div>;
}
