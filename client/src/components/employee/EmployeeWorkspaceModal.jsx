import { useState, useEffect } from 'react';
import { FiUser, FiBriefcase, FiPhone, FiFileText, FiShield, FiDollarSign, FiLink, FiArrowRight } from 'react-icons/fi';
import Modal from '../Modal';
import SearchableSelect from '../SearchableSelect';
import EmployeeChangeCard from '../EmployeeChangeCard';
import PersonalSection from './sections/PersonalSection';
import EmploymentSection from './sections/EmploymentSection';
import ContactSection from './sections/ContactSection';
import StatutorySection from './sections/StatutorySection';
import CompensationSection from './sections/CompensationSection';
import DocumentsSection from './sections/DocumentsSection';

// Compensation (Module 2, 2026-08-04) is entirely gated behind
// employee_salary.can_view (no new permission — reuses the same flag that
// already gates the `salary` field itself, see the plan's "Decisions locked
// in" section) — a holder-less viewer never even sees the tab, rather than
// seeing an empty/error-prone one whose 14 fields the server always strips.
const BASE_NAV = [
  { key: 'personal', label: 'Personal', icon: FiUser, Section: PersonalSection },
  { key: 'employment', label: 'Job', icon: FiBriefcase, Section: EmploymentSection },
  { key: 'contact', label: 'Contact', icon: FiPhone, Section: ContactSection },
  { key: 'compensation', label: 'Compensation', icon: FiDollarSign, Section: CompensationSection },
  { key: 'statutory', label: 'Statutory', icon: FiShield, Section: StatutorySection },
  { key: 'documents', label: 'Docs', icon: FiFileText, Section: DocumentsSection },
];

// The Employee Workspace shell (plan: keep-confirmation-status-separate-
// elegant-beacon, 2026-08-04 revision). Phase 3 scope: restructure only,
// existing fields — the 17 HR-pack fields pour into these same four
// sections in Phase 4 with no shell change needed.
//
// Sections stay mounted always, toggled by CSS block/hidden (never
// unmounted — that would drop <input type="file"> selections). Each section
// owns its own Save button and its own EmployeeChangeCard instance, since
// saves are per-section now: a section's Save PUTs only that section's
// fields, so its reason/action prompt is scoped to exactly that.
export default function EmployeeWorkspaceModal({ ws, employees, users, canSeeSalary }) {
  const [tab, setTab] = useState('personal');
  useEffect(() => { if (ws.isOpen) setTab('personal'); }, [ws.isOpen]);
  const NAV = BASE_NAV.filter((n) => n.key !== 'compensation' || canSeeSalary);

  const dirty = (key) => ws.sectionChanges(key).length > 0 || ws.sectionUploadDirty(key);
  const subtitle = ws.editing && ws.completeness
    ? `${ws.completeness.overall.done} of ${ws.completeness.overall.total} HR fields complete`
    : undefined;

  return (
    <Modal isOpen={ws.isOpen} onClose={ws.close} title={ws.editing ? 'Edit Employee' : 'Add Employee'} subtitle={subtitle} xwide={!!ws.editing}>
      {!ws.editing ? (
        <QuickCreate ws={ws} />
      ) : (
        <div className="space-y-4">
          <UserLinkBar ws={ws} users={users} />
          <div className="flex flex-col lg:flex-row gap-4">
            <div className="flex lg:flex-col gap-1 lg:w-40 flex-shrink-0 overflow-x-auto lg:overflow-visible border-b lg:border-b-0 lg:border-r border-gray-200 pb-2 lg:pb-0 lg:pr-3">
              {NAV.map((n) => {
                const errCount = ws.sectionErrors(n.key).length;
                return (
                  <button
                    key={n.key}
                    type="button"
                    onClick={() => setTab(n.key)}
                    className={`flex items-center gap-2 px-3 py-2 rounded-lg text-sm font-semibold whitespace-nowrap ${tab === n.key ? 'bg-red-50 text-red-700' : 'text-gray-600 hover:bg-gray-50'}`}>
                    <n.icon size={14} />{n.label}
                    {errCount > 0 ? (
                      <span className="text-[9px] font-bold text-white bg-red-500 rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none ml-1" title={`${errCount} field error${errCount === 1 ? '' : 's'}`}>{errCount}</span>
                    ) : dirty(n.key) && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 ml-1" title="Unsaved changes" />}
                  </button>
                );
              })}
            </div>

            <div className="flex-1 min-w-0 space-y-4">
              {NAV.map(({ key, Section }) => (
                <div key={key} className={tab === key ? 'flex flex-col items-stretch min-h-[150px] space-y-4' : 'hidden'}>
                  <Section ws={ws} employees={employees} users={users} canSeeSalary={canSeeSalary} />
                  <SectionFooter ws={ws} sectionKey={key} users={users} employees={employees} canSeeSalary={canSeeSalary} />
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}

// The linked ERP login gets a dedicated, always-visible spot at the very top
// of the Workspace (2026-08-04) — it's a system-access relationship, not a
// fact about the person, so it doesn't belong buried inside a tab the way it
// used to (Docs → "ERP Access"). Its own one-field section in
// employeeSections.js ('access') keeps this independent of whichever tab is
// open: changing it here never touches Docs' KYC fields, and vice versa.
//
// Reason capture is deliberately NOT the full EmployeeChangeCard — that
// component's Action/Effective-date apparatus exists for fields with a real
// range of human-judgement labels (Promotion vs Transfer vs Correction...).
// A login link has exactly one meaningful action regardless of direction
// ("Access Change" — computed server-side, see suggestAction), so offering
// a picker would just be a dropdown with one sensible answer. Just the
// before→after fact and a direct reason, nothing to choose.
function UserLinkBar({ ws, users }) {
  const { form, setForm, original } = ws;
  const changes = ws.sectionChanges('access');
  const dirty = changes.length > 0;
  const userLabel = (id) => users.find((u) => u.id === id)?.name || 'Not linked';

  return (
    <div className="pb-4 border-b border-gray-200">
      <div className="flex flex-wrap items-center gap-2">
        <FiLink className="text-gray-400 shrink-0" size={14} />
        <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide shrink-0">Linked login</span>
        <div className="flex-1 min-w-[220px] max-w-sm">
          <SearchableSelect
            options={users.map((u) => ({ ...u, label: `${u.name} (${u.username || u.email})` }))}
            value={form.user_id || null}
            valueKey="id"
            displayKey="label"
            placeholder="Search by name, username or email…"
            onChange={(u) => setForm({ ...form, user_id: u?.id || null })}
          />
        </div>
        {dirty && (
          <button type="button" onClick={() => ws.saveSection('access')} disabled={ws.uploading} className="btn btn-primary !py-1.5 text-xs disabled:opacity-50">
            Save
          </button>
        )}
        <span className="text-[10px] text-gray-400 basis-full">Required for DPR Staff Cost auto-calc. If left blank and email matches a user, it auto-links on save.</span>
      </div>
      {dirty && (
        <div className="mt-2 bg-slate-50 border border-slate-200 rounded-lg p-2.5 space-y-2">
          <div className="text-[11px] text-gray-600 flex items-center gap-1.5">
            {userLabel(original?.user_id)} <FiArrowRight size={10} className="text-gray-400" /> <span className="font-semibold text-gray-800">{userLabel(form.user_id)}</span>
          </div>
          <textarea
            className="input"
            rows={2}
            placeholder="Why is this login link changing? (required — appears in the HR report)"
            value={ws.changeMeta.access.reason || ''}
            onChange={(e) => ws.setSectionMeta('access', (m) => ({ ...m, reason: e.target.value }))}
          />
        </div>
      )}
    </div>
  );
}

function SectionFooter({ ws, sectionKey, users, employees, canSeeSalary }) {
  const changes = ws.sectionChanges(sectionKey);
  const docLabels = sectionKey === 'documents' ? ws.docLabels() : [];
  const meta = ws.changeMeta[sectionKey];
  const hasErrors = ws.sectionErrors(sectionKey).length > 0;

  return (
    <>
      {(changes.length > 0 || docLabels.length > 0) && (
        <EmployeeChangeCard
          changes={changes}
          docLabels={docLabels}
          statusTo={ws.form.status}
          meta={meta}
          setMeta={(updater) => ws.setSectionMeta(sectionKey, updater)}
          canSeeSalary={canSeeSalary}
          today={ws.today}
          users={users}
          employees={employees}
          employeeId={ws.editing?.id}
        />
      )}
      <div className="flex justify-end !mt-auto pt-6">
        <button
          type="button"
          onClick={() => ws.saveSection(sectionKey)}
          disabled={ws.uploading || hasErrors}
          title={hasErrors ? 'Fix the highlighted field(s) before saving' : undefined}
          className="btn btn-primary disabled:opacity-50">
          {ws.uploading ? 'Uploading…' : 'Save section'}
        </button>
      </div>
    </>
  );
}

// Create mode has nothing to section yet — the record doesn't exist. One
// lightweight form (name is the only requirement, per Phase 2.5's Draft
// lifecycle) that, on success, hands the SAME open modal a persisted
// employee id and flips into the sectioned edit view above.
function QuickCreate({ ws }) {
  const { form, setForm, close, createEmployee } = ws;
  return (
    <form onSubmit={(e) => { e.preventDefault(); createEmployee(); }} className="space-y-4">
      <p className="text-xs text-gray-500">Only a name is needed to create the record — everything else can be filled in over time, before this employee is activated.</p>
      <div>
        <label className="label">Name *</label>
        <input className="input" value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} required autoFocus />
      </div>
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="label">Phone</label>
          <input className="input" value={form.phone || ''} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div>
          <label className="label">Email</label>
          <input className="input" value={form.email || ''} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
      </div>
      <div className="flex justify-end gap-3">
        <button type="button" onClick={close} className="btn btn-secondary">Cancel</button>
        <button type="submit" className="btn btn-primary">Create</button>
      </div>
    </form>
  );
}
