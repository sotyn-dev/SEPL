// Delivery notes describe the physical consignment, never the whole client BOQ.
function vendorItems(db, poId) {
  return db.prepare(`SELECT vpi.id AS vendor_po_item_id, ii.id AS indent_item_id,
    ii.item_master_id, vpi.quantity, ii.description, ii.item_type,
    CASE WHEN ii.unit_overridden=1 AND TRIM(COALESCE(ii.unit,''))<>''
      THEN ii.unit ELSE COALESCE(NULLIF(TRIM(im.uom),''),ii.unit) END AS unit,
    im.item_name, im.item_code, COALESCE(vpi.specification,im.specification) AS specification,
    im.size, COALESCE(im.make,ii.make) AS make, poi.hsn_code, poi.business_book_id
    FROM vendor_po_items vpi LEFT JOIN indent_items ii ON ii.id=vpi.indent_item_id
    LEFT JOIN item_master im ON im.id=ii.item_master_id
    LEFT JOIN po_items poi ON poi.id=ii.po_item_id
    WHERE vpi.vendor_po_id=? ORDER BY vpi.id`).all(poId);
}

function challanItems(db, dn, fallbackItems = []) {
  const linked = dn.vendor_po_id ? vendorItems(db, dn.vendor_po_id) : [];
  const hasSnapshot = dn.items_json != null && String(dn.items_json).trim() !== '';
  let rows = linked.length ? linked : fallbackItems;
  if (hasSnapshot) {
    try { rows = JSON.parse(dn.items_json); } catch { throw new Error('This delivery note has invalid saved items. Correct its items before printing.'); }
    if (!Array.isArray(rows)) throw new Error('This delivery note has invalid saved items. Correct its items before printing.');
  }
  return rows.filter(it => it && it.include !== false).map(it => {
    const poItem = it.vendor_po_item_id == null ? null : linked.find(p => p.vendor_po_item_id === +it.vendor_po_item_id);
    if (it.vendor_po_item_id != null && !poItem) throw new Error('A saved delivery item does not belong to this PO. Correct it before printing.');
    let master = null;
    if (it.item_master_id) master = db.prepare('SELECT item_name,item_code,specification,size,make,uom FROM item_master WHERE id=?').get(it.item_master_id);
    else if (it.item_code) master = db.prepare('SELECT item_name,item_code,specification,size,make,uom FROM item_master WHERE item_code=?').get(it.item_code);
    const base = { ...master, ...poItem };
    const quantity = Number(it.quantity ?? it.qty ?? it.received_qty ?? it.ordered_qty ?? base.quantity ?? 0);
    if (!Number.isFinite(quantity) || quantity < 0) throw new Error('This delivery note has an invalid quantity. Correct it before printing.');
    return { ...base, ...it, quantity,
      description: it.description || base.description || it.item_name || base.item_name || '',
      item_name: it.item_name || base.item_name || '', item_code: it.item_code || base.item_code || '',
      specification: it.specification || base.specification || '', size: it.size || base.size || '',
      make: it.make || base.make || '', unit: it.unit || it.uom || base.unit || base.uom || '',
      hsn_code: it.hsn_code || it.hsn || base.hsn_code || '',
    };
  }).filter(it => it.quantity > 0);
}

function fillChallanParties(db, dn) {
  // Exact item/order links take precedence. Never guess between multiple sites
  // belonging to the same customer just because one row is newer.
  const linked = dn.vendor_po_id ? vendorItems(db, dn.vendor_po_id) : [];
  const orderIds = [...new Set(linked.map(it => it.business_book_id).filter(Boolean))];
  let bb = orderIds.length === 1 ? db.prepare('SELECT * FROM business_book WHERE id=?').get(orderIds[0]) : null;
  if (!bb && dn.business_book_id) bb = db.prepare('SELECT * FROM business_book WHERE id=?').get(dn.business_book_id);
  if (!bb && !orderIds.length) {
    const names = [...new Set([dn.site_name, dn.indent_client_name, dn.client_company]
      .map(n => String(n || '').replace(/^\s*M\/?s\.?\s*/i, '').trim()).filter(Boolean))];
    for (const name of names) {
      const bySite = db.prepare(`SELECT DISTINCT bb.* FROM sites s JOIN business_book bb ON bb.id=s.business_book_id
        WHERE UPPER(TRIM(s.name))=UPPER(?)`).all(name);
      if (bySite.length === 1) { bb = bySite[0]; break; }
      const byProject = db.prepare('SELECT * FROM business_book WHERE UPPER(TRIM(project_name))=UPPER(?)').all(name);
      if (byProject.length === 1) { bb = byProject[0]; break; }
      const byName = db.prepare(`SELECT * FROM business_book WHERE UPPER(TRIM(company_name))=UPPER(?)
        OR UPPER(TRIM(client_name))=UPPER(?)`).all(name, name);
      if (byName.length === 1) { bb = byName[0]; break; }
    }
  }
  if (bb) {
    const fields = { client_company:'company_name', client_person_name:'client_name', client_phone:'client_contact',
      client_email:'client_email', client_address:'billing_address', site_address:'shipping_address',
      client_gstin:'gstin', client_state:'state', client_state_code:'state_code', bb_lead_no:'lead_no' };
    for (const [target, source] of Object.entries(fields)) dn[target] = bb[source] || dn[target];
    dn.site_name ||= bb.project_name;
  }
  return dn;
}

module.exports = { vendorItems, challanItems, fillChallanParties };
