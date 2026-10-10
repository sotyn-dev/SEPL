// Full-Kitting performance counts filled cells across all active projects.
// Owner helpers remain available for owner-specific consumers.

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

// Same Business Book project grouping as the tracker; removed projects are excluded.
function kittingAllProjects(db) {
  const hasRemoved = db.prepare(`PRAGMA table_info(crm_kitting_project_meta)`).all().some(c => c.name === 'removed_at');
  return db.prepare(`
    SELECT DISTINCT COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) AS project_key
      FROM business_book bb
     WHERE COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name) IS NOT NULL
       ${hasRemoved ? `AND NOT EXISTS (
         SELECT 1 FROM crm_kitting_project_meta m
          WHERE m.project_key = COALESCE(NULLIF(TRIM(bb.company_name),''), bb.client_name)
            AND m.removed_at IS NOT NULL
       )` : ''}
  `).all().map(row => row.project_key);
}

// Planned: projects times active checkpoints across non-disabled stages.
// When a stage is disabled for a project (e.g. Stage 1 Pre-Start completed/disabled),
// that stage's checkpoints are deducted from that project's planned count (given),
// and entries in that disabled stage are excluded from actual (done).
function kittingProgress(db, projectKeys) {
  const keys = [...new Set((projectKeys || []).filter(k => k != null).map(String))];
  const activeCheckpoints = db.prepare(
    `SELECT id, stage_no FROM crm_kitting_checkpoint WHERE is_active = 1`
  ).all();
  const totalCps = activeCheckpoints.length;
  if (keys.length === 0) return { projects: 0, checkpoints: totalCps, given: 0, done: 0 };

  const stageCounts = { 1: 0, 2: 0, 3: 0 };
  for (const cp of activeCheckpoints) {
    if (stageCounts[cp.stage_no] !== undefined) {
      stageCounts[cp.stage_no] += 1;
    }
  }

  const metaCols = db.prepare(`PRAGMA table_info(crm_kitting_project_meta)`).all().map(c => c.name);
  const hasStage1Disabled = metaCols.includes('stage1_disabled_at');
  const hasStage2Disabled = metaCols.includes('stage2_disabled_at');
  const hasStage3Disabled = metaCols.includes('stage3_disabled_at');

  const ph = keys.map(() => '?').join(',');
  const selectCols = ['project_key'];
  if (hasStage1Disabled) selectCols.push('stage1_disabled_at');
  if (hasStage2Disabled) selectCols.push('stage2_disabled_at');
  if (hasStage3Disabled) selectCols.push('stage3_disabled_at');

  const metaRows = db.prepare(`
    SELECT ${selectCols.join(', ')}
    FROM crm_kitting_project_meta
    WHERE project_key IN (${ph})
  `).all(...keys);
  const metaByKey = {};
  for (const m of metaRows) metaByKey[m.project_key] = m;

  let given = 0;
  for (const k of keys) {
    const m = metaByKey[k];
    let projPlan = totalCps;
    if (hasStage1Disabled && m?.stage1_disabled_at) projPlan -= (stageCounts[1] || 0);
    if (hasStage2Disabled && m?.stage2_disabled_at) projPlan -= (stageCounts[2] || 0);
    if (hasStage3Disabled && m?.stage3_disabled_at) projPlan -= (stageCounts[3] || 0);
    given += Math.max(0, projPlan);
  }

  let stageExclusions = '';
  if (hasStage1Disabled) stageExclusions += ' AND NOT (c.stage_no = 1 AND m.stage1_disabled_at IS NOT NULL)';
  if (hasStage2Disabled) stageExclusions += ' AND NOT (c.stage_no = 2 AND m.stage2_disabled_at IS NOT NULL)';
  if (hasStage3Disabled) stageExclusions += ' AND NOT (c.stage_no = 3 AND m.stage3_disabled_at IS NOT NULL)';

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
      LEFT JOIN crm_kitting_project_meta m ON m.project_key = e.project_key
     WHERE COALESCE(TRIM(e.status), '') <> ''
       ${stageExclusions}
  `).get(...keys).c;

  return { projects: keys.length, checkpoints: totalCps, given, done };
}

module.exports = {
  nameMatches, resolveOwnerUserId,
  kittingOwnerProjects, kittingProjectsForUser, kittingAllProjects, kittingProgress,
};
