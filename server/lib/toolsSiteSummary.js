// Aggregate tools before resolving engineers so multiple assigned engineers or
// linked orders cannot duplicate the site's count or purchase value.
const TOOLS_SITE_SUMMARY_SQL = `
  SELECT totals.site_id,
         CASE WHEN totals.site_id IS NULL THEN 'Unassigned'
              ELSE COALESCE(s.name, 'Unknown site #' || totals.site_id) END AS site_name,
         (
           SELECT GROUP_CONCAT(engineer.name, ', ')
           FROM (
             SELECT u.name
             FROM users u
             WHERE u.id = s.site_engineer_id
                OR EXISTS (
                  SELECT 1 FROM purchase_orders po
                  WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
                    AND (po.site_engineer_id = u.id
                      OR (',' || REPLACE(COALESCE(po.site_engineer_ids, ''), ' ', '') || ',')
                         LIKE ('%,' || u.id || ',%'))
                )
             ORDER BY u.name, u.id
           ) engineer
         ) AS site_engineer_name,
         totals.tool_count,
         totals.tools_amount
  FROM (
    SELECT current_site_id AS site_id,
           SUM(quantity) AS tool_count,
           COALESCE(SUM(CASE WHEN status != 'scrapped' THEN purchase_price ELSE 0 END), 0) AS tools_amount
    FROM tools
    GROUP BY current_site_id
  ) totals
  LEFT JOIN sites s ON s.id = totals.site_id
  ORDER BY totals.site_id IS NULL, site_name COLLATE NOCASE, totals.site_id
`;

module.exports = { TOOLS_SITE_SUMMARY_SQL };
