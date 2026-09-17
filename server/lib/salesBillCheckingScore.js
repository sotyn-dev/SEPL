// Count completed checks, not bill creation or client-sending events.
function salesBillCheckingScore(db, userId, sinceDate, untilDate) {
  const { count } = db.prepare(`SELECT COUNT(*) AS count FROM sales_bills
    WHERE bill_type=3 AND checked_by=? AND checked_at IS NOT NULL
      AND date(checked_at, '+330 minutes') BETWEEN ? AND ?`).get(userId, sinceDate, untilDate);
  return { given: null, done: count };
}

function migrateSalesBillCheckingScore(db) {
  const key = 'migration_sales_bill_checking_score_v1';
  if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(key)) return;
  db.transaction(() => {
    const update = db.prepare("UPDATE score_kpis SET data_source='auto:sales_bill_checking' WHERE id=?");
    for (const row of db.prepare('SELECT id, metric_name FROM score_kpis').all()) {
      const name = String(row.metric_name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (['ra bill sales bill checking', 'ra sales bill checking', 'ra bills sales bills checking'].includes(name)) update.run(row.id);
    }
    db.prepare('INSERT INTO app_settings(key,value) VALUES(?,?)').run(key, '1');
  })();
}

module.exports = { salesBillCheckingScore, migrateSalesBillCheckingScore };
