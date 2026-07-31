// Daily 18:30 SPOS Exception Report — (mam 2026-07-29, SPOS PDF).
//
// The Project Coordinator's "Evening Review → Exception Report to
// Management", automated: at 6:30 PM each working day, compute the SPOS
// compliance grid (lib/sposCompliance) and, when anything is missing —
// morning punch, DPR, photos, approved weekly plan — send:
//   1. an in-app notification to every admin (deduped per day), and
//   2. an email to the director (best-effort; skipped when SMTP isn't set).
//
// Sunday off. Skip via ERP_DISABLE_SPOS_REPORT=1.

const { getDb } = require('../db/schema');

const TARGET_HOUR = 18;
const TARGET_MIN = 30;

function todayIso() { return new Date().toISOString().slice(0, 10); }
function isSunday() { return new Date().getDay() === 0; }

async function runOnce() {
  if (process.env.ERP_DISABLE_SPOS_REPORT === '1') return;
  if (isSunday()) { console.log('[spos-report] Sunday, skipping'); return; }

  const db = getDb();
  const today = todayIso();
  const { computeSposCompliance } = require('../lib/sposCompliance');
  const { sites, summary } = computeSposCompliance(db, today);

  const misses = sites.filter(r =>
    !r.punch_done || !r.dpr_done || !r.photos_done || r.plan_status !== 'approved');
  if (misses.length === 0) {
    console.log(`[spos-report] ${today} 18:30 — all ${sites.length} active sites fully compliant, no report sent`);
    return;
  }

  const missLine = (r) => {
    const parts = [];
    if (!r.punch_done) parts.push('no morning punch');
    else if (!r.punch_by_9) parts.push('punch after 9 AM');
    // Report runs 18:30; the DPR deadline is 20:00 — word it as "not yet"
    // so an engineer submitting at 19:00 isn't branded a defaulter (audit).
    if (!r.dpr_done) parts.push('DPR not in by 6:30 PM');
    else if (!r.dpr_by_cutoff) parts.push('DPR after cutoff');
    if (r.dpr_done && !r.photos_done) parts.push('no site photos');
    if (r.plan_status === 'missing') parts.push('no weekly plan');
    else if (r.plan_status !== 'approved') parts.push(`weekly plan ${r.plan_status}`);
    return `${r.site}${r.engineer ? ` (${r.engineer})` : ''} — ${parts.join(', ')}`;
  };
  const lines = misses.map(missLine);
  const title = `📋 SPOS Exception Report — ${misses.length}/${sites.length} site(s) with gaps`;
  const body = `Attendance ${summary.punch_pct}% · DPR ${summary.dpr_pct}% · Photos ${summary.photos_pct}% · Plans approved ${summary.plan_approved_pct}%\n\n${lines.join('\n')}`;

  // 1) In-app notification to admins — same dedupe pattern as hrAutomationsCron.
  try {
    const admins = db.prepare("SELECT id FROM users WHERE role='admin' AND active=1").all();
    const dedupe = `spos_exception:${today}`;
    const ins = db.prepare(`INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
                            VALUES (?,?,?,?,?,?,?)`);
    for (const a of admins) {
      const seen = db.prepare('SELECT id FROM notifications WHERE user_id = ? AND dedupe_key = ?').get(a.id, dedupe);
      if (!seen) ins.run(a.id, 'spos_exception', title, body.slice(0, 900), '/dpr?tab=compliance', 'in_app', dedupe);
    }
  } catch (e) { console.warn('[spos-report] in-app notify failed:', e.message); }

  // 2) Email the director — best-effort, never blocks.
  try {
    const { sendEmail, getEmailConfig } = require('../lib/email');
    const director = getEmailConfig().director;
    if (sendEmail && director) {
      await sendEmail({
        to: director,
        subject: `[SEPL ERP] ${title}`,
        text: `SPOS Exception Report for ${today}\n\n${body}\n\nOpen: /dpr?tab=compliance`,
        html: `<h3>SPOS Exception Report — ${today}</h3>
               <p>Attendance ${summary.punch_pct}% · DPR ${summary.dpr_pct}% · Photos ${summary.photos_pct}% · Plans approved ${summary.plan_approved_pct}%</p>
               <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`,
      });
    }
  } catch (e) { console.warn('[spos-report] email failed:', e.message); }

  console.log(`[spos-report] ${today} 18:30 — ${misses.length}/${sites.length} sites with gaps, report sent`);
}

// Drift-correct schedule to next 18:30, then 24h — same pattern as
// dprAutoPrompt.js / morningPunchPrompt.js.
function scheduleSposExceptionReport() {
  if (process.env.ERP_DISABLE_SPOS_REPORT === '1') {
    console.log('[spos-report] disabled via ERP_DISABLE_SPOS_REPORT');
    return;
  }
  const now = new Date();
  const next = new Date(now);
  next.setHours(TARGET_HOUR, TARGET_MIN, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  const msUntil = next - now;
  console.log(`[spos-report] first run scheduled for ${next.toLocaleString()} (in ${Math.round(msUntil / 60000)} min)`);
  setTimeout(() => {
    runOnce().catch(e => console.error('[spos-report] error:', e.message));
    setInterval(() => {
      runOnce().catch(e => console.error('[spos-report] error:', e.message));
    }, 24 * 60 * 60 * 1000);
  }, msUntil);
}

module.exports = { scheduleSposExceptionReport, runOnce };
