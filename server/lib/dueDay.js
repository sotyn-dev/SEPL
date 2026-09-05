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

// [table, owner column, due column] — the three sources the scorecard counts.
const DUE_SOURCES = [
  ['pms_tasks', 'assigned_to', 'due_date'],
  ['delegations', 'assigned_to', 'due_date'],
  ['support_tickets', 'assigned_to', 'deadline_date'],
];

function dueDayIndexSql() {
  const out = [];
  for (const [table, owner, col] of DUE_SOURCES) {
    const expr = dueDay(col);
    out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_due_day_owner ON ${table}(${owner}, ${expr})`);
    out.push(`CREATE INDEX IF NOT EXISTS idx_${table}_due_day ON ${table}(${expr})`);
  }
  return out;
}

module.exports = { dueDay, dueDayIndexSql, DUE_SOURCES };
