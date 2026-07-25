// Material Issue → Reconcile loop (director ask, 2026-07-26):
// "in morning store keeper will issue the inventory and then they have to
// just enter the stock data what is used, rest submit all back."
//
// Morning:  storekeeper issues items → stock OUT immediately (material
//           physically leaves the store), engineer gets a push and taps
//           Accept (two-party record, no paper challan).
// Evening:  Quick DPR shows the slip; engineer enters qty USED per item;
//           returned = issued − used (arithmetic, not memory). Consumption
//           needs NO further stock movement — the OUT already happened at
//           issue time (so the DPR materials auto-OUT path is NOT used for
//           slip-covered items; that would double-deduct).
// Closing:  storekeeper CONFIRMS the physical return → stock IN for the
//           confirmed qty. declared-vs-confirmed gap = variance, alerted
//           to admins — shrinkage can't hide inside paper returns.

const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { collectLowStock, notifyLowStock } = require('../lib/lowStock');
const router = express.Router();
router.use(authMiddleware);

const today = () => new Date().toISOString().slice(0, 10);

// List slips — storekeeper/admin sees all for a site/date; an engineer is
// always allowed to see slips issued TO them.
router.get('/', (req, res) => {
  const db = getDb();
  const { site_id, date, status, mine } = req.query;
  let sql = `
    SELECT mi.*, s.name as site_name, ub.name as issued_by_name, ut.name as issued_to_name
      FROM material_issues mi
      JOIN sites s ON s.id = mi.site_id
      LEFT JOIN users ub ON ub.id = mi.issued_by
      LEFT JOIN users ut ON ut.id = mi.issued_to
     WHERE 1=1`;
  const params = [];
  if (mine === '1') { sql += ' AND mi.issued_to = ?'; params.push(req.user.id); }
  if (site_id) { sql += ' AND mi.site_id = ?'; params.push(+site_id); }
  if (date) { sql += ' AND mi.issue_date = ?'; params.push(String(date).slice(0, 10)); }
  if (status) { sql += ' AND mi.status = ?'; params.push(status); }
  sql += ' ORDER BY mi.issue_date DESC, mi.id DESC LIMIT 200';
  const rows = db.prepare(sql).all(...params);
  if (!rows.length) return res.json([]);
  const ph = rows.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT mii.*, im.item_name, im.item_code, im.uom
      FROM material_issue_items mii JOIN item_master im ON im.id = mii.item_master_id
     WHERE mii.issue_id IN (${ph})`).all(...rows.map(r => r.id));
  res.json(rows.map(r => ({ ...r, items: items.filter(i => i.issue_id === r.id) })));
});

// Morning issue — storekeeper (inventory:create). Validates against live
// stock, writes the OUT movements inside one transaction, then pushes a
// notification to the engineer to Accept.
router.post('/', requirePermission('inventory', 'create'), (req, res) => {
  const db = getDb();
  const { site_id, issued_to, items, notes } = req.body || {};
  if (!site_id || !issued_to) return res.status(400).json({ error: 'site_id and issued_to (engineer) required' });
  const clean = (Array.isArray(items) ? items : [])
    .map(i => ({ item_master_id: +i.item_master_id, qty: +i.qty || 0 }))
    .filter(i => i.item_master_id && i.qty > 0);
  if (!clean.length) return res.status(400).json({ error: 'At least one item with qty > 0 required' });

  const store = db.prepare(
    `SELECT id FROM warehouses WHERE site_id = ? AND type = 'site_store' AND active = 1 LIMIT 1`
  ).get(+site_id);
  if (!store) return res.status(400).json({ error: 'This site has no site-store warehouse' });

  // Stock check up-front so the engineer never gets a slip the store can't fulfil.
  for (const it of clean) {
    const bal = db.prepare('SELECT quantity FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(store.id, it.item_master_id);
    if (!bal || +bal.quantity < it.qty) {
      const im = db.prepare('SELECT item_name FROM item_master WHERE id=?').get(it.item_master_id);
      return res.status(400).json({ error: `Not enough stock of ${im?.item_name || 'item #' + it.item_master_id}: have ${bal ? bal.quantity : 0}, issuing ${it.qty}` });
    }
  }

  try {
    const issueId = db.transaction(() => {
      const r = db.prepare(
        `INSERT INTO material_issues (site_id, warehouse_id, issue_date, issued_by, issued_to, notes)
         VALUES (?,?,?,?,?,?)`
      ).run(+site_id, store.id, today(), req.user.id, +issued_to, notes || null);
      const id = r.lastInsertRowid;
      const insItem = db.prepare(
        `INSERT INTO material_issue_items (issue_id, item_master_id, qty_issued, rate) VALUES (?,?,?,?)`
      );
      const updBal = db.prepare('UPDATE stock_balance SET quantity = quantity - ?, updated_at=CURRENT_TIMESTAMP WHERE warehouse_id=? AND item_master_id=?');
      const insMove = db.prepare(
        `INSERT INTO stock_movements (warehouse_id, item_master_id, type, quantity, rate, total_value,
           reference_type, reference_id, site_id, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const it of clean) {
        const bal = db.prepare('SELECT avg_rate FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(store.id, it.item_master_id);
        const rate = +bal?.avg_rate || 0;
        insItem.run(id, it.item_master_id, it.qty, rate);
        updBal.run(it.qty, store.id, it.item_master_id);
        insMove.run(store.id, it.item_master_id, 'OUT', it.qty, rate, it.qty * rate,
          'MATERIAL_ISSUE', `MI-${id}`, +site_id, `Morning issue slip #${id}`, req.user.id);
      }
      return id;
    })();

    // Issue-time deduction can cross reorder levels just like consumption.
    const touched = clean.map(it => ({ warehouse_id: store.id, item_master_id: it.item_master_id }));
    const alerts = collectLowStock(db, touched);
    if (alerts.length) {
      setImmediate(() => notifyLowStock(+site_id, alerts, `Issue slip #${issueId}`).catch(e =>
        console.warn('[material-issues] low-stock alert failed:', e.message)));
    }
    // Nudge the engineer to Accept — their digital signature on the handover.
    try {
      const pushLib = require('../lib/push');
      pushLib.notify(+issued_to, {
        title: '📦 Material issued to you',
        body: `${clean.length} item(s) issued from the site store — tap to accept.`,
        url: '/dpr-quick',
        tag: `material-issue-${issueId}`,
      });
    } catch (e) { /* best-effort */ }

    res.status(201).json({ id: issueId, low_stock_alerts: alerts });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Engineer taps Accept — the second signature on the morning handover.
router.post('/:id/accept', (req, res) => {
  const db = getDb();
  const mi = db.prepare('SELECT * FROM material_issues WHERE id=?').get(req.params.id);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  if (mi.issued_to !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the engineer this slip was issued to can accept it' });
  }
  if (mi.status !== 'issued') return res.status(400).json({ error: `Slip is already ${mi.status}` });
  db.prepare(`UPDATE material_issues SET status='accepted', accepted_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(mi.id);
  res.json({ ok: true });
});

// Evening reconcile — called by Quick DPR on submit. Engineer declares qty
// USED per item; returned = issued − used. NO stock movement here: the OUT
// happened at issue time, and the return comes back only on storekeeper
// confirmation below. Also mirrors used quantities into dpr_material so the
// DPR detail view shows consumption exactly like hand-entered materials.
router.post('/:id/reconcile', (req, res) => {
  const db = getDb();
  const mi = db.prepare('SELECT * FROM material_issues WHERE id=?').get(req.params.id);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  if (mi.issued_to !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Only the engineer this slip was issued to can reconcile it' });
  }
  if (!['issued', 'accepted'].includes(mi.status)) {
    return res.status(400).json({ error: `Slip is already ${mi.status}` });
  }
  const { dpr_id, items } = req.body || {};
  const declared = new Map((Array.isArray(items) ? items : [])
    .map(i => [+i.item_master_id, Math.max(0, +i.qty_used || 0)]));
  try {
    db.transaction(() => {
      const rows = db.prepare('SELECT * FROM material_issue_items WHERE issue_id=?').all(mi.id);
      const upd = db.prepare('UPDATE material_issue_items SET qty_used=?, qty_returned=? WHERE id=?');
      const insMat = db.prepare(
        `INSERT INTO dpr_material (dpr_id, item_master_id, material_name, unit, consumed_today, cumulative_consumed, balance_qty, remarks)
         VALUES (?,?,?,?,?,?,?,?)`
      );
      for (const row of rows) {
        const used = Math.min(+row.qty_issued, declared.get(row.item_master_id) ?? 0);
        const returned = +row.qty_issued - used;
        upd.run(used, returned, row.id);
        if (dpr_id && used > 0) {
          const im = db.prepare('SELECT item_name, uom FROM item_master WHERE id=?').get(row.item_master_id);
          insMat.run(+dpr_id, row.item_master_id, im?.item_name || `Item #${row.item_master_id}`,
            im?.uom || 'nos', used, used, returned, `Issue slip #${mi.id}`);
        }
      }
      db.prepare(`UPDATE material_issues SET status='reconciled', dpr_id=COALESCE(?, dpr_id), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(dpr_id ? +dpr_id : null, mi.id);
    })();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Storekeeper confirms the physical return → stock IN for CONFIRMED qty.
// Confirming less than the engineer declared logs a variance and alerts
// admins — that gap is exactly where material disappears.
router.post('/:id/confirm-return', requirePermission('inventory', 'create'), (req, res) => {
  const db = getDb();
  const mi = db.prepare('SELECT * FROM material_issues WHERE id=?').get(req.params.id);
  if (!mi) return res.status(404).json({ error: 'Not found' });
  if (mi.status !== 'reconciled') return res.status(400).json({ error: 'Engineer has not reconciled this slip yet (DPR not filed?)' });
  const confirmed = new Map((Array.isArray(req.body?.items) ? req.body.items : [])
    .map(i => [+i.item_master_id, Math.max(0, +i.qty || 0)]));
  const variances = [];
  try {
    db.transaction(() => {
      const rows = db.prepare('SELECT * FROM material_issue_items WHERE issue_id=?').all(mi.id);
      const upd = db.prepare(`UPDATE material_issue_items SET qty_return_confirmed=?, return_confirmed_by=?, return_confirmed_at=CURRENT_TIMESTAMP WHERE id=?`);
      const updBal = db.prepare(`
        INSERT INTO stock_balance (warehouse_id, item_master_id, quantity) VALUES (?,?,?)
        ON CONFLICT(warehouse_id, item_master_id) DO UPDATE SET quantity = quantity + excluded.quantity, updated_at=CURRENT_TIMESTAMP`);
      const insMove = db.prepare(
        `INSERT INTO stock_movements (warehouse_id, item_master_id, type, quantity, rate, total_value,
           reference_type, reference_id, site_id, notes, created_by)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const row of rows) {
        const declared = +row.qty_returned || 0;
        // Default to the declared figure when the storekeeper doesn't type
        // one — the common all-good case stays one tap.
        const conf = confirmed.has(row.item_master_id) ? Math.min(declared, confirmed.get(row.item_master_id)) : declared;
        upd.run(conf, req.user.id, row.id);
        if (conf > 0) {
          updBal.run(mi.warehouse_id, row.item_master_id, conf);
          insMove.run(mi.warehouse_id, row.item_master_id, 'IN', conf, +row.rate || 0, conf * (+row.rate || 0),
            'MATERIAL_RETURN', `MI-${mi.id}`, mi.site_id, `Return against issue slip #${mi.id}`, req.user.id);
        }
        if (conf < declared) {
          const im = db.prepare('SELECT item_name FROM item_master WHERE id=?').get(row.item_master_id);
          variances.push({ item_master_id: row.item_master_id, item_name: im?.item_name, declared, confirmed: conf, missing: declared - conf });
        }
      }
      db.prepare(`UPDATE material_issues SET status='closed', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(mi.id);
    })();
    if (variances.length) {
      try {
        const pushLib = require('../lib/push');
        const adminIds = db.prepare(`SELECT id FROM users WHERE role='admin' AND active=1`).all().map(r => r.id);
        const eng = db.prepare('SELECT name FROM users WHERE id=?').get(mi.issued_to);
        pushLib.notifyMany(adminIds, {
          title: '⚠ Material return variance',
          body: `Slip #${mi.id} (${eng?.name || 'engineer'}): ${variances.map(v => `${v.item_name} short ${v.missing}`).join(', ')}`,
          url: '/inventory',
          tag: `mi-variance-${mi.id}`,
        });
      } catch (e) { /* best-effort */ }
    }
    res.json({ ok: true, variances });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
