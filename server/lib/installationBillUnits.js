const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Resolve units independently of rates: even a zero-rate PO line owns its UOM.
function resolveInstallationBillUnits(db, bill, items) {
  if (+bill.bill_type !== 3) return items;
  const linked = db.prepare(`
    SELECT wi.description, p.description AS po_description,
           COALESCE(NULLIF(TRIM(p.unit), ''), NULLIF(TRIM(wi.unit), '')) AS unit
    FROM dpr_work_items wi
    JOIN dpr d ON d.id = wi.dpr_id
    LEFT JOIN po_items p ON p.id = wi.po_item_id
    WHERE d.sales_bill_id = ?
  `).all(bill.id);
  const po = bill.business_book_id
    ? db.prepare('SELECT description, unit FROM po_items WHERE business_book_id = ?').all(bill.business_book_id)
    : [];
  return items.map(item => {
    const key = normalize(item.description);
    if (!key) return item;
    const matches = linked.filter(row => normalize(row.description) === key || normalize(row.po_description) === key);
    const candidates = matches.length ? matches : po.filter(row => normalize(row.description) === key);
    const units = [...new Set(candidates.map(row => String(row.unit || '').trim()).filter(Boolean))];
    // Old bill lines have no PO ID. Preserve the stored unit if ambiguous.
    return units.length === 1 ? { ...item, unit: units[0] } : item;
  });
}

module.exports = { resolveInstallationBillUnits };
