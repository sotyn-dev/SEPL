// Rate Radar — vendor price intelligence for an item.
//
// For any item_master_id returns:
//   - summary: lowest / highest / average finalized rate, total purchase
//     value, count of quotes, count of distinct vendors
//   - top_vendors: vendors ranked by # times their rate was finalized
//                  (with their average and most-recent rate)
//   - quotes: every vendor1/2/3 quote ever entered for an indent of this
//             item, with the indent number / site / date / who quoted
//   - finalized: every finalized rate for this item with vendor + indent +
//                when + by whom
//   - vendor_pos: every vendor PO that bought this item, with rate + qty
//                 (actual purchase rate, may differ from the finalized one
//                 if mam negotiated further when raising the PO)
//
// Used by the Procurement page Rate Radar drawer/popup so the purchase
// team can decide a fair rate before quoting.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/:item_master_id', requirePermission('procurement', 'view'), (req, res) => {
  const itemId = +req.params.item_master_id;
  if (!itemId) return res.status(400).json({ error: 'item_master_id required' });
  const db = getDb();

  const item = db.prepare('SELECT id, item_code, item_name, specification, size, uom, make, current_price, type FROM item_master WHERE id=?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  // All quotes (the 3 vendor columns) flattened to long form
  const quoteRows = db.prepare(
    `SELECT r.id as rate_id, r.created_at, r.status,
            i.indent_number, i.site_name,
            r.vendor1_name as v1n, r.vendor1_rate as v1r, r.vendor1_terms as v1t, r.vendor1_credit_days as v1d,
            r.vendor2_name as v2n, r.vendor2_rate as v2r, r.vendor2_terms as v2t, r.vendor2_credit_days as v2d,
            r.vendor3_name as v3n, r.vendor3_rate as v3r, r.vendor3_terms as v3t, r.vendor3_credit_days as v3d,
            r.final_vendor_name, r.final_rate, r.final_terms, r.final_credit_days,
            r.finalized_at, fu.name as finalized_by_name,
            ii.quantity, ii.unit
       FROM indent_item_rates r
       JOIN indent_items ii ON ii.id = r.indent_item_id
       JOIN indents i ON i.id = ii.indent_id
       LEFT JOIN users fu ON fu.id = r.finalized_by
      WHERE ii.item_master_id = ?
      ORDER BY r.created_at DESC`
  ).all(itemId);

  // Flatten to one row per (vendor, quote) so the table is easy to render
  const quotes = [];
  for (const r of quoteRows) {
    for (const n of [1, 2, 3]) {
      const name = r[`v${n}n`]; const rate = +r[`v${n}r`] || 0;
      if (name && rate > 0) {
        quotes.push({
          vendor: name, rate, terms: r[`v${n}t`], credit_days: r[`v${n}d`],
          indent_number: r.indent_number, site_name: r.site_name,
          when: r.created_at, status: r.status,
          quantity: r.quantity, unit: r.unit,
        });
      }
    }
  }

  // Finalized rates
  const finalized = quoteRows
    .filter(r => r.final_vendor_name && r.final_rate > 0)
    .map(r => ({
      vendor: r.final_vendor_name, rate: r.final_rate, terms: r.final_terms,
      credit_days: r.final_credit_days, indent_number: r.indent_number,
      site_name: r.site_name, when: r.finalized_at, by: r.finalized_by_name,
      quantity: r.quantity, unit: r.unit,
    }));

  // Vendor PO line items — actual purchase rates
  const vendorPos = db.prepare(
    `SELECT vp.po_number, vp.po_date, v.name as vendor_name,
            vpi.quantity, vpi.rate, vpi.amount, vpi.terms, vpi.credit_days,
            i.indent_number
       FROM vendor_po_items vpi
       JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
       LEFT JOIN vendors v ON v.id = vp.vendor_id
       JOIN indent_items ii ON ii.id = vpi.indent_item_id
       JOIN indents i ON i.id = ii.indent_id
      WHERE ii.item_master_id = ?
      ORDER BY vp.po_date DESC, vp.created_at DESC`
  ).all(itemId);

  // Summary stats over finalized rates (the rates SEPL actually committed to)
  const summary = (() => {
    if (finalized.length === 0) {
      return { count_finalized: 0, count_quotes: quotes.length, count_vendors: new Set(quotes.map(q => q.vendor)).size };
    }
    const rates = finalized.map(f => +f.rate);
    return {
      count_finalized: finalized.length,
      count_quotes: quotes.length,
      count_vendors: new Set([...quotes.map(q => q.vendor), ...finalized.map(f => f.vendor)]).size,
      min_rate: Math.min(...rates),
      max_rate: Math.max(...rates),
      avg_rate: +(rates.reduce((a, b) => a + b, 0) / rates.length).toFixed(2),
      total_value: +finalized.reduce((s, f) => s + (+f.rate * +f.quantity || 0), 0).toFixed(2),
      latest_rate: finalized[0].rate,
      latest_vendor: finalized[0].vendor,
      latest_when: finalized[0].when,
    };
  })();

  // Top vendors by # times finalized
  const vendorAgg = new Map();
  for (const f of finalized) {
    if (!vendorAgg.has(f.vendor)) vendorAgg.set(f.vendor, { vendor: f.vendor, count: 0, rates: [], latest: null });
    const v = vendorAgg.get(f.vendor);
    v.count += 1;
    v.rates.push(+f.rate);
    if (!v.latest || f.when > v.latest.when) v.latest = { rate: +f.rate, when: f.when };
  }
  const top_vendors = [...vendorAgg.values()]
    .map(v => ({
      vendor: v.vendor,
      times_selected: v.count,
      avg_rate: +(v.rates.reduce((a, b) => a + b, 0) / v.rates.length).toFixed(2),
      min_rate: Math.min(...v.rates),
      latest_rate: v.latest?.rate,
      latest_when: v.latest?.when,
    }))
    .sort((a, b) => b.times_selected - a.times_selected || a.avg_rate - b.avg_rate);

  // Recommended vendor: lowest average among the top 3 selected
  const recommended = top_vendors.length > 0
    ? [...top_vendors].sort((a, b) => a.avg_rate - b.avg_rate)[0]
    : null;

  res.json({ item, summary, top_vendors, recommended, finalized, quotes, vendor_pos: vendorPos });
});

module.exports = router;
