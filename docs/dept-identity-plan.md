# Department / Identity — Working Plan

**Status: PLANNING. No code changes. No schema changes. Discussion in progress.**

Supersedes the earlier exploration in `hr-identity-department-solution.md` (that draft
was over-built — full SCD2 versioning + a `user_hr` view). This is the leaner,
agreed direction.

---

## Core observation (the decision we reached)

For showing a person's **department/designation**, do **not** trust `users.department`.
Read it from the linked **employee (HR)** record via the existing link, with a plain
**indexed `LEFT JOIN`** — no copy, no view, no new layer. Leave `users.department`
completely untouched.

Reasoning, settled:
- **`employees` (HR) is the single source of truth** for department + designation.
- **`users.department` is off-limits** — it drives HR-access logic gates
  (`department LIKE '%hr%'`). Migrating that gate to RBAC is a *separate, later* concern,
  explicitly out of scope for this plan.
- **Reading through the foreign key is the correct, standard practice at any scale.**
  Denormalizing (copying the value onto `users`) is rejected: it would reintroduce
  drift *and* touch the gate field. No performance reason to denormalize exists.
- **No `user_hr` view** — it was only a DRY convenience. For the few screens involved,
  inline the join. (Revisit a view only if the same join spreads across many screens —
  a maintainability choice, not a performance one.)

## The rule we're standing on

> **Join by default for current-state display. Snapshot for point-in-time/history.
> Never copy department onto `users`.**

| Need | Mechanism | Notes |
|---|---|---|
| Current ("what is their dept now") | live indexed `LEFT JOIN` users→employees | Locations, users list, pickers |
| Point-in-time ("what was it then") | snapshot frozen at record time | payroll etc. — already the app's pattern; handled separately |
| — | ~~denormalize onto users~~ | rejected (drift + gate) |

## Cardinality (why LEFT JOIN, users on the left)

`users` is the **superset**; `employees` is a **subset** (every employee has a login,
but ~15 logins have no employee record because HR hasn't added them). So:
`LEFT JOIN employees ON employees.user_id = users.id` — login-only users still appear,
with NULL HR fields (screen falls back to today's behaviour). INNER JOIN would wrongly
drop them.

## Prerequisites for the join to be correct + fast

1. **Index** `employees(user_id)` — makes the join O(log n).
2. **Unique** `employees(user_id)` (partial, WHERE NOT NULL) — so duplicates can't
   multiply rows in the join.

Linking itself is **already done** (91/92 employees linked) — nothing to redo.

## Identity: the one live defect

- **Rajat = user 21 linked to TWO active employee rows** (emp 7 "Rajat Sir" ₹80k
  Operation head; emp 61 "RAJAT SHARMA" ₹100k Purchase Head). Causes: a direct join
  double-counts him, and payroll can pay both (₹180k risk).
- **Open question for HR:** is this a **data error** (evidence says yes — name variants,
  one blank email, month apart, two different auto-linkers) or a **genuine dual role**?
  - If error → deactivate/unlink the wrong row, then add the unique index.
  - If genuine dual role → still **one employee row = one payroll identity**; capture the
    second department as a *secondary attribute*, never a second payroll-bearing row.
    (A full worker↔positions model is over-engineering for one person.)

## Supporting data (from prod snapshot 2026-07-25, for context — not tasks yet)

- `users.department`: 42 blank, 22 hold a **job title** not a department, typos/casing
  throughout (~64% unusable). `employees` holds the cleaner values.
- Identity: 91/92 employees linked; 1 duplicate (Rajat); 1 unlinked (Sujal Sharma);
  6 active employees linked to a deactivated login; 19 active employees `salary=0`
  (mostly the field/trade cohort — confirm if they belong in payroll).

## Explicitly deferred (NOT in this plan)

- `user_hr` view — unnecessary; inline join instead.
- Full effective-dated `employee_versions` (SCD2) — over-engineering at this scale;
  prefer snapshot-on-record + append-only audit log **if/when** history is needed.
- `departments` / `designations` lookup tables + dropdowns — the typo-prevention layer;
  worthwhile later, but not part of solving the display/identity crisis.
- HR-access gate → RBAC migration — separate concern; `users.department` stays as-is.

## Next planning steps (decide before any code)

1. HR to confirm Rajat: error vs dual role.
2. Confirm which screens are in first scope (Locations list + person card? users list?).
3. Decide handling for the 19 `salary=0` and 6 dead-login employees (payroll scope).
4. Only then: turn the confirmed scope into concrete change steps.
