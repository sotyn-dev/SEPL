# Website consultancy intake and reporting corrections

## Root causes and changes

The website sent Punjab for controlled enquiry SEPL9399; the webhook did not insert state at all. It also stored the service label `MEP design / BOQ / tender support` in category although the editor only offered `MEP`. This PR saves explicit state/district (never infers them from a city), maps that exact known service option to MEP, and preserves the original service in remarks, sub-trades and the saved payload. Unknown categories and locations remain visible when editing legacy records.

The dashboard now excludes only these verified delivery tests, matched by both source Website and the CRM/reference pair:

| CRM | Website reference |
|---|---|
| SEPL9398 | SEPL-20261015-EAA0BCA2 |
| SEPL9399 | SEPL-20261015-A14F8259 |

The same scope applies to dashboard totals, stage/category/assignee charts, recent rows, won/lost amounts, follow-ups and expected-closing amounts. The response includes `excludedTestCount` and the UI explains the scope. All Leads and single-record lookups retain the test records. NULL sources and real businesses containing “test” remain included. Other ERP reports, Sheet rows, GA4 and Ads are not altered by this filter. Further tests require a separately reviewed registry addition.

Assignment to Nancy, lead-capture stage, numbering, existing acceptance response, retry handling, permissions, rate limits, honeypot, notifications and mail are preserved. An enquiry intent is never treated as a qualification decision.

## Historical correction: approval required

The script does not run on startup or deploy. Default mode opens the explicit database read-only and lists proposed field changes and their SHA-256 digest. It does not print enquiry bodies or contact details. It uses saved website metadata, skips missing/truncated/invalid payloads, fills only blank location fields and only normalises the exact legacy consultancy service category. Existing manual state/category choices are preserved.

1. After owner approval of the PR/release, take a database backup and test the command on a copy.
2. Run `node server/scripts/reconcileWebsiteLeadFields.js --db /explicit/path/to/copy.sqlite`.
3. Review the proposed changes and skipped records; obtain owner approval for that exact plan before applying to production. The two controlled test records are not commercial opportunities.
4. Generate and review a fresh plan against the approved target database. To apply only that reviewed plan: `node server/scripts/reconcileWebsiteLeadFields.js --db /explicit/path/to/database.sqlite --apply --expected-digest REVIEWED_SHA256`.
5. The script recomputes the plan inside a write transaction and refuses a changed digest. Each change writes a before/after audit row. Verify saved fields and retained original service after applying.

No production database was opened or changed during preparation. Missing source data remains missing. Applying the code does not itself repair historical records.

## Validation and release

Run the five targeted Node test files named in the PR description. They use scratch databases and local HTTP servers, covering real webhook acceptance/retry/security, explicit field mapping, dashboard exclusion across every metric, authenticated access, retained audit rows, dry-run non-mutation, stale-plan refusal and idempotence. Run `npm run build` inside client to compile the UI; rebuild client assets through the existing deployment procedure after approval, rather than publishing stale committed dist files.

Do not merge or deploy without owner approval. This ERP release is separate from the website's main-only cPanel release. After an approved release, inspect both known test records and the dashboard exclusion count. Additional live enquiry submissions require new explicit authorisation. Local tests do not prove a future production delivery.
