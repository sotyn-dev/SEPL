// Tools management module — catalogs returnable assets (drills, ladders,
// multimeters, safety gear) separately from consumable stock. Three
// pieces:
//   1. tools          - master catalog with serial / condition / current
//                       location (site or user)
//   2. tool_movements - log of every issue / return / transfer / scrap
//   3. tools_list_submissions - weekly per-site tool count submission
//                              (powers Supervisor MIS KPI)

const express = require('express');
const QRCode = require('qrcode');
const router = express.Router();
const { getDb } = require('../db/schema');
const { statusFilter } = require('../lib/statusFilter');
const { authMiddleware, requirePermission, adminOnly } = require('../middleware/auth');
const { nextSequence } = require('../db/nextSequence');
const { TOOLS_SITE_SUMMARY_SQL } = require('../lib/toolsSiteSummary');
const { getRgpToolsSyncStatus, drainRgpToolsSync } = require('../lib/rgpToolsSync');

router.use(authMiddleware);

// Tools are individual instances of RGP Item Master rows. Keep this
// migration beside the route so older databases are upgraded on deploy.
try { getDb().exec('ALTER TABLE tools ADD COLUMN item_master_id INTEGER REFERENCES item_master(id)'); } catch (_) {}
const toolColumns = getDb().prepare('PRAGMA table_info(tools)').all().map(c => c.name);
if (!toolColumns.includes('quantity')) getDb().exec('ALTER TABLE tools ADD COLUMN quantity REAL NOT NULL DEFAULT 1 CHECK(quantity > 0)');
if (!toolColumns.includes('unit')) getDb().exec('ALTER TABLE tools ADD COLUMN unit TEXT');
// Tools Barcode & TVS Sticker columns migration (TSK-0514)
try {
  const db = getDb();
  const cols = db.prepare('PRAGMA table_info(tools)').all().map(c => c.name);
  if (!cols.includes('barcode')) db.exec('ALTER TABLE tools ADD COLUMN barcode TEXT');
  if (!cols.includes('sticker_status')) db.exec("ALTER TABLE tools ADD COLUMN sticker_status TEXT DEFAULT 'pending_print'");
  if (!cols.includes('sticker_printed_at')) db.exec('ALTER TABLE tools ADD COLUMN sticker_printed_at DATETIME');
  if (!cols.includes('sticker_printed_by')) db.exec('ALTER TABLE tools ADD COLUMN sticker_printed_by INTEGER REFERENCES users(id)');
  if (!cols.includes('sticker_pasted_at')) db.exec('ALTER TABLE tools ADD COLUMN sticker_pasted_at DATETIME');
  if (!cols.includes('sticker_pasted_by')) db.exec('ALTER TABLE tools ADD COLUMN sticker_pasted_by INTEGER REFERENCES users(id)');
  if (!cols.includes('sticker_photo_url')) db.exec('ALTER TABLE tools ADD COLUMN sticker_photo_url TEXT');
  if (!cols.includes('sticker_notes')) db.exec('ALTER TABLE tools ADD COLUMN sticker_notes TEXT');
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tools_barcode ON tools(barcode)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_tools_sticker_status ON tools(sticker_status)'); } catch (_) {}
} catch (_) {}


// Preserve assigned serials; fill older blank records once with the next number.
getDb().transaction(() => {
  const db = getDb();
  const missing = db.prepare("SELECT id FROM tools WHERE serial_no IS NULL OR TRIM(serial_no) = '' ORDER BY id").all();
  const assign = db.prepare('UPDATE tools SET serial_no=? WHERE id=?');
  for (const tool of missing) {
    assign.run(nextSequence(db, 'tools', 'serial_no', ''), tool.id);
  }
})();

function validQuantity(value) {
  return (typeof value === 'number' || typeof value === 'string') && Number.isFinite(Number(value)) && Number(value) > 0;
}

function validUnit(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 30;
}

// ---------- TOOLS CATALOG ----------

router.get('/rgp-sync', adminOnly, (req, res) => {
  try { res.json(getRgpToolsSyncStatus(getDb())); }
  catch (error) { res.status(500).json({ error: error.message }); }
});

router.post('/rgp-sync', adminOnly, (req, res) => {
  try {
    const id = req.body?.delivery_note_id;
    if (id !== undefined && (!Number.isSafeInteger(Number(id)) || Number(id) <= 0)) return res.status(400).json({ error: 'Invalid challan ID' });
    res.json(drainRgpToolsSync(getDb(), { retry: true, deliveryNoteId: id ? Number(id) : null }));
  } catch (error) { res.status(500).json({ error: error.message }); }
});

router.get('/', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { category, status, site_id, user_id, search, sticker_status } = req.query;
    let sql = `
      SELECT t.*,
             im.item_code as item_master_code,
             im.specification as item_specification,
             im.size as item_size,
             im.uom as item_uom,
             COALESCE(NULLIF(TRIM(t.unit), ''), 'Nos') as resolved_unit,
             im.photo_link as item_photo_link,
             s.name as current_site_name,
             u.name as current_user_name,
             np.name as sticker_printed_by_name,
             ap.name as sticker_pasted_by_name,
             cu.name as created_by_name
      FROM tools t
      LEFT JOIN item_master im ON im.id = t.item_master_id
      LEFT JOIN sites s ON s.id = t.current_site_id
      LEFT JOIN users u ON u.id = t.current_user_id
      LEFT JOIN users np ON np.id = t.sticker_printed_by
      LEFT JOIN users ap ON ap.id = t.sticker_pasted_by
      LEFT JOIN users cu ON cu.id = t.created_by
      WHERE 1=1
    `;
    const params = [];
    if (category) { sql += ' AND t.category = ?'; params.push(category); }
    // Status — one value or a comma list (mam 2026-09-12).
    const st = statusFilter(status, ['available', 'in_use', 'maintenance', 'lost', 'scrapped'], 't.status');
    if (st) { sql += ` AND ${st.sql}`; params.push(...st.params); }
    if (site_id) { sql += ' AND t.current_site_id = ?'; params.push(site_id); }
    if (user_id) { sql += ' AND t.current_user_id = ?'; params.push(user_id); }
    if (sticker_status) {
      sql += ' AND COALESCE(t.sticker_status, "pending_print") = ?';
      params.push(sticker_status);
    }
    if (search) {
      sql += ` AND (LOWER(t.name) LIKE ? OR LOWER(t.tool_code) LIKE ? OR LOWER(COALESCE(t.barcode, '')) LIKE ? OR LOWER(COALESCE(t.brand, '')) LIKE ? OR LOWER(t.serial_no) LIKE ? OR LOWER(COALESCE(im.item_code, '')) LIKE ? OR LOWER(COALESCE(im.specification, '')) LIKE ?)`;
      const q = `%${search.toLowerCase()}%`;
      params.push(q, q, q, q, q, q, q);
    }
    sql += ' ORDER BY t.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/stats', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const total = db.prepare('SELECT COALESCE(SUM(quantity), 0) as c FROM tools').get().c;
    const byStatus = db.prepare(`SELECT status, SUM(quantity) as c FROM tools GROUP BY status`).all();
    const byCategory = db.prepare(`SELECT COALESCE(category, '—') as category, SUM(quantity) as c FROM tools GROUP BY category`).all();
    const calibrationDue = db.prepare(`SELECT COUNT(*) as c FROM tools WHERE next_calibration_date IS NOT NULL AND next_calibration_date <= date('now', '+30 days')`).get().c;
    const totalValue = db.prepare(`SELECT COALESCE(SUM(purchase_price), 0) as s FROM tools WHERE status != 'scrapped'`).get().s;
    const bySite = db.prepare(TOOLS_SITE_SUMMARY_SQL).all();
    const byStickerStatus = db.prepare(`
      SELECT COALESCE(sticker_status, 'pending_print') as status, COUNT(*) as c
      FROM tools
      GROUP BY COALESCE(sticker_status, 'pending_print')
    `).all();
    res.json({ total, by_status: byStatus, by_category: byCategory, by_site: bySite, by_sticker_status: byStickerStatus, calibration_due_30d: calibrationDue, total_value: totalValue });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// RGP-only Item Master picker for the tools form. It uses tools permission so
// a store user can register tools without needing full Item Master access.
router.get('/lookup/rgp-items', requirePermission('tools', 'view'), (req, res) => {
  try {
    const rows = getDb().prepare(`
      SELECT id, item_code, item_name, specification, size, uom, current_price, photo_link
        FROM item_master
       WHERE UPPER(TRIM(type)) = 'RGP'
       ORDER BY item_code
    `).all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Fast barcode scanner / mobile lookup (TSK-0514)
router.get('/barcode/:code', async (req, res) => {
  try {
    const db = getDb();
    const raw = String(req.params.code || '').trim();
    if (!raw) return res.status(400).json({ error: 'Please provide a barcode or tool code' });

    const tool = db.prepare(`
      SELECT t.*,
             im.item_code as item_master_code,
             im.specification as item_specification,
             im.size as item_size,
             im.uom as item_uom,
             COALESCE(NULLIF(TRIM(t.unit), ''), 'Nos') as resolved_unit,
             im.photo_link as item_photo_link,
             s.name as current_site_name,
             s.address as current_site_address,
             se.name as site_engineer_name,
             se.phone as site_engineer_phone,
             u.name as current_user_name,
             u.phone as current_user_phone,
             u.department as current_user_department,
             np.name as sticker_printed_by_name,
             ap.name as sticker_pasted_by_name,
             cu.name as created_by_name
      FROM tools t
      LEFT JOIN item_master im ON im.id = t.item_master_id
      LEFT JOIN sites s ON s.id = t.current_site_id
      LEFT JOIN users se ON se.id = s.site_engineer_id
      LEFT JOIN users u ON u.id = t.current_user_id
      LEFT JOIN users np ON np.id = t.sticker_printed_by
      LEFT JOIN users ap ON ap.id = t.sticker_pasted_by
      LEFT JOIN users cu ON cu.id = t.created_by
      WHERE UPPER(TRIM(COALESCE(t.barcode, ''))) = UPPER(?)
         OR UPPER(TRIM(t.tool_code)) = UPPER(?)
         OR UPPER(TRIM(COALESCE(t.serial_no, ''))) = UPPER(?)
    `).get(raw, raw, raw);

    if (!tool) {
      return res.status(404).json({ error: `No tool found matching barcode / code "${raw}"` });
    }

    const movements = db.prepare(`
      SELECT tm.*,
             fs.name as from_site_name, ts.name as to_site_name,
             fu.name as from_user_name, tu.name as to_user_name,
             cb.name as created_by_name
      FROM tool_movements tm
      LEFT JOIN sites fs ON fs.id = tm.from_site_id
      LEFT JOIN sites ts ON ts.id = tm.to_site_id
      LEFT JOIN users fu ON fu.id = tm.from_user_id
      LEFT JOIN users tu ON tu.id = tm.to_user_id
      LEFT JOIN users cb ON cb.id = tm.created_by
      WHERE tm.tool_id = ?
      ORDER BY tm.created_at DESC
      LIMIT 20
    `).all(tool.id);

    let qrDataUrl = null;
    try {
      qrDataUrl = await QRCode.toDataURL(tool.barcode || tool.tool_code, { width: 180, margin: 1, errorCorrectionLevel: 'M' });
    } catch (_) {}

    res.json({ ...tool, movements, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Single tool label data + QR code for TVS Label Printer (TSK-0514)
router.get('/:id/label-data', requirePermission('tools', 'view'), async (req, res) => {
  try {
    const db = getDb();
    const tool = db.prepare(`
      SELECT t.*,
             s.name as current_site_name,
             u.name as current_user_name
      FROM tools t
      LEFT JOIN sites s ON s.id = t.current_site_id
      LEFT JOIN users u ON u.id = t.current_user_id
      WHERE t.id = ?
    `).get(req.params.id);

    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const code = tool.barcode || tool.tool_code;
    const qrDataUrl = await QRCode.toDataURL(code, { width: 180, margin: 1, errorCorrectionLevel: 'M' });
    res.json({ ...tool, qrDataUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Nancy batch-printing stickers on TVS printer (TSK-0514)
router.post('/stickers/batch-print', requirePermission('tools', 'edit'), async (req, res) => {
  try {
    const db = getDb();
    const { tool_ids } = req.body;
    if (!Array.isArray(tool_ids) || !tool_ids.length) {
      return res.status(400).json({ error: 'Select at least one tool to print' });
    }
    const updateStmt = db.prepare(`
      UPDATE tools SET
        sticker_status = 'printed',
        sticker_printed_at = CURRENT_TIMESTAMP,
        sticker_printed_by = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `);
    const tx = db.transaction(() => {
      for (const id of tool_ids) {
        updateStmt.run(req.user.id, id);
      }
    });
    tx();

    // In-app alert for Ajmer / Plant & Machinery team
    try {
      const ajmerUsers = db.prepare(`
        SELECT id FROM users
        WHERE active=1 AND (
          LOWER(name) LIKE '%ajmer%'
          OR LOWER(department) LIKE '%machinery%'
          OR LOWER(department) LIKE '%plant%'
        )
      `).all();
      const notifStmt = db.prepare(`
        INSERT INTO notifications (user_id, type, title, body, link_url, channel_sent, dedupe_key)
        VALUES (?, 'rgp_sticker_printed', ?, ?, '/tools?tab=barcodes', 'in_app', ?)
      `);
      for (const u of ajmerUsers) {
        try {
          notifStmt.run(
            u.id,
            `${tool_ids.length} Tool Barcode Stickers Printed`,
            `Nancy has printed TVS barcode stickers for ${tool_ids.length} tools. Please paste them on the physical machines & upload photo proof.`,
            `rgp-stickers-batch-${Date.now()}-${u.id}`
          );
        } catch (_) {}
      }
    } catch (notifErr) {
      console.warn('[tools] notification error:', notifErr.message);
    }

    res.json({ success: true, count: tool_ids.length, message: `Marked ${tool_ids.length} tool stickers as printed by Nancy` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Ajmer sticker pasted & physical photo verification (TSK-0514)
router.post('/:id/sticker-pasted', (req, res, next) => {
  if (req.user.role === 'admin' || req.user.id === 1001444 || (req.user.department && /plant|machinery|store|godown/i.test(req.user.department))) return next();
  requirePermission('tools', 'edit')(req, res, next);
}, (req, res) => {
  try {
    const db = getDb();
    const { photo_url, notes, condition } = req.body;
    if (!photo_url) return res.status(400).json({ error: 'Photo showing sticker pasted on tool is required' });

    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });

    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE tools SET
          sticker_status = 'pasted',
          sticker_photo_url = ?,
          sticker_pasted_at = CURRENT_TIMESTAMP,
          sticker_pasted_by = ?,
          sticker_notes = COALESCE(?, sticker_notes),
          condition = COALESCE(?, condition),
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(photo_url, req.user.id, notes || null, condition || null, req.params.id);

      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'maintenance', ?, ?, ?, ?)
      `).run(req.params.id, condition || tool.condition, notes ? `Sticker pasted: ${notes}` : 'Physical barcode sticker pasted & verified with photo proof', photo_url, req.user.id);
    });
    tx();

    res.json({ success: true, message: 'Sticker pasted and verified with photo proof' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/:id', requirePermission('tools', 'view'), (req, res) => {
  const db = getDb();
  const tool = db.prepare(`
    SELECT t.*, s.name as current_site_name, u.name as current_user_name
    FROM tools t
    LEFT JOIN sites s ON s.id = t.current_site_id
    LEFT JOIN users u ON u.id = t.current_user_id
    WHERE t.id = ?
  `).get(req.params.id);
  if (!tool) return res.status(404).json({ error: 'Not found' });
  const movements = db.prepare(`
    SELECT tm.*,
           fs.name as from_site_name, ts.name as to_site_name,
           fu.name as from_user_name, tu.name as to_user_name,
           cb.name as created_by_name
    FROM tool_movements tm
    LEFT JOIN sites fs ON fs.id = tm.from_site_id
    LEFT JOIN sites ts ON ts.id = tm.to_site_id
    LEFT JOIN users fu ON fu.id = tm.from_user_id
    LEFT JOIN users tu ON tu.id = tm.to_user_id
    LEFT JOIN users cb ON cb.id = tm.created_by
    WHERE tm.tool_id = ?
    ORDER BY tm.created_at DESC
  `).all(req.params.id);
  res.json({ ...tool, movements });
});

function createTool(db, b, createdBy) {
    let master = null;
    if (b.item_master_id) {
      master = db.prepare(`SELECT id, item_name, department, current_price, uom, make FROM item_master WHERE id=?`).get(b.item_master_id);
    }
    const toolName = (b.name || (master ? master.item_name : '')).trim();
    if (!toolName) throw Object.assign(new Error('Tool name or RGP item from Item Master is required'), { status: 400 });

    const quantity = b.quantity === undefined ? 1 : b.quantity;
    const unit = b.unit === undefined ? (master?.uom || 'Nos') : b.unit;
    if (!validQuantity(quantity)) throw Object.assign(new Error('Quantity must be greater than zero'), { status: 400 });
    if (!validUnit(unit)) throw Object.assign(new Error('Enter a unit (up to 30 characters)'), { status: 400 });
    const yr = new Date().getFullYear();
    const tool_code = b.tool_code || nextSequence(db, 'tools', 'tool_code', `T-${yr}-`, { startFrom: 1, pad: 4 });
    const serial_no = b.serial_no || nextSequence(db, 'tools', 'serial_no', '');
    const barcode = (b.barcode || tool_code).trim();
    const brand = (b.brand || (master ? master.make : '') || '').trim() || null;
    const model = (b.model || '').trim() || null;

    const r = db.prepare(`
      INSERT INTO tools (
        item_master_id, tool_code, barcode, name, category, brand, model, serial_no,
        purchase_date, purchase_price, condition, status,
        current_site_id, current_user_id,
        last_calibration_date, next_calibration_date,
        photo_url, notes, created_by, quantity, unit,
        sticker_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      master ? master.id : null,
      tool_code,
      barcode,
      toolName,
      b.category || (master ? master.department : null) || 'Other',
      brand,
      model,
      serial_no,
      b.purchase_date || null,
      b.purchase_price ?? master?.current_price ?? 0,
      b.condition || 'good',
      b.status || 'available',
      b.current_site_id || null,
      b.current_user_id || null,
      b.last_calibration_date || null,
      b.next_calibration_date || null,
      b.photo_url || null,
      b.notes || null,
      createdBy,
      Number(quantity),
      unit.trim(),
      b.sticker_status || 'pending_print'
    );
    return { id: r.lastInsertRowid, tool_code, serial_no, barcode };
}


router.post('/', requirePermission('tools', 'create'), (req, res) => {
  try {
    const db = getDb();
    const result = db.transaction(() => createTool(db, req.body, req.user.id))();
    res.status(201).json(result);
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.post('/bulk', requirePermission('tools', 'create'), (req, res) => {
  try {
    const db = getDb();
    const { site_id, user_id, items } = req.body;
    if (!site_id || !db.prepare('SELECT id FROM sites WHERE id=?').get(site_id)) {
      return res.status(400).json({ error: 'Select a valid site' });
    }
    if (user_id && !db.prepare('SELECT id FROM users WHERE id=?').get(user_id)) {
      return res.status(400).json({ error: 'Select a valid employee' });
    }
    if (!Array.isArray(items) || !items.length || items.length > 100) {
      return res.status(400).json({ error: 'Add between 1 and 100 tool entries' });
    }
    const results = db.transaction(() => items.map((item, index) => {
      if (!item || typeof item !== 'object') throw Object.assign(new Error(`Row ${index + 1}: select an RGP item`), { status: 400 });
      try {
        return createTool(db, { ...item, tool_code: undefined, current_site_id: site_id, current_user_id: user_id || null }, req.user.id);
      } catch (err) { err.message = `Row ${index + 1}: ${err.message}`; throw err; }
    }))();
    res.status(201).json({ count: results.length, tools: results });
  } catch (err) { res.status(err.status || 500).json({ error: err.message }); }
});

router.put('/:id', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const b = req.body;
    const db = getDb();
    if (b.item_master_id === null) delete b.item_master_id;
    if (b.quantity !== undefined) {
      if (!validQuantity(b.quantity)) return res.status(400).json({ error: 'Quantity must be greater than zero' });
      b.quantity = Number(b.quantity);
    }
    if (b.unit !== undefined) {
      if (!validUnit(b.unit)) return res.status(400).json({ error: 'Enter a unit (up to 30 characters)' });
      b.unit = b.unit.trim();
    }
    if (b.item_master_id !== undefined) {
      const master = db.prepare(`SELECT id, item_name, department FROM item_master WHERE id=? AND UPPER(TRIM(type))='RGP'`).get(b.item_master_id);
      if (!master) return res.status(400).json({ error: 'The selected Item Master entry must be RGP type' });
      b.name = master.item_name;
      b.category = master.department || null;
    }
    const fields = [
      'quantity','unit','item_master_id','name','category','brand','model','barcode',
      'purchase_date','purchase_price','condition','status','current_site_id','current_user_id',
      'last_calibration_date','next_calibration_date','photo_url','notes',
      'sticker_status','sticker_printed_at','sticker_printed_by','sticker_pasted_at','sticker_pasted_by','sticker_photo_url','sticker_notes'
    ];
    const sets = [];
    const vals = [];
    for (const f of fields) {
      if (b[f] !== undefined) { sets.push(`${f} = ?`); vals.push(b[f]); }
    }
    if (sets.length === 0) return res.status(400).json({ error: 'No fields to update' });
    sets.push('updated_at = CURRENT_TIMESTAMP');
    vals.push(req.params.id);
    db.prepare(`UPDATE tools SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
    res.json({ message: 'Updated' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/:id', requirePermission('tools', 'delete'), (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM tool_movements WHERE tool_id=?').run(req.params.id);
  db.prepare('DELETE FROM tools WHERE id=?').run(req.params.id);
  res.json({ message: 'Deleted' });
});

// ---------- MOVEMENTS (issue / return / transfer / scrap / maintenance) ----------

router.post('/:id/issue', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { to_site_id, to_user_id, expected_return_date, condition, notes, photo_url } = req.body;
    if (!to_site_id && !to_user_id) return res.status(400).json({ error: 'Pick a site or a person to issue this tool to' });
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    if (tool.status === 'scrapped' || tool.status === 'lost') return res.status(400).json({ error: `Tool is ${tool.status}` });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, to_site_id, to_user_id, expected_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'issue', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, to_site_id || null, to_user_id || null, expected_return_date || null, condition || tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET current_site_id=?, current_user_id=?, status='in_use', updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(to_site_id || null, to_user_id || null, req.params.id);
    });
    tx();
    res.json({ message: 'Issued' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/return', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { condition, notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, actual_return_date, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'return', ?, ?, date('now'), ?, ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, condition || tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET current_site_id=NULL, current_user_id=NULL, status='available', condition=COALESCE(?, condition), updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(condition || null, req.params.id);
    });
    tx();
    res.json({ message: 'Returned' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/scrap', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO tool_movements (tool_id, action, from_site_id, from_user_id, condition_at_action, notes, photo_url, created_by)
        VALUES (?, 'scrap', ?, ?, 'scrap', ?, ?, ?)
      `).run(req.params.id, tool.current_site_id || null, tool.current_user_id || null, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET status='scrapped', condition='scrap', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ message: 'Scrapped' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/:id/maintenance', requirePermission('tools', 'edit'), (req, res) => {
  try {
    const db = getDb();
    const { notes, photo_url } = req.body;
    const tool = db.prepare('SELECT * FROM tools WHERE id=?').get(req.params.id);
    if (!tool) return res.status(404).json({ error: 'Tool not found' });
    const tx = db.transaction(() => {
      db.prepare(`INSERT INTO tool_movements (tool_id, action, condition_at_action, notes, photo_url, created_by)
                  VALUES (?, 'maintenance', ?, ?, ?, ?)`).run(req.params.id, tool.condition, notes || null, photo_url || null, req.user.id);
      db.prepare(`UPDATE tools SET status='maintenance', updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(req.params.id);
    });
    tx();
    res.json({ message: 'Marked for maintenance' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ---------- WEEKLY SUBMISSIONS (Supervisor KPI) ----------

router.get('/submissions/list', requirePermission('tools', 'view'), (req, res) => {
  try {
    const db = getDb();
    const { week_start, site_id, submitted_by } = req.query;
    let sql = `
      SELECT tls.*, s.name as site_name, u.name as submitted_by_name
      FROM tools_list_submissions tls
      LEFT JOIN sites s ON s.id = tls.site_id
      LEFT JOIN users u ON u.id = tls.submitted_by
      WHERE 1=1
    `;
    const params = [];
    if (week_start) { sql += ' AND tls.week_start = ?'; params.push(week_start); }
    if (site_id) { sql += ' AND tls.site_id = ?'; params.push(site_id); }
    if (submitted_by) { sql += ' AND tls.submitted_by = ?'; params.push(submitted_by); }
    sql += ' ORDER BY tls.week_start DESC, tls.created_at DESC';
    res.json(db.prepare(sql).all(...params));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/submissions', requirePermission('tools', 'create'), (req, res) => {
  try {
    const { site_id, week_start, tools_json, photo_url, notes } = req.body;
    if (!site_id || !week_start) return res.status(400).json({ error: 'site_id and week_start required' });
    const tools = Array.isArray(tools_json) ? tools_json : [];
    const tools_count = tools.reduce((s, t) => s + (Number(t.qty) || 1), 0);
    const db = getDb();
    db.prepare(`
      INSERT INTO tools_list_submissions (site_id, submitted_by, week_start, tools_count, tools_json, photo_url, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(site_id, submitted_by, week_start) DO UPDATE SET
        tools_count=excluded.tools_count,
        tools_json=excluded.tools_json,
        photo_url=excluded.photo_url,
        notes=excluded.notes
    `).run(site_id, req.user.id, week_start, tools_count, JSON.stringify(tools), photo_url || null, notes || null);
    res.json({ message: 'Submitted', tools_count });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

module.exports = router;
