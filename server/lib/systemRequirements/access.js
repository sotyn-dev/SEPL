const { SETTINGS_KEYS } = require('./constants');

function parseIdList(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(Number).filter(n => Number.isFinite(n) && n > 0);
  } catch {
    return [];
  }
}

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM app_settings WHERE key=?').get(key);
  return row?.value ?? null;
}

function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
  `).run(key, value);
}

/** Preserve order (first = priority / primary). */
function normalizeIds(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  for (const x of arr) {
    const n = Number(x);
    if (!Number.isFinite(n) || n <= 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/**
 * Admin cherry-picked groups (ordered lists; overlap allowed).
 * - it_manager_ids: triage owners; [0] = Priority / primary
 * - it_team_ids: work assignees
 * - business_owner_ids: business sign-off
 */
function getTeamSettings(db) {
  const managers = parseIdList(getSetting(db, SETTINGS_KEYS.itManagers));
  const itTeam = parseIdList(getSetting(db, SETTINGS_KEYS.itTeam));
  const itLegacy = parseIdList(getSetting(db, SETTINGS_KEYS.itApproversLegacy));
  const biz = parseIdList(getSetting(db, SETTINGS_KEYS.businessOwners));
  const bizLegacy = parseIdList(getSetting(db, SETTINGS_KEYS.businessApproversLegacy));

  let it_manager_ids = managers.length ? managers : (itLegacy.length ? itLegacy : []);
  let it_team_ids = itTeam.length ? itTeam : [];
  // One-release: older builds stored the combined handlers list as it_team only
  if (!it_manager_ids.length && it_team_ids.length) {
    it_manager_ids = [...it_team_ids];
  }
  const business_owner_ids = biz.length ? biz : bizLegacy;

  return { it_manager_ids, it_team_ids, business_owner_ids };
}

function saveTeamSettings(db, { it_manager_ids, it_team_ids, business_owner_ids }) {
  const managers = normalizeIds(it_manager_ids);
  const team = normalizeIds(it_team_ids);
  const biz = normalizeIds(business_owner_ids);
  setSetting(db, SETTINGS_KEYS.itManagers, JSON.stringify(managers));
  setSetting(db, SETTINGS_KEYS.itTeam, JSON.stringify(team));
  setSetting(db, SETTINGS_KEYS.businessOwners, JSON.stringify(biz));
  return getTeamSettings(db);
}

function loadUsersByIds(db, ids) {
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, name, email, department FROM users
     WHERE id IN (${placeholders})
       AND (active IS NULL OR active=1)
       AND COALESCE(archived, 0)=0`
  ).all(...ids);
  const byId = Object.fromEntries(rows.map(u => [u.id, u]));
  return ids.map(id => byId[id]).filter(Boolean);
}

function enrichTeamSettings(db, settings) {
  return {
    ...settings,
    it_managers: loadUsersByIds(db, settings.it_manager_ids || []),
    it_team: loadUsersByIds(db, settings.it_team_ids || []),
    business_owners: loadUsersByIds(db, settings.business_owner_ids || []),
    primary_it_manager_id: (settings.it_manager_ids && settings.it_manager_ids[0]) || null,
  };
}

/** Assignment pool = managers ∪ team (ordered: managers first, then team extras). */
function assignableIds(db) {
  const { it_manager_ids, it_team_ids } = getTeamSettings(db);
  return normalizeIds([...(it_manager_ids || []), ...(it_team_ids || [])]);
}

function listAssignableUsers(db) {
  return loadUsersByIds(db, assignableIds(db));
}

/** @deprecated use listAssignableUsers */
function listItTeamUsers(db) {
  return listAssignableUsers(db);
}

function primaryItManagerId(db) {
  const { it_manager_ids } = getTeamSettings(db);
  return it_manager_ids[0] || null;
}

function isAssignableUser(db, userId) {
  return assignableIds(db).includes(Number(userId));
}

function isBusinessOwnerId(db, userId) {
  const { business_owner_ids } = getTeamSettings(db);
  return (business_owner_ids || []).includes(Number(userId));
}

function listBusinessOwners(db) {
  const { business_owner_ids } = getTeamSettings(db);
  return loadUsersByIds(db, business_owner_ids || []);
}

/**
 * Who to pick when recovering an inactive person mid-flow.
 * - under_review → business owners
 * - submitted / clarification / rejected → IT managers
 * - pending / in_progress / testing / … → managers ∪ team
 */
function reassignRoleForStatus(status) {
  if (status === 'under_review') return 'business_owner';
  if (['submitted', 'need_clarification', 'rejected', 'approved', 'reopened', 'draft'].includes(status)) {
    return 'it_manager';
  }
  return 'it_person';
}

function reassignPool(db, status) {
  const role = reassignRoleForStatus(status);
  const settings = getTeamSettings(db);
  let ids;
  if (role === 'business_owner') ids = settings.business_owner_ids || [];
  else if (role === 'it_manager') ids = settings.it_manager_ids || [];
  else ids = assignableIds(db);
  return {
    role,
    users: loadUsersByIds(db, ids),
  };
}

function isValidReassignTarget(db, status, userId) {
  const { users } = reassignPool(db, status);
  return users.some(u => u.id === Number(userId));
}

const { listActiveUsers } = require('./users');

const getApproverSettings = getTeamSettings;
const saveApproverSettings = (db, body) => saveTeamSettings(db, {
  it_manager_ids: body.it_manager_ids ?? body.it_approver_ids,
  it_team_ids: body.it_team_ids,
  business_owner_ids: body.business_owner_ids ?? body.business_approver_ids,
});
const enrichApprovers = (db, settings) => {
  const enriched = enrichTeamSettings(db, {
    it_manager_ids: settings.it_manager_ids || settings.it_approver_ids || [],
    it_team_ids: settings.it_team_ids || [],
    business_owner_ids: settings.business_owner_ids || settings.business_approver_ids || [],
  });
  return {
    ...enriched,
    it_approver_ids: enriched.it_manager_ids,
    business_approver_ids: enriched.business_owner_ids,
    it_approvers: enriched.it_managers,
    business_approvers: enriched.business_owners,
  };
};

module.exports = {
  getTeamSettings,
  saveTeamSettings,
  enrichTeamSettings,
  listItTeamUsers,
  listAssignableUsers,
  assignableIds,
  isAssignableUser,
  isBusinessOwnerId,
  listBusinessOwners,
  primaryItManagerId,
  reassignRoleForStatus,
  reassignPool,
  isValidReassignTarget,
  listActiveUsers,
  getApproverSettings,
  saveApproverSettings,
  enrichApprovers,
  parseIdList,
  normalizeIds,
};
