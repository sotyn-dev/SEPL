// Use the same PO/Business Book allotment paths as the DPR site picker.
function scorecardSiteIds(db, userId, userName) {
  const csv = `%,${userId},%`;
  return db.prepare(`SELECT DISTINCT s.id FROM sites s
    WHERE s.site_engineer_id=? OR s.supervisor_id=?
       OR (? <> '' AND LOWER(TRIM(COALESCE(s.supervisor,'')))=LOWER(TRIM(?)))
       OR EXISTS (SELECT 1 FROM purchase_orders po
         WHERE (po.id=s.po_id OR po.business_book_id=s.business_book_id)
           AND (po.site_engineer_id=?
             OR (',' || REPLACE(COALESCE(po.site_engineer_ids,''),' ','') || ',') LIKE ?
             OR (',' || REPLACE(COALESCE(po.jr_site_engineer_ids,''),' ','') || ',') LIKE ?
             OR (',' || REPLACE(COALESCE(po.supervisor_ids,''),' ','') || ',') LIKE ?))
    ORDER BY s.id`).all(userId, userId, userName.trim(), userName, userId, csv, csv, csv).map(r => r.id);
}
module.exports = { scorecardSiteIds };
