// Quantity reconciliation and AP calculations shared by every purchase-bill entry point.
const money = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const json = value => { try { const a=JSON.parse(value || '[]'); return Array.isArray(a)?a:[]; } catch (_) { return []; } };

function ensurePurchaseBilling(db) {
  for (const [name,type] of [['freight_amount','REAL NOT NULL DEFAULT 0'],['reconciliation_version','INTEGER NOT NULL DEFAULT 0'],['request_key','TEXT'],['reconciliation_note','TEXT']]) {
    if (!db.prepare('PRAGMA table_info(purchase_bills)').all().some(c=>c.name===name)) db.exec(`ALTER TABLE purchase_bills ADD COLUMN ${name} ${type}`);
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pb_request ON purchase_bills(request_key) WHERE request_key IS NOT NULL;
    CREATE TABLE IF NOT EXISTS purchase_bill_pos (
      purchase_bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
      vendor_po_id INTEGER NOT NULL REFERENCES vendor_pos(id), PRIMARY KEY(purchase_bill_id,vendor_po_id));
    CREATE TABLE IF NOT EXISTS purchase_bill_items (
      id INTEGER PRIMARY KEY, purchase_bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
      vendor_po_id INTEGER NOT NULL REFERENCES vendor_pos(id), vendor_po_item_id INTEGER NOT NULL REFERENCES vendor_po_items(id),
      delivery_note_id INTEGER REFERENCES delivery_notes(id), grn_item_id INTEGER REFERENCES grn_items(id),
      description TEXT, unit TEXT, quantity REAL NOT NULL CHECK(quantity>0), po_rate REAL NOT NULL,
      bill_rate REAL NOT NULL CHECK(bill_rate>=0), gst_percent REAL NOT NULL DEFAULT 0,
      taxable_amount REAL NOT NULL, gst_amount REAL NOT NULL, total_amount REAL NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_pbi_item ON purchase_bill_items(vendor_po_item_id);
    CREATE TABLE IF NOT EXISTS purchase_bill_debits (
      purchase_bill_id INTEGER NOT NULL REFERENCES purchase_bills(id) ON DELETE CASCADE,
      debit_note_id INTEGER NOT NULL UNIQUE REFERENCES debit_notes(id), amount REAL NOT NULL CHECK(amount>0),
      allocated_by INTEGER REFERENCES users(id), PRIMARY KEY(purchase_bill_id,debit_note_id));
    INSERT OR IGNORE INTO purchase_bill_pos SELECT id,vendor_po_id FROM purchase_bills WHERE vendor_po_id IS NOT NULL;`);
  // Preserve uncertain history; never infer quantities by dividing an invoice total.
  db.transaction(()=>{
    for(const bill of db.prepare('SELECT * FROM purchase_bills WHERE reconciliation_version=0 AND vendor_po_id IS NOT NULL').all()) {
      const linked=db.prepare('SELECT * FROM delivery_notes WHERE balance_purchase_bill_id=?').all(bill.id);
      const count=db.prepare('SELECT COUNT(*) n FROM purchase_bills WHERE vendor_po_id=?').get(bill.vendor_po_id).n;
      const notes=linked.length?linked:count===1?db.prepare("SELECT * FROM delivery_notes WHERE vendor_po_id=? AND document_type='challan'").all(bill.vendor_po_id):[];
      const poLines=db.prepare('SELECT * FROM vendor_po_items WHERE vendor_po_id=?').all(bill.vendor_po_id);
      const lines=notes.flatMap(dn=>json(dn.items_json).filter(it=>+it.received_qty>0).map(it=>({it,dn,po:poLines.find(p=>p.id===+it.vendor_po_item_id)})));
      const value=money(lines.reduce((n,l)=>n+(+l.it.received_qty)*(+l.po?.rate || 0),0));
      const totals={};for(const l of lines) totals[l.po?.id]=(totals[l.po?.id]||0)+(+l.it.received_qty);
      if(bill.material_status!=='reject' && lines.length && lines.every(l=>l.po && totals[l.po.id]<=+l.po.quantity) && Math.abs(value-(+bill.amount||0))<0.02 && value>0) {
        const tax=(+bill.gst_amount||0)/value*100;
        for(const {it,dn,po} of lines) insertLine(db,bill.id,po,{description:it.description,unit:it.unit},+it.received_qty,+po.rate,tax,{delivery_note_id:dn.id});
        db.prepare("UPDATE purchase_bills SET reconciliation_version=1,reconciliation_note='Historical quantities matched to delivery lines and PO rates' WHERE id=?").run(bill.id);
      } else db.prepare("UPDATE purchase_bills SET reconciliation_note='Historical bill needs item reconciliation before further billing of this PO' WHERE id=?").run(bill.id);
    }
  })();
}

function insertLine(db,billId,po,item,qty,rate,gst,source={}) {
  const taxable=money(qty*rate),tax=money(taxable*gst/100);
  db.prepare(`INSERT INTO purchase_bill_items(purchase_bill_id,vendor_po_id,vendor_po_item_id,delivery_note_id,grn_item_id,description,unit,quantity,po_rate,bill_rate,gst_percent,taxable_amount,gst_amount,total_amount)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(billId,po.vendor_po_id,po.id,source.delivery_note_id||null,source.grn_item_id||null,item.description||'',item.unit||'',qty,+po.rate||0,rate,gst,taxable,tax,money(taxable+tax));
}

function poState(db,poId,ignoreLegacyId=0) {
  const po=db.prepare('SELECT * FROM vendor_pos WHERE id=?').get(poId); if(!po)return null;
  const items=db.prepare(`SELECT v.*,COALESCE(im.item_name,ii.description,v.description,'Item') description,COALESCE(ii.unit,im.uom,'') unit,ii.item_master_id
    FROM vendor_po_items v LEFT JOIN indent_items ii ON ii.id=v.indent_item_id LEFT JOIN item_master im ON im.id=ii.item_master_id WHERE v.vendor_po_id=? ORDER BY v.id`).all(poId);
  const unresolved=ignoreLegacyId?[]:db.prepare(`SELECT b.id FROM purchase_bills b JOIN purchase_bill_pos bp ON bp.purchase_bill_id=b.id
    WHERE bp.vendor_po_id=? AND b.reconciliation_version=0 AND b.id<>?`).all(poId,ignoreLegacyId);
  const dns=db.prepare("SELECT * FROM delivery_notes WHERE vendor_po_id=? AND document_type='challan' AND status IN ('received','partial')").all(poId);
  const grns=db.prepare(`SELECT gi.*,g.status grn_status FROM grn_items gi JOIN grn g ON g.id=gi.grn_id WHERE g.vendor_po_id=? AND g.status<>'rejected'`).all(poId);
  // GRNs are the acceptance record when present. Never add the same physical receipt again from a challan.
  const usingGrn=grns.length>0;
  let ambiguous=false;
  const sources=new Map(items.map(it=>[it.id,[]]));
  if(usingGrn) for(const g of grns) {
    const matches=items.filter(it=>g.item_master_id?it.item_master_id===g.item_master_id:it.description.trim().toLowerCase()===String(g.description).trim().toLowerCase());
    if(matches.length!==1){ambiguous=true;continue;}
    const qty=Math.max(0,Math.min(+g.accepted_qty||0,(+g.received_qty||0)-(+g.rejected_qty||0)));
    sources.get(matches[0].id).push({grn_item_id:g.id,qty});
  } else for(const dn of dns) for(const r of json(dn.items_json)) {
    const id=+r.vendor_po_item_id;if(!sources.has(id)){if(+r.received_qty>0)ambiguous=true;continue;}
    sources.get(id).push({delivery_note_id:dn.id,qty:Math.max(0,(+r.received_qty||0)-(+r.rejected_qty||0))});
  }
  const rows=items.map(it=>{
    const billed=db.prepare('SELECT COALESCE(SUM(quantity),0) n FROM purchase_bill_items WHERE vendor_po_item_id=?').get(it.id).n;
    const received=sources.get(it.id).reduce((n,r)=>n+r.qty,0);
    return {...it,ordered_qty:+it.quantity,po_rate:+it.rate||0,received_qty:received,previously_billed_qty:billed,
      billable_qty:unresolved.length||ambiguous||po.cancelled||po.po_approval==='rejected'||po.payment_block_status==='pending'?0:Math.max(0,Math.min(+it.quantity,received)-billed),sources:sources.get(it.id)};
  });
  return {...po,items:rows,reconciliation_required:unresolved.length>0||ambiguous,legacy_bill_ids:unresolved.map(b=>b.id),pending_value:money(rows.reduce((n,it)=>n+it.billable_qty*it.po_rate,0))};
}

function financials(db,bill) {
  const explicit=db.prepare(`SELECT d.*,a.amount allocation FROM purchase_bill_debits a JOIN debit_notes d ON d.id=a.debit_note_id WHERE a.purchase_bill_id=? AND d.status<>'cancelled'`).all(bill.id);
  let debit=explicit.reduce((n,d)=>n+Math.min(+d.amount,+d.allocation),0),review=0;
  const direct=db.prepare("SELECT * FROM debit_notes WHERE purchase_bill_id=? AND status<>'cancelled' AND id NOT IN (SELECT debit_note_id FROM purchase_bill_debits)").all(bill.id);
  for(const d of direct) {
    // Legacy auto-short notes compare the whole order to received quantities, not what this invoice billed.
    if(/auto/i.test(d.reason||'') && ['short_supply','extra_rate'].includes(d.type)) {
      const poTotal=db.prepare('SELECT SUM(quantity*rate) n FROM vendor_po_items WHERE vendor_po_id=?').get(d.vendor_po_id)?.n;
      const accepted=db.prepare('SELECT SUM(quantity*po_rate) n FROM purchase_bill_items WHERE purchase_bill_id=?').get(bill.id)?.n;
      if(d.type==='short_supply' && accepted!=null && +bill.amount<=accepted+0.01) continue;
      if(d.type==='extra_rate' && poTotal!=null && +bill.amount<=poTotal+0.01) continue;
      review+=+d.amount||0; continue;
    }
    debit+=Math.max(0,+d.amount||0);
  }
  // Unallocated PO debits are not deducted repeatedly from each invoice.
  const unallocated=db.prepare(`SELECT COALESCE(SUM(d.amount),0) n FROM debit_notes d JOIN purchase_bill_pos bp ON bp.vendor_po_id=d.vendor_po_id
    WHERE bp.purchase_bill_id=? AND d.purchase_bill_id IS NULL AND d.status<>'cancelled'
    AND NOT EXISTS(SELECT 1 FROM purchase_bill_debits a WHERE a.debit_note_id=d.id)`).get(bill.id).n;
  const paid=db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE type='payable' AND reference_type IN ('purchase_bill','purchase_bills') AND reference_id=?").get(bill.id).n;
  const net=Math.max(0,money((+bill.total_amount||0)-debit)),amountPaid=Math.max(0,money(paid));
  return {debit_total:money(debit),debit_review_amount:money(review+unallocated),net_payable:net,paid_amount:amountPaid,balance_amount:Math.max(0,money(net-amountPaid)),payment_status:net<=0?'paid':amountPaid<=0?'pending':amountPaid+0.005>=net?'paid':'partial'};
}

function eligibleDebits(db,vendorId) {
  return db.prepare(`SELECT d.* FROM debit_notes d WHERE d.vendor_id=? AND d.status<>'cancelled' AND d.purchase_bill_id IS NULL
    AND NOT EXISTS(SELECT 1 FROM purchase_bill_debits a WHERE a.debit_note_id=d.id)`).all(vendorId);
}

function saveBill(db,body,userId,filePath,legacyId=0) {
  return db.transaction(()=>{
    const key=String(body.request_key||'');if(!/^[a-zA-Z0-9-]{16,80}$/.test(key))throw Error('A request ID is required');
    const prior=db.prepare('SELECT id FROM purchase_bills WHERE request_key=?').get(key);if(prior)return {...prior,existing:true};
    const legacy=legacyId?db.prepare('SELECT * FROM purchase_bills WHERE id=? AND reconciliation_version=0').get(legacyId):null;
    if(legacyId&&!legacy)throw Error('Historical bill has already been reconciled');
    const freight=Number(legacy ? legacy.freight_amount || 0 : body.freight_amount || 0);
    if(!Number.isFinite(freight)||freight<0)throw Error('Freight amount must be a valid non-negative number');
    const vendor=+body.vendor_id,number=String(body.bill_number||'').trim(),date=String(body.bill_date||'');
    if(!db.prepare('SELECT id FROM vendors WHERE id=?').get(vendor))throw Error('Select a vendor');
    if(!number||number.length>100)throw Error('Bill number is required');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||Number.isNaN(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw Error('Valid bill date is required');
    if(!filePath)throw Error('Purchase bill file is required');
    if(legacy && (legacy.vendor_id!==vendor || legacy.bill_number!==number))throw Error('Keep the historical vendor and bill number unchanged');
    if(db.prepare('SELECT id FROM purchase_bills WHERE vendor_id=? AND LOWER(TRIM(bill_number))=LOWER(?) AND id<>?').get(vendor,number,legacyId))throw Error('Bill number already exists for this vendor');
    if(!Array.isArray(body.items)||!body.items.length)throw Error('Select billable items');
    const seen=new Set(),prepared=[],states=new Map();
    for(const input of body.items) {
      const poId=+input.vendor_po_id;if(!states.has(poId))states.set(poId,poState(db,poId,legacyId));
      const state=states.get(poId);if(!state||state.vendor_id!==vendor)throw Error('All POs must belong to the selected vendor');
      if(legacy && !db.prepare('SELECT 1 FROM purchase_bill_pos WHERE purchase_bill_id=? AND vendor_po_id=?').get(legacy.id,poId))throw Error('Historical reconciliation must retain the original PO links');
      if(state.cancelled||state.po_approval==='rejected'||state.payment_block_status==='pending')throw Error('PO is cancelled, rejected or blocked for payment');
      if(state.reconciliation_required)throw Error('Reconcile historical bills/receipt item links before billing this PO');
      const item=state.items.find(it=>it.id===+input.vendor_po_item_id),qty=Number(input.quantity),rate=Number(input.bill_rate),tax=Number(input.gst_percent);
      if(!item||seen.has(item.id))throw Error('Invalid or duplicate PO item');seen.add(item.id);
      if(!Number.isFinite(qty)||qty<=0||qty>item.billable_qty+0.000001)throw Error('Bill quantity exceeds accepted unbilled quantity');
      if(input.bill_rate==null||input.bill_rate===''||!Number.isFinite(rate)||rate<0||!Number.isFinite(tax)||tax<0||tax>100)throw Error('Enter valid bill rate and GST percentage');
      prepared.push({item,qty,rate,tax});
    }
    const poIds=[...states.keys()];
    const r=legacy?{lastInsertRowid:legacy.id}:db.prepare(`INSERT INTO purchase_bills(vendor_po_id,vendor_id,bill_number,bill_date,amount,gst_amount,total_amount,file_path,material_status,created_by,reconciliation_version,request_key)
      VALUES(?,?,?,?,0,0,0,?,'approved',?,2,?)`).run(poIds.length===1?poIds[0]:null,vendor,number,date,filePath,userId,key);
    for(const id of poIds)db.prepare('INSERT OR IGNORE INTO purchase_bill_pos VALUES(?,?)').run(r.lastInsertRowid,id);
    for(const {item,qty,rate,tax} of prepared) {
      let remaining=qty;
      // Allocate physical receipt sources FIFO, keeping traceability without changing inventory.
      let previously=item.previously_billed_qty;
      for(const source of item.sources) {
        const consumed=Math.min(previously,source.qty);previously-=consumed;
        const take=Math.min(remaining,source.qty-consumed);
        if(take>0){insertLine(db,r.lastInsertRowid,item,item,take,rate,tax,source);remaining-=take;}
      }
      if(remaining>0.000001)throw Error('Receipt balance changed; reload and try again');
      const allocated=db.prepare('SELECT id,taxable_amount,gst_amount FROM purchase_bill_items WHERE purchase_bill_id=? AND vendor_po_item_id=? ORDER BY id').all(r.lastInsertRowid,item.id);
      const last=allocated[allocated.length-1],targetAmount=money(qty*rate),targetTax=money(targetAmount*tax/100);
      const taxable=money(last.taxable_amount+targetAmount-allocated.reduce((s,l)=>s+l.taxable_amount,0));
      const gstAmount=money(last.gst_amount+targetTax-allocated.reduce((s,l)=>s+l.gst_amount,0));
      db.prepare('UPDATE purchase_bill_items SET taxable_amount=?,gst_amount=?,total_amount=? WHERE id=?').run(taxable,gstAmount,money(taxable+gstAmount),last.id);
    }
    const totals=db.prepare('SELECT SUM(taxable_amount) amount,SUM(gst_amount) gst,SUM(total_amount) total FROM purchase_bill_items WHERE purchase_bill_id=?').get(r.lastInsertRowid);
    if(legacy && (money(legacy.amount)!==money(totals.amount) || money(legacy.gst_amount)!==money(totals.gst)))throw Error('Reconciled quantities, rates and GST must match the historical invoice totals');
    db.prepare('UPDATE purchase_bills SET amount=?,gst_amount=?,total_amount=?,freight_amount=? WHERE id=?').run(money(totals.amount),money(totals.gst),money(totals.total+freight),money(freight),r.lastInsertRowid);
    if(legacy)db.prepare("UPDATE purchase_bills SET reconciliation_version=2,request_key=?,reconciliation_note='Historical item allocation verified' WHERE id=?").run(key,legacy.id);
    const choices=eligibleDebits(db,vendor),debitIds=[...new Set(body.debit_ids||[])];let adjustment=0;
    for(const id of debitIds) {
      const d=choices.find(d=>d.id===+id);if(!d||!poIds.includes(d.vendor_po_id)||!(+d.amount>0))throw Error('Debit is not available for these POs');
      adjustment+=+d.amount;
      db.prepare('INSERT INTO purchase_bill_debits VALUES(?,?,?,?)').run(r.lastInsertRowid,d.id,d.amount,userId);
    }
    if(adjustment>money(totals.total+freight))throw Error('Debit adjustment exceeds invoice total');
    syncPaymentStatus(db,r.lastInsertRowid);
    return {id:r.lastInsertRowid,...financials(db,db.prepare('SELECT * FROM purchase_bills WHERE id=?').get(r.lastInsertRowid))};
  }).immediate();
}

function followup(db,query={}) {
  const all=db.prepare(`SELECT vp.*,v.name vendor_name,i.indent_number,i.site_name indent_site_name FROM vendor_pos vp
    LEFT JOIN vendors v ON v.id=vp.vendor_id LEFT JOIN indents i ON i.id=vp.indent_id WHERE COALESCE(vp.cancelled,0)=0 ORDER BY vp.id DESC`).all();
  let blocked_count=0;
  const rows=[];
  for(const po of all) {
    const state=poState(db,po.id);
    if(po.payment_block_status==='pending'){blocked_count++;continue;}
    if(!state.items.some(it=>it.billable_qty>0)&&!state.reconciliation_required)continue;
    if(query.vendor_id&&+query.vendor_id!==po.vendor_id)continue;
    if(query.from&&(!po.expected_receipt_date||po.expected_receipt_date<query.from))continue;
    if(query.to&&(!po.expected_receipt_date||po.expected_receipt_date>query.to))continue;
    const q=String(query.q||query.search||'').trim().toLowerCase();if(q&&!`${po.po_number} ${po.vendor_name} ${po.indent_number} ${po.indent_site_name}`.toLowerCase().includes(q))continue;
    rows.push({...po,items:state.items,pending_value:state.pending_value,display_total:state.pending_value,total_amount:state.pending_value,total_amount_drift:0,reconciliation_required:state.reconciliation_required,pending_qty:state.items.reduce((n,it)=>n+it.billable_qty,0)});
  }
  rows.sort((a,b)=>(a.expected_receipt_date || "9999").localeCompare(b.expected_receipt_date || "9999") || b.id-a.id);
  return {rows,blocked_count};
}
function syncPaymentStatus(db,id) {
  const bill=db.prepare('SELECT * FROM purchase_bills WHERE id=?').get(id);
  if(bill)db.prepare('UPDATE purchase_bills SET payment_status=? WHERE id=?').run(financials(db,bill).payment_status,id);
}
function poFinancials(db,poId) {
  let billed=0,paid=0;
  for(const bill of db.prepare('SELECT b.* FROM purchase_bills b JOIN purchase_bill_pos p ON p.purchase_bill_id=b.id WHERE p.vendor_po_id=?').all(poId)) {
    const amount=bill.reconciliation_version?db.prepare('SELECT COALESCE(SUM(total_amount),0) n FROM purchase_bill_items WHERE purchase_bill_id=? AND vendor_po_id=?').get(bill.id,poId).n:+bill.total_amount;
    const lineTotal=(+bill.total_amount||0)-(+bill.freight_amount||0);
    const allocated= bill.reconciliation_version && lineTotal>0 ? money(amount + (+bill.freight_amount||0)*amount/lineTotal) : amount;
    billed+=allocated;paid+=Math.min(financials(db,bill).paid_amount,financials(db,bill).net_payable)*(bill.total_amount?allocated/bill.total_amount:0);
  }
  return {billed_amount:money(billed),paid_amount:money(paid)};
}
module.exports={poFinancials,ensurePurchaseBilling,poState,financials,saveBill,followup,eligibleDebits,money,syncPaymentStatus};
