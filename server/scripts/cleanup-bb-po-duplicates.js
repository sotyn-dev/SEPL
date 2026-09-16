// Remove Business Book records that duplicate a PO already in Order to Planning.
//
// mam 2026-09-11: "delete which new records from order toplanning" — extra
// one-line leads such as "CONSERN PHARMA - Cable Tray … PO CPL/SEPL/10/25-26"
// that were created for a client PO whose real lead is the one Order to
// Planning uses. One client PO = one lead (see lib/orderPoMatch.js).
//
// SAFE BY DESIGN
//   • Dry run by default — lists candidates, changes nothing.
//   • Deletes ONLY the ids you pass with --apply --ids=…, and only if every one
//     of them is still DELETABLE in a fresh dry run (otherwise nothing changes).
//   • Never touches the lead Order to Planning uses, and never a PO group where
//     the Order to Planning PO has no lead (nobody to keep).
//   • A candidate is BLOCKED if anything real hangs off it (indents, DPR, POs,
//     BOQ lines, bills, receivables, a planning row pointing at a PO, …).
//     Only the lead itself plus the empty planning / site rows the Business
//     Book form auto-creates are removed.
//   • Before deleting: a full database copy in data/backups/ and a JSON file of
//     every deleted row.
//
//   cd /root/erp && node server/scripts/cleanup-bb-po-duplicates.js
//   cd /root/erp && node server/scripts/cleanup-bb-po-duplicates.js --apply --ids=12,15
//   (ERP_DB_PATH=/path/to/copy.db to run against a copy)
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { basePo } = require('../lib/orderPoMatch');

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const idsArg = (args.find((a) => a.startsWith('--ids=')) || '').slice(6);
const IDS = idsArg ? idsArg.split(',').map((s) => parseInt(s, 10)).filter(Number.isFinite) : [];

if (APPLY && IDS.length === 0) {
  console.error('--apply needs --ids=… (copy them from the dry run). Nothing changed.');
  process.exit(2);
}

const db = new Database(DB_PATH, { readonly: !APPLY, fileMustExist: true });

// ── Who points at what ────────────────────────────────────────────────
// Declared foreign keys PLUS columns that follow the naming convention without
// a declared key (e.g. drawing tracker site_id).
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map((t) => t.name);
const refsTo = { business_book: [], order_planning: [], sites: [] };
const byName = { business_book_id: 'business_book', planning_id: 'order_planning', order_planning_id: 'order_planning', site_id: 'sites' };
for (const t of tables) {
  const seen = new Set();
  for (const fk of db.prepare(`PRAGMA foreign_key_list("${t}")`).all()) {
    if (refsTo[fk.table] && t !== fk.table) { refsTo[fk.table].push({ table: t, column: fk.from }); seen.add(fk.from); }
  }
  for (const c of db.prepare(`PRAGMA table_info("${t}")`).all()) {
    const target = byName[c.name];
    if (target && t !== target && !seen.has(c.name)) refsTo[target].push({ table: t, column: c.name });
  }
}
const countRefs = (target, id, skip = []) => refsTo[target]
  .filter((r) => !skip.includes(r.table))
  .map((r) => {
    try {
      const n = db.prepare(`SELECT COUNT(*) c FROM "${r.table}" WHERE "${r.column}" = ?`).get(id).c;
      return n ? `${r.table}.${r.column}=${n}` : null;
    } catch (_) { return null; }
  })
  .filter(Boolean);

// What would deleting this lead take with it, and is anything real attached?
function inspect(leadId) {
  const blockers = [];
  // Links to the lead other than its own planning / site rows.
  blockers.push(...countRefs('business_book', leadId, ['order_planning', 'sites']));
  const plans = db.prepare('SELECT id, po_id FROM order_planning WHERE business_book_id = ?').all(leadId);
  for (const p of plans) {
    if (p.po_id) blockers.push(`order_planning #${p.id} points at PO #${p.po_id}`);
    blockers.push(...countRefs('order_planning', p.id).map((s) => `order_planning #${p.id} ← ${s}`));
  }
  const siteRows = db.prepare('SELECT id FROM sites WHERE business_book_id = ?').all(leadId);
  for (const s of siteRows) {
    blockers.push(...countRefs('sites', s.id).map((x) => `site #${s.id} ← ${x}`));
  }
  return { blockers, planIds: plans.map((p) => p.id), siteIds: siteRows.map((s) => s.id) };
}

// ── Find candidates ───────────────────────────────────────────────────
const leads = db.prepare(`SELECT id, lead_no, client_name, company_name, project_name, po_number,
    sale_amount_without_gst, created_at, remarks FROM business_book`).all();
const pos = db.prepare('SELECT id, po_number, business_book_id FROM purchase_orders').all();
const leadById = new Map(leads.map((l) => [l.id, l]));
const groups = new Map();
const bucket = (k) => { if (!groups.has(k)) groups.set(k, { leads: [], pos: [] }); return groups.get(k); };
for (const l of leads) { const k = basePo(l.po_number); if (k) bucket(k).leads.push(l); }
for (const p of pos) { const k = basePo(p.po_number); if (k) bucket(k).pos.push(p); }

const candidates = [];     // { lead, keep: [lead_no], plan }
const untouched = [];      // messages
for (const [key, g] of [...groups.entries()].sort()) {
  if (!g.pos.length) {
    if (g.leads.length > 1) untouched.push(`PO ${key}: ${g.leads.length} leads but no Order to Planning PO — not touched (${g.leads.map((l) => l.lead_no).join(', ')})`);
    continue;
  }
  const keepIds = new Set(g.pos.map((p) => p.business_book_id).filter((id) => id && leadById.has(id)));
  if (!keepIds.size) {
    if (g.leads.length) untouched.push(`PO ${key}: in Order to Planning but not linked to any lead — not touched (${g.leads.map((l) => l.lead_no).join(', ')})`);
    continue;
  }
  for (const l of g.leads) {
    if (keepIds.has(l.id)) continue;
    candidates.push({ lead: l, keep: [...keepIds].map((id) => leadById.get(id).lead_no), ...inspect(l.id) });
  }
}

const deletable = candidates.filter((c) => c.blockers.length === 0);
const blocked = candidates.filter((c) => c.blockers.length > 0);
const money = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;

console.log(`Database: ${DB_PATH}${APPLY ? '' : '   (DRY RUN — nothing will change)'}`);
console.log(`Leads ${leads.length} · Order to Planning POs ${pos.length} · duplicate leads found ${candidates.length}\n`);
if (deletable.length) {
  console.log(`DELETABLE (${deletable.length}) — only the lead + its empty planning/site rows would go:`);
  for (const c of deletable) {
    const l = c.lead;
    console.log(`  id=${l.id} ${l.lead_no} · PO "${l.po_number}" · ${money(l.sale_amount_without_gst)} · keeps ${c.keep.join(', ')}`);
    console.log(`      ${l.project_name || l.company_name || l.client_name || ''}`);
    console.log(`      created ${l.created_at}${l.remarks ? ` · remarks: ${String(l.remarks).slice(0, 80)}` : ''}`);
  }
  console.log('');
}
if (blocked.length) {
  console.log(`BLOCKED (${blocked.length}) — real work is attached; move it to the kept lead first, or leave it:`);
  for (const c of blocked) {
    const l = c.lead;
    console.log(`  id=${l.id} ${l.lead_no} · PO "${l.po_number}" · keeps ${c.keep.join(', ')}`);
    console.log(`      ${c.blockers.join('; ')}`);
  }
  console.log('');
}
for (const m of untouched) console.log(m);
if (untouched.length) console.log('');

if (!APPLY) {
  if (deletable.length) {
    console.log('To delete, after checking the list above:');
    console.log(`  node server/scripts/cleanup-bb-po-duplicates.js --apply --ids=${deletable.map((c) => c.lead.id).join(',')}`);
  } else {
    console.log('Nothing to delete.');
  }
  db.close();
  process.exit(0);
}

// ── Apply ─────────────────────────────────────────────────────────────
const deletableById = new Map(deletable.map((c) => [c.lead.id, c]));
const notAllowed = IDS.filter((id) => !deletableById.has(id));
if (notAllowed.length) {
  console.error(`ABORT: id(s) ${notAllowed.join(', ')} are not in the DELETABLE list above. Nothing changed.`);
  db.close();
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDir = path.join(path.dirname(DB_PATH), 'backups');
fs.mkdirSync(backupDir, { recursive: true });
const backupFile = path.join(backupDir, `before-bb-po-cleanup-${stamp}.db`);
db.exec(`VACUUM INTO '${backupFile.replace(/'/g, "''")}'`);

const deletedLog = [];
db.transaction(() => {
  for (const id of IDS) {
    const c = deletableById.get(id);
    const lead = db.prepare('SELECT * FROM business_book WHERE id = ?').get(id);
    const planRows = db.prepare('SELECT * FROM order_planning WHERE business_book_id = ?').all(id);
    const siteRows = db.prepare('SELECT * FROM sites WHERE business_book_id = ?').all(id);
    db.prepare('DELETE FROM sites WHERE business_book_id = ?').run(id);
    db.prepare('DELETE FROM order_planning WHERE business_book_id = ?').run(id);
    db.prepare('DELETE FROM business_book WHERE id = ?').run(id);
    deletedLog.push({ kept_lead: c.keep, business_book: lead, order_planning: planRows, sites: siteRows });
  }
})();

const logFile = path.join(backupDir, `bb-po-cleanup-deleted-${stamp}.json`);
fs.writeFileSync(logFile, JSON.stringify(deletedLog, null, 2));
console.log(`Deleted ${IDS.length} duplicate lead(s): ${deletedLog.map((d) => d.business_book.lead_no).join(', ')}`);
console.log(`Backup of the database before the change: ${backupFile}`);
console.log(`Every deleted row: ${logFile}`);
db.close();
