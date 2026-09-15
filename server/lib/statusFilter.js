// ONE place for "?status=a,b,c" list filters.
//
// Every list screen shipped the same single-value filter:
//     if (status) { where.push('x.status = ?'); params.push(status); }
// Mam asked for multi-select status pickers (2026-09-12: "its good option if
// status like other drop dwon multiple can selects"), so all of them have to
// accept a comma list. Eight routes doing their own string splitting is eight
// chances to get the placeholder count wrong, so the parsing — and the safety
// rule — live here instead.
//
// SAFETY. Values are matched against the caller's OWN allow-list BEFORE the
// placeholders are built, so the number of `?` always equals the number of
// bound params and an unknown value can never widen the query — it is simply
// dropped. Nothing from the query string is ever interpolated into SQL; the
// column name is checked against a strict identifier pattern because it is the
// only part that is concatenated, and it always comes from our own code.
//
// Usage:
//     const st = statusFilter(req.query.status, STATUSES, 'c.status');
//     if (st) { where.push(st.sql); params.push(...st.params); }
//
// Returns null when nothing valid was asked for, so the caller leaves the
// query unfiltered — exactly how these screens behaved before. That null is
// also the honest answer to "did the user actually pick a status?", which some
// routes need for their own defaults (pmstasks hides approved tasks unless a
// status was chosen).
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;

function statusFilter(raw, allowed, column) {
  if (!IDENT.test(String(column || ''))) {
    // Our own bug, never user input — fail loudly rather than build odd SQL.
    throw new Error(`statusFilter: unsafe column name ${column}`);
  }
  const ok = new Set((allowed || []).map(s => String(s).toLowerCase()));
  // A single value, a comma list, or an array (axios can send either) all end
  // up as the same clean, de-duplicated set.
  const asText = Array.isArray(raw) ? raw.join(',') : String(raw == null ? '' : raw);
  const picked = [...new Set(asText.split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => s && ok.has(s)))];
  if (!picked.length) return null;
  return picked.length === 1
    ? { sql: `${column} = ?`, params: picked, values: picked }
    : { sql: `${column} IN (${picked.map(() => '?').join(',')})`, params: picked, values: picked };
}

module.exports = { statusFilter };
