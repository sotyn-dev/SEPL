const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Bypass the site-engineer scope filter when the user's role has
// can_approve OR can_see_all on the 'dpr' module — that's the
// explicit "See All" toggle in Roles & Permissions. Mam ticks
// See All on DPR for CRM / Accounts / Auditor and they get the
// full list like an admin.
function dprCanSeeAll(db, user) {
  if (user.role === 'admin') return true;
  const r = db.prepare(`
    SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
    FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
    WHERE ur.user_id = ? AND rp.module = 'dpr'
  `).get(user.id);
  return !!r?.ok;
}

// Build a normalized "site key" for grouping — strips ALL whitespace
// (incl. non-breaking space CHAR(160), tabs, CR/LF) and quotes, then
// uppercases. This way 'M/s X Pvt. Ltd', '"""M/s X Pvt. Ltd"""' and
// 'M/s X Pvt. Ltd' all collapse into the same group key. Without
// this, Excel paste artifacts produce phantom duplicate rows.
const siteKeySql = (col) =>
  `UPPER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${col}, CHAR(160), ''), CHAR(9), ''), CHAR(10), ''), CHAR(13), ''), ' ', ''), '"', ''), CHAR(39), ''))`;

// ===== SITES =====
// Non-admins see only sites where they are assigned as a site engineer —
// either directly on the site row, or via a PO linked to that site whose
// site_engineer_ids CSV contains their user id.
router.get('/sites', (req, res) => {
  const db = getDb();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  // ?all=1 → skip the user-scoping filter. Used by modules like Payment
  // Required where every employee should see every site (not just the ones
  // assigned to them as a site engineer).
  const all = req.query.all === '1' || req.query.all === 'true';
  const canSeeAll = dprCanSeeAll(db, req.user);

  // Group by the normalized site key (see siteKeySql above) so all the
  // quote/whitespace variants of the same logical site collapse into
  // one row. Display name is built by stripping quotes and collapsing
  // double-spaces — readable, keeps the original casing.
  // Status: if ANY underlying duplicate is 'active' the row shows active.
  let sql = `SELECT MIN(s.id) as id,
    TRIM(REPLACE(REPLACE(REPLACE(REPLACE(s.name, '"', ''), CHAR(39), ''), '  ', ' '), '  ', ' ')) as name,
    MAX(s.address) as address,
    MAX(s.client_name) as client_name,
    MAX(s.po_id) as po_id,
    MAX(s.business_book_id) as business_book_id,
    MAX(s.site_engineer_id) as site_engineer_id,
    MAX(s.supervisor) as supervisor,
    CASE WHEN SUM(CASE WHEN s.status='active' THEN 1 ELSE 0 END) > 0 THEN 'active' ELSE MIN(s.status) END as status,
    MAX(u.name) as engineer_name,
    MAX(bb.lead_no) as lead_no,
    COUNT(*) as entry_count
    FROM sites s
    LEFT JOIN users u ON s.site_engineer_id=u.id
    LEFT JOIN business_book bb ON s.business_book_id=bb.id`;
  const params = [];

  if (!canSeeAll && !all) {
    sql += ` WHERE (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    params.push(uid, `%,${uid},%`, uid);
  }

  sql += ` GROUP BY ${siteKeySql('s.name')} ORDER BY name`;
  res.json(db.prepare(sql).all(...params));
});

router.post('/sites', (req, res) => {
  const db = getDb();
  const { name, address, client_name, po_id, site_engineer_id, supervisor } = req.body;
  // Auto-resolve business_book_id so the new site is wired to BOQ items
  // out of the box. Tries: (1) po_id → purchase_orders.business_book_id,
  // (2) business_book.project_name matching site name. Without this the
  // site sits orphan and DPR can't surface any BOQ items.
  let bbId = null;
  if (po_id) {
    const poRow = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(po_id);
    if (poRow?.business_book_id) bbId = poRow.business_book_id;
  }
  if (!bbId && name) {
    const byProject = db.prepare(`SELECT id FROM business_book
      WHERE TRIM(LOWER(project_name)) = TRIM(LOWER(?))
         OR TRIM(LOWER(client_name)) = TRIM(LOWER(?))
         OR TRIM(LOWER(company_name)) = TRIM(LOWER(?))
      LIMIT 1`).get(name, name, name);
    if (byProject?.id) bbId = byProject.id;
  }
  const r = db.prepare('INSERT INTO sites (name, address, client_name, po_id, business_book_id, site_engineer_id, supervisor) VALUES (?,?,?,?,?,?,?)')
    .run(name, address, client_name, po_id, bbId, site_engineer_id, supervisor);
  res.status(201).json({ id: r.lastInsertRowid, business_book_id: bbId });
});

router.put('/sites/:id', (req, res) => {
  const { name, address, client_name, site_engineer_id, supervisor, supervisor_id, status } = req.body;
  const db = getDb();
  db.prepare(
    `UPDATE sites SET
       name=?, address=?, client_name=?,
       site_engineer_id=?, supervisor=?, supervisor_id=?, status=?
     WHERE id=?`
  ).run(name, address, client_name, site_engineer_id, supervisor, supervisor_id || null, status, req.params.id);

  // The Sites tab dedupes rows by the normalized site key (Excel-paste
  // quote / whitespace noise creates phantom duplicates). When mam clicks
  // Deactivate / Reactivate on the deduped row, also flip every other
  // sibling row that maps to the same logical site — otherwise the row
  // would still show as 'active' on next refresh because at least one
  // sibling is still active.
  if (status) {
    try {
      const cur = db.prepare('SELECT name FROM sites WHERE id=?').get(req.params.id);
      if (cur?.name) {
        db.prepare(
          `UPDATE sites SET status=?
            WHERE id != ?
              AND ${siteKeySql('name')} = ${siteKeySql('?')}`
        ).run(status, req.params.id, cur.name);
      }
    } catch (e) { /* non-fatal: primary update already succeeded */ }
  }

  res.json({ message: 'Updated' });
});

// TA/DA cost for a site — sums every payment_requests row of category
// 'TA/DA' for this site that's already been final-approved. Mam: 'according
// to site TA/DA that site show here automatically which we fill in payment
// category TA/DA only'. Optional ?date= filters to that single day's
// required_by_date so DPRs don't double-count travel claims across days.
router.get('/sites/:site_id/ta-da-cost', (req, res) => {
  try {
    const db = getDb();
    const site = db.prepare('SELECT id, name FROM sites WHERE id=?').get(req.params.site_id);
    if (!site) return res.json({ total_amount: 0, count: 0 });

    // Match by site_id (preferred) OR site_name fallback (legacy rows that
    // pre-date the FK). Approved-only so pending claims don't inflate cost.
    const params = [req.params.site_id, site.name];
    let dateClause = '';
    if (req.query.date) {
      dateClause = ' AND (required_by_date = ? OR DATE(created_at) = ?)';
      params.push(req.query.date, req.query.date);
    }
    const row = db.prepare(`
      SELECT COALESCE(SUM(amount),0) as total_amount, COUNT(*) as count
      FROM payment_requests
      WHERE category = 'TA/DA'
        AND status = 'final_approved'
        AND (site_id = ? OR site_name = ?)
        ${dateClause}
    `).get(...params);

    res.json({
      total_amount: row.total_amount || 0,
      count: row.count || 0,
      site_name: site.name,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, total_amount: 0, count: 0 });
  }
});

// Per-day staff cost for a site = sum of monthly salary / 30 of all site
// engineers assigned to the PO for this site. IMPORTANT: returns only the
// aggregated number + counts — never individual salaries — because salaries
// are confidential.
//
// Matching is forgiving: for each site-engineer user we try employees.user_id
// first, then fall back to matching employees.email to users.email (case
// insensitive), then employees.name to users.name (exact, case insensitive).
// That way DPR works even if the Employees ↔ Users link wasn't set manually.
router.get('/sites/:site_id/staff-cost', (req, res) => {
  const db = getDb();
  const site = db.prepare('SELECT id, name, po_id, business_book_id FROM sites WHERE id=?').get(req.params.site_id);
  if (!site) return res.json({ per_day_cost: 0, engineer_count: 0, po_engineers: 0 });

  const pos = db.prepare(
    `SELECT DISTINCT site_engineer_id, site_engineer_ids FROM purchase_orders
     WHERE id = ? OR business_book_id = ?`
  ).all(site.po_id, site.business_book_id);

  const ids = new Set();
  for (const po of pos) {
    if (po.site_engineer_id) ids.add(po.site_engineer_id);
    if (po.site_engineer_ids) {
      String(po.site_engineer_ids).split(',').map(s => parseInt(s, 10)).filter(Boolean).forEach(i => ids.add(i));
    }
  }
  // Also include the DPR submitter — the person filing the report is present
  // on site that day even if they aren't listed as a site engineer on the PO.
  // This ensures Raushan / Samsad / etc. are counted when they submit.
  if (req.user?.id) ids.add(req.user.id);

  if (ids.size === 0) return res.json({ per_day_cost: 0, engineer_count: 0, po_engineers: 0 });

  const idList = [...ids];
  const placeholders = idList.map(() => '?').join(',');
  const engUsers = db.prepare(`SELECT id, name, email FROM users WHERE id IN (${placeholders})`).all(...idList);
  const allEmployees = db.prepare(
    `SELECT id, user_id, name, email, salary FROM employees
     WHERE (status IS NULL OR status = 'active')`
  ).all();

  // Forgiving matcher — tries, in order, for each site engineer user:
  //   1) employees.user_id === user.id
  //   2) employees.email (case insens) === user.email
  //   3) employees.name exact (case insens, trimmed) === user.name
  //   4) employees.name first-word === user.name first-word
  //      so "Vivek" (user) matches "Vivek Kumar" (employee).
  // Step 4 picks the employee whose full name shares the MOST tokens with the
  // user's name, to avoid "Ram" incorrectly matching "Ram Kumar" when there is
  // also a "Ram Singh" in the list.
  const tokens = (s) => String(s || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  const firstWord = (s) => tokens(s)[0] || '';

  const findEmp = (user) => {
    // 1. Explicit link
    let hit = allEmployees.find(e => e.user_id === user.id);
    if (hit) return hit;
    // 2. Email
    if (user.email) {
      const ue = user.email.toLowerCase();
      hit = allEmployees.find(e => (e.email || '').toLowerCase() === ue);
      if (hit) return hit;
    }
    // 3. Exact name
    const un = (user.name || '').toLowerCase().trim();
    if (un) {
      hit = allEmployees.find(e => (e.name || '').toLowerCase().trim() === un);
      if (hit) return hit;
    }
    // 4. First-word match, pick best overlap
    const uf = firstWord(user.name);
    if (!uf) return null;
    const userSet = new Set(tokens(user.name));
    const candidates = allEmployees
      .filter(e => firstWord(e.name) === uf)
      .map(e => {
        const empTokens = tokens(e.name);
        const overlap = empTokens.filter(t => userSet.has(t)).length;
        return { emp: e, overlap };
      })
      .sort((a, b) => b.overlap - a.overlap);
    return candidates[0]?.emp || null;
  };

  let totalMonthly = 0;
  let matched = 0;
  let submitterMatched = false;
  let submitterHasSalary = false;
  const seenEmpIds = new Set();
  for (const u of engUsers) {
    const emp = findEmp(u);
    if (emp) {
      if (u.id === req.user?.id) {
        submitterMatched = true;
        if ((emp.salary || 0) > 0) submitterHasSalary = true;
      }
      if (!seenEmpIds.has(emp.id) && (emp.salary || 0) > 0) {
        seenEmpIds.add(emp.id);
        totalMonthly += emp.salary;
        matched++;
      }
    }
  }

  const perDay = Math.round((totalMonthly / 30) * 100) / 100;
  // Diagnostic so the UI can tell the user exactly why staff cost is 0
  let diagnostic = null;
  if (matched === 0) {
    if (!submitterMatched) {
      diagnostic = { reason: 'no_employee_for_submitter', message: 'You have no employee record in HR → Employees. Add one (with a monthly salary) so Staff Cost can auto-calculate. Until then, enter the rate manually.' };
    } else if (!submitterHasSalary) {
      diagnostic = { reason: 'submitter_salary_zero', message: 'Your employee record has salary = 0 in HR. Ask HR to set your monthly salary. Until then, enter the rate manually.' };
    } else {
      diagnostic = { reason: 'no_matching_engineers', message: 'No site engineers with salary records on this PO. Enter rate manually or ask HR to link users → employees.' };
    }
  }
  res.json({ per_day_cost: perDay, engineer_count: matched, po_engineers: engUsers.length, diagnostic });
});

// Get PO items for a site - fetches ALL PO items for that company/site name.
// Mam: "in dpr all not see boq item which i upload in order to planning".
// The site row might not have business_book_id (especially when it was
// created via DPR's /sites endpoint), so we walk EVERY known path to
// discover business_book_ids that own BOQ items for this site:
//   1. The site's own business_book_id
//   2. Other sites with the same name (covers same-project, multi-phase)
//   3. The site's po_id → purchase_orders.business_book_id
//   4. Any purchase_orders / business_book whose project_name OR
//      po_number / lead_no matches the site name
// then UNION the resulting set so every BOQ item the user uploaded in
// Orders/Planning surfaces in DPR, regardless of which way the BB was
// linked. Diagnostic message names whichever paths found nothing.
router.get('/sites/:site_id/po-items', (req, res) => {
  const db = getDb();
  const site = db.prepare('SELECT id, name, po_id, business_book_id FROM sites WHERE id=?').get(req.params.site_id);
  if (!site) return res.status(404).json({ items: [], diagnostic: { reason: 'no_site', message: 'Site row not found.' } });

  // Path 1+2: site's own bb_id + same-name sites with bb_id.
  const sameNameBB = db.prepare(`SELECT DISTINCT s.business_book_id FROM sites s
                                  WHERE s.name = ? AND s.business_book_id IS NOT NULL`).all(site.name);

  // Path 3: site.po_id → purchase_orders.business_book_id.
  let poBbId = null;
  if (site.po_id) {
    const poRow = db.prepare('SELECT business_book_id FROM purchase_orders WHERE id=?').get(site.po_id);
    if (poRow?.business_book_id) poBbId = poRow.business_book_id;
  }

  // Path 4a: any purchase_orders whose business_book has project_name matching site name.
  const bbByProject = db.prepare(`SELECT id FROM business_book WHERE TRIM(LOWER(project_name)) = TRIM(LOWER(?))`).all(site.name);

  // Path 4b: order_planning rows whose business_book.project_name matches — covers cases where the BB has a different project_name but planning was done.
  const opBBs = db.prepare(`
    SELECT DISTINCT op.business_book_id AS bb_id
      FROM order_planning op
      JOIN business_book bb ON bb.id = op.business_book_id
     WHERE TRIM(LOWER(bb.project_name)) = TRIM(LOWER(?))
        OR TRIM(LOWER(bb.client_name)) = TRIM(LOWER(?))
        OR TRIM(LOWER(bb.company_name)) = TRIM(LOWER(?))
  `).all(site.name, site.name, site.name);

  const bbIds = Array.from(new Set([
    ...(site.business_book_id ? [site.business_book_id] : []),
    ...sameNameBB.map(r => r.business_book_id),
    ...(poBbId ? [poBbId] : []),
    ...bbByProject.map(r => r.id),
    ...opBBs.map(r => r.bb_id),
  ].filter(Boolean)));

  if (!bbIds.length) {
    return res.json({
      items: [],
      diagnostic: {
        reason: 'no_business_book',
        message: `This DPR site (name="${site.name}") couldn't be linked to a Business Book record by name, by site.business_book_id, by its PO, or by project_name match. Open Business Book, find the lead for this project, and either rename the project to match the DPR site name OR rename the DPR site to match the project.`,
      },
    });
  }

  // 2. SELECT every column on po_items + the item_master extras. Explicit
  //    column list so the response shape is stable for the UI.
  const ph = bbIds.map(() => '?').join(',');
  const items = db.prepare(`
    SELECT pi.id, pi.business_book_id, pi.item_master_id, pi.description,
           pi.quantity, pi.unit, pi.rate, pi.amount, pi.hsn_code,
           pi.labour_rate, pi.labour_amount, pi.sr_no, pi.created_at,
           im.item_code, im.item_name AS master_name,
           im.specification AS master_specification, im.size AS master_size,
           im.type AS master_type, im.make AS master_make,
           im.gst AS master_gst, im.uom AS master_uom,
           bb.lead_no, bb.po_number AS bb_po_number, bb.project_name
      FROM po_items pi
      LEFT JOIN item_master im ON im.id = pi.item_master_id
      LEFT JOIN business_book bb ON bb.id = pi.business_book_id
     WHERE pi.business_book_id IN (${ph})
     ORDER BY pi.business_book_id, pi.sr_no, pi.id
  `).all(...bbIds);

  if (!items.length) {
    return res.json({
      items: [],
      diagnostic: {
        reason: 'no_po_items',
        message: 'Business Book is linked but no BOQ items found. Open Orders → upload the PO\'s BOQ Excel, then go to Order Planning → upload the Labour Rate Sheet. Items will then appear here.',
      },
    });
  }

  // 3. Add filled_qty + remaining_qty so the UI can show "BOQ:10 Remaining:7".
  const siteIds = db.prepare('SELECT id FROM sites WHERE name=?').all(site.name).map(r => r.id);
  const sidPh = siteIds.length ? siteIds.map(() => '?').join(',') : '?';
  const sidArgs = siteIds.length ? siteIds : [req.params.site_id];
  const filledStmt = db.prepare(`
    SELECT COALESCE(SUM(wi.actual_qty), 0) as total
      FROM dpr_work_items wi
      JOIN dpr d ON wi.dpr_id = d.id
     WHERE d.site_id IN (${sidPh})
       AND (wi.po_item_id = ? OR (wi.description IS NOT NULL AND wi.description = ?))
  `);
  const result = items.map(it => {
    const filledRow = filledStmt.get(...sidArgs, it.id, it.description);
    const filledQty = filledRow?.total || 0;
    const remaining = Math.max(0, (it.quantity || 0) - filledQty);
    return { ...it, filled_qty: filledQty, remaining_qty: remaining };
  });

  // Soft warning when items loaded but some have no SITC rate set.
  const missingSitc = result.filter(it => !(+it.rate || 0)).length;
  const diagnostic = missingSitc ? {
    reason: 'rates_missing',
    message: `${missingSitc} item${missingSitc === 1 ? '' : 's'} have no rate set — open the PO in Orders to fix.`,
    missing_sitc_count: missingSitc,
    total_count: result.length,
  } : null;

  res.json({ items: result, diagnostic, total_count: result.length, business_book_ids: bbIds });
});

// ===== DPR =====
router.get('/', (req, res) => {
  const { site_id, date, status } = req.query;
  const db = getDb();
  const uid = req.user.id;
  const canSeeAll = dprCanSeeAll(db, req.user);
  let sql = `SELECT d.*, s.name as site_name, u.name as submitted_by_name, au.name as approved_by_name
    FROM dpr d LEFT JOIN sites s ON d.site_id=s.id LEFT JOIN users u ON d.submitted_by=u.id LEFT JOIN users au ON d.approved_by=au.id WHERE 1=1`;
  const params = [];
  if (site_id) { sql += ' AND d.site_id=?'; params.push(site_id); }
  if (date) { sql += ' AND d.report_date=?'; params.push(date); }
  if (status) { sql += ' AND d.approval_status=?'; params.push(status); }
  if (!canSeeAll) {
    sql += ` AND (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    params.push(uid, `%,${uid},%`, uid);
  }
  sql += ' ORDER BY d.report_date DESC, s.name';
  res.json(db.prepare(sql).all(...params));
});

// Dashboard summary
router.get('/summary', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  // Use the normalized site key so phantom-duplicate rows (Excel paste
  // junk) don't inflate the active-site count or the missing-DPR list.
  const activeSites = db.prepare(
    `SELECT COUNT(DISTINCT ${siteKeySql('name')}) as c FROM sites WHERE status='active'`
  ).get();
  const todayDprs = db.prepare('SELECT COUNT(*) as c FROM dpr WHERE report_date=?').get(today);
  const pendingApproval = db.prepare("SELECT COUNT(*) as c FROM dpr WHERE approval_status='pending'").get();
  const billingReady = db.prepare('SELECT COUNT(*) as c FROM dpr WHERE billing_ready=1').get();
  const uid = req.user.id;
  const canSeeAll = dprCanSeeAll(db, req.user);
  // Display name: strip quotes + collapse double spaces, keep original
  // case. Filter sites that are 'active' AND have NO sibling row (sharing
  // the normalized key) which already has a DPR today — otherwise the
  // same logical site shows up multiple times in the 'NO DPR' panel.
  let missingSql = `SELECT MIN(s.id) as id,
    TRIM(REPLACE(REPLACE(REPLACE(REPLACE(s.name, '"', ''), CHAR(39), ''), '  ', ' '), '  ', ' ')) as name,
    MAX(s.supervisor) as supervisor
    FROM sites s WHERE s.status='active'
    AND NOT EXISTS (
      SELECT 1 FROM sites s2
       JOIN dpr d ON d.site_id = s2.id
      WHERE d.report_date = ?
        AND ${siteKeySql('s2.name')} = ${siteKeySql('s.name')}
    )`;
  const missingParams = [today];
  if (!canSeeAll) {
    missingSql += ` AND (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    missingParams.push(uid, `%,${uid},%`, uid);
  }
  missingSql += ` GROUP BY ${siteKeySql('s.name')} ORDER BY name`;
  const missingSites = db.prepare(missingSql).all(...missingParams);
  const variance = db.prepare(`SELECT d.report_date, s.name as site_name,
    COALESCE(AVG(w.variance_pct),0) as avg_variance
    FROM dpr d JOIN sites s ON d.site_id=s.id LEFT JOIN dpr_work_items w ON w.dpr_id=d.id
    WHERE d.report_date >= date('now','-7 days') GROUP BY d.id ORDER BY d.report_date DESC LIMIT 20`).all();
  res.json({ activeSites: activeSites.c, todaySubmissions: todayDprs.c, pendingApproval: pendingApproval.c, billingReady: billingReady.c, missingSites, recentVariance: variance });
});

// ─── Weekly DPR Planning ───────────────────────────────────────
// Mam (2026-05-16): "i want site eng fill full week planning one
// day fill 7 days plaaning and actual per day according to that".
//
// Workflow:
//   1. Site eng picks a site + week-start date + clicks "Plan Week"
//   2. Fills 7 rows (one per day): planned work description, planned
//      manpower count, planned cost.
//   3. POST /api/dpr/plan-week creates 7 dpr rows with is_planned_template=1
//      and only the planned_* fields populated.
//   4. Each day, site eng opens the existing row for that date and
//      fills the actual (grand_total_a, manpower, etc.) — the daily
//      submit endpoint UPDATEs the row instead of inserting a new one.
//
// Idempotent ALTER TABLE (safe to re-run; SQLite throws if column
// exists, swallowed by try/catch).
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN planned_description TEXT`); } catch (_) {}
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN planned_manpower INTEGER DEFAULT 0`); } catch (_) {}
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN is_planned_template INTEGER DEFAULT 0`); } catch (_) {}
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN week_plan_locked_at DATETIME`); } catch (_) {}
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN week_plan_locked_by INTEGER REFERENCES users(id)`); } catch (_) {}
// BOQ-item driven planning (mam, 2026-05-16: "planning giving as per
// boq items").  Each planning day can be tied to a specific PO line
// item + planned quantity; planned_description is auto-formatted
// from the item details when both are set.
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN planned_po_item_id INTEGER REFERENCES po_items(id)`); } catch (_) {}
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN planned_qty REAL DEFAULT 0`); } catch (_) {}
// Separate planned cost column so the daily-submit upsert can preserve
// the plan figure while overwriting grand_total_b with actuals (mam,
// 2026-05-28: "DPR list — plan cost vs actual cost side-by-side").
// One-time backfill: rows still in planned-only state had their plan
// stored in grand_total_b under the old scheme; move it across once.
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN planned_cost_b REAL DEFAULT 0`); } catch (_) {}
try {
  getDb().prepare(
    `UPDATE dpr SET planned_cost_b = grand_total_b, grand_total_b = 0
     WHERE is_planned_template = 1 AND (planned_cost_b IS NULL OR planned_cost_b = 0) AND grand_total_b > 0`
  ).run();
} catch (_) {}

// Returns Mon-Sun (or any 7 consecutive days starting at week_start)
// for one site, blending planned + actual fields.  Multi-item per
// day comes back as `items: [{ id, po_item_id, description, unit,
// planned_qty, actual_qty }]` so the UI can render the full plan.
// Mam, 2026-05-16: "in one day multiple boq item have".
router.get('/week-view', requirePermission('dpr', 'view'), (req, res) => {
  const { site_id, week_start } = req.query;
  if (!site_id || !week_start) return res.status(400).json({ error: 'site_id and week_start required' });
  const db = getDb();
  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(week_start);
    d.setDate(d.getDate() + i);
    days.push(d.toISOString().slice(0, 10));
  }
  const placeholders = days.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT d.*, u.name as planned_by_name, ap.name as approved_by_name, sb.name as submitted_by_name
    FROM dpr d
    LEFT JOIN users u  ON d.week_plan_locked_by = u.id
    LEFT JOIN users ap ON d.approved_by = ap.id
    LEFT JOIN users sb ON d.submitted_by = sb.id
    WHERE d.site_id = ? AND d.report_date IN (${placeholders})
  `).all(site_id, ...days);
  // Pull per-day work items.  dpr_work_items.description /
  // po_item_id / planned_qty / actual_qty cover both phases of the
  // plan-actual lifecycle.
  const itemsByDpr = {};
  if (rows.length) {
    const dprIds = rows.map(r => r.id);
    const placeholders2 = dprIds.map(() => '?').join(',');
    const items = db.prepare(`
      SELECT wi.*, pi.description as po_item_description, pi.unit as po_item_unit,
             pi.quantity as po_item_boq_qty
      FROM dpr_work_items wi
      LEFT JOIN po_items pi ON wi.po_item_id = pi.id
      WHERE wi.dpr_id IN (${placeholders2})
    `).all(...dprIds);
    items.forEach(it => {
      (itemsByDpr[it.dpr_id] = itemsByDpr[it.dpr_id] || []).push(it);
    });
  }
  const byDate = Object.fromEntries(rows.map(r => [r.report_date, { ...r, items: itemsByDpr[r.id] || [] }]));
  res.json({
    site_id: +site_id,
    week_start,
    days: days.map(date => byDate[date] || { report_date: date, is_planned_template: 0, site_id: +site_id, items: [] }),
  });
});

// Upsert the 7-day plan for a site/week.  For each day, if a dpr
// row exists for (site_id, date), UPDATE its planned_* fields.
// Otherwise INSERT a stub row with is_planned_template=1.  The
// daily actuals get filled in later via PUT /api/dpr/:id.
router.post('/plan-week', requirePermission('dpr', 'create'), (req, res) => {
  const { site_id, week_start, days } = req.body || {};
  if (!site_id || !week_start || !Array.isArray(days) || days.length === 0) {
    return res.status(400).json({ error: 'site_id, week_start, and days[] are required' });
  }
  const db = getDb();
  const out = { created: 0, updated: 0, dates: [] };

  const findRow  = db.prepare(`SELECT id FROM dpr WHERE site_id = ? AND report_date = ?`);
  // Day-level planned fields. Single planned_po_item_id is kept for
  // legacy callers but the multi-item flow lives in dpr_work_items.
  const updateRow = db.prepare(`
    UPDATE dpr SET planned_description = ?, planned_manpower = ?, planned_cost_b = ?,
                   week_plan_locked_at = CURRENT_TIMESTAMP, week_plan_locked_by = ?
    WHERE id = ?
  `);
  const insertRow = db.prepare(`
    INSERT INTO dpr (
      site_id, report_date, submitted_by, planned_description, planned_manpower,
      planned_cost_b, is_planned_template, week_plan_locked_at, week_plan_locked_by
    ) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?)
  `);
  // BOQ item metadata used to auto-format the planned summary text.
  const findPoItem = db.prepare(`SELECT description, unit, quantity, rate FROM po_items WHERE id = ?`);
  // Day-level work items.  We REPLACE all items for the (dpr_id) on
  // each save so re-saving the planning modal doesn't accumulate
  // ghosts.  Existing actuals (actual_qty) on rows already filled
  // would be wiped — to avoid that, the daily-submit endpoint
  // updates actual_qty in place rather than going through plan-week.
  const deleteItems = db.prepare(`DELETE FROM dpr_work_items WHERE dpr_id = ?`);
  const insertItem  = db.prepare(`
    INSERT INTO dpr_work_items (dpr_id, po_item_id, description, unit, boq_qty, rate, planned_qty)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const txn = db.transaction(() => {
    for (const d of days) {
      const date = d.date || d.report_date;
      if (!date) continue;
      const mp   = +d.planned_manpower || 0;
      const cost = +d.planned_grand_total_b || +d.planned_cost || 0;
      // Items array (multi-BOQ-per-day).  Falls back to single-item
      // shape from older callers ({ planned_po_item_id, planned_qty })
      // so the JS clients that haven't updated still work.
      const rawItems = Array.isArray(d.items) ? d.items
                     : (d.planned_po_item_id ? [{ po_item_id: d.planned_po_item_id, planned_qty: d.planned_qty }] : []);
      const cleanedItems = rawItems
        .filter(it => it && it.po_item_id)
        .map(it => ({ po_item_id: +it.po_item_id, planned_qty: +it.planned_qty || 0 }));

      // Build a human-readable summary string from picked items so
      // legacy parts of the UI that read planned_description still
      // show something sensible.
      let desc = (d.planned_description || '').trim() || null;
      if (!desc && cleanedItems.length) {
        desc = cleanedItems.map(it => {
          const pi = findPoItem.get(it.po_item_id);
          if (!pi) return null;
          return `${pi.description}${it.planned_qty > 0 ? ` · ${it.planned_qty} ${pi.unit || ''}`.trim() : ''}`;
        }).filter(Boolean).join(' | ') || null;
      }

      // Upsert the daily row, then re-write its work items.
      const existing = findRow.get(site_id, date);
      let dprId;
      if (existing) {
        updateRow.run(desc, mp, cost, req.user.id, existing.id);
        dprId = existing.id;
        out.updated++;
      } else {
        const r = insertRow.run(site_id, date, req.user.id, desc, mp, cost, req.user.id);
        dprId = r.lastInsertRowid;
        out.created++;
      }

      // Replace the items list for this day.  Carry rate from BOQ so
      // the dpr_work_items row has enough context for later reporting.
      deleteItems.run(dprId);
      for (const it of cleanedItems) {
        const pi = findPoItem.get(it.po_item_id);
        if (!pi) continue;
        insertItem.run(
          dprId, it.po_item_id, pi.description, pi.unit || 'nos',
          +pi.quantity || 0, +pi.rate || 0, it.planned_qty,
        );
      }

      out.dates.push(date);
    }
  });
  try {
    txn();
    res.json(out);
  } catch (e) {
    console.error('[dpr/plan-week]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Submit MEPF DPR
router.post('/', (req, res) => {
  const { site_id, report_date, weather, overall_status, shift, contractor_name, contractor_manpower, mb_sheet_no,
    floor_zone, system_type, safety_toolbox_talk, safety_ppe_compliance, safety_incidents,
    next_day_plan, hindrances, hindrance_category, remarks, grand_total_a, grand_total_b, profit_loss,
    work_items, manpower, machinery, materials, contractors } = req.body;

  if (!site_id || !report_date) return res.status(400).json({ error: 'Site and date required' });

  // Mam: 'in dpr if loss then hindrance/issue which is reason mandatory,
  // category one select Money / Machine / Material / Manpower / Site
  // Clearance, after then write reason'. Enforce both at submit-time
  // when the DPR shows a loss (profit_loss < 0). No-op when profit/break-even.
  const VALID_CATEGORIES = ['Money', 'Machine', 'Material', 'Manpower', 'Site Clearance'];
  if ((+profit_loss || 0) < 0) {
    if (!hindrance_category || !VALID_CATEGORIES.includes(hindrance_category)) {
      return res.status(400).json({ error: 'Loss recorded — please pick a hindrance category (Money / Machine / Material / Manpower / Site Clearance)' });
    }
    if (!hindrances || !String(hindrances).trim()) {
      return res.status(400).json({ error: 'Loss recorded — please write the hindrance reason' });
    }
  }

  const db = getDb();

  try {
  // If a weekly-plan stub already exists for (site_id, report_date),
  // UPDATE it with the actual data instead of inserting a duplicate
  // (mam, 2026-05-16: "actual per day according to that").  Otherwise
  // INSERT a fresh row.  Either way, dprId is the row we just wrote.
  let dprId;
  const existing = db.prepare(`SELECT id, is_planned_template FROM dpr WHERE site_id = ? AND report_date = ?`).get(site_id, report_date);
  if (existing) {
    db.prepare(`UPDATE dpr SET
        submitted_by = ?, submission_time = CURRENT_TIMESTAMP, weather = ?, overall_status = ?,
        shift = ?, contractor_name = ?, contractor_manpower = ?, mb_sheet_no = ?,
        grand_total_a = ?, grand_total_b = ?, profit_loss = ?,
        floor_zone = ?, system_type = ?, safety_toolbox_talk = ?, safety_ppe_compliance = ?,
        safety_incidents = ?, next_day_plan = ?, hindrances = ?, hindrance_category = ?, remarks = ?,
        is_planned_template = 0
      WHERE id = ?`)
      .run(req.user.id, weather || 'clear', overall_status || 'on_track',
        shift || 'day', contractor_name, contractor_manpower || 0, mb_sheet_no,
        grand_total_a || 0, grand_total_b || 0, profit_loss || 0,
        floor_zone, system_type, safety_toolbox_talk ? 1 : 0, safety_ppe_compliance ? 1 : 0,
        safety_incidents, next_day_plan, hindrances, hindrance_category || null, remarks,
        existing.id);
    dprId = existing.id;
  } else {
    const r = db.prepare(`INSERT INTO dpr (site_id, report_date, submitted_by, submission_time, weather, overall_status,
      shift, contractor_name, contractor_manpower, mb_sheet_no, grand_total_a, grand_total_b, profit_loss,
      floor_zone, system_type, safety_toolbox_talk, safety_ppe_compliance, safety_incidents,
      next_day_plan, hindrances, hindrance_category, remarks) VALUES (?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(site_id, report_date, req.user.id, weather || 'clear', overall_status || 'on_track',
        shift || 'day', contractor_name, contractor_manpower || 0, mb_sheet_no,
        grand_total_a || 0, grand_total_b || 0, profit_loss || 0,
        floor_zone, system_type, safety_toolbox_talk ? 1 : 0, safety_ppe_compliance ? 1 : 0,
        safety_incidents, next_day_plan, hindrances, hindrance_category || null, remarks);
    dprId = r.lastInsertRowid;
  }

  // Multi-contractor rows (mam's "at least 5 contractor" ask). Skip empty
  // rows so the table only carries real entries. Legacy single contractor
  // field stays for backwards compat.
  const insertContractor = db.prepare('INSERT INTO dpr_contractors (dpr_id, name, manpower) VALUES (?,?,?)');
  for (const c of (contractors || [])) {
    const name = (c?.name || '').trim();
    const mp = +c?.manpower || 0;
    if (!name && !mp) continue;
    insertContractor.run(dprId, name || null, mp);
  }

  // Table A: Installation work items from PO.
  const insertWork = db.prepare('INSERT INTO dpr_work_items (dpr_id, po_item_id, description, unit, floor_zone, boq_qty, rate, amount, planned_qty, actual_qty, cumulative_qty, variance_pct, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const w of (work_items || [])) {
    if (!w.description && !w.po_item_id) continue;
    const qty = w.qty || 0;
    const rate = w.rate || 0;
    const amount = qty * rate;
    // Verify po_item_id exists, set null if not.
    const validPoItemId = w.po_item_id ? (db.prepare('SELECT id FROM po_items WHERE id=?').get(w.po_item_id) ? w.po_item_id : null) : null;
    insertWork.run(dprId, validPoItemId, w.description, w.unit, w.location || w.floor_zone,
      w.boq_qty || 0, rate, amount, qty, qty, w.cumulative_qty || 0, 0, w.remarks);
  }

  // Table B: Costs (stored in manpower table - trade=type, required=qty, deployed=rate, shortage=amount)
  const insertCost = db.prepare('INSERT INTO dpr_manpower (dpr_id, trade, required, deployed, shortage) VALUES (?,?,?,?,?)');
  for (const c of (manpower || [])) {
    const costType = c.type || c.trade || '';
    const qty = c.qty || c.required || 0;
    const rate = c.rate || c.deployed || 0;
    const amount = c.amount || c.shortage || (qty * rate);
    if (costType) insertCost.run(dprId, costType, qty, rate, amount);
  }

  // Machinery/Tools
  const insertMach = db.prepare('INSERT INTO dpr_machinery (dpr_id, equipment, quantity, hours_used, condition, remarks) VALUES (?,?,?,?,?,?)');
  for (const mc of (machinery || [])) {
    if (mc.equipment) insertMach.run(dprId, mc.equipment, mc.quantity || 1, mc.hours_used || 0, mc.condition || 'working', mc.remarks);
  }

  // Materials consumed today — write to dpr_material AND auto-OUT from
  // the site's site_store warehouse so inventory stays in sync. Each
  // material can be supplied by item_master_id (preferred — links to
  // catalog) OR plain material_name (free-text). consumed_today drives
  // the stock decrement.
  const insertMat = db.prepare(
    `INSERT INTO dpr_material (dpr_id, po_item_id, item_master_id, material_name, unit, boq_qty,
       consumed_today, cumulative_consumed, balance_qty, remarks)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  );
  let stockOuts = 0;
  // Resolve the site's site_store warehouse once (auto-OUT FROM here)
  const siteStore = db.prepare(
    `SELECT id FROM warehouses WHERE site_id = ? AND type = 'site_store' AND active = 1 LIMIT 1`
  ).get(site_id);
  for (const m of (materials || [])) {
    const consumed = +m.consumed_today || 0;
    const matName = m.material_name || '';
    if (!matName && !m.item_master_id && !m.po_item_id) continue;
    const validPoItemId = m.po_item_id ? (db.prepare('SELECT id FROM po_items WHERE id=?').get(m.po_item_id) ? m.po_item_id : null) : null;
    insertMat.run(
      dprId, validPoItemId, m.item_master_id || null, matName, m.unit || 'nos',
      +m.boq_qty || 0, consumed, +m.cumulative_consumed || consumed,
      +m.balance_qty || 0, m.remarks || null,
    );
    // Auto-OUT only if we know the item AND a site store exists AND qty > 0
    if (consumed > 0 && m.item_master_id && siteStore?.id) {
      try {
        const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(siteStore.id, m.item_master_id);
        const prevQty = cur ? +cur.quantity : 0;
        if (prevQty >= consumed) {
          const rate = cur ? +cur.avg_rate : 0;
          db.prepare('UPDATE stock_balance SET quantity=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
            .run(prevQty - consumed, cur.id);
          db.prepare(
            `INSERT INTO stock_movements
              (warehouse_id, item_master_id, type, quantity, rate, total_value,
               reference_type, reference_id, site_id, notes, created_by)
             VALUES (?,?,?,?,?,?,?,?,?,?,?)`
          ).run(siteStore.id, m.item_master_id, 'OUT', consumed, rate, consumed * rate,
                'DPR_CONSUMPTION', `DPR-${dprId}`, site_id,
                `Consumed in DPR #${dprId} on ${report_date}`, req.user.id);
          stockOuts += 1;
        } else {
          // Insufficient stock — log but don't fail the DPR submission.
          // mam can manually adjust or do a stock-in to reconcile.
          console.warn(`[dpr] Skipped auto-OUT for item ${m.item_master_id}: have ${prevQty}, need ${consumed}`);
        }
      } catch (e) {
        console.error('[dpr] auto-OUT failed:', e.message);
      }
    }
  }

  // Fire-and-forget: if this DPR is a loss, check whether the site now
  // has 3+ consecutive loss days and email director@securedengineers.com
  // (mam's spec). Email failures must not break the DPR save itself.
  if ((+profit_loss || 0) < 0) {
    setImmediate(() => checkConsecutiveLossAndAlert(dprId, site_id).catch(e =>
      console.warn('[dpr] loss-streak alert failed:', e.message)));
  }

  res.status(201).json({ id: dprId, message: 'DPR submitted', stock_outs: stockOuts });
  } catch (err) {
    console.error('DPR submit error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to submit DPR' });
  }
});

// Walk backwards from `asOfDate` and count consecutive days where the
// site's net profit_loss (summed across any same-day DPRs) is < 0.
// Stops at the first non-loss day or a missing date in the sequence.
function consecutiveLossDays(db, siteId, asOfDate) {
  // Aggregate per-day net P/L. Limits to the last 30 dates which is more
  // than enough for our 3-day check and keeps the streak walk bounded.
  const days = db.prepare(`SELECT report_date AS d, SUM(profit_loss) AS pl
                           FROM dpr WHERE site_id=? AND report_date<=?
                           GROUP BY report_date ORDER BY report_date DESC LIMIT 30`).all(siteId, asOfDate);
  let streak = 0;
  let cursor = asOfDate;
  for (const row of days) {
    if (row.d !== cursor) break;            // gap (missing day) — streak stops
    if ((+row.pl || 0) >= 0) break;         // non-loss day — streak stops
    streak += 1;
    cursor = isoMinusOneDay(cursor);
  }
  return streak;
}

// Detect a 3+ day consecutive loss streak for `siteId` and email the
// director if it just crossed the threshold (or just got longer than the
// last alert we sent). Runs after each loss-DPR save.
async function checkConsecutiveLossAndAlert(latestDprId, siteId) {
  const db = getDb();
  const latest = db.prepare(`SELECT d.id, d.report_date, d.profit_loss,
                                    s.name AS site_name, s.client_name
                             FROM dpr d LEFT JOIN sites s ON d.site_id=s.id
                             WHERE d.id=?`).get(latestDprId);
  if (!latest) return;

  const streak = consecutiveLossDays(db, siteId, latest.report_date);
  if (streak < 3) return;

  // Dedupe: only send if this latest DPR's date is newer than the date we
  // last alerted for on this site (any DPR row for this site carries the
  // streak_alert_sent_for marker, so check the max across the site).
  const lastAlertedFor = db.prepare(`SELECT MAX(streak_alert_sent_for) AS d FROM dpr WHERE site_id=?`).get(siteId).d;
  if (lastAlertedFor && lastAlertedFor >= latest.report_date) return;

  // Pull the 3 most recent loss rows for context.
  const recent = db.prepare(`SELECT report_date, profit_loss, hindrance_category, hindrances
                             FROM dpr WHERE site_id=?
                             ORDER BY report_date DESC LIMIT 5`).all(siteId);

  const totalLoss = recent.slice(0, streak).reduce((s, r) => s + (+r.profit_loss || 0), 0);
  const siteName = latest.site_name || `Site #${siteId}`;
  const subject = `[SEPL ERP] ${siteName} — ${streak} consecutive loss days (Rs ${Math.abs(Math.round(totalLoss)).toLocaleString('en-IN')} total)`;
  const rowsHtml = recent.slice(0, streak).map(r =>
    `<tr><td style="padding:6px 10px;border:1px solid #eee">${r.report_date}</td>` +
    `<td style="padding:6px 10px;border:1px solid #eee;color:#b91c1c">Rs ${(+r.profit_loss||0).toLocaleString('en-IN')}</td>` +
    `<td style="padding:6px 10px;border:1px solid #eee">${r.hindrance_category || '-'}</td>` +
    `<td style="padding:6px 10px;border:1px solid #eee">${(r.hindrances || '-').replace(/</g,'&lt;')}</td></tr>`
  ).join('');
  const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#111">
    <h2 style="color:#b91c1c;margin:0 0 6px 0">Loss streak alert — ${siteName}</h2>
    <p>This site has reported a loss for <b>${streak} consecutive days</b>. Latest DPR for <b>${latest.report_date}</b>.</p>
    <p>Cumulative loss across the streak: <b style="color:#b91c1c">Rs ${Math.abs(Math.round(totalLoss)).toLocaleString('en-IN')}</b></p>
    <table style="border-collapse:collapse;font-size:13px;margin-top:6px">
      <thead><tr style="background:#f3f4f6">
        <th style="padding:6px 10px;border:1px solid #eee;text-align:left">Date</th>
        <th style="padding:6px 10px;border:1px solid #eee;text-align:left">P/L</th>
        <th style="padding:6px 10px;border:1px solid #eee;text-align:left">Hindrance Category</th>
        <th style="padding:6px 10px;border:1px solid #eee;text-align:left">Reason</th>
      </tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <p style="margin-top:12px;color:#666;font-size:12px">Open the DPR module in SEPL ERP and switch to the <b>Loss Reasons</b> tab to follow up.</p>
  </div>`;

  const { sendEmail } = require('../lib/email');
  const result = await sendEmail({ subject, html });
  if (result?.sent) {
    db.prepare('UPDATE dpr SET streak_alert_sent_for=? WHERE id=?').run(latest.report_date, latest.id);
    console.log(`[dpr] loss-streak email sent: ${siteName} (${streak} days)`);
  } else if (result?.skipped) {
    console.log(`[dpr] loss-streak email skipped (${result.reason}): ${siteName} (${streak} days)`);
  }
}

function isoMinusOneDay(iso) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().split('T')[0];
}

// Loss Reasons dashboard — every DPR with profit_loss < 0, latest first.
// Includes `consecutive_loss_days` for the site as of that DPR's date so
// the UI can show a streak badge and a 3+ days alert highlight.
router.get('/loss-dashboard', (req, res) => {
  const db = getDb();
  // Resolve the Site Clearance owner — falls back through:
  //   1. business_book.employee_assigned (CRM on the BB row for this site)
  //   2. sites.supervisor (legacy text field)
  //   3. NULL if neither is set
  // Mam (2026-05-16) wants this name surfaced so the Loss Reasons
  // dashboard shows WHO is on the hook for each category of hindrance.
  const rows = db.prepare(`SELECT d.id, d.site_id, d.report_date, d.profit_loss, d.grand_total_a,
                                  d.grand_total_b, d.hindrance_category, d.hindrances,
                                  d.loss_addressed, d.loss_addressed_at, d.loss_addressed_note,
                                  d.loss_addressed_proof_url,
                                  s.name AS site_name, s.client_name, s.supervisor,
                                  bb.employee_assigned AS site_crm_name,
                                  u.name AS submitted_by_name, au.name AS addressed_by_name
                           FROM dpr d
                           LEFT JOIN sites s ON d.site_id=s.id
                           LEFT JOIN business_book bb ON s.business_book_id = bb.id
                           LEFT JOIN users u ON d.submitted_by=u.id
                           LEFT JOIN users au ON d.loss_addressed_by=au.id
                           WHERE d.profit_loss < 0
                           ORDER BY d.report_date DESC, d.id DESC`).all();

  // Use the shared helper so the loss-dashboard streak count and the
  // alert-on-submit streak count never diverge.
  for (const r of rows) {
    r.consecutive_loss_days = consecutiveLossDays(db, r.site_id, r.report_date);
  }

  res.json(rows);
});

// Proof-of-resolution column (mam, 2026-05-16: "on address click proof
// so that problem can solve and identify").  Idempotent ALTER TABLE.
try { getDb().exec(`ALTER TABLE dpr ADD COLUMN loss_addressed_proof_url TEXT`); } catch (_) {}

// Mark a loss as followed-up / addressed.  Optional proof_url (a
// file URL from POST /api/upload) stored so management can later
// click through to verify the issue was actually fixed.
router.patch('/:id/loss-addressed', (req, res) => {
  const db = getDb();
  const { addressed, note, proof_url } = req.body || {};
  const next = addressed ? 1 : 0;
  const r = db.prepare(`UPDATE dpr SET loss_addressed=?, loss_addressed_by=?, loss_addressed_at=?, loss_addressed_note=?, loss_addressed_proof_url=?
                        WHERE id=?`).run(
    next,
    next ? req.user.id : null,
    next ? new Date().toISOString() : null,
    next ? (note || null) : null,
    next ? (proof_url || null) : null,
    req.params.id,
  );
  if (r.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ message: next ? 'Marked as addressed' : 'Unmarked' });
});

// Per-site engineer compliance — mam (2026-05-29):
// "as per site eng present and dpr filled as per filter dates".
//
// For the chosen date_from..date_to window, every active site rolls
// up to one row showing how many days the assigned site engineer
// punched attendance at that site vs how many days a DPR was filed.
// The `gap` column (present − filled) surfaces engineers who showed
// up but skipped the DPR — straight line to the Payment Blocked
// dashboard above.
//
// MUST stay above GET /:id — otherwise the id-matcher eats the path.
//
// Permission: same canSeeAll gate as the rest of /dpr — engineers
// see only their own sites; admins/managers see everything.
router.get('/engineer-compliance', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const canSeeAll = dprCanSeeAll(db, req.user);

  // Default range: last 30 days inclusive of today.  Caller can
  // override either bound.
  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = (() => {
    const d = new Date(); d.setDate(d.getDate() - 29);
    return d.toISOString().slice(0, 10);
  })();
  const from = String(req.query.date_from || thirtyAgo).slice(0, 10);
  const to   = String(req.query.date_to   || today    ).slice(0, 10);
  if (from > to) return res.status(400).json({ error: 'date_from must be on or before date_to' });

  // Calendar-day count so the UI can show "12 / 30 days present"
  // without re-computing on the client.
  const calendarDays = (() => {
    const a = new Date(from + 'T00:00:00');
    const b = new Date(to   + 'T00:00:00');
    return Math.round((b - a) / 86400000) + 1;
  })();

  // Attendance statuses that count as "engineer was on site".
  // Excludes leave/absent/holiday — those are legitimately DPR-free.
  const PRESENT_STATUSES = "('present','half_day','short_day','late')";

  let sql = `
    SELECT
      s.id                              AS site_id,
      s.name                            AS site_name,
      s.client_name                     AS client_name,
      s.status                          AS site_status,
      s.supervisor                      AS supervisor,
      s.site_engineer_id                AS engineer_id,
      u.name                            AS engineer_name,
      COALESCE((
        SELECT COUNT(DISTINCT a.date)
          FROM attendance a
         WHERE a.user_id  = s.site_engineer_id
           AND a.site_id  = s.id
           AND a.date BETWEEN ? AND ?
           AND a.status IN ${PRESENT_STATUSES}
      ), 0) AS days_present,
      COALESCE((
        SELECT COUNT(DISTINCT d.report_date)
          FROM dpr d
         WHERE d.site_id = s.id
           AND d.report_date BETWEEN ? AND ?
           AND COALESCE(d.is_planned_template, 0) = 0
      ), 0) AS days_dpr_filled
      FROM sites s
      LEFT JOIN users u ON u.id = s.site_engineer_id
     WHERE s.status = 'active'
       AND s.site_engineer_id IS NOT NULL
  `;
  const params = [from, to, from, to];

  if (!canSeeAll) {
    sql += ` AND (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
       WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
         AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    params.push(uid, `%,${uid},%`, uid);
  }

  // Worst gap first so MD's eyeball-test catches offenders straight
  // away.  Site name as tiebreaker for a stable, scan-friendly order.
  sql += ` ORDER BY (
      COALESCE((SELECT COUNT(DISTINCT a.date) FROM attendance a
                 WHERE a.user_id = s.site_engineer_id AND a.site_id = s.id
                   AND a.date BETWEEN ? AND ? AND a.status IN ${PRESENT_STATUSES}), 0)
      -
      COALESCE((SELECT COUNT(DISTINCT d.report_date) FROM dpr d
                 WHERE d.site_id = s.id
                   AND d.report_date BETWEEN ? AND ?
                   AND COALESCE(d.is_planned_template, 0) = 0), 0)
    ) DESC, s.name ASC`;
  params.push(from, to, from, to);

  const rows = db.prepare(sql).all(...params);

  // Roll up totals so the header strip can show "X engineers
  // present Y days but only filed Z DPRs" at a glance.
  const totals = rows.reduce((acc, r) => {
    acc.sites += 1;
    acc.days_present += r.days_present;
    acc.days_dpr_filled += r.days_dpr_filled;
    return acc;
  }, { sites: 0, days_present: 0, days_dpr_filled: 0 });
  totals.gap_days = Math.max(0, totals.days_present - totals.days_dpr_filled);

  res.json({
    range: { date_from: from, date_to: to, calendar_days: calendarDays },
    totals,
    rows,
  });
});

// Get DPR details
router.get('/:id', (req, res) => {
  const db = getDb();
  const dpr = db.prepare(`SELECT d.*, s.name as site_name, s.client_name, u.name as submitted_by_name
    FROM dpr d LEFT JOIN sites s ON d.site_id=s.id LEFT JOIN users u ON d.submitted_by=u.id WHERE d.id=?`).get(req.params.id);
  if (!dpr) return res.status(404).json({ error: 'Not found' });
  dpr.work_items = db.prepare('SELECT * FROM dpr_work_items WHERE dpr_id=?').all(req.params.id);
  dpr.manpower = db.prepare('SELECT * FROM dpr_manpower WHERE dpr_id=?').all(req.params.id);
  dpr.materials = db.prepare('SELECT * FROM dpr_material WHERE dpr_id=?').all(req.params.id);
  dpr.machinery = db.prepare('SELECT * FROM dpr_machinery WHERE dpr_id=?').all(req.params.id);
  dpr.contractors = db.prepare('SELECT id, name, manpower FROM dpr_contractors WHERE dpr_id=? ORDER BY id').all(req.params.id);
  res.json(dpr);
});

// Approve/Reject DPR — requires can_approve on the dpr module.
// Site Engineers can only submit DPRs; admin / billing engineers approve.
router.put('/:id/approve', requirePermission('dpr', 'approve'), (req, res) => {
  const { approval_status, billing_ready } = req.body;
  const db = getDb();
  db.prepare('UPDATE dpr SET approval_status=?, billing_ready=?, approved_by=? WHERE id=?')
    .run(approval_status, billing_ready ? 1 : 0, req.user.id, req.params.id);
  if (billing_ready) {
    const dpr = db.prepare('SELECT d.*, s.client_name, s.name as site_name FROM dpr d JOIN sites s ON d.site_id=s.id WHERE d.id=?').get(req.params.id);
    if (dpr?.client_name) {
      const existing = db.prepare('SELECT id FROM receivables WHERE client_name=? AND project_name=? AND invoice_date=?').get(dpr.client_name, dpr.site_name, dpr.report_date);
      if (!existing) {
        db.prepare('INSERT OR IGNORE INTO receivables (client_name, project_name, invoice_date, invoice_amount, outstanding_amount, due_date, status, created_by) VALUES (?,?,?,0,0,?,?,?)')
          .run(dpr.client_name, dpr.site_name, dpr.report_date, dpr.report_date, 'green', req.user.id);
      }
    }
  }
  res.json({ message: `DPR ${approval_status}` });
});

// Delete DPR (cascade child tables)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  db.prepare('DELETE FROM dpr_work_items WHERE dpr_id=?').run(id);
  db.prepare('DELETE FROM dpr_manpower WHERE dpr_id=?').run(id);
  db.prepare('DELETE FROM dpr_material WHERE dpr_id=?').run(id);
  db.prepare('DELETE FROM dpr_machinery WHERE dpr_id=?').run(id);
  db.prepare('DELETE FROM dpr WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

router.delete('/sites/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const dprCount = db.prepare('SELECT COUNT(*) as c FROM dpr WHERE site_id=?').get(id).c;
  if (dprCount > 0) return res.status(409).json({ error: 'Cannot delete: DPRs reference this site' });
  db.prepare('DELETE FROM sites WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Engineer → Site → BOQ progress. Shows every site each Site Engineer is
// assigned to (directly on sites.site_engineer_id or via a linked PO's
// site_engineer_ids CSV), with BOQ qty vs consumed qty from DPR work items
// and a % complete per item and per site.
router.get('/progress', (req, res) => {
  const db = getDb();
  const uid = req.user.id;
  const canSeeAll = dprCanSeeAll(db, req.user);

  // Base engineer pool: users with Site Engineer role. Non-admins only see themselves.
  let engineers = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    WHERE u.active=1 AND (r.name='Site Engineer' OR u.role='admin')
    ORDER BY u.name
  `).all();
  if (!canSeeAll) engineers = engineers.filter(e => e.id === uid);

  const siteSql = `SELECT MIN(s.id) as id, s.name, s.business_book_id, s.po_id, s.site_engineer_id, s.client_name
    FROM sites s
    WHERE (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))
    GROUP BY s.name`;

  const result = [];
  for (const eng of engineers) {
    const sites = db.prepare(siteSql).all(eng.id, `%,${eng.id},%`, eng.id);
    const siteDetails = [];
    for (const site of sites) {
      // Collect all business_book_ids for same-named sites (legacy duplicates)
      const bbIds = db.prepare('SELECT DISTINCT business_book_id FROM sites WHERE name=? AND business_book_id IS NOT NULL').all(site.name).map(r => r.business_book_id);
      let items = [];
      if (bbIds.length > 0) {
        const placeholders = bbIds.map(() => '?').join(',');
        items = db.prepare(`SELECT * FROM po_items WHERE business_book_id IN (${placeholders})`).all(...bbIds);
      } else if (site.business_book_id) {
        items = db.prepare('SELECT * FROM po_items WHERE business_book_id=?').all(site.business_book_id);
      }

      // All site-IDs with the same site name — DPRs are submitted against a
      // specific site_id, but re-uploading a PO recycles po_items with new
      // IDs, so we also match on description within this site's DPRs.
      const siteIds = db.prepare('SELECT id FROM sites WHERE name=?').all(site.name).map(r => r.id);
      const sidPlaceholders = siteIds.length ? siteIds.map(() => '?').join(',') : '?';
      const sidParams = siteIds.length ? siteIds : [site.id];

      let totalBoq = 0, totalDone = 0;
      const itemRows = items.map(it => {
        const done = db.prepare(`
          SELECT COALESCE(SUM(wi.actual_qty), 0) as t
          FROM dpr_work_items wi
          JOIN dpr d ON wi.dpr_id = d.id
          WHERE d.site_id IN (${sidPlaceholders})
            AND (wi.po_item_id = ? OR (wi.description IS NOT NULL AND wi.description = ?))
        `).get(...sidParams, it.id, it.description).t || 0;

        const boq = it.quantity || 0;
        const remaining = Math.max(0, boq - done);
        const pct = boq > 0 ? Math.min(100, Math.round((done / boq) * 1000) / 10) : 0;
        const boqAmount = (it.rate || 0) * boq;
        const doneAmount = (it.rate || 0) * done;
        totalBoq += boqAmount;
        totalDone += doneAmount;
        return {
          po_item_id: it.id,
          description: it.description,
          unit: it.unit,
          rate: it.rate || 0,
          boq_qty: boq,
          done_qty: done,
          remaining_qty: remaining,
          pct_complete: pct,
          boq_amount: Math.round(boqAmount),
          done_amount: Math.round(doneAmount),
        };
      });
      // Sort: incomplete first (so engineer sees pending work), then by name
      itemRows.sort((a, b) => (a.pct_complete - b.pct_complete) || a.description.localeCompare(b.description));

      const overallPct = totalBoq > 0 ? Math.round((totalDone / totalBoq) * 1000) / 10 : 0;
      siteDetails.push({
        site_id: site.id,
        site_name: site.name,
        client_name: site.client_name,
        total_boq_amount: Math.round(totalBoq),
        total_done_amount: Math.round(totalDone),
        overall_pct: overallPct,
        item_count: itemRows.length,
        items: itemRows,
      });
    }
    siteDetails.sort((a, b) => a.site_name.localeCompare(b.site_name));
    result.push({
      engineer: { id: eng.id, name: eng.name, email: eng.email },
      site_count: siteDetails.length,
      sites: siteDetails,
    });
  }
  res.json(result);
});

// No DPR = no payment check
router.get('/payment-check/:site_id', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const dpr = db.prepare('SELECT id FROM dpr WHERE site_id=? AND report_date=?').get(req.params.site_id, today);
  res.json({ site_id: req.params.site_id, dpr_submitted: !!dpr, payment_allowed: !!dpr,
    message: dpr ? 'DPR submitted - payment can proceed' : 'NO DPR submitted today - payment NOT allowed' });
});

// Admin-triggered DPR auto-prompt — same code path as the 18:00
// scheduler, exposed so mam can verify the push reaches engineers
// without waiting for evening.  Per TOC v3 P1 #4.
router.post('/admin/trigger-prompt', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  try {
    const { runOnce } = require('../scripts/dprAutoPrompt');
    runOnce().then(() => {}).catch(e => console.error('[dpr-prompt manual]', e.message));
    res.json({ message: 'DPR prompt fired — check pm2 logs for the adherence rollup line' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
