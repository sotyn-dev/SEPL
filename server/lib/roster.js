// Roster / shift definitions (SEPL 2026-07, meeting Item 4 "roster").
//
// HR wants exactly TWO rosters, assigned per employee:
//   • general — 9:30 AM–6:30 PM  (the default; matches the employment agreement)
//   • early   — 9:00 AM–6:00 PM  (site staff, so a wasted first hour + false OT
//                                 on the 9:30 mindset stops costing money)
//
// Late / half-day CUTOFFS stay admin-tunable in payroll_settings (late_after_time,
// half_day_after_time) and describe the GENERAL roster. The EARLY roster simply
// shifts those cutoffs 30 min earlier, so a 9:00 person is late from 09:16, not
// 09:46 — without the admin having to maintain a second set of times. Add a third
// roster here later (offset only) and every consumer picks it up automatically.

const ROSTERS = {
  general: { key: 'general', label: '9:30 AM – 6:30 PM', start: '09:30', offsetMin: 0 },
  early:   { key: 'early',   label: '9:00 AM – 6:00 PM', start: '09:00', offsetMin: -30 },
};

const DEFAULT_ROSTER = 'general';

// Any unknown / null value falls back to the default so legacy rows and bad
// input can never break payroll or attendance.
function normalizeRoster(r) {
  return Object.prototype.hasOwnProperty.call(ROSTERS, r) ? r : DEFAULT_ROSTER;
}

// Shift an "HH:MM" clock string by deltaMin, clamped to a valid 24h time.
function shiftHHMM(hhmm, deltaMin) {
  if (!hhmm || !/^\d{1,2}:\d{2}$/.test(String(hhmm))) return hhmm;
  const [h, m] = String(hhmm).split(':').map(Number);
  let total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + (m || 0) + (deltaMin || 0)));
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

// Effective cutoffs for an employee on `roster`, derived from the global
// payroll_settings. Returns the roster key/label plus the shifted times.
function rosterCutoffs(settings, roster) {
  const r = ROSTERS[normalizeRoster(roster)];
  const s = settings || {};
  return {
    roster: r.key,
    roster_label: r.label,
    roster_start: r.start,
    late_after_time: shiftHHMM(s.late_after_time || '09:46', r.offsetMin),
    half_day_after_time: shiftHHMM(s.half_day_after_time || '10:00', r.offsetMin),
  };
}

module.exports = { ROSTERS, DEFAULT_ROSTER, normalizeRoster, shiftHHMM, rosterCutoffs };
