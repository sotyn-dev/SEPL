# Daily Work Dashboard

Daily Work is available to authenticated users at `/daily-work`, with a sidebar link. It adds personal planning to existing task records; it does not create copies of those tasks or introduce a second approval system.

## Included

| Capability | Implementation |
| --- | --- |
| Existing assigned work | Delegations, PMS Tasks and recurring HR Checklists, keyed by source, source ID, assignee and (for checklists) occurrence date |
| Daily timeline | Explicit work date, start time, estimated duration, priority, timed checklist steps; source deadline displayed separately |
| Work controls | Start, pause, resume, resolve blocker, complete steps; one running task per user; optimistic version checks prevent overwriting another tab's changes |
| Completion | Existing source submission/approval handlers; submitted work is counted separately from approved work |
| Proof | Existing `/api/upload`, image/PDF preview, filename and open/download link; explicit review checkbox before submission; removal/replacement and cancellation of stale uploads |
| Context | Source instructions and attachment, additional instructions/document links, dependencies, named eligible approvers |
| Dependencies | References to the user's existing work; unresolved approvals prevent starting; circular references rejected |
| More time | Delegation/PMS extension endpoints; request reason required; original deadline stays unchanged until its existing approver accepts |
| Daily progress | Completed, remaining, overdue, blocked and awaiting approval; overdue/blocked are overlapping indicators, not additive totals |
| End-of-day review | Reason and next action for each unfinished/awaiting-approval item; append-only snapshots preserve earlier reviews |
| Team overview | Direct reports from `users.manager_id`; admins see active users; source module permissions filter report details |
| Approval inbox | Source-authorized approvals across reporting lines; does not expose another team's private plans |
| Notifications | Existing `server/lib/push.js` notifications for blockers, submitted work, extension requests, review decisions and saved day reviews |
| Accountability history | Actor, time, reason and before/after snapshots for plans, schedules, work controls and observed source workflow changes |

Planning, timing and step completion never mark a source task approved. Completing work uses the original Delegation/PMS submit route or HR checklist completion route. PMS approvals retain their existing Tally bill completion side effect. Existing module pages remain usable.

## Configuration before rollout

1. **Reporting lines:** Set each staff member's `users.manager_id` through the existing user-management workflow. Managers see direct reports, not an automatically expanded organization tree.
2. **Employee identities and rosters:** Link employees to user accounts and confirm their `employees.roster`. Defaults come from the existing roster definitions (`general` or `early`), rather than one new hard-coded dashboard shift.
3. **Personal planning schedules:** In Daily Work, choose the relevant user and **Configure schedule**. Administrators, direct-report managers, and attendance approvers for their own schedule can configure hours, working weekdays and breaks. A reason is recorded. These are planning overrides; they do not alter attendance or payroll rules.
4. **Leave and holidays:** Maintain approved leave in Attendance and company holidays in the existing payroll holiday calendar. A full-day approved leave, holiday, explicit absence, or weekly day off removes that availability. Timed leave and breaks remove their intervals. An untimed half-day leave is treated conservatively as unavailable until HR records its times.
5. **Permissions and approvers:** Retain existing role-matrix grants. Delegations use admin/Delegations-or-PMS approvers; PMS work uses the assigner, matching CRM owner, PMS approver or admin; PMS extensions and checklist completions retain admin-only approval. The dashboard does not grant new approval authority.
6. **Task plans:** Agree estimates, steps, priorities, instructions, required document links and dependencies. The two initial step suggestions in the editor are editable planning suggestions, not source-module instructions or automatically saved work.
7. **Push delivery:** Existing browser notification subscriptions and VAPID configuration must be functional. A failed notification does not fail the saved task action; the dashboard remains the record of outstanding work.

All times use SEPL's existing **Asia/Kolkata (IST)** business timezone. Overnight shifts are supported by an end time earlier than the start; after-midnight task starts have an explicit next-day checkbox. Select the shift's starting date when continuing an overnight plan. Additional business timezones would require a separate change.

Recurring checklists reuse `checklistFrequency.expectedOn`, including its existing Sunday/recurrence-window rules. The dashboard additionally respects planning availability; it does not rewrite checklist recurrence policy. It uses explicit attendance and approved leave, not inferred absence merely because a legacy roster's end time passed.

## Data and workflow boundaries

- `daily_work_plans` stores only scheduling, steps, dependencies, documents and work-session metadata. Its unique source reference prevents duplicate personal plans for the same task/occurrence.
- `daily_work_schedules` stores per-user planning overrides.
- `daily_work_events` stores plan/schedule/session changes and observed source submit/review/extension/edit/delete events.
- `daily_work_reviews` stores immutable end-of-day snapshots. Saving another review creates a new revision.
- The migration is additive and repeatable, called by normal database initialization. Existing source tables and state machines are unchanged.
- Unfinished work remains visible as backlog. It is **not automatically scheduled tomorrow**. Rescheduling requires an explicit plan save and reason. Recurring checklist occurrences keep their original occurrence date.
- A schedule, holiday or leave change can invalidate a previously saved plan. The dashboard flags the conflict instead of silently moving it.
- Source deadlines are currently dates. The displayed planned finish time is an estimate, not a new authoritative deadline.
- Activity timing is descriptive. There is no payroll write, salary deduction, attendance checkout interception, departure lock, or requirement to save an end-of-day review before leaving.
- Cross-user dependencies are intentionally not exposed; use the existing source instructions/blocker workflow when another team owns an input.
- Other ERP modules are not automatically converted into tasks. Future adapters must use authoritative assignments and source permissions instead of inferring work from every business record.
- Office document formats without a browser preview offer an open/download link. Images and PDFs are shown inline where the browser supports them.

## API

All dashboard endpoints require the existing bearer authentication middleware.

| Endpoint | Purpose |
| --- | --- |
| `GET /api/daily-work?date=YYYY-MM-DD&user_id=…` | Assigned work, schedule, counts, reviews and authorized member selector |
| `GET /api/daily-work/team?date=YYYY-MM-DD` | Direct-report workload/progress/blockers; admins see active staff |
| `GET /api/daily-work/approvals` | Source-authorized approval and extension queue |
| `PUT /api/daily-work/schedule` | Validated planning override with reason |
| `PUT /api/daily-work/plan/:source/:id` | Plan or explicitly reschedule assigned work, with version and reason |
| `POST /api/daily-work/plan/:id/action` | Start, pause, resume, block or update a checklist step |
| `POST /api/daily-work/review` | Save an immutable end-of-day review |
| `GET /api/daily-work/history/:source/:id` | Authorized task history; include occurrence date for recurring tasks |

The UI calls existing module endpoints for proof submission, approval/rejection and extension decisions. `dailyWorkEvents` observes those mutations so actions from the original module pages also appear in history.

## Validation and release

Run with the repository's supported Node runtime and installed dependencies:

```sh
node --test server/lib/__tests__/dailyWork.test.js server/lib/__tests__/delegationDates.test.js server/lib/__tests__/checklistProofVisibility.test.js
cd client
node node_modules/eslint/bin/eslint.js src/pages/DailyWork.jsx src/components/ProofPreview.jsx
npm run build
```

The database tests use in-memory SQLite and synthetic users. They cover scoping, duplicate prevention, overlap/stale-write rejection, schedule availability, overnight work, state transitions, blockers, dependency cycles, source approvals/extensions, previous checklist submissions, end-of-day snapshots, approval inbox access and IST completion dates. Browser checks use a separate synthetic preview, never the live database.

Current validation: 18 regression checks passed on Node 22, including cross-date overnight overlaps, permission-filtered review snapshots and observer failure isolation. Targeted ESLint and the production Vite build passed. Browser checks verified planning, start/pause/resume, timed step completion, the pre-submission review dialog, a manager's direct-report overview and a 390px mobile layout without horizontal overflow. The browser extension blocked automated file selection, so real file upload and its local image/PDF preview need a deployment smoke test. The source submission/approval lifecycle is covered by the API integration tests.

Activity-observer failures are logged as `[daily-work] Source action saved; activity recording failed`. They do not turn an already committed source action into an error or force users to repeat it. Monitor these logs; an observer failure can leave a gap in dashboard activity history, while the original source workflow remains authoritative.

Before deployment, back up the database using the existing operational procedure. Deploy the backend and client together, confirm roster/reporting-line configuration, and smoke-test an assignee plus a manager. This change does not deploy itself. Rollback can leave the four additive tables in place; old source workflows do not depend on them.
