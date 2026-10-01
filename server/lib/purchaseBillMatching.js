const crypto = require('crypto');
const billing = require('./purchaseBilling');
const round = billing.money;

function signature(db, id) {
  const bill = db.prepare('SELECT amount,gst_amount,freight_amount,total_amount,material_status FROM purchase_bills WHERE id=?').get(id);
  const items = db.prepare('SELECT vendor_po_item_id,quantity,po_rate,bill_rate,gst_percent FROM purchase_bill_items WHERE purchase_bill_id=? ORDER BY id').all(id);
  return crypto.createHash('sha256').update(JSON.stringify({bill,items})).digest('hex');
}

function poProgress(db, id) {
  const state = billing.poState(db, id);
  if (!state) return null;
  return {id:state.id,po_number:state.po_number,reconciliation_required:state.reconciliation_required,
    items:state.items.map(it=>({id:it.id,description:it.description,unit:it.unit,ordered_qty:it.ordered_qty,
      accepted_qty:it.received_qty,billed_qty:it.previously_billed_qty,
      balance_expected:Math.max(0,it.ordered_qty-it.received_qty),
      unbilled_qty:state.reconciliation_required?null:Math.max(0,Math.min(it.ordered_qty,it.received_qty)-it.previously_billed_qty)}))};
}

// Read-only: invoice totals, stock and historical payments are never rewritten.
function review(db, bill) {
  const finance = billing.financials(db,bill);
  const links = db.prepare('SELECT vendor_po_id FROM purchase_bill_pos WHERE purchase_bill_id=?').all(bill.id);
  const states = new Map(links.map(p=>[p.vendor_po_id,billing.poState(db,p.vendor_po_id)]));
  const approval = db.prepare('SELECT * FROM purchase_bill_match_reviews WHERE purchase_bill_id=? ORDER BY id DESC LIMIT 1').get(bill.id);
  const rateApproved = approval?.signature === signature(db,bill.id);
  const lines = db.prepare('SELECT * FROM purchase_bill_items WHERE purchase_bill_id=? ORDER BY id').all(bill.id);
  let missingValue=0,rateValue=0,needsReview=!lines.length,waiting=false;
  const items = lines.map(line=>{
    const state=states.get(line.vendor_po_id),po=state?.items.find(it=>it.id===line.vendor_po_item_id);
    // Allocate accepted quantities once, in saved invoice-line order. Pending
    // challans reserve billing quantities but do not count as accepted receipts.
    const earlier = db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM purchase_bill_items WHERE vendor_po_item_id=? AND id<?').get(line.vendor_po_item_id,line.id).n;
    const accepted=po?Math.min(+line.quantity,Math.max(0,Math.min(po.ordered_qty,po.received_qty)-earlier)):0;
    const pending=Math.max(0,+line.quantity-accepted);
    if(!po || state.reconciliation_required || state.cancelled || state.po_approval==='rejected') needsReview=true;
    if(pending>0.000001)waiting=true;
    missingValue+=pending*(+line.bill_rate)*(1+(+line.gst_percent)/100);
    const difference=Math.max(0,+line.bill_rate-(+line.po_rate));
    if(!rateApproved)rateValue+=accepted*difference*(1+(+line.gst_percent)/100);
    return {id:line.id,po_number:state?.po_number,description:line.description,unit:line.unit,
      ordered_qty:po?.ordered_qty??null,accepted_qty:accepted,billed_qty:+line.quantity,pending_qty:pending,
      po_rate:+line.po_rate,bill_rate:+line.bill_rate,rate_difference:round(difference),
      status:pending>0.000001?'Awaiting receiving verification':difference>0.005&&!rateApproved?'Rate difference needs review':'Matched'};
  });
  // An unmatched header or ambiguous historical allocation must not be
  // treated as a verified item-level invoice.
  const lineAmount=round(lines.reduce((n,l)=>n+(+l.taxable_amount),0));
  const lineGst=round(lines.reduce((n,l)=>n+(+l.gst_amount),0));
  if(Math.abs(lineAmount-(+bill.amount||0))>0.02 || Math.abs(lineGst-(+bill.gst_amount||0))>0.02)needsReview=true;
  const rejected=bill.material_status==='reject';
  const gross=+bill.total_amount||0,freight=+bill.freight_amount||0;
  const holdBeforeDebits=needsReview||rejected?gross:round(missingValue+rateValue+(waiting?freight:0));
  // Valid invoice debit adjustments reduce the disputed amount first.
  const hold=Math.min(finance.balance_amount,Math.max(0,round(holdBeforeDebits-finance.debit_total)));
  const available=Math.max(0,round(Math.min(finance.balance_amount,finance.net_payable-Math.max(0,holdBeforeDebits-finance.debit_total)-finance.paid_amount)));
  const status=rejected?'Rejected material':needsReview?'Item reconciliation needed':waiting?'Awaiting receiving verification':rateValue>0.005?'Rate difference needs review':'Verified';
  return {...finance,status,items,hold_amount:hold,payable_now:available,enforced:!!bill.match_required,
    rate_approved:rateApproved,approval:rateApproved?{reason:approval.reason,created_at:approval.created_at}:null,
    pos:links.map(p=>poProgress(db,p.vendor_po_id)),
    note:bill.match_required?'Only verified, undisputed amounts can be recorded as invoice payments. PO advances remain separate.':'Historical bill: review is advisory; existing totals and payment rules are preserved.'};
}

function approveRate(db, bill, userId, reason) {
  reason=String(reason||'').trim();
  if(reason.length<10)throw Error('Enter a reason of at least 10 characters for accepting the vendor rate');
  if(!db.prepare('SELECT 1 FROM purchase_bill_items WHERE purchase_bill_id=? AND bill_rate>po_rate+0.005').get(bill.id))throw Error('No higher bill rate to approve');
  db.prepare('INSERT INTO purchase_bill_match_reviews(purchase_bill_id,signature,reason,reviewed_by) VALUES(?,?,?,?)').run(bill.id,signature(db,bill.id),reason.slice(0,1000),userId);
  return review(db,bill);
}

function assertPayment(db,bill,amount) {
  if(!bill.match_required)return;
  const result=review(db,bill);
  if(amount>result.payable_now+0.005)throw Error(`Invoice payment exceeds verified amount available (₹${result.payable_now.toFixed(2)}). ${result.status}. Record PO advances separately.`);
}
module.exports={review,poProgress,approveRate,assertPayment};
