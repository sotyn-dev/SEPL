// Tools Management — catalog every returnable asset (drills, ladders,
// multimeters, safety gear) with its current location (site / user),
// condition, and movement history. Plus weekly tools-list submission
// per site that powers the Supervisor MIS scorecard KPI.

import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import Pagination, { usePagination } from '../components/PaginationBar';
import SearchableSelect from '../components/SearchableSelect';
import StatusMultiSelect from '../components/StatusMultiSelect';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiTool, FiTruck, FiArrowDownCircle, FiAlertCircle, FiEdit2, FiTrash2, FiSearch, FiCalendar, FiClipboard, FiImage, FiX } from 'react-icons/fi';
import { fmtDateTime } from '../utils/datetime';

const CATEGORIES = ['Drilling', 'Cutting', 'Measurement', 'Safety', 'Power', 'Hand', 'Lifting', 'Electrical', 'Other'];
const STATUSES = ['available', 'in_use', 'maintenance', 'lost', 'scrapped'];
const STATUS_PILL = {
  available: 'bg-emerald-100 text-emerald-700',
  in_use: 'bg-blue-100 text-blue-700',
  maintenance: 'bg-amber-100 text-amber-700',
  lost: 'bg-red-100 text-red-700',
  scrapped: 'bg-gray-200 text-gray-600',
};

const CONDITION_PILL = {
  new: 'bg-emerald-50 text-emerald-700 border-emerald-300',
  good: 'bg-blue-50 text-blue-700 border-blue-300',
  fair: 'bg-amber-50 text-amber-700 border-amber-300',
  poor: 'bg-orange-50 text-orange-700 border-orange-300',
  scrap: 'bg-red-50 text-red-700 border-red-300',
};

const lastMonday = () => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset);
  return d.toISOString().slice(0, 10);
};

function BulkToolsModal({ sites, users, items, onClose, onSaved, onPreview }) {
  const newRow = () => ({ key: crypto.randomUUID(), item_master_id: '', quantity: 1, unit: 'Nos', condition: 'good', status: 'available', purchase_price: 0, notes: '', photo_url: '' });
  const [rows, setRows] = useState(() => [newRow()]);
  const [siteId, setSiteId] = useState(null);
  const [userId, setUserId] = useState(null);
  const [busy, setBusy] = useState(false);
  const update = (key, patch) => setRows(previous => previous.map(row => row.key === key ? { ...row, ...patch } : row));
  const upload = async (key, file) => {
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) return toast.error('Choose an image under 5 MB');
    setBusy(true);
    try {
      const body = new FormData(); body.append('file', file);
      const { data } = await api.post('/upload?folder=tools', body, { headers: { 'Content-Type': 'multipart/form-data' } });
      update(key, { photo_url: data.url });
    } catch (err) { toast.error(err.response?.data?.error || 'Photo upload failed'); }
    finally { setBusy(false); }
  };
  const save = async (event) => {
    event.preventDefault();
    if (busy) return;
    if (!siteId) return toast.error('Select a site');
    const missing = rows.findIndex(row => !row.item_master_id);
    if (missing >= 0) return toast.error(`Row ${missing + 1}: select an RGP item`);
    setBusy(true);
    try {
      const { data } = await api.post('/tools/bulk', { site_id: siteId, user_id: userId, items: rows.map(({ key, ...row }) => row) });
      toast.success(`Added ${data.count} tool entries`);
      onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Could not save tool entries'); }
    finally { setBusy(false); }
  };
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} title="Add Multiple Tools — One Site" xwide>
    <form onSubmit={save}>
      <fieldset disabled={busy} className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div><label className="label">Site Name *</label><SearchableSelect options={sites} value={siteId} valueKey="id" displayKey="name" placeholder="Pick site…" onChange={site => setSiteId(site?.id || null)} /></div>
          <div><label className="label">Issued To (optional)</label><SearchableSelect options={users} value={userId} valueKey="id" displayKey="name" placeholder="Pick employee…" onChange={user => setUserId(user?.id || null)} /></div>
        </div>
        <p className="text-xs text-gray-500">All entries will be saved to this site. Each entry receives its own automatic serial number.</p>
        {rows.map((row, index) => <div key={row.key} className="border rounded-lg p-3 space-y-3">
          <div className="flex justify-between items-center"><h3 className="font-semibold text-sm">Item {index + 1}</h3><button type="button" disabled={rows.length === 1} onClick={() => setRows(previous => previous.filter(item => item.key !== row.key))} className="text-sm text-red-600 disabled:opacity-30">Remove</button></div>
          <div><label className="label">RGP Item *</label><SearchableSelect options={items} value={row.item_master_id || null} valueKey="id" displayKey="label" placeholder="Pick an RGP item…" onChange={item => update(row.key, { item_master_id: item?.id || '', purchase_price: item?.current_price || 0 })} /></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <label><span className="label">Quantity *</span><input type="number" required min="0.000001" step="any" className="input" value={row.quantity} onChange={e => update(row.key, { quantity: e.target.value })} /></label>
            <label><span className="label">Unit *</span><input required maxLength={30} className="input" value={row.unit} onChange={e => update(row.key, { unit: e.target.value })} /></label>
            <label><span className="label">Condition</span><select className="select" value={row.condition} onChange={e => update(row.key, { condition: e.target.value })}>{['new', 'good', 'fair', 'poor', 'scrap'].map(value => <option key={value}>{value}</option>)}</select></label>
            <label><span className="label">Status</span><select className="select" value={row.status} onChange={e => update(row.key, { status: e.target.value })}>{STATUSES.map(value => <option key={value} value={value}>{value.replace('_', ' ')}</option>)}</select></label>
            <label><span className="label">Purchase Price (Rs)</span><input type="number" min="0" step="any" className="input" value={row.purchase_price} onChange={e => update(row.key, { purchase_price: e.target.value })} /></label>
            <label className="col-span-2 sm:col-span-3"><span className="label">Notes</span><input className="input" value={row.notes} onChange={e => update(row.key, { notes: e.target.value })} /></label>
          </div>
          <label className="block"><span className="label">Tool Condition Photo</span><input type="file" accept="image/*" className="text-sm max-w-full" onChange={e => { upload(row.key, e.target.files?.[0]); e.target.value = ''; }} /></label>
          {row.photo_url && <div className="flex gap-3 items-center"><button type="button" onClick={() => onPreview({ url: row.photo_url, name: `Item ${index + 1} condition` })}><img src={row.photo_url} alt="Tool condition" className="w-16 h-16 object-cover border rounded cursor-zoom-in" /></button><button type="button" className="text-sm text-red-600" onClick={() => update(row.key, { photo_url: '' })}>Remove photo</button></div>}
        </div>)}
        <button type="button" disabled={rows.length >= 100} className="btn btn-secondary" onClick={() => setRows(previous => [...previous, newRow()])}>+ Add Another Item</button>
        <div className="flex justify-end gap-2 border-t pt-3"><button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button><button type="submit" className="btn btn-primary">{busy ? 'Please wait…' : `Save All (${rows.length})`}</button></div>
      </fieldset>
    </form>
  </Modal>;
}

export default function Tools() {
  const { canCreate, canEdit, canDelete, isAdmin } = useAuth();
  const admin = isAdmin();
  const [tab, setTab] = useUrlTab('catalog');
  const [tools, setTools] = useState([]);
  const [stats, setStats] = useState(null);
  const [rgpSync, setRgpSync] = useState(null);
  const [syncBusy, setSyncBusy] = useState(false);
  const [sites, setSites] = useState([]);
  const [users, setUsers] = useState([]);
  const [rgpItems, setRgpItems] = useState([]);
  const [imagePreview, setImagePreview] = useState(null);
  const [filters, setFilters] = useState({ category: '', status: [], search: '' });
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({});
  const [uploadingPhoto, setUploadingPhoto] = useState(false);
  const [actionTool, setActionTool] = useState(null);
  const [actionType, setActionType] = useState(null);
  const [actionForm, setActionForm] = useState({});
  const [historyTool, setHistoryTool] = useState(null);
  const [submissions, setSubmissions] = useState([]);
  const [submissionWeek, setSubmissionWeek] = useState(lastMonday());
  const [submitForm, setSubmitForm] = useState({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' });
  // Windows the catalog table only — `tools` itself stays the full filtered
  // list (the weekly-submission modal's picker needs every tool).
  const toolsPager = usePagination(tools, { resetKey: [filters.search, filters.category, filters.status] });

  const load = useCallback(() => {
    const params = new URLSearchParams();
    if (filters.category) params.set('category', filters.category);
    if (filters.status.length) params.set('status', filters.status.join(','));
    if (filters.search) params.set('search', filters.search);
    api.get(`/tools?${params}`).then(r => setTools(r.data)).catch(() => { });
    api.get('/tools/stats').then(r => setStats(r.data)).catch(() => { });
  }, [filters]);

  useEffect(() => {
    if (tab === 'catalog' || tab === 'dashboard') load();
    if (tab === 'submissions') {
      api.get(`/tools/submissions/list?week_start=${submissionWeek}`).then(r => setSubmissions(r.data)).catch(() => { });
    }
    api.get('/dpr/sites?all=1').then(r => setSites(r.data)).catch(() => { });
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => { });
    api.get('/tools/lookup/rgp-items').then(r => setRgpItems((r.data || []).map(i => ({
      ...i,
      label: [i.item_code, i.item_name, i.specification, i.size].filter(Boolean).join(' — '),
    })))).catch(() => { });
  }, [tab, load, submissionWeek]);

  useEffect(() => {
    if (admin && (tab === 'dashboard' || tab === 'catalog')) {
      api.get('/tools/rgp-sync').then(r => setRgpSync(r.data)).catch(() => toast.error('Could not load RGP import status'));
    }
  }, [admin, tab]);

  const retryRgp = async (deliveryNoteId) => {
    if (syncBusy) return;
    if (deliveryNoteId && !window.confirm('Only continue if these are ADDITIONAL assets. If this challan moves existing tools, use Issue / Transfer instead. Import as new tools?')) return;
    setSyncBusy(true);
    try {
      const { data } = await api.post('/tools/rgp-sync', deliveryNoteId ? { delivery_note_id: deliveryNoteId, allow_additional_assets: true } : {});
      setRgpSync(data); load();
      toast.success(data.review.length ? 'Checked challans. Review the remaining items below.' : 'RGP tools are up to date');
    } catch (err) { toast.error(err.response?.data?.error || 'RGP import failed'); }
    finally { setSyncBusy(false); }
  };

  const save = async (e) => {
    e.preventDefault();
    if (uploadingPhoto) return;
    const payload = { ...form, quantity: form.quantity ?? 1, unit: form.unit ?? form.resolved_unit ?? 'Nos' };
    try {
      if (form.id) {
        await api.put(`/tools/${form.id}`, payload);
        toast.success('Updated');
      } else {
        const r = await api.post('/tools', payload);
        toast.success(`Added ${r.data.tool_code}`);
      }
      setModal(null);
      setForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const uploadConditionPhoto = async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) return toast.error('Please choose an image');
    if (file.size > 5 * 1024 * 1024) return toast.error('Photo must be under 5 MB');
    setUploadingPhoto(true);
    try {
      const body = new FormData();
      body.append('file', file);
      const { data } = await api.post('/upload?folder=tools', body, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, photo_url: data.url }));
      toast.success('Photo uploaded. Save to attach it to this tool.');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Photo upload failed');
    } finally { setUploadingPhoto(false); }
  };

  const del = async (t) => {
    if (!confirm(`Delete tool "${t.name}" (${t.tool_code})?`)) return;
    try { await api.delete(`/tools/${t.id}`); toast.success('Deleted'); load(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const doAction = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/tools/${actionTool.id}/${actionType}`, actionForm);
      toast.success(`${actionType.charAt(0).toUpperCase() + actionType.slice(1)}d`);
      setActionTool(null);
      setActionType(null);
      setActionForm({});
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const submitWeekly = async (e) => {
    e.preventDefault();
    if (!submitForm.site_id || submitForm.tools_json.length === 0) {
      return toast.error('Pick a site and at least one tool');
    }
    try {
      const r = await api.post('/tools/submissions', submitForm);
      toast.success(`Submitted — ${r.data.tools_count} tools logged`);
      setModal(null);
      setSubmitForm({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' });
      api.get(`/tools/submissions/list?week_start=${submissionWeek}`).then(r => setSubmissions(r.data));
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTool className="text-blue-600" /> Tools Management</h1>
          <p className="text-sm text-gray-500">Returnable assets — catalog, issue, return, weekly site submissions.</p>
        </div>
        {canCreate('tools') && tab === 'catalog' && (
          <div className="flex gap-2 flex-wrap">
          <button onClick={() => { setForm({ condition: 'good', status: 'available', quantity: 1, unit: 'Nos' }); setModal('add'); }} className="btn btn-primary flex items-center gap-1"><FiPlus size={14} /> Add Tool</button>
          <button onClick={() => setModal('bulk')} className="btn btn-secondary flex items-center gap-1"><FiPlus size={14} /> Add Multiple Tools</button>
          </div>
        )}
        {canCreate('tools') && tab === 'submissions' && (
          <button onClick={() => { setSubmitForm({ site_id: '', week_start: lastMonday(), tools_json: [], notes: '' }); setModal('submit'); }} className="btn btn-primary flex items-center gap-1"><FiClipboard size={14} /> Submit Weekly List</button>
        )}
      </div>

      <div className="flex gap-2 flex-wrap text-sm">
        {['dashboard', 'catalog', 'submissions'].map(t => (
          <button key={t} onClick={() => setTab(t)} className={`btn ${tab === t ? 'btn-primary' : 'btn-secondary'}`}>
            {t === 'dashboard' ? 'Dashboard' : t === 'catalog' ? 'All Tools' : 'Weekly Submissions'}
          </button>
        ))}
      </div>

      {/* Dashboard */}
      {(tab === 'dashboard' || tab === 'catalog') && admin && rgpSync && <details className="card p-4">
        <summary className="cursor-pointer font-semibold">RGP challan imports: {rgpSync.imported} tool entries linked · {rgpSync.review.length} challans need review</summary>
        <p className="text-sm text-gray-500 my-3">New and old RGP challans populate Tools with dispatched quantity, indent site and Raised By employee. Value = quantity × recorded challan rate (or indent rate for zero-value RGP challans). Fix missing details in Procurement, then retry. Existing tool movements are preserved.</p>
        <button disabled={syncBusy} onClick={() => retryRgp()} className="btn btn-secondary mb-3">{syncBusy ? 'Checking…' : 'Retry old / unresolved RGP challans'}</button>
        {!!rgpSync.review.length && <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr><th>Challan / Indent</th><th>Site / Raised By</th><th>Needs review</th><th>Action</th></tr></thead>
          <tbody>{rgpSync.review.map(row => <tr key={row.delivery_note_id}>
            <td>{row.document_number || `Challan #${row.delivery_note_id}`}<div className="text-xs text-gray-500">{row.indent_number}</div></td>
            <td>{row.site_name || 'Missing site'}<div className="text-xs text-gray-500">{row.raised_by_name || 'Missing Raised By'}</div></td>
            <td>{row.reason || 'Waiting for import'}</td>
            <td>{row.reason?.startsWith('Possible existing asset') && <button disabled={syncBusy} onClick={() => retryRgp(row.delivery_note_id)} className="btn btn-secondary text-xs">Import as additional assets</button>}</td>
          </tr>)}</tbody>
        </table></div>}
      </details>}
      {tab === 'dashboard' && stats && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="card p-4 border-l-4 border-blue-500"><p className="text-xs text-gray-500">Total Tools</p><p className="text-2xl font-bold">{stats.total}</p></div>
            <div className="card p-4 border-l-4 border-emerald-500"><p className="text-xs text-gray-500">Total Value</p><p className="text-xl font-bold text-emerald-700">Rs {(stats.total_value || 0).toLocaleString('en-IN')}</p></div>
            <div className="card p-4 border-l-4 border-amber-500"><p className="text-xs text-gray-500">Calibration Due (30 days)</p><p className="text-2xl font-bold text-amber-600">{stats.calibration_due_30d}</p></div>
            {stats.by_status?.slice(0, 2).map(s => (
              <div key={s.status} className="card p-4 border-l-4 border-gray-300">
                <p className="text-xs text-gray-500">{s.status.replace('_', ' ')}</p>
                <p className="text-2xl font-bold">{s.c}</p>
              </div>
            ))}
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="p-4 border-b">
              <h3 className="font-bold text-sm">Site-wise Tools</h3>
              <p className="text-xs text-gray-500 mt-1">Current site and assigned site engineers. Count totals recorded quantities. Amount is the recorded total value of tool entries, excluding scrapped tools. RGP imports use dispatched quantity × recorded rate.</p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead><tr><th>Site Name</th><th>Site Engineer</th><th className="text-right">Tools Count</th><th className="text-right">Tools Amount (Rs)</th></tr></thead>
                <tbody>
                  {!stats.by_site && <tr><td colSpan="4" className="text-center py-8 text-gray-400">Site-wise summary unavailable</td></tr>}
                  {stats.by_site?.length === 0 && <tr><td colSpan="4" className="text-center py-8 text-gray-400">No tools recorded yet</td></tr>}
                  {stats.by_site?.map(site => (
                    <tr key={site.site_id ?? 'unassigned'}>
                      <td className="font-medium">{site.site_name}</td>
                      <td>{site.site_engineer_name || (site.site_id == null ? '—' : 'Not assigned')}</td>
                      <td className="text-right tabular-nums">{site.tool_count.toLocaleString('en-IN')}</td>
                      <td className="text-right font-semibold tabular-nums whitespace-nowrap">{site.tools_amount.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                    </tr>
                  ))}
                </tbody>
                {!!stats.by_site?.length && <tfoot><tr className="bg-gray-50 font-bold">
                  <td colSpan="2">Total</td>
                  <td className="text-right tabular-nums">{stats.by_site.reduce((sum, site) => sum + site.tool_count, 0).toLocaleString('en-IN')}</td>
                  <td className="text-right tabular-nums whitespace-nowrap">{stats.by_site.reduce((sum, site) => sum + site.tools_amount, 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr></tfoot>}
              </table>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="card p-4">
              <h3 className="font-bold text-sm mb-3">By Status</h3>
              {stats.by_status.map(s => (
                <div key={s.status} className="flex justify-between text-sm py-1.5 border-b last:border-0">
                  <span className={`px-2 py-0.5 rounded text-[10px] ${STATUS_PILL[s.status] || 'bg-gray-100'}`}>{s.status.replace('_', ' ')}</span>
                  <span className="font-semibold">{s.c}</span>
                </div>
              ))}
            </div>
            <div className="card p-4">
              <h3 className="font-bold text-sm mb-3">By Category</h3>
              {stats.by_category.map(c => (
                <div key={c.category} className="flex justify-between text-sm py-1.5 border-b last:border-0">
                  <span>{c.category}</span>
                  <span className="font-semibold">{c.c}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* Catalog */}
      {tab === 'catalog' && (
        <>
          <div className="card p-3 flex flex-wrap gap-2 items-end">
            <div className="relative flex-1 min-w-[200px]">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input className="input pl-9 text-sm" placeholder="Search by name / code / serial / brand…" value={filters.search} onChange={e => setFilters(f => ({ ...f, search: e.target.value }))} />
            </div>
            <select className="select text-sm w-40" value={filters.category} onChange={e => setFilters(f => ({ ...f, category: e.target.value }))}>
              <option value="">All categories</option>
              {CATEGORIES.map(c => <option key={c}>{c}</option>)}
            </select>
{/* Status - tick as many as you like (mam 2026-09-12). */}
            <div className="w-[248px]">
              <StatusMultiSelect
                options={STATUSES.map(s => ({ id: s, name: s.replace('_', ' ') }))}
                value={filters.status}
                onChange={v => setFilters(f => ({ ...f, status: v }))}
                placeholder="All statuses"
              />
            </div>
          </div>

          <div className="card p-0 overflow-hidden">
            <div className="table-responsive">
              <table className="min-w-[800px]">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Item Master Code</th>
                    <th>Specification / Size</th>
                    <th>Qty</th>
                    <th>Unit</th>
                    <th>Serial</th>
                    <th>Cond.</th>
                    <th>Status</th>
                    <th>Current Site / User</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {tools.length === 0 && <tr><td colSpan="11" className="text-center py-8 text-gray-400">No tools yet — click "Add Tool" to start the catalog</td></tr>}
                  {toolsPager.pageItems.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50">
                      <td className="font-bold text-blue-700 text-xs">{t.tool_code}</td>
                      <td className="font-medium">
                        <div className="flex items-center gap-2">
                          {(t.photo_url || t.item_photo_link) ? (
                            <button type="button" onClick={() => setImagePreview({ url: t.photo_url || t.item_photo_link, name: t.name })} title={t.photo_url ? 'Tool condition photo — click to enlarge' : 'Item Master reference photo — click to enlarge'} className="shrink-0">
                              <img src={t.photo_url || t.item_photo_link} alt={t.name} loading="lazy" className="w-10 h-10 object-cover rounded border border-gray-200 cursor-zoom-in hover:ring-2 hover:ring-blue-300" />
                            </button>
                          ) : <span className="w-10 h-10 rounded border border-dashed border-gray-200 bg-gray-50 flex items-center justify-center shrink-0"><FiImage className="text-gray-300" size={17} /></span>}
                          <span>{t.name}</span>
                        </div>
                      </td>
                      <td className="text-xs font-medium text-blue-700">{t.item_master_code || 'Legacy tool'}</td>
                      <td className="text-xs">{[t.item_specification, t.item_size].filter(Boolean).join(' / ') || '—'}</td>
                      <td className="text-sm font-semibold">{t.quantity ?? 1}</td>
                      <td className="text-xs">{t.resolved_unit || t.unit || 'Nos'}</td>
                      <td className="text-xs text-gray-500">{t.serial_no || '—'}</td>
                      <td><span className={`text-[10px] px-1.5 py-0.5 rounded border ${CONDITION_PILL[t.condition] || 'bg-gray-50'}`}>{t.condition}</span></td>
                      <td><span className={`text-[10px] px-2 py-0.5 rounded font-bold ${STATUS_PILL[t.status]}`}>{t.status.replace('_', ' ')}</span></td>
                      <td className="text-xs">
                        {t.current_user_name && <div>👤 {t.current_user_name}</div>}
                        {t.current_site_name && <div>📍 {t.current_site_name}</div>}
                        {!t.current_user_name && !t.current_site_name && <span className="text-gray-300">Stored</span>}
                      </td>
                      <td className="whitespace-nowrap">
                        <div className="flex gap-1">
                          {canEdit('tools') && t.status === 'available' && (
                            <button onClick={() => { setActionTool(t); setActionType('issue'); setActionForm({}); }} className="btn btn-success text-[10px] px-2 py-1" title="Issue"><FiTruck size={11} /></button>
                          )}
                          {canEdit('tools') && t.status === 'in_use' && (
                            <button onClick={() => { setActionTool(t); setActionType('return'); setActionForm({}); }} className="btn btn-secondary text-[10px] px-2 py-1" title="Return"><FiArrowDownCircle size={11} /></button>
                          )}
                          {canEdit('tools') && t.status !== 'scrapped' && (
                            <>
                              <button onClick={() => { setActionTool(t); setActionType('maintenance'); setActionForm({}); }} className="btn btn-secondary text-[10px] px-2 py-1" title="Maintenance"><FiAlertCircle size={11} /></button>
                            </>
                          )}
                          <button onClick={() => setHistoryTool(t)} className="btn btn-secondary text-[10px] px-2 py-1" title="History">📜</button>
                          {canEdit('tools') && (
                            <button onClick={() => { setForm(t); setModal('add'); }} className="p-1 text-gray-400 hover:text-blue-600"><FiEdit2 size={12} /></button>
                          )}
                          {canDelete('tools') && (
                            <button onClick={() => del(t)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={12} /></button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <Pagination {...toolsPager} />
          </div>
        </>
      )}

      {/* Weekly Submissions */}
      {tab === 'submissions' && (
        <>
          <div className="card p-3 flex items-center gap-3">
            <FiCalendar className="text-gray-400" />
            <div>
              <label className="label">Week starting (Monday)</label>
              <input type="date" className="input" value={submissionWeek} onChange={e => setSubmissionWeek(e.target.value)} />
            </div>
          </div>
          <div className="card p-0 overflow-x-auto">
            <table>
              <thead><tr><th>Week</th><th>Site</th><th>Submitted By</th><th className="text-right">Tools Count</th><th>Photo</th><th>Notes</th></tr></thead>
              <tbody>
                {submissions.length === 0 && <tr><td colSpan="6" className="text-center py-8 text-gray-400">No submissions for this week</td></tr>}
                {submissions.map(s => (
                  <tr key={s.id}>
                    <td className="text-xs">{s.week_start}</td>
                    <td className="font-medium">{s.site_name || '—'}</td>
                    <td className="text-xs">{s.submitted_by_name}</td>
                    <td className="text-right font-bold text-blue-700">{s.tools_count}</td>
                    <td>{s.photo_url ? <a href={s.photo_url} target="_blank" rel="noreferrer" className="text-blue-600 underline text-xs">📎 view</a> : <span className="text-gray-300 text-xs">—</span>}</td>
                    <td className="text-xs text-gray-500 max-w-xs truncate">{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Add / Edit Tool Modal */}
      {modal === 'bulk' && <BulkToolsModal sites={sites} users={users} items={rgpItems} onClose={() => setModal(null)} onSaved={() => { setModal(null); load(); }} onPreview={setImagePreview} />}
      <Modal isOpen={modal === 'add'} onClose={() => { if (!uploadingPhoto) { setModal(null); setForm({}); } }} title={form.id ? `Edit ${form.tool_code}` : 'Add Tool'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="col-span-1 sm:col-span-2">
              <label className="label">RGP Item *</label>
              <SearchableSelect
                options={rgpItems}
                value={form.item_master_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick an RGP item from Item Master…"
                onChange={(i) => setForm(f => ({ ...f, item_master_id: i?.id || '', name: i?.item_name || '', purchase_price: i?.current_price || 0, unit: f.unit ?? 'Nos' }))}
              />
              <p className="text-[10px] text-gray-400 mt-1">Only Item Master entries with type RGP are available.</p>
            </div>
            <div><label htmlFor="tool-quantity" className="label">Quantity *</label><input id="tool-quantity" type="number" step="any" min="0.000001" required className="input" value={form.quantity ?? 1} onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} /></div>
            <div><label htmlFor="tool-unit" className="label">Unit *</label><input id="tool-unit" className="input" required maxLength={30} value={form.unit ?? form.resolved_unit ?? 'Nos'} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="e.g. Nos, SET, MTR" /><p className="text-xs text-gray-500 mt-1">Defaults to Nos. Change if needed.</p></div>
            <div><label htmlFor="tool-serial" className="label">Serial No. (Automatic)</label><input id="tool-serial" className="input bg-gray-50 text-gray-500" readOnly value={form.serial_no || ''} placeholder="Generated when saved" /><p className="text-xs text-gray-500 mt-1">Assigned automatically and cannot be edited.</p></div>
            <div><label className="label">Purchase Date</label><input type="date" className="input" value={form.purchase_date || ''} onChange={e => setForm(f => ({ ...f, purchase_date: e.target.value }))} /></div>
            <div><label className="label">Purchase Price (Rs)</label><input type="number" className="input" value={form.purchase_price || 0} onChange={e => setForm(f => ({ ...f, purchase_price: +e.target.value }))} /></div>
            <div>
              <label className="label">Condition</label>
              <select className="select" value={form.condition || 'good'} onChange={e => setForm(f => ({ ...f, condition: e.target.value }))}>
                {['new', 'good', 'fair', 'poor', 'scrap'].map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Status</label>
              <select className="select" value={form.status || 'available'} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
                {STATUSES.map(s => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}
              </select>
            </div>
            <div><label className="label">Last Calibration</label><input type="date" className="input" value={form.last_calibration_date || ''} onChange={e => setForm(f => ({ ...f, last_calibration_date: e.target.value }))} /></div>
            <div><label className="label">Next Calibration</label><input type="date" className="input" value={form.next_calibration_date || ''} onChange={e => setForm(f => ({ ...f, next_calibration_date: e.target.value }))} /></div>
            {/* Site / user assignment — mam: lets her correct where a tool
                is parked without going through the Issue / Return flow. */}
            <div>
              <label className="label">Site Name / Current Site</label>
              <SearchableSelect
                options={sites}
                value={form.current_site_id || null}
                valueKey="id"
                displayKey="name"
                placeholder="Pick site…"
                onChange={(s) => setForm(f => ({ ...f, current_site_id: s?.id || '' }))}
              />
            </div>
            <div>
              <label className="label">Issued To <span className="text-gray-400 font-normal text-[10px]">(employee)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))}
                value={form.current_user_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Pick employee…"
                onChange={(u) => setForm(f => ({ ...f, current_user_id: u?.id || '' }))}
              />
            </div>
            <div className="col-span-1 sm:col-span-2 space-y-2 rounded-lg border p-3">
              <label htmlFor="tool-condition-photo" className="label">Tool Condition Photo</label>
              <p className="text-xs text-gray-500">Upload a photo of this tool’s actual condition. It will appear in the tools list.</p>
              {form.photo_url && <div className="flex items-center gap-3">
                <button type="button" onClick={() => setImagePreview({ url: form.photo_url, name: form.name || 'Tool condition' })} title="Click to enlarge">
                  <img src={form.photo_url} alt="Tool condition" className="w-20 h-20 object-cover rounded border cursor-zoom-in" />
                </button>
                <button type="button" disabled={uploadingPhoto} onClick={() => setForm(f => ({ ...f, photo_url: '' }))} className="text-sm text-red-600">Remove photo</button>
              </div>}
              <input id="tool-condition-photo" type="file" accept="image/*" disabled={uploadingPhoto} onChange={e => { uploadConditionPhoto(e.target.files?.[0]); e.target.value = ''; }} className="block w-full text-sm" />
              <p className="text-xs text-gray-500">{uploadingPhoto ? 'Uploading…' : 'Images up to 5 MB. Click Save to keep your changes.'}</p>
            </div>
            <div className="col-span-1 sm:col-span-2"><label className="label">Notes</label><textarea className="input" rows="2" value={form.notes || ''} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></div>
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" disabled={uploadingPhoto} onClick={() => { setModal(null); setForm({}); }} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={uploadingPhoto} className="btn btn-primary">{uploadingPhoto ? 'Uploading…' : form.id ? 'Save' : 'Add Tool'}</button>
          </div>
        </form>
      </Modal>

      {/* Action Modal (issue / return / maintenance / scrap) */}
      <Modal isOpen={!!actionTool} onClose={() => { setActionTool(null); setActionType(null); }} title={actionTool && actionType ? `${actionType.charAt(0).toUpperCase() + actionType.slice(1)} — ${actionTool.name}` : ''}>
        {actionTool && actionType && (
          <form onSubmit={doAction} className="space-y-3">
            {actionType === 'issue' && (
              <>
                <div>
                  <label className="label">Issue to Site</label>
                  <SearchableSelect options={sites} value={actionForm.to_site_id || null} valueKey="id" displayKey="name" placeholder="Pick a site…" onChange={(s) => setActionForm(f => ({ ...f, to_site_id: s?.id || '' }))} />
                </div>
                <div>
                  <label className="label">Issue to Person <span className="text-gray-400 font-normal">(optional)</span></label>
                  <SearchableSelect options={users.map(u => ({ ...u, label: u.name + (u.department ? ` — ${u.department}` : '') }))} value={actionForm.to_user_id || null} valueKey="id" displayKey="label" placeholder="Pick a user…" onChange={(u) => setActionForm(f => ({ ...f, to_user_id: u?.id || '' }))} />
                </div>
                <div><label className="label">Expected Return</label><input type="date" className="input" value={actionForm.expected_return_date || ''} onChange={e => setActionForm(f => ({ ...f, expected_return_date: e.target.value }))} /></div>
              </>
            )}
            {actionType === 'return' && (
              <div>
                <label className="label">Condition on Return</label>
                <select className="select" value={actionForm.condition || actionTool.condition} onChange={e => setActionForm(f => ({ ...f, condition: e.target.value }))}>
                  {['new', 'good', 'fair', 'poor', 'scrap'].map(c => <option key={c}>{c}</option>)}
                </select>
              </div>
            )}
            <div><label className="label">Notes</label><textarea className="input" rows="2" value={actionForm.notes || ''} onChange={e => setActionForm(f => ({ ...f, notes: e.target.value }))} /></div>
            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={() => { setActionTool(null); setActionType(null); }} className="btn btn-secondary">Cancel</button>
              <button type="submit" className="btn btn-primary">{actionType.charAt(0).toUpperCase() + actionType.slice(1)}</button>
            </div>
          </form>
        )}
      </Modal>

      {/* History Modal */}
      <Modal isOpen={!!historyTool} onClose={() => setHistoryTool(null)} title={historyTool ? `History — ${historyTool.name} (${historyTool.tool_code})` : ''} wide>
        {historyTool && <ToolHistory id={historyTool.id} />}
      </Modal>

      {imagePreview && (
        <div className="!m-0 fixed inset-0 z-[70] bg-black/80 flex items-center justify-center p-4 cursor-zoom-out" onClick={() => setImagePreview(null)}>
          <img src={imagePreview.url} alt={imagePreview.name} className="max-w-full max-h-full rounded shadow-2xl" onClick={e => e.stopPropagation()} />
          <button type="button" onClick={() => setImagePreview(null)} className="absolute top-4 right-4 text-white/90 hover:text-white" aria-label="Close image"><FiX size={30} /></button>
        </div>
      )}

      {/* Weekly Submission Modal */}
      <Modal isOpen={modal === 'submit'} onClose={() => setModal(null)} title="Submit Weekly Tools List" wide>
        <form onSubmit={submitWeekly} className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Site *</label>
              <SearchableSelect options={sites} value={submitForm.site_id || null} valueKey="id" displayKey="name" placeholder="Pick a site…" onChange={(s) => setSubmitForm(f => ({ ...f, site_id: s?.id || '' }))} />
            </div>
            <div><label className="label">Week starting</label><input type="date" className="input" value={submitForm.week_start} onChange={e => setSubmitForm(f => ({ ...f, week_start: e.target.value }))} /></div>
          </div>
          <div>
            <label className="label">Tools at site (pick from catalog)</label>
            <select multiple size="8" className="input w-full" value={submitForm.tools_json.map(t => t.tool_id)} onChange={e => {
              const ids = Array.from(e.target.selectedOptions).map(o => +o.value);
              const items = tools.filter(t => ids.includes(t.id)).map(t => ({ tool_id: t.id, name: t.name, qty: 1, condition: t.condition }));
              setSubmitForm(f => ({ ...f, tools_json: items }));
            }}>
              {tools.filter(t => t.status !== 'scrapped').map(t => (
                <option key={t.id} value={t.id}>{t.tool_code} — {t.name} ({t.condition})</option>
              ))}
            </select>
            <p className="text-[10px] text-gray-500 mt-1">Hold Ctrl / Cmd to multi-select. {submitForm.tools_json.length} tool(s) selected.</p>
          </div>
          <div><label className="label">Notes</label><textarea className="input" rows="2" value={submitForm.notes} onChange={e => setSubmitForm(f => ({ ...f, notes: e.target.value }))} /></div>
          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setModal(null)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">Submit</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

function ToolHistory({ id }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get(`/tools/${id}`).then(r => setData(r.data)); }, [id]);
  if (!data) return <div className="text-gray-400 text-center py-6">Loading…</div>;
  const acts = {
    issue: { color: 'bg-blue-100 text-blue-700', icon: '📤' },
    return: { color: 'bg-emerald-100 text-emerald-700', icon: '📥' },
    maintenance: { color: 'bg-amber-100 text-amber-700', icon: '🔧' },
    repair: { color: 'bg-amber-100 text-amber-700', icon: '🔧' },
    scrap: { color: 'bg-red-100 text-red-700', icon: '🗑️' },
    transfer: { color: 'bg-purple-100 text-purple-700', icon: '🔄' },
    calibration: { color: 'bg-indigo-100 text-indigo-700', icon: '📏' },
  };
  return (
    <div className="space-y-2 max-h-[60vh] overflow-y-auto">
      {data.movements.length === 0 && <div className="text-center py-6 text-gray-400">No movements yet — issue this tool to start the trail.</div>}
      {data.movements.map(m => (
        <div key={m.id} className="border rounded p-3 text-sm">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className={`text-[10px] px-2 py-0.5 rounded font-bold ${acts[m.action]?.color || 'bg-gray-100'}`}>{acts[m.action]?.icon} {m.action}</span>
              <span className="text-[11px] text-gray-500 ml-2">by {m.created_by_name || 'unknown'} · {fmtDateTime(m.created_at)}</span>
            </div>
          </div>
          <div className="text-xs text-gray-700 mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1">
            {m.from_site_name && <div>From site: <b>{m.from_site_name}</b></div>}
            {m.to_site_name && <div>To site: <b>{m.to_site_name}</b></div>}
            {m.from_user_name && <div>From user: <b>{m.from_user_name}</b></div>}
            {m.to_user_name && <div>To user: <b>{m.to_user_name}</b></div>}
            {m.expected_return_date && <div>Expected return: <b>{m.expected_return_date}</b></div>}
            {m.actual_return_date && <div>Actual return: <b>{m.actual_return_date}</b></div>}
            {m.condition_at_action && <div>Condition: <b>{m.condition_at_action}</b></div>}
          </div>
          {m.notes && <p className="text-xs text-gray-600 mt-1.5 italic">"{m.notes}"</p>}
          {m.photo_url && <a href={m.photo_url} target="_blank" rel="noreferrer" className="text-blue-600 text-xs underline mt-1 inline-block">📎 photo</a>}
        </div>
      ))}
    </div>
  );
}
