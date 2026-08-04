import { useState, useEffect } from 'react';
import { FiLock, FiUnlock } from 'react-icons/fi';
import api from '../../../api';
import SearchableSelect from '../../SearchableSelect';
import WasHint, { FieldError, trackAccent } from '../WasHint';
import { fmtDate } from '../../../utils/datetime';
import { JOIN_DATE_MIN, JOIN_DATE_MAX } from '../../../constants/employeeValidation';

const EMPLOYMENT_TYPES = ['Permanent', 'Contract', 'Intern', 'Vendor'];
const CONFIRMATION_STATUSES = ['Probation', 'Confirmed', 'Terminated'];
const NOTICE_PERIODS = [30, 60, 90];

// Grade catalog is server data (org_grades), not a hand-listed enum — fetched
// once and cached at module scope, same pattern as useEmployeeForm.js's
// sectionsCache, so re-opening the Workspace never re-fetches it.
let gradesCache = null;
let gradesPromise = null;
function fetchGrades() {
  if (gradesCache) return Promise.resolve(gradesCache);
  if (!gradesPromise) gradesPromise = api.get('/hr/grades').then((r) => { gradesCache = r.data; return gradesCache; });
  return gradesPromise;
}

// +6 months, date-string in, date-string out — used only for the probation
// suggestion below, never written to the field until HR clicks "Use".
const plusMonths = (ymd, months) => {
  if (!ymd) return '';
  const d = new Date(ymd);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
};

// Section key note: this file renders all three "Job" sub-sections (Role &
// Reporting / Employment Terms / Payroll & Shift) — they're one Workspace
// section (`employment` in employeeSections.js) with one Save, just visually
// grouped per the plan's Phase 4 layout guidance.
export default function EmploymentSection({ ws, employees, canSeeSalary }) {
  const { form, setForm, changedSet, original, revertField, joinDateLocked, setJoinDateLocked, editing } = ws;
  const [grades, setGrades] = useState(gradesCache || []);
  useEffect(() => { fetchGrades().then(setGrades); }, []);

  const managers = employees.filter((e) => !editing || e.id !== editing.id);
  const suggestedProbation = form.employment_type === 'Permanent' && form.join_date ? plusMonths(form.join_date, 6) : null;

  return (
    <div className="space-y-4">
      <div>
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Role & Reporting</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'designation')}>
            <label className="label">Designation</label>
            <input className="input" list="empDesigDL" value={form.designation || ''} onChange={(e) => setForm({ ...form, designation: e.target.value })} placeholder="Pick or type" />
            <datalist id="empDesigDL">{[...new Set(employees.map((e) => e.designation).filter(Boolean))].map((d) => <option key={d} value={d} />)}</datalist>
            <WasHint k="designation" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'department')}>
            <label className="label">Department</label>
            <input className="input" list="empDeptDL" value={form.department || ''} onChange={(e) => setForm({ ...form, department: e.target.value })} placeholder="Pick or type" />
            <datalist id="empDeptDL">{[...new Set(employees.map((e) => e.department).filter(Boolean))].map((d) => <option key={d} value={d} />)}</datalist>
            <WasHint k="department" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'reports_to_employee_id')}>
            <label className="label">Reports To</label>
            <SearchableSelect
              options={managers.map((m) => ({ ...m, label: `${m.name}${m.designation ? ` (${m.designation})` : ''}` }))}
              value={form.reports_to_employee_id || null}
              valueKey="id"
              displayKey="label"
              placeholder="Search by name…"
              onChange={(m) => setForm({ ...form, reports_to_employee_id: m?.id || null })}
            />
            <WasHint k="reports_to_employee_id" fmt={(v) => employees.find((e) => e.id === v)?.name || '—'} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'grade')}>
            <label className="label">Grade</label>
            <select className="select" value={form.grade || ''} onChange={(e) => setForm({ ...form, grade: e.target.value })}>
              <option value="">Select…</option>
              {grades.map((g) => <option key={g.code} value={g.code}>{g.label}</option>)}
            </select>
            <WasHint k="grade" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Employment Terms</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className={trackAccent(changedSet, 'employment_type')}>
            <label className="label">Employment Type</label>
            <select className="select" value={form.employment_type || ''} onChange={(e) => setForm({ ...form, employment_type: e.target.value })}>
              <option value="">Select…</option>
              {EMPLOYMENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <WasHint k="employment_type" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'join_date')}>
            <div className="flex items-start justify-start gap-1">
              <label className="label">Join Date</label>
              <button
                type="button"
                onClick={() => setJoinDateLocked(!joinDateLocked)}
                className="border-px border-gray-200 size-4 leading-none relative -top-0.5"
                title={joinDateLocked ? 'Unlock to correct/edit the join date' : 'Lock to stop edit the join date'}
              >
                {joinDateLocked ? <FiLock size={10} className="inline text-gray-400" /> : <FiUnlock size={10} className="inline text-blue-600" />}
              </button>
            </div>
            {joinDateLocked ? (
              <input className="input bg-gray-100 text-gray-500 cursor-not-allowed" type="date" value={form.join_date || ''} disabled />
            ) : (
              <input className="input" type="date" min={JOIN_DATE_MIN} max={JOIN_DATE_MAX} value={form.join_date || ''} onChange={(e) => setForm({ ...form, join_date: e.target.value })} />
            )}
            <WasHint k="join_date" fmt={(v) => fmtDate(v) || '—'} changedSet={changedSet} original={original} revertField={revertField} />
            <FieldError k="join_date" ws={ws} />
          </div>
          <div className={trackAccent(changedSet, 'probation_end_date')}>
            <label className="label">Probation End Date</label>
            <input className="input" type="date" value={form.probation_end_date || ''} onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })} />
            {!form.probation_end_date && suggestedProbation && (
              <p className="text-[10px] text-gray-400 mt-0.5">
                Suggested from {form.employment_type}, +6 months ({fmtDate(suggestedProbation)}) —{' '}
                <button type="button" onClick={() => setForm({ ...form, probation_end_date: suggestedProbation })} className="underline hover:text-gray-600">use</button>
              </p>
            )}
            <WasHint k="probation_end_date" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'confirmation_status')}>
            <label className="label">Confirmation Status</label>
            <select className="select" value={form.confirmation_status || ''} onChange={(e) => setForm({ ...form, confirmation_status: e.target.value })}>
              <option value="">Select…</option>
              {CONFIRMATION_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <WasHint k="confirmation_status" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'notice_period_days')}>
            <label className="label">Notice Period</label>
            <select className="select" value={form.notice_period_days || ''} onChange={(e) => setForm({ ...form, notice_period_days: +e.target.value })}>
              <option value="">Select…</option>
              {NOTICE_PERIODS.map((n) => <option key={n} value={n}>{n} days</option>)}
            </select>
            <WasHint k="notice_period_days" fmt={(v) => `${v} days`} changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>

      <div className="border-t border-dashed pt-4 !mt-6">
        <div className="text-[11px] font-semibold text-gray-400 uppercase tracking-wide mb-2">Payroll & Shift</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {canSeeSalary && (
            <div className={trackAccent(changedSet, 'salary')}>
              <label className="label">Salary (Rs)</label>
              <input className="input" type="number" min="0" value={form.salary || 0} onChange={(e) => setForm({ ...form, salary: +e.target.value })} />
              <WasHint k="salary" fmt={(v) => `₹${Number(v || 0).toLocaleString('en-IN')}`} changedSet={changedSet} original={original} revertField={revertField} />
            </div>
          )}
          <div className={trackAccent(changedSet, 'roster')}>
            <label className="label">Roster / Shift</label>
            <select className="select" value={form.roster || 'general'} onChange={(e) => setForm({ ...form, roster: e.target.value })}>
              <option value="general">General — 9:30 AM to 6:30 PM</option>
              <option value="early">Early — 9:00 AM to 6:00 PM</option>
            </select>
            <WasHint k="roster" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
          <div className={trackAccent(changedSet, 'status')}>
            <label className="label">Status</label>
            <select className="select" value={form.status || ''} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              {['active', 'training', 'inactive', 'terminated'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <WasHint k="status" changedSet={changedSet} original={original} revertField={revertField} />
          </div>
        </div>
      </div>
    </div>
  );
}
