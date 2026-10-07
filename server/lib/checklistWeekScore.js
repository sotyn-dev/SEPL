const { expectedOn, absenceSet, weekDates } = require('./checklistFrequency');
const { istToday } = require('./istDate');

// Score the same task/date occurrences shown in Follow-up. The uploader may
// be an admin; the credit belongs to the checklist's assignee. Multiple
// submissions for one occurrence resolve to the latest, just as in Follow-up.
function checklistWeekScore(db, userId, weekStart) {
  const dates = weekDates(weekStart);
  const tasks = db.prepare(`SELECT * FROM checklists
    WHERE assigned_to=? AND COALESCE(active,1)=1 ORDER BY id`).all(userId);
  const completions = db.prepare(`SELECT cc.* FROM checklist_completions cc
    JOIN checklists c ON c.id=cc.checklist_id
    WHERE c.assigned_to=? AND cc.completion_date BETWEEN ? AND ?
    ORDER BY cc.submitted_at, cc.id`).all(userId, dates[0], dates[5]);
  const latest = new Map(completions.map(c => [`${c.checklist_id}::${c.completion_date}`, c]));
  const away = absenceSet(db, dates);
  const today = istToday();
  const rows = [];
  for (const task of tasks) {
    for (const date of dates) {
      if (!expectedOn(task, date, away)) continue;
      const completion = latest.get(`${task.id}::${date}`);
      const status = completion
        ? completion.approval_status === 'approved' ? 'approved'
          : completion.approval_status === 'rejected' ? 'rejected' : 'submitted'
        : date < today ? 'missed' : date === today ? 'today' : 'future';
      rows.push({
        id: `${task.id}::${date}`, checklist_id: task.id,
        title: task.title, description: task.description, frequency: task.frequency,
        date, status, planned: 1, actual: status === 'approved' ? 1 : 0,
        completion_id: completion?.id || null,
        proof_url: completion?.proof_url || null, notes: completion?.notes || null,
        submitted_at: completion?.submitted_at || null,
      });
    }
  }
  rows.sort((a, b) => b.date.localeCompare(a.date) || a.checklist_id - b.checklist_id);
  return { given: rows.length, done: rows.reduce((n, row) => n + row.actual, 0), rows };
}

module.exports = { checklistWeekScore };
