// Match Daily Reports' Actual Cost (B-actual), using the stored daily total
// already recomputed across shifts. Planned-only rows display no Actual Cost.
// Report dates, rather than submission/approval times, select the period.
function dprActualCostScore(db, sinceDate, untilDate, options = {}) {
  const filters = [];
  const args = [sinceDate, untilDate];
  if (Object.prototype.hasOwnProperty.call(options, 'userId')) {
    const userId = Number(options.userId);
    if (!Number.isSafeInteger(userId) || userId <= 0) return { given: null, done: 0 };
    filters.push('submitted_by=?');
    args.push(userId);
  }
  if (Object.prototype.hasOwnProperty.call(options, 'siteIds')) {
    const siteIds = [...new Set((Array.isArray(options.siteIds) ? options.siteIds : [])
      .map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    // An employee without mapped sites must never fall back to all sites.
    if (!siteIds.length) return { given: null, done: 0 };
    filters.push(`site_id IN (${siteIds.map(() => '?').join(',')})`);
    args.push(...siteIds);
  }
  const scopeFilter = filters.length ? ` AND ${filters.join(' AND ')}` : '';
  const { amount } = db.prepare(`SELECT COALESCE(SUM(grand_total_b),0) AS amount
    FROM dpr WHERE report_date BETWEEN ? AND ?
      AND COALESCE(is_planned_template,0)=0${scopeFilter}`).get(...args);
  // A null GIVEN leaves the comparison target to manual/template Plan entry.
  return { given: null, done: Math.round(amount * 100) / 100 };
}

module.exports = { dprActualCostScore };
