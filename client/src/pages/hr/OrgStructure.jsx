import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FiPlus, FiEdit2, FiTrash2, FiChevronRight, FiChevronDown, FiCornerDownRight,
  FiUserPlus, FiStar, FiSlash, FiCheckCircle, FiMoreVertical, FiX, FiHelpCircle, FiRefreshCw, FiLayers,
} from 'react-icons/fi';
import api from '../../api';
import toast from 'react-hot-toast';
import { useAuth } from '../../context/AuthContext';
import Modal from '../../components/Modal';
import PeoplePicker from '../../components/PeoplePicker';
import DepartmentPicker from '../../components/DepartmentPicker';
import OrgStructureGuide from './OrgStructureGuide';
import usePeopleOptions from '../../hooks/usePeopleOptions';
import { invalidateDepartments } from '../../hooks/useDepartmentTree';

// Org Structure (Phase B) — Departments tree · Designations catalog · Openings.
// Talks to /api/org-structure (gated by org_structure). Reuses PeoplePicker
// (set-head = employee, reports-to = user) and DepartmentPicker (move / opening).

const DESIG_PILL = {
  present: ['badge-green', 'Present'],
  not_wanted: ['badge-gray', 'Not wanted'],
  planned: ['badge-yellow', 'Planned'],
};
const OPENING_PILL = {
  open: ['badge-red', 'Open'],
  filled: ['badge-green', 'Filled'],
  on_hold: ['badge-yellow', 'On hold'],
  closed: ['badge-gray', 'Closed'],
};
const errMsg = (e, fallback) => e?.response?.data?.error || fallback;
const clean = (s) => (s || '').trim();   // single source of truth for input trimming

export default function OrgStructure() {
  const { isAdmin, canDelete } = useAuth();
  const canLoadTemplate = isAdmin() || canDelete('org_structure');
  const [view, setView] = useState('departments'); // departments | designations | openings
  const [tree, setTree] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [openings, setOpenings] = useState([]);
  const [openIds, setOpenIds] = useState(() => new Set());
  const [modal, setModal] = useState(null); // { kind, ...ctx }
  const [confirmBox, setConfirmBox] = useState(null); // { message, onYes }
  const [guideOpen, setGuideOpen] = useState(false);
  // Load Template — a LIST of catalogs (db/orgTemplate.js TEMPLATES), all
  // picked inside one self-contained "Pick Template" popover (list + footer
  // actions live together, per dme 2026-08-03 — see TemplatePicker below).
  // Adding a second/third template needs no UI change, just another entry in
  // orgTemplate.js. Preview is optional (Set works without it) and, once
  // fetched, feeds Set's confirm dialog with real numbers instead of a
  // generic warning.
  const [templates, setTemplates] = useState([]);
  const [templateSetAllowed, setTemplateSetAllowed] = useState(true);
  const [templateSetBlockedReason, setTemplateSetBlockedReason] = useState(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [templatePreview, setTemplatePreview] = useState(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const emp = usePeopleOptions('employee');
  const usr = usePeopleOptions('user');

  const seededRef = useRef(false);
  const loadTree = useCallback(() => api.get('/org-structure/departments')
    .then(r => {
      setTree(r.data);
      // First load: expand every node so the whole structure is visible; the
      // user collapses what they don't need. (Only seeds once — later reloads
      // preserve whatever the user has expanded/collapsed.)
      if (!seededRef.current && r.data.length) {
        seededRef.current = true;
        const ids = []; const walk = (ns) => (ns || []).forEach(n => { ids.push(n.id); walk(n.children); });
        walk(r.data);
        setOpenIds(new Set(ids));
      }
    }).catch(e => toast.error(errMsg(e, 'Failed to load departments'))), []);
  const loadDesig = useCallback(() => api.get('/org-structure/designations')
    .then(r => setDesignations(r.data)).catch(e => toast.error(errMsg(e, 'Failed to load designations'))), []);
  // Openings — recruitment planning, not a mandatory field. Tab hidden below
  // (Mandatory Field Spec HR pack, plan: keep-confirmation-status-separate-
  // elegant-beacon). The endpoints stay mounted with the router; nothing on
  // this page calls them anymore, so `openings` stays [] and loadOpenings is
  // kept (unused) only so re-enabling the tab later is a one-line revert.
  // eslint-disable-next-line no-unused-vars
  const loadOpenings = useCallback(() => api.get('/org-structure/openings')
    .then(r => setOpenings(r.data)).catch(e => toast.error(errMsg(e, 'Failed to load openings'))), []);

  useEffect(() => { loadTree(); loadDesig(); }, [loadTree, loadDesig]);
  useEffect(() => {
    if (!canLoadTemplate) return;
    api.get('/org-structure/templates').then((r) => {
      const data = r.data;
      // Object shape (Plan B.0 P0) — array fallback if an older server replies.
      if (Array.isArray(data)) {
        setTemplates(data);
        setTemplateSetAllowed(true);
        setTemplateSetBlockedReason(null);
      } else {
        setTemplates(data.templates || []);
        setTemplateSetAllowed(data.setAllowed !== false);
        setTemplateSetBlockedReason(data.setBlockedReason || null);
      }
    }).catch(e => toast.error(errMsg(e, 'Failed to load templates')));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canLoadTemplate]);

  const toggleOpen = (id) => setOpenIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // DRY mutation helpers — one error path, one confirm path, used everywhere.
  const mutate = useCallback((promise, after) => promise
    .then((r) => { after?.(); return r; })
    .catch(e => toast.error(errMsg(e, 'Failed'))), []);
  // In-app confirm (window.confirm is BLOCKED in the embedded preview iframe →
  // silently returned false, so × / delete did nothing). Renders a real modal.
  const confirm = useCallback((message, onYes, opts) => setConfirmBox({ message, onYes, ...opts }), []);
  const confirmDelete = useCallback((message, doDelete, after) => {
    confirm(message, () => doDelete().then(() => { toast.success('Deleted'); after?.(); }).catch(e => toast.error(errMsg(e, 'Failed'))), { title: 'Delete', confirmLabel: 'Delete' });
  }, [confirm]);

  const afterDeptChange = useCallback(() => { loadTree(); invalidateDepartments(); }, [loadTree]);

  // Selecting a template in the picker drops any stale preview from
  // whichever one was previously selected.
  const chooseTemplate = useCallback((id) => {
    setSelectedTemplateId(id);
    setTemplatePreview(null);
  }, []);
  // Closing the picker without applying anything — reset to a blank slate so
  // reopening it always starts at the list, never a stale preview.
  const closeTemplatePicker = useCallback(() => {
    setSelectedTemplateId('');
    setTemplatePreview(null);
  }, []);

  // "Preview" — read-only, mutates nothing (GET /template/preview for the
  // SELECTED template). Optional: Set works fine without ever calling this.
  // When present, its numbers feed Set's confirm dialog instead of a generic
  // warning.
  const previewTemplate = useCallback(() => {
    if (!selectedTemplateId) return;
    setPreviewLoading(true);
    api.get('/org-structure/template/preview', { params: { id: selectedTemplateId } })
      .then((r) => setTemplatePreview(r.data))
      .catch((e) => toast.error(errMsg(e, 'Failed to preview template')))
      .finally(() => setPreviewLoading(false));
  }, [selectedTemplateId]);

  // "Set" — bootstrap only. Server blocks once employees exist; client
  // disables Set when templates payload says setAllowed=false.
  const setTemplate = useCallback(() => {
    if (!selectedTemplateId) return;
    if (!templateSetAllowed) {
      toast.error(templateSetBlockedReason || 'Template Set is for initial structure only.');
      return;
    }
    const tplName = templates.find((t) => t.id === selectedTemplateId)?.name || 'this template';
    const p = templatePreview;
    const detail = p
      ? `This will remove ${p.departmentsToRemove.length} department${p.departmentsToRemove.length === 1 ? '' : 's'}${p.departmentsToRemove.length ? ` (${p.departmentsToRemove.join(', ')})` : ''} and replace all ${p.currentDesignationCount} designation(s) with ${p.newDesignationCount} from “${tplName}”. This cannot be undone.`
      : `This replaces the entire designation catalog and removes any department outside the standard 5 groups + 11 with “${tplName}”. This cannot be undone.`;
    confirm(
      detail,
      () => mutate(
        api.post('/org-structure/template/load', { id: selectedTemplateId }).then((r) => {
          const { departmentsRemoved, designationsRemoved, designationsAdded } = r.data;
          toast.success(`“${tplName}” loaded — removed ${departmentsRemoved} department(s), replaced ${designationsRemoved} designation(s) with ${designationsAdded}`);
          setTemplatePreview(null);
          setSelectedTemplateId('');
        }),
        () => { loadTree(); loadDesig(); invalidateDepartments(); },
      ),
      { title: 'Load Template', confirmLabel: 'Set' },
    );
  }, [selectedTemplateId, templates, templatePreview, templateSetAllowed, templateSetBlockedReason, confirm, mutate, loadTree, loadDesig]);

  // name → tag/short-code lookup, so a head's designation can show as its alias
  // (e.g. "MD") with the full title on hover. Custom/legacy titles with no catalog
  // match just render as-is.
  const tagByName = useMemo(() => {
    const m = new Map();
    designations.forEach(d => { if (d.tag_name) m.set(d.name.trim().toLowerCase(), d.tag_name); });
    return m;
  }, [designations]);

  // Openings tab hidden (see loadOpenings comment above) — recruitment
  // planning is out of scope for the Mandatory Field Spec HR pack.
  const tabs = [
    ['departments', 'Departments'],
    ['designations', 'Designations'],
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 max-md:flex-col">
        <div>
          <h1 className="text-xl font-bold text-gray-900">Org Structure</h1>
          <p className="text-sm text-gray-500">Departments, the designation catalog, and open positions.</p>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button className="btn btn-secondary text-sm" onClick={() => setGuideOpen(true)}>
            <FiHelpCircle className="inline -mt-0.5 mr-1" />Guide
          </button>
          {/* Rightmost — its popover opens right-anchored (right-0), so being
              the last/right-most trigger keeps the panel from having to
              reach left past other controls on narrow screens. */}
          {canLoadTemplate && (
            <TemplatePicker
              templates={templates} selectedId={selectedTemplateId} onSelect={chooseTemplate} onClose={closeTemplatePicker}
              preview={templatePreview} previewLoading={previewLoading} onPreview={previewTemplate} onSet={setTemplate}
              setAllowed={templateSetAllowed} setBlockedReason={templateSetBlockedReason}
            />
          )}
        </div>
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${view === key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-[calc(100vh-290px)]">
      {view === 'departments' && (
        <DepartmentsTab
          tree={tree} openIds={openIds} toggleOpen={toggleOpen} setModal={setModal} tagByName={tagByName}
          onToggleActive={(n) => mutate(api.put(`/org-structure/departments/${n.id}`, { active: n.active ? 0 : 1 }), afterDeptChange)}
          onDelete={(n) => confirmDelete(
            `Hard-delete “${n.name}”? Prefer Deactivate if this department may be used. Linked employee history blocks delete.`,
            () => api.delete(`/org-structure/departments/${n.id}`),
            afterDeptChange,
          )}
          onDetachRole={(deptId, desigId, label) => confirm(`Remove “${label}” from this department’s designations?`, () => mutate(api.delete(`/org-structure/departments/${deptId}/designations/${desigId}`), () => { loadTree(); loadDesig(); }), { title: 'Remove designation', confirmLabel: 'Remove' })}
        />
      )}

      {view === 'designations' && (
        <DesignationsTab designations={designations} setModal={setModal}
          onDelete={(d) => confirmDelete(
            `Hard-delete “${d.name}”? Prefer “not wanted” if the title may be referenced. In-use titles cannot be deleted.`,
            () => api.delete(`/org-structure/designations/${d.id}`),
            () => { loadDesig(); loadTree(); },
          )}
        />
      )}

      {view === 'openings' && (
        <OpeningsTab openings={openings} setModal={setModal}
          onFill={(o) => mutate(api.put(`/org-structure/openings/${o.id}`, { status: 'filled' }), loadOpenings)}
          onReopen={(o) => mutate(api.put(`/org-structure/openings/${o.id}`, { status: 'open' }), loadOpenings)}
          onDelete={(o) => confirmDelete('Delete this opening?', () => api.delete(`/org-structure/openings/${o.id}`), loadOpenings)}
        />
      )}
      </div>

      {modal && (
        <OrgModals modal={modal} close={() => setModal(null)} setModal={setModal}
          tree={tree} designations={designations} emp={emp} usr={usr}
          afterDeptChange={afterDeptChange} loadDesig={loadDesig} loadTree={loadTree} loadOpenings={loadOpenings} />
      )}

      {guideOpen && (
        <Modal isOpen onClose={() => setGuideOpen(false)} title="Org Structure — Guide" subtitle="A quick tour of the module" wide>
          <OrgStructureGuide />
        </Modal>
      )}

      {confirmBox && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
          onClick={() => setConfirmBox(null)}>
          <div className="w-full max-w-[320px] bg-white rounded-xl shadow-xl overflow-hidden" onClick={e => e.stopPropagation()}>
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

// ─── "Pick Template" popover — ONE self-contained surface: trigger → list of
// templates (single-select) → footer (Preview / Set), all inside the same
// panel. Clicking Preview swaps the list for a diff message in place, with
// Close/Apply right there — no action ever lives outside the surface it
// affects (dme 2026-08-03: a page-header dropdown + a separate page-footer
// action bar was the wrong shape — this replaces it). Adding a second
// template to db/orgTemplate.js needs no change here, it's just another row.
function TemplatePicker({ templates, selectedId, onSelect, onClose, preview, previewLoading, onPreview, onSet, setAllowed = true, setBlockedReason }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) { setOpen(false); onClose(); } };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onClose]);
  // Trigger label is STATIC — "Pick Template" never swaps to the selected
  // template's name. Swapping it made the button (and everything right of
  // it) resize the instant an option was picked; a fixed label keeps the
  // header still. Which template is selected shows inside the panel (the
  // checked radio), not on the trigger.
  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button type="button" className="btn btn-secondary text-sm" onClick={() => setOpen(o => !o)}>
        <FiLayers className="inline -mt-0.5 mr-1.5" />Pick Template
        <FiChevronDown className={`inline -mt-0.5 ml-1.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-20 w-72 max-w-[calc(100vw-1.5rem)] bg-white border border-gray-200 rounded-lg shadow-lg overflow-hidden">
          {!setAllowed && (
            <div className="px-2.5 py-2 text-[11px] leading-snug text-amber-900 bg-amber-50 border-b border-amber-100">
              <span className="font-semibold">Initial structure only.</span>{' '}
              {setBlockedReason || 'Employees exist — Preview is available; Set is blocked.'}
            </div>
          )}
          {preview ? (
            <div className="p-2.5 space-y-2">
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-2.5 py-2 text-[11px] leading-snug text-amber-900">
                <span className="font-semibold">Preview — nothing applied yet.</span>{' '}
                {preview.departmentsToRemove.length ? (
                  <>Would remove {preview.departmentsToRemove.length} department(s): {preview.departmentsToRemove.join(', ')}. </>
                ) : (
                  <>No departments would be removed. </>
                )}
                Designations: {preview.currentDesignationCount} → {preview.newDesignationCount}.
              </div>
              <div className="flex justify-end gap-2">
                <button type="button" className="btn btn-secondary text-xs" onClick={() => { setOpen(false); onClose(); }}>Close</button>
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  disabled={!setAllowed || preview.setAllowed === false}
                  title={!setAllowed || preview.setAllowed === false ? (setBlockedReason || preview.setBlockedReason || 'Set blocked') : undefined}
                  onClick={() => { setOpen(false); onSet(); }}
                >
                  Apply
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="max-h-56 overflow-y-auto p-1">
                {templates.length === 0 && <div className="text-xs text-gray-400 p-3 text-center">No templates yet.</div>}
                {templates.map(t => (
                  <label key={t.id} className="flex items-start gap-1.5 px-2 py-1.5 rounded-lg cursor-pointer hover:bg-gray-50">
                    <input type="radio" name="org-template" className="mt-0.5" checked={selectedId === t.id} onChange={() => onSelect(t.id)} />
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-gray-800">{t.name}</div>
                      {t.description && <div className="text-[10px] leading-snug text-gray-400">{t.description}</div>}
                    </div>
                  </label>
                ))}
              </div>
              <div className="flex justify-end gap-2 border-t border-gray-100 px-2.5 py-2">
                <button type="button" className="btn btn-secondary text-xs" disabled={!selectedId || previewLoading} onClick={onPreview}
                  title="See what Set would change, without applying it">
                  <FiRefreshCw className="inline -mt-0.5 mr-1" />{previewLoading ? 'Loading…' : 'Preview'}
                </button>
                <button
                  type="button"
                  className="btn btn-primary text-xs"
                  disabled={!selectedId || !setAllowed}
                  title={!setAllowed ? (setBlockedReason || 'Set blocked') : undefined}
                  onClick={() => { setOpen(false); onSet(); }}
                >
                  Set
                </button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Reusable always-visible kebab (⋮) dropdown menu ─────────────────────────
function Menu({ items }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    const h = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, []);
  const visible = items.filter(it => !it.hidden);
  return (
    <div ref={ref} className="relative flex-shrink-0">
      <button type="button" title="Actions" aria-label="Actions" onClick={() => setOpen(o => !o)}
        className="w-7 h-7 flex items-center justify-center rounded hover:bg-gray-200 text-gray-500">
        <FiMoreVertical />
      </button>
      {open && (
        <div className="absolute right-0 mt-1 z-20 w-48 bg-white border border-gray-200 rounded-lg shadow-lg py-1">
          {visible.map((it, i) => (
            <button key={i} type="button" onClick={() => { setOpen(false); it.onClick(); }}
              className={`w-full text-left px-3 py-1.5 text-sm flex items-center gap-2 hover:bg-gray-50 ${it.danger ? 'text-red-600' : 'text-gray-700'}`}>
              <span className="w-4 flex-shrink-0">{it.icon}</span><span>{it.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function IconBtn({ title, onClick, children, danger }) {
  return (
    <button type="button" title={title} onClick={onClick}
      className={`w-6 h-6 flex items-center justify-center rounded hover:bg-gray-200 ${danger ? 'text-red-500 hover:text-red-700' : 'text-gray-500 hover:text-gray-800'}`}>
      {children}
    </button>
  );
}

// ─── Departments tab (recursive tree) ────────────────────────────────────────
function DepartmentsTab({ tree, openIds, toggleOpen, setModal, onToggleActive, onDelete, onDetachRole, tagByName }) {
  return (
    <div className="card p-0">
      <div className="p-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Department tree</h2>
        <p className="text-xs text-gray-400">Use the ⋮ menu on any department to add a sub-department, designations, or a head.</p>
      </div>
      <div className="p-2">
        {tree.length === 0 && (
          <div className="p-8 text-center">
            <p className="text-sm text-gray-400 mb-3">No organization set up yet.</p>
            <button className="btn btn-primary text-sm" onClick={() => setModal({ kind: 'org-add' })}>
              <FiPlus className="inline -mt-0.5 mr-1" />Create organization
            </button>
          </div>
        )}
        {tree.map(node => (
          <DeptNode key={node.id} node={node} depth={0} openIds={openIds} toggleOpen={toggleOpen}
            setModal={setModal} onToggleActive={onToggleActive} onDelete={onDelete} onDetachRole={onDetachRole} tagByName={tagByName} />
        ))}
      </div>
    </div>
  );
}

function DeptNode({ node, depth, openIds, toggleOpen, setModal, onToggleActive, onDelete, onDetachRole, tagByName }) {
  const isOpen = openIds.has(node.id);
  const headTag = node.head_designation ? tagByName?.get(node.head_designation.trim().toLowerCase()) : null;
  const desigCount = (node.designations || []).length;
  const childCount = (node.children || []).length;
  const hasBody = !!node.head_name || desigCount > 0;
  // A department folds if it has anything under it — head, designations, or
  // sub-departments. Collapsing hides the whole body + children.
  const expandable = hasBody || childCount > 0;
  const isRoot = depth === 0;

  const menuItems = [
    { label: isRoot ? 'Add department' : 'Add sub-department', icon: <FiPlus />, onClick: () => setModal({ kind: 'dept-add', parent: node }) },
    // Designations live on any node. On the ROOT they mean "org roles" —
    // company-level positions reporting directly to the head and sitting in no
    // department (EA to MD, Company Secretary). NOT department heads like COO/
    // CFO — those are the heads of their own departments.
    { label: isRoot ? 'Add org role' : 'Add designation', icon: <FiCornerDownRight />, onClick: () => setModal({ kind: 'dept-role', dept: node }) },
    { label: isRoot ? 'Set organization head' : 'Set department head', icon: <FiUserPlus />, onClick: () => setModal({ kind: 'dept-head', dept: node }) },
    { label: 'Rename', icon: <FiEdit2 />, onClick: () => setModal({ kind: 'dept-rename', dept: node }) },
    { label: 'Move to…', icon: <FiCornerDownRight className="rotate-180" />, onClick: () => setModal({ kind: 'dept-move', dept: node }), hidden: isRoot },
    // Deactivating the whole company/root makes no sense (would grey out everything) → root only.
    { label: node.active ? 'Deactivate' : 'Activate', icon: node.active ? <FiSlash /> : <FiCheckCircle />, onClick: () => onToggleActive(node), hidden: isRoot },
    { label: 'Delete', icon: <FiTrash2 />, onClick: () => onDelete(node), danger: true, hidden: isRoot },
  ];

  return (
    <div>
      <div className={`flex items-center gap-1.5 rounded-lg px-2 py-1.5 hover:bg-gray-50 ${!node.active ? 'opacity-50' : ''}`}
        style={{ marginLeft: depth * 16 }}>
        <button type="button" onClick={() => expandable && toggleOpen(node.id)}
          className={`flex-shrink-0 w-5 h-5 flex items-center justify-center ${expandable ? 'text-gray-500' : 'text-transparent'}`}>
          <FiChevronRight className={`transition-transform ${isOpen ? 'rotate-90' : ''}`} />
        </button>
        <span className={`text-sm ${isRoot ? 'text-gray-900 font-semibold' : 'text-gray-800 font-medium'}`}>{node.name}</span>
        {node.alias && <span className="text-xs text-gray-400">{node.alias}</span>}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.active ? 'bg-green-500' : 'bg-gray-300'}`} title={node.active ? 'active' : 'inactive'} />
        {!isOpen && expandable && (
          <span className="text-[11px] text-gray-400 flex-shrink-0">
            {[desigCount && `${desigCount} ${isRoot ? (desigCount > 1 ? 'roles' : 'role') : 'desig.'}`, childCount && `${childCount} sub`].filter(Boolean).join(' · ')}
          </span>
        )}
        <div className="ml-auto"><Menu items={menuItems} /></div>
      </div>

      {/* Body — this department's head + designations, grouped under one subtle
          left guide and aligned to a single left edge so the tree reads neatly.
          The × is ALWAYS visible (mobile has no hover) — subtle grey, red on tap. */}
      {isOpen && hasBody && (
        <div className="border-l-2 border-gray-100 pl-3 my-1 space-y-1.5" style={{ marginLeft: depth * 16 + 19 }}>
          {node.head_name && (
            <div className="flex items-center gap-1.5 text-[12px] min-w-0">
              <span className="text-[9px] font-bold uppercase tracking-wide text-blue-400 flex-shrink-0" title="Head — the one person leading this (display only, grants no access)">Head</span>
              <span className="font-semibold text-gray-800 truncate">{node.head_name}</span>
              {node.head_designation && <span className="text-gray-300 flex-shrink-0">·</span>}
              {node.head_designation && <span className="text-gray-500 truncate" title={headTag ? node.head_designation : undefined}>{headTag || node.head_designation}</span>}
            </div>
          )}
          {(node.designations || []).length > 0 && (
            <div>
              <div className="text-[9px] font-bold uppercase tracking-wide text-gray-400 mb-1" title={isRoot ? 'Org roles — company-level positions reporting directly to the head, in no department (e.g. EA to MD)' : 'Designations = the titles/positions this department holds'}>{isRoot ? 'Org roles' : 'Designations'}</div>
              <ul className="space-y-0.5">
                {node.designations.map(d => {
                  const dot = { present: 'bg-green-500', planned: 'bg-amber-400', not_wanted: 'bg-gray-300' }[d.status] || 'bg-green-500';
                  return (
                    <li key={d.id} className="flex items-center gap-2 text-[12px] text-gray-700 rounded pl-1 pr-3 hover:bg-gray-50">
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${dot}`} title={DESIG_PILL[d.status]?.[1] || 'Present'} />
                      <span className="truncate">{d.name}{d.tag_name && d.tag_name !== d.name && <span className="text-gray-400"> · {d.tag_name}</span>}</span>
                      {d.singleton === 1 && <FiStar className="text-amber-400 flex-shrink-0" size={11} title="Unique — one active holder" />}
                      <button type="button" onClick={() => onDetachRole(node.id, d.id, d.tag_name || d.name)}
                        className="ml-auto flex-shrink-0 text-gray-300 hover:text-red-600 p-1 -mr-0.5" title="Remove designation" aria-label={`Remove ${d.tag_name || d.name}`}>
                        <FiX size={13} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      )}

      {isOpen && (node.children || []).map(child => (
        <DeptNode key={child.id} node={child} depth={depth + 1} openIds={openIds} toggleOpen={toggleOpen}
          setModal={setModal} onToggleActive={onToggleActive} onDelete={onDelete} onDetachRole={onDetachRole} tagByName={tagByName} />
      ))}
    </div>
  );
}

// ─── Designations tab ────────────────────────────────────────────────────────
function DesignationsTab({ designations, setModal, onDelete }) {
  const groups = useMemo(() => ({
    present: designations.filter(d => d.status === 'present'),
    planned: designations.filter(d => d.status === 'planned'),
    not_wanted: designations.filter(d => d.status === 'not_wanted'),
  }), [designations]);

  return (
    <div className="card p-0">
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Designation catalog</h2>
        <button className="btn btn-primary text-xs" onClick={() => setModal({ kind: 'desig-edit', desig: null })}>
          <FiPlus className="inline -mt-0.5 mr-1" />New designation
        </button>
      </div>
      {designations.length === 0 && <div className="p-6 text-center text-sm text-gray-400">No designations yet.</div>}
      {['present', 'planned', 'not_wanted'].map(status => groups[status].length > 0 && (
        <div key={status}>
          <div className="px-4 pt-3 pb-1 text-[11px] font-bold uppercase tracking-wide text-gray-400">{DESIG_PILL[status][1]} · {groups[status].length}</div>
          <div className="divide-y divide-gray-50">
            {groups[status].map(d => (
              <div key={d.id} className="flex items-center gap-2 px-4 py-2 hover:bg-gray-50">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-gray-800">{d.name}</span>
                    {d.tag_name && <span className="badge badge-gray !normal-case !tracking-normal !text-[10px]">{d.tag_name}</span>}
                    {d.singleton === 1 && <FiStar className="text-amber-500" size={13} title="Unique — one active holder only" />}
                    {d.active_holders > 0 && <span className="text-[11px] text-gray-400">· {d.active_holders} holder{d.active_holders > 1 ? 's' : ''}</span>}
                  </div>
                  {d.departments?.length > 0 && <div className="text-xs text-gray-400 truncate">{d.departments.map(x => x.name).join(' · ')}</div>}
                </div>
                <IconBtn title="Edit" onClick={() => setModal({ kind: 'desig-edit', desig: d })}><FiEdit2 /></IconBtn>
                <IconBtn title="Delete" danger onClick={() => onDelete(d)}><FiTrash2 /></IconBtn>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Openings tab ────────────────────────────────────────────────────────────
function OpeningsTab({ openings, setModal, onFill, onReopen, onDelete }) {
  return (
    <div className="card p-0">
      <div className="flex items-center justify-between p-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Open positions</h2>
        <button className="btn btn-primary text-xs" onClick={() => setModal({ kind: 'opening', opening: null })}>
          <FiPlus className="inline -mt-0.5 mr-1" />New opening
        </button>
      </div>
      {openings.length === 0 && <div className="p-6 text-center text-sm text-gray-400">No openings.</div>}
      <div className="divide-y divide-gray-50">
        {openings.map(o => {
          const [cls, label] = OPENING_PILL[o.status] || OPENING_PILL.open;
          return (
            <div key={o.id} className="flex items-center gap-2 px-4 py-2.5 hover:bg-gray-50">
              <div className="min-w-0 flex-1">
                <div className="text-sm font-medium text-gray-800">
                  {o.designation_name || 'Any role'}{o.headcount > 1 && <span className="text-gray-400 font-normal"> × {o.headcount}</span>}
                </div>
                <div className="text-xs text-gray-400">{o.department_name || 'Unassigned dept'}{o.notes ? ` · ${o.notes}` : ''}</div>
              </div>
              <span className={`badge ${cls}`}>{label}</span>
              {o.status !== 'filled'
                ? <IconBtn title="Mark filled" onClick={() => onFill(o)}><FiCheckCircle /></IconBtn>
                : <IconBtn title="Reopen" onClick={() => onReopen(o)}><FiCornerDownRight /></IconBtn>}
              <IconBtn title="Delete" danger onClick={() => onDelete(o)}><FiTrash2 /></IconBtn>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Modals ──────────────────────────────────────────────────────────────────
function OrgModals({ modal, close, setModal, tree, designations, emp, usr, afterDeptChange, loadDesig, loadTree, loadOpenings }) {
  const { kind } = modal;
  const [saving, setSaving] = useState(false);
  const run = (promise, okMsg) => {
    setSaving(true);
    return promise.then(() => { if (okMsg) toast.success(okMsg); close(); })
      .catch(e => toast.error(errMsg(e, 'Failed'))).finally(() => setSaving(false));
  };

  if (kind === 'org-add' || kind === 'dept-add' || kind === 'dept-rename') {
    return <DeptForm kind={kind} modal={modal} saving={saving} close={close}
      onSubmit={(body) => run(
        kind === 'dept-rename'
          ? api.put(`/org-structure/departments/${modal.dept.id}`, body)
          : api.post('/org-structure/departments', { ...body, parent_id: kind === 'org-add' ? null : modal.parent.id }),
        kind === 'org-add' ? 'Organization created' : 'Saved',
      ).then(afterDeptChange)} />;
  }
  if (kind === 'dept-head') {
    return <HeadForm dept={modal.dept} emp={emp} saving={saving} close={close}
      onSubmit={(headId) => run(api.put(`/org-structure/departments/${modal.dept.id}`, { head_employee_id: headId }), 'Head updated').then(afterDeptChange)} />;
  }
  if (kind === 'dept-move') {
    return <MoveForm dept={modal.dept} tree={tree} saving={saving} close={close}
      onSubmit={(parentId) => run(api.put(`/org-structure/departments/${modal.dept.id}`, { parent_id: parentId }), 'Moved').then(afterDeptChange)} />;
  }
  if (kind === 'dept-role') {
    return <AddRoleForm dept={modal.dept} designations={designations} saving={saving} close={close}
      onCreateNew={() => setModal({ kind: 'desig-edit', desig: null, initialDeptIds: [modal.dept.id] })}
      onSubmit={(ids) => run(
        (async () => { for (const id of ids) await api.post(`/org-structure/departments/${modal.dept.id}/designations`, { designation_id: id }); })(),
        ids.length > 1 ? `${ids.length} added` : 'Added',
      ).then(() => { loadTree(); loadDesig(); })} />;
  }
  if (kind === 'desig-edit') {
    return <DesigForm desig={modal.desig} initialDeptIds={modal.initialDeptIds} tree={tree} saving={saving} close={close}
      onSubmit={(body, deptIds) => run(
        (modal.desig ? api.put(`/org-structure/designations/${modal.desig.id}`, body) : api.post('/org-structure/designations', body))
          .then(async (r) => {
            const id = modal.desig ? modal.desig.id : r.data.id;
            const current = new Set((modal.desig?.departments || []).map(x => x.id));
            const want = new Set(deptIds);
            for (const dId of want) if (!current.has(dId)) await api.post(`/org-structure/departments/${dId}/designations`, { designation_id: id });
            for (const dId of current) if (!want.has(dId)) await api.delete(`/org-structure/departments/${dId}/designations/${id}`);
          }),
        'Saved',
      ).then(() => { loadDesig(); loadTree(); })} />;
  }
  if (kind === 'opening') {
    return <OpeningForm tree={tree} designations={designations} usr={usr} saving={saving} close={close}
      onSubmit={(body) => run(api.post('/org-structure/openings', body), 'Opening created').then(loadOpenings)} />;
  }
  return null;
}

function Footer({ close, saving, label = 'Save', disabled = false }) {
  return (
    <div className="flex justify-end gap-3 pt-2">
      <button type="button" className="btn btn-secondary" onClick={close} disabled={saving}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={saving || disabled}>{saving ? 'Saving…' : label}</button>
    </div>
  );
}

function DeptForm({ kind, modal, saving, close, onSubmit }) {
  const editing = kind === 'dept-rename';
  const isOrg = kind === 'org-add';
  // Adding directly under the (single) root company node = a top-level
  // "department"; deeper = a "sub-department". Labels match that mental model.
  const underRoot = kind === 'dept-add' && modal.parent && modal.parent.parent_id == null;
  const [name, setName] = useState(editing ? modal.dept.name : '');
  const [alias, setAlias] = useState(editing ? (modal.dept.alias || '') : '');
  const title = isOrg ? 'Create organization' : editing ? 'Rename department' : underRoot ? 'Add department' : 'Add sub-department';
  const subtitle = isOrg ? undefined : editing ? `“${modal.dept.name}”` : `under ${modal.parent.name}`;
  return (
    <Modal isOpen onClose={close} title={title} subtitle={subtitle}>
      <form onSubmit={e => { e.preventDefault(); if (clean(name)) onSubmit({ name: clean(name), alias: clean(alias) || null }); }} className="space-y-3">
        <div><label className="label">Name</label><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder={isOrg ? 'e.g. Acme Pvt Ltd' : 'e.g. Procurement'} /></div>
        <div><label className="label">Alias / common name (optional)</label><input className="input" value={alias} onChange={e => setAlias(e.target.value)} placeholder="e.g. (Purchase)" /></div>
        <Footer close={close} saving={saving} disabled={!clean(name)} />
      </form>
    </Modal>
  );
}

function HeadForm({ dept, emp, saving, close, onSubmit }) {
  const [headId, setHeadId] = useState(dept.head_employee_id || null);
  return (
    <Modal isOpen onClose={close} title={dept.parent_id ? 'Set department head' : 'Set organization head'} subtitle={dept.name} scrollOutside>
      <form onSubmit={e => { e.preventDefault(); onSubmit(headId); }} className="space-y-3">
        <p className="text-xs text-gray-500">The one person who leads <b>{dept.name}</b>. Display only — grants no access. Their title comes from their employee record, not from here.</p>
        <div>
          <label className="label">Person</label>
          <PeoplePicker options={emp.options} loading={emp.loading} error={!!emp.error} onRetry={emp.refresh}
            value={headId} onChange={(id) => setHeadId(id)} placeholder="Search employee…" />
        </div>
        <Footer close={close} saving={saving} />
      </form>
    </Modal>
  );
}

function MoveForm({ dept, tree, saving, close, onSubmit }) {
  const [parentId, setParentId] = useState(dept.parent_id || null);
  return (
    <Modal isOpen onClose={close} title="Move department" subtitle={`“${dept.name}” to…`}>
      <form onSubmit={e => { e.preventDefault(); if (parentId) onSubmit(parentId); }} className="space-y-3">
        <DepartmentPicker tree={tree} excludeId={dept.id} value={parentId} onChange={(id) => setParentId(id)} allowClear={false} placeholder="Select new parent…" />
        <Footer close={close} saving={saving} label="Move" />
      </form>
    </Modal>
  );
}

// Attach EXISTING catalog designations (multi-select). Creating a brand-new
// title routes to the full catalog form (onCreateNew) so tag + unique are never
// skipped — quick free-text create used to silently drop them.
function AddRoleForm({ dept, designations, saving, close, onSubmit, onCreateNew }) {
  const isRoot = !dept.parent_id;
  const attachedIds = useMemo(() => new Set((dept.designations || []).map(d => d.id)), [dept]);
  const available = useMemo(() => designations.filter(d => !attachedIds.has(d.id)), [designations, attachedIds]);
  const [sel, setSel] = useState(() => new Set());
  const [q, setQ] = useState('');
  const toggle = (id) => setSel(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const ql = q.trim().toLowerCase();
  const filtered = available.filter(d => !ql || d.name.toLowerCase().includes(ql) || (d.tag_name || '').toLowerCase().includes(ql));
  const noun = isRoot ? 'org role' : 'designation';
  return (
    <Modal isOpen onClose={close} title={isRoot ? 'Add org roles' : 'Add designations'} subtitle={`to ${dept.name}`}>
      <form onSubmit={e => { e.preventDefault(); if (sel.size) onSubmit([...sel]); }} className="space-y-3">
        {isRoot && <p className="text-xs text-gray-500">Company-level roles reporting directly to the head, in no department — e.g. EA to MD, Company Secretary.</p>}
        <div className="flex items-center justify-between gap-2">
          <label className="label !mb-0">Pick from the catalog</label>
          <button type="button" className="text-xs font-medium text-red-600 hover:underline flex-shrink-0" onClick={onCreateNew}>+ New designation…</button>
        </div>
        {available.length > 6 && <input className="input" placeholder="Filter titles…" value={q} onChange={e => setQ(e.target.value)} autoFocus />}
        <div className="max-h-56 overflow-y-auto border border-gray-200 rounded-xl p-1">
          {filtered.length === 0 && (
            <div className="text-xs text-gray-400 p-4 text-center">
              {available.length === 0 ? 'Every catalog title is already attached here.' : 'No match — create it via “+ New designation”.'}
            </div>
          )}
          {filtered.map(d => (
            <label key={d.id} className="flex items-center gap-2 px-2 py-1.5 cursor-pointer hover:bg-gray-50 rounded">
              <input type="checkbox" checked={sel.has(d.id)} onChange={() => toggle(d.id)} />
              <span className="text-sm text-gray-800">{d.name}</span>
              {d.tag_name && <span className="badge badge-gray !normal-case !tracking-normal !text-[10px]">{d.tag_name}</span>}
              {d.singleton === 1 && <FiStar className="text-amber-500 flex-shrink-0" size={12} title="Unique — one active holder" />}
            </label>
          ))}
        </div>
        <Footer close={close} saving={saving} label={sel.size > 1 ? `Add ${sel.size} ${noun}s` : `Add ${noun}`} disabled={sel.size === 0} />
      </form>
    </Modal>
  );
}

function DesigForm({ desig, initialDeptIds, tree, saving, close, onSubmit }) {
  const [name, setName] = useState(desig?.name || '');
  const [tagName, setTagName] = useState(desig?.tag_name || '');
  const [status, setStatus] = useState(desig?.status || 'present');
  const [singleton, setSingleton] = useState(desig?.singleton === 1);
  // New designation opened from a department's "+ New designation" is pre-attached
  // to that department (initialDeptIds); editing keeps its existing attachments.
  const [deptIds, setDeptIds] = useState(() => new Set(desig ? (desig.departments || []).map(x => x.id) : (initialDeptIds || [])));
  const [touched, setTouched] = useState(false);
  const nameOk = !!clean(name);
  const flatDepts = useMemo(() => {
    const out = []; const walk = (ns, d) => (ns || []).forEach(n => { out.push({ id: n.id, name: n.name, depth: d }); walk(n.children, d + 1); });
    walk(tree, 0); return out;
  }, [tree]);
  const toggleDept = (id) => setDeptIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Modal isOpen onClose={close} title={desig ? 'Edit designation' : 'New designation'} subtitle={desig ? `“${desig.name}”` : undefined} wide>
      <form onSubmit={e => { e.preventDefault(); setTouched(true); if (nameOk) onSubmit({ name: clean(name), tag_name: clean(tagName) || null, status, singleton: singleton ? 1 : 0 }, [...deptIds]); }} className="space-y-3">
        <div>
          <label className="label">Full title <span className="text-red-500">*</span></label>
          <input className={`input ${touched && !nameOk ? '!border-red-400 focus:!ring-red-200' : ''}`} value={name}
            onChange={e => setName(e.target.value)} onBlur={() => setTouched(true)} autoFocus placeholder="Managing Director" />
          {touched && !nameOk && <p className="text-[11px] text-red-500 mt-1">Full title is required.</p>}
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Tag / short code</label><input className="input" value={tagName} onChange={e => setTagName(e.target.value)} placeholder="MD" /></div>
          <div>
            <label className="label">Status</label>
            <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="present">Present (have)</option>
              <option value="planned">Planned (might open)</option>
              <option value="not_wanted">Not wanted</option>
            </select>
          </div>
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
          <input type="checkbox" checked={singleton} onChange={e => setSingleton(e.target.checked)} />
          <FiStar className="text-amber-500" /> Unique — only one active holder
        </label>
        <div>
          <label className="label">Attached departments</label>
          <div className="max-h-40 overflow-y-auto border border-gray-200 rounded-xl p-2 space-y-0.5">
            {flatDepts.length === 0 && <div className="text-xs text-gray-400 p-2">No departments.</div>}
            {flatDepts.map(d => (
              <label key={d.id} className="flex items-center gap-2 text-sm py-0.5 cursor-pointer hover:bg-gray-50 rounded" style={{ paddingLeft: 4 + d.depth * 14 }}>
                <input type="checkbox" checked={deptIds.has(d.id)} onChange={() => toggleDept(d.id)} />{d.name}
              </label>
            ))}
          </div>
        </div>
        <Footer close={close} saving={saving} disabled={!nameOk} />
      </form>
    </Modal>
  );
}

function OpeningForm({ tree, designations, usr, saving, close, onSubmit }) {
  const [departmentId, setDepartmentId] = useState(null);
  const [designationId, setDesignationId] = useState(null);
  const [headcount, setHeadcount] = useState(1);
  const [reportsTo, setReportsTo] = useState(null);
  const [notes, setNotes] = useState('');
  return (
    <Modal isOpen onClose={close} title="New opening" wide scrollOutside>
      <form onSubmit={e => { e.preventDefault(); onSubmit({ department_id: departmentId, designation_id: designationId, headcount: Number(headcount) || 1, reports_to_employee_id: reportsTo, notes: clean(notes) || null }); }} className="space-y-3">
        <div><label className="label">Department</label>
          <DepartmentPicker tree={tree} value={departmentId} onChange={(id) => setDepartmentId(id)} placeholder="Select department…" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Designation</label>
            <select className="select" value={designationId || ''} onChange={e => setDesignationId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">— any role —</option>
              {designations.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select></div>
          <div><label className="label">Headcount</label><input type="number" min="1" className="input" value={headcount} onChange={e => setHeadcount(e.target.value)} /></div>
        </div>
        <div><label className="label">Reports to (optional)</label>
          <PeoplePicker options={usr.options} loading={usr.loading} error={!!usr.error} onRetry={usr.refresh} value={reportsTo} onChange={(id) => setReportsTo(id)} placeholder="Search person…" /></div>
        <div>
          <label className="label">Notes (optional)</label>
          <textarea className="input resize-none h-20" maxLength={100} value={notes} onChange={e => setNotes(e.target.value)} placeholder="Up to 100 characters" />
          <div className="text-[11px] text-gray-400 text-right mt-0.5">{notes.length}/100</div>
        </div>
        <div className="pt-4">
          <Footer close={close} saving={saving} label="Create" />
        </div>
      </form>
    </Modal>
  );
}
