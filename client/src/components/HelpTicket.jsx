import { useState, useEffect } from 'react';
import api from '../api';
import Modal from './Modal';
import SearchableSelect from './SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiHelpCircle, FiBook, FiX, FiPlus, FiCheckCircle, FiClock, FiAlertTriangle, FiUpload } from 'react-icons/fi';
import useDraggableFab from '../hooks/useDraggableFab';
import { fmtDateIST } from '../utils/dateIST';
import { compressImage } from '../utils/compressImage';

const GUIDES = [
  { title: 'How to Add a Business Book Entry', steps: ['Go to Business Book page', 'Click "New Entry"', 'Fill client, company, project details', 'Select category (FF/Electrical/etc)', 'Save - auto creates Site + Order Planning'] },
  { title: 'How to Create a Purchase Order', steps: ['Go to Orders & Planning', 'Click "Add PO"', 'Select Business Book entry', 'Upload PO copy', 'Upload BOQ Excel → items auto-fill', 'Create PO'] },
  { title: 'How to Submit DPR', steps: ['Go to DPR page', 'Click "Submit DPR"', 'Select site', 'Fill Table A (Installation from PO)', 'Fill Table B (Costs)', 'Add safety, hindrances, next day plan', 'Submit'] },
  { title: 'How to Request Payment', steps: ['Go to Payment Required', 'Click "New Request"', 'Select employee name (auto fills dept/phone)', 'Select category', 'Fill required fields based on category', 'Submit - goes to category approver'] },
  { title: 'How to Punch Attendance', steps: ['Open SOTYN.AI on mobile', 'Go to Attendance', 'Click "Take Selfie"', 'Allow GPS + Camera', 'Click PUNCH IN (only inside office geofence)', 'After work click PUNCH OUT'] },
  { title: 'How to Add a New User', steps: ['Admin → User Management', 'Click "Add User"', 'Fill name, email, password', 'Assign roles (Site Engineer/HR/etc.)', 'User can now login'] },
  { title: 'How to Approve Payment', steps: ['Go to Payment Required', 'Click Review on pending request', 'Read all details', 'Enter approval reason (min 5 chars)', 'Click Approve or Reject'] },
  { title: 'How Sales Funnel Works', steps: ['New Lead (SC)', 'Mark Qualified or Not (SC)', 'Assign Meeting (SC)', 'Upload MOM (ASM)', 'Upload Drawings (ASM)', 'Create BOQ (Designer)', 'Send Quotation (SC)', 'Final: Won/Lost'] },
];

export default function HelpTicket() {
  const { user, canSeeAll } = useAuth();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('tickets');
  const [tickets, setTickets] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '' });
  const [selectedTicket, setSelectedTicket] = useState(null);
  const [adminResponse, setAdminResponse] = useState('');
  const [reassign, setReassign] = useState('');
  const [deadlineEdit, setDeadlineEdit] = useState('');
  // Delegation-style proof upload state for the open ticket.
  const [proof, setProof] = useState({ url: '', notes: '', uploading: false, pct: 0 });

  // Draggable FAB — mam's request 2026-05-16.  Position persists in
  // localStorage under 'fab-help' so it stays put across reloads.
  // offsetBottom = 24 so the default position matches the old
  // bottom-6 right-6 anchor for first-time users.
  const helpFab = useDraggableFab('fab-help', { offsetRight: 24, offsetBottom: 24 });

  const isAdmin = user?.role === 'admin';
  // Admin OR the help_tickets follow-up role can approve/reject any proof.
  const canFollowAll = isAdmin || (typeof canSeeAll === 'function' && canSeeAll('help_tickets'));

  const load = () => { api.get('/support').then(r => setTickets(r.data)).catch(() => {}); };
  useEffect(() => {
    if (open) {
      load();
      // Active employees for the Assign To dropdown
      api.get('/auth/users').then(r => setEmployees((r.data || []).filter(u => u.active !== 0))).catch(() => setEmployees([]));
    }
  }, [open]);

  // Upload an optional attachment first (screenshot of the bug, error log,
  // etc.), stash its URL on the form, then POST the ticket. Backend's
  // /support route already accepts attachment_link, no API change needed.
  const submit = async (e) => {
    e.preventDefault();
    let payload = { ...form };
    delete payload._file;
    if (form._file) {
      try {
        const fd = new FormData();
        fd.append('file', form._file);
        const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        payload.attachment_link = r.data?.url || null;
      } catch {
        toast.error('Attachment upload failed — submitting without file');
      }
    }
    try {
      const res = await api.post('/support', payload);
      toast.success(`Ticket ${res.data.ticket_no} created${form.assigned_to ? ' — assigned' : ''}`);
      setModal(null);
      setForm({ subject: '', description: '', category: 'bug', priority: 'medium', module: '', assigned_to: '', deadline_date: '', _file: null });
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const updateTicket = async (id, update) => {
    try { await api.put(`/support/${id}`, update); toast.success('Updated'); setSelectedTicket(null); setAdminResponse(''); load(); }
    catch { toast.error('Failed'); }
  };

  // ── Proof of fix (Delegation-style) ──────────────────────────────────
  const uploadProof = async (file) => {
    if (!file) return;
    setProof(p => ({ ...p, uploading: true, pct: 0 }));
    try {
      const toSend = file.type?.startsWith('image/') ? await compressImage(file) : file;
      const fd = new FormData();
      fd.append('file', toSend);
      const res = await api.post('/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (ev) => { if (ev.total) setProof(p => ({ ...p, pct: Math.round((ev.loaded / ev.total) * 100) })); },
      });
      setProof(p => ({ ...p, url: res.data?.url || '', uploading: false, pct: 100 }));
      toast.success('Proof uploaded — add a note (optional) and submit');
    } catch (err) {
      setProof(p => ({ ...p, uploading: false, pct: 0 }));
      toast.error(`Upload failed: ${err.response?.data?.error || err.message}`);
    }
  };
  const submitProof = async (id) => {
    if (!proof.url) return toast.error('Please upload a proof file first');
    try {
      await api.post(`/support/${id}/submit-proof`, { proof_url: proof.url, proof_notes: proof.notes });
      toast.success('Proof submitted — awaiting approval');
      setSelectedTicket(null); setModal(null); setProof({ url: '', notes: '', uploading: false, pct: 0 }); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const approveProof = async (id) => {
    try {
      await api.post(`/support/${id}/approve`);
      toast.success('Proof approved — ticket resolved');
      setSelectedTicket(null); setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };
  const rejectProof = async (id) => {
    const reason = prompt('Reason for rejecting this proof (the assignee will see it):');
    if (reason === null) return;
    if (!reason.trim()) return toast.error('A reason is required to reject');
    try {
      await api.post(`/support/${id}/reject`, { reason });
      toast.success('Proof rejected — assignee notified');
      setSelectedTicket(null); setModal(null); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const statusColors = { open: 'bg-red-100 text-red-700', in_progress: 'bg-amber-100 text-amber-700', submitted: 'bg-blue-100 text-blue-700', resolved: 'bg-emerald-100 text-emerald-700', rejected: 'bg-red-100 text-red-700', closed: 'bg-gray-100 text-gray-500' };
  const priorityColors = { low: 'text-gray-500', medium: 'text-red-600', high: 'text-amber-600', urgent: 'text-red-600' };

  return (
    <>
      {/* Floating Help Button — draggable (mam, 2026-05-16). The
          inline z-30 lives on the style now since `fixed bottom-X
          right-X` was replaced with the hook's dynamic position. */}
      <button
        {...helpFab.handlers}
        onClick={helpFab.onClickGuard(() => setOpen(true))}
        style={{ ...helpFab.style, zIndex: 30 }}
        className="w-14 h-14 rounded-full bg-gradient-to-br from-blue-700 to-blue-800 text-white shadow-xl shadow-blue-500/40 flex items-center justify-center hover:scale-110 transition-transform cursor-grab active:cursor-grabbing"
        title="Help & Support (drag to move)">
        <FiHelpCircle size={24} />
      </button>

      {/* Help Panel */}
      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[420px] max-w-[calc(100vw-2rem)] max-h-[80vh] bg-white rounded-2xl shadow-2xl border flex flex-col">
          <div className="flex items-center justify-between p-4 border-b bg-gradient-to-r from-blue-700 to-blue-800 text-white rounded-t-2xl">
            <div>
              <h3 className="font-bold">Help & Support</h3>
              <p className="text-xs opacity-80">We're here to help</p>
            </div>
            <button onClick={() => setOpen(false)} className="p-1.5 hover:bg-white/20 rounded"><FiX size={18}/></button>
          </div>

          <div className="flex border-b">
            <button onClick={() => setTab('tickets')} className={`flex-1 py-2.5 text-xs font-bold ${tab==='tickets' ? 'text-red-600 border-b-2 border-red-600' : 'text-gray-500'}`}>
              <FiHelpCircle className="inline mr-1" size={12}/> Tickets {tickets.length > 0 && `(${tickets.filter(t=>t.status!=='closed'&&t.status!=='resolved').length})`}
            </button>
            <button onClick={() => setTab('learner')} className={`flex-1 py-2.5 text-xs font-bold ${tab==='learner' ? 'text-red-600 border-b-2 border-red-600' : 'text-gray-500'}`}>
              <FiBook className="inline mr-1" size={12}/> SOTYN.AI Learner
            </button>
          </div>

          <div className="flex-1 overflow-y-auto p-3">
            {tab === 'tickets' && (
              <div className="space-y-2">
                <button onClick={() => setModal('new')} className="w-full btn btn-primary text-xs py-2 flex items-center justify-center gap-1"><FiPlus size={12}/> Raise New Ticket</button>
                {tickets.length === 0 && <p className="text-xs text-gray-400 text-center py-6">No tickets yet</p>}
                {tickets.map(t => (
                  <div key={t.id} onClick={() => { setSelectedTicket(t); setAdminResponse(t.admin_response || ''); setReassign(t.assigned_to || ''); setDeadlineEdit((t.deadline_date || '').slice(0, 10)); setProof({ url: '', notes: '', uploading: false, pct: 0 }); setModal('view'); }} className="p-2.5 border rounded-lg hover:bg-red-50/40 cursor-pointer text-xs">
                    <div className="flex justify-between items-start">
                      <div className="flex-1 min-w-0">
                        <p className="font-bold text-red-600">{t.ticket_no}</p>
                        <p className="font-medium truncate">{t.subject}</p>
                        {isAdmin && <p className="text-[10px] text-gray-400">by {t.user_name}</p>}
                        {t.assigned_to_name && (
                          <p className="text-[10px] text-indigo-600 font-semibold">→ {t.assigned_to_name}{t.assigned_to === user?.id && <span className="text-emerald-600"> (you)</span>}</p>
                        )}
                        {t.deadline_date && (
                          <p className="text-[10px] text-amber-700 font-medium">📅 Due: {t.deadline_date.slice(0, 10)}</p>
                        )}
                      </div>
                      <span className={`text-[9px] px-1.5 py-0.5 rounded font-bold ${statusColors[t.status]}`}>{t.status}</span>
                    </div>
                    <div className="flex items-center justify-between mt-1">
                      <span className={`text-[9px] font-bold ${priorityColors[t.priority]}`}>{t.priority.toUpperCase()}</span>
                      <span className="text-[9px] text-gray-400">{fmtDateIST(t.created_at)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}

            {tab === 'learner' && (
              <div className="space-y-2">
                <p className="text-xs text-gray-500 mb-2">Quick guides to use the SOTYN.AI</p>
                {GUIDES.map((g, i) => (
                  <details key={i} className="border rounded-lg p-2">
                    <summary className="font-semibold text-xs text-red-600 cursor-pointer">{g.title}</summary>
                    <ol className="text-xs space-y-1 mt-2 ml-4 list-decimal text-gray-600">
                      {g.steps.map((s, j) => <li key={j}>{s}</li>)}
                    </ol>
                  </details>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* New Ticket Modal */}
      <Modal isOpen={modal === 'new'} onClose={() => setModal(null)} title="Raise Support Ticket">
        <form onSubmit={submit} className="space-y-4">
          <div><label className="label">Subject *</label><input className="input" value={form.subject} onChange={e => setForm({...form, subject: e.target.value})} placeholder="Brief summary..." required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Category</label><select className="select" value={form.category} onChange={e => setForm({...form, category: e.target.value})}><option value="bug">Bug / Issue</option><option value="feature_request">Feature Request</option><option value="how_to">How To / Question</option><option value="data_issue">Data Issue</option><option value="other">Other</option></select></div>
            <div><label className="label">Priority</label><select className="select" value={form.priority} onChange={e => setForm({...form, priority: e.target.value})}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option></select></div>
            <div className="col-span-2"><label className="label">Which Module?</label><input className="input" value={form.module} onChange={e => setForm({...form, module: e.target.value})} placeholder="e.g. Payment Required, DPR, Attendance..." /></div>
            <div className="col-span-2">
              <label className="label">Assign To <span className="text-gray-400 font-normal">(optional — employee sees it on their dashboard)</span></label>
              <SearchableSelect
                options={employees.map(u => ({ ...u, label: `${u.name}${u.username ? ' (@' + u.username + ')' : ''}${u.department ? ' — ' + u.department : ''}` }))}
                value={form.assigned_to || null}
                valueKey="id" displayKey="label"
                placeholder="— Unassigned — type to search by name"
                onChange={(u) => setForm({ ...form, assigned_to: u?.id || '' })}
              />
            </div>
            <div className="col-span-2">
              <label className="label">Deadline Date <span className="text-gray-400 font-normal text-[10px]">(optional — target completion date)</span></label>
              <input
                type="date"
                className="input"
                value={form.deadline_date || ''}
                onChange={e => setForm({ ...form, deadline_date: e.target.value })}
              />
            </div>
          </div>
          <div><label className="label">Description *</label><textarea className="input" rows="4" value={form.description} onChange={e => setForm({...form, description: e.target.value})} placeholder="Describe your issue or request in detail..." required /></div>
          <div>
            <label className="label">Attachment <span className="text-gray-400 font-normal text-[10px]">(optional · screenshot, log file, PDF)</span></label>
            <input
              className="input"
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp,.gif,.txt,.log,.xlsx,.xls,.csv,.doc,.docx"
              onChange={e => setForm({ ...form, _file: e.target.files?.[0] || null })}
            />
            {form._file && (
              <p className="text-[10px] text-blue-600 mt-1">Selected: {form._file.name} ({(form._file.size / 1024).toFixed(1)} KB)</p>
            )}
          </div>
          <div className="flex justify-end gap-3"><button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Submit Ticket</button></div>
        </form>
      </Modal>

      {/* View Ticket Modal */}
      <Modal isOpen={modal === 'view'} onClose={() => { setModal(null); setSelectedTicket(null); }} title={selectedTicket?.ticket_no} wide>
        {selectedTicket && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <div><h3 className="font-bold text-lg">{selectedTicket.subject}</h3><p className="text-xs text-gray-500">by {selectedTicket.user_name} on {selectedTicket.created_at}</p></div>
              <div className="flex gap-2">
                <span className={`text-xs px-2 py-1 rounded font-bold ${statusColors[selectedTicket.status]}`}>{selectedTicket.status}</span>
                <span className={`text-xs font-bold ${priorityColors[selectedTicket.priority]}`}>{selectedTicket.priority.toUpperCase()}</span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="bg-gray-100 px-2 py-1 rounded">{selectedTicket.category}</span>
              {selectedTicket.module && <span className="bg-red-100 px-2 py-1 rounded">{selectedTicket.module}</span>}
              {selectedTicket.deadline_date && (
                <span className="bg-amber-100 text-amber-800 font-semibold px-2 py-1 rounded border border-amber-200">
                  📅 Due: {selectedTicket.deadline_date.slice(0, 10)}
                </span>
              )}
            </div>
            <div className="bg-gray-50 p-3 rounded text-sm whitespace-pre-wrap">{selectedTicket.description}</div>
            {selectedTicket.attachment_link && (
              <div className="text-xs">
                <a href={selectedTicket.attachment_link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-blue-600 hover:underline font-semibold">
                  📎 View attachment
                </a>
              </div>
            )}
            {/* Submitted proof of fix */}
            {selectedTicket.proof_url && (
              <div className="text-xs">
                <a href={selectedTicket.proof_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-emerald-700 hover:underline font-semibold">
                  ✅ View submitted proof{selectedTicket.proof_submitted_by_name ? ` — by ${selectedTicket.proof_submitted_by_name}` : ''}
                </a>
                {selectedTicket.proof_notes && <p className="text-gray-600 mt-1 whitespace-pre-wrap">{selectedTicket.proof_notes}</p>}
              </div>
            )}
            {selectedTicket.status === 'rejected' && selectedTicket.reject_reason && (
              <div className="bg-red-50 border-l-4 border-red-500 rounded p-2 text-xs">
                <p className="font-bold text-red-700 mb-0.5">Proof rejected — please re-upload</p>
                <p className="text-red-900 whitespace-pre-wrap">{selectedTicket.reject_reason}</p>
              </div>
            )}
            {/* Assignee uploads proof of the fix */}
            {(selectedTicket.assigned_to === user?.id || canFollowAll) && ['open', 'in_progress', 'rejected'].includes(selectedTicket.status) && (
              <div className="border-t pt-3 space-y-2">
                <h5 className="font-bold text-sm">Upload proof of fix <span className="text-gray-400 font-normal text-[10px]">(photo / PDF / Excel)</span></h5>
                <div className="flex flex-wrap gap-2">
                  <label className="btn btn-secondary text-[11px] px-2 py-1 cursor-pointer flex items-center gap-1">
                    <FiUpload size={11} /> Camera
                    <input type="file" accept="image/*" capture="environment" className="hidden" disabled={proof.uploading}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(f); }} />
                  </label>
                  <label className="btn btn-secondary text-[11px] px-2 py-1 cursor-pointer flex items-center gap-1">
                    <FiUpload size={11} /> File
                    <input type="file" accept=".pdf,.jpg,.jpeg,.png,.doc,.docx,.xls,.xlsx" className="hidden" disabled={proof.uploading}
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(f); }} />
                  </label>
                  {proof.uploading && <span className="text-[11px] text-gray-500 self-center">Uploading… {proof.pct}%</span>}
                  {proof.url && !proof.uploading && <span className="text-[11px] text-emerald-600 self-center">✓ File ready</span>}
                </div>
                <textarea className="input" rows="2" value={proof.notes} onChange={e => setProof(p => ({ ...p, notes: e.target.value }))} placeholder="Optional note about the fix…" />
                <button onClick={() => submitProof(selectedTicket.id)} disabled={!proof.url || proof.uploading} className="btn btn-success text-[11px] px-2 py-1 disabled:opacity-50">Submit Proof for Approval</button>
              </div>
            )}
            {/* Raiser / admin reviews the submitted proof */}
            {selectedTicket.status === 'submitted' && (selectedTicket.user_id === user?.id || canFollowAll) && (
              <div className="border-t pt-3 flex flex-wrap items-center gap-2">
                <span className="text-xs font-bold text-gray-700">Review proof:</span>
                <button onClick={() => approveProof(selectedTicket.id)} className="btn btn-success text-[11px] px-2 py-1 flex items-center gap-1"><FiCheckCircle size={11} /> Approve &amp; Resolve</button>
                <button onClick={() => rejectProof(selectedTicket.id)} className="btn btn-danger text-[11px] px-2 py-1">Reject…</button>
              </div>
            )}
            {selectedTicket.status === 'submitted' && !(selectedTicket.user_id === user?.id || canFollowAll) && (
              <p className="text-[10px] text-gray-500 italic">Proof submitted — awaiting the raiser's approval.</p>
            )}
            {selectedTicket.admin_response && (
              <div className="bg-emerald-50 p-3 rounded border-l-4 border-emerald-500">
                <p className="text-xs font-bold text-emerald-700 mb-1">Admin Response (by {selectedTicket.resolved_by_name})</p>
                <p className="text-sm whitespace-pre-wrap">{selectedTicket.admin_response}</p>
              </div>
            )}

            {/* Deadline editor for raiser, assignee, or admin */}
            {(canFollowAll || selectedTicket.assigned_to === user?.id || selectedTicket.user_id === user?.id) && (
              <div className="border-t pt-3 space-y-1">
                <label className="label text-[11px]">Set / Edit Deadline Date</label>
                <div className="flex gap-2 items-center">
                  <input type="date" className="input text-xs py-1 flex-1" value={deadlineEdit} onChange={e => setDeadlineEdit(e.target.value)} />
                  <button type="button" onClick={() => updateTicket(selectedTicket.id, { deadline_date: deadlineEdit || null })} disabled={(deadlineEdit || '') === (selectedTicket.deadline_date || '').slice(0, 10)} className="btn btn-secondary text-xs whitespace-nowrap disabled:opacity-50">Save Deadline</button>
                </div>
              </div>
            )}

            {/* Assignee (non-admin) can move to in_progress + leave a response */}
            {!isAdmin && selectedTicket.assigned_to === user?.id && selectedTicket.status !== 'closed' && selectedTicket.status !== 'resolved' && (
              <div className="border-t pt-4 space-y-3">
                <h5 className="font-bold text-sm">Your response (you're assigned to this ticket)</h5>
                <textarea className="input" rows="3" placeholder="Update the user about what you've done..." value={adminResponse} onChange={e => setAdminResponse(e.target.value)} />
                <button onClick={() => updateTicket(selectedTicket.id, { status: 'in_progress', admin_response: adminResponse })} className="btn btn-secondary text-xs">Mark In Progress & Save Response</button>
                <p className="text-[10px] text-gray-400">Only admin can finally mark this Resolved or Closed.</p>
              </div>
            )}

            {isAdmin && selectedTicket.status !== 'closed' && (
              <div className="border-t pt-4 space-y-3">
                <h5 className="font-bold text-sm">Admin Actions</h5>
                <div>
                  <label className="label text-[11px]">Reassign to</label>
                  <div className="flex gap-2">
                    <div className="flex-1">
                      <SearchableSelect
                        options={employees.map(u => ({ ...u, label: `${u.name}${u.username ? ' (@' + u.username + ')' : ''}` }))}
                        value={reassign || null}
                        valueKey="id" displayKey="label"
                        placeholder="— Unassigned — search employee"
                        onChange={(u) => setReassign(u?.id || '')}
                      />
                    </div>
                    <button type="button" onClick={() => updateTicket(selectedTicket.id, { assigned_to: reassign ? +reassign : null })} className="btn btn-secondary text-xs whitespace-nowrap">Save Assignee</button>
                  </div>
                </div>
                <textarea className="input" rows="3" placeholder="Your response to the user..." value={adminResponse} onChange={e => setAdminResponse(e.target.value)} />
                <div className="flex flex-wrap gap-2">
                  <button onClick={() => updateTicket(selectedTicket.id, { status: 'in_progress', admin_response: adminResponse })} className="btn btn-secondary text-xs">Mark In Progress</button>
                  <button onClick={() => updateTicket(selectedTicket.id, { status: 'resolved', admin_response: adminResponse })} className="btn btn-success text-xs">Resolve</button>
                  <button onClick={() => updateTicket(selectedTicket.id, { status: 'closed', admin_response: adminResponse })} className="btn btn-danger text-xs">Close</button>
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}
