/**
 * TSK-0824: Cost Estimate Auto-Approval Engine
 * "I will only approve items where cost is more than estimated otherwise auto approve"
 *
 * Implements Management by Exception (MBE):
 * - If actual cost <= estimated cost for all items -> Auto-approve L2.
 * - If actual cost > estimated cost -> Hold for manual L2 (MD) approval with overrun alerts.
 * - If items lack estimated benchmark -> Hold for manual L2 approval (safety fallback).
 */

/**
 * Evaluate the cost of all line items in a Vendor PO against their estimated benchmarks.
 *
 * Priority for estimated rate:
 * 1. poi.part_price  (Project BOQ planned purchase price)
 * 2. im.current_price (Catalog master purchase price)
 * 3. ir.marketing_rate (AI-estimated minimum market rate)
 * 4. ir.final_rate (Finalized vendor rate from indent stage)
 *
 * @param {object} db - better-sqlite3 instance
 * @param {number|string} poId - vendor_pos id
 * @param {object} [opts] - options: { tolerancePct: 0 }
 * @returns {object} Evaluation result
 */
function evaluatePoCostEstimate(db, poId, opts = {}) {
  const tolerancePct = Number(opts.tolerancePct ?? 0) || 0;

  const rows = db.prepare(`
    SELECT
      vpi.id as vpi_id,
      vpi.vendor_po_id,
      vpi.indent_item_id,
      vpi.quantity,
      vpi.rate as actual_rate,
      vpi.amount as actual_amount,
      vpi.description as po_description,
      ii.description as indent_description,
      ii.item_master_id,
      ii.po_item_id,
      im.item_name as master_name,
      im.item_code,
      im.current_price as master_price,
      poi.description as boq_description,
      poi.part_price as pp_rate,
      ir.marketing_rate,
      ir.final_rate as indent_final_rate
    FROM vendor_po_items vpi
    LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
    LEFT JOIN po_items poi ON poi.id = ii.po_item_id
    LEFT JOIN item_master im ON im.id = ii.item_master_id
    LEFT JOIN indent_item_rates ir ON ir.id = (
      SELECT MAX(r2.id) FROM indent_item_rates r2 WHERE r2.indent_item_id = ii.id
    )
    WHERE vpi.vendor_po_id = ?
    ORDER BY vpi.id
  `).all(+poId);

  if (!rows || rows.length === 0) {
    return {
      po_id: +poId,
      can_auto_approve: false,
      cost_status: 'unestimated',
      total_items: 0,
      total_actual_amount: 0,
      total_estimated_amount: 0,
      total_variance_amount: 0,
      total_variance_pct: 0,
      overrun_count: 0,
      within_count: 0,
      missing_count: 0,
      max_overrun_pct: 0,
      items: [],
      reason: 'No linked items found for cost evaluation',
    };
  }

  let totalActual = 0;
  let totalEstimated = 0;
  let overrunCount = 0;
  let withinCount = 0;
  let missingCount = 0;
  let maxOverrunPct = 0;

  const items = rows.map((r) => {
    const qty = +r.quantity || 0;
    const actualRate = +r.actual_rate || 0;
    const actualAmount = Math.round((+r.actual_amount || (actualRate * qty)) * 100) / 100;
    totalActual += actualAmount;

    // Resolve benchmark
    let estimatedRate = null;
    let benchmarkSource = null;

    if (+r.pp_rate > 0) {
      estimatedRate = +r.pp_rate;
      benchmarkSource = 'BOQ PP Rate';
    } else if (+r.master_price > 0) {
      estimatedRate = +r.master_price;
      benchmarkSource = 'Item Master';
    } else if (+r.marketing_rate > 0) {
      estimatedRate = +r.marketing_rate;
      benchmarkSource = 'Mktg Rate';
    } else if (+r.indent_final_rate > 0) {
      estimatedRate = +r.indent_final_rate;
      benchmarkSource = 'Finalized Quote';
    }

    if (estimatedRate == null || estimatedRate <= 0) {
      missingCount++;
      return {
        vpi_id: r.vpi_id,
        item_name: r.po_description || r.master_name || r.indent_description || 'Item',
        quantity: qty,
        actual_rate: actualRate,
        actual_amount: actualAmount,
        estimated_rate: null,
        estimated_amount: null,
        benchmark_source: 'None',
        variance_amount: 0,
        variance_pct: 0,
        is_overrun: false,
        is_within: false,
        is_missing: true,
      };
    }

    const estimatedAmount = Math.round(qty * estimatedRate * 100) / 100;
    totalEstimated += estimatedAmount;

    const allowedMaxRate = tolerancePct > 0
      ? estimatedRate * (1 + tolerancePct / 100)
      : estimatedRate;

    const isOverrun = actualRate > allowedMaxRate;
    const varianceAmt = Math.round((actualRate - estimatedRate) * qty * 100) / 100;
    const variancePct = Math.round(((actualRate - estimatedRate) / estimatedRate) * 1000) / 10;

    if (isOverrun) {
      overrunCount++;
      if (variancePct > maxOverrunPct) maxOverrunPct = variancePct;
    } else {
      withinCount++;
    }

    return {
      vpi_id: r.vpi_id,
      item_name: r.po_description || r.master_name || r.indent_description || 'Item',
      quantity: qty,
      actual_rate: actualRate,
      actual_amount: actualAmount,
      estimated_rate: estimatedRate,
      estimated_amount: estimatedAmount,
      benchmark_source: benchmarkSource,
      variance_amount: varianceAmt,
      variance_pct: variancePct,
      is_overrun: isOverrun,
      is_within: !isOverrun,
      is_missing: false,
    };
  });

  const totalVarianceAmt = Math.round((totalActual - totalEstimated) * 100) / 100;
  const totalVariancePct = totalEstimated > 0
    ? Math.round(((totalActual - totalEstimated) / totalEstimated) * 1000) / 10
    : 0;

  let costStatus = 'within_estimate';
  let canAutoApprove = false;
  let reason = '';

  if (overrunCount > 0) {
    costStatus = 'cost_overrun';
    canAutoApprove = false;
    reason = `${overrunCount} item(s) exceed estimated cost (up to +${maxOverrunPct}%) — requires manual approval`;
  } else if (missingCount > 0) {
    costStatus = 'missing_estimate';
    canAutoApprove = false;
    reason = `${missingCount} item(s) lack an estimated benchmark rate — requires manual approval`;
  } else {
    costStatus = 'within_estimate';
    canAutoApprove = true;
    reason = 'All items within estimated cost — eligible for auto-approval';
  }

  return {
    po_id: +poId,
    can_auto_approve: canAutoApprove,
    cost_status: costStatus,
    total_items: rows.length,
    total_actual_amount: Math.round(totalActual * 100) / 100,
    total_estimated_amount: Math.round(totalEstimated * 100) / 100,
    total_variance_amount: totalVarianceAmt,
    total_variance_pct: totalVariancePct,
    overrun_count: overrunCount,
    within_count: withinCount,
    missing_count: missingCount,
    max_overrun_pct: maxOverrunPct,
    items,
    reason,
  };
}

/**
 * Execute auto-approval for a Vendor PO if all items are within estimated cost.
 *
 * @param {object} db - better-sqlite3 instance
 * @param {number|string} poId - vendor_pos id
 * @param {object} actorUser - logged-in user who triggered approval
 * @returns {object} { auto_approved: boolean, evaluation: object }
 */
function autoApprovePoIfEligible(db, poId, actorUser) {
  const evalResult = evaluatePoCostEstimate(db, poId);
  if (!evalResult.can_auto_approve) {
    return {
      auto_approved: false,
      evaluation: evalResult,
    };
  }

  // Stamp L2 auto-approval
  db.prepare(`
    UPDATE vendor_pos
       SET po_approval = 'approved',
           po_l2_by = ?,
           po_l2_at = CURRENT_TIMESTAMP,
           po_auto_approved = 1,
           po_approval_note = ?
     WHERE id = ?
  `).run(actorUser?.id || null, `TSK-0824 Auto-Approved: ${evalResult.reason}`, +poId);

  return {
    auto_approved: true,
    evaluation: evalResult,
  };
}

module.exports = {
  evaluatePoCostEstimate,
  autoApprovePoIfEligible,
};
