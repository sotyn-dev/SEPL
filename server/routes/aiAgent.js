// AI Agent — read-only "rate intelligence" endpoints powered by the
// item_price_history log. When a BOQ row with a linked catalogue item
// is saved, the rate gets logged here so the next quotation can show
// "last quoted to this client" + 6-month avg-low-high to keep the team
// consistent on pricing.
//
// Future home for the "Ask ERP" chatbot (Feature 3) once mam wires
// up ANTHROPIC_API_KEY.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// GET /api/ai-agent/rate-suggestion?item_id=&lead_id=
// Returns last-quoted-to-this-client + 6-month stats across all clients.
// Both null when no history exists for that item (UI hides the panel).
router.get('/rate-suggestion', (req, res) => {
  const itemId = +req.query.item_id;
  const leadId = req.query.lead_id ? +req.query.lead_id : null;
  if (!itemId) return res.status(400).json({ error: 'item_id required' });

  const db = getDb();

  // Pull this client's company_name so we can match historical rows
  // even if a different lead from the same client quoted before.
  let companyName = null;
  if (leadId) {
    const lead = db.prepare('SELECT company_name FROM leads WHERE id=?').get(leadId);
    companyName = lead?.company_name || null;
  }

  const lastForClient = companyName
    ? db.prepare(`SELECT rate, created_at, created_by_name, quantity
                  FROM item_price_history
                  WHERE item_id=? AND company_name=?
                  ORDER BY created_at DESC LIMIT 1`).get(itemId, companyName)
    : null;

  // 6-month window across all clients
  const stats = db.prepare(`SELECT
      COUNT(*) AS n,
      AVG(rate) AS avg_rate,
      MIN(rate) AS min_rate,
      MAX(rate) AS max_rate
    FROM item_price_history
    WHERE item_id=? AND created_at >= datetime('now', '-6 months')`).get(itemId);

  const lastOverall = db.prepare(`SELECT rate, created_at, created_by_name, company_name
                                  FROM item_price_history
                                  WHERE item_id=?
                                  ORDER BY created_at DESC LIMIT 1`).get(itemId);

  const item = db.prepare('SELECT id, item_name, current_price FROM item_master WHERE id=?').get(itemId);

  res.json({
    item,
    last_for_client: lastForClient,         // null if no prior quote to this client
    last_overall: lastOverall,              // null if no history at all
    six_month_stats: stats?.n > 0 ? {
      count: stats.n,
      avg: Math.round(stats.avg_rate),
      min: stats.min_rate,
      max: stats.max_rate,
    } : null,
    company_name: companyName,
  });
});

// GET /api/ai-agent/item-history?item_id=&limit=20
// Full historical log for an item — used by the AI Agent page (later)
// and useful for "show me the rate trend" view.
router.get('/item-history', (req, res) => {
  const itemId = +req.query.item_id;
  const limit = Math.min(+req.query.limit || 20, 100);
  if (!itemId) return res.status(400).json({ error: 'item_id required' });
  const rows = getDb().prepare(`SELECT h.*, l.company_name AS lead_company
                                FROM item_price_history h
                                LEFT JOIN leads l ON h.lead_id=l.id
                                WHERE h.item_id=?
                                ORDER BY h.created_at DESC
                                LIMIT ?`).all(itemId, limit);
  res.json(rows);
});

module.exports = router;
