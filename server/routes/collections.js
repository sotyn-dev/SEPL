const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Helper: calculate ageing and bucket
function calculateAgeing(dueDate) {
  if (!dueDate) return { days: 0, bucket: '0-30' };
  const now = new Date();
  const due = new Date(dueDate);
  const days = Math.max(0, Math.floor((now - due) / (1000 * 60 * 60 * 24)));
  let bucket = '0-30';
  if (days > 90) bucket = '90+';
  else if (days > 60) bucket = '61-90';
  else if (days > 30) bucket = '31-60';
  return { days, bucket };
}

// Helper: determine status color
function getStatusColor(outstandingAmount, ageingDays) {
  if (outstandingAmount <= 0) return 'green';
  if (ageingDays > 60) return 'red';
  if (ageingDays > 30) return 'yellow';
  return 'green';
}

// Get all receivables with filters. Now also returns:
//   - pms_tasks_count : how many PMS tasks were raised for this site
//                       (so mam can see at a glance how much CRM
//                       follow-up activity sits behind a delayed payment)
//   - payments        : array of individual collection installments
//                       [{ amount, collection_date, payment_mode, notes }]
//                       so the table can show "today rec 40, +15 in 10 days"
router.get('/', (req, res) => {
  const { status, ageing_bucket, client, search } = req.query;
  let sql = `
    SELECT r.*,
           u.name as owner_name,
           (SELECT COUNT(*) FROM pms_tasks p
              WHERE p.project_id = r.site_id
                 OR (r.site_name IS NOT NULL AND r.site_name <> ''
                     AND (p.project_name_snapshot = r.site_name
                          OR p.project_name_snapshot LIKE '%' || r.site_name || '%'))
           ) as pms_tasks_count
      FROM receivables r
      LEFT JOIN users u ON r.owner_id = u.id
     WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND r.status = ?'; params.push(status); }
  if (ageing_bucket) { sql += ' AND r.ageing_bucket = ?'; params.push(ageing_bucket); }
  if (client) { sql += ' AND (r.client_name LIKE ? OR r.site_name LIKE ?)'; params.push(`%${client}%`, `%${client}%`); }
  if (search) { sql += ' AND (r.client_name LIKE ? OR r.site_name LIKE ? OR r.invoice_number LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
  sql += ' ORDER BY r.status DESC, r.ageing_days DESC';
  const rows = getDb().prepare(sql).all(...params);

  // Pull payment installments per receivable (one query, then group)
  const ids = rows.map(r => r.id);
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const allPayments = getDb().prepare(
      `SELECT receivable_id, amount, collection_date, payment_mode, transaction_ref, notes
         FROM collections
        WHERE receivable_id IN (${placeholders})
        ORDER BY collection_date DESC, id DESC`
    ).all(...ids);
    const byRecv = new Map();
    for (const p of allPayments) {
      if (!byRecv.has(p.receivable_id)) byRecv.set(p.receivable_id, []);
      byRecv.get(p.receivable_id).push(p);
    }
    for (const r of rows) r.payments = byRecv.get(r.id) || [];
  } else {
    rows.forEach(r => { r.payments = []; });
  }
  res.json(rows);
});

// Helper for the Edit modal — list of UNIQUE site names from sites +
// business_book, with their latest CRM and total invoice value pulled
// from the most recent Client PO. Used as the dropdown source for
// "Site Name" so mam picks from real data instead of typing free text.
router.get('/sites', (req, res) => {
  const db = getDb();
  // Pull unique site names. SQLite can't reference aggregate functions
  // inside correlated subqueries, so we pick one canonical row per name
  // (lowest id) via a sub-SELECT first, then run the PO lookups against
  // that single row. Net result: one row per unique site name with the
  // most recent PO's CRM + value.
  const rows = db.prepare(`
    SELECT s.name, s.id, s.business_book_id,
           (SELECT po.crm_name FROM purchase_orders po
              WHERE po.business_book_id = s.business_book_id
                AND po.crm_name IS NOT NULL AND po.crm_name <> ''
              ORDER BY po.created_at DESC LIMIT 1) as crm_name,
           (SELECT po.total_amount FROM purchase_orders po
              WHERE po.business_book_id = s.business_book_id
                AND po.total_amount IS NOT NULL
              ORDER BY po.created_at DESC LIMIT 1) as latest_po_value,
           (SELECT po.po_number FROM purchase_orders po
              WHERE po.business_book_id = s.business_book_id
              ORDER BY po.created_at DESC LIMIT 1) as latest_po_number
      FROM sites s
     WHERE s.id IN (
       SELECT MIN(id) FROM sites
        WHERE name IS NOT NULL AND name <> ''
        GROUP BY name
     )
     ORDER BY s.name
  `).all();
  res.json(rows);
});

// Dashboard summary
router.get('/summary', (req, res) => {
  const db = getDb();
  const total = db.prepare('SELECT COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0').get();
  const byBucket = db.prepare('SELECT ageing_bucket, COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY ageing_bucket').all();
  const byStatus = db.prepare('SELECT status, COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY status').all();
  const topClients = db.prepare('SELECT client_name, SUM(outstanding_amount) as total FROM receivables WHERE outstanding_amount > 0 GROUP BY client_name ORDER BY total DESC LIMIT 10').all();
  const overdue = db.prepare('SELECT COUNT(*) as count, COALESCE(SUM(outstanding_amount),0) as total FROM receivables WHERE ageing_days > 30 AND outstanding_amount > 0').get();

  res.json({ totalOutstanding: total.total, byBucket, byStatus, topClients, overdue });
});

// Create receivable. Accepts the original free-text fields AND the new
// v2 fields (site_id / site_name / crm_name / next_planned_date /
// last_discussion). client_name is auto-derived from site_name when
// missing so the existing dashboard still groups things correctly.
router.post('/', (req, res) => {
  const b = req.body || {};
  const {
    client_name, project_name, po_id, invoice_number, invoice_date,
    invoice_amount, due_date, owner_id,
    site_id, site_name, crm_name, next_planned_date, last_discussion,
  } = b;
  const target = +invoice_amount;
  const finalClient = client_name || site_name;
  if (!finalClient || !(target > 0)) return res.status(400).json({ error: 'Site/client name and target amount required' });

  const { days, bucket } = calculateAgeing(due_date);
  const statusColor = getStatusColor(target, days);

  const r = getDb().prepare(
    `INSERT INTO receivables
       (client_name, project_name, po_id, invoice_number, invoice_date,
        invoice_amount, outstanding_amount, due_date, ageing_days, ageing_bucket,
        status, owner_id, created_by,
        site_id, site_name, crm_name, next_planned_date, last_discussion)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(
    finalClient, project_name || site_name || null, po_id || null, invoice_number || null, invoice_date || null,
    target, target, due_date || null, days, bucket,
    statusColor, owner_id || null, req.user.id,
    site_id || null, site_name || null, crm_name || null, next_planned_date || null, last_discussion || null,
  );
  res.status(201).json({ id: r.lastInsertRowid });
});

// Update receivable. Two modes:
//   - Quick: pass any of follow_up_status / follow_up_date / follow_up_notes /
//     escalation_level / owner_id (the original signature)
//   - Full edit: also accepts client_name / project_name / invoice_number /
//     invoice_date / invoice_amount / due_date. When invoice_amount or
//     due_date change, ageing days/bucket and status colour are recomputed.
router.put('/:id', (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};

  // Build a partial UPDATE — only touch the fields the caller actually sent
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };

  if (b.client_name !== undefined)       set('client_name', b.client_name);
  if (b.project_name !== undefined)      set('project_name', b.project_name);
  if (b.invoice_number !== undefined)    set('invoice_number', b.invoice_number);
  if (b.invoice_date !== undefined)      set('invoice_date', b.invoice_date || null);
  if (b.due_date !== undefined)          set('due_date', b.due_date || null);
  if (b.owner_id !== undefined)          set('owner_id', b.owner_id || null);
  if (b.follow_up_status !== undefined)  set('follow_up_status', b.follow_up_status);
  if (b.follow_up_date !== undefined)    set('follow_up_date', b.follow_up_date || null);
  if (b.follow_up_notes !== undefined)   set('follow_up_notes', b.follow_up_notes);
  if (b.escalation_level !== undefined)  set('escalation_level', +b.escalation_level || 0);
  // Collection Engine v2 fields
  if (b.site_id !== undefined)           set('site_id', b.site_id || null);
  if (b.site_name !== undefined)         set('site_name', b.site_name || null);
  if (b.crm_name !== undefined)          set('crm_name', b.crm_name || null);
  if (b.next_planned_date !== undefined) set('next_planned_date', b.next_planned_date || null);
  if (b.last_discussion !== undefined)   set('last_discussion', b.last_discussion || null);

  if (b.invoice_amount !== undefined) {
    const amt = +b.invoice_amount;
    const recv = +cur.received_amount || 0;
    set('invoice_amount', amt);
    set('outstanding_amount', Math.max(0, amt - recv));
  }

  // Recompute ageing if due_date or invoice_amount changed
  if (b.due_date !== undefined || b.invoice_amount !== undefined) {
    const dueDate = b.due_date !== undefined ? (b.due_date || cur.due_date) : cur.due_date;
    const amt = b.invoice_amount !== undefined ? +b.invoice_amount : +cur.invoice_amount;
    const { days, bucket } = calculateAgeing(dueDate);
    set('ageing_days', days);
    set('ageing_bucket', bucket);
    set('status', getStatusColor(amt, days));
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  sets.push('updated_at=CURRENT_TIMESTAMP');
  params.push(req.params.id);
  db.prepare(`UPDATE receivables SET ${sets.join(', ')} WHERE id=?`).run(...params);
  res.json({ message: 'Updated' });
});

// Target vs Received summary, broken down by ageing bucket. Used by the
// "Payment Target vs Received (with Ageing)" panel mam asked for.
//   target           = SUM(invoice_amount)
//   received         = SUM(received_amount)
//   outstanding      = SUM(outstanding_amount)
//   collection_pct   = received / target * 100
//   by_bucket        = same metrics per ageing_bucket
router.get('/target-summary', (req, res) => {
  const db = getDb();
  const overall = db.prepare(`
    SELECT COUNT(*)                      as count,
           COALESCE(SUM(invoice_amount),0)     as target,
           COALESCE(SUM(received_amount),0)    as received,
           COALESCE(SUM(outstanding_amount),0) as outstanding
      FROM receivables
  `).get();
  overall.collection_pct = overall.target > 0 ? +(100 * overall.received / overall.target).toFixed(2) : 0;

  const byBucket = db.prepare(`
    SELECT ageing_bucket,
           COUNT(*)                              as count,
           COALESCE(SUM(invoice_amount),0)       as target,
           COALESCE(SUM(received_amount),0)      as received,
           COALESCE(SUM(outstanding_amount),0)   as outstanding
      FROM receivables
     GROUP BY ageing_bucket
     ORDER BY CASE ageing_bucket
       WHEN '0-30' THEN 0 WHEN '30-60' THEN 1
       WHEN '60-90' THEN 2 WHEN '90+'   THEN 3 ELSE 4 END
  `).all().map(r => ({
    ...r,
    collection_pct: r.target > 0 ? +(100 * r.received / r.target).toFixed(2) : 0,
  }));

  res.json({ overall, by_bucket: byBucket });
});

// Delete receivable (blocks if any collection received)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const received = db.prepare('SELECT COUNT(*) as c FROM collections WHERE receivable_id=?').get(id).c;
  if (received > 0) return res.status(409).json({ error: 'Cannot delete: collections have been recorded against this receivable' });
  db.prepare('DELETE FROM collection_follow_ups WHERE receivable_id=?').run(id);
  db.prepare('DELETE FROM receivables WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Add follow-up
router.post('/:id/follow-up', (req, res) => {
  const { follow_up_date, contact_method, response, promised_date, promised_amount } = req.body;
  const db = getDb();
  db.prepare('INSERT INTO collection_follow_ups (receivable_id, follow_up_date, contact_method, response, promised_date, promised_amount, followed_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, follow_up_date, contact_method, response, promised_date, promised_amount, req.user.id);

  // Update receivable follow-up status
  db.prepare('UPDATE receivables SET follow_up_status=?, follow_up_date=?, follow_up_notes=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run('contacted', follow_up_date, response, req.params.id);

  res.status(201).json({ message: 'Follow-up added' });
});

// Get follow-ups for a receivable
router.get('/:id/follow-ups', (req, res) => {
  const followUps = getDb().prepare('SELECT f.*, u.name as followed_by_name FROM collection_follow_ups f LEFT JOIN users u ON f.followed_by=u.id WHERE f.receivable_id=? ORDER BY f.created_at DESC').all(req.params.id);
  res.json(followUps);
});

// Record collection (payment received from client)
router.post('/:id/collect', (req, res) => {
  const { amount, collection_date, payment_mode, transaction_ref, notes } = req.body;
  if (!amount) return res.status(400).json({ error: 'Amount required' });
  const db = getDb();

  // Record collection
  db.prepare('INSERT INTO collections (receivable_id, amount, collection_date, payment_mode, transaction_ref, notes, collected_by) VALUES (?,?,?,?,?,?,?)')
    .run(req.params.id, amount, collection_date || new Date().toISOString().split('T')[0], payment_mode, transaction_ref, notes, req.user.id);

  // Update receivable
  const rec = db.prepare('SELECT * FROM receivables WHERE id=?').get(req.params.id);
  const newReceived = (rec.received_amount || 0) + amount;
  const newOutstanding = rec.invoice_amount - newReceived;
  const { days, bucket } = calculateAgeing(rec.due_date);
  const statusColor = getStatusColor(newOutstanding, days);

  db.prepare('UPDATE receivables SET received_amount=?, outstanding_amount=?, ageing_days=?, ageing_bucket=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(newReceived, Math.max(0, newOutstanding), days, bucket, statusColor, req.params.id);

  // AUTO-LINK: Add to Cash Flow as inflow
  const today = collection_date || new Date().toISOString().split('T')[0];
  let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date=?').get(today);
  if (!daily) {
    const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
    const r2 = db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?,?,?)').run(today, prev?.closing_balance || 0, prev?.closing_balance || 0);
    daily = { id: r2.lastInsertRowid };
  }
  db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, payment_mode, party_name, reference_type, reference_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(daily.id, today, 'inflow', 'Collection', `Collection from ${rec.client_name} - ${rec.invoice_number || ''}`, amount, payment_mode, rec.client_name, 'collection', req.params.id, req.user.id);

  // Recalculate daily cash flow
  const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='inflow'").get(daily.id);
  const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='outflow'").get(daily.id);
  const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id=?').get(daily.id);
  db.prepare('UPDATE cash_flow_daily SET total_inflows=?, total_outflows=?, closing_balance=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, daily.id);

  res.status(201).json({ message: 'Collection recorded & linked to Cash Flow', new_outstanding: Math.max(0, newOutstanding) });
});

// Refresh all ageing (run daily or on demand)
router.post('/refresh-ageing', (req, res) => {
  const db = getDb();
  const receivables = db.prepare('SELECT * FROM receivables WHERE outstanding_amount > 0').all();
  for (const r of receivables) {
    const { days, bucket } = calculateAgeing(r.due_date);
    const statusColor = getStatusColor(r.outstanding_amount, days);
    db.prepare('UPDATE receivables SET ageing_days=?, ageing_bucket=?, status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(days, bucket, statusColor, r.id);
  }
  res.json({ message: `Ageing refreshed for ${receivables.length} receivables` });
});

module.exports = router;
