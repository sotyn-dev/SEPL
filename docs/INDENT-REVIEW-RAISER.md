# Indent review and raiser approval

Local dummy preview approved for deployment on 26 September 2026.

For newly created indents from 28 September 2026 (Asia/Kolkata), the server stores `raiser_approval_required=1`. Existing indents retain their current flow. Weekly-plan-generated indents use their original submitter as the raiser.

1. The site engineer raises the indent.
2. The configured L1 reviewer (Naveen) uses **Review / Edit**, saves corrections, and then **Mark Correct**.
3. The original `created_by` user receives an in-app notification and uses **Approve by Raiser**. A typed display name cannot transfer approval authority.

There is no Reject action in this new flow, including through the status API. Existing pre-cutoff controls remain. CRM approval for extra billable items still precedes review. The global L2 switch does not change the required raiser signature.

Edits before final approval increment the revision and invalidate review. Final approval checks the revision shown to the user. Review and final approval cannot be performed by the same person; admin does not bypass either identity check. Reviewed quantities and units cannot be silently changed inside final approval. Existing optional from-store allocation and final-approval stock/challan processing run at final approval, not at Mark Correct.

The audit table records the reviewer, reviewed item snapshot, revisions invalidated by edits, and final approver. Pending notification entries are marked read when invalidated or completed. Mobile push remains Chat-only.

Before deployment:

- Verify Procurement → Workflow Settings → L1 contains Naveen's active account. This existing configurable assignment now supplies reviewers for new-flow indents.
- Ensure the original raiser has an active account and Procurement access. If the raiser is also the reviewer, assign a different reviewer before proceeding.
- Deploy before the Monday cutoff. No existing rows are automatically reclassified by the migration.
- The existing Wednesday/Saturday raising schedule and emergency-day settings remain unchanged.

Validation: `node --test server/lib/__tests__/indentRaiserApproval.test.js server/lib/__tests__/indentCompletion.test.js server/lib/__tests__/indentDeliveryBill.test.js` plus a Vite build and local dummy-user browser checks.

The test fixture uses an in-memory database and fake users; it must never be mounted in production. The standalone preview launcher under `outputs/indent-review-preview.cjs` is local-only and is not part of the application.
