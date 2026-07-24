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
}

// NOTE: there is deliberately NO auto-seed. The gates start empty and the code
// fallbacks keep approvals working on deploy (indent L1 → users.approval_role,
// PO L1/L2 → the hardcoded names, stand-in → the default 'coo@'), so nothing
// breaks before anyone opens the screen. An admin fills the real names in once on
// ⚙ Workflow Settings at deploy — a handful of entries, done deliberately and
// visibly, rather than a throwaway boot script reading who-can-approve data and
// then needing to be remembered and removed later.

module.exports = { runIndentFlowSettingsMigrations };
