// Daily 18:00 DPR auto-prompt — TOC v3 P1 #4.
//
// At 6 PM local time each working day, look up every site engineer
// who has an assigned active site BUT hasn't yet submitted a DPR for
// that site today, and push a notification reminder.
//
// The DPR adherence number on the CMD dashboard is currently low
// because engineers forget to submit by EOD.  This nudge brings the
// adherence % up without any other change — TOC v3 P1 quick win.
//
// Skip via ERP_DISABLE_DPR_PROMPT=1 in dev / staging.

const { getDb } = require('../db/schema');

const TARGET_HOUR = 18;   // 18:00 = 6 PM
const TARGET_MIN = 0;

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isWeekend() {
  const d = new Date().getDay();
  return d === 0; // Sunday only; SEPL works 6-day week with Saturday active
}

// Find site engineers who own at least one active site but who haven't
// submitted a DPR today for any of those sites.
function findEngineersOwingDpr(db) {
  const today = todayIso();
  // sites.site_engineer_id is the primary; some sites also store a
  // CSV in a sister column.  Stick with the FK column for simplicity.
  return db.prepare(`
    SELECT DISTINCT u.id user_id, u.name user_name, COUNT(s.id) site_count,
           GROUP_CONCAT(s.name, ' · ') site_names
    FROM sites s
    JOIN users u ON s.site_engineer_id = u.id
    WHERE s.status = 'active'
      AND u.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM dpr d
        WHERE d.site_id = s.id AND d.report_date = ?
      )
    GROUP BY u.id, u.name
  `).all(today);
}

// Also notify the directors / admin pool when adherence is below 50%
// so management knows before tomorrow's standup.
function findAdminsForRollup(db) {
  return db.prepare(`SELECT id FROM users WHERE role='admin' AND active=1`).all().map(r => r.id);
}

// Same WHERE clause as findEngineersOwingDpr but ungrouped — one row per
// (user, site) miss, since dpr_compliance_log needs site-level granularity
// that the GROUP_CONCAT'd version above collapses away (director ask,
// 2026-07-25: "link HR attendance to DPR — if it's not uploaded on time").
function findEngineerSiteMisses(db) {
  const today = todayIso();
  return db.prepare(`
    SELECT u.id user_id, s.id site_id
    FROM sites s
    JOIN users u ON s.site_engineer_id = u.id
    WHERE s.status = 'active'
      AND u.active = 1
      AND NOT EXISTS (
        SELECT 1 FROM dpr d
        WHERE d.site_id = s.id AND d.report_date = ?
      )
  `).all(today);
}

// Log every (user, site) miss for the day so HR has a persistent,
// queryable compliance history — the push notification alone disappears
// once the day passes. Idempotent: UNIQUE(user_id, site_id, report_date)
// on dpr_compliance_log means re-running the sweep never double-logs.
function logComplianceMisses(db) {
  const today = todayIso();
  const misses = findEngineerSiteMisses(db);
  const insert = db.prepare(
    `INSERT OR IGNORE INTO dpr_compliance_log (user_id, site_id, report_date, status) VALUES (?,?,?,'missed')`
  );
  for (const m of misses) insert.run(m.user_id, m.site_id, today);
  return misses.length;
}

async function runOnce() {
  if (process.env.ERP_DISABLE_DPR_PROMPT === '1') return;
  if (isWeekend()) { console.log('[dpr-prompt] Sunday, skipping'); return; }
  let pushLib;
  try { pushLib = require('../lib/push'); }
  catch (e) { console.warn('[dpr-prompt] push lib missing:', e.message); return; }

  const db = getDb();
  const today = todayIso();
  const owing = findEngineersOwingDpr(db);
  const loggedMisses = logComplianceMisses(db);
  if (loggedMisses) console.log(`[dpr-prompt] ${today} 18:00 — logged ${loggedMisses} compliance miss(es)`);

  if (owing.length === 0) {
    console.log(`[dpr-prompt] ${today} 18:00 — every active site has a DPR submitted, no prompts sent`);
    return;
  }

  // Per-engineer push (each gets a personalised message naming their sites)
  for (const eng of owing) {
    const sitesShort = eng.site_count === 1
      ? eng.site_names
      : `${eng.site_count} sites: ${(eng.site_names || '').slice(0, 80)}${(eng.site_names || '').length > 80 ? '…' : ''}`;
    pushLib.notify(eng.user_id, {
      title: '📋 DPR reminder — 6 PM',
      // Deep-link straight into Quick DPR (director 2026-07-26): everything
      // is pre-filled there — the tap lands them one confirm away from done.
      body: `Tap to file today's DPR for ${sitesShort} — it's already pre-filled, 30 seconds.`,
      url: '/dpr-quick',
      tag: `dpr-reminder-${today}-${eng.user_id}`,
    });
  }

  // Rollup notification to admins if adherence is below 50%
  const totalActiveSites = db.prepare(`SELECT COUNT(*) c FROM sites WHERE status='active'`).get()?.c || 0;
  const sitesWithDprToday = db.prepare(`SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date=?`).get(today)?.c || 0;
  const adherence = totalActiveSites > 0 ? Math.round((sitesWithDprToday / totalActiveSites) * 100) : 100;
  if (adherence < 50) {
    const adminIds = findAdminsForRollup(db);
    pushLib.notifyMany(adminIds, {
      title: '⚠ DPR adherence below 50%',
      body: `Only ${sitesWithDprToday}/${totalActiveSites} sites submitted DPR today (${adherence}%). ${owing.length} engineers notified.`,
      url: '/dashboard/cmd',
      tag: `dpr-rollup-${today}`,
    });
  }

  console.log(`[dpr-prompt] ${today} 18:00 — ${owing.length} engineers notified, ${sitesWithDprToday}/${totalActiveSites} sites adherent (${adherence}%)`);
}

// Schedule the daily 18:00 run.  Drift-correct setTimeout to the next
// 18:00, then setInterval at 24h.  Matches the pattern used by
// dailyAuditSnapshot.js and backup-db.js.
function scheduleDprAutoPrompt() {
  if (process.env.ERP_DISABLE_DPR_PROMPT === '1') {
    console.log('[dpr-prompt] disabled via ERP_DISABLE_DPR_PROMPT');
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[dpr-prompt] first run scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    runOnce().catch(e => console.error('[dpr-prompt] error:', e.message));
    setInterval(() => {
      runOnce().catch(e => console.error('[dpr-prompt] error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

module.exports = { scheduleDprAutoPrompt, runOnce, logComplianceMisses, findEngineerSiteMisses };
