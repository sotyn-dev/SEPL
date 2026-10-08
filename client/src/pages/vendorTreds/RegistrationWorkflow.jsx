import SerialNumber from '../../components/SerialNumber';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { FiArrowRight, FiCheck, FiExternalLink, FiPlus, FiRefreshCw } from 'react-icons/fi';
import toast from 'react-hot-toast';
import api from '../../api';
import Modal from '../../components/Modal';
import { useAuth } from '../../context/AuthContext';
import { LoadState, RemoteSelect, StatusBadge, Value } from '../../components/vendorTreds/Common';
import { DocumentsPanel, EntityForm, History } from '../../components/vendorTreds/Forms';
import { ServerPager } from '../../components/vendorTreds/Records';
import { useDebounced, useRemote } from '../../components/vendorTreds/hooks';
import { BASE, definition, errorMessage, fieldsFor } from '../../components/vendorTreds/model';

const STAGES = [
  { id: 'basics', number: 1, title: 'Basic Information', hint: 'All company entries', description: 'Every company stays here. View or edit its basic details at any stage.' },
  { id: 'documents', number: 2, title: 'Submit Documents', hint: 'Upload and submit the checklist', description: 'Upload the required documents, then mark them submitted to the company.' },
  { id: 'accepted', number: 3, title: 'Accepted / Portal Open', hint: 'Record portal acceptance', description: 'Companies with submitted documents. Record acceptance here; accepted companies remain visible.' },
  { id: 'enquiries', number: 4, title: 'Enquiry Received', hint: 'Record the requirement / RFQ', description: 'Companies with portal acceptance. Record an enquiry when it arrives and view earlier enquiries here.' },
];
const today = () => new Date(Date.now() + 19800000).toISOString().slice(0, 10);
const portalAccepted = r => ['approved', 'enquiry_received', 'quote_sent', 'po_received'].includes(r.status);
const hasEnquiry = r => Number(r.enquiry_count) > 0 || ['enquiry_received', 'quote_sent', 'po_received'].includes(r.status);
const stageOf = r => portalAccepted(r) ? 4 : r.status === 'submitted' ? 3 : 2;
const availableStageOf = r => Number(r.available_stage) || (portalAccepted(r) ? 4 : r.submitted_at || r.status === 'submitted' ? 3 : 2);
const stageText = r => r.status === 'submitted' ? 'Submitted · awaiting acceptance' : ['started', 'docs_pending', 'not_started'].includes(r.status) ? 'Documents pending' : r.status === 'approved' ? 'Portal accepted' : hasEnquiry(r) ? 'Enquiry received' : r.status.replaceAll('_', ' ');
const stepDone = (r, step) => step === 1 || (step === 2 ? !!r.submitted_at || portalAccepted(r) : step === 3 ? portalAccepted(r) : hasEnquiry(r));
const stepText = (r, step) => step === 1 ? 'Basic details saved' : r.status === 'rejected' ? 'Registration rejected' : step === 2 ? (r.status === 'docs_pending' ? 'Documents need resubmission' : stepDone(r, 2) ? 'Documents submitted' : 'Documents pending') : step === 3 ? (portalAccepted(r) ? 'Portal accepted' : r.status === 'submitted' ? 'Awaiting acceptance' : 'Complete documents first') : hasEnquiry(r) ? 'Enquiry received' : portalAccepted(r) ? 'Awaiting enquiry' : 'Portal acceptance required';
const stepAction = (r, step) => step === 1 ? 'View / Edit basic details' : step === 2 ? (stepDone(r, 2) && r.status !== 'docs_pending' ? 'View documents' : 'Upload / Submit documents') : step === 3 ? (portalAccepted(r) ? 'View portal details' : 'Record acceptance') : hasEnquiry(r) ? 'View / Add enquiry' : 'Record enquiry';
const BASIC_FIELDS = ['customer_id', 'company_name', 'contact_person', 'phone', 'email', 'city', 'address', 'website_url', 'owner_id', 'registration_date'];
function basicDefinition(options, user) {
  const def = definition(options, 'registrations');
  return { ...def, label: 'Basic Information', fields: BASIC_FIELDS.map(key => fieldsFor(def).find(f => f.key === key)).filter(Boolean).map(f => ({
    ...f, label: f.key === 'customer_id' ? 'Existing company (optional)' : f.key === 'owner_id' ? 'Responsible person' : f.label,
    default: f.key === 'owner_id' ? user.id : f.key === 'registration_date' ? today() : f.default,
    defaultLabel: f.key === 'owner_id' ? user.name : undefined,
  })) };
}

export default function RegistrationWorkflow() {
  const { user, canView, canCreate, canEdit } = useAuth();
  const [params, setParams] = useSearchParams();
  const [revision, setRevision] = useState(0);
  const [creating, setCreating] = useState(false);
  const active = STAGES.find(s => s.id === params.get('tab')) || STAGES[params.get('tab') === 'approvals' ? 2 : 0];
  const allowed = canView('vendor_registrations');
  const { data: options, error: optionError, loading: optionLoading } = useRemote(allowed ? BASE + '/options' : null);
  const search = useDebounced(params.get('search') || '');
  const page = Math.max(1, Number(params.get('page')) || 1);
  const limit = [15, 25, 50, 100].includes(Number(params.get('limit'))) ? Number(params.get('limit')) : 25;
  const { data, error, loading } = useRemote(allowed ? BASE + '/registration-stages' : null, { workflow_stage: active.number, search, owner_id: params.get('owner_id') || '', page, limit }, revision);
  const refresh = () => setRevision(v => v + 1);
  const change = patch => {
    const next = new URLSearchParams(params);
    Object.entries(patch).forEach(([key, value]) => value ? next.set(key, value) : next.delete(key));
    setParams(next, { replace: true });
  };
  const selectStage = s => setParams({ tab: s.id, ...(params.get('search') ? { search: params.get('search') } : {}), ...(params.get('owner_id') ? { owner_id: params.get('owner_id') } : {}) });
  const goToRecord = (r, step = stageOf(r)) => { refresh(); setParams({ tab: STAGES[step - 1].id, record: r.id }); };
  return <div className="space-y-5 min-w-0">
    <header className="flex flex-wrap justify-between items-start gap-3">
      <div><h2 className="text-xl font-bold text-slate-800">Vendor &amp; TReDS Management</h2><p className="text-sm text-slate-500 mt-1">One company record, from basic details to the first enquiry.</p></div>
      {allowed && canCreate('vendor_registrations') && <button className="btn btn-primary inline-flex items-center gap-2" onClick={() => setCreating(true)}><FiPlus /> Add Company</button>}
    </header>
    <nav aria-label="Vendor registration stages" className="grid grid-cols-2 xl:grid-cols-4 gap-3">
      {STAGES.map(s => <button type="button" key={s.id} aria-current={active.id === s.id ? 'step' : undefined} onClick={() => selectStage(s)} className={'relative rounded-xl border p-3 sm:p-4 text-left flex flex-col sm:flex-row items-start gap-2 sm:gap-3 ' + (active.id === s.id ? 'bg-blue-700 border-blue-700 text-white shadow-sm' : 'bg-white border-slate-200 text-slate-700 hover:border-blue-400')}>
        <span className={'rounded-full w-8 h-8 shrink-0 flex items-center justify-center font-semibold ' + (active.id === s.id ? 'bg-white/20' : 'bg-blue-50 text-blue-700')}>{s.number}</span>
        <span className="min-w-0 flex-1"><span className="font-semibold text-sm block">{s.title}</span><span className={'hidden md:block text-xs mt-1 ' + (active.id === s.id ? 'text-blue-100' : 'text-slate-500')}>{s.hint}</span></span>
        <span className={'absolute top-3 right-3 sm:static rounded-full px-2 py-0.5 text-xs tabular-nums ' + (active.id === s.id ? 'bg-white/20' : 'bg-slate-100')}>{data?.counts?.[s.number] ?? '—'}</span>
      </button>)}
    </nav>
    {!allowed ? <div className="card p-6 text-sm text-slate-600">Vendor Registration access is required to use these stages. Contact your administrator.</div> : <>
      <LoadState loading={optionLoading} error={optionError} onRetry={() => window.location.reload()} />
      <section className="card p-4 space-y-4">
        <div className="flex flex-wrap items-start gap-3"><div className="flex-1"><h3 className="font-semibold text-slate-800">Stage {active.number} · {active.title}</h3><p className="text-sm text-slate-500 mt-1">{active.description}</p></div><button className="btn btn-secondary inline-flex items-center gap-2" onClick={refresh}><FiRefreshCw /> Refresh</button></div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3"><label><span className="label">Search company</span><input className="input" value={params.get('search') || ''} placeholder="Company name or portal…" onChange={e => change({ search: e.target.value, page: '' })} /></label><label><span className="label">Responsible person</span><RemoteSelect entity="users" label="Responsible person filter" value={params.get('owner_id')} onChange={v => change({ owner_id: v, page: '' })} /></label></div>
      </section>
      <LoadState loading={loading} error={error} onRetry={refresh} />
      {!loading && !error && data && <>
        {!data.rows.length ? <section className="card px-5 py-12 text-center"><div className="mx-auto rounded-full w-12 h-12 bg-blue-50 text-blue-700 flex items-center justify-center font-bold text-lg">{active.number}</div><h4 className="font-semibold mt-4 text-slate-800">No companies in {active.title.toLowerCase()}</h4><p className="text-sm text-slate-500 mt-2">{active.number === 1 ? 'Start with the company’s basic details. Documents come in Stage 2.' : 'Companies appear here as you complete the previous stage.'}</p>{active.number === 1 && canCreate('vendor_registrations') && <button className="btn btn-primary mt-5" onClick={() => setCreating(true)}>Add Company</button>}</section> : <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">{data.rows.map((row, index) => <article key={row.id} className="card p-4 space-y-4">
          <div className="flex items-start gap-3"><SerialNumber value={(page - 1) * limit + index + 1} /><div className="flex-1 min-w-0"><h4 className="font-semibold text-slate-800 break-words">{row.company_name}</h4><p className="text-xs text-slate-500 mt-1">Registration #{row.id} · {row.owner_name}</p></div><StatusBadge value={active.number === 1 || stepDone(row, active.number) && row.status !== 'rejected' && row.status !== 'docs_pending' ? 'verified' : row.status === 'rejected' ? 'rejected' : 'pending'} displayLabel={stepText(row, active.number)} /></div>
          <dl className="grid grid-cols-2 gap-3 text-sm"><div><dt className="text-xs text-slate-500">Added on</dt><dd className="mt-1"><Value value={row.registration_date} field={{ type: 'date' }} /></dd></div><div><dt className="text-xs text-slate-500">{active.number === 4 ? 'Enquiries' : active.number === 3 ? 'Accepted on' : 'Documents submitted'}</dt><dd className="mt-1"><Value value={active.number === 4 ? row.enquiry_count : active.number === 3 ? row.accepted_date : row.submitted_at} field={{ type: active.number === 4 ? 'number' : active.number === 3 ? 'date' : 'datetime' }} /></dd></div></dl>
          <div className="border-t pt-3 flex flex-wrap items-center justify-between gap-2">{row.portal_url && <a href={row.portal_url} target="_blank" rel="noreferrer" className="text-blue-700 text-xs inline-flex items-center gap-1">Open vendor portal <FiExternalLink /></a>}<button className="btn btn-primary ml-auto inline-flex items-center gap-2" onClick={() => change({ record: row.id })}>{stepAction(row, active.number)}<FiArrowRight /></button></div>
        </article>)}</div>}
        <ServerPager page={page} limit={limit} total={data.total} onChange={change} />
      </>}
      {creating && options && <EntityForm kind="registrations" def={basicDefinition(options, user)} submitLabel="Save basic details" onClose={() => setCreating(false)} onSaved={r => { setCreating(false); goToRecord(r, 1); }} />}
      {params.get('record') && options && <RegistrationDetail key={`${params.get('record')}-${active.number}`} id={params.get('record')} initialPanel={active.number} options={options} revision={revision} onRefresh={refresh} onClose={() => change({ record: '' })} onAdvance={goToRecord} editable={canEdit('vendor_registrations')} user={user} />}
    </>}
  </div>;
}

function RegistrationDetail({ id, initialPanel, options, revision, onRefresh, onClose, onAdvance, editable, user }) {
  const { canView, canCreate, canApprove } = useAuth();
  const { data, loading, error } = useRemote(BASE + '/registrations/' + id, {}, revision);
  const [editing, setEditing] = useState(false);
  const [panel, setPanel] = useState(initialPanel);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState('');
  const r = data?.record;
  const maxPanel = r ? availableStageOf(r) : 1;
  const visible = Math.min(panel || 1, maxPanel);
  const canAccept = editable && canCreate('vendor_approvals') && canApprove('vendor_approvals');
  const canEnquire = editable && canCreate('vendor_enquiries');
  const advance = async (action, fields = {}) => {
    if (busy) return;
    setBusy(true); setFailure('');
    try {
      const response = await api.post(BASE + '/registrations/' + id + '/stage', { action, version: r.version, ...fields });
      setPanel(stageOf(response.data)); toast.success(action === 'accept_portal' ? 'Portal acceptance recorded' : action === 'record_enquiry' ? 'Enquiry recorded' : 'Stage updated'); onAdvance(response.data);
    } catch (err) { setFailure(errorMessage(err)); } finally { setBusy(false); }
  };
  return <Modal isOpen xwide title={r?.company_name || 'Vendor Registration'} onClose={() => { if (!busy) onClose(); }}>
    <LoadState loading={loading} error={error} onRetry={onRefresh} />
    {!loading && !error && r && <div className="space-y-5">
      <div className="flex flex-wrap gap-2 items-center"><StatusBadge value={r.status} displayLabel={stageText(r)} /><span className="text-xs text-slate-500">Registration #{r.id} · One record through all four stages</span></div>
      <nav aria-label="Company registration steps" className="grid grid-cols-2 md:grid-cols-4 gap-2">{STAGES.map(s => <button type="button" key={s.id} disabled={busy || s.number > maxPanel} onClick={() => { setPanel(s.number); setFailure(''); }} className={'border rounded-lg p-3 text-xs text-left disabled:opacity-40 ' + (visible === s.number ? 'bg-blue-50 border-blue-400 text-blue-800' : 'border-slate-200')}><span className="font-semibold block">{stepDone(r, s.number) ? <FiCheck className="inline mr-1" /> : s.number + '. '}{s.title}</span></button>)}</nav>
      {failure && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{failure}</p>}
      {visible === 1 && <section className="space-y-4"><dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">{basicDefinition(options, user).fields.filter(f => f.key !== 'customer_id').map(f => <div key={f.key}><dt className="text-xs text-slate-500">{f.label}</dt><dd className="text-sm mt-1 break-words"><Value field={f} value={f.key === 'owner_id' ? r.owner_name || '#' + r.owner_id : r[f.key]} /></dd></div>)}</dl><div className="flex flex-wrap justify-end gap-2">{editable && <button className="btn btn-secondary" onClick={() => setEditing(true)}>Edit basic details</button>}<button className="btn btn-primary" disabled={busy} onClick={() => setPanel(2)}>Continue to documents →</button></div></section>}
      {visible === 2 && <section className="space-y-4"><DocumentsPanel kind="registrations" record={r} documents={data.documents || []} options={{ ...options, document_types: data.document_types || options.document_types }} canUpload={editable} canReview={canApprove('vendor_registrations')} onSaved={() => { setFailure(''); onRefresh(); }} />{r.submitted_at && <div className="bg-green-50 text-green-800 p-3 rounded-lg text-sm">Documents submitted on <Value value={r.submitted_at} field={{ type: 'datetime' }} />.</div>}<div className="flex flex-wrap justify-end gap-2">{editable && ['not_started', 'started', 'docs_pending'].includes(r.status) && <button className="btn btn-primary" disabled={busy} onClick={() => advance('submit_documents')}>{busy ? 'Submitting…' : 'Submit documents'}</button>}{editable && ['rejected', 'invite_only'].includes(r.status) && <button className="btn btn-primary" disabled={busy} onClick={() => advance('start_documents')}>Resume document submission</button>}{maxPanel >= 3 && <button className="btn btn-secondary" onClick={() => setPanel(3)}>Continue to acceptance →</button>}</div></section>}
      {visible === 3 && <section className="space-y-4">{portalAccepted(r) ? <><div className="bg-green-50 border border-green-200 rounded-xl p-4"><h4 className="font-semibold text-green-900">Vendor registration accepted</h4>{r.accepted_date && <p className="text-sm text-green-800 mt-1">Accepted on <Value value={r.accepted_date} field={{ type: 'date' }} /></p>}{r.portal_url && <a className="inline-flex items-center gap-2 mt-3 text-blue-700 text-sm break-all" href={r.portal_url} target="_blank" rel="noreferrer">Open vendor portal <FiExternalLink /></a>}{r.portal_login_id && <p className="text-xs mt-2">Portal login ID: {r.portal_login_id}</p>}</div><div className="flex justify-end"><button className="btn btn-primary" onClick={() => setPanel(4)}>Continue to enquiries →</button></div></> : r.status !== 'submitted' ? <div className="rounded-lg bg-amber-50 p-4 space-y-3"><p className="text-sm text-amber-900">Complete document submission before recording portal acceptance.</p><button className="btn btn-secondary" onClick={() => setPanel(2)}>View documents</button></div> : canAccept ? <PortalForm record={r} busy={busy} onSave={f => advance('accept_portal', f)} /> : <p className="text-sm text-slate-500">An authorized approver must confirm acceptance and portal access.</p>}</section>}
      {visible === 4 && <section className="space-y-4">{canView('vendor_enquiries') && hasEnquiry(r) && <EnquiryHistory id={id} revision={revision} />}{!canView('vendor_enquiries') && hasEnquiry(r) && <p className="text-sm text-slate-500">Enquiry view access is required to view enquiry details.</p>}{!portalAccepted(r) ? <p className="rounded-lg bg-amber-50 p-4 text-sm text-amber-900">Portal acceptance must be active before adding an enquiry. Earlier records remain available here.</p> : canEnquire ? hasEnquiry(r) ? <details className="border rounded-xl p-4"><summary className="cursor-pointer text-blue-700 font-medium text-sm">Add another enquiry</summary><div className="mt-4"><EnquiryForm busy={busy} onSave={f => advance('record_enquiry', f)} /></div></details> : <><p className="text-sm text-slate-500">Portal acceptance is complete. Record the first enquiry when it arrives.</p><EnquiryForm busy={busy} onSave={f => advance('record_enquiry', f)} /></> : <p className="text-sm text-slate-500">Enquiry create and registration edit access are required to record an enquiry.</p>}</section>}
      <details className="border-t pt-4"><summary className="cursor-pointer text-sm text-slate-500">Activity history</summary><div className="mt-4"><History rows={data.history || []} /></div></details>
      {editing && <EntityForm kind="registrations" def={basicDefinition(options, user)} record={r} onClose={() => setEditing(false)} onSaved={() => { setEditing(false); onRefresh(); }} />}
    </div>}
  </Modal>;
}

function PortalForm({ record, busy, onSave }) {
  const [form, setForm] = useState({ portal_url: record.portal_url || '', portal_login_id: record.portal_login_id || '', vendor_code: '', approval_date: today(), remarks: '' });
  const field = (key, title, type = 'text', required = false) => <label><span className="label">{title}{required ? ' *' : ''}</span><input className="input" type={type} required={required} disabled={busy} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} /></label>;
  return <form onSubmit={e => { e.preventDefault(); onSave(form); }} className="space-y-4"><div><h4 className="font-semibold">Confirm acceptance &amp; portal access</h4><p className="text-sm text-slate-500 mt-1">Use this after the company accepts your registration and opens vendor portal access.</p></div><div className="grid grid-cols-1 sm:grid-cols-2 gap-4">{field('portal_url', 'Vendor portal URL', 'url', true)}{field('approval_date', 'Accepted on', 'date', true)}{field('portal_login_id', 'Portal login ID (optional)')}{field('vendor_code', 'Vendor code (if issued)')}<label className="sm:col-span-2"><span className="label">Remarks</span><textarea className="input" disabled={busy} value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} /></label></div><p className="text-xs text-slate-500">Do not enter a portal password.</p><div className="flex justify-end"><button disabled={busy} className="btn btn-primary">{busy ? 'Saving…' : 'Confirm accepted / portal open'}</button></div></form>;
}

function EnquiryForm({ busy, onSave }) {
  const [form, setForm] = useState({ enquiry_date: today(), rfq_number: '', product_service: '', due_date: '', remarks: '' });
  return <form className="space-y-4" onSubmit={e => { e.preventDefault(); onSave(form); }}><h4 className="font-semibold text-slate-800">Record enquiry received</h4><div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><label><span className="label">Received on *</span><input className="input" type="date" required disabled={busy} value={form.enquiry_date} onChange={e => setForm({ ...form, enquiry_date: e.target.value })} /></label><label><span className="label">Enquiry / RFQ number</span><input className="input" disabled={busy} value={form.rfq_number} onChange={e => setForm({ ...form, rfq_number: e.target.value })} /></label><label className="sm:col-span-2"><span className="label">Requirement / Product / Service *</span><textarea className="input min-h-24" required disabled={busy} value={form.product_service} onChange={e => setForm({ ...form, product_service: e.target.value })} /></label><label><span className="label">Response due date</span><input className="input" type="date" disabled={busy} value={form.due_date} onChange={e => setForm({ ...form, due_date: e.target.value })} /></label><label><span className="label">Remarks</span><input className="input" disabled={busy} value={form.remarks} onChange={e => setForm({ ...form, remarks: e.target.value })} /></label></div><div className="flex justify-end"><button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : 'Save enquiry received'}</button></div></form>;
}

function EnquiryHistory({ id, revision }) {
  const [page, setPage] = useState(1);
  const [limit, setLimit] = useState(15);
  const { data, loading, error } = useRemote(BASE + '/enquiries', { registration_id: id, page, limit }, revision);
  return <div className="space-y-3"><h4 className="font-semibold">Received enquiries</h4><LoadState loading={loading} error={error} />{data?.rows.map((r, index) => <article key={r.id} className="border rounded-xl p-4 space-y-2"><SerialNumber value={(page - 1) * limit + index + 1} /><div className="flex flex-wrap justify-between gap-2"><h5 className="font-medium">{r.rfq_number || 'Enquiry #' + r.id}</h5><span className="text-xs text-slate-500"><Value value={r.enquiry_date} field={{ type: 'date' }} /></span></div><p className="text-sm whitespace-pre-wrap">{r.product_service}</p>{r.due_date && <p className="text-xs text-slate-500">Response due: <Value value={r.due_date} field={{ type: 'date' }} /></p>}{r.remarks && <p className="text-sm text-slate-500">{r.remarks}</p>}</article>)}{data?.total === 0 && <p className="text-sm text-slate-500">No enquiries visible in your assigned scope.</p>}<ServerPager page={page} limit={limit} total={data?.total || 0} onChange={next => { setPage(next.page); if (next.limit) setLimit(next.limit); }} /></div>;
}
