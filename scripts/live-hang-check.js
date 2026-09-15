#!/usr/bin/env node
/**
 * live-hang-check.js — READ-ONLY live-ERP hang diagnostic (2026-08-21)
 *
 * Answers, against the REAL production database, the three questions the
 * local audit could not:
 *   1. Which of the hot-path indexes actually exist on prod?
 *   2. How big are the tables that make the quadratic queries quadratic?
 *   3. What does SQLite's planner say it will do for the three worst queries?
 *
 * SAFETY — this script cannot slow the ERP down:
 *   • It opens the database READ-ONLY, on its own connection. In WAL mode a
 *     reader never blocks the writer, and it is a SEPARATE process, so it does
 *     NOT touch the Node event loop the ERP runs on.
 *   • It runs COUNT(*) and EXPLAIN QUERY PLAN only. EXPLAIN does not execute
 *     the query — the 150-second statements are never actually run.
 *   • It writes nothing, anywhere.
 *
 * Usage on the VPS:
 *   cd /root/erp && node scripts/live-hang-check.js
 */

const path = require('path');

let Database;
try {
  Database = require('better-sqlite3');
} catch (e) {
  console.error('Could not load better-sqlite3. Run this from the ERP root: cd /root/erp && node scripts/live-hang-check.js');
  process.exit(1);
}

const DB_PATH = process.env.ERP_DB_PATH || path.join(__dirname, '..', 'data', 'erp.db');
let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (e) {
  console.error('Could not open ' + DB_PATH + ' read-only: ' + e.message);
  process.exit(1);
}

const line = (c) => console.log(c.repeat(74));
const has = (name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?").get(name);
const tableExists = (t) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(t);
const count = (t) => {
  if (!tableExists(t)) return null;
  try { return db.prepare('SELECT COUNT(*) c FROM "' + t + '"').get().c; } catch (e) { return null; }
};

console.log('');
line('=');
console.log('LIVE ERP HANG CHECK — read-only, safe to run at any time');
console.log('db: ' + DB_PATH);
try {
  const fs = require('fs');
  const st = fs.statSync(DB_PATH);
  console.log('size: ' + (st.size / 1048576).toFixed(1) + ' MB   modified: ' + st.mtime.toISOString());
} catch (e) { /* ignore */ }
console.log('journal_mode: ' + db.pragma('journal_mode', { simple: true }));
line('=');

/* ── 1. Hot-path indexes ─────────────────────────────────────────────── */
console.log('');
console.log('[1] HOT-PATH INDEXES  (missing ones are what make queries quadratic)');
console.log('');
const INDEXES = [
  ['idx_vpitems_indentitem', 'vendor_po_items(indent_item_id)', 'Procurement mount — worst offender'],
  ['idx_indent_tracker_ind', 'indent_tracker(indent_id, stage_date)', 'Indent FMS mount'],
  ['idx_dnotes_vpo', 'delivery_notes(vendor_po_id)', 'PO pipeline'],
  ['idx_pbills_vpo', 'purchase_bills(vendor_po_id)', 'PO pipeline'],
  ['idx_grn_vpo', 'grn(vendor_po_id)', 'PO pipeline'],
  ['idx_dnotes_debit_vpo', 'debit_notes(vendor_po_id)', 'PO pipeline'],
  ['idx_pms_assignee', 'pms_tasks(assigned_to, status)', 'PMS Tasks + scorecards'],
  ['idx_dprmat_dpr', 'dpr_material(dpr_id)', 'CMD dashboard KPIs'],
  ['idx_expenses_created', 'expenses(created_at DESC)', 'Expenses list'],
  ['idx_notif_user', 'notifications(user_id, id DESC)', 'Notification bell (60s poll)'],
  ['idx_scoreentries_uw', 'score_entries(user_id, week_start)', 'Scorecard / Weekly Score'],
];
let missing = 0;
for (const [name, cols, why] of INDEXES) {
  const ok = has(name);
  if (!ok) missing++;
  console.log('  ' + (ok ? '[ok]     ' : '[MISSING]') + ' ' + cols.padEnd(42) + why);
}
console.log('');
console.log('  => ' + missing + ' of ' + INDEXES.length + ' missing on live.');

/* ── 2. Table sizes ──────────────────────────────────────────────────── */
console.log('');
console.log('[2] TABLE SIZES  (these decide how bad the missing indexes actually are)');
console.log('');
const TABLES = [
  'indent_items', 'vendor_po_items', 'indents', 'indent_tracker', 'vendor_pos',
  'delivery_notes', 'purchase_bills', 'grn', 'debit_notes', 'stock_movements',
  'pms_tasks', 'delegations', 'item_master', 'po_foc_entries', 'attendance',
  'location_tracking', 'audit_log', 'dpr', 'dpr_material', 'dpr_work_items',
  'notifications', 'score_entries', 'expenses', 'cheques', 'payment_requests',
  'receivables', 'tally_bills', 'arap_entries', 'business_book', 'sites',
];
const sizes = {};
for (const t of TABLES) {
  const c = count(t);
  sizes[t] = c;
  if (c === null) { console.log('  ' + '(no table)'.padStart(12) + '  ' + t); continue; }
  const flag = c > 50000 ? '  <-- LARGE' : c > 10000 ? '  <-- growing' : '';
  console.log('  ' + String(c).padStart(12) + '  ' + t + flag);
}

/* ── 3. The quadratic pairs ──────────────────────────────────────────── */
console.log('');
console.log('[3] QUADRATIC RISK  (rows x rows the server must compare, per page load)');
console.log('');
const pair = (label, a, b, idx) => {
  if (sizes[a] == null || sizes[b] == null) return;
  const prod = sizes[a] * sizes[b];
  const guarded = has(idx);
  console.log('  ' + label);
  console.log('      ' + a + ' (' + sizes[a] + ') x ' + b + ' (' + sizes[b] + ') = ' +
    prod.toLocaleString() + ' row comparisons');
  console.log('      index ' + idx + ': ' + (guarded ? 'PRESENT — cost avoided' : 'MISSING — this cost is REAL today'));
  console.log('');
};
pair('Procurement, on mount  (GET /procurement/indents)', 'indent_items', 'vendor_po_items', 'idx_vpitems_indentitem');
pair('Indent FMS, on mount   (GET /indent-fms/tracker)', 'indents', 'indent_tracker', 'idx_indent_tracker_ind');
pair('Procurement pipeline   (GET /procurement/po-pipeline)', 'vendor_pos', 'delivery_notes', 'idx_dnotes_vpo');

/* ── 4. Planner verdicts — EXPLAIN only, nothing is executed ─────────── */
console.log('[4] PLANNER VERDICT  (EXPLAIN only — these queries are NOT run)');
console.log('');
const plans = [
  ['GET /procurement/indents — po_qty subquery',
    'SELECT ii.id, COALESCE((SELECT SUM(vpi.quantity) FROM vendor_po_items vpi ' +
    'JOIN vendor_pos vp ON vp.id=vpi.vendor_po_id WHERE vpi.indent_item_id = ii.id ' +
    'AND COALESCE(vp.cancelled,0)=0),0) q FROM indent_items ii ORDER BY ii.id'],
  ['GET /indent-fms/tracker — stages subquery',
    "SELECT i.id, (SELECT GROUP_CONCAT(it.stage || ':' || it.stage_date, '|') " +
    'FROM indent_tracker it WHERE it.indent_id=i.id) s FROM indents i ORDER BY i.created_at DESC'],
  ['GET /pms-tasks — full list',
    'SELECT p.* FROM pms_tasks p LEFT JOIN users tu ON tu.id=p.assigned_to ' +
    "ORDER BY CASE p.status WHEN 'rejected' THEN 0 ELSE 3 END, p.created_at DESC"],
];
for (const [label, sql] of plans) {
  console.log('  ' + label);
  try {
    let inSubquery = false;
    for (const r of db.prepare('EXPLAIN QUERY PLAN ' + sql).all()) {
      if (/SUBQUERY/i.test(r.detail)) inSubquery = true;
      // Only a full scan INSIDE a correlated subquery is the quadratic case.
      // A scan of the outer table is normal and expected — flagging it would
      // cry wolf on every single query.
      const quadratic = inSubquery && /SCAN (?!.*USING (COVERING )?INDEX)/.test(r.detail);
      console.log('      ' + (quadratic ? '!! ' : '   ') + r.detail);
    }
  } catch (e) {
    console.log('      (could not plan: ' + e.message + ')');
  }
  console.log('');
}
console.log('  "!!" = a full table scan INSIDE a correlated subquery, i.e. one');
console.log('  repeated for every row. That is the quadratic case and the whole');
console.log('  cause of the multi-minute freezes. A plain "SCAN" on the outer');
console.log('  table (no "!!") is normal and not a problem.');

line('=');
console.log('Done. Nothing was written and no slow query was executed.');
line('=');
console.log('');
db.close();
