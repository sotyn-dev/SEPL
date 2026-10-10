// AI BOQ to Item-wise Decomposer (TSK-0822)
// Decomposes high-level composite BOQ items into detailed item-wise Bill of Materials (BOM)
// according to Indian CPWD & MEP engineering standards.
//
// Dual-Rate Logic:
//   Primary Rate (🟢): SEPL Item Master / Past PO rate (used for all calculations by default)
//   Secondary Rate (🔵): Perplexity Live Market Rate (shown side-by-side for comparison)
//
// Safe & Non-Destructive: Zero auto-saving to DB. Always returns structured draft preview.

const { getDb } = require('../db/schema');
const { aiComplete, aiConfig, extractJsonArray } = require('./aiComplete');
const { tokens, scoreMatch } = require('./textMatch');

function getSetting(db, key) {
  try {
    const row = (db || getDb()).prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
    return row ? row.value : null;
  } catch (_) {
    return null;
  }
}

/**
 * Fetch live market rates via Perplexity Sonar API.
 * Returns map of index -> { rate, source, notes }
 */
async function fetchPerplexityRates(db, items) {
  const pplxKey = (getSetting(db, 'perplexity_api_key') || process.env.PERPLEXITY_API_KEY || '').trim();
  const results = new Map();

  if (!items || !items.length) return results;

  if (pplxKey) {
    try {
      const itemsListText = items.map((it, idx) => 
        `[${idx}] "${it.item_name}" (Unit: ${it.uom || 'Nos'}, Type: ${it.type || 'material'})`
      ).join('\n');

      const prompt = `You are an Indian MEPF and construction cost surveyor.
Provide current Indian wholesale / contractor market procurement rates (in INR per unit, excluding GST) for each item below.
Return ONLY a valid JSON array of objects, one per item, in this exact format:
[{"index": 0, "rate": 1450, "note": "Standard commercial rate (ex-factory)"}]

ITEMS:
${itemsListText}`;

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const resp = await fetch('https://api.perplexity.ai/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${pplxKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'sonar',
          messages: [
            {
              role: 'system',
              content: 'You provide accurate Indian market rates for MEP and civil construction materials in JSON format only.'
            },
            {
              role: 'user',
              content: prompt
            }
          ],
          temperature: 0.1
        }),
        signal: controller.signal
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const json = await resp.json();
        const rawContent = json.choices?.[0]?.message?.content || '';
        const parsed = extractJsonArray(rawContent);
        if (Array.isArray(parsed)) {
          for (const entry of parsed) {
            if (typeof entry.index === 'number' && typeof entry.rate === 'number') {
              results.set(entry.index, {
                rate: Math.round(entry.rate * 100) / 100,
                source: 'perplexity_sonar',
                notes: entry.note || 'Perplexity live market rate'
              });
            }
          }
          return results;
        }
      } else {
        console.warn('[boqDecomposer] Perplexity API HTTP error:', resp.status);
      }
    } catch (err) {
      console.warn('[boqDecomposer] Perplexity API request failed:', err.message);
    }
  }

  // Fallback if Perplexity key is missing or fails: generate market benchmark rates via aiComplete
  try {
    const itemsListText = items.map((it, idx) => 
      `[${idx}] "${it.item_name}" (Unit: ${it.uom || 'Nos'}, Type: ${it.type || 'material'})`
    ).join('\n');

    const benchmarkPrompt = `You are an Indian MEPF cost estimator. Estimate realistic current Indian market purchase rates (in INR per unit, excluding GST) for each item.
Return ONLY a valid JSON array:
[{"index": 0, "rate": <number>, "note": "<short benchmark note>"}]

ITEMS:
${itemsListText}`;

    const out = await aiComplete(db, {
      prompt: benchmarkPrompt,
      maxTokens: 2048,
      timeout: 25000,
      json: true
    });

    const parsed = extractJsonArray(out.text);
    if (Array.isArray(parsed)) {
      for (const entry of parsed) {
        if (typeof entry.index === 'number' && typeof entry.rate === 'number') {
          results.set(entry.index, {
            rate: Math.round(entry.rate * 100) / 100,
            source: pplxKey ? 'ai_benchmark_fallback' : 'ai_market_benchmark',
            notes: entry.note || 'AI market benchmark'
          });
        }
      }
    }
  } catch (err) {
    console.warn('[boqDecomposer] Fallback benchmark rate failed:', err.message);
  }

  return results;
}

/**
 * Match decomposed item against SEPL's Item Master catalogue and past PO / pricing history.
 */
function matchSeplCatalogue(db, candidateTokens, catalogueCache) {
  let best = null;
  let bestScore = 0;

  for (const item of catalogueCache) {
    const score = scoreMatch(candidateTokens, item.tokens);
    if (score > bestScore) {
      bestScore = score;
      best = item;
    }
  }

  // Acceptance threshold: score >= 0.35 with at least 2 tokens matched
  if (best && bestScore >= 0.35) {
    let recentRate = best.current_price || 0;
    let rateSource = 'item_master';

    // Check item_price_history if current_price is zero
    if (!recentRate) {
      try {
        const hist = db.prepare('SELECT rate FROM item_price_history WHERE item_id = ? ORDER BY created_at DESC LIMIT 1').get(best.id);
        if (hist && hist.rate > 0) {
          recentRate = hist.rate;
          rateSource = 'price_history';
        }
      } catch (_) {}
    }

    return {
      matched: true,
      score: Math.round(bestScore * 100),
      item_id: best.id,
      item_code: best.item_code || '',
      item_name: best.full_name,
      department: best.department || '',
      uom: best.uom || '',
      sepl_rate: recentRate,
      rate_source: rateSource
    };
  }

  return {
    matched: false,
    score: 0,
    item_id: null,
    item_code: '',
    item_name: '',
    department: '',
    uom: '',
    sepl_rate: null,
    rate_source: 'none'
  };
}

/**
 * Main function: Decompose a single high-level BOQ line into an item-wise BOM breakdown.
 *
 * @param {object} db - SQLite database handle
 * @param {object} boqLine - { description, quantity, unit, trade, client_spec }
 * @param {object} opts - { preferredSource }
 */
async function decomposeBoqLine(db, boqLine, opts = {}) {
  const database = db || getDb();
  const desc = String(boqLine?.description || '').trim();
  const qty = Math.max(0.001, Number(boqLine?.quantity) || 1);
  const unit = String(boqLine?.unit || 'Nos').trim();
  const trade = String(boqLine?.trade || '').trim();

  if (!desc || desc.length < 3) {
    const err = new Error('BOQ item description is too short to decompose');
    err.status = 400;
    throw err;
  }

  // 1. Prompt the AI for structured technical engineering breakdown
  const decomposePrompt = `You are a Senior Quantity Surveyor and MEPF Cost Estimation Engineer.
Decompose this high-level composite BOQ line into an exhaustive, item-wise Bill of Materials (BOM) breakdown following Indian CPWD and IS standards.

Composite BOQ Item:
- Description: "${desc}"
- Total Quantity: ${qty} ${unit}
${trade ? `- Trade / Discipline: ${trade}` : ''}

Decomposition Requirements:
Break down into 4 clear component types:
1. "primary": Main equipment/material/pipe/cable (include standard 3-5% cutting/laying wastage if bulk material like cable/pipe).
2. "accessory": Essential installation fittings, hardware, supports, flanges, bends, boxes, glands, lugs, connectors.
3. "consumable": Installation consumables like primer, paint, sealant, tapes, welding rods, dash fasteners, solvent.
4. "labour": Installation, testing, laying, commissioning activities.

For EACH sub-item, output:
- "item_name": Specific trade name with standard Indian specification (e.g., "100mm NB Heavy Duty MS ERW Pipe", "Double Compression Brass Gland 240 sq.mm").
- "type": Exactly one of ["primary", "accessory", "consumable", "labour"].
- "qty_per_boq_unit": Quantity needed per 1 unit of the main BOQ line.
- "total_qty": Calculated quantity = (qty_per_boq_unit * ${qty}), rounded to 2 decimals.
- "uom": Standard unit (e.g., Mtr, Nos, Set, Kg, Ltr, Rmt, Sqm, Man-days).
- "wastage_pct": Wastage percentage included (0 if none).
- "category": Discipline (e.g., Electrical, Plumbing, HVAC, Fire Fighting, Civil).

CRITICAL: Return ONLY a valid JSON array, no markdown fences, no explanatory text:
[
  {
    "item_name": "...",
    "type": "primary",
    "qty_per_boq_unit": 1.05,
    "total_qty": 105,
    "uom": "Mtr",
    "wastage_pct": 5,
    "category": "Fire Fighting"
  }
]`;

  let aiRes;
  try {
    aiRes = await aiComplete(database, {
      prompt: decomposePrompt,
      maxTokens: 4096,
      timeout: 60000,
      json: true
    });
  } catch (err) {
    console.error('[boqDecomposer] AI breakdown error:', err.message);
    const customErr = new Error(`AI breakdown failed: ${err.message}`);
    customErr.status = 502;
    throw customErr;
  }

  const rawItems = extractJsonArray(aiRes.text);
  if (!Array.isArray(rawItems) || !rawItems.length) {
    const err = new Error('AI was unable to generate an itemized breakdown array for this line.');
    err.status = 422;
    throw err;
  }

  // 2. Load catalogue cache from item_master for matching
  const allMasterItems = database.prepare(`
    SELECT id, item_code, item_name, specification, size, uom, current_price, department
    FROM item_master
  `).all();

  const catalogueCache = allMasterItems.map(it => {
    const fullName = [it.item_name, it.specification, it.size].filter(Boolean).join(' ');
    return {
      ...it,
      full_name: fullName,
      tokens: tokens(fullName)
    };
  });

  // 3. Match each item to SEPL catalogue & prepare for Perplexity market lookup
  const processedItems = rawItems.map((item, idx) => {
    const candidateTokens = new Set(tokens(item.item_name));
    const match = matchSeplCatalogue(database, candidateTokens, catalogueCache);
    const itemQty = Math.max(0.01, Number(item.total_qty) || (Number(item.qty_per_boq_unit || 1) * qty));

    return {
      index: idx,
      item_name: String(item.item_name || '').trim(),
      type: ['primary', 'accessory', 'consumable', 'labour'].includes(item.type) ? item.type : 'accessory',
      qty_per_boq_unit: Math.round((Number(item.qty_per_boq_unit) || 1) * 1000) / 1000,
      total_qty: Math.round(itemQty * 100) / 100,
      uom: String(item.uom || match.uom || 'Nos').trim(),
      wastage_pct: Number(item.wastage_pct) || 0,
      category: item.category || trade || 'General',

      // SEPL Matched info (Primary rate)
      sepl_matched: match.matched,
      sepl_match_score: match.score,
      sepl_item_id: match.item_id,
      sepl_item_code: match.item_code,
      sepl_item_name: match.item_name,
      sepl_rate: (match.sepl_rate !== null && match.sepl_rate !== undefined) ? Number(match.sepl_rate) : null,
      sepl_rate_source: match.rate_source, // 'item_master' | 'price_history' | 'none'

      // Perplexity Market Rate placeholder
      perplexity_rate: null,
      perplexity_source: null,
      perplexity_note: null,

      // Active / Selected rate for calculation (defaults to SEPL rate, else falls back to market rate)
      selected_rate: null,
      selected_rate_type: 'sepl',
      amount: 0
    };
  });

  // 4. Fetch Perplexity / Market comparison rates in parallel
  const marketRatesMap = await fetchPerplexityRates(database, processedItems);

  // 5. Finalize pricing and compute amounts
  for (const it of processedItems) {
    const market = marketRatesMap.get(it.index);
    if (market) {
      it.perplexity_rate = market.rate;
      it.perplexity_source = market.source;
      it.perplexity_note = market.notes;
    }

    // Default rate rule:
    // If SEPL rate is available (> 0), USE IT AS DEFAULT (🟢 primary).
    // If SEPL rate is missing/0, fallback to Perplexity market rate (🔵 secondary).
    if (it.sepl_rate !== null && it.sepl_rate > 0) {
      it.selected_rate = it.sepl_rate;
      it.selected_rate_type = 'sepl';
    } else if (it.perplexity_rate !== null && it.perplexity_rate > 0) {
      it.selected_rate = it.perplexity_rate;
      it.selected_rate_type = 'perplexity';
    } else {
      it.selected_rate = 0;
      it.selected_rate_type = 'none';
    }

    it.amount = Math.round((it.total_qty * (it.selected_rate || 0)) * 100) / 100;
  }

  // 6. Compute summary totals
  const totalSeplCost = processedItems.reduce((acc, it) => acc + (it.total_qty * (it.sepl_rate || 0)), 0);
  const totalMarketCost = processedItems.reduce((acc, it) => acc + (it.total_qty * (it.perplexity_rate || 0)), 0);
  const totalActiveCost = processedItems.reduce((acc, it) => acc + it.amount, 0);

  return {
    boq_line: {
      description: desc,
      quantity: qty,
      unit: unit,
      trade: trade || 'General'
    },
    items: processedItems,
    summary: {
      total_items: processedItems.length,
      sepl_matched_count: processedItems.filter(i => i.sepl_matched).length,
      total_sepl_cost: Math.round(totalSeplCost * 100) / 100,
      total_market_cost: Math.round(totalMarketCost * 100) / 100,
      total_active_cost: Math.round(totalActiveCost * 100) / 100,
      variance: Math.round((totalSeplCost - totalMarketCost) * 100) / 100,
      variance_pct: totalMarketCost > 0 ? Math.round(((totalSeplCost - totalMarketCost) / totalMarketCost) * 1000) / 10 : 0
    }
  };
}

module.exports = {
  decomposeBoqLine,
  fetchPerplexityRates
};
