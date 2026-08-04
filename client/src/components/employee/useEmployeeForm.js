import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { computeChanges } from '../../constants/employeeChangeCodes';

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export const DOC_SLOTS = [
  { key: 'aadhar_file',        slot: '_aadhar_file',        label: 'Aadhar Card' },
  { key: 'pan_file',           slot: '_pan_file',           label: 'PAN Card' },
  { key: 'qualification_file', slot: '_qualification_file', label: 'Qualification Certificate' },
];

const freshMeta = () => ({
  action_code: '', reason_code: '', reason: '', effective_date: istToday(),
  salary_effective_date: '', salary_action: '', salary_reason_code: '',
  status_effective_date: '',
});

// Field → Workspace-section membership is fetched once from the server
// (server/lib/employeeSections.js is the single source of truth — see the
// plan's 2026-08-04 section-level-saves revision) and cached at module scope
// so re-opening the modal never re-fetches it.
let sectionsCache = null;
let sectionsPromise = null;
function fetchSections() {
  if (sectionsCache) return Promise.resolve(sectionsCache);
  if (!sectionsPromise) {
    sectionsPromise = api.get('/hr/employees/meta/sections').then((r) => { sectionsCache = r.data; return sectionsCache; });
  }
  return sectionsPromise;
}

// One hook, all Workspace modal state. Employees.jsx owns none of this
// anymore — it just calls open()/openCreate() and renders <EmployeeWorkspaceModal ws={...} />.
export default function useEmployeeForm({ onSaved }) {
  const [sections, setSections] = useState(sectionsCache || {});
  useEffect(() => { fetchSections().then(setSections); }, []);

  const [isOpen, setIsOpen] = useState(false);
  const [editing, setEditing] = useState(null); // the persisted employee row, or null in create mode
  const [original, setOriginal] = useState(null); // snapshot at open — the diff baseline
  const [form, setForm] = useState({});
  const [changeMeta, setChangeMeta] = useState({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), documents: freshMeta(), access: freshMeta() });
  const [joinDateLocked, setJoinDateLocked] = useState(false);
  const [uploading, setUploading] = useState(false);

  const openCreate = useCallback(() => {
    setEditing(null);
    setOriginal(null);
    setForm({ name: '', phone: '', email: '', designation: '', department: '', join_date: '', salary: 0, user_id: null, roster: 'general' });
    setChangeMeta({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), documents: freshMeta(), access: freshMeta() });
    setJoinDateLocked(false);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((emp) => {
    setEditing(emp);
    setOriginal(emp);
    setForm(emp);
    setChangeMeta({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), documents: freshMeta(), access: freshMeta() });
    setJoinDateLocked(!!emp.join_date);
    setIsOpen(true);
  }, []);

  const close = useCallback(() => setIsOpen(false), []);

  // Diff against the WHOLE tracked-field set (unscoped) — trackAccent/WasHint
  // styling applies to a field regardless of which section it renders in.
  const changedSet = new Set((editing && original ? computeChanges(original, form) : []).map((c) => c.key));
  const revertField = (key) => setForm((f) => ({ ...f, [key]: original[key] }));

  // A section's own slice of the diff — what its Save button actually submits.
  const sectionChanges = (key) => {
    const keys = new Set(sections[key] || []);
    return (editing && original ? computeChanges(original, form) : []).filter((c) => keys.has(c.key));
  };
  const docLabels = () => DOC_SLOTS.filter((d) => form[d.slot]).map((d) => d.label);

  const setSectionMeta = (key, updater) =>
    setChangeMeta((m) => ({ ...m, [key]: typeof updater === 'function' ? updater(m[key]) : updater }));

  const uploadFile = async (file) => {
    if (!file) return null;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const r = await api.post('/upload', fd, { headers: { 'Content-Type': 'multipart/form-data' } });
      return r.data?.url || null;
    } catch { toast.error('Upload failed'); return null; }
    finally { setUploading(false); }
  };

  // Lightweight create — POST /employees needs only a name (Phase 2.5: the
  // record is a true Draft). On success the SAME modal flips into edit mode
  // for the new employee, so the rest of the Workspace's sections become
  // available immediately without closing and reopening.
  const createEmployee = async () => {
    if (!form.name || !String(form.name).trim()) return toast.error('Name is required');
    const payload = {
      name: form.name, phone: form.phone, email: form.email,
      designation: form.designation, department: form.department,
      join_date: form.join_date, user_id: form.user_id, roster: form.roster,
    };
    // Only send salary if it's actually set — 0 is the Draft default and
    // validateEmployee treats a SUPPLIED salary of 0 as invalid (a real
    // employee's salary can't be zero), not as "not set". Omitting it keeps
    // the field genuinely blank until HR fills it in via the Job section.
    if (Number(form.salary) > 0) payload.salary = form.salary;
    try {
      const r = await api.post('/hr/employees', payload);
      const created = { ...payload, id: r.data.id, user_id: r.data.linked_user_id ?? payload.user_id, onboarding_status: 'draft' };
      setEditing(created);
      setOriginal(created);
      setForm(created);
      setJoinDateLocked(!!created.join_date);
      toast.success('Created — fill in the remaining sections below');
      onSaved && onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create'); }
  };

  // A section's Save — PUTs only that section's fields, per the plan's
  // 2026-08-04 section-level-saves revision. Same endpoint as before; the
  // call site just fires once per section instead of once per modal-submit.
  const saveSection = async (key) => {
    if (!editing) return;
    const changes = sectionChanges(key);
    const isDocs = key === 'documents';
    const fieldPayload = {};
    for (const k of sections[key] || []) {
      if (DOC_SLOTS.some((d) => d.key === k)) continue;
      fieldPayload[k] = form[k];
    }
    if (isDocs) {
      for (const d of DOC_SLOTS) {
        if (form[d.slot]) {
          const url = await uploadFile(form[d.slot]);
          if (!url) return;
          fieldPayload[d.key] = url;
        } else {
          fieldPayload[d.key] = form[d.key];
        }
      }
    }
    const docsChanged = isDocs && docLabels().length > 0;

    const meta = changeMeta[key];
    const request = { ...fieldPayload };
    if (changes.length > 0 || docsChanged) {
      if (!meta.reason?.trim()) return toast.error('Add a reason for this change');
      request.reason = meta.reason.trim();
    }
    if (changes.length > 0) {
      request.action_code = meta.action_code;
      request.reason_code = meta.reason_code || null;
      request.effective_date = meta.effective_date || istToday();
    }
    const changedKeys = new Set(changes.map((c) => c.key));
    if (changedKeys.has('salary')) {
      if (!meta.salary_action) return toast.error('Pick Pay Revision or Correction for this salary change');
      if (meta.salary_action === 'revision' && !meta.salary_reason_code) return toast.error('Pick a reason for this pay revision');
      request.salary_effective_date = meta.salary_effective_date || istToday();
      request.salary_action = meta.salary_action;
      request.salary_reason_code = meta.salary_action === 'revision' ? meta.salary_reason_code : null;
    }
    if (changedKeys.has('status')) {
      request.status_effective_date = meta.status_effective_date || istToday();
    }

    try {
      await api.put(`/hr/employees/${editing.id}`, request);
      toast.success('Saved');
      setOriginal((o) => ({ ...o, ...fieldPayload }));
      setEditing((e) => ({ ...e, ...fieldPayload }));
      setForm((f) => {
        const next = { ...f, ...fieldPayload };
        if (isDocs) for (const d of DOC_SLOTS) next[d.slot] = null;
        return next;
      });
      if (fieldPayload.join_date !== undefined) setJoinDateLocked(!!fieldPayload.join_date);
      setSectionMeta(key, freshMeta());
      onSaved && onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return {
    sections, isOpen, editing, original, form, setForm,
    changeMeta, setSectionMeta, changedSet, sectionChanges, docLabels,
    joinDateLocked, setJoinDateLocked, revertField, uploading,
    openCreate, openEdit, close, createEmployee, saveSection,
    today: istToday(),
  };
}
