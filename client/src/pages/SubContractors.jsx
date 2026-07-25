import { useState, useEffect } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiPhone, FiMapPin, FiDownload, FiUsers, FiKey, FiCalendar, FiCheckCircle } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { useAuth } from '../context/AuthContext';
import { STATES, DISTRICTS_BY_STATE, CONTRACTOR_TYPES } from '../data/indiaLocations';

// Sub-Contractor master list. Mirrors mam's Google Form 1:1 (Name, Contact,
// Location, Type, Experience, Manpower, Tools Y/N, GST Y/N, Rate, Days to
// Start) plus a few practical fields (GST number when applicable, notes,
// active toggle).
//
// Location is split: State (dropdown of 36 states/UTs) + District (cascades
// from selected state) + optional address text. Type is a dropdown of MEPF
// trade categories.

const blankForm = () => ({
  name: '', phone: '', state: '', district: '', location_extra: '',
  contractor_type: '', experience_years: 0, manpower: 0,
  with_tools: false, has_gst: false, gst_number: '', rate_in_budget: '',
  start_within_days: 0, notes: '', active: true, work_order_file: '',
});

export default function SubContractors() {
  const { isAdmin } = useAuth();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState({ q: '', state: '', contractor_type: '', active: '1' });
  const [modal, setModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [saving, setSaving] = useState(false);
  const [uploadingWO, setUploadingWO] = useState(false);

  // ── Crew Access (director ask, 2026-07-25; "no work order no attendance"):
  // admin manages a sub-contractor's self-service login, sees which sites
  // they can currently submit attendance for (derived live from active Work
  // Orders — no manual assignment step), and reviews their submitted crew
  // attendance.
  const [crewModal, setCrewModal] = useState(false);
  const [crewRow, setCrewRow] = useState(null);
  const [crewWoSites, setCrewWoSites] = useState([]);
  const [crewLog, setCrewLog] = useState([]);
  const [crewBusy, setCrewBusy] = useState(false);
  const [crewCreds, setCrewCreds] = useState(null); // shown once, right after Create Login

  const openCrew = (row) => {
    setCrewRow(row);
    setCrewCreds(null);
    setCrewModal(true);
    api.get(`/sub-contractors/${row.id}/work-order-sites`).then(r => setCrewWoSites(r.data || [])).catch(() => setCrewWoSites([]));
    api.get(`/sub-contractors/${row.id}/attendance-log`).then(r => setCrewLog(r.data || [])).catch(() => setCrewLog([]));
  };

  const createLogin = async () => {
    if (!crewRow) return;
    setCrewBusy(true);
    try {
      const { data } = await api.post(`/sub-contractors/${crewRow.id}/create-login`, {});
      setCrewCreds(data);
      toast.success('Login created — share these credentials with the sub-contractor');
      load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create login'); }
    finally { setCrewBusy(false); }
  };

  const load = () => {
    setLoading(true);
    const params = {};
    if (filter.q) params.q = filter.q;
    if (filter.state) params.state = filter.state;
    if (filter.contractor_type) params.contractor_type = filter.contractor_type;
    if (filter.active !== '1') params.active = filter.active;
    api.get('/sub-contractors', { params }).then(r => setRows(r.data))
      .catch(e => toast.error(e.response?.data?.error || 'Load failed'))
      .finally(() => setLoading(false));
  };
  useEffect(load, [filter.q, filter.state, filter.contractor_type, filter.active]);

  const openAdd = () => { setEditing(null); setForm(blankForm()); setModal(true); };
  const openEdit = (row) => {
    setEditing(row);
    setForm({
      ...row,
      with_tools: !!row.with_tools,
      has_gst: !!row.has_gst,
      active: !!row.active,
    });
    setModal(true);
  };

  const districtsForState = form.state ? (DISTRICTS_BY_STATE[form.state] || []) : [];

  const save = async (e) => {
    e.preventDefault();
    if (!form.name?.trim()) { toast.error('Name is required'); return; }
    setSaving(true);
    try {
      if (editing) {
        await api.put(`/sub-contractors/${editing.id}`, form);
        toast.success('Sub-contractor updated');
      } else {
        await api.post('/sub-contractors', form);
        toast.success('Sub-contractor added');
      }
      setModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  // Optional Work Order document upload (mam) — PDF / image / Excel.
  // Uploads to the shared /upload endpoint and stores the returned URL on
  // the form; the JSON save then persists work_order_file like any field.
  const uploadWorkOrder = async (file) => {
    if (!file) return;
    setUploadingWO(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      setForm(f => ({ ...f, work_order_file: r.data.url }));
      toast.success('Work order attached');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploadingWO(false);
    }
  };

  const toggleActive = async (row) => {
    try {
      await api.patch(`/sub-contractors/${row.id}/active`, { active: !row.active });
      toast.success(row.active ? 'Deactivated' : 'Activated');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed');
    }
  };

  const remove = async (row) => {
    if (!confirm(`Permanently delete "${row.name}"? Deactivate instead if you may want them back.`)) return;
    try {
      await api.delete(`/sub-contractors/${row.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-gray-800">Sub-Contractors</h3>
        <div className="flex gap-2">
          <button onClick={() => exportCsv('sub-contractors',
            ['Name','Type','Contact','District','State','Experience','Manpower','Tools','GST','Rate','Status'],
            rows.map(c => [c.name, c.contractor_type, c.contact_number, c.district, c.state, c.experience_years, c.manpower_strength, c.tools_owned, c.gst_number, c.rate_vs_budget, c.status]))}
            className="btn btn-secondary flex items-center gap-2"><FiDownload /> Export Excel</button>
          <button onClick={openAdd} className="btn btn-primary flex items-center gap-2">
            <FiPlus /> Add Sub-Contractor
          </button>
        </div>
      </div>

      <div className="card p-3 grid grid-cols-1 sm:grid-cols-4 gap-2">
        <input className="input text-sm" placeholder="Search name / contact / type / district"
          value={filter.q} onChange={e => setFilter(f => ({ ...f, q: e.target.value }))} />
        <select className="select text-sm" value={filter.state}
          onChange={e => setFilter(f => ({ ...f, state: e.target.value }))}>
          <option value="">All states</option>
          {STATES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select className="select text-sm" value={filter.contractor_type}
          onChange={e => setFilter(f => ({ ...f, contractor_type: e.target.value }))}>
          <option value="">All types</option>
          {CONTRACTOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <select className="select text-sm" value={filter.active}
          onChange={e => setFilter(f => ({ ...f, active: e.target.value }))}>
          <option value="1">Active only</option>
          <option value="0">Inactive only</option>
          <option value="all">All</option>
        </select>
      </div>

      <div className="card p-0">
        <table className="freeze-head">
          <thead>
            <tr>
              <th>Name</th><th>Type</th><th>Contact</th><th>Location</th>
              <th>Exp.</th><th>Manpower</th><th>Tools</th><th>GST</th>
              <th>Rate vs Budget</th><th>Start (days)</th><th>Status</th><th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {loading && <tr><td colSpan="12" className="text-center py-8 text-gray-400">Loading…</td></tr>}
            {!loading && rows.length === 0 && (
              <tr><td colSpan="12" className="text-center py-8 text-gray-400">
                No sub-contractors yet. Click <b>+ Add Sub-Contractor</b> to add one.
              </td></tr>
            )}
            {rows.map(r => (
              <tr key={r.id}>
                <td className="font-medium">{r.name}</td>
                <td><span className="px-2 py-0.5 text-xs bg-gray-100 rounded">{r.contractor_type || '-'}</span></td>
                <td className="text-gray-700"><FiPhone className="inline mr-1 text-gray-400" size={12} />{r.phone || '-'}</td>
                <td className="text-gray-700 text-xs">
                  {(r.district || r.state) ? (
                    <><FiMapPin className="inline mr-1 text-gray-400" size={12} />{[r.district, r.state].filter(Boolean).join(', ')}</>
                  ) : '-'}
                </td>
                <td>{r.experience_years || 0} yr</td>
                <td>{r.manpower || 0}</td>
                <td>{r.with_tools ? <span className="text-green-700">Yes</span> : <span className="text-gray-400">No</span>}</td>
                <td>{r.has_gst ? <span className="text-green-700">Yes</span> : <span className="text-gray-400">No</span>}</td>
                <td className="text-xs">{r.rate_in_budget || '-'}</td>
                <td>{r.start_within_days || '-'}</td>
                <td>
                  <button onClick={() => toggleActive(r)}
                    className={`px-2 py-0.5 rounded text-xs ${r.active ? 'bg-green-100 text-green-800' : 'bg-gray-200 text-gray-600'}`}>
                    {r.active ? 'Active' : 'Inactive'}
                  </button>
                </td>
                <td>
                  <div className="flex gap-1">
                    <button onClick={() => openEdit(r)} className="p-1 text-gray-500 hover:text-red-600" title="Edit"><FiEdit2 size={14} /></button>
                    {isAdmin && <button onClick={() => openCrew(r)} className="p-1 text-gray-500 hover:text-blue-600" title="Crew Access — login, Work-Order sites, attendance"><FiUsers size={14} /></button>}
                    {isAdmin && <button onClick={() => remove(r)} className="p-1 text-gray-400 hover:text-red-600" title="Delete (admin only)"><FiTrash2 size={14} /></button>}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Sub-Contractor' : 'Add Sub-Contractor'} wide>
        <form onSubmit={save} className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Name <span className="text-red-500">*</span></label>
              <input className="input" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} required />
            </div>
            <div>
              <label className="label">Contact Number <span className="text-red-500">*</span></label>
              <input className="input" type="tel" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} required />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">State</label>
              <SearchableSelect
                options={STATES.map(s => ({ value: s, label: s }))}
                value={form.state}
                onChange={(opt) => setForm({ ...form, state: opt?.value || '', district: '' })}
                displayKey="label"
                valueKey="value"
                placeholder="Pick a state"
              />
            </div>
            <div>
              <label className="label">District</label>
              <SearchableSelect
                options={districtsForState.map(d => ({ value: d, label: d }))}
                value={form.district}
                onChange={(opt) => setForm({ ...form, district: opt?.value || '' })}
                displayKey="label"
                valueKey="value"
                placeholder={form.state ? 'Pick a district' : 'Pick a state first'}
              />
            </div>
            <div>
              <label className="label">Address / City <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
              <input className="input" value={form.location_extra} onChange={e => setForm({ ...form, location_extra: e.target.value })} placeholder="Specific address" />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="label">Type of Contractor <span className="text-red-500">*</span></label>
              <select className="select" value={form.contractor_type} onChange={e => setForm({ ...form, contractor_type: e.target.value })} required>
                <option value="">Select</option>
                {CONTRACTOR_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="label">Experience (years) <span className="text-red-500">*</span></label>
              <input className="input" type="number" min="0" value={form.experience_years} onChange={e => setForm({ ...form, experience_years: +e.target.value })} required />
            </div>
            <div>
              <label className="label">Manpower (qty) <span className="text-red-500">*</span></label>
              <input className="input" type="number" min="0" value={form.manpower} onChange={e => setForm({ ...form, manpower: +e.target.value })} required />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Contractor with Tools? <span className="text-red-500">*</span></label>
              <div className="flex gap-4 mt-1">
                {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map(o => (
                  <label key={o.l} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="with_tools" checked={form.with_tools === o.v} onChange={() => setForm({ ...form, with_tools: o.v })} className="w-4 h-4" />
                    <span className="text-sm">{o.l}</span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="label">Have GST? <span className="text-red-500">*</span></label>
              <div className="flex gap-4 mt-1">
                {[{ v: true, l: 'Yes' }, { v: false, l: 'No' }].map(o => (
                  <label key={o.l} className="flex items-center gap-1.5 cursor-pointer">
                    <input type="radio" name="has_gst" checked={form.has_gst === o.v} onChange={() => setForm({ ...form, has_gst: o.v })} className="w-4 h-4" />
                    <span className="text-sm">{o.l}</span>
                  </label>
                ))}
              </div>
            </div>
          </div>

          {form.has_gst && (
            <div>
              <label className="label">GSTIN <span className="text-xs text-gray-400 font-normal">(if available)</span></label>
              <input className="input font-mono text-sm" value={form.gst_number} onChange={e => setForm({ ...form, gst_number: e.target.value.toUpperCase() })} maxLength="15" placeholder="e.g. 08AAACR5055K1Z5" />
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="label">Rate in Company Budget? <span className="text-red-500">*</span></label>
              <input className="input" value={form.rate_in_budget} onChange={e => setForm({ ...form, rate_in_budget: e.target.value })} placeholder="e.g. Yes / No / Rs 850 per sqft" required />
            </div>
            <div>
              <label className="label">Time to Start Site (days) <span className="text-red-500">*</span></label>
              <input className="input" type="number" min="0" value={form.start_within_days} onChange={e => setForm({ ...form, start_within_days: +e.target.value })} required />
            </div>
          </div>

          <div>
            <label className="label">Notes <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
            <textarea className="input" rows="2" value={form.notes} onChange={e => setForm({ ...form, notes: e.target.value })} placeholder="Past projects, references, special skills…" />
          </div>

          <div>
            <label className="label">Work Order File <span className="text-xs text-gray-400 font-normal">(optional)</span></label>
            {form.work_order_file ? (
              <div className="flex items-center gap-3 text-sm">
                <a href={form.work_order_file} target="_blank" rel="noreferrer" className="text-blue-700 underline">View attached work order</a>
                <button type="button" onClick={() => setForm({ ...form, work_order_file: '' })} className="text-red-500 hover:underline">Remove</button>
              </div>
            ) : (
              <input
                type="file"
                accept=".pdf,.doc,.docx,.xls,.xlsx,image/*"
                className="input"
                disabled={uploadingWO}
                onChange={e => uploadWorkOrder(e.target.files?.[0])}
              />
            )}
            {uploadingWO && <p className="text-xs text-gray-500 mt-1">Uploading…</p>}
          </div>

          {editing && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={form.active} onChange={e => setForm({ ...form, active: e.target.checked })} />
              Active (uncheck to hide from default list without deleting)
            </label>
          )}

          <div className="flex justify-end gap-2 pt-2 border-t">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" disabled={saving} className="btn btn-primary">{saving ? 'Saving…' : (editing ? 'Update' : 'Add')}</button>
          </div>
        </form>
      </Modal>

      {/* Crew Access (director ask, 2026-07-25) — self-service login, Work-
          Order-derived site access ("no work order no attendance"), and
          attendance review for one sub-contractor. */}
      <Modal isOpen={crewModal} onClose={() => setCrewModal(false)} title={`Crew Access — ${crewRow?.name || ''}`} wide>
        <div className="space-y-5">
          <div>
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-2"><FiKey size={14} /> Self-Service Login</h4>
            {crewCreds ? (
              <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-sm space-y-1">
                <p className="font-semibold text-emerald-800">Login created — share these with the sub-contractor now (shown once):</p>
                <p>Username: <span className="font-mono font-bold">{crewCreds.username}</span></p>
                <p>Password: <span className="font-mono font-bold">{crewCreds.password}</span></p>
              </div>
            ) : crewRow?.user_id ? (
              <p className="text-sm text-emerald-700 flex items-center gap-1.5"><FiCheckCircle size={14} /> Login already active for this sub-contractor.</p>
            ) : (
              <button onClick={createLogin} disabled={crewBusy} className="btn btn-secondary text-sm">Create Login</button>
            )}
          </div>

          <div>
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-2"><FiMapPin size={14} /> Sites (via active Work Order)</h4>
            <p className="text-xs text-gray-500 mb-2">
              No manual assignment — a sub-contractor can only submit attendance for a site once an <b>active Work Order</b> exists for them there
              (Projects → Indent Labour Payment → Work Orders). "No work order, no attendance."
            </p>
            <div className="max-h-40 overflow-y-auto border border-gray-100 rounded-lg divide-y">
              {crewWoSites.map(s => (
                <div key={s.site_id} className="flex items-center justify-between gap-2 px-2 py-1.5 text-sm">
                  <span>{s.site_name}</span>
                  <span className="text-[10px] text-gray-400 font-mono">{s.wo_number || `WO#${s.work_order_id}`}</span>
                </div>
              ))}
              {crewWoSites.length === 0 && <p className="text-xs text-gray-400 p-2">No active Work Order for this sub-contractor yet — they cannot submit attendance anywhere until one is issued.</p>}
            </div>
          </div>

          <div>
            <h4 className="font-semibold text-sm flex items-center gap-1.5 mb-2"><FiCalendar size={14} /> Recent Attendance (last 30 days)</h4>
            {crewLog.length === 0 ? (
              <p className="text-xs text-gray-400">No attendance submitted yet.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {crewLog.map(a => (
                  <div key={a.id} className="border border-gray-100 rounded-lg p-2 text-xs">
                    <div className="flex justify-between font-medium">
                      <span>{a.attendance_date} — {a.site_name}</span>
                      <span className="text-gray-500">{(a.workers || []).filter(w => w.present).length}/{(a.workers || []).length} present</span>
                    </div>
                    {a.workers?.length > 0 && (
                      <div className="text-gray-500 mt-1">{a.workers.map(w => `${w.name}${w.present ? '' : ' (absent)'}`).join(', ')}</div>
                    )}
                    {a.photos?.length > 0 && (
                      <div className="flex gap-1 mt-1.5">
                        {a.photos.map(p => <img key={p.id} src={p.photo_url} alt="" className="w-14 h-11 object-cover rounded border border-gray-200" />)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Modal>
    </div>
  );
}
