// ═════════════════════════════════════════════════════════════════════════════
// SOP-10: Material use at site (Owner: Project Manager — Adarsh Kumar)
// Breadcrumb: daily reports -> daily reports -> store issue/return
// Stages:
//   S1: Material issued from store against work area — mobile slip (Store Keeper: Ajmer)
//   S2: Daily report shows how much got installed in that area (Site Engineer)
//   S3: System compares issued vs installed vs BOQ. Difference too big = flag SAME day. (ERP Automatic)
//   S4: Monthly physical counting at site; tally with system (Store Keeper + PM)
//   S5: Left-over material goes back to store or another site — never wasted (ERP / Ajmer)
// ═════════════════════════════════════════════════════════════════════════════

const { getDb } = require('../db/schema');
const { requirePermission } = require('../middleware/auth');
const { istToday } = require('../lib/istDate');
const istTodayIso = () => (typeof istToday === 'function' ? istToday() : new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }));

module.exports = function registerSop10Routes(router) {
  // SOP-10.1: Distinct work areas for a site (for dropdown selection & auto-suggestions)
  router.get('/sites/:site_id/work-areas', requirePermission('dpr', 'view'), (req, res) => {
    const db = getDb();
    const siteId = +req.params.site_id;
    if (!siteId) return res.status(400).json({ error: 'site_id required' });
    try {
      const areas = new Set();
      // 1. From existing site store slips
      try {
        const fromSlips = db.prepare('SELECT DISTINCT work_area FROM site_store_slips WHERE site_id = ? AND work_area IS NOT NULL').all(siteId);
        fromSlips.forEach(r => { if (r.work_area && r.work_area.trim()) areas.add(r.work_area.trim()); });
      } catch (_) {}
      // 2. From DPR submissions
      try {
        const fromDpr = db.prepare('SELECT DISTINCT floor_zone FROM dpr WHERE site_id = ? AND floor_zone IS NOT NULL').all(siteId);
        fromDpr.forEach(r => { if (r.floor_zone && r.floor_zone.trim()) areas.add(r.floor_zone.trim()); });
      } catch (_) {}
      // 3. From DPR work items
      try {
        const fromItems = db.prepare('SELECT DISTINCT wi.floor_zone FROM dpr_work_items wi JOIN dpr d ON d.id = wi.dpr_id WHERE d.site_id = ? AND wi.floor_zone IS NOT NULL').all(siteId);
        fromItems.forEach(r => { if (r.floor_zone && r.floor_zone.trim()) areas.add(r.floor_zone.trim()); });
      } catch (_) {}
      // 4. From SOP-09 ready checklists
      try {
        const fromChecklists = db.prepare('SELECT DISTINCT work_area FROM site_ready_checklists WHERE site_id = ? AND work_area IS NOT NULL').all(siteId);
        fromChecklists.forEach(r => { if (r.work_area && r.work_area.trim()) areas.add(r.work_area.trim()); });
      } catch (_) {}

      // Pre-populate standard site zones if empty
      if (!areas.size) {
        ['Ground Floor', '1st Floor', '2nd Floor', 'Main Work Area', 'Terrace / Roof', 'Electrical Room', 'Block A', 'Block B'].forEach(a => areas.add(a));
      }
      res.json(Array.from(areas).sort());
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // SOP-10.3: Difference Flag Rule Card Engine
  // Compares Net Issued (slips) vs Installed (DPR) vs BOQ for selected date/area or cumulative.
  // Difference too big = flag the SAME day. Leakage visible daily, not at project end.
  router.get('/sites/:site_id/sop10-reconciliation', requirePermission('dpr', 'view'), (req, res) => {
    const db = getDb();
    const siteId = +req.params.site_id;
    if (!siteId) return res.status(400).json({ error: 'site_id required' });
    const dateIso = req.query.date ? String(req.query.date).slice(0, 10) : null;
    const areaFilter = req.query.work_area ? String(req.query.work_area).trim() : null;

    try {
      const site = db.prepare('SELECT id, name, client_name, business_book_id, po_id FROM sites WHERE id = ?').get(siteId);
      if (!site) return res.status(404).json({ error: 'Site not found' });

      // Store warehouse for this site
      const store = db.prepare("SELECT id, name FROM warehouses WHERE site_id = ? AND type = 'site_store' AND COALESCE(active,1) = 1 LIMIT 1").get(siteId);

      // 1. Gather all site store slip movements (Issued, Returned, Transferred)
      let slipSql = `
        SELECT si.item_master_id,
               COALESCE(MAX(si.item_name), 'Item #' || si.item_master_id) AS item_name,
               COALESCE(MAX(si.unit), 'nos') AS unit,
               COALESCE(s.work_area, 'General Work Area') AS work_area,
               SUM(CASE WHEN s.slip_type = 'issue' THEN si.quantity ELSE 0 END) AS issued_qty,
               SUM(CASE WHEN s.slip_type = 'return' THEN si.quantity ELSE 0 END) AS returned_qty,
               SUM(CASE WHEN s.slip_type = 'transfer' THEN si.quantity ELSE 0 END) AS transfer_qty
          FROM site_store_slip_items si
          JOIN site_store_slips s ON s.id = si.slip_id
         WHERE s.site_id = ?
      `;
      const slipParams = [siteId];
      if (dateIso) {
        slipSql += ' AND s.slip_date = ?';
        slipParams.push(dateIso);
      }
      if (areaFilter) {
        slipSql += ' AND s.work_area = ?';
        slipParams.push(areaFilter);
      }
      slipSql += ' GROUP BY si.item_master_id, s.work_area';
      const slipRows = db.prepare(slipSql).all(...slipParams);

      // 2. Gather DPR material installation reported
      let dprSql = `
        SELECT dm.item_master_id,
               COALESCE(MAX(dm.material_name), 'Item') AS material_name,
               COALESCE(MAX(dm.unit), 'nos') AS unit,
               COALESCE(d.floor_zone, 'General Work Area') AS work_area,
               SUM(COALESCE(dm.consumed_today, 0)) AS installed_today,
               MAX(COALESCE(dm.boq_qty, 0)) AS boq_qty
          FROM dpr_material dm
          JOIN dpr d ON d.id = dm.dpr_id
         WHERE d.site_id = ?
      `;
      const dprParams = [siteId];
      if (dateIso) {
        dprSql += ' AND d.report_date = ?';
        dprParams.push(dateIso);
      }
      if (areaFilter) {
        dprSql += ' AND d.floor_zone = ?';
        dprParams.push(areaFilter);
      }
      dprSql += ' GROUP BY dm.item_master_id, d.floor_zone';
      const dprRows = db.prepare(dprSql).all(...dprParams);

      // 3. Fallback: project BOQ items
      const bbId = site.business_book_id;
      let boqItemsMap = new Map();
      if (bbId) {
        try {
          const bItems = db.prepare('SELECT item_master_id, description, quantity, unit FROM po_items WHERE business_book_id = ?').all(bbId);
          bItems.forEach(b => {
            if (b.item_master_id) boqItemsMap.set(b.item_master_id, b.quantity || 0);
          });
        } catch (_) {}
      }

      // 4. Live stock balances
      let stockMap = new Map();
      if (store) {
        try {
          const stocks = db.prepare('SELECT item_master_id, quantity, avg_rate FROM stock_balance WHERE warehouse_id = ?').all(store.id);
          stocks.forEach(st => stockMap.set(st.item_master_id, { qty: st.quantity || 0, rate: st.avg_rate || 0 }));
        } catch (_) {}
      }

      // 5. Merge item lines by (item_master_id, work_area)
      const lineMap = new Map();
      slipRows.forEach(sr => {
        const key = `${sr.item_master_id}_${sr.work_area}`;
        lineMap.set(key, {
          item_master_id: sr.item_master_id,
          item_name: sr.item_name,
          unit: sr.unit,
          work_area: sr.work_area,
          issued_qty: +sr.issued_qty || 0,
          returned_qty: +sr.returned_qty || 0,
          net_issued_qty: +((+sr.issued_qty || 0) - (+sr.returned_qty || 0)).toFixed(3),
          transfer_qty: +sr.transfer_qty || 0,
          installed_qty: 0,
          boq_qty: boqItemsMap.get(sr.item_master_id) || 0,
          current_store_stock: stockMap.get(sr.item_master_id)?.qty || 0,
          unit_rate: stockMap.get(sr.item_master_id)?.rate || 0,
        });
      });

      dprRows.forEach(dr => {
        if (!dr.item_master_id) return;
        const key = `${dr.item_master_id}_${dr.work_area}`;
        const existing = lineMap.get(key) || {
          item_master_id: dr.item_master_id,
          item_name: dr.material_name,
          unit: dr.unit,
          work_area: dr.work_area,
          issued_qty: 0,
          returned_qty: 0,
          net_issued_qty: 0,
          transfer_qty: 0,
          installed_qty: 0,
          boq_qty: dr.boq_qty || boqItemsMap.get(dr.item_master_id) || 0,
          current_store_stock: stockMap.get(dr.item_master_id)?.qty || 0,
          unit_rate: stockMap.get(dr.item_master_id)?.rate || 0,
        };
        existing.installed_qty = +((+existing.installed_qty) + (+dr.installed_today || 0)).toFixed(3);
        if (dr.boq_qty && !existing.boq_qty) existing.boq_qty = dr.boq_qty;
        lineMap.set(key, existing);
      });

      // 6. Evaluate Rule Cards for each item
      let redCount = 0;
      let amberCount = 0;
      let greenCount = 0;

      const items = Array.from(lineMap.values()).map(it => {
        const netIssued = +it.net_issued_qty || 0;
        const installed = +it.installed_qty || 0;
        const boq = +it.boq_qty || 0;
        const variance = +(netIssued - installed).toFixed(3); // material drawn but not installed or returned
        const variancePct = netIssued > 0 ? +(((variance) / netIssued) * 100).toFixed(1) : (installed > 0 ? -100 : 0);
        const boqPct = boq > 0 ? +((installed / boq) * 100).toFixed(1) : 0;

        let flagStatus = 'green'; // 'green', 'amber', 'red'
        let flagTitle = 'Reconciled';
        let flagMessage = 'Installed matches issued slip.';

        if (netIssued <= 0 && installed > 0) {
          flagStatus = 'amber';
          flagTitle = 'Unrecorded Draw';
          flagMessage = `Installed ${installed} ${it.unit} without recorded store issue slip.`;
          amberCount++;
        } else if (variance === 0) {
          flagStatus = 'green';
          flagTitle = 'Exact Match';
          flagMessage = '100% of issued material installed or returned.';
          greenCount++;
        } else if (variance > 0 && variancePct <= 5) {
          flagStatus = 'green';
          flagTitle = 'Normal Tolerance';
          flagMessage = `Scrap/variance of ${variance} ${it.unit} (${variancePct}%) is within 5% site tolerance.`;
          greenCount++;
        } else if (variance > 0 && variancePct <= 15) {
          flagStatus = 'amber';
          flagTitle = 'Unreturned Balance';
          flagMessage = `${variance} ${it.unit} (${variancePct}%) drawn and sitting uninstalled. Ensure evening return slip.`;
          amberCount++;
        } else if (variance > 0 && variancePct > 15) {
          flagStatus = 'red';
          flagTitle = 'LEAKAGE ALERT (SOP-10.3)';
          flagMessage = `Difference too big: ${variance} ${it.unit} (${variancePct}%) missing! Flagged the SAME day.`;
          redCount++;
        } else if (variance < 0) {
          flagStatus = 'amber';
          flagTitle = 'Excess Installed';
          flagMessage = `Installed ${installed} ${it.unit} exceeds net issued ${netIssued} ${it.unit}. Verify prior days.`;
          amberCount++;
        }

        if (boq > 0 && installed > boq) {
          flagStatus = 'red';
          flagTitle = 'BOQ BREACH';
          flagMessage = `Total installed (${installed}) exceeds design BOQ limit (${boq} ${it.unit}).`;
          if (flagStatus !== 'red') redCount++;
        }

        return {
          ...it,
          variance,
          variance_pct: variancePct,
          boq_pct: boqPct,
          flag_status: flagStatus,
          flag_title: flagTitle,
          flag_message: flagMessage,
        };
      });

      items.sort((a, b) => {
        const p = { red: 3, amber: 2, green: 1 };
        return (p[b.flag_status] - p[a.flag_status]) || Math.abs(b.variance) - Math.abs(a.variance);
      });

      res.json({
        site_id: siteId,
        site_name: site.name,
        client_name: site.client_name,
        report_date: dateIso,
        work_area: areaFilter,
        owner: 'Project Manager — Adarsh Kumar',
        store_keeper: 'Ajmer',
        summary: {
          total_items: items.length,
          red_flags: redCount,
          amber_flags: amberCount,
          green_flags: greenCount,
          leakage_alert_today: redCount > 0,
        },
        items,
      });
    } catch (e) {
      console.error('[dpr/sop10-reconciliation]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // SOP-10.4: Monthly Physical Count Sheets Register
  router.get('/sites/:site_id/count-sheets', requirePermission('dpr', 'view'), (req, res) => {
    const db = getDb();
    const siteId = +req.params.site_id;
    if (!siteId) return res.status(400).json({ error: 'site_id required' });
    try {
      const sheets = db.prepare(`
        SELECT cs.*, w.name AS warehouse_name, u.name AS created_by_name,
               (SELECT COUNT(*) FROM site_store_count_sheet_items ci WHERE ci.count_sheet_id = cs.id) AS item_count,
               (SELECT COALESCE(SUM(ci.variance_value), 0) FROM site_store_count_sheet_items ci WHERE ci.count_sheet_id = cs.id) AS total_variance_value
          FROM site_store_count_sheets cs
          LEFT JOIN warehouses w ON w.id = cs.warehouse_id
          LEFT JOIN users u ON u.id = cs.created_by
         WHERE cs.site_id = ?
         ORDER BY cs.count_date DESC, cs.id DESC
      `).all(siteId);
      res.json(sheets);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // SOP-10.4: Create / Submit Monthly Physical Count Sheet
  router.post('/sites/:site_id/count-sheets', requirePermission('dpr', 'create'), (req, res) => {
    const db = getDb();
    const siteId = +req.params.site_id;
    const { count_date, month_year, conducted_by, verified_by, remarks, items } = req.body || {};
    if (!siteId) return res.status(400).json({ error: 'site_id required' });
    if (!month_year) return res.status(400).json({ error: 'month_year (e.g. 2026-11) is required' });

    const store = db.prepare("SELECT id, name FROM warehouses WHERE site_id = ? AND type = 'site_store' AND COALESCE(active,1) = 1 LIMIT 1").get(siteId);
    if (!store) return res.status(400).json({ error: 'This site has no active site store warehouse.' });

    const cleanItems = Array.isArray(items) ? items.filter(it => it && it.item_master_id) : [];
    if (!cleanItems.length) return res.status(400).json({ error: 'At least one inventory line is required in the count sheet.' });

    const dateIso = String(count_date || istTodayIso()).slice(0, 10);
    const getBal = db.prepare('SELECT quantity, avg_rate FROM stock_balance WHERE warehouse_id = ? AND item_master_id = ?');
    const getMaster = db.prepare('SELECT item_name, specification, size, uom FROM item_master WHERE id = ?');

    let sheetId;
    try {
      const txn = db.transaction(() => {
        const insHdr = db.prepare(`
          INSERT INTO site_store_count_sheets (site_id, warehouse_id, count_date, month_year, conducted_by, verified_by, status, remarks, created_by)
          VALUES (?,?,?,?,?,?,?,?,?)
        `);
        const r = insHdr.run(
          siteId,
          store.id,
          dateIso,
          String(month_year).trim(),
          String(conducted_by || 'Ajmer / Store Keeper').trim(),
          verified_by ? String(verified_by).trim() : null,
          'submitted',
          remarks || null,
          req.user.id
        );
        sheetId = r.lastInsertRowid;

        const insItem = db.prepare(`
          INSERT INTO site_store_count_sheet_items (count_sheet_id, item_master_id, item_name, unit, system_qty, physical_qty, variance_qty, rate, variance_value, reason_remarks)
          VALUES (?,?,?,?,?,?,?,?,?,?)
        `);

        for (const it of cleanItems) {
          const m = getMaster.get(it.item_master_id);
          const name = m ? [m.item_name, m.specification, m.size].filter(Boolean).join(' ') : (it.item_name || 'Item');
          const unit = m?.uom || it.unit || 'nos';
          const bal = getBal.get(store.id, it.item_master_id);
          const sysQty = +(bal?.quantity || 0);
          const physQty = +(it.physical_qty || 0);
          const varQty = +(physQty - sysQty).toFixed(3);
          const rate = +(bal?.avg_rate || it.rate || 0);
          const varVal = +(varQty * rate).toFixed(2);

          insItem.run(sheetId, it.item_master_id, name, unit, sysQty, physQty, varQty, rate, varVal, it.reason_remarks || null);
        }
      });
      txn();
      res.status(201).json({ id: sheetId, message: 'Monthly Physical Count Sheet saved (SOP-10.4)' });
    } catch (e) {
      console.error('[dpr/count-sheets]', e);
      res.status(500).json({ error: e.message });
    }
  });

  // SOP-10.4: View single count sheet with lines
  router.get('/count-sheets/:id', requirePermission('dpr', 'view'), (req, res) => {
    const db = getDb();
    try {
      const sheet = db.prepare(`
        SELECT cs.*, s.name AS site_name, s.client_name, w.name AS warehouse_name, u.name AS created_by_name
          FROM site_store_count_sheets cs
          JOIN sites s ON s.id = cs.site_id
          LEFT JOIN warehouses w ON w.id = cs.warehouse_id
          LEFT JOIN users u ON u.id = cs.created_by
         WHERE cs.id = ?
      `).get(req.params.id);
      if (!sheet) return res.status(404).json({ error: 'Count sheet not found' });
      sheet.items = db.prepare('SELECT * FROM site_store_count_sheet_items WHERE count_sheet_id = ? ORDER BY id ASC').all(sheet.id);
      res.json(sheet);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // SOP-10.4: Verify count sheet by Project Manager (Adarsh Kumar)
  router.post('/count-sheets/:id/verify', requirePermission('dpr', 'approve'), (req, res) => {
    const db = getDb();
    try {
      const sheet = db.prepare('SELECT * FROM site_store_count_sheets WHERE id = ?').get(req.params.id);
      if (!sheet) return res.status(404).json({ error: 'Count sheet not found' });
      const verifierName = req.user.name || 'Adarsh Kumar (PM)';
      db.prepare("UPDATE site_store_count_sheets SET status = 'verified', verified_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(verifierName, sheet.id);
      res.json({ message: `Count sheet #${sheet.id} verified by ${verifierName} (SOP-10.4)` });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
};
