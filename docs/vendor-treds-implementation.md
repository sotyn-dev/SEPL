# Vendor & TReDS implementation

## Phase 1: existing ERP audit and implementation plan

The ERP uses React 19, React Router 7, Vite 5 and Tailwind 3; Express/CommonJS and SQLite (`better-sqlite3`) power the backend. Authentication, users, reporting hierarchy, role grants, notifications, audit events and local/S3 document storage already exist.

| Requirement | Reused ERP entity or component | Module-specific addition |
| --- | --- | --- |
| Client/MNC identity | `customers`, existing Customers page | Missing structured website, sector and identifier fields |
| Supplier identity | `vendors`, existing Vendors page | Optional relationship; preserve internal SEVC codes |
| Enquiries and quotations | `crm_funnel`, `quotations`, Business Book | RFQ metadata and registration relationship |
| Client invoice | `sales_bills` | TReDS workflow and external invoice identity |
| Receipts/reconciliation | `receivables`, `collections` | Explicit existing receipt reference; funding does not mark a client invoice paid |
| Daily tasks | `pms_tasks`, `daily_work_plans` | Module link and dashboard adapter |
| Permissions | `roles`, `user_roles`, `role_permissions` | Ten module permission keys with merged grants and record scope |
| Notifications | `notifications`, AnnouncementBell, user socket rooms | Deduplicated, configurable internal reminders |
| Documents | `server/lib/storage.js` | Authenticated record-aware download; anonymous prefix blocked |
| UI | Layout, Modal, PaginationBar, shared inputs/badges | Remote selectors, backend lists, mobile cards and workflow details |
| Reports | ExcelJS and existing print/Save PDF pattern | Eleven filtered report definitions sharing list predicates |
| Audit | Global audit middleware | Immutable before/after and status history inside each transaction |

Registration means registering on a buyer's procurement portal. Client-issued vendor approval codes belong to that client-registration relationship and never replace a supplier's internal ERP code. ERP-owned TReDS accounts are distinct from buyer/platform mappings.

### Implementation phases

1. Foundation: additive schema, catalogues, registrations, documents, duplicate candidates, status gates and history.
2. Enquiries, approvals and follow-ups linked to canonical clients and CRM records.
3. Configurable TReDS platforms, seller accounts and buyer/platform contacts/mappings.
4. Canonical invoices, protected PDF/proof attachments and funding stages.
5. Database-driven dashboard, target schedules, task adapter, reports and reminders.
6. Migration dry-run, route/journey/permission/export tests, scoped lint/build, desktop/mobile browser verification and final report. Stop before production deployment.

### Files and APIs

New module code lives in `server/db/vendorTredsSchema.js`, `server/lib/vendorTreds/`, `server/routes/vendorTreds.js`, `server/scripts/vendorTredsReminderCron.js`, and `client/src/pages/vendorTreds/`. Integration changes connect server route/schema startup, the frontend route/sidebar and the existing role permission catalogue. Two narrow bank-matching changes protect credits explicitly reconciled to funding records from reuse. Tests and a module-only migration tool accompany the implementation.

`/api/vendor-treds` provides metadata, bounded lookups, paginated entity lists, detail/history, versioned edits, explicit status transitions, protected document uploads/downloads, dashboard/KPI queries, filtered reports/XLSX exports, catalogues and effective-dated settings. List, aggregate, drill-down and export filters share SQL predicates and ownership scope.

### Migration and validation

The local database is an empty schema snapshot for the relevant business tables; it is not evidence of production data quality. Schema drift exists, so the migration introspects columns/indexes, applies additive changes in a transaction, checks foreign keys and repeatability on a scratch copy, and reports identity collisions. No sample transactions are seeded. Production migration is excluded from this request.

### Financial and KPI definitions

Amounts use integer paise. Invoice face value, financed principal, expected net proceeds and actual documented receipt remain distinct. Unknown fees, taxes, rates or dates stay unknown. Discount calculations require a declared flat/annualized basis and applicable term/day basis. Funding KPI uses actual cash received; invoice face value remains a separate metric. No external platform submission, credit decision or money transfer is performed.

Target schedules retain effective dates, owner overrides and a program start date. Initial-week targets apply per week, with the ERP's Mon–Sat reporting convention as the default. Actuals come from dated transaction events. AP contacts count recorded contact activities. Same-day tracker completion compares the transaction's business date with its recorded IST date; its cohort and definition are displayed in the dashboard. Zero denominators yield an unavailable percentage.

Reminders persist in the existing in-app bell. Current ERP device push supports chat only; this module does not change that policy. Private documents never resolve through anonymous `/uploads` URLs.

## Implemented result and review scope

The local implementation covers all ten requested sections and the complete registration-to-funding journey. It reuses canonical ERP masters and transactions rather than maintaining parallel clients, users, CRM enquiries, invoices or accounting receipts. No production migration, deployment, external TReDS submission, financial transfer or commit was performed. Existing unrelated untracked files were left untouched.

| Section / URL tab | Permission key | Delivered workflow |
| --- | --- | --- |
| `dashboard` | `vendor_treds_dashboard` | Management cards, weekly scorecard, platform cohorts, funding metrics, today's tasks and dated tracker events |
| `registrations` | `vendor_registrations` | Canonical company profile, duplicates, registration stages, document checklist, expiry and protected files |
| `enquiries` | `vendor_enquiries` | RFQs linked to `crm_funnel`, procurement contacts, quotation/PO evidence and follow-ups |
| `approvals` | `vendor_approvals` | Client-issued vendor code, approval document/date, validity and approval history |
| `treds` | `treds_accounts` | Issuer accounts, active/frozen/inactive stages and buyer/platform/AP-contact mappings |
| `invoices` | `treds_invoices` | Canonical bill relationship, external invoice identity, PDF/proof uploads and acceptance/bid stages |
| `discounting` | `bill_discounting` | Terms, expected proceeds, approval, actual receipt, reconciliation and closure |
| `reports` | `vendor_treds_reports` | Eleven server-filtered reports, true XLSX and complete bounded Print / Save PDF |
| `masters` | `vendor_treds_masters` | Platform/document/sector/service catalogues and procurement/AP contacts; links to existing masters |
| `settings` | `vendor_treds_settings` | Effective-dated target schedules, responsible employees, overrides and reminder rules |

The sidebar contains one **CRM → Vendor & TReDS Management** link. All ten sections remain pill tabs inside the module at `/vendor-treds?tab=<tab>`. The single link appears when the user can view any of those sections and opens the first permitted section; each pill retains its own permission. Account/mapping, enquiry/follow-up, catalogue/contact and task/history views use `sub`; record details use `record` and optional `action=edit`. Navigation and actions respect merged role grants. Non-admin records remain scoped to assigned owners, with authorized direct-report visibility for approvers. Client profile reads outside an assigned registration expose identity only; populated unassigned master fields cannot be overwritten without the necessary authority. Duplicate candidates omit tax identifier values.

Desktop uses server-paginated tables; screens below 768px use cards. Search is debounced, lookups are bounded remote requests, and stale responses cannot replace the current request. Forms use backend field definitions, errors and permitted transitions. They submit current versions and display 409 conflicts/duplicate candidates. No transactional filtering or KPI aggregation is performed over browser-held full datasets. Unsupported advanced filter controls are hidden per entity/report. Dashboard workflow states are qualified by `status_entity`; the resulting record drilldown carries the effective raw status, and tracker drilldowns replay their original qualified predicates.

### Actual file manifest

| Files | Responsibility |
| --- | --- |
| `server/db/vendorTredsSchema.js`; integration in `server/db/schema.js` | Additive columns, module tables/indexes, immutable history triggers and ten permission registrations |
| `server/routes/vendorTreds.js`; integration in `server/index.js` | Authenticated API, role/scope gates, document namespace protection and reminder startup |
| `server/lib/vendorTreds/model.js`, `access.js`, `service.js` | Metadata, scope, validation, canonical relationships, versioned mutations and workflow gates |
| `server/lib/vendorTreds/queries.js`, `kpis.js`, `reports.js`, `finance.js` | Shared allowlisted/bound SQL cohorts, dated actuals, effective target schedules, XLSX and paise calculations |
| `server/lib/vendorTreds/documents.js`, `tasks.js` | Private documents, first-PDF milestone, existing PMS/daily-work task adapter |
| `server/scripts/migrate-vendor-treds.js`, `vendorTredsReminderCron.js` | Module-only backup/dry-run migration and deduplicated internal reminders |
| `server/lib/bankStatementImport.js`, `server/routes/bank.js` | Protect financier-credit reservations during automatic and manual matching |
| `client/src/pages/vendorTreds/index.jsx`, `Dashboard.jsx`, `TrackerEvents.jsx`, `Reports.jsx`, `Masters.jsx`, `Settings.jsx` | Ten-tab parent, dashboard/history, reports, masters and readable settings/version history |
| `client/src/components/vendorTreds/Common.jsx`, `Forms.jsx`, `Records.jsx`, `hooks.js`, `model.js` | Remote selectors, responsive rows, metadata forms, documents, workflow/history, pagination and request guards |
| `client/src/App.jsx`, `client/src/components/Layout.jsx`, `client/src/pages/admin/RolesPermissions.jsx` | Lazy route, one module link under CRM, internal pill tabs, role catalogue |
| `server/lib/vendorTreds/__tests__/fixture.js`, `service.test.js`, `routes.test.js`; `server/lib/__tests__/vendorTredsAnalytics.test.js`, `vendorTredsTaskReminders.test.js` | In-memory schema/service/API journey, financial/permission/privacy/document/report/KPI/reminder regressions |
| `client/src/pages/Scorecard.jsx`, `client/src/utils/scorecardSelection.js`; `server/lib/__tests__/scorecardSelection.test.js`, `dprActualCostScoring.test.js` | Separate DPR weekly-selection/request-order correction and regression coverage |

Module tables are `vt_catalog`, `vt_registrations`, `vt_contacts`, `vt_documents`, `vt_approvals`, `vt_enquiries`, `vt_accounts`, `vt_mappings`, `vt_followups`, `vt_invoices`, `vt_invoice_documents`, `vt_funding`, `vt_history`, `vt_task_links` and `vt_reminder_keys`. Existing client profiles receive missing structured website/domain, PAN/GST/Udyam, sector/location/turnover fields; canonical bills receive `vt_origin`. Registration/issuer, account/platform/issuer and invoice/client/issuer identities have appropriate uniqueness constraints. Catalogues are configuration, not fabricated business transactions.

### API and report contracts

All endpoints below are relative to `/api/vendor-treds` and require ERP authentication and applicable permission/scope.

| API | Contract |
| --- | --- |
| `GET /options` | Active catalogues, `entity_defs`, field/status labels, merged permissions/action capabilities and the report catalogue |
| `GET /lookups/:lookup?q=&page=&limit=` | Bounded `{rows,total,page,limit}` choices; singular/plural aliases for canonical users/customers/vendors/CRM/bills/receivables/collections/bank transactions and module relationships/catalogues |
| `GET /customers/:id/profile` | Canonical profile with assignment-aware sensitive-field redaction |
| `GET /:kind`; `GET /:kind/:id`; `GET /:kind/:id/history` | Paginated `{rows,total,page,limit}` lists; `{record,history,allowed_transitions,documents?}` details and immutable history |
| `POST /:kind`; `PATCH /:kind/:id` | Validated create/current-`version` edit; canonical identity/reference checks and explicit validation/conflict responses |
| `POST /:kind/:id/status` | Explicit `{status,version,remarks}` workflow action; backend permits only eligible transitions and required evidence |
| `POST /registrations/:id/documents` | Multipart `file,type_id,expiry_date?,remarks?`; authenticated checklist files |
| `POST /invoices/:id/documents` | Multipart `file,purpose=invoice|proof,expiry_date?,remarks?`; actual invoice purpose accepts PDF, proof accepts PDF/JPEG/PNG |
| `GET /documents/:id/download`; `PATCH /documents/:id` | Private authenticated streaming/review; invoice document IDs use `invoice-<id>` to distinguish namespaces; review requires permission/current version |
| `GET /dashboard`; `GET /weekly-kpis`; `GET /history` | Backend cards/targets/actuals/platform and funding metrics; exact drilldowns and paginated dated-event tracker |
| `GET/POST /tasks`; `GET/PATCH /tasks/:id`; `POST /tasks/:id/status` | Existing PMS task source with module links, due date/owner/reminder and completion approval; no invented work schedule |
| `GET/POST /catalog`; `PATCH /catalog/:id` | Generic entity routes manage active/required catalogue configuration |
| `GET/PATCH /settings` | `{versions,record,effective,owner_names}`; PATCH appends an effective version, validates active ERP owner IDs, and preserves history |
| `GET /reports/:report`; `GET /reports/:report/export` | Typed JSON columns/rows/filter metadata and true ExcelJS XLSX using the same scoped predicates |

Generic list kinds are `registrations`, `approvals`, `enquiries`, `accounts`, `mappings`, `invoices`, `funding`, `contacts`, `followups`, `catalog`; tasks have their dedicated adapter. Preview list/report pagination is capped at 200; UI choices are 15/25/50/100. Filter/sort parameters are bound or allowlisted. Supported cohorts include owner/client/platform, sector, source where applicable, workflow status, vendor-code/enquiry/TReDS relationships, dates, stage event and overdue deadlines. Sort selection never becomes arbitrary SQL.

| Report key | Source entity |
| --- | --- |
| `daily_registrations`, `weekly_registrations` | Registration business-date cohort |
| `vendor_approvals` | Approvals |
| `vendor_codes` | Registrations with approved client vendor code |
| `enquiries`, `po_conversion` | Enquiries / first real PO-received milestone |
| `treds_registration` | Accounts |
| `invoice_uploads` | Actual first-PDF uploads |
| `funding` | Funding transactions, actual cash and separate terms |
| `pending_followups` | Pending follow-ups |
| `weekly_kpi_scorecard` | Computed weekly actual/target metrics |

Report responses include `report`, `columns:[{key,label,type}]`, `rows`, `total`, `page`, `limit`, `filters` and optional `definition`. Types include text, number, paise, date, datetime, boolean and metric. Paise renders as rupees, including scalar metric values with monetary units. Excel cells retain numeric/null semantics and include a filter worksheet. Print / Save PDF requests all backend-filtered rows with a 10,000-row ceiling; oversized reports return 413 instead of silently truncating. The client also rejects an incomplete returned cohort. PDF output is browser print/save, not an external PDF service.

### Evidence-sensitive financial and document behavior

Creating invoice metadata leaves `uploaded_at` null even though its initial workflow status is `uploaded`; list/detail/history labels show **Awaiting invoice PDF**. The first successfully stored invoice-purpose PDF stamps the parent upload instant, increments its version and records one immutable dated milestone atomically. Proof files and replacement PDFs neither create nor reset that milestone. Upload KPI periods use the first actual PDF's IST day, not invoice metadata creation. Acceptance/later funding stages require eligible uploaded evidence.

Quotation and PO stages require existing sent/accepted ERP quotation and received client-PO relationships; text remarks cannot manufacture those stages. TReDS invoices require the correct active issuer account and confirmed buyer mapping. Canonical bill mismatches produce server-generated warning/current canonical fields while recorded invoice date/amount snapshots and historical totals remain intact; financial actions reject unresolved discrepancies.

Funding progresses through invoice/client acceptance, bid, funding approval, actual funds, reconciliation and closure. Terms use integer paise and declared flat/annualized basis. Actual receipts must be positive and cannot exceed financed principal. A bank reconciliation requires the real matching positive credit/reference, rejects debit/mismatch/reuse, and atomically reserves `bank_transactions.matched_type='vt_funding'` with the funding ID. Both auto/manual bank matching preserve this reservation. Alternative collection/receivable evidence must match the canonical invoice/client and amount. Financier credit does **not** pay the customer's AR, create a customer collection, or change `sales_bills.payment_status`; funded terms are locked and timestamps record actual stage events.

Documents are content-checked PDF/JPEG/PNG with a 10 MiB upload ceiling, record-aware permission checks, private/no-store download caching and protected storage keys. Anonymous `/uploads/vendor-treds` access is blocked. Remote storage configured with a nonempty `S3_PUBLIC_BASE_URL` causes these private uploads to return **503 before writing an object**; a private storage namespace must be configured first. Portal passwords/secrets are rejected. No external platform credentials are stored or platform actions executed.

### Verified checks and limitations

The final [combined test log](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-treds-final-tests.log) records **48 passed, 0 failed, 0 skipped**, including nested tests. These cover the complete HTTP business journey with two distinct same-client invoices, protected PDF/proof files, exact monetary/count drilldowns, reserved bank receipt and unchanged client AR; scope/privacy/optimistic conflicts; document and first-PDF gates; report/XLSX/configuration; reminders/IST and DPR selection/request ordering. The eight DPR selection regressions include delayed saves after a week/user/range change, period rendering without a weekly response, normalized Monday selection and same-week refresh. The invoice tracker regression also proves hold/resume does not count another first upload. All business fixtures are isolated and synthetic.

[Scoped lint](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-treds-lint.log) is clean for the new module, frontend route integration and selection utility. The Scorecard review found seven remaining pre-existing findings after the fix (eight before it), with no new findings; 15 existing combined Layout/Roles errors also remain, plus existing warnings. This is not a full-repository lint pass. This is a JavaScript project with no typecheck script, so no TypeScript/typecheck result is claimed.

The latest [Vite build log](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-treds-build.log) records a successful build in 38.61 seconds after moving the single module link under CRM. Vite notes the external output directory and existing large chunks; these are warnings, not build failures. The tracked diff whitespace check also passes.

[Migration report](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-treds-migration/latest-report.json) records a **dry run**, unchanged existing business row counts, zero baseline/module foreign-key issues, zero identity-collision groups, repeatability, 21 catalogue entries and `transactions_seeded:false`. Source `data/erp.db` has zero rows in customers/vendors/CRM/invoices/receivables/collections/PMS. The migration operates on its backup copy by default; this proves additive/repeatable behavior on the local empty schema, not production data compatibility or production deduplication. Production must first be validated against a current populated backup.

Saved local UI evidence: [management dashboard](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-dashboard.jpg), [registration form](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-registration-form.jpg), [mobile](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-mobile.jpg), [readable settings](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-treds-settings.jpg). Browser geometry was checked at desktop 1274px, mobile 390px and tablet 768px with no document/main horizontal overflow; the mobile registration modal fit at 368px. Tablet geometry has no separate saved screenshot. The final UI check confirmed employee names/readable target versions, the funding-qualified status filter without errors, and all eleven report choices.

Print / Save PDF controls and backend complete-row requests are implemented and checked; **native print/PDF output was not browser-verified in the in-app browser**. Its click produced no discoverable popup tab and no reported alert/runtime error, so no successful native print dialog or saved PDF is claimed. This may reflect the in-app browser's popup support; verify that action in the target deployment browser before release.

### Repeatable local validation commands

Run from `C:\Users\HP\Desktop\SEPL-main` with installed dependencies. The already installed Node 22 executable avoids the host/native-module version mismatch; no runtime installation is required.

```powershell
# Default module migration: online backup and dry run only.
& 'C:\Users\HP\Desktop\SEPL-main\outputs\node22\node.exe' server/scripts/migrate-vendor-treds.js data/erp.db

# Combined regression set (synthetic databases/fixtures).
& 'C:\Users\HP\Desktop\SEPL-main\outputs\node22\node.exe' --test server/lib/vendorTreds/__tests__/service.test.js server/lib/vendorTreds/__tests__/routes.test.js server/lib/__tests__/vendorTredsAnalytics.test.js server/lib/__tests__/vendorTredsTaskReminders.test.js server/lib/__tests__/dprActualCostScoring.test.js server/lib/__tests__/scorecardSelection.test.js

Set-Location client
& '..\outputs\node22\node.exe' node_modules/eslint/bin/eslint.js src/components/vendorTreds src/pages/vendorTreds src/App.jsx src/utils/scorecardSelection.js
& '..\outputs\node22\node.exe' node_modules/vite/bin/vite.js build --outDir ../outputs/vendor-treds-build
Set-Location ..
```

Before a production release, configure the actual program start/effective targets/responsible ERP users and grants, confirm platform/document requirements, validate private storage, run the migration on a populated production backup and review collision/FK findings, and arrange the approved production migration/deployment. Reminders use the existing internal bell with persisted deduplication; preview/test scheduling is disabled, and `ERP_DISABLE_VENDOR_TREDS_REMINDERS=1` can disable the module worker. No hard-coded staff, business rows, dashboard actuals or financial receipts are needed to initialize the module. The user approved commit, push and VPS deployment after reviewing the CRM navigation on 7 October 2026. Production backup, migration validation and live verification remain release steps.

## Separate DPR week-selection correction

Selecting a week now clears an applied period and its cached aggregate, invalidates outstanding weekly/period requests, and displays only a response matching the selected employee/week. Date-picker selections normalize to Monday, including Thursday/Sunday picks; re-selecting the same scoring week refreshes it. Latest-request generation guards prevent an older week or range response from restoring stale values. A delayed save cannot reload a departed employee/week, and a same-week save refreshes the currently applied period rather than captured old dates. Period cards must match their applied normalized date bounds, and rendering/printing uses the selected card even when the weekly response is absent. Manual plan amounts and automatic DPR-cost actuals retain their existing semantics.

The final built UI preview showed **5,000 for last week** and **11,453.34 for the current selected week**; applying both weeks showed **16,453.34**, and returning to Last Week restored **5,000**. Picking Thursday 8 October normalized to Monday 5 October and restored **11,453.34**. [Last-week proof](C:/Users/HP/Desktop/SEPL-main/outputs/dpr-last-week.jpg) and [current-week proof](C:/Users/HP/Desktop/SEPL-main/outputs/dpr-current-week.jpg) are synthetic evidence, not live ERP totals. Regression fixtures verify distinct selected-week cohorts after a range and delayed response/save delivery. The local checks above precede the approved Vendor/DPR release; deployment status must be confirmed separately from these fixture results.

Local review pages are [Vendor & TReDS](http://127.0.0.1:5191/vendor-treds?tab=dashboard) and [DPR week selection](http://127.0.0.1:5192/scorecard?tab=my). Both use isolated in-memory preview databases and are visibly labelled; the DPR page has test fixtures, while the Vendor page has no business records. The preview servers must remain running for these links to work. No production credentials or database are used. The latest navigation correction was browser-verified with one CRM module link, no separate Sales group, and all ten internal pill tabs; [CRM sidebar proof](C:/Users/HP/Desktop/SEPL-main/outputs/vendor-crm-sidebar.jpg). The user reviewed this CRM preview and subsequently authorized commit, push and deployment.
