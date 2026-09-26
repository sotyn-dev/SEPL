const { expectedOn, absenceSet } = require('./checklistFrequency');
const { istToday } = require('./istDate');

// Personal occurrences only, including management checklists assigned to everyone.
function checklistDashboard(db, userId, back = 30) {
  const today = istToday();
  back = Math.min(365, Math.max(0, Number.parseInt(back, 10) || 30));
  const dates = Array.from({length:back + 1}, (_, i) => {
    const d = new Date(today + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - back + i);
    return d.toISOString().slice(0,10);
  });
  const tasks = db.prepare(`SELECT c.*, u.name AS assigned_by_name FROM checklists c
    LEFT JOIN users u ON u.id=c.created_by
    WHERE (c.assigned_to=? OR c.assigned_to IS NULL)
    AND (c.status IS NULL OR c.status IN ('pending','active',''))`).all(userId);
  const completions = db.prepare(`SELECT * FROM checklist_completions WHERE user_id=? AND completion_date BETWEEN ? AND ?`).all(userId,dates[0],today);
  const byDay = new Map(completions.map(c => [`${c.checklist_id}:${c.completion_date}`,c]));
  const away = absenceSet(db, dates);
  const rows = [];
  for (const task of tasks) for (const date of dates) {
    const comp = byDay.get(`${task.id}:${date}`);
    const created = String(task.created_at || '').slice(0,10);
    if (created && date < created) continue;
    if (!comp && !expectedOn({...task, assigned_to:userId},date,away)) continue;
    rows.push({...task,key:`${task.id}:${date}`,occurrence:date,due_date:date,
      status:comp ? comp.approval_status === 'approved' ? 'approved' : comp.approval_status === 'rejected' ? 'rejected' : 'submitted' : 'pending',
      proof_url:comp?.proof_url || null,proof_notes:comp?.notes || '',reject_reason:comp?.approval_note || '',completion_id:comp?.id || null});
  }
  return {rows,from:dates[0],to:today};
}
module.exports = { checklistDashboard };
