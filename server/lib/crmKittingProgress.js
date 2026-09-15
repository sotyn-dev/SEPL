// CRM Full Kitting — one definition of "done", and one rule for whose
// project it is, shared by the tracker and the scorecard.
//
// mam 2026-09-07: "CRM -> only CRM Full kitting". The Full-Kitting KPI used to
// count crm_kitting_entry rows by uploaded_by inside the scoring week, so the
// person who ticks the boxes (Admin) got the credit, the CRM owner named on
// the row got 0, two edits of one checkpoint counted as two units of work, and
// everything reset to 0 every Monday. This module fixes all four: credit the
// project's CRM owner, count CHECKPOINTS CURRENTLY COMPLETE, cumulatively.
//
// "Done" is the tracker's own rule (client/src/pages/CRMKitting.jsx
// stagePctFor): a checkpoint counts when its LATEST entry says 'yes' or 'na',
// over the ACTIVE checkpoints. crm_kitting_entry is append-only — every
// dropdown change and photo is a new row — so the collapse to the latest row
// per (project_key, checkpoint_id) is what makes "two edits = one checkpoint"
// true. Anything that scores kitting comes through here, so the KPI and the
// screen cannot drift apart.

// Latest status values that count as complete. 'partially' and 'no' do not —
// same as the tracker.
const DONE_STATUSES = ['yes', 'na'];

// trim, collapse inner whitespace, lowercase — 'LOVELY  SHARMA ' and
// 'Lovely Sharma' are the same person.
const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLowerCase();

// Whole-token containment, in ONE direction at a time so it can be counted:
// the tracker's CRM picklist stores first names ('Lovely') while users.name
// holds the full name ('Lovely Sharma'). Whole tokens on both sides catch
// 'Lovely' ↔ 'Lovely Sharma' without letting a bare LIKE '%lov%' over-match.
// NOT a match rule on its own — see resolveOwnerUserId: a token hit only
// counts when it lands on exactly ONE user, because 'Lovely' would otherwise
// claim both 'Lovely Sharma' and 'Lovely Verma' and score the same project
// twice.
function nameMatches(a, b) {
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.split(' ').includes(y) || y.split(' ').includes(x);
}

// A free-text CRM owner ('Lovely', 'Lovely Sharma', 'MD Sir') → ONE user id,
// or null. Two tiers, and BOTH must be unambiguous:
//   1. exact equality on the normalised name;
//   2. only if that found nothing, whole-token containment.
// 0 hits or MORE THAN ONE hit = null: nobody is credited. Crediting several
// users for one project (the old per-row Business Book fallback) inflates the
// company total and hands the same work to two people, which is worse than a
// blank. Archived accounts are out of the candidate list — they cannot be the
// current CRM owner of anything, and leaving them in would let one archived
// duplicate ('… _DISABLED') make a live name ambiguous and silently zero a
// real person's KPI.
function resolveOwnerUserId(name, users) {
  const want = norm(name);
  if (!want) return null;
  const exact = users.filter(u => norm(u.name) === want);
  if (exact.length === 1) return exact[0].id;
  if (exact.length > 1) return null;              // two accounts, same name → nobody
  const loose = users.filter(u => nameMatches(u.name, name));
  return loose.length === 1 ? loose[0].id : null; // 0 or many → nobody
}

// Which kitting projects belong to each user.
//
// OWNERSHIP IS crm_kitting_project_meta.crm_owner AND NOTHING ELSE — the
// tracker's own CRM column, the value mam types and the only one the screen
// renders (CRMKitting.jsx:530 shows meta.crm_owner or an em-dash). There is
// deliberately NO fallback to business_book.employee_assigned: one project has
// several BB rows naming different people (CONSERN PHARMA has 'MD Sir' on four
// and 'LOVELY SHARMA' on a fifth), so a BB fallback credits the same
// checkpoints to two people at once and credits owners mam cannot see on the
// screen she is reading. A project with no crm_owner typed is credited to
// NOBODY — visible and honest, and mam fixes it by typing the owner in the
// same column she already looks at.
//
// Only projects that still exist in the tracker count: project_key is the
// business_book grouping expression (the same one /matrix, /projects and
// /project use), so a meta row left behind by a deleted Business Book entry
// is not on the screen and must not sit in anyone's denominator either.
// Same rule for a project REMOVED from the tracker (handed over — mam
// 2026-09-10): it has left the screen, so it leaves the owner's denominator.
// Column checked first because the routes file adds it at boot.
function kittingOwnerProjects(db) {
  const users = db.prepare(`SELECT id, name FROM users WHERE COALESCE(archived,0)=0`).all();
  const hasRemoved = db.prepare(`PRAGMA table_info(crm_kitting_project_meta)`).all().some(c => c.name === 'removed_at');
  const rows = db.prepare(`
    SELECT m.project_key, m.crm_owner
      FROM crm_kitting_project_meta m
     WHERE COALESCE(TRIM(m.crm_owner),'') <> ''
       ${hasRemoved ? 'AND m.removed_at IS NULL' : ''}
       AND EXISTS (SELECT 1 FROM business_book bb
                    WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) = m.project_key)
  `).all();
  const byUser = new Map();
  for (const r of rows) {
    const uid = resolveOwnerUserId(r.crm_owner, users);
    if (uid == null) continue;
    if (!byUser.has(uid)) byUser.set(uid, []);
    byUser.get(uid).push(r.project_key);
  }
  return byUser;
}

function kittingProjectsForUser(db, userId) {
  if (userId == null) return [];
  return kittingOwnerProjects(db).get(userId) || [];
}

// Cumulative kitting progress over a set of projects.
//   checkpoints — active checkpoints in the master list (admin-editable, so
//                 read live, never hardcoded)
//   given       — checkpoints × projects: the whole checklist in front of them
//   done        — checkpoints whose LATEST entry is 'yes' or 'na'
// BOTH sides are standing totals with no date window, and that is exactly why
// the ratio is honest: numerator and denominator are measured at the same
// moment, so done/given is "how much of my kitting is finished" and can never
// climb past 100%. (The old shape — a cumulative done against mam's typed
// weekly target of 120 — had no ceiling and rewrote every past week with
// today's total.) Cumulative on purpose: mam 2026-09-07, work already done
// must keep counting, like lib/dataCompletion.
// MAX(id) collapses the history rather than MAX(uploaded_at): ids are
// monotonic with uploaded_at (both are set by the single INSERT) and unlike
// the timestamp they cannot tie, so two entries saved inside the same second
// can never both survive the join and double-count one checkpoint.
function kittingProgress(db, projectKeys) {
  const keys = (projectKeys || []).map(k => String(k == null ? '' : k)).filter(k => k.trim() !== '');
  const checkpoints = db.prepare(
    `SELECT COUNT(*) c FROM crm_kitting_checkpoint WHERE is_active = 1`
  ).get().c;
  if (keys.length === 0) return { projects: 0, checkpoints, given: 0, done: 0 };
  const ph = keys.map(() => '?').join(',');
  const st = DONE_STATUSES.map(() => '?').join(',');
  const done = db.prepare(`
    SELECT COUNT(*) c
      FROM crm_kitting_entry e
      JOIN (
        SELECT project_key, checkpoint_id, MAX(id) AS latest_id
          FROM crm_kitting_entry
         WHERE project_key IN (${ph})
         GROUP BY project_key, checkpoint_id
      ) lm ON lm.latest_id = e.id
      JOIN crm_kitting_checkpoint c ON c.id = e.checkpoint_id AND c.is_active = 1
     WHERE e.status IN (${st})
  `).get(...keys, ...DONE_STATUSES).c;
  return { projects: keys.length, checkpoints, given: keys.length * checkpoints, done };
}

module.exports = {
  DONE_STATUSES, nameMatches, resolveOwnerUserId,
  kittingOwnerProjects, kittingProjectsForUser, kittingProgress,
};
