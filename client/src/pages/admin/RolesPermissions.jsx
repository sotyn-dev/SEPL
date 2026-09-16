import { useState, useEffect, useLayoutEffect, useRef, Fragment } from 'react';
import api from '../../api';
import Modal from '../../components/Modal';
import toast from 'react-hot-toast';
import { FiPlus, FiEdit2, FiTrash2, FiShield, FiCheck, FiX, FiPower, FiArrowLeft, FiChevronRight } from 'react-icons/fi';
import { useModuleFlags } from '../../context/ModuleFlagsContext';

// Order + labels mirror the sidebar so admins recognise each module
// at a glance. Keys (used by backend role_permissions) stay unchanged —
// renaming 'Procurement' to 'Indent to Dispatch' is UI-only.
// Mam (2026-05-21): "add all module in roles& permission".  Keep this
// list in sync with server/db/schema.js ALL_MODULES — every module
// permission-gated in the SOTYN.AI needs a row here so admin can grant /
// revoke access.  Grouped by sidebar section for readability; keys
// (used by backend role_permissions) are unchanged.
const ALL_MODULES = [
  { key: 'project_profit', label: 'Project Profit & Loss' },
  // — Finance & Daily Operations
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'cashflow', label: 'Bank — cash ledger (the Cash Flow page was removed 2026-09-03; this key still gates Bank)' },
  { key: 'cheques', label: 'Cheque FMS' },
  { key: 'payment_required', label: 'Payment Required' },
  { key: 'attendance', label: 'Attendance' },
  { key: 'attendance_grid', label: 'Attendance Monthly Grid — view the monthly muster' },
  { key: 'collections', label: 'Collection Engine' },
  { key: 'ar_ap_tracker', label: 'Cash Flow Tracker — weekly AR/AP forecast, auto-fed from Collections + Payables' },
  { key: 'site_chat', label: 'SOTYN Chat — create/manage groups (chatting is open to all)' },
  { key: 'sotyn_flow', label: "SOTYN Flow — Create = create & own boards. See All = view & contribute (cards, comments) on every board, not just your own. Board settings, members & lists stay board-admin only." },
  { key: 'dpr', label: 'DPR' },
  { key: 'indent_labour_payment', label: 'Indent Labour Payment' },
  { key: 'drawing_tracker', label: 'Drawing Tracker — drawings + revision history (delete = cancel a revision)' },
  { key: 'labour_payment', label: 'Labour Payment Indents' },
  { key: 'delegations', label: 'Delegations' },
  { key: 'pms_tasks', label: 'PMS Tasks' },
  { key: 'checklists', label: 'Checklists' },
  // Was missing here (drift audit 2026-09-01) — the module was gated on the
  // server but admins had no row to grant it from.
  { key: 'tally_bills', label: 'Tally Bills — Create=upload · Edit=record payment · Approve=task-done + approve/hold/reject' },

  // — Sales & CRM
  { key: 'leads', label: 'Sales Funnel' },
  { key: 'crm_funnel', label: 'CRM Sales Funnel' },
  // Sotyn Leads (2026-09-07). Same drift trap as tally_bills above: the key is
  // gated on the server, so without a row here nobody but Admin could ever be
  // granted it. Convert also needs 'leads' Create — it writes a real funnel lead.
  { key: 'sotyn_leads', label: 'Sotyn Leads — sotyn.ai website enquiries · Create=Convert to a Sales Funnel lead (also needs Sales Funnel Create) · Edit=status/owner/remarks · Delete=bin junk' },
  { key: 'fire_noc', label: 'Fire NOC Renewal' },
  { key: 'rental_tools', label: 'Rental Tools' },
  { key: 'influencers', label: 'Influencers' },
  { key: 'crm_kitting', label: 'CRM Full Kitting' },
  { key: 'quotations', label: 'BOQ & Quotations' },
  { key: 'ai_quotation', label: 'AI Auto-Quotation' },
  { key: 'labour_rates', label: 'Labour Rate Sheet' },

  // — Labour Management System (2026-08).
  // 'indent_labour_payment' above already gates Projects & Work Orders and is
  // deliberately left alone: roles already carry grants against that key, and
  // renaming it would silently revoke access for everyone who has it.
  { key: 'labour_quotation', label: 'Labour Quotations — can_approve generates the Work Order' },
  { key: 'labour_rate_master', label: 'Labour Rate Master — HR maintains; others read-only' },
  { key: 'labour_master', label: 'Labour Master — roster, attendance, transfers, wage register' },
  { key: 'bill_verification', label: 'Bill Verification — 6-stage chain, Bills & Finance, Payments' },
  { key: 'business_book', label: 'Business Book' },

  // — Solar Division (PR #2: Funnel / Quotation / Projects / Masters)
  { key: 'solar_quotation', label: 'Solar Division (Funnel / Quotation / Projects / Masters)' },

  // — Materials, Vendors, Procurement
  { key: 'item_master', label: 'Item Master' },
  { key: 'orders', label: 'Orders & Planning' },
  { key: 'vendors', label: 'Vendors' },
  { key: 'sub_contractors', label: 'Sub-Contractors' },
  { key: 'customers', label: 'Customers' },
  { key: 'procurement', label: 'Indent to Dispatch' },
  { key: 'sales_bill_receive', label: 'Sales Bill Receive' },
  { key: 'procurement_schedule', label: 'Schedule (Gantt)' },
  { key: 'indent_fms', label: 'Indent FMS (legacy)' },
  { key: 'inventory', label: 'Inventory' },

  // — Execution / Site
  { key: 'installation', label: 'Installation' },
  { key: 'billing', label: 'Billing' },
  { key: 'client_snag', label: 'Client Snag — bill missing client signature (upload = Ajmer only, approve/reject = Lovely Sharma only, see the Reassign panel on the page)' },
  { key: 'complaints', label: 'Complaints' },
  { key: 'snags', label: 'Snag List' },
  { key: 'company_assets', label: 'Company Assets' },
  { key: 'help_tickets', label: 'Help Tickets' },

  // — HR / People
  { key: 'hr_system', label: 'HR System (recruitment / ATS / offers)' },
  { key: 'subcon_hiring', label: 'Sub-contractor Hiring' },
  { key: 'hr', label: 'HR & Hiring (legacy)' },
  { key: 'employee_salary', label: 'Employee Salary — see salary field' },
  { key: 'hr_team', label: 'HR Team — member (hiring + HR alerts)' },
  { key: 'payroll', label: 'Payroll' },
  { key: 'scoring', label: 'Weekly Score' },
  { key: 'gamification', label: 'Champions League (Gamification)' },
  { key: 'tools', label: 'Tools Management' },
  { key: 'rentals', label: 'Room Rentals' },
  { key: 'employees', label: 'Employees' },
  { key: 'expenses', label: 'Expenses' },

  // — ERP Management (2026-09) — System Flow & Implementation Control.
  // View = dashboards/flows + update OWN tasks · Create = create flows ·
  // Edit = edit any flow + manage Step/Process masters + ERP links ·
  // Approve = override an incomplete-dependency completion.
  { key: 'system_flow', label: 'System Flow (ERP Management) — build tracker, bottlenecks, step master' },

  // — Platform
  { key: 'ai_agent', label: 'AI Agent (Ask SOTYN.AI)' },
  { key: 'users', label: 'User Management' },
];

const ACTIONS = [
  { key: 'can_view', label: 'View', color: 'text-red-600' },
  { key: 'can_create', label: 'Create', color: 'text-emerald-600' },
  { key: 'can_edit', label: 'Edit', color: 'text-amber-600' },
  { key: 'can_delete', label: 'Delete', color: 'text-red-600' },
  { key: 'can_approve', label: 'Approve', color: 'text-purple-600' },
  // can_see_all: explicit "scope=ALL records" toggle (decoupled from approve).
  // When OFF (default), users with this role only see records they raised /
  // own. When ON, they see every record in the module like an approver does.
  // Useful for auditor-style roles that need full read but no approval power.
  { key: 'can_see_all', label: 'See All', short: 'S', color: 'text-blue-600' },
];

// Remembers which role was open so a RELOAD mid-edit doesn't dump you back on the roles
// list. sessionStorage rather than the URL: no browser-history entries, and it clears
// itself when the tab closes.
//
// Restoring is deliberately limited to a genuine page reload (F5 / browser refresh).
// Arriving from another page must always start on the roles list — silently re-opening
// a role you didn't choose reads as "I'm editing something I never picked".
// `restoreConsumed` makes this fire at most once per full page load, so a later
// client-side navigation back to this screen is treated as a fresh visit.
const LAST_ROLE_KEY = 'roles_perm_last_role_id';
let restoreConsumed = false;
const isPageReload = () => {
  try { return performance.getEntriesByType('navigation')[0]?.type === 'reload'; }
  catch { return false; }
};

// One toggle cell, shared by the mobile (two-row) and desktop (one-row) layouts so the
// two renderings can never drift apart. N/A cells render as a non-interactive dash.
function PermCell({ p, a, onToggle }) {
  if (!actionApplies(p.module, a.key)) return (
    <span
      title="Not used for SOTYN Flow — board members can always view & contribute; a board's own admins manage its edits, members and deletion."
      className="inline-flex w-8 h-8 items-center justify-center mx-auto text-gray-300 select-none cursor-default"
    >–</span>
  );
  return (
    <button
      onClick={() => onToggle(p.module, a.key)}
      aria-label={`${a.label} — ${p.module}`}
      aria-pressed={!!p[a.key]}
      className={`w-8 h-8 rounded-lg flex items-center justify-center mx-auto transition-colors ${p[a.key] ? 'bg-emerald-100 text-emerald-600 hover:bg-emerald-200' : 'bg-gray-100 text-gray-300 hover:bg-gray-200'}`}
    >
      {p[a.key] ? <FiCheck size={16} /> : <FiX size={14} />}
    </button>
  );
}

// Modules whose access isn't a full CRUD matrix. Only the listed action columns
// do anything; the rest render as N/A. sotyn_flow: view/contribute is by board
// membership (no role perm) and edit/delete/members are per-board (board admin) —
// so only Create (make boards) and See All (see every board) are role-level.
const MODULE_ACTIONS = { sotyn_flow: ['can_create', 'can_see_all'] };
const actionApplies = (moduleKey, actionKey) =>
  !MODULE_ACTIONS[moduleKey] || MODULE_ACTIONS[moduleKey].includes(actionKey);

export default function RolesPermissions() {
  const [roles, setRoles] = useState([]);
  const [selectedRole, setSelectedRole] = useState(null);
  const [permissions, setPermissions] = useState([]);
  const [modal, setModal] = useState(false);
  const [roleForm, setRoleForm] = useState({ name: '', description: '' });
  const [editingRole, setEditingRole] = useState(null);
  const [saving, setSaving] = useState(false);

  // Global module availability (see server/lib/features.js). A switched-off module is
  // hidden from the matrix below, but its role_permissions rows are NEVER deleted — so
  // every grant comes back exactly as it was when the module is switched on again.
  const { modules: killableModules, access: moduleAccess, refresh: refreshFlags } = useModuleFlags();
  const moduleVisible = (key) => moduleAccess(key).ok;
  const visiblePermissions = permissions.filter(p => moduleVisible(p.module));
  const [flagBusy, setFlagBusy] = useState(null);
  const [modulesModal, setModulesModal] = useState(false);

  // The card header (role name + actions) and the table's column header pin as ONE block,
  // at every breakpoint. The column header therefore has to sit exactly `headerHeight`
  // below the pin point — measured, not hardcoded, because that height changes with the
  // role name wrapping, the subtitle, and the breakpoint. Both are additionally offset by
  // <main>'s own padding (p-2 → 8px, md:p-6 → 24px) so they pin flush to the container
  // edge instead of leaving a band where rows show above them.
  const headRef = useRef(null);
  const [theadTop, setTheadTop] = useState(null);   // px; null = fall back to CSS classes

  useLayoutEffect(() => {
    const mdQ = window.matchMedia('(min-width: 768px)');
    const compute = () => {
      if (!headRef.current) return setTheadTop(null);
      const mainPad = mdQ.matches ? 24 : 8;
      setTheadTop(headRef.current.offsetHeight - mainPad);
    };
    compute();
    const ro = new ResizeObserver(compute);
    if (headRef.current) ro.observe(headRef.current);
    mdQ.addEventListener('change', compute);
    return () => { ro.disconnect(); mdQ.removeEventListener('change', compute); };
  }, [selectedRole]);

  const toggleModule = async (key, enabled) => {
    setFlagBusy(key);
    try {
      await api.put(`/module-flags/${key}`, { enabled });
      await refreshFlags();
      toast.success(`${killableModules.find(m => m.key === key)?.label || key} ${enabled ? 'enabled' : 'disabled'}`);
    } catch (err) {
      toast.error(err.response?.data?.error || 'Failed to update module');
    }
    setFlagBusy(null);
  };

  const loadRoles = () => api.get('/auth/roles').then(r => { setRoles(r.data); return r.data; });

  // Re-open the role that was being edited — ONLY after a real page reload, and at most
  // once per page load. Navigating here from elsewhere always lands on the roles list.
  useEffect(() => {
    loadRoles().then(list => {
      // Either branch below lands on the roles list, so drop the remembered id — leaving
      // it would let a LATER reload re-open a role the user never chose this visit.
      // selectRole() re-writes it the moment they actually pick one.
      if (restoreConsumed || !isPageReload()) { sessionStorage.removeItem(LAST_ROLE_KEY); return; }
      restoreConsumed = true;
      const id = Number(sessionStorage.getItem(LAST_ROLE_KEY));
      const role = id && (list || []).find(r => r.id === id);
      if (role) selectRole(role, { restore: true });
    });
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // <main> is the page's scroll container, not the window — scrolling the window here does
  // nothing. Used after actions that change what's on screen, so you don't end up parked at
  // an offset that no longer has content under it. Instant, not smooth: `behavior:'smooth'`
  // is silently ignored on this container in some browsers (verified), and a scroll that
  // only sometimes happens is worse than one that always does.
  const scrollPanelTop = () => document.querySelector('main')?.scrollTo(0, 0);

  const backToRoles = () => {
    setSelectedRole(null);
    setPermissions([]);
    sessionStorage.removeItem(LAST_ROLE_KEY);
    scrollPanelTop();          // the matrix is gone; stay put and you'd stare at blank space
  };

  const selectRole = async (role, { restore = false } = {}) => {
    setSelectedRole(role);
    sessionStorage.setItem(LAST_ROLE_KEY, String(role.id));
    // On mobile the matrix REPLACES the roles list (drill-down), so start it at the
    // top instead of wherever the list happened to be scrolled to. Skipped when
    // restoring after a reload, where the browser handles scroll itself.
    if (!restore) scrollPanelTop();
    const { data } = await api.get(`/auth/roles/${role.id}/permissions`);
    // Build full permission matrix
    const permMap = {};
    for (const p of data) permMap[p.module] = p;
    const fullPerms = ALL_MODULES.map(m => ({
      module: m.key,
      can_view: permMap[m.key]?.can_view || 0,
      can_create: permMap[m.key]?.can_create || 0,
      can_edit: permMap[m.key]?.can_edit || 0,
      can_delete: permMap[m.key]?.can_delete || 0,
      can_approve: permMap[m.key]?.can_approve || 0,
      can_see_all: permMap[m.key]?.can_see_all || 0,
    }));
    setPermissions(fullPerms);
  };

  const togglePerm = (moduleKey, actionKey) => {
    if (!actionApplies(moduleKey, actionKey)) return;   // N/A cell — not togglable
    setPermissions(prev => prev.map(p => {
      if (p.module !== moduleKey) return p;
      const newVal = p[actionKey] ? 0 : 1;
      // If enabling any action, also enable view — but only when View applies to
      // this module (sotyn_flow has no role-level view; access is by membership).
      if (newVal && actionKey !== 'can_view' && actionApplies(moduleKey, 'can_view')) {
        return { ...p, [actionKey]: newVal, can_view: 1 };
      }
      // If disabling view, disable all (including the new can_see_all)
      if (!newVal && actionKey === 'can_view') {
        return { ...p, can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0, can_see_all: 0 };
      }
      return { ...p, [actionKey]: newVal };
    }));
  };

  const toggleAll = (actionKey) => {
    // Only consider rows where this action actually applies (skip N/A cells) AND that
    // are actually on screen — a switched-off module's row is hidden, so a "toggle
    // column" click must not silently rewrite permissions the admin can't see.
    const applicable = visiblePermissions.filter(p => actionApplies(p.module, actionKey));
    const allEnabled = applicable.length > 0 && applicable.every(p => p[actionKey]);
    setPermissions(prev => prev.map(p => {
      if (!actionApplies(p.module, actionKey)) return p;   // leave N/A cells untouched
      if (!moduleVisible(p.module)) return p;              // hidden module — never touched
      if (allEnabled) {
        if (actionKey === 'can_view') return { ...p, can_view: 0, can_create: 0, can_edit: 0, can_delete: 0, can_approve: 0 };
        return { ...p, [actionKey]: 0 };
      } else {
        if (actionKey !== 'can_view') return { ...p, [actionKey]: 1, can_view: 1 };
        return { ...p, [actionKey]: 1 };
      }
    }));
  };

  const savePermissions = async () => {
    if (!selectedRole) return;
    setSaving(true);
    try {
      await api.put(`/auth/roles/${selectedRole.id}/permissions`, { permissions });
      toast.success(`Permissions saved for "${selectedRole.name}"`);
      // Return to the top so the role name and its header are back in view — otherwise a
      // save from row 40 leaves you mid-table with only a toast to go on.
      scrollPanelTop();
    } catch (err) {
      toast.error('Failed to save');   // stay put on failure — the user may want to retry
    }
    setSaving(false);
  };

  const saveRole = async (e) => {
    e.preventDefault();
    try {
      if (editingRole) {
        await api.put(`/auth/roles/${editingRole.id}`, roleForm);
        toast.success('Role updated');
      } else {
        await api.post('/auth/roles', roleForm);
        toast.success('Role created');
      }
      setModal(false);
      loadRoles();
    } catch (err) {
      toast.error(err.response?.data?.error || 'Error');
    }
  };

  const deleteRole = async (role) => {
    if (role.is_system) return toast.error('Cannot delete system role');
    if (!confirm(`Delete role "${role.name}"? Users with this role will lose their permissions.`)) return;
    await api.delete(`/auth/roles/${role.id}`);
    toast.success('Role deleted');
    if (selectedRole?.id === role.id) backToRoles();
    loadRoles();
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <h3 className="text-xl font-bold text-gray-800">Roles & Permissions</h3>
          <p className="text-sm text-gray-500">Define roles and customize what each role can view, create, edit, delete, or approve in each module</p>
        </div>
        {/* Module availability is a different job from editing a role's permissions, so it
            lives behind a button rather than as a panel competing for the same screen. */}
        {killableModules.length > 0 && (
          <button onClick={() => setModulesModal(true)} className="btn btn-secondary flex items-center gap-2 flex-shrink-0 self-start">
            <FiPower size={14} /> Module availability
          </button>
        )}
      </div>

      {/* Below `lg` this is a master-detail drill-down, not a stack: the roles list and
          the matrix swap places so you never scroll past 50 modules to change role.
          Same approach as the chat list/thread in SiteChat.jsx. At `lg` and above both
          panes are always visible, so the conditional classes never apply. */}
      {/* lg:items-start — grid children stretch to the tallest sibling by default. Now
          that the matrix scrolls inside a height-capped box, stretching left a block of
          dead white space below it whenever the roles list was taller. Top-align instead
          so each panel is its own natural height. */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 lg:items-start">
        {/* Roles List */}
        <div className={`card lg:col-span-1 p-0 ${selectedRole ? 'hidden lg:block' : 'block'}`}>
          <div className="p-4 border-b flex items-center justify-between">
            <h4 className="font-semibold text-gray-700">Roles</h4>
            <button onClick={() => { setEditingRole(null); setRoleForm({ name: '', description: '' }); setModal(true); }} className="p-1.5 hover:bg-red-50 rounded text-red-600"><FiPlus size={18} /></button>
          </div>
          <div className="divide-y">
            {roles.map(r => (
              <div
                key={r.id}
                className={`p-3 cursor-pointer flex items-center justify-between group hover:bg-gray-50 ${selectedRole?.id === r.id ? 'bg-red-50 border-l-4 border-red-500' : ''}`}
                onClick={() => selectRole(r)}
              >
                <div>
                  <div className="text-sm font-medium flex items-center gap-2">
                    <FiShield size={14} className={selectedRole?.id === r.id ? 'text-red-600' : 'text-gray-400'} />
                    {r.name}
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">{r.description}</div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {!r.is_system && (
                    // Always visible on touch — `group-hover` alone never fires without a
                    // mouse, so edit/delete were unreachable on a phone. Hover behaviour
                    // is preserved from `lg` up.
                    <div className="flex lg:hidden lg:group-hover:flex gap-1">
                      <button onClick={(e) => { e.stopPropagation(); setEditingRole(r); setRoleForm({ name: r.name, description: r.description }); setModal(true); }} className="p-1.5 lg:p-1 hover:bg-red-100 rounded text-red-600"><FiEdit2 size={14} /></button>
                      <button onClick={(e) => { e.stopPropagation(); deleteRole(r); }} className="p-1.5 lg:p-1 hover:bg-red-100 rounded text-red-600"><FiTrash2 size={14} /></button>
                    </div>
                  )}
                  {/* Drill-down affordance — mobile only, where tapping swaps panes. */}
                  <FiChevronRight size={16} className="lg:hidden text-gray-300" />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Permissions Matrix.
            `!overflow-visible` overrides the global `.card:has(… table) { overflow-x: auto }`
            rule in index.css. That rule turns any table card into its own scroll container,
            which (a) creates a second scrollbar competing with the page and (b) breaks
            `position: sticky` on <thead>, because sticky resolves against the nearest
            scrollport — one that never scrolls vertically. Opting out means <main> is the
            ONLY scroller: one scrollbar, and the sticky head and Save bar both pin against
            it. The table fits without horizontal scroll at every breakpoint (mobile puts
            the module name on its own row), so nothing is lost by opting out. */}
        <div className={`card lg:col-span-3 p-0 !overflow-visible ${selectedRole ? 'block' : 'hidden lg:block'}`}>
          {selectedRole ? (
            <>
              {/* Pins as one block with the column header below it, so the role you're
                  editing stays identified through a 3000px table — on phone as well as
                  desktop. Opaque background required: rows scroll underneath it. */}
              <div ref={headRef}
                   className="p-3 sm:p-4 border-b flex items-center justify-between gap-2 bg-gradient-to-r from-blue-50 to-white sticky -top-2 md:-top-6 z-30 rounded-t-2xl">
                <div className="flex items-start gap-2 min-w-0">
                  <button
                    onClick={backToRoles}
                    className="lg:hidden -ml-1 mt-0.5 p-1 rounded hover:bg-white/60 text-gray-600 flex-shrink-0"
                    title="Back" aria-label="Back to roles"
                  ><FiArrowLeft size={20} /></button>
                  <div className="min-w-0">
                    <h4 className="font-semibold text-gray-800 truncate">Permissions for: <span className="text-blue-700">{selectedRole.name}</span></h4>
                    <p className="text-xs text-gray-500 mt-1">Click checkboxes to toggle permissions. Changes are saved when you click "Save Permissions".</p>
                  </div>
                </div>
                {/* Secondary-left / primary-right, matching the Cancel|Create order in this
                    page's own role modal — the dismissive action sits away from the one you
                    reach for by default, so Save stays the rightmost, largest target.
                    Both are labelled buttons: a bare X icon reads as chrome rather than a
                    choice, which is why Close was easy to miss. */}
                <div className="hidden lg:flex items-center gap-2 flex-shrink-0">
                  {/* Mobile has the back arrow on the left instead; desktop keeps both panes
                      on screen, so without this there was no way to leave a role once
                      opened — you could only switch to a different one. */}
                  <button onClick={backToRoles} className="btn btn-secondary flex items-center gap-1.5"
                          title="Close — back to role list" aria-label="Close selected role">
                    <FiX size={15} /> Close
                  </button>
                  <button onClick={savePermissions} disabled={saving} className="btn btn-primary flex items-center gap-2">
                    {saving ? 'Saving…' : 'Save Permissions'}
                  </button>
                </div>
              </div>
              {/* Deliberately NO height cap and NO overflow here: a scrollport on this div
                  would give the matrix its own vertical scrollbar competing with the page's.
                  <main> stays the single vertical scroller, so the roles list growing or the
                  Module availability card below simply extend that one scroll. */}
              <div>
                <table className="w-full">
                  {/* Negative offsets match <main>'s own padding (p-2 md:p-6). With a plain
                      top-0 the head pins at main's CONTENT edge, leaving a band of padding
                      above it where scrolling rows stay visible — a sliver of table peeking
                      over the header. Pinning that much higher covers the band. */}
                  <thead className="bg-gray-50 sticky -top-2 md:-top-6 z-20"
                         style={theadTop != null ? { top: `${theadTop}px` } : undefined}>
                    <tr>
                      {/* Mobile puts the module name on its own row above the controls, so
                          the Module column only exists from `lg` up. */}
                      <th className="hidden lg:table-cell px-4 py-3 text-left text-xs font-semibold text-gray-600 w-48">Module</th>
                      {ACTIONS.map(a => (
                        <th key={a.key} className="px-1 sm:px-3 py-3 text-center text-xs font-semibold text-gray-600">
                          <button onClick={() => toggleAll(a.key)} className={`hover:underline ${a.color}`} title={`Toggle ${a.label} for every module`}>
                            {a.label}
                          </button>
                        </th>
                      ))}
                    </tr>
                  </thead>

                  {/* ── Mobile: two rows per module ───────────────────────────────
                      R1 = the module name, full width (no truncation, no cramped
                      128px column); R2 = its six controls. Costs vertical space but
                      removes the squeeze that made long labels unreadable. */}
                  <tbody className="lg:hidden">
                    {visiblePermissions.map((p, i) => {
                      const mod = ALL_MODULES.find(m => m.key === p.module);
                      const rowBg = i % 2 === 0 ? 'bg-white' : 'bg-gray-50';
                      return (
                        <Fragment key={p.module}>
                          <tr className={rowBg}>
                            <td colSpan={ACTIONS.length} className="px-3 pt-2.5 pb-1 text-sm font-semibold text-gray-700 border-t">
                              {mod?.label || p.module}
                            </td>
                          </tr>
                          <tr className={rowBg}>
                            {ACTIONS.map(a => (
                              <td key={a.key} className="px-1 pb-2.5 pt-0 text-center align-top">
                                <PermCell p={p} a={a} onToggle={togglePerm} />
                              </td>
                            ))}
                          </tr>
                        </Fragment>
                      );
                    })}
                  </tbody>

                  {/* ── Desktop: unchanged one-row-per-module matrix ─────────────── */}
                  <tbody className="hidden lg:table-row-group">
                    {visiblePermissions.map((p, i) => {
                      const mod = ALL_MODULES.find(m => m.key === p.module);
                      return (
                        <tr key={p.module} className={i % 2 === 0 ? 'bg-white' : 'bg-gray-50/50'}>
                          <td className="px-4 py-3 text-sm font-medium text-gray-700">{mod?.label || p.module}</td>
                          {ACTIONS.map(a => (
                            <td key={a.key} className="px-3 py-3 text-center">
                              <PermCell p={p} a={a} onToggle={togglePerm} />
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Save is a sticky footer of THIS panel at every breakpoint. The table is
                  ~3000px tall, so a button in the card header scrolls out of reach on
                  desktop just as badly as on mobile. Sticky-inside-the-card (not `fixed`)
                  keeps it tied to the panel it acts on and confined to the panel's width,
                  so it never floats over the rest of the page. Bottom inset clears the
                  iOS home indicator. */}
              <div className="lg:hidden sticky bottom-0 z-30 p-3 bg-white/95 backdrop-blur border-t rounded-b-2xl"
                   style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
                <button onClick={savePermissions} disabled={saving} className="btn btn-primary w-full justify-center">
                  {saving ? 'Saving…' : `Save Permissions — ${selectedRole.name}`}
                </button>
              </div>
            </>
          ) : (
            <div className="p-12 text-center text-gray-400">
              <FiShield size={48} className="mx-auto mb-4 text-gray-300" />
              <h4 className="text-lg font-medium text-gray-500">Select a Role</h4>
              <p className="text-sm mt-1">Click a role from the left panel to view and edit its permissions</p>
            </div>
          )}
        </div>
      </div>

      {/* Module availability — the global on/off switch, one layer ABOVE the per-role
          matrix. In a modal so it can't be mistaken for part of the role being edited. */}
      <Modal isOpen={modulesModal} onClose={() => setModulesModal(false)} title="Module availability">
        <p className="text-xs text-gray-500">
          Switching a module off withdraws it from <b>everyone, including admins</b> — the sidebar link, the page and its data all become unavailable.
          Role settings are kept and restored when you switch it back on.
        </p>
        <div className="mt-3 divide-y border-t">
          {killableModules.map(m => (
            <div key={m.key} className={`flex items-center justify-between py-3 gap-4 ${m.dormant ? 'opacity-60' : ''}`}>
              <div className="min-w-0">
                <div className="text-sm font-medium text-gray-700 flex items-center gap-2 flex-wrap">
                  {m.label}
                  {m.dormant && (
                    <span className="text-[10px] font-medium uppercase tracking-wide text-amber-700 bg-amber-50 border border-amber-200 px-1.5 py-0.5 rounded">
                      Not deployed
                    </span>
                  )}
                </div>
                {m.description && <div className="text-xs text-gray-500">{m.description}</div>}
              </div>
              <button
                onClick={() => !m.dormant && toggleModule(m.key, !m.enabled)}
                disabled={m.dormant || flagBusy === m.key}
                role="switch" aria-checked={m.enabled} aria-label={`${m.label} availability`}
                title={m.dormant ? 'Reserved — enable after the module is deployed' : (m.enabled ? 'Switch off for the whole organisation' : 'Switch on')}
                className={`relative inline-flex h-6 w-11 flex-shrink-0 rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${m.enabled ? 'bg-emerald-500' : 'bg-gray-300'}`}
              >
                <span className={`inline-block h-5 w-5 mt-0.5 rounded-full bg-white shadow transition-transform ${m.enabled ? 'translate-x-[22px]' : 'translate-x-0.5'}`} />
              </button>
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-4">
          <button onClick={() => setModulesModal(false)} className="btn btn-secondary">Done</button>
        </div>
      </Modal>

      {/* Role Create/Edit Modal */}
      <Modal isOpen={modal} onClose={() => setModal(false)} title={editingRole ? 'Edit Role' : 'Create New Role'}>
        <form onSubmit={saveRole} className="space-y-4">
          <div><label className="label">Role Name *</label><input className="input" value={roleForm.name} onChange={e => setRoleForm({...roleForm, name: e.target.value})} required placeholder="e.g. Project Manager" /></div>
          <div><label className="label">Description</label><input className="input" value={roleForm.description} onChange={e => setRoleForm({...roleForm, description: e.target.value})} placeholder="Brief description of this role" /></div>
          <div className="flex justify-end gap-3">
            <button type="button" onClick={() => setModal(false)} className="btn btn-secondary">Cancel</button>
            <button type="submit" className="btn btn-primary">{editingRole ? 'Update' : 'Create'}</button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
