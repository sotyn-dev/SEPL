// Indent → Dispatch flow settings — schema (idempotent).
//
// The ONE place that stores approval flow control for the indent→dispatch
// pipeline: who may act at each gate, and which optional gates are switched on.
//
// Why this exists (2026-07-23). Before this, "who may approve" was answered by
// FOUR different mechanisms and "is the gate on" by TWO:
//   raci_assignment.responsible_id   — indent L1 / L2   (reporting table doing
//                                      authorization; also drove the scorecard)
//   users.approval_role              — legacy l1/l2 fallback + the RGP 'hr' gate,
//                                      one value per user, LIMIT 1 per role, and
//                                      no UI to set it since 2026-07-02
//   PO_APPROVERS = {'Nitin Jain'…}   — vendor PO L1/L2, hardcoded BY NAME in
//                                      procurement.js (twice — PO_NEXT is a copy)
//   role_permissions(crm_funnel)     — CRM gate, granted to anyone who could
//                                      merely VIEW the CRM funnel
//   app_settings.indent_l2_enabled   — L2 on/off  (mirrored, two writers)
//   raci_assignment.step_enabled     — CRM on/off
//
// All six collapse into the two tables below, read through one resolver.
//
// Design notes:
//   - Scoped to the FLOW, not the procurement family. 'indent_to_dispatch' is
//     already this pipeline's identifier (MODULE_DEFS key, raci_assignment.module,
//     the ResponsibilityTab mount), so the table name reuses it rather than
//     inventing a second name for the same thing. Procurement schedule / stores /
//     item master keep their own tables — this is not a module-wide settings bag.
//   - Two tables because there are two shapes: scalars (switches, flags) and
//     lists of people. People get their own table so they can carry a real FK —
//     a CSV in a value column would rot the moment a user is deleted, which is
//     exactly how raci_assignment.responsible_id (declared plain INTEGER, no
//     REFERENCES) already leaves dangling ids today.
//   - SPARSE by design: a missing row means "use the catalogue default", so a
//     fresh DB is correct with zero rows and adding a setting later needs no
//     backfill. The valid key surface is declared in code, not in the data.
//   - ADMIN IS NEVER STORED HERE. Any admin passes every gate; that comes from
//     users.role in the resolver. Storing it would let someone delete the row and
//     lock everyone out.
//
// Key namespace (dotted; 'approval.' is simply the first group to use it):
//   approval.l1.users        approval.l2.users        approval.l2.enabled
//   approval.crm.users       approval.po_l1.users     approval.po_l2.users
//   approval.po.standin.email                         approval.po.standin.enabled

function runIndentFlowSettingsMigrations(db) {
  db.exec(`
    -- Scalar settings (switches + flags). Values are plain strings coerced by
    -- the catalogue's declared type ('0'/'1' for bool). No JSON: a value is one
    -- thing, and anything with structure gets its own table instead.
    CREATE TABLE IF NOT EXISTS indent_to_dispatch_settings (
      key        TEXT PRIMARY KEY,
      value      TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id)
    );

    -- People assigned to a gate. Many approvers per gate, and one person may
    -- appear under several keys — neither was expressible with the single
    -- users.approval_role column or the LIMIT 1 lookups it fed.
    --
    -- ON DELETE CASCADE: deleting a user removes them from every gate
    -- automatically. Enforced for real — schema.js:31 sets
    -- PRAGMA foreign_keys = ON on every connection.
    CREATE TABLE IF NOT EXISTS indent_to_dispatch_setting_users (
      key        TEXT    NOT NULL,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_by INTEGER REFERENCES users(id),
      PRIMARY KEY (key, user_id)
    );

    -- Reverse lookup: "which gates is this person an approver on?" The PK covers
    -- key→users; this covers user→keys (needed by the indent list, which lets an
    -- approver SEE the records they must act on even without procurement.approve).
    CREATE INDEX IF NOT EXISTS idx_itd_setting_users_user
      ON indent_to_dispatch_setting_users (user_id);
  `);

  seedSettingsFromLegacy(db);
}

// ── ONE-TIME SEED — itd_settings_seed_v1 ─────────────────────────────────────
// Populates ⚙ Workflow Settings from the mechanisms it replaced, so a deploy
// arrives with the gates already filled instead of quietly relying on the code
// fallbacks. Everything here is exactly what the resolver would have answered on
// its own; this just writes it down so it is VISIBLE and editable on the screen.
//
//   Indent L1 / L2 ← the RACI-board Responsible for each step (raci_assignment,
//                    module 'indent_to_dispatch', record_id=0, step_key 'l1'/'l2').
//                    That is where the L1/L2 approvers were actually DESIGNATED in
//                    production (Phase 5): prod has L1=Nitin Jain, L2=Ankur Kaplesh
//                    there — richer than users.approval_role, which only ever held
//                    L1. We do NOT seed from approval_role.
//   Vendor PO L1   ← the hardcoded name 'Nitin Jain', resolved against active users.
//   Vendor PO L2   ← the hardcoded name 'Ankur Kaplesh', likewise.
//   PO stand-in    ← 'coo@', applied (the old hardcoded COO clause, made explicit).
//
// Reading RACI HERE does not resurrect it as an authorization source. This is a
// one-time COPY of its historical designation INTO the settings table; after the
// seed, the live approval path still never reads raci_assignment. The point is
// exactly to migrate that value OUT of RACI so nothing depends on it going forward.
//
// SAFETY:
//   • Guarded by app_settings.itd_settings_seed_v1 — runs at most once per DB.
//   • BACKFILL only: each gate is filled solely when its settings entry is EMPTY,
//     so it can never overwrite approvers an admin has already named (belt-and-
//     braces on top of the guard).
//   • Only ACTIVE users are seeded (RACI responsible_id is a plain int with no FK
//     and can dangle) — a missing/inactive/unresolved target is skipped, leaving
//     that gate to its code fallback.
//   • PO L1 ≠ PO L2 is respected — L2 is skipped if the name resolves to whoever
//     already holds L1.
//
// SAFE TO DELETE this function and its call once every environment has booted with
// it present (the guard key will be set, making it a permanent no-op). It exists
// only to carry the pre-settings state across the one deploy that introduces the
// screen.
function seedSettingsFromLegacy(db) {
  try {
    const done = db.prepare("SELECT value FROM app_settings WHERE key='itd_settings_seed_v1'").get();
    if (done) return;

    const isEmpty = (key) =>
      db.prepare('SELECT COUNT(*) c FROM indent_to_dispatch_setting_users WHERE key=?').get(key).c === 0;
    const addUser = db.prepare('INSERT OR IGNORE INTO indent_to_dispatch_setting_users (key, user_id) VALUES (?, ?)');
    const setScalarIfAbsent = db.prepare(
      "INSERT INTO indent_to_dispatch_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING");
    const activeUser = db.prepare('SELECT id, name FROM users WHERE id=? AND active=1');
    // Same resolution the PO gate uses: exact name, then a loose LIKE.
    const resolveName = (name) =>
      db.prepare('SELECT id, name FROM users WHERE active=1 AND LOWER(TRIM(name))=LOWER(TRIM(?)) LIMIT 1').get(name)
      || db.prepare('SELECT id, name FROM users WHERE active=1 AND LOWER(name) LIKE LOWER(?) ORDER BY id LIMIT 1').get('%' + name + '%');
    // The RACI-board Responsible for a whole-module indent step, if it points at
    // an active user. Own try/catch so a missing raci_assignment (ordering on a
    // fresh DB) degrades to "no seed for this step" rather than aborting the rest.
    const raciApprover = (stepKey) => {
      try {
        const row = db.prepare(
          "SELECT responsible_id FROM raci_assignment WHERE module='indent_to_dispatch' AND record_id=0 AND step_key=?"
        ).get(stepKey);
        return row && row.responsible_id ? activeUser.get(row.responsible_id) : null;
      } catch (_) { return null; }
    };

    db.transaction(() => {
      // 1. Indent L1 / L2 — the RACI-board Responsible for each step (the real
      //    production designation). Seeded only when the gate is empty.
      if (isEmpty('approval.l1.users')) {
        const u = raciApprover('l1');
        if (u) { addUser.run('approval.l1.users', u.id); console.log(`[itd-seed] Indent L1 ← ${u.name} (RACI)`); }
      }
      if (isEmpty('approval.l2.users')) {
        const u = raciApprover('l2');
        if (u) { addUser.run('approval.l2.users', u.id); console.log(`[itd-seed] Indent L2 ← ${u.name} (RACI)`); }
      }

      // 2. Vendor PO L1 — the hardcoded 'Nitin Jain', if it resolves.
      if (isEmpty('approval.po_l1.users')) {
        const u = resolveName('Nitin Jain');
        if (u) { addUser.run('approval.po_l1.users', u.id); console.log(`[itd-seed] PO L1 ← ${u.name}`); }
      }
      // 3. Vendor PO L2 — the hardcoded 'Ankur Kaplesh', if it resolves AND is a
      //    different person from whoever now holds PO L1 (the exclusivity rule).
      if (isEmpty('approval.po_l2.users')) {
        const u = resolveName('Ankur Kaplesh');
        const poL1Now = db.prepare("SELECT user_id FROM indent_to_dispatch_setting_users WHERE key='approval.po_l1.users'")
          .all().map(r => r.user_id);
        if (u && !poL1Now.includes(u.id)) { addUser.run('approval.po_l2.users', u.id); console.log(`[itd-seed] PO L2 ← ${u.name}`); }
        else if (u) console.log('[itd-seed] PO L2 skipped — resolves to the same person as PO L1');
      }

      // 4. PO stand-in — the old hardcoded 'coo@' clause, applied. ON CONFLICT DO
      //    NOTHING leaves any value an admin has already set.
      setScalarIfAbsent.run('approval.po.standin.email', 'coo@');
      setScalarIfAbsent.run('approval.po.standin.enabled', '1');

      db.prepare("INSERT OR REPLACE INTO app_settings (key, value) VALUES ('itd_settings_seed_v1', '1')").run();
    })();
    console.log('[itd-seed] one-time settings seed complete');
  } catch (e) {
    // app_settings / users not ready on a very first boot — the guard row was
    // never written, so this retries on the next boot.
    console.warn('[itd-seed] skipped (will retry next boot):', e.message);
  }
}

module.exports = { runIndentFlowSettingsMigrations };
