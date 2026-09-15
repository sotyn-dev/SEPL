# Destructive-Action Safeguards (2026-08-25)

Plain-language guide to the protections added after the **22–24 Aug incident**, where one ordinary user account made ~1,155 destructive calls in one night — mass deletes across ~20 modules, 16 employee terminations, 106 PO/FOC approvals — at ~2 requests per second, noticed only the next day.

The defence is **four layers**. Any one can fail; together they make a repeat impractical — and loud.

---

## Layer 1 — Take the gun away (permissions)

**What changed:** a one-time migration (`security_destructive_strip_v1`, runs automatically at first boot after deploy) removes:

- `can_delete` on all incident modules (business book, customers, CRM/sales funnel, influencers, quotations, solar, procurement, orders, snags, billing, cheques, payment required, collections, AR/AP, HR, assets, rentals, subcon, attendance…) from **every role except the role named "Admin"**. System admins (`users.role = 'admin'`) are unaffected — they bypass role permissions entirely.
- `can_approve` on **quotations** (the PO/FOC approve spray) — same scope.

**Safety net:** before stripping, the entire permission table is snapshotted to `role_permissions_snapshot_20260825`. Any single grant can be restored via Roles → Permissions in the UI (the normal way), or in bulk from the snapshot table if this ever proves too tight.

**What to expect:** if a team legitimately deletes things day-to-day, they will now get "no permission" and ask. Re-grant `can_delete` for **that role, that module** deliberately — don't restore the old broad defaults.

## Layer 2 — Circuit breaker (the refuse)

New file: `server/lib/destructiveBreaker.js`, hooked at a single point inside `authMiddleware` so **every** route passes through it — new endpoints are covered automatically.

| Rule | Value |
|---|---|
| Counting window | rolling **10 minutes** |
| Trip threshold (day) | **10** successful destructive actions |
| Trip threshold (night, 22:00–06:00 IST) | **5** (the real spray ran 23:42–00:47) |
| Lock duration | **30 minutes**, then opens by itself |
| While locked | destructive calls get **HTTP 429**; the user **stays logged in** (never a logout); viewing, creating, editing all still work |
| Survives | pm2 restart, redeploy, re-login — the lock lives in the `destructive_locks` table |
| Applies to admins? | **Yes** — the scenario Layer 1 can't stop is a stolen admin/HR login |

**What counts toward the score:**

- Every successful `DELETE` on any **business-data module** (~40 routers: the incident bands plus every same-class cousin the adversarial review found uncovered — DPR, item master, tally bills, tools, inventory, complaints, drawings, labour, solar-site studies, user accounts…). Counted from the audit log — no per-route wiring needed. Config/housekeeping routers (pipe weights, module flags, videos, delegations…) are deliberately excluded and can neither count nor be blocked, so admin housekeeping can't arm the lock.
- Attendance **clear** (a delete disguised as a POST) — +1
- PO/FOC **approve** — +1 each (106 in 2 minutes was the incident)
- Payment **bulk-approve / bulk-reject** — +1 **per call** (not per id — a legitimate morning batch of 25 approvals must not lock the approver; the per-step + SoD gates already restrict who can call these at all)
- HR status change to terminated/inactive — +1 (transition-aware: re-saving an already-terminated employee doesn't count and isn't blocked)
- HR bulk-status — trips the lock **deliberately** (see Layer 3)
- Attendance bulk month-mark — +1 per call
- Business-book force-delete — carries its **real blast radius** (the number of DPRs + attendance rows it erased), and when it actually erased history it **locks immediately** and emails the director — same "one deliberate act, then the gun goes cold" design as HR bulk-status. A stolen admin gets one damaging force-delete, not ten.

**Burst-proof:** requests **in flight** count too. A script firing 30 parallel DELETEs at once — which would outrun any counter based only on completed requests — gets exactly the threshold through and the rest refused (verified live: 10 succeeded, 20 got 429). Path matching is normalised against Express's routing quirks (case-insensitive, doubled slashes, percent-encoding), so `/API//Customers/5` can't slip past the guard.

**What does NOT count:** punch-in/out, GPS pings, chat messages, ordinary edits, and **plain grid attendance marking** — the Monthly Grid marks payroll corrections cell-by-cell, and 15+ clicks in a sitting is normal HR work. (Marking is separately gated by `attendance.approve`, proof-tracked, and reversible; a locked account can't reach it anyway.)

**When it trips:** every admin gets an in-app + push notification, the director gets an email, and the event is logged. Escalation alerts (`bulkDeleteAlert`, from 24 Aug) still fire at 10/50/100/250/500/1000 — and now the **first alert fires at 3 during night hours**.

**Admin controls** (API now; UI button ships with the next client build):

- `GET /api/auth/breaker/locks` — who is locked / recent history
- `POST /api/auth/breaker/unlock/:userId` — clear a lock early. **Every unlock emails the director** — so a stolen admin account unlocking itself still leaves a trace.

**Emergency valve:** `ERP_DISABLE_BREAKER=1` in the environment disables the breaker entirely (mirrors `ERP_DISABLE_AUDIT`).

## Layer 3 — Close the one-shot holes

1. **Terminating an employee is no longer just an "edit."** `PUT /hr/employees/:id` changing status to `terminated`/`inactive` now requires **admin or `employees.can_approve`**. The 16-termination spray rode in on plain `employees.edit` — invisible to every delete-focused defence. Ordinary edits (phone, salary, designation) are untouched.
2. **One legitimate mass-offboarding path:** `POST /api/hr/employees/bulk-status` — up to 30 ids, reason required, needs off-boarding authority. After it succeeds the breaker lock starts **on purpose** and the director is emailed. Real HR: one batch, done. An attacker: one batch, then locked — not all morning, and never silently.
3. **Business Book `?force=1` is admin-only.** That flag skips the "this order has DPRs + attendance" refusal and cascade-wipes them in one request — the single most damaging call of the incident class. Non-admins keep the protective 409.

## Layer 4 — Detection (already existed, tightened)

`bulkDeleteAlert` (24 Aug) stays as-is, plus: night-hours first alert at 3 deletes, and the breaker trip itself alerts through the same channels.

---

## Files changed

| File | Change |
|---|---|
| `server/lib/destructiveBreaker.js` | **New** — the whole breaker: counting, thresholds, locks, unlock, notifications |
| `server/middleware/auth.js` | One `guardCheck(req)` call after authentication — the single wiring point |
| `server/routes/auth.js` | `GET /breaker/locks`, `POST /breaker/unlock/:userId` (admin-only) |
| `server/routes/hr.js` | `canOffboard()` gate on status→terminated/inactive; new `bulk-status` endpoint |
| `server/routes/attendance.js` | Breaker scoring on clear (+1) and bulk-mark (+1/call); plain marks unscored by design |
| `server/routes/quotations.js` | PO/FOC approve scores +1 |
| `server/routes/paymentrequired.js` | Bulk approve/reject score +1 per call |
| `server/routes/businessbook.js` | `force=1` admin-only + cascade weight +10 |
| `server/lib/bulkDeleteAlert.js` | Night-hours first alert tier of 3 |
| `server/db/schema.js` | Run-once permission strip + snapshot (`security_destructive_strip_v1`) |
| `client/src/pages/PoFocStripped.jsx` | Approve/delete errors show the server's message (src-only; ships with next client build) |

Server-side is complete and **needs no client rebuild** to deploy. (The admin "Unlock" button in User Management is a follow-up; until then the unlock API above works from any admin session, and locks always expire on their own in 30 minutes.)

## Test evidence (2026-08-25, local, full server + real DB copy)

30 automated end-to-end checks plus a burst test, all passing:

- Spray of 16 deletes: exactly **10 succeed, the 11th gets 429**, lock appears in the admin list, still 429 while locked
- **Parallel burst of 30 simultaneous deletes: 10 succeed, 20 refused** — the in-flight counter closes the race a completed-requests-only counter would lose
- **Unlock works and resets the window** — the next delete succeeds instead of instantly re-tripping (this caught a real same-second timestamp bug during testing; fixed with a millisecond-precision unlock boundary)
- Migration: snapshot table exists, **zero** non-Admin roles keep band-A `can_delete` or quotations `can_approve`
- Edit-only HR user: **cannot** terminate (403), **can** still edit a phone number; admin can terminate
- Bulk-status: works for authority, 403 without it, deliberately locks afterwards, rejects missing reason / wrong status / >30 ids
- `force=1` as non-admin: 403 admin-only; stripped role deleting: 403
- `auth/me` and normal traffic: never counted, never blocked
- Night threshold 5 / day threshold 10 (unit-tested with faked clock)

An independent **multi-agent adversarial review** (26 agents: bypass hunting, correctness, legit-flow breakage, hot-path performance, deploy safety — each finding then adversarially verified) ran over the change. Confirmed findings were all fixed and re-tested: ~15 uncovered module routers added to the guard, the score/block path-filter mismatch closed, Express path-normalisation bypasses closed, the parallel-burst race closed, payment bulk weights corrected to per-call, employee-PUT blocking made transition-aware, lock times shown in IST, and the PO/FOC page now shows the breaker's message instead of a bare "Failed". The performance lens empirically verified the hot-path queries stay under ~0.5 ms even against a 1M-row audit log mid-spray.

## Known limits & follow-ups (honest list)

- A **patient** attacker doing 9 deletes per 10 minutes stays under the breaker — Layer 1 (no grants) and Layer 4 (alerts) are the answer there; the strategic fix is the planned **recycle-bin soft-delete** (turns any successful wipe into a 10-minute restore).
- The Layer-1 **permission strip stays scoped to the modules the incident actually hit** (the reviewed list mam endorsed). The breaker additionally guards DPR, item master, tally bills, tools, inventory, complaints and their siblings — but ordinary roles may still hold `can_delete` there. Widening the strip to those modules is a one-line v2 migration once management confirms no team deletes there day-to-day.
- Mass **fake-present marking** via the grid is deliberately unscored (legit workflow); it remains gated by `attendance.approve`, audit-logged, and blocked while locked.
- Bulk **imports** (row caps) and **exports** (rate limits) are Phase 4 — not yet done.
- Client UI for the unlock button — next client build.
