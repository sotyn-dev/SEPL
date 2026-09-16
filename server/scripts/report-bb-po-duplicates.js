// READ-ONLY report: Business Book records that duplicate an Order to Planning PO.
//
// mam 2026-09-11: "u create new records as per order to planning even i told u
// if match order to planning to business book only fetch from order to planning
// po". A client PO that already lives in Order to Planning must stay attached to
// its ONE Business Book lead — not spawn extra leads (e.g. one per PO line,
// "CPL/SEPL/10/25-26 L7").
//
// This script only READS. It opens the database read-only and never runs the
// schema migrations, so it cannot change anything. Use its output to decide the
// clean-up (move links to the right lead first — deleting a Business Book row
// also deletes its purchase orders).
//
//   cd /root/erp && node server/scripts/report-bb-po-duplicates.js
//   (ERP_DB_PATH=/path/to/copy.db to point it at a copy)
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });

// "CPL/SEPL/10/25-26 L7" and " cpl/sepl/10/25-26" are the same client PO.
const basePo = (v) => String(v || '')
  .replace(/\s+L\s*\d+\s*$/i, '')
  .replace(/\s+/g, '')
  .toLowerCase();

const leads = db.prepare(`SELECT id, lead_no, client_name, company_name, project_name, po_number,
    sale_amount_without_gst, created_at, created_by, substr(COALESCE(remarks,''), 1, 90) AS remarks
  FROM business_book`).all();
const pos = db.prepare(`SELECT id, po_number, business_book_id, total_amount, created_at FROM purchase_orders`).all();
const leadById = new Map(leads.map((l) => [l.id, l]));

// Every table column that points at business_book(id), read from the schema.
const refs = [];
for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
  for (const fk of db.prepare(`PRAGMA foreign_key_list("${name}")`).all()) {
    if (fk.table === 'business_book') refs.push({ table: name, column: fk.from });
  }
}
const linkedTo = (leadId) => refs
  .map(({ table, column }) => {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM "${table}" WHERE "${column}" = ?`).get(leadId).c;
      return n ? `${table}.${column}=${n}` : null;
    } catch (_) { return null; }
  })
  .filter(Boolean)
  .join(', ') || 'nothing linked';

// Group Business Book leads and Order to Planning POs by base PO number.
const groups = new Map();
const bucket = (key) => {
  if (!groups.has(key)) groups.set(key, { leads: [], pos: [] });
  return groups.get(key);
};
for (const l of leads) { const k = basePo(l.po_number); if (k) bucket(k).leads.push(l); }
for (const p of pos) { const k = basePo(p.po_number); if (k) bucket(k).pos.push(p); }

let suspects = 0;
console.log(`Database: ${DB_PATH}`);
console.log(`Business Book leads: ${leads.length} · Order to Planning POs: ${pos.length}\n`);
for (const [key, g] of [...groups.entries()].sort()) {
  const opLeadIds = new Set(g.pos.map((p) => p.business_book_id).filter(Boolean));
  const extra = g.leads.filter((l) => !opLeadIds.has(l.id));
  // Suspicious: the PO is in Order to Planning and a lead OTHER than the one it
  // is attached to carries the same PO, or several leads share one PO.
  const flagged = (g.pos.length && extra.length) || g.leads.length > 1;
  if (!flagged) continue;
  suspects += 1;
  console.log(`PO ${key}`);
  for (const p of g.pos) {
    const owner = p.business_book_id ? leadById.get(p.business_book_id) : null;
    console.log(`  Order to Planning PO #${p.id} "${p.po_number}" Rs ${p.total_amount || 0} → lead ${owner ? owner.lead_no : '(not linked)'}`);
  }
  for (const l of g.leads) {
    const tag = opLeadIds.has(l.id) ? 'KEEP (linked from Order to Planning)' : 'CHECK (duplicate?)';
    console.log(`  ${tag} ${l.lead_no} id=${l.id} "${l.po_number}" · ${l.company_name || l.client_name} · Rs ${l.sale_amount_without_gst || 0} · created ${l.created_at}`);
    if (l.remarks) console.log(`      remarks: ${l.remarks}`);
    console.log(`      linked: ${linkedTo(l.id)}`);
  }
  console.log('');
}
console.log(suspects ? `${suspects} PO number(s) need a look.` : 'No duplicate Business Book leads found for any PO.');
db.close();
