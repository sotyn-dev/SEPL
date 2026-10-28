import NumberedTable from '../components/NumberedTable';
// Per-employee MIS scorecard matching the SEPL Google Sheet format mam
// shared on 2026-05-04. Three tabs:
//   - My Scorecard  : current user's MIS for the picked week, editable
//   - Team Overview : all employees' weekly score (existing dashboard)
//   - Templates     : admin manages KPI templates per role
//   - Assign        : admin maps each user to one or more templates

import { useState, useEffect, useCallback, useMemo, useLayoutEffect, Fragment } from 'react';
import api from '../api';
import { useUrlTab } from '../hooks/useUrlTab';
import Modal from '../components/Modal';
import TemplateAssignmentPicker from '../components/TemplateAssignmentPicker';
import { ScoreMetricSettings, ScoreMetricDates } from '../components/ScoreMetricInputs';
import toast from 'react-hot-toast';
import { useAuth } from '../context/AuthContext';
import { FiTrendingUp, FiCalendar, FiEdit2, FiSave, FiUsers, FiSettings, FiPlus, FiTrash2, FiUser, FiDownload, FiTarget, FiPrinter, FiInfo, FiExternalLink, FiBarChart2, FiCheckSquare, FiChevronDown, FiChevronUp } from 'react-icons/fi';
import { exportCsv } from '../utils/exportCsv';
import { createLatestScorecardRequest, createScorecardSelection, selectScorecardWeek, selectedScorecard, saveSelectedScorecard } from '../utils/scorecardSelection';
import {
  ResponsiveContainer, ComposedChart, Bar, Line, Area, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';

// ── Scorecard display convention (mam 2026-07-04): show performance as the
// VARIANCE vs plan — achievement% − 100.  So hitting 100% of plan reads 0%,
// falling short reads negative (DPR 68% → −32%), beating plan reads positive.
// The server/engine keep the raw achievement % (higher-better) so the Champions
// League leaderboard and War Room rankings are unaffected — this transform is
// display-only, applied uniformly to every % the Scorecard page renders.
const vsPlan = (pct) => (pct == null ? null : Math.round(pct) - 100);
const fmtVs = (pct) => { const v = vsPlan(pct); return v == null ? null : `${v > 0 ? '+' : ''}${v}%`; };
const vsClr = (pct) => {
  const v = vsPlan(pct);
  if (v == null) return 'text-gray-300';
  return v >= 0 ? 'text-emerald-700' : v >= -50 ? 'text-amber-700' : 'text-red-700';
};

// For values ALREADY expressed as variance-vs-plan (the commitment convention:
// 0 = on plan, negative = behind).  Colour + signed label without the −100 shift.
const varClr = (v) => v == null ? 'text-gray-400' : v >= 0 ? 'text-emerald-700' : v >= -50 ? 'text-amber-700' : 'text-red-700';
const fmtVar = (v) => v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`;
const fmtShort = (start) => {
  const d = new Date(start + 'T00:00:00');
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getMonth()];
  return `${d.getDate()} ${month}`;
};

const fmtCompact = (num, decimals = 1) => {
  if (num == null) return '0';
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 10000000) {
    const v = (abs / 10000000).toFixed(decimals).replace(/\.0$/, '');
    return `${sign}${v} Cr`;
  }
  if (abs >= 100000) {
    const v = (abs / 100000).toFixed(decimals).replace(/\.0$/, '');
    return `${sign}${v} L`;
  }
  if (abs >= 1000) {
    const v = (abs / 1000).toFixed(decimals).replace(/\.0$/, '');
    return `${sign}${v}k`;
  }
  return `${sign}${Math.round(abs * 10) / 10}`;
};

const fmtFullNumber = (num) => {
  if (num == null) return '0';
  const n = Number(num);
  if (!Number.isFinite(n)) return '0';
  return Math.round(n * 10) / 10 === Math.round(n)
    ? Math.round(n).toLocaleString('en-IN')
    : Number(n.toFixed(1)).toLocaleString('en-IN');
};

const lastMonday = (offsetWeeks = 0) => {
  const d = new Date();
  const dow = d.getDay();
  const offset = dow === 0 ? -6 : (1 - dow);
  d.setDate(d.getDate() + offset - (offsetWeeks * 7));
  return d.toISOString().slice(0, 10);
};

// Monday of the week containing the given yyyy-mm-dd (scoring weeks are Mon-Sat).
const mondayOf = (dateStr) => {
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return null;
  const dow = d.getDay();
  d.setDate(d.getDate() + (dow === 0 ? -6 : 1 - dow));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

const fmtRange = (start) => {
  const s = new Date(start), e = new Date(start);
  e.setDate(s.getDate() + 5);
  const month = (m) => ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][m];
  return `${s.getDate()} ${month(s.getMonth())} – ${e.getDate()} ${month(e.getMonth())} ${e.getFullYear()}`;
};

const scorePill = (s) => {
  if (s == null) return 'bg-gray-100 text-gray-500';
  if (s >= 0) return 'bg-emerald-100 text-emerald-700';
  if (s >= -25) return 'bg-blue-100 text-blue-700';
  if (s >= -50) return 'bg-amber-100 text-amber-700';
  return 'bg-red-100 text-red-700';
};

// Mam (2026-06-02): "how plan actual say in template that pick from
// here".  For every auto:* source, this map explains in plain English
// which DB field feeds the Plan (target) and which feeds the Actual
// (achievement) for the scoring period.  Rendered as a small chip
// under the source dropdown so the admin doesn't have to guess what
// each abbreviated source name means.  Keep keys identical to the
// `value` attributes on the <option> elements in the source dropdown.
const SOURCE_INFO = {
  manual:                       { plan: 'You set (Target column)',           actual: 'You enter weekly in the scorecard' },
  'auto:lead_response_hours': { plan: 'You set the allowed response hours', actual: 'Average hours from Sales Funnel lead creation to its first completed follow-up by this user, for leads created in the week. Older completions without a timestamp are excluded.' },
  // Tasks & Tickets — Plan = items assigned this week, Actual = items completed
  'auto:delegations':           { desc: 'Tracks task execution on assignments delegated to you with target deadlines in this week.', plan: 'Delegations DUE this week (current due date; no date = week created)', actual: 'Of those, completed (status=approved)', tip: 'Submit tasks before due date and request review approval from your assigner.' },
  'auto:pms':                   { desc: 'Tracks scheduled PMS engineering and project milestones due this week.', plan: 'PMS tasks DUE this week (current due date; no date = week created)', actual: 'Of those, completed (status=approved)', tip: 'Keep milestone timelines updated and submit deliverables for approval promptly.' },
  'auto:checklists':            { desc: 'Assigned recurring checklists and inspection SOPs.', plan: 'Assigned checklist occurrences due Mon–Sat, following frequency and attendance rules', actual: 'Approved occurrences from that same week, including submissions made by an admin for the assignee', tip: 'Fill checklist responses on their due days and avoid overdue backlogs.' },
  'auto:tickets':               { desc: 'Resolution of internal support and issue tickets.', plan: 'Help tickets DUE this week (deadline date; no date = week raised)', actual: 'Of those, resolved / closed', tip: 'Close open support tickets within their assigned SLA deadline.' },
  'auto:snags':                  { plan: 'Snags raised within the week, assigned to user', actual: 'Of those, status = Approved (whenever approved)' },
  'auto:activity_log':          { plan: 'You set',                            actual: 'Create/update/delete actions the user logged this week (audit trail)' },
  // Responsibility (RACI / SLA) — cross-module accountability from the "Responsible" tabs
  'auto:pms_all':               { plan: 'ALL PMS tasks DUE this week (company-wide)', actual: 'Of those, done (company-wide)' },
  'auto:delegations_all':       { plan: 'ALL delegations DUE this week (company-wide)', actual: 'Of those, done (company-wide)' },
  'auto:tickets_all':           { plan: 'ALL help tickets DUE this week (company-wide)', actual: 'Of those, resolved (company-wide)' },
  'auto:snags_all':             { plan: 'ALL snags raised within the week (company-wide)', actual: 'Of those, status = Approved (company-wide)' },
  'auto:erp_module_coverage':   { plan: 'SOTYN.AI modules tracked (the target = all running)', actual: 'Modules with activity this week' },
  'auto:raci_steps_done':       { desc: 'Cross-module SOP accountability across Drawings, Procurement, Indents, and Dispatch.', plan: 'RACI steps on the user this week (closed + still open)', actual: 'RACI steps the user closed this week (all modules)', tip: 'Click on the numbers or "step-wise" to see module-by-module breakdown and pending steps.' },
  'auto:raci_ontime_pct':       { plan: 'You set (target %, e.g. 90)',        actual: '% of the user\'s closed steps done within SLA' },
  // ERP Management (System Flow) — the ERP build tracked step by step, scored
  // on the DEVELOPER column, not the RACI-style Owner (mam 2026-09-07).
  'auto:sysflow_steps':         { plan: 'System Flow steps DUE this week where the user is the DEVELOPER (target date; no date = week created)', actual: 'Of those, completed' },
  'auto:sysflow_ontime_pct':    { plan: 'You set (target %, e.g. 90)',        actual: '% of the steps the user (developer) completed this week that finished on/before their target date' },
  'auto:sysflow_blocked':       { plan: 'You set (max acceptable — pick ↓ lower better)', actual: 'Steps the user is developing that went BLOCKED this week' },
  'auto:sysflow_overdue':       { plan: 'You set (max acceptable — pick ↓ lower better)', actual: 'Steps the user is developing that were OVERDUE at the week end (target passed, not completed)' },
  'auto:sysflow_updates':       { plan: 'You set',                            actual: 'Work updates the user logged this week — status, progress, priority, remarks, ERP link (not step creation or re-dating)' },
  'auto:sysflow_all':           { plan: 'ALL System Flow steps DUE this week (company-wide)', actual: 'Of those, completed (company-wide)' },
  'auto:sysflow_progress_pct':  { plan: 'You set (target %, e.g. 100)',       actual: 'ERP implementation progress at the week end — steps completed ÷ steps existing by then (company-wide)' },
  // DPR
  'auto:dpr_profit':            { plan: 'Σ planned cost (DPR Table B) × 1.5', actual: 'Σ actual (DPR Table A)' },
  'auto:dpr_count':             { plan: '6 days/week target',                 actual: 'DPR submissions for this site' },
  'auto:dpr_by_user':           { plan: '6 DPRs/week target',                 actual: 'DPRs submitted BY this user' },
  'auto:dpr_profit_by_user':    { plan: 'You set (Target column)',            actual: 'Σ profit/loss across user\'s DPRs' },
  'auto:dpr_cost_by_user':      { plan: 'DPRs submitted',                     actual: 'DPRs approved' },
  'auto:dpr_actual_cost_all':   { scope: 'All sites', plan: 'You set the weekly amount', actual: 'Sum of Actual Cost (B-actual) across all sites’ submitted Daily Reports dated Mon–Sat; planned-only reports are excluded' },
  'auto:dpr_actual_cost_sites': { scope: 'Assigned sites', plan: 'You set the weekly amount', actual: 'Sum of Actual Cost (B-actual) for the employee’s assigned sites, by report date Mon–Sat, regardless of uploader; planned-only reports are excluded' },
  'auto:dpr_actual_cost_by_user': { scope: 'Employee uploads', plan: 'You set the weekly amount', actual: 'Sum of Actual Cost (B-actual) from Daily Reports submitted by this employee, by report date Mon–Sat; planned-only reports are excluded' },
  // Sales / CRM
  'auto:leads_created':         { plan: 'You set',                            actual: 'Leads assigned to user this week' },
  'auto:leads_qualified':       { plan: 'You set',                            actual: 'Leads moved to qualified by user' },
  'auto:quotations_sent':       { plan: 'You set',                            actual: 'Quotations sent by user' },
  'auto:meetings_planned':      { plan: 'You set',                            actual: 'Meetings scheduled this week' },
  'auto:crm_kitting':           { plan: 'Weekly checkpoint target (from template / target set)', actual: 'Checkpoints updated / filled this week' },
  // Business Book
  'auto:bb_entries':            { plan: 'You set',                            actual: 'Business Book entries created by user' },
  'auto:bb_po_amount':          { plan: 'You set',                            actual: 'Σ PO amount on user\'s BB entries' },
  'auto:bb_sale_amount':        { plan: 'You set',                            actual: 'Σ Sale amount on user\'s BB entries' },
  'auto:bb_advance':            { plan: 'You set',                            actual: 'Σ Advance received on user\'s BB entries' },
  // Procurement
  'auto:indents_in_week':       { plan: 'Indents created for user\'s site',    actual: 'Indents created for user\'s site' },
  'auto:indent_vs_bill':        { plan: 'Indents raised for the site (this week)', actual: 'Sales bills generated for the site (this week)' },
  'auto:items_complete':        { plan: 'All indent line-items (total)',         actual: 'Items with a PO raised (procured) — company-wide' },
  'auto:po_bill_pending':       { plan: 'POs approved this week (they now owe a bill)', actual: 'POs whose first purchase bill was uploaded this week — Pending = older approved POs still unbilled' },
  'auto:po_bill_pending_all':   { plan: 'POs approved this week — company-wide',        actual: 'POs first billed this week — company-wide; Pending = the whole unbilled backlog' },
  // HR — Manpower (from the HR → Manpower Plan page)
  'auto:site_manpower':         { plan: 'Σ REQUIRED manpower — value slab, all projects', actual: 'Σ ACTUAL manpower on site (DPR average)' },
  'auto:attrition':             { plan: 'You set (max acceptable leavers)',    actual: 'Count of inactive/terminated staff (all-time)' },
  // System / Engagement (from the audit trail)
  'auto:daily_active_users':    { desc: 'Company-wide employee adoption & daily system engagement across all departments.', plan: 'Total active, registered ERP user accounts in the company.', actual: 'Average daily users performing qualifying work actions (Drawings, Tasks, Bills, Indents) Mon–Sat in IST. Attendance punches, login-only visits, and background pings do not count.', tip: 'Ensure all team members log daily task progress and site updates in SOTYN.AI directly instead of offline notes.' },
  'auto:data_entry_all':        { plan: 'You set (e.g. 300000)',               actual: 'CREATE/UPDATE/DELETE records entered company-wide this week' },
  'auto:data_completeness':     { desc: 'Measures mandatory field data quality across Item Master, Business Book, Employees & Users.', plan: 'Every required field across all existing records in company registers.', actual: 'Count of mandatory fields currently filled in with valid data.', tip: 'Review records with missing fields (e.g. HSN/GST, Vendor, Rate, Bank Details) and update them to 100%.' },
  'auto:indents_approved':      { plan: 'You set',                            actual: 'Indents approved by user' },
  'auto:vendor_pos_created':    { plan: 'You set',                            actual: 'Vendor POs created by user' },
  'auto:purchase_bills':        { plan: 'You set',                            actual: 'Purchase bills received this week' },
  'auto:dispatch_sent':         { plan: 'You set',                            actual: 'Delivery notes dispatched' },
  'auto:dispatch_receiving_approved': { plan: 'Receiving records uploaded by this user during the selected week (IST)', actual: 'Of those same uploads, currently approved by Lovely or an admin; later approvals update the upload week' },
  'auto:material_received':     { plan: 'Indents raised for user\'s sites this week', actual: 'Of those, delivered (delivery note) at the site' },
  // Inventory
  'auto:stock_in':              { plan: 'You set',                            actual: 'Stock IN movements (count)' },
  'auto:stock_out':             { plan: 'You set',                            actual: 'Stock OUT movements (count)' },
  'auto:stock_to_site':         { plan: 'You set',                            actual: 'Stock issued from office → site' },
  'auto:stock_updates':         { plan: 'Sites the user manages (1 update each)', actual: 'Sites with a stock update this week' },
  'auto:tools_list':            { plan: 'Sites the user manages (1 list each)',   actual: 'Sites with a tools list submitted this week' },
  'auto:stock_at_site':         { plan: '1 (stock must be present)',             actual: 'Stock-at-site flag (0/1)' },
  // Installation & Billing
  'auto:installations_started': { plan: 'You set',                            actual: 'Installation start dates this week' },
  'auto:installations_completed':{ plan: 'You set',                           actual: 'Installations marked complete this week' },
  'auto:sales_bills':           { plan: 'You set',                            actual: 'Sales bills raised this week' },
  'auto:ra_bills':              { plan: '3 per week (fixed SEPL norm)',          actual: 'RA bills raised for user\'s sites this week' },
  'auto:sales_bill_checking':   { plan: 'You set', actual: 'Installation bills marked Checked / OK by this user during the week (IST); each bill counts once' },
  'auto:dpr_bill_checking':     { plan: 'All installation bills dated in the selected week', actual: 'Of those bills, marked Checked / OK by anyone; later checks update the bill-date week' },
  'auto:mb_filed':              { plan: 'You set',                            actual: 'MB sheets filed (count)' },
  'auto:mb_signed':             { plan: 'MB bills raised for user\'s sites this week', actual: 'Of those, approved / client-signed' },
  // Cash Flow
  'auto:amount_received':       { plan: 'You set',                            actual: 'Σ collections amount (by user)' },
  'auto:amount_received_all':   { plan: 'You set',                            actual: 'Σ collections amount (everyone)' },
  'auto:amount_received_lakh':  { plan: 'You set (target in lakh)',           actual: 'Σ collections this week, in LAKH (₹÷1,00,000)' },
  'auto:receivables_outstanding_cr': { plan: 'You set (target in CR, lower better)', actual: 'Current open receivables, in CRORE (₹÷1,00,00,000)' },
  'auto:collections_count':     { plan: 'You set',                            actual: 'Number of collections (by user)' },
  'auto:receivables_outstanding':{ plan: 'You set',                           actual: 'Σ open receivables (owner)' },
  'auto:receivables_count':     { plan: 'You set',                            actual: 'Count of open receivables (owner)' },
  // Payments
  'auto:payments_raised':       { plan: 'You set',                            actual: 'Payment requests raised by user' },
  'auto:payments_approved':     { plan: 'You set',                            actual: 'Payment requests final-approved by user' },
  'auto:payments_rejected':     { plan: 'You set',                            actual: 'Payment requests rejected' },
  // HR Hiring
  'auto:subcontractor_work_orders': { plan: 'Weekly target: 2 (editable)', actual: 'Work-order files saved in Sub-contractor Master Detail during the selected week (IST); each uploaded file counts once' },
  'auto:candidates_added':      { plan: 'You set',                            actual: 'Candidates added this week' },
  'auto:candidates_shortlisted':{ plan: 'You set',                            actual: 'Candidates shortlisted this week' },
  'auto:offer_letters': { plan: 'Your weekly target (editable)', actual: 'Offer Letters first generated or uploaded in Hiring → Candidates during the selected week (IST); each candidate counts once' },
  'auto:candidates_onboarded':  { plan: 'You set',                            actual: 'Candidates onboarded this week' },
  // Attendance
  'auto:attendance_present_days':{ plan: '6 days target',                     actual: 'Present days this week' },
  'auto:attendance_late_days':  { plan: 'You set (lower better)',             actual: 'Late days this week' },
  'auto:attendance_absent_days':{ plan: '0 days target',                      actual: 'Absent days this week' },
  'auto:leaves_applied':        { plan: 'You set',                            actual: 'Leave requests filed by user' },
  // Complaints — Plan auto-fills from the complaints RAISED in the week;
  // Actual = of that same week's complaints, how many are resolved/closed
  // (mam 2026-08-20: "plan 10 complaint but resolve 9" → 90%). Both sources
  // return the same pair server-side, so the hint is the same for both.
  'auto:complaints_raised':     { plan: 'Complaints raised this week (company-wide)', actual: 'Of those, resolved / closed' },
  'auto:complaints_resolved':   { plan: 'Complaints raised this week (company-wide)', actual: 'Of those, resolved / closed' },
  // Master Data
  'auto:customers_added':       { plan: 'You set',                            actual: 'Customers added by user' },
  'auto:vendors_added':         { plan: 'You set',                            actual: 'Vendors added by user' },
};
const sourceInfoFor = (src) => {
  if (src?.startsWith('auto:raci_step:indent_to_dispatch:')) {
    return {
      plan: 'Whole module: completed this week + pending work that reached this step this week',
      actual: 'Whole module: this step completed during the selected week. Previous pending / done shows older work and how much was completed this week.',
    };
  }
  // Per-step RACI sources are dynamic (auto:raci_step:<module>:<step>) — one hint covers them all.
  if (src && src.startsWith('auto:raci_step:')) {
    // Kept in step with raciUserWeek(): Planned is now week-scoped on BOTH
    // sides. It used to read "closed + still open", which was true but
    // misleading — "still open" meant every open record ever, so a step could
    // show 97 planned from leads sitting since March (mam 2026-08-22).
    return {
      plan: 'Closed this week + still open from work that reached the user this week',
      actual: 'This step the user closed this week',
    };
  }
  return SOURCE_INFO[src] || { plan: '—', actual: '—' };
};

export default function Scorecard() {
  const { user, isAdmin } = useAuth();
  const [tab, setTab] = useUrlTab(['my', 'assign', 'overview', 'templates', 'view'], 'my');
  const [weekStart, setWeekStart] = useState(lastMonday(0));
  const [viewUserId, setViewUserId] = useState(user?.id);
  const [currentSelection] = useState(() => createScorecardSelection({ userId: viewUserId, weekStart }));
  const [scorecard, setScorecard] = useState(null);
  const [weeklyRequests] = useState(() => createLatestScorecardRequest(
      url => api.get(url).then(response => response.data), setScorecard,
      error => toast.error(error.response?.data?.error || 'Failed to load scorecard'),
  ));
  const [savingKpi, setSavingKpi] = useState(null);
  const [templates, setTemplates] = useState([]);
  // Inline rename of the open template's heading (mam 2026-08-22 "rename title").
  const [renamingTpl, setRenamingTpl] = useState(false);
  const [renameVal, setRenameVal] = useState('');
  const [renameSaving, setRenameSaving] = useState(false);
  const [assignments, setAssignments] = useState([]);
  const [tplDetail, setTplDetail] = useState(null);
  // Save the inline template rename. Patches the open modal AND re-pulls the
  // list so the Templates tab and the Assign dropdowns don't keep showing the
  // old name until a reload.
  const saveTplName = async () => {
    const name = renameVal.trim();
    if (!name || !tplDetail || name === tplDetail.name) { setRenamingTpl(false); return; }
    setRenameSaving(true);
    try {
      await api.put(`/scoring/templates/${tplDetail.id}`, { name });
      setTplDetail(d => (d ? { ...d, name } : d));
      api.get('/scoring/templates').then(r => setTemplates(r.data)).catch(() => {});
      setRenamingTpl(false);
      toast.success('Template renamed');
    } catch (e) {
      toast.error(e.response?.data?.error || 'Could not rename the template');
    } finally {
      setRenameSaving(false);
    }
  };
  const [teamSummary, setTeamSummary] = useState(null);
  const [overviewGroupMode, setOverviewGroupMode] = useState('flat'); // 'flat' | 'by_leader'

  // TSK-0914: Load direct reports' team summary for the viewed user/week
  useEffect(() => {
    if (tab !== 'my' && tab !== 'view') {
      setTeamSummary(null);
      return;
    }
    let on = true;
    api.get(`/scoring/team-summary?leader_id=${viewUserId}&week_start=${weekStart}`)
      .then(r => { if (on) setTeamSummary(r.data); })
      .catch(() => { if (on) setTeamSummary(null); });
    return () => { on = false; };
  }, [tab, viewUserId, weekStart]);

  const [overview, setOverview] = useState(null);
  // "RACI Steps" row → step-wise breakdown shown INLINE, expanded under the row
  // on the page (mam 2026-06-27: show it here, like an expand — not in a popup).
  const [raci, setRaci] = useState({ open: false, loading: false, data: null });
  // Collapse + drop stale data whenever the viewed user or week changes.
  useEffect(() => { setRaci({ open: false, loading: false, data: null }); }, [viewUserId, weekStart]);

  // Metric Explainer Modal (ℹ️ button next to each KPI)
  const [explainingKpi, setExplainingKpi] = useState(null);

  // Universal Drilldown Modal for Planned / Actual / Previous Pending / Done
  const [drilldown, setDrilldown] = useState(null);
  const handleDrilldown = useCallback((kpi, type) => {
    // 1. Daily Active Users Drilldown (Active vs Inactive company employees)
    if (kpi.data_source === 'auto:daily_active_users') {
      setDrilldown({
        open: true,
        loading: true,
        title: `Daily Active Users — Company Adoption Audit (${fmtRange(weekStart)})`,
        module: 'active_users',
        type,
        activeTab: type === 'planned' ? 'inactive' : 'active',
        engagementData: null,
      });
      api.get(`/scoring/engagement/users?week_start=${weekStart}`)
        .then(res => setDrilldown(prev => ({ ...prev, loading: false, engagementData: res.data })))
        .catch(err => {
          toast.error(err.response?.data?.error || 'Failed to load user engagement details');
          setDrilldown(null);
        });
      return;
    }

    // 2. Data Completeness Field Audit
    if (kpi.data_source === 'auto:data_completeness' || kpi.data_source?.startsWith('auto:data_completeness:')) {
      const subMod = kpi.data_source === 'auto:data_completeness' ? '' : kpi.data_source.slice('auto:data_completeness:'.length);
      setDrilldown({
        open: true,
        loading: true,
        title: `${kpi.metric_name} — Data Field Completion Audit`,
        module: 'data_completeness',
        type,
        completenessData: null,
      });
      const url = subMod ? `/data-completion/${subMod}` : `/data-completion`;
      api.get(url)
        .then(res => setDrilldown(prev => ({ ...prev, loading: false, completenessData: res.data })))
        .catch(err => {
          toast.error(err.response?.data?.error || 'Failed to load data completion details');
          setDrilldown(null);
        });
      return;
    }

    // 3. Task Modules (Delegations, PMS, Tickets, Checklists)
    const modMap = {
      'auto:delegations': 'delegations',
      'auto:pms': 'pms',
      'auto:tickets': 'tickets',
      'auto:checklists': 'checklists',
    };
    const mod = modMap[kpi.data_source];
    if (!mod) return;
    const isTicket = kpi.data_source === 'auto:tickets';
    const typeLabels = {
      planned: 'Planned Tasks (Due this week)',
      actual: isTicket ? 'Resolved / Closed Tasks (This week)' : 'Approved Tasks (This week)',
      prev_pending: 'Pending Backlog (Still Pending · Due before this week)',
      prev_done: isTicket ? 'Previous Backlog Resolved This Week' : 'Previous Backlog Approved This Week',
    };
    setDrilldown({
      open: true,
      loading: true,
      title: `${kpi.metric_name} — ${typeLabels[type] || 'Tasks'} (${fmtRange(weekStart)})`,
      rows: [],
      module: mod,
      type,
    });
    api.get(`/scoring/weekly/detail?user_id=${viewUserId}&module=${mod}&type=${type}&week_start=${weekStart}`)
      .then(res => setDrilldown(prev => ({ ...prev, loading: false, rows: res.data?.rows || [] })))
      .catch(err => {
        toast.error(err.response?.data?.error || 'Failed to load task details');
        setDrilldown(null);
      });
  }, [viewUserId, weekStart]);
  const toggleRaci = useCallback(() => {
    setRaci(r => {
      if (r.open) return { ...r, open: false };          // collapse
      api.get(`/scoring/raci-breakdown?user_id=${viewUserId}&week_start=${weekStart}`)
        .then(res => setRaci(rr => ({ ...rr, loading: false, data: res.data })))
        .catch(err => { setRaci({ open: false, loading: false, data: null }); toast.error(err.response?.data?.error || 'Failed to load step-wise breakdown'); });
      return { open: true, loading: true, data: r.data };  // expand + fetch fresh
    });
  }, [viewUserId, weekStart]);

  const loadScorecard = useCallback(() => {
    return weeklyRequests.load(`/scoring/scorecard?user_id=${viewUserId}&week_start=${weekStart}`);
  }, [viewUserId, weekStart, weeklyRequests]);

  const loadOverview = useCallback(() => {
    api.get(`/scoring/weekly?week_start=${weekStart}`)
      .then(r => setOverview(r.data))
      .catch(() => setOverview(null));
  }, [weekStart]);

  useEffect(() => {
    if (tab === 'my' || tab === 'view') loadScorecard();
    if (tab === 'overview') loadOverview();
    if (tab === 'templates') api.get('/scoring/templates').then(r => setTemplates(r.data || [])).catch(() => {});
    if (tab === 'assign') {
      Promise.all([
        api.get('/scoring/assignments').then(r => r.data),
        api.get('/scoring/templates').then(r => r.data),
      ]).then(([a, t]) => { setAssignments(a || []); setTemplates(t || []); }).catch(() => {});
    }
  }, [tab, loadScorecard, loadOverview]);

  const saveEntry = async (kpi, patch) => {
    setSavingKpi(kpi.kpi_id);
    try {
      await saveSelectedScorecard({ userId: viewUserId, weekStart }, () => api.put('/scoring/scorecard/entry', {
        user_id: viewUserId, kpi_id: kpi.kpi_id, week_start: weekStart, ...patch,
      }), () => currentSelection.get(), current => {
        const loads = [weeklyRequests.load(`/scoring/scorecard?user_id=${current.userId}&week_start=${current.weekStart}`)];
        if (current.rangeApplied) {
          setPeriodCard(null);
          loads.push(periodRequests.load(`/scoring/scorecard-range?user_id=${current.userId}&from=${current.rangeApplied.from}&to=${current.rangeApplied.to}`));
        }
        return Promise.all(loads);
      });
      return true;
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
      return false;
    } finally {
      setSavingKpi(null);
    }
  };

  // Group KPIs by group_name for the table render

  // Mam 2026-08-17: "one time last 6 months score count show" — ONE aggregate
  // figure: the average weekly vs-plan variance across the last 26 weeks
  // (weeks without a scored template are skipped, count shown alongside).
  const [sixMonth, setSixMonth] = useState(null);
  useEffect(() => {
    let on = true;
    setSixMonth(null);
    api.get(`/scoring/commitments?user_id=${viewUserId}&week_start=${weekStart}&weeks=26`)
      .then(r => {
        if (!on) return;
        const vals = (r.data?.weeks || []).map(w => w.actual_pct).filter(v => v != null);
        setSixMonth(vals.length
          ? { avg: Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100, n: vals.length }
          : { avg: null, n: 0 });
      })
      .catch(() => { if (on) setSixMonth({ avg: null, n: 0 }); });
    return () => { on = false; };
  }, [viewUserId, weekStart]);

  // Mam 2026-08-17: "give me start to end date manual because in onetime i
  // want last one month" — a manual From/To range that shows ONE average for
  // that window. Snaps to whole scoring weeks (Mon-Sat): the range runs from
  // the week containing From through the week containing To.
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  // Mam 2026-08-17: "period select and give apply button" — typing a date no
  // longer triggers a half-picked calculation; the score computes only when
  // Apply is pressed (rangeApplied snapshots the dates at that moment).
  const [rangeApplied, setRangeApplied] = useState(null);
  useLayoutEffect(() => {
    currentSelection.set({ userId: viewUserId, weekStart, rangeApplied });
  }, [viewUserId, weekStart, rangeApplied, currentSelection]);
  const [rangeStat, setRangeStat] = useState(null);
  // The FULL scorecard aggregated over the applied period — when set, the MIS
  // table shows these summed values instead of the single week (read-only).
  const [periodCard, setPeriodCard] = useState(null);
  const [periodRequests] = useState(() => createLatestScorecardRequest(
      url => api.get(url).then(response => response.data), setPeriodCard,
      () => setPeriodCard(null),
  ));
  const chooseWeek = week => {
    if (!week) return;
    const selectedWeek = selectScorecardWeek(week, {
      weekly: weeklyRequests, period: periodRequests,
      setScorecard, setPeriodCard, setRangeApplied, setRangeStat, setWeekStart,
    });
    // Re-selecting the same week also exits period mode and refreshes its data.
    if (selectedWeek === weekStart) loadScorecard();
  };
  useEffect(() => {
    if (!rangeApplied) { setPeriodCard(null); return; }
    setPeriodCard(null);
    periodRequests.load(`/scoring/scorecard-range?user_id=${viewUserId}&from=${rangeApplied.from}&to=${rangeApplied.to}`);
    return () => periodRequests.invalidate();
  }, [rangeApplied, viewUserId, periodRequests]);
  useEffect(() => () => {
    weeklyRequests.invalidate();
    periodRequests.invalidate();
  }, [weeklyRequests, periodRequests]);
  useEffect(() => {
    if (!rangeApplied) { setRangeStat(null); return; }
    let from = mondayOf(rangeApplied.from), to = mondayOf(rangeApplied.to);
    if (!from || !to) { setRangeStat(null); return; }
    if (from > to) [from, to] = [to, from];            // swapped dates — just fix them
    const nWeeks = Math.min(53, Math.round((new Date(to) - new Date(from)) / (7 * 864e5)) + 1);
    let on = true;
    setRangeStat({ loading: true });
    api.get(`/scoring/commitments?user_id=${viewUserId}&week_start=${to}&weeks=${nWeeks}`)
      .then(r => {
        if (!on) return;
        const vals = (r.data?.weeks || []).map(w => w.actual_pct).filter(v => v != null);
        setRangeStat({
          from, to, n: vals.length,
          avg: vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100 : null,
        });
      })
      .catch(() => { if (on) setRangeStat(null); });
    return () => { on = false; };
  }, [rangeApplied, viewUserId]);

  // Period mode: the applied From→To aggregate replaces the weekly card in the
  // table + banner (read-only — entries/commitments are per-week concepts).
  const displayCard = selectedScorecard({ scorecard, periodCard, rangeApplied, viewUserId, weekStart });
  const periodMode = !!rangeApplied;
  // Whose scorecard is on screen — comes from the API (admin can switch to any
  // employee), falling back to the logged-in user so the export filename and
  // the print letterhead are never blank.
  const cardOwnerName = displayCard?.user?.name || scorecard?.user?.name
    || (viewUserId === user?.id ? (user?.name || '') : '');
  const grouped = (displayCard?.kpis || []).reduce((acc, k) => {
    const g = (displayCard?.templates?.length > 1 ? `${k.template_name} · ` : '') + (k.group_name || 'Other');
    if (!acc[g]) acc[g] = [];
    acc[g].push(k);
    return acc;
  }, {});

  // Mam 2026-08-17: "add option for print this scoring also". Browser-print of
  // just the scorecard area — a body class + CSS in index.css hides the rest
  // of the app (sidebar, tabs, pickers) while printing.
  // Landscape (mam 2026-09-14): @page can't be scoped to a body class, so the
  // rule is injected only for this print and removed after — bills and other
  // print pages keep their own portrait layout.
  const printScorecard = () => {
    document.body.classList.add('print-scorecard');
    const pageStyle = document.createElement('style');
    pageStyle.textContent = '@page { size: A4 landscape; margin: 8mm; }';
    document.head.appendChild(pageStyle);
    const done = () => { document.body.classList.remove('print-scorecard'); pageStyle.remove(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    setTimeout(() => window.print(), 60);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-3">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2"><FiTrendingUp className="text-indigo-600" /> Scorecard</h1>
          <p className="text-sm text-gray-500">Weekly MIS — Mon-Sat. Per-role KPI templates with planned vs actual and weighted score.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        <button onClick={() => { setTab('my'); setViewUserId(user.id); }}
          className={`btn ${tab === 'my' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUser size={14} /> My Scorecard
        </button>
        <button onClick={() => setTab('overview')}
          className={`btn ${tab === 'overview' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
          <FiUsers size={14} /> Team Overview
        </button>
        {isAdmin() && (
          <>
            <button onClick={() => setTab('templates')}
              className={`btn ${tab === 'templates' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiSettings size={14} /> Templates
            </button>
            <button onClick={() => setTab('assign')}
              className={`btn ${tab === 'assign' ? 'btn-primary' : 'btn-secondary'} flex items-center gap-1`}>
              <FiUsers size={14} /> Assign Templates
            </button>
          </>
        )}
      </div>

      {(tab === 'my' || tab === 'overview' || tab === 'view') && (
        <div className="card p-4 flex flex-wrap items-center gap-3">
          <FiCalendar className="text-gray-400" />
          <div>
            <label className="label">Week starting (Monday)</label>
            <input type="date" className="input" value={weekStart} onChange={e => chooseWeek(e.target.value)} />
          </div>
          <div className="flex gap-1 flex-wrap items-center">
            <button onClick={() => chooseWeek(lastMonday(1))} className="btn btn-secondary text-xs">Last Week</button>
            <button onClick={() => chooseWeek(lastMonday(0))} className="btn btn-secondary text-xs">This Week</button>
            <button onClick={() => chooseWeek(lastMonday(2))} className="btn btn-secondary text-xs">Two Weeks Ago</button>
            {/* Mam 2026-08-17: "add with two weeks last 6 months also" — jump
                to any week of the last 6 months without date-picker gymnastics. */}
            <select
              className="input text-xs w-auto py-1.5"
              value={Array.from({ length: 26 }, (_, i) => lastMonday(i)).includes(weekStart) ? weekStart : ''}
              onChange={e => e.target.value && chooseWeek(e.target.value)}>
              <option value="" disabled>Last 6 months…</option>
              {Array.from({ length: 26 }, (_, i) => {
                const m = lastMonday(i);
                return (
                  <option key={m} value={m}>
                    {fmtRange(m)}{i === 0 ? ' · this week' : ''}
                  </option>
                );
              })}
            </select>
          </div>
          {/* Mam 2026-08-17: manual From→To period — one average score for any
              window (e.g. last one month). Result shows in the score banner. */}
          <div>
            <label className="label">Period score (from → to)</label>
            <div className="flex items-center gap-1">
              <input type="date" className="input text-xs w-auto py-1.5" title="Period from"
                value={rangeFrom} onChange={e => setRangeFrom(e.target.value)} />
              <span className="text-xs text-gray-400">→</span>
              <input type="date" className="input text-xs w-auto py-1.5" title="Period to"
                value={rangeTo} onChange={e => setRangeTo(e.target.value)} />
              <button
                onClick={() => setRangeApplied({ from: rangeFrom, to: rangeTo })}
                disabled={!rangeFrom || !rangeTo}
                className="btn btn-primary text-xs py-1.5 disabled:opacity-40"
                title="Calculate the score for this period">
                Apply
              </button>
              {(rangeFrom || rangeTo || rangeApplied) && (
                <button onClick={() => { setRangeFrom(''); setRangeTo(''); setRangeApplied(null); }}
                  className="text-gray-400 hover:text-red-600 text-sm px-1" title="Clear period">✕</button>
              )}
            </div>
          </div>
          {/* Admin & Team Leader employee switcher (TSK-0914) */}
          {(tab === 'my' || tab === 'view') && (
            <EmployeeSwitcher value={viewUserId} onChange={setViewUserId} currentUserId={user?.id} />
          )}
          <div className="ml-auto text-sm text-gray-700">
            <span className="font-semibold">{fmtRange(weekStart)}</span>
          </div>
        </div>
      )}

      {/* MY SCORECARD */}
      {(tab === 'my' || tab === 'view') && !displayCard && <div className="card p-4 text-sm text-gray-500">Loading scorecard…</div>}
      {(tab === 'my' || tab === 'view') && displayCard && (
        <div id="scorecard-print-area" className="space-y-6">
          {/* Active view indicator for team leader / admin viewing another user */}
          {viewUserId !== user?.id && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-2.5 flex items-center justify-between text-xs text-blue-800 print:hidden shadow-sm">
              <span className="flex items-center gap-1.5 font-medium">
                <FiUser size={14} className="text-blue-600" /> Viewing <b>{cardOwnerName?.trim()}</b>&apos;s scorecard
                {isAdmin() ? (
                  <span className="ml-1 px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-semibold text-[10px]">
                    Admin Mode
                  </span>
                ) : (
                  <span className="ml-1 text-gray-500 font-normal">
                    (Read Only)
                  </span>
                )}
              </span>
              <button
                type="button"
                onClick={() => { setViewUserId(user?.id); setTab('my'); }}
                className="btn btn-secondary text-xs py-1 px-2.5 bg-white hover:bg-gray-50 text-blue-700 border-blue-200"
              >
                ← Back to My Scorecard
              </button>
            </div>
          )}
          {/* Letterhead — appears only on the printed sheet */}
          <div className="hidden print:block text-center border-b-2 border-gray-800 pb-3">
            <div className="text-xl font-bold tracking-wide">SECURED ENGINEERS PVT. LTD.</div>
            <div className="text-sm font-semibold mt-1">{periodMode ? 'Period' : 'Weekly'} Scorecard — {cardOwnerName}</div>
            <div className="text-xs text-gray-600">
              {periodMode ? `${fmtRange(displayCard.from)} → ${fmtRange(displayCard.to)} (${displayCard.weeks_counted} weeks)` : fmtRange(weekStart)}
              {' '}· Template: {displayCard.template?.name || '—'}
            </div>
          </div>
          <div className="card p-4 flex flex-wrap items-center justify-between gap-3 bg-gradient-to-r from-indigo-50 to-blue-50">
            <div>
              <p className="text-xs text-gray-500">{displayCard.templates?.length > 1 ? `${displayCard.templates.length} templates` : 'Template'}</p>
              <p className="text-lg font-bold">{displayCard.template?.name || <span className="text-amber-600">No template assigned</span>}</p>
              {displayCard.templates?.length > 1 && <p className="text-xs text-gray-500 mt-1">Combined score uses the KPI weights across all selected templates. Matching KPI names remain separate by template.</p>}
              {displayCard.template?.description && <p className="text-xs text-gray-500">{displayCard.template.description}</p>}
              {periodMode && (
                <span className="inline-block mt-1 text-[11px] font-bold px-2 py-0.5 rounded bg-indigo-600 text-white">
                  PERIOD {fmtRange(displayCard.from).replace(/ \d{4}$/, '')} → {fmtRange(displayCard.to)} · {displayCard.weeks_counted} wks
                </span>
              )}
            </div>
            <div className="flex items-center gap-3">
              {displayCard.template && (displayCard.kpis || []).length > 0 && (
                <button
                  onClick={() => exportCsv(
                    `scorecard-${(cardOwnerName || 'user').replace(/\s+/g, '-')}-${periodMode ? `${displayCard.from}_to_${displayCard.to}` : weekStart}`,
                    ['Employee', 'Template', 'Group', 'Team / Person', 'Weight %', 'Planned', 'Actual', 'Actual %', 'Previous Pending', 'Previous Done', 'Previous Score %', 'Commitment'],
                    (displayCard.kpis || []).map(k => [
                      cardOwnerName,
                      k.template_name || '',
                      k.group_name || 'Other',
                      k.metric_name || '',
                      k.weightage ?? '',
                      k.planned ?? 0,
                      k.actual ?? 0,
                      vsPlan(k.actual_pct) ?? '',
                      k.pending_uptodate ?? '',
                      k.pending_work ?? '',
                      // (done ÷ pending) × 100 − 100; nothing pending = on plan (0)
                      vsPlan((+k.pending_uptodate || 0) > 0 ? ((+k.pending_work || 0) / +k.pending_uptodate) * 100 : 100) ?? '',
                      [k.commitment_prev ? `Prev: ${k.commitment_prev}` : '', k.commitment ? `Now: ${k.commitment}` : '']
                        .filter(Boolean).join(' · '),
                    ])
                  )}
                  className="btn btn-secondary text-xs flex items-center gap-1 print:hidden"
                  title="Download this scorecard as CSV (opens in Excel)"
                ><FiDownload size={14} /> Export Excel</button>
              )}
              {displayCard.template && (displayCard.kpis || []).length > 0 && (
                <button onClick={printScorecard}
                  className="btn btn-secondary text-xs flex items-center gap-1 print:hidden"
                  title="Print this scorecard (or save as PDF)"
                ><FiPrinter size={14} /> Print</button>
              )}
              <div className="text-right">
                <p className="text-xs text-gray-500">{periodMode ? 'Period Score' : 'Weekly Score'} <span className="text-gray-400">vs plan</span></p>
                {(() => {
                  // Headline = variance from plan (achievement% − 100), 2 decimals:
                  // 0% = on plan, negative = behind, positive = ahead (mam 2026-07-04).
                  // Engine score stays the raw achievement % so the Champions League /
                  // War Room keep ranking higher-better; this is display-only.
                  // In period mode this is the weighted score of the SUMMED table.
                  if (!displayCard.template) return <p className="text-3xl font-bold text-gray-300">—</p>;
                  const headVs = (displayCard.score ?? 0) - 100;
                  return <p className={`text-3xl font-bold ${vsClr(displayCard.score)}`}>{headVs > 0 ? '+' : ''}{headVs.toFixed(2)}%</p>;
                })()}
              </div>
              {/* Mam 2026-08-17: one-shot 6-month aggregate — avg of the weekly
                  vs-plan variances over the 26 weeks ending at the viewed week. */}
              <div className="text-right border-l border-indigo-200 pl-3">
                <p className="text-xs text-gray-500">Last 6 Months <span className="text-gray-400">avg vs plan</span></p>
                {sixMonth == null
                  ? <p className="text-2xl font-bold text-gray-300">…</p>
                  : sixMonth.avg == null
                    ? <p className="text-2xl font-bold text-gray-300">—</p>
                    : <p className={`text-2xl font-bold ${vsClr(sixMonth.avg + 100)}`}>{sixMonth.avg > 0 ? '+' : ''}{sixMonth.avg.toFixed(2)}%</p>}
                {sixMonth?.n > 0 && <p className="text-[10px] text-gray-400">across {sixMonth.n} scored week{sixMonth.n === 1 ? '' : 's'}</p>}
              </div>
              {/* One-shot score for the manually picked From→To period. */}
              {rangeStat && (
                <div className="text-right border-l border-indigo-200 pl-3">
                  <p className="text-xs text-gray-500">Selected Period <span className="text-gray-400">avg vs plan</span></p>
                  {rangeStat.loading
                    ? <p className="text-2xl font-bold text-gray-300">…</p>
                    : rangeStat.avg == null
                      ? <p className="text-2xl font-bold text-gray-300">—</p>
                      : <p className={`text-2xl font-bold ${vsClr(rangeStat.avg + 100)}`}>{rangeStat.avg > 0 ? '+' : ''}{rangeStat.avg.toFixed(2)}%</p>}
                  {!rangeStat.loading && (
                    <p className="text-[10px] text-gray-400">
                      {rangeStat.n > 0
                        ? `${fmtRange(rangeStat.from).replace(/ \d{4}$/, '')} → ${fmtRange(rangeStat.to)} · ${rangeStat.n} scored wk${rangeStat.n === 1 ? '' : 's'}`
                        : 'no scored weeks in this period'}
                    </p>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Weekly commitment — the employee's promise for the coming week,
              last week's committed target, and a committed-vs-delivered graph
              so they SEE the gap (mam 2026-07-06). Print shows the MIS tables
              only, so this interactive panel stays screen-only. */}
          <div className="print:hidden space-y-4">
            <CommitmentPanel viewUserId={viewUserId} weekStart={weekStart} />
            {displayCard.template && (displayCard.kpis || []).length > 0 && (
              <WorkExecutionGraph kpis={displayCard.kpis} weekStart={weekStart} cardOwnerName={cardOwnerName} />
            )}
          </div>

          {!displayCard.template && (
            <div className="card p-6 text-center text-gray-400 text-sm">
              No template assigned to this user yet. {isAdmin() && <span>Open the <button className="text-blue-600 underline" onClick={() => setTab('assign')}>Assign Templates</button> tab to set one.</span>}
            </div>
          )}

          {displayCard.template && Object.keys(grouped).map(groupName => (
            <div key={groupName} className="card p-0 overflow-x-auto">
              <div className="px-4 py-2 bg-amber-50 border-b border-amber-200 font-bold text-amber-800 text-sm">{groupName}</div>
              <NumberedTable className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
                  <tr>
                    <th className="text-left p-2 w-[260px]">Team / Person</th>
                    <th className="text-center p-2 w-16">Weight %</th>
                    <th className="text-center p-2 w-24">Planned</th>
                    <th className="text-center p-2 w-24">Actual</th>
                    <th className="text-center p-2 w-20">Actual %</th>
                    <th className="text-center p-2 w-24">Previous<br />Pending / Done</th>
                    <th className="text-left p-2 w-40">Commitment</th>
                  </tr>
                </thead>
                <tbody>
                  {grouped[groupName].map((k, index) => {
                    const isRaci = k.data_source === 'auto:raci_steps_done';
                    return (
                      <Fragment key={k.kpi_id}>
                        <KpiRow
                          serialNumber={index + 1}
                          kpi={k}
                          saving={savingKpi === k.kpi_id}
                          onSave={(patch) => saveEntry(k, patch)}
                          readOnly={periodMode || (viewUserId !== user.id && !isAdmin())}
                          onStepWise={isRaci && !periodMode ? toggleRaci : null}
                          stepWiseOpen={isRaci && !periodMode && raci.open}
                          onDrilldown={handleDrilldown}
                          onExplain={setExplainingKpi}
                        />
                        {isRaci && raci.open && (
                          <tr className="border-t bg-gray-50">
                            <td colSpan={7} className="p-3">
                              {raci.loading
                                ? <p className="text-sm text-gray-500">Loading step-wise…</p>
                                : <RaciBreakdown data={raci.data} />}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </NumberedTable>
            </div>
          ))}
          {/* TEAM LEADER'S TEAM SCORING (TSK-0914) */}
          {teamSummary?.has_team && (
            <div className="card p-0 overflow-hidden border border-indigo-200 print:hidden mt-6 shadow-sm">
              <div className="bg-gradient-to-r from-indigo-50 to-blue-50 p-4 border-b border-indigo-100 flex flex-wrap items-center justify-between gap-3">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="p-1.5 bg-indigo-600 text-white rounded-lg shadow-sm">
                      <FiUsers size={16} />
                    </span>
                    <h3 className="font-bold text-base text-gray-800">
                      Team Performance · {teamSummary.leader.name}&apos;s Team
                    </h3>
                    <span className="text-xs bg-indigo-100 text-indigo-700 px-2 py-0.5 rounded-full font-semibold">
                      {teamSummary.team_count} direct report{teamSummary.team_count === 1 ? '' : 's'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    Weekly scoring for employees reporting to this team leader. Click &ldquo;Open MIS&rdquo; to inspect any team member&apos;s scorecard.
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right bg-white px-3 py-1.5 rounded-lg border border-indigo-100 shadow-sm">
                    <p className="text-[10px] text-gray-500 uppercase tracking-wide">Team Average</p>
                    <p className={`text-xl font-bold ${vsClr(teamSummary.team_average_score)}`}>
                      {fmtVs(teamSummary.team_average_score)}
                    </p>
                  </div>
                </div>
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase border-b border-gray-200">
                    <tr>
                      <th className="p-2 text-left w-12">#</th>
                      <th className="p-2 text-left">Team Member</th>
                      <th className="p-2 text-left">Role / Template</th>
                      <th className="p-2 text-center">Delegations</th>
                      <th className="p-2 text-center">PMS Tasks</th>
                      <th className="p-2 text-center">Checklists</th>
                      <th className="p-2 text-center">Tickets</th>
                      <th className="p-2 text-right">Weekly Score</th>
                      <th className="p-2 text-center w-24">Action</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {teamSummary.members.map((m, idx) => (
                      <tr key={m.user_id} className="hover:bg-blue-50/40 transition">
                        <td className="p-2 font-bold text-gray-400">#{idx + 1}</td>
                        <td className="p-2">
                          <div className="font-semibold text-gray-900">{m.name}</div>
                          <div className="text-[10px] text-gray-400">{m.department || '—'}</div>
                        </td>
                        <td className="p-2">
                          <span className="text-gray-700">{m.template_name || m.role || '—'}</span>
                        </td>
                        <td className="p-2 text-center">
                          <span className={m.delegations.done === m.delegations.given && m.delegations.given > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-600'}>
                            {m.delegations.done}/{m.delegations.given}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <span className={m.pms.done === m.pms.given && m.pms.given > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-600'}>
                            {m.pms.done}/{m.pms.given}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <span className={m.checklists.done === m.checklists.given && m.checklists.given > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-600'}>
                            {m.checklists.done}/{m.checklists.given}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <span className={m.tickets.done === m.tickets.given && m.tickets.given > 0 ? 'text-emerald-700 font-semibold' : 'text-gray-600'}>
                            {m.tickets.done}/{m.tickets.given}
                          </span>
                        </td>
                        <td className="p-2 text-right">
                          <span className={`px-2 py-0.5 rounded text-xs font-bold ${scorePill(m.variance)}`}>
                            {fmtVs(m.score)}
                          </span>
                        </td>
                        <td className="p-2 text-center">
                          <button
                            type="button"
                            onClick={() => { setViewUserId(m.user_id); setTab('view'); }}
                            className="btn btn-secondary text-[11px] py-1 px-2.5 font-medium hover:bg-indigo-50 hover:text-indigo-600"
                          >
                            Open MIS
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {/* TEAM OVERVIEW (existing weekly aggregator + TSK-0914 Group by Leader) */}
      {tab === 'overview' && overview && (
        <div className="card p-0 overflow-x-auto">
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-gray-50 border-b border-gray-200">
            <div className="text-xs text-gray-500">
              <b>{overview.users.length}</b> employees scored for week {fmtRange(weekStart)}.
            </div>
            <div className="flex items-center gap-1 text-xs">
              <button
                type="button"
                onClick={() => setOverviewGroupMode('flat')}
                className={`px-2.5 py-1 rounded font-medium transition ${overviewGroupMode === 'flat' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white border text-gray-700 hover:bg-gray-100'}`}
              >
                All Employees (Ranked)
              </button>
              <button
                type="button"
                onClick={() => setOverviewGroupMode('by_leader')}
                className={`px-2.5 py-1 rounded font-medium transition ${overviewGroupMode === 'by_leader' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white border text-gray-700 hover:bg-gray-100'}`}
              >
                Group by Team Leader
              </button>
            </div>
          </div>
          <table>
            <thead>
              <tr>
                <th>Rank</th>
                <th>Employee</th>
                <th>Dept</th>
                <th className="text-center">Delegations</th>
                <th className="text-center">PMS</th>
                <th className="text-center">Checklists</th>
                <th className="text-center">Tickets</th>
                <th className="text-right">Score</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {overviewGroupMode === 'flat' ? (
                overview.users.map((u, i) => (
                  <tr key={u.user_id}>
                    <td className="text-gray-400 font-bold">#{i + 1}</td>
                    <td className="font-medium">{u.name}</td>
                    <td className="text-xs text-gray-500">{u.department || u.role}</td>
                    <td className="text-center">{u.delegations.done}/{u.delegations.given}</td>
                    <td className="text-center">{u.pms.done}/{u.pms.given}</td>
                    <td className="text-center">{u.checklists.done}/{u.checklists.given}</td>
                    <td className="text-center">{u.tickets.done}/{u.tickets.given}</td>
                    <td className="text-right">
                      <span className={`px-2 py-1 rounded text-xs font-bold ${scorePill(u.score - 100)}`}>{fmtVs(u.score)}</span>
                    </td>
                    <td>
                      <button onClick={() => { setViewUserId(u.user_id); setTab('view'); }} className="btn btn-secondary text-xs">Open MIS</button>
                    </td>
                  </tr>
                ))
              ) : (
                (() => {
                  const groups = {};
                  overview.users.forEach(u => {
                    const grp = u.manager_name ? `${u.manager_name}'s Team` : 'Other / Direct Reports';
                    if (!groups[grp]) groups[grp] = [];
                    groups[grp].push(u);
                  });
                  return Object.entries(groups).map(([groupTitle, groupMembers]) => {
                    const avg = groupMembers.reduce((s, m) => s + (m.score || 0), 0) / groupMembers.length;
                    return (
                      <Fragment key={groupTitle}>
                        <tr className="bg-indigo-50/70 border-y border-indigo-100">
                          <td colSpan={7} className="py-2 px-3 font-bold text-xs text-indigo-900">
                            👥 {groupTitle} ({groupMembers.length} member{groupMembers.length === 1 ? '' : 's'})
                          </td>
                          <td className="py-2 px-3 text-right">
                            <span className={`px-2 py-0.5 rounded text-[11px] font-bold ${scorePill(avg - 100)}`}>
                              Avg: {fmtVs(avg)}
                            </span>
                          </td>
                          <td></td>
                        </tr>
                        {groupMembers.map((u, i) => (
                          <tr key={u.user_id} className="hover:bg-gray-50/50">
                            <td className="text-gray-400 font-bold pl-5">↳ #{i + 1}</td>
                            <td className="font-medium">{u.name}</td>
                            <td className="text-xs text-gray-500">{u.department || u.role}</td>
                            <td className="text-center">{u.delegations.done}/{u.delegations.given}</td>
                            <td className="text-center">{u.pms.done}/{u.pms.given}</td>
                            <td className="text-center">{u.checklists.done}/{u.checklists.given}</td>
                            <td className="text-center">{u.tickets.done}/{u.tickets.given}</td>
                            <td className="text-right">
                              <span className={`px-2 py-1 rounded text-xs font-bold ${scorePill(u.score - 100)}`}>{fmtVs(u.score)}</span>
                            </td>
                            <td>
                              <button onClick={() => { setViewUserId(u.user_id); setTab('view'); }} className="btn btn-secondary text-xs">Open MIS</button>
                            </td>
                          </tr>
                        ))}
                      </Fragment>
                    );
                  });
                })()
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* TEMPLATES (admin) */}
      {tab === 'templates' && (
        <TemplatesAdmin templates={templates} reload={() => api.get('/scoring/templates').then(r => setTemplates(r.data))} setTplDetail={setTplDetail} />
      )}

      {/* ASSIGN (admin) */}
      {tab === 'assign' && (
        <AssignTemplates assignments={assignments} templates={templates} onSaved={(userId, selected) => {
          setAssignments(previous => previous.map(a => a.user_id !== userId ? a : { ...a,
            templates: selected, template_ids: selected.map(t => t.id),
            template_id: selected[0]?.id ?? null, template_name: selected.map(t => t.name).join(' + ') || null }));
        }} />
      )}

      {/* Template detail modal. The heading doubles as an inline rename (mam
          2026-08-22 "rename title") — the template name was read-only here, so
          a role that got renamed (or typo'd on creation) could only be fixed by
          deleting the template and rebuilding every KPI on it. Admin-only,
          matching PUT /scoring/templates/:id which is adminOnly server-side. */}
      <Modal
        isOpen={!!tplDetail}
        onClose={() => { setTplDetail(null); setRenamingTpl(false); }}
        wide
        title={
          !tplDetail ? 'Template' : renamingTpl ? (
            <span className="flex items-center gap-2">
              <input
                autoFocus
                value={renameVal}
                onChange={e => setRenameVal(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') saveTplName();
                  if (e.key === 'Escape') setRenamingTpl(false);
                }}
                placeholder="Template name"
                className="input text-base font-semibold py-1"
              />
              <button onClick={saveTplName} disabled={renameSaving || !renameVal.trim()} className="btn btn-primary text-xs py-1 whitespace-nowrap">
                {renameSaving ? 'Saving…' : 'Save'}
              </button>
              <button onClick={() => setRenamingTpl(false)} className="btn btn-secondary text-xs py-1">Cancel</button>
            </span>
          ) : (
            <span className="flex items-center gap-2">
              {tplDetail.name}
              {isAdmin() && (
                <button
                  onClick={() => { setRenameVal(tplDetail.name || ''); setRenamingTpl(true); }}
                  title="Rename this template"
                  className="p-1 text-gray-400 hover:text-blue-700 hover:bg-gray-100 rounded flex-shrink-0"
                >
                  <FiEdit2 size={14} />
                </button>
              )}
            </span>
          )
        }
      >
        {tplDetail && <TemplateKpiEditor templateId={tplDetail.id} onChange={() => api.get(`/scoring/templates/${tplDetail.id}`).then(r => setTplDetail(r.data))} />}
      </Modal>

      {/* Universal Drilldown Modal */}
      <Modal
        isOpen={!!drilldown?.open}
        onClose={() => setDrilldown(null)}
        title={drilldown?.title || 'Audit Details'}
        wide
      >
        {drilldown?.loading ? (
          <div className="p-8 text-center text-sm text-gray-500">Loading details…</div>
        ) : drilldown?.module === 'active_users' ? (
          // ─── Daily Active Users Audit View ───
          <div className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50 p-3 rounded-lg border text-center">
              <div>
                <div className="text-[10px] text-gray-500 uppercase font-semibold">Registered Users (Target)</div>
                <div className="text-xl font-bold text-gray-800">{drilldown.engagementData?.total_registered || 0}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500 uppercase font-semibold">Avg Daily Active (Score)</div>
                <div className="text-xl font-bold text-indigo-600">{drilldown.engagementData?.average_daily_active || 0}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500 uppercase font-semibold">Active This Week</div>
                <div className="text-xl font-bold text-emerald-600">{drilldown.engagementData?.active_users?.length || 0}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-500 uppercase font-semibold">Zero-Activity Gap</div>
                <div className="text-xl font-bold text-red-600">{drilldown.engagementData?.inactive_users?.length || 0}</div>
              </div>
            </div>

            <div className="flex items-center justify-between gap-2 border-b pb-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setDrilldown(prev => ({ ...prev, activeTab: 'active' }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                    drilldown.activeTab === 'active'
                      ? 'bg-emerald-600 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <span>Active Employees</span>
                  <span className="px-1.5 py-0.2 bg-white/20 rounded-full text-[10px]">
                    {drilldown.engagementData?.active_users?.length || 0}
                  </span>
                </button>
                <button
                  type="button"
                  onClick={() => setDrilldown(prev => ({ ...prev, activeTab: 'inactive' }))}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1.5 ${
                    drilldown.activeTab === 'inactive'
                      ? 'bg-red-600 text-white shadow-sm'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  <span>⚠️ Missing / Inactive Users</span>
                  <span className="px-1.5 py-0.2 bg-white/20 rounded-full text-[10px]">
                    {drilldown.engagementData?.inactive_users?.length || 0}
                  </span>
                </button>
              </div>

              <button
                type="button"
                onClick={() => {
                  const isAct = drilldown.activeTab === 'active';
                  const list = isAct ? (drilldown.engagementData?.active_users || []) : (drilldown.engagementData?.inactive_users || []);
                  exportCsv(
                    `daily_active_users_${drilldown.activeTab}_${weekStart}.csv`,
                    list.map(u => ({
                      'User ID': u.id,
                      'Name': u.name,
                      'Email': u.email,
                      'Department': u.department,
                      'Role': u.role,
                      'Designation': u.designation,
                      ...(isAct ? { 'Days Active Count': u.active_days_count, 'Days List': (u.active_days || []).join('; ') } : { 'Status': 'Zero qualifying actions this week' })
                    }))
                  );
                }}
                className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                title="Export list to CSV"
              >
                <FiDownload size={13} /> Export CSV
              </button>
            </div>

            <div className="overflow-x-auto max-h-[50vh] border rounded-lg">
              {drilldown.activeTab === 'active' ? (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase border-b sticky top-0">
                    <tr>
                      <th className="p-2 text-left">#</th>
                      <th className="p-2 text-left">Employee</th>
                      <th className="p-2 text-left">Department</th>
                      <th className="p-2 text-left">Designation</th>
                      <th className="p-2 text-center">Days Active</th>
                      <th className="p-2 text-left">Active Days (Mon–Sat)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {drilldown.engagementData?.active_users?.map((u, i) => (
                      <tr key={u.id} className="hover:bg-emerald-50/40">
                        <td className="p-2 font-bold text-gray-400">#{i + 1}</td>
                        <td className="p-2 font-semibold text-gray-900">{u.name}</td>
                        <td className="p-2 text-gray-600">{u.department}</td>
                        <td className="p-2 text-gray-600">{u.designation}</td>
                        <td className="p-2 text-center font-bold text-emerald-700">{u.active_days_count} day{u.active_days_count === 1 ? '' : 's'}</td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-1">
                            {u.active_days?.map(d => (
                              <span key={d} className="px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 text-[10px] font-mono">
                                {d.slice(5)}
                              </span>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <table className="w-full text-xs">
                  <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase border-b sticky top-0">
                    <tr>
                      <th className="p-2 text-left">#</th>
                      <th className="p-2 text-left">Employee</th>
                      <th className="p-2 text-left">Department</th>
                      <th className="p-2 text-left">Designation</th>
                      <th className="p-2 text-left">Email</th>
                      <th className="p-2 text-center">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {drilldown.engagementData?.inactive_users?.map((u, i) => (
                      <tr key={u.id} className="hover:bg-red-50/40">
                        <td className="p-2 font-bold text-gray-400">#{i + 1}</td>
                        <td className="p-2 font-semibold text-gray-900">{u.name}</td>
                        <td className="p-2 text-gray-600">{u.department}</td>
                        <td className="p-2 text-gray-600">{u.designation}</td>
                        <td className="p-2 text-gray-500">{u.email}</td>
                        <td className="p-2 text-center">
                          <span className="px-2 py-0.5 rounded bg-red-100 text-red-800 text-[10px] font-semibold">
                            0 Actions
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        ) : drilldown?.module === 'data_completeness' ? (
          // ─── Data Completeness Audit View ───
          <div className="space-y-4">
            {drilldown.completenessData?.per_field ? (
              <div>
                <div className="p-3 bg-indigo-50 border border-indigo-200 rounded-lg flex items-center justify-between text-xs text-indigo-900 mb-3">
                  <div>
                    <b>{drilldown.completenessData.label}</b> · {drilldown.completenessData.total_items} {drilldown.completenessData.noun} ({drilldown.completenessData.complete_items} 100% complete)
                  </div>
                  <div className="font-bold text-indigo-700">
                    {drilldown.completenessData.required_total ? Math.round((drilldown.completenessData.filled_total / drilldown.completenessData.required_total) * 100) : 0}% Filled
                  </div>
                </div>
                <div className="overflow-x-auto max-h-[55vh] border rounded-lg">
                  <table className="w-full text-xs">
                    <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase border-b sticky top-0">
                      <tr>
                        <th className="p-2 text-left">Mandatory Field</th>
                        <th className="p-2 text-center">Filled Records</th>
                        <th className="p-2 text-center">Missing / Incomplete</th>
                        <th className="p-2 text-left w-48">Completion Rate</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {drilldown.completenessData.per_field.map(f => {
                        const pct = drilldown.completenessData.total_items ? Math.round((f.filled / drilldown.completenessData.total_items) * 100) : 0;
                        return (
                          <tr key={f.key} className="hover:bg-gray-50">
                            <td className="p-2 font-semibold text-gray-800">{f.label}</td>
                            <td className="p-2 text-center font-bold text-emerald-700">{f.filled}</td>
                            <td className="p-2 text-center font-bold text-red-600">{f.missing}</td>
                            <td className="p-2">
                              <div className="flex items-center gap-2">
                                <div className="w-full bg-gray-200 rounded-full h-2 overflow-hidden">
                                  <div className={`h-2 rounded-full ${pct === 100 ? 'bg-emerald-500' : pct >= 70 ? 'bg-blue-500' : 'bg-amber-500'}`} style={{ width: `${pct}%` }}></div>
                                </div>
                                <span className="text-[10px] font-bold text-gray-600 w-9 text-right">{pct}%</span>
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : drilldown.completenessData?.modules ? (
              <div className="space-y-3">
                {drilldown.completenessData.modules.map(mod => (
                  <div key={mod.module} className="border rounded-lg p-3 bg-white">
                    <div className="flex items-center justify-between text-xs font-bold mb-2">
                      <span className="text-gray-900">{mod.label}</span>
                      <span className="text-indigo-600">{mod.required_total ? Math.round((mod.filled_total / mod.required_total) * 100) : 0}% ({mod.filled_total} / {mod.required_total} fields)</span>
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                      {mod.per_field?.map(f => (
                        <div key={f.key} className="bg-gray-50 p-1.5 rounded border flex justify-between">
                          <span className="text-gray-600 truncate">{f.label}</span>
                          <span className={f.missing > 0 ? 'text-amber-700 font-bold' : 'text-emerald-700 font-bold'}>{f.filled}/{mod.total_items}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="p-4 text-center text-gray-500">No completion data available.</div>
            )}
          </div>
        ) : !drilldown?.rows?.length ? (
          // ─── Task Modules Empty State ───
          <div className="p-8 text-center text-sm text-gray-400">
            No tasks found in this category.
          </div>
        ) : (
          // ─── Task Modules List ───
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs text-gray-500 font-medium px-1">
              <span>Showing <b>{drilldown.rows.length}</b> task{drilldown.rows.length === 1 ? '' : 's'}:</span>
              <button
                type="button"
                onClick={() => {
                  exportCsv(
                    `tasks_${drilldown.module}_${drilldown.type}_${weekStart}.csv`,
                    drilldown.rows.map(r => ({
                      'Task ID': drilldown.module === 'pms' ? `PMS-${String(r.id).padStart(4, '0')}` : drilldown.module === 'tickets' ? (r.ticket_no || `TSK-${String(r.id).padStart(4, '0')}`) : `TSK-${String(r.id).padStart(4, '0')}`,
                      'Description': r.description || r.title || r.subject || '',
                      'Project': r.project_name || '',
                      'Assigned By': r.assigned_by_name || r.raised_by_name || '',
                      'Due Date': r.due_date || r.deadline_date || '',
                      [drilldown.module === 'tickets' ? 'Resolved At' : 'Approved At']: (r.reviewed_at || r.resolved_at) ? (r.reviewed_at || r.resolved_at).slice(0, 10) : '',
                      'Status': r.status,
                    }))
                  );
                }}
                className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
                title="Export list to CSV"
              >
                <FiDownload size={13} /> Export CSV
              </button>
            </div>
            <div className="overflow-x-auto max-h-[60vh] border rounded-lg">
              <table className="w-full text-xs">
                <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase border-b sticky top-0">
                  <tr>
                    <th className="p-2 text-left w-20">Task ID</th>
                    <th className="p-2 text-left">Description</th>
                    {drilldown.module === 'pms' && <th className="p-2 text-left">Project</th>}
                    <th className="p-2 text-left">Assigned By</th>
                    <th className="p-2 text-center w-24">Due Date</th>
                    <th className="p-2 text-center w-24">{drilldown.module === 'tickets' ? 'Resolved At' : 'Approved At'}</th>
                    <th className="p-2 text-center w-20">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {drilldown.rows.map(row => (
                    <tr key={row.id} className="hover:bg-blue-50/40">
                      <td className="p-2 font-mono font-bold text-red-700">
                        <a
                          href={
                            drilldown.module === 'pms'
                              ? `/pms-tasks?open=${row.id}`
                              : drilldown.module === 'tickets'
                              ? `/help-tickets?open=${row.id}`
                              : `/delegations?open=${row.id}`
                          }
                          target="_blank"
                          rel="noreferrer"
                          className="hover:underline flex items-center gap-1"
                          title="Open task in new tab"
                        >
                          {drilldown.module === 'pms' ? `PMS-${String(row.id).padStart(4, '0')}` : drilldown.module === 'tickets' ? (row.ticket_no || `TSK-${String(row.id).padStart(4, '0')}`) : `TSK-${String(row.id).padStart(4, '0')}`}
                        </a>
                      </td>
                      <td className="p-2 text-gray-800 whitespace-pre-wrap max-w-sm">{row.description || row.title || row.subject || '—'}</td>
                      {drilldown.module === 'pms' && <td className="p-2 text-gray-600">{row.project_name || '—'}</td>}
                      <td className="p-2 text-gray-600">{row.assigned_by_name || row.raised_by_name || '—'}</td>
                      <td className="p-2 text-center text-gray-600">{row.due_date || row.deadline_date || '—'}</td>
                      <td className="p-2 text-center text-gray-600">{(row.reviewed_at || row.resolved_at) ? (row.reviewed_at || row.resolved_at).slice(0, 10) : '—'}</td>
                      <td className="p-2 text-center">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${
                          ['approved', 'resolved', 'closed'].includes(row.status) ? 'bg-emerald-100 text-emerald-800' :
                          row.status === 'submitted' ? 'bg-blue-100 text-blue-800' :
                          row.status === 'rejected' ? 'bg-red-100 text-red-800' : 'bg-amber-100 text-amber-800'
                        }`}>
                          {row.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </Modal>

      {/* Metric Explainer Modal (ℹ️ button) */}
      <MetricExplainerModal kpi={explainingKpi} onClose={() => setExplainingKpi(null)} />
    </div>
  );
}

// ---------- Weekly Commitment panel ----------
// mam (2026-07-06): "separate box for writing the commitment (0 to −50%) for
// the coming week; always show last week's committed target in its own box;
// then a committed-vs-actual graph that gives the emotional angle so the
// employee sees the gap."  All three live here.  The committed % uses the same
// variance-vs-plan convention the rest of the page shows (0 = on plan).
function CommitTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0].payload;
  const gap = row.gap;
  return (
    <div className="bg-white border rounded shadow px-3 py-2 text-xs">
      <div className="font-semibold mb-1">Week of {label}</div>
      <div>Committed: <b className={varClr(row.committed)}>{fmtVar(row.committed)}</b></div>
      <div>Delivered: <b className={varClr(row.actual)}>{fmtVar(row.actual)}</b></div>
      {gap != null && (
        <div className={gap >= 0 ? 'text-emerald-700 mt-0.5' : 'text-red-700 mt-0.5'}>
          {gap >= 0 ? `Met the promise (+${gap}%)` : `Gap of ${gap}% to close`}
        </div>
      )}
    </div>
  );
}

function CommitWorkTooltip({ active, payload, label, mode = 'cumulative' }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const isCum = mode === 'cumulative';
  const planVal = isCum ? (row.cum_planned != null ? row.cum_planned : row.total_planned) : row.total_planned;
  const actVal = isCum ? (row.cum_actual != null ? row.cum_actual : row.total_actual) : row.total_actual;
  const gapVal = Math.round((planVal - actVal) * 10) / 10;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg px-3 py-2.5 text-xs space-y-1.5 max-w-xs">
      <div className="font-bold text-gray-900 border-b border-gray-100 pb-1 flex items-center justify-between">
        <span>Week of {label}</span>
        {isCum && <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">Cumulative S-Curve</span>}
      </div>
      <div className="flex items-center justify-between gap-3 text-indigo-700">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block"></span>
          <b>Committed Work (Plan):</b>
        </span>
        <b className="font-bold text-indigo-900">{fmtFullNumber(planVal)} units {planVal >= 100000 ? `(${fmtCompact(planVal)})` : ''}</b>
      </div>
      <div className="flex items-center justify-between gap-3 text-gray-800">
        <span className="flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: actVal >= planVal && planVal > 0 ? '#10b981' : '#e11d48' }}></span>
          <b>Done Work (Delivered):</b>
        </span>
        <b className={`font-bold ${actVal >= planVal && planVal > 0 ? 'text-emerald-700' : 'text-rose-700'}`}>{fmtFullNumber(actVal)} units {actVal >= 100000 ? `(${fmtCompact(actVal)})` : ''}</b>
      </div>
      {row.work_achievement_pct != null && (
        <div className="flex items-center justify-between gap-3 text-gray-500 border-t border-gray-100 pt-1 text-[11px]">
          <span>Weekly Execution Rate:</span>
          <b>{row.work_achievement_pct}%</b>
        </div>
      )}
      <div className={`text-[11px] font-bold pt-1 border-t border-gray-100 flex items-center gap-1 ${gapVal > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
        <span className="text-sm font-black">↕</span>
        {gapVal > 0 ? `Work Gap (Shortfall): ${fmtFullNumber(gapVal)} units (${fmtCompact(gapVal)})` : `Target Met (+${fmtFullNumber(Math.abs(gapVal))} units surplus)`}
      </div>
    </div>
  );
}

function CommitmentPanel({ viewUserId, weekStart }) {
  const { user, isAdmin } = useAuth();
  const readOnly = viewUserId !== user.id && !isAdmin();
  const [data, setData] = useState(null);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Mam 2026-08-17: graph range — 8 weeks (default, fast) or the last 6 months.
  const [range, setRange] = useState(8);
  // View mode: 'units' (Work Units: Committed vs Done) or 'variance' (Score Variance %)
  const [graphMode, setGraphMode] = useState('units');
  // Trajectory view: 'cumulative' (S-curve gap matching Sir's drawing) or 'weekly'
  const [trajectoryView, setTrajectoryView] = useState('cumulative');

  const load = useCallback(() => {
    api.get(`/scoring/commitments?user_id=${viewUserId}&week_start=${weekStart}&weeks=${range}`)
      .then(r => { setData(r.data); setDraft(r.data?.next?.committed_pct ?? ''); })
      .catch(() => setData(null));
  }, [viewUserId, weekStart, range]);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    const raw = String(draft).trim();
    const v = raw === '' ? null : Number(raw);
    if (v !== null && (!Number.isFinite(v) || v < -50 || v > 0)) {
      toast.error('Commitment must be between 0% and −50%');
      return;
    }
    setSaving(true);
    try {
      await api.put('/scoring/commitment', { user_id: viewUserId, week_start: data.next_week_start, committed_pct: v });
      toast.success(v === null ? 'Commitment cleared' : 'Commitment saved');
      load();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Save failed');
    } finally { setSaving(false); }
  };

  if (!data) return null;
  const current = data.current?.committed_pct ?? null;   // promise made for the viewed week
  const series = data.weeks || [];
  const actualThisWeek = series.length ? series[series.length - 1].actual_pct : null;
  const gapThisWeek = (current != null && actualThisWeek != null)
    ? Math.round((actualThisWeek - current) * 100) / 100 : null;

  const currentWeekWork = series.length ? series[series.length - 1] : null;

  // Chart data for percentage variance
  const chartVariance = series.map(w => ({
    label: fmtShort(w.week_start),
    committed: w.committed_pct,
    actual: w.actual_pct,
    gap: (w.committed_pct != null && w.actual_pct != null)
      ? Math.round((w.actual_pct - w.committed_pct) * 100) / 100 : null,
  }));
  const valsVariance = chartVariance.flatMap(r => [r.committed, r.actual]).filter(v => v != null);
  const lo = Math.floor(Math.min(-55, 0, ...valsVariance) / 5) * 5;
  const hi = Math.ceil(Math.max(10, 0, ...valsVariance) / 5) * 5;

  // Chart data for work units (Committed Work vs Done Work)
  let cumPlan = 0;
  let cumAct = 0;
  const chartUnits = series.map(w => {
    const p = Number(w.total_planned || 0);
    const a = Number(w.total_actual || 0);
    cumPlan += p;
    cumAct += a;
    return {
      label: fmtShort(w.week_start),
      week_start: w.week_start,
      total_planned: p,
      total_actual: a,
      work_gap: w.gap != null ? w.gap : Math.round((a - p) * 10) / 10,
      work_achievement_pct: w.work_achievement_pct,
      cum_planned: Math.round(cumPlan * 10) / 10,
      cum_actual: Math.round(cumAct * 10) / 10,
      cum_gap: Math.round((cumPlan - cumAct) * 10) / 10,
    };
  });
  const maxWorkUnit = Math.max(10, ...chartUnits.flatMap(r => [r.total_planned, r.total_actual]));
  const yMaxUnits = Math.ceil((maxWorkUnit * 1.15) / 5) * 5;

  const maxCumUnit = Math.max(10, ...chartUnits.flatMap(r => [r.cum_planned, r.cum_actual]));
  const yMaxCumUnits = Math.ceil((maxCumUnit * 1.15) / 5) * 5;

  const latestCum = chartUnits.length ? chartUnits[chartUnits.length - 1] : null;
  const latestCumGap = latestCum ? latestCum.cum_gap : 0;

  // Green when the bar meets/beats the promise line, red when it falls short.
  const barColorVariance = (r) => {
    if (r.actual == null) return '#e5e7eb';
    if (r.committed != null) return r.actual >= r.committed ? '#10b981' : '#ef4444';
    return r.actual >= 0 ? '#10b981' : r.actual >= -50 ? '#f59e0b' : '#ef4444';
  };

  const hasDataVariance = valsVariance.length > 0;
  const hasDataUnits = chartUnits.some(r => r.total_planned > 0 || r.total_actual > 0);

  return (
    <div className="card p-4 space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2">
        <div className="flex items-center gap-2">
          <FiTarget className="text-indigo-600" />
          <h3 className="font-bold text-sm">Weekly Commitment &amp; Work Execution</h3>
        </div>

        {/* Graph Mode Selector */}
        <div className="flex items-center gap-1 bg-gray-100 p-0.5 rounded-lg text-xs">
          <button
            type="button"
            onClick={() => setGraphMode('units')}
            className={`px-2.5 py-1 rounded font-semibold transition ${graphMode === 'units' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            Work Units (Committed vs Done)
          </button>
          <button
            type="button"
            onClick={() => setGraphMode('variance')}
            className={`px-2.5 py-1 rounded font-semibold transition ${graphMode === 'variance' ? 'bg-white text-indigo-700 shadow-sm' : 'text-gray-600 hover:text-gray-900'}`}
          >
            Score Variance %
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Box A — last week's committed target for THIS week (read-only) */}
        <div className="rounded-lg border bg-gradient-to-br from-slate-50 to-white p-4">
          <p className="text-xs text-gray-500">Committed target — this week</p>
          <p className="text-[11px] text-gray-400 mb-1">{fmtRange(weekStart)} · set last week</p>
          {current == null
            ? <p className="text-2xl font-bold text-gray-300">Not committed</p>
            : <p className={`text-3xl font-bold ${varClr(current)}`}>{fmtVar(current)}</p>}
          {gapThisWeek != null && (
            <p className="text-[11px] mt-1 text-gray-600">
              Delivered <b className={varClr(actualThisWeek)}>{fmtVar(actualThisWeek)}</b> ·{' '}
              {gapThisWeek >= 0
                ? <span className="text-emerald-700 font-semibold">met the promise (+{gapThisWeek}%)</span>
                : <span className="text-red-700 font-semibold">gap of {gapThisWeek}%</span>}
            </p>
          )}
          {currentWeekWork && (currentWeekWork.total_planned > 0 || currentWeekWork.total_actual > 0) && (
            <div className="mt-2 pt-2 border-t border-gray-100 flex items-center justify-between text-xs text-gray-600">
              <span>Work Execution:</span>
              <span>
                <b>{fmtFullNumber(currentWeekWork.total_actual)}</b> done / <b>{fmtFullNumber(currentWeekWork.total_planned)}</b> {currentWeekWork.total_planned >= 100000 ? `(${fmtCompact(currentWeekWork.total_planned)}) ` : ''}committed
              </span>
            </div>
          )}
        </div>

        {/* Box B — commit for the coming week (editable, 0 … −50) */}
        <div className="rounded-lg border border-indigo-200 bg-indigo-50/40 p-4">
          <p className="text-xs text-indigo-800 font-semibold">My commitment for next week</p>
          <p className="text-[11px] text-gray-500 mb-2">{fmtRange(data.next_week_start)}</p>
          <div className="flex items-center gap-2">
            <input
              type="number" min={-50} max={0} step={5}
              className="input w-28 text-lg font-bold text-center"
              placeholder="0 … −50" value={draft}
              onChange={e => setDraft(e.target.value)} disabled={readOnly || saving}
            />
            <span className="text-gray-500 text-sm">%</span>
            {!readOnly && (
              <button onClick={save} disabled={saving} className="btn btn-primary text-sm flex items-center gap-1">
                <FiSave size={14} /> {saving ? 'Saving…' : 'Commit'}
              </button>
            )}
          </div>
          <p className="text-[10px] text-gray-400 mt-1.5">0% = you&apos;ll fully hit plan · −50% = the worst you&apos;ll allow. You can&apos;t commit below −50%.</p>
        </div>
      </div>

      {/* Graph Section with Range Buttons */}
      <div>
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-xs font-semibold text-gray-700">
              {graphMode === 'units' ? 'Work Done vs Committed Trajectory' : 'Commitment vs Delivered Score %'}
            </span>
            {graphMode === 'units' && (
              <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded text-[11px]">
                <button
                  type="button"
                  onClick={() => setTrajectoryView('cumulative')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${trajectoryView === 'cumulative' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
                  title="Cumulative S-Curve showing Plan Line vs Done Line and the Gap"
                >
                  Cumulative S-Curve (Gap Graph)
                </button>
                <button
                  type="button"
                  onClick={() => setTrajectoryView('weekly')}
                  className={`px-2 py-0.5 rounded font-semibold transition ${trajectoryView === 'weekly' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
                  title="Weekly Trend View"
                >
                  Weekly Trend
                </button>
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {graphMode === 'units' && latestCum && (
              <div className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-bold border ${latestCumGap > 0 ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                <span className="text-sm font-black">↕ Gap:</span>
                <span>{fmtFullNumber(Math.abs(latestCumGap))} units ({fmtCompact(Math.abs(latestCumGap))} {latestCumGap > 0 ? 'Shortfall' : 'Surplus'})</span>
              </div>
            )}
            <div className="flex gap-1">
              <button onClick={() => setRange(8)}
                className={`text-[11px] px-2 py-1 rounded font-semibold ${range === 8 ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                8 Weeks
              </button>
              <button onClick={() => setRange(26)}
                className={`text-[11px] px-2 py-1 rounded font-semibold ${range === 26 ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'}`}>
                Last 6 Months
              </button>
            </div>
          </div>
        </div>

        {graphMode === 'units' ? (
          hasDataUnits ? (
            <ResponsiveContainer width="100%" height={270}>
              <ComposedChart data={chartUnits} margin={{ top: 12, right: 20, left: 16, bottom: 0 }}>
                <defs>
                  <linearGradient id="planGradPanel" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#6366f1" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="actGradPanel" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#475569' }} />
                <YAxis width={65} tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: '#64748b' }} domain={[0, trajectoryView === 'cumulative' ? yMaxCumUnits : yMaxUnits]} />
                <Tooltip content={<CommitWorkTooltip mode={trajectoryView} />} />
                <Legend wrapperStyle={{ fontSize: 11, paddingTop: '8px' }} />
                {trajectoryView === 'cumulative' ? (
                  <>
                    <Area
                      type="monotone"
                      dataKey="cum_planned"
                      name="Committed Work (Plan)"
                      stroke="#4f46e5"
                      strokeWidth={3}
                      fill="url(#planGradPanel)"
                      dot={{ r: 4, fill: '#4f46e5', stroke: '#fff', strokeWidth: 2 }}
                      activeDot={{ r: 6 }}
                    />
                    <Area
                      type="monotone"
                      dataKey="cum_actual"
                      name="Done Work (Delivered)"
                      stroke={latestCumGap > 0 ? '#e11d48' : '#10b981'}
                      strokeWidth={3}
                      fill="url(#actGradPanel)"
                      dot={{ r: 4, fill: latestCumGap > 0 ? '#e11d48' : '#10b981', stroke: '#fff', strokeWidth: 2 }}
                      activeDot={{ r: 6 }}
                    />
                  </>
                ) : (
                  <>
                    <Line
                      type="monotone"
                      dataKey="total_planned"
                      name="Committed Work (Plan)"
                      stroke="#4f46e5"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#4f46e5' }}
                    />
                    <Line
                      type="monotone"
                      dataKey="total_actual"
                      name="Done Work (Delivered)"
                      stroke="#10b981"
                      strokeWidth={2.5}
                      dot={{ r: 4, fill: '#10b981' }}
                    />
                  </>
                )}
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-gray-400 text-sm py-10 border border-dashed rounded">
              No work data recorded for these weeks yet. Once scoring KPIs are recorded, the committed vs done work chart displays here.
            </div>
          )
        ) : (
          hasDataVariance ? (
            <ResponsiveContainer width="100%" height={260}>
              <ComposedChart data={chartVariance} margin={{ top: 10, right: 12, left: 12, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#eef2f7" />
                <XAxis dataKey="label" tick={{ fontSize: 11 }} />
                <YAxis width={45} tick={{ fontSize: 11 }} domain={[lo, hi]} tickFormatter={v => `${v}%`} />
                <Tooltip content={<CommitTooltip />} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeWidth={1} ifOverflow="extendDomain" />
                <Bar dataKey="actual" name="Delivered" radius={[3, 3, 0, 0]} maxBarSize={40}>
                  {chartVariance.map((r, i) => <Cell key={i} fill={barColorVariance(r)} />)}
                </Bar>
                <Line type="monotone" dataKey="committed" name="Committed" stroke="#4f46e5"
                  strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3, fill: '#4f46e5' }} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
          ) : (
            <div className="text-center text-gray-400 text-sm py-10 border border-dashed rounded">
              No commitments yet. Set one for next week above — the gap graph fills in as the weeks go by.
            </div>
          )
        )}
        <p className="text-[11px] text-gray-500 text-center mt-1">
          {graphMode === 'units'
            ? <>Upper Line (Indigo) = <b>Committed Work (Plan)</b> · Lower Line ({latestCumGap > 0 ? <span className="text-rose-600 font-semibold">Rose</span> : <span className="text-emerald-600 font-semibold">Green</span>}) = <b>Done Work (Delivered)</b> · ↕ Shaded space between lines = <b>Work Gap</b>.</>
            : <>Dashed line = what you <b>committed</b>. Bars = what you <b>delivered</b>. <span className="text-red-600 font-semibold">Red bars fall short of your promise</span> — that&apos;s the gap to close.</>}
        </p>
      </div>
    </div>
  );
}

function WorkTrajectoryTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const isStart = row.shortName === 'Start';
  if (isStart) {
    return (
      <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-2.5 text-xs">
        <b className="text-gray-700">Starting Baseline (0 Units)</b>
      </div>
    );
  }
  const gap = row.cum_gap != null ? row.cum_gap : Math.round((row.cum_planned - row.cum_actual) * 10) / 10;
  return (
    <div className="bg-white border border-slate-200 rounded-lg shadow-lg p-3 text-xs max-w-xs space-y-1.5">
      <div className="font-bold text-gray-900 border-b pb-1 flex items-center justify-between">
        <span>{row.metric_name}</span>
        <span className="text-[10px] font-semibold text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded">Cumulative</span>
      </div>
      <div className="text-[11px] text-gray-500">Group: <span className="font-medium text-gray-700">{row.group_name}</span></div>
      <div className="flex justify-between py-0.5">
        <span className="text-indigo-700 font-medium flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full bg-indigo-600 inline-block"></span> Cumulative Plan:
        </span>
        <b className="font-bold text-indigo-900">
          {fmtFullNumber(row.cum_planned)} units {row.cum_planned >= 100000 ? `(${fmtCompact(row.cum_planned)}) ` : ''}
          <span className="text-[10px] text-gray-400 font-normal">({fmtFullNumber(row.planned)} this KPI)</span>
        </b>
      </div>
      <div className="flex justify-between py-0.5">
        <span className="text-gray-700 font-medium flex items-center gap-1.5">
          <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ backgroundColor: row.cum_actual >= row.cum_planned ? '#10b981' : '#e11d48' }}></span> Cumulative Done:
        </span>
        <b className={`font-bold ${row.cum_actual >= row.cum_planned ? 'text-emerald-700' : 'text-rose-700'}`}>
          {fmtFullNumber(row.cum_actual)} units {row.cum_actual >= 100000 ? `(${fmtCompact(row.cum_actual)}) ` : ''}
          <span className="text-[10px] text-gray-400 font-normal">({fmtFullNumber(row.actual)} this KPI)</span>
        </b>
      </div>
      <div className={`mt-1.5 pt-1.5 border-t text-[11px] font-bold flex items-center gap-1 ${gap > 0 ? 'text-rose-700' : 'text-emerald-700'}`}>
        <span className="text-sm font-black">↕</span>
        {gap > 0 ? `Cumulative Gap: ${fmtFullNumber(gap)} units (${fmtCompact(gap)} Shortfall)` : `Target Met (+${fmtFullNumber(Math.abs(gap))} units Surplus)`}
      </div>
    </div>
  );
}

function WorkMetricTooltip({ active, payload }) {
  if (!active || !payload || !payload.length) return null;
  const row = payload[0]?.payload;
  if (!row) return null;
  const gap = Math.round((Number(row.actual || 0) - Number(row.planned || 0)) * 10) / 10;
  return (
    <div className="bg-white border border-gray-200 rounded-lg shadow-lg p-3 text-xs max-w-xs space-y-1">
      <div className="font-bold text-gray-900 border-b pb-1">{row.metric_name}</div>
      <div className="text-[11px] text-gray-500">Group: <span className="font-medium text-gray-700">{row.group_name}</span></div>
      <div className="flex justify-between py-0.5">
        <span className="text-indigo-700 font-medium flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-indigo-600 inline-block"></span> Committed / Planned:
        </span>
        <b className="font-bold text-indigo-900">{fmtFullNumber(row.planned)} {row.planned >= 100000 ? `(${fmtCompact(row.planned)})` : ''}</b>
      </div>
      <div className="flex justify-between py-0.5">
        <span className="text-gray-700 font-medium flex items-center gap-1">
          <span className="w-2 h-2 rounded-full inline-block" style={{ backgroundColor: row.actual >= row.planned && row.planned > 0 ? '#10b981' : '#ef4444' }}></span> Done / Delivered:
        </span>
        <b className={`font-bold ${row.actual >= row.planned && row.planned > 0 ? 'text-emerald-700' : row.actual > 0 ? 'text-amber-700' : 'text-rose-700'}`}>{fmtFullNumber(row.actual)} {row.actual >= 100000 ? `(${fmtCompact(row.actual)})` : ''}</b>
      </div>
      <div className="flex justify-between py-0.5 border-t mt-1 pt-1">
        <span className="text-gray-500">Achievement:</span>
        <b className="font-semibold">{row.achievement_pct != null ? `${row.achievement_pct}%` : '—'}</b>
      </div>
      <div className={`mt-1.5 text-[11px] font-semibold flex items-center gap-1 ${gap >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
        {gap >= 0 ? `✅ Met Target (+${fmtFullNumber(gap)})` : `⚠️ Shortfall of ${fmtFullNumber(Math.abs(gap))} ${Math.abs(gap) >= 100000 ? `(${fmtCompact(gap)})` : ''}`}
      </div>
      {row.pending_uptodate ? (
        <div className="text-[10px] text-gray-400 mt-1 border-t pt-1">
          Backlog: {fmtFullNumber(row.pending_work || 0)} done / {fmtFullNumber(row.pending_uptodate)} pending
        </div>
      ) : null}
    </div>
  );
}

function WorkExecutionGraph({ kpis = [], weekStart, cardOwnerName }) {
  const [collapsed, setCollapsed] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState('all');
  const [metricFilter, setMetricFilter] = useState('all'); // 'all', 'tasks', 'amount'
  const [viewMode, setViewMode] = useState('trajectory'); // 'trajectory' (S-curve gap) or 'bars' (metric breakdown)

  const groups = useMemo(() => {
    const set = new Set();
    kpis.forEach(k => { if (k.group_name) set.add(k.group_name); });
    return Array.from(set);
  }, [kpis]);

  const { taskKpis, amountKpis } = useMemo(() => {
    const tasks = [];
    const amounts = [];
    kpis.forEach(k => {
      const isAmount = k.metric_type === 'amount' || Number(k.planned || 0) >= 100000;
      if (isAmount) amounts.push(k);
      else tasks.push(k);
    });
    return { taskKpis: tasks, amountKpis: amounts };
  }, [kpis]);

  const hasMixedTypes = taskKpis.length > 0 && amountKpis.length > 0;

  const filteredKpis = useMemo(() => {
    let list = kpis;
    if (selectedGroup !== 'all') {
      list = list.filter(k => k.group_name === selectedGroup);
    }
    if (metricFilter === 'tasks') {
      list = list.filter(k => !(k.metric_type === 'amount' || Number(k.planned || 0) >= 100000));
    } else if (metricFilter === 'amount') {
      list = list.filter(k => k.metric_type === 'amount' || Number(k.planned || 0) >= 100000);
    }
    return list;
  }, [kpis, selectedGroup, metricFilter]);

  const summary = useMemo(() => {
    let totPlanned = 0;
    let totActual = 0;
    let targetsHit = 0;
    let targetsTotal = 0;

    filteredKpis.forEach(k => {
      const p = Number(k.planned || 0);
      const a = Number(k.actual || 0);
      totPlanned += p;
      totActual += a;
      if (p > 0) {
        targetsTotal++;
        if (a >= p) targetsHit++;
      }
    });

    const completionRate = totPlanned > 0
      ? Math.round((totActual / totPlanned) * 100)
      : (totActual > 0 ? 100 : 0);

    return {
      totPlanned: Math.round(totPlanned * 10) / 10,
      totActual: Math.round(totActual * 10) / 10,
      gap: Math.round((totActual - totPlanned) * 10) / 10,
      completionRate,
      targetsHit,
      targetsTotal,
    };
  }, [filteredKpis]);

  const chartData = useMemo(() => {
    let cumPlan = 0;
    let cumAct = 0;
    return filteredKpis.map((k, idx) => {
      const p = Number(k.planned || 0);
      const a = Number(k.actual || 0);
      cumPlan += p;
      cumAct += a;
      const rawPct = p > 0 ? Math.round((a / p) * 100) : (a > 0 ? 100 : 0);
      const short = (k.metric_name || '').length > 20
        ? (k.metric_name || '').slice(0, 18) + '…'
        : k.metric_name;
      return {
        step: idx + 1,
        metric_name: k.metric_name,
        shortName: short,
        group_name: k.group_name || 'Other',
        planned: p,
        actual: a,
        cum_planned: Math.round(cumPlan * 10) / 10,
        cum_actual: Math.round(cumAct * 10) / 10,
        cum_gap: Math.round((cumPlan - cumAct) * 10) / 10,
        gap: Math.round((a - p) * 10) / 10,
        achievement_pct: rawPct,
        pending_uptodate: k.pending_uptodate,
        pending_work: k.pending_work,
      };
    });
  }, [filteredKpis]);

  const trajectoryData = useMemo(() => {
    if (!chartData.length) return [];
    return [
      { step: 0, shortName: 'Start', metric_name: 'Starting Baseline', cum_planned: 0, cum_actual: 0, cum_gap: 0 },
      ...chartData,
    ];
  }, [chartData]);

  if (!kpis.length) return null;

  const unitLabel = metricFilter === 'amount' ? '₹' : 'units';

  return (
    <div className="card p-4 space-y-3 border border-indigo-100 shadow-sm bg-gradient-to-br from-white to-slate-50/50">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-3">
        <div className="flex items-center gap-2">
          <div className="p-1.5 bg-indigo-50 text-indigo-600 rounded-lg">
            <FiBarChart2 size={18} />
          </div>
          <div>
            <h3 className="font-bold text-sm text-gray-800 flex items-center gap-2">
              Work Execution Graph
              <span className="text-xs px-2 py-0.5 rounded-full bg-indigo-100 text-indigo-700 font-semibold">
                Committed vs Done Work
              </span>
            </h3>
            <p className="text-[11px] text-gray-500">
              Trajectory showing what was committed/planned vs what was actually delivered for {fmtRange(weekStart)}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded text-xs">
            <button
              type="button"
              onClick={() => setViewMode('trajectory')}
              className={`px-2.5 py-1 rounded font-semibold transition ${viewMode === 'trajectory' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
              title="Trajectory S-Curve with visual Gap (Sir's layout)"
            >
              Trajectory &amp; Gap
            </button>
            <button
              type="button"
              onClick={() => setViewMode('bars')}
              className={`px-2.5 py-1 rounded font-semibold transition ${viewMode === 'bars' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
              title="Metric Breakdown Bars"
            >
              Metric Bars
            </button>
          </div>

          {hasMixedTypes && (
            <div className="flex items-center gap-1 bg-slate-100 p-0.5 rounded text-xs">
              <button
                type="button"
                onClick={() => setMetricFilter('all')}
                className={`px-2 py-1 rounded font-semibold transition ${metricFilter === 'all' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
                title="All metrics combined"
              >
                All ({kpis.length})
              </button>
              <button
                type="button"
                onClick={() => setMetricFilter('tasks')}
                className={`px-2 py-1 rounded font-semibold transition ${metricFilter === 'tasks' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
                title="Task & activity metrics only (excludes ₹ Lakhs currency targets)"
              >
                Tasks ({taskKpis.length})
              </button>
              <button
                type="button"
                onClick={() => setMetricFilter('amount')}
                className={`px-2 py-1 rounded font-semibold transition ${metricFilter === 'amount' ? 'bg-white text-indigo-700 shadow-xs' : 'text-gray-500 hover:text-gray-900'}`}
                title="Financial & revenue amount targets"
              >
                Revenue ({amountKpis.length})
              </button>
            </div>
          )}

          {groups.length > 1 && (
            <div className="flex items-center gap-1 text-xs">
              <span className="text-gray-400">Group:</span>
              <select
                className="input text-xs py-1 px-2 h-7"
                value={selectedGroup}
                onChange={e => setSelectedGroup(e.target.value)}
              >
                <option value="all">All Groups ({filteredKpis.length})</option>
                {groups.map(g => (
                  <option key={g} value={g}>{g}</option>
                ))}
              </select>
            </div>
          )}
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className="btn btn-secondary text-xs py-1 px-2.5 flex items-center gap-1"
          >
            {collapsed ? <><FiChevronDown size={14} /> Show Graph</> : <><FiChevronUp size={14} /> Hide Graph</>}
          </button>
        </div>
      </div>

      {hasMixedTypes && metricFilter === 'all' && (
        <div className="flex items-center justify-between text-xs bg-amber-50 border border-amber-200 rounded px-2.5 py-1.5 text-amber-900 flex-wrap gap-2">
          <span>
            💡 <b>Note on Scale:</b> Revenue targets (e.g. ₹{fmtCompact(amountKpis[0]?.planned || 2000000)}) are mixed with count tasks.
          </span>
          <button
            type="button"
            onClick={() => setMetricFilter('tasks')}
            className="text-indigo-700 underline font-bold hover:text-indigo-900 cursor-pointer"
          >
            View pure Tasks trajectory ({taskKpis.length} tasks) →
          </button>
        </div>
      )}

      {/* Summary KPI Badges */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
        <div className="rounded-lg bg-indigo-50/70 border border-indigo-100 p-2.5">
          <p className="text-[10px] uppercase font-semibold text-indigo-800 tracking-wider">Committed Work (Plan)</p>
          <p className="text-xl font-bold text-indigo-900 mt-0.5">
            {fmtFullNumber(summary.totPlanned)} <span className="text-xs font-normal text-indigo-600">{unitLabel}</span>
            {summary.totPlanned >= 100000 && <span className="text-xs font-semibold text-indigo-500 block">({fmtCompact(summary.totPlanned)})</span>}
          </p>
        </div>
        <div className="rounded-lg bg-emerald-50/70 border border-emerald-100 p-2.5">
          <p className="text-[10px] uppercase font-semibold text-emerald-800 tracking-wider">Done Work (Delivered)</p>
          <p className="text-xl font-bold text-emerald-900 mt-0.5">
            {fmtFullNumber(summary.totActual)} <span className="text-xs font-normal text-emerald-600">{unitLabel}</span>
            {summary.totActual >= 100000 && <span className="text-xs font-semibold text-emerald-500 block">({fmtCompact(summary.totActual)})</span>}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
          <p className="text-[10px] uppercase font-semibold text-gray-500 tracking-wider">Work Gap</p>
          <p className={`text-xl font-bold mt-0.5 ${summary.gap >= 0 ? 'text-emerald-700' : 'text-rose-600'}`}>
            {summary.gap >= 0 ? `+${fmtFullNumber(summary.gap)}` : `-${fmtFullNumber(Math.abs(summary.gap))}`} <span className="text-xs font-normal text-gray-500">{unitLabel}</span>
            {Math.abs(summary.gap) >= 100000 && <span className="text-xs font-semibold text-rose-500 block">({fmtCompact(summary.gap)})</span>}
          </p>
        </div>
        <div className="rounded-lg bg-slate-50 border border-slate-200 p-2.5">
          <p className="text-[10px] uppercase font-semibold text-gray-500 tracking-wider">Execution Rate</p>
          <p className={`text-xl font-bold mt-0.5 ${summary.completionRate >= 100 ? 'text-emerald-700' : summary.completionRate >= 80 ? 'text-indigo-600' : 'text-amber-600'}`}>
            {summary.completionRate}%
            {summary.targetsTotal > 0 && (
              <span className="text-[10px] font-normal text-gray-500 block">
                {summary.targetsHit}/{summary.targetsTotal} targets met
              </span>
            )}
          </p>
        </div>
      </div>

      {!collapsed && (
        <div className="mt-3">
          {viewMode === 'trajectory' ? (
            <div>
              <div className="flex items-center justify-between text-xs text-gray-600 mb-2 px-1 flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-gray-800">Trajectory S-Curve:</span>
                  <span className="text-gray-500">Committed Plan (Top Line) vs Delivered Actual (Bottom Line)</span>
                </div>
                <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full text-xs font-bold border shadow-xs ${summary.gap < 0 ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'}`}>
                  <span className="text-sm font-black">↕ Gap:</span>
                  <span>{fmtFullNumber(Math.abs(summary.gap))} {unitLabel} ({fmtCompact(Math.abs(summary.gap))} {summary.gap < 0 ? 'Shortfall' : 'Surplus'})</span>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={Math.max(280, Math.min(380, trajectoryData.length * 24 + 140))}>
                <ComposedChart data={trajectoryData} margin={{ top: 12, right: 24, left: 16, bottom: 45 }}>
                  <defs>
                    <linearGradient id="planGradExec" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#6366f1" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#6366f1" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="actGradExec" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="shortName"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    interval={0}
                    angle={-25}
                    textAnchor="end"
                    height={55}
                  />
                  <YAxis width={65} tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
                  <Tooltip content={<WorkTrajectoryTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: '10px' }} />
                  <Area
                    type="monotone"
                    dataKey="cum_planned"
                    name="Committed Work (Plan)"
                    stroke="#4f46e5"
                    strokeWidth={3}
                    fill="url(#planGradExec)"
                    dot={{ r: 4, fill: '#4f46e5', stroke: '#fff', strokeWidth: 2 }}
                    activeDot={{ r: 6 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="cum_actual"
                    name="Done Work (Delivered)"
                    stroke={summary.gap < 0 ? '#e11d48' : '#10b981'}
                    strokeWidth={3}
                    fill="url(#actGradExec)"
                    dot={{ r: 4, fill: summary.gap < 0 ? '#e11d48' : '#10b981', stroke: '#fff', strokeWidth: 2 }}
                    activeDot={{ r: 6 }}
                  />
                </ComposedChart>
              </ResponsiveContainer>
              <div className="mt-2 p-2 bg-slate-50 border rounded text-[11px] text-gray-500 flex flex-wrap items-center justify-between gap-2">
                <span>
                  Top Line (Indigo) = <b>Committed Work (Plan)</b> · Bottom Line ({summary.gap < 0 ? <span className="text-rose-600 font-semibold">Rose</span> : <span className="text-emerald-600 font-semibold">Green</span>}) = <b>Done Work (Delivered)</b>
                </span>
                <span className="font-semibold text-gray-700">
                  ↕ Vertical area between lines represents the <b>Work Gap</b> (Shortfall to close).
                </span>
              </div>
            </div>
          ) : (
            <div>
              <div className="flex items-center justify-between text-xs text-gray-500 mb-2 px-1">
                <span className="text-[11px]">
                  Comparing <b>{chartData.length}</b> metric{chartData.length === 1 ? '' : 's'}:
                </span>
                <div className="flex items-center gap-3 text-[11px]">
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-indigo-600 inline-block"></span>
                    <b>Committed Work</b>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500 inline-block"></span>
                    <b>Done Work (Met/Exceeded)</b>
                  </span>
                  <span className="flex items-center gap-1">
                    <span className="w-2.5 h-2.5 rounded-sm bg-rose-500 inline-block"></span>
                    <b>Done Work (Shortfall)</b>
                  </span>
                </div>
              </div>

              <ResponsiveContainer width="100%" height={Math.max(280, Math.min(420, chartData.length * 28 + 120))}>
                <ComposedChart data={chartData} margin={{ top: 12, right: 20, left: 16, bottom: 50 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis
                    dataKey="shortName"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    interval={0}
                    angle={-25}
                    textAnchor="end"
                    height={60}
                  />
                  <YAxis width={65} tickFormatter={fmtCompact} tick={{ fontSize: 11, fill: '#64748b' }} allowDecimals={false} />
                  <Tooltip content={<WorkMetricTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11, paddingTop: '10px' }} />
                  <Bar dataKey="planned" name="Committed Work (Plan)" fill="#6366f1" radius={[3, 3, 0, 0]} maxBarSize={36} />
                  <Bar dataKey="actual" name="Done Work (Delivered)" radius={[3, 3, 0, 0]} maxBarSize={36}>
                    {chartData.map((r, i) => {
                      const fill = (r.planned > 0 && r.actual >= r.planned)
                        ? '#10b981'
                        : (r.actual === 0 && r.planned > 0)
                          ? '#ef4444'
                          : (r.actual < r.planned)
                            ? '#f59e0b'
                            : '#3b82f6';
                      return <Cell key={i} fill={fill} />;
                    })}
                  </Bar>
                </ComposedChart>
              </ResponsiveContainer>
              <p className="text-[11px] text-gray-400 text-center mt-1">
                Blue bars = what was <b>Committed / Planned</b>. Colored bars = what was <b>Actually Done</b> (<span className="text-emerald-600 font-semibold">Green = Achieved</span>, <span className="text-amber-600 font-semibold">Amber = Partial</span>, <span className="text-rose-600 font-semibold">Red = Zero</span>).
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------- RACI step-wise breakdown (drill-down of the RACI Steps row) ----------
// Editable "for next week" commitment per step — saves in place to the module
// default (record_id 0) so it sticks for that module/step (mam 2026-06-29:
// "commitment should be editable"). Touches only commitment, never R/A/C/I/SLA.
function CommitmentCell({ row }) {
  const [val, setVal] = useState(row.commitment ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const next = (val || '').trim();
    if (next === (row.commitment || '')) return;     // unchanged — skip
    setSaving(true);
    try {
      await api.put(`/raci/step-commitment/${row.module}/0`, { step_key: row.step_key, commitment: next });
      row.commitment = next;                          // keep the row's data in sync
    } catch { toast.error('Failed to save commitment'); setVal(row.commitment ?? ''); }
    finally { setSaving(false); }
  };
  return (
    <input type="text" className={`input text-xs w-full ${saving ? 'bg-amber-50' : ''}`}
      placeholder="for next week…" value={val}
      onChange={e => setVal(e.target.value)} onBlur={save} />
  );
}

function RaciBreakdown({ data }) {
  if (!data || data.loading) return <p className="text-sm text-gray-500 p-4">Loading…</p>;
  const rows = data.rows || [];
  if (!rows.length) return <p className="text-sm text-gray-500 p-4">No RACI steps on this person for this week.</p>;
  // Group the per-step rows under their module heading.
  const byMod = rows.reduce((a, r) => { (a[r.module_label] = a[r.module_label] || []).push(r); return a; }, {});
  // Actual % per the scorecard's higher-better rule: (done − planned)/planned, floored at −100.
  const pct = (done, planned) => { if (!planned) return 0; const p = Math.round(((done - planned) / planned) * 100); return p < -100 ? -100 : p; };
  const pctClr = (p) => p >= 0 ? 'text-emerald-700' : p >= -50 ? 'text-amber-700' : 'text-red-700';
  const overall = pct(data.totals.actual, data.totals.planned);
  // Overall %. Weighting is only applied when EVERY step carries a weight.
  //
  // It used to be Σ(weight × stepPct)/Σ(weight) over just the weighted rows,
  // which silently dropped every step that had no weight set — so a step with
  // 97 pending at −100% vanished from the headline and the person read −50%
  // instead of −99% (mam 2026-08-22). A step must never be able to hide from
  // the score just because nobody typed a weight on it, so when any step is
  // unweighted we fall back to the plain all-step figure, which is exactly the
  // planned/done totals shown next to it.
  const wRows = rows.filter(r => +r.weight > 0);
  const hasW = wRows.length > 0 && wRows.length === rows.length;
  const weightedOverall = hasW
    ? Math.round(wRows.reduce((s, r) => s + (+r.weight) * pct(r.actual, r.planned), 0) / wRows.reduce((s, r) => s + (+r.weight), 0))
    : overall;
  return (
    <div className="space-y-4">
      <div className="text-sm text-gray-600">
        Week {data.week_start} → {data.week_end} · <b>{data.totals.planned}</b> planned ·{' '}
        <b className="text-emerald-700">{data.totals.actual}</b> done ·{' '}
        <b className="text-amber-700">{data.totals.pending}</b> pending
        {data.totals.prev_done > 0 && <> · <b className="text-emerald-700">{data.totals.prev_done}</b> prev done</>} ·{' '}
        <b className={pctClr(weightedOverall)}>{weightedOverall}%</b>{hasW && <span className="text-[10px] text-gray-400"> (weighted)</span>}
      </div>
      {Object.entries(byMod).map(([mod, list]) => (
        <div key={mod} className="border rounded overflow-hidden">
          <div className="px-3 py-1.5 bg-amber-50 border-b border-amber-200 font-semibold text-amber-800 text-sm">{mod}</div>
          <NumberedTable className="w-full text-xs">
            <thead className="bg-gray-50 text-[10px] text-gray-500 uppercase">
              <tr>
                <th className="text-left p-2">Step</th>
                <th className="text-center p-2 w-14">Wt %</th>
                <th className="text-center p-2 w-20">Planned</th>
                <th className="text-center p-2 w-16">Done</th>
                <th className="text-center p-2 w-16">Pending</th>
                <th className="text-center p-2 w-20">Actual %</th>
                <th className="text-center p-2 w-20">On-time</th>
                <th className="text-left p-2">Commitment (next wk)</th>
              </tr>
            </thead>
            <tbody>
              {list.map(r => (
                <tr key={r.step_key} className="border-t">
                  <td className="p-2 font-medium">
                    {r.step_label}
                    {/* R = Responsible, A = Accountable (mam 2026-08-28:
                        accountable steps show on the card too) */}
                    {r.role && r.role !== 'R' && (
                      <span className="ml-1.5 px-1 py-0.5 bg-purple-100 text-purple-700 rounded text-[9px] font-bold align-middle"
                        title={r.role.includes('A') ? 'On this step this person is ACCOUNTABLE (RACI)' : ''}>{r.role}</span>
                    )}
                  </td>
                  <td className="text-center p-2 text-indigo-700">{r.weight != null ? `${r.weight}%` : <span className="text-gray-300">—</span>}</td>
                  <td className="text-center p-2 font-semibold">{r.planned}</td>
                  <td className="text-center p-2 text-emerald-700">{r.actual}</td>
                  {/* Same pair as the scorecard row's Pending column: total
                      outstanding (week + pre-week backlog) / backlog closed
                      this week (mam 2026-08-27 audit — no 502-vs-297 mismatch). */}
                  <td className="text-center p-2"
                      title={`${(r.pending_before || 0) + (r.closed_before || 0)} previous pending total / ${r.closed_before || 0} completed this week — ${r.pending_before || 0} remaining`}>
                    <span className="text-amber-700">{((r.pending_before || 0) + (r.closed_before || 0)) || ''}</span>
                    {(r.closed_before || 0) > 0 && <span className="text-gray-300"> / <b className="text-emerald-700">{r.closed_before}</b></span>}
                  </td>
                  <td className={`text-center p-2 font-bold ${pctClr(pct(r.actual, r.planned))}`}>{pct(r.actual, r.planned)}%</td>
                  <td className="text-center p-2">{r.sla_judged ? `${Math.round((r.on_time / r.sla_judged) * 100)}%` : <span className="text-gray-300">—</span>}</td>
                  <td className="p-2"><CommitmentCell row={r} /></td>
                </tr>
              ))}
            </tbody>
          </NumberedTable>
        </div>
      ))}
    </div>
  );
}

// ---------- Employee Switcher (TSK-0914: Admin & Team Leader) ----------
function EmployeeSwitcher({ value, onChange }) {
  const [viewable, setViewable] = useState({ is_admin: false, is_leader: false, users: [] });
  useEffect(() => {
    api.get('/scoring/viewable-users').then(r => setViewable(r.data || { users: [] })).catch(() => {});
  }, []);

  if (!viewable.users || viewable.users.length <= 1) return null;

  return (
    <div>
      <label className="label">{viewable.is_admin ? 'View as' : 'Team Member'}</label>
      <select className="select text-xs py-1.5" value={value || ''} onChange={e => onChange(+e.target.value)}>
        {viewable.users.map(u => (
          <option key={u.user_id} value={u.user_id}>
            {u.is_self ? `👤 ${u.name} (Me)` : u.name} {u.template_name ? `— ${u.template_name}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------- KPI Row (editable) ----------
function KpiRow({ serialNumber, kpi, saving, onSave, readOnly, onStepWise, stepWiseOpen, onDrilldown, onExplain }) {
  const [planned, setPlanned] = useState(kpi.planned ?? 0);
  const [actual, setActual] = useState(kpi.actual ?? 0);
  const [pendingUp, setPendingUp] = useState(kpi.pending_uptodate ?? '');
  const [pendingWork, setPendingWork] = useState(kpi.pending_work ?? '');
  const [commitment, setCommitment] = useState(kpi.commitment ?? '');
  // Commitment split (mam 2026-08-27): "commitment has two type — previous
  // pending task and current commitment". Prev = promise on the backlog.
  const [commitmentPrev, setCommitmentPrev] = useState(kpi.commitment_prev ?? '');
  const [totalUp, setTotalUp] = useState(kpi.total_uptodate ?? '');
  useEffect(() => {
    setPlanned(kpi.planned ?? 0);
    setActual(kpi.actual ?? 0);
    setPendingUp(kpi.pending_uptodate ?? '');
    setPendingWork(kpi.pending_work ?? '');
    setCommitment(kpi.commitment ?? '');
    setCommitmentPrev(kpi.commitment_prev ?? '');
    setTotalUp(kpi.total_uptodate ?? '');
  }, [kpi.kpi_id, kpi.planned, kpi.actual, kpi.pending_uptodate, kpi.pending_work, kpi.commitment, kpi.commitment_prev, kpi.total_uptodate]);

  const flush = (extra = {}) => {
    if (readOnly) return;
    return onSave({
      planned: Number(planned) || 0,
      actual: Number(actual) || 0,
      pending_uptodate: pendingUp === '' ? null : Number(pendingUp),
      pending_work: pendingWork === '' ? null : Number(pendingWork),
      total_uptodate: totalUp === '' ? null : Number(totalUp),
      ...(String(commitment ?? '') !== String(kpi.commitment ?? '') ? { commitment } : {}),
      ...(String(commitmentPrev ?? '') !== String(kpi.commitment_prev ?? '') ? { commitment_prev: commitmentPrev } : {}),
      ...(extra?.nativeEvent ? {} : extra),
    });
  };

  // Show the % as variance vs plan (achievement − 100): 0% = on plan, negative =
  // behind, positive = ahead.  Colour on that scale (see vsPlan note up top).
  const pctClr = vsClr(kpi.actual_pct);
  // Previous-pendency score (mam 2026-09-14): (done ÷ pending) × 100 − 100,
  // e.g. 4 done of 226 pending = −98%. Kept as an achievement % (100 = on
  // plan) so fmtVs/vsClr format it like Actual %. Nothing pending = on plan.
  const prevPend = +(kpi.pending_auto ? kpi.pending_uptodate : pendingUp) || 0;
  const prevDoneN = +(kpi.pending_auto ? kpi.pending_work : pendingWork) || 0;
  const prevAch = prevPend > 0 ? (prevDoneN / prevPend) * 100 : 100;
  const remainingPending = Math.max(0, (+kpi.pending_uptodate || 0) - (+kpi.pending_work || 0));
  const isAuto = kpi.is_auto;
  const actualAuto = kpi.actual_auto ?? isAuto;
  const plannedEditable = kpi.planned_editable ?? !isAuto;
  const calculatedHours = kpi.actual_mode === 'dates';
  const unit = kpi.metric_type === 'hours' ? 'hrs' : kpi.metric_type === 'amount' ? 'amount' : '';
  const canDrill = [
    'auto:delegations',
    'auto:pms',
    'auto:tickets',
    'auto:checklists',
    'auto:daily_active_users',
    'auto:data_completeness',
  ].includes(kpi.data_source) || kpi.data_source?.startsWith('auto:data_completeness:');
  const isRaci = kpi.data_source === 'auto:raci_steps_done';

  return (
    <tr className={`border-t ${saving ? 'bg-amber-50' : ''}`}>
      <td className="serial-number-cell">{serialNumber}</td>
      <td className="p-2">
        <div className="flex items-center gap-1.5">
          <span className="font-medium text-gray-900">{kpi.metric_name}</span>
          {onExplain && (
            <button
              type="button"
              onClick={() => onExplain(kpi)}
              className="text-gray-400 hover:text-indigo-600 transition p-0.5 rounded cursor-pointer shrink-0"
              title="Click to view KPI calculation rules & details"
            >
              <FiInfo size={13} />
            </button>
          )}
        </div>
        {unit && <div className="text-[10px] text-gray-500">{unit === 'hrs' ? 'Hours' : 'Amount'}</div>}
        {actualAuto && SOURCE_INFO[kpi.data_source]?.scope && <div className="text-[10px] text-gray-500" title={SOURCE_INFO[kpi.data_source].actual}>B-actual · {SOURCE_INFO[kpi.data_source].scope}</div>}
        <ScoreMetricDates kpi={kpi} readOnly={readOnly} onSave={flush} />
        <div className="text-[10px] text-gray-500">
          {kpi.direction === 'lower_better' && <span className="text-blue-600">↓ lower better</span>}
          {kpi.direction !== 'lower_better' && <span className="text-emerald-600">↑ higher better</span>}
          {isAuto && <span className="ml-2 px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold">{plannedEditable || !actualAuto ? 'MIXED' : 'AUTO'}</span>}
          {calculatedHours && <span className="ml-2 text-blue-700">Date/time → hours</span>}
          {kpi.data_source?.startsWith('auto:raci_step:indent_to_dispatch:') && <span className="ml-2 text-[9px] text-slate-500" title="Counts all Indent to Dispatch records for the selected step, regardless of employee RACI assignment">Whole module</span>}
          {onStepWise && (
            <button onClick={onStepWise} className="ml-2 text-indigo-600 hover:underline font-semibold">
              {stepWiseOpen ? '▾ hide steps' : '▸ step-wise'}
            </button>
          )}
        </div>
      </td>
      <td className="text-center p-2">{kpi.weightage}%</td>
      {/* Planned/Actual stay this week's cohort — mam 2026-08-26: previous
          pendency shows ONLY in the Pending column (up), not added here. */}
      <td className="text-center p-2">
        {!plannedEditable ? (
          <span className="text-gray-700 cursor-help"
                title={(kpi.target_auto
                  ? sourceInfoFor(kpi.data_source).plan
                  : `Target typed in the template${kpi.has_target_override ? ' (per-user override)' : ''} — the ERP records only the outcome for this source`)}>
            {canDrill && onDrilldown ? (
              <button
                type="button"
                onClick={() => onDrilldown(kpi, 'planned')}
                className="font-bold text-indigo-600 hover:underline hover:text-indigo-800"
                title="Click to view planned tasks due this week"
              >
                {planned}
              </button>
            ) : (isRaci && onStepWise) ? (
              <button
                type="button"
                onClick={onStepWise}
                className="font-bold text-indigo-600 hover:underline hover:text-indigo-800 cursor-pointer"
                title="Click to view step-wise breakdown"
              >
                {planned}
              </button>
            ) : planned}
            {!kpi.target_auto && (
              <span className={`block text-[9px] font-semibold ${+planned === 0 && +actual > 0 ? 'text-red-600' : 'text-emerald-700'}`}>
                {+planned === 0 && +actual > 0 ? 'no target set' : 'target set'}
              </span>
            )}
          </span>
        ) : (
          <input aria-label={`Planned ${kpi.metric_name}`} type="number" step="any" className="input text-center text-xs w-20 mx-auto" value={planned} onChange={e => setPlanned(e.target.value)} onBlur={() => flush()} disabled={readOnly} />
        )}
      </td>
      <td className="text-center p-2">
        {actualAuto || calculatedHours ? (
          <span className="text-gray-700" title={calculatedHours ? 'Calculated from your selected date/times (IST)' : sourceInfoFor(kpi.data_source).actual}>
            {kpi.actual == null ? '—' : (
              canDrill && onDrilldown ? (
                <button
                  type="button"
                  onClick={() => onDrilldown(kpi, 'actual')}
                  className={`font-bold hover:underline ${+actual > 0 ? 'text-emerald-700 hover:text-emerald-900' : 'text-gray-600 hover:text-gray-800'}`}
                  title="Click to view approved tasks for this week"
                >
                  {`${actual}${unit === 'hrs' ? ' hrs' : ''}`}
                </button>
              ) : (isRaci && onStepWise) ? (
                <button
                  type="button"
                  onClick={onStepWise}
                  className="font-bold text-emerald-700 hover:underline hover:text-emerald-900 cursor-pointer"
                  title="Click to view step-wise breakdown"
                >
                  {`${actual}${unit === 'hrs' ? ' hrs' : ''}`}
                </button>
              ) : `${actual}${unit === 'hrs' ? ' hrs' : ''}`
            )}
          </span>
        ) : (
          <input aria-label={`Actual ${kpi.metric_name}`} type="number" step="any" className="input text-center text-xs w-20 mx-auto" value={actual} onChange={e => setActual(e.target.value)} onBlur={() => flush()} disabled={readOnly} />
        )}
        {kpi.actual == null && <span className="block text-[9px] text-gray-500" title={kpi.date_error || undefined}>{kpi.date_error ? 'Check selected dates' : 'Awaiting recorded time'}</span>}
        {kpi.observations != null && <span className="block text-[9px] text-gray-500">{kpi.observations} response{kpi.observations === 1 ? '' : 's'}</span>}
      </td>
      <td className={`text-center p-2 font-bold ${pctClr}`}>{fmtVs(kpi.actual_pct)}</td>
      {/* Total Up-to-date column removed (mam 2026-09-14: "no need here").
          totalUp stays in state so a save never wipes an old stored value. */}
      <td className="text-center p-2">
        {/* Previous pendency only (mam 2026-09-14): of the tasks due BEFORE this
            week, opening pending total / how many were done during this week.
            Opening total = remaining + done. This week's own
            leftover is already Planned − Actual, so it is not in here. */}
        {kpi.pending_auto ? (
          <div className="flex items-start justify-center gap-2 font-semibold leading-tight"
            title={`Previous (due before this week): ${kpi.pending_uptodate || 0} carried in — ${Math.max(0, (+kpi.pending_uptodate || 0) - (+kpi.pending_work || 0))} still pending, ${kpi.pending_work || 0} done this week`}>
            <div className="text-center">
              {canDrill && onDrilldown && (remainingPending > 0) ? (
                <button
                  type="button"
                  onClick={() => onDrilldown(kpi, 'prev_pending')}
                  className="font-bold text-amber-700 hover:underline hover:text-amber-900 cursor-pointer"
                  title="Click to view carryover pending tasks due before this week"
                >
                  {remainingPending}
                </button>
              ) : (isRaci && onStepWise && (remainingPending > 0)) ? (
                <button
                  type="button"
                  onClick={onStepWise}
                  className="font-bold text-amber-700 hover:underline hover:text-amber-900 cursor-pointer"
                  title="Click to view step-wise breakdown"
                >
                  {remainingPending}
                </button>
              ) : (
                <div className={remainingPending > 0 ? 'text-amber-700' : 'text-gray-400'}>{remainingPending}</div>
              )}
              <div className="text-[9px] font-normal text-gray-400">pending</div>
            </div>
            <span className="text-gray-300">/</span>
            <div className="text-center">
              {canDrill && onDrilldown && (+kpi.pending_work > 0) ? (
                <button
                  type="button"
                  onClick={() => onDrilldown(kpi, 'prev_done')}
                  className="font-bold text-emerald-700 hover:underline hover:text-emerald-900 cursor-pointer"
                  title="Click to view older backlog tasks completed this week"
                >
                  {kpi.pending_work || 0}
                </button>
              ) : (isRaci && onStepWise && (+kpi.pending_work > 0)) ? (
                <button
                  type="button"
                  onClick={onStepWise}
                  className="font-bold text-emerald-700 hover:underline hover:text-emerald-900 cursor-pointer"
                  title="Click to view step-wise breakdown"
                >
                  {kpi.pending_work || 0}
                </button>
              ) : (
                <div className={kpi.pending_work > 0 ? 'text-emerald-700' : 'text-gray-400'}>{kpi.pending_work || 0}</div>
              )}
              <div className="text-[9px] font-normal text-gray-400">done</div>
            </div>
          </div>
        ) : (
          <div className="flex items-center justify-center gap-1">
            <input type="number" className="input text-center text-xs w-14" placeholder="pending" title="Previous pending total, including tasks completed this week" value={pendingUp} onChange={e => setPendingUp(e.target.value)} onBlur={flush} disabled={readOnly} />
            <span className="text-gray-300">/</span>
            <input type="number" className="input text-center text-xs w-14" placeholder="done" title="Previous tasks done this week" value={pendingWork} onChange={e => setPendingWork(e.target.value)} onBlur={flush} disabled={readOnly} />
          </div>
        )}
        <div className={`text-center text-[11px] font-bold mt-1 ${vsClr(prevAch)}`}
          title={`Previous score = (done ÷ pending) × 100 − 100 = (${prevDoneN} ÷ ${prevPend}) × 100 − 100${prevPend ? '' : ' — nothing pending, on plan'}`}>
          {fmtVs(prevAch)}
        </div>
      </td>
      <td className="p-2 w-40">
        {/* Two commitments (mam 2026-08-27): the promise on the PREVIOUS
            pending tasks, and the CURRENT week's commitment. */}
        <div className="space-y-1">
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold text-amber-600 w-9 flex-shrink-0 uppercase" title="Commitment for previous pending tasks (%)">Prev</span>
            <KpiCommitmentInput label={`Previous commitment ${kpi.metric_name}`} value={commitmentPrev} onChange={setCommitmentPrev} onSave={flush} disabled={readOnly || saving} />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[9px] font-bold text-indigo-600 w-9 flex-shrink-0 uppercase" title="Commitment for current work (%) — carried into the following week">Now</span>
            <KpiCommitmentInput label={`Current commitment ${kpi.metric_name}`} value={commitment} onChange={setCommitment} onSave={flush} disabled={readOnly || saving} />
          </div>
          {kpi.commitment_inherited && String(commitment ?? '') === String(kpi.commitment ?? '') && <p className="text-[9px] text-gray-400 pl-10" title={`Commitment entered for week starting ${kpi.commitment_from_week}`}>From last week</p>}
        </div>
      </td>
    </tr>
  );
}

function KpiCommitmentInput({ label, value, onChange, onSave, disabled }) {
  const text = String(value ?? '');
  const isNumber = text.trim() !== '' && Number.isFinite(Number(text));
  const legacyNote = text.trim() !== '' && !isNumber;
  return (
    <div>
      <div className="flex items-center gap-1">
        <input type="number" step="any" className="input text-center text-xs !w-20 py-1" aria-label={label} placeholder="—"
          value={isNumber ? text : ''} onChange={e => onChange(e.target.value)} onBlur={() => onSave()} disabled={disabled} />
        <span className="text-[10px] text-gray-400">%</span>
      </div>
      {legacyNote && <p className="max-w-40 truncate text-[9px] text-gray-500" title={text}>{text}</p>}
    </div>
  );
}

// ---------- Templates Admin ----------
function TemplatesAdmin({ templates, reload, setTplDetail }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');

  const create = async (e) => {
    e.preventDefault();
    try {
      await api.post('/scoring/templates', { name, description });
      toast.success('Template created');
      setName(''); setDescription(''); setAdding(false);
      reload();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const del = async (t) => {
    if (!confirm(`Delete template "${t.name}" and all its KPIs?`)) return;
    try { await api.delete(`/scoring/templates/${t.id}`); toast.success('Deleted'); reload(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return (
    <div className="space-y-3">
      <div className="flex justify-between items-center">
        <p className="text-sm text-gray-500">Per-role KPI templates. Edit weights / metrics / data sources here. Mam pre-seeded 20 templates from your MIS PDFs.</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-sm flex items-center gap-1"><FiPlus size={14} /> New Template</button>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {templates.map(t => (
          <div key={t.id} className="card p-4 hover:shadow-md transition cursor-pointer" onClick={() => api.get(`/scoring/templates/${t.id}`).then(r => setTplDetail(r.data))}>
            <div className="flex items-start justify-between gap-2">
              <div>
                <div className="font-bold text-sm">{t.name}</div>
                {t.description && <p className="text-[11px] text-gray-500 mt-0.5">{t.description}</p>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); del(t); }} className="text-red-500 hover:text-red-700"><FiTrash2 size={14} /></button>
            </div>
            <div className="flex gap-3 mt-3 text-[10px] text-gray-500">
              <span>{t.kpi_count} KPIs</span>
              <span>{t.user_count} assigned</span>
            </div>
          </div>
        ))}
      </div>

      <Modal isOpen={adding} onClose={() => setAdding(false)} title="New Template">
        <form onSubmit={create} className="space-y-3">
          <div><label className="label">Name *</label><input className="input" required value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Site Engineer" /></div>
          <div><label className="label">Description</label><input className="input" value={description} onChange={e => setDescription(e.target.value)} placeholder="What this role's KPIs measure" /></div>
          <div className="flex justify-end gap-2"><button type="button" onClick={() => setAdding(false)} className="btn btn-secondary">Cancel</button><button type="submit" className="btn btn-primary">Create</button></div>
        </form>
      </Modal>
    </div>
  );
}

// ---------- Template KPI Editor ----------
// Per-step RACI <optgroup>s for the template editor's source pickers — one group
// per module, each step an option whose value is "auto:raci_step:<module>:<step>".
// Indent to Dispatch sources count the whole module; other steps use personal RACI.
function DprActualCostOptions() {
  return <>
    <option value="auto:dpr_actual_cost_all">DPR Actual Cost (B-actual) — all sites</option>
    <option value="auto:dpr_actual_cost_sites">DPR Actual Cost (B-actual) — assigned sites</option>
    <option value="auto:dpr_actual_cost_by_user">DPR Actual Cost (B-actual) — submitted by employee</option>
  </>;
}

function RaciStepOptions({ modules }) {
  if (!modules || !modules.length) return null;
  return modules.map(m => (
    <optgroup key={m.key} label={`${m.key === 'indent_to_dispatch' ? 'Whole module step' : 'RACI step'} · ${m.label}`}>
      {(m.steps || []).map(s => (
        <option key={s.key} value={`auto:raci_step:${m.key}:${s.key}`}>{s.label}</option>
      ))}
    </optgroup>
  ));
}

function TemplateKpiEditor({ templateId, onChange }) {
  const [tpl, setTpl] = useState(null);
  const [expandedMetric, setExpandedMetric] = useState(null);
  const [adding, setAdding] = useState(false);
  const emptyForm = { group_name: 'Weekly', metric_name: '', weightage: 0, direction: 'higher_better', data_source: 'manual', default_planned: 0, planned_mode: 'source', actual_mode: 'source', metric_type: 'number', time_basis: 'elapsed' };
  const [form, setForm] = useState(emptyForm);
  // Module + step catalogue for the per-step RACI source options (one fetch).
  const [raciModules, setRaciModules] = useState([]);
  useEffect(() => { api.get('/raci/modules').then(r => setRaciModules(r.data || [])).catch(() => {}); }, []);
  // Mam (2026-06-02): "here we done with it plan fill but from where
  // is actual we not show".  Live actual preview — pick any user
  // assigned to THIS template, fetch their current-week scorecard,
  // and merge the actual values into the KPI rows so mam can verify
  // each data source returns real data.
  const [previewUsers, setPreviewUsers] = useState([]);   // users assigned to this template
  const [previewUserId, setPreviewUserId] = useState('');
  const [previewKpis, setPreviewKpis] = useState({});     // { kpi_id: { planned, actual, score, target_auto } }
  const { user: me } = useAuth();
  const [previewLoading, setPreviewLoading] = useState(false);

  const load = useCallback(() => {
    api.get(`/scoring/templates/${templateId}`).then(r => setTpl(r.data));
  }, [templateId]);
  useEffect(() => { load(); }, [load]);

  // Load users assigned to this template — we use the assignments
  // endpoint and filter client-side.  Auto-select the first one so
  // mam doesn't have to pick before seeing data.
  useEffect(() => {
    api.get('/scoring/assignments').then(r => {
      const onThis = (r.data || []).filter(a => (a.template_ids || [a.template_id]).includes(templateId));
      setPreviewUsers(onThis);
      if (onThis.length > 0 && !previewUserId) setPreviewUserId(onThis[0].user_id);
    }).catch(() => setPreviewUsers([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId]);

  // When user picked, fetch their scorecard and build a {kpi_id → row} lookup.
  useEffect(() => {
    // Fetched even with no preview user (falls back to the admin's own id):
    // the engine reports target_auto per KPI — whether Planned is counted live
    // or must be typed — and the Target cell below locks/opens on that. With
    // template_id the server scores THIS template, assigned or not.
    setPreviewLoading(true);
    api.get('/scoring/scorecard', { params: { user_id: previewUserId || me?.id, template_id: templateId } })
      .then(r => {
        const map = {};
        for (const k of (r.data?.kpis || [])) {
          map[k.kpi_id || k.id] = k;
        }
        setPreviewKpis(map);
      })
      .catch(() => setPreviewKpis({}))
      .finally(() => setPreviewLoading(false));
  }, [previewUserId, templateId, me?.id, tpl]);

  // Per-user KPI overrides — mam (2026-06-02): "every person different
  // KPIs" (Option B).  Three things mam can override per user:
  //   - planned_value  → custom target
  //   - weight_override → custom weight (e.g. demote a KPI to 0% so
  //                       it stays visible but doesn't count toward score)
  //   - enabled         → 0 hides the KPI entirely (struck-through row)
  // All three flow through the same /scoring/users/:uid/kpi-targets
  // endpoint (composite-PK row in score_user_kpi_target).
  const [userOverrides, setUserOverrides] = useState({}); // { kpi_id: {planned_value, enabled, weight_override} }
  useEffect(() => {
    if (!previewUserId) { setUserOverrides({}); return; }
    api.get(`/scoring/users/${previewUserId}/kpi-targets`, { params: { template_id: templateId } })
      .then(r => {
        const map = {};
        for (const row of (r.data || [])) {
          map[row.kpi_id] = {
            planned_value: row.planned_value,
            enabled: row.enabled != null ? row.enabled : 1,
            weight_override: row.weight_override,
          };
        }
        setUserOverrides(map);
      })
      .catch(() => setUserOverrides({}));
  }, [previewUserId, templateId]);

  // Convenience accessors so existing per-target render paths keep working.
  const userTargets = useMemo(() => {
    const o = {};
    for (const [kid, v] of Object.entries(userOverrides)) {
      if (v.planned_value != null) o[kid] = v.planned_value;
    }
    return o;
  }, [userOverrides]);

  // Patch one field; backend handles partial-PUT (other fields stay put).
  const saveUserSetting = async (kpiId, patch) => {
    if (!previewUserId) return;
    try {
      await api.put(`/scoring/users/${previewUserId}/kpi-targets/${kpiId}`, patch);
      setUserOverrides(prev => {
        const next = { ...prev };
        const cur = next[kpiId] || { planned_value: null, enabled: 1, weight_override: null };
        // Apply the patch locally to keep the UI snappy
        const merged = { ...cur };
        if ('planned_value' in patch)   merged.planned_value   = patch.planned_value === '' ? null : (patch.planned_value == null ? null : +patch.planned_value);
        if ('enabled' in patch)         merged.enabled         = patch.enabled ? 1 : 0;
        if ('weight_override' in patch) merged.weight_override = patch.weight_override === '' ? null : (patch.weight_override == null ? null : +patch.weight_override);
        // If row is back to defaults (enabled=1 + no overrides), drop it locally too
        if (merged.enabled === 1 && merged.planned_value == null && merged.weight_override == null) {
          delete next[kpiId];
        } else {
          next[kpiId] = merged;
        }
        return next;
      });
      toast.success('Saved');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to save');
    }
  };
  const saveUserTarget = (kpiId, value) =>
    saveUserSetting(kpiId, { planned_value: value === '' || value == null ? null : +value });

  const addKpi = async (e) => {
    e.preventDefault();
    try {
      await api.post(`/scoring/templates/${templateId}/kpis`, form);
      setForm(emptyForm);
      setAdding(false);
      load(); onChange?.();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const updateKpi = async (k, patch) => {
    try { await api.put(`/scoring/kpis/${k.id}`, patch); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  const delKpi = async (k) => {
    if (!confirm(`Delete KPI "${k.metric_name}"?`)) return;
    try { await api.delete(`/scoring/kpis/${k.id}`); load(); onChange?.(); }
    catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  if (!tpl) return <div className="text-gray-400 text-center py-6">Loading…</div>;

  const totalWeight = (tpl.kpis || []).reduce((s, k) => s + (k.weightage || 0), 0);

  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto">
      <div className="flex justify-between items-center flex-wrap gap-2">
        <p className="text-xs text-gray-500">Total weight: <span className={`font-bold ${totalWeight === 100 ? 'text-emerald-600' : 'text-amber-600'}`}>{totalWeight}%</span> {totalWeight !== 100 && '(should be 100)'}</p>
        <button onClick={() => setAdding(true)} className="btn btn-primary text-xs flex items-center gap-1"><FiPlus size={12} /> Add KPI</button>
      </div>
      {/* Why some Targets are typed and some are not (mam 2026-09-05: "some
          place I need to enter plan and some place automatically pick plan,
          how I can justify"). The engine decides per source (target_auto). */}
      <div className="text-[11px] text-gray-600 bg-gray-50 border border-gray-200 rounded p-2 flex flex-wrap gap-x-4 gap-y-1">
        <span><span className="inline-block px-1.5 py-0.5 rounded bg-blue-50 border border-blue-200 text-blue-700 font-semibold">auto</span> target — the ERP knows what was <b>given</b> this week (tasks due, snags raised, RACI steps reached, sites managed), so Planned is counted live. Nothing to type.</span>
        <span><span className="inline-block px-1.5 py-0.5 rounded bg-emerald-50 border border-emerald-300 text-emerald-700 font-semibold">you set</span> target — the ERP records only the <b>outcome</b> (candidates shortlisted, amount received, leads created). There is no "given" count to derive a target from, so the weekly target is a management goal you type here. Leave it 0 and any actual above 0 scores 0%.</span>
      </div>
      {/* Mam (2026-06-02): "from where is actual we not show".  Pick a
          user assigned to this template → the Actual column below
          renders their current-week computed value per KPI so mam
          can verify each data source is wired correctly. */}
      <div className="bg-blue-50/40 border border-blue-200 rounded p-2 flex items-center gap-2 flex-wrap text-xs">
        <span className="font-semibold text-blue-800">Preview actuals for:</span>
        {previewUsers.length === 0 ? (
          <span className="text-gray-500 italic">No users assigned to this template yet — assign one from "Assign Templates" tab to preview actual values.</span>
        ) : (
          <>
            <select
              className="select text-xs py-1 px-2"
              value={previewUserId}
              onChange={e => setPreviewUserId(+e.target.value)}
            >
              {previewUsers.map(u => (
                <option key={u.user_id} value={u.user_id}>
                  {u.name}{u.department ? ` · ${u.department}` : ''}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-gray-500">
              {previewLoading ? 'loading…' : 'current week, live from SOTYN.AI data'}
            </span>
          </>
        )}
      </div>
      <NumberedTable className="w-full text-xs">
        <thead className="bg-gray-50">
          <tr>
            <th className="text-left p-2">Group</th>
            <th className="text-left p-2">Metric</th>
            <th className="text-center p-2 w-16">Weight</th>
            <th className="text-center p-2 w-20">Target</th>
            <th className="text-center p-2 w-24">Direction</th>
            <th className="text-center p-2 w-32">Source</th>
            <th className="text-center p-2 w-24">Actual<br/><span className="text-[9px] font-normal text-gray-400 normal-case">(this week)</span></th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {tpl.kpis.map(k => {
            // Per-user override snapshot for this row (only used when
            // previewUserId is set).  Drives the enable toggle + the
            // weight override input + the visual "disabled" dimming.
            const userRow = previewUserId ? userOverrides[k.id] : null;
            const userEnabled = userRow ? userRow.enabled !== 0 : true;
            const userWeight = userRow?.weight_override;
            const hasWeightOverride = userWeight != null;
            return (
            <Fragment key={k.id}>
            <tr className={`border-t ${previewUserId && !userEnabled ? 'opacity-40 line-through' : ''}`}>
              <td className="p-2">
                <div className="flex items-center gap-2">
                  {/* Mam (2026-06-02): per-user enable toggle.  When a
                      preview user is picked, this controls whether the
                      KPI counts for THAT user.  Disabled rows render
                      dimmed + struck-through.  Hidden when no user
                      picked (template editor mode). */}
                  {previewUserId && (
                    <input
                      type="checkbox"
                      checked={userEnabled}
                      onChange={e => saveUserSetting(k.id, { enabled: e.target.checked ? 1 : 0 })}
                      className="cursor-pointer flex-shrink-0"
                      title={userEnabled
                        ? `Untick to hide this KPI from ${previewUsers.find(u => u.user_id === previewUserId)?.name || 'this user'}'s scorecard.`
                        : 'Tick to include this KPI in the scorecard again.'}
                    />
                  )}
                  <input className="input text-xs" defaultValue={k.group_name} onBlur={e => updateKpi(k, { group_name: e.target.value })} />
                </div>
              </td>
              <td className="p-2"><input className="input text-xs" defaultValue={k.metric_name} onBlur={e => updateKpi(k, { metric_name: e.target.value })} /></td>
              <td className="p-2">
                {previewUserId ? (
                  /* Per-user weight override (Option B).  Empty = falls
                     back to template default. */
                  <div>
                    <input
                      type="number" step="0.1"
                      className={`input text-xs text-center ${hasWeightOverride ? 'border-emerald-400 bg-emerald-50' : ''}`}
                      key={`uw-${previewUserId}-${k.id}-${userWeight ?? 'def'}`}
                      defaultValue={hasWeightOverride ? userWeight : k.weightage}
                      onBlur={e => {
                        const v = e.target.value;
                        const num = +v;
                        if (hasWeightOverride) {
                          if (v === '') saveUserSetting(k.id, { weight_override: null });
                          else if (num !== +userWeight) saveUserSetting(k.id, { weight_override: num });
                        } else {
                          if (v !== '' && num !== (+k.weightage || 0)) saveUserSetting(k.id, { weight_override: num });
                        }
                      }}
                      title={hasWeightOverride
                        ? `Per-user weight (template default: ${k.weightage}%)`
                        : `Falls back to template weight ${k.weightage}%.  Edit to override for this user.`}
                    />
                    <div className="text-[9px] mt-0.5 text-center">
                      {hasWeightOverride
                        ? <span className="text-emerald-700 font-semibold">user weight</span>
                        : <span className="text-gray-400">default: {k.weightage}</span>}
                    </div>
                  </div>
                ) : (
                  <input type="number" className="input text-xs text-center" defaultValue={k.weightage} onBlur={e => updateKpi(k, { weightage: +e.target.value })} />
                )}
              </td>
              {/* Target column — three modes:
                  1. Auto source (locked): shows "auto" pill, target comes
                     from computeAutoCount's `given`.
                  2. Manual + no preview user: edits the TEMPLATE default
                     (k.default_planned) — fallback for everyone.
                  3. Manual + preview user picked: edits the PER-USER
                     override (mam 2026-06-02: "same target weekly but
                     per-user").  Empty → falls back to template default.
                     A small chip below the input shows which mode is
                     active so mam doesn't accidentally change the wrong
                     one. */}
              <td className="p-2">
                {(() => {
                  const isAuto = k.data_source && k.data_source.startsWith('auto:');
                  // The ENGINE says whether this source produces a target
                  // (target_auto). Until the preview loads, fall back to the
                  // source description: "You set" = typed target. Before this,
                  // every auto source was locked as "auto" even where the
                  // description said "You set" — 49 sources with no box.
                  const live = previewKpis[k.id];
                  const autoLocksTarget = isAuto && k.planned_mode !== 'manual' && (live
                    ? !!live.target_auto
                    : !/^you set/i.test(sourceInfoFor(k.data_source)?.plan || ''));
                  const youSetHint = (
                    <div className="text-[9px] mt-0.5 text-center text-emerald-700 font-semibold cursor-help"
                         title="The ERP records only the outcome for this source — there is no 'given' count to derive a target from. Type the weekly target (a management goal). Leaving it 0 makes any actual above 0 score 0%.">
                      you set
                    </div>
                  );
                  if (autoLocksTarget) {
                    return (
                      <div className="text-center text-[10px] text-blue-700 bg-blue-50 border border-blue-200 rounded px-1 py-1 cursor-help"
                           title={`Target is counted live from ${k.data_source.replace('auto:', '')} — the ERP knows what was given to the user in the scoring period (${sourceInfoFor(k.data_source)?.plan || 'items given'}). Nothing to type.`}>
                        auto
                      </div>
                    );
                  }
                  // Per-user override mode (preview user picked)
                  if (previewUserId) {
                    const overrideVal = userTargets[k.id];
                    const hasOverride = overrideVal != null;
                    return (
                      <div>
                        <input
                          type="number" step="0.1"
                          className={`input text-xs text-center ${hasOverride ? 'border-emerald-400 bg-emerald-50' : ''}`}
                          // controlled via key so switching user remounts the input with fresh defaultValue
                          key={`utg-${previewUserId}-${k.id}-${overrideVal ?? 'def'}`}
                          defaultValue={hasOverride ? overrideVal : (k.default_planned || 0)}
                          onBlur={e => {
                            const v = e.target.value;
                            const num = +v;
                            // Save only if value differs from current state
                            if (hasOverride) {
                              if (v === '' || num === 0) saveUserTarget(k.id, '');         // remove override
                              else if (num !== +overrideVal) saveUserTarget(k.id, num);
                            } else {
                              // No override yet — only save if mam typed a NON-default value
                              if (v !== '' && num !== (+k.default_planned || 0)) saveUserTarget(k.id, num);
                            }
                          }}
                          title={hasOverride ? `Per-user target (override of template default ${k.default_planned})` : `Falls back to template default (${k.default_planned}). Edit to override for this user.`}
                        />
                        <div className="text-[9px] mt-0.5 text-center">
                          {hasOverride
                            ? <span className="text-emerald-700 font-semibold">user override</span>
                            : <span className="text-gray-400">default: {k.default_planned || 0}</span>}
                        </div>
                        {isAuto && youSetHint}
                      </div>
                    );
                  }
                  // No preview user — editing the TEMPLATE default for everyone.
                  return (
                    <div>
                      <input
                        type="number" step="0.1"
                        className="input text-xs text-center"
                        defaultValue={k.default_planned || 0}
                        onBlur={e => updateKpi(k, { default_planned: +e.target.value })}
                        title="Template default — applies to every user assigned to this template (unless overridden per-user)."
                      />
                      {isAuto && youSetHint}
                    </div>
                  );
                })()}
              </td>
              <td className="p-2">
                <select className="select text-xs" value={k.direction} onChange={e => updateKpi(k, { direction: e.target.value })}>
                  <option value="higher_better">↑ higher</option>
                  <option value="lower_better">↓ lower</option>
                </select>
              </td>
              <td className="p-2">
                <select aria-label={`Source for ${k.metric_name}`} key={`src-${k.id}-${raciModules.length}`} className="select text-xs" value={k.data_source} onChange={e => updateKpi(k, { data_source: e.target.value, ...(e.target.value === 'auto:lead_response_hours' ? { metric_type: 'hours', direction: 'lower_better', planned_mode: 'manual', actual_mode: 'source' } : e.target.value.startsWith('auto:dpr_actual_cost_') ? { metric_type: 'amount', planned_mode: 'manual', actual_mode: 'source' } : {}) })}>
                  <option value="manual">manual entry</option>
                  <option value="auto:lead_response_hours">Lead response — first completed response (hours)</option>
                  <optgroup label="Tasks & Tickets">
                    <option value="auto:delegations">delegations (assigned/done)</option>
                    <option value="auto:pms">pms tasks (assigned/done)</option>
                    <option value="auto:checklists">checklists (per day)</option>
                    <option value="auto:tickets">help tickets (assigned/resolved)</option>
                    <option value="auto:snags">snag list (assigned/approved)</option>
                    <option value="auto:activity_log">activity log — data entries (by user)</option>
                  </optgroup>
                  <optgroup label="Owner / Company-wide (ALL records)">
                    <option value="auto:pms_all">PMS tasks — ALL (company-wide)</option>
                    <option value="auto:delegations_all">Delegations — ALL (company-wide)</option>
                    <option value="auto:tickets_all">Help tickets — ALL (company-wide)</option>
                    <option value="auto:snags_all">Snag list — ALL (company-wide)</option>
                    <option value="auto:erp_module_coverage">SOTYN.AI module coverage (how many ran)</option>
                  </optgroup>
                  <optgroup label="Responsibility (RACI / SLA)">
                    <option value="auto:raci_steps_done">RACI steps closed (all modules)</option>
                    <option value="auto:raci_ontime_pct">RACI on-time % (within SLA)</option>
                  </optgroup>
                  <RaciStepOptions modules={raciModules} />
                  <optgroup label="ERP Management (System Flow) — by developer">
                    <option value="auto:sysflow_steps">System Flow steps (developer — due/completed)</option>
                    <option value="auto:sysflow_ontime_pct">System Flow on-time % (developer — completed by target date)</option>
                    <option value="auto:sysflow_blocked">System Flow steps blocked this week (developer)</option>
                    <option value="auto:sysflow_overdue">System Flow steps overdue at week end (developer)</option>
                    <option value="auto:sysflow_updates">System Flow work updates logged (by user)</option>
                    <option value="auto:sysflow_all">System Flow steps — ALL (company-wide)</option>
                    <option value="auto:sysflow_progress_pct">ERP implementation progress % (at week end)</option>
                  </optgroup>
                  <optgroup label="DPR (Daily Project Report)">
                    <DprActualCostOptions />
                    <option value="auto:dpr_profit">DPR profit (planned vs actual ₹) [site]</option>
                    <option value="auto:dpr_count">DPR count (6 days/week target) [site]</option>
                    <option value="auto:dpr_by_user">DPR submitted BY user (count)</option>
                    <option value="auto:dpr_profit_by_user">DPR profit/loss SUM (by user)</option>
                    <option value="auto:dpr_cost_by_user">DPR submitted vs approved (by user)</option>
                  </optgroup>
                  <optgroup label="Sales / CRM">
                    <option value="auto:leads_created">leads created (assigned to user)</option>
                    <option value="auto:leads_qualified">leads qualified (by user)</option>
                    <option value="auto:quotations_sent">quotations sent (by user)</option>
                    <option value="auto:meetings_planned">meetings planned (this week)</option>
                    <option value="auto:crm_kitting">Full kitting — checkpoints updated this week (all projects)</option>
                  </optgroup>
                  <optgroup label="Business Book">
                    <option value="auto:bb_entries">BB entries created (by user)</option>
                    <option value="auto:bb_po_amount">BB PO amount SUM (by user)</option>
                    <option value="auto:bb_sale_amount">BB Sale amount SUM (by user)</option>
                    <option value="auto:bb_advance">BB Advance received SUM (by user)</option>
                  </optgroup>
                  <optgroup label="Procurement (Indent → Dispatch)">
                    <option value="auto:indents_in_week">indents created (site)</option>
                    <option value="auto:indent_vs_bill">Indent vs Bill — indents raised vs sales bills (site)</option>
                    <option value="auto:items_complete">Itemwise complete — items with PO raised / total (all)</option>
                    <option value="auto:indents_approved">indents approved (by user)</option>
                    <option value="auto:vendor_pos_created">vendor POs created</option>
                    <option value="auto:purchase_bills">purchase bills received</option>
                    <option value="auto:po_bill_pending">Purchase Bill — approved POs missing a bill (by owner)</option>
                    <option value="auto:po_bill_pending_all">Purchase Bill — approved POs missing a bill (company-wide)</option>
                    <option value="auto:dispatch_sent">dispatches sent (delivery notes)</option>
                    <option value="auto:dispatch_receiving_approved">Dispatch Receiving — weekly uploads vs approved (by uploader)</option>
                    <option value="auto:material_received">material received (site)</option>
                  </optgroup>
                  <optgroup label="Inventory / Stock">
                    <option value="auto:stock_in">stock IN movements</option>
                    <option value="auto:stock_out">stock OUT movements</option>
                    <option value="auto:stock_to_site">stock issued to site</option>
                    <option value="auto:stock_updates">stock updates per site/week</option>
                    <option value="auto:tools_list">tools list per site</option>
                    <option value="auto:stock_at_site">stock at site flag</option>
                  </optgroup>
                  <optgroup label="Installation & Billing">
                    <option value="auto:installations_started">installations started</option>
                    <option value="auto:installations_completed">installations completed</option>
                    <option value="auto:sales_bills">sales bills raised</option>
                    <option value="auto:ra_bills">RA bills raised (site)</option>
                    <option value="auto:sales_bill_checking">RA Bill / Sales Bill Checking — Checked / OK</option>
                    <option value="auto:dpr_bill_checking">DPR to RA Bill — checked bills by bill date (all)</option>
                    <option value="auto:mb_filed">MB bills filed (count)</option>
                    <option value="auto:mb_signed">MB signed by client (site)</option>
                  </optgroup>
                  <optgroup label="Cash Flow / Collections">
                    <option value="auto:amount_received">amount received SUM (by user)</option>
                    <option value="auto:amount_received_all">amount received SUM (all)</option>
                    <option value="auto:amount_received_lakh">amount received — in LAKH (all, weekly)</option>
                    <option value="auto:receivables_outstanding_cr">receivables outstanding — in CRORE (all)</option>
                    <option value="auto:collections_count">collections count (by user)</option>
                    <option value="auto:receivables_outstanding">receivables outstanding SUM (owner)</option>
                    <option value="auto:receivables_count">receivables outstanding count (owner)</option>
                  </optgroup>
                  <optgroup label="Payment Required">
                    <option value="auto:payments_raised">payment requests raised (by user)</option>
                    <option value="auto:payments_approved">payment requests final-approved</option>
                    <option value="auto:payments_rejected">payment requests rejected</option>
                  </optgroup>
                  <optgroup label="HR Hiring">
                    <option value="auto:subcontractor_work_orders">Work-order uploads — Sub-contractor Master Detail (weekly)</option>
                    <option value="auto:candidates_added">candidates added</option>
                    <option value="auto:candidates_shortlisted">candidates shortlisted</option>
                    <option value="auto:offer_letters">Offer Letters — Hiring Candidates (weekly)</option>
                    <option value="auto:candidates_onboarded">candidates onboarded</option>
                  </optgroup>
                  <optgroup label="HR — Manpower">
                    <option value="auto:site_manpower">Site manpower — required vs actual (all projects)</option>
                    <option value="auto:attrition">Attrition — staff left count (↓ lower better, you set target)</option>
                  </optgroup>
                  <optgroup label="System / Engagement">
                    <option value="auto:daily_active_users">Daily Active users — checking/updates, excluding attendance</option>
                    <option value="auto:data_entry_all">Data Entry — records entered company-wide (weekly)</option>
                    <option value="auto:data_completeness">Data Completeness — required fields filled (Item Master + Business Book + Employees + Users)</option>
                    <option value="auto:data_completeness:item_master">Data Completeness — Item Master only</option>
                    <option value="auto:data_completeness:business_book">Data Completeness — Business Book only</option>
                    <option value="auto:data_completeness:employees">Data Completeness — Employees only</option>
                    <option value="auto:data_completeness:users">Data Completeness — Users only</option>
                  </optgroup>
                  <optgroup label="Attendance">
                    <option value="auto:attendance_present_days">attendance present days (target 6)</option>
                    <option value="auto:attendance_late_days">attendance late days</option>
                    <option value="auto:attendance_absent_days">attendance absent days</option>
                    <option value="auto:leaves_applied">leaves applied (by user)</option>
                  </optgroup>
                  <optgroup label="Complaints">
                    <option value="auto:complaints_raised">complaints raised</option>
                    <option value="auto:complaints_resolved">complaints resolved</option>
                  </optgroup>
                  <optgroup label="Master Data">
                    <option value="auto:customers_added">customers added</option>
                    <option value="auto:vendors_added">vendors added</option>
                  </optgroup>
                </select>
                <button type="button" aria-expanded={expandedMetric === k.id} onClick={() => setExpandedMetric(expandedMetric === k.id ? null : k.id)} className="mt-2 rounded border border-blue-100 bg-blue-50 px-2 py-1.5 text-[10px] font-semibold text-blue-700">
                  Plan / Actual options
                </button>
                {/* Mam (2026-06-02): "how plan actual say in template that
                    pick from here".  Plain-English mapping so admin sees
                    exactly which DB field feeds Plan vs Actual for this
                    KPI source.  Pulled from the SOURCE_INFO map at top
                    of file. */}
                {(() => {
                  const info = sourceInfoFor(k.data_source);
                  return (
                    <div className="mt-1 space-y-0.5 text-[9px] leading-tight">
                      <div className="flex items-start gap-1">
                        <span className="font-bold text-blue-700 whitespace-nowrap">Plan:</span>
                        <span className="text-gray-600">{k.planned_mode === 'manual' ? 'You enter the weekly plan; template target is the default' : info.plan}</span>
                      </div>
                      <div className="flex items-start gap-1">
                        <span className="font-bold text-emerald-700 whitespace-nowrap">Actual:</span>
                        <span className="text-gray-600">{k.actual_mode === 'manual' ? 'You enter the weekly value manually' : k.actual_mode === 'dates' ? 'You enter both date/times manually; SOTYN calculates hours (IST)' : info.actual}</span>
                      </div>
                    </div>
                  );
                })()}
              </td>
              {/* Actual preview (mam 2026-06-02) — live value from the
                  computeAutoCount path for the selected preview user.
                  Renders the actual value, with a small chip showing
                  whether the source returned data (📊 green if non-
                  zero, ⚪ gray if zero, ⚠ amber if not yet computed). */}
              <td className="p-2 text-center">
                {(() => {
                  if (!previewUserId) return <span className="text-gray-300 text-[10px]">—</span>;
                  if (previewLoading) return <span className="text-gray-400 text-[10px] italic">…</span>;
                  const row = previewKpis[k.id];
                  if (!row) return <span className="text-gray-300 text-[10px]">no data</span>;
                  const actual = row.actual ?? row.actual_value ?? null;
                  const isAuto = row.actual_auto;
                  let cls = 'bg-gray-100 text-gray-500';
                  if (actual !== null && actual !== undefined && actual !== 0) {
                    cls = 'bg-emerald-100 text-emerald-800';
                  } else if (!isAuto) {
                    cls = 'bg-amber-50 text-amber-700';
                  }
                  return (
                    <div className="inline-flex items-center justify-center gap-1">
                      <span className={`text-[11px] font-bold px-2 py-0.5 rounded ${cls}`} title={`Live actual for ${row.metric_name || k.metric_name} · ${isAuto ? 'auto from ' + k.data_source.replace('auto:', '') : 'manual entry'}`}>
                        {actual !== null && actual !== undefined
                          ? (Number.isFinite(+actual) ? (+actual).toLocaleString('en-IN') : String(actual))
                          : '—'}
                      </span>
                    </div>
                  );
                })()}
              </td>
              <td className="p-2"><button onClick={() => delKpi(k)} className="text-red-500 hover:text-red-700"><FiTrash2 size={12} /></button></td>
            </tr>
            {expandedMetric === k.id && <tr className="bg-blue-50/40"><td colSpan={8} className="p-3">
              <div className="mb-2 font-semibold text-blue-800">{k.metric_name} · Plan / Actual settings</div>
              <ScoreMetricSettings value={k} onChange={patch => updateKpi(k, patch)} />
            </td></tr>}
            </Fragment>
            );
          })}
        </tbody>
      </NumberedTable>

      {adding && (
        <form onSubmit={addKpi} className="border-t pt-3 grid grid-cols-2 gap-2">
          <input className="input text-sm" placeholder="Group (e.g. Weekly)" value={form.group_name} onChange={e => setForm(f => ({ ...f, group_name: e.target.value }))} />
          <input className="input text-sm" placeholder="Metric name" required value={form.metric_name} onChange={e => setForm(f => ({ ...f, metric_name: e.target.value }))} />
          <input type="number" className="input text-sm" placeholder="Weight %" value={form.weightage} onChange={e => setForm(f => ({ ...f, weightage: +e.target.value }))} />
          <input type="number" step="0.1" className="input text-sm" placeholder="Default Target (fixed Planned)" value={form.default_planned} onChange={e => setForm(f => ({ ...f, default_planned: +e.target.value }))} />
          <select className="select text-sm" value={form.direction} onChange={e => setForm(f => ({ ...f, direction: e.target.value }))}>
            <option value="higher_better">↑ higher better</option>
            <option value="lower_better">↓ lower better</option>
          </select>
          <select aria-label="New metric source" className="select text-sm col-span-2" value={form.data_source} onChange={e => setForm(f => ({ ...f, data_source: e.target.value,
            ...(e.target.value === 'auto:lead_response_hours' ? { metric_type: 'hours', direction: 'lower_better', planned_mode: 'manual', actual_mode: 'source' }
              : e.target.value.startsWith('auto:dpr_actual_cost_') ? { metric_type: 'amount', planned_mode: 'manual', actual_mode: 'source' }
              : e.target.value.startsWith('auto:amount_received') ? { metric_type: 'amount', actual_mode: 'source' } : {}),
          }))}>
            <option value="manual">manual entry</option>
            <option value="auto:lead_response_hours">Lead response — first completed response (hours)</option>
            <option value="auto:amount_received">Amount received (by user)</option>
            <option value="auto:amount_received_all">Amount received (all)</option>
            <option value="auto:delegations">auto: delegations</option>
            <option value="auto:pms">auto: pms tasks</option>
            <option value="auto:checklists">auto: checklists</option>
            <option value="auto:tickets">auto: tickets</option>
            <option value="auto:snags">auto: snag list</option>
            <optgroup label="DPR Actual Cost (B-actual)"><DprActualCostOptions /></optgroup>
            <option value="auto:raci_steps_done">auto: RACI steps (all modules)</option>
            <RaciStepOptions modules={raciModules} />
            <optgroup label="Procurement">
              <option value="auto:po_bill_pending">auto: Purchase Bill — approved POs missing a bill (by owner)</option>
              <option value="auto:po_bill_pending_all">auto: Purchase Bill — approved POs missing a bill (company-wide)</option>
            </optgroup>
            <optgroup label="ERP Management (System Flow) — by developer">
              <option value="auto:sysflow_steps">auto: System Flow steps (developer)</option>
              <option value="auto:sysflow_ontime_pct">auto: System Flow on-time % (developer)</option>
              <option value="auto:sysflow_blocked">auto: System Flow steps blocked this week (developer)</option>
              <option value="auto:sysflow_overdue">auto: System Flow steps overdue at week end (developer)</option>
              <option value="auto:sysflow_updates">auto: System Flow work updates logged</option>
              <option value="auto:sysflow_all">auto: System Flow steps — ALL (company-wide)</option>
              <option value="auto:sysflow_progress_pct">auto: ERP implementation progress %</option>
            </optgroup>
          </select>
          <div className="col-span-2 rounded-lg border bg-blue-50/40 p-3"><ScoreMetricSettings value={form} onChange={patch => setForm(f => ({ ...f, ...patch }))} /></div>
          <div className="col-span-2 flex justify-end gap-2">
            <button type="button" onClick={() => setAdding(false)} className="btn btn-secondary text-sm">Cancel</button>
            <button type="submit" className="btn btn-primary text-sm">Add</button>
          </div>
        </form>
      )}
    </div>
  );
}

// ---------- Assign Templates ----------
function AssignTemplates({ assignments, templates, onSaved }) {
  const [editing, setEditing] = useState(null);
  const [search, setSearch] = useState('');
  const visible = assignments.filter(a => `${a.name} ${a.department || ''} ${a.template_name || ''}`.toLowerCase().includes(search.trim().toLowerCase()));
  return (
    <div className="card p-0">
      <div className="p-4 border-b flex flex-wrap items-center justify-between gap-3">
        <div><p className="font-semibold">Assign templates</p><p className="text-xs text-gray-500 mt-1">Choose multiple templates for employees handling more than one role.</p></div>
        <input className="input text-sm w-full sm:w-64" aria-label="Search employees" placeholder="Search employee or template…" value={search} onChange={e => setSearch(e.target.value)} />
      </div>
      <div className="overflow-x-auto"><NumberedTable>
        <thead><tr><th>Employee</th><th>Dept</th><th>Role</th><th>Assigned templates</th></tr></thead>
        <tbody>
          {visible.map(a => (
            <tr key={a.user_id}>
              <td className="font-medium">{a.name}</td>
              <td className="text-xs text-gray-500">{a.department || '-'}</td>
              <td className="text-xs text-gray-500">{a.role}</td>
              <td>
                <button type="button" onClick={() => setEditing(a)} aria-label={`Select templates for ${a.name}`}
                  className="w-full min-w-[240px] rounded-lg border border-gray-200 hover:border-blue-400 p-2.5 text-left flex items-center gap-3">
                  <span className="flex flex-wrap gap-1.5 flex-1">
                    {(a.templates || []).map(t => <span key={t.id} className="rounded-md bg-blue-50 text-blue-800 px-2 py-1 text-xs">{t.name}{t.active === 0 ? ' (inactive)' : ''}</span>)}
                    {!a.templates?.length && <span className="text-sm text-gray-400">Select templates…</span>}
                  </span>
                  <FiEdit2 className="text-gray-400 shrink-0" size={14} />
                </button>
              </td>
            </tr>
          ))}
          {!visible.length && <tr><td colSpan={4} className="text-center text-gray-400 py-6">No employees found.</td></tr>}
        </tbody>
      </NumberedTable></div>
      {editing && <TemplateAssignmentPicker key={editing.user_id} employee={editing} templates={templates} onSaved={onSaved} onClose={() => setEditing(null)} />}
    </div>
  );
}

// ---------- Metric Explainer Modal (ℹ️ button) ----------
function MetricExplainerModal({ kpi, onClose }) {
  if (!kpi) return null;
  const src = sourceInfoFor(kpi.data_source) || {};
  const isAuto = kpi.is_auto || (kpi.data_source && kpi.data_source.startsWith('auto:'));
  const isHigher = kpi.direction !== 'lower_better';

  return (
    <Modal isOpen onClose={onClose} title={`KPI Guide: ${kpi.metric_name}`} wide>
      <div className="space-y-4 text-xs">
        {/* Banner */}
        <div className="p-3 bg-gradient-to-r from-indigo-50 to-blue-50 border border-indigo-100 rounded-lg flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="text-sm font-bold text-gray-900 flex items-center gap-2">
              <span>{kpi.metric_name}</span>
              <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${isHigher ? 'bg-emerald-100 text-emerald-800' : 'bg-blue-100 text-blue-800'}`}>
                {isHigher ? '↑ Higher is Better' : '↓ Lower is Better'}
              </span>
              {isAuto && <span className="px-1.5 py-0.5 bg-blue-100 text-blue-700 rounded text-[9px] font-bold">AUTO</span>}
            </div>
            <div className="text-gray-500 text-[11px] mt-0.5">
              {kpi.department ? `${kpi.department} · ` : ''}{kpi.template_name || 'Role KPI'} · Weight: <b>{kpi.weightage || kpi.weight || 0}%</b>
            </div>
          </div>
        </div>

        {/* 4 Explainer Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {/* Card 1: Purpose */}
          <div className="card p-3 bg-white border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-gray-800 text-xs">
              <span className="text-indigo-600">📌</span> What This Metric Measures
            </div>
            <p className="text-gray-600 leading-relaxed">
              {src.desc || `Evaluates performance for ${kpi.metric_name}. Planned targets are compared against verified achievements recorded in the ERP.`}
            </p>
          </div>

          {/* Card 2: Planned */}
          <div className="card p-3 bg-white border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-gray-800 text-xs">
              <span className="text-blue-600">🎯</span> How Target (Planned) is Set
            </div>
            <p className="text-gray-600 leading-relaxed">
              {kpi.target_auto
                ? (src.plan || 'Calculated automatically by ERP based on active cohort.')
                : (kpi.has_target_override
                  ? `Specific weekly target override set for this employee: ${kpi.planned || 0}.`
                  : `Standard weekly target defined in the role template (${kpi.planned || 0}).`)}
            </p>
          </div>

          {/* Card 3: Actual */}
          <div className="card p-3 bg-white border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-gray-800 text-xs">
              <span className="text-emerald-600">✅</span> How Achievement (Actual) is Counted
            </div>
            <p className="text-gray-600 leading-relaxed">
              {src.actual || 'Actual achievement recorded for the Mon–Sat week cohort.'}
            </p>
          </div>

          {/* Card 4: How to Score 100% */}
          <div className="card p-3 bg-white border border-slate-200 space-y-1">
            <div className="flex items-center gap-1.5 font-bold text-gray-800 text-xs">
              <span className="text-amber-600">💡</span> How to Achieve 100%
            </div>
            <p className="text-gray-600 leading-relaxed">
              {src.tip || 'Complete and submit all scheduled activities before Saturday end-of-day. Ensure the approver reviews and signs off on your completed tasks.'}
            </p>
          </div>
        </div>

        {/* Footer info */}
        <div className="p-2.5 bg-gray-50 border rounded text-[11px] text-gray-500 flex items-center justify-between">
          <span>Formula: <b>Variance % = ((Actual − Planned) ÷ Planned) × 100</b></span>
          <button type="button" onClick={onClose} className="btn btn-secondary text-xs py-1 px-3">Close</button>
        </div>
      </div>
    </Modal>
  );
}
