// Organizational Management — company structure, independent of any specific
// person. A department can exist empty; a designation can be defined before
// anyone holds it. HR (hrSchema.js) references this by FK, it doesn't own it —
// same OM/PA split most enterprise HRIS suites (SAP, Workday) keep as separate
// modules. Extracted from schema.js (was inline; plan: keep-confirmation-
// status-separate-elegant-beacon) — moved verbatim, same execution order,
// same non-fatal try/catch idiom the rest of schema.js already uses for
// self-contained modules (see fireNocSchema.js / rentalToolsSchema.js).
//
// MUST run BEFORE hrSchema.js — employee_timeline.department_id/designation_id
// carry FKs to org_departments/org_designations created here.
//
// Design: plans/moonlit-puzzling-dawn.md (Phase B) +
// plans/keep-confirmation-status-separate-elegant-beacon.md (grades, seeds).
// Built to be migration-proof:
//   · CREATE TABLE / INDEX IF NOT EXISTS → re-running boot is a no-op.
//   · NO CHECK constraints on the status columns — a CHECK can only be relaxed
//     by a full copy-table rebuild (see the indents.status pain in schema.js);
//     statuses are validated in the route layer instead.
//   · FKs only on STRUCTURAL ids (tree parent, junction). Display-only /
//     snapshot refs (head, reports-to, filled-by) are plain INTEGER — no FK —
//     so they never raise "FOREIGN KEY constraint failed" when an unrelated
//     employee/user is removed.
//   · Fully reversible: DROP these tables and the DB is byte-for-byte as
//     before (nothing outside hrSchema.js's employee_timeline references them).

const { SPEC_DEPARTMENTS } = require('./orgTemplate');

// Ensure each of the spec's 11 departments (HR-3) exists as a LEAF child of
// its function node. ADDITIVE, per-item, idempotent — checks each of the 11
// by (parent, name) rather than gating on a row count, so it delivers
// regardless of what else is in the tree and never touches/removes anything
// an admin has added. Extracted as its own function so both the automatic
// boot seed below and the on-demand "Load Template" reset (orgStructure.js)
// share one implementation.
function ensureSpecDepartments(db) {
  // Scoped to DIRECT CHILDREN OF THE ROOT ONLY — not "any department with a
  // parent". One of the 11 spec leaves ("Finance") shares its name with its
  // own function node ("Finance"); a broader lookup would resolve "Finance"
  // to whichever row sorts last once the leaf exists too, silently nesting
  // a THIRD "Finance" under the leaf on the very next boot. Root-scoping
  // removes the ambiguity outright — there is exactly one node per name
  // one level below the single root.
  const root = db.prepare('SELECT id FROM org_departments WHERE parent_id IS NULL ORDER BY id LIMIT 1').get();
  const fnNodes = root ? db.prepare('SELECT id, name FROM org_departments WHERE parent_id=?').all(root.id) : [];
  const byName = Object.fromEntries(fnNodes.map((n) => [n.name, n.id]));
  const parentsOk = Object.keys(SPEC_DEPARTMENTS).every((n) => byName[n]);
  if (!parentsOk) {
    console.error('[schema] org_departments spec-dept seed skipped — a function node this depends on is missing/renamed');
    return 0;
  }
  const exists = db.prepare('SELECT 1 FROM org_departments WHERE parent_id=? AND LOWER(name)=LOWER(?)');
  const insLeaf = db.prepare('INSERT INTO org_departments (parent_id, name, sort_order) VALUES (?,?,?)');
  let added = 0;
  Object.entries(SPEC_DEPARTMENTS).forEach(([parentName, children]) => {
    children.forEach((childName, i) => {
      if (!exists.get(byName[parentName], childName)) { insLeaf.run(byName[parentName], childName, i); added++; }
    });
  });
  if (added) console.log(`[schema] org_departments: added ${added} missing spec departments (HR-3)`);
  return added;
}

function runOrgStructureMigrations(db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS org_departments (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        parent_id        INTEGER REFERENCES org_departments(id),   -- NULL = root
        name             TEXT NOT NULL,
        alias            TEXT,                                      -- common/site name, e.g. "(Sales & Tendering)"
        head_employee_id INTEGER,                                  -- DISPLAY ONLY (soft ref, no FK; grants nothing)
        sort_order       INTEGER DEFAULT 0,
        active           INTEGER DEFAULT 1,
        created_at       DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(parent_id, name)
      );

      CREATE TABLE IF NOT EXISTS org_designations (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        name       TEXT NOT NULL UNIQUE,        -- full title, e.g. "Managing Director"
        tag_name   TEXT,                        -- short chip/code, e.g. "MD"
        singleton  INTEGER DEFAULT 0,           -- 1 = HARD cap: only ONE active holder (MD/COO/CFO)
        status     TEXT DEFAULT 'present',      -- present | not_wanted | planned  (validated in routes)
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      -- Partial UNIQUE: tag_name is unique only when present (most titles omit it).
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_desig_tag
        ON org_designations(tag_name) WHERE tag_name IS NOT NULL;

      -- Grade/Band master (Mandatory Field Spec HR-6: "L1..L8 or A..G" — two
      -- schemes in one rule, so the scheme is DATA, not code). Seeded L1-L8
      -- below; CRUD is a third Org Structure tab (Departments · Designations ·
      -- Grades), read for the employee form via GET /api/hr/grades.
      CREATE TABLE IF NOT EXISTS org_grades (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        code       TEXT NOT NULL UNIQUE,
        label      TEXT,
        sort_order INTEGER DEFAULT 0,
        active     INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS org_department_designations (
        department_id  INTEGER NOT NULL REFERENCES org_departments(id)  ON DELETE CASCADE,
        designation_id INTEGER NOT NULL REFERENCES org_designations(id) ON DELETE CASCADE,
        PRIMARY KEY (department_id, designation_id)
      );
      -- Reverse lookup (depts-of-a-title); the forward direction is the PK itself.
      CREATE INDEX IF NOT EXISTS idx_org_dd_designation
        ON org_department_designations(designation_id);

      CREATE TABLE IF NOT EXISTS org_openings (
        id                     INTEGER PRIMARY KEY AUTOINCREMENT,
        department_id          INTEGER REFERENCES org_departments(id),
        designation_id         INTEGER REFERENCES org_designations(id),
        headcount              INTEGER DEFAULT 1,
        reports_to_employee_id INTEGER,               -- soft ref (no FK)
        status                 TEXT DEFAULT 'open',   -- open | filled | on_hold | closed (validated in routes)
        filled_employee_id     INTEGER,               -- soft ref (no FK)
        notes                  TEXT,
        created_at             DATETIME DEFAULT CURRENT_TIMESTAMP,
        closed_at              DATETIME
      );
      CREATE INDEX IF NOT EXISTS idx_org_openings_status ON org_openings(status);
    `);
  } catch (e) { console.error('[schema] org_structure tables create failed:', e.message); }

  // Case-INSENSITIVE uniqueness for the designation catalog (dme 2026-07-28:
  // "md | MD | Md | Managing Director | managing director — all compared in
  // duplication?"). The inline UNIQUE(name) and the tag_name index are BINARY,
  // so "MD"/"md" and "Managing Director"/"managing director" slipped through as
  // separate rows. Add LOWER() functional unique indexes — same guarded idiom as
  // idx_users_username in schema.js: only swap in the stricter guard when the
  // data has no case-collisions, so boot never crashes and a real duplicate
  // can't leave the catalog with weaker (binary-only) protection. Routes
  // already .trim(). MUST run BEFORE the live-data designation seed below —
  // the seed's own case-insensitive de-dupe depends on this having already
  // hardened (or reported) the current state.
  try {
    const dup = db.prepare("SELECT 1 FROM org_designations GROUP BY LOWER(name) HAVING COUNT(*)>1 LIMIT 1").get();
    if (!dup) db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_desig_name_ci ON org_designations(LOWER(name))');
    else console.error('[schema] org_designations.name CI-uniqueness NOT hardened — case-variant titles exist; de-dupe them then restart.');
  } catch (e) { console.error('[schema] org_desig name CI index error:', e.message); }
  try {
    const dup = db.prepare("SELECT 1 FROM org_designations WHERE tag_name IS NOT NULL AND tag_name<>'' GROUP BY LOWER(tag_name) HAVING COUNT(*)>1 LIMIT 1").get();
    if (!dup) db.exec("CREATE UNIQUE INDEX IF NOT EXISTS uniq_org_desig_tag_ci ON org_designations(LOWER(tag_name)) WHERE tag_name IS NOT NULL");
    else console.error('[schema] org_designations.tag_name CI-uniqueness NOT hardened — case-variant tags exist; de-dupe them then restart.');
  } catch (e) { console.error('[schema] org_desig tag CI index error:', e.message); }

  // Org Structure — SKELETON seed, guarded on empty: company root + the 5
  // function nodes, nothing else. Everything is editable in the UI afterward
  // (rename the root, restructure, add sub-departments + the designation
  // catalog), so a different org reconfigures freely — the seed is a starting
  // point, not a lock-in. Runs once (guarded on org_departments being empty).
  try {
    if (db.prepare('SELECT COUNT(*) c FROM org_departments').get().c === 0) {
      const rootId = db.prepare('INSERT INTO org_departments (name, sort_order) VALUES (?, 0)')
        .run('Secured Engineers Pvt Ltd').lastInsertRowid;
      const insFn = db.prepare('INSERT INTO org_departments (parent_id, name, sort_order) VALUES (?,?,?)');
      ['Business', 'Operation', 'Finance', 'HR & Admin', 'System & Process'].forEach((n, i) => insFn.run(rootId, n, i));
      console.log('[schema] org_structure skeleton seeded (root + 5 function nodes)');
    }
  } catch (e) { console.error('[schema] org_structure seed failed:', e.message); }

  // Mandatory Field Spec HR-3 (dept master, 11 values) — ensure each exists as
  // a LEAF child of its function node above. The dropdown offers leaves only;
  // the tree survives intact for the org chart. All 11 map cleanly:
  //   Business → Sales, Marketing, CRM
  //   Operation → Operations, Purchase, Design, Service
  //   Finance → Finance
  //   HR & Admin → HR, Admin
  //   System & Process → IT
  // ADDITIVE, per-item, idempotent — NOT a count-based gate. A count gate
  // (e.g. "only seed if the tree is exactly the 6-row skeleton") silently
  // stops delivering once ANYTHING else is added to the tree, which this dev
  // DB already demonstrates: it carries a hand-added "Procurement" node from
  // earlier Org Structure testing, so a count===6 guard would never fire here
  // and HR-3 would go unmet on the very DB this ships to. Checking each of
  // the 11 by (parent, name) instead guarantees the actual invariant HR-3
  // needs — "these 11 departments exist" — regardless of what else is present,
  // and never touches/removes anything an admin has since added.
  try {
    ensureSpecDepartments(db);
  } catch (e) { console.error('[schema] org_departments spec-dept seed failed:', e.message); }

  // Mandatory Field Spec HR-2 (Role Master) — REMOVED the boot-time seed that
  // used to pull every LIVE designation string off `employees` into the
  // catalog (dme 2026-08-03). It actively conflicted with the "Load Template"
  // reset (orgStructure.js POST /template/load): that reset deliberately
  // removes messy/typo'd titles like "Staffs", but this seed ran on EVERY
  // boot and silently re-added them the moment the server restarted —
  // observed live: a clean 26-row catalog grew back to 29 after two restarts,
  // with "Senior Staff"/"Staff"/"Staffs" reappearing. The curated template
  // (db/orgTemplate.js) is now HR-2's actual mechanism. Employees whose
  // current free-text designation isn't in the catalog get matched via the
  // picker's inline-add (client, once the Employee form is wired in a later
  // phase) — a deliberate, one-time, human-reviewed add, not an automatic
  // one that can reintroduce data quality problems on a restart.

  // org_grades — Mandatory Field Spec HR-6. Seeded L1-L8 (the spec's first-
  // listed scheme); A-G is a 7-value remap, not a relabel, left for the Org
  // Structure "Grades" tab to switch later if management wants it instead.
  try {
    if (db.prepare('SELECT COUNT(*) c FROM org_grades').get().c === 0) {
      const insGrade = db.prepare('INSERT INTO org_grades (code, label, sort_order) VALUES (?,?,?)');
      for (let i = 1; i <= 8; i++) insGrade.run(`L${i}`, `L${i}`, i);
      console.log('[schema] org_grades seeded (L1-L8)');
    }
  } catch (e) { console.error('[schema] org_grades seed failed:', e.message); }
}

module.exports = { runOrgStructureMigrations, ensureSpecDepartments };
