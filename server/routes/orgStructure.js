const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

// Org Structure (Phase B) — department tree + flat designation catalog + M:N
// mapping + openings. Tables + skeleton seed live in db/schema.js; this module
// is pure CRUD. Gated by requirePermission('org_structure', …); mutations are
// auto-audited by the global auditMiddleware (index.js). Admin bypasses gates.
const router = express.Router();
router.use(authMiddleware);

const M = 'org_structure';
const DESIG_STATUS = ['present', 'not_wanted', 'planned'];
const OPENING_STATUS = ['open', 'filled', 'on_hold', 'closed'];

// Count of CURRENT active holders of a designation (open timeline row + active
// employee). Used by the singleton-enable guard.
function activeHolders(db, designationId) {
  return db.prepare(`
    SELECT COUNT(*) c FROM employee_timeline t
    JOIN employees e ON e.id = t.employee_id
    WHERE t.designation_id = ? AND t.effective_to IS NULL AND e.status = 'active'
  `).get(designationId).c;
}

// PRAGMA helper — Phase 1 will add employees.department_id / designation_id;
// hard-delete guards check those columns only when they exist.
function tableHasColumn(db, table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

// Template Set is bootstrap-only. Once any employee (or timeline catalog bind)
// exists, resetting the catalog would orphan or wipe live HR data.
function templateSetGuard(db) {
  const employeeCount = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
  if (employeeCount > 0) {
    return {
      allowed: false,
      employeeCount,
      reason: 'Template Set is for initial structure only. Employees already exist — edit the tree instead of resetting.',
    };
  }
  const timelineRefs = db.prepare(`
    SELECT COUNT(*) c FROM employee_timeline
    WHERE department_id IS NOT NULL OR designation_id IS NOT NULL
  `).get().c;
  if (timelineRefs > 0) {
    return {
      allowed: false,
      employeeCount: 0,
      reason: 'Template Set is for initial structure only. Employee history already references departments or designations.',
    };
  }
  return { allowed: true, employeeCount: 0, reason: null };
}

function departmentHardDeleteBlock(db, id) {
  const timeline = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE department_id=?').get(id).c;
  if (timeline) {
    return 'Employees are (or were) tagged to this department — deactivate it instead of deleting';
  }
  if (tableHasColumn(db, 'employees', 'department_id')) {
    const live = db.prepare('SELECT COUNT(*) c FROM employees WHERE department_id=?').get(id).c;
    if (live) return 'Employees are assigned to this department — deactivate it instead of deleting';
  }
  return null;
}

function designationHardDeleteBlock(db, id) {
  const timeline = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE designation_id=?').get(id).c;
  if (timeline) {
    return 'This title is in use — set it to “not wanted” instead of deleting';
  }
  if (tableHasColumn(db, 'employees', 'designation_id')) {
    const live = db.prepare('SELECT COUNT(*) c FROM employees WHERE designation_id=?').get(id).c;
    if (live) return 'This title is assigned to employees — set it to “not wanted” instead of deleting';
  }
  return null;
}

// ─── Departments ────────────────────────────────────────────────────────────

// Nested tree. ?activeOnly=1 flattens to active departments (for pickers).
router.get('/departments', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const activeOnly = req.query.activeOnly === '1' || req.query.activeOnly === 'true';
  const rows = db.prepare(`
    SELECT d.*, e.name AS head_name, e.email AS head_email, e.designation AS head_designation
    FROM org_departments d
    LEFT JOIN employees e ON e.id = d.head_employee_id
    ${activeOnly ? 'WHERE d.active = 1' : ''}
    ORDER BY d.sort_order, d.name COLLATE NOCASE
  `).all();

  // Mapped designations per department (for the tree's expandable role rows).
  const maps = db.prepare(`
    SELECT dd.department_id, g.id, g.name, g.tag_name, g.status
    FROM org_department_designations dd
    JOIN org_designations g ON g.id = dd.designation_id
    ORDER BY g.name COLLATE NOCASE
  `).all();
  const byDept = {};
  for (const m of maps) (byDept[m.department_id] ||= []).push({ id: m.id, name: m.name, tag_name: m.tag_name, status: m.status });

  // Phase 2 — HOME people under each department (HR-designated place via
  // employees.department_id). Skip for activeOnly picker payloads.
  const homeByDept = {};
  if (!activeOnly && tableHasColumn(db, 'employees', 'department_id')) {
    const homeRows = db.prepare(`
      SELECT id, name, designation, status, department_id
      FROM employees
      WHERE department_id IS NOT NULL
      ORDER BY CASE lower(COALESCE(status, ''))
                 WHEN 'active' THEN 0
                 WHEN 'training' THEN 1
                 ELSE 2
               END,
               name COLLATE NOCASE
    `).all();
    for (const e of homeRows) {
      (homeByDept[e.department_id] ||= []).push({
        id: e.id,
        name: e.name,
        designation: e.designation || null,
        status: e.status || null,
      });
    }
  }

  // Phase 3 — active DEPUTED labels (visibility overlay; not a second home).
  const deputedByDept = {};
  if (!activeOnly) {
    try {
      const depRows = db.prepare(`
        SELECT dep.id AS deputation_id, dep.remarks, dep.started_on, dep.department_id,
               e.id, e.name, e.designation, e.status,
               e.department_id AS home_department_id,
               hd.name AS home_department_name
        FROM org_deputations dep
        JOIN employees e ON e.id = dep.employee_id
        LEFT JOIN org_departments hd ON hd.id = e.department_id
        WHERE dep.ended_on IS NULL
        ORDER BY CASE lower(COALESCE(e.status, ''))
                   WHEN 'active' THEN 0
                   WHEN 'training' THEN 1
                   ELSE 2
                 END,
                 e.name COLLATE NOCASE
      `).all();
      for (const r of depRows) {
        (deputedByDept[r.department_id] ||= []).push({
          deputation_id: r.deputation_id,
          id: r.id,
          name: r.name,
          designation: r.designation || null,
          status: r.status || null,
          remarks: r.remarks || null,
          started_on: r.started_on || null,
          home_department_id: r.home_department_id || null,
          home_department_name: r.home_department_name || null,
        });
      }
    } catch (e) {
      // Table may not exist yet on a mid-boot race; tree still useful without labels.
      if (!/no such table/i.test(e.message)) throw e;
    }
  }

  const nodes = {};
  rows.forEach(r => {
    nodes[r.id] = {
      ...r,
      designations: byDept[r.id] || [],
      home_employees: homeByDept[r.id] || [],
      deputed_employees: deputedByDept[r.id] || [],
      children: [],
    };
  });
  const roots = [];
  rows.forEach(r => {
    const n = nodes[r.id];
    if (r.parent_id && nodes[r.parent_id]) nodes[r.parent_id].children.push(n);
    else roots.push(n);
  });
  res.json(roots);
});

router.post('/departments', requirePermission(M, 'create'), (req, res) => {
  const db = getDb();
  const { parent_id = null, name, alias = null } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Name is required' });
  if (parent_id != null && !db.prepare('SELECT id FROM org_departments WHERE id=?').get(parent_id)) {
    return res.status(400).json({ error: 'Parent department not found' });
  }
  try {
    const info = db.prepare(`
      INSERT INTO org_departments (parent_id, name, alias, sort_order)
      VALUES (?, ?, ?, (SELECT COALESCE(MAX(sort_order) + 1, 0) FROM org_departments WHERE parent_id IS ?))
    `).run(parent_id, String(name).trim(), alias, parent_id);
    res.json(db.prepare('SELECT * FROM org_departments WHERE id=?').get(info.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A department with that name already exists here' });
    res.status(500).json({ error: e.message });
  }
});

// Multi-purpose: rename / set alias / set head / toggle active / sort / reparent.
router.put('/departments/:id', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const dept = db.prepare('SELECT * FROM org_departments WHERE id=?').get(id);
  if (!dept) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  // Reparent — cycle-guarded (walk up from the target parent; if we meet this
  // node it would form a loop). The company root cannot be moved.
  if (b.parent_id !== undefined && (b.parent_id || null) !== (dept.parent_id || null)) {
    if (dept.parent_id === null) return res.status(400).json({ error: 'The company root cannot be moved' });
    if (b.parent_id === id) return res.status(400).json({ error: 'A department cannot be its own parent' });
    if (b.parent_id != null) {
      let cur = db.prepare('SELECT id, parent_id FROM org_departments WHERE id=?').get(b.parent_id);
      if (!cur) return res.status(400).json({ error: 'Target parent not found' });
      const seen = new Set();
      while (cur) {
        if (cur.id === id) return res.status(400).json({ error: 'Cannot move a department under its own descendant' });
        if (seen.has(cur.id)) break;
        seen.add(cur.id);
        cur = cur.parent_id ? db.prepare('SELECT id, parent_id FROM org_departments WHERE id=?').get(cur.parent_id) : null;
      }
    }
  }

  const newName = b.name !== undefined ? String(b.name).trim() : dept.name;
  if (b.name !== undefined && !newName) return res.status(400).json({ error: 'Name cannot be empty' });

  try {
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE org_departments
        SET name=?, alias=?, head_employee_id=?, active=?, sort_order=?, parent_id=?
        WHERE id=?
      `).run(
        newName,
        b.alias !== undefined ? b.alias : dept.alias,
        b.head_employee_id !== undefined ? b.head_employee_id : dept.head_employee_id,
        b.active !== undefined ? (b.active ? 1 : 0) : dept.active,
        b.sort_order !== undefined ? b.sort_order : dept.sort_order,
        b.parent_id !== undefined ? b.parent_id : dept.parent_id,
        id,
      );
      // Rename self-heal (Plan B.0): refresh denormalized leaf TEXT on every
      // employee currently bound here — via live employees.department_id and
      // via open timeline rows (covers pre-bind timeline tags). Linked
      // users.department mirrors the same set.
      if (b.name !== undefined && newName !== dept.name) {
        db.prepare('UPDATE employees SET department=? WHERE department_id=?').run(newName, id);
        // Pre-bind open timeline tags (id on timeline, not yet on employees row).
        db.prepare(`
          UPDATE employees SET department=?
          WHERE department_id IS NULL
            AND id IN (SELECT employee_id FROM employee_timeline WHERE department_id=? AND effective_to IS NULL)
        `).run(newName, id);
        db.prepare(`
          UPDATE users SET department=?
          WHERE id IN (
            SELECT e.user_id FROM employees e
            WHERE e.department_id=? AND e.user_id IS NOT NULL
          )
        `).run(newName, id);
        db.prepare(`
          UPDATE users SET department=?
          WHERE id IN (
            SELECT e.user_id FROM employees e
            JOIN employee_timeline t ON t.employee_id = e.id
            WHERE e.department_id IS NULL AND t.department_id=? AND t.effective_to IS NULL AND e.user_id IS NOT NULL
          )
        `).run(newName, id);
      }
      // NOTE: Set-head records ONLY who leads (head_employee_id). A person's
      // designation is an employee attribute, authored in the employee form —
      // NOT here. The org tree references the head; it does not tag their title.
    });
    tx();
    res.json(db.prepare('SELECT * FROM org_departments WHERE id=?').get(id));
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A department with that name already exists here' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/departments/:id', requirePermission(M, 'delete'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const dept = db.prepare('SELECT * FROM org_departments WHERE id=?').get(id);
  if (!dept) return res.status(404).json({ error: 'Not found' });
  const kids = db.prepare('SELECT COUNT(*) c FROM org_departments WHERE parent_id=?').get(id).c;
  if (kids) return res.status(400).json({ error: 'This department has sub-departments — move or remove them first, or deactivate instead' });
  // Timeline (any era) or live employees.department_id → deactivate, never wipe.
  const block = departmentHardDeleteBlock(db, id);
  if (block) return res.status(400).json({ error: block });
  db.prepare('DELETE FROM org_departments WHERE id=?').run(id); // junction rows cascade
  res.json({ ok: true });
});

// ─── Designations (flat catalog) ─────────────────────────────────────────────

// ?department_id= → only titles mapped to that dept; ?status= → filter by status.
router.get('/designations', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const { department_id, status } = req.query;
  const args = [];
  let sql;
  if (department_id) {
    sql = `SELECT g.* FROM org_designations g
           JOIN org_department_designations dd ON dd.designation_id = g.id
           WHERE dd.department_id = ?`;
    args.push(Number(department_id));
    if (status) { sql += ' AND g.status = ?'; args.push(status); }
  } else {
    sql = 'SELECT g.* FROM org_designations g';
    if (status) { sql += ' WHERE g.status = ?'; args.push(status); }
  }
  sql += ' ORDER BY g.name COLLATE NOCASE';
  const rows = db.prepare(sql).all(...args);

  // Attach the department chips + current active-holder count per title.
  const chips = db.prepare(`
    SELECT dd.designation_id, d.id, d.name
    FROM org_department_designations dd
    JOIN org_departments d ON d.id = dd.department_id
    ORDER BY d.name COLLATE NOCASE
  `).all();
  const byDes = {};
  chips.forEach(c => (byDes[c.designation_id] ||= []).push({ id: c.id, name: c.name }));
  const holders = db.prepare(`
    SELECT t.designation_id, COUNT(*) c
    FROM employee_timeline t JOIN employees e ON e.id = t.employee_id
    WHERE t.effective_to IS NULL AND e.status = 'active' AND t.designation_id IS NOT NULL
    GROUP BY t.designation_id
  `).all();
  const holderCount = {};
  holders.forEach(h => { holderCount[h.designation_id] = h.c; });

  res.json(rows.map(r => ({ ...r, departments: byDes[r.id] || [], active_holders: holderCount[r.id] || 0 })));
});

router.post('/designations', requirePermission(M, 'create'), (req, res) => {
  const db = getDb();
  const { name, tag_name = null, singleton = 0, status = 'present' } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Title is required' });
  if (!DESIG_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  try {
    const info = db.prepare('INSERT INTO org_designations (name, tag_name, singleton, status) VALUES (?,?,?,?)')
      .run(String(name).trim(), tag_name ? String(tag_name).trim() : null, singleton ? 1 : 0, status);
    res.json(db.prepare('SELECT * FROM org_designations WHERE id=?').get(info.lastInsertRowid));
  } catch (e) {
    if (/UNIQUE/i.test(e.message) && /tag/i.test(e.message)) return res.status(400).json({ error: 'That tag/code is already used by another title (case-insensitive)' });
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A designation with that title already exists (case-insensitive)' });
    res.status(500).json({ error: e.message });
  }
});

router.put('/designations/:id', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM org_designations WHERE id=?').get(id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  if (b.status !== undefined && !DESIG_STATUS.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });

  // Singleton enable guard: turning ★ on requires ≤1 active holder (clean first).
  if (b.singleton !== undefined && b.singleton && !d.singleton) {
    const h = activeHolders(db, id);
    if (h > 1) return res.status(400).json({ error: `This title has ${h} active holders — reconcile to one before marking it unique` });
  }

  const newName = b.name !== undefined ? String(b.name).trim() : d.name;
  if (b.name !== undefined && !newName) return res.status(400).json({ error: 'Title cannot be empty' });

  try {
    const tx = db.transaction(() => {
      db.prepare('UPDATE org_designations SET name=?, tag_name=?, singleton=?, status=? WHERE id=?').run(
        newName,
        b.tag_name !== undefined ? (b.tag_name ? String(b.tag_name).trim() : null) : d.tag_name,
        b.singleton !== undefined ? (b.singleton ? 1 : 0) : d.singleton,
        b.status !== undefined ? b.status : d.status,
        id,
      );
      // Designation rename → re-derive cached leaf TEXT on bound employees
      // (live designation_id + open timeline tags). Closed timeline untouched.
      if (b.name !== undefined && newName !== d.name) {
        db.prepare('UPDATE employees SET designation=? WHERE designation_id=?').run(newName, id);
        db.prepare(`
          UPDATE employees SET designation=?
          WHERE designation_id IS NULL
            AND id IN (SELECT employee_id FROM employee_timeline WHERE designation_id=? AND effective_to IS NULL)
        `).run(newName, id);
      }
    });
    tx();
    res.json(db.prepare('SELECT * FROM org_designations WHERE id=?').get(id));
  } catch (e) {
    if (/UNIQUE/i.test(e.message) && /tag/i.test(e.message)) return res.status(400).json({ error: 'That tag/code is already used by another title (case-insensitive)' });
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A designation with that title already exists (case-insensitive)' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/designations/:id', requirePermission(M, 'delete'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM org_designations WHERE id=?').get(id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const block = designationHardDeleteBlock(db, id);
  if (block) return res.status(400).json({ error: block });
  db.prepare('DELETE FROM org_designations WHERE id=?').run(id); // junction rows cascade
  res.json({ ok: true });
});

// ─── Mapping (department ↔ designation, M:N) ─────────────────────────────────

router.post('/departments/:id/designations', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const deptId = Number(req.params.id);
  const { designation_id } = req.body || {};
  if (!designation_id) return res.status(400).json({ error: 'designation_id is required' });
  if (!db.prepare('SELECT id FROM org_departments WHERE id=?').get(deptId)) return res.status(404).json({ error: 'Department not found' });
  if (!db.prepare('SELECT id FROM org_designations WHERE id=?').get(designation_id)) return res.status(404).json({ error: 'Designation not found' });
  db.prepare('INSERT OR IGNORE INTO org_department_designations (department_id, designation_id) VALUES (?,?)').run(deptId, designation_id);
  res.json({ ok: true });
});

router.delete('/departments/:id/designations/:designationId', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM org_department_designations WHERE department_id=? AND designation_id=?')
    .run(Number(req.params.id), Number(req.params.designationId));
  res.json({ ok: true });
});

// ─── Template bootstrap (Mandatory Field Spec HR-2/HR-3 draft catalog) ──────
// Initial-structure tool only: wipes non-skeleton departments + the whole
// designation catalog, then reseeds from db/orgTemplate.js. Preview stays
// available always. Set is blocked once any employee (or timeline catalog
// bind) exists — playground reset after go-live is not allowed (Plan B.0 P0).

// Read-only: which departments WOULD be removed, and the resulting counts —
// shared by /template/preview (GET, no mutation) and /template/load (POST,
// actually applies it) so the two can never disagree about what "applying
// the template" means. Same bottom-up traversal as the delete path, but
// collecting ids into a Set instead of deleting them. `tpl` is one entry
// from db/orgTemplate.js's TEMPLATES list — every caller resolves it via
// getTemplate(id) first so an unknown id is rejected before this runs.
function computeTemplateDiff(db, tpl) {
  const { SPEC_DEPARTMENTS } = require('../db/orgTemplate');
  const root = db.prepare('SELECT id FROM org_departments WHERE parent_id IS NULL ORDER BY id LIMIT 1').get();
  if (!root) return null;
  const fnNodes = db.prepare('SELECT id, name FROM org_departments WHERE parent_id=?').all(root.id);
  const keepIds = new Set([root.id, ...fnNodes.map((n) => n.id)]);
  fnNodes.forEach((n) => {
    (SPEC_DEPARTMENTS[n.name] || []).forEach((leafName) => {
      const row = db.prepare('SELECT id FROM org_departments WHERE parent_id=? AND LOWER(name)=LOWER(?)').get(n.id, leafName);
      if (row) keepIds.add(row.id);
    });
  });

  const allDepts = db.prepare('SELECT id, parent_id, name FROM org_departments').all();
  const byId = new Map(allDepts.map((d) => [d.id, d]));
  const removedIds = new Set();
  let progress = true;
  while (progress) {
    progress = false;
    for (const d of allDepts) {
      if (keepIds.has(d.id) || removedIds.has(d.id)) continue;
      const hasSurvivingChild = allDepts.some((c) => c.parent_id === d.id && !removedIds.has(c.id));
      if (!hasSurvivingChild) { removedIds.add(d.id); progress = true; }
    }
  }

  const newDesignationCount = tpl.companyTitles.length + Object.values(tpl.departmentTitles).reduce((n, list) => n + list.length, 0);
  return {
    root, fnNodes, keepIds,
    departmentsToRemove: [...removedIds].map((id) => ({ id, name: byId.get(id).name })),
    currentDesignationCount: db.prepare('SELECT COUNT(*) c FROM org_designations').get().c,
    newDesignationCount,
  };
}

// List available templates + whether Set is still allowed (bootstrap-only).
router.get('/templates', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const { TEMPLATES } = require('../db/orgTemplate');
  const guard = templateSetGuard(db);
  res.json({
    templates: TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
    setAllowed: guard.allowed,
    setBlockedReason: guard.reason,
    employeeCount: guard.employeeCount,
  });
});

// Preview only — computes the diff, mutates nothing. requirePermission(M,
// 'view') rather than 'delete': looking is not the destructive part.
router.get('/template/preview', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const { getTemplate } = require('../db/orgTemplate');
  const tpl = getTemplate(req.query.id);
  if (!tpl) return res.status(400).json({ error: 'Unknown template' });
  const diff = computeTemplateDiff(db, tpl);
  if (!diff) return res.status(400).json({ error: 'No root department — org structure was never seeded' });
  const guard = templateSetGuard(db);
  res.json({
    departmentsToRemove: diff.departmentsToRemove.map((d) => d.name),
    currentDesignationCount: diff.currentDesignationCount,
    newDesignationCount: diff.newDesignationCount,
    setAllowed: guard.allowed,
    setBlockedReason: guard.reason,
  });
});

router.post('/template/load', requirePermission(M, 'delete'), (req, res) => {
  const db = getDb();
  const { getTemplate } = require('../db/orgTemplate');
  const { ensureSpecDepartments } = require('../db/orgSchema');
  const tpl = getTemplate((req.body || {}).id);
  if (!tpl) return res.status(400).json({ error: 'Unknown template' });

  const guard = templateSetGuard(db);
  if (!guard.allowed) {
    return res.status(400).json({ error: guard.reason });
  }

  try {
    const result = db.transaction(() => {
      // Compute the SAME diff /template/preview would show, then apply it —
      // guarantees preview and apply can never drift apart.
      const diff = computeTemplateDiff(db, tpl);
      if (!diff) throw new Error('No root department — org structure was never seeded');
      const { root, fnNodes, departmentsToRemove, currentDesignationCount } = diff;

      const designationsRemoved = currentDesignationCount;
      db.prepare('DELETE FROM org_designations').run(); // junction rows cascade

      departmentsToRemove.forEach((d) => db.prepare('DELETE FROM org_departments WHERE id=?').run(d.id));
      const departmentsRemoved = departmentsToRemove.length;

      // Clear stale test heads (e.g. a mock employee) on whatever survives.
      db.prepare('UPDATE org_departments SET head_employee_id=NULL').run();

      // Reseed the 11 spec leaves (idempotent — safe even freshly cleared).
      ensureSpecDepartments(db);

      const insDesig = db.prepare('INSERT INTO org_designations (name, tag_name, singleton, status) VALUES (?,?,?,?)');
      const attach = db.prepare('INSERT OR IGNORE INTO org_department_designations (department_id, designation_id) VALUES (?,?)');
      const fnByName = Object.fromEntries(db.prepare('SELECT id, name FROM org_departments WHERE parent_id=?').all(root.id).map((n) => [n.name, n.id]));

      let designationsAdded = 0;
      tpl.companyTitles.forEach((t) => {
        const info = insDesig.run(t.name, t.tagName || null, 1, 'present');
        designationsAdded++;
        const deptId = t.attachTo ? fnByName[t.attachTo] : root.id;
        if (deptId) attach.run(deptId, info.lastInsertRowid);
      });

      const leafByName = {};
      fnNodes.forEach((n) => {
        db.prepare('SELECT id, name FROM org_departments WHERE parent_id=?').all(n.id).forEach((l) => { leafByName[l.name] = l.id; });
      });
      Object.entries(tpl.departmentTitles).forEach(([deptName, titles]) => {
        const deptId = leafByName[deptName];
        if (!deptId) return;
        titles.forEach((title) => {
          const info = insDesig.run(title, null, 0, 'present');
          designationsAdded++;
          attach.run(deptId, info.lastInsertRowid);
        });
      });

      return { departmentsRemoved, designationsRemoved, designationsAdded };
    })();

    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Openings (decoupled vacancy board) ──────────────────────────────────────

router.get('/openings', requirePermission(M, 'view'), (req, res) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT o.*, d.name AS department_name, g.name AS designation_name, g.tag_name AS designation_tag
    FROM org_openings o
    LEFT JOIN org_departments d ON d.id = o.department_id
    LEFT JOIN org_designations g ON g.id = o.designation_id
    ORDER BY CASE o.status WHEN 'open' THEN 0 WHEN 'on_hold' THEN 1 WHEN 'filled' THEN 2 ELSE 3 END, o.created_at DESC
  `).all();
  res.json(rows);
});

router.post('/openings', requirePermission(M, 'create'), (req, res) => {
  const db = getDb();
  const { department_id = null, designation_id = null, headcount = 1, reports_to_employee_id = null, notes = null } = req.body || {};
  const info = db.prepare(`
    INSERT INTO org_openings (department_id, designation_id, headcount, reports_to_employee_id, notes)
    VALUES (?,?,?,?,?)
  `).run(department_id, designation_id, headcount, reports_to_employee_id, notes);
  res.json(db.prepare('SELECT * FROM org_openings WHERE id=?').get(info.lastInsertRowid));
});

router.put('/openings/:id', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const o = db.prepare('SELECT * FROM org_openings WHERE id=?').get(id);
  if (!o) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const status = b.status !== undefined ? b.status : o.status;
  if (!OPENING_STATUS.includes(status)) return res.status(400).json({ error: 'Invalid status' });
  db.prepare(`
    UPDATE org_openings SET
      department_id=?, designation_id=?, headcount=?, reports_to_employee_id=?, status=?, filled_employee_id=?, notes=?,
      closed_at = CASE WHEN ? IN ('filled','closed') THEN COALESCE(closed_at, CURRENT_TIMESTAMP) ELSE NULL END
    WHERE id=?
  `).run(
    b.department_id !== undefined ? b.department_id : o.department_id,
    b.designation_id !== undefined ? b.designation_id : o.designation_id,
    b.headcount !== undefined ? b.headcount : o.headcount,
    b.reports_to_employee_id !== undefined ? b.reports_to_employee_id : o.reports_to_employee_id,
    status,
    b.filled_employee_id !== undefined ? b.filled_employee_id : o.filled_employee_id,
    b.notes !== undefined ? b.notes : o.notes,
    status,
    id,
  );
  res.json(db.prepare('SELECT * FROM org_openings WHERE id=?').get(id));
});

router.delete('/openings/:id', requirePermission(M, 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM org_openings WHERE id=?').run(Number(req.params.id));
  res.json({ ok: true });
});

// ─── Deputations (Phase 3 — visibility labels only; never writes employee home) ─

router.post('/deputations', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const employeeId = Number(b.employee_id);
  const departmentId = Number(b.department_id);
  if (!employeeId || !departmentId) {
    return res.status(400).json({ error: 'employee_id and department_id are required' });
  }

  const emp = db.prepare('SELECT id, name, department_id FROM employees WHERE id=?').get(employeeId);
  if (!emp) return res.status(400).json({ error: 'Employee not found' });

  const dept = db.prepare('SELECT id, name, active FROM org_departments WHERE id=?').get(departmentId);
  if (!dept) return res.status(400).json({ error: 'Department not found' });
  if (!dept.active) return res.status(400).json({ error: 'Cannot depute to an inactive department' });

  if (emp.department_id != null && Number(emp.department_id) === departmentId) {
    return res.status(400).json({ error: 'Already home in that department — depute is for another department only' });
  }

  const remarks = b.remarks != null && String(b.remarks).trim() ? String(b.remarks).trim() : null;
  const startedOn = b.started_on && String(b.started_on).trim()
    ? String(b.started_on).trim().slice(0, 10)
    : new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  const createdBy = req.user?.id || null;

  try {
    const info = db.prepare(`
      INSERT INTO org_deputations (employee_id, department_id, remarks, started_on, created_by)
      VALUES (?,?,?,?,?)
    `).run(employeeId, departmentId, remarks, startedOn, createdBy);
    const row = db.prepare('SELECT * FROM org_deputations WHERE id=?').get(info.lastInsertRowid);
    res.json(row);
  } catch (e) {
    if (/UNIQUE/i.test(e.message)) {
      return res.status(400).json({ error: 'Already deputed to that department' });
    }
    res.status(500).json({ error: e.message });
  }
});

// Soft-end: clears visibility under the target dept. Does not touch employees.*
router.delete('/deputations/:id', requirePermission(M, 'edit'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM org_deputations WHERE id=?').get(id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  if (row.ended_on) return res.json({ ok: true, alreadyEnded: true });

  const endedOn = new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10);
  db.prepare('UPDATE org_deputations SET ended_on=? WHERE id=?').run(endedOn, id);
  res.json({ ok: true, ended_on: endedOn });
});

module.exports = router;
