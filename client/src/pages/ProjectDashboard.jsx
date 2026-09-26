import { useState, useEffect, useMemo } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import {
  FiBriefcase, FiShoppingBag, FiTruck, FiAlertTriangle, FiCheckCircle,
  FiClock, FiDollarSign, FiBarChart2, FiPieChart, FiArrowLeft, FiSearch,
  FiFilter, FiDownload, FiExternalLink, FiCalendar, FiPackage, FiLayers,
  FiChevronRight, FiUsers, FiFileText, FiRefreshCw
} from 'react-icons/fi';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell,
  PieChart, Pie, Legend
} from 'recharts';
import api from '../api';
import StatusBadge from '../components/StatusBadge';
import { exportCsv } from '../utils/exportCsv';
import toast from 'react-hot-toast';

const inr = (v) => {
  if (v == null || isNaN(v)) return '₹0';
  return '₹' + Math.round(+v).toLocaleString('en-IN');
};

const inrCompact = (v) => {
  if (v == null || isNaN(v)) return '—';
  const val = Number(v);
  if (Math.abs(val) >= 1e7) return `₹${(val / 1e7).toFixed(2)} Cr`;
  if (Math.abs(val) >= 1e5) return `₹${(val / 1e5).toFixed(2)} L`;
  if (Math.abs(val) >= 1e3) return `₹${(val / 1e3).toFixed(1)} K`;
  return `₹${Math.round(val).toLocaleString('en-IN')}`;
};

const PALETTE = ['#2563eb', '#16a34a', '#f59e0b', '#dc2626', '#8b5cf6', '#06b6d4', '#ec4899', '#64748b'];

export default function ProjectDashboard() {
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedIdFromUrl = searchParams.get('id');

  const [loading, setLoading] = useState(true);
  const [projectsData, setProjectsData] = useState({ summary: {}, projects: [] });
  const [activeProject, setActiveProject] = useState(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [activeTab, setActiveTab] = useState('vpos'); // 'vpos', 'items', 'alerts', 'site'
  const [vpoStatusFilter, setVpoStatusFilter] = useState('all');

  // Load all projects summary
  const loadProjects = async () => {
    setLoading(true);
    try {
      const res = await api.get('/project-dashboard/projects');
      setProjectsData(res.data || { summary: {}, projects: [] });
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.error || 'Failed to load projects');
    } finally {
      setLoading(false);
    }
  };

  // Load single project detailed 360° analytics
  const loadProjectDetail = async (id) => {
    if (!id) {
      setActiveProject(null);
      return;
    }
    setDetailLoading(true);
    try {
      const res = await api.get(`/project-dashboard/project/${id}`);
      setActiveProject(res.data);
    } catch (err) {
      console.error(err);
      toast.error(err.response?.data?.error || 'Failed to load project details');
      setActiveProject(null);
    } finally {
      setDetailLoading(false);
    }
  };

  useEffect(() => {
    loadProjects();
  }, []);

  useEffect(() => {
    if (selectedIdFromUrl) {
      loadProjectDetail(selectedIdFromUrl);
    } else {
      setActiveProject(null);
    }
  }, [selectedIdFromUrl]);

  const selectProject = (id) => {
    if (!id) {
      searchParams.delete('id');
      setSearchParams(searchParams);
    } else {
      setSearchParams({ id });
    }
  };

  // Filtered projects for the macro list
  const filteredProjects = useMemo(() => {
    return (projectsData.projects || []).filter((p) => {
      const matchesSearch =
        !searchQuery ||
        [p.name, p.company_name, p.client_name, p.lead_no, p.location]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(searchQuery.toLowerCase());
      const matchesStatus = statusFilter === 'all' || p.status === statusFilter;
      return matchesSearch && matchesStatus;
    });
  }, [projectsData.projects, searchQuery, statusFilter]);

  // Filtered VPOs within active project
  const filteredVpos = useMemo(() => {
    if (!activeProject?.vendor_pos) return [];
    return activeProject.vendor_pos.filter((v) => {
      if (vpoStatusFilter === 'approved') return v.po_approval === 'approved';
      if (vpoStatusFilter === 'pending') return ['pending_l1', 'pending_l2'].includes(v.po_approval);
      if (vpoStatusFilter === 'received') return Number(v.grn_count) > 0;
      if (vpoStatusFilter === 'overdue') return v.is_overdue;
      return true;
    });
  }, [activeProject?.vendor_pos, vpoStatusFilter]);

  // Export CSV for Macro Projects
  const exportProjectsCsv = () => {
    exportCsv(
      'projects_procurement_summary',
      ['Project Name', 'Lead No', 'Company', 'Client', 'Status', 'Contract Value', 'Vendor PO Count', 'PO Spend (INR)', 'Pending Approval', 'Overdue Deliveries'],
      filteredProjects.map((p) => [
        p.name,
        p.lead_no,
        p.company_name || '—',
        p.client_name || '—',
        p.status,
        p.contract_value,
        p.po_count,
        p.total_po_spend,
        p.pending_approval_count,
        p.overdue_delivery_count,
      ])
    );
  };

  // Export CSV for Active Project POs
  const exportActiveProjectPosCsv = () => {
    if (!activeProject?.vendor_pos) return;
    exportCsv(
      `${activeProject.project.lead_no}_vendor_pos`,
      ['PO Number', 'Date', 'Vendor', 'Approval Status', 'Total Amount', 'Billed Amount', 'GRN Received', 'Expected Delivery', 'Delay Reason'],
      activeProject.vendor_pos.map((v) => [
        v.po_number,
        v.po_date || '—',
        v.vendor_name || '—',
        v.po_approval,
        v.total_amount,
        v.billed_amount,
        v.grn_count > 0 ? 'Yes' : 'No',
        v.expected_receipt_date || '—',
        v.delay_reason || '—',
      ])
    );
  };

  return (
    <div className="space-y-6">
      {/* ── Top Header ────────────────────────────────────────── */}
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white p-4 rounded-xl border border-gray-200 shadow-sm">
        <div>
          <div className="flex items-center gap-2">
            <span className="p-2 bg-red-50 text-red-600 rounded-lg">
              <FiPieChart size={20} />
            </span>
            <div>
              <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
                Project Dashboard &amp; PO Analytics
              </h1>
              <p className="text-xs text-gray-500">
                Track project execution, procurement spend vs. budget, vendor orders &amp; material delivery status
              </p>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 w-full sm:w-auto">
          {activeProject && (
            <button
              onClick={() => selectProject(null)}
              className="btn btn-secondary flex items-center gap-1.5 text-xs font-medium"
            >
              <FiArrowLeft size={14} /> All Projects
            </button>
          )}
          <button
            onClick={() => {
              loadProjects();
              if (selectedIdFromUrl) loadProjectDetail(selectedIdFromUrl);
            }}
            className="btn btn-secondary flex items-center gap-1.5 text-xs"
            title="Refresh data"
          >
            <FiRefreshCw size={14} className={loading || detailLoading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button
            onClick={activeProject ? exportActiveProjectPosCsv : exportProjectsCsv}
            className="btn btn-secondary flex items-center gap-1.5 text-xs"
          >
            <FiDownload size={14} /> Export CSV
          </button>
        </div>
      </div>

      {/* ── Macro Enterprise KPI Strip (Always visible or on Macro view) ── */}
      {!activeProject && projectsData.summary && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <div className="card p-3 border-l-4 border-l-blue-600">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Total Projects</p>
            <p className="text-lg font-bold text-gray-900 mt-1">{projectsData.summary.total_projects || 0}</p>
          </div>
          <div className="card p-3 border-l-4 border-l-indigo-600">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Contract Booked</p>
            <p className="text-lg font-bold text-indigo-700 mt-1">{inrCompact(projectsData.summary.total_contract_value)}</p>
          </div>
          <div className="card p-3 border-l-4 border-l-emerald-600">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Vendor PO Spend</p>
            <p className="text-lg font-bold text-emerald-700 mt-1">{inrCompact(projectsData.summary.total_po_spend)}</p>
          </div>
          <div className="card p-3 border-l-4 border-l-gray-600">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Total POs Issued</p>
            <p className="text-lg font-bold text-gray-800 mt-1">{projectsData.summary.total_pos_count || 0}</p>
          </div>
          <div className="card p-3 border-l-4 border-l-amber-500">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Pending Approvals</p>
            <p className="text-lg font-bold text-amber-600 mt-1">{projectsData.summary.total_pending_approval || 0}</p>
          </div>
          <div className="card p-3 border-l-4 border-l-red-600">
            <p className="text-[11px] font-medium text-gray-500 uppercase tracking-wider">Overdue Deliveries</p>
            <p className="text-lg font-bold text-red-600 mt-1">{projectsData.summary.total_overdue_deliveries || 0}</p>
          </div>
        </div>
      )}

      {/* ── PROJECT SELECTOR / SEARCH BAR ───────────────────────── */}
      <div className="card p-3 flex flex-col md:flex-row items-center justify-between gap-3">
        <div className="flex items-center gap-2 w-full md:w-auto flex-1">
          <div className="relative w-full max-w-md">
            <FiSearch className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={15} />
            <input
              type="text"
              placeholder="Select or search project by name, company, client, lead #..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full pl-9 pr-3 py-1.5 text-xs rounded-lg border border-gray-200 focus:outline-none focus:ring-1 focus:ring-red-500 focus:border-red-500"
            />
          </div>
        </div>

        <div className="flex items-center gap-2 w-full md:w-auto">
          <label className="text-xs text-gray-500 whitespace-nowrap">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs py-1.5 px-2.5 rounded-lg border border-gray-200 focus:outline-none focus:ring-1 focus:ring-red-500"
          >
            <option value="all">All Statuses</option>
            <option value="booked">Booked</option>
            <option value="planning">Planning</option>
            <option value="in_progress">In Progress</option>
            <option value="completed">Completed</option>
          </select>

          {activeProject && (
            <select
              value={activeProject.project.id}
              onChange={(e) => selectProject(e.target.value)}
              className="text-xs py-1.5 px-3 rounded-lg border border-red-300 bg-red-50 text-red-800 font-semibold focus:outline-none"
            >
              {projectsData.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.lead_no})
                </option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* ════════════════════════════════════════════════════════════
          VIEW 1: SELECTED PROJECT 360° DASHBOARD + PO ANALYTICS
      ════════════════════════════════════════════════════════════ */}
      {activeProject ? (
        detailLoading ? (
          <div className="card p-12 text-center text-gray-400 text-sm">
            <FiRefreshCw className="animate-spin inline-block mr-2" size={18} />
            Loading Project 360° Analytics...
          </div>
        ) : (
          <div className="space-y-6">
            {/* Project Banner & Commercial Overview */}
            <div className="card p-5 bg-gradient-to-r from-gray-900 via-gray-800 to-slate-900 text-white rounded-xl shadow-md">
              <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div>
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <span className="px-2 py-0.5 text-[10px] font-bold tracking-wider bg-red-600 text-white uppercase rounded">
                      {activeProject.project.lead_no}
                    </span>
                    <span className="px-2 py-0.5 text-[10px] font-medium bg-gray-700 text-gray-200 uppercase rounded">
                      {activeProject.project.order_type}
                    </span>
                    <span className="px-2 py-0.5 text-[10px] font-medium bg-emerald-900/60 text-emerald-300 border border-emerald-700/50 uppercase rounded">
                      {activeProject.project.status}
                    </span>
                  </div>
                  <h2 className="text-xl md:text-2xl font-bold">{activeProject.project.name}</h2>
                  <p className="text-xs text-gray-300 mt-1 flex flex-wrap items-center gap-3">
                    <span><strong>Client:</strong> {activeProject.project.client_name || '—'}</span>
                    {activeProject.project.company_name && (
                      <span><strong>Company:</strong> {activeProject.project.company_name}</span>
                    )}
                    {activeProject.project.address && (
                      <span><strong>Location:</strong> {activeProject.project.address}</span>
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap gap-2 text-right">
                  <div className="bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/10">
                    <p className="text-[10px] uppercase tracking-wider text-gray-300">Contract Value</p>
                    <p className="text-lg font-bold text-emerald-400">{inr(activeProject.project.contract_value)}</p>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/10">
                    <p className="text-[10px] uppercase tracking-wider text-gray-300">PO Spend</p>
                    <p className="text-lg font-bold text-amber-300">{inr(activeProject.kpis.total_po_spend)}</p>
                  </div>
                  <div className="bg-white/10 backdrop-blur-sm px-4 py-2 rounded-lg border border-white/10">
                    <p className="text-[10px] uppercase tracking-wider text-gray-300">Budget Consumed</p>
                    <p className={`text-lg font-bold ${activeProject.kpis.budget_consumed_pct > 100 ? 'text-red-400' : 'text-blue-300'}`}>
                      {activeProject.kpis.budget_consumed_pct}%
                    </p>
                  </div>
                </div>
              </div>

              {activeProject.project.committed_delivery_date && (
                <div className="mt-4 pt-3 border-t border-gray-700/60 flex items-center justify-between text-xs text-gray-300">
                  <span className="flex items-center gap-1.5">
                    <FiCalendar className="text-amber-400" />
                    Target Delivery: <strong>{activeProject.project.committed_delivery_date}</strong>
                  </span>
                  {activeProject.project.penalty_clause === 'Yes' && (
                    <span className="text-red-400 font-medium">⚠️ Penalty Clause Applicable</span>
                  )}
                </div>
              )}
            </div>

            {/* KPI Cards Strip */}
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
              <div className="card p-3 border-t-4 border-t-blue-600">
                <p className="text-[11px] font-medium text-gray-500 uppercase">Material Budget</p>
                <p className="text-base font-bold text-gray-900 mt-1">{inr(activeProject.kpis.material_budget)}</p>
                <p className="text-[10px] text-gray-400 mt-0.5">
                  {activeProject.kpis.is_budget_estimated ? 'Est. standard 70%' : 'From planned BOQ'}
                </p>
              </div>

              <div className="card p-3 border-t-4 border-t-amber-500">
                <p className="text-[11px] font-medium text-gray-500 uppercase">Vendor PO Spend</p>
                <p className="text-base font-bold text-amber-700 mt-1">{inr(activeProject.kpis.total_po_spend)}</p>
                <div className="w-full bg-gray-200 rounded-full h-1.5 mt-2">
                  <div
                    className={`h-1.5 rounded-full ${activeProject.kpis.budget_consumed_pct > 100 ? 'bg-red-600' : 'bg-amber-500'}`}
                    style={{ width: `${Math.min(100, activeProject.kpis.budget_consumed_pct)}%` }}
                  />
                </div>
              </div>

              <div className="card p-3 border-t-4 border-t-emerald-600">
                <p className="text-[11px] font-medium text-gray-500 uppercase">POs Approved / Total</p>
                <p className="text-base font-bold text-emerald-700 mt-1">
                  {activeProject.kpis.approved_po_count} / {activeProject.kpis.po_count}
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  {activeProject.kpis.pending_approval_count > 0 ? (
                    <span className="text-amber-600 font-semibold">{activeProject.kpis.pending_approval_count} pending sign-off</span>
                  ) : (
                    'All signed off'
                  )}
                </p>
              </div>

              <div className="card p-3 border-t-4 border-t-purple-600">
                <p className="text-[11px] font-medium text-gray-500 uppercase">Received vs Overdue</p>
                <p className="text-base font-bold text-gray-900 mt-1">
                  <span className="text-emerald-600">{activeProject.kpis.grn_completed_count} GRN</span>
                  {' · '}
                  <span className={activeProject.kpis.overdue_delivery_count > 0 ? 'text-red-600 font-bold' : 'text-gray-400'}>
                    {activeProject.kpis.overdue_delivery_count} Late
                  </span>
                </p>
                <p className="text-[10px] text-gray-400 mt-0.5">Material receipt on site</p>
              </div>

              <div className="card p-3 border-t-4 border-t-teal-600">
                <p className="text-[11px] font-medium text-gray-500 uppercase">Client Invoiced</p>
                <p className="text-base font-bold text-teal-700 mt-1">
                  {inr(activeProject.client_billing?.invoiced || 0)}
                </p>
                <p className="text-[10px] text-gray-500 mt-0.5">
                  Collected: {inr(activeProject.client_billing?.collected || 0)}
                </p>
              </div>
            </div>

            {/* Visual Analytics Grid */}
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {/* Chart 1: Spend vs Budget Comparison */}
              <div className="card p-4">
                <h3 className="font-semibold text-sm text-gray-800 mb-3 flex items-center justify-between">
                  <span>Procurement Spend vs. Budget</span>
                  <span className="text-xs text-gray-400 font-normal">Amounts in INR</span>
                </h3>
                <ResponsiveContainer width="100%" height={250}>
                  <BarChart
                    data={[
                      { name: 'Contract Value', amount: activeProject.analytics.spend_vs_budget.contract_value, fill: '#64748b' },
                      { name: 'Material Budget', amount: activeProject.analytics.spend_vs_budget.material_budget, fill: '#3b82f6' },
                      { name: 'PO Spend', amount: activeProject.analytics.spend_vs_budget.po_spend, fill: '#f59e0b' },
                      { name: 'Vendor Billed', amount: activeProject.analytics.spend_vs_budget.vendor_billed, fill: '#10b981' },
                    ]}
                    margin={{ top: 10, right: 10, left: 10, bottom: 25 }}
                  >
                    <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} angle={-15} textAnchor="end" stroke="#94a3b8" />
                    <YAxis tick={{ fontSize: 10 }} stroke="#94a3b8" tickFormatter={(v) => inrCompact(v)} />
                    <Tooltip formatter={(v) => inr(v)} />
                    <Bar dataKey="amount" radius={[4, 4, 0, 0]}>
                      {[
                        '#64748b',
                        '#3b82f6',
                        activeProject.kpis.budget_consumed_pct > 100 ? '#ef4444' : '#f59e0b',
                        '#10b981'
                      ].map((fill, i) => (
                        <Cell key={i} fill={fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>

              {/* Chart 2: PO Status Funnel & Top Vendors */}
              <div className="card p-4">
                <h3 className="font-semibold text-sm text-gray-800 mb-3">
                  Vendor PO Status Distribution
                </h3>
                {activeProject.analytics.status_distribution.length === 0 ? (
                  <div className="flex items-center justify-center h-48 text-gray-400 text-xs">
                    No vendor POs issued for this project yet.
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={250}>
                    <PieChart>
                      <Pie
                        data={activeProject.analytics.status_distribution}
                        dataKey="value"
                        nameKey="name"
                        innerRadius={55}
                        outerRadius={85}
                        paddingAngle={3}
                      >
                        {activeProject.analytics.status_distribution.map((entry, idx) => (
                          <Cell key={idx} fill={entry.color || PALETTE[idx % PALETTE.length]} />
                        ))}
                      </Pie>
                      <Tooltip formatter={(v) => `${inr(v)}`} />
                      <Legend wrapperStyle={{ fontSize: 11 }} />
                    </PieChart>
                  </ResponsiveContainer>
                )}
              </div>
            </div>

            {/* Vendor Spend Breakdown Strip (if available) */}
            {activeProject.analytics.top_vendors?.length > 0 && (
              <div className="card p-4">
                <h3 className="font-semibold text-sm text-gray-800 mb-3 flex items-center justify-between">
                  <span>Top Suppliers &amp; Vendors for this Project</span>
                  <span className="text-xs text-gray-400">Total {activeProject.analytics.top_vendors.length} vendors</span>
                </h3>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3">
                  {activeProject.analytics.top_vendors.slice(0, 4).map((v, i) => (
                    <div key={i} className="p-3 rounded-lg bg-gray-50 border border-gray-100 flex flex-col justify-between">
                      <div>
                        <p className="font-semibold text-xs text-gray-900 truncate" title={v.name}>{v.name}</p>
                        <p className="text-[11px] text-gray-500 mt-0.5">{v.po_count} PO(s) placed</p>
                      </div>
                      <div className="mt-2 pt-2 border-t border-gray-200 flex justify-between items-baseline">
                        <span className="text-[10px] text-gray-400">Total Spend</span>
                        <span className="font-bold text-xs text-gray-900">{inr(v.spend)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* ── Interactive Detail Tabs ───────────────────────── */}
            <div className="space-y-3">
              <div className="flex border-b border-gray-200 gap-1 overflow-x-auto">
                <button
                  onClick={() => setActiveTab('vpos')}
                  className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition-all ${
                    activeTab === 'vpos'
                      ? 'border-red-600 text-red-600 bg-red-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FiShoppingBag size={14} /> Vendor Purchase Orders
                  <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-gray-100 text-gray-600">
                    {activeProject.vendor_pos.length}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('items')}
                  className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition-all ${
                    activeTab === 'items'
                      ? 'border-red-600 text-red-600 bg-red-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FiPackage size={14} /> PO Line Items
                  <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-gray-100 text-gray-600">
                    {activeProject.po_line_items.length}
                  </span>
                </button>

                <button
                  onClick={() => setActiveTab('alerts')}
                  className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition-all ${
                    activeTab === 'alerts'
                      ? 'border-amber-600 text-amber-700 bg-amber-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FiAlertTriangle size={14} className={activeProject.kpis.overdue_delivery_count > 0 ? 'text-red-500' : 'text-amber-500'} />
                  Pending &amp; Alerts
                  {(activeProject.kpis.pending_approval_count > 0 || activeProject.kpis.overdue_delivery_count > 0) && (
                    <span className="ml-1 text-[10px] px-1.5 py-0.2 rounded-full bg-red-100 text-red-700 font-bold">
                      {activeProject.kpis.pending_approval_count + activeProject.kpis.overdue_delivery_count}
                    </span>
                  )}
                </button>

                <button
                  onClick={() => setActiveTab('site')}
                  className={`px-4 py-2 text-xs font-semibold border-b-2 -mb-px flex items-center gap-1.5 transition-all ${
                    activeTab === 'site'
                      ? 'border-red-600 text-red-600 bg-red-50/50'
                      : 'border-transparent text-gray-500 hover:text-gray-700'
                  }`}
                >
                  <FiTruck size={14} /> Site &amp; Client Overview
                </button>
              </div>

              {/* ── TAB 1: Vendor POs Table ─────────────────────── */}
              {activeTab === 'vpos' && (
                <div className="card overflow-hidden">
                  <div className="p-3 bg-gray-50 border-b border-gray-200 flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-gray-700">Filter POs:</span>
                      <div className="inline-flex rounded-lg border border-gray-200 bg-white p-0.5 text-xs">
                        {[
                          { k: 'all', l: 'All' },
                          { k: 'approved', l: 'Approved' },
                          { k: 'pending', l: 'Pending Approval' },
                          { k: 'received', l: 'GRN Received' },
                          { k: 'overdue', l: 'Overdue' },
                        ].map((btn) => (
                          <button
                            key={btn.k}
                            onClick={() => setVpoStatusFilter(btn.k)}
                            className={`px-2.5 py-1 rounded text-xs font-medium transition-all ${
                              vpoStatusFilter === btn.k ? 'bg-red-600 text-white shadow-xs' : 'text-gray-600 hover:text-gray-900'
                            }`}
                          >
                            {btn.l}
                          </button>
                        ))}
                      </div>
                    </div>
                    <span className="text-xs text-gray-500">Showing {filteredVpos.length} of {activeProject.vendor_pos.length} POs</span>
                  </div>

                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                        <tr>
                          <th className="py-2.5 px-3">PO Number</th>
                          <th className="py-2.5 px-3">Date</th>
                          <th className="py-2.5 px-3">Vendor</th>
                          <th className="py-2.5 px-3 text-right">Amount</th>
                          <th className="py-2.5 px-3 text-center">Approval</th>
                          <th className="py-2.5 px-3 text-center">Delivery Status</th>
                          <th className="py-2.5 px-3 text-center">GRN</th>
                          <th className="py-2.5 px-3 text-right">Billed</th>
                          <th className="py-2.5 px-3 text-center">Actions</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {filteredVpos.length === 0 ? (
                          <tr>
                            <td colSpan={9} className="text-center py-8 text-gray-400 text-xs">
                              No vendor purchase orders match the selected filter.
                            </td>
                          </tr>
                        ) : (
                          filteredVpos.map((v) => (
                            <tr key={v.id} className="hover:bg-gray-50/80 transition-colors">
                              <td className="py-2.5 px-3 font-mono font-semibold text-blue-700">
                                <a
                                  href={`/vendor-po/${v.id}/print`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:underline flex items-center gap-1"
                                >
                                  {v.po_number} <FiExternalLink size={11} className="opacity-60" />
                                </a>
                              </td>
                              <td className="py-2.5 px-3 text-gray-600">{v.po_date || '—'}</td>
                              <td className="py-2.5 px-3 font-medium text-gray-800">{v.vendor_name || '—'}</td>
                              <td className="py-2.5 px-3 text-right font-semibold text-gray-900">{inr(v.total_amount)}</td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`inline-block px-2 py-0.5 text-[10px] font-bold rounded-full ${
                                    v.po_approval === 'approved'
                                      ? 'bg-emerald-100 text-emerald-800'
                                      : v.po_approval === 'rejected'
                                      ? 'bg-red-100 text-red-800'
                                      : 'bg-amber-100 text-amber-800'
                                  }`}
                                >
                                  {v.po_approval ? v.po_approval.replace(/_/g, ' ') : 'draft'}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <span
                                  className={`inline-block px-2 py-0.5 text-[10px] font-semibold rounded ${
                                    v.is_overdue
                                      ? 'bg-red-50 text-red-700 border border-red-200 animate-pulse'
                                      : Number(v.grn_count) > 0
                                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                                      : 'bg-gray-50 text-gray-600 border border-gray-200'
                                  }`}
                                >
                                  {v.delivery_status}
                                </span>
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                {Number(v.grn_count) > 0 ? (
                                  <span className="text-emerald-600 font-bold flex items-center justify-center gap-1">
                                    <FiCheckCircle size={13} /> {v.grn_count}
                                  </span>
                                ) : (
                                  <span className="text-gray-400">—</span>
                                )}
                              </td>
                              <td className="py-2.5 px-3 text-right text-gray-700">
                                {v.billed_amount > 0 ? inr(v.billed_amount) : '—'}
                              </td>
                              <td className="py-2.5 px-3 text-center">
                                <a
                                  href={`/vendor-po/${v.id}/print`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn btn-secondary !py-1 !px-2 text-[10px]"
                                >
                                  View PO
                                </a>
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── TAB 2: PO Line Items ────────────────────────── */}
              {activeTab === 'items' && (
                <div className="card overflow-hidden">
                  <div className="p-3 bg-gray-50 border-b border-gray-200 flex justify-between items-center text-xs">
                    <span className="font-semibold text-gray-700">Purchased Items for this Project</span>
                    <span className="text-gray-400">Total {activeProject.po_line_items.length} item lines</span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                        <tr>
                          <th className="py-2.5 px-3">Item Description</th>
                          <th className="py-2.5 px-3">PO Ref</th>
                          <th className="py-2.5 px-3">Supplier</th>
                          <th className="py-2.5 px-3 text-right">Qty</th>
                          <th className="py-2.5 px-3 text-right">Unit Rate</th>
                          <th className="py-2.5 px-3 text-right">Total Amount</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {activeProject.po_line_items.length === 0 ? (
                          <tr>
                            <td colSpan={6} className="text-center py-8 text-gray-400 text-xs">
                              No line items recorded on vendor POs.
                            </td>
                          </tr>
                        ) : (
                          activeProject.po_line_items.map((it) => (
                            <tr key={it.id} className="hover:bg-gray-50/80">
                              <td className="py-2.5 px-3 font-medium text-gray-800">
                                {it.description}
                                {it.specification && <p className="text-[10px] text-gray-400">{it.specification}</p>}
                              </td>
                              <td className="py-2.5 px-3 font-mono text-blue-700">{it.po_number}</td>
                              <td className="py-2.5 px-3 text-gray-600">{it.vendor_name || '—'}</td>
                              <td className="py-2.5 px-3 text-right font-medium">{it.quantity}</td>
                              <td className="py-2.5 px-3 text-right">{inr(it.rate)}</td>
                              <td className="py-2.5 px-3 text-right font-semibold text-gray-900">{inr(it.amount)}</td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* ── TAB 3: Pending & Actionable Alerts ───────────── */}
              {activeTab === 'alerts' && (
                <div className="space-y-4">
                  {/* Alert 1: Overdue Deliveries */}
                  <div className="card p-4 border-l-4 border-l-red-600">
                    <h4 className="font-semibold text-sm text-red-800 flex items-center gap-2">
                      <FiAlertTriangle className="text-red-600" /> Overdue Material Deliveries
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">
                      Purchase orders where the expected receipt date has passed, but material has not been received (GRN).
                    </p>
                    <div className="mt-3 divide-y divide-gray-100">
                      {activeProject.vendor_pos.filter((v) => v.is_overdue).length === 0 ? (
                        <p className="text-xs text-emerald-600 font-medium py-2">✓ No overdue deliveries for this project.</p>
                      ) : (
                        activeProject.vendor_pos
                          .filter((v) => v.is_overdue)
                          .map((v) => (
                            <div key={v.id} className="py-2.5 flex items-center justify-between text-xs">
                              <div>
                                <span className="font-mono font-semibold text-red-700 mr-2">{v.po_number}</span>
                                <span className="text-gray-800 font-medium">{v.vendor_name}</span>
                                <p className="text-[11px] text-gray-500">
                                  Expected: <strong className="text-red-600">{v.expected_receipt_date}</strong>
                                  {v.delay_reason && ` · Reason: ${v.delay_reason}`}
                                </p>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-gray-900">{inr(v.total_amount)}</span>
                                <a
                                  href={`/vendor-po/${v.id}/print`}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="btn btn-secondary !py-1 !px-2 text-[10px]"
                                >
                                  View PO
                                </a>
                              </div>
                            </div>
                          ))
                      )}
                    </div>
                  </div>

                  {/* Alert 2: POs Pending L1/L2 Approval */}
                  <div className="card p-4 border-l-4 border-l-amber-500">
                    <h4 className="font-semibold text-sm text-amber-800 flex items-center gap-2">
                      <FiClock className="text-amber-600" /> POs Pending Approval
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">
                      Vendor purchase orders waiting for management sign-off before dispatching to suppliers.
                    </p>
                    <div className="mt-3 divide-y divide-gray-100">
                      {activeProject.vendor_pos.filter((v) => ['pending_l1', 'pending_l2'].includes(v.po_approval)).length === 0 ? (
                        <p className="text-xs text-emerald-600 font-medium py-2">✓ All vendor POs are approved.</p>
                      ) : (
                        activeProject.vendor_pos
                          .filter((v) => ['pending_l1', 'pending_l2'].includes(v.po_approval))
                          .map((v) => (
                            <div key={v.id} className="py-2.5 flex items-center justify-between text-xs">
                              <div>
                                <span className="font-mono font-semibold text-amber-800 mr-2">{v.po_number}</span>
                                <span className="text-gray-800 font-medium">{v.vendor_name}</span>
                                <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 font-bold uppercase">
                                  {v.po_approval}
                                </span>
                              </div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-gray-900">{inr(v.total_amount)}</span>
                                <Link to="/procurement?tab=vendorpo" className="btn btn-secondary !py-1 !px-2 text-[10px]">
                                  Open Approvals
                                </Link>
                              </div>
                            </div>
                          ))
                      )}
                    </div>
                  </div>

                  {/* Alert 3: Indent Items Pending PO Creation */}
                  <div className="card p-4 border-l-4 border-l-blue-600">
                    <h4 className="font-semibold text-sm text-blue-800 flex items-center gap-2">
                      <FiShoppingBag className="text-blue-600" /> Indent Items Awaiting Vendor PO
                    </h4>
                    <p className="text-xs text-gray-500 mt-1">
                      Material requested by site engineers where a Vendor PO has not yet been created.
                    </p>
                    <div className="mt-3 divide-y divide-gray-100">
                      {activeProject.pending_po_items.length === 0 ? (
                        <p className="text-xs text-emerald-600 font-medium py-2">✓ No pending items waiting for PO.</p>
                      ) : (
                        activeProject.pending_po_items.map((pi) => (
                          <div key={pi.id} className="py-2.5 flex items-center justify-between text-xs">
                            <div>
                              <span className="font-medium text-gray-900">{pi.description}</span>
                              <p className="text-[11px] text-gray-400">
                                Indent: <strong className="text-gray-700">{pi.indent_number}</strong> · Qty: {pi.quantity} {pi.unit || 'nos'}
                              </p>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="font-semibold text-gray-800">{inr(pi.amount)}</span>
                              <Link to="/procurement?tab=vendorpo&subtab=pending" className="btn btn-primary !py-1 !px-2 text-[10px]">
                                Create PO
                              </Link>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>
                </div>
              )}

              {/* ── TAB 4: Site & Client Overview ───────────────── */}
              {activeTab === 'site' && (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {/* Site Execution Card */}
                  <div className="card p-4">
                    <h4 className="font-semibold text-sm text-gray-800 mb-3 flex items-center gap-2">
                      <FiTruck className="text-red-600" /> Site Progress &amp; DPR Execution
                    </h4>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Total DPRs Submitted:</span>
                        <strong className="text-gray-900">{activeProject.site_execution.dpr_count} reports</strong>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Cumulative Work Done (Value A):</span>
                        <strong className="text-emerald-700">{inr(activeProject.site_execution.work_done_value)}</strong>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Site Execution Cost (Cost B):</span>
                        <strong className="text-amber-700">{inr(activeProject.site_execution.cost_incurred)}</strong>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Latest DPR Report Date:</span>
                        <strong className="text-gray-900">{activeProject.site_execution.latest_dpr_date || 'No DPRs yet'}</strong>
                      </div>
                      <div className="flex justify-between py-1.5">
                        <span className="text-gray-500">Open Snags on Site:</span>
                        <strong className={activeProject.site_execution.open_snags > 0 ? 'text-red-600' : 'text-emerald-600'}>
                          {activeProject.site_execution.open_snags} open
                        </strong>
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-gray-200">
                      <Link to="/dpr" className="btn btn-secondary w-full text-center text-xs justify-center flex items-center gap-1.5">
                        <FiFileText size={13} /> Open DPR Module
                      </Link>
                    </div>
                  </div>

                  {/* Client Billing & Invoicing Card */}
                  <div className="card p-4">
                    <h4 className="font-semibold text-sm text-gray-800 mb-3 flex items-center gap-2">
                      <FiDollarSign className="text-emerald-600" /> Commercial &amp; Client Billing
                    </h4>
                    <div className="space-y-2 text-xs">
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Contracted Value:</span>
                        <strong className="text-gray-900">{inr(activeProject.project.contract_value)}</strong>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Total Invoiced (Sales Bills):</span>
                        <strong className="text-blue-700">{inr(activeProject.client_billing.invoiced)}</strong>
                      </div>
                      <div className="flex justify-between py-1.5 border-b border-gray-100">
                        <span className="text-gray-500">Total Collected from Client:</span>
                        <strong className="text-emerald-700">{inr(activeProject.client_billing.collected)}</strong>
                      </div>
                      <div className="flex justify-between py-1.5">
                        <span className="text-gray-500">Balance Receivable:</span>
                        <strong className="text-red-600">{inr(activeProject.client_billing.balance)}</strong>
                      </div>
                    </div>

                    <div className="mt-4 pt-3 border-t border-gray-200 flex gap-2">
                      <Link to="/installation" className="btn btn-secondary flex-1 text-center text-xs justify-center">
                        Sales Billing
                      </Link>
                      <Link to="/collections" className="btn btn-secondary flex-1 text-center text-xs justify-center">
                        Collections
                      </Link>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        )
      ) : (
        /* ════════════════════════════════════════════════════════════
            VIEW 2: MACRO ALL-PROJECTS COMPARISON TABLE
        ════════════════════════════════════════════════════════════ */
        <div className="card overflow-hidden">
          <div className="p-3 bg-gray-50 border-b border-gray-200 flex justify-between items-center">
            <div>
              <h3 className="font-semibold text-sm text-gray-800">Project-Wise Procurement &amp; PO Summary</h3>
              <p className="text-xs text-gray-500">Select any project to drill down into 360° analytics, spend vs budget &amp; vendor orders</p>
            </div>
            <span className="text-xs text-gray-400">Showing {filteredProjects.length} projects</span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-gray-50 text-gray-500 border-b border-gray-200">
                <tr>
                  <th className="py-2.5 px-3">Project / Site</th>
                  <th className="py-2.5 px-3">Lead No</th>
                  <th className="py-2.5 px-3">Client / Company</th>
                  <th className="py-2.5 px-3 text-right">Contract Value</th>
                  <th className="py-2.5 px-3 text-center">POs Placed</th>
                  <th className="py-2.5 px-3 text-right">PO Spend (INR)</th>
                  <th className="py-2.5 px-3 text-center">Pending Approvals</th>
                  <th className="py-2.5 px-3 text-center">Overdue Deliveries</th>
                  <th className="py-2.5 px-3 text-center">Status</th>
                  <th className="py-2.5 px-3 text-center">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filteredProjects.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="text-center py-10 text-gray-400 text-xs">
                      No projects found matching the criteria.
                    </td>
                  </tr>
                ) : (
                  filteredProjects.map((p) => (
                    <tr
                      key={p.id}
                      onClick={() => selectProject(p.id)}
                      className="hover:bg-red-50/40 cursor-pointer transition-colors"
                    >
                      <td className="py-2.5 px-3 font-semibold text-gray-900 flex items-center gap-1.5">
                        <FiBriefcase className="text-red-600 shrink-0" size={13} />
                        <span className="truncate max-w-[200px]" title={p.name}>{p.name}</span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[11px] text-gray-600">{p.lead_no}</td>
                      <td className="py-2.5 px-3 text-gray-700">
                        <span className="truncate max-w-[160px] inline-block" title={p.company_name || p.client_name}>
                          {p.company_name || p.client_name || '—'}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 text-right font-medium text-gray-900">{inr(p.contract_value)}</td>
                      <td className="py-2.5 px-3 text-center font-semibold text-blue-700">{p.po_count}</td>
                      <td className="py-2.5 px-3 text-right font-bold text-gray-900">{inr(p.total_po_spend)}</td>
                      <td className="py-2.5 px-3 text-center">
                        {p.pending_approval_count > 0 ? (
                          <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800">
                            {p.pending_approval_count}
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        {p.overdue_delivery_count > 0 ? (
                          <span className="inline-block px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-red-100 text-red-700 animate-pulse">
                            {p.overdue_delivery_count} late
                          </span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-center">
                        <StatusBadge status={p.status} />
                      </td>
                      <td className="py-2.5 px-3 text-center" onClick={(e) => e.stopPropagation()}>
                        <button
                          onClick={() => selectProject(p.id)}
                          className="btn btn-secondary !py-1 !px-2.5 text-[10px] flex items-center gap-1 mx-auto"
                        >
                          View 360° <FiChevronRight size={10} />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
