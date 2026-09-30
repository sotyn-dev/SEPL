const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { getDb } = require('../db/schema');
const { authMiddleware, requirePermission } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('../lib/istDate');
const { aiComplete, aiConfig } = require('../lib/aiComplete');
const sharp = require('sharp');

const router = express.Router();
router.use(authMiddleware);

// Ensure upload directory exists
const uploadsDir = path.join(__dirname, '..', '..', 'data', 'uploads', 'grn');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `grn_${Date.now()}_${Math.random().toString(36).slice(2, 7)}_${safeName}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20MB
});

// Initialize Tables on Module Load
function initDb() {
  const db = getDb();

  db.exec(`
    -- 1. Site GRN Header
    CREATE TABLE IF NOT EXISTS site_grn (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_number TEXT UNIQUE NOT NULL,
      grn_date DATE NOT NULL,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      warehouse_id INTEGER REFERENCES warehouses(id),
      warehouse_name TEXT,
      vendor_id INTEGER REFERENCES vendors(id),
      vendor_name TEXT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      po_number TEXT,
      delivery_challan_no TEXT NOT NULL,
      challan_date DATE,
      vehicle_number TEXT,
      received_by INTEGER REFERENCES users(id),
      received_by_name TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'under_verification', 'approved', 'rejected', 'correction')),
      stock_updated INTEGER DEFAULT 0,
      stock_updated_at DATETIME,
      remarks TEXT,
      rejection_reason TEXT,
      approval_remarks TEXT,
      verified_by INTEGER REFERENCES users(id),
      verified_by_name TEXT,
      verified_at DATETIME,
      approved_by INTEGER REFERENCES users(id),
      approved_by_name TEXT,
      approved_at DATETIME,
      challan_doc_url TEXT,
      material_photos TEXT,
      attachments TEXT,
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 2. Site GRN Items
    CREATE TABLE IF NOT EXISTS site_grn_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER NOT NULL REFERENCES site_grn(id) ON DELETE CASCADE,
      item_master_id INTEGER REFERENCES item_master(id),
      item_code TEXT,
      material_name TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      po_qty REAL DEFAULT 0,
      prev_received_qty REAL DEFAULT 0,
      curr_received_qty REAL NOT NULL DEFAULT 0,
      accepted_qty REAL NOT NULL DEFAULT 0,
      rejected_qty REAL NOT NULL DEFAULT 0,
      unit_rate REAL DEFAULT 0,
      tax_rate REAL DEFAULT 18,
      total_amount REAL DEFAULT 0,
      rejection_reason TEXT,
      remarks TEXT
    );

    -- 3. Site GRN Audit Log
    CREATE TABLE IF NOT EXISTS site_grn_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      grn_id INTEGER NOT NULL REFERENCES site_grn(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      performed_by INTEGER REFERENCES users(id),
      performed_by_name TEXT,
      previous_status TEXT,
      new_status TEXT,
      remarks TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 4. Supplier Invoices
    CREATE TABLE IF NOT EXISTS supplier_invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_number TEXT NOT NULL,
      invoice_date DATE NOT NULL,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      vendor_name TEXT,
      site_id INTEGER REFERENCES sites(id),
      site_name TEXT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      po_number TEXT,
      grn_id INTEGER NOT NULL REFERENCES site_grn(id),
      grn_number TEXT,
      taxable_amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      total_amount REAL DEFAULT 0,
      due_date DATE,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'submitted', 'verification', 'matched', 'approved', 'exception', 'hold', 'rejected', 'payment_pending', 'payment_processing', 'paid')),
      match_status TEXT DEFAULT 'pending' CHECK(match_status IN ('pending', 'matched', 'mismatched', 'exception')),
      match_details TEXT,
      exception_reason TEXT,
      resolution_notes TEXT,
      attachment_url TEXT,
      remarks TEXT,
      verified_by INTEGER REFERENCES users(id),
      verified_by_name TEXT,
      verified_at DATETIME,
      approved_by INTEGER REFERENCES users(id),
      approved_by_name TEXT,
      approved_at DATETIME,
      created_by INTEGER REFERENCES users(id),
      created_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 5. Supplier Invoice Items
    CREATE TABLE IF NOT EXISTS supplier_invoice_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      grn_item_id INTEGER REFERENCES site_grn_items(id),
      item_master_id INTEGER REFERENCES item_master(id),
      item_code TEXT,
      material_name TEXT NOT NULL,
      unit TEXT DEFAULT 'nos',
      po_qty REAL DEFAULT 0,
      po_rate REAL DEFAULT 0,
      grn_accepted_qty REAL DEFAULT 0,
      invoice_qty REAL NOT NULL DEFAULT 0,
      invoice_rate REAL NOT NULL DEFAULT 0,
      tax_rate REAL DEFAULT 18,
      taxable_amount REAL DEFAULT 0,
      gst_amount REAL DEFAULT 0,
      line_total REAL DEFAULT 0,
      qty_matched INTEGER DEFAULT 1,
      rate_matched INTEGER DEFAULT 1,
      tax_matched INTEGER DEFAULT 1,
      discrepancy_notes TEXT
    );

    -- 6. Supplier Invoice Audit Log
    CREATE TABLE IF NOT EXISTS supplier_invoice_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      performed_by INTEGER REFERENCES users(id),
      performed_by_name TEXT,
      previous_status TEXT,
      new_status TEXT,
      remarks TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 7. Supplier Payments
    CREATE TABLE IF NOT EXISTS supplier_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_voucher_no TEXT UNIQUE NOT NULL,
      invoice_id INTEGER NOT NULL REFERENCES supplier_invoices(id),
      invoice_number TEXT NOT NULL,
      vendor_id INTEGER NOT NULL REFERENCES vendors(id),
      vendor_name TEXT,
      vendor_po_id INTEGER REFERENCES vendor_pos(id),
      po_number TEXT,
      grn_id INTEGER REFERENCES site_grn(id),
      grn_number TEXT,
      approved_amount REAL NOT NULL DEFAULT 0,
      tds_deduction REAL DEFAULT 0,
      other_deductions REAL DEFAULT 0,
      deduction_reason TEXT,
      net_payable REAL NOT NULL DEFAULT 0,
      paid_amount REAL NOT NULL DEFAULT 0,
      payment_date DATE NOT NULL,
      payment_mode TEXT DEFAULT 'NEFT/RTGS' CHECK(payment_mode IN ('NEFT/RTGS', 'IMPS', 'UPI', 'Cheque', 'Bank Transfer', 'Cash')),
      bank_reference TEXT,
      bank_name TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'processing', 'paid', 'failed', 'cancelled')),
      payment_proof_url TEXT,
      payment_remarks TEXT,
      processed_by INTEGER REFERENCES users(id),
      processed_by_name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- 8. Supplier Payment Audit Log
    CREATE TABLE IF NOT EXISTS supplier_payment_audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_id INTEGER NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
      action TEXT NOT NULL,
      performed_by INTEGER REFERENCES users(id),
      performed_by_name TEXT,
      remarks TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_site_grn_status ON site_grn(status);
    CREATE INDEX IF NOT EXISTS idx_site_grn_site ON site_grn(site_id);
    CREATE INDEX IF NOT EXISTS idx_site_grn_vendor ON site_grn(vendor_id);
    CREATE INDEX IF NOT EXISTS idx_site_grn_po ON site_grn(vendor_po_id);
    CREATE INDEX IF NOT EXISTS idx_sup_inv_status ON supplier_invoices(status);
    CREATE INDEX IF NOT EXISTS idx_sup_inv_grn ON supplier_invoices(grn_id);
    CREATE INDEX IF NOT EXISTS idx_sup_pay_inv ON supplier_payments(invoice_id);
  `);
}

initDb();

// Helper: Ensure valid vendor_id and vendor_name for direct/cash purchases
function resolveVendor(db, vendorId, vendorName) {
  if (vendorId) {
    const v = db.prepare('SELECT id, name FROM vendors WHERE id=?').get(vendorId);
    if (v) return { vendorId: v.id, vendorName: vendorName || v.name };
  }
  if (vendorName && String(vendorName).trim()) {
    const v = db.prepare('SELECT id, name FROM vendors WHERE LOWER(name)=LOWER(?) LIMIT 1').get(String(vendorName).trim());
    if (v) return { vendorId: v.id, vendorName: v.name };
  }
  let defaultVendor = db.prepare("SELECT id, name FROM vendors WHERE LOWER(name) LIKE '%direct%' OR LOWER(name) LIKE '%cash%' OR LOWER(name) LIKE '%local%' LIMIT 1").get();
  if (!defaultVendor) {
    defaultVendor = db.prepare("SELECT id, name FROM vendors ORDER BY id ASC LIMIT 1").get();
  }
  if (!defaultVendor) {
    const r = db.prepare("INSERT INTO vendors (name, phone, address) VALUES ('Direct / Local Supplier', '9999999999', 'Site Local Purchase')").run();
    defaultVendor = { id: r.lastInsertRowid, name: 'Direct / Local Supplier' };
  }
  return { vendorId: defaultVendor.id, vendorName: vendorName || defaultVendor.name };
}

// Self-heal existing GRNs with NULL vendor_id
try {
  const db = getDb();
  const nullGrns = db.prepare('SELECT id FROM site_grn WHERE vendor_id IS NULL').all();
  if (nullGrns.length > 0) {
    const def = resolveVendor(db, null, null);
    db.prepare('UPDATE site_grn SET vendor_id = ?, vendor_name = COALESCE(vendor_name, ?) WHERE vendor_id IS NULL').run(def.vendorId, def.vendorName);
  }
} catch (_) {}

// Helper: Log audit action for GRN
function logGrnAudit(db, grnId, action, user, prevStatus, newStatus, remarks) {
  try {
    db.prepare(`
      INSERT INTO site_grn_audit_log (grn_id, action, performed_by, performed_by_name, previous_status, new_status, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(grnId, action, user?.id || null, user?.name || 'System', prevStatus || null, newStatus || null, remarks || null);
  } catch (err) {
    console.warn('[site-grn] audit log error:', err.message);
  }
}

// Helper: Log audit action for Invoice
function logInvoiceAudit(db, invoiceId, action, user, prevStatus, newStatus, remarks) {
  try {
    db.prepare(`
      INSERT INTO supplier_invoice_audit_log (invoice_id, action, performed_by, performed_by_name, previous_status, new_status, remarks)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(invoiceId, action, user?.id || null, user?.name || 'System', prevStatus || null, newStatus || null, remarks || null);
  } catch (err) {
    console.warn('[supplier-invoice] audit log error:', err.message);
  }
}

// Helper: Log audit action for Payment
function logPaymentAudit(db, paymentId, action, user, remarks) {
  try {
    db.prepare(`
      INSERT INTO supplier_payment_audit_log (payment_id, action, performed_by, performed_by_name, remarks)
      VALUES (?, ?, ?, ?, ?)
    `).run(paymentId, action, user?.id || null, user?.name || 'System', remarks || null);
  } catch (err) {
    console.warn('[supplier-payment] audit log error:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// FILE UPLOAD ENDPOINT
// ─────────────────────────────────────────────────────────────────────────────
router.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const relativeUrl = `/uploads/grn/${req.file.filename}`;
  res.json({
    url: relativeUrl,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size
  });
});

// Helper: Resilient JSON object extractor
function extractJsonObject(text) {
  if (!text) return null;
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const v = JSON.parse(t);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
  } catch (_) {}
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      const v = JSON.parse(t.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    } catch (_) {}
  }
  return null;
}

// AI & OCR Delivery Challan Auto-Reader
router.post('/parse-challan', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No delivery challan file uploaded' });

  const db = getDb();
  const relativeUrl = `/uploads/grn/${req.file.filename}`;
  const filePath = req.file.path;
  const isPdf = /\.pdf$/i.test(req.file.originalname) || req.file.mimetype === 'application/pdf';
  const isImage = /\.(jpg|jpeg|png|webp)$/i.test(req.file.originalname) || /^image\//i.test(req.file.mimetype);

  // Immediate pre-check: If AI is not configured, return immediately in 1ms without lag
  const cfg = aiConfig(db);
  if (!cfg.configured) {
    return res.json({
      success: true,
      file_url: relativeUrl,
      filename: req.file.filename,
      originalName: req.file.originalname,
      ai_parsed: false,
      ai_error: 'AI not configured — paste a Google Gemini API key in Admin → AI Settings',
      parsed: {
        delivery_challan_no: '',
        challan_date: istToday(),
        vehicle_number: '',
        vendor_id: '',
        vendor_name: '',
        vendor_po_id: '',
        po_number: '',
        site_id: '',
        site_name: '',
        warehouse_id: '',
        warehouse_name: '',
        remarks: '',
        items: []
      }
    });
  }

  let rawText = '';
  let buffer;

  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read uploaded file on server' });
  }

  if (isPdf) {
    try {
      let pdfParse;
      try { pdfParse = require('pdf-parse/lib/pdf-parse.js'); } catch (_) { pdfParse = require('pdf-parse'); }
      if (typeof pdfParse === 'function') {
        const parsedPdf = await pdfParse(buffer);
        rawText = parsedPdf.text || '';
      }
    } catch (e) {
      console.warn('[site-grn/parse-challan] pdf-parse warning:', e.message);
    }
  }

  let extracted = {
    delivery_challan_no: '',
    challan_date: istToday(),
    vehicle_number: '',
    vendor_name: '',
    site_name: '',
    remarks: '',
    items: []
  };

  let aiSuccess = false;
  let aiErrorMsg = null;

  // Try AI vision / document completion
  try {
    const attachments = [];
    if (isImage) {
      let imgBase64;
      let imgMime = 'image/jpeg';
      try {
        // High speed optimization: 1000x1400, quality 70% produces crisp ~50KB payload for instant OCR
        const optimized = await sharp(buffer)
          .rotate()
          .resize({ width: 1000, height: 1400, fit: 'inside', withoutEnlargement: true })
          .jpeg({ quality: 70, progressive: true })
          .toBuffer();
        imgBase64 = optimized.toString('base64');
      } catch (shErr) {
        console.warn('[site-grn/parse-challan] sharp fallback:', shErr.message);
        imgBase64 = buffer.toString('base64');
        imgMime = req.file.mimetype || (/\.png$/i.test(req.file.originalname) ? 'image/png' : 'image/jpeg');
      }
      attachments.push({ mime: imgMime, data: imgBase64, name: req.file.originalname });
    } else if (isPdf) {
      attachments.push({ mime: 'application/pdf', data: buffer.toString('base64'), name: req.file.originalname });
    }

    const aiPrompt = `Extract Indian Delivery Challan / Invoice into strict JSON:
- delivery_challan_no: Invoice / Challan No (e.g. "4908")
- challan_date: YYYY-MM-DD (e.g. "2026-09-26")
- vehicle_number: Vehicle / Truck No (e.g. "DL01LAF0722")
- vendor_name: Supplier / Vendor Name (e.g. "Swastik International")
- site_name: Shipped to / Consignee / Site Name (e.g. "SHRI GANGA INDUSTRIES ALLIED")
- remarks: E-Way Bill or notes (e.g. "E-Way Bill: 771674042604")
- items: array of { material_name, unit, quantity (number), unit_rate (number), tax_rate (number) }

Return ONLY strict JSON matching this schema:
{
  "delivery_challan_no": "4908",
  "challan_date": "2026-09-26",
  "vehicle_number": "DL01LAF0722",
  "vendor_name": "Swastik International",
  "site_name": "SHRI GANGA INDUSTRIES ALLIED",
  "remarks": "E-Way Bill: 771674042604",
  "items": [{ "material_name": "ANGEL GRINDER 4'", "unit": "PCS", "quantity": 2, "unit_rate": 2000, "tax_rate": 18 }]
}`;

    const aiRes = await aiComplete(db, {
      prompt: aiPrompt,
      system: 'You extract delivery challan structured data. Return strictly JSON with no markdown formatting or commentary.',
      json: true,
      attachments,
      maxTokens: 2048,
      timeout: 10000,
      retries429: 0,
      prefer: 'capable'
    });

    if (aiRes && aiRes.text) {
      const parsedAi = extractJsonObject(aiRes.text);
      if (parsedAi && typeof parsedAi === 'object') {
        extracted = {
          ...extracted,
          ...parsedAi,
          items: Array.isArray(parsedAi.items) ? parsedAi.items : []
        };
        aiSuccess = true;
      }
    }
  } catch (aiErr) {
    aiErrorMsg = aiErr.message;
    console.warn('[site-grn/parse-challan] AI OCR error (fallback to text regex):', aiErr.message);
  }

  // Regex fallback if AI was not available or produced no items
  if (!aiSuccess && rawText) {
    const dcMatch = rawText.match(/(?:Challan\s*(?:No|#|\.)?|DC\s*(?:No|#|\.)?|Invoice\s*(?:No|#|\.)?)\s*[:\-]?\s*([A-Za-z0-9\-\/]+)/i);
    if (dcMatch) extracted.delivery_challan_no = dcMatch[1].trim();

    const dateMatch = rawText.match(/(?:Date|Dated)\s*[:\-]?\s*(\d{1,2}[\/\-\.]\d{1,2}[\/\-\.]\d{2,4})/i);
    if (dateMatch) {
      try {
        const parts = dateMatch[1].split(/[\/\-\.]/);
        if (parts.length === 3) {
          const d = parts[0].padStart(2, '0');
          const m = parts[1].padStart(2, '0');
          let y = parts[2];
          if (y.length === 2) y = '20' + y;
          extracted.challan_date = `${y}-${m}-${d}`;
        }
      } catch (_) {}
    }

    const vehMatch = rawText.match(/(?:Vehicle|Truck|Lorry|Veh)\s*(?:No|#|\.)?\s*[:\-]?\s*([A-Z]{2}[0-9\s\-A-Z]{4,12})/i);
    if (vehMatch) extracted.vehicle_number = vehMatch[1].replace(/\s+/g, '').trim();
  }

  // Database Linkage: Match Vendor, Site & Warehouse
  let matchedVendor = null;
  let matchedSite = null;
  let matchedWh = null;
  let matchedPo = null;

  try {
    if (extracted.vendor_name && String(extracted.vendor_name).trim()) {
      const vName = String(extracted.vendor_name).trim();
      matchedVendor = db.prepare(`
        SELECT id, name FROM vendors
        WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE ? OR LOWER(?) LIKE LOWER('%' || name || '%')
        ORDER BY CASE WHEN LOWER(name) = LOWER(?) THEN 1 ELSE 2 END
        LIMIT 1
      `).get(vName, `%${vName}%`, vName, vName);

      if (!matchedVendor) {
        const words = vName.split(/[\s,.-]+/).filter(w => w.length > 3 && !/^(international|enterprises|traders|corporation|private|limited|allied|industries)$/i.test(w));
        for (const w of words) {
          matchedVendor = db.prepare("SELECT id, name FROM vendors WHERE LOWER(name) LIKE ? LIMIT 1").get(`%${w.toLowerCase()}%`);
          if (matchedVendor) break;
        }
      }
    }

    if (extracted.site_name && String(extracted.site_name).trim()) {
      const sName = String(extracted.site_name).trim();
      matchedSite = db.prepare(`
        SELECT id, name FROM sites
        WHERE LOWER(name) = LOWER(?) OR LOWER(name) LIKE ? OR LOWER(?) LIKE LOWER('%' || name || '%')
        ORDER BY CASE WHEN LOWER(name) = LOWER(?) THEN 1 ELSE 2 END
        LIMIT 1
      `).get(sName, `%${sName}%`, sName, sName);

      if (!matchedSite) {
        const words = sName.split(/[\s,.-]+/).filter(w => w.length > 3 && !/^(near|road|area|industries|private|limited|allied|upsidc|industrial)$/i.test(w));
        for (const w of words) {
          matchedSite = db.prepare("SELECT id, name FROM sites WHERE LOWER(name) LIKE ? OR LOWER(address) LIKE ? LIMIT 1").get(`%${w.toLowerCase()}%`, `%${w.toLowerCase()}%`);
          if (matchedSite) break;
        }
      }
    }

    if (matchedSite) {
      matchedWh = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? AND type='site_store' AND COALESCE(active,1)=1 LIMIT 1").get(matchedSite.id);
      if (!matchedWh) {
        matchedWh = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? AND COALESCE(active,1)=1 LIMIT 1").get(matchedSite.id);
      }
    }

    // Find active PO if vendor matched
    if (matchedVendor) {
      matchedPo = db.prepare(`
        SELECT vp.id, vp.po_number, s.id as site_id, s.name as site_name
          FROM vendor_pos vp
          LEFT JOIN indents i ON i.id = vp.indent_id
          LEFT JOIN order_planning op ON op.id = i.planning_id
          LEFT JOIN purchase_orders po ON po.id = op.po_id
          LEFT JOIN sites s ON s.id = po.site_id
         WHERE vp.vendor_id = ?
         ORDER BY vp.id DESC
         LIMIT 1
      `).get(matchedVendor.id);

      if (matchedPo && !matchedSite && matchedPo.site_id) {
        matchedSite = { id: matchedPo.site_id, name: matchedPo.site_name };
        matchedWh = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? LIMIT 1").get(matchedSite.id);
      }
    }
  } catch (matchErr) {
    console.warn('[site-grn/parse-challan] Linkage match warning:', matchErr.message);
  }

  // Normalize Items
  const formattedItems = (extracted.items || []).map(it => {
    const q = Math.max(1, parseFloat(it.quantity) || 1);
    const r = parseFloat(it.unit_rate) || 0;
    const t = parseFloat(it.tax_rate) || 18;
    return {
      material_name: String(it.material_name || 'Material Item').trim(),
      unit: String(it.unit || 'nos').toLowerCase().trim(),
      po_qty: 0,
      prev_received_qty: 0,
      curr_received_qty: q,
      accepted_qty: q,
      rejected_qty: 0,
      unit_rate: r,
      tax_rate: t,
      total_amount: q * r,
      rejection_reason: '',
      is_manual: true
    };
  });

  return res.json({
    success: true,
    file_url: relativeUrl,
    filename: req.file.filename,
    originalName: req.file.originalname,
    ai_parsed: aiSuccess,
    ai_error: aiErrorMsg,
    parsed: {
      delivery_challan_no: extracted.delivery_challan_no || '',
      challan_date: extracted.challan_date || istToday(),
      vehicle_number: extracted.vehicle_number || '',
      vendor_id: matchedVendor?.id || '',
      vendor_name: matchedVendor?.name || extracted.vendor_name || '',
      vendor_po_id: matchedPo?.id || '',
      po_number: matchedPo?.po_number || '',
      site_id: matchedSite?.id || '',
      site_name: matchedSite?.name || extracted.site_name || '',
      warehouse_id: matchedWh?.id || '',
      warehouse_name: matchedWh?.name || '',
      remarks: extracted.remarks || '',
      items: formattedItems
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// MASTER LOOKUPS & PO / STORE DATA
// ─────────────────────────────────────────────────────────────────────────────

// List available Vendor POs for GRN creation
router.get('/lookup/pos', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT vp.id, vp.po_number, vp.vendor_id, vp.total_amount, vp.created_at,
             v.name as vendor_name, v.gstin as vendor_gstin, v.phone as vendor_phone,
             s.name as site_name, s.id as site_id, vp.indent_id
        FROM vendor_pos vp
        LEFT JOIN vendors v ON v.id = vp.vendor_id
        LEFT JOIN indents i ON i.id = vp.indent_id
        LEFT JOIN order_planning op ON op.id = i.planning_id
        LEFT JOIN purchase_orders po ON po.id = op.po_id
        LEFT JOIN sites s ON s.id = po.site_id
       ORDER BY vp.created_at DESC
       LIMIT 200
    `).all();
    res.json(rows);
  } catch (e) {
    console.error('[siteGrn/lookup/pos] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// Get PO Items with Previously Received Quantities across GRNs
router.get('/lookup/po-items/:vendor_po_id', (req, res) => {
  const db = getDb();
  const poId = +req.params.vendor_po_id;
  try {
    const po = db.prepare(`
      SELECT vp.*, v.name as vendor_name, s.name as site_name, s.id as site_id, vp.indent_id
        FROM vendor_pos vp
        LEFT JOIN vendors v ON v.id = vp.vendor_id
        LEFT JOIN indents i ON i.id = vp.indent_id
        LEFT JOIN order_planning op ON op.id = i.planning_id
        LEFT JOIN purchase_orders po ON po.id = op.po_id
        LEFT JOIN sites s ON s.id = po.site_id
       WHERE vp.id = ?
    `).get(poId);

    if (!po) return res.status(404).json({ error: 'Purchase Order not found' });

    // Find linked site and site store warehouse
    let warehouse = null;
    let site = null;
    if (po.site_id) {
      site = db.prepare('SELECT id, name FROM sites WHERE id=?').get(po.site_id);
      warehouse = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? AND type='site_store' AND COALESCE(active,1)=1 LIMIT 1").get(po.site_id);
    } else if (po.site_name) {
      site = db.prepare('SELECT id, name FROM sites WHERE LOWER(name)=LOWER(?) LIMIT 1').get(po.site_name);
      if (site) {
        warehouse = db.prepare("SELECT id, name FROM warehouses WHERE site_id=? AND type='site_store' AND COALESCE(active,1)=1 LIMIT 1").get(site.id);
      }
    }

    // Default fallback to first active site store or central warehouse if needed
    if (!warehouse) {
      warehouse = db.prepare("SELECT id, name FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY type='site_store' DESC, id ASC LIMIT 1").get();
    }

    // Fetch PO items from indent_items
    let items = [];
    if (po.indent_id) {
      items = db.prepare(`
        SELECT ii.id as po_item_id, ii.description as material_name, ii.quantity as po_qty,
               ii.unit, ii.rate as unit_rate, ii.amount as total_amount,
               ii.item_master_id, im.item_code, COALESCE(im.gst, '18%') as gst_str
          FROM indent_items ii
          LEFT JOIN item_master im ON im.id = ii.item_master_id
         WHERE ii.indent_id = ?
      `).all(po.indent_id);
    }

    // Calculate previously received quantity for each item from approved / active GRNs
    const enrichedItems = items.map(item => {
      const prevRec = db.prepare(`
        SELECT COALESCE(SUM(gi.accepted_qty), 0) as total_accepted,
               COALESCE(SUM(gi.curr_received_qty), 0) as total_received
          FROM site_grn_items gi
          JOIN site_grn g ON g.id = gi.grn_id
         WHERE g.vendor_po_id = ?
            AND g.status NOT IN ('rejected')
            AND (gi.item_master_id = ? OR LOWER(TRIM(gi.material_name)) = LOWER(TRIM(?)))
      `).get(poId, item.item_master_id || -1, item.material_name);

      const prevAccepted = Number(prevRec?.total_accepted || 0);
      const prevReceived = Number(prevRec?.total_received || 0);
      const remainingBalance = Math.max(0, Number(item.po_qty) - prevAccepted);

      // Extract numeric tax percentage
      const taxNum = parseFloat(String(item.gst_str || '18').replace(/[^0-9.]/g, '')) || 18;

      return {
        ...item,
        prev_received_qty: prevReceived,
        prev_accepted_qty: prevAccepted,
        remaining_balance: remainingBalance,
        curr_received_qty: remainingBalance > 0 ? remainingBalance : 0,
        accepted_qty: remainingBalance > 0 ? remainingBalance : 0,
        rejected_qty: 0,
        tax_rate: taxNum,
        rejection_reason: '',
        remarks: ''
      };
    });

    // Fetch any existing delivery note for this PO with attached file
    let dn = null;
    try {
      dn = db.prepare(`
        SELECT id, document_number, vehicle_no, delivery_date, file_path, receipt_file_path, sales_bill_file_path, notes
          FROM delivery_notes
         WHERE vendor_po_id = ?
         ORDER BY id DESC LIMIT 1
      `).get(poId);
    } catch (_) {}

    res.json({
      po,
      site,
      warehouse,
      delivery_note: dn ? {
        ...dn,
        challan_doc_url: dn.file_path || dn.receipt_file_path || dn.sales_bill_file_path || ''
      } : null,
      items: enrichedItems
    });
  } catch (e) {
    console.error('[siteGrn/lookup/po-items] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// List Active Sites and their Site Store Warehouses
router.get('/lookup/sites-warehouses', (req, res) => {
  const db = getDb();
  try {
    const sites = db.prepare(`SELECT id, name, address as location FROM sites WHERE status != 'completed' ORDER BY name ASC`).all();
    const warehouses = db.prepare(`
      SELECT w.id, w.name, w.type, w.site_id, s.name as site_name
        FROM warehouses w
        LEFT JOIN sites s ON s.id = w.site_id
       WHERE COALESCE(w.active,1)=1
       ORDER BY w.type='site_store' DESC, w.name ASC
    `).all();
    const vendors = db.prepare(`SELECT id, name, gstin, phone, address FROM vendors ORDER BY name ASC`).all();
    res.json({ sites, warehouses, vendors });
  } catch (e) {
    console.error('[siteGrn/lookup/sites-warehouses] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 1. SITE GRN MODULE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// List GRNs with rich filters
router.get('/grn', (req, res) => {
  const db = getDb();
  const { site_id, vendor_id, po_number, status, search, from_date, to_date } = req.query;

  const where = [];
  const params = [];

  if (site_id) { where.push('g.site_id = ?'); params.push(+site_id); }
  if (vendor_id) { where.push('g.vendor_id = ?'); params.push(+vendor_id); }
  if (po_number) { where.push('g.po_number LIKE ?'); params.push(`%${po_number}%`); }
  if (status && status !== 'all') { where.push('g.status = ?'); params.push(status); }
  if (from_date) { where.push('g.grn_date >= ?'); params.push(from_date); }
  if (to_date) { where.push('g.grn_date <= ?'); params.push(to_date); }
  if (search) {
    where.push('(g.grn_number LIKE ? OR g.delivery_challan_no LIKE ? OR g.vendor_name LIKE ? OR g.site_name LIKE ? OR g.vehicle_number LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q, q);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const rows = db.prepare(`
      SELECT g.*,
             COALESCE(
               NULLIF(g.challan_doc_url, ''),
               (SELECT COALESCE(NULLIF(dn.file_path, ''), NULLIF(dn.receipt_file_path, ''), NULLIF(dn.sales_bill_file_path, ''))
                  FROM delivery_notes dn
                 WHERE (dn.document_number = g.delivery_challan_no OR dn.vendor_po_id = g.vendor_po_id)
                   AND (dn.file_path IS NOT NULL OR dn.receipt_file_path IS NOT NULL OR dn.sales_bill_file_path IS NOT NULL)
                 ORDER BY dn.id DESC LIMIT 1)
             ) as challan_doc_url,
             (SELECT COUNT(*) FROM site_grn_items gi WHERE gi.grn_id = g.id) as item_count,
             (SELECT COALESCE(SUM(gi.curr_received_qty),0) FROM site_grn_items gi WHERE gi.grn_id = g.id) as total_received_qty,
             (SELECT COALESCE(SUM(gi.accepted_qty),0) FROM site_grn_items gi WHERE gi.grn_id = g.id) as total_accepted_qty,
             (SELECT COALESCE(SUM(gi.rejected_qty),0) FROM site_grn_items gi WHERE gi.grn_id = g.id) as total_rejected_qty,
             (SELECT COALESCE(SUM(gi.accepted_qty * gi.unit_rate),0) FROM site_grn_items gi WHERE gi.grn_id = g.id) as total_accepted_value,
             (SELECT id FROM supplier_invoices si WHERE si.grn_id = g.id LIMIT 1) as linked_invoice_id,
             (SELECT status FROM supplier_invoices si WHERE si.grn_id = g.id LIMIT 1) as linked_invoice_status
        FROM site_grn g
       ${whereSql}
       ORDER BY g.created_at DESC, g.id DESC
       LIMIT 300
    `).all(...params);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get GRN Details by ID with items, audit log, linked invoice & payment
router.get('/grn/:id', (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  try {
    let grn = db.prepare(`SELECT * FROM site_grn WHERE id=?`).get(id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });

    if (!grn.challan_doc_url && (grn.delivery_challan_no || grn.vendor_po_id)) {
      try {
        const fallbackDn = db.prepare(`
          SELECT COALESCE(NULLIF(file_path, ''), NULLIF(receipt_file_path, ''), NULLIF(sales_bill_file_path, '')) as photo_url
            FROM delivery_notes
           WHERE (document_number = ? OR vendor_po_id = ?)
             AND (file_path IS NOT NULL OR receipt_file_path IS NOT NULL OR sales_bill_file_path IS NOT NULL)
           ORDER BY id DESC LIMIT 1
        `).get(grn.delivery_challan_no || '', grn.vendor_po_id || -1);
        if (fallbackDn?.photo_url) {
          grn.challan_doc_url = fallbackDn.photo_url;
        }
      } catch (_) {}
    }

    const items = db.prepare(`SELECT * FROM site_grn_items WHERE grn_id=? ORDER BY id ASC`).all(id);
    const audit_logs = db.prepare(`SELECT * FROM site_grn_audit_log WHERE grn_id=? ORDER BY timestamp DESC, id DESC`).all(id);
    const linked_invoice = db.prepare(`SELECT * FROM supplier_invoices WHERE grn_id=?`).get(id);
    let linked_payment = null;
    if (linked_invoice) {
      linked_payment = db.prepare(`SELECT * FROM supplier_payments WHERE invoice_id=?`).get(linked_invoice.id);
    }

    res.json({
      ...grn,
      items,
      audit_logs,
      linked_invoice,
      linked_payment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Attach or Update Photos on existing GRN
router.post('/grn/:id/attach-photos', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { challan_doc_url, material_photos } = req.body || {};

  try {
    const grn = db.prepare('SELECT id, challan_doc_url, material_photos, status FROM site_grn WHERE id=?').get(id);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });

    const newChallan = challan_doc_url !== undefined ? challan_doc_url : grn.challan_doc_url;
    let newPhotos = grn.material_photos;
    if (material_photos !== undefined) {
      newPhotos = typeof material_photos === 'object' ? JSON.stringify(material_photos) : material_photos;
    }

    db.prepare(`UPDATE site_grn SET challan_doc_url=?, material_photos=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(newChallan, newPhotos, id);

    logGrnAudit(db, id, 'ATTACH_PHOTOS', req.user, grn.status, grn.status, 'Updated challan / unloading photos');
    res.json({ success: true, challan_doc_url: newChallan, material_photos: newPhotos });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create GRN (Store / Site Store)
router.post('/grn', (req, res) => {
  const db = getDb();
  const {
    site_id, site_name, warehouse_id, warehouse_name,
    vendor_id, vendor_name, vendor_po_id, po_number,
    delivery_challan_no, challan_date, vehicle_number,
    remarks, challan_doc_url, material_photos, attachments,
    items, is_submit
  } = req.body || {};

  if (!delivery_challan_no || !String(delivery_challan_no).trim()) {
    return res.status(400).json({ error: 'Delivery Challan Number is required' });
  }
  if (!items || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: 'At least one material item is required' });
  }

  // Material Line Validations
  for (const it of items) {
    const curr = Number(it.curr_received_qty || 0);
    const acc = Number(it.accepted_qty || 0);
    const rej = Number(it.rejected_qty || 0);

    if (curr < 0 || acc < 0 || rej < 0) {
      return res.status(400).json({ error: `Quantities cannot be negative for item: ${it.material_name || 'Item'}` });
    }
    // Validation 1: Accepted Qty + Rejected Qty must equal Current Received Qty
    if (Math.abs((acc + rej) - curr) > 0.001) {
      return res.status(400).json({
        error: `Validation Failed for "${it.material_name}": Accepted Qty (${acc}) + Rejected Qty (${rej}) must equal Current Received Qty (${curr}).`
      });
    }
    if (rej > 0 && !String(it.rejection_reason || '').trim()) {
      return res.status(400).json({
        error: `Please provide a rejection reason for "${it.material_name}" having ${rej} rejected quantity.`
      });
    }
  }

  const year = new Date().getFullYear();
  const prefix = `GRN/${year}/`;
  const initialStatus = is_submit ? 'submitted' : 'draft';
  const today = istToday();

  try {
    let grnId, grnNumber;

    db.transaction(() => {
      grnNumber = nextSequence(db, 'site_grn', 'grn_number', prefix, { pad: 4 });

      // Resolve site and warehouse names if missing
      let sName = site_name;
      if (!sName && site_id) {
        sName = db.prepare('SELECT name FROM sites WHERE id=?').get(site_id)?.name;
      }
      let wName = warehouse_name;
      if (!wName && warehouse_id) {
        wName = db.prepare('SELECT name FROM warehouses WHERE id=?').get(warehouse_id)?.name;
      }
      // Resolve vendor
      const { vendorId: resolvedVendorId, vendorName: resolvedVendorName } = resolveVendor(db, vendor_id, vendor_name);

      const stmt = db.prepare(`
        INSERT INTO site_grn (
          grn_number, grn_date, site_id, site_name, warehouse_id, warehouse_name,
          vendor_id, vendor_name, vendor_po_id, po_number, delivery_challan_no, challan_date,
          vehicle_number, received_by, received_by_name, status, stock_updated,
          remarks, challan_doc_url, material_photos, attachments, created_by, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)
      `);

      const r = stmt.run(
        grnNumber,
        today,
        site_id || null,
        sName || null,
        warehouse_id || null,
        wName || null,
        resolvedVendorId,
        resolvedVendorName,
        vendor_po_id || null,
        po_number || null,
        String(delivery_challan_no).trim(),
        challan_date || today,
        vehicle_number || null,
        req.user.id,
        req.user.name,
        initialStatus,
        remarks || null,
        challan_doc_url || null,
        typeof material_photos === 'object' ? JSON.stringify(material_photos) : (material_photos || null),
        typeof attachments === 'object' ? JSON.stringify(attachments) : (attachments || null),
        req.user.id,
        req.user.name
      );

      grnId = r.lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO site_grn_items (
          grn_id, item_master_id, item_code, material_name, unit,
          po_qty, prev_received_qty, curr_received_qty, accepted_qty, rejected_qty,
          unit_rate, tax_rate, total_amount, rejection_reason, remarks
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of items) {
        const curr = Number(it.curr_received_qty || 0);
        const acc = Number(it.accepted_qty || 0);
        const rej = Number(it.rejected_qty || 0);
        const rate = Number(it.unit_rate || 0);
        const tax = Number(it.tax_rate || 18);
        const totAmt = acc * rate;

        insItem.run(
          grnId,
          it.item_master_id || null,
          it.item_code || null,
          it.material_name || 'Material',
          it.unit || 'nos',
          Number(it.po_qty || 0),
          Number(it.prev_received_qty || 0),
          curr,
          acc,
          rej,
          rate,
          tax,
          totAmt,
          it.rejection_reason || null,
          it.remarks || null
        );
      }

      logGrnAudit(
        db,
        grnId,
        is_submit ? 'SUBMITTED' : 'CREATED',
        req.user,
        null,
        initialStatus,
        is_submit ? 'GRN created and submitted for verification' : 'GRN created as draft'
      );
    })();

    res.status(201).json({
      message: is_submit ? 'GRN submitted successfully' : 'GRN draft saved successfully',
      id: grnId,
      grn_number: grnNumber,
      status: initialStatus
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update Draft or Correction GRN
router.put('/grn/:id', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(id);

  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  if (grn.status === 'approved') {
    return res.status(403).json({ error: 'Approved GRN cannot be edited directly. Contact administrator.' });
  }

  const {
    site_id, site_name, warehouse_id, warehouse_name,
    vendor_id, vendor_name, vendor_po_id, po_number,
    delivery_challan_no, challan_date, vehicle_number,
    remarks, challan_doc_url, material_photos, attachments,
    items, is_submit
  } = req.body || {};

  // Material Line Validations
  if (items && Array.isArray(items)) {
    for (const it of items) {
      const curr = Number(it.curr_received_qty || 0);
      const acc = Number(it.accepted_qty || 0);
      const rej = Number(it.rejected_qty || 0);
      if (Math.abs((acc + rej) - curr) > 0.001) {
        return res.status(400).json({
          error: `Validation Failed for "${it.material_name}": Accepted (${acc}) + Rejected (${rej}) must equal Current Received (${curr}).`
        });
      }
      if (rej > 0 && !String(it.rejection_reason || '').trim()) {
        return res.status(400).json({
          error: `Please provide a rejection reason for "${it.material_name}" having ${rej} rejected quantity.`
        });
      }
    }
  }

  const newStatus = is_submit ? 'submitted' : grn.status;

  try {
    db.transaction(() => {
      db.prepare(`
        UPDATE site_grn SET
          site_id = COALESCE(?, site_id),
          site_name = COALESCE(?, site_name),
          warehouse_id = COALESCE(?, warehouse_id),
          warehouse_name = COALESCE(?, warehouse_name),
          vendor_id = COALESCE(?, vendor_id),
          vendor_name = COALESCE(?, vendor_name),
          vendor_po_id = COALESCE(?, vendor_po_id),
          po_number = COALESCE(?, po_number),
          delivery_challan_no = COALESCE(?, delivery_challan_no),
          challan_date = COALESCE(?, challan_date),
          vehicle_number = COALESCE(?, vehicle_number),
          remarks = COALESCE(?, remarks),
          challan_doc_url = COALESCE(?, challan_doc_url),
          material_photos = COALESCE(?, material_photos),
          attachments = COALESCE(?, attachments),
          status = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        site_id || null, site_name || null, warehouse_id || null, warehouse_name || null,
        vendor_id || null, vendor_name || null, vendor_po_id || null, po_number || null,
        delivery_challan_no || null, challan_date || null, vehicle_number || null,
        remarks || null, challan_doc_url || null,
        typeof material_photos === 'object' ? JSON.stringify(material_photos) : (material_photos || null),
        typeof attachments === 'object' ? JSON.stringify(attachments) : (attachments || null),
        newStatus,
        id
      );

      if (items && Array.isArray(items) && items.length > 0) {
        db.prepare('DELETE FROM site_grn_items WHERE grn_id=?').run(id);
        const insItem = db.prepare(`
          INSERT INTO site_grn_items (
            grn_id, item_master_id, item_code, material_name, unit,
            po_qty, prev_received_qty, curr_received_qty, accepted_qty, rejected_qty,
            unit_rate, tax_rate, total_amount, rejection_reason, remarks
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        for (const it of items) {
          const curr = Number(it.curr_received_qty || 0);
          const acc = Number(it.accepted_qty || 0);
          const rej = Number(it.rejected_qty || 0);
          const rate = Number(it.unit_rate || 0);
          const tax = Number(it.tax_rate || 18);
          insItem.run(
            id, it.item_master_id || null, it.item_code || null,
            it.material_name || 'Material', it.unit || 'nos',
            Number(it.po_qty || 0), Number(it.prev_received_qty || 0),
            curr, acc, rej, rate, tax, acc * rate,
            it.rejection_reason || null, it.remarks || null
          );
        }
      }

      logGrnAudit(
        db,
        id,
        is_submit ? 'RESUBMITTED' : 'MODIFIED',
        req.user,
        grn.status,
        newStatus,
        is_submit ? 'GRN updated and submitted for verification' : 'GRN draft updated'
      );
    })();

    res.json({ message: 'GRN updated successfully', status: newStatus });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Submit GRN
router.post('/grn/:id/submit', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(id);

  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  if (grn.status === 'approved') return res.status(400).json({ error: 'GRN is already approved' });

  db.prepare(`UPDATE site_grn SET status='submitted', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  logGrnAudit(db, id, 'SUBMITTED', req.user, grn.status, 'submitted', 'GRN submitted for verification');

  res.json({ message: 'GRN submitted for verification', status: 'submitted' });
});

// Verify GRN (Site Engineer / Manager)
router.post('/grn/:id/verify', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { remarks } = req.body || {};
  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(id);

  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  if (grn.status === 'approved') return res.status(400).json({ error: 'GRN is already approved' });

  db.prepare(`
    UPDATE site_grn SET
      status = 'under_verification',
      verified_by = ?,
      verified_by_name = ?,
      verified_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.user.id, req.user.name, id);

  logGrnAudit(db, id, 'VERIFIED', req.user, grn.status, 'under_verification', remarks || 'Material physically verified at site');

  res.json({ message: 'GRN marked as Under Verification', status: 'under_verification' });
});

// Approve GRN (Authorized Approver) + AUTOMATIC SITE STOCK UPDATE
router.post('/grn/:id/approve', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { approval_remarks } = req.body || {};

  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(id);
  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  if (grn.status === 'approved') return res.status(400).json({ error: 'GRN is already approved' });

  // Resolve warehouse ID for stock update
  let warehouseId = grn.warehouse_id;
  if (!warehouseId && grn.site_id) {
    const wh = db.prepare("SELECT id FROM warehouses WHERE site_id=? AND type='site_store' AND COALESCE(active,1)=1 LIMIT 1").get(grn.site_id);
    if (wh) warehouseId = wh.id;
  }
  if (!warehouseId) {
    const wh = db.prepare("SELECT id FROM warehouses WHERE COALESCE(active,1)=1 ORDER BY type='site_store' DESC, id ASC LIMIT 1").get();
    if (wh) warehouseId = wh.id;
  }

  if (!warehouseId) {
    return res.status(400).json({ error: 'No active warehouse/site store found to credit stock to. Please check Warehouse setup.' });
  }

  const items = db.prepare('SELECT * FROM site_grn_items WHERE grn_id=?').all(id);
  if (!items.length) {
    return res.status(400).json({ error: 'GRN has no material items' });
  }

  let stockUpdatedCount = 0;

  try {
    db.transaction(() => {
      // 1. Update GRN status to APPROVED
      db.prepare(`
        UPDATE site_grn SET
          status = 'approved',
          approved_by = ?,
          approved_by_name = ?,
          approved_at = CURRENT_TIMESTAMP,
          approval_remarks = ?,
          stock_updated = 1,
          stock_updated_at = CURRENT_TIMESTAMP,
          warehouse_id = ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(req.user.id, req.user.name, approval_remarks || null, warehouseId, id);

      // 2. TRANSACTIONAL SITE STOCK INTEGRATION
      // Apply accepted quantity ONLY to stock_balance & stock_movements
      const getBal = db.prepare('SELECT * FROM stock_balance WHERE warehouse_id = ? AND item_master_id = ?');
      const insBal = db.prepare('INSERT INTO stock_balance (warehouse_id, item_master_id, quantity, avg_rate, condition) VALUES (?, ?, ?, ?, ?)');
      const upBal = db.prepare('UPDATE stock_balance SET quantity = ?, avg_rate = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
      const insMove = db.prepare(`
        INSERT INTO stock_movements (
          warehouse_id, item_master_id, type, quantity, rate, total_value,
          reference_type, reference_id, site_id, notes, created_by
        ) VALUES (?, ?, 'IN', ?, ?, ?, 'SITE_GRN', ?, ?, ?, ?)
      `);

      for (const it of items) {
        const acceptedQty = Number(it.accepted_qty || 0);
        // Do NOT add rejected quantity to stock
        if (acceptedQty <= 0) continue;

        let itemMasterId = it.item_master_id;
        // If item_master_id is missing, try looking up by exact code or name
        if (!itemMasterId) {
          const match = db.prepare('SELECT id FROM item_master WHERE item_code = ? OR LOWER(item_name) = LOWER(?) LIMIT 1')
            .get(it.item_code || '', it.material_name || '');
          if (match) itemMasterId = match.id;
        }

        if (!itemMasterId) {
          // Auto-create item in item_master if completely absent so inventory tracking is preserved
          const code = it.item_code || `ITM-${Date.now().toString().slice(-6)}`;
          const insMaster = db.prepare(`
            INSERT INTO item_master (item_code, item_name, uom, current_price)
            VALUES (?, ?, ?, ?)
          `).run(code, it.material_name, it.unit || 'PCS', Number(it.unit_rate || 0));
          itemMasterId = insMaster.lastInsertRowid;
          // Link back to grn_items
          db.prepare('UPDATE site_grn_items SET item_master_id = ? WHERE id = ?').run(itemMasterId, it.id);
        }

        const rate = Number(it.unit_rate || 0);
        const curBal = getBal.get(warehouseId, itemMasterId);

        if (curBal) {
          const prevQty = Number(curBal.quantity || 0);
          const prevRate = Number(curBal.avg_rate || 0);
          const newQty = prevQty + acceptedQty;
          const newAvgRate = newQty > 0 ? ((prevQty * prevRate) + (acceptedQty * rate)) / newQty : 0;
          upBal.run(newQty, newAvgRate, curBal.id);
        } else {
          insBal.run(warehouseId, itemMasterId, acceptedQty, rate, 'Unused');
        }

        // Record stock movement journal
        insMove.run(
          warehouseId,
          itemMasterId,
          acceptedQty,
          rate,
          acceptedQty * rate,
          grn.grn_number,
          grn.site_id || null,
          `Stock IN from Approved Site GRN ${grn.grn_number} (Challan: ${grn.delivery_challan_no})`,
          req.user.id
        );

        stockUpdatedCount++;
      }

      logGrnAudit(
        db,
        id,
        'APPROVED',
        req.user,
        grn.status,
        'approved',
        `GRN Approved. Stock updated for ${stockUpdatedCount} items in warehouse #${warehouseId}. ${approval_remarks || ''}`
      );
    })();

    res.json({
      message: `GRN ${grn.grn_number} Approved successfully! Stock updated with +Accepted Quantity for ${stockUpdatedCount} material(s).`,
      status: 'approved',
      stock_updated_items: stockUpdatedCount
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Reject GRN or Send Back for Correction
router.post('/grn/:id/reject', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { reason, action_type } = req.body || {};

  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: 'Rejection/Correction reason is mandatory' });
  }

  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(id);
  if (!grn) return res.status(404).json({ error: 'GRN not found' });
  if (grn.status === 'approved') return res.status(400).json({ error: 'Approved GRN cannot be rejected' });

  const targetStatus = action_type === 'correction' ? 'correction' : 'rejected';

  db.prepare(`
    UPDATE site_grn SET
      status = ?,
      rejection_reason = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(targetStatus, String(reason).trim(), id);

  logGrnAudit(
    db,
    id,
    targetStatus === 'correction' ? 'SENT_FOR_CORRECTION' : 'REJECTED',
    req.user,
    grn.status,
    targetStatus,
    reason
  );

  res.json({
    message: targetStatus === 'correction' ? 'GRN sent back for correction' : 'GRN rejected',
    status: targetStatus
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. SUPPLIER INVOICE & 3-WAY MATCHING MODULE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// Helper: Run 3-Way Match Algorithm (PO vs GRN vs Invoice)
function calculate3WayMatch(poItems, grnItems, invoiceItems) {
  let isMatched = true;
  let discrepancies = [];
  let enrichedInvoiceItems = [];
  let totalTaxable = 0;
  let totalGst = 0;
  let totalInvoice = 0;

  for (const invIt of invoiceItems) {
    const grnIt = grnItems.find(g => g.id === invIt.grn_item_id || (g.material_name && invIt.material_name && g.material_name.trim().toLowerCase() === invIt.material_name.trim().toLowerCase())) || {};
    const poIt = poItems.find(p => p.id === grnIt.po_item_id || (p.description && invIt.material_name && p.description.trim().toLowerCase() === invIt.material_name.trim().toLowerCase())) || {};

    const invQty = Number(invIt.invoice_qty || 0);
    const invRate = Number(invIt.invoice_rate || 0);
    const grnAccQty = Number(grnIt.accepted_qty || 0);
    const poRate = Number(poIt.rate || grnIt.unit_rate || invRate);
    const poQty = Number(poIt.quantity || grnIt.po_qty || 0);
    const taxRate = Number(invIt.tax_rate || grnIt.tax_rate || 18);

    const lineTaxable = invQty * invRate;
    const lineGst = (lineTaxable * taxRate) / 100;
    const lineTotal = lineTaxable + lineGst;

    totalTaxable += lineTaxable;
    totalGst += lineGst;
    totalInvoice += lineTotal;

    // Matching Checks
    const qtyMatched = Math.abs(invQty - grnAccQty) <= 0.001;
    const rateMatched = Math.abs(invRate - poRate) <= 0.01;
    const taxMatched = Math.abs(taxRate - (Number(grnIt.tax_rate || 18))) <= 0.01;

    let itemNotes = [];
    if (!qtyMatched) {
      isMatched = false;
      const msg = `Quantity Mismatch: Invoice Qty (${invQty}) does not match GRN Accepted Qty (${grnAccQty}). Variance: ${(invQty - grnAccQty).toFixed(2)}`;
      itemNotes.push(msg);
      discrepancies.push({ item: invIt.material_name, type: 'QTY_MISMATCH', message: msg });
    }
    if (!rateMatched) {
      isMatched = false;
      const msg = `Rate Variance: Invoice Rate (₹${invRate}) does not match PO Rate (₹${poRate}). Diff: ₹${(invRate - poRate).toFixed(2)}`;
      itemNotes.push(msg);
      discrepancies.push({ item: invIt.material_name, type: 'RATE_MISMATCH', message: msg });
    }

    enrichedInvoiceItems.push({
      ...invIt,
      grn_item_id: grnIt.id || null,
      item_master_id: grnIt.item_master_id || null,
      item_code: grnIt.item_code || null,
      material_name: invIt.material_name || grnIt.material_name,
      unit: invIt.unit || grnIt.unit || 'nos',
      po_qty: poQty,
      po_rate: poRate,
      grn_accepted_qty: grnAccQty,
      invoice_qty: invQty,
      invoice_rate: invRate,
      tax_rate: taxRate,
      taxable_amount: lineTaxable,
      gst_amount: lineGst,
      line_total: lineTotal,
      qty_matched: qtyMatched ? 1 : 0,
      rate_matched: rateMatched ? 1 : 0,
      tax_matched: taxMatched ? 1 : 0,
      discrepancy_notes: itemNotes.join('; ')
    });
  }

  return {
    isMatched,
    matchStatus: isMatched ? 'matched' : 'mismatched',
    discrepancies,
    enrichedInvoiceItems,
    taxableAmount: totalTaxable,
    gstAmount: totalGst,
    totalAmount: totalInvoice
  };
}

// Get approved GRN data for invoice creation
router.get('/invoices/grn-for-invoice/:grn_id', (req, res) => {
  const db = getDb();
  const grnId = +req.params.grn_id;

  try {
    let grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(grnId);
    if (!grn) return res.status(404).json({ error: 'GRN not found' });

    if (!grn.challan_doc_url && (grn.delivery_challan_no || grn.vendor_po_id)) {
      try {
        const fallbackDn = db.prepare(`
          SELECT COALESCE(NULLIF(file_path, ''), NULLIF(receipt_file_path, ''), NULLIF(sales_bill_file_path, '')) as photo_url
            FROM delivery_notes
           WHERE (document_number = ? OR vendor_po_id = ?)
             AND (file_path IS NOT NULL OR receipt_file_path IS NOT NULL OR sales_bill_file_path IS NOT NULL)
           ORDER BY id DESC LIMIT 1
        `).get(grn.delivery_challan_no || '', grn.vendor_po_id || -1);
        if (fallbackDn?.photo_url) {
          grn.challan_doc_url = fallbackDn.photo_url;
        }
      } catch (_) {}
    }

    if (grn.status !== 'approved') {
      return res.status(400).json({
        error: `Cannot create invoice for GRN with status "${grn.status}". Material must be approved through GRN first.`
      });
    }

    const items = db.prepare('SELECT * FROM site_grn_items WHERE grn_id=?').all(grnId);

    // Pull PO items if vendor_po_id exists
    let poItems = [];
    if (grn.vendor_po_id) {
      const po = db.prepare('SELECT indent_id FROM vendor_pos WHERE id=?').get(grn.vendor_po_id);
      if (po?.indent_id) {
        poItems = db.prepare('SELECT * FROM indent_items WHERE indent_id=?').all(po.indent_id);
      }
    }

    res.json({
      grn,
      items: items.map(g => {
        const poIt = poItems.find(p => p.item_master_id === g.item_master_id || p.description === g.material_name);
        return {
          grn_item_id: g.id,
          item_master_id: g.item_master_id,
          item_code: g.item_code,
          material_name: g.material_name,
          unit: g.unit,
          po_qty: g.po_qty,
          po_rate: poIt?.rate || g.unit_rate,
          grn_accepted_qty: g.accepted_qty,
          invoice_qty: g.accepted_qty, // defaults to accepted qty
          invoice_rate: poIt?.rate || g.unit_rate, // defaults to PO rate
          tax_rate: g.tax_rate || 18,
          line_total: (g.accepted_qty * (poIt?.rate || g.unit_rate)) * (1 + (g.tax_rate || 18) / 100)
        };
      })
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List Supplier Invoices with filters
router.get('/invoices', (req, res) => {
  const db = getDb();
  const { status, match_status, vendor_id, search, from_date, to_date } = req.query;

  const where = [];
  const params = [];

  if (status && status !== 'all') {
    if (status === 'pending' || status === 'pending_approval' || status === 'submitted') {
      where.push("si.status IN ('submitted', 'verification', 'matched')");
    } else if (status === 'exception') {
      where.push("(si.status = 'exception' OR si.match_status = 'mismatched')");
    } else {
      where.push('si.status = ?');
      params.push(status);
    }
  }
  if (match_status && match_status !== 'all') { where.push('si.match_status = ?'); params.push(match_status); }
  if (vendor_id) { where.push('si.vendor_id = ?'); params.push(+vendor_id); }
  if (from_date) { where.push('si.invoice_date >= ?'); params.push(from_date); }
  if (to_date) { where.push('si.invoice_date <= ?'); params.push(to_date); }
  if (search) {
    where.push('(si.invoice_number LIKE ? OR si.grn_number LIKE ? OR si.vendor_name LIKE ? OR si.po_number LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const rows = db.prepare(`
      SELECT si.*,
             (SELECT COUNT(*) FROM supplier_invoice_items sii WHERE sii.invoice_id = si.id) as item_count,
             (SELECT COUNT(*) FROM supplier_invoice_items sii WHERE sii.invoice_id = si.id AND (sii.qty_matched = 0 OR sii.rate_matched = 0)) as mismatch_item_count,
             (SELECT id FROM supplier_payments sp WHERE sp.invoice_id = si.id LIMIT 1) as linked_payment_id,
             (SELECT status FROM supplier_payments sp WHERE sp.invoice_id = si.id LIMIT 1) as linked_payment_status,
             (SELECT bank_reference FROM supplier_payments sp WHERE sp.invoice_id = si.id LIMIT 1) as utr_number
        FROM supplier_invoices si
       ${whereSql}
       ORDER BY si.created_at DESC, si.id DESC
       LIMIT 300
    `).all(...params);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get Supplier Invoice Details
router.get('/invoices/:id', (req, res) => {
  const db = getDb();
  const id = +req.params.id;

  try {
    const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(id);
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    const items = db.prepare('SELECT * FROM supplier_invoice_items WHERE invoice_id=? ORDER BY id ASC').all(id);
    const audit_logs = db.prepare('SELECT * FROM supplier_invoice_audit_log WHERE invoice_id=? ORDER BY timestamp DESC, id DESC').all(id);
    const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(invoice.grn_id);
    const payment = db.prepare('SELECT * FROM supplier_payments WHERE invoice_id=?').get(id);

    res.json({
      ...invoice,
      items,
      audit_logs,
      grn,
      payment
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Create Supplier Invoice & Execute Automatic 3-Way Matching
router.post('/invoices', (req, res) => {
  const db = getDb();
  const {
    invoice_number, invoice_date, due_date,
    grn_id, items, attachment_url, remarks
  } = req.body || {};

  if (!invoice_number || !String(invoice_number).trim()) {
    return res.status(400).json({ error: 'Invoice Number is required' });
  }
  if (!grn_id) {
    return res.status(400).json({ error: 'GRN ID is required to link invoice' });
  }

  const grn = db.prepare('SELECT * FROM site_grn WHERE id=?').get(grn_id);
  if (!grn) return res.status(404).json({ error: 'Referenced GRN not found' });
  if (grn.status !== 'approved') {
    return res.status(400).json({ error: 'Invoice can only be linked to an APPROVED GRN' });
  }

  const grnItems = db.prepare('SELECT * FROM site_grn_items WHERE grn_id=?').all(grn_id);
  let poItems = [];
  if (grn.vendor_po_id) {
    const po = db.prepare('SELECT indent_id FROM vendor_pos WHERE id=?').get(grn.vendor_po_id);
    if (po?.indent_id) {
      poItems = db.prepare('SELECT * FROM indent_items WHERE indent_id=?').all(po.indent_id);
    }
  }

  // Execute 3-Way Match Check
  const matchResult = calculate3WayMatch(poItems, grnItems, items || []);
  const initialStatus = matchResult.isMatched ? 'matched' : 'exception';

  try {
    let invoiceId;

    db.transaction(() => {
      // Resolve vendor safely (handles direct inward without vendor or PO)
      const rawVendorId = req.body?.vendor_id || grn.vendor_id;
      const rawVendorName = req.body?.vendor_name || grn.vendor_name;
      const { vendorId: invVendorId, vendorName: invVendorName } = resolveVendor(db, rawVendorId, rawVendorName);

      const insInvoice = db.prepare(`
        INSERT INTO supplier_invoices (
          invoice_number, invoice_date, due_date, vendor_id, vendor_name,
          site_id, site_name, vendor_po_id, po_number, grn_id, grn_number,
          taxable_amount, gst_amount, total_amount, status, match_status,
          match_details, exception_reason, attachment_url, remarks,
          created_by, created_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      const r = insInvoice.run(
        String(invoice_number).trim(),
        invoice_date || istToday(),
        due_date || null,
        invVendorId,
        invVendorName,
        grn.site_id,
        grn.site_name,
        grn.vendor_po_id,
        grn.po_number,
        grn.id,
        grn.grn_number,
        matchResult.taxableAmount,
        matchResult.gstAmount,
        matchResult.totalAmount,
        initialStatus,
        matchResult.matchStatus,
        JSON.stringify(matchResult.discrepancies),
        matchResult.isMatched ? null : matchResult.discrepancies.map(d => d.message).join('; '),
        attachment_url || null,
        remarks || null,
        req.user.id,
        req.user.name
      );

      invoiceId = r.lastInsertRowid;

      const insItem = db.prepare(`
        INSERT INTO supplier_invoice_items (
          invoice_id, grn_item_id, item_master_id, item_code, material_name, unit,
          po_qty, po_rate, grn_accepted_qty, invoice_qty, invoice_rate, tax_rate,
          taxable_amount, gst_amount, line_total, qty_matched, rate_matched, tax_matched,
          discrepancy_notes
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const it of matchResult.enrichedInvoiceItems) {
        insItem.run(
          invoiceId,
          it.grn_item_id,
          it.item_master_id,
          it.item_code,
          it.material_name,
          it.unit,
          it.po_qty,
          it.po_rate,
          it.grn_accepted_qty,
          it.invoice_qty,
          it.invoice_rate,
          it.tax_rate,
          it.taxable_amount,
          it.gst_amount,
          it.line_total,
          it.qty_matched,
          it.rate_matched,
          it.tax_matched,
          it.discrepancy_notes || null
        );
      }

      logInvoiceAudit(
        db,
        invoiceId,
        matchResult.isMatched ? 'CREATED_AND_MATCHED' : 'CREATED_WITH_EXCEPTIONS',
        req.user,
        null,
        initialStatus,
        matchResult.isMatched
          ? '3-Way Match Passed (PO + GRN + Invoice matched)'
          : `3-Way Match Failed: ${matchResult.discrepancies.length} discrepancy(ies) detected. Invoice placed on EXCEPTION hold.`
      );
    })();

    res.status(201).json({
      message: matchResult.isMatched
        ? 'Invoice created and 3-Way Matched successfully!'
        : 'Invoice created with Discrepancies (placed on Exception Hold).',
      id: invoiceId,
      status: initialStatus,
      match_status: matchResult.matchStatus,
      discrepancies: matchResult.discrepancies
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Accounts Verify Supplier Invoice
router.post('/invoices/:id/verify', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { remarks } = req.body || {};

  const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'approved') return res.status(400).json({ error: 'Invoice is already approved' });

  db.prepare(`
    UPDATE supplier_invoices SET
      status = 'verification',
      verified_by = ?,
      verified_by_name = ?,
      verified_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.user.id, req.user.name, id);

  logInvoiceAudit(db, id, 'VERIFIED', req.user, invoice.status, 'verification', remarks || 'Verified by Accounts team');

  res.json({ message: 'Invoice verified by Accounts', status: 'verification' });
});

// Resolve Exception / Override on Invoice
router.post('/invoices/:id/resolve-exception', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { resolution_notes } = req.body || {};

  if (!resolution_notes || !String(resolution_notes).trim()) {
    return res.status(400).json({ error: 'Resolution notes / authorization rationale is required' });
  }

  const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  db.prepare(`
    UPDATE supplier_invoices SET
      status = 'matched',
      resolution_notes = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(String(resolution_notes).trim(), id);

  logInvoiceAudit(db, id, 'EXCEPTION_RESOLVED', req.user, invoice.status, 'matched', resolution_notes);

  res.json({ message: 'Invoice exception resolved and cleared for approval', status: 'matched' });
});

// Approve Invoice (Accounts / Approver) -> Moves to Payment Pending
router.post('/invoices/:id/approve', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { approval_remarks } = req.body || {};

  const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'approved' || invoice.status === 'payment_pending' || invoice.status === 'paid') {
    return res.status(400).json({ error: 'Invoice is already approved' });
  }

  if (invoice.match_status === 'mismatched' && !invoice.resolution_notes) {
    return res.status(400).json({
      error: 'Cannot approve a mismatched invoice without recorded Exception Resolution / Authorization.'
    });
  }

  db.prepare(`
    UPDATE supplier_invoices SET
      status = 'approved',
      approved_by = ?,
      approved_by_name = ?,
      approved_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(req.user.id, req.user.name, id);

  logInvoiceAudit(db, id, 'APPROVED', req.user, invoice.status, 'approved', approval_remarks || 'Invoice approved for payment');

  res.json({ message: 'Invoice approved! Ready for Payment Processing.', status: 'approved' });
});

// Reject Supplier Invoice
router.post('/invoices/:id/reject', (req, res) => {
  const db = getDb();
  const id = +req.params.id;
  const { reason } = req.body || {};

  const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
  if (invoice.status === 'paid') {
    return res.status(400).json({ error: 'Paid invoice cannot be rejected' });
  }

  const rejReason = String(reason || 'Rejected by Accounts').trim();

  db.prepare(`
    UPDATE supplier_invoices SET
      status = 'rejected',
      exception_reason = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(rejReason, id);

  logInvoiceAudit(db, id, 'REJECTED', req.user, invoice.status, 'rejected', rejReason);

  res.json({ message: 'Invoice rejected successfully', status: 'rejected' });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. PAYMENT PROCESSING MODULE ENDPOINTS
// ─────────────────────────────────────────────────────────────────────────────

// List Approved Invoices Pending Payment
router.get('/payments/pending-invoices', (req, res) => {
  const db = getDb();
  try {
    const rows = db.prepare(`
      SELECT si.*,
             g.delivery_challan_no, g.vehicle_number,
             (SELECT COUNT(*) FROM supplier_invoice_items sii WHERE sii.invoice_id = si.id) as item_count
        FROM supplier_invoices si
        JOIN site_grn g ON g.id = si.grn_id
       WHERE si.status IN ('approved', 'payment_pending', 'payment_processing')
         AND NOT EXISTS (SELECT 1 FROM supplier_payments sp WHERE sp.invoice_id = si.id AND sp.status = 'paid')
       ORDER BY si.approved_at DESC, si.id DESC
    `).all();

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// List Processed Payments
router.get('/payments', (req, res) => {
  const db = getDb();
  const { vendor_id, status, search, from_date, to_date } = req.query;

  const where = [];
  const params = [];

  if (vendor_id) { where.push('sp.vendor_id = ?'); params.push(+vendor_id); }
  if (status && status !== 'all') { where.push('sp.status = ?'); params.push(status); }
  if (from_date) { where.push('sp.payment_date >= ?'); params.push(from_date); }
  if (to_date) { where.push('sp.payment_date <= ?'); params.push(to_date); }
  if (search) {
    where.push('(sp.payment_voucher_no LIKE ? OR sp.invoice_number LIKE ? OR sp.bank_reference LIKE ? OR sp.vendor_name LIKE ?)');
    const q = `%${search}%`;
    params.push(q, q, q, q);
  }

  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  try {
    const rows = db.prepare(`
      SELECT sp.*,
             si.total_amount as invoice_total_amount,
             si.taxable_amount as invoice_taxable_amount,
             si.gst_amount as invoice_gst_amount,
             si.invoice_date
        FROM supplier_payments sp
        JOIN supplier_invoices si ON si.id = sp.invoice_id
       ${whereSql}
       ORDER BY sp.payment_date DESC, sp.id DESC
       LIMIT 300
    `).all(...params);

    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Process Payment (Finance)
router.post('/payments', (req, res) => {
  const db = getDb();
  const {
    invoice_id, payment_date, payment_mode, bank_reference,
    bank_name, tds_deduction, other_deductions, deduction_reason,
    payment_proof_url, payment_remarks
  } = req.body || {};

  if (!invoice_id) return res.status(400).json({ error: 'Invoice ID is required' });
  if (!bank_reference || !String(bank_reference).trim()) {
    return res.status(400).json({ error: 'Bank Reference / UTR Number is required' });
  }

  const invoice = db.prepare('SELECT * FROM supplier_invoices WHERE id=?').get(invoice_id);
  if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

  // Core Business Rule: Only Approved Invoices can move to payment
  if (invoice.status !== 'approved' && invoice.status !== 'payment_pending' && invoice.status !== 'payment_processing') {
    return res.status(400).json({
      error: `Invoice with status "${invoice.status}" cannot be paid. Only APPROVED invoices can proceed to payment.`
    });
  }

  const existingPaid = db.prepare("SELECT id FROM supplier_payments WHERE invoice_id=? AND status='paid'").get(invoice_id);
  if (existingPaid) {
    return res.status(400).json({ error: 'This invoice has already been marked as PAID.' });
  }

  const approvedAmount = Number(invoice.total_amount || 0);
  const tds = Number(tds_deduction || 0);
  const otherDed = Number(other_deductions || 0);
  const netPayable = Math.max(0, approvedAmount - tds - otherDed);

  const year = new Date().getFullYear();
  const voucherPrefix = `PAY/${year}/`;

  try {
    let paymentId, voucherNo;

    db.transaction(() => {
      voucherNo = nextSequence(db, 'supplier_payments', 'payment_voucher_no', voucherPrefix, { pad: 4 });

      // Resolve vendor
      const { vendorId: payVendorId, vendorName: payVendorName } = resolveVendor(db, invoice.vendor_id, invoice.vendor_name);

      const insPay = db.prepare(`
        INSERT INTO supplier_payments (
          payment_voucher_no, invoice_id, invoice_number, vendor_id, vendor_name,
          vendor_po_id, po_number, grn_id, grn_number, approved_amount,
          tds_deduction, other_deductions, deduction_reason, net_payable,
          paid_amount, payment_date, payment_mode, bank_reference, bank_name,
          status, payment_proof_url, payment_remarks, processed_by, processed_by_name
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, ?, ?)
      `);

      const r = insPay.run(
        voucherNo,
        invoice.id,
        invoice.invoice_number,
        payVendorId,
        payVendorName,
        invoice.vendor_po_id,
        invoice.po_number,
        invoice.grn_id,
        invoice.grn_number,
        approvedAmount,
        tds,
        otherDed,
        deduction_reason || null,
        netPayable,
        netPayable,
        payment_date || istToday(),
        payment_mode || 'NEFT/RTGS',
        String(bank_reference).trim(),
        bank_name || null,
        payment_proof_url || null,
        payment_remarks || null,
        req.user.id,
        req.user.name
      );

      paymentId = r.lastInsertRowid;

      // Update Invoice status to PAID
      db.prepare(`
        UPDATE supplier_invoices SET
          status = 'paid',
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(invoice.id);

      logPaymentAudit(
        db,
        paymentId,
        'PAYMENT_RECORDED',
        req.user,
        `Payment of ₹${netPayable.toLocaleString('en-IN')} released via ${payment_mode}. UTR/Ref: ${bank_reference}`
      );

      logInvoiceAudit(
        db,
        invoice.id,
        'PAYMENT_COMPLETED',
        req.user,
        invoice.status,
        'paid',
        `Payment Voucher ${voucherNo} processed. Net Paid: ₹${netPayable.toLocaleString('en-IN')}, UTR: ${bank_reference}`
      );
    })();

    res.status(201).json({
      message: `Payment voucher ${voucherNo} recorded successfully. Invoice marked as PAID.`,
      id: paymentId,
      voucher_number: voucherNo,
      net_payable: netPayable,
      status: 'paid'
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. SUMMARY DASHBOARD METRICS
// ─────────────────────────────────────────────────────────────────────────────
router.get('/metrics', (req, res) => {
  const db = getDb();
  try {
    const totalGrn = db.prepare('SELECT COUNT(*) c FROM site_grn').get().c;
    const pendingGrnVerify = db.prepare("SELECT COUNT(*) c FROM site_grn WHERE status IN ('submitted', 'under_verification')").get().c;
    const approvedGrn = db.prepare("SELECT COUNT(*) c FROM site_grn WHERE status='approved'").get().c;

    const totalInvoices = db.prepare('SELECT COUNT(*) c FROM supplier_invoices').get().c;
    const pendingInvoiceApprove = db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE status IN ('submitted', 'verification', 'matched')").get().c;
    const exceptionInvoices = db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE status='exception' OR match_status='mismatched'").get().c;
    const approvedInvoicesPendingPay = db.prepare("SELECT COUNT(*) c FROM supplier_invoices WHERE status='approved'").get().c;

    const totalPaidPayments = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(paid_amount), 0) sum FROM supplier_payments WHERE status='paid'").get();

    res.json({
      totalGrn,
      pendingGrnVerify,
      approvedGrn,
      totalInvoices,
      pendingInvoiceApprove,
      exceptionInvoices,
      approvedInvoicesPendingPay,
      totalPaidCount: totalPaidPayments.c,
      totalPaidAmount: totalPaidPayments.sum
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
