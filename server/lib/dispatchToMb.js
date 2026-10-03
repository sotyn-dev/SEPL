/**
 * TSK-0823: Dispatch to MB (installation) auto
 * "Dispatch to MB (installation) auto"
 *
 * Automatically creates or updates Measurement Book (MB) entries in mb_bills
 * under the corresponding installation whenever materials are dispatched or
 * marked received at site.
 */

const { nextSequence } = require('../db/nextSequence');
const { istToday } = require('./istDate');

/**
 * Sync a delivery note / challan dispatch to mb_bills.
 * Idempotent: creates a new draft MB bill or updates existing if already synced.
 *
 * @param {object} db - better-sqlite3 database instance
 * @param {number|string} deliveryNoteId - ID in delivery_notes
 * @param {object} [actorUser] - user object or ID performing the action
 * @returns {object} { ok: boolean, action: string, mb_id: number, bill_number: string }
 */
function syncDispatchToMb(db, deliveryNoteId, actorUser = null) {
  if (!db || !deliveryNoteId) return { ok: false, reason: 'Invalid arguments' };

  try {
    const dn = db.prepare('SELECT * FROM delivery_notes WHERE id = ?').get(deliveryNoteId);
    if (!dn) return { ok: false, reason: 'Dispatch not found' };

    // Standalone sales bills are tax invoices, not physical material dispatches
    if (dn.document_type === 'sales_bill') {
      return { ok: false, reason: 'Sales bill is not a physical material dispatch' };
    }

    // 1. Resolve Indent ID if missing directly on delivery_notes
    let indentId = dn.indent_id || null;
    if (!indentId && dn.vendor_po_id) {
      try {
        const vp = db.prepare('SELECT indent_id FROM vendor_pos WHERE id = ?').get(dn.vendor_po_id);
        if (vp?.indent_id) indentId = vp.indent_id;
      } catch (_) {}
    }

    // 2. Trace Client PO / Business Book / Site Address
    let poId = null;
    let businessBookId = null;
    let siteAddress = null;
    let indentNumber = null;

    if (indentId) {
      try {
        const ind = db.prepare('SELECT id, indent_number, site_name, site_id, planning_id FROM indents WHERE id = ?').get(indentId);
        if (ind) {
          indentNumber = ind.indent_number || null;
          siteAddress = ind.site_name || null;
          if (ind.planning_id) {
            const plan = db.prepare('SELECT po_id, business_book_id FROM order_planning WHERE id = ?').get(ind.planning_id);
            if (plan) {
              poId = plan.po_id || null;
              businessBookId = plan.business_book_id || null;
            }
          }
        }
      } catch (_) {}
    }

    // Try finding Client PO by business_book_id if poId wasn't found
    if (!poId && businessBookId) {
      try {
        const poRow = db.prepare('SELECT id FROM purchase_orders WHERE business_book_id = ? ORDER BY id DESC LIMIT 1').get(businessBookId);
        if (poRow?.id) poId = poRow.id;
      } catch (_) {}
    }

    // Fallbacks for siteAddress
    if (!siteAddress && businessBookId) {
      try {
        const bb = db.prepare('SELECT project_name, client_name, site_address FROM business_book WHERE id = ?').get(businessBookId);
        if (bb) siteAddress = bb.site_address || bb.project_name || bb.client_name || null;
      } catch (_) {}
    }

    if (!siteAddress && dn.vendor_po_id) {
      try {
        const vp = db.prepare('SELECT po_number, vendor_name FROM vendor_pos WHERE id = ?').get(dn.vendor_po_id);
        if (vp) siteAddress = `${vp.po_number || 'Vendor PO'} - ${vp.vendor_name || 'Site'}`;
      } catch (_) {}
    }

    if (!siteAddress) {
      siteAddress = dn.document_number ? `Site for ${dn.document_number}` : 'Project Site';
    }

    // 3. Find or Auto-Create Installation Record
    let instRow = null;
    if (poId) {
      try {
        instRow = db.prepare('SELECT id FROM installations WHERE po_id = ? ORDER BY id DESC LIMIT 1').get(poId);
      } catch (_) {}
    }
    if (!instRow && businessBookId) {
      try {
        instRow = db.prepare('SELECT id FROM installations WHERE business_book_id = ? ORDER BY id DESC LIMIT 1').get(businessBookId);
      } catch (_) {}
    }
    if (!instRow && siteAddress) {
      try {
        instRow = db.prepare('SELECT id FROM installations WHERE site_address = ? ORDER BY id DESC LIMIT 1').get(siteAddress);
      } catch (_) {}
    }

    if (!instRow) {
      const today = istToday();
      const insInst = db.prepare(
        `INSERT INTO installations (po_id, business_book_id, site_address, start_date, status, notes)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      ).run(poId, businessBookId, siteAddress, today, `Auto-created from Dispatch Challan ${dn.document_number || dn.id}`);
      instRow = { id: insInst.lastInsertRowid };
    }

    // 4. Parse Items & Measurements
    let rawItems = [];
    try {
      rawItems = Array.isArray(dn.items_json) ? dn.items_json : JSON.parse(dn.items_json || '[]');
      if (!Array.isArray(rawItems)) rawItems = [];
    } catch (_) {
      rawItems = [];
    }

    if (dn.receipt_dispatch_items_json) rawItems = require('./deliveryReceipts').state(db, dn).items;
    const isReceived = dn.status === 'received' || dn.status === 'partial';
    const formattedItems = [];
    let totalAmount = 0;
    const measurementLines = [];

    const dcLabel = dn.document_number || `Challan #${dn.id}`;
    const dcDate = dn.delivery_date || istToday();
    const sourceLabel = dn.source === 'store' ? 'Store Issue' : (dn.source === 'rgp' ? 'RGP Gate Pass' : 'Vendor Dispatch');

    measurementLines.push(`Challan: ${dcLabel} (${sourceLabel})`);
    measurementLines.push(`Date: ${dcDate} | Status: ${isReceived ? 'Received at Site' : 'In Transit / Dispatched'}`);
    if (indentNumber) measurementLines.push(`Indent: ${indentNumber}`);
    measurementLines.push('--- Dispatched / Measured Items ---');

    rawItems.forEach((it, idx) => {
      if (!it) return;
      // When received, prefer received_qty if present
      const qty = isReceived && it.received_qty != null
        ? Math.max(0, +it.received_qty)
        : Math.max(0, +it.qty || +it.quantity || +it.ordered_qty || 0);

      const rate = +it.rate || 0;
      const unit = it.unit || 'Nos';
      const desc = it.description || it.item_name || 'Material Item';
      const amount = Math.round((qty * rate) * 100) / 100;
      totalAmount += amount;

      const itemRecord = {
        item_no: idx + 1,
        description: desc,
        qty,
        unit,
        rate,
        amount,
        short_reason: it.short_reason || null,
        item_code: it.item_code || null,
      };
      formattedItems.push(itemRecord);

      let lineText = `${idx + 1}. ${desc}: ${qty} ${unit}`;
      if (rate > 0) lineText += ` @ Rs ${rate.toLocaleString('en-IN')} = Rs ${amount.toLocaleString('en-IN')}`;
      if (it.short_reason) lineText += ` [Shortage Note: ${it.short_reason}]`;
      measurementLines.push(lineText);
    });

    if (formattedItems.length === 0) {
      measurementLines.push('No itemized breakdown recorded on challan.');
    } else {
      measurementLines.push('-----------------------------------');
      measurementLines.push(`Total Amount: Rs ${Math.round(totalAmount).toLocaleString('en-IN')}`);
    }

    const measurementsText = measurementLines.join('\n');
    const itemsJsonStr = JSON.stringify(formattedItems);

    // 5. Insert or Update mb_bills
    const existingMb = db.prepare('SELECT id, bill_number, status FROM mb_bills WHERE delivery_note_id = ?').get(dn.id);

    if (existingMb) {
      db.prepare(`
        UPDATE mb_bills
           SET installation_id = ?,
               measurements = ?,
               total_amount = ?,
               items_json = ?,
               source = 'auto_dispatch'
         WHERE id = ?
      `).run(instRow.id, measurementsText, totalAmount, itemsJsonStr, existingMb.id);

      return {
        ok: true,
        action: 'updated',
        mb_id: existingMb.id,
        bill_number: existingMb.bill_number,
        installation_id: instRow.id,
      };
    } else {
      const year = new Date().getFullYear();
      const prefix = `MB/${year}/`;
      const billNumber = nextSequence(db, 'mb_bills', 'bill_number', prefix, { pad: 4 });

      const insMb = db.prepare(`
        INSERT INTO mb_bills (installation_id, bill_number, measurements, total_amount, status, delivery_note_id, source, items_json)
        VALUES (?, ?, ?, ?, 'draft', ?, 'auto_dispatch', ?)
      `).run(instRow.id, billNumber, measurementsText, totalAmount, dn.id, itemsJsonStr);

      return {
        ok: true,
        action: 'created',
        mb_id: insMb.lastInsertRowid,
        bill_number: billNumber,
        installation_id: instRow.id,
      };
    }
  } catch (err) {
    console.error('[dispatchToMb error]', err);
    return { ok: false, error: err.message };
  }
}

module.exports = { syncDispatchToMb };
