const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// ============= PROJECT FINANCIAL TRACKER =============

// GET all projects with financial data.
// Non-admin users only see projects where they are the assigned CRM —
// match by employee_assigned containing their name or first name.
router.get('/projects', requirePermission('cashflow', 'view'), (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const isAdmin = req.user.role === 'admin';
  // Bypass the CRM-name scope filter when the role has can_approve OR
  // can_see_all on cashflow — that's the explicit "see everyone's
  // projects" toggle in Roles & Permissions. Accountant / Auditor /
  // any role mam ticks See All for, gets the full list like admin.
  const canSeeAll = isAdmin || (() => {
    const r = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'cashflow'
    `).get(req.user.id);
    return !!r?.ok;
  })();

  // GROUP BY company_name — one row per logical project. The bug was
  // that bb.sale_amount_without_gst etc. were SELECTed without an
  // aggregate so SQLite picked a single arbitrary row's value (mam:
  // "concern pharma has 21 BB entries but Sale Value showed only one
  // order"). Now SUMs across every BB row sharing the same project
  // name so totals are correct. Same for PO / Advance / Balance.
  // Dates: take earliest start and latest completion across rows.
  let sql = `SELECT MIN(bb.id) as id,
    MAX(bb.lead_no) as lead_no,
    bb.company_name as project_name,
    MAX(bb.client_name) as client_name,
    MAX(bb.employee_assigned) as crm_person,
    COALESCE(SUM(bb.sale_amount_without_gst), 0) as sale_amount_without_gst,
    COALESCE(SUM(bb.po_amount), 0) as po_amount,
    COALESCE(SUM(bb.advance_received), 0) as advance_received,
    COALESCE(SUM(bb.balance_amount), 0) as balance_amount,
    MAX(bb.category) as category,
    MAX(bb.order_type) as order_type,
    MIN(bb.committed_start_date) as committed_start_date,
    MAX(bb.committed_completion_date) as committed_completion_date,
    MIN(bb.created_at) as created_at,
    MAX(s.name) as site_name,
    COUNT(bb.id) as bb_entry_count
    FROM business_book bb
    LEFT JOIN sites s ON s.business_book_id=bb.id`;
  const params = [];
  if (!canSeeAll) {
    const fullName = (req.user.name || '').trim();
    const firstName = fullName.split(/\s+/)[0] || fullName;
    sql += ` WHERE (LOWER(COALESCE(bb.employee_assigned,'')) LIKE ? OR LOWER(COALESCE(bb.employee_assigned,'')) LIKE ?)`;
    params.push(`%${fullName.toLowerCase()}%`, `%${firstName.toLowerCase()}%`);
  }
  sql += ' GROUP BY bb.company_name ORDER BY bb.company_name';
  const projects = db.prepare(sql).all(...params);

  const result = projects.map((p, idx) => {
    // Amount received (from cash flow inflows for this client)
    const received = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE type='inflow' AND party_name LIKE ?").get(`%${p.client_name}%`);

    // Purchase value — only payment_requests where category='Purchase' for this
    // site/project (mam: 'purchase value is pick from payment required where
    // we select category Purchase'). Includes approved + pending so the tracker
    // reflects actual commitment, not just cleared amounts.
    const purchaseValue = db.prepare(
      "SELECT COALESCE(SUM(amount),0) as total FROM payment_requests WHERE category='Purchase' AND site_name LIKE ?"
    ).get(`%${p.project_name}%`);

    // Total PO value + CRM from the latest Client PO uploaded for this project.
    // mam: 'CRM name is pick from client PO upload'.
    const totalPO = db.prepare(
      `SELECT COALESCE(SUM(po.total_amount),0) as total
       FROM purchase_orders po JOIN business_book bb ON po.business_book_id=bb.id
       WHERE bb.company_name=?`
    ).get(p.project_name);
    const poCrm = db.prepare(
      `SELECT po.crm_name FROM purchase_orders po
       JOIN business_book bb ON po.business_book_id=bb.id
       WHERE bb.company_name=? AND po.crm_name IS NOT NULL AND po.crm_name != ''
       ORDER BY po.created_at DESC LIMIT 1`
    ).get(p.project_name);

    const amountReceived = received?.total || 0;
    const purchaseAmt = purchaseValue?.total || 0;

    // Get manual fields from project_finance
    const pf = db.prepare('SELECT * FROM project_finance WHERE business_book_id=?').get(p.id);
    const aanchalValue = (pf?.aanchal_value || 0) * 100000; // in Rs (aanchal stored in lakhs)
    const paymentInvestDays = pf?.payment_investment_days || 0;
    const manualPaymentDays = pf?.payment_days || 0;

    // Days calculation
    const startDate = p.committed_start_date ? new Date(p.committed_start_date) : new Date(p.created_at);
    const completionDate = p.committed_completion_date ? new Date(p.committed_completion_date) : null;
    const todayDate = new Date(today);
    const computedCompletionDays = completionDate ? Math.ceil((completionDate - startDate) / (1000 * 60 * 60 * 24)) : 0;
    const paymentDays = manualPaymentDays; // Q: Payment Days (manual)

    // Effective completion days — manual override (project_finance) takes
    // precedence over the date-computed value. The TOTAL displayed in the
    // grid must use this same effective value, otherwise the row reads
    // (manual 10) + (manual 10) = 25 because the totalDays kept silently
    // using the date-computed 15 instead of the manual override 10.
    const effCompletion = pf?.manual_completion_days ?? computedCompletionDays;
    const totalDays = effCompletion + paymentDays; // R: Total = P (effective) + Q

    // Cash Velocity = (J - K) / R = (Aanchal Value - Purchase Value) / Total Days
    const effPurchase = pf?.manual_purchase_value != null ? pf.manual_purchase_value * 100000 : purchaseAmt;
    const cashVelocity = totalDays > 0 ? Math.round(((aanchalValue - effPurchase) / totalDays / 100000) * 100) / 100 : 0;

    return {
      sr_no: idx + 1,
      id: p.id,
      bb_entry_count: p.bb_entry_count || 1,  // how many BB rows summed into this project
      project_name: p.project_name || p.client_name,
      // CRM comes from the Client PO if available, falls back to Business Book's employee_assigned
      crm_person: poCrm?.crm_name || p.crm_person,
      category: p.category,
      sale_amount: p.sale_amount_without_gst || 0,
      po_amount: totalPO?.total || p.po_amount || 0,
      amount_received: pf?.amount_received || amountReceived, // H: Tally (manual)
      milestone_name: pf?.milestone_name || '',  // I: Milestone (manual)
      aanchal_value: pf?.aanchal_value || 0,  // J: Aanchal Value (in lakhs, manual)
      purchase_value: pf?.manual_purchase_value != null ? pf.manual_purchase_value * 100000 : purchaseAmt, // K: Purchase Value (auto from FMS)
      cash_velocity: cashVelocity,  // M: (J-K)/R
      live_date: today,  // N: Today
      payment_investment_days: paymentInvestDays,  // O: Manual by Nitin ji
      completion_days: effCompletion,  // P: manual override OR computed from dates
      payment_days: paymentDays,  // Q: Manual
      total_days: totalDays,  // R: effective P + Q (now consistent with displayed P + Q)
      committed_start: p.committed_start_date,
      committed_completion: p.committed_completion_date,
    };
  });

  // Summary
  const totalSale = result.reduce((s, r) => s + r.sale_amount, 0);
  const totalReceived = result.reduce((s, r) => s + r.amount_received, 0);
  const totalPurchase = result.reduce((s, r) => s + r.purchase_value, 0);
  // Total Value = sum of Aanchal Values (manual entry, stored in lakhs).
  // Multiply by 100,000 so the dashboard shows full rupees consistent with
  // the rest of the cards.
  const totalValue = result.reduce((s, r) => s + (r.aanchal_value || 0), 0) * 100000;

  res.json({ projects: result, summary: { totalSale, totalReceived, totalValue, totalPurchase, projectCount: result.length } });
});

// POST update project manual fields (milestone, aanchal value, payment days)
router.post('/projects/:id/update', requirePermission('cashflow', 'edit'), (req, res) => {
  const { crm_person, amount_received, milestone_name, aanchal_value, payment_investment_days, payment_days, manual_purchase_value, manual_completion_days } = req.body;
  const db = getDb();
  // Add payment_days column if missing
  try { db.exec('ALTER TABLE project_finance ADD COLUMN payment_days INTEGER DEFAULT 0'); } catch(e) {}
  try { db.exec('ALTER TABLE project_finance ADD COLUMN manual_purchase_value REAL'); } catch(e) {}
  try { db.exec('ALTER TABLE project_finance ADD COLUMN manual_completion_days INTEGER'); } catch(e) {}
  if (crm_person !== undefined) {
    db.prepare('UPDATE business_book SET employee_assigned=? WHERE id=?').run(crm_person, req.params.id);
  }
  db.prepare('INSERT OR REPLACE INTO project_finance (business_book_id, amount_received, milestone_name, aanchal_value, payment_investment_days, payment_days, manual_purchase_value, manual_completion_days, updated_at) VALUES (?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)')
    .run(req.params.id, amount_received || 0, milestone_name, aanchal_value || 0, payment_investment_days || 0, payment_days || 0, manual_purchase_value ?? null, manual_completion_days ?? null);
  res.json({ message: 'Updated' });
});

// ============= DAILY CASH FLOW (existing) =============

router.get('/daily', (req, res) => {
  const { from, to } = req.query;
  let sql = 'SELECT * FROM cash_flow_daily WHERE 1=1';
  const params = [];
  if (from) { sql += ' AND date >= ?'; params.push(from); }
  if (to) { sql += ' AND date <= ?'; params.push(to); }
  sql += ' ORDER BY date DESC';
  res.json(getDb().prepare(sql).all(...params));
});

router.get('/today', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  let daily = db.prepare('SELECT * FROM cash_flow_daily WHERE date = ?').get(today);
  if (!daily) {
    const yesterday = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(today);
    const opening = yesterday?.closing_balance || 0;
    db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance) VALUES (?, ?, ?)').run(today, opening, opening);
    daily = db.prepare('SELECT * FROM cash_flow_daily WHERE date = ?').get(today);
  }
  res.json(daily);
});

router.get('/summary', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  // Mam: "upper why not showing" — the top 4 cards used to be hard-wired
  // to today's row only and stayed at Rs 0 whenever the user picked a
  // different date. Now they reflect the date the client asks for
  // (?date=YYYY-MM-DD); when no row exists for that date we derive the
  // opening = closing from the most recent prior day so the numbers
  // make sense even for days nobody recorded entries.
  const targetDate = req.query.date || today;
  let rowData = db.prepare('SELECT * FROM cash_flow_daily WHERE date = ?').get(targetDate);
  if (!rowData) {
    const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(targetDate);
    const carry = prev?.closing_balance || 0;
    rowData = { date: targetDate, opening_balance: carry, total_inflows: 0, total_outflows: 0, closing_balance: carry };
  }
  const last7 = db.prepare('SELECT * FROM cash_flow_daily ORDER BY date DESC LIMIT 7').all();
  const monthStart = targetDate.substring(0, 7) + '-01';
  const monthInflow = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE date >= ? AND type = 'inflow'").get(monthStart);
  const monthOutflow = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM cash_flow_entries WHERE date >= ? AND type = 'outflow'").get(monthStart);
  res.json({
    // Field name stays `today` for frontend compatibility — it's the
    // selected-date row now, not literal today.
    today: rowData,
    last7Days: last7,
    monthlyInflow: monthInflow.total,
    monthlyOutflow: monthOutflow.total,
  });
});

router.post('/entry', (req, res) => {
  const { date, type, category, description, amount, payment_mode, party_name } = req.body;
  if (!date || !type || !category || !description || !amount) return res.status(400).json({ error: 'All fields required' });
  const db = getDb();
  let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date = ?').get(date);
  if (!daily) {
    const prev = db.prepare('SELECT closing_balance FROM cash_flow_daily WHERE date < ? ORDER BY date DESC LIMIT 1').get(date);
    const r = db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance, created_by) VALUES (?, ?, ?, ?)').run(date, prev?.closing_balance || 0, prev?.closing_balance || 0, req.user.id);
    daily = { id: r.lastInsertRowid };
  }
  db.prepare('INSERT INTO cash_flow_entries (daily_id, date, type, category, description, amount, payment_mode, party_name, created_by) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(daily.id, date, type, category, description, amount, payment_mode, party_name, req.user.id);
  const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'inflow'").get(daily.id);
  const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'outflow'").get(daily.id);
  const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id = ?').get(daily.id);
  const closing = (opening?.opening_balance || 0) + inflows.t - outflows.t;
  db.prepare('UPDATE cash_flow_daily SET total_inflows = ?, total_outflows = ?, closing_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(inflows.t, outflows.t, closing, daily.id);
  res.status(201).json({ message: 'Entry added', closing_balance: closing });
});

router.get('/entries/:date', (req, res) => {
  res.json(getDb().prepare('SELECT e.*, u.name as created_by_name FROM cash_flow_entries e LEFT JOIN users u ON e.created_by=u.id WHERE e.date = ? ORDER BY e.created_at DESC').all(req.params.date));
});

router.delete('/entry/:id', (req, res) => {
  const db = getDb();
  const entry = db.prepare('SELECT * FROM cash_flow_entries WHERE id = ?').get(req.params.id);
  if (!entry) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM cash_flow_entries WHERE id = ?').run(req.params.id);
  const inflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'inflow'").get(entry.daily_id);
  const outflows = db.prepare("SELECT COALESCE(SUM(amount),0) as t FROM cash_flow_entries WHERE daily_id = ? AND type = 'outflow'").get(entry.daily_id);
  const opening = db.prepare('SELECT opening_balance FROM cash_flow_daily WHERE id = ?').get(entry.daily_id);
  db.prepare('UPDATE cash_flow_daily SET total_inflows = ?, total_outflows = ?, closing_balance = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(inflows.t, outflows.t, (opening?.opening_balance || 0) + inflows.t - outflows.t, entry.daily_id);
  res.json({ message: 'Deleted' });
});

router.post('/opening-balance', (req, res) => {
  const { date, opening_balance } = req.body;
  const db = getDb();
  let daily = db.prepare('SELECT id FROM cash_flow_daily WHERE date = ?').get(date);
  if (daily) {
    db.prepare('UPDATE cash_flow_daily SET opening_balance = ? WHERE id = ?').run(opening_balance, daily.id);
  } else {
    db.prepare('INSERT INTO cash_flow_daily (date, opening_balance, closing_balance, created_by) VALUES (?, ?, ?, ?)').run(date, opening_balance, opening_balance, req.user.id);
  }
  daily = db.prepare('SELECT * FROM cash_flow_daily WHERE date = ?').get(date);
  const closing = opening_balance + (daily.total_inflows || 0) - (daily.total_outflows || 0);
  db.prepare('UPDATE cash_flow_daily SET closing_balance = ? WHERE date = ?').run(closing, date);
  res.json({ message: 'Set', closing_balance: closing });
});

module.exports = router;
