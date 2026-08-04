// Employee field registry — ONE list behind the change-history plumbing.
//
// Why this exists: the tracked-field set used to live in four hand-maintained
// copies (TRACKED_FIELDS here, the ten hand-written `if`s in hr.js's PUT, the
// SNAPSHOT_COLS string + both timeline INSERTs, and CHANGE_FIELDS in hr.js).
// Volume was never the problem — SILENT failure was. Forget the hr.js diff and a
// promotion saves with no reason and no History row; forget SNAPSHOT_COLS and the
// timeline column exists but stores NULL forever; forget CHANGE_FIELDS and the
// change is recorded but invisible in History and the Excel reports. None of those
// throw. This module is the single source those four now derive from.
//
// Deliberately NOT derived from here (they fail LOUDLY, so a miss is caught on the
// first save): the POST/PUT destructures, the UPDATE ... SET list, and the schema.js
// ALTER migrations.
//
// ORDER MATTERS: this array is ordered to reproduce CHANGE_FIELDS exactly, because
// buildChangeEvents walks it to emit per-field rows and that ordering is what HR
// sees on the History timeline. TRACKED_FIELDS falls out of the same order for free.
// SNAPSHOT order is irrelevant (a SELECT list, read by name).
//
// Mirrored on the client in client/src/constants/employeeChangeCodes.js — the two
// carry different LABELS on purpose (the Change Card says "Pay"/"Role", History and
// the reports say "Salary"/"Designation"); only the key set must stay in sync.

// Field flags:
//   tracked     → joins the reason-required diff (employee_timeline row + Change Card)
//   snapshot    → read from `employees` and written onto the timeline row
//   changeField → surfaced in History events / Employee Vault / Excel reports
//   timelineCol → column name on employee_timeline when it differs from the
//                 employees column (name→employee_name, user_id→linked_user_label)
//   compare     → 'number' uses Number(x||0) equality, default is trimmed-string
//   money/bool  → display hints consumed by the reports and the Change Card
const FIELDS = [
  { key: 'status',        label: 'Status',       tracked: true, snapshot: true, changeField: true },
  { key: 'salary',        label: 'Salary',       tracked: true, snapshot: true, changeField: true, money: true, compare: 'number' },

  // Payroll-owned: snapshotted so an as-of read is complete, but never
  // reason-prompted on the HR form (payroll writes its own silent system row).
  { key: 'salary_exempt', label: 'Salary exempt', snapshot: true },

  { key: 'designation',   label: 'Designation',  tracked: true, snapshot: true, changeField: true },
  { key: 'department',    label: 'Department',   tracked: true, snapshot: true, changeField: true },
  { key: 'roster',        label: 'Roster',       tracked: true, snapshot: true, changeField: true },
  { key: 'join_date',     label: 'Join date',    tracked: true, snapshot: true, changeField: true },

  // Also payroll-owned — appears in History (it has a real effect HR should see)
  // but is not part of the HR form's tracked set.
  { key: 'ot_eligible',   label: 'OT eligible',  snapshot: true, changeField: true, bool: true },

  { key: 'name',          label: 'Name',         tracked: true, snapshot: true, changeField: true, timelineCol: 'employee_name' },
  { key: 'phone',         label: 'Phone',        tracked: true, snapshot: true, changeField: true },
  { key: 'email',         label: 'Email',        tracked: true, snapshot: true, changeField: true },

  // The snapshot value is the DENORMALIZED "Name (username/email)" label, not the
  // id — so history still reads correctly after the user is renamed or deleted.
  // The diff, however, compares the raw numeric id.
  { key: 'user_id',       label: 'Linked user',  tracked: true, snapshot: true, changeField: true, timelineCol: 'linked_user_label', compare: 'number', snapshotFrom: 'linkedUserLabel' },

  // Employee lifecycle (plan revision 2026-08-04) — snapshotted so History
  // reads "as of this date" correctly, and shown as its own event on the
  // timeline (see employeeChangeCodes.js's classifyEvent). NOT tracked:
  // Activation (hr.js POST /employees/:id/activate) writes its own row
  // through its own code path, not through the generic reason-required diff.
  { key: 'onboarding_status', label: 'Onboarding status', snapshot: true, changeField: true },

  // Mandatory Field Spec — HR pack career-event fields (Phase 5, 2026-08-04):
  // these 4 have no isolation quirks, so they slot into the shared diff/
  // History path exactly like designation/department/roster above.
  { key: 'grade',              label: 'Grade',              tracked: true, snapshot: true, changeField: true },
  { key: 'employment_type',    label: 'Employment type',    tracked: true, snapshot: true, changeField: true },
  { key: 'probation_end_date', label: 'Probation end date', tracked: true, snapshot: true, changeField: true },
  { key: 'notice_period_days', label: 'Notice period',      tracked: true, snapshot: true, changeField: true },

  // confirmation_status gets its OWN isolated effective date (like salary and
  // status) — the shared effective_date is hard-capped at today (hr.js), and
  // probation confirmations are routinely dated forward ("confirmed w.e.f.
  // the 1st"). Still tracked/diffed/shown in History the same as any other
  // field — only its SAVE-TIME date is isolated (confirmation_effective_from,
  // handled directly in employeeTimeline.js/hr.js, same as
  // salary_effective_from/status_effective_from — NOT part of this registry,
  // since it isn't an `employees` column, only an `employee_timeline` one).
  { key: 'confirmation_status', label: 'Confirmation status', tracked: true, snapshot: true, changeField: true },

  // Diffed/edited on the raw manager id (compare:'number', like user_id
  // above), but the value actually SNAPSHOTTED into history is the
  // denormalized manager NAME — same reasoning as linked_user_label, so
  // History stays readable after a manager is renamed or removed. The raw id
  // also lands in employee_timeline.manager_id, but that's populated
  // directly in employeeTimeline.js (not through this registry, for the same
  // reason confirmation_effective_from isn't: one FIELDS entry can only
  // target one timeline column).
  { key: 'reports_to_employee_id', label: 'Reports to', tracked: true, snapshot: true, changeField: true, timelineCol: 'manager_label', compare: 'number', snapshotFrom: 'managerLabel' },
];

const byKey = new Map(FIELDS.map((f) => [f.key, f]));

// The employees columns to SELECT for a timeline snapshot. `id` is always first —
// recordEmployeeChange needs it and it is not a "field".
const SNAPSHOT_SELECT = ['id', ...FIELDS.filter((f) => f.snapshot).map((f) => f.key)].join(', ');

// employee_timeline column names for the snapshot half of an INSERT.
const snapshotTimelineCols = () =>
  FIELDS.filter((f) => f.snapshot).map((f) => f.timelineCol || f.key);

// Values aligned to snapshotTimelineCols(). `ctx` supplies anything that is
// computed rather than copied straight off the employees row.
const snapshotValues = (emp, ctx = {}) =>
  FIELDS.filter((f) => f.snapshot).map((f) => (f.snapshotFrom ? ctx[f.snapshotFrom] : emp[f.key]));

// The HR form's tracked set, in CHANGE_FIELDS order.
const trackedKeys = () => FIELDS.filter((f) => f.tracked).map((f) => f.key);

// What History / Vault / reports render, keyed by TIMELINE column name.
const changeFields = () =>
  FIELDS.filter((f) => f.changeField).map((f) => ({
    key: f.timelineCol || f.key,
    label: f.label,
    ...(f.money ? { money: true } : {}),
    ...(f.bool ? { bool: true } : {}),
  }));

// Diff `next` (the incoming, already-normalized values) against `before` (the live
// row). Returns the changed tracked keys. Comparison semantics are preserved
// exactly from the hand-written version this replaced: trimmed-string equality,
// except where compare:'number' asks for Number(x||0).
const norm = (v) => (v == null ? '' : String(v).trim());
function diffTracked(before, next) {
  const changed = [];
  for (const f of FIELDS) {
    if (!f.tracked) continue;
    const a = next[f.key];
    const b = before[f.key];
    const moved = f.compare === 'number'
      ? Number(a || 0) !== Number(b || 0)
      : norm(a) !== norm(b);
    if (moved) changed.push(f.key);
  }
  return changed;
}

module.exports = {
  FIELDS,
  byKey,
  SNAPSHOT_SELECT,
  snapshotTimelineCols,
  snapshotValues,
  trackedKeys,
  changeFields,
  diffTracked,
};
