import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import toast from 'react-hot-toast';
import api from '../api';
import { useAuth } from '../context/AuthContext';
import Modal from './Modal';
import ProofPreview from './ProofPreview';
import { workGroup, workGroups } from '../utils/dashboardWorkGroups.mjs';

const statusLabel = { open:'Open', in_progress:'In progress', submitted:'Proof submitted — awaiting your review', rejected:'Changes requested', resolved:'Closed', closed:'Closed' };
const done = t => ['resolved', 'closed', 'approved'].includes(t.status);
const button = 'btn btn-secondary text-xs';

export function TicketAction({ action, onClose, onSaved }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploaded, setUploaded] = useState('');
  const { ticket, kind } = action;
  const source = ticket.isSnag ? 'snags' : 'support';
  const proofType = ticket.assignmentType === 'checklists' ? ticket.proof_type || 'photo' : 'file';
  const requiresFile = !['text','none'].includes(proofType);
  useEffect(() => () => { if (preview) URL.revokeObjectURL(preview); }, [preview]);
  const submit = async e => {
    e.preventDefault(); setBusy(true);
    try {
      if (kind === 'proof') {
        let url = uploaded;
        if (!url && requiresFile) {
          const data = new FormData(); data.append('file', file);
          const result = await api.post(`/upload?folder=${ticket.isSnag ? 'snags' : 'help-tickets'}`, data, { headers:{'Content-Type':'multipart/form-data'} });
          url = result.data.url; setUploaded(url);
        }
        if (ticket.assignmentType === 'checklists') {
          await api.post(`/hr/checklists/${ticket.id}/complete`, {proof_url:url || null,notes,completion_date:ticket.occurrence});
        } else if (ticket.assignmentType === 'delegations') {
          await api.post(`/delegations/${ticket.id}/submit`, {proof_url:url,proof_remarks:notes});
        } else {
          await api.post(`/${source}/${ticket.id}/${ticket.isSnag ? 'submit' : 'submit-proof'}`, { proof_url:url, proof_notes:notes });
        }
      } else if (kind === 'reject') {
        await api.post(`/${source}/${ticket.id}/reject`, { reason:notes.trim() });
      } else if (ticket.status === 'submitted') {
        await api.post(`/${source}/${ticket.id}/approve`, {});
      } else {
        await api.put(`/support/${ticket.id}`, { status:'resolved' });
      }
      toast.success(kind === 'proof' ? 'Proof submitted for review' : kind === 'reject' ? 'Changes requested' : 'Ticket closed');
      onSaved();
    } catch (e) { toast.error(e.response?.data?.error || 'Could not save. Please retry.'); }
    finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => !busy && onClose()} title={`${kind === 'proof' ? 'Upload proof' : kind === 'reject' ? 'Request changes' : 'Review & close'} · ${ticket.ticket_no}`}>
    <form onSubmit={submit} className="space-y-4">
      <p className="font-semibold">{ticket.subject}</p>
      {kind === 'proof' ? <>
        {requiresFile && <label className="block text-sm">Proof file<input className="block mt-2 w-full" type="file" required disabled={busy} accept={proofType === 'photo' ? 'image/*' : proofType === 'pdf' ? '.pdf,application/pdf' : '.pdf,.jpg,.jpeg,.png,.webp,.doc,.docx,.xls,.xlsx,.csv'} onChange={e => { const selected = e.target.files[0] || null; setFile(selected); setPreview(selected ? URL.createObjectURL(selected) : ''); setUploaded(''); }} /></label>}
        <ProofPreview key={preview} url={preview} name={file?.name} type={file?.type}/>
        <p className="text-xs text-gray-500">{ticket.assignmentType ? `Submit for management approval${ticket.occurrence ? ` for ${ticket.occurrence}` : ''}. Submission does not mean approval.` : 'Submitting proof sends it to the person who raised this ticket for review. It does not close the ticket.'}</p>
      </> : ticket.proof_url && <ProofPreview url={ticket.proof_url} reviewOnly/>}
      {kind !== 'close' && <label className="block text-sm">{kind === 'reject' ? 'Reason for requesting changes' : 'Proof notes'}<textarea className="input w-full mt-1" value={notes} disabled={busy} required={kind === 'reject' || proofType === 'text'} onChange={e => setNotes(e.target.value)}/></label>}
      {kind === 'close' && <p className="text-sm">{ticket.proof_notes && <span className="block whitespace-pre-wrap mb-2">{ticket.proof_notes}</span>}Close this ticket only after checking that your issue is resolved.</p>}
      <div className="flex gap-2"><button className="btn btn-primary text-sm" disabled={busy || (kind === 'proof' && requiresFile && !file) || ((kind === 'reject' || proofType === 'text') && !notes.trim())}>{busy ? 'Saving…' : kind === 'proof' ? 'Submit for approval' : kind === 'reject' ? 'Send back' : ticket.status === 'submitted' ? 'Approve proof & close' : 'Close ticket'}</button><button type="button" className={button} disabled={busy} onClick={onClose}>Cancel</button></div>
    </form>
  </Modal>;
}

export default function DashboardHelpTickets({ snags = false }) {
  const { user, canApprove, isAdmin } = useAuth();
  const approver = snags && (isAdmin() || canApprove('snags'));
  const title = snags ? 'Snag List' : 'Help Tickets';
  const [tickets, setTickets] = useState({ mine:[], given:[], all:[] });
  const [scope, setScope] = useState('mine');
  const [showClosed, setShowClosed] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [action, setAction] = useState(null);
  const [busy, setBusy] = useState(null);
  const requests = useRef({ sequence:0 });
  const load = useCallback(async () => {
    const state = requests.current;
    const current = ++state.sequence;
    try {
      let result;
      if (snags) {
        // Server applies the existing site/role visibility, including imported names.
        const response = await api.get('/snags');
        const all = response.data.map(s => ({ ...s, isSnag:true, ticket_no:s.snag_no, subject:s.description, user_id:s.raised_by, user_name:s.raised_by_name, assigned_to_name:s.assigned_to_user_name || s.assigned_to_name, deadline_date:s.target_date, attachment_link:s.photo_url, module:s.site_name_live || s.site_name }));
        result = { all, mine:all.filter(s => Number(s.assigned_to) === user.id || (!s.assigned_to && s.assigned_to_name === user.name) || s.assigned_to === user.name), given:all.filter(s => Number(s.user_id) === user.id) };
      } else {
        const [mine, given] = await Promise.all([api.get('/support?scope=mine'), api.get('/support?scope=given')]);
        result = { mine:mine.data, given:given.data, all:[] };
      }
      if (current !== state.sequence) return;
      setTickets(result); setError('');
    } catch { if (current === state.sequence) setError('Could not refresh this list. Please retry.'); }
    finally { if (current === state.sequence) setLoading(false); }
  }, [snags, user.id, user.name]);
  useEffect(() => {
    const state = requests.current;
    // Fetch external ticket state on mount; all updates occur after the API response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
    const refresh = () => { if (!document.hidden) load(); };
    const timer = setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { state.sequence++; clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, [load, user.id]);
  const start = async t => {
    setBusy(t.id);
    try { await api.put(`/support/${t.id}`, { status:'in_progress' }); await load(); toast.success('Ticket marked in progress'); }
    catch (e) { toast.error(e.response?.data?.error || 'Could not update ticket'); }
    finally { setBusy(null); }
  };
  const rows = tickets[scope].filter(t => showClosed || !done(t));
  return <section aria-label={`Dashboard ${title}`} className="card border-l-4 border-indigo-400 bg-indigo-50/30">
    <div className="flex flex-wrap items-center justify-between gap-2 mb-3"><h3 className="font-semibold text-gray-800">{title}</h3><div className="flex items-center gap-3"><button className={button} onClick={load}>Refresh {title}</button><Link to={snags ? '/snags' : '/help-tickets'} className="text-xs text-indigo-700 hover:underline">Open {title} →</Link></div></div>
    <div className="flex flex-wrap items-center gap-2 mb-3">{[['mine','Assigned to Me'],['given','Raised by Me'],...(snags ? [['all','My Sites / Permitted Snags']] : [])].map(([key,label]) => <button key={key} aria-pressed={scope === key} className={scope === key ? 'btn btn-primary text-xs' : button} onClick={() => setScope(key)}>{label} ({tickets[key].filter(t => !done(t)).length} active)</button>)}<label className="text-xs flex gap-2 items-center"><input type="checkbox" checked={showClosed} onChange={e => setShowClosed(e.target.checked)}/>Show closed</label></div>
    <p className="text-xs text-gray-500 mb-3">Updates every 30 seconds and when you return. Today and previous pending use the actual due date (IST). Items without a deadline stay under No Due Date.</p>
    {loading && <p role="status">Loading help tickets…</p>}{error && <p role="alert" className="text-sm text-red-700 mb-3">{error}</p>}
    {!loading && !error && !rows.length && <p className="text-sm text-gray-500 py-3">No {showClosed ? '' : 'active '}tickets {scope === 'mine' ? 'assigned to you' : 'raised by you'}.</p>}
    <div className="space-y-4 max-h-[42rem] overflow-y-auto">{workGroups.filter(([key]) => key !== 'closed' || showClosed).map(([key,label]) => {
      const group = rows.filter(t => workGroup(t) === key);
      if (!group.length && !['today','previous'].includes(key)) return null;
      return <section key={key} aria-label={`${title} ${label}`} className="space-y-2"><h4 className={`font-semibold text-sm ${key === 'previous' ? 'text-red-700' : 'text-indigo-800'}`}>{label} ({group.length})</h4>{!group.length && <p className="text-xs text-gray-500">No pending tasks in this group.</p>}{group.map(t => <article key={t.id} className="bg-white border rounded-lg p-3 space-y-2">
      <div className="flex flex-wrap justify-between gap-2"><span className="text-xs font-semibold text-indigo-700">{t.ticket_no} · {(t.priority || 'medium').toUpperCase()} {t.module && `· ${t.module}`}</span><span className={`text-xs rounded px-2 py-1 ${done(t) ? 'bg-emerald-50 text-emerald-700' : t.status === 'submitted' ? 'bg-blue-50 text-blue-700' : 'bg-amber-50 text-amber-800'}`}>{t.status === 'submitted' && scope === 'mine' ? 'Submitted for approval' : statusLabel[t.status] || t.status}</span></div>
      <h4 className="text-sm font-semibold">{t.subject}</h4><p className="text-xs text-gray-500">{scope === 'mine' ? `Raised by ${t.user_name || '—'}` : `Assigned to ${t.assigned_to_name || 'Not assigned'}`}{t.deadline_date && ` · Due ${t.deadline_date}`}</p>
      {t.admin_response && <p className="text-sm whitespace-pre-wrap">Latest response: {t.admin_response}</p>}{t.reject_reason && <p className="text-sm text-red-700">Changes requested: {t.reject_reason}</p>}
      <details className="text-sm"><summary className="cursor-pointer text-indigo-700">Details{t.proof_url ? ' & submitted proof' : ''}</summary><p className="whitespace-pre-wrap my-2">{t.description}</p>{t.attachment_link && <a className="text-indigo-700 underline" href={t.attachment_link} target="_blank" rel="noreferrer">Original attachment</a>}{t.proof_url && <><ProofPreview url={t.proof_url} reviewOnly/><p className="whitespace-pre-wrap mt-2">{t.proof_notes}</p><p className="text-xs text-gray-500">Submitted by {t.proof_submitted_by_name || t.assigned_to_name || 'assignee'}{t.proof_submitted_at && ` · ${t.proof_submitted_at}`}</p></>}</details>
      {!error && !done(t) && <div className="flex flex-wrap gap-2">
        {(Number(t.assigned_to) === user.id || approver) && ['open','in_progress','rejected'].includes(t.status) && <>{!snags && t.status !== 'in_progress' && <button className={button} disabled={busy === t.id} onClick={() => start(t)}>Mark in progress</button>}<button className="btn btn-primary text-xs" onClick={() => setAction({ticket:t,kind:'proof'})}>Upload proof</button></>}
        {(Number(t.user_id) === user.id || approver) && (!snags || t.status === 'submitted') && <><button className={button} onClick={() => setAction({ticket:t,kind:'close'})}>{t.status === 'submitted' ? 'Review proof & close' : 'Close ticket'}</button>{t.status === 'submitted' && <button className={button} onClick={() => setAction({ticket:t,kind:'reject'})}>Request changes</button>}</>}
      </div>}
    </article>)}</section>;
    })}</div>
    {action && <TicketAction key={`${action.ticket.id}-${action.kind}`} action={action} onClose={() => setAction(null)} onSaved={() => { setAction(null); load(); }}/>} 
  </section>;
}
