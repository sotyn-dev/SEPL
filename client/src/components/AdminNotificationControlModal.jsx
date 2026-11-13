import { useState, useEffect, useMemo } from 'react';
import {
  FiX,
  FiBell,
  FiCheck,
  FiShield,
  FiLock,
  FiUnlock,
  FiSmartphone,
  FiSearch,
  FiSend,
  FiRotateCw,
  FiCheckCircle,
  FiCheckSquare,
  FiSquare,
  FiChevronDown,
  FiChevronUp
} from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';

const CATEGORIES = [
  { key: 'chat_mention', label: 'Mentions', icon: '💬' },
  { key: 'chat_dm',      label: 'DMs',      icon: '✉️' },
  { key: 'delegation',   label: 'Tasks',    icon: '📋' },
  { key: 'ticket',       label: 'Tickets',  icon: '🆘' },
  { key: 'approval',     label: 'Approvals',icon: '📄' },
];

export default function AdminNotificationControlModal({ isOpen, onClose }) {
  const [employees, setEmployees] = useState([]);
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [testingId, setTestingId] = useState(null);
  const [search, setSearch] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('all'); // all | active | disabled | unregistered | enforced
  const [expandedUser, setExpandedUser] = useState(null);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    if (isOpen) {
      loadMatrix();
    }
  }, [isOpen]);

  const loadMatrix = async () => {
    try {
      setLoading(true);
      const res = await api.get('/notifications/admin/employee-matrix');
      setEmployees(res.data || []);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to load employee notification matrix');
    } finally {
      setLoading(false);
    }
  };

  // Toggle single category preference for an employee (toggles both push and in_app)
  const handleTogglePref = async (employee, catKey) => {
    const current = employee.preferences[catKey] || { in_app: true, push: true };
    const nextState = !(current.push !== false);
    const updatedPref = {
      in_app: nextState,
      push: nextState,
      email: current.email || false
    };

    // Optimistic update
    setEmployees(prev =>
      prev.map(u => {
        if (u.id === employee.id) {
          return {
            ...u,
            preferences: {
              ...u.preferences,
              [catKey]: updatedPref
            }
          };
        }
        return u;
      })
    );

    try {
      await api.put(`/notifications/admin/employee/${employee.id}`, {
        preferences: {
          [catKey]: updatedPref
        }
      });
      toast.success(`${employee.name}: ${catKey} set to ${nextState ? 'ON' : 'OFF'}`, { id: `pref-${employee.id}` });
    } catch (err) {
      toast.error('Failed to update preference');
      loadMatrix();
    }
  };

  // Toggle strict enforcement policy for an employee
  const handleToggleEnforcement = async employee => {
    const nextVal = !employee.strictly_enforced;
    setSavingId(employee.id);

    // If enforcing, automatically turn on all preferences for that employee
    const updatedPreferences = { ...employee.preferences };
    if (nextVal) {
      CATEGORIES.forEach(c => {
        updatedPreferences[c.key] = { in_app: true, push: true, email: false };
      });
    }

    setEmployees(prev =>
      prev.map(u => {
        if (u.id === employee.id) {
          return {
            ...u,
            strictly_enforced: nextVal,
            preferences: nextVal ? updatedPreferences : u.preferences
          };
        }
        return u;
      })
    );

    try {
      await api.put(`/notifications/admin/employee/${employee.id}`, {
        strictly_enforced: nextVal,
        reactivate_devices: nextVal,
        preferences: nextVal ? updatedPreferences : undefined
      });
      toast.success(
        nextVal
          ? `Strict Policy LOCKED for ${employee.name}`
          : `Strict Policy lifted for ${employee.name}`
      );
    } catch (err) {
      toast.error('Failed to update enforcement policy');
      loadMatrix();
    } finally {
      setSavingId(null);
    }
  };

  // Remotely turn ON all notifications & reactivate devices for an employee
  const handleTurnOnAll = async employee => {
    setSavingId(employee.id);
    const updatedPrefs = {};
    CATEGORIES.forEach(c => {
      updatedPrefs[c.key] = { in_app: true, push: true, email: false };
    });

    setEmployees(prev =>
      prev.map(u => {
        if (u.id === employee.id) {
          return {
            ...u,
            preferences: { ...u.preferences, ...updatedPrefs },
            overall_push_status: u.total_devices > 0 ? 'active' : u.overall_push_status
          };
        }
        return u;
      })
    );

    try {
      await api.put(`/notifications/admin/employee/${employee.id}`, {
        preferences: updatedPrefs,
        reactivate_devices: true
      });
      toast.success(`Turned ON all notifications for ${employee.name}`);
      loadMatrix();
    } catch (err) {
      toast.error('Failed to turn on notifications');
      loadMatrix();
    } finally {
      setSavingId(null);
    }
  };

  // Send test push to an employee
  const handleTestPush = async employee => {
    setTestingId(employee.id);
    try {
      const res = await api.post(`/push/admin/test-employee/${employee.id}`, {
        message: `Admin Test: Push alert connectivity verified for ${employee.name} ✓`
      });
      if (res.data?.sent > 0) {
        toast.success(`Push delivered to ${res.data.sent} device(s) of ${employee.name}! 🎉`);
      } else {
        toast.error(`No active push subscription received the message for ${employee.name}. Check their device status.`);
      }
    } catch (err) {
      toast.error(err.response?.data?.error || 'Test push failed');
    } finally {
      setTestingId(null);
    }
  };

  // Bulk actions
  const handleBulkAction = async (actionType) => {
    const targetIds = selectedIds.size > 0 ? Array.from(selectedIds) : filteredEmployees.map(u => u.id);
    if (targetIds.length === 0) {
      toast.error('No employees selected or matching current filter');
      return;
    }

    setBulkBusy(true);
    try {
      if (actionType === 'turn_on_all') {
        await api.post('/notifications/admin/bulk-update', {
          user_ids: targetIds,
          turn_on_all: true
        });
        toast.success(`Turned ON all notifications for ${targetIds.length} employee(s)`);
      } else if (actionType === 'enforce') {
        await api.post('/notifications/admin/bulk-update', {
          user_ids: targetIds,
          strictly_enforced: true,
          turn_on_all: true
        });
        toast.success(`Strict Policy LOCKED for ${targetIds.length} employee(s)`);
      } else if (actionType === 'lift_enforce') {
        await api.post('/notifications/admin/bulk-update', {
          user_ids: targetIds,
          strictly_enforced: false
        });
        toast.success(`Strict Policy lifted for ${targetIds.length} employee(s)`);
      }
      setSelectedIds(new Set());
      await loadMatrix();
    } catch (err) {
      toast.error('Bulk update failed');
    } finally {
      setBulkBusy(false);
    }
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === filteredEmployees.length && filteredEmployees.length > 0) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(filteredEmployees.map(u => u.id)));
    }
  };

  const toggleSelectOne = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Departments list for filter
  const departments = useMemo(() => {
    const s = new Set();
    employees.forEach(e => {
      if (e.department) s.add(e.department);
    });
    return Array.from(s).sort();
  }, [employees]);

  // Filtered employees
  const filteredEmployees = useMemo(() => {
    return employees.filter(e => {
      if (search) {
        const q = search.toLowerCase();
        const matchName = e.name?.toLowerCase().includes(q);
        const matchUser = e.username?.toLowerCase().includes(q);
        const matchEmail = e.email?.toLowerCase().includes(q);
        if (!matchName && !matchUser && !matchEmail) return false;
      }
      if (deptFilter && e.department !== deptFilter) return false;
      if (statusFilter === 'active' && e.overall_push_status !== 'active') return false;
      if (statusFilter === 'disabled' && e.overall_push_status !== 'disabled') return false;
      if (statusFilter === 'unregistered' && e.overall_push_status !== 'unregistered') return false;
      if (statusFilter === 'enforced' && !e.strictly_enforced) return false;
      return true;
    });
  }, [employees, search, deptFilter, statusFilter]);

  // Aggregated KPI counts
  const counts = useMemo(() => {
    let activePush = 0;
    let disabledPush = 0;
    let unregistered = 0;
    let enforced = 0;
    employees.forEach(e => {
      if (e.overall_push_status === 'active') activePush++;
      else if (e.overall_push_status === 'disabled') disabledPush++;
      else unregistered++;
      if (e.strictly_enforced) enforced++;
    });
    return { total: employees.length, activePush, disabledPush, unregistered, enforced };
  }, [employees]);

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/60 backdrop-blur-xs animate-fade-in"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[94vh] flex flex-col border border-gray-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        
        {/* Header */}
        <div className="px-5 py-3.5 bg-gradient-to-r from-slate-900 via-indigo-950 to-blue-900 text-white flex items-center justify-between shadow-md flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-600/30 border border-blue-400/30 rounded-xl text-blue-300">
              <FiBell size={20} />
            </div>
            <div>
              <h3 className="font-bold text-base flex items-center gap-2">
                Employee Push & Notification Control Desk
                <span className="bg-blue-500/20 text-blue-200 text-xs px-2.5 py-0.5 rounded-full border border-blue-400/20">
                  Admin Master
                </span>
              </h3>
              <p className="text-xs text-blue-200/80">
                Audit device push subscriptions, remotely enable alerts, and enforce mandatory policies.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 hover:bg-white/10 rounded-lg text-white/80 hover:text-white transition-colors"
            title="Close"
          >
            <FiX size={20} />
          </button>
        </div>

        {/* Top KPI Metrics Bar */}
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 p-3 bg-slate-50 border-b border-gray-200 text-xs flex-shrink-0">
          <div
            onClick={() => setStatusFilter('all')}
            className={`p-2.5 rounded-xl border cursor-pointer transition ${
              statusFilter === 'all'
                ? 'bg-blue-50 border-blue-300 ring-2 ring-blue-500/20'
                : 'bg-white border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-gray-500">Total Employees</div>
            <div className="text-lg font-bold text-gray-800">{counts.total}</div>
          </div>

          <div
            onClick={() => setStatusFilter('active')}
            className={`p-2.5 rounded-xl border cursor-pointer transition ${
              statusFilter === 'active'
                ? 'bg-emerald-50 border-emerald-300 ring-2 ring-emerald-500/20'
                : 'bg-white border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-emerald-700 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              Active Push
            </div>
            <div className="text-lg font-bold text-emerald-700">{counts.activePush}</div>
          </div>

          <div
            onClick={() => setStatusFilter('disabled')}
            className={`p-2.5 rounded-xl border cursor-pointer transition ${
              statusFilter === 'disabled'
                ? 'bg-amber-50 border-amber-300 ring-2 ring-amber-500/20'
                : 'bg-white border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-amber-700 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              Disabled by User
            </div>
            <div className="text-lg font-bold text-amber-700">{counts.disabledPush}</div>
          </div>

          <div
            onClick={() => setStatusFilter('unregistered')}
            className={`p-2.5 rounded-xl border cursor-pointer transition ${
              statusFilter === 'unregistered'
                ? 'bg-slate-100 border-slate-300 ring-2 ring-slate-500/20'
                : 'bg-white border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-gray-500 flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-gray-400" />
              No Device Yet
            </div>
            <div className="text-lg font-bold text-gray-600">{counts.unregistered}</div>
          </div>

          <div
            onClick={() => setStatusFilter('enforced')}
            className={`p-2.5 rounded-xl border cursor-pointer transition col-span-2 sm:col-span-1 ${
              statusFilter === 'enforced'
                ? 'bg-indigo-50 border-indigo-300 ring-2 ring-indigo-500/20'
                : 'bg-white border-gray-200 hover:border-gray-300'
            }`}
          >
            <div className="text-[11px] font-semibold text-indigo-700 flex items-center gap-1.5">
              <FiLock size={12} />
              Strictly Enforced
            </div>
            <div className="text-lg font-bold text-indigo-700">{counts.enforced}</div>
          </div>
        </div>

        {/* Filtration & Bulk Toolbar */}
        <div className="p-3 bg-white border-b border-gray-200 flex flex-wrap items-center justify-between gap-2.5 text-xs flex-shrink-0">
          <div className="flex flex-wrap items-center gap-2 flex-1 min-w-[280px]">
            {/* Search */}
            <div className="relative flex-1 min-w-[160px] max-w-xs">
              <FiSearch className="absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                type="text"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search employee name, username…"
                className="w-full pl-8 pr-3 py-1.5 border border-gray-200 rounded-lg text-xs focus:outline-none focus:ring-1 focus:ring-blue-600"
              />
              {search && (
                <button
                  onClick={() => setSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600"
                >
                  <FiX size={13} />
                </button>
              )}
            </div>

            {/* Department Filter */}
            <select
              value={deptFilter}
              onChange={e => setDeptFilter(e.target.value)}
              className="px-2.5 py-1.5 border border-gray-200 rounded-lg text-xs bg-white text-gray-700 focus:outline-none focus:ring-1 focus:ring-blue-600"
            >
              <option value="">All Departments ({departments.length})</option>
              {departments.map(d => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>

            {/* Refresh */}
            <button
              onClick={loadMatrix}
              disabled={loading}
              className="p-1.5 border border-gray-200 rounded-lg text-gray-600 hover:bg-gray-100 transition"
              title="Refresh Matrix"
            >
              <FiRotateCw size={14} className={loading ? 'animate-spin' : ''} />
            </button>
          </div>

          {/* Bulk Action Buttons */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[11px] text-gray-500 font-medium hidden sm:inline">
              {selectedIds.size > 0
                ? `${selectedIds.size} selected`
                : `${filteredEmployees.length} matching`}
            </span>

            <button
              onClick={() => handleBulkAction('turn_on_all')}
              disabled={bulkBusy}
              className="px-2.5 py-1.5 bg-emerald-50 text-emerald-700 border border-emerald-300 rounded-lg font-semibold hover:bg-emerald-100 transition flex items-center gap-1.5 shadow-2xs"
              title="Turn ON all categories for these employees"
            >
              <FiCheckCircle size={13} /> Turn ON All
            </button>

            <button
              onClick={() => handleBulkAction('enforce')}
              disabled={bulkBusy}
              className="px-2.5 py-1.5 bg-indigo-50 text-indigo-700 border border-indigo-300 rounded-lg font-semibold hover:bg-indigo-100 transition flex items-center gap-1.5 shadow-2xs"
              title="Strictly lock notifications ON so employees cannot disable them"
            >
              <FiLock size={13} /> Lock Strict Policy
            </button>

            <button
              onClick={() => handleBulkAction('lift_enforce')}
              disabled={bulkBusy}
              className="px-2.5 py-1.5 bg-gray-50 text-gray-700 border border-gray-300 rounded-lg hover:bg-gray-100 transition flex items-center gap-1.5 shadow-2xs"
              title="Lift strict lock"
            >
              <FiUnlock size={13} /> Lift Lock
            </button>
          </div>
        </div>

        {/* Matrix Table */}
        <div className="flex-1 overflow-y-auto overflow-x-auto min-h-[300px]">
          <table className="w-full text-left text-xs border-collapse">
            <thead className="bg-slate-100 text-gray-700 uppercase font-semibold text-[10px] tracking-wider sticky top-0 z-10 shadow-2xs">
              <tr>
                <th className="p-3 w-8 text-center">
                  <button
                    onClick={toggleSelectAll}
                    className="text-gray-500 hover:text-gray-800"
                    title={selectedIds.size === filteredEmployees.length ? 'Deselect all' : 'Select all'}
                  >
                    {selectedIds.size === filteredEmployees.length && filteredEmployees.length > 0 ? (
                      <FiCheckSquare size={16} className="text-blue-600" />
                    ) : (
                      <FiSquare size={16} />
                    )}
                  </button>
                </th>
                <th className="p-3 min-w-[170px]">Employee</th>
                <th className="p-3 min-w-[140px]">Push Device</th>
                <th className="p-3 w-24 text-center">Strict Lock</th>

                {/* Individual Category Columns */}
                {CATEGORIES.map(c => (
                  <th key={c.key} className="p-2.5 text-center min-w-[80px]" title={c.label}>
                    <div className="flex flex-col items-center justify-center">
                      <span>{c.icon}</span>
                      <span>{c.label}</span>
                    </div>
                  </th>
                ))}

                <th className="p-3 min-w-[130px] text-right">Quick Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {loading && employees.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-8 text-center text-gray-500">
                    <FiRotateCw size={24} className="animate-spin mx-auto mb-2 text-blue-600" />
                    Loading employee notification matrix...
                  </td>
                </tr>
              ) : filteredEmployees.length === 0 ? (
                <tr>
                  <td colSpan={10} className="p-8 text-center text-gray-500">
                    No employees matched the selected filters.
                  </td>
                </tr>
              ) : (
                filteredEmployees.map(emp => {
                  const isSelected = selectedIds.has(emp.id);
                  const isExpanded = expandedUser === emp.id;
                  const hasDevices = emp.total_devices > 0;
                  const isActivePush = emp.overall_push_status === 'active';
                  const isDisabledPush = emp.overall_push_status === 'disabled';

                  return (
                    <tr
                      key={emp.id}
                      className={`hover:bg-slate-50/80 transition-colors ${
                        isSelected ? 'bg-blue-50/40' : ''
                      }`}
                    >
                      {/* Checkbox */}
                      <td className="p-3 text-center">
                        <button
                          onClick={() => toggleSelectOne(emp.id)}
                          className="text-gray-400 hover:text-gray-700"
                        >
                          {isSelected ? (
                            <FiCheckSquare size={15} className="text-blue-600" />
                          ) : (
                            <FiSquare size={15} />
                          )}
                        </button>
                      </td>

                      {/* Employee Info */}
                      <td className="p-3">
                        <div className="font-semibold text-gray-900 flex items-center gap-1.5">
                          {emp.name}
                          {emp.role === 'admin' && (
                            <span className="text-[9px] bg-purple-100 text-purple-700 px-1.5 py-0.2 rounded font-bold">
                              ADMIN
                            </span>
                          )}
                        </div>
                        <div className="text-[11px] text-gray-500 flex items-center gap-2">
                          <span>{emp.department || 'No Dept'}</span>
                          <span>•</span>
                          <span className="font-mono text-gray-400">{emp.username}</span>
                        </div>
                      </td>

                      {/* Push Device Status */}
                      <td className="p-3">
                        {isActivePush ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                              <span className="font-bold text-emerald-700 text-[11px]">
                                Active ({emp.active_devices})
                              </span>
                            </div>
                            <div className="text-[10px] text-gray-500">
                              {emp.latest_seen_at
                                ? `Seen ${new Date(emp.latest_seen_at).toLocaleDateString('en-IN', {
                                    month: 'short',
                                    day: 'numeric',
                                    hour: '2-digit',
                                    minute: '2-digit'
                                  })}`
                                : 'Connected'}
                            </div>
                          </div>
                        ) : isDisabledPush ? (
                          <div className="space-y-0.5">
                            <div className="flex items-center gap-1.5">
                              <span className="w-2 h-2 rounded-full bg-amber-500" />
                              <span className="font-bold text-amber-700 text-[11px]">
                                Turned OFF ({emp.total_devices})
                              </span>
                            </div>
                            <button
                              onClick={() => handleTurnOnAll(emp)}
                              className="text-[10px] text-blue-600 hover:underline font-semibold"
                            >
                              Remote Turn ON
                            </button>
                          </div>
                        ) : (
                          <div className="text-gray-400 text-[11px] flex items-center gap-1">
                            <FiSmartphone size={13} />
                            <span>No device yet</span>
                          </div>
                        )}

                        {/* View devices toggle if user has devices */}
                        {hasDevices && (
                          <button
                            onClick={() => setExpandedUser(isExpanded ? null : emp.id)}
                            className="mt-1 text-[10px] text-gray-500 hover:text-indigo-600 flex items-center gap-0.5 underline decoration-dotted"
                          >
                            <span>{emp.devices.length} device info</span>
                            {isExpanded ? <FiChevronUp size={11} /> : <FiChevronDown size={11} />}
                          </button>
                        )}

                        {/* Device Detail Popup */}
                        {isExpanded && (
                          <div className="mt-1.5 p-2 bg-slate-100 rounded-lg text-[10px] text-gray-600 space-y-1 border border-slate-200">
                            {emp.devices.map((d, idx) => (
                              <div key={d.id || idx} className="border-b border-slate-200/60 pb-1 last:border-0 last:pb-0">
                                <div className="font-semibold text-gray-800 flex items-center justify-between">
                                  <span>{d.device_label || 'Browser Device'}</span>
                                  <span className={d.active ? 'text-emerald-600 font-bold' : 'text-gray-400'}>
                                    {d.active ? '🟢 Active' : '⚪ Inactive'}
                                  </span>
                                </div>
                                <div className="text-[9px] text-gray-500 truncate max-w-[200px]" title={d.user_agent}>
                                  {d.user_agent || 'Unknown UA'}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>

                      {/* Strict Enforcement Lock Toggle */}
                      <td className="p-3 text-center">
                        <button
                          onClick={() => handleToggleEnforcement(emp)}
                          disabled={savingId === emp.id}
                          className={`px-2.5 py-1 rounded-full text-[10px] font-bold inline-flex items-center gap-1 border transition-all ${
                            emp.strictly_enforced
                              ? 'bg-indigo-600 text-white border-indigo-700 shadow-xs'
                              : 'bg-gray-100 text-gray-600 border-gray-300 hover:bg-gray-200'
                          }`}
                          title={
                            emp.strictly_enforced
                              ? 'Strictly locked: Employee CANNOT turn off notifications or push'
                              : 'Unlocked: Employee can customize their own toggles'
                          }
                        >
                          {emp.strictly_enforced ? (
                            <>
                              <FiLock size={10} /> LOCKED
                            </>
                          ) : (
                            <>
                              <FiUnlock size={10} /> Free
                            </>
                          )}
                        </button>
                      </td>

                      {/* Individual Category Columns (Clickable Pill Checkboxes) */}
                      {CATEGORIES.map(cat => {
                        const setting = emp.preferences[cat.key] || { in_app: true, push: true };
                        const isEnabled = setting.push !== false || setting.in_app !== false;

                        return (
                          <td key={cat.key} className="p-2.5 text-center">
                            <button
                              type="button"
                              onClick={() => handleTogglePref(emp, cat.key)}
                              className={`px-2.5 py-1 rounded-lg text-[10px] font-bold border transition-all inline-flex items-center gap-1 shadow-2xs ${
                                isEnabled
                                  ? 'bg-indigo-50 border-indigo-300 text-indigo-700 hover:bg-indigo-100'
                                  : 'bg-gray-50 border-gray-200 text-gray-400 hover:bg-gray-100'
                              }`}
                              title={`${emp.name} - ${cat.label}: Click to toggle ${isEnabled ? 'OFF' : 'ON'}`}
                            >
                              {isEnabled ? (
                                <>
                                  <FiCheck size={11} className="text-indigo-600" />
                                  <span>ON</span>
                                </>
                              ) : (
                                <span>OFF</span>
                              )}
                            </button>
                          </td>
                        );
                      })}

                      {/* Quick Actions */}
                      <td className="p-3 text-right whitespace-nowrap">
                        <div className="flex items-center justify-end gap-1.5">
                          {/* Turn ON All Button */}
                          <button
                            onClick={() => handleTurnOnAll(emp)}
                            disabled={savingId === emp.id}
                            className="px-2.5 py-1 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-300 rounded-lg text-[11px] font-semibold transition"
                            title="Turn ON all categories and reactivate devices"
                          >
                            Turn ON
                          </button>

                          {/* Test Push Button */}
                          <button
                            onClick={() => handleTestPush(emp)}
                            disabled={testingId === emp.id || !hasDevices}
                            className={`px-2.5 py-1 border rounded-lg text-[11px] font-semibold flex items-center gap-1 transition ${
                              hasDevices
                                ? 'bg-blue-50 text-blue-700 hover:bg-blue-100 border-blue-300'
                                : 'bg-gray-50 text-gray-400 border-gray-200 cursor-not-allowed'
                            }`}
                            title={
                              hasDevices
                                ? 'Send a test push notification to this employee'
                                : 'Employee has not registered any device yet'
                            }
                          >
                            <FiSend size={11} className={testingId === emp.id ? 'animate-bounce' : ''} />
                            Test
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Footer info banner */}
        <div className="px-5 py-2.5 bg-slate-50 border-t border-gray-200 flex flex-wrap items-center justify-between text-[11px] text-gray-500 flex-shrink-0">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-gray-700">Guide:</span>
            <span className="flex items-center gap-1">Click any category pill (ON/OFF) to toggle alerts</span>
            <span>•</span>
            <span className="flex items-center gap-1">🔒 Locked = Policy mandated by Admin</span>
          </div>
          <div>
            Showing <span className="font-bold text-gray-700">{filteredEmployees.length}</span> of {employees.length} employees
          </div>
        </div>

      </div>
    </div>
  );
}
