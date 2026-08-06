#!/usr/bin/env node
/**
 * Phase 2 smoke: HOME employees attached to org department tree.
 * Uses a transaction that always rolls back for the bind path.
 */
const path = require('path');
process.chdir(path.join(__dirname, '..'));

const { getDb, initializeDatabase } = require('../db/schema');

initializeDatabase();
const db = getDb();

function tableHasColumn(table, col) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
}

/** Mirror GET /org-structure/departments home attachment (Phase 2). */
function attachHomeEmployees() {
  const homeByDept = {};
  if (!tableHasColumn('employees', 'department_id')) return homeByDept;
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
  return homeByDept;
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: !!ok, detail: detail || '' });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

console.log('=== Phase 2 HOME mirror verification ===\n');

check('employees.department_id exists', tableHasColumn('employees', 'department_id'));

const emp = db.prepare('SELECT id, name, department, department_id, designation, status FROM employees ORDER BY id LIMIT 1').get();
const dept = db.prepare('SELECT id, name FROM org_departments WHERE active=1 ORDER BY id LIMIT 1').get();

if (emp && dept) {
  const tx = db.transaction(() => {
    db.prepare('UPDATE employees SET department_id=?, department=? WHERE id=?')
      .run(dept.id, dept.name, emp.id);
    const homeByDept = attachHomeEmployees();
    const list = homeByDept[dept.id] || [];
    check(
      'Bound employee appears under home department',
      list.some((e) => e.id === emp.id),
      `${emp.name} → ${dept.name} (#${dept.id}); list=${list.length}`,
    );
    check(
      'HOME payload has id/name/designation/status only',
      list.every((e) => e.id != null && e.name != null && !('salary' in e) && !('email' in e)),
    );
    throw new Error('ROLLBACK_PHASE2_TEST');
  });
  try {
    tx();
  } catch (e) {
    if (e.message !== 'ROLLBACK_PHASE2_TEST') throw e;
  }
  const after = db.prepare('SELECT department_id, department FROM employees WHERE id=?').get(emp.id);
  check(
    'Temp bind rolled back',
    after.department_id === emp.department_id && after.department === emp.department,
    `dept_id=${after.department_id}`,
  );
} else {
  check('Bind smoke (skipped — need employee + department)', false, 'missing seed data');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n=== ${results.length - failed.length}/${results.length} passed ===`);
if (failed.length) {
  failed.forEach((f) => console.log(`  - ${f.name}: ${f.detail}`));
  process.exit(1);
}
process.exit(0);
