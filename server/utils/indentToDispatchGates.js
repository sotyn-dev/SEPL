// Indent → Dispatch approval gates — the catalogue and the ONLY reader/writer of
// the gate settings (indent_to_dispatch_settings + ..._setting_users).
//
// Every gate is declared ONCE here. Adding a gate later = one entry below plus
// one call site — never a scattered edit across procurement.js, raci.js,
// dashboards.js and two render paths of Procurement.jsx, which is how the
// current four-mechanism tangle grew.
//
// Rules that hold for every gate:
//   - ADMIN ALWAYS PASSES. That comes from users.role, never from a stored row,
//     so an empty approver list means admin-only — a visible, safe state that
//     cannot lock anyone out. There is deliberately NO fallback to some other
//     source when the list is empty; a silent fallback is what made "who can
//     approve L1?" un-answerable before.
//   - ONLY ACTIVE USERS resolve. Deactivating someone removes their authority
//     without anyone having to remember to edit the gate.
//   - SPARSE STORAGE. A missing row means the catalogue default below, so a
//     fresh database is correct with zero rows and new settings need no backfill.

// ── Catalogue ────────────────────────────────────────────────────────────────
// togglable     — does this gate have an ON/OFF switch? (L1 and the PO levels are
//                 always part of the flow; L2 and CRM are optional stages.)
// default       — the enabled state when nothing is stored.
// conflictsWith — second-pair-of-eyes: the same person may not sign both this
//                 gate and the named one on the SAME record.
const GATES = {
  l1: {
    label: 'Indent — L1 Approval',
    togglable: false,
  },
  l2: {
    label: 'Indent — L2 Approval',
    togglable: true,
    default: false,               // OFF since 2026-07-21 — L1 is final
    conflictsWith: 'l1',
  },
  crm: {
    label: 'CRM Approval (billable Extra indents)',
    togglable: true,
    default: true,
    // No flags. Naming people here is an ADDITIONAL allow on top of the existing
    // rule (crm_funnel module access, or the CRM person named on that project's
    // Client PO — mam 2026-06-03). Both of those stay unconditional, so there is
    // nothing here to switch off.
  },
  po_l1: {
    label: 'Vendor PO — L1 Approval',
    togglable: false,
  },
  po_l2: {
    label: 'Vendor PO — L2 Approval',
    togglable: false,
    conflictsWith: 'po_l1',       // NEW — the PO side has no such check today
  },
  // No 'revoke' gate. Undoing a closed indent (re-approve / re-reject / reset a
  // store issue) is NOT separately assignable — it follows the current final
  // signer: the 'l2' approvers when L2 is on, the 'l1' approvers when it's off
  // (see canRevoke in procurement.js). A standalone list here would be a third
  // authority source that nothing reads — exactly the tangle this table removes.
};

const GATE_KEYS = Object.keys(GATES);

// ── Key namespace ────────────────────────────────────────────────────────────
const usersKey   = (gate)       => `approval.${gate}.users`;
const enabledKey = (gate)       => `approval.${gate}.enabled`;

// ── Reads ────────────────────────────────────────────────────────────────────

// Named approvers for a gate — ACTIVE users only. Admin is NOT included; admin
// authority is checked separately so it can never be edited away.
function approversOf(db, gate) {
  try {
    return db.prepare(`
      SELECT u.id, u.name
        FROM indent_to_dispatch_setting_users s
        JOIN users u ON u.id = s.user_id AND u.active = 1
       WHERE s.key = ?
       ORDER BY u.name
    `).all(usersKey(gate));
  } catch (_) { return []; }      // table not created yet → nobody named
}

function rawScalar(db, key) {
  try { return db.prepare('SELECT value FROM indent_to_dispatch_settings WHERE key=?').get(key)?.value ?? null; }
  catch (_) { return null; }
}

// Is this gate switched on? Non-togglable gates are always on.
function gateEnabled(db, gate) {
  const def = GATES[gate];
  if (!def) return false;
  if (!def.togglable) return true;
  const v = rawScalar(db, enabledKey(gate));
  return v == null ? !!def.default : v === '1';
}

// (Per-gate boolean FLAGS were removed 2026-07-23 — the one flag that existed,
// crm.allow_project_crm, became unconditional. If a gate ever needs an extra
// boolean, re-add a `flags: { name: { default } }` block to its catalogue entry
// plus a reader here; the dotted key namespace already reserves the space:
// approval.<gate>.<flag>.)

// Explicit-only read: null when NOTHING is stored, so a caller can tell
// "configured off" apart from "never configured". Needed while a legacy source
// still exists for the same switch — an absent setting must fall through to it
// rather than silently forcing the catalogue default.
function storedEnabled(db, gate) {
  if (!GATES[gate]?.togglable) return null;
  const v = rawScalar(db, enabledKey(gate));
  return v == null ? null : v === '1';
}

// EFFECTIVE on/off for a togglable gate: the settings table when it has ever
// been saved, else the legacy source it replaced. EVERY consumer of a gate
// switch must call this — the approval flow, the CMD one-click approve, the RACI
// board — or they drift apart the moment the two disagree.
//
// The legacy half is temporary. Drop it (and the mirror write in the settings
// route) once nothing reads app_settings.indent_l2_enabled.
function effectiveEnabled(db, gate) {
  const stored = storedEnabled(db, gate);
  if (stored !== null) return stored;
  if (gate === 'l2') {
    try {
      return db.prepare("SELECT value v FROM app_settings WHERE key='indent_l2_enabled'").get()?.v === '1';
    } catch (_) { /* fall through */ }
  }
  return gateEnabled(db, gate);
}

// Is this user named on the gate? (Admin handled by the caller / canAct.)
function isApprover(db, gate, userId) {
  if (!userId) return false;
  return approversOf(db, gate).some(u => u.id === +userId);
}

// Every gate this ACTIVE user is named on — used by the indent/PO list so an
// approver can SEE the records waiting on them without procurement.approve.
function gatesForUser(db, userId) {
  if (!userId) return [];
  try {
    const rows = db.prepare(
      'SELECT key FROM indent_to_dispatch_setting_users WHERE user_id=?'
    ).all(userId);
    const prefix = 'approval.', suffix = '.users';
    return rows
      .map(r => String(r.key))
      .filter(k => k.startsWith(prefix) && k.endsWith(suffix))
      .map(k => k.slice(prefix.length, -suffix.length))
      .filter(g => GATES[g]);
  } catch (_) { return []; }
}

// The whole config, resolved — powers the settings screen and the API.
function readAll(db) {
  const out = {};
  for (const gate of GATE_KEYS) {
    const def = GATES[gate];
    const entry = {
      label: def.label,
      togglable: !!def.togglable,
      conflicts_with: def.conflictsWith || null,
      enabled: gateEnabled(db, gate),
      users: approversOf(db, gate),
    };
    out[gate] = entry;
  }
  return out;
}

// ── Write ────────────────────────────────────────────────────────────────────
// Replaces the config for the gates present in `payload`, in ONE transaction so
// a half-saved screen is impossible. Unknown gates and inactive or non-existent
// user ids are rejected rather than silently dropped.
//
// payload: { [gate]: { users:[id], enabled:bool } }
function writeAll(db, payload, actorId) {
  if (!payload || typeof payload !== 'object') throw new Error('No settings supplied');

  const gates = Object.keys(payload);
  for (const gate of gates) {
    if (!GATES[gate]) throw new Error(`Unknown approval gate "${gate}"`);
    const g = payload[gate] || {};
    if (g.users != null && !Array.isArray(g.users)) throw new Error(`"${gate}" users must be a list`);
  }

  // Validate every id up front — an inactive or deleted user must never end up
  // holding a gate. (The FK would catch a missing row; this also catches inactive.)
  const activeStmt = db.prepare('SELECT id FROM users WHERE id=? AND active=1');
  for (const gate of gates) {
    for (const raw of (payload[gate].users || [])) {
      const id = +raw;
      if (!Number.isInteger(id) || id <= 0) throw new Error(`Invalid user id "${raw}" on "${gate}"`);
      if (!activeStmt.get(id)) throw new Error(`User #${id} is not an active user`);
    }
  }

  const setScalar = db.prepare(`
    INSERT INTO indent_to_dispatch_settings (key, value, updated_at, updated_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value, updated_at=CURRENT_TIMESTAMP, updated_by=excluded.updated_by`);
  const clearUsers = db.prepare('DELETE FROM indent_to_dispatch_setting_users WHERE key=?');
  const addUser = db.prepare(`
    INSERT INTO indent_to_dispatch_setting_users (key, user_id, updated_at, updated_by)
    VALUES (?, ?, CURRENT_TIMESTAMP, ?)`);

  db.transaction(() => {
    for (const gate of gates) {
      const g = payload[gate] || {};
      const def = GATES[gate];

      if (Array.isArray(g.users)) {
        clearUsers.run(usersKey(gate));
        for (const id of [...new Set(g.users.map(Number))]) addUser.run(usersKey(gate), id, actorId || null);
      }
      // Only togglable gates store an enabled row — the rest are always on and a
      // stored value would be a lie waiting to be read by someone.
      if (def.togglable && g.enabled !== undefined) {
        setScalar.run(enabledKey(gate), g.enabled ? '1' : '0', actorId || null);
      }
    }
  })();

  return readAll(db);
}

module.exports = {
  GATES, GATE_KEYS,
  usersKey, enabledKey,
  approversOf, gateEnabled, storedEnabled, effectiveEnabled, isApprover, gatesForUser,
  readAll, writeAll,
};
