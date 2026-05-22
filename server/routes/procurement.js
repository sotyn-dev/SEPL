const express = require('express');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const router = express.Router();
router.use(authMiddleware);

// Gate the high-trust procurement actions (Vendor Rates entry, Vendor PO
// upload, Purchase Bill, Dispatch) behind procurement.approve permission.
// Site engineers with only procurement.create can still raise indents —
// they just can't touch vendor-facing or financial steps. This matches
// mam's requirement (2026-04-23): site can create indent, nothing else.
const needsApprove = requirePermission('procurement', 'approve');

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

  // Mam (2026-05-21): block duplicate vendors.  A vendor is the same
  // entity if EITHER its phone OR its GSTIN matches an existing row.
  // Phone-only or GST-only matches are also caught; if both blank we
  // skip the guard (legit edge case: pre-onboarding vendors with no
  // contact details yet).
  const { findDuplicate, sendDuplicate } = require('../utils/duplicateGuard');
  if (b.gst_number && String(b.gst_number).trim()) {
    const dup = findDuplicate(db, {
      table: 'vendors', fields: { gst_number: b.gst_number },
      codeColumn: 'vendor_code',
    });
    if (sendDuplicate(res, dup, `Vendor with GSTIN ${b.gst_number}`)) return;
  }
  if (b.phone && String(b.phone).trim()) {
    const dup = findDuplicate(db, {
      table: 'vendors', fields: { phone: b.phone },
      codeColumn: 'vendor_code',
    });
    if (sendDuplicate(res, dup, `Vendor with phone ${b.phone}`)) return;
  }

  // Auto-generate vendor code if empty. Uses nextSequence so deletes don't
  // cause UNIQUE-constraint collisions.
  let code = b.vendor_code;
  if (!code) {
    const { nextSequence } = require('../db/nextSequence');
    code = nextSequence(db, 'vendors', 'vendor_code', 'SEVC', { startFrom: 1999, pad: 4 });
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
  // Scope filter: anyone with 'approve' permission on procurement (or admin)
  // sees ALL indents. Plain users (site engineers with only view + create)
  // see only the ones they raised. Mam toggles this by checking / unchecking
  // 'approve' on the role's procurement permissions.
  const isAdmin = req.user.role === 'admin';
  const canSeeAll = isAdmin || (() => {
    const r = db.prepare(`
      SELECT MAX(CASE WHEN rp.can_approve = 1 OR rp.can_see_all = 1 THEN 1 ELSE 0 END) as ok
      FROM user_roles ur JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE ur.user_id = ? AND rp.module = 'procurement'
    `).get(req.user.id);
    return !!r?.ok;
  })();
  const where = canSeeAll ? '' : 'WHERE i.created_by = ?';
  const params = canSeeAll ? [] : [req.user.id];
  const indents = db.prepare(
    `SELECT i.*, u.name as created_by_name, au.name as approved_by_name
     FROM indents i
     LEFT JOIN users u ON i.created_by = u.id
     LEFT JOIN users au ON i.approved_by = au.id
     ${where}
     ORDER BY i.created_at DESC`
  ).all(...params);

  // Pull every indent_item in one query and group client-side so the
  // listing can show what was raised without a per-row API call.
  // Also pulls item_master.item_code / specification / size so the expanded
  // view can show the actual Sub-Item (Item Master entry) alongside the
  // BOQ description — the BOQ description is often very long and identical
  // across rows of the same BOQ, so the sub-item column is what tells the
  // rows apart at a glance.
  const allItems = db.prepare(
    `SELECT ii.id, ii.indent_id, ii.description, ii.make, ii.quantity,
            ii.unit, ii.item_type,
            im.item_code, im.item_name as master_name,
            im.specification as master_specification, im.size as master_size
     FROM indent_items ii
     LEFT JOIN item_master im ON ii.item_master_id = im.id
     ORDER BY ii.id`
  ).all();
  const itemsByIndent = new Map();
  for (const it of allItems) {
    if (!itemsByIndent.has(it.indent_id)) itemsByIndent.set(it.indent_id, []);
    itemsByIndent.get(it.indent_id).push(it);
  }

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

  res.json(indents.map(i => ({
    ...i,
    boq_file_link: findBoq(i.site_name || i.client_name),
    items: itemsByIndent.get(i.id) || [],
  })));
});

router.post('/indents', (req, res) => {
  const db = getDb();
  const { planning_id, items, notes, site_name, raised_by_name, business_book_id } = req.body;
  if (!items || items.length === 0) {
    return res.status(400).json({ error: 'At least one item is required' });
  }
  // Per-row validation. Two valid modes:
  //   1) BOQ-linked: BOTH po_item_id AND item_master_id are picked
  //      (the normal flow when the site has a Client PO BOQ uploaded)
  //   2) Manual:     it.manual === true OR it.description is non-empty
  //      (the fallback when the site has no BOQ yet or mam wants
  //       to enter a free-text item — same flow as the old code)
  // Quantity must always be > 0.
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const hasBoq = !!it.po_item_id;
    const hasSub = !!it.item_master_id;
    const isManual = it.manual === true || !!String(it.description || '').trim();
    const qtyOk = +it.quantity > 0;
    if (!qtyOk) return res.status(400).json({ error: `Row ${i + 1}: Quantity must be greater than 0` });
    if (isManual) continue;                              // manual entry — skip BOQ/sub checks
    if (hasBoq && hasSub) continue;                      // BOQ-linked entry — both present, OK
    if (!hasBoq) return res.status(400).json({ error: `Row ${i + 1}: pick a BOQ Item (or type a description for manual entry)` });
    if (!hasSub) return res.status(400).json({ error: `Row ${i + 1}: pick a Sub-Item (Item Master)` });
  }
  const { nextSequence } = require('../db/nextSequence');
  const indentNum = nextSequence(db, 'indents', 'indent_number', 'IND-', { startFrom: 0, pad: 4 });
  // Resolve planning_id from business_book_id if one exists (for downstream
  // vendor-PO / GRN flows that key off planning rows).
  let resolvedPlanningId = planning_id || null;
  if (!resolvedPlanningId && business_book_id) {
    const plan = db.prepare('SELECT id FROM order_planning WHERE business_book_id=? ORDER BY id DESC LIMIT 1').get(business_book_id);
    if (plan) resolvedPlanningId = plan.id;
  }
  // status='submitted' (not 'draft') — mam's flow: every Raise Purchase Indent
  // submission goes straight to the approval queue, no draft state in between.
  // Approver then either Approves (→ 'approved') or Rejects (→ 'rejected') from
  // the indent list.
  const r = db.prepare(
    `INSERT INTO indents (planning_id, indent_number, status, notes, site_name, raised_by_name, client_name, created_by)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(resolvedPlanningId, indentNum, 'submitted', notes || '', site_name || '', raised_by_name || '', site_name || '', req.user.id);

  // Seed the indent_tracker with the approval_pending stage so the IndentFMS
  // pipeline view immediately reflects "this indent is waiting for approval".
  // The 'indent_raised' stage is implicit (any indent without a tracker entry
  // is considered at that stage), so we jump straight to approval_pending.
  try {
    db.prepare('INSERT INTO indent_tracker (indent_id, stage, updated_by, notes) VALUES (?,?,?,?)')
      .run(r.lastInsertRowid, 'approval_pending', req.user.id, 'Awaiting approval');
  } catch (e) { /* tracker is best-effort; never block indent creation */ }

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
      (indent_id, po_item_id, item_master_id, description, make, quantity, unit, rate, amount, item_type, is_foc, is_tool, required_date)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
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
        // Item Master UOM is the authoritative unit (mam, 2026-05-16:
        // "automatic uom pick from itemwise master as per subitem").
        // Overrides whatever the BOQ row said because the master sheet
        // is the source of truth post-cleanup.
        if (m.uom) unit = String(m.uom).toLowerCase();
      }
    }

    const qty = +i.quantity || 0;
    // Keep legacy is_foc / is_tool in sync with the new item_type so older
    // reports still work.
    const foc = String(itemType || '').toUpperCase() === 'FOC' ? 1 : 0;
    const tool = String(itemType || '').toUpperCase() === 'RGP' ? 1 : 0;
    insertItem.run(
      r.lastInsertRowid, poItemId, masterId, desc, make, qty, unit, 0, 0, itemType, foc, tool,
      i.required_date || null,
    );
  }
  res.status(201).json({ id: r.lastInsertRowid, indent_number: indentNum });
});

// PUT supports two modes:
//   1. Approve / reject — body has { status } only.
//   2. Full edit (mam: site engineers in training submit wrong indents,
//      should be able to fix instead of delete + re-create) — body has
//      items[] and the header fields. Allowed only while the indent is
//      still in 'submitted', 'draft' or 'rejected' state AND no active
//      Vendor PO has been created against it. Once approved or POed,
//      it's frozen.
router.put('/indents/:id', (req, res) => {
  const { status, items, site_name, raised_by_name, notes } = req.body;
  const db = getDb();
  const id = req.params.id;

  // Approve / reject path.
  if (status && !items) {
    // Separation of duties — mam (2026-05-21): "how can if user fill
    // that indent how can he she approved and reject their indent".
    // Block the creator from approving / rejecting their own indent.
    // Site engineers / data-entry users can still flip status from
    // 'draft' → 'submitted' on their own row (that's the submit step,
    // not an approval).  Admin bypasses (handles corner cases where
    // mam herself raised an indent and needs to push it through).
    if (status === 'approved' || status === 'rejected') {
      const cur = db.prepare('SELECT created_by FROM indents WHERE id=?').get(id);
      if (cur && cur.created_by === req.user.id && req.user.role !== 'admin') {
        return res.status(403).json({
          error: 'You cannot approve or reject an indent you raised yourself. Ask another approver.',
        });
      }
    }
    db.prepare('UPDATE indents SET status=?, approved_by=? WHERE id=?')
      .run(status, status === 'approved' ? req.user.id : null, id);
    return res.json({ message: 'Updated' });
  }

  // Full edit path
  if (items) {
    const cur = db.prepare('SELECT status FROM indents WHERE id=?').get(id);
    if (!cur) return res.status(404).json({ error: 'Indent not found' });
    if (cur.status === 'approved') {
      return res.status(400).json({ error: 'Cannot edit an approved indent' });
    }
    const vpoCount = db.prepare(
      'SELECT COUNT(*) as c FROM vendor_pos WHERE indent_id=? AND COALESCE(cancelled, 0) = 0'
    ).get(id).c;
    if (vpoCount > 0) {
      return res.status(400).json({ error: `Cannot edit — ${vpoCount} active Vendor PO(s) reference this indent` });
    }

    // Same per-row validation as POST.
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const hasBoq = !!it.po_item_id;
      const hasSub = !!it.item_master_id;
      const isManual = it.manual === true || !!String(it.description || '').trim();
      const qtyOk = +it.quantity > 0;
      if (!qtyOk) return res.status(400).json({ error: `Row ${i + 1}: Quantity must be greater than 0` });
      if (isManual) continue;
      if (hasBoq && hasSub) continue;
      if (!hasBoq) return res.status(400).json({ error: `Row ${i + 1}: pick a BOQ Item (or type a description for manual entry)` });
      if (!hasSub) return res.status(400).json({ error: `Row ${i + 1}: pick a Sub-Item (Item Master)` });
    }

    const tx = db.transaction(() => {
      db.prepare(
        `UPDATE indents SET site_name=?, raised_by_name=?, client_name=?, notes=?,
                            status = CASE WHEN status='rejected' THEN 'submitted' ELSE status END
         WHERE id=?`
      ).run(site_name || '', raised_by_name || '', site_name || '', notes || '', id);

      db.prepare('DELETE FROM indent_items WHERE indent_id=?').run(id);

      const getPoItem = db.prepare('SELECT description, unit, quantity as boq_qty, item_master_id FROM po_items WHERE id=?');
      const getMaster = db.prepare('SELECT item_name, specification, size, uom, type, make FROM item_master WHERE id=?');
      const insertItem = db.prepare(
        `INSERT INTO indent_items
          (indent_id, po_item_id, item_master_id, description, make, quantity, unit, rate, amount, item_type, is_foc, is_tool, required_date)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
      );
      for (const i of items) {
        let desc = i.description || '';
        let unit = i.unit || 'nos';
        let itemType = null;
        let make = i.make || '';
        let masterId = i.item_master_id || null;

        const poItemId = Number.isInteger(+i.po_item_id) && +i.po_item_id > 0 ? +i.po_item_id : null;
        if (poItemId) {
          const p = getPoItem.get(poItemId);
          if (p) {
            desc = p.description || desc;
            // Respect the user's chosen unit on the line — that's the
            // whole point of the unit dropdown. Only fall back to the
            // BOQ's unit if the user didn't pick one.
            if (!i.unit) unit = p.unit || unit;
            if (!masterId && p.item_master_id) masterId = p.item_master_id;
          }
        }
        if (masterId) {
          const m = getMaster.get(masterId);
          if (m) {
            itemType = m.type || itemType;
            if (!make && m.make) make = m.make;
            // Item Master UOM wins (mam, 2026-05-16: "automatic uom
            // pick from itemwise master as per subitem").  Same rule
            // as POST handler — only override if the user explicitly
            // typed a different unit on this edit, else use master's.
            if (m.uom && !i.unit) unit = String(m.uom).toLowerCase();
          }
        }

        const qty = +i.quantity || 0;
        const foc = String(itemType || '').toUpperCase() === 'FOC' ? 1 : 0;
        const tool = String(itemType || '').toUpperCase() === 'RGP' ? 1 : 0;
        insertItem.run(id, poItemId, masterId, desc, make, qty, unit, 0, 0, itemType, foc, tool, i.required_date || null);
      }
    });
    try {
      tx();
      return res.json({ message: 'Indent updated' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Nothing to update' });
});

router.delete('/indents/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  // Active vendor POs (cancelled=0) referencing this indent block hard delete.
  // Cancelled POs don't block — they're already soft-deleted themselves.
  const vpoCount = db.prepare(
    'SELECT COUNT(*) as c FROM vendor_pos WHERE indent_id=? AND COALESCE(cancelled, 0) = 0'
  ).get(id).c;
  if (vpoCount > 0) {
    // Soft-reject instead of failing. The indent + its items stay for audit
    // and the linked vendor POs continue to function. Status='rejected' hides
    // the indent from active "Pending for PO" / "Submitted" queues.
    db.prepare("UPDATE indents SET status='rejected' WHERE id=?").run(id);
    return res.json({ message: `Indent rejected (cannot hard-delete — ${vpoCount} active Vendor PO(s) reference it). Indent kept for audit.`, soft: true });
  }
  db.prepare('DELETE FROM indent_items WHERE indent_id=?').run(id);
  db.prepare('DELETE FROM indents WHERE id=?').run(id);
  res.json({ message: 'Deleted', soft: false });
});

// Print-friendly payload for the indent — same shape mam uses on the
// indent page expanded view (BoQ description + sub-item from item
// master + make + qty + unit + type), plus site + raised-by info
// for the page header. Mam: 'where 19 items show able to download pdf'.
router.get('/indents/:id/print', (req, res) => {
  const db = getDb();
  const indent = db.prepare(`
    SELECT i.*, u.name as created_by_name
    FROM indents i LEFT JOIN users u ON i.created_by = u.id
    WHERE i.id = ?
  `).get(req.params.id);
  if (!indent) return res.status(404).json({ error: 'Indent not found' });
  const items = db.prepare(`
    SELECT ii.*,
           im.item_code, im.item_name as master_name, im.size as master_size, im.uom as master_uom,
           v.name as vendor_name,
           poi.description as boq_description
      FROM indent_items ii
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN vendors v ON v.id = ii.vendor_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
     WHERE ii.indent_id = ?
     ORDER BY ii.id
  `).all(req.params.id);
  res.json({ indent, items });
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
// GET /vendor-po list
// Mam (2026-05-16): "look at actual amount and 2. photo what show" —
// PO print page showed Rs 3,05,208 but the Follow-up: POs awaiting
// Purchase Bill table showed Rs 4,34,043 for the SAME PO.  Root
// cause: vendor_pos.total_amount can drift from the actual sum of
// line items (saved at create time; not auto-updated if items were
// edited).  The print page recomputes live from items + GST, so it's
// always right; the list endpoint was naively returning the stale
// header value.
//
// Fix: compute display_total live from vendor_po_items + 18% GST
// (matches the print logic).  Store side-by-side with the original
// total_amount so admins can see drift.  Frontend uses display_total
// for the Amount column.  Drift > ₹1 also surfaces in /audit later
// as its own exception type (TODO).
router.get('/vendor-po', (req, res) => {
  const db = getDb();
  // Mam (2026-05-20): "show here also indent number so that easily
  // can see".  Added LEFT JOIN indents so each row carries
  // indent_number + site_name for the Follow-up table.
  const rows = db.prepare(`
    SELECT vp.*, v.name as vendor_name,
           ind.indent_number, ind.site_name as indent_site_name,
           COALESCE((
             SELECT ROUND(SUM(vpi.amount) * 1.18, 2)
             FROM vendor_po_items vpi
             WHERE vpi.vendor_po_id = vp.id
           ), vp.total_amount) as display_total
    FROM vendor_pos vp
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    LEFT JOIN indents ind ON vp.indent_id = ind.id
    ORDER BY vp.created_at DESC
  `).all();
  // Surface drift so the frontend can show a small warning chip if
  // the stored header total disagrees with the items sum.
  for (const r of rows) {
    const stored = +r.total_amount || 0;
    const live = +r.display_total || 0;
    r.total_amount_drift = Math.round(Math.abs(stored - live));
  }
  res.json(rows);
});

// Full Vendor PO payload for the print/share page — includes vendor
// contact details, indent info, and every line item with item_master
// fields (code, description, spec, make, uom). Used by /vendor-po/:id/print
// in the client to render a print-friendly PO that mam can save as PDF
// or share to vendor.
router.get('/vendor-po/:id/print', (req, res) => {
  const db = getDb();
  // vendor_pos has no created_by column (verified in schema), so the
  // print page falls back to "Authorized Signatory" when the creator
  // can't be looked up. Indent.created_by is available via the indent
  // join below if mam ever wants the raiser's name on the PO instead.
  // Mam (2026-05-16): the print page must auto-fill Vendor Code,
  // Contact Person, Contact No, and SEPL Lead No from existing
  // masters — NOT leave them blank.  Added v.vendor_code to the
  // SELECT; lead_no resolved via a separate BB lookup below
  // because indents store site_name as free text (no FK).
  const po = db.prepare(`
    SELECT vp.*, v.name as vendor_name, v.firm_name, v.vendor_code,
           v.contact_person,
           v.phone as vendor_phone, v.email as vendor_email,
           v.gst_number, v.address as vendor_address,
           v.district, v.state, v.payment_terms as vendor_payment_terms,
           i.indent_number, i.site_name, i.raised_by_name
      FROM vendor_pos vp
      LEFT JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN indents i ON vp.indent_id = i.id
     WHERE vp.id = ?
  `).get(req.params.id);
  if (!po) return res.status(404).json({ error: 'Vendor PO not found' });

  // SEPL Lead No. lookup — match indent.site_name against the
  // business_book project_name (preferred) or company_name (fallback).
  // Case + whitespace insensitive so "M/s SAEL" matches " m/s sael ".
  // Takes the most recent match — older BB rows for the same site
  // share the lead_no anyway.
  if (po.site_name) {
    try {
      const bb = db.prepare(`
        SELECT lead_no, project_name, company_name, client_name
        FROM business_book
        WHERE LOWER(TRIM(COALESCE(project_name, ''))) = LOWER(TRIM(?))
           OR LOWER(TRIM(COALESCE(company_name, ''))) = LOWER(TRIM(?))
        ORDER BY id DESC LIMIT 1
      `).get(po.site_name, po.site_name);
      if (bb) {
        po.sepl_lead_no = bb.lead_no || null;
        po.project_name_bb = bb.project_name || bb.company_name || null;
        po.client_name_bb = bb.client_name || null;
      }
    } catch (_) { /* non-fatal */ }
  }

  const items = db.prepare(`
    SELECT vpi.id, vpi.quantity, vpi.rate, vpi.amount, vpi.terms, vpi.credit_days,
           ii.description, ii.make as ii_make, ii.unit, ii.required_date,
           im.item_code, im.item_name as master_name, im.specification, im.size, im.uom, im.make as im_make,
           poi.description as boq_description,
           -- Mam (2026-05-21): "update here if i update rate in 3
           -- vendor".  Pull the LATEST finalised rate from the
           -- 3-vendor quote table.  Print page prefers this over the
           -- frozen vendor_po_items.rate so editing the rate later
           -- (in Vendor Rates step) is reflected on every fresh print.
           ir.final_rate as latest_rate,
           ir.final_vendor_name as latest_vendor
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
      LEFT JOIN po_items poi ON poi.id = ii.po_item_id
      LEFT JOIN indent_item_rates ir ON ir.indent_item_id = vpi.indent_item_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  res.json({ po, items });
});

// ── Delivery Note data for a Vendor PO (mam 2026-05-22) ──────────
// Given a vendor_po id, returns ALL the data needed to render an
// SEPL Delivery Note: PO + vendor + indent + business_book client
// info + items.  Print-on-demand from the existing PO data — no
// delivery_notes table row required.  Client renders the template
// at /vendor-po/:id/delivery-note.
//
// Mam's spec — fields the DN template needs (extracted from
// SEPL_Delivery_Note_Template.pdf she shared):
//   Header meta:    DN No (auto-suggest), Date (today), SEPL PO No, Indent No
//   Client block:   Company name (M/s ...), Billing address, GSTIN
//   Site block:     Site name, Shipping address, Site engineer/contact
//   Items table:    SL · Description / Spec / Make · HSN · Qty · UOM · Remarks
//   Transport box:  Vehicle No · Driver Name & Mobile · LR/Challan No · Total Packages
//                   (these are filled in by HAND at dispatch time — left blank in print)
router.get('/vendor-po/:id/delivery-note-data', (req, res) => {
  const db = getDb();
  const data = db.prepare(`
    SELECT vp.id as po_id, vp.po_number, vp.po_date,
           v.name as vendor_name, v.gst_number as vendor_gstin,
           v.address as vendor_address, v.phone as vendor_phone,
           v.contact_person as vendor_contact,
           i.indent_number, i.site_name as indent_site_name,
           i.raised_by_name as site_engineer_name,
           bb.company_name as client_company,
           bb.client_name as client_person_name,
           bb.client_contact as client_phone, bb.client_email,
           bb.billing_address as client_address,
           bb.shipping_address as site_address,
           bb.state as client_state, bb.district as client_district,
           bb.gstin as client_gstin, bb.state_code as client_state_code,
           bb.project_name as bb_project_name,
           bb.lead_no as bb_lead_no
      FROM vendor_pos vp
      LEFT JOIN vendors v ON vp.vendor_id = v.id
      LEFT JOIN indents i ON vp.indent_id = i.id
      LEFT JOIN order_planning op ON op.id = i.planning_id
      LEFT JOIN business_book bb ON bb.id = op.business_book_id
     WHERE vp.id = ?
  `).get(req.params.id);
  if (!data) return res.status(404).json({ error: 'Vendor PO not found' });

  // Items — only the columns the DN template shows.  Pull from
  // indent_items via vendor_po_items (the items actually purchased
  // under THIS PO, not the full indent).
  const items = db.prepare(`
    SELECT vpi.id, vpi.quantity,
           COALESCE(NULLIF(TRIM(im.item_name), ''), ii.description) as description,
           im.specification, im.size,
           COALESCE(im.make, ii.make) as make,
           COALESCE(im.uom, ii.unit) as uom,
           im.item_code,
           im.hsn_code, im.gst as gst_text
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
      LEFT JOIN item_master im ON im.id = ii.item_master_id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);

  // Pre-compute a suggested DN number — mam can override on print
  // but most of the time today's date + PO number is enough.
  const today = new Date();
  const yy = String(today.getFullYear()).slice(2);
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  data.dn_number_suggested = `DN-${yy}${mm}${dd}-${data.po_number?.replace(/\W+/g, '') || data.po_id}`;

  res.json({ po: data, items });
});

// Items of a given indent, with finalized rate info and whether each item is
// already covered by a Vendor PO. Used to populate the item-checkbox grid in
// the Create Vendor PO modal.
router.get('/indents/:id/items-for-po', (req, res) => {
  const db = getDb();
  const rows = db.prepare(
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity, ii.unit, ii.item_type,
            ii.item_master_id, ii.required_date,
            im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            r.final_rate, r.final_vendor_name, r.final_terms, r.final_credit_days, r.status as rate_status,
            (SELECT COUNT(*) FROM vendor_po_items vpi
              JOIN vendor_pos vp_check ON vp_check.id = vpi.vendor_po_id
              WHERE vpi.indent_item_id = ii.id AND COALESCE(vp_check.cancelled, 0) = 0) as in_po_count
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
     WHERE NOT EXISTS (
       SELECT 1 FROM vendor_po_items vpi
         JOIN vendor_pos vp ON vp.id = vpi.vendor_po_id
        WHERE vpi.indent_item_id = ii.id
          AND COALESCE(vp.cancelled, 0) = 0
     )
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
router.post('/vendor-po', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const db = getDb();
  const b = req.body || {};
  const vendor_id = +b.vendor_id;
  const indent_id = b.indent_id ? +b.indent_id : null;
  if (!vendor_id) return res.status(400).json({ error: 'Vendor is required' });
  // PO file is now OPTIONAL — mam's flow: the PO is created in the ERP itself,
  // there's no Tally PDF to upload anymore. Users can still attach a file
  // (e.g. a signed scan once printed) but it's no longer required.

  // Parse optional line items (JSON string in multipart form)
  let items = [];
  if (b.items) {
    try { items = JSON.parse(b.items); } catch (e) { return res.status(400).json({ error: 'items must be valid JSON' }); }
  }
  const lines = Array.isArray(items) ? items.filter(i => i.indent_item_id && +i.quantity > 0 && +i.rate > 0) : [];

  // PO number is always auto-generated with a year-stamped pattern
  // VPO/YYYY/#### (e.g. VPO/2026/0001) — mam's "professional behaviour"
  // requirement. Any po_number sent by the client is ignored so we have
  // a single authoritative numbering source.
  const { nextSequence } = require('../db/nextSequence');
  const yr = new Date().getFullYear();
  const poNum = nextSequence(db, 'vendor_pos', 'po_number', `VPO/${yr}/`, { startFrom: 0, pad: 4 });

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

// PUT /vendor-po/:id  —  status / advance OR full header edit.
// Mam (2026-05-20): "how can i edit po after creation because
// some time need".  Same endpoint handles both legacy callers
// (status / advance_paid only) and the new full-edit modal
// (po_date, expected_receipt_date, total_amount, advance_required,
// remarks, vendor_id).  po_number stays immutable.
//
// Guards:
//   - Cancelled POs must be uncancelled before editing.
//   - PO with linked Purchase Bills can edit dates / remarks but
//     NOT total_amount / vendor_id (those would invalidate the bill).
router.put('/vendor-po/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const b = req.body || {};
  const cur = db.prepare('SELECT * FROM vendor_pos WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Vendor PO not found' });
  if (cur.cancelled) return res.status(400).json({ error: 'PO is cancelled — restore it before editing.' });

  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(id).c;
  const sets = []; const params = [];
  const set = (k, v) => { sets.push(`${k}=?`); params.push(v); };

  // Legacy fields (kept for backwards compat with status / advance toggle)
  if (b.status !== undefined)        set('status', b.status);
  if (b.advance_paid !== undefined)  set('advance_paid', b.advance_paid ? 1 : 0);

  // New editable header fields (mam's full-edit modal)
  if (b.po_date !== undefined)               set('po_date', b.po_date || null);
  if (b.expected_receipt_date !== undefined) set('expected_receipt_date', b.expected_receipt_date || null);
  if (b.remarks !== undefined)               set('remarks', b.remarks || null);
  if (b.advance_required !== undefined)      set('advance_required', +b.advance_required || 0);

  // High-impact edits: blocked when bills exist (would invalidate them)
  if (b.total_amount !== undefined) {
    if (billCount > 0) {
      return res.status(409).json({ error: `Cannot change total_amount — ${billCount} purchase bill(s) reference this PO. Cancel the bill first or use Restore-then-recreate.` });
    }
    set('total_amount', +b.total_amount || 0);
  }
  if (b.vendor_id !== undefined) {
    if (billCount > 0) {
      return res.status(409).json({ error: `Cannot change vendor — ${billCount} purchase bill(s) reference this PO. Cancel the bill first.` });
    }
    set('vendor_id', +b.vendor_id || null);
  }

  if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
  db.prepare(`UPDATE vendor_pos SET ${sets.join(', ')} WHERE id=?`).run(...params, id);
  res.json({ message: 'Updated', changed: sets.length });
});

router.delete('/vendor-po/:id', (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const billCount = db.prepare('SELECT COUNT(*) as c FROM purchase_bills WHERE vendor_po_id=?').get(id).c;
  const dnCount = db.prepare('SELECT COUNT(*) as c FROM delivery_notes WHERE vendor_po_id=?').get(id).c;
  // Hard delete is only allowed when nothing references this PO. Otherwise
  // the user should use POST /vendor-po/:id/cancel which is a soft-delete
  // that preserves the audit trail + linked bills / delivery notes.
  if (billCount > 0 || dnCount > 0) return res.status(409).json({ error: `Cannot delete — ${billCount} bill(s) and ${dnCount} delivery note(s) reference this PO. Use Cancel PO instead.` });
  db.prepare('DELETE FROM vendor_pos WHERE id=?').run(id);
  res.json({ message: 'Deleted' });
});

// Soft-cancel a Vendor PO. Hides it from "Pending for PO" / "Awaiting Bill" /
// "Ready to Dispatch" follow-up lists while preserving the row + every
// linked bill / delivery note for audit. Reversible via /uncancel.
router.post('/vendor-po/:id/cancel', needsApprove, (req, res) => {
  const db = getDb();
  const id = req.params.id;
  const { reason } = req.body || {};
  const cur = db.prepare('SELECT id, cancelled FROM vendor_pos WHERE id=?').get(id);
  if (!cur) return res.status(404).json({ error: 'Vendor PO not found' });
  if (cur.cancelled) return res.status(400).json({ error: 'PO is already cancelled' });
  db.prepare(`
    UPDATE vendor_pos
       SET cancelled = 1,
           cancelled_at = CURRENT_TIMESTAMP,
           cancelled_by = ?,
           cancel_reason = ?
     WHERE id = ?
  `).run(req.user.id, String(reason || '').trim() || null, id);
  res.json({ message: 'PO cancelled' });
});

router.post('/vendor-po/:id/uncancel', needsApprove, (req, res) => {
  const db = getDb();
  db.prepare(`
    UPDATE vendor_pos
       SET cancelled = 0, cancelled_at = NULL, cancelled_by = NULL, cancel_reason = NULL
     WHERE id = ?
  `).run(req.params.id);
  res.json({ message: 'PO restored' });
});

// Admin-only: clear an item-rate row entirely. Wipes the 3 vendor quotes +
// any finalize fields. Indent_item itself stays intact so the row reappears
// in the Vendor Rates list as "Pending" — admin can re-quote from scratch.
router.delete('/item-rates/:rate_id', needsApprove, (req, res) => {
  const db = getDb();
  const cur = db.prepare('SELECT id, indent_item_id FROM indent_item_rates WHERE id=?').get(req.params.rate_id);
  if (!cur) return res.status(404).json({ error: 'Rate not found' });
  db.prepare('DELETE FROM indent_item_rates WHERE id=?').run(req.params.rate_id);
  res.json({ message: 'Rate cleared' });
});

// Purchase Bills
router.get('/purchase-bills', (req, res) => {
  res.json(getDb().prepare(`SELECT pb.*, v.name as vendor_name FROM purchase_bills pb
    LEFT JOIN vendors v ON pb.vendor_id=v.id ORDER BY pb.created_at DESC`).all());
});

// Purchase bill creation supports an optional file upload (PDF / image / xlsx)
// via multipart/form-data, the same pattern as Vendor PO upload. If no file
// is attached it still works — mam sometimes captures a bill without a scan.
router.post('/purchase-bills', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  if (!req.file) return res.status(400).json({ error: 'Bill file is required — upload the vendor bill' });
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
router.post('/delivery-notes', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  // File is OPTIONAL on create. Mam's flow: ERP generates the document
  // (Delivery Note / Sales Bill PDF via the new print endpoint), staff
  // print it, get it signed at delivery, then upload the signed copy.
  // The signed copy can be added later via PUT /dispatches/:id.
  const vendor_po_id = b.vendor_po_id ? +b.vendor_po_id : null;
  const delivery_date = b.delivery_date || null;
  const notes = b.notes || null;
  const document_type = b.document_type || null;     // 'sales_bill' or 'challan'
  if (!document_type || !['sales_bill', 'challan'].includes(document_type)) {
    return res.status(400).json({ error: 'Dispatch type (Sales Bill or Challan) is required' });
  }
  // Auto-generate the document number when not supplied so mam doesn't
  // have to think up a unique INV/DC number herself. Format:
  //   Sales Bill -> INV/{year}/{0001+}   e.g. INV/2026/0042
  //   Challan    -> DC/{year}/{0001+}    e.g. DC/2026/0042
  // The nextSequence helper scans existing rows for the same prefix and
  // returns max+1, so deleting a row doesn't break uniqueness.
  let document_number = b.document_number && String(b.document_number).trim();
  if (!document_number) {
    const { nextSequence } = require('../db/nextSequence');
    const year = new Date().getFullYear();
    const prefix = (document_type === 'sales_bill' ? `INV/${year}/` : `DC/${year}/`);
    document_number = nextSequence(getDb(), 'delivery_notes', 'document_number', prefix, { pad: 4 });
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

  const num = (v) => { const n = +v; return Number.isFinite(n) ? n : 0; };
  // Per-line-item overrides — JSON array of {description, hsn, unit, qty,
  // rate, disc_pct, amount, include}. Defaults to whatever Client PO had;
  // the form lets mam tweak qty/rate/disc per row before generating.
  let itemsJson = null;
  if (Array.isArray(b.items) && b.items.length) {
    try { itemsJson = JSON.stringify(b.items.filter(it => it && it.include !== false)); } catch (_) {}
  } else if (typeof b.items === 'string' && b.items.trim()) {
    itemsJson = b.items;
  }
  const fields = {
    // Delivery-Note extras
    vehicle_no: b.vehicle_no || null,
    driver_name: b.driver_name || null,
    driver_mobile: b.driver_mobile || null,
    lr_challan_no: b.lr_challan_no || null,
    total_packages: b.total_packages || null,
    // Sales-Bill extras
    place_of_supply: b.place_of_supply || null,
    state_code: b.state_code || null,
    reverse_charge: b.reverse_charge ? 1 : 0,
    e_way_bill_no: b.e_way_bill_no || null,
    cgst_pct: num(b.cgst_pct),
    sgst_pct: num(b.sgst_pct),
    igst_pct: num(b.igst_pct),
    freight_amount: num(b.freight_amount),
    round_off_amount: num(b.round_off_amount),
    subtotal_amount: num(b.subtotal_amount),
    grand_total_amount: num(b.grand_total_amount),
    items_json: itemsJson,
  };

  try {
    const r = getDb().prepare(
      `INSERT INTO delivery_notes (vendor_po_id, delivery_date, received_by, notes,
                                    document_type, document_number, file_path,
                                    vehicle_no, driver_name, driver_mobile, lr_challan_no, total_packages,
                                    place_of_supply, state_code, reverse_charge, e_way_bill_no,
                                    cgst_pct, sgst_pct, igst_pct, freight_amount, round_off_amount,
                                    subtotal_amount, grand_total_amount)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(vendor_po_id, delivery_date, req.user.id, notes, document_type, document_number, filePath,
      fields.vehicle_no, fields.driver_name, fields.driver_mobile, fields.lr_challan_no, fields.total_packages,
      fields.place_of_supply, fields.state_code, fields.reverse_charge, fields.e_way_bill_no,
      fields.cgst_pct, fields.sgst_pct, fields.igst_pct, fields.freight_amount, fields.round_off_amount,
      fields.subtotal_amount, fields.grand_total_amount);
    res.status(201).json({ id: r.lastInsertRowid, file_path: filePath, document_number, document_type });
  } catch (err) {
    if (filePath) { try { fs.unlinkSync(path.join(uploadDir, path.basename(filePath))); } catch (e) {} }
    res.status(500).json({ error: err.message });
  }
});

// Mark a dispatch as "Received by <name> on <date>" and attach the stamped +
// signed receipt photo as proof. Mam flagged this as business-critical: without
// the signed proof, clients sometimes deny receipt and SEPL eats the loss.
// Multipart so the receipt photo can ride along with the metadata.
router.patch('/delivery-notes/:id/receive', needsApprove, vendorPoUpload.single('file'), (req, res) => {
  const b = req.body || {};
  const received_by_name = b.received_by_name;
  const received_at = b.received_at;
  if (!received_by_name || !String(received_by_name).trim()) {
    return res.status(400).json({ error: 'Received-by name is required' });
  }
  if (!req.file) {
    return res.status(400).json({ error: 'Receipt proof photo is required — attach the stamped + signed document' });
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

  // Optional inventory hook — if mam picked a warehouse_id, the items
  // from the linked vendor_po auto-land as stock IN. Skipped silently if
  // no warehouse selected (legacy behavior).
  const warehouseId = b.warehouse_id ? +b.warehouse_id : null;

  try {
    db.prepare(
      `UPDATE delivery_notes
         SET received_by_name = ?,
             received_at = COALESCE(?, CURRENT_TIMESTAMP),
             receipt_file_path = COALESCE(?, receipt_file_path),
             status = 'received',
             warehouse_id = COALESCE(?, warehouse_id)
       WHERE id = ?`
    ).run(String(received_by_name).trim(), received_at || null, receiptPath, warehouseId, req.params.id);

    // INVENTORY AUTO-IN — best effort; never blocks the receipt save.
    let stockIns = 0;
    if (warehouseId) {
      try {
        // Pull the line items via vendor_po → vendor_po_items → indent_items
        const dn = db.prepare('SELECT vendor_po_id FROM delivery_notes WHERE id=?').get(req.params.id);
        if (dn?.vendor_po_id) {
          const items = db.prepare(
            `SELECT vpi.quantity, vpi.rate, ii.item_master_id, ii.description
               FROM vendor_po_items vpi
               LEFT JOIN indent_items ii ON ii.id = vpi.indent_item_id
              WHERE vpi.vendor_po_id = ?`
          ).all(dn.vendor_po_id);

          // Idempotency: skip if movements for this delivery_note already exist
          const refId = `DN-${req.params.id}`;
          const existingMv = db.prepare(
            `SELECT 1 FROM stock_movements WHERE reference_type='RECEIVE' AND reference_id=? LIMIT 1`
          ).get(refId);
          if (!existingMv) {
            const tx = db.transaction(() => {
              for (const i of items) {
                if (!i.item_master_id || !(+i.quantity > 0)) continue;
                const cur = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id=? AND item_master_id=?').get(warehouseId, i.item_master_id);
                const prevQty = cur ? +cur.quantity : 0;
                const prevRate = cur ? +cur.avg_rate : 0;
                const qty = +i.quantity;
                const rate = +(i.rate || 0);
                const newQty = prevQty + qty;
                const newAvg = newQty > 0 ? ((prevQty * prevRate) + (qty * rate)) / newQty : 0;
                if (cur) db.prepare('UPDATE stock_balance SET quantity=?, avg_rate=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(newQty, newAvg, cur.id);
                else db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate) VALUES (?,?,?,?)').run(warehouseId, i.item_master_id, newQty, newAvg);
                db.prepare(
                  `INSERT INTO stock_movements
                    (warehouse_id, item_master_id, type, quantity, rate, total_value,
                     reference_type, reference_id, notes, created_by)
                   VALUES (?,?,?,?,?,?,?,?,?,?)`
                ).run(warehouseId, i.item_master_id, 'IN', qty, rate, qty * rate, 'RECEIVE', refId, `Auto-IN from delivery note #${req.params.id}`, req.user.id);
                stockIns += 1;
              }
            });
            tx();
          }
        }
      } catch (e) {
        console.error('[receive] auto-IN failed (receipt saved anyway):', e.message);
      }
    }

    res.json({ message: 'Marked as received', receipt_file_path: receiptPath, stock_ins: stockIns });
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

// Pre-fill items for the Sales Bill / Delivery Note modal. Mam picks a
// vendor PO; the modal needs the Client PO line items (po_items) so she
// can tweak qty / rate / disc % per row before generating. We resolve
// the same chain the print endpoint uses:
//   vendor_pos.indent_id → indents.planning_id → order_planning.business_book_id
//   → po_items.business_book_id
// Returns the po_items in the order they were entered. Client-side falls
// back to vendor_po_items if nothing comes back.
// Resolve "Bill To" client info for a Vendor PO — used by the
// Create Sales Bill modal to pre-fill the customer block.  Same
// chain the print endpoint uses (vendor_pos → indents →
// order_planning → business_book) plus the linked client PO if any.
// Mam (2026-05-16): "no client / bill-to block" was issue #1 on
// the modal review.
router.get('/vendor-pos/:id/bill-to', (req, res) => {
  const db = getDb();
  const r = db.prepare(`
    SELECT bb.id as business_book_id, bb.lead_no,
           bb.company_name AS client_company,
           bb.client_name  AS client_person_name,
           bb.project_name,
           bb.client_contact AS client_phone, bb.client_email,
           bb.billing_address AS client_address,
           bb.shipping_address AS site_address,
           bb.state AS client_state,
           bb.district AS client_district,
           bb.gstin AS client_gstin,
           bb.state_code AS client_state_code,
           po.po_number AS client_po_number, po.po_date AS client_po_date,
           v.name AS vendor_name, vp.po_number AS vendor_po_no,
           COALESCE(NULLIF(TRIM(ind.site_name), ''), bb.project_name) AS site_name
    FROM vendor_pos vp
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    LEFT JOIN indents ind ON vp.indent_id = ind.id
    LEFT JOIN order_planning op ON ind.planning_id = op.id
    LEFT JOIN business_book bb ON bb.id = op.business_book_id
    LEFT JOIN purchase_orders po ON op.po_id = po.id
    WHERE vp.id = ?
  `).get(req.params.id);
  if (!r) return res.status(404).json({ error: 'Vendor PO not found' });
  res.json(r);
});

router.get('/vendor-pos/:id/client-po-items', (req, res) => {
  const db = getDb();
  // Sales Bill must always quote the BOQ SITC rate (mam, 2026-05-16:
  // "if sales bill we enter BOQ SITC rate which you can now according
  // BOQ rate").  Pass ?doc_type=sales_bill to disable the vendor-cost
  // fallback — better empty + clear warning than wrong rate billed.
  const docType = String(req.query.doc_type || '').toLowerCase();
  const isSalesBill = docType === 'sales_bill';
  const rows = db.prepare(`
    SELECT pi.id, pi.description, pi.quantity, pi.unit, pi.rate, pi.amount,
           pi.hsn_code,
           im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM po_items pi
      LEFT JOIN item_master im ON pi.item_master_id = im.id
     WHERE pi.business_book_id = (
       SELECT op.business_book_id
         FROM vendor_pos vp
         JOIN indents ind ON ind.id = vp.indent_id
         JOIN order_planning op ON op.id = ind.planning_id
        WHERE vp.id = ?
     )
     ORDER BY pi.id
  `).all(req.params.id);

  if (rows.length) {
    // Count rows with usable rates — surfaces a warning when BOQ was
    // uploaded but rates are all zero (i.e. BOQ stub, not priced yet).
    const ratedCount = rows.filter(r => +r.rate > 0).length;
    return res.json({
      items: rows,
      source: 'po_items',
      rate_source: 'boq_sitc',
      rated_count: ratedCount,
      total_count: rows.length,
    });
  }

  // No Client PO items found.  For Sales Bill we refuse to fall
  // back to vendor cost — that would be billing the wrong amount.
  // Return empty + a clear reason so the UI can show a red warning.
  if (isSalesBill) {
    return res.json({
      items: [],
      source: 'empty',
      rate_source: null,
      warning: 'No Client PO / BOQ items linked to this Vendor PO. Sales Bill needs BOQ SITC rates — upload the Client PO with BOQ first, OR add rows manually with the right selling rate.',
    });
  }

  // Challan (or other non-billable doc) — vendor PO fallback is fine.
  const vpRows = db.prepare(`
    SELECT vpi.id, ii.description, vpi.quantity, ii.unit, vpi.rate, vpi.amount,
           NULL AS hsn_code,
           im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON vpi.indent_item_id = ii.id
      LEFT JOIN item_master im ON ii.item_master_id = im.id
     WHERE vpi.vendor_po_id = ?
     ORDER BY vpi.id
  `).all(req.params.id);
  res.json({ items: vpRows, source: 'vendor_po', rate_source: 'vendor_cost' });
});

// Print-page renderer for a dispatch row. Returns a self-contained HTML
// page styled to match mam's SEPL Delivery Note / Sales Bill templates
// (red header, two-column blocks, 8-row item table, totals + bank +
// terms for SB, transport + receipt block for DN). The page is intended
// to be opened in a new tab; user hits Ctrl+P → prints to A4.
router.get('/delivery-notes/:id/print', (req, res) => {
  const db = getDb();
  // Resolve client + site info through:
  //   delivery_notes → vendor_pos → indents → order_planning → business_book
  // Joining business_book directly via op.business_book_id is the most
  // reliable path — going through purchase_orders.business_book_id used
  // to leave bb fields null when op.po_id was absent. mam's screenshot
  // showed empty CLIENT / COMPANY + DELIVERY SITE blocks for that
  // reason. Also prefer ind.site_name over bb.project_name when set,
  // since one BB record can have multiple indent sites.
  const dn = db.prepare(`
    SELECT dn.*, vp.po_number AS vendor_po_no,
           v.name AS vendor_name, v.gst_number AS vendor_gstin, v.address AS vendor_address,
           v.phone AS vendor_phone, v.email AS vendor_email,
           po.po_number AS client_po_no, po.po_date AS client_po_date,
           bb.company_name AS client_company, bb.client_name AS client_person_name,
           bb.client_contact AS client_phone, bb.client_email,
           bb.billing_address AS client_address, bb.shipping_address AS site_address,
           bb.state AS client_state, bb.district AS client_district,
           bb.gstin AS client_gstin, bb.state_code AS client_state_code,
           COALESCE(NULLIF(TRIM(ind.site_name), ''), bb.project_name) AS site_name,
           ind.indent_number,
           bb.lead_no AS bb_lead_no
    FROM delivery_notes dn
    LEFT JOIN vendor_pos vp ON dn.vendor_po_id = vp.id
    LEFT JOIN vendors v ON vp.vendor_id = v.id
    LEFT JOIN indents ind ON vp.indent_id = ind.id
    LEFT JOIN order_planning op ON ind.planning_id = op.id
    LEFT JOIN business_book bb ON bb.id = op.business_book_id
    LEFT JOIN purchase_orders po ON op.po_id = po.id
    WHERE dn.id = ?
  `).get(req.params.id);
  if (!dn) return res.status(404).send('Dispatch not found');

  // Resolve items in priority order:
  //   1) dn.items_json — per-row overrides the user tweaked in the create
  //      modal (qty / rate / disc % / include flag). Authoritative when set.
  //   2) po_items — the Client PO line items (selling price). For a SALES
  //      BILL this is what mam actually invoices; vendor cost would be wrong.
  //   3) vendor_po_items — vendor cost fallback. Used when there's no
  //      Client PO link (rare edge case for FOC challans, etc.).
  let items = [];
  let itemsSource = 'vendor_po';
  if (dn.items_json) {
    try {
      const parsed = JSON.parse(dn.items_json);
      if (Array.isArray(parsed) && parsed.length) {
        items = parsed
          .filter(it => it && it.include !== false)
          .map(it => ({
            description: it.description || '',
            quantity: +it.quantity || 0,
            unit: it.unit || '',
            rate: +it.rate || 0,
            disc_pct: +it.disc_pct || 0,
            amount: +it.amount || ((+it.quantity || 0) * (+it.rate || 0) * (1 - (+it.disc_pct || 0) / 100)),
            item_code: it.item_code || it.hsn || '',
            specification: it.specification || '',
            size: it.size || '',
            gst_text: it.hsn || it.gst_text || '',
            item_name: it.item_name || '',
          }));
        itemsSource = 'overrides';
      }
    } catch (_) { /* fall through to po_items */ }
  }
  if (!items.length) {
    // Client PO line items via the chain:
    //   delivery_notes.vendor_po_id → vendor_pos.indent_id
    //   → indents.planning_id → order_planning.business_book_id
    //   → po_items.business_book_id
    const poItems = db.prepare(`
      SELECT pi.description, pi.quantity, pi.unit, pi.rate, pi.amount,
             pi.hsn_code,
             im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM po_items pi
      LEFT JOIN item_master im ON pi.item_master_id = im.id
      WHERE pi.business_book_id = (
        SELECT op.business_book_id
        FROM vendor_pos vp
        JOIN indents ind ON ind.id = vp.indent_id
        JOIN order_planning op ON op.id = ind.planning_id
        WHERE vp.id = ?
      )
      ORDER BY pi.id
    `).all(dn.vendor_po_id);
    if (poItems.length) {
      items = poItems.map(it => ({
        description: it.description || '',
        quantity: +it.quantity || 0,
        unit: it.unit || '',
        rate: +it.rate || 0,
        disc_pct: 0,
        amount: +it.amount || ((+it.quantity || 0) * (+it.rate || 0)),
        item_code: it.item_code || '',
        specification: it.specification || '',
        size: it.size || '',
        gst_text: it.hsn_code || it.gst_text || '',
        item_name: it.item_name || '',
      }));
      itemsSource = 'po_items';
    }
  }
  if (!items.length) {
    // Last-resort fallback — vendor cost. Used only when no Client PO row
    // can be located (e.g. FOC challan from a stand-alone indent).
    const vpItems = db.prepare(`
      SELECT ii.description, vpi.quantity, ii.unit, vpi.rate, vpi.amount,
             im.item_code, im.specification, im.size, im.gst AS gst_text, im.item_name
      FROM vendor_po_items vpi
      LEFT JOIN indent_items ii ON vpi.indent_item_id = ii.id
      LEFT JOIN item_master im ON ii.item_master_id = im.id
      WHERE vpi.vendor_po_id = ?
      ORDER BY vpi.id
    `).all(dn.vendor_po_id);
    items = vpItems.map(it => ({
      description: it.description || '',
      quantity: +it.quantity || 0,
      unit: it.unit || '',
      rate: +it.rate || 0,
      disc_pct: 0,
      amount: +it.amount || ((+it.quantity || 0) * (+it.rate || 0)),
      item_code: it.item_code || '',
      specification: it.specification || '',
      size: it.size || '',
      gst_text: it.gst_text || '',
      item_name: it.item_name || '',
    }));
  }

  const isSalesBill = dn.document_type === 'sales_bill';
  // Ship the HTML as a UTF-8 Buffer so the ₹ / em-dash / 🖨 emoji
  // round-trip cleanly through proxies that otherwise re-encode the
  // body as Latin-1. Earlier mam saw mojibake on the printed bill
  // ("â¹" instead of "₹") — explicit Buffer encoding is the fix.
  const html = renderDispatchHTML({ dn, items, isSalesBill, itemsSource });
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(Buffer.from(html, 'utf8'));
});

// HTML template renderer — kept inline so it stays self-contained and
// matches the PDFs mam supplied. All styling is inline / in a <style>
// block; no external assets. Tested on Chrome/Edge → A4 portrait.
function renderDispatchHTML({ dn, items, isSalesBill }) {
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const fmt = (n) => (+n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numToWords = (() => {
    // Compact Indian-number-to-words for invoice amounts.
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = (n) => n < 20 ? a[n] : `${b[Math.floor(n / 10)]}${n % 10 ? ' ' + a[n % 10] : ''}`;
    const three = (n) => n >= 100 ? `${a[Math.floor(n / 100)]} Hundred${n % 100 ? ' ' + two(n % 100) : ''}` : two(n);
    return (n) => {
      n = Math.floor(+n || 0);
      if (!n) return 'Zero';
      const parts = [];
      const crore = Math.floor(n / 10000000); n %= 10000000;
      const lakh = Math.floor(n / 100000); n %= 100000;
      const thousand = Math.floor(n / 1000); n %= 1000;
      const hundred = n;
      if (crore) parts.push(`${two(crore)} Crore`);
      if (lakh) parts.push(`${two(lakh)} Lakh`);
      if (thousand) parts.push(`${two(thousand)} Thousand`);
      if (hundred) parts.push(three(hundred));
      return parts.join(' ').trim();
    };
  })();

  // Build items rows (pad to 8 like the template)
  const padCount = Math.max(0, 8 - items.length);
  const rowsHtml = items.map((it, idx) => {
    const desc = [it.description, it.specification, it.size].filter(Boolean).join(' / ');
    const qty = +it.quantity || 0;
    const rate = +it.rate || 0;
    const discPct = +it.disc_pct || 0;
    const gross = qty * rate;
    // Taxable = gross - line discount. If amount was stored we trust it;
    // otherwise compute from the disc %.
    const taxable = +it.amount || (gross * (1 - discPct / 100));
    if (isSalesBill) {
      return `<tr><td class="num">${idx + 1}</td><td>${esc(desc)}</td><td class="num">${esc(it.gst_text || '')}</td><td class="num">${fmt(qty)}</td><td>${esc(it.unit || '')}</td><td class="num">${fmt(rate)}</td><td class="num">${discPct ? fmt(discPct) : '0'}</td><td class="num">${fmt(taxable)}</td><td class="num">${fmt(taxable)}</td></tr>`;
    }
    return `<tr><td class="num">${idx + 1}</td><td>${esc(desc)}</td><td class="num">${esc(it.gst_text || '')}</td><td class="num">${fmt(qty)}</td><td>${esc(it.unit || '')}</td><td></td></tr>`;
  }).join('') + Array.from({ length: padCount }, (_, i) => {
    const idx = items.length + i + 1;
    return isSalesBill
      ? `<tr><td class="num">${idx}</td><td></td><td></td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`
      : `<tr><td class="num">${idx}</td><td></td><td></td><td></td><td></td><td></td></tr>`;
  }).join('');

  const css = `
    @page { size: A4; margin: 12mm 10mm; }
    * { box-sizing: border-box; }
    body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #1a1a1a; margin: 0; padding: 0; }
    /* Browser preview: render the document as an A4 "paper" centered on
       a grey background so what mam sees on screen matches what comes
       out of the printer. The @page rule above governs the actual print
       so we don't double-up margins. */
    @media screen {
      html { background: #e5e5e5; }
      body { width: 210mm; min-height: 297mm; margin: 8mm auto; padding: 12mm 10mm; background: white; box-shadow: 0 2px 12px rgba(0,0,0,0.15); }
    }
    /* Underline placeholder for empty fillable values — makes the
       generated bill look like the printed template ("M/s ______") when
       a field isn't filled in the source data yet. */
    .blank { display: inline-block; min-width: 140px; border-bottom: 1px dotted #999; height: 1em; vertical-align: bottom; }
    .header { background: #7a1b1b; color: #fff; padding: 8px 12px; display: flex; justify-content: space-between; align-items: center; }
    .header .gstin, .header .pan { font-size: 10px; }
    .header .title { font-size: 18px; font-weight: bold; letter-spacing: 1px; }
    .companyblock { text-align: center; padding: 6px; }
    .companyblock h1 { font-size: 16px; margin: 0 0 4px 0; color: #7a1b1b; }
    .companyblock .addr { font-size: 9.5px; color: #444; }
    .companyblock .tag { font-size: 9.5px; color: #444; margin-top: 2px; }
    table.meta, table.parties, table.items, table.totals, table.foot { width: 100%; border-collapse: collapse; }
    table.meta td, table.parties td { border: 1px solid #e7d4d4; padding: 6px 8px; vertical-align: top; }
    table.meta .lbl, table.parties .lbl { background: #f8efef; color: #7a1b1b; font-weight: bold; font-size: 9.5px; text-transform: uppercase; }
    table.items { margin-top: 6px; border: 1px solid #e7d4d4; }
    table.items th { background: #f8efef; color: #7a1b1b; font-size: 10px; padding: 6px 4px; border: 1px solid #e7d4d4; text-transform: uppercase; }
    table.items td { border: 1px solid #e7d4d4; padding: 5px 4px; font-size: 10px; min-height: 18px; }
    table.items td.num { text-align: right; }
    table.totals { margin-top: 6px; }
    table.totals td { padding: 4px 8px; font-size: 11px; }
    table.totals .label { text-align: right; color: #444; }
    table.totals .val { text-align: right; width: 130px; }
    table.totals .grand { background: #f8efef; color: #7a1b1b; font-weight: bold; font-size: 13px; }
    .bank, .terms { border: 1px solid #e7d4d4; padding: 6px 8px; font-size: 10px; margin-top: 6px; }
    .bank .hdr, .terms .hdr { background: #f8efef; color: #7a1b1b; font-weight: bold; padding: 4px 6px; margin: -6px -8px 6px -8px; text-transform: uppercase; font-size: 10px; }
    .signblk { border: 1px solid #e7d4d4; margin-top: 6px; padding: 6px 8px; }
    .signblk .hdr { background: #f8efef; color: #7a1b1b; font-weight: bold; padding: 4px 6px; margin: -6px -8px 6px -8px; text-transform: uppercase; font-size: 10px; text-align: center; }
    .signblk .row { display: flex; gap: 16px; margin-top: 18px; }
    .signblk .row > div { flex: 1; border-top: 1px solid #888; padding-top: 4px; font-size: 10px; text-align: center; }
    .notice { margin-top: 6px; padding: 6px 8px; background: #f8efef; color: #7a1b1b; font-weight: bold; text-align: center; font-size: 10px; border: 1px solid #e7d4d4; }
    ul.checklist { font-size: 9.5px; padding-left: 16px; margin: 4px 0; color: #444; }
    .footnote { text-align: center; font-size: 9.5px; color: #888; padding: 8px; border-top: 1px dashed #ccc; margin-top: 10px; }
    .print-btn { position: fixed; top: 10px; right: 10px; padding: 8px 14px; background: #7a1b1b; color: white; border: none; border-radius: 4px; cursor: pointer; font-size: 13px; box-shadow: 0 2px 6px rgba(0,0,0,0.2); }
    @media print { .print-btn { display: none; } }
  `;

  const docTitle = isSalesBill ? 'TAX INVOICE / SALES BILL' : 'DELIVERY NOTE';
  // Use the stored document_number (auto-generated INV/YYYY/#### or
  // DC/YYYY/####); only fall back to id-based if somehow blank.
  const docNo = dn.document_number || (isSalesBill ? `INV/${new Date().getFullYear()}/${dn.id}` : `DN/${new Date().getFullYear()}/${dn.id}`);
  const dnNum = dn.document_number || docNo;

  // Best-effort state-name → GST state code lookup. Used when business_book
  // doesn't have an explicit state_code saved (legacy rows). Punjab=03 etc.
  const stateCodeFor = (name) => {
    const map = {
      'jammu and kashmir': '01', 'himachal pradesh': '02', 'punjab': '03',
      'chandigarh': '04', 'uttarakhand': '05', 'haryana': '06', 'delhi': '07',
      'rajasthan': '08', 'uttar pradesh': '09', 'bihar': '10', 'sikkim': '11',
      'arunachal pradesh': '12', 'nagaland': '13', 'manipur': '14',
      'mizoram': '15', 'tripura': '16', 'meghalaya': '17', 'assam': '18',
      'west bengal': '19', 'jharkhand': '20', 'odisha': '21', 'chhattisgarh': '22',
      'madhya pradesh': '23', 'gujarat': '24', 'daman and diu': '25',
      'dadra and nagar haveli': '26', 'maharashtra': '27', 'andhra pradesh': '28',
      'karnataka': '29', 'goa': '30', 'lakshadweep': '31', 'kerala': '32',
      'tamil nadu': '33', 'puducherry': '34', 'andaman and nicobar islands': '35',
      'telangana': '36', 'andhra pradesh (new)': '37', 'ladakh': '38',
    };
    return map[String(name || '').trim().toLowerCase()] || '';
  };
  const clientStateCode = dn.client_state_code || stateCodeFor(dn.client_state);

  // Compute totals for sales bill — honour per-line discount % so the
  // taxable value matches what mam tweaked in the create-modal.
  let subtotal = 0;
  for (const it of items) {
    const qty = +it.quantity || 0;
    const rate = +it.rate || 0;
    const discPct = +it.disc_pct || 0;
    subtotal += +it.amount || (qty * rate * (1 - discPct / 100));
  }
  const cgst = subtotal * (+dn.cgst_pct || 0) / 100;
  const sgst = subtotal * (+dn.sgst_pct || 0) / 100;
  const igst = subtotal * (+dn.igst_pct || 0) / 100;
  const freight = +dn.freight_amount || 0;
  const roundOff = +dn.round_off_amount || 0;
  const grandTotal = subtotal + cgst + sgst + igst + freight + roundOff;

  const headerBlock = `
    <div class="header">
      <div class="gstin">GSTIN : 03AASCS7836D2Z3</div>
      <div class="title">${docTitle}</div>
      <div class="pan">PAN : AASCS7836D</div>
    </div>
    <div class="companyblock">
      <h1>SECURED ENGINEERS PVT. LTD - 24-25</h1>
      <div class="addr"><b>HO:</b> 2480/1, B.K Tower, 1st Floor, Near Grewal Hospital, Gill Road, LUDHIANA, Punjab - 141003 &nbsp;|&nbsp; <b>Noida:</b> 91, Springboard, Sector 2, Noida (UP)</div>
      <div class="tag">PAN-INDIA PRESENCE : <b>LUDHIANA | NOIDA | BANGALORE | MUMBAI</b> — ELECTRICAL | HVAC | FIRE SAFETY | PLUMBING | SOLAR | ELV</div>
    </div>
  `;

  // Display "DD / MM / YYYY" for any ISO date string. Used by both Sales
  // Bill and Delivery Note. Returns empty when no date is provided.
  const dispDate = (d) => {
    if (!d) return '';
    const m = String(d).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]} / ${m[2]} / ${m[1]}` : esc(d);
  };

  // Helper — if a field has no value, render an underline placeholder
  // so the document looks like the printed fill-in template.
  const fill = (v, w) => {
    const s = (v == null ? '' : String(v)).trim();
    if (s) return esc(s);
    return `<span class="blank"${w ? ` style="min-width:${w}"` : ''}></span>`;
  };

  if (isSalesBill) {
    // Match the SEPL Sales Bill template page 1:1 — Bill To / Ship To
    // with State + Code as two fields, GSTIN (if diff.) on Ship To,
    // bank details + numbered T&C in side-by-side cards, and two
    // separate signature panels.
    const billState = esc(dn.client_state || '');
    const billStateCode = esc(clientStateCode);
    const shipStateCode = esc(dn.state_code || clientStateCode);
    return `<!doctype html><html><head><meta charset="UTF-8"><title>${esc(docNo)}</title><style>${css}</style></head><body>
      <button class="print-btn" onclick="window.print()">🖨 Print</button>
      ${headerBlock}
      <table class="meta">
        <tr>
          <td class="lbl">Invoice No.</td><td>${esc(docNo)}</td>
          <td class="lbl">Invoice Date</td><td>${dispDate(dn.delivery_date)}</td>
          <td class="lbl">Client PO No.</td><td>${esc(dn.client_po_no || '')}</td>
          <td class="lbl">PO Date</td><td>${dispDate(dn.client_po_date)}</td>
          <td class="lbl">Delivery Note Ref.</td><td>${esc(dnNum)}</td>
        </tr>
        <tr>
          <td class="lbl">Place of Supply</td><td>${esc(dn.place_of_supply || dn.client_state || '')}</td>
          <td class="lbl">State Code</td><td>${esc(dn.state_code || clientStateCode)}</td>
          <td class="lbl">Reverse Charge</td><td>${dn.reverse_charge ? 'YES' : 'NO'}</td>
          <td class="lbl">Vehicle No.</td><td>${esc(dn.vehicle_no || '')}</td>
          <td class="lbl">E-Way Bill No.</td><td>${esc(dn.e_way_bill_no || '')}</td>
        </tr>
      </table>
      <table class="parties">
        <tr>
          <td class="lbl" style="width:50%">Bill To</td>
          <td class="lbl">Ship To / Site</td>
        </tr>
        <tr>
          <td style="width:50%">
            <div><b>M/s</b> ${fill(dn.client_company, '220px')}</div>
            <div style="margin-top:3px"><b>Address:</b> ${fill(dn.client_address, '220px')}</div>
            <div style="margin-top:3px"><b>GSTIN:</b> ${fill(dn.client_gstin, '180px')}</div>
            <div style="margin-top:3px"><b>State:</b> ${fill(dn.client_state, '100px')} &nbsp; <b>Code:</b> ${fill(clientStateCode, '40px')}</div>
            <div style="margin-top:3px"><b>Contact:</b> ${fill([dn.client_person_name, dn.client_phone].filter(Boolean).join(' · '), '180px')}</div>
          </td>
          <td>
            <div><b>Site Name:</b> ${fill(dn.site_name, '220px')}</div>
            <div style="margin-top:3px"><b>Address:</b> ${fill(dn.site_address, '220px')}</div>
            <div style="margin-top:3px"><b>GSTIN (if diff.):</b> ${fill(dn.client_gstin, '180px')}</div>
            <div style="margin-top:3px"><b>State:</b> ${fill(dn.client_state, '100px')} &nbsp; <b>Code:</b> ${fill(dn.state_code || clientStateCode, '40px')}</div>
            <div style="margin-top:3px"><b>Site Engineer / Contact:</b> ${fill(dn.client_phone, '180px')}</div>
          </td>
        </tr>
      </table>
      <table class="items">
        <thead><tr><th style="width:30px">SL NO.</th><th>DESCRIPTION OF GOODS / SERVICES</th><th style="width:60px">HSN / SAC</th><th style="width:50px">QTY</th><th style="width:40px">UOM</th><th style="width:60px">RATE (₹)</th><th style="width:40px">DISC. %</th><th style="width:80px">TAXABLE VALUE (₹)</th><th style="width:80px">AMOUNT (₹)</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <table class="totals">
        <tr><td class="label">Sub Total (Taxable Value)</td><td class="val">₹ ${fmt(subtotal)}</td></tr>
        <tr><td class="label">Add: CGST @ ${dn.cgst_pct || 0} %</td><td class="val">₹ ${fmt(cgst)}</td></tr>
        <tr><td class="label">Add: SGST / UTGST @ ${dn.sgst_pct || 0} %</td><td class="val">₹ ${fmt(sgst)}</td></tr>
        <tr><td class="label">Add: IGST @ ${dn.igst_pct || 0} %</td><td class="val">₹ ${fmt(igst)}</td></tr>
        <tr><td class="label">Add: Freight / Packing / Other Charges</td><td class="val">₹ ${fmt(freight)}</td></tr>
        <tr><td class="label">Less: Round Off</td><td class="val">₹ ${fmt(roundOff)}</td></tr>
        <tr><td class="label grand">GRAND TOTAL (₹)</td><td class="val grand">₹ ${fmt(grandTotal)}</td></tr>
      </table>
      <div style="margin-top:6px;font-size:11px;border:1px solid #e7d4d4;padding:5px 8px;"><b>Amount Chargeable (in words):</b> Rupees ${esc(numToWords(grandTotal))} Only</div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <div class="bank" style="flex:1">
          <div class="hdr">Bank Details for Payment</div>
          <div><b>Beneficiary:</b> SECURED ENGINEERS PVT. LTD.</div>
          <div><b>Bank Name:</b> __________________________</div>
          <div><b>Branch:</b> ______________________________</div>
          <div><b>A/c No.:</b> _____________________________</div>
          <div><b>IFSC Code:</b> ___________________________</div>
          <div><b>UPI ID:</b> ______________________________</div>
        </div>
        <div class="terms" style="flex:1">
          <div class="hdr">Terms &amp; Conditions</div>
          <ol style="margin:0;padding-left:18px;line-height:1.6">
            <li>Payment due within ______ days from invoice date.</li>
            <li>Interest @ 18% p.a. shall be charged on overdue amounts.</li>
            <li>Goods once sold will not be taken back / exchanged.</li>
            <li>Subject to <b>LUDHIANA</b> jurisdiction only.</li>
            <li>Cheque / DD to be drawn in favour of <b>"Secured Engineers Pvt. Ltd."</b></li>
            <li>Please quote Invoice No. while making payment.</li>
          </ol>
        </div>
      </div>
      <div style="display:flex;gap:8px;margin-top:6px;">
        <div class="signblk" style="flex:1">
          <div class="hdr">Receiver's Acknowledgement</div>
          <div style="font-size:10px;color:#444;">Received the above material / services in good condition.</div>
          <div class="row"><div>Name, Signature &amp; Stamp with Date</div></div>
        </div>
        <div class="signblk" style="flex:1">
          <div class="hdr">For Secured Engineers Pvt. Ltd.</div>
          <div style="height:14px"></div>
          <div class="row"><div>Authorised Signatory</div></div>
        </div>
      </div>
      <div class="footnote">This is a Computer Generated Tax Invoice. &nbsp;|&nbsp; E. &amp; O.E. &nbsp;|&nbsp; Certified that the particulars given above are true and correct.</div>
    </body></html>`;
  }

  // Delivery Note — matches the SEPL Delivery Note template 1:1.
  // Items table is 6 columns (SL / DESCRIPTION / HSN / QUANTITY / UOM /
  // REMARKS) padded to 8 rows. Vehicle / Transport details get their
  // own banner-headed section; the two notices ("IMPORTANT" and
  // "RECEIVED IN GOOD CONDITION") use red banner headers like the
  // template; footer text sits inside a red-bordered banner.
  return `<!doctype html><html><head><meta charset="UTF-8"><title>${esc(docNo)}</title><style>${css}</style></head><body>
    <button class="print-btn" onclick="window.print()">🖨 Print</button>
    ${headerBlock}
    <table class="meta">
      <tr>
        <td class="lbl">Delivery Note No.</td><td>${esc(docNo)}</td>
        <td class="lbl">Date</td><td>${dispDate(dn.delivery_date)}</td>
        <td class="lbl">SEPL PO No.</td><td>${esc(dn.vendor_po_no || '')}</td>
        <td class="lbl">Indent No.</td><td>${esc(dn.indent_number || '')}</td>
      </tr>
    </table>
    <table class="parties">
      <tr>
        <td class="lbl" style="width:50%">Client / Company</td>
        <td class="lbl">Delivery Site</td>
      </tr>
      <tr>
        <td style="width:50%">
          <div><b>M/s</b> ${fill(dn.client_company, '220px')}</div>
          <div style="margin-top:4px"><b>Address:</b></div>
          <div style="margin-left:4px">${fill(dn.client_address, '260px')}</div>
          <div style="margin-top:4px"><b>GSTIN:</b> ${fill(dn.client_gstin, '180px')}</div>
        </td>
        <td>
          <div><b>Site Name:</b> ${fill(dn.site_name, '220px')}</div>
          <div style="margin-top:4px"><b>Address:</b></div>
          <div style="margin-left:4px">${fill(dn.site_address, '260px')}</div>
          <div style="margin-top:4px"><b>Site Engineer / Contact:</b> ${fill(dn.client_phone, '180px')}</div>
        </td>
      </tr>
    </table>
    <table class="items">
      <thead><tr><th style="width:30px">SL NO.</th><th>DESCRIPTION OF MATERIAL / WORK</th><th style="width:80px">HSN / CODE</th><th style="width:70px">QUANTITY</th><th style="width:50px">UOM</th><th style="width:130px">REMARKS</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table>
    <div style="margin-top:6px;border:1px solid #e7d4d4">
      <div style="background:#f8efef;color:#7a1b1b;font-weight:bold;padding:4px 8px;font-size:10px;text-transform:uppercase">Vehicle / Transport Details</div>
      <table class="parties" style="border-top:0"><tr>
        <td class="lbl" style="border-top:0">Vehicle No.</td>
        <td class="lbl" style="border-top:0">Driver Name &amp; Mobile</td>
        <td class="lbl" style="border-top:0">LR / Challan No.</td>
        <td class="lbl" style="border-top:0">Total Packages</td>
      </tr><tr>
        <td>${esc(dn.vehicle_no || '')}</td>
        <td>${esc([dn.driver_name, dn.driver_mobile].filter(Boolean).join(' · '))}</td>
        <td>${esc(dn.lr_challan_no || '')}</td>
        <td>${esc(dn.total_packages || '')}</td>
      </tr></table>
    </div>
    <div class="notice" style="margin-top:6px">IMPORTANT — RECEIVING IS VALID ONLY ON THIS DELIVERY NOTE</div>
    <div style="font-size:9.5px;color:#444;border:1px solid #e7d4d4;border-top:0;padding:6px 8px">
      It is the supplier's responsibility to obtain dated signature, name and stamp of Secured Engineers' authorised site representative on this Delivery Note. Receiving acknowledged on the supplier's bill / invoice / challan shall <b>NOT</b> be treated as proof of delivery and may lead to non-payment.
    </div>
    <div class="notice" style="margin-top:6px">Received in Good Condition (to be filled by SEPL site representative)</div>
    <table class="parties" style="border-top:0">
      <tr>
        <td class="lbl">Name of Receiver</td>
        <td class="lbl">Designation</td>
        <td class="lbl">Date &amp; Time</td>
      </tr>
      <tr>
        <td style="height:30px"></td><td></td><td></td>
      </tr>
      <tr>
        <td class="lbl">Signature</td>
        <td class="lbl">Site Stamp</td>
        <td class="lbl">Mobile No.</td>
      </tr>
      <tr>
        <td style="height:40px"></td><td></td><td></td>
      </tr>
    </table>
    <ul class="checklist">
      <li>Please verify quantity, description and condition of material BEFORE signing this Delivery Note.</li>
      <li>Mention shortage / damage / wrong-supply (if any) clearly under <b>REMARKS</b> column. Once signed without remark, supply shall be deemed accepted in full.</li>
      <li>Receiving on this Delivery Note is the <b>only</b> recognised proof of delivery. Bills / Invoices are for accounting only.</li>
      <li>Original copy to be retained by Secured Engineers' site office; duplicate copy may be returned to the supplier for billing reference.</li>
      <li>For any clarification, contact the Stores / Project Department of Secured Engineers Pvt. Ltd., Ludhiana.</li>
    </ul>
    <div style="margin-top:6px;border:1px solid #7a1b1b;background:#fdf2f2;color:#7a1b1b;font-weight:bold;text-align:center;padding:6px 8px;font-size:10.5px">
      This is a Computer Generated Delivery Note. Valid only when received and signed at the designated SEPL site.
    </div>
  </body></html>`;
}

// Sales Bills
router.get('/sales-bills', (req, res) => {
  res.json(getDb().prepare(`SELECT sb.*, po.po_number FROM sales_bills sb
    LEFT JOIN purchase_orders po ON sb.po_id=po.id ORDER BY sb.created_at DESC`).all());
});

router.post('/sales-bills', (req, res) => {
  const db = getDb();
  const { po_id, bill_date, amount, gst_amount, total_amount } = req.body;
  const { nextSequence } = require('../db/nextSequence');
  const billNum = nextSequence(db, 'sales_bills', 'bill_number', 'SB-', { startFrom: 0, pad: 4 });
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
  // Also pull the parent BOQ item (po_items) so the UI can render
  // "BOQ: <parent description>" as a sub-category above the actual
  // sub-item — mam wants both visible per row.
  const rows = db.prepare(
    // Mam (2026-05-16): "not change according to itemwise" — UOM
    // was showing the stale stored ii.unit ("Each", "Metre", etc.)
    // even when the linked item_master had a clean uom.  The SELECT
    // now exposes both: `unit` is the effective UOM (master.uom
    // wins, falling back to ii.unit when no master link), `unit_raw`
    // is the original ii.unit preserved for any audit needs.
    `SELECT ii.id as indent_item_id, ii.description, ii.make, ii.quantity as qty,
            LOWER(COALESCE(NULLIF(TRIM(im.uom), ''), NULLIF(TRIM(ii.unit), ''), 'nos')) as unit,
            ii.unit as unit_raw,
            ii.item_type, ii.item_master_id, ii.po_item_id,
            im.item_code, im.item_name as master_name, im.specification, im.size, im.uom,
            poi.description as boq_description, poi.quantity as boq_qty,
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
     LEFT JOIN po_items poi ON poi.id = ii.po_item_id
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
router.post('/item-rates', needsApprove, (req, res) => {
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
router.post('/item-rates/:id/finalize', needsApprove, (req, res) => {
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
