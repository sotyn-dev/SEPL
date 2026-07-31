// SPOS daily-compliance compute (mam 2026-07-29) — one row per active site
// answering the four SPOS HR-checklist questions for a given date:
//   1. Morning manpower punched? (target: by 09:00 IST)
//   2. DPR submitted? (target: by 20:00 IST evening cutoff)
//   3. Site photos uploaded on the DPR?
//   4. Weekly plan approved for the week containing that date?
// Shared by GET /dpr/spos-compliance (dashboard grid) and the 18:30
// exception-report cron, so both always agree.
//
// DB timestamps (CURRENT_TIMESTAMP) are UTC 'YYYY-MM-DD HH:MM:SS'; all
// targets are IST wall-clock, converted here (IST = UTC+5:30).

const IST_OFFSET_MIN = 330;

// UTC instant for `dateIso hh:mm` IST wall-clock.
function istInstant(dateIso, hh, mm) {
  return new Date(new Date(dateIso + 'T00:00:00Z').getTime() + ((hh * 60 + mm) - IST_OFFSET_MIN) * 60000);
}

// Parse a SQLite UTC timestamp ('YYYY-MM-DD HH:MM:SS') to a Date.
function parseUtc(ts) {
  if (!ts) return null;
  return new Date(String(ts).replace(' ', 'T') + (String(ts).endsWith('Z') ? '' : 'Z'));
}

// Monday of the week containing dateIso (weekly plans are keyed on Mondays).
function mondayOf(dateIso) {
  const d = new Date(dateIso + 'T00:00:00Z');
  const dow = (d.getUTCDay() + 6) % 7;   // Mon=0 … Sun=6
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

function computeSposCompliance(db, dateIso) {
  const weekStart = mondayOf(dateIso);
  const nineAm = istInstant(dateIso, 9, 0);
  const dprCutoff = istInstant(dateIso, 20, 0);

  // Group phantom duplicate sites rows (Excel paste artifacts — the DPR
  // module collapses them the same way in GET /dpr/sites). Every check
  // then looks across ALL the duplicate ids, so a punch/DPR keyed to any
  // one of them counts (audit 2026-07-31: duplicates reported permanent
  // false "missing" gaps to management).
  const siteKey = (name) => String(name || '').replace(/[\s" ']/g, '').toUpperCase();
  const raw = db.prepare(`
    SELECT s.id, s.name, u.name AS engineer_name
      FROM sites s
      LEFT JOIN users u ON u.id = s.site_engineer_id
     WHERE s.status = 'active'
     ORDER BY s.name
  `).all();
  const grouped = new Map();
  for (const s of raw) {
    const k = siteKey(s.name);
    const g = grouped.get(k) || { site_id: s.id, site: s.name, engineer: null, ids: [] };
    g.ids.push(s.id);
    if (!g.engineer && s.engineer_name) g.engineer = s.engineer_name;
    grouped.set(k, g);
  }
  const sites = [...grouped.values()];

  const rows = sites.map(s => {
    const ph2 = s.ids.map(() => '?').join(',');
    const punch = db.prepare(`SELECT MIN(created_at) t, COUNT(*) c FROM contractor_attendance WHERE site_id IN (${ph2}) AND attendance_date = ?`).get(...s.ids, dateIso);
    const dpr = db.prepare(`SELECT submission_time, site_photos FROM dpr WHERE site_id IN (${ph2}) AND report_date = ? AND submission_time IS NOT NULL LIMIT 1`).get(...s.ids, dateIso);
    const plan = db.prepare(`SELECT status, submitted_late FROM weekly_plans WHERE site_id IN (${ph2}) AND week_start = ? ORDER BY CASE status WHEN 'approved' THEN 0 WHEN 'submitted' THEN 1 ELSE 2 END LIMIT 1`).get(...s.ids, weekStart);
    // Photos: dpr.site_photos has no writer yet — the REAL photo evidence
    // in the system today is the morning-punch photo (contractor_attendance
    // .photo_url), so count that too (audit 2026-07-31: the old check was
    // permanently false → daily false alarms to the director).
    const punchPhoto = db.prepare(`SELECT 1 ok FROM contractor_attendance WHERE site_id IN (${ph2}) AND attendance_date = ? AND COALESCE(photo_url,'') <> '' LIMIT 1`).get(...s.ids, dateIso);
    const punchAt = parseUtc(punch.t);
    const dprAt = dpr ? parseUtc(dpr.submission_time) : null;
    const dprPhotos = dpr ? String(dpr.site_photos || '').trim() : '';
    return {
      site_id: s.site_id,
      site_ids: s.ids,
      site: s.site,
      engineer: s.engineer || null,
      punch_done: punch.c > 0,
      punch_at: punch.t || null,
      punch_by_9: punch.c > 0 && !!punchAt && punchAt <= nineAm,
      dpr_done: !!dpr,
      dpr_at: dpr ? dpr.submission_time : null,
      dpr_by_cutoff: !!dpr && !!dprAt && dprAt <= dprCutoff,
      photos_done: !!punchPhoto || (!!dprPhotos && dprPhotos !== '[]' && dprPhotos !== 'null'),
      plan_status: plan ? plan.status : 'missing',
      plan_late: plan ? !!plan.submitted_late : false,
    };
  });

  const n = rows.length || 1;
  const summary = {
    sites: rows.length,
    punch_pct: Math.round(rows.filter(r => r.punch_done).length / n * 100),
    dpr_pct: Math.round(rows.filter(r => r.dpr_done).length / n * 100),
    photos_pct: Math.round(rows.filter(r => r.photos_done).length / n * 100),
    plan_approved_pct: Math.round(rows.filter(r => r.plan_status === 'approved').length / n * 100),
  };
  return { date: dateIso, week_start: weekStart, sites: rows, summary };
}

module.exports = { computeSposCompliance, mondayOf };
