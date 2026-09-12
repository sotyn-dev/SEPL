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
//     expected ON a Sunday. A DAILY task just skips it (the other six days
//     still run). Every other frequency fires on one day only, so a Sunday
//     anchor would lose the whole occurrence - those MOVE TO THE MONDAY after
//     it instead (mam 2026-09-12: "monthly sunday move to monday").
//   * the assignee was ABSENT or on LEAVE - `absentSet` carries "userId::date"
//     keys, built by absenceSet() below from the attendance table. Only an
//     EXPLICIT absent/leave row exempts anyone; a missing attendance row does
//     NOT, or every checklist for staff whose attendance nobody tracks would
//     quietly disappear.

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// The raw frequency test: does this checklist's own recurrence land on this
// date? No Sunday handling here — appliesOn() layers that on top.
function firesOn(task, dateStr) {
  const f = String(task.frequency || 'daily').toLowerCase();
  const d = new Date(dateStr + 'T00:00:00');
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

const addDays = (iso, n) => {
  const d = new Date(iso + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return fmt(d);
};

function appliesOn(task, dateStr) {
  if (task.recurrence_start_date && dateStr < String(task.recurrence_start_date).slice(0, 10)) return false;
  if (task.recurrence_end_date && dateStr > String(task.recurrence_end_date).slice(0, 10)) return false;
  const f = String(task.frequency || 'daily').toLowerCase();
  const dow = new Date(dateStr + 'T00:00:00').getDay();

  // Never ON a Sunday (mam 2026-09-12: "sunday checklist no need").
  if (dow === 0) return false;

  // A DAILY checklist simply skips Sunday — it still runs the other six days,
  // so nothing is lost.
  if (!f || f === 'daily') return true;

  // Its own day, and that day isn't a Sunday.
  if (firesOn(task, dateStr)) return true;

  // Every OTHER frequency fires on one day only, so a Sunday anchor used to
  // lose the whole occurrence — a monthly task anchored on the 1st vanished in
  // any month whose 1st was a Sunday, and a weekly one anchored on Sunday never
  // fired at all. Mam 2026-09-12: "monthly sunday move to monday" — so a Sunday
  // occurrence moves to the Monday after it.
  //
  // Asked about monthly; applied to weekly / fortnightly / quarterly / yearly /
  // once too, because the defect and the fix are identical for all of them and
  // leaving weekly-on-Sunday firing NEVER would be the same bug she just named.
  //
  // No double-firing: if this Monday were itself an anchor, firesOn() above has
  // already returned true. That is the case that matters for fortnightly, whose
  // days list can contain two consecutive dates (e.g. "1,2").
  if (dow === 1) {
    const yesterday = addDays(dateStr, -1);
    if (new Date(yesterday + 'T00:00:00').getDay() === 0 && firesOn(task, yesterday)) {
      // The shifted day must still be inside the task's own recurrence window.
      if (task.recurrence_end_date && dateStr > String(task.recurrence_end_date).slice(0, 10)) return false;
      return true;
    }
  }
  return false;
}

// Who was away, as a set of "userId::YYYY-MM-DD" keys, for the given dates.
// Nobody away is expected to file a checklist (mam 2026-09-12, then "leave also
// no need checklist"). Away means EITHER of two things, because the ERP records
// them in two places:
//
//   1. an attendance row marked 'absent' or 'leave';
//   2. an APPROVED leave_requests row whose from_date..to_date covers the day -
//      this is the one that matters in practice, since a person on three days'
//      casual leave usually has no attendance rows at all for those days. Only
//      checking attendance would have missed exactly the case she asked about.
//
// 'short_leave' is deliberately NOT away: it is a part-day allowance (hours),
// the person is at work, and it already only forgives lateness. 'half_day',
// 'short_day' and 'late' are working days too and still owe their checklist.
//
// A pending or rejected leave request does not exempt anyone - only approved.
//
// Two queries for the whole window, not per cell: the callers render a grid and
// the database is synchronous, so a per-cell query would be a visible N+1.
const AWAY = ['absent', 'leave'];

function absenceSet(db, dates) {
  const list = (Array.isArray(dates) ? dates : [dates]).filter(Boolean).map(d => String(d).slice(0, 10));
  if (!list.length) return new Set();
  const marks = new Set();

  const att = db.prepare(`
    SELECT user_id, date FROM attendance
     WHERE status IN (${AWAY.map(() => '?').join(',')})
       AND date IN (${list.map(() => '?').join(',')})
       AND user_id IS NOT NULL
  `).all(...AWAY, ...list);
  att.forEach(r => marks.add(`${r.user_id}::${String(r.date).slice(0, 10)}`));

  // Approved leave overlapping the window, then expanded onto each day it covers.
  // Same shape attendance.js already uses: from_date <= day AND to_date >= day.
  const lv = db.prepare(`
    SELECT user_id, from_date, to_date FROM leave_requests
     WHERE status = 'approved'
       AND COALESCE(leave_type, '') != 'short_leave'
       AND user_id IS NOT NULL
       AND from_date <= ? AND to_date >= ?
  `).all(list[list.length - 1], list[0]);
  lv.forEach(r => {
    const from = String(r.from_date || '').slice(0, 10);
    const to = String(r.to_date || from).slice(0, 10);
    list.forEach(d => { if (d >= from && d <= to) marks.add(`${r.user_id}::${d}`); });
  });

  return marks;
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
