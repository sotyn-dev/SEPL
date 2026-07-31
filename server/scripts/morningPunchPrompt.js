// Daily 09:00 morning-manpower reminder — SPOS (mam 2026-07-29).
//
// SPOS HR compliance checklist: "Daily Attendance Submitted by 09:00 AM".
// At 9 AM each working day, find every active site whose contractor
// attendance (Morning Manpower punch) hasn't been recorded yet today and
// push a reminder to its site engineer. Admins get a rollup when
// compliance is below 50%.
//
// Mirrors dprAutoPrompt.js (18:00 DPR nudge) — same scheduling pattern,
// same push library, Sunday off. Skip via ERP_DISABLE_PUNCH_PROMPT=1.

const { getDb } = require('../db/schema');

const TARGET_HOUR = 9;
const TARGET_MIN = 0;

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isSunday() { return new Date().getDay() === 0; }   // 6-day week, Sunday off

// Active sites with NO contractor_attendance row today, grouped by engineer.
function findEngineersOwingPunch(db) {
  const today = todayIso();
  return db.prepare(`
    SELECT DISTINCT u.id user_id, u.name user_name, COUNT(s.id) site_count,
           GROUP_CONCAT(s.name, ' · ') site_names
    FROM sites s
    JOIN users u ON s.site_engineer_id = u.id
    WHERE s.status = 'active'
      AND u.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM contractor_attendance ca
        WHERE ca.site_id = s.id AND ca.attendance_date = ?
      )
    GROUP BY u.id, u.name
  `).all(today);
}

async function runOnce() {
  if (process.env.ERP_DISABLE_PUNCH_PROMPT === '1') return;
  if (isSunday()) { console.log('[punch-prompt] Sunday, skipping'); return; }
  let pushLib;
  try { pushLib = require('../lib/push'); }
  catch (e) { console.warn('[punch-prompt] push lib missing:', e.message); return; }

  const db = getDb();
  const today = todayIso();
  const owing = findEngineersOwingPunch(db);

  if (owing.length === 0) {
    console.log(`[punch-prompt] ${today} 09:00 — every active site has its morning manpower punched`);
    return;
  }

  for (const eng of owing) {
    const sitesShort = eng.site_count === 1
      ? eng.site_names
      : `${eng.site_count} sites: ${(eng.site_names || '').slice(0, 80)}${(eng.site_names || '').length > 80 ? '…' : ''}`;
    pushLib.notify(eng.user_id, {
      title: '👷 Morning Manpower — 9 AM',
      body: `Punch today's contractor attendance for ${sitesShort} (SPOS: attendance by 09:00).`,
      url: '/dpr',
      tag: `punch-reminder-${today}-${eng.user_id}`,
    });
  }

  // Rollup to admins when punch compliance is under 50%
  const totalActiveSites = db.prepare(`SELECT COUNT(*) c FROM sites WHERE status='active'`).get()?.c || 0;
  const punchedSites = db.prepare(`SELECT COUNT(DISTINCT site_id) c FROM contractor_attendance WHERE attendance_date=?`).get(today)?.c || 0;
  const compliance = totalActiveSites > 0 ? Math.round((punchedSites / totalActiveSites) * 100) : 100;
  if (compliance < 50) {
    const adminIds = db.prepare(`SELECT id FROM users WHERE role='admin' AND active=1`).all().map(r => r.id);
    pushLib.notifyMany(adminIds, {
      title: '⚠ Morning attendance below 50%',
      body: `Only ${punchedSites}/${totalActiveSites} sites punched contractor attendance by 9 AM (${compliance}%). ${owing.length} engineers reminded.`,
      url: '/dpr',
      tag: `punch-rollup-${today}`,
    });
  }

  console.log(`[punch-prompt] ${today} 09:00 — ${owing.length} engineers reminded, ${punchedSites}/${totalActiveSites} sites punched (${compliance}%)`);
}

// Drift-correct setTimeout to the next 09:00, then setInterval at 24h —
// same pattern as dprAutoPrompt.js / dailyAuditSnapshot.js.
function scheduleMorningPunchPrompt() {
  if (process.env.ERP_DISABLE_PUNCH_PROMPT === '1') {
    console.log('[punch-prompt] disabled via ERP_DISABLE_PUNCH_PROMPT');
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[punch-prompt] first run scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    runOnce().catch(e => console.error('[punch-prompt] error:', e.message));
    setInterval(() => {
      runOnce().catch(e => console.error('[punch-prompt] error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

module.exports = { scheduleMorningPunchPrompt, runOnce };
