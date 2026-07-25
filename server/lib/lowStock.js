// Low-stock / reorder-level alerting, shared by every path that decrements
// site-store stock: DPR material consumption (routes/dpr.js) and the
// morning Material Issue flow (routes/materialIssues.js).
//
// Recipients: active admins + anyone whose role has can_approve on the
// 'procurement' module (Purchase Manager et al). Deliberately NOT can_view —
// a pre-existing migration grants procurement can_view+can_create to nearly
// every role (incl. Sub-Contractor logins), which would blast internal stock
// alerts to outsiders. can_approve stays a small, actually-procurement set.
const { getDb } = require('../db/schema');

function findProcurementUsers(db) {
  const ids = new Set();
  db.prepare(`SELECT id FROM users WHERE role='admin' AND active=1`).all().forEach(r => ids.add(r.id));
  db.prepare(`
    SELECT DISTINCT u.id FROM users u
    JOIN user_roles ur ON ur.user_id = u.id
    JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE rp.module = 'procurement' AND rp.can_approve = 1 AND u.active = 1
  `).all().forEach(r => ids.add(r.id));
  return [...ids];
}

// For every (warehouse_id, item_master_id) pair in `touched`, check the
// current balance against reorder_level and return the ones at/below it.
function collectLowStock(db, touched) {
  const out = [];
  const seen = new Set();
  for (const t of touched) {
    const key = `${t.warehouse_id}:${t.item_master_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const bal = db.prepare('SELECT quantity, reorder_level FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(t.warehouse_id, t.item_master_id);
    if (!bal || !(bal.reorder_level > 0) || bal.quantity > bal.reorder_level) continue;
    const item = db.prepare('SELECT item_name, item_code FROM item_master WHERE id=?').get(t.item_master_id);
    out.push({
      warehouse_id: t.warehouse_id, item_master_id: t.item_master_id,
      item_name: item?.item_name || null, item_code: item?.item_code || null,
      quantity: bal.quantity, reorder_level: bal.reorder_level,
    });
  }
  return out;
}

// Fire-and-forget notify: in-app `notifications` rows (deduped per
// item+day, same convention as scripts/hrAutomationsCron.js) + web push
// (same payload shape as scripts/dprAutoPrompt.js). `context` is a short
// human string naming what triggered it (e.g. "DPR #12", "Issue slip #4").
async function notifyLowStock(siteId, alerts, context) {
  const db = getDb();
  const site = db.prepare('SELECT name FROM sites WHERE id=?').get(siteId);
  const today = new Date().toISOString().slice(0, 10);
  const userIds = findProcurementUsers(db);
  if (!userIds.length) return;
  for (const a of alerts) {
    const label = a.item_name || a.item_code || `Item #${a.item_master_id}`;
    const title = `⚠ Low stock — ${label}`;
    const body = `${site?.name || `Site #${siteId}`}: ${label} at ${a.quantity} (reorder level ${a.reorder_level}), triggered by ${context}.`;
    const dedupeKey = `low_stock_reorder:${a.warehouse_id}:${a.item_master_id}:${today}`;
    for (const uid of userIds) {
      const existing = db.prepare('SELECT id FROM notifications WHERE user_id=? AND dedupe_key=?').get(uid, dedupeKey);
      if (existing) continue;
      db.prepare(
        `INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
         VALUES (?,?,?,?,?,?,?)`
      ).run(uid, 'low_stock_reorder', title, body, '/inventory', 'in_app', dedupeKey);
    }
    try {
      const pushLib = require('./push');
      pushLib.notifyMany(userIds, { title, body, url: '/inventory', tag: dedupeKey });
    } catch (e) { console.warn('[low-stock] push failed:', e.message); }
  }
}

module.exports = { findProcurementUsers, collectLowStock, notifyLowStock };
