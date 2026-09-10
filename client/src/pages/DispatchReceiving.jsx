import { useEffect, useState } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import Pagination, { usePagination } from '../components/PaginationBar';
import { useAuth } from '../context/AuthContext';
import { compressImage } from '../utils/compressImage';

export default function DispatchReceiving() {
  const { canCreate } = useAuth();
  const [rows, setRows] = useState([]);
  const [sites, setSites] = useState([]);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ site: '', indent_number: '', bill_number: '', file: null });
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
  const filtered = rows.filter(r => `${r.site_name} ${r.indent_number} ${r.bill_number}`.toLowerCase().includes(search.trim().toLowerCase()));
  const pagination = usePagination(filtered);
  const save = async e => {
    e.preventDefault();
    if (saving) return;
    if (!form.site || !form.indent_number.trim() || !form.bill_number.trim() || !form.file) return toast.error('All four fields are required');
    setSaving(true);
    try {
      const file = await compressImage(form.file);
      const data = new FormData(); data.append('file', file);
      const upload = await api.post('/upload', data, { headers: { 'Content-Type': 'multipart/form-data' } });
      await api.post('/dispatch-receiving', { site: form.site, indent_number: form.indent_number.trim(), bill_number: form.bill_number.trim(), receiving_url: upload.data.url });
      toast.success('Dispatch receiving saved'); setOpen(false); await load();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not save dispatch receiving'); }
    finally { setSaving(false); }
  };
  return <div className="space-y-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h1 className="text-xl font-bold text-gray-800">Dispatch Receiving</h1><p className="text-sm text-gray-500">Record site receiving against an indent and bill.</p></div>
      {canCreate('procurement') && <button className="btn btn-primary" onClick={() => { setForm({ site: '', indent_number: '', bill_number: '', file: null }); setOpen(true); }}>Add Receiving</button>}
    </div>
    <input className="input max-w-md" aria-label="Search receiving records" placeholder="Search site, indent or bill…" value={search} onChange={e => setSearch(e.target.value)} />
    <div className="card overflow-x-auto">
      <table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-3">Site Name</th><th className="p-3">Indent No.</th><th className="p-3">Bill Number</th><th className="p-3">Receiving</th><th className="p-3">Recorded By</th></tr></thead>
        <tbody>{pagination.pageItems.map(r => <tr key={r.id} className="border-b"><td className="p-3">{r.site_name}</td><td className="p-3 whitespace-nowrap">{r.indent_number}</td><td className="p-3">{r.bill_number}</td><td className="p-3"><a className="text-blue-700 underline" href={r.receiving_url} target="_blank" rel="noreferrer">View receiving</a></td><td className="p-3">{r.created_by_name || '—'}</td></tr>)}</tbody>
      </table>
      {!rows.length && <p className="p-6 text-center text-gray-500">{loading ? 'Loading…' : 'No receiving entries yet.'}</p>}
      {!!rows.length && !filtered.length && <p className="p-6 text-center text-gray-500">No matching receiving entries.</p>}
    </div>
    <Pagination {...pagination} />
    <Modal isOpen={open} onClose={() => { if (!saving) setOpen(false); }} title="Add Dispatch Receiving">
      <form onSubmit={save} className="space-y-4">
        <fieldset disabled={saving} className="space-y-4">
          <div><label className="label">Site Name *</label><SearchableSelect options={sites} value={form.site} placeholder="Select Business Book site…" onChange={site => setForm(f => ({ ...f, site: site?.value || '' }))} /></div>
          {/* Typed by hand (mam 2026-09-10) — no dropdown */}
          <div><label className="label" htmlFor="receiving-indent">Indent No. *</label><input id="receiving-indent" className="input" required maxLength={100} placeholder="Enter indent number" value={form.indent_number} onChange={e => setForm({ ...form, indent_number: e.target.value })} /></div>
          <div><label className="label" htmlFor="receiving-bill">Bill Number *</label><input id="receiving-bill" className="input" required maxLength={100} value={form.bill_number} onChange={e => setForm({ ...form, bill_number: e.target.value })} /></div>
          <div><label className="label" htmlFor="receiving-file">Upload Receiving *</label><input id="receiving-file" className="input" type="file" required accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf" onChange={e => setForm({ ...form, file: e.target.files?.[0] || null })} /><p className="mt-1 text-xs text-gray-500">Upload the receiving photo or PDF.</p></div>
        </fieldset>
        <div className="flex justify-end gap-2"><button type="button" className="btn btn-secondary" disabled={saving} onClick={() => setOpen(false)}>Cancel</button><button className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : 'Save Receiving'}</button></div>
      </form>
    </Modal>
  </div>;
}
