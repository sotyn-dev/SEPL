/**
 * TSK-0824 & TSK-0477: Cost Estimate & Item Master Auto-Approval Engine
 *
 * TSK-0824: "I will only approve items where cost is more than estimated otherwise auto approve"
 * TSK-0477: "If procurement team buys anythings in which prices are more than item wise
 * master sheet then coo approval ( if PO is less than 50 K ) & above 50 k cmd approval must be mandatory"
 *
 * Rules:
 * 1. If any line item's actual_rate > item_master.current_price (and current_price > 0):
 *    - PO has an Item Master Overrun.
 *    - Auto-approval is STRICTLY BLOCKED.
 *    - If total PO amount < 50,000  -> Mandatory COO Approval ('pending_coo').
 *    - If total PO amount >= 50,000 -> Mandatory CMD Approval ('pending_cmd').
 * 2. If no item exceeds item master price:
 *    - Standard cost evaluation applies (TSK-0824 auto-approval if within estimated benchmarks).
 */

/**
 * Evaluate the cost of all line items in a Vendor PO against their estimated benchmarks
 * and specifically against the Item Master Sheet current price.
 *
 * Benchmark priority for general cost estimate:
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
      COALESCE(im.item_name, im_alt.item_name) as master_name,
      COALESCE(im.item_code, im_alt.item_code) as item_code,
      COALESCE(im.current_price, im_alt.current_price, 0) as master_price,
      poi.description as boq_description,
      poi.part_price as pp_rate,
      ir.marketing_rate,
      ir.final_rate as indent_final_rate
    FROM vendor_po_items vpi
    LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
    LEFT JOIN po_items poi ON poi.id = ii.po_item_id
    LEFT JOIN item_master im ON im.id = ii.item_master_id
    LEFT JOIN item_master im_alt ON (
      im.id IS NULL AND (
        (im_alt.item_name IS NOT NULL AND LOWER(TRIM(im_alt.item_name)) = LOWER(TRIM(COALESCE(vpi.description, ii.description, ''))))
        OR (im_alt.item_code IS NOT NULL AND LOWER(TRIM(im_alt.item_code)) = LOWER(TRIM(COALESCE(vpi.description, ii.description, ''))))
      )
    )
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
      has_item_master_overrun: false,
      item_master_overrun_count: 0,
      item_master_max_overrun_pct: 0,
      required_overrun_gate: null,
      required_overrun_label: null,
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

  // TSK-0477: Specific Item Master Sheet comparison
  let itemMasterOverrunCount = 0;
  let maxMasterOverrunPct = 0;

  const items = rows.map((r) => {
    const qty = +r.quantity || 0;
    const actualRate = +r.actual_rate || 0;
    const actualAmount = Math.round((+r.actual_amount || (actualRate * qty)) * 100) / 100;
    totalActual += actualAmount;

    // TSK-0477: Item Master rate comparison
    const masterPrice = +r.master_price || 0;
    const hasMasterBenchmark = masterPrice > 0;
    const isMasterOverrun = hasMasterBenchmark && (actualRate > masterPrice);
    const masterVarianceAmt = hasMasterBenchmark ? Math.round((actualRate - masterPrice) * qty * 100) / 100 : 0;
    const masterVariancePct = hasMasterBenchmark ? Math.round(((actualRate - masterPrice) / masterPrice) * 1000) / 10 : 0;

    if (isMasterOverrun) {
      itemMasterOverrunCount++;
      if (masterVariancePct > maxMasterOverrunPct) {
        maxMasterOverrunPct = masterVariancePct;
      }
    }

    // Resolve benchmark for general estimate
    let estimatedRate = null;
    let benchmarkSource = null;

    if (+r.pp_rate > 0) {
      estimatedRate = +r.pp_rate;
      benchmarkSource = 'BOQ PP Rate';
    } else if (masterPrice > 0) {
      estimatedRate = masterPrice;
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
        master_price: masterPrice,
        is_master_overrun: isMasterOverrun,
        master_variance_amount: masterVarianceAmt,
        master_variance_pct: masterVariancePct,
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
      master_price: masterPrice,
      is_master_overrun: isMasterOverrun,
      master_variance_amount: masterVarianceAmt,
      master_variance_pct: masterVariancePct,
    };
  });

  const totalVarianceAmt = Math.round((totalActual - totalEstimated) * 100) / 100;
  const totalVariancePct = totalEstimated > 0
    ? Math.round(((totalActual - totalEstimated) / totalEstimated) * 1000) / 10
    : 0;

  const hasItemMasterOverrun = itemMasterOverrunCount > 0;
  const roundedTotalActual = Math.round(totalActual * 100) / 100;

  // TSK-0477: Overrun Gate Determination
  let requiredOverrunGate = null;
  let requiredOverrunLabel = null;

  if (hasItemMasterOverrun) {
    if (roundedTotalActual < 50000) {
      requiredOverrunGate = 'coo';
      requiredOverrunLabel = 'COO Approval (< ₹50K)';
    } else {
      requiredOverrunGate = 'cmd';
      requiredOverrunLabel = 'CMD Approval (≥ ₹50K)';
    }
  }

  let costStatus = 'within_estimate';
  let canAutoApprove = false;
  let reason = '';

  if (hasItemMasterOverrun) {
    // TSK-0477: Mandatory COO / CMD Approval
    costStatus = 'master_overrun';
    canAutoApprove = false;
    reason = `TSK-0477: ${itemMasterOverrunCount} item(s) exceed Item Master Sheet rate (up to +${maxMasterOverrunPct}%) — Mandatory ${requiredOverrunLabel} required`;
  } else if (overrunCount > 0) {
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
    reason = 'All items within estimated cost and item master sheet — eligible for auto-approval';
  }

  return {
    po_id: +poId,
    can_auto_approve: canAutoApprove,
    cost_status: costStatus,
    total_items: rows.length,
    total_actual_amount: roundedTotalActual,
    total_estimated_amount: Math.round(totalEstimated * 100) / 100,
    total_variance_amount: totalVarianceAmt,
    total_variance_pct: totalVariancePct,
    overrun_count: overrunCount,
    within_count: withinCount,
    missing_count: missingCount,
    max_overrun_pct: maxOverrunPct,
    // TSK-0477 specific fields
    has_item_master_overrun: hasItemMasterOverrun,
    item_master_overrun_count: itemMasterOverrunCount,
    item_master_max_overrun_pct: maxMasterOverrunPct,
    required_overrun_gate: requiredOverrunGate,
    required_overrun_label: requiredOverrunLabel,
    items,
    reason,
  };
}

/**
 * Execute auto-approval for a Vendor PO if all items are within estimated cost
 * and NO item master price overrun exists (TSK-0824 & TSK-0477).
 *
 * @param {object} db - better-sqlite3 instance
 * @param {number|string} poId - vendor_pos id
 * @param {object} actorUser - logged-in user who triggered approval
 * @returns {object} { auto_approved: boolean, evaluation: object }
 */
function autoApprovePoIfEligible(db, poId, actorUser) {
  const evalResult = evaluatePoCostEstimate(db, poId);
  if (!evalResult.can_auto_approve || evalResult.has_item_master_overrun) {
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
