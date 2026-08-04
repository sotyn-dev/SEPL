import { useState, useEffect, useCallback } from 'react';
import toast from 'react-hot-toast';
import api from '../../api';
import { computeChanges } from '../../constants/employeeChangeCodes';
import { validateEmployeeClient } from '../../constants/employeeValidation';

const istToday = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);

export const DOC_SLOTS = [
  { key: 'aadhar_file',        slot: '_aadhar_file',        label: 'Aadhar Card' },
  { key: 'pan_file',           slot: '_pan_file',           label: 'PAN Card' },
  { key: 'qualification_file', slot: '_qualification_file', label: 'Qualification Certificate' },
  // Statutory/Compliance pack (Module 1, 2026-08-04)
  { key: 'form11_file', slot: '_form11_file', label: 'Form 11 (PF Self-Declaration)' },
  { key: 'formf_file',  slot: '_formf_file',  label: 'Form F (Gratuity Nomination)' },
];

// photo_url is an upload field living in `personal`, not `documents` — same
// "pick a file, hold it in a shadow `_slot` key until Save" mechanism as
// DOC_SLOTS, generalized below (Phase 4) so saveSection() doesn't need to
// special-case which section owns an upload.
export const PHOTO_SLOT = { key: 'photo_url', slot: '_photo_url', label: 'Photo' };
const UPLOAD_SLOTS = [...DOC_SLOTS, PHOTO_SLOT];
const uploadSlotFor = (key) => UPLOAD_SLOTS.find((u) => u.key === key);

// Statutory/Compliance pack sensitive fields (Aadhaar, Bank Account Number) —
// the server never sends the real value back except bank_account_number to
// employee_statutory.can_view holders (see redactStatutory in hr.js), so the
// form field itself is read-only/masked; a genuine edit is typed into this
// shadow key instead and only sent to the server when non-blank — otherwise
// the masked display string would silently overwrite the real value on the
// next save. Mirrors the DOC_SLOTS shadow-key mechanism above.
const SENSITIVE_EDIT_SLOT = { aadhar_number: '_aadhar_number_edit', bank_account_number: '_bank_account_number_edit' };

const freshMeta = () => ({
  action_code: '', reason_code: '', reason: '', effective_date: istToday(),
  salary_effective_date: '', salary_action: '', salary_reason_code: '',
  status_effective_date: '', confirmation_effective_date: '',
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
  const [changeMeta, setChangeMeta] = useState({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), statutory: freshMeta(), documents: freshMeta(), access: freshMeta() });
  const [joinDateLocked, setJoinDateLocked] = useState(false);
  const [uploading, setUploading] = useState(false);
  // Activation-readiness ({overall:{total,done,pct}, sections, errors}) —
  // the Workspace's "N of 21 HR fields complete" signal (Modal's `subtitle`).
  // Same computeCompleteness() Activation itself gates on, so this can never
  // show "done" while Activate would still 400.
  const [completeness, setCompleteness] = useState(null);
  const refreshCompleteness = useCallback((employeeId) => {
    if (!employeeId) return setCompleteness(null);
    api.get(`/hr/employees/${employeeId}/completeness`).then((r) => setCompleteness(r.data)).catch(() => {});
  }, []);

  const openCreate = useCallback(() => {
    setEditing(null);
    setOriginal(null);
    setForm({
      name: '', phone: '', email: '', designation: '', department: '',
      join_date: '', salary: 0, user_id: null, roster: 'general',
      // Form-only defaults for a brand-new hire — never written to the DB
      // until a section Save sends them (see schema.js: no DB-level default,
      // so an existing long-serving employee's blank columns are never
      // fabricated). HR can still change either before saving.
      employment_type: 'Permanent', confirmation_status: 'Probation',
    });
    setChangeMeta({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), statutory: freshMeta(), documents: freshMeta(), access: freshMeta() });
    setJoinDateLocked(false);
    setCompleteness(null);
    setIsOpen(true);
  }, []);

  const openEdit = useCallback((emp) => {
    setEditing(emp);
    setOriginal(emp);
    setForm(emp);
    setChangeMeta({ personal: freshMeta(), employment: freshMeta(), contact: freshMeta(), statutory: freshMeta(), documents: freshMeta(), access: freshMeta() });
    setJoinDateLocked(!!emp.join_date);
    setCompleteness(null);
    refreshCompleteness(emp.id);
    setIsOpen(true);
  }, [refreshCompleteness]);

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

  // Client-side format validation (Mandatory Field Spec) — recomputed from
  // `form` on every render, never blocks on presence (only the Activation
  // gate does that). `fieldError(key)` is what each section renders inline;
  // `sectionErrors(key)` is what saveSection() below gates on.
  // Sensitive fields (see SENSITIVE_EDIT_SLOT) validate whatever's actually
  // about to be SUBMITTED — the shadow edit value — not the masked display
  // string sitting in form[key], which was never real input to begin with.
  const clientErrors = validateEmployeeClient({
    ...form,
    aadhar_number: form._aadhar_number_edit || undefined,
    bank_account_number: form._bank_account_number_edit || form.bank_account_number,
  });
  const fieldError = (key) => clientErrors.find((e) => e.field === key)?.message || null;
  const sectionErrors = (key) => clientErrors.filter((e) => (sections[key] || []).includes(e.field));
  // Any pending (unsaved) upload belonging to a given section — drives both
  // that section's nav dot and whether its Save button treats itself as dirty,
  // for whichever section the upload field actually lives in (documents for
  // KYC, personal for photo_url) — derived from the fetched section map, not
  // hardcoded, so it never drifts from employeeSections.js.
  const sectionUploadDirty = (key) =>
    (sections[key] || []).some((k) => { const u = uploadSlotFor(k); return u && !!form[u.slot]; });

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
      setOriginal(created); // the true persisted row — employment_type/confirmation_status NOT set yet
      // The form keeps the 'Permanent'/'Probation' pre-fill from openCreate
      // (not yet saved) on top of the persisted row, so it reads as a
      // pending Job-section change until HR saves or overrides it.
      setForm({ ...created, employment_type: form.employment_type, confirmation_status: form.confirmation_status });
      setJoinDateLocked(!!created.join_date);
      refreshCompleteness(created.id);
      toast.success('Created — fill in the remaining sections below');
      onSaved && onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed to create'); }
  };

  // A section's Save — PUTs only that section's fields, per the plan's
  // 2026-08-04 section-level-saves revision. Same endpoint as before; the
  // call site just fires once per section instead of once per modal-submit.
  const saveSection = async (key) => {
    if (!editing) return;
    const errs = sectionErrors(key);
    if (errs.length) return toast.error(errs[0].message);
    const changes = sectionChanges(key);
    const fieldPayload = {};
    const shadowUsed = new Set(); // keys whose NEW value came from a masked-field shadow edit
    for (const k of sections[key] || []) {
      const sensSlot = SENSITIVE_EDIT_SLOT[k];
      if (sensSlot) {
        // A typed edit always wins. Otherwise: if the server sent this key's
        // REAL value (privileged bank-account view), resending it unedited is
        // harmless. If only the masked form (form[k] undefined) came back,
        // omit the key entirely — sending the masked string would silently
        // overwrite the real stored value with "••••1234".
        if (form[sensSlot]) { fieldPayload[k] = form[sensSlot]; shadowUsed.add(k); }
        else if (form[k] !== undefined) fieldPayload[k] = form[k];
        continue;
      }
      const upload = uploadSlotFor(k);
      if (!upload) { fieldPayload[k] = form[k]; continue; }
      // Upload field (photo_url, the 3 KYC docs): a pending file in its
      // shadow `_slot` key gets uploaded now; otherwise keep the existing
      // stored URL untouched, whichever section owns the field.
      if (form[upload.slot]) {
        const url = await uploadFile(form[upload.slot]);
        if (!url) return;
        fieldPayload[k] = url;
      } else {
        fieldPayload[k] = form[k];
      }
    }
    const docsChanged = sectionUploadDirty(key);

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
    if (changedKeys.has('confirmation_status')) {
      request.confirmation_effective_date = meta.confirmation_effective_date || istToday();
    }

    try {
      await api.put(`/hr/employees/${editing.id}`, request);
      toast.success('Saved');
      // A shadow-edited sensitive field is excluded from the local merge — its
      // masked display (aadhar_masked/bank_account_masked) only refreshes on
      // the next list fetch (onSaved()), and merging the just-typed plaintext
      // into local state would otherwise briefly render it unmasked. A
      // PRIVILEGED direct edit of bank_account_number (no shadow involved) is
      // real input already sitting in `form` — merge it normally.
      const localPayload = { ...fieldPayload };
      for (const k of shadowUsed) delete localPayload[k];
      setOriginal((o) => ({ ...o, ...localPayload }));
      setEditing((e) => ({ ...e, ...localPayload }));
      setForm((f) => {
        const next = { ...f, ...localPayload };
        for (const k of sections[key] || []) {
          const u = uploadSlotFor(k);
          if (u) next[u.slot] = null;
          const s = SENSITIVE_EDIT_SLOT[k];
          if (s) next[s] = '';
        }
        return next;
      });
      if (fieldPayload.join_date !== undefined) setJoinDateLocked(!!fieldPayload.join_date);
      setSectionMeta(key, freshMeta());
      refreshCompleteness(editing.id);
      onSaved && onSaved();
    } catch (err) { toast.error(err.response?.data?.error || 'Failed'); }
  };

  return {
    sections, isOpen, editing, original, form, setForm,
    changeMeta, setSectionMeta, changedSet, sectionChanges, docLabels, sectionUploadDirty,
    joinDateLocked, setJoinDateLocked, revertField, uploading, completeness,
    fieldError, sectionErrors,
    openCreate, openEdit, close, createEmployee, saveSection,
    today: istToday(),
  };
}
