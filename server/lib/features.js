// Module availability — the global on/off switch for whole features.
//
// This sits ABOVE role permissions. RBAC answers "may THIS ROLE use the module";
// this answers "is the module switched on for the organisation at all". They are
// different questions: `requirePermission` and the client `can()` both short-circuit
// on role === 'admin', so RBAC can never hide a module from an admin, and turning
// something off "for everyone" would mean unticking a box on every single role.
//
// State lives in a JSON file, NOT in app_settings — that table is inside erp.db, the
// database we roll back. Restoring an older erp.db would silently revert the switch,
// which is exactly the failure this must not have. A flat file is untouched by any DB
// restore, and can be hand-edited on the VPS if the admin UI is ever unavailable.
//
// The path comes from paths.js (DATA_ROOT), never a hardcoded join, so if `data/`
// ever becomes `data/tenant_<x>/` the flags become per-tenant with no code change.
const fs = require('fs');
const path = require('path');
const { DATA_ROOT, ensureDir } = require('./paths');

// The ONE list to edit when a module becomes switchable. `default` is what an absent
// entry in the file means, so a module ships in the state declared here with nothing
// to seed or migrate:
//   sotyn_flow — brand new, untested, must not appear on deploy → default OFF
//   site_chat  — in daily use today → default ON, so nothing changes for anyone
// Optional `offHint` adds a custom second line to the "switched off" screen.
const KILLABLE_MODULES = [
  { key: 'sotyn_flow', label: 'SOTYN Flow', description: 'Task boards for planning and tracking work.', default: false },
  { key: 'site_chat',  label: 'SOTYN Chat', description: 'Internal messaging, groups and calls.', default: true },
];

const FLAGS_PATH = path.join(DATA_ROOT, 'module-flags.json');

// The file is an OVERRIDE map ({"sotyn_flow": true}), not a full state map — an absent
// key falls back to the registry default. So a missing file is completely valid and
// there is nothing to create on first boot.
let cache = null;
let cacheMtime = -1;

function readOverrides() {
  try {
    const mtime = fs.statSync(FLAGS_PATH).mtimeMs;
    // Cheap stat-based invalidation: a per-request check costs a stat instead of a
    // parse, and a hand-edit on the VPS is still picked up without a restart.
    if (cache && mtime === cacheMtime) return cache;
    const parsed = JSON.parse(fs.readFileSync(FLAGS_PATH, 'utf8'));
    cache = (parsed && typeof parsed === 'object') ? parsed : {};
    cacheMtime = mtime;
    return cache;
  } catch (_) {
    // Missing OR corrupt (truncated write, bad hand-edit) → fall back to the registry
    // defaults rather than crashing or guessing. Deliberately does not cache, so a
    // repaired file is picked up on the next call.
    return {};
  }
}

// Resolved state for every killable module: { sotyn_flow: false, site_chat: true }.
function getModuleFlags() {
  const ov = readOverrides();
  const out = {};
  for (const m of KILLABLE_MODULES) {
    out[m.key] = Object.prototype.hasOwnProperty.call(ov, m.key) ? !!ov[m.key] : !!m.default;
  }
  return out;
}

// The registry merged with current state — what the client needs to render both the
// admin toggles and the "switched off" message (which interpolates `label`).
function getModuleList() {
  const flags = getModuleFlags();
  return KILLABLE_MODULES.map(m => ({
    key: m.key, label: m.label, description: m.description || null,
    offHint: m.offHint || null, enabled: flags[m.key],
  }));
}

function isKillable(key) {
  return KILLABLE_MODULES.some(m => m.key === key);
}

// THE single server-side gating call. Anything that needs to know "is this module on"
// asks here and nowhere else — so if an orchestration/entitlement layer is ever added,
// it becomes `entitled(key) && thisFlag(key)` in this one function and every call site
// is already correct.
function isModuleEnabled(key) {
  if (!isKillable(key)) return true;      // not switchable → always on
  return getModuleFlags()[key];
}

// Write via a temp file + rename so a crash mid-write can never leave truncated JSON
// (which would otherwise read as "corrupt" and silently revert every module to default).
function setModuleFlag(key, on) {
  if (!isKillable(key)) throw new Error(`Unknown module: ${key}`);
  ensureDir(DATA_ROOT);
  const next = { ...readOverrides(), [key]: !!on };
  const tmp = `${FLAGS_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, FLAGS_PATH);
  cache = null; cacheMtime = -1;          // force a re-read on the next check
  return getModuleFlags();
}

// Express guard for a whole router mount. 404 (not 403) on purpose: a disabled module
// should look like it does not exist, rather than confirming it exists but is blocked.
function requireModuleEnabled(key) {
  return (req, res, next) => {
    if (isModuleEnabled(key)) return next();
    res.status(404).json({ error: 'Not found' });
  };
}

module.exports = {
  KILLABLE_MODULES, FLAGS_PATH,
  getModuleFlags, getModuleList, isModuleEnabled, setModuleFlag, requireModuleEnabled,
};
