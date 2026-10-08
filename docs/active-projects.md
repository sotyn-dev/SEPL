# Active Projects

Confirmed business rule (8 October 2026): **a project is active if at least one of its site records has status `active`.** Sites marked `completed`, `on_hold`, null or an unknown status do not qualify a project. An open PO without an Active site is not an active project. Business Book/PO workflow status and payment balances do not override site status.

All four screens display **Active Projects**, explicitly **Company-wide**, from `GET /api/dashboard/active-projects`. Date, search, employee and financial filters do not change this operational headline. The endpoint is authenticated, uncached, and returns the calculation time and definition. Widgets refresh on opening, regaining focus, every visible minute, and on Refresh. An unavailable request displays an error, never a made-up zero.

## One query and identity

`server/lib/activeProjects.js` owns the SQL CTE used by every count and its project breakdown. A site uses its valid Business Book link, falling back to the Business Book linked through its PO. Multiple Book/order rows for the same company and project name count once. Project name falls back to company name when absent. Different named projects for one company and identically named projects for different companies remain separate.

Normalization removes case, whitespace (including pasted non-breaking spaces) and quotation marks, consistent with the legacy site deduplication rule. An unlinked site joins a linked project only when its normalized site name identifies exactly one project among linked sites. Otherwise it retains its own name identity. Unnamed, unlinked sites retain their individual IDs; they are not silently discarded or merged. Book rows without names retain their Book IDs. This is deterministic matching, not fuzzy company matching.

Admin **View projects** shows every counted project and its number of active site records; these rows sum to the headline. Unlinked records are flagged for review. Other users see only the already company-wide aggregate, not this list. No site records or permissions are rewritten by this change.

## Reconciliation of the May audit

| Former number | Former basis | Current treatment |
| --- | --- | --- |
| Dashboard: 62 Active Orders | Purchase-order workflow status | Active Projects counter; genuine PO totals keep their own meaning |
| War Room: 80 active sites | Site/Business Book IDs, with another name fallback | Canonical project count; open client POs labelled separately |
| DPR: 25 Active Sites | Normalized site names | Canonical project count; assigned-site work lists retain their permissions |
| Cash Flow: 34 Total Projects | All companies in financial records, including historical work | Canonical counter on Cash Flow Tracker; historical financial rows retained |

The old Dashboard KPI strip was removed on 22 May; the old Cash Flow screen was replaced by Cash Flow Tracker on 3 September. The shared counter is on the current screens. Compatibility API fields `activeSites` / `active_sites` also resolve to the canonical count. Legacy Cash Flow `projectCount` remains a **financial report row count**, not the active metric; `summary.activeProjects` supplies the active count.

CMD/War Room project DPR coverage and the SPOS project-level ratios use the same project membership for numerator and denominator. Duplicate site reports cannot inflate coverage; plan-only DPRs are excluded. Employee scorecard calculations are unchanged. The aggregate reflects present status, not a historical reconstruction of 21 May. The four historical numbers must not be hard-coded or presented as today's verified counts.

## Verification

Run `node --test server/lib/__tests__/activeProjects.test.js server/lib/__tests__/activeProjectsRoutes.test.js`. These cover deduplication, multiple orders, distinct clients/projects, PO links, inactive sites, null/invalid links, blank names, ambiguous matches, lifecycle changes, API parity, permissions and DPR coverage. Use Node 22 in the Windows workspace for its installed SQLite native module.

Before release, run `node scripts/reconcile-active-projects.cjs /absolute/path/to/erp.db` on a database copy or the server. It opens the database read-only and prints the canonical total alongside the former count methods; it never updates business data. Exact production totals depend on the current site statuses and links.
