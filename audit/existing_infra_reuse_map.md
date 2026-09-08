# Existing Infrastructure Reuse Map (Step 1 supporting evidence)

> Purpose: the audit brief mandates "Reuse existing auth, DB, components. Don't rebuild what works."
> This map records the accountability/KPI/notification machinery **that already exists**, so Steps 4–5
> assemble over it instead of rebuilding. Compiled from reading `server/db/schema.js` and `server/routes/*`.
> Line numbers are indicative; **all column/route names to be re-verified against production** before code.

## TL;DR — what already exists vs. what's missing

| Capability | Status | Reuse target |
|---|---|---|
| Per-user weekly KPI scorecard | **EXISTS** | `score_templates`, `score_kpis`, `score_entries` (`scoring.js`) |
| 40+ auto KPI data sources | **EXISTS** | `score_kpis.data_source = auto:*` (`scoring.js:277-617`) |
| Weekly score math + week boundary (Monday) | **EXISTS** | `scoring.js:676-699`, `champions.js:121` |
| Leaderboard (week/month/quarter/year) | **EXISTS** | `GET /api/gamification/leaderboard` (`champions.js:176`) |
| Teams + auto-balance + awards | **EXISTS** | `gam_team`, `gam_team_member`, `gam_award` |
| Per-record ownership + SLA late tracking | **EXISTS** | `raci_assignment` (`raci.js`), `GET /api/raci/board/:module` |
| Task workflow (assign→submit→approve) | **EXISTS** | `delegations`, `pms_tasks` |
| On-time / overdue / cycle-time source data | **EXISTS** | `raci_assignment.done_at`+`sla_hours`, `*.due_date`/`submitted_at` |
| Web push + email-rules + chat notifications | **EXISTS** | `lib/push.js`, `lib/emailRules.js`, `siteChat.js` |
| Daily scheduled-job pattern | **EXISTS** | `server/scripts/dailyCmdEmail.js`, `dailyAuditSnapshot.js` (setInterval-at-time) |
| **Monday Commit / Friday Review weekly flow** | **MISSING** | columns ready: `score_entries.commitment`, `.planned`, `.actual`, `.week_start` |

## 1. Ownership / role / responsibility data
- `users` (role admin|manager|user, department, approval_role, manager_id via migration), `roles`, `role_permissions(module, can_view/create/edit/delete/approve)`, `user_roles`.
- **RACI per-record** — `raci_assignment(module, record_id, step_key, responsible_id, accountable_id, consulted_id, informed_id, sla_hours, done_at, done_by)`, UNIQUE(module,record_id,step_key). Modules+steps defined in `server/utils/raciModules.js`.
- **Delegations** — `delegations(assigned_by, assigned_to, due_date, status, submitted_at, reviewed_at, reviewer_id)`.
- Read/write routes: `GET /api/raci/board/:module`, `PUT /api/raci/record/:module/:recordId`, `GET/POST/PUT /api/delegations`, `GET /api/scoring/assignments`.

## 2. Scorecard / KPI / leaderboard engine
- Tables: `score_templates`, `score_kpis(template_id, group_name, metric_name, weightage, direction, data_source, default_planned)`, `score_user_template`, `score_user_kpi_target(planned_value, enabled, weight_override)`, `score_entries(user_id, kpi_id, week_start, planned, actual, actual_pct, last_week_pct, total_uptodate, pending_*, commitment, notes)`.
- `score_kpis.data_source` supports `manual` and **`auto:*`** (delegations done, pms approved, dpr count/profit, indents by status, MB bills, installations, collections, payment requests, candidates, attendance, complaints, …) — these are the QQTC raw feeds.
- Formula (`scoring.js:676-699`): `actual_pct = ((actual-planned)/planned)*100` (flip sign if `direction=lower_better`); week score = `Σ(weightage × actual_pct)`. Champions Score = `clamp(100 + score, 0, 200)` (`champions.js:162`). Period = average of qualified weeks (activity ≥ `gam_config.min_activity`).
- Leaderboard: `GET /api/gamification/leaderboard?period=week|month|quarter|year&date=YYYY-MM-DD` (90s cache).

## 3. SLA / task / attendance source data
- `raci_assignment`: `done_at` vs record `created_at` → elapsed; `late = elapsed > sla_hours`, `late_hours`. Per-person rollup at `raci.js:172-180`.
- `delegations` / `pms_tasks`: `status`, `due_date`, `submitted_at`, `reviewed_at`.
- `complaints`: `stepN_planned_date` / `stepN_actual_date` / `stepN_time_delay`. `snags`: `target_date`, `approval_status`.
- `attendance`: `status`, `punch_in_time`, `punch_out_time`, `total_hours`. `checklist_completions`: daily proof.

## 4. Notification channels already wired (do NOT add a new one)
| Channel | Send fn | Location |
|---|---|---|
| Web push (per-user) | `pushToUser(userId,{title,body,url,tag})` | `server/lib/push.js` |
| Web push (broadcast) | `pushToAll({...})` | `server/lib/push.js` |
| Email rules engine | `runRulesForEvent(event_key, ctx, opts)` | `server/lib/emailRules.js` (events in `emailEvents.js`) |
| Site chat (real-time) | `emitChat(groupId, ...)` (Socket.IO) | `server/routes/siteChat.js` |
| Announcements (+push) | route handler | `server/routes/announcements.js:100-110` |

Scheduler to reuse for Mon 09:00 / Fri 17:00: the `setInterval`-at-time pattern in `server/scripts/dailyCmdEmail.js` and `dailyAuditSnapshot.js`.

## 5. Weekly Monday-commit / Friday-review feature
**NONE implemented.** But `score_entries` already has `commitment`, `planned`, `actual`, `week_start` (Monday) — the storage is ready; only the Monday form + Friday snapshot/lock + audit trail need building (Step 5).
