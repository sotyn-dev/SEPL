import { useState, useEffect, useRef } from 'react';
import api from '../api';
import Modal from '../components/Modal';
import SearchableSelect from '../components/SearchableSelect';
import StatusBadge from '../components/StatusBadge';
import useEmployeeForm from '../components/employee/useEmployeeForm';
import EmployeeWorkspaceModal from '../components/employee/EmployeeWorkspaceModal';
import { SALARY_REASON_CODES } from '../constants/employeeChangeCodes';
import { fmtDate, fmtDateTime } from '../utils/datetime';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiPlus, FiEdit2, FiTrash2, FiDownload, FiUpload, FiSearch, FiUsers, FiLink, FiLink2, FiFileText, FiRefreshCw, FiMoreVertical } from 'react-icons/fi';

// IST calendar date (caps the effective-date picker; matches the server).
const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export default function Employees() {
  const { canDelete, isAdmin, canView } = useAuth();
  // Salary is confidential — only admins and holders of employee_salary.can_view see it
  const canSeeSalary = isAdmin() || canView('employee_salary');
  const [employees, setEmployees] = useState([]);
  const [users, setUsers] = useState([]);
  const [bulkModal, setBulkModal] = useState(false);
  const [search, setSearch] = useState('');
  const [bulkData, setBulkData] = useState('');
  const [bulkPreview, setBulkPreview] = useState([]);
  const [rosterAudit, setRosterAudit] = useState({ backlog: [], guests: [] });
  // Tab survives an in-page refresh via sessionStorage (no URL/query-param
  // routing), but navigating away to another route and back should land on
  // Directory again — so the stored value is cleared on unmount, not just left
  // to expire naturally like localStorage would.
  const [view, setView] = useState(() => sessionStorage.getItem('employees_view') || 'directory'); // 'directory' | 'review' | 'history'
  useEffect(() => { sessionStorage.setItem('employees_view', view); }, [view]);
  useEffect(() => () => sessionStorage.removeItem('employees_view'), []);
  // Leaving History & Reports for another tab clears the selected employee, so
  // coming back always starts at "no employee selected" rather than wherever
  // you last left off (dme 2026-08-01).
  useEffect(() => { if (view !== 'history') setHistoryEmpId(null); }, [view]);
  const [tabMenuOpen, setTabMenuOpen] = useState(false); // mobile 3-dot tab menu
  // History & Reports tab state — grouped HR events, not raw field diffs.
  const [historyEmpId, setHistoryEmpId] = useState(null); // employee driving both the History and Vault tabs
  const [historyTab, setHistoryTab] = useState('vault'); // 'events' | 'vault' — mobile/medium tab state only; large screens show both as a split view
  const [events, setEvents] = useState([]);
  const [vault, setVault] = useState(null);
  const [reportMonth, setReportMonth] = useState(istToday().slice(0, 7)); // org-wide monthly report — independent of historyEmpId
  const [syncing, setSyncing] = useState(false);
  const [confirmBox, setConfirmBox] = useState(null); // { message, onYes } — in-app confirm (org-structure pattern: window.confirm is blocked in the embedded preview iframe, silently returning false)

  const EVENT_BADGE = {
    Joined: 'bg-purple-100 text-purple-800',
    'Status Change': 'bg-amber-100 text-amber-800',
    Promotion: 'bg-emerald-100 text-emerald-800',
    Transfer: 'bg-blue-100 text-blue-800',
    'Salary Revision': 'bg-teal-100 text-teal-800',
    'Documents Updated': 'bg-orange-100 text-orange-800',
    'Access Change': 'bg-indigo-100 text-indigo-800',
    Correction: 'bg-gray-100 text-gray-700',
  };
  // code -> human label, for the small reason line under a Salary Revision card
  // (the event JSON carries salary_reason_code, but the card never showed it).
  const SALARY_REASON_LABEL = Object.fromEntries(SALARY_REASON_CODES.map((r) => [r.code, r.label]));
  const fileRef = useRef(null);

  const load = () => {
    api.get('/hr/employees').then(r => setEmployees(r.data));
    api.get('/auth/users').then(r => setUsers((r.data || []).filter(u => u.active !== 0))).catch(() => {});
    api.get('/hr/roster-audit').then(r => setRosterAudit(r.data || { backlog: [], guests: [] })).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  // Add/Edit Workspace — extracted out of this page (Phase 3, plan:
  // keep-confirmation-status-separate-elegant-beacon). This page owns none
  // of the form state anymore; it just opens the workspace and reloads the
  // list when it reports a save.
  const workspace = useEmployeeForm({ onSaved: load });

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
  // No default selection — the employee panel starts empty until HR picks one.
  const loadEvents = (id) => api.get(`/hr/employees/${id}/events`)
    .then(r => setEvents(r.data || [])).catch(() => setEvents([]));
  const loadVault = (id) => api.get(`/hr/employees/${id}/vault`)
    .then(r => setVault(r.data)).catch(() => setVault(null));

  // Load BOTH panels whenever the selected employee changes — desktop shows
  // Vault + History side by side at once, so gating the fetch on historyTab
  // (the mobile-only tab toggle) left the non-active panel stale/empty there.
  useEffect(() => {
    if (view !== 'history' || !historyEmpId) return;
    loadEvents(historyEmpId);
    loadVault(historyEmpId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, historyEmpId]);

  // Admin: reconstruct history from the audit log. Run ONCE, right after deploy,
  // before any edits — employees already having timeline rows are skipped.
  const doSync = async () => {
    setSyncing(true);
    try {
      const r = await api.post('/hr/employee-timeline/backfill-from-audit');
      const d = r.data || {};
      toast.success(`Synced — ${d.processed} employees, ${d.changes} changes reconstructed, ${d.skipped} already had history`);
      if (historyEmpId) loadEvents(historyEmpId);
      load();
    } catch (e) { toast.error(e.response?.data?.error || 'Sync failed'); }
    finally { setSyncing(false); }
  };
  const runSync = () => setConfirmBox({
    title: 'Sync from audit log',
    message: 'Reconstruct employee history from the audit log? Safe: it never changes any current value, only fills in past changes for employees who have no history yet. Best run once, before editing employees.',
    confirmLabel: 'Sync',
    onYes: doSync,
  });

  // null | 'employee' | 'monthly' — which export (if any) is in flight. Disables
  // its triggering button + swaps the label while fetching: a slow report with
  // no feedback used to get double-clicked into two downloads (dme 2026-08-01).
  const [exportingKey, setExportingKey] = useState(null);
  // Download a styled .xlsx report (blob) — shared pattern for both exports.
  const downloadXlsx = async (url, filename, key) => {
    setExportingKey(key);
    try {
      const r = await api.get(url, { responseType: 'blob' });
      const blobUrl = URL.createObjectURL(r.data);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(blobUrl);
      toast.success('Exported to Excel');
    } catch { toast.error('Export failed'); }
    finally { setExportingKey(null); }
  };
  const exportThisEmployee = () => historyEmpId && downloadXlsx(
    `/hr/employees/${historyEmpId}/events/export.xlsx`, `hr-history-${istToday()}.xlsx`, 'employee'
  );
  const exportMonthlyReport = () => downloadXlsx(
    `/hr/employees/history/export.xlsx?month=${reportMonth}`, `hr-monthly-report-${reportMonth}.xlsx`, 'monthly'
  );

  // Auto-link employees to users by matching email — for existing records
  const autoLink = async () => {
    try {
      const res = await api.post('/hr/employees/auto-link');
      toast.success(`Linked ${res.data.linked} employee${res.data.linked === 1 ? '' : 's'} by email`);
      load();
    } catch { toast.error('Auto-link failed'); }
  };

  // Export CSV — never include salary for non-HR/non-admin users
  const exportCSV = () => {
    if (employees.length === 0) return toast.error('No data');
    const headers = canSeeSalary
      ? ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Salary', 'Status', 'Last Updated']
      : ['Name', 'Phone', 'Email', 'Designation', 'Department', 'Join Date', 'Status', 'Last Updated'];
    const rows = employees.map(e => canSeeSalary
      ? [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.salary, e.status, fmtDateTime(e.updated_at)]
      : [e.name, e.phone, e.email, e.designation, e.department, e.join_date, e.status, fmtDateTime(e.updated_at)]);
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
          <button onClick={workspace.openCreate} className="btn btn-primary flex items-center gap-2"><FiPlus size={15} /> Add Employee</button>
        </div>
      </div>

      {/* Tabs — keep the roster-reconciliation flags off the main directory
          (in production the flag lists can be long and clutter the table).
          They live in their own "Roster Review" tab as a listed view.
          One TABS array drives both the desktop strip and the mobile dropdown —
          only the wrapping classes/layout differ, not the link content. */}
      {(() => {
        const rosterFlags = rosterAudit.backlog.length + rosterAudit.guests.length;
        const TABS = [
          { id: 'directory', content: 'Directory' },
          { id: 'history', content: <><FiFileText size={14} /> History &amp; Reports</> },
          {
            id: 'review',
            content: (
              <>
                Roster Review
                {rosterFlags > 0 && (
                  <span className="text-[10px] font-bold bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none">{rosterFlags}</span>
                )}
              </>
            ),
          },
        ];
        return (
          <div className="border-b border-gray-200">
            {/* Desktop/tablet — full tab strip */}
            <div className="hidden sm:flex gap-2">
              {TABS.map(t => (
                <button
                  key={t.id}
                  onClick={() => setView(t.id)}
                  className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px flex items-center gap-1.5 ${view === t.id ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
                  {t.content}
                </button>
              ))}
            </div>

            {/* Mobile — 3-dot menu; all tabs move into the dropdown */}
            <div className="sm:hidden relative">
              <button onClick={() => setTabMenuOpen(o => !o)} className="absolute top-1 right-0 p-1.5 text-gray-500 hover:bg-gray-50" aria-label="Tabs menu">
                <FiMoreVertical size={18} />
              </button>
              {tabMenuOpen && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setTabMenuOpen(false)} />
                  <div className="absolute right-0 top-full w-56 bg-white border border-gray-200 rounded-lg shadow-lg z-20 py-1 overflow-hidden">
                    {TABS.map(t => (
                      <button
                        key={t.id}
                        onClick={() => { setView(t.id); setTabMenuOpen(false); }}
                        className={`w-full text-left px-3 py-2.5 text-sm font-semibold flex items-center gap-1.5 ${view === t.id ? 'text-red-600 bg-red-50' : 'text-gray-700 hover:bg-gray-50'}`}>
                        {t.content}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}

      {view === 'directory' && (
      <>
      <h5 className="font-semibold text-sm md:text-base">Directory</h5>
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
                  ? <span className="badge badge-green text-[10px] flex items-center gap-1 w-fit leading-none"><FiLink size={10} /> {e.linked_user_name}</span>
                  : <span className="badge badge-red text-[10px] leading-none">Not linked</span>}
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
                <button onClick={() => workspace.openEdit(e)} className="p-1.5 hover:bg-red-50 rounded text-red-600" title="Edit"><FiEdit2 size={15} /></button>
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
              <button onClick={() => workspace.openEdit(e)} className="text-blue-600 hover:underline flex items-center gap-1 font-semibold">
                <FiEdit2 size={11} /> Edit
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
          <h5 className="font-semibold text-sm md:text-base">
            <span className="inline-block mr-2">Roster Review</span>
            {(rosterAudit.backlog.length + rosterAudit.guests.length) > 0 && (
              <span className="md:hidden text-[10px] font-bold bg-amber-500 text-white rounded-full px-1.5 py-0.5 leading-none">{rosterAudit.backlog.length + rosterAudit.guests.length}</span>
            )}
          </h5>
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
        <div className="space-y-3">
          {/* Page-level utility strip — org-wide, not tied to any employee.
              Deliberately NOT a card matching the employee panel below, so it
              reads as a separate toolbar rather than a sibling control. The
              month picker + its report button are grouped as ONE widget so
              the pairing (which control drives which action) is unambiguous;
              Sync is a distinct, unrelated action set off by a divider. */}
          <div className="flex flex-wrap items-start gap-3 justify-start bg-gray-50 rounded-lg pb-2 text-sm border-b border-gray-200">
            <div className="mr-auto max-md:w-full">
              <h4 className='font-semibold text-sm md:text-base'>
                History & Reports
              </h4>
              <p className="text-gray-400 mt-1 text-xs">View Employee Record History & Details</p>
            </div>
            <div className="flex flex-wrap items-start gap-3">
              {isAdmin() && (
                <button onClick={runSync} disabled={syncing} className="btn btn-secondary !py-1.5 text-sm flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap border-l border-gray-200 pl-3" title="Reconstruct history from the audit log for every employee (admin, non-destructive)">
                  <FiRefreshCw size={12} className={syncing ? 'animate-spin' : ''} /> {syncing ? 'Syncing…' : 'Sync from audit log'}
                </button>
              )}
              <div className="pl-3 border-l-2 border-gray-6200">
                <div className="flex items-center gap-1.5 mb-0.5">
                  <input type="month" className="!text-sm !outline-none !w-32 h-8 p-2 rounded !border border-gray-200" max={istToday().slice(0, 7)} value={reportMonth} onChange={e => setReportMonth(e.target.value)} />
                  <button onClick={exportMonthlyReport} disabled={!!exportingKey} className="btn btn-primary text-sm flex items-center gap-2 whitespace-nowrap !py-1.5 disabled:opacity-50">
                    <FiDownload size={14} className={exportingKey === 'monthly' ? 'animate-pulse' : ''} /> {exportingKey === 'monthly' ? 'Exporting…' : 'Get Report'}
                  </button>
                </div>
                <span className="text-[11px] text-gray-400">Org-wide Monthly report — all employees</span>
              </div>
            </div>
          </div>

          {/* Everything below is scoped to ONE employee — selector, tabs,
              export, and content all live inside this single card. */}
          <div className="mt-6">
            <div className="mb-4 max-w-full w-96">
              <label className="label">Viewing employee</label>
              <SearchableSelect
                options={employees.map(e => ({ ...e, label: `${e.name} — ${e.designation || 'No designation'}${e.department ? `, ${e.department}` : ''}` }))}
                value={historyEmpId}
                valueKey="id"
                displayKey="label"
                placeholder="Search by name, designation, department…"
                onChange={(e) => setHistoryEmpId(e?.id || null)}
              />
            </div>

            {!historyEmpId && (
              <div className="min-h-[320px] flex items-center justify-center text-gray-400 text-sm border-t border-gray-200">
                Select an employee above to view their history and documents.
              </div>
            )}

            {historyEmpId && (() => {
              // Sleeker timeline — smaller paddings/text so it reads well squeezed into a half-width column on large screens.
              const eventsPanel = (
                <div className="relative pl-5">
                  <div className="absolute left-[7px] top-4 bottom-1 w-0.5 bg-gray-200"></div>
                  {events.map((g, gi) => (
                    <div key={gi} className="relative mb-3">
                      <div className="absolute -left-[16px] top-4 w-2 h-2 rounded-full bg-gray-400"></div>
                      <div className="border border-gray-200 rounded-lg p-3 bg-white">
                        <div className="flex justify-between items-baseline mb-1.5">
                          <span className="text-[11px] text-gray-500">{fmtDate(g.effective)}</span>
                          <span className="flex items-center gap-1.5">
                            {g.salary_action === 'revision' && g.salary_reason_code && (
                              <span className="text-[10px] text-gray-500">Pay: {SALARY_REASON_LABEL[g.salary_reason_code] || g.salary_reason_code}</span>
                            )}
                            <span className={`text-[11px] px-2 py-0.5 rounded-full font-semibold ${EVENT_BADGE[g.event_type] || 'bg-gray-100 text-gray-700'}`}>{g.event_type}</span>
                          </span>
                        </div>
                        <table className="w-full text-xs mb-1.5">
                          <tbody>
                            {g.fields.map((f, fi) => {
                              const fmtField = (v) => (f.label === 'Salary' && v && /^\d+$/.test(String(v))) ? `Rs ${Number(v).toLocaleString('en-IN')}` : v;
                              return (
                                <tr key={fi}>
                                  <td className="text-gray-500 py-0.5 pr-2 w-28 align-top">{f.label}</td>
                                  <td className="py-0.5">{f.from ? <>{fmtField(f.from)} <span className="text-gray-400">→</span> <span className="font-semibold">{fmtField(f.to) || '—'}</span></> : <span className="font-semibold">{fmtField(f.to) || '—'}</span>}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div className="border-t border-gray-100 pt-1.5 flex justify-between text-[11px] text-gray-500">
                          <span>Reason: {g.reason || '—'}</span>
                          <span>By {g.by || '—'}</span>
                        </div>
                      </div>
                    </div>
                  ))}
                  {events.length === 0 && <div className="bg-white border border-gray-200 rounded-lg text-center py-8 px-3 text-gray-400 text-sm">No history yet for this employee. An admin can <span className="font-semibold inline-block">Sync from audit log</span>.</div>}
                </div>
              );

              // Employee vault — read-only current details + mandatory documents.
              const vaultPanel = vault && (
                <div className="space-y-4">
                  <div className="border border-gray-200 rounded-lg p-4 bg-white">
                    <div className="text-xs text-gray-400 mb-2">Current details (read only)</div>
                    <div className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm break-words md:gap-x-6">
                      <div><span className="text-gray-500">Name</span><br /><span className="font-semibold">{vault.employee.name}</span></div>
                      <div><span className="text-gray-500">Status</span><br /><StatusBadge status={vault.employee.status} /></div>
                      <div><span className="text-gray-500">Phone</span><br />{vault.employee.phone || '—'}</div>
                      <div><span className="text-gray-500">Email</span><br />{vault.employee.email || '—'}</div>
                      <div><span className="text-gray-500">Designation</span><br />{vault.employee.designation || '—'}</div>
                      <div><span className="text-gray-500">Department</span><br />{vault.employee.department || '—'}</div>
                      <div><span className="text-gray-500">Join date</span><br />{vault.employee.join_date ? fmtDate(vault.employee.join_date) : '—'}</div>
                      <div><span className="text-gray-500">Roster</span><br />{vault.employee.roster || '—'}</div>
                      {canSeeSalary && <div><span className="text-gray-500">Salary</span><br />Rs {(vault.employee.salary || 0).toLocaleString('en-IN')}</div>}
                      <div><span className="text-gray-500">OT eligible</span><br />{vault.employee.ot_eligible ? 'Yes' : 'No'}</div>
                    </div>
                  </div>
                  <div className="text-xs text-gray-400">Documents</div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {vault.documents.map(d => (
                      <div key={d.doc_type} className="border border-gray-200 rounded-lg p-4 bg-white">
                        <div className="font-semibold text-sm mb-2">{d.label}</div>
                        <div className="text-[11px] text-gray-400 mb-2">{d.file_url ? (d.updated_at ? `Updated ${fmtDate(d.updated_at)}` : 'Uploaded') : 'Not uploaded'}</div>
                        <div className="flex gap-2">
                          <a href={d.file_url || undefined} target="_blank" rel="noreferrer" className={`btn btn-secondary text-xs flex-1 text-center ${!d.file_url ? 'opacity-40 pointer-events-none' : ''}`}>View</a>
                          <a href={d.file_url || undefined} download target="_blank" rel="noreferrer" className={`btn btn-secondary text-xs flex-1 text-center ${!d.file_url ? 'opacity-40 pointer-events-none' : ''}`}><FiDownload size={12} className="inline" /></a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );

              const exportBtn = (
                <button onClick={exportThisEmployee} disabled={!!exportingKey} className="btn btn-secondary text-xs flex items-center gap-1.5 !px-2.5 disabled:opacity-50">
                  <FiDownload size={12} className={exportingKey === 'employee' ? 'animate-pulse' : ''} /> {exportingKey === 'employee' ? 'Exporting…' : "Employee's history (Excel)"}
                </button>
              );

              // Single mount for each panel — mobile/desktop switch by CSS display
              // toggles (tab-state class + an lg: override), not by mounting the
              // panel twice in the tree. Heavy content (docs grid, timeline) only
              // ever exists once in the DOM.
              return (
                <div>
                  {/* Mobile/medium tab switcher — collapses away on large screens */}
                  <div className="lg:hidden flex gap-1 border-b border-gray-200 mb-4">
                    <button onClick={() => setHistoryTab('vault')} className={`px-3 py-2 text-sm font-semibold border-b-2 ${historyTab === 'vault' ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500'}`}>Employee vault</button>
                    <button onClick={() => setHistoryTab('events')} className={`px-3 py-2 text-sm font-semibold border-b-2 ${historyTab === 'events' ? 'border-red-600 text-red-700' : 'border-transparent text-gray-500'}`}>History</button>
                  </div>

                  <div className="lg:grid lg:grid-cols-5 lg:gap-6">
                    <div className={`${historyTab === 'vault' ? 'block' : 'hidden'} lg:block lg:col-span-3 lg:mt-3`}>
                      <h5 className="hidden lg:block font-semibold text-sm mb-3">Employee Vault</h5>
                      {vaultPanel}
                    </div>
                    <div className={`${historyTab === 'events' ? 'block' : 'hidden'} lg:block lg:col-span-2`}>
                      <div className="flex items-end justify-between mb-3 ml-5 lg:ml-0">
                        <h5 className="hidden lg:block font-semibold text-sm">History</h5>
                        {exportBtn}
                      </div>
                      {eventsPanel}
                    </div>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Add/Edit Workspace — extracted to components/employee/, see Phase 3 */}
      <EmployeeWorkspaceModal ws={workspace} employees={employees} users={users} canSeeSalary={canSeeSalary} />

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

      {/* In-app confirm (window.confirm is blocked in the embedded preview
          iframe — silently returns false, so a native confirm() would make
          Sync from audit log a dead button here). Same pattern as OrgStructure.jsx. */}
      {confirmBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmBox(null)}>
          <div className="w-full max-w-[360px] bg-white rounded-xl shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-4 py-2.5 border-b border-gray-100">
              <h3 className="text-[13px] font-semibold text-gray-800">{confirmBox.title || 'Confirm'}</h3>
            </div>
            <div className="px-4 py-3">
              <p className="text-[13px] leading-snug text-gray-600">{confirmBox.message}</p>
            </div>
            <div className="flex justify-end gap-2 px-4 pb-3">
              <button type="button" onClick={() => setConfirmBox(null)}
                className="px-3 py-1.5 text-xs font-medium rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50">Cancel</button>
              <button type="button" onClick={() => { const fn = confirmBox.onYes; setConfirmBox(null); fn?.(); }}
                className="px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700">{confirmBox.confirmLabel || 'Confirm'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
