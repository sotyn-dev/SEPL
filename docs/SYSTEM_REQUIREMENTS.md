# System Requirements Module — SEPL ERP

Lightweight product-evolution tracker (Linear / GitHub Issues feel).  
Not a help desk or Jira clone.

Branch: `feature/system-requirements-module`  
Primary operator: in-house intern scrum master / IT manager.

## Locked decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Access | Open to logged-in users (Help Tickets pattern). No Roles & Permissions matrix in Phase 1. |
| 2 | Settings | **Admin only.** Three cherry-picked lists from active `users` (overlap allowed). |
| 2a | IT managers | `sysreq_it_manager_ids` — **ordered**. First entry = **Priority / primary** manager. New Waiting tickets auto-assign to them. |
| 2b | IT team | `sysreq_it_team_ids` — developers / handlers who may receive work assignments. |
| 2c | Business owners | `sysreq_business_owner_ids` — optional business sign-off when IT requests it. |
| 2d | Assignment pool | Manual assignee = **IT managers ∪ IT team** (Admin / IT manager only). |
| 3 | History | Immutable `sysreq_history` is system of record. Logs **who** changed assignee / status. |
| 4 | Dates | `due_date`, `target_start_date`, release/completed — no story points / hour estimates. |
| 5 | Confirm UX | Reuse `ConfirmDialog` — never `window.confirm` / `alert`. |
| 6 | Sidebar | Service Desk group, immediately after Help Tickets. |
| 7 | Architecture | Fire NOC plug-in style: `*Schema.js` + routes + `lib/systemRequirements/*`. |
| 8 | Status UX | Side-by-side **Assignee** + **Status** dropdown (Jira-style). No Assign → Pending quick action. |
| 8a | Waiting | Label for `submitted` = **Waiting** (IT queue). |
| 8b | Status who | Admin / IT manager / IT team may change status (allowed transitions only). |
| 8c | Business lock | While `under_review`, **Assignee and Status both locked**. |
| 9 | Quick actions | Only business tangent: IT **Request business approval** (pick one BO); BO **Approve / Need Clarification / Reject**. |
| 9a | Business approval (1A) | IT picks **one** business owner → assignee. Banner: “Waiting for business approval — **Name**”. |
| 9b | After Approve / Reject | Back to **Waiting** + priority IT manager. |
| 9c | Need Clarification | Stays its **own status**; assignee → priority IT manager. |
| 10 | Requester edits | **Create:** title, description, type, priority. **Open:** title, description, comments only. |
| 11 | No module/department fields | Context belongs in **description** (columns removed). |

## Operating flow

1. Create as Draft, or **Submit** → status **Waiting**, assignee = priority IT manager.
2. IT manager sets **Assignee** + **Status** side-by-side (e.g. Pending / In Progress). Changes are history-logged.
3. Optional: **Request business approval** → pick one BO → **Business Approval** (status locked; show BO name).
4. Business: **Approve** or **Reject** → **Waiting** + primary manager. **Need Clarification** stays that status + primary manager.
5. Then **Testing → Released → Closed** via Status dropdown.

## Tables

- `sysreq_requirements`
- `sysreq_comments`
- `sysreq_history`
- `sysreq_attachments`

## API

`/api/system-requirements/*` — `authMiddleware` only (no `requirePermission`).
