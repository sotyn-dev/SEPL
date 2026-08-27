#!/usr/bin/env node
/**
 * incident-forensics.js — read-only investigation of the audit_log.
 *
 * Built 2026-08-24 for the "account X deleted data" incident. Answers, from
 * evidence rather than memory:
 *    who deleted what, when, from which IP and device
 *    did anything act WITHOUT ever logging in (a forged / stolen token)
 *    was there a burst of deletions, and where did it start and stop
 *
 * READ-ONLY. It opens the database with readonly:true and never writes, so it
 * is safe to run on production while people are working. It changes nothing
 * and recovers nothing — use incident-restore.js for that.
 *
 * Usage (on the VPS):
 *    cd /root/erp
 *    node server/scripts/incident-forensics.js --user "durgesh" --since 2026-08-01
 *    node server/scripts/incident-forensics.js --since 2026-08-01 --out /root/incident.txt
 *
 * Options:
 *    --user   <text>   name / username / email fragment of the suspect. Comma-
 *                      separate several ("birender,durgesh,nitin") when you
 *                      suspect more than one account was used — a compromise
 *                      is rarely limited to a single victim. Omit to sweep
 *                      every user with no section-1/4 focus.
 *    --since  <date>   YYYY-MM-DD, default 30 days ago
 *    --until  <date>   YYYY-MM-DD, default today
 *    --db     <path>   database file, default ../../data/erp.db
 *    --out    <path>   also write the report to this file
 *    --full            print every row instead of capping long lists
 *
 * A NOTE ON WHAT THIS CAN AND CANNOT PROVE. audit_log records the request
 * (path, entity id, IP, user agent, status). For DELETEs it does NOT store the
 * row that was deleted — only the auto-middleware fields — so this report tells
 * you WHAT was deleted and BY WHOM, not what was in it. The contents come back
 * from the nightly backup via incident-restore.js.
 * Second limit: an attacker with database access could edit audit_log itself.
 * Cross-check anything decisive against the nightly backups, which live outside
 * the application.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

// ── args ───────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes(`--${name}`);

const DB_PATH = arg('db', path.join(__dirname, '..', '..', 'data', 'erp.db'));
const SUSPECT = arg('user');
const FULL = flag('full');
const CAP = FULL ? 100000 : 60;

const dayMs = 24 * 3600 * 1000;
const ymd = (d) => new Date(d).toISOString().slice(0, 10);
const SINCE = arg('since', ymd(Date.now() - 30 * dayMs));
const UNTIL = arg('until', ymd(Date.now()));
const FROM_TS = `${SINCE} 00:00:00`;
const TO_TS = `${UNTIL} 23:59:59`;

// audit_log.at is written by SQLite's CURRENT_TIMESTAMP, which is UTC. Everyone
// reading this report thinks in IST, so convert on the way out — an 02:10 UTC
// deletion is 07:40 IST, and getting that wrong makes an ordinary morning look
// like a midnight raid.
const ist = (utc) => {
  if (!utc) return '—';
  const t = Date.parse(String(utc).replace(' ', 'T') + 'Z');
  if (Number.isNaN(t)) return String(utc);
  return new Date(t + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19) + ' IST';
};
const istHour = (utc) => {
  const t = Date.parse(String(utc).replace(' ', 'T') + 'Z');
  return Number.isNaN(t) ? null : new Date(t + 5.5 * 3600 * 1000).getUTCHours();
};

// ── output ─────────────────────────────────────────────────────────────────
const lines = [];
const out = (s = '') => { lines.push(s); console.log(s); };
const h1 = (s) => { out(''); out('='.repeat(78)); out(s); out('='.repeat(78)); };
const h2 = (s) => { out(''); out('── ' + s + ' ' + '─'.repeat(Math.max(0, 74 - s.length))); };
const truncate = (s, n) => { s = s == null ? '' : String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const pad = (s, n) => truncate(s, n).padEnd(n);

if (!fs.existsSync(DB_PATH)) {
  console.error(`Database not found: ${DB_PATH}\nPass the right path with --db`);
  process.exit(1);
}
// Opened read-WRITE and then locked with `query_only`, deliberately.
// A readonly connection cannot rebuild the WAL index when the -shm file is
// stale, and SQLite then silently serves an OLD snapshot of the database —
// during testing that hid 3 rows that were plainly there. In an incident that
// failure mode is exactly backwards: the most recent activity, which is the
// activity you are investigating, is the part still sitting in the WAL and the
// part you would not see. So we let SQLite recover the WAL, then forbid this
// connection from writing at the engine level. Any write attempt errors out.
const db = new Database(DB_PATH, { fileMustExist: true });
db.pragma('query_only = ON');

const SUSPECT_TERMS = SUSPECT ? SUSPECT.split(',').map(s => s.trim()).filter(Boolean) : [];

h1(`ERP INCIDENT FORENSICS — ${SINCE} to ${UNTIL} (IST)`);
out(`database : ${DB_PATH}`);
out(`generated: ${ist(new Date().toISOString().slice(0, 19).replace('T', ' '))}`);
if (SUSPECT_TERMS.length) out(`suspects : matching ${SUSPECT_TERMS.map(s => `"${s}"`).join(', ')}`);

// ── 0. is the evidence itself intact? ──────────────────────────────────────
h2('0. Evidence integrity');
// Before blaming anybody, check the database is not simply broken. A corrupt
// INDEX makes rows vanish from some queries while they are still sitting in the
// table — the page looks empty, the data was never deleted, and no audit row
// exists because no delete ever happened. "Our data disappeared" has this as a
// real cause, and it is repaired with REINDEX, not with a restore.
{
  const ic = db.pragma('integrity_check').map(r => r.integrity_check);
  if (ic.length === 1 && ic[0] === 'ok') {
    out('integrity_check: ok — the database file itself is sound.');
  } else {
    out('!! integrity_check FAILED. The database file is damaged:');
    for (const l of ic.slice(0, 20)) for (const part of String(l).split('\n')) out(`     ${part}`);
    if (ic.length > 20) out(`     … ${ic.length - 20} more`);
    out('');
    out('   READ THIS BEFORE CONCLUDING ANYTHING WAS DELETED. A damaged index hides');
    out('   rows that are still present. Rows reported "missing from index" are NOT');
    out('   lost — rebuild with:   sqlite3 <db> "REINDEX;"   (stop the app first,');
    out('   take a copy first) and re-check whether the data is back.');
  }
  try {
    const fk = db.pragma('foreign_key_check');
    if (fk.length) {
      const byT = {};
      for (const r of fk) byT[r.table] = (byT[r.table] || 0) + 1;
      out(`?? ${fk.length} row(s) reference a parent record that no longer exists:`);
      for (const [t, n] of Object.entries(byT).slice(0, 15)) out(`     ${t.padEnd(32)} ${n}`);
      out('   Orphans like these are what a deleted PARENT row leaves behind — a good');
      out('   pointer to which tables actually lost data.');
    }
  } catch (_) { /* older SQLite / huge DB — not essential */ }
}
const totalAudit = db.prepare('SELECT COUNT(*) c FROM audit_log').get().c;
const span = db.prepare('SELECT MIN(at) lo, MAX(at) hi FROM audit_log').get();
out(`audit_log holds ${totalAudit.toLocaleString()} rows, from ${ist(span.lo)} to ${ist(span.hi)}`);
// A gap in the AUTOINCREMENT id sequence means rows were deleted from the log.
const idSpan = db.prepare('SELECT MIN(id) lo, MAX(id) hi, COUNT(*) c FROM audit_log').get();
const missingIds = (idSpan.hi - idSpan.lo + 1) - idSpan.c;
if (missingIds > 0) {
  out(`?? ${missingIds.toLocaleString()} id(s) missing between ${idSpan.lo} and ${idSpan.hi}.`);
  out(`   A gap is CONSISTENT WITH rows being deleted from the audit log — but it is`);
  out(`   not proof. SQLite also burns an id on an insert that fails or is rolled`);
  out(`   back, and the audit middleware swallows those failures by design. So a`);
  out(`   handful of scattered gaps is normal wear; a large CONTIGUOUS run of them`);
  out(`   sitting exactly around the time of interest is what should worry you.`);
  const t = db.prepare(
    `SELECT a.id + 1 AS gap_start, MIN(b.id) - 1 AS gap_end
       FROM audit_log a JOIN audit_log b ON b.id > a.id
      GROUP BY a.id HAVING gap_start <= gap_end
      ORDER BY (gap_end - gap_start) DESC LIMIT 5`
  ).all();
  for (const g of t) {
    const n = g.gap_end - g.gap_start + 1;
    const near = db.prepare('SELECT at FROM audit_log WHERE id < ? ORDER BY id DESC LIMIT 1').get(g.gap_start);
    out(`     gap of ${String(n).padStart(4)} id(s) at ${g.gap_start}..${g.gap_end}, around ${ist(near && near.at)}`);
  }
} else {
  out(`id sequence ${idSpan.lo}..${idSpan.hi} is unbroken — nothing was removed from the log.`);
}

// ── 1. who is the suspect ──────────────────────────────────────────────────
// A compromise is rarely limited to one victim, so --user takes a comma list
// and this checks every name against the same account, not just the first
// match — otherwise "birender,durgesh" would silently only ever report on
// whichever of them happens to exist under an exact-ish name.
let suspectIds = [];
if (SUSPECT_TERMS.length) {
  h2('1. Matching accounts');
  for (const term of SUSPECT_TERMS) {
    const like = `%${term}%`;
    const rows = db.prepare(
      `SELECT id, name, username, email, role, COALESCE(active,1) active,
              COALESCE(archived,0) archived, created_at
         FROM users
        WHERE name LIKE ? OR username LIKE ? OR email LIKE ?
        ORDER BY id`
    ).all(like, like, like);
    if (!rows.length) {
      out(`  "${term}" — no matching user. They may act under a different account`);
      out(`     name, or the account may already have been deleted — section 2`);
      out(`     sweeps every user regardless, so keep reading.`);
    }
    for (const r of rows) {
      out(`  "${term}" → id=${r.id}  ${r.name}  (username=${r.username || '—'}, ${r.email})`);
      out(`      role=${r.role}  active=${r.active}  archived=${r.archived}  created=${ist(r.created_at)}`);
      suspectIds.push(r.id);
    }
    // The audit log keeps the name even when the users row is gone.
    const ghosts = db.prepare(
      `SELECT DISTINCT user_id, user_name FROM audit_log
        WHERE user_name LIKE ? AND (user_id IS NULL OR user_id NOT IN (SELECT id FROM users))`
    ).all(like);
    for (const g of ghosts) {
      out(`  !! audit_log shows activity by "${g.user_name}" (user_id=${g.user_id}) but that`);
      out(`     account NO LONGER EXISTS in the users table.`);
      if (g.user_id != null) suspectIds.push(g.user_id);
    }
  }
  suspectIds = [...new Set(suspectIds)];
}

// ── 2. every deletion in the window ────────────────────────────────────────
h2(`2. All deletions between ${SINCE} and ${UNTIL}`);
const dels = db.prepare(
  `SELECT * FROM audit_log
    WHERE action IN ('DELETE','FORCE_DELETE') AND at BETWEEN ? AND ?
    ORDER BY at`
).all(FROM_TS, TO_TS);

// A DELETE that returned 4xx/5xx did NOT remove anything — separating these
// stops a wall of blocked attempts being read as destroyed data.
const ok = dels.filter(d => !d.status_code || (d.status_code >= 200 && d.status_code < 300));
const failed = dels.filter(d => d.status_code && (d.status_code < 200 || d.status_code >= 300));
out(`${dels.length} delete request(s): ${ok.length} succeeded, ${failed.length} were rejected.`);

if (ok.length) {
  out('');
  out('  BY USER:');
  const byUser = {};
  for (const d of ok) {
    const k = `${d.user_name || '(unattributed)'} [id=${d.user_id ?? '—'}]`;
    byUser[k] = (byUser[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byUser).sort((a, b) => b[1] - a[1])) {
    out(`    ${pad(k, 44)} ${String(v).padStart(5)} deleted`);
  }

  out('');
  out('  BY MODULE:');
  const byMod = {};
  for (const d of ok) byMod[d.entity_type || '(unknown)'] = (byMod[d.entity_type || '(unknown)'] || 0) + 1;
  for (const [k, v] of Object.entries(byMod).sort((a, b) => b[1] - a[1])) {
    out(`    ${pad(k, 44)} ${String(v).padStart(5)} deleted`);
  }

  out('');
  out('  BY DAY (IST):');
  const byDay = {};
  for (const d of ok) { const k = ist(d.at).slice(0, 10); byDay[k] = (byDay[k] || 0) + 1; }
  for (const [k, v] of Object.entries(byDay).sort()) {
    out(`    ${k}  ${String(v).padStart(5)}  ${'#'.repeat(Math.min(50, v))}`);
  }
}

if (failed.length) {
  out('');
  out(`  ${failed.length} REJECTED delete attempt(s) — nothing was removed by these, but a`);
  out(`  run of them is someone probing for what they are allowed to destroy:`);
  const byU = {};
  for (const d of failed) {
    const k = `${d.user_name || '(unattributed)'} [${d.status_code}]`;
    byU[k] = (byU[k] || 0) + 1;
  }
  for (const [k, v] of Object.entries(byU).sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    out(`    ${pad(k, 44)} ${String(v).padStart(5)} blocked`);
  }
}

// ── 3. deletion bursts ─────────────────────────────────────────────────────
h2('3. Bulk-deletion bursts (5+ deletions inside 5 minutes by one user)');
const bursts = [];
{
  const byUser = {};
  for (const d of ok) (byUser[d.user_id ?? 'null'] ||= []).push(d);
  for (const rows of Object.values(byUser)) {
    rows.sort((a, b) => String(a.at).localeCompare(String(b.at)));
    let i = 0;
    while (i < rows.length) {
      const start = Date.parse(String(rows[i].at).replace(' ', 'T') + 'Z');
      let j = i;
      while (j + 1 < rows.length &&
             Date.parse(String(rows[j + 1].at).replace(' ', 'T') + 'Z') - start <= 5 * 60 * 1000) j++;
      if (j - i + 1 >= 5) {
        bursts.push({ who: rows[i].user_name, id: rows[i].user_id, n: j - i + 1,
                      from: rows[i].at, to: rows[j].at, ip: rows[i].ip,
                      mods: [...new Set(rows.slice(i, j + 1).map(r => r.entity_type))] });
        i = j + 1;
      } else i++;
    }
  }
}
if (!bursts.length) out('None. Deletions in this window are spread out — no mass-wipe pattern.');
for (const b of bursts.sort((a, b) => b.n - a.n)) {
  out(`  ${b.n} deletions by ${b.who || '(unattributed)'} [id=${b.id ?? '—'}] from ip=${b.ip || '—'}`);
  out(`      ${ist(b.from)}  →  ${ist(b.to)}`);
  out(`      modules: ${b.mods.join(', ')}`);
}

// ── 4. each suspect account's own timeline ──────────────────────────────────
// Reported ONE ACCOUNT AT A TIME, not merged, so a burst of deletions on one
// name and normal traffic on another aren't blended into a single average
// that hides which specific account did the damage — that distinction is the
// whole question when the theory is "one person's login, several victims'
// accounts."
if (suspectIds.length) {
  for (const sid of suspectIds) {
    const who = db.prepare('SELECT name, username, email FROM users WHERE id=?').get(sid)
      || { name: (db.prepare("SELECT DISTINCT user_name FROM audit_log WHERE user_id=? LIMIT 1").get(sid) || {}).user_name || '(deleted account)' };
    h2(`4. Full activity for id=${sid} — ${who.name}`);
    const acts = db.prepare(
      `SELECT action, COUNT(*) c FROM audit_log
        WHERE user_id = ? AND at BETWEEN ? AND ?
        GROUP BY action ORDER BY c DESC`
    ).all(sid, FROM_TS, TO_TS);
    if (!acts.length) { out('  No recorded activity in this window.'); continue; }
    for (const a of acts) out(`    ${pad(a.action, 24)} ${String(a.c).padStart(6)}`);

    const rows = db.prepare(
      `SELECT * FROM audit_log
        WHERE user_id = ? AND at BETWEEN ? AND ?
        ORDER BY at DESC LIMIT ?`
    ).all(sid, FROM_TS, TO_TS, CAP);
    if (rows.length) {
      out('');
      out(`  Most recent ${rows.length} action(s)${FULL ? '' : ' — pass --full for all'}:`);
      out(`  ${pad('WHEN (IST)', 22)} ${pad('ACTION', 14)} ${pad('MODULE', 16)} ${pad('ID', 7)} ${pad('IP', 16)} CODE`);
      for (const r of rows) {
        out(`  ${pad(ist(r.at), 22)} ${pad(r.action, 14)} ${pad(r.entity_type, 16)} ${pad(r.entity_id, 7)} ${pad(r.ip, 16)} ${r.status_code ?? ''}`);
      }
    }
  }
}

// ── 5. logins, devices, locations ──────────────────────────────────────────
h2('5. Sign-in history and devices');
{
  const where = suspectIds.length ? `AND user_id IN (${suspectIds.map(() => '?').join(',')})` : '';
  const params = suspectIds.length ? [FROM_TS, TO_TS, ...suspectIds] : [FROM_TS, TO_TS];
  const logins = db.prepare(
    `SELECT user_id, user_name, ip, user_agent, COUNT(*) c, MIN(at) first, MAX(at) last
       FROM audit_log
      WHERE action='LOGIN' AND at BETWEEN ? AND ? ${where}
      GROUP BY user_id, ip, user_agent ORDER BY last DESC LIMIT ?`
  ).all(...params, CAP);
  if (!logins.length) out('No successful sign-ins recorded in this window.');
  for (const l of logins) {
    out(`  ${pad(l.user_name || '(?)', 22)} ip=${pad(l.ip, 16)} ${String(l.c).padStart(4)}x  last ${ist(l.last)}`);
    out(`      ${truncate(l.user_agent, 100)}`);
  }

  const fails = db.prepare(
    `SELECT entity_label, ip, COUNT(*) c, MAX(at) last FROM audit_log
      WHERE action='LOGIN_FAIL' AND at BETWEEN ? AND ?
      GROUP BY entity_label, ip HAVING c >= 3 ORDER BY c DESC LIMIT 30`
  ).all(FROM_TS, TO_TS);
  if (fails.length) {
    out('');
    out('  Repeated failed sign-ins (3+ from one IP — possible password guessing):');
    for (const f of fails) {
      out(`    ${pad(f.entity_label || '(?)', 28)} ip=${pad(f.ip, 16)} ${String(f.c).padStart(4)} failures, last ${ist(f.last)}`);
    }
  }
}

// ── 6. forged / stolen token indicators ────────────────────────────────────
h2('6. Signs of a forged or stolen token');
{
  // Anyone who CHANGED data but never successfully signed in did not get in
  // through the login page. Until 2026-08-24 the publicly-committed JWT secret
  // made minting such a token possible for anyone who could read the repo.
  const actors = db.prepare(
    `SELECT DISTINCT user_id, user_name FROM audit_log
      WHERE user_id IS NOT NULL AND at BETWEEN ? AND ?
        AND action NOT IN ('LOGIN','LOGIN_FAIL')`
  ).all(FROM_TS, TO_TS);
  let found = 0;
  for (const a of actors) {
    const everLoggedIn = db.prepare(
      `SELECT COUNT(*) c FROM audit_log WHERE user_id=? AND action='LOGIN'`
    ).get(a.user_id).c;
    if (everLoggedIn === 0) {
      found++;
      const n = db.prepare(
        `SELECT COUNT(*) c FROM audit_log WHERE user_id=? AND at BETWEEN ? AND ?
           AND action NOT IN ('LOGIN','LOGIN_FAIL')`
      ).get(a.user_id, FROM_TS, TO_TS).c;
      const ips = db.prepare(
        `SELECT DISTINCT ip FROM audit_log WHERE user_id=? AND ip IS NOT NULL LIMIT 8`
      ).all(a.user_id).map(r => r.ip);
      out(`  !! ${a.user_name || '(?)'} [id=${a.user_id}] made ${n} change(s) but has NEVER`);
      out(`     signed in through the login page. IPs: ${ips.join(', ') || '—'}`);
    }
  }

  // Acting from an IP that account has never logged in from.
  for (const uid of suspectIds) {
    const loginIps = new Set(db.prepare(
      `SELECT DISTINCT ip FROM audit_log WHERE user_id=? AND action='LOGIN' AND ip IS NOT NULL`
    ).all(uid).map(r => r.ip));
    if (!loginIps.size) continue;
    const actIps = db.prepare(
      `SELECT ip, COUNT(*) c, MIN(at) first, MAX(at) last FROM audit_log
        WHERE user_id=? AND ip IS NOT NULL AND action NOT IN ('LOGIN','LOGIN_FAIL')
        GROUP BY ip`
    ).all(uid);
    for (const a of actIps) {
      if (!loginIps.has(a.ip)) {
        found++;
        out(`  !! account id=${uid} made ${a.c} change(s) from ip=${a.ip}, an address it has`);
        out(`     never signed in from. ${ist(a.first)} → ${ist(a.last)}`);
      }
    }
  }
  if (!found) out('None found. Every account that changed data had signed in normally first.');
  out('');
  out('  Caveat: behind a shared office NAT or a mobile network, IPs move around on');
  out('  their own. Treat these as leads to confirm, not as proof on their own.');

  // If several NAMED SUSPECTS were passed in (--user "birender,durgesh,..."),
  // check whether their accounts share a login/activity fingerprint — the
  // direct version of "one attacker, several victims' accounts": the same
  // browser + same network showing up under different people's names.
  if (suspectIds.length > 1) {
    out('');
    out('  Shared fingerprint check across the named accounts:');
    const fp = (uid) => db.prepare(
      `SELECT DISTINCT ip, user_agent FROM audit_log WHERE user_id=? AND ip IS NOT NULL`
    ).all(uid).map(r => `${r.ip}::${(r.user_agent || '').slice(0, 60)}`);
    const byAcc = suspectIds.map(uid => ({ uid, fps: new Set(fp(uid)) }));
    let sharedAny = false;
    for (let i = 0; i < byAcc.length; i++) {
      for (let j = i + 1; j < byAcc.length; j++) {
        const shared = [...byAcc[i].fps].filter(x => byAcc[j].fps.has(x));
        if (shared.length) {
          sharedAny = true;
          const n1 = db.prepare('SELECT name FROM users WHERE id=?').get(byAcc[i].uid)?.name || byAcc[i].uid;
          const n2 = db.prepare('SELECT name FROM users WHERE id=?').get(byAcc[j].uid)?.name || byAcc[j].uid;
          out(`  !! "${n1}" and "${n2}" both acted from the SAME ip+device:`);
          for (const s of shared.slice(0, 5)) out(`       ${s.replace('::', '  —  ')}`);
        }
      }
    }
    if (!sharedAny) out('  No overlap — these accounts never acted from the same ip+device pairing.');
  }
}

// ── 7. out-of-hours ────────────────────────────────────────────────────────
h2('7. Changes made outside working hours (before 07:00 / after 22:00 IST)');
{
  const rows = db.prepare(
    `SELECT * FROM audit_log
      WHERE at BETWEEN ? AND ? AND action NOT IN ('LOGIN','LOGIN_FAIL')
      ORDER BY at DESC`
  ).all(FROM_TS, TO_TS).filter(r => { const h = istHour(r.at); return h !== null && (h < 7 || h >= 22); });
  if (!rows.length) out('None.');
  const byUser = {};
  for (const r of rows) {
    const k = `${r.user_name || '(unattributed)'} [id=${r.user_id ?? '—'}]`;
    (byUser[k] ||= []).push(r);
  }
  for (const [k, rs] of Object.entries(byUser).sort((a, b) => b[1].length - a[1].length)) {
    const delN = rs.filter(r => r.action === 'DELETE' || r.action === 'FORCE_DELETE').length;
    out(`  ${pad(k, 44)} ${String(rs.length).padStart(5)} change(s)${delN ? `, ${delN} of them DELETIONS` : ''}`);
    for (const r of rs.slice(0, FULL ? 100000 : 5)) {
      out(`      ${ist(r.at)}  ${pad(r.action, 12)} ${pad(r.entity_type, 16)} ip=${r.ip || '—'}`);
    }
    if (!FULL && rs.length > 5) out(`      … ${rs.length - 5} more (--full to list)`);
  }
}

// ── 8. changes to accounts and permissions ─────────────────────────────────
h2('8. Changes to accounts, roles and permissions');
{
  const rows = db.prepare(
    `SELECT * FROM audit_log
      WHERE at BETWEEN ? AND ?
        AND (path LIKE '/api/auth/users%' OR path LIKE '/api/auth/roles%'
             OR path LIKE '%/permissions%' OR action IN ('FORCE_DELETE','FORCE_LOGOUT'))
      ORDER BY at DESC LIMIT ?`
  ).all(FROM_TS, TO_TS, CAP);
  if (!rows.length) out('None.');
  for (const r of rows) {
    out(`  ${pad(ist(r.at), 22)} ${pad(r.user_name || '(?)', 20)} ${pad(r.action, 13)} ${r.method} ${truncate(r.path, 40)}  [${r.status_code}]`);
    if (r.body_summary) out(`      ${truncate(r.body_summary, 150)}`);
  }
}

// ── 9. what to do next ─────────────────────────────────────────────────────
h1('WHAT THIS DOES NOT TELL YOU');
out('• The CONTENTS of deleted rows are not in the audit log — only that a delete');
out('  happened, to which module and which record id. Recover the contents from');
out('  the nightly backup:  node server/scripts/incident-restore.js --help');
out('• Anyone with direct database or server access could have edited audit_log.');
out('  Section 0 checks the id sequence for gaps, which catches casual tampering');
out('  but not a careful rewrite. Compare against the nightly backups.');
out('• IP addresses identify a network, not a person.');

if (arg('out')) {
  fs.writeFileSync(arg('out'), lines.join('\n'), 'utf8');
  console.log(`\nReport written to ${arg('out')}`);
}
db.close();
