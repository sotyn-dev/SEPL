const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }
});

const ALLOWED_SOURCES = ['PO', 'Quote', 'Manual', 'Online', 'Bill', 'Catalogue'];

// MD Phase 1: "Right now Price is just a number — no date, no vendor,
// no bill. We can't trust it for tenders." Every Item Master row now
// surfaces:
//   - age_days     — days since the ACTUAL rate date (bill_po_date),
//                    NOT since the row was typed into ERP. Mam: "u
//                    pick its from when we enter in erp itemwise
//                    sheet" — a 2-year-old rate imported today should
//                    NOT show as 0 days. Falls back to priced_at /
//                    updated_at only when no bill_po_date is set.
//   - age_status   — green ≤30 / yellow 31-60 / red 60+ / never (no
//                    price set yet) so the UI can colour the row.
// And the filter param accepts status=expired|ageing|fresh|never|
// make_blank|no_vendor for the top-row filter pills.
function ageStatus(days) {
  if (days == null) return 'never';
  if (days <= 30) return 'green';
  if (days <= 60) return 'yellow';
  return 'red';
}

// SQL snippet that picks the right "rate date" to age from. Bill/PO
// date is the real-world evidence date; we fall back to priced_at
// (when staff captured it) only if no bill date was recorded. Returns
// NULL when no price/bill is set so the row shows NEVER.
const AGE_DATE_EXPR = `COALESCE(im.bill_po_date, im.priced_at, CASE WHEN im.current_price > 0 THEN im.updated_at END)`;

// Speed-up indexes for the filter pills (mam, 2026-05-28: "items wise
// master takes time to open like hang" — 2,385 rows × 5 filter columns
// without indexes meant each click did a full scan).
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_department    ON item_master(department)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_vendor_id     ON item_master(vendor_id)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_make          ON item_master(make)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_bill_po_date  ON item_master(bill_po_date)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_item_code     ON item_master(item_code)`); } catch (_) {}
try { getDb().exec(`CREATE INDEX IF NOT EXISTS idx_im_approval       ON item_master(approval_status)`); } catch (_) {}

// Guarantee the pricing/approval columns the list query joins on actually
// exist (mam 2026-06-16: "data is missing"). The central migration adds these
// with a "REFERENCES users(id)" clause, which some SQLite builds reject in an
// ALTER ... ADD COLUMN — and since that migration is wrapped in a silent
// try/catch, the column ends up missing on those servers. The Item Master list
// JOINs on approved_by / priced_by, so a missing column made the WHOLE list
// 500 and show "0 items / No items found", while the completion dashboard
// (which never touches these columns) kept reporting the real count. Re-adding
// them here with a plain ADD COLUMN (no REFERENCES) is idempotent and safe.
for (const col of [
  'priced_at DATETIME',
  'priced_by INTEGER',
  'approved_by INTEGER',
  'approved_at DATETIME',
  "approval_status TEXT DEFAULT 'approved'",
  'ai_audit_notes TEXT',
  'ai_reviewed_at DATETIME',
]) {
  try { getDb().exec(`ALTER TABLE item_master ADD COLUMN ${col}`); } catch (_) {}
}

// One-time backfill (mam 2026-06-16): flag items added in the LAST 2 DAYS
// (i.e. "yesterday's new entries") as pending so an Admin reviews them;
// everything older stays approved (the column default already grandfathered
// every existing row to 'approved'). Guarded by an app_settings sentinel so
// it runs exactly once per deploy of this rule.
try {
  const db = getDb();
  db.exec(`CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT)`);
  const flag = db.prepare(`SELECT value FROM app_settings WHERE key='item_master_recent_pending_v1'`).get();
  if (!flag) {
    const r = db.prepare(`
      UPDATE item_master
         SET approval_status = 'pending', approved_by = NULL, approved_at = NULL
       WHERE COALESCE(approval_status, 'approved') = 'approved'
         AND created_at >= datetime('now', 'localtime', '-2 days')
    `).run();
    db.prepare(`INSERT INTO app_settings (key, value) VALUES ('item_master_recent_pending_v1', '1')`).run();
    console.log(`[item_master] recent-pending backfill: ${r.changes} item(s) flagged for approval`);
  }
} catch (e) {
  console.warn('[item_master] recent-pending backfill skipped:', e.message);
}

// Builds the WHERE clause + params shared by the list endpoint and the
// COUNT(*) for the paginator. Keeping them in one place ensures the
// "Showing X-Y of Z" total always matches what the table shows.
function buildItemFilters(query) {
  const { department, type, search, status, approval } = query;
  const clauses = [];
  const params = [];
  if (department) { clauses.push('im.department=?'); params.push(department); }
  if (type) { clauses.push('im.type=?'); params.push(type); }
  // Approval filter (mam 2026-06-16): pending | approved | rejected.
  // Treat a missing/NULL status as 'approved' (grandfathered rows).
  if (approval === 'pending')  clauses.push(`im.approval_status = 'pending'`);
  if (approval === 'approved') clauses.push(`COALESCE(im.approval_status, 'approved') = 'approved'`);
  if (approval === 'rejected') clauses.push(`im.approval_status = 'rejected'`);
  if (search) {
    clauses.push('(im.item_name LIKE ? OR im.specification LIKE ? OR im.size LIKE ? OR im.item_code LIKE ? OR im.make LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }
  if (status === 'expired')    clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) > 60`);
  if (status === 'ageing')     clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) BETWEEN 31 AND 60`);
  if (status === 'fresh')      clauses.push(`(julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) <= 30 AND ${AGE_DATE_EXPR} IS NOT NULL`);
  if (status === 'never')      clauses.push(`(${AGE_DATE_EXPR} IS NULL OR im.current_price = 0)`);
  if (status === 'make_blank') clauses.push(`(im.make IS NULL OR TRIM(im.make) = '')`);
  if (status === 'no_vendor')  clauses.push('im.vendor_id IS NULL');
  return { where: clauses.length ? ' WHERE ' + clauses.join(' AND ') : '', params };
}

// GET items, paginated. Response: { items, total, limit, offset }.
// Defaults to 100 per page so the client doesn't paint 2,385 rows at
// once (which is what was hanging the browser). Pass ?limit=99999 if
// you genuinely need everything (export, scripts).
router.get('/', requirePermission('item_master', 'view'), (req, res) => {
  const { where, params } = buildItemFilters(req.query);
  const limit  = Math.max(1, Math.min(99999, +req.query.limit  || 100));
  const offset = Math.max(0, +req.query.offset || 0);

  const sql = `
    SELECT im.*,
           v.name AS vendor_name,
           u.name AS priced_by_name,
           au.name AS approved_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
      LEFT JOIN users au ON au.id = im.approved_by
    ${where}
    ORDER BY im.item_code
    LIMIT ? OFFSET ?
  `;
  const countSql = `SELECT COUNT(*) AS n FROM item_master im ${where}`;

  const db = getDb();
  try {
    const rows  = db.prepare(sql).all(...params, limit, offset);
    const total = db.prepare(countSql).get(...params).n;
    res.json({
      items: rows.map(r => ({ ...r, age_status: ageStatus(r.age_days) })),
      total, limit, offset,
    });
  } catch (e) {
    // Never let a schema hiccup (e.g. a column an older server failed to add)
    // blank out the entire Item Master. Log it, then fall back to a query that
    // only touches base columns + the vendor name so the list still loads.
    console.error('[item_master] list query failed, using degraded fallback:', e.message);
    try {
      const fbSql = `
        SELECT im.*, v.name AS vendor_name,
               CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                    ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
               END AS age_days
          FROM item_master im
          LEFT JOIN vendors v ON v.id = im.vendor_id
        ${where}
        ORDER BY im.item_code
        LIMIT ? OFFSET ?`;
      const rows  = db.prepare(fbSql).all(...params, limit, offset);
      const total = db.prepare(countSql).get(...params).n;
      res.json({
        items: rows.map(r => ({ ...r, age_status: ageStatus(r.age_days) })),
        total, limit, offset,
      });
    } catch (e2) {
      console.error('[item_master] list fallback also failed:', e2.message);
      res.status(500).json({ error: 'Could not load items', detail: e2.message });
    }
  }
});

// Data-completion dashboard (mam 2026-06-15): across ALL items, how many of
// the required fields are filled — overall %, count of fully-complete items,
// and per-field missing counts. Each item has N required fields, so the
// denominator is items × N.
router.get('/completion', requirePermission('item_master', 'view'), (req, res) => {
  // The field list moved to server/lib/dataCompletion.js (mam 2026-09-03) so the
  // bar, the same bar on Business Book / Employees / Users, and the Data Entry
  // KPI all measure the SAME thing. Response shape is unchanged.
  const { completionFor } = require('../lib/dataCompletion');
  try {
    res.json(completionFor(getDb(), 'item_master'));
  } catch (e) {
    console.error('[item-master] completion failed:', e.message);
    res.status(500).json({ error: 'Could not compute data completion' });
  }
});

// Lightweight dropdown — unchanged shape so callers don't break.
router.get('/dropdown', (req, res) => {
  const { type } = req.query;
  // Dedupe make-variants (mam 2026-06-09): the same item in 2-3 makes shows
  // as identical rows. Group to ONE row per unique item_name + specification
  // + size — make is irrelevant in pickers. Representative id = lowest; price
  // = any non-zero (reference only).
  // Use a SINGLE aggregate (MIN id) so SQLite returns item_code, uom,
  // current_price etc. from the SAME row as that min id — with two
  // aggregates the bare columns came from indeterminate rows, so the shown
  // code/unit didn't match the item (mam 2026-06-10).
  // `type` may be a single value or a comma list (e.g. 'PO,POC').
  const types = type ? String(type).split(',').map(s => s.trim()).filter(Boolean) : [];
  const where = types.length ? `WHERE type IN (${types.map(() => '?').join(',')})` : '';
  // Age the material price so the Estimator can show "rate N days old" (mam #4
  // "PP rate age"). Same rate-date logic as the Item Master list (bill/PO date,
  // else priced_at, else updated_at when a price exists). Bare-column / single
  // MIN(id) aggregate so the date comes from the same representative row.
  const ageExpr = `COALESCE(bill_po_date, priced_at, CASE WHEN current_price > 0 THEN updated_at END)`;
  const sql = `SELECT MIN(id) AS id, item_code, department, item_name, specification, size, uom, gst, type, make, current_price,
                      COALESCE(approval_status, 'approved') AS approval_status,
                      CASE WHEN ${ageExpr} IS NULL THEN NULL
                           ELSE CAST((julianday('now','localtime') - julianday(${ageExpr})) AS INTEGER) END AS age_days
                 FROM item_master ${where}
                GROUP BY LOWER(TRIM(item_name)), LOWER(TRIM(COALESCE(specification, ''))), LOWER(TRIM(COALESCE(size, '')))
                ORDER BY department, item_name`;
  const stmt = getDb().prepare(sql);
  const items = types.length ? stmt.all(...types) : stmt.all();
  res.json(items.map(i => {
    const base = [i.item_name, i.specification, i.size].filter(Boolean).join(' / ');
    // Pending items stay selectable but are flagged so pickers can show
    // they're awaiting approval (mam 2026-06-16).
    const pending = i.approval_status === 'pending';
    return { ...i, display_name: pending ? `${base} (Pending approval)` : base, age_status: ageStatus(i.age_days) };
  }));
});

// GET /template.xlsx — downloadable Excel template for bulk import
router.get('/template.xlsx', (req, res) => {
  const wb = XLSX.utils.book_new();
  const headers = [
    'Item Code', 'Department', 'Item Name', 'Specification', 'Size',
    'UOM', 'GST', 'Type', 'Make', 'Rate', 'Vendor Name',
    'Source Type', 'Bill/PO Number', 'Bill/PO Date'
  ];
  const sampleRows = [
    [
      'FF0100', 'FF', 'HYDRANT VALVE', 'SS BODY, 63MM INSTANTANEOUS', '63MM',
      'PCS', '18%', 'PO', 'AGNI', 2500, 'Agni Devices Ltd',
      'PO', 'SEPL/PO/2026/042', '2026-04-15'
    ],
    [
      '', 'ELE', 'SMOKE DETECTOR', 'OPTICAL PHOTOELECTRIC', 'STANDARD',
      'NOS', '18%', 'PO', 'SCHNEIDER', 1250, 'Schneider Electric India',
      'Quote', 'SEPL/QT/2026/101', '2026-05-10'
    ]
  ];
  const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
  ws['!cols'] = [
    { wch: 14 }, { wch: 14 }, { wch: 28 }, { wch: 32 }, { wch: 14 },
    { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 16 }, { wch: 12 }, { wch: 26 },
    { wch: 14 }, { wch: 20 }, { wch: 14 }
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Item Master');

  const instructions = [
    ['SEPL ERP — Item Master Bulk Import Guidelines'],
    [''],
    ['Column', 'Description', 'Allowed / Example Values'],
    ['Item Code', 'Unique code. Leave blank to auto-generate from Department (e.g. FF0001)', 'FF0100, ELE0045, or blank'],
    ['Department', 'Short code or name of department', 'FF, ELE, PLB, HVAC, CIVIL, SOLAR, UT'],
    ['Item Name', 'Mandatory. Full descriptive name of the item', 'HYDRANT VALVE, DIESEL PUMP'],
    ['Specification', 'Technical spec, material grade, pressure rating, etc.', 'SS 304, PN16, 220V Single Phase'],
    ['Size', 'Dimensions, diameter, length or capacity', '63MM, 25MM, 100NB, 1.5HP'],
    ['UOM', 'Unit of measurement (defaults to PCS)', 'PCS, NOS, MTR, KG, SET, LTR, PKT'],
    ['GST', 'GST tax slab (defaults to 18%)', '18%, 12%, 5%, 28%, 0%'],
    ['Type', 'Item classification (defaults to PO)', 'PO, FOC, RGP'],
    ['Make', 'Brand or manufacturer', 'AGNI, NEWAGE, TATA, SCHNEIDER'],
    ['Rate', 'Unit rate / price without currency symbol', '2500, 1250.50'],
    ['Vendor Name', 'Matched against Vendors Master (case-insensitive)', 'Agni Devices Ltd'],
    ['Source Type', 'Source of the rate', 'PO, Quote, Manual, Online, Bill'],
    ['Bill/PO Number', 'Reference PO or Bill / Invoice number', 'SEPL/PO/2026/042'],
    ['Bill/PO Date', 'Date of PO / invoice for rate aging tracking', 'YYYY-MM-DD or DD/MM/YYYY']
  ];
  const wsGuide = XLSX.utils.aoa_to_sheet(instructions);
  wsGuide['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 35 }];
  XLSX.utils.book_append_sheet(wb, wsGuide, 'Instructions');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.set('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.set('Content-Disposition', 'attachment; filename="item-master-template.xlsx"');
  res.send(buf);
});

// POST /parse-file — parses uploaded Excel (.xlsx, .xls) or CSV file and returns cleaned preview rows
router.post('/parse-file', requirePermission('item_master', 'create'), uploadMemory.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Please choose an Excel (.xlsx, .xls) or CSV file' });
  try {
    const wb = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: true });
    if (!wb.SheetNames || !wb.SheetNames.length) {
      return res.status(400).json({ error: 'No worksheets found in spreadsheet' });
    }
    const sheetName = wb.SheetNames.find(n => /item/i.test(n)) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    if (!ws) return res.status(400).json({ error: 'Spreadsheet sheet is empty' });

    const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
    if (!aoa.length) return res.status(400).json({ error: 'Spreadsheet is empty' });

    let headerIdx = -1;
    for (let i = 0; i < Math.min(10, aoa.length); i++) {
      const row = (aoa[i] || []).map(c => String(c || '').toLowerCase().trim());
      if (row.some(c => c.includes('item') || c.includes('name') || c.includes('code') || c.includes('rate') || c.includes('price') || c.includes('dept'))) {
        headerIdx = i; break;
      }
    }
    if (headerIdx === -1) headerIdx = 0;

    const headers = (aoa[headerIdx] || []).map(h => String(h || '').trim());
    const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const pick = (row, wantedList, blacklist = []) => {
      const rowKeys = Object.keys(row);
      const normWanted = wantedList.map(w => norm(w));
      const normBlacklist = blacklist.map(b => norm(b));

      // Pass 1: exact match
      for (const w of normWanted) {
        const hit = rowKeys.find(rk => norm(rk) === w);
        if (hit && row[hit] != null && String(row[hit]).trim() !== '') return String(row[hit]).trim();
      }

      // Pass 2: substring match avoiding blacklisted terms
      for (const w of normWanted) {
        const hit = rowKeys.find(rk => {
          const nrk = norm(rk);
          if (normBlacklist.some(b => nrk.includes(b))) return false;
          return nrk === w || nrk.startsWith(w) || nrk.endsWith(w) || (w.length > 3 && nrk.includes(w));
        });
        if (hit && row[hit] != null && String(row[hit]).trim() !== '') return String(row[hit]).trim();
      }
      return '';
    };

    const parseDateVal = (val) => {
      if (!val) return '';
      if (val instanceof Date && !isNaN(val)) return val.toISOString().split('T')[0];
      const s = String(val).trim();
      if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
      const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
      if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      return s;
    };

    const items = [];
    for (let i = headerIdx + 1; i < aoa.length; i++) {
      const r = aoa[i];
      if (!r || !Array.isArray(r) || r.every(c => c === '' || c == null)) continue;
      const rowObj = {};
      headers.forEach((h, idx) => { if (h) rowObj[h] = r[idx]; });

      const itemName = pick(rowObj, ['itemname', 'itemdescription', 'description', 'particulars', 'productname', 'materialname', 'name'], ['code', 'dept', 'vendor', 'party', 'supplier', 'rate', 'price', 'cost', 'make', 'brand', 'uom', 'unit', 'gst', 'tax', 'date']);
      if (!itemName) continue;
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(itemName)) continue;

      const rawPrice = pick(rowObj, ['rate', 'price', 'currentprice', 'unitprice', 'cost', 'unitrate', 'rateinr', 'priceinr'], ['tax', 'gst']);
      const cleanPrice = parseFloat(String(rawPrice || '').replace(/,/g, '')) || 0;

      items.push({
        item_code: pick(rowObj, ['itemcode', 'code', 'productcode', 'partnumber', 'partno', 'itemno'], ['name', 'dept', 'rate', 'price', 'desc']),
        department: pick(rowObj, ['department', 'dept', 'category'], ['code', 'name', 'rate', 'price']),
        item_name: itemName,
        specification: pick(rowObj, ['specification', 'spec', 'specs', 'technicalspec', 'details'], ['name', 'code', 'rate']),
        size: pick(rowObj, ['size', 'dimensions', 'dimension', 'capacity'], ['name', 'code', 'rate']),
        uom: pick(rowObj, ['uom', 'unit', 'unitofmeasurement'], ['price', 'rate', 'cost']) || 'PCS',
        gst: pick(rowObj, ['gst', 'gstpercent', 'tax', 'taxrate'], []),
        type: (() => {
          const rawT = pick(rowObj, ['type', 'itemtype', 'classification'], ['sourcetype']);
          const upper = String(rawT || '').trim().toUpperCase();
          if (upper === 'MATERIAL MASTER' || upper === 'MATERIAL' || upper === 'MATERIAL_MASTER') return 'PO';
          return rawT;
        })(),
        make: pick(rowObj, ['make', 'brand', 'manufacturer'], []),
        current_price: cleanPrice,
        vendor_name: pick(rowObj, ['vendorname', 'vendor', 'supplier', 'suppliername', 'party'], []),
        source_type: pick(rowObj, ['sourcetype', 'source', 'ratesource'], []) || 'Manual',
        bill_po_number: pick(rowObj, ['billponumber', 'billno', 'pono', 'billnumber', 'ponumber', 'invoiceno', 'invoicenumber'], ['date']),
        bill_po_date: parseDateVal(pick(rowObj, ['billpodate', 'billdate', 'podate', 'invoicedate', 'date'], ['number', 'no']))
      });
    }

    res.json({
      items,
      total: items.length,
      fileName: req.file.originalname,
      sheetName
    });
  } catch (err) {
    res.status(400).json({ error: 'Could not read file: ' + err.message });
  }
});

// Single item — same shape as list, including age.
router.get('/:id', requirePermission('item_master', 'view'), (req, res) => {
  const item = getDb().prepare(`
    SELECT im.*, v.name AS vendor_name, u.name AS priced_by_name,
           CASE WHEN ${AGE_DATE_EXPR} IS NULL THEN NULL
                ELSE CAST((julianday('now','localtime') - julianday(${AGE_DATE_EXPR})) AS INTEGER)
           END AS age_days
      FROM item_master im
      LEFT JOIN vendors v ON v.id = im.vendor_id
      LEFT JOIN users u ON u.id = im.priced_by
     WHERE im.id = ?
  `).get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  res.json({ ...item, age_status: ageStatus(item.age_days) });
});

// Price history for a single item — every prior captured price plus the
// vendor / source / bill that justified it.
router.get('/:id/price-history', requirePermission('item_master', 'view'), (req, res) => {
  const rows = getDb().prepare(`
    SELECT iph.*, v.name AS vendor_name
      FROM item_price_history iph
      LEFT JOIN vendors v ON v.id = iph.vendor_id
     WHERE iph.item_id = ?
     ORDER BY iph.created_at DESC
  `).all(req.params.id);
  res.json(rows);
});

// Helper — when the price (or its provenance) changes, snapshot the
// OLD row into item_price_history before overwriting. Never deletes.
function snapshotCurrentPrice(db, oldRow, actor) {
  if (!oldRow) return;
  // Only snapshot if there's a meaningful current price worth keeping.
  if (!(oldRow.current_price > 0)) return;
  db.prepare(`
    INSERT INTO item_price_history
      (item_id, rate, quantity, source, source_type, vendor_id,
       bill_po_number, bill_po_date, created_by, created_by_name, created_at)
    VALUES (?, ?, 0, 'item_master_edit', ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))
  `).run(
    oldRow.id,
    +oldRow.current_price || 0,
    oldRow.source_type || null,
    oldRow.vendor_id || null,
    oldRow.bill_po_number || null,
    oldRow.bill_po_date || null,
    oldRow.priced_by || actor?.id || null,
    actor?.name || null,
    oldRow.priced_at || oldRow.updated_at || null,
  );
}

// Update just the item identity (name / specification / make) — a SAFE partial
// update for the Inventory row edit (mam 2026-06-30: "edit item name also").
// Avoids the full PUT /:id, which would blank the other columns when not sent.
router.patch('/:id/identity', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const cur = db.prepare('SELECT item_name, specification, make FROM item_master WHERE id=?').get(req.params.id);
  if (!cur) return res.status(404).json({ error: 'Item not found' });
  const item_name = (b.item_name != null && String(b.item_name).trim()) ? String(b.item_name).trim() : cur.item_name;
  const specification = (b.specification !== undefined) ? String(b.specification || '') : cur.specification;
  const make = (b.make !== undefined) ? String(b.make || '') : cur.make;
  db.prepare('UPDATE item_master SET item_name=?, specification=?, make=?, updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(item_name, specification, make, req.params.id);
  res.json({ ok: true });
});

// Inline price patch (Inventory page uses this). Snapshots history.
router.patch('/:id/price', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const price = +req.body?.current_price;
  if (!(price >= 0)) return res.status(400).json({ error: 'Price must be a positive number' });
  snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET current_price = ?,
           source_type = COALESCE(?, source_type, 'Manual'),
           priced_at = CURRENT_TIMESTAMP,
           priced_by = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(price, req.body?.source_type || null, req.user.id, req.params.id);
  res.json({ message: 'Price updated', current_price: price });
});

// ─── Item approval (TSK-0470 - Ankur Kaplesh: "item approval must be from AI agent only") ─
// Approvals are handled strictly by the AI Agent (audits nomenclature, duplicates, UOM, specs & price).
const { auditItemWithAi, getAiAgentUserId } = require('../lib/itemAiApproval');

const adminOnly = (req, res, next) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Only an Admin can trigger item approval audits' });
  next();
};

// Count of pending items — lets the page show a badge without fetching all.
router.get('/approval/pending-count', (req, res) => {
  const n = getDb().prepare(`SELECT COUNT(*) AS n FROM item_master WHERE approval_status='pending'`).get().n;
  res.json({ pending: n });
});

// Approve/Audit everything currently pending using the AI Agent
router.post('/approval/approve-all', adminOnly, async (req, res) => {
  try {
    const db = getDb();
    const pending = db.prepare("SELECT id FROM item_master WHERE approval_status='pending'").all();
    if (!pending.length) {
      return res.json({ message: 'No items currently pending approval', approved: 0, rejected: 0 });
    }
    let approved = 0, rejected = 0;
    const details = [];
    for (const p of pending) {
      try {
        const verdict = await auditItemWithAi(p, db);
        if (verdict.approved) approved++; else rejected++;
        details.push({ id: p.id, approved: verdict.approved, reason: verdict.reason });
      } catch (err) {
        rejected++;
        details.push({ id: p.id, approved: false, reason: err.message });
      }
    }
    res.json({
      message: `AI Agent audited ${pending.length} item(s): ${approved} approved, ${rejected} rejected`,
      approved,
      rejected,
      details
    });
  } catch (err) {
    res.status(500).json({ error: 'AI Agent audit failed: ' + err.message });
  }
});

// Single item audit & approval by AI Agent
router.post('/:id/approve', adminOnly, async (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT id FROM item_master WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const verdict = await auditItemWithAi(item, db);
    res.json({
      message: verdict.reason,
      approval_status: verdict.approved ? 'approved' : 'rejected',
      verdict
    });
  } catch (err) {
    res.status(500).json({ error: 'AI Agent audit failed: ' + err.message });
  }
});

router.post('/:id/ai-audit', adminOnly, async (req, res) => {
  try {
    const db = getDb();
    const item = db.prepare('SELECT id FROM item_master WHERE id=?').get(req.params.id);
    if (!item) return res.status(404).json({ error: 'Not found' });
    const verdict = await auditItemWithAi(item, db);
    res.json({
      message: verdict.reason,
      approval_status: verdict.approved ? 'approved' : 'rejected',
      verdict
    });
  } catch (err) {
    res.status(500).json({ error: 'AI Agent audit failed: ' + err.message });
  }
});

// Rejecting with mandatory remark (stamped with AI Agent / Admin audit record)
router.post('/:id/reject', adminOnly, (req, res) => {
  const db = getDb();
  const reason = String(req.body?.reason || '').trim();
  if (!reason) return res.status(400).json({ error: 'Rejection remark is required' });
  const item = db.prepare('SELECT id FROM item_master WHERE id=?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const aiUserId = getAiAgentUserId(db) || req.user.id;
  db.prepare(`UPDATE item_master
                 SET approval_status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, rejection_reason=?, ai_audit_notes=?, updated_at=CURRENT_TIMESTAMP
               WHERE id=?`).run(aiUserId, reason, reason, req.params.id);
  res.json({ message: 'Item rejected', approval_status: 'rejected', rejection_reason: reason });
});

router.post('/', requirePermission('item_master', 'create'), async (req, res) => {
  const b = req.body || {};
  if (!b.item_name) return res.status(400).json({ error: 'Item name required' });

  // Mam (2026-05-21): same item name + size + spec = same item.  This
  // matches the dedupe rule the master-sheet cleanup script used
  // (server/scripts/itemMasterCleanup.js).  Catches "MS PIPE 25mm
  // C-CLASS" being added twice with slight whitespace differences.
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  const dup = findDuplicate(getDb(), {
    table: 'item_master',
    fields: {
      item_name: b.item_name,
      size: b.size || '',
      specification: b.specification || '',
    },
    codeColumn: 'item_code',
  });
  if (sendDuplicate(res, dup, `Item "${b.item_name}"${b.size ? ' · ' + b.size : ''}`)) return;

  let code = b.item_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    const dept = (b.department || 'GEN').toUpperCase().substring(0, 3);
    code = nextSequence(getDb(), 'item_master', 'item_code', dept, { startFrom: 0, pad: 4 });
  }
  const sourceType = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : 'Manual';
  const price = +b.current_price || 0;
  // Mam (2026-06-16): a new item entered from anywhere starts as PENDING
  // and must be approved by an Admin before it counts as "correct".
  // Admins who add an item approve it on the spot (no point making them
  // approve their own entry).
  const isAdmin = req.user.role === 'admin';
  const r = getDb().prepare(`
    INSERT INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make, model_number,
       current_price, catalogue_link, photo_link,
       vendor_id, source_type, bill_po_number, bill_po_date,
       weight_per_meter, weight_per_pipe, pipe_length_m,
       priced_at, priced_by,
       approval_status, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    code, b.department, b.item_name, b.specification, b.size,
    b.uom || 'PCS', b.gst || '18%', b.type || 'PO', b.make, b.model_number,
    price, b.catalogue_link, b.photo_link,
    b.vendor_id || null, sourceType, b.bill_po_number || null, b.bill_po_date || null,
    (b.weight_per_meter === '' || b.weight_per_meter == null) ? null : (+b.weight_per_meter || null),
    (b.weight_per_pipe === '' || b.weight_per_pipe == null) ? null : (+b.weight_per_pipe || null),
    (b.pipe_length_m === '' || b.pipe_length_m == null) ? null : (+b.pipe_length_m || null),
    price > 0 ? new Date().toISOString() : null,
    price > 0 ? req.user.id : null,
    'pending',
    null,
    null
  );
  const newId = r.lastInsertRowid;
  // TSK-0470: Trigger immediate AI Agent audit upon creation
  let aiVerdict = null;
  try {
    aiVerdict = await auditItemWithAi({ id: newId }, getDb());
  } catch (err) {
    console.warn('[itemmaster] immediate AI audit failed, item remains pending:', err.message);
  }
  const finalStatus = aiVerdict?.approved ? 'approved' : (aiVerdict ? 'rejected' : 'pending');
  res.status(201).json({
    id: newId,
    item_code: code,
    approval_status: finalStatus,
    ai_verdict: aiVerdict
  });
});

router.put('/:id', requirePermission('item_master', 'edit'), (req, res) => {
  const db = getDb();
  const old = db.prepare('SELECT * FROM item_master WHERE id=?').get(req.params.id);
  if (!old) return res.status(404).json({ error: 'Not found' });
  const b = req.body || {};
  const newPrice = +b.current_price || 0;
  const newVendor = b.vendor_id || null;
  const newSource = ALLOWED_SOURCES.includes(b.source_type) ? b.source_type : (old.source_type || 'Manual');
  const newBillNo = b.bill_po_number || null;
  const newBillDate = b.bill_po_date || null;
  // Detect "price provenance changed" — any of: rate, vendor, source,
  // bill number, bill date. If yes, snapshot old + bump priced_at.
  const priceProvenanceChanged =
    (+old.current_price || 0) !== newPrice ||
    (old.vendor_id || null) !== newVendor ||
    (old.source_type || null) !== newSource ||
    (old.bill_po_number || null) !== newBillNo ||
    (old.bill_po_date || null) !== newBillDate;
  if (priceProvenanceChanged) snapshotCurrentPrice(db, old, req.user);
  db.prepare(`
    UPDATE item_master
       SET item_code = ?, department = ?, item_name = ?, specification = ?, size = ?,
           uom = ?, gst = ?, type = ?, make = ?, model_number = ?,
           current_price = ?, catalogue_link = ?, photo_link = ?,
           vendor_id = ?, source_type = ?, bill_po_number = ?, bill_po_date = ?,
           weight_per_meter = ?, weight_per_pipe = ?, pipe_length_m = ?,
           priced_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE priced_at END,
           priced_by = CASE WHEN ? THEN ? ELSE priced_by END,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?
  `).run(
    b.item_code, b.department, b.item_name, b.specification, b.size,
    b.uom, b.gst, b.type, b.make, b.model_number,
    newPrice, b.catalogue_link, b.photo_link,
    newVendor, newSource, newBillNo, newBillDate,
    (b.weight_per_meter === '' || b.weight_per_meter == null) ? null : (+b.weight_per_meter || null),
    (b.weight_per_pipe === '' || b.weight_per_pipe == null) ? null : (+b.weight_per_pipe || null),
    (b.pipe_length_m === '' || b.pipe_length_m == null) ? null : (+b.pipe_length_m || null),
    priceProvenanceChanged ? 1 : 0,
    priceProvenanceChanged ? 1 : 0, req.user.id,
    req.params.id,
  );
  res.json({ message: 'Updated', price_history_snapshot: priceProvenanceChanged });
});

router.delete('/:id', requirePermission('item_master', 'delete'), (req, res) => {
  getDb().prepare('DELETE FROM item_master WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Bulk import — extended CSV header so MD's CSV template can carry
// vendor + source + bill data. New columns are optional; old templates
// still work.
router.post('/bulk', requirePermission('item_master', 'create'), (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) return res.status(400).json({ error: 'No data' });
  const updateExisting = req.body?.update_existing === true || req.body?.updateExisting === true;
  const db = getDb();
  // Resolve vendor name → id at import time so the CSV can carry a name.
  const vendorByName = new Map(
    db.prepare('SELECT id, LOWER(TRIM(name)) AS k FROM vendors').all().map(r => [r.k, r.id])
  );
  const insert = db.prepare(`
    INSERT INTO item_master
      (item_code, department, item_name, specification, size, uom, gst, type, make,
       current_price, vendor_id, source_type, bill_po_number, bill_po_date,
       priced_at, priced_by, approval_status, approved_by, approved_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const update = db.prepare(`
    UPDATE item_master SET
      department = CASE WHEN ? != '' THEN ? ELSE department END,
      item_name = CASE WHEN ? != '' THEN ? ELSE item_name END,
      specification = CASE WHEN ? != '' THEN ? ELSE specification END,
      size = CASE WHEN ? != '' THEN ? ELSE size END,
      uom = CASE WHEN ? != '' THEN ? ELSE uom END,
      gst = CASE WHEN ? != '' THEN ? ELSE gst END,
      type = CASE WHEN ? != '' THEN ? ELSE type END,
      make = CASE WHEN ? != '' THEN ? ELSE make END,
      current_price = CASE WHEN ? > 0 THEN ? ELSE current_price END,
      vendor_id = CASE WHEN ? IS NOT NULL THEN ? ELSE vendor_id END,
      source_type = CASE WHEN ? IS NOT NULL THEN ? ELSE source_type END,
      bill_po_number = CASE WHEN ? IS NOT NULL THEN ? ELSE bill_po_number END,
      bill_po_date = CASE WHEN ? IS NOT NULL THEN ? ELSE bill_po_date END,
      priced_at = CASE WHEN ? > 0 THEN ? ELSE priced_at END,
      priced_by = CASE WHEN ? > 0 THEN ? ELSE priced_by END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  const findExisting = db.prepare('SELECT * FROM item_master WHERE item_code = ?');
  const { nextSequence } = require('../db/nextSequence');
  const isAdmin = req.user.role === 'admin';
  let added = 0, updated = 0, skipped = 0;
  const errors = [];

  const runBulk = db.transaction(() => {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.item_name || !String(it.item_name).trim()) {
        errors.push(`Row ${i + 1}: Item name required`);
        skipped++;
        continue;
      }
      if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(String(it.item_name))) {
        errors.push(`Row ${i + 1}: Corrupted binary data in item name (upload as .xlsx or .csv)`);
        skipped++;
        continue;
      }
      try {
        const vendorId = it.vendor_id != null
          ? +it.vendor_id || null
          : (it.vendor_name ? vendorByName.get(String(it.vendor_name).trim().toLowerCase()) || null : null);
        const source = it.source_type && String(it.source_type).trim() ? String(it.source_type).trim() : 'Manual';
        const price = +it.current_price || 0;
        let code = it.item_code && String(it.item_code).trim();
        const existing = code ? findExisting.get(code) : null;
        const rawType = String(it.type || '').trim().toUpperCase();
        const normalizedType = (rawType === 'MATERIAL MASTER' || rawType === 'MATERIAL' || rawType === 'MATERIAL_MASTER')
          ? 'PO'
          : (it.type || 'PO');

        if (existing) {
          if (updateExisting) {
            if (price > 0 && price !== existing.current_price) {
              snapshotCurrentPrice(db, existing, req.user);
            }
            const dept = it.department || '';
            const name = String(it.item_name).trim();
            const spec = it.specification || '';
            const size = it.size || '';
            const uom = it.uom || 'PCS';
            const gst = it.gst || '18%';
            const type = normalizedType;
            const make = it.make || '';
            update.run(
              dept, dept,
              name, name,
              spec, spec,
              size, size,
              uom, uom,
              gst, gst,
              type, type,
              make, make,
              price, price,
              vendorId, vendorId,
              source, source,
              it.bill_po_number || null, it.bill_po_number || null,
              it.bill_po_date || null, it.bill_po_date || null,
              price, price > 0 ? new Date().toISOString() : null,
              price, price > 0 ? req.user.id : null,
              existing.id
            );
            updated++;
          } else {
            skipped++;
            errors.push(`Row ${i + 1}: "${it.item_name}" — code "${code}" already exists, skipped`);
          }
        } else {
          if (!code) {
            const dept = (it.department || 'GEN').toUpperCase().substring(0, 3);
            code = nextSequence(db, 'item_master', 'item_code', dept, { startFrom: 0, pad: 4 });
          }
          const r = insert.run(
            code, it.department || '', String(it.item_name).trim(),
            it.specification || '', it.size || '', it.uom || 'PCS',
            it.gst || '18%', normalizedType, it.make || '',
            price, vendorId, source, it.bill_po_number || null, it.bill_po_date || null,
            price > 0 ? new Date().toISOString() : null,
            price > 0 ? req.user.id : null,
            isAdmin ? 'approved' : 'pending',
            isAdmin ? req.user.id : null,
            isAdmin ? new Date().toISOString() : null
          );
          if (r.changes > 0) added++;
          else { skipped++; errors.push(`Row ${i + 1}: "${it.item_name}" — code "${code}" already exists, skipped`); }
        }
      } catch (err) {
        skipped++;
        errors.push(`Row ${i + 1}: ${err.message}`);
      }
    }
  });

  try {
    runBulk();
  } catch (txErr) {
    return res.status(500).json({ error: 'Database bulk transaction failed: ' + txErr.message });
  }

  res.json({ added, updated, skipped, errors, total: items.length });
});

module.exports = router;
