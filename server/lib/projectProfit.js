const round = n => Math.round((Number(n) || 0) * 100) / 100;
const BASES = ['sales', 'client_ra', 'dpr'];
const CATEGORIES = ['Overhead', 'Transport', 'Travel', 'Salary', 'Material', 'Labour', 'Revenue correction', 'Other'];
function validDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === s;
}
function validateAdjustment(b) {
  if (!Number.isSafeInteger(b.project_id) || b.project_id < 1) return 'Select a project';
  if (!BASES.includes(b.basis)) return 'Select a calculation basis';
  if (!['revenue','cost'].includes(b.kind)) return 'Select revenue or cost';
  if (!CATEGORIES.includes(b.category)) return 'Select a category';
  if (!validDate(b.entry_date)) return 'Enter a valid date';
  if (typeof b.amount !== 'number' || !Number.isFinite(b.amount) || !b.amount || Math.abs(b.amount) > 1e11 || Math.abs(b.amount * 100 - Math.round(b.amount * 100)) > 0.001) return 'Enter a non-zero amount with at most two decimals';
  if (typeof b.reason !== 'string' || b.reason.trim().length < 5 || b.reason.length > 1000) return 'Enter a reason (5–1000 characters)';
  return null;
}
function report(db, {basis='sales', from='', to=''} = {}) {
  const projects = db.prepare(`SELECT id, lead_no, project_name, company_name, client_name, status,
    MAX(0, COALESCE(sale_amount_without_gst,0)-COALESCE(management_discount_amount,0)) contract_value FROM business_book ORDER BY id DESC`).all();
  const entries = [];
  const add = (rows, source, kind, amountKey, dateKey) => rows.forEach(r => entries.push({
    id: `${source}:${r.id}:${kind}`, record_id:r.id, project_id:r.project_id, source, kind,
    amount:round(r[amountKey]), entry_date:String(r[dateKey] || '').slice(0,10), reference:r.reference || String(r.id), manual:false
  }));
  if (basis === 'dpr') {
    const rows = db.prepare(`SELECT d.*, COALESCE(s.business_book_id,p.business_book_id) project_id, s.name reference
      FROM dpr d LEFT JOIN sites s ON s.id=d.site_id LEFT JOIN purchase_orders p ON p.id=s.po_id
      WHERE d.approval_status='approved' AND d.submission_time IS NOT NULL AND COALESCE(d.is_planned_template,0)=0`).all();
    add(rows,'Approved DPR','revenue','grand_total_a','report_date');
    add(rows,'Approved DPR','cost','grand_total_b','report_date');
  } else {
    if (basis === 'sales') add(db.prepare(`SELECT b.*, COALESCE(b.business_book_id,p.business_book_id) project_id, b.bill_number reference
      FROM sales_bills b LEFT JOIN purchase_orders p ON p.id=b.po_id
      WHERE b.approval_status='approved' AND (b.bill_type IN (2,3) OR b.bill_type IS NULL)`).all(),'Sales invoice','revenue','amount','bill_date');
    else add(db.prepare(`SELECT *,ra_no reference FROM proj_client_ra_bills WHERE status IN ('raised','payment','paid')`).all(),'Client RA','revenue','gross_amount','raised_at');
    add(db.prepare(`SELECT b.*, COALESCE(op.business_book_id,p.business_book_id) project_id,b.bill_number reference
      FROM purchase_bills b LEFT JOIN vendor_pos v ON v.id=b.vendor_po_id LEFT JOIN indents i ON i.id=v.indent_id
      LEFT JOIN order_planning op ON op.id=i.planning_id LEFT JOIN purchase_orders p ON p.id=op.po_id`).all(),'Purchase bill','cost','amount','bill_date');
    add(db.prepare(`SELECT *,ra_no reference FROM proj_contractor_ra_bills WHERE status IN ('raised','payment','paid')`).all(),'Contractor RA','cost','gross_amount','raised_at');
    add(db.prepare(`SELECT r.*,COALESCE(s.business_book_id,p.business_book_id) project_id,r.request_no reference
      FROM payment_requests r LEFT JOIN sites s ON s.id=r.site_id LEFT JOIN purchase_orders p ON p.id=s.po_id
      WHERE r.status='final_approved' AND r.category IN ('TA/DA','Transport')`).all(),'Approved travel / transport','cost','amount','created_at');
  }
  const adjustments = db.prepare(`SELECT a.*,u.name created_by_name,v.name voided_by_name FROM project_profit_adjustments a
    LEFT JOIN users u ON u.id=a.created_by LEFT JOIN users v ON v.id=a.voided_by WHERE a.basis=? ORDER BY a.id DESC`).all(basis);
  for (const a of adjustments) if (!a.voided_at) entries.push({...a,record_id:a.id,id:`manual:${a.id}`,manual:true,source:a.category,reference:a.reason});
  const known = new Set(projects.map(p=>p.id));
  const unlinked = entries.filter(e=>!known.has(e.project_id));
  const undated = entries.filter(e=>!validDate(e.entry_date));
  const filtered = entries.filter(e=>(!from && !to) || (validDate(e.entry_date) && (!from || e.entry_date>=from) && (!to || e.entry_date<=to)));
  const orderRows = projects.map(p=>{
    const ledger=filtered.filter(e=>e.project_id===p.id);
    const sum=(kind,manual)=>round(ledger.filter(e=>e.kind===kind && e.manual===manual).reduce((n,e)=>n+e.amount,0));
    const auto_revenue=sum('revenue',false),auto_cost=sum('cost',false),manual_revenue=sum('revenue',true),manual_cost=sum('cost',true);
    const revenue=round(auto_revenue+manual_revenue),cost=round(auto_cost+manual_cost),profit=round(revenue-cost);
    return {...p,name:(p.project_name || '').trim() || (p.company_name || '').trim() || `Project ${p.id}`,auto_revenue,auto_cost,manual_revenue,manual_cost,revenue,cost,profit,
      margin:revenue>0?round(profit/revenue*100):null,auto_count:ledger.filter(e=>!e.manual).length,manual_count:ledger.filter(e=>e.manual).length,
      has_activity:ledger.length>0,ledger,adjustments:adjustments.filter(a=>a.project_id===p.id)};
  });
  const groups = new Map();
  for (const order of orderRows) {
    const display = (order.project_name || '').trim() || (order.company_name || '').trim() || `Project ${order.id}`;
    const key = display.normalize('NFKC').replace(/\s+/g,' ').toLowerCase();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(order);
  }
  const rows = [...groups.values()].map(orders => {
    orders.sort((a,b)=>a.id-b.id);
    const first=orders[0], total=key=>round(orders.reduce((n,o)=>n+o[key],0));
    const revenue=total('revenue'),cost=total('cost'),profit=round(revenue-cost);
    return {...first,name:first.name.trim().replace(/\s+/g,' '),orders:orders.map(({ledger,adjustments,...order})=>order),
      order_count:orders.length,lead_no:orders.map(o=>o.lead_no || `Order #${o.id}`).join(', '),
      client_name:[...new Set(orders.map(o=>o.client_name).filter(Boolean))].join(', '),
      contract_value:total('contract_value'),auto_revenue:total('auto_revenue'),auto_cost:total('auto_cost'),
      manual_revenue:total('manual_revenue'),manual_cost:total('manual_cost'),revenue,cost,profit,
      margin:revenue>0?round(profit/revenue*100):null,auto_count:total('auto_count'),manual_count:total('manual_count'),
      has_activity:orders.some(o=>o.has_activity),ledger:orders.flatMap(o=>o.ledger.map(e=>({...e,order_reference:o.lead_no || `Order #${o.id}`}))),
      adjustments:orders.flatMap(o=>o.adjustments.map(a=>({...a,order_reference:o.lead_no || `Order #${o.id}`}))).sort((a,b)=>b.id-a.id)};
  });
  return {basis,from,to,rows,warnings:{unlinked_count:unlinked.length,undated_count:undated.length},unlinked};
}
module.exports={report,validateAdjustment,validDate,BASES,CATEGORIES};
