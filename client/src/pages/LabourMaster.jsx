// Labour Management System — Labour Master (Module 3).
//
//   Roster          individual worker records (ID/name/mobile/Aadhaar/trade/wage)
//   Attendance      daily present/absent/half-day + overtime, per site
//   Transfers       site-to-site move log
//   Wage Register   computed report — days present × daily wage + overtime
//   Daily Progress  brief per-site daily note + headcount
//
// The Wage Register tab has no "Save" button — it's a derived report over
// Roster + Attendance, same principle as the Labour Rate Master's own
// reports tab (server never stores a duplicate of a number it can compute).
import { useState, useEffect, useCallback } from 'react';
import api from '../api';
import toast from 'react-hot-toast';
import Modal from '../components/Modal';
import { useAuth } from '../context/AuthContext';
import { useUrlTab } from '../hooks/useUrlTab';
import {
  FiUsers, FiCalendar, FiRepeat, FiDollarSign, FiTrendingUp, FiPlus, FiEdit2,
  FiTrash2, FiSearch, FiCheck, FiX, FiUpload,
} from 'react-icons/fi';

const money = (n) => 'Rs ' + Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 });
const today = () => new Date().toLocaleDateString('en-CA');

const emptyLabour = { name: '', mobile: '', aadhaar_number: '', trade: '', department: '', manpower_type: '', document_url: '', daily_wage: '', site_id: '', status: 'active', remarks: '' };
const MANPOWER_TYPE_LABEL = {
  contractor_manpower: 'Contractor Manpower', sepl_team: 'SEPL Team', daily_wages_team: 'Daily Wages Team',
};

export default function LabourMaster() {
  const [tab, setTab] = useUrlTab('roster');
  const { canCreate, canEdit, canDelete } = useAuth();
  const [sites, setSites] = useState([]);

  useEffect(() => { api.get('/dpr/sites', { params: { all: 1 } }).then(r => setSites(r.data || [])).catch(() => setSites([])); }, []);

  const TABS = [
    ['roster', 'Roster', FiUsers],
    ['attendance', 'Attendance', FiCalendar],
    ['transfers', 'Transfers', FiRepeat],
    ['wage', 'Wage Register', FiDollarSign],
    ['progress', 'Daily Progress', FiTrendingUp],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2">
          <FiUsers className="text-red-600" /> Labour Master
        </h1>
        <p className="text-sm text-gray-500">Individual worker roster, attendance, transfers and wage register.</p>
      </div>

      <div className="flex gap-2 border-b border-gray-200 flex-wrap">
        {TABS.map(([k, text, Icon]) => (
          <button key={k} onClick={() => setTab(k)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-1.5 ${tab === k
              ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icon size={14} /> {text}
          </button>
        ))}
      </div>

      {tab === 'roster' && <RosterTab sites={sites} canCreate={canCreate} canEdit={canEdit} canDelete={canDelete} />}
      {tab === 'attendance' && <AttendanceTab sites={sites} canCreate={canCreate} />}
      {tab === 'transfers' && <TransfersTab sites={sites} canCreate={canCreate} />}
      {tab === 'wage' && <WageTab sites={sites} />}
      {tab === 'progress' && <ProgressTab sites={sites} canCreate={canCreate} />}
    </div>
  );
}

// ─── Roster ────────────────────────────────────────────────────────────
function RosterTab({ sites, canCreate, canEdit, canDelete }) {
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(null);
  const [form, setForm] = useState({ ...emptyLabour });
  const F = (k, v) => setForm(f => ({ ...f, [k]: v }));
  const [uploadingDoc, setUploadingDoc] = useState(false);

  const uploadDocument = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) return toast.error('File too large (max 10 MB)');
    setUploadingDoc(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      F('document_url', r.data?.url || '');
      toast.success('Document attached');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Upload failed');
    } finally {
      setUploadingDoc(false);
    }
  };

  const load = useCallback(() => {
    api.get('/labour-master', { params: search ? { search } : {} })
      .then(r => setRows(r.data || [])).catch(() => toast.error('Could not load roster'));
  }, [search]);
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (!form.name.trim()) return toast.error('Name is required');
    try {
      const payload = { ...form, daily_wage: Number(form.daily_wage) || 0, site_id: form.site_id || null };
      if (modal === 'edit') { await api.put(`/labour-master/${form.id}`, payload); toast.success('Updated'); }
      else { await api.post('/labour-master', payload); toast.success('Worker added'); }
      setModal(null); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  const del = async (row) => {
    if (!window.confirm(`Delete ${row.name}?`)) return;
    try { await api.delete(`/labour-master/${row.id}`); toast.success('Deleted'); load(); }
    catch (e) { toast.error(e.response?.data?.error || 'Delete failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 items-center justify-between">
        <div className="relative w-full sm:w-72">
          <FiSearch className="absolute left-2 top-2.5 text-gray-400" size={14} />
          <input className="input pl-7 text-sm" placeholder="Name, code, mobile, trade" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        {canCreate('labour_master') && (
          <button onClick={() => { setForm({ ...emptyLabour }); setModal('add'); }} className="btn btn-primary flex items-center gap-1 text-sm"><FiPlus size={14} /> Add Worker</button>
        )}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Mobile</th>
            <th className="px-3 py-2 text-left">Trade</th>
            <th className="px-3 py-2 text-left">Type</th>
            <th className="px-3 py-2 text-left">Site</th>
            <th className="px-3 py-2 text-right">Daily Wage</th>
            <th className="px-3 py-2 text-center">Status</th>
            <th className="px-3 py-2 text-center">Actions</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id} className="hover:bg-red-50/30">
                <td className="px-3 py-2 font-mono text-xs font-bold text-red-600">{r.labour_code}</td>
                <td className="px-3 py-2">
                  <div className="flex items-center gap-1">
                    {r.name}
                    {r.document_url && (
                      <a href={r.document_url} target="_blank" rel="noreferrer" title="View document"
                        className="text-gray-400 hover:text-blue-600">
                        <FiUpload size={11} />
                      </a>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 text-xs">{r.mobile || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.trade || '—'}</td>
                <td className="px-3 py-2 text-xs">{MANPOWER_TYPE_LABEL[r.manpower_type] || '—'}</td>
                <td className="px-3 py-2 text-xs">{r.site_name || '—'}</td>
                <td className="px-3 py-2 text-right">{money(r.daily_wage)}</td>
                <td className="px-3 py-2 text-center">
                  <span className={`text-[10px] px-1.5 py-0.5 rounded ${r.status === 'active' ? 'bg-emerald-100 text-emerald-700' : 'bg-gray-100 text-gray-500'}`}>{r.status}</span>
                </td>
                <td className="px-3 py-2 text-center">
                  <div className="flex items-center justify-center gap-1">
                    {canEdit('labour_master') && <button onClick={() => { setForm({ ...r, site_id: r.site_id || '' }); setModal('edit'); }} className="p-1 text-gray-400 hover:text-amber-600"><FiEdit2 size={13} /></button>}
                    {canDelete('labour_master') && <button onClick={() => del(r)} className="p-1 text-gray-400 hover:text-red-600"><FiTrash2 size={13} /></button>}
                  </div>
                </td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={9} className="text-center py-8 text-gray-400">No workers found</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal === 'add' || modal === 'edit'} onClose={() => setModal(null)} title={modal === 'edit' ? `Edit — ${form.labour_code || ''}` : 'Add Worker'}>
        <form onSubmit={save} className="space-y-3">
          <div><label className="label">Name *</label><input className="input" value={form.name} onChange={e => F('name', e.target.value)} required /></div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Mobile</label><input className="input" value={form.mobile || ''} onChange={e => F('mobile', e.target.value)} /></div>
            <div><label className="label">Aadhaar</label><input className="input" value={form.aadhaar_number || ''} onChange={e => F('aadhaar_number', e.target.value)} /></div>
          </div>
          <div>
            <label className="label">Worker Document (PDF / JPG)</label>
            {form.document_url ? (
              <div className="flex items-center gap-2">
                <a href={form.document_url} target="_blank" rel="noreferrer"
                  className="inline-flex items-center gap-1 px-2 py-1.5 bg-gray-100 rounded border border-gray-300 text-xs text-blue-700 hover:underline">
                  <FiUpload size={12} /> View file
                </a>
                <button type="button" onClick={() => F('document_url', '')}
                  className="text-xs text-red-600 hover:underline">Remove</button>
              </div>
            ) : (
              <label className="flex items-center gap-1.5 text-xs text-blue-700 hover:text-blue-900 cursor-pointer px-2 py-1.5 bg-blue-50 border border-blue-200 rounded w-fit">
                <FiUpload size={13} /> {uploadingDoc ? 'Uploading…' : 'Choose file'}
                <input type="file" accept="application/pdf,image/jpeg,image/jpg" className="hidden"
                  disabled={uploadingDoc} onChange={e => uploadDocument(e.target.files?.[0])} />
              </label>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Trade</label><input className="input" value={form.trade || ''} onChange={e => F('trade', e.target.value)} placeholder="Electrician, Helper…" /></div>
            <div><label className="label">Department</label><input className="input" value={form.department || ''} onChange={e => F('department', e.target.value)} /></div>
          </div>
          <div><label className="label">Type of Manpower</label>
            <select className="select" value={form.manpower_type || ''} onChange={e => F('manpower_type', e.target.value)}>
              <option value="">Select…</option>
              {Object.entries(MANPOWER_TYPE_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="label">Daily Wage *</label><input type="number" min="0" className="input" value={form.daily_wage} onChange={e => F('daily_wage', e.target.value)} required /></div>
            <div><label className="label">Site</label>
              <select className="select" value={form.site_id || ''} onChange={e => F('site_id', e.target.value)}>
                <option value="">Unassigned</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>
          {modal === 'edit' && (
            <div><label className="label">Status</label>
              <select className="select" value={form.status} onChange={e => F('status', e.target.value)}>
                <option value="active">Active</option><option value="inactive">Inactive</option>
              </select>
            </div>
          )}
          <div><label className="label">Remarks</label><input className="input" value={form.remarks || ''} onChange={e => F('remarks', e.target.value)} /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModal(null)} className="btn">Cancel</button>
            <button type="submit" className="btn btn-primary">Save</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ─── Attendance ────────────────────────────────────────────────────────
function AttendanceTab({ sites, canCreate }) {
  const [date, setDate] = useState(today());
  const [siteId, setSiteId] = useState('');
  const [workers, setWorkers] = useState([]);
  const [marks, setMarks] = useState({}); // labour_id -> { status, overtime_hours }
  const [existing, setExisting] = useState([]);

  const loadWorkers = useCallback(() => {
    api.get('/labour-master', { params: { status: 'active', ...(siteId ? { site_id: siteId } : {}) } })
      .then(r => setWorkers(r.data || [])).catch(() => setWorkers([]));
  }, [siteId]);
  useEffect(() => { loadWorkers(); }, [loadWorkers]);

  const loadExisting = useCallback(() => {
    api.get('/labour-master/attendance/list', { params: { date, ...(siteId ? { site_id: siteId } : {}) } })
      .then(r => {
        setExisting(r.data || []);
        const m = {};
        for (const row of (r.data || [])) m[row.labour_id] = { status: row.status, overtime_hours: row.overtime_hours };
        setMarks(m);
      }).catch(() => {});
  }, [date, siteId]);
  useEffect(() => { loadExisting(); }, [loadExisting]);

  const setMark = (labourId, field, value) => {
    setMarks(m => ({ ...m, [labourId]: { status: 'present', overtime_hours: 0, ...m[labourId], [field]: value } }));
  };

  const saveAll = async () => {
    const entries = workers.map(w => ({
      labour_id: w.id, site_id: siteId || w.site_id,
      status: marks[w.id]?.status || 'present', overtime_hours: Number(marks[w.id]?.overtime_hours) || 0,
    }));
    if (!entries.length) return toast.error('No workers to mark');
    try {
      await api.post('/labour-master/attendance/bulk', { date, site_id: siteId || null, entries });
      toast.success(`Attendance saved for ${entries.length} worker(s)`);
      loadExisting();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div><label className="label text-xs">Date</label><input type="date" className="input" value={date} onChange={e => setDate(e.target.value)} /></div>
        <div><label className="label text-xs">Site</label>
          <select className="select" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        {canCreate('labour_master') && <button onClick={saveAll} className="btn btn-primary text-sm ml-auto">Save Attendance</button>}
      </div>

      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-left">Trade</th>
            <th className="px-3 py-2 text-center">Present</th>
            <th className="px-3 py-2 text-center">Half Day</th>
            <th className="px-3 py-2 text-center">Absent</th>
            <th className="px-3 py-2 text-center">OT Hours</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {workers.map(w => {
              const mark = marks[w.id] || { status: 'present', overtime_hours: 0 };
              return (
                <tr key={w.id}>
                  <td className="px-3 py-2 font-mono text-xs">{w.labour_code}</td>
                  <td className="px-3 py-2">{w.name}</td>
                  <td className="px-3 py-2 text-xs">{w.trade || '—'}</td>
                  {['present', 'half_day', 'absent'].map(s => (
                    <td key={s} className="px-3 py-2 text-center">
                      <input type="radio" name={`status-${w.id}`} checked={mark.status === s} onChange={() => setMark(w.id, 'status', s)} />
                    </td>
                  ))}
                  <td className="px-3 py-2 text-center">
                    <input type="number" min="0" step="0.5" className="input w-16 text-center py-1" value={mark.overtime_hours}
                      onChange={e => setMark(w.id, 'overtime_hours', e.target.value)} />
                  </td>
                </tr>
              );
            })}
            {workers.length === 0 && <tr><td colSpan={6} className="text-center py-8 text-gray-400">No active workers for this site</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Transfers ────────────────────────────────────────────────────────
function TransfersTab({ sites, canCreate }) {
  const [rows, setRows] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [modal, setModal] = useState(false);
  const [form, setForm] = useState({ labour_id: '', to_site_id: '', transfer_date: today(), reason: '' });

  const load = useCallback(() => { api.get('/labour-master/transfers').then(r => setRows(r.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); api.get('/labour-master', { params: { status: 'active' } }).then(r => setWorkers(r.data || [])).catch(() => {}); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (!form.labour_id || !form.to_site_id) return toast.error('Worker and destination site are required');
    try {
      await api.post('/labour-master/transfers', form);
      toast.success('Transfer recorded');
      setModal(false); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Transfer failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        {canCreate('labour_master') && <button onClick={() => { setForm({ labour_id: '', to_site_id: '', transfer_date: today(), reason: '' }); setModal(true); }} className="btn btn-primary flex items-center gap-1 text-sm"><FiPlus size={14} /> New Transfer</button>}
      </div>
      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Worker</th>
            <th className="px-3 py-2 text-left">From</th>
            <th className="px-3 py-2 text-left">To</th>
            <th className="px-3 py-2 text-left">Reason</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.transfer_date}</td>
                <td className="px-3 py-2">{r.labour_code} — {r.labour_name}</td>
                <td className="px-3 py-2 text-xs">{r.from_site_name || '—'}</td>
                <td className="px-3 py-2 text-xs font-medium">{r.to_site_name}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.reason || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No transfers yet</td></tr>}
          </tbody>
        </table>
      </div>

      <Modal isOpen={modal} onClose={() => setModal(false)} title="New Transfer">
        <form onSubmit={save} className="space-y-3">
          <div><label className="label">Worker *</label>
            <select className="select" value={form.labour_id} onChange={e => setForm(f => ({ ...f, labour_id: e.target.value }))} required>
              <option value="">Select worker</option>
              {workers.map(w => <option key={w.id} value={w.id}>{w.labour_code} — {w.name} ({w.site_name || 'unassigned'})</option>)}
            </select>
          </div>
          <div><label className="label">To Site *</label>
            <select className="select" value={form.to_site_id} onChange={e => setForm(f => ({ ...f, to_site_id: e.target.value }))} required>
              <option value="">Select site</option>
              {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
            </select>
          </div>
          <div><label className="label">Transfer Date *</label><input type="date" className="input" value={form.transfer_date} onChange={e => setForm(f => ({ ...f, transfer_date: e.target.value }))} required /></div>
          <div><label className="label">Reason</label><input className="input" value={form.reason} onChange={e => setForm(f => ({ ...f, reason: e.target.value }))} /></div>
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={() => setModal(false)} className="btn">Cancel</button>
            <button type="submit" className="btn btn-primary">Transfer</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}

// ─── Wage Register ────────────────────────────────────────────────────
function WageTab({ sites }) {
  const [from, setFrom] = useState(today().slice(0, 8) + '01');
  const [to, setTo] = useState(today());
  const [siteId, setSiteId] = useState('');
  const [data, setData] = useState(null);

  const load = useCallback(() => {
    api.get('/labour-master/wage-register', { params: { from, to, ...(siteId ? { site_id: siteId } : {}) } })
      .then(r => setData(r.data)).catch(() => toast.error('Could not load wage register'));
  }, [from, to, siteId]);
  useEffect(() => { load(); }, [load]);

  return (
    <div className="space-y-3">
      <div className="card p-3 flex flex-wrap gap-3 items-end">
        <div><label className="label text-xs">From</label><input type="date" className="input" value={from} onChange={e => setFrom(e.target.value)} /></div>
        <div><label className="label text-xs">To</label><input type="date" className="input" value={to} onChange={e => setTo(e.target.value)} /></div>
        <div><label className="label text-xs">Site</label>
          <select className="select" value={siteId} onChange={e => setSiteId(e.target.value)}>
            <option value="">All sites</option>
            {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        </div>
        <a href={`/wage-register-print?from=${from}&to=${to}`} target="_blank" rel="noreferrer" className="btn text-sm ml-auto">Export PDF</a>
      </div>
      <div className="card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Code</th>
            <th className="px-3 py-2 text-left">Name</th>
            <th className="px-3 py-2 text-right">Days Present</th>
            <th className="px-3 py-2 text-right">Days Absent</th>
            <th className="px-3 py-2 text-right">OT Hours</th>
            <th className="px-3 py-2 text-right">Wage Due</th>
            <th className="px-3 py-2 text-right">OT Due</th>
            <th className="px-3 py-2 text-right">Total Due</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {(data?.rows || []).map(r => (
              <tr key={r.labour_id}>
                <td className="px-3 py-2 font-mono text-xs">{r.labour_code}</td>
                <td className="px-3 py-2">{r.name}</td>
                <td className="px-3 py-2 text-right">{r.days_present}</td>
                <td className="px-3 py-2 text-right">{r.days_absent}</td>
                <td className="px-3 py-2 text-right">{r.overtime_hours}</td>
                <td className="px-3 py-2 text-right">{money(r.wage_due)}</td>
                <td className="px-3 py-2 text-right">{money(r.overtime_due)}</td>
                <td className="px-3 py-2 text-right font-semibold text-emerald-700">{money(r.total_due)}</td>
              </tr>
            ))}
            {(!data || data.rows.length === 0) && <tr><td colSpan={8} className="text-center py-8 text-gray-400">No attendance in this range</td></tr>}
          </tbody>
          {data && data.rows.length > 0 && (
            <tfoot><tr className="bg-gray-50 font-semibold">
              <td colSpan={7} className="px-3 py-2 text-right">Total</td>
              <td className="px-3 py-2 text-right text-emerald-700">{money(data.total_due)}</td>
            </tr></tfoot>
          )}
        </table>
      </div>
    </div>
  );
}

// ─── Daily Progress ────────────────────────────────────────────────────
function ProgressTab({ sites, canCreate }) {
  const [rows, setRows] = useState([]);
  const [form, setForm] = useState({ site_id: '', date: today(), labourers_present: '', progress_notes: '', progress_pct: '' });

  const load = useCallback(() => { api.get('/labour-master/daily-progress').then(r => setRows(r.data || [])).catch(() => {}); }, []);
  useEffect(() => { load(); }, [load]);

  const save = async (e) => {
    e.preventDefault();
    if (!form.site_id) return toast.error('Site is required');
    try {
      await api.post('/labour-master/daily-progress', {
        ...form, labourers_present: Number(form.labourers_present) || 0,
        progress_pct: form.progress_pct === '' ? null : Number(form.progress_pct),
      });
      toast.success('Progress saved');
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Save failed'); }
  };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {canCreate('labour_master') && (
        <div className="card p-4 space-y-3">
          <h3 className="text-sm font-semibold">Log Today's Progress</h3>
          <form onSubmit={save} className="space-y-3">
            <div><label className="label text-xs">Site *</label>
              <select className="select" value={form.site_id} onChange={e => setForm(f => ({ ...f, site_id: e.target.value }))} required>
                <option value="">Select site</option>
                {sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div><label className="label text-xs">Date</label><input type="date" className="input" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></div>
            <div><label className="label text-xs">Labourers Present</label><input type="number" min="0" className="input" value={form.labourers_present} onChange={e => setForm(f => ({ ...f, labourers_present: e.target.value }))} /></div>
            <div><label className="label text-xs">Progress %</label><input type="number" min="0" max="100" className="input" value={form.progress_pct} onChange={e => setForm(f => ({ ...f, progress_pct: e.target.value }))} /></div>
            <div><label className="label text-xs">Notes</label><textarea className="input" rows={3} value={form.progress_notes} onChange={e => setForm(f => ({ ...f, progress_notes: e.target.value }))} /></div>
            <button type="submit" className="btn btn-primary w-full text-sm">Save</button>
          </form>
        </div>
      )}
      <div className="lg:col-span-2 card p-0 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead><tr className="bg-gray-50 text-xs text-gray-600">
            <th className="px-3 py-2 text-left">Date</th>
            <th className="px-3 py-2 text-left">Site</th>
            <th className="px-3 py-2 text-right">Labourers</th>
            <th className="px-3 py-2 text-right">Progress</th>
            <th className="px-3 py-2 text-left">Notes</th>
          </tr></thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(r => (
              <tr key={r.id}>
                <td className="px-3 py-2">{r.date}</td>
                <td className="px-3 py-2 text-xs">{r.site_name}</td>
                <td className="px-3 py-2 text-right">{r.labourers_present}</td>
                <td className="px-3 py-2 text-right">{r.progress_pct != null ? `${r.progress_pct}%` : '—'}</td>
                <td className="px-3 py-2 text-xs text-gray-500">{r.progress_notes || '—'}</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-gray-400">No progress logged yet</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
