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

const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function appliesOn(task, dateStr) {
  if (task.recurrence_start_date && dateStr < String(task.recurrence_start_date).slice(0, 10)) return false;
  if (task.recurrence_end_date && dateStr > String(task.recurrence_end_date).slice(0, 10)) return false;
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

// How many completions the Mon–Sat scoring week expects from this checklist.
function weeklyExpected(task, weekStartStr) {
  let n = 0;
  const base = new Date(weekStartStr + 'T00:00:00');
  for (let i = 0; i < 6; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    if (appliesOn(task, fmt(d))) n += 1;
  }
  return n;
}

module.exports = { appliesOn, weeklyExpected };
