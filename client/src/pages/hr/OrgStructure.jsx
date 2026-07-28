import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  FiPlus, FiEdit2, FiTrash2, FiChevronRight, FiCornerDownRight,
  FiUserPlus, FiStar, FiSlash, FiCheckCircle, FiMoreVertical,
} from 'react-icons/fi';
import api from '../../api';
import toast from 'react-hot-toast';
import Modal from '../../components/Modal';
import PeoplePicker from '../../components/PeoplePicker';
import DepartmentPicker from '../../components/DepartmentPicker';
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
  const [view, setView] = useState('departments'); // departments | designations | openings
  const [tree, setTree] = useState([]);
  const [designations, setDesignations] = useState([]);
  const [openings, setOpenings] = useState([]);
  const [openIds, setOpenIds] = useState(() => new Set());
  const [modal, setModal] = useState(null); // { kind, ...ctx }

  const emp = usePeopleOptions('employee');
  const usr = usePeopleOptions('user');

  const seededRef = useRef(false);
  const loadTree = useCallback(() => api.get('/org-structure/departments')
    .then(r => {
      setTree(r.data);
      if (!seededRef.current && r.data.length) { seededRef.current = true; setOpenIds(new Set(r.data.map(n => n.id))); }
    }).catch(e => toast.error(errMsg(e, 'Failed to load departments'))), []);
  const loadDesig = useCallback(() => api.get('/org-structure/designations')
    .then(r => setDesignations(r.data)).catch(e => toast.error(errMsg(e, 'Failed to load designations'))), []);
  const loadOpenings = useCallback(() => api.get('/org-structure/openings')
    .then(r => setOpenings(r.data)).catch(e => toast.error(errMsg(e, 'Failed to load openings'))), []);

  useEffect(() => { loadTree(); loadDesig(); loadOpenings(); }, [loadTree, loadDesig, loadOpenings]);

  const toggleOpen = (id) => setOpenIds(prev => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  // DRY mutation helpers — one error path, one confirm path, used everywhere.
  const mutate = useCallback((promise, after) => promise
    .then((r) => { after?.(); return r; })
    .catch(e => toast.error(errMsg(e, 'Failed'))), []);
  const confirmDelete = useCallback((message, doDelete, after) => {
    if (!window.confirm(message)) return;
    doDelete().then(() => { toast.success('Deleted'); after?.(); }).catch(e => toast.error(errMsg(e, 'Failed')));
  }, []);

  const afterDeptChange = useCallback(() => { loadTree(); loadOpenings(); invalidateDepartments(); }, [loadTree, loadOpenings]);

  const tabs = [
    ['departments', 'Departments'],
    ['designations', 'Designations'],
    ['openings', `Openings${openings.filter(o => o.status === 'open').length ? ' · ' + openings.filter(o => o.status === 'open').length : ''}`],
  ];

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-900">Org Structure</h1>
        <p className="text-sm text-gray-500">Departments, the designation catalog, and open positions.</p>
      </div>

      <div className="flex gap-2 border-b border-gray-200">
        {tabs.map(([key, label]) => (
          <button key={key} onClick={() => setView(key)}
            className={`px-3 py-2 text-sm font-semibold border-b-2 -mb-px ${view === key ? 'border-red-600 text-red-600' : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-[60vh]">
      {view === 'departments' && (
        <DepartmentsTab
          tree={tree} openIds={openIds} toggleOpen={toggleOpen} setModal={setModal}
          onToggleActive={(n) => mutate(api.put(`/org-structure/departments/${n.id}`, { active: n.active ? 0 : 1 }), afterDeptChange)}
          onDelete={(n) => confirmDelete(`Delete “${n.name}”? This cannot be undone.`, () => api.delete(`/org-structure/departments/${n.id}`), afterDeptChange)}
          onDetachRole={(deptId, desigId) => mutate(api.delete(`/org-structure/departments/${deptId}/designations/${desigId}`), () => { loadTree(); loadDesig(); })}
        />
      )}

      {view === 'designations' && (
        <DesignationsTab designations={designations} setModal={setModal}
          onDelete={(d) => confirmDelete(`Delete “${d.name}”?`, () => api.delete(`/org-structure/designations/${d.id}`), () => { loadDesig(); loadTree(); })}
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
        <OrgModals modal={modal} close={() => setModal(null)}
          tree={tree} designations={designations} emp={emp} usr={usr}
          afterDeptChange={afterDeptChange} loadDesig={loadDesig} loadTree={loadTree} loadOpenings={loadOpenings} />
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
function DepartmentsTab({ tree, openIds, toggleOpen, setModal, onToggleActive, onDelete, onDetachRole }) {
  return (
    <div className="card p-0">
      <div className="p-4 border-b border-gray-100">
        <h2 className="text-sm font-semibold text-gray-700">Department tree</h2>
        <p className="text-xs text-gray-400">Use the ⋮ menu on any department to add a sub-department, roles, or a head.</p>
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
            setModal={setModal} onToggleActive={onToggleActive} onDelete={onDelete} onDetachRole={onDetachRole} />
        ))}
      </div>
    </div>
  );
}

function DeptNode({ node, depth, openIds, toggleOpen, setModal, onToggleActive, onDelete, onDetachRole }) {
  const isOpen = openIds.has(node.id);
  const expandable = (node.children && node.children.length) || (node.designations && node.designations.length);
  const isRoot = depth === 0;

  const menuItems = [
    { label: isRoot ? 'Add department' : 'Add sub-department', icon: <FiPlus />, onClick: () => setModal({ kind: 'dept-add', parent: node }) },
    // Roles live on any node INCLUDING the root — company-level titles (MD/COO/
    // CFO) belong to the organization itself, not a department. (Head = the one
    // person; role = the title — a distinct thing, so this is valid on the root.)
    { label: 'Add role', icon: <FiCornerDownRight />, onClick: () => setModal({ kind: 'dept-role', dept: node }) },
    { label: 'Set head', icon: <FiUserPlus />, onClick: () => setModal({ kind: 'dept-head', dept: node }) },
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
        {node.head_name && (
          <span className="badge badge-blue !normal-case !tracking-normal !text-[10px]" title="Department head (display only)">{node.head_name}</span>
        )}
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${node.active ? 'bg-green-500' : 'bg-gray-300'}`} title={node.active ? 'active' : 'inactive'} />
        <div className="ml-auto"><Menu items={menuItems} /></div>
      </div>

      {isOpen && (
        <div>
          {(node.designations || []).length > 0 && (
            <div className="flex flex-wrap gap-1.5 py-1" style={{ marginLeft: depth * 16 + 28 }}>
              {node.designations.map(d => {
                const [cls] = DESIG_PILL[d.status] || DESIG_PILL.present;
                return (
                  <span key={d.id} className={`badge ${cls} !normal-case !tracking-normal inline-flex items-center gap-1`} title={`${d.name} — ${d.status}`}>
                    {d.tag_name || d.name}
                    <button type="button" onClick={() => onDetachRole(node.id, d.id)} className="hover:text-red-800" title="Detach">×</button>
                  </span>
                );
              })}
            </div>
          )}
          {(node.children || []).map(child => (
            <DeptNode key={child.id} node={child} depth={depth + 1} openIds={openIds} toggleOpen={toggleOpen}
              setModal={setModal} onToggleActive={onToggleActive} onDelete={onDelete} onDetachRole={onDetachRole} />
          ))}
        </div>
      )}
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
function OrgModals({ modal, close, tree, designations, emp, usr, afterDeptChange, loadDesig, loadTree, loadOpenings }) {
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
      onSubmit={async ({ designation_id, newName }) => {
        let id = designation_id;
        if (newName) { const r = await api.post('/org-structure/designations', { name: newName }); id = r.data.id; }
        return run(api.post(`/org-structure/departments/${modal.dept.id}/designations`, { designation_id: id }), 'Role added').then(() => { loadTree(); loadDesig(); });
      }} />;
  }
  if (kind === 'desig-edit') {
    return <DesigForm desig={modal.desig} tree={tree} saving={saving} close={close}
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

function Footer({ close, saving, label = 'Save' }) {
  return (
    <div className="flex justify-end gap-3 pt-2">
      <button type="button" className="btn btn-secondary" onClick={close} disabled={saving}>Cancel</button>
      <button type="submit" className="btn btn-primary" disabled={saving}>{saving ? 'Saving…' : label}</button>
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
        <Footer close={close} saving={saving} />
      </form>
    </Modal>
  );
}

function HeadForm({ dept, emp, saving, close, onSubmit }) {
  const [headId, setHeadId] = useState(dept.head_employee_id || null);
  return (
    <Modal isOpen onClose={close} title="Set department head" subtitle={dept.name}>
      <form onSubmit={e => { e.preventDefault(); onSubmit(headId); }} className="space-y-3">
        <p className="text-xs text-gray-500">Display-only. Setting a head grants no access.</p>
        <PeoplePicker options={emp.options} loading={emp.loading} error={!!emp.error} onRetry={emp.refresh}
          value={headId} onChange={(id) => setHeadId(id)} placeholder="Search employee…" />
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

function AddRoleForm({ dept, designations, saving, close, onSubmit }) {
  const [designationId, setDesignationId] = useState(null);
  const [newName, setNewName] = useState('');
  return (
    <Modal isOpen onClose={close} title="Add role" subtitle={`to ${dept.name}`}>
      <form onSubmit={e => { e.preventDefault(); if (clean(newName) || designationId) onSubmit({ designation_id: designationId, newName: clean(newName) }); }} className="space-y-3">
        <div>
          <label className="label">Attach existing title</label>
          <select className="select" value={designationId || ''} onChange={e => { setDesignationId(e.target.value ? Number(e.target.value) : null); setNewName(''); }}>
            <option value="">— pick a title —</option>
            {designations.map(d => <option key={d.id} value={d.id}>{d.name}{d.tag_name ? ` (${d.tag_name})` : ''}</option>)}
          </select>
        </div>
        <div className="text-center text-xs text-gray-400">or</div>
        <div>
          <label className="label">Create a new title</label>
          <input className="input" value={newName} onChange={e => { setNewName(e.target.value); if (e.target.value) setDesignationId(null); }} placeholder="e.g. Site Supervisor" />
        </div>
        <Footer close={close} saving={saving} label="Add role" />
      </form>
    </Modal>
  );
}

function DesigForm({ desig, tree, saving, close, onSubmit }) {
  const [name, setName] = useState(desig?.name || '');
  const [tagName, setTagName] = useState(desig?.tag_name || '');
  const [status, setStatus] = useState(desig?.status || 'present');
  const [singleton, setSingleton] = useState(desig?.singleton === 1);
  const [deptIds, setDeptIds] = useState(new Set((desig?.departments || []).map(x => x.id)));
  const flatDepts = useMemo(() => {
    const out = []; const walk = (ns, d) => (ns || []).forEach(n => { out.push({ id: n.id, name: n.name, depth: d }); walk(n.children, d + 1); });
    walk(tree, 0); return out;
  }, [tree]);
  const toggleDept = (id) => setDeptIds(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });

  return (
    <Modal isOpen onClose={close} title={desig ? 'Edit designation' : 'New designation'} subtitle={desig ? `“${desig.name}”` : undefined} wide>
      <form onSubmit={e => { e.preventDefault(); if (clean(name)) onSubmit({ name: clean(name), tag_name: clean(tagName) || null, status, singleton: singleton ? 1 : 0 }, [...deptIds]); }} className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <div><label className="label">Full title</label><input className="input" value={name} onChange={e => setName(e.target.value)} autoFocus placeholder="Managing Director" /></div>
          <div><label className="label">Tag / short code</label><input className="input" value={tagName} onChange={e => setTagName(e.target.value)} placeholder="MD" /></div>
        </div>
        <div className="grid grid-cols-2 gap-3 items-end">
          <div>
            <label className="label">Status</label>
            <select className="select" value={status} onChange={e => setStatus(e.target.value)}>
              <option value="present">Present (have)</option>
              <option value="planned">Planned (might open)</option>
              <option value="not_wanted">Not wanted</option>
            </select>
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-700 pb-2 cursor-pointer">
            <input type="checkbox" checked={singleton} onChange={e => setSingleton(e.target.checked)} />
            <FiStar className="text-amber-500" /> Unique — only one active holder
          </label>
        </div>
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
        <Footer close={close} saving={saving} />
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
    <Modal isOpen onClose={close} title="New opening" wide>
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
        <div><label className="label">Notes (optional)</label><input className="input" value={notes} onChange={e => setNotes(e.target.value)} /></div>
        <Footer close={close} saving={saving} label="Create" />
      </form>
    </Modal>
  );
}
