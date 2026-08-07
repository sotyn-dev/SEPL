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
| 8a | Waiting / Backlog | Label for `submitted` = **Waiting / Backlog** (IT inbox). |
| 8b | Status who | Admin / IT manager / IT team may change status (allowed transitions only). |
| 8c | Business lock | While `under_review`, **Assignee and Status both locked**. |
| 8d | Closed | **Early stop** by IT manager (won’t ship) — not post-release finish. |
| 8e | Done | **Post-release success** (`released` → `done`). Sets `completed_at`. |
| 8f | Reopen | From **Done / Closed / Rejected** → `reopened`, then Pending / In Progress / Backlog for bad fix or incomplete work. Mid-QA rework = Testing → In Progress (not Reopen). |
| 8g | Board default | “Open work” hides Done, Closed, Archived, Rejected. |
| 9 | Quick actions | Only business tangent: IT **Request business approval** (pick one BO); BO **Approve / Need Clarification / Reject**. |
| 9a | Business approval (1A) | IT picks **one** business owner → assignee. Banner: “Waiting for business approval — **Name**”. |
| 9b | After Approve / Reject | Back to **Waiting / Backlog** + priority IT manager. |
| 9c | Need Clarification | Stays its **own status**; assignee → priority IT manager. Remark required → Comments as `{name} (business approver)`. |
| 9d | Approve | Silent (status + history only). Reject requires remark + auto Comment. |
| 10 | Requester edits | **Create:** title, description, type, priority, attachments. **Open:** title, description, comments (+ attach). |
| 11 | No module/department fields | Context belongs in **description** (columns removed). |
| 12 | Task preview UI | Overview: Details card (title/desc/files) + Comments card; Actions sticky desktop / blur drawer mobile. |
| 13 | Tabs | overview · development · timeline · release. **Discussion & Attachments tabs removed.** |
| 14 | Attachment scopes | Requirement (Overview), Comment (under comment + Overview), Development (one list on Dev tab only). |
| 15 | File open | Image/PDF → new tab; zip + other → download. |
| 16 | Proof | Optional via Comments only — no proof dialog on Done / Closed. |

## Real statuses (operator-facing)

| Status | UI label | Role |
|--------|----------|------|
| `submitted` | Waiting / Backlog | IT inbox |
| `under_review` | Business Approval | Tangent (locked); not free-picked |
| `need_clarification` | Need Clarification | After business clarify |
| `pending` | Pending | Assigned, not started |
| `in_progress` | In Progress | Being built |
| `testing` | Testing | QA |
| `released` | Released | Shipped |
| `done` | Done | Successful finish after release |
| `closed` | Closed | Early IT kill |
| `reopened` | Reopened | Revived after Done/Closed/Rejected |
| `rejected` | Rejected | Terminal reject (optional) |

Legacy (DB only / hidden from filters): Draft, Approved, Planned, Assigned, In Development, Archived.

## Operating flow

1. Create / **Submit** → **Waiting / Backlog**, assignee = priority IT manager. Optional files on create.
2. IT manager sets **Assignee** + **Status** side-by-side (e.g. Pending / In Progress). Changes are history-logged.
3. Optional: **Request business approval** → pick one BO → **Business Approval** (status locked; show BO name).
4. Business: **Approve** (silent) or **Reject** / **Need Clarification** (remark → Comments labeled business approver) → back to IT path.
5. Happy path: **Testing → Released → Done** (status only; optional proof in Comments).
6. Early stop: **Closed** from Backlog / Clarification / Pending (IT manager).
7. Bad fix after finish: **Reopen** → then Pending / In Progress (assign developer). QA bounce before release = Testing → In Progress.

## Tables

- `sysreq_requirements`
- `sysreq_comments` — includes `source` (`user` | `business_reject` | `business_clarify`)
- `sysreq_history`
- `sysreq_attachments` — optional `comment_id`, `dev_section` (`development`)

## API

`/api/system-requirements/*` — `authMiddleware` only (no `requirePermission`).

Attachments `POST` accepts optional `comment_id` or `dev_section=development`.