// Public Vendor Self-Registration Router (TSK-1052)
// Allows prospective vendors/suppliers to register themselves via a public link
// without requiring SEPL purchase team to manually type details.

const express = require('express');
const router = express.Router();
const { getDb } = require('../db/schema');
const { nextSequence } = require('../db/nextSequence');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const storage = require('../lib/storage');

// Safe column migrations for vendors table
function ensureVendorColumns(db) {
  const cols = [
    'bank_name TEXT',
    'account_number TEXT',
    'ifsc_code TEXT',
    'account_type TEXT',
    'pan_number TEXT',
    'msme_number TEXT',
    'gst_doc_url TEXT',
    'cheque_doc_url TEXT',
    'msme_doc_url TEXT',
    'catalog_doc_url TEXT',
    "verification_status TEXT DEFAULT 'verified'",
    'self_registered_at DATETIME',
    'source_link TEXT'
  ];
  for (const c of cols) {
    try { db.exec(`ALTER TABLE vendors ADD COLUMN ${c}`); } catch (_) {}
  }
}

const { UPLOADS_ROOT, ensureDir } = require('../lib/paths');
// Multer storage for public document uploads
const uploadDir = ensureDir(UPLOADS_ROOT);

const diskStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const cleanName = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9_-]/g, '_');
    cb(null, `vendor_doc_${Date.now()}_${cleanName}${ext}`);
  }
});

const upload = multer({
  storage: diskStorage,
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only PDF, JPG, PNG or WEBP documents are allowed'));
  }
});

// GET /api/public/vendor-registration/meta
router.get('/meta', (req, res) => {
  res.json({
    company: 'Secured Engineers Pvt. Ltd. (SEPL)',
    portal: 'SOTYN Vendor Empanelment',
    categories: [
      { id: 'FF', label: 'Fire Fighting (Hydrant, Sprinkler, Alarm, Suppression)' },
      { id: 'ELE', label: 'Electrical (HT/LT Panels, Cables, Trays, Transformers)' },
      { id: 'LV', label: 'LV & Automation (CCTV, FAS, PA, Access Control, Networking)' },
      { id: 'Solar', label: 'Solar Division (Panels, Inverters, Structures, BOS)' },
      { id: 'HVAC', label: 'HVAC & Ventilation (Chillers, Ducting, AHU, VRF)' },
      { id: 'Plumbing', label: 'Plumbing & PHE (Pipes, Pumps, Valves, Fittings)' },
      { id: 'INTERIOR', label: 'Civil, Finishing & Interior Works' },
      { id: 'OTHER', label: 'General Consumables & Safety Equipment' }
    ],
    vendor_types: [
      'Authorized Distributor',
      'Stockist / Dealer',
      'Direct Manufacturer / OEM',
      'Trader',
      'Fabricator',
      'Specialized Contractor / Service Provider'
    ],
    payment_terms_options: [
      '30 Days Credit',
      '45 Days Credit',
      '60 Days Credit',
      '15 Days Credit',
      'Against Delivery / PDC',
      'Advance against PI'
    ]
  });
});

// POST /api/public/vendor-registration/upload
router.post('/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const key = req.file.filename;
    const url = await storage.adoptLocalFile(req.file.path, key, req.file.mimetype);
    res.json({ url, filename: req.file.originalname, size: req.file.size });
  } catch (err) {
    console.error('[publicVendor upload] error:', err.message);
    res.status(500).json({ error: 'File upload failed: ' + err.message });
  }
});

// POST /api/public/vendor-registration/submit
router.post('/submit', async (req, res) => {
  const db = getDb();
  ensureVendorColumns(db);

  const b = req.body || {};
  const firmName = String(b.firm_name || b.name || '').trim();
  const contactPerson = String(b.contact_person || '').trim();
  const phone = String(b.phone || '').trim().replace(/[^0-9]/g, '').slice(-10);
  const email = String(b.email || '').trim().toLowerCase();
  const gst = String(b.gst_number || b.gstin || '').toUpperCase().trim();
  const pan = String(b.pan_number || b.pan || (gst.length === 15 ? gst.slice(2, 12) : '')).toUpperCase().trim();
  const state = String(b.state || '').trim();
  const district = String(b.district || '').trim();
  const address = String(b.address || '').trim();
  const category = String(b.category || 'OTHER').trim();
  const dealsIn = String(b.deals_in || '').trim();
  const makes = String(b.makes || '').trim();
  const type = String(b.type || 'Trader').trim();
  const paymentTerms = String(b.payment_terms || '30 Days Credit').trim();
  const creditDays = String(b.credit_days || (paymentTerms.match(/\d+/) ? paymentTerms.match(/\d+/)[0] : '30')).trim();

  // Basic validation
  if (!firmName || firmName.length < 3) {
    return res.status(400).json({ error: 'Firm / Business name is required (minimum 3 characters)' });
  }
  if (!contactPerson) {
    return res.status(400).json({ error: 'Contact person name is required' });
  }
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'A valid 10-digit mobile number is required' });
  }
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'A valid official email address is required' });
  }
  if (gst && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/.test(gst)) {
    return res.status(400).json({ error: 'Invalid GSTIN format (must be 15 characters, e.g. 03AAAAA0000A1Z5)' });
  }

  try {
    // Duplicate check by GSTIN or Phone
    let existing = null;
    if (gst) {
      existing = db.prepare('SELECT id, vendor_code, firm_name, phone FROM vendors WHERE UPPER(TRIM(gst_number))=?').get(gst);
    }
    if (!existing && phone) {
      existing = db.prepare('SELECT id, vendor_code, firm_name, phone FROM vendors WHERE phone LIKE ?').get(`%${phone}%`);
    }

    if (existing) {
      return res.status(200).json({
        success: true,
        already_registered: true,
        vendor_code: existing.vendor_code || `VEN-${String(existing.id).padStart(4, '0')}`,
        firm_name: existing.firm_name || firmName,
        message: `Your firm "${existing.firm_name || firmName}" is already registered with SEPL under code ${existing.vendor_code || ''}. Our purchase team has your details on record.`
      });
    }

    // Generate next vendor code
    const vendorCode = nextSequence(db, 'vendors', 'vendor_code', 'VEN-', { startFrom: 1, pad: 4 });

    const stmt = db.prepare(`
      INSERT INTO vendors (
        vendor_code, name, firm_name, contact_person, phone, email,
        district, state, address, category, deals_in, makes, type,
        payment_terms, credit_days, gst_number, pan_number, msme_number,
        bank_name, account_number, ifsc_code, account_type,
        gst_doc_url, cheque_doc_url, msme_doc_url, catalog_doc_url,
        source, verification_status, self_registered_at, active
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        'Vendor Self-Registration Link', 'verified', CURRENT_TIMESTAMP, 1
      )
    `);

    const r = stmt.run(
      vendorCode,
      firmName,
      firmName,
      contactPerson,
      phone,
      email,
      district,
      state,
      address,
      category,
      dealsIn,
      makes,
      type,
      paymentTerms,
      creditDays,
      gst || null,
      pan || null,
      b.msme_number || null,
      b.bank_name || null,
      b.account_number || null,
      b.ifsc_code ? String(b.ifsc_code).toUpperCase().trim() : null,
      b.account_type || 'Current',
      b.gst_doc_url || null,
      b.cheque_doc_url || null,
      b.msme_doc_url || null,
      b.catalog_doc_url || null
    );

    const newVendorId = r.lastInsertRowid;

    // Send notifications to Purchase team & Admins
    try {
      const staff = db.prepare(`
        SELECT id FROM users
        WHERE active=1 AND (
          role='admin'
          OR LOWER(department) LIKE '%purchase%'
          OR LOWER(department) LIKE '%procurement%'
        )
      `).all();

      const notifStmt = db.prepare(`
        INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
        VALUES (?, 'vendor_self_reg', ?, ?, '/vendors', 'in_app', ?)
      `);

      for (const s of staff) {
        try {
          notifStmt.run(
            s.id,
            `New Vendor Registered: ${firmName}`,
            `Online registration completed (${vendorCode}) · ${contactPerson} (${phone}) · ${category}. Ready for RFQs.`,
            `v-reg-${newVendorId}-${s.id}`
          );
        } catch (_) {}
      }
    } catch (notifErr) {
      console.warn('[publicVendor] notify error:', notifErr.message);
    }

    res.status(201).json({
      success: true,
      vendor_code: vendorCode,
      firm_name: firmName,
      message: `Registration successful! Your firm "${firmName}" is now registered with Secured Engineers Pvt Ltd under code ${vendorCode}.`
    });

  } catch (err) {
    console.error('[publicVendor] submit error:', err);
    res.status(500).json({ error: 'Registration failed: ' + err.message });
  }
});

module.exports = router;

