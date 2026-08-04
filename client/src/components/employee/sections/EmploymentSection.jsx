import { FiLock, FiUnlock } from 'react-icons/fi';
import WasHint, { trackAccent } from '../WasHint';
import { fmtDate } from '../../../utils/datetime';

// Phase 3 scope: designation, department, join_date, salary, roster, status —
// the existing 6 of this section's eventual 12 fields (reports_to, grade,
// employment_type, probation_end_date, confirmation_status, notice_period
// arrive in Phase 4, already grouped here via employeeSections.js).
export default function EmploymentSection({ ws, employees, canSeeSalary }) {
  const { form, setForm, changedSet, original, revertField, joinDateLocked, setJoinDateLocked } = ws;
  return (
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
          <input className="input" type="date" value={form.join_date || ''} onChange={(e) => setForm({ ...form, join_date: e.target.value })} />
        )}
        <WasHint k="join_date" fmt={(v) => fmtDate(v) || '—'} changedSet={changedSet} original={original} revertField={revertField} />
      </div>

      <div className={trackAccent(changedSet, 'status')}>
        <label className="label">Status</label>
        <select className="select" value={form.status || ''} onChange={(e) => setForm({ ...form, status: e.target.value })}>
          {['active', 'training', 'inactive', 'terminated'].map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <WasHint k="status" changedSet={changedSet} original={original} revertField={revertField} />
      </div>

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
    </div>
  );
}
