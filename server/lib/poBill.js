// "Every approved PO must have a bill" — ONE predicate, two screens.
//
// mam 2026-09-07: the scorecard's Purchase Bill row and the Procurement flow
// board's Purchase Bill column must never disagree again, so both call the
// function below instead of each keeping their own copy of the WHERE clause.
// The old KPI was the RACI step 'indent_to_dispatch:purchase_bill' — the LAST
// step of that module, and a record is only ever pending at the FIRST unstamped
// step, so everything upstream absorbed the pipeline and the row read 0/0.

// When a PO became DUE a bill. vendor_pos has no approved_at column, so this
// is a documented COALESCE chain over what actually exists:
//   po_l2_at  — both code paths that write po_approval='approved' stamp it in
//               the same statement (procurement.js:4205, and the flow-board
//               popup at dashboards.js:139), so every PO approved through the
//               app carries it;
//   po_l1_at  — the next-best stamp for any row that reached approved without
//               an L2 stamp;
//   created_at — the fallback that carries the whole legacy estate: the
//               po_approval column was added with DEFAULT 'approved'
//               (schema.js:3071), so every PO that predates the approval
//               workflow reads 'approved' with NO stamp at all. For those the
//               PO was billable from the day it was raised, which is
//               created_at.
// All three are CURRENT_TIMESTAMP (UTC), so '+330 minutes' converts to IST the
// same way the rest of the scorecard does.
const PO_APPROVED_AT = `COALESCE(vp.po_l2_at, vp.po_l1_at, vp.created_at)`;
const PO_APPROVED_TS_IST = `datetime(${PO_APPROVED_AT}, '+330 minutes')`;
const PO_APPROVED_DATE_IST = `date(${PO_APPROVED_AT}, '+330 minutes')`;

// The flow board's predicate, verbatim, when called with no cutoff:
//   COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
//   AND NOT EXISTS (SELECT 1 FROM purchase_bills pb WHERE pb.vendor_po_id=vp.id)
// Bills with no PO (vendor_po_id NULL — a supported direct-bill path) are
// excluded by the join on purpose: a bill against no PO cannot satisfy any
// PO's requirement, and counting one would let a person score by uploading
// unlinked bills while POs stay unbilled.
//
// cutSql (a SQL fragment — pass a named parameter such as '@cut') bounds BOTH
// sides of the question to a moment:
//   • the BILL — only bills uploaded on or before the cutoff count as billed;
//   • the PO   — only POs whose approval timestamp is on or before the cutoff
//                are in the population at all.
// Bounding the bill alone was the bug: without the PO bound, a scoring week
// from before a PO existed still counted it as pending, and a week with zero
// POs reported a backlog. What this does NOT reconstruct is the approval
// STATE: po_approval is read as it stands today, so a PO that has since been
// rejected or cancelled is absent from every past week, and one approved today
// is treated as having been due from its approval stamp onward. Timestamps are
// all this table keeps; there is no approval history to replay.
function poMissingBillWhere(cutSql) {
  if (!cutSql) {
    return `COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
           AND NOT EXISTS (SELECT 1 FROM purchase_bills pb WHERE pb.vendor_po_id=vp.id)`;
  }
  return `COALESCE(vp.cancelled,0)=0 AND vp.po_approval='approved'
           AND ${PO_APPROVED_TS_IST} <= ${cutSql}
           AND NOT EXISTS (SELECT 1 FROM purchase_bills pb WHERE pb.vendor_po_id=vp.id
                            AND datetime(pb.created_at, '+330 minutes') <= ${cutSql})`;
}

// Whose PO is it — i.e. who OWES the purchase bill? Three sources, in mam's
// own order of authority:
//   1-2. the RACI Responsible / Accountable she named for the purchase_bill
//        step — per-indent first, then the whole-module default (record_id 0),
//        set on the Responsible (RACI) screen;
//   3.   who raised the PO (vendor_pos.created_by, recorded from 2026-09-07 on;
//        NULL on every earlier row and unbackfillable — audit_log's CREATE
//        rows carry entity_id NULL).
// po_l1_by / po_l2_by are deliberately NOT in this chain. They name the
// APPROVER — Nitin Jain, Ankur Kaplesh — not the accounts person who uploads
// the bill, and neither is the indent's creator; putting a wrong name on the
// row is worse than putting none, because it scores one person for another's
// work and hides the gap. NULL = the PO cannot be traced to any user, and
// today that is EVERY existing PO: raci_assignment is empty and created_by is
// new. Those POs are invisible to the per-person source by design and stay
// visible in auto:po_bill_pending_all, which is why mam's own row is pointed
// at the _all source until a Responsible is named.
const PO_BILL_OWNER_SQL = `COALESCE(
    (SELECT COALESCE(ra.responsible_id, ra.accountable_id) FROM raci_assignment ra
      WHERE ra.module='indent_to_dispatch' AND ra.step_key='purchase_bill'
        AND ra.record_id=COALESCE(vp.indent_id,-1) LIMIT 1),
    (SELECT COALESCE(ra.responsible_id, ra.accountable_id) FROM raci_assignment ra
      WHERE ra.module='indent_to_dispatch' AND ra.step_key='purchase_bill'
        AND ra.record_id=0 LIMIT 1),
    vp.created_by
  )`;

module.exports = {
  poMissingBillWhere, PO_BILL_OWNER_SQL,
  PO_APPROVED_AT, PO_APPROVED_TS_IST, PO_APPROVED_DATE_IST,
};
