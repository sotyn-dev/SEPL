// These are the two owner-authorised production delivery tests verified on
// 15 Oct 2026. Require BOTH CRM number and website reference; never classify a
// real prospect by a word such as "test", their phone, or an incoming flag.
const CONFIRMED_TESTS = Object.freeze([
  { leadNo: 'SEPL9398', reference: 'SEPL-20261015-EAA0BCA2' },
  { leadNo: 'SEPL9399', reference: 'SEPL-20261015-A14F8259' },
]);

function reportLeadScope() {
  const predicate = `source = 'Website' AND (${CONFIRMED_TESTS.map(() =>
    '(lead_no = ? AND instr(COALESCE(remarks, \'\'), ?) > 0)').join(' OR ')})`;
  const params = CONFIRMED_TESTS.flatMap(t => [t.leadNo, `Website ref: ${t.reference}`]);
  // COALESCE matters: legacy NULL sources are genuine records, not exclusions.
  return {
    cte: `WITH report_leads AS (SELECT * FROM sales_funnel WHERE NOT COALESCE((${predicate}), 0))`,
    excludedSql: `SELECT COUNT(*) AS count FROM sales_funnel WHERE ${predicate}`,
    params,
  };
}

module.exports = { CONFIRMED_TESTS, reportLeadScope };
