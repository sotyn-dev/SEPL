// CMD Audit JSON endpoint — per Master Prompt v3 spec.
// Read-only, token-authenticated, lives OUTSIDE /api/* so it has a
// distinct URL surface (`securederp.in/audit`) that an external
// scheduler (Claude's daily 9 AM email job, or any other automated
// caller) can hit without going through the session-cookie flow.
//
// Endpoints:
//   GET /audit                — 12 KPI tiles + 5 exception lists
//   GET /audit/data-quality   — per-table null/quality scorecard
//   GET /audit/analytics      — 30-day rolling activity analytics
//
// Auth: pass `Authorization: Bearer <AUDIT_API_TOKEN>` header OR
//       `?token=<AUDIT_API_TOKEN>` query.  Token is set per environment
//       in pm2 (`pm2 set ERP:AUDIT_API_TOKEN ...`) or `.env`.
//
// Mam's MD requested this so Claude can generate a daily 9 AM audit
// email for the CMD without giving the AI a user login.

const express = require('express');
const fs = require('fs');
const path = require('path');
const { getDb } = require('../db/schema');

const router = express.Router();

// --- Token auth -----------------------------------------------------
// Keep this here rather than in middleware/auth.js because the rest of
// auth.js is session/cookie-based.  Audit traffic is server-to-server.
router.use((req, res, next) => {
  const expected = process.env.AUDIT_API_TOKEN;
  if (!expected || expected.length < 8) {
    return res.status(503).json({
      error: 'audit_token_unconfigured',
      hint: 'Set AUDIT_API_TOKEN (>=8 chars) in the server environment',
    });
  }
  const headerTok = (req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const queryTok = (req.query.token || '').trim();
  const provided = headerTok || queryTok;
  if (provided !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
});

// --- Small helpers --------------------------------------------------
const today = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n) => {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const monthStart = () => {
  const d = new Date(); d.setDate(1);
  return d.toISOString().slice(0, 10);
};
// Safe wrapper: SQLite throws if a queried table doesn't exist on a
// fresh install.  Returning 0/[] keeps the response shape stable.
const safeGet = (db, sql, ...params) => {
  try { return db.prepare(sql).get(...params); } catch { return null; }
};
const safeAll = (db, sql, ...params) => {
  try { return db.prepare(sql).all(...params); } catch { return []; }
};
const safeCount = (db, sql, ...params) => {
  const r = safeGet(db, sql, ...params);
  if (!r) return 0;
  return r.c || r.count || Object.values(r)[0] || 0;
};

// --- 12 KPI tiles ---------------------------------------------------
function computeKpis(db) {
  const t = today();
  const mStart = monthStart();

  return [
    {
      id: 'active_sites',
      label: 'Active Sites',
      value: safeCount(db, `SELECT COUNT(*) c FROM sites WHERE status='active'`),
      unit: 'count',
    },
    {
      id: 'open_pos',
      label: 'Open Purchase Orders',
      value: safeCount(db, `SELECT COUNT(*) c FROM purchase_orders WHERE status NOT IN ('completed')`),
      unit: 'count',
    },
    {
      id: 'mtd_sale_value',
      label: 'MTD Sale Value (ex-GST)',
      value: Math.round((safeGet(db, `SELECT COALESCE(SUM(sale_amount_without_gst),0) c FROM business_book WHERE date(created_at) >= ?`, mStart)?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'mtd_received',
      label: 'MTD Cash Received',
      value: Math.round((safeGet(db, `SELECT COALESCE(SUM(amount),0) c FROM cash_flow_entries WHERE type='inflow' AND date >= ?`, mStart)?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'outstanding_receivables',
      label: 'Total Outstanding Receivables',
      value: Math.round((safeGet(db, `SELECT COALESCE(SUM(outstanding_amount),0) c FROM receivables`)?.c) || 0),
      unit: 'inr',
    },
    {
      id: 'overdue_receivables',
      label: 'Overdue (>60d) Receivables',
      value: safeCount(db, `SELECT COUNT(*) c FROM receivables WHERE ageing_bucket IN ('61-90','90+')`),
      unit: 'count',
    },
    {
      id: 'dpr_submitted_today',
      label: 'DPRs Submitted Today',
      value: safeCount(db, `SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date = ?`, t),
      unit: 'count',
    },
    {
      id: 'dpr_missing_today',
      label: 'Sites Missing DPR Today',
      value: Math.max(0,
        safeCount(db, `SELECT COUNT(*) c FROM sites WHERE status='active'`) -
        safeCount(db, `SELECT COUNT(DISTINCT site_id) c FROM dpr WHERE report_date = ?`, t)),
      unit: 'count',
    },
    {
      id: 'pending_payment_requests',
      label: 'Pending Payment Requests',
      value: safeCount(db, `SELECT COUNT(*) c FROM payment_requests WHERE status NOT IN ('final_approved','rejected')`),
      unit: 'count',
    },
    {
      id: 'pending_indents',
      label: 'Pending Indents',
      value: safeCount(db, `SELECT COUNT(*) c FROM indents WHERE status NOT IN ('approved','completed','rejected')`),
      unit: 'count',
    },
    {
      id: 'active_employees',
      label: 'Active Employees',
      value: safeCount(db, `SELECT COUNT(*) c FROM employees WHERE status='active'`),
      unit: 'count',
    },
    {
      id: 'cheques_open',
      label: 'Cheques Awaiting Action',
      value: safeCount(db, `SELECT COUNT(*) c FROM cheques WHERE current_status IN ('pending','hold')`),
      unit: 'count',
    },
  ];
}

// --- Exception list 1: Duplicates -----------------------------------
function findDuplicates(db) {
  const out = [];
  // BB duplicates by client_name + project_name (case-insensitive)
  safeAll(db, `
    SELECT LOWER(TRIM(client_name)) k1, LOWER(TRIM(project_name)) k2,
           COUNT(*) cnt, GROUP_CONCAT(id) ids, GROUP_CONCAT(lead_no) leads
    FROM business_book
    WHERE client_name IS NOT NULL AND project_name IS NOT NULL
    GROUP BY k1, k2 HAVING cnt > 1
  `).forEach(r => out.push({
    table: 'business_book', kind: 'client_project_pair',
    key: `${r.k1} | ${r.k2}`, count: r.cnt, ids: r.ids, leads: r.leads,
  }));
  // Vendors with same name
  safeAll(db, `
    SELECT LOWER(TRIM(name)) k, COUNT(*) cnt, GROUP_CONCAT(id) ids
    FROM vendors WHERE name IS NOT NULL
    GROUP BY k HAVING cnt > 1
  `).forEach(r => out.push({
    table: 'vendors', kind: 'name', key: r.k, count: r.cnt, ids: r.ids,
  }));
  // Customers with same company_name
  safeAll(db, `
    SELECT LOWER(TRIM(company_name)) k, COUNT(*) cnt, GROUP_CONCAT(id) ids
    FROM customers WHERE company_name IS NOT NULL
    GROUP BY k HAVING cnt > 1
  `).forEach(r => out.push({
    table: 'customers', kind: 'company_name', key: r.k, count: r.cnt, ids: r.ids,
  }));
  // Item master with same name+spec+make
  safeAll(db, `
    SELECT LOWER(TRIM(item_name)) k1, LOWER(TRIM(IFNULL(specification,''))) k2,
           LOWER(TRIM(IFNULL(make,''))) k3, COUNT(*) cnt, GROUP_CONCAT(id) ids
    FROM item_master WHERE item_name IS NOT NULL
    GROUP BY k1, k2, k3 HAVING cnt > 1
  `).forEach(r => out.push({
    table: 'item_master', kind: 'name_spec_make',
    key: `${r.k1} | ${r.k2} | ${r.k3}`, count: r.cnt, ids: r.ids,
  }));
  // PO numbers — these should be UNIQUE; if duplicates exist it's a constraint failure
  safeAll(db, `
    SELECT po_number k, COUNT(*) cnt, GROUP_CONCAT(id) ids
    FROM purchase_orders WHERE po_number IS NOT NULL
    GROUP BY po_number HAVING cnt > 1
  `).forEach(r => out.push({
    table: 'purchase_orders', kind: 'po_number_dup',
    key: r.k, count: r.cnt, ids: r.ids, severity: 'critical',
  }));
  return out;
}

// --- Exception list 2: Arithmetic errors ----------------------------
function findArithmeticErrors(db) {
  const out = [];
  // sales_bills: amount + gst_amount should equal total_amount (within 1 rupee)
  safeAll(db, `
    SELECT id, bill_number, amount, gst_amount, total_amount,
           ROUND(total_amount - amount - gst_amount, 2) diff
    FROM sales_bills
    WHERE total_amount > 0
      AND ABS(total_amount - amount - gst_amount) > 1
    LIMIT 100
  `).forEach(r => out.push({
    table: 'sales_bills', id: r.id, ref: r.bill_number,
    expected: r.amount + r.gst_amount, actual: r.total_amount, diff: r.diff,
  }));
  // purchase_bills: same check
  safeAll(db, `
    SELECT id, bill_number, amount, gst_amount, total_amount,
           ROUND(total_amount - amount - gst_amount, 2) diff
    FROM purchase_bills
    WHERE total_amount > 0
      AND ABS(total_amount - amount - gst_amount) > 1
    LIMIT 100
  `).forEach(r => out.push({
    table: 'purchase_bills', id: r.id, ref: r.bill_number,
    expected: r.amount + r.gst_amount, actual: r.total_amount, diff: r.diff,
  }));
  // PO total vs sum of po_items.amount (when items exist)
  safeAll(db, `
    SELECT p.id, p.po_number, p.total_amount,
           ROUND((SELECT SUM(amount) FROM po_items WHERE po_id=p.id), 2) items_sum
    FROM purchase_orders p
    WHERE p.total_amount > 0
      AND EXISTS (SELECT 1 FROM po_items WHERE po_id=p.id)
      AND ABS(p.total_amount - (SELECT SUM(amount) FROM po_items WHERE po_id=p.id)) > 10
    LIMIT 100
  `).forEach(r => out.push({
    table: 'purchase_orders', id: r.id, ref: r.po_number,
    expected: r.items_sum, actual: r.total_amount,
    diff: Math.round((r.total_amount - r.items_sum) * 100) / 100,
  }));
  // DPR grand_total_b should be roughly profit_loss + grand_total_a (sanity)
  safeAll(db, `
    SELECT id, report_date, site_id, grand_total_a, grand_total_b, profit_loss,
           ROUND((grand_total_a - grand_total_b) - profit_loss, 2) diff
    FROM dpr
    WHERE (grand_total_a > 0 OR grand_total_b > 0)
      AND ABS((grand_total_a - grand_total_b) - profit_loss) > 1
    LIMIT 100
  `).forEach(r => out.push({
    table: 'dpr', id: r.id, ref: `site=${r.site_id} ${r.report_date}`,
    expected: r.grand_total_a - r.grand_total_b, actual: r.profit_loss, diff: r.diff,
  }));
  return out;
}

// --- Exception list 3: Missing required fields ----------------------
function findMissingRequired(db) {
  const out = [];
  const push = (table, id, ref, missing) =>
    out.push({ table, id, ref, missing });

  safeAll(db, `
    SELECT id, lead_no, client_name, po_amount, sale_amount_without_gst
    FROM business_book
    WHERE lead_no IS NULL OR lead_no=''
       OR client_name IS NULL OR client_name=''
       OR (po_amount IS NULL OR po_amount=0)
    LIMIT 100
  `).forEach(r => {
    const m = [];
    if (!r.lead_no) m.push('lead_no');
    if (!r.client_name) m.push('client_name');
    if (!r.po_amount) m.push('po_amount');
    push('business_book', r.id, r.lead_no || `#${r.id}`, m);
  });

  safeAll(db, `
    SELECT id, po_number, po_date, total_amount
    FROM purchase_orders
    WHERE po_number IS NULL OR po_number=''
       OR po_date IS NULL OR po_date=''
       OR (total_amount IS NULL OR total_amount=0)
    LIMIT 100
  `).forEach(r => {
    const m = [];
    if (!r.po_number) m.push('po_number');
    if (!r.po_date) m.push('po_date');
    if (!r.total_amount) m.push('total_amount');
    push('purchase_orders', r.id, r.po_number || `#${r.id}`, m);
  });

  safeAll(db, `
    SELECT id, name, phone, email FROM vendors
    WHERE (phone IS NULL OR phone='') AND (email IS NULL OR email='')
    LIMIT 100
  `).forEach(r => push('vendors', r.id, r.name, ['phone', 'email']));

  safeAll(db, `
    SELECT id, company_name, contact_no, email FROM customers
    WHERE (contact_no IS NULL OR contact_no='') AND (email IS NULL OR email='')
    LIMIT 100
  `).forEach(r => push('customers', r.id, r.company_name, ['contact_no', 'email']));

  safeAll(db, `
    SELECT id, name, address FROM sites
    WHERE address IS NULL OR address=''
    LIMIT 100
  `).forEach(r => push('sites', r.id, r.name, ['address']));

  safeAll(db, `
    SELECT id, name, phone FROM employees
    WHERE status='active' AND (phone IS NULL OR phone='')
    LIMIT 100
  `).forEach(r => push('employees', r.id, r.name, ['phone']));

  return out;
}

// --- Exception list 4: Stale records --------------------------------
function findStaleRecords(db) {
  const out = [];
  // POs stuck in 'received' for >30 days — should have moved on by now
  safeAll(db, `
    SELECT id, po_number, po_date, created_at FROM purchase_orders
    WHERE status='received' AND date(created_at) < ?
    LIMIT 100
  `, daysAgo(30)).forEach(r => out.push({
    table: 'purchase_orders', id: r.id, ref: r.po_number,
    reason: 'status=received for >30 days', age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  // Receivables 90+ days old without escalation
  safeAll(db, `
    SELECT id, invoice_number, client_name, ageing_bucket, follow_up_status, outstanding_amount
    FROM receivables
    WHERE ageing_bucket='90+'
      AND follow_up_status NOT IN ('escalated','legal')
      AND outstanding_amount > 1000
    LIMIT 100
  `).forEach(r => out.push({
    table: 'receivables', id: r.id, ref: r.invoice_number || r.client_name,
    reason: `90+ days old, follow_up=${r.follow_up_status}, ₹${r.outstanding_amount}`,
  }));
  // Complaints open >14 days
  safeAll(db, `
    SELECT id, complaint_number, client_name, created_at FROM complaints
    WHERE status='open' AND date(created_at) < ?
    LIMIT 100
  `, daysAgo(14)).forEach(r => out.push({
    table: 'complaints', id: r.id, ref: r.complaint_number || r.client_name,
    reason: 'open complaint >14 days', age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  // Snags open >30 days
  safeAll(db, `
    SELECT id, snag_no, description, raised_at FROM snags
    WHERE status='open' AND date(raised_at) < ?
    LIMIT 100
  `, daysAgo(30)).forEach(r => out.push({
    table: 'snags', id: r.id, ref: r.snag_no || `#${r.id}`,
    reason: 'open snag >30 days', age_days: Math.floor((Date.now() - new Date(r.raised_at).getTime()) / 86400000),
  }));
  // Indents pending >14 days
  safeAll(db, `
    SELECT id, indent_number, status, created_at FROM indents
    WHERE status NOT IN ('approved','completed','rejected')
      AND date(created_at) < ?
    LIMIT 100
  `, daysAgo(14)).forEach(r => out.push({
    table: 'indents', id: r.id, ref: r.indent_number,
    reason: `status=${r.status} >14 days`, age_days: Math.floor((Date.now() - new Date(r.created_at).getTime()) / 86400000),
  }));
  return out;
}

// --- Exception list 5: Schema drift ---------------------------------
// Expected columns we depend on across the code.  If any of these
// disappear (or get renamed), the report flags them so the deploy
// can be corrected before downstream queries break.
const EXPECTED_COLUMNS = {
  business_book: ['id', 'lead_no', 'client_name', 'po_amount', 'sale_amount_without_gst', 'created_at'],
  purchase_orders: ['id', 'po_number', 'po_date', 'total_amount', 'status', 'business_book_id'],
  po_items: ['id', 'po_id', 'amount'],
  sales_bills: ['id', 'bill_number', 'amount', 'gst_amount', 'total_amount'],
  purchase_bills: ['id', 'bill_number', 'amount', 'gst_amount', 'total_amount'],
  vendors: ['id', 'name', 'phone', 'email'],
  customers: ['id', 'company_name', 'contact_no', 'email'],
  item_master: ['id', 'item_name', 'specification', 'make', 'current_price'],
  sites: ['id', 'name', 'address', 'status'],
  dpr: ['id', 'site_id', 'report_date', 'grand_total_a', 'grand_total_b', 'profit_loss'],
  receivables: ['id', 'outstanding_amount', 'ageing_bucket', 'follow_up_status'],
  payment_requests: ['id', 'request_no', 'status', 'amount'],
  indents: ['id', 'indent_number', 'status'],
  cheques: ['id', 'cheque_number', 'cheque_date', 'amount', 'current_status'],
  employees: ['id', 'name', 'phone', 'status'],
  cash_flow_entries: ['id', 'date', 'type', 'amount'],
};
function findSchemaDrift(db) {
  const out = [];
  for (const [table, expectedCols] of Object.entries(EXPECTED_COLUMNS)) {
    let actualCols;
    try {
      actualCols = db.prepare(`PRAGMA table_info(${table})`).all().map(r => r.name);
    } catch (e) {
      out.push({ table, kind: 'table_missing', detail: e.message, severity: 'critical' });
      continue;
    }
    if (actualCols.length === 0) {
      out.push({ table, kind: 'table_missing', severity: 'critical' });
      continue;
    }
    const missing = expectedCols.filter(c => !actualCols.includes(c));
    if (missing.length) {
      out.push({ table, kind: 'columns_missing', missing, severity: 'critical' });
    }
  }
  return out;
}

// --- /audit (main) --------------------------------------------------
router.get('/', (req, res) => {
  const db = getDb();
  const started = Date.now();
  let dbInfo = { path: null, size_bytes: null, last_modified: null };
  try {
    // The DB path is configurable via DB_PATH; default is ../data/erp.db
    const dbPath = process.env.DB_PATH || path.join(__dirname, '..', '..', 'data', 'erp.db');
    if (fs.existsSync(dbPath)) {
      const st = fs.statSync(dbPath);
      dbInfo = { path: dbPath, size_bytes: st.size, last_modified: st.mtime.toISOString() };
    }
  } catch (_) {}

  const kpis = computeKpis(db);
  const exceptions = {
    duplicates:        { description: 'Records sharing key identifying fields',                 items: findDuplicates(db) },
    arithmetic_errors: { description: 'Computed total ≠ recorded total (>₹1 / >₹10 for POs)', items: findArithmeticErrors(db) },
    missing_required:  { description: 'Critical fields blank on otherwise-valid rows',          items: findMissingRequired(db) },
    stale_records:     { description: 'Open work-items past their expected SLA',                 items: findStaleRecords(db) },
    schema_drift:      { description: 'Columns expected by code but absent from the database',  items: findSchemaDrift(db) },
  };
  Object.values(exceptions).forEach(e => { e.count = e.items.length; });

  res.json({
    spec_version: 'v3',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    database: dbInfo,
    kpis,
    exceptions,
    summary: {
      kpi_count: kpis.length,
      total_exceptions: Object.values(exceptions).reduce((s, e) => s + e.count, 0),
      critical_exceptions: Object.values(exceptions).reduce(
        (s, e) => s + e.items.filter(i => i.severity === 'critical').length, 0),
    },
  });
});

// --- /audit/data-quality --------------------------------------------
// Per-table scorecard: row counts + null rates on the columns we
// actually care about (the EXPECTED_COLUMNS set).  Quality score is
// 100 minus the worst null-rate percentage on a required column.
router.get('/data-quality', (req, res) => {
  const db = getDb();
  const started = Date.now();
  const tables = [];

  for (const [table, cols] of Object.entries(EXPECTED_COLUMNS)) {
    const total = safeCount(db, `SELECT COUNT(*) c FROM ${table}`);
    const nulls = {};
    let worstNullPct = 0;
    for (const col of cols) {
      if (col === 'id') continue; // id always present (PK)
      let n = 0;
      try {
        n = safeCount(db, `SELECT COUNT(*) c FROM ${table} WHERE ${col} IS NULL OR ${col}=''`);
      } catch { continue; }
      const pct = total > 0 ? Math.round((n / total) * 10000) / 100 : 0;
      nulls[col] = { null_count: n, null_pct: pct };
      if (pct > worstNullPct) worstNullPct = pct;
    }
    const lastRow = safeGet(db, `SELECT MAX(rowid) m FROM ${table}`);
    tables.push({
      name: table,
      row_count: total,
      last_rowid: lastRow ? lastRow.m : null,
      nulls,
      quality_score: Math.max(0, Math.round((100 - worstNullPct) * 10) / 10),
    });
  }

  // Overall score = average of per-table scores, weighted by row count
  const totalRows = tables.reduce((s, t) => s + t.row_count, 0);
  const weightedScore = totalRows > 0
    ? Math.round((tables.reduce((s, t) => s + t.quality_score * t.row_count, 0) / totalRows) * 10) / 10
    : 100;

  res.json({
    spec_version: 'v3',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    overall_quality_score: weightedScore,
    tables,
  });
});

// --- /audit/analytics -----------------------------------------------
// 30-day rolling activity: how many of each entity were created, plus
// day-by-day counts so CMD can see whether the team is keeping pace.
router.get('/analytics', (req, res) => {
  const db = getDb();
  const started = Date.now();
  const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
  const from = daysAgo(days);
  const to = today();

  // Total counts in window
  const totals = {
    new_business_book:    safeCount(db, `SELECT COUNT(*) c FROM business_book   WHERE date(created_at) >= ?`, from),
    new_purchase_orders:  safeCount(db, `SELECT COUNT(*) c FROM purchase_orders WHERE date(created_at) >= ?`, from),
    new_sales_bills:      safeCount(db, `SELECT COUNT(*) c FROM sales_bills     WHERE date(created_at) >= ?`, from),
    new_purchase_bills:   safeCount(db, `SELECT COUNT(*) c FROM purchase_bills  WHERE date(created_at) >= ?`, from),
    new_dpr:              safeCount(db, `SELECT COUNT(*) c FROM dpr             WHERE report_date    >= ?`, from),
    new_indents:          safeCount(db, `SELECT COUNT(*) c FROM indents         WHERE date(created_at) >= ?`, from),
    new_payment_requests: safeCount(db, `SELECT COUNT(*) c FROM payment_requests WHERE date(created_at) >= ?`, from),
    new_cheques:          safeCount(db, `SELECT COUNT(*) c FROM cheques         WHERE date(raised_at)  >= ?`, from),
    new_complaints:       safeCount(db, `SELECT COUNT(*) c FROM complaints      WHERE date(created_at) >= ?`, from),
    new_snags:            safeCount(db, `SELECT COUNT(*) c FROM snags           WHERE date(raised_at)  >= ?`, from),
  };

  // Day-by-day for the busy tables
  const dailyDpr = safeAll(db, `
    SELECT report_date d, COUNT(*) c FROM dpr
    WHERE report_date >= ? GROUP BY d ORDER BY d
  `, from);
  const dailyBills = safeAll(db, `
    SELECT date(created_at) d, COUNT(*) c FROM sales_bills
    WHERE date(created_at) >= ? GROUP BY d ORDER BY d
  `, from);
  const dailyPayments = safeAll(db, `
    SELECT date(date) d, COALESCE(SUM(amount),0) total FROM cash_flow_entries
    WHERE type='inflow' AND date >= ? GROUP BY d ORDER BY d
  `, from);

  // Top vendors by spend, top customers by sale value
  const topVendors = safeAll(db, `
    SELECT v.id, v.name, COUNT(pb.id) bill_count, COALESCE(SUM(pb.total_amount),0) total_spend
    FROM vendors v LEFT JOIN purchase_bills pb ON pb.vendor_id = v.id
      AND date(pb.created_at) >= ?
    GROUP BY v.id, v.name HAVING bill_count > 0
    ORDER BY total_spend DESC LIMIT 10
  `, from);
  const topClients = safeAll(db, `
    SELECT client_name, COUNT(*) entries, COALESCE(SUM(sale_amount_without_gst),0) total_sale
    FROM business_book
    WHERE date(created_at) >= ? AND client_name IS NOT NULL
    GROUP BY client_name ORDER BY total_sale DESC LIMIT 10
  `, from);

  res.json({
    spec_version: 'v3',
    generated_at: new Date().toISOString(),
    duration_ms: Date.now() - started,
    period: { from, to, days },
    totals,
    by_day: {
      dpr: dailyDpr,
      sales_bills: dailyBills,
      cash_inflows: dailyPayments,
    },
    top_vendors: topVendors,
    top_clients: topClients,
  });
});

module.exports = router;
