// Plan B.0 — resolve employee home department/designation binds.
// Server is authoritative for leaf TEXT when an org catalog id is supplied.
// Soft refs: unknown / inactive ids are rejected so the UI cannot invent binds.

function resolveOrgEmployeeBind(db, input = {}) {
  const out = {
    department_id: input.department_id,
    designation_id: input.designation_id,
    department: input.department,
    designation: input.designation,
  };
  const errors = [];

  if (input.department_id !== undefined) {
    if (input.department_id === null || input.department_id === '') {
      out.department_id = null;
      // Clearing the bind also clears denormalized leaf (strict catalog pickers).
      if (input.department === undefined) out.department = null;
    } else {
      const id = Number(input.department_id);
      const row = db.prepare('SELECT id, name, active FROM org_departments WHERE id=?').get(id);
      if (!row) errors.push({ field: 'department_id', message: 'Department not found in org catalog' });
      else if (!row.active) errors.push({ field: 'department_id', message: 'That department is inactive — pick an active one' });
      else {
        out.department_id = row.id;
        out.department = row.name;
      }
    }
  }

  if (input.designation_id !== undefined) {
    if (input.designation_id === null || input.designation_id === '') {
      out.designation_id = null;
      if (input.designation === undefined) out.designation = null;
    } else {
      const id = Number(input.designation_id);
      const row = db.prepare('SELECT id, name, status FROM org_designations WHERE id=?').get(id);
      if (!row) errors.push({ field: 'designation_id', message: 'Designation not found in org catalog' });
      else if (row.status === 'not_wanted') {
        errors.push({ field: 'designation_id', message: 'That designation is marked not wanted — pick another' });
      } else {
        out.designation_id = row.id;
        out.designation = row.name;
      }
    }
  }

  return { ...out, errors };
}

module.exports = { resolveOrgEmployeeBind };
