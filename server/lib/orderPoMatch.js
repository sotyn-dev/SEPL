// One client PO = one Business Book lead.
//
// mam 2026-09-11: "u create new records as per order to planning even i told u
// if match order to planning to business book only fetch from order to planning
// po". When a PO already sits in Order to Planning, the Business Book must use
// the lead that PO belongs to — never get a second record for the same PO (for
// example one per PO line, "CPL/SEPL/10/25-26 L7").

// "CPL/SEPL/10/25-26 L7", "cpl/sepl/10/25-26" and "CPL / SEPL/10/25-26" are the
// same client PO: drop a trailing line tag, spaces and case.
const basePo = (v) => String(v || '')
  .replace(/\s+L\s*\d+\s*$/i, '')
  .replace(/\s+/g, '')
  .toLowerCase();

// Who already owns this PO? Order to Planning decides first (the PO there names
// its lead); then any other Business Book lead carrying the same PO.
// `leadId` is the lead being saved — its own PO is never a conflict.
function findOrderPoConflict(db, poNumber, { leadId = null } = {}) {
  const key = basePo(poNumber);
  if (!key) return null;
  const self = leadId == null ? null : Number(leadId);
  const leadNo = (id) => (id ? db.prepare('SELECT lead_no FROM business_book WHERE id=?').get(id)?.lead_no || null : null);

  const pos = db.prepare("SELECT id, po_number, business_book_id FROM purchase_orders WHERE COALESCE(TRIM(po_number),'') <> ''").all();
  for (const po of pos) {
    if (basePo(po.po_number) !== key) continue;
    if (self != null && po.business_book_id === self) return null;
    return { source: 'order_planning', po_id: po.id, po_number: po.po_number, lead_id: po.business_book_id || null, lead_no: leadNo(po.business_book_id) };
  }

  const leads = db.prepare("SELECT id, lead_no, po_number FROM business_book WHERE COALESCE(TRIM(po_number),'') <> ''").all();
  for (const bb of leads) {
    if (bb.id === self) continue;
    if (basePo(bb.po_number) === key) return { source: 'business_book', lead_id: bb.id, lead_no: bb.lead_no, po_number: bb.po_number };
  }
  return null;
}

function conflictMessage(c) {
  if (c.source === 'order_planning' && c.lead_no) {
    return `PO ${c.po_number} is already in Order to Planning under lead ${c.lead_no}. Open ${c.lead_no} instead of creating another Business Book record — its PO and files come from Order to Planning.`;
  }
  if (c.source === 'order_planning') {
    return `PO ${c.po_number} is already in Order to Planning but not linked to a lead yet. Link it to the right lead from Order to Planning instead of creating a new Business Book record.`;
  }
  return `PO ${c.po_number} already belongs to lead ${c.lead_no}. One client PO stays on one Business Book lead.`;
}

module.exports = { basePo, findOrderPoConflict, conflictMessage };
