// Employee change-history write path (plan: magical-wibbling-orbit).
//
// The ONE place that appends to the effective-dated employee_timeline ledger, so
// every writer (HR create/bulk/edit, payroll ot_eligible, backfill) obeys the same
// invariants:
//   • exactly one OPEN row per employee (effective_to IS NULL) — enforced by the
//     unique partial index; this code keeps it true by closing the prior open row
//     before opening a new one, inside the caller's db.transaction();
//   • each row is a FULL snapshot of the employee's tracked state at effective_from
//     (so an as-of read is a single row, no delta-chaining);
//   • effective_from is DATE-LEVEL (YYYY-MM-DD); the precise wall-clock lives in
//     changed_at (DEFAULT CURRENT_TIMESTAMP);
//   • employee_name is denormalized so history stays readable after a hard delete
//     (employee_id then nulls out via ON DELETE SET NULL).
//
// MUST be called AFTER the employees row is written, so the snapshot reads the new
// (post-edit) live state. MUST run inside the same transaction as that write.

// IST calendar date (server clock is UTC on the VPS). Matches istToday() elsewhere.
function istToday() {
  return new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

// Coerce any date-ish value to YYYY-MM-DD; blank/garbage → today (IST).
function toYMD(v) {
  if (v == null || v === '') return istToday();
  const s = String(v).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : istToday();
}

const SNAPSHOT_COLS =
  'id, name, status, salary, salary_exempt, designation, department, roster, ot_eligible';

// The effective_from of the employee's current OPEN row, or null if none yet.
function currentOpenFrom(db, employeeId) {
  const row = db
    .prepare('SELECT effective_from FROM employee_timeline WHERE employee_id=? AND effective_to IS NULL')
    .get(employeeId);
  return row ? row.effective_from : null;
}

// Append one ledger row for an employee. Closes the prior open row and opens a new
// full-snapshot row. Reads the employee's CURRENT live state for the snapshot.
//
// Backdating rule: effective_from may not be EARLIER than the current open row's
// effective_from (that would invert an interval / require mid-history re-chaining,
// out of scope now). Same-day is fine — effective_seq disambiguates. On violation
// this throws; callers surface it as 400. Chronological/forward writes are unaffected,
// as is backfill (it inserts strictly in audit-time order).
function recordEmployeeChange(db, opts) {
  const {
    employeeId,
    effectiveFrom,
    actionCode = null,
    reasonCode = null,
    reason = null,
    source = 'hr',
    changedBy = null,
    allowBackdateBefore = false, // backfill sets true (it controls its own ordering)
  } = opts || {};

  const emp = db.prepare(`SELECT ${SNAPSHOT_COLS} FROM employees WHERE id=?`).get(employeeId);
  if (!emp) return null; // employee vanished mid-txn — nothing to record

  const eff = toYMD(effectiveFrom);

  const openFrom = currentOpenFrom(db, employeeId);
  if (!allowBackdateBefore && openFrom && eff < openFrom) {
    const err = new Error(
      `Effective date ${eff} is before this employee's last recorded change (${openFrom}). ` +
        `Pick that date or later.`
    );
    err.code = 'EFFDT_BACKWARDS';
    throw err;
  }

  // EFFSEQ: next tiebreaker among rows already sharing this effective_from.
  const seq = db
    .prepare(
      'SELECT COALESCE(MAX(effective_seq), -1) + 1 AS seq FROM employee_timeline WHERE employee_id=? AND effective_from=?'
    )
    .get(employeeId, eff).seq;

  // Close the current open row (if any). effective_to = the new row's effective_from.
  db.prepare(
    'UPDATE employee_timeline SET effective_to=? WHERE employee_id=? AND effective_to IS NULL'
  ).run(eff, employeeId);

  // Open the new full-snapshot row. department_id/designation_id/manager_id stay
  // NULL — org-structure is parked; the free-text department/designation carry the
  // history now and the *_id columns fill in with zero rework when it resumes.
  const info = db
    .prepare(
      `INSERT INTO employee_timeline
         (employee_id, employee_name, department, designation, manager_id,
          salary, salary_exempt, roster, ot_eligible, status,
          effective_from, effective_seq, effective_to,
          action_code, reason_code, reason, source, changed_by)
       VALUES (?,?,?,?,?, ?,?,?,?,?, ?,?,?, ?,?,?,?,?)`
    )
    .run(
      emp.id, emp.name, emp.department, emp.designation, null,
      emp.salary, emp.salary_exempt, emp.roster, emp.ot_eligible, emp.status,
      eff, seq, null,
      actionCode, reasonCode, reason, source, changedBy
    );
  return info.lastInsertRowid;
}

// Seed the FIRST ("Hired") open row for a newly created employee. No reason prompt —
// a create has no before-state. Idempotent: does nothing if the employee already has
// a timeline row (so a re-run or a later backfill never double-seeds).
function seedHiredRow(db, opts) {
  const { employeeId, effectiveFrom, changedBy = null, source = 'hr' } = opts || {};
  const exists = db
    .prepare('SELECT 1 FROM employee_timeline WHERE employee_id=? LIMIT 1')
    .get(employeeId);
  if (exists) return null;
  const emp = db.prepare('SELECT join_date FROM employees WHERE id=?').get(employeeId);
  return recordEmployeeChange(db, {
    employeeId,
    effectiveFrom: effectiveFrom || (emp && emp.join_date) || istToday(),
    actionCode: 'Hired',
    reason: null,
    source,
    changedBy,
  });
}

// ── Backfill from audit_log — non-destructive, idempotent ─────────────────────
// Reconstructs history from the full-snapshot body_summary of each PUT audit row.
// NEVER alters live employees/users values; only inserts timeline rows and fills a
// NULL updated_at. Skips any employee that already has a timeline row. Pure (db
// injected) so it is unit-testable against a copy. Caller wraps in a transaction.
function backfillFromAudit(db) {
  const TRACK = ['status', 'salary', 'designation', 'department', 'roster'];
  const trackedKey = (o) => TRACK.map((k) => String(o[k] ?? '')).join('|');
  const toISO = (v) => { const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})/); return m ? m[1] : null; };
  const nowStamp = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().replace('T', ' ').slice(0, 19);

  const employees = db.prepare(
    `SELECT id, name, status, salary, salary_exempt, designation, department, roster, ot_eligible,
            join_date, created_at FROM employees`
  ).all();
  const auditRows = db.prepare(
    `SELECT entity_id, at, body_summary FROM audit_log
      WHERE entity_type='hr' AND path GLOB '/api/hr/employees/*' AND method='PUT' AND status_code=200
      ORDER BY at ASC`
  ).all();
  const byEmp = new Map();
  for (const a of auditRows) {
    let body; try { body = JSON.parse(a.body_summary); } catch { continue; }
    if (!body || typeof body !== 'object') continue;
    const id = Number(a.entity_id);
    if (!byEmp.has(id)) byEmp.set(id, []);
    byEmp.get(id).push({ at: a.at, body });
  }

  const insertOpen = db.prepare(
    `INSERT INTO employee_timeline
       (employee_id, employee_name, department, designation, salary, salary_exempt, roster, ot_eligible,
        status, effective_from, effective_seq, effective_to, action_code, reason_code, reason, source, changed_at)
     VALUES (@employee_id,@employee_name,@department,@designation,@salary,@salary_exempt,@roster,@ot_eligible,
        @status,@effective_from,@effective_seq,NULL,@action_code,NULL,@reason,'backfill',@at)`
  );
  const closePrev = db.prepare('UPDATE employee_timeline SET effective_to=? WHERE employee_id=? AND effective_to IS NULL');
  const seqFor = db.prepare('SELECT COALESCE(MAX(effective_seq),-1)+1 AS s FROM employee_timeline WHERE employee_id=? AND effective_from=?');
  const setUpdated = db.prepare('UPDATE employees SET updated_at=? WHERE id=? AND updated_at IS NULL');
  const hasRow = db.prepare('SELECT 1 FROM employee_timeline WHERE employee_id=? LIMIT 1');

  const RECON = '(reconstructed from audit log — from-values inferred, reason unavailable)';
  let processed = 0, changes = 0, seeded_only = 0, skipped = 0, updated_seeded = 0;

  const run = db.transaction(() => {
    for (const e of employees) {
      if (hasRow.get(e.id)) { skipped++; continue; }

      const snaps = byEmp.get(e.id) || [];
      const states = [];
      let lastKey = null;
      for (const s of snaps) {
        const b = s.body;
        const snap = { status: b.status, salary: b.salary, designation: b.designation, department: b.department,
          roster: b.roster, salary_exempt: b.salary_exempt, ot_eligible: b.ot_eligible, name: b.name };
        const k = trackedKey(snap);
        if (k !== lastKey) { states.push({ from: toISO(s.at) || toISO(e.created_at), snap }); lastKey = k; }
      }
      const liveSnap = { status: e.status, salary: e.salary, designation: e.designation, department: e.department,
        roster: e.roster, salary_exempt: e.salary_exempt, ot_eligible: e.ot_eligible, name: e.name };

      const anchorFrom = (snaps.length ? toISO(snaps[snaps.length - 1].at) : null)
        || toISO(e.join_date) || toISO(e.created_at) || istToday();

      if (!states.length || trackedKey(states[states.length - 1].snap) !== trackedKey(liveSnap)) {
        states.push({ from: anchorFrom, snap: liveSnap });
      }

      states.forEach((st, i) => {
        const from = st.from;
        closePrev.run(from, e.id);
        const seq = seqFor.get(e.id, from).s;
        insertOpen.run({
          employee_id: e.id,
          employee_name: st.snap.name || e.name,
          department: st.snap.department ?? null,
          designation: st.snap.designation ?? null,
          salary: st.snap.salary ?? null,
          salary_exempt: st.snap.salary_exempt ?? null,
          roster: st.snap.roster ?? null,
          ot_eligible: st.snap.ot_eligible ?? null,
          status: st.snap.status ?? null,
          effective_from: from,
          effective_seq: seq,
          action_code: i === 0 ? (snaps.length ? 'Reconstructed' : 'Hired') : 'Reconstructed',
          reason: snaps.length ? RECON : null,
          at: nowStamp(),
        });
      });

      const lastAt = snaps.length ? snaps[snaps.length - 1].at : (e.created_at || null);
      if (lastAt) { const r = setUpdated.run(lastAt, e.id); if (r.changes) updated_seeded++; }

      processed++;
      if (states.length > 1) changes += states.length - 1; else seeded_only++;
    }
  });
  run();
  return { processed, changes, seeded_only, skipped, updated_seeded };
}

module.exports = { recordEmployeeChange, seedHiredRow, backfillFromAudit, istToday, toYMD };
