const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/auth');
const { getMarketRates, getInternalHistoricalRates } = require('../services/externalProcurementService');

router.use(authMiddleware);

/**
 * GET /api/market-rates/search?q=...
 * Search across Moglix, IndiaMART, and internal historical ERP PO prices
 */
router.get('/search', async (req, res) => {
  const query = req.query.q || req.query.query || '';
  const size = req.query.size || '';
  const make = req.query.make || '';
  const spec = req.query.spec || req.query.specification || '';
  if (!query.trim()) {
    return res.status(400).json({ error: 'Search query is required' });
  }

  try {
    const result = await getMarketRates(query, { size, make, spec });
    res.json(result);
  } catch (err) {
    console.error('[market-rates/search error]', err);
    // Graceful fallback — never return 500 error to user
    res.json({
      query,
      moglix: [],
      indiamart: [],
      internalHistory: getInternalHistoricalRates(query),
      directLinks: {
        moglix: `https://www.moglix.com/search?controller=search&s=${encodeURIComponent(query)}`,
        indiamart: `https://dir.indiamart.com/search.mp?ss=${encodeURIComponent(query)}`,
        amazon: `https://www.amazon.in/s?k=${encodeURIComponent(query)}`,
        industrybuying: `https://www.industrybuying.com/search/?q=${encodeURIComponent(query)}`,
      },
      summary: null,
      error: 'External live rates temporarily unreachable, internal records loaded.'
    });
  }
});

/**
 * GET /api/market-rates/history?q=...
 * Fast lookup of previous PO prices paid by SEPL for this item
 */
router.get('/history', (req, res) => {
  const query = req.query.q || req.query.query || '';
  try {
    const history = getInternalHistoricalRates(query);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
