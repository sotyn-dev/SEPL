// Delivery Bill of an indent — ONE implementation, used by the indent list and
// by the delivery-bill audit print (mam 2026-09-11: "show here delivery bill pdf
// so that i can audit"), so the PDF can never disagree with the list.
//
// (mam 2026-06-16) Billable = Σ (client SALE rate × indent qty). The sale rate
// comes from the priced BOQ (po_items), resolved EXACTLY like the Sales Bill:
// the line's po_item link first, then a description match within the same
// order's BOQ. FOC / RGP lines are not billed to the client (rate 0, mam
// 2026-06-24). Delivery Bill = Billable × the order's Against-Delivery %.
//
// Besides the numbers, the resolver says WHERE each one came from — which order
// (Business Book), why that order, which rate source per line, and whose % —
// because that is what an audit needs to check.

const parsePct = (v) => parseFloat(String(v || '').replace(/[^0-9.]/g, '')) || 0;

function makeDeliveryBillResolver(db) {
  // po_item id → { rate, business_book } — one pass, reused for every indent.
  const poItemById = new Map();
  for (const p of db.prepare('SELECT id, business_book_id, rate FROM po_items').all()) {
    poItemById.set(p.id, { rate: +p.rate || 0, bb: p.business_book_id });
  }
  // Per-order description → rate (the fallback when a line has no usable
  // po_item rate) — only priced rows.
  const bbDescCache = new Map();
  const bbDescMap = (bbId) => {
    if (bbDescCache.has(bbId)) return bbDescCache.get(bbId);
    const m = new Map();
    for (const p of db.prepare('SELECT description, rate FROM po_items WHERE business_book_id=?').all(bbId)) {
      if (p.description && +p.rate > 0) m.set(String(p.description).toLowerCase().trim(), +p.rate || 0);
    }
    bbDescCache.set(bbId, m);
    return m;
  };
  // The order's Against-Delivery % (used when the planning join didn't carry it).
  const bbPctCache = new Map();
  const bbPct = (bbId) => {
    if (bbPctCache.has(bbId)) return bbPctCache.get(bbId);
    const row = db.prepare('SELECT payment_against_delivery FROM business_book WHERE id=?').get(bbId);
    const pct = parsePct(row && row.payment_against_delivery);
    bbPctCache.set(bbId, pct);
    return pct;
  };
  // site / project name → order, the same way the BOQ link is found
  // (sites.business_book_id, else a project / company name match).
  const bbIdBySiteCache = new Map();
  const bbIdForSite = (siteName) => {
    if (!siteName) return null;
    if (bbIdBySiteCache.has(siteName)) return bbIdBySiteCache.get(siteName);
    const row = db.prepare(
      `SELECT id FROM business_book
        WHERE id IN (SELECT DISTINCT business_book_id FROM sites
                      WHERE name = ? AND business_book_id IS NOT NULL)
           OR project_name = ? OR company_name = ?
        ORDER BY id DESC LIMIT 1`
    ).get(siteName, siteName, siteName);
    const id = row?.id || null;
    bbIdBySiteCache.set(siteName, id);
    return id;
  };

  // indent: { business_book_id (via planning), bb_delivery_terms, site_name, client_name }
  // items:  indent_items rows with quantity, description, item_type, po_item_id.
  // Sets it.boq_sale_rate / it.billable_line on each item (the list shows them).
  return function resolve(indent, items) {
    // Which order: planning link first, else the first line's po_item order,
    // else the indent's site → order mapping.
    let bbId = indent.business_book_id || null;
    let bbSource = bbId ? 'planning' : null;
    if (!bbId) {
      for (const it of items) {
        const po = it.po_item_id != null ? poItemById.get(it.po_item_id) : null;
        if (po && po.bb) { bbId = po.bb; bbSource = 'po_item'; break; }
      }
    }
    if (!bbId) {
      bbId = bbIdForSite(indent.site_name || indent.client_name || '');
      if (bbId) bbSource = 'site';
    }
    const descMap = bbId ? bbDescMap(bbId) : null;

    let billable = 0;
    const lines = [];
    for (const it of items) {
      let rate = 0;
      let rateSource = 'none';
      const t = String(it.item_type || '').toUpperCase();
      if (t === 'FOC' || t === 'RGP') {
        rateSource = 'not_billed';
      } else {
        const po = it.po_item_id != null ? poItemById.get(it.po_item_id) : null;
        if (po && po.rate > 0) { rate = po.rate; rateSource = 'po_item'; }
        if (!rate && descMap) {
          rate = descMap.get(String(it.description || '').toLowerCase().trim()) || 0;
          if (rate) rateSource = 'boq_description';
        }
      }
      it.boq_sale_rate = +rate.toFixed(2);
      it.billable_line = +(rate * (+it.quantity || 0)).toFixed(2);
      billable += rate * (+it.quantity || 0);
      lines.push({ id: it.id, rate: it.boq_sale_rate, rate_source: rateSource, billable: it.billable_line });
    }

    // Whose %: the planning order's term first, else the resolved order's.
    let pct = parsePct(indent.bb_delivery_terms);
    let pctSource = pct ? 'planning' : null;
    if (!pct && bbId) {
      pct = bbPct(bbId);
      if (pct) pctSource = 'business_book';
    }
    return {
      business_book_id: bbId,
      bb_source: bbSource,
      pct,
      pct_source: pctSource,
      billable,
      delivery: pct > 0 ? billable * pct / 100 : 0,
      lines,
    };
  };
}

module.exports = { makeDeliveryBillResolver, parsePct };
