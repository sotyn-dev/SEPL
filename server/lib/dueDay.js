// The scoring "due day" expression — ONE definition shared by the scorecard
// queries (routes/scoring.js) and the expression indexes that make them fast
// (db/schema.js hotPathIndexes). SQLite only uses an index on an expression
// when the query's expression is structurally identical, so both sides MUST
// build it from this function — never retype it.
//
// Rules (pre-push review 2026-09-05):
//  • undated rows fall back to the IST calendar day they were created —
//    created_at is UTC, so a 00:00–05:29 IST creation would otherwise slide
//    to the previous day (same '+330 minutes' shift the snag formula uses);
//  • the scoring week is Mon–Sat, so a SUNDAY due day is folded into the
//    Saturday before it: it belongs to the week that just ended, never to no
//    week at all.
//
// Hang audit 2026-09-05: without an index every scorecard KPI count walked all
// of a user's tasks evaluating date()/strftime() per row; the leaderboard ran
// that ~100 times (users × weeks). The expression indexes below turn each
// count into an index range seek (measured 25 ms → <0.1 ms per query).
const dueDay = (col, alias = '') => {
  const d = `COALESCE(date(NULLIF(${alias}${col}, '')), date(${alias}created_at, '+330 minutes'))`;
  return `(CASE WHEN strftime('%w', ${d}) = '0' THEN date(${d}, '-1 day') ELSE ${d} END)`;
};

// [table, owner column, due column] — every (table, owner) pair the scorecard
// counts on the due-day basis. A table can appear twice with different owner
// columns (System Flow steps are scored for the Responsible AND the Developer).
const DUE_SOURCES = [
  ['pms_tasks', 'assigned_to', 'due_date'],
  ['delegations', 'assigned_to', 'due_date'],
  ['support_tickets', 'assigned_to', 'deadline_date'],
  // ERP Management (System Flow) — mam 2026-09-07 "ERP Management also show
  // here … not as RACI, according to developer": scored on the DEVELOPER column.
  ['sysflow_flows', 'developer_id', 'target_date'],
];

function dueDayIndexSql() {
  const out = [
    // First-cut names (2026-09-05, never deployed) carried no owner column, so a
    // second owner on the same table would have collided. Retire them, plus the
    // responsible_id variant that was dropped when mam chose developer-basis.
    'DROP INDEX IF EXISTS idx_pms_tasks_due_day_owner',
    'DROP INDEX IF EXISTS idx_delegations_due_day_owner',
    'DROP INDEX IF EXISTS idx_support_tickets_due_day_owner',
    'DROP INDEX IF EXISTS idx_sysflow_flows_due_day_responsible_id',
  ];
  const seenTable = new Set();
  for (const [table, owner, col] of DUE_SOURCES) {
    const expr = dueDay(col);
    out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_due_day_${owner} ON ${table}(${owner}, ${expr})`);
    if (!seenTable.has(table)) {
      seenTable.add(table);
      out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_due_day ON ${table}(${expr})`);
    }
  }
  return out;
}

module.exports = { dueDay, dueDayIndexSql, DUE_SOURCES };
