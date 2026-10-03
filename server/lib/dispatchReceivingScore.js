// A receiving stays in its original upload week (IST). Later approval updates
// that week's Actual; edits/replacements neither move nor duplicate its Plan.
function dispatchReceivingScore(db, userId, sinceDate, untilDate) {
  return db.prepare(`SELECT COUNT(*) AS given,
    COALESCE(SUM(CASE WHEN status='approved' THEN 1 ELSE 0 END),0) AS done
    FROM dispatch_receiving
    WHERE created_by=? AND TRIM(COALESCE(receiving_url,''))<>''
      AND date(created_at, '+330 minutes') BETWEEN ? AND ?`).get(userId, sinceDate, untilDate);
}

module.exports = { dispatchReceivingScore };
