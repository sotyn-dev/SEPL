# HR Identity & Department/Designation — Solution Design

Status: proposal for review. No code changes yet.
Scope: fix the department/designation data model and the user↔employee identity
without disturbing `users.department` (which drives HR-access logic gates).

---

## 1. The problem, in one paragraph

`department`/`designation` are stored free-text in several places with no shared
source, so the same person shows different values on different screens (Locations
shows "welder", payroll shows "Operation"). Identity between a login (`users`) and
an HR record (`employees`) is a nullable link reconciled by 6 fragile name-matchers,
which has already produced a duplicate (one login → two employee rows → double
payroll). And there is no history, so promotions overwrite the past and time-series
screens render today's role against old data.

## 2. Principles

1. **`employees` is the single source of truth** for a person's department, designation,
   salary and status.
2. **`users.department` is never touched** — it keeps feeding the HR-access gates as-is.
   HR values are surfaced *alongside* it as derived fields, never by overwriting it.
3. **Three time-perspectives, three mechanisms** (do not mix them):
   - *Now* → a live view (`user_hr`). Current-state screens only.
   - *As-of a date* → an effective-dated history table (`employee_versions`).
     Historical/time-series screens, going forward.
   - *The frozen past* → snapshots already written at record time
     (`checklists.department`, `payroll_runs.*`). Only as good as what was captured.
4. **One login ↔ at most one employee.** Enforced in the schema, not by convention.

## 3. Data prerequisites (Phase 0 — must precede schema changes)

These are existing defects that will block the constraints below and corrupt payroll.
All actionable from the Employees UI; take a DB backup first.

- **De-duplicate employees** — user 21 (Rajat) is linked to two active employee rows
  (emp 7 "Rajat Sir" ₹80k, emp 61 "RAJAT SHARMA" ₹100k). Decide the true current row,
  set the other `status='inactive'` and clear its `user_id`. (The partial-unique index
  in Phase 1 will fail until this is done — a useful tripwire.)
- **19 active employees with `salary = 0`** (the field/trade cohort). Confirm whether
  they belong in this payroll module; set salaries or mark them out of scope.
- **6 active employees linked to a deactivated/archived login** — reactivate or re-link
  so attendance flows.
- **1 unlinked employee** (Sujal Sharma) — link explicitly.

## 4. Schema changes

### 4.1 Identity integrity (Phase 1)

```sql
-- one login → at most one employee; also serves as the lookup index
CREATE UNIQUE INDEX IF NOT EXISTS idx_employees_user_id
  ON employees(user_id) WHERE user_id IS NOT NULL;
```

Application guard: before any path sets `employees.user_id` (explicit picker,
email auto-link at hr.js:751, payroll name-match at payroll.js:203), reject if
another employee already holds that `user_id` and surface it to the admin.

Because the link is now unique, downstream resolution is a plain indexed join —
no correlated subquery / `LIMIT 1` tie-break needed. This is the efficiency payoff.

### 4.2 Current-state resolution — `user_hr` view (Phase 2)

```sql
CREATE VIEW user_hr AS
SELECT u.id          AS user_id,
       e.id          AS employee_id,
       e.department  AS hr_department,
       e.designation AS hr_designation
FROM users u
LEFT JOIN employees e ON e.user_id = u.id;   -- indexed, unique → 1 row per user
```

- Read-only, computed live; no data stored, nothing to sync.
- Unlinked users → `hr_*` come back NULL (fall back to `users.department`/`role` in UI).
- `users.department` untouched → gates unaffected.

Consumers (current-state only) add one join:
```sql
SELECT u.*, uh.hr_department, uh.hr_designation
FROM users u LEFT JOIN user_hr uh ON uh.user_id = u.id
```

### 4.3 History — `employee_versions` (Phase 3)

Effective-dated, one row per version (SCD Type 2 style) so an as-of read returns the
whole state in a single indexed lookup.

```sql
CREATE TABLE IF NOT EXISTS employee_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  employee_id    INTEGER NOT NULL REFERENCES employees(id),
  effective_from DATE NOT NULL,          -- inclusive
  effective_to   DATE,                   -- NULL = current version
  -- Tier 1 (career)
  designation    TEXT,
  department     TEXT,
  salary         REAL,
  status         TEXT,
  -- Tier 2 (payroll-affecting flags)
  salary_exempt  INTEGER,
  ot_eligible    INTEGER,
  cl_eligible    INTEGER,
  roster         TEXT,
  -- provenance
  changed_by     INTEGER REFERENCES users(id),
  changed_at     DATETIME DEFAULT CURRENT_TIMESTAMP,
  reason         TEXT                     -- 'promotion' | 'transfer' | 'revision' | ...
);

CREATE INDEX IF NOT EXISTS idx_empver_asof
  ON employee_versions(employee_id, effective_from);
```

`users.name`, `phone`, `email`, `user_id` are **not** versioned here — they go to the
general audit log (identity/contact corrections, not career history).
`join_date`, `cl_opening_balance`, documents are fixed/running values — not versioned.

**As-of query** (one indexed range-scan, returns full state):
```sql
SELECT * FROM employee_versions
WHERE employee_id = ? AND effective_from <= :as_of
ORDER BY effective_from DESC LIMIT 1;
```

### 4.4 Payroll freeze (Phase 4)

`payroll_runs` freezes `employee_name` + salary numbers but NOT dept/designation, so
historical payslips drift. Add frozen columns, populated at finalise from the version
effective for that month:

```sql
ALTER TABLE payroll_runs ADD COLUMN department  TEXT;
ALTER TABLE payroll_runs ADD COLUMN designation TEXT;
-- at finalise: read employee_versions as-of `${month}-01`, store dept/designation here.
```

## 5. Write rules

### On any employee edit (Employees "Edit" save)
Single transaction:
1. `UPDATE employees SET ...` (current snapshot — fast current reads keep working).
2. If a **versioned** field (Tier 1/2) changed:
   - close the open version: `UPDATE employee_versions SET effective_to = date(:eff,'-1 day') WHERE employee_id=? AND effective_to IS NULL`
   - insert a new version with `effective_from = :eff`, the new values, `changed_by`, `reason`.
3. If a non-versioned field changed → general audit log only.

### Promotion = the above with `reason='promotion'`
- One employee row (never a second row — that was the Rajat bug).
- designation (and department/salary) change on one shared `effective_from`.
- **Settle the open payroll month first** (finalise/lock) OR effective-date the salary,
  so the open month doesn't back-compute the raise for pre-promotion days.

### Backfill (Phase 3 rollout)
For every employee, insert one seed version: `effective_from = join_date`
(or created_at if missing), `effective_to = NULL`, current field values. This gives
history a starting point from today forward (it cannot reconstruct already-overwritten
past — see §7).

## 6. Read rules (which source per screen)

| Screen type | Source | Examples |
|---|---|---|
| Current state | `user_hr` view | Locations list + person card, live map, pickers, users list |
| As-of / time-series | `employee_versions` (as-of) | payslips, monthly muster, period scorecards, as-of reports |
| Already-frozen past | existing snapshots | old payslips (`employee_name`), old checklists (`checklists.department`) |

Rewire time-series screens from live-read to as-of-read (Phase 5). Until rewired,
they keep drifting even though the data exists.

## 7. Honest limits

- **History is forward-only.** `employee_versions` records changes from go-live; it
  cannot rebuild department/designation already destroyed by past overwrites. The only
  handle on the already-passed period is where a snapshot was frozen at the time.
- **Blanks stay blank.** If `employees.department` is empty (49 today), the view and
  history show blank — an HR data-entry gap to fill in the Employees screen, not a code fix.
- **The HR-access gate** still reads `users.department LIKE '%hr%'`. Out of scope here;
  if/when department is normalised, migrate that gate to a role/flag deliberately.

## 8. Efficiency

- `employees(user_id)` unique partial index → link resolution O(log n); `user_hr` is a
  plain indexed join (no subquery) once the link is unique.
- `employee_versions(employee_id, effective_from)` → as-of read is a single indexed
  range-scan returning the full state (no per-field subqueries).
- As-of reads confined to the few historical screens; current screens use the cheap view.
- At current scale (≈107 users / 92 employees) this is effectively instant; the design
  also holds into the tens-of-thousands range before materialisation would be considered.

## 9. Prevention (Phase 6 — later, optional)

Stop new typos at the entry point: `departments` + `designations(department_id)` lookup
tables seeded from the org chart (5 departments: Business, Finance, HR/Admin, Operation,
System & Process), and replace the Employees free-text datalists + the UserManagement
free-text box with dependent dropdowns (department → designation). This is the enhancement
layer; everything above works without it.

## 10. Rollout order (each phase independently shippable & reversible)

0. Data cleanup (§3) — dedup Rajat, salary=0, dead logins, unlinked.
1. Identity integrity — unique index + linker guards (§4.1).
2. `user_hr` view; point Locations list + person card at it (§4.2).
3. `employee_versions` + backfill + write-hook + promotion flow (§4.3, §5).
4. Payroll freeze dept/designation (§4.4).
5. Rewire historical screens to as-of reads (§6).
6. (Later) lookup tables + dropdowns (§9).
