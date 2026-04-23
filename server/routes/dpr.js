const express = require('express');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

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

  let sql = `SELECT MIN(s.id) as id, s.name, s.address, s.client_name, s.po_id, s.business_book_id,
    s.site_engineer_id, s.supervisor, s.status, u.name as engineer_name, bb.lead_no,
    COUNT(*) as entry_count
    FROM sites s
    LEFT JOIN users u ON s.site_engineer_id=u.id
    LEFT JOIN business_book bb ON s.business_book_id=bb.id`;
  const params = [];

  if (!isAdmin && !all) {
    sql += ` WHERE (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    params.push(uid, `%,${uid},%`, uid);
  }

  sql += ' GROUP BY s.name ORDER BY s.name';
  res.json(db.prepare(sql).all(...params));
});

router.post('/sites', (req, res) => {
  const { name, address, client_name, po_id, site_engineer_id, supervisor } = req.body;
  const r = getDb().prepare('INSERT INTO sites (name, address, client_name, po_id, site_engineer_id, supervisor) VALUES (?,?,?,?,?,?)')
    .run(name, address, client_name, po_id, site_engineer_id, supervisor);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.put('/sites/:id', (req, res) => {
  const { name, address, client_name, site_engineer_id, supervisor, status } = req.body;
  getDb().prepare('UPDATE sites SET name=?, address=?, client_name=?, site_engineer_id=?, supervisor=?, status=? WHERE id=?')
    .run(name, address, client_name, site_engineer_id, supervisor, status, req.params.id);
  res.json({ message: 'Updated' });
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

// Get PO items for a site - fetches ALL PO items for that company/site name
router.get('/sites/:site_id/po-items', (req, res) => {
  const db = getDb();
  const site = db.prepare('SELECT name, po_id, business_book_id FROM sites WHERE id=?').get(req.params.site_id);
  if (!site) return res.json([]);
  // Get ALL business_book IDs for this company name (all POs for same company)
  const allBBIds = db.prepare('SELECT DISTINCT s.business_book_id FROM sites s WHERE s.name=? AND s.business_book_id IS NOT NULL').all(site.name);
  const bbIds = allBBIds.map(r => r.business_book_id);
  let items = [];
  if (bbIds.length > 0) {
    items = db.prepare(`SELECT * FROM po_items WHERE business_book_id IN (${bbIds.join(',')})`).all();
  } else if (site.business_book_id) {
    items = db.prepare('SELECT * FROM po_items WHERE business_book_id=?').all(site.business_book_id);
  }
  if (items.length > 0) {
    // Match DPR consumption by po_item_id OR by description (so re-uploading
    // a PO — which recycles po_items with new IDs — doesn't lose history).
    const siteIds = db.prepare('SELECT id FROM sites WHERE name=?').all(site.name).map(r => r.id);
    const sidPlaceholders = siteIds.length ? siteIds.map(() => '?').join(',') : '?';
    const sidParams = siteIds.length ? siteIds : [req.params.site_id];
    const result = items.map(item => {
      const filled = db.prepare(`
        SELECT COALESCE(SUM(wi.actual_qty), 0) as total
        FROM dpr_work_items wi
        JOIN dpr d ON wi.dpr_id = d.id
        WHERE d.site_id IN (${sidPlaceholders})
          AND (wi.po_item_id = ? OR (wi.description IS NOT NULL AND wi.description = ?))
      `).get(...sidParams, item.id, item.description);
      const filledQty = filled?.total || 0;
      const remaining = Math.max(0, (item.quantity || 0) - filledQty);
      return { ...item, filled_qty: filledQty, remaining_qty: remaining };
    });
    return res.json(result);
  }
  res.json([]);
});

// ===== DPR =====
router.get('/', (req, res) => {
  const { site_id, date, status } = req.query;
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  let sql = `SELECT d.*, s.name as site_name, u.name as submitted_by_name, au.name as approved_by_name
    FROM dpr d LEFT JOIN sites s ON d.site_id=s.id LEFT JOIN users u ON d.submitted_by=u.id LEFT JOIN users au ON d.approved_by=au.id WHERE 1=1`;
  const params = [];
  if (site_id) { sql += ' AND d.site_id=?'; params.push(site_id); }
  if (date) { sql += ' AND d.report_date=?'; params.push(date); }
  if (status) { sql += ' AND d.approval_status=?'; params.push(status); }
  if (!isAdmin) {
    sql += ` AND (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    params.push(uid, `%,${uid},%`, uid);
  }
  sql += ' ORDER BY d.report_date DESC, s.name';
  res.json(getDb().prepare(sql).all(...params));
});

// Dashboard summary
router.get('/summary', (req, res) => {
  const db = getDb();
  const today = new Date().toISOString().split('T')[0];
  const activeSites = db.prepare("SELECT COUNT(DISTINCT name) as c FROM sites WHERE status='active'").get();
  const todayDprs = db.prepare('SELECT COUNT(*) as c FROM dpr WHERE report_date=?').get(today);
  const pendingApproval = db.prepare("SELECT COUNT(*) as c FROM dpr WHERE approval_status='pending'").get();
  const billingReady = db.prepare('SELECT COUNT(*) as c FROM dpr WHERE billing_ready=1').get();
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;
  let missingSql = `SELECT MIN(s.id) as id, s.name, s.supervisor FROM sites s WHERE s.status='active'
    AND s.id NOT IN (SELECT site_id FROM dpr WHERE report_date=?)`;
  const missingParams = [today];
  if (!isAdmin) {
    missingSql += ` AND (s.site_engineer_id = ? OR EXISTS (
      SELECT 1 FROM purchase_orders po
      WHERE (po.id = s.po_id OR po.business_book_id = s.business_book_id)
        AND ((',' || COALESCE(po.site_engineer_ids,'') || ',') LIKE ? OR po.site_engineer_id = ?)
    ))`;
    missingParams.push(uid, `%,${uid},%`, uid);
  }
  missingSql += ' GROUP BY s.name';
  const missingSites = db.prepare(missingSql).all(...missingParams);
  const variance = db.prepare(`SELECT d.report_date, s.name as site_name,
    COALESCE(AVG(w.variance_pct),0) as avg_variance
    FROM dpr d JOIN sites s ON d.site_id=s.id LEFT JOIN dpr_work_items w ON w.dpr_id=d.id
    WHERE d.report_date >= date('now','-7 days') GROUP BY d.id ORDER BY d.report_date DESC LIMIT 20`).all();
  res.json({ activeSites: activeSites.c, todaySubmissions: todayDprs.c, pendingApproval: pendingApproval.c, billingReady: billingReady.c, missingSites, recentVariance: variance });
});

// Submit MEPF DPR
router.post('/', (req, res) => {
  const { site_id, report_date, weather, overall_status, shift, contractor_name, contractor_manpower, mb_sheet_no,
    floor_zone, system_type, safety_toolbox_talk, safety_ppe_compliance, safety_incidents,
    next_day_plan, hindrances, remarks, grand_total_a, grand_total_b, profit_loss,
    work_items, manpower, machinery } = req.body;

  if (!site_id || !report_date) return res.status(400).json({ error: 'Site and date required' });
  const db = getDb();

  try {
  const r = db.prepare(`INSERT INTO dpr (site_id, report_date, submitted_by, submission_time, weather, overall_status,
    shift, contractor_name, contractor_manpower, mb_sheet_no, grand_total_a, grand_total_b, profit_loss,
    floor_zone, system_type, safety_toolbox_talk, safety_ppe_compliance, safety_incidents,
    next_day_plan, hindrances, remarks) VALUES (?,?,?,CURRENT_TIMESTAMP,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(site_id, report_date, req.user.id, weather || 'clear', overall_status || 'on_track',
      shift || 'day', contractor_name, contractor_manpower || 0, mb_sheet_no,
      grand_total_a || 0, grand_total_b || 0, profit_loss || 0,
      floor_zone, system_type, safety_toolbox_talk ? 1 : 0, safety_ppe_compliance ? 1 : 0,
      safety_incidents, next_day_plan, hindrances, remarks);
  const dprId = r.lastInsertRowid;

  // Table A: Installation work items from PO
  const insertWork = db.prepare('INSERT INTO dpr_work_items (dpr_id, po_item_id, description, unit, floor_zone, boq_qty, rate, amount, planned_qty, actual_qty, cumulative_qty, variance_pct, remarks) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  for (const w of (work_items || [])) {
    if (!w.description && !w.po_item_id) continue;
    const qty = w.qty || 0;
    const rate = w.rate || 0;
    const amount = qty * rate;
    // Verify po_item_id exists, set null if not
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

  res.status(201).json({ id: dprId, message: 'DPR submitted' });
  } catch (err) {
    console.error('DPR submit error:', err.message);
    res.status(500).json({ error: err.message || 'Failed to submit DPR' });
  }
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
  const isAdmin = req.user.role === 'admin';
  const uid = req.user.id;

  // Base engineer pool: users with Site Engineer role. Non-admins only see themselves.
  let engineers = db.prepare(`
    SELECT DISTINCT u.id, u.name, u.email
    FROM users u
    LEFT JOIN user_roles ur ON u.id = ur.user_id
    LEFT JOIN roles r ON ur.role_id = r.id
    WHERE u.active=1 AND (r.name='Site Engineer' OR u.role='admin')
    ORDER BY u.name
  `).all();
  if (!isAdmin) engineers = engineers.filter(e => e.id === uid);

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

module.exports = router;
