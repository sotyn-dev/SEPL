# Additional employee fields

Implemented from GitHub revision `c2252330083dbfe1c781170fd44547ebe0cb0c08` on local branch `codex/employee-additional-fields`. The original working checkout was not updated or overwritten.

## Where to find the additions

| Addition | Location | Behavior |
|---|---|---|
| Grade / Band | Employees → Add/Edit → Employment details | Optional L1–L8 dropdown. |
| Special Allowance | Compensation beside Basic/HRA | Non-negative monthly amount; saved with the employee. |
| Professional Tax | Compensation below PF/ESI | Read-only estimate for a selected month, using PT State, the existing Salary amount and configured slabs. No missing rule is treated as zero. |
| LTA / Medical / Phone | Reimbursements below Compensation | Three non-negative annual entitlement amounts; not monthly deductions or paid claims. |
| Bonus / Variable Target | Beside Variable / Bonus | 0–100%; a positive value requires the linked login to have an active assigned scorecard. The current template name is displayed. |
| Salary Review Cycle | Beside Last Increment Date | Apr–Mar / Joining Anniversary. |
| Vehicle Allotted | Assigned Assets below Salary Bank Account | Select a Vehicle in Company Assets or “Not allotted”. Saving records issue/return movements atomically with the employee update. |

Fixed Monthly Gross and the existing Salary field/calculation are unchanged. Existing records are not forced to fill these additions. Compensation values use the existing employee salary visibility permission.

## Configuration

1. **PT slabs:** Admin → Payroll → Rules / Settings → Employee Professional Tax Slabs. Enter company-approved state rules, minimum salary inclusive, maximum salary exclusive (blank means unbounded), monthly amount, calendar month and effective month range. A calendar-month-specific rule overrides an all-month rule in its range. Overlapping rules of the same specificity are rejected. No statutory rates are prefilled.
2. **Scorecard:** Assign an active template to the employee's Linked Login User using the existing Scorecard module before entering a positive bonus target. This field records the target; it does not automatically pay a bonus.
3. **Vehicles:** Create the asset in Company Assets with category Vehicle. Link the employee to a login user, then select an available vehicle in the employee form. Company Assets edit permission is required. Selecting “Not allotted” returns the vehicle; changing vehicles returns the old one and issues the new one. Return the old vehicle before changing the employee's linked login. A vehicle cannot be taken from another user's allocation through this form.

PT is a calculated employee-form estimate, not a new payroll deduction. Special allowance, annual entitlements and bonus targets are employee master values; this change does not modify net-pay calculations, claims processing or payment execution.

## Validation

- Frontend production build passed (existing large-chunk warning remains).
- Five focused Node tests passed: PT boundaries/effective months/overrides, invalid or overlapping slabs, field/scorecard validation, vehicle ledger transitions, and real HR create/update/read routes with salary redaction and transactional rollback.
- Full schema initialized twice in an isolated in-memory database; all new employee columns and PT rules table were present. Existing schema initialization emitted unrelated legacy missing-column/index warnings.
- No live employee data or production database was used. Browser-level visual verification was not performed.

Run targeted tests from the repository root:

```sh
node --test server/lib/__tests__/employeeAdditionalFields.test.js server/lib/__tests__/employeeAdditionalRoutes.test.js
```

Normal application startup applies the additive employee-column migrations and creates the PT rules table. Deploy frontend and backend together so the new form endpoints are available. Changes have not been pushed or deployed.

Annual CTC now derives automatically from the existing Salary amount multiplied by 12. The form is read-only and employee create/update recomputes it server-side. Salary itself remains unchanged. Assigned Assets also supports multiple laptops, PCs, mobiles, SIMs and other equipment through the existing issue/return ledger.
