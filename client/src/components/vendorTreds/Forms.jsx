import { useRef, useState } from 'react';
import { FiAlertCircle, FiDownload, FiUpload } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../../api';
import Modal from '../Modal';
import { RemoteSelect, StatusBadge, Value } from './Common';
import { BASE, choice, contentFilename, downloadBlob, errorMessage, fieldsFor, isPaise, label, recordLabel, recordStatusLabel } from './model';

function editableFields(def) {
  return fieldsFor(def).filter(field => !field.readOnly && !field.readonly && !['id', 'status', 'version', 'created_at', 'created_by', 'updated_at', 'updated_by', 'expected_net_paise'].includes(field.key));
}

function initialValues(fields, record) {
  return Object.fromEntries(fields.map(field => {
    const value = record?.[field.key] ?? field.default ?? (field.type === 'boolean' ? field.nullable ? null : field.key === 'active' : '');
    return [field.key, isPaise(field) && value !== '' && value != null ? (Number(value) / 100).toFixed(2) : value];
  }));
}

function amountPaise(text) {
  const value = String(text).trim();
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(value)) throw new Error('Enter a rupee amount with at most two decimal places.');
  const [whole, fractional = ''] = value.replace('-', '').split('.');
  const amount = Number(whole) * 100 + Number(fractional.padEnd(2, '0'));
  if (!Number.isSafeInteger(amount)) throw new Error('This amount is too large.');
  return value.startsWith('-') ? -amount : amount;
}

export function EntityForm({ kind, def, record, onClose, onSaved, endpoint, onOpenCandidate, submitLabel = 'Save' }) {
  const fields = editableFields(def);
  const [values, setValues] = useState(() => initialValues(fields, record));
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState({});
  const [failure, setFailure] = useState('');
  const [candidates, setCandidates] = useState([]);
  const profileSequence = useRef(0);
  const update = (key, value) => {
    setValues(previous => ({ ...previous, [key]: value }));
    if (kind === 'registrations' && key === 'customer_id') {
      const sequence = ++profileSequence.current;
      if (!value) return;
      api.get(`${BASE}/customers/${value}/profile`).then(response => {
        if (sequence !== profileSequence.current) return;
        const profile = response.data.record || response.data;
        const canonical = Object.fromEntries(fields.filter(field => field.virtual).map(field => [field.key, profile[field.key] ?? '']));
        setValues(previous => ({ ...previous, ...canonical, customer_id: value }));
      }).catch(error => { if (sequence === profileSequence.current) setFailure(errorMessage(error)); });
    }
  };
  const save = async event => {
    event.preventDefault();
    if (busy) return;
    const body = {}; const invalid = {};
    fields.forEach(field => {
      const value = values[field.key];
      if (field.required && (value == null || value === '')) invalid[field.key] = `${field.label || label(field.key)} is required.`;
      try {
        body[field.key] = value === '' || value == null ? null : isPaise(field) ? amountPaise(value) : ['number', 'integer', 'percent'].includes(field.type) ? Number(value) : field.type === 'boolean' ? (value === true || value === 1 || value === '1' ? 1 : 0) : field.type === 'json' ? (typeof value === 'string' ? JSON.parse(value) : value) : value;
      } catch (error) { invalid[field.key] = error.message; }
    });
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    setBusy(true); setFailure(''); setCandidates([]);
    try {
      const target = endpoint || `${BASE}/${kind}`;
      const response = record?.id ? await api.patch(`${target}/${record.id}`, { ...body, version: record.version }) : await api.post(target, body);
      toast.success(record?.id ? 'Changes saved' : 'Record created');
      onSaved(response.data);
    } catch (error) {
      const result = error.response?.data || {};
      setFailure(errorMessage(error));
      const fieldErrors = result.fields || result.errors || {};
      setErrors(Array.isArray(fieldErrors) ? Object.fromEntries(fieldErrors.map(item => [item.field || item.key, item.message])) : fieldErrors);
      setCandidates(result.candidates || result.existing_candidates || result.matches || []);
    } finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title={`${record?.id ? 'Edit' : 'New'} ${def.label || label(kind)}`} xwide>
    <form onSubmit={save} className="space-y-4">
      {failure && <div role="alert" className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex gap-2"><FiAlertCircle className="shrink-0 mt-0.5" /><span>{failure}</span></div>}
      {candidates.length > 0 && <div className="rounded-lg bg-amber-50 border border-amber-200 p-3"><p className="font-semibold text-sm text-amber-900">Possible existing vendor found.</p><p className="text-xs text-amber-800 mt-1">Review the matching company, website, PAN and GST before creating another record.</p>{candidates.map((candidate, index) => <div key={candidate.id || index} className="mt-2 text-sm flex flex-wrap gap-2"><span>{recordLabel(candidate)} · {candidate.website || candidate.domain || candidate.website_url || '—'} · {candidate.pan || '—'} · {candidate.gst || candidate.gst_number || '—'}</span>{onOpenCandidate && candidate.id && <button type="button" className="text-blue-700 underline" onClick={() => onOpenCandidate(candidate)}>View existing</button>}</div>)}</div>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-4">
        {fields.map(field => <div key={field.key} className={['textarea', 'json'].includes(field.type) ? 'md:col-span-2' : ''}>
          <label htmlFor={`vt-${kind}-${field.key}`} className="label">{field.label || label(field.key)}{field.required && <span className="text-red-600"> *</span>}{isPaise(field) && <span className="text-slate-500"> (₹)</span>}</label>
          <Field field={field} value={values[field.key]} values={values} record={record} id={`vt-${kind}-${field.key}`} disabled={busy} onChange={value => update(field.key, value)} />
          {field.help && <p className="mt-1 text-xs text-slate-500">{field.help}</p>}
          {errors[field.key] && <p role="alert" className="text-xs text-red-700 mt-1">{String(errors[field.key])}</p>}
        </div>)}
      </div>
      {!fields.length && <p className="text-sm text-slate-500">Field configuration is unavailable. Refresh the module before creating a record.</p>}
      <div className="flex flex-col-reverse sm:flex-row justify-end gap-2 border-t pt-4"><button type="button" className="btn btn-secondary" disabled={busy} onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary" disabled={busy || !fields.length}>{busy ? 'Saving…' : submitLabel}</button></div>
    </form>
  </Modal>;
}

export function Field({ field, value, record = {}, id, disabled, onChange }) {
  if (field.lookup) return <RemoteSelect id={id} entity={field.lookup} value={value} onChange={onChange} selectedLabel={record[field.labelKey || field.key.replace(/_id$/, '_name')] || field.defaultLabel} required={field.required} disabled={disabled} label={field.label} />;
  if (field.options || field.type === 'select') return <select id={id} disabled={disabled} required={field.required} className="select" value={value ?? ''} onChange={event => onChange(event.target.value)}><option value="">Select…</option>{(field.options || []).map(item => { const option = choice(item); return <option key={option.value} value={option.value}>{option.label}</option>; })}</select>;
  if (field.type === 'boolean' && field.nullable) return <select id={id} disabled={disabled} className="select" value={value == null ? '' : value ? '1' : '0'} onChange={event => onChange(event.target.value === '' ? null : event.target.value === '1')}><option value="">Not confirmed</option><option value="1">Yes</option><option value="0">No</option></select>;
  if (field.type === 'boolean') return <label className="flex items-center gap-2 py-2 text-sm"><input id={id} type="checkbox" disabled={disabled} checked={value === true || value === 1 || value === '1'} onChange={event => onChange(event.target.checked)} />Yes</label>;
  if (['textarea', 'json'].includes(field.type)) return <textarea id={id} disabled={disabled} required={field.required} className="input min-h-24" value={typeof value === 'object' ? JSON.stringify(value, null, 2) : value ?? ''} onChange={event => onChange(event.target.value)} />;
  const number = ['number', 'integer', 'percent', 'money_paise', 'money'].includes(field.type);
  const type = number ? 'number' : field.type === 'datetime' ? 'datetime-local' : ['date', 'email', 'url', 'tel'].includes(field.type) ? field.type : 'text';
  let displayValue = type === 'date' ? String(value || '').slice(0, 10) : value ?? '';
  if (type === 'datetime-local' && value) {
    const string = String(value).replace(' ', 'T');
    const timestamp = /Z$|[+-]\d{2}:?\d{2}$/.test(string) ? Date.parse(string) : null;
    displayValue = timestamp != null && Number.isFinite(timestamp) ? new Date(timestamp + 19800000).toISOString().slice(0, 16) : string.slice(0, 16);
  }
  return <input id={id} disabled={disabled} required={field.required} type={type} className="input" value={displayValue} step={field.step || (field.type === 'integer' ? 1 : number ? '0.01' : undefined)} min={field.min} max={field.max} maxLength={field.maxLength} placeholder={field.placeholder} onChange={event => onChange(event.target.value)} />;
}

export function StatusForm({ kind, record, allowed, onClose, onSaved }) {
  const [status, setStatus] = useState(''); const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const save = async event => {
    event.preventDefault(); setBusy(true); setError('');
    try { await api.post(`${BASE}/${kind}/${record.id}/status`, { status, remarks, version: record.version }); toast.success('Status updated'); onSaved(); }
    catch (err) { setError(errorMessage(err)); }
    finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title="Change workflow status"><form onSubmit={save} className="space-y-4">
    <p className="text-sm flex gap-2 items-center">Current status <StatusBadge value={record.status} displayLabel={recordStatusLabel(kind, record)} /></p>
    {error && <p role="alert" className="bg-red-50 text-red-700 rounded p-3 text-sm">{error}</p>}
    <label className="block"><span className="label">Next status *</span><select className="select" required value={status} disabled={busy} onChange={event => setStatus(event.target.value)}><option value="">Select a permitted next stage…</option>{allowed.map(item => { const option = choice(item); return <option key={option.value} value={option.value}>{option.label}</option>; })}</select></label>
    <label className="block"><span className="label">Remarks *</span><textarea className="input min-h-24" value={remarks} required disabled={busy} onChange={event => setRemarks(event.target.value)} placeholder="Explain this status change" /></label>
    <div className="flex justify-end gap-2"><button type="button" disabled={busy} className="btn btn-secondary" onClick={onClose}>Cancel</button><button className="btn btn-primary" disabled={busy || !status}>{busy ? 'Updating…' : 'Update status'}</button></div>
  </form></Modal>;
}

export function DocumentsPanel({ kind, record, documents = [], options, canUpload, canReview, onSaved }) {
  const catalog = Array.isArray(options?.catalog) ? options.catalog : Object.values(options?.catalog || {}).flat();
  const docTypes = options?.document_types || catalog.filter(item => ['doc_type', 'document_type'].includes(item.kind) && item.active !== 0);
  const [uploading, setUploading] = useState(false); const [downloading, setDownloading] = useState(null);
  const [form, setForm] = useState({ purpose: 'invoice', expiry_date: '', remarks: '' }); const [file, setFile] = useState(null); const [error, setError] = useState('');
  const [selectedIds, setSelectedIds] = useState([]); const [uploadTypeIds, setUploadTypeIds] = useState([]);
  const [review, setReview] = useState(null); const [reviewBusy, setReviewBusy] = useState(false); const [reviewError, setReviewError] = useState('');
  const [today] = useState(() => new Date(Date.now() + 19800000).toISOString().slice(0, 10));
  const typeId = document => String(document.type_id ?? document.document_type_id ?? '');
  const statusOf = document => document.expiry_date && document.expiry_date < today && document.status !== 'rejected' ? 'expired' : document.status || 'uploaded';
  const ready = document => ['uploaded', 'verified'].includes(statusOf(document));
  const checklist = docTypes.map(type => {
    const versions = documents.filter(document => typeId(document) === String(type.id)).sort((a, b) => Number(b.id) - Number(a.id));
    // Submission accepts any unexpired uploaded/verified version. Match that
    // rule rather than hiding a valid file behind a newer rejected upload.
    return { ...type, required: !!Number(type.required), current: versions.find(ready) || versions[0] };
  });
  const requiredRows = checklist.filter(type => type.required);
  const requiredReady = requiredRows.filter(type => type.current && ready(type.current)).length;
  const selectedTypes = docTypes.filter(type => selectedIds.includes(String(type.id)));
  const uploadTypes = docTypes.filter(type => uploadTypeIds.includes(String(type.id)));
  const uploadTitle = uploadTypes.length === 1 ? `Upload ${uploadTypes[0].label}` : `Upload one file for ${uploadTypes.length} document types`;
  const startUpload = types => {
    setFile(null); setError(''); setForm({ purpose: 'invoice', expiry_date: '', remarks: '' });
    setUploadTypeIds((Array.isArray(types) ? types : [types]).map(type => String(type.id)));
  };
  const closeUpload = () => { if (!uploading) { setFile(null); setError(''); setUploadTypeIds([]); } };
  const saveReview = async event => {
    event.preventDefault(); setReviewBusy(true); setReviewError('');
    try { await api.patch(`${BASE}/documents/${kind === 'invoices' ? 'invoice-' : ''}${review.id}`, { status: review.status, remarks: review.remarks, version: review.version }); toast.success('Document review saved'); setReview(null); onSaved(); }
    catch (err) { setReviewError(errorMessage(err)); } finally { setReviewBusy(false); }
  };
  const download = async document => {
    setDownloading(document.id);
    try { const response = await api.get(document.download_url || `${BASE}/documents/${kind === 'invoices' ? 'invoice-' : ''}${document.id}/download`, { responseType: 'blob' }); downloadBlob(response.data, contentFilename(response, document.filename || document.file_name || 'document')); }
    catch (err) { toast.error(errorMessage(err)); } finally { setDownloading(null); }
  };
  const upload = async event => {
    event.preventDefault(); if (!file || uploading || (kind === 'registrations' && !uploadTypes.length)) return;
    const uploadForm = event.currentTarget;
    setUploading(true); setError('');
    const data = new FormData(); data.append('file', file);
    Object.entries(form).forEach(([key, value]) => { if (value !== '') data.append(key, value); });
    if (kind === 'registrations') {
      if (uploadTypes.length === 1) data.append('type_id', uploadTypes[0].id);
      else data.append('type_ids', JSON.stringify(uploadTypes.map(type => type.id)));
    }
    data.append('version', record.version ?? 0);
    try { await api.post(`${BASE}/${kind}/${record.id}/documents`, data); toast.success(uploadTypes.length > 1 ? `File uploaded for ${uploadTypes.length} document types` : 'Document uploaded'); uploadForm.reset(); setFile(null); setForm({ purpose: 'invoice', expiry_date: '', remarks: '' }); setSelectedIds(ids => ids.filter(id => !uploadTypeIds.includes(id))); setUploadTypeIds([]); onSaved(); }
    catch (err) { setError(errorMessage(err)); } finally { setUploading(false); }
  };
  const documentDetails = (document, showTitle = true) => <div className="rounded-lg bg-slate-50 p-3 text-sm" key={document.id}>
    <div className="flex flex-wrap gap-2 items-center"><span className="font-medium flex-1 min-w-0 break-words">{showTitle ? document.type_label || document.document_type || label(document.purpose) || document.filename : document.filename || document.file_name}</span><StatusBadge value={statusOf(document)} /><button type="button" className="btn btn-secondary text-xs inline-flex items-center gap-1" disabled={downloading === document.id} onClick={() => download(document)}><FiDownload />{downloading === document.id ? 'Downloading…' : 'Download'}</button>{kind === 'registrations' && canUpload && docTypes.some(type => String(type.id) === typeId(document)) && <button type="button" className="btn btn-secondary text-xs" disabled={uploading} onClick={() => startUpload(docTypes.find(type => String(type.id) === typeId(document)))}>Upload new file</button>}{canReview && <button type="button" className="btn btn-secondary text-xs" onClick={() => { setReviewError(''); setReview({ ...document, status: document.status || 'uploaded', remarks: document.remarks || '' }); }}>Review</button>}</div>
    {showTitle && <p className="text-xs text-slate-500 mt-2 break-all">{document.filename || document.file_name}</p>}<div className="flex flex-wrap gap-x-5 gap-y-1 mt-2 text-xs text-slate-500"><div>Uploaded: <Value fieldKey="uploaded_at" value={document.uploaded_at || document.created_at} /></div>{document.expiry_date && <div>Expiry: <Value field={{ type: 'date' }} value={document.expiry_date} /></div>}</div>{document.remarks && <p className="text-xs mt-2 whitespace-pre-wrap break-words">{document.remarks}</p>}
  </div>;
  const uploadFields = () => <form key={uploadTypeIds.join(',') || 'invoice'} aria-label={kind === 'registrations' ? uploadTitle : 'Upload invoice document'} onSubmit={upload} className="bg-blue-50/50 border border-blue-100 rounded-xl p-3 space-y-3">
      {kind === 'registrations' && <div className="space-y-2"><p className="text-sm text-slate-600">{record.company_name || 'This company'}</p><ul aria-label="Selected document types" className="flex flex-wrap gap-2">{uploadTypes.map(type => <li key={type.id} className="rounded-lg bg-blue-100 px-2 py-1 text-xs text-blue-900">{type.label}{Number(type.required) ? ' *' : ''}</li>)}</ul>{uploadTypes.length > 1 && <p className="text-xs text-slate-500">Upload a combined file containing these documents. The same file, expiry date and remarks will apply to every selected type.</p>}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {kind === 'invoices' && <label><span className="label">Purpose *</span><select className="select" required disabled={uploading} value={form.purpose} onChange={event => setForm(v => ({ ...v, purpose: event.target.value }))}><option value="invoice">Invoice PDF</option><option value="proof">Completion / delivery proof</option></select></label>}
        <label><span className="label">Expiry date (if applicable)</span><input type="date" className="input" disabled={uploading} value={form.expiry_date} onChange={event => setForm(v => ({ ...v, expiry_date: event.target.value }))} /></label>
        <label className="sm:col-span-2"><span className="label">File *</span><input type="file" required disabled={uploading} accept={kind === 'invoices' && form.purpose === 'invoice' ? '.pdf' : '.pdf,.jpg,.jpeg,.png'} className="input" onChange={event => setFile(event.target.files?.[0] || null)} /><span className="text-xs text-slate-500 mt-1 block">{kind === 'invoices' && form.purpose === 'invoice' ? 'PDF' : 'PDF, JPG or PNG'} · up to 10 MB</span></label>
        <label className="sm:col-span-2"><span className="label">Remarks (optional)</span><textarea className="input" disabled={uploading} rows={2} value={form.remarks} onChange={event => setForm(v => ({ ...v, remarks: event.target.value }))} /></label>
      </div>{error && <p role="alert" className="text-sm text-red-700">{error}</p>}<div className="flex flex-wrap justify-end gap-2">{kind === 'registrations' && <button type="button" className="btn btn-secondary" disabled={uploading} onClick={closeUpload}>Cancel</button>}<button type="submit" className="btn btn-primary inline-flex items-center gap-2" disabled={uploading || !file}><FiUpload />{uploading ? 'Uploading…' : uploadTypes.length > 1 ? `Save for ${uploadTypes.length} document types` : uploadTypes.length ? `Save ${uploadTypes[0].label}` : 'Upload document'}</button></div>
    </form>;
  return <section className="space-y-3">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="font-semibold text-slate-800">Documents &amp; checklist</h4>{kind === 'registrations' && <p className="text-xs text-slate-500 mt-1">{canUpload ? 'Click Docs pending to upload that document. ' : ''}Items marked * are required.</p>}</div>{kind === 'registrations' && requiredRows.length > 0 && <span className={'rounded-lg px-3 py-2 text-xs font-semibold ' + (requiredReady === requiredRows.length ? 'bg-green-50 text-green-800' : 'bg-amber-50 text-amber-800')}>{requiredReady} / {requiredRows.length} required documents ready</span>}</div>
    {kind === 'registrations' ? <>
      {canUpload && checklist.length > 0 && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 p-3"><p className="text-xs text-slate-600">Select document types to upload one combined file.</p><div className="flex items-center gap-2">{selectedTypes.length > 0 && <button type="button" className="text-xs text-slate-500 hover:text-slate-800" disabled={uploading} onClick={() => setSelectedIds([])}>Clear selection</button>}<button type="button" className="btn btn-primary text-xs inline-flex items-center gap-1" disabled={uploading || !selectedTypes.length} onClick={() => startUpload(selectedTypes)}><FiUpload />Upload one file{selectedTypes.length ? ` (${selectedTypes.length})` : ''}</button></div></div>}
      <ul aria-label="Company document checklist" className="grid grid-cols-1 sm:grid-cols-2 gap-2">{checklist.map(type => {
        const status = type.current ? statusOf(type.current) : 'docs_pending';
        const needsUpload = !type.current || !ready(type.current);
        const checked = selectedIds.includes(String(type.id));
        return <li key={type.id} className={'border rounded-lg p-2.5 text-xs flex items-center gap-2 ' + (checked ? 'border-blue-300 bg-blue-50' : '')}><label className="flex flex-1 min-w-0 items-center gap-2 break-words">{canUpload && <input type="checkbox" className="shrink-0 accent-blue-700" aria-label={`Select ${type.label}`} checked={checked} disabled={uploading} onChange={event => setSelectedIds(ids => event.target.checked ? [...ids, String(type.id)] : ids.filter(id => id !== String(type.id)))} />}<span>{type.label}{type.required ? ' *' : ''}</span></label>{canUpload && needsUpload ? <button type="button" aria-label={`Upload ${type.label} — ${label(status)}`} title={`Upload ${type.label}`} className="shrink-0 rounded-full hover:ring-2 hover:ring-amber-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500" disabled={uploading} onClick={() => startUpload(type)}><StatusBadge value={status} /></button> : <StatusBadge value={status} />}</li>;
      })}</ul>
      {!checklist.length && <p className="text-sm text-slate-500">No document types are configured for this checklist.</p>}
      <div className="space-y-2">{documents.map(document => documentDetails(document))}</div>
      {canUpload && uploadTypes.length > 0 && <Modal isOpen title={uploadTitle} onClose={closeUpload}>{uploadFields()}</Modal>}
    </> : <>
      <div className="space-y-2">{documents.map(document => documentDetails(document))}</div>
      {!documents.length && <p className="text-sm text-slate-500">No documents uploaded yet.</p>}
      {canUpload && uploadFields()}
    </>}
    {review && <Modal isOpen onClose={() => { if (!reviewBusy) setReview(null); }} title="Review document"><form onSubmit={saveReview} className="space-y-4"><p className="text-sm break-all">{review.filename || review.file_name}</p>{reviewError && <p role="alert" className="text-sm text-red-700">{reviewError}</p>}<label className="block"><span className="label">Status</span><select className="select" value={review.status} disabled={reviewBusy} onChange={event => setReview(v => ({ ...v, status: event.target.value }))}>{(options.document_statuses || ['uploaded', 'pending', 'verified', 'rejected', 'expired']).map(status => <option key={status} value={status}>{label(status)}</option>)}</select></label><label className="block"><span className="label">Remarks *</span><textarea className="input min-h-24" required value={review.remarks} disabled={reviewBusy} onChange={event => setReview(v => ({ ...v, remarks: event.target.value }))} /></label><div className="flex justify-end gap-2"><button type="button" disabled={reviewBusy} className="btn btn-secondary" onClick={() => setReview(null)}>Cancel</button><button className="btn btn-primary" disabled={reviewBusy}>{reviewBusy ? 'Saving…' : 'Save review'}</button></div></form></Modal>}
  </section>;
}

function historyStatusLabel(entry, before = false) {
  if (entry.entity_type !== 'invoices' || entry[before ? 'old_status' : 'new_status'] !== 'uploaded') return undefined;
  let snapshot = entry[before ? 'before_json' : 'after_json'];
  if (typeof snapshot === 'string') { try { snapshot = JSON.parse(snapshot); } catch { return undefined; } }
  return snapshot ? recordStatusLabel('invoices', snapshot) : undefined;
}

export function History({ rows = [] }) {
  return <section className="space-y-3"><h4 className="font-semibold text-slate-800">History & workflow timeline</h4>{rows.length === 0 ? <p className="text-sm text-slate-500">No history recorded.</p> : <ol className="border-l-2 border-blue-100 ml-2 space-y-4">{rows.map((entry, index) => <li key={entry.id || index} className="relative pl-5"><span className="absolute -left-[6px] top-1.5 w-2.5 h-2.5 rounded-full bg-blue-600" /><div className="text-sm font-medium">{entry.new_status ? <><span className="text-slate-500">{historyStatusLabel(entry, true) || label(entry.old_status || 'Created')}</span><span className="mx-2">→</span><StatusBadge value={entry.new_status} displayLabel={historyStatusLabel(entry)} /></> : label(entry.event || entry.action || 'Updated')}</div><p className="text-xs text-slate-500 mt-1">{entry.actor_name || entry.changed_by_name || `User #${entry.actor_id || entry.changed_by || '—'}`} · <Value fieldKey="changed_at" value={entry.changed_at || entry.created_at} /></p>{entry.remarks && <p className="text-sm mt-1 whitespace-pre-wrap">{entry.remarks}</p>}{(entry.before_json || entry.after_json) && <details className="text-xs mt-2"><summary className="text-blue-700 cursor-pointer">View recorded changes</summary><div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-2">{['before_json', 'after_json'].map(key => entry[key] && <div key={key}><b>{key === 'before_json' ? 'Before' : 'After'}</b><pre className="whitespace-pre-wrap break-all bg-slate-50 p-2 rounded max-h-44 overflow-y-auto">{typeof entry[key] === 'string' ? entry[key] : JSON.stringify(entry[key], null, 2)}</pre></div>)}</div></details>}</li>)}</ol>}</section>;
}
