// ONE truth for "does this checklist expect a completion on this date?"
// (mam 2026-08-31: "monthly mean month one time — it pick every day, not
// correct"). Before this, THREE different rules disagreed: the follow-up
// register fired non-daily tasks with no due_date EVERY day ("Missed"
// daily), my-today NEVER showed them, and the scorecard counted every
// checklist as ×6/week. Now every consumer asks this module.
//
// Anchor day when due_date is missing:
//   daily       → every day
//   weekly      → Monday
//   fortnightly → fortnight_days (default "1,15")
//   monthly     → the 1st
//   quarterly   → the 1st of Jan / Apr / Jul / Oct
//   yearly      → 1 Jan
//   once        → its due_date, else the day it was created
// With a due_date set, that date stays the anchor (same day-of-week /
// day-of-month / month+day logic the register already used).
//
// TWO days are never expected (mam 2026-09-12: "if person have checklist but
// he is absent that day checklist automatically not need and sunday checklist
// no need"):
//   * SUNDAY - the company's non-working day. No checklist of any frequency is
//     expected on a Sunday. Note this is a blanket rule: a monthly task whose
//     anchor day happens to fall on a Sunday is simply not expected that month.
//   * the assignee was ABSENT or on LEAVE - `absentSet` carries "userId::date"
//     keys, built by absenceSet() below from the attendance table. Only an
//     EXPLICIT absent/leave row exempts anyone; a missing attendance row does
//     NOT, or every checklist for staff whose attendance nobody tracks would
//     quietly disappear.

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function appliesOn(task, dateStr) {
  if (task.recurrence_start_date && dateStr < String(task.recurrence_start_date).slice(0, 10)) return false;
  if (task.recurrence_end_date && dateStr > String(task.recurrence_end_date).slice(0, 10)) return false;
  const f = String(task.frequency || 'daily').toLowerCase();
  const d = new Date(dateStr + 'T00:00:00');
  if (d.getDay() === 0) return false;         // Sunday - nothing is expected
  const dueIso = task.due_date ? String(task.due_date).slice(0, 10) : null;
  const due = dueIso ? new Date(dueIso + 'T00:00:00') : null;
  if (!f || f === 'daily') return true;
  if (f === 'weekly') return d.getDay() === (due ? due.getDay() : 1);
  if (f === 'fortnightly') {
    const csv = task.fortnight_days && String(task.fortnight_days).trim() ? task.fortnight_days : '1,15';
    const days = csv.split(/[,;|]/).map(s => parseInt(String(s).trim(), 10)).filter(x => x >= 1 && x <= 31);
    return days.length ? days.includes(d.getDate()) : false;
  }
  if (f === 'monthly') return d.getDate() === (due ? due.getDate() : 1);
  if (f === 'quarterly') {
    if (d.getDate() !== (due ? due.getDate() : 1)) return false;
    return (((d.getMonth() - (due ? due.getMonth() : 0)) % 3) + 3) % 3 === 0;
  }
  if (f === 'yearly') return d.getMonth() === (due ? due.getMonth() : 0) && d.getDate() === (due ? due.getDate() : 1);
  if (f === 'once') {
    const anchor = dueIso || (task.created_at ? String(task.created_at).slice(0, 10) : null);
    return anchor ? anchor === dateStr : false;
  }
  return true;   // unknown frequency — stay generous rather than hide work
}

// Who was away, as a set of "userId::YYYY-MM-DD" keys, for the given dates.
// 'absent' and 'leave' both mean the person was not at work, so neither is
// expected to file a checklist that day. 'half_day', 'short_day' and 'late'
// are working days and still count.
//
// One query for the whole window - the callers render a grid, and a per-cell
// query would be N+1 on a synchronous database.
const AWAY = ['absent', 'leave'];

function absenceSet(db, dates) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean).map(d => String(d).slice(0, 10));
  if (!list.length) return new Set();
  const rows = db.prepare(`
    SELECT user_id, date, status FROM attendance
     WHERE status IN (${AWAY.map(() => '?').join(',')})
       AND date IN (${list.map(() => '?').join(',')})
       AND user_id IS NOT NULL
  `).all(...AWAY, ...list);
  return new Set(rows.map(r => `${r.user_id}::${String(r.date).slice(0, 10)}`));
}

// The question every consumer should ask: is a completion expected from THIS
// checklist's assignee on THIS date? Frequency + Sunday + the assignee's own
// attendance. Pass the set from absenceSet(); omit it and only the frequency
// and Sunday rules apply.
function expectedOn(task, dateStr, absentSet) {
  if (!appliesOn(task, dateStr)) return false;
  const uid = task.assigned_to;
  if (absentSet && uid && absentSet.has(`${uid}::${String(dateStr).slice(0, 10)}`)) return false;
  return true;
}

// How many completions the Mon-Sat scoring week expects from this checklist.
// Sunday is outside the loop already; days the assignee was away drop out too,
// so nobody is scored against a day they were not at work.
function weeklyExpected(task, weekStartStr, absentSet) {
  let n = 0;
  const base = new Date(weekStartStr + 'T00:00:00');
  for (let i = 0; i < 6; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (expectedOn(task, fmt(d), absentSet)) n += 1;
  }
  return n;
}

// Every date in a Mon-Sat week, for building an absenceSet over a scoring week.
function weekDates(weekStartStr) {
  const base = new Date(weekStartStr + 'T00:00:00');
  return Array.from({ length: 6 }, (_, i) => {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    return fmt(d);
  });
}

module.exports = { appliesOn, expectedOn, weeklyExpected, absenceSet, weekDates };
