import NumberedTable from './NumberedTable';
import { useEffect, useState } from 'react';
import api from '../api';
import Modal from './Modal';
import toast from 'react-hot-toast';
import {
  FiPlus, FiEdit2, FiTrash2, FiCheckCircle, FiXCircle, FiBriefcase,
  FiUsers, FiCalendar, FiLock, FiFileText, FiUploadCloud, FiPaperclip,
  FiDownload, FiTrendingUp, FiAlertTriangle, FiTarget, FiLayers,
  FiAward, FiCopy, FiEye, FiCheck, FiSearch, FiDollarSign, FiClock,
} from 'react-icons/fi';
import { useAuth } from '../context/AuthContext';

const EMPLOYMENT_TYPES = [
  { v: 'full_time',  l: 'Full-time' },
  { v: 'part_time',  l: 'Part-time' },
  { v: 'contract',   l: 'Contract'  },
  { v: 'internship', l: 'Internship'},
  { v: 'freelance',  l: 'Freelance' },
];

const STATUS_PILLS = [
  { id: 'pending',  label: 'Pending Approval', bg: 'bg-amber-500' },
  { id: 'approved', label: 'Approved (Open)',  bg: 'bg-emerald-500' },
  { id: 'rejected', label: 'Rejected',         bg: 'bg-rose-500' },
  { id: 'closed',   label: 'Closed / Fulfilled', bg: 'bg-gray-500' },
];

const JOB_LEVELS = [
  { id: 'L1', label: 'L1 · Junior / Trainee', exp: '0–1 years', min: 15000, max: 25000, badge: 'bg-sky-100 text-sky-800 border-sky-300' },
  { id: 'L2', label: 'L2 · Executive / Site Eng', exp: '1–3 years', min: 25000, max: 42000, badge: 'bg-blue-100 text-blue-800 border-blue-300' },
  { id: 'L3', label: 'L3 · Senior / Specialist', exp: '3–6 years', min: 42000, max: 65000, badge: 'bg-indigo-100 text-indigo-800 border-indigo-300' },
  { id: 'L4', label: 'L4 · Lead / Project Mgr', exp: '6–10 years', min: 65000, max: 110000, badge: 'bg-purple-100 text-purple-800 border-purple-300' },
  { id: 'L5', label: 'L5 · Senior Mgr / HOD', exp: '10+ years', min: 110000, max: 200000, badge: 'bg-rose-100 text-rose-800 border-rose-300' },
];

export default function HiringRequestsTab({ employees = [] }) {
  const { user, canDelete } = useAuth();
  const [rows, setRows] = useState([]);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false); // false | 'form' | 'view' | 'approve' | 'reject' | 'provision'
  const [formTab, setFormTab] = useState('requisition'); // 'requisition' | 'jd' | 'kras' | 'scorecards'
  const [editing, setEditing] = useState(null);
  const [viewingRow, setViewingRow] = useState(null);
  const [actionRow, setActionRow] = useState(null);
  const [reason, setReason] = useState('');
  const [uploading, setUploading] = useState(false);
  const [targetEmployeeId, setTargetEmployeeId] = useState('');

  // Department budgets & templates state
  const [deptSummary, setDeptSummary] = useState({ stats: [], budgets: [] });
  const [templates, setTemplates] = useState([]);

  // Form State
  const [form, setForm] = useState({
    department: '',
    position_title: '',
    job_level: 'L2',
    num_openings: 1,
    hiring_type: 'new_addition',
    exiting_employee_id: '',
    salary_min: '',
    salary_max: '',
    experience_required: '',
    employment_type: 'full_time',
    hiring_deadline: '',
    reporting_manager_id: '',
    job_description: '',
    file_attachments: [],
    jd_details: {
      summary: '',
      responsibilities: '',
      skills: '',
      qualifications: '',
      work_mode: 'On-site',
    },
    kras: [],
    kpis: [],
    weekly_scorecard: [],
    monthly_scorecard: [],
    dept_budget: 0,
    dept_current_payroll: 0,
    is_over_budget: 0,
    over_budget_amount: 0,
    over_budget_pct: 0,
    over_budget_justification: '',
  });

  const load = async () => {
    try {
      const [reqRes, summaryRes, tplRes] = await Promise.all([
        api.get('/hr/hiring-requests'),
        api.get('/hr/department-budget-summary').catch(() => ({ data: { stats: [], budgets: [] } })),
        api.get('/hr/role-templates').catch(() => ({ data: [] })),
      ]);
      setRows(reqRes.data || []);
      setDeptSummary(summaryRes.data || { stats: [], budgets: [] });
      setTemplates(tplRes.data || []);
    } catch (e) {
      toast.error(e.response?.data?.error || 'Failed to load hiring requests');
    }
  };

  useEffect(() => { load(); }, []);

  const fmtDate = (s) => {
    if (!s) return '';
    const d = new Date(s);
    if (isNaN(d.getTime())) return s;
    return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  };

  // Safe JSON parse helper
  const parseJson = (val, fallback) => {
    if (!val) return fallback;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch (_) { return fallback; }
  };

  // Live Budget Guardrail Computation
  const computeBudgetImpact = (currentForm = form) => {
    const dept = currentForm.department?.trim();
    const openings = Math.max(1, +(currentForm.num_openings || 1));
    const offeredMonthly = +(currentForm.salary_max || currentForm.salary_min || 0);
    const newHireTotal = openings * offeredMonthly;

    // Find dept budget
    const bRow = deptSummary.budgets.find(b => b.department?.toLowerCase() === dept?.toLowerCase());
    const allocatedBudget = bRow ? bRow.monthly_budget : 1200000; // default ₹12L benchmark

    // Find current active payroll for that dept
    const sRow = deptSummary.stats.find(s => s.department?.toLowerCase() === dept?.toLowerCase());
    let currentPayroll = sRow ? sRow.current_monthly_payroll : 0;

    // If replacement hire, subtract exiting employee salary if known
    if (currentForm.hiring_type === 'replacement' && currentForm.exiting_employee_id) {
      const exEmp = employees.find(e => e.id === +currentForm.exiting_employee_id);
      if (exEmp?.salary) {
        currentPayroll = Math.max(0, currentPayroll - exEmp.salary);
      }
    }

    const projectedPayroll = currentPayroll + newHireTotal;
    const isOver = projectedPayroll > allocatedBudget;
    const overAmount = isOver ? projectedPayroll - allocatedBudget : 0;
    const overPct = allocatedBudget > 0 ? ((overAmount / allocatedBudget) * 100).toFixed(1) : 0;

    return {
      allocatedBudget,
      currentPayroll,
      newHireTotal,
      projectedPayroll,
      isOver,
      overAmount,
      overPct: +overPct,
      bufferRemaining: Math.max(0, allocatedBudget - projectedPayroll),
    };
  };

  const openCreate = () => {
    setEditing(null);
    setFormTab('requisition');
    const defaultDept = user?.department || 'Operations';
    const initialForm = {
      department: defaultDept,
      position_title: '',
      job_level: 'L2',
      num_openings: 1,
      hiring_type: 'new_addition',
      exiting_employee_id: '',
      salary_min: 25000,
      salary_max: 40000,
      experience_required: '1-3 years',
      employment_type: 'full_time',
      hiring_deadline: '',
      reporting_manager_id: '',
      job_description: '',
      file_attachments: [],
      jd_details: {
        summary: '',
        responsibilities: '',
        skills: '',
        qualifications: '',
        work_mode: 'On-site',
      },
      kras: [
        { id: 1, title: 'Operational Milestone Adherence', description: 'Deliver on-site tasks within target timelines.', weightage: 40 },
        { id: 2, title: 'Quality & Safety Compliance', description: 'Zero defects and 100% adherence to safety checklist.', weightage: 30 },
        { id: 3, title: 'Cost Control & Material Reconciliation', description: 'Prevent scrap leakage and adhere to project budget.', weightage: 30 },
      ],
      kpis: [
        { id: 1, kra_id: 1, metric: 'On-Time Project Milestone Delivery', target: 95, unit: '%', direction: 'higher_better' },
        { id: 2, kra_id: 2, metric: 'Safety Audit Score', target: 100, unit: '%', direction: 'higher_better' },
        { id: 3, kra_id: 3, metric: 'Material Scrap vs BOQ Variance', target: 1.5, unit: '%', direction: 'lower_better' },
      ],
      weekly_scorecard: [
        { id: 1, metric: 'Daily DPR Submitted with photos (6/6 days)', target: 6, weight: 30, notes: 'Logged in SOTYN DPR before 8:00 PM' },
        { id: 2, metric: 'Indent to store consumption reconciliation', target: 100, weight: 35, notes: 'Zero untracked inventory' },
        { id: 3, metric: 'Safety & Quality inspection audits completed', target: 2, weight: 35, notes: 'Bi-weekly checks' },
      ],
      monthly_scorecard: [
        { id: 1, metric: 'Monthly Milestone Target Achieved', target: 100, weight: 40, notes: 'Progress vs plan' },
        { id: 2, metric: 'Cost Adherence within Sanctioned Budget', target: 100, weight: 35, notes: 'Zero unapproved escalation' },
        { id: 3, metric: 'Subcontractor RA Bill Certification Speed', target: 3, weight: 25, notes: 'Within 3 days' },
      ],
      dept_budget: 0,
      dept_current_payroll: 0,
      is_over_budget: 0,
      over_budget_amount: 0,
      over_budget_pct: 0,
      over_budget_justification: '',
    };

    const impact = computeBudgetImpact(initialForm);
    initialForm.dept_budget = impact.allocatedBudget;
    initialForm.dept_current_payroll = impact.currentPayroll;
    initialForm.is_over_budget = impact.isOver ? 1 : 0;
    initialForm.over_budget_amount = impact.overAmount;
    initialForm.over_budget_pct = impact.overPct;

    setForm(initialForm);
    setModal('form');
  };

  const openEdit = (row) => {
    if (row.status !== 'pending' && user?.role !== 'admin') {
      return toast.error(`Cannot edit an ${row.status} request (admin only)`);
    }
    setEditing(row);
    setFormTab('requisition');

    const jd = parseJson(row.jd_details, { summary: '', responsibilities: '', skills: '', qualifications: '', work_mode: 'On-site' });
    const kras = parseJson(row.kras, []);
    const kpis = parseJson(row.kpis, []);
    const weekly = parseJson(row.weekly_scorecard, []);
    const monthly = parseJson(row.monthly_scorecard, []);
    const files = parseJson(row.file_attachments, []);

    setForm({
      ...row,
      file_attachments: files,
      jd_details: jd,
      kras,
      kpis,
      weekly_scorecard: weekly,
      monthly_scorecard: monthly,
      is_over_budget: row.is_over_budget ? 1 : 0,
      over_budget_amount: row.over_budget_amount || 0,
      over_budget_pct: row.over_budget_pct || 0,
      over_budget_justification: row.over_budget_justification || '',
    });
    setModal('form');
  };

  const openView = (row) => {
    setViewingRow(row);
    setModal('view');
  };

  // 1-Click Template Clone
  const applyTemplate = (tplId) => {
    if (!tplId) return;
    const t = templates.find(x => x.id === +tplId);
    if (!t) return;

    setForm(prev => {
      const updated = {
        ...prev,
        position_title: t.title || prev.position_title,
        department: t.department || prev.department,
        job_level: t.job_level || prev.job_level,
        experience_required: t.experience_required || prev.experience_required,
        salary_min: t.salary_min || prev.salary_min,
        salary_max: t.salary_max || prev.salary_max,
        jd_details: t.jd_details ? { ...t.jd_details } : prev.jd_details,
        kras: t.kras?.length ? [...t.kras] : prev.kras,
        kpis: t.kpis?.length ? [...t.kpis] : prev.kpis,
        weekly_scorecard: t.weekly_scorecard?.length ? [...t.weekly_scorecard] : prev.weekly_scorecard,
        monthly_scorecard: t.monthly_scorecard?.length ? [...t.monthly_scorecard] : prev.monthly_scorecard,
      };
      const impact = computeBudgetImpact(updated);
      updated.dept_budget = impact.allocatedBudget;
      updated.dept_current_payroll = impact.currentPayroll;
      updated.is_over_budget = impact.isOver ? 1 : 0;
      updated.over_budget_amount = impact.overAmount;
      updated.over_budget_pct = impact.overPct;
      return updated;
    });

    toast.success(`Loaded blueprint template: ${t.title}`);
  };

  // File Upload Helper
  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      const newFileObj = {
        name: file.name,
        url: r.data.url,
        size: (file.size / 1024).toFixed(1) + ' KB',
        uploaded_at: new Date().toISOString(),
      };
      setForm(prev => ({
        ...prev,
        file_attachments: [...(prev.file_attachments || []), newFileObj],
      }));
      toast.success(`Attached requirement file: ${file.name}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'File upload failed');
    } finally {
      setUploading(false);
      e.target.value = '';
    }
  };

  const removeFileAttachment = (idx) => {
    setForm(prev => ({
      ...prev,
      file_attachments: prev.file_attachments.filter((_, i) => i !== idx),
    }));
  };

  // Save Hiring Request
  const save = async (e) => {
    if (e?.preventDefault) e.preventDefault();
    if (!form.department?.trim()) return toast.error('Department is required');
    if (!form.position_title?.trim()) return toast.error('Position title is required');

    // Recalculate impact on save
    const impact = computeBudgetImpact(form);
    const payload = {
      ...form,
      dept_budget: impact.allocatedBudget,
      dept_current_payroll: impact.currentPayroll,
      is_over_budget: impact.isOver ? 1 : 0,
      over_budget_amount: impact.overAmount,
      over_budget_pct: impact.overPct,
    };

    if (impact.isOver && !payload.over_budget_justification?.trim()) {
      setFormTab('requisition');
      return toast.error('This request exceeds department budget. Please provide an Over-Budget Justification.');
    }

    try {
      if (editing) {
        await api.put(`/hr/hiring-requests/${editing.id}`, payload);
        toast.success('Hiring requirement & blueprint updated');
      } else {
        await api.post('/hr/hiring-requests', payload);
        toast.success('Hiring requirement raised — submitted for MD / HR review');
      }
      setModal(false);
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save hiring requirement');
    }
  };

  // Approve
  const approve = async () => {
    try {
      await api.post(`/hr/hiring-requests/${actionRow.id}/approve`, { notes: reason || null });
      toast.success('Approved — position opened for recruitment');
      setModal(false);
      setActionRow(null);
      setReason('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Approve failed');
    }
  };

  // Reject
  const reject = async () => {
    if (!reason.trim()) return toast.error('Rejection reason required');
    try {
      await api.post(`/hr/hiring-requests/${actionRow.id}/reject`, { reason });
      toast.success('Hiring request rejected');
      setModal(false);
      setActionRow(null);
      setReason('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Reject failed');
    }
  };

  // Close
  const closeRequest = async (row) => {
    if (!confirm(`Close hiring requirement for ${row.position_title}?`)) return;
    try {
      await api.post(`/hr/hiring-requests/${row.id}/close`);
      toast.success('Hiring request closed');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Close failed');
    }
  };

  // Delete
  const removeRequest = async (row) => {
    if (!confirm(`Delete hiring requirement "${row.position_title}"? Any linked candidates will be detached.`)) return;
    try {
      await api.delete(`/hr/hiring-requests/${row.id}`);
      toast.success('Deleted');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Delete failed');
    }
  };

  // Provision Scorecard
  const provisionScorecard = async () => {
    if (!targetEmployeeId) return toast.error('Please select an employee');
    try {
      const res = await api.post(`/hr/hiring-requests/${actionRow.id}/provision-scorecard`, {
        employee_id: targetEmployeeId,
      });
      toast.success(res.data?.message || 'Scorecard template successfully provisioned!');
      setModal(false);
      setActionRow(null);
      setTargetEmployeeId('');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Scorecard provisioning failed');
    }
  };

  // Copy Sanitized Public Job Post
  const copyPublicJobPost = (data = form) => {
    const jd = parseJson(data.jd_details, {});
    const text = [
      `🌟 WE ARE HIRING AT SEPL! 🌟`,
      `Position: ${data.position_title}`,
      `Department: ${data.department}`,
      `Level: ${data.job_level || 'Executive'} | Openings: ${data.num_openings || 1}`,
      `Experience: ${data.experience_required || 'Not specified'}`,
      `Location / Mode: ${jd.work_mode || 'On-site'}`,
      data.salary_min || data.salary_max ? `Salary Band: ₹${(data.salary_min || 0).toLocaleString('en-IN')} - ₹${(data.salary_max || 0).toLocaleString('en-IN')} / month` : '',
      `\nAbout the Role:\n${jd.summary || data.job_description || 'Join our fast-growing engineering & solar execution team.'}`,
      jd.responsibilities ? `\nKey Responsibilities:\n${jd.responsibilities}` : '',
      jd.skills ? `\nKey Skills:\n${jd.skills}` : '',
      jd.qualifications ? `\nQualifications:\n${jd.qualifications}` : '',
      `\nTo apply, share your updated resume with our recruitment team at HR.`,
    ].filter(Boolean).join('\n');

    navigator.clipboard.writeText(text);
    toast.success('Copied formatted Job Post to clipboard!');
  };

  // Live Budget Metrics for current editing form
  const budgetImpact = computeBudgetImpact(form);

  // Filtered Rows
  const counts = STATUS_PILLS.reduce((acc, s) => {
    acc[s.id] = rows.filter(r => r.status === s.id).length;
    return acc;
  }, {});

  const visible = rows.filter(r => {
    if (filter !== 'all' && r.status !== filter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      const matchPos = r.position_title?.toLowerCase().includes(q);
      const matchDept = r.department?.toLowerCase().includes(q);
      const matchBy = r.requested_by_name?.toLowerCase().includes(q);
      if (!matchPos && !matchDept && !matchBy) return false;
    }
    return true;
  });

  // Over budget count for executive banner
  const overBudgetPending = rows.filter(r => r.status === 'pending' && r.is_over_budget).length;

  return (
    <div className="space-y-4">
      {/* Executive Header & KPI Banner */}
      <div className="bg-gradient-to-r from-blue-900 via-indigo-900 to-slate-900 text-white rounded-xl p-4 sm:p-5 shadow-sm">
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 bg-blue-500/20 text-blue-300 rounded-lg">
                <FiBriefcase size={22} />
              </span>
              <div>
                <h2 className="text-lg sm:text-xl font-bold tracking-tight">Hiring Requirements & Role Blueprints</h2>
                <p className="text-xs text-blue-200/80">
                  Role JDs, KRAs, quantifiable KPIs, Weekly & Monthly scorecards with live department budget guardrails.
                </p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 self-stretch md:self-auto">
            <button
              onClick={openCreate}
              className="btn btn-primary bg-blue-600 hover:bg-blue-500 text-white border-0 shadow-md flex items-center justify-center gap-2 px-4 py-2 text-sm font-semibold w-full md:w-auto"
            >
              <FiPlus size={16} /> Raise Hiring Requirement
            </button>
          </div>
        </div>

        {/* Executive Quick Stats Cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-4 pt-4 border-t border-white/10 text-xs">
          <div className="bg-white/5 rounded-lg p-2.5">
            <div className="text-white/60">Total Requisitions</div>
            <div className="text-lg font-bold text-white mt-0.5">{rows.length}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2.5">
            <div className="text-white/60">Pending Approval</div>
            <div className="text-lg font-bold text-amber-300 mt-0.5">{counts.pending || 0}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2.5">
            <div className="text-white/60">Open for Sourcing</div>
            <div className="text-lg font-bold text-emerald-300 mt-0.5">{counts.approved || 0}</div>
          </div>
          <div className="bg-white/5 rounded-lg p-2.5">
            <div className="text-white/60">Over-Budget Flagged</div>
            <div className="text-lg font-bold text-rose-300 mt-0.5 flex items-center gap-1">
              {overBudgetPending > 0 && <FiAlertTriangle size={14} className="text-rose-400" />}
              {overBudgetPending} Pending
            </div>
          </div>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3">
        {/* Status Pills */}
        <div className="flex gap-1.5 flex-wrap items-center">
          <button
            onClick={() => setFilter('all')}
            className={`btn text-xs py-1.5 px-3 rounded-lg flex items-center gap-1.5 ${filter === 'all' ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
          >
            All <span className="px-1.5 rounded-full text-[10px] bg-white/30 text-current">{rows.length}</span>
          </button>
          {STATUS_PILLS.map(s => {
            const active = filter === s.id;
            return (
              <button
                key={s.id}
                onClick={() => setFilter(s.id)}
                className={`btn text-xs py-1.5 px-3 rounded-lg flex items-center gap-1.5 ${active ? 'bg-blue-700 text-white font-semibold' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'}`}
              >
                {s.label}
                <span className={`px-1.5 rounded-full text-[10px] font-bold text-white ${s.bg}`}>
                  {counts[s.id] || 0}
                </span>
              </button>
            );
          })}
        </div>

        {/* Search Input */}
        <div className="relative min-w-[220px]">
          <FiSearch className="absolute left-3 top-2.5 text-gray-400" size={14} />
          <input
            type="text"
            className="input text-xs pl-8 py-1.5 w-full bg-white"
            placeholder="Search role, dept, requester…"
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
        </div>
      </div>

      {/* Requisitions List Table */}
      <div className="card p-0 overflow-x-auto shadow-xs border border-gray-200 rounded-xl">
        <NumberedTable className="text-sm w-full">
          <thead className="bg-gray-50/90 text-gray-600 border-b border-gray-200">
            <tr>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Position / Level</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Department & Type</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Offered Salary & Level Band</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Budget Status (MD View)</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Blueprint Status</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Status</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Candidates</th>
              <th className="text-left px-3 py-2.5 text-[10px] font-bold uppercase tracking-wider">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {visible.map(r => {
              const levelObj = JOB_LEVELS.find(l => l.id === r.job_level) || JOB_LEVELS[1];
              const files = parseJson(r.file_attachments, []);
              const kras = parseJson(r.kras, []);
              const kpis = parseJson(r.kpis, []);
              const weekly = parseJson(r.weekly_scorecard, []);
              const monthly = parseJson(r.monthly_scorecard, []);
              const isOver = !!r.is_over_budget;

              return (
                <tr key={r.id} className="hover:bg-blue-50/30 transition-colors align-top">
                  {/* Position / Level */}
                  <td className="px-3 py-2.5">
                    <div className="font-semibold text-gray-900 flex items-center gap-1.5">
                      <span>{r.position_title}</span>
                      <span className={`text-[10px] font-bold px-1.5 py-0.2 rounded border ${levelObj.badge}`}>
                        {r.job_level || 'L2'}
                      </span>
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      {r.num_openings} opening{r.num_openings > 1 ? 's' : ''} · <span className="uppercase text-[10px] text-gray-400">{(r.employment_type || 'full_time').replace(/_/g, '-')}</span>
                    </div>
                    <div className="text-[10px] text-gray-400 mt-0.5">
                      Req by {r.requested_by_name || `#${r.requested_by}`} · {fmtDate(r.created_at)}
                    </div>
                  </td>

                  {/* Department & Type */}
                  <td className="px-3 py-2.5">
                    <div className="font-medium text-gray-800">{r.department}</div>
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      {r.hiring_type === 'replacement' ? (
                        <span className="text-amber-700 bg-amber-50 px-1 py-0.5 rounded border border-amber-200">
                          Replacement {r.exiting_employee_name ? `(${r.exiting_employee_name})` : ''}
                        </span>
                      ) : (
                        <span className="text-blue-700 bg-blue-50 px-1 py-0.5 rounded border border-blue-200">
                          New Addition (Growth)
                        </span>
                      )}
                    </div>
                    {r.reporting_manager_name && (
                      <div className="text-[10px] text-gray-400 mt-1 flex items-center gap-1">
                        <FiUsers size={10} /> Reports: {r.reporting_manager_name}
                      </div>
                    )}
                  </td>

                  {/* Salary & Level Band */}
                  <td className="px-3 py-2.5 text-xs">
                    {(r.salary_min || r.salary_max) ? (
                      <div className="font-medium text-gray-900">
                        ₹{(r.salary_min || 0).toLocaleString('en-IN')} – ₹{(r.salary_max || 0).toLocaleString('en-IN')}<span className="text-[10px] text-gray-400">/mo</span>
                      </div>
                    ) : (
                      <div className="text-gray-400 italic text-[11px]">Salary not specified</div>
                    )}
                    <div className="text-[10px] text-gray-500 mt-0.5">
                      Std Band: ₹{(levelObj.min).toLocaleString('en-IN')} - ₹{(levelObj.max).toLocaleString('en-IN')}
                    </div>
                    {r.experience_required && (
                      <div className="text-[10px] text-gray-400">Exp: {r.experience_required}</div>
                    )}
                  </td>

                  {/* Budget Status (MD Sir View) */}
                  <td className="px-3 py-2.5">
                    {isOver ? (
                      <div className="inline-block bg-rose-50 border border-rose-200 text-rose-800 rounded px-2 py-1 text-[11px]">
                        <div className="font-bold flex items-center gap-1 text-rose-700">
                          <FiAlertTriangle size={12} className="text-rose-600" />
                          Exceeds Budget
                        </div>
                        <div className="text-[10px] font-semibold text-rose-800 mt-0.5">
                          +₹{(r.over_budget_amount || 0).toLocaleString('en-IN')} ({r.over_budget_pct || 0}%)
                        </div>
                      </div>
                    ) : (
                      <div className="inline-block bg-emerald-50 border border-emerald-200 text-emerald-800 rounded px-2 py-1 text-[11px]">
                        <div className="font-semibold text-emerald-700 flex items-center gap-1">
                          <FiCheckCircle size={12} className="text-emerald-600" />
                          Within Budget
                        </div>
                        <div className="text-[10px] text-emerald-600">
                          Dept Run Rate OK
                        </div>
                      </div>
                    )}
                  </td>

                  {/* Blueprint Elements Badges */}
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap gap-1 items-center">
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200" title="Job Description">
                        JD ✓
                      </span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-700 border border-indigo-200" title="Key Result Areas">
                        {kras.length} KRAs
                      </span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-purple-50 text-purple-700 border border-purple-200" title="Key Performance Indicators">
                        {kpis.length} KPIs
                      </span>
                      <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200" title="Weekly & Monthly Scorecard">
                        {weekly.length}W · {monthly.length}M
                      </span>
                    </div>
                    {files.length > 0 && (
                      <div className="text-[10px] text-gray-500 mt-1 flex items-center gap-1">
                        <FiPaperclip size={10} className="text-blue-600" />
                        <span className="text-blue-700 font-medium">{files.length} attached doc{files.length > 1 ? 's' : ''}</span>
                      </div>
                    )}
                  </td>

                  {/* Status */}
                  <td className="px-3 py-2.5">
                    {(() => {
                      const sp = STATUS_PILLS.find(s => s.id === r.status);
                      return (
                        <span className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded text-white ${sp?.bg || 'bg-gray-400'}`}>
                          {sp?.label || r.status}
                        </span>
                      );
                    })()}
                    {r.hiring_deadline && (
                      <div className="text-[10px] text-gray-500 mt-1 flex items-center gap-1">
                        <FiCalendar size={10} /> Due: {fmtDate(r.hiring_deadline)}
                      </div>
                    )}
                  </td>

                  {/* Candidates */}
                  <td className="px-3 py-2.5 text-xs">
                    <span className="font-bold text-gray-800 text-sm">{r.candidates_count || 0}</span>
                    <span className="text-[10px] text-gray-400"> applied</span>
                  </td>

                  {/* Actions */}
                  <td className="px-3 py-2.5">
                    <div className="flex flex-wrap items-center gap-1">
                      {/* View Dossier */}
                      <button
                        onClick={() => openView(r)}
                        className="btn btn-secondary text-[11px] py-1 px-2 text-gray-700 hover:text-blue-700 flex items-center gap-1"
                        title="View Full Role Blueprint Dossier"
                      >
                        <FiEye size={12} /> View
                      </button>

                      {/* Approval Buttons for Pending */}
                      {r.status === 'pending' && (
                        <>
                          <button
                            onClick={() => { setActionRow(r); setReason(''); setModal('approve'); }}
                            className="btn btn-primary text-[11px] py-1 px-2 bg-emerald-600 hover:bg-emerald-700 border-emerald-600 text-white flex items-center gap-1"
                            title="Approve Hiring Request"
                          >
                            <FiCheckCircle size={11} /> Approve
                          </button>
                          <button
                            onClick={() => { setActionRow(r); setReason(''); setModal('reject'); }}
                            className="btn btn-secondary text-[11px] py-1 px-2 text-red-600 hover:bg-red-50 flex items-center gap-1"
                            title="Reject Hiring Request"
                          >
                            <FiXCircle size={11} /> Reject
                          </button>
                        </>
                      )}

                      {/* Provision Scorecard to Onboarded Candidate */}
                      {r.status === 'approved' && (
                        <button
                          onClick={() => { setActionRow(r); setTargetEmployeeId(''); setModal('provision'); }}
                          className="btn btn-secondary text-[11px] py-1 px-2 text-indigo-700 hover:bg-indigo-50 border-indigo-200 flex items-center gap-1"
                          title="Auto-create Employee Scorecard in Performance module"
                        >
                          <FiAward size={11} /> Scorecard
                        </button>
                      )}

                      {/* Close */}
                      {r.status === 'approved' && (
                        <button
                          onClick={() => closeRequest(r)}
                          className="btn btn-secondary text-[11px] py-1 px-2 text-gray-600 flex items-center gap-1"
                          title="Close Requisition"
                        >
                          <FiLock size={11} /> Close
                        </button>
                      )}

                      {/* Edit */}
                      <button
                        onClick={() => openEdit(r)}
                        disabled={r.status !== 'pending' && user?.role !== 'admin'}
                        className="p-1.5 text-gray-400 hover:text-blue-600 disabled:opacity-30 disabled:cursor-not-allowed rounded"
                        title={r.status === 'pending' ? 'Edit Request' : 'Frozen after approval (admin only)'}
                      >
                        <FiEdit2 size={13} />
                      </button>

                      {/* Delete */}
                      {canDelete('hr') && (
                        <button
                          onClick={() => removeRequest(r)}
                          className="p-1.5 text-gray-400 hover:text-red-600 rounded"
                          title="Delete"
                        >
                          <FiTrash2 size={13} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}

            {visible.length === 0 && (
              <tr>
                <td colSpan="8" className="text-center py-12 text-gray-400">
                  <FiBriefcase className="mx-auto mb-2 text-gray-300" size={32} />
                  <p className="font-medium text-gray-500">
                    {rows.length === 0 ? 'No hiring requirements found' : `No ${filter} requisitions matching your filter`}
                  </p>
                  <p className="text-xs text-gray-400 mt-1">Click "Raise Hiring Requirement" to create a new role blueprint.</p>
                </td>
              </tr>
            )}
          </tbody>
        </NumberedTable>
      </div>

      {/* =========================================================================
          CREATE / EDIT ROLE BLUEPRINT MODAL (4 RICH TABS)
      ========================================================================== */}
      <Modal
        isOpen={modal === 'form'}
        onClose={() => setModal(false)}
        title={editing ? `Edit Hiring Requirement: ${form.position_title}` : 'Raise Hiring Requirement & Blueprint'}
        xwide
      >
        <div className="space-y-4">
          {/* Quick Clone Template Dropdown */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 bg-blue-50/70 border border-blue-200 rounded-lg text-xs">
            <div className="flex items-center gap-1.5 text-blue-900 font-medium">
              <FiCopy className="text-blue-700" size={14} />
              <span>1-Click Auto-Fill from Standard SEPL Role Template:</span>
            </div>
            <select
              className="select text-xs py-1 px-2.5 bg-white border-blue-300 font-medium text-blue-900 min-w-[220px]"
              onChange={e => applyTemplate(e.target.value)}
              defaultValue=""
            >
              <option value="" disabled>— Select standard blueprint —</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.title} ({t.department} · {t.job_level})</option>
              ))}
            </select>
          </div>

          {/* Modal Tab Headers */}
          <div className="flex gap-2 border-b border-gray-200 overflow-x-auto pb-1">
            {[
              { id: 'requisition', label: '1 · Requisition & Budget Guardrail', icon: FiDollarSign },
              { id: 'jd',          label: '2 · All JD (Job Description)',       icon: FiFileText },
              { id: 'kras',        label: '3 · KRAs & Measurable KPIs',         icon: FiTarget },
              { id: 'scorecards',  label: '4 · Weekly & Monthly Scorecards',    icon: FiAward },
            ].map(t => {
              const active = formTab === t.id;
              const Icon = t.icon;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => setFormTab(t.id)}
                  className={`px-3 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 whitespace-nowrap transition-colors
                    ${active ? 'border-blue-600 text-blue-700 bg-blue-50/50 rounded-t' : 'border-transparent text-gray-500 hover:text-gray-700'}`}
                >
                  <Icon size={14} /> {t.label}
                </button>
              );
            })}
          </div>

          <form onSubmit={save} className="space-y-4">
            {/* -------------------------------------------------------------
                TAB 1: REQUISITION, BUDGET GUARDRAILS & UPLOADS
            -------------------------------------------------------------- */}
            {formTab === 'requisition' && (
              <div className="space-y-4">
                {/* Live Budget & Exceeding Calculator Card for MD Sir */}
                <div className={`p-4 rounded-xl border text-xs transition-all ${budgetImpact.isOver ? 'bg-rose-50/80 border-rose-300 text-rose-950' : 'bg-emerald-50/80 border-emerald-300 text-emerald-950'}`}>
                  <div className="flex items-center justify-between flex-wrap gap-2 pb-2 border-b border-current/15 font-semibold">
                    <span className="flex items-center gap-1.5 text-sm font-bold">
                      {budgetImpact.isOver ? (
                        <>
                          <FiAlertTriangle className="text-rose-600" size={18} />
                          <span className="text-rose-800">Budget Warning: Exceeds Approved Department Budget</span>
                        </>
                      ) : (
                        <>
                          <FiCheckCircle className="text-emerald-600" size={18} />
                          <span className="text-emerald-800">Budget Guardrail: Within Approved Department Allocation</span>
                        </>
                      )}
                    </span>
                    <span className="text-[11px] font-normal opacity-80">
                      Live Financial Check for Department: <strong className="font-bold">{form.department || 'Not selected'}</strong>
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3">
                    <div>
                      <div className="text-[11px] opacity-75">Dept Monthly Budget</div>
                      <div className="font-bold text-sm">₹{budgetImpact.allocatedBudget.toLocaleString('en-IN')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] opacity-75">Current Dept Payroll</div>
                      <div className="font-bold text-sm">₹{budgetImpact.currentPayroll.toLocaleString('en-IN')}</div>
                    </div>
                    <div>
                      <div className="text-[11px] opacity-75">Proposed Hire Cost</div>
                      <div className="font-bold text-sm">₹{budgetImpact.newHireTotal.toLocaleString('en-IN')}<span className="text-[10px] font-normal">/mo</span></div>
                    </div>
                    <div>
                      <div className="text-[11px] opacity-75">Projected Run Rate</div>
                      <div className={`font-bold text-sm ${budgetImpact.isOver ? 'text-rose-700' : 'text-emerald-700'}`}>
                        ₹{budgetImpact.projectedPayroll.toLocaleString('en-IN')}
                      </div>
                    </div>
                  </div>

                  {budgetImpact.isOver && (
                    <div className="mt-3 pt-2.5 border-t border-rose-200">
                      <div className="text-rose-800 font-bold text-xs flex items-center gap-1.5">
                        <span>🚨 EXCEEDING BUDGET BY:</span>
                        <span className="text-rose-900 bg-rose-200/80 px-2 py-0.5 rounded font-black text-sm">
                          +₹{budgetImpact.overAmount.toLocaleString('en-IN')}/month (+{budgetImpact.overPct}%)
                        </span>
                      </div>
                      <div className="mt-2">
                        <label className="label text-rose-900 font-bold text-xs">
                          Over-Budget Justification for MD Sir *
                        </label>
                        <textarea
                          className="input bg-white border-rose-300 text-xs text-gray-900 w-full"
                          rows="2"
                          required={budgetImpact.isOver}
                          placeholder="State why this role exceeds budget (e.g. specialized skill required, urgently needed for upcoming 10MW project milestone)…"
                          value={form.over_budget_justification || ''}
                          onChange={e => setForm({ ...form, over_budget_justification: e.target.value })}
                        />
                      </div>
                    </div>
                  )}
                </div>

                {/* Form Fields Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label className="label">Department *</label>
                    <input
                      className="input text-xs"
                      required
                      placeholder="e.g. Operations / Solar / Accounts"
                      value={form.department || ''}
                      onChange={e => setForm({ ...form, department: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Position Title *</label>
                    <input
                      className="input text-xs"
                      required
                      placeholder="e.g. Senior Solar Site Engineer"
                      value={form.position_title || ''}
                      onChange={e => setForm({ ...form, position_title: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Seniority Grade / Job Level *</label>
                    <select
                      className="select text-xs font-medium"
                      value={form.job_level || 'L2'}
                      onChange={e => {
                        const lvl = JOB_LEVELS.find(l => l.id === e.target.value);
                        setForm({
                          ...form,
                          job_level: e.target.value,
                          salary_min: lvl?.min || form.salary_min,
                          salary_max: lvl?.max || form.salary_max,
                        });
                      }}
                    >
                      {JOB_LEVELS.map(l => (
                        <option key={l.id} value={l.id}>{l.label} ({l.exp})</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label">Hiring Type</label>
                    <select
                      className="select text-xs"
                      value={form.hiring_type || 'new_addition'}
                      onChange={e => setForm({ ...form, hiring_type: e.target.value })}
                    >
                      <option value="new_addition">New Addition (Capacity Expansion)</option>
                      <option value="replacement">Replacement (Backfill)</option>
                    </select>
                  </div>

                  {form.hiring_type === 'replacement' && (
                    <div>
                      <label className="label">Exiting Employee (Being Replaced)</label>
                      <select
                        className="select text-xs"
                        value={form.exiting_employee_id || ''}
                        onChange={e => setForm({ ...form, exiting_employee_id: e.target.value })}
                      >
                        <option value="">— Select exiting employee —</option>
                        {employees.map(emp => (
                          <option key={emp.id} value={emp.id}>
                            {emp.name} {emp.designation ? `(${emp.designation})` : ''} - ₹{emp.salary || 0}/mo
                          </option>
                        ))}
                      </select>
                    </div>
                  )}

                  <div>
                    <label className="label">Number of Openings</label>
                    <input
                      className="input text-xs"
                      type="number"
                      min="1"
                      value={form.num_openings ?? 1}
                      onChange={e => setForm({ ...form, num_openings: Math.max(1, +e.target.value) })}
                    />
                  </div>

                  <div>
                    <label className="label">Salary Min (₹/month)</label>
                    <input
                      className="input text-xs"
                      type="number"
                      placeholder="e.g. 25000"
                      value={form.salary_min ?? ''}
                      onChange={e => setForm({ ...form, salary_min: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Salary Max (₹/month)</label>
                    <input
                      className="input text-xs font-semibold"
                      type="number"
                      placeholder="e.g. 40000"
                      value={form.salary_max ?? ''}
                      onChange={e => setForm({ ...form, salary_max: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Experience Required</label>
                    <input
                      className="input text-xs"
                      placeholder="e.g. 2-4 years / Fresher"
                      value={form.experience_required || ''}
                      onChange={e => setForm({ ...form, experience_required: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Target Hiring Deadline</label>
                    <input
                      className="input text-xs"
                      type="date"
                      value={form.hiring_deadline || ''}
                      onChange={e => setForm({ ...form, hiring_deadline: e.target.value })}
                    />
                  </div>

                  <div>
                    <label className="label">Reporting Manager</label>
                    <select
                      className="select text-xs"
                      value={form.reporting_manager_id || ''}
                      onChange={e => setForm({ ...form, reporting_manager_id: e.target.value })}
                    >
                      <option value="">— Pick reporting manager —</option>
                      {employees.map(e => (
                        <option key={e.id} value={e.id}>{e.name} {e.designation ? `(${e.designation})` : ''}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="label">Employment Type</label>
                    <select
                      className="select text-xs"
                      value={form.employment_type || 'full_time'}
                      onChange={e => setForm({ ...form, employment_type: e.target.value })}
                    >
                      {EMPLOYMENT_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
                    </select>
                  </div>
                </div>

                {/* Upload Latest Hiring Requirements Section */}
                <div className="pt-2 border-t border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <label className="label font-bold text-gray-800 flex items-center gap-1.5">
                      <FiUploadCloud className="text-blue-600" size={16} />
                      Upload Latest Hiring Requirements (PDF / Word / Excel / Spec Sheets)
                    </label>
                    <label className="btn btn-secondary text-xs py-1 px-3 cursor-pointer hover:bg-gray-100 flex items-center gap-1">
                      <FiPlus size={12} /> {uploading ? 'Uploading…' : 'Attach File'}
                      <input
                        type="file"
                        className="hidden"
                        accept=".pdf,.doc,.docx,.xlsx,.xls,.png,.jpg"
                        onChange={handleFileUpload}
                        disabled={uploading}
                      />
                    </label>
                  </div>

                  {form.file_attachments?.length > 0 ? (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {form.file_attachments.map((f, i) => (
                        <div key={i} className="flex items-center justify-between p-2 bg-gray-50 border border-gray-200 rounded-lg text-xs">
                          <div className="flex items-center gap-2 truncate">
                            <FiPaperclip className="text-blue-600 flex-shrink-0" size={14} />
                            <a href={f.url} target="_blank" rel="noreferrer" className="text-blue-700 font-medium hover:underline truncate">
                              {f.name}
                            </a>
                            <span className="text-[10px] text-gray-400">({f.size})</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeFileAttachment(i)}
                            className="text-red-500 hover:text-red-700 p-1"
                            title="Remove attachment"
                          >
                            <FiTrash2 size={13} />
                          </button>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="p-3 bg-gray-50 border border-dashed border-gray-300 rounded-lg text-center text-xs text-gray-400">
                      No files attached yet. You can attach requirement docs, client specs, or detailed role notes.
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* -------------------------------------------------------------
                TAB 2: ALL JD (JOB DESCRIPTION)
            -------------------------------------------------------------- */}
            {formTab === 'jd' && (
              <div className="space-y-4">
                <div className="flex items-center justify-between bg-blue-50/70 p-3 rounded-lg border border-blue-200">
                  <div className="text-xs text-blue-900">
                    <strong>Job Description Builder:</strong> Structure the mission, responsibilities, competencies, and qualifications for this role.
                  </div>
                  <button
                    type="button"
                    onClick={() => copyPublicJobPost(form)}
                    className="btn btn-secondary text-xs py-1.5 px-3 text-blue-700 border-blue-300 hover:bg-blue-100/50 flex items-center gap-1.5"
                  >
                    <FiCopy size={12} /> Copy Formatted Job Post
                  </button>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div className="sm:col-span-2">
                    <label className="label">Role Summary / Objective</label>
                    <textarea
                      className="input text-xs w-full"
                      rows="2"
                      placeholder="Brief overview of the role and its primary purpose within SEPL…"
                      value={form.jd_details?.summary || ''}
                      onChange={e => setForm({ ...form, jd_details: { ...form.jd_details, summary: e.target.value } })}
                    />
                  </div>

                  <div className="sm:col-span-2">
                    <label className="label">Key Responsibilities (Duty Checklist)</label>
                    <textarea
                      className="input text-xs w-full font-mono text-[11px]"
                      rows="5"
                      placeholder="• Supervise PV module mounting and electrical cabling.&#10;• Submit daily progress reports (DPR) before 8:00 PM.&#10;• Reconcile material consumption against BOQ."
                      value={form.jd_details?.responsibilities || ''}
                      onChange={e => setForm({ ...form, jd_details: { ...form.jd_details, responsibilities: e.target.value } })}
                    />
                  </div>

                  <div>
                    <label className="label">Required Skills & Tools</label>
                    <textarea
                      className="input text-xs w-full"
                      rows="3"
                      placeholder="e.g. AutoCAD, PVsyst, Cable Sizing, Inverter Commissioning, Excel, Team Handling"
                      value={form.jd_details?.skills || ''}
                      onChange={e => setForm({ ...form, jd_details: { ...form.jd_details, skills: e.target.value } })}
                    />
                  </div>

                  <div>
                    <label className="label">Education & Qualifications</label>
                    <textarea
                      className="input text-xs w-full"
                      rows="3"
                      placeholder="e.g. B.Tech in Electrical / Civil Engineering, Diploma, MBA"
                      value={form.jd_details?.qualifications || ''}
                      onChange={e => setForm({ ...form, jd_details: { ...form.jd_details, qualifications: e.target.value } })}
                    />
                  </div>

                  <div>
                    <label className="label">Work Mode & Location</label>
                    <select
                      className="select text-xs"
                      value={form.jd_details?.work_mode || 'On-site'}
                      onChange={e => setForm({ ...form, jd_details: { ...form.jd_details, work_mode: e.target.value } })}
                    >
                      <option value="On-site">On-site (Project Site / Traveling)</option>
                      <option value="Office">Office / HQ</option>
                      <option value="Hybrid">Hybrid</option>
                      <option value="Remote">Remote</option>
                    </select>
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------------------
                TAB 3: KRAS & KPIS
            -------------------------------------------------------------- */}
            {formTab === 'kras' && (
              <div className="space-y-4">
                {/* KRAs Section */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-gray-800 text-xs flex items-center gap-1.5">
                        <FiTarget className="text-indigo-600" /> Key Result Areas (KRAs)
                      </h4>
                      <p className="text-[11px] text-gray-500">Core functional accountability domains (recommended 3–5 items)</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm(prev => ({
                        ...prev,
                        kras: [...(prev.kras || []), { id: Date.now(), title: '', description: '', weightage: 25 }],
                      }))}
                      className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                    >
                      <FiPlus size={12} /> Add KRA
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(form.kras || []).map((kra, idx) => (
                      <div key={kra.id || idx} className="p-3 bg-gray-50 border border-gray-200 rounded-lg flex items-start gap-2">
                        <span className="font-bold text-gray-400 text-xs mt-2">#{idx + 1}</span>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 flex-1">
                          <div className="sm:col-span-2">
                            <input
                              className="input text-xs"
                              placeholder="KRA Title (e.g. Site Safety & Quality)"
                              value={kra.title || ''}
                              onChange={e => {
                                const copy = [...form.kras];
                                copy[idx].title = e.target.value;
                                setForm({ ...form, kras: copy });
                              }}
                            />
                          </div>
                          <div>
                            <input
                              className="input text-xs"
                              placeholder="Description"
                              value={kra.description || ''}
                              onChange={e => {
                                const copy = [...form.kras];
                                copy[idx].description = e.target.value;
                                setForm({ ...form, kras: copy });
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              className="input text-xs w-20"
                              type="number"
                              min="0"
                              max="100"
                              placeholder="Weight %"
                              value={kra.weightage ?? ''}
                              onChange={e => {
                                const copy = [...form.kras];
                                copy[idx].weightage = +e.target.value;
                                setForm({ ...form, kras: copy });
                              }}
                            />
                            <span className="text-xs text-gray-500">%</span>
                            <button
                              type="button"
                              onClick={() => setForm(prev => ({ ...prev, kras: prev.kras.filter((_, i) => i !== idx) }))}
                              className="text-red-500 hover:text-red-700 p-1.5 ml-auto"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* KPIs Section */}
                <div className="pt-3 border-t border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-gray-800 text-xs flex items-center gap-1.5">
                        <FiLayers className="text-purple-600" /> Key Performance Indicators (KPIs)
                      </h4>
                      <p className="text-[11px] text-gray-500">Quantifiable metrics mapped to the KRAs</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm(prev => ({
                        ...prev,
                        kpis: [...(prev.kpis || []), { id: Date.now(), metric: '', target: 100, unit: '%', direction: 'higher_better' }],
                      }))}
                      className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                    >
                      <FiPlus size={12} /> Add KPI
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(form.kpis || []).map((kpi, idx) => (
                      <div key={kpi.id || idx} className="p-3 bg-gray-50 border border-gray-200 rounded-lg flex items-center gap-2">
                        <span className="font-bold text-gray-400 text-xs">#{idx + 1}</span>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 flex-1">
                          <div className="sm:col-span-2">
                            <input
                              className="input text-xs"
                              placeholder="Metric Name (e.g. Schedule Milestone Adherence)"
                              value={kpi.metric || ''}
                              onChange={e => {
                                const copy = [...form.kpis];
                                copy[idx].metric = e.target.value;
                                setForm({ ...form, kpis: copy });
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              className="input text-xs w-20"
                              placeholder="Target"
                              value={kpi.target ?? ''}
                              onChange={e => {
                                const copy = [...form.kpis];
                                copy[idx].target = e.target.value;
                                setForm({ ...form, kpis: copy });
                              }}
                            />
                            <input
                              className="input text-xs w-16"
                              placeholder="Unit"
                              value={kpi.unit || '%'}
                              onChange={e => {
                                const copy = [...form.kpis];
                                copy[idx].unit = e.target.value;
                                setForm({ ...form, kpis: copy });
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <select
                              className="select text-xs flex-1"
                              value={kpi.direction || 'higher_better'}
                              onChange={e => {
                                const copy = [...form.kpis];
                                copy[idx].direction = e.target.value;
                                setForm({ ...form, kpis: copy });
                              }}
                            >
                              <option value="higher_better">Higher is Better</option>
                              <option value="lower_better">Lower is Better</option>
                            </select>
                            <button
                              type="button"
                              onClick={() => setForm(prev => ({ ...prev, kpis: prev.kpis.filter((_, i) => i !== idx) }))}
                              className="text-red-500 hover:text-red-700 p-1.5"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* -------------------------------------------------------------
                TAB 4: WEEKLY & MONTHLY SCORECARDS
            -------------------------------------------------------------- */}
            {formTab === 'scorecards' && (
              <div className="space-y-4">
                {/* Weekly Scorecard */}
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-gray-800 text-xs flex items-center gap-1.5">
                        <FiClock className="text-teal-600" /> Weekly Scorecard Criteria (Monday Cadence)
                      </h4>
                      <p className="text-[11px] text-gray-500">Every Monday operational review metrics for the new hire</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm(prev => ({
                        ...prev,
                        weekly_scorecard: [...(prev.weekly_scorecard || []), { id: Date.now(), metric: '', target: 6, weight: 25, notes: '' }],
                      }))}
                      className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                    >
                      <FiPlus size={12} /> Add Weekly Metric
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(form.weekly_scorecard || []).map((w, idx) => (
                      <div key={w.id || idx} className="p-3 bg-teal-50/40 border border-teal-200 rounded-lg flex items-center gap-2">
                        <span className="font-bold text-teal-700 text-xs">W{idx + 1}</span>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 flex-1">
                          <div className="sm:col-span-2">
                            <input
                              className="input text-xs"
                              placeholder="Operational Metric (e.g. Daily DPR submitted on time 6/6)"
                              value={w.metric || ''}
                              onChange={e => {
                                const copy = [...form.weekly_scorecard];
                                copy[idx].metric = e.target.value;
                                setForm({ ...form, weekly_scorecard: copy });
                              }}
                            />
                          </div>
                          <div>
                            <input
                              className="input text-xs"
                              placeholder="Target Value"
                              value={w.target ?? ''}
                              onChange={e => {
                                const copy = [...form.weekly_scorecard];
                                copy[idx].target = e.target.value;
                                setForm({ ...form, weekly_scorecard: copy });
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="input text-xs"
                              placeholder="Notes / Source"
                              value={w.notes || ''}
                              onChange={e => {
                                const copy = [...form.weekly_scorecard];
                                copy[idx].notes = e.target.value;
                                setForm({ ...form, weekly_scorecard: copy });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setForm(prev => ({ ...prev, weekly_scorecard: prev.weekly_scorecard.filter((_, i) => i !== idx) }))}
                              className="text-red-500 hover:text-red-700 p-1.5"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Monthly Scorecard */}
                <div className="pt-3 border-t border-gray-200">
                  <div className="flex items-center justify-between mb-2">
                    <div>
                      <h4 className="font-bold text-gray-800 text-xs flex items-center gap-1.5">
                        <FiAward className="text-amber-600" /> Monthly Scorecard Criteria (Month-End Outcome)
                      </h4>
                      <p className="text-[11px] text-gray-500">Month-end strategic outcome evaluation with weightages</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => setForm(prev => ({
                        ...prev,
                        monthly_scorecard: [...(prev.monthly_scorecard || []), { id: Date.now(), metric: '', target: 100, weight: 30, notes: '' }],
                      }))}
                      className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                    >
                      <FiPlus size={12} /> Add Monthly Metric
                    </button>
                  </div>

                  <div className="space-y-2">
                    {(form.monthly_scorecard || []).map((m, idx) => (
                      <div key={m.id || idx} className="p-3 bg-amber-50/40 border border-amber-200 rounded-lg flex items-center gap-2">
                        <span className="font-bold text-amber-700 text-xs">M{idx + 1}</span>
                        <div className="grid grid-cols-1 sm:grid-cols-4 gap-2 flex-1">
                          <div className="sm:col-span-2">
                            <input
                              className="input text-xs"
                              placeholder="Outcome Metric (e.g. Monthly Milestone progress vs plan)"
                              value={m.metric || ''}
                              onChange={e => {
                                const copy = [...form.monthly_scorecard];
                                copy[idx].metric = e.target.value;
                                setForm({ ...form, monthly_scorecard: copy });
                              }}
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <input
                              className="input text-xs w-20"
                              placeholder="Weight %"
                              type="number"
                              value={m.weight ?? ''}
                              onChange={e => {
                                const copy = [...form.monthly_scorecard];
                                copy[idx].weight = +e.target.value;
                                setForm({ ...form, monthly_scorecard: copy });
                              }}
                            />
                            <span className="text-xs text-gray-500">%</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <input
                              className="input text-xs flex-1"
                              placeholder="Target or Criteria"
                              value={m.target || ''}
                              onChange={e => {
                                const copy = [...form.monthly_scorecard];
                                copy[idx].target = e.target.value;
                                setForm({ ...form, monthly_scorecard: copy });
                              }}
                            />
                            <button
                              type="button"
                              onClick={() => setForm(prev => ({ ...prev, monthly_scorecard: prev.monthly_scorecard.filter((_, i) => i !== idx) }))}
                              className="text-red-500 hover:text-red-700 p-1.5"
                            >
                              <FiTrash2 size={13} />
                            </button>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* Modal Actions */}
            <div className="flex items-center justify-between pt-4 border-t border-gray-200">
              <div className="flex items-center gap-2">
                {formTab !== 'requisition' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (formTab === 'scorecards') setFormTab('kras');
                      else if (formTab === 'kras') setFormTab('jd');
                      else if (formTab === 'jd') setFormTab('requisition');
                    }}
                    className="btn btn-secondary text-xs"
                  >
                    ← Previous Tab
                  </button>
                )}
                {formTab !== 'scorecards' && (
                  <button
                    type="button"
                    onClick={() => {
                      if (formTab === 'requisition') setFormTab('jd');
                      else if (formTab === 'jd') setFormTab('kras');
                      else if (formTab === 'kras') setFormTab('scorecards');
                    }}
                    className="btn btn-secondary text-xs text-blue-700 hover:bg-blue-50"
                  >
                    Next Tab →
                  </button>
                )}
              </div>

              <div className="flex items-center gap-2">
                <button type="button" onClick={() => setModal(false)} className="btn btn-secondary text-xs">
                  Cancel
                </button>
                <button type="submit" className="btn btn-primary text-xs bg-blue-700 hover:bg-blue-800 text-white font-semibold">
                  {editing ? 'Update Requirement & Blueprint' : 'Submit for HR & MD Approval'}
                </button>
              </div>
            </div>
          </form>
        </div>
      </Modal>

      {/* =========================================================================
          VIEW FULL BLUEPRINT DOSSIER MODAL
      ========================================================================== */}
      <Modal
        isOpen={modal === 'view'}
        onClose={() => setModal(false)}
        title={`Role Blueprint: ${viewingRow?.position_title || ''} (${viewingRow?.department || ''})`}
        xwide
      >
        {viewingRow && (() => {
          const levelObj = JOB_LEVELS.find(l => l.id === viewingRow.job_level) || JOB_LEVELS[1];
          const jd = parseJson(viewingRow.jd_details, {});
          const kras = parseJson(viewingRow.kras, []);
          const kpis = parseJson(viewingRow.kpis, []);
          const weekly = parseJson(viewingRow.weekly_scorecard, []);
          const monthly = parseJson(viewingRow.monthly_scorecard, []);
          const files = parseJson(viewingRow.file_attachments, []);

          return (
            <div className="space-y-4 text-xs">
              {/* Executive Header Box */}
              <div className="p-4 bg-gray-50 border border-gray-200 rounded-xl">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="text-base font-bold text-gray-900">{viewingRow.position_title}</h3>
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded border ${levelObj.badge}`}>
                        {levelObj.label}
                      </span>
                    </div>
                    <div className="text-gray-500 mt-1">
                      Department: <strong className="text-gray-800 font-semibold">{viewingRow.department}</strong> · Openings: <strong>{viewingRow.num_openings}</strong> · Type: <span className="uppercase text-gray-600 font-semibold">{viewingRow.employment_type}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => copyPublicJobPost(viewingRow)}
                      className="btn btn-secondary text-xs py-1.5 px-3 text-blue-700 flex items-center gap-1.5"
                    >
                      <FiCopy size={13} /> Copy Job Post
                    </button>
                  </div>
                </div>

                {/* Financial & Budget Guardrail Summary */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-3 pt-3 border-t border-gray-200">
                  <div>
                    <span className="text-gray-400">Offered Salary:</span>
                    <div className="font-bold text-gray-800 text-sm">
                      ₹{(viewingRow.salary_min || 0).toLocaleString('en-IN')} – ₹{(viewingRow.salary_max || 0).toLocaleString('en-IN')}<span className="text-[10px] text-gray-400 font-normal">/mo</span>
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400">Standard Level Band:</span>
                    <div className="font-semibold text-gray-700">
                      ₹{levelObj.min.toLocaleString('en-IN')} – ₹{levelObj.max.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400">Budget Status:</span>
                    <div>
                      {viewingRow.is_over_budget ? (
                        <span className="text-rose-700 font-bold bg-rose-50 px-2 py-0.5 rounded border border-rose-200 inline-block">
                          Over Budget (+₹{(viewingRow.over_budget_amount || 0).toLocaleString('en-IN')})
                        </span>
                      ) : (
                        <span className="text-emerald-700 font-bold bg-emerald-50 px-2 py-0.5 rounded border border-emerald-200 inline-block">
                          Within Budget ✓
                        </span>
                      )}
                    </div>
                  </div>
                  <div>
                    <span className="text-gray-400">Hiring Deadline:</span>
                    <div className="font-semibold text-gray-800">
                      {fmtDate(viewingRow.hiring_deadline) || 'Immediate'}
                    </div>
                  </div>
                </div>

                {viewingRow.over_budget_justification && (
                  <div className="mt-3 p-2.5 bg-rose-50 border border-rose-200 rounded text-rose-900 text-xs">
                    <strong>Over-Budget Justification:</strong> {viewingRow.over_budget_justification}
                  </div>
                )}
              </div>

              {/* Attached Requirement Files */}
              {files.length > 0 && (
                <div className="p-3 bg-blue-50/50 border border-blue-200 rounded-lg">
                  <h4 className="font-bold text-blue-900 mb-2 flex items-center gap-1.5">
                    <FiPaperclip size={14} /> Attached Requirement Documents ({files.length})
                  </h4>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {files.map((f, i) => (
                      <div key={i} className="flex items-center justify-between p-2 bg-white rounded border border-blue-200">
                        <span className="font-medium text-blue-800 truncate">{f.name}</span>
                        <a
                          href={f.url}
                          target="_blank"
                          rel="noreferrer"
                          className="btn btn-secondary text-xs py-0.5 px-2 flex items-center gap-1 text-blue-700"
                        >
                          <FiDownload size={11} /> Open
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Job Description (JD) */}
              <div className="p-4 bg-white border border-gray-200 rounded-xl space-y-3">
                <h4 className="font-bold text-gray-900 text-sm border-b pb-1 flex items-center gap-1.5">
                  <FiFileText className="text-blue-700" /> Job Description & Expectations
                </h4>
                {jd.summary && (
                  <div>
                    <div className="font-bold text-gray-700">Role Objective:</div>
                    <p className="text-gray-600 mt-0.5 whitespace-pre-wrap">{jd.summary}</p>
                  </div>
                )}
                {jd.responsibilities && (
                  <div>
                    <div className="font-bold text-gray-700">Key Responsibilities:</div>
                    <pre className="text-gray-600 font-sans mt-0.5 whitespace-pre-wrap leading-relaxed">{jd.responsibilities}</pre>
                  </div>
                )}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t">
                  {jd.skills && (
                    <div>
                      <div className="font-bold text-gray-700">Required Skills & Tools:</div>
                      <div className="text-gray-600 mt-0.5">{jd.skills}</div>
                    </div>
                  )}
                  {jd.qualifications && (
                    <div>
                      <div className="font-bold text-gray-700">Education & Experience:</div>
                      <div className="text-gray-600 mt-0.5">{jd.qualifications}</div>
                    </div>
                  )}
                </div>
              </div>

              {/* KRAs & KPIs Tables */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3 bg-white border border-gray-200 rounded-xl space-y-2">
                  <h4 className="font-bold text-gray-900 text-xs flex items-center gap-1.5 border-b pb-1">
                    <FiTarget className="text-indigo-600" /> Key Result Areas (KRAs)
                  </h4>
                  {kras.length > 0 ? (
                    <div className="space-y-2">
                      {kras.map((k, idx) => (
                        <div key={idx} className="p-2 bg-gray-50 rounded border text-xs">
                          <div className="font-semibold text-gray-800 flex justify-between">
                            <span>#{idx + 1} {k.title}</span>
                            <span className="text-indigo-700 font-bold">{k.weightage}%</span>
                          </div>
                          {k.description && <div className="text-gray-500 text-[11px] mt-0.5">{k.description}</div>}
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-gray-400 italic">No KRAs specified</div>}
                </div>

                <div className="p-3 bg-white border border-gray-200 rounded-xl space-y-2">
                  <h4 className="font-bold text-gray-900 text-xs flex items-center gap-1.5 border-b pb-1">
                    <FiLayers className="text-purple-600" /> Measurable KPIs
                  </h4>
                  {kpis.length > 0 ? (
                    <div className="space-y-2">
                      {kpis.map((k, idx) => (
                        <div key={idx} className="p-2 bg-gray-50 rounded border text-xs flex justify-between items-center">
                          <span className="font-medium text-gray-800">{k.metric}</span>
                          <span className="font-bold text-purple-700 bg-purple-50 px-2 py-0.5 rounded border border-purple-200">
                            {k.target} {k.unit || '%'}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-gray-400 italic">No KPIs specified</div>}
                </div>
              </div>

              {/* Weekly & Monthly Scorecards */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-3 bg-teal-50/50 border border-teal-200 rounded-xl space-y-2">
                  <h4 className="font-bold text-teal-900 text-xs flex items-center gap-1.5 border-b border-teal-200 pb-1">
                    <FiClock className="text-teal-600" /> Weekly Scorecard (Operational Cadence)
                  </h4>
                  {weekly.length > 0 ? (
                    <div className="space-y-1.5">
                      {weekly.map((w, idx) => (
                        <div key={idx} className="p-2 bg-white rounded border border-teal-100 text-xs flex justify-between items-center">
                          <div>
                            <div className="font-medium text-gray-800">{w.metric}</div>
                            {w.notes && <div className="text-[10px] text-gray-400">{w.notes}</div>}
                          </div>
                          <span className="font-bold text-teal-700 bg-teal-50 px-2 py-0.5 rounded">
                            Target: {w.target}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-gray-400 italic">No weekly scorecard set</div>}
                </div>

                <div className="p-3 bg-amber-50/50 border border-amber-200 rounded-xl space-y-2">
                  <h4 className="font-bold text-amber-900 text-xs flex items-center gap-1.5 border-b border-amber-200 pb-1">
                    <FiAward className="text-amber-600" /> Monthly Scorecard (Strategic Outcomes)
                  </h4>
                  {monthly.length > 0 ? (
                    <div className="space-y-1.5">
                      {monthly.map((m, idx) => (
                        <div key={idx} className="p-2 bg-white rounded border border-amber-100 text-xs flex justify-between items-center">
                          <span className="font-medium text-gray-800">{m.metric}</span>
                          <span className="font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
                            Weight: {m.weight || 0}%
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : <div className="text-gray-400 italic">No monthly scorecard set</div>}
                </div>
              </div>

              {/* Close View */}
              <div className="flex justify-end pt-3 border-t">
                <button onClick={() => setModal(false)} className="btn btn-secondary text-xs">Close Dossier</button>
              </div>
            </div>
          );
        })()}
      </Modal>

      {/* =========================================================================
          APPROVE MODAL (WITH BUDGET SUMMARY FOR MD SIR)
      ========================================================================== */}
      <Modal isOpen={modal === 'approve'} onClose={() => setModal(false)} title={`Approve Requisition: ${actionRow?.position_title || ''}`}>
        <div className="space-y-3 text-xs">
          {actionRow?.is_over_budget ? (
            <div className="p-3 bg-rose-50 border border-rose-300 rounded-lg text-rose-900">
              <div className="font-bold flex items-center gap-1.5 text-sm">
                <FiAlertTriangle className="text-rose-600" />
                Executive Attention: This role is Over-Budget
              </div>
              <p className="mt-1">
                Requested salary exceeds the approved department budget by <strong>+₹{(actionRow.over_budget_amount || 0).toLocaleString('en-IN')}/month</strong>.
              </p>
              {actionRow.over_budget_justification && (
                <div className="mt-2 p-2 bg-white rounded border border-rose-200 text-[11px]">
                  <strong>Justification provided:</strong> "{actionRow.over_budget_justification}"
                </div>
              )}
            </div>
          ) : (
            <div className="p-3 bg-emerald-50 border border-emerald-300 rounded-lg text-emerald-900">
              <div className="font-bold flex items-center gap-1.5">
                <FiCheckCircle className="text-emerald-600" />
                Within Budget Allocation
              </div>
              <p className="mt-1">Approving this request will open the position for active candidate sourcing.</p>
            </div>
          )}

          <div>
            <label className="label">Approval Notes (Optional)</label>
            <textarea
              className="input text-xs w-full"
              rows="2"
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Approved with target hiring deadline by end of month…"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary text-xs">Cancel</button>
            <button onClick={approve} className="btn btn-primary text-xs bg-emerald-600 hover:bg-emerald-700 text-white font-semibold">
              Confirm & Open Position
            </button>
          </div>
        </div>
      </Modal>

      {/* =========================================================================
          REJECT MODAL
      ========================================================================== */}
      <Modal isOpen={modal === 'reject'} onClose={() => setModal(false)} title={`Reject: ${actionRow?.position_title || ''}`}>
        <div className="space-y-3 text-xs">
          <p className="text-red-700 bg-red-50 border border-red-200 rounded p-2.5">
            Reject this hiring request. The requester will see the reason on their dashboard.
          </p>
          <div>
            <label className="label">Rejection Reason *</label>
            <textarea
              className="input text-xs w-full"
              rows="2"
              required
              value={reason}
              onChange={e => setReason(e.target.value)}
              placeholder="e.g. Budget ceiling reached this quarter — defer to next month…"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary text-xs">Cancel</button>
            <button onClick={reject} className="btn btn-primary text-xs bg-red-600 hover:bg-red-700 text-white font-semibold">
              Reject Request
            </button>
          </div>
        </div>
      </Modal>

      {/* =========================================================================
          PROVISION SCORECARD MODAL
      ========================================================================== */}
      <Modal isOpen={modal === 'provision'} onClose={() => setModal(false)} title="Auto-Provision Employee Scorecard">
        <div className="space-y-3 text-xs">
          <p className="text-indigo-900 bg-indigo-50 border border-indigo-200 rounded p-3">
            This links the Weekly & Monthly Scorecard criteria from <strong>{actionRow?.position_title}</strong> directly to an onboarded employee in SOTYN's Performance module (`Scorecard.jsx`).
          </p>

          <div>
            <label className="label">Select Hired Employee *</label>
            <select
              className="select text-xs w-full"
              value={targetEmployeeId}
              onChange={e => setTargetEmployeeId(e.target.value)}
            >
              <option value="">— Select employee to assign this scorecard —</option>
              {employees.map(emp => (
                <option key={emp.id} value={emp.id}>
                  {emp.name} {emp.designation ? `(${emp.designation})` : ''} · {emp.department}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <button onClick={() => setModal(false)} className="btn btn-secondary text-xs">Cancel</button>
            <button onClick={provisionScorecard} className="btn btn-primary text-xs bg-indigo-700 hover:bg-indigo-800 text-white font-semibold">
              Activate Scorecard for Employee
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
