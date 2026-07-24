# Payroll & Attendance — July 2026 changes (Meet 2026-07-17)

Source: HR-Head ↔ dev meeting on **17 Jul 2026** (payroll + attendance).
Status: **implemented locally, verified on the running dev instance, NOT pushed live.**
Pending tech-lead (Ashutosh) review → then push.

> Scope note: two items are intentionally **not** code-complete and are parked for
> Ashutosh — **C** (which role gets OT-eligibility/settings authority) and **D**
> (per-day mid-month roster split, which he asked to "sort out together").

---

## 1. Summary — meeting item → status

| # | Requirement (meeting) | Status | Batch |
|---|---|---|---|
| 1 | Payroll export split into **Base / OT / Total** (delete OT cols → labour-compliant sheet) | ✅ done | 1 |
| 2 | OT shown **only for OT-eligible**; OT formula on hover | ✅ done | 1 |
| 3 | Prevent **unlock of a finalised/paid** month; audit who unlocks | ✅ done | 1 |
| 4 | OT **calculated separately** from salary; frozen at lock | ✅ done | 1 |
| 5 | **Backdate** past attendance (Present/Half-Day) with **mandatory proof upload** | ✅ done | 2 |
| 6 | **Roster**: 2 shifts (9:00–6:00 / 9:30–6:30) on employee form | ✅ done | 3 |
| 7 | **Per-roster late marks & deductions** (9:00 late from 09:16, 9:30 from 09:46) | ✅ done | 3 |
| 8 | Roster **frozen into locked month** (mid-month change can't distort a paid month) | ✅ done | 3 |
| 9 | Monthly grid: **In/Out times** + **Week-Off / Worked-on-off** tags | ✅ done | 4 |
| 10 | UTC→IST "today" fix (near-midnight wrong-day bug, "E") | ✅ done | 5 |
| C | HR **authority** over OT-eligibility / settings | ⏸ parked — needs role decision | — |
| D | **Per-day** mid-month roster split | ⏸ parked — deferred in meeting | — |

Monthly attendance **grid + month filter** already existed before this work (`GET /grid`).

---

## 2. Files changed

### New
- **`server/lib/roster.js`** — single source of truth for the two rosters
  (`general` 9:30 / `early` 9:00) and `rosterCutoffs(settings, roster)` which shifts
  the admin-tuned global cutoffs (`early` = −30 min).

### Server
- **`server/db/schema.js`** (idempotent `ALTER` migrations)
  - `payroll_runs`: `ot_eligible`, `ot_per_hour_rate`, `ot_threshold`, `net_before_ot`, `roster`
  - `attendance`: `proof_url`, `marked_at`
  - `employees`: `roster` (default `'general'`)
- **`server/routes/payroll.js`**
  - requires `logAuditEvent`, `rosterCutoffs`
  - `calculateForEmployee`: roster-aware late/half cutoffs; returns `ot_eligible`, `roster`, `roster_label`, `late_after_time`, `half_day_after_time`
  - `GET /calculate`: selects `roster`
  - `POST /finalise`: **re-finalise guard**; snapshots `ot_eligible`, `ot_per_hour_rate`, `ot_threshold`, `net_before_ot`, `roster`
  - `POST /unlock`: **blocks unlock once any row is `paid=1`**; audit-logs `PAYROLL_UNLOCK` / `PAYROLL_UNLOCK_BLOCKED`
- **`server/routes/attendance.js`**
  - requires `rosterCutoffs`; new `istTodayStr()` helper
  - `isPunchLate` roster-aware; punch-in passes employee roster
  - `GET /my-month`: roster-aware late cutoff
  - `POST /admin-mark` & `/admin-mark-bulk`: **require `proof_url` for past worked-status** marks; store `proof_url`, `marked_at`, `marked_by`
  - `GET /grid`: cells now carry `in`, `out`, `hours`, `week_off`, `worked_on_off`
  - all "today" date derivations routed through `istTodayStr()` (IST) — L4 fix
- **`server/routes/hr.js`**
  - requires `normalizeRoster`; `POST`/`PUT /employees` accept & persist `roster`

### Client
- **`client/src/pages/Payroll.jsx`** — bifurcated CSV export (`Base Pay (excl. OT) | OT Hours | OT Pay | Total Payable`); OT cell shows `—` for ineligible + robust tooltip; mobile card same.
- **`client/src/pages/Attendance.jsx`** — proof upload in the Backfill modal (mandatory for past worked days); `markAllPresent` proof picker; grid `cellMeta` renders `WO` / `W✓`; legend entries; **click-any-cell → detail panel** (date, status, In/Out, hours); read-only cells made clickable.
- **`client/src/pages/Employees.jsx`** — **Roster / Shift** dropdown in add/edit form.

---

## 3. Key design decisions (for review)

1. **Roster model** — exactly two rosters as code constants in `lib/roster.js`; the
   `early` roster derives its cutoffs by offsetting the admin's global
   `payroll_settings` times (−30 min), so admins keep one set of tunable times.
   Adding a 3rd roster later = one entry (offset only).
2. **Proof gate scope** — proof required for worked-status marks **only when the
   date is in the past** (back-dating). Same-day "forgot to punch" stays
   frictionless. Absent / clear need no proof.
3. **Lock integrity** — a month can't be unlocked once anyone in it is marked
   **paid**; finalise freezes OT eligibility + rate + roster so reopening/recompute
   can't silently drift history. This fixes the "June showed unlocked" incident.
4. **Grid detail via click** — native `title` tooltips don't fire on click and are
   suppressed on disabled (read-only) cells, so a click-to-open detail panel is the
   primary way to see In/Out.
5. **Week-off = Sunday** (matches existing `sundays_paid` logic). Configurable
   week-offs (alt-Saturdays / per-roster off-days) are a future option, not built.

---

## 4. Known limitations / follow-ups
- **C** — OT-eligibility toggle (`PUT /api/payroll/leave-balance/:id`) is still
  `adminOnly`. Awaiting decision on which HR role should hold it.
- **D** — one `roster` per employee; a genuine mid-month split (9:00 first half →
  9:30 second) within one *unlocked* month is computed on the current roster until
  finalised (then frozen). True per-day split needs per-day roster tagging.
- Old `payroll_runs` snapshots finalised **before** this change won't have the new
  frozen columns populated (default 0) — only affects pre-existing locked months.

---

## 5. How to run & verify (local)

```bash
cd hagerstone-sepl
PORT=5050 npm run dev      # server :5050, client :3000 (Vite proxy → 5050)
```
Login `admin` / `admin123` at http://localhost:3000. Use month **May 2026** where a picker appears.

- **Payroll** (`HRMS → Payroll`, May 2026): OT column `10h (+₹932)` for eligible, `—` for ineligible; `Before OT` column; **Export Excel** → bifurcated CSV; **Finalise / Unlock** (unlock blocked after Paid).
- **Employees** (`HRMS → Employees` → edit): **Roster / Shift** dropdown.
- **Attendance → Dashboard → Mark / Backfill**: proof upload appears + required for past worked days.
- **Attendance → Monthly Grid → May 2026**: `WO` / `W✓` cells, legend; **click any cell** → detail panel with In/Out/hours.

> Port note: local runs on **5050** (macOS AirPlay holds 5000); `.env` and
> `client/vite.config.js` proxy targets are set to 5050. Revert both to 5000 if
> AirPlay Receiver is disabled.

Demo data present: `Test Worker` (general, OT-eligible) + `Office Staff` (early, not
eligible) with May 2026 attendance illustrating OT, week-off-worked, and roster-late.

---

## 6. Verification evidence (dev instance)
- Payroll: eligible → `ot_hours=10, ot_pay=931.9`; ineligible → `0` / `—`.
- Lock: re-finalise → 409; unlock-before-paid → 200; unlock-after-paid → **409 + audit row**; snapshot froze OT context + roster.
- Backdate: past-present no proof → 400; with proof → stored `proof_url`+`marked_at`; today exempt; absent exempt; bulk gated; UI upload verified.
- Roster: same 09:30 punch → general `late=0` / early `late=5, penalty=560`; snapshot froze roster; mid-month change left locked month unchanged; UI dropdown saves.
- Grid: `WO` / `W✓` render; click → detail panel `In 09:00 am · Out 08:00 pm · 11h`.
- IST fix: proven in the live 00:00–05:30 IST window (IST-today accepted, IST-tomorrow rejected).
