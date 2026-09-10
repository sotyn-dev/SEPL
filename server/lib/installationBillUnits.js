const normalize = value => String(value || '').toLowerCase().replace(/\s+/g, ' ').trim();

// Resolve units independently of rates: even a zero-rate PO line owns its UOM.
function resolveInstallationBillUnits(db, bill, items) {
  if (+bill.bill_type !== 3) return items;
  const linked = db.prepare(`
    SELECT wi.description, p.id AS current_po_item_id, p.description AS po_description,
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
    const currentMatches = matches.filter(row => row.current_po_item_id);
    const orderMatches = po.filter(row => normalize(row.description) === key);
    const candidates = currentMatches.length ? currentMatches : orderMatches.length ? orderMatches : matches;
    const units = [...new Set(candidates.map(row => String(row.unit || '').trim()).filter(Boolean))];
    // Old bill lines have no PO ID. Preserve the stored unit if ambiguous.
    return units.length === 1 ? { ...item, unit: units[0] } : item;
  });
}

// Update stored historical units as well as the read/print view. Never change
// quantities, rates, totals or material-stock units (which have their own UOM).
function syncInstallationUnits(db, businessBookId = null) {
  return db.transaction(() => {
    const poRows = db.prepare('SELECT id, po_id, business_book_id, description, unit FROM po_items').all();
    const byId = new Map(poRows.map(row => [row.id, row]));
    const work = db.prepare(`SELECT wi.id, wi.po_item_id, wi.description, wi.unit,
      s.po_id, s.business_book_id FROM dpr_work_items wi
      JOIN dpr d ON d.id = wi.dpr_id JOIN sites s ON s.id = d.site_id
      WHERE (? IS NULL OR s.business_book_id = ?)` ).all(businessBookId, businessBookId);
    const updateWork = db.prepare('UPDATE dpr_work_items SET po_item_id=?, unit=? WHERE id=?');
    let workUpdated = 0;
    for (const row of work) {
      let source = byId.get(row.po_item_id);
      if (!source) {
        const key = normalize(row.description);
        const candidates = poRows.filter(p => key && normalize(p.description) === key
          && (row.po_id ? p.po_id === row.po_id : row.business_book_id && p.business_book_id === row.business_book_id));
        if (candidates.length === 1) source = candidates[0];
      }
      if (source?.unit?.trim() && (row.po_item_id !== source.id || row.unit !== source.unit)) {
        workUpdated += updateWork.run(source.id, source.unit, row.id).changes;
      }
    }
    const bills = db.prepare(`SELECT id, bill_type, business_book_id FROM sales_bills
      WHERE bill_type=3 AND (? IS NULL OR business_book_id=?)`).all(businessBookId, businessBookId);
    const getItems = db.prepare('SELECT * FROM sales_bill_items WHERE sales_bill_id=?');
    const updateItem = db.prepare('UPDATE sales_bill_items SET unit=? WHERE id=?');
    let billsUpdated = 0;
    for (const bill of bills) {
      const items = getItems.all(bill.id);
      const resolved = resolveInstallationBillUnits(db, bill, items);
      resolved.forEach((item, index) => {
        if (item.unit !== items[index].unit) billsUpdated += updateItem.run(item.unit, item.id).changes;
      });
    }
    return { workUpdated, billsUpdated };
  })();
}

module.exports = { resolveInstallationBillUnits, syncInstallationUnits };
