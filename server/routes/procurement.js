const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Shared upload directory (served statically by server/index.js at /uploads).
// Used by both the Tally PO upload and the BOQ bulk upload lower in this file.
const uploadDir = path.join(__dirname, '..', '..', 'data', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Multer for Vendor PO file uploads (PDF / images / Excel), up to 10 MB.
const vendorPoUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Same lenient Excel-BOQ parser the Orders upload uses — kept in sync here
// so we can fall back to the raw file when po_items is empty.
const parseBoqExcel = (filePath) => {
  try {
    const wb = XLSX.readFile(filePath);
    const parseNum = (v) => {
      if (v === null || v === undefined || v === '') return 0;
      if (typeof v === 'number') return v;
      const c = String(v).replace(/[,\s]/g, '').match(/-?\d+(\.\d+)?/);
      return c ? parseFloat(c[0]) : 0;
    };
    const HEADER_KW = ['item name', 'description', 'particulars', 'work', 'item', 'qty', 'qnty', 'quantity', 'sitc', 'rate', 'amount', 's/n', 's.no'];
    const parseSheet = (sn) => {
      const ws = wb.Sheets[sn];
      if (!ws) return [];
      const data = XLSX.utils.sheet_to_json(ws, { header: 1 });
      let headerIdx = -1;
      for (let i = 0; i < Math.min(20, data.length); i++) {
        const row = (data[i] || []).map(c => String(c || '').toLowerCase().trim());
        const m = HEADER_KW.filter(k => row.some(c => c === k || c.includes(k))).length;
        if (m >= 2) { headerIdx = i; break; }
      }
      if (headerIdx === -1) return [];
      const headers = (data[headerIdx] || []).map(h => String(h || '').toLowerCase().trim());
      const colMap = {};
      headers.forEach((h, i) => {
        if (colMap.name === undefined && (h.includes('item name') || h.includes('description') || h.includes('particulars') || h === 'work' || h.includes('work description') || h === 'item' || h === 'items')) colMap.name = i;
        if (colMap.qty === undefined && (h === 'qty' || h === 'quantity' || h === 'qnty' || h.includes('qty') || h.includes('qnty') || h.includes('quantity') || h === 'nos')) colMap.qty = i;
        if (colMap.unit === undefined && (h === 'unit' || h === 'uom' || h.includes('unit') || h === 'units')) colMap.unit = i;
      });
      if (colMap.qty !== undefined && colMap.unit === undefined) {
        const uc = colMap.qty + 1;
        const UL = /^(mtr|nos|set|kg|sqm|rft|pair|pcs?|no|lot|unit|ltr|ton|bag|rmt|cum|sft|box|roll|feet|ft|mm|inch)\.?$/i;
        let matches = 0;
        for (let i = headerIdx + 1; i < Math.min(headerIdx + 40, data.length); i++) {
          const v = String((data[i] || [])[uc] || '').trim();
          if (v && UL.test(v)) matches++;
        }
        if (matches >= 2) colMap.unit = uc;
      }
      if (colMap.name === undefined) return [];
      const out = [];
      let sr = 1;
      for (let i = headerIdx + 1; i < data.length; i++) {
        const row = data[i] || [];
        const name = String(row[colMap.name] || '').trim();
        if (!name || name.length < 3) continue;
        const qty = colMap.qty !== undefined ? parseNum(row[colMap.qty]) : 0;
        if (qty === 0) continue;
        const unit = colMap.unit !== undefined ? String(row[colMap.unit] || 'Nos').trim() : 'Nos';
        out.push({ id: `fallback-${sn}-${sr}`, description: name, unit: unit || 'nos', boq_qty: qty, item_master_id: null, item_code: null, item_type: null, item_make: null, indented_qty: 0, remaining_qty: qty, is_foc: false });
        sr++;
      }
      return out;
    };
    // Pick the sheet that yields most rows (offer Excels often put BOQ in sheet 2)
    let best = [];
    for (const sn of wb.SheetNames) {
      const rows = parseSheet(sn);
      if (rows.length > best.length) best = rows;
    }
    return best;
  } catch (e) { return []; }
};

// Vendors
router.get('/vendors', (req, res) => {
  res.json(getDb().prepare('SELECT * FROM vendors WHERE active=1 ORDER BY name').all());
});

router.post('/vendors', (req, res) => {
  const b = req.body;
  if (!b.name) return res.status(400).json({ error: 'Vendor name required' });
  const db = getDb();
  // Auto-generate vendor code if empty
  let code = b.vendor_code;
  if (!code) {
    const count = db.prepare('SELECT COUNT(*) as c FROM vendors').get().c;
    code = `SEVC${String(count + 2000).padStart(4, '0')}`;
  }
  const r = db.prepare('INSERT OR IGNORE INTO vendors (vendor_code,name,firm_name,contact_person,phone,email,district,state,address,category,deals_in,authorized_dealer,type,turnover,team_size,payment_terms,credit_days,gst_number,source,category_wise,sub_category,existing_vendor) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(code, b.name, b.firm_name, b.contact_person, b.phone, b.email, b.district, b.state, b.address, b.category, b.deals_in, b.authorized_dealer, b.type, b.turnover, b.team_size, b.payment_terms, b.credit_days, b.gst_number, b.source, b.category_wise, b.sub_category, b.existing_vendor);
  res.status(201).json({ id: r.lastInsertRowid, vendor_code: code });
});

router.put('/vendors/:id', (req, res) => {
  const b = req.body;
  getDb().prepare('UPDATE vendors SET vendor_code=?,name=?,firm_name=?,contact_person=?,phone=?,email=?,district=?,state=?,address=?,category=?,deals_in=?,authorized_dealer=?,type=?,turnover=?,team_size=?,payment_terms=?,credit_days=?,gst_number=?,source=?,sub_category=?,active=? WHERE id=?')
    .run(b.vendor_code, b.name, b.firm_name, b.contact_person, b.phone, b.email, b.district, b.state, b.address, b.category, b.deals_in, b.authorized_dealer, b.type, b.turnover, b.team_size, b.payment_terms, b.credit_days, b.gst_number, b.source, b.sub_category, b.active !== undefined ? (b.active ? 1 : 0) : 1, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/vendors/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const uses = db.prepare(`SELECT
    (SELECT COUNT(*) FROM vendor_pos WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM purchase_bills WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM indent_items WHERE vendor_id=?) +
    (SELECT COUNT(*) FROM vendor_rates WHERE vendor1_id=? OR vendor2_id=? OR vendor3_id=? OR selected_vendor_id=?) as c`
  ).get(id, id, id, id, id, id, id).c;
  if (uses > 0) return res.status(409).json({ error: 'Cannot delete: vendor is referenced by POs, bills, indents or rate comparisons' });
  db.prepare('DELETE FROM vendors WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Vendor Rate Comparison
router.get('/vendor-rates', (req, res) => {
  const { planning_id } = req.query;
  let sql = `SELECT vr.*, v1.name as vendor1_name, v2.name as vendor2_name, v3.name as vendor3_name, sv.name as selected_vendor_name
    FROM vendor_rates vr LEFT JOIN vendors v1 ON vr.vendor1_id=v1.id LEFT JOIN vendors v2 ON vr.vendor2_id=v2.id
    LEFT JOIN vendors v3 ON vr.vendor3_id=v3.id LEFT JOIN vendors sv ON vr.selected_vendor_id=sv.id`;
  if (planning_id) sql += ` WHERE vr.planning_id=${planning_id}`;
  sql += ' ORDER BY vr.created_at DESC';
  res.json(getDb().prepare(sql).all());
});

router.post('/vendor-rates', (req, res) => {
  const { planning_id, item_description, vendor1_id, vendor1_rate, vendor2_id, vendor2_rate, vendor3_id, vendor3_rate, final_rate, selected_vendor_id } = req.body;
  const r = getDb().prepare(
    'INSERT INTO vendor_rates (planning_id,item_description,vendor1_id,vendor1_rate,vendor2_id,vendor2_rate,vendor3_id,vendor3_rate,final_rate,selected_vendor_id) VALUES (?,?,?,?,?,?,?,?,?,?)'
  ).run(planning_id, item_description, vendor1_id, vendor1_rate, vendor2_id, vendor2_rate, vendor3_id, vendor3_rate, final_rate, selected_vendor_id);
  res.status(201).json({ id: r.lastInsertRowid });
});

router.delete('/vendor-rates/:id', (req, res) => {
  getDb().prepare('DELETE FROM vendor_rates WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

router.put('/vendor-rates/:id/approve', (req, res) => {
  const { approval_status, approved_by } = req.body;
  getDb().prepare('UPDATE vendor_rates SET approval_status=?, approved_by=? WHERE id=?')
    .run(approval_status, approved_by || req.user.name, req.params.id);
  res.json({ message: 'Updated' });
});

// Indents
// Sites for the indent "Site Name" dropdown. mam's rule: show each company
// exactly once (CONSERN PHARMA even though there are 10 BB entries for it).
// The BOQ/PO-items lookup aggregates across ALL matching BBs for that name,
// so picking "CONSERN PHARMA" pulls items from every project with that
// company/site/project name. We return a representative lead_no (the latest)
// just so the dropdown can show '[SEPL20227] CONSERN PHARMA' as a hint.
router.get('/sites', (req, res) => {
  const rows = getDb().prepare(
    `SELECT name, MAX(lead_no) as lead_no
     FROM (
       SELECT COALESCE(s.name, bb.project_name, bb.company_name) as name,
              bb.lead_no as lead_no
       FROM business_book bb
       LEFT JOIN sites s ON s.business_book_id = bb.id
       WHERE COALESCE(s.name, bb.project_name, bb.company_name) IS NOT NULL
         AND TRIM(COALESCE(s.name, bb.project_name, bb.company_name)) != ''
     )
     GROUP BY LOWER(TRIM(name))
     ORDER BY name COLLATE NOCASE`
  ).all();
  res.json(rows);
});

// BOQ items by business_book_id — used when the indent raiser picks a
// specific project row (preferred over site_name because names collide
// when mam has multiple projects for the same client).
// BOQ items for a specific project (business_book). Tries, in order:
//   1. po_items saved for this exact bb_id
//   2. Parse boq_file_link of this project's PO from disk
//   3. po_items saved for another project with the SAME company name / project
//      (mam has 10+ CONSERN PHARMA projects and often uploads BOQ once,
//       uses it for all — so we auto-borrow from a sibling project)
//   4. Parse boq_file_link of any sibling project's PO
// Returns { items, diagnostic } — diagnostic is optional when items load
// from the happy path, and informational (e.g. 'borrowed_from') when
// items come from a sibling so the UI can show it clearly.
router.get('/boq-items-by-bb', (req, res) => {
  const bbId = parseInt(req.query.bb_id, 10);
  if (!bbId) return res.status(400).json({ error: 'bb_id is required' });
  const db = getDb();

  const decorate = (rows) => rows.map(r => {
    const isFoc = String(r.item_type || '').toUpperCase() === 'FOC';
    return { ...r, is_foc: isFoc, remaining_qty: isFoc ? null : Math.max(0, (r.boq_qty || 0) - (r.indented_qty || 0)) };
  });
  const fetchPoItems = (bb) => db.prepare(
    `SELECT pi.id, pi.description, pi.unit, pi.quantity as boq_qty, pi.rate as boq_rate,
            pi.item_master_id, im.item_code, im.type as item_type, im.make as item_make,
            COALESCE((SELECT SUM(ii.quantity) FROM indent_items ii WHERE ii.po_item_id = pi.id), 0) as indented_qty
     FROM po_items pi
     LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE pi.business_book_id = ?
     ORDER BY pi.id`
  ).all(bb);
  const latestPoFor = (bb) => db.prepare(
    `SELECT id, po_number, boq_file_link FROM purchase_orders
     WHERE business_book_id = ? ORDER BY created_at DESC LIMIT 1`
  ).get(bb);
  const tryFileParse = (po) => {
    if (!po?.boq_file_link) return null;
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!fs.existsSync(diskPath)) return null;
    const parsed = parseBoqExcel(diskPath);
    return parsed.length > 0 ? parsed : null;
  };

  // 1. This project's po_items
  const own = fetchPoItems(bbId);
  if (own.length > 0) return res.json({ items: decorate(own) });

  // 2. This project's BOQ Excel on disk
  const ownPo = latestPoFor(bbId);
  const ownParsed = tryFileParse(ownPo);
  if (ownParsed) return res.json({ items: ownParsed, diagnostic: { reason: 'fallback_parsed', po_number: ownPo.po_number, message: 'Items loaded from this project\'s BOQ file.' } });

  // 3. Sibling project's po_items (same company/project name)
  const meta = db.prepare('SELECT company_name, project_name, lead_no FROM business_book WHERE id=?').get(bbId);
  if (meta) {
    const sibling = db.prepare(
      `SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, COUNT(pi.id) as item_count
       FROM business_book bb
       JOIN po_items pi ON pi.business_book_id = bb.id
       WHERE bb.id != ?
         AND (LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
           OR LOWER(TRIM(bb.project_name)) = LOWER(TRIM(?)))
       GROUP BY bb.id
       ORDER BY item_count DESC
       LIMIT 1`
    ).get(bbId, meta.company_name || '', meta.project_name || '');
    if (sibling) {
      const borrowed = fetchPoItems(sibling.id);
      return res.json({
        items: decorate(borrowed),
        diagnostic: {
          reason: 'borrowed_from_sibling',
          source_lead_no: sibling.lead_no,
          source_project: sibling.project_name || sibling.company_name,
          message: `No BOQ uploaded for this project yet — showing ${borrowed.length} items from sibling project [${sibling.lead_no}] ${sibling.project_name || sibling.company_name}. Upload this project's own BOQ to override.`,
        },
      });
    }

    // 4. Sibling project's BOQ Excel on disk
    const siblingWithFile = db.prepare(
      `SELECT bb.id, bb.lead_no, bb.project_name, bb.company_name, po.po_number, po.boq_file_link
       FROM business_book bb
       JOIN purchase_orders po ON po.business_book_id = bb.id
       WHERE bb.id != ?
         AND po.boq_file_link IS NOT NULL AND po.boq_file_link != ''
         AND (LOWER(TRIM(bb.company_name)) = LOWER(TRIM(?))
           OR LOWER(TRIM(bb.project_name)) = LOWER(TRIM(?)))
       ORDER BY po.created_at DESC LIMIT 1`
    ).get(bbId, meta.company_name || '', meta.project_name || '');
    const siblingParsed = tryFileParse(siblingWithFile);
    if (siblingParsed) {
      return res.json({
        items: siblingParsed,
        diagnostic: {
          reason: 'borrowed_from_sibling_file',
          source_lead_no: siblingWithFile.lead_no,
          source_project: siblingWithFile.project_name || siblingWithFile.company_name,
          message: `Items loaded from sibling project [${siblingWithFile.lead_no}] ${siblingWithFile.project_name || siblingWithFile.company_name}'s BOQ file.`,
        },
      });
    }
  }

  // Nothing found anywhere
  return res.json({
    items: [],
    diagnostic: {
      reason: ownPo ? (ownPo.boq_file_link ? 'boq_parse_empty' : 'no_boq_file') : 'no_po',
      po_number: ownPo?.po_number,
      message: ownPo
        ? (ownPo.boq_file_link
          ? `PO ${ownPo.po_number} has a BOQ file but parsing returned no items.`
          : `No BOQ uploaded yet for this project or any sibling project with the same name.`)
        : 'No BOQ uploaded yet for this project or any sibling project with the same name.',
    },
  });
});

// BOQ items for a given site — the "item wise sheet" mam referred to.
// Lookup order so BOQs are found even when the sites row isn't explicitly
// linked to a business_book (DPR can create sites without that FK):
//   1. sites.business_book_id where sites.name = X
//   2. business_book rows whose project_name / company_name = X
// For each BOQ line we compute:
//   - boq_qty       = po_items.quantity
//   - indented_qty  = sum of qty already indented against this line
//   - remaining_qty = boq_qty − indented_qty, but null for FOC items so
//                     the UI can hide the number (free items don't track)
router.get('/boq-items', (req, res) => {
  const siteName = String(req.query.site_name || '').trim();
  if (!siteName) return res.status(400).json({ error: 'site_name is required' });
  const db = getDb();

  // Case-insensitive, whitespace-tolerant matching — mam's names often differ
  // by case ('CONSERN PHARMA' in sites vs 'Consern Pharma' in business_book).
  const bbIds = new Set();
  db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL`
  ).all(siteName).forEach(r => bbIds.add(r.business_book_id));
  db.prepare(
    `SELECT id FROM business_book
     WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
        OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
        OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))`
  ).all(siteName, siteName, siteName).forEach(r => bbIds.add(r.id));

  if (bbIds.size === 0) {
    return res.json({
      items: [],
      diagnostic: { site_name: siteName, reason: 'no_business_book', message: `No Business Book entry matches "${siteName}". Check the site name in Business Book.` },
    });
  }
  const idList = [...bbIds];
  const placeholders = idList.map(() => '?').join(',');
  const items = db.prepare(
    `SELECT pi.id, pi.description, pi.unit, pi.quantity as boq_qty, pi.rate as boq_rate,
            pi.item_master_id, im.item_code, im.type as item_type, im.make as item_make,
            COALESCE((SELECT SUM(ii.quantity) FROM indent_items ii WHERE ii.po_item_id = pi.id), 0) as indented_qty
     FROM po_items pi
     LEFT JOIN item_master im ON im.id = pi.item_master_id
     WHERE pi.business_book_id IN (${placeholders})
     ORDER BY pi.id`
  ).all(...idList);

  // Fallback — if no po_items rows but the PO has a BOQ file attached, parse
  // that Excel on the fly. Lets mam pick BOQ items even when the save-to-DB
  // step was skipped during PO creation.
  if (items.length === 0) {
    const po = db.prepare(
      `SELECT id, po_number, boq_file_link FROM purchase_orders
       WHERE business_book_id IN (${placeholders})
       ORDER BY created_at DESC LIMIT 1`
    ).get(...idList);
    if (!po) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'no_po', message: `Business Book entry matched but no PO exists yet. Create a PO in Orders first.` } });
    }
    if (!po.boq_file_link) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'no_boq_file', po_number: po.po_number, message: `PO ${po.po_number} found but no BOQ file was attached. Open that PO in Orders and upload a BOQ.` } });
    }
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (!fs.existsSync(diskPath)) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'boq_file_missing', po_number: po.po_number, path: po.boq_file_link, message: `PO ${po.po_number} references ${po.boq_file_link} but the file is missing on the server. Re-upload the BOQ on that PO.` } });
    }
    const parsed = parseBoqExcel(diskPath);
    if (parsed.length === 0) {
      return res.json({ items: [], diagnostic: { site_name: siteName, reason: 'boq_parse_empty', po_number: po.po_number, message: `BOQ file was read but no items could be parsed. Re-open the PO, click "Upload BOQ & Fetch Items" and save.` } });
    }
    return res.json({ items: parsed, diagnostic: { site_name: siteName, reason: 'fallback_parsed', po_number: po.po_number, message: `Items loaded from BOQ file (not yet saved to DB).` } });
  }

  const result = items.map(r => {
    const isFoc = String(r.item_type || '').toUpperCase() === 'FOC';
    return {
      ...r,
      is_foc: isFoc,
      remaining_qty: isFoc ? null : Math.max(0, (r.boq_qty || 0) - (r.indented_qty || 0)),
    };
  });
  res.json({ items: result });
});

// List indents with a BOQ file link derived from the site's Client PO.
// The mapping is: indent.site_name → sites.business_book_id → purchase_orders.
// boq_file_link (pick the most recent PO for that business_book).
router.get('/indents', (req, res) => {
  const db = getDb();
  const indents = db.prepare(
    `SELECT i.*, u.name as created_by_name, au.name as approved_by_name
     FROM indents i
     LEFT JOIN users u ON i.created_by = u.id
     LEFT JOIN users au ON i.approved_by = au.id
     ORDER BY i.created_at DESC`
  ).all();

  // One BOQ-link lookup per unique site_name — cached in the loop so we
  // don't hit the DB once per indent when many share the same site.
  const boqCache = new Map();
  const findBoq = (siteName) => {
    if (!siteName) return null;
    if (boqCache.has(siteName)) return boqCache.get(siteName);
    const row = db.prepare(
      `SELECT po.boq_file_link
       FROM purchase_orders po
       WHERE po.boq_file_link IS NOT NULL AND po.boq_file_link != ''
         AND po.business_book_id IN (
           SELECT DISTINCT s.business_book_id FROM sites s
             WHERE s.name = ? AND s.business_book_id IS NOT NULL
           UNION
           SELECT id FROM business_book
             WHERE project_name = ? OR company_name = ?
         )
       ORDER BY po.created_at DESC LIMIT 1`
    ).get(siteName, siteName, siteName);
    const link = row?.boq_file_link || null;
    boqCache.set(siteName, link);
    return link;
  };

  res.json(indents.map(i => ({ ...i, boq_file_link: findBoq(i.site_name || i.client_name) })));
});

router.post('/indents', (req, res) => {
  const db = getDb();
  const { planning_id, items, notes, site_name, raised_by_name, business_book_id } = req.body;
  if (!items || items.length === 0 || !items.some(i => i.item_master_id || (i.description && i.description.trim()))) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  const count = db.prepare('SELECT COUNT(*) as c FROM indents').get().c;
  const indentNum = `IND-${String(count + 1).padStart(4, '0')}`;
  // Resolve planning_id from business_book_id if one exists (for downstream
  // vendor-PO / GRN flows that key off planning rows).
  let resolvedPlanningId = planning_id || null;
  if (!resolvedPlanningId && business_book_id) {
    const plan = db.prepare('SELECT id FROM order_planning WHERE business_book_id=? ORDER BY id DESC LIMIT 1').get(business_book_id);
    if (plan) resolvedPlanningId = plan.id;
  }
  const r = db.prepare(
    `INSERT INTO indents (planning_id, indent_number, notes, site_name, raised_by_name, client_name, created_by)
     VALUES (?,?,?,?,?,?,?)`
  ).run(resolvedPlanningId, indentNum, notes || '', site_name || '', raised_by_name || '', site_name || '', req.user.id);

  // Pull description/unit/type from item_master on the server so the
  // classification flags (PO / FOC / RGP) are authoritative and can't be
  // forged by the client. Vendor/make/rate are NOT captured at indent stage
  // — the purchase team sets them later via vendor-rates.
  // Indent items are now picked from the site BOQ (po_items). We look that
  // row up on the server to derive authoritative description/unit, and fall
  // back to item_master if the BOQ row was linked to the catalogue.
  const getPoItem = db.prepare('SELECT description, unit, quantity as boq_qty, item_master_id FROM po_items WHERE id=?');
  const getMaster = db.prepare('SELECT item_name, specification, size, uom, type, make FROM item_master WHERE id=?');
  const insertItem = db.prepare(
    `INSERT INTO indent_items
      (indent_id, po_item_id, item_master_id, description, make, quantity, unit, rate, amount, item_type, is_foc, is_tool)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  for (const i of (items || [])) {
    let desc = i.description || '';
    let unit = i.unit || 'nos';
    let itemType = null;
    let make = i.make || '';
    let masterId = i.item_master_id || null;

    // Only integer po_item_ids correspond to real po_items rows. Strings like
    // 'fallback-Sheet2-3' come from the on-the-fly BOQ Excel parser and
    // should NOT be persisted (no FK exists for them).
    const poItemId = Number.isInteger(+i.po_item_id) && +i.po_item_id > 0 ? +i.po_item_id : null;
    if (poItemId) {
      const p = getPoItem.get(poItemId);
      if (p) {
        desc = p.description || desc;
        unit = p.unit || unit;
        if (!masterId && p.item_master_id) masterId = p.item_master_id;
      }
    }
    if (masterId) {
      const m = getMaster.get(masterId);
      if (m) {
        itemType = m.type || itemType;
        if (!make && m.make) make = m.make;
      }
    }

    const qty = +i.quantity || 0;
    // Keep legacy is_foc / is_tool in sync with the new item_type so older
    // reports still work.
    const foc = String(itemType || '').toUpperCase() === 'FOC' ? 1 : 0;
    const tool = String(itemType || '').toUpperCase() === 'RGP' ? 1 : 0;
    insertItem.run(
      r.lastInsertRowid, poItemId, masterId, desc, make, qty, unit, 0, 0, itemType, foc, tool,
    );
  }
  res.status(201).json({ id: r.lastInsertRowid, indent_number: indentNum });
});

router.put('/indents/:id', (req, res) => {
  const { status } = req.body;
  const db = getDb();
  db.prepare('UPDATE indents SET status=?, approved_by=? WHERE id=?')
    .run(status, status === 'approved' ? req.user.id : null, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/indents/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const vpoCount = db.prepare('SELECT COUNT(*) as c FROM vendor_pos WHERE indent_id=?').get(id).c;
  if (vpoCount > 0) return res.status(409).json({ error: 'Cannot delete: Vendor POs reference this indent' });
  db.prepare('DELETE FROM indent_items WHERE indent_id=?').run(id);
  db.prepare('DELETE FROM indents WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

router.get('/indents/:id', (req, res) => {
  const indent = getDb().prepare(
    `SELECT i.*, u.name as created_by_name FROM indents i LEFT JOIN users u ON i.created_by=u.id WHERE i.id=?`
  ).get(req.params.id);
  if (!indent) return res.status(404).json({ error: 'Not found' });
  indent.items = getDb().prepare(
    `SELECT ii.*, v.name as vendor_name, im.item_code, im.item_name as master_name
     FROM indent_items ii
     LEFT JOIN vendors v ON ii.vendor_id = v.id
     LEFT JOIN item_master im ON ii.item_master_id = im.id
     WHERE ii.indent_id = ?`
  ).all(req.params.id);
  res.json(indent);
});

// Vendor PO
// GET returns the extra upload fields (po_date, file_path, remarks) too.
router.get('/vendor-po', (req, res) => {
  res.json(getDb().prepare(`SELECT vp.*, v.name as vendor_name FROM vendor_pos vp
    LEFT JOIN vendors v ON vp.vendor_id=v.id ORDER BY vp.created_at DESC`).all());
});

// Items of a given indent, with finalized rate info and whether each item is
// already covered by a Vendor PO. Used to populate the item-checkbox grid in
// the Create Vendor PO modal.
router.get('/indents/:id/items-for-po', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity, ii.unit, ii.item_type,
            ii.item_master_id, im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days, r.status as rate_status,
            (SELECT COUNT(*) FROM vendor_po_items vpi WHERE vpi.indent_item_id = ii.id) as in_po_count
     FROM indent_items ii
     LEFT JOIN indent_item_rates r ON r.indent_item_id = ii.id
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE ii.indent_id = ?
     ORDER BY ii.id`
  ).all(req.params.id);
  res.json(rows);
});

// Indent items not yet covered by a Vendor PO — the 'pending for PO' list
// on top of the Vendor PO tab. Joins item_master so the Pending table can
// show item_code + full master name (mam's ask: 'no item of item master
// which I fill in indent').
router.get('/pending-po-items', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity, ii.unit, ii.item_type,
            ii.item_master_id, im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            i.id as indent_id, i.indent_number, i.site_name, i.raised_by_name,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days, r.status as rate_status
     FROM indent_items ii
     JOIN indents i ON ii.indent_id = i.id
     LEFT JOIN indent_item_rates r ON r.indent_item_id = ii.id
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE NOT EXISTS (SELECT 1 FROM vendor_po_items vpi WHERE vpi.indent_item_id = ii.id)
     ORDER BY
       CASE WHEN r.status = 'finalized' THEN 0 ELSE 1 END,
       i.created_at DESC, ii.id`
  ).all();
  res.json(rows);
});

// Upload a Vendor PO that was created in Tally.
//
// This is a multipart/form-data endpoint — the client sends metadata fields
// plus an optional file (PDF / image / xlsx). Items linking back to indent
// lines are optional and come in as a JSON-stringified `items` field.
//
// Why a JSON string for items? multer parses the multipart body into
// req.body where each field is a string. Passing a nested array requires
// encoding it as JSON on the client and decoding here.
router.post('/vendor-po', vendorPoUpload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const vendor_id = +b.vendor_id;
  const indent_id = b.indent_id ? +b.indent_id : null;
  if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });

  // Parse optional line items (JSON string in multipart form)
  let items = [];
  if (b.items) {
    try { items = JSON.parse(b.items); } catch (e) { return res.status(400).json({ error: 'items must be valid JSON' }); }
  }
  const lines = Array.isArray(items) ? items.filter(i => i.indent_item_id && +i.quantity > 0 && +i.rate > 0) : [];

  // Use the PO number from Tally if provided; else auto-number with the usual
  // VPO-#### pattern so nothing breaks for uploads that lack a Tally ref.
  let poNum = (b.po_number || '').trim();
  if (!poNum) {
    const count = db.prepare('SELECT COUNT(*) as c FROM vendor_pos').get().c;
    poNum = `VPO-${String(count + 1).padStart(4, '0')}`;
  }

  // Total: prefer what the user typed (matches the Tally printout). Fall back
  // to the computed sum of line items if blank.
  const typedTotal = Number(b.total_amount);
  const computedTotal = lines.reduce((s, i) => s + (+i.quantity * +i.rate), 0);
  const totalAmount = Number.isFinite(typedTotal) && typedTotal > 0 ? typedTotal : computedTotal;

  // Move uploaded file to a readable name so downloads show the original
  // filename, and save /uploads/<name> as the file_path.
  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'vendor-po').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  const po_date = b.po_date || null;
  const remarks = b.remarks || null;
  const expected_receipt_date = b.expected_receipt_date || null;

  try {
    const tx = db.transaction(() => {
      const r = db.prepare(
        `INSERT INTO vendor_pos
           (indent_id, vendor_id, po_number, total_amount, advance_required, po_date, file_path, remarks, expected_receipt_date)
         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?)`
      ).run(indent_id, vendor_id, poNum, Math.round(totalAmount * 100) / 100, po_date, filePath, remarks, expected_receipt_date);
      const vpoId = r.lastInsertRowid;

      // Only write line items if the uploader chose to link indent lines.
      // Terms + credit_days are deliberately null — PO terms now live on the
      // uploaded Tally PO itself.
      const insItem = db.prepare(
        `INSERT INTO vendor_po_items (vendor_po_id, indent_item_id, quantity, rate, amount, terms, credit_days)
         VALUES (?, ?, ?, ?, ?, NULL, 0)`
      );
      for (const i of lines) {
        insItem.run(vpoId, i.indent_item_id, +i.quantity, +i.rate, +i.quantity * +i.rate);
      }
      if (indent_id) db.prepare('UPDATE indents SET status=? WHERE id=?').run('po_sent', indent_id);
      return vpoId;
    });
    const vpoId = tx();
    res.status(201).json({ id: vpoId, po_number: poNum, total_amount: totalAmount, lines: lines.length, file_path: filePath });
  } catch (err) {
    // Clean up orphaned upload if the DB insert failed (e.g. unique-constraint on po_number)
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    if (String(err.message || '').includes('UNIQUE')) {
      return res.status(409).json({ error: `PO Number "${poNum}" already exists` });
    }
    res.status(500).json({ error: err.message });
  }
});

router.put('/vendor-po/:id', (req, res) => {
  const { status, advance_paid } = req.body;
  getDb().prepare('UPDATE vendor_pos SET status=?, advance_paid=? WHERE id=?')
    .run(status, advance_paid ? 1 : 0, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/vendor-po/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(id).c;
  const dnCount = db.prepare('SELECT COUNT(*) as c FROM delivery_notes WHERE vendor_po_id=?').get(id).c;
  if (billCount > 0 || dnCount > 0) return res.status(409).json({ error: 'Cannot delete: Purchase Bills or Delivery Notes reference this Vendor PO' });
  db.prepare('DELETE FROM vendor_pos WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Purchase Bills
router.get('/purchase-bills', (req, res) => {
  res.json(getDb().prepare(`SELECT pb.*, v.name as vendor_name FROM purchase_bills pb
    LEFT JOIN vendors v ON pb.vendor_id=v.id ORDER BY pb.created_at DESC`).all());
});

// Purchase bill creation supports an optional file upload (PDF / image / xlsx)
// via multipart/form-data, the same pattern as Vendor PO upload. If no file
// is attached it still works — mam sometimes captures a bill without a scan.
router.post('/purchase-bills', vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  const vendor_id = b.vendor_id ? +b.vendor_id : null;
  const bill_number = b.bill_number || null;
  const bill_date = b.bill_date || null;
  const amount = +b.amount || 0;
  const gst_amount = +b.gst_amount || 0;
  const total_amount = +b.total_amount || 0;

  // Rename uploaded file to "<timestamp>-<original>" so the /uploads link
  // shows the real filename, same convention as Vendor PO upload.
  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'purchase-bill').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  try {
    const r = getDb().prepare(
      `INSERT INTO purchase_bills (vendor_po_id, vendor_id, bill_number, bill_date, amount, gst_amount, total_amount, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(vendor_po_id, vendor_id, bill_number, bill_date, amount, gst_amount, total_amount, filePath);
    res.status(201).json({ id: r.lastInsertRowid, file_path: filePath });
  } catch (err) {
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

router.delete('/purchase-bills/:id', (req, res) => {
  getDb().prepare('DELETE FROM purchase_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Dispatch (delivery_notes) — a dispatch entry is either a Sales Bill
// (for PO items sold to client) or a Delivery Challan (FOC / RGP items).
// After dispatch, mam records who received it via the /receive endpoint.
router.get('/delivery-notes', (req, res) => {
  res.json(getDb().prepare(`
    SELECT dn.*,
      u.name as received_by_user_name,
      vp.po_number as vendor_po_number,
      v.name as vendor_name
    FROM delivery_notes dn
    LEFT JOIN users u ON dn.received_by = u.id
    LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    ORDER BY dn.created_at DESC
  `).all());
});

// Create a dispatch entry. Multipart/form-data so we can carry the
// sales-bill/challan PDF as an optional upload. Document type is required
// (sales_bill | challan) so the list can show the right label.
router.post('/delivery-notes', vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  const delivery_date = b.delivery_date || null;
  const notes = b.notes || null;
  const document_type = b.document_type || null;     // 'sales_bill' or 'challan'
  const document_number = b.document_number || null;
  if (document_type && !['sales_bill', 'challan'].includes(document_type)) {
    return res.status(400).json({ error: 'document_type must be sales_bill or challan' });
  }

  let filePath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'dispatch').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      filePath = `/uploads/${newName}`;
    } catch (e) {
      filePath = `/uploads/${req.file.filename}`;
    }
  }

  try {
    const r = getDb().prepare(
      `INSERT INTO delivery_notes (vendor_po_id, delivery_date, received_by, notes,
                                    document_type, document_number, file_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(vendor_po_id, delivery_date, req.user.id, notes, document_type, document_number, filePath);
    res.status(201).json({ id: r.lastInsertRowid, file_path: filePath });
  } catch (err) {
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

// Mark a dispatch as "Received by <name> on <date>" and attach the stamped +
// signed receipt photo as proof. Mam flagged this as business-critical: without
// the signed proof, clients sometimes deny receipt and SEPL eats the loss.
// Multipart so the receipt photo can ride along with the metadata.
router.patch('/delivery-notes/:id/receive', vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const received_by_name = b.received_by_name;
  const received_at = b.received_at;
  if (!received_by_name || !String(received_by_name).trim()) {
    return res.status(400).json({ error: 'Received-by name is required' });
  }
  const db = getDb();
  const existing = db.prepare('SELECT id FROM delivery_notes WHERE id=?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Dispatch not found' });

  // Rename + persist the uploaded receipt photo under /uploads
  let receiptPath = null;
  if (req.file) {
    try {
      const safeName = (req.file.originalname || 'receipt').replace(/[^a-zA-Z0-9._-]/g, '_');
      const newName = `${Date.now()}-${safeName}`;
      const newPath = path.join(path.dirname(req.file.path), newName);
      fs.renameSync(req.file.path, newPath);
      receiptPath = `/uploads/${newName}`;
    } catch (e) {
      receiptPath = `/uploads/${req.file.filename}`;
    }
  }

  try {
    db.prepare(
      `UPDATE delivery_notes
         SET received_by_name = ?,
             received_at = COALESCE(?, CURRENT_TIMESTAMP),
             receipt_file_path = COALESCE(?, receipt_file_path),
             status = 'received'
       WHERE id = ?`
    ).run(String(received_by_name).trim(), received_at || null, receiptPath, req.params.id);
    res.json({ message: 'Marked as received', receipt_file_path: receiptPath });
  } catch (err) {
    if (receiptPath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(receiptPath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

router.put('/delivery-notes/:id', (req, res) => {
  const { status, notes } = req.body;
  getDb().prepare('UPDATE delivery_notes SET status=?, notes=? WHERE id=?').run(status, notes, req.params.id);
  res.json({ message: 'Updated' });
});

router.delete('/delivery-notes/:id', (req, res) => {
  getDb().prepare('DELETE FROM delivery_notes WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// Sales Bills
router.get('/sales-bills', (req, res) => {
  res.json(getDb().prepare(`SELECT sb.*, po.po_number FROM sales_bills sb
    LEFT JOIN purchase_orders po ON sb.po_id=po.id ORDER BY sb.created_at DESC`).all());
});

router.post('/sales-bills', (req, res) => {
  const db = getDb();
  const { po_id, bill_date, amount, gst_amount, total_amount } = req.body;
  const count = db.prepare('SELECT COUNT(*) as c FROM sales_bills').get().c;
  const billNum = `SB-${String(count + 1).padStart(4, '0')}`;
  const r = db.prepare('INSERT INTO sales_bills (po_id,bill_number,bill_date,amount,gst_amount,total_amount) VALUES (?,?,?,?,?,?)')
    .run(po_id, billNum, bill_date, amount, gst_amount, total_amount);
  res.status(201).json({ id: r.lastInsertRowid, bill_number: billNum });
});

router.delete('/sales-bills/:id', (req, res) => {
  getDb().prepare('DELETE FROM sales_bills WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ITEM-WISE VENDOR RATES — each indent item gets up to 3 vendor quotes,
// then one is finalized. This is the "Step 1 + Step 2" of mam's workflow
// sheet: (1) 3 Vendors Rate, (2) Final Rate.

// List all indent items (not yet fully converted to vendor PO) with their
// current rates row (one per item, joined). An item shows here once the
// indent is submitted/approved.
router.get('/item-rates', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity as qty, ii.unit,
            ii.item_type, ii.item_master_id,
            im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            i.indent_number, i.id as indent_id,
            i.site_name, i.raised_by_name, i.status as indent_status,
            bb.lead_no,
            r.id as rate_id,
            r.vendor1_name, r.vendor1_rate, r.vendor1_terms, r.vendor1_credit_days,
            r.vendor2_name, r.vendor2_rate, r.vendor2_terms, r.vendor2_credit_days,
            r.vendor3_name, r.vendor3_rate, r.vendor3_terms, r.vendor3_credit_days,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days,
            r.status as rate_status, r.finalized_at, fu.name as finalized_by_name
     FROM indent_items ii
     JOIN indents i ON ii.indent_id = i.id
     LEFT JOIN item_master im ON im.id = ii.item_master_id
     LEFT JOIN indent_item_rates r ON r.indent_item_id = ii.id
     LEFT JOIN users fu ON fu.id = r.finalized_by
     LEFT JOIN order_planning op ON op.id = i.planning_id
     LEFT JOIN business_book bb ON bb.id = op.business_book_id
     ORDER BY i.created_at DESC, ii.id`
  ).all();
  res.json(rows);
});

// Upsert a rate row for an indent item. Any of the 3 vendors (or the
// finalization fields) may be updated in one call.
router.post('/item-rates', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const iiId = parseInt(b.indent_item_id, 10);
  if (!iiId) return res.status(400).json({ error: 'indent_item_id is required' });

  const existing = db.prepare('SELECT id FROM indent_item_rates WHERE indent_item_id=?').get(iiId);
  const fields = ['vendor1_name','vendor1_rate','vendor1_terms','vendor1_credit_days',
                  'vendor2_name','vendor2_rate','vendor2_terms','vendor2_credit_days',
                  'vendor3_name','vendor3_rate','vendor3_terms','vendor3_credit_days'];
  // Mark status 'quoted' once any vendor rate is set
  const anyRate = [b.vendor1_rate, b.vendor2_rate, b.vendor3_rate].some(v => Number(v) > 0);

  if (existing) {
    const sets = fields.map(f => `${f} = COALESCE(?, ${f})`).join(', ');
    const vals = fields.map(f => b[f] !== undefined ? b[f] : null);
    db.prepare(
      `UPDATE indent_item_rates
       SET ${sets}, status = COALESCE(?, status), updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`
    ).run(...vals, anyRate ? 'quoted' : null, existing.id);
    res.json({ id: existing.id, updated: true });
  } else {
    const cols = ['indent_item_id', ...fields, 'status', 'entered_by'];
    const vals = [iiId, ...fields.map(f => b[f] ?? null), anyRate ? 'quoted' : 'pending', req.user.id];
    const r = db.prepare(
      `INSERT INTO indent_item_rates (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`
    ).run(...vals);
    res.status(201).json({ id: r.lastInsertRowid, created: true });
  }
});

// Finalize — admin / approver picks one of the three vendors (or enters a
// custom final rate). After this, downstream steps (Vendor PO, Bill) use
// the final_* columns.
router.post('/item-rates/:id/finalize', (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const { final_rate, final_vendor_name, final_terms, final_credit_days } = b;
  if (!final_vendor_name || !final_rate) return res.status(400).json({ error: 'final_vendor_name and final_rate are required' });
  db.prepare(
    `UPDATE indent_item_rates
     SET final_rate=?, final_vendor_name=?, final_terms=?, final_credit_days=?,
         status='finalized', finalized_by=?, finalized_at=CURRENT_TIMESTAMP, updated_at=CURRENT_TIMESTAMP
     WHERE id=?`
  ).run(+final_rate, final_vendor_name, final_terms || null, +final_credit_days || 0, req.user.id, req.params.id);
  res.json({ message: 'Finalized' });
});

// ADMIN ONLY — wipe all dispatches/indents, vendor POs, purchase bills,
// delivery notes and vendor rate rows. Used when mam wants a clean slate.
// Irreversible; the UI protects with a double confirmation.
router.post('/admin/wipe-indents-pos', (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  const db = getDb();
  const counts = {
    indents: db.prepare('SELECT COUNT(*) as c FROM indents').get().c,
    vendor_pos: db.prepare('SELECT COUNT(*) as c FROM vendor_pos').get().c,
    purchase_bills: db.prepare('SELECT COUNT(*) as c FROM purchase_bills').get().c,
    delivery_notes: db.prepare('SELECT COUNT(*) as c FROM delivery_notes').get().c,
  };
  // Delete child rows first to avoid FK issues (SQLite isn't enforcing by
  // default here but this keeps things tidy either way).
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM grn_items').run();
    db.prepare('DELETE FROM grn').run();
    db.prepare('DELETE FROM indent_tracker').run();
    db.prepare('DELETE FROM delivery_notes').run();
    db.prepare('DELETE FROM purchase_bills').run();
    db.prepare('DELETE FROM vendor_rates').run();
    db.prepare('DELETE FROM vendor_pos').run();
    db.prepare('DELETE FROM indent_items').run();
    db.prepare('DELETE FROM indents').run();
  });
  tx();
  res.json({ message: 'Wiped', counts });
});

// Upload / replace the BOQ for the currently-selected site directly from
// the Raise Indent modal. Creates a stub PO if none exists yet, so a user
// can start indenting immediately without bouncing to Orders. Replaces
// existing po_items for that business_book and saves the file link to the
// PO's boq_file_link.
// BOQ bulk upload (Raise Indent tab). Reuses the shared uploadDir defined
// at the top of this file — no need to re-require multer.
const bulkUpload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

// Fetch items from the BOQ that's ALREADY attached somewhere (PO file link,
// BOQ module via quotation, etc.) — no re-upload needed. Mam's usual case:
// BOQ was uploaded during PO creation; items either weren't saved to po_items
// or were never saved because the final 'Update Purchase Order' step was
// skipped. This endpoint fishes the items out and persists them to po_items.
router.post('/fetch-existing-boq', (req, res) => {
  const siteName = String(req.body?.site_name || '').trim();
  if (!siteName) return res.status(400).json({ error: 'site_name is required' });
  const db = getDb();

  // 1. Resolve business_book_id (same tolerant matcher)
  let bbId = null;
  const viaSite = db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL LIMIT 1`
  ).get(siteName);
  if (viaSite?.business_book_id) bbId = viaSite.business_book_id;
  if (!bbId) {
    const viaBB = db.prepare(
      `SELECT id FROM business_book
       WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))
       LIMIT 1`
    ).get(siteName, siteName, siteName);
    if (viaBB?.id) bbId = viaBB.id;
  }
  if (!bbId) return res.status(404).json({ error: `No Business Book entry matches "${siteName}"` });

  // 2. Try each source in order and return the first that yields items.
  const sources = [];

  // 2a. Parse PO's boq_file_link from disk
  const po = db.prepare(
    `SELECT id, po_number, boq_file_link FROM purchase_orders
     WHERE business_book_id=? AND boq_file_link IS NOT NULL AND boq_file_link != ''
     ORDER BY created_at DESC LIMIT 1`
  ).get(bbId);
  if (po?.boq_file_link) {
    const filename = path.basename(po.boq_file_link);
    const diskPath = path.join(__dirname, '..', '..', 'data', 'uploads', filename);
    if (fs.existsSync(diskPath)) {
      const parsed = parseBoqExcel(diskPath);
      if (parsed.length > 0) sources.push({ name: 'po_file', items: parsed, po_number: po.po_number });
    }
  }

  // 2b. boq_items via quotations tied to this project's lead
  if (sources.length === 0) {
    const leadRows = db.prepare(
      `SELECT DISTINCT lead_id FROM business_book WHERE id=? AND lead_id IS NOT NULL`
    ).all(bbId);
    const leadIds = leadRows.map(r => r.lead_id);
    if (leadIds.length > 0) {
      const leadPH = leadIds.map(() => '?').join(',');
      const boqRows = db.prepare(
        `SELECT bi.description, bi.quantity, bi.unit, bi.rate, bi.amount
         FROM boq_items bi
         JOIN boq b ON b.id = bi.boq_id
         WHERE b.lead_id IN (${leadPH})`
      ).all(...leadIds);
      if (boqRows.length > 0) {
        sources.push({
          name: 'boq_module',
          items: boqRows.map((r, i) => ({
            description: r.description, unit: r.unit || 'nos', boq_qty: r.quantity,
          })),
        });
      }
    }
  }

  if (sources.length === 0) {
    return res.status(404).json({
      error: po?.boq_file_link
        ? `BOQ file is attached to PO ${po.po_number} but could not be read or parsed.`
        : 'No BOQ file attached to the PO, and no BOQ items in the BOQ module for this project.',
    });
  }

  // 3. Persist into po_items so Remaining tracking works across indents
  const src = sources[0];
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM po_items WHERE business_book_id=?').run(bbId);
    const ins = db.prepare('INSERT INTO po_items (business_book_id, description, quantity, unit, rate, amount) VALUES (?,?,?,?,?,?)');
    for (const it of src.items) {
      ins.run(bbId, it.description, it.boq_qty || it.quantity || 0, it.unit || 'nos', it.rate || 0, it.amount || 0);
    }
  });
  tx();

  res.json({ message: 'Items fetched', items_saved: src.items.length, source: src.name, po_number: src.po_number || null });
});

router.post('/upload-boq-for-site', bulkUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const siteName = String(req.body?.site_name || '').trim();
  if (!siteName) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(400).json({ error: 'site_name is required' });
  }

  const db = getDb();
  // Resolve business_book id (case-insensitive, tolerant)
  let bbId = null;
  const viaSite = db.prepare(
    `SELECT DISTINCT s.business_book_id FROM sites s
     WHERE LOWER(TRIM(s.name)) = LOWER(TRIM(?)) AND s.business_book_id IS NOT NULL LIMIT 1`
  ).get(siteName);
  if (viaSite?.business_book_id) bbId = viaSite.business_book_id;
  if (!bbId) {
    const viaBB = db.prepare(
      `SELECT id FROM business_book
       WHERE LOWER(TRIM(project_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(company_name)) = LOWER(TRIM(?))
          OR LOWER(TRIM(client_name))  = LOWER(TRIM(?))
       LIMIT 1`
    ).get(siteName, siteName, siteName);
    if (viaBB?.id) bbId = viaBB.id;
  }
  if (!bbId) {
    try { fs.unlinkSync(req.file.path); } catch (e) {}
    return res.status(404).json({ error: `No Business Book entry found matching "${siteName}"` });
  }

  // Rename file to something readable + served from /uploads
  const safeName = (req.file.originalname || 'boq.xlsx').replace(/[^a-zA-Z0-9._-]/g, '_');
  const newName = `${Date.now()}-${safeName}`;
  const newPath = path.join(uploadDir, newName);
  try { fs.renameSync(req.file.path, newPath); } catch (e) { /* fall through */ }
  const fileUrl = `/uploads/${newName}`;

  // Parse items — only meaningful for Excel; PDFs just attach the link.
  const isExcel = /\.(xlsx|xls)$/i.test(req.file.originalname || '');
  let parsedItems = [];
  if (isExcel) parsedItems = parseBoqExcel(fs.existsSync(newPath) ? newPath : req.file.path);

  // Ensure a PO exists for this business_book so boq_file_link can be stored
  let po = db.prepare(
    'SELECT id, boq_file_link FROM purchase_orders WHERE business_book_id=? ORDER BY created_at DESC LIMIT 1'
  ).get(bbId);
  if (!po) {
    const stubNum = `AUTO-${bbId}-${Date.now().toString().slice(-6)}`;
    const r = db.prepare(
      `INSERT INTO purchase_orders (business_book_id, po_number, po_date, boq_file_link, site_engineer_id, site_engineer_ids, crm_name, created_by)
       VALUES (?, ?, DATE('now'), ?, ?, ?, ?, ?)`
    ).run(bbId, stubNum, fileUrl, req.user.id, String(req.user.id), 'Auto', req.user.id);
    po = { id: r.lastInsertRowid, boq_file_link: fileUrl };
  } else {
    db.prepare('UPDATE purchase_orders SET boq_file_link=? WHERE id=?').run(fileUrl, po.id);
  }

  // Replace po_items for this business_book with the parsed set
  let savedCount = 0;
  if (parsedItems.length > 0) {
    const tx = db.transaction(() => {
      db.prepare('DELETE FROM po_items WHERE business_book_id=?').run(bbId);
      const ins = db.prepare(
        'INSERT INTO po_items (business_book_id, description, quantity, unit, rate, amount) VALUES (?,?,?,?,?,?)'
      );
      for (const it of parsedItems) {
        ins.run(bbId, it.description, it.boq_qty, it.unit || 'nos', 0, 0);
        savedCount++;
      }
    });
    tx();
  }

  res.json({ message: 'BOQ saved', file_url: fileUrl, items_saved: savedCount, parsed_items_count: parsedItems.length, business_book_id: bbId, po_id: po.id });
});

module.exports = router;
