// Actual response uses completion time, never the time a future call was scheduled.
function leadResponseScore(db, userId, from, to) {
  const result = db.prepare(`
    SELECT COUNT(*) observations, AVG((julianday(f.completed_at)-julianday(l.created_at))*24) hours
    FROM sales_funnel l
    JOIN lead_followups f ON f.id=(
      SELECT first.id FROM lead_followups first
      WHERE first.lead_id=l.id AND first.done=1 AND first.completed_at IS NOT NULL
      ORDER BY first.completed_at,first.id LIMIT 1
    )
    WHERE f.done_by=? AND date(l.created_at,'+330 minutes') BETWEEN ? AND ?
      AND julianday(f.completed_at)>=julianday(l.created_at)
      AND NOT EXISTS (SELECT 1 FROM lead_followups unknown
        WHERE unknown.lead_id=l.id AND unknown.done=1 AND unknown.completed_at IS NULL)
  `).get(userId, from, to);
  return { given: null, done: result.hours == null ? null : Math.round(result.hours * 100) / 100,
    observations: result.observations, noData: result.hours == null };
}
module.exports = { leadResponseScore };
