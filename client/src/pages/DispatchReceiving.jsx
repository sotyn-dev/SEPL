import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import Pagination, { usePagination } from '../components/PaginationBar';
import { useAuth } from '../context/AuthContext';
import { compressImage } from '../utils/compressImage';
import { fmtDateTime } from '../utils/datetime';

const BLANK = { site: '', indent_number: '', bill_number: '', file: null };
const siteKey = (name) => String(name || '').trim().toLowerCase();
const when = (iso) => (iso ? fmtDateTime(iso, { dateStyle: 'medium', timeStyle: 'short' }) : '');

// Status of a receiving — Lovely approves every one (mam 2026-09-11).
function StatusCell({ r }) {
  if (r.status === 'approved') {
    return <div><span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-700">Approved</span>
      <div className="text-xs text-gray-500 mt-1">{r.approved_by_name || '—'}{r.approved_at ? ` · ${when(r.approved_at)}` : ''}</div></div>;
  }
  if (r.status === 'rejected') {
    return <div><span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-700">Rejected</span>
      <div className="text-xs text-gray-500 mt-1">{r.approved_by_name || '—'}{r.rejected_reason ? ` · ${r.rejected_reason}` : ''}</div></div>;
  }
  return <div><span className="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-700">Pending approval</span>
    <div className="text-xs text-gray-500 mt-1">Awaiting {r.approver_names || 'Lovely'}</div></div>;
}

export default function DispatchReceiving() {
  const { canCreate } = useAuth();
  const [rows, setRows] = useState([]);
  const [sites, setSites] = useState([]);
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState(null);     // the row being edited, or null when adding
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [form, setForm] = useState(BLANK);
  const [search, setSearch] = useState('');
  const load = async () => {
    setLoading(true);
    try {
      const [entries, options] = await Promise.all([api.get('/dispatch-receiving'), api.get('/dispatch-receiving/sites')]);
      setRows(entries.data); setSites(options.data);
    } catch (err) { toast.error(err.response?.data?.error || 'Could not load dispatch receiving'); }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []);
  const filtered = rows.filter(r => `${r.site_name} ${r.indent_number} ${r.bill_number} ${r.status}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pagination = usePagination(filtered, { resetKey: [search] });

  const openAdd = () => { setEditing(null); setForm(BLANK); setOpen(true); };
  const openEdit = (r) => {
    setEditing(r);
    setForm({ site: siteKey(r.site_name), indent_number: r.indent_number || '', bill_number: r.bill_number || '', file: null });
    setOpen(true);
  };
  // A saved site that is no longer in the list still shows while editing.
  const siteOptions = editing && !sites.some(s => s.value === siteKey(editing.site_name))
    ? [...sites, { value: siteKey(editing.site_name), label: editing.site_name }]
    : sites;

  const save = async e => {
    e.preventDefault();
    if (saving) return;
    if (!form.site || !form.indent_number.trim() || !form.bill_number.trim() || (!editing && !form.file)) {
      return toast.error(editing ? 'Site, Indent No. and Bill Number are required' : 'All four fields are required');
    }
    setSaving(true);
    try {
      let receivingUrl = editing ? editing.receiving_url : null;
      if (form.file) {
        const file = await compressImage(form.file);
        const data = new FormData(); data.append('file', file);
        const upload = await api.post('/upload', data, { headers: { 'Content-Type': 'multipart/form-data' } });
        receivingUrl = upload.data.url;
      }
      const body = { site: form.site, indent_number: form.indent_number.trim(), bill_number: form.bill_number.trim(), receiving_url: receivingUrl };
      const res = editing ? await api.put(`/dispatch-receiving/${editing.id}`, body) : await api.post('/dispatch-receiving', body);
      toast.success(res.data?.message || 'Dispatch receiving saved'); setOpen(false); await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not save dispatch receiving'); }
    finally { setSaving(false); }
  };

  const decide = async (r, action) => {
    let reason = '';
    if (action === 'reject') {
      reason = (window.prompt(`Reason for rejecting the receiving for ${r.site_name} (bill ${r.bill_number})?`) || '').trim();
      if (!reason) return;
    }
    setBusyId(r.id);
    try {
      const res = await api.post(`/dispatch-receiving/${r.id}/${action}`, action === 'reject' ? { reason } : {});
      toast.success(res.data?.message || 'Done');
      // Approval fires the 'Dispatch Receiving — approved' email trigger; say
      // what it actually did, so a missing rule or Email ID is noticed at once
      // (mam 2026-09-12).
      const mail = res.data?.mail;
      if (mail && action === 'approve') {
        if (mail.sent?.length) {
          for (const s of mail.sent) {
            toast.success(`Mail sent to ${(s.to || []).join(', ')}${s.cc?.length ? ` (cc ${s.cc.join(', ')})` : ''}`, { duration: 6000 });
          }
        } else if (!mail.rules) {
          toast(`No email trigger set for approved receivings — add one in Admin → Email Triggers`, { duration: 7000, icon: '✉️' });
        } else {
          const why = mail.skipped?.map(s => `${s.rule}: ${s.reason}`).join(' · ') || 'no reason given';
          toast.error(`Customer mail NOT sent — ${why}`, { duration: 8000 });
        }
      }
      await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not update the receiving'); }
    finally { setBusyId(null); }
  };

  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold text-gray-800">Dispatch Receiving</h1><p className="text-sm text-gray-500">Record site receiving against an indent and bill. Lovely approves each receiving.</p></div>
      {canCreate('procurement') && <button className="btn btn-primary" onClick={openAdd}>Add Receiving</button>}
    </div>
    <input className="input max-w-md" aria-label="Search receiving records" placeholder="Search site, indent, bill or status…" value={search} onChange={e => setSearch(e.target.value)} />
    <div className="card overflow-x-auto">
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-3">Site Name</th><th className="p-3">Indent No.</th><th className="p-3">Bill Number</th><th className="p-3">Receiving</th><th className="p-3">Recorded By</th><th className="p-3">Status</th><th className="p-3">Actions</th></tr></thead>
        <tbody>{pagination.pageItems.map(r => <tr key={r.id} className="border-b align-top">
          <td className="p-3">{r.site_name}</td>
          <td className="p-3 whitespace-nowrap">{r.indent_number}</td>
          <td className="p-3">{r.bill_number}</td>
          <td className="p-3"><a className="text-blue-700 underline" href={r.receiving_url} target="_blank" rel="noreferrer">View receiving</a></td>
          <td className="p-3">{r.created_by_name || '—'}{r.updated_by_name && <div className="text-xs text-gray-400 mt-1">Edited by {r.updated_by_name}{r.updated_at ? ` · ${when(r.updated_at)}` : ''}</div>}</td>
          <td className="p-3"><StatusCell r={r} /></td>
          <td className="p-3">
            <div className="flex flex-wrap gap-1.5">
              {r.can_approve && <>
                <button className="px-2.5 py-1 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50" disabled={busyId === r.id} onClick={() => decide(r, 'approve')}>Approve</button>
                <button className="px-2.5 py-1 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700 disabled:opacity-50" disabled={busyId === r.id} onClick={() => decide(r, 'reject')}>Reject</button>
              </>}
              {canCreate('procurement') && <button className="px-2.5 py-1 rounded-md text-xs font-semibold border border-gray-300 text-gray-700 hover:bg-gray-50" onClick={() => openEdit(r)}>Edit</button>}
            </div>
          </td>
        </tr>)}</tbody>
      </table>
      {!rows.length && <p className="p-6 text-center text-gray-500">{loading ? 'Loading…' : 'No receiving entries yet.'}</p>}
      {!!rows.length && !filtered.length && <p className="p-6 text-center text-gray-500">No matching receiving entries.</p>}
    </div>
    <Pagination {...pagination} />
    <Modal isOpen={open} onClose={() => { if (!saving) setOpen(false); }} title={editing ? 'Edit Dispatch Receiving' : 'Add Dispatch Receiving'}>
      <form onSubmit={save} className="space-y-4">
        {editing && editing.status !== 'pending' && <p className="text-xs rounded-md bg-amber-50 border border-amber-200 text-amber-800 p-2">This receiving is {editing.status}. Saving changes sends it back to Lovely for approval.</p>}
        <fieldset disabled={saving} className="space-y-4">
          <div><label className="label">Site Name *</label><SearchableSelect options={siteOptions} value={form.site} placeholder="Select site…" onChange={site => setForm(f => ({ ...f, site: site?.value || '' }))} /></div>
          {/* Typed by hand (mam 2026-09-10) — no dropdown */}
          <div><label className="label" htmlFor="receiving-indent">Indent No. *</label><input id="receiving-indent" className="input" required maxLength={100} placeholder="Enter indent number" value={form.indent_number} onChange={e => setForm({ ...form, indent_number: e.target.value })} /></div>
          <div><label className="label" htmlFor="receiving-bill">Bill Number *</label><input id="receiving-bill" className="input" required maxLength={100} value={form.bill_number} onChange={e => setForm({ ...form, bill_number: e.target.value })} /></div>
          <div><label className="label" htmlFor="receiving-file">Upload Receiving {editing ? '' : '*'}</label><input id="receiving-file" className="input" type="file" required={!editing} accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" onChange={e => setForm({ ...form, file: e.target.files?.[0] || null })} />
            <p className="mt-1 text-xs text-gray-500">{editing ? <>Leave empty to keep the current file (<a className="text-blue-700 underline" href={editing.receiving_url} target="_blank" rel="noreferrer">view</a>).</> : 'Upload the receiving photo or PDF.'}</p></div>
        </fieldset>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : editing ? 'Save Changes' : 'Save Receiving'}</button></div>
      </form>
    </Modal>
  </div>;
}
