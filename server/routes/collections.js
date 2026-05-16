const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const {
  calculateAgeing, getStatusColor,
  syncSalesBillPaymentStatus, ensureTodayCashFlowDaily,
  refreshAllAgeing,
} = require('../lib/cashSync');
const router = express.Router();
router.use(authMiddleware);

// Get all receivables with filters. Now also returns:
//   - pms_tasks_count : how many PMS tasks were raised for this site
//                       (so mam can see at a glance how much CRM
//                       follow-up activity sits behind a delayed payment)
//   - payments        : array of individual collection installments
//                       [{ amount, collection_date, payment_mode, notes }]
//                       so the table can show "today rec 40, +15 in 10 days"
router.get('/', (req, res) => {
  const { status, ageing_bucket, client, search } = req.query;
  // bb_project_name: best-effort lookup of the matching business_book.project_name
  // for this receivable, by matching r.client_name OR r.site_name against either
  // business_book.client_name or business_book.project_name (case-insensitive +
  // trimmed). Lets the UI show the actual project / site label even on legacy
  // receivables that only carry client_name.
  let sql = `
    SELECT r.*,
           u.name as owner_name,
           (SELECT bb.project_name FROM business_book bb
              WHERE bb.project_name IS NOT NULL AND TRIM(bb.project_name) <> ''
                AND (
                     LOWER(TRIM(bb.client_name))   = LOWER(TRIM(COALESCE(r.client_name,'')))
                  OR LOWER(TRIM(bb.project_name))  = LOWER(TRIM(COALESCE(r.client_name,'')))
                  OR LOWER(TRIM(bb.project_name))  = LOWER(TRIM(COALESCE(r.site_name,'')))
                )
              ORDER BY bb.id LIMIT 1
           ) as bb_project_name,
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

// MD Dashboard — one row per site with money + activity in the same view.
// Correlates each receivable with:
//   - pms_tasks_count : how many CRM tasks were raised for the site
//                       (chasing payment / coordination)
//   - location_pings_7d : how many GPS pings happened for the linked site
//                         in the last 7 days (proxy for "is anyone visiting
//                         the client / site to chase payment")
//   - last_follow_up   : most recent collection_follow_up date for this row
//                       (proxy for Aanchal's actual chasing)
//   - oldest_ageing    : ageing days of the oldest unpaid invoice for the
//                       site (so MD instantly sees the worst offender)
// Sorted by outstanding DESC so MD's eye lands on biggest unpaid first.
router.get('/md-dashboard', (req, res) => {
  const db = getDb();
  const since7 = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = db.prepare(`
    SELECT
      COALESCE(r.site_name, r.client_name) as site_name,
      r.site_id,
      MIN(r.crm_name)                       as crm_name,
      MIN(u.name)                           as owner_name,
      COUNT(r.id)                           as invoice_count,
      COALESCE(SUM(r.invoice_amount),0)     as target,
      COALESCE(SUM(r.received_amount),0)    as received,
      COALESCE(SUM(r.outstanding_amount),0) as outstanding,
      MAX(r.ageing_days)                    as oldest_ageing,
      MAX(r.next_planned_date)              as next_planned_date,
      MAX(r.last_discussion)                as last_discussion,
      (SELECT COUNT(*) FROM pms_tasks p
         WHERE (r.site_id IS NOT NULL AND p.project_id = r.site_id)
            OR (r.site_name IS NOT NULL AND r.site_name <> ''
                AND (p.project_name_snapshot = r.site_name
                     OR p.project_name_snapshot LIKE '%' || r.site_name || '%'))
      )                                     as pms_tasks_count,
      (SELECT COUNT(*) FROM location_tracking lt
         WHERE lt.time >= ?
           AND lt.site_name IS NOT NULL AND lt.site_name <> 'Outside'
           AND lt.site_name = COALESCE(r.site_name, r.client_name)
      )                                     as location_pings_7d,
      (SELECT MAX(cf.follow_up_date) FROM collection_follow_ups cf
         WHERE cf.receivable_id = r.id
      )                                     as last_follow_up,
      -- Indents raised for this site — total + last 30 days separately
      -- so MD can see fresh procurement activity vs lifetime activity.
      (SELECT COUNT(*) FROM indents ind
         WHERE ind.site_name = COALESCE(r.site_name, r.client_name)
            OR ind.client_name = COALESCE(r.site_name, r.client_name)
      )                                     as indents_count,
      (SELECT COUNT(*) FROM indents ind
         WHERE (ind.site_name = COALESCE(r.site_name, r.client_name)
                OR ind.client_name = COALESCE(r.site_name, r.client_name))
           AND ind.created_at >= DATE('now', '-30 days')
      )                                     as indents_30d,
      -- Materials value SENT to this site — sums OUT movements whose
      -- site_id matches, plus IN movements at this site's site_store
      -- warehouse (i.e. material physically delivered to the site).
      (SELECT COALESCE(SUM(sm.quantity * sm.rate), 0)
         FROM stock_movements sm
        WHERE (sm.site_id = r.site_id AND r.site_id IS NOT NULL)
           OR sm.warehouse_id IN (
             SELECT w.id FROM warehouses w
              WHERE w.type = 'site_store'
                AND w.name = COALESCE(r.site_name, r.client_name) || ' Store'
           )
      )                                     as materials_value_sent,
      -- DPR entries in the last 30 days for that site
      (SELECT COUNT(*) FROM dpr d
         JOIN sites s ON s.id = d.site_id
        WHERE s.name = COALESCE(r.site_name, r.client_name)
          AND d.created_at >= DATE('now', '-30 days')
      )                                     as dpr_count_30d
    FROM receivables r
    LEFT JOIN users u ON u.id = r.owner_id
    GROUP BY COALESCE(r.site_name, r.client_name)
    ORDER BY outstanding DESC
  `).all(since7);

  // Top-line totals
  const totals = rows.reduce((s, r) => ({
    sites: s.sites + 1,
    target: s.target + (+r.target || 0),
    received: s.received + (+r.received || 0),
    outstanding: s.outstanding + (+r.outstanding || 0),
    pms_tasks: s.pms_tasks + (+r.pms_tasks_count || 0),
    location_pings_7d: s.location_pings_7d + (+r.location_pings_7d || 0),
    indents_count: s.indents_count + (+r.indents_count || 0),
    indents_30d: s.indents_30d + (+r.indents_30d || 0),
    materials_value_sent: s.materials_value_sent + (+r.materials_value_sent || 0),
    dpr_count_30d: s.dpr_count_30d + (+r.dpr_count_30d || 0),
  }), { sites: 0, target: 0, received: 0, outstanding: 0, pms_tasks: 0, location_pings_7d: 0, indents_count: 0, indents_30d: 0, materials_value_sent: 0, dpr_count_30d: 0 });
  totals.collection_pct = totals.target > 0 ? +(100 * totals.received / totals.target).toFixed(2) : 0;

  // Flag rows where outstanding is significant AND there's NO recent
  // activity — these are the "silent overdue" sites MD should grill.
  const flagged = rows.filter(r =>
    +r.outstanding > 0 && +r.oldest_ageing > 30 &&
    +r.pms_tasks_count === 0 && +r.location_pings_7d === 0
  );

  res.json({ totals, sites: rows, silent_overdue_count: flagged.length });
});

// Helper for the Edit/Add modal — UNIQUE PROJECT NAMES from the
// Business Book master. mam: "in collection eng site name is project
// name". So the dropdown lists distinct business_book.project_name
// values (CONSERN PHARMA appears once even though 3 BB rows reference
// it across different POs). Latest PO of any BB row sharing that
// project name is used to auto-fill CRM + suggest target payment.
router.get('/sites', (req, res) => {
  const db = getDb();
  // mam's spec: the Site Name dropdown is EVERY non-empty project_name from
  // Business Book — that's the single source of truth. Each project_name
  // appears once (DISTINCT). Latest PO value + crm_name are pulled per
  // project for auto-fill convenience.
  const rows = db.prepare(`
    SELECT MIN(bb.id)            as business_book_id,
           bb.project_name        as name,
           bb.project_name        as project_name,
           GROUP_CONCAT(DISTINCT bb.client_name)  as client_names,
           GROUP_CONCAT(DISTINCT bb.company_name) as company_names,
           MIN(bb.lead_no)        as lead_no,
           (SELECT po.crm_name FROM purchase_orders po
              JOIN business_book bb2 ON bb2.id = po.business_book_id
             WHERE TRIM(bb2.project_name) = TRIM(bb.project_name)
               AND po.crm_name IS NOT NULL AND po.crm_name <> ''
             ORDER BY po.created_at DESC LIMIT 1) as crm_name,
           (SELECT COALESCE(SUM(po.total_amount), 0) FROM purchase_orders po
              JOIN business_book bb2 ON bb2.id = po.business_book_id
             WHERE TRIM(bb2.project_name) = TRIM(bb.project_name)) as latest_po_value,
           (SELECT po.po_number FROM purchase_orders po
              JOIN business_book bb2 ON bb2.id = po.business_book_id
             WHERE TRIM(bb2.project_name) = TRIM(bb.project_name)
             ORDER BY po.created_at DESC LIMIT 1) as latest_po_number
      FROM business_book bb
     WHERE bb.project_name IS NOT NULL AND TRIM(bb.project_name) <> ''
     GROUP BY TRIM(bb.project_name)
     ORDER BY bb.project_name
  `).all();

  // Label = project_name + client_names (first one) so mam can search by
  // either ("Pune Tower", "Hagerstone", etc.) and still pick the right site.
  const list = rows.map(r => ({
    ...r,
    id: r.business_book_id,
    project_name: r.project_name,
    client_name: (r.client_names || '').split(',')[0] || null,
    company_name: (r.company_names || '').split(',')[0] || null,
    label: [r.name, r.client_names].filter(Boolean).join(' · '),
  }));
  res.json(list);
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

  // Defensive FK validators — these columns reference users(id) / sites(id),
  // but the receivable rows may carry stale references to sites/users that
  // were since deleted (data drift). Without this guard, every Edit Save
  // triggers SQLite "FOREIGN KEY constraint failed" because the row's old
  // value re-enters the UPDATE. We coerce unknown ids to NULL so the save
  // always succeeds — the field stays empty until the user picks a fresh value.
  const userExists = (id) => {
    const v = +id; if (!Number.isFinite(v) || v <= 0) return false;
    return !!db.prepare('SELECT 1 FROM users WHERE id=?').get(v);
  };
  const siteExists = (id) => {
    const v = +id; if (!Number.isFinite(v) || v <= 0) return false;
    return !!db.prepare('SELECT 1 FROM sites WHERE id=?').get(v);
  };

  if (b.owner_id !== undefined)          set('owner_id', userExists(b.owner_id) ? +b.owner_id : null);
  if (b.follow_up_status !== undefined)  set('follow_up_status', b.follow_up_status);
  if (b.follow_up_date !== undefined)    set('follow_up_date', b.follow_up_date || null);
  if (b.follow_up_notes !== undefined)   set('follow_up_notes', b.follow_up_notes);
  if (b.escalation_level !== undefined)  set('escalation_level', +b.escalation_level || 0);
  // Collection Engine v2 fields
  if (b.site_id !== undefined)           set('site_id', siteExists(b.site_id) ? +b.site_id : null);
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

  // A9 — sync sales_bills.payment_status if this receivable is
  // linked to a sales bill (via invoice_number = bill_number).
  // Quietly no-ops when no bill is linked.
  const billSync = syncSalesBillPaymentStatus(db, req.params.id);

  // AUTO-LINK + A14 — Add to Cash Flow as inflow; ensureTodayCashFlowDaily
  // creates today's row with opening = yesterday closing if missing.
  const today = collection_date || new Date().toISOString().split('T')[0];
  const dailyRes = ensureTodayCashFlowDaily(db, today);
  const daily = { id: dailyRes.id };
  db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, payment_mode, party_name, reference_type, reference_id, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
    .run(daily.id, today, 'inflow', 'Collection', `Collection from ${rec.client_name} - ${rec.invoice_number || ''}`, amount, payment_mode, rec.client_name, 'collection', req.params.id, req.user.id);

  // Recalculate daily cash flow
  const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='inflow'").get(daily.id);
  const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id=? AND type='outflow'").get(daily.id);
  const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id=?').get(daily.id);
  db.prepare('UPDATE cash_flow_daily SET total_inflows=?, total_outflows=?, closing_balance=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, daily.id);

  res.status(201).json({
    message: 'Collection recorded & linked to Cash Flow',
    new_outstanding: Math.max(0, newOutstanding),
    sales_bill_synced: billSync.synced > 0 ? billSync : null,
  });
});

// Refresh all ageing (run daily or on demand).  Same code path as
// the 01:00 cron in scripts/cashFidelityCron.js — shared helper.
router.post('/refresh-ageing', (req, res) => {
  const r = refreshAllAgeing(getDb());
  res.json({ message: `Ageing refreshed for ${r.updated} receivables` });
});

module.exports = router;
