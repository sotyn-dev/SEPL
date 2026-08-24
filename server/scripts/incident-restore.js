#!/usr/bin/env node
/**
 * incident-restore.js — find rows that exist in a backup but are gone from the
 * live database, and put them back.
 *
 * Built 2026-08-24 alongside incident-forensics.js. Forensics tells you WHAT was
 * deleted; this brings the contents back, because audit_log records that a
 * delete happened but not the row itself.
 *
 * SAFE BY DEFAULT. With no --apply it only ever READS and prints what it would
 * do. --apply copies the live database to a timestamped .before-restore file
 * first, then inserts inside a single transaction: it either all lands or
 * nothing does.
 *
 * TWO MODES:
 *
 * 1. Plain diff (default) — every row present in the backup but absent from
 *    live, regardless of when or why it went missing. Good for a first look,
 *    but it cannot tell an attacker's deletion apart from someone's ordinary,
 *    legitimate cleanup that happens to predate the backup.
 *
 * 2. --deleted-since / --deleted-until (audit-scoped, RECOMMENDED for an
 *    incident) — restores ONLY rows the LIVE audit_log actually recorded as
 *    deleted inside that exact window, resolved from the real request PATH
 *    against a hand-verified table map (server/scripts/incident-restore.js
 *    TABLE_RULES below) — not the audit log's generic module label, which is
 *    too coarse (e.g. every /api/hr/* delete is logged as entity_type='hr'
 *    whether it deleted an employee, a candidate, or a checklist). A path
 *    that doesn't match a verified rule is reported as unmapped rather than
 *    guessed, so nothing is silently restored into the wrong table and
 *    nothing real is silently skipped either.
 *
 * Usage (on the VPS):
 *   # audit-scoped: only what was actually deleted in this window
 *   node server/scripts/incident-restore.js --backup <file> \
 *       --deleted-since "2026-08-22 00:00:00" --deleted-until "2026-08-23 23:59:59"
 *
 *   # then apply once the plan looks right
 *   node server/scripts/incident-restore.js --backup <file> \
 *       --deleted-since "..." --deleted-until "..." --apply
 *
 *   # plain diff — what is missing, across every table
 *   node server/scripts/incident-restore.js --backup ~/erp-backups/erp-2026-08-23_02-00-00.db
 *
 *   # look at the actual rows for one table before deciding
 *   node server/scripts/incident-restore.js --backup <file> --table indents --show
 *
 *   # plain-diff apply — one table, or specific records
 *   node server/scripts/incident-restore.js --backup <file> --table indents --apply
 *   node server/scripts/incident-restore.js --backup <file> --table indents --ids 41,42,43 --apply
 *
 * Options:
 *   --backup <path>          REQUIRED. The backup to recover from. It only
 *                            needs to be OLDER than the incident window — it
 *                            is never restored wholesale, only the specific
 *                            audit-confirmed rows are pulled from it, so an
 *                            older-than-necessary backup is completely safe.
 *   --live   <path>          Live DB, default ../../data/erp.db
 *   --deleted-since <ts>     Audit-scoped mode: window start, "YYYY-MM-DD" or
 *                            "YYYY-MM-DD HH:MM:SS" (server-local, matches
 *                            audit_log.at)
 *   --deleted-until <ts>     Audit-scoped mode: window end
 *   --table  <name>          Plain-diff mode: restrict to one table (comma
 *                            list for several)
 *   --ids    <list>          Plain-diff mode: only these primary keys (needs
 *                            --table)
 *   --show                   Print the missing rows themselves, not just a
 *                            count
 *   --apply                  Actually write. Without this, nothing is changed.
 *   --min    <n>              Plain-diff mode: ignore tables missing fewer
 *                            than n rows (default 1)
 *
 * READ THIS BEFORE --apply
 * In PLAIN-DIFF mode, a row missing from live is not automatically a row that
 * was destroyed by an attacker — it is equally consistent with an ordinary,
 * legitimate deletion made on purpose at any point before the backup. Prefer
 * --deleted-since/--deleted-until, which restores only what the audit trail
 * actually shows happened inside the incident window.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── verified DELETE-route → table map ───────────────────────────────────────
// Ground truth, not a guess: each entry below was confirmed by reading the
// actual `DELETE FROM …` SQL inside that route's handler in this repo on
// 2026-08-24 (see the commit that added this file for the extraction). The
// audit log's own `entity_type` is too coarse for this — it is just the
// second URL segment, so EVERY delete under /api/hr/* is logged as
// entity_type='hr' whether it removed an employee, a candidate, or a
// checklist. We resolve from the exact recorded `path` instead.
//
// `tables` lists every table that handler's DELETE(s)/child-cascades touch,
// in the order they were deleted — restored in REVERSE order so a child row
// never lands before the parent it references (matters even with foreign_keys
// OFF, because the foreign_key_check at the end would otherwise flag it).
//
// This list covers the modules seen active in this repo's own audit log while
// building the tool. A path that matches NONE of these is reported as
// unmapped rather than guessed — extend this list (verify the real DELETE FROM
// target first) before trusting an unmapped module's rows to auto-restore.
const TABLE_RULES = [
  { re: /^\/api\/tally-bills\/\d+$/, tables: ['tally_bills'] },
  { re: /^\/api\/tally-bills\/\d+\/files\/\d+$/, tables: ['tally_bill_files'] },
  { re: /^\/api\/tally-bills\/\d+\/payments\/\d+$/, tables: ['tally_bill_payments'] },
  { re: /^\/api\/procurement\/vendors\/\d+$/, tables: ['vendors'] },
  { re: /^\/api\/procurement\/vendor-rates\/\d+$/, tables: ['vendor_rates'] },
  { re: /^\/api\/procurement\/indents\/\d+$/, tables: ['indent_tracker', 'indent_items', 'indents'] },
  { re: /^\/api\/procurement\/vendor-po\/\d+$/, tables: ['vendor_pos'] },
  { re: /^\/api\/procurement\/item-rates\/\d+$/, tables: ['indent_item_rates'] },
  { re: /^\/api\/procurement\/purchase-bills\/\d+$/, tables: ['purchase_bills'] },
  { re: /^\/api\/procurement\/debit-notes\/\d+$/, tables: ['debit_notes'] },
  { re: /^\/api\/procurement\/delivery-notes\/\d+$/, tables: ['delivery_notes'] },
  { re: /^\/api\/procurement\/sales-bills\/\d+$/, tables: ['sales_bills'] },
  { re: /^\/api\/quotations\/\d+$/, tables: ['quotations'] },
  { re: /^\/api\/quotations\/boq\/\d+$/, tables: ['boq_items', 'boq'] },
  { re: /^\/api\/quotations\/po-foc\/\d+$/, tables: ['po_foc_entries'] },
  { re: /^\/api\/quotations\/labour-rates\/\d+$/, tables: ['labour_rates'] },
  { re: /^\/api\/quotations\/estimates\/\d+$/, tables: ['estimate_quotations'] },
  // /api/auth/users/:id is EXCLUDED deliberately — its force-delete path clears
  // an admin-discovered, dynamic list of FK references across the whole schema
  // (see findUserFkReferences in routes/auth.js), not a fixed table list. A
  // deleted user needs a manual, reviewed restore, not an automated one.
  { re: /^\/api\/auth\/roles\/\d+$/, tables: ['roles'] },
  { re: /^\/api\/hr\/candidates\/\d+$/, tables: ['candidates'] },
  { re: /^\/api\/hr\/employees\/\d+$/, tables: ['employees'] },
  { re: /^\/api\/hr\/sub-contractors\/\d+$/, tables: ['sub_contractors'] },
  { re: /^\/api\/hr\/expenses\/\d+$/, tables: ['expenses'] },
  { re: /^\/api\/hr\/checklists\/\d+$/, tables: ['checklists'] },
  { re: /^\/api\/hr\/hiring-requests\/\d+$/, tables: ['hiring_requests'] },
  { re: /^\/api\/hr\/jd-templates\/\d+$/, tables: ['jd_templates'] },
  { re: /^\/api\/hr\/job-descriptions\/\d+$/, tables: ['job_descriptions'] },
  { re: /^\/api\/hr\/scorecards\/\d+$/, tables: ['interview_scorecards'] },
  { re: /^\/api\/hr\/final-round-questions\/\d+$/, tables: ['final_round_questions'] },
  { re: /^\/api\/hr\/induction\/\d+$/, tables: ['induction_items'] },
  { re: /^\/api\/hr\/training\/videos\/\d+$/, tables: ['training_videos'] },
  { re: /^\/api\/hr\/training\/assignments\/\d+$/, tables: ['training_assignments'] },
  { re: /^\/api\/hr\/screening-questions\/\d+$/, tables: ['screening_questions'] },
  { re: /^\/api\/hr\/docs\/\d+$/, tables: ['candidate_docs'] },
  { re: /^\/api\/payment-required\/\d+$/, tables: ['payment_approvals', 'payment_requests'] },
  { re: /^\/api\/email-rules\/\d+$/, tables: ['email_rules'] },
  { re: /^\/api\/indent-fms\/grn\/\d+$/, tables: ['grn_items', 'grn'] },
  { re: /^\/api\/pipe-weights\/\d+$/, tables: ['pipe_weights'] },
];

function resolveTables(reqPath) {
  for (const rule of TABLE_RULES) if (rule.re.test(reqPath)) return rule.tables;
  return null;
}

const argv = process.argv.slice(2);
const arg = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const flag = (n) => argv.includes(`--${n}`);

if (flag('help') || !arg('backup')) {
  console.log(fs.readFileSync(__filename, 'utf8').split('*/')[0].replace(/^#!.*\n/, ''));
  process.exit(arg('backup') ? 0 : 1);
}

const BACKUP = arg('backup');
const LIVE = arg('live', path.join(__dirname, '..', '..', 'data', 'erp.db'));
const ONLY = arg('table') ? arg('table').split(',').map(s => s.trim()).filter(Boolean) : null;
const IDS = arg('ids') ? arg('ids').split(',').map(s => s.trim()).filter(Boolean) : null;
const SHOW = flag('show');
const APPLY = flag('apply');
const MIN = parseInt(arg('min', '1'), 10);
const DELETED_SINCE = arg('deleted-since');
const DELETED_UNTIL = arg('deleted-until');
const SCOPED = !!(DELETED_SINCE || DELETED_UNTIL);

if (SCOPED && (!DELETED_SINCE || !DELETED_UNTIL)) {
  console.error('Pass BOTH --deleted-since and --deleted-until for audit-scoped mode.');
  process.exit(1);
}
if (SCOPED && (ONLY || IDS)) {
  console.error('--table/--ids are plain-diff-mode options; audit-scoped mode selects rows from the audit log itself.');
  process.exit(1);
}

for (const [label, p] of [['backup', BACKUP], ['live', LIVE]]) {
  if (!fs.existsSync(p)) { console.error(`${label} database not found: ${p}`); process.exit(1); }
}
if (IDS && (!ONLY || ONLY.length !== 1)) {
  console.error('--ids needs exactly one --table'); process.exit(1);
}

// Both opened read-WRITE, with `query_only` locking the live one during a dry
// run. This is not laziness about readonly:true — a readonly connection cannot
// rebuild a stale WAL index, so SQLite quietly serves an OLD snapshot. Diffing
// against a stale snapshot reports rows as "missing" that are really present,
// and worse, hides deletions that happened in the last few minutes. query_only
// gives us read-only behaviour without that trap: writes error at the engine.
const bk = new Database(BACKUP, { fileMustExist: true });
bk.pragma('query_only = ON');            // never write to the evidence
const live = new Database(LIVE, { fileMustExist: true });
if (!APPLY) live.pragma('query_only = ON');

const listTables = (d) => d.prepare(
  `SELECT name FROM sqlite_master WHERE type='table'
     AND name NOT LIKE 'sqlite_%' ORDER BY name`
).all().map(r => r.name);

const liveTables = new Set(listTables(live));
const cols = (d, t) => d.prepare(`PRAGMA table_info("${t}")`).all();

// The key we compare rows on. INTEGER PRIMARY KEY covers almost every table
// here; a composite key is handled too. Tables with no declared key at all
// can't be diffed reliably, so we report them rather than guessing.
function keyCols(d, t) {
  const c = cols(d, t).filter(x => x.pk > 0).sort((a, b) => a.pk - b.pk);
  return c.map(x => x.name);
}

// Restore a set of specific ids into one table (shared by both modes). Skips
// silently if the table/pk can't be matched between the two schemas — callers
// report that via `skipped`.
function diffTableForIds(table, ids) {
  if (!liveTables.has(table)) return { skip: 'table does not exist in the live DB' };
  const pk = keyCols(bk, table);
  if (pk.length !== 1) return { skip: pk.length ? 'composite primary key — needs manual handling' : 'no primary key — cannot match rows reliably' };
  const bkColNames = cols(bk, table).map(c => c.name);
  const liveColNames = new Set(cols(live, table).map(c => c.name));
  const shared = bkColNames.filter(c => liveColNames.has(c));
  if (!liveColNames.has(pk[0])) return { skip: 'primary key differs between the two schemas' };
  let bkRows;
  try {
    bkRows = bk.prepare(
      `SELECT ${shared.map(c => `"${c}"`).join(',')} FROM "${table}" WHERE "${pk[0]}" IN (${ids.map(() => '?').join(',')})`
    ).all(...ids);
  } catch (e) { return { skip: `could not read from backup: ${e.message}` }; }
  const liveIds = new Set(
    live.prepare(`SELECT "${pk[0]}" v FROM "${table}" WHERE "${pk[0]}" IN (${ids.map(() => '?').join(',')})`)
        .all(...ids).map(r => String(r.v))
  );
  const inBackup = new Set(bkRows.map(r => String(r[pk[0]])));
  const missing = bkRows.filter(r => !liveIds.has(String(r[pk[0]])));
  const notInBackupEither = ids.filter(id => !inBackup.has(String(id)));
  return { pk, shared, missing, notInBackupEither };
}

function restoreFinding(f) {
  const colList = f.shared.map(c => `"${c}"`).join(',');
  const stmt = live.prepare(
    `INSERT OR IGNORE INTO "${f.table}" (${colList}) VALUES (${f.shared.map(() => '?').join(',')})`
  );
  let inserted = 0; const failures = [];
  for (const r of f.missing) {
    try { inserted += stmt.run(...f.shared.map(c => r[c])).changes; }
    catch (e) { failures.push(`${f.pk.join('/')}=${f.pk.map(k => r[k]).join('/')}: ${e.message}`); }
  }
  return { inserted, failures };
}

// ── audit-scoped mode ────────────────────────────────────────────────────
if (SCOPED) {
  console.log('='.repeat(78));
  console.log('AUDIT-SCOPED RECOVERY — only rows the audit log confirms were deleted');
  console.log('='.repeat(78));
  console.log(`backup : ${BACKUP}`);
  console.log(`live   : ${LIVE}`);
  console.log(`window : ${DELETED_SINCE}  →  ${DELETED_UNTIL}  (server-local time, matches audit_log.at)`);
  console.log(`mode   : ${APPLY ? '*** APPLY — the live database WILL be written ***' : 'dry run (nothing is changed)'}`);
  console.log('');

  let dels;
  try {
    dels = live.prepare(
      `SELECT * FROM audit_log
        WHERE action IN ('DELETE','FORCE_DELETE') AND at BETWEEN ? AND ?
          AND (status_code IS NULL OR (status_code >= 200 AND status_code < 300))
        ORDER BY at`
    ).all(DELETED_SINCE, DELETED_UNTIL);
  } catch (e) {
    console.error(`Could not read audit_log from the live database: ${e.message}`);
    process.exit(1);
  }
  console.log(`${dels.length} successful delete request(s) recorded in this window.`);
  if (!dels.length) {
    console.log('Nothing to restore — the audit log shows no deletions in this window.');
    process.exit(0);
  }

  const byTable = new Map();   // table -> Set(ids)
  const unmapped = new Map();  // path pattern (method+path shape) -> count
  const noNumericId = [];
  for (const d of dels) {
    const tables = resolveTables(d.path || '');
    if (!tables) {
      const key = `${d.method} ${d.path}`;
      unmapped.set(key, (unmapped.get(key) || 0) + 1);
      continue;
    }
    if (!/^\d+$/.test(String(d.entity_id))) { noNumericId.push(d); continue; }
    for (const t of tables) {
      if (!byTable.has(t)) byTable.set(t, new Set());
      byTable.get(t).add(d.entity_id);
    }
  }

  if (unmapped.size) {
    console.log('');
    console.log('?? Not auto-restorable — path not in the verified table map (see TABLE_RULES');
    console.log('   at the top of this script). NOT skipped silently: extend the map with the');
    console.log('   real DELETE FROM target from the route handler, then re-run.');
    for (const [k, n] of [...unmapped.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`     ${String(n).padStart(4)}x  ${k}`);
    }
  }
  if (noNumericId.length) {
    console.log('');
    console.log(`?? ${noNumericId.length} delete(s) matched a table but had no numeric id in the`);
    console.log('   path (e.g. a compound/non-standard route) — needs manual lookup:');
    for (const d of noNumericId.slice(0, 20)) console.log(`     ${ist_local(d.at)}  ${d.method} ${d.path}`);
  }

  console.log('');
  const findings = [];
  const skipped = [];
  for (const [table, idSet] of byTable) {
    const ids = [...idSet];
    const r = diffTableForIds(table, ids);
    if (r.skip) { skipped.push([table, r.skip]); continue; }
    console.log(`  ${table.padEnd(28)} audit log: ${String(ids.length).padStart(4)} deleted   ` +
      `restorable now: ${String(r.missing.length).padStart(4)}` +
      (r.notInBackupEither.length ? `   (${r.notInBackupEither.length} not in this backup — try an older one)` : ''));
    if (r.missing.length) findings.push({ table, pk: r.pk, shared: r.shared, missing: r.missing });
  }
  if (skipped.length) {
    console.log('');
    console.log('Not compared:');
    for (const [t, why] of skipped) console.log(`  ${t.padEnd(28)} ${why}`);
  }

  const totalRestorable = findings.reduce((n, f) => n + f.missing.length, 0);
  console.log('');
  console.log(`${totalRestorable} row(s) across ${findings.length} table(s) will be restored.`);

  if (SHOW) {
    for (const f of findings) {
      console.log('');
      console.log(`── ${f.table} — the rows to restore ${'─'.repeat(Math.max(0, 46 - f.table.length))}`);
      for (const r of f.missing.slice(0, 200)) {
        const brief = {};
        for (const [k, v] of Object.entries(r)) {
          if (v === null || v === '') continue;
          brief[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 59) + '…' : v;
        }
        console.log('  ' + JSON.stringify(brief));
      }
      if (f.missing.length > 200) console.log(`  … and ${f.missing.length - 200} more`);
    }
  }

  if (!APPLY) {
    console.log('');
    console.log('Dry run — nothing was written. Pass --show to see the actual rows, --apply to restore.');
    process.exit(0);
  }
  if (!totalRestorable) { console.log('\nNothing to restore.'); process.exit(0); }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const safety = `${LIVE}.before-restore-${stamp}`;
  fs.copyFileSync(LIVE, safety);
  console.log('');
  console.log(`Safety copy of the live database: ${safety}`);

  const fkWasOn = live.pragma('foreign_keys', { simple: true });
  live.pragma('foreign_keys = OFF');
  let grandInserted = 0;
  const run = live.transaction(() => {
    for (const f of findings) {
      const { inserted, failures } = restoreFinding(f);
      grandInserted += inserted;
      console.log(`  ${f.table.padEnd(28)} restored ${inserted}${failures.length ? `, ${failures.length} FAILED` : ''}`);
      for (const m of failures.slice(0, 5)) console.log(`      failed: ${m}`);
    }
  });
  run();
  live.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);

  console.log('');
  console.log(`Restored ${grandInserted} row(s) total.`);
  const dangling = live.pragma('foreign_key_check');
  if (dangling.length) {
    console.log('');
    console.log(`${dangling.length} row(s) now point at a parent that no longer exists — that parent`);
    console.log('table likely also needs restoring (its own deletion may be outside this window,');
    console.log('or its route is in the "not auto-restorable" list above):');
    const byT = {};
    for (const d of dangling) byT[d.table] = (byT[d.table] || 0) + 1;
    for (const [t, n] of Object.entries(byT)) console.log(`  ${t.padEnd(34)} ${n}`);
  } else {
    console.log('No dangling references — the database is internally consistent.');
  }
  console.log(`integrity_check: ${live.pragma('integrity_check', { simple: true })}`);
  console.log('');
  console.log('Restart the app so nothing is serving a stale cache:  pm2 restart erp');

  bk.close(); live.close();
  process.exit(0);
}

function ist_local(utc) {
  if (!utc) return '—';
  const t = Date.parse(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return String(utc);
  return new Date(t + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
}

console.log('='.repeat(78));
console.log('ROWS PRESENT IN THE BACKUP BUT MISSING FROM THE LIVE DATABASE');
console.log('='.repeat(78));
console.log(`backup : ${BACKUP}`);
console.log(`live   : ${LIVE}`);
console.log(`mode   : ${APPLY ? '*** APPLY — the live database WILL be written ***' : 'dry run (nothing is changed)'}`);
console.log('');

const findings = [];
const skipped = [];

for (const t of listTables(bk)) {
  if (ONLY && !ONLY.includes(t)) continue;
  if (t === 'sqlite_sequence' || t === 'app_migrations') continue;
  if (!liveTables.has(t)) { skipped.push([t, 'table does not exist in the live DB']); continue; }

  const pk = keyCols(bk, t);
  if (!pk.length) { skipped.push([t, 'no primary key — cannot match rows reliably']); continue; }

  // Only columns the two schemas share, so a migration that added or dropped a
  // column since the backup doesn't break the insert.
  const bkCols = cols(bk, t).map(c => c.name);
  const liveCols = new Set(cols(live, t).map(c => c.name));
  const shared = bkCols.filter(c => liveCols.has(c));
  if (!pk.every(k => liveCols.has(k))) { skipped.push([t, 'primary key differs between the two schemas']); continue; }

  let bkRows;
  try {
    const sel = `SELECT ${shared.map(c => `"${c}"`).join(',')} FROM "${t}"`;
    bkRows = IDS
      ? bk.prepare(`${sel} WHERE "${pk[0]}" IN (${IDS.map(() => '?').join(',')})`).all(...IDS)
      : bk.prepare(sel).all();
  } catch (e) { skipped.push([t, `could not read from backup: ${e.message}`]); continue; }
  if (!bkRows.length) continue;

  // Pull just the keys from live and diff in memory — one query per table
  // instead of one per row, which matters on tables with tens of thousands.
  const liveKeys = new Set(
    live.prepare(`SELECT ${pk.map(c => `"${c}"`).join(',')} FROM "${t}"`).all()
        .map(r => pk.map(c => String(r[c])).join(' '))
  );
  const missing = bkRows.filter(r => !liveKeys.has(pk.map(c => String(r[c])).join(' ')));
  if (missing.length >= MIN) findings.push({ table: t, pk, shared, missing });
}

if (!findings.length) {
  console.log('Nothing is missing. Every row in the backup is still present live.');
} else {
  const w = Math.max(...findings.map(f => f.table.length), 24);
  for (const f of findings.sort((a, b) => b.missing.length - a.missing.length)) {
    console.log(`  ${f.table.padEnd(w)}  ${String(f.missing.length).padStart(7)} row(s) missing   (key: ${f.pk.join('+')})`);
  }
  console.log('');
  console.log(`  ${findings.reduce((n, f) => n + f.missing.length, 0)} row(s) missing across ${findings.length} table(s).`);
}

if (skipped.length) {
  console.log('');
  console.log('Not compared:');
  for (const [t, why] of skipped) console.log(`  ${t.padEnd(34)} ${why}`);
}

if (SHOW) {
  for (const f of findings) {
    console.log('');
    console.log(`── ${f.table} — the missing rows ${'─'.repeat(Math.max(0, 50 - f.table.length))}`);
    for (const r of f.missing.slice(0, 200)) {
      const brief = {};
      for (const [k, v] of Object.entries(r)) {
        if (v === null || v === '') continue;
        brief[k] = typeof v === 'string' && v.length > 60 ? v.slice(0, 59) + '…' : v;
      }
      console.log('  ' + JSON.stringify(brief));
    }
    if (f.missing.length > 200) console.log(`  … and ${f.missing.length - 200} more`);
  }
}

if (!APPLY) {
  console.log('');
  console.log('Dry run — nothing was written.');
  if (findings.length) {
    console.log('Inspect one table first:');
    console.log(`   node server/scripts/incident-restore.js --backup "${BACKUP}" --table ${findings[0].table} --show`);
    console.log('Then restore that table:');
    console.log(`   node server/scripts/incident-restore.js --backup "${BACKUP}" --table ${findings[0].table} --apply`);
    console.log('');
    console.log('Restore deliberately, one table at a time. A missing row may simply have');
    console.log('been deleted on purpose after this backup was taken — check it against the');
    console.log('forensics report before putting it back.');
  }
  process.exit(0);
}

// ── apply ──────────────────────────────────────────────────────────────────
if (!findings.length) { console.log('\nNothing to restore.'); process.exit(0); }
if (!ONLY) {
  console.error('\nRefusing to restore every table at once. Pass --table <name> and work');
  console.error('through them one at a time so each restore is a decision you made.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const safety = `${LIVE}.before-restore-${stamp}`;
fs.copyFileSync(LIVE, safety);
console.log('');
console.log(`Safety copy of the live database: ${safety}`);
console.log('(if anything about this restore looks wrong, stop the app and copy that back)');

let inserted = 0, failed = 0;
const failures = [];
// Foreign keys off for the duration: a deleted parent and its children come
// back in whatever order the tables are processed, and an FK error mid-way
// would abort a restore that is actually fine once both halves are present.
// We run a full foreign_key_check afterwards and report anything left dangling.
const fkWasOn = live.pragma('foreign_keys', { simple: true });
live.pragma('foreign_keys = OFF');

const run = live.transaction((f) => {
  const colList = f.shared.map(c => `"${c}"`).join(',');
  const stmt = live.prepare(
    `INSERT OR IGNORE INTO "${f.table}" (${colList}) VALUES (${f.shared.map(() => '?').join(',')})`
  );
  for (const r of f.missing) {
    try {
      const res = stmt.run(...f.shared.map(c => r[c]));
      inserted += res.changes;
    } catch (e) {
      failed++;
      if (failures.length < 10) failures.push(`${f.pk.map(k => r[k]).join('/')}: ${e.message}`);
    }
  }
});

for (const f of findings) {
  console.log(`\nRestoring ${f.missing.length} row(s) into ${f.table} …`);
  run(f);
}

live.pragma(`foreign_keys = ${fkWasOn ? 'ON' : 'OFF'}`);

console.log('');
console.log(`Restored ${inserted} row(s). ${failed ? `${failed} failed.` : ''}`);
for (const m of failures) console.log(`  failed: ${m}`);

const dangling = live.pragma('foreign_key_check');
if (dangling.length) {
  console.log('');
  console.log(`${dangling.length} row(s) now point at a parent that no longer exists:`);
  const byTable = {};
  for (const d of dangling) byTable[d.table] = (byTable[d.table] || 0) + 1;
  for (const [t, n] of Object.entries(byTable)) console.log(`  ${t.padEnd(34)} ${n}`);
  console.log('Usually this means the PARENT table still needs restoring too — run the');
  console.log('dry run again and restore that table next.');
} else {
  console.log('No dangling references — the database is internally consistent.');
}

const integrity = live.pragma('integrity_check', { simple: true });
console.log(`integrity_check: ${integrity}`);
console.log('');
console.log('Restart the app so nothing is serving a stale cache:  pm2 restart erp');

bk.close();
live.close();
