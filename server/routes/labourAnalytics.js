// Labour Analytics (director ask, 2026-07-26): "calculate in different
// module all labour consumed, target vs actual, manhours, budget everything".
//
// One row per project (business_book grouping, same normalized-name
// convention as /hr/manpower-plan):
//   budget_labour        — Σ po_items labour value (labour_amount when set,
//                          else 11% of SITC qty×rate — same convention the
//                          DPR uses for Table-A labour rates)
//   consumed_labour_cost — Σ DPR Table-B Skilled+Helper amounts
//   consumed_all_cost    — Σ DPR grand_total_b (labour + staff + rentals…)
//   work_value           — Σ DPR grand_total_a (labour billing value earned)
//   manhours             — Σ (skilled+helper qty + contractor manpower) × 8h
//   required_manpower    — value-slab target (same slab as HR Manpower Plan)
//   avg_manpower         — average daily manpower across filed DPRs
//   productivity         — work_value ÷ manhours (₹ earned per manhour)

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Value slab → required manpower. Duplicated from routes/hr.js (not
// exported there); keep the two in sync if the slab ever changes.
const LAKH = 100000, CRORE = 10000000;
function requiredManpower(v) {
  v = +v || 0;
  if (v <= 5 * LAKH) return 4;
  if (v <= 25 * LAKH) return 6;
  if (v <= 50 * LAKH) return 8;
  if (v <= 1 * CRORE) return 10;
  if (v <= 5 * CRORE) return 15;
  if (v <= 10 * CRORE) return 25;
  return 40;
}
const HOURS_PER_DAY = 8;

router.get('/', requirePermission('dpr', 'view'), (req, res) => {
  const db = getDb();
  const dateFrom = String(req.query.date_from || '').slice(0, 10) || null;
  const dateTo = String(req.query.date_to || '').slice(0, 10) || null;

  const bbs = db.prepare(`SELECT id, project_name, company_name, client_name, lead_no, po_amount FROM business_book`).all();
  const sites = db.prepare(`SELECT id, business_book_id FROM sites`).all();
  const norm = s => String(s || '').trim();
  const keyOf = bb => (norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name)
    || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`)).toLowerCase();
  const groups = new Map();
  const groupByBB = new Map();
  for (const bb of bbs) {
    const key = keyOf(bb);
    groupByBB.set(bb.id, key);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        project: norm(bb.project_name) || norm(bb.company_name) || norm(bb.client_name) || (bb.lead_no ? `Lead ${bb.lead_no}` : `BB#${bb.id}`),
        value: 0, budget_labour: 0,
        consumed_labour_cost: 0, consumed_all_cost: 0, work_value: 0,
        manhours: 0, dpr_days: 0, manpower_sum: 0,
      });
    }
    groups.get(key).value += +bb.po_amount || 0;
  }
  const siteToKey = new Map();
  for (const s of sites) {
    const k = groupByBB.get(s.business_book_id);
    if (k) siteToKey.set(s.id, k);
  }

  // Labour budget from BOQ lines.
  try {
    const items = db.prepare(`
      SELECT business_book_id,
             COALESCE(SUM(CASE WHEN COALESCE(labour_amount,0) > 0 THEN labour_amount
                               ELSE COALESCE(quantity,0) * COALESCE(rate,0) * 0.11 END), 0) AS labour_budget
        FROM po_items GROUP BY business_book_id`).all();
    for (const it of items) {
      const g = groups.get(groupByBB.get(it.business_book_id));
      if (g) g.budget_labour += +it.labour_budget || 0;
    }
  } catch (e) { /* po_items absent */ }

  // Per-DPR rollup: labour cost rows, totals, headcount for manhours.
  let dateClause = '';
  const params = [];
  if (dateFrom) { dateClause += ' AND d.report_date >= ?'; params.push(dateFrom); }
  if (dateTo) { dateClause += ' AND d.report_date <= ?'; params.push(dateTo); }
  const dprs = db.prepare(`
    SELECT d.id, d.site_id, d.grand_total_a, d.grand_total_b, d.contractor_manpower,
           COALESCE((SELECT SUM(dc.manpower) FROM dpr_contractors dc WHERE dc.dpr_id = d.id), 0) AS contractor_mp,
           COALESCE((SELECT SUM(dm.shortage) FROM dpr_manpower dm WHERE dm.dpr_id = d.id
                      AND LOWER(dm.trade) IN ('skilled manpower','helper','skilled')), 0) AS labour_cost,
           COALESCE((SELECT SUM(dm.required) FROM dpr_manpower dm WHERE dm.dpr_id = d.id
                      AND LOWER(dm.trade) IN ('skilled manpower','helper','skilled')), 0) AS labour_heads
      FROM dpr d
     WHERE COALESCE(d.is_planned_template, 0) = 0 ${dateClause}`).all(...params);
  for (const d of dprs) {
    const g = groups.get(siteToKey.get(d.site_id));
    if (!g) continue;
    const contractorHeads = +d.contractor_mp > 0 ? +d.contractor_mp : (+d.contractor_manpower || 0);
    const heads = (+d.labour_heads || 0) + contractorHeads;
    g.consumed_labour_cost += +d.labour_cost || 0;
    g.consumed_all_cost += +d.grand_total_b || 0;
    g.work_value += +d.grand_total_a || 0;
    g.manhours += heads * HOURS_PER_DAY;
    g.dpr_days += 1;
    g.manpower_sum += heads;
  }

  const rows = [...groups.values()]
    .filter(g => g.dpr_days > 0 || g.budget_labour > 0)
    .map(g => {
      const required = requiredManpower(g.value);
      const avgMp = g.dpr_days ? Math.round((g.manpower_sum / g.dpr_days) * 10) / 10 : 0;
      return {
        key: g.key,
        project: g.project,
        value: Math.round(g.value),
        budget_labour: Math.round(g.budget_labour),
        consumed_labour_cost: Math.round(g.consumed_labour_cost),
        consumed_all_cost: Math.round(g.consumed_all_cost),
        budget_used_pct: g.budget_labour > 0 ? Math.round((g.consumed_labour_cost / g.budget_labour) * 100) : null,
        work_value: Math.round(g.work_value),
        manhours: Math.round(g.manhours),
        productivity_per_hour: g.manhours > 0 ? Math.round(g.work_value / g.manhours) : null,
        required_manpower: required,
        avg_manpower: avgMp,
        manpower_coverage_pct: required > 0 ? Math.round((avgMp / required) * 100) : null,
        dpr_days: g.dpr_days,
      };
    })
    .sort((a, b) => (b.budget_used_pct ?? -1) - (a.budget_used_pct ?? -1));

  res.json({ date_from: dateFrom, date_to: dateTo, rows });
});

module.exports = router;
