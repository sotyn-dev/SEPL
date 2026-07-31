import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import EmployeeChangeCard from '../components/EmployeeChangeCard';
import EmployeeHistoryDrawer from '../components/EmployeeHistoryDrawer';
import { computeChanges } from '../constants/employeeChangeCodes';
import { fmtDate, timeAgo } from '../utils/datetime';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiUpload, FiSearch, FiUsers, FiLink, FiLink2, FiClock, FiRotateCcw, FiFileText, FiRefreshCw } from 'react-icons/fi';

// IST calendar date (caps the effective-date picker; matches the server).
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function Employees() {
  const { canDelete, isAdmin, canView } = useAuth();
  // Salary is confidential — only admins and holders of employee_salary.can_view see it
  const canSeeSalary = isAdmin() || canView('employee_salary');
  const [employees, setEmployees] = useState([]);
  const [users, setUsers] = useState([]);
  const [modal, setModal] = useState(false);
  const [bulkModal, setBulkModal] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [original, setOriginal] = useState(null);   // snapshot at edit-open, for the live diff
  const [changeMeta, setChangeMeta] = useState({ action_code: '', reason_code: '', reason: '', effective_date: '' });
  const [historyEmp, setHistoryEmp] = useState(null); // employee whose history drawer is open
  const [search, setSearch] = useState('');
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const [rosterAudit, setRosterAudit] = useState({ backlog: [], guests: [] });
  const [view, setView] = useState('directory'); // 'directory' | 'review' | 'history'
  // History & Reports tab state
  const [reportMode, setReportMode] = useState('changelog'); // 'changelog' | 'snapshot'
  const [changeLog, setChangeLog] = useState([]);
  const [snapshot, setSnapshot] = useState({ asof: istToday(), rows: [] });
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [asof, setAsof] = useState(istToday());
  const [syncing, setSyncing] = useState(false);
  const fileRef = useRef(null);

  const load = () => {
    api.get('/hr/employees').then(r => setEmployees(r.data));
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/hr/roster-audit').then(r => setRosterAudit(r.data || { backlog: [], guests: [] })).catch(() => {});
  };
  useEffect(() => { load(); }, []);

  // Delete an employee — surfaces WHY it's blocked instead of a bare "Delete
  // failed" (mam 2026-07-06). Payroll history → server 400 tells her to
  // deactivate; interview/hiring links → 409 offers Force Delete. Shared by the
  // desktop row AND the mobile card so both behave the same.
  const deleteEmployee = async (e) => {
    if (!confirm(
      `Delete employee "${e.name}"?\n\n` +
      'Tip: if they have left, setting Status to "inactive" / "terminated" (Edit) keeps their ' +
      'salary history and drops them off the active list — that is usually what you want.'
    )) return;
    try {
      await api.delete(`/hr/employees/${e.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      if (err.response?.status === 409) {
        const refCount = err.response?.data?.reference_count;
        if (!confirm(
          `Delete blocked — "${e.name}" is still linked to ${refCount || 'some'} interview/hiring record(s).\n\n` +
          'FORCE DELETE will unlink those (interviewer / reporting-manager links) and delete the ' +
          'employee permanently.\n\nProceed with force delete?'
        )) return;
        try {
          await api.delete(`/hr/employees/${e.id}?force=1`);
          toast.success(`Employee "${e.name}" force-deleted`);
          load();
        } catch (err2) {
          toast.error(err2.response?.data?.error || 'Force delete failed');
        }
        return;
      }
      // 400 payroll guard (or anything else) → show the server's reason verbatim
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // ── History & Reports ──────────────────────────────────────────────────────
  const changeQuery = () => {
    const p = new URLSearchParams();
    if (rangeFrom) p.set('from', rangeFrom);
    if (rangeTo) p.set('to', rangeTo);
    return p.toString();
  };
  const loadChangeLog = () => api.get(`/hr/changes?${changeQuery()}`).then(r => setChangeLog(r.data || [])).catch(() => setChangeLog([]));
  const loadSnapshot = () => api.get(`/hr/snapshot?asof=${asof}`).then(r => setSnapshot(r.data || { asof, rows: [] })).catch(() => setSnapshot({ asof, rows: [] }));

  // Load report data whenever the History tab / mode / filters change.
  useEffect(() => {
    if (view !== 'history') return;
    if (reportMode === 'changelog') loadChangeLog(); else loadSnapshot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, reportMode, rangeFrom, rangeTo, asof]);

  // Admin: reconstruct history from the audit log. Run ONCE, right after deploy,
  // before any edits — employees already having timeline rows are skipped.
  const runSync = async () => {
    if (!confirm(
      'Reconstruct employee history from the audit log?\n\n' +
      'Safe: it never changes any current value, only fills in past changes for employees ' +
      'who have no history yet. Best run once, before editing employees.'
    )) return;
    setSyncing(true);
    try {
      const r = await api.post('/hr/employee-timeline/backfill-from-audit');
      const d = r.data || {};
      toast.success(`Synced — ${d.processed} employees, ${d.changes} changes reconstructed, ${d.skipped} already had history`);
      loadChangeLog(); load();
    } catch (e) { toast.error(e.response?.data?.error || 'Sync failed'); }
    finally { setSyncing(false); }
  };

  // Download a styled .xlsx report (blob, like UserManagement export).
  const exportReport = async () => {
    try {
      const url = reportMode === 'changelog' ? `/hr/changes/export.xlsx?${changeQuery()}` : `/hr/snapshot/export.xlsx?asof=${asof}`;
      const r = await api.get(url, { responseType: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(r.data);
      a.download = reportMode === 'changelog' ? `employee-change-log-${istToday()}.xlsx` : `employee-snapshot-${asof}.xlsx`;
      a.click();
      toast.success('Exported to Excel');
    } catch { toast.error('Export failed'); }
  };

  // Auto-link employees to users by matching email — for existing records
  const autoLink = async () => {
    try {
      const res = await api.post('/hr/employees/auto-link');
      toast.success(`Linked ${res.data.linked} employee${res.data.linked === 1 ? '' : 's'} by email`);
      load();
    } catch { toast.error('Auto-link failed'); }
  };

  const [uploading, setUploading] = useState(false);

  // Generic file uploader — same pattern as HR.jsx / Inventory.jsx. Posts to
  // /upload, returns the served URL we can stash on the form.
  const uploadFile = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data?.url || null;
    } catch {
      toast.error('Upload failed');
      return null;
    } finally { setUploading(false); }
  };

  // Open the modal to EDIT — snapshot the row for the live diff and reset the
  // change-capture meta (effective date defaults to today).
  const openEdit = (emp) => {
    setEditing(emp);
    setForm(emp);
    setOriginal(emp);
    setChangeMeta({ action_code: '', reason_code: '', reason: '', effective_date: istToday() });
    setModal(true);
  };
  // Open the modal to CREATE — no before-state, so no change card / reason.
  const openCreate = () => {
    setEditing(null);
    setOriginal(null);
    setForm({ name: '', phone: '', email: '', designation: '', department: '', join_date: '', salary: 0, user_id: null, roster: 'general' });
    setChangeMeta({ action_code: '', reason_code: '', reason: '', effective_date: istToday() });
    setModal(true);
  };

  // Live diff of the tracked fields (edit only) — drives the field accents + card.
  const changes = editing && original ? computeChanges(original, form) : [];
  const changedSet = new Set(changes.map((c) => c.key));
  const revertField = (key) => setForm((f) => ({ ...f, [key]: original[key] }));
  const trackAccent = (key) => (changedSet.has(key) ? 'border-l-4 border-amber-400 pl-2' : '');

  // "↩ was X" hint + revert link under a changed tracked field.
  const WasHint = ({ k, fmt }) => changedSet.has(k) ? (
    <p className="text-[10px] text-amber-700 mt-0.5 flex items-center gap-1.5">
      <FiRotateCcw size={10} /> was {fmt ? fmt(original[k]) : `“${original[k] ?? '—'}”`}
      <button type="button" onClick={() => revertField(k)} className="underline hover:text-amber-900">revert</button>
    </p>
  ) : null;

  const save = async (e) => {
    e.preventDefault();
    // Upload any newly-attached document files first, then save the URLs
    // alongside the rest of the employee fields. Existing URLs (when
    // editing) stay untouched if no new file is picked.
    const payload = { ...form };
    delete payload._aadhar_file;
    delete payload._pan_file;
    delete payload._qualification_file;
    if (form._aadhar_file) {
      const url = await uploadFile(form._aadhar_file); if (!url) return;
      payload.aadhar_file = url;
    }
    if (form._pan_file) {
      const url = await uploadFile(form._pan_file); if (!url) return;
      payload.pan_file = url;
    }
    if (form._qualification_file) {
      const url = await uploadFile(form._qualification_file); if (!url) return;
      payload.qualification_file = url;
    }
    // Required-on-create — backend will also reject, but checking here lets
    // mam see the error before the upload spinner spins.
    if (!editing) {
      if (!payload.aadhar_file)        return toast.error('Upload Aadhar card');
      if (!payload.pan_file)           return toast.error('Upload PAN card');
      if (!payload.qualification_file) return toast.error('Upload Highest qualification certificate');
    }
    // A tracked change requires an action + reason (the server enforces this too).
    if (editing && changes.length > 0) {
      if (!changeMeta.action_code) return toast.error('Select an action for this change');
      if (!changeMeta.reason?.trim()) return toast.error('Add a reason for this change');
      payload.action_code = changeMeta.action_code;
      payload.reason_code = changeMeta.reason_code || null;
      payload.reason = changeMeta.reason.trim();
      payload.effective_date = changeMeta.effective_date || istToday();
    }
    try {
      if (editing) { await api.put(`/hr/employees/${editing.id}`, payload); }
      else { await api.post('/hr/employees', payload); }
      toast.success(editing ? 'Updated' : 'Created');
      setModal(false); load();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  // Export CSV — never include salary for non-HR/non-admin users
  const exportCSV = () => {
    if (employees.length === 0) return toast.error('No data');
    const headers = canSeeSalary
      ? ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Salary', 'Status']
      : ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Status'];
    const rows = employees.map(e => canSeeSalary
      ? [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.salary, e.status]
      : [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.status]);
    const csv = [headers, ...rows].map(r => r.map(c => `"${(c ?? '').toString().replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `employees-${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    toast.success('Exported to CSV');
  };

  // Download template
  const downloadTemplate = () => {
    const csv = 'Name,Phone,Email,Designation,Department,Join Date (YYYY-MM-DD),Salary\nJohn Doe,9876543210,john@example.com,Engineer,Engineering,2024-01-15,50000\nJane Smith,9123456789,jane@example.com,Manager,HR,2024-02-01,60000';
    const blob = new Blob([csv], { type: 'text/csv' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'employee-bulk-template.csv';
    a.click();
    toast.success('Template downloaded');
  };

  // Parse CSV
  const parseCSV = (text) => {
    const lines = text.trim().split('\n');
    if (lines.length < 2) return [];
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',').map(c => c.replace(/^"|"$/g, '').trim());
      if (cols[0]) {
        rows.push({
          name: cols[0] || '',
          phone: cols[1] || '',
          email: cols[2] || '',
          designation: cols[3] || '',
          department: cols[4] || '',
          join_date: cols[5] || '',
          salary: parseFloat(cols[6]) || 0,
        });
      }
    }
    return rows;
  };

  // Handle file upload
  const handleFile = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const text = ev.target.result;
      setBulkData(text);
      const parsed = parseCSV(text);
      setBulkPreview(parsed);
    };
    reader.readAsText(file);
    e.target.value = '';
  };

  // Handle paste data
  const handlePaste = (text) => {
    setBulkData(text);
    if (text.trim()) {
      const parsed = parseCSV(text);
      setBulkPreview(parsed);
    } else {
      setBulkPreview([]);
    }
  };

  // Bulk import
  const bulkImport = async () => {
    if (bulkPreview.length === 0) return toast.error('No valid data to import');
    try {
      const res = await api.post('/hr/employees/bulk', { employees: bulkPreview });
      toast.success(`Added ${res.data.added} of ${res.data.total} employees`);
      if (res.data.errors.length > 0) {
        toast.error(`${res.data.errors.length} errors: ${res.data.errors[0]}`);
      }
      setBulkModal(false); setBulkData(''); setBulkPreview([]); load();
    } catch { toast.error('Import failed'); }
  };

  const filtered = employees.filter(e =>
    !search || [e.name, e.phone, e.email, e.designation, e.department].some(f => (f || '').toLowerCase().includes(search.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h3 className="text-xl font-bold flex items-center gap-2"><FiUsers className="text-red-600" /> Employee Directory</h3>
          <p className="text-sm text-gray-500">{employees.length} total employees</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <button onClick={exportCSV} className="btn btn-secondary flex items-center gap-2 text-sm"><FiDownload size={15} /> Export CSV</button>
          <button onClick={autoLink} className="btn btn-secondary flex items-center gap-2 text-sm" title="Link unlinked employees to users by matching email"><FiLink2 size={15} /> Auto-Link by Email</button>
          <button onClick={() => { setBulkData(''); setBulkPreview([]); setBulkModal(true); }} className="btn btn-secondary flex items-center gap-2 text-sm"><FiUpload size={15} /> Bulk Import</button>
          <button onClick={openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Employee</button>
        </div>
      </div>

      {/* Tabs — keep the roster-reconciliation flags off the main directory
          (in production the flag lists can be long and clutter the table).
          They live in their own "Roster Review" tab as a listed view. */}
      <div className="flex gap-2 border-b border-gray-200">
        <button
          onClick={() => setView('directory')}
          className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${view === 'directory' ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Directory
        </button>
        <button
          onClick={() => setView('review')}
          className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5 ${view === 'review' ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          Roster Review
          {(rosterAudit.backlog.length + rosterAudit.guests.length) > 0 && (
            <span className="text-[10px] font-bold bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none">{rosterAudit.backlog.length + rosterAudit.guests.length}</span>
          )}
        </button>
        <button
          onClick={() => setView('history')}
          className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5 ${view === 'history' ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
          <FiFileText size={14} /> History &amp; Reports
        </button>
      </div>

      {view === 'directory' && (
      <>
      {/* Search */}
      <div className="relative">
        <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={16} />
        <input className="input pl-10" placeholder="Search by name, phone, email, designation, department..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      {/* Table */}
      <div className="card p-0 hidden md:block"><table className="freeze-head">
        <thead><tr>
          <th>Name</th><th>Phone</th><th>Email</th><th>Designation</th><th>Department</th><th>Join Date</th>
          <th title="Linked user login — needed for DPR Staff Cost auto-calc">Linked User</th>
          {canSeeSalary && <th>Salary</th>}
          <th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {filtered.map(e => (
            <tr key={e.id}>
              <td className="font-medium">{e.name}</td><td>{e.phone}</td><td>{e.email}</td>
              <td>{e.designation}</td><td>{e.department}</td><td>{e.join_date}</td>
              <td>
                {e.linked_user_name
                  ? <span className="badge badge-green text-[10px] flex items-center gap-1 w-fit"><FiLink size={10} /> {e.linked_user_name}</span>
                  : <span className="badge badge-red text-[10px]">Not linked</span>}
              </td>
              {canSeeSalary && <td className="font-medium">Rs {(e.salary || 0).toLocaleString('en-IN')}</td>}
              <td>
                <StatusBadge status={e.status} />
                {e.status_since && (
                  <div className={`text-[10px] mt-0.5 ${['inactive','terminated'].includes(e.status) ? 'text-red-500' : 'text-gray-400'}`}>
                    since {fmtDate(e.status_since)}
                  </div>
                )}
              </td>
              <td><div className="flex gap-1">
                <button onClick={() => openEdit(e)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title="Edit"><FiEdit2 size={15} /></button>
                <button onClick={() => setHistoryEmp(e)} className="p-1.5 hover:bg-gray-100 rounded text-gray-500" title="Change history"><FiClock size={15} /></button>
                {canDelete('employees') && <button onClick={() => deleteEmployee(e)} className="p-1 text-gray-400 hover:text-red-600" title="Delete"><FiTrash2 size={14} /></button>}
              </div></td>
            </tr>
          ))}
          {filtered.length === 0 && <tr><td colSpan={canSeeSalary ? 10 : 9} className="text-center py-8 text-gray-400">No employees found</td></tr>}
        </tbody>
      </table></div>

      {/* Mobile cards (mam 2026-06-02) — polished employee card list */}
      <div className="md:hidden space-y-3">
        {filtered.length === 0 && (
          <div className="card p-6 text-center text-gray-400 text-sm">No employees found</div>
        )}
        {filtered.map(e => (
          <div key={e.id} className="card p-3 space-y-2">
            <div className="flex justify-between items-start gap-2">
              <div className="flex-1 min-w-0">
                <div className="text-[10px] uppercase tracking-wide text-gray-500 font-semibold">Employee</div>
                <div className="text-lg font-bold text-gray-900 truncate">{e.name}</div>
                {e.designation && <div className="text-[11px] text-gray-600">{e.designation}</div>}
                {e.department && <div className="text-[10px] text-gray-400">{e.department}</div>}
              </div>
              <div className="text-right">
                <StatusBadge status={e.status} />
                {e.status_since && (
                  <div className={`text-[9px] mt-0.5 ${['inactive','terminated'].includes(e.status) ? 'text-red-500' : 'text-gray-400'}`}>
                    since {fmtDate(e.status_since)}
                  </div>
                )}
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2 pt-1 border-t border-gray-100 text-[11px]">
              {e.phone && (
                <a href={`tel:${e.phone}`} className="text-blue-600 hover:underline">
                  <div className="text-[9px] uppercase text-gray-400">Phone</div>
                  <div className="font-semibold">📞 {e.phone}</div>
                </a>
              )}
              {e.email && (
                <a href={`mailto:${e.email}`} className="text-blue-600 hover:underline truncate" title={e.email}>
                  <div className="text-[9px] uppercase text-gray-400">Email</div>
                  <div className="font-semibold truncate">✉ {e.email}</div>
                </a>
              )}
              {e.join_date && (
                <div>
                  <div className="text-[9px] uppercase text-gray-400">Join Date</div>
                  <div className="font-semibold text-gray-700">{e.join_date}</div>
                </div>
              )}
              {canSeeSalary && (
                <div>
                  <div className="text-[9px] uppercase text-gray-400">Salary</div>
                  <div className="font-semibold text-emerald-700">Rs {(e.salary || 0).toLocaleString('en-IN')}</div>
                </div>
              )}
            </div>
            <div className="pt-1 border-t border-gray-100">
              <div className="text-[9px] uppercase text-gray-400">Linked User</div>
              {e.linked_user_name
                ? <span className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1"><FiLink size={10} /> {e.linked_user_name}</span>
                : <span className="text-[11px] font-semibold text-red-600">Not linked — DPR Staff Cost won't include this employee</span>}
            </div>
            <div className="flex items-center justify-end gap-3 pt-2 border-t border-gray-100 text-xs">
              <button onClick={() => openEdit(e)} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                <FiEdit2 size={11} /> Edit
              </button>
              <button onClick={() => setHistoryEmp(e)} className="text-gray-500 hover:underline flex items-center gap-1 font-semibold">
                <FiClock size={11} /> History
              </button>
              {canDelete('employees') && (
                <button onClick={() => deleteEmployee(e)} className="text-red-600 hover:underline flex items-center gap-1 font-semibold">
                  <FiTrash2 size={11} /> Delete
                </button>
              )}
            </div>
          </div>
        ))}
      </div>
      </>
      )}

      {view === 'review' && (
        <div className="space-y-4">
          {rosterAudit.backlog.length === 0 && rosterAudit.guests.length === 0 && (
            <div className="card p-8 text-center text-gray-400 text-sm">Nothing to review — every active login maps to an on-roll employee.</div>
          )}

          {/* Backlog: past employees whose login is still active — still counted
              in attendance strength until HR deactivates them. */}
          {rosterAudit.backlog.length > 0 && (
            <div className="card p-0 overflow-hidden">
              <div className="p-3 bg-red-50 border-b border-red-200">
                <h4 className="font-bold text-red-700 text-sm">Terminated / inactive — login still active ({rosterAudit.backlog.length})</h4>
                <p className="text-[11px] text-red-700/80 italic mt-0.5">Past employees still counted in attendance. Deactivate their login in User Management to clear them. Nothing here is changed automatically.</p>
              </div>
              <table className="text-sm w-full">
                <thead><tr className="text-left text-gray-500 border-b"><th className="px-3 py-2">Name</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Role</th><th className="px-3 py-2">Employee status</th></tr></thead>
                <tbody>
                  {rosterAudit.backlog.map(u => (
                    <tr key={u.id} className="border-b border-gray-50">
                      <td className="px-3 py-2 font-medium">{u.name}</td>
                      <td className="px-3 py-2 text-gray-600">{u.department || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{u.role}</td>
                      <td className="px-3 py-2"><span className="text-[10px] font-semibold uppercase bg-red-100 text-red-700 px-1.5 py-0.5 rounded">{u.employee_status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Guests: active logins never onboarded into the employee roster. */}
          {rosterAudit.guests.length > 0 && (
            <div className="card p-0 overflow-hidden">
              <div className="p-3 bg-amber-50 border-b border-amber-200">
                <h4 className="font-bold text-amber-700 text-sm">Active logins not on the employee roster ({rosterAudit.guests.length})</h4>
                <p className="text-[11px] text-amber-700/80 italic mt-0.5">Guest / never-onboarded accounts. Onboard them via “Add Employee” if they belong, or leave as-is. Not changed automatically.</p>
              </div>
              <table className="text-sm w-full">
                <thead><tr className="text-left text-gray-500 border-b"><th className="px-3 py-2">Name</th><th className="px-3 py-2">Department</th><th className="px-3 py-2">Role</th></tr></thead>
                <tbody>
                  {rosterAudit.guests.map(u => (
                    <tr key={u.id} className="border-b border-gray-50">
                      <td className="px-3 py-2 font-medium">{u.name}</td>
                      <td className="px-3 py-2 text-gray-600">{u.department || '—'}</td>
                      <td className="px-3 py-2 text-gray-600">{u.role}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {view === 'history' && (
        <div className="space-y-4">
          {/* Toolbar: mode toggle + admin sync + export */}
          <div className="flex flex-wrap items-center gap-2 justify-between">
            <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
              <button onClick={() => setReportMode('changelog')} className={`px-3 py-1.5 text-sm font-semibold ${reportMode === 'changelog' ? 'bg-red-600 text-white' : 'bg-white text-gray-600'}`}>Change Log</button>
              <button onClick={() => setReportMode('snapshot')} className={`px-3 py-1.5 text-sm font-semibold ${reportMode === 'snapshot' ? 'bg-red-600 text-white' : 'bg-white text-gray-600'}`}>As-of Snapshot</button>
            </div>
            <div className="flex gap-2">
              {isAdmin() && (
                <button onClick={runSync} disabled={syncing} className="btn btn-secondary text-sm flex items-center gap-2 disabled:opacity-50" title="Reconstruct history from the audit log (admin, non-destructive)">
                  <FiRefreshCw size={14} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync from audit log'}
                </button>
              )}
              <button onClick={exportReport} className="btn btn-primary text-sm flex items-center gap-2"><FiDownload size={14} /> Export Excel</button>
            </div>
          </div>

          {/* Change Log */}
          {reportMode === 'changelog' && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div><label className="label">From</label><input type="date" className="input" max={istToday()} value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} /></div>
                <div><label className="label">To</label><input type="date" className="input" max={istToday()} value={rangeTo} onChange={e => setRangeTo(e.target.value)} /></div>
                {(rangeFrom || rangeTo) && <button onClick={() => { setRangeFrom(''); setRangeTo(''); }} className="btn btn-secondary text-sm">Clear</button>}
                <div className="text-xs text-gray-400 ml-auto">{changeLog.length} change{changeLog.length === 1 ? '' : 's'}</div>
              </div>
              <div className="card p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-gray-500 border-b bg-gray-50">
                    <th className="px-3 py-2">Employee</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Field</th>
                    <th className="px-3 py-2">From</th><th className="px-3 py-2">To</th><th className="px-3 py-2">Effective</th>
                    <th className="px-3 py-2">Reason</th><th className="px-3 py-2">By</th>
                  </tr></thead>
                  <tbody>
                    {changeLog.map((ev, i) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="px-3 py-2 font-medium">{ev.employee_name}</td>
                        <td className="px-3 py-2">{ev.action}{ev.source === 'backfill' && <span className="ml-1 text-[9px] uppercase bg-gray-100 text-gray-500 rounded px-1">recon</span>}</td>
                        <td className="px-3 py-2 text-gray-600">{ev.label}</td>
                        <td className="px-3 py-2 text-gray-500">{ev.from || '—'}</td>
                        <td className="px-3 py-2 font-semibold">{ev.to || '—'}</td>
                        <td className="px-3 py-2 text-gray-600">{fmtDate(ev.effective)}</td>
                        <td className="px-3 py-2 text-gray-600 max-w-[240px] truncate" title={ev.reason}>{ev.reason}{ev.reason_code ? ` (${ev.reason_code})` : ''}</td>
                        <td className="px-3 py-2 text-gray-500">{ev.by}</td>
                      </tr>
                    ))}
                    {changeLog.length === 0 && <tr><td colSpan={8} className="text-center py-8 text-gray-400">No changes in this range. If history looks empty, an admin can <span className="font-semibold">Sync from audit log</span>.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* As-of Snapshot */}
          {reportMode === 'snapshot' && (
            <>
              <div className="flex flex-wrap items-end gap-3">
                <div><label className="label">State as of</label><input type="date" className="input" max={istToday()} value={asof} onChange={e => setAsof(e.target.value)} /></div>
                <div className="text-xs text-gray-400 ml-auto">{snapshot.rows.length} employees</div>
              </div>
              <div className="card p-0 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead><tr className="text-left text-gray-500 border-b bg-gray-50">
                    <th className="px-3 py-2">Employee</th><th className="px-3 py-2">Designation</th><th className="px-3 py-2">Department</th>
                    <th className="px-3 py-2">Status</th><th className="px-3 py-2">Roster</th>{canSeeSalary && <th className="px-3 py-2">Salary</th>}<th className="px-3 py-2">Since</th>
                  </tr></thead>
                  <tbody>
                    {snapshot.rows.map((r, i) => (
                      <tr key={i} className="border-b border-gray-50">
                        <td className="px-3 py-2 font-medium">{r.employee}</td>
                        <td className="px-3 py-2 text-gray-600">{r.designation || '—'}</td>
                        <td className="px-3 py-2 text-gray-600">{r.department || '—'}</td>
                        <td className="px-3 py-2"><StatusBadge status={r.status} /></td>
                        <td className="px-3 py-2 text-gray-600">{r.roster || '—'}</td>
                        {canSeeSalary && <td className="px-3 py-2">Rs {(r.salary || 0).toLocaleString('en-IN')}</td>}
                        <td className="px-3 py-2 text-gray-500">{fmtDate(r.since)}</td>
                      </tr>
                    ))}
                    {snapshot.rows.length === 0 && <tr><td colSpan={canSeeSalary ? 7 : 6} className="text-center py-8 text-gray-400">No snapshot for this date. History may need a <span className="font-semibold">Sync from audit log</span> first.</td></tr>}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}

      {/* Add/Edit Modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editing ? 'Edit Employee' : 'Add Employee'}>
        <form onSubmit={save} className="space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div><label className="label">Name *</label><input className="input" value={form.name || ''} onChange={e => setForm({...form, name: e.target.value})} required /></div>
            <div><label className="label">Phone</label><input className="input" value={form.phone || ''} onChange={e => setForm({...form, phone: e.target.value})} /></div>
            <div><label className="label">Email</label><input className="input" value={form.email || ''} onChange={e => setForm({...form, email: e.target.value})} /></div>
            <div className={trackAccent('designation')}><label className="label">Designation</label><input className="input" list="empDesigDL" value={form.designation || ''} onChange={e => setForm({...form, designation: e.target.value})} placeholder="Pick or type" /><datalist id="empDesigDL">{[...new Set(employees.map(e => e.designation).filter(Boolean))].map(d => <option key={d} value={d} />)}</datalist><WasHint k="designation" /></div>
            <div className={trackAccent('department')}><label className="label">Department</label><input className="input" list="empDeptDL" value={form.department || ''} onChange={e => setForm({...form, department: e.target.value})} placeholder="Pick or type" /><datalist id="empDeptDL">{[...new Set(employees.map(e => e.department).filter(Boolean))].map(d => <option key={d} value={d} />)}</datalist><WasHint k="department" /></div>
            <div><label className="label">Join Date</label><input className="input" type="date" value={form.join_date || ''} onChange={e => setForm({...form, join_date: e.target.value})} /></div>
            {canSeeSalary && <div className={trackAccent('salary')}><label className="label">Salary (Rs)</label><input className="input" type="number" value={form.salary || 0} onChange={e => setForm({...form, salary: +e.target.value})} /><WasHint k="salary" fmt={(v) => `₹${Number(v || 0).toLocaleString('en-IN')}`} /></div>}
            {editing && <div className={trackAccent('status')}><label className="label">Status</label><select className="select" value={form.status || ''} onChange={e => setForm({...form, status: e.target.value})}>{['active','training','inactive','terminated'].map(s => <option key={s} value={s}>{s}</option>)}</select><WasHint k="status" /></div>}
            <div className={trackAccent('roster')}>
              <label className="label">Roster / Shift</label>
              <select className="select" value={form.roster || 'general'} onChange={e => setForm({ ...form, roster: e.target.value })}>
                <option value="general">General — 9:30 AM to 6:30 PM</option>
                <option value="early">Early — 9:00 AM to 6:00 PM</option>
              </select>
              <WasHint k="roster" />
            </div>
            <div className="col-span-2">
              <label className="label flex items-center gap-1"><FiLink size={12} /> Linked Login User <span className="text-gray-400 font-normal">(required for DPR Staff Cost auto-calc)</span></label>
              <SearchableSelect
                options={users.map(u => ({ ...u, label: `${u.name} (${u.username || u.email})` }))}
                value={form.user_id || null}
                valueKey="id"
                displayKey="label"
                placeholder="Search by name, username or email…"
                onChange={(u) => setForm({ ...form, user_id: u?.id || null })}
              />
              <p className="text-[10px] text-gray-500 mt-0.5">If left blank and email matches a user, it will auto-link on save.</p>
            </div>

            {/* Contextual Change Card — appears only when a tracked field moved.
                Single surface (no popup), full width, right after the grid. */}
            {editing && (
              <EmployeeChangeCard
                changes={changes}
                statusTo={form.status}
                meta={changeMeta}
                setMeta={setChangeMeta}
                canSeeSalary={canSeeSalary}
                today={istToday()}
              />
            )}
          </div>

          {/* Mandatory KYC docs for new employees. When editing, the inputs
              show "Existing: view file" if a doc URL is already on file —
              uploading a new one replaces it. Three docs: Aadhar, PAN,
              Highest qualification certificate. */}
          <div className="card p-3 bg-amber-50/40 border-l-4 border-amber-400 space-y-3">
            <div className="text-xs font-semibold text-amber-800 uppercase tracking-wide">Mandatory documents{editing ? '' : ' *'}</div>
            {[
              { key: 'aadhar_file',        slot: '_aadhar_file',        label: 'Aadhar Card *' },
              { key: 'pan_file',           slot: '_pan_file',           label: 'PAN Card *' },
              { key: 'qualification_file', slot: '_qualification_file', label: 'Highest Qualification Certificate *' },
            ].map(({ key, slot, label }) => (
              <div key={key}>
                <label className="label">{label} <span className="text-gray-400 font-normal text-[10px]">(PDF / JPG / PNG, max 10 MB)</span></label>
                <input
                  className="input"
                  type="file"
                  accept=".pdf,.jpg,.jpeg,.png"
                  required={!editing && !form[key]}
                  onChange={e => setForm({ ...form, [slot]: e.target.files?.[0] || null })}
                />
                {/* Existing URL link when editing */}
                {editing && form[key] && !form[slot] && (
                  <p className="text-[10px] text-emerald-600 mt-0.5">
                    Existing: <a href={form[key]} target="_blank" rel="noreferrer" className="underline">view file</a> · upload to replace
                  </p>
                )}
                {form[slot] && <p className="text-[10px] text-blue-600 mt-0.5">Selected: {form[slot].name}</p>}
              </div>
            ))}
          </div>

          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button
              type="submit"
              disabled={uploading || (editing && changes.length > 0 && (!changeMeta.action_code || !changeMeta.reason?.trim()))}
              title={editing && changes.length > 0 && !changeMeta.reason?.trim() ? 'Add a reason to save' : ''}
              className="btn btn-primary disabled:opacity-50">
              {uploading ? 'Uploading…' : (editing ? 'Update' : 'Create')}
            </button>
          </div>
        </form>
      </Modal>

      {/* Change history drawer — opened from a directory row only (never over the
          Edit modal, so the two modals can't stack). */}
      <EmployeeHistoryDrawer isOpen={!!historyEmp} onClose={() => setHistoryEmp(null)} employee={historyEmp} />

      {/* Bulk Import Modal */}
      <Modal isOpen={bulkModal} onClose={() => setBulkModal(false)} title="Bulk Import Employees" wide>
        <div className="space-y-4">
          <div className="bg-red-50 p-3 rounded-lg text-sm text-red-700">
            <p className="font-semibold mb-1">How to bulk import:</p>
            <ol className="list-decimal ml-4 space-y-1">
              <li>Download the CSV template below</li>
              <li>Fill in your employee data (keep the header row)</li>
              <li>Upload the CSV file or paste the data below</li>
              <li>Review the preview and click Import</li>
            </ol>
          </div>

          <button onClick={downloadTemplate} className="btn btn-secondary text-sm flex items-center gap-2"><FiDownload size={14} /> Download CSV Template</button>

          <div>
            <label className="label">Upload CSV File</label>
            <input ref={fileRef} type="file" accept=".csv,.txt" onChange={handleFile}
              className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-semibold file:bg-red-50 file:text-red-700 hover:file:bg-red-100" />
          </div>

          <div>
            <label className="label">Or Paste CSV Data</label>
            <textarea className="input font-mono text-xs" rows="6" placeholder="Name,Phone,Email,Designation,Department,Join Date,Salary&#10;John Doe,9876543210,john@example.com,Engineer,Engineering,2024-01-15,50000"
              value={bulkData} onChange={e => handlePaste(e.target.value)} />
          </div>

          {/* Preview */}
          {bulkPreview.length > 0 && (
            <div>
              <p className="text-sm font-semibold text-gray-700 mb-2">Preview: {bulkPreview.length} employees to import</p>
              <div className="max-h-60 overflow-y-auto border rounded-lg">
                <table className="min-w-full text-xs">
                  <thead><tr className="bg-gray-50"><th className="px-2 py-1.5">Name</th><th className="px-2 py-1.5">Phone</th><th className="px-2 py-1.5">Email</th><th className="px-2 py-1.5">Designation</th><th className="px-2 py-1.5">Department</th><th className="px-2 py-1.5">Join Date</th><th className="px-2 py-1.5">Salary</th></tr></thead>
                  <tbody>
                    {bulkPreview.map((e, i) => (
                      <tr key={i} className={!e.name ? 'bg-red-50' : ''}>
                        <td className="px-2 py-1.5 font-medium">{e.name || '(empty)'}</td>
                        <td className="px-2 py-1.5">{e.phone}</td><td className="px-2 py-1.5">{e.email}</td>
                        <td className="px-2 py-1.5">{e.designation}</td><td className="px-2 py-1.5">{e.department}</td>
                        <td className="px-2 py-1.5">{e.join_date}</td><td className="px-2 py-1.5">{e.salary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-3 pt-2 border-t">
            <button onClick={() => setBulkModal(false)} className="btn btn-secondary">Cancel</button>
            <button onClick={bulkImport} disabled={bulkPreview.length === 0} className="btn btn-primary flex items-center gap-2 disabled:opacity-50">
              <FiUpload size={14} /> Import {bulkPreview.length} Employees
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
