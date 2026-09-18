import { useState, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  FiShield, FiAlertTriangle, FiCheckCircle, FiClock, FiUser,
  FiMapPin, FiFileText, FiRefreshCw, FiSearch, FiFilter,
  FiChevronRight, FiX, FiCheck, FiAlertCircle, FiPhoneCall,
  FiTrendingUp, FiActivity, FiEye, FiPlus,
} from 'react-icons/fi';
import api from '../api';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { fmtDate, fmtTime } from '../utils/datetime';

const VIOLATION_TYPE_CONFIG = {
  location_off: {
    label: 'GPS Turned Off',
    color: 'bg-red-50 text-red-700 border-red-200',
    badge: 'bg-red-600',
    icon: FiMapPin,
  },
  location_unavailable: {
    label: 'No Signal / Missing GPS',
    color: 'bg-amber-50 text-amber-700 border-amber-200',
    badge: 'bg-amber-600',
    icon: FiMapPin,
  },
  mandatory_task_overdue: {
    label: 'Mandatory Task Overdue',
    color: 'bg-purple-50 text-purple-700 border-purple-200',
    badge: 'bg-purple-600',
    icon: FiClock,
  },
  task_notification_unresponsive: {
    label: 'Task Notification Unresponsive',
    color: 'bg-indigo-50 text-indigo-700 border-indigo-200',
    badge: 'bg-indigo-600',
    icon: FiAlertCircle,
  },
  geofence_breach: {
    label: 'Geofence Breach',
    color: 'bg-orange-50 text-orange-700 border-orange-200',
    badge: 'bg-orange-600',
    icon: FiMapPin,
  },
};

const STATUS_CONFIG = {
  open: { label: 'Open', color: 'bg-red-100 text-red-800' },
  in_progress: { label: 'In Progress', color: 'bg-amber-100 text-amber-800' },
  pending_employee: { label: 'Pending Response', color: 'bg-blue-100 text-blue-800' },
  resolved: { label: 'Resolved', color: 'bg-emerald-100 text-emerald-800' },
  closed: { label: 'Closed', color: 'bg-gray-100 text-gray-800' },
};

export default function ComplianceDashboard() {
  const { user, isAdmin } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();

  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [dashboardData, setDashboardData] = useState(null);
  const [cases, setCases] = useState([]);
  const [totalCases, setTotalCases] = useState(0);
  const [page, setPage] = useState(1);

  // Filters
  const [statusFilter, setStatusFilter] = useState('all');
  const [violationFilter, setViolationFilter] = useState('all');
  const [searchTerm, setSearchTerm] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');

  // Selected Case Detail & Modal
  const [selectedCase, setSelectedCase] = useState(null);
  const [caseLogs, setCaseLogs] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [newCaseModal, setNewCaseModal] = useState(false);

  // Form states inside modal
  const [followupText, setFollowupText] = useState('');
  const [responseText, setResponseText] = useState('');
  const [resolutionText, setResolutionText] = useState('');
  const [submittingAction, setSubmittingAction] = useState(false);

  // Manual Case Creation state
  const [newCaseForm, setNewCaseForm] = useState({
    user_id: '',
    violation_type: 'location_off',
    title: '',
    description: '',
    sla_hours: 4,
    impacts_attendance: 1,
    impacts_expense: 1,
  });
  const [usersList, setUsersList] = useState([]);

  // Check if current user is compliance monitor or admin
  const isNancy = user?.email?.toLowerCase().includes('nancy') || user?.name?.toLowerCase().includes('nancy');
  const canManage = isAdmin() || isNancy;

  const loadDashboard = () => {
    setLoading(true);
    const query = new URLSearchParams();
    if (startDate) query.set('start_date', startDate);
    if (endDate) query.set('end_date', endDate);

    api.get(`/compliance/dashboard?${query.toString()}`)
      .then(res => {
        setDashboardData(res.data);
      })
      .catch(err => {
        toast.error('Failed to load compliance dashboard metrics');
      })
      .finally(() => setLoading(false));
  };

  const loadCases = () => {
    const query = new URLSearchParams({
      page: String(page),
      limit: '25',
      status: statusFilter,
      violation_type: violationFilter,
    });
    if (searchTerm) query.set('search', searchTerm);
    if (startDate) query.set('start_date', startDate);
    if (endDate) query.set('end_date', endDate);

    api.get(`/compliance/cases?${query.toString()}`)
      .then(res => {
        setCases(res.data.cases || []);
        setTotalCases(res.data.total || 0);
      })
      .catch(err => toast.error('Failed to load compliance cases'));
  };

  const loadCaseDetail = (caseId) => {
    api.get(`/compliance/cases/${caseId}`)
      .then(res => {
        setSelectedCase(res.data.caseItem);
        setCaseLogs(res.data.logs || []);
        setModalOpen(true);
      })
      .catch(err => toast.error('Failed to load case details'));
  };

  const loadUsers = async () => {
    try {
      const res = await api.get('/auth/users');
      const list = Array.isArray(res.data) ? res.data : (res.data?.users || []);
      if (list.length > 0) {
        setUsersList(list.filter(u => u.active !== 0));
        return;
      }
    } catch (_) {}

    try {
      const empRes = await api.get('/hr/employees');
      const emps = Array.isArray(empRes.data) ? empRes.data : (empRes.data?.employees || []);
      if (emps.length > 0) {
        setUsersList(emps.map(e => ({
          id: e.user_id || e.id,
          name: e.name,
          department: e.department,
          role: e.designation || 'Staff',
        })));
      }
    } catch (_) {}
  };

  useEffect(() => {
    loadDashboard();
    loadUsers();
  }, [startDate, endDate]);

  useEffect(() => {
    if (newCaseModal) {
      loadUsers();
    }
  }, [newCaseModal]);

  useEffect(() => {
    loadCases();
  }, [page, statusFilter, violationFilter, searchTerm, startDate, endDate]);

  // Open direct case from URL query ?case_id=
  useEffect(() => {
    const caseId = searchParams.get('case_id');
    if (caseId) {
      loadCaseDetail(caseId);
    }
  }, [searchParams]);

  const handleScanNow = async () => {
    setScanning(true);
    try {
      const res = await api.post('/compliance/scan-now');
      toast.success(res.data.message || 'Scan completed');
      loadDashboard();
      loadCases();
    } catch (err) {
      toast.error('Scan failed');
    } finally {
      setScanning(false);
    }
  };

  const handleSaveFollowup = async (e) => {
    e.preventDefault();
    if (!followupText.trim()) return toast.error('Please enter follow-up remarks');
    setSubmittingAction(true);
    try {
      await api.post(`/compliance/cases/${selectedCase.id}/followup`, { notes: followupText });
      toast.success('Follow-up logged');
      setFollowupText('');
      loadCaseDetail(selectedCase.id);
      loadDashboard();
      loadCases();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to log follow-up');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleSaveResponse = async (e) => {
    e.preventDefault();
    if (!responseText.trim()) return toast.error('Please enter response / explanation');
    setSubmittingAction(true);
    try {
      await api.post(`/compliance/cases/${selectedCase.id}/employee-response`, { response: responseText });
      toast.success('Response submitted');
      setResponseText('');
      loadCaseDetail(selectedCase.id);
      loadDashboard();
      loadCases();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to submit response');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleResolveCase = async (e) => {
    e.preventDefault();
    if (!resolutionText.trim()) return toast.error('Please enter resolution remarks');
    setSubmittingAction(true);
    try {
      await api.post(`/compliance/cases/${selectedCase.id}/resolve`, {
        resolution_notes: resolutionText,
        status: 'resolved',
      });
      toast.success('Case resolved and closed');
      setResolutionText('');
      loadCaseDetail(selectedCase.id);
      loadDashboard();
      loadCases();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to resolve case');
    } finally {
      setSubmittingAction(false);
    }
  };

  const handleUpdateFlags = async (impactsAttendance, impactsExpense) => {
    try {
      await api.post(`/compliance/cases/${selectedCase.id}/review-flags`, {
        impacts_attendance: impactsAttendance,
        impacts_expense: impactsExpense,
      });
      toast.success('Compliance review flags updated');
      loadCaseDetail(selectedCase.id);
    } catch (err) {
      toast.error('Failed to update flags');
    }
  };

  const handleCreateCase = async (e) => {
    e.preventDefault();
    if (!newCaseForm.user_id || !newCaseForm.title.trim()) {
      return toast.error('Please select an employee and specify a title');
    }
    setSubmittingAction(true);
    try {
      await api.post('/compliance/create-case', newCaseForm);
      toast.success('Compliance case created successfully');
      setNewCaseModal(false);
      setNewCaseForm({
        user_id: '',
        violation_type: 'location_off',
        title: '',
        description: '',
        sla_hours: 4,
        impacts_attendance: 1,
        impacts_expense: 1,
      });
      loadDashboard();
      loadCases();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to create case');
    } finally {
      setSubmittingAction(false);
    }
  };

  const kpi = dashboardData?.kpi || { overallKpi: 100, onTimeFollowUpScore: 100, closureScore: 100, taskViolationScore: 100, locationViolationScore: 100 };
  const metrics = dashboardData?.metrics || {};

  return (
    <div className="p-4 sm:p-6 max-w-7xl mx-auto space-y-6">
      {/* ── HEADER ── */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-gradient-to-r from-slate-900 via-indigo-950 to-slate-900 text-white p-6 rounded-2xl shadow-xl border border-slate-800">
        <div className="space-y-1">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-semibold uppercase tracking-wider border border-indigo-400/30">
            <FiShield size={14} className="text-indigo-400" /> SOTYN Compliance Monitoring
          </div>
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight">Compliance & Task Integrity</h1>
          <p className="text-slate-300 text-xs sm:text-sm">
            Mandatory task delivery, location tracking enforcement during duty hours, and Nancy's automated KPI tracking.
          </p>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {canManage && (
            <>
              <button
                onClick={() => setNewCaseModal(true)}
                className="btn bg-indigo-600 hover:bg-indigo-500 text-white text-xs px-3.5 py-2 rounded-xl flex items-center gap-1.5 shadow-md transition-all"
              >
                <FiPlus size={14} /> New Case
              </button>
              <button
                onClick={handleScanNow}
                disabled={scanning}
                className="btn bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs px-3.5 py-2 rounded-xl border border-slate-700 flex items-center gap-1.5 transition-all shadow-sm"
              >
                <FiRefreshCw size={13} className={scanning ? 'animate-spin text-indigo-400' : ''} />
                {scanning ? 'Scanning…' : 'Scan Violations'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* ── NANCY'S AUTOMATED KPI PROGRESS PANEL ── */}
      <div className="card p-5 bg-white border border-slate-200/80 rounded-2xl shadow-sm space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-gray-100 pb-3">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-50 flex items-center justify-center text-indigo-600 font-bold border border-indigo-100">
              <FiTrendingUp size={20} />
            </div>
            <div>
              <div className="text-sm font-bold text-gray-900 flex items-center gap-2">
                Nancy's Compliance Monitoring Score
                <span className="text-[10px] uppercase font-bold tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800">
                  Auto-Calculated · Locked
                </span>
              </div>
              <div className="text-xs text-gray-500">
                100% objective evaluation: 30% SLA Follow-up + 30% Closure + 20% Task Violations + 20% Location Violations
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="text-right">
              <div className="text-2xl font-extrabold text-indigo-600">{kpi.overallKpi}%</div>
              <div className="text-[10px] text-gray-400 font-medium">Weighted Final Score</div>
            </div>
          </div>
        </div>

        {/* 4 Weighted KPI Pillars */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2">
            <div className="flex justify-between items-center text-xs font-semibold text-gray-700">
              <span>On-Time SLA (30%)</span>
              <span className="font-bold text-indigo-600">{kpi.onTimeFollowUpScore}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div className="bg-indigo-600 h-2 rounded-full transition-all duration-500" style={{ width: `${kpi.onTimeFollowUpScore}%` }} />
            </div>
            <div className="text-[10.5px] text-gray-500 flex justify-between">
              <span>Followed up in SLA</span>
              <span className="font-medium text-gray-700">{kpi.details?.followedUpOnTime || 0} / {kpi.details?.total || 0}</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2">
            <div className="flex justify-between items-center text-xs font-semibold text-gray-700">
              <span>Case Closure (30%)</span>
              <span className="font-bold text-emerald-600">{kpi.closureScore}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div className="bg-emerald-600 h-2 rounded-full transition-all duration-500" style={{ width: `${kpi.closureScore}%` }} />
            </div>
            <div className="text-[10.5px] text-gray-500 flex justify-between">
              <span>Resolved & closed</span>
              <span className="font-medium text-gray-700">{kpi.details?.closedCases || 0} / {kpi.details?.total || 0}</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2">
            <div className="flex justify-between items-center text-xs font-semibold text-gray-700">
              <span>Task Follow-up (20%)</span>
              <span className="font-bold text-purple-600">{kpi.taskViolationScore}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div className="bg-purple-600 h-2 rounded-full transition-all duration-500" style={{ width: `${kpi.taskViolationScore}%` }} />
            </div>
            <div className="text-[10.5px] text-gray-500 flex justify-between">
              <span>Overdue tasks handled</span>
              <span className="font-medium text-gray-700">{kpi.details?.taskFollowedUp || 0} / {kpi.details?.taskCases || 0}</span>
            </div>
          </div>

          <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200/70 space-y-2">
            <div className="flex justify-between items-center text-xs font-semibold text-gray-700">
              <span>Field Location (20%)</span>
              <span className="font-bold text-amber-600">{kpi.locationViolationScore}%</span>
            </div>
            <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
              <div className="bg-amber-600 h-2 rounded-full transition-all duration-500" style={{ width: `${kpi.locationViolationScore}%` }} />
            </div>
            <div className="text-[10.5px] text-gray-500 flex justify-between">
              <span>Location cases handled</span>
              <span className="font-medium text-gray-700">{kpi.details?.locationFollowedUp || 0} / {kpi.details?.locationCases || 0}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ── METRIC CARDS ── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <div className="card p-4 bg-white border border-gray-100 rounded-2xl shadow-sm">
          <div className="text-xs text-gray-500 font-medium">Total Violations</div>
          <div className="text-2xl font-bold text-gray-900 mt-1">{metrics.totalViolations || 0}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Recorded by scanner</div>
        </div>

        <div className="card p-4 bg-white border border-gray-100 rounded-2xl shadow-sm">
          <div className="text-xs text-rose-600 font-medium flex items-center gap-1">
            <FiAlertTriangle size={12} /> Open Violations
          </div>
          <div className="text-2xl font-bold text-rose-700 mt-1">{metrics.openViolations || 0}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Requires monitoring</div>
        </div>

        <div className="card p-4 bg-white border border-gray-100 rounded-2xl shadow-sm">
          <div className="text-xs text-emerald-600 font-medium flex items-center gap-1">
            <FiCheckCircle size={12} /> Resolved Cases
          </div>
          <div className="text-2xl font-bold text-emerald-700 mt-1">{metrics.resolvedViolations || 0}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Successfully closed</div>
        </div>

        <div className="card p-4 bg-white border border-gray-100 rounded-2xl shadow-sm">
          <div className="text-xs text-amber-600 font-medium flex items-center gap-1">
            <FiClock size={12} /> SLA Overdue
          </div>
          <div className="text-2xl font-bold text-amber-700 mt-1">{metrics.overdueFollowups || 0}</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Exceeded response SLA</div>
        </div>

        <div className="card p-4 bg-white border border-gray-100 rounded-2xl shadow-sm col-span-2 sm:col-span-1">
          <div className="text-xs text-indigo-600 font-medium flex items-center gap-1">
            <FiActivity size={12} /> Avg Resolution
          </div>
          <div className="text-2xl font-bold text-indigo-700 mt-1">{metrics.avgResolutionTimeMinutes || 0}m</div>
          <div className="text-[10px] text-gray-400 mt-0.5">Average closure TAT</div>
        </div>
      </div>

      {/* ── CASES FILTER & DATA GRID ── */}
      <div className="card bg-white border border-gray-200/90 rounded-2xl shadow-sm overflow-hidden">
        {/* Table Filters */}
        <div className="p-4 border-b border-gray-100 bg-slate-50/50 flex flex-col md:flex-row items-center justify-between gap-3">
          <div className="flex items-center gap-2 w-full md:w-auto">
            <div className="relative flex-1 md:w-64">
              <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
              <input
                type="text"
                placeholder="Search case #, employee, issue…"
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                className="input pl-9 text-xs w-full py-1.5 rounded-xl border-gray-300"
              />
            </div>
            {searchTerm && (
              <button onClick={() => setSearchTerm('')} className="text-gray-400 hover:text-gray-600 p-1">
                <FiX size={14} />
              </button>
            )}
          </div>

          <div className="flex items-center gap-2 w-full md:w-auto flex-wrap">
            <select
              value={statusFilter}
              onChange={e => setStatusFilter(e.target.value)}
              className="select text-xs py-1.5 rounded-xl border-gray-300"
            >
              <option value="all">All Statuses</option>
              <option value="open">Open</option>
              <option value="in_progress">In Progress</option>
              <option value="pending_employee">Pending Employee</option>
              <option value="resolved">Resolved</option>
              <option value="closed">Closed</option>
            </select>

            <select
              value={violationFilter}
              onChange={e => setViolationFilter(e.target.value)}
              className="select text-xs py-1.5 rounded-xl border-gray-300"
            >
              <option value="all">All Violations</option>
              <option value="location_off">GPS Turned Off</option>
              <option value="location_unavailable">Missing Signal</option>
              <option value="mandatory_task_overdue">Task Overdue</option>
              <option value="task_notification_unresponsive">Task Unresponsive</option>
              <option value="geofence_breach">Geofence Breach</option>
            </select>

            <input
              type="date"
              value={startDate}
              onChange={e => setStartDate(e.target.value)}
              className="input text-xs py-1.5 rounded-xl border-gray-300"
              title="From Date"
            />
            <input
              type="date"
              value={endDate}
              onChange={e => setEndDate(e.target.value)}
              className="input text-xs py-1.5 rounded-xl border-gray-300"
              title="To Date"
            />
          </div>
        </div>

        {/* Data Table */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-slate-100/70 text-gray-600 uppercase text-[10px] tracking-wider border-b border-gray-200">
                <th className="p-3.5 font-semibold">Case #</th>
                <th className="p-3.5 font-semibold">Employee</th>
                <th className="p-3.5 font-semibold">Violation Type</th>
                <th className="p-3.5 font-semibold">Detected At</th>
                <th className="p-3.5 font-semibold">SLA Status</th>
                <th className="p-3.5 font-semibold">Follow-up</th>
                <th className="p-3.5 font-semibold">Review Flags</th>
                <th className="p-3.5 font-semibold">Status</th>
                <th className="p-3.5 font-semibold text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {cases.length === 0 ? (
                <tr>
                  <td colSpan={9} className="text-center py-10 text-gray-400">
                    <FiShield size={32} className="mx-auto opacity-30 mb-2" />
                    No compliance cases found for this criteria.
                  </td>
                </tr>
              ) : (
                cases.map(c => {
                  const cfg = VIOLATION_TYPE_CONFIG[c.violation_type] || VIOLATION_TYPE_CONFIG.location_off;
                  const st = STATUS_CONFIG[c.status] || STATUS_CONFIG.open;
                  const isSlaBreached = c.status !== 'resolved' && c.status !== 'closed' && c.sla_deadline && new Date() > new Date(c.sla_deadline);

                  return (
                    <tr key={c.id} className="hover:bg-indigo-50/30 transition-colors">
                      <td className="p-3.5 font-mono font-bold text-gray-900">
                        {c.case_number}
                      </td>
                      <td className="p-3.5">
                        <div className="font-semibold text-gray-800">{c.employee_name || 'N/A'}</div>
                        <div className="text-[10px] text-gray-400">{c.user_department || c.user_phone || 'Field Staff'}</div>
                      </td>
                      <td className="p-3.5">
                        <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[11px] font-medium border ${cfg.color}`}>
                          <span className={`w-1.5 h-1.5 rounded-full ${cfg.badge}`} />
                          {cfg.label}
                        </span>
                      </td>
                      <td className="p-3.5 text-gray-600">
                        <div>{fmtDate(c.detected_at)}</div>
                        <div className="text-[10px] text-gray-400">{fmtTime(c.detected_at)}</div>
                      </td>
                      <td className="p-3.5">
                        {c.status === 'resolved' || c.status === 'closed' ? (
                          <span className="text-emerald-700 text-[11px] font-medium flex items-center gap-1">
                            <FiCheck size={12} /> Resolved in {c.resolution_time_minutes || 0}m
                          </span>
                        ) : isSlaBreached ? (
                          <span className="text-red-700 text-[11px] font-bold flex items-center gap-1 animate-pulse">
                            <FiAlertTriangle size={12} /> SLA Breached
                          </span>
                        ) : (
                          <span className="text-gray-600 text-[11px] flex items-center gap-1">
                            <FiClock size={11} className="text-indigo-500" /> Due by {fmtTime(c.sla_deadline)}
                          </span>
                        )}
                      </td>
                      <td className="p-3.5">
                        {c.followup_status === 'contacted' ? (
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-md font-medium">
                            <FiPhoneCall size={10} /> Contacted
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-[10.5px] text-amber-700 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md font-medium">
                            <FiClock size={10} /> Pending
                          </span>
                        )}
                      </td>
                      <td className="p-3.5">
                        <div className="flex items-center gap-1.5">
                          {c.impacts_attendance ? (
                            <span className="text-[10px] font-semibold bg-rose-50 text-rose-700 border border-rose-200 px-1.5 py-0.5 rounded" title="Attendance impacted">
                              Att: ⚠
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-400">Att: OK</span>
                          )}
                          {c.impacts_expense ? (
                            <span className="text-[10px] font-semibold bg-amber-50 text-amber-700 border border-amber-200 px-1.5 py-0.5 rounded" title="Field expense review flag">
                              Exp: ⚠
                            </span>
                          ) : (
                            <span className="text-[10px] text-gray-400">Exp: OK</span>
                          )}
                        </div>
                      </td>
                      <td className="p-3.5">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold ${st.color}`}>
                          {st.label}
                        </span>
                      </td>
                      <td className="p-3.5 text-right">
                        <button
                          onClick={() => loadCaseDetail(c.id)}
                          className="btn bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 text-xs px-2.5 py-1 rounded-lg inline-flex items-center gap-1 shadow-sm transition-all"
                        >
                          <FiEye size={12} /> Audit & Actions
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="p-3 border-t border-gray-100 bg-slate-50/50 flex justify-between items-center text-xs text-gray-500">
          <span>Showing {cases.length} of {totalCases} compliance cases</span>
          <div className="flex gap-2">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page === 1}
              className="btn btn-secondary text-xs py-1 px-2.5 disabled:opacity-50"
            >
              Previous
            </button>
            <button
              onClick={() => setPage(p => p + 1)}
              disabled={cases.length < 25}
              className="btn btn-secondary text-xs py-1 px-2.5 disabled:opacity-50"
            >
              Next
            </button>
          </div>
        </div>
      </div>

      {/* ── STEP-BY-STEP CASE AUDIT & ACTION MODAL ── */}
      {modalOpen && selectedCase && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4 overflow-y-auto">
          <div className="bg-white rounded-2xl shadow-2xl max-w-3xl w-full border border-gray-200 overflow-hidden my-8 animate-in fade-in zoom-in-95 duration-200">
            {/* Modal Header */}
            <div className="bg-gradient-to-r from-slate-900 to-indigo-950 text-white p-5 flex items-start justify-between">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-sm font-bold text-indigo-300">{selectedCase.case_number}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${STATUS_CONFIG[selectedCase.status]?.color || 'bg-gray-100'}`}>
                    {selectedCase.status}
                  </span>
                </div>
                <h2 className="text-lg font-bold text-white">{selectedCase.title}</h2>
                <div className="text-xs text-slate-300">
                  Concerned Employee: <strong className="text-white">{selectedCase.employee_name}</strong> ({selectedCase.user_department || 'Field Staff'})
                </div>
              </div>
              <button
                onClick={() => { setModalOpen(false); setSelectedCase(null); }}
                className="text-slate-400 hover:text-white p-1 rounded-lg bg-slate-800/80"
              >
                <FiX size={18} />
              </button>
            </div>

            <div className="p-6 space-y-6 max-h-[75vh] overflow-y-auto text-xs">
              {/* ── Step-by-Step Audit Lifecycle Progression ── */}
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-3">
                <div className="text-xs font-bold uppercase tracking-wider text-gray-700 flex items-center gap-1.5">
                  <FiActivity size={14} className="text-indigo-600" /> Compliance Lifecycle Trail
                </div>

                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-center">
                  <div className="p-2.5 rounded-lg bg-white border border-gray-200 shadow-2xs space-y-1">
                    <div className="text-[10px] font-bold uppercase text-gray-500">1. Detection</div>
                    <div className="font-semibold text-gray-800">{fmtTime(selectedCase.detected_at)}</div>
                    <div className="text-[10px] text-emerald-600 font-medium">✓ Logged</div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-white border border-gray-200 shadow-2xs space-y-1">
                    <div className="text-[10px] font-bold uppercase text-gray-500">2. Dual Alerts</div>
                    <div className="font-semibold text-gray-800">{selectedCase.alert_sent ? 'Sent' : 'Pending'}</div>
                    <div className="text-[10px] text-emerald-600 font-medium">✓ Emp + Nancy</div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-white border border-gray-200 shadow-2xs space-y-1">
                    <div className="text-[10px] font-bold uppercase text-gray-500">3. Nancy Follow-up</div>
                    <div className="font-semibold text-gray-800">
                      {selectedCase.followed_up_at ? fmtTime(selectedCase.followed_up_at) : 'Pending'}
                    </div>
                    <div className={`text-[10px] font-medium ${selectedCase.followed_up_at ? 'text-emerald-600' : 'text-amber-600'}`}>
                      {selectedCase.followed_up_at ? '✓ Contacted' : '⏳ In Progress'}
                    </div>
                  </div>

                  <div className="p-2.5 rounded-lg bg-white border border-gray-200 shadow-2xs space-y-1">
                    <div className="text-[10px] font-bold uppercase text-gray-500">4. Resolution</div>
                    <div className="font-semibold text-gray-800">
                      {selectedCase.resolved_at ? fmtTime(selectedCase.resolved_at) : 'Open'}
                    </div>
                    <div className={`text-[10px] font-medium ${selectedCase.resolved_at ? 'text-emerald-600' : 'text-slate-400'}`}>
                      {selectedCase.resolved_at ? `✓ In ${selectedCase.resolution_time_minutes}m` : 'Pending'}
                    </div>
                  </div>
                </div>
              </div>

              {/* Case Violation Details */}
              <div className="space-y-2">
                <div className="font-semibold text-gray-800">Violation Details</div>
                <div className="p-3.5 bg-gray-50 rounded-xl border border-gray-200 text-gray-700 leading-relaxed">
                  {selectedCase.description || 'No additional details provided.'}
                </div>
              </div>

              {/* Nancy Follow-Up Section */}
              <div className="space-y-2 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-gray-800 flex items-center gap-1.5">
                    <FiPhoneCall size={13} className="text-indigo-600" /> Nancy Follow-Up & Contact Log
                  </div>
                  {selectedCase.followed_up_at && (
                    <span className="text-[11px] text-gray-400">
                      Followed up by {selectedCase.followed_up_by_name || 'Nancy'} at {fmtDate(selectedCase.followed_up_at)} {fmtTime(selectedCase.followed_up_at)}
                    </span>
                  )}
                </div>

                {selectedCase.followup_notes ? (
                  <div className="p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 text-indigo-950">
                    <strong>Logged Note:</strong> {selectedCase.followup_notes}
                  </div>
                ) : canManage ? (
                  <form onSubmit={handleSaveFollowup} className="space-y-2">
                    <textarea
                      rows={2}
                      placeholder="Enter follow-up remarks (e.g. called employee at 10:15, verified reason for GPS loss)…"
                      value={followupText}
                      onChange={e => setFollowupText(e.target.value)}
                      className="input w-full p-2.5 rounded-xl border-gray-300 text-xs"
                    />
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={submittingAction}
                        className="btn bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-1.5 rounded-xl shadow-xs"
                      >
                        {submittingAction ? 'Saving…' : 'Log Follow-Up Call'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="text-gray-400 italic">No follow-up logged yet.</p>
                )}
              </div>

              {/* Employee Response Section */}
              <div className="space-y-2 border-t border-gray-100 pt-4">
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-gray-800 flex items-center gap-1.5">
                    <FiUser size={13} className="text-blue-600" /> Employee Response & Explanation
                  </div>
                  {selectedCase.employee_responded_at && (
                    <span className="text-[11px] text-gray-400">
                      Responded at {fmtDate(selectedCase.employee_responded_at)} {fmtTime(selectedCase.employee_responded_at)}
                    </span>
                  )}
                </div>

                {selectedCase.employee_response ? (
                  <div className="p-3 bg-blue-50/50 rounded-xl border border-blue-100 text-blue-950">
                    <strong>Employee:</strong> {selectedCase.employee_response}
                  </div>
                ) : (
                  <form onSubmit={handleSaveResponse} className="space-y-2">
                    <textarea
                      rows={2}
                      placeholder="Submit explanation/response regarding this compliance alert…"
                      value={responseText}
                      onChange={e => setResponseText(e.target.value)}
                      className="input w-full p-2.5 rounded-xl border-gray-300 text-xs"
                    />
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={submittingAction}
                        className="btn bg-blue-600 hover:bg-blue-700 text-white text-xs px-3 py-1.5 rounded-xl shadow-xs"
                      >
                        {submittingAction ? 'Submitting…' : 'Submit Response'}
                      </button>
                    </div>
                  </form>
                )}
              </div>

              {/* Attendance & Expense Flags Controls */}
              {canManage && (
                <div className="p-3.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
                  <div className="font-semibold text-gray-800">Compliance Penalty / Review Flags</div>
                  <div className="flex items-center gap-6">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!selectedCase.impacts_attendance}
                        onChange={e => handleUpdateFlags(e.target.checked ? 1 : 0, selectedCase.impacts_expense)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-gray-700 font-medium">Flag in Attendance Review</span>
                    </label>

                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={!!selectedCase.impacts_expense}
                        onChange={e => handleUpdateFlags(selectedCase.impacts_attendance, e.target.checked ? 1 : 0)}
                        className="rounded border-gray-300 text-indigo-600 focus:ring-indigo-500"
                      />
                      <span className="text-xs text-gray-700 font-medium">Flag in Field Expense Review</span>
                    </label>
                  </div>
                </div>
              )}

              {/* Resolution Section */}
              <div className="space-y-2 border-t border-gray-100 pt-4">
                <div className="font-semibold text-gray-800 flex items-center gap-1.5">
                  <FiCheckCircle size={13} className="text-emerald-600" /> Resolution & Case Closure
                </div>

                {selectedCase.resolution_notes ? (
                  <div className="p-3.5 bg-emerald-50 rounded-xl border border-emerald-200 text-emerald-950">
                    <div className="font-semibold mb-1">
                      Case Closed by {selectedCase.resolved_by_name || 'Monitor'} at {fmtDate(selectedCase.resolved_at)} {fmtTime(selectedCase.resolved_at)}
                    </div>
                    <p>{selectedCase.resolution_notes}</p>
                  </div>
                ) : canManage ? (
                  <form onSubmit={handleResolveCase} className="space-y-2">
                    <textarea
                      rows={2}
                      placeholder="Enter final resolution notes to officially resolve and close this compliance case…"
                      value={resolutionText}
                      onChange={e => setResolutionText(e.target.value)}
                      className="input w-full p-2.5 rounded-xl border-gray-300 text-xs"
                    />
                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={submittingAction}
                        className="btn bg-emerald-600 hover:bg-emerald-700 text-white text-xs px-3.5 py-1.5 rounded-xl shadow-xs"
                      >
                        {submittingAction ? 'Resolving…' : 'Resolve & Close Case'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <p className="text-gray-400 italic">Awaiting resolution by compliance monitor.</p>
                )}
              </div>

              {/* Complete Chronological Audit Log Trail */}
              <div className="space-y-2 border-t border-gray-100 pt-4">
                <div className="font-semibold text-gray-800">Activity & Audit Trail</div>
                <div className="space-y-2 max-h-48 overflow-y-auto">
                  {caseLogs.map(log => (
                    <div key={log.id} className="p-2.5 rounded-lg bg-gray-50 border border-gray-200/80 flex items-start gap-2.5 text-[11px]">
                      <div className="w-1.5 h-1.5 rounded-full bg-indigo-500 mt-1.5 flex-shrink-0" />
                      <div className="flex-1">
                        <div className="flex justify-between items-center">
                          <span className="font-semibold text-gray-800">{log.performer_name_resolved || log.performer_name || 'System'}</span>
                          <span className="text-[10px] text-gray-400">{fmtDate(log.created_at)} {fmtTime(log.created_at)}</span>
                        </div>
                        <p className="text-gray-600 mt-0.5">{log.notes}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ── CREATE NEW CASE MODAL ── */}
      {newCaseModal && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full border border-gray-200 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
            <div className="bg-slate-900 text-white p-4 flex items-center justify-between">
              <h3 className="font-bold text-sm flex items-center gap-2">
                <FiPlus size={16} className="text-indigo-400" /> Create Compliance Violation Case
              </h3>
              <button onClick={() => setNewCaseModal(false)} className="text-gray-400 hover:text-white">
                <FiX size={18} />
              </button>
            </div>

            <form onSubmit={handleCreateCase} className="p-5 space-y-3.5 text-xs">
              <div>
                <label className="label">Concerned Employee</label>
                <select
                  value={newCaseForm.user_id}
                  onChange={e => setNewCaseForm({ ...newCaseForm, user_id: e.target.value })}
                  required
                  className="select w-full"
                >
                  <option value="">Select Employee</option>
                  {usersList.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.name} ({u.department || u.role || 'Staff'})
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="label">Violation Category</label>
                <select
                  value={newCaseForm.violation_type}
                  onChange={e => setNewCaseForm({ ...newCaseForm, violation_type: e.target.value })}
                  className="select w-full"
                >
                  <option value="location_off">GPS Turned Off</option>
                  <option value="location_unavailable">Missing / Unreported Location</option>
                  <option value="mandatory_task_overdue">Mandatory Task Overdue</option>
                  <option value="task_notification_unresponsive">Task Notification Unresponsive</option>
                  <option value="geofence_breach">Geofence Breach</option>
                </select>
              </div>

              <div>
                <label className="label">Case Title</label>
                <input
                  type="text"
                  placeholder="e.g. Field GPS Signal Lost During Work Hours"
                  value={newCaseForm.title}
                  onChange={e => setNewCaseForm({ ...newCaseForm, title: e.target.value })}
                  required
                  className="input w-full"
                />
              </div>

              <div>
                <label className="label">Issue Description</label>
                <textarea
                  rows={3}
                  placeholder="Provide violation context, location or task details…"
                  value={newCaseForm.description}
                  onChange={e => setNewCaseForm({ ...newCaseForm, description: e.target.value })}
                  className="input w-full"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="label">SLA Deadline (Hours)</label>
                  <input
                    type="number"
                    min="1"
                    max="48"
                    value={newCaseForm.sla_hours}
                    onChange={e => setNewCaseForm({ ...newCaseForm, sla_hours: Number(e.target.value) })}
                    className="input w-full"
                  />
                </div>
                <div className="pt-5 space-y-1">
                  <label className="flex items-center gap-2">
                    <input
                      type="checkbox"
                      checked={!!newCaseForm.impacts_attendance}
                      onChange={e => setNewCaseForm({ ...newCaseForm, impacts_attendance: e.target.checked ? 1 : 0 })}
                    />
                    <span>Impacts Attendance</span>
                  </label>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2 border-t border-gray-100">
                <button
                  type="button"
                  onClick={() => setNewCaseModal(false)}
                  className="btn btn-secondary text-xs"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingAction}
                  className="btn btn-primary text-xs"
                >
                  {submittingAction ? 'Creating…' : 'Create Case'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
