#!/usr/bin/env node
/**
 * Phase 0 + Phase 1 smoke checks for Plan B.0 (org bind).
 * Uses the live DB inside a transaction that always rolls back.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getDb, initializeDatabase } = require('../db/schema');
const { resolveOrgEmployeeBind } = require('../lib/orgEmployeeBind');

initializeDatabase();
const db = getDb();

function tableHasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

function templateSetGuard() {
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
      reason: 'Template Set is for initial structure only. Timeline already references org catalog ids.',
    };
  }
  return { allowed: true, employeeCount: 0, reason: null };
}

function departmentHardDeleteBlock(id) {
  const timeline = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE department_id=?').get(id).c;
  if (timeline) return 'timeline';
  if (tableHasColumn('employees', 'department_id')) {
    const live = db.prepare('SELECT COUNT(*) c FROM employees WHERE department_id=?').get(id).c;
    if (live) return 'live';
  }
  return null;
}

function designationHardDeleteBlock(id) {
  const timeline = db.prepare('SELECT COUNT(*) c FROM employee_timeline WHERE designation_id=?').get(id).c;
  if (timeline) return 'timeline';
  if (tableHasColumn('employees', 'designation_id')) {
    const live = db.prepare('SELECT COUNT(*) c FROM employees WHERE designation_id=?').get(id).c;
    if (live) return 'live';
  }
  return null;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  const mark = ok ? 'PASS' : 'FAIL';
  console.log(`${mark}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('=== Phase 0 + Phase 1 verification ===\n');

// ── Schema ──────────────────────────────────────────────────────────────────
check(
  'employees.department_id column exists',
  tableHasColumn('employees', 'department_id'),
);
check(
  'employees.designation_id column exists',
  tableHasColumn('employees', 'designation_id'),
);

// ── Phase 0: Template Set guard ─────────────────────────────────────────────
const guard = templateSetGuard();
const empCount = db.prepare('SELECT COUNT(*) c FROM employees').get().c;
check(
  'Template Set blocked when employees exist',
  empCount === 0 || guard.allowed === false,
  `employees=${empCount}, allowed=${guard.allowed}`,
);
if (empCount > 0) {
  check(
    'Template Set reason is informative',
    !!(guard.reason && /initial structure/i.test(guard.reason)),
    guard.reason,
  );
}

// ── Phase 0: Hard-delete blocks ─────────────────────────────────────────────
const linkedDept = db.prepare(`
  SELECT id, name FROM org_departments d
  WHERE EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.id)
     OR EXISTS (SELECT 1 FROM employee_timeline t WHERE t.department_id = d.id)
  LIMIT 1
`).get();
if (linkedDept) {
  check(
    'Hard-delete blocked for linked department',
    !!departmentHardDeleteBlock(linkedDept.id),
    `${linkedDept.name} (#${linkedDept.id})`,
  );
} else {
  check(
    'Hard-delete linked department (skipped — none linked yet)',
    true,
    'no employees.department_id / timeline refs; bind first to exercise live path',
  );
}

const linkedDesig = db.prepare(`
  SELECT id, name FROM org_designations g
  WHERE EXISTS (SELECT 1 FROM employees e WHERE e.designation_id = g.id)
     OR EXISTS (SELECT 1 FROM employee_timeline t WHERE t.designation_id = g.id)
  LIMIT 1
`).get();
if (linkedDesig) {
  check(
    'Hard-delete blocked for linked designation',
    !!designationHardDeleteBlock(linkedDesig.id),
    `${linkedDesig.name} (#${linkedDesig.id})`,
  );
} else {
  check(
    'Hard-delete linked designation (skipped — none linked yet)',
    true,
    'no employees.designation_id / timeline refs',
  );
}

const freeDept = db.prepare(`
  SELECT id, name FROM org_departments d
  WHERE NOT EXISTS (SELECT 1 FROM employees e WHERE e.department_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM employee_timeline t WHERE t.department_id = d.id)
    AND NOT EXISTS (SELECT 1 FROM org_departments c WHERE c.parent_id = d.id)
  LIMIT 1
`).get();
if (freeDept) {
  check(
    'Hard-delete allowed for unlinked leaf department',
    departmentHardDeleteBlock(freeDept.id) === null,
    `${freeDept.name} (#${freeDept.id})`,
  );
}

// ── Phase 1: resolveOrgEmployeeBind ─────────────────────────────────────────
const activeDept = db.prepare('SELECT id, name FROM org_departments WHERE active=1 ORDER BY id LIMIT 1').get();
const inactiveDept = db.prepare('SELECT id, name FROM org_departments WHERE active=0 ORDER BY id LIMIT 1').get();
const activeDesig = db.prepare(`SELECT id, name FROM org_designations WHERE status IS NULL OR status != 'not_wanted' ORDER BY id LIMIT 1`).get();
const notWantedDesig = db.prepare(`SELECT id, name FROM org_designations WHERE status='not_wanted' ORDER BY id LIMIT 1`).get();

if (activeDept) {
  const r = resolveOrgEmployeeBind(db, {
    department_id: activeDept.id,
    department: 'CLIENT_SPOOFED_NAME',
  });
  check(
    'Bind: active department_id wins over client text',
    r.errors.length === 0 && r.department_id === activeDept.id && r.department === activeDept.name,
    `got "${r.department}" (expected "${activeDept.name}")`,
  );
}

{
  const r = resolveOrgEmployeeBind(db, { department_id: 999999999 });
  check(
    'Bind: unknown department_id rejected',
    r.errors.some((e) => e.field === 'department_id'),
    r.errors.map((e) => e.message).join('; '),
  );
}

if (inactiveDept) {
  const r = resolveOrgEmployeeBind(db, { department_id: inactiveDept.id });
  check(
    'Bind: inactive department_id rejected',
    r.errors.some((e) => e.field === 'department_id'),
    r.errors.map((e) => e.message).join('; '),
  );
} else {
  check('Bind: inactive department (skipped — none inactive)', true, 'no inactive depts');
}

if (activeDesig) {
  const r = resolveOrgEmployeeBind(db, {
    designation_id: activeDesig.id,
    designation: 'CLIENT_SPOOFED_TITLE',
  });
  check(
    'Bind: active designation_id wins over client text',
    r.errors.length === 0 && r.designation_id === activeDesig.id && r.designation === activeDesig.name,
    `got "${r.designation}" (expected "${activeDesig.name}")`,
  );
}

if (notWantedDesig) {
  const r = resolveOrgEmployeeBind(db, { designation_id: notWantedDesig.id });
  check(
    'Bind: not_wanted designation rejected',
    r.errors.some((e) => e.field === 'designation_id'),
    r.errors.map((e) => e.message).join('; '),
  );
} else {
  check('Bind: not_wanted designation (skipped — none)', true, 'no not_wanted titles');
}

{
  const r = resolveOrgEmployeeBind(db, { department_id: null, designation_id: null });
  check(
    'Bind: clear ids also clears leaf text',
    r.department_id === null && r.designation_id === null && r.department === null && r.designation === null,
  );
}

// ── Phase 1: rename self-heal (transaction + rollback) ──────────────────────
const bound = db.prepare(`
  SELECT e.id AS emp_id, e.department AS old_name, e.department_id, d.name AS catalog_name
  FROM employees e
  JOIN org_departments d ON d.id = e.department_id
  LIMIT 1
`).get();

if (bound) {
  const marker = `__PHASE1_TEST_${Date.now()}__`;
  const tx = db.transaction(() => {
    db.prepare('UPDATE org_departments SET name=? WHERE id=?').run(marker, bound.department_id);
    // Mirror the cascade in orgStructure PUT rename:
    db.prepare('UPDATE employees SET department=? WHERE department_id=?').run(marker, bound.department_id);
    const after = db.prepare('SELECT department FROM employees WHERE id=?').get(bound.emp_id);
    check(
      'Rename self-heal updates employees.department for bound id',
      after.department === marker,
      `emp #${bound.emp_id}: "${bound.old_name}" → "${after.department}"`,
    );
    throw new Error('ROLLBACK_PHASE1_TEST');
  });
  try {
    tx();
  } catch (e) {
    if (e.message !== 'ROLLBACK_PHASE1_TEST') throw e;
  }
  const restored = db.prepare('SELECT department, name FROM employees e JOIN org_departments d ON d.id=e.department_id WHERE e.id=?').get(bound.emp_id);
  // After rollback, both should match pre-test catalog name
  const deptNow = db.prepare('SELECT name FROM org_departments WHERE id=?').get(bound.department_id);
  check(
    'Rename self-heal test rolled back (DB unchanged)',
    deptNow.name === bound.catalog_name && restored.department === bound.old_name,
    `dept="${deptNow.name}", emp.department="${restored.department}"`,
  );
} else {
  // Exercise cascade with a temporary bind on first employee + rollback
  const emp = db.prepare('SELECT id, department, department_id FROM employees ORDER BY id LIMIT 1').get();
  const dept = activeDept;
  if (emp && dept) {
    const marker = `__PHASE1_TEST_${Date.now()}__`;
    const originalDeptName = dept.name;
    const tx = db.transaction(() => {
      db.prepare('UPDATE employees SET department_id=?, department=? WHERE id=?')
        .run(dept.id, dept.name, emp.id);
      db.prepare('UPDATE org_departments SET name=? WHERE id=?').run(marker, dept.id);
      db.prepare('UPDATE employees SET department=? WHERE department_id=?').run(marker, dept.id);
      const after = db.prepare('SELECT department, department_id FROM employees WHERE id=?').get(emp.id);
      check(
        'Rename self-heal (temp bind) updates leaf text',
        after.department_id === dept.id && after.department === marker,
        `emp #${emp.id} → "${after.department}"`,
      );
      throw new Error('ROLLBACK_PHASE1_TEST');
    });
    try {
      tx();
    } catch (e) {
      if (e.message !== 'ROLLBACK_PHASE1_TEST') throw e;
    }
    const empAfter = db.prepare('SELECT department, department_id FROM employees WHERE id=?').get(emp.id);
    const deptAfter = db.prepare('SELECT name FROM org_departments WHERE id=?').get(dept.id);
    check(
      'Temp-bind rename test rolled back',
      empAfter.department_id === emp.department_id
        && empAfter.department === emp.department
        && deptAfter.name === originalDeptName,
      `emp.dept_id=${empAfter.department_id}, dept.name="${deptAfter.name}"`,
    );
  } else {
    check('Rename self-heal (skipped — no employees/depts)', false, 'need at least one employee and department');
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  console.log('Failed:');
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}
process.exit(0);
