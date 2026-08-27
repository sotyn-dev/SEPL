// Daily 18:30 SPOS Exception Report — (mam 2026-07-29, SPOS PDF).
//
// The Project Coordinator's "Evening Review → Exception Report to
// Management", automated: at 6:30 PM each working day, compute the SPOS
// compliance rollup (one line per site engineer — mam 2026-08-21) and,
// when anything is missing —
// morning punch, DPR, photos, approved weekly plan — send:
//   1. an in-app notification to every admin (deduped per day), and
//   2. an email to the director (best-effort; skipped when SMTP isn't set).
//
// Sunday off. Skip via ERP_DISABLE_SPOS_REPORT=1.

const { getDb } = require('../db/schema');
const { istToday } = require('../lib/istDate');

const TARGET_HOUR = 18;
const TARGET_MIN = 30;

function todayIso() { return istToday(); }
function isSunday() { return new Date().getDay() === 0; }

async function runOnce() {
  if (process.env.ERP_DISABLE_SPOS_REPORT === '1') return;
  if (isSunday()) { console.log('[spos-report] Sunday, skipping'); return; }

  const db = getDb();
  const today = todayIso();
  const { computeSposCompliance, computeStoreAgeing } = require('../lib/sposCompliance');
  const { engineers, sites, summary } = computeSposCompliance(db, today);

  // Inventory ageing violations (mam 2026-08-03): Sr. Engineer is
  // responsible — 15 days allowed, 30 max. RED (30+) items go straight to
  // management in this report, grouped per site.
  let ageingLines = [];
  try {
    const aged = computeStoreAgeing(db).filter(r => r.status === 'red' || r.status === 'orange');
    const bySite = new Map();
    for (const r of aged) {
      const g = bySite.get(r.site_id) || { site: r.site_name, engineer: r.engineer_name, red: [], orange: 0 };
      if (r.status === 'red') g.red.push(`${r.material_name} ${r.quantity} ${r.uom || ''} — ${r.age_days} din`);
      else g.orange += 1;
      bySite.set(r.site_id, g);
    }
    ageingLines = [...bySite.values()].map(g =>
      `${g.site}${g.engineer ? ` (Sr. Eng: ${g.engineer})` : ''} — ${g.red.length ? `RED 30+ din: ${g.red.join('; ')}` : ''}${g.red.length && g.orange ? ' · ' : ''}${g.orange ? `${g.orange} item 15+ din (orange)` : ''}`);
  } catch (e) { console.warn('[spos-report] ageing calc failed:', e.message); }

  // Engineer-wise since mam 2026-08-21 — one line per site engineer with a
  // gap, naming the sites. Lateness alone is still never a "miss".
  const misses = engineers.filter(e =>
    e.punch.missing > 0 || e.dpr.missing > 0 || e.photos.missing > 0 || e.plan.approved < e.plan.total);
  // Engineer-less active sites get no GRID row (mam 2026-08-21) but a real gap
  // on one must still reach management — most prod sites have no engineer, so
  // folding them into a bare count would drop the majority of the report.
  // Listed separately below, with the original per-site wording and predicate.
  const orphanMisses = sites.filter(r => !r.engineer_id &&
    (!r.punch_done || !r.dpr_done || !r.photos_done || r.plan_status !== 'approved'));
  // Only REAL gaps send a report. Audit 2026-08-21: gating this on
  // sites_unassigned === 0 turned the exception report into an unconditional
  // daily mail to the director (that count is ~never 0 in prod) whose only
  // line was the unassigned footnote — an exception report with no exception.
  if (misses.length === 0 && orphanMisses.length === 0 && ageingLines.length === 0) {
    console.log(`[spos-report] ${today} 18:30 — all ${engineers.length} engineer(s) fully compliant, no report sent`);
    return;
  }

  // Cap the site list at 3 names so the 900-char in-app truncation survives.
  const nameList = (a) => a.length <= 3 ? a.join(', ') : `${a.slice(0, 3).join(', ')} +${a.length - 3} more`;
  const missLine = (e) => {
    const parts = [];
    if (e.punch.missing > 0) parts.push(`no morning punch: ${nameList(e.punch.missing_sites)}`);
    else if (e.punch.late > 0) parts.push(`punch after 9 AM: ${nameList(e.punch.late_sites)}`);
    // Report runs 18:30; the DPR deadline is 20:00 — word it as "not yet"
    // so an engineer submitting at 19:00 isn't branded a defaulter (audit).
    if (e.dpr.missing > 0) parts.push(`DPR not in by 6:30 PM: ${nameList(e.dpr.missing_sites)}`);
    else if (e.dpr.late > 0) parts.push(`DPR after cutoff: ${nameList(e.dpr.late_sites)}`);
    if (e.photos.missing > 0) parts.push(`no site photos: ${nameList(e.photos.missing_sites)}`);
    if (e.plan.missing > 0) parts.push(`no weekly plan: ${nameList(e.plan.missing_sites)}`);
    if (e.plan.submitted > 0) parts.push(`weekly plan pending PM: ${nameList(e.plan.pending_sites)}`);
    if (e.plan.rejected > 0) parts.push(`weekly plan rejected: ${nameList(e.plan.rejected_sites)}`);
    return `${e.engineer} (${e.sites_count} site${e.sites_count === 1 ? '' : 's'}) — ${parts.join(' · ')}`;
  };
  // Unassigned sites keep the pre-2026-08-21 per-site wording.
  const orphanLine = (r) => {
    const parts = [];
    if (!r.punch_done) parts.push('no morning punch');
    else if (!r.punch_by_9) parts.push('punch after 9 AM');
    if (!r.dpr_done) parts.push('DPR not in by 6:30 PM');
    else if (!r.dpr_by_cutoff) parts.push('DPR after cutoff');
    if (r.dpr_done && !r.photos_done) parts.push('no site photos');
    if (r.plan_status === 'missing') parts.push('no weekly plan');
    else if (r.plan_status !== 'approved') parts.push(`weekly plan ${r.plan_status}`);
    return `${r.site} — ${parts.join(', ')}`;
  };
  const lines = misses.map(missLine);
  // Engineer-less active sites get no engineer row (mam 2026-08-21) but stay
  // counted, and the ones with a real gap are still named for management.
  if (summary.sites_unassigned > 0) {
    lines.push(`${summary.sites_unassigned} active site(s) have no engineer assigned — not counted above.`);
    lines.push(...orphanMisses.map(orphanLine));
  }
  if (ageingLines.length) {
    lines.push('', '🕰 INVENTORY AGEING (15 din allowed · 30 max — Sr. Engineer responsible):', ...ageingLines);
  }
  const head = engineers.length
    ? `${misses.length}/${engineers.length} engineer(s) with gaps`
    : 'no engineer assigned to any active site';
  const orphanHead = orphanMisses.length ? ` · ${orphanMisses.length} unassigned site(s) with gaps` : '';
  const title = `📋 SPOS Exception Report — ${head}${orphanHead}${ageingLines.length ? ` · ${ageingLines.length} site(s) with aged inventory` : ''}`;
  // Headline percentages are per SITE but over ENGINEER-OWNED sites only, so
  // they must never be read as company-wide (audit 2026-08-21). Two traps:
  //   • no engineer-owned site at all → the pcts are null (0/0), and printing
  //     them told the director "Attendance 0%" on a day every site punched;
  //   • one compliant engineer-owned site + 19 unassigned sites that did
  //     nothing → a flat "100%" sitting directly above 19 gap lines.
  // Say what the number covers, or say there is no number.
  const scope = summary.sites_unassigned > 0
    ? ` (across ${summary.sites_assigned} engineer-owned site${summary.sites_assigned === 1 ? '' : 's'} only — ${summary.sites_unassigned} unassigned site(s) below)`
    : '';
  const headline = summary.sites_assigned === 0
    ? `No active site has a site engineer assigned, so there are no engineer-wise percentages for ${today} — all ${summary.sites} active site(s) are reported individually below.`
    : `Attendance ${summary.punch_pct}% · DPR ${summary.dpr_pct}% · Photos ${summary.photos_pct}% · Plans approved ${summary.plan_approved_pct}%${scope}`;
  const body = `${headline}\n\n${lines.join('\n')}`;

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
               <p>${headline}</p>
               <ul>${lines.map(l => `<li>${l}</li>`).join('')}</ul>`,
      });
    }
  } catch (e) { console.warn('[spos-report] email failed:', e.message); }

  console.log(`[spos-report] ${today} 18:30 — ${misses.length}/${engineers.length} engineers with gaps${orphanMisses.length ? ` + ${orphanMisses.length} unassigned site(s)` : ''}, report sent`);
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
