// Sales Bill Receive — client sales bill uploaded against an indent.
//
// Flow (Procurement, after Indent to Dispatch):
//   indent number (from indents) → site name (Business Book, auto-filled
//   from the indent) → bill number → upload the received bill.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiDownload, FiTrash2, FiEdit2, FiSearch, FiUpload, FiPaperclip } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { fmtDateTime } from '../utils/datetime';

const emptyForm = () => ({
  indent_id: null,
  site_name: '',
  bill_number: '',
  file_url: '',
  file_name: '',
});

export default function SalesBillReceive() {
  const { canCreate, canEdit, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [indents, setIndents] = useState([]);
  const [sites, setSites] = useState([]);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState(emptyForm());
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    const params = search ? `?search=${encodeURIComponent(search)}` : '';
    api.get(`/sales-bill-receive${params}`).then(r => setRows(r.data || [])).catch(() => setRows([]));
  }, [search]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api.get('/sales-bill-receive/lookups').then(r => {
      setIndents(r.data?.indents || []);
      setSites(r.data?.sites || []);
    }).catch(() => {});
  }, []);

  const indentOptions = indents.map(i => ({
    value: i.id,
    label: i.site_name ? `${i.indent_number} · ${i.site_name}` : i.indent_number,
  }));
  if (form.indent_id && !indentOptions.some(o => o.value === form.indent_id)) {
    indentOptions.unshift({ value: form.indent_id, label: String(form.indent_id) });
  }
  const siteOptions = sites.map(s => ({
    value: s.name,
    label: s.lead_no ? `[${s.lead_no}] ${s.name}` : s.name,
  }));
  if (form.site_name && !siteOptions.some(s => s.value === form.site_name)) {
    siteOptions.unshift({ value: form.site_name, label: form.site_name });
  }

  const openAdd = () => { setForm(emptyForm()); setModal(true); };
  const openEdit = (row) => {
    setForm({
      id: row.id,
      indent_id: row.indent_id,
      site_name: row.site_name || '',
      bill_number: row.bill_number || '',
      file_url: row.file_url || '',
      file_name: row.file_name || '',
    });
    setModal(true);
  };

  const pickIndent = (opt) => {
    if (!opt) {
      setForm(f => ({ ...f, indent_id: null, site_name: '' }));
      return;
    }
    const indent = indents.find(i => i.id === opt.value);
    setForm(f => ({
      ...f,
      indent_id: opt.value,
      site_name: indent?.site_name || f.site_name || '',
    }));
  };

  const uploadFile = async (file) => {
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, file_url: r.data.url, file_name: r.data.filename || file.name }));
      toast.success('File uploaded');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const save = async (e) => {
    e.preventDefault();
    if (!form.indent_id) return toast.error('Pick an indent number');
    if (!form.site_name?.trim()) return toast.error('Site name is required');
    if (!form.bill_number?.trim()) return toast.error('Bill number is required');
    if (!form.file_url) return toast.error('Upload the received bill');
    setSaving(true);
    try {
      const payload = {
        indent_id: form.indent_id,
        site_name: form.site_name.trim(),
        bill_number: form.bill_number.trim(),
        file_url: form.file_url,
        file_name: form.file_name || null,
      };
      if (form.id) {
        await api.put(`/sales-bill-receive/${form.id}`, payload);
        toast.success('Updated');
      } else {
        await api.post('/sales-bill-receive', payload);
        toast.success('Sales bill received');
      }
      setModal(false);
      setForm(emptyForm());
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (row) => {
    if (!confirm(`Delete bill ${row.bill_number} for ${row.indent_number}?`)) return;
    try {
      await api.delete(`/sales-bill-receive/${row.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <FiDownload className="text-emerald-600" /> Sales Bill Receive
          </h1>
          <p className="text-sm text-gray-500">
            Record a received sales bill against an indent — indent number, site from Business Book, bill number, then upload.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => exportCsv('sales-bill-receive',
              ['Indent No', 'Site', 'Bill Number', 'Received By', 'Received At'],
              rows.map(r => [r.indent_number, r.site_name, r.bill_number, r.received_by_name, r.received_at]))}
            className="btn btn-secondary flex items-center gap-1 text-sm">
            <FiDownload size={14} /> Export Excel
          </button>
          {canCreate('sales_bill_receive') && (
            <button onClick={openAdd} className="btn btn-primary flex items-center gap-1">
              <FiPlus size={14} /> Receive Bill
            </button>
          )}
        </div>
      </div>

      <div className="card p-3">
        <div className="relative max-w-md">
          <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
          <input
            className="input pl-9 text-sm"
            placeholder="Search indent, site, bill number…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      <div className="card p-0">
        <table className="freeze-head">
          <thead>
            <tr>
              <th>Indent No</th>
              <th>Site Name</th>
              <th>Bill Number</th>
              <th>Received File</th>
              <th>Received By</th>
              <th>Received At</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan="7" className="text-center py-8 text-gray-400">
                  No sales bills received yet — click “Receive Bill” to add one
                </td>
              </tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="font-bold text-indigo-700 text-xs">{r.indent_number || '—'}</td>
                <td className="text-xs">{r.site_name || '—'}</td>
                <td className="text-xs font-medium">{r.bill_number}</td>
                <td className="text-xs">
                  {r.file_url ? (
                    <a href={r.file_url} target="_blank" rel="noreferrer" className="text-blue-600 hover:underline inline-flex items-center gap-1">
                      <FiPaperclip size={12} /> {r.file_name || 'Open file'}
                    </a>
                  ) : <span className="text-gray-300">—</span>}
                </td>
                <td className="text-xs">{r.received_by_name || '—'}</td>
                <td className="text-xs whitespace-nowrap">{r.received_at ? fmtDateTime(r.received_at) : '—'}</td>
                <td className="whitespace-nowrap">
                  {canEdit('sales_bill_receive') && (
                    <button onClick={() => openEdit(r)} className="p-1 text-amber-600 hover:text-amber-800" title="Edit">
                      <FiEdit2 size={14} />
                    </button>
                  )}
                  {canDelete('sales_bill_receive') && (
                    <button onClick={() => remove(r)} className="p-1 text-red-500 hover:text-red-700" title="Delete">
                      <FiTrash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={form.id ? 'Edit Sales Bill Receive' : 'Receive Sales Bill'}>
        <form onSubmit={save} className="space-y-4">
          <div>
            <label className="label">1. Indent Number</label>
            <SearchableSelect
              options={indentOptions}
              value={form.indent_id}
              onChange={pickIndent}
              placeholder="Search indent number…"
            />
          </div>
          <div>
            <label className="label">2. Site Name</label>
            <SearchableSelect
              options={siteOptions}
              value={form.site_name}
              onChange={opt => setForm(f => ({ ...f, site_name: opt?.value || '' }))}
              placeholder="From Business Book…"
            />
            <p className="text-[11px] text-gray-400 mt-1">Filled from the indent; change if the Business Book name is different.</p>
          </div>
          <div>
            <label className="label">3. Bill Number</label>
            <input
              className="input w-full"
              value={form.bill_number}
              onChange={e => setForm(f => ({ ...f, bill_number: e.target.value }))}
              placeholder="Client / sales bill number"
            />
          </div>
          <div>
            <label className="label">4. Upload Receive</label>
            <label className="flex items-center gap-2 btn btn-secondary cursor-pointer w-fit text-sm">
              <FiUpload size={14} /> {uploading ? 'Uploading…' : (form.file_url ? 'Replace file' : 'Choose file')}
              <input type="file" className="hidden" disabled={uploading} onChange={e => uploadFile(e.target.files?.[0])} />
            </label>
            {form.file_url && (
              <a href={form.file_url} target="_blank" rel="noreferrer" className="mt-2 text-xs text-blue-600 hover:underline inline-flex items-center gap-1">
                <FiPaperclip size={12} /> {form.file_name || 'Uploaded file'}
              </a>
            )}
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" className="btn btn-secondary" onClick={() => setModal(false)}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={saving || uploading}>
              {saving ? 'Saving…' : (form.id ? 'Update' : 'Save')}
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
