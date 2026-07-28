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

  const nodes = {};
  rows.forEach(r => { nodes[r.id] = { ...r, designations: byDept[r.id] || [], children: [] }; });
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
      // Rename clockwork (design §7): re-derive the cached LEAF string on every
      // employee CURRENTLY tagged here (open timeline row) + mirror the linked
      // users.department — same transaction. No-op until employees are tagged.
      if (b.name !== undefined && newName !== dept.name) {
        db.prepare(`
          UPDATE employees SET department=?
          WHERE id IN (SELECT employee_id FROM employee_timeline WHERE department_id=? AND effective_to IS NULL)
        `).run(newName, id);
        db.prepare(`
          UPDATE users SET department=?
          WHERE id IN (
            SELECT e.user_id FROM employees e
            JOIN employee_timeline t ON t.employee_id = e.id
            WHERE t.department_id=? AND t.effective_to IS NULL AND e.user_id IS NOT NULL
          )
        `).run(newName, id);
      }
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
  // Any timeline reference (open OR closed) blocks a hard delete — preserve
  // history; deactivate instead. (Also avoids the FK RESTRICT surfacing raw.)
  const refs = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE department_id=?').get(id).c;
  if (refs) return res.status(400).json({ error: 'Employees are (or were) tagged to this department — deactivate it instead of deleting' });
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
    if (/UNIQUE/i.test(e.message) && /tag_name/i.test(e.message)) return res.status(400).json({ error: 'That tag/code is already used by another title' });
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A designation with that title already exists' });
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
      // Designation rename → re-derive the cached leaf string on currently-tagged
      // employees (symmetry with dept rename; no users.designation column exists).
      if (b.name !== undefined && newName !== d.name) {
        db.prepare(`
          UPDATE employees SET designation=?
          WHERE id IN (SELECT employee_id FROM employee_timeline WHERE designation_id=? AND effective_to IS NULL)
        `).run(newName, id);
      }
    });
    tx();
    res.json(db.prepare('SELECT * FROM org_designations WHERE id=?').get(id));
  } catch (e) {
    if (/UNIQUE/i.test(e.message) && /tag_name/i.test(e.message)) return res.status(400).json({ error: 'That tag/code is already used by another title' });
    if (/UNIQUE/i.test(e.message)) return res.status(400).json({ error: 'A designation with that title already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.delete('/designations/:id', requirePermission(M, 'delete'), (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  const d = db.prepare('SELECT * FROM org_designations WHERE id=?').get(id);
  if (!d) return res.status(404).json({ error: 'Not found' });
  const inUse = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE designation_id=?').get(id).c;
  if (inUse) return res.status(400).json({ error: 'This title is in use — set it to “not wanted” instead of deleting' });
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

module.exports = router;
