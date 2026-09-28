const SOURCE = 'auto:offer_letters';
const MIGRATION = 'offer_letter_weekly_score_v1';

function countOfferLetters(db, from, to) {
  // One offer per candidate, in its first issue week. Re-saving the MD
  // decision, opening/printing a letter and later onboarding add no counts.
  const dates = db.prepare(`SELECT c.id, c.offer_letter_file,
    MIN(d.issued_at) AS issued_at
    FROM candidates c LEFT JOIN (
      SELECT id AS candidate_id, julianday(offer_sent_at) AS issued_at FROM candidates
      UNION ALL
      SELECT candidate_id, julianday(created_at) FROM candidate_events WHERE event_type='offer_generated'
    ) d ON d.candidate_id=c.id
    GROUP BY c.id`).all();
  const inWeek = db.prepare("SELECT date(?,'+330 minutes') BETWEEN ? AND ? AS matches");
  let count = 0;
  for (const row of dates) {
    let issuedAt = row.issued_at;
    // Legacy uploaded PDFs use the timestamp assigned by the ERP upload route.
    // Never substitute candidate creation or last-edit dates for an offer date.
    const match = /^\/uploads\/(\d{13})-/.exec(String(row.offer_letter_file || '').trim());
    const timestamp = match && Number(match[1]);
    if (timestamp >= Date.UTC(2020, 0, 1) && timestamp <= Date.now()) {
      const uploadedAt = timestamp / 86400000 + 2440587.5;
      issuedAt = issuedAt == null ? uploadedAt : Math.min(issuedAt, uploadedAt);
    }
    if (issuedAt != null && inWeek.get(issuedAt, from, to).matches) count++;
  }
  return count;
}

function initialize(db) {
  if (db.prepare('SELECT 1 FROM app_settings WHERE key=?').get(MIGRATION)) return;
  db.transaction(() => {
    // Preserve the person's existing weekly target, weights and saved entries.
    db.prepare(`UPDATE score_kpis SET data_source=?
      WHERE lower(trim(metric_name))='offer letter' AND data_source='auto:candidates_shortlisted'`).run(SOURCE);
    db.prepare('INSERT INTO app_settings(key,value) VALUES (?,?)').run(MIGRATION, 'done');
  })();
}

module.exports = { countOfferLetters, initialize };
