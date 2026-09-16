# Employee Master audit and implementation

Inspected Employees.jsx, EmployeeDetailsFields.jsx, employeeTerms.js, HR create/update/list/bulk routes, publicHr self-fill, database migrations, upload endpoint/storage, auth permissions, Company Assets and employeeVehicle, PT rules and scorecard assignment. All current form keys are mapped below before implementation. This refactor continues on the isolated GitHub checkout; existing local changes stay untouched.

## Layout and behavior

Preserve Inter typography, ERP blue (#1e40af), slate text (#0f172a), white surfaces (#ffffff), pale workspace (#f0f4f8), borders (#e2e8f0), and emerald saved state (#047857). Use a wide Employee Master dialog with left section navigation on desktop, a section selector on mobile, a profile completion rail and persistent Save all changes and Close. The signature is a factual per-section completion list, not decorative numbered steps. A full-page route would add routing risk; the wide accessible dialog supports this task safely.

Quick creation uses identity/contact plus organization fields; documents are deferred only through an explicit quick_onboarding mode. Edit uses shared field definitions. One atomic update saves all changed fields; changing sections preserves drafts. Keep all original options and backend employee/user/master data. Do not invent new designation or department masters.

## Existing behavior and risks

- Existing POST requires Aadhaar/PAN/qualification files. Retain legacy behavior except explicit quick_onboarding=true, authorized by the requested lightweight onboarding workflow.
- Existing PUT overwrites core fields when omitted; master fields use COALESCE and cannot be cleared. Replace with allowlisted partial updates, preserving absent keys and accepting explicit null for removable fields.
- Existing employee_salary.can_view protects reads but raw salary writes bypass it. Require employee_salary.can_view and can_edit for changes. Respect employees create/edit, company_assets edit and employee offboarding approve permissions.
- Employees list is used for other module pickers. Preserve directory identifiers; redact private HR fields for callers without employees.can_view instead of breaking pickers. Sensitive edit remains behind employees create/edit. No new permissions/grants.
- Probation has selectable 3/6-month calculation and manual override; preserve both. CTC remains Salary × 12 on server. PT remains a configured estimate. Bonus requires an active scorecard; no payment behavior changes.
- Asset equipment arrays and vehicle selector map to the existing company_assets issue/return ledger atomically with employee saves. Omitted assignments mean unchanged.
- Upload API is /api/upload with multipart file and {url}. Preserve storage seam and URLs. Existing Form11/FormF checks allow PDF/JPG/PNG <=10 MB; apply consistent upload validation. Remove means unlink after save, not physical deletion.
- Reusable components found: Modal, ConfirmDialog, SearchableSelect, Pagination, StatusBadge, EmployeeProfessionalTax. No dedicated reusable employee document uploader exists. Add one. Extend SearchableSelect with optional accessible labels without changing existing callers.
- No UI column renames/migrations needed for this redesign. Shared schema is ownership/completion metadata, not authorization.

## Field inventory

| DB / payload key | Section | Owner | Sensitive | Calculated | Initial requirement | Completion criterion |
|---|---|---|---|---|---|---|
| name | basic | employee | no | no | quick create | yes |
| phone | basic | employee | no | no | optional | no |
| email | basic | employee | no | no | optional | no |
| date_of_birth | basic | employee | yes | no | optional | yes |
| gender | basic | employee | no | no | optional | yes |
| blood_group | basic | employee | yes | no | optional | yes |
| emergency_contact_name | basic | employee | no | no | optional | yes |
| emergency_contact_phone | basic | employee | yes | no | optional | yes |
| guardian_title | basic | employee | no | no | optional | no |
| guardian_relation | basic | employee | no | no | optional | no |
| guardian_name | basic | employee | yes | no | optional | yes |
| id | employment | system | no | yes | optional | no |
| designation | employment | hr | no | no | quick create | yes |
| department | employment | hr | no | no | quick create | yes |
| reports_to | employment | hr | no | no | quick create | yes |
| join_date | employment | hr | no | no | quick create | yes |
| employment_type | employment | hr | no | no | quick create | yes |
| grade_band | employment | hr | no | no | optional | yes |
| employment_status | employment | hr | no | no | optional | no |
| status | employment | hr | no | no | optional | no |
| roster | employment | hr | no | no | optional | no |
| notice_period_days | employment | hr | no | no | optional | yes |
| probation_end_date | employment | hr | no | yes | optional | yes |
| user_id | employment | hr | no | no | optional | no |
| same_as_permanent | address | employee | yes | no | optional | no |
| permanent_address | address | employee | yes | no | optional | yes |
| permanent_pin | address | employee | yes | no | optional | yes |
| current_address | address | employee | yes | no | optional | yes |
| current_pin | address | employee | yes | no | optional | yes |
| aadhaar_last4 | documents | employee | yes | no | optional | yes |
| aadhar_file | documents | employee | yes | no | optional | yes |
| pan_number | documents | employee | yes | no | optional | yes |
| pan_file | documents | employee | yes | no | optional | yes |
| qualification_file | documents | employee | yes | no | optional | yes |
| uan_number | statutory | hr | yes | no | optional | no |
| uan_verified | statutory | hr | yes | no | optional | no |
| pf_number | statutory | hr | yes | no | optional | no |
| esi_number | statutory | hr | yes | no | optional | no |
| pt_state | statutory | hr | yes | no | optional | no |
| form11_file | statutory | hr | yes | no | optional | no |
| form_f_file | statutory | hr | yes | no | optional | no |
| salary | compensation | hr | yes | no | optional | yes |
| ctc_annual | compensation | system | yes | yes | optional | no |
| basic_salary | compensation | hr | yes | no | optional | no |
| hra | compensation | hr | yes | no | optional | no |
| special_allowance | compensation | hr | yes | no | optional | no |
| variable_bonus | compensation | hr | yes | no | optional | no |
| bonus_target_pct | compensation | hr | yes | no | optional | no |
| pf_deduction | compensation | hr | yes | no | optional | no |
| esi_deduction | compensation | hr | yes | no | optional | no |
| professional_tax_estimate | compensation | system | yes | yes | optional | no |
| tds_estimated_annual | compensation | hr | yes | no | optional | no |
| last_increment_date | compensation | hr | yes | no | optional | no |
| salary_review_cycle | compensation | hr | yes | no | optional | no |
| reimbursement_lta_annual | compensation | hr | yes | no | optional | no |
| reimbursement_medical_annual | compensation | hr | yes | no | optional | no |
| reimbursement_phone_annual | compensation | hr | yes | no | optional | no |
| bank_ifsc | bank | employee | yes | no | optional | yes |
| bank_name | bank | employee | yes | no | optional | yes |
| bank_branch | bank | employee | yes | no | optional | yes |
| bank_account_no | bank | employee | yes | no | optional | yes |
| equipment_asset_ids | assets | hr | no | no | optional | no |
| vehicle_asset_id | assets | hr | no | no | optional | no |

Phone OR email is required for quick creation and counts once for contact completeness. Compliance is conditional (eligibility and due dates are not currently modeled), so missing optional PF/ESI or declarations will not penalize completion. Assets are optional and show assigned count. System timestamps and profile completion are derived metadata, not new editable columns. Uploaded file slots stay transient and never become database columns.


## Delivered implementation

- `client/src/components/employee/EmployeeMaster.jsx`: quick creation, eight-section editor, keyboard focus containment, background inertness, mobile selector, required completion, sticky atomic save, dirty-close and reload guards, inline errors, IFSC lookup and preserved calculations.
- `employeeForm.js` and `shared/employeeMaster.json`: complete field ownership, sensitive/calculated flags, options and completion metadata shared with the server.
- `DocumentUpload.jsx`: staged upload, validation, original/new filename, authenticated View, Replace and unlink-on-save Remove. View also supports a newly selected file before saving.
- `EmployeeAssets.jsx`: assigned cards and searchable/category-filtered eligible equipment; updates retain the original issue/return ledger.
- `employeeMaster.css`: ERP styling, one-column mobile and desktop navigation. SearchableSelect gains optional labels and disabled state; existing callers remain compatible.
- `Employees.jsx`: replaces the long modal, retains bulk import/export, roster review, self-fill and linking actions; adds directory loading/retry state.
- `server/lib/employeeMaster.js` and `server/routes/hr.js`: partial updates, quick onboarding, private-field redaction, salary edit checks and completion metadata.
- `server/lib/employeeDocumentUpload.js` and `server/index.js`: scoped `purpose=employee-document` on the existing upload endpoint, 10 MB limit, extension/signature checks, existing storage adapter. New `/uploads/employee-documents` paths require authenticated employees view permission.

No additional DB migration or renamed column is required by the redesign. Earlier field additions on this branch still include their additive schema changes. Existing POST clients retain mandatory document checks; quick_onboarding is opt-in. PUT now preserves omitted fields and supports explicit clearing. POST/PUT responses retain old keys and add employee/profile_completion data.

The first employee can be created without a manager when the database has no employees; subsequent quick creation requires a manager. This avoids a first-record deadlock without inventing a manager option. Employee self-fill continues through its existing token-scoped API.

## Validation and limits

- Eight Node regression tests pass: salary/CTC, PT rules, field validation, asset issue/return/rollback, real create/update routes, partial field preservation, quick creation, private redaction, document removal and upload permission/type/size/content checks.
- Scoped frontend lint passes. Full project lint found 374 issues (309 errors, 65 warnings) during the audit, including one in the previously added PT component that has now been fixed. Unrelated repository lint failures remain.
- Vite production build passes, with the pre-existing large-chunk warning. No standalone TypeScript check is configured in this JavaScript frontend.
- Browser Add UI and validation observed; responsive widths 390, 768 and 1366 checked with no horizontal overflow. The editor now renders through a portal to avoid inherited layout margins. Close/reload guards preserve unsaved data.
- Current local database contains zero employees. Preview is an isolated SQLite backup of actual local data with no seeded employee/asset rows. Full existing-record Edit UI verification therefore requires current employee records; persisted Edit/asset/upload behavior is covered in isolated route tests. Synthetic fixtures are confined to automated tests.
- Preview only mounts employee-related services; unrelated shell API calls can return 404. No background mail/scheduled jobs start, and the original database and live system are untouched.
- Existing legacy flat upload URLs remain served under the pre-existing upload system. New employee-document URLs are protected; securing all historical uploads requires a coordinated migration/access policy for existing consumers.

## Automatic login on Add Employee

New employees created through POST /hr/employees now create an ordinary linked ERP user in the same transaction. Usernames are normalized lowercase name parts joined by dots; collisions receive .2, .3, etc. Matching email or an explicitly selected login reuses that account without changing its password or permissions. Existing employees are not backfilled by this change.

New accounts use the requested initial password 123456, stored only as a bcrypt hash, and must change it before accessing ERP APIs. The creation response adds login_details; the UI shows the username and initial password in a compact creation-only panel. Existing-account responses contain no password. A new users.must_change_password column defaults to 0, so existing users are unaffected. A new-password screen uses the existing authenticated change-password API and clears the flag after a successful change; the new password must differ and contain at least eight characters.

The legacy users.email column is required. For phone-only onboarding, the login has a reserved, non-deliverable username@employee.invalid internal placeholder; the employee contact email remains empty. No roles are automatically granted beyond the ordinary user account.

Validation: ten employee tests pass, including duplicate names, hashing, existing-account reuse, transaction rollback, first-login verification, API blocking before password change and access after successful change. Production build passes. New UI components and App.jsx lint clean; AuthContext retains its existing no-empty and fast-refresh export lint findings.
